// 판 번호 규칙: major.minor.fix (사람이 정함, 2026-11-11).
//   fix   고치기만 했다. 새 도구·새 입력·새 설정이 없고 쓰는 법이 그대로다.
//   minor 기능을 더하거나 사람이 보는 동작을 바꿨다. 예전 판과 그대로 이어진다.
//   major 예전 판과 이어지지 않는다(연결 코드, 주고받는 메시지, 저장 상태의 꼴이 바뀜). 함께 쓰는 사람 모두 올려야 한다.
// 지난 릴리스 뒤에 들어간 것 가운데 가장 큰 변경으로 한 자리만 올리고, 뒷자리는 0으로 돌린다.

export type Kind = 'major' | 'minor' | 'fix'
// build 와 patch 는 fix 와 같다.
export const KINDS: Record<string, Kind> = { major: 'major', minor: 'minor', fix: 'fix', build: 'fix', patch: 'fix' }
const PLACE: Record<Kind, number> = { major: 0, minor: 1, fix: 2 }

export function nextVersion(from: string, kind: Kind): string {
  const place = PLACE[kind]
  return from
    .split('.')
    .map((n, i) => (i < place ? Number(n) : i === place ? Number(n) + 1 : 0))
    .join('.')
}

// 지난 판에서 어느 자리가 올랐는지. 같으면 undefined.
export function kindOf(from: string, to: string): Kind | undefined {
  const [a, b] = [from, to].map(v => v.split('.'))
  if (a![0] !== b![0]) return 'major'
  if (a![1] !== b![1]) return 'minor'
  if (a![2] !== b![2]) return 'fix'
  return undefined
}

// 릴리스 노트 첫 줄.
export const KIND_NOTE: Record<Kind, string> = {
  major: '큰 변경(major): 예전 판과 이어지지 않는다. 함께 쓰는 사람 모두 이 판으로 올려야 한다.',
  minor: '기능을 더한 판(minor): 예전 판과 그대로 이어진다.',
  fix: '고친 판(fix): 쓰는 법은 그대로다.',
}
