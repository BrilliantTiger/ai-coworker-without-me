import { afterAll, afterEach, expect, test } from 'bun:test'
import type { Server } from 'bun'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ElicitRequestSchema, type ElicitResult } from '@modelcontextprotocol/sdk/types.js'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, hostname, networkInterfaces, platform, tmpdir, userInfo } from 'node:os'
import { basename, join } from 'node:path'
import { decodeCode } from '../src/code'
import { fromB64, isSealed, open, type KeyPair } from '../src/crypto'
import { shortHostname } from '../src/net'
import { startRelay } from '../src/relay'
import { readSaved, savedPath } from '../src/resume'

const root = join(import.meta.dir, '..')
const temps: string[] = []
const clients: Client[] = []
const servers: Server<undefined>[] = []

function tempDir(label: string) {
  const dir = mkdtempSync(join(tmpdir(), `coworker-outside-${label}-`))
  temps.push(dir)
  return dir
}

afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true)
})

afterAll(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

type ToolReply = { isError?: boolean; text: string; data?: any }

async function rawSession(
  clientName: string,
  env: Record<string, string> = {},
  options: { entry?: string; args?: string[]; cwd?: string; client?: Client } = {},
) {
  const home = env.COWORKER_HOME ?? tempDir('home')
  const client = options.client ?? new Client({ name: clientName, version: '1.0.0' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: options.args ?? [options.entry ?? join(root, 'src', 'mcp.ts')],
      cwd: options.cwd,
      env: {
        ...process.env,
        COWORKER_HOME: home,
        COWORKER_CHANNEL: 'off',
        CLAUDE_CODE_SESSION_ID: '',
        COWORKER_AUTO_UPDATE: 'off',
        COWORKER_NOTIFY: 'off',
        COWORKER_RELAY: '',
        COWORKER_RELAY_KEY: '',
        ...env,
      } as Record<string, string>,
      stderr: 'inherit',
    }),
  )
  clients.push(client)
  const callRaw = async (name: string, args: Record<string, unknown> = {}): Promise<ToolReply> => {
    const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] }
    const text = res.content[0]?.text ?? ''
    if (res.isError) return { isError: true, text }
    return { isError: false, text, data: JSON.parse(text) }
  }
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await callRaw(name, args)
    if (res.isError) throw new Error(res.text)
    return res.data
  }
  return { client, home, call, callRaw }
}

function scutil(key: string): string | undefined {
  if (platform() !== 'darwin') return undefined
  try {
    const run = Bun.spawnSync(['scutil', '--get', key])
    if (run.exitCode !== 0) return undefined
    return run.stdout.toString().trim() || undefined
  } catch {
    return undefined
  }
}

// 실행 중인 이 기계에서 컴퓨터 이름, 모든 네트워크 인터페이스 주소, 계정 이름, 홈 폴더, 작업 폴더 경로를 읽는다.
function machineSecrets() {
  const items: { kind: string; value: string }[] = []
  const add = (kind: string, value: string | undefined) => {
    const v = value?.trim()
    if (!v) return
    if (kind === 'computer name' && v.toLowerCase() === 'localhost') return
    items.push({ kind, value: v })
  }

  const host = hostname()
  const short = shortHostname()
  add('computer name', host)
  add('computer name', short)
  if (short) add('computer name', `${short}.local`)
  for (const key of ['LocalHostName', 'ComputerName', 'HostName']) {
    const v = scutil(key)
    add('computer name', v)
    if (v && key === 'LocalHostName') add('computer name', `${v}.local`)
    if (v?.includes('’')) add('computer name', v.replace(/’/g, "'"))
  }
  if (platform() === 'win32') add('computer name', process.env.COMPUTERNAME)

  for (const list of Object.values(networkInterfaces())) {
    for (const nic of list ?? []) {
      add('network interface address', nic.address)
      const noZone = nic.address.split('%')[0]
      if (noZone !== nic.address) add('network interface address', noZone)
    }
  }

  const account = userInfo().username || basename(homedir())
  add('account name', account)

  const home = homedir()
  add('home folder', home)
  try {
    add('home folder', realpathSync(home))
  } catch {}

  const cwd = process.cwd()
  add('working folder path', cwd)
  try {
    add('working folder path', realpathSync(cwd))
  } catch {}

  return items
}

type Recorded = { method: string; path: string; headers: Record<string, string>; body: string }

