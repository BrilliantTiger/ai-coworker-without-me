import { expect, test } from 'bun:test'
import { KINDS, kindOf, nextVersion } from '../scripts/version'

test('fix, minor and major each raise one place and reset the places after it', () => {
  expect(nextVersion('0.4.12', 'fix')).toBe('0.4.13')
  expect(nextVersion('0.4.12', 'minor')).toBe('0.5.0')
  expect(nextVersion('0.4.12', 'major')).toBe('1.0.0')
  expect(nextVersion('1.9.9', 'minor')).toBe('1.10.0')
  // build 와 patch 는 fix 와 같다.
  expect([KINDS.build, KINDS.patch, KINDS.fix]).toEqual(['fix', 'fix', 'fix'])
})

test('the release note names the kind from the place that changed', () => {
  expect(kindOf('0.4.12', '0.4.13')).toBe('fix')
  expect(kindOf('0.4.12', '0.5.0')).toBe('minor')
  expect(kindOf('0.4.12', '1.0.0')).toBe('major')
  expect(kindOf('0.4.12', '0.4.12')).toBeUndefined()
})
