import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bridge, parsePorts, routeId, type BridgeEvent } from '../src/bridge'
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

  test('catches a code copied with one character wrong', () => {
    const code = { v: 1 as const, name: 'x', addrs: ['10.0.0.2'], port: 7700, key: 'nLhjH3gE+OVawkREk4xTkkIXXeVr79+494UYISzKyCk=', token: 't' }
    const text = encodeCode(code)
    const dot = text.lastIndexOf('.')
    const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1)
    // 한 글자만 바뀌면 JSON 은 멀쩡할 수 있어서, 예전에는 상대가 거절할 때까지 몰랐다.
    expect(() => decodeCode(flip(text, dot - 10))).toThrow('copied wrong')
    expect(() => decodeCode(flip(text, text.length - 1))).toThrow('copied wrong')
    // 예전 판이 만든, 확인용 글자 없는 코드도 받는다.
    expect(decodeCode(text.slice(0, dot))).toEqual(code)
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

  test('a fresh private code lets a second session connect to the same bridge only', async () => {
    const { a, b } = await pair()
    const c = make('C · Claude Code')
    await c.connect(a.newCode({ private: true }))
    expect([...a.peers.values()].map(p => p.name).sort()).toEqual(['B · Codex', 'C · Claude Code'])
    await expect(a.ask(undefined, 'hi')).rejects.toThrow('several sessions are connected')
    expect((await a.ask('codex', 'hi')).to).toBe('B · Codex')
    await expect(a.ask('nobody', 'hi')).rejects.toThrow('no connected session matches')
    await Bun.sleep(300)
    expect(b.peers.size).toBe(1)
    expect(c.peers.size).toBe(1)
    expect((await a.connections()).peers.find(p => p.name === 'C · Claude Code')).toMatchObject({ group: false })
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

  test('a conversation has no limit on how many times the two sides go back and forth', async () => {
    const { a, b } = await pair()
    const { thread } = await b.ask(undefined, 'q')
    let last: unknown
    for (let n = 2; n <= 30; n++) last = await (n % 2 === 0 ? a : b).reply(thread, `turn ${n}`)
    // 30번째는 a가 답했다. 이제 b의 차례다.
    expect(last).toMatchObject({ status: 'waiting_for_peer' })
    await Bun.sleep(50)
    expect(b.threadSummaries()[0]).toMatchObject({ status: 'your_turn', messages: 30 })
    expect(await b.reply(thread, 'turn 31')).toMatchObject({ status: 'waiting_for_peer' })
  })

  test('an agreement goes to both sides and is saved on both PCs, with facts kept apart from guesses', async () => {
    const homeA = mkdtempSync(join(tmpdir(), 'coworker-a-'))
    const homeB = mkdtempSync(join(tmpdir(), 'coworker-b-'))
    const a = make('A · Claude Code', { home: homeA })
    const b = make('B · Codex', { home: homeB })
    await b.connect(a.newCode())
    const { thread } = await b.ask(undefined, 'Which port does the dev API use?')
    await next(a, 'message')
    await a.reply(thread, '18001, from docker-compose.yml line 12')
    await next(b, 'message')

    const wrote = await b.agree(thread, {
      conclusion: 'The dev API listens on 18001.',
      facts: [
        { fact: 'docker-compose.yml maps 18001', evidence: 'docker-compose.yml:12', checkedBy: 'them' },
        { fact: 'the client calls 18001', evidence: 'rg 18001 src/ → src/api.ts:3', checkedBy: 'me' },
      ],
      guesses: ['18000 is probably the old port'],
      forHumans: ['Remove 18000 from the docs?'],
    })
    expect(wrote).toMatchObject({ delivery: 'delivered', status: 'agreed' })
    const got = (await next(a, 'message')) as Extract<BridgeEvent, { type: 'message' }>
    expect(got).toMatchObject({ kind: 'agreement', status: 'agreed', agreement: { by: 'B · Codex', conclusion: 'The dev API listens on 18001.' } })
    // 누가 확인했는지는 이름으로 남는다. 상대가 알려 주기만 한 것은 상대 이름이다.
    expect(got.agreement!.facts.map(f => f.checkedBy)).toEqual(['A · Claude Code', 'B · Codex'])

    for (const file of [wrote.file!, got.file!]) {
      const text = readFileSync(file, 'utf8')
      expect(text).toContain('# 합의문: Which port does the dev API use?')
      expect(text).toContain('## 확인한 사실과 근거')
      expect(text).toContain('## 추측 (아무도 확인하지 않음)\n\n- 18000 is probably the old port')
      expect(text).toContain('## 의견이 갈린 점\n\n- 없음')
      expect(text).toContain('### 답 · ')
    }
    expect(wrote.file!.startsWith(join(homeB, 'agreements'))).toBe(true)
    expect(got.file!.startsWith(join(homeA, 'agreements'))).toBe(true)

    // 끝난 대화에는 더 답하지 않는다. 동의하지 않으면 자기 판을 쓴다.
    await expect(a.reply(thread, 'one more thing')).rejects.toThrow('an agreement was written')
    await a.agree(thread, { conclusion: 'Mostly agree.', disagreements: ['18000 is still used by the worker'] })
    expect(((await next(b, 'message')) as { agreement: { by: string } }).agreement.by).toBe('A · Claude Code')
    const both = readFileSync(wrote.file!, 'utf8')
    expect(both).toContain('# 합의문 · A · Claude Code 작성')
    expect(both).toContain('# 합의문 · B · Codex 작성')
    expect(a.threadSummaries()[0]).toMatchObject({ status: 'agreed', messages: 2 })
  })

  test('an agreement can be written after a long conversation, and when the other side has left', async () => {
    const { a, b } = await pair()
    const { thread } = await b.ask(undefined, 'q')
    for (let n = 2; n <= 20; n++) await (n % 2 === 0 ? a : b).reply(thread, `turn ${n}`)
    await Bun.sleep(50)
    expect(await b.agree(thread, { conclusion: 'Not settled.', forHumans: ['Pick one'] })).toMatchObject({ status: 'agreed' })
    await b.close()
    await next(a, 'peer_closed')
    expect(await a.agree(thread, { conclusion: 'Agreed to disagree.' })).toMatchObject({ delivery: expect.stringContaining('no longer connected') })
  })

  test('anything that looks like a secret is refused before it leaves', async () => {
    const { a, b } = await pair()
    const key = ['AKIA', 'Q3EGZ7YBLHPX4K2M'].join('')
    await expect(b.ask(undefined, 'Why does this fail?', `aws configure with ${key}`)).rejects.toThrow('nothing was sent')
    expect(b.threads.size).toBe(0)
    const { thread } = await b.ask(undefined, 'Which database do we use?')
    await next(a, 'message')
    await expect(a.reply(thread, 'postgres://app:S3cr3t!x@db.internal/main')).rejects.toThrow('password in a URL')
    await expect(a.hold(thread, 'password=hunter2!')).rejects.toThrow('nothing was sent')
    await expect(a.agree(thread, { conclusion: 'ok', facts: [{ fact: 'it works', evidence: `ran with ${key}`, checkedBy: 'me' }] })).rejects.toThrow('AWS access key')
    expect(a.threads.get(thread)!.messages).toHaveLength(1)
    expect(await a.reply(thread, 'Postgres; the password is in the team vault.')).toMatchObject({ delivery: 'delivered' })
  })

  test('a wait with no time limit stays open until something arrives', async () => {
    const { a, b } = await pair()
    await next(a, 'connected')
    let done = false
    const waiting = a.wait(Infinity).then(events => ((done = true), events))
    await Bun.sleep(300)
    expect(done).toBe(false)
    await b.ask(undefined, 'are you there?')
    expect(await waiting).toEqual([expect.objectContaining({ type: 'message', text: 'are you there?' })])
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

async function connectedTo(b: Bridge, names: string[]) {
  for (let i = 0; i < 60; i++) {
    if (names.every(n => [...b.peers.values()].some(p => p.name === n))) return
    await Bun.sleep(50)
  }
  throw new Error(`${b.name} is connected to ${[...b.peers.values()].map(p => p.name).join(', ')}, not ${names.join(', ')}`)
}

async function messages(b: Bridge, count: number) {
  const got: Extract<BridgeEvent, { type: 'message' }>[] = []
  for (let i = 0; i < 40 && got.length < count; i++) for (const e of await b.wait(100)) if (e.type === 'message') got.push(e)
  return got
}

async function team() {
  const a = make('A · Claude Code')
  const b = make('B · Codex')
  const c = make('C · Claude Code')
  await b.connect(a.newCode())
  await c.connect(a.newCode())
  await connectedTo(b, ['A · Claude Code', 'C · Claude Code'])
  await connectedTo(c, ['A · Claude Code', 'B · Codex'])
  return { a, b, c }
}

describe('group', () => {
  test('everyone who joins with a group code is connected with everyone already in the group', async () => {
    const { a, b, c } = await team()
    const d = make('D · Codex')
    await d.connect(c.newCode())
    for (const s of [a, b, c, d]) await connectedTo(s, [a, b, c, d].filter(x => x !== s).map(x => x.name))
    const joined = [] as BridgeEvent[]
    for (let i = 0; i < 10; i++) joined.push(...(await b.wait(50)))
    expect(joined).toContainEqual(expect.objectContaining({ type: 'connected', peer: 'D · Codex', via: 'C · Claude Code' }))
  })

  test('a session introduced to the group can be asked directly, and a stranger still cannot get in', async () => {
    const { b, c } = await team()
    const { thread } = await b.ask('C · Claude Code', 'direct between the two who joined')
    expect((await messages(c, 1))[0]).toMatchObject({ from: 'B · Codex', text: 'direct between the two who joined' })
    await c.reply(thread, 'got it')
    expect((await messages(b, 1))[0]).toMatchObject({ kind: 'answer', text: 'got it' })

    const stranger = newKeyPair()
    const url = `http://127.0.0.1:${c.port}/v1/${routeId(c.key)}`
    const hello = seal({ type: 'hello', name: 'evil', addrs: [], port: 1 }, fromB64(c.key), stranger)
    expect((await fetch(url, { method: 'POST', body: JSON.stringify(hello) })).status).toBe(403)
  })

  test('a private member does not introduce others into the group', async () => {
    const a = make('A')
    const b = make('B')
    const x = make('X')
    await b.connect(a.newCode())
    await x.connect(a.newCode({ private: true }))
    // X는 A와만 이어졌다. X가 A에게 누군가를 소개해도 A는 받지 않는다.
    const outsider = make('Outsider')
    outsider.open()
    await (x as any).sendOrQueue(x.peers.get(a.key), { type: 'introduce', member: { key: outsider.key, name: 'Outsider', addrs: ['127.0.0.1'], port: outsider.port } })
    await Bun.sleep(300)
    expect(a.connecting()).toEqual([])
    expect([...a.peers.values()].map(p => p.name).sort()).toEqual(['B', 'X'])
  })
})

describe('asking several sessions', () => {
  test('asking everyone gets an answer from each, each in its own conversation', async () => {
    const { a, b, c } = await team()
    const sent = (await a.askMany('everyone', 'Which branch are you on?')) as { ask: string; sent: { thread: string; to: string; delivery: string }[] }
    expect(sent).toMatchObject({ answers: 'all', to: ['B · Codex', 'C · Claude Code'] })
    expect(sent.sent.map(s => s.delivery)).toEqual(['delivered', 'delivered'])

    const qb = (await messages(b, 1))[0]!
    const qc = (await messages(c, 1))[0]!
    expect(qb).toMatchObject({ kind: 'question', ask: { to: ['B · Codex', 'C · Claude Code'], answers: 'all' } })
    await b.reply(qb.thread, 'main')
    await c.reply(qc.thread, 'feat/x')
    const answers = await messages(a, 2)
    expect(answers.map(e => e.text).sort()).toEqual(['feat/x', 'main'])
    expect(answers.at(-1)!.ask).toMatchObject({ id: sent.ask, answered: expect.arrayContaining(['B · Codex', 'C · Claude Code']) })
    // B와 C는 서로의 답을 보지 않는다.
    expect(await b.wait(100)).toEqual([])
  })

  test('when one answer is enough, the first answer closes the question for the others', async () => {
    const { a, b, c } = await team()
    const d = make('D · Codex')
    await d.connect(a.newCode())
    await connectedTo(a, ['B · Codex', 'C · Claude Code', 'D · Codex'])
    const sent = (await a.askMany(['B · Codex', 'C · Claude Code'], 'Who can review PR 12?', undefined, 'one')) as { ask: string }
    const qb = (await messages(b, 1))[0]!
    const qc = (await messages(c, 1))[0]!
    expect(qc.ask).toMatchObject({ answers: 'one' })
    // 묻지 않은 D에게는 질문이 가지 않는다.
    expect((await d.wait(100)).filter(e => e.type === 'message')).toEqual([])

    await b.reply(qb.thread, 'I will.')
    const got = (await messages(a, 1))[0]!
    expect(got).toMatchObject({ from: 'B · Codex', kind: 'answer', ask: { id: sent.ask, answers: 'one', closedBy: 'B · Codex' } })
    expect((await messages(c, 1))[0]).toMatchObject({ kind: 'closed', status: 'closed' })
    await expect(c.reply(qc.thread, 'me too')).rejects.toThrow('B · Codex answered first')
    await expect(c.hold(qc.thread, 'asking')).rejects.toThrow('closed')
    expect(a.threadSummaries().filter(t => t.ask?.id === sent.ask).map(t => t.status).sort()).toEqual(['closed', 'your_turn'])
  })

  test('a list with one name is an ordinary question', async () => {
    const { a } = await pair()
    expect(await a.askMany(['codex'], 'hi')).toMatchObject({ to: 'B · Codex', delivery: 'delivered' })
  })
})

describe('ports', () => {
  test('the default range can be changed', () => {
    expect(parsePorts(undefined)).toEqual([7700, 7799])
    expect(parsePorts(' 9000-9010 ')).toEqual([9000, 9010])
    expect(parsePorts('9005')).toEqual([9005, 9005])
    expect(() => parsePorts('80-90')).toThrow('COWORKER_PORTS')
    expect(() => parsePorts('9010-9000')).toThrow('COWORKER_PORTS')
    expect(() => parsePorts('abc')).toThrow('COWORKER_PORTS')
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

  test('pushes each change to the browser as it happens, without the page asking again', async () => {
    const { a, b } = await pair()
    await next(a, 'connected')
    const viewer = new Viewer(a)
    try {
      const res = await fetch(`${viewer.start()}/events`)
      expect(res.headers.get('content-type')).toContain('text/event-stream')
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const pushed = async (): Promise<ReturnType<Viewer['data']>> => {
        for (;;) {
          const end = buffer.indexOf('\n\n')
          if (end >= 0) {
            const chunk = buffer.slice(0, end)
            buffer = buffer.slice(end + 2)
            if (chunk.startsWith('data: ')) return JSON.parse(chunk.slice(6))
            continue
          }
          const { value, done } = await reader.read()
          if (done) throw new Error('the stream ended')
          buffer += decoder.decode(value, { stream: true })
        }
      }
      expect((await pushed()).conversations).toEqual([])
      const asked = await b.ask(undefined, 'Which port?')
      expect((await pushed()).conversations).toEqual([expect.objectContaining({ id: asked.thread, status: 'your_turn' })])
      await a.reply(asked.thread, '18001')
      expect((await pushed()).conversations[0]).toMatchObject({ status: 'waiting_for_peer', messages: [expect.anything(), expect.objectContaining({ text: '18001' })] })
      await reader.cancel()
    } finally {
      viewer.stop()
    }
  })
})
