import type { EngineInterface, Register } from 'claude-code'

// Claude Code 의 채팅창 위에 이 세션의 coworker 연결 상태와 대화 보기 링크를 한 줄로 보여 준다
// (2026-11-16, 사람이 정함: 「coworker가 띄워져있으면 채팅창 위에 coworker 연결 상태랑 viewer 링크 클릭할 수 있게」).
// 브릿지를 열지 않은 세션에서는 아무것도 그리지 않는다.
//
// 자료는 이 세션의 MCP 서버가 이 PC 안(127.0.0.1)에 연 대화 보기 서버에서 읽는다. 그 주소는 MCP 서버가 저장해 둔
// 상태 파일(~/.coworker/sessions/<세션 ID>.json)에 있다. 대화 글은 읽지 않는다. 연결된 세션의 이름과 닿는지,
// 답을 기다리는 대화가 몇 개인지만 읽는다. 밖으로는 아무것도 보내지 않는다.

// 이 폴더(claude/)에 두는 까닭: Codex 도 플러그인의 hooks/hooks.json 을 읽는다. 이 파일은 Claude Code 만 읽어야 해서
// 따로 두고, .claude-plugin/plugin.json 의 hooks 가 claude/hooks.json 을 가리킨다.
// 그리는 값은 이 모듈이 들고 있다가 바뀌면 다시 그려 달라고 한다. $.state 를 쓰지 않은 것은, 그러려면 plugin.json 에
// 새 항목(types)을 넣어야 하는데 그 항목을 모르는 옛 Claude Code 가 플러그인 전체를 거절할 수 있어서다.

type Link = { name: string; state: 'connected' | 'reconnecting' }
// 이 세션이 연 브릿지 하나. url 은 사람이 누르는 대화 보기 주소다(http://localhost:포트/토큰).
// waiting 은 답을 빚진 대화의 수다. 대화는 대개 질문과 답으로 끝나므로, 답이 오간 대화는 세지 않는다.
// yours: 이쪽이 답할 것. theirs: 상대의 답을 기다리는 것. yourHuman/theirHuman: 사람의 결정을 기다리는 것.
type Bridge = {
  url: string
  name: string
  links: Link[]
  connecting: number
  waiting: { yours: number; theirs: number; yourHuman: number; theirHuman: number }
}

const EVERY_MS = 4000
// 브릿지가 없을 때는 이만큼의 박자마다 한 번만 상태 파일을 찾아본다.
const LOOK_EVERY = 3

const count = (value: unknown) => (typeof value === 'number' && value > 0 ? Math.floor(value) : 0)

// 상태 파일에서 대화 보기 주소를 찾는다. 플러그인으로 뜬 서버는 세션 ID, 직접 등록한 서버는 끝에 .direct 가 붙는다.
async function locate($: EngineInterface): Promise<string[]> {
  const id = await $.session.id()
  const home = (await $.env.get('COWORKER_HOME')) || `${(await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''}/.coworker`
  const found: string[] = []

  for (const label of [id, `${id}.direct`]) {
    const path = `${home}/sessions/${label.replace(/[^A-Za-z0-9._-]/g, '_')}.json`

    try {
      if (!(await $.fs.exists(path))) continue
      const viewer = JSON.parse(await $.fs.read(path))?.viewer

      if (Number.isInteger(viewer?.port) && typeof viewer?.token === 'string' && /^[\w-]+$/.test(viewer.token)) {
        found.push(`http://127.0.0.1:${viewer.port}/${viewer.token}`)
      }
    } catch {
      // 파일을 쓰는 중이었거나 읽지 못했다. 다음 박자에 다시 본다.
    }
  }

  return found
}

// 누가 답을 빚졌는지. 마지막으로 오간 글이 질문이면 받은 쪽이 빚졌고, 답이면 아무도 빚지지 않았다(서버의 owes 와 같다).
function owes(conversation: { messages?: unknown }): 'me' | 'peer' | undefined {
  const messages: { kind?: unknown; from?: unknown }[] = Array.isArray(conversation.messages) ? conversation.messages : []

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m?.kind === 'question') return m.from === 'me' ? 'peer' : 'me'
    if (m?.kind === 'answer') return undefined
  }

  return undefined
}

