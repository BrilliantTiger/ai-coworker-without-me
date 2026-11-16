// 사람이 브라우저로 보는 대화 화면. viewer.ts 가 이 글을 그대로 내려 준다.
// 사람이 지켜볼 맛이 나게 움직임을 많이 넣었다(2026-11-16, 사람이 정함: 「모션도 빵빵하게」, 「보는 재미가 있어야지」).
//
// 지키는 것:
// - 상대가 보낸 글과 이름은 textContent 로만 넣는다. HTML 로 해석하지 않는다.
// - 밖에서 아무것도 받아 오지 않는다. 글꼴·그림·스크립트 모두 이 글 안에 있다(CSP: default-src 'none').
// - 움직임은 <html class="on"> 일 때만 건다. 「동작 줄이기」를 켠 PC에서는 처음부터 꺼져 있고,
//   화면의 「모션 끄기」 단추로 언제든 멈춘다. 멈춰도 내용은 모두 그대로 보인다.
// - 1초에 세 번 넘게 깜빡이는 것은 없다.
// - 이 글은 템플릿 글 안에 있다. 그래서 화면 스크립트에는 백틱, 달러-중괄호, 역슬래시를 쓰지 않는다.
//   (String.raw 로 감싸면 안 된다. Bun 이 한글을 \\uXXXX 로 바꿔 묶어서, 화면에 그 글자가 그대로 찍힌다.)
export const PAGE = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Coworker 대화</title>
<style>
@property --a { syntax: '<angle>'; inherits: false; initial-value: 0deg; }
:root {
  color-scheme: light dark;
  --bg: #f3f2ee; --card: #ffffff; --text: #1c1b19; --muted: #63615b; --line: #dcdad2;
  --in: #e7eefe; --in-b: #2f5bd3; --out: #e3f4e7; --out-b: #17703c; --note: #fcf2d7; --note-b: #8f5c0e; --agree: #f0e8ff; --agree-b: #6f42c9;
  --accent: #2f5bd3; --accent2: #7c4ddb; --warn: #b3261e;
  --shadow: 0 1px 2px rgba(20, 20, 30, .06), 0 8px 24px rgba(20, 20, 30, .07);
  --aur1: #9db8ff; --aur2: #c9b3ff; --aur3: #9fe3c0; --aur-o: .55;
  --spring: cubic-bezier(.34, 1.56, .64, 1); --bounce: cubic-bezier(.34, 1.56, .64, 1);
  --font: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", "Segoe UI", sans-serif;
}
@supports (transition-timing-function: linear(0, 1)) {
  :root {
    --spring: linear(0, 0.009, 0.035 2.1%, 0.141, 0.281 6.7%, 0.723 12.9%, 0.938 16.7%, 1.017, 1.077, 1.121, 1.149 24.3%, 1.159, 1.163, 1.161, 1.154 29.9%, 1.129 32.8%, 1.051 39.6%, 1.017 43.1%, 0.991, 0.977 51%, 0.974 53.8%, 0.975 57.1%, 0.997 69.8%, 1.003 76.9%, 1.004 83.8%, 1);
    --bounce: linear(0, 0.214 14.7%, 0.386 23.7%, 0.598 31.9%, 0.999 44.7%, 0.807 52.6%, 0.762 56%, 0.747 59.4%, 0.758 62.4%, 0.793 65.6%, 0.999 77.4%, 0.961 81.2%, 0.949 84.8%, 0.956 88%, 0.993 95.5%, 1);
  }
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0b0c11; --card: #171924; --text: #ecebe6; --muted: #9b9ba6; --line: #2a2d3b;
    --in: #162242; --in-b: #8aa8ff; --out: #12301e; --out-b: #62d28d; --note: #32280e; --note-b: #f0b84a; --agree: #281d47; --agree-b: #b9a0ff;
    --accent: #8aa8ff; --accent2: #b9a0ff; --warn: #ff8a80;
    --shadow: 0 1px 2px rgba(0, 0, 0, .4), 0 10px 30px rgba(0, 0, 0, .35);
    --aur1: #2b4fb8; --aur2: #5a36b0; --aur3: #17694a; --aur-o: .42;
  }
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--text); font: 15px/1.55 var(--font); overflow-x: hidden; }
button { font: inherit; color: inherit; }
button:focus-visible, .node:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* 배경: 떠다니는 빛과 별자리 */
#sky, .aurora, #fx { position: fixed; inset: 0; width: 100%; height: 100%; pointer-events: none; }
#sky, .aurora { z-index: 0; }
#fx { z-index: 40; }
.aurora { overflow: hidden; opacity: var(--aur-o); }
.aurora i { position: absolute; width: 46vmax; height: 46vmax; border-radius: 50%; filter: blur(70px); }
.aurora i:nth-child(1) { left: -12vmax; top: -16vmax; background: radial-gradient(circle, var(--aur1), transparent 65%); }
.aurora i:nth-child(2) { right: -14vmax; top: 4vmax; background: radial-gradient(circle, var(--aur2), transparent 65%); }
.aurora i:nth-child(3) { left: 22vmax; bottom: -26vmax; background: radial-gradient(circle, var(--aur3), transparent 65%); }
.on .aurora i:nth-child(1) { animation: drift1 26s ease-in-out infinite alternate; }
.on .aurora i:nth-child(2) { animation: drift2 32s ease-in-out infinite alternate; }
.on .aurora i:nth-child(3) { animation: drift3 38s ease-in-out infinite alternate; }
@keyframes drift1 { to { translate: 14vmax 10vmax; scale: 1.25; } }
@keyframes drift2 { to { translate: -16vmax 12vmax; scale: .85; } }
@keyframes drift3 { to { translate: -10vmax -14vmax; scale: 1.3; } }

/* 맨 위: 이름, 실시간 표시, 단추 */
.bar { position: fixed; inset: 0 0 auto 0; height: 3px; z-index: 20; background: linear-gradient(90deg, var(--accent), var(--accent2)); transform-origin: 0 50%; scale: 0 1; }
.top { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: 10px 12px; flex-wrap: wrap; padding: 12px max(16px, calc((100vw - 900px) / 2 + 16px)); background: color-mix(in srgb, var(--bg) 72%, transparent); -webkit-backdrop-filter: blur(14px) saturate(1.4); backdrop-filter: blur(14px) saturate(1.4); border-bottom: 1px solid color-mix(in srgb, var(--line) 70%, transparent); }
.brand { display: flex; align-items: center; gap: 10px; margin-right: auto; }
.logo { width: 30px; height: 30px; overflow: visible; flex: none; }
.logo .lo { fill: none; stroke: var(--muted); stroke-width: 1.2; stroke-dasharray: 3 5; opacity: .6; }
.logo .l1 { fill: var(--accent); } .logo .l2 { fill: var(--accent2); }
.logo .ll { stroke: var(--muted); stroke-width: 2; stroke-linecap: round; }
.on .logo .lg { animation: rot 9s linear infinite; }
.on .logo .lo { animation: rot 30s linear infinite reverse; }
@keyframes rot { to { rotate: 360deg; } }
h1 { font-size: 20px; margin: 0; letter-spacing: -.01em; white-space: nowrap; }
h1 span { background: linear-gradient(90deg, var(--accent), var(--accent2), var(--accent)); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; }
.on h1 span { animation: shimmer 5s linear infinite; }
@keyframes shimmer { to { background-position: -200% 0; } }
.chips { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.chip { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; line-height: 1; padding: 7px 11px; border-radius: 99px; border: 1px solid var(--line); background: color-mix(in srgb, var(--card) 80%, transparent); white-space: nowrap; }
button.chip { cursor: pointer; transition: scale .5s var(--spring), border-color .2s; }
button.chip:hover { border-color: var(--accent); }
.on button.chip:hover { scale: 1.06; }
.on button.chip:active { scale: .94; }
.live .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--out-b); position: relative; flex: none; }
.on .live .dot::after { content: ''; position: absolute; inset: 0; border-radius: 50%; background: inherit; animation: ping 1.8s ease-out infinite; }
@keyframes ping { from { scale: 1; opacity: .7; } to { scale: 3.2; opacity: 0; } }
.live.off { color: var(--warn); border-color: var(--warn); }
.live.off .dot { background: var(--warn); }
@supports ((animation-timeline: scroll()) and (animation-range: entry)) {
  .on .bar { animation: grow auto linear both; animation-timeline: scroll(root); }
  .on .top { animation: tuck auto linear both; animation-timeline: scroll(root); animation-range: 0px 140px; }
  @keyframes grow { to { scale: 1 1; } }
  @keyframes tuck { from { padding-block: 20px; } to { padding-block: 8px; box-shadow: 0 6px 24px rgba(0, 0, 0, .14); } }
}

