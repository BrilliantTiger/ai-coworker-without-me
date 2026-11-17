#!/usr/bin/env bun
import { PAGE } from '../src/page'
import { scenario } from './demo-scenario'

// 대화 화면을 꾸민 대화로 미리 본다. 진짜 세션과는 연결하지 않고, 아무것도 밖으로 보내지 않는다.
// 화면의 움직임을 손볼 때 쓴다. 대화의 내용은 demo-scenario.ts 에 있고, 끝까지 흐른 뒤 처음부터 되풀이한다.
//   bun scripts/viewer-demo.ts [포트]

const demo = scenario()
// 화면에서 고정한 대화. 데모가 처음으로 돌아가도 남는다.
const pins = new Set<string>()
const shown = () => ({ ...demo.state, conversations: demo.state.conversations.map(c => (pins.has(c.id) ? { ...c, pinned: true } : c)) })

const encoder = new TextEncoder()
const watchers = new Set<() => void>()
const port = Number(process.argv[2] ?? 7799)
const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  idleTimeout: 0,
  fetch(req) {
    const path = new URL(req.url).pathname
    if (path === '/demo')
      return new Response(PAGE, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'" },
      })
    if (path === '/demo/data') return Response.json(shown())
    // 고정 단추가 부르는 주소. 진짜 서버의 /pin 과 같은 모양이다.
    if (path === '/demo/pin' && req.method === 'POST')
      return req.json().then((body: { threads?: string[]; pinned?: boolean }) => {
        for (const id of body.threads ?? []) body.pinned ? pins.add(id) : pins.delete(id)
        for (const send of [...watchers]) send()
        return Response.json({ changed: (body.threads ?? []).length })
      })
    // 채팅창 위 띠가 읽는 짧은 요약. 진짜 서버의 /status 와 같은 모양이다.
    if (path === '/demo/status') {
      const waiting = { yours: 0, theirs: 0, yourHuman: 0, theirHuman: 0 }
      for (const c of demo.state.conversations) {
        const last = [...c.messages].reverse().find(m => m.kind === 'question' || m.kind === 'answer')
        if (c.status === 'checking_with_your_human') waiting.yourHuman++
        else if (c.status === 'peer_checking_with_their_human') waiting.theirHuman++
        else if (last?.kind === 'question' && !last.noAnswer) last.from === 'me' ? waiting.theirs++ : waiting.yours++
      }
      const recent = demo.state.conversations
        .flatMap(c => c.messages.map(m => ({ id: m.id, thread: c.id, at: m.at, from: m.from, peer: c.peerName, kind: m.kind, text: m.text.slice(0, 400), category: c.category, noAnswer: m.noAnswer, human: m.human })))
        .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
        .slice(-8)
      const rooms = new Set(demo.state.conversations.map(c => (c.ask && c.startedBy === 'me' ? `ask:${c.ask.id}` : c.id))).size
      return Response.json({
        name: demo.state.me.name,
        about: demo.state.me.about,
        open: demo.state.me.open,
        links: demo.state.links.map(l => ({ name: l.name, state: l.state, about: l.about })),
        connecting: demo.state.connecting.length,
        waiting,
        counts: { conversations: rooms, messages: demo.state.conversations.reduce((n, c) => n + c.messages.length, 0) },
        recent,
      })
    }
    // 접근키 발급 단추가 부르는 주소. 진짜 코드가 아니라 모양만 같은 글자를 돌려준다.
    if (path === '/demo/code' && req.method === 'POST')
      return Response.json({ code: `cw1.${Buffer.from(crypto.getRandomValues(new Uint8Array(96))).toString('base64url')}`, expires: new Date(Date.now() + 3_600_000).toISOString() })
    if (path !== '/demo/events') return new Response('not found', { status: 404 })
    let stop = () => {}
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = () => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(shown())}\n\n`))
          } catch {
            stop()
          }
        }
        watchers.add(send)
        stop = () => void watchers.delete(send)
        req.signal.addEventListener('abort', stop)
        send()
      },
      cancel: () => stop(),
    })
    return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' } })
  },
})
console.log(`대화 화면 미리보기: http://127.0.0.1:${server.port}/demo  (Ctrl+C 로 끝냅니다)`)

for (;;)
  for (const [wait, change] of demo.steps) {
    await Bun.sleep(wait)
    change()
    for (const send of [...watchers]) send()
  }
