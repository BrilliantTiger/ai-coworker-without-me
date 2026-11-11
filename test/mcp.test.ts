import { afterAll, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ElicitRequestSchema, type ElicitRequest, type ElicitResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { waitSeconds } from '../src/limits'
import { readSaved, savedPath, stillRunning } from '../src/resume'

// 실제 MCP 서버 두 개를 띄워, Claude Code 쪽과 Codex 쪽이 도구만으로 주고받는지 본다.
const home = mkdtempSync(join(tmpdir(), 'coworker-mcp-'))
const clients: Client[] = []

async function session(clientName: string, env: Record<string, string> = {}, client = new Client({ name: clientName, version: '1.0.0' })) {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(import.meta.dir, '..', 'src', 'mcp.ts')],
      // 시험을 채널로 켠 Claude Code 안에서 돌려도 채널로 바뀌지 않게 정해 둔다.
      // Claude Code 안에서 돌려도 그 세션 ID를 물려받지 않게 비운다. 다시 켜기 시험만 따로 준다.
      env: { ...process.env, COWORKER_HOME: home, COWORKER_CHANNEL: 'off', CLAUDE_CODE_SESSION_ID: '', ...env } as Record<string, string>,
      stderr: 'inherit',
    }),
  )
  clients.push(client)
  return async (name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) => {
    const res = (await client.callTool({ name, arguments: args }, undefined, { signal })) as { isError?: boolean; content: { text: string }[] }
    const text = res.content[0]!.text
    if (res.isError) throw new Error(text)
    return JSON.parse(text)
  }
}

afterAll(async () => {
  for (const c of clients) await c.close()
})

test('a Claude Code session and a Codex session talk through the tools', async () => {
  const claude = await session('claude-code')
  const codex = await session('codex-mcp-client')

  const opened = await claude('open_bridge', {})
  expect(opened.name).toMatch(/ · Claude Code @ /)
  expect(opened.port).toBeGreaterThanOrEqual(7700)
  expect(opened.code).toStartWith('cw1.')
  expect(existsSync(join(home, 'bridges', `${opened.port}.json`))).toBe(true)
  expect(opened.viewer).toStartWith('http://127.0.0.1:')

  const joined = await codex('connect', { code: opened.code })
  expect(joined.connected).toBe(opened.name)
  expect(joined.myName).toMatch(/ · Codex @ /)
  expect(joined.myPort).not.toBe(opened.port)
  // 연 쪽과 연결한 쪽이 저마다 자기 링크를 받고, AI에게 주는 안내에도 그 링크가 들어 있다.
  expect(joined.viewer).toStartWith('http://127.0.0.1:')
  expect(joined.viewer).not.toBe(opened.viewer)
  expect(opened.next).toContain(opened.viewer)
  expect(joined.next).toContain(joined.viewer)

  expect((await claude('wait_for_message', { timeout_sec: 5 })).events[0]).toMatchObject({ type: 'connected', peer: joined.myName })

  const asked = await codex('send_question', { question: 'What is 2+2?', context: 'just checking' })
  expect(asked.delivery).toBe('delivered')

  const got = (await claude('wait_for_message', { timeout_sec: 5 })).events[0]
  expect(got).toMatchObject({ type: 'message', kind: 'question', text: 'What is 2+2?', thread: asked.thread })

  await claude('reply', { thread: got.thread, text: '4' })
  const answer = (await codex('wait_for_message', { timeout_sec: 5 })).events[0]
  expect(answer).toMatchObject({ type: 'message', kind: 'answer', text: '4' })

  expect((await codex('inbox')).conversations[0]).toMatchObject({ id: asked.thread, status: 'your_turn', messages: 2 })

  // 사람은 브라우저에서 같은 대화를 본다.
  const view = (await (await fetch(`${opened.viewer}/data`)).json()) as { conversations: unknown[] }
  expect(view.conversations[0]).toMatchObject({ id: asked.thread, startedBy: 'peer', peerName: joined.myName, messages: [{ text: 'What is 2+2?' }, { text: '4' }] })
  expect((await codex('list_connections')).viewer).toStartWith('http://127.0.0.1:')

  // 결정이 필요한 질문: 받은 쪽이 사람에게 묻는 중이라고 알린다. 질문 창을 띄울 수 없는 앱이면 AI가 번호 보기로 묻고, 사람의 결정을 답으로 보낸다.
  const decide = await codex('send_question', { question: 'Release on Friday or Monday?' })
  const dq = (await claude('wait_for_message', { timeout_sec: 5 })).events[0]
  expect(dq).toMatchObject({ kind: 'question', thread: decide.thread })
  const held = await claude('check_with_human', { thread: dq.thread, question: 'Release on Friday or Monday?', options: ['Friday', 'Monday'], recommend: 2 })
  expect(held).toMatchObject({ status: 'checking_with_your_human', window: false })
  expect(held.next).toMatch(/numbered 1, 2, 3/)
  expect((await codex('wait_for_message', { timeout_sec: 5 })).events[0]).toMatchObject({ kind: 'note', status: 'peer_checking_with_their_human' })
  await claude('reply', { thread: dq.thread, text: 'My human decided: Monday.', decided_by_human: true })
  expect((await codex('wait_for_message', { timeout_sec: 5 })).events[0]).toMatchObject({ kind: 'answer', text: 'My human decided: Monday.', human: true })
  expect((await claude('read_conversation', { thread: asked.thread })).messages).toHaveLength(2)
  expect((await codex('list_connections')).peers[0]).toMatchObject({ name: opened.name, reachable: true })

  const nothing = await codex('wait_for_message', { timeout_sec: 0 })
  expect(nothing.events).toEqual([])
  // 아무것도 안 왔으면 사람에게 알리지 말고 다시 기다리라고 한다.
  expect(nothing.next).toMatch(/do not tell your human/i)

  // 사람이 끊은 기다림이 서버에 남아 다음 소식을 가로채지 않는다.
  const cancel = new AbortController()
  const abandoned = codex('wait_for_message', { timeout_sec: 30 }, cancel.signal).catch(() => 'cancelled')
  await Bun.sleep(100)
  cancel.abort()
  expect(await abandoned).toBe('cancelled')
  const late = await claude('send_question', { question: 'Still there?' })
  expect((await codex('wait_for_message', { timeout_sec: 5 })).events[0]).toMatchObject({ kind: 'question', thread: late.thread })

  await codex('close_bridge')
  expect((await claude('wait_for_message', { timeout_sec: 5 })).events[0]).toMatchObject({ type: 'peer_closed' })
})

