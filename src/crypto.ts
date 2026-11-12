import nacl from 'tweetnacl'

export type KeyPair = { publicKey: Uint8Array; secretKey: Uint8Array }

// 보낸 쪽 공개키, 일회용 nonce, 암호문. 셋 다 base64.
export type Sealed = { from: string; nonce: string; box: string }

export const newKeyPair = (): KeyPair => nacl.box.keyPair()

export const toB64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
export const fromB64 = (text: string) => new Uint8Array(Buffer.from(text, 'base64'))

export const randomToken = () => Buffer.from(nacl.randomBytes(16)).toString('base64url')

// 봉인할 때 보낸 시각(t)을 안에 넣는다. 받는 쪽은 이것과 nonce 로 같은 봉투가 다시 오는 것을 막는다.
export function seal(payload: unknown, to: Uint8Array, me: KeyPair): Sealed {
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const stamped = payload && typeof payload === 'object' && !Array.isArray(payload) ? { ...payload, t: Date.now() } : payload
  const message = new TextEncoder().encode(JSON.stringify(stamped))
  return {
    from: toB64(me.publicKey),
    nonce: toB64(nonce),
    box: toB64(nacl.box(message, nonce, to, me.secretKey)),
  }
}

// 열리지 않으면(키가 다르거나 내용이 바뀌었으면) null.
export function open(sealed: unknown, me: KeyPair): unknown | null {
  if (!isSealed(sealed)) return null
  try {
    const from = fromB64(sealed.from)
    const nonce = fromB64(sealed.nonce)
    if (from.length !== nacl.box.publicKeyLength || nonce.length !== nacl.box.nonceLength) return null
    const opened = nacl.box.open(fromB64(sealed.box), nonce, from, me.secretKey)
    return opened ? JSON.parse(new TextDecoder().decode(opened)) : null
  } catch {
    return null
  }
}

export function isSealed(value: unknown): value is Sealed {
  const v = value as Sealed
  return !!v && typeof v.from === 'string' && typeof v.nonce === 'string' && typeof v.box === 'string'
}

// 다시 보낸 봉투 막기. 같은 네트워크에서 엿보던 사람이나 중계 서버가 예전 봉투를 그대로 다시 보내면,
// 열리기는 하지만 이미 받은 것이므로 거절한다(예: 예전의 「연결 끊음」을 다시 보내 연결을 끊는 것).
// 받은 nonce 를 MAX_AGE 동안 기억하고, 그보다 오래됐거나 너무 앞선 시각(t)의 봉투는 받지 않는다.
// t 가 없는 봉투는 예전 판이 보낸 것이다. 시각으로는 거르지 않고 nonce 로만 거른다.
export const REPLAY_MAX_AGE_MS = 2 * 60 * 60_000

export class ReplayGuard {
  private nonces = new Map<string, number>()
  private lastSweep = 0

  constructor(private readonly maxAgeMs = REPLAY_MAX_AGE_MS) {}

  check(sealed: Sealed, opened: unknown, now = Date.now()): 'ok' | 'again' | 'stale' {
    const t = (opened as { t?: unknown } | null)?.t
    if (typeof t === 'number' && Math.abs(now - t) > this.maxAgeMs) return 'stale'
    if (now - this.lastSweep > 60_000) {
      for (const [n, at] of this.nonces) if (now - at > this.maxAgeMs * 2) this.nonces.delete(n)
      this.lastSweep = now
    }
    if (this.nonces.has(sealed.nonce)) return 'again'
    this.nonces.set(sealed.nonce, now)
    return 'ok'
  }
}
