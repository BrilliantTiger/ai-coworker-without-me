import { afterAll, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { connect as tcp } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchAgentPlist, windowsShortcutScript } from '../src/autostart'

// coworker 앱: 이 PC의 여러 세션이 127.0.0.1 의 HTTP 로 한 앱에 붙는다. 디렉터리판 플러그인이 이렇게 붙는다.
const entry = join(import.meta.dir, '..', 'src', 'mcp.ts')
const apps: ReturnType<typeof Bun.spawn>[] = []
const clients: Client[] = []
const temps: string[] = []
afterAll(async () => {
  for (const c of clients) await c.close().catch(() => {})
  for (const a of apps) a.kill()
  for (const t of temps) rmSync(t, { recursive: true, force: true })
})

const freePort = () => {
  const s = Bun.serve({ port: 0, fetch: () => new Response('') })
  const port = s.port!
  s.stop(true)
  return port
}

async function startApp(env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'coworker-app-'))
  temps.push(home)
  const port = freePort()
  const app = Bun.spawn([process.execPath, entry, 'serve'], {
    env: { ...process.env, COWORKER_HOME: home, COWORKER_APP_PORT: String(port), ...env },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  apps.push(app)
  for (let i = 0; i < 50; i++) {
    const ok = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.ok).catch(() => false)
    if (ok) return { port, home, app }
    await Bun.sleep(100)
  }
  throw new Error('the app did not start')
}

async function session(port: number, name: string, folder?: string) {
  const client = new Client({ name, version: '1.0.0' }, folder ? { capabilities: { roots: {} } } : undefined)
  if (folder) client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: `file://${folder}`, name: 'project' }] }))
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
  await client.connect(transport)
  clients.push(client)
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name: tool, arguments: args })) as { isError?: boolean; content: { text: string }[] }
    const text = res.content[0]!.text
    if (res.isError) throw new Error(text)
    return JSON.parse(text)
  }
  return { call, transport }
}

// fetch 는 Host 를 바꿔 보내지 못해서, 날 HTTP 요청으로 보낸다.
const rawStatus = (port: number, host: string) =>
  new Promise<number>((done, fail) => {
    const sock = tcp(port, '127.0.0.1', () => sock.write(`GET /health HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`))
    let data = ''
    sock.on('data', d => (data += d))
    sock.on('end', () => done(Number(data.split(' ')[1])))
    sock.on('error', fail)
  })

test('two sessions on one app ask and answer each other, each with its own bridge', async () => {
  const { port } = await startApp()
  const a = await session(port, 'claude-code', '/work/api-server')
  const b = await session(port, 'codex-mcp-client', '/work/web-app')
  const opened = await a.call('open_bridge')
  expect(opened.name).toStartWith('api-server · Claude Code @ ')
  // 주소로 붙은 세션은 채널이 아니어서 기다리기로 받으라고 안내한다.
  expect(opened.next).toContain('wait_for_message')
  const joined = await b.call('connect', { code: opened.code })
  expect(joined.myName).toStartWith('web-app · Codex @ ')
  expect(joined.myPort).not.toBe(opened.port)
  expect((await a.call('wait_for_message', { timeout_sec: 5 })).events[0]).toMatchObject({ type: 'connected', peer: joined.myName })
  const asked = await b.call('send_question', { question: 'Is the token field read?' })
  const got = (await a.call('wait_for_message', { timeout_sec: 5 })).events[0]
  expect(got).toMatchObject({ kind: 'question', text: 'Is the token field read?', thread: asked.thread })
  await a.call('reply', { thread: got.thread, text: 'Yes, auth.ts:42.' })
  expect((await b.call('wait_for_message', { timeout_sec: 5 })).events[0]).toMatchObject({ kind: 'answer', text: 'Yes, auth.ts:42.' })
}, 20_000)

test('the app refuses web pages, other hosts and requests outside a session', async () => {
  const { port } = await startApp()
  expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200)
  expect((await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' })).status).toBe(403)
  expect(await rawStatus(port, 'evil.example')).toBe(403)
  expect(await rawStatus(port, `localhost:${port}`)).toBe(200)
  const notInit = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  expect(notInit.status).toBe(400)
  const unknown = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': 'nope' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  expect(unknown.status).toBe(404)
})

test('a quiet session keeps its bridge open; a session that ends stops it and can come back with resume', async () => {
  const { port, home } = await startApp()
  // 사람이 닫으라고 하거나 세션이 끝나기 전까지는 조용해도 그대로 둔다.
  const quiet = await session(port, 'claude-code')
  const kept = await quiet.call('open_bridge')
  await Bun.sleep(3000)
  expect(existsSync(join(home, 'bridges', `${kept.port}.json`))).toBe(true)
  expect(await quiet.call('list_connections')).toMatchObject({ me: { open: true } })

  // Claude Code 가 세션을 끝내면(DELETE) 브릿지는 멈추지만, 상태는 남아 새 세션의 AI가 되살린다.
  const ended = await session(port, 'claude-code')
  const opened = await ended.call('open_bridge')
  await ended.transport.terminateSession()
  for (let i = 0; i < 20 && existsSync(join(home, 'bridges', `${opened.port}.json`)); i++) await Bun.sleep(100)
  expect(existsSync(join(home, 'bridges', `${opened.port}.json`))).toBe(false)
  const again = await session(port, 'claude-code')
  expect(await again.call('open_bridge', { resume: opened.session_id })).toMatchObject({ resumed: true, session_id: opened.session_id, name: opened.name })
}, 20_000)

test('the app takes only so many sessions at once', async () => {
  const { port } = await startApp({ COWORKER_APP_MAX_SESSIONS: '2' })
  await session(port, 'claude-code')
  await session(port, 'claude-code')
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(init),
  })
  expect(res.status).toBe(503)
  expect(await res.text()).toContain('already has 2 sessions')
})

test('starting the app twice leaves the running one alone', async () => {
  const { port, home } = await startApp()
  const second = Bun.spawn([process.execPath, entry, 'serve'], {
    env: { ...process.env, COWORKER_HOME: home, COWORKER_APP_PORT: String(port) },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(await second.exited).toBe(0)
  expect(await new Response(second.stdout).text()).toContain('already running')
  expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true)
}, 15_000)

test('autostart runs the app with serve at login, with paths quoted for each system', () => {
  const plist = launchAgentPlist('/Users/me/.bun/bin/bun', '/Users/me/.coworker/coworker.js', '/Users/me/.coworker/app.log')
  expect(plist).toContain('<string>/Users/me/.bun/bin/bun</string><string>/Users/me/.coworker/coworker.js</string><string>serve</string>')
  expect(plist).toContain('<key>RunAtLoad</key><true/>')
  expect(launchAgentPlist('/a&b/bun', '/x<y>/c.js', '/l')).toContain('/a&amp;b/bun')
  const win = windowsShortcutScript("C:\\Users\\O'Neil\\.bun\\bin\\bun.exe", "C:\\Users\\O'Neil\\.coworker\\coworker.js", 'C:\\Startup\\coworker.lnk')
  expect(win).toContain("$s.TargetPath = 'C:\\Users\\O''Neil\\.bun\\bin\\bun.exe'")
  expect(win).toContain(`$s.Arguments = '"C:\\Users\\O''Neil\\.coworker\\coworker.js" serve'`)
  expect(win).toContain('$s.WindowStyle = 7')
})