test('a Claude Code started as a channel gets messages pushed in, without waiting', async () => {
  const client = new Client({ name: 'claude-code', version: '1.0.0' })
  const pushed: { content: string; meta: Record<string, string> }[] = []
  client.setNotificationHandler(
    z.object({ method: z.literal('notifications/claude/channel'), params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }) }),
    ({ params }) => void pushed.push(params),
  )
  const claude = await session('claude-code', { COWORKER_CHANNEL: 'on' }, client)
  const codex = await session('codex-mcp-client')
  const next = async (type: string) => {
    for (let i = 0; i < 50; i++) {
      const found = pushed.find(p => p.meta.type === type)
      if (found) return pushed.splice(pushed.indexOf(found), 1)[0]!
      await Bun.sleep(50)
    }
    throw new Error(`nothing pushed: ${type}`)
  }

  // 채널만 켜고, 상대가 이 PC의 명령 실행을 승인할 수 있는 원격 승인은 켜지 않는다.
  expect(client.getServerCapabilities()?.experimental).toEqual({ 'claude/channel': {} })
  expect(client.getInstructions()).toMatch(/Do not call wait_for_message/)

  const opened = await claude('open_bridge', {})
  expect(opened.next).toMatch(/comes in by itself/)
  const joined = await codex('connect', { code: opened.code })
  expect((await next('connected')).meta).toEqual({ type: 'connected', peer: joined.myName })

  const asked = await codex('send_question', { question: 'What is 2+2?' })
  const q = await next('message')
  expect(q.meta).toEqual({ type: 'message', kind: 'question', from: joined.myName, thread: asked.thread })
  expect(JSON.parse(q.content).event).toMatchObject({ text: 'What is 2+2?', status: 'your_turn' })

  // 밀어 넣은 것은 기다리기로 한 번 더 오지 않는다.
  expect(await claude('wait_for_message', {})).toMatchObject({ events: [] })
  await claude('reply', { thread: asked.thread, text: '4' })
  expect((await codex('wait_for_message', { timeout_sec: 5 })).events[0]).toMatchObject({ kind: 'answer', text: '4' })

  await codex('close_bridge')
  expect((await next('peer_closed')).meta).toEqual({ type: 'peer_closed', peer: joined.myName })
})

