import { afterEach, describe, expect, test } from 'bun:test'
import type { Server } from 'bun'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Bridge, FILE_CHUNK, MAX_FILE_BYTES, MAX_FILES, safeFileName, type BridgeEvent, type SavedBridge } from '../src/bridge'
import { startRelay } from '../src/relay'

// 파일 주고받기. 세션마다 자기 폴더(home)가 있고, 받은 파일은 그 안에 저장된다.
const servers: Server<undefined>[] = []
const bridges: Bridge[] = []
let nextPort = 18300
type Message = Extract<BridgeEvent, { type: 'message' }>

const folder = (label: string) => mkdtempSync(join(tmpdir(), `coworker-files-${label}-`))

function make(name: string, extra: Partial<ConstructorParameters<typeof Bridge>[0]> = {}) {
  const start = nextPort
  nextPort += 10
  const b = new Bridge({ name, ports: [start, start + 9], addrs: () => ['127.0.0.1'], retryMs: 50, connectTimeoutMs: 500, pollWaitMs: 1000, home: folder('home'), ...extra })
  bridges.push(b)
  return b
}

function relay() {
  const server = startRelay({ port: 0, hostname: '127.0.0.1', holdMs: 30_000 })
  servers.push(server)
  return `http://127.0.0.1:${server.port}`
}

async function pair(aExtra = {}, bExtra = {}) {
  const a = make('A · Claude Code', aExtra)
  const b = make('B · Codex', bExtra)
  a.open()
  await b.connect(a.newCode())
  await next(a, 'connected')
  return { a, b }
}

async function next(b: Bridge, type: BridgeEvent['type']) {
  for (let i = 0; i < 60; i++) {
    const found = (await b.wait(200)).find(e => e.type === type)
    if (found) return found
  }
  throw new Error(`no ${type} event`)
}

// 보낼 파일을 임시 폴더에 만든다.
function file(name: string, content: string | Buffer) {
  const path = join(folder('src'), name)
  writeFileSync(path, content)
  return path
}
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await Bun.sleep(30)
  return ok()
}
// 세션의 파일 폴더 안에 든 것.
const inside = (b: Bridge, kind: string) => {
  const dir = join((b as unknown as { opts: { home: string }; route: string }).opts.home, 'files', (b as unknown as { route: string }).route, kind)
  return existsSync(dir) ? readdirSync(dir) : []
}

afterEach(() => {
  for (const b of bridges.splice(0)) b.shutdown()
  for (const s of servers.splice(0)) s.stop(true)
})

