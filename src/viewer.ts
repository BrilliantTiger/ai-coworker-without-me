import type { Server } from 'bun'
import { createHash, timingSafeEqual } from 'node:crypto'
import { connect } from 'node:net'
import { openQuestion } from './bridge'
import type { Bridge, BridgeEvent, ViewerAddress } from './bridge'
import { randomToken } from './crypto'
import { hostForUrl } from './net'
import { limitAfterCut, listenLimit } from './limits'
import { PAGE, QUIET_AFTER_MS } from './page'
import { viewAddress, type ViewAddressDeps, type ViewAddressSetting } from './viewaddr'

// 사람이 브라우저로 대화를 지켜보는 화면. 이 PC 안(127.0.0.1)에서만 열리고, 주소에 든 토큰을 알아야 볼 수 있다.
// 주인이 대화 보기 주소를 정했으면(viewaddr.ts) 그 주소에서도 같은 포트로 연다. 그때도 토큰 없이는 아무것도 답하지 않는다.
// 상대가 보낸 글은 화면에 글자로만 넣는다. HTML 로 해석하지 않는다.
// 정한 주소에서는 브라우저가 쓰는 것(화면, 읽기, 접근키, 고정)만 준다. 이 PC 안의 도우미가 부르는 주소(/status, /next, /wake, /about)는 127.0.0.1 에서만 답한다.
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
  // 주인이 정한 대화 보기 주소와, 그 주소에서 연 서버. 정하지 않았으면 없다.
  private readonly address?: ViewAddressSetting
  private outsideServers = new Map<string, Server<undefined>>()
  private outsideFailed?: string
  // 다른 프로그램이 이미 답하고 있어서 쓰지 않을 포트, 그리고 아무도 답하지 않는 것을 확인한 「주소 포트」.
  private avoidPort?: number
  private clear = new Set<string>()
  // 전에 쓰던 포트를 쓰지 못해 옮겼으면 그 포트. 링크가 바뀌었다고 사람에게 알린다.
  private movedFrom?: number
  // 듣기 명령이 소식 없이 스스로 끝나는 시간(ms). 끝을 두지 않으면 Infinity. 까닭은 limits.ts 에 있다.
  private limit: number
  // 듣기 명령이 시간 상한에 끊긴 것으로 보여 기다림을 줄였다. AI가 다음에 inbox 를 부를 때 한 번 알려 준다.
  private cut?: { waitedMs: number; limitMs: number }

  // pushes: 채널로 켠 세션이라 소식이 세션에 바로 들어간다. 그때는 기다릴 것이 없다.
  // listenMs: 듣기 명령이 스스로 끝나는 시간. 주지 않으면 이 세션이 도는 곳을 보고 정한다. cutFloorMs · cutMinuteMs 는 시험용이다.
  constructor(
    private readonly bridge: Bridge,
    private readonly options: { pushes?: boolean; quietAfterMs?: number; address?: string; at?: ViewAddressSetting; listenMs?: number; cutFloorMs?: number; cutMinuteMs?: number } & ViewAddressDeps = {},
  ) {
    this.token = bridge.viewerAt?.token ?? randomToken()
    this.address = options.at ?? (options.address?.trim() ? viewAddress(options.address, options) : undefined)
    this.limit = options.listenMs ?? listenLimit()
  }

  // 열기 전에 본다: 쓰려는 포트에서 다른 프로그램이 이미 답하고 있는지. 127.0.0.1 과 정한 주소 둘 다 본다.
  // 어떤 운영체제는 다른 프로그램이 모든 주소에서 듣는 포트를 주소 하나로 다시 열게 두고, 그러면 그 주소로 오는 손님을 이쪽이 가로챈다.
  // 그래서 여는 일은 여기서 한다. 답하는 프로그램이 있으면 전에 쓰던 포트를 버리고 새 포트로 옮기고, 정한 주소에서는 열지 않는다.
  // 도구가 답하기 전마다 부른다. 정한 주소에서 아직 못 열었으면 그때마다 다시 해 본다.
  async ready() {
    const want = this.wanted()
    if (!this.server) {
      const remembered = this.bridge.viewerAt?.port
      if (remembered !== undefined && (await Promise.all(['127.0.0.1', ...want].map(a => answers(a, remembered)))).some(Boolean)) this.avoidPort = remembered
      this.startLocal()
    }
    const port = this.server!.port!
    for (const addr of want) {
      if (this.outsideServers.has(addr)) continue
      if (await answers(addr, port)) this.clear.delete(`${addr} ${port}`)
      else this.clear.add(`${addr} ${port}`)
    }
    this.openOutside()
  }

  // 127.0.0.1 말고 더 열 주소.
  private wanted() {
    const host = this.address?.now().host
    return host && host !== '127.0.0.1' ? [host] : []
  }

  // 사람에게 주는 링크. 정한 주소에서 열려 있으면 그 주소로, 아니면 이 PC 안의 주소로 준다.
  get url() {
    const host = this.outsideHost()
    return this.server && (host ? `http://${hostForUrl(host)}:${this.server.port}/${this.token}` : this.localUrl)
  }

  // 이 PC 안에서 부르는 주소. 기다리는 명령과 채팅창 위 띠는 언제나 이 주소를 쓴다.
  private get localUrl() {
    return this.server && `http://127.0.0.1:${this.server.port}/${this.token}`
  }

  // 정한 주소에서 실제로 열려 있을 때만 그 주소를 돌려준다.
  private outsideHost() {
    const host = this.address?.now().host
    return this.server && host && (host === '127.0.0.1' || this.outsideServers.has(host)) ? host : undefined
  }

  // 전에 쓰던 포트를 다른 프로그램이 쓰고 있어서 옮겼으면, 사람에게 전할 말.
  moved(): string | undefined {
    if (this.movedFrom === undefined || !this.server) return undefined
    return `the conversation view moved to a new port, because another program already answers on port ${this.movedFrom}. The link changed: the old one no longer opens this view, and the new one is ${this.url}`
  }

  // 정한 주소의 지금 상태. list_connections 가 사람에게 그대로 알린다. 정하지 않았으면 없다.
  outside(): { set: string; available: boolean; link?: string; problem?: string } | undefined {
    if (!this.address) return undefined
    const at = this.address.now()
    if (this.outsideHost()) return { set: this.address.set, available: true, link: this.url }
    const why = at.problem ?? this.outsideFailed ?? 'the view is not open yet'
    return { set: this.address.set, available: false, problem: `the conversation view cannot be opened at ${at.host ?? this.address.set} now: ${why}.${this.localUrl ? ` It still opens on this computer at ${this.localUrl}` : ''}` }
  }

  // 정한 주소에서도 같은 포트로 연다. 그 주소의 그 포트에서 아무도 답하지 않는 것을 확인했을 때만 연다(ready).
  // 못 열면 127.0.0.1 로만 계속 일한다.
  private openOutside() {
    if (!this.address || !this.server) return
    const want = this.wanted()
    const port = this.server.port!
    for (const [addr, server] of this.outsideServers)
      if (!want.includes(addr)) {
        server.stop(true)
        this.outsideServers.delete(addr)
      }
    this.outsideFailed = undefined
    for (const addr of want) {
      if (this.outsideServers.has(addr)) continue
      if (!this.clear.has(`${addr} ${port}`)) {
        this.outsideFailed = `another program already answers at ${addr} port ${port}, and coworker does not take its place`
        continue
      }
      try {
        this.outsideServers.set(addr, Bun.serve({ hostname: addr, port, idleTimeout: 0, fetch: req => this.handle(req, true) }))
      } catch {
        this.outsideFailed = `coworker could not listen on ${addr} port ${port}; that address is not on this computer right now, or another program uses the port there`
      }
    }
  }

  // 이 PC 안에서 연다. 정한 주소에서는 ready 가 확인한 뒤에만 열린다.
  start(): string {
    this.startLocal()
    this.openOutside()
    return this.url!
  }

  private startLocal() {
    if (this.server) return
    // 전에 쓰던 포트가 비어 있으면 그 포트로, 아니면 빈 포트로 연다. 어느 쪽이든 토큰은 그대로 둔다.
    const remembered = this.bridge.viewerAt?.port
    this.server = (remembered === this.avoidPort ? undefined : this.serve(remembered)) ?? this.serve(0)!
    if (remembered !== undefined && remembered !== this.server.port) this.movedFrom = remembered
    this.bridge.viewerAt = { port: this.server.port!, token: this.token }
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
    for (const server of this.outsideServers.values()) server.stop(true)
    this.outsideServers.clear()
    this.server?.stop(true)
    this.server = undefined
  }

  // links: 연결된 세션마다 지금 닿는지. 화면의 연결 그림과 Claude Code 의 채팅창 위 띠가 본다.
  // unread: 이쪽 AI가 아직 읽어 가지 않은 글이 있는 대화. 화면이 「아직 읽지 않은 질문」을 계속 눈에 띄게 둔다.
  data() {
    return { me: this.bridge.describe(), links: this.bridge.links(), connecting: this.bridge.connecting(), unread: this.bridge.unreadThreads(), conversations: [...this.bridge.threads.values()] }
  }

  // Claude Code 의 채팅창 위 띠(plugin/claude/band.tsx)가 몇 초마다 읽는 짧은 요약. 대화 전체는 넣지 않고, 수와 최근 글 몇 개의 앞부분만 넣는다.
  // 대화는 대개 합의문 없이 질문과 답으로 끝난다(2026-11-16, 사람이 정함). 그래서 「차례」가 아니라 답을 빚진 대화만 센다.
  // yours: 상대가 물었고 이쪽이 아직 답하지 않았다. theirs: 이쪽이 물었고 상대가 아직 답하지 않았다.
  // 답이 필요 없는 알림도 질문으로 온다(2026-11-16, 사람이 지적함: 「답할 필요 없다는데 이쪽 AI가 답할 차례 이게 계속 뜨냐」).
  // 그래서 답 없이 시간이 지난 질문은 더 세지 않는다. 다만 이쪽 AI가 아직 읽지 않은 질문은 오래돼도 센다.
  // 보내는 쪽이 「답 필요 없음」으로 표시한 알림은 처음부터 세지 않는다.
  status() {
    const waiting = { yours: 0, theirs: 0, yourHuman: 0, theirHuman: 0 }
    const quiet = this.options.quietAfterMs ?? QUIET_AFTER_MS
    const unread = new Set(this.bridge.unreadThreads())
    for (const t of this.bridge.threads.values()) {
      if (t.status === 'checking_with_your_human') waiting.yourHuman++
      else if (t.status === 'peer_checking_with_their_human') waiting.theirHuman++
      else {
        const asked = openQuestion(t)
        // 답이 필요 없는 알림은 아무도 기다리지 않는다.
        if (!asked || asked.noAnswer) continue
        const fresh = Date.now() - Date.parse(asked.at) <= quiet
        if (t.status === 'your_turn' && asked.from === 'peer' && (fresh || unread.has(t.id))) waiting.yours++
        else if (t.status === 'waiting_for_peer' && asked.from === 'me' && fresh) waiting.theirs++
      }
    }
    const me = this.bridge.describe()
    const threads = [...this.bridge.threads.values()]
    // 대화 수는 화면과 같게 센다: 여럿에게 한 번에 보낸 질문은 하나다.
    const counts = { conversations: new Set(threads.map(t => (t.ask && t.startedBy === 'me' ? `ask:${t.ask.id}` : t.id))).size, messages: threads.reduce((n, t) => n + t.messages.length, 0) }
    // 가장 최근에 오간 글 몇 개. 띠가 새로 받은 질문과 답을 펼쳐 보인다(2026-11-17). 글은 앞부분만 준다.
    const recent = threads
      .flatMap(t => t.messages.map(m => ({ id: m.id, thread: t.id, at: m.at, from: m.from, peer: t.peerName, kind: m.kind, text: m.text.slice(0, RECENT_TEXT), category: t.category, noAnswer: m.noAnswer || undefined, human: m.human || undefined })))
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
      .slice(-RECENT)
    // 정한 주소에서 열려 있으면 띠가 사람에게 보일 링크도 함께 준다.
    const link = this.outsideHost() ? { link: this.url } : {}
    return { name: me.name, about: me.about, open: me.open, ...link, links: this.bridge.links().map(l => ({ name: l.name, state: l.state, about: l.about })), connecting: this.bridge.connecting().length, waiting, counts, recent }
  }

  // 이 화면(또는 이 PC의 채팅창 위 띠)에서 온 요청인지. 표시 헤더가 있어야 하고, 브라우저가 알려 주는 출처가 이 화면이어야 한다.
  // 이 화면의 출처는 127.0.0.1, localhost, 그리고 주인이 정한 대화 보기 주소뿐이다. 모두 이 서버의 포트여야 한다.
  // 정한 주소는 거기서 실제로 열려 있을 때만 받는다.
  private origins() {
    const host = this.outsideHost()
    return [`http://127.0.0.1:${this.server?.port}`, `http://localhost:${this.server?.port}`, ...(host ? [`http://${hostForUrl(host)}:${this.server?.port}`] : [])]
  }

  // 받지 않을 요청이면 거절하는 답을 돌려준다. 화면에서 왔지만 화면을 연 주소가 다르면, 어디로 열어야 하는지 알려 준다.
  // 그 답은 같은 출처의 화면만 읽을 수 있다. 다른 사이트의 페이지는 이 서버가 허락하지 않아 읽지 못한다.
  private refuse(req: Request, headers: Record<string, string>): Response | undefined {
    const origin = req.headers.get('origin')
    const site = req.headers.get('sec-fetch-site')
    const marked = req.headers.get('x-coworker-viewer') === '1' && (site === null || site === 'same-origin')
    if (marked && (origin === null || this.origins().includes(origin))) return undefined
    if (marked && origin) return Response.json({ error: 'opened at an address this view does not accept', opened: origin, open: this.origins() }, { status: 403, headers })
    return new Response('forbidden', { status: 403 })
  }

  // Claude Code 의 채팅창 위 띠가 이 세션의 모델과 강도(effort)를 알려 준다. AI가 스스로 모를 때가 있어서 Claude Code 에서 읽은 것을 받는다.
  // 브릿지가 그것을 기억하고, 상대에게 인사할 때 함께 전한다. 글자만, 한 줄, 60자까지 받는다.
  private async introduce(req: Request, headers: Record<string, string>): Promise<Response> {
    const refused = this.refuse(req, headers)
    if (refused) return refused
    const body = (await req.json().catch(() => null)) as { model?: unknown; effort?: unknown } | null
    this.bridge.setAbout({ ...(typeof body?.model === 'string' ? { model: body.model } : {}), ...(typeof body?.effort === 'string' ? { effort: body.effort } : {}) })
    return Response.json({ about: this.bridge.describe().about ?? {} }, { headers })
  }

  // 사람이 화면에서 접근키(연결 코드)를 새로 만든다. 사람을 더할 때, 그리고 끊긴 상대가 다시 들어오게 할 때 쓴다
  // (2026-11-16, 사람이 정함: 「끊겼을경우 웹에서 접근키를 재생성」, 「유저 추가가 필요할때 접근키 발급」).
  // AI가 open_bridge 로 만드는 코드와 같다: 그룹 코드이고, 한 번만 쓸 수 있고, 60분 동안 쓸 수 있다.
  // 화면 주소의 토큰을 아는 이 PC의 사람만 부를 수 있다. 다른 웹페이지가 부르지 못하게 이 화면에서 온 요청인지도 본다:
  // 화면이 붙이는 표시 헤더가 있어야 하고(다른 사이트가 붙이면 브라우저가 먼저 허락을 묻는데, 이 서버는 허락하지 않는다),
  // 브라우저가 알려 주는 출처가 이 화면이어야 한다.
  private issue(req: Request, headers: Record<string, string>): Response {
    const refused = this.refuse(req, headers)
    if (refused) return refused
    // 브릿지가 닫혀 있으면 만들지 않는다. 화면에서 누른 것으로 닫힌 브릿지를 다시 열지 않는다.
    if (!this.bridge.isOpen) return Response.json({ error: 'the bridge is closed' }, { status: 409, headers })
    const now = Date.now()
    if (now - this.issuedAt < ISSUE_GAP_MS) return Response.json({ error: 'too many requests' }, { status: 429, headers })
    this.issuedAt = now
    return Response.json({ code: this.bridge.newCode({ ttlMs: ISSUE_TTL_MS }), expires: new Date(now + ISSUE_TTL_MS).toISOString() }, { headers })
  }

  // 사람이 화면에서 대화를 맨 위에 고정하거나 푼다(2026-11-17, 사람이 정함: 「질답 정렬을 고정, 최신 질답, 순으로」).
  // 접근키 발급과 같이 이 화면에서 온 요청만 받는다. 고정은 이 PC에만 남는다.
  private async pin(req: Request, headers: Record<string, string>): Promise<Response> {
    const refused = this.refuse(req, headers)
    if (refused) return refused
    const body = (await req.json().catch(() => null)) as { threads?: unknown; pinned?: unknown } | null
    const threads = body?.threads
    const ok = Array.isArray(threads) && threads.length > 0 && threads.length <= 64 && threads.every(id => typeof id === 'string' && id.length <= 200)
    if (!ok || typeof body?.pinned !== 'boolean') return Response.json({ error: 'expected { threads: string[], pinned: boolean }' }, { status: 400, headers })
    return Response.json({ changed: this.bridge.pin(threads as string[], body.pinned) }, { headers })
  }

  // 백그라운드 명령이 지금 기다리고 있는지.
  get listening() {
    return this.listener !== undefined
  }

  // 듣기 명령이 소식 없이 스스로 끝나는 시간(ms). 끝을 두지 않으면 Infinity.
  get listenLimit() {
    return this.limit
  }

  // 듣기 명령이 시간 상한에 끊겨 기다림을 줄였으면, 그 사실을 한 번만 돌려준다.
  takeCut() {
    const cut = this.cut
    this.cut = undefined
    return cut
  }

  // 백그라운드로 돌려 둘 명령. 새 소식이 오면 한 줄을 찍고 끝난다.
  // Windows PowerShell 에서 curl 은 다른 명령의 별명이라 curl.exe 로 부른다. Git Bash 에서도 curl.exe 가 된다.
  listenCommand(platform: string = process.platform) {
    this.start()
    return `${platform === 'win32' ? 'curl.exe' : 'curl'} -s ${this.localUrl}/next`
  }

  // outside: 정한 주소에서 온 요청. 브라우저가 쓰는 것만 준다.
  // 주소는 받은 그대로 본다. 정확히 /토큰 또는 /토큰/이름 꼴일 때만 답한다(겹친 빗금, 점, %로 바꿔 적은 글자, 물음표 뒤 값은 받지 않는다).
  private handle(req: Request, outside = false): Response | Promise<Response> {
    const none = () => new Response('not found', { status: 404 })
    const raw = req.url.replace(/^[a-z]+:\/\/[^/]*/i, '')
    const parts = /^\/([A-Za-z0-9_-]{1,128})(?:\/([a-z]{1,12}))?$/.exec(raw)
    if (!parts || !sameText(parts[1]!, this.token)) return none()
    const what = `${req.method} ${parts[2] ?? ''}`
    const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }
    if (what === 'GET ')
      return new Response(PAGE, {
        headers: {
          ...headers,
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
        },
      })
    if (what === 'GET data') return Response.json(this.data(), { headers })
    if (what === 'POST code') return this.issue(req, headers)
    if (what === 'POST pin') return this.pin(req, headers)
    if (what === 'GET events') return this.events(req, headers)
    if (outside) return none()
    if (what === 'GET status') return Response.json(this.status(), { headers })
    if (what === 'POST about') return this.introduce(req, headers)
    if (what === 'GET next') return this.next(req, headers)
    if (what === 'GET wake') return this.wake(req, headers)
    return new Response('not found', { status: 404 })
  }

  // 채널 없이 켠 Claude Code 는 이 주소를 부르는 명령을 백그라운드로 돌려 두고 차례를 끝낸다. 그동안 사람은 AI와 계속 이야기할 수 있다.
  // 새 소식이 쌓이거나 브릿지가 닫히면 한 줄을 돌려주고 끝나고, 명령이 끝났다고 Claude Code 가 AI를 깨운다.
  // 소식은 가져가지 않는다. AI가 inbox 로 읽으므로 이 명령이 중간에 끊겨도 소식은 남는다.
  // 기다림은 마지막 하나만 산다. 새 명령이 오면 앞의 명령은 바로 끝나서, 백그라운드 명령이 쌓이지 않는다.
  // 소식이 없어도 정한 시간이 지나면 스스로 끝난다(limits.ts). Claude Code 의 시간 상한에 걸려 「killed」로 끝나면 AI가 다시 걸지 않기 때문이다.
  private next(req: Request, headers: Record<string, string>): Promise<Response> {
    this.listener?.('coworker: a newer listen command took over from this one. Nothing to do.')
    // AI가 스스로 기다리기 시작했으니, 다시 켤 때 훅이 걸어 둔 기다림은 끝낸다. 두 번 깨우지 않는다.
    for (const done of [...this.wakers]) done(LISTENING_ITSELF)
    return new Promise(resolve => {
      let unwatch = () => {}
      let timer: ReturnType<typeof setTimeout> | undefined
      const started = Date.now()
      const finish = (text: string) => {
        if (this.listener === finish) this.listener = undefined
        unwatch()
        clearTimeout(timer)
        resolve(new Response(text && `${text}\n`, { headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' } }))
      }
      const check = () => {
        const text = newsLine(this.bridge.unread(), this.bridge.isOpen)
        if (text) finish(text)
      }
      this.listener = finish
      unwatch = this.bridge.watch(check)
      if (Number.isFinite(this.limit)) timer = setTimeout(() => finish(NOTHING_NEW), this.limit)
      // 명령이 멈췄으면(사람이 백그라운드 작업을 멈췄거나, 세션이 끝났거나, Claude Code 가 시간 상한으로 끊었다) 더 기다리지 않는다.
      // 시간 상한으로 끊긴 것으로 보이면 다음부터는 그보다 먼저 스스로 끝나게 기다림을 줄인다.
      req.signal.addEventListener(
        'abort',
        () => {
          if (this.listener === finish) this.learnFromCut(Date.now() - started)
          finish('')
        },
        { once: true },
      )
      check()
    })
  }

  private learnFromCut(waitedMs: number) {
    const shorter = limitAfterCut(waitedMs, this.limit, this.options.cutFloorMs, this.options.cutMinuteMs)
    if (shorter === undefined) return
    this.limit = shorter
    this.cut = { waitedMs, limitMs: shorter }
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

// 요약에 넣는 최근 글의 수와, 글마다 주는 길이.
const RECENT = 8
const RECENT_TEXT = 400

// 화면에서 만든 접근키를 쓸 수 있는 시간과, 다시 만들 수 있는 간격.
const ISSUE_TTL_MS = 60 * 60_000
const ISSUE_GAP_MS = 1000

// 백그라운드 명령이 찍는 한 줄. 무엇이 몇 건 왔는지만 알린다. 상대가 정한 이름이나 보낸 글은 넣지 않는다.
// 내용은 AI가 inbox 로 읽는다. 아무 일도 없으면 아무것도 돌려주지 않아 명령이 계속 기다린다.
const LISTENING_ITSELF = 'coworker: this session is listening by itself now. Nothing to do.'

// 소식 없이 정한 시간이 지나 듣기 명령이 스스로 끝날 때 찍는 한 줄.
export const NOTHING_NEW =
  'coworker: nothing new. This listen command ends by itself after a while, so that no time limit stops it. That is how listening works, not an error. Call the coworker inbox tool, then run this listen command in the background again. Do not tell your human anything about this.'

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
  peer_session_closed: 'their AI session closed',
  undelivered: 'undelivered',
  decision: 'decision by your human',
  moved: 'moved to another session',
  clock: 'clocks differ',
  peer_human_slow: 'their human is slow to decide',
}

// 두 글이 같은지, 걸린 시간으로 어디까지 맞았는지 드러나지 않게 견준다.
function sameText(a: string, b: string) {
  const hash = (t: string) => createHash('sha256').update(t).digest()
  return timingSafeEqual(hash(a), hash(b))
}

// 그 주소의 그 포트에서 누가 답하는지(연결을 받아 주는지) 잠깐 본다.
function answers(host: string, port: number): Promise<boolean> {
  return new Promise(done => {
    const sock = connect({ host, port })
    const end = (yes: boolean) => {
      sock.destroy()
      done(yes)
    }
    sock.setTimeout(300, () => end(false))
    sock.once('connect', () => end(true))
    sock.once('error', () => end(false))
  })
}
