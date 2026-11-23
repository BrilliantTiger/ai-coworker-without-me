// 사람이 브라우저로 보는 대화 화면. viewer.ts 가 이 글을 그대로 내려 준다.
// 화면은 차분하고 읽기 쉽게 짜고, 움직임은 과하지도 모자라지도 않게 넣는다(2026-11-17, 사람이 정함:
// 「모던하고 심플하되 가독성 높은 상태에서 모션이 과하지 않고 이질감없이 자연스럽게」, 「과하지 않은 적절한 모션」).
// 왼쪽에 대화 목록을, 오른쪽에 고른 대화 하나를 둔다(2026-11-17, 사람이 정함: 「대화의 묶음 리스트를 … 클릭하면 볼 수 있게」, 「오른쪽이 아니라 왼쪽이다」).
// 넓은 화면에서는 머리와 틀이 그대로 있고 대화 목록과 채팅 내용이 따로 구른다. 채팅은 맨 아래가 가장 새 글이고, 새 글이 오면 맨 아래에 붙는다.
// 넣는 움직임: 글이 오가면 연결선을 따라 점이 건너간다. 고른 대화와 새 글이 부드럽게 들어온다. 차례가 바뀌면 목록의 줄이 미끄러져 간다.
// 상태가 바뀌면 이름표가 넘어가고 체크가 그려진다. 기다리는 곳에서는 점이 조용히 뛴다.
// 넣지 않는 것: 얼굴 캐릭터, 배경에 떠다니는 것, 색종이, 번쩍이며 도는 테두리, 글자가 써 내려가는 것, 카드가 기우는 것.
//
// 지키는 것:
// - 상대가 보낸 글과 이름은 textContent 로만 넣는다. HTML 로 해석하지 않는다.
// - 밖에서 아무것도 받아 오지 않는다. 글꼴·그림·스크립트 모두 이 글 안에 있다(CSP: default-src 'none').
// - 움직임은 <html class="on"> 일 때만 건다. 「동작 줄이기」를 켠 PC에서는 처음부터 꺼져 있고,
//   화면의 「모션 끄기」 단추로 언제든 멈춘다. 멈춰도 내용은 모두 그대로 보인다. 빛깔이나 투명도만 바뀌는 것은 그대로 둔다.
// - 움직임은 자리 옮김, 크기, 투명도, 그리고 선이 그어지거나 흐르는 것으로만 만든다. 1초에 세 번 넘게 깜빡이는 것은 없다.
// - 이 글은 템플릿 글 안에 있다. 그래서 화면 스크립트에는 백틱, 달러-중괄호, 역슬래시를 쓰지 않는다.
//   달러-중괄호는 아래 QUIET_AFTER_MS 를 넣는 한 곳에만 있다.
//   (String.raw 로 감싸면 안 된다. Bun 이 한글을 \\uXXXX 로 바꿔 묶어서, 화면에 그 글자가 그대로 찍힌다.)

// 답 없이 이만큼 지난 질문은 화면과 채팅창 위 띠가 조용히 둔다. 답이 필요 없는 알림도 질문으로 오기 때문이다.
export const QUIET_AFTER_MS = 5 * 60_000

export const PAGE = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Coworker 대화</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #f4f4f7; --card: #ffffff; --soft: #f0f0f4; --line: #e1e1e8; --text: #17171c; --muted: #5f606b;
  --in: #edf0fd; --in-b: #3350c9; --out: #e7f5ec; --out-b: #1b7340; --note: #fbf1d8; --note-b: #8a5a0c; --agree: #f1ebfe; --agree-b: #6a3fc0;
  --accent: #4353d6; --accent2: #7a4fd8; --warn: #b3261e; --ok: #1b8a4b;
  --t1: #3350c9; --t2: #1b7340; --t3: #8a5a0c; --t4: #6a3fc0; --t5: #0e7490; --t6: #b4325f;
  --shadow: 0 1px 2px rgba(16, 20, 40, .05), 0 6px 20px rgba(16, 20, 40, .06);
  --pop: 0 4px 12px rgba(16, 20, 40, .08), 0 18px 44px rgba(16, 20, 40, .16);
  --glow: 9%;
  --ease: cubic-bezier(.22, 1, .36, 1);
  --font: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", "Segoe UI", sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0c0d11; --card: #15161c; --soft: #1d1f27; --line: #282a33; --text: #ededf1; --muted: #9c9eaa;
    --in: #161f38; --in-b: #8eaaff; --out: #122a1e; --out-b: #6fd49b; --note: #2a2311; --note-b: #e8b85a; --agree: #221b3a; --agree-b: #b9a2ff;
    --accent: #8b9dff; --accent2: #b08cff; --warn: #ff8f85; --ok: #5fd08f;
    --t1: #8eaaff; --t2: #6fd49b; --t3: #e8b85a; --t4: #b9a2ff; --t5: #5cc8de; --t6: #ff8fb1;
    --shadow: 0 1px 2px rgba(0, 0, 0, .35), 0 8px 24px rgba(0, 0, 0, .22);
    --pop: 0 4px 14px rgba(0, 0, 0, .4), 0 20px 50px rgba(0, 0, 0, .5);
    --glow: 14%;
  }
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; color: var(--text); font: 15px/1.55 var(--font); background: radial-gradient(1000px 440px at 50% -180px, color-mix(in srgb, var(--accent) var(--glow), transparent), transparent 72%) fixed no-repeat, var(--bg); }
button { font: inherit; color: inherit; }
:where(button, summary, [tabindex]):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
/* 화면에는 안 보이고 읽어 주는 프로그램에만 잡히는 글 */
.plain { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

/* 맨 위: 이름, 실시간 표시, 단추. 화면을 내리면 아래 금이 나타난다. */
.top { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; padding: 12px max(16px, calc((100vw - 1180px) / 2 + 16px)); background: color-mix(in srgb, var(--bg) 80%, transparent); -webkit-backdrop-filter: blur(14px) saturate(1.3); backdrop-filter: blur(14px) saturate(1.3); border-bottom: 1px solid var(--line); }
@supports (animation-timeline: scroll()) {
  .top { border-bottom-color: transparent; animation: edge linear both; animation-timeline: scroll(root); animation-range: 0px 72px; }
  @keyframes edge { to { border-bottom-color: var(--line); } }
}
.brand { display: flex; align-items: center; gap: 10px; margin-right: auto; }
.logo { width: 26px; height: 26px; flex: none; }
.logo path { stroke: var(--muted); stroke-width: 2; stroke-linecap: round; opacity: .55; }
.logo .l1 { fill: var(--accent); } .logo .l2 { fill: var(--accent2); }
h1 { font-size: 18px; font-weight: 700; margin: 0; letter-spacing: -.015em; white-space: nowrap; }
h1 span { background: linear-gradient(90deg, var(--accent), var(--accent2)); -webkit-background-clip: text; background-clip: text; color: transparent; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.chip { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; line-height: 1; padding: 8px 12px; border-radius: 9px; border: 1px solid var(--line); background: var(--card); white-space: nowrap; }
button.chip { cursor: pointer; transition: background-color .15s, border-color .15s, color .15s, scale .2s var(--ease); }
button.chip:hover { background: var(--soft); border-color: color-mix(in srgb, var(--muted) 45%, var(--line)); }
.on button.chip:active { scale: .96; }
button.chip:disabled { opacity: .5; cursor: not-allowed; }
.chip b { font-weight: 600; color: var(--muted); font-variant-numeric: tabular-nums; }
.chip.sel { border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); background: color-mix(in srgb, var(--accent) 12%, var(--card)); color: var(--accent); font-weight: 600; }
.chip.sel b { color: inherit; opacity: .8; }
.chip.main { background: linear-gradient(135deg, var(--accent), var(--accent2)); border-color: transparent; color: var(--card); font-weight: 600; }
button.chip.main:hover { background: linear-gradient(135deg, var(--accent), var(--accent2)); filter: brightness(1.08); }
/* 살아 있음을 알리는 점. 둘레로 고리가 천천히 퍼진다. */
.live { display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--muted); padding: 0 8px 0 2px; white-space: nowrap; }
.beacon { position: relative; width: 7px; height: 7px; border-radius: 50%; background: var(--ok); flex: none; }
.beacon::after, .sdot::after { content: ''; position: absolute; inset: 0; border-radius: 50%; background: inherit; opacity: 0; }
.on .beacon::after, .on .act .sdot::after { animation: ping 2.4s var(--ease) infinite; }
@keyframes ping { 0% { opacity: .5; scale: 1; } 70%, 100% { opacity: 0; scale: 2.9; } }
.live.off { color: var(--warn); font-weight: 600; }
.live.off .beacon { background: var(--warn); }
.on .live.off .beacon::after { animation: none; }

main { max-width: 1180px; margin: 0 auto; padding: 18px 16px 90px; transition: opacity .3s; }
.offline main { opacity: .55; }
.on.boot .panel, .on.boot .info { animation: enter .6s var(--ease) both; }
.on.boot .info { animation-delay: .08s; }
@keyframes enter { from { opacity: 0; translate: 0 10px; } }

