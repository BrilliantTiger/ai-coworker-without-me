import type { EngineInterface, Register } from 'claude-code'

// Claude Code 의 채팅창 위에 이 세션의 coworker 를 카드 하나로 보여 준다.
// (2026-11-16, 사람이 정함: 「coworker가 띄워져있으면 채팅창 위에 coworker 연결 상태랑 viewer 링크 클릭할 수 있게」.
//  2026-11-17, 사람이 정함: 「질문 대화 글수 이런 상태도」, 「카드형식으로 해서 질문이나 답받으면 그게 커지면서 보여주면」,
//  「여러개면 ui ux 고려해서」.)
// 평소에는 연결된 세션, 대화와 글의 수, 답을 기다리는 수, 대화 보기 링크를 한 줄로 보인다.
// 질문이나 답을 받으면 카드가 한 줄씩 자라면서 누가 무엇을 보냈는지 보이고, 얼마 뒤 한 줄로 줄었다가 사라진다.
// 여럿이 오면 가장 새 글만 펼치고, 앞의 글은 한 줄씩 쌓고, 넘치면 수로 줄인다.
// 브릿지를 열지 않은 세션에서는 아무것도 그리지 않는다.
//
// 자료는 이 세션의 MCP 서버가 이 PC 안(127.0.0.1)에 연 대화 보기 서버에서 읽는다. 그 주소는 MCP 서버가 저장해 둔
// 상태 파일(~/.coworker/sessions/<세션 ID>.json)에 있다. 읽는 것은 연결된 세션의 이름과 닿는지, 대화와 글의 수,
// 그리고 최근 글 몇 개의 앞부분이다. 밖으로는 아무것도 보내지 않는다.
// 이 세션의 모델과 강도(effort)는 이 모듈이 Claude Code 에서 읽어 MCP 서버에 알려 준다. 상대 세션이 그것을 본다.

// 이 폴더(claude/)에 두는 까닭: Codex 도 플러그인의 hooks/hooks.json 을 읽는다. 이 파일은 Claude Code 만 읽어야 해서
// 따로 두고, .claude-plugin/plugin.json 의 hooks 가 claude/hooks.json 을 가리킨다.
// 그리는 값은 이 모듈이 들고 있다가 바뀌면 다시 그려 달라고 한다. $.state 를 쓰지 않은 것은, 그러려면 plugin.json 에
// 새 항목(types)을 넣어야 하는데 그 항목을 모르는 옛 Claude Code 가 플러그인 전체를 거절할 수 있어서다.

type About = { app: string; model: string; effort: string }
type Link = { name: string; state: 'connected' | 'reconnecting'; about: About }
// 답을 빚진 대화의 수. yours: 이쪽이 답할 것. theirs: 상대의 답을 기다리는 것. yourHuman/theirHuman: 사람의 결정을 기다리는 것.
type Waiting = { yours: number; theirs: number; yourHuman: number; theirHuman: number }
// 최근에 오간 글 하나. text 는 앞부분만 온다.
type Recent = { id: string; from: 'me' | 'peer'; peer: string; kind: string; text: string; category: string; isNotice: boolean; isHuman: boolean }
// 이 세션이 연 브릿지 하나. api 는 읽는 주소(127.0.0.1), url 은 사람이 누르는 대화 보기 주소다(http://localhost:포트/토큰).
type Bridge = { api: string; url: string; name: string; links: Link[]; connecting: number; waiting: Waiting; conversations: number; messages: number; recent: Recent[] }
// 새로 받은 글 하나. bornAt 은 이 띠가 그 글을 처음 본 때다.
type Arrival = Recent & { url: string; bornAt: number }
// 다시 읽는 사이에 기억해 둘 것과 지금 그릴 것. 모듈을 다시 올리면 처음부터 다시 읽는다.
type Memo = { apis: string[]; ticks: number; isBusy: boolean; last: string; list: Bridge[]; seen: string[]; primed: string[]; arrivals: Arrival[]; effort: string; told: string }

