import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect as tcp } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bridge } from '../src/bridge'
import { PAGE } from '../src/page'
import { Viewer } from '../src/viewer'

// 대화 보기 주소 설정(COWORKER_VIEWER_ADDRESS). 이 PC의 주인이 자기 다른 기기에서 이 PC에 닿는 주소(예: VPN 주소)를 정하면
// 대화 보기 화면이 127.0.0.1 과 그 주소에서 함께 열린다.
// 시험에는 둘째 주소가 필요하다. macOS 는 127.0.0.2 를 기본으로 두지 않아서, 어디에나 있는 IPv6 루프백 ::1 을 「정한 주소」로 쓴다.
const SECOND = '::1'
const root = join(import.meta.dir, '..')
const opened: Bridge[] = []
const viewers: Viewer[] = []
const servers: { stop: (now?: boolean) => void }[] = []
const clients: Client[] = []
const temps: string[] = []
let nextPort = 18900

function make(name = 'A · Claude Code') {
  const start = nextPort
  nextPort += 10
  const b = new Bridge({ name, ports: [start, start + 9], addrs: () => ['127.0.0.1'], retryMs: 50, connectTimeoutMs: 500 })
  opened.push(b)
  return b
}

type Outside = { set: string; available: boolean; link?: string; problem?: string }
type Extra = { address?: string; interfaces?: () => ReturnType<typeof networkInterfaces> }

// 설정을 준 대화 보기. 쓰던 포트에 다른 프로그램이 답하는지 먼저 본 뒤에 연다.
async function view(bridge: Bridge, extra: Extra = {}) {
  const viewer = new Viewer(bridge, extra as never)
  viewers.push(viewer)
  await (viewer as unknown as { ready?: () => Promise<void> }).ready?.()
  const url = viewer.start()
  const outside = () => (viewer as unknown as { outside?: () => Outside | undefined }).outside?.()
  const moved = () => (viewer as unknown as { moved?: () => string | undefined }).moved?.()
  return { viewer, url, moved, port: Number(new URL(viewer.listenCommand('darwin').split(' ').pop()!).port), token: url.split('/').pop()!, outside }
}