/* 연결 그림: 왼쪽이 이 세션, 오른쪽이 연결된 세션. 선이 둘을 잇고, 글이 오가면 선을 따라 점이 건너간다. */
.panel { background: var(--card); border: 1px solid var(--line); border-radius: 16px; box-shadow: var(--shadow); margin-bottom: 10px; overflow: hidden; container: panel / inline-size; }
.net { position: relative; display: grid; grid-template-columns: minmax(0, max-content) minmax(56px, 1fr) minmax(0, 1.6fr); align-items: center; padding: 20px 20px 18px; background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 5%, transparent), transparent 70%); }
#wires { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }
.wire { fill: none; stroke: color-mix(in srgb, var(--muted) 28%, var(--line)); stroke-width: 1.5; transition: stroke .3s; }
/* 기다리는 일이 있는 선은 점선이 되어, 답할 쪽으로 천천히 흐른다 */
.wire.fwd, .wire.back { stroke: color-mix(in srgb, var(--accent) 55%, var(--line)); stroke-dasharray: 3 7; }
.on .wire.fwd { animation: flow 1.8s linear infinite; }
.on .wire.back { animation: flow 1.8s linear infinite reverse; }
@keyframes flow { to { stroke-dashoffset: -10; } }
.wire.ghost { stroke-dasharray: 2 6; }
.wire.sel { stroke: color-mix(in srgb, var(--accent) 80%, var(--line)); }
.wire.down, .on .wire.down { stroke: var(--warn); stroke-dasharray: 4 6; animation: none; }
.spark { fill: var(--c, var(--accent)); filter: drop-shadow(0 0 5px var(--c, var(--accent))); }
.peers { grid-column: 3; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.peers:empty { display: none; }
.nopeer { grid-column: 2 / 4; margin: 0; padding-left: 24px; font-size: 13px; color: var(--muted); text-wrap: pretty; }
.nopeer[hidden] { display: none; }
#keykinds[hidden], #keycode[hidden], #keycopy[hidden], #keyagain[hidden] { display: none; }
.sess { position: relative; display: flex; align-items: center; gap: 11px; min-width: 0; padding: 7px 10px; border-radius: 12px; border: 1px solid transparent; background: none; text-align: left; }
.sess.me { grid-column: 1; padding: 0; gap: 13px; max-width: 280px; }
button.sess { width: 100%; cursor: pointer; }
.on .sess { transition: opacity .4s ease-out, background-color .15s, border-color .2s; }
button.sess:hover { background: var(--soft); }
.sess[aria-pressed=true] { border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); background: color-mix(in srgb, var(--accent) 9%, transparent); }
.avatar { position: relative; display: grid; place-items: center; width: 36px; height: 36px; border-radius: 50%; flex: none; font-size: 14px; font-weight: 650; color: var(--tone, var(--muted)); background: color-mix(in srgb, var(--tone, var(--muted)) 14%, var(--card)); box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--tone, var(--muted)) 36%, transparent); }
.sess.me .avatar { width: 46px; height: 46px; font-size: 17px; color: var(--card); background: linear-gradient(135deg, var(--accent), var(--accent2)); box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 16%, transparent); }
.sess.ghost .avatar { box-shadow: none; outline: 1.5px dashed color-mix(in srgb, var(--tone, var(--muted)) 55%, transparent); outline-offset: -1.5px; }
.sess.down .avatar, .sess.closed .avatar { filter: grayscale(1); opacity: .7; }
.ring { position: absolute; inset: 0; border-radius: 50%; box-shadow: 0 0 0 2px var(--c, var(--accent)); opacity: 0; pointer-events: none; }
.st { position: absolute; right: -1px; bottom: -1px; width: 10px; height: 10px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 2px var(--card); }
.sess.down .st { background: var(--warn); }
.sess.ghost .st, .sess.closed .st { background: var(--muted); }
.sinfo { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; }
.sname { font-size: 13.5px; font-weight: 600; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sess.me .sname { font-size: 15px; font-weight: 650; }
.ssub { font-size: 12px; line-height: 1.45; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ssub:empty { display: none; }
/* 답할 차례인 쪽에는 점 세 개가, 사람에게 확인 중인 쪽에는 이름표가 붙는다. */
.stag { display: none; flex: none; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 600; line-height: 1; padding: 5px 9px; border-radius: 99px; white-space: nowrap; }
.sinfo .stag { align-self: flex-start; margin-top: 5px; }
.sess.think .stag { display: inline-flex; color: var(--in-b); background: color-mix(in srgb, var(--in-b) 12%, transparent); }
.sess.human .stag { display: inline-flex; color: var(--note-b); background: color-mix(in srgb, var(--note-b) 14%, transparent); }
.sess.human .stag .dots { display: none; }
@container panel (max-width: 619px) {
  .net { grid-template-columns: minmax(0, 1fr); row-gap: 12px; padding: 16px; }
  .sess.me, .peers, .nopeer { grid-column: 1; }
  .sess.me { max-width: none; }
  .peers { padding-left: 34px; }
  .nopeer { padding-left: 2px; }
}
.dots { display: inline-flex; gap: 3px; align-items: center; }
.dots i { width: 5px; height: 5px; border-radius: 50%; background: currentColor; opacity: .4; }
.on .dots i { animation: wave 1.3s ease-in-out infinite; }
.on .dots i:nth-child(2) { animation-delay: .16s; }
.on .dots i:nth-child(3) { animation-delay: .32s; }
@keyframes wave { 0%, 60%, 100% { translate: 0 0; opacity: .35; } 30% { translate: 0 -3px; opacity: 1; } }
/* 닿지 않는 세션 */
.downs { display: flex; flex-direction: column; gap: 6px; padding: 0 14px 12px; }
.downs:empty { display: none; }
.downrow { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 12.5px; color: var(--warn); padding: 7px 10px; border-radius: 10px; background: color-mix(in srgb, var(--warn) 9%, transparent); }
.downrow > span { flex: 1 1 220px; }
/* 숫자 띠. 칸 너비가 같아서 줄이 맞는다. */
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(108px, 1fr)); border-top: 1px solid var(--line); overflow: hidden; }
.stat { display: flex; flex-direction: column; gap: 1px; min-width: 0; padding: 11px 20px 12px; margin: -1px 0 0 -1px; border-left: 1px solid var(--line); border-top: 1px solid var(--line); font-size: 12px; line-height: 1.4; color: var(--muted); }
.num { display: block; font-weight: 650; font-size: 20px; line-height: 1.25; color: var(--text); font-variant-numeric: tabular-nums; }
.stat.hot, .stat.hot .num { color: var(--note-b); }
.info { display: flex; flex-wrap: wrap; gap: 2px 14px; justify-content: space-between; margin: 0 4px 18px; color: var(--muted); font-size: 12.5px; }
.me, .refresh { margin: 0; }
.offline .refresh { color: var(--warn); font-weight: 600; }

/* 세션이나 분류를 골라 그 대화만 본다 */
.filterbar { display: flex; flex-wrap: wrap; gap: 8px 22px; }
.filters { display: flex; gap: 6px; flex-wrap: wrap; }
.filters[hidden], .wrap[hidden], .room[hidden], .board[hidden] { display: none; }