// 테스트용 중계 서버와 그 앞의 기록용 프록시(둘 다 루프백). 첫 세션이 중계 서버와 상대에게 보낸 모든 요청을 남긴다.
function recordingRelay(key?: string) {
  const real = startRelay({ port: 0, hostname: '127.0.0.1', key, holdMs: 30_000 })
  servers.push(real)
  const recorded: Recorded[] = []
  const proxy = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const body = req.method === 'POST' ? await req.text() : ''
      const headers: Record<string, string> = {}
      req.headers.forEach((v, k) => {
        if (k.toLowerCase() !== 'host') headers[k] = v
      })
      recorded.push({ method: req.method, path: url.pathname, headers, body })
      return fetch(`http://127.0.0.1:${real.port}${url.pathname}${url.search}`, {
        method: req.method,
        headers: req.headers,
        body: req.method === 'POST' ? body : undefined,
      })
    },
  })
  servers.push(proxy)
  return { url: `http://localhost:${proxy.port}`, port: proxy.port!, recorded, stop: () => (real.stop(true), proxy.stop(true)) }
}

// 첫 세션이 상대에게 보낸 암호화 봉투를 상대 비밀키로 모두 열어 평문과 파일 조각까지 꺼낸다.
function unpackSentByFirst(recorded: Recorded[], box1: string, firstKey: string, secondKeys: KeyPair): string[] {
  const texts: string[] = []
  const unpackPayload = (p: unknown) => {
    texts.push(JSON.stringify(p))
    if (!p || typeof p !== 'object') return
    const obj = p as { type?: string; data?: string; items?: { payload: unknown }[] }
    if (obj.type === 'file' && typeof obj.data === 'string') {
      texts.push(Buffer.from(obj.data, 'base64').toString('utf8'))
    }
    if (obj.type === 'batch' && Array.isArray(obj.items)) {
      for (const item of obj.items) unpackPayload(item.payload)
    }
  }
  const tryOpen = (raw: string) => {
    try {
      const parsed = JSON.parse(raw)
      if (isSealed(parsed) && parsed.from === firstKey) {
        const opened = open(parsed, secondKeys)
        if (opened !== null) unpackPayload(opened)
      }
    } catch {}
  }

  for (const r of recorded) {
    const [, , action, id] = r.path.split('/')
    const fromFirst =
      (action === 'inbox' && id === box1) ||
      (action === 'reply' && id === box1) ||
      (action === 'box' && id !== box1)
    if (!fromFirst) continue
    texts.push(`${r.method} ${r.path}`)
    texts.push(JSON.stringify(r.headers))
    texts.push(r.body)
    if (action === 'reply') {
      try {
        const reply = JSON.parse(r.body) as { body?: string }
        if (typeof reply.body === 'string') {
          texts.push(reply.body)
          tryOpen(reply.body)
        }
      } catch {}
    } else if (action === 'box') {
      tryOpen(r.body)
    }
  }
  return texts
}

async function waitEvent(call: (name: string, args?: Record<string, unknown>) => Promise<any>, predicate: (e: any) => boolean) {
  for (let i = 0; i < 40; i++) {
    const { events } = await call('wait_for_message', { timeout_sec: 1 })
    const found = events.find(predicate)
    if (found) return found
  }
  throw new Error('timed out waiting for event')
}

