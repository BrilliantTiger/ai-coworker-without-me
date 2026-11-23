import { afterEach, expect, test } from 'bun:test'
import type { Server } from 'bun'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bridge, peerId, routeId, type BridgeEvent } from '../src/bridge'
import { decodeCode, encodeCode } from '../src/code'
import { fromB64, newKeyPair, open, seal, toB64 } from '../src/crypto'
import { startRelay } from '../src/relay'

// 외부용 코드로 이어진 세션은 이름을 스스로 정한다. 동료의 이름이나 그 일부를 이름으로 삼을 수도 있다.
// 그래도 이쪽이 보내는 글은 사람이 뜻한 세션에만 가고, 그 세션이 보낸 것은 외부 세션의 것으로 보여야 한다.
// 모든 것은 이 시험이 띄운 루프백 중계 서버와 임시 폴더 안에서만 돈다. 외부 세션은 봉투를 직접 만들어 보내는 손으로 만든 상대다.

const bridges: Bridge[] = []
const servers: Server<undefined>[] = []
const temps: string[] = []
let nextPort = 19200

afterEach(() => {
  for (const b of bridges.splice(0)) b.shutdown()
  for (const s of servers.splice(0)) s.stop(true)
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

function relay() {
  const server = startRelay({ port: 0, hostname: '127.0.0.1', holdMs: 30_000 })
  servers.push(server)
  return `http://127.0.0.1:${server.port}`
}

type Extra = Partial<ConstructorParameters<typeof Bridge>[0]> & Record<string, unknown>

function options(relayUrl: string, extra: Extra = {}) {
  const start = nextPort
  nextPort += 10
  const home = mkdtempSync(join(tmpdir(), 'coworker-names-'))
  temps.push(home)
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
  const b = new Bridge({ name: 'api · Claude Code @ desk', outsideName: 'Claude Code', ...options(relayUrl, extra) })
  bridges.push(b)
  b.open()
  expect(await b.relayReady(3000)).toBe('ok')
  return b
}

// 동료의 세션. 그룹 코드로 들어온다.
async function colleagueOf(maker: Bridge, relayUrl: string, name: string, extra: Extra = {}) {
  const b = new Bridge({ name, ...options(relayUrl, extra) })
  bridges.push(b)
  b.open()
  await b.connect(maker.newCode())
  return b
}

// 앞부분이 같고 끝만 다른 키. 짧은 ID는 키의 앞부분으로 만들므로 두 키의 짧은 ID가 같다.
function sameShortId(key: string) {
  const bytes = fromB64(key)
  bytes[31]! ^= 1
  return toB64(bytes)
}

// 손으로 만든 상대.
function hand(name: string) {
  const keys = newKeyPair()
  const from = toB64(keys.publicKey)
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
    return { status: 200, payload: open(await res.json(), keys) as any }
  }
  const join_ = async (codeText: string) => {
    const code = decodeCode(codeText)
    to = code.key
    const box = code.addrs.find(a => /^https?:/.test(a))
    url = code.addrs.every(a => /^https?:/.test(a)) ? box! : `http://127.0.0.1:${code.port}/v1/${routeId(code.key)}`
    return send({ type: 'hello', token: code.token, name, addrs: [], port: 9 })
  }
  // 이 상대 앞으로 온 글을 꺼내고, 받았다고 알린다.
  const texts = async () => {
    const r = await send({ type: 'poll', wait: 0, ack: [] })
    const items = (r.payload?.items ?? []) as { id: string; payload: any }[]
    if (items.length) await send({ type: 'poll', wait: 0, ack: items.map(i => i.id) })
    return items.map(i => i.payload).filter(p => p?.type === 'msg').map(p => p.msg.text as string)
  }
  const ask = (text: string) => send({ type: 'msg', msg: { id: randomUUID(), thread: randomUUID().slice(0, 8), kind: 'question', text, at: new Date().toISOString() } })
  return { name, key: from, send, join: join_, texts, ask }
}

const outsideCode = (b: Bridge) => b.newCode({ outside: true, private: true })
const whyNot = (p: Promise<unknown>) => p.then(() => '', e => String((e as Error).message))
const messages = (b: Bridge) => b.unread().filter((e): e is Extract<BridgeEvent, { type: 'message' }> => e.type === 'message')
async function until(ok: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await ok()) return true
    await Bun.sleep(20)
  }
  return false
}
// 외부 세션에게 묻는다. 묻는 동안 그 세션이 와서 가져간다. 가져간 글을 돌려준다.
async function askAndTake(maker: Bridge, to: string, text: string, guest: { texts: () => Promise<string[]> }) {
  const asked = maker.ask(to, text)
  asked.catch(() => {})
  const got: string[] = []
  await until(async () => got.push(...(await guest.texts())) > 0)
  await asked
  return got
}