const EVERY_MS = 4000
// 브릿지가 없을 때는 이만큼의 박자마다 한 번만 상태 파일을 찾아본다.
const LOOK_EVERY = 3
// 답 없이 이만큼 지난 질문은 세지 않는다(서버의 QUIET_AFTER_MS 와 같다). 옛 판 서버의 자료를 직접 셀 때만 쓴다.
const QUIET_MS = 5 * 60_000
// 새로 받은 글은 이만큼 펼쳐 보이고, 그 뒤 한 줄로 줄었다가, 이만큼 지나면 사라진다.
const OPEN_MS = 20_000
const KEEP_MS = 3 * 60_000
// 펼치고 접을 때 한 줄씩 움직이는 박자.
const GROW_MS = 140
const MAX_ARRIVALS = 5
const KIND: Record<string, string> = { question: '새 질문', answer: '새 답', note: '알림', closed: '마감', agreement: '합의문' }

const count = (value: unknown) => (typeof value === 'number' && value > 0 ? Math.floor(value) : 0)
const word = (value: unknown, max: number) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '')
// 외부용 코드로 이어진 세션은 이름 뒤에 표시를 붙인다. 그 이름은 그쪽이 정한 글이라 동료의 이름과 같을 수도 있다.
const marked = (name: string, outside: unknown) => (outside === true ? `${name} (외부)` : name)
const aboutOf = (value: unknown): About => {
  const v = (value ?? {}) as Record<string, unknown>

  return { app: word(v.app, 60), model: word(v.model, 60), effort: word(v.effort, 60) }
}
const said = (about: About) => [about.app, about.model, about.effort].filter(Boolean).join(' · ')

// 터미널에서 글자가 차지하는 칸 수. 한글과 한자, 전각 글자는 두 칸이다.
function cells(text: string): number {
  let n = 0

  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    const isWide = c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || c >= 0x1f300)
    n += isWide ? 2 : 1
  }

  return n
}

// 칸 수에 맞게 자른다. 잘렸으면 끝에 … 을 붙인다.
function clip(text: string, max: number): string {
  if (cells(text) <= max) return text
  let out = ''
  let used = 0

  for (const ch of text) {
    const w = cells(ch)
    if (used + w > max - 1) break
    out += ch
    used += w
  }

  return `${out}…`
}

function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 8) return '방금'
  if (s < 60) return `${s}초 전`

  return `${Math.floor(s / 60)}분 전`
}

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

type Turn = { kind?: unknown; from?: unknown; at?: unknown; noAnswer?: unknown }

// 옛 판 서버(0.10 이하)는 요약에 수와 최근 글이 없다. 그때는 화면 자료에서 직접 센다. 서버의 요약과 같은 규칙이다.
function fromPage(d: Record<string, unknown>, now: number): Pick<Bridge, 'waiting' | 'conversations' | 'messages' | 'recent'> {
  const waiting = { yours: 0, theirs: 0, yourHuman: 0, theirHuman: 0 }
  const conversations: Record<string, unknown>[] = Array.isArray(d.conversations) ? d.conversations : []
  const unread = new Set<unknown>(Array.isArray(d.unread) ? d.unread : [])
  const rooms = new Set<string>()
  const all: (Recent & { at: string })[] = []
  let messages = 0

  for (const c of conversations) {
    const turns: (Turn & Record<string, unknown>)[] = Array.isArray(c.messages) ? c.messages : []
    const ask = c.ask as { id?: unknown } | undefined
    rooms.add(ask && c.startedBy === 'me' ? `ask:${String(ask.id)}` : String(c.id))
    messages += turns.length
    for (const m of turns) {
      all.push({ id: String(m.id ?? ''), at: String(m.at ?? ''), from: m.from === 'me' ? 'me' : 'peer', peer: marked(word(c.peerName, 80), c.outside), kind: word(m.kind, 20), text: word(m.text, 400), category: word(c.category, 30), isNotice: m.noAnswer === true, isHuman: m.human === true })
    }
    if (c.status === 'checking_with_your_human') waiting.yourHuman += 1
    else if (c.status === 'peer_checking_with_their_human') waiting.theirHuman += 1
    else {
      const open = [...turns].reverse().find(m => m.kind === 'question' || m.kind === 'answer')
      if (!open || open.kind !== 'question' || open.noAnswer === true) continue
      const isFresh = now - Date.parse(String(open.at)) <= QUIET_MS
      if (c.status === 'your_turn' && open.from !== 'me' && (isFresh || unread.has(c.id))) waiting.yours += 1
      else if (c.status === 'waiting_for_peer' && open.from === 'me' && isFresh) waiting.theirs += 1
    }
  }

  all.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))

  return { waiting, conversations: rooms.size, messages, recent: all.slice(-8) }
}

