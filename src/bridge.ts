import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Server } from 'bun'
import { decodeCode, encodeCode } from './code'
import { fromB64, newKeyPair, open, randomToken, seal, toB64, type KeyPair } from './crypto'
import { hostForUrl, localAddresses } from './net'

// 사내 방화벽에 열어 달라고 요청하기 쉽게 정해 둔 범위.
export const DEFAULT_PORTS: [number, number] = [7700, 7799]
// 대화 하나에 주고받는 메시지 상한. 왕복 6번.
export const MAX_MESSAGES_PER_THREAD = 12

// 주소마다 다른 프로그램이 같은 포트로 떠 있을 수 있다. 받는 쪽 키로 만든 경로로 보내서,
// 엉뚱한 곳(예: 같은 포트를 쓰는 이 PC의 다른 브릿지)이 답하면 「여기 아님」으로 알 수 있게 한다.
export const routeId = (key: string) => Buffer.from(key, 'base64').toString('base64url').slice(0, 16)
const isLoopback = (addr: string) => addr.startsWith('127.') || addr === '::1' || addr === 'localhost'

// directFailed: 이쪽에서 상대로 바로 보내지 못했다. lastPollAt: 상대가 메시지를 가져가려고 마지막으로 접속한 때.
export type Peer = { key: string; name: string; addrs: string[]; port: number; lastAddr?: string; directFailed?: boolean; lastPollAt?: number }

// checking_with_your_human: 결정이 필요해 이쪽 사람에게 묻는 중. peer_checking_with_their_human: 상대가 자기 사람에게 묻는 중.
export type ThreadStatus = 'waiting_for_peer' | 'your_turn' | 'checking_with_your_human' | 'peer_checking_with_their_human' | 'needs_human'

// note 는 「사람에게 확인 중」 같은 알림이다. 왕복 횟수에 세지 않는다.
export type MessageKind = 'question' | 'answer' | 'note'

export type ThreadMessage = {
  id: string
  from: 'me' | 'peer'
  kind: MessageKind
  text: string
  context?: string
  at: string
}

// peerAddr: 대화가 시작될 때 상대에게 닿던 주소. 사람이 「어디와」 주고받았는지 볼 수 있게 남긴다.
export type Thread = {
  id: string
  peer: string
  peerName: string
  peerAddr?: string
  subject: string
  startedBy: 'me' | 'peer'
  status: ThreadStatus
  messages: ThreadMessage[]
}

export type BridgeEvent =
  | { type: 'connected'; peer: string; at: string }
  | { type: 'message'; thread: string; from: string; kind: MessageKind; text: string; context?: string; status: ThreadStatus; at: string }
  | { type: 'peer_closed'; peer: string; at: string }
  | { type: 'undelivered'; to: string; thread?: string; reason: string; at: string }

type WireMessage = { id: string; thread: string; subject?: string; kind: MessageKind; text: string; context?: string; at: string }

type Payload =
  | { type: 'hello'; token: string; name: string; addrs: string[]; port: number }
  | { type: 'hello_ack'; name: string }
  | { type: 'msg'; msg: WireMessage }
  | { type: 'ok' }
  | { type: 'ping' }
  | { type: 'pong' }
  | { type: 'bye' }
  | { type: 'poll'; wait: number; ack?: string[] }
  | { type: 'batch'; items: { id: string; payload: Payload }[] }

// 상대가 가져간 뒤 「받았다」고 알려 와야 줄에서 지운다. 가져가던 연결이 끊겨도 다음에 다시 넘긴다.
type Outgoing = { id: string; peer: string; payload: Payload; thread?: string; since: number }

class DeliveryError extends Error {
  constructor(readonly reason: 'unreachable' | 'rejected', message: string) {
    super(message)
  }
}

export type BridgeOptions = {
  name: string
  ports?: [number, number]
  home?: string
  addrs?: () => string[]
  retryMs?: number
  expireMs?: number
  tokenTtlMs?: number
  connectTimeoutMs?: number
  pollWaitMs?: number
}

