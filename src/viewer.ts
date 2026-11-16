import type { Server } from 'bun'
import type { Bridge, BridgeEvent, Thread, ViewerAddress } from './bridge'
import { randomToken } from './crypto'
import { PAGE } from './page'

// 사람이 브라우저로 대화를 지켜보는 화면. 이 PC 안(127.0.0.1)에서만 열리고, 주소에 든 토큰을 알아야 볼 수 있다.
// 상대가 보낸 글은 화면에 글자로만 넣는다. HTML 로 해석하지 않는다.
// 사람이 화면에서 할 수 있는 일은 하나다: 접근키(연결 코드)를 새로 만드는 것(/code). 나머지는 모두 보기만 한다.
// 채널 없이 켠 Claude Code 가 백그라운드 명령으로 기다리는 주소(/next)도 여기에 둔다.
// 주소는 브릿지가 기억한다. 같은 세션을 다시 켜면 같은 포트와 토큰으로 열어, 사람이 열어 둔 화면이 끊기지 않고 이어서 보여 준다.
export class Viewer {
  private server?: Server<undefined>
  private readonly token: string
  // 지금 기다리고 있는 백그라운드 명령. 하나만 산다.
  private listener?: (text: string) => void
  // 세션을 다시 켰을 때 플러그인 훅이 거는 기다림(/wake). AI가 스스로 기다리기를 걸면 끝난다.
  private wakers = new Set<(text: string) => void>()
  // 화면에서 접근키를 마지막으로 만든 때. 너무 잦은 요청을 막는다.
  private issuedAt = 0

  // pushes: 채널로 켠 세션이라 소식이 세션에 바로 들어간다. 그때는 기다릴 것이 없다.
  constructor(
    private readonly bridge: Bridge,
    private readonly options: { pushes?: boolean } = {},
  ) {
    this.token = bridge.viewerAt?.token ?? randomToken()
  }

  get url() {
    return this.server && `http://127.0.0.1:${this.server.port}/${this.token}`
  }

  start(): string {
    if (!this.server) {
      // 전에 쓰던 포트가 비어 있으면 그 포트로, 아니면 빈 포트로 연다. 어느 쪽이든 토큰은 그대로 둔다.
      this.server = this.serve(this.bridge.viewerAt?.port) ?? this.serve(0)!
      this.bridge.viewerAt = { port: this.server.port!, token: this.token }
    }
    return this.url!
  }

  private serve(port: number | undefined) {
    if (port === undefined) return undefined
    try {
      // 바뀔 때만 밀어 주는 연결은 오래 조용할 수 있다. Bun 은 10초 동안 조용한 연결을 끊으므로 끄지 않게 한다.
      return Bun.serve({ hostname: '127.0.0.1', port, idleTimeout: 0, fetch: req => this.handle(req) })
    } catch (e) {
      if (port === 0) throw e
      return undefined
    }
  }

  stop() {
    for (const done of [...this.wakers]) done('')
    this.listener = undefined
    this.server?.stop(true)
    this.server = undefined
  }

  // links: 연결된 세션마다 지금 닿는지. 화면의 연결 그림과 Claude Code 의 채팅창 위 띠가 본다.
  data() {
    return { me: this.bridge.describe(), links: this.bridge.links(), connecting: this.bridge.connecting(), conversations: [...this.bridge.threads.values()] }
  }

