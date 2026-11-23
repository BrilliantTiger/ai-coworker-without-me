import { afterEach, expect, test } from 'bun:test'
import type { Server } from 'bun'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bridge, routeId, safeFileName } from '../src/bridge'
import { boxOf } from '../src/box'
import { decodeCode, encodeCode } from '../src/code'
import { fromB64, newKeyPair, open, seal, toB64 } from '../src/crypto'
import { startRelay } from '../src/relay'

// 외부용 코드를 계속 만들어 모르는 사람에게 주는 세션(프로젝트의 안내 창구)을 시험한다.
// 모든 것은 이 시험이 띄운 루프백 중계 서버와 임시 폴더 안에서만 돈다.
// 상대 세션은 규칙을 지키지 않을 수 있으므로, 여기서는 봉투를 직접 만들어 보내는 손으로 만든 상대를 쓴다.

const bridges: Bridge[] = []
const servers: Server<undefined>[] = []
const temps: string[] = []
let nextPort = 18900

afterEach(() => {
  for (const b of bridges.splice(0)) b.shutdown()
  for (const s of servers.splice(0)) s.stop(true)
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'coworker-desk-'))
  temps.push(dir)
  return dir
}

function relay() {
  const server = startRelay({ port: 0, hostname: '127.0.0.1', holdMs: 30_000 })
  servers.push(server)
  return `http://127.0.0.1:${server.port}`
}

type Extra = Partial<ConstructorParameters<typeof Bridge>[0]> & Record<string, unknown>

function options(relayUrl: string, extra: Extra = {}) {
  const start = nextPort
  nextPort += 10
  const home = tempDir()
  return { ports: [start, start + 9] as [number, number], addrs: () => ['127.0.0.1'], retryMs: 50, connectTimeoutMs: 500, relay: relayUrl, home, saveTo: join(home, 'saved.json'), ...extra }
}

// 외부용으로만 연 브릿지.
async function desk(relayUrl: string, extra: Extra = {}) {
  const b = new Bridge({ name: 'Claude Code', outsideName: 'Claude Code', outsideOnly: true, ...options(relayUrl, extra) })
  bridges.push(b)
  b.open(undefined, { outsideOnly: true })
  expect(await b.relayReady(3000)).toBe('ok')
  return b
}

// 동료에게도 열려 있는 보통 브릿지. 외부용 코드도 만든다.
async function mixed(relayUrl: string, extra: Extra = {}) {
  const opts = options(relayUrl, extra)
  const b = new Bridge({ name: 'api · Claude Code @ desk', outsideName: 'Claude Code', ...opts })
  bridges.push(b)
  b.open()
  expect(await b.relayReady(3000)).toBe('ok')
  return { b, opts }
}

// 손으로 만든 상대. got 에는 브릿지가 이 상대에게 보낸 모든 것(요청의 답과, 가져간 것)이 쌓인다.
function hand(name: string, keyText?: (key: string) => string) {
  let keys = newKeyPair()
  // 키 글자를 다른 꼴로 적어 보내는 상대를 만들 때는, 꼴이 달라지는 글자(+ 나 /)가 든 키를 고른다.
  while (keyText && keyText(toB64(keys.publicKey)) === toB64(keys.publicKey)) keys = newKeyPair()
  const from = keyText ? keyText(toB64(keys.publicKey)) : toB64(keys.publicKey)
  const got: any[] = []
  const note = (p: any) => {
    got.push(p)
    if (p?.type === 'batch') for (const item of p.items ?? []) got.push(item.payload)
  }
  let url = ''
  let to = ''
  const send = async (payload: object, timeoutMs = 10_000): Promise<{ status: number; payload?: any }> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...seal(payload, fromB64(to), keys), from }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return { status: res.status }
    const opened = open(await res.json(), keys) as any
    note(opened)
    return { status: 200, payload: opened }
  }
  // 코드를 들고 인사한다. 외부용 코드는 중계 서버의 우편함으로, 동료용 코드는 바로 간다.
  const join_ = async (codeText: string, hello: Record<string, unknown> = {}) => {
    const code = decodeCode(codeText)
    to = code.key
    const box = code.addrs.find(a => /^https?:/.test(a))
    url = code.addrs.every(a => /^https?:/.test(a)) ? box! : `http://127.0.0.1:${code.port}/v1/${routeId(code.key)}`
    return send({ type: 'hello', token: code.token, name, addrs: [], port: 9, ...hello })
  }
  const poll = async () => {
    const r = await send({ type: 'poll', wait: 0, ack: [] })
    return (r.payload?.items ?? []).map((i: any) => i.payload) as any[]
  }
  const ask = (text: string, thread = randomUUID().slice(0, 8), more: Record<string, unknown> = {}) =>
    send({ type: 'msg', msg: { id: randomUUID(), thread, kind: 'question', text, at: new Date().toISOString(), ...more } })
  return { name, key: from, keys, got, send, join: join_, poll, ask }
}

