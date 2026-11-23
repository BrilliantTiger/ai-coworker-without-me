import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { Bridge, outsideLimitsFrom, parsePorts, pathInside, routeId, type SavedBridge } from './bridge'
import { LinkLog } from './linklog'
import { osNotify } from './notify'
import { listSaved, readSaved, savedPath, stillRunning, waitUntilStopped } from './resume'
import { spawnOutsideJob } from './winjob'

// 지킴이. 세션이 닫혀도 그 세션의 다리를 지킨다.
//
// 다리는 AI 도구가 띄운 MCP 서버 프로세스 안에서 돈다. 그래서 세션이 닫히면 다리도 같이 멈췄다.
// 2026-11-17 ~ 18 에 Orca 채팅형 세션이 세 번 닫혔다(앱 종료, 앱 자동 업데이트, 쉬는 세션 내리기).
// 세 번 모두 다리가 같이 내려갔고, 15초 · 2시간 5분 · 15시간 동안 상대가 보낸 글이 전해지지 않았다.
//
// 그래서 다리를 열 때 세션 밖에 지킴이 프로세스를 하나 세워 둔다. 지킴이는 다리를 쥔 프로세스를 지켜보기만 한다.
// 그 프로세스가 어떻게든 멈추면(세션을 닫음, 강제 종료, 앱 종료 · 업데이트) 지킴이가 같은 키로 같은 포트를 이어 연다.
//   - 새 포트를 열지 않는다. 지켜보는 동안에는 다리의 포트에 붙어 있고, 이어 연 뒤에는 그 포트 하나만 연다. 대화 보기 화면은 열지 않는다.
//   - 글을 받아 저장해 둔다. 상대에게는 「AI 세션이 닫혀 있다. 글은 받아 두었다」고 알리고, 이쪽 사람에게는 OS 알림을 띄운다.
//   - 세션이 다시 열리면 그 세션에 다리를 넘겨주고 끝난다. 받아 둔 글은 AI가 inbox 로 읽는다.
//   - 사람이 다리를 닫으면(close_bridge) 지킴이도 끝난다. 언제 지켜보기 시작했고, 넘겨받고, 넘겨줬는지는 연결 기록에 남는다.
// 로그인 항목(launchd 등)으로 상주시키지 않은 까닭: 사람의 동의 없이 PC에 로그인 항목을 깔게 된다.
// PC를 다시 켠 뒤에는, 이 PC에서 coworker 가 처음 뜰 때 지키던 다리를 다시 지킨다(reviveKept).
//
// COWORKER_KEEP=off 면 지킴이를 세우지 않는다(전처럼 세션이 닫히면 다리도 멈춘다).
// 저장소에서 직접 띄운 서버(src/mcp.ts)와 시험에서는 COWORKER_KEEP=on 일 때만 세운다.

// 다리를 쥔 프로세스가 멈춘 뒤 이어 열기 전에 기다리는 시간. Claude Code 가 MCP 서버만 다시 띄우는 것이면 그 사이에 새 서버가 다리를 연다.
const GRACE_MS = Number(process.env.COWORKER_KEEP_GRACE_MS) || 3000
// 이 PC에서 지킴이가 쥘 수 있는 다리의 수. 넘으면 가장 오래 쥔 지킴이부터 끝난다(저장한 상태는 남는다).
const MAX_KEPT = Number(process.env.COWORKER_KEEP_MAX) || 10
// 받아 둔 글을 사람에게 알리는 간격.
const NOTIFY_GAP_MS = 5 * 60_000
const CAP_CHECK_MS = Number(process.env.COWORKER_KEEP_CHECK_MS) || 5 * 60_000
// 지켜보는 요청을 다시 거는 간격. Bun 이 답 없는 요청을 끊는 6분보다 짧게 둔다.
const WATCH_MS = Number(process.env.COWORKER_KEEP_WATCH_MS) || 4 * 60_000
const KOREAN = /[가-힣]/

export function keepsBridges(env: Record<string, string | undefined> = process.env, script: string = process.argv[1] ?? ''): boolean {
  const set = env.COWORKER_KEEP ?? ''
  if (/^(off|false|0|no)$/i.test(set)) return false
  if (/^(on|true|1|yes)$/i.test(set)) return true
  return basename(script) === 'coworker.js'
}