test('the asking side writes the agreement, and secrets never leave', async () => {
  const claude = await session('claude-code')
  const codex = await session('codex-mcp-client')
  const opened = await claude('open_bridge', {})
  await codex('connect', { code: opened.code })
  await claude('wait_for_message', { timeout_sec: 5 })

  const token = ['gh', 'p_', 'Q7w'.repeat(12)].join('')
  await expect(codex('send_question', { question: 'Why does the clone fail?', context: `git clone https://x:${token}@github.com/a/b` })).rejects.toThrow(
    /nothing was sent/,
  )
  const asked = await codex('send_question', { question: 'Which branch do we release from?' })
  const q = (await claude('wait_for_message', { timeout_sec: 5 })).events[0]
  await claude('reply', { thread: q.thread, text: 'main, per docs/release.md' })
  await codex('wait_for_message', { timeout_sec: 5 })

  const wrote = await codex('write_agreement', {
    thread: asked.thread,
    conclusion: 'Releases go out from main.',
    facts: [{ fact: 'docs/release.md says main', evidence: 'docs/release.md:4', checked_by: 'them' }],
    for_humans: ['Keep the release branch?'],
  })
  expect(wrote).toMatchObject({ status: 'agreed', delivery: 'delivered', file: expect.stringContaining(join(home, 'agreements')) })
  const got = (await claude('wait_for_message', { timeout_sec: 5 })).events[0]
  expect(got).toMatchObject({ kind: 'agreement', status: 'agreed', agreement: { conclusion: 'Releases go out from main.' } })
  expect(existsSync(got.file)).toBe(true)
  // Windows 의 Bun 1.3.7 에서는 여기서 rejects.toThrow 가 이미 끝난 거절을 놓치고 시험 시간을 다 쓴다. 거절 글을 받아서 본다.
  expect(await claude('reply', { thread: q.thread, text: 'also tags' }).catch(e => String(e))).toMatch(/write_agreement/)
  expect(await claude('send_question', { question: 'Anything else for the release?' })).toMatchObject({ delivery: 'delivered' })
}, 20_000)

test('a long wait in Claude Code keeps reporting progress, so Claude Code does not cut it off', async () => {
  const client = new Client({ name: 'claude-code', version: '1.0.0' })
  const claude = await session('claude-code', { COWORKER_KEEPALIVE_MS: '100' }, client)
  const codex = await session('codex-mcp-client')
  await codex('connect', { code: (await claude('open_bridge', {})).code })
  await claude('wait_for_message', { timeout_sec: 5 })
  const beats: number[] = []
  const waiting = client.callTool({ name: 'wait_for_message', arguments: {} }, undefined, { onprogress: p => void beats.push(p.progress) })
  await Bun.sleep(450)
  await codex('send_question', { question: 'Still there?' })
  const res = (await waiting) as { content: { text: string }[] }
  expect(JSON.parse(res.content[0]!.text).events[0]).toMatchObject({ kind: 'question', text: 'Still there?' })
  expect(beats.length).toBeGreaterThanOrEqual(3)
}, 20_000)

test('a session not started as a channel does not claim to be one', async () => {
  const client = new Client({ name: 'claude-code', version: '1.0.0' })
  await session('claude-code', {}, client)
  expect(client.getServerCapabilities()?.experimental).toBeUndefined()
  expect(client.getInstructions()).toMatch(/call wait_for_message, handle what arrives/)
  expect(client.getInstructions()).toMatch(/In Claude Code, listen in the background.*run_in_background: true/)
})

test('Claude Code without a channel listens with a background command, so its human can keep talking to it meanwhile', async () => {
  const claude = await session('claude-code')
  const codex = await session('codex-mcp-client')
  const opened = await claude('open_bridge', {})
  // Claude Code 는 백그라운드로 돌릴 명령을 받는다. 기다리기 도구를 붙잡지 않는다.
  expect(opened.listen_command).toBe(`${process.platform === 'win32' ? 'curl.exe' : 'curl'} -s ${opened.viewer}/next`)
  expect(opened.next).toContain(`run \`${opened.listen_command}\` with Bash in the background (run_in_background: true)`)
  expect(opened.next).toContain('do not call wait_for_message')
  // Codex 는 백그라운드 명령이 끝나도 AI가 깨지 않으므로 그대로 기다리기 도구를 쓴다.
  const joined = await codex('connect', { code: opened.code })
  expect(joined.listen_command).toBeUndefined()
  expect(joined.next).toContain('call wait_for_message now')

  const listen = () => fetch(`${opened.viewer}/next`).then(r => r.text())
  expect(await listen()).toContain('(1 connected)')
  const first = await claude('inbox')
  expect(first.events[0]).toMatchObject({ type: 'connected', peer: joined.myName })
  expect(first.next).toContain(opened.listen_command)

  // 명령이 기다리는 동안 다른 도구를 쓰면, 명령이 아직 돈다고 알려 준다. 하나 더 걸지 않게 한다.
  const waiting = listen()
  await Bun.sleep(200)
  const asked = await claude('send_question', { question: 'Which port?' })
  expect(asked.next).toContain('your background listen command is still running')
  expect(asked.next).not.toContain(opened.listen_command)
  const q = (await codex('wait_for_message', { timeout_sec: 5 })).events.at(-1)
  await codex('reply', { thread: q.thread, text: '7690' })
  expect(await waiting).toContain('(1 answer)')
  const answered = await claude('inbox')
  expect(answered.events.at(-1)).toMatchObject({ kind: 'answer', text: '7690' })
  expect(answered.next).toContain(`run \`${opened.listen_command}\``)

  // 사람이 그만하라고 해서 브릿지를 닫으면, 기다리던 명령도 끝난다.
  const last = listen()
  await Bun.sleep(100)
  await claude('close_bridge')
  expect(await last).toContain('bridge is closed')
}, 20_000)