const text = (v: unknown) => JSON.stringify(v)

test('group members and a session that joined with an outside code are never introduced to each other, in either order and after a restart', async () => {
  const relayUrl = relay()
  const { b: maker, opts } = await mixed(relayUrl)
  const member1 = hand('member-one')
  const outsider = hand('stranger-one')
  const member2 = hand('member-two')
  const member3 = hand('member-three')

  // 그룹에 동료가 먼저 있고, 그 뒤에 외부 세션이 들어온다.
  expect((await member1.join(maker.newCode(), { addrs: ['127.0.0.1'] })).payload.type).toBe('hello_ack')
  const ack = (await outsider.join(maker.newCode({ outside: true }))).payload
  expect(ack.type).toBe('hello_ack')
  expect(ack.members ?? []).toEqual([])
  expect(ack.private).toBe(true)
  expect(await member1.poll()).toEqual([])

  // 외부 세션이 먼저 있고, 그 뒤에 동료가 들어온다.
  const ack2 = (await member2.join(maker.newCode(), { addrs: ['127.0.0.1'] })).payload
  expect((ack2.members ?? []).map((m: { key: string }) => m.key)).toEqual([member1.key])
  expect(await outsider.poll()).toEqual([])
  expect((await member1.poll()).map(p => `${p.type}:${p.member?.key}`)).toEqual([`introduce:${member2.key}`])

  // 다시 켠 뒤에도 같다.
  const saved = JSON.parse(JSON.stringify(maker.snapshot()))
  maker.shutdown()
  const again = Bridge.restore(saved, opts)
  bridges.push(again)
  expect(await again.relayReady(3000)).toBe('ok')
  const ack3 = (await member3.join(again.newCode(), { addrs: ['127.0.0.1'] })).payload
  expect((ack3.members ?? []).map((m: { key: string }) => m.key).sort()).toEqual([member1.key, member2.key].sort())
  await outsider.poll()
  await member1.poll()
  await member2.poll()

  // 브릿지가 외부 세션에게 보낸 어떤 것에도 동료의 이름과 키가 없고, 동료에게 보낸 어떤 것에도 외부 세션의 이름과 키가 없다.
  const toOutsider = text(outsider.got)
  for (const m of [member1, member2, member3]) {
    expect(toOutsider.includes(m.key)).toBe(false)
    expect(toOutsider.includes(m.name)).toBe(false)
    expect(text(m.got).includes(outsider.key)).toBe(false)
    expect(text(m.got).includes(outsider.name)).toBe(false)
  }
  expect(outsider.got.some(p => p?.type === 'introduce')).toBe(false)
}, 20_000)