describe('files', () => {
  test('files go with a question: the receiver saves them after checking size and sha256, and both conversations keep the record', async () => {
    const { a, b } = await pair()
    const note = '# 설치 안내\n\n1. prep-run.sh 를 실행합니다.\n'
    const big = randomBytes(FILE_CHUNK * 2 + 4321)
    const sent = await b.ask(undefined, 'Here is the bundle. Please check it.', undefined, [file('설치안내.md', note), file('prep-run.bin', big)])
    // 보낸 AI는 무엇이 갔는지 이름, 크기, sha256 으로 본다.
    expect(sent).toMatchObject({
      delivery: 'delivered',
      files: [
        { name: '설치안내.md', size: Buffer.byteLength(note), sha256: sha256(note) },
        { name: 'prep-run.bin', size: big.length, sha256: sha256(big) },
      ],
    })

    const got = (await next(a, 'message')) as Message
    expect(got.files).toMatchObject([
      { name: '설치안내.md', size: Buffer.byteLength(note), sha256: sha256(note), verified: true },
      { name: 'prep-run.bin', size: big.length, sha256: sha256(big), verified: true },
    ])
    // 받은 파일은 이 세션의 폴더에 대화마다 따로, 본인만 읽게 저장된다. 내용은 보낸 것과 같다.
    const [first, second] = got.files!
    expect(first!.saved_to).toStartWith(join((a as unknown as { opts: { home: string } }).opts.home, 'files'))
    expect(first!.saved_to).toContain(join('received', got.thread))
    expect(readFileSync(first!.saved_to!, 'utf8')).toBe(note)
    expect(readFileSync(second!.saved_to!).equals(big)).toBe(true)
    if (process.platform !== 'win32') expect(statSync(first!.saved_to!).mode & 0o777).toBe(0o600)

    // 대화 기록에 누가(from), 언제(at), 무엇을(name, size, sha256) 보냈는지 남는다.
    const kept = a.threads.get(got.thread)!.messages[0]!
    expect(kept).toMatchObject({ from: 'peer', files: [{ name: '설치안내.md', sha256: sha256(note), ok: true, path: first!.saved_to }, { name: 'prep-run.bin', ok: true }] })
    expect(typeof kept.at).toBe('string')
    // 보낸 쪽 기록에는 상대가 받아서 확인했다는 것이 붙는다.
    const mine = b.threads.get(sent.thread!)!.messages[0]!
    expect(await until(() => mine.files!.every(f => f.ok === true))).toBe(true)
    expect(mine).toMatchObject({ from: 'me', files: [{ name: '설치안내.md', size: Buffer.byteLength(note), sha256: sha256(note) }, { name: 'prep-run.bin' }] })
    // 다 넘어간 뒤에는 보내려고 둔 사본과 받다 만 조각이 남지 않는다.
    expect(inside(b, 'out')).toEqual([])
    expect(inside(a, 'partial')).toEqual([])

    // 답에도 붙일 수 있다. 같은 이름이 또 오면 덮어쓰지 않는다.
    await a.reply(got.thread, 'Fixed. See the new file.', { files: [file('설치안내.md', 'v2')] })
    const back = (await next(b, 'message')) as Message
    expect(back).toMatchObject({ kind: 'answer', files: [{ name: '설치안내.md', verified: true }] })
    expect(readFileSync(back.files![0]!.saved_to!, 'utf8')).toBe('v2')
    await b.reply(sent.thread!, 'One more.', { files: [file('설치안내.md', 'v3')] })
    const again = (await next(a, 'message')) as Message
    expect(basename(again.files![0]!.saved_to!)).toBe('설치안내 (2).md')
    expect(readFileSync(first!.saved_to!, 'utf8')).toBe(note)
  })

  test('files go through the relay, both when each side uses it and when one side comes to pick up', async () => {
    const url = relay()
    // 둘 다 주소를 내놓지 않아서 중계 서버로만 닿는다.
    const a = make('A', { relay: url, addrs: () => [] })
    const b = make('B', { relay: url, addrs: () => [] })
    a.open()
    expect(await a.relayReady(2000)).toBe('ok')
    await b.connect(a.newCode())
    await next(a, 'connected')
    const bytes = randomBytes(FILE_CHUNK * 3 + 17)
    const sent = await b.ask(undefined, 'A file through the relay.', undefined, [file('bundle.tar', bytes)])
    expect(sent.delivery).toBe('delivered')
    const got = (await next(a, 'message')) as Message
    expect(got.files).toMatchObject([{ name: 'bundle.tar', size: bytes.length, sha256: sha256(bytes), verified: true }])
    expect(readFileSync(got.files![0]!.saved_to!).equals(bytes)).toBe(true)

    // 한쪽만 중계 서버를 쓴다. 다른 쪽은 중계 서버를 거쳐 와서 자기 앞으로 온 것을 가져간다. 조각은 나눠서 넘어간다.
    const c = make('C', { relay: url, addrs: () => [] })
    const d = make('D', { addrs: () => [] })
    c.open()
    await c.relayReady(2000)
    await d.connect(c.newCode())
    await next(c, 'connected')
    const { thread } = await d.ask(undefined, 'ping?')
    await next(c, 'message')
    for (let i = 0; i < 40 && !(await c.connections()).peers[0]!.reachable; i++) await Bun.sleep(50)
    const more = randomBytes(FILE_CHUNK * 4 + 99)
    await c.reply(thread!, 'pong, with a file', { files: [file('picked-up.bin', more)] })
    const picked = (await next(d, 'message')) as Message
    expect(picked.files).toMatchObject([{ name: 'picked-up.bin', size: more.length, verified: true }])
    expect(readFileSync(picked.files![0]!.saved_to!).equals(more)).toBe(true)
    expect(await until(() => inside(c, 'out').length === 0)).toBe(true)
  }, 30_000)

  test('files wait with their message while the other side is away, also across a restart of the sender', async () => {
    const dir = folder('state')
    const home = folder('home')
    const a = make('A · Claude Code', { saveTo: join(dir, 'a.json') })
    const b = make('B · Codex', { saveTo: join(dir, 'b.json'), home })
    a.open()
    await b.connect(a.newCode())
    await next(a, 'connected')
    const [aPort, bPort] = [a.port, b.port]
    // A가 꺼졌다. B가 보낸 파일과 글은 줄에 선다.
    a.shutdown()
    const bytes = randomBytes(FILE_CHUNK + 500)
    const sent = await b.ask(undefined, 'For when you are back.', undefined, [file('later.bin', bytes)])
    expect(sent.delivery).toBe('queued')
    expect(inside(b, 'out')).toHaveLength(1)
    // 줄에 선 조각에는 내용이 없다. 내용은 사본에 있다.
    b.shutdown()
    const saved = JSON.parse(readFileSync(join(dir, 'b.json'), 'utf8')) as SavedBridge
    expect(JSON.stringify(saved.outbox)).not.toContain('"data"')
    expect(saved.outbox.map(o => o.payload.type)).toEqual(['file', 'file', 'msg'])

    // B가 다시 켜지고, 그 뒤에 A가 돌아온다. 파일이 온전히 간다.
    const b2 = Bridge.restore(saved, { ports: [bPort, bPort + 9], addrs: () => ['127.0.0.1'], retryMs: 50, connectTimeoutMs: 500, saveTo: join(dir, 'b.json'), home })
    bridges.push(b2)
    const a2 = Bridge.restore(JSON.parse(readFileSync(join(dir, 'a.json'), 'utf8')), { ports: [aPort, aPort + 9], addrs: () => ['127.0.0.1'], retryMs: 50, connectTimeoutMs: 500, saveTo: join(dir, 'a.json'), home: (a as unknown as { opts: { home: string } }).opts.home })
    bridges.push(a2)
    const got = (await next(a2, 'message')) as Message
    expect(got).toMatchObject({ text: 'For when you are back.', files: [{ name: 'later.bin', size: bytes.length, sha256: sha256(bytes), verified: true }] })
    expect(readFileSync(got.files![0]!.saved_to!).equals(bytes)).toBe(true)
    expect(await until(() => inside(b2, 'out').length === 0)).toBe(true)
  }, 30_000)

  test('a file that changed on the way is not saved: the receiver says why, and the sender is told', async () => {
    const { a, b } = await pair()
    // 가는 길에 첫 조각이 바뀌었다고 하자.
    const raw = b as unknown as { withData(p: { type: string; seq?: number; data?: string }): { type: string; data?: string } }
    const real = raw.withData.bind(b)
    raw.withData = p => {
      const out = real(p)
      return out.type === 'file' && p.seq === 0 ? { ...out, data: Buffer.from(Buffer.from(out.data!, 'base64').map(v => v ^ 1)).toString('base64') } : out
    }
    const sent = await b.ask(undefined, 'Check this.', undefined, [file('changed.txt', 'the original words')])
    const got = (await next(a, 'message')) as Message
    expect(got.files).toEqual([{ name: 'changed.txt', size: 18, sha256: sha256('the original words'), verified: false, problem: 'the sha256 differs from what the sender said' }])
    expect(a.threads.get(got.thread)!.messages[0]!.files).toMatchObject([{ ok: false, problem: 'sha256' }])
    expect(inside(a, 'partial')).toEqual([])
    expect(inside(a, 'received')).toEqual([])
    // 보낸 AI는 다시 보내야 한다는 것을 안다.
    expect(await next(b, 'undelivered')).toMatchObject({ to: 'A · Claude Code', thread: sent.thread, reason: expect.stringContaining('changed.txt (the sha256 differs from what the sender said)') })
    expect(b.threads.get(sent.thread!)!.messages[0]!.files).toMatchObject([{ ok: false, problem: 'sha256' }])
  })

  test('the name and the conversation id that come from the other side cannot place a file outside the received folder', async () => {
    const { a, b } = await pair()
    expect(['../../evil.sh', '..\\..\\evil.sh', '/etc/passwd', '.bashrc', 'a\x00b', '', '   ', 'x'.repeat(400)].map(safeFileName)).toEqual(['evil.sh', 'evil.sh', 'passwd', 'bashrc', 'a_b', 'file', 'file', 'x'.repeat(150)])
    // 잘못된 대화 번호로 온 글은 거절하고 파일을 저장하지 않는다. 파일 이름만 이상한 글은 이름만 다듬어 받은 폴더 안에 둔다.
    const raw = b as unknown as { sendOrQueue(peer: unknown, payload: { type: string; msg?: { thread: string; files?: { name: string }[] } }, thread?: string, patient?: boolean): Promise<unknown> }
    const real = raw.sendOrQueue.bind(b)
    let badThread = true
    raw.sendOrQueue = (peer, payload, thread, patient) => {
      if (payload.type === 'msg' && payload.msg?.files) {
        if (badThread) payload.msg.thread = '../../../outside'
        payload.msg.files[0]!.name = '../../evil.sh'
      }
      return real(peer, payload, thread, patient)
    }
    const base = join((a as unknown as { opts: { home: string } }).opts.home, 'files')
    await b.ask(undefined, 'A file with a bad thread id.', undefined, [file('plain.sh', 'echo hi\n')])
    expect(await a.wait(200)).toEqual([])
    expect(existsSync(join(base, '..', 'outside'))).toBe(false)
    expect(inside(a, 'received')).toEqual([])

    badThread = false
    const sent = await b.ask(undefined, 'A file with a strange name.', undefined, [file('plain.sh', 'echo hi\n')])
    const got = (await next(a, 'message')) as Message
    expect(got.files).toMatchObject([{ name: 'evil.sh', verified: true }])
    expect(got.files![0]!.saved_to).toStartWith(base)
    expect(got.files![0]!.saved_to).toEndWith(join('received', sent.thread!, 'evil.sh'))
    expect(existsSync(join(base, '..', 'outside'))).toBe(false)
  })

  test('nothing is sent when a file is missing, too large, too many, or looks like it holds a secret', async () => {
    const { a, b } = await pair()
    const none = async (files: string[], why: string, reviewed = false) => {
      await expect(b.ask(undefined, 'With files.', undefined, files, reviewed)).rejects.toThrow(why)
      expect(b.threads.size).toBe(0)
      expect(inside(b, 'out')).toEqual([])
    }
    await none([join(tmpdir(), 'no-such-file-here.txt')], 'cannot read the file')
    await none([tmpdir()], 'cannot read the file')
    await none([file('huge.bin', Buffer.alloc(MAX_FILE_BYTES + 1))], 'larger than 10 MiB')
    await none(
      Array.from({ length: MAX_FILES + 1 }, (_, i) => file(`f${i}.txt`, 'x')),
      `at most ${MAX_FILES} files`,
    )
    // 열쇠나 비밀번호를 담는 이름의 파일, 모양이 정해진 열쇠가 든 파일은 사람이 봤다고 해도 보내지 않는다.
    await none([file('.env', 'A=1')], 'holds keys or passwords', true)
    await none([file('server.pem', 'x')], 'holds keys or passwords', true)
    await none([file('notes.txt', 'the key is AKIAIOSFODNN7EXAMPLE')], 'AWS access key', true)
    // 「password = 값」 꼴은 사람이 보고 진짜가 아니라고 해야 간다.
    const script = file('run.sh', 'DB_PASSWORD=hunter2!x9\necho done\n')
    await none([script], 'files_reviewed_by_human: true')
    expect((await b.ask(undefined, 'With a reviewed script.', undefined, [script], true)).delivery).toBe('delivered')
    expect(((await next(a, 'message')) as Message).files).toMatchObject([{ name: 'run.sh', verified: true }])
  })

  test('a session that runs an older version is not sent files; closing the bridge clears what was waiting but keeps what was received', async () => {
    const { a, b } = await pair()
    // 받은 파일이 하나 있다.
    await b.ask(undefined, 'Keep this.', undefined, [file('keep.txt', 'kept')])
    const got = (await next(a, 'message')) as Message
    // A가 옛 판이라고 하자: 할 수 있는 것을 알리지 않는다.
    const raw = a as unknown as { process(peer: unknown, payload: unknown): { type: string; can?: string[] } | null }
    const real = raw.process.bind(a)
    raw.process = (peer, payload) => {
      const out = real(peer, payload)
      if (out) delete out.can
      return out
    }
    b.peers.get(a.key)!.can = undefined
    await expect(b.reply(got.thread, 'More files.', { files: [file('more.txt', 'more')] })).rejects.toThrow('cannot receive files')
    expect(b.threads.get(got.thread)!.messages).toHaveLength(1)
    expect(inside(b, 'out')).toEqual([])

    // 줄에 선 파일이 있는 채로 사람이 브릿지를 닫는다.
    mkdirSync(join((a as unknown as { opts: { home: string } }).opts.home, 'files', (a as unknown as { route: string }).route, 'partial'), { recursive: true })
    writeFileSync(join((a as unknown as { opts: { home: string } }).opts.home, 'files', (a as unknown as { route: string }).route, 'partial', 'left-over'), 'x')
    await a.close()
    expect(inside(a, 'partial')).toEqual([])
    expect(readFileSync(got.files![0]!.saved_to!, 'utf8')).toBe('kept')
  })
})