main { position: relative; z-index: 1; max-width: 900px; margin: 0 auto; padding: 16px 16px 90px; transition: filter .6s ease; }
.offline main { filter: grayscale(.85); }
.me, .refresh { color: var(--muted); font-size: 13px; margin: 0; }
.refresh { margin: 2px 0 16px; }
.offline .refresh { color: var(--warn); font-weight: 600; }

/* 연결 그림 */
.stage { position: relative; border: 1px solid var(--line); border-radius: 18px; background: color-mix(in srgb, var(--card) 62%, transparent); box-shadow: var(--shadow); overflow: hidden; margin-bottom: 12px; }
.stage::before { content: ''; position: absolute; inset: 0; pointer-events: none; opacity: .4; background-image: linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px); background-size: 28px 28px; -webkit-mask-image: radial-gradient(ellipse at center, #000 15%, transparent 72%); mask-image: radial-gradient(ellipse at center, #000 15%, transparent 72%); }
.on .stage::before { animation: grid 14s linear infinite; }
@keyframes grid { to { background-position: 28px 28px, 28px 28px; } }
#net { display: block; width: 100%; position: relative; }
#net text { font: 600 12px/1 var(--font); fill: var(--text); text-anchor: middle; paint-order: stroke; stroke: var(--card); stroke-width: 3px; stroke-linejoin: round; }
#net .sub { font-weight: 400; font-size: 11px; fill: var(--muted); font-variant-numeric: tabular-nums; }
#net .ini { fill: #fff; stroke: none; font-size: 15px; font-weight: 700; }
.link { fill: none; stroke: var(--line); stroke-width: 2; }
.flow { fill: none; stroke-width: 3; stroke-linecap: round; stroke-dasharray: 1 15; opacity: .9; }
.flow.a { stroke: var(--out-b); } .flow.b { stroke: var(--in-b); }
.on .flow.a { animation: dash-a 1.8s linear infinite; }
.on .flow.b { animation: dash-b 2.6s linear infinite; }
@keyframes dash-a { to { stroke-dashoffset: -16; } }
@keyframes dash-b { to { stroke-dashoffset: 16; } }
.lk.down .link { stroke: var(--warn); stroke-dasharray: 6 8; }
.lk.down .flow, .lk.ghost .flow { display: none; }
.on .lk.down .link { animation: blink 1.8s ease-in-out infinite; }
@keyframes blink { 50% { opacity: .3; } }
.lk.ghost .link { stroke-dasharray: 3 7; opacity: .7; }
.node { cursor: pointer; outline-offset: 6px; }
.node.me { cursor: default; }
.node .core { fill: var(--in-b); stroke: var(--card); stroke-width: 2; }
.node.me .core { fill: url(#gme); }
.node.ghost .core { fill: var(--muted); stroke-dasharray: 3 3; opacity: .7; }
.node.down .core, .node.closed .core { fill: var(--muted); }
.node .halo { fill: var(--in-b); opacity: .14; }
.node.me .halo { fill: var(--accent2); }
.node.down .halo { fill: var(--warn); }
.on .node .halo { animation: halo 3.2s ease-in-out infinite; }
@keyframes halo { 50% { scale: 1.28; opacity: .04; } }
.on .node .fl { animation: float var(--fd, 5s) ease-in-out var(--fo, 0s) infinite alternate; }
@keyframes float { from { translate: 0 -3px; } to { translate: 0 4px; } }
.orbit, .hb { display: none; }
.orbit circle { fill: var(--out-b); }
.node.think .orbit { display: inline; }
.on .node.think .orbit { animation: rot 1.4s linear infinite; }
.node.human .hb { display: inline; }
.hb circle { fill: var(--note-b); stroke: var(--card); stroke-width: 2; }
#net .hb text { fill: var(--card); stroke: none; font-size: 11px; font-weight: 800; }
.on .node.human .hb circle { animation: beat 1.4s ease-in-out infinite; }
.rip { fill: none; stroke: var(--accent); stroke-width: 2; }
.pkt { fill: var(--in-b); filter: drop-shadow(0 0 5px var(--in-b)); }
.pkt.k-answer { fill: var(--out-b); filter: drop-shadow(0 0 5px var(--out-b)); }
.pkt.k-note, .pkt.k-closed { fill: var(--note-b); filter: drop-shadow(0 0 5px var(--note-b)); }
.pkt.k-agreement { fill: var(--agree-b); filter: drop-shadow(0 0 6px var(--agree-b)); }
.stats { position: relative; display: flex; gap: 6px 20px; flex-wrap: wrap; justify-content: center; padding: 2px 12px 12px; }
.stat { display: flex; align-items: baseline; gap: 6px; font-size: 12.5px; color: var(--muted); }
.stat.hot { color: var(--note-b); }
.num { display: inline-flex; font-weight: 700; font-size: 18px; line-height: 1.2; height: 1.2em; color: var(--text); font-variant-numeric: tabular-nums; }
.stat.hot .num { color: var(--note-b); }
.dg { display: inline-block; height: 1.2em; overflow: hidden; }
.dg > span { display: block; white-space: pre; translate: 0 calc(var(--d, 0) * -1.2em); }
.on .dg > span { transition: translate .8s var(--spring); }
.stage .key { position: absolute; top: 10px; right: 10px; z-index: 2; }
button.chip:disabled { opacity: .5; cursor: not-allowed; }
.downs { position: relative; display: flex; flex-direction: column; gap: 6px; padding: 0 12px 12px; }
.downs:empty { display: none; }
.downrow { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 12.5px; color: var(--warn); padding: 7px 10px; border-radius: 10px; background: color-mix(in srgb, var(--warn) 9%, transparent); }
.downrow > span { flex: 1 1 220px; }
.node.sel .core { stroke: var(--accent2); stroke-width: 4; }

/* 세션을 골라 그 세션과 나눈 대화만 본다 */
.filters { display: flex; gap: 8px; flex-wrap: wrap; margin: 0 0 12px; }
.filters[hidden], .wrap[hidden] { display: none; }
.chip b { font-weight: 600; opacity: .75; font-variant-numeric: tabular-nums; }
.chip.sel { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 16%, var(--card)); font-weight: 600; }

/* 대화 카드 */
#list { display: flex; flex-direction: column; gap: 16px; }
.wrap { position: relative; }
@supports ((animation-timeline: view()) and (animation-range: entry)) {
  .on .wrap { animation: rise auto linear backwards, sink auto linear forwards; animation-timeline: view(), view(); animation-range: entry 0px entry 180px, exit calc(100% - 160px) exit 100%; }
  @keyframes rise { from { opacity: 0; scale: .95; } }
  @keyframes sink { to { opacity: .2; scale: .97; } }
}
.conv { position: relative; background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 14px 16px 12px; box-shadow: var(--shadow); transform: perspective(1100px) rotateX(var(--rx, 0deg)) rotateY(var(--ry, 0deg)); --ring: var(--muted); }
.conv[data-st=waiting_for_peer] { --ring: var(--in-b); }
.conv[data-st=your_turn] { --ring: var(--out-b); }
.conv[data-st=checking_with_your_human], .conv[data-st=peer_checking_with_their_human] { --ring: var(--note-b); }
.conv[data-st=agreed] { --ring: var(--agree-b); }
.conv[data-st=answered], .conv[data-st=answered_by_me] { --ring: var(--out-b); }
.conv.act { border-color: color-mix(in srgb, var(--ring) 45%, var(--line)); }
.conv::before { content: ''; position: absolute; inset: -1px; border-radius: inherit; padding: 2px; pointer-events: none; opacity: 0; background: conic-gradient(from var(--a), transparent 0 62%, var(--ring) 84%, transparent 100%); -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0); }
.on .conv.act::before { opacity: 1; animation: spin 3.6s linear infinite; }
@keyframes spin { to { --a: 360deg; } }
.conv::after { content: ''; position: absolute; inset: 0; border-radius: inherit; pointer-events: none; opacity: 0; transition: opacity .3s; background: radial-gradient(420px circle at var(--mx, 50%) var(--my, 0%), color-mix(in srgb, var(--accent) 13%, transparent), transparent 60%); }
.on .conv:hover::after { opacity: 1; }
.on .conv { transition-property: opacity, translate, scale, filter, transform, border-color; transition-duration: .6s, .9s, .9s, .6s, .4s, .3s; transition-timing-function: ease-out, var(--spring), var(--spring), ease-out, ease-out, ease; --d: calc(var(--i, 0) * 70ms); transition-delay: var(--d), var(--d), var(--d), var(--d), 0s, 0s; }
.on .wrap.gone .conv { opacity: 0; scale: .92; filter: blur(6px); }
.head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.badge { font-size: 12px; font-weight: 700; padding: 3px 9px; border-radius: 99px; background: var(--in); color: var(--in-b); white-space: nowrap; }
.badge.out { background: var(--out); color: var(--out-b); }
.subject { font-size: 15px; font-weight: 650; margin: 0; overflow-wrap: anywhere; flex: 1 1 220px; min-width: 0; }
.status { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 99px; color: var(--ring); background: color-mix(in srgb, var(--ring) 12%, transparent); }
.sdot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex: none; }
.on .act .sdot { animation: beat 1.4s ease-in-out infinite; }
/* 답이 오간 대화와 합의한 대화는 점 대신 체크로 끝났음을 보인다 */
.ck { display: none; width: 12px; height: 12px; flex: none; fill: none; stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 16; }
.conv[data-st^=answered] .ck, .conv[data-st=agreed] .ck { display: inline; }
.conv[data-st^=answered] .sdot, .conv[data-st=agreed] .sdot { display: none; }
.fxl { position: absolute; inset: 0; border-radius: inherit; overflow: hidden; pointer-events: none; }
.shine { position: absolute; top: 0; bottom: 0; left: 0; width: 45%; translate: -130% 0; background: linear-gradient(100deg, transparent, color-mix(in srgb, var(--ring) 30%, transparent), transparent); }
@keyframes beat { 50% { scale: 1.6; opacity: .5; } }
.ago { font-weight: 400; opacity: .85; font-variant-numeric: tabular-nums; }
.meta { color: var(--muted); font-size: 12.5px; margin: 6px 0 2px; overflow-wrap: anywhere; }
/* 여럿에게 보낸 질문: 받은 사람마다 답했는지 */
.people { display: flex; gap: 6px; flex-wrap: wrap; margin: 6px 0 0; }
.people:empty { display: none; }
.pp { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; padding: 2px 9px; border-radius: 99px; border: 1px solid var(--line); color: var(--muted); }
.pp::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.pp.ok { color: var(--out-b); border-color: color-mix(in srgb, var(--out-b) 40%, var(--line)); }
.pp.wait { color: var(--in-b); border-color: color-mix(in srgb, var(--in-b) 40%, var(--line)); }
.pp.human { color: var(--note-b); border-color: color-mix(in srgb, var(--note-b) 40%, var(--line)); }
.on .pp.wait::before, .on .pp.human::before { animation: beat 1.4s ease-in-out infinite; }
.av { display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; background: var(--b); color: var(--card); font-size: 11px; font-weight: 700; flex: none; }