test('one outside session cannot make the maker keep more than the limits: more is refused with the reason, and the state stays small', async () => {
  const relayUrl = relay()
  const maker = await desk(relayUrl, { outsideLimits: { conversations: 3, messages: 8, messageBytes: 2000, totalBytes: 9000 } })
  const stranger = hand('stranger')
  expect((await stranger.join(maker.newCode({ outside: true }))).payload.type).toBe('hello_ack')

  // 대화 수: 넷째 대화부터 받지 않고, 까닭을 알려 준다.
  const threads: string[] = []
  for (let i = 0; i < 3; i++) {
    const thread = randomUUID().slice(0, 8)
    threads.push(thread)
    expect((await stranger.ask(`question ${i}`, thread)).payload.type).toBe('ok')
  }
  const fourth = (await stranger.ask('one more conversation')).payload
  expect(fourth.type).toBe('refused')
  expect(fourth.reason).toMatch(/3 conversations/)
  expect(maker.threads.size).toBe(3)

  // 글 하나의 크기.
  const big = (await stranger.ask('x'.repeat(5000), threads[0])).payload
  expect(big.type).toBe('refused')
  expect(big.reason).toMatch(/larger than/)

  // 글의 수: 여덟까지 받는다(이미 셋).
  for (let i = 0; i < 5; i++) expect((await stranger.ask(`more ${i}`, threads[0])).payload.type).toBe('ok')
  const ninth = (await stranger.ask('ninth', threads[0])).payload
  expect(ninth.type).toBe('refused')
  expect(ninth.reason).toMatch(/8 messages/)
  expect([...maker.threads.values()].reduce((n, t) => n + t.messages.length, 0)).toBe(8)

  // 받지 않은 것은 AI에게도 가지 않는다.
  const events = await maker.wait(0)
  expect(events.filter(e => e.type === 'message')).toHaveLength(8)
}, 20_000)

test('the total kept from one outside session is bounded, and with the default limits a flood leaves a small state on disk', async () => {
  const relayUrl = relay()
  const small = await desk(relayUrl, { outsideLimits: { messages: 1000, messageBytes: 2000, totalBytes: 9000 } })
  const a = hand('a')
  await a.join(small.newCode({ outside: true }))
  const thread = randomUUID().slice(0, 8)
  let kept = 0
  let reason = ''
  for (let i = 0; i < 30; i++) {
    const r = (await a.ask('y'.repeat(1000), thread)).payload
    if (r.type === 'ok') kept++
    else reason = r.reason
  }
  expect(kept).toBeGreaterThan(3)
  expect(kept).toBeLessThan(10)
  expect(reason).toMatch(/in total|altogether/)

  // 기본 한도: 큰 글을 새 대화로 수백 번 보내도 저장된 상태는 작게 남는다.
  const maker = await desk(relayUrl)
  const flood = hand('flood')
  await flood.join(maker.newCode({ outside: true }))
  const first = randomUUID().slice(0, 8)
  const sends: Promise<unknown>[] = []
  for (let i = 0; i < 150; i++) {
    if (i % 10 === 0) await Promise.all(sends.splice(0))
    sends.push(flood.ask('z'.repeat(50_000), i === 0 ? first : undefined))
  }
  await Promise.all(sends)
  for (let i = 0; i < 150; i++) await flood.ask('w'.repeat(50_000), first)
  // 대화 번호가 아닌 것, 다시 인사하기도 쌓이지 않는다.
  for (let i = 0; i < 300; i++) await flood.send({ type: 'msg', msg: { id: randomUUID(), thread: '../../x', kind: 'question', text: 'q', at: '' } })
  for (let i = 0; i < 300; i++) await flood.send({ type: 'hello', name: 'flood', addrs: [], port: 9, back: true })
  expect(maker.threads.size).toBeLessThanOrEqual(20)
  maker.persist()
  const home = maker.log.path!.replace(/[\\/]logs[\\/].*$/, '')
  const size = (dir: string): number => readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(join(dir, e.name)) : statSync(join(dir, e.name)).size), 0)
  // 한 외부 세션이 이 PC에 남길 수 있는 것은 모두 합쳐 8 MiB 를 넘지 않는다(문서에 적는 값).
  expect(size(home)).toBeLessThan(8 * 1024 * 1024)
  expect(maker.unread().length).toBeLessThan(400)
}, 60_000)

