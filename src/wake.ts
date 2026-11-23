import { readSaved, savedPath } from './resume'
import { AFTER_RESTART } from './viewer'

// Claude Code 세션을 다시 켰을 때(resume) 플러그인의 세션 시작 훅이 띄우는 명령이다.
// 채널 없이 켠 세션은 AI가 걸어 둔 백그라운드 대기 명령이 끝나야 깨는데, 다시 켜면 그 명령이 사라진다.
// 사람이 말을 걸기 전까지 아무도 다시 걸지 않아서, 그사이 온 질문을 아무도 읽지 않았다(2026-11-11).
// 그래서 다시 켜지자마자 이 명령이 대신 기다린다. 소식이 오면 그 한 줄을 stderr 에 쓰고 코드 2로 끝난다.
// 훅이 asyncRewake 라서 Claude Code 가 그 줄로 AI를 깨운다. 할 일이 없으면 코드 0으로 조용히 끝난다.
// 서버가 아직 뜨는 중이면 2분, 떴다가 멈췄으면 5초 동안 다시 붙어 본다.
// 횟수가 아니라 시간으로 센다: Windows 는 닫힌 포트에 붙어 보는 데만 2초쯤 걸려서, 횟수로 세면 몇 배로 늘어난다.
const COMING_MS = 120_000
const GONE_MS = 5000
// 떠 있는지 묻는 요청은 1초만 기다린다. 같은 까닭이다.
const ASK_MS = 1000

export async function wake(home: string, input: string): Promise<number> {
  let sessionId: unknown
  try {
    sessionId = JSON.parse(input).session_id
  } catch {}
  if (typeof sessionId !== 'string' || !sessionId) return 0
  // MCP 서버와 같은 이름표: 플러그인으로 뜬 서버는 세션 ID, 직접 등록한 서버는 끝에 .direct 가 붙는다.
  const path = savedPath(home, `${sessionId}${process.env.CLAUDE_PLUGIN_ROOT ? '' : '.direct'}`)
  // MCP 서버가 브릿지와 보기 화면을 되살리는 동안은 닿지 않는다. 2분까지 다시 붙어 본다.
  // 서버가 떠 있는 것을 한 번 본 뒤에 닿지 않으면 서버가 멈춘 것이다: 세션이 끝났거나 서버만 다시 뜨는 중이다. 그때는 5초만 더 본다.
  // 한 번 답하고 끝나는 세션(claude -p --resume)은 끝날 때 이 명령이 끝나기를 30초까지 기다린다(Claude Code 2.1.327 에서 확인).
  // 2분을 다 채우면 그런 세션이 번번이 30초 늦게 끝난다.
  // 떠 있는지는 /status 로 먼저 묻는다. 기다리는 요청(/wake)은 서버가 멈출 때 답 없이 끊길 수 있어서, 그것만으로는 닿았었는지 알 수 없다.
  let reached = false
  // 서버가 떠 있는 것을 마지막으로 본 때. 아직 못 봤으면 시작한 때.
  let seen = Date.now()
  for (;;) {
    const saved = readSaved(path)
    if (!saved) return 0
    if (saved.viewer) {
      const at = `http://127.0.0.1:${saved.viewer.port}/${saved.viewer.token}`
      if (await fetch(`${at}/status`, { signal: AbortSignal.timeout(ASK_MS) }).then(res => res.ok, () => false)) {
        reached = true
        try {
          const res = await fetch(`${at}/wake`)
          if (res.ok) {
            const text = (await res.text()).trim()
            if (text.startsWith(AFTER_RESTART)) {
              process.stderr.write(`${text}\n`)
              return 2
            }
            // 할 일이 없다는 답이면 끝낸다. 빈 답은 서버가 멈추며 끊은 것이라 다시 붙어 본다.
            if (text) return 0
          }
        } catch {}
        seen = Date.now()
      }
    }
    if (Date.now() - seen > (reached ? GONE_MS : COMING_MS)) return 0
    await Bun.sleep(200)
  }
}
