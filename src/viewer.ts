import type { Server } from 'bun'
import type { Bridge, BridgeEvent, ViewerAddress } from './bridge'
import { randomToken } from './crypto'

// 사람이 브라우저로 대화를 지켜보는 화면. 이 PC 안(127.0.0.1)에서만 열리고, 주소에 든 토큰을 알아야 볼 수 있다.
// 상대가 보낸 글은 화면에 글자로만 넣는다. HTML 로 해석하지 않는다.
// 채널 없이 켠 Claude Code 가 백그라운드 명령으로 기다리는 주소(/next)도 여기에 둔다.
// 주소는 브릿지가 기억한다. 같은 세션을 다시 켜면 같은 포트와 토큰으로 열어, 사람이 열어 둔 화면이 끊기지 않고 이어서 보여 준다.
export class Viewer {
  private server?: Server<undefined>
  private readonly token: string
  // 지금 기다리고 있는 백그라운드 명령. 하나만 산다.
  private listener?: (text: string) => void

  constructor(private readonly bridge: Bridge) {
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
    this.listener = undefined
    this.server?.stop(true)
    this.server = undefined
  }

  data() {
    return { me: this.bridge.describe(), conversations: [...this.bridge.threads.values()] }
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
    if (req.method === 'GET' && path === `/${this.token}/events`) return this.events(req, headers)
    if (req.method === 'GET' && path === `/${this.token}/next`) return this.next(req, headers)
    return new Response('not found', { status: 404 })
  }