/* 주고받은 글 */
.msgs { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 9px; }
.msg { max-width: min(88%, 660px); min-width: 0; }
.msg.peer { align-self: flex-start; }
.msg.mine { align-self: flex-end; }
.msg.note { align-self: center; max-width: 92%; }
.msg.agreement { align-self: stretch; max-width: none; margin-top: 8px; }
.bubble { position: relative; padding: 9px 13px 10px; border-radius: 16px; background: var(--in); --b: var(--in-b); border: 1px solid color-mix(in srgb, var(--b) 22%, transparent); }
.peer .bubble { border-bottom-left-radius: 5px; }
.mine .bubble { background: var(--out); --b: var(--out-b); border-bottom-right-radius: 5px; }
.note .bubble { background: var(--note); --b: var(--note-b); border-radius: 12px; font-size: 13.5px; }
.agreement .bubble { background: var(--agree); --b: var(--agree-b); border-width: 1.5px; border-color: color-mix(in srgb, var(--b) 55%, transparent); border-radius: 14px; padding: 14px 16px; }
.who { display: flex; flex-wrap: wrap; gap: 3px 8px; align-items: center; font-size: 12.5px; font-weight: 650; color: var(--b); }
.hum { font-size: 11.5px; padding: 1px 7px; border-radius: 99px; background: color-mix(in srgb, var(--note-b) 18%, transparent); color: var(--note-b); }
.dir { font-weight: 500; color: var(--muted); }
.time { color: var(--muted); font-size: 11.5px; font-weight: 400; font-variant-numeric: tabular-nums; margin-left: auto; }
.text { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 3px; }
.rest { visibility: hidden; }
.caret { display: inline-block; width: 0; position: relative; }
.caret::after { content: ''; position: absolute; left: 1px; bottom: -.2em; width: 2px; height: 1.15em; border-radius: 1px; background: var(--b); }
.on .caret::after { animation: caret 1s steps(1) infinite; }
@keyframes caret { 50% { opacity: 0; } }
.stamp { position: absolute; right: 12px; top: -13px; padding: 3px 10px; border: 2px solid var(--agree-b); color: var(--agree-b); background: var(--card); border-radius: 8px; font-weight: 800; font-size: 12px; letter-spacing: .08em; rotate: -6deg; }
details { margin-top: 6px; font-size: 13px; color: var(--muted); }
summary { cursor: pointer; width: fit-content; }
details .text { color: var(--text); }
@supports (interpolate-size: allow-keywords) {
  :root { interpolate-size: allow-keywords; }
  .on details::details-content { block-size: 0; overflow: clip; transition: block-size .45s ease, content-visibility .45s; transition-behavior: allow-discrete; }
  .on details[open]::details-content { block-size: auto; }
}
.on .msg { transition: opacity .5s ease-out, translate .8s var(--spring), scale .8s var(--spring), filter .5s ease-out; transition-delay: calc(var(--i, 0) * 45ms); }
.typing { display: none; align-items: center; gap: 8px; margin-top: 10px; font-size: 12.5px; color: var(--ring); }
.conv.act .typing { display: flex; }
.typing.r { flex-direction: row-reverse; }
.dots { display: inline-flex; gap: 4px; padding: 7px 10px; border-radius: 12px; background: color-mix(in srgb, var(--ring) 14%, transparent); }
.dots i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: .6; }
.on .dots i { animation: hop 1.2s ease-in-out infinite; }
.on .dots i:nth-child(2) { animation-delay: .15s; }
.on .dots i:nth-child(3) { animation-delay: .3s; }
@keyframes hop { 0%, 60%, 100% { translate: 0 0; opacity: .45; } 30% { translate: 0 -5px; opacity: 1; } }
.timer { font-variant-numeric: tabular-nums; font-weight: 650; }

/* 아직 대화가 없을 때 */
.empty { display: grid; place-items: center; gap: 12px; padding: 30px 16px 40px; color: var(--muted); text-align: center; }
.empty[hidden] { display: none; }
.radar { width: 88px; height: 88px; border-radius: 50%; position: relative; border: 1px solid var(--line); background: radial-gradient(circle, color-mix(in srgb, var(--accent) 16%, transparent), transparent 70%); }
.radar::before { content: ''; position: absolute; inset: 0; border-radius: 50%; background: conic-gradient(color-mix(in srgb, var(--accent) 55%, transparent), transparent 28%); }
.radar::after { content: ''; position: absolute; inset: 38px; border-radius: 50%; background: var(--accent); }
.on .radar::before { animation: rot 2.6s linear infinite; }
.on .radar::after { animation: beat 1.6s ease-in-out infinite; }

