import { afterAll, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { routeId } from '../src/bridge'
import { keeperEnv, keepsBridges } from '../src/keep'
import { readSaved, savedPath, stillRunning } from '../src/resume'

// 지킴이(src/keep.ts): 세션이 닫혀도 다리가 살아서 글을 받고, 세션이 다시 열리면 이어 붙는다.
// 2026-11-17 ~ 18 에 Orca 채팅형 세션이 앱 종료 · 앱 자동 업데이트 · 쉬는 세션 내리기로 닫힐 때마다 다리(7700 포트)가 같이 내려갔다.
// 여기서는 실제 MCP 서버 프로세스를 띄우고 그 프로세스를 끝내서, 세 경우를 그대로 만든다.
const MCP = join(import.meta.dir, '..', 'src', 'mcp.ts')
const clients: Client[] = []
const keepers = new Set<number>()
// 시험마다 쓰는 coworker 폴더. 끝날 때 그 연결 기록에서 지킴이를 찾아 모두 끝낸다.
const homes: string[] = []
const newHome = (tag: string) => {
  const home = mkdtempSync(join(tmpdir(), `coworker-keep-${tag}-`))
  homes.push(home)
  return home
}
let nextPort = 18400

type Row = { event: string; keeper?: number; why?: string; port?: number; [field: string]: unknown }
type Tool = (name: string, args?: Record<string, unknown>) => Promise<any>

// 서버를 자기 프로세스 묶음의 우두머리로 띄우는 프로세스. 앱은 세션을 그렇게 띄운다(Orca 가 채팅형 세션의 Claude Code 를 그렇게 띄운다).
// 서버를 따로 띄우고(detached) 입출력을 그대로 물려준다. 서버의 pid 를 파일에 적고, 서버가 끝나면 같이 끝난다.
const LEAD = `
const { spawn } = require('node:child_process')
const child = spawn(process.execPath, [process.env.LEAD_RUN], { stdio: 'inherit', detached: true })
require('node:fs').writeFileSync(process.env.LEAD_PID_FILE, String(child.pid))
child.on('exit', code => process.exit(code ?? 1))
`

async function start(clientName: string, env: Record<string, string>, cwd?: string, ownGroup = false) {
  const client = new Client({ name: clientName, version: '1.0.0' })
  const pidFile = ownGroup ? join(mkdtempSync(join(tmpdir(), 'coworker-keep-lead-')), 'pid') : ''
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ownGroup ? ['-e', LEAD] : [MCP],
    // 지킴이는 저장소에서 띄운 서버에서는 꺼져 있다. 지킬 세션에만 COWORKER_KEEP=on 을 준다.
    env: {
      ...process.env,
      COWORKER_CHANNEL: 'off',
      CLAUDE_CODE_SESSION_ID: '',
      COWORKER_AUTO_UPDATE: 'off',
      COWORKER_NOTIFY: 'off',
      COWORKER_LISTEN_MS: '0',
      COWORKER_KEEP: 'off',
      ...env,
      ...(ownGroup ? { LEAD_RUN: MCP, LEAD_PID_FILE: pidFile } : {}),
    } as Record<string, string>,
    stderr: 'inherit',
    cwd,
  })
  await client.connect(transport)
  clients.push(client)
  const call: Tool = async (name, args = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] }
    const text = res.content[0]!.text
    if (res.isError) throw new Error(text)
    return JSON.parse(text)
  }
  return { call, client, pid: ownGroup ? Number(readFileSync(pidFile, 'utf8')) : transport.pid! }
}

// 프로세스 표: pid → 부모 pid · 프로세스 묶음(pgid). Linux 는 /proc 에서 읽는다(ps 가 없는 곳이 있다). macOS 는 ps 로 읽는다.
// Orca 도 세션을 닫을 때 이 표(ps 의 pid · ppid · pgid)로 끝낼 프로세스를 고른다.
function processTable() {
  const table = new Map<number, { parent: number; group: number }>()
  if (existsSync('/proc/self/stat')) {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue
      try {
        const [, parent, group] = readFileSync(`/proc/${name}/stat`, 'utf8').split(') ').pop()!.split(' ')
        table.set(Number(name), { parent: Number(parent), group: Number(group) })
      } catch {}
    }
    return table
  }
  for (const line of Bun.spawnSync(['ps', '-axo', 'pid=,ppid=,pgid=']).stdout.toString().split('\n')) {
    const [pid, parent, group] = line.trim().split(/\s+/).map(Number)
    if (pid) table.set(pid, { parent: parent ?? 0, group: group ?? 0 })
  }
  return table
}

// 그 표에서 root 아래에 있는 프로세스(자식, 그 자식 …).
function under(root: number, table = processTable()) {
  const found: number[] = []
  const todo = [root]
  while (todo.length) {
    const at = todo.pop()!
    for (const [pid, row] of table) {
      if (row.parent !== at || found.includes(pid)) continue
      found.push(pid)
      todo.push(pid)
    }
  }
  return found
}