test('an outside bridge exchanges a question, an answer, a notice, a file and an agreement through the relay without anything about this computer leaving', async () => {
  const { url: relayUrl, port: relayPort, recorded } = recordingRelay()
  const window = new Client({ name: 'claude-code', version: '1.0.0' }, { capabilities: { elicitation: {} } })
  window.setRequestHandler(ElicitRequestSchema, async (): Promise<ElicitResult> => ({ action: 'accept', content: { choice: '1' } }))

  const first = await rawSession('claude-code', { COWORKER_RELAY: relayUrl }, { client: window })
  const second = await rawSession('codex-mcp-client', { COWORKER_RELAY: relayUrl })

  const opened = await first.call('open_bridge', { outside: true, model: 'Fable 5.2', effort: 'high' })
  const decoded = decodeCode(opened.code)

  const joined = await second.call('connect', { code: opened.code, model: 'GPT-5.5' })
  await waitEvent(first.call, e => e.type === 'connected')

  // 1. 상대가 묻고 첫 세션이 답한다. 첫 세션도 묻고 상대가 답한다.
  const qFromSecond = await second.call('send_question', { question: 'Does the parser skip blank lines?', context: 'checking edge cases', category: '파서' })
  const gotQ = await waitEvent(first.call, e => e.type === 'message' && e.kind === 'question')
  await first.call('reply', { thread: gotQ.thread, text: 'Yes, blank lines are ignored.' })
  expect(await waitEvent(second.call, e => e.type === 'message' && e.kind === 'answer')).toMatchObject({ text: 'Yes, blank lines are ignored.' })

  const qFromFirst = await first.call('send_question', { question: 'Can you reproduce on empty input?' })
  const gotFromFirst = await waitEvent(second.call, e => e.type === 'message' && e.kind === 'question' && e.thread === qFromFirst.thread)
  await second.call('reply', { thread: gotFromFirst.thread, text: 'Checked: empty input returns an empty list.' })
  await waitEvent(first.call, e => e.type === 'message' && e.kind === 'answer' && e.thread === qFromFirst.thread)

  // 2. 답이 필요 없는 알림과 사람에게 묻는 알림.
  const notice = await first.call('send_question', { question: 'FYI: CI checks are green.', no_answer_needed: true })
  expect(await waitEvent(second.call, e => e.type === 'message' && e.thread === notice.thread)).toMatchObject({ no_answer_needed: true })

  await first.call('check_with_human', { thread: gotQ.thread, question: 'Keep blank-line behavior?', options: ['Keep it', 'Change it'], recommend: 1 })
  expect(await waitEvent(second.call, e => e.type === 'message' && e.kind === 'note')).toMatchObject({ kind: 'note' })
  expect(await waitEvent(second.call, e => e.type === 'message' && e.kind === 'answer' && e.human === true)).toMatchObject({ human: true })
  await waitEvent(first.call, e => e.type === 'decision')

  // 3. 파일을 주고받고 확인 표시(receipt)까지 마친다.
  const samplePath = join(first.home, 'fixture.txt')
  writeFileSync(samplePath, 'line one\n\nline two\n')
  const withFile = await first.call('send_question', { question: 'Here is the sample input.', files: [samplePath] })
  const arrivedFile = await waitEvent(second.call, e => e.type === 'message' && e.thread === withFile.thread)
  expect(arrivedFile.files[0]).toMatchObject({ name: 'fixture.txt', verified: true })
  for (let i = 0; i < 40 && (await first.call('read_conversation', { thread: withFile.thread })).messages[0].files[0].ok !== true; i++) await Bun.sleep(50)

  const replyFile = join(second.home, 'result.txt')
  writeFileSync(replyFile, 'parsed: 2 lines\n')
  await second.call('reply', { thread: withFile.thread, text: 'Here is the output.', files: [replyFile] })
  const gotReplyFile = await waitEvent(first.call, e => e.type === 'message' && e.kind === 'answer' && e.thread === withFile.thread)
  expect(gotReplyFile.files[0]).toMatchObject({ name: 'result.txt', verified: true })
  for (let i = 0; i < 40 && (await second.call('read_conversation', { thread: withFile.thread })).messages[1].files[0].ok !== true; i++) await Bun.sleep(50)

  // 4. 첫 세션이 합의문을 쓴다.
  await first.call('write_agreement', {
    thread: qFromFirst.thread,
    conclusion: 'Blank lines and empty input are both handled without error.',
    facts: [
      { fact: 'Blank lines are skipped', evidence: 'src/code.ts:25', checked_by: 'me' },
      { fact: 'Empty input returns an empty list', evidence: 'verified by contributor test', checked_by: 'them' },
    ],
    guesses: ['CRLF endings behave the same'],
    for_humans: ['Document blank-line handling in README?'],
  })
  const gotAgreement = await waitEvent(second.call, e => e.type === 'message' && e.kind === 'agreement')
  expect(gotAgreement.agreement.conclusion).toContain('Blank lines')

  // 5. 모델 소개 바뀜(다시 인사), 화면에서의 접근키 재발급, 연결 상태와 연결 기록 요청까지 모두 거친다.
  await fetch(`${opened.viewer}/about`, {
    method: 'POST',
    headers: { 'x-coworker-viewer': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'Fable 5.2', effort: 'max' }),
  })
  for (let i = 0; i < 30 && (await second.call('list_connections')).peers[0]?.about?.effort !== 'max'; i++) await Bun.sleep(50)
  const viewerIssued = (await (
    await fetch(`${opened.viewer}/code`, { method: 'POST', headers: { 'x-coworker-viewer': '1' } })
  ).json()) as { code: string }
  const viewerDecoded = decodeCode(viewerIssued.code)

  const secondConns = await second.call('list_connections')
  const secondLogs = await second.call('connection_log', {})

  // 상대 세션의 저장 상태에서 비밀키를 읽어 첫 세션이 보낸 모든 암호화 봉투를 복호화한다.
  let savedSecond = readSaved(savedPath(second.home, joined.session_id))
  for (let i = 0; i < 30 && !savedSecond; i++) {
    await Bun.sleep(50)
    savedSecond = readSaved(savedPath(second.home, joined.session_id))
  }
  expect(savedSecond).toBeDefined()
  const secondKeys: KeyPair = { publicKey: fromB64(savedSecond!.publicKey), secretKey: fromB64(savedSecond!.secretKey) }
  const relayAddr = decoded.addrs.find(a => /^https?:\/\//.test(a))
  const box1 = relayAddr ? new URL(relayAddr).pathname.split('/').pop() ?? '' : ''

  const sentTexts = unpackSentByFirst(recorded, box1, decoded.key, secondKeys)
  const secrets = machineSecrets()
  expect(secrets.some(s => s.kind === 'computer name')).toBe(true)
  expect(secrets.some(s => s.kind === 'network interface address')).toBe(true)
  expect(secrets.some(s => s.kind === 'account name')).toBe(true)
  expect(secrets.some(s => s.kind === 'home folder')).toBe(true)
  expect(secrets.some(s => s.kind === 'working folder path')).toBe(true)

  const haystacks = [
    opened.code,
    JSON.stringify(decoded),
    viewerIssued.code,
    JSON.stringify(viewerDecoded),
    ...sentTexts,
    JSON.stringify(joined.connected),
    JSON.stringify(secondConns.peers),
    JSON.stringify(secondLogs.theirs),
    JSON.stringify(gotAgreement.agreement),
  ]

  const leaked = [...new Set(secrets.filter(s => haystacks.some(h => h.toLowerCase().includes(s.value.toLowerCase()))).map(s => s.kind))]
  expect(leaked).toEqual([])
  expect(sentTexts.length).toBeGreaterThan(0)

  // 외부용 코드는 중계 서버 우편함 하나만 담고, 이 컴퓨터의 포트를 담지 않는다.
  expect(decoded.addrs.length === 1 && decoded.addrs[0]!.startsWith(`${relayUrl}/v1/box/`)).toBe(true)
  expect(decoded.port).toBe(relayPort)
  expect(secondConns.peers[0].via).toBe(`localhost:${relayPort} (relay)`)
}, 30_000)

