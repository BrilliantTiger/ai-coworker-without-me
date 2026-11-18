import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as known from './known'

// 흔들리는 시험에 붙이는 표시(unsteady)가 스스로 다시 해 보는지, 그리고 시간 초과를 통과로 치지 않는지 본다.
// 시험 도구(bun 1.4.4)의 다시 해 보기는 세 번 모두 시간을 넘긴 시험을 통과로 센다. 그래서 그것을 쓰지 않는다.
type TryAgain = (body: () => void | Promise<unknown>, tries: number, limitMs: number, name?: string, write?: (line: string) => void) => Promise<void>
type TriesFor = (env: Record<string, string | undefined>) => number
const marker = known as unknown as { tryAgain?: TryAgain; triesFor?: TriesFor }
// 표시가 아직 없으면 몸통을 한 번 돌리고 조용히 끝낸다. 그러면 아래 시험들이 단언에서 실패한다.
const once: TryAgain = async body => {
  try {
    await body()
  } catch {}
}
const tryAgain: TryAgain = (body, tries, limitMs, name, write) => (marker.tryAgain ?? once)(body, tries, limitMs, name, write)
const triesFor: TriesFor = env => (marker.triesFor ? marker.triesFor(env) : -1)

test('a body that is wrong every time fails after three tries, with its last error', async () => {
  let calls = 0
  const run = tryAgain(
    () => {
      calls++
      throw new Error(`wrong ${calls}`)
    },
    3,
    1000,
  )
  await expect(run).rejects.toThrow('wrong 3')
  expect(calls).toBe(3)
})

test('a body that runs out of time every time fails after three tries', async () => {
  let calls = 0
  const started = Date.now()
  const run = tryAgain(
    async () => {
      calls++
      await Bun.sleep(400)
    },
    3,
    50,
  )
  await expect(run).rejects.toThrow('ran out of time (50 ms)')
  expect(calls).toBe(3)
  expect(Date.now() - started).toBeLessThan(380)
})

test('a body that is wrong once, or out of time once, and then right passes', async () => {
  let wrong = 0
  await tryAgain(
    () => {
      if (++wrong === 1) throw new Error('first try')
    },
    3,
    1000,
  )
  expect(wrong).toBe(2)
  let slow = 0
  await tryAgain(
    async () => {
      if (++slow === 1) await Bun.sleep(400)
    },
    3,
    50,
  )
  expect(slow).toBe(2)
  let twice = 0
  await tryAgain(
    async () => {
      if (++twice < 3) throw new Error('not yet')
    },
    3,
    1000,
  )
  expect(twice).toBe(3)
})

test('with one try nothing is tried twice, and the automatic check is the only place with more than one', async () => {
  let calls = 0
  const wrong = tryAgain(
    () => {
      calls++
      throw new Error('once')
    },
    1,
    1000,
  )
  await expect(wrong).rejects.toThrow('once')
  expect(calls).toBe(1)
  let slow = 0
  const late = tryAgain(
    async () => {
      slow++
      await Bun.sleep(400)
    },
    1,
    50,
  )
  await expect(late).rejects.toThrow('ran out of time')
  expect(slow).toBe(1)
  expect(triesFor({})).toBe(1)
  expect(triesFor({ CI: '' })).toBe(1)
  expect(triesFor({ CI: 'true' })).toBe(3)
})

test('every try that fails leaves one line in the log, and a test that passes at once leaves none', async () => {
  // 한 번에 통과하면 아무것도 적지 않는다.
  const quiet: string[] = []
  await tryAgain(() => {}, 3, 1000, 'passes at once', l => quiet.push(l))
  expect(quiet).toEqual([])

  // 틀린 차례와 시간을 넘긴 차례를 한 줄씩 적는다: 시험 이름, 몇 번째인지, 까닭.
  const wavered: string[] = []
  let calls = 0
  await tryAgain(
    async () => {
      calls++
      if (calls === 1) throw new Error('not ready')
      if (calls === 2) await Bun.sleep(400)
    },
    3,
    50,
    'wavers twice',
    l => wavered.push(l),
  )
  expect(wavered).toEqual(['unsteady test "wavers twice": try 1 of 3 failed: not ready', 'unsteady test "wavers twice": try 2 of 3 ran out of time (50 ms)'])

  // 마지막 차례가 실패해도 그 줄을 적는다.
  const lost: string[] = []
  let n = 0
  const run = tryAgain(
    () => {
      throw new Error(`wrong ${++n}`)
    },
    3,
    1000,
    'never right',
    l => lost.push(l),
  )
  await expect(run).rejects.toThrow('wrong 3')
  expect(lost).toEqual([1, 2, 3].map(i => `unsteady test "never right": try ${i} of 3 failed: wrong ${i}`))

  // 여러 줄짜리 까닭은 첫 줄만 적는다.
  const long: string[] = []
  await tryAgain(
    (() => {
      let first = true
      return () => {
        if (first) {
          first = false
          throw new Error('first line\nsecond line')
        }
      }
    })(),
    2,
    1000,
    'long reason',
    l => long.push(l),
  )
  expect(long).toEqual(['unsteady test "long reason": try 1 of 2 failed: first line'])
})

test("nothing uses the test runner's own retry: not the check, not a test", () => {
  const root = join(import.meta.dir, '..')
  const option = ['re', 'try'].join('')
  expect(readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')).not.toContain(`--${option}`)
  for (const file of readdirSync(import.meta.dir).filter(f => f.endsWith('.ts'))) {
    const text = readFileSync(join(import.meta.dir, file), 'utf8')
    expect([file, new RegExp(`\\b${option}:\\s*\\d`).test(text)]).toEqual([file, false])
  }
})