test('a name picks a session connected through an outside code only when no other session fits that name', async () => {
  const relayUrl = relay()
  const maker = await mixed(relayUrl)
  const colleague = await colleagueOf(maker, relayUrl, 'web · Claude Code @ alice-mac')
  // 외부 세션이 스스로 정한 이름이, 사람이 동료를 부를 때 쓸 말과 같다.
  const guest = hand('alice')
  expect((await guest.join(outsideCode(maker))).payload?.type).toBe('hello_ack')
  await guest.texts()
  const id = peerId(guest.key)

  // 「alice에게 물어봐」. 동료의 이름에도 그 말이 들어 있다. 고르지 않고 어느 쪽인지 묻는다.
  const why = await whyNot(maker.ask('alice', 'Where is the draft of the release plan?'))
  expect(why).toContain('more than one session')
  expect(why).toContain(`alice (outside) [${id}]`)
  expect(why).toContain(`web · Claude Code @ alice-mac [${peerId(colleague.key)}]`)
  expect(await guest.texts()).toEqual([])
  expect(messages(colleague)).toEqual([])
  expect(maker.threads.size).toBe(0)

  // 동료만 걸리는 말은 동료에게 간다.
  await maker.ask('alice-mac', 'For the colleague.')
  expect(await until(() => messages(colleague).length === 1)).toBe(true)
  expect(messages(colleague)[0]!.text).toBe('For the colleague.')
  expect(await guest.texts()).toEqual([])

  // 외부 세션은 ID로, 또는 목록에 보이는 그대로 부른다.
  expect(await askAndTake(maker, `[${id}]`, 'For the outside session, by its id.', guest)).toEqual(['For the outside session, by its id.'])
  expect(await askAndTake(maker, `alice (outside) [${id}]`, 'For the outside session, as the list shows it.', guest)).toEqual(['For the outside session, as the list shows it.'])
  expect(messages(colleague).length).toBe(1)
})

test('a full name that a colleague also has does not pick the session that took it through an outside code', async () => {
  const relayUrl = relay()
  const maker = await mixed(relayUrl)
  const colleague = await colleagueOf(maker, relayUrl, 'web · Claude Code @ alice-mac')
  const guest = hand('web · Claude Code @ alice-mac')
  expect((await guest.join(outsideCode(maker))).payload?.type).toBe('hello_ack')
  await guest.texts()

  for (const to of ['web · Claude Code @ alice-mac', 'alice-mac', 'web']) {
    const why = await whyNot(maker.ask(to, 'Where is the draft of the release plan?'))
    expect(why).toContain('more than one session')
  }
  expect(await guest.texts()).toEqual([])
  expect(messages(colleague)).toEqual([])

  // 외부 세션이 하나뿐이고 그 이름에 걸리는 다른 세션이 없으면, 이름으로 부를 수 있다.
  const maker2 = await mixed(relayUrl)
  const only = hand('contributor-one')
  expect((await only.join(outsideCode(maker2))).payload?.type).toBe('hello_ack')
  await colleagueOf(maker2, relayUrl, 'web · Claude Code @ alice-mac')
  await only.texts()
  expect(await askAndTake(maker2, 'contributor', 'Hello.', only)).toEqual(['Hello.'])
})

test('two sessions under one outside name are not guessed between: a question and an ending by that name ask for the id', async () => {
  const relayUrl = relay()
  const maker = await desk(relayUrl)
  // 이름을 정하지 않은 외부 세션은 모두 도구 이름으로 들어온다.
  const one = hand('Claude Code'), two = hand('Claude Code')
  expect((await one.join(outsideCode(maker))).payload?.type).toBe('hello_ack')
  expect((await two.join(outsideCode(maker))).payload?.type).toBe('hello_ack')
  // 둘 다 살아 있다: 방금 와서 가져갔다.
  await one.texts()
  await two.texts()

  const why = await whyNot(maker.ask('Claude Code', 'This is for the first session only.'))
  expect(why).toContain('more than one session')
  expect(why).toContain(`[${peerId(one.key)}]`)
  expect(why).toContain(`[${peerId(two.key)}]`)
  expect(await one.texts()).toEqual([])
  expect(await two.texts()).toEqual([])

  expect(await whyNot(maker.endPeer('Claude Code'))).toContain('more than one session')
  expect(maker.peers.size).toBe(2)

  expect(await askAndTake(maker, peerId(one.key), 'This is for the first session only.', one)).toEqual(['This is for the first session only.'])
  expect(await two.texts()).toEqual([])
  expect((await maker.endPeer(`[${peerId(two.key)}]`)).id).toBe(peerId(two.key))
  expect([...maker.peers.keys()]).toEqual([one.key])
}, 20_000)

