import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join, resolve } from 'node:path'

// 로그인할 때 coworker 앱을 켜 둔다: bun coworker.js autostart on (끄기: off)
// Mac 은 사용자 LaunchAgent, Windows 는 시작프로그램 폴더의 바로가기다. 둘 다 관리자 권한이 필요 없다.
// Windows 바로가기는 창을 최소화해서 띄워, 앱이 켜져 있다는 것이 작업 표시줄에 보인다.
export const LABEL = 'com.brillianttiger.coworker'

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function launchAgentPlist(bun: string, script: string, log: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(bun)}</string><string>${xml(script)}</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`
}

const ps = (s: string) => s.replace(/'/g, "''")

export function windowsShortcutScript(bun: string, script: string, lnk: string) {
  return [
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${ps(lnk)}')`,
    `$s.TargetPath = '${ps(bun)}'`,
    `$s.Arguments = '"${ps(script)}" serve'`,
    `$s.WindowStyle = 7`,
    `$s.Description = 'AI Co-worker Without Me app'`,
    `$s.Save()`,
    `Start-Process -FilePath '${ps(bun)}' -ArgumentList '"${ps(script)}"', 'serve' -WindowStyle Minimized`,
  ].join('\n')
}

const run = (cmd: string[]) => Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' })
const powershell = (script: string) =>
  run(['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')])

export async function autostart(mode: string | undefined, home: string): Promise<number> {
  if (mode !== 'on' && mode !== 'off') {
    console.error('usage: bun coworker.js autostart on|off')
    return 1
  }
  const bun = process.execPath
  const script = resolve(process.argv[1] ?? '')
  if (platform() === 'darwin') {
    const plist = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
    const domain = `gui/${process.getuid?.() ?? 501}`
    run(['launchctl', 'bootout', `${domain}/${LABEL}`])
    if (mode === 'off') {
      rmSync(plist, { force: true })
      console.log('coworker app stopped and will no longer start at login')
      return 0
    }
    mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true })
    mkdirSync(home, { recursive: true })
    writeFileSync(plist, launchAgentPlist(bun, script, join(home, 'app.log')))
    const loaded = run(['launchctl', 'bootstrap', domain, plist])
    if (!loaded.success) {
      console.error(`launchctl could not start it: ${loaded.stderr.toString().trim()}`)
      return 1
    }
    console.log(`coworker app is running and starts at login (${plist})`)
    return 0
  }
  if (platform() === 'win32') {
    const startup = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
    const lnk = join(startup, 'coworker.lnk')
    // 켜져 있는 앱은 끈다. 다시 켤 때 새 판으로 뜨게 하려는 것이기도 하다.
    powershell(
      `Get-CimInstance Win32_Process -Filter "Name like 'bun%'" | Where-Object { $_.CommandLine -like '*${ps(script.replace(/\[|\]/g, ''))}*serve*' } | Invoke-CimMethod -MethodName Terminate | Out-Null`,
    )
    if (mode === 'off') {
      rmSync(lnk, { force: true })
      console.log('coworker app stopped and will no longer start at login')
      return 0
    }
    mkdirSync(startup, { recursive: true })
    const made = powershell(windowsShortcutScript(bun, script, lnk))
    if (!made.success || !existsSync(lnk)) {
      console.error(`could not set it up: ${made.stderr.toString().trim()}`)
      return 1
    }
    console.log(`coworker app is running and starts at login (${lnk})`)
    return 0
  }
  console.error(`autostart is for macOS and Windows. Here, start the app yourself: bun "${script}" serve`)
  return 1
}