/* 새 소식 알림 */
#toasts { position: fixed; right: 16px; bottom: 16px; z-index: 30; display: flex; flex-direction: column; gap: 8px; width: min(360px, calc(100vw - 32px)); }
.toast { position: relative; display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; align-items: baseline; text-align: left; padding: 10px 12px 12px; border-radius: 12px; border: 1px solid var(--line); background: color-mix(in srgb, var(--card) 88%, transparent); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); box-shadow: var(--shadow); cursor: pointer; overflow: hidden; }
.toast .tk { font-size: 12px; font-weight: 700; color: var(--in-b); }
.toast .tk.k-answer { color: var(--out-b); } .toast .tk.k-note, .toast .tk.k-closed { color: var(--note-b); } .toast .tk.k-agreement { color: var(--agree-b); }
.toast .tw { font-size: 12.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toast .ts { grid-column: 1 / -1; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toast .life { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: var(--accent); transform-origin: 0 50%; }
.on .toast { transition: opacity .3s ease, translate .7s var(--spring); }
.on .toast .life { animation: life 5.2s linear forwards; }
@keyframes life { to { scale: 0 1; } }
.on .toast.out { opacity: 0; translate: 48px 0; }

/* 접근키 창 */
dialog { border: 1px solid var(--line); border-radius: 16px; padding: 18px 18px 14px; width: min(540px, calc(100vw - 32px)); background: var(--card); color: var(--text); box-shadow: 0 20px 60px rgba(0, 0, 0, .35); }
dialog::backdrop { background: rgba(8, 9, 14, .5); -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px); }
.on dialog[open] { animation: pop .5s var(--spring); }
@keyframes pop { from { opacity: 0; scale: .9; translate: 0 12px; } }
dialog h2 { margin: 0 0 6px; font-size: 16px; }
dialog p { margin: 0 0 10px; font-size: 13.5px; color: var(--muted); }
.code { font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; min-height: 3em; max-height: 180px; overflow: auto; padding: 10px 12px; margin-bottom: 10px; border-radius: 10px; border: 1px dashed var(--line); background: color-mix(in srgb, var(--accent) 7%, transparent); overflow-wrap: anywhere; -webkit-user-select: all; user-select: all; }
.row { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
.chip.main { background: var(--accent); border-color: var(--accent); color: var(--card); font-weight: 600; }

/* 처음 나타날 때의 출발 모습. 맨 바깥에 둬야 브라우저가 읽는다. */
@starting-style {
  .on .conv { opacity: 0; translate: 0 26px; scale: .96; filter: blur(8px); }
  .on .msg { opacity: 0; scale: .92; filter: blur(6px); }
  .on .msg.peer { translate: -28px 8px; }
  .on .msg.mine { translate: 28px 8px; }
  .on .msg.note, .on .msg.agreement { translate: 0 14px; }
  .on .toast { opacity: 0; translate: 48px 0; }
}
</style>
</head>
<body>
<canvas id="sky" aria-hidden="true"></canvas>
<div class="aurora" aria-hidden="true"><i></i><i></i><i></i></div>
<div class="bar" aria-hidden="true"></div>
<header class="top">
  <div class="brand">
    <svg class="logo" viewBox="-24 -24 48 48" aria-hidden="true"><circle class="lo" r="21"/><g class="lg"><path class="ll" d="M-7 0H7"/><circle class="l1" cx="-13" r="6"/><circle class="l2" cx="13" r="6"/></g></svg>
    <h1>Coworker <span>대화</span></h1>
  </div>
  <div class="chips">
    <span class="chip live" id="live"><i class="dot"></i><span id="liveText">연결하는 중</span></span>
    <button class="chip" id="follow" type="button">새 글 따라가기 끄기</button>
    <button class="chip" id="motion" type="button">모션 끄기</button>
  </div>
</header>
<main>
  <section class="stage" id="stage" aria-label="연결 상태">
    <button class="chip key" id="issue" type="button">접근키 발급</button>
    <svg id="net" role="img" aria-label="세션 연결 그림"></svg>
    <div class="stats" id="stats"></div>
    <div class="downs" id="downs"></div>
  </section>
  <p class="me" id="me"></p>
  <p class="refresh" id="refresh" role="status"></p>
  <div class="filters" id="filters" role="group" aria-label="세션을 골라 보기" hidden></div>
  <div id="list"></div>
  <div class="empty" id="empty" hidden><div class="radar" aria-hidden="true"></div><div id="emptyText">아직 주고받은 질문이 없습니다.</div></div>
</main>
<dialog id="keybox" aria-labelledby="keytitle">
  <h2 id="keytitle">접근키 (연결 코드)</h2>
  <p id="keyhelp"></p>
  <div class="code" id="keycode" tabindex="0"></div>
  <p id="keyinfo" role="status"></p>
  <div class="row">
    <button class="chip main" id="keycopy" type="button">복사</button>
    <button class="chip" id="keyagain" type="button">새로 만들기</button>
    <button class="chip" id="keyclose" type="button">닫기</button>
  </div>
</dialog>
<div id="toasts" role="log" aria-live="polite"></div>
<canvas id="fx" aria-hidden="true"></canvas>
<script>
const KIND = { question: '질문', answer: '답', note: '알림', closed: '마감', agreement: '합의문' }
// 대화가 지금 어디에 와 있는지. 대화는 대개 합의문 없이 질문과 답으로 끝난다. 그래서 세션이 알려 주는 「차례」를
// 그대로 쓰지 않고, 마지막으로 오간 글을 본다: 질문이면 답을 기다리는 중이고, 답이면 끝난 것으로 차분하게 보인다.
const PHASE = {
  waiting_for_peer: '답 기다리는 중',
  your_turn: '답할 차례',
  checking_with_your_human: '이쪽 사람에게 확인 중',
  peer_checking_with_their_human: '상대가 자기 사람에게 확인 중',
  answered: '답 받음',
  answered_by_me: '답 보냄',
  closed: '마감 · 다른 사람이 먼저 답함',
  agreed: '합의문 작성됨',
}
// 누군가를 기다리는 단계. 카드 테두리가 돌고, 기다리는 쪽에 점 세 개가 뛴다.
const WAIT = {
  waiting_for_peer: '상대의 답을 기다리는 중',
  your_turn: '이쪽 AI가 답할 차례',
  checking_with_your_human: '이쪽 사람의 결정을 기다리는 중',
  peer_checking_with_their_human: '상대 쪽 사람의 결정을 기다리는 중',
}
function phase(c) {
  if (c.status !== 'waiting_for_peer' && c.status !== 'your_turn') return c.status
  for (let i = c.messages.length - 1; i >= 0; i--) {
    const m = c.messages[i]
    if (m.kind === 'question') return m.from === 'me' ? 'waiting_for_peer' : 'your_turn'
    if (m.kind === 'answer') return m.from === 'me' ? 'answered_by_me' : 'answered'
  }
  return c.status
}
const ANSWERS = { all: '모두 답', one: '한 명만 답' }
const SPRING_FN = 'linear(0, 0.009, 0.035 2.1%, 0.141, 0.281 6.7%, 0.723 12.9%, 0.938 16.7%, 1.017, 1.077, 1.121, 1.149 24.3%, 1.159, 1.163, 1.161, 1.154 29.9%, 1.129 32.8%, 1.051 39.6%, 1.017 43.1%, 0.991, 0.977 51%, 0.974 53.8%, 0.975 57.1%, 0.997 69.8%, 1.003 76.9%, 1.004 83.8%, 1)'
const SPRING = window.CSS && CSS.supports('transition-timing-function', 'linear(0, 1)') ? SPRING_FN : 'cubic-bezier(.34, 1.56, .64, 1)'
const root = document.documentElement
const byId = id => document.getElementById(id)
const time = at => new Date(at).toLocaleString('ko-KR', { hour12: false })
// 글마다 붙는 짧은 시각. 오늘 것이 아니면 날짜를 앞에 붙인다.
function shortTime(at) {
  const d = new Date(at)
  const hms = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
  return d.toDateString() === new Date().toDateString() ? hms : d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' }) + ' ' + hms
}
const NL = String.fromCharCode(10)
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

// 배경의 별자리. 점이 천천히 떠다니고 가까운 점끼리 선이 이어진다. 새 글이 오면 물결이 한 번 퍼진다.
const sky = (() => {
  const canvas = byId('sky')
  const ctx = canvas.getContext('2d')
  let w = 0, h = 0, points = [], waves = [], raf = 0, px = -1e4, py = -1e4, rgb = '120,150,255'
  const make = () => ({ x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - .5) * .28, vy: (Math.random() - .5) * .28, r: Math.random() * 1.5 + .6, p: Math.random() * 6.28 })
  function tone() {
    const m = /^#([0-9a-f]{6})$/i.exec(getComputedStyle(root).getPropertyValue('--accent').trim())
    if (m) rgb = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)).join(',')
  }
  function size() {
    const dpr = Math.min(devicePixelRatio || 1, 2)
    w = innerWidth
    h = innerHeight
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const n = Math.round(Math.min(90, Math.max(26, (w * h) / 17000)))
    while (points.length < n) points.push(make())
    points.length = n
    tone()
    paint(performance.now(), false)
  }
  function paint(now, step) {
    ctx.clearRect(0, 0, w, h)
    for (const p of points) {
      if (step) {
        p.x += p.vx
        p.y += p.vy
        const dx = p.x - px, dy = p.y - py, d2 = dx * dx + dy * dy
        if (d2 < 16000 && d2 > 1) {
          const f = ((16000 - d2) / 16000) * .7, d = Math.sqrt(d2)
          p.x += (dx / d) * f
          p.y += (dy / d) * f
        }
        if (p.x < -20) p.x = w + 20
        else if (p.x > w + 20) p.x = -20
        if (p.y < -20) p.y = h + 20
        else if (p.y > h + 20) p.y = -20
      }
      ctx.fillStyle = 'rgba(' + rgb + ',' + (.3 + .25 * Math.sin(now / 900 + p.p)).toFixed(3) + ')'
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.r, 0, 6.2832)
      ctx.fill()
    }
    ctx.lineWidth = 1
    for (let i = 0; i < points.length; i++)
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i], b = points[j], dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy
        if (d2 > 16900) continue
        ctx.strokeStyle = 'rgba(' + rgb + ',' + ((1 - Math.sqrt(d2) / 130) * .2).toFixed(3) + ')'
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }
    waves = waves.filter(v => v.r < v.max)
    for (const v of waves) {
      if (step) v.r += 7
      ctx.strokeStyle = 'rgba(' + rgb + ',' + ((1 - v.r / v.max) * .35).toFixed(3) + ')'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(v.x, v.y, v.r, 0, 6.2832)
      ctx.stroke()
    }
  }
  function frame(now) {
    raf = 0
    if (!moving() || document.hidden) return
    paint(now, true)
    raf = requestAnimationFrame(frame)
  }
  function run() {
    if (!raf && moving() && !document.hidden) raf = requestAnimationFrame(frame)
    if (!moving()) {
      waves = []
      paint(0, false)
    }
  }
  addEventListener('resize', size)
  addEventListener('pointermove', e => { px = e.clientX; py = e.clientY }, { passive: true })
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { tone(); run() })
  size()
  return { run, wave(x, y) { if (moving()) waves.push({ x, y, r: 10, max: Math.max(w, h) * .6 }) } }
})()

