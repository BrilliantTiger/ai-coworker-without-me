import { createHash } from 'node:crypto'

// 합의문: 대화를 마치고 양쪽 AI가 남기는 정리. 사람은 이걸 놓고 논의한다.
// AI 둘이 서로 맞장구치다 틀린 결론에 합의하지 않게, 확인한 사실(근거와 누가 확인했는지)과 추측을 나눠 적는다.

// checkedBy 는 그 사실을 직접 확인한 세션 이름이다.
export type Fact = { fact: string; evidence: string; checkedBy: string }

export type Agreement = {
  by: string
  conclusion: string
  facts: Fact[]
  guesses: string[]
  disagreements: string[]
  forHumans: string[]
}

const isText = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max
const isList = (v: unknown) => Array.isArray(v) && v.length <= 50 && v.every(s => isText(s, 2000))

export function isAgreement(a: unknown): a is Agreement {
  const v = a as Agreement
  return (
    !!v &&
    isText(v.by, 200) &&
    isText(v.conclusion, 5000) &&
    Array.isArray(v.facts) &&
    v.facts.length <= 50 &&
    v.facts.every(f => !!f && isText(f.fact, 2000) && isText(f.evidence, 2000) && isText(f.checkedBy, 200)) &&
    isList(v.guesses) &&
    isList(v.disagreements) &&
    isList(v.forHumans)
  )
}

const bullets = (items: string[]) => (items.length ? items.map(i => `- ${i}`).join('\n') : '- 없음')

export function renderAgreement(a: Agreement): string {
  const facts = a.facts.length ? a.facts.map(f => `- ${f.fact}\n  - 근거: ${f.evidence}\n  - 확인한 쪽: ${f.checkedBy}`).join('\n') : '- 없음'
  return [
    `## 결론\n\n${a.conclusion}`,
    `## 확인한 사실과 근거\n\n${facts}`,
    `## 추측 (아무도 확인하지 않음)\n\n${bullets(a.guesses)}`,
    `## 의견이 갈린 점\n\n${bullets(a.disagreements)}`,
    `## 사람이 정할 것\n\n${bullets(a.forHumans)}`,
  ].join('\n\n')
}

const THREAD_ID = /^[0-9a-f]{8}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
const BASE64_KEY = /^[A-Za-z0-9+/]+={0,2}$/

// 키는 보통 32바이트를 base64 로 적은 글자다. 그 꼴이 아닌 키 글자(다른 base64 꼴, 군더더기가 낀 것)로도 봉투는 열릴 수 있다.
// 그런 세션의 합의문도 남들처럼 저장되게, 그때는 키 글자 자체를 재료로 쓴다. 어느 쪽이든 파일 이름에는 해시만 들어간다.
function keyBytesOf(key: unknown): Buffer | undefined {
  if (typeof key !== 'string' || !key) return undefined
  if (BASE64_KEY.test(key)) {
    const bytes = Buffer.from(key, 'base64')
    if (bytes.length === 32) return bytes
  }
  return Buffer.from(`key text:${key}`, 'utf8')
}

// 합의문 파일 이름: 날짜, 대화 번호, 이 세션과 상대 공개키(각 32바이트)의 SHA-256 앞 24글자(소문자 16진수).
export function agreementFileName(startedAt: string, threadId: string, ownKey: string, peerKey: string): string | undefined {
  if (typeof threadId !== 'string' || threadId.length !== 8 || !THREAD_ID.test(threadId)) return undefined
  const ownBytes = keyBytesOf(ownKey), peerBytes = keyBytesOf(peerKey)
  if (!ownBytes || !peerBytes) return undefined
  const day = typeof startedAt === 'string' && DAY.test(startedAt.slice(0, 10)) ? startedAt.slice(0, 10) : new Date().toISOString().slice(0, 10)
  const pairHash = createHash('sha256').update(ownBytes).update(peerBytes).digest('hex').slice(0, 24)
  return `${day}-${threadId}-${pairHash}.md`
}