/* 대화 카드 */
/* 왼쪽에 대화 목록, 오른쪽에 고른 대화 하나. 목록은 화면을 내려도 따라온다. 좁은 화면에서는 목록이 위에 옆으로 놓인다. */
.board { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 16px; align-items: start; margin-top: 14px; }
.pane { grid-column: 2; grid-row: 1; min-width: 0; }
.wrap { position: relative; }
.rooms { grid-column: 1; grid-row: 1; position: sticky; top: 68px; display: flex; flex-direction: column; gap: 6px; max-height: calc(100vh - 84px); overflow-y: auto; padding: 3px; margin: -3px; scrollbar-width: thin; overscroll-behavior: contain; }
.room { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 8px; align-items: center; flex: none; width: 100%; text-align: left; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--line); background: var(--card); cursor: pointer; --ring: var(--muted); }
.on .room { transition: opacity .35s ease-out, translate .45s var(--ease), background-color .15s, border-color .2s; transition-delay: calc(var(--i, 0) * 45ms), calc(var(--i, 0) * 45ms), 0s, 0s; }
.room:hover { border-color: color-mix(in srgb, var(--muted) 45%, var(--line)); }
.room[aria-current=true] { border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); background: color-mix(in srgb, var(--accent) 10%, var(--card)); }
.rtitle { display: flex; gap: 6px; align-items: baseline; min-width: 0; font-size: 13.5px; font-weight: 600; line-height: 1.4; }
.rsub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rcat { flex: none; font-size: 11px; font-weight: 650; line-height: 1.3; padding: 1px 6px; border-radius: 6px; color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
.rcat:empty { display: none; }
.rago { font-size: 11.5px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.rstate { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 12px; line-height: 1.4; color: var(--muted); }
.rstate .sdot { color: var(--ring); }
.rlabel { flex: 0 1 auto; min-width: 0; color: var(--ring); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rwho { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rmarks { display: flex; align-items: center; justify-content: flex-end; gap: 6px; min-height: 12px; }
.rpin { display: none; color: var(--accent); }
.rpin svg { display: block; width: 12px; height: 12px; fill: currentColor; }
.room.pinned .rpin { display: block; }
/* 열어 두지 않은 대화에 새 글이 왔다는 표시 */
.rnew { display: none; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
.room.unseen .rnew { display: block; }
.room.unseen .rago { color: var(--accent); font-weight: 650; }
@media (max-width: 860px) {
  .board { grid-template-columns: minmax(0, 1fr); }
  .pane, .rooms { grid-column: 1; grid-row: auto; }
  .rooms { position: static; flex-direction: row; max-height: none; overflow-x: auto; overflow-y: hidden; scroll-snap-type: x proximity; padding-bottom: 8px; }
  .room { flex: 0 0 min(80%, 300px); scroll-snap-align: start; }
}
.conv { position: relative; background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 16px 18px; box-shadow: var(--shadow); --ring: var(--muted); }
/* 상태마다 빛깔 하나. 카드와 목록의 줄이 같이 쓴다. */
[data-st=waiting_for_peer] { --ring: var(--in-b); }
[data-st=your_turn] { --ring: var(--out-b); }
[data-st=checking_with_your_human], [data-st=peer_checking_with_their_human] { --ring: var(--note-b); }
[data-st=agreed] { --ring: var(--agree-b); }
[data-st=answered], [data-st=answered_by_me] { --ring: var(--out-b); }
[data-st=unread], [data-st=unread_notice] { --ring: var(--note-b); }
.conv:hover { border-color: color-mix(in srgb, var(--muted) 38%, var(--line)); }
.conv.pinned, .conv.pinned:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); }
.on .conv { transition: opacity .35s ease-out, translate .5s var(--ease), border-color .25s; transition-delay: calc(var(--i, 0) * 55ms), calc(var(--i, 0) * 55ms), 0s; }
.head { display: flex; gap: 8px 10px; align-items: flex-start; flex-wrap: wrap; }
/* 질문에 붙은 분류 */
.cat { flex: none; margin-top: 2px; font-size: 11.5px; font-weight: 650; line-height: 1.3; padding: 3px 8px; border-radius: 7px; color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); white-space: nowrap; }
.cat:empty { display: none; }
.subject { font-size: 16px; font-weight: 650; line-height: 1.4; letter-spacing: -.005em; margin: 0; overflow-wrap: anywhere; flex: 1 1 240px; min-width: 0; }
.status { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; line-height: 1.3; padding: 4px 10px; border-radius: 99px; color: var(--ring); background: color-mix(in srgb, var(--ring) 12%, transparent); transition: color .25s, background-color .25s; }
.sdot { position: relative; width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
/* 답이 오간 대화와 합의한 대화는 점 대신 체크로 끝났음을 보인다 */
.ck { display: none; width: 12px; height: 12px; flex: none; fill: none; stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 16; }
.conv[data-st^=answered] .ck, .conv[data-st=agreed] .ck { display: inline; }
.conv[data-st^=answered] .sdot, .conv[data-st=agreed] .sdot { display: none; }
.ago { font-weight: 400; opacity: .85; font-variant-numeric: tabular-nums; }
/* 맨 위에 고정하는 단추. 고정하면 핀이 바로 서고 색이 찬다. */
.pin { flex: none; display: inline-flex; align-items: center; gap: 4px; font-size: 12px; line-height: 1; padding: 5px 8px; border-radius: 8px; border: 1px solid transparent; background: none; color: var(--muted); cursor: pointer; transition: background-color .15s, color .15s, border-color .15s; }
.pin:hover { background: var(--soft); color: var(--text); }
.pin svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linejoin: round; stroke-linecap: round; rotate: 38deg; }
.on .pin svg { transition: rotate .35s var(--ease); }
.pin[aria-pressed=true] { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, transparent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
.pin[aria-pressed=true] svg { rotate: 0deg; fill: currentColor; }
.sub { margin-top: 5px; font-size: 12.5px; line-height: 1.5; color: var(--muted); overflow-wrap: anywhere; }
.badge { font-weight: 650; color: var(--in-b); margin-right: 8px; white-space: nowrap; }
.badge.out { color: var(--out-b); }
/* 여럿에게 보낸 질문: 받은 사람마다 답했는지 */
.people { display: flex; gap: 6px; flex-wrap: wrap; margin: 9px 0 0; }
.people:empty { display: none; }
.pp { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; line-height: 1.3; padding: 3px 9px; border-radius: 99px; border: 1px solid var(--line); color: var(--muted); }
.pp::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.pp.ok { color: var(--out-b); border-color: color-mix(in srgb, var(--out-b) 35%, var(--line)); }
.pp.wait { color: var(--in-b); border-color: color-mix(in srgb, var(--in-b) 35%, var(--line)); }
.pp.human { color: var(--note-b); border-color: color-mix(in srgb, var(--note-b) 35%, var(--line)); }

/* 주고받은 글 */
/* 채팅 내용이 구르는 자리. 넓은 화면에서는 이 안에서만 구른다. */
.scroll { margin-top: 14px; border-top: 1px solid var(--line); }
.scroll:focus-visible { outline-offset: -2px; }
.msgs { list-style: none; margin: 0; padding: 14px 6px 6px 4px; display: flex; flex-direction: column; gap: 10px; }
.msg { max-width: min(86%, 640px); min-width: 0; }
.msg.peer { align-self: flex-start; }
.msg.mine { align-self: flex-end; }
.msg.note { align-self: center; max-width: 92%; }
.msg.agreement { align-self: stretch; max-width: none; margin-top: 4px; }
.on .msg { transition: opacity .3s ease-out, translate .45s var(--ease); transition-delay: calc(var(--i, 0) * 40ms); }
.bubble { position: relative; padding: 9px 13px 10px; border-radius: 14px; background: var(--in); --b: var(--in-b); }
.peer .bubble { border-bottom-left-radius: 5px; }
.mine .bubble { background: var(--out); --b: var(--out-b); border-bottom-right-radius: 5px; }
.note .bubble { background: var(--note); --b: var(--note-b); border-radius: 11px; font-size: 13.5px; padding: 7px 12px 8px; }
.agreement .bubble { background: var(--agree); --b: var(--agree-b); padding: 13px 15px; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--b) 35%, transparent); }
/* 새로 온 글에는 테두리가 잠깐 둘렸다가 사라진다 */
.bubble::after { content: ''; position: absolute; inset: -3px; border-radius: inherit; border: 2px solid var(--b); opacity: 0; pointer-events: none; transition: opacity .9s ease-out; }
.msg.fresh .bubble::after { opacity: .6; transition-duration: .2s; }
.who { display: flex; flex-wrap: wrap; gap: 3px 8px; align-items: center; font-size: 12.5px; font-weight: 650; color: var(--b); }
.av { display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; background: var(--tone, var(--b)); color: var(--card); font-size: 11px; font-weight: 700; flex: none; }
.hum { font-size: 11.5px; padding: 1px 7px; border-radius: 99px; background: color-mix(in srgb, var(--note-b) 18%, transparent); color: var(--note-b); }
.dir { font-weight: 500; color: var(--muted); }
.time { color: var(--muted); font-size: 11.5px; font-weight: 400; font-variant-numeric: tabular-nums; margin-left: auto; }
.text { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 3px; }
/* 글에 붙은 파일: 이름, 온전히 받았는지, 크기와 sha256 */
.files { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.file { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 1px 8px; align-items: center; padding: 6px 10px; border-radius: 9px; background: color-mix(in srgb, var(--card) 60%, transparent); border: 1px solid color-mix(in srgb, var(--b) 22%, transparent); font-size: 12.5px; }
.file svg { width: 14px; height: 14px; fill: none; stroke: var(--b); stroke-width: 1.5; stroke-linejoin: round; stroke-linecap: round; }
.fname { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fstate { font-size: 11.5px; font-weight: 600; color: var(--muted); white-space: nowrap; }
.file.good .fstate { color: var(--ok); }
.file.bad .fstate { color: var(--warn); }
.fmeta { grid-column: 2 / 4; font-size: 11.5px; color: var(--muted); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
details { margin-top: 6px; font-size: 13px; color: var(--muted); }
summary { cursor: pointer; width: fit-content; }
details .text { color: var(--text); }
@supports (interpolate-size: allow-keywords) {
  :root { interpolate-size: allow-keywords; }
  .on details::details-content { block-size: 0; overflow: clip; transition: block-size .3s var(--ease), content-visibility .3s; transition-behavior: allow-discrete; }
  .on details[open]::details-content { block-size: auto; }
}
/* 누군가를 기다리는 동안: 기다리게 하는 쪽에 점 세 개가 뛴다 */
.typing { display: none; align-items: center; gap: 8px; margin-top: 12px; font-size: 12.5px; color: var(--ring); }
.conv.act .typing { display: flex; }
.typing.r { flex-direction: row-reverse; }
.typing .dots { padding: 7px 10px; border-radius: 11px; background: color-mix(in srgb, var(--ring) 12%, transparent); }
.timer { font-variant-numeric: tabular-nums; font-weight: 650; }

/* 아직 대화가 없을 때 */
.empty { display: grid; place-items: center; gap: 10px; padding: 36px 16px 40px; color: var(--muted); text-align: center; font-size: 14px; border: 1px dashed var(--line); border-radius: 16px; }
.empty[hidden] { display: none; }
.empty svg { width: 44px; height: 44px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linejoin: round; stroke-linecap: round; opacity: .6; }

/* 새 소식 알림 */
#toasts { position: fixed; right: 16px; bottom: 16px; z-index: 30; display: flex; flex-direction: column; gap: 8px; width: min(350px, calc(100vw - 32px)); }
.toast { display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; align-items: baseline; text-align: left; padding: 11px 13px 12px; border-radius: 12px; border: 1px solid var(--line); background: var(--card); box-shadow: var(--pop); cursor: pointer; }
.toast .tk { font-size: 12px; font-weight: 700; color: var(--in-b); }
.toast .tk.k-answer { color: var(--out-b); } .toast .tk.k-note, .toast .tk.k-closed { color: var(--note-b); } .toast .tk.k-agreement { color: var(--agree-b); }
.toast .tw { font-size: 12.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toast .ts { grid-column: 1 / -1; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.on .toast { transition: opacity .3s ease-out, translate .45s var(--ease); }
.on .toast.out { opacity: 0; translate: 14px 0; }

/* 접근키 창 */
dialog { border: 1px solid var(--line); border-radius: 16px; padding: 20px 20px 16px; width: min(540px, calc(100vw - 32px)); background: var(--card); color: var(--text); box-shadow: var(--pop); }
dialog::backdrop { background: rgba(8, 9, 14, .5); -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px); }
.on dialog[open] { animation: pop .35s var(--ease); }
.on dialog[open]::backdrop { animation: fade .25s ease-out; }
@keyframes pop { from { opacity: 0; scale: .96; translate: 0 8px; } }
@keyframes fade { from { opacity: 0; } }
dialog h2 { margin: 0 0 6px; font-size: 16px; }
dialog p { margin: 0 0 10px; font-size: 13.5px; color: var(--muted); }
.code { font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; min-height: 3em; max-height: 180px; overflow: auto; padding: 10px 12px; margin-bottom: 10px; border-radius: 10px; border: 1px solid var(--line); background: var(--soft); overflow-wrap: anywhere; -webkit-user-select: all; user-select: all; }
.row { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }

/* 넓고 충분히 높은 화면에서는 화면 전체가 구르지 않는다(2026-11-17, 사람이 정함: 「대화 목록과 채팅 내용이 각각 따로 스크롤」).
   머리와 연결 그림은 그대로 있고, 대화 목록과 채팅 내용이 저마다 따로 구른다. 좁거나 낮은 화면에서는 전처럼 화면 전체가 구른다. */
@media (min-width: 861px) and (min-height: 680px) {
  body { display: flex; flex-direction: column; height: 100vh; height: 100dvh; overflow: hidden; }
  .top { position: static; flex: none; border-bottom-color: var(--line); animation: none; }
  main { flex: 1 1 auto; min-height: 0; width: 100%; display: flex; flex-direction: column; padding-bottom: 16px; }
  .panel, .info, .filterbar { flex: none; }
  /* 채팅 자리를 넓히려고 숫자 줄을 연결 그림 옆에 둔다. 연결된 세션이 많으면 연결 그림 안에서 구른다. */
  .panel { display: grid; grid-template-columns: minmax(0, 1fr) auto; }
  .net { grid-column: 1; grid-row: 1; max-height: 30vh; overflow-y: auto; overscroll-behavior: contain; }
  .stats { grid-column: 2; grid-row: 1; grid-template-columns: repeat(2, minmax(104px, auto)); align-content: center; border-top: 0; border-left: 1px solid var(--line); }
  .stat { padding: 8px 18px; }
  .num { font-size: 17px; }
  .downs { grid-column: 1 / -1; grid-row: 2; }
  .board { flex: 1 1 auto; min-height: 0; align-items: stretch; grid-template-rows: minmax(0, 1fr); }
  .rooms { position: static; max-height: none; min-height: 0; scrollbar-gutter: stable; }
  .pane { display: flex; min-height: 0; }
  .wrap { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; }
  .wrap[hidden] { display: none; }
  .conv { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .head, .sub, .people, .typing { flex: none; }
  .scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; scrollbar-width: thin; }
}

/* 처음 나타날 때의 출발 모습. 맨 바깥에 둬야 브라우저가 읽는다. */
@starting-style {
  .on .conv { opacity: 0; translate: 0 14px; }
  .on .msg { opacity: 0; translate: 0 10px; }
  .on .room { opacity: 0; translate: 0 8px; }
  .on .toast { opacity: 0; translate: 14px 0; }
  .on .sess { opacity: 0; }
  /* 대화를 열 때는 카드만 떠오른다. 안의 글은 따로 움직이지 않는다. */
  .on .wrap.quiet .msg { opacity: 1; translate: none; }
  /* 자리만 옮긴 목록 줄은 다시 나타나는 움직임을 하지 않는다 */
  .on .room.still { opacity: 1; translate: none; }
}
</style>
</head>
<body>
<header class="top">
  <div class="brand">
    <svg class="logo" viewBox="0 0 28 28" aria-hidden="true"><path d="M9 14h10"/><circle class="l1" cx="7" cy="14" r="5"/><circle class="l2" cx="21" cy="14" r="5"/></svg>
    <h1>Coworker <span>대화</span></h1>
  </div>
  <div class="chips">
    <span class="live" id="live"><i class="beacon" aria-hidden="true"></i><span id="liveText">연결하는 중</span></span>
    <button class="chip" id="issue" type="button">접근키 발급</button>
    <button class="chip" id="follow" type="button">새 글 따라가기 끄기</button>
    <button class="chip" id="motion" type="button">모션 끄기</button>
  </div>
</header>
<main>
  <section class="panel" aria-label="연결 상태">
    <div class="net" id="net">
      <svg id="wires" aria-hidden="true"></svg>
      <div class="peers" id="peers"></div>
      <p class="nopeer" id="nopeer" hidden>아직 연결된 세션이 없습니다. 「접근키 발급」으로 동료를 초대할 수 있습니다.</p>
    </div>
    <div class="downs" id="downs"></div>
    <div class="stats" id="stats"></div>
  </section>
  <div class="info">
    <p class="me" id="me"></p>
    <p class="refresh" id="refresh" role="status"></p>
  </div>
  <div class="filterbar">
    <div class="filters" id="filters" role="group" aria-label="세션을 골라 보기" hidden></div>
    <div class="filters" id="cats" role="group" aria-label="분류를 골라 보기" hidden></div>
  </div>
  <p class="plain" id="said" role="status"></p>
  <div class="board" id="board" hidden>
    <nav class="rooms" id="rooms" aria-label="대화 목록"></nav>
    <div class="pane" id="pane"></div>
  </div>
  <div class="empty" id="empty" hidden>
    <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M8 12a4 4 0 0 1 4-4h18a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H19l-7 6v-6a4 4 0 0 1-4-4z"/><path d="M38 19a4 4 0 0 1 2 3.5V32a4 4 0 0 1-4 4v5l-6-5h-8"/></svg>
    <div id="emptyText">아직 주고받은 질문이 없습니다.</div>
  </div>
</main>
<dialog id="keybox" aria-labelledby="keytitle">
  <h2 id="keytitle">접근키 (연결 코드)</h2>
  <p id="keyhelp"></p>
  <div class="row" id="keykinds" hidden>
    <button class="chip main" id="keygroup" type="button">동료용 접근키 만들기</button>
    <button class="chip main" id="keyoutside" type="button">외부용 접근키 만들기</button>
  </div>
  <div class="code" id="keycode" tabindex="0"></div>
  <p id="keyinfo" role="status"></p>
  <div class="row">
    <button class="chip main" id="keycopy" type="button">복사</button>
    <button class="chip" id="keyagain" type="button">새로 만들기</button>
    <button class="chip" id="keyclose" type="button">닫기</button>
  </div>
</dialog>
<div id="toasts" role="log" aria-live="polite"></div>
<script>
const KIND = { question: '질문', answer: '답', note: '알림', closed: '마감', agreement: '합의문' }
// 대화가 지금 어디에 와 있는지. 대화는 대개 합의문 없이 질문과 답으로 끝난다. 그래서 세션이 알려 주는 「차례」를
// 그대로 쓰지 않고, 마지막으로 오간 글을 본다: 질문이면 답을 기다리는 중이고, 답이면 끝난 것으로 차분하게 보인다.
const PHASE = {
  waiting_for_peer: '답 기다리는 중',
  your_turn: '답할 차례',
  checking_with_your_human: '이쪽 사람에게 확인 중',
  peer_checking_with_their_human: '상대가 자기 사람에게 확인 중',
  unread: '새 질문 · AI가 아직 읽지 않음',
  unread_notice: '새 알림 · AI가 아직 읽지 않음',
  notice: '알림 받음 · 답 필요 없음',
  notice_sent: '알림 보냄 · 답 필요 없음',
  read_no_answer: '읽음 · 답 없음',
  no_answer_yet: '아직 답 없음',
  answered: '답 받음',
  answered_by_me: '답 보냄',
  closed: '마감 · 다른 사람이 먼저 답함',
  agreed: '합의문 작성됨',
}
// 누군가를 기다리는 단계. 상태 점 둘레로 고리가 퍼지고, 기다리게 하는 쪽에 점 세 개가 뛴다.
const WAIT = {
  waiting_for_peer: '상대의 답을 기다리는 중',
  your_turn: '이쪽 AI가 답할 차례',
  unread: '이쪽 AI가 아직 읽지 않았습니다',
  unread_notice: '이쪽 AI가 아직 읽지 않았습니다',
  checking_with_your_human: '이쪽 사람의 결정을 기다리는 중',
  peer_checking_with_their_human: '상대 쪽 사람의 결정을 기다리는 중',
}
// 답이 필요 없는 알림도 질문으로 온다. 그래서 답 없이 이만큼 지난 질문은 더 돌리지 않고 조용히 둔다.
// 다만 이쪽 AI가 아직 읽지 않은 질문은 오래돼도 눈에 띄게 둔다.
const QUIET_MS = Number(new URLSearchParams(location.search).get('quiet')) || ${QUIET_AFTER_MS}
let unread = new Set()
// 마지막으로 오간 글. 알림은 건너뛴다.
function lastTurn(c) {
  for (let i = c.messages.length - 1; i >= 0; i--) if (c.messages[i].kind === 'question' || c.messages[i].kind === 'answer') return c.messages[i]
  return null
}
function phase(c) {
  if (c.status !== 'waiting_for_peer' && c.status !== 'your_turn') return c.status
  const m = lastTurn(c)
  if (!m) return c.status
  if (m.kind === 'answer') return m.from === 'me' ? 'answered_by_me' : 'answered'
  // 보낸 쪽이 「답 필요 없음」으로 표시한 알림. 아무도 답을 기다리지 않는다. 받은 쪽은 답해도 되고, 답하면 여느 대화처럼 이어진다.
  if (m.noAnswer) return m.from === 'me' ? 'notice_sent' : unread.has(c.id) ? 'unread_notice' : 'notice'
  const quiet = Date.now() - Date.parse(m.at) > QUIET_MS
  if (m.from === 'me') return quiet ? 'no_answer_yet' : 'waiting_for_peer'
  if (unread.has(c.id)) return 'unread'
  return quiet ? 'read_no_answer' : 'your_turn'
}
const ANSWERS = { all: '모두 답', one: '한 명만 답' }
// 움직임에 쓰는 빠르기 곡선. 빨리 나가서 부드럽게 멎는다. 튀어 넘지 않는다.
const EASE = 'cubic-bezier(.22, 1, .36, 1)'
const root = document.documentElement
const byId = id => document.getElementById(id)
const time = at => new Date(at).toLocaleString('ko-KR', { hour12: false })
// 글마다 붙는 짧은 시각. 오늘 것이 아니면 날짜를 앞에 붙인다.
function shortTime(at) {
  const d = new Date(at)
  const hms = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
  return d.toDateString() === new Date().toDateString() ? hms : d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' }) + ' ' + hms
}
const kindOf = kind => (KIND[kind] ? kind : 'note')
function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}
function put(node, text) {
  if (node.textContent !== text) node.textContent = text
}
function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000) || 0)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s % 60).padStart(2, '0')
}
function ago(ms) {
  const s = Math.floor(ms / 1000) || 0
  if (s < 5) return '방금'
  if (s < 60) return s + '초 전'
  if (s < 3600) return Math.floor(s / 60) + '분 전'
  if (s < 86400) return Math.floor(s / 3600) + '시간 전'
  return Math.floor(s / 86400) + '일 전'
}

