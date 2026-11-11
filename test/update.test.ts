import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { version } from '../package.json'
import { createSession } from '../src/session'
import { newer, PLUGIN, selfUpdate, type Run } from '../src/update'

// 릴리스 브랜치의 매니페스트 노릇을 하는 서버. 시험마다 최신 판 번호를 바꾼다.
let latest = '0.5.0'
const manifest = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ name: 'coworker', version: latest }) })
beforeAll(() => {
  process.env.COWORKER_UPDATE_URL = `http://127.0.0.1:${manifest.port}/plugin.json`
})
afterAll(() => {
  delete process.env.COWORKER_UPDATE_URL
  manifest.stop(true)
})

// claude·codex 명령 대신 부르는 가짜. 부른 명령을 적어 두고, 올리면 설치된 판이 바뀐다.
function fakeApp(installedVersion: string) {
  const calls: string[] = []
  let current = installedVersion
  const exec: Run = async cmd => {
    const args = cmd.slice(1).join(' ')
    calls.push(args)
    if (args === 'plugin list --json') return { code: 0, out: JSON.stringify([{ id: PLUGIN, version: current, scope: 'user' }]) }
    if (args === 'plugin list') return { code: 0, out: `PLUGIN  STATUS  VERSION  SOURCE\n${PLUGIN}  installed, enabled  ${current}  /x\n` }
    if (args.startsWith('plugin update') || args.startsWith('plugin add')) current = latest
    return { code: 0, out: '' }
  }
  return { exec, calls }
}

test('version numbers compare part by part', () => {
  expect(newer('0.4.12', '0.4.11')).toBe(true)
  expect(newer('0.4.10', '0.4.9')).toBe(true)
  expect(newer('0.5.0', '0.4.99')).toBe(true)
  expect(newer('0.4.11', '0.4.11')).toBe(false)
  expect(newer('0.4.9', '0.4.10')).toBe(false)
  expect(newer('abc', '0.1.0')).toBe(false)
})

test('a newer release updates the Claude Code plugin with its own commands', async () => {
  latest = '0.5.0'
  const home = mkdtempSync(join(tmpdir(), 'coworker-update-'))
  const app = fakeApp('0.4.11')
  expect(await selfUpdate('claude', '0.4.11', home, app.exec)).toEqual({ to: '0.5.0' })
  expect(app.calls).toEqual([
    'plugin list --json',
    'plugin marketplace update ai-coworker-without-me',
    `plugin update ${PLUGIN} --scope user --json`,
    'plugin list --json',
  ])
  // 잠금은 풀려 있다.
  expect(existsSync(join(home, 'update.lock'))).toBe(false)
})

test('Codex refreshes the marketplace and adds the plugin again', async () => {
  latest = '0.5.0'
  const home = mkdtempSync(join(tmpdir(), 'coworker-update-'))
  const app = fakeApp('0.4.11')
  expect(await selfUpdate('codex', '0.4.11', home, app.exec)).toEqual({ to: '0.5.0' })
  expect(app.calls).toEqual(['plugin list', 'plugin marketplace upgrade ai-coworker-without-me', `plugin add ${PLUGIN}`, 'plugin list'])
})

test('nothing runs when this is the newest release, when another session already updated, or while another session updates', async () => {
  const home = mkdtempSync(join(tmpdir(), 'coworker-update-'))
  latest = '0.4.11'
  const same = fakeApp('0.4.11')
  expect(await selfUpdate('claude', '0.4.11', home, same.exec)).toBeUndefined()
  expect(same.calls).toEqual([])

  // 다른 세션이 이미 올렸다. 명령은 돌리지 않고, 설치된 새 판을 알려 준다.
  latest = '0.5.0'
  const done = fakeApp('0.5.0')
  expect(await selfUpdate('claude', '0.4.11', home, done.exec)).toEqual({ to: '0.5.0' })
  expect(done.calls).toEqual(['plugin list --json', 'plugin list --json'])

  // 다른 세션이 올리는 중이다(잠금이 있다).
  writeFileSync(join(home, 'update.lock'), '')
  const busy = fakeApp('0.4.11')
  expect(await selfUpdate('claude', '0.4.11', home, busy.exec)).toBeUndefined()
  expect(busy.calls).toEqual([])
})

test('after an update the AI tells its human once to reload', async () => {
  process.env.COWORKER_UPDATE_FIRST_MS = '10'
  try {
    const home = mkdtempSync(join(tmpdir(), 'coworker-update-'))
    const session = createSession({ channel: false, hint: false, home, folder: () => undefined, autoUpdate: true, updater: async () => ({ to: '9.9.9' }) })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await session.server.connect(serverSide)
    const client = new Client({ name: 'claude-code', version: '1.0.0' })
    await client.connect(clientSide)
    const call = async () => JSON.parse(((await client.callTool({ name: 'list_connections', arguments: {} })) as { content: { text: string }[] }).content[0]!.text)
    let told: { update?: unknown; next?: string } | undefined
    for (let i = 0; i < 50 && !told; i++) {
      await Bun.sleep(20)
      const got = await call()
      if (got.update) told = got
    }
    expect(told?.update).toEqual({ running: version, installed: '9.9.9' })
    expect(told?.next).toMatch(/coworker 9\.9\.9 is installed .*\/reload-plugins/)
    // 한 번만 알린다.
    expect((await call()).update).toBeUndefined()
    await client.close()
    session.shutdown()
  } finally {
    delete process.env.COWORKER_UPDATE_FIRST_MS
  }
})
