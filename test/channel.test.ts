import { expect, test } from 'bun:test'
import { channelRequested, detectChannel, launcherCommandLine } from '../src/channel'

test('a Claude Code started with this server as a development channel is a channel session', () => {
  expect(channelRequested('claude --dangerously-load-development-channels server:coworker')).toBe(true)
  expect(channelRequested('claude --model haiku --dangerously-load-development-channels server:coworker --resume')).toBe(true)
  expect(channelRequested('claude --dangerously-load-development-channels=server:coworker')).toBe(true)
  expect(channelRequested('claude --dangerously-load-development-channels server:other server:coworker')).toBe(true)
  expect(channelRequested('claude --dangerously-load-development-channels plugin:coworker@mine', true)).toBe(true)
  expect(channelRequested('claude --dangerously-load-development-channels plugin:coworker', true)).toBe(true)
})

test('with both a plugin and a directly added server, only the one named in the channel list is a channel', () => {
  // 플러그인을 채널로 켜도 직접 등록한 서버는 채널이 아니다. Claude Code 가 그 서버의 알림을 버린다.
  const plugin = 'claude --dangerously-load-development-channels plugin:coworker@ai-coworker-without-me'
  expect(channelRequested(plugin, true)).toBe(true)
  expect(channelRequested(plugin, false)).toBe(false)
  const server = 'claude --dangerously-load-development-channels server:coworker'
  expect(channelRequested(server, false)).toBe(true)
  expect(channelRequested(server, true)).toBe(false)
  expect(channelRequested('claude --dangerously-load-development-channels plugin:coworker2@mine', true)).toBe(false)
})

test('anything else is not a channel session', () => {
  expect(channelRequested('claude')).toBe(false)
  expect(channelRequested('claude --dangerously-load-development-channels server:webhook')).toBe(false)
  expect(channelRequested('claude --dangerously-load-development-channels server:coworker2')).toBe(false)
  expect(channelRequested('claude --dangerously-load-development-channels server:webhook --resume server:coworker')).toBe(false)
  // 사람 없이 돌리면 Claude Code 가 채널 옵션을 무시한다.
  expect(channelRequested('claude -p hi --dangerously-load-development-channels server:coworker')).toBe(false)
  expect(channelRequested('codex')).toBe(false)
  // --channels 는 승인된 플러그인만 받는다. 이 서버를 적으면 Claude Code 가 거절하고 채널을 켜지 않는다.
  expect(channelRequested('claude --channels server:coworker')).toBe(false)
})

test('only the program that started this server counts, not a Claude Code further up', () => {
  const claude = 'claude --dangerously-load-development-channels server:coworker'
  expect(launcherCommandLine([claude, 'tmux'])).toBe(claude)
  expect(launcherCommandLine(['C:\\Windows\\system32\\cmd.exe /c bun mcp.ts', claude])).toBe(claude)
  expect(launcherCommandLine(['"C:\\Windows\\system32\\cmd.exe" /c bun mcp.ts', claude])).toBe(claude)
  expect(launcherCommandLine(['codex', '-zsh', claude])).toBe('codex')
  // chocolatey 등이 까는 bun.exe 껍데기는 진짜 bun 을 다시 띄운다. Windows 에서 실제로 이렇게 잡혔다.
  const winClaude = '"C:\\Users\\me\\.local\\bin\\claude.exe" --dangerously-load-development-channels server:coworker'
  expect(launcherCommandLine(['"C:\\ProgramData\\chocoportable\\bin\\bun.exe" C:\\me\\src\\mcp.ts', winClaude])).toBe(winClaude)
  expect(launcherCommandLine(['"C:\\Program Files\\Codex\\codex.exe" mcp', winClaude])).toStartWith('"C:\\Program Files\\Codex')
  // 훅은 셸을 거쳐 뜬다. Windows 에서는 Git Bash 다.
  expect(launcherCommandLine(['"C:\\Program Files\\Git\\usr\\bin\\bash.exe" -c "bun hint.ts"', winClaude])).toBe(winClaude)
})

test('a server not started by Claude Code never reads command lines', () => {
  expect(detectChannel({})).toBe(false)
  expect(detectChannel({ COWORKER_CHANNEL: 'on' })).toBe(true)
  expect(detectChannel({ CLAUDECODE: '1', COWORKER_CHANNEL: 'off' })).toBe(false)
})
