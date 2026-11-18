import { createHash } from 'node:crypto'

// 연결 코드: 사람이 메신저 등으로 상대에게 넘기는 한 줄.
// 동료용(그룹·개인용) 코드에는 이 세션에 닿는 주소 목록, 포트, 공개키, 일회용 토큰이 들어 있고,
// 외부용 코드에는 중계 서버 우편함 주소와 암호화·확인에 필요한 값만 들어 있다(이 PC의 주소와 포트는 넣지 않는다).
// 끝의 확인용 글자로, AI나 사람이 옮겨 적다 한 글자라도 틀리면 연결하기 전에 알아챈다.
export type ConnectionCode = {
  v: 1
  name: string
  addrs: string[]
  port: number
  key: string
  token: string
  // 외부용 코드라는 표시. 이 코드로 들어가는 쪽은 자기 컴퓨터에 관한 것(주소, 포트, 컴퓨터 이름)을 보내지 않는다.
  // 이 표시를 모르는 옛 판(0.12 이하)은 그냥 지나친다.
  outside?: true
}

const PREFIX = 'cw1.'

const check = (body: string) => createHash('sha256').update(body).digest('base64url').slice(0, 8)

export function encodeCode(code: ConnectionCode): string {
  const body = Buffer.from(JSON.stringify(code)).toString('base64url')
  return `${PREFIX}${body}.${check(body)}`
}

export function decodeCode(text: string): ConnectionCode {
  const trimmed = text.trim().replace(/^`+|`+$/g, '')
  if (!trimmed.startsWith(PREFIX)) throw new Error('not a coworker connection code (it should start with "cw1.")')
  // 확인용 글자가 없는 코드는 예전 판이 만든 것이다. 그대로 받는다.
  const [body = '', sum] = trimmed.slice(PREFIX.length).split('.')
  if (sum !== undefined && sum !== check(body))
    throw new Error('connection code was copied wrong: some character differs from the original. Copy the whole line again exactly as the coworker sent it')
  let code: ConnectionCode
  try {
    code = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    throw new Error('connection code is damaged; copy the whole line again')
  }
  const valid =
    code?.v === 1 &&
    typeof code.name === 'string' &&
    Array.isArray(code.addrs) &&
    code.addrs.length > 0 &&
    code.addrs.every(a => typeof a === 'string' && a.length > 0) &&
    Number.isInteger(code.port) &&
    code.port > 0 &&
    code.port < 65536 &&
    typeof code.key === 'string' &&
    typeof code.token === 'string' &&
    (code.outside === undefined || code.outside === true)
  if (!valid) throw new Error('connection code is damaged; copy the whole line again')
  return code
}
