import nacl from 'tweetnacl'

export type KeyPair = { publicKey: Uint8Array; secretKey: Uint8Array }

// 보낸 쪽 공개키, 일회용 nonce, 암호문. 셋 다 base64.
export type Sealed = { from: string; nonce: string; box: string }

export const newKeyPair = (): KeyPair => nacl.box.keyPair()

export const toB64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
export const fromB64 = (text: string) => new Uint8Array(Buffer.from(text, 'base64'))

export const randomToken = () => Buffer.from(nacl.randomBytes(16)).toString('base64url')

export function seal(payload: unknown, to: Uint8Array, me: KeyPair): Sealed {
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const message = new TextEncoder().encode(JSON.stringify(payload))
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
