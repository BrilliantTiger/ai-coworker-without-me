import { afterAll, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { waitSeconds } from '../src/limits'

// 실제 MCP 서버 두 개를 띄워, Claude Code 쪽과 Codex 쪽이 도구만으로 주고받는지 본다.
const home = mkdtempSync(join(tmpdir(), 'coworker-mcp-'))
const clients: Client[] = []

async function session(clientName: string, env: Record<string, string> = {}, client = new Client({ name: clientName, version: '1.0.0' })) {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(import.meta.dir, '..', 'src', 'mcp.ts')],
      // 시험을 채널로 켠 Claude Code 안에서 돌려도 채널로 바뀌지 않게 정해 둔다.
      env: { ...process.env, COWORKER_HOME: home, COWORKER_CHANNEL: 'off', ...env } as Record<string, string>,
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

  // 결정이 필요한 질문: 받은 쪽이 사람에게 묻는 중이라고 알리고, 사람의 결정을 답으로 보낸다.
  const decide = await codex('send_question', { question: 'Release on Friday or Monday?' })
  const dq = (await claude('wait_for_message', { timeout_sec: 5 })).events[0]
  expect(dq).toMatchObject({ kind: 'question', thread: decide.thread })
  expect(await claude('check_with_human', { thread: dq.thread })).toMatchObject({ status: 'checking_with_your_human' })
  expect((await codex('wait_for_message', { timeout_sec: 5 })).events[0]).toMatchObject({ kind: 'note', status: 'peer_checking_with_their_human' })
  await claude('reply', { thread: dq.thread, text: 'My human decided: Monday.' })
  expect((await codex('wait_for_message', { timeout_sec: 5 })).events[0]).toMatchObject({ kind: 'answer', text: 'My human decided: Monday.' })
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