// 합의문이 오면 색종이가 터진다.
const confetti = (() => {
  const canvas = byId('fx')
  const ctx = canvas.getContext('2d')
  const colors = ['#8aa8ff', '#b9a0ff', '#62d28d', '#f0b84a', '#ff8a80', '#5fd3e6']
  let parts = [], raf = 0, w = 0, h = 0, seen = 0
  // 시간으로 움직인다. 탭이 가려져 그리기가 멈췄다가 돌아오면, 지난 조각은 남기지 않고 바로 치운다.
  function frame(now) {
    raf = 0
    const dt = Math.min(3, (now - seen) / 16.7)
    seen = now
    ctx.clearRect(0, 0, w, h)
    parts = parts.filter(p => now - p.born < 2400 && p.y < h + 40)
    for (const p of parts) {
      const age = now - p.born
      p.vy += .3 * dt
      p.vx *= Math.pow(.99, dt)
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.rot += p.vr * dt
      ctx.save()
      ctx.globalAlpha = age > 1600 ? Math.max(0, 1 - (age - 1600) / 800) : 1
      ctx.translate(p.x, p.y)
      ctx.rotate(p.rot)
      ctx.fillStyle = p.color
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(age / 150 + p.rot)))
      ctx.restore()
    }
    if (parts.length && moving()) raf = requestAnimationFrame(frame)
    else {
      parts = []
      ctx.clearRect(0, 0, w, h)
    }
  }
  return {
    burst(x, y) {
      if (!moving()) return
      const dpr = Math.min(devicePixelRatio || 1, 2)
      w = innerWidth
      h = innerHeight
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      for (let i = 0; i < 120; i++) {
        const a = -Math.PI / 2 + (Math.random() - .5) * 2.4, v = 4 + Math.random() * 10
        parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 2, w: 5 + Math.random() * 6, h: 8 + Math.random() * 6, rot: Math.random() * 6.28, vr: (Math.random() - .5) * .4, color: colors[i % colors.length], born: performance.now() })
      }
      if (!raf) {
        seen = performance.now()
        raf = requestAnimationFrame(frame)
      }
    },
  }
})()

const list = byId('list')
const empty = byId('empty')
const toasts = byId('toasts')
const cards = new Map()

function reveal(node) {
  node.scrollIntoView({ block: 'center', behavior: moving() ? 'smooth' : 'auto' })
  fx(node, [{ scale: 1.03, filter: 'brightness(1.2)' }, { scale: 1, filter: 'brightness(1)' }], { duration: 800, easing: 'ease-out' })
}

