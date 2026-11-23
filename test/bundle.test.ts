import { afterAll, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APP_PORT } from '../src/serve'

// 설치되는 것은 plugin/ 폴더뿐이다. 사용자 PC에서 아무것도 깔지 않고 그 폴더만으로 서버가 떠야 한다.
const root = join(import.meta.dir, '..')
const pluginDir = join(root, 'plugin')
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const temps: string[] = []
// Windows 는 어떤 프로세스의 작업 폴더인 폴더를 지우지 못한다. 막 끝나는 중인 프로세스(서버, 지킴이)가 놓을 때까지 몇 번 다시 해 본다.
afterAll(async () => {
  for (const t of temps) {
    for (let i = 0; ; i++) {
      try {
        rmSync(t, { recursive: true, force: true })
        break
      } catch (e) {
        if (i >= 40) throw e
        await Bun.sleep(250)
      }
    }
  }
})

test('the plugin folder holds the bundled server and no package install', () => {
  const files = readdirSync(pluginDir)
  expect(files).toContain('coworker.js')
  for (const f of ['package.json', 'bun.lock', 'bun.lockb', 'package-lock.json', 'node_modules', 'src']) expect(files).not.toContain(f)
})

test('Claude Code and Codex start the bundle with bun --no-install; the only command hook wakes the AI after a restart', () => {
  const claude = json(join(pluginDir, '.claude-plugin', 'plugin.json'))
  expect(claude.mcpServers.coworker.command).toBe('bun')
  expect(claude.mcpServers.coworker.args).toEqual(['--no-install', '${CLAUDE_PLUGIN_ROOT}/coworker.js'])
  // hooks 는 둘이다. 하나는 명령 훅이고, 하나는 채팅창 위 띠를 그리는 모듈의 파일이다(아래 시험).
  // 명령 훅은 세션을 다시 켰을 때만, 백그라운드로 돌며(asyncRewake) 그사이 온 소식으로 AI를 깨운다. 다른 명령 훅은 없다(디렉터리판에는 훅이 아예 없다).
  // async 도 함께 켠다. asyncRewake 만 있으면 한 번 답하고 끝나는 세션(claude -p --resume)에서는 Claude Code 가 이 훅을 백그라운드로 돌리지 않고
  // 끝나기를 기다린다(2.1.327 에서 확인). 훅은 소식이 올 때까지 기다리므로, 새 소식이 없으면 그 세션이 시작도 못 하고 멈춰 있었다.
  const [hooks, band] = claude.hooks
  expect(claude.hooks).toHaveLength(2)
  expect(band).toBe('./claude/hooks.json')
  expect(Object.keys(hooks)).toEqual(['SessionStart'])
  expect(hooks.SessionStart).toEqual([
    {
      matcher: 'resume',
      hooks: [expect.objectContaining({ type: 'command', command: 'bun --no-install "${CLAUDE_PLUGIN_ROOT}/coworker.js" wake', async: true, asyncRewake: true })],
    },
  ])
  // 훅의 시간 제한을 밀리초로 바꿔도 타이머가 받는 값 안에 든다.
  expect(hooks.SessionStart[0].hooks[0].timeout * 1000).toBeLessThanOrEqual(2 ** 31 - 1)
  expect(claude.mcpServers.coworker.env.BUN_OPTIONS).toBeUndefined()
  const codex = json(join(pluginDir, '.codex-plugin', 'plugin.json'))
  expect(codex.mcpServers.coworker.args).toEqual(['--no-install', './coworker.js'])
  // 세 매니페스트의 판 번호가 같아야 업데이트가 맞게 잡힌다.
  const version = json(join(root, 'package.json')).version
  expect(claude.version).toBe(version)
  expect(codex.version).toBe(version)
  expect(json(join(root, '.claude-plugin', 'marketplace.json')).plugins[0].source).toBe('./plugin')
  expect(json(join(root, '.agents', 'plugins', 'marketplace.json')).plugins[0].source.path).toBe('./plugin')
})

