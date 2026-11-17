#!/usr/bin/env bun
import { PAGE } from '../src/page'

// 대화 화면을 가짜 대화로 미리 본다. 진짜 세션과는 연결하지 않고, 아무것도 밖으로 보내지 않는다.
// 화면의 움직임을 손볼 때 쓴다. 세션이 붙고, 질문과 답이 오가고, 연결이 끊겼다 붙고,
// 사람에게 확인하고, 합의문을 쓰는 것까지 차례로 흘려보낸 뒤 처음부터 되풀이한다.
//   bun scripts/viewer-demo.ts [포트]

type Message = { id: string; from: 'me' | 'peer'; kind: string; text: string; context?: string; human?: boolean; noAnswer?: boolean; at: string }
type Conversation = {
  id: string
  peer: string
  peerName: string
  peerAddr?: string
  subject: string
  startedBy: 'me' | 'peer'
  status: string
  ask?: { id: string; to: string[]; answers: 'all' | 'one' }
  category?: string
  humanSince?: string
  messages: Message[]
}
type About = { app?: string; model?: string; effort?: string }
type State = {
  me: { name: string; about?: About; open: boolean; port: number; relay?: { url: string; status: string } }
  links: { key: string; id: string; name: string; about?: About; state: 'connected' | 'reconnecting'; since?: string; via: 'direct' | 'relay' | 'pickup' }[]
  connecting: { name: string; introducedBy: string }[]
  unread: string[]
  conversations: Conversation[]
}

const MINSU = { key: 'bWluc3Uta2V5', id: 'a1b2c3', name: '민수 · Codex', about: { app: 'Codex', model: 'GPT-5.5', effort: 'high' } }
const JIHYEON = { key: 'amloeWVvbi1rZXk', id: 'd4e5f6', name: '지현 · Claude Code (Windows)', about: { app: 'Claude Code', model: 'Opus 5.5' } }
const now = () => new Date().toISOString()
let made = 0
const message = (from: 'me' | 'peer', kind: string, text: string, more: Partial<Message> = {}): Message => ({ id: `m${++made}`, from, kind, text, at: now(), ...more })
const fresh = (): State => ({ me: { name: '연규 · Claude Code', about: { app: 'Claude Code', model: 'Fable 5.2', effort: 'max' }, open: true, port: 7701, relay: { url: 'https://relay.example', status: 'connected' } }, links: [], connecting: [], unread: [], conversations: [] })
let state = fresh()
const talk = (id: string) => state.conversations.find(c => c.id === id)!
const link = (key: string) => state.links.find(l => l.key === key)!