test('Codex replacing the plugin folder under a running server does not break it', async () => {
  // Codex 는 설치 뒤 첫 세션에서 플러그인 폴더를 같은 경로의 새 폴더로 바꾼다. 이 서버는 그 폴더 안에서 떠 있다.
  const pluginDir = join(home, 'plugins', 'cache', 'mkt', 'coworker', '0.1.0')
  mkdirSync(pluginDir, { recursive: true })
  const client = new Client({ name: 'codex-mcp-client', version: '1.0.0' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(import.meta.dir, '..', 'src', 'mcp.ts')],
      cwd: pluginDir,
      env: { ...process.env, COWORKER_HOME: home, COWORKER_CHANNEL: 'off', PWD: '/work/billing-api' } as Record<string, string>,
      stderr: 'inherit',
    }),
  )
  clients.push(client)
  rmSync(pluginDir, { recursive: true })
  mkdirSync(pluginDir)
  const res = (await client.callTool({ name: 'open_bridge', arguments: {} })) as { isError?: boolean; content: { text: string }[] }
  expect(res.isError).toBeFalsy()
  expect(JSON.parse(res.content[0]!.text).name).toStartWith('billing-api · Codex @ ')
})

test('three sessions join one group and one question goes to everyone', async () => {
  const lead = await session('claude-code', { COWORKER_PORTS: '17960-17969' })
  const first = await session('codex-mcp-client')
  const second = await session('claude-code')

  const opened = await lead('open_bridge', {})
  expect(opened.port).toBeGreaterThanOrEqual(17960)
  expect(opened.port).toBeLessThanOrEqual(17969)
  const one = await first('connect', { code: opened.code })
  const two = await second('connect', { code: (await lead('open_bridge', {})).code })
  expect(two.joining).toEqual([one.myName])
  for (let i = 0; i < 40 && (await first('list_connections')).peers.length < 2; i++) await Bun.sleep(50)
  expect((await first('list_connections')).peers.map((p: { name: string }) => p.name).sort()).toEqual([opened.name, two.myName].sort())

  const asked = await lead('send_question', { question: 'Ready to merge?', to: 'everyone', answers: 'one' })
  expect(asked).toMatchObject({ answers: 'one', to: expect.arrayContaining([one.myName, two.myName]) })
  const take = async (s: typeof lead, kind: string) => {
    for (let i = 0; i < 20; i++) {
      const found = (await s('wait_for_message', { timeout_sec: 1 })).events.find((e: { kind?: string }) => e.kind === kind)
      if (found) return found
    }
    throw new Error(`no ${kind}`)
  }
  const q = await take(first, 'question')
  await take(second, 'question')
  await first('reply', { thread: q.thread, text: 'Yes.' })
  expect(await take(lead, 'answer')).toMatchObject({ text: 'Yes.', ask: { closedBy: one.myName } })
  expect(await take(second, 'closed')).toMatchObject({ status: 'closed' })
  await expect(lead('open_bridge', { port: 80 })).rejects.toThrow()
}, 20_000)

test('open_bridge makes codes that last 60 minutes by default, a chosen time, or with no time limit', async () => {
  const s = await session('claude-code')
  const minutesLeft = (expires: string) => Math.round((Date.parse(expires) - Date.now()) / 60_000)
  expect(minutesLeft((await s('open_bridge', {})).expires)).toBe(60)
  expect(minutesLeft((await s('open_bridge', { expires_minutes: 180 })).expires)).toBe(180)
  const unlimited = await s('open_bridge', { expires_minutes: 0 })
  expect(unlimited.expires).toStartWith('never')
  expect(unlimited.next).toContain('no time limit')
  await expect(s('open_bridge', { expires_minutes: -1 })).rejects.toThrow()
})

test('ending the session closes its bridge and removes its state file', async () => {
  const s = await session('claude-code')
  const { port } = await s('open_bridge', {})
  await clients.pop()!.close()
  for (let i = 0; i < 20 && existsSync(join(home, 'bridges', `${port}.json`)); i++) await Bun.sleep(100)
  expect(readdirSync(join(home, 'bridges'))).not.toContain(`${port}.json`)
  // Windows는 닫힌 포트에 접속하면 거절까지 2초쯤 걸린다. 그 안에 답이 없으면 닫힌 것으로 본다.
  const res = await fetch(`http://127.0.0.1:${port}/v1`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(3000) }).catch(() => null)
  expect(res).toBeNull()
}, 15_000)

