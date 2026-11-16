import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// 채팅창 위 띠(plugin/hooks/band.tsx)의 시험. `bun scripts/mod-test.ts` 가 플러그인 폴더의 사본에 넣어 `claude plugin test` 로 돌린다.
// 플러그인 폴더에 두지 않는다. 설치되는 폴더에 시험을 싣지 않고, `bun test` 가 이 파일을 집지 않게 하려는 것이다.

const BAND = {
  plugin: 'coworker',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const
// 서버에서 읽는 주소와, 띠가 사람에게 내미는 링크.
const VIEWER = 'http://127.0.0.1:7777/tok'
const LINK = 'http://localhost:7777/tok'

// 엔진 자리에 서는 것들: 세션 ID, 환경 변수, MCP 서버가 저장해 둔 상태 파일, 대화 보기 서버.
function world(on: On, saved: boolean, answers: Record<string, { status: number; body?: unknown }>) {
  mock.env(on, { HOME: '/home/u' })
  on('session.id', () => ({ value: 'session-1' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.exists', (_, e) => ({ value: saved && e.path === '/home/u/.coworker/sessions/session-1.json' }))
  on('fs.read', () => ({ value: JSON.stringify({ viewer: { port: 7777, token: 'tok' }, keys: 'not for the band' }) }))
  on('http.fetch', (_, e) => {
    const a = answers[e.url] ?? { status: 404 }

    return { value: { status: a.status, ok: a.status === 200, headers: {}, text: JSON.stringify(a.body ?? {}) } }
  })
}

test('the band shows who is connected, what waits, and the viewer link', async ($, on) => {
  const clock = mock.clock(on)
  world(on, true, {
    [`${VIEWER}/status`]: {
      status: 200,
      body: {
        name: '연규 · Claude Code',
        open: true,
        links: [
          { name: '민수 · Codex', state: 'connected' },
          { name: '지현 · Claude Code', state: 'reconnecting' },
        ],
        connecting: 1,
        waiting: { yours: 1, theirs: 0, yourHuman: 2, theirHuman: 0 },
      },
    },
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect((await ui.find({ type: 'Text', text: /민수/ }))?.text).toBe('민수 · Codex')
    expect((await ui.find({ type: 'Text', text: /지현/ }))?.text).toBe('지현 · Claude Code (다시 붙는 중)')
    expect((await ui.find({ type: 'Text', text: /소개받는 중/ }))?.text).toBe('소개받는 중 1')
    expect((await ui.find({ type: 'Text', text: /사람 결정 필요/ }))?.text).toBe('사람 결정 필요 2')
    expect((await ui.find({ type: 'Text', text: /답할 것/ }))?.text).toBe('답할 것 1')
    expect(await ui.find({ type: 'Text', text: /답 기다리는 중/ })).toBeUndefined()
    expect((await ui.find({ type: 'Link' }))?.props.href).toBe(LINK)
    await ui.unmount()
  }
})

test('a narrow band counts the sessions instead of naming them', async ($, on) => {
  const clock = mock.clock(on)
  world(on, true, {
    [`${VIEWER}/status`]: { status: 200, body: { name: 'A', open: true, links: [{ name: '민수 · Codex', state: 'connected' }, { name: '지현', state: 'reconnecting' }], connecting: 0, waiting: {} } },
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 60 }, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /^연결/ }))?.text).toBe('연결 1')
  expect((await ui.find({ type: 'Text', text: /다시 붙는 중/ }))?.text).toBe('다시 붙는 중 1')
  expect(await ui.find({ type: 'Text', text: /민수/ })).toBeUndefined()
  await ui.unmount()
})

test('a server from before 0.9 has no /status, so the band counts from the page data', async ($, on) => {
  const clock = mock.clock(on)
  world(on, true, {
    [`${VIEWER}/data`]: {
      status: 200,
      body: {
        me: { name: 'A', open: true },
        conversations: [
          // 상대가 물었고 아직 답하지 않았다.
          { status: 'your_turn', messages: [{ from: 'peer', kind: 'question' }] },
          // 이쪽이 물었고 답을 기다린다. 알림은 건너뛴다.
          { status: 'waiting_for_peer', messages: [{ from: 'me', kind: 'question' }, { from: 'peer', kind: 'note' }] },
          // 질문과 답으로 끝난 대화. 차례는 남아 있어도 세지 않는다.
          { status: 'your_turn', messages: [{ from: 'me', kind: 'question' }, { from: 'peer', kind: 'answer' }] },
          { status: 'agreed', messages: [] },
        ],
      },
    },
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /답할 것/ }))?.text).toBe('답할 것 1')
  expect((await ui.find({ type: 'Text', text: /답 기다리는 중/ }))?.text).toBe('답 기다리는 중 1')
  expect((await ui.find({ type: 'Link' }))?.props.href).toBe(LINK)
  await ui.unmount()
})

test('the band appears a few seconds after a bridge opens, and goes when it closes', async ($, on) => {
  const clock = mock.clock(on)
  let isOpen = false
  mock.env(on, { HOME: '/home/u' })
  on('session.id', () => ({ value: 'session-1' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.exists', () => ({ value: isOpen }))
  on('fs.read', () => ({ value: JSON.stringify({ viewer: { port: 7777, token: 'tok' } }) }))
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ name: 'A', open: isOpen, links: [], connecting: 0, waiting: {} }) } }))
  // 엔진이 그리는 자리. 띠가 아무것도 그리지 않으면 이것이 보인다.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  isOpen = true
  await clock.advance(12_000)
  expect((await ui.find({ type: 'Text', text: /연결된 세션 없음/ }))?.text).toBe('연결된 세션 없음')
  expect(await ui.find({ type: 'Link' })).toBeDefined()
  isOpen = false
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