test('the band above the prompt is a Claude Code hooks module that Codex never reads and that only talks to this PC', () => {
  // 옛 Claude Code 는 hooks 가 없는 hooks.json 을 받지 않는다. 그래서 빈 hooks 를 함께 둔다.
  expect(json(join(pluginDir, 'claude', 'hooks.json'))).toMatchObject({ hooks: {}, modules: ['./band.tsx'] })
  // Codex 도 플러그인의 hooks/hooks.json 을 읽는다. 그 자리에는 아무것도 두지 않는다.
  expect(existsSync(join(pluginDir, 'hooks'))).toBe(false)
  // plugin.json 에 새 항목을 넣지 않는다. 그 항목을 모르는 옛 Claude Code 가 플러그인을 통째로 거절할 수 있다.
  expect(json(join(pluginDir, '.claude-plugin', 'plugin.json')).types).toBeUndefined()
  const source = readFileSync(join(pluginDir, 'claude', 'band.tsx'), 'utf8')
  // 플러그인 밖의 코드를 가져오지 않는다. claude-code 는 타입뿐이다.
  expect([...source.matchAll(/^import (type )?.* from '([^']+)'$/gm)].map(m => [m[1], m[2]])).toEqual([['type ', 'claude-code']])
  // 읽는 곳은 이 PC 안의 대화 보기 서버뿐이다.
  expect([...source.matchAll(/https?:\/\/[\w.-]+/g)].map(m => m[0]).every(u => u === 'http://127.0.0.1' || u === 'http://localhost')).toBe(true)
  expect(source).toContain('$.http.fetch(`${api}/status`)')
})

test('the bundled server starts from a copy of the plugin folder with no packages around it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coworker-plugin-'))
  const home = mkdtempSync(join(tmpdir(), 'coworker-plugin-home-'))
  temps.push(dir, home)
  cpSync(pluginDir, dir, { recursive: true })
  expect(existsSync(join(dir, 'node_modules'))).toBe(false)
  const client = new Client({ name: 'claude-code', version: '1.0.0' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['--no-install', join(dir, 'coworker.js')],
      cwd: dir,
      env: { ...process.env, COWORKER_HOME: home, COWORKER_CHANNEL: 'off', CLAUDECODE: '', COWORKER_AUTO_UPDATE: 'off', COWORKER_NOTIFY: 'off' } as Record<string, string>,
      stderr: 'inherit',
    }),
  )
  try {
    expect(client.getServerVersion()).toMatchObject({ name: 'coworker', version: json(join(root, 'package.json')).version })
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name).sort()).toEqual(
      ['check_with_human', 'close_bridge', 'connect', 'inbox', 'list_connections', 'open_bridge', 'read_conversation', 'reply', 'send_question', 'wait_for_message', 'write_agreement', 'connection_log'].sort(),
    )
    const res = (await client.callTool({ name: 'open_bridge', arguments: {} })) as { content: { text: string }[] }
    const opened = JSON.parse(res.content[0]!.text)
    expect(opened.code).toStartWith('cw1.')
    // 묶은 뒤에도 대화 보기 화면의 글은 한글 그대로 내려간다. 묶는 도구가 한글을 \uXXXX 로 바꿔 적어도 화면에는 그 글자가 찍히지 않는다.
    const page = await (await fetch(opened.viewer)).text()
    expect(page).toContain('<h1>Coworker <span>대화</span></h1>')
    expect(page).toContain('접근키 발급')
    expect(page).not.toMatch(/\\u[0-9a-fA-F]{4}/)
    await client.callTool({ name: 'close_bridge', arguments: {} })
  } finally {
    await client.close()
  }
})

test('the same bundle runs as the coworker app, and the directory plugin holds no code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coworker-app-bundle-'))
  temps.push(dir)
  cpSync(join(pluginDir, 'coworker.js'), join(dir, 'coworker.js'))
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
  const port = probe.port!
  probe.stop(true)
  const app = Bun.spawn([process.execPath, '--no-install', join(dir, 'coworker.js'), 'serve'], {
    cwd: dir,
    env: { ...process.env, COWORKER_HOME: join(dir, 'home'), COWORKER_APP_PORT: String(port) },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  try {
    let health = ''
    for (let i = 0; i < 50 && !health; i++) {
      health = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.text()).catch(() => '')
      if (!health) await Bun.sleep(100)
    }
    expect(health).toBe(`coworker app ${json(join(root, 'package.json')).version}\n`)
  } finally {
    app.kill()
  }
  // 디렉터리판: 고정된 앱 주소만 두고, 코드도 훅도 없다. 디렉터리가 어디로 붙는지 끝까지 읽을 수 있게 변수를 쓰지 않는다.
  const directory = join(root, 'directory')
  const manifest = json(join(directory, '.claude-plugin', 'plugin.json'))
  expect(manifest.mcpServers.coworker).toEqual({ type: 'http', url: `http://127.0.0.1:${APP_PORT}/mcp` })
  expect(JSON.stringify(manifest)).not.toContain('${')
  expect(manifest.userConfig).toBeUndefined()
  expect(manifest.hooks).toBeUndefined()
  expect(manifest.version).toBe(json(join(root, 'package.json')).version)
  const allowed = /\.(md|json|png|txt)$|^LICENSE$/
  // .DS_Store 는 Finder 가 폴더를 열면 만드는 파일이다. .gitignore 에 있어 올라가지 않는다.
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(d, e.name)) : e.name === '.DS_Store' ? [] : [e.name]))
  for (const f of walk(directory)) expect(f).toMatch(allowed)
}, 15_000)
