import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { platform } from 'node:os'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { version } from '../package.json'
import { LABEL } from './autostart'
import { pruneSaved } from './resume'
import { createSession } from './session'
import { appUpdate, firstCheckMs, UPDATE_EVERY_MS } from './update'

// coworker 앱. 이 PC에서 따로 켜 두면, Claude 플러그인 디렉터리판 플러그인이 http://127.0.0.1:7690/mcp 로 붙는다.
// 디렉터리는 인증된 조직이 아니면 사용자 PC에서 코드를 띄우는 플러그인을 받지 않는다(2026-11-09).
// 그래서 사람이 이 앱을 직접 깔아 켜 두고, 플러그인에는 주소만 둔다. 세션마다 브릿지를 따로 두는 것은 stdio 와 같다.
// 주소로 붙는 서버는 채널이 될 수 없어서, 이 앱에 붙은 세션은 wait_for_message 로 기다린다.
export const APP_PORT = 7690

// 세션은 사람이 닫으라고 하거나 Claude Code 가 세션을 끝낼 때(DELETE)까지 산다. 조용하다고 시간으로 정리하지 않는다(사람이 정함, 2026-11-10).
// 대신 세션 수에 상한을 둔다. 앱은 이 PC의 어느 프로그램이든 부를 수 있어서, 상한이 없으면 세션을 끝없이 만들어 메모리를 채울 수 있다.
// 브릿지 포트도 기본 100개(7700~7799)라 그보다 많은 세션은 어차피 브릿지를 열지 못한다.
export const MAX_SESSIONS = Number(process.env.COWORKER_APP_MAX_SESSIONS) || 100
type Entry = { transport: WebStandardStreamableHTTPServerTransport; session: ReturnType<typeof createSession> }

const jsonError = (status: number, message: string) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json' },
  })

async function isInitialize(req: Request) {
  const body = (await req.clone().json().catch(() => undefined)) as { method?: string } | { method?: string }[] | undefined
  return Array.isArray(body) ? body.some(m => m?.method === 'initialize') : body?.method === 'initialize'
}

// 세션 이름에 붙일 프로젝트 폴더. 앱은 세션이 어느 폴더에서 켜졌는지 모르므로, 클라이언트가 알려 주는 폴더(roots)를 쓴다.
async function rootsFolder(server: McpServer) {
  if (!server.server.getClientCapabilities()?.roots) return undefined
  const { roots } = await server.server.listRoots(undefined, { timeout: 3000 })
  const uri = roots[0]?.uri
  return uri?.startsWith('file:') ? basename(fileURLToPath(uri)) : undefined
}