test('Claude Code waits until something arrives; Codex ends before it gives up on the call', () => {
  expect(waitSeconds(undefined, false)).toBe(Infinity)
  expect(waitSeconds(0, false)).toBe(Infinity)
  expect(waitSeconds(300, false)).toBe(300)
  expect(waitSeconds(30, false)).toBe(30)
  expect(waitSeconds(undefined, true)).toBe(50)
  expect(waitSeconds(300, true)).toBe(55)
})

test('a Claude Code session not started as a channel passes on how to start one, once', async () => {
  const own = mkdtempSync(join(tmpdir(), 'coworker-hint-mcp-'))
  const claude = await session('claude-code', { COWORKER_HOME: own, CLAUDECODE: '1' })
  const first = await claude('open_bridge', {})
  expect(first.next).toContain('claude-cw')
  expect(first.next).toContain('plugin:coworker@ai-coworker-without-me')
  const again = await claude('open_bridge', {})
  expect(again.next).not.toContain('claude-cw')
  // Codex 는 채널이 없어서 이 안내를 받지 않는다.
  const codex = await session('codex-mcp-client', { COWORKER_HOME: mkdtempSync(join(tmpdir(), 'coworker-hint-mcp-')), CLAUDECODE: '' })
  expect((await codex('open_bridge', {})).next).not.toContain('claude-cw')
})

// 세션을 닫으면 MCP 서버가 끝난다. 끝나서 그 포트가 답하지 않을 때까지 기다린다.
async function ended(client: Client, homeDir: string, id: string) {
  await client.close()
  for (let i = 0; i < 100; i++) {
    const saved = readSaved(savedPath(homeDir, id))
    if (saved && !(await stillRunning(saved))) return saved
    await Bun.sleep(50)
  }
  throw new Error('the server did not end')
}

test('the same Claude Code session started again gets its bridge back by itself, and the other side needs no new code', async () => {
  const own = mkdtempSync(join(tmpdir(), 'coworker-resume-'))
  const env = { COWORKER_HOME: own, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'session-one', CLAUDE_PLUGIN_ROOT: join(own, 'plugin') }
  const first = new Client({ name: 'claude-code', version: '1.0.0' })
  const claude = await session('claude-code', env, first)
  const codex = await session('codex-mcp-client')
  const opened = await claude('open_bridge', {})
  expect(opened.session_id).toBe('session-one')
  const joined = await codex('connect', { code: opened.code })
  expect((await claude('wait_for_message', { timeout_sec: 5 })).events[0]).toMatchObject({ type: 'connected' })
  const asked = await claude('send_question', { question: 'Which port?' })

  // Claude Code 를 닫았다. 그사이 상대가 답한다.
  await ended(first, own, 'session-one')
  const q = (await codex('wait_for_message', { timeout_sec: 5 })).events.find((e: { kind?: string }) => e.kind === 'question')
  expect((await codex('reply', { thread: q.thread, text: '7690' })).delivery).toBe('queued')

  // 같은 세션을 이어서 켰다(claude --resume). 브릿지가 저절로 돌아오고, 그사이 온 답을 받는다.
  const second = new Client({ name: 'claude-code', version: '1.0.0' })
  const again = await session('claude-code', env, second)
  expect(second.getInstructions()).toMatch(/came back by itself with the same identity: it is open again and still connected to /)
  // 사람이 열어 둔 대화 보기 화면은 AI가 도구를 부르기 전에도 같은 주소에서 다시 대화를 보여 준다.
  const view = (await (await fetch(`${opened.viewer}/data`)).json()) as { conversations: { id: string }[] }
  expect(view.conversations).toEqual([expect.objectContaining({ id: asked.thread })])
  const conns = await again('list_connections')
  expect(conns).toMatchObject({ session_id: 'session-one', viewer: opened.viewer, peers: [expect.objectContaining({ name: joined.myName })] })
  const got = (await again('wait_for_message', { timeout_sec: 10 })).events
  expect(got).toEqual([expect.objectContaining({ kind: 'answer', text: '7690', thread: asked.thread })])
  // 상대는 이쪽이 돌아온 것을 안다.
  expect((await codex('wait_for_message', { timeout_sec: 5 })).events).toEqual([expect.objectContaining({ type: 'connected', again: true })])
}, 30_000)