test('files from an outside session are refused unless the bridge allows them, and then they have a quota', async () => {
  const relayUrl = relay()
  const closed = await desk(relayUrl)
  const stranger = hand('stranger')
  const ack = (await stranger.join(closed.newCode({ outside: true }))).payload
  expect(ack.can ?? []).not.toContain('files')
  const bytes = Buffer.from('hello from outside\n'.repeat(30))
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const chunk = (id: string) => ({ type: 'file', id, seq: 0, of: 1, size: bytes.length, data: bytes.toString('base64') })
  const id = randomUUID()
  const refused = (await stranger.send(chunk(id))).payload
  expect(refused.type).toBe('refused')
  expect(refused.reason).toMatch(/files/)
  await stranger.ask('see attached', undefined, { files: [{ id, name: 'note.txt', size: bytes.length, sha256 }] })
  const filesRoot = join(closed.log.path!.replace(/[\\/]logs[\\/].*$/, ''), 'files')
  const all = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? all(join(dir, e.name)) : [e.name])) : [])
  expect(all(filesRoot)).toEqual([])

  // 파일을 받기로 하고 연 브릿지: 정한 양까지만 받는다.
  const openDesk = await desk(relayUrl, { outsideFiles: true, outsideLimits: { fileBytes: 1000 } })
  const sender = hand('sender')
  const ack2 = (await sender.join(openDesk.newCode({ outside: true }))).payload
  expect(ack2.can).toContain('files')
  const one = randomUUID()
  expect((await sender.send(chunk(one))).payload.type).toBe('ok')
  await sender.ask('first file', undefined, { files: [{ id: one, name: 'note.txt', size: bytes.length, sha256 }] })
  const event = (await openDesk.wait(0)).find(e => e.type === 'message') as { files?: { verified: boolean }[] }
  expect(event.files?.[0]?.verified).toBe(true)
  const two = randomUUID()
  const over = (await sender.send(chunk(two))).payload
  expect(over.type).toBe('refused')
  expect(over.reason).toMatch(/files/)
}, 20_000)

test('a bridge takes at most five outside sessions by default; a further one is refused with the reason and its code is not used up', async () => {
  const relayUrl = relay()
  const maker = await desk(relayUrl)
  const five = [1, 2, 3, 4, 5].map(n => hand(`stranger-${n}`))
  for (const s of five) expect((await s.join(maker.newCode({ outside: true }))).payload.type).toBe('hello_ack')

  const sixth = hand('stranger-6')
  const code = maker.newCode({ outside: true })
  const refused = (await sixth.join(code)).payload
  expect(refused.type).toBe('refused')
  expect(refused.reason).toMatch(/5 outside sessions/)
  expect(maker.peers.size).toBe(5)

  // 한 세션이 떠나면, 같은 코드로 들어온다.
  expect((await five[0]!.send({ type: 'bye' })).payload.type).toBe('ok')
  expect((await sixth.join(code)).payload.type).toBe('hello_ack')
  expect(maker.peers.size).toBe(5)

  // 이쪽 사람이 한 세션과의 연결만 끝내도 자리가 난다. 끝낸 세션은 새 코드 없이는 다시 들어오지 못한다.
  const seventh = hand('stranger-7')
  const code7 = maker.newCode({ outside: true })
  expect((await seventh.join(code7)).payload.type).toBe('refused')
  await maker.endPeer('stranger-2')
  expect(maker.peers.size).toBe(4)
  expect((await seventh.join(code7)).payload.type).toBe('hello_ack')
  expect((await five[1]!.send({ type: 'ping' })).status).toBe(403)

  // 한도는 설정으로 바꾼다.
  const wide = await desk(relayUrl, { outsideLimits: { sessions: 1 } })
  expect((await hand('p').join(wide.newCode({ outside: true }))).payload.type).toBe('hello_ack')
  expect((await hand('q').join(wide.newCode({ outside: true }))).payload.type).toBe('refused')
}, 20_000)