const alive = (pid: number | undefined) => {
  if (!pid) return false
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  // Linux 에서 끝난 프로세스는 부모가 거둘 때까지 이름만 남는다(좀비). 지킴이는 부모 없이 돌아서, 거두는 것은 그 시스템의 첫 프로세스다.
  // 컨테이너처럼 그것이 늦는 곳에서는 끝난 지킴이가 살아 있는 것처럼 보인다. 그것은 끝난 것으로 센다.
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').pop()![0] !== 'Z'
  } catch {
    return true
  }
}

async function until<T>(look: () => T | undefined | false | Promise<T | undefined | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const found = await look()
    if (found) return found
    if (Date.now() > end) throw new Error('did not happen in time')
    await Bun.sleep(50)
  }
}

// AI가 읽어 간 소식은 0.1초 뒤에 저장한 상태에서도 빠진다(bridge.ts 의 dirty). 그 전에 세션이 죽으면, 다시 켠 세션이 같은 소식을 한 번 더 받는다.
// 소식을 잃는 것보다 한 번 더 받는 쪽으로 둔 것이다. 시험은 읽은 것이 저장된 뒤에 세션을 끝낸다. 그래야 다시 켠 뒤에 받는 소식이 늘 같다.
const settled = (path: string) =>
  until(() => {
    const saved = readSaved(path)
    return !!saved && !saved.events?.length
  })

// Claude Code 세션 A(지킴이를 켬)와 Codex 세션 B를 잇는다. A의 다리가 이 시험에서 지켜볼 다리다.
// enter 는 A가 뜬 뒤, 다리를 열기 전에(지킴이가 뜨기 전에) 부른다.
// ownGroup 이면 A의 서버가 자기 프로세스 묶음의 우두머리다.
async function pairUp(tag: string, extra: Record<string, string> = {}, cwd?: string, enter?: (pid: number) => void, ownGroup = false) {
  const home = newHome(tag)
  const ports = `${nextPort}-${nextPort + 9}`
  nextPort += 10
  const id = `keep-${tag}`
  const notifyLog = join(home, 'notify.log')
  const env = {
    COWORKER_HOME: home,
    COWORKER_PORTS: ports,
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: id,
    CLAUDE_PLUGIN_ROOT: join(home, 'plugin'),
    COWORKER_KEEP: 'on',
    COWORKER_KEEP_GRACE_MS: '400',
    COWORKER_NOTIFY_LOG: notifyLog,
    ...extra,
  }
  const a = await start('claude-code', env, cwd, ownGroup)
  enter?.(a.pid)
  const b = await start('codex-mcp-client', { COWORKER_HOME: home, COWORKER_PORTS: ports })
  const opened = await a.call('open_bridge', {})
  await b.call('connect', { code: opened.code })
  await a.call('wait_for_message', { timeout_sec: 5 })
  const path = savedPath(home, id)
  await settled(path)
  const saved = readSaved(path)!
  const logFile = join(home, 'logs', `${routeId(saved.publicKey)}.log`)
  const log = (): Row[] => {
    if (!existsSync(logFile)) return []
    const rows = readFileSync(logFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Row)
    for (const r of rows) if (r.event.startsWith('keeper_') && r.keeper) keepers.add(r.keeper)
    return rows
  }
  const row = (event: string, nth = 0) => until(() => log().filter(r => r.event === event)[nth])
  // B가 받은 소식을 모은다. 찾는 것이 올 때까지 기다린다.
  const heard: any[] = []
  const hears = (ok: (e: any) => boolean) =>
    until(async () => {
      heard.push(...(await b.call('inbox')).events)
      return heard.find(ok)
    })
  return { home, env, id, path, a, b, opened, saved, log, row, heard, hears, notifyLog }
}

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => {})
  // 시험이 중간에 실패해도 지킴이 프로세스를 남기지 않는다. 시험이 읽기 전에 멈춘 줄에 적힌 지킴이도 연결 기록에서 찾는다.
  await Bun.sleep(600)
  for (const home of homes) {
    const dir = join(home, 'logs')
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir)) {
      for (const line of readFileSync(join(dir, file), 'utf8').split('\n').filter(Boolean)) {
        try {
          const r = JSON.parse(line) as Row
          if (r.event.startsWith('keeper_') && r.keeper) keepers.add(r.keeper)
        } catch {}
      }
    }
  }
  for (const pid of keepers) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
})

test('keepers are on for the installed plugin, off for a server run from the repository, and a human can turn them off', () => {
  expect(keepsBridges({}, '/Users/me/.claude/plugins/cache/x/coworker/0.13.0/coworker.js')).toBe(true)
  expect(keepsBridges({}, '/Users/me/ai-coworker-without-me/src/mcp.ts')).toBe(false)
  expect(keepsBridges({ COWORKER_KEEP: 'off' }, '/x/coworker.js')).toBe(false)
  expect(keepsBridges({ COWORKER_KEEP: 'on' }, '/x/src/mcp.ts')).toBe(true)
})

