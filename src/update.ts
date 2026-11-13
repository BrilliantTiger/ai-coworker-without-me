import { closeSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// 플러그인으로 설치한 coworker 가 스스로 최신 판으로 올린다(사람이 정함, 2026-11-11: 「최초에 시작해서 옛 버전이면 업데이트하면 되지 않아?」).
// 릴리스 브랜치의 매니페스트에서 최신 판 번호를 읽고, 지금 도는 판보다 새로우면 그 앱의 플러그인 명령으로 올린다.
// Claude Code 와 Codex 는 플러그인을 켤 때 불러오므로, 켜 둔 세션은 다시 불러올 때까지 예전 판으로 돈다.
// 끄려면 COWORKER_AUTO_UPDATE=off (Claude Code 는 플러그인 설정의 Auto update 를 off).

export const MARKETPLACE = 'ai-coworker-without-me'
export const PLUGIN = `coworker@${MARKETPLACE}`
const LATEST_URL = 'https://raw.githubusercontent.com/BrilliantTiger/ai-coworker-without-me/release/plugin/.claude-plugin/plugin.json'
// 여러 세션이 한꺼번에 올리지 않게 거는 잠금. 이보다 오래된 잠금은 올리다 멈춘 프로세스가 남긴 것으로 본다.
const STALE_LOCK_MS = 10 * 60_000

export type App = 'claude' | 'codex'

// 새 판이 있는지 보는 간격. COWORKER_UPDATE_EVERY_MS 는 시험용이다.
export const UPDATE_EVERY_MS = Number(process.env.COWORKER_UPDATE_EVERY_MS) || 6 * 60 * 60_000
// 뜬 뒤 처음 볼 때까지. 같은 PC의 여러 세션이 한꺼번에 보지 않게 흩는다. COWORKER_UPDATE_FIRST_MS 는 시험용이다.
export const firstCheckMs = () => Number(process.env.COWORKER_UPDATE_FIRST_MS) || 5_000 + Math.random() * 25_000
export type Run = (cmd: string[]) => Promise<{ code: number; out: string }>

const run: Run = async cmd => {
  const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
  return { code, out }
}

// a 가 b 보다 새 판인가. 0.4.12 같은 번호를 마디마다 숫자로 견준다.
export function newer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  if ([...pa, ...pb].some(n => !Number.isInteger(n))) return false
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

// 릴리스한 최신 판. 플러그인을 설치하는 곳(release 브랜치)의 매니페스트에서 읽는다. 닿지 않으면 모른다고 둔다.
export async function latestVersion(url = process.env.COWORKER_UPDATE_URL || LATEST_URL): Promise<string | undefined> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return undefined
    const version = ((await res.json()) as { version?: unknown }).version
    return typeof version === 'string' && /^\d+(\.\d+)*$/.test(version) ? version : undefined
  } catch {
    return undefined
  }
}

// 이 PC에 지금 설치된 판과 그 범위(Claude Code: user · project 등). 다른 세션이 이미 올렸는지 보려고 쓴다.
export async function installed(app: App, exec: Run = run): Promise<{ version: string; scope?: string } | undefined> {
  try {
    if (app === 'claude') {
      const { code, out } = await exec([command('claude'), 'plugin', 'list', '--json'])
      if (code !== 0) return undefined
      const list = JSON.parse(out) as { id?: string; version?: string; scope?: string }[]
      const found = list.find(p => p.id === PLUGIN)
      return found?.version ? { version: found.version, scope: found.scope } : undefined
    }
    const { code, out } = await exec([command('codex'), 'plugin', 'list'])
    if (code !== 0) return undefined
    const line = out.split('\n').find(l => l.trim().startsWith(`${PLUGIN} `))
    const version = line?.trim().split(/\s{2,}/)[2]
    return version && /^\d+(\.\d+)*$/.test(version) ? { version } : undefined
  } catch {
    return undefined
  }
}