  // 채널 없이 켠 Claude Code 는 이 주소를 부르는 명령을 백그라운드로 돌려 두고 차례를 끝낸다. 그동안 사람은 AI와 계속 이야기할 수 있다.
  // 새 소식이 쌓이거나 브릿지가 닫히면 한 줄을 돌려주고 끝나고, 명령이 끝났다고 Claude Code 가 AI를 깨운다.
  // 소식은 가져가지 않는다. AI가 inbox 로 읽으므로 이 명령이 중간에 끊겨도 소식은 남는다.
  // 기다림은 마지막 하나만 산다. 새 명령이 오면 앞의 명령은 바로 끝나서, 백그라운드 명령이 쌓이지 않는다.
  private next(req: Request, headers: Record<string, string>): Promise<Response> {
    this.listener?.('coworker: a newer listen command took over from this one. Nothing to do.')
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

// 백그라운드 명령이 찍는 한 줄. 무엇이 몇 건 왔는지만 알린다. 상대가 정한 이름이나 보낸 글은 넣지 않는다.
// 내용은 AI가 inbox 로 읽는다. 아무 일도 없으면 아무것도 돌려주지 않아 명령이 계속 기다린다.
export function newsLine(events: readonly BridgeEvent[], open: boolean): string | undefined {
  if (events.length) {
    const counts = new Map<string, number>()
    for (const e of events) {
      const what = e.type === 'message' ? e.kind : WHAT[e.type]
      counts.set(what, (counts.get(what) ?? 0) + 1)
    }
    const list = [...counts].map(([what, n]) => `${n} ${what}`).join(', ')
    return `coworker: new for this session (${list}). Call the coworker inbox tool to read it and handle it, then run this listen command in the background again.`
  }
  if (!open) return "coworker: this session's bridge is closed, so there is nothing to listen for. Do not run this command again."
}

const WHAT: Record<Exclude<BridgeEvent['type'], 'message'>, string> = {
  connected: 'connected',
  peer_closed: 'left',
  undelivered: 'undelivered',
}

const PAGE = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Coworker 대화</title>
<style>
:root { --bg: #f7f7f5; --card: #fff; --text: #1d1d1b; --muted: #6b6b66; --line: #e3e2dd; --in: #e8f0fe; --out: #eaf6ec; --note: #fdf5e2; --accent: #2f5bd3; --warn: #b3261e; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #161615; --card: #20201e; --text: #ecebe6; --muted: #9c9b95; --line: #34332f; --in: #1f2a40; --out: #1e3324; --note: #3a321e; --accent: #8aa8ff; --warn: #ff8a80; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 20px; margin: 0 0 4px; }
.me, .meta, .time, .empty, .refresh { color: var(--muted); font-size: 13px; }
.refresh { margin: 4px 0 20px; }
.refresh.offline { color: var(--warn); font-weight: 600; }
.conv { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; }
.head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.badge { font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 99px; background: var(--in); }
.badge.out { background: var(--out); }
.subject { font-weight: 600; overflow-wrap: anywhere; }
.status { margin-left: auto; font-size: 12px; color: var(--accent); }
.meta { margin: 4px 0 10px; overflow-wrap: anywhere; }
.msg { border-left: 3px solid var(--line); padding: 6px 10px; margin: 8px 0; border-radius: 0 6px 6px 0; background: var(--in); }
.msg.mine { background: var(--out); }
.msg.note { background: var(--note); }
.msg.agreement { border-left-color: var(--accent); }
.who { font-size: 13px; font-weight: 600; }
.text { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 2px; }
details { margin-top: 4px; font-size: 13px; color: var(--muted); }
details .text { color: var(--text); }
</style>
</head>
<body>
<main>
<h1>Coworker 대화</h1>
<div class="me" id="me"></div>
<div class="refresh" id="refresh"></div>
<div id="list"></div>
</main>
<script>
const KIND = { question: '질문', answer: '답', note: '알림', closed: '마감', agreement: '합의문' }
const STATUS = {
  waiting_for_peer: '상대 차례',
  your_turn: '이쪽 차례',
  checking_with_your_human: '이쪽 사람에게 확인 중',
  peer_checking_with_their_human: '상대가 자기 사람에게 확인 중',
  closed: '마감 · 다른 사람이 먼저 답함',
  agreed: '합의문 작성됨',
}
const ANSWERS = { all: '모두 답', one: '한 명만 답' }
const time = at => new Date(at).toLocaleString('ko-KR', { hour12: false })
function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}
function render(data) {
  const me = data.me
  document.getElementById('me').textContent = me.name + (me.open ? ' · 포트 ' + me.port + ' 열림' : ' · 브릿지 닫힘')
  const list = document.getElementById('list')
  list.replaceChildren()
  const convs = [...data.conversations].sort((a, b) => (b.messages[0]?.at ?? '').localeCompare(a.messages[0]?.at ?? ''))
  if (!convs.length) list.append(el('div', 'empty', '아직 주고받은 질문이 없습니다.'))
  for (const c of convs) {
    const card = el('section', 'conv')
    const head = el('div', 'head')
    const mine = c.startedBy === 'me'
    head.append(el('span', 'badge' + (mine ? ' out' : ''), mine ? '보낸 질문' : '받은 질문'), el('span', 'subject', c.subject), el('span', 'status', STATUS[c.status] ?? c.status))
    const where = c.peerName + (c.peerAddr ? ' (' + c.peerAddr + ')' : '')
    const first = c.messages[0]
    const group = c.ask ? ' · 함께 받은 사람: ' + c.ask.to.join(', ') + ' (' + (ANSWERS[c.ask.answers] ?? c.ask.answers) + ')' : ''
    card.append(head, el('div', 'meta', (mine ? '받는 쪽: ' : '보낸 쪽: ') + where + (first ? ' · 시작 ' + time(first.at) : '') + group))
    for (const m of c.messages) {
      const box = el('div', 'msg' + (m.from === 'me' ? ' mine' : '') + (m.kind === 'note' || m.kind === 'closed' ? ' note' : '') + (m.kind === 'agreement' ? ' agreement' : ''))
      const who = m.from === 'me' ? '나 → ' + c.peerName : c.peerName + ' → 나'
      box.append(el('div', 'who', (KIND[m.kind] ?? m.kind) + ' · ' + who), el('div', 'time', time(m.at)), el('div', 'text', m.text))
      if (m.context) {
        const d = el('details')
        d.append(el('summary', '', '함께 보낸 배경'), el('div', 'text', m.context))
        box.append(d)
      }
      card.append(box)
    }
    list.append(card)
  }
}
// 세션이 바뀐 것을 그때그때 밀어 준다. 세션을 다시 켜면 같은 주소로 돌아오므로, 끊겨도 스스로 다시 붙는다.
// 브라우저는 한 주소에 연결을 6개까지만 열어 둔다. 화면마다 연결 하나를 쥐고 있으면 탭을 여럿 연 뒤 새 탭이 뜨지 않으므로,
// 보이지 않는 탭은 연결을 놓았다가 다시 보일 때 붙는다. 붙을 때마다 대화 전체를 다시 받는다.
const refresh = document.getElementById('refresh')
let changedAt = ''
let shown = ''
let events
let retry
function status(text, offline) {
  refresh.textContent = text
  refresh.classList.toggle('offline', !!offline)
}
function connect() {
  clearTimeout(retry)
  if (events) events.close()
  const source = new EventSource(location.pathname + '/events')
  events = source
  source.onmessage = e => {
    if (e.data !== shown) {
      shown = e.data
      render(JSON.parse(e.data))
      changedAt = time(new Date().toISOString())
    }
    status('바뀌면 바로 보여 줍니다 · 마지막 변경 ' + changedAt)
  }
  source.onerror = () => {
    status('세션에 닿지 않습니다. 세션이 다시 켜지면 이 화면이 스스로 이어서 보여 줍니다.', true)
    // 브라우저가 다시 붙기를 그만두었으면(그 포트에 다른 것이 떴을 때) 잠시 뒤 직접 다시 붙는다.
    if (source.readyState === EventSource.CLOSED && events === source) retry = setTimeout(connect, 5000)
  }
}
function release() {
  clearTimeout(retry)
  if (events) events.close()
  events = undefined
}
document.addEventListener('visibilitychange', () => (document.hidden ? release() : connect()))
if (!document.hidden) connect()
</script>
</body>
</html>
`