// 지킴이에게 넘기는 환경. 세션의 환경에는 API 키 같은 비밀이 들어 있을 수 있다. 오래 남는 프로세스에 그것을 물려주지 않는다.
const ENV_KEEP = new Set(
  'PATH HOME USER LOGNAME SHELL LANG TMPDIR TEMP TMP TZ USERPROFILE APPDATA LOCALAPPDATA PROGRAMDATA SYSTEMROOT SYSTEMDRIVE WINDIR COMSPEC PATHEXT HOMEDRIVE HOMEPATH USERNAME USERDOMAIN BUN_INSTALL HTTP_PROXY HTTPS_PROXY NO_PROXY ALL_PROXY SSL_CERT_FILE SSL_CERT_DIR NODE_EXTRA_CA_CERTS DISPLAY WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS'.split(
    ' ',
  ),
)
export function keeperEnv(env: Record<string, string | undefined>, home: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue
    const upper = name.toUpperCase()
    if (ENV_KEEP.has(upper) || /^(COWORKER_|LC_|XDG_)/.test(upper)) out[name] = value
  }
  out.COWORKER_HOME = home
  return out
}

// MCP 서버와 같이 --no-install 로 띄운다: 지킴이도 켜질 때 아무것도 깔지 않는다.
// 작업 폴더는 coworker 폴더로 둔다. 지킴이는 세션보다 오래 산다. 세션의 작업 폴더(프로젝트 폴더, 플러그인 폴더)를 물려받으면,
// Windows 에서는 지킴이가 사는 내내 그 폴더를 지우거나 옮길 수 없다.
const keeperCommand = (args: string[]) => [process.execPath, '--no-install', resolve(process.argv[1] ?? ''), ...args]
const keeperFolder = (home: string) => (existsSync(home) ? home : undefined)

function launch(args: string[], home: string) {
  try {
    const [program, ...rest] = keeperCommand(args)
    const child = spawn(program!, rest, {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
      cwd: keeperFolder(home),
      env: keeperEnv(process.env, home),
    })
    child.on('error', () => {})
    child.unref()
  } catch {}
}

// 이 세션(이름표 id)의 다리를 지켜볼 지킴이를 세운다. 다리를 열 때마다 부른다.
//
// 앱은 세션을 닫으며 그 세션에서 나온 프로세스까지 끝낸다. 지킴이는 그때 살아남아야 한다.
// macOS 의 Orca 가 채팅형 세션을 닫는 방법(1.4.258 · 1.4.262 의 코드에서 확인):
//   - 세션의 프로세스 묶음(process group) 전체에 SIGTERM, 이어서 SIGKILL 을 보낸다.
//   - 프로세스 표(ps 의 pid · ppid)에서 세션 아래에 있는 것(자식, 그 자식 …)에도 보낸다.
//     닫을 때 아래에 있는 것뿐 아니라, 세션이 도는 동안 한 번 읽어 둔 표에 있던 것에도 보낸다.
// 그래서 지킴이는 자기 묶음으로 따로 뜨고, 한순간도 세션 아래에 있지 않게 두 프로세스를 거쳐 뜬다:
//   1. 첫 프로세스(keep --detach)는 둘째를 띄우고 바로 끝난다.
//   2. 둘째(keep --apart)는 첫 프로세스가 끝나서 자기 부모가 바뀐 것을 본 뒤에 지킴이를 띄우고 끝난다.
// 한 프로세스만 거치면 지킴이는 뜨는 동안 잠깐 세션 아래에 있다. 앱이 그 틈에 프로세스 표를 읽으면 지킴이도 세션과 함께 끝난다.
//
// Windows 는 다르게 묶는다. 앱이 작업 개체(Job Object)에 든 프로세스를 모두 끝내면 부모가 없는 프로세스도 함께 끝난다.
// 그래서 Windows 에서는 첫 프로세스가 지킴이를 작업 개체 밖에 띄운다(winjob.ts). 그렇게 띄우지 못하면 여느 방법으로 띄운다.
export function startKeeper(home: string, id: string) {
  launch(['keep', '--detach', id], home)
}

// 둘째 프로세스가 첫 프로세스가 끝나기를 기다리는 가장 긴 시간. 첫 프로세스는 둘째를 띄우자마자 끝나므로 보통 몇 ms 다.
// 이 시간이 지나도 끝나지 않으면 지킴이를 그대로 띄운다. 지킴이가 없는 것보다 낫다.
const APART_WAIT_MS = 5000