const now = () => new Date().toISOString()
// 상대가 이 시간 안에 가져가러 왔으면, 상대는 이쪽 메시지를 스스로 가져가는 중이다.
const POLL_FRESH_MS = 60_000
const firstLine = (text: string) => text.trim().split('\n')[0]!.slice(0, 80)
const counted = (t: Thread) => t.messages.filter(m => m.kind !== 'note').length
const whereIs = (p: Peer) => {
  const addr = p.lastAddr ?? p.addrs[0]
  return addr ? `${hostForUrl(addr)}:${p.port}` : undefined
}

export class Bridge {
  readonly keys: KeyPair = newKeyPair()
  readonly key = toB64(this.keys.publicKey)
  private readonly route = routeId(this.key)
  name: string
  port = 0
  readonly peers = new Map<string, Peer>()
  readonly threads = new Map<string, Thread>()

  private server?: Server<undefined>
  private timer?: ReturnType<typeof setInterval>
  private tokens = new Map<string, number>()
  private seen = new Set<string>()
  private outbox: Outgoing[] = []
  private events: BridgeEvent[] = []
  private waiters: Array<() => void> = []
  private waiting = 0
  private flushing = false
  private lastCode?: string
  private polling = new Set<string>()
  private pollWaiters = new Map<string, Set<() => void>>()
  private abort = new AbortController()
  private readonly opts: Required<Omit<BridgeOptions, 'home'>> & { home?: string }

  constructor(options: BridgeOptions) {
    this.name = options.name
    this.opts = {
      ports: DEFAULT_PORTS,
      addrs: localAddresses,
      retryMs: 3000,
      expireMs: 30 * 60_000,
      tokenTtlMs: 60 * 60_000,
      connectTimeoutMs: 2000,
      pollWaitMs: 20_000,
      ...options,
    }
  }

  get isOpen() {
    return !!this.server
  }

  addrs() {
    return this.opts.addrs()
  }

  // 포트를 열고 받기 시작한다. 포트를 지정하지 않으면 정해 둔 범위에서 비어 있는 번호를 쓴다.
  open(port?: number) {
    if (this.server) {
      if (port && port !== this.port) throw new Error(`bridge is already open on port ${this.port}`)
      return
    }
    if (port) {
      if (!this.listen(port)) throw new Error(`port ${port} is already in use; pick another port or leave it empty`)
    } else {
      const [min, max] = this.opts.ports
      for (let p = min; p <= max && !this.server; p++) this.listen(p)
      if (!this.server) throw new Error(`no free port between ${min} and ${max}`)
    }
    this.abort = new AbortController()
    this.timer = setInterval(() => void this.flush(), this.opts.retryMs)
    this.timer.unref?.()
    this.writeState()
  }

  // 새 연결 코드. 코드마다 토큰이 달라서 한 코드로는 한 세션만 연결할 수 있다.
  newCode(): string {
    if (!this.server) this.open()
    const token = randomToken()
    this.tokens.set(token, Date.now() + this.opts.tokenTtlMs)
    this.lastCode = encodeCode({ v: 1, name: this.name, addrs: this.addrs(), port: this.port, key: this.key, token })
    this.writeState()
    return this.lastCode
  }

  async connect(codeText: string): Promise<Peer> {
    const code = decodeCode(codeText)
    if (code.key === this.key) throw new Error('that is this session\'s own code; give it to your coworker instead')
    if (!this.server) this.open()
    const peer: Peer = { key: code.key, name: code.name, addrs: code.addrs, port: code.port }
    let reply: Payload
    try {
      reply = await this.deliver(peer, { type: 'hello', token: code.token, name: this.name, addrs: this.addrs(), port: this.port })
    } catch (e) {
      if (e instanceof DeliveryError && e.reason === 'rejected')
        throw new Error('the other session refused this code; it was already used, expired, or that bridge was reopened. Ask for a new code')
      throw new Error(`cannot reach ${code.name} at ${code.addrs.join(', ')} port ${code.port}. Check that its bridge is open and that the network or VPN lets the two PCs talk`)
    }
    if (reply.type !== 'hello_ack') throw new Error('unexpected answer from the other session')
    peer.name = reply.name
    this.peers.set(peer.key, peer)
    void this.pollLoop(peer.key)
    return peer
  }