export async function serve({ home }: { home: string }) {
  const port = Number(process.env.COWORKER_APP_PORT) || APP_PORT
  const sessions = new Map<string, Entry>()
  pruneSaved(home)
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`])
  const script = resolve(process.argv[1] ?? '')
  const restartCommand = `bun "${script}" autostart on`
  const updating = appUpdates(script)
  // 받아 두었지만 아직 그 판으로 다시 켜지 않은 새 판.
  let downloaded: string | undefined

  const close = (id: string) => {
    const entry = sessions.get(id)
    if (!entry) return
    sessions.delete(id)
    entry.session.shutdown()
    void entry.transport.close().catch(() => {})
  }

  const handle = async (req: Request): Promise<Response> => {
    // 웹페이지가 브라우저를 시켜 이 앱을 부르지 못하게 한다. 브라우저는 다른 사이트로 보내는 요청에 Origin 을 붙인다.
    if (req.headers.get('origin')) return new Response('requests from web pages are refused\n', { status: 403 })
    // DNS 리바인딩 막기: 이 PC의 주소로 온 요청만 받는다.
    if (!hosts.has(req.headers.get('host') ?? '')) return new Response('wrong host\n', { status: 403 })
    const url = new URL(req.url)
    if (url.pathname === '/' || url.pathname === '/health') return new Response(`coworker app ${version}\n`)
    if (url.pathname !== '/mcp') return new Response('not found\n', { status: 404 })
    const id = req.headers.get('mcp-session-id')
    if (id) {
      const entry = sessions.get(id)
      if (!entry) return jsonError(404, 'Session not found')
      return entry.transport.handleRequest(req)
    }
    if (req.method !== 'POST' || !(await isInitialize(req))) return jsonError(400, 'Bad Request: No valid session ID provided')
    if (sessions.size >= MAX_SESSIONS)
      return jsonError(503, `the coworker app already has ${MAX_SESSIONS} sessions. Close sessions you no longer use, or restart the app: ${restartCommand}`)
    const session = createSession({
      channel: false,
      hint: false,
      home,
      portsText: process.env.COWORKER_PORTS,
      relay: process.env.COWORKER_RELAY || undefined,
      relayKey: process.env.COWORKER_RELAY_KEY || undefined,
      folder: rootsFolder,
      app: updating ? { downloaded: () => downloaded, restartCommand } : undefined,
    })
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: sid => {
        sessions.set(sid, { transport, session })
      },
      onsessionclosed: sid => close(sid),
    })
    await session.server.connect(transport)
    return transport.handleRequest(req)
  }

  let server: ReturnType<typeof Bun.serve>
  try {
    // 기다리기 호출은 오래 열려 있으므로 연결을 끊는 유휴 시간을 끈다.
    // 새 판으로 다시 켤 때는 앞 프로세스가 포트를 막 놓은 참이라, 잠깐 다시 해 본다.
    server = await listen(port, handle)
  } catch (e) {
    const running = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
      .then(r => r.text())
      .catch(() => '')
    if (running.startsWith('coworker app')) {
      console.log(`coworker app is already running at http://127.0.0.1:${port}/mcp (${running.trim()})`)
      process.exit(0)
    }
    console.error(`could not open 127.0.0.1:${port}: ${e instanceof Error ? e.message : e}. Another program uses this port. The Claude directory plugin connects to 127.0.0.1:${APP_PORT}, so close that program and start the app again.`)
    process.exit(1)
  }

  const stop = () => {
    for (const id of [...sessions.keys()]) close(id)
    server.stop(true)
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  console.log(`coworker app ${version} listening at http://127.0.0.1:${server.port}/mcp`)

  if (!updating) return
  const check = async () => {
    const done = await appUpdate(script, downloaded ?? version, home).catch(() => undefined)
    if (done) {
      downloaded = done.to
      console.log(`coworker app ${done.to} downloaded; restarting into it when no session is connected`)
    }
  }
  setTimeout(() => void check(), firstCheckMs())
  setInterval(() => void check(), UPDATE_EVERY_MS)
  // 붙은 세션이 없을 때 새 판으로 다시 켠다. 붙어 있는 세션의 브릿지를 끊지 않으려는 것이다.
  setInterval(() => {
    if (!downloaded || sessions.size > 0) return
    server.stop(true)
    restartApp(script)
  }, Number(process.env.COWORKER_APP_RESTART_CHECK_MS) || 60_000)
}

async function listen(port: number, fetch: (req: Request) => Promise<Response>) {
  for (let i = 0; ; i++) {
    try {
      return Bun.serve({ hostname: '127.0.0.1', port, idleTimeout: 0, fetch })
    } catch (e) {
      if (i >= 10) throw e
      await Bun.sleep(300)
    }
  }
}

// 받은 coworker.js 파일로 도는 앱만 스스로 올린다. 저장소에서 띄운 앱(src/mcp.ts)과 플러그인 폴더의 파일은 올리지 않는다.
// COWORKER_AUTO_UPDATE=off 면 끈다.
function appUpdates(script: string) {
  if (/^(off|false|0|no)$/i.test(process.env.COWORKER_AUTO_UPDATE ?? '')) return false
  return basename(script) === 'coworker.js' && !process.env.CLAUDE_PLUGIN_ROOT && !/[\\/]plugins[\\/]/.test(script)
}

// 새 판으로 다시 켠다. Mac 로그인 항목(LaunchAgent)으로 켰으면 끝나기만 하면 launchd 가 다시 켠다.
// 그 밖에는 새 프로세스를 따로 띄우고 끝난다. Windows 는 시작프로그램 바로가기처럼 최소화한 창으로 띄운다.
function restartApp(script: string) {
  if (process.env.XPC_SERVICE_NAME === LABEL) process.exit(0)
  const bun = process.execPath
  if (platform() === 'win32') {
    const ps = (s: string) => s.replace(/'/g, "''")
    const command = `Start-Process -FilePath '${ps(bun)}' -ArgumentList '"${ps(script)}"', 'serve' -WindowStyle Minimized`
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref()
  } else spawn(bun, [script, 'serve'], { detached: true, stdio: 'ignore' }).unref()
  setTimeout(() => process.exit(0), 500)
}
