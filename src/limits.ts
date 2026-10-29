// wait_for_message 한 번에 기다리는 시간(초).
// Codex 는 도구 호출을 60초까지만 기다리므로 그 안에서 끝낸다.
// Claude Code 는 오래 걸리는 호출을 백그라운드로 넘기고 끝나면 알려 주므로, 무언가 올 때까지 기다린다.
// 정한 시간 없이 기다리면 빈 결과로 끝나는 일이 없어 사람에게 빈 알림이 가지 않는다.
export function waitSeconds(requested: number | undefined, codex: boolean) {
  if (codex) return Math.min(requested ?? 50, 55)
  return requested || Infinity
}
