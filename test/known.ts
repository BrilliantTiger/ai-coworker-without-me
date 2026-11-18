import { test } from 'bun:test'

// Windows 에서 아직 실패하는 시험에 붙인다. 까닭은 붙인 자리에 적는다.
// Windows 에서는 「실패해야 통과」로 돌아서, 고쳐지면 빨갛게 되어 이 표시를 떼라고 알려 준다. 다른 운영체제에서는 여느 시험이다.
// 여기에 없는 시험이 Windows 에서 실패하면 검사는 그대로 실패한다.
export const failsOnWindows = process.platform === 'win32' ? test.failing : test
