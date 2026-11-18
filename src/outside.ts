import { realpathSync } from 'node:fs'
import { homedir, hostname, networkInterfaces, platform, userInfo } from 'node:os'
import { basename } from 'node:path'
import type { RelayState } from './bridge'
import { shortHostname } from './net'

// 외부용 코드(outside: true)로 이어진 상대에게는 이 컴퓨터가 누구 것인지 드러나는 값이 나가지 않게 막는다.
// 컴퓨터 이름(여러 꼴), 계정 이름, 홈 폴더와 그 아래 경로, 작업·프로젝트 폴더 경로, 네트워크 인터페이스 주소와 사내·VPN 대역을 본다.

type Mark = { kind: string; test: (text: string) => boolean }

const PRIVATE_OR_VPN_IPV4 =
  /(?<![\d.])(?:10(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}|192\.168(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){2})(?![\d.])/

const COMMON_SHORT_WORDS = new Set(['user', 'root', 'test', 'main', 'code', 'node', 'work', 'home', 'info', 'admin', 'dev'])

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function scutilGet(key: string): string | undefined {
  if (platform() !== 'darwin') return undefined
  try {
    const out = Bun.spawnSync(['scutil', '--get', key])
    if (out.exitCode !== 0) return undefined
    return out.stdout.toString().trim() || undefined
  } catch {
    return undefined
  }
}

function pathVariants(dir: string | undefined): string[] {
  const raw = dir?.trim()
  if (!raw || raw.includes('${')) return []
  const candidates = new Set<string>([raw])
  try {
    candidates.add(realpathSync(raw))
  } catch {}
  const out: string[] = []
  for (const c of candidates) {
    const clean = c.replace(/[\\/]+$/, '')
    if (clean.length < 4 || clean === '/' || /^[A-Za-z]:$/.test(clean)) continue
    out.push(clean)
    if (clean.includes('\\')) out.push(clean.replace(/\\/g, '/'))
  }
  return [...new Set(out)]
}

let cachedHostMarks: Mark[] | undefined

function baseMarks(): Mark[] {
  if (cachedHostMarks) return cachedHostMarks
  const marks: Mark[] = []
  const seen = new Set<string>()
  const addSubstring = (kind: string, value: string | undefined) => {
    const v = value?.trim()
    if (!v || v.length < 2) return
    const lower = v.toLowerCase()
    const key = `${kind}:${lower}`
    if (seen.has(key)) return
    seen.add(key)
    marks.push({ kind, test: text => text.toLowerCase().includes(lower) })
  }

  // 컴퓨터 이름(hostname, 짧은 이름, .local, macOS LocalHostName·ComputerName·HostName, Windows COMPUTERNAME).
  const names = new Set<string>()
  const addName = (n: string | undefined) => {
    const v = n?.trim()
    if (!v || v.toLowerCase() === 'localhost') return
    names.add(v)
    if (v.includes('’')) names.add(v.replace(/’/g, "'"))
  }
  const host = hostname()
  const short = shortHostname()
  addName(host)
  addName(short)
  if (short && short.toLowerCase() !== 'localhost') names.add(`${short}.local`)
  for (const key of ['LocalHostName', 'ComputerName', 'HostName']) {
    const v = scutilGet(key)
    addName(v)
    if (v && key === 'LocalHostName') names.add(`${v}.local`)
  }
  if (platform() === 'linux' && host && host.toLowerCase() !== 'localhost') names.add(`${host}.local`)
  if (platform() === 'win32') addName(process.env.COMPUTERNAME)
  for (const n of names) {
    if (n.length <= 3) {
      const re = new RegExp(`(?<![A-Za-z0-9])${escapeRegex(n)}(?![A-Za-z0-9])`, 'i')
      marks.push({ kind: 'computer name', test: text => re.test(text) })
    } else {
      addSubstring('computer name', n)
    }
  }

  // 홈 폴더와 그 아래 경로.
  for (const p of pathVariants(homedir())) addSubstring('home folder path', p)

  // 계정 이름.
  const accounts = new Set<string>()
  try {
    if (userInfo().username) accounts.add(userInfo().username.trim())
  } catch {}
  for (const envUser of [process.env.USER, process.env.USERNAME, basename(homedir())]) {
    if (envUser?.trim()) accounts.add(envUser.trim())
  }
  for (const u of accounts) {
    if (!u || u.length < 2) continue
    const lower = u.toLowerCase()
    const pathRe = new RegExp(`(?:[/\\\\](?:Users|home)[/\\\\]|~)${escapeRegex(u)}(?=$|[/\\\\\\s"'\`:,;)])`, 'i')
    marks.push({ kind: 'account name', test: text => pathRe.test(text) })
    if (COMMON_SHORT_WORDS.has(lower)) continue
    if (u.length >= 5) {
      addSubstring('account name', u)
    } else {
      const tokenRe = new RegExp(`(?<![A-Za-z0-9])${escapeRegex(u)}(?![A-Za-z0-9])`, 'i')
      marks.push({ kind: 'account name', test: text => tokenRe.test(text) })
    }
  }

  // 이 기계의 네트워크 인터페이스 주소(루프백 제외)와 사내·VPN IPv4 주소.
  for (const list of Object.values(networkInterfaces())) {
    for (const nic of list ?? []) {
      if (nic.internal) continue
      const addr = nic.address.trim()
      if (!addr) continue
      const bare = addr.split('%')[0]!
      if (bare.includes(':')) {
        addSubstring('internal or VPN address', addr)
        addSubstring('internal or VPN address', bare)
      } else {
        const re = new RegExp(`(?<![\\d.])${escapeRegex(bare)}(?![\\d.])`)
        marks.push({ kind: 'internal or VPN address', test: text => re.test(text) })
      }
    }
  }
  marks.push({ kind: 'internal or VPN address', test: text => PRIVATE_OR_VPN_IPV4.test(text) })

  cachedHostMarks = marks
  return marks
}

