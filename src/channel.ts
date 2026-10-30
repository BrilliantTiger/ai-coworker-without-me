import { platform } from 'node:os'

// Claude Code 를 Channels 로 켰는지 알아낸다.
// Claude Code 는 이 MCP 를 채널로 등록했는지 알려 주지 않는다(초기화 때 오는 정보에 없다).
// 채널로 등록되지 않은 세션에 보낸 알림은 오류 없이 버려지므로, 확실할 때만 채널로 보낸다.
// 그래서 이 MCP 를 띄운 Claude Code 의 실행 인자에 채널 옵션과 이 서버 이름이 함께 있는지 본다.

// 직접 만든 채널은 이 옵션으로 켤 때만 받는다. --channels 는 Anthropic 이 승인한 플러그인만 받는다.
// --channels server:coworker 로 켜면 Claude Code 가 「server: entries need --dangerously-load-development-channels」를 띄우고
// 채널을 켜지 않는다(2026-10-29, 2.1.312). 그때 채널로 알면 보낸 알림이 버려지고 AI는 기다리지도 않아 메시지를 놓친다.
const CHANNEL_FLAG = '--dangerously-load-development-channels'

// 실행 인자 한 줄에서 이 서버를 채널로 켰는지 본다.
// 예: claude --dangerously-load-development-channels server:coworker
// 플러그인으로 깐 서버는 plugin:coworker@… 로만, 직접 등록한 서버는 server:coworker 로만 채널이 된다.
// 둘 다 깔린 PC에서 플러그인을 채널로 켜면 직접 등록한 서버도 같은 실행 인자를 본다. 그 서버까지 채널로 알면
// AI가 그쪽 도구를 골랐을 때 Claude Code 가 알림을 버려(「coworker not in --channels list」) 메시지를 놓친다(2026-10-29).
export function channelRequested(commandLine: string, asPlugin = false, server = 'coworker'): boolean {
  const args = commandLine.trim().split(/\s+/)
  // -p 처럼 사람 없이 돌리면 Claude Code 가 채널 옵션을 무시한다.
  if (args.some(a => a === '-p' || a === '--print')) return false
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i]!.split(/=(.*)/s, 2)
    if (flag !== CHANNEL_FLAG) continue
    const entries = inline !== undefined ? [inline] : []
    for (let j = i + 1; inline === undefined && j < args.length && !args[j]!.startsWith('-'); j++) entries.push(args[j]!)
    const names = entries.flatMap(e => e.split(','))
    const mine = (n: string) => (asPlugin ? n === `plugin:${server}` || n.startsWith(`plugin:${server}@`) : n === `server:${server}`)
    if (names.some(mine)) return true
  }
  return false
}

// 이 프로세스를 띄운 프로세스부터 위로 몇 단계의 실행 인자.
export function ancestorCommandLines(depth = 4): string[] {
  try {
    return platform() === 'win32' ? windowsAncestors(depth) : posixAncestors(depth)
  } catch {
    return []
  }
}

function posixAncestors(depth: number): string[] {
  const lines: string[] = []
  let pid = process.ppid
  for (let i = 0; i < depth && pid > 1; i++) {
    const text = Bun.spawnSync(['ps', '-o', 'ppid=,command=', '-p', String(pid)]).stdout.toString().trim()
    const match = /^(\d+)\s+(.*)$/s.exec(text)
    if (!match) break
    lines.push(match[2]!)
    pid = Number(match[1])
  }
  return lines
}

// Windows 는 실행 인자를 PowerShell 로만 읽을 수 있다. 프로세스 하나씩 물으면 단계마다 0.3초가 더 들어서,
// 전체 목록을 한 번에 받아 위로 따라간다(2026-10-29 Windows PC에서 잰 값: 하나씩 4단계 1.5초, 한 번에 0.7초).
// 따옴표가 깨지지 않게 스크립트는 인코딩해서 넘기고, 실행 인자는 base64 로 받는다.
function windowsAncestors(depth: number): string[] {
  const script = `$all = @{}
Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CommandLine | ForEach-Object { $all[[int]$_.ProcessId] = $_ }
$id = ${process.ppid}
for ($i = 0; $i -lt ${depth} -and $all.ContainsKey($id); $i++) {
  $p = $all[$id]
  [Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$p.CommandLine)))
  $id = [int]$p.ParentProcessId
}`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const out = Bun.spawnSync(['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]).stdout.toString()
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => Buffer.from(line.trim(), 'base64').toString('utf8'))
}

// 셸이나 bun 껍데기를 거쳐 띄운 경우에는 건너뛴다.
// Windows 의 cmd /c, 그리고 chocolatey 등이 까는 bun.exe 껍데기는 진짜 bun 을 다시 띄운다.
// Claude Code 는 훅을 셸로 띄운다. Windows 에서는 Git Bash(bash.exe)다.
const WRAPPERS = new Set(['sh', 'sh.exe', 'bash', 'bash.exe', 'zsh', 'fish', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'bun', 'bun.exe'])

// 이 MCP 를 띄운 프로그램 하나만 본다. 더 위까지 보면, 채널로 켠 Claude Code 안에서 띄운 Codex 도 채널로 잘못 안다.
export function launcherCommandLine(lines: string[]): string | undefined {
  return lines.find(line => {
    const exe = /^\s*(?:"([^"]*)"|(\S+))/.exec(line)
    const path = exe?.[1] ?? exe?.[2] ?? ''
    return !WRAPPERS.has(path.replace(/^.*[\\/]/, '').replace(/^-/, '').toLowerCase())
  })
}

// COWORKER_CHANNEL=on|off 은 시험용이다. 없으면 실행 인자로 정한다.
export function detectChannel(env = process.env): boolean {
  if (env.COWORKER_CHANNEL === 'on') return true
  if (env.COWORKER_CHANNEL === 'off') return false
  // Claude Code 가 띄운 MCP 에는 CLAUDECODE=1 이 붙는다. 없으면 실행 인자를 읽지 않는다(Windows 에서 1초를 아낀다).
  if (env.CLAUDECODE !== '1') return false
  const launcher = launcherCommandLine(ancestorCommandLines())
  // Claude Code 는 플러그인이 띄운 MCP 에만 CLAUDE_PLUGIN_ROOT 를 붙인다.
  return !!launcher && channelRequested(launcher, !!env.CLAUDE_PLUGIN_ROOT)
}
