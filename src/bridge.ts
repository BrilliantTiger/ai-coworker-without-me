import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Server } from 'bun'
import { agreementFileName, isAgreement, renderAgreement, type Agreement } from './agreement'
import { decodeCode, encodeCode } from './code'
import { fromB64, newKeyPair, open, randomToken, ReplayGuard, seal, toB64, type KeyPair, type Sealed } from './crypto'
import { hostForUrl, localAddresses } from './net'
import { boxOf } from './box'
import { assertNoSecrets, findSecrets, type Found } from './secrets'
import { LinkLog, MAX_LOG_LINES, type LogEntry } from './linklog'

// 사내 방화벽에 열어 달라고 요청하기 쉽게 정해 둔 범위.
export const DEFAULT_PORTS: [number, number] = [7700, 7799]

// 「9000-9010」이나 「9000」. 회사가 다른 범위만 열어 줄 때 기본 범위를 바꾼다.
export function parsePorts(text: string | undefined): [number, number] {
  if (!text?.trim()) return DEFAULT_PORTS
  const m = text.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/)
  const min = Number(m?.[1])
  const max = Number(m?.[2] ?? m?.[1])
  if (!m || min < 1024 || max > 65535 || min > max)
    throw new Error(`COWORKER_PORTS must look like "9000-9010" or "9000", between 1024 and 65535 (got "${text}")`)
  return [min, max]
}

// 주소마다 다른 프로그램이 같은 포트로 떠 있을 수 있다. 받는 쪽 키로 만든 경로로 보내서,
// 엉뚱한 곳(예: 같은 포트를 쓰는 이 PC의 다른 브릿지)이 답하면 「여기 아님」으로 알 수 있게 한다.
export const routeId = (key: string) => Buffer.from(key, 'base64').toString('base64url').slice(0, 16)
// 연결된 세션마다 붙는 짧은 ID. 이름이 같은 세션이 여럿일 때 하나를 집어 부를 수 있다.
export const peerId = (key: string) => routeId(key).slice(0, 6)
const labelOf = (p: { key: string; name: string }) => `${p.name} [${peerId(p.key)}]`
const CLOCK_FIX =
  "Messages are kept and sent once the clocks agree. Turn on automatic date and time on this PC and ask the coworker to do the same (macOS: System Settings > General > Date & Time; Windows: Settings > Time & language > Date & time > Set time automatically)."
const isLoopback = (addr: string) => addr.startsWith('127.') || addr === '::1' || addr === 'localhost'
// 주소 목록에서 http(s):// 로 시작하는 것은 중계 서버의 우편함이다. 나머지는 IP나 컴퓨터 이름이다.
export const isRelayAddr = (addr: string) => /^https?:\/\//.test(addr)

// 상대에게 닿지 못한 까닭. no_route: 그 주소로 가는 길이 없다(꺼짐, 잠자기, 다른 네트워크로 옮김).
// refused: 그 PC는 있지만 그 포트에서 브릿지가 받지 않는다. cut: 이어져 있다가 도중에 끊겼다. timeout: 정한 시간 안에 답이 없다.
// not_recognized: 브릿지는 답했지만 이 세션을 모른다고 한다. bad_answer: 알아볼 수 없는 답이 왔다.
// clock: 브릿지는 답했지만 두 PC의 시계가 너무 달라 서로의 봉투를 받지 않는다.
export type LinkError = 'no_route' | 'refused' | 'cut' | 'timeout' | 'not_recognized' | 'bad_answer' | 'clock'
const LINK_ERRORS: Record<LinkError, string> = {
  no_route: 'no route to it: it is asleep, turned off, or on another network',
  refused: 'its computer answered, but no bridge is listening on that port: coworker there is restarting or stopped',
  cut: 'the connection was cut while it was open: coworker there stopped, or the network dropped',
  timeout: 'no answer in time',
  not_recognized: 'its bridge answered but does not know this session; this side keeps offering the code it joined with',
  bad_answer: 'an answer came back that could not be read',
  clock: 'its bridge answered, but the clocks of the two PCs differ by more than two hours, so neither side takes the other\'s messages. Turn on automatic date and time on both PCs',
}

// directFailed: 이쪽에서 상대로 바로 보내지 못했다. lastPollAt: 상대가 메시지를 가져가려고 마지막으로 접속한 때.
// private: 개인용 코드로 이어진 상대. 그룹의 다른 세션에 소개하지 않고, 이 상대가 소개하는 세션도 받지 않는다.
// lastSeen: 상대에게서 마지막으로 무엇이든 받은 때. lastError: 마지막으로 닿지 못한 까닭. retryAt: 다음에 다시 붙어 볼 때.
// token: 상대가 이쪽을 잊었을 때 들고 다시 들어갈 토큰. 상대의 연결 코드에 있던 것이거나, 상대가 인사하며 건넨 것이다.
// given: 이쪽이 상대에게 건넨 토큰. 이쪽이 상대를 잊어도 상대가 이것을 들고 다시 들어온다. 그래서 어느 쪽에서든 다시 붙는다.
// 세션이 어느 AI 도구이고(app), 무슨 모델을(model), 어떤 강도로(effort) 쓰는지. 서로 인사할 때 알린다(2026-11-17, 사람이 정함:
// 「AI이 어디꺼고, 모델이 뭔지 그리고 effort 가 뭔지 서로 알면 좋고」). 모르는 것은 비운다.
export type About = { app?: string; model?: string; effort?: string }
const MAX_ABOUT = 60
// 상대가 보낸 것도, 이쪽 AI가 적은 것도 같은 규칙으로 다듬는다: 글자만, 한 줄, 60자까지.
export function cleanAbout(value: unknown): About | undefined {
  if (!value || typeof value !== 'object') return undefined
  const out: About = {}
  for (const key of ['app', 'model', 'effort'] as const) {
    const v = (value as Record<string, unknown>)[key]
    if (typeof v !== 'string') continue
    const text = v.replace(/\s+/g, ' ').trim().slice(0, MAX_ABOUT)
    if (text) out[key] = text
  }
  return Object.keys(out).length ? out : undefined
}

export type Peer = {
  key: string
  name: string
  about?: About
  // 그 세션의 판이 할 수 있는 것(예: files). 인사에 적어 온 것만 있다. 옛 판은 적지 않는다.
  can?: string[]
  addrs: string[]
  port: number
  lastAddr?: string
  directFailed?: boolean
  lastPollAt?: number
  private?: boolean
  lastSeen?: number
  lastError?: { kind: LinkError; at: number; detail?: string; addr?: string }
  retryAt?: number
  token?: string
  given?: string
}

// 상대 쪽 사람이 브릿지를 닫아 끝난 연결. 연결을 끝내는 것은 사람뿐이라서, 끝난 것은 이것만 남는다.
export type Ended = { name: string; id: string; at: string }

// 그룹의 다른 세션에 소개할 때 넘기는 것.
type Member = { key: string; name: string; addrs: string[]; port: number }

// 소개받은 세션. 양쪽이 서로를 기다리다가 먼저 닿는 쪽이 인사한다.
// 사람이 닫거나 세션이 끝날 때까지 기다린다. 시간으로 포기하지 않는다.
type Invite = Member & { by: string; nextTry: number; backoff: number; trying?: boolean }

// checking_with_your_human: 결정이 필요해 이쪽 사람에게 묻는 중. peer_checking_with_their_human: 상대가 자기 사람에게 묻는 중.
// closed: 여럿에게 한 명만 답하면 되는 질문을 했고, 다른 사람이 먼저 답했다. agreed: 어느 한쪽이 합의문을 썼다.
export type ThreadStatus =
  | 'waiting_for_peer'
  | 'your_turn'
  | 'checking_with_your_human'
  | 'peer_checking_with_their_human'
  | 'closed'
  | 'agreed'

// note 는 「사람에게 확인 중」 같은 알림, closed 는 「다른 사람이 먼저 답했다」는 알림, agreement 는 합의문이다.
// 셋 다 왕복 횟수에 세지 않는다.
export type MessageKind = 'question' | 'answer' | 'note' | 'closed' | 'agreement'
const KINDS: MessageKind[] = ['question', 'answer', 'note', 'closed', 'agreement']

// 한 질문을 여러 세션에 보냈을 때. 받는 사람마다 대화가 따로 생기고, 같은 ask id 로 묶인다.
// answers: all 이면 모두 답하고, one 이면 먼저 온 답 하나로 끝낸다.
export type AnswerMode = 'all' | 'one'
export type AskInfo = { id: string; to: string[]; answers: AnswerMode }
export const EVERYONE = ['everyone', 'all']

// 파일 주고받기(2026-11-17, 사람이 정함: 「coworker 로 파일을 주고받을 수 있게」, 「중계서버도 가능하게」).
// 파일은 조각으로 나눠 글과 같은 길(바로, 중계 서버, 상대가 가져가기)로 보낸다. 조각 하나가 중계 서버와 브릿지의 요청 한도(1 MiB)에 들어간다.
// 조각을 먼저 보내고 글을 뒤에 보낸다. 받은 쪽은 글이 닿을 때 크기와 sha256 을 견주고, 맞으면 받은 자리에 저장한다.
export const FILE_CHUNK = 256 * 1024
export const MAX_FILE_BYTES = 10 * 1024 * 1024
export const MAX_FILES = 10
export const MAX_FILES_BYTES = 30 * 1024 * 1024
// 상대가 가져갈 때 한 번에 넘기는 양. 중계 서버의 답 한도(1 MiB) 안에 들어가게 한다.
const BATCH_BYTES = 600 * 1024
// 이 판이 할 수 있는 것. 인사에 적어 보낸다. 상대가 파일을 받을 줄 아는지 이것으로 안다.
const CAN = ['files']
const cleanCan = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length <= 20).slice(0, 20) : undefined)
// 파일이 온전히 오지 못한 까닭.
export type FileProblem = 'incomplete' | 'size' | 'sha256' | 'limit' | 'no_folder'
export const FILE_PROBLEM: Record<FileProblem, string> = {
  incomplete: 'the file did not arrive completely',
  size: 'the size differs from what the sender said',
  sha256: 'the sha256 differs from what the sender said',
  limit: 'the files of this message are over the size limit',
  no_folder: 'this session has no folder to save files in',
}
// 글에 붙은 파일의 기록. 누가 언제 보냈는지는 그 글(from, at)에 있다.
export type FileNote = {
  id: string
  name: string
  size: number
  sha256: string
  // 보낸 쪽에서는 보낸 파일의 원래 자리, 받은 쪽에서는 저장한 자리.
  path?: string
  // 받은 쪽: 크기와 sha256 이 보낸 쪽이 적은 것과 같았다. 보낸 쪽: 상대가 그렇게 확인했다고 알려 왔다. 아직 모르면 없다.
  ok?: boolean
  problem?: FileProblem
}
type WireFile = { id: string; name: string; size: number; sha256: string }
const FILE_ID = /^[A-Za-z0-9-]{8,64}$/
const SHA256 = /^[0-9a-f]{64}$/
// 대화 번호는 randomUUID 앞 여덟 글자(소문자 16진수)다.
export const THREAD_ID = /^[0-9a-f]{8}$/
export const isThreadId = (value: unknown): value is string => typeof value === 'string' && value.length === 8 && THREAD_ID.test(value)
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
// 지정한 폴더 바로 아래 이름 하나만 받아 그 안의 경로를 만든다.
export function pathInside(folder: string, name: string): string | undefined {
  if (!folder || !name || name === '.' || name === '..') return undefined
  if (name.includes('/') || name.includes('\\') || name.includes('\x00') || name.includes(':')) return undefined
  if (basename(name) !== name) return undefined
  const base = resolve(folder)
  const full = resolve(base, name)
  const rel = relative(base, full)
  if (!rel || rel !== name || rel.startsWith('..') || isAbsolute(rel) || dirname(full) !== base) return undefined
  return full
}
// 열쇠나 비밀번호를 담는 파일의 이름. 이런 파일은 보내지 않는다.
const SECRET_FILE = /^(?:\.env(?:\..*)?|\.netrc|\.npmrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\.json)?|.*\.(?:pem|key|p12|pfx|jks|keystore|kdbx))$/i
// 받은 파일의 이름에서 폴더와 제어 글자를 뺀다. 숨김 파일이 되지 않게 앞의 점도 뺀다. 상대가 적어 보낸 이름은 믿지 않는다.
export function safeFileName(name: unknown): string {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? ''
  const clean = base
    .replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 150)
  if (!clean) return 'file'
  return WINDOWS_RESERVED.test(clean) ? `_${clean}`.slice(0, 150) : clean
}
// 같은 이름이 이미 있으면 덮어쓰지 않고 이름 뒤에 번호를 붙인다.
function freePath(folder: string, name: string): string | undefined {
  const clean = safeFileName(name)
  const ext = extname(clean), stem = clean.slice(0, clean.length - ext.length)
  let path = pathInside(folder, clean)
  for (let n = 2; path && existsSync(path); n++) path = pathInside(folder, `${stem} (${n})${ext}`)
  return path
}

export type ThreadMessage = {
  id: string
  from: 'me' | 'peer'
  kind: MessageKind
  text: string
  context?: string
  agreement?: Agreement
  // 사람이 질문 창에서 고르거나 직접 써서 정한 답.
  human?: boolean
  // 답이 필요 없는 알림으로 보낸 질문(2026-11-16). 받은 쪽은 답하지 않아도 되고, 답해도 된다.
  noAnswer?: boolean
  // 글에 붙여 보내거나 받은 파일.
  files?: FileNote[]
  at: string
}

// peerAddr: 대화가 시작될 때 상대에게 닿던 주소. 사람이 「어디와」 주고받았는지 볼 수 있게 남긴다.
export type Thread = {
  id: string
  peer: string
  peerName: string
  peerAddr?: string
  subject: string
  startedBy: 'me' | 'peer'
  status: ThreadStatus
  ask?: AskInfo
  // 질문을 보낸 쪽 AI가 붙인 분류(예: 배포, 보안). 사람이 화면에서 골라 본다(2026-11-17).
  category?: string
  // 사람이 화면에서 「맨 위에 고정」한 대화(2026-11-17). 이 PC에서만 쓰고 상대에게는 보내지 않는다.
  pinned?: boolean
  messages: ThreadMessage[]
  // 상대가 자기 사람에게 묻기 시작한 때. 「사람에게 확인 중」 알림을 받았거나, 답에 「사람에게 올렸다」고만 썼을 때다.
  humanSince?: string
  // 그 사실을 상대가 알림 없이 답 글로만 알렸다(0.7 이하 판). 질문 창이 열렸는지는 알 수 없다.
  saidInText?: boolean
  // 오래 기다린다고 이쪽에 알린 횟수. nudgeMs 마다 하나씩 는다.
  nudges?: number
  // 상대가 알려 준 질문 창 상태(0.8 이상 판). 연결 상태를 볼 때와 기다리는 동안 1분마다 새로 받는다.
  peerWait?: WaitState
}

// 이쪽 사람에게 띄운 질문 창의 상태. 묻는 쪽이 「상대가 사람에게 묻는 중」을 자세히 볼 수 있게 건넨다.
// shown: 사람 화면에 창이 떠 있다. closed_without_answer: 사람이 창을 봤지만 답하지 않고 닫았다(다음 알림 때 다시 뜬다).
// text: 이 앱은 창을 띄울 수 없어서 대화 글로 물었다.
export type WaitState = {
  thread: string
  since: string
  window: 'shown' | 'closed_without_answer' | 'text'
  reminders: number
  last_reminder?: string
  closed_at?: string
}

// 여럿에게 보낸 질문에 답이 오면, 몇 명이 답했고 몇 명이 남았는지 함께 알린다.
export type AskProgress = { id: string; answers: AnswerMode; asked: string[]; answered: string[]; closedBy?: string }

export type BridgeEvent =
  // again: 이미 이어져 있던 상대가 다시 켜져 돌아왔다.
  // about: 그 세션이 어느 AI 도구이고 무슨 모델을 어떤 강도로 쓰는지. 상대가 알려 준 만큼만 있다.
  | { type: 'connected'; peer: string; via?: string; again?: boolean; about?: About; at: string }
  | {
      type: 'message'
      thread: string
      from: string
      kind: MessageKind
      text: string
      context?: string
      status: ThreadStatus
      ask?: AskInfo | AskProgress
      agreement?: Agreement
      file?: string
      // 상대 쪽 사람이 정한 답이다.
      human?: boolean
      // 답이 필요 없는 알림이다. 답하지 않아도 되고, 덧붙일 것이 있으면 답해도 된다.
      no_answer_needed?: boolean
      // 그 대화에 붙은 분류.
      category?: string
      // 글에 붙어 온 파일. verified: 크기와 sha256 이 보낸 쪽이 적은 것과 같아서 saved_to 에 저장했다. 아니면 problem 에 까닭이 있고 저장하지 않았다.
      files?: { name: string; size: number; sha256: string; saved_to?: string; verified: boolean; problem?: string }[]
      at: string
    }
  | { type: 'peer_closed'; peer: string; at: string }
  | { type: 'undelivered'; to: string; thread?: string; reason: string; at: string }
  // 이 브릿지를 같은 PC의 다른 세션이 이어받았다. 이 세션은 더 듣지 않는다.
  | { type: 'moved'; at: string }
  // 두 PC의 시계가 너무 달라서 그 상대와 주고받지 못한다. 시계를 맞출 때까지 메시지는 보내지 않고 들고 있다.
  | { type: 'clock'; peer: string; fix: string; at: string }
  // 이쪽 사람이 질문 창에 답했다. 고른 것과 쓴 말은 상대에게 이미 보냈다. closed: 답하지 않고 창을 닫았다. error: 보내지 못한 까닭.
  | { type: 'decision'; thread: string; peer: string; choice?: string; text?: string; delivery?: 'delivered' | 'queued'; closed?: boolean; opens_again_at?: string; error?: string; at: string }
  // 상대가 자기 사람에게 묻기 시작한 지 오래됐다(기본 30분, 그 뒤로 30분마다). 이쪽 사람이 전화나 메신저로 재촉할 수 있게 알린다.
  | { type: 'peer_human_slow'; thread: string; peer: string; subject: string; since: string; minutes: number; their_window?: WaitState; said_in_text?: boolean; at: string }

