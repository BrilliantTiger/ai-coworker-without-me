import { test } from 'bun:test'

// Windows 에서 아직 실패하는 시험에 붙인다. 까닭은 붙인 자리에 적는다.
// Windows 에서는 「실패해야 통과」로 돌아서, 고쳐지면 빨갛게 되어 이 표시를 떼라고 알려 준다. 다른 운영체제에서는 여느 시험이다.
// 여기에 없는 시험이 Windows 에서 실패하면 검사는 그대로 실패한다.
export const failsOnWindows = process.platform === 'win32' ? test.failing : test

// 실패가 「시간 초과」인 시험은 위 표시를 쓸 수 없다(시험 도구가 시간 초과를 예상한 실패로 치지 않는다). 그런 시험은 Windows 에서 건너뛴다.
export const skippedOnWindows = test.skipIf(process.platform === 'win32')

// 시간에 따라 흔들리는 것이 확인된 시험에 붙인다. 자동 검사(CI)에서만, 실패하면 두 번까지 다시 해 본다. 세 번 내리 실패하면 실패다.
// 실패는 몸통이 던진 것과 제 시간을 넘긴 것 둘 다다. 내 PC 에서는 다시 해 보지 않는다. 여기에 없는 시험은 어디서나 한 번 실패하면 실패다.
// 흔들리는 까닭을 찾아 고치면 이 표시를 뗀다.
//
// 시험 도구의 다시 해 보기(retry)는 쓰지 않는다. bun 1.4.4 는 다시 해 보기가 걸린 시험이 번번이 시간을 넘기면 통과로 센다.
// 그래서 여기서 직접 다시 돌리고, 한 번에 주는 시간도 여기서 잰다.
type Body = () => void | Promise<unknown>

// 몸통을 tries 번까지 돌린다. 한 번에 limitMs 를 넘기면 그 한 번은 실패다. 마지막까지 실패하면 마지막 실패를 던진다.
// 시간을 넘긴 몸통은 멈출 수 없어서 뒤에서 마저 돈다. 다시 돌린 것과 겹칠 수 있다.
export async function tryAgain(body: Body, tries: number, limitMs: number): Promise<void> {
  let last: unknown
  for (let attempt = 1; attempt <= tries; attempt++) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const late = new Promise<never>((_, fail) => {
        timer = setTimeout(() => fail(new Error(`ran out of time (${limitMs} ms)${tries > 1 ? `, try ${attempt} of ${tries}` : ''}`)), limitMs)
      })
      const run = Promise.resolve().then(body)
      // 시간을 넘긴 뒤에 몸통이 던지는 것은 받는 곳이 없다. 흘려 둔다.
      run.catch(() => {})
      await Promise.race([run, late])
      return
    } catch (e) {
      last = e
    } finally {
      clearTimeout(timer)
    }
  }
  throw last
}

// 몇 번까지 돌리는지: 자동 검사에서는 세 번, 그 밖에서는 한 번.
export const triesFor = (env: Record<string, string | undefined>) => (env.CI ? 3 : 1)

// 한 번에 주는 시간. 시험에 따로 적은 시간이 없으면 시험 도구의 기본과 같게 둔다: 자동 검사는 20초(ci.yml 의 --timeout), 내 PC 는 5초.
const limitFor = (env: Record<string, string | undefined>, timeout?: number) => timeout ?? (env.CI ? 20_000 : 5_000)

export const unsteady = (name: string, body: Body, timeout?: number) => {
  const tries = triesFor(process.env)
  // 내 PC 에서는 여느 시험과 똑같이 돈다.
  if (tries === 1) return timeout === undefined ? test(name, body) : test(name, body, timeout)
  const limit = limitFor(process.env, timeout)
  // 시험 도구가 마지막 차례보다 먼저 끊지 않게, 도구에는 모든 차례를 더한 것보다 조금 긴 시간을 준다.
  return test(name, () => tryAgain(body, tries, limit), tries * limit + 5_000)
}
