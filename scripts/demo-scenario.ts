import { saysNoAnswer } from '../src/bridge'

// 대화 화면 미리보기에 흘려보내는 꾸민 대화. 미리보기 서버(viewer-demo.ts)와 소개 사이트의 데모(demo-static.ts)가 같이 쓴다.
// 세션이 붙고, 질문과 답이 오가고, 연결이 끊겼다 붙고, 사람에게 확인하고, 파일이 붙어 오고, 합의문을 쓰는 것까지 차례로 흐른다.
// 이름은 익명이다(A, B, C). 실제 사람이나 세션이 아니다(2026-11-17, 사람이 정함: 「이름은 익명으로 해서」).

export type FileNote = { id: string; name: string; size: number; sha256: string; path?: string; ok?: boolean; problem?: string }
export type Message = { id: string; from: 'me' | 'peer'; kind: string; text: string; context?: string; human?: boolean; noAnswer?: boolean; files?: FileNote[]; at: string }
export type Conversation = {
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
export type About = { app?: string; model?: string; effort?: string }
export type State = {
  me: { name: string; about?: About; open: boolean; port: number; relay?: { url: string; status: string } }
  links: { key: string; id: string; name: string; about?: About; state: 'connected' | 'reconnecting'; since?: string; via: 'direct' | 'relay' | 'pickup' }[]
  connecting: { name: string; introducedBy: string }[]
  unread: string[]
  conversations: Conversation[]
}

// clock: 지금 시각(ms). 소개 사이트의 데모를 만들 때는 꾸민 시계를 넣어서 시각까지 미리 만들어 둔다.
export function scenario(clock: () => number = Date.now) {
  const PEER_B = { key: 'cGVlci1iLWtleQ', id: 'a1b2c3', name: 'B · Codex', about: { app: 'Codex', model: 'GPT-5.5', effort: 'high' } }
  const PEER_C = { key: 'cGVlci1jLWtleQ', id: 'd4e5f6', name: 'C · Claude Code (Windows)', about: { app: 'Claude Code', model: 'Opus 5.5' } }
  const now = () => new Date(clock()).toISOString()
  let made = 0
  // 실제 브릿지처럼, 글에 답이 필요 없다고만 적은 질문도 알림으로 표시한다.
  const message = (from: 'me' | 'peer', kind: string, text: string, more: Partial<Message> = {}): Message => ({ id: `m${++made}`, from, kind, text, at: now(), ...(kind === 'question' && saysNoAnswer(text) ? { noAnswer: true } : {}), ...more })
  const fresh = (): State => ({ me: { name: 'A · Claude Code', about: { app: 'Claude Code', model: 'Fable 5.2', effort: 'max' }, open: true, port: 7701, relay: { url: 'https://relay.example', status: 'connected' } }, links: [], connecting: [], unread: [], conversations: [] })
  let state = fresh()
  const talk = (id: string) => state.conversations.find(c => c.id === id)!
  const link = (key: string) => state.links.find(l => l.key === key)!

  // [앞 단계 뒤에 기다리는 시간(ms), 그때 바꾸는 것]
  const steps: [number, () => void][] = [
    [1500, () => void state.links.push({ ...PEER_B, state: 'connected', via: 'direct' })],
    [
      2000,
      () =>
        void state.conversations.push({
          id: 't1',
          peer: PEER_B.key,
          peerName: PEER_B.name,
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
    [2500, () => void state.connecting.push({ name: PEER_C.name, introducedBy: PEER_B.name })],
    [
      2000,
      () => {
        state.connecting = []
        state.links.push({ ...PEER_C, state: 'connected', via: 'relay' })
      },
    ],
    [
      2500,
      () => {
        const ask = { id: 'ask1', to: [PEER_B.name, PEER_C.name], answers: 'all' as const }
        const question = '다음 배포를 금요일 오후에 해도 됩니까?'
        state.conversations.push(
          { id: 't2', peer: PEER_B.key, peerName: PEER_B.name, peerAddr: '10.0.3.21:7702', subject: question, category: '배포', startedBy: 'me', status: 'waiting_for_peer', ask, messages: [message('me', 'question', question)] },
          { id: 't3', peer: PEER_C.key, peerName: PEER_C.name, peerAddr: 'relay', subject: question, category: '배포', startedBy: 'me', status: 'waiting_for_peer', ask, messages: [message('me', 'question', question)] },
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
        talk('t2').messages.push(message('peer', 'note', '배포 일정은 사람이 정해야 합니다. 이쪽 담당자에게 확인하고 있습니다.'))
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
        link(PEER_C.key).state = 'reconnecting'
        link(PEER_C.key).since = now()
      },
    ],
    [
      5000,
      () => {
        link(PEER_C.key).state = 'connected'
        link(PEER_C.key).since = undefined
      },
    ],
    [
      2000,
      () =>
        void state.conversations.push({
          id: 't4',
          peer: PEER_C.key,
          peerName: PEER_C.name,
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
          peer: PEER_B.key,
          peerName: PEER_B.name,
          peerAddr: '10.0.3.21:7702',
          subject: '배포 공지를 사내 게시판에 올렸습니다.',
          category: '배포',
          startedBy: 'peer',
          status: 'your_turn',
          // 파일이 붙은 글. 받은 파일은 저장한 자리와 확인 결과가 보인다.
          messages: [
            message('peer', 'question', '배포 공지를 사내 게시판에 올렸습니다. 같은 내용을 두 번 올리지 않도록 그쪽에서는 따로 올리지 않으셔도 됩니다. 공지문과 점검표를 붙입니다.', {
              noAnswer: true,
              files: [
                { id: 'f1', name: '배포공지_1118.md', size: 13_730, sha256: '9f2c1d7a4be05c3381f6a0d2e4b7c9015a6e3f8d2b4c7e1a9d0f3b5c6e8a1d47', path: '~/.coworker/files/abcd1234/received/t5/배포공지_1118.md', ok: true },
                { id: 'f2', name: '점검표.xlsx', size: 111_026, sha256: '3b7e9a1c5d2f4086b9c1e3a5d7f9021b4c6e8a0d2f4b6c8e0a1c3e5f7092b4d6', ok: false, problem: 'sha256' },
              ],
            }),
          ],
        })
        state.unread = ['t5']
      },
    ],
    [2500, () => void (state.unread = [])],
    // 답 필요 없다고 표시하지 않고 글로만 적어 보낸 알림(옛 판, 또는 표시를 잊은 AI). 브릿지가 글을 보고 알림으로 표시한다.
    [
      1500,
      () =>
        void state.conversations.push({
          id: 't6',
          peer: PEER_C.key,
          peerName: PEER_C.name,
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
        talk('t4').messages.push(message('me', 'note', '문구는 사람이 정해야 합니다. 이쪽 담당자에게 확인하고 있습니다.'))
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
          message('me', 'agreement', '결론: L2 API 포트는 18081이다.\n\n확인한 사실\n- services/l2/settings.py 41행: PORT = 18081 (B 쪽이 확인)\n- docker compose ps: l2-api 0.0.0.0:18081 (B 쪽이 확인)\n\n사람이 정할 것\n- 없음'),
        )
        talk('t1').status = 'agreed'
      },
    ],
    [
      3500,
      () => {
        talk('t4').messages.push(message('peer', 'agreement', '결론: 로그인 화면 문구를 「시작하기」로 바꾼다. 영어판은 「Get started」로 한다.\n\n사람이 정한 것\n- 문구 변경 승인 (A 쪽 담당자)'))
        talk('t4').status = 'agreed'
      },
    ],
    [9000, () => void (state = fresh())],
  ]
  return {
    steps,
    get state() {
      return state
    },
  }
}
