#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// 플러그인으로 설치하면 의존성 없이 복사될 수 있다(Codex 는 bun install 을 하지 않는다).
// 없으면 저장소의 bun.lock 그대로 먼저 깔고 MCP 서버를 띄운다.
// MCP 는 표준 출력으로 주고받으므로 설치 출력은 표준 출력에 내지 않는다.
// Codex 는 설치 뒤 첫 세션에서 플러그인 폴더를 새 폴더로 바꾼다. 까는 사이에 바뀌면 깐 것이 옛 폴더와 함께 사라지므로 다시 깐다.
const root = join(import.meta.dir, '..')
const installed = () => existsSync(join(root, 'node_modules', '@modelcontextprotocol', 'sdk'))
for (let tries = 0; !installed(); tries++) {
  const done = tries < 3 && Bun.spawnSync([process.execPath, 'install', '--frozen-lockfile', '--production'], { cwd: root, stdout: 'ignore', stderr: 'inherit' })
  if (!done || !done.success) {
    console.error(`coworker: could not install its packages in ${root}; run "bun install" there`)
    process.exit(1)
  }
}
await import('./mcp.ts')
