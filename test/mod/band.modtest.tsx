import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// 채팅창 위 카드(plugin/claude/band.tsx)의 시험. `bun scripts/mod-test.ts` 가 플러그인 폴더의 사본에 넣어 `claude plugin test` 로 돌린다.
// 플러그인 폴더에 두지 않는다. 설치되는 폴더에 시험을 싣지 않고, `bun test` 가 이 파일을 집지 않게 하려는 것이다.

const BAND = {
  plugin: 'coworker',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 12, bodyColumns: 120, scroll: { offset: 0, bodyRows: 12 }, view: {} },
} as const
// 서버에서 읽는 주소와, 카드가 사람에게 내미는 링크.
const VIEWER = 'http://127.0.0.1:7777/tok'
const LINK = 'http://localhost:7777/tok'

type Answer = { status: number; body?: unknown }
type World = { answers: Record<string, Answer>; posts: { url: string; body: string }[]; isSaved: boolean }

// 엔진 자리에 서는 것들: 세션 ID와 모델, 환경 변수, MCP 서버가 저장해 둔 상태 파일, 대화 보기 서버.
function world(on: On, answers: Record<string, Answer>): World {
  const w: World = { answers, posts: [], isSaved: true }
  mock.env(on, { HOME: '/home/u' })
  on('session.id', () => ({ value: 'session-1' }))
  on('session.model', () => ({ value: 'Fable 5.2' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.exists', (_, e) => ({ value: w.isSaved && e.path === '/home/u/.coworker/sessions/session-1.json' }))
  on('fs.read', () => ({ value: JSON.stringify({ viewer: { port: 7777, token: 'tok' }, keys: 'not for the band' }) }))
  on('http.fetch', (_, e) => {
    if (e.init?.method === 'POST') w.posts.push({ url: e.url, body: String(e.init.body ?? '') })
    const a = w.answers[e.url] ?? { status: 404 }

    return { value: { status: a.status, ok: a.status === 200, headers: {}, text: JSON.stringify(a.body ?? {}) } }
  })

  return w
}

const message = (id: string, from: 'me' | 'peer', kind: string, text: string, more: Record<string, unknown> = {}) => ({ id, thread: 't1', at: `2026-11-17T03:00:${id.padStart(2, '0')}.000Z`, from, peer: '민수 · Codex', kind, text, ...more })
const summary = (more: Record<string, unknown> = {}) => ({
  name: '연규 · Claude Code',
  open: true,
  links: [{ name: '민수 · Codex', state: 'connected', about: { app: 'Codex', model: 'GPT-5.5', effort: 'high' } }],
  connecting: 0,
  waiting: { yours: 0, theirs: 0, yourHuman: 0, theirHuman: 0 },
  counts: { conversations: 3, messages: 12 },
  recent: [message('1', 'me', 'question', 'Which port?')],
  ...more,
})

test('the card shows who is connected and what they run, the counts, what waits, and the viewer link', async ($, on) => {
  const clock = mock.clock(on)
  world(on, {
    [`${VIEWER}/status`]: {
      status: 200,
      body: summary({
        links: [
          { name: '민수 · Codex', state: 'connected', about: { app: 'Codex', model: 'GPT-5.5', effort: 'high' } },
          { name: '지현 · Claude Code', state: 'reconnecting' },
        ],
        connecting: 1,
        waiting: { yours: 1, theirs: 0, yourHuman: 2, theirHuman: 0 },
      }),
    },
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect((await ui.find({ type: 'Text', text: /^민수/ }))?.text).toBe('민수 · Codex')
    expect((await ui.find({ type: 'Text', text: /GPT-5.5/ }))?.text).toBe('‹Codex · GPT-5.5 · high›')
    expect((await ui.find({ type: 'Text', text: /지현/ }))?.text).toBe('지현 · Claude Code (다시 붙는 중)')
    expect((await ui.find({ type: 'Text', text: /소개받는 중/ }))?.text).toBe('소개받는 중 1')
    expect((await ui.find({ type: 'Text', text: /^대화/ }))?.text).toBe('대화 3 · 글 12')
    expect((await ui.find({ type: 'Text', text: /사람 결정 필요/ }))?.text).toBe('사람 결정 필요 2')
    expect((await ui.find({ type: 'Text', text: /답할 것/ }))?.text).toBe('답할 것 1')
    expect(await ui.find({ type: 'Text', text: /답 기다리는 중/ })).toBeUndefined()
    expect((await ui.find({ type: 'Link' }))?.props.href).toBe(LINK)
    // 카드다: 테두리가 있다. 새 글이 없으면 흐리게 둔다.
    expect((await ui.findAll({ type: 'Box' })).some(b => b.props.borderStyle === 'round' && b.props.borderDimColor === true)).toBe(true)
    await ui.unmount()
  }
})

test('a narrow card counts the sessions instead of naming them', async ($, on) => {
  const clock = mock.clock(on)
  world(on, {
    [`${VIEWER}/status`]: { status: 200, body: summary({ links: [{ name: '민수 · Codex', state: 'connected' }, { name: '지현', state: 'reconnecting' }] }) },
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 60 }, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /^연결/ }))?.text).toBe('연결 1')
  expect((await ui.find({ type: 'Text', text: /다시 붙는 중/ }))?.text).toBe('다시 붙는 중 1')
  expect(await ui.find({ type: 'Text', text: /민수/ })).toBeUndefined()
  await ui.unmount()
})

test('a question or an answer that arrives makes the card grow, then shrink to one line, then go', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, { [`${VIEWER}/status`]: { status: 200, body: summary() } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // 카드를 처음 그릴 때 이미 있던 글은 새 글로 치지 않는다.
  expect(await ui.find({ type: 'Text', text: /새 질문|새 답/ })).toBeUndefined()

  // 이쪽이 보낸 글은 카드를 펼치지 않는다.
  w.answers[`${VIEWER}/status`] = { status: 200, body: summary({ recent: [message('1', 'me', 'question', 'Which port?'), message('2', 'me', 'answer', 'my own words')] }) }
  await clock.advance(4000)
  expect(await ui.find({ type: 'Text', text: /my own words/ })).toBeUndefined()

  // 받은 답은 펼친다: 누가 보냈는지, 분류, 글의 앞부분.
  const answer = message('3', 'peer', 'answer', '18081 입니다. settings.py 41행에 있습니다.', { category: 'API', human: true })
  w.answers[`${VIEWER}/status`] = { status: 200, body: summary({ recent: [message('1', 'me', 'question', 'Which port?'), answer] }) }
  await clock.advance(4000)
  expect((await ui.find({ type: 'Text', text: /^새 답/ }))?.text).toBe('새 답')
  expect((await ui.find({ type: 'Text', text: /^\[API\]/ }))?.text).toBe('[API]')
  expect((await ui.find({ type: 'Text', text: /→ 나/ }))?.text).toBe('민수 · Codex → 나 · 방금')
  expect((await ui.find({ type: 'Text', text: /사람이 정함/ }))?.text).toBe('사람이 정함')
  // 처음에는 머리줄만 있고, 박자마다 글이 한 줄씩 자란다.
  expect(await ui.find({ type: 'Text', text: /18081/ })).toBeUndefined()
  await clock.advance(150)
  expect((await ui.find({ type: 'Text', text: /18081/ }))?.text).toBe('18081 입니다. settings.py 41행에 있습니다.')
  expect((await ui.findAll({ type: 'Box' })).some(b => b.props.borderStyle === 'round' && b.props.borderColor === 'success' && b.props.borderDimColor === false)).toBe(true)

  // 얼마 뒤 한 줄로 줄어든다.
  await clock.advance(21_000)
  expect(await ui.find({ type: 'Text', text: /^새 답/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^↳/ }))?.text).toContain('↳ 새 답 [API] · 민수 · Codex → 나')
  // 몇 분 뒤에는 사라진다.
  await clock.advance(180_000)
  expect(await ui.find({ type: 'Text', text: /^↳/ })).toBeUndefined()
  await ui.unmount()
})