test('an outside session holding many waiting requests does not delay the greeting of the next one', async () => {
  const relayUrl = relay()
  const maker = await desk(relayUrl)
  const holder = hand('holder')
  expect((await holder.join(maker.newCode({ outside: true }))).payload.type).toBe('hello_ack')
  // 가져가기 요청 200개를 한꺼번에 걸어 둔다. 예전에는 하나하나가 25초씩 우편함 자리를 차지했다.
  // 한꺼번에 이으면 이 PC가 연결을 받지 못하므로 스무 개씩 나눠 건다.
  const held: Promise<unknown>[] = []
  for (let i = 0; i < 200; i++) {
    if (i % 20 === 0) await Bun.sleep(40)
    held.push(holder.send({ type: 'poll', wait: 25_000, ack: [] }, 40_000).catch(() => undefined))
  }
  await Bun.sleep(1000)
  const next = hand('next')
  const started = Date.now()
  const ack = await next.join(maker.newCode({ outside: true }))
  expect(ack.status).toBe(200)
  expect(ack.payload.type).toBe('hello_ack')
  expect(Date.now() - started).toBeLessThan(3000)
  void held
}, 30_000)

test('a question to everyone goes to the group only, and group members never learn the name of an outside session', async () => {
  const relayUrl = relay()
  const { b: maker } = await mixed(relayUrl)
  const member = hand('member-one')
  const member2 = hand('member-two')
  const outsider = hand('stranger-one')
  await member.join(maker.newCode(), { addrs: ['127.0.0.1'] })
  await member2.join(maker.newCode(), { addrs: ['127.0.0.1'] })
  await outsider.join(maker.newCode({ outside: true }))

  // 「모두」는 그룹이다.
  const everyone = (await maker.askMany('everyone', 'Status check?', undefined, 'one')) as { to: string[] }
  expect(everyone.to.sort()).toEqual(['member-one', 'member-two'])
  expect(await outsider.poll()).toEqual([])
  await member.poll()
  await member2.poll()

  // 이름으로는 외부 세션에도 묻는다. 동료에게 가는 글에는 외부 세션의 이름이 없다.
  await maker.askMany(['member-one', 'member-two', 'stranger-one'], 'Who can check the parser?', undefined, 'one')
  const toMember = (await member.poll()).find(p => p.type === 'msg')
  expect(toMember.msg.ask.to.sort()).toEqual(['member-one', 'member-two'])
  const toOutsider = (await outsider.poll()).find(p => p.type === 'msg')
  expect(toOutsider.msg.ask).toBeUndefined()

  // 외부 세션이 먼저 답해도, 동료가 받는 마감 알림에 그 이름이 없다.
  await outsider.send({ type: 'msg', msg: { id: randomUUID(), thread: toOutsider.msg.thread, kind: 'answer', text: 'I can.', at: '' } })
  const closed = (await member.poll()).find(p => p.type === 'msg' && p.msg.kind === 'closed')
  expect(closed.msg.text).toMatch(/answered first/)
  expect(text(member.got).includes('stranger-one')).toBe(false)
  expect(text(member2.got).includes('stranger-one')).toBe(false)

  // 외부 세션만 이어져 있으면 「모두」에게 물을 사람이 없다.
  const only = await desk(relayUrl)
  await hand('lonely').join(only.newCode({ outside: true }))
  await expect(only.askMany('everyone', 'Anyone?')).rejects.toThrow(/by name/)
}, 20_000)

