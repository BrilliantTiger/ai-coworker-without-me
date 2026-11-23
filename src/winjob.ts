// Windows 에서 프로세스를 「작업 개체(Job Object)」 밖에 띄운다. 지킴이를 띄울 때만 쓴다(keep.ts).
//
// Windows 의 앱은 자기가 띄운 프로세스들을 작업 개체에 묶어 두고, 닫을 때 그 안의 것을 한꺼번에 끝낼 수 있다.
// 2026-11-18 에 Windows 의 Orca 에서 쟀다. 터미널을 닫으니 그 터미널에서 나온 프로세스가 모두 같은 순간에 종료 코드 1 로 끝났다.
// 부모 없이 따로 띄운(detached) 지킴이도, 그 터미널의 콘솔에 붙어 있지 않았는데 함께 끝났다. 그러면 세션이 닫힐 때 다리도 다시 같이 멈춘다.
// 같은 자리에서 작업 개체를 벗어나게 띄운 프로세스는 남았다.
//
// Bun 과 Node 의 spawn 은 「벗어나기」 표시(CREATE_BREAKAWAY_FROM_JOB)를 줄 수 없다. 그래서 kernel32 의 CreateProcessW 를 직접 부른다.
// 띄우지 못하면 false 를 돌려주고, 부른 쪽이 여느 방법(spawn)으로 띄운다:
//   - 작업 개체가 벗어나기를 허용하지 않는다. 그때 CreateProcessW 는 「접근 거부」로 실패한다.
//   - bun:ffi 를 쓸 수 없는 Bun 이다.

const DETACHED_PROCESS = 0x8
const CREATE_NEW_PROCESS_GROUP = 0x200
const CREATE_UNICODE_ENVIRONMENT = 0x400
const CREATE_BREAKAWAY_FROM_JOB = 0x0100_0000
const STARTF_USESTDHANDLES = 0x100
const INVALID_HANDLE = 0xffff_ffff_ffff_ffffn

// 명령줄의 한 조각을 Windows 규칙대로 적는다. 프로그램은 이 규칙으로 명령줄을 다시 조각낸다(CommandLineToArgvW).
// 빈칸이나 따옴표가 있으면 따옴표로 싼다. 따옴표 앞의 역슬래시와 맨 끝의 역슬래시는 두 배로 적는다.
export function quoteWindowsArg(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg
  let out = '"'
  let slashes = 0
  for (const ch of arg) {
    if (ch === '\\') {
      slashes++
      continue
    }
    out += ch === '"' ? `${'\\'.repeat(slashes * 2 + 1)}"` : `${'\\'.repeat(slashes)}${ch}`
    slashes = 0
  }
  return `${out}${'\\'.repeat(slashes * 2)}"`
}

// 환경 변수 묶음. 「이름=값」마다 끝에 0 을 붙여 잇고, 맨 끝에 0 을 하나 더 붙인다. Windows 가 기대하는 대로 이름 순으로 놓는다.
export function windowsEnvBlock(env: Record<string, string>): Buffer {
  const rows = Object.entries(env)
    .filter(([name]) => name !== '' && !name.includes('=') && !name.includes('\0'))
    .sort(([a], [b]) => (a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0))
    .map(([name, value]) => `${name}=${value.replaceAll('\0', '')}\0`)
  return Buffer.from(`${rows.join('') || '\0'}\0`, 'utf16le')
}

// command[0] 은 프로그램의 전체 경로다. 띄웠으면 true.
// 새 프로세스는 콘솔 없이, 새 프로세스 묶음으로 뜬다(spawn 의 detached 와 같다). 표준 입출력은 이 프로세스의 것을 그대로 준다:
// 지킴이를 띄우는 프로세스는 표준 입출력이 모두 「없음」(NUL)이다.
export async function spawnOutsideJob(command: string[], cwd: string | undefined, env: Record<string, string>): Promise<boolean> {
  if (process.platform !== 'win32' || !command[0]) return false
  try {
    const { dlopen, FFIType, ptr } = await import('bun:ffi')
    const lib = dlopen('kernel32.dll', {
      CreateProcessW: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
      GetStdHandle: { args: [FFIType.u32], returns: FFIType.u64 },
      CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    })
    try {
      const wide = (text: string) => Buffer.from(`${text}\0`, 'utf16le')
      // CreateProcessW 는 명령줄을 고쳐 쓸 수 있다. 그래서 따로 만든 버퍼를 준다.
      const commandLine = wide(command.map(quoteWindowsArg).join(' '))
      const block = windowsEnvBlock(env)
      const folder = cwd ? wide(cwd) : undefined

      // STARTUPINFOW (64비트에서 104바이트). 맨 앞이 크기, 60 이 표시, 80 · 88 · 96 이 표준 입력 · 출력 · 오류다.
      const startup = Buffer.alloc(104)
      startup.writeUInt32LE(104, 0)
      const std = [0xffff_fff6, 0xffff_fff5, 0xffff_fff4].map(which => BigInt(lib.symbols.GetStdHandle(which)))
      const inherit = std.every(h => h !== 0n && h !== INVALID_HANDLE)
      if (inherit) {
        startup.writeUInt32LE(STARTF_USESTDHANDLES, 60)
        std.forEach((h, i) => startup.writeBigUInt64LE(h, 80 + i * 8))
      }
      // PROCESS_INFORMATION: 프로세스 핸들, 스레드 핸들, 프로세스 id, 스레드 id.
      const made = Buffer.alloc(24)
      const flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT | CREATE_BREAKAWAY_FROM_JOB
      const ok = lib.symbols.CreateProcessW(null, ptr(commandLine), null, null, inherit ? 1 : 0, flags, ptr(block), folder ? ptr(folder) : null, ptr(startup), ptr(made))
      if (!ok) return false
      lib.symbols.CloseHandle(made.readBigUInt64LE(0))
      lib.symbols.CloseHandle(made.readBigUInt64LE(8))
      return true
    } finally {
      lib.close()
    }
  } catch {
    return false
  }
}
