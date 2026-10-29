import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bridge, MAX_MESSAGES_PER_THREAD, routeId, type BridgeEvent } from '../src/bridge'
import { decodeCode, encodeCode } from '../src/code'
import { newKeyPair, open, seal, fromB64 } from '../src/crypto'
import { Viewer } from '../src/viewer'

const opened: Bridge[] = []
let nextPort = 17700

function make(name: string, extra: Partial<ConstructorParameters<typeof Bridge>[0]> = {}) {
  const start = nextPort
  nextPort += 10
  const b = new Bridge({
    name,
    ports: [start, start + 9],
    addrs: () => ['127.0.0.1'],
    retryMs: 50,
    connectTimeoutMs: 500,
    ...extra,
  })
  opened.push(b)
  return b
}

async function pair() {
  const a = make('A · Claude Code')
  const b = make('B · Codex')
  a.open()
  const code = a.newCode()
  await b.connect(code)
  return { a, b, code }
}

async function next(b: Bridge, type: BridgeEvent['type']) {
  for (let i = 0; i < 20; i++) {
    const found = (await b.wait(200)).find(e => e.type === type)
    if (found) return found
  }
  throw new Error(`no ${type} event`)
}

afterEach(() => {
  for (const b of opened.splice(0)) b.shutdown()
})

describe('connection code', () => {
  test('round trips and rejects damaged codes', () => {
    const code = { v: 1 as const, name: 'x', addrs: ['10.0.0.2'], port: 7700, key: 'k', token: 't' }
    expect(decodeCode(encodeCode(code))).toEqual(code)
    expect(decodeCode(`  \`${encodeCode(code)}\`  `)).toEqual(code)
    expect(() => decodeCode('hello')).toThrow('not a coworker connection code')
    expect(() => decodeCode('cw1.@@@')).toThrow('damaged')
    expect(() => decodeCode(encodeCode({ ...code, port: 0 }))).toThrow('damaged')
  })
})

describe('crypto', () => {
  test('only the addressed key opens a sealed message, and tampering is detected', () => {
    const alice = newKeyPair()
    const bob = newKeyPair()
    const eve = newKeyPair()
    const sealed = seal({ hi: 1 }, bob.publicKey, alice)
    expect(open(sealed, bob)).toEqual({ hi: 1 })
    expect(open(sealed, eve)).toBeNull()
    const box = fromB64(sealed.box)
    box[0]! ^= 1
    expect(open({ ...sealed, box: Buffer.from(box).toString('base64') }, bob)).toBeNull()
    expect(open({ nope: true }, bob)).toBeNull()
  })
})