test('a session without a session id, like Codex, brings its bridge back with resume', async () => {
  const own = mkdtempSync(join(tmpdir(), 'coworker-resume-'))
  const first = new Client({ name: 'codex-mcp-client', version: '1.0.0' })
  const codex = await session('codex-mcp-client', { COWORKER_HOME: own }, first)
  const claude = await session('claude-code')
  const opened = await codex('open_bridge', {})
  const joined = await claude('connect', { code: opened.code })
  expect((await codex('wait_for_message', { timeout_sec: 5 })).events[0]).toMatchObject({ type: 'connected' })
  await ended(first, own, opened.session_id)

  // Codex 를 다시 켜면 새 서버는 이 세션을 모른다. AI는 앞의 결과에 있던 session_id 로 되살린다.
  const again = await session('codex-mcp-client', { COWORKER_HOME: own })
  await expect(again('wait_for_message', { timeout_sec: 1 })).rejects.toThrow(/open_bridge with resume set to the session_id/)
  await expect(again('open_bridge', { resume: 'nothing-saved' })).rejects.toThrow(/no saved bridge for session_id nothing-saved/)
  const back = await again('open_bridge', { resume: opened.session_id })
  expect(back).toMatchObject({ resumed: true, session_id: opened.session_id, connected: [joined.myName] })
  expect(back.code).toBeUndefined()
  expect((await claude('wait_for_message', { timeout_sec: 5 })).events).toEqual([expect.objectContaining({ type: 'connected', again: true })])
  await claude('send_question', { question: 'Back?' })
  expect((await again('wait_for_message', { timeout_sec: 5 })).events[0]).toMatchObject({ kind: 'question', text: 'Back?' })

  // 사람이 닫으라고 하면 저장한 상태도 지운다. 다시 되살릴 수 없다.
  await again('close_bridge')
  expect(readSaved(savedPath(own, opened.session_id))).toBeUndefined()
}, 30_000)

test('the plugin server and a directly added server in the same Claude Code session do not take each other\'s bridge', async () => {
  const own = mkdtempSync(join(tmpdir(), 'coworker-resume-'))
  const base = { COWORKER_HOME: own, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'session-two' }
  const pluginEnv = { ...base, CLAUDE_PLUGIN_ROOT: join(own, 'plugin') }
  const firstPlugin = new Client({ name: 'claude-code', version: '1.0.0' })
  const firstDirect = new Client({ name: 'claude-code', version: '1.0.0' })
  const plugin = await session('claude-code', pluginEnv, firstPlugin)
  await session('claude-code', base, firstDirect)
  const opened = await plugin('open_bridge', {})
  expect(opened.session_id).toBe('session-two')
  await ended(firstPlugin, own, 'session-two')
  await firstDirect.close()

  // 같은 세션을 다시 켰다. 브릿지를 열었던 플러그인 서버만 되살린다.
  const again = await session('claude-code', pluginEnv)
  const direct = await session('claude-code', base)
  expect(await again('list_connections')).toMatchObject({ session_id: 'session-two', me: { open: true, port: opened.port } })
  expect(await direct('list_connections')).toMatchObject({ session_id: 'session-two.direct', me: { open: false } })
}, 30_000)

// 질문 창을 띄울 수 있는 클라이언트(Claude Code, Codex 처럼). answer 가 사람의 대답 노릇을 한다.
function windowClient(answer: (params: ElicitRequest['params']) => Promise<ElicitResult> | ElicitResult) {
  const client = new Client({ name: 'claude-code', version: '1.0.0' }, { capabilities: { elicitation: {} } })
  const shown: ElicitRequest['params'][] = []
  client.setRequestHandler(ElicitRequestSchema, async req => {
    shown.push(req.params)
    return answer(req.params)
  })
  return { client, shown }
}

async function questionFromCodex() {
  const { client, shown } = windowClient(() => ({ action: 'accept', content: { choice: '2', other: '테스트가 끝나면 바로' } }))
  const claude = await session('claude-code', {}, client)
  const codex = await session('codex-mcp-client')
  const opened = await claude('open_bridge', {})
  await codex('connect', { code: opened.code })
  await claude('wait_for_message', { timeout_sec: 5 })
  const asked = await codex('send_question', { question: '배포를 언제 할까요?' })
  await claude('wait_for_message', { timeout_sec: 5 })
  return { claude, codex, opened, asked, shown }
}