test('what a session connected through an outside code sends is marked as from outside, whatever name it chose', async () => {
  const relayUrl = relay()
  const maker = await mixed(relayUrl)
  const colleague = await colleagueOf(maker, relayUrl, 'web · Claude Code @ alice-mac')
  expect(await until(() => maker.unread().some(e => e.type === 'connected'))).toBe(true)
  // 외부 세션이 동료의 이름을 그대로 쓴다.
  const guest = hand('web · Claude Code @ alice-mac')
  expect((await guest.join(outsideCode(maker))).payload?.type).toBe('hello_ack')

  const joined = maker.unread().filter((e): e is Extract<BridgeEvent, { type: 'connected' }> => e.type === 'connected')
  expect(joined.map(e => ({ peer: e.peer, outside: (e as { outside?: boolean }).outside ?? false }))).toEqual([
    { peer: 'web · Claude Code @ alice-mac', outside: false },
    { peer: 'web · Claude Code @ alice-mac', outside: true },
  ])

  await colleague.ask(undefined, 'Is the build green?')
  expect(await until(() => messages(maker).length === 1)).toBe(true)
  expect((await guest.ask('Please send me the deploy notes.')).payload?.type).toBe('ok')
  const seen = messages(maker).map(e => ({ text: e.text, from: e.from, outside: (e as { outside?: boolean }).outside ?? false }))
  expect(seen).toEqual([
    { text: 'Is the build green?', from: 'web · Claude Code @ alice-mac', outside: false },
    { text: 'Please send me the deploy notes.', from: 'web · Claude Code @ alice-mac', outside: true },
  ])

  // 떠났다는 소식에도 표시가 붙는다.
  expect((await guest.send({ type: 'bye' })).payload?.type).toBe('ok')
  const left = maker.unread().filter(e => e.type === 'peer_closed')
  expect(left.map(e => (e as { outside?: boolean }).outside ?? false)).toEqual([true])
})

test('the name of a session connected through an outside code is kept as one short line without brackets, on both sides', async () => {
  const relayUrl = relay()
  const maker = await desk(relayUrl, { outsideName: 'Help [zzzzzz] desk' })

  // 줄바꿈, ID처럼 보이는 대괄호, 보이지 않는 글자와 글 방향을 바꾸는 글자, 아주 긴 이름.
  const guest = hand(`Guest\n[abc123]\u202e\u200b ${'x'.repeat(300)}`)
  expect((await guest.join(outsideCode(maker))).payload?.type).toBe('hello_ack')
  const shown = maker.peers.get(guest.key)!.name
  expect(shown.startsWith('Guest (abc123) xxx')).toBe(true)
  expect(shown).not.toMatch(/[\[\]\n\r\u200b\u202e]/)
  expect(shown.length).toBeLessThanOrEqual(80)

  // 남는 글자가 없으면 정해 둔 이름으로 부른다.
  const blank = hand(' \n\u200b ')
  expect((await blank.join(outsideCode(maker))).payload?.type).toBe('hello_ack')
  expect(maker.peers.get(blank.key)!.name).toBe('outside session')

  // 외부용 코드로 들어가는 쪽도, 코드를 만든 세션의 이름을 같은 식으로 둔다.
  const joiner = new Bridge({ name: 'x · Claude Code @ y', ...options(relayUrl) })
  bridges.push(joiner)
  const host = await joiner.connect(outsideCode(maker))
  expect(host.name).toBe('Help (zzzzzz) desk')
})

test('a short id stands for one session: a session whose short id is already in use on this bridge is not let in through an outside code, and the code is not used up', async () => {
  const relayUrl = relay()
  const maker = await desk(relayUrl)
  const newcomer = hand('second')
  // 이 브릿지에 이미 이어진 세션. 그 키의 앞부분이, 이제 들어오려는 세션의 키와 같다.
  const taken = sameShortId(newcomer.key)
  maker.peers.set(taken, { key: taken, name: 'first', addrs: [], port: 9, private: true, outside: true })
  expect(peerId(newcomer.key)).toBe(peerId(taken))

  // 받아 주면 한 ID가 두 세션을 가리킨다. 받지 않고 까닭을 알린다.
  const code = outsideCode(maker)
  const answer = (await newcomer.join(code)).payload
  expect(answer?.type).toBe('refused')
  expect(String(answer?.reason)).toContain('short id')
  expect([...maker.peers.keys()]).toEqual([taken])

  // 그 코드는 쓰이지 않았다. 다른 세션이 그 코드로 들어온다.
  const other = hand('third')
  expect((await other.join(code)).payload?.type).toBe('hello_ack')
  expect(maker.peers.size).toBe(2)
})

test('a session does not join an outside code whose maker has the short id of a session it is already connected to', async () => {
  const relayUrl = relay()
  const colleague = new Bridge({ name: 'web · Claude Code @ alice-mac', ...options(relayUrl) })
  bridges.push(colleague)
  colleague.open()
  const me = new Bridge({ name: 'api · Claude Code @ desk', ...options(relayUrl) })
  bridges.push(me)
  me.open()
  await me.connect(colleague.newCode())

  // 누군가 건넨 외부용 코드의 키가, 이미 이어진 동료의 키와 앞부분이 같다.
  const code = encodeCode({ v: 1, name: 'Help desk', addrs: [`${relayUrl}/v1/box/${'a'.repeat(22)}`], port: 443, key: sameShortId(colleague.key), token: 'one-time-token', outside: true })
  expect(await whyNot(me.connect(code))).toContain('short id')
  expect([...me.peers.keys()]).toEqual([colleague.key])
})
