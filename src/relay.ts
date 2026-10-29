#!/usr/bin/env bun
import { createHash, timingSafeEqual } from 'node:crypto'
import type { Server } from 'bun'

// 중계 서버. VPN 없이 서로 다른 공유기 아래에 있는 PC끼리 이어 준다.
// 인터넷에서 닿는 곳에 하나 띄우면, 두 PC는 여기로 나가는 연결만 한다. 들어오는 연결을 받을 필요가 없다.
//
// 세션마다 우편함이 하나 있다. 보내는 쪽은 상대 우편함에 요청을 넣고 답이 올 때까지 기다린다.
// 우편함 주인은 자기 우편함에서 요청을 꺼내 처리하고 답을 돌려준다. 바로 연결할 때와 같은 요청·답이 그대로 오간다.
// 내용은 양 끝에서 암호화한 그대로 지나가므로 중계 서버는 읽지도 고치지도 못한다.
//
// 우편함 번호는 주인만 아는 비밀의 해시다. 번호는 연결 코드에 들어가 상대가 알지만,
// 우편함을 열어 꺼내 가는 것은 비밀을 아는 주인만 된다.
// RELAY_KEY 를 정해 두면 그 키를 아는 세션만 우편함을 연다. 남이 이 서버를 공짜 중계로 쓰지 못하게 한다.

export const boxOf = (secret: string) => createHash('sha256').update(secret).digest('base64url').slice(0, 22)

export type RelayOptions = {
  port?: number
  hostname?: string
  key?: string
  // 보낸 요청에 답이 오기를 기다리는 최대 시간. 상대가 메시지를 가져가려고 붙잡아 두는 요청(20초)보다 길어야 한다.
  holdMs?: number
  // 우편함 주인이 이 시간 안에 다녀가지 않으면 없는 우편함으로 본다.
  aliveMs?: number
}

type Request_ = { id: string; body: string; reply: (status: number, body: string) => void }
type Box = { queue: Request_[]; waiting: Map<string, Request_>; lastSeen: number; wake?: () => void }

const MAX_BODY = 1 << 20
const MAX_QUEUE = 200
const MAX_BOXES = 10_000
const MAX_INBOX_WAIT = 25_000

export function startRelay(options: RelayOptions = {}): Server<undefined> {
  const holdMs = options.holdMs ?? 40_000
  const aliveMs = options.aliveMs ?? 60_000
  const boxes = new Map<string, Box>()
  const key = options.key ? Buffer.from(options.key) : undefined
  let seq = 0

  const sameKey = (given: string | null) => {
    if (!key) return true
    const g = Buffer.from(given ?? '')
    return g.length === key.length && timingSafeEqual(g, key)
  }
  // 주인 확인: 비밀의 해시가 우편함 번호와 같아야 한다.
  const owner = (req: Request, box: string) => {
    const secret = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
    return !!secret && boxOf(secret) === box
  }
  const text = (status: number, body: string) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })

  // 오래 다녀가지 않은 우편함은 치운다. 기다리던 요청에는 「닿지 않음」으로 답한다.
  const sweep = setInterval(() => {
    for (const [id, box] of boxes)
      if (Date.now() - box.lastSeen > aliveMs * 2) {
        for (const r of [...box.queue, ...box.waiting.values()]) r.reply(504, 'the session left')
        boxes.delete(id)
      }
  }, aliveMs)
  sweep.unref?.()

  const server = Bun.serve({
    port: options.port ?? 8787,
    hostname: options.hostname ?? '0.0.0.0',
    maxRequestBodySize: MAX_BODY + 4096,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const [, v, action, id] = url.pathname.split('/')
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/healthz')) return text(200, 'coworker relay\n')
      if (req.method !== 'POST' || v !== 'v1' || !id || !/^[A-Za-z0-9_-]{22}$/.test(id)) return text(404, 'not found')

      // 보내는 쪽: 상대 우편함에 넣고 답을 기다린다.
      if (action === 'box') {
        const box = boxes.get(id)
        if (!box || Date.now() - box.lastSeen > aliveMs) return text(404, 'no such session')
        if (box.queue.length >= MAX_QUEUE) return text(503, 'that session has too many waiting requests')
        const body = await req.text()
        if (body.length > MAX_BODY) return text(413, 'too large')
        return await new Promise<Response>(resolve => {
          const r: Request_ = {
            id: `${Date.now().toString(36)}-${(++seq).toString(36)}`,
            body,
            reply: (status, answer) => {
              clearTimeout(timer)
              box.waiting.delete(r.id)
              box.queue = box.queue.filter(q => q !== r)
              resolve(new Response(answer, { status, headers: { 'content-type': 'application/json' } }))
            },
          }
          const timer = setTimeout(() => r.reply(504, 'no answer from the session'), holdMs)
          box.queue.push(r)
          box.wake?.()
        })
      }

      if (action !== 'inbox' && action !== 'reply') return text(404, 'not found')
      if (!sameKey(req.headers.get('x-relay-key'))) return text(401, 'wrong or missing relay key')
      if (!owner(req, id)) return text(403, 'not the owner of this box')
      let box = boxes.get(id)
      if (!box) {
        if (boxes.size >= MAX_BOXES) return text(503, 'relay is full')
        box = { queue: [], waiting: new Map(), lastSeen: Date.now() }
        boxes.set(id, box)
      }
      box.lastSeen = Date.now()
      const input = (await req.json().catch(() => null)) as { wait?: number; id?: string; status?: number; body?: string } | null

      // 주인: 처리한 요청의 답을 돌려준다.
      if (action === 'reply') {
        const r = input?.id ? box.waiting.get(input.id) : undefined
        if (r && Number.isInteger(input!.status) && typeof input!.body === 'string') r.reply(input!.status!, input!.body)
        return text(200, 'ok')
      }

      // 주인: 쌓인 요청을 꺼내 간다. 없으면 새로 올 때까지 잠깐 붙잡아 둔다.
      const wait = Math.min(Math.max(Number(input?.wait) || 0, 0), MAX_INBOX_WAIT)
      if (!box.queue.length && wait > 0) {
        await new Promise<void>(resolve => {
          const done = () => {
            clearTimeout(timer)
            if (box!.wake === done) box!.wake = undefined
            resolve()
          }
          const timer = setTimeout(done, wait)
          box!.wake?.()
          box!.wake = done
          req.signal.addEventListener('abort', done)
        })
        box.lastSeen = Date.now()
      }
      const items = box.queue.splice(0)
      for (const r of items) box.waiting.set(r.id, r)
      return Response.json({ items: items.map(r => ({ id: r.id, body: r.body })) })
    },
  })
  return server
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8787)
  const server = startRelay({ port, key: process.env.RELAY_KEY || undefined })
  console.log(`coworker relay listening on port ${server.port}${process.env.RELAY_KEY ? ' (relay key required)' : ''}`)
}