test('a decision opens a question window for the human, and their answer goes to the other side by itself', async () => {
  const { claude, codex, opened, asked, shown } = await questionFromCodex()
  const held = await claude('check_with_human', { thread: asked.thread, question: '보안 담당이 배포 날짜를 묻습니다. 언제 할까요?', options: ['금요일', '월요일'], recommend: 2 })
  expect(held).toMatchObject({ status: 'checking_with_your_human', window: 'open' })

  // 상대는 사람에게 묻는 중이라는 알림을 받고, 이어서 사람이 정한 답을 받는다.
  const got: { kind?: string; text?: string; human?: boolean }[] = []
  for (let i = 0; i < 10 && got.length < 2; i++) got.push(...(await codex('wait_for_message', { timeout_sec: 2 })).events)
  expect(got).toEqual([
    expect.objectContaining({ kind: 'note' }),
    expect.objectContaining({ kind: 'answer', text: '사람이 정했습니다: 월요일\n덧붙인 말: 테스트가 끝나면 바로', human: true }),
  ])

  // 사람에게는 번호 붙은 보기와 직접 쓰는 칸이 뜨고, 추천한 것이 표시된다.
  expect(shown).toHaveLength(1)
  expect(shown[0]!.message).toStartWith('보안 담당이 배포 날짜를 묻습니다. 언제 할까요?')
  const props = (shown[0] as { requestedSchema: { properties: Record<string, { title?: string; oneOf?: { const: string; title: string }[] }> } }).requestedSchema.properties
  expect(props.choice!.oneOf).toEqual([
    { const: '1', title: '1. 금요일' },
    { const: '2', title: '2. 월요일 (추천)' },
  ])
  expect(props.other!.title).toBe('직접 입력')

  // 이쪽 AI는 사람이 답했고 보냈다는 알림을 받는다. 대화 보기 화면에도 사람이 정한 답으로 남는다.
  expect((await claude('wait_for_message', { timeout_sec: 5 })).events).toEqual([
    expect.objectContaining({ type: 'decision', thread: asked.thread, choice: '월요일', text: '테스트가 끝나면 바로', delivery: 'delivered' }),
  ])
  const view = (await (await fetch(`${opened.viewer}/data`)).json()) as { conversations: { id: string; messages: { human?: boolean }[] }[] }
  expect(view.conversations.find(c => c.id === asked.thread)!.messages.at(-1)).toMatchObject({ human: true })
  expect((await claude('inbox')).waiting_for_your_human).toBeUndefined()
})

test('closing the question window without answering tells the AI to ask in text', async () => {
  const { client } = windowClient(() => ({ action: 'cancel' }))
  const claude = await session('claude-code', {}, client)
  const codex = await session('codex-mcp-client')
  await codex('connect', { code: (await claude('open_bridge', {})).code })
  await claude('wait_for_message', { timeout_sec: 5 })
  const asked = await codex('send_question', { question: 'Ship it?' })
  await claude('wait_for_message', { timeout_sec: 5 })
  expect((await claude('check_with_human', { thread: asked.thread, question: 'Ship it?', options: ['Yes', 'No'] })).window).toBe('open')
  const told = await claude('wait_for_message', { timeout_sec: 5 })
  expect(told.events).toEqual([expect.objectContaining({ type: 'decision', thread: asked.thread, closed: true })])
  expect(told.next).toMatch(/window was closed, ask them in text with numbered options/)
  // 상대에게는 사람에게 묻는 중이라는 알림만 갔다.
  const got = (await codex('wait_for_message', { timeout_sec: 2 })).events
  expect(got.map((e: { kind?: string }) => e.kind)).toEqual(['note'])
})

test('a question window the human has not answered opens again when the same session starts again', async () => {
  const own = mkdtempSync(join(tmpdir(), 'coworker-window-'))
  const env = { COWORKER_HOME: own, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'window-session', CLAUDE_PLUGIN_ROOT: join(own, 'plugin') }
  // 사람이 창을 띄워 둔 채로 답하지 않았다.
  const first = windowClient(() => new Promise<ElicitResult>(() => {}))
  const claude = await session('claude-code', env, first.client)
  const codex = await session('codex-mcp-client')
  await codex('connect', { code: (await claude('open_bridge', {})).code })
  await claude('wait_for_message', { timeout_sec: 5 })
  const asked = await codex('send_question', { question: '어느 서버에 올릴까요?' })
  await claude('wait_for_message', { timeout_sec: 5 })
  await claude('check_with_human', { thread: asked.thread, question: '어느 서버에 올릴까요?', options: ['PREP', 'PROD'], recommend: 1 })
  for (let i = 0; i < 100 && !first.shown.length; i++) await Bun.sleep(20)
  expect((await claude('inbox')).waiting_for_your_human).toEqual([asked.thread])

  // 세션을 닫았다가 같은 세션으로 다시 켠다. 창이 다시 뜨고, 이번에는 사람이 고른다.
  await ended(first.client, own, 'window-session')
  const second = windowClient(() => ({ action: 'accept', content: { choice: '1' } }))
  await session('claude-code', env, second.client)
  for (let i = 0; i < 100 && !second.shown.length; i++) await Bun.sleep(50)
  expect(second.shown[0]!.message).toStartWith('어느 서버에 올릴까요?')
  const got: { kind?: string; text?: string; human?: boolean }[] = []
  for (let i = 0; i < 10 && !got.some(e => e.kind === 'answer'); i++) got.push(...(await codex('wait_for_message', { timeout_sec: 2 })).events)
  expect(got.find(e => e.kind === 'answer')).toMatchObject({ text: '사람이 정했습니다: PREP', human: true })
}, 30_000)