const logOf = (home: string, saved: SavedBridge) => {
  const dir = pathInside(home, 'logs')
  return new LinkLog(dir ? pathInside(dir, `${routeId(saved.publicKey)}.log`) : undefined)
}

// 지킴이가 지금 그 다리를 쥐고 있는지. 저장한 상태에 적힌 pid 가 살아 있는지로 보지 않는다: 끝난 프로세스의 pid 는 다른 프로세스가 다시 쓸 수 있고,
// 컨테이너에서는 끝난 프로세스가 거두어지지 않은 채 남기도 한다. 그 포트에서 그 키로 답하는지를 본다.
const held = async (saved: SavedBridge) => !!saved.keptBy && (await stillRunning(saved))

const hasSomethingToKeep = (saved: SavedBridge) => saved.peers.length > 0 || saved.tokens.some(t => (t.expires ?? Infinity) > Date.now())

// bun coworker.js keep <세션 이름표>            지킴이로 돈다(coworker 가 띄운다).
// bun coworker.js keep --detach <세션 이름표>   위의 것을 따로 띄우고 바로 끝난다(startKeeper 의 설명).
// bun coworker.js keep --apart <세션 이름표> <첫 프로세스의 pid>   --detach 가 거치는 둘째 프로세스.
// bun coworker.js keep list                     이 PC에서 지킴이가 쥐고 있는 다리를 보여 준다.
// bun coworker.js keep stop                     지킴이가 쥔 다리를 모두 놓는다. 저장한 상태는 남고, 세션을 다시 열면 이어진다.
export async function keep(home: string, args: string[]): Promise<number> {
  const [first, second, third] = args
  if (first === '--detach' && second) {
    if (process.platform === 'win32') {
      const outside = await spawnOutsideJob(keeperCommand(['keep', second]), keeperFolder(home), keeperEnv(process.env, home))
      if (!outside) launch(['keep', second], home)
      return 0
    }
    launch(['keep', '--apart', second, String(process.pid)], home)
    // COWORKER_KEEP_START_HOLD_MS 는 시험용이다. 이 프로세스가 둘째를 띄운 뒤에도 그만큼 살아 있는다.
    const hold = Number(process.env.COWORKER_KEEP_START_HOLD_MS) || 0
    if (hold > 0) await Bun.sleep(hold)
    return 0
  }
  if (first === '--apart' && second) {
    // 첫 프로세스가 끝나면 이 프로세스의 부모가 바뀐다(그 시스템의 첫 프로세스가 맡는다). 그 뒤에 띄운 지킴이는 세션 아래에 있은 적이 없다.
    const starter = Number(third)
    const end = Date.now() + APART_WAIT_MS
    while (starter > 0 && process.ppid === starter && Date.now() < end) await Bun.sleep(5)
    launch(['keep', second], home)
    return 0
  }
  if (first === 'list') return list(home)
  if (first === 'stop') return stopAll(home)
  if (!first || first.startsWith('-')) {
    console.error('usage: bun coworker.js keep list | stop')
    return 1
  }
  return guard(home, first)
}