test('the default name on an outside bridge is the AI tool only, model and tool are still told, and computer details in messages, files or agreements are refused', async () => {
  const { url: relayUrl } = recordingRelay()
  const claude = await rawSession('claude-code', { COWORKER_RELAY: relayUrl })
  const codex = await rawSession('codex-mcp-client', { COWORKER_RELAY: relayUrl })

  const cOpen = await claude.call('open_bridge', { outside: true, model: 'Fable 5.2', effort: 'max' })
  const xOpen = await codex.call('open_bridge', { outside: true, model: 'GPT-5.5' })

  expect({ claudeName: cOpen.name === 'Claude Code', codexName: xOpen.name === 'Codex' }).toEqual({ claudeName: true, codexName: true })
  expect(decodeCode(cOpen.code).name === 'Claude Code').toBe(true)
  expect(decodeCode(xOpen.code).name === 'Codex').toBe(true)

  // 직접 정한 안전한 이름은 그대로 쓰고, 컴퓨터 이름이나 홈 경로가 든 이름은 거절한다.
  const named = await rawSession('claude-code', { COWORKER_RELAY: relayUrl })
  expect((await named.call('open_bridge', { outside: true, name: 'coworker-maintainer' })).name).toBe('coworker-maintainer')
  const unsafeName = await named.callRaw('open_bridge', { outside: true, name: `maint @ ${shortHostname()}` })
  expect(unsafeName.isError).toBe(true)

  const peer = await rawSession('codex-mcp-client', { COWORKER_RELAY: relayUrl })
  await peer.call('connect', { code: cOpen.code, model: 'GPT-5.5' })
  await waitEvent(claude.call, e => e.type === 'connected')

  // 어떤 도구와 모델을 쓰는지는 그대로 알린다.
  expect((await peer.call('list_connections')).peers[0]).toMatchObject({
    name: 'Claude Code',
    about: { app: 'Claude Code', model: 'Fable 5.2', effort: 'max' },
  })

  // 질문, 답, 알림, 합의문 근거, 파일에 홈 폴더·작업 폴더·컴퓨터 이름·계정 이름·사내 IP가 들어가면 보내지 않는다.
  for (const bad of [
    `See ${join(homedir(), 'notes.md')}`,
    `Checked in ${join(process.cwd(), 'src', 'code.ts')}`,
    `Running on ${shortHostname()}`,
    `Account is ${userInfo().username}`,
    'Internal service at 192.168.10.25',
  ]) {
    const attempt = await claude.callRaw('send_question', { question: bad })
    expect({ isError: attempt.isError === true }).toEqual({ isError: true })
  }

  const ok = await peer.call('send_question', { question: 'Where is decodeCode?' })
  const got = await waitEvent(claude.call, e => e.type === 'message' && e.thread === ok.thread)
  expect((await claude.callRaw('reply', { thread: got.thread, text: `In ${join(process.cwd(), 'src', 'code.ts')}` })).isError).toBe(true)
  expect((await claude.callRaw('write_agreement', {
    thread: got.thread,
    conclusion: 'Found decodeCode.',
    facts: [{ fact: 'decodeCode validates fields', evidence: `${join(process.cwd(), 'src', 'code.ts')}:24`, checked_by: 'me' }],
  })).isError).toBe(true)

  const leakFile = join(claude.home, 'leak.txt')
  writeFileSync(leakFile, `path=${homedir()}\n`)
  expect((await claude.callRaw('reply', { thread: got.thread, text: 'Attached.', files: [leakFile] })).isError).toBe(true)

  // 상대에게는 위 거절된 것들이 하나도 가지 않았다.
  expect((await peer.call('wait_for_message', { timeout_sec: 0 })).events).toEqual([])
}, 25_000)

