// 기다림에는 끝이 있다. AI 도구가 정한 시간 상한에 걸려 끊기기 전에, 이쪽이 먼저 「새 소식 없음」으로 끝내고 AI가 다시 건다.
//
// Codex 는 도구 호출을 60초까지만 기다린다. 그래서 wait_for_message 를 그 안에서 끝낸다.
//
// Claude Code 는 사람이 터미널에서 직접 쓰는 세션이 아니면 백그라운드 명령을 시간으로 끊는다(2.1.327 에서 확인).
// 명령에 timeout 을 주지 않으면 30분, 주어도 2시간까지다. 두 값은 Anthropic 이 서버 설정으로 바꿀 수 있다.
// 끊긴 명령은 「killed」로 끝나고, Claude Code 는 AI에게 「가장 긴 timeout 이었으면 다시 걸지 말라」고 알린다.
// 2026-11-18 에 Orca 채팅형 세션에서 듣기 명령이 2시간에 끊겼다. AI는 다시 걸지 않았고, 쉬는 세션이 된 그 세션을 Orca 가 내렸다.
// 그래서 듣기 명령(/next)과 wait_for_message 는 상한보다 먼저 스스로 끝난다.

// 듣기가 스스로 끝나는 시간. 안내하는 timeout(1시간)보다 5분 짧다.
// 1시간 안쪽으로 둔 까닭: Claude Code 는 프롬프트 캐시를 1시간까지 남긴다. 그 안에 깨면 AI가 한 차례 도는 값이 싸다.
export const LISTEN_MS = 55 * 60_000
// 듣기 명령에 함께 주라고 안내하는 timeout. 주지 않으면 Claude Code 가 30분에 끊는다.
export const LISTEN_TIMEOUT_MS = 60 * 60_000
// 끊긴 것을 보고 기다림을 줄일 때의 바닥. 이보다 자주 AI를 깨우지 않는다.
export const LISTEN_FLOOR_MS = 5 * 60_000
// setTimeout 이 받는 가장 긴 시간보다 조금 짧게.
const TIMER_MAX_MS = 2_000_000_000

const given = (text: string | undefined) => {
  const n = Number(text)
  return text !== undefined && text.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : undefined
}

// 이 세션의 듣기가 스스로 끝나야 하는 시간(ms). 끝이 필요 없으면 Infinity.
// 사람이 터미널에서 직접 쓰는 Claude Code(CLAUDE_CODE_ENTRYPOINT=cli)는 백그라운드 명령을 시간으로 끊지 않는다. 그때는 올 때까지 기다린다.
// 스스로 끝날 때마다 AI가 한 차례 돌아 사용량이 들기 때문에, 끊기지 않는 곳에서는 끝을 두지 않는다.
// 그 밖의 세션(Orca 채팅형, SDK, 데스크톱 앱, coworker 앱에 붙은 세션, 알 수 없는 곳)은 끝을 둔다.
// 이 짐작이 틀려도(예: 환경 변수를 물려받은 세션) 끊긴 시간을 보고 스스로 줄인다(limitAfterCut).
// COWORKER_LISTEN_MINUTES 로 사람이 정할 수 있다(0 이면 끝을 두지 않는다). COWORKER_LISTEN_MS 는 시험용이다.
export function listenLimit(env: Record<string, string | undefined> = process.env): number {
  const ms = given(env.COWORKER_LISTEN_MS)
  if (ms !== undefined) return ms ? Math.min(ms, TIMER_MAX_MS) : Infinity
  const minutes = given(env.COWORKER_LISTEN_MINUTES)
  if (minutes !== undefined) return minutes ? Math.min(minutes * 60_000, TIMER_MAX_MS) : Infinity
  return env.CLAUDE_CODE_ENTRYPOINT === 'cli' ? Infinity : LISTEN_MS
}

// 듣기 명령이 소식 없이 끊겼다. Claude Code 가 시간 상한으로 끊은 것으로 보이면, 다음부터 쓸 더 짧은 기다림을 돌려준다.
// 상한은 분으로 떨어진다(30분, 1시간, 2시간, AI가 준 timeout). 명령이 뜨고 이 서버에 닿기까지 조금 걸리므로, 기다린 시간은 그보다 몇 초 짧다.
// 사람이 멈춘 것과 세션이 끝난 것은 아무 때나 온다. 그래서 분에 맞게 끊긴 것만 상한으로 본다(5초 일찍 ~ 1초 늦게).
// 바닥보다 짧은 상한은 보지 않는다. 기다림은 줄이기만 한다.
// COWORKER_LISTEN_CUT_FLOOR_MS · COWORKER_LISTEN_CUT_MINUTE_MS 는 시험용이다.
export function limitAfterCut(
  waitedMs: number,
  current: number,
  floorMs = given(process.env.COWORKER_LISTEN_CUT_FLOOR_MS) || LISTEN_FLOOR_MS,
  minuteMs = given(process.env.COWORKER_LISTEN_CUT_MINUTE_MS) || 60_000,
): number | undefined {
  const limit = Math.round(waitedMs / minuteMs) * minuteMs
  const early = limit - waitedMs
  if (limit < floorMs || early > minuteMs / 12 || early < -minuteMs / 60) return undefined
  const shorter = Math.max(floorMs, Math.floor(limit * 0.8))
  return shorter < Math.min(current, limit) ? shorter : undefined
}

// 듣기 명령에 주라고 안내할 timeout(ms). 기다림보다 5분 넉넉하게, 적어도 1시간.
export const listenTimeout = (limitMs: number) => Math.max(LISTEN_TIMEOUT_MS, Math.ceil((limitMs + 5 * 60_000) / 60_000) * 60_000)

// wait_for_message 한 번에 기다리는 시간(초).
// Codex 는 55초까지. 그 밖에는 무언가 올 때까지 기다리되, 이 세션의 듣기가 끝나는 시간(길어도 55분)을 넘기지 않는다.
// Claude Code 는 MCP 도구 호출에도 전체 시간 상한을 두기 때문이다. 빈 결과로 끝나면 AI는 사람에게 알리지 않고 다시 부른다.
export function waitSeconds(requested: number | undefined, codex: boolean, limitMs: number = LISTEN_MS) {
  if (codex) return Math.min(requested ?? 50, 55)
  return Math.min(requested || Infinity, Math.min(limitMs, LISTEN_MS) / 1000)
}