// 연결 그림. 가운데가 이 세션이고 둘레가 연결된 세션이다. 글이 오가면 그 선을 따라 빛이 날아간다.
const ME = ':me'
const stage = (() => {
  const box = byId('stage'), net = byId('net'), NS = 'http://www.w3.org/2000/svg'
  const mk = (tag, cls, attrs) => {
    const e = document.createElementNS(NS, tag)
    if (cls) e.setAttribute('class', cls)
    for (const k in attrs || {}) e.setAttribute(k, attrs[k])
    return e
  }
  const defs = mk('defs'), grad = mk('radialGradient', '', { id: 'gme', cx: '35%', cy: '30%', r: '80%' })
  const s1 = mk('stop', '', { offset: '0' }), s2 = mk('stop', '', { offset: '1' })
  s1.style.stopColor = 'var(--accent2)'
  s2.style.stopColor = 'var(--accent)'
  grad.append(s1, s2)
  defs.append(grad)
  const linkLayer = mk('g'), packetLayer = mk('g'), nodeLayer = mk('g')
  net.append(defs, linkLayer, packetLayer, nodeLayer)
  const nodes = new Map()
  let W = 0, H = 190, raf = 0, packets = [], shown = []

  // 세션을 누르면 그 세션과 나눈 대화만 보인다. 다시 누르면 모두 보인다.
  function open(key) {
    setFilter(key)
    byId('filters').scrollIntoView({ block: 'nearest', behavior: moving() ? 'smooth' : 'auto' })
  }
  function node(key, kind) {
    let n = nodes.get(key)
    if (n) return n
    const r = kind === 'me' ? 26 : kind === 'ghost' ? 15 : 20
    const g = mk('g', 'node ' + kind), fl = mk('g', 'fl'), tip = mk('title')
    const core = mk('circle', 'core', { r }), ini = mk('text', 'ini', { dy: '.35em' })
    const orbit = mk('g', 'orbit')
    orbit.append(mk('circle', '', { cx: r + 8, r: 3.2 }), mk('circle', '', { cx: -(r + 8), r: 2.2 }))
    const hb = mk('g', 'hb', { transform: 'translate(' + (r * .78).toFixed(1) + ' ' + (-r * .78).toFixed(1) + ')' })
    const mark = mk('text', '', { dy: '.35em' })
    mark.textContent = '?'
    hb.append(mk('circle', '', { r: 9 }), mark)
    const nm = mk('text', 'nm', { y: r + 20 }), sub = mk('text', 'sub', { y: r + 35 })
    fl.append(mk('circle', 'halo', { r: r + 9 }), orbit, core, ini, hb)
    g.append(tip, fl, nm, sub)
    fl.style.setProperty('--fd', (4 + Math.random() * 3).toFixed(1) + 's')
    fl.style.setProperty('--fo', (-Math.random() * 5).toFixed(1) + 's')
    nodeLayer.append(g)
    n = { key, kind, g, fl, core, ini, nm, sub, tip, r, x: NaN, y: NaN, tx: 0, ty: 0, sign: 1, lk: null }
    if (kind !== 'me') {
      const lg = mk('g', 'lk' + (kind === 'ghost' ? ' ghost' : '')), paths = [mk('path', 'link'), mk('path', 'flow a'), mk('path', 'flow b')]
      lg.append(...paths)
      linkLayer.append(lg)
      n.lk = { g: lg, paths }
      g.setAttribute('tabindex', '0')
      g.setAttribute('role', 'button')
      g.addEventListener('click', () => open(key))
      g.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        open(key)
      })
    }
    nodes.set(key, n)
    fx(fl, [{ scale: 0 }, { scale: 1 }], { duration: 800, easing: SPRING })
    return n
  }
  function drop(n) {
    nodes.delete(n.key)
    if (n.lk) n.lk.g.remove()
    const a = fx(n.g, [{ opacity: 1 }, { opacity: 0 }], { duration: 400, easing: 'ease-in' })
    if (a) a.finished.then(() => n.g.remove(), () => n.g.remove())
    else n.g.remove()
  }
  function label(n, name, sub, since) {
    const chars = Array.from(name)
    put(n.nm, chars.length > 18 ? chars.slice(0, 17).join('') + '…' : name)
    put(n.ini, (Array.from(name.trim())[0] || '?').toUpperCase())
    put(n.tip, name + ' · ' + sub)
    n.g.setAttribute('aria-label', name + ', ' + sub)
    if (since) {
      n.sub.dataset.pre = sub + ' '
      if (n.sub.dataset.since !== since) {
        n.sub.dataset.since = since
        n.sub.textContent = sub + ' ' + clock(Date.now() - Date.parse(since))
      }
    } else {
      delete n.sub.dataset.since
      put(n.sub, sub)
    }
  }
  function layout() {
    const me = nodes.get(ME)
    if (!me) return
    const peers = shown, n = peers.length
    W = Math.max(280, box.clientWidth)
    H = n > 6 ? 340 : n > 2 ? 290 : 190
    net.setAttribute('viewBox', '0 0 ' + W + ' ' + H)
    net.setAttribute('height', H)
    const cy = H / 2 - 14
    me.tx = n === 1 ? W * .28 : W / 2
    me.ty = cy
    if (n === 1) {
      peers[0].tx = W * .72
      peers[0].ty = cy
      peers[0].sign = -1
    } else {
      const rx = Math.min(W * .38, 340), ry = H * .3
      peers.forEach((p, i) => {
        const a = (n === 2 ? Math.PI : -Math.PI / 2) + (i * 2 * Math.PI) / n
        p.tx = W / 2 + Math.cos(a) * rx
        p.ty = cy + Math.sin(a) * ry
        p.sign = i % 2 ? 1 : -1
      })
    }
    // 새로 생긴 세션은 이 세션 자리에서 튀어나온다.
    const still = !moving()
    for (const p of [me].concat(peers))
      if (isNaN(p.x) || still) {
        const from = p === me || still || isNaN(me.x) ? p : me
        p.x = from === p ? p.tx : me.x
        p.y = from === p ? p.ty : me.y
      }
    kick()
  }
  function ctrl(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y
    return { x: (a.x + b.x) / 2 - dy * .16 * b.sign, y: (a.y + b.y) / 2 + dx * .16 * b.sign }
  }
  function draw() {
    const me = nodes.get(ME)
    for (const n of nodes.values()) {
      n.g.style.transform = 'translate(' + n.x.toFixed(1) + 'px,' + n.y.toFixed(1) + 'px)'
      if (!n.lk || !me) continue
      const c = ctrl(me, n)
      const d = 'M' + me.x.toFixed(1) + ' ' + me.y.toFixed(1) + 'Q' + c.x.toFixed(1) + ' ' + c.y.toFixed(1) + ' ' + n.x.toFixed(1) + ' ' + n.y.toFixed(1)
      for (const p of n.lk.paths) p.setAttribute('d', d)
    }
  }
  function pulse(n) {
    const rip = mk('circle', 'rip', { r: n.r })
    n.g.insertBefore(rip, n.g.children[1])
    const a = fx(rip, [{ scale: 1, opacity: .8 }, { scale: 2.6, opacity: 0 }], { duration: 750, easing: 'ease-out' })
    if (a) a.finished.then(() => rip.remove(), () => rip.remove())
    else rip.remove()
    fx(n.core, [{ scale: 1 }, { scale: 1.28 }, { scale: 1 }], { duration: 520, easing: 'ease-out' })
  }
  function fly(p, now) {
    const me = nodes.get(ME), raw = (now - p.t0) / 900
    if (raw < 0) return true
    if (raw >= 1.2 || !me || !nodes.has(p.peer.key)) {
      for (const d of p.dots) d.remove()
      if (!p.hit) pulse(p.to)
      return false
    }
    const c = ctrl(me, p.peer)
    p.dots.forEach((d, i) => {
      let t = Math.min(1, Math.max(0, raw - i * .035))
      t = t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
      if (!p.out) t = 1 - t
      const u = 1 - t
      d.setAttribute('cx', (u * u * me.x + 2 * u * t * c.x + t * t * p.peer.x).toFixed(1))
      d.setAttribute('cy', (u * u * me.y + 2 * u * t * c.y + t * t * p.peer.y).toFixed(1))
      d.style.display = ''
    })
    if (raw >= 1 && !p.hit) {
      p.hit = true
      pulse(p.to)
    }
    return true
  }
  function tick(now) {
    raf = 0
    let busy = false
    const glide = moving()
    for (const n of nodes.values()) {
      const dx = n.tx - n.x, dy = n.ty - n.y
      if (glide && (Math.abs(dx) > .4 || Math.abs(dy) > .4)) {
        n.x += dx * .13
        n.y += dy * .13
        busy = true
      } else {
        n.x = n.tx
        n.y = n.ty
      }
    }
    draw()
    packets = packets.filter(p => fly(p, now))
    if (busy || packets.length) raf = requestAnimationFrame(tick)
  }
  function kick() {
    if (!raf) raf = requestAnimationFrame(tick)
  }
  new ResizeObserver(layout).observe(box)

  return {
    update(data, convs) {
      const me = node(ME, 'me'), want = new Set([ME]), act = new Map()
      const flag = (key, what) => act.set(key, Object.assign(act.get(key) || {}, { [what]: true }))
      for (const c of convs) {
        const ph = phase(c)
        if (ph === 'waiting_for_peer') flag(c.peer, 'think')
        else if (ph === 'your_turn') flag(ME, 'think')
        else if (ph === 'checking_with_your_human') flag(ME, 'human')
        else if (ph === 'peer_checking_with_their_human') flag(c.peer, 'human')
      }
      label(me, data.me.name, data.me.open ? '이 세션 · 포트 ' + data.me.port : '이 세션 · 브릿지 닫힘')
      me.g.classList.toggle('closed', !data.me.open)
      shown = []
      const said = []
      for (const l of (data.links || []).slice(0, 12)) {
        const n = node(l.key, 'peer'), down = l.state !== 'connected'
        want.add(l.key)
        shown.push(n)
        n.g.classList.toggle('down', down)
        n.lk.g.classList.toggle('down', down)
        const sub = down ? '다시 붙는 중' : l.via === 'relay' ? '중계로 연결됨' : l.via === 'pickup' ? '상대가 가져가는 중' : '연결됨'
        label(n, l.name, sub, down ? l.since : '')
        said.push(l.name + ' ' + sub)
      }
      for (const c of (data.connecting || []).slice(0, 4)) {
        const key = ':in:' + c.name, n = node(key, 'ghost')
        want.add(key)
        shown.push(n)
        label(n, c.name, '소개받는 중')
        said.push(c.name + ' 소개받는 중')
      }
      for (const n of [...nodes.values()]) {
        const a = act.get(n.key) || {}
        n.g.classList.toggle('think', !!a.think)
        n.g.classList.toggle('human', !!a.human)
        if (!want.has(n.key)) drop(n)
      }
      net.setAttribute('aria-label', said.length ? '연결된 세션 ' + said.length + '개: ' + said.join(', ') : '연결된 세션이 없습니다')
      layout()
    },
    // 글 하나가 from 에서 to 로 날아간다.
    send(from, to, kind, delay) {
      const a = nodes.get(from), b = nodes.get(to), me = nodes.get(ME)
      if (!a || !b || !me || a === b) return
      if (!moving()) return
      const dots = []
      for (let i = 0; i < 6; i++) {
        const c = mk('circle', 'pkt k-' + kindOf(kind), { r: (5.5 - i * .8).toFixed(1) })
        c.style.opacity = String(1 - i * .16)
        c.style.display = 'none'
        packetLayer.append(c)
        dots.push(c)
      }
      packets.push({ peer: a === me ? b : a, out: a === me, to: b, t0: performance.now() + (delay || 0), dots })
      kick()
    },
    center() {
      const r = box.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    },
    // 골라 둔 세션에 테두리를 두른다.
    select(key) {
      for (const n of nodes.values()) {
        n.g.classList.toggle('sel', !!key && n.key === key)
        if (n.kind === 'peer') n.g.setAttribute('aria-pressed', String(!!key && n.key === key))
      }
    },
  }
})()

// 숫자가 바뀌면 자리마다 굴러서 바뀐다.
const stats = (() => {
  const box = byId('stats'), made = {}
  function stat(key, label) {
    if (made[key]) return made[key]
    const wrap = el('div', 'stat'), num = el('span', 'num'), text = el('span', '', label)
    num.setAttribute('aria-hidden', 'true')
    text.setAttribute('aria-hidden', 'true')
    wrap.setAttribute('role', 'img')
    wrap.append(num, text)
    box.append(wrap)
    return (made[key] = { wrap, num, text, value: '' })
  }
  return {
    set(key, label, n, hot) {
      const s = stat(key, label), value = String(n)
      put(s.text, label)
      s.wrap.classList.toggle('hot', !!hot)
      s.wrap.setAttribute('aria-label', label + ' ' + value)
      if (s.value === value) return
      s.value = value
      while (s.num.children.length < value.length) {
        const dg = el('span', 'dg')
        dg.append(el('span', '', '0123456789'.split('').join(NL)))
        s.num.prepend(dg)
      }
      while (s.num.children.length > value.length) s.num.firstChild.remove()
      // 자리가 새로 생겼으면 0 에서 굴러 올라오게 한 박자 뒤에 값을 넣는다.
      requestAnimationFrame(() => {
        for (let i = 0; i < value.length; i++) if (s.num.children[i]) s.num.children[i].firstChild.style.setProperty('--d', value[i])
      })
    },
  }
})()

// 새 글은 한 낱말씩 써 내려간다. 자리는 미리 잡아 두어서 쓰는 동안 화면이 밀리지 않는다.
function cuts(text) {
  const out = []
  if (window.Intl && Intl.Segmenter) for (const s of new Intl.Segmenter('ko', { granularity: 'word' }).segment(text)) out.push(s.index + s.segment.length)
  else {
    // 낱말 나누기가 없는 브라우저: 빈칸과 글자가 바뀌는 자리에서 끊는다.
    let gap = text.slice(0, 1).trim() === ''
    for (let i = 1; i < text.length; i++) {
      const g = text[i].trim() === ''
      if (g !== gap) out.push(i)
      gap = g
    }
    out.push(text.length)
  }
  if (!out.length) out.push(text.length)
  return out
}
function typeIn(node, text) {
  if (!moving() || document.hidden || text.length < 2 || text.length > 6000) return
  const at = cuts(text), typed = document.createTextNode(''), rest = el('span', 'rest', text)
  node.replaceChildren(typed, el('span', 'caret'), rest)
  const length = Math.min(2800, Math.max(450, text.length * 14)), t0 = performance.now()
  let last = -1
  const finish = () => {
    if (node.typing !== finish) return
    node.typing = null
    node.textContent = text
  }
  const step = now => {
    if (node.typing !== finish) return
    if (!node.isConnected || !moving()) return finish()
    const p = Math.min(1, (now - t0) / length), i = Math.min(at.length - 1, Math.floor(p * at.length))
    if (i !== last) {
      last = i
      typed.data = text.slice(0, at[i])
      rest.textContent = text.slice(at[i])
    }
    if (p < 1) requestAnimationFrame(step)
    else finish()
  }
  node.typing = finish
  requestAnimationFrame(step)
}

