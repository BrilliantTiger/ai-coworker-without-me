import { createHash } from 'node:crypto'

// 연결 코드: 사람이 메신저로 동료에게 넘기는 한 줄.
// 이 세션에 닿는 주소 목록, 포트, 공개키, 한 번만 쓸 수 있는 토큰이 들어 있다.
// 끝의 확인용 글자로, AI나 사람이 옮겨 적다 한 글자라도 틀리면 연결하기 전에 알아챈다.
export type ConnectionCode = {
  v: 1
  name: string
  addrs: string[]
  port: number
  key: string
  token: string
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
    typeof code.token === 'string'
  if (!valid) throw new Error('connection code is damaged; copy the whole line again')
  return code
}