// 움직임을 켤지. 사람이 단추로 정한 것이 먼저고, 없으면 PC의 「동작 줄이기」 설정을 따른다.
const saved = {
  get(key) { try { return localStorage.getItem(key) } catch (e) { return null } },
  set(key, value) { try { localStorage.setItem(key, value) } catch (e) {} },
}
const reduce = matchMedia('(prefers-reduced-motion: reduce)')
let motionPref = saved.get('coworker.motion')
const moving = () => (motionPref ? motionPref === 'on' : !reduce.matches)
// 한 번 하고 끝나는 움직임. 움직임을 껐으면 아무것도 하지 않는다.
function fx(node, frames, options) {
  if (!moving() || !node.animate) return null
  try { return node.animate(frames, options) } catch (e) { return null }
}

const pane = byId('pane'), rooms = byId('rooms'), board = byId('board')
// 오른쪽에 열어 둔 대화. 사람이 왼쪽 목록에서 고르거나, 새 글이 오면 그 대화로 바뀐다.
let active = ''
const empty = byId('empty')
const toasts = byId('toasts')
const cards = new Map()

// 새로 온 글에 테두리를 잠깐 둘러 어디가 바뀌었는지 보인다.
function mark(node) {
  node.classList.add('fresh')
  clearTimeout(node.unmark)
  node.unmark = setTimeout(() => node.classList.remove('fresh'), 1800)
}
function reveal(node) {
  node.scrollIntoView({ block: 'center', behavior: moving() ? 'smooth' : 'auto' })
  mark(node)
}

// 연결 그림. 왼쪽이 이 세션이고, 연결된 세션이 오른쪽에 줄지어 선다. 선이 둘을 잇는다.
// 글이 오가면 그 선을 따라 점 하나가 보낸 쪽에서 받은 쪽으로 건너가고, 닿은 쪽 둘레에 고리가 한 번 퍼진다.
// 답할 차례인 쪽에는 점 세 개가, 사람에게 확인 중인 쪽에는 이름표가 붙는다.
// 세션을 누르면 그 세션이 들어 있는 대화만 보인다. 다시 누르면 모두 보인다.
const ME = ':me'
const net = (() => {
  const box = byId('net'), wires = byId('wires'), peersBox = byId('peers'), nopeer = byId('nopeer')
  const NS = 'http://www.w3.org/2000/svg'
  const tiles = new Map(), tones = new Map()
  // 세션마다 빛깔 하나. 여럿이 있는 방의 글에도 같은 빛깔을 쓴다.
  const toneOf = key => {
    if (!tones.has(key)) tones.set(key, 'var(--t' + ((tones.size % 6) + 1) + ')')
    return tones.get(key)
  }
  function tile(key, kind) {
    let t = tiles.get(key)
    if (t) return t
    const node = el(kind === 'peer' ? 'button' : 'div', 'sess ' + kind)
    const avatar = el('span', 'avatar'), ini = el('span'), ring = el('i', 'ring'), info = el('span', 'sinfo'), name = el('span', 'sname'), sub = el('span', 'ssub'), about = el('span', 'ssub')
    const tag = el('span', 'stag'), dots = el('span', 'dots'), tagText = el('span')
    avatar.setAttribute('aria-hidden', 'true')
    avatar.append(ini, ring, el('i', 'st'))
    dots.setAttribute('aria-hidden', 'true')
    dots.append(el('i'), el('i'), el('i'))
    tag.append(dots, tagText)
    info.append(name, sub)
    node.append(avatar, info)
    let wire = null
    if (kind === 'me') {
      info.append(about, tag)
      box.insertBefore(node, peersBox)
    } else {
      node.append(tag)
      node.style.setProperty('--tone', toneOf(key))
      wire = document.createElementNS(NS, 'path')
      wire.setAttribute('class', kind === 'ghost' ? 'wire ghost' : 'wire')
      wires.append(wire)
    }
    if (kind === 'peer') {
      node.type = 'button'
      node.setAttribute('aria-pressed', 'false')
      node.addEventListener('click', () => setFilter(key))
    }
    t = { key, kind, node, avatar, ini, ring, name, sub, about, tagText, wire, drawn: false }
    tiles.set(key, t)
    return t
  }
  function drop(t) {
    tiles.delete(t.key)
    t.node.remove()
    if (t.wire) t.wire.remove()
  }
  function fill(t, name, sub, about) {
    put(t.ini, (Array.from(name.trim())[0] || '?').toUpperCase())
    put(t.name, name)
    put(t.sub, sub)
    put(t.about, about)
    const full = [name, sub, about].filter(Boolean).join(' · ')
    if (t.node.title !== full) t.node.title = full
  }
  // 선을 다시 긋는다. 넓으면 옆으로 휘어 잇고, 좁아서 세션이 아래로 내려가면 나뭇가지처럼 꺾어 잇는다.
  // 자리는 한꺼번에 재고, 그 뒤에 한꺼번에 그린다.
  function layout() {
    const me = tiles.get(ME)
    if (!me || !box.clientWidth) return
    const tree = peersBox.offsetTop >= me.node.offsetTop + me.node.offsetHeight - 2
    const hx = me.node.offsetLeft + me.avatar.offsetLeft + me.avatar.offsetWidth / 2, hy = me.node.offsetTop + me.avatar.offsetTop + me.avatar.offsetHeight + 7
    const sx = me.node.offsetLeft + me.node.offsetWidth + 12, sy = me.node.offsetTop + me.node.offsetHeight / 2
    const jobs = []
    for (const t of tiles.values()) if (t.wire) jobs.push([t, t.node.offsetLeft + t.avatar.offsetLeft - 8, t.node.offsetTop + t.avatar.offsetTop + t.avatar.offsetHeight / 2])
    const f = n => n.toFixed(1)
    for (const [t, x2, y2] of jobs) {
      let d = ''
      if (tree) {
        const r = Math.max(0, Math.min(10, x2 - hx, y2 - hy))
        d = 'M' + f(hx) + ' ' + f(hy) + 'V' + f(y2 - r) + 'Q' + f(hx) + ' ' + f(y2) + ' ' + f(hx + r) + ' ' + f(y2) + 'H' + f(x2)
      } else if (x2 > sx) {
        const k = (x2 - sx) * .5
        d = 'M' + f(sx) + ' ' + f(sy) + 'C' + f(sx + k) + ' ' + f(sy) + ' ' + f(x2 - k) + ' ' + f(y2) + ' ' + f(x2) + ' ' + f(y2)
      }
      if (t.wire.getAttribute('d') !== d) t.wire.setAttribute('d', d)
      // 새로 이어진 세션은 선이 한 번 그어지며 나타난다.
      if (d && !t.drawn) {
        t.drawn = true
        const length = t.wire.getTotalLength()
        fx(t.wire, [{ strokeDasharray: length + ' ' + length, strokeDashoffset: length }, { strokeDasharray: length + ' ' + length, strokeDashoffset: 0 }], { duration: 700, easing: EASE })
      }
    }
  }
  new ResizeObserver(layout).observe(box)

  return {
    tone: toneOf,
    update(data, convs) {
      const me = tile(ME, 'me'), want = new Set([ME]), act = new Map(), order = []
      // 누가 답할 차례인지(think), 누가 사람에게 묻는 중인지(human), 그리고 그 일이 선의 어느 쪽에 가 있는지(toward: 상대 쪽이면 fwd, 이쪽이면 back).
      const toward = new Map()
      const flag = (key, what) => act.set(key, Object.assign(act.get(key) || {}, { [what]: true }))
      for (const c of convs) {
        const ph = phase(c)
        if (ph === 'waiting_for_peer') flag(c.peer, 'think')
        else if (ph === 'your_turn' || ph === 'unread' || ph === 'unread_notice') flag(ME, 'think')
        else if (ph === 'checking_with_your_human') flag(ME, 'human')
        else if (ph === 'peer_checking_with_their_human') flag(c.peer, 'human')
        if (ph === 'waiting_for_peer' || ph === 'peer_checking_with_their_human') toward.set(c.peer, 'fwd')
        else if (WAIT[ph] && !toward.has(c.peer)) toward.set(c.peer, 'back')
      }
      const who = about => (about ? [about.app, about.model, about.effort].filter(Boolean).join(' · ') : '')
      fill(me, data.me.name, data.me.open ? (data.me.outside_only ? '이 세션 · 외부용 전용' : '이 세션 · 포트 ' + data.me.port) : '이 세션 · 브릿지 닫힘', who(data.me.about))
      me.node.classList.toggle('closed', !data.me.open)
      for (const l of (data.links || []).slice(0, 16)) {
        const t = tile(l.key, 'peer'), down = l.state !== 'connected'
        want.add(l.key)
        order.push(t)
        t.node.classList.toggle('down', down)
        t.wire.classList.toggle('down', down)
        const state = down ? '다시 붙는 중' : l.via === 'relay' ? '중계로 연결됨' : l.via === 'pickup' ? '상대가 가져가는 중' : '연결됨'
        fill(t, l.name, [state, who(l.about)].filter(Boolean).join(' · '), '')
      }
      for (const c of (data.connecting || []).slice(0, 4)) {
        const key = ':in:' + c.name, t = tile(key, 'ghost')
        want.add(key)
        order.push(t)
        fill(t, c.name, '소개받는 중', '')
      }
      for (const t of [...tiles.values()]) {
        if (!want.has(t.key)) {
          drop(t)
          continue
        }
        const a = act.get(t.key) || {}
        t.node.classList.toggle('human', !!a.human)
        t.node.classList.toggle('think', !!a.think && !a.human)
        put(t.tagText, a.human ? '사람 확인 중' : a.think ? '답할 차례' : '')
        if (t.wire) {
          t.wire.classList.toggle('fwd', toward.get(t.key) === 'fwd')
          t.wire.classList.toggle('back', toward.get(t.key) === 'back')
        }
      }
      // 줄 선 차례를 맞춘다. 달라진 것만 옮긴다(옮기면 누르던 단추가 초점을 잃는다).
      let at = peersBox.firstElementChild
      for (const t of order) {
        if (t.node === at) at = at.nextElementSibling
        else peersBox.insertBefore(t.node, at)
      }
      nopeer.hidden = order.length > 0
      layout()
    },
    // 글 하나가 from 에서 to 로 건너간다. 닿으면 받은 쪽 둘레에 고리가 한 번 퍼진다.
    send(from, to, kind, delay) {
      const target = tiles.get(to), via = tiles.get(from === ME ? to : from)
      if (!target || !moving()) return
      const color = 'var(--' + (kind === 'answer' ? 'out-b' : kind === 'agreement' ? 'agree-b' : kind === 'question' ? 'in-b' : 'note-b') + ')'
      const land = () => {
        target.ring.style.setProperty('--c', color)
        fx(target.ring, [{ opacity: .75, scale: 1 }, { opacity: 0, scale: 1.75 }], { duration: 700, easing: 'ease-out' })
      }
      const wire = via && via.wire
      if (!wire || !wire.getAttribute('d')) return void setTimeout(land, delay || 0)
      const length = wire.getTotalLength(), steps = 14, frames = []
      for (let i = 0; i <= steps; i++) {
        const p = wire.getPointAtLength(length * (from === ME ? i / steps : 1 - i / steps))
        // 떠날 때 나타나고, 닿기 조금 전부터 옅어진다.
        frames.push({ transform: 'translate(' + p.x.toFixed(1) + 'px, ' + p.y.toFixed(1) + 'px)', opacity: i === 0 || i === steps ? 0 : i === steps - 1 ? .5 : 1 })
      }
      const dot = document.createElementNS(NS, 'circle')
      dot.setAttribute('class', 'spark')
      dot.setAttribute('r', '3.5')
      dot.style.setProperty('--c', color)
      wires.append(dot)
      // 시작 전과 끝난 뒤에는 보이지 않게 양쪽 끝 모습을 붙들어 둔다(fill: both). 끝나면 점을 지운다.
      const run = dot.animate(frames, { duration: 800, delay: delay || 0, easing: 'cubic-bezier(.45, 0, .2, 1)', fill: 'both' })
      let landed = false
      const done = () => {
        if (landed) return
        landed = true
        dot.remove()
        land()
      }
      run.finished.then(done, done)
      // 끝났다는 알림이 오지 않아도 점이 남지 않게 한다. 화면이 가려져 움직임이 늦게 시작할 수 있으므로 넉넉히 기다린다.
      setTimeout(done, (delay || 0) + 4000)
    },
    // 골라 둔 세션과 그 선을 도드라지게 한다.
    select(key) {
      for (const t of tiles.values()) {
        const on = !!key && t.key === key
        if (t.kind === 'peer') t.node.setAttribute('aria-pressed', String(on))
        if (t.wire) t.wire.classList.toggle('sel', on)
      }
    },
  }
})()