async function guard(home: string, id: string): Promise<number> {
  const path = savedPath(home, id)
  // 다리를 연 쪽은 상태를 저장한 뒤에 지킴이를 띄운다(Bridge.open). 그래서 파일이 없으면 그 사이에 사람이 다리를 닫은 것이다. 바로 끝난다.
  // 파일은 있는데 읽지 못했으면(다른 프로세스가 쓰는 중이었다) 잠깐 뒤에 다시 읽는다.
  let saved = readSaved(path)
  for (let i = 0; i < 20 && !saved && existsSync(path); i++) {
    await Bun.sleep(100)
    saved = readSaved(path)
  }
  if (!saved) return 0
  const log = logOf(home, saved)
  const me = process.pid
  log.write('keeper_waiting', { keeper: me, watching: saved.pid, port: saved.port, what: 'a keeper watches the process that holds this bridge; it opens no port while it waits' })
  const leave = (why: string) => {
    log.write('keeper_stopped', { keeper: me, why })
    return 0
  }

  // 1) 지켜본다. 다리를 쥔 프로세스가 멈출 때까지 다리의 포트에 붙어 기다린다.
  for (;;) {
    const watching = saved.pid
    const end = await Bridge.watchHolder(saved, WATCH_MS)
    // 붙잡아 둔 요청을 스스로 끊은 것이다. 다리는 그대로다. 바로 다시 건다.
    if (end === 'again') continue
    if (end === 'replaced') return leave('a newer keeper watches this bridge')
    if (end === 'closed') return leave('the bridge was closed by its human')
    await Bun.sleep(GRACE_MS)
    const now = readSaved(path)
    if (!now) return leave('the bridge was closed, or moved to another session')
    if (!(await stillRunning(now))) {
      saved = now
      break
    }
    // 누가 다리를 쥐고 있다. 지켜보던 그 프로세스면(연결만 끊겼거나, 지켜보기를 모르는 옛 판이다) 다시 지켜본다.
    // 다른 프로세스면(세션이 MCP 서버를 다시 띄웠거나 다른 세션이 이어받았다) 그쪽이 세운 지킴이에게 맡기고 끝난다.
    if (now.pid !== watching || now.keptBy) return leave('another process holds this bridge now')
    saved = now
  }
  if (!hasSomethingToKeep(saved)) return leave('no connection and no unused code is left to keep')

  // 2) 이어 연다. 같은 키로, 쓰던 포트 하나만 연다. 그 포트를 못 열면 다른 프로세스가 먼저 쥔 것이다.
  let bridge: Bridge | undefined
  for (let i = 0; i < 20 && !bridge; i++) {
    try {
      bridge = Bridge.restore(saved, {
        home,
        ports: parsePorts(process.env.COWORKER_PORTS),
        relay: process.env.COWORKER_RELAY || undefined,
        relayKey: process.env.COWORKER_RELAY_KEY || undefined,
        outsideLimits: outsideLimitsFrom(process.env),
        saveTo: path,
        nudgeMs: Number(process.env.COWORKER_NUDGE_MS) || undefined,
        tickMs: Number(process.env.COWORKER_TICK_MS) || undefined,
        keeper: true,
      })
    } catch {
      if (await stillRunning(saved)) return leave('another process holds this bridge now')
      await Bun.sleep(250)
      const now = readSaved(path)
      if (!now) return leave('the bridge was closed, or moved to another session')
      saved = now
    }
  }
  if (!bridge) return leave(`port ${saved.port} is in use by another program; the keeper opens no other port`)
  const kept = bridge
  kept.persist()
  kept.note('keeper_took_over', {
    keeper: me,
    port: kept.port,
    connections: kept.peers.size,
    why: 'the process that held this bridge stopped',
    what: 'the keeper receives on the same port with the same key and keeps what arrives; the AI session reads it when it starts again',
  })

  let done = false
  const finish = (why: string) => {
    if (done) return
    done = true
    kept.shutdown(why)
    log.write('keeper_stopped', { keeper: me, why })
    process.exit(0)
  }
  // 세션이 다시 열렸다. 그 세션에 다리를 넘겨줬다.
  kept.onMoved = () => {
    if (done) return
    done = true
    if (kept.stoppedByHuman) log.write('keeper_stopped', { keeper: me, why: 'a human ran "keep stop"; the bridge is down until its session starts again' })
    else log.write('keeper_handed_over', { keeper: me, port: saved!.port, to: 'a session on this PC', what: 'that session holds the bridge now; the keeper has ended' })
    process.exit(0)
  }
  // 받은 글을 이쪽 사람에게 알린다. AI가 닫혀 있어서 대신 알릴 것이 없다.
  let seen = kept.unread().length
  let notifiedAt = 0
  kept.onEvent = () => {
    const events = kept.unread()
    const fresh = events.slice(seen)
    seen = events.length
    const arrived = fresh.findLast(e => e.type === 'message')
    if (!arrived || arrived.type !== 'message' || Date.now() - notifiedAt < NOTIFY_GAP_MS) return
    notifiedAt = Date.now()
    if (KOREAN.test(arrived.text))
      osNotify(`coworker · ${arrived.from}`, `${kept.name}: 새 글이 왔습니다. 이 AI 세션은 닫혀 있어서 받아 두었습니다. 세션을 다시 열면 AI가 읽고 답합니다.`)
    else osNotify(`coworker · ${arrived.from}`, `${kept.name}: a new message arrived. This AI session is closed, so it is kept here. Open the session again and its AI reads and answers it.`)
  }
  // 상대가 모두 떠났고 쓸 수 있는 코드도 없으면 지킬 것이 없다.
  // 코드는 시간이 지나서 못 쓰게 되기도 한다. 그때는 다리에 아무 일도 일어나지 않는다. 그래서 아래에서 때마다 다시 본다.
  const nothingLeft = () => {
    if (!done && kept.isOpen && !kept.worthKeeping) finish('no connection and no unused code is left to keep')
  }
  kept.watch(nothingLeft)
  // 이 PC에서 지킴이가 너무 많은 다리를 쥐지 않게 한다. 더 늦게 쥔 지킴이가 상한만큼 있으면, 오래 쥔 이 지킴이가 끝난다.
  const since = Date.now()
  const overCap = async () => {
    let later = 0
    for (const e of listSaved(home)) {
      if (e.id === id || e.saved.keptBy === me || !(Date.parse(e.saved.keptSince ?? '') > since)) continue
      if (await held(e.saved)) later++
    }
    return later >= MAX_KEPT
  }
  setInterval(() => {
    nothingLeft()
    void overCap()
      .then(over => {
        if (over) finish(`more than ${MAX_KEPT} bridges are kept on this PC; this one was kept the longest. Its saved state stays, and its session takes it up when it starts again`)
      })
      .catch(() => {})
  }, CAP_CHECK_MS)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    try {
      process.on(signal, () => finish('the keeper process was told to stop'))
    } catch {}
  }
  // 다리의 서버가 이 프로세스를 살려 둔다. 넘겨주거나 끝낼 때 process.exit 로 나간다.
  return new Promise<number>(() => {})
}

