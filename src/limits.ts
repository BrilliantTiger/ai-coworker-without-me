// wait_for_message 한 번에 기다리는 시간(초).
// Codex 는 도구 호출을 60초까지만 기다린다. Claude Code 는 120초가 넘는 호출을 백그라운드로 넘기고,
// 끝날 때마다 사람에게 보이는 알림 턴을 만든다. 그래서 둘 다 그 안에서 끝낸다.
export function waitSeconds(requested: number | undefined, codex: boolean) {
  const limit = codex ? 55 : 110
  return Math.min(requested ?? (codex ? 50 : limit), limit)
}