test('an outside code is always private: the outsider connects only with the session that made it, learns of nobody else, and nobody else learns of it or its address', async () => {
  const { url: relayUrl } = recordingRelay()
  const host = await rawSession('claude-code', { COWORKER_RELAY: relayUrl })
  const colleague1 = await rawSession('codex-mcp-client')
  const outsider = await rawSession('codex-mcp-client', { COWORKER_RELAY: relayUrl })
  const colleague2 = await rawSession('claude-code')

  const group1 = await host.call('open_bridge', {})
  const c1 = await colleague1.call('connect', { code: group1.code })
  await waitEvent(host.call, e => e.type === 'connected')

  // private: false 를 넘겨도 외부용 코드는 언제나 개인용이다.
  const outOpen = await host.call('open_bridge', { outside: true, private: false })
  expect(outOpen.group.length).toBe(0)
  const oJoined = await outsider.call('connect', { code: outOpen.code, name: 'Outside Contributor' })
  expect(oJoined.joining.length).toBe(0)
  await waitEvent(host.call, e => e.type === 'connected' && e.peer === 'Outside Contributor')

  // 뒤에 새 그룹 코드로 들어온 동료도 외부 세션과는 이어지지 않고 소개받지도 않는다.
  const group2 = await host.call('open_bridge', {})
  const c2 = await colleague2.call('connect', { code: group2.code })
  expect(c2.joining).toEqual([c1.myName])
  for (let i = 0; i < 40 && (await colleague1.call('list_connections')).peers.length < 2; i++) await Bun.sleep(50)

  const oConns = await outsider.call('list_connections')
  const c1Conns = await colleague1.call('list_connections')
  const c2Conns = await colleague2.call('list_connections')

  expect(oConns.peers).toHaveLength(1)
  expect(oConns.connecting).toEqual([])
  expect(c1Conns.peers.map((p: { name: string }) => p.name)).not.toContain('Outside Contributor')
  expect(c2Conns.peers.map((p: { name: string }) => p.name)).not.toContain('Outside Contributor')
  expect((await host.call('list_connections')).peers.find((p: { name: string }) => p.name === 'Outside Contributor').group).toBe(false)

  // 전체에게 묻고 한 명만 답을 받아도 외부 세션에는 다른 세션 이름이 가지 않는다.
  await host.call('send_question', { question: 'Status check?', to: 'everyone', answers: 'one' })
  const c1Q = await waitEvent(colleague1.call, e => e.type === 'message' && e.kind === 'question')
  const oQ = await waitEvent(outsider.call, e => e.type === 'message' && e.kind === 'question')
  expect(oQ.ask).toBeUndefined()
  await colleague1.call('reply', { thread: c1Q.thread, text: 'All good.' })
  const oClosed = await waitEvent(outsider.call, e => e.type === 'message' && e.kind === 'closed')
  expect(oClosed.text.includes(c1.myName)).toBe(false)
}, 25_000)

