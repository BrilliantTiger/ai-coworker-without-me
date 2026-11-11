import { readSaved, savedPath } from './resume'

// Claude Code 세션을 다시 켰을 때(resume) 플러그인의 세션 시작 훅이 띄우는 명령이다.
// 채널 없이 켠 세션은 AI가 걸어 둔 백그라운드 대기 명령이 끝나야 깨는데, 다시 켜면 그 명령이 사라진다.
// 사람이 말을 걸기 전까지 아무도 다시 걸지 않아서, 그사이 온 질문을 아무도 읽지 않았다(2026-11-11).
// 그래서 다시 켜지자마자 이 명령이 대신 기다린다. 소식이 오면 그 한 줄을 stderr 에 쓰고 코드 2로 끝난다.
// 훅이 asyncRewake 라서 Claude Code 가 그 줄로 AI를 깨운다. 할 일이 없으면 코드 0으로 조용히 끝난다.
export async function wake(home: string, input: string): Promise<number> {
  let sessionId: unknown
  try {
    sessionId = JSON.parse(input).session_id
  } catch {}
  if (typeof sessionId !== 'string' || !sessionId) return 0
  // MCP 서버와 같은 이름표: 플러그인으로 뜬 서버는 세션 ID, 직접 등록한 서버는 끝에 .direct 가 붙는다.
  const path = savedPath(home, `${sessionId}${process.env.CLAUDE_PLUGIN_ROOT ? '' : '.direct'}`)
  // MCP 서버가 브릿지와 보기 화면을 되살리는 동안은 닿지 않는다. 2분까지 다시 붙어 본다.
  let misses = 0
  for (;;) {
    const saved = readSaved(path)
    if (!saved) return 0
    if (saved.viewer) {
      try {
        const res = await fetch(`http://127.0.0.1:${saved.viewer.port}/${saved.viewer.token}/wake`)
        if (res.ok) {
          const text = (await res.text()).trim()
          if (text.startsWith('coworker: new for this session')) {
            process.stderr.write(`${text}\n`)
            return 2
          }
          // 할 일이 없다는 답이면 끝낸다. 빈 답은 서버가 멈추며 끊은 것이라 다시 붙어 본다.
          if (text) return 0
          misses = 0
        }
      } catch {}
    }
    if (++misses > 600) return 0
    await Bun.sleep(200)
  }
}