function workingDirSafe(): string | undefined {
  try {
    return process.cwd()
  } catch {
    return undefined
  }
}

export function findComputerInfo(fields: Record<string, string | undefined>, extraDirs: (string | undefined)[] = []): { kind: string; field: string }[] {
  const dirs = new Set<string>()
  for (const d of [workingDirSafe(), process.env.PWD, process.env.COWORKER_PROJECT_DIR, ...extraDirs]) {
    for (const v of pathVariants(d)) dirs.add(v.toLowerCase())
  }
  const dirList = [...dirs]
  const marks: Mark[] = [
    ...baseMarks(),
    ...dirList.map(d => ({ kind: 'project folder path', test: (text: string) => text.toLowerCase().includes(d) })),
  ]
  const found: { kind: string; field: string }[] = []
  for (const [field, text] of Object.entries(fields)) {
    if (!text) continue
    // 모양만 다른 글자(전각 글자, 합쳐 쓴 글자)로 적어도 같은 것으로 본다.
    const plain = text.normalize('NFKC')
    for (const m of marks) {
      if (m.test(text) || (plain !== text && m.test(plain))) found.push({ kind: m.kind, field })
    }
  }
  return found
}

// 파일 내용이 UTF-8 글이면 그 글을, 아니면 undefined 를 돌려준다. 0 바이트가 있으면 글로 보지 않는다.
// UTF-16 이나 UTF-32 로 쓴 글은 영문자와 경로 구분자마다 0 바이트가 끼므로 여기서 걸린다. 그 밖의 인코딩은 UTF-8 로 읽히지 않아 걸린다.
export function utf8Text(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

export function assertNoComputerInfo(fields: Record<string, string | undefined>, extraDirs: (string | undefined)[] = []) {
  const found = findComputerInfo(fields, extraDirs)
  if (!found.length) return
  const what = [...new Set(found.map(f => `${f.kind} in ${f.field}`))].slice(0, 8).join(', ')
  throw new Error(
    `nothing was sent: this session is connected through an outside code, and the content holds information about this computer (${what}). Remove it, and write file references as paths relative to the project instead of full paths on this PC.`,
  )
}

export function relayPortOf(relayUrl: string): number {
  try {
    const u = new URL(relayUrl)
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : 443
  } catch {
    return 443
  }
}

export function outsideRelayError(relay: string | undefined, state: RelayState): string {
  if (!relay)
    return 'cannot open a bridge for outsiders without a relay: set a relay server URL first (in Claude Code: /plugin configure coworker@ai-coworker-without-me -> Relay server, or set COWORKER_RELAY=https://relay.example.com, and Relay key / COWORKER_RELAY_KEY if the relay uses a key), then restart this session'
  if (typeof state === 'object' && /relay key/i.test(state.error))
    return `cannot open a bridge for outsiders: ${state.error}. Set Relay key in /plugin configure coworker@ai-coworker-without-me or COWORKER_RELAY_KEY to the key from whoever runs the relay, then restart this session`
  const detail = typeof state === 'object' ? state.error : 'the relay did not answer in time'
  return `cannot open a bridge for outsiders: the relay ${relay} is not answering as a coworker relay (${detail}). Check that COWORKER_RELAY (or Relay server in /plugin configure coworker@ai-coworker-without-me) points to a running coworker relay (${relay}/healthz should answer "coworker relay") and set COWORKER_RELAY_KEY if it uses a key`
}