test('opening a bridge for outsiders requires a working coworker relay and never falls back to direct addresses', async () => {
  // 1. 중계 서버를 설정하지 않음.
  const noRelay = await rawSession('claude-code', { COWORKER_RELAY: '' })
  const r1 = await noRelay.callRaw('open_bridge', { outside: true })
  expect(r1.isError).toBe(true)
  expect(r1.text).toMatch(/COWORKER_RELAY|Relay server/i)
  expect((await noRelay.call('list_connections')).me.open).toBe(false)

  // 2. 중계 서버 주소에 아무것도 떠 있지 않음.
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
  const deadPort = probe.port!
  probe.stop(true)
  const deadRelay = await rawSession('claude-code', { COWORKER_RELAY: `http://127.0.0.1:${deadPort}` })
  const r2 = await deadRelay.callRaw('open_bridge', { outside: true })
  expect(r2.isError).toBe(true)
  expect(r2.text).not.toContain('cw1.')
  expect((await deadRelay.call('list_connections')).me.open).toBe(false)

  // 3. 중계 서버 키가 틀렸거나 없음.
  const keyed = recordingRelay('secret-relay-key')
  const wrongKey = await rawSession('claude-code', { COWORKER_RELAY: keyed.url, COWORKER_RELAY_KEY: 'wrong-key' })
  const r3 = await wrongKey.callRaw('open_bridge', { outside: true })
  expect(r3.isError).toBe(true)
  expect(r3.text).toMatch(/COWORKER_RELAY_KEY|relay key/i)
  expect(r3.text).not.toContain('cw1.')

  // 4. 중계 서버 자리에 엉뚱한 HTTP 서버가 떠 있음.
  const fake = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ hello: 'world' }) })
  servers.push(fake)
  const fakeRelay = await rawSession('claude-code', { COWORKER_RELAY: `http://127.0.0.1:${fake.port}` })
  const r4 = await fakeRelay.callRaw('open_bridge', { outside: true })
  expect(r4.isError).toBe(true)
  expect(r4.text).not.toContain('cw1.')
}, 25_000)

test('group and private codes are unchanged, and a session on released version 0.12.1 connects and talks with an outside code', async () => {
  const { url: relayUrl } = recordingRelay()
  const current = await rawSession('claude-code', { COWORKER_RELAY: relayUrl })

  // 그룹 코드와 개인용 코드는 전과 같다.
  const groupOpen = await current.call('open_bridge', {})
  expect(groupOpen.name.includes(' @ ')).toBe(true)
  expect(decodeCode(groupOpen.code).addrs).toContain('127.0.0.1')
  expect(decodeCode(groupOpen.code).port).toBe(groupOpen.port)

  const privOpen = await current.call('open_bridge', { private: true })
  expect(privOpen.kind).toStartWith('private:')
  expect(decodeCode(privOpen.code).addrs).toContain('127.0.0.1')

  // 릴리스된 0.12.1 묶음(v0.12.1 태그의 plugin/coworker.js)을 그대로 띄워 외부용 코드로 연결한다.
  const oldDir = tempDir('v0121')
  const oldBundle = join(oldDir, 'coworker.js')
  const gitShow = Bun.spawnSync(['git', 'show', 'v0.12.1:plugin/coworker.js'], { cwd: root })
  expect(gitShow.exitCode).toBe(0)
  writeFileSync(oldBundle, gitShow.stdout)

  const host = await rawSession('claude-code', { COWORKER_RELAY: relayUrl })
  const outOpen = await host.call('open_bridge', { outside: true, model: 'Fable 5.2' })
  const decoded = decodeCode(outOpen.code)
  expect(decoded.addrs.length === 1 && decoded.addrs[0]!.startsWith(`${relayUrl}/v1/box/`)).toBe(true)
  expect(decoded.name === 'Claude Code').toBe(true)

  // 상대(0.12.1)는 중계 서버 설정 없이도 외부용 코드 하나로 연결하고 묻고 답한다.
  const v0121 = await rawSession('codex-mcp-client', {}, { args: ['--no-install', oldBundle], cwd: oldDir })
  const joined = await v0121.call('connect', { code: outOpen.code, name: 'Contributor 0.12.1' })
  expect(joined.connected).toBe('Claude Code')
  await waitEvent(host.call, e => e.type === 'connected' && e.peer === 'Contributor 0.12.1')

  const asked = await v0121.call('send_question', { question: 'Does 0.12.1 work with an outside code?' })
  const gotQ = await waitEvent(host.call, e => e.type === 'message' && e.thread === asked.thread)
  await host.call('reply', { thread: gotQ.thread, text: 'Yes, 0.12.1 connects without a major bump.' })
  expect(await waitEvent(v0121.call, e => e.type === 'message' && e.kind === 'answer')).toMatchObject({
    text: 'Yes, 0.12.1 connects without a major bump.',
  })
}, 25_000)