const PAGE_HEADERS = { 'x-coworker-viewer': '1' }
const post = (url: string, headers: Record<string, string>, body?: unknown) =>
  fetch(url, { method: 'POST', headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
// 주소를 다듬지 않고 그대로 보낸다(fetch 는 겹친 빗금이나 점을 보내기 전에 고친다).
const rawStatus = (host: string, port: number, path: string) =>
  new Promise<number>((done, fail) => {
    const sock = tcp(port, host, () => sock.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`))
    let data = ''
    sock.on('data', d => (data += d))
    sock.on('end', () => done(Number(data.split(' ')[1])))
    sock.on('error', fail)
  })
const reaches = async (url: string) => {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1500) })).status
  } catch {
    return 'no answer'
  }
}
// 이 PC의 루프백이 아닌 IPv4 주소 하나. 없으면(네트워크가 꺼진 PC) 그 확인은 건너뛴다.
const lanAddress = () =>
  Object.values(networkInterfaces())
    .flat()
    .find(n => n && n.family === 'IPv4' && !n.internal)?.address

afterEach(() => {
  for (const v of viewers.splice(0)) v.stop()
  for (const s of servers.splice(0)) s.stop(true)
  for (const b of opened.splice(0)) b.shutdown()
})

afterAll(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('viewer address', () => {
  test('with the address set, the view answers on 127.0.0.1 and on that address at the same port, and nowhere else', async () => {
    const a = make()
    a.open()
    const { url, port, token, outside } = await view(a, { address: SECOND })

    expect(url).toBe(`http://[::1]:${port}/${token}`)
    expect(await reaches(`http://127.0.0.1:${port}/${token}`)).toBe(200)
    expect(await reaches(`http://[::1]:${port}/${token}`)).toBe(200)
    expect(await reaches(`http://[::1]:${port}/${token}/data`)).toBe(200)
    expect(outside()).toMatchObject({ set: SECOND, available: true, link: url })

    const lan = lanAddress()
    if (lan) expect(await reaches(`http://${lan}:${port}/${token}`)).toBe('no answer')
  })

  test('an address that would mean every interface is refused, and the view stays on 127.0.0.1', async () => {
    for (const every of ['0.0.0.0', '::', '[::]', '0:0:0:0:0:0:0:0']) {
      const a = make()
      a.open()
      const { url, port, token, outside } = await view(a, { address: every })
      expect(url).toBe(`http://127.0.0.1:${port}/${token}`)
      expect(await reaches(url)).toBe(200)
      expect(outside()).toMatchObject({ set: every, available: false })
      expect(outside()?.problem).toContain('every')
      expect(await reaches(`http://[::1]:${port}/${token}`)).toBe('no answer')
      const lan = lanAddress()
      if (lan) expect(await reaches(`http://${lan}:${port}/${token}`)).toBe('no answer')
    }
  }, 40_000)

  test('when it cannot listen at the set address, the view keeps working on 127.0.0.1 and says the outside address is not available', async () => {
    // 이 PC에 없는 주소(문서용 주소 192.0.2.1).
    const a = make()
    a.open()
    const gone = await view(a, { address: '192.0.2.1' })
    expect(gone.url).toBe(`http://127.0.0.1:${gone.port}/${gone.token}`)
    expect(await reaches(gone.url)).toBe(200)
    expect(gone.outside()).toMatchObject({ set: '192.0.2.1', available: false })
    expect(gone.outside()?.problem).toContain('192.0.2.1')
    expect(gone.outside()?.problem).toContain(`http://127.0.0.1:${gone.port}/`)
    expect(gone.outside()?.link).toBeUndefined()

    // 열지 못한 까닭이 list_connections 의 문장에 그대로 들어 있다.
    expect(gone.outside()?.problem).toContain(`coworker could not listen on 192.0.2.1 port ${gone.port}`)
  })

  test('the view does not take over a port on which another program already answers: it moves to a fresh port and says the link changed', async () => {
    // 다른 프로그램이 모든 주소에서 듣는 포트를, 이 세션이 예전에 쓰던 포트로 기억하고 있다.
    for (const [every, address] of [['0.0.0.0', undefined], ['::', SECOND], ['0.0.0.0', SECOND]] as const) {
      const b = make('B · Codex')
      b.open()
      const blocker = Bun.serve({ hostname: every, port: 0, fetch: () => new Response('someone else') })
      servers.push(blocker)
      const busy = blocker.port!
      b.viewerAt = { port: busy, token: 'kept-token' }
      const got = await view(b, address ? { address } : {})
      expect(got.port).not.toBe(busy)
      expect(got.token).toBe('kept-token')
      expect(got.url).toBe(address ? `http://[::1]:${got.port}/kept-token` : `http://127.0.0.1:${got.port}/kept-token`)
      expect(got.moved()).toContain(`another program already answers on port ${busy}`)
      expect(got.moved()).toContain(got.url)
      // 그 프로그램은 제 손님을 그대로 받는다.
      expect(await (await fetch(`http://127.0.0.1:${busy}/kept-token`)).text()).toBe('someone else')
      expect(await reaches(got.url)).toBe(200)
      blocker.stop(true)
    }
    // 정한 주소에서만 다른 프로그램이 그 포트를 쓰고 있어도 옮긴다.
    const c = make('C · Codex')
    c.open()
    const blocker = Bun.serve({ hostname: SECOND, port: 0, fetch: () => new Response('someone else') })
    servers.push(blocker)
    c.viewerAt = { port: blocker.port!, token: 'kept-token' }
    const got = await view(c, { address: SECOND })
    expect(got.port).not.toBe(blocker.port!)
    expect(got.outside()).toMatchObject({ available: true, link: `http://[::1]:${got.port}/kept-token` })
    expect(await (await fetch(`http://[::1]:${blocker.port}/kept-token`)).text()).toBe('someone else')
    // 쓰던 포트가 비어 있으면 옮기지 않고, 링크가 바뀌었다는 말도 없다.
    const d = make('D · Codex')
    d.open()
    const free = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
    const was = free.port!
    free.stop(true)
    d.viewerAt = { port: was, token: 'kept-token' }
    const same = await view(d, { address: SECOND })
    expect(same.port).toBe(was)
    expect(same.moved()).toBeUndefined()
  }, 20_000)

  test('the word tailscale means this computer\'s own address in 100.64.0.0/10, and without one the view stays on 127.0.0.1', async () => {
    const nic = (address: string, internal = false) => ({ address, netmask: '255.255.255.0', family: 'IPv4' as const, mac: '00:00:00:00:00:00', internal, cidr: null })
    const a = make()
    a.open()
    const none = await view(a, { address: 'tailscale', interfaces: () => ({ en0: [nic('192.168.7.7')], lo0: [nic('127.0.0.1', true)], other: [nic('100.63.255.255'), nic('100.128.0.1')] }) })
    expect(none.url).toBe(`http://127.0.0.1:${none.port}/${none.token}`)
    expect(none.outside()).toMatchObject({ set: 'tailscale', available: false })
    expect(none.outside()?.problem).toContain('100.64.0.0/10')

    // 그 범위의 주소가 있으면 그것을 고른다. 이 시험 PC에는 그 주소가 없으니 열지는 못하고, 무엇을 골랐는지만 본다.
    const b = make('B · Codex')
    b.open()
    const found = await view(b, { address: 'Tailscale', interfaces: () => ({ en0: [nic('192.168.7.7')], utun9: [nic('100.127.255.254')] }) })
    expect(found.outside()).toMatchObject({ set: 'tailscale', available: false })
    expect(found.outside()?.problem).toContain('100.127.255.254')
    expect(await reaches(found.url)).toBe(200)

    // 그 범위의 주소가 둘이면 고르지 않는다. 주소를 적으라고 한다.
    const c = make('C · Codex')
    c.open()
    const two = await view(c, { address: 'tailscale', interfaces: () => ({ utun8: [nic('100.64.0.1')], utun9: [nic('100.127.255.254')] }) })
    expect(two.url).toStartWith('http://127.0.0.1:')
    expect(two.outside()).toMatchObject({ set: 'tailscale', available: false })
    expect(two.outside()?.problem).toContain('more than one address in 100.64.0.0/10')
    expect(two.outside()?.problem).toContain('write the address')
  }, 20_000)

  test('only an address written plainly is taken: a name is refused with a message that says to write the address', async () => {
    for (const name of ['my-desk.example', 'localhost', 'desk']) {
      const a = make()
      a.open()
      const named = await view(a, { address: name })
      expect(named.url).toBe(`http://127.0.0.1:${named.port}/${named.token}`)
      expect(named.outside()).toMatchObject({ available: false })
      expect(named.outside()?.problem).toContain('a name is not accepted')
      expect(named.outside()?.problem).toContain('write the address')
      expect((await post(`${named.url}/pin`, { ...PAGE_HEADERS, origin: `http://${name}:${named.port}` }, { threads: ['abcdef12'], pinned: true })).status).toBe(name === 'localhost' ? 200 : 403)
    }
    // 주소가 아닌 값, 줄여 쓰거나 다른 진법으로 쓴 주소, 컴퓨터 한 대의 주소일 수 없는 주소.
    const refused = ['http://192.0.2.1', '192.0.2.1:8080', 'a b', 'desk.example/path', '2130706433', '0x7f000001', '0x7f.0.0.1', '127.1', '0177.0.0.1', '192.0.2.01', '255.255.255.255', '224.0.0.1', '239.1.2.3', 'ff02::1', '::ffff:0.0.0.0', 'fe80::1%lo0']
    for (const bad of refused) {
      const c = make('C · Codex')
      c.open()
      const wrong = await view(c, { address: bad })
      expect(wrong.url).toStartWith('http://127.0.0.1:')
      expect(wrong.outside()).toMatchObject({ available: false })
      expect(wrong.outside()?.link).toBeUndefined()
    }
  }, 30_000)

  test('the page\'s requests are accepted from 127.0.0.1, localhost and the set address, and from nowhere else', async () => {
    const a = make()
    a.open()
    const { port, token } = await view(a, { address: SECOND })
    const local = `http://127.0.0.1:${port}/${token}`
    const allowed = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]
    const others = ['https://evil.example', `http://evil.example:${port}`, `http://[::1]:${port + 1}`, `https://[::1]:${port}`, `http://192.0.2.1:${port}`, `http://[::2]:${port}`, 'null']
    const body = { threads: ['abcdef12'], pinned: true }

    for (const base of [local, `http://[::1]:${port}/${token}`]) {
      for (const origin of allowed) {
        expect((await post(`${base}/pin`, { ...PAGE_HEADERS, origin, 'sec-fetch-site': 'same-origin' }, body)).status).toBe(200)
        expect((await post(`${local}/about`, { ...PAGE_HEADERS, origin }, { effort: 'high' })).status).toBe(200)
      }
      for (const origin of others) {
        expect((await post(`${base}/pin`, { ...PAGE_HEADERS, origin }, body)).status).toBe(403)
        expect((await post(`${local}/about`, { ...PAGE_HEADERS, origin }, { effort: 'high' })).status).toBe(403)
        expect((await post(`${base}/code`, { ...PAGE_HEADERS, origin })).status).toBe(403)
      }
      // 표시 헤더가 없거나, 브라우저가 다른 사이트에서 왔다고 알려 주면 주소가 맞아도 받지 않는다.
      expect((await post(`${base}/pin`, { origin: allowed[2]! }, body)).status).toBe(403)
      expect((await post(`${base}/pin`, { ...PAGE_HEADERS, origin: allowed[2]!, 'sec-fetch-site': 'cross-site' }, body)).status).toBe(403)
      expect((await post(`${base}/pin`, { ...PAGE_HEADERS, origin: allowed[2]!, 'sec-fetch-site': 'same-site' }, body)).status).toBe(403)
    }
    const made = await post(`http://[::1]:${port}/${token}/code`, { ...PAGE_HEADERS, origin: allowed[2]!, 'sec-fetch-site': 'same-origin' })
    expect(made.status).toBe(200)
    expect(((await made.json()) as { code: string }).code).toStartWith('cw1.')
  }, 20_000)

  test('the accepted origins follow where the view actually listens, not the setting', async () => {
    const a = make()
    a.open()
    const { url, port } = await view(a, { address: '192.0.2.1' })
    const body = { threads: ['abcdef12'], pinned: true }
    const refused = await post(`${url}/pin`, { ...PAGE_HEADERS, origin: `http://192.0.2.1:${port}` }, body)
    expect(refused.status).toBe(403)
    expect(((await refused.json()) as { open: string[] }).open).toEqual([`http://127.0.0.1:${port}`, `http://localhost:${port}`])
    expect((await post(`${url}/pin`, { ...PAGE_HEADERS, origin: `http://localhost:${port}` }, body)).status).toBe(200)
  })

  test('the listener at the set address serves only what a browser needs; what the session\'s helpers call answers on 127.0.0.1 only', async () => {
    const a = make()
    a.open()
    const { port, token } = await view(a, { address: SECOND })
    const outside = `http://[::1]:${port}/${token}`
    const local = `http://127.0.0.1:${port}/${token}`
    const origin = `http://[::1]:${port}`
    // 브라우저가 쓰는 것: 화면, 읽기, 접근키, 고정.
    expect(await reaches(outside)).toBe(200)
    expect(await reaches(`${outside}/data`)).toBe(200)
    const events = await fetch(`${outside}/events`)
    expect(events.status).toBe(200)
    await events.body?.cancel()
    expect((await post(`${outside}/pin`, { ...PAGE_HEADERS, origin }, { threads: ['abcdef12'], pinned: true })).status).toBe(200)
    expect((await post(`${outside}/code`, { ...PAGE_HEADERS, origin })).status).toBe(200)
    // 이 PC 안의 도우미가 쓰는 것: 요약, 다음 소식 기다리기, 깨우기, 소개. 정한 주소에서는 없는 주소다.
    expect(await reaches(`${outside}/status`)).toBe(404)
    expect(await reaches(`${outside}/next`)).toBe(404)
    expect(await reaches(`${outside}/wake`)).toBe(404)
    expect((await post(`${outside}/about`, { ...PAGE_HEADERS, origin }, { effort: 'high' })).status).toBe(404)
    expect(await reaches(`${local}/status`)).toBe(200)
    expect((await post(`${local}/about`, { ...PAGE_HEADERS, origin }, { effort: 'high' })).status).toBe(200)
  }, 20_000)

  test('without the setting nothing changes: 127.0.0.1 only, the same links, and the set-address origin is refused', async () => {
    const a = make()
    a.open()
    const { viewer, url, port, token, outside } = await view(a)
    expect(url).toBe(`http://127.0.0.1:${port}/${token}`)
    expect(outside()).toBeUndefined()
    expect(await reaches(`http://[::1]:${port}/${token}`)).toBe('no answer')
    expect('link' in viewer.status()).toBe(false)
    expect((await post(`${url}/pin`, { ...PAGE_HEADERS, origin: `http://[::1]:${port}` }, { threads: ['abcdef12'], pinned: true })).status).toBe(403)
    expect((await post(`${url}/pin`, { ...PAGE_HEADERS, origin: `http://localhost:${port}` }, { threads: ['abcdef12'], pinned: true })).status).toBe(200)
  })

  test('without the token in the path nothing answers, on either address', async () => {
    const a = make()
    a.open()
    const { port, token } = await view(a, { address: SECOND })
    for (const host of ['127.0.0.1', '[::1]']) {
      const base = `http://${host}:${port}`
      for (const path of ['', '/', '/data', '/status', '/events', '/next', '/wake', '/wrong-token', '/wrong-token/data', `/${token.slice(0, -1)}`, `/${token}x/data`, `/x/${token}`]) expect(await reaches(`${base}${path}`)).toBe(404)
      for (const path of ['/code', '/wrong-token/code', '/wrong-token/pin', '/wrong-token/about']) expect((await post(`${base}${path}`, { ...PAGE_HEADERS, origin: base })).status).toBe(404)
      expect(await reaches(`${base}/${token}/data`)).toBe(200)
    }
    // 정확히 그 꼴의 주소에만 답한다: 겹친 빗금, 끝의 빗금, 바꿔 적은 글자, 물음표 뒤 값에는 답하지 않는다.
    // 점으로 된 마디(/./, /../, %2e)는 Bun 이 서버에 넘기기 전에 풀어 버려서 서버가 보지 못한다. 풀린 주소에도 토큰이 있어야 답한다.
    for (const host of ['127.0.0.1', '::1']) {
      expect(await rawStatus(host, port, `/${token}`)).toBe(200)
      expect(await rawStatus(host, port, `/${token}/data`)).toBe(200)
      const coded = `%${token.charCodeAt(0).toString(16)}${token.slice(1)}`
      for (const path of [`//${token}`, `/${token}/`, `/${token}//data`, `/${coded}`, `/${token}/dat%61`, `/${token}?x`, `/${token}/data/`, `/${token}/../${token}x`])
        expect([path, await rawStatus(host, port, path)]).toEqual([path, 404])
    }
  }, 20_000)

  test('the links for the human use the set address; what this computer calls itself stays on 127.0.0.1', async () => {
    const a = make()
    a.open()
    const { viewer, url, port, token } = await view(a, { address: SECOND })
    expect(viewer.url).toBe(url)
    expect((viewer.status() as { link?: string }).link).toBe(`http://[::1]:${port}/${token}`)
    expect(viewer.listenCommand('darwin')).toBe(`curl -s http://127.0.0.1:${port}/${token}/next`)
    expect(viewer.listenCommand('win32')).toBe(`curl.exe -s http://127.0.0.1:${port}/${token}/next`)
    // 채팅창 위 띠는 요약이 알려 주는 링크를 쓴다.
    const band = readFileSync(join(root, 'plugin', 'claude', 'band.tsx'), 'utf8')
    expect(band).toContain('s?.link')
  })

  test('a refused request says it is about where the page was opened and where to open it instead; other refusals say their own reason', async () => {
    const a = make()
    a.open()
    const { port, token } = await view(a, { address: SECOND })
    const local = `http://127.0.0.1:${port}/${token}`
    const where = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]

    for (const [path, body] of [['code', undefined], ['pin', { threads: ['abcdef12'], pinned: true }], ['about', { effort: 'high' }]] as const) {
      const res = await post(`${local}/${path}`, { ...PAGE_HEADERS, origin: `http://192.0.2.1:${port}` }, body)
      expect(res.status).toBe(403)
      expect((await res.json().catch(() => null)) as unknown).toEqual({ error: 'opened at an address this view does not accept', opened: `http://192.0.2.1:${port}`, open: where })
    }
    // 화면에서 온 요청이 아니면 어디로 열라는 말을 하지 않는다.
    expect(await (await post(`${local}/code`, { origin: `http://192.0.2.1:${port}` })).text()).toBe('forbidden')

    expect((await post(`${local}/code`, { ...PAGE_HEADERS, origin: where[2]! })).status).toBe(200)
    const soon = await post(`${local}/code`, { ...PAGE_HEADERS, origin: where[2]! })
    expect([soon.status, await soon.json()]).toEqual([429, { error: 'too many requests' }])
    await a.close()
    const closed = await post(`${local}/code`, { ...PAGE_HEADERS, origin: where[2]! })
    expect([closed.status, await closed.json()]).toEqual([409, { error: 'the bridge is closed' }])

    // 화면의 글: 까닭마다 다른 말을 하고, 세션이 답했는데 세션을 탓하는 옛 글은 없다.
    for (const text of [
      '이 화면을 연 주소(',
      '이 주소로 다시 여세요: ',
      '브릿지가 닫혀 있어서 만들 수 없습니다. AI에게 「브릿지 열어줘」라고 하세요.',
      '잠시 뒤에 다시 눌러 주세요.',
      '세션에 닿지 않습니다. 세션이 켜져 있는지 확인하세요.',
      '세션이 이 요청을 받지 않았습니다(응답 ',
      '접근키를 만들 수 없습니다',
      '고정을 바꿀 수 없습니다',
    ])
      expect(PAGE).toContain(text)
    expect(PAGE).not.toContain('접근키를 만들지 못했습니다. 세션이 켜져 있는지 확인하세요.')

    // 화면이 답을 사람의 말로 바꾸는 함수를 화면 글에서 꺼내 그대로 돌려 본다.
    const source = PAGE.match(/const UNREACHED = [\s\S]*?\n}\n/)?.[0]
    expect(source).toBeDefined()
    const { whyNot } = new Function('location', `${source}; return { whyNot }`)({ origin: `http://192.0.2.1:${port}`, pathname: `/${token}` }) as { whyNot: (res: Response, cannot: string) => Promise<string> }
    const said = await whyNot(Response.json({ error: 'x', opened: 'y', open: where }, { status: 403 }), '접근키를 만들 수 없습니다')
    expect(said).toBe(`이 화면을 연 주소(http://192.0.2.1:${port})로는 접근키를 만들 수 없습니다. 이 주소로 다시 여세요: ${where.map(o => `${o}/${token}`).join(' 또는 ')}`)
    expect(await whyNot(new Response('forbidden', { status: 403 }), '고정을 바꿀 수 없습니다')).toBe('세션이 이 요청을 받지 않았습니다(응답 403).')
    expect(await whyNot(Response.json({ error: 'the bridge is closed' }, { status: 409 }), 'x')).toContain('브릿지가 닫혀 있어서')
    expect(await whyNot(Response.json({ error: 'too many requests' }, { status: 429 }), 'x')).toBe('잠시 뒤에 다시 눌러 주세요.')
    expect(await whyNot(new Response('bad', { status: 400 }), 'x')).toBe('세션이 이 요청을 받지 않았습니다(응답 400).')
    expect(PAGE).not.toContain('고정을 바꾸지 못했습니다. 세션이 켜져 있는지 확인하세요.')
  })
})