test('a keeper does not inherit the secrets in the session environment', () => {
  const env = keeperEnv(
    { PATH: '/usr/bin', HOME: '/Users/me', ANTHROPIC_API_KEY: 'sk-secret', GITHUB_TOKEN: 'ghp_secret', CLAUDE_CODE_SESSION_ID: 's', COWORKER_PORTS: '7700-7799', COWORKER_RELAY_KEY: 'k', LC_ALL: 'ko_KR.UTF-8', Path: 'C:\\Windows' },
    '/Users/me/.coworker',
  )
  expect(env).toEqual({ PATH: '/usr/bin', HOME: '/Users/me', COWORKER_PORTS: '7700-7799', COWORKER_RELAY_KEY: 'k', LC_ALL: 'ko_KR.UTF-8', Path: 'C:\\Windows', COWORKER_HOME: '/Users/me/.coworker' })
})

// 조건 (2): 세션 강제 종료 · 다시 열기.
test('a session that is killed keeps its bridge: a keeper takes over the same port with the same key, keeps what arrives, and hands the bridge back when the session starts again', async () => {
  const t = await pairUp('kill')
  // 다리를 열 때 지킴이가 서서 지켜본다. 지켜보는 동안 포트를 열지 않는다.
  const waiting = await t.row('keeper_waiting')
  expect(waiting.port).toBe(t.opened.port)
  expect(alive(waiting.keeper)).toBe(true)
  expect(t.saved.keep).toBe(true)

  // 세션을 강제로 끝낸다. 서버 프로세스는 저장도 정리도 못 하고 죽는다.
  process.kill(t.a.pid, 'SIGKILL')
  const took = await t.row('keeper_took_over')
  expect(took).toMatchObject({ keeper: waiting.keeper, port: t.opened.port, connections: 1 })
  const held = readSaved(t.path)!
  // 같은 키, 같은 포트다. 대화 보기 화면 같은 다른 포트는 열지 않는다.
  expect(held).toMatchObject({ publicKey: t.saved.publicKey, port: t.opened.port, keptBy: waiting.keeper })
  expect(await stillRunning(held)).toBe(true)
  await expect(fetch(t.opened.viewer, { signal: AbortSignal.timeout(1000) })).rejects.toThrow()

  // 상대는 AI 세션이 닫혔다는 것을 안다. 그래도 보낸 글은 닿고, 그 PC가 받아 둔다.
  expect(await t.hears(e => e.type === 'peer_session_closed')).toMatchObject({ peer: t.opened.name })
  const sent = await t.b.call('send_question', { question: '세션이 닫힌 동안에도 받나요?' })
  expect(sent.delivery).toBe('delivered')
  expect(sent.their_ai_session).toStartWith('closed since ')
  const listed = await t.b.call('list_connections')
  expect(listed.peers[0]).toMatchObject({ reachable: true, state: 'connected', their_ai_session: 'closed' })
  // 이쪽 사람에게는 OS 알림이 간다.
  const note = await until(() => existsSync(t.notifyLog) && readFileSync(t.notifyLog, 'utf8').split('\n').find(l => l.includes('새 글이 왔습니다')))
  expect(JSON.parse(note)).toMatchObject({ body: expect.stringContaining('이 AI 세션은 닫혀 있어서 받아 두었습니다') })

  // 같은 세션을 다시 연다. 지킴이에게서 다리를 넘겨받고, 닫힌 동안 온 글을 읽는다.
  const again = await start('claude-code', t.env)
  const inbox = await again.call('inbox')
  expect(inbox.events).toEqual([expect.objectContaining({ type: 'message', kind: 'question', text: '세션이 닫힌 동안에도 받나요?' })])
  expect(await t.row('keeper_handed_over')).toMatchObject({ keeper: waiting.keeper, port: t.opened.port })
  await until(() => !alive(waiting.keeper))
  const back = readSaved(t.path)!
  expect(back).toMatchObject({ publicKey: t.saved.publicKey, port: t.opened.port })
  expect(back.keptBy).toBeUndefined()
  // 상대에게는 「다시 왔다」가 가고, 답이 오간다.
  expect(await t.hears(e => e.type === 'connected' && e.again)).toMatchObject({ peer: t.opened.name })
  await again.call('reply', { thread: inbox.events[0].thread, text: '받습니다.' })
  expect(await t.hears(e => e.type === 'message' && e.kind === 'answer')).toMatchObject({ text: '받습니다.' })
  expect((await t.b.call('list_connections')).peers[0].their_ai_session).toBeUndefined()

  // 다시 열린 세션에는 새 지킴이가 선다. 사람이 다리를 닫으면 그 지킴이도 끝나고, 아무것도 남지 않는다.
  const second = await t.row('keeper_waiting', 1)
  expect(second.keeper).not.toBe(waiting.keeper)
  expect(alive(second.keeper)).toBe(true)
  await again.call('close_bridge')
  await until(() => !alive(second.keeper))
  expect(readSaved(t.path)).toBeUndefined()
  expect(await stillRunning(held)).toBe(false)
  expect(t.log().filter(r => r.event === 'keeper_stopped').at(-1)).toMatchObject({ keeper: second.keeper })
}, 60_000)