test('tool descriptions, AI instructions, README and PRIVACY explain outside codes', async () => {
  const s = await rawSession('claude-code')
  const { tools } = await s.client.listTools()
  const openBridge = tools.find(t => t.name === 'open_bridge')!
  const props = (openBridge.inputSchema as { properties: Record<string, { description?: string }> }).properties
  expect(Boolean(props.outside?.description)).toBe(true)
  expect(s.client.getInstructions() ?? '').toContain('outside: true')

  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  const privacy = readFileSync(join(root, 'PRIVACY.md'), 'utf8')
  expect(readme).toContain('외부용 코드')
  expect(privacy).toContain('outside')
  expect(privacy).toContain('외부용 코드')
})

// 이 컴퓨터의 루프백이 아닌 IPv4 주소 하나. 없으면 그 확인은 건너뛴다.
function lanAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) for (const nic of list ?? []) if (!nic.internal && nic.family === 'IPv4') return nic.address
  return undefined
}

// 그 포트가 이 컴퓨터 밖에서 닿는 주소로도 받고 있는지.
async function answersOnLan(port: number): Promise<boolean> {
  const addr = lanAddress()
  if (!addr) return false
  try {
    await fetch(`http://${addr}:${port}/`, { signal: AbortSignal.timeout(1500) })
    return true
  } catch {
    return false
  }
}

const pressButton = (viewer: string) => fetch(`${viewer}/code`, { method: 'POST', headers: { 'x-coworker-viewer': '1' } })
const onlyRelay = (code: string, relayUrl: string) => {
  const d = decodeCode(code)
  return d.addrs.length === 1 && d.addrs[0]!.startsWith(`${relayUrl}/v1/box/`)
}

test('a bridge opened for outside sessions stays that way: a second and a tenth outside code, a failed call, the button and a restart never open it to the network or make an ordinary code', async () => {
  const relay = recordingRelay()
  const env = { COWORKER_RELAY: relay.url, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'desk-session', COWORKER_HOME: tempDir('home') }
  const deskSession = await rawSession('claude-code', env)

  const first = await deskSession.call('open_bridge', { outside: true })
  const stays = async (s: typeof deskSession) => {
    const me = (await s.call('list_connections')).me
    expect(me.addrs.length === 1 && me.addrs[0].startsWith(`${relay.url}/v1/box/`)).toBe(true)
    expect(await answersOnLan(me.port)).toBe(false)
  }
  await stays(deskSession)

  // 둘째부터 열째 코드까지.
  for (let i = 2; i <= 10; i++) {
    const more = await deskSession.call('open_bridge', { outside: true })
    expect(onlyRelay(more.code, relay.url)).toBe(true)
    expect(more.kind).toStartWith('outside')
  }
  await stays(deskSession)

  // 동료용 코드를 달라고 하면 거절한다. 그 뒤에도 그대로다.
  for (const args of [{}, { private: true }, { name: 'for colleagues' }]) {
    const asked = await deskSession.callRaw('open_bridge', args)
    expect(asked.isError).toBe(true)
    expect(asked.text).toMatch(/outside sessions only/)
    expect(asked.text).not.toContain('cw1.')
  }
  await stays(deskSession)

  // 화면의 버튼도 외부용 코드만 만든다.
  await Bun.sleep(1100)
  const pressed = (await (await pressButton(first.viewer)).json()) as { code: string; kind?: string }
  expect(onlyRelay(pressed.code, relay.url)).toBe(true)
  expect(pressed.kind).toBe('outside')

  // 다시 켠 뒤에도 그대로다.
  await deskSession.client.close()
  const back = await rawSession('claude-code', env)
  for (let i = 0; i < 40 && !(await back.call('list_connections')).me.open; i++) await Bun.sleep(50)
  await stays(back)
  expect((await back.callRaw('open_bridge', {})).isError).toBe(true)
  const after = await back.call('open_bridge', { outside: true })
  expect(onlyRelay(after.code, relay.url)).toBe(true)
  await stays(back)

  // 중계 서버가 사라져 외부용 코드를 만들지 못해도 브릿지는 바뀌지 않는다.
  relay.stop()
  for (let i = 0; i < 2; i++) {
    const failed = await back.callRaw('open_bridge', { outside: true })
    expect(failed.isError).toBe(true)
    expect(failed.text).not.toContain('cw1.')
  }
  const me = (await back.call('list_connections')).me
  expect(me.open).toBe(true)
  expect(JSON.stringify(me.addrs).includes('127.0.0.1')).toBe(false)
  expect(await answersOnLan(me.port)).toBe(false)
  expect((await back.callRaw('open_bridge', {})).isError).toBe(true)
  await Bun.sleep(1100)
  const dead = await pressButton(after.viewer)
  const body = await dead.text()
  expect(body).not.toContain('cw1.')
  expect(await answersOnLan(me.port)).toBe(false)
}, 60_000)