describe('the link is a secret', () => {
  test('outgoing text that holds this session\'s view token is refused, and the refusal says why', async () => {
    const home = mkdtempSync(join(tmpdir(), 'coworker-viewer-link-home-'))
    temps.push(home)
    const a = new Bridge({ name: 'A · Claude Code', ports: [nextPort, (nextPort += 10) - 1], addrs: () => ['127.0.0.1'], retryMs: 50, connectTimeoutMs: 500, home } as never)
    opened.push(a)
    const b = make('B · Codex')
    a.open()
    await b.connect(a.newCode())
    const { url, token } = await view(a, { address: SECOND })
    const local = `http://127.0.0.1:${a.viewerAt!.port}/${token}`
    const why = 'conversation view link'
    for (const text of [url, local, `see ${token} there`]) {
      await expect(a.ask(undefined, `Look at ${text}`)).rejects.toThrow(why)
      await expect(a.ask(undefined, 'Look.', `background: ${text}`)).rejects.toThrow(why)
    }
    expect(a.threads.size).toBe(0)
    const asked = await a.ask(undefined, 'A plain question.')
    await expect(a.reply(asked.thread, `it is at ${url}`)).rejects.toThrow(why)
    await expect(a.hold(asked.thread, `my human reads ${url}`)).rejects.toThrow(why)
    await expect(a.agree(asked.thread, { conclusion: `read ${url}`, facts: [] } as never)).rejects.toThrow(why)
    await expect(a.agree(asked.thread, { conclusion: 'done', facts: [{ fact: 'the page', evidence: url }] } as never)).rejects.toThrow(why)
    expect(() => a.setAbout({ model: token })).toThrow(why)
    expect(a.describe().about?.model).not.toBe(token)

    const dir = mkdtempSync(join(tmpdir(), 'coworker-viewer-link-'))
    temps.push(dir)
    const note = join(dir, 'note.md')
    writeFileSync(note, `# where to look\n\n${url}\n`)
    await expect(a.ask(undefined, 'See the file.', undefined, [note])).rejects.toThrow(why)
    const named = join(dir, `${token}.md`)
    writeFileSync(named, 'nothing inside')
    await expect(a.ask(undefined, 'See the file.', undefined, [named])).rejects.toThrow(why)
    // 토큰이 없는 글과 파일은 그대로 간다. 상대의 토큰은 이 세션의 비밀이 아니다.
    writeFileSync(note, '# where to look\n\nhttp://127.0.0.1:1/some-other-token\n')
    expect((await a.ask(undefined, 'See the file at http://127.0.0.1:1/some-other-token', undefined, [note])).thread).toBeString()
    // 대화 보기를 연 적이 없는 세션에는 막을 토큰이 없다.
    expect((await b.ask(undefined, `B has no view yet: ${token}`)).thread).toBeString()
  }, 20_000)
})

