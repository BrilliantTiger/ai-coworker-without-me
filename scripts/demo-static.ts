#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PAGE } from '../src/page'
import { scenario } from './demo-scenario'

// 소개 사이트(GitHub Pages)에 올리는 대화 화면 데모를 만든다(2026-11-17, 사람이 정함: 「github page 최신화에 demo를 익명화 해서 넣으라」).
// 진짜 대화 화면에 꾸민 대화를 미리 만들어 넣은 파일 하나다. 서버 없이 브라우저 안에서만 돌고, 아무것도 밖으로 보내지 않는다.
// 대화의 내용은 demo-scenario.ts 에 있다. 이름은 익명이다.
//   bun scripts/demo-static.ts <나올 파일>     예: bun scripts/demo-static.ts ../coworker-pages/demo/index.html

const out = process.argv[2]
if (!out) {
  console.error('usage: bun scripts/demo-static.ts <output file>')
  process.exit(1)
}

// 꾸민 시계로 대화를 끝까지 흘려서 장면마다의 내용을 모은다. 시각은 볼 때 지금 시각에 맞게 옮긴다.
const base = Date.UTC(2026, 0, 1)
let clock = base
const demo = scenario(() => clock)
const frames = [{ at: 0, state: structuredClone(demo.state) }]
for (const [wait, change] of demo.steps) {
  clock += wait
  change()
  frames.push({ at: clock - base, state: structuredClone(demo.state) })
}

// 내용 안의 닫는 태그가 스크립트를 끝내지 못하게 빗금을 막아 둔다.
const data = JSON.stringify({ base, length: clock - base, frames }).replaceAll('</', '<\\/')
const player = readFileSync(join(import.meta.dir, 'demo-player.js'), 'utf8')
const mark = '<script>'
if (PAGE.split(mark).length !== 2) throw new Error('the page should have exactly one script')
const html = PAGE.replace('<title>Coworker 대화</title>', '<title>Coworker 대화 화면 데모</title>\n<meta name="robots" content="noindex">').replace(
  mark,
  () => `<script>window.COWORKER_DEMO = ${data}</script>\n<script>\n${player}</script>\n${mark}`,
)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, html)
console.log(`wrote ${out} (${Math.round(html.length / 1024)} KiB, ${frames.length} scenes, ${Math.round((clock - base) / 1000)} s loop)`)
