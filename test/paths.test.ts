import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import { renderAgreement, type Agreement } from '../src/agreement'
import { Bridge, routeId, safeFileName, type BridgeEvent } from '../src/bridge'
import { fromB64, seal } from '../src/crypto'
import { savedPath } from '../src/resume'
import { wake } from '../src/wake'

const prevHome = process.env.COWORKER_HOME
const sandboxes: string[] = []
const opened: Bridge[] = []
let nextPort = 18600
let sandbox = ''
let home = ''

function newSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'coworker-paths-'))
  sandboxes.push(root)
  const cwHome = join(root, 'nested', 'coworker-home')
  mkdirSync(cwHome, { recursive: true })
  return { root, cwHome }
}

beforeEach(() => {
  const made = newSandbox()
  sandbox = made.root
  home = made.cwHome
  process.env.COWORKER_HOME = home
})

afterEach(() => {
  for (const b of opened.splice(0)) b.shutdown()
})

afterAll(() => {
  if (prevHome === undefined) delete process.env.COWORKER_HOME
  else process.env.COWORKER_HOME = prevHome
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function make(name: string, extra: Partial<ConstructorParameters<typeof Bridge>[0]> = {}) {
  const start = nextPort
  nextPort += 10
  const b = new Bridge({
    name,
    ports: [start, start + 9],
    addrs: () => ['127.0.0.1'],
    retryMs: 50,
    connectTimeoutMs: 500,
    home,
    ...extra,
  })
  opened.push(b)
  return b
}

function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name)
    return entry.isDirectory() ? walkFiles(full) : [resolve(full)]
  })
}

function isUnder(parent: string, file: string) {
  const rel = relative(resolve(parent), resolve(file))
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..'
}