test('the maker never sends to an address that a session joining with an outside code names', async () => {
  const real = startRelay({ port: 0, hostname: '127.0.0.1', holdMs: 30_000 })
  servers.push(real)
  // 브릿지가 중계 서버로 보내는 요청을 모두 적는 프록시.
  const paths: string[] = []
  const proxy = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 0,
    async fetch(req) {
      const u = new URL(req.url)
      paths.push(u.pathname)
      const body = req.method === 'POST' ? await req.text() : undefined
      return fetch(`http://127.0.0.1:${real.port}${u.pathname}`, { method: req.method, headers: req.headers, body })
    },
  })
  servers.push(proxy)
  let knocks = 0
  const elsewhere = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => (knocks++, new Response('no', { status: 404 })) })
  servers.push(elsewhere)

  const proxyUrl = `http://localhost:${proxy.port}`
  const maker = await desk(proxyUrl)
  // 같은 중계 서버에 있는 제삼자의 우편함.
  const thirdSecret = 'third-party-secret'
  const third = boxOf(thirdSecret)
  const openThird = () => fetch(`http://127.0.0.1:${real.port}/v1/inbox/${third}`, { method: 'POST', headers: { authorization: `Bearer ${thirdSecret}`, 'content-type': 'application/json' }, body: '{"wait":0}' }).then(r => r.json()) as Promise<{ items: unknown[] }>
  await openThird()

  const stranger = hand('stranger')
  const code = decodeCode(maker.newCode({ outside: true }))
  const named = [`${proxyUrl}/v1/box/${third}`, code.addrs[0]!, `http://127.0.0.1:${elsewhere.port}`, '127.0.0.1']
  // 손으로 만든 상대는 프록시를 거치지 않고 진짜 중계 서버로 보낸다. 그래서 적힌 것은 모두 브릿지가 보낸 것이다.
  const direct = { ...code, addrs: [code.addrs[0]!.replace(proxyUrl, `http://127.0.0.1:${real.port}`)] }
  expect((await stranger.join(encodeCode(direct), { addrs: named, port: elsewhere.port })).payload.type).toBe('hello_ack')
  await stranger.send({ type: 'hello', name: 'stranger', addrs: named, port: elsewhere.port, back: true })

  const sent = maker.ask('stranger', 'Can you reproduce it?')
  await Bun.sleep(300)
  // 답은 그 세션이 스스로 가져간다.
  expect((await stranger.poll()).some(p => p.type === 'msg' && p.msg.text === 'Can you reproduce it?')).toBe(true)
  await sent
  await maker.connections()
  await Bun.sleep(300)

  expect(paths.filter(p => p.startsWith('/v1/box/'))).toEqual([])
  expect((await openThird()).items).toEqual([])
  expect(knocks).toBe(0)
  expect([...maker.peers.values()][0]!.addrs).toEqual([])
}, 20_000)