// 조건 (3): 앱 종료 · 앱 업데이트로 세션이 닫힌다. 그때 앱은 자식 프로세스에 끝내라는 신호를 보낸다.
// Windows 는 어떤 프로세스의 작업 폴더인 폴더를 지우거나 옮기지 못한다. 지킴이는 세션보다 오래 산다.
// 지킴이가 세션의 작업 폴더(프로젝트 폴더, 플러그인 폴더)를 물려받으면 그 폴더가 지킴이가 사는 내내 잠긴다. 그래서 지킴이는 coworker 폴더에서 돈다.
test('a keeper does not stay in the folder its session ran in, so that folder can be removed while the keeper lives', async () => {
  const project = mkdtempSync(join(tmpdir(), 'coworker-keep-project-'))
  const t = await pairUp('folder', {}, project)
  const waiting = await t.row('keeper_waiting')
  process.kill(t.a.pid, 'SIGKILL')
  await t.row('keeper_took_over')
  await until(() => !alive(t.a.pid))
  // 끝난 세션이 폴더를 놓기까지 잠깐 걸릴 수 있다. 지킴이가 쥐고 있으면 끝까지 지워지지 않는다.
  await until(() => {
    try {
      rmSync(project, { recursive: true })
      return true
    } catch {
      return false
    }
  }, 5000)
  expect(existsSync(project)).toBe(false)
  expect(alive(waiting.keeper)).toBe(true)
}, 30_000)

