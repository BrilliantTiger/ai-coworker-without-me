import { afterEach, expect, test } from 'bun:test'
import type { Server } from 'bun'
import { connect as tcp, type Socket } from 'node:net'
import { Bridge, type BridgeEvent } from '../src/bridge'
import { boxOf, startRelay } from '../src/relay'

// 서로 바로 닿지 않는 두 PC를 흉내 낸다. 각자 주소를 하나도 내놓지 않아서 중계 서버로만 닿는다.
const servers: Server<undefined>[] = []
const bridges: Bridge[] = []
const sockets: Socket[] = []
let nextPort = 17800

function relay(key?: string) {
  const server = startRelay({ port: 0, hostname: '127.0.0.1', key, holdMs: 30_000 })
  servers.push(server)
  return `http://127.0.0.1:${server.port}`
}

function make(name: string, extra: Partial<ConstructorParameters<typeof Bridge>[0]> = {}) {
  const start = nextPort
  nextPort += 10
  const b = new Bridge({ name, ports: [start, start + 9], addrs: () => [], retryMs: 50, connectTimeoutMs: 500, pollWaitMs: 1000, ...extra })
  bridges.push(b)
  return b
}

async function next(b: Bridge, type: BridgeEvent['type']) {
  for (let i = 0; i < 40; i++) {
    const found = (await b.wait(200)).find(e => e.type === type)
    if (found) return found
  }
  throw new Error(`no ${type} event`)
}

afterEach(() => {
  for (const k of sockets.splice(0)) k.destroy()
  for (const b of bridges.splice(0)) b.shutdown()
  for (const s of servers.splice(0)) s.stop(true)
})

test('two sessions that cannot reach each other talk through the relay', async () => {
  const url = relay()
  const a = make('A · Claude Code', { relay: url })
  const b = make('B · Codex', { relay: url })
  a.open()
  expect(await a.relayReady(2000)).toBe('ok')
  const code = a.newCode()
  expect(a.addrs()).toEqual([expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/v1\/box\/[\w-]{22}$/)])

  await b.connect(code)
  expect(await next(a, 'connected')).toMatchObject({ peer: 'B · Codex' })
  const { thread, delivery } = await b.ask(undefined, 'Which port does the dev API use?')
  expect(delivery).toBe('delivered')
  expect(await next(a, 'message')).toMatchObject({ kind: 'question', text: 'Which port does the dev API use?' })
  expect(await a.reply(thread, '18001')).toMatchObject({ delivery: 'delivered' })
  expect(await next(b, 'message')).toMatchObject({ kind: 'answer', text: '18001' })
  expect((await b.connections()).peers[0]).toMatchObject({ reachable: true, via: expect.stringMatching(/^127\.0\.0\.1:\d+ \(relay\)$/) })

  await b.close()
  expect(await next(a, 'peer_closed')).toMatchObject({ peer: 'B · Codex' })
})

test('only one side needs the relay: the other comes to pick up its messages through it', async () => {
  const url = relay()
  const a = make('A', { relay: url })
  const b = make('B')
  a.open()
  await a.relayReady(2000)
  await b.connect(a.newCode())
  await next(a, 'connected')
  // A는 B에게 바로 닿지 못한다. B가 중계 서버를 거쳐 A에게 와서 가져간다.
  const { thread } = await b.ask(undefined, 'ping?')
  await next(a, 'message')
  for (let i = 0; i < 40 && !(await a.connections()).peers[0]!.reachable; i++) await Bun.sleep(50)
  expect(await a.reply(thread, 'pong')).toMatchObject({ delivery: 'delivered' })
  expect(await next(b, 'message')).toMatchObject({ kind: 'answer', text: 'pong' })
})

test('a relay with a key opens boxes only for sessions that know it', async () => {
  const url = relay('team-key-1')
  const wrong = make('W', { relay: url, relayKey: 'nope' })
  wrong.open()
  expect(await wrong.relayReady(2000)).toEqual({ error: expect.stringContaining('wrong or missing relay key') })
  const right = make('R', { relay: url, relayKey: 'team-key-1' })
  right.open()
  expect(await right.relayReady(2000)).toBe('ok')
  // 키 없이도 이미 열린 우편함에는 보낼 수 있다. 상대는 중계 서버를 몰라도 된다.
  const outsider = make('O')
  await outsider.connect(right.newCode())
  expect(await next(right, 'connected')).toMatchObject({ peer: 'O' })
})