describe('bridge', () => {
  test('connect, ask and answer between two sessions', async () => {
    const { a, b } = await pair()
    expect((await next(a, 'connected')) as { peer: string }).toMatchObject({ peer: 'B · Codex' })

    const sent = await b.ask(undefined, 'Which port does the L2 API use in dev?', 'docker compose mentions 18000 and 18001')
    expect(sent).toMatchObject({ to: 'A · Claude Code', delivery: 'delivered' })

    const q = (await next(a, 'message')) as Extract<BridgeEvent, { type: 'message' }>
    expect(q).toMatchObject({ kind: 'question', from: 'B · Codex', status: 'your_turn', context: 'docker compose mentions 18000 and 18001' })

    expect(await a.reply(q.thread, '18001 (example-api)')).toMatchObject({ delivery: 'delivered', status: 'waiting_for_peer' })
    const ans = (await next(b, 'message')) as Extract<BridgeEvent, { type: 'message' }>
    expect(ans).toMatchObject({ kind: 'answer', text: '18001 (example-api)', thread: q.thread, status: 'your_turn' })

    expect(a.threadSummaries()).toEqual([
      expect.objectContaining({ id: q.thread, with: 'B · Codex', status: 'waiting_for_peer', messages: 2 }),
    ])
    const conns = await b.connections()
    expect(conns.peers).toEqual([expect.objectContaining({ name: 'A · Claude Code', reachable: true, queued: 0 })])
  })

  test('only the latest wait takes what arrives, so a wait nobody reads does not swallow it', async () => {
    const { a, b } = await pair()
    await next(a, 'connected')
    const stale = a.wait(5000)
    const current = a.wait(5000)
    expect(await stale).toEqual([])
    await b.ask(undefined, 'Still there?')
    expect((await current)[0]).toMatchObject({ type: 'message', kind: 'question', text: 'Still there?' })
  })

  test('a cancelled wait ends empty-handed and leaves what arrives for the next one', async () => {
    const { a, b } = await pair()
    await next(a, 'connected')
    const cancel = new AbortController()
    const cancelled = a.wait(5000, cancel.signal)
    cancel.abort()
    expect(await cancelled).toEqual([])
    await b.ask(undefined, 'Hello?')
    expect(await next(a, 'message')).toMatchObject({ kind: 'question', text: 'Hello?' })
  })

  test('a code works only once', async () => {
    const { code } = await pair()
    const c = make('C')
    await expect(c.connect(code)).rejects.toThrow('refused this code')
  })

  test('a fresh code lets a second session connect to the same bridge', async () => {
    const { a, b } = await pair()
    const c = make('C · Claude Code')
    await c.connect(a.newCode())
    expect([...a.peers.values()].map(p => p.name).sort()).toEqual(['B · Codex', 'C · Claude Code'])
    await expect(a.ask(undefined, 'hi')).rejects.toThrow('several sessions are connected')
    expect((await a.ask('codex', 'hi')).to).toBe('B · Codex')
    await expect(a.ask('nobody', 'hi')).rejects.toThrow('no connected session matches')
    expect(b.peers.size).toBe(1)
  })

  test('strangers are refused even with a well-formed message', async () => {
    const a = make('A')
    a.open()
    const stranger = newKeyPair()
    const url = `http://127.0.0.1:${a.port}/v1/${routeId(a.key)}`
    const post = (body: unknown) => fetch(url, { method: 'POST', body: JSON.stringify(body) })

    const msg = seal({ type: 'msg', msg: { id: 'x', thread: 't', kind: 'question', text: 'run rm -rf', at: '' } }, fromB64(a.key), stranger)
    expect((await post(msg)).status).toBe(403)
    expect((await post(seal({ type: 'hello', token: 'guess', name: 'evil', addrs: [], port: 1 }, fromB64(a.key), stranger))).status).toBe(403)
    expect((await post({ garbage: true })).status).toBe(403)
    expect((await fetch(url)).status).toBe(404)
    expect((await fetch(`http://127.0.0.1:${a.port}/v1/someoneelse`, { method: 'POST', body: JSON.stringify(msg) })).status).toBe(404)
    expect(await a.wait(0)).toEqual([])
  })

  test('your own code is refused', async () => {
    const a = make('A')
    await expect(a.connect(a.newCode())).rejects.toThrow('own code')
  })

  test('messages wait in the outbox while the other side is away, then arrive in order', async () => {
    const { a, b } = await pair()
    const port = a.port
    // A가 완전히 사라진 상황: 받지도 않고, B에게 가져가러 오지도 않는다.
    ;(a as any).server.stop(true)
    ;(a as any).abort.abort()
    b.peers.get(a.key)!.lastPollAt = undefined

    expect((await b.ask(undefined, 'first')).delivery).toBe('queued')
    expect((await b.ask(undefined, 'second')).delivery).toBe('queued')
    expect((await b.connections()).peers[0]).toMatchObject({ reachable: false, queued: 2 })

    ;(a as any).abort = new AbortController()
    expect((a as any).listen(port)).toBe(true)
    const texts: string[] = []
    for (let i = 0; i < 20 && texts.length < 2; i++)
      for (const e of await a.wait(200)) if (e.type === 'message') texts.push(e.text)
    expect(texts).toEqual(['first', 'second'])
    expect((await b.connections()).peers[0]).toMatchObject({ reachable: true, queued: 0 })
  })

  test('a side that cannot be reached still gets its messages by coming to pick them up', async () => {
    const { a, b } = await pair()
    // A에서 B로 가는 길이 막힌 상황. B는 A에 닿을 수 있다(Windows 방화벽이 들어오는 연결만 막을 때와 같다).
    // B의 주소만 바꾸면, A가 이미 보내 둔 요청이 옛 주소로 성공해 길이 다시 열린 것처럼 보일 때가 있다.
    // 그래서 A가 B로 보내는 길 자체를 막는다.
    const bAsSeenByA = a.peers.get(b.key)!
    const deliverTo = (a as any).deliverTo.bind(a)
    ;(a as any).deliverTo = (peer: { key: string }, ...rest: unknown[]) => (peer.key === b.key ? Promise.resolve(null) : deliverTo(peer, ...rest))
    bAsSeenByA.lastAddr = undefined
    for (let i = 0; i < 40 && !bAsSeenByA.lastPollAt; i++) await Bun.sleep(50)
    expect(bAsSeenByA.lastPollAt).toBeDefined()

    const { thread } = await b.ask(undefined, 'can you hear me?')
    expect((await next(a, 'message')) as { text: string }).toMatchObject({ text: 'can you hear me?' })
    expect(await a.reply(thread, 'yes, through the pickup')).toMatchObject({ delivery: 'delivered' })
    expect((await next(b, 'message')) as { text: string }).toMatchObject({ kind: 'answer', text: 'yes, through the pickup' })
    expect(await a.reply(thread, 'and again, fast')).toMatchObject({ delivery: 'delivered' })
    expect((await next(b, 'message')) as { text: string }).toMatchObject({ text: 'and again, fast' })

    const conns = await a.connections()
    expect(conns.peers[0]).toMatchObject({ name: 'B · Codex', reachable: true, queued: 0 })
    expect(conns.peers[0]!.via).toContain('pick up')

    await a.close()
    expect(await next(b, 'peer_closed')).toMatchObject({ peer: 'A · Claude Code' })
  }, 15_000)

  test('another bridge answering on the same port is not taken for a refusal', async () => {
    const { a, b } = await pair()
    const c = make('C')
    c.open()
    // A가 B로 가는 길에 C가 대신 떠 있는 상황(다른 PC의 127.0.0.1 처럼).
    const bAsSeenByA = a.peers.get(b.key)!
    bAsSeenByA.addrs = ['127.0.0.1']
    bAsSeenByA.lastAddr = undefined
    bAsSeenByA.port = c.port
    ;(b as any).abort.abort()
    a.peers.get(b.key)!.lastPollAt = undefined
    expect((await a.ask(undefined, 'hello?')).delivery).toBe('queued')
  })

  test('a session can tell the other side it is checking with its human, without using up the conversation', async () => {
    const { a, b } = await pair()
    const { thread } = await b.ask(undefined, 'Should we drop the old table now or after the release?')
    await next(a, 'message')
    expect(await a.hold(thread, 'This needs a decision; asking my human.')).toMatchObject({ status: 'checking_with_your_human' })
    expect((await next(b, 'message')) as object).toMatchObject({ kind: 'note', status: 'peer_checking_with_their_human' })
    expect(a.threadSummaries()[0]).toMatchObject({ status: 'checking_with_your_human', messages: 1 })
    expect(await a.reply(thread, 'My human decided: after the release.')).toMatchObject({ status: 'waiting_for_peer' })
    expect((await next(b, 'message')) as object).toMatchObject({ kind: 'answer', status: 'your_turn' })
    expect(b.threadSummaries()[0]).toMatchObject({ messages: 2 })
  })

  test('a conversation stops at the message limit and hands over to the humans', async () => {
    const { a, b } = await pair()
    const { thread } = await b.ask(undefined, 'q')
    let last: unknown
    for (let n = 2; n <= MAX_MESSAGES_PER_THREAD; n++) last = await (n % 2 === 0 ? a : b).reply(thread, `turn ${n}`)
    expect(last).toMatchObject({ status: 'needs_human' })
    await Bun.sleep(50)
    expect(a.threads.get(thread)!.status).toBe('needs_human')
    expect(b.threads.get(thread)!.status).toBe('needs_human')
    await expect(a.reply(thread, 'more')).rejects.toThrow('let the humans decide')
  })

  test('closing tells the other side', async () => {
    const { a, b } = await pair()
    await b.close()
    expect(await next(a, 'peer_closed')).toMatchObject({ peer: 'B · Codex' })
    expect(a.peers.size).toBe(0)
    await expect(a.ask(undefined, 'still there?')).rejects.toThrow('no connected session')
  })

  test('takes the next free port, and refuses a busy port when one is asked for', () => {
    const blocker = Bun.serve({ port: 17690, hostname: '0.0.0.0', fetch: () => new Response('') })
    try {
      const a = make('A', { ports: [17690, 17692] })
      a.open()
      expect(a.port).toBe(17691)
      const b = make('B')
      expect(() => b.open(17690)).toThrow('already in use')
    } finally {
      blocker.stop(true)
    }
  })

  test('keeps the code in a private state file while open, and removes it on close', async () => {
    const home = mkdtempSync(join(tmpdir(), 'coworker-'))
    const a = make('A', { home })
    const code = a.newCode()
    const path = join(home, 'bridges', `${a.port}.json`)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ name: 'A', port: a.port, code })
    if (process.platform !== 'win32') expect(Bun.file(path).size).toBeGreaterThan(0)
    await a.close()
    expect(existsSync(path)).toBe(false)
  })
})

