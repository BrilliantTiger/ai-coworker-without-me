import { afterAll, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  return async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] }
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
  expect((await claude('read_conversation', { thread: asked.thread })).messages).toHaveLength(2)
  expect((await codex('list_connections')).peers[0]).toMatchObject({ name: opened.name, reachable: true })

  const nothing = await codex('wait_for_message', { timeout_sec: 0 })
  expect(nothing.events).toEqual([])

  await codex('close_bridge')
  expect((await claude('wait_for_message', { timeout_sec: 5 })).events[0]).toMatchObject({ type: 'peer_closed' })
})

test('ending the session closes its bridge and removes its state file', async () => {
  const s = await session('claude-code')
  const { port } = await s('open_bridge', {})
  await clients.pop()!.close()
  for (let i = 0; i < 20 && existsSync(join(home, 'bridges', `${port}.json`)); i++) await Bun.sleep(100)
  expect(readdirSync(join(home, 'bridges'))).not.toContain(`${port}.json`)
  const res = await fetch(`http://127.0.0.1:${port}/v1`, { method: 'POST', body: '{}' }).catch(() => null)
  expect(res).toBeNull()
})
