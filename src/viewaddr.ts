import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'

// 대화 보기 주소 설정(COWORKER_VIEWER_ADDRESS, 플러그인 설정의 Viewer address).
// 이 PC의 주인이 자기 다른 기기에서 이 PC에 닿는 주소를 적는다. 셋 가운데 하나다:
//   주소(예: VPN 주소), 이름(이 PC를 가리키는 이름), tailscale(이 PC의 100.64.0.0/10 주소를 스스로 찾는다).
// 정하면 대화 보기 화면이 127.0.0.1 과 그 주소에서 함께 열리고, 사람에게 주는 링크가 그 주소로 나간다.
// 정하지 않으면 아무것도 달라지지 않는다. 모든 인터페이스(0.0.0.0, ::)에서는 어떤 경우에도 열지 않는다.

// host: 링크에 쓸 주소나 이름. listen: 127.0.0.1 말고 더 열 주소. problem: 그 주소를 쓸 수 없는 까닭.
export type ViewAddress = { host?: string; listen: string[]; problem?: string }
type Interfaces = () => ReturnType<typeof networkInterfaces>
export type ViewAddressDeps = { interfaces?: Interfaces; lookup?: (name: string) => Promise<string[]> }
export type ViewAddressSetting = { set: string; ready: Promise<void>; now: () => ViewAddress }

const NAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/
const EVERY = 'that would open the view on every network interface of this computer, which coworker never does'

// 브라우저가 출처에 적는 꼴로 맞춘다(IPv6 는 줄여 쓴 소문자). 주소가 아니면 undefined.
function canonical(text: string): string | undefined {
  const bare = text.replace(/^\[(.*)\]$/, '$1')
  const kind = isIP(bare)
  if (!kind) return undefined
  try {
    return kind === 6 ? new URL(`http://[${bare}]`).hostname.replace(/^\[|\]$/g, '') : bare
  } catch {
    return undefined
  }
}

const isEvery = (ip: string) => ip === '0.0.0.0' || /^[0:]+$/.test(ip) || /^::ffff:(0\.0\.0\.0|0:0)$/i.test(ip)

// 이 PC의 100.64.0.0/10 주소(Tailscale 이 붙이는 범위).
export function tailscaleAddress(interfaces: Interfaces = networkInterfaces): string | undefined {
  for (const list of Object.values(interfaces()))
    for (const nic of list ?? []) {
      if (nic.family !== 'IPv4' || nic.internal) continue
      const [a, b] = nic.address.split('.').map(Number)
      if (a === 100 && b! >= 64 && b! <= 127) return nic.address
    }
  return undefined
}

export function viewAddress(setting: string, deps: ViewAddressDeps = {}): ViewAddressSetting {
  const interfaces = deps.interfaces ?? networkInterfaces
  const text = setting.trim()
  const lower = text.toLowerCase()

  if (lower === 'tailscale')
    return {
      set: 'tailscale',
      ready: Promise.resolve(),
      // 볼 때마다 다시 찾는다. VPN 이 나중에 켜져도 다음에 링크를 줄 때 열린다.
      now: () => {
        const found = tailscaleAddress(interfaces)
        return found ? { host: found, listen: [found] } : { listen: [], problem: 'this computer has no address in 100.64.0.0/10 now (is Tailscale running?)' }
      },
    }

  const address = canonical(text)
  if (address) {
    const fixed: ViewAddress = isEvery(address) ? { listen: [], problem: EVERY } : { host: address, listen: address === '127.0.0.1' ? [] : [address] }
    return { set: text, ready: Promise.resolve(), now: () => fixed }
  }

  if (!NAME.test(lower)) {
    const wrong: ViewAddress = { listen: [], problem: 'the setting must be one address, one name, or the word tailscale, without http://, a port or a path' }
    return { set: text, ready: Promise.resolve(), now: () => wrong }
  }

  // 이름은 켤 때 한 번 푼다. 이 PC의 주소를 가리켜야 쓴다. 다른 곳을 가리키는 이름으로는 열지 않는다.
  let found: ViewAddress = { listen: [], problem: `the name ${lower} is still being looked up` }
  const resolve = deps.lookup ?? (async (name: string) => (await lookup(name, { all: true })).map(a => a.address))
  const ready = (async () => {
    let addresses: string[]
    try {
      addresses = (await resolve(lower)).flatMap(a => canonical(a) ?? [])
    } catch {
      found = { listen: [], problem: `the name ${lower} could not be found` }
      return
    }
    if (addresses.some(isEvery)) return void (found = { listen: [], problem: EVERY })
    const mine = new Set(
      Object.values(interfaces())
        .flat()
        .flatMap(nic => (nic ? (canonical(nic.address.split('%')[0]!) ?? []) : [])),
    )
    const here = addresses.filter(a => a === '127.0.0.1' || a === '::1' || mine.has(a))
    found = here.length ? { host: lower, listen: [...new Set(here)].filter(a => a !== '127.0.0.1') } : { listen: [], problem: `the name ${lower} does not point at this computer` }
  })()
  return { set: lower, ready, now: () => found }
}