// [앞 단계 뒤에 기다리는 시간(ms), 그때 바꾸는 것]
const steps: [number, () => void][] = [
  [1500, () => void state.links.push({ ...MINSU, state: 'connected', via: 'direct' })],
  [
    2000,
    () =>
      void state.conversations.push({
        id: 't1',
        peer: MINSU.key,
        peerName: MINSU.name,
        peerAddr: '10.0.3.21:7702',
        subject: 'L2 API가 쓰는 포트가 18001이 맞습니까?',
        category: 'API',
        startedBy: 'me',
        status: 'waiting_for_peer',
        messages: [message('me', 'question', 'L2 API가 쓰는 포트가 18001이 맞습니까?', { context: 'compose.yaml 에는 18001과 18081이 둘 다 나옵니다. 화면은 18081로 부릅니다.' })],
      }),
  ],
  [
    3500,
    () => {
      talk('t1').messages.push(message('peer', 'answer', '아닙니다. L2 API는 18081입니다. 18001은 L1 API입니다.\n근거: services/l2/settings.py 41행의 PORT = 18081, 그리고 docker compose ps 결과에 l2-api 0.0.0.0:18081 이 나옵니다.'))
      talk('t1').status = 'your_turn'
    },
  ],
  [2500, () => void state.connecting.push({ name: JIHYEON.name, introducedBy: MINSU.name })],
  [
    2000,
    () => {
      state.connecting = []
      state.links.push({ ...JIHYEON, state: 'connected', via: 'relay' })
    },
  ],
  [
    2500,
    () => {
      const ask = { id: 'ask1', to: [MINSU.name, JIHYEON.name], answers: 'all' as const }
      const question = '다음 배포를 금요일 오후에 해도 됩니까?'
      state.conversations.push(
        { id: 't2', peer: MINSU.key, peerName: MINSU.name, peerAddr: '10.0.3.21:7702', subject: question, category: '배포', startedBy: 'me', status: 'waiting_for_peer', ask, messages: [message('me', 'question', question)] },
        { id: 't3', peer: JIHYEON.key, peerName: JIHYEON.name, peerAddr: 'relay', subject: question, category: '배포', startedBy: 'me', status: 'waiting_for_peer', ask, messages: [message('me', 'question', question)] },
      )
    },
  ],
  [
    3000,
    () => {
      talk('t3').messages.push(message('peer', 'answer', '프런트엔드는 됩니다. 금요일 14시 이후면 QA가 끝나 있습니다.'))
      talk('t3').status = 'your_turn'
    },
  ],
  [
    2500,
    () => {
      talk('t2').messages.push(message('peer', 'note', '배포 일정은 사람이 정해야 합니다. 민수 님에게 확인하고 있습니다.'))
      talk('t2').status = 'peer_checking_with_their_human'
      talk('t2').humanSince = now()
    },
  ],
  [
    6000,
    () => {
      talk('t2').messages.push(message('peer', 'answer', '금요일 16시에 합시다. 백엔드 마이그레이션이 15시에 끝납니다.', { human: true }))
      talk('t2').status = 'your_turn'
      talk('t2').humanSince = undefined
    },
  ],
  [
    2500,
    () => {
      link(JIHYEON.key).state = 'reconnecting'
      link(JIHYEON.key).since = now()
    },
  ],
  [
    5000,
    () => {
      link(JIHYEON.key).state = 'connected'
      link(JIHYEON.key).since = undefined
    },
  ],
  [
    2000,
    () =>
      void state.conversations.push({
        id: 't4',
        peer: JIHYEON.key,
        peerName: JIHYEON.name,
        peerAddr: 'relay',
        subject: '로그인 화면 문구를 「시작하기」로 바꿔도 됩니까?',
        category: 'UI 문구',
        startedBy: 'peer',
        status: 'your_turn',
        messages: [message('peer', 'question', '로그인 화면 문구를 「시작하기」로 바꿔도 됩니까?', { context: '디자인 시안 3번에 그렇게 적혀 있습니다.' })],
      }),
  ],
  // 답이 필요 없는 알림. 이쪽 AI가 읽기 전에는 눈에 띄게 두고, 읽은 뒤에는 조용히 둔다.
  [
    1500,
    () => {
      state.conversations.push({
        id: 't5',
        peer: MINSU.key,
        peerName: MINSU.name,
        peerAddr: '10.0.3.21:7702',
        subject: '배포 공지를 사내 게시판에 올렸습니다.',
        category: '배포',
        startedBy: 'peer',
        status: 'your_turn',
        messages: [message('peer', 'question', '배포 공지를 사내 게시판에 올렸습니다. 같은 내용을 두 번 올리지 않도록 그쪽에서는 따로 올리지 않으셔도 됩니다.', { noAnswer: true })],
      })
      state.unread = ['t5']
    },
  ],
  [2500, () => void (state.unread = [])],
  // 답 필요 없다고 표시하지 않고 글로만 적어 보낸 옛 판의 알림. 읽고 답하지 않으면 얼마 뒤 조용해진다(주소에 ?quiet=6000 을 붙이면 6초).
  [
    1500,
    () =>
      void state.conversations.push({
        id: 't6',
        peer: JIHYEON.key,
        peerName: JIHYEON.name,
        peerAddr: 'relay',
        subject: 'QA 서버를 14시에 다시 켰습니다. (답 필요 없습니다)',
        startedBy: 'peer',
        status: 'your_turn',
        messages: [message('peer', 'question', 'QA 서버를 14시에 다시 켰습니다. (답 필요 없습니다)')],
      }),
  ],
  [
    3000,
    () => {
      talk('t4').messages.push(message('me', 'note', '문구는 사람이 정해야 합니다. 연규 님에게 확인하고 있습니다.'))
      talk('t4').status = 'checking_with_your_human'
    },
  ],
  [
    5000,
    () => {
      talk('t4').messages.push(message('me', 'answer', '바꿔도 됩니다. 다만 영어판은 「Get started」로 맞춰 주세요.', { human: true }))
      talk('t4').status = 'waiting_for_peer'
    },
  ],
  [
    3000,
    () => {
      talk('t1').messages.push(message('me', 'answer', '확인했습니다. 화면 설정의 18081이 맞고, 문서의 18001을 고치겠습니다.'))
      talk('t1').status = 'waiting_for_peer'
    },
  ],
  [
    3000,
    () => {
      talk('t1').messages.push(
        message('me', 'agreement', '결론: L2 API 포트는 18081이다.\n\n확인한 사실\n- services/l2/settings.py 41행: PORT = 18081 (민수 쪽이 확인)\n- docker compose ps: l2-api 0.0.0.0:18081 (민수 쪽이 확인)\n\n사람이 정할 것\n- 없음'),
      )
      talk('t1').status = 'agreed'
    },
  ],
  [
    3500,
    () => {
      talk('t4').messages.push(message('peer', 'agreement', '결론: 로그인 화면 문구를 「시작하기」로 바꾼다. 영어판은 「Get started」로 한다.\n\n사람이 정한 것\n- 문구 변경 승인 (연규)'))
      talk('t4').status = 'agreed'
    },
  ],
  [9000, () => void (state = fresh())],
]

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
    if (path === '/demo/data') return Response.json(state)
    // 채팅창 위 띠가 읽는 짧은 요약. 진짜 서버의 /status 와 같은 모양이다.
    if (path === '/demo/status') {
      const waiting = { yours: 0, theirs: 0, yourHuman: 0, theirHuman: 0 }
      for (const c of state.conversations) {
        const last = [...c.messages].reverse().find(m => m.kind === 'question' || m.kind === 'answer')
        if (c.status === 'checking_with_your_human') waiting.yourHuman++
        else if (c.status === 'peer_checking_with_their_human') waiting.theirHuman++
        else if (last?.kind === 'question' && !last.noAnswer) last.from === 'me' ? waiting.theirs++ : waiting.yours++
      }
      const recent = state.conversations
        .flatMap(c => c.messages.map(m => ({ id: m.id, thread: c.id, at: m.at, from: m.from, peer: c.peerName, kind: m.kind, text: m.text.slice(0, 400), category: c.category, noAnswer: m.noAnswer, human: m.human })))
        .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
        .slice(-8)
      const rooms = new Set(state.conversations.map(c => (c.ask && c.startedBy === 'me' ? `ask:${c.ask.id}` : c.id))).size
      return Response.json({
        name: state.me.name,
        about: state.me.about,
        open: state.me.open,
        links: state.links.map(l => ({ name: l.name, state: l.state, about: l.about })),
        connecting: state.connecting.length,
        waiting,
        counts: { conversations: rooms, messages: state.conversations.reduce((n, c) => n + c.messages.length, 0) },
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
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(state)}\n\n`))
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
  for (const [wait, change] of steps) {
    await Bun.sleep(wait)
    change()
    for (const send of [...watchers]) send()
  }