  // Claude Code 의 채팅창 위 띠(plugin/claude/band.tsx)가 몇 초마다 읽는 짧은 요약. 대화 글은 넣지 않는다.
  // 대화는 대개 합의문 없이 질문과 답으로 끝난다(2026-11-16, 사람이 정함). 그래서 「차례」가 아니라 답을 빚진 대화만 센다.
  // yours: 상대가 물었고 이쪽이 아직 답하지 않았다. theirs: 이쪽이 물었고 상대가 아직 답하지 않았다.
  status() {
    const waiting = { yours: 0, theirs: 0, yourHuman: 0, theirHuman: 0 }
    for (const t of this.bridge.threads.values()) {
      if (t.status === 'checking_with_your_human') waiting.yourHuman++
      else if (t.status === 'peer_checking_with_their_human') waiting.theirHuman++
      else if (t.status === 'your_turn' && owes(t) === 'me') waiting.yours++
      else if (t.status === 'waiting_for_peer' && owes(t) === 'peer') waiting.theirs++
    }
    const me = this.bridge.describe()
    return { name: me.name, open: me.open, links: this.bridge.links().map(l => ({ name: l.name, state: l.state })), connecting: this.bridge.connecting().length, waiting }
  }

  // 사람이 화면에서 접근키(연결 코드)를 새로 만든다. 사람을 더할 때, 그리고 끊긴 상대가 다시 들어오게 할 때 쓴다
  // (2026-11-16, 사람이 정함: 「끊겼을경우 웹에서 접근키를 재생성」, 「유저 추가가 필요할때 접근키 발급」).
  // AI가 open_bridge 로 만드는 코드와 같다: 그룹 코드이고, 한 번만 쓸 수 있고, 60분 동안 쓸 수 있다.
  // 화면 주소의 토큰을 아는 이 PC의 사람만 부를 수 있다. 다른 웹페이지가 부르지 못하게 이 화면에서 온 요청인지도 본다:
  // 화면이 붙이는 표시 헤더가 있어야 하고(다른 사이트가 붙이면 브라우저가 먼저 허락을 묻는데, 이 서버는 허락하지 않는다),
  // 브라우저가 알려 주는 출처가 이 화면이어야 한다.
  private issue(req: Request, headers: Record<string, string>): Response {
    const origin = req.headers.get('origin')
    const site = req.headers.get('sec-fetch-site')
    const here = origin === null || [`http://127.0.0.1:${this.server?.port}`, `http://localhost:${this.server?.port}`].includes(origin)
    if (req.headers.get('x-coworker-viewer') !== '1' || !here || (site !== null && site !== 'same-origin')) return new Response('forbidden', { status: 403 })
    // 브릿지가 닫혀 있으면 만들지 않는다. 화면에서 누른 것으로 닫힌 브릿지를 다시 열지 않는다.
    if (!this.bridge.isOpen) return Response.json({ error: 'the bridge is closed' }, { status: 409, headers })
    const now = Date.now()
    if (now - this.issuedAt < ISSUE_GAP_MS) return Response.json({ error: 'too many requests' }, { status: 429, headers })
    this.issuedAt = now
    return Response.json({ code: this.bridge.newCode({ ttlMs: ISSUE_TTL_MS }), expires: new Date(now + ISSUE_TTL_MS).toISOString() }, { headers })
  }

  // 백그라운드 명령이 지금 기다리고 있는지.
  get listening() {
    return this.listener !== undefined
  }

  // 백그라운드로 돌려 둘 명령. 새 소식이 오면 한 줄을 찍고 끝난다.
  // Windows PowerShell 에서 curl 은 다른 명령의 별명이라 curl.exe 로 부른다. Git Bash 에서도 curl.exe 가 된다.
  listenCommand(platform: string = process.platform) {
    return `${platform === 'win32' ? 'curl.exe' : 'curl'} -s ${this.start()}/next`
  }

