import { afterEach, expect, test } from 'bun:test'
import type { Server } from 'bun'
import { Bridge, type BridgeEvent } from '../src/bridge'
import { boxOf, startRelay } from '../src/relay'

// 서로 바로 닿지 않는 두 PC를 흉내 낸다. 각자 주소를 하나도 내놓지 않아서 중계 서버로만 닿는다.
const servers: Server<undefined>[] = []
const bridges: Bridge[] = []
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