// 이쪽 사람에게 띄운 질문 창. 사람이 답하거나 창을 닫을 때까지 남고, 세션을 다시 켜면 다시 띄운다.
// reminders: 다시 알린 횟수. closedAt: 사람이 답하지 않고 창을 닫은 때. text: 창을 띄울 수 없어 글로 물었다.
export type HumanQuestion = {
  thread: string
  question: string
  options: string[]
  recommend?: number
  at: string
  reminders?: number
  lastReminder?: string
  closedAt?: string
  text?: boolean
}

// 결정을 사람에게 넘겼다는 말. 이런 말을 답 글로만 보내면 상대는 창이 열렸는지, 사람이 봤는지 모른 채 기다린다.
// 보내는 쪽은 이런 답을 막고 check_with_human 을 쓰게 한다. 받는 쪽은 옛 판 상대가 이렇게 답하면 「사람에게 묻는 중」으로 본다.
const DEFERS_TO_HUMAN = [
  /(사람|담당자?|책임자|팀장|상사|관리자|보안\s*담당|윗선|결재권자|사용자|주인)(에게|께|한테|쪽에|분께)\s*(올렸|올리|넘겼|넘기|전달|여쭤|물어|묻|확인\s*요청|보고)/,
  /(확인|결정|검토|승인|논의)\s*(후|되면|되는\s*대로|하고\s*나서|받는\s*대로|받으면)[^.\n]{0,20}(알려|알리|회신|답|연락|공유)/,
  /(정해지면|정해지는\s*대로|결정되면|답이\s*오면|회신이\s*오면|답을\s*받으면)[^.\n]{0,20}(알려|알리|회신|답|연락|공유)/,
  /\b(ask(ed|ing)?|check(ed|ing)? with|run (it|this) by|escalat\w*|pass(ed|ing)? (it|this) to|forward(ed|ing)? (it|this) to)\b[^.\n]{0,30}\b(my|our|the) (human|owner|user|manager|lead|team|boss|security)/i,
  /\b(get back to you|let you know)\b[^.\n]{0,30}\b(once|when|after|as soon as)\b/i,
]
export const defersToHuman = (text: string) => DEFERS_TO_HUMAN.some(r => r.test(text))

type WireMessage = {
  id: string
  thread: string
  subject?: string
  kind: MessageKind
  text: string
  context?: string
  ask?: AskInfo
  agreement?: Agreement
  human?: boolean
  // 답이 필요 없는 알림. 이 항목을 모르는 옛 판은 그냥 질문으로 받는다.
  noAnswer?: boolean
  // 질문에 붙인 분류. 대화의 첫 글에만 쓴다.
  category?: string
  // 글에 붙인 파일. 내용은 이 글보다 먼저 조각(file)으로 간다. 이 항목을 모르는 옛 판에는 보내지 않는다.
  files?: WireFile[]
  at: string
}

// 분류는 사람이 골라 보는 짧은 이름표다. 한 줄, 30자까지만 받는다. 상대가 보낸 것도 같은 규칙으로 다듬는다.
export const MAX_CATEGORY = 30
export function cleanCategory(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_CATEGORY) || undefined
}