// 숫자 띠. 값이 바뀌면 새 숫자가 아래에서 살짝 올라온다.
const stats = (() => {
  const box = byId('stats'), made = {}
  return {
    set(key, label, n, hot) {
      let s = made[key]
      if (!s) {
        s = made[key] = { wrap: el('div', 'stat'), text: el('span'), num: el('b', 'num'), value: null }
        s.wrap.append(s.text, s.num)
        box.append(s.wrap)
      }
      put(s.text, label)
      s.wrap.classList.toggle('hot', !!hot)
      const value = String(n)
      if (s.value === value) return
      if (s.value !== null) fx(s.num, [{ opacity: 0, translate: '0 7px' }, { opacity: 1, translate: '0 0' }], { duration: 320, easing: EASE })
      s.value = value
      s.num.textContent = value
    },
  }
})()

// 목록의 차례가 바뀌면 줄이 옛 자리에서 새 자리로 미끄러져 온다. 바꾸기 전에 자리를 재 두고(measure), 바꾼 뒤에 맞춘다(settle).
// 재는 일과 움직이는 일을 섞지 않는다: 먼저 다 재고, 그 뒤에 다 움직인다.
function measure() {
  const before = new Map()
  if (moving())
    for (const v of cards.values())
      if (!v.item.hidden) {
        const r = v.item.getBoundingClientRect()
        before.set(v, [r.left, r.top])
      }
  return before
}
function settle(before) {
  const moved = [], far = Math.max(innerWidth, innerHeight)
  for (const v of before.keys()) if (v.slide) v.slide.cancel()
  for (const [v, at] of before)
    if (v.item.isConnected && !v.item.hidden) {
      const r = v.item.getBoundingClientRect()
      moved.push([v, at[0] - r.left, at[1] - r.top])
    }
  // 아주 멀리 가는 줄은 화면 크기만큼만 미끄러진다.
  const cap = n => Math.max(-far, Math.min(far, n)).toFixed(1)
  for (const [v, dx, dy] of moved)
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) v.slide = v.item.animate([{ translate: cap(dx) + 'px ' + cap(dy) + 'px' }, { translate: '0 0' }], { duration: 480, easing: EASE })
}
// 목록의 줄을 정한 차례대로 놓는다. 있는 줄은 다시 만들지 않고 자리만 옮긴다.
// moveBefore 로 옮기면 초점과 돌던 움직임이 그대로 남는다. 그것이 없는 브라우저에서는 떼었다 붙이므로,
// 나타나는 움직임이 다시 돌지 않게 표시(still)를 잠깐 붙이고 초점을 되돌린다.
function place(order) {
  const held = document.activeElement, canMove = Object.hasOwn(Element.prototype, 'moveBefore'), stills = []
  let at = rooms.firstElementChild
  for (const item of order) {
    if (item === at) {
      at = at.nextElementSibling
      continue
    }
    if (item.parentNode !== rooms) rooms.insertBefore(item, at)
    else if (canMove) rooms.moveBefore(item, at)
    else {
      item.classList.add('still')
      stills.push(item)
      rooms.insertBefore(item, at)
    }
  }
  // 다시 붙인 줄의 스타일을 여기서 한 번 계산하게 한다. 그러면 출발 모습을 그 자리에서 지나가므로 표시를 바로 뗄 수 있다.
  for (const item of stills) getComputedStyle(item).opacity
  for (const item of stills) item.classList.remove('still')
  if (held && held !== document.activeElement && rooms.contains(held)) held.focus({ preventScroll: true })
}
// 목록 안에서만 굴려서 그 줄이 보이게 한다. 화면 전체는 건드리지 않는다.
function showItem(item) {
  const a = item.getBoundingClientRect(), b = rooms.getBoundingClientRect()
  const dx = a.left < b.left ? a.left - b.left : a.right > b.right ? a.right - b.right : 0
  const dy = a.top < b.top ? a.top - b.top : a.bottom > b.bottom ? a.bottom - b.bottom : 0
  if (dx || dy) rooms.scrollBy({ left: dx, top: dy, behavior: moving() ? 'smooth' : 'auto' })
}
// 채팅 내용을 맨 아래(가장 새 글)로 내린다. 넓은 화면에서는 채팅 내용만 따로 구른다.
// 화면 전체가 구르는 좁은 화면에서는, 새 글이 왔을 때(arrived)만 그 글이 보이게 화면을 옮긴다.
// 채팅 내용이 그 자리 안에서 구르는지 본다. 구를 것이 있을 때만 키보드로 닿는 자리로 둔다.
function canScroll(v) {
  const can = v.scroll.scrollHeight > v.scroll.clientHeight + 1
  if (can) v.scroll.tabIndex = 0
  else v.scroll.removeAttribute('tabindex')
  return can
}
function toBottom(v, arrived) {
  const how = arrived && moving() ? 'smooth' : 'auto'
  if (canScroll(v)) v.scroll.scrollTo({ top: v.scroll.scrollHeight, behavior: how })
  else if (arrived && v.msgs.lastElementChild) v.msgs.lastElementChild.scrollIntoView({ block: 'nearest', behavior: how })
}
// 창 크기가 바뀌면 구르는 자리가 생기거나 없어진다.
addEventListener('resize', () => {
  const v = cards.get(active)
  if (v) canScroll(v)
})
// 오른쪽에 열 대화를 고른다. 열리는 대화는 카드만 떠오르고, 안의 글은 따로 움직이지 않는다. 열면 가장 새 글이 보인다.
// byHand: 사람이 목록에서 골랐다. 긴 대화를 읽다가 다른 대화로 가도 처음부터 보이게 화면을 올린다.
function activate(id, byHand) {
  const next = cards.get(id)
  if (!next) return
  active = id
  for (const v of cards.values()) {
    const on = v === next
    v.item.setAttribute('aria-current', String(on))
    if (on && v.wrap.hidden) {
      v.wrap.classList.add('quiet')
      v.wrap.hidden = false
      for (const node of v.msgs.children) getComputedStyle(node).opacity
      v.wrap.classList.remove('quiet')
    } else if (!on && !v.wrap.hidden) v.wrap.hidden = true
  }
  if (next.unseen) {
    next.unseen = false
    next.item.classList.remove('unseen')
  }
  showItem(next.item)
  toBottom(next, false)
  if (byHand) {
    const top = next.wrap.getBoundingClientRect().top
    if (top < 60) scrollBy({ top: top - 76, behavior: moving() ? 'smooth' : 'auto' })
  }
}
// 세션이 요청을 받지 않은 까닭을 사람이 읽을 말로 바꾼다. 세션이 답했으면 세션이 꺼졌다고 하지 않는다.
// 화면을 연 주소 때문에 거절됐으면(403), 세션이 알려 준 주소로 다시 열라고 한다.
const UNREACHED = '세션에 닿지 않습니다. 세션이 켜져 있는지 확인하세요.'
async function whyNot(res, cannot) {
  if (res.status === 409) return '브릿지가 닫혀 있어서 만들 수 없습니다. AI에게 「브릿지 열어줘」라고 하세요.'
  if (res.status === 429) return '잠시 뒤에 다시 눌러 주세요.'
  if (res.status === 403) {
    const told = await res.json().catch(() => null)
    const open = told && Array.isArray(told.open) ? told.open.filter(o => typeof o === 'string') : []
    if (open.length) return '이 화면을 연 주소(' + location.origin + ')로는 ' + cannot + '. 이 주소로 다시 여세요: ' + open.map(o => o + location.pathname).join(' 또는 ')
  }
  return '세션이 이 요청을 받지 않았습니다(응답 ' + res.status + ').'
}
// 대화를 맨 위에 고정하거나 푼다. 세션이 기억하고, 바뀐 차례는 세션이 밀어 주는 새 내용으로 그려진다.
// 읽어 주는 프로그램에는 결과를 한 번만 알린다.
const said = byId('said')
async function togglePin(v) {
  const want = !v.pinned
  let ok = false, why = UNREACHED
  try {
    const res = await fetch(location.pathname + '/pin', { method: 'POST', headers: { 'x-coworker-viewer': '1', 'content-type': 'application/json' }, body: JSON.stringify({ threads: v.threads, pinned: want }) })
    ok = res.ok
    if (!ok) why = await whyNot(res, '고정을 바꿀 수 없습니다')
  } catch (e) {}
  said.textContent = !ok ? why : '「' + v.subject.textContent + '」 대화' + (want ? '를 맨 위에 고정했습니다.' : '의 고정을 풀었습니다.')
}
const PIN_PATH = 'M5.5 2h5v1.2l-1 .8v3.2l2 1.8v1H8.6V14L8 15.2 7.4 14v-4H4.5V9l2-1.8V4l-1-.8z'