test('a new session takes over the bridge of an earlier session that is still running, with all its conversations, and the other side needs no new code', async () => {
  const own = mkdtempSync(join(tmpdir(), 'coworker-takeover-'))
  const oldEnv = { COWORKER_HOME: own, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'qa-old', CLAUDE_PLUGIN_ROOT: join(own, 'plugin') }
  const oldClaude = await session('claude-code', oldEnv)
  const codex = await session('codex-mcp-client')
  const opened = await oldClaude('open_bridge', { name: 'ccb 질의응답' })
  const joined = await codex('connect', { code: opened.code })
  await oldClaude('wait_for_message', { timeout_sec: 5 })
  const first = await codex('send_question', { question: '7판을 설치해도 될까요?' })
  const q = (await oldClaude('wait_for_message', { timeout_sec: 5 })).events[0]
  await oldClaude('reply', { thread: q.thread, text: '네, 설치하셔도 됩니다.' })
  await codex('wait_for_message', { timeout_sec: 5 })
  const asked = await oldClaude('send_question', { question: '설치 결과를 알려 주세요.' })

  // context 가 차서 사람이 새 세션을 켰다. 앞 세션은 아직 켜져 있다. 새 세션은 이 PC에 남은 브릿지를 보고 이름으로 이어받는다.
  const newClaude = await session('claude-code', { ...oldEnv, CLAUDE_CODE_SESSION_ID: 'qa-new' })
  expect((await newClaude('list_connections')).earlier_bridges).toEqual([
    expect.objectContaining({ session_id: 'qa-old', name: 'ccb 질의응답', connected: [joined.myName], conversations: 2, running_in_another_session: true }),
  ])
  const back = await newClaude('open_bridge', { resume: '질의응답' })
  expect(back).toMatchObject({ resumed: true, session_id: 'qa-new', connected: [joined.myName], viewer: opened.viewer })
  expect(back.conversations.map((c: { id: string }) => c.id).sort()).toEqual([first.thread, asked.thread].sort())
  expect(back.next).toMatch(/read the 2 conversation\(s\) still open with read_conversation/)

  // 앞 세션은 브릿지가 옮겨 갔다는 것을 알고 그만 듣는다. 거기서 새로 열면 다른 이름표로 새로 시작한다.
  const told = await oldClaude('wait_for_message', { timeout_sec: 5 })
  expect(told.events).toEqual([expect.objectContaining({ type: 'moved' })])
  expect(told.next).toMatch(/moved to another session on this PC/)
  expect((await oldClaude('open_bridge', {})).session_id).not.toBe('qa-old')

  // 상대는 새 코드 없이 다시 이어진 것을 안다. 이어서 답하면 새 세션이 받는다.
  const seen: { type: string; again?: boolean; kind?: string }[] = []
  for (let i = 0; i < 10 && !seen.some(e => e.type === 'connected'); i++) seen.push(...(await codex('wait_for_message', { timeout_sec: 2 })).events)
  expect(seen.find(e => e.type === 'connected')).toMatchObject({ again: true })
  await codex('reply', { thread: asked.thread, text: '설치 끝났습니다.' })
  expect((await newClaude('wait_for_message', { timeout_sec: 5 })).events).toEqual([
    expect.objectContaining({ kind: 'answer', text: '설치 끝났습니다.', thread: asked.thread }),
  ])
  expect((await newClaude('read_conversation', { thread: first.thread })).messages.map((m: { text: string }) => m.text)).toEqual([
    '7판을 설치해도 될까요?',
    '네, 설치하셔도 됩니다.',
  ])

  // 사람은 같은 대화 보기 링크에서 앞 세션 때부터의 대화를 다 본다.
  const view = (await (await fetch(`${opened.viewer}/data`)).json()) as { conversations: { id: string; messages: unknown[] }[] }
  expect(view.conversations.map(c => c.id).sort()).toEqual([first.thread, asked.thread].sort())
  expect(view.conversations.find(c => c.id === asked.thread)!.messages).toHaveLength(2)

  // 이어받은 브릿지는 새 세션의 이름표로 저장된다. 새 세션을 다시 켜도 저절로 돌아온다.
  for (let i = 0; i < 50 && readSaved(savedPath(own, 'qa-old')); i++) await Bun.sleep(20)
  expect(readSaved(savedPath(own, 'qa-old'))).toBeUndefined()
  expect(readSaved(savedPath(own, 'qa-new'))?.peers.map(p => p.name)).toEqual([joined.myName])
}, 30_000)
