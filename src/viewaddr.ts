import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'

// 대화 보기 주소 설정(COWORKER_VIEWER_ADDRESS, 플러그인 설정의 Viewer address).
// 이 PC의 주인이 자기 다른 기기에서 이 PC에 닿는 주소를 적는다. 둘 가운데 하나다:
//   이 PC의 주소(예: VPN 주소), 또는 tailscale(이 PC의 100.64.0.0/10 주소 하나를 스스로 찾는다).
// 이름은 받지 않는다. 이름을 받으면 그 이름이 어디를 가리킬지 정하는 쪽이 링크와, 화면의 요청을 받아 주는 출처를 얻는다.
// 정하면 대화 보기 화면이 127.0.0.1 과 그 주소에서 함께 열리고, 사람에게 주는 링크가 그 주소로 나간다.
// 정하지 않으면 아무것도 달라지지 않는다. 모든 인터페이스(0.0.0.0, ::)에서는 어떤 경우에도 열지 않는다.

// host: 링크에 쓰고 127.0.0.1 말고 더 열 주소. problem: 그 주소를 쓸 수 없는 까닭.
export type ViewAddress = { host?: string; problem?: string }
type Interfaces = () => ReturnType<typeof networkInterfaces>
export type ViewAddressDeps = { interfaces?: Interfaces }
export type ViewAddressSetting = { set: string; now: () => ViewAddress }

const FORM = 'the setting must be one address of this computer written out (like 100.64.0.10) or the word tailscale, without http://, a port or a path'
const NOT_ONE = 'that address cannot be the address of one computer (it means every interface, or a group of computers)'

// 평범하게 적은 주소만 받는다: 점으로 나눈 십진수 넷(앞에 0 없이), 또는 IPv6. 브라우저가 출처에 적는 꼴로 돌려준다.
// 수 하나로 적은 주소, 16진수·8진수, 줄여 쓴 IPv4(127.1), 범위 표시(%)가 붙은 주소는 받지 않는다.
function plain(text: string): { ip: string; v4: boolean } | undefined {
  if (/^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/.test(text)) return { ip: text, v4: true }
  const bare = text.replace(/^\[(.*)\]$/, '$1')
  if (!/^[0-9a-fA-F:.]+$/.test(bare) || isIP(bare) !== 6) return undefined
  try {
    return { ip: new URL(`http://[${bare}]`).hostname.replace(/^\[|\]$/g, ''), v4: false }
  } catch {
    return undefined
  }
}

// 컴퓨터 한 대의 주소일 수 없는 주소: 정해지지 않은 주소, 모두에게 보내는 주소, 여럿에게 보내는 주소.
function notOne(ip: string, v4: boolean): boolean {
  if (v4) {
    const first = Number(ip.split('.')[0])
    return ip === '0.0.0.0' || ip === '255.255.255.255' || (first >= 224 && first <= 239)
  }
  // IPv4 를 품은 IPv6(::ffff:a.b.c.d)는 받지 않는다. 같은 주소를 두 가지로 적을 수 있게 된다.
  return /^[0:]+$/.test(ip) || /^ff/i.test(ip) || /^::ffff:/i.test(ip)
}

// 이 PC의 100.64.0.0/10 주소들(Tailscale 이 붙이는 범위).
export function tailscaleAddresses(interfaces: Interfaces = networkInterfaces): string[] {
  const found = new Set<string>()
  for (const list of Object.values(interfaces()))
    for (const nic of list ?? []) {
      if (nic.family !== 'IPv4' || nic.internal) continue
      const [a, b] = nic.address.split('.').map(Number)
      if (a === 100 && b! >= 64 && b! <= 127) found.add(nic.address)
    }
  return [...found]
}

export function viewAddress(setting: string, deps: ViewAddressDeps = {}): ViewAddressSetting {
  const interfaces = deps.interfaces ?? networkInterfaces
  const text = setting.trim()

  if (text.toLowerCase() === 'tailscale')
    return {
      set: 'tailscale',
      // 볼 때마다 다시 찾는다. VPN 이 나중에 켜져도 다음에 링크를 줄 때 열린다. 꼭 하나일 때만 쓴다.
      now: () => {
        const found = tailscaleAddresses(interfaces)
        if (found.length === 1) return { host: found[0] }
        if (!found.length) return { problem: 'this computer has no address in 100.64.0.0/10 now (is Tailscale running?)' }
        return { problem: `this computer has more than one address in 100.64.0.0/10 (${found.join(', ')}), so coworker does not choose: write the address itself in the setting instead of the word tailscale` }
      },
    }

  const address = plain(text)
  const fixed: ViewAddress = address
    ? notOne(address.ip, address.v4)
      ? { problem: address.ip === '0.0.0.0' || /^[0:]+$/.test(address.ip) ? `${NOT_ONE}; coworker never opens the view on every network interface` : NOT_ONE }
      : { host: address.ip }
    : /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(text) && !/^[0-9.]+$/.test(text) && !/^0x/i.test(text)
      ? { problem: `a name is not accepted, because whoever decides where the name points would get the link: write the address of this computer itself instead of ${text}` }
      : { problem: FORM }
  return { set: text, now: () => fixed }
}
