#!/usr/bin/env bun
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { autostart } from './autostart'
import { detectChannel } from './channel'
import { findSession, pruneSaved } from './resume'
import { serve } from './serve'
import { createSession } from './session'
import { wake } from './wake'

// 실행 방법은 셋이다.
//   bun coworker.js                    Claude Code·Codex 가 플러그인으로 띄우는 stdio MCP 서버. 세션 하나를 맡는다.
//   bun coworker.js serve              coworker 앱. 이 PC의 여러 세션을 127.0.0.1 의 HTTP 로 받는다. 디렉터리판 플러그인이 여기에 붙는다.
//   bun coworker.js autostart on|off   로그인할 때 앱을 켤지 정한다.
//   bun coworker.js wake               Claude Code 세션을 다시 켰을 때 플러그인 훅이 띄운다. 그사이 온 소식으로 AI를 깨운다.
const home = process.env.COWORKER_HOME ?? join(homedir(), '.coworker')
const command = process.argv[2]

if (command === 'serve') await serve({ home })
else if (command === 'autostart') process.exit(await autostart(process.argv[3], home))
else if (command === 'wake') process.exit(await wake(home, await Bun.stdin.text()))
else await stdio()

async function stdio() {
  // Claude Code 를 Channels 로 켰으면(claude --dangerously-load-development-channels server:coworker)
  // 상대 메시지를 세션에 바로 밀어 넣는다. 아니면 AI가 wait_for_message 로 기다린다.
  const channel = detectChannel()
  // Claude Code 는 세션 ID를 넘겨 준다. 같은 세션을 다시 켜면(claude --resume) 저장해 둔 브릿지를 되살린다.
  // 한 세션에 플러그인으로 뜬 서버와 직접 등록한 서버가 함께 뜰 수 있어서, 서로의 브릿지를 되살리지 않게 이름표를 나눈다.
  pruneSaved(home)
  const id = process.env.CLAUDECODE === '1' ? process.env.CLAUDE_CODE_SESSION_ID : undefined
  const claudeSession = id ? `${id}${process.env.CLAUDE_PLUGIN_ROOT ? '' : '.direct'}` : undefined
  const { sessionId, restore } = await findSession(home, claudeSession)
  const session = createSession({
    channel,
    hint: !channel && process.env.CLAUDECODE === '1',
    home,
    portsText: process.env.COWORKER_PORTS,
    relay: process.env.COWORKER_RELAY || undefined,
    relayKey: process.env.COWORKER_RELAY_KEY || undefined,
    folder: projectFolder,
    sessionId,
    restore,
    autoUpdate: installedAsPlugin(),
  })
  let exiting = false
  const exit = () => {
    if (exiting) return
    exiting = true
    session.shutdown()
    process.exit(0)
  }
  process.stdin.on('end', exit)
  process.stdin.on('close', exit)
  process.on('SIGINT', exit)
  process.on('SIGTERM', exit)
  await session.server.connect(new StdioServerTransport())
}

// 플러그인으로 설치해서 도는 묶음(coworker.js)이면 새 판이 나왔을 때 스스로 올린다.
// 저장소에서 직접 띄운 서버(src/mcp.ts)와 시험에서는 올리지 않는다. COWORKER_AUTO_UPDATE=off 면 끈다.
function installedAsPlugin() {
  if (/^(off|false|0|no)$/i.test(process.env.COWORKER_AUTO_UPDATE ?? '')) return false
  const script = process.argv[1] ?? ''
  if (basename(script) !== 'coworker.js') return false
  // Claude Code 플러그인은 그 플러그인 폴더에서 뜬다. Codex 플러그인은 자기 플러그인 폴더의 ./coworker.js 로 뜬다.
  const root = process.env.CLAUDE_PLUGIN_ROOT
  return root ? resolve(script).startsWith(resolve(root)) : true
}

// 세션 이름에 붙일 프로젝트 폴더. 플러그인으로 설치하면 MCP가 플러그인 폴더에서 뜬다.
// 그때는 Claude Code 가 알려 준 프로젝트 폴더나, Codex 가 넘겨 준 PWD 를 쓴다. 둘 다 없으면 폴더 이름을 붙이지 않는다.
function projectFolder() {
  const given = process.env.COWORKER_PROJECT_DIR
  if (given && !given.includes('${')) return basename(given)
  const cwd = workingDir()
  if (cwd && !/[\\/]plugins[\\/]cache[\\/]/.test(cwd)) return basename(cwd)
  const pwd = process.env.PWD
  return pwd && pwd !== cwd && !/[\\/]plugins[\\/]cache[\\/]/.test(pwd) ? basename(pwd) : undefined
}

// Codex 는 플러그인을 깐 뒤 첫 세션을 켤 때, 이미 띄운 MCP 의 플러그인 폴더를 같은 경로의 새 폴더로 바꾼다
// (2026-10-29, codex-cli 0.165.0). 그러면 지워진 폴더에 머문 이 프로세스에서 process.cwd() 가 uv_cwd 오류를 낸다.
function workingDir() {
  try {
    return process.cwd()
  } catch {
    return undefined
  }
}