  async ask(to: string | undefined, question: string, context?: string) {
    const peer = this.resolvePeer(to)
    const thread: Thread = {
      id: randomUUID().slice(0, 8),
      peer: peer.key,
      peerName: peer.name,
      peerAddr: whereIs(peer),
      subject: firstLine(question),
      startedBy: 'me',
      status: 'waiting_for_peer',
      messages: [],
    }
    this.threads.set(thread.id, thread)
    const msg: WireMessage = { id: randomUUID(), thread: thread.id, subject: thread.subject, kind: 'question', text: question, context, at: now() }
    thread.messages.push({ id: msg.id, from: 'me', kind: msg.kind, text: msg.text, context: msg.context, at: msg.at })
    const delivery = await this.sendOrQueue(peer, { type: 'msg', msg }, thread.id)
    return { thread: thread.id, to: peer.name, delivery }
  }

  async reply(threadId: string, text: string) {
    const thread = this.threads.get(threadId)
    if (!thread) throw new Error(`no conversation with id ${threadId}`)
    if (thread.status === 'needs_human')
      throw new Error(`this conversation reached ${MAX_MESSAGES_PER_THREAD} messages; stop and let the humans decide`)
    const peer = this.peers.get(thread.peer)
    if (!peer) throw new Error(`${thread.peerName} is no longer connected`)
    const msg: WireMessage = { id: randomUUID(), thread: thread.id, kind: 'answer', text, at: now() }
    thread.messages.push({ id: msg.id, from: 'me', kind: msg.kind, text, at: msg.at })
    thread.status = counted(thread) >= MAX_MESSAGES_PER_THREAD ? 'needs_human' : 'waiting_for_peer'
    const delivery = await this.sendOrQueue(peer, { type: 'msg', msg }, thread.id)
    return { thread: thread.id, to: peer.name, delivery, status: thread.status }
  }

  // 결정이 필요해 이쪽 사람에게 묻는 동안, 상대가 막연히 기다리지 않게 알린다.
  async hold(threadId: string, note: string) {
    const thread = this.threads.get(threadId)
    if (!thread) throw new Error(`no conversation with id ${threadId}`)
    const peer = this.peers.get(thread.peer)
    if (!peer) throw new Error(`${thread.peerName} is no longer connected`)
    const msg: WireMessage = { id: randomUUID(), thread: thread.id, kind: 'note', text: note, at: now() }
    thread.messages.push({ id: msg.id, from: 'me', kind: 'note', text: note, at: msg.at })
    thread.status = 'checking_with_your_human'
    const delivery = await this.sendOrQueue(peer, { type: 'msg', msg }, thread.id)
    return { thread: thread.id, to: peer.name, delivery, status: thread.status }
  }