test('only the owner can take from a box, and an unknown box is not reachable', async () => {
  const url = relay()
  const secret = 'owner-secret'
  const box = boxOf(secret)
  const post = (path: string, headers: Record<string, string> = {}, body = '{}') => fetch(`${url}/v1/${path}`, { method: 'POST', headers, body })
  expect((await post(`box/${box}`)).status).toBe(404)
  expect((await post(`inbox/${box}`, { authorization: 'Bearer someone-else' })).status).toBe(403)
  expect((await post(`inbox/${box}`, { authorization: `Bearer ${secret}` })).status).toBe(200)
  // 주인이 우편함을 열었으면 보낸 요청은 주인이 답할 때까지 기다린다.
  const sent = post(`box/${box}`, {}, '{"hello":1}')
  const taken = (await (await post(`inbox/${box}`, { authorization: `Bearer ${secret}` }, '{"wait":2000}')).json()) as { items: { id: string; body: string }[] }
  expect(taken.items).toEqual([{ id: expect.any(String), body: '{"hello":1}' }])
  await post(`reply/${box}`, { authorization: `Bearer ${secret}` }, JSON.stringify({ id: taken.items[0]!.id, status: 200, body: '{"ok":true}' }))
  const res = await sent
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
  expect(await (await fetch(`${url}/healthz`)).text()).toBe('coworker relay\n')
})

// 중계 서버 이미지는 relay/Dockerfile 이 골라 담은 파일만 갖는다. relay.ts 가 불러오는 파일이 하나라도 빠지면 켜자마자 죽는다.
test('the relay image carries every file relay.ts needs', async () => {
  const dockerfile = await Bun.file(new URL('../relay/Dockerfile', import.meta.url)).text()
  const ignore = await Bun.file(new URL('../relay/Dockerfile.dockerignore', import.meta.url)).text()
  const needed = new Set<string>()
  const queue = ['relay.ts']
  while (queue.length) {
    const file = queue.pop()!
    if (needed.has(file)) continue
    needed.add(file)
    const source = await Bun.file(new URL(`../src/${file}`, import.meta.url)).text()
    for (const [, name] of source.matchAll(/from '\.\/([\w-]+)'/g)) queue.push(`${name}.ts`)
  }
  for (const file of needed) {
    expect(dockerfile).toContain(`COPY src/${file} ./${file}`)
    expect(ignore.split(/\r?\n/)).toContain(`!src/${file}`)
  }
})

test('a sender is not left waiting forever when the owner answers with a bad status', async () => {
  const server = startRelay({ port: 0, hostname: '127.0.0.1', holdMs: 300 })
  servers.push(server)
  const base = `http://127.0.0.1:${server.port}/v1`
  const box = boxOf('owner-secret')
  const auth = { authorization: 'Bearer owner-secret' }
  expect((await fetch(`${base}/inbox/${box}`, { method: 'POST', headers: auth, body: '{}' })).status).toBe(200)
  const sent = fetch(`${base}/box/${box}`, { method: 'POST', body: '{"x":1}' })
  await Bun.sleep(50)
  const { items } = (await (await fetch(`${base}/inbox/${box}`, { method: 'POST', headers: auth, body: '{}' })).json()) as { items: { id: string }[] }
  expect(items).toHaveLength(1)
  await fetch(`${base}/reply/${box}`, { method: 'POST', headers: auth, body: JSON.stringify({ id: items[0]!.id, status: 1000, body: 'x' }) })
  expect((await sent).status).toBe(504)
})

test('both sides restart and still find each other through the relay, because each keeps its box', async () => {
  const { mkdtempSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'coworker-relay-'))
  const url = relay()
  const aSave = join(dir, 'a.json')
  const bSave = join(dir, 'b.json')
  const a = make('A · Claude Code', { relay: url, saveTo: aSave })
  const b = make('B · Codex', { relay: url, saveTo: bSave })
  a.open()
  expect(await a.relayReady(2000)).toBe('ok')
  await b.connect(a.newCode())
  await next(a, 'connected')
  const boxes = [a.addrs()[0], b.addrs()[0]]
  // 두 PC가 함께 꺼졌다가(예: 둘 다 재부팅) 다시 켜졌다. 어느 쪽도 상대의 새 주소를 알려 줄 수 없다.
  a.shutdown()
  b.shutdown()
  const opts = { relay: url, addrs: () => [] as string[], retryMs: 50, connectTimeoutMs: 500, pollWaitMs: 1000 }
  const a2 = Bridge.restore(JSON.parse(readFileSync(aSave, 'utf8')), { ...opts, ports: [17990, 17999], saveTo: aSave })
  const b2 = Bridge.restore(JSON.parse(readFileSync(bSave, 'utf8')), { ...opts, ports: [17980, 17989], saveTo: bSave })
  bridges.push(a2, b2)
  expect([a2.addrs()[0], b2.addrs()[0]]).toEqual(boxes)
  await a2.relayReady(2000)
  await b2.relayReady(2000)
  const { thread } = await b2.ask(undefined, 'still there after both restarted?')
  expect(await next(a2, 'message')).toMatchObject({ text: 'still there after both restarted?' })
  await a2.reply(thread, 'yes')
  expect(await next(b2, 'message')).toMatchObject({ kind: 'answer', text: 'yes' })
}, 20_000)