function toast(n) {
  const b = el('button', 'toast')
  b.type = 'button'
  b.append(
    el('span', 'tk k-' + kindOf(n.m.kind), '새 ' + (KIND[n.m.kind] ?? n.m.kind)),
    el('span', 'tw', n.m.from === 'me' ? '나 → ' + n.c.peerName : n.c.peerName + ' → 나'),
    el('span', 'ts', n.c.subject),
    el('i', 'life'),
  )
  b.addEventListener('click', () => {
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
async function leave(wrap) {
  wrap.classList.add('gone')
  const running = wrap.firstChild.getAnimations ? wrap.firstChild.getAnimations() : []
  if (moving() && running.length) await Promise.race([Promise.allSettled(running.map(a => a.finished)), new Promise(r => setTimeout(r, 900))])
  wrap.remove()
}

function makeCard() {
  const wrap = el('div', 'wrap'), card = el('section', 'conv'), head = el('div', 'head')
  const badge = el('span', 'badge'), subject = el('h2', 'subject'), status = el('span', 'status'), stext = el('span'), agoEl = el('span', 'ago')
  const SVG = 'http://www.w3.org/2000/svg', ck = document.createElementNS(SVG, 'svg'), tick = document.createElementNS(SVG, 'path')
  ck.setAttribute('class', 'ck')
  ck.setAttribute('viewBox', '0 0 16 16')
  ck.setAttribute('aria-hidden', 'true')
  tick.setAttribute('d', 'M3 8.5l3.2 3L13 4.5')
  ck.append(tick)
  status.append(el('i', 'sdot'), ck, stext, agoEl)
  head.append(badge, subject, status)
  const meta = el('div', 'meta'), msgs = el('ol', 'msgs'), typing = el('div', 'typing'), dots = el('span', 'dots'), tlabel = el('span'), timer = el('span', 'timer')
  dots.append(el('i'), el('i'), el('i'))
  dots.setAttribute('aria-hidden', 'true')
  typing.append(dots, tlabel, timer)
  const glow = el('div', 'fxl'), shine = el('i', 'shine'), people = el('div', 'people')
  glow.setAttribute('aria-hidden', 'true')
  glow.append(shine)
  card.append(glow, head, meta, people, msgs, typing)
  wrap.append(card)
  return { wrap, card, badge, subject, status, stext, tick, shine, ago: agoEl, meta, people, msgs, typing, tlabel, timer, seen: new Map(), st: undefined, label: '', peers: [] }
}
function bubble(c, m, everyone) {
  const cls = m.kind === 'agreement' ? 'agreement' : m.kind === 'note' || m.kind === 'closed' ? 'note' : m.from === 'me' ? 'mine' : 'peer'
  const li = el('li', 'msg ' + cls), b = el('div', 'bubble'), who = el('div', 'who'), at = el('time', 'time', shortTime(m.at))
  at.dateTime = m.at
  at.title = time(m.at)
  // 여럿이 있는 방에서는 누가 한 말인지 얼굴(이름 첫 글자)을 붙인다.
  if (everyone && m.from !== 'me') who.append(el('span', 'av', (Array.from(c.peerName.trim())[0] || '?').toUpperCase()))
  who.append(el('span', '', KIND[m.kind] ?? m.kind))
  if (m.human) who.append(el('span', 'hum', '사람이 정함'))
  const shared = everyone && m.from === 'me' && m.kind === 'question'
  who.append(el('span', 'dir', shared ? '나 → ' + everyone.join(', ') : m.from === 'me' ? '나 → ' + c.peerName : c.peerName + ' → 나'), at)
  const text = el('div', 'text', m.text)
  b.append(who, text)
  if (m.kind === 'agreement') b.append(el('span', 'stamp', '합의'))
  if (m.context) {
    const d = el('details')
    d.append(el('summary', '', '함께 보낸 배경'), el('div', 'text', m.context))
    b.append(d)
  }
  li.append(b)
  li.body = text
  // 써 내려가는 중에 누르면 바로 끝까지 보여 준다.
  li.addEventListener('click', () => text.typing && text.typing())
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
  for (const p of ['checking_with_your_human', 'peer_checking_with_their_human', 'your_turn', 'waiting_for_peer']) if (phases.includes(p)) return p
  for (const p of ['agreed', 'closed']) if (phases.every(one => one === p)) return p
  return phases.includes('answered') ? 'answered' : phases.includes('answered_by_me') ? 'answered_by_me' : phases[0]
}
const PERSON = { waiting_for_peer: ['wait', '기다리는 중'], peer_checking_with_their_human: ['human', '사람에게 확인 중'], answered: ['ok', '답함'], answered_by_me: ['ok', '답함'], agreed: ['ok', '합의'], closed: ['', '마감'] }

// 카드 하나를 지금 방에 맞춘다. 이미 있는 것은 그대로 두고 달라진 것만 바꾼다. 그래야 새로 온 것만 움직인다.
function paint(v, room, live, index, news) {
  const convs = room.convs, c = convs[0], group = convs.length > 1
  const mine = c.startedBy === 'me', first = c.messages[0]
  const names = convs.map(one => one.peerName)
  v.peers = convs.map(one => one.peer)
  put(v.badge, group ? '여럿에게 보낸 질문' : mine ? '보낸 질문' : '받은 질문')
  v.badge.classList.toggle('out', mine)
  put(v.subject, c.subject)
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
    v.typing.classList.toggle('r', ph === 'your_turn' || ph === 'checking_with_your_human')
    if (live && was !== undefined) {
      fx(v.status, [{ rotate: 'x 90deg', opacity: 0 }, { rotate: 'x 0deg', opacity: 1 }], { duration: 600, easing: SPRING })
      // 답이 와서 질문과 답이 끝났다. 가장 흔한 끝이므로 여기에도 작은 마무리를 둔다: 체크가 그려지고 빛이 한 번 지나간다.
      if (changed && (ph === 'answered' || ph === 'answered_by_me')) {
        fx(v.tick, [{ strokeDashoffset: 16 }, { strokeDashoffset: 0 }], { duration: 600, delay: 300, easing: 'ease-out', fill: 'backwards' })
        fx(v.shine, [{ translate: '-130% 0' }, { translate: '330% 0' }], { duration: 1100, easing: 'ease-in-out' })
      }
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
  }
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
      if (!live) node.style.setProperty('--i', Math.min(index + i + 1, 10))
      v.seen.set(it.id, node)
      v.msgs.insertBefore(node, after)
      if (live) news.unshift({ c: it.c, m: it.m, v, node })
    }
    after = node
  }
}

// 여러 세션과 이어져 있으면 세션을 골라 그 세션과 나눈 대화만 본다. 연결 그림의 세션을 눌러도 된다.
const filters = byId('filters')
let filter = ''
function setFilter(key) {
  filter = filter === key ? '' : key
  applyFilter(true)
}
function applyFilter(byPerson) {
  const slide = byPerson && moving(), before = new Map()
  if (slide) for (const v of cards.values()) if (!v.wrap.hidden) before.set(v, v.wrap.getBoundingClientRect().top)
  let count = 0
  for (const v of cards.values()) {
    const hide = !!filter && !v.peers.includes(filter)
    if (v.wrap.hidden !== hide) v.wrap.hidden = hide
    if (!hide) count++
  }
  empty.hidden = count > 0
  put(byId('emptyText'), filter ? '이 세션과 나눈 대화가 아직 없습니다.' : '아직 주고받은 질문이 없습니다.')
  if (slide)
    for (const [v, top] of before) {
      if (v.wrap.hidden) continue
      if (v.slide) v.slide.cancel()
      const dy = top - v.wrap.getBoundingClientRect().top
      if (Math.abs(dy) > 1) v.slide = v.wrap.animate([{ translate: '0 ' + dy.toFixed(1) + 'px' }, { translate: '0 0' }], { duration: 700, easing: SPRING })
    }
  for (const b of filters.children) {
    const on = (b.dataset.key || '') === filter
    b.classList.toggle('sel', on)
    b.setAttribute('aria-pressed', String(on))
  }
  stage.select(filter)
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

// 접근키(연결 코드)를 화면에서 만든다. 사람을 더할 때, 그리고 끊긴 상대가 다시 들어오게 할 때 쓴다.
const keybox = byId('keybox'), keycode = byId('keycode'), keycopy = byId('keycopy'), issueButton = byId('issue')
let keyFor = ''
let hasKey = false
async function issueKey(name) {
  keyFor = name
  hasKey = false
  put(byId('keyhelp'), name ? name + ' 쪽에 이 접근키를 다시 보내세요. 그쪽 AI가 이 코드로 다시 연결하면 이어집니다.' : '함께할 동료에게 이 접근키를 보내세요. 동료가 자기 AI에게 「이 코드로 연결해줘」라고 하면 이어집니다.')
  put(keycode, '만드는 중…')
  put(byId('keyinfo'), '')
  if (!keybox.open) keybox.showModal()
  try {
    const res = await fetch(location.pathname + '/code', { method: 'POST', headers: { 'x-coworker-viewer': '1' } })
    if (!res.ok) throw new Error(String(res.status))
    const made = await res.json()
    hasKey = true
    put(keycode, made.code)
    put(byId('keyinfo'), '한 사람만, 한 번만 쓸 수 있습니다. ' + shortTime(made.expires) + '까지 쓸 수 있습니다.')
    fx(keycode, [{ scale: .96, opacity: .3 }, { scale: 1, opacity: 1 }], { duration: 500, easing: SPRING })
  } catch (e) {
    put(keycode, '')
    put(byId('keyinfo'), e.message === '409' ? '브릿지가 닫혀 있어서 만들 수 없습니다. AI에게 「브릿지 열어줘」라고 하세요.' : e.message === '429' ? '잠시 뒤에 다시 눌러 주세요.' : '접근키를 만들지 못했습니다. 세션이 켜져 있는지 확인하세요.')
  }
}
issueButton.addEventListener('click', () => issueKey(''))
byId('keyagain').addEventListener('click', () => issueKey(keyFor))
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
      again.addEventListener('click', () => issueKey(l.name))
      row.append(text, again)
      return row
    }),
  )
}