async function sendRaw(from: Bridge, to: Bridge, payload: unknown) {
  const body = JSON.stringify(seal(payload, fromB64(to.key), from.keys))
  return fetch(`http://127.0.0.1:${to.port}/v1/${routeId(to.key)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
}

describe('paths built from peer data', () => {
  test('thread ids from the other side must be eight lowercase hex characters', async () => {
    const outsideFile = join(sandbox, 'EXISTING.md')
    const siblingFile = join(home, 'KEEP.md')
    writeFileSync(outsideFile, 'original outside content\n')
    writeFileSync(siblingFile, 'original home content\n')

    const senderHome = join(sandbox, 'sender-home')
    mkdirSync(senderHome, { recursive: true })
    const a = make('A · Claude Code', { home })
    const b = make('B · Codex', { home: senderHome })
    a.open()
    await b.connect(a.newCode())
    await a.wait(200)

    const sampleAgreement: Agreement = {
      by: 'B · Codex',
      conclusion: 'distinct-peer-marker-9912',
      facts: [{ fact: 'checked item', evidence: 'doc:1', checkedBy: 'B · Codex' }],
      guesses: [],
      disagreements: [],
      forHumans: [],
    }
    const text = renderAgreement(sampleAgreement)

    const badThreadIds = [
      '../../KEEP',
      '/../../KEEP',
      '/../../../../EXISTING',
      '../../../outside-note',
      join(sandbox, 'abs-written'),
      resolve(sandbox, 'abs-second'),
      'sub/1234abcd',
      'sub\\1234abcd',
      '..\\..\\KEEP',
      '/..\\..\\KEEP',
      '1234\x00abcd',
      '1234abcd\x00',
      'a'.repeat(4096),
      '',
      '.',
      '..',
      '........',
      'A1b2c3d4',
      'DEADBEEF',
      '\uff411b2c3d4',
      '\uff11234abcd',
      '\u04301b2c3d4',
      'a\u03011b2c3d',
    ]

    for (const thread of badThreadIds) {
      const res = await sendRaw(b, a, {
        type: 'msg',
        msg: {
          id: randomUUID(),
          thread,
          subject: 'distinct-subject-marker-9912',
          kind: 'agreement',
          text,
          agreement: sampleAgreement,
          at: new Date().toISOString(),
        },
      })
      expect(res.status).toBe(200)
    }

    // 기존 파일은 내용이 그대로여야 한다.
    expect(readFileSync(outsideFile, 'utf8')).toBe('original outside content\n')
    expect(readFileSync(siblingFile, 'utf8')).toBe('original home content\n')

    // 잘못된 대화 ID는 대화 목록이나 알림에 들어가지 않는다.
    expect(a.threads.size).toBe(0)
    expect((await a.wait(100)).filter(e => e.type === 'message')).toEqual([])

    // sandbox 전체에 새로 생긴 파일이 agreements 바깥에는 하나도 없어야 한다.
    const agreementsDir = join(home, 'agreements')
    const allowedBefore = [join(home, 'bridges'), join(home, 'logs'), senderHome]
    const strayBefore = walkFiles(sandbox).filter(
      f => f !== resolve(outsideFile) && f !== resolve(siblingFile) && !allowedBefore.some(dir => isUnder(dir, f)),
    )
    expect(strayBefore).toEqual([])
    expect(walkFiles(agreementsDir)).toEqual([])

    // 연결 기록은 거절한 횟수를 세되, 상대가 보낸 글이나 잘못된 ID 문자열은 남기지 않는다.
    const logEntries = a.log.read({ lines: 300 })
    const refused = logEntries.filter(e => e.event === 'refused_thread_id')
    expect(refused.length).toBe(badThreadIds.length)
    expect(refused.at(-1)?.count).toBe(badThreadIds.length)
    const rawLog = JSON.stringify(logEntries)
    expect(rawLog).not.toContain('distinct-peer-marker-9912')
    expect(rawLog).not.toContain('distinct-subject-marker-9912')
    expect(rawLog).not.toContain('EXISTING')
    expect(rawLog).not.toContain('DEADBEEF')

    // 올바른 모양(8자리 소문자 16진수)의 대화 ID로 온 합의문은 agreements 폴더 안에만 저장된다.
    const goodRes = await sendRaw(b, a, {
      type: 'msg',
      msg: {
        id: randomUUID(),
        thread: '0123abcd',
        kind: 'agreement',
        text,
        agreement: sampleAgreement,
        at: new Date().toISOString(),
      },
    })
    expect(goodRes.status).toBe(200)
    const savedMd = walkFiles(agreementsDir)
    expect(savedMd).toHaveLength(1)
    expect(isUnder(agreementsDir, savedMd[0]!)).toBe(true)
  })

  test('the agreement path builder stays inside agreements even if a malformed thread reaches it directly', () => {
    const outsideFile = join(sandbox, 'KEEP-LAYER2.md')
    writeFileSync(outsideFile, 'untouched\n')
    const a = make('A · Claude Code', { home })
    const raw = a as unknown as {
      saveAgreement(t: { id: string; subject: string; peer: string; peerName: string; startedBy: 'peer'; status: 'agreed'; messages: any[] }): string | undefined
    }
    for (const badId of ['/../../../../KEEP-LAYER2', '../../KEEP-LAYER2', '..\\..\\KEEP-LAYER2', 'a\x00b', '', '..', 'A1b2c3d4']) {
      const out = raw.saveAgreement({
        id: badId,
        subject: 's',
        peer: 'k',
        peerName: 'p',
        startedBy: 'peer',
        status: 'agreed',
        messages: [{ id: '1', from: 'peer', kind: 'question', text: 'q', at: '../../bad-date' }],
      })
      if (out !== undefined) expect(isUnder(join(home, 'agreements'), out)).toBe(true)
    }
    expect(readFileSync(outsideFile, 'utf8')).toBe('untouched\n')
    const stray = walkFiles(sandbox).filter(f => f !== resolve(outsideFile) && !isUnder(join(home, 'agreements'), f))
    expect(stray).toEqual([])
  })

  test('received file names and file chunk ids cannot write outside partial or received folders', async () => {
    const keepFile = join(sandbox, 'KEEP-FILE.txt')
    writeFileSync(keepFile, 'keep\n')
    const senderHome = join(sandbox, 'sender-files')
    mkdirSync(senderHome, { recursive: true })

    const a = make('A · Claude Code', { home })
    const b = make('B · Codex', { home: senderHome })
    a.open()
    await b.connect(a.newCode())
    await a.wait(200)

    // 잘못된 조각 ID 들은 partial 폴더 바깥에도 안쪽에도 쓰이지 않는다.
    const bytes = Buffer.from('hello file\n')
    for (const badChunkId of ['../../KEEP-FILE', '/../../../../KEEP-FILE', '..\\..\\KEEP-FILE', 'abcd1234\x00efgh', '.', '..', 'short']) {
      await sendRaw(b, a, { type: 'file', id: badChunkId, seq: 0, of: 1, size: bytes.length, data: bytes.toString('base64') })
    }
    expect(readFileSync(keepFile, 'utf8')).toBe('keep\n')

    // 유효한 조각 ID와 유효한 대화 ID로 보내되 파일 이름에 경로 구분자·예약어·점·널 바이트를 넣어도 received/<대화> 안에만 저장된다.
    const strangeNames = ['../../KEEP-FILE.txt', '..\\..\\KEEP-FILE.txt', '/etc/hosts', '.hidden', '..', 'a\x00b.txt', 'CON.txt', 'trailing. ']
    for (let i = 0; i < strangeNames.length; i++) {
      const fid = randomUUID()
      const thread = `0000000${i}`
      await sendRaw(b, a, { type: 'file', id: fid, seq: 0, of: 1, size: bytes.length, data: bytes.toString('base64') })
      await sendRaw(b, a, {
        type: 'msg',
        msg: {
          id: randomUUID(),
          thread,
          kind: 'question',
          text: 'file check',
          files: [{ id: fid, name: strangeNames[i]!, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }],
          at: new Date().toISOString(),
        },
      })
    }

    const events: BridgeEvent[] = []
    for (let i = 0; i < 20 && events.length < strangeNames.length; i++) {
      events.push(...(await a.wait(100)).filter(e => e.type === 'message'))
    }
    expect(events).toHaveLength(strangeNames.length)
    const receivedRoot = join(home, 'files', routeId(a.key), 'received')
    for (const e of events) {
      if (e.type !== 'message') continue
      const savedTo = e.files?.[0]?.saved_to
      expect(savedTo).toBeDefined()
      expect(isUnder(receivedRoot, savedTo!)).toBe(true)
    }
    expect(readFileSync(keepFile, 'utf8')).toBe('keep\n')
    for (const n of ['CON.txt', 'nul']) expect(safeFileName(n)).not.toMatch(/^(?:con|nul)(?:\.|$)/i)
  })

  test('peer session names, session resume ids, and log files stay inside their folders under home', async () => {
    const keepJson = join(sandbox, 'keep.json')
    writeFileSync(keepJson, '{"keep":true}\n')
    const senderHome = join(sandbox, 'sender-peer')
    mkdirSync(senderHome, { recursive: true })

    // 상대 세션 이름은 파일 경로에 쓰이지 않는다.
    const a = make('A · Claude Code', { home, saveTo: savedPath(home, 'host-session') })
    const b = make('/../../../../outside-peer', { home: senderHome })
    a.open()
    await b.connect(a.newCode())
    await a.wait(200)
    const asked = await b.ask(undefined, 'Question from strange peer name?')
    const got = (await a.wait(500)).find(e => e.type === 'message') as Extract<BridgeEvent, { type: 'message' }>
    await a.agree(got.thread, { conclusion: 'Settled.' })
    await b.close()
    await a.wait(200)

    // 세션 저장 경로와 wake 입력도 sessions 폴더 바깥을 가리키지 않는다.
    for (const rawId of ['../../../keep', '..\\..\\keep', '/abs/keep', '..', '.', 'a\x00b', '.hidden']) {
      const p = savedPath(home, rawId)
      expect(isUnder(join(home, 'sessions'), p)).toBe(true)
    }
    expect(await wake(home, JSON.stringify({ session_id: '../../../keep' }))).toBe(0)
    expect(readFileSync(keepJson, 'utf8')).toBe('{"keep":true}\n')

    // 연결 기록 파일도 logs 폴더 안에만 생긴다.
    expect(a.log.path).toBeDefined()
    expect(isUnder(join(home, 'logs'), a.log.path!)).toBe(true)

    // home 안팎의 모든 파일이 정해진 폴더 안에만 있는지 확인한다.
    const allowedRoots = ['agreements', 'bridges', 'files', 'logs', 'sessions'].map(d => join(home, d))
    const writtenInHome = walkFiles(home)
    for (const f of writtenInHome) {
      expect(allowedRoots.some(r => isUnder(r, f))).toBe(true)
    }
    const outsideHome = walkFiles(sandbox).filter(f => f !== resolve(keepJson) && !isUnder(home, f) && !isUnder(senderHome, f))
    expect(outsideHome).toEqual([])
    expect(asked.thread).toMatch(/^[0-9a-f]{8}$/)
  })

  test('two bridges on one home with different peers and the same thread id on the same day write separate agreement files', async () => {
    const peerOneHome = join(sandbox, 'peer-one')
    const peerTwoHome = join(sandbox, 'peer-two')
    mkdirSync(peerOneHome, { recursive: true })
    mkdirSync(peerTwoHome, { recursive: true })

    const desk = make('Desk · Claude Code', { home })
    const other = make('Other · Claude Code', { home })
    const peerOne = make('Peer One · Codex', { home: peerOneHome })
    const peerTwo = make('Peer Two · Codex', { home: peerTwoHome })

    desk.open()
    other.open()
    await peerOne.connect(desk.newCode())
    await peerTwo.connect(other.newCode())
    await desk.wait(200)
    await other.wait(200)

    const sharedThread = 'abcd0123'
    const at = new Date().toISOString()
    const firstAgreement: Agreement = {
      by: 'Peer One · Codex',
      conclusion: 'Desk settled on port 7701.',
      facts: [{ fact: 'desk config line 4', evidence: 'config.toml:4', checkedBy: 'Peer One · Codex' }],
      guesses: [],
      disagreements: [],
      forHumans: [],
    }
    const secondAgreement: Agreement = {
      by: 'Peer Two · Codex',
      conclusion: 'Other settled on port 9900.',
      facts: [{ fact: 'other config line 9', evidence: 'other.toml:9', checkedBy: 'Peer Two · Codex' }],
      guesses: [],
      disagreements: [],
      forHumans: [],
    }

    expect(
      (
        await sendRaw(peerOne, desk, {
          type: 'msg',
          msg: { id: randomUUID(), thread: sharedThread, subject: 'Desk port', kind: 'agreement', text: renderAgreement(firstAgreement), agreement: firstAgreement, at },
        })
      ).status,
    ).toBe(200)
    const firstGot = (await desk.wait(300)).find(e => e.type === 'message') as Extract<BridgeEvent, { type: 'message' }>
    expect(firstGot.file).toBeDefined()
    const firstBytes = Buffer.from(readFileSync(firstGot.file!))

    expect(
      (
        await sendRaw(peerTwo, other, {
          type: 'msg',
          msg: { id: randomUUID(), thread: sharedThread, subject: 'Other port', kind: 'agreement', text: renderAgreement(secondAgreement), agreement: secondAgreement, at },
        })
      ).status,
    ).toBe(200)
    const secondGot = (await other.wait(300)).find(e => e.type === 'message') as Extract<BridgeEvent, { type: 'message' }>
    expect(secondGot.file).toBeDefined()

    expect(secondGot.file).not.toBe(firstGot.file)
    expect(basename(firstGot.file!)).toMatch(/^\d{4}-\d{2}-\d{2}-abcd0123-[0-9a-f]{24}\.md$/)
    expect(basename(secondGot.file!)).toMatch(/^\d{4}-\d{2}-\d{2}-abcd0123-[0-9a-f]{24}\.md$/)
    expect(basename(firstGot.file!).toLowerCase()).not.toBe(basename(secondGot.file!).toLowerCase())

    const files = walkFiles(join(home, 'agreements'))
    expect(files).toHaveLength(2)
    expect(Buffer.compare(readFileSync(firstGot.file!), firstBytes)).toBe(0)
    expect(readFileSync(secondGot.file!, 'utf8')).toContain('Other settled on port 9900.')
  })

  test('saving again on the same conversation updates its own file, and pre-update agreement files keep their names', async () => {
    const senderHome = join(sandbox, 'sender-repeat')
    mkdirSync(senderHome, { recursive: true })
    const saveTo = savedPath(home, 'repeat-session')
    const a = make('A · Claude Code', { home, saveTo })
    const b = make('B · Codex', { home: senderHome })
    a.open()
    await b.connect(a.newCode())
    await a.wait(200)

    const { thread } = await b.ask(undefined, 'Which cache TTL do we use?')
    await a.wait(200)
    await a.reply(thread!, '60 seconds.')
    await b.wait(200)

    // 같은 상대가 같은 대화에 합의문을 두 번 쓰면 전과 같이 그 대화의 파일을 새 판으로 바꾼다.
    const wrote1 = await b.agree(thread!, { conclusion: 'Draft: 30 seconds.' })
    const got1 = (await a.wait(300)).find(e => e.type === 'message') as Extract<BridgeEvent, { type: 'message' }>
    const wrote2 = await b.agree(thread!, { conclusion: 'Final: 60 seconds.' })
    const got2 = (await a.wait(300)).find(e => e.type === 'message') as Extract<BridgeEvent, { type: 'message' }>

    expect(wrote2.file).toBe(wrote1.file)
    expect(got2.file).toBe(got1.file)
    expect(walkFiles(join(home, 'agreements'))).toHaveLength(1)
    expect(readFileSync(got2.file!, 'utf8')).toContain('Final: 60 seconds.')
    expect(readFileSync(got2.file!, 'utf8')).not.toContain('Draft: 30 seconds.')

    // 반대쪽이 자기 판을 더해도 같은 파일 하나에 두 판이 함께 남는다.
    const wroteA = await a.agree(thread!, { conclusion: 'Agreed: 60 seconds.' })
    expect(wroteA.file).toBe(got2.file)
    const combined = readFileSync(wroteA.file!, 'utf8')
    expect(combined).toContain('# 합의문 · B · Codex 작성')
    expect(combined).toContain('# 합의문 · A · Claude Code 작성')

    // 예전 이름(<날짜>-<대화 id>.md)으로 저장된 파일은 그대로 남고, 같은 날 다시 저장하면 새 이름으로 따로 남는다.
    const day = new Date().toISOString().slice(0, 10)
    const legacyThread = '1122aabb'
    const legacyPath = join(home, 'agreements', `${day}-${legacyThread}.md`)
    const legacyBytes = Buffer.from('# 합의문: Legacy topic\n\npre-update file bytes\n', 'utf8')
    writeFileSync(legacyPath, legacyBytes)

    await Bun.sleep(150)
    a.shutdown()
    opened.splice(opened.indexOf(a), 1)

    const saved = JSON.parse(readFileSync(saveTo, 'utf8'))
    const legacyAgreement: Agreement = {
      by: 'B · Codex',
      conclusion: 'Pre-update conclusion.',
      facts: [],
      guesses: [],
      disagreements: [],
      forHumans: [],
    }
    saved.threads.push({
      id: legacyThread,
      peer: b.key,
      peerName: 'B · Codex',
      subject: 'Legacy topic',
      startedBy: 'peer',
      status: 'agreed',
      messages: [
        { id: 'm1', from: 'peer', kind: 'question', text: 'Legacy topic?', at: `${day}T00:00:00.000Z` },
        { id: 'm2', from: 'peer', kind: 'agreement', text: renderAgreement(legacyAgreement), agreement: legacyAgreement, at: `${day}T00:01:00.000Z` },
      ],
    })
    saved.events = [
      {
        type: 'message',
        thread: legacyThread,
        from: 'B · Codex',
        kind: 'agreement',
        text: renderAgreement(legacyAgreement),
        status: 'agreed',
        agreement: legacyAgreement,
        file: legacyPath,
        at: `${day}T00:01:00.000Z`,
      },
    ]

    const start = nextPort
    nextPort += 10
    const restored = Bridge.restore(saved, {
      ports: [start, start + 9],
      addrs: () => ['127.0.0.1'],
      retryMs: 50,
      connectTimeoutMs: 500,
      home,
      saveTo,
    })
    opened.push(restored)

    expect(restored.threads.get(legacyThread)?.status).toBe('agreed')
    expect(restored.threadSummaries().some(s => s.id === legacyThread && s.status === 'agreed')).toBe(true)
    const unread = await restored.wait(0)
    expect(unread.find(e => e.type === 'message' && e.thread === legacyThread)).toMatchObject({ file: legacyPath })

    const updated = await restored.agree(legacyThread, { conclusion: 'Post-update addition.' })
    expect(updated.file).toBeDefined()
    expect(updated.file).not.toBe(legacyPath)
    expect(Buffer.compare(readFileSync(legacyPath), legacyBytes)).toBe(0)
    expect(readFileSync(updated.file!, 'utf8')).toContain('Pre-update conclusion.')
    expect(readFileSync(updated.file!, 'utf8')).toContain('Post-update addition.')
  })

  test('two bridges on one home joined to the same peer write separate agreement files for the same thread id', async () => {
    const peerHome = join(sandbox, 'shared-peer')
    mkdirSync(peerHome, { recursive: true })

    const one = make('One · Claude Code', { home })
    const two = make('Two · Claude Code', { home })
    const peer = make('Shared Peer · Codex', { home: peerHome })

    one.open()
    two.open()
    await peer.connect(one.newCode())
    await peer.connect(two.newCode())
    await one.wait(200)
    await two.wait(200)

    const asked = await one.ask(undefined, 'Which port does service one use?')
    await peer.wait(200)
    const firstWrote = await one.agree(asked.thread!, {
      conclusion: 'Service one uses port 7701.',
      facts: [{ fact: 'one.toml maps 7701', evidence: 'one.toml:3', checkedBy: 'me' }],
    })
    expect(firstWrote.file).toBeDefined()
    const firstBytes = Buffer.from(readFileSync(firstWrote.file!))

    const peerAgreement: Agreement = {
      by: 'Shared Peer · Codex',
      conclusion: 'Service two uses port 9900.',
      facts: [{ fact: 'two.toml maps 9900', evidence: 'two.toml:5', checkedBy: 'Shared Peer · Codex' }],
      guesses: [],
      disagreements: [],
      forHumans: [],
    }
    const res = await sendRaw(peer, two, {
      type: 'msg',
      msg: {
        id: randomUUID(),
        thread: asked.thread!,
        subject: 'Service two port',
        kind: 'agreement',
        text: renderAgreement(peerAgreement),
        agreement: peerAgreement,
        at: new Date().toISOString(),
      },
    })
    expect(res.status).toBe(200)
    const secondGot = (await two.wait(300)).find(e => e.type === 'message') as Extract<BridgeEvent, { type: 'message' }>
    expect(secondGot.file).toBeDefined()

    expect(secondGot.file).not.toBe(firstWrote.file)
    expect(walkFiles(join(home, 'agreements'))).toHaveLength(2)
    expect(Buffer.compare(readFileSync(firstWrote.file!), firstBytes)).toBe(0)
    expect(readFileSync(secondGot.file!, 'utf8')).toContain('Service two uses port 9900.')

    const pairTag = (ownKey: string, peerKey: string) =>
      createHash('sha256').update(Buffer.from(ownKey, 'base64')).update(Buffer.from(peerKey, 'base64')).digest('hex').slice(0, 24)
    expect(basename(firstWrote.file!)).toMatch(new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${asked.thread}-${pairTag(one.key, peer.key)}\\.md$`))
    expect(basename(secondGot.file!)).toMatch(new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${asked.thread}-${pairTag(two.key, peer.key)}\\.md$`))
  })
})
