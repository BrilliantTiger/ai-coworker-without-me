#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// 플러그인으로 설치하면 의존성 없이 복사될 수 있다(Codex 는 bun install 을 하지 않는다).
// 없으면 저장소의 bun.lock 그대로 먼저 깔고 MCP 서버를 띄운다.
// MCP 는 표준 출력으로 주고받으므로 설치 출력은 표준 출력에 내지 않는다.
// Codex 는 설치 뒤 첫 세션에서 플러그인 폴더를 새 폴더로 바꾼다. 까는 사이에 바뀌면 깐 것이 옛 폴더와 함께 사라지므로 다시 깐다.
const root = join(import.meta.dir, '..')
const installed = () => existsSync(join(root, 'node_modules', '@modelcontextprotocol', 'sdk'))
// 오래된 Bun 은 새 Bun 이 만든 bun.lock 을 읽지 못해 --frozen-lockfile 이 실패한다
// (2026-10-29, Windows PC의 Bun 1.3.7: 「Unknown lockfile version」). 그때는 package.json 의 범위대로 깐다.
// --production 은 lock 파일을 고정한 것처럼 다뤄 같이 실패하므로, 개발용 패키지는 --omit=dev 로 뺀다.
const install = (frozen: boolean) =>
  Bun.spawnSync([process.execPath, 'install', ...(frozen ? ['--frozen-lockfile', '--production'] : ['--omit=dev'])], {
    cwd: root,
    stdout: 'ignore',
    stderr: frozen ? 'ignore' : 'inherit',
  }).success
for (let tries = 0; !installed(); tries++) {
  if (tries === 3 || !(install(true) || install(false))) {
    console.error(`coworker: could not install its packages in ${root}; run "bun install" there`)
    process.exit(1)
  }
}
await import('./mcp.ts')