  // 새 소식이 올 때까지 기다린다. 이미 쌓여 있으면 바로 돌려준다.
  // 기다림은 마지막 하나만 산다. 사람이 끊었거나 아무도 결과를 읽지 않는 기다림이 소식을 가져가면
  // 그 소식은 사라진다. 그래서 새 기다림이 시작되거나 호출이 취소되면 앞의 기다림은 빈손으로 끝난다.
  async wait(timeoutMs: number, signal?: AbortSignal): Promise<BridgeEvent[]> {
    if (timeoutMs <= 0) return this.events.splice(0)
    const turn = ++this.waiting
    for (const wake of [...this.waiters]) wake()
    const live = () => turn === this.waiting && !signal?.aborted
    const deadline = Date.now() + timeoutMs
    while (this.events.length === 0 && live() && Date.now() < deadline) {
      await new Promise<void>(resolve => {
        const done = () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', done)
          this.waiters = this.waiters.filter(w => w !== done)
          resolve()
        }
        // 정한 시간 없이 기다릴 때는 타이머를 걸지 않는다(setTimeout 은 너무 큰 값을 1ms 로 바꾼다).
        const timer = Number.isFinite(deadline) ? setTimeout(done, deadline - Date.now()) : undefined
        signal?.addEventListener('abort', done)
        this.waiters.push(done)
      })
    }
    return live() ? this.events.splice(0) : []
  }

  async connections() {
    const peers = await Promise.all(
      [...this.peers.values()].map(async peer => {
        let direct = false
        try {
          direct = (await this.deliver(peer, { type: 'ping' })).type === 'pong'
        } catch {}
        const pulling = this.isPulling(peer)
        return {
          name: peer.name,
          reachable: direct || pulling,
          via: direct
            ? `${peer.lastAddr}:${peer.port}`
            : pulling
              ? 'the other side cannot be reached directly, so it comes here to pick up messages'
              : undefined,
          queued: this.outbox.filter(o => o.peer === peer.key).length,
        }
      }),
    )
    return { me: this.describe(), peers }
  }

  threadSummaries() {
    return [...this.threads.values()].map(t => {
      const last = t.messages.at(-1)
      return {
        id: t.id,
        with: t.peerName,
        subject: t.subject,
        status: t.status,
        messages: counted(t),
        last: last && { from: last.from, kind: last.kind, text: last.text.slice(0, 200) },
      }
    })
  }

  describe() {
    return { name: this.name, open: this.isOpen, port: this.port || undefined, addrs: this.isOpen ? this.addrs() : undefined }
  }

  // 연결된 세션에 끝났다고 알리고 포트를 닫는다.
  async close() {
    if (!this.server) return
    await Promise.all(
      [...this.peers.values()].map(async p => {
        try {
          await this.deliver(p, { type: 'bye' })
        } catch {
          if (this.isPulling(p)) await this.handOver(p, { type: 'bye' }, 2000)
        }
      }),
    )
    this.shutdown()
  }

  // 알리지 않고 바로 닫는다. 프로세스가 끝날 때 쓴다.
  shutdown() {
    this.abort.abort()
    for (const wakers of this.pollWaiters.values()) for (const wake of [...wakers]) wake()
    clearInterval(this.timer)
    this.server?.stop(true)
    this.server = undefined
    this.removeState()
    this.peers.clear()
    this.tokens.clear()
    this.outbox = []
  }

  private listen(port: number): boolean {
    try {
      this.server = Bun.serve({
        port,
        hostname: '0.0.0.0',
        maxRequestBodySize: 1 << 20,
        idleTimeout: 60,
        fetch: (req, server) => this.handle(req, server),
      })
      this.port = port
      return true
    } catch {
      return false
    }
  }

  private async handle(req: Request, server: Server<undefined>): Promise<Response> {
    if (req.method !== 'POST' || new URL(req.url).pathname !== `/v1/${this.route}`) return new Response('not found', { status: 404 })
    const sealed = await req.json().catch(() => null)
    const payload = open(sealed, this.keys) as Payload | null
    if (!payload) return new Response('forbidden', { status: 403 })
    const from = (sealed as { from: string }).from
    const answer = (p: Payload) => Response.json(seal(p, fromB64(from), this.keys))

    const peer = this.peers.get(from)
    if (!peer) {
      if (payload.type !== 'hello' || !this.takeToken(payload.token)) return new Response('forbidden', { status: 403 })
      const seenAt = server.requestIP(req)?.address.replace(/^::ffff:/, '')
      // 다른 PC에서 왔으면 상대가 적어 보낸 127.0.0.1 은 이 PC를 가리키므로 뺀다.
      const remote = !!seenAt && !isLoopback(seenAt)
      const given = remote ? payload.addrs.filter(a => !isLoopback(a)) : payload.addrs
      const addrs = [...new Set([...(seenAt ? [seenAt] : []), ...given])]
      this.peers.set(from, { key: from, name: payload.name, addrs, port: payload.port })
      this.emit({ type: 'connected', peer: payload.name, at: now() })
      void this.pollLoop(from)
      return answer({ type: 'hello_ack', name: this.name })
    }

    if (payload.type === 'poll') {
      peer.lastPollAt = Date.now()
      const acked = new Set(Array.isArray(payload.ack) ? payload.ack : [])
      if (acked.size) this.outbox = this.outbox.filter(o => !(o.peer === peer.key && acked.has(o.id)))
      const items = await this.pending(peer.key, Math.min(Math.max(payload.wait, 0), 25_000))
      return answer({ type: 'batch', items })
    }
    const reply = this.process(peer, payload)
    return reply ? answer(reply) : new Response('bad request', { status: 400 })
  }

  // 바로 받았든, 상대에게 가져왔든 같은 방식으로 처리한다.
  private process(peer: Peer, payload: Payload): Payload | null {
    switch (payload.type) {
      case 'ping':
        return { type: 'pong' }
      case 'msg':
        this.receive(peer, payload.msg)
        return { type: 'ok' }
      case 'bye':
        this.dropPeer(peer)
        return { type: 'ok' }
      case 'hello':
        peer.addrs = payload.addrs
        peer.port = payload.port
        return { type: 'hello_ack', name: this.name }
      default:
        return null
    }
  }

  private dropPeer(peer: Peer) {
    if (!this.peers.delete(peer.key)) return
    this.outbox = this.outbox.filter(o => o.peer !== peer.key)
    this.emit({ type: 'peer_closed', peer: peer.name, at: now() })
  }

  private isPulling(peer: Peer) {
    return !!peer.lastPollAt && Date.now() - peer.lastPollAt < POLL_FRESH_MS
  }

  // 상대가 가져갈 수 있게 줄에 세우고, 실제로 가져갈 때까지 잠깐 기다린다.
  private async handOver(peer: Peer, payload: Payload, waitMs: number, thread?: string): Promise<boolean> {
    const item: Outgoing = { id: randomUUID(), peer: peer.key, payload, thread, since: Date.now() }
    this.outbox.push(item)
    this.wakePoll(peer.key)
    for (let waited = 0; waited < waitMs && this.outbox.includes(item); waited += 50) await Bun.sleep(50)
    return !this.outbox.includes(item)
  }

  private wakePoll(key: string) {
    for (const wake of [...(this.pollWaiters.get(key) ?? [])]) wake()
  }

  // 상대가 가져가러 왔을 때: 아직 「받았다」를 못 들은 것을 순서대로 넘기고, 없으면 새로 생길 때까지 붙잡아 둔다.
  private async pending(key: string, waitMs: number): Promise<{ id: string; payload: Payload }[]> {
    const take = () => this.outbox.filter(o => o.peer === key).map(o => ({ id: o.id, payload: o.payload }))
    const ready = take()
    if (ready.length || waitMs === 0 || !this.server) return ready
    await new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timer)
        this.pollWaiters.get(key)?.delete(done)
        resolve()
      }
      const timer = setTimeout(done, waitMs)
      if (!this.pollWaiters.has(key)) this.pollWaiters.set(key, new Set())
      this.pollWaiters.get(key)!.add(done)
    })
    return take()
  }

  // 이쪽이 상대에게 가서 이쪽 앞으로 온 메시지를 가져온다.
  // 이쪽 PC로 들어오는 연결이 방화벽에 막혀 있어도 대화가 되게 하는 길이다.
  private async pollLoop(key: string) {
    if (this.polling.has(key)) return
    this.polling.add(key)
    let backoff = this.opts.retryMs
    // 막 연결된 직후에는 상대가 아직 이쪽을 등록하기 전이라 거절할 수 있다. 여러 번 거절하면 그때 끊는다.
    let refusals = 0
    let ack: string[] = []
    try {
      while (this.server && !this.abort.signal.aborted) {
        const peer = this.peers.get(key)
        if (!peer) break
        try {
          if (!peer.lastAddr) await this.deliver(peer, { type: 'ping' })
          const body = JSON.stringify(seal({ type: 'poll', wait: this.opts.pollWaitMs, ack }, fromB64(peer.key), this.keys))
          const reply = await this.deliverTo(peer, peer.lastAddr!, body, this.opts.pollWaitMs + 5000)
          if (reply === 'refused') throw new DeliveryError('rejected', 'refused')
          if (!reply) throw new DeliveryError('unreachable', 'no answer')
          backoff = this.opts.retryMs
          refusals = 0
          ack = []
          if (reply.type === 'batch')
            for (const item of reply.items) {
              this.process(peer, item.payload)
              ack.push(item.id)
            }
        } catch (e) {
          if (this.abort.signal.aborted) break
          if (e instanceof DeliveryError && e.reason === 'rejected' && ++refusals >= 3) {
            this.dropPeer(peer)
            break
          }
          peer.lastAddr = undefined
          await Bun.sleep(backoff)
          backoff = Math.min(backoff * 2, 30_000)
        }
      }
    } finally {
      this.polling.delete(key)
    }
  }

  private receive(peer: Peer, msg: WireMessage) {
    if (!msg || typeof msg.id !== 'string' || typeof msg.thread !== 'string' || typeof msg.text !== 'string') return
    if (msg.kind !== 'question' && msg.kind !== 'answer' && msg.kind !== 'note') return
    if (this.seen.has(msg.id)) return
    this.seen.add(msg.id)
    let thread = this.threads.get(msg.thread)
    if (!thread) {
      thread = {
        id: msg.thread,
        peer: peer.key,
        peerName: peer.name,
        peerAddr: whereIs(peer),
        subject: msg.subject ?? firstLine(msg.text),
        startedBy: 'peer',
        status: 'your_turn',
        messages: [],
      }
      this.threads.set(thread.id, thread)
    } else if (thread.peer !== peer.key) {
      return
    }
    const context = typeof msg.context === 'string' ? msg.context : undefined
    thread.messages.push({ id: msg.id, from: 'peer', kind: msg.kind, text: msg.text, context, at: now() })
    if (msg.kind === 'note') thread.status = 'peer_checking_with_their_human'
    else thread.status = counted(thread) >= MAX_MESSAGES_PER_THREAD ? 'needs_human' : 'your_turn'
    this.emit({ type: 'message', thread: thread.id, from: peer.name, kind: msg.kind, text: msg.text, context, status: thread.status, at: now() })
  }

  private emit(event: BridgeEvent) {
    this.events.push(event)
    for (const wake of [...this.waiters]) wake()
  }

  private takeToken(token: unknown) {
    if (typeof token !== 'string') return false
    const expires = this.tokens.get(token)
    this.tokens.delete(token)
    return expires !== undefined && expires > Date.now()
  }

  private resolvePeer(to?: string): Peer {
    const peers = [...this.peers.values()]
    if (peers.length === 0) throw new Error('no connected session yet; open the bridge and exchange a connection code first')
    if (!to) {
      if (peers.length === 1) return peers[0]!
      throw new Error(`several sessions are connected; say which one: ${peers.map(p => p.name).join(', ')}`)
    }
    const needle = to.trim().toLowerCase()
    const exact = peers.filter(p => p.name.toLowerCase() === needle)
    const matches = exact.length ? exact : peers.filter(p => p.name.toLowerCase().includes(needle))
    if (matches.length === 1) return matches[0]!
    if (matches.length === 0) throw new Error(`no connected session matches "${to}". Connected: ${peers.map(p => p.name).join(', ')}`)
    throw new Error(`"${to}" matches more than one session: ${matches.map(p => p.name).join(', ')}`)
  }

  // 주소를 앞에서부터 하나씩 시도한다. 상대 키로 봉인된 답이 와야 닿은 것으로 본다.
  private async deliver(peer: Peer, payload: Payload): Promise<Payload> {
    const body = JSON.stringify(seal(payload, fromB64(peer.key), this.keys))
    const addrs = [...new Set([...(peer.lastAddr ? [peer.lastAddr] : []), ...peer.addrs])]
    let refused = false
    for (const addr of addrs) {
      const reply = await this.deliverTo(peer, addr, body, this.opts.connectTimeoutMs)
      if (reply === 'refused') refused = true
      if (!reply || reply === 'refused') continue
      peer.lastAddr = addr
      return reply
    }
    if (refused) throw new DeliveryError('rejected', `${peer.name} refused the message`)
    throw new DeliveryError('unreachable', `${peer.name} is not reachable right now`)
  }

  private async deliverTo(peer: Peer, addr: string, body: string, timeoutMs: number): Promise<Payload | 'refused' | null> {
    let res: Response
    try {
      res = await fetch(`http://${hostForUrl(addr)}:${peer.port}/v1/${routeId(peer.key)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), this.abort.signal]),
      })
    } catch {
      return null
    }
    if (res.status === 403) return 'refused'
    if (!res.ok) return null
    const sealed = (await res.json().catch(() => null)) as { from?: string } | null
    return sealed?.from === peer.key ? (open(sealed, this.keys) as Payload | null) : null
  }

  private async sendOrQueue(peer: Peer, payload: Payload, thread?: string): Promise<'delivered' | 'queued'> {
    // 앞에 밀린 것이 있으면 순서를 지키려고 뒤에 줄 세운다.
    // 바로 못 보내는 상대가 스스로 가져가는 중이면, 바로 보내기는 건너뛴다.
    const skipDirect = peer.directFailed && this.isPulling(peer)
    if (!skipDirect && !this.outbox.some(o => o.peer === peer.key)) {
      try {
        await this.deliver(peer, payload)
        peer.directFailed = false
        return 'delivered'
      } catch (e) {
        if (e instanceof DeliveryError && e.reason === 'rejected')
          throw new Error(`${peer.name} refused the message; its bridge may have been closed and reopened. Exchange a new connection code`)
        peer.directFailed = true
      }
    }
    if (this.isPulling(peer)) return (await this.handOver(peer, payload, 3000, thread)) ? 'delivered' : 'queued'
    this.outbox.push({ id: randomUUID(), peer: peer.key, payload, thread, since: Date.now() })
    return 'queued'
  }

  private async flush() {
    if (this.flushing || this.outbox.length === 0) return
    this.flushing = true
    try {
      const blocked = new Set<string>()
      for (const item of [...this.outbox]) {
        if (blocked.has(item.peer)) continue
        const peer = this.peers.get(item.peer)
        const drop = (reason: string) => {
          this.outbox = this.outbox.filter(o => o !== item)
          this.emit({ type: 'undelivered', to: peer?.name ?? 'disconnected session', thread: item.thread, reason, at: now() })
        }
        if (!peer) {
          drop('the session disconnected')
          continue
        }
        if (Date.now() - item.since > this.opts.expireMs) {
          drop('gave up after 30 minutes without reaching the session')
          continue
        }
        try {
          await this.deliver(peer, item.payload)
          this.outbox = this.outbox.filter(o => o !== item)
        } catch (e) {
          if (e instanceof DeliveryError && e.reason === 'rejected') drop('the session refused it')
          else blocked.add(item.peer)
        }
      }
    } finally {
      this.flushing = false
    }
  }

  // 사람이 연결 코드를 다시 보거나 열린 브릿지를 확인할 수 있게 남겨 둔다.
  private statePath() {
    return this.opts.home && this.port ? join(this.opts.home, 'bridges', `${this.port}.json`) : undefined
  }

  private writeState() {
    const path = this.statePath()
    if (!path) return
    try {
      mkdirSync(join(this.opts.home!, 'bridges'), { recursive: true, mode: 0o700 })
      const state = { name: this.name, port: this.port, pid: process.pid, addrs: this.addrs(), code: this.lastCode, updatedAt: now() }
      writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 })
    } catch {}
  }

  private removeState() {
    const path = this.statePath()
    if (path) rmSync(path, { force: true })
  }
}