function toast(n) {
  const b = el('button', 'toast')
  b.type = 'button'
  b.append(
    el('span', 'tk k-' + (n.m.noAnswer ? 'note' : kindOf(n.m.kind)), '새 ' + (n.m.noAnswer ? '알림' : KIND[n.m.kind] ?? n.m.kind)),
    el('span', 'tw', (n.m.from === 'me' ? '나 → ' + n.c.peerName : n.c.peerName + ' → 나') + (n.c.category ? ' · ' + n.c.category : '')),
    el('span', 'ts', n.c.subject),
  )
  b.addEventListener('click', () => {
    activate(n.v.id, false)
    reveal(n.node)
    dismiss(b)
  })
  toasts.append(b)
  while (toasts.children.length > 4) toasts.firstChild.remove()
  setTimeout(() => dismiss(b), 5200)
}
// 사라지는 움직임이 끝난 뒤에 지운다. 움직임이 없으면 바로 지운다.
async function dismiss(b) {
  if (!b.isConnected || b.classList.contains('out')) return
  b.classList.add('out')
  const running = (b.getAnimations ? b.getAnimations() : []).filter(a => a.transitionProperty)
  if (running.length) await Promise.race([Promise.allSettled(running.map(a => a.finished)), new Promise(r => setTimeout(r, 900))])
  b.remove()
}
function makeCard(id) {
  const wrap = el('div', 'wrap'), card = el('section', 'conv'), head = el('div', 'head')
  const cat = el('span', 'cat'), subject = el('h2', 'subject'), status = el('span', 'status'), stext = el('span'), agoEl = el('span', 'ago')
  const SVG = 'http://www.w3.org/2000/svg'
  const icon = (cls, d) => {
    const svg = document.createElementNS(SVG, 'svg'), path = document.createElementNS(SVG, 'path')
    if (cls) svg.setAttribute('class', cls)
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('aria-hidden', 'true')
    path.setAttribute('d', d)
    svg.append(path)
    return svg
  }
  const ck = icon('ck', 'M3 8.5l3.2 3L13 4.5')
  status.append(el('i', 'sdot'), ck, stext, agoEl)
  // 맨 위에 고정하는 단추. 이름은 그대로 두고, 눌린 상태로 지금 고정돼 있는지를 알린다.
  const pin = el('button', 'pin')
  pin.type = 'button'
  pin.setAttribute('aria-pressed', 'false')
  pin.title = '맨 위에 고정'
  pin.append(icon('', PIN_PATH), el('span', '', '고정'))
  head.append(cat, subject, status, pin)
  const sub = el('div', 'sub'), badge = el('span', 'badge'), meta = el('span', 'meta')
  sub.append(badge, meta)
  const people = el('div', 'people'), msgs = el('ol', 'msgs'), typing = el('div', 'typing'), dots = el('span', 'dots'), tlabel = el('span'), timer = el('span', 'timer')
  dots.append(el('i'), el('i'), el('i'))
  dots.setAttribute('aria-hidden', 'true')
  typing.append(dots, tlabel, timer)
  // 채팅 내용이 구르는 자리. 맨 아래가 가장 새 글이다.
  const scroll = el('div', 'scroll')
  scroll.setAttribute('role', 'region')
  scroll.setAttribute('aria-label', '주고받은 글')
  scroll.append(msgs)
  card.append(head, sub, people, scroll, typing)
  wrap.append(card)
  wrap.hidden = true
  // 왼쪽 목록의 한 줄: 분류와 제목, 마지막 글의 때, 상태, 상대, 그리고 고정했는지와 새 글이 왔는지. 누르면 이 대화가 열린다.
  const item = el('button', 'room'), ititle = el('span', 'rtitle'), icat = el('span', 'rcat'), isub = el('span', 'rsub'), iago = el('span', 'rago')
  const istate = el('span', 'rstate'), ilabel = el('span', 'rlabel'), iwho = el('span', 'rwho'), imarks = el('span', 'rmarks'), ipin = el('span', 'rpin'), inew = el('span', 'rnew')
  item.type = 'button'
  item.dataset.id = id
  item.setAttribute('aria-current', 'false')
  ititle.append(icat, isub)
  iago.dataset.pre = ''
  istate.append(el('i', 'sdot'), ilabel, iwho)
  ipin.append(icon('', PIN_PATH), el('span', 'plain', '고정됨'))
  inew.append(el('span', 'plain', '새 글'))
  imarks.append(ipin, inew)
  item.append(ititle, iago, istate, imarks)
  const v = { id, wrap, card, badge, cat, subject, status, stext, tick: ck.firstChild, pin, ago: agoEl, meta, people, msgs, scroll, stuck: false, typing, tlabel, timer, item, icat, isub, iago, ilabel, iwho, unseen: false, seen: new Map(), st: undefined, label: '', peers: [], category: '', threads: [], pinned: false }
  pin.addEventListener('click', () => togglePin(v))
  item.addEventListener('click', () => activate(id, true))
  return v
}
// 글에 붙은 파일. 이름, 크기, sha256 앞부분, 그리고 온전히 받았는지를 보인다. 받은 파일에는 저장한 자리도 적는다.
// 보낸 파일은 상대가 받아서 확인하면 표시가 바뀐다. 그래서 글을 그릴 때마다 달라졌는지 본다.
const FILE_WHY = { incomplete: '다 오지 않음', size: '크기가 다름', sha256: 'sha256이 다름', limit: '크기 한도를 넘음', no_folder: '저장할 폴더가 없음' }
const CLIP_PATH = 'M13.2 7.4l-5 5a3 3 0 0 1-4.3-4.3l5.3-5.3a2 2 0 0 1 2.9 2.9l-5.3 5.3a1 1 0 0 1-1.5-1.5l4.9-4.9'
function howBig(n) {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}
function syncFiles(li, m) {
  const files = Array.isArray(m.files) ? m.files : [], sig = files.length ? JSON.stringify(files) : ''
  if ((li.dataset.files || '') === sig) return
  li.dataset.files = sig
  if (li.files) li.files.remove()
  li.files = null
  if (!files.length) return
  const box = el('ul', 'files'), mine = m.from === 'me', SVG = 'http://www.w3.org/2000/svg'
  for (const f of files) {
    const row = el('li', 'file' + (f.ok === true ? ' good' : f.ok === false ? ' bad' : ''))
    const clip = document.createElementNS(SVG, 'svg'), path = document.createElementNS(SVG, 'path')
    clip.setAttribute('viewBox', '0 0 16 16')
    clip.setAttribute('aria-hidden', 'true')
    path.setAttribute('d', CLIP_PATH)
    clip.append(path)
    const state = f.ok === true ? (mine ? '상대가 받아서 확인함' : '저장함 · sha256 확인됨') : f.ok === false ? (mine ? '상대가 받지 못함 · ' : '받지 못함 · ') + (FILE_WHY[f.problem] || '확인 실패') : mine ? '보냄 · 확인 기다리는 중' : ''
    const where = !mine && f.path ? ' · ' + f.path : ''
    row.append(clip, el('span', 'fname', String(f.name)), el('span', 'fstate', state), el('span', 'fmeta', howBig(Number(f.size) || 0) + ' · sha256 ' + String(f.sha256).slice(0, 16) + '…' + where))
    row.title = 'sha256 ' + f.sha256 + (f.path ? ' · ' + f.path : '')
    box.append(row)
  }
  li.firstChild.append(box)
  li.files = box
}
function bubble(c, m, everyone) {
  const cls = m.kind === 'agreement' ? 'agreement' : m.kind === 'note' || m.kind === 'closed' ? 'note' : m.from === 'me' ? 'mine' : 'peer'
  const li = el('li', 'msg ' + cls), b = el('div', 'bubble'), who = el('div', 'who'), at = el('time', 'time', shortTime(m.at))
  at.dateTime = m.at
  at.title = time(m.at)
  // 여럿이 있는 방에서는 누가 한 말인지 이름 첫 글자를 붙인다. 빛깔은 연결 그림의 그 세션과 같다.
  if (everyone && m.from !== 'me') {
    const av = el('span', 'av', (Array.from(c.peerName.trim())[0] || '?').toUpperCase())
    av.style.setProperty('--tone', net.tone(c.peer))
    who.append(av)
  }
  who.append(el('span', '', m.noAnswer ? '알림 · 답 필요 없음' : KIND[m.kind] ?? m.kind))
  if (m.human) who.append(el('span', 'hum', '사람이 정함'))
  const shared = everyone && m.from === 'me' && m.kind === 'question'
  who.append(el('span', 'dir', shared ? '나 → ' + everyone.join(', ') : m.from === 'me' ? '나 → ' + c.peerName : c.peerName + ' → 나'), at)
  const text = el('div', 'text', m.text)
  b.append(who, text)
  if (m.context) {
    const d = el('details')
    d.append(el('summary', '', '함께 보낸 배경'), el('div', 'text', m.context))
    b.append(d)
  }
  li.append(b)
  return li
}
// 여러 세션에 한 번에 보낸 질문은 방 하나로 묶는다. 단체 대화방처럼 질문은 한 번만 보이고, 답은 온 차례대로 한 방에 쌓인다
// (2026-11-16, 사람이 정함). 세션은 받는 사람마다 대화를 따로 두지만, 사람에게는 한 질문이다.
// 받은 쪽에서는 다른 사람의 답이 오지 않으므로 묶을 것이 없다.
function roomsOf(convs) {
  const out = [], byAsk = new Map()
  for (const c of convs) {
    if (!c.ask || c.startedBy !== 'me') {
      out.push({ id: c.id, convs: [c] })
      continue
    }
    let room = byAsk.get(c.ask.id)
    if (!room) {
      room = { id: 'ask:' + c.ask.id, convs: [] }
      byAsk.set(c.ask.id, room)
      out.push(room)
    }
    room.convs.push(c)
  }
  return out
}
// 방 전체의 단계. 한 사람이라도 기다리게 하면 기다리는 중이다.
function roomPhase(phases) {
  for (const p of ['checking_with_your_human', 'peer_checking_with_their_human', 'unread', 'unread_notice', 'your_turn', 'waiting_for_peer']) if (phases.includes(p)) return p
  for (const p of ['agreed', 'closed', 'notice_sent']) if (phases.every(one => one === p)) return p
  return phases.includes('answered') ? 'answered' : phases.includes('answered_by_me') ? 'answered_by_me' : phases[0]
}
const PERSON = { waiting_for_peer: ['wait', '기다리는 중'], no_answer_yet: ['', '아직 답 없음'], notice_sent: ['', '답 필요 없음'], peer_checking_with_their_human: ['human', '사람에게 확인 중'], answered: ['ok', '답함'], answered_by_me: ['ok', '답함'], agreed: ['ok', '합의'], closed: ['', '마감'] }