// 브릿지 하나의 지금 모습. 닫혔거나 닿지 않으면 없다고 돌려준다.
// 읽을 때는 서버가 듣는 127.0.0.1 로 읽고, 사람이 누를 링크는 localhost 로 적는다.
// Claude 데스크톱 앱은 https 가 아닌 링크 가운데 http://localhost 만 눌리게 한다(127.0.0.1 은 글자로만 그린다).
async function look($: EngineInterface, api: string): Promise<Bridge | undefined> {
  const url = api.replace('//127.0.0.1:', '//localhost:')
  const status = await $.http.fetch(`${api}/status`)

  if (status.ok) {
    const s = JSON.parse(status.text)
    if (!s?.open) return undefined
    const links = Array.isArray(s.links) ? s.links : []

    return {
      url,
      name: String(s.name ?? ''),
      links: links.map((l: { name?: unknown; state?: unknown }) => ({ name: String(l?.name ?? ''), state: l?.state === 'connected' ? 'connected' : 'reconnecting' })),
      connecting: count(s.connecting),
      waiting: { yours: count(s.waiting?.yours), theirs: count(s.waiting?.theirs), yourHuman: count(s.waiting?.yourHuman), theirHuman: count(s.waiting?.theirHuman) },
    }
  }

  // 0.8 이하 판의 서버에는 /status 가 없다. 그때는 화면 자료에서 대화만 센다. 누가 닿는지는 알 수 없다.
  if (status.status !== 404) return undefined
  const data = await $.http.fetch(`${api}/data`)
  if (!data.ok) return undefined
  const d = JSON.parse(data.text)
  if (!d?.me?.open) return undefined
  const waiting = { yours: 0, theirs: 0, yourHuman: 0, theirHuman: 0 }

  for (const c of Array.isArray(d.conversations) ? d.conversations : []) {
    if (c?.status === 'checking_with_your_human') waiting.yourHuman += 1
    else if (c?.status === 'peer_checking_with_their_human') waiting.theirHuman += 1
    else if (c?.status === 'your_turn' && owes(c) === 'me') waiting.yours += 1
    else if (c?.status === 'waiting_for_peer' && owes(c) === 'peer') waiting.theirs += 1
  }

  return { url, name: String(d.me.name ?? ''), links: [], connecting: 0, waiting }
}

// 다시 읽는 사이에 기억해 둘 것과 지금 그릴 것. 모듈을 다시 올리면 처음부터 다시 읽는다.
type Memo = { apis: string[]; ticks: number; isBusy: boolean; last: string; list: Bridge[] }

async function refresh($: EngineInterface, memo: Memo) {
  if (memo.isBusy) return
  memo.isBusy = true

  try {
    // 아는 주소가 없으면 가끔만 찾아본다. 있으면 20초쯤마다 다시 확인한다(브릿지를 닫았다가 새로 열면 주소가 바뀐다).
    if (memo.ticks % (memo.apis.length ? LOOK_EVERY * 2 : LOOK_EVERY) === 0) memo.apis = await locate($)
    memo.ticks += 1
    const found: Bridge[] = []

    for (const api of memo.apis) {
      const one = await look($, api).catch(() => undefined)
      if (one) found.push(one)
    }

    // 닿지 않으면 다음 박자에 주소부터 다시 찾는다.
    if (found.length < memo.apis.length) memo.ticks = 0
    const now = JSON.stringify(found)
    if (now === memo.last) return
    memo.last = now
    memo.list = found
    $.ui.invalidate('ui.render')
  } finally {
    memo.isBusy = false
  }
}

export const register: Register = on => {
  const memo: Memo = { apis: [], ticks: 0, isBusy: false, last: '[]', list: [] }

  on('session.start', ($, e, next) => {
    // 그릴 화면이 없는 세션(claude -p)에서는 읽지 않는다.
    if (e.isInteractive) {
      const poll = () => void refresh($, memo).catch(() => {})
      $.clock.every(EVERY_MS, poll)
      poll()
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    const list = memo.list
    if (e.props.hasSurvey || list.length === 0) return next(e)
    const { Box, Link, Text } = $.ui.resolve(e)
    const isNarrow = e.props.bodyColumns < 90

    return (
      <Box flexDirection="column">
        {list.map(b => {
          const down = b.links.filter(l => l.state !== 'connected')
          const isAlone = b.links.length === 0
          const w = b.waiting

          return (
            <Box columnGap={1} flexWrap="wrap">
              <Text color={isAlone ? 'inactive' : down.length ? 'warning' : 'success'}>{isAlone ? '○' : down.length ? '◐' : '●'}</Text>
              <Text bold>coworker</Text>
              {isAlone && <Text dimColor>연결된 세션 없음</Text>}
              {!isAlone && (isNarrow || b.links.length > 3) && <Text>연결 {b.links.length - down.length}</Text>}
              {!isAlone && (isNarrow || b.links.length > 3) && down.length > 0 && <Text color="warning">다시 붙는 중 {down.length}</Text>}
              {!isAlone &&
                !isNarrow &&
                b.links.length <= 3 &&
                b.links.map(l => (l.state === 'connected' ? <Text>{l.name}</Text> : <Text color="warning">{l.name} (다시 붙는 중)</Text>))}
              {b.connecting > 0 && <Text dimColor>소개받는 중 {b.connecting}</Text>}
              {w.yourHuman > 0 && (
                <Text color="warning" bold>
                  사람 결정 필요 {w.yourHuman}
                </Text>
              )}
              {w.yours > 0 && <Text color="success">답할 것 {w.yours}</Text>}
              {w.theirs > 0 && <Text dimColor>답 기다리는 중 {w.theirs}</Text>}
              {w.theirHuman > 0 && <Text dimColor>상대 쪽 사람 확인 {w.theirHuman}</Text>}
              <Link href={b.url} label="대화 보기" />
            </Box>
          )
        })}
      </Box>
    )
  })
}
