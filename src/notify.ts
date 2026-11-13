import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'

// 사람의 화면에 OS 알림을 소리와 함께 띄운다. 사람이 다른 창을 보고 있어도 결정이 기다린다는 것을 놓치지 않게 한다.
// 알림을 띄우지 못해도(명령이 없음, 권한 없음) 다른 일은 그대로 한다.
// COWORKER_NOTIFY=off 이면 띄우지 않는다. COWORKER_NOTIFY_LOG 를 정하면 띄우는 대신 그 파일에 한 줄씩 적는다(시험용).
export type Notify = (title: string, body: string) => void

export function osNotify(title: string, body: string) {
  const log = process.env.COWORKER_NOTIFY_LOG
  if (log) {
    try {
      appendFileSync(log, `${JSON.stringify({ title, body })}\n`)
    } catch {}
    return
  }
  if (process.env.COWORKER_NOTIFY === 'off') return
  const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
  title = short(title, 80)
  body = short(body, 240)
  try {
    if (process.platform === 'darwin')
      // 글은 인자로 넘긴다. 스크립트 안에 넣지 않으므로 따옴표가 섞여도 깨지지 않는다.
      run('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"', '-e', 'end run', title, body])
    else if (process.platform === 'win32')
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_TOAST], { CW_TITLE: title, CW_BODY: body })
    else run('notify-send', ['-u', 'critical', title, body])
  } catch {}
}

// Windows 10 이상의 알림. 글은 환경 변수로 넘겨 명령 안에 끼워 넣지 않는다. 기본 알림 소리가 난다.
const WINDOWS_TOAST = [
  '[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]',
  '$x=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
  "$t=$x.GetElementsByTagName('text')",
  '[void]$t.Item(0).AppendChild($x.CreateTextNode($env:CW_TITLE))',
  '[void]$t.Item(1).AppendChild($x.CreateTextNode($env:CW_BODY))',
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))",
].join(';')

function run(command: string, args: string[], env?: Record<string, string>) {
  const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true, env: env ? { ...process.env, ...env } : process.env })
  child.on('error', () => {})
  child.unref()
}