describe('viewer address in a session', () => {
  async function session(env: Record<string, string>) {
    const home = mkdtempSync(join(tmpdir(), 'coworker-viewer-address-'))
    temps.push(home)
    const client = new Client({ name: 'claude-code', version: '1.0.0' })
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(root, 'src', 'mcp.ts')],
        env: { ...process.env, COWORKER_HOME: home, COWORKER_CHANNEL: 'off', CLAUDE_CODE_SESSION_ID: '', COWORKER_AUTO_UPDATE: 'off', COWORKER_NOTIFY: 'off', COWORKER_RELAY: '', COWORKER_RELAY_KEY: '', COWORKER_PORTS: '18990-18999', COWORKER_VIEWER_ADDRESS: '', ...env } as Record<string, string>,
        stderr: 'ignore',
      }),
    )
    clients.push(client)
    return async (name: string, args: Record<string, unknown> = {}) => {
      const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] }
      if (res.isError) throw new Error(res.content[0]?.text)
      return JSON.parse(res.content[0]!.text) as Record<string, any>
    }
  }

  test('the tools give the human a link at the set address, and list_connections says in plain words when that address is not available', async () => {
    const call = await session({ COWORKER_VIEWER_ADDRESS: SECOND })
    const open = await call('open_bridge')
    expect(open.viewer).toStartWith('http://[::1]:')
    expect(open.next).toContain(open.viewer)
    // 사람에게 줄 링크는 정한 주소다. 이 PC 안에서 AI가 돌리는 기다리는 명령만 127.0.0.1 을 쓴다.
    expect(open.next.replace(/curl(\.exe)? -s \S+/g, '')).not.toContain('http://127.0.0.1')
    expect(open.listen_command).toMatch(/^curl(\.exe)? -s http:\/\/127\.0\.0\.1:/)
    expect(open.next).toContain('make an access key and pin a conversation')
    expect(open.next).toContain('never send it to another session')
    expect(await reaches(open.viewer)).toBe(200)
    const listed = await call('list_connections')
    expect(listed.viewer).toBe(open.viewer)
    expect(listed.viewer_address).toEqual({ set: SECOND, available: true, link: open.viewer })

    const away = await session({ COWORKER_VIEWER_ADDRESS: '192.0.2.1' })
    const opened = await away('open_bridge')
    expect(opened.viewer).toStartWith('http://127.0.0.1:')
    expect(opened.next).toContain('192.0.2.1')
    const state = (await away('list_connections')).viewer_address
    expect(state).toMatchObject({ set: '192.0.2.1', available: false })
    expect(state.problem).toContain('cannot be opened at 192.0.2.1')
    expect(state.problem).toContain(opened.viewer)
  }, 20_000)

  test('without the setting the tools answer exactly as before', async () => {
    const call = await session({})
    const open = await call('open_bridge')
    expect(open.viewer).toStartWith('http://127.0.0.1:')
    expect(open.next).toContain(`It opens, in a browser on this PC, every question and answer of this session, with whom and when, and updates by itself; the link stays the same when this session restarts: ${open.viewer}`)
    const listed = await call('list_connections')
    expect(listed.viewer).toBe(open.viewer)
    expect('viewer_address' in listed).toBe(false)
  }, 20_000)
})

describe('viewer address in the plugin settings', () => {
  test('it is set the way the relay address is: an environment variable and a plugin option', () => {
    const claude = JSON.parse(readFileSync(join(root, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8'))
    expect(claude.mcpServers.coworker.env.COWORKER_VIEWER_ADDRESS).toBe('${user_config.viewer_address}')
    expect(claude.userConfig.viewer_address).toMatchObject({ type: 'string', default: '' })
    const codex = JSON.parse(readFileSync(join(root, 'plugin', '.codex-plugin', 'plugin.json'), 'utf8'))
    expect(codex.mcpServers.coworker.env_vars).toContain('COWORKER_VIEWER_ADDRESS')
  })
})