// 카드 하나를 지금 방에 맞춘다. 이미 있는 것은 그대로 두고 달라진 것만 바꾼다. 그래야 새로 온 것만 움직인다.
function paint(v, room, live, index, news) {
  const convs = room.convs, c = convs[0], group = convs.length > 1
  const mine = c.startedBy === 'me', first = c.messages[0]
  const names = convs.map(one => one.peerName)
  v.peers = convs.map(one => one.peer)
  v.category = c.category || ''
  put(v.cat, v.category)
  // 고정은 방 전체에 건다. 여럿에게 보낸 질문은 그 대화들을 한 번에 고정한다.
  v.threads = convs.map(one => one.id)
  if (v.pinned !== !!room.pinned) {
    v.pinned = !!room.pinned
    v.card.classList.toggle('pinned', v.pinned)
    v.item.classList.toggle('pinned', v.pinned)
    v.pin.setAttribute('aria-pressed', String(v.pinned))
    v.pin.title = v.pinned ? '고정 풀기' : '맨 위에 고정'
  }
  const what = first && first.noAnswer ? '알림' : '질문'
  put(v.badge, group ? '여럿에게 보낸 ' + what : mine ? '보낸 ' + what : '받은 ' + what)
  v.badge.classList.toggle('out', mine)
  put(v.subject, c.subject)
  put(v.isub, c.subject)
  put(v.icat, v.category)
  put(v.iwho, names.join(', '))
  const where = convs.map(one => one.peerName + (one.peerAddr ? ' (' + one.peerAddr + ')' : '')).join(', ')
  const mode = c.ask ? ' (' + (ANSWERS[c.ask.answers] ?? c.ask.answers) + ')' : ''
  const others = c.ask ? (group ? ' ·' + mode : ' · 함께 받은 사람: ' + c.ask.to.join(', ') + mode) : ''
  put(v.meta, (mine ? '받는 쪽: ' : '보낸 쪽: ') + where + (first ? ' · 시작 ' + time(first.at) : '') + others)

  const phases = convs.map(phase), ph = group ? roomPhase(phases) : phases[0]
  const answered = phases.filter(p => p === 'answered' || p === 'answered_by_me' || p === 'agreed').length
  const pending = convs.filter((one, i) => phases[i] === ph && WAIT[ph])
  const label = (PHASE[ph] ?? ph) + (group ? ' · ' + convs.length + '명 중 ' + answered + '명 답함' : '')
  if (v.st !== ph || v.label !== label) {
    const was = v.st, changed = v.st !== ph
    v.st = ph
    v.label = label
    v.card.dataset.st = PHASE[ph] ? ph : ''
    v.card.classList.toggle('act', !!WAIT[ph])
    put(v.stext, label)
    put(v.ilabel, label)
    v.item.dataset.st = PHASE[ph] ? ph : ''
    v.item.classList.toggle('act', !!WAIT[ph])
    v.typing.classList.toggle('r', ph === 'your_turn' || ph === 'unread' || ph === 'unread_notice' || ph === 'checking_with_your_human')
    if (live && was !== undefined) {
      // 상태가 바뀌면 이름표가 아래에서 올라오며 바뀐다.
      fx(v.status, [{ opacity: 0, translate: '0 5px' }, { opacity: 1, translate: '0 0' }], { duration: 320, easing: EASE })
      // 답이 와서 질문과 답이 끝났다. 가장 흔한 끝이다: 체크가 한 번 그려진다.
      if (changed && (ph === 'answered' || ph === 'answered_by_me' || ph === 'agreed')) fx(v.tick, [{ strokeDashoffset: 16 }, { strokeDashoffset: 0 }], { duration: 450, delay: 180, easing: 'ease-out', fill: 'backwards' })
    }
  }
  put(v.tlabel, !WAIT[ph] ? '' : group ? WAIT[ph] + ': ' + pending.map(one => one.peerName).join(', ') : WAIT[ph])
  // 받은 사람마다 답했는지. 여럿에게 보낸 질문에만 붙는다.
  const people = group ? convs.map((one, i) => [one.peerName, (PERSON[phases[i]] || ['', PHASE[phases[i]] ?? phases[i]])]) : []
  const sig = JSON.stringify(people)
  if (v.people.dataset.sig !== sig) {
    v.people.dataset.sig = sig
    v.people.replaceChildren(...people.map(([name, state]) => el('span', 'pp ' + state[0], name + ' · ' + state[1])))
  }

  // 얼마나 기다렸는지. 상대가 자기 사람에게 묻는 중이면 묻기 시작한 때부터, 아니면 기다리게 하는 대화의 마지막 글부터 센다.
  const held = pending[0] || c, tail = held.messages[held.messages.length - 1]
  const since = held.status === 'peer_checking_with_their_human' && held.humanSince ? held.humanSince : tail ? tail.at : ''
  if (v.timer.dataset.since !== since) {
    v.timer.dataset.since = since
    v.timer.textContent = since ? clock(Date.now() - Date.parse(since)) : ''
  }
  // 한 방에 보일 글. 여럿에게 보낸 질문은 대화마다 같은 질문이 들어 있으므로 하나만 남기고, 나머지는 온 차례대로 섞는다.
  const items = []
  convs.forEach((one, k) =>
    one.messages.forEach((m, i) => {
      if (group && k > 0 && i === 0 && m.kind === 'question') return
      items.push({ c: one, m, id: m.id || one.id + ':' + i })
    }),
  )
  if (group) items.sort((x, y) => (x.m.at < y.m.at ? -1 : x.m.at > y.m.at ? 1 : 0))
  const newest = items.reduce((at, it) => (it.m.at > at ? it.m.at : at), '')
  if (newest && v.ago.dataset.ago !== newest) {
    v.ago.dataset.ago = newest
    v.ago.textContent = '· ' + ago(Date.now() - Date.parse(newest))
    v.iago.dataset.ago = newest
    v.iago.textContent = ago(Date.now() - Date.parse(newest))
  }
  // 열어 둔 대화가 맨 아래까지 내려가 있었는지. 그랬으면 새 글이 와도 맨 아래에 붙어 있게 한다.
  v.stuck = !v.wrap.hidden && v.scroll.scrollHeight - v.scroll.scrollTop - v.scroll.clientHeight < 40
  const ids = new Set(items.map(it => it.id))
  for (const [id, node] of v.seen)
    if (!ids.has(id)) {
      v.seen.delete(id)
      node.remove()
    }
  // 새 글만 만들어 제자리에 끼운다. 이미 있는 글은 옮기지 않는다(옮기면 나타나는 움직임이 다시 돈다).
  for (let i = items.length - 1, after = null; i >= 0; i--) {
    const it = items[i]
    let node = v.seen.get(it.id)
    if (!node) {
      node = bubble(it.c, it.m, group ? names : null)
      v.seen.set(it.id, node)
      v.msgs.insertBefore(node, after)
      if (live) news.unshift({ c: it.c, m: it.m, v, node })
    }
    syncFiles(node, it.m)
    after = node
  }
}

// 여러 세션과 이어져 있으면 세션을 골라 그 세션과 나눈 대화만 본다. 연결 그림의 세션을 눌러도 된다.
const filters = byId('filters'), cats = byId('cats')
let filter = ''
// 분류로도 골라 본다. 비면 전체, ':none' 이면 분류가 없는 대화다.
let catFilter = ''
const filtered = v => (!!filter && !v.peers.includes(filter)) || (!!catFilter && (catFilter === ':none' ? v.category !== '' : v.category !== catFilter))
function setFilter(key) {
  filter = filter === key ? '' : key
  applyFilter(true)
}
function setCat(key) {
  catFilter = catFilter === key ? '' : key
  applyFilter(true)
}
function applyFilter(byPerson) {
  const before = byPerson ? measure() : null
  let count = 0
  for (const v of cards.values()) {
    const hide = filtered(v)
    if (v.item.hidden !== hide) v.item.hidden = hide
    if (!hide) count++
  }
  board.hidden = count === 0
  empty.hidden = count > 0
  put(byId('emptyText'), filter ? '이 세션과 나눈 대화가 아직 없습니다.' : catFilter ? '이 분류의 대화가 아직 없습니다.' : '아직 주고받은 질문이 없습니다.')
  // 열어 둔 대화가 목록에서 빠졌으면 목록의 첫 대화를 연다.
  const open = cards.get(active)
  if (!open || open.item.hidden) {
    let top = ''
    for (const node of rooms.children)
      if (!node.hidden) {
        top = node.dataset.id
        break
      }
    active = ''
    for (const v of cards.values()) if (!v.wrap.hidden) v.wrap.hidden = true
    if (top) activate(top, false)
  }
  if (before) settle(before)
  for (const [row, picked] of [[filters, filter], [cats, catFilter]])
    for (const b of row.children) {
      const on = (b.dataset.key || '') === picked
      b.classList.toggle('sel', on)
      b.setAttribute('aria-pressed', String(on))
    }
  net.select(filter)
}
function syncFilters(groups, links) {
  const seen = new Map()
  for (const l of links) seen.set(l.key, { name: l.name, n: 0 })
  for (const room of groups)
    for (const c of room.convs) {
      const one = seen.get(c.peer) || { name: c.peerName, n: 0 }
      one.n++
      seen.set(c.peer, one)
    }
  if (filter && !seen.has(filter)) filter = ''
  filters.hidden = seen.size < 2
  const sig = JSON.stringify([...seen])
  if (filters.dataset.sig === sig) return
  filters.dataset.sig = sig
  const chip = (key, name, n) => {
    const b = el('button', 'chip')
    b.type = 'button'
    b.dataset.key = key
    b.append(el('span', '', name), el('b', '', String(n)))
    b.addEventListener('click', () => setFilter(key))
    return b
  }
  filters.replaceChildren(chip('', '전체', groups.length), ...[...seen].map(([key, one]) => chip(key, one.name, one.n)))
}
// 분류 이름표. 분류가 하나라도 있을 때만 보인다.
function syncCats(groups) {
  const seen = new Map()
  let none = 0
  for (const room of groups) {
    const label = room.convs[0].category || ''
    if (label) seen.set(label, (seen.get(label) || 0) + 1)
    else none++
  }
  if (catFilter && catFilter !== ':none' && !seen.has(catFilter)) catFilter = ''
  if (catFilter === ':none' && !none) catFilter = ''
  cats.hidden = seen.size === 0
  const sig = JSON.stringify([[...seen], none])
  if (cats.dataset.sig === sig) return
  cats.dataset.sig = sig
  const chip = (key, name, n) => {
    const b = el('button', 'chip')
    b.type = 'button'
    b.dataset.key = key
    b.append(el('span', '', name), el('b', '', String(n)))
    b.addEventListener('click', () => setCat(key))
    return b
  }
  const all = [chip('', '모든 분류', groups.length), ...[...seen].map(([label, n]) => chip(label, label, n))]
  if (none) all.push(chip(':none', '분류 없음', none))
  cats.replaceChildren(...all)
}