test('refusals and repeated greetings cannot push older lines out of the connection log: a line at the first, the tenth, the hundredth, and the count is kept', async () => {
  const relayUrl = relay()
  const maker = await desk(relayUrl, { outsideLimits: { messageBytes: 1000 } })
  const stranger = hand('stranger')
  await stranger.join(maker.newCode({ outside: true }))
  for (let i = 0; i < 250; i++) await stranger.send({ type: 'msg', msg: { id: randomUUID(), thread: 'not-an-id', kind: 'question', text: 'q', at: '' } })
  for (let i = 0; i < 250; i++) await stranger.ask('x'.repeat(3000))
  for (let i = 0; i < 120; i++) await stranger.send({ type: 'hello', name: 'stranger', addrs: [], port: 9, back: i % 2 === 0 })
  // 코드 없이, 또는 없는 코드로 두드리는 모르는 세션들.
  const code = decodeCode(maker.newCode({ outside: true }))
  for (let i = 0; i < 120; i++) expect((await hand(`knock-${i}`).join(encodeCode({ ...code, token: `wrong-${i}` }))).status).toBe(403)

  const lines = readFileSync(maker.log.path!, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  expect(lines[0].event).toBe('open')
  expect(lines.length).toBeLessThan(25)
  expect(lines.filter(l => l.event === 'refused_thread_id').map(l => l.count)).toEqual([1, 10, 100])
  expect(lines.filter(l => l.event === 'refused_outside').map(l => l.count)).toEqual([1, 10, 100])
  expect(lines.filter(l => l.event === 'refused_stranger').map(l => l.count)).toEqual([1, 10, 100])
  expect(lines.filter(l => l.event === 'hello_in').map(l => l.count)).toEqual([1, 10, 100])
  expect((await maker.connections()).peers[0]!.refused).toBe(500)
  // 「돌아왔다」는 소식도 쌓이지 않는다.
  expect(maker.unread().filter(e => e.type === 'connected' && e.again).length).toBe(1)
}, 60_000)

test('a received file name cut to 150 characters never ends with a dot or a space', () => {
  for (const name of [`${'a'.repeat(149)}. b.txt`, `${'a'.repeat(148)}.. .txt`, `${'a'.repeat(149)} .txt`, `con${'.'.repeat(160)}`, `${'가'.repeat(149)}.`]) {
    const safe = safeFileName(name)
    expect(safe.length).toBeLessThanOrEqual(150)
    expect(/[. ]$/.test(safe)).toBe(false)
    expect(safe.length).toBeGreaterThan(0)
  }
  expect(safeFileName('report.final.txt')).toBe('report.final.txt')
})

test('a session that joins with an outside code sends no address, no port and no computer name in its greeting', async () => {
  const relayUrl = relay()
  // 손으로 만든 「코드를 만든 쪽」: 중계 서버에 우편함을 열고, 들어오는 인사를 꺼내 열어 본다.
  const makerKeys = newKeyPair()
  const secret = 'maker-box-secret'
  const box = boxOf(secret)
  const owner = { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }
  const inbox = async (wait: number) => ((await (await fetch(`${relayUrl}/v1/inbox/${box}`, { method: 'POST', headers: owner, body: JSON.stringify({ wait }) })).json()) as { items: { id: string; body: string }[] }).items
  await inbox(0)
  const relayPort = Number(new URL(relayUrl).port)
  const code = encodeCode({ v: 1, name: 'Claude Code', addrs: [`${relayUrl}/v1/box/${box}`], port: relayPort, key: toB64(makerKeys.publicKey), token: 'tok', outside: true })

  // 동료에게 이미 열어 둔 보통 브릿지. 이름에 폴더와 컴퓨터 이름이 있고, 사내 주소와 포트가 있다.
  const start = nextPort
  nextPort += 10
  const joiner = new Bridge({ name: 'billing-api · Codex @ dev-box-7', ports: [start, start + 9], addrs: () => ['192.168.7.7', 'dev-box-7.local', '127.0.0.1'], retryMs: 50, connectTimeoutMs: 500, relay: relayUrl, home: tempDir() })
  bridges.push(joiner)
  joiner.open()
  joiner.setAbout({ app: 'Codex', model: 'GPT-5.5' })
  expect(await joiner.relayReady(3000)).toBe('ok')

  const greetings: any[] = []
  const serve = async () => {
    for (const item of await inbox(3000)) {
      const sealed = JSON.parse(item.body)
      const hello = open(sealed, makerKeys) as any
      greetings.push(hello)
      const answer = hello.type === 'hello' ? { type: 'hello_ack', name: 'Claude Code', private: true } : hello.type === 'poll' ? { type: 'batch', items: [] } : { type: 'pong' }
      await fetch(`${relayUrl}/v1/reply/${box}`, { method: 'POST', headers: owner, body: JSON.stringify({ id: item.id, status: 200, body: JSON.stringify(seal(answer, fromB64(sealed.from), makerKeys)) }) })
    }
  }
  const connecting = joiner.connect(code)
  for (let i = 0; i < 5 && !greetings.some(g => g.type === 'hello'); i++) await serve()
  const peer = await connecting
  expect(peer.outside).toBe(true)
  // 소개가 바뀌어 다시 인사할 때도 같다.
  joiner.setAbout({ effort: 'high' })
  for (let i = 0; i < 5 && greetings.filter(g => g.type === 'hello').length < 2; i++) await serve()

  const hellos = greetings.filter(g => g.type === 'hello')
  expect(hellos.length).toBeGreaterThanOrEqual(2)
  for (const hello of hellos) {
    expect(hello.name).toBe('Codex')
    expect(hello.addrs).toEqual([])
    expect(hello.port).toBe(relayPort)
    expect(hello.port).not.toBe(joiner.port)
  }
  const all = text(greetings)
  for (const mark of ['dev-box-7', 'billing-api', '192.168.7.7', '.local']) expect(all.includes(mark)).toBe(false)
  // 이 세션의 우편함 주소도 보내지 않는다.
  expect(all.includes('/v1/box/')).toBe(false)
}, 30_000)

test('an agreement from a session whose key text is not in the usual form is saved like any other, and when no file can be written the AI is told', async () => {
  const relayUrl = relay()
  const { b: maker } = await mixed(relayUrl)
  // 같은 키를 base64url 글자로 적어 보내는 세션. 봉투는 열리지만 키 글자의 꼴이 다르다.
  const odd = hand('odd-key', key => key.replace(/\+/g, '-').replace(/\//g, '_'))
  expect((await odd.join(maker.newCode(), { addrs: ['127.0.0.1'] })).payload.type).toBe('hello_ack')
  const thread = randomUUID().slice(0, 8)
  await odd.ask('Shall we write it down?', thread)
  const agreement = { by: 'odd-key', conclusion: 'Agreed on the format.', facts: [], guesses: [], disagreements: [], forHumans: [] }
  await odd.send({ type: 'msg', msg: { id: randomUUID(), thread, kind: 'agreement', text: '', agreement, at: '' } })
  const event = (await maker.wait(0)).find(e => e.type === 'message' && e.kind === 'agreement') as { file?: string; not_saved?: string }
  expect(typeof event.file).toBe('string')
  expect(event.not_saved).toBeUndefined()
  expect(readFileSync(event.file!, 'utf8')).toContain('Agreed on the format.')

  // 파일을 둘 자리가 없는 세션: 합의문은 보이고, 저장하지 못했다고 알린다.
  const start = nextPort
  nextPort += 10
  const homeless = new Bridge({ name: 'no-home', ports: [start, start + 9], addrs: () => ['127.0.0.1'], retryMs: 50, connectTimeoutMs: 500 })
  bridges.push(homeless)
  homeless.open()
  const other = hand('other')
  await other.join(homeless.newCode(), { addrs: ['127.0.0.1'] })
  const t2 = randomUUID().slice(0, 8)
  await other.ask('And here?', t2)
  await other.send({ type: 'msg', msg: { id: randomUUID(), thread: t2, kind: 'agreement', text: '', agreement, at: '' } })
  const shown = (await homeless.wait(0)).find(e => e.type === 'message' && e.kind === 'agreement') as { file?: string; not_saved?: string; text: string }
  expect(shown.text).toContain('Agreed on the format.')
  expect(shown.file).toBeUndefined()
  expect(shown.not_saved).toMatch(/not be saved|could not be saved/)
}, 20_000)

test('a bridge for outside sessions that a keeper opens again listens where it listened before, and the keeper opens no other port when that one is held', async () => {
  const relayUrl = relay()
  const opts = options(relayUrl)
  const maker = new Bridge({ name: 'Claude Code', outsideName: 'Claude Code', outsideOnly: true, ...opts })
  bridges.push(maker)
  maker.open(undefined, { outsideOnly: true })
  expect(await maker.relayReady(3000)).toBe('ok')
  expect((await hand('stranger-one').join(maker.newCode({ outside: true }))).payload.type).toBe('hello_ack')
  const port = maker.port
  // 운영체제가 고른 번호다. 방화벽에 열어 둔 범위의 번호가 아니다.
  expect(port < opts.ports[0] || port > opts.ports[1]).toBe(true)
  const saved = JSON.parse(JSON.stringify(maker.snapshot()))
  maker.shutdown()

  // 세션이 죽은 뒤 지킴이가 이어 연다: 쓰던 번호 그대로, 외부용 전용 그대로.
  const kept = Bridge.restore(saved, { ...opts, keeper: true })
  bridges.push(kept)
  expect(kept.port).toBe(port)
  expect(kept.isOutsideOnly).toBe(true)

  // 그 번호를 다른 프로세스가 쥐고 있으면(여기서는 방금 연 지킴이), 지킴이는 다른 번호를 열지 않고 물러난다.
  // 그래야 한 다리를 두 프로세스가 함께 쥐지 않는다.
  let second: Bridge | undefined
  let why = ''
  try {
    second = Bridge.restore(saved, { ...opts, keeper: true })
    bridges.push(second)
  } catch (e) {
    why = String((e as Error).message)
  }
  expect(second).toBeUndefined()
  expect(why).toContain(String(port))

  // 세션이 다시 켜질 때는 그 번호가 막혀 있어도 열린다: 운영체제가 고른 다른 번호로, 이 PC 안에서만.
  const session = Bridge.restore(saved, opts)
  bridges.push(session)
  expect(session.port).not.toBe(port)
  expect(session.port < opts.ports[0] || session.port > opts.ports[1]).toBe(true)
  expect(session.isOutsideOnly).toBe(true)
})

