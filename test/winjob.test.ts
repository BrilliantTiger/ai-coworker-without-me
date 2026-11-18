import { expect, test } from 'bun:test'
import { quoteWindowsArg, spawnOutsideJob, windowsEnvBlock } from '../src/winjob'

// Windows 에서 지킴이를 작업 개체 밖에 띄울 때 쓰는 명령줄과 환경 변수 묶음. 글자를 다루는 부분은 어느 운영체제에서나 시험한다.
test('a command line part is written so that Windows reads back the same text', () => {
  expect(quoteWindowsArg('keep')).toBe('keep')
  expect(quoteWindowsArg('--no-install')).toBe('--no-install')
  expect(quoteWindowsArg('C:\\Users\\me\\coworker.js')).toBe('C:\\Users\\me\\coworker.js')
  expect(quoteWindowsArg('')).toBe('""')
  expect(quoteWindowsArg('C:\\Users\\Kim Minsu\\.claude\\coworker.js')).toBe('"C:\\Users\\Kim Minsu\\.claude\\coworker.js"')
  // 따옴표 앞의 역슬래시는 두 배로 적고, 따옴표에는 역슬래시를 하나 붙인다.
  expect(quoteWindowsArg('say "hi"')).toBe('"say \\"hi\\""')
  expect(quoteWindowsArg('a\\"b c')).toBe('"a\\\\\\"b c"')
  // 맨 끝의 역슬래시는 두 배로 적는다. 그러지 않으면 닫는 따옴표를 글자로 읽는다.
  expect(quoteWindowsArg('C:\\my folder\\')).toBe('"C:\\my folder\\\\"')
})

test('the environment block lists name=value in name order, each ended by a zero, with one more zero at the end', () => {
  const text = (block: Buffer) => block.toString('utf16le')
  expect(text(windowsEnvBlock({ b: '2', A: '1', Path: 'C:\\Windows' }))).toBe('A=1\0b=2\0Path=C:\\Windows\0\0')
  expect(text(windowsEnvBlock({}))).toBe('\0\0')
  // 이름이 비었거나 이름에 「=」이 든 것은 넣지 않는다.
  expect(text(windowsEnvBlock({ '': 'x', 'A=B': 'x', HOME: '가나다' }))).toBe('HOME=가나다\0\0')
})

test('away from Windows nothing is started this way, and the caller starts the keeper the usual way', async () => {
  if (process.platform === 'win32') return
  expect(await spawnOutsideJob([process.execPath, '--version'], undefined, {})).toBe(false)
})
