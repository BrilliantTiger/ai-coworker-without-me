import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// 채널 없이 켠 Claude Code 세션에 한 번, 채널로 켜는 법을 알려 준다.
// 채널 옵션은 settings.json 에 넣을 수 없고 켤 때만 줄 수 있다(2026-10-30, 2.1.314). 그래서 별칭을 권한다.
// 처음에는 세션 시작 훅이 띄웠지만, Claude 플러그인 디렉터리가 인증된 조직이 아니면 훅을 받지 않아서
// MCP 가 처음 브릿지를 열거나 연결할 때 AI에게 전하게 바꿨다(2026-11-09).
export const HINT = [
  'coworker: 동료가 보낸 질문이 이 세션에 바로 들어오게 하려면 Claude Code를 이렇게 켜세요.',
  '  claude --dangerously-load-development-channels plugin:coworker@ai-coworker-without-me',
  '매번 치기 번거로우면 claude-cw로 줄여 두세요(Mac·Windows 방법: https://github.com/BrilliantTiger/ai-coworker-without-me/blob/main/INSTALL.md). 이 안내는 한 번만 나옵니다.',
].join('\n')

// 처음 한 번만 안내를 돌려준다. 한 번 지나가면 표시 파일이 남아 다시 돌려주지 않는다.
export function firstTimeHint(home: string): string | undefined {
  const seen = join(home, 'hint-shown')
  if (existsSync(seen)) return undefined
  mkdirSync(home, { recursive: true })
  writeFileSync(seen, `${new Date().toISOString()}\n`)
  return HINT
}