// 접근키(연결 코드)를 화면에서 만든다. 사람을 더할 때, 그리고 끊긴 상대가 다시 들어오게 할 때 쓴다.
const keybox = byId('keybox'), keycode = byId('keycode'), keycopy = byId('keycopy'), issueButton = byId('issue')
let keyFor = ''
let keyKind = ''
let hasKey = false
// 접근키는 두 가지다. 어느 것을 만들었는지 사람이 알 수 있게 제목과 설명에 적는다.
// 동료용(그룹 코드)에는 이 컴퓨터의 주소와 이름이 들어 있다. 외부용 코드는 중계 서버로만 이어지고 이 컴퓨터에 관한 것을 담지 않는다.
const KEY_KIND = {
  group: {
    title: '동료용 접근키 (그룹 코드)',
    help: '함께 일하는 동료에게만 보내세요. 이 코드에는 이 컴퓨터의 사내·VPN 주소와 컴퓨터 이름이 들어 있고, 이 코드로 들어온 세션은 이 그룹의 다른 세션과도 이어집니다. 동료가 자기 AI에게 「이 코드로 연결해줘」라고 하면 이어집니다.',
  },
  outside: {
    title: '외부용 접근키 (외부용 코드)',
    help: '팀 밖의 사람에게 보내는 코드입니다. 중계 서버로만 이어지고, 이 컴퓨터의 주소·포트·이름은 들어 있지 않습니다. 이 코드로 들어온 세션은 이 세션하고만 이어집니다. 받은 사람이 자기 AI에게 「이 코드로 연결해줘」라고 하면 이어집니다.',
  },
}
const KEY_ERROR = {
  relay: '중계 서버에 닿지 않아 외부용 접근키를 만들지 못했습니다. 중계 서버가 켜져 있는지, 설정한 주소와 키가 맞는지 확인한 뒤 다시 눌러 주세요. 이 컴퓨터의 주소가 든 다른 코드로 바꾸어 만들지 않았습니다.',
  outside_only: '이 브릿지는 외부용으로만 열려 있어서 동료용 접근키를 만들지 않습니다. 동료용 접근키는 다른 세션에서 만드세요.',
  unsafe: '이 세션의 이름이나 모델 소개에 이 컴퓨터에 관한 정보가 들어 있어서 외부용 접근키를 만들지 않았습니다. AI에게 이름을 바꿔 달라고 하세요.',
  failed: '접근키를 만들지 못했습니다. 다시 눌러 주세요.',
}
// kind 를 주지 않으면: 이 브릿지가 한 가지만 만들 수 있으면 그것을 만들고, 둘 다 만들 수 있으면 사람이 고를 때까지 아무것도 만들지 않는다.
async function issueKey(name, kind) {
  keyFor = name
  hasKey = false
  const kinds = (lastData && lastData.me && lastData.me.codes) || ['group']
  if (!kind && kinds.length === 1) kind = kinds[0]
  keyKind = kind || ''
  byId('keykinds').hidden = !!kind
  byId('keycopy').hidden = byId('keyagain').hidden = keycode.hidden = !kind
  put(byId('keyinfo'), '')
  if (!kind) {
    put(byId('keytitle'), '접근키 (연결 코드)')
    put(byId('keyhelp'), '어떤 접근키를 만들지 고르세요. 동료용에는 이 컴퓨터의 사내·VPN 주소와 이름이 들어가고, 외부용은 중계 서버로만 이어지며 이 컴퓨터에 관한 것을 담지 않습니다. 고르기 전에는 아무 코드도 만들지 않습니다.')
    if (!keybox.open) keybox.showModal()
    return
  }
  put(byId('keytitle'), KEY_KIND[kind].title)
  put(byId('keyhelp'), (name ? name + ' 쪽에 이 접근키를 다시 보내세요. ' : '') + KEY_KIND[kind].help)
  put(keycode, '만드는 중…')
  if (!keybox.open) keybox.showModal()
  try {
    const res = await fetch(location.pathname + '/code', { method: 'POST', headers: { 'x-coworker-viewer': '1', 'content-type': 'application/json' }, body: JSON.stringify({ kind }) })
    if (!res.ok) {
      // 만들지 못한 까닭을 세션이 알려 주면 그 말을 쓴다(중계 서버, 외부용 전용, 이름에 든 정보). 그 밖에는 응답 번호로 안다.
      const told = await res.clone().json().catch(() => null)
      throw new Error((told && KEY_ERROR[told.error]) || (await whyNot(res, '접근키를 만들 수 없습니다')))
    }
    const made = await res.json()
    // 만든 코드의 종류가 고른 것과 다르면 보여 주지 않는다.
    if (made.kind !== kind) throw new Error(KEY_ERROR.failed)
    hasKey = true
    put(keycode, made.code)
    put(byId('keyinfo'), '한 사람만, 한 번만 쓸 수 있습니다. ' + shortTime(made.expires) + '까지 쓸 수 있습니다.')
    fx(keycode, [{ opacity: .2 }, { opacity: 1 }], { duration: 300, easing: 'ease-out' })
  } catch (e) {
    put(keycode, '')
    put(byId('keyinfo'), e instanceof TypeError ? UNREACHED : e.message)
  }
}
byId('keygroup').addEventListener('click', () => issueKey(keyFor, 'group'))
byId('keyoutside').addEventListener('click', () => issueKey(keyFor, 'outside'))
issueButton.addEventListener('click', () => issueKey(''))
byId('keyagain').addEventListener('click', () => issueKey(keyFor, keyKind))
byId('keyclose').addEventListener('click', () => keybox.close())
keybox.addEventListener('click', e => {
  if (e.target === keybox) keybox.close()
})
keycopy.addEventListener('click', async () => {
  if (!hasKey) return
  let ok = false
  try {
    await navigator.clipboard.writeText(keycode.textContent)
    ok = true
  } catch (e) {
    // 클립보드를 못 쓰는 브라우저: 글자를 골라 두어 사람이 바로 복사하게 한다.
    getSelection().selectAllChildren(keycode)
  }
  put(keycopy, ok ? '복사했습니다' : '골라 두었습니다. 복사 키를 누르세요')
  setTimeout(() => put(keycopy, '복사'), 2000)
})
// 닿지 않는 세션마다 한 줄. 스스로 다시 붙지만, 오래 걸리면 사람이 접근키를 다시 만들어 보낼 수 있다.
function syncDowns(links) {
  const box = byId('downs'), rows = links.filter(l => l.state !== 'connected')
  const sig = rows.map(l => l.key + (l.since || '')).join(' ')
  if (box.dataset.sig === sig) return
  box.dataset.sig = sig
  box.replaceChildren(
    ...rows.map(l => {
      const row = el('div', 'downrow'), text = el('span'), timer = el('b', 'timer'), again = el('button', 'chip', '접근키 다시 만들기')
      timer.dataset.since = l.since || ''
      put(timer, l.since ? clock(Date.now() - Date.parse(l.since)) : '')
      text.append(l.name + '에 닿지 않습니다. 스스로 다시 붙는 중 · ', timer)
      again.type = 'button'
      again.addEventListener('click', () => issueKey(l.name, l.outside ? 'outside' : 'group'))
      row.append(text, again)
      return row
    }),
  )
}

let follow = saved.get('coworker.follow') !== 'off'
// 새로 온 글을 알린다: 연결선을 따라 점이 건너가고, 새 글에 테두리가 잠깐 둘린다.
// 「새 글 따라가기」를 켰으면 그 글이 온 대화를 언제나 연다(2026-11-17, 사람이 정함: 「신규 질답이 오면 그 창이 활성화 되게」).
// 껐으면 열어 둔 대화를 그대로 둔다. 열어 두지 않은 대화에 온 글은 목록에 표시하고 알림으로 띄운다.
function announce(news) {
  const newest = news[news.length - 1], jump = follow
  if (jump) activate(newest.v.id, false)
  news.forEach((n, i) => {
    const recent = i >= news.length - 3
    if (i < 6) net.send(n.m.from === 'me' ? ME : n.c.peer, n.m.from === 'me' ? n.c.peer : ME, n.m.kind, i * 180)
    if (recent) mark(n.node)
    if (n.v.id === active) return
    if (!n.v.unseen) {
      n.v.unseen = true
      n.v.item.classList.add('unseen')
    }
    if (recent) toast(n)
  })
  // 열어 둔 대화에 새 글이 왔으면 맨 아래(새 글)로 내린다. 따라가기를 껐어도, 맨 아래에 있었으면 붙어 있는다.
  const open = cards.get(active)
  if (open && news.some(n => n.v === open) && (follow || open.stuck)) toBottom(open, true)
}

let first = true
let lastData = null
let nextFlip = 0
// 방에서 가장 새 글의 시각.
function newestAt(room) {
  let at = ''
  for (const c of room.convs) for (const m of c.messages) if (m.at > at) at = m.at
  return at
}
function render(data) {
  const live = !first
  first = false
  lastData = data
  unread = new Set(data.unread || [])
  const me = data.me
  const relay = me.relay ? ' · 중계 서버 ' + ({ connected: '연결됨', connecting: '연결하는 중', off: '꺼짐' }[me.relay.status] ?? '닿지 않음') : ''
  put(byId('me'), me.name + (me.open ? ' · 포트 ' + me.port + ' 열림' : ' · 브릿지 닫힘') + relay)
  const convs = [...data.conversations].sort((a, b) => (b.messages[0]?.at ?? '').localeCompare(a.messages[0]?.at ?? ''))
  const links = data.links || []
  const up = links.filter(l => l.state === 'connected').length
  const asking = convs.filter(c => c.status === 'checking_with_your_human' || c.status === 'peer_checking_with_their_human').length
  const unanswered = convs.filter(c => ['waiting_for_peer', 'your_turn', 'unread'].includes(phase(c))).length
  // 답이 필요 없는 알림은 「답 기다림」에 세지 않는다.
  // 답 없이 시간이 지나 조용해질 대화가 있으면, 그때 화면을 한 번 다시 맞춘다.
  nextFlip = 0
  for (const c of convs) {
    const ph = phase(c), asked = lastTurn(c)
    if ((ph !== 'waiting_for_peer' && ph !== 'your_turn') || !asked) continue
    const at = Date.parse(asked.at) + QUIET_MS + 500
    if (!nextFlip || at < nextFlip) nextFlip = at
  }
  // 차례는 대화방 목록처럼 한다(2026-11-17, 사람이 정함: 「고정, 최신 질답, 순」).
  // 고정한 대화가 먼저고, 그 안에서는 마지막 글이 새로운 대화가 먼저다.
  const groups = roomsOf(convs).map(room => Object.assign(room, { pinned: room.convs.some(c => c.pinned), at: newestAt(room) }))
  groups.sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  stats.set('links', up < links.length ? '연결 (끊김 ' + (links.length - up) + ')' : '연결', up, false)
  stats.set('convs', '대화', groups.length, false)
  stats.set('msgs', '글', convs.reduce((n, c) => n + c.messages.length, 0), false)
  stats.set('open', '답 기다림', unanswered, false)
  stats.set('humans', '사람 결정 대기', asking, asking > 0)
  net.update(data, convs)
  issueButton.disabled = !me.open
  syncDowns(links)

  // 목록의 차례가 바뀌는 것을 부드럽게 잇는다: 바꾸기 전 자리를 재 두고, 바꾼 뒤 그 차이만큼 미끄러져 오게 한다.
  const before = live ? measure() : new Map()
  const news = [], keep = new Set(), order = []
  groups.forEach((room, i) => {
    keep.add(room.id)
    let v = cards.get(room.id)
    if (!v) {
      v = makeCard(room.id)
      cards.set(room.id, v)
      pane.append(v.wrap)
      // 처음 열 때는 목록이 위에서부터 차례로 들어온다.
      if (!live) {
        v.item.style.setProperty('--i', Math.min(i, 8))
        setTimeout(() => v.item.style.removeProperty('--i'), 1500)
      }
    }
    paint(v, room, live, i, news)
    order.push(v.item)
  })
  for (const [id, v] of [...cards])
    if (!keep.has(id)) {
      cards.delete(id)
      v.wrap.remove()
      v.item.remove()
    }
  place(order)
  syncFilters(groups, links)
  syncCats(groups)
  applyFilter(false)
  settle(before)
  if (news.length) announce(news)
}

// 기다린 시간과 「몇 초 전」을 1초마다 새로 쓴다.
setInterval(() => {
  if (document.hidden) return
  const now = Date.now()
  for (const n of document.querySelectorAll('[data-since]')) {
    const from = Date.parse(n.dataset.since)
    if (!isNaN(from)) put(n, (n.dataset.pre || '') + clock(now - from))
  }
  for (const n of document.querySelectorAll('[data-ago]')) put(n, (n.dataset.pre ?? '· ') + ago(now - Date.parse(n.dataset.ago)))
  if (nextFlip && now >= nextFlip && lastData) render(lastData)
}, 1000)


const motionButton = byId('motion'), followButton = byId('follow')
function applyMotion() {
  root.classList.toggle('on', moving())
  put(motionButton, moving() ? '모션 끄기' : '모션 켜기')
}
motionButton.addEventListener('click', () => {
  motionPref = moving() ? 'off' : 'on'
  saved.set('coworker.motion', motionPref)
  applyMotion()
})
reduce.addEventListener('change', applyMotion)
function applyFollow() {
  put(followButton, follow ? '새 글 따라가기 끄기' : '새 글 따라가기 켜기')
}
followButton.addEventListener('click', () => {
  follow = !follow
  saved.set('coworker.follow', follow ? 'on' : 'off')
  applyFollow()
})
// 처음 열릴 때 한 번, 위쪽 칸이 떠오르며 나타난다.
root.classList.add('boot')
setTimeout(() => root.classList.remove('boot'), 1500)
applyMotion()
applyFollow()

// 세션이 바뀐 것을 그때그때 밀어 준다. 세션을 다시 켜면 같은 주소로 돌아오므로, 끊겨도 스스로 다시 붙는다.
// 브라우저는 한 주소에 연결을 6개까지만 열어 둔다. 화면마다 연결 하나를 쥐고 있으면 탭을 여럿 연 뒤 새 탭이 뜨지 않으므로,
// 보이지 않는 탭은 연결을 놓았다가 다시 보일 때 붙는다. 붙을 때마다 대화 전체를 다시 받는다.
const refresh = byId('refresh'), liveChip = byId('live'), liveText = byId('liveText')
let changedAt = ''
let shown = ''
let events
let retry
function status(text, offline) {
  put(refresh, text)
  document.body.classList.toggle('offline', !!offline)
  liveChip.classList.toggle('off', !!offline)
  put(liveText, offline ? '끊김' : '실시간')
}
function connect() {
  clearTimeout(retry)
  if (events) events.close()
  const source = new EventSource(location.pathname + '/events')
  events = source
  source.onmessage = e => {
    if (e.data !== shown) {
      shown = e.data
      render(JSON.parse(e.data))
      changedAt = time(new Date().toISOString())
    }
    status('바뀌면 바로 보여 줍니다 · 마지막 변경 ' + changedAt)
  }
  source.onerror = () => {
    status('세션에 닿지 않습니다. 세션이 다시 켜지면 이 화면이 스스로 이어서 보여 줍니다.', true)
    // 브라우저가 다시 붙기를 그만두었으면(그 포트에 다른 것이 떴을 때) 잠시 뒤 직접 다시 붙는다.
    if (source.readyState === EventSource.CLOSED && events === source) retry = setTimeout(connect, 5000)
  }
}
function release() {
  clearTimeout(retry)
  if (events) events.close()
  events = undefined
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) release()
  else {
    connect()
  }
})
if (!document.hidden) connect()
</script>
</body>
</html>
`
