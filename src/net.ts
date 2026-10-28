import { networkInterfaces, hostname, platform } from 'node:os'

const isPrivateLan = (ip: string) =>
  ip.startsWith('10.') || ip.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)

// 상대가 이 PC에 닿을 수 있는 주소들. 사내망 IP가 먼저, 그다음 VPN 같은 나머지 IP,
// 그다음 컴퓨터 이름, 마지막에 같은 PC 안에서 쓰는 127.0.0.1.
export function localAddresses(): string[] {
  const lan: string[] = []
  const other: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const nic of list ?? []) {
      if (nic.family !== 'IPv4' || nic.internal || nic.address.startsWith('169.254.')) continue
      ;(isPrivateLan(nic.address) ? lan : other).push(nic.address)
    }
  }
  const name = bonjourName()
  return [...new Set([...lan, ...other, ...(name ? [name] : []), '127.0.0.1'])]
}

// macOS는 「컴퓨터이름.local」로 같은 네트워크에서 찾을 수 있다. IP가 바뀌어도 이 이름은 그대로다.
// Windows는 이 이름 찾기가 잘 안 될 수 있어서 넣지 않는다.
function bonjourName(): string | undefined {
  if (platform() === 'darwin') {
    try {
      const out = Bun.spawnSync(['scutil', '--get', 'LocalHostName']).stdout.toString().trim()
      if (out) return `${out}.local`
    } catch {}
  }
  if (platform() === 'linux') return `${hostname()}.local`
  return undefined
}

export const shortHostname = () => hostname().replace(/\.local$/, '')

export const hostForUrl = (addr: string) => (addr.includes(':') ? `[${addr}]` : addr)
