import { afterAll, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { waitSeconds } from '../src/limits'

// 실제 MCP 서버 두 개를 띄워, Claude Code 쪽과 Codex 쪽이 도구만으로 주고받는지 본다.
const home = mkdtempSync(join(tmpdir(), 'coworker-mcp-'))
const clients: Client[] = []

async function session(clientName: string) {
  const client = new Client({ name: clientName, version: '1.0.0' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(import.meta.dir, '..', 'src', 'mcp.ts')],
      env: { ...process.env, COWORKER_HOME: home } as Record<string, string>,
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

test('a wait ends before Claude Code pushes it to the background or Codex gives up on it', () => {
  expect(waitSeconds(undefined, false)).toBe(110)
  expect(waitSeconds(300, false)).toBe(110)
  expect(waitSeconds(30, false)).toBe(30)
  expect(waitSeconds(undefined, true)).toBe(50)
  expect(waitSeconds(300, true)).toBe(55)
})