// 새 판이 있으면 올린다. 올렸거나(또는 다른 세션이 이미 올려) 지금 도는 판보다 새 판이 설치돼 있으면 그 판을 돌려준다.
export async function selfUpdate(app: App, current: string, home: string, exec: Run = run): Promise<{ to: string } | undefined> {
  const latest = await latestVersion()
  if (!latest || !newer(latest, current)) return undefined
  const release = lock(home)
  // 다른 세션이 올리는 중이다. 다음에 볼 때 설치된 판을 보고 알린다.
  if (!release) return undefined
  try {
    const before = await installed(app, exec)
    if (!before || newer(latest, before.version)) {
      if (app === 'claude') {
        await exec([command('claude'), 'plugin', 'marketplace', 'update', MARKETPLACE])
        await exec([command('claude'), 'plugin', 'update', PLUGIN, ...(before?.scope ? ['--scope', before.scope] : []), '--json'])
      } else {
        await exec([command('codex'), 'plugin', 'marketplace', 'upgrade', MARKETPLACE])
        await exec([command('codex'), 'plugin', 'add', PLUGIN])
      }
    }
    const after = await installed(app, exec)
    return after && newer(after.version, current) ? { to: after.version } : undefined
  } finally {
    release()
  }
}

// coworker 앱(디렉터리판이 붙는 serve)도 스스로 새 판을 받는다(사람이 정함, 2026-11-12).
// 앱은 플러그인 명령으로 설치한 것이 아니라 사람이 받은 coworker.js 파일 하나라서, 그 파일을 새 판의 릴리스 파일로 바꾼다.
// 받은 파일은 그 판으로 한 번 띄워 판 번호를 물어 보고, 맞을 때만 바꿔 넣는다. 반쯤 받았거나 다른 파일이면 그대로 둔다.
// 도는 앱은 예전 판으로 계속 돈다. 새 판으로 다시 켜는 것은 serve 가 붙은 세션이 없을 때 한다.
// COWORKER_RELEASE_BASE 는 시험용이다.
export const releaseAsset = (version: string) =>
  `${process.env.COWORKER_RELEASE_BASE || 'https://github.com/BrilliantTiger/ai-coworker-without-me/releases/download'}/v${version}/coworker.js`
const BANNER = '// AI Co-worker Without Me: built from src/'

export type AppUpdateDeps = {
  latest?: () => Promise<string | undefined>
  download?: (url: string) => Promise<string | undefined>
  versionOf?: (file: string) => Promise<string | undefined>
}

const download = async (url: string) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  return res.ok ? res.text() : undefined
}

// 받은 파일을 그 판으로 띄워 판 번호를 묻는다(bun coworker.js version).
const versionOfFile = async (file: string) => {
  const p = Bun.spawn([process.execPath, '--no-install', file, 'version'], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
  const timer = setTimeout(() => p.kill(), 15_000)
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
  clearTimeout(timer)
  return code === 0 ? out.trim() : undefined
}

export async function appUpdate(script: string, current: string, home: string, deps: AppUpdateDeps = {}): Promise<{ to: string } | undefined> {
  const latest = await (deps.latest ?? latestVersion)()
  if (!latest || !newer(latest, current)) return undefined
  const release = lock(home)
  if (!release) return undefined
  const tmp = `${script}.download`
  try {
    const text = await (deps.download ?? download)(releaseAsset(latest)).catch(() => undefined)
    // 묶은 파일은 #!/usr/bin/env bun, // @bun 다음 줄에 이 안내가 있다.
    if (!text?.slice(0, 500).includes(BANNER)) return undefined
    writeFileSync(tmp, text)
    if ((await (deps.versionOf ?? versionOfFile)(tmp).catch(() => undefined)) !== latest) return undefined
    renameSync(tmp, script)
    return { to: latest }
  } finally {
    rmSync(tmp, { force: true })
    release()
  }
}

// 명령의 실제 경로. Windows 에서는 claude.exe 처럼 확장자가 붙는다. 찾지 못하면 이름 그대로 둔다.
function command(name: string) {
  return Bun.which(name) ?? name
}

function lock(home: string): (() => void) | undefined {
  const path = join(home, 'update.lock')
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 })
    closeSync(openSync(path, 'wx'))
    return () => rmSync(path, { force: true })
  } catch {
    try {
      if (Date.now() - statSync(path).mtimeMs > STALE_LOCK_MS) {
        rmSync(path, { force: true })
        closeSync(openSync(path, 'wx'))
        return () => rmSync(path, { force: true })
      }
    } catch {}
    return undefined
  }
}