test('several arrivals: the newest is open, earlier ones are one line each, the rest are counted, and 닫기 clears them', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, { [`${VIEWER}/status`]: { status: 200, body: summary() } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const four = ['3', '4', '5', '6'].map((id, i) => message(id, 'peer', i === 3 ? 'question' : 'answer', `글 ${id}`, i === 3 ? { noAnswer: true } : {}))
  w.answers[`${VIEWER}/status`] = { status: 200, body: summary({ recent: [message('1', 'me', 'question', 'Which port?'), ...four] }) }
  await clock.advance(4000)
  await clock.advance(600)

  // 가장 새 글(답이 필요 없는 알림)이 펼쳐진다.
  expect((await ui.find({ type: 'Text', text: /^새 알림/ }))?.text).toBe('새 알림')
  expect((await ui.find({ type: 'Text', text: /^글 6/ }))?.text).toBe('글 6')
  // 앞의 둘은 한 줄씩, 그보다 앞은 수로.
  expect((await ui.findAll({ type: 'Text', text: /^↳/ })).map(t => t.text.includes('글 4') || t.text.includes('글 5'))).toEqual([true, true])
  expect((await ui.find({ type: 'Text', text: /건 더/ }))?.text).toBe('+1건 더 있습니다. 대화 보기에서 봅니다.')

  await ui.press({ key: `close ${LINK}` })
  expect(await ui.find({ type: 'Text', text: /^새 알림/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^↳/ })).toBeUndefined()
  // 닫아도 카드의 첫 줄은 남는다.
  expect((await ui.find({ type: 'Link' }))?.props.href).toBe(LINK)
  await ui.unmount()
})