  private handle(req: Request): Response | Promise<Response> {
    const path = new URL(req.url).pathname
    const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }
    if (req.method === 'GET' && path === `/${this.token}`)
      return new Response(PAGE, {
        headers: {
          ...headers,
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
        },
      })
    if (req.method === 'GET' && path === `/${this.token}/data`) return Response.json(this.data(), { headers })
    if (req.method === 'GET' && path === `/${this.token}/status`) return Response.json(this.status(), { headers })
    if (req.method === 'POST' && path === `/${this.token}/code`) return this.issue(req, headers)
    if (req.method === 'GET' && path === `/${this.token}/events`) return this.events(req, headers)
    if (req.method === 'GET' && path === `/${this.token}/next`) return this.next(req, headers)
    if (req.method === 'GET' && path === `/${this.token}/wake`) return this.wake(req, headers)
    return new Response('not found', { status: 404 })
  }

  // 채널 없이 켠 Claude Code 는 이 주소를 부르는 명령을 백그라운드로 돌려 두고 차례를 끝낸다. 그동안 사람은 AI와 계속 이야기할 수 있다.
  // 새 소식이 쌓이거나 브릿지가 닫히면 한 줄을 돌려주고 끝나고, 명령이 끝났다고 Claude Code 가 AI를 깨운다.
  // 소식은 가져가지 않는다. AI가 inbox 로 읽으므로 이 명령이 중간에 끊겨도 소식은 남는다.
  // 기다림은 마지막 하나만 산다. 새 명령이 오면 앞의 명령은 바로 끝나서, 백그라운드 명령이 쌓이지 않는다.
  private next(req: Request, headers: Record<string, string>): Promise<Response> {
    this.listener?.('coworker: a newer listen command took over from this one. Nothing to do.')
    // AI가 스스로 기다리기 시작했으니, 다시 켤 때 훅이 걸어 둔 기다림은 끝낸다. 두 번 깨우지 않는다.
    for (const done of [...this.wakers]) done(LISTENING_ITSELF)
    return new Promise(resolve => {
      let unwatch = () => {}
      const finish = (text: string) => {
        if (this.listener === finish) this.listener = undefined
        unwatch()
        resolve(new Response(text && `${text}\n`, { headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' } }))
      }
      const check = () => {
        const text = newsLine(this.bridge.unread(), this.bridge.isOpen)
        if (text) finish(text)
      }
      this.listener = finish
      unwatch = this.bridge.watch(check)
      // 명령이 멈췄으면(사람이 백그라운드 작업을 멈췄거나 세션이 끝났다) 더 기다리지 않는다.
      req.signal.addEventListener('abort', () => finish(''), { once: true })
      check()
    })
  }

  // 세션을 다시 켜면(Claude Code resume) 백그라운드 대기 명령이 사라진다. 사람이 말을 걸기 전까지 AI는 그것을 다시 걸지 않는다.
  // 그래서 플러그인의 세션 시작 훅(asyncRewake)이 여기서 기다린다. 소식이 오면 한 줄을 돌려주고, 훅이 코드 2로 끝나 Claude Code가 AI를 깨운다.
  // AI가 스스로 기다리고 있거나(또는 그렇게 되면), 채널로 받는 세션이거나, 브릿지가 닫혔으면 할 일이 없다고 돌려준다.
  private wake(req: Request, headers: Record<string, string>): Promise<Response> | Response {
    const reply = (text: string) => new Response(text && `${text}\n`, { headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' } })
    if (this.options.pushes) return reply('coworker: this session gets messages pushed in by itself. Nothing to do.')
    if (this.listener) return reply(LISTENING_ITSELF)
    return new Promise(resolve => {
      let unwatch = () => {}
      const finish = (text: string) => {
        this.wakers.delete(finish)
        unwatch()
        resolve(reply(text))
      }
      const check = () => {
        const text = newsLine(this.bridge.unread(), this.bridge.isOpen, 'after-restart')
        if (text) finish(text)
      }
      this.wakers.add(finish)
      unwatch = this.bridge.watch(check)
      req.signal.addEventListener('abort', () => finish(''), { once: true })
      check()
    })
  }

  // 대화가 바뀔 때마다 화면 자료를 통째로 밀어 준다(Server-Sent Events). 대화 몇 개라 통째로 보내도 작다.
  // 한 번에 여러 곳이 바뀌어도 한 번만 보내고, 보낸 것과 같으면 보내지 않는다.
  private events(req: Request, headers: Record<string, string>): Response {
    const encoder = new TextEncoder()
    let stop = () => {}
    const body = new ReadableStream<Uint8Array>({
      start: controller => {
        let last = ''
        let pending = false
        const write = (text: string) => {
          try {
            controller.enqueue(encoder.encode(text))
          } catch {
            stop()
          }
        }
        const send = () => {
          pending = false
          const json = JSON.stringify(this.data())
          if (json === last) return
          last = json
          write(`data: ${json}\n\n`)
        }
        const unwatch = this.bridge.watch(() => {
          if (!pending) (pending = true), setTimeout(send, 0)
        })
        // 연결이 살아 있는지 브라우저가 알 수 있게 가끔 빈 주석을 보낸다.
        const ping = setInterval(() => write(': ping\n\n'), 15_000)
        stop = () => {
          clearInterval(ping)
          unwatch()
        }
        req.signal.addEventListener('abort', () => stop())
        send()
      },
      cancel: () => stop(),
    })
    return new Response(body, { headers: { ...headers, 'content-type': 'text/event-stream; charset=utf-8' } })
  }
}

// 화면에서 만든 접근키를 쓸 수 있는 시간과, 다시 만들 수 있는 간격.
const ISSUE_TTL_MS = 60 * 60_000
const ISSUE_GAP_MS = 1000

// 누가 답을 빚졌는지. 마지막으로 오간 글이 질문이면 받은 쪽이 빚졌고, 답이면 아무도 빚지지 않았다. 알림은 건너뛴다.
export function owes(thread: Thread): 'me' | 'peer' | undefined {
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const m = thread.messages[i]!
    if (m.kind === 'question') return m.from === 'me' ? 'peer' : 'me'
    if (m.kind === 'answer') return undefined
  }
  return undefined
}

// 백그라운드 명령이 찍는 한 줄. 무엇이 몇 건 왔는지만 알린다. 상대가 정한 이름이나 보낸 글은 넣지 않는다.
// 내용은 AI가 inbox 로 읽는다. 아무 일도 없으면 아무것도 돌려주지 않아 명령이 계속 기다린다.
const LISTENING_ITSELF = 'coworker: this session is listening by itself now. Nothing to do.'

// 다시 켠 뒤 깨우는 한 줄은 이것으로 시작한다. 훅은 코드 2로 끝나야 AI를 깨우는데, Claude Code 는 코드 2로 끝난 훅을
// 언제나 실패(error)로 기록한다(2.1.323). 그래서 Orca 같은 화면은 이 한 줄을 빨간 「hook failed」 상자에 넣는다(2026-11-13).
// 그 상자를 본 사람이 고장으로 여기지 않게, 맨 앞에서 오류가 아니라고 먼저 말한다.
export const AFTER_RESTART = 'coworker: not an error.'

export function newsLine(events: readonly BridgeEvent[], open: boolean, when: 'listening' | 'after-restart' = 'listening'): string | undefined {
  if (events.length) {
    const counts = new Map<string, number>()
    for (const e of events) {
      const what = e.type === 'message' ? e.kind : WHAT[e.type]
      counts.set(what, (counts.get(what) ?? 0) + 1)
    }
    const list = [...counts].map(([what, n]) => `${n} ${what}`).join(', ')
    if (when === 'after-restart')
      return `${AFTER_RESTART} New for this session (${list}) arrived after it restarted, while nothing was listening, so coworker woke it. Claude Code shows this as a failed hook only because waking needs exit code 2. Call the coworker inbox tool to read and handle it, then start listening in the background again with the listen_command it gives.`
    return `coworker: new for this session (${list}). Call the coworker inbox tool to read it and handle it, then run this listen command in the background again.`
  }
  if (!open) return "coworker: this session's bridge is closed, so there is nothing to listen for. Do not run this command again."
}

const WHAT: Record<Exclude<BridgeEvent['type'], 'message'>, string> = {
  connected: 'connected',
  peer_closed: 'left',
  undelivered: 'undelivered',
  decision: 'decision by your human',
  moved: 'moved to another session',
  clock: 'clocks differ',
  peer_human_slow: 'their human is slow to decide',
}