// 답이 필요 없다고 글에만 적어 보낸 알림을 알아본다. 0.9 이하 판은 표시(noAnswer)를 보내지 못하고, 새 판의 AI도 표시를 잊고 글로만 적을 때가 있다.
// 그런 글을 질문으로 두면 화면과 채팅창 위 카드가 답을 기다린다고 보인다. 그래서 보낼 때와 받을 때 글을 보고 알림으로 표시한다.
// 좁게 본다. 문장을 끝내는 물음표가 하나라도 있으면 질문이다. 조건(필요 없으면), 전하는 말(필요 없다고), 지난 일(필요 없었),
// 부정(필요 없지 않), 묻는 말(필요 없나요)은 알림으로 보지 않는다. 「응답」과 response 는 HTTP 응답을 말할 때가 많아서 보지 않는다.
// 잘못 알아봐도 잃는 것은 적다: 받은 AI는 글을 그대로 읽고, 알림에도 답할 수 있다.
const NO_ANSWER_TEXT = [
  /(?:답변|답장|답신|회신|대답|(?<![가-힣])답)(?:은|는|을|이|도)?\s*(?:하실|할|주실|줄)?\s*필요(?:(?:는|가|도)?\s*없(?!으면|다면|다고|다는|다며|다던|는지|을지|나요|습니까|었|지\s*않|는\s*(?:건|것은|것이|게)\s*아니)|하지\s*않(?:습니다|아요|음|다(?![고는며던면])))/,
  /(?:답변|답장|답신|회신|대답|(?<![가-힣])답)(?:은|는)?\s*불필요(?!한지|하면|하다면)/,
  /(?:답변|답장|답신|회신|대답|(?<![가-힣])답)(?:은|는|을)?\s*(?:안\s*(?:하셔|해|주셔|줘)도|(?:하|주)시?지\s*않(?:으셔|아)도)\s*(?:됩|돼|괜찮|되(?!나|는지|느냐|냐|겠습니까|겠어요|겠죠))/,
  /(?<!\b(?:if|whether)\s)\bno\s+(?:reply|answer)\s+(?:is\s+)?(?:needed|required|necessary|expected)\b/i,
  /\bno\s+need\s+to\s+(?:reply|answer|respond)\b/i,
  /\b(?:do(?:es)?\s+not|don['’]?t|doesn['’]?t)\s+need\s+(?:to\s+)?(?:an?\s+|any\s+)?(?:reply|answer)\b/i,
  /\bneed(?:n['’]?t|\s+not)\s+(?:reply|answer)\b/i,
]
// 문장을 끝내는 물음표. 주소 속의 ?id=3 같은 것은 세지 않는다.
const ASKS = /[?？](?![A-Za-z0-9_%=&-])/
export function saysNoAnswer(text: unknown): boolean {
  return typeof text === 'string' && !ASKS.test(text) && NO_ANSWER_TEXT.some(re => re.test(text))
}

// 아직 답이 없는 질문. 마지막으로 오간 글이 질문이면 그 글이고, 답이면 없다. 알림(note)은 건너뛴다.
export function openQuestion(thread: Thread) {
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const m = thread.messages[i]!
    if (m.kind === 'question') return m
    if (m.kind === 'answer') return undefined
  }
  return undefined
}

// 합의문 쓰기 도구로 받는 것. checkedBy 는 이쪽(me)이 확인했는지, 상대(them)가 알려 주기만 했는지다.
export type AgreementInput = {
  conclusion: string
  facts?: { fact: string; evidence: string; checkedBy: 'me' | 'them' }[]
  guesses?: string[]
  disagreements?: string[]
  forHumans?: string[]
}

// hello 는 연결 코드의 토큰을 들고 오거나, 그룹 안의 누군가가 이쪽에 소개해 둔 세션이 토큰 없이 온다.
// 이미 이어진 상대도 주소나 포트가 바뀌면 hello 로 알린다. back 은 그 상대가 다시 켜져 돌아왔다는 뜻이다.
type Payload =
  // rejoin: 받는 쪽이 보내는 쪽을 잊었다가 다시 붙을 때 들고 올 토큰. 보내는 쪽이 받는 쪽 키에만 쓰이게 만들어 건넨다.
  | { type: 'hello'; token?: string; name: string; addrs: string[]; port: number; back?: boolean; rejoin?: string; about?: About; can?: string[] }
  | { type: 'hello_ack'; name: string; members?: Member[]; private?: boolean; rejoin?: string; about?: About; can?: string[] }
  | { type: 'introduce'; member: Member }
  | { type: 'msg'; msg: WireMessage }
  | { type: 'ok' }
  | { type: 'ping' }
  // waiting: 받는 쪽이 이 상대와의 대화에서 자기 사람에게 묻는 중인 것. 0.7 이하 판은 보내지 않는다.
  | { type: 'pong'; waiting?: WaitState[]; can?: string[] }
  | { type: 'bye' }
  | { type: 'poll'; wait: number; ack?: string[] }
  | { type: 'batch'; items: { id: string; payload: Payload }[] }
  // 같은 PC의 다른 세션이 이 브릿지를 이어받는다. 이 브릿지의 비밀키로 봉인해 보내므로, 저장한 상태를 읽을 수 있는 쪽만 보낼 수 있다.
  | { type: 'handover' }
  | { type: 'handover_ok' }
  // 끊긴 까닭을 함께 보려고 상대의 연결 기록 가운데 이쪽에 관한 줄을 달라고 한다. 메시지 내용은 기록에 없다.
  | { type: 'log_request'; lines?: number }
  | { type: 'log'; entries: LogEntry[] }
  // 파일 조각. seq 번째이고 모두 of 개다. data 는 base64 다. 줄에 서 있는 동안에는 data 가 없고, 보낼 때 사본에서 읽어 붙인다.
  | { type: 'file'; id: string; seq: number; of: number; size: number; data?: string }
  // 파일이 붙은 글을 받은 쪽이, 파일마다 크기와 sha256 이 맞았는지 알려 준다.
  | { type: 'receipt'; thread: string; msg: string; files: { id: string; ok: boolean; problem?: string }[] }

// 글에 붙여 보내는 파일의 이름표. 내용은 조각으로 따로 간다.
const wireFiles = (files: FileNote[]) => (files.length ? { files: files.map(({ id, name, size, sha256 }) => ({ id, name, size, sha256 })) } : {})
// 보내기 도구가 AI에게 돌려주는 파일 목록.
const sentFiles = (files: FileNote[]) => (files.length ? { files: files.map(({ name, size, sha256 }) => ({ name, size, sha256 })) } : {})
// 받은 파일을 AI에게 알리는 모양.
const seenFile = (f: FileNote) => ({ name: f.name, size: f.size, sha256: f.sha256, ...(f.path ? { saved_to: f.path } : {}), verified: f.ok === true, ...(f.problem ? { problem: FILE_PROBLEM[f.problem] } : {}) })

// 상대가 가져간 뒤 「받았다」고 알려 와야 줄에서 지운다. 가져가던 연결이 끊겨도 다음에 다시 넘긴다.
export type Outgoing = { id: string; peer: string; payload: Payload; thread?: string; since: number }

class DeliveryError extends Error {
  constructor(readonly reason: 'unreachable' | 'rejected', message: string) {
    super(message)
  }
}

export type BridgeOptions = {
  name: string
  ports?: [number, number]
  home?: string
  addrs?: () => string[]
  retryMs?: number
  // 닿지 않는 상대에게 다시 붙어 보는 간격은 retryMs 에서 두 배씩 늘어 이 값에서 멈춘다. 포기하지는 않는다.
  maxRetryMs?: number
  tokenTtlMs?: number
  connectTimeoutMs?: number
  pollWaitMs?: number
  // 중계 서버 주소(예: https://relay.example.com). 정하면 브릿지를 열 때 거기에 우편함을 연다.
  relay?: string
  relayKey?: string
  // 중계 서버를 거치면 상대가 우편함에서 꺼내 처리할 때까지 기다려야 해서, 바로 보낼 때보다 오래 기다린다.
  relayTimeoutMs?: number
  // 되살릴 때 쓰는 키. 없으면 새로 만든다.
  keys?: KeyPair
  // 이 세션을 다시 켰을 때 되살릴 수 있게 상태를 저장할 파일. 없으면 저장하지 않는다.
  saveTo?: string
  // 받은 봉투의 시각을 견줄 이 PC의 시계. 시험에서 시계가 틀린 PC를 흉내 낼 때만 바꾼다.
  clock?: () => number
  // 상대가 자기 사람에게 묻는 동안 이 시간마다 이쪽에 「오래 기다린다」고 알린다. 기본 30분.
  nudgeMs?: number
  // 이 PC 쪽 일(잠자기, 주소 바뀜, 오래 기다림)을 보는 간격. 시험에서만 줄인다.
  tickMs?: number
}

// 사람이 브라우저로 여는 대화 보기 화면의 주소. 세션을 다시 켜도 이 포트와 토큰으로 다시 열어서, 열어 둔 화면이 스스로 다시 붙는다.
export type ViewerAddress = { port: number; token: string }

// 세션을 다시 켰을 때 되살릴 것. 이 세션의 비밀키와 아직 쓰지 않은 연결 코드가 들어 있어서, 이 PC의 사용자만 읽게 쓴다.
export type SavedBridge = {
  v: 1
  name: string
  publicKey: string
  secretKey: string
  port: number
  peers: Peer[]
  threads: Thread[]
  outbox: Outgoing[]
  tokens: { token: string; expires: number | null; private: boolean }[]
  // 이미 쓴 코드와 그 코드로 들어온 세션. 같은 세션이 그 코드를 다시 들고 오면 받아 준다.
  used?: { token: string; key: string; private: boolean }[]
  ended?: Ended[]
  // 중계 서버 우편함의 비밀. 다시 켜도 같은 우편함을 쓰므로, 양쪽이 다 다시 켜져도 서로의 우편함을 찾는다.
  relaySecret?: string
  // 이 세션의 소개. 다시 켜도 남는다.
  about?: About
  seen: string[]
  closedAsks: [string, string][]
  // 왔지만 AI가 아직 읽지 않은 소식. 다시 켠 뒤 inbox 나 기다리기로 받는다.
  events?: BridgeEvent[]
  viewer?: ViewerAddress
  // 이쪽 사람이 아직 답하지 않은 질문 창.
  asking?: HumanQuestion[]
  pid: number
  savedAt: string
}

export function isSavedBridge(v: unknown): v is SavedBridge {
  const s = v as SavedBridge
  return (
    !!s &&
    s.v === 1 &&
    typeof s.name === 'string' &&
    typeof s.publicKey === 'string' &&
    typeof s.secretKey === 'string' &&
    Number.isInteger(s.port) &&
    Array.isArray(s.peers) &&
    s.peers.every(isMember) &&
    Array.isArray(s.threads) &&
    Array.isArray(s.outbox) &&
    Array.isArray(s.tokens) &&
    (s.used === undefined || Array.isArray(s.used)) &&
    (s.ended === undefined || Array.isArray(s.ended)) &&
    Array.isArray(s.seen) &&
    Array.isArray(s.closedAsks) &&
    (s.events === undefined || Array.isArray(s.events)) &&
    (s.viewer === undefined || (!!s.viewer && Number.isInteger(s.viewer.port) && typeof s.viewer.token === 'string')) &&
    (s.asking === undefined || (Array.isArray(s.asking) && s.asking.every(isHumanQuestion))) &&
    typeof s.savedAt === 'string'
  )
}

function isHumanQuestion(v: unknown): v is HumanQuestion {
  const q = v as HumanQuestion
  return !!q && typeof q.thread === 'string' && typeof q.question === 'string' && Array.isArray(q.options) && q.options.every(o => typeof o === 'string')
}

// 중계 서버의 우편함 상태. off: 중계 서버를 쓰지 않는다.
export type RelayState = 'off' | 'connecting' | 'ok' | { error: string }

const now = () => new Date().toISOString()
const NO_PEERS =
  'no connected session yet; open the bridge and exchange a connection code first. If this session was connected before coworker restarted, call open_bridge with resume set to the session_id from that earlier result'
// 상대가 이 시간 안에 가져가러 왔으면, 상대는 이쪽 메시지를 스스로 가져가는 중이다.
const POLL_FRESH_MS = 60_000
const firstLine = (text: string) => text.trim().split('\n')[0]!.slice(0, 80)
const counted = (t: Thread) => t.messages.filter(m => m.kind === 'question' || m.kind === 'answer').length
const memberOf = (p: Peer): Member => ({ key: p.key, name: p.name, addrs: p.addrs, port: p.port })
// 상대가 알려 준 이름과 주소. 이름은 화면과 AI에게 그대로 가므로 길이를 자르고, 주소는 몇 개까지만 받는다.
const MAX_NAME = 200
const MAX_ADDRS = 32
const isHelloFields = (p: { name?: unknown; addrs?: unknown; port?: unknown }) =>
  typeof p.name === 'string' &&
  Array.isArray(p.addrs) &&
  p.addrs.length <= MAX_ADDRS &&
  p.addrs.every(a => typeof a === 'string' && a.length > 0 && a.length <= 300) &&
  Number.isInteger(p.port) &&
  (p.port as number) > 0 &&
  (p.port as number) < 65536
const isMember = (m: unknown): m is Member => {
  const v = m as Member
  return !!v && typeof v.key === 'string' && isHelloFields(v)
}
const isAskInfo = (a: unknown): a is AskInfo => {
  const v = a as AskInfo
  return !!v && typeof v.id === 'string' && Array.isArray(v.to) && v.to.every(n => typeof n === 'string') && (v.answers === 'all' || v.answers === 'one')
}
// 사람에게 보여 줄 상대 위치. 중계 서버를 거치면 그 서버 이름을 붙인다.
const placeOf = (addr: string, port: number) => (isRelayAddr(addr) ? `${new URL(addr).host} (relay)` : `${hostForUrl(addr)}:${port}`)
const whereIs = (p: Peer) => {
  const addr = p.lastAddr ?? p.addrs[0]
  return addr ? placeOf(addr, p.port) : undefined
}
// 보내다 실패한 까닭을 가린다. 시간 초과, 포트에서 받지 않음, 나머지(주소를 찾지 못함, 길이 없음)는 길 없음이다.
const detailOf = (e: unknown) => {
  const err = e as { name?: string; code?: string | number; message?: string } | undefined
  // 시간 초과는 code 가 숫자(23)라서 이름을 쓴다.
  const name = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? err.name : undefined
  return String(name ?? err?.code ?? err?.name ?? err?.message ?? e).slice(0, 120)
}
const isToken = (t: unknown): t is string => typeof t === 'string' && t.length > 0 && t.length <= 200
const linkErrorOf = (e: unknown): LinkError => {
  const err = e as { name?: string; code?: string } | undefined
  if (err?.name === 'TimeoutError') return 'timeout'
  if (err?.code === 'ECONNREFUSED' || err?.code === 'ConnectionRefused') return 'refused'
  if (err?.code === 'ECONNRESET' || err?.code === 'EPIPE' || err?.code === 'ECONNABORTED' || err?.code === 'ConnectionClosed') return 'cut'
  return 'no_route'
}
const isoOf = (ms: number | undefined) => (ms ? new Date(ms).toISOString() : undefined)
// 기억해 두는 「쓴 코드」와 「끝난 연결」의 수.
const MAX_USED = 500
const MAX_ENDED = 20
const savedPeer = (p: Peer) => ({ key: p.key, name: p.name, about: p.about, can: p.can, addrs: p.addrs, port: p.port, private: p.private || undefined, lastSeen: p.lastSeen, token: p.token, given: p.given })
// 이 PC가 잠들었다고 보는 시계의 빈틈. 5초마다 재는데 이만큼 넘게 비면 그동안 멈춰 있었다.
const TICK_MS = 5000
const PAUSE_MS = 30_000

export class Bridge {
  readonly keys: KeyPair
  // 이 세션의 소개(어느 AI 도구, 모델, 강도). 인사할 때 상대에게 알린다.
  private about: About | undefined
  readonly key: string
  private readonly route: string
  name: string
  port = 0
  readonly peers = new Map<string, Peer>()
  readonly threads = new Map<string, Thread>()

  private server?: Server<undefined>
  private timer?: ReturnType<typeof setInterval>
  private tokens = new Map<string, { expires: number; private: boolean }>()
  private used = new Map<string, { key: string; private: boolean }>()
  private ended: Ended[] = []
  // 상대마다 다시 붙기를 기다리는 중이면, 그 기다림을 바로 끝내는 함수.
  private retryWakers = new Map<string, () => void>()
  // 연결 기록. 홈 폴더가 없으면(시험) 남기지 않는다.
  readonly log: LinkLog
  private ticker?: ReturnType<typeof setInterval>
  private stopReason?: string
  private rejoinTried = new Map<string, number>()
  // 닿지 않는 상대. 언제부터, 몇 번 실패했는지, 마지막으로 기록한 까닭.
  private down = new Map<string, { since: number; tries: number; what: string }>()
  private addedAt = new Map<string, number>()
  private invites = new Map<string, Invite>()
  private closedAsks = new Map<string, string>()
  private seen = new Set<string>()
  private refusedThreads = new Map<string, number>()
  // 예전 봉투를 다시 보내 오는 것을 거른다. 받는 요청과 받은 답 모두.
  private replay: ReplayGuard
  // 시계가 달라 주고받지 못한 상대와 그때. 사람에게는 상대마다 한 시간에 한 번만 알린다.
  private clockOff = new Map<string, number>()
  private outbox: Outgoing[] = []
  private events: BridgeEvent[] = []
  private waiters: Array<() => void> = []
  // 새 일이 생길 때마다 불린다. Claude Code 를 Channels 로 켰으면 여기서 바로 세션에 밀어 넣는다.
  onEvent?: () => void
  // 다른 세션이 이 브릿지를 이어받아 이 브릿지가 멈춘 뒤 불린다. 세션은 띄워 둔 창과 보기 화면을 닫는다.
  onMoved?: () => void
  // 대화나 브릿지 상태가 바뀔 때마다 불린다. 보기 화면이 듣고 브라우저에 바로 밀어 준다.
  private watchers = new Set<() => void>()
  // 이 세션의 대화 보기 화면이 열린 주소. 상태와 함께 저장해서, 다시 켜도 같은 주소로 연다.
  private viewerAddress?: ViewerAddress
  // 이쪽 사람에게 띄운 질문 창. 대화 id 마다 하나.
  private asking = new Map<string, HumanQuestion>()
  private lastWaitPing = 0
  // 상대가 오래 답하지 않을 때 부른다. 세션이 이쪽 사람에게 OS 알림을 띄운다.
  onSlow?: (event: Extract<BridgeEvent, { type: 'peer_human_slow' }>) => void
  private waiting = 0
  private flushing = false
  private lastCode?: string
  private polling = new Set<string>()
  private pollWaiters = new Map<string, Set<() => void>>()
  private abort = new AbortController()
  private relaySecret?: string
  private relayBox?: string
  // 다시 켤 때 이어 쓸 우편함 비밀. 사람이 브릿지를 닫으면 버린다.
  private keptRelaySecret?: string
  relayState: RelayState = 'off'
  private relayWaiters: Array<() => void> = []
  private saveTimer?: ReturnType<typeof setTimeout>
  // close 로 닫았으면 저장한 상태를 지운다. 프로세스가 끝나서 닫힐 때는 다시 켤 때를 위해 남긴다.
  private forget = false
  private readonly opts: Required<Omit<BridgeOptions, 'home' | 'relay' | 'relayKey' | 'keys' | 'saveTo' | 'clock'>> & {
    home?: string
    relay?: string
    relayKey?: string
    saveTo?: string
  }

  constructor(options: BridgeOptions) {
    this.keys = options.keys ?? newKeyPair()
    this.replay = new ReplayGuard(undefined, options.clock)
    this.key = toB64(this.keys.publicKey)
    this.route = routeId(this.key)
    this.name = options.name
    this.opts = {
      ports: DEFAULT_PORTS,
      addrs: localAddresses,
      retryMs: 3000,
      maxRetryMs: 30_000,
      tokenTtlMs: 60 * 60_000,
      connectTimeoutMs: 2000,
      pollWaitMs: 20_000,
      relayTimeoutMs: 15_000,
      nudgeMs: 30 * 60_000,
      tickMs: TICK_MS,
      ...options,
      relay: options.relay?.trim().replace(/\/+$/, '') || undefined,
    }
    const logsDir = this.opts.home ? pathInside(this.opts.home, 'logs') : undefined
    this.log = new LinkLog(logsDir ? pathInside(logsDir, `${this.route}.log`) : undefined)
  }

  // 저장해 둔 세션을 같은 키로 되살린다. 전에 쓰던 포트가 비어 있으면 그 포트로 연다.
  // 상대들은 이 세션을 같은 키로 알고 있으므로 새 연결 코드 없이 다시 이어진다. 바뀐 주소와 포트는 인사로 알린다.
  static restore(saved: SavedBridge, options: Omit<BridgeOptions, 'name' | 'keys'>): Bridge {
    const b = new Bridge({ ...options, name: saved.name, keys: { publicKey: fromB64(saved.publicKey), secretKey: fromB64(saved.secretKey) } })
    b.about = cleanAbout(saved.about)
    for (const p of saved.peers)
      b.peers.set(p.key, {
        key: p.key,
        name: p.name,
        about: cleanAbout(p.about),
        can: cleanCan((p as { can?: unknown }).can),
        addrs: p.addrs,
        port: p.port,
        private: p.private || undefined,
        lastSeen: typeof p.lastSeen === 'number' ? p.lastSeen : undefined,
        token: isToken(p.token) ? p.token : undefined,
        given: isToken(p.given) ? p.given : undefined,
      })
    for (const t of saved.threads) if (t && isThreadId(t.id)) b.threads.set(t.id, t)
    // 글로만 답이 필요 없다고 적은 알림을 알아보기 전(0.10 이하)에 저장한 대화도 알림으로 표시한다.
    for (const t of b.threads.values()) for (const m of t.messages ?? []) if (m.kind === 'question' && !m.noAnswer && saysNoAnswer(m.text)) m.noAnswer = true
    b.outbox = saved.outbox.filter(o => b.peers.has(o.peer))
    for (const t of saved.tokens) b.tokens.set(t.token, { expires: t.expires ?? Infinity, private: !!t.private })
    for (const u of saved.used ?? []) if (typeof u?.token === 'string' && typeof u.key === 'string') b.used.set(u.token, { key: u.key, private: !!u.private })
    b.ended = (saved.ended ?? []).filter(e => typeof e?.name === 'string' && typeof e.id === 'string')
    b.seen = new Set(saved.seen)
    b.closedAsks = new Map(saved.closedAsks)
    // 「다른 세션이 이어받았다」는 알림은 넘겨준 세션의 것이다. 이어받은 쪽에는 넘기지 않는다.
    b.events = (saved.events ?? []).filter(e => e.type !== 'moved')
    b.viewerAddress = saved.viewer
    if (isToken(saved.relaySecret)) b.keptRelaySecret = saved.relaySecret
    for (const q of saved.asking ?? []) if (q && isThreadId(q.thread)) b.asking.set(q.thread, q)
    try {
      b.open(saved.port)
    } catch {
      b.open()
    }
    b.log.write('restored', { name: b.name, peers: b.peers.size, queued: b.outbox.length })
    for (const peer of b.peers.values()) {
      void b.sayHello(peer, { back: true }).catch(() => {})
      void b.pollLoop(peer.key)
    }
    return b
  }

  // 같은 PC의 다른 세션에서 돌고 있는 이 브릿지에게 이쪽으로 옮겨 오겠다고 알린다. 그쪽은 상태를 저장하고 멈춘다.
  static async askToMove(saved: SavedBridge): Promise<boolean> {
    const keys = { publicKey: fromB64(saved.publicKey), secretKey: fromB64(saved.secretKey) }
    try {
      const res = await fetch(`http://127.0.0.1:${saved.port}/v1/${routeId(saved.publicKey)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(seal({ type: 'handover' }, keys.publicKey, keys)),
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) return false
      return (open(await res.json(), keys) as Payload | null)?.type === 'handover_ok'
    } catch {
      return false
    }
  }

  // 지금 상태를 바로 저장한다. 다른 이름표로 옮겨 저장할 때 쓴다.
  persist() {
    this.save()
  }

  snapshot(): SavedBridge {
    return {
      v: 1,
      name: this.name,
      publicKey: toB64(this.keys.publicKey),
      secretKey: toB64(this.keys.secretKey),
      port: this.port,
      about: this.about,
      peers: [...this.peers.values()].map(savedPeer),
      threads: [...this.threads.values()],
      outbox: this.outbox,
      tokens: [...this.tokens]
        .filter(([, t]) => t.expires > Date.now())
        .map(([token, t]) => ({ token, expires: Number.isFinite(t.expires) ? t.expires : null, private: t.private })),
      used: [...this.used].map(([token, u]) => ({ token, key: u.key, private: u.private })),
      ended: this.ended,
      relaySecret: this.keptRelaySecret,
      seen: [...this.seen].slice(-2000),
      closedAsks: [...this.closedAsks],
      events: this.events,
      viewer: this.viewerAddress,
      asking: [...this.asking.values()],
      pid: process.pid,
      savedAt: now(),
    }
  }

  get isOpen() {
    return !!this.server
  }

  addrs() {
    const relay = this.relayBox ? [`${this.opts.relay}/v1/box/${this.relayBox}`] : []
    return [...this.opts.addrs(), ...relay]
  }

  // 포트를 열고 받기 시작한다. 포트를 지정하지 않으면 정해 둔 범위에서 비어 있는 번호를 쓴다.
  open(port?: number) {
    if (this.server) {
      if (port && port !== this.port) throw new Error(`bridge is already open on port ${this.port}`)
      return
    }
    if (port) {
      if (!this.listen(port)) throw new Error(`port ${port} is already in use; pick another port or leave it empty`)
    } else {
      const [min, max] = this.opts.ports
      for (let p = min; p <= max && !this.server; p++) this.listen(p)
      if (!this.server) throw new Error(`no free port between ${min} and ${max}`)
    }
    this.abort = new AbortController()
    if (this.opts.relay) {
      this.relaySecret = this.keptRelaySecret ?? randomToken()
      this.keptRelaySecret = this.relaySecret
      this.relayBox = boxOf(this.relaySecret)
      this.relayState = 'connecting'
      void this.relayLoop()
    }
    this.timer = setInterval(() => {
      void this.flush()
      void this.tryInvites()
    }, this.opts.retryMs)
    this.timer.unref?.()
    this.log.write('open', { name: this.name, port: this.port, addrs: this.addrs(), relay: this.opts.relay })
    this.watchThisPc()
    this.writeState()
    this.changed()
    // 열자마자 한 번은 바로 저장한다. 이 세션이 곧바로 꺼져도 다시 켜거나 다른 세션이 이어받을 수 있다.
    this.save()
  }

  // 새 연결 코드. 코드마다 토큰이 달라서 한 코드로는 한 세션만 연결할 수 있다.
  // 그룹 코드로 들어온 세션은 이쪽 그룹의 다른 세션과도 이어 준다. 개인용 코드는 이쪽하고만 잇는다.
  // ttlMs: 코드를 쓸 수 있는 시간. 비우면 tokenTtlMs(기본 60분), null 이면 시간 제한 없이 브릿지를 닫을 때까지 쓴다.
  // 어느 쪽이든 한 번 쓰면 끝난다.
  newCode(options: { private?: boolean; ttlMs?: number | null } = {}): string {
    if (!this.server) this.open()
    const token = randomToken()
    const ttlMs = options.ttlMs === undefined ? this.opts.tokenTtlMs : options.ttlMs
    this.tokens.set(token, { expires: ttlMs === null ? Infinity : Date.now() + ttlMs, private: !!options.private })
    this.lastCode = encodeCode({ v: 1, name: this.name, addrs: this.addrs(), port: this.port, key: this.key, token })
    this.writeState()
    this.dirty()
    return this.lastCode
  }

  async connect(codeText: string): Promise<Peer> {
    const code = decodeCode(codeText)
    if (code.key === this.key) throw new Error('that is this session\'s own code; give it to your coworker instead')
    if (!this.server) this.open()
    const known = this.peers.get(code.key)
    if (known) {
      // 이미 이어진 상대의 코드를 다시 넣었다. 코드에 적힌 주소를 더해 두고 바로 다시 붙어 본다.
      // 닿지 않아도 끊긴 것으로 보지 않는다. 사람이 닫기 전까지 스스로 다시 붙는다.
      known.addrs = [...new Set([...known.addrs, ...code.addrs])].slice(0, MAX_ADDRS)
      known.token ??= code.token
      this.wakeRetry(known.key)
      this.log.write('code_again', { id: peerId(known.key), peer: known.name })
      await this.sayHello(known, { token: known.token }).catch(() => {})
      this.dirty()
      return known
    }
    const peer: Peer = { key: code.key, name: code.name, addrs: code.addrs, port: code.port, token: code.token }
    let reply: Payload
    try {
      reply = await this.sayHello(peer, { token: code.token })
    } catch (e) {
      this.forgetGiven(peer)
      this.log.write('connect_failed', { id: peerId(peer.key), peer: peer.name, kind: peer.lastError?.kind, detail: peer.lastError?.detail, addrs: peer.addrs, port: peer.port })
      if (e instanceof DeliveryError && e.reason === 'rejected')
        throw new Error('the other session refused this code; it was already used, expired, or that bridge was reopened. Ask for a new code')
      if (this.clockOff.has(code.key))
        throw new Error(`${code.name} answered, but the clocks of the two PCs differ by more than two hours, so it cannot be used. ${CLOCK_FIX}`)
      throw new Error(`cannot reach ${code.name} at ${code.addrs.join(', ')} port ${code.port}. Check that its bridge is open and that the network or VPN lets the two PCs talk`)
    }
    if (reply.type !== 'hello_ack') {
      this.forgetGiven(peer)
      throw new Error('unexpected answer from the other session')
    }
    peer.name = reply.name
    peer.private = !!reply.private
    peer.token ??= code.token
    if (peer.given) this.used.set(peer.given, { key: peer.key, private: peer.private })
    this.addPeer(peer, { how: 'code' })
    if (!peer.private) for (const m of Array.isArray(reply.members) ? reply.members : []) this.invite(m, peer.name)
    return peer
  }

  // 소개받아 아직 잇는 중인 세션.
  connecting() {
    return [...this.invites.values()].map(i => ({ name: i.name, introducedBy: i.by }))
  }

  // 화면에 보여 줄 연결 상태. 핑을 보내지 않고, 마지막으로 주고받아 본 결과를 그대로 돌려준다.
  // 닿는지가 바뀔 때만 달라지는 값만 넣는다. 「마지막으로 본 때」처럼 늘 바뀌는 값을 넣으면,
  // 화면에 밀어 줄 때 「보낸 것과 같으면 보내지 않는다」가 깨진다.
  // via: 마지막으로 닿은 길이다. direct 는 바로 닿는 주소, relay 는 중계 서버.
  // pickup 은 이쪽에서 닿은 적이 없고 상대가 이쪽에 와서 가져가기만 하는 것이다.
  links() {
    return [...this.peers.values()].map(peer => {
      const pulling = this.isPulling(peer)
      const down = pulling ? undefined : this.down.get(peer.key)
      return {
        key: peer.key,
        id: peerId(peer.key),
        name: peer.name,
        about: peer.about,
        state: down ? ('reconnecting' as const) : ('connected' as const),
        since: isoOf(down?.since),
        via: peer.lastAddr ? (isRelayAddr(peer.lastAddr) ? ('relay' as const) : ('direct' as const)) : pulling ? ('pickup' as const) : ('direct' as const),
      }
    })
  }

  // 한 세션에 묻는다. 대화 하나가 생긴다.
  // files: 글에 붙여 보낼 파일의 경로. reviewed: 파일 안의 비밀번호처럼 보이는 곳을 사람이 보고 진짜가 아니라고 했다.
  async ask(to: string | undefined, question: string, context?: string, files?: string[], reviewed = false) {
    const peer = await this.resolvePeer(to)
    if (files?.length) await this.assertTakesFiles([peer])
    return this.sendQuestion(peer, question, context, undefined, false, undefined, this.stage(files, reviewed))
  }

  // to 가 여러 명이나 everyone 이면 받는 사람마다 대화를 하나씩 만들고 같은 ask 로 묶는다. 한 명이면 ask 와 같다.
  // noAnswer: 답이 필요 없는 알림으로 보낸다. 받은 쪽은 답하지 않아도 되고, 답해도 된다.
  // category: 사람이 골라 볼 수 있게 붙이는 짧은 분류.
  async askMany(to: string | string[] | undefined, question: string, context?: string, answers: AnswerMode = 'all', noAnswer = false, category?: string, files?: string[], reviewed = false) {
    const peers = await this.resolvePeers(to)
    // 파일은 아무에게도 보내기 전에 모두 확인한다. 받는 사람마다 사본을 따로 둔다(한 사람에게 다 가면 그 사본만 지운다).
    if (files?.length) await this.assertTakesFiles(peers)
    const staged = peers.map(() => this.stage(files, reviewed))
    if (peers.length === 1) return this.sendQuestion(peers[0]!, question, context, undefined, noAnswer, category, staged[0])
    const ask: AskInfo = { id: randomUUID().slice(0, 8), to: peers.map(p => p.name), answers }
    const sent = await Promise.all(
      peers.map((peer, i) =>
        // 한 곳이 거절해도 나머지는 보낸다.
        this.sendQuestion(peer, question, context, ask, noAnswer, category, staged[i]).catch(e => ({
          thread: undefined,
          to: peer.name,
          delivery: 'refused' as const,
          error: e instanceof Error ? e.message : String(e),
        })),
      ),
    )
    return { ask: ask.id, answers, to: ask.to, sent }
  }

  private async sendQuestion(peer: Peer, question: string, context?: string, ask?: AskInfo, noAnswer = false, category?: string, files: FileNote[] = []) {
    assertNoSecrets({ question, context, category })
    const label = cleanCategory(category)
    const thread: Thread = {
      id: randomUUID().slice(0, 8),
      peer: peer.key,
      peerName: peer.name,
      peerAddr: whereIs(peer),
      subject: firstLine(question),
      startedBy: 'me',
      status: 'waiting_for_peer',
      ask,
      category: label,
      messages: [],
    }
    this.threads.set(thread.id, thread)
    // 표시하지 않고 글에 답이 필요 없다고만 적어도 알림으로 보낸다.
    const notice = noAnswer || saysNoAnswer(question) ? { noAnswer: true } : {}
    const msg: WireMessage = { id: randomUUID(), thread: thread.id, subject: thread.subject, kind: 'question', text: question, context, ask, ...notice, category: label, ...wireFiles(files), at: now() }
    thread.messages.push({ id: msg.id, from: 'me', kind: msg.kind, text: msg.text, context: msg.context, ...notice, ...(files.length ? { files } : {}), at: msg.at })
    this.changed()
    try {
      return { thread: thread.id, to: peer.name, delivery: await this.sendMessage(peer, msg, thread.id), ...sentFiles(files) }
    } catch (e) {
      // 보내다 만 파일 조각과 사본도 함께 치운다.
      this.outbox = this.outbox.filter(o => o.thread !== thread.id)
      this.unspool({ type: 'msg', msg })
      this.threads.delete(thread.id)
      this.changed()
      throw e
    }
  }

  // human: 사람이 정한 답이다. 합의문이 「사람이 정할 것」으로 남긴 것은 합의문을 쓴 뒤에도 사람이 정해 보낼 수 있다.
  async reply(threadId: string, text: string, opts: { human?: boolean; files?: string[]; reviewed?: boolean } = {}) {
    const thread = this.threads.get(threadId)
    if (!thread) throw new Error(`no conversation with id ${threadId}`)
    if (!(opts.human && thread.status === 'agreed')) this.assertOpen(thread)
    assertNoSecrets({ answer: text })
    const peer = this.peers.get(thread.peer)
    if (!peer) throw new Error(`${thread.peerName} is no longer connected`)
    if (opts.files?.length) await this.assertTakesFiles([peer])
    const files = this.stage(opts.files, opts.reviewed)
    const human = opts.human ? { human: true } : {}
    const msg: WireMessage = { id: randomUUID(), thread: thread.id, kind: 'answer', text, ...human, ...wireFiles(files), at: now() }
    thread.messages.push({ id: msg.id, from: 'me', kind: msg.kind, text, ...human, ...(files.length ? { files } : {}), at: msg.at })
    // 상대가 자기 사람에게 묻는 중에 이쪽이 재촉해도, 상대는 여전히 사람의 결정을 기다린다.
    if (thread.status !== 'agreed' && !(thread.status === 'peer_checking_with_their_human' && thread.humanSince)) thread.status = 'waiting_for_peer'
    this.changed()
    const delivery = await this.sendMessage(peer, msg, thread.id)
    return { thread: thread.id, to: peer.name, delivery, status: thread.status, ...sentFiles(files) }
  }

  // 결정이 필요해 이쪽 사람에게 묻는 동안, 상대가 막연히 기다리지 않게 알린다.
  async hold(threadId: string, note: string) {
    const thread = this.threads.get(threadId)
    if (!thread) throw new Error(`no conversation with id ${threadId}`)
    if (thread.status !== 'agreed') this.assertOpen(thread)
    assertNoSecrets({ note })
    const peer = this.peers.get(thread.peer)
    if (!peer) throw new Error(`${thread.peerName} is no longer connected`)
    const msg: WireMessage = { id: randomUUID(), thread: thread.id, kind: 'note', text: note, at: now() }
    thread.messages.push({ id: msg.id, from: 'me', kind: 'note', text: note, at: msg.at })
    if (thread.status !== 'agreed') thread.status = 'checking_with_your_human'
    this.changed()
    const delivery = await this.sendOrQueue(peer, { type: 'msg', msg }, thread.id)
    return { thread: thread.id, to: peer.name, delivery, status: thread.status }
  }

  // 대화를 마치고 합의문을 쓴다. 상대에게 보내고, 양쪽 PC에 파일로 남긴다.
  // 상대가 먼저 썼어도 이쪽 판을 따로 쓸 수 있다. 같은 쪽이 다시 쓰면 앞의 것을 고친 판이 된다.
  // 상대가 이미 떠났으면 이쪽에만 남긴다.
  async agree(threadId: string, input: AgreementInput) {
    const thread = this.threads.get(threadId)
    if (!thread) throw new Error(`no conversation with id ${threadId}`)
    if (thread.status === 'closed') this.assertOpen(thread)
    const facts = input.facts ?? []
    assertNoSecrets({
      conclusion: input.conclusion,
      facts: facts.map(f => `${f.fact}\n${f.evidence}`).join('\n'),
      guesses: input.guesses?.join('\n'),
      disagreements: input.disagreements?.join('\n'),
      for_humans: input.forHumans?.join('\n'),
    })
    const agreement: Agreement = {
      by: this.name,
      conclusion: input.conclusion,
      facts: facts.map(f => ({ fact: f.fact, evidence: f.evidence, checkedBy: f.checkedBy === 'me' ? this.name : thread.peerName })),
      guesses: input.guesses ?? [],
      disagreements: input.disagreements ?? [],
      forHumans: input.forHumans ?? [],
    }
    if (!isAgreement(agreement)) throw new Error('the agreement is too long or has an empty item')
    const msg: WireMessage = { id: randomUUID(), thread: thread.id, kind: 'agreement', text: renderAgreement(agreement), agreement, at: now() }
    thread.messages.push({ id: msg.id, from: 'me', kind: 'agreement', text: msg.text, agreement, at: msg.at })
    thread.status = 'agreed'
    this.changed()
    const file = this.saveAgreement(thread)
    const peer = this.peers.get(thread.peer)
    const delivery = peer ? await this.sendOrQueue(peer, { type: 'msg', msg }, thread.id) : `not sent: ${thread.peerName} is no longer connected`
    return { thread: thread.id, to: thread.peerName, delivery, status: thread.status, file }
  }

  // 아직 아무도 가져가지 않은 소식을 들여다본다. 가져가지는 않는다.
  unread(): readonly BridgeEvent[] {
    return this.events
  }

  // AI가 아직 읽어 가지 않은 글이 있는 대화들. 화면이 「이쪽 AI가 아직 읽지 않은 질문」을 가려 보인다.
  unreadThreads(): string[] {
    return [...new Set(this.events.flatMap(e => (e.type === 'message' ? [e.thread] : [])))]
  }

  // 새 소식이 올 때까지 기다린다. 이미 쌓여 있으면 바로 돌려준다.
  // 기다림은 마지막 하나만 산다. 사람이 끊었거나 아무도 결과를 읽지 않는 기다림이 소식을 가져가면
  // 그 소식은 사라진다. 그래서 새 기다림이 시작되거나 호출이 취소되면 앞의 기다림은 빈손으로 끝난다.
  async wait(timeoutMs: number, signal?: AbortSignal): Promise<BridgeEvent[]> {
    if (timeoutMs <= 0) return this.take()
    const turn = ++this.waiting
    for (const wake of [...this.waiters]) wake()
    const live = () => turn === this.waiting && !signal?.aborted
    const deadline = Date.now() + timeoutMs
    while (this.events.length === 0 && live() && Date.now() < deadline) {
      await new Promise<void>(resolve => {
        const done = () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', done)
          this.waiters = this.waiters.filter(w => w !== done)
          resolve()
        }
        // 정한 시간 없이 기다릴 때는 타이머를 걸지 않는다(setTimeout 은 너무 큰 값을 1ms 로 바꾼다).
        const timer = Number.isFinite(deadline) ? setTimeout(done, deadline - Date.now()) : undefined
        signal?.addEventListener('abort', done)
        this.waiters.push(done)
      })
    }
    return live() ? this.take() : []
  }

  // AI가 읽어 간 소식은 줄에서 빼고, 저장한 상태에서도 뺀다.
  private take() {
    const taken = this.events.splice(0)
    // AI가 읽어 갔다는 것을 화면도 알아야 한다(「아직 읽지 않음」 표시가 풀린다). 그래서 저장만 하지 않고 지켜보는 쪽에도 알린다.
    if (taken.length) this.changed()
    return taken
  }

  async connections() {
    const peers = await Promise.all(
      [...this.peers.values()].map(async peer => {
        let direct = false
        try {
          const pong = await this.deliver(peer, { type: 'ping' })
          direct = pong.type === 'pong'
          if (pong.type === 'pong') this.takeWaiting(peer, pong.waiting)
        } catch {}
        const deciding = [...this.threads.values()]
          .filter(t => t.peer === peer.key)
          .flatMap(t => {
            const h = this.theirHuman(t)
            return h ? [{ thread: t.id, subject: t.subject, ...h }] : []
          })
        const pulling = this.isPulling(peer)
        const reachable = direct || pulling
        const error = !reachable && peer.lastError
        return {
          name: peer.name,
          about: peer.about,
          id: peerId(peer.key),
          group: !peer.private,
          reachable,
          // 연결은 사람이 닫을 때만 끝난다. 닿지 않는 동안은 끊긴 것이 아니라 다시 붙는 중이다.
          state: reachable ? 'connected' : 'reconnecting',
          via: direct
            ? placeOf(peer.lastAddr!, peer.port)
            : pulling
              ? 'the other side cannot be reached directly, so it comes here to pick up messages'
              : undefined,
          queued: this.outbox.filter(o => o.peer === peer.key).length,
          last_seen: isoOf(peer.lastSeen),
          last_error: error ? { kind: error.kind, what: LINK_ERRORS[error.kind], detail: error.detail, at: isoOf(error.at) } : undefined,
          next_try: reachable ? undefined : (isoOf(peer.retryAt) ?? 'now'),
          their_human_deciding: deciding.length ? deciding : undefined,
        }
      }),
    )
    return { me: this.describe(), peers, connecting: this.connecting(), ended: this.ended.length ? this.ended : undefined, log: this.log.path }
  }

  threadSummaries() {
    return [...this.threads.values()].map(t => {
      const last = t.messages.at(-1)
      return {
        id: t.id,
        with: t.peerName,
        subject: t.subject,
        category: t.category,
        status: t.status,
        ask: t.ask && { id: t.ask.id, to: t.ask.to, answers: t.ask.answers },
        messages: counted(t),
        last: last && { from: last.from, kind: last.kind, text: last.text.slice(0, 200) },
        // 답이 필요 없는 알림이 마지막이다. 「차례」는 남아 있지만 아무도 답을 기다리지 않는다.
        no_answer_needed: openQuestion(t)?.noAnswer || undefined,
        their_human: this.theirHuman(t),
      }
    })
  }

  describe() {
    const relay = this.opts.relay ? { url: this.opts.relay, status: this.relayState } : undefined
    return { name: this.name, about: this.about, open: this.isOpen, port: this.port || undefined, addrs: this.isOpen ? this.addrs() : undefined, relay }
  }

  // 중계 서버에 우편함이 열릴 때까지 잠깐 기다린다. 연결 코드를 넘기기 전에 상대가 닿을 수 있게 한다.
  async relayReady(timeoutMs: number) {
    const deadline = Date.now() + timeoutMs
    while (this.relayState === 'connecting' && Date.now() < deadline)
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, Math.max(deadline - Date.now(), 0))
        this.relayWaiters.push(() => (clearTimeout(timer), resolve()))
      })
    return this.relayState
  }

  // 연결된 세션에 끝났다고 알리고 포트를 닫는다. 사람이 닫은 것이므로 저장한 상태도 지운다.
  async close() {
    if (!this.server) return
    this.forget = true
    await Promise.all(
      [...this.peers.values()].map(async p => {
        try {
          await this.deliver(p, { type: 'bye' })
        } catch {
          if (this.isPulling(p)) await this.handOver(p, { type: 'bye' }, 2000)
        }
      }),
    )
    this.shutdown()
  }

  // 알리지 않고 바로 닫는다. 프로세스가 끝날 때 쓴다. 그때는 다시 켤 때를 위해 상태를 남긴다.
  shutdown() {
    if (this.server) this.log.write('closed', { by: this.forget ? 'this side\'s human (close_bridge)' : (this.stopReason ?? 'the process stopped; it comes back on restart') })
    this.stopReason = undefined
    clearInterval(this.ticker)
    clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    if (this.opts.saveTo) {
      if (this.forget) rmSync(this.opts.saveTo, { force: true })
      else this.save()
    }
    // 사람이 브릿지를 닫았으면 보내려고 둔 사본과 받다 만 조각을 지운다. 받은 파일은 사람의 것이라 남긴다.
    if (this.forget)
      for (const kind of ['out', 'partial'] as const) {
        const dir = this.filesDir(kind)
        if (dir) rmSync(dir, { recursive: true, force: true })
      }
    if (this.forget) this.keptRelaySecret = undefined
    this.forget = false
    this.abort.abort()
    for (const wakers of this.pollWaiters.values()) for (const wake of [...wakers]) wake()
    clearInterval(this.timer)
    this.server?.stop(true)
    this.server = undefined
    this.relaySecret = undefined
    this.relayBox = undefined
    if (this.opts.relay) this.relayState = 'off'
    this.removeState()
    this.peers.clear()
    this.tokens.clear()
    this.used.clear()
    this.ended = []
    this.retryWakers.clear()
    this.invites.clear()
    this.refusedThreads.clear()
    this.outbox = []
    this.changed()
  }

  private listen(port: number): boolean {
    try {
      this.server = Bun.serve({
        port,
        hostname: '0.0.0.0',
        maxRequestBodySize: 1 << 20,
        idleTimeout: 60,
        fetch: (req, server) => this.handle(req, server),
      })
      this.port = port
      return true
    } catch {
      return false
    }
  }

  private async handle(req: Request, server: Server<undefined>): Promise<Response> {
    if (req.method !== 'POST' || new URL(req.url).pathname !== `/v1/${this.route}`) return new Response('not found', { status: 404 })
    const sealed = await req.json().catch(() => null)
    const seenAt = server.requestIP(req)?.address.replace(/^::ffff:/, '')
    const { status, body } = await this.respond(sealed, seenAt)
    return new Response(body, { status, headers: { 'content-type': status === 200 ? 'application/json' : 'text/plain' } })
  }

  // 바로 온 요청이든 중계 서버의 우편함에서 꺼낸 요청이든 같게 처리한다. seenAt 은 바로 왔을 때 상대의 IP다.
  private async respond(sealed: unknown, seenAt: string | undefined, relayed = false): Promise<{ status: number; body: string }> {
    const payload = open(sealed, this.keys) as Payload | null
    if (!payload) return { status: 403, body: 'forbidden' }
    // 다시 온 봉투는 거절하되 403 은 쓰지 않는다. 보낸 쪽이 같은 봉투를 다른 주소로 다시 보낸 것일 수도 있어서, 연결을 끊지 않고 다시 보내게 한다.
    const fresh = this.replay.check(sealed as Sealed, payload)
    if (fresh === 'stale') this.clockDiffers((sealed as Sealed).from)
    if (fresh !== 'ok') return { status: 409, body: fresh === 'stale' ? 'stale: the two PCs clocks differ by more than two hours' : 'already received' }
    const from = (sealed as { from: string }).from
    const answer = (p: Payload) => ({ status: 200, body: JSON.stringify(seal(p, fromB64(from), this.keys)) })
    const forbidden = { status: 403, body: 'forbidden' }

    // 같은 PC의 다른 세션이 이어받는다. 상태를 저장하고 멈춘다. 답을 보낸 뒤에 멈춰야 답이 간다.
    if (from === this.key && payload.type === 'handover' && this.server) {
      this.emit({ type: 'moved', at: now() })
      this.stopReason = 'another session on this PC took over this bridge'
      this.save()
      setTimeout(() => {
        this.shutdown()
        this.onMoved?.()
      }, 50)
      return answer({ type: 'handover_ok' })
    }

    const peer = this.peers.get(from)
    if (!peer) {
      if (payload.type !== 'hello' || !isHelloFields(payload)) return forbidden
      const invite = this.invites.get(from)
      const invited = !!invite
      const why = invited ? undefined : this.whyRefused(payload.token, from)
      const token = invited ? undefined : this.takeToken(payload.token, from)
      if (!invited && !token) {
        this.log.write('refused_stranger', { id: peerId(from), peer: payload.name.slice(0, MAX_NAME), from: seenAt ?? (relayed ? 'relay' : undefined), reason: why })
        return forbidden
      }
      // 다른 PC에서 왔으면 상대가 적어 보낸 127.0.0.1 은 이 PC를 가리키므로 뺀다. 중계 서버로 온 것도 다른 PC로 본다.
      const remote = relayed || (!!seenAt && !isLoopback(seenAt))
      const given = remote ? payload.addrs.filter(a => !isLoopback(a)) : payload.addrs
      const addrs = [...new Set([...(seenAt ? [seenAt] : []), ...given])]
      const added: Peer = { key: from, name: payload.name.slice(0, MAX_NAME), about: cleanAbout(payload.about), can: cleanCan(payload.can), addrs, port: payload.port, private: token?.private, token: isToken(payload.rejoin) ? payload.rejoin : undefined }
      // 그룹 코드로 들어왔으면, 이쪽 그룹의 다른 세션과 서로 소개한다. 소개받아 온 세션은 더 퍼뜨리지 않는다.
      const members = token && !token.private ? this.groupPeers().filter(p => p.key !== from) : []
      for (const m of members) void this.sendOrQueue(m, { type: 'introduce', member: memberOf(added) }).catch(() => {})
      const rejoin = this.rejoinFor(added)
      const again = !!token && 'again' in token
      this.addPeer(added, { emit: true, via: invited ? invite!.by : undefined, again, how: invited ? 'introduced' : again ? 'came back with its token' : 'code' })
      return answer({ type: 'hello_ack', name: this.name, members: members.map(memberOf), private: token?.private || undefined, rejoin, about: this.about, can: CAN })
    }

    // 상대에게서 무엇이든 왔으면 상대는 깨어 있다. 다시 붙기를 기다리던 중이면 바로 다시 붙어 본다.
    peer.lastSeen = Date.now()
    this.wakeRetry(peer.key)
    if (payload.type === 'hello') return answer(this.welcomeBack(peer, payload, seenAt, relayed))
    if (payload.type === 'poll') {
      peer.lastPollAt = Date.now()
      const acked = new Set(Array.isArray(payload.ack) ? payload.ack : [])
      if (acked.size) {
        for (const o of this.outbox) if (o.peer === peer.key && acked.has(o.id)) this.unspool(o.payload)
        this.outbox = this.outbox.filter(o => !(o.peer === peer.key && acked.has(o.id)))
        this.dirty()
      }
      const items = await this.pending(peer.key, Math.min(Math.max(payload.wait, 0), 25_000))
      return answer({ type: 'batch', items })
    }
    const reply = this.process(peer, payload)
    return reply ? answer(reply) : { status: 400, body: 'bad request' }
  }

  // 중계 서버의 우편함에서 이쪽 앞으로 온 요청을 꺼내 처리하고, 답을 돌려준다.
  // 이 PC로 들어오는 연결을 받을 수 없어도(공유기 아래, 방화벽) 나가는 연결만으로 받는다.
  private async relayLoop() {
    const base = `${this.opts.relay}/v1`
    const box = this.relayBox!
    const signal = this.abort.signal
    const headers = { authorization: `Bearer ${this.relaySecret}`, 'content-type': 'application/json', ...(this.opts.relayKey ? { 'x-relay-key': this.opts.relayKey } : {}) }
    const setState = (state: RelayState) => {
      if (JSON.stringify(state) !== JSON.stringify(this.relayState)) this.log.write('relay', { state })
      this.relayState = state
      for (const wake of this.relayWaiters.splice(0)) wake()
    }
    let backoff = this.opts.retryMs
    // 처음에는 기다리지 않고 바로 돌아와 우편함이 열린 것을 확인한다. 그다음부터 새 요청이 올 때까지 붙잡아 둔다.
    let wait = 0
    while (!signal.aborted && this.relayBox === box) {
      try {
        const res = await fetch(`${base}/inbox/${box}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ wait }),
          signal: AbortSignal.any([AbortSignal.timeout(35_000), signal]),
        })
        if (res.status === 401) {
          setState({ error: 'the relay refused this session: wrong or missing relay key (COWORKER_RELAY_KEY)' })
          return
        }
        if (!res.ok) throw new Error(`the relay answered ${res.status}`)
        const { items } = (await res.json()) as { items: { id: string; body: string }[] }
        setState('ok')
        wait = 25_000
        backoff = this.opts.retryMs
        for (const item of items) void this.answerRelayed(base, box, headers, item)
      } catch (e) {
        if (signal.aborted) return
        setState({ error: `cannot reach the relay ${this.opts.relay}: ${e instanceof Error ? e.message : String(e)}` })
        wait = 0
        await Bun.sleep(backoff)
        backoff = Math.min(backoff * 2, 30_000)
      }
    }
  }

  private async answerRelayed(base: string, box: string, headers: Record<string, string>, item: { id: string; body: string }) {
    let sealed: unknown = null
    try {
      sealed = JSON.parse(item.body)
    } catch {}
    const { status, body } = await this.respond(sealed, undefined, true)
    await fetch(`${base}/reply/${box}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: item.id, status, body }),
      signal: AbortSignal.any([AbortSignal.timeout(10_000), this.abort.signal]),
    }).catch(() => {})
  }

  // 이미 이어진 상대가 다시 인사했다. 다시 켜졌거나 잠에서 깨어 주소나 포트가 바뀌었을 수 있으니 새로 받는다.
  // 상대가 다시 켜져 돌아온 것이면(back) 사람에게 알릴 수 있게 소식을 남긴다. 밀려 있던 것은 바로 다시 보낸다.
  private welcomeBack(peer: Peer, hello: Extract<Payload, { type: 'hello' }>, seenAt: string | undefined, relayed: boolean): Payload {
    if (isHelloFields(hello)) {
      const remote = relayed || (!!seenAt && !isLoopback(seenAt))
      const given = remote ? hello.addrs.filter(a => !isLoopback(a)) : hello.addrs
      const addrs = [...new Set([...(seenAt ? [seenAt] : []), ...given])].slice(0, MAX_ADDRS)
      const moved = addrs.join() !== peer.addrs.join() || hello.port !== peer.port
      this.log.write('hello_in', { id: peerId(peer.key), peer: peer.name, back: hello.back || undefined, from: seenAt ?? (relayed ? 'relay' : undefined), moved: moved || undefined, addrs: moved ? addrs : undefined, port: moved ? hello.port : undefined })
      peer.addrs = addrs
      peer.port = hello.port
      peer.lastAddr = undefined
      peer.directFailed = false
    }
    // 상대가 건넨 토큰은 늘 새것으로 바꿔 둔다. 이쪽을 잊은 상대에게 다시 들어갈 때 그것을 든다.
    if (isToken(hello.rejoin)) peer.token = hello.rejoin
    if (hello.back) this.emit({ type: 'connected', peer: peer.name, again: true, at: now() })
    else this.changed()
    void this.flush()
    this.learn(peer, hello.about, hello.can)
    return { type: 'hello_ack', name: this.name, rejoin: this.rejoinFor(peer), about: this.about, can: CAN }
  }

  // 바로 받았든, 상대에게 가져왔든 같은 방식으로 처리한다.
  private process(peer: Peer, payload: Payload): Payload | null {
    switch (payload.type) {
      case 'ping':
        return { type: 'pong', waiting: this.waitingFor(peer), can: CAN }
      case 'msg':
        this.receive(peer, payload.msg)
        return { type: 'ok' }
      case 'bye':
        this.dropPeer(peer)
        return { type: 'ok' }
      case 'hello':
        if (!isHelloFields(payload)) return null
        peer.addrs = payload.addrs
        peer.port = payload.port
        this.learn(peer, payload.about, payload.can)
        return { type: 'hello_ack', name: this.name, about: this.about, can: CAN }
      case 'introduce':
        // 개인용 코드로 이어진 상대가 소개하는 세션은 받지 않는다.
        if (!peer.private) this.invite(payload.member, peer.name)
        return { type: 'ok' }
      case 'file':
        this.takeChunk(peer, payload)
        return { type: 'ok' }
      case 'receipt':
        this.takeReceipt(peer, payload)
        return { type: 'ok' }
      case 'log_request':
        // 이 상대에 관한 줄과 이 PC 전체에 관한 줄만 준다. 다른 상대에 관한 줄은 주지 않는다.
        return { type: 'log', entries: this.log.read({ id: peerId(peer.key), lines: typeof payload.lines === 'number' ? payload.lines : 100 }) }
      default:
        return null
    }
  }

  private groupPeers() {
    return [...this.peers.values()].filter(p => !p.private)
  }

  // 새로 이어진 상대를 등록한다. 양쪽이 동시에 인사해 이미 등록돼 있으면 아무것도 하지 않는다.
  private addPeer(peer: Peer, options: { emit?: boolean; via?: string; again?: boolean; how?: string } = {}) {
    if (this.peers.has(peer.key)) return false
    this.peers.set(peer.key, peer)
    this.addedAt.set(peer.key, Date.now())
    this.log.write('connected', { id: peerId(peer.key), peer: peer.name, how: options.how, via: options.via, addrs: peer.addrs, port: peer.port })
    this.invites.delete(peer.key)
    this.ended = this.ended.filter(e => e.id !== peerId(peer.key))
    // 바로 저장한다. 연결하자마자 프로세스가 죽어도 다시 켜면 이 상대에게 다시 붙는다.
    this.save()
    if (options.emit) this.emit({ type: 'connected', peer: peer.name, via: options.via, again: options.again || undefined, about: peer.about, at: now() })
    else this.changed()
    void this.pollLoop(peer.key)
    return true
  }

  // 그룹의 누군가가 소개한 세션을 기다리고, 이쪽에서도 먼저 인사해 본다.
  private invite(member: unknown, by: string) {
    if (!isMember(member) || member.key === this.key || this.peers.has(member.key)) return
    const { key, name, addrs, port } = member
    this.invites.set(key, { key, name, addrs, port, by, nextTry: 0, backoff: this.opts.retryMs })
    void this.tryInvites()
  }

  private async tryInvites() {
    await Promise.all(
      [...this.invites.values()].map(async invite => {
        if (this.peers.has(invite.key)) return void this.invites.delete(invite.key)
        if (invite.trying || invite.nextTry > Date.now() || !this.server) return
        invite.trying = true
        const peer: Peer = { key: invite.key, name: invite.name, addrs: invite.addrs, port: invite.port }
        try {
          // 상대가 아직 소개를 못 받았으면 거절한다. 그때는 조금 뒤에 다시 인사한다.
          const reply = await this.sayHello(peer)
          if (reply.type === 'hello_ack' && this.invites.has(invite.key)) {
            peer.name = reply.name
            this.addPeer(peer, { emit: true, via: invite.by, how: 'introduced' })
          } else this.forgetGiven(peer)
        } catch {
          this.forgetGiven(peer)
          invite.nextTry = Date.now() + invite.backoff
          invite.backoff = Math.min(invite.backoff * 2, this.opts.maxRetryMs)
        } finally {
          invite.trying = false
        }
      }),
    )
  }

  private assertOpen(thread: Thread) {
    if (thread.status === 'closed') {
      const notice = thread.messages.findLast(m => m.kind === 'closed')
      throw new Error(notice?.text ?? 'this question is closed. No answer is needed.')
    }
    if (thread.status === 'agreed')
      throw new Error(
        'this conversation is finished: an agreement was written. If you disagree with it, write your own version with write_agreement; for anything new, send a new question',
      )
  }

  // 한 명만 답하면 되는 질문에 첫 답이 오면, 나머지 사람에게 답하지 않아도 된다고 알린다.
  private closeSiblings(ask: AskInfo, answeredBy: string, except: string) {
    this.closedAsks.set(ask.id, answeredBy)
    for (const t of this.threads.values()) {
      if (t.ask?.id !== ask.id || t.id === except || t.status === 'closed') continue
      const text = `${answeredBy} answered first, so this question is closed. No answer is needed.`
      const msg: WireMessage = { id: randomUUID(), thread: t.id, kind: 'closed', text, at: now() }
      t.messages.push({ id: msg.id, from: 'me', kind: 'closed', text, at: msg.at })
      t.status = 'closed'
      const peer = this.peers.get(t.peer)
      if (peer) void this.sendOrQueue(peer, { type: 'msg', msg }, t.id).catch(() => {})
    }
  }

  private askProgress(ask: AskInfo): AskProgress {
    const threads = [...this.threads.values()].filter(t => t.ask?.id === ask.id)
    const answered = threads.filter(t => t.messages.some(m => m.from === 'peer' && m.kind === 'answer')).map(t => t.peerName)
    return { id: ask.id, answers: ask.answers, asked: threads.map(t => t.peerName), answered, closedBy: this.closedAsks.get(ask.id) }
  }

  // 상대 쪽 사람이 브릿지를 닫아 「끝」을 알려 왔다. 연결이 끝나는 것은 이때뿐이다.
  private dropPeer(peer: Peer) {
    if (!this.peers.delete(peer.key)) return
    this.log.write('ended', { id: peerId(peer.key), peer: peer.name, by: 'the other side\'s human (close_bridge)' })
    // 사람이 끝낸 연결이다. 그 상대가 들고 있는 토큰으로는 다시 들어오지 못한다. 다시 이으려면 새 코드가 있어야 한다.
    for (const [token, u] of this.used) if (u.key === peer.key) this.used.delete(token)
    for (const o of this.outbox) if (o.peer === peer.key) this.unspool(o.payload)
    this.outbox = this.outbox.filter(o => o.peer !== peer.key)
    this.wakeRetry(peer.key)
    const id = peerId(peer.key)
    this.ended = [...this.ended.filter(e => e.id !== id), { name: peer.name, id, at: now() }].slice(-MAX_ENDED)
    this.emit({ type: 'peer_closed', peer: peer.name, at: now() })
  }

  // 다시 붙어 보기 전에 기다린다. 그사이 상대에게서 무엇이든 오면 기다림을 끝내고 바로 다시 붙어 본다.
  private pause(peer: Peer, ms: number) {
    const signal = this.abort.signal
    peer.retryAt = Date.now() + ms
    return new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        if (this.retryWakers.get(peer.key) === done) this.retryWakers.delete(peer.key)
        peer.retryAt = undefined
        resolve()
      }
      const timer = setTimeout(done, ms)
      signal.addEventListener('abort', done)
      this.retryWakers.set(peer.key, done)
    })
  }

  private wakeRetry(key: string) {
    this.retryWakers.get(key)?.()
  }

  private isPulling(peer: Peer) {
    return !!peer.lastPollAt && Date.now() - peer.lastPollAt < POLL_FRESH_MS
  }

  // 상대가 가져갈 수 있게 줄에 세우고, 실제로 가져갈 때까지 잠깐 기다린다.
  private async handOver(peer: Peer, payload: Payload, waitMs: number, thread?: string): Promise<boolean> {
    const item: Outgoing = { id: randomUUID(), peer: peer.key, payload, thread, since: Date.now() }
    this.outbox.push(item)
    this.dirty()
    this.wakePoll(peer.key)
    for (let waited = 0; waited < waitMs && this.outbox.includes(item); waited += 50) await Bun.sleep(50)
    return !this.outbox.includes(item)
  }

  private wakePoll(key: string) {
    for (const wake of [...(this.pollWaiters.get(key) ?? [])]) wake()
  }

  // 상대가 가져가러 왔을 때: 아직 「받았다」를 못 들은 것을 순서대로 넘기고, 없으면 새로 생길 때까지 붙잡아 둔다.
  private async pending(key: string, waitMs: number): Promise<{ id: string; payload: Payload }[]> {
    // 파일 조각은 내용을 붙여 넘긴다. 한 번에 넘기는 양이 중계 서버의 답 한도를 넘지 않게 끊는다. 남은 것은 다음에 가져간다.
    const take = () => {
      const out: { id: string; payload: Payload }[] = []
      let bytes = 0
      for (const o of this.outbox) {
        if (o.peer !== key) continue
        const payload = this.withData(o.payload)
        const size = JSON.stringify(payload).length
        if (out.length && bytes + size > BATCH_BYTES) break
        out.push({ id: o.id, payload })
        bytes += size
      }
      return out
    }
    const ready = take()
    if (ready.length || waitMs === 0 || !this.server) return ready
    await new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timer)
        this.pollWaiters.get(key)?.delete(done)
        resolve()
      }
      const timer = setTimeout(done, waitMs)
      if (!this.pollWaiters.has(key)) this.pollWaiters.set(key, new Set())
      this.pollWaiters.get(key)!.add(done)
    })
    return take()
  }

  // 이쪽이 상대에게 가서 이쪽 앞으로 온 메시지를 가져온다.
  // 이쪽 PC로 들어오는 연결이 방화벽에 막혀 있어도 대화가 되게 하는 길이다.
  // 닿지 않으면 간격을 늘려 가며 끝까지 다시 붙어 본다. 횟수나 시간으로 포기하지 않는다.
  // 멈추는 것은 사람이 닫았을 때뿐이다: 이쪽 브릿지를 닫았거나, 상대가 「끝」을 알려 왔다.
  private async pollLoop(key: string) {
    if (this.polling.has(key)) return
    this.polling.add(key)
    let backoff = this.opts.retryMs
    let ack: string[] = []
    // 닿지 않다가 다시 닿으면(이쪽 PC가 잠에서 깼다) 이쪽의 지금 주소와 포트를 다시 알린다.
    let lost = false
    try {
      while (this.server && !this.abort.signal.aborted) {
        const peer = this.peers.get(key)
        if (!peer) break
        try {
          if (!peer.lastAddr) await this.deliver(peer, { type: 'ping' })
          const body = JSON.stringify(seal({ type: 'poll', wait: this.opts.pollWaitMs, ack }, fromB64(peer.key), this.keys))
          const reply = await this.deliverTo(peer, peer.lastAddr!, body, this.opts.pollWaitMs + 5000)
          if (reply === 'refused') throw new DeliveryError('rejected', 'refused')
          if (!reply) throw new DeliveryError('unreachable', 'no answer')
          backoff = this.opts.retryMs
          ack = []
          if (lost) {
            lost = false
            void this.sayHello(peer).catch(() => {})
            void this.flush()
            this.changed()
          }
          if (reply.type === 'batch')
            for (const item of reply.items) {
              this.process(peer, item.payload)
              ack.push(item.id)
            }
        } catch (e) {
          if (this.abort.signal.aborted) break
          // 상대가 이쪽을 모른다고 하면(막 연결된 직후이거나, 상대가 이쪽을 잊었다) 처음 들어갈 때 쓴 코드를 다시 들고 간다.
          this.noteDown(peer)
          if (e instanceof DeliveryError && e.reason === 'rejected') await this.rejoin(peer)
          peer.lastAddr = undefined
          if (!lost) this.changed()
          lost = true
          await this.pause(peer, backoff)
          backoff = Math.min(backoff * 2, this.opts.maxRetryMs)
        }
      }
    } finally {
      this.polling.delete(key)
    }
  }

  private receive(peer: Peer, msg: WireMessage) {
    if (!msg || typeof msg !== 'object') return
    if (!isThreadId(msg.thread)) {
      const count = (this.refusedThreads.get(peer.key) ?? 0) + 1
      this.refusedThreads.set(peer.key, count)
      this.log.write('refused_thread_id', { id: peerId(peer.key), count })
      this.dropStagedChunks(peer, msg.files)
      return
    }
    if (typeof msg.id !== 'string' || typeof msg.text !== 'string') return
    if (!KINDS.includes(msg.kind)) return
    if (this.seen.has(msg.id)) return
    this.seen.add(msg.id)
    let thread = this.threads.get(msg.thread)
    if (!thread) {
      thread = {
        id: msg.thread,
        peer: peer.key,
        peerName: peer.name,
        peerAddr: whereIs(peer),
        subject: msg.subject ?? firstLine(msg.text),
        startedBy: 'peer',
        status: 'your_turn',
        ask: isAskInfo(msg.ask) ? { id: msg.ask.id, to: msg.ask.to, answers: msg.ask.answers } : undefined,
        category: cleanCategory(msg.category),
        messages: [],
      }
      this.threads.set(thread.id, thread)
    } else if (thread.peer !== peer.key) {
      return
    }
    const context = typeof msg.context === 'string' ? msg.context : undefined
    // 합의문은 상대가 적어 보낸 글 대신 받은 내용으로 이쪽에서 다시 쓴다. 쓴 사람 이름은 상대 이름으로 둔다.
    const got = msg.kind === 'agreement' && isAgreement(msg.agreement) ? msg.agreement : undefined
    const agreement: Agreement | undefined = got && {
      by: peer.name,
      conclusion: got.conclusion,
      facts: got.facts.map(f => ({ fact: f.fact, evidence: f.evidence, checkedBy: f.checkedBy })),
      guesses: got.guesses,
      disagreements: got.disagreements,
      forHumans: got.forHumans,
    }
    if (msg.kind === 'agreement' && !agreement) return
    const text = agreement ? renderAgreement(agreement) : msg.text
    const human = msg.human === true ? { human: true } : {}
    // 표시 없이 글로만 답이 필요 없다고 적어 보낸 알림도 알아본다(옛 판, 또는 표시를 잊은 AI).
    const notice = msg.kind === 'question' && (msg.noAnswer === true || saysNoAnswer(msg.text))
    const files = this.collect(peer, thread, msg.files)
    thread.messages.push({ id: msg.id, from: 'peer', kind: msg.kind, text, context, agreement, ...human, ...(notice ? { noAnswer: true } : {}), ...(files ? { files } : {}), at: now() })
    // 파일마다 크기와 sha256 이 맞았는지 보낸 쪽에 알린다.
    if (files) void this.sendOrQueue(peer, { type: 'receipt', thread: thread.id, msg: msg.id, files: files.map(f => ({ id: f.id, ok: f.ok === true, problem: f.problem })) }, thread.id).catch(() => {})
    // 이미 마감한 질문에 늦게 온 답은 남기기만 하고, 마감 상태는 그대로 둔다.
    if (thread.status === 'closed' || msg.kind === 'closed') thread.status = 'closed'
    else if (agreement) thread.status = 'agreed'
    // 합의문을 쓴 뒤에 온 알림이나 답(사람이 정한 것 포함)도 남기기만 한다.
    else if (thread.status === 'agreed') {
    } else if (msg.kind === 'note') this.peerAsksHuman(thread, false)
    // 옛 판 상대가 「사람에게 올렸다」고 답 글로만 알렸다. 사람이 정한 답은 아니다.
    else if (msg.kind === 'answer' && !msg.human && defersToHuman(text)) this.peerAsksHuman(thread, true)
    else {
      thread.status = 'your_turn'
      this.peerAnswered(thread)
    }
    if (agreement || thread.status === 'closed') this.peerAnswered(thread)
    const file = agreement ? this.saveAgreement(thread) : undefined
    let ask: AskInfo | AskProgress | undefined = thread.ask
    if (thread.ask && thread.startedBy === 'me') {
      if (msg.kind === 'answer' && thread.ask.answers === 'one' && !this.closedAsks.has(thread.ask.id)) this.closeSiblings(thread.ask, peer.name, thread.id)
      ask = this.askProgress(thread.ask)
    }
    this.emit({ type: 'message', thread: thread.id, from: peer.name, kind: msg.kind, text, context, status: thread.status, ask, agreement, file, ...(files ? { files: files.map(seenFile) } : {}), ...human, ...(notice ? { no_answer_needed: true } : {}), ...(thread.category ? { category: thread.category } : {}), at: now() })
  }

  private peerAsksHuman(thread: Thread, inText: boolean) {
    // 이미 묻는 중이면 처음 물은 때를 그대로 둔다. 다시 알린다고 기다린 시간이 줄지 않는다.
    if (thread.status !== 'peer_checking_with_their_human' || !thread.humanSince) {
      thread.humanSince = now()
      thread.nudges = 0
      thread.peerWait = undefined
    }
    thread.status = 'peer_checking_with_their_human'
    thread.saidInText = inText || undefined
  }

  private peerAnswered(thread: Thread) {
    thread.humanSince = undefined
    thread.saidInText = undefined
    thread.nudges = undefined
    thread.peerWait = undefined
  }

  // 이 상대와의 대화 가운데 이쪽 사람에게 묻는 중인 것. 상대가 ping 하면 함께 건넨다. 질문 내용은 건네지 않는다.
  private waitingFor(peer: Peer): WaitState[] | undefined {
    const out: WaitState[] = []
    for (const q of this.asking.values()) {
      if (this.threads.get(q.thread)?.peer !== peer.key) continue
      out.push({
        thread: q.thread,
        since: q.at,
        window: q.text ? 'text' : q.closedAt ? 'closed_without_answer' : 'shown',
        reminders: q.reminders ?? 0,
        last_reminder: q.lastReminder,
        closed_at: q.closedAt,
      })
    }
    return out.length ? out : undefined
  }

  // 상대가 알려 준 질문 창 상태를 대화에 붙인다. 이미 답이 와서 묻는 중이 아닌 대화에는 붙이지 않는다.
  private takeWaiting(peer: Peer, waiting: unknown) {
    if (!Array.isArray(waiting)) return
    for (const w of waiting as WaitState[]) {
      if (!w || !isThreadId(w.thread) || typeof w.since !== 'string') continue
      const t = this.threads.get(w.thread)
      if (!t || t.peer !== peer.key || t.status !== 'peer_checking_with_their_human') continue
      const window = ['shown', 'closed_without_answer', 'text'].includes(w.window) ? w.window : 'shown'
      const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 40) : undefined)
      t.peerWait = { thread: t.id, since: str(w.since)!, window, reminders: Number.isInteger(w.reminders) ? w.reminders : 0, last_reminder: str(w.last_reminder), closed_at: str(w.closed_at) }
    }
  }

  // 상대가 자기 사람에게 묻는 중인 대화. 묻는 쪽이 얼마나 기다렸는지, 상대의 창이 어떤지 본다.
  private theirHuman(t: Thread) {
    if (t.status !== 'peer_checking_with_their_human' || !t.humanSince) return undefined
    const w = t.peerWait
    return {
      since: t.humanSince,
      minutes: Math.floor((Date.now() - Date.parse(t.humanSince)) / 60_000),
      window: w
        ? w.window === 'shown'
          ? 'a question window is on their human\'s screen'
          : w.window === 'closed_without_answer'
            ? `their human saw the question window and closed it without answering at ${w.closed_at}; it opens again with the next reminder`
            : 'their app cannot open a question window, so their AI asked their human in text'
        : t.saidInText
          ? 'they only wrote that they passed it to their human (an older coworker version); whether a question window is open is unknown'
          : 'unknown (the other side runs an older coworker version)',
      reminders: w ? w.reminders : undefined,
      last_reminder: w?.last_reminder,
    }
  }

  // 오래 기다리는 대화가 있으면 알린다. 상대에게 창 상태도 1분마다 새로 묻는다.
  private checkWaits() {
    const t0 = Date.now()
    const asking = [...this.threads.values()].filter(t => t.status === 'peer_checking_with_their_human' && t.humanSince)
    if (!asking.length) return
    if (t0 - this.lastWaitPing >= Math.min(60_000, this.opts.nudgeMs)) {
      this.lastWaitPing = t0
      for (const key of new Set(asking.map(t => t.peer))) {
        const peer = this.peers.get(key)
        if (peer) void this.deliver(peer, { type: 'ping' }).then(r => r.type === 'pong' && this.takeWaiting(peer, r.waiting)).catch(() => {})
      }
    }
    for (const t of asking) {
      const waited = t0 - Date.parse(t.humanSince!)
      const due = Math.floor(waited / this.opts.nudgeMs)
      if (due <= (t.nudges ?? 0)) continue
      t.nudges = due
      const slow: Extract<BridgeEvent, { type: 'peer_human_slow' }> = {
        type: 'peer_human_slow',
        thread: t.id,
        peer: t.peerName,
        subject: t.subject,
        since: t.humanSince!,
        minutes: Math.floor(waited / 60_000),
        their_window: t.peerWait,
        said_in_text: t.saidInText,
        at: now(),
      }
      this.emit(slow)
      this.onSlow?.(slow)
    }
  }

  private emit(event: BridgeEvent) {
    this.events.push(event)
    for (const wake of [...this.waiters]) wake()
    this.onEvent?.()
    this.changed()
  }

  // 바뀐 것을 들을 함수를 건다. 돌려준 함수를 부르면 그만 듣는다.
  watch(onChange: () => void) {
    this.watchers.add(onChange)
    return () => void this.watchers.delete(onChange)
  }

  // 이쪽 사람에게 질문 창을 띄웠다. 사람이 답하거나 창을 닫을 때까지 남긴다(시간으로 지우지 않는다).
  waitForHuman(question: HumanQuestion) {
    this.asking.set(question.thread, question)
    this.dirty()
  }

  humanQuestions() {
    return [...this.asking.values()]
  }

  // 사람이 질문 창에 답했다(또는 대화 글로 답해 AI가 보냈다). 그 대화의 질문은 끝났다.
  humanDone(thread: string) {
    if (this.asking.delete(thread)) this.dirty()
  }

  // 사람에게 다시 알렸다. 묻는 쪽이 몇 번 알렸는지 볼 수 있게 센다.
  remindedHuman(thread: string) {
    const q = this.asking.get(thread)
    if (!q) return undefined
    q.reminders = (q.reminders ?? 0) + 1
    q.lastReminder = now()
    this.dirty()
    return q
  }

  // 사람이 창을 봤지만 답하지 않고 닫았다. 질문은 남기고, 다음 알림 때 창을 다시 띄운다. undefined 면 창을 다시 띄웠다.
  humanClosedWindow(thread: string, closed: boolean) {
    const q = this.asking.get(thread)
    if (!q) return
    q.closedAt = closed ? now() : undefined
    this.dirty()
  }

  // 이 세션 안에서 생긴 일(사람이 질문 창에 답함)을 AI에게 알린다.
  tell(event: Extract<BridgeEvent, { type: 'decision' }>) {
    this.emit(event)
  }

  // 대화 보기 화면이 연 주소. 보기 화면이 열릴 때 알려 주고, 다시 켤 때 그 주소로 다시 연다.
  get viewerAt(): ViewerAddress | undefined {
    return this.viewerAddress
  }

  set viewerAt(at: ViewerAddress | undefined) {
    if (at?.port === this.viewerAddress?.port && at?.token === this.viewerAddress?.token) return
    this.viewerAddress = at
    this.dirty()
  }

  private changed() {
    this.dirty()
    for (const onChange of [...this.watchers]) onChange()
  }

  // 바뀐 것을 조금 모았다가 한 번에 저장한다.
  private dirty() {
    if (!this.opts.saveTo || this.saveTimer || !this.server) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      this.save()
    }, 100)
    this.saveTimer.unref?.()
  }

  private save() {
    const path = this.opts.saveTo
    if (!path || !this.server) return
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const tmp = `${path}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(this.snapshot()), { mode: 0o600 })
      renameSync(tmp, path)
    } catch {}
  }

  // 코드는 한 세션만 들어오게 한 번 쓰면 끝난다. 다만 그 코드로 들어왔던 바로 그 세션(같은 키)이 다시 들고 오면 받아 준다.
  // 이쪽이 그 세션을 잊었어도(예전 판이 지웠거나 상태를 잃었다) 새 코드 없이 다시 이어진다.
  private takeToken(token: unknown, from: string) {
    if (typeof token !== 'string') return undefined
    const used = this.used.get(token)
    if (used) return used.key === from ? { expires: Infinity, private: used.private, again: true } : undefined
    const entry = this.tokens.get(token)
    this.tokens.delete(token)
    this.dirty()
    if (!entry || entry.expires <= Date.now()) return undefined
    this.used.set(token, { key: from, private: entry.private })
    this.trimUsed()
    return entry
  }

  // 기억해 둔 토큰이 너무 많으면 오래된 것부터 지운다. 지금 이어진 상대의 토큰은 지우지 않는다.
  private trimUsed() {
    for (const [token, u] of this.used) {
      if (this.used.size <= MAX_USED) return
      if (!this.peers.has(u.key)) this.used.delete(token)
    }
  }

  // 들어오지 못할 까닭. 토큰을 쓰기 전에 보고, 기록에만 쓴다. 들어올 수 있으면 undefined.
  private whyRefused(token: unknown, from: string) {
    if (!isToken(token)) return 'it brought no code: this side does not know it (it may have lost its saved state, or joined before 0.7.0)'
    const used = this.used.get(token)
    if (used) return used.key === from ? undefined : 'that code was already used by another session'
    const entry = this.tokens.get(token)
    if (entry) return entry.expires <= Date.now() ? 'the code has expired' : undefined
    return 'unknown code: it was never issued here, or this side was closed by its human and forgot it'
  }

  // 상대가 이쪽을 잊었다가 다시 들어올 때 들 토큰. 상대 키에만 쓰인다. 한 상대에 하나만 만들어 두고 다시 준다.
  private rejoinFor(peer: Peer) {
    if (peer.given && this.used.get(peer.given)?.key === peer.key) return peer.given
    const token = randomToken()
    this.used.set(token, { key: peer.key, private: !!peer.private })
    peer.given = token
    this.trimUsed()
    this.dirty()
    return token
  }

  // 이어지지 못한 상대에게 건넨 토큰은 지운다.
  private forgetGiven(peer: Peer) {
    if (peer.given && !this.peers.has(peer.key)) this.used.delete(peer.given)
    peer.given = undefined
  }

  // 끊긴 순간과, 실패한 까닭이 바뀐 때만 기록한다. 같은 까닭으로 다시 실패한 것은 횟수만 센다.
  private noteDown(peer: Peer) {
    const err = peer.lastError
    // 막 이어진 직후에는 상대가 아직 이쪽을 등록하지 않아 「모른다」고 할 수 있다. 끊긴 것이 아니므로 적지 않는다.
    if (err?.kind === 'not_recognized' && Date.now() - (this.addedAt.get(peer.key) ?? 0) < 5000) return
    const what = `${err?.kind}|${err?.detail}`
    const down = this.down.get(peer.key)
    if (!down || down.what !== what)
      this.log.write(down ? 'still_down' : 'link_down', {
        id: peerId(peer.key),
        peer: peer.name,
        kind: err?.kind,
        detail: err?.detail,
        addr: err?.addr,
        tried: [...new Set([...(peer.lastAddr ? [peer.lastAddr] : []), ...peer.addrs])],
        port: peer.port,
        tries: down?.tries,
        last_seen: isoOf(peer.lastSeen),
      })
    this.down.set(peer.key, { since: down?.since ?? Date.now(), tries: (down?.tries ?? 0) + 1, what })
  }

  // 다시 닿았다. 얼마나 끊겨 있었는지 기록한다.
  private noteUp(peer: Peer, addr: string) {
    const down = this.down.get(peer.key)
    if (!down) return
    this.down.delete(peer.key)
    this.log.write('link_up', { id: peerId(peer.key), peer: peer.name, down_for_s: Math.round((Date.now() - down.since) / 1000), tries: down.tries, addr: isRelayAddr(addr) ? 'relay' : addr })
  }

  // 상대가 이쪽을 모른다고 했다. 건네받은 토큰을 들고 다시 들어간다. 보내기마다 부르므로 retryMs 에 한 번만 해 본다.
  private async rejoin(peer: Peer) {
    const last = this.rejoinTried.get(peer.key) ?? 0
    if (Date.now() - last < this.opts.retryMs) return
    this.rejoinTried.set(peer.key, Date.now())
    const id = peerId(peer.key)
    if (!peer.token) {
      // 0.7.0 전에 맺은 연결에서 코드를 준 쪽은 토큰이 없다. 상대가 코드를 다시 넣거나 새 코드로 이어야 한다.
      if (!last) this.log.write('cannot_rejoin', { id, peer: peer.name, why: 'the other side forgot this session, and this side holds no token for it (connected before 0.7.0). The other side can put in this side\'s code again, or use a new code' })
      return
    }
    try {
      const reply = await this.sayHello(peer, { token: peer.token })
      if (reply.type === 'hello_ack') {
        // 막 이어진 직후의 엇갈림은 적지 않는다.
        if (Date.now() - (this.addedAt.get(peer.key) ?? 0) >= 5000) this.log.write('rejoined', { id, peer: peer.name })
        void this.flush()
      }
    } catch {
      if (!last) this.log.write('rejoin_failed', { id, peer: peer.name, kind: peer.lastError?.kind, detail: peer.lastError?.detail })
    }
  }

  // 인사한다. 상대가 이쪽을 잊으면 들고 올 토큰을 함께 건네고, 상대가 건넨 토큰은 받아 둔다.
  private async sayHello(peer: Peer, extra: { token?: string; back?: boolean } = {}) {
    const reply = await this.deliver(peer, { type: 'hello', name: this.name, addrs: this.addrs(), port: this.port, rejoin: this.rejoinFor(peer), about: this.about, can: CAN, ...extra })
    if (reply.type === 'hello_ack') this.learn(peer, reply.about, reply.can)
    if (reply.type === 'hello_ack' && isToken(reply.rejoin)) {
      peer.token = reply.rejoin
      if (this.peers.has(peer.key)) this.dirty()
    }
    return reply
  }

  // 상대가 인사에 적어 보낸 자기 소개를 기억한다. 달라졌으면 화면에도 알린다.
  private learn(peer: Peer, about: unknown, can?: unknown) {
    const next = cleanAbout(about), skills = cleanCan(can)
    if (JSON.stringify(next) === JSON.stringify(peer.about) && JSON.stringify(skills) === JSON.stringify(peer.can)) return
    peer.about = next
    peer.can = skills
    if (this.peers.has(peer.key)) this.changed()
  }

  // 이 세션의 소개를 정한다. 준 것만 바꾸고, 달라졌으면 이어진 세션에 다시 인사해서 알린다.
  setAbout(about: About) {
    const next = cleanAbout({ ...this.about, ...about })
    if (JSON.stringify(next) === JSON.stringify(this.about)) return
    this.about = next
    this.changed()
    for (const peer of this.peers.values()) void this.sayHello(peer).catch(() => {})
  }

  // 사람이 화면에서 대화를 맨 위에 고정하거나 푼다. 이 PC에만 남기고 상대에게는 알리지 않는다.
  // 여럿에게 보낸 질문은 화면에서 한 방이므로 대화 여러 개가 한 번에 온다. 바뀐 대화 수를 돌려준다.
  pin(ids: string[], pinned: boolean) {
    let changed = 0
    for (const id of new Set(ids)) {
      const t = this.threads.get(id)
      if (!t || !!t.pinned === pinned) continue
      if (pinned) t.pinned = true
      else delete t.pinned
      changed++
    }
    if (changed) this.changed()
    return changed
  }

  // 파일을 두는 자리. 보내려고 둔 사본(out), 받는 중인 조각(partial), 받은 파일(received). 세션마다 따로다.
  private filesDir(kind: 'out' | 'partial' | 'received') {
    if (!this.opts.home) return undefined
    const root = pathInside(this.opts.home, 'files')
    const mine = root ? pathInside(root, this.route) : undefined
    return mine ? pathInside(mine, kind) : undefined
  }

  // 파일을 받을 줄 아는 상대인지 본다. 모르면 한 번 물어본다(상대가 그사이 새 판으로 올렸을 수 있다).
  private async assertTakesFiles(peers: Peer[]) {
    for (const peer of peers) {
      if (peer.can?.includes('files')) continue
      try {
        const pong = await this.deliver(peer, { type: 'ping' })
        if (pong.type === 'pong') this.learn(peer, peer.about, pong.can)
      } catch {}
      if (!peer.can?.includes('files'))
        throw new Error(`nothing was sent: ${peer.name} cannot receive files. It runs a coworker version older than 0.12.0, or it has not answered since it was updated. Ask its human to update coworker and try again, or send the content another way`)
    }
  }

  // 보낼 파일을 확인하고 이 세션의 보낼 자리에 사본을 둔다. 사본이 있어서, 상대가 꺼져 있다가 돌아와도 처음 확인한 그 내용이 간다.
  private stage(paths: string[] | undefined, reviewed = false): FileNote[] {
    if (!paths?.length) return []
    const dir = this.filesDir('out')
    if (!dir) throw new Error('nothing was sent: this session has no folder to keep files in')
    const unique = [...new Set(paths)]
    if (unique.length > MAX_FILES) throw new Error(`nothing was sent: one message takes at most ${MAX_FILES} files`)
    const read = unique.map(path => {
      const name = basename(path)
      if (SECRET_FILE.test(name)) throw new Error(`nothing was sent: ${name} looks like a file that holds keys or passwords. Humans share secrets their own way, never through coworker`)
      let bytes: Buffer
      try {
        const stat = statSync(path)
        if (!stat.isFile()) throw new Error('not a file')
        if (stat.size > MAX_FILE_BYTES) throw new RangeError()
        bytes = readFileSync(path)
      } catch (e) {
        if (e instanceof RangeError) throw new Error(`nothing was sent: ${name} is larger than ${MAX_FILE_BYTES >> 20} MiB, the most one file can be`)
        throw new Error(`nothing was sent: cannot read the file ${path}. Give the full path of a file on this PC`)
      }
      if (bytes.length > MAX_FILE_BYTES) throw new Error(`nothing was sent: ${name} is larger than ${MAX_FILE_BYTES >> 20} MiB, the most one file can be`)
      return { path, name: safeFileName(name), bytes }
    })
    if (read.reduce((n, f) => n + f.bytes.length, 0) > MAX_FILES_BYTES) throw new Error(`nothing was sent: the files are larger than ${MAX_FILES_BYTES >> 20} MiB together, the most one message can carry`)
    // 글로 된 파일은 글과 같은 눈으로 본다. 0 바이트가 섞였거나 2 MiB 를 넘으면 글로 보지 않는다.
    const texts: Record<string, string> = {}
    for (const f of read) if (f.bytes.length <= 2 * 1024 * 1024 && !f.bytes.subarray(0, 8192).includes(0)) texts[`the file ${f.name}`] = f.bytes.toString('utf8')
    const found = findSecrets(texts)
    const list = (items: Found[]) => [...new Set(items.map(f => `${f.kind} in ${f.field} ("${f.preview}")`))].slice(0, 12).join(', ')
    // 모양이 정해진 열쇠와 토큰은 사람이 뭐라 해도 보내지 않는다.
    const sure = found.filter(f => f.kind !== 'password or secret')
    if (sure.length) throw new Error(`nothing was sent: a file contains a secret (${list(sure)}). Humans share secrets their own way, never through coworker`)
    // 「password = 값」 꼴은 스크립트와 설정 파일에 흔하다. 진짜 비밀값이 아닐 때가 많아서, 사람이 보고 아니라고 하면 보낸다.
    const maybe = found.filter(f => f.kind === 'password or secret')
    if (maybe.length && !reviewed)
      throw new Error(
        `nothing was sent: a file may contain a password or secret (${list(maybe)}). Scripts and settings files often look like this without holding a real secret. Show these places to your human. If your human says none of them is a real secret, send again with files_reviewed_by_human: true`,
      )
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return read.map(f => {
      const id = randomUUID()
      const file = pathInside(dir, id)
      if (!file) throw new Error('nothing was sent: this session has no folder to keep files in')
      writeFileSync(file, f.bytes, { mode: 0o600 })
      return { id, name: f.name, size: f.bytes.length, sha256: createHash('sha256').update(f.bytes).digest('hex'), path: f.path }
    })
  }

  // 파일 조각을 먼저 보내고 글을 뒤에 보낸다. 한 줄에 순서대로 서므로, 글이 닿을 때는 파일이 이미 가 있다.
  private async sendMessage(peer: Peer, msg: WireMessage, thread: string) {
    let queued = false
    for (const f of msg.files ?? []) {
      const of = Math.max(1, Math.ceil(f.size / FILE_CHUNK))
      for (let seq = 0; seq < of; seq++) if ((await this.sendOrQueue(peer, { type: 'file', id: f.id, seq, of, size: f.size }, thread, !queued)) === 'queued') queued = true
    }
    return this.sendOrQueue(peer, { type: 'msg', msg }, thread, !queued)
  }

  // 줄에 서 있는 파일 조각에는 내용이 없다. 보낼 때 사본에서 그 조각을 읽어 붙인다.
  private withData(payload: Payload): Payload {
    if (payload.type !== 'file' || payload.data !== undefined) return payload
    const dir = this.filesDir('out')
    const file = dir && typeof payload.id === 'string' && FILE_ID.test(payload.id) ? pathInside(dir, payload.id) : undefined
    let data = ''
    if (file)
      try {
        const fd = openSync(file, 'r')
        try {
          const buf = Buffer.alloc(FILE_CHUNK)
          data = buf.subarray(0, readSync(fd, buf, 0, FILE_CHUNK, payload.seq * FILE_CHUNK)).toString('base64')
        } finally {
          closeSync(fd)
        }
      } catch {}
    return { ...payload, data }
  }

  // 글이 상대에게 넘어갔거나 버려졌으면, 그 글에 붙여 보내려고 둔 사본을 지운다.
  private unspool(payload: Payload) {
    if (payload.type !== 'msg' || !payload.msg.files?.length) return
    const dir = this.filesDir('out')
    if (!dir) return
    for (const f of payload.msg.files) {
      if (typeof f?.id !== 'string' || !FILE_ID.test(f.id)) continue
      const file = pathInside(dir, f.id)
      if (file) rmSync(file, { force: true })
    }
  }

  private dropStagedChunks(peer: Peer, sent: unknown) {
    if (!Array.isArray(sent) || !sent.length) return
    const partial = this.filesDir('partial')
    if (!partial) return
    for (const f of sent.slice(0, MAX_FILES) as Array<Partial<WireFile> | null>) {
      if (!f || typeof f.id !== 'string' || !FILE_ID.test(f.id)) continue
      const file = pathInside(partial, `${peerId(peer.key)}-${f.id}`)
      if (file) rmSync(file, { force: true })
    }
  }

  // 파일 조각을 받아 이어 붙인다. 조각마다 자리가 정해져 있어서, 같은 조각이 다시 와도 한 번만 붙는다.
  // 받다 만 것이 얼마나 있는지는 파일 크기로 안다. 그래서 이 세션이 다시 켜져도 이어서 받는다.
  private takeChunk(peer: Peer, p: Extract<Payload, { type: 'file' }>) {
    const dir = this.filesDir('partial')
    if (!dir || typeof p.id !== 'string' || !FILE_ID.test(p.id) || typeof p.data !== 'string') return
    if (!Number.isInteger(p.size) || p.size < 0 || p.size > MAX_FILE_BYTES) return
    const of = Math.max(1, Math.ceil(p.size / FILE_CHUNK))
    if (!Number.isInteger(p.seq) || p.seq < 0 || p.seq >= of || p.of !== of) return
    const bytes = Buffer.from(p.data, 'base64')
    // 마지막 조각만 짧다. 길이가 다르면 받지 않는다.
    if (bytes.length !== (p.seq < of - 1 ? FILE_CHUNK : p.size - FILE_CHUNK * (of - 1))) return
    const prefix = `${peerId(peer.key)}-`, path = pathInside(dir, prefix + p.id)
    if (!path) return
    try {
      if (p.seq === 0) {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        // 한 상대가 받다 만 조각을 끝없이 쌓지 못하게 한다. 하루 넘게 묵은 것은 치운다.
        const mine = readdirSync(dir).filter(n => n.startsWith(prefix))
        for (const n of mine) {
          const old = pathInside(dir, n)
          if (old && Date.now() - statSync(old).mtimeMs > 24 * 60 * 60_000) rmSync(old, { force: true })
        }
        if (!existsSync(path) && readdirSync(dir).filter(n => n.startsWith(prefix)).length >= MAX_FILES * 2) return
        writeFileSync(path, bytes, { mode: 0o600 })
      } else if (existsSync(path) && statSync(path).size === p.seq * FILE_CHUNK) appendFileSync(path, bytes)
    } catch {}
  }

  // 글에 붙어 온 파일을 확인하고 받은 자리로 옮긴다. 크기와 sha256 이 보낸 쪽이 적은 것과 같아야 받은 것으로 친다.
  // 아니면 받다 만 것을 지우고 까닭을 적는다. 상대가 적어 보낸 이름과 대화 번호는 폴더 이름으로 쓰기 전에 다듬는다.
  private collect(peer: Peer, thread: Thread, sent: unknown): FileNote[] | undefined {
    if (!Array.isArray(sent) || !sent.length) return undefined
    const partial = this.filesDir('partial'), received = this.filesDir('received')
    let total = 0
    const notes = sent.slice(0, MAX_FILES).flatMap((f: Partial<WireFile> | null): FileNote[] => {
      if (!f || typeof f.id !== 'string' || !FILE_ID.test(f.id) || typeof f.name !== 'string' || !Number.isInteger(f.size) || f.size! < 0 || typeof f.sha256 !== 'string' || !SHA256.test(f.sha256)) return []
      const note: FileNote = { id: f.id, name: safeFileName(f.name), size: f.size!, sha256: f.sha256 }
      const from = partial ? pathInside(partial, `${peerId(peer.key)}-${f.id}`) : undefined
      const fail = (problem: FileProblem): FileNote[] => {
        if (from) rmSync(from, { force: true })
        return [{ ...note, ok: false, problem }]
      }
      if (!from || !received || !isThreadId(thread.id)) return fail('no_folder')
      total += note.size
      if (note.size > MAX_FILE_BYTES || total > MAX_FILES_BYTES) return fail('limit')
      let size = -1
      try {
        size = statSync(from).size
      } catch {}
      if (size < note.size) return fail('incomplete')
      if (size > note.size) return fail('size')
      try {
        if (createHash('sha256').update(readFileSync(from)).digest('hex') !== note.sha256) return fail('sha256')
        const folder = pathInside(received, thread.id)
        if (!folder) return fail('no_folder')
        mkdirSync(folder, { recursive: true, mode: 0o700 })
        const to = freePath(folder, note.name)
        if (!to) return fail('no_folder')
        renameSync(from, to)
        chmodSync(to, 0o600)
        return [{ ...note, name: basename(to), path: to, ok: true }]
      } catch {
        return fail('no_folder')
      }
    })
    return notes.length ? notes : undefined
  }

  // 보낸 파일을 상대가 받아서 확인한 결과. 대화 기록에 적고, 온전히 가지 못한 것이 있으면 AI에게 알린다.
  private takeReceipt(peer: Peer, r: Extract<Payload, { type: 'receipt' }>) {
    const thread = isThreadId(r.thread) ? this.threads.get(r.thread) : undefined
    if (!thread || thread.peer !== peer.key || !Array.isArray(r.files)) return
    const message = thread.messages.find(m => m.id === r.msg && m.from === 'me')
    if (!message?.files) return
    const failed: string[] = []
    for (const got of r.files) {
      const note = message.files.find(f => f.id === got?.id)
      if (!note || note.ok !== undefined) continue
      note.ok = got.ok === true
      if (note.ok) continue
      note.problem = typeof got.problem === 'string' && got.problem in FILE_PROBLEM ? (got.problem as FileProblem) : 'incomplete'
      failed.push(`${note.name} (${FILE_PROBLEM[note.problem]})`)
    }
    this.changed()
    if (failed.length) this.emit({ type: 'undelivered', to: peer.name, thread: thread.id, reason: `the message arrived, but these files did not arrive intact: ${failed.join(', ')}. Send them again`, at: now() })
  }

  // 이 PC 쪽 일을 기록한다: 잠들었다 깸(시계가 비었다), 주소가 바뀜(다른 네트워크로 옮김).
  private watchThisPc() {
    clearInterval(this.ticker)
    let last = Date.now()
    let addrs = this.opts.addrs().join()
    let n = 0
    this.ticker = setInterval(() => {
      this.checkWaits()
      const t = Date.now()
      if (t - last > PAUSE_MS) this.log.write('this_pc_paused', { for_s: Math.round((t - last) / 1000), what: 'this computer was asleep or stopped; nothing could get through meanwhile' })
      last = t
      // 주소 찾기는 명령을 부르므로 30초에 한 번만 본다.
      if (++n % 6 === 0) {
        const now = this.opts.addrs().join()
        if (now !== addrs) this.log.write('this_pc_moved', { from: addrs.split(','), to: now.split(',') })
        addrs = now
      }
    }, this.opts.tickMs)
    this.ticker.unref?.()
  }

  // 연결 기록. 상대를 주면 그 상대에 관한 줄만 준다. other 면, 닿는 상대에게도 이쪽에 관한 줄을 달라고 한다.
  async logs(options: { peer?: string; lines?: number; other?: boolean } = {}) {
    const lines = Math.min(Math.max(options.lines ?? 100, 1), MAX_LOG_LINES)
    const peer = options.peer ? await this.resolvePeer(options.peer) : undefined
    const mine = this.log.read({ id: peer && peerId(peer.key), lines })
    if (!options.other) return { file: this.log.path, mine }
    const targets = peer ? [peer] : [...this.peers.values()]
    const theirs = await Promise.all(
      targets.map(async p => {
        try {
          const reply = await this.deliver(p, { type: 'log_request', lines })
          if (reply.type === 'log' && Array.isArray(reply.entries)) return { peer: labelOf(p), entries: reply.entries.slice(-lines) }
          return { peer: labelOf(p), error: 'its answer could not be read' }
        } catch {
          return { peer: labelOf(p), error: 'could not get its log: it cannot be reached now, or it runs a coworker older than 0.7.0. Its human can open its log file instead (list_connections there shows the path)' }
        }
      }),
    )
    return { file: this.log.path, mine, theirs }
  }

  private async resolvePeers(to?: string | string[]): Promise<Peer[]> {
    const names = (Array.isArray(to) ? to : to === undefined ? [] : [to]).map(n => n.trim()).filter(Boolean)
    if (names.some(n => EVERYONE.includes(n.toLowerCase()))) {
      if (this.peers.size === 0) throw new Error(NO_PEERS)
      return this.withoutLeftBehind([...this.peers.values()])
    }
    if (names.length === 0) return [await this.resolvePeer(undefined)]
    return [...new Set(await Promise.all(names.map(n => this.resolvePeer(n))))]
  }

  // 받는 사람을 이름(일부여도 된다)이나 [ID]로 찾는다.
  // 상대가 세션을 새로 켜고 새 코드로 다시 붙으면, 옛 연결과 새 연결이 같은 이름으로 함께 남는다.
  // 그때 이름은 지금 닿는 쪽을 가리킨다. 둘 다 닿지 않으면 나중에 붙은 쪽이다. 둘 다 닿으면 ID로 고르게 한다.
  private async resolvePeer(to?: string): Promise<Peer> {
    const peers = [...this.peers.values()]
    if (peers.length === 0) throw new Error(NO_PEERS)
    if (!to) {
      if (peers.length === 1) return peers[0]!
      throw new Error(`several sessions are connected; say which one, several, or "everyone": ${peers.map(labelOf).join(', ')}`)
    }
    const wanted = to.trim()
    const byId = peers.find(p => wanted === peerId(p.key) || wanted.endsWith(`[${peerId(p.key)}]`))
    if (byId) return byId
    const needle = wanted.toLowerCase()
    const exact = peers.filter(p => p.name.toLowerCase() === needle)
    const matches = exact.length ? exact : peers.filter(p => p.name.toLowerCase().includes(needle))
    if (matches.length === 1) return matches[0]!
    if (matches.length === 0) throw new Error(`no connected session matches "${to}". Connected: ${peers.map(labelOf).join(', ')}`)
    if (new Set(matches.map(p => p.name)).size > 1) throw new Error(`"${to}" matches more than one session: ${matches.map(labelOf).join(', ')}`)
    const live = await this.likelyLive(matches)
    if (live.length === 1) return live[0]!
    throw new Error(`"${to}" matches more than one session that can be reached now: ${live.map(labelOf).join(', ')}. Say which one by the id in brackets`)
  }

  // 이름이 같은 세션이 여럿이면 살아 있을 만한 것만 남긴다.
  private async withoutLeftBehind(peers: Peer[]) {
    const byName = new Map<string, Peer[]>()
    for (const p of peers) byName.set(p.name, [...(byName.get(p.name) ?? []), p])
    const keep = new Set<Peer>()
    for (const same of byName.values()) for (const p of same.length === 1 ? same : await this.likelyLive(same)) keep.add(p)
    return peers.filter(p => keep.has(p))
  }

  // 이름이 같은 세션 가운데 살아 있을 만한 것. 바로 닿는 것이 있으면 그것들(여럿이면 모두)이다.
  // 바로 닿는 것이 없으면, 이쪽에 와서 가져가는 것 가운데 나중에 붙은 하나, 그것도 없으면 나중에 붙은 하나다.
  // 막 꺼진 옛 세션도 1분 동안은 가져가던 흔적이 남아서, 가져가기만으로는 둘을 가리지 않는다.
  private async likelyLive(same: Peer[]) {
    const scores = await Promise.all(
      same.map(async p => {
        try {
          if ((await this.deliver(p, { type: 'ping' })).type === 'pong') return 2
        } catch {}
        return this.isPulling(p) ? 1 : 0
      }),
    )
    const best = Math.max(...scores)
    const top = same.filter((_, i) => scores[i] === best)
    return best === 2 ? top : [top.at(-1)!]
  }

  // 주소를 앞에서부터 하나씩 시도한다. 상대 키로 봉인된 답이 와야 닿은 것으로 본다.
  private async deliver(peer: Peer, payload: Payload): Promise<Payload> {
    const body = JSON.stringify(seal(this.withData(payload), fromB64(peer.key), this.keys))
    const addrs = [...new Set([...(peer.lastAddr ? [peer.lastAddr] : []), ...peer.addrs])]
    let refused = false
    for (const addr of addrs) {
      const reply = await this.deliverTo(peer, addr, body, this.opts.connectTimeoutMs)
      if (reply === 'refused') refused = true
      if (!reply || reply === 'refused') continue
      peer.lastAddr = addr
      return reply
    }
    if (refused) throw new DeliveryError('rejected', `${peer.name} refused the message`)
    throw new DeliveryError('unreachable', `${peer.name} is not reachable right now`)
  }

  // 한 주소로 보낸다. 닿지 못하면 그 까닭을 상대 기록에 남기고, 닿으면 마지막으로 본 때를 새로 적는다.
  private async deliverTo(peer: Peer, addr: string, body: string, timeoutMs: number): Promise<Payload | 'refused' | null> {
    const relayed = isRelayAddr(addr)
    const url = relayed ? addr : `http://${hostForUrl(addr)}:${peer.port}/v1/${routeId(peer.key)}`
    const failed = (kind: LinkError, detail?: string) => {
      if (!this.abort.signal.aborted) peer.lastError = { kind, at: Date.now(), detail, addr: relayed ? 'relay' : addr }
      return null
    }
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.any([AbortSignal.timeout(relayed ? Math.max(timeoutMs, this.opts.relayTimeoutMs) : timeoutMs), this.abort.signal]),
      })
    } catch (e) {
      return failed(linkErrorOf(e), detailOf(e))
    }
    if (res.status === 403) return (failed('not_recognized', 'HTTP 403'), 'refused')
    // 409: 같은 봉투가 다시 왔거나(다른 주소로 다시 보낸 것) 두 PC의 시계가 너무 다르다.
    if (res.status === 409) {
      const stale = (await res.text().catch(() => '')).startsWith('stale')
      if (stale) this.clockDiffers(peer.key)
      return failed(stale ? 'clock' : 'bad_answer', stale ? 'HTTP 409 stale' : 'HTTP 409')
    }
    if (!res.ok) return failed('bad_answer', `HTTP ${res.status}`)
    const sealed = (await res.json().catch(() => null)) as Sealed | null
    if (sealed?.from !== peer.key) return failed('bad_answer')
    const reply = open(sealed, this.keys) as Payload | null
    if (!reply) return failed('bad_answer')
    const fresh = this.replay.check(sealed, reply)
    if (fresh === 'stale') this.clockDiffers(peer.key)
    if (fresh !== 'ok') return failed(fresh === 'stale' ? 'clock' : 'bad_answer')
    peer.lastSeen = Date.now()
    peer.lastError = undefined
    this.noteUp(peer, addr)
    this.wakeRetry(peer.key)
    return reply
  }

  // 시계가 달라 봉투를 주고받지 못했다. 이어진 상대면 사람에게 알린다. 연결하는 중이면 연결 오류에서 알린다.
  private clockDiffers(key: string) {
    const last = this.clockOff.get(key)
    this.clockOff.set(key, Date.now())
    const peer = this.peers.get(key)
    if (peer && (!last || Date.now() - last > 60 * 60_000)) {
      this.log.write('clock_differs', { id: peerId(key), peer: peer.name, what: 'the two clocks differ by more than two hours, so envelopes are refused' })
      this.emit({ type: 'clock', peer: peer.name, fix: CLOCK_FIX, at: now() })
    }
  }

  // patient: 상대가 가져가는 중이면 가져갈 때까지 잠깐 기다려 본다. 파일 조각이 이미 줄에 섰으면 뒤의 것은 기다리지 않고 줄만 세운다.
  private async sendOrQueue(peer: Peer, payload: Payload, thread?: string, patient = true): Promise<'delivered' | 'queued'> {
    // 앞에 밀린 것이 있으면 순서를 지키려고 뒤에 줄 세운다.
    // 바로 못 보내는 상대가 스스로 가져가는 중이면, 바로 보내기는 건너뛴다.
    const skipDirect = peer.directFailed && this.isPulling(peer)
    if (!skipDirect && !this.outbox.some(o => o.peer === peer.key)) {
      try {
        await this.deliver(peer, payload)
        peer.directFailed = false
        this.unspool(payload)
        return 'delivered'
      } catch (e) {
        // 닿지 않거나 상대가 이쪽을 모른다고 해도 버리지 않는다. 줄에 세워 두고, 다시 붙으면 순서대로 보낸다.
        peer.directFailed = true
        if (e instanceof DeliveryError && e.reason === 'rejected') void this.rejoin(peer)
      }
    }
    if (this.isPulling(peer) && patient) return (await this.handOver(peer, payload, 3000, thread)) ? 'delivered' : 'queued'
    this.outbox.push({ id: randomUUID(), peer: peer.key, payload, thread, since: Date.now() })
    this.dirty()
    this.wakePoll(peer.key)
    return 'queued'
  }

  private async flush() {
    if (this.flushing || this.outbox.length === 0) return
    this.flushing = true
    try {
      const blocked = new Set<string>()
      for (const item of [...this.outbox]) {
        if (blocked.has(item.peer)) continue
        const peer = this.peers.get(item.peer)
        const drop = (reason: string) => {
          this.log.write('undelivered', { id: peerId(item.peer), reason })
          this.unspool(item.payload)
          this.outbox = this.outbox.filter(o => o !== item)
          this.emit({ type: 'undelivered', to: peer?.name ?? 'disconnected session', thread: item.thread, reason, at: now() })
        }
        if (!peer) {
          drop('the other side\'s human closed the connection')
          continue
        }
        // 다시 붙기를 기다리는 동안은 건너뛴다. 다시 붙는 순간 순서대로 보낸다.
        if (peer.retryAt && peer.retryAt > Date.now()) {
          blocked.add(item.peer)
          continue
        }
        try {
          await this.deliver(peer, item.payload)
          this.unspool(item.payload)
          this.outbox = this.outbox.filter(o => o !== item)
          this.dirty()
        } catch (e) {
          // 거절당해도 버리지 않는다. 다시 들어가 보고, 상대가 이쪽을 다시 알아보면 그때 간다.
          blocked.add(item.peer)
          if (e instanceof DeliveryError && e.reason === 'rejected') void this.rejoin(peer)
        }
      }
    } finally {
      this.flushing = false
    }
  }

  // 합의문 파일. 대화마다 하나이고, 양쪽이 쓴 마지막 판과 대화 기록을 담는다. 세션이 끝나도 남는다.
  private saveAgreement(thread: Thread): string | undefined {
    if (!this.opts.home || !isThreadId(thread.id)) return undefined
    const dir = pathInside(this.opts.home, 'agreements')
    if (!dir) return undefined
    const started = thread.messages[0]?.at ?? now()
    const name = agreementFileName(started, thread.id, thread.peer)
    const path = name ? pathInside(dir, name) : undefined
    if (!path) return undefined
    const latest = new Map<string, ThreadMessage>()
    for (const m of thread.messages) if (m.agreement) latest.set(m.agreement.by, m)
    const who = (m: ThreadMessage) => (m.from === 'me' ? `${this.name} → ${thread.peerName}` : `${thread.peerName} → ${this.name}`)
    const label: Record<MessageKind, string> = { question: '질문', answer: '답', note: '알림', closed: '마감', agreement: '합의문' }
    const versions = [...latest.values()].map(m => `# 합의문 · ${m.agreement!.by} 작성 (${m.at})\n\n${m.text}`)
    const log = thread.messages
      .filter(m => m.kind !== 'agreement')
      .map(m => `### ${label[m.kind]} · ${who(m)} · ${m.at}\n\n${m.text}${m.context ? `\n\n배경:\n\n${m.context}` : ''}`)
    const text = [
      `# 합의문: ${thread.subject}`,
      `- 대화: ${thread.id}\n- 사이: ${this.name} ↔ ${thread.peerName}${thread.peerAddr ? ` (${thread.peerAddr})` : ''}\n- 시작: ${started}`,
      ...versions,
      `# 대화 기록\n\n${log.join('\n\n')}`,
    ].join('\n\n')
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(path, `${text}\n`, { mode: 0o600 })
      return path
    } catch {
      return undefined
    }
  }

  // 사람이 연결 코드를 다시 보거나 열린 브릿지를 확인할 수 있게 남겨 둔다.
  private statePath() {
    if (!this.opts.home || !Number.isInteger(this.port) || this.port <= 0) return undefined
    const dir = pathInside(this.opts.home, 'bridges')
    return dir ? pathInside(dir, `${this.port}.json`) : undefined
  }

  private writeState() {
    const path = this.statePath()
    if (!path) return
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const state = { name: this.name, port: this.port, pid: process.pid, addrs: this.addrs(), code: this.lastCode, updatedAt: now() }
      writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 })
    } catch {}
  }

  private removeState() {
    const path = this.statePath()
    if (path) rmSync(path, { force: true })
  }
}