// 옛 판 서버의 화면 자료. 요약이 없거나 모자라면 카드가 이것으로 센다.
const PAGE = {
  me: { name: 'A', open: true },
  unread: [],
  conversations: [
    // 상대가 물었고 아직 답하지 않았다.
    { id: 'a', status: 'your_turn', messages: [{ id: 'm1', from: 'peer', kind: 'question', text: 'q', at: '2026-11-17T03:00:00.000Z' }] },
    // 질문과 답으로 끝난 대화. 차례는 남아 있어도 세지 않는다.
    {
      id: 'b',
      status: 'your_turn',
      messages: [
        { id: 'm2', from: 'me', kind: 'question', text: 'q', at: '2026-11-17T03:00:01.000Z' },
        { id: 'm3', from: 'peer', kind: 'answer', text: 'a', at: '2026-11-17T03:00:02.000Z' },
      ],
    },
    // 답이 필요 없는 알림.
    { id: 'c', status: 'your_turn', messages: [{ id: 'm4', from: 'peer', kind: 'question', text: 'fyi', noAnswer: true, at: '2026-11-17T03:00:03.000Z' }] },
  ],
}

for (const [name, status] of [
  ['a server before 0.11 has no counts in /status, so the card counts from the page data', { status: 200, body: { name: 'A', open: true, links: [{ name: '민수 · Codex', state: 'connected' }], connecting: 0, waiting: {} } }],
  ['a server before 0.9 has no /status at all, so the card counts from the page data', { status: 404 }],
] as const)
  test(name, async ($, on) => {
    const clock = mock.clock(on, { now: Date.parse('2026-11-17T03:01:00.000Z') })
    world(on, { [`${VIEWER}/status`]: status, [`${VIEWER}/data`]: { status: 200, body: PAGE } })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await clock.settle()
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    expect((await ui.find({ type: 'Text', text: /^대화/ }))?.text).toBe('대화 3 · 글 4')
    expect((await ui.find({ type: 'Text', text: /답할 것/ }))?.text).toBe('답할 것 1')
    expect((await ui.find({ type: 'Link' }))?.props.href).toBe(LINK)
    await ui.unmount()
  })

test('the card tells the session which model and effort this Claude Code runs, once, and again when they change', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, { [`${VIEWER}/status`]: { status: 200, body: summary() }, [`${VIEWER}/about`]: { status: 200 } })
  // 엔진 자리: 차례가 끝났다는 훅에는 아무것도 답하지 않는다.
  on('classic.Stop', () => ({}))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  // 모델은 Claude Code 에서 읽는다. 강도는 차례가 끝날 때 안다.
  expect(w.posts).toEqual([{ url: `${VIEWER}/about`, body: JSON.stringify({ model: 'Fable 5.2' }) }])
  await clock.advance(8000)
  expect(w.posts).toHaveLength(1)
  await $.classic.Stop({ stop_hook_active: false, effort: { level: 'max' } } as never)
  await clock.advance(4000)
  expect(w.posts[1]).toEqual({ url: `${VIEWER}/about`, body: JSON.stringify({ model: 'Fable 5.2', effort: 'max' }) })
})

test('the card appears a few seconds after a bridge opens, and goes when it closes', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, {})
  w.isSaved = false
  // 엔진이 그리는 자리. 카드가 아무것도 그리지 않으면 이것이 보인다.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  w.isSaved = true
  w.answers[`${VIEWER}/status`] = { status: 200, body: summary({ links: [] }) }
  await clock.advance(12_000)
  expect((await ui.find({ type: 'Text', text: /연결된 세션 없음/ }))?.text).toBe('연결된 세션 없음')
  expect(await ui.find({ type: 'Link' })).toBeDefined()
  w.answers[`${VIEWER}/status`] = { status: 200, body: summary({ open: false }) }
  await clock.advance(30_000)
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('a session with no screen reads nothing', async ($, on) => {
  const clock = mock.clock(on)
  let reads = 0
  mock.env(on, { HOME: '/home/u' })
  on('session.id', () => ({ value: 'session-1' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.exists', () => {
    reads += 1

    return { value: false }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })
  await clock.advance(60_000)
  expect(reads).toBe(0)
})
