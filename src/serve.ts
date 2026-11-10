import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { version } from '../package.json'
import { pruneSaved } from './resume'
import { createSession } from './session'

// coworker 앱. 이 PC에서 따로 켜 두면, Claude 플러그인 디렉터리판 플러그인이 http://127.0.0.1:7690/mcp 로 붙는다.
// 디렉터리는 인증된 조직이 아니면 사용자 PC에서 코드를 띄우는 플러그인을 받지 않는다(2026-11-09).
// 그래서 사람이 이 앱을 직접 깔아 켜 두고, 플러그인에는 주소만 둔다. 세션마다 브릿지를 따로 두는 것은 stdio 와 같다.
// 주소로 붙는 서버는 채널이 될 수 없어서, 이 앱에 붙은 세션은 wait_for_message 로 기다린다.
export const APP_PORT = 7690

// 세션은 사람이 닫으라고 하거나 Claude Code 가 세션을 끝낼 때(DELETE)까지 산다. 조용하다고 시간으로 정리하지 않는다(사람이 정함, 2026-11-10).
type Entry = { transport: WebStandardStreamableHTTPServerTransport; session: ReturnType<typeof createSession> }

const jsonError = (status: number, message: string) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json' },
  })

async function isInitialize(req: Request) {
  const body = (await req.clone().json().catch(() => undefined)) as { method?: string } | { method?: string }[] | undefined
  return Array.isArray(body) ? body.some(m => m?.method === 'initialize') : body?.method === 'initialize'
}

// 세션 이름에 붙일 프로젝트 폴더. 앱은 세션이 어느 폴더에서 켜졌는지 모르므로, 클라이언트가 알려 주는 폴더(roots)를 쓴다.
async function rootsFolder(server: McpServer) {
  if (!server.server.getClientCapabilities()?.roots) return undefined
  const { roots } = await server.server.listRoots(undefined, { timeout: 3000 })
  const uri = roots[0]?.uri
  return uri?.startsWith('file:') ? basename(fileURLToPath(uri)) : undefined
}

export async function serve({ home }: { home: string }) {
  const port = Number(process.env.COWORKER_APP_PORT) || APP_PORT
  const sessions = new Map<string, Entry>()
  pruneSaved(home)
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`])

  const close = (id: string) => {
    const entry = sessions.get(id)
    if (!entry) return
    sessions.delete(id)
    entry.session.shutdown()
    void entry.transport.close().catch(() => {})
  }

  const handle = async (req: Request): Promise<Response> => {
    // 웹페이지가 브라우저를 시켜 이 앱을 부르지 못하게 한다. 브라우저는 다른 사이트로 보내는 요청에 Origin 을 붙인다.
    if (req.headers.get('origin')) return new Response('requests from web pages are refused\n', { status: 403 })
    // DNS 리바인딩 막기: 이 PC의 주소로 온 요청만 받는다.
    if (!hosts.has(req.headers.get('host') ?? '')) return new Response('wrong host\n', { status: 403 })
    const url = new URL(req.url)
    if (url.pathname === '/' || url.pathname === '/health') return new Response(`coworker app ${version}\n`)
    if (url.pathname !== '/mcp') return new Response('not found\n', { status: 404 })
    const id = req.headers.get('mcp-session-id')
    if (id) {
      const entry = sessions.get(id)
      if (!entry) return jsonError(404, 'Session not found')
      return entry.transport.handleRequest(req)
    }
    if (req.method !== 'POST' || !(await isInitialize(req))) return jsonError(400, 'Bad Request: No valid session ID provided')
    const session = createSession({
      channel: false,
      hint: false,
      home,
      portsText: process.env.COWORKER_PORTS,
      relay: process.env.COWORKER_RELAY || undefined,
      relayKey: process.env.COWORKER_RELAY_KEY || undefined,
      folder: rootsFolder,
    })
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: sid => {
        sessions.set(sid, { transport, session })
      },
      onsessionclosed: sid => close(sid),
    })
    await session.server.connect(transport)
    return transport.handleRequest(req)
  }

  let server: ReturnType<typeof Bun.serve>
  try {
    // 기다리기 호출은 오래 열려 있으므로 연결을 끊는 유휴 시간을 끈다.
    server = Bun.serve({ hostname: '127.0.0.1', port, idleTimeout: 0, fetch: handle })
  } catch (e) {
    const running = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
      .then(r => r.text())
      .catch(() => '')
    if (running.startsWith('coworker app')) {
      console.log(`coworker app is already running at http://127.0.0.1:${port}/mcp (${running.trim()})`)
      process.exit(0)
    }
    console.error(`could not open 127.0.0.1:${port}: ${e instanceof Error ? e.message : e}. Another program uses this port. The Claude directory plugin connects to 127.0.0.1:${APP_PORT}, so close that program and start the app again.`)
    process.exit(1)
  }

  const stop = () => {
    for (const id of [...sessions.keys()]) close(id)
    server.stop(true)
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  console.log(`coworker app ${version} listening at http://127.0.0.1:${server.port}/mcp`)
}