// 조건 (3), Windows: 앱이 세션을 닫으며 그 세션의 작업 개체(Job Object)에 든 프로세스를 한꺼번에 끝낸다.
// 2026-11-18 에 Windows 의 Orca 에서 쟀다: 터미널을 닫으니 부모 없이 따로 띄운 지킴이까지 같은 순간에 종료 코드 1 로 끝났다.
// 작업 개체는 벗어나기를 허용했다(BREAKAWAY_OK). 그래서 지킴이는 작업 개체 밖에 뜬다.
test.skipIf(process.platform !== 'win32')(
  'on Windows a keeper starts outside the job object of its session, so it lives on and takes over when an app ends every process in that job',
  async () => {
    const { dlopen, FFIType, ptr } = await import('bun:ffi')
    const lib = dlopen('kernel32.dll', {
      CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
      SetInformationJobObject: { args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
      AssignProcessToJobObject: { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 },
      IsProcessInJob: { args: [FFIType.u64, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
      TerminateJobObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.i32 },
      CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    })
    const k = lib.symbols
    const job = k.CreateJobObjectW(null, null)
    try {
      // JOBOBJECT_EXTENDED_LIMIT_INFORMATION (144바이트). 16 이 한도 표시다. 0x800 = 벗어나기 허용.
      const limits = Buffer.alloc(144)
      limits.writeUInt32LE(0x800, 16)
      expect(k.SetInformationJobObject(job, 9, ptr(limits), 144)).not.toBe(0)
      const inJob = (pid: number) => {
        const h = k.OpenProcess(0x1000, 0, pid)
        const answer = Buffer.alloc(4)
        expect(k.IsProcessInJob(h, job, ptr(answer))).not.toBe(0)
        k.CloseHandle(h)
        return answer.readUInt32LE(0) !== 0
      }
      // 세션을 작업 개체에 넣는다. 그 뒤에 세션이 띄우는 것은 벗어나지 않는 한 모두 이 작업 개체에 든다.
      const t = await pairUp('job', {}, undefined, pid => {
        const h = k.OpenProcess(0x0100 | 0x0001, 0, pid)
        expect(k.AssignProcessToJobObject(job, h)).not.toBe(0)
        k.CloseHandle(h)
      })
      const waiting = await t.row('keeper_waiting')
      expect(inJob(t.a.pid)).toBe(true)
      expect(inJob(waiting.keeper!)).toBe(false)

      // 앱이 하는 대로, 작업 개체에 든 것을 한꺼번에 끝낸다.
      expect(k.TerminateJobObject(job, 1)).not.toBe(0)
      await until(() => !alive(t.a.pid))
      expect(await t.row('keeper_took_over')).toMatchObject({ keeper: waiting.keeper, port: t.opened.port })
      expect(alive(waiting.keeper)).toBe(true)
      expect(await t.b.call('send_question', { question: 'Is the bridge still up?' })).toMatchObject({ delivery: 'delivered', their_ai_session: expect.stringContaining('closed since ') })
    } finally {
      k.CloseHandle(job)
      lib.close()
    }
  },
  30_000,
)

test('a keeper renews its held request on the holder again and again, and still takes over when the session stops', async () => {
  // 지킴이는 다리의 포트에 요청 하나를 붙잡아 두고 지켜본다. Bun 은 답 없는 요청을 6분에 끊으므로, 그 전에 스스로 끊고 다시 건다.
  // 여기서는 그 간격을 0.3초로 줄인다. 다시 걸 때마다 기록을 남기지 않고, 다리를 이어 열지도 않는다.
  const t = await pairUp('renew', { COWORKER_KEEP_WATCH_MS: '300' })
  await t.row('keeper_waiting')
  await Bun.sleep(1500)
  expect(t.log().filter(r => r.event.startsWith('keeper_')).map(r => r.event)).toEqual(['keeper_waiting'])
  expect(readSaved(t.path)!.keptBy).toBeUndefined()
  process.kill(t.a.pid, 'SIGKILL')
  expect((await t.row('keeper_took_over')).port).toBe(t.saved.port)
}, 30_000)

test('a session that an app quit or an app update closes keeps its bridge the same way, and a message sent meanwhile is answered after it reopens', async () => {
  const t = await pairUp('quit')
  const waiting = await t.row('keeper_waiting')
  process.kill(t.a.pid, 'SIGTERM')
  const took = await t.row('keeper_took_over')
  expect(took).toMatchObject({ keeper: waiting.keeper, port: t.opened.port })
  // 연결 기록에 순서대로 남는다: 서버가 멈춤 → 지킴이가 넘겨받음.
  if (process.platform !== 'win32') {
    const events = t.log().map(r => r.event)
    expect(events.lastIndexOf('closed')).toBeLessThan(events.indexOf('keeper_took_over'))
    expect(events.lastIndexOf('closed')).toBeGreaterThan(events.indexOf('keeper_waiting'))
  }
  const sent = await t.b.call('send_question', { question: 'Did the update finish?' })
  expect(sent).toMatchObject({ delivery: 'delivered', their_ai_session: expect.stringContaining('closed since ') })
  // 영어 글이면 알림도 영어다.
  await until(() => existsSync(t.notifyLog) && readFileSync(t.notifyLog, 'utf8').includes('This AI session is closed, so it is kept here.'))

  const again = await start('claude-code', t.env)
  const inbox = await again.call('inbox')
  expect(inbox.events).toEqual([expect.objectContaining({ kind: 'question', text: 'Did the update finish?' })])
  await t.row('keeper_handed_over')
  await until(() => !alive(waiting.keeper))
  await again.call('reply', { thread: inbox.events[0].thread, text: 'Yes.' })
  expect(await t.hears(e => e.type === 'message' && e.kind === 'answer')).toMatchObject({ text: 'Yes.' })
  const second = await t.row('keeper_waiting', 1)
  await again.call('close_bridge')
  await until(() => !alive(second.keeper))
}, 60_000)

// 2026-11-18 에 보안 담당 PC(macOS)에서 닫힌 것은 Orca 채팅형 세션이다. Orca 는 그 세션의 Claude Code 를 자기 프로세스 묶음으로 띄운다.
// 닫을 때는 그 묶음 전체에 SIGTERM, 이어서 SIGKILL 을 보내고, 프로세스 표에서 그 아래에 있는 것에도 보낸다(Orca 1.4.262 의 코드에서 확인).
// MCP 서버는 Claude Code 의 자식이고 같은 묶음에 있다. 여기서는 MCP 서버를 묶음의 우두머리로 띄워 같은 신호를 보낸다.
test.skipIf(process.platform === 'win32')(
  'a session keeps its bridge when an app ends its whole process group and every process under it, as Orca on macOS ends a chat-type session',
  async () => {
    const t = await pairUp('group', {}, undefined, undefined, true)
    const waiting = await t.row('keeper_waiting')
    const session = t.a.pid
    const table = processTable()
    // 세션은 자기 묶음의 우두머리다. 지킴이는 그 묶음에 없고, 세션 아래에도 없다.
    expect(table.get(session)?.group).toBe(session)
    expect(table.get(waiting.keeper!)?.group).not.toBe(session)
    const below = under(session, table)
    expect(below).not.toContain(waiting.keeper!)

    const signal = (how: NodeJS.Signals) => {
      for (const target of [-session, ...below]) {
        try {
          process.kill(target, how)
        } catch {}
      }
    }
    signal('SIGTERM')
    await Bun.sleep(300)
    signal('SIGKILL')
    await until(() => !alive(session))

    const took = await t.row('keeper_took_over')
    expect(took).toMatchObject({ keeper: waiting.keeper, port: t.opened.port })
    expect(alive(waiting.keeper)).toBe(true)
    const sent = await t.b.call('send_question', { question: 'Is the bridge still there?' })
    expect(sent).toMatchObject({ delivery: 'delivered', their_ai_session: expect.stringContaining('closed since ') })
  },
  60_000,
)

// Orca 는 세션이 도는 동안에도 프로세스 표를 한 번 읽어 두고, 그때 세션 아래에 있던 프로세스를 닫을 때 함께 끝낸다.
// 지킴이가 뜨는 동안 잠깐이라도 세션 아래에 있으면, 그 틈에 읽힌 지킴이는 세션과 함께 끝난다.
// 여기서는 지킴이를 띄우는 첫 프로세스를 일부러 오래 살려 두고, 그동안 프로세스 표를 계속 읽는다.
test.skipIf(process.platform === 'win32')(
  'a keeper is never under its session in the process table, not even while it starts, so an app that remembers what it saw under a session does not end the keeper with it',
  async () => {
    const seen = new Set<number>()
    let looking = true
    const look = async (session: number) => {
      while (looking) {
        for (const pid of under(session)) seen.add(pid)
        await Bun.sleep(15)
      }
    }
    const t = await pairUp('apart', { COWORKER_KEEP_START_HOLD_MS: '700' }, undefined, pid => void look(pid))
    const waiting = await t.row('keeper_waiting')
    looking = false
    // 지킴이를 띄우는 프로세스는 세션 아래에서 보였다. 지킴이는 한 번도 보이지 않았다.
    expect(seen.size).toBeGreaterThan(0)
    expect(seen.has(waiting.keeper!)).toBe(false)
    expect(under(t.a.pid)).not.toContain(waiting.keeper!)
    // 세션이 멈추면 그 지킴이가 넘겨받는다.
    process.kill(t.a.pid, 'SIGKILL')
    expect(await t.row('keeper_took_over')).toMatchObject({ keeper: waiting.keeper })
  },
  60_000,
)

// 판을 올리면 Claude Code 가 MCP 서버를 다시 띄운다. 앞 서버를 지켜보던 지킴이(옛 판)가 남으면 안 된다.
test('when only the MCP server restarts (a plugin update, a reconnect), the keeper of the old server ends by itself: one keeper remains, and the other side never hears that the session closed', async () => {
  // 새 서버가 뜰 틈을 넉넉히 준다(실제 기본값은 3초다).
  const t = await pairUp('restart', { COWORKER_KEEP_GRACE_MS: '6000' })
  const first = await t.row('keeper_waiting')
  // 서버를 끝내고, 지킴이가 이어 열기 전에 같은 세션의 새 서버가 뜬다.
  await t.a.client.close()
  const again = await start('claude-code', t.env)
  expect((await again.call('list_connections')).peers).toHaveLength(1)
  const stopped = await until(() => t.log().find(r => r.event === 'keeper_stopped' && r.keeper === first.keeper))
  expect(stopped.why).toBe('another process holds this bridge now')
  await until(() => !alive(first.keeper))
  const second = await t.row('keeper_waiting', 1)
  expect(alive(second.keeper)).toBe(true)
  expect(t.log().some(r => r.event === 'keeper_took_over')).toBe(false)
  expect(await t.hears(e => e.type === 'connected' && e.again)).toBeDefined()
  expect(t.heard.filter(e => e.type === 'peer_session_closed')).toEqual([])
  await again.call('close_bridge')
  await until(() => !alive(second.keeper))
  expect(t.log().filter(r => r.event === 'keeper_waiting')).toHaveLength(2)
}, 60_000)

test('a keeper ends when nothing is left to keep, and its saved state stays for the session', async () => {
  const t = await pairUp('empty')
  const waiting = await t.row('keeper_waiting')
  process.kill(t.a.pid, 'SIGKILL')
  await t.row('keeper_took_over')
  // 상대 쪽 사람이 다리를 닫았다. 이어진 상대도, 쓸 수 있는 코드도 없다.
  await t.b.call('close_bridge')
  const stopped = await t.row('keeper_stopped')
  expect(stopped).toMatchObject({ keeper: waiting.keeper, why: 'no connection and no unused code is left to keep' })
  await until(() => !alive(waiting.keeper))
  const left = readSaved(t.path)!
  expect(left.threads).toEqual(t.saved.threads)
  expect(await stillRunning(left)).toBe(false)
}, 60_000)

// 2026-11-18 에 실제로 남았다: 아무도 쓰지 않은 연결 코드가 60분 뒤에 못 쓰게 됐는데, 지킴이는 2시간 반 뒤에도 그 다리를 쥐고 있었다.
// 코드가 시간으로 끝날 때는 다리에 아무 일도 일어나지 않아서, 지킴이가 알아챌 계기가 없었다.
test('a keeper ends when the last unused code runs out of time, although nothing happens on the bridge at that moment', async () => {
  const home = newHome('expired')
  const ports = `${nextPort}-${nextPort + 9}`
  nextPort += 10
  const env = { COWORKER_HOME: home, COWORKER_PORTS: ports, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'keep-expired', COWORKER_KEEP: 'on', COWORKER_KEEP_GRACE_MS: '1500', COWORKER_KEEP_CHECK_MS: '300' }
  const session = await start('claude-code', env)
  // 아무도 이 코드를 쓰지 않는다.
  const opened = await session.call('open_bridge', {})
  const path = savedPath(home, opened.session_id)
  const k = keeperLog(home, opened.session_id)
  const waiting = await k.row('keeper_waiting')
  process.kill(session.pid, 'SIGKILL')
  await until(() => !alive(session.pid))
  // 코드의 시간은 분으로만 정할 수 있다. 시험이 그만큼 기다리지 않게, 지킴이가 이어 열기 전에 저장한 상태에서 코드의 남은 시간을 6초로 줄인다.
  const saved = readSaved(path)!
  expect(saved.tokens).toHaveLength(1)
  const ends = Date.now() + 6000
  writeFileSync(path, JSON.stringify({ ...saved, tokens: saved.tokens.map(t => ({ ...t, expires: ends })) }))
  // 코드를 아직 쓸 수 있는 동안에는 지킨다.
  expect(await k.row('keeper_took_over')).toMatchObject({ keeper: waiting.keeper, connections: 0 })
  // 코드가 시간으로 끝나면, 다음에 살펴볼 때 끝난다.
  expect(await k.row('keeper_stopped')).toMatchObject({ keeper: waiting.keeper, why: 'no connection and no unused code is left to keep' })
  expect(Date.now()).toBeGreaterThanOrEqual(ends)
  await until(() => !alive(waiting.keeper))
}, 40_000)

test('a human can see what keepers hold and stop them; after a keeper died, the next coworker start on this PC sets one up again', async () => {
  const t = await pairUp('cli')
  const waiting = await t.row('keeper_waiting')
  process.kill(t.a.pid, 'SIGKILL')
  await t.row('keeper_took_over')
  const keep = (...args: string[]) => Bun.spawnSync([process.execPath, MCP, 'keep', ...args], { env: { ...process.env, COWORKER_HOME: t.home, COWORKER_PORTS: t.env.COWORKER_PORTS } }).stdout.toString()
  expect(keep('list')).toContain(`port ${t.opened.port}  keeper pid ${waiting.keeper}`)

  // PC를 다시 켠 것처럼 지킴이가 죽었다. 다리는 내려가 있다.
  process.kill(waiting.keeper!, 'SIGKILL')
  await until(() => !alive(waiting.keeper))
  await until(async () => !(await stillRunning(readSaved(t.path)!)))
  expect(keep('list')).toContain('no bridge is held by a keeper')
  // 이 PC에서 coworker 가 다시 뜨면(어느 세션이든) 지키던 다리에 지킴이를 다시 세운다.
  await start('claude-code', { ...t.env, CLAUDE_CODE_SESSION_ID: 'keep-cli-other' })
  const again = await until(() => t.log().filter(r => r.event === 'keeper_took_over')[1], 20_000)
  expect(again.keeper).not.toBe(waiting.keeper)
  expect(again.port).toBe(t.opened.port)
  expect(await stillRunning(readSaved(t.path)!)).toBe(true)

  // 사람이 멈추면 지킴이가 끝나고, 다음에 coworker 가 떠도 다시 세우지 않는다. 저장한 상태는 남는다.
  expect(keep('stop')).toContain(`stopped keeping ${t.opened.name} (port ${t.opened.port})`)
  await until(() => !alive(again.keeper))
  const left = readSaved(t.path)!
  expect(left.keep).toBe(false)
  expect(left.keptBy).toBeUndefined()
  expect(await stillRunning(left)).toBe(false)
  expect(t.log().at(-1)).toMatchObject({ event: 'keeper_stopped', keeper: again.keeper, why: expect.stringContaining('keep stop') })
  expect(keep('list')).toContain('no bridge is held by a keeper')
}, 90_000)

// 로그는 다리의 공개키로 찾는다. 저장한 상태에서 읽는다.
function keeperLog(home: string, id: string) {
  const saved = readSaved(savedPath(home, id))!
  const file = join(home, 'logs', `${routeId(saved.publicKey)}.log`)
  const log = (): Row[] => {
    if (!existsSync(file)) return []
    const rows = readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Row)
    for (const r of rows) if (r.event.startsWith('keeper_') && r.keeper) keepers.add(r.keeper)
    return rows
  }
  return { saved, log, row: (event: string, nth = 0) => until(() => log().filter(r => r.event === event)[nth]) }
}

// Codex 에는 세션 ID가 없다. 다시 켠 세션의 AI가 open_bridge resume 으로 지킴이에게서 넘겨받는다.
test('a Codex session that ends keeps its bridge too, and the session started again takes it back from the keeper with resume', async () => {
  const home = newHome('codex')
  const ports = `${nextPort}-${nextPort + 9}`
  nextPort += 10
  const env = { COWORKER_HOME: home, COWORKER_PORTS: ports, COWORKER_KEEP: 'on', COWORKER_KEEP_GRACE_MS: '400' }
  const codex = await start('codex-mcp-client', env)
  const claude = await start('claude-code', { COWORKER_HOME: home, COWORKER_PORTS: ports })
  const opened = await codex.call('open_bridge', {})
  await claude.call('connect', { code: opened.code })
  await codex.call('wait_for_message', { timeout_sec: 5 })
  await settled(savedPath(home, opened.session_id))
  const k = keeperLog(home, opened.session_id)
  const waiting = await k.row('keeper_waiting')

  process.kill(codex.pid, 'SIGKILL')
  expect(await k.row('keeper_took_over')).toMatchObject({ keeper: waiting.keeper, port: opened.port })
  expect(await claude.call('send_question', { question: 'Is Codex there?' })).toMatchObject({ delivery: 'delivered', their_ai_session: expect.stringContaining('closed since ') })

  // 다시 켠 Codex 세션. 앞 세션이 남긴 다리가 지킴이 손에 있다는 것이 보이고, resume 으로 넘겨받는다.
  const again = await start('codex-mcp-client', env)
  const earlier = (await again.call('list_connections')).earlier_bridges
  // 같은 PC의 다른 세션(여기서는 상대 쪽)이 쥔 다리도 함께 보인다. 그것은 지킴이가 아니라 그 세션이 쥐고 있다.
  expect(earlier).toContainEqual(expect.objectContaining({ session_id: opened.session_id, kept_while_its_session_is_closed: true, running_in_another_session: false }))
  expect(earlier.filter((e: { kept_while_its_session_is_closed?: boolean }) => e.kept_while_its_session_is_closed)).toHaveLength(1)
  expect(await again.call('open_bridge', { resume: opened.session_id })).toMatchObject({ resumed: true, session_id: opened.session_id, name: opened.name, port: opened.port })
  expect((await again.call('wait_for_message', { timeout_sec: 5 })).events).toEqual([expect.objectContaining({ kind: 'question', text: 'Is Codex there?' })])
  await k.row('keeper_handed_over')
  await until(() => !alive(waiting.keeper))
  const second = await k.row('keeper_waiting', 1)
  await again.call('close_bridge')
  await until(() => !alive(second.keeper))
  expect(readSaved(savedPath(home, opened.session_id))).toBeUndefined()
}, 60_000)

// coworker 앱(디렉터리판)에서는 다리가 앱 프로세스 안에서 돈다. 세션이 끝나면 앱이 그 다리를 멈춘다. 그때도 지킴이가 이어 연다.
test('on the coworker app, a session that ends keeps its bridge too, and a new session takes it back from the keeper with resume', async () => {
  const home = newHome('app')
  const ports = `${nextPort}-${nextPort + 9}`
  nextPort += 10
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
  const appPort = probe.port!
  probe.stop(true)
  const app = Bun.spawn([process.execPath, MCP, 'serve'], {
    env: { ...process.env, COWORKER_HOME: home, COWORKER_APP_PORT: String(appPort), COWORKER_PORTS: ports, COWORKER_KEEP: 'on', COWORKER_KEEP_GRACE_MS: '400', COWORKER_NOTIFY: 'off', COWORKER_AUTO_UPDATE: 'off' },
    stdout: 'ignore',
    stderr: 'inherit',
  })
  try {
    await until(() => fetch(`http://127.0.0.1:${appPort}/health`).then(r => r.ok).catch(() => false))
    const onApp = async () => {
      const client = new Client({ name: 'claude-code', version: '1.0.0' })
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${appPort}/mcp`))
      await client.connect(transport)
      clients.push(client)
      const call: Tool = async (name, args = {}) => {
        const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] }
        const text = res.content[0]!.text
        if (res.isError) throw new Error(text)
        return JSON.parse(text)
      }
      return { call, transport }
    }
    const first = await onApp()
    const opened = await first.call('open_bridge', {})
    const peer = await start('codex-mcp-client', { COWORKER_HOME: home, COWORKER_PORTS: ports })
    await peer.call('connect', { code: opened.code })
    await first.call('inbox')
    const k = keeperLog(home, opened.session_id)
    const waiting = await k.row('keeper_waiting')

    // Claude Code 가 세션을 끝낸다(DELETE). 앱은 살아 있지만 그 세션의 다리는 멈춘다.
    await first.transport.terminateSession()
    expect(await k.row('keeper_took_over')).toMatchObject({ keeper: waiting.keeper, port: opened.port })
    expect(await peer.call('send_question', { question: 'Is the app session there?' })).toMatchObject({ delivery: 'delivered', their_ai_session: expect.stringContaining('closed since ') })

    const again = await onApp()
    expect(await again.call('open_bridge', { resume: opened.session_id })).toMatchObject({ resumed: true, session_id: opened.session_id, port: opened.port })
    expect((await again.call('inbox')).events).toEqual([expect.objectContaining({ kind: 'question', text: 'Is the app session there?' })])
    await k.row('keeper_handed_over')
    await until(() => !alive(waiting.keeper))
    const second = await k.row('keeper_waiting', 1)
    await again.call('close_bridge')
    await until(() => !alive(second.keeper))
  } finally {
    app.kill()
  }
}, 60_000)
