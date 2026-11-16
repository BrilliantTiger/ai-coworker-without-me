#!/usr/bin/env bun
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 채팅창 위 띠(plugin/hooks/band.tsx)를 Claude Code 로 검사하고 시험한다. Claude Code 가 깔려 있어야 한다.
//   bun scripts/mod-test.ts
// 시험(test/mod/band.modtest.tsx)은 플러그인 폴더에 싣지 않는다. 그래서 플러그인 폴더의 사본에 넣어서 돌린다.
// mod API 는 Claude Code 판마다 바뀔 수 있어서 `bun test` 와 릴리스에는 넣지 않았다. 띠를 고칠 때 손으로 돌린다.
const root = join(import.meta.dir, '..')
const copy = join(mkdtempSync(join(tmpdir(), 'coworker-mod-')), 'coworker')
const run = (args: string[]) => Bun.spawnSync(['claude', 'plugin', ...args], { stdout: 'inherit', stderr: 'inherit' }).exitCode
let code = 1
try {
  cpSync(join(root, 'plugin'), copy, { recursive: true })
  mkdirSync(join(copy, 'tests'))
  cpSync(join(root, 'test', 'mod', 'band.modtest.tsx'), join(copy, 'tests', 'band.test.tsx'))
  code = run(['validate', join(root, 'plugin')]) || run(['test', copy])
} finally {
  rmSync(join(copy, '..'), { recursive: true, force: true })
}
process.exit(code)
