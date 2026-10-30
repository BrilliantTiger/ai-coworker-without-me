import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HINT, startupHint } from '../src/hint'

const homes: string[] = []
const newHome = () => {
  const home = join(mkdtempSync(join(tmpdir(), 'coworker-hint-')), '.coworker')
  homes.push(home)
  return home
}
afterAll(() => homes.forEach(h => rmSync(join(h, '..'), { recursive: true, force: true })))

test('the first session started without the channel option shows how to start one, once', () => {
  const home = newHome()
  expect(startupHint(home, () => 'claude')).toBe(HINT)
  expect(existsSync(join(home, 'hint-shown'))).toBe(true)
  // 한 번 보였으면 실행 인자를 다시 읽지도 않는다.
  expect(startupHint(home, () => { throw new Error('read the command line again') })).toBeUndefined()
})

test('a session already started as a channel shows nothing and is not told again later', () => {
  const home = newHome()
  expect(startupHint(home, () => 'claude --dangerously-load-development-channels plugin:coworker@ai-coworker-without-me')).toBeUndefined()
  expect(startupHint(home, () => 'claude')).toBeUndefined()
})

test('the hint names the plugin channel and points to the install guide', () => {
  expect(HINT).toContain('claude --dangerously-load-development-channels plugin:coworker@ai-coworker-without-me')
  expect(HINT).toContain('claude-cw')
  expect(HINT).toContain('INSTALL.md')
})
