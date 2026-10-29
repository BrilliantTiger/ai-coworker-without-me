#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// 플러그인으로 설치하면 의존성 없이 복사될 수 있다(Codex 는 bun install 을 하지 않는다).
// 없으면 저장소의 bun.lock 그대로 먼저 깔고 MCP 서버를 띄운다.
// MCP 는 표준 출력으로 주고받으므로 설치 출력은 표준 출력에 내지 않는다.
const root = join(import.meta.dir, '..')
if (!existsSync(join(root, 'node_modules', '@modelcontextprotocol', 'sdk'))) {
  const done = Bun.spawnSync([process.execPath, 'install', '--frozen-lockfile', '--production'], { cwd: root, stdout: 'ignore', stderr: 'inherit' })
  if (!done.success) {
    console.error(`coworker: could not install its packages in ${root}; run "bun install" there`)
    process.exit(1)
  }
}
await import('./mcp.ts')