// 브릿지 하나의 지금 모습. 닫혔거나 닿지 않으면 없다고 돌려준다.
// 읽을 때는 서버가 듣는 127.0.0.1 로 읽고, 사람이 누를 링크는 localhost 로 적는다.
// Claude 데스크톱 앱은 https 가 아닌 링크 가운데 http://localhost 만 눌리게 한다(127.0.0.1 은 글자로만 그린다).
// 주인이 대화 보기 주소를 정했으면 서버가 요약에 그 주소의 링크(link)를 넣어 준다. 그때는 그 링크를 보인다.
async function look($: EngineInterface, api: string, now: number): Promise<Bridge | undefined> {
  const status = await $.http.fetch(`${api}/status`)
  if (!status.ok && status.status !== 404) return undefined
  const s = status.ok ? JSON.parse(status.text) : undefined
  const url = typeof s?.link === 'string' && /^http:\/\/[\w.:\[\]-]+\/[\w-]+$/.test(s.link) ? s.link : api.replace('//127.0.0.1:', '//localhost:')
  if (s && !s.open) return undefined
  const links: Link[] = (Array.isArray(s?.links) ? s.links : []).map((l: Record<string, unknown>) => ({ name: marked(word(l?.name, 80), l?.outside), state: l?.state === 'connected' ? 'connected' : 'reconnecting', about: aboutOf(l?.about) }))

  if (s && Array.isArray(s.recent)) {
    const recent: Recent[] = s.recent.map((m: Record<string, unknown>) => ({ id: String(m?.id ?? ''), from: m?.from === 'me' ? 'me' : 'peer', peer: marked(word(m?.peer, 80), m?.outside), kind: word(m?.kind, 20), text: word(m?.text, 400), category: word(m?.category, 30), isNotice: m?.noAnswer === true, isHuman: m?.human === true }))

    return {
      api,
      url,
      name: word(s.name, 80),
      links,
      connecting: count(s.connecting),
      waiting: { yours: count(s.waiting?.yours), theirs: count(s.waiting?.theirs), yourHuman: count(s.waiting?.yourHuman), theirHuman: count(s.waiting?.theirHuman) },
      conversations: count(s.counts?.conversations),
      messages: count(s.counts?.messages),
      recent,
    }
  }

  const page = await $.http.fetch(`${api}/data`)
  if (!page.ok) return undefined
  const d = JSON.parse(page.text)
  if (!d?.me?.open) return undefined

  return { api, url, name: word(s?.name ?? d.me.name, 80), links, connecting: count(s?.connecting), ...fromPage(d, now) }
}

