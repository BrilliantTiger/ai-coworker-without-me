import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HINT, firstTimeHint } from '../src/hint'

const homes: string[] = []
const newHome = () => {
  const home = join(mkdtempSync(join(tmpdir(), 'coworker-hint-')), '.coworker')
  homes.push(home)
  return home
}
afterAll(() => homes.forEach(h => rmSync(join(h, '..'), { recursive: true, force: true })))

test('the hint on how to start Claude Code as a channel is given once', () => {
  const home = newHome()
  expect(firstTimeHint(home)).toBe(HINT)
  expect(existsSync(join(home, 'hint-shown'))).toBe(true)
  expect(firstTimeHint(home)).toBeUndefined()
})

test('the hint names the plugin channel and points to the install guide', () => {
  expect(HINT).toContain('claude --dangerously-load-development-channels plugin:coworker@ai-coworker-without-me')
  expect(HINT).toContain('claude-cw')
  expect(HINT).toContain('INSTALL.md')
})