test('everything a session says about itself is checked before it reaches an outside session: model and effort too, from the AI and from the conversation view', async () => {
  const { url: relayUrl } = recordingRelay()
  const host = await rawSession('claude-code', { COWORKER_RELAY: relayUrl })
  const mark = shortHostname()

  // 여는 순간에 적은 모델에 컴퓨터 이름이 있으면 열지 않는다.
  const refused = await host.callRaw('open_bridge', { outside: true, model: `Fable 5.2 on ${mark}` })
  expect(refused.isError).toBe(true)
  expect(refused.text).not.toContain('cw1.')
  const refusedEffort = await host.callRaw('open_bridge', { outside: true, effort: join(homedir(), 'max') })
  expect(refusedEffort.isError).toBe(true)

  const opened = await host.call('open_bridge', { outside: true, model: 'Fable 5.2', effort: 'high' })
  const guest = await rawSession('codex-mcp-client', { COWORKER_RELAY: relayUrl })
  await guest.call('connect', { code: opened.code })
  await waitEvent(host.call, e => e.type === 'connected')

  // 화면(채팅창 위 띠)에서 적어도, 다음 코드를 만들며 적어도 나가지 않는다.
  const fromView = await fetch(`${opened.viewer}/about`, {
    method: 'POST',
    headers: { 'x-coworker-viewer': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ model: `Fable 5.2 @ ${mark}.local`, effort: `high (${userInfo().username})` }),
  })
  expect(fromView.ok).toBe(false)
  expect((await host.callRaw('open_bridge', { outside: true, model: `host ${mark}` })).isError).toBe(true)
  // 괜찮은 값은 그대로 간다.
  await fetch(`${opened.viewer}/about`, {
    method: 'POST',
    headers: { 'x-coworker-viewer': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ effort: 'max' }),
  })
  for (let i = 0; i < 40 && (await guest.call('list_connections')).peers[0]?.about?.effort !== 'max'; i++) await Bun.sleep(50)
  expect((await guest.call('list_connections')).peers[0].about).toEqual({ app: 'Claude Code', model: 'Fable 5.2', effort: 'max' })

  // 외부용 코드로 들어가는 쪽이 적는 것도 같다.
  const joiner = await rawSession('codex-mcp-client', { COWORKER_RELAY: relayUrl })
  const another = await host.call('open_bridge', { outside: true })
  expect((await joiner.callRaw('connect', { code: another.code, model: `GPT on ${mark}` })).isError).toBe(true)
}, 30_000)

test('a file goes to an outside session only when it is UTF-8 text that passes the check, whatever encoding hides the content', async () => {
  const { url: relayUrl } = recordingRelay()
  const host = await rawSession('claude-code', { COWORKER_RELAY: relayUrl })
  const guest = await rawSession('codex-mcp-client', { COWORKER_RELAY: relayUrl })
  const opened = await host.call('open_bridge', { outside: true })
  await guest.call('connect', { code: opened.code })
  await waitEvent(host.call, e => e.type === 'connected')

  const leak = `path=${homedir()}\nhost=${shortHostname()}\n`
  const files: [string, Buffer][] = [
    ['utf16le.txt', Buffer.from(`﻿${leak}`, 'utf16le')],
    ['utf16be.txt', Buffer.from(Buffer.from(leak, 'utf16le')).swap16()],
    ['latin1.txt', Buffer.concat([Buffer.from(leak), Buffer.from([0xe9, 0x0a])])],
    ['picture.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])],
    ['plain.txt', Buffer.from(leak)],
  ]
  for (const [name, bytes] of files) {
    const path = join(host.home, name)
    writeFileSync(path, bytes)
    const attempt = await host.callRaw('send_question', { question: 'Attached.', files: [path] })
    expect({ name, isError: attempt.isError === true }).toEqual({ name, isError: true })
  }
  // 인코딩 때문에 거절한 것은 까닭을 말한다.
  const why = await host.callRaw('send_question', { question: 'Attached.', files: [join(host.home, 'utf16le.txt')] })
  expect(why.text).toMatch(/UTF-8/)
  expect((await guest.call('wait_for_message', { timeout_sec: 0 })).events).toEqual([])

  // UTF-8 글로 된 괜찮은 파일은 간다.
  const fine = join(host.home, 'fine.txt')
  writeFileSync(fine, 'line one\n한글 줄\n')
  const sent = await host.call('send_question', { question: 'A sample.', files: [fine] })
  const arrived = await waitEvent(guest.call, e => e.type === 'message' && e.thread === sent.thread)
  expect(arrived.files[0]).toMatchObject({ name: 'fine.txt', verified: true })
}, 30_000)