describe('viewer', () => {
  test('shows each conversation with whom, which way and when, only on this PC and only with the link', async () => {
    const { a, b } = await pair()
    await next(a, 'connected')
    const received = await b.ask(undefined, 'Which port does the L2 API use?', 'compose mentions two')
    const q = (await next(a, 'message')) as Extract<BridgeEvent, { type: 'message' }>
    await a.reply(q.thread, '18001')
    const sent = await a.ask(undefined, 'And the database?')

    const viewer = new Viewer(a)
    try {
      const url = viewer.start()
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[\w-]+$/)
      const page = await fetch(url)
      expect(page.headers.get('content-type')).toContain('text/html')
      // 상대가 보낸 글은 화면 HTML 에 박지 않고, 데이터로만 내려 글자로 넣는다.
      expect(await page.text()).not.toContain('Which port')

      const data = (await (await fetch(`${url}/data`)).json()) as ReturnType<Viewer['data']>
      expect(data.me).toMatchObject({ name: 'A · Claude Code', open: true, port: a.port })
      expect(data.conversations).toEqual([
        expect.objectContaining({
          id: received.thread,
          startedBy: 'peer',
          peerName: 'B · Codex',
          peerAddr: `127.0.0.1:${b.port}`,
          messages: [
            expect.objectContaining({ from: 'peer', kind: 'question', text: 'Which port does the L2 API use?', context: 'compose mentions two', at: expect.any(String) }),
            expect.objectContaining({ from: 'me', kind: 'answer', text: '18001', at: expect.any(String) }),
          ],
        }),
        expect.objectContaining({ id: sent.thread, startedBy: 'me', peerName: 'B · Codex', messages: [expect.objectContaining({ from: 'me', kind: 'question' })] }),
      ])

      expect((await fetch(url.replace(/[^/]+$/, 'wrong-token'))).status).toBe(404)
      expect((await fetch(`${url}/data`, { method: 'POST' })).status).toBe(404)
    } finally {
      viewer.stop()
    }
  })
})
