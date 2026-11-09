import { afterAll, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 설치되는 것은 plugin/ 폴더뿐이다. 사용자 PC에서 아무것도 깔지 않고 그 폴더만으로 서버가 떠야 한다.
const root = join(import.meta.dir, '..')
const pluginDir = join(root, 'plugin')
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const temps: string[] = []
afterAll(() => temps.forEach(t => rmSync(t, { recursive: true, force: true })))

test('the plugin folder holds the bundled server and no package install', () => {
  const files = readdirSync(pluginDir)
  expect(files).toContain('coworker.js')
  for (const f of ['package.json', 'bun.lock', 'bun.lockb', 'package-lock.json', 'node_modules', 'src']) expect(files).not.toContain(f)
})

test('Claude Code and Codex start the bundle with bun --no-install, and nothing runs as a hook', () => {
  const claude = json(join(pluginDir, '.claude-plugin', 'plugin.json'))
  expect(claude.mcpServers.coworker.command).toBe('bun')
  expect(claude.mcpServers.coworker.args).toEqual(['--no-install', '${CLAUDE_PLUGIN_ROOT}/coworker.js'])
  expect(claude.hooks).toBeUndefined()
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
      env: { ...process.env, COWORKER_HOME: home, COWORKER_CHANNEL: 'off', CLAUDECODE: '' } as Record<string, string>,
      stderr: 'inherit',
    }),
  )
  try {
    expect(client.getServerVersion()).toMatchObject({ name: 'coworker', version: json(join(root, 'package.json')).version })
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name).sort()).toEqual(
      ['check_with_human', 'close_bridge', 'connect', 'inbox', 'list_connections', 'open_bridge', 'read_conversation', 'reply', 'send_question', 'wait_for_message', 'write_agreement'].sort(),
    )
    const res = (await client.callTool({ name: 'open_bridge', arguments: {} })) as { content: { text: string }[] }
    expect(JSON.parse(res.content[0]!.text).code).toStartWith('cw1.')
    await client.callTool({ name: 'close_bridge', arguments: {} })
  } finally {
    await client.close()
  }
})
