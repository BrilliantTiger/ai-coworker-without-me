import type { Server } from 'bun'
import type { Bridge } from './bridge'
import { randomToken } from './crypto'

// 사람이 브라우저로 대화를 지켜보는 화면. 이 PC 안(127.0.0.1)에서만 열리고, 주소에 든 토큰을 알아야 볼 수 있다.
// 상대가 보낸 글은 화면에 글자로만 넣는다. HTML 로 해석하지 않는다.
export class Viewer {
  private server?: Server<undefined>
  private readonly token = randomToken()

  constructor(private readonly bridge: Bridge) {}

  get url() {
    return this.server && `http://127.0.0.1:${this.server.port}/${this.token}`
  }

  start(): string {
    this.server ??= Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: req => this.handle(req) })
    return this.url!
  }

  stop() {
    this.server?.stop(true)
    this.server = undefined
  }

  data() {
    return { me: this.bridge.describe(), conversations: [...this.bridge.threads.values()] }
  }

  private handle(req: Request): Response {
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
    return new Response('not found', { status: 404 })
  }
}

const PAGE = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Coworker 대화</title>
<style>
:root { --bg: #f7f7f5; --card: #fff; --text: #1d1d1b; --muted: #6b6b66; --line: #e3e2dd; --in: #e8f0fe; --out: #eaf6ec; --note: #fdf5e2; --accent: #2f5bd3; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #161615; --card: #20201e; --text: #ecebe6; --muted: #9c9b95; --line: #34332f; --in: #1f2a40; --out: #1e3324; --note: #3a321e; --accent: #8aa8ff; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 20px; margin: 0 0 4px; }
.me, .meta, .time, .empty, .refresh { color: var(--muted); font-size: 13px; }
.refresh { margin: 4px 0 20px; }
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
const KIND = { question: '질문', answer: '답', note: '알림' }
const STATUS = {
  waiting_for_peer: '상대 차례',
  your_turn: '이쪽 차례',
  checking_with_your_human: '이쪽 사람에게 확인 중',
  peer_checking_with_their_human: '상대가 자기 사람에게 확인 중',
  needs_human: '상한에 닿음 · 사람이 정할 차례',
}
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
    card.append(head, el('div', 'meta', (mine ? '받는 쪽: ' : '보낸 쪽: ') + where + (first ? ' · 시작 ' + time(first.at) : '')))
    for (const m of c.messages) {
      const box = el('div', 'msg' + (m.from === 'me' ? ' mine' : '') + (m.kind === 'note' ? ' note' : ''))
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
async function load() {
  try {
    const res = await fetch(location.pathname + '/data', { cache: 'no-store' })
    if (!res.ok) throw new Error(res.status)
    render(await res.json())
    document.getElementById('refresh').textContent = '3초마다 새로 고침 · 마지막 ' + time(new Date().toISOString())
  } catch {
    document.getElementById('refresh').textContent = '세션에 닿지 않습니다. 세션이 끝났으면 이 화면은 더 바뀌지 않습니다.'
  }
}
load()
setInterval(load, 3000)
</script>
</body>
</html>
`