// 이 세션의 모델과 강도를 MCP 서버에 알린다. 서버가 상대 세션에 전한다. 달라졌을 때만 보낸다. 옛 판 서버는 받지 않는다.
async function tell($: EngineInterface, memo: Memo) {
  const model = word(await $.session.model().catch(() => ''), 60)
  const about = JSON.stringify({ model: model || undefined, effort: memo.effort || undefined })
  const sign = `${memo.list.map(b => b.api).join()} ${about}`
  if (about === '{}' || sign === memo.told || memo.list.length === 0) return
  memo.told = sign

  for (const b of memo.list) {
    await $.http.fetch(`${b.api}/about`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-coworker-viewer': '1' }, body: about }).catch(() => undefined)
  }
}

async function refresh($: EngineInterface, memo: Memo) {
  if (memo.isBusy) return
  memo.isBusy = true

  try {
    // 아는 주소가 없으면 가끔만 찾아본다. 있으면 20초쯤마다 다시 확인한다(브릿지를 닫았다가 새로 열면 주소가 바뀐다).
    if (memo.ticks % (memo.apis.length ? LOOK_EVERY * 2 : LOOK_EVERY) === 0) memo.apis = await locate($)
    memo.ticks += 1
    const now = await $.clock.now()
    const found: Bridge[] = []

    for (const api of memo.apis) {
      const one = await look($, api, now).catch(() => undefined)
      if (one) found.push(one)
    }

    // 닿지 않으면 다음 박자에 주소부터 다시 찾는다.
    if (found.length < memo.apis.length) memo.ticks = 0
    let isNew = false

    for (const b of found) {
      // 처음 본 브릿지의 지난 글은 새 글로 치지 않는다. 그 뒤에 온 글만 펼친다.
      const isPrimed = memo.primed.includes(b.url)
      if (!isPrimed) memo.primed.push(b.url)
      for (const m of b.recent) {
        if (m.id === '' || memo.seen.includes(m.id)) continue
        memo.seen.push(m.id)
        if (!isPrimed || m.from !== 'peer') continue
        memo.arrivals.push({ ...m, url: b.url, bornAt: now })
        isNew = true
      }
    }

    memo.seen = memo.seen.slice(-400)
    memo.arrivals = memo.arrivals.filter(a => now - a.bornAt < KEEP_MS).slice(-MAX_ARRIVALS)
    memo.list = found
    await tell($, memo).catch(() => undefined)
    const view = JSON.stringify([found, memo.arrivals.map(a => a.id)])
    // 펼친 글이 있는 동안에는 「몇 초 전」이 바뀌므로 박자마다 다시 그린다.
    if (view !== memo.last || memo.arrivals.length > 0) $.ui.invalidate('ui.render')
    memo.last = view
    // 한 줄씩 자라고, 시간이 되면 한 줄씩 줄어든다. 그때마다 다시 그린다.
    if (isNew) for (const ms of [GROW_MS, GROW_MS * 2, GROW_MS * 3, GROW_MS * 4, OPEN_MS - GROW_MS * 3, OPEN_MS - GROW_MS * 2, OPEN_MS - GROW_MS, OPEN_MS + 30]) $.clock.after(ms, () => $.ui.invalidate('ui.render'))
  } finally {
    memo.isBusy = false
  }
}

export const register: Register = on => {
  const memo: Memo = { apis: [], ticks: 0, isBusy: false, last: '[[],[]]', list: [], seen: [], primed: [], arrivals: [], effort: '', told: '' }

  on('session.start', ($, e, next) => {
    // 그릴 화면이 없는 세션(claude -p)에서는 읽지 않는다.
    if (e.isInteractive) {
      const poll = () => void refresh($, memo).catch(() => {})
      $.clock.every(EVERY_MS, poll)
      poll()
    }

    return next(e)
  })

  // 차례가 끝날 때 그 차례의 강도(effort)를 적어 둔다. 다음 박자에 MCP 서버에 알린다.
  on('classic.Stop', ($, e, next) => {
    const level = (e as { effort?: { level?: unknown } }).effort?.level
    if (typeof level === 'string' && level !== '') memo.effort = level

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = memo.list
    if (e.props.hasSurvey || list.length === 0) return next(e)
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    // 테두리와 안쪽 여백을 뺀 너비.
    const inner = Math.max(24, e.props.bodyColumns - 4)
    const isNarrow = e.props.bodyColumns < 96
    // 띠가 쓸 수 있는 줄 수에 맞춰 펼치는 줄과 쌓는 줄을 줄인다.
    const room = e.props.maxRows
    const bodyMax = room >= 10 ? 3 : room >= 8 ? 2 : room >= 7 ? 1 : 0
    const olderMax = room >= 9 ? 2 : room >= 7 ? 1 : 0

    return (
      <Box flexDirection="column">
        {list.map(b => {
          const mine = memo.arrivals.filter(a => a.url === b.url && now - a.bornAt < KEEP_MS)
          const newest = mine[mine.length - 1]
          const age = newest ? now - newest.bornAt : 0
          const isOpen = newest !== undefined && age < OPEN_MS
          // 앞의 글은 새것부터 한 줄씩 쌓는다.
          const older = (isOpen ? mine.slice(0, -1) : mine).slice(-olderMax).reverse()
          const more = mine.length - older.length - (isOpen ? 1 : 0)
          const tone = !newest ? 'inactive' : newest.kind === 'answer' ? 'success' : newest.kind === 'agreement' ? 'claude' : newest.kind === 'question' && !newest.isNotice ? 'suggestion' : 'warning'
          const body = newest ? clip(newest.text, Math.max(inner, bodyMax * inner - 2)) : ''
          const need = Math.min(bodyMax, Math.max(1, Math.ceil(cells(body) / inner)))
          // 한 줄씩 자라고, 닫히기 직전에 한 줄씩 줄어든다.
          const rows = isOpen ? Math.max(0, Math.min(need, Math.floor(age / GROW_MS), Math.ceil((OPEN_MS - age) / GROW_MS))) : 0
          const down = b.links.filter(l => l.state !== 'connected')
          const isAlone = b.links.length === 0
          const isCounted = isNarrow || b.links.length > 3
          const w = b.waiting

          return (
            <Box flexDirection="column" borderStyle="round" borderColor={isOpen ? tone : 'inactive'} borderDimColor={!isOpen} paddingX={1}>
              <Box columnGap={2} flexWrap="wrap">
                <Box columnGap={1} flexWrap="wrap">
                  <Text color={isAlone ? 'inactive' : down.length ? 'warning' : 'success'}>{isAlone ? '○' : down.length ? '◐' : '●'}</Text>
                  <Text bold>coworker</Text>
                  {isAlone && <Text dimColor>연결된 세션 없음</Text>}
                  {!isAlone && isCounted && <Text>연결 {b.links.length - down.length}</Text>}
                  {!isAlone && isCounted && down.length > 0 && <Text color="warning">다시 붙는 중 {down.length}</Text>}
                  {!isAlone &&
                    !isCounted &&
                    b.links.map(l => (
                      <Box columnGap={1}>
                        {l.state === 'connected' ? <Text>{l.name}</Text> : <Text color="warning">{l.name} (다시 붙는 중)</Text>}
                        {said(l.about) !== '' && <Text dimColor>‹{said(l.about)}›</Text>}
                      </Box>
                    ))}
                  {b.connecting > 0 && <Text dimColor>소개받는 중 {b.connecting}</Text>}
                </Box>
                <Box columnGap={1} flexWrap="wrap">
                  <Text dimColor>
                    대화 {b.conversations} · 글 {b.messages}
                  </Text>
                  {w.yourHuman > 0 && (
                    <Text color="warning" bold>
                      사람 결정 필요 {w.yourHuman}
                    </Text>
                  )}
                  {w.yours > 0 && <Text color="success">답할 것 {w.yours}</Text>}
                  {w.theirs > 0 && <Text dimColor>답 기다리는 중 {w.theirs}</Text>}
                  {w.theirHuman > 0 && <Text dimColor>상대 쪽 사람 확인 {w.theirHuman}</Text>}
                </Box>
                <Link href={b.url} label="대화 보기" />
              </Box>
              {isOpen && newest && (
                <Box flexDirection="column">
                  <Box columnGap={1} justifyContent="space-between">
                    <Box columnGap={1} flexWrap="wrap">
                      <Text bold color={tone}>
                        {newest.isNotice ? '새 알림' : (KIND[newest.kind] ?? newest.kind)}
                      </Text>
                      {newest.category !== '' && <Text color="suggestion">[{newest.category}]</Text>}
                      <Text dimColor>
                        {newest.peer} → 나 · {ago(age)}
                      </Text>
                      {newest.isHuman && <Text color="warning">사람이 정함</Text>}
                    </Box>
                    <Button
                      key={`close ${b.url}`}
                      plain
                      label="닫기"
                      onPress={() => {
                        memo.arrivals = memo.arrivals.filter(a => a.url !== b.url)
                        $.ui.invalidate('ui.render')
                      }}
                    />
                  </Box>
                  {rows > 0 && (
                    <Box height={rows} overflow="hidden">
                      <Text wrap="wrap">{body}</Text>
                    </Box>
                  )}
                </Box>
              )}
              {older.map(a => (
                <Text dimColor wrap="truncate-end">
                  ↳ {a.isNotice ? '새 알림' : (KIND[a.kind] ?? a.kind)}
                  {a.category !== '' ? ` [${a.category}]` : ''} · {a.peer} → 나 · {ago(now - a.bornAt)} · {clip(a.text, Math.max(12, inner - 40))}
                </Text>
              ))}
              {more > 0 && <Text dimColor>+{more}건 더 있습니다. 대화 보기에서 봅니다.</Text>}
            </Box>
          )
        })}
      </Box>
    )
  })
}