let follow = saved.get('coworker.follow') !== 'off'
let touched = 0
// 새로 온 글을 알린다: 연결 그림에 빛이 날아가고, 글이 써 내려가고, 알림이 뜬다. 합의문이면 색종이가 터진다.
function announce(news) {
  const few = news.length <= 4
  news.forEach((n, i) => {
    const recent = i >= news.length - 3
    if (i < 8) stage.send(n.m.from === 'me' ? ME : n.c.peer, n.m.from === 'me' ? n.c.peer : ME, n.m.kind, i * 140)
    if (few || recent) typeIn(n.node.body, n.m.text)
    if (recent) toast(n)
    if (n.m.kind === 'agreement' && recent) {
      const stamp = n.node.querySelector('.stamp')
      if (stamp) fx(stamp, [{ scale: 2.8, opacity: 0, rotate: '-24deg' }, { scale: 1, opacity: 1, rotate: '-6deg' }], { duration: 800, easing: SPRING })
      const r = n.node.getBoundingClientRect()
      confetti.burst(Math.min(innerWidth - 20, Math.max(20, r.left + r.width / 2)), Math.min(innerHeight - 20, Math.max(20, r.top + 20)))
    }
  })
  const c = stage.center()
  sky.wave(c.x, c.y)
  const newest = news[news.length - 1]
  // 따라가기를 켰으면 새 글이 보이게 옮긴다. 사람이 방금 화면을 만졌으면 건드리지 않는다.
  if (follow && Date.now() - touched > 3000) newest.node.scrollIntoView({ block: 'nearest', behavior: moving() ? 'smooth' : 'auto' })
}

let first = true
function render(data) {
  const live = !first
  first = false
  const me = data.me
  const relay = me.relay ? ' · 중계 서버 ' + ({ connected: '연결됨', connecting: '연결하는 중', off: '꺼짐' }[me.relay.status] ?? '닿지 않음') : ''
  put(byId('me'), me.name + (me.open ? ' · 포트 ' + me.port + ' 열림' : ' · 브릿지 닫힘') + relay)
  const convs = [...data.conversations].sort((a, b) => (b.messages[0]?.at ?? '').localeCompare(a.messages[0]?.at ?? ''))
  const links = data.links || []
  const up = links.filter(l => l.state === 'connected').length
  const asking = convs.filter(c => c.status === 'checking_with_your_human' || c.status === 'peer_checking_with_their_human').length
  const unanswered = convs.filter(c => ['waiting_for_peer', 'your_turn'].includes(phase(c))).length
  stats.set('links', up < links.length ? '연결 (끊김 ' + (links.length - up) + ')' : '연결', up, false)
  const groups = roomsOf(convs)
  stats.set('convs', '대화', groups.length, false)
  stats.set('msgs', '글', convs.reduce((n, c) => n + c.messages.length, 0), false)
  stats.set('open', '답 기다림', unanswered, false)
  stats.set('humans', '사람 결정 대기', asking, asking > 0)
  stage.update(data, convs)
  issueButton.disabled = !me.open
  syncDowns(links)

  // 카드가 밀려나는 것을 부드럽게 잇는다: 바꾸기 전 자리를 재 두고, 바꾼 뒤 그 차이만큼 미끄러져 오게 한다.
  const slide = live && moving()
  const before = new Map()
  if (slide) for (const v of cards.values()) before.set(v, v.wrap.getBoundingClientRect().top)
  const news = [], keep = new Set()
  let prev = null
  groups.forEach((room, i) => {
    keep.add(room.id)
    let v = cards.get(room.id)
    if (!v) {
      v = makeCard()
      cards.set(room.id, v)
      if (!live) {
        v.card.style.setProperty('--i', Math.min(i, 8))
        setTimeout(() => v.card.style.removeProperty('--i'), 2000)
      }
      list.insertBefore(v.wrap, prev ? prev.nextSibling : list.firstChild)
    }
    paint(v, room, live, i, news)
    if (filter && !v.peers.includes(filter)) v.wrap.hidden = true
    prev = v.wrap
  })
  for (const [id, v] of [...cards])
    if (!keep.has(id)) {
      cards.delete(id)
      leave(v.wrap)
    }
  syncFilters(groups, links)
  applyFilter(false)
  if (slide)
    for (const [v, top] of before) {
      if (!v.wrap.isConnected) continue
      if (v.slide) v.slide.cancel()
      const dy = top - v.wrap.getBoundingClientRect().top
      if (Math.abs(dy) > 1) v.slide = v.wrap.animate([{ translate: '0 ' + dy.toFixed(1) + 'px' }, { translate: '0 0' }], { duration: 700, easing: SPRING })
    }
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
  for (const n of document.querySelectorAll('[data-ago]')) put(n, '· ' + ago(now - Date.parse(n.dataset.ago)))
}, 1000)

// 카드 위에서 마우스를 움직이면 카드가 살짝 기울고 빛이 따라온다. 긴 카드는 덜 기운다.
const fine = matchMedia('(hover: hover) and (pointer: fine)')
let tilt = null
list.addEventListener('pointermove', e => {
  if (!moving() || !fine.matches) return
  const card = e.target.closest ? e.target.closest('.conv') : null
  if (!card) return
  const go = !tilt
  tilt = { card, x: e.clientX, y: e.clientY }
  if (go)
    requestAnimationFrame(() => {
      const t = tilt
      tilt = null
      const r = t.card.getBoundingClientRect(), x = (t.x - r.left) / r.width, y = (t.y - r.top) / r.height, k = Math.min(1, 420 / r.height)
      t.card.style.setProperty('--mx', (x * 100).toFixed(1) + '%')
      t.card.style.setProperty('--my', (y * 100).toFixed(1) + '%')
      t.card.style.setProperty('--ry', ((x - .5) * 2.4).toFixed(2) + 'deg')
      t.card.style.setProperty('--rx', ((.5 - y) * 2.4 * k).toFixed(2) + 'deg')
    })
})
list.addEventListener('pointerout', e => {
  const card = e.target.closest ? e.target.closest('.conv') : null
  if (!card || (e.relatedTarget && card.contains(e.relatedTarget))) return
  card.style.removeProperty('--rx')
  card.style.removeProperty('--ry')
})
for (const name of ['wheel', 'touchstart', 'keydown', 'pointerdown']) addEventListener(name, () => { touched = Date.now() }, { passive: true })

const motionButton = byId('motion'), followButton = byId('follow')
function applyMotion() {
  root.classList.toggle('on', moving())
  put(motionButton, moving() ? '모션 끄기' : '모션 켜기')
  sky.run()
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
    sky.run()
  }
})
if (!document.hidden) connect()
</script>
</body>
</html>
`
