#!/usr/bin/env bun
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ancestorCommandLines, channelRequested, launcherCommandLine } from './channel'

// 플러그인을 깐 뒤 처음 켠 Claude Code 세션에 한 번, 채널로 켜는 법을 알려 준다.
// Claude Code 에는 플러그인 설치 직후에 안내를 띄우는 방법이 없어서 세션 시작 훅에서 띄운다.
// 채널 옵션은 settings.json 에 넣을 수 없고 켤 때만 줄 수 있다(2026-10-30, 2.1.314). 그래서 별칭을 권한다.
export const HINT = [
  'coworker: 동료가 보낸 질문이 이 세션에 바로 들어오게 하려면 Claude Code를 이렇게 켜세요.',
  '  claude --dangerously-load-development-channels plugin:coworker@ai-coworker-without-me',
  '매번 치기 번거로우면 claude-cw로 줄여 두세요(Mac·Windows 방법: https://github.com/BrilliantTiger/ai-coworker-without-me/blob/main/INSTALL.md). 이 안내는 한 번만 나옵니다.',
].join('\n')

// 보여 줄 안내. 한 번 지나가면 다시 보이지 않는다. 이미 채널로 켰으면 보이지 않고 지나간다.
// 이미 지나갔으면 실행 인자를 읽지 않는다. Windows 에서는 읽는 데 0.7초가 걸려서 세션마다 늦어진다.
export function startupHint(home: string, launcher: () => string | undefined): string | undefined {
  const seen = join(home, 'hint-shown')
  if (existsSync(seen)) return undefined
  const command = launcher()
  mkdirSync(home, { recursive: true })
  writeFileSync(seen, `${new Date().toISOString()}\n`)
  return command && channelRequested(command, true) ? undefined : HINT
}

if (import.meta.main) {
  try {
    const home = process.env.COWORKER_HOME ?? join(homedir(), '.coworker')
    const text = startupHint(home, () => launcherCommandLine(ancestorCommandLines()))
    // systemMessage 는 사람에게 보이는 안내 줄로 뜬다.
    if (text) console.log(JSON.stringify({ systemMessage: text }))
  } catch {}
}