// PC를 다시 켰거나 지킴이가 죽어서, 지키던 다리를 아무도 쥐고 있지 않다. coworker 가 뜰 때 그런 다리에 지킴이를 다시 세운다.
// 지킴이를 켠 판(0.14 이상)이 저장한 것만 본다. 지킬 것이 없는 다리와 이 세션 자신의 다리(except)는 건너뛴다.
export async function reviveKept(home: string, except?: string): Promise<string[]> {
  const revived: string[] = []
  let kept = 0
  for (const e of listSaved(home)) {
    if (kept >= MAX_KEPT) break
    if (e.id === except || !e.saved.keep || !hasSomethingToKeep(e.saved)) continue
    if (await stillRunning(e.saved)) {
      if (e.saved.keptBy) kept++
      continue
    }
    startKeeper(home, e.id)
    revived.push(e.id)
    kept++
  }
  return revived
}

async function list(home: string): Promise<number> {
  const rows = []
  for (const e of listSaved(home)) if (await held(e.saved)) rows.push(e)
  if (!rows.length) console.log('no bridge is held by a keeper on this PC')
  for (const e of rows)
    console.log(
      `${e.saved.name}  port ${e.saved.port}  keeper pid ${e.saved.keptBy}  since ${e.saved.keptSince ?? '?'}  connected: ${e.saved.peers.map(p => p.name).join(', ') || 'nobody'}  session_id ${e.id}`,
    )
  return 0
}

// 지킴이가 쥔 다리를 모두 놓는다. 지킴이는 상태를 저장하고 끝난다. 다음에 coworker 가 뜰 때 다시 세우지 않게 표시도 지운다.
// 세션을 다시 열면 다리는 전처럼 그 세션에서 이어지고, 그때부터 다시 지킨다.
async function stopAll(home: string): Promise<number> {
  let stopped = 0
  for (const e of listSaved(home)) {
    if (!e.saved.keptBy || !(await stillRunning(e.saved))) continue
    if (!(await Bridge.askToMove(e.saved, true, true))) continue
    await waitUntilStopped(e.saved)
    const path = savedPath(home, e.id)
    try {
      const state = JSON.parse(readFileSync(path, 'utf8')) as SavedBridge
      state.keep = false
      state.keptBy = undefined
      state.keptSince = undefined
      writeFileSync(path, JSON.stringify(state), { mode: 0o600 })
    } catch {}
    console.log(`stopped keeping ${e.saved.name} (port ${e.saved.port})`)
    stopped++
  }
  if (!stopped) console.log('no bridge is held by a keeper on this PC')
  return 0
}