test('one sender cannot fill a mailbox: its waiting requests are capped, and another sender still gets in', async () => {
  const url = relay()
  const secret = 'owner-secret'
  const box = boxOf(secret)
  // 주인이 한 번 다녀가 우편함을 연다. 그 뒤로는 꺼내 가지 않아서 넣은 요청이 그대로 기다린다.
  await fetch(`${url}/v1/inbox/${box}`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: '{"wait":0}' })
  // 프록시 뒤에서는 보낸 쪽을 X-Forwarded-For 로 안다(이 시험의 연결은 루프백에서 온다).
  const put = (from: string) =>
    Promise.race([
      fetch(`${url}/v1/box/${box}`, { method: 'POST', headers: { 'x-forwarded-for': from }, body: '{}' }).then(r => r.status),
      Bun.sleep(700).then(() => 'waiting' as const),
    ])
  const flood: Promise<number | 'waiting'>[] = []
  for (let i = 0; i < 60; i++) {
    if (i % 20 === 0) await Bun.sleep(30)
    flood.push(put('203.0.113.5'))
  }
  const results = await Promise.all(flood)
  expect(results.filter(r => r === 'waiting').length).toBe(50)
  expect(results.filter(r => r === 503).length).toBe(10)
  // 다른 보낸 쪽의 요청은 받아서 기다리게 한다.
  expect(await put('203.0.113.9')).toBe('waiting')
  // 같은 보낸 쪽은 여전히 거절된다.
  expect(await put('203.0.113.5')).toBe(503)
})

// 본문을 늦게 보내는 보낸 쪽을 손으로 만든다. 요청 줄과 본문의 앞 절반만 보내 둔다.
// answers 에는 중계 서버가 돌려준 답의 첫 줄이, closed 에는 중계 서버가 끊은 연결의 수가 쌓인다.
function lateBodies(url: string, box: string, n: number) {
  const answers: string[] = []
  const state = { closed: 0 }
  const mine = Array.from({ length: n }, () => {
    const k = tcp(Number(new URL(url).port), '127.0.0.1')
    sockets.push(k)
    k.on('error', () => {})
    k.on('data', d => answers.push(String(d).split('\r\n')[0]!))
    k.on('close', () => state.closed++)
    k.write(`POST /v1/box/${box} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: text/plain\r\nContent-Length: 10\r\n\r\n12345`)
    return k
  })
  return { answers, state, finish: () => mine.forEach(k => k.write('67890')) }
}

async function until(ok: () => boolean | Promise<boolean>, ms: number) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await ok()) return true
    await Bun.sleep(25)
  }
  return false
}

function mailbox(url: string, secret: string) {
  const box = boxOf(secret)
  const take = async () => {
    const res = await fetch(`${url}/v1/inbox/${box}`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: '{"wait":0}' })
    return ((await res.json()) as { items: unknown[] }).items
  }
  return { box, take }
}

test('a request counts from the moment it arrives, also while its body is still on the way: late bodies do not pass the share of one sender', async () => {
  const url = relay()
  const { box, take } = mailbox(url, 'owner-of-late-bodies')
  await take()
  // 한 보낸 쪽이 요청 120개를 열어 두고 본문을 다 보내지 않는다. 그러다 한꺼번에 마저 보낸다.
  const late = lateBodies(url, box, 120)
  await Bun.sleep(300)
  late.finish()
  // 받아 준 것은 주인이 가져간다: 한 보낸 쪽의 몫인 50개다. 몫을 넘는 70개는 자리가 없다는 답을 받는다.
  const taken: unknown[] = []
  await until(async () => taken.push(...(await take())) >= 50, 5000)
  await until(() => late.answers.length >= 70, 5000)
  expect(taken.length).toBe(50)
  expect(late.answers.filter(a => a.includes(' 503 ')).length).toBe(70)
  expect(late.answers.length).toBe(70)
}, 20_000)

test('a request whose body does not arrive in time is dropped, and its place is free again', async () => {
  const server = startRelay({ port: 0, hostname: '127.0.0.1', holdMs: 30_000, bodyMs: 1000 })
  servers.push(server)
  const url = `http://127.0.0.1:${server.port}`
  const { box, take } = mailbox(url, 'owner-of-stalled-bodies')
  await take()
  // 한 보낸 쪽이 자기 몫만큼 요청을 열어 두고 본문을 끝내 보내지 않는다.
  const stalled = lateBodies(url, box, 50)
  // 중계 서버가 그 연결을 끊는다. 끊는 시각은 몇 초 단위로만 맞는다.
  expect(await until(() => stalled.state.closed >= 50, 15_000)).toBe(true)
  expect((await take()).length).toBe(0)
  // 자리가 다시 났다: 같은 보낸 쪽의 온전한 요청을 받는다.
  void fetch(`${url}/v1/box/${box}`, { method: 'POST', body: '{}' }).catch(() => {})
  expect(await until(async () => (await take()).length === 1, 3000)).toBe(true)
}, 30_000)

