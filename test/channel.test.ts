import { expect, test } from 'bun:test'
import { channelRequested, detectChannel, launcherCommandLine } from '../src/channel'

test('a Claude Code started with this server as a development channel is a channel session', () => {
  expect(channelRequested('claude --dangerously-load-development-channels server:coworker')).toBe(true)
  expect(channelRequested('claude --model haiku --dangerously-load-development-channels server:coworker --resume')).toBe(true)
  expect(channelRequested('claude --dangerously-load-development-channels=server:coworker')).toBe(true)
  expect(channelRequested('claude --dangerously-load-development-channels server:other server:coworker')).toBe(true)
  expect(channelRequested('claude --channels plugin:coworker@mine')).toBe(true)
})

test('anything else is not a channel session', () => {
  expect(channelRequested('claude')).toBe(false)
  expect(channelRequested('claude --dangerously-load-development-channels server:webhook')).toBe(false)
  expect(channelRequested('claude --dangerously-load-development-channels server:coworker2')).toBe(false)
  expect(channelRequested('claude --dangerously-load-development-channels server:webhook --resume server:coworker')).toBe(false)
  // 사람 없이 돌리면 Claude Code 가 채널 옵션을 무시한다.
  expect(channelRequested('claude -p hi --dangerously-load-development-channels server:coworker')).toBe(false)
  expect(channelRequested('codex')).toBe(false)
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
})

test('a server not started by Claude Code never reads command lines', () => {
  expect(detectChannel({})).toBe(false)
  expect(detectChannel({ COWORKER_CHANNEL: 'on' })).toBe(true)
  expect(detectChannel({ CLAUDECODE: '1', COWORKER_CHANNEL: 'off' })).toBe(false)
})
