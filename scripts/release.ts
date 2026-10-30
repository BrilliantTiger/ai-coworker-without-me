#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// 릴리스: bun run release 0.2.0 [--notes-file 노트.md]
// 세 매니페스트의 판 번호를 맞추고, 시험을 돌리고, 커밋과 태그(v0.2.0)를 만들어 올린 뒤
// release 브랜치를 그 커밋으로 옮기고 GitHub 릴리스를 만든다.
// 플러그인을 깐 사람과 디렉터리는 release 브랜치를 따라간다. main 에 올린 것은 릴리스해야 나간다.
// Claude Code 는 plugin.json 의 version 이 바뀌어야 업데이트로 본다. 그래서 릴리스마다 판을 올린다.

const root = join(import.meta.dir, '..')
const MANIFESTS = ['package.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json']
const SEMVER = /^\d+\.\d+\.\d+$/

function run(cmd: string[], quiet = false): string {
  const p = Bun.spawnSync(cmd, { cwd: root, stdout: 'pipe', stderr: quiet ? 'pipe' : 'inherit' })
  if (!p.success) throw new Error(`${cmd.join(' ')} failed${quiet ? `: ${p.stderr.toString().trim()}` : ''}`)
  return p.stdout.toString().trim()
}

const versionOf = (file: string) => (JSON.parse(readFileSync(join(root, file), 'utf8')) as { version?: string }).version

// 판 번호만 바꾸고 나머지 줄 모양은 그대로 둔다.
function setVersion(file: string, version: string) {
  const path = join(root, file)
  const text = readFileSync(path, 'utf8')
  const next = text.replace(/("version":\s*")[^"]*(")/, `$1${version}$2`)
  if (next === text && versionOf(file) !== version) throw new Error(`${file} has no "version" field`)
  writeFileSync(path, next)
}

const newer = (a: string, b: string) => {
  const [x, y] = [a, b].map(v => v.split('.').map(Number))
  for (let i = 0; i < 3; i++) if (x![i] !== y![i]) return x![i]! > y![i]!
  return false
}

const version = process.argv[2] ?? ''
const notesAt = process.argv.indexOf('--notes-file')
const notesFile = notesAt > 0 ? process.argv[notesAt + 1] : undefined
if (!SEMVER.test(version)) throw new Error('usage: bun run release <major.minor.patch>, like 0.2.0')
const tag = `v${version}`

if (run(['git', 'branch', '--show-current']) !== 'main') throw new Error('release from main')
if (run(['git', 'status', '--porcelain'])) throw new Error('commit or stash your changes first')
run(['git', 'fetch', '-q', 'origin', '--tags'])
if (run(['git', 'rev-parse', 'HEAD']) !== run(['git', 'rev-parse', 'origin/main'])) throw new Error('main is not the same as origin/main; pull or push first')
if (run(['git', 'tag', '-l', tag])) throw new Error(`${tag} already exists`)

const current = MANIFESTS.map(versionOf)
const latestTag = run(['git', 'tag', '-l', 'v*', '--sort=-v:refname']).split('\n')[0] || undefined
const released = latestTag?.slice(1)
// 아직 릴리스한 적이 없으면 지금 매니페스트의 판 그대로 첫 릴리스를 할 수 있다.
if (released ? !newer(version, released) : current.some(v => v && newer(v, version)))
  throw new Error(`${version} must be newer than ${released ?? current.join(', ')}`)

for (const file of MANIFESTS) setVersion(file, version)
run(['bun', 'test'])
run(['bun', 'run', 'typecheck'])
run(['claude', 'plugin', 'validate', '.'])

const changed = run(['git', 'status', '--porcelain'])
if (changed) {
  run(['git', 'add', ...MANIFESTS])
  run(['git', 'commit', '-q', '-m', `Release ${tag}`])
}
// 노트 파일이 없으면 지난 릴리스 뒤의 커밋 제목을 적는다.
const notes = notesFile
  ? readFileSync(notesFile, 'utf8').trim()
  : run(['git', 'log', '--format=- %s', ...(latestTag ? [`${latestTag}..HEAD`] : ['-n', '20'])])
run(['git', 'tag', '-a', tag, '-m', `Release ${tag}`])
run(['git', 'push', '-q', 'origin', 'main', tag])
run(['git', 'push', '-q', 'origin', 'HEAD:refs/heads/release'])
run(['gh', 'release', 'create', tag, '--title', tag, '--notes', notes || `Release ${tag}`])
console.log(`released ${tag}: main, the release branch and the GitHub release now point at ${run(['git', 'rev-parse', '--short', 'HEAD'])}`)
