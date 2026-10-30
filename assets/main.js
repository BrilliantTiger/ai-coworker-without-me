(() => {
  'use strict'

  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  const finePointer = matchMedia('(pointer: fine)').matches
  const $ = (s, r = document) => r.querySelector(s)
  const $$ = (s, r = document) => [...r.querySelectorAll(s)]
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
  const NS = 'http://www.w3.org/2000/svg'

  if (!reduce) document.documentElement.classList.add('anim')

  // 보일 때만 진행한다. 화면 밖이거나 탭이 숨겨지면 다음 단계에서 기다린다.
  function makeGate(el, threshold = 0.08) {
    let visible = false
    let waiters = []
    const flush = () => {
      if (!visible || document.hidden) return
      const w = waiters
      waiters = []
      w.forEach(f => f())
    }
    new IntersectionObserver(([e]) => { visible = e.isIntersecting; flush() }, { threshold }).observe(el)
    document.addEventListener('visibilitychange', flush)
    return { wait: () => (visible && !document.hidden ? Promise.resolve() : new Promise(r => waiters.push(r))) }
  }

  function tween(ms, fn) {
    return new Promise(resolve => {
      const t0 = performance.now()
      const step = now => {
        const t = Math.min(1, (now - t0) / ms)
        fn(t)
        if (t < 1) requestAnimationFrame(step)
        else resolve()
      }
      requestAnimationFrame(step)
    })
  }

  /* ───────────── split text ───────────── */
  const counters = new Map()
  function split(el) {
    const key = el.closest('.headline') || el
    let i = counters.get(key) || 0
    const text = el.textContent.replace(/\s+/g, ' ').trim()
    const visual = document.createElement('span')
    visual.setAttribute('aria-hidden', 'true')
    for (const node of [...el.childNodes]) {
      if (node.nodeType === Node.TEXT_NODE) {
        for (const part of node.textContent.split(/(\s+)/)) {
          if (!part) continue
          if (/^\s+$/.test(part)) { visual.append(' '); continue }
          const w = document.createElement('span')
          w.className = 'w'
          for (const c of part) {
            const s = document.createElement('span')
            s.className = 'ch'
            s.style.setProperty('--i', i++)
            s.textContent = c
            w.append(s)
          }
          visual.append(w)
        }
      } else {
        // 그라디언트를 입힌 글자처럼 묶음으로 둬야 하는 요소는 통째로 한 글자처럼 움직인다.
        const w = document.createElement('span')
        w.className = 'w'
        const s = document.createElement('span')
        s.className = 'ch'
        s.style.setProperty('--i', i)
        i += 2
        s.append(node)
        w.append(s)
        visual.append(w)
      }
    }
    counters.set(key, i)
    const label = document.createElement('span')
    label.className = 'sr-only'
    label.textContent = text
    el.textContent = ''
    el.append(label, visual)
  }
  if (!reduce) $$('[data-split]').forEach(split)

  /* ───────────── reveal + in-view ───────────── */
  const revealIO = new IntersectionObserver(
    es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); revealIO.unobserve(e.target) } }),
    { threshold: 0.16, rootMargin: '0px 0px -6% 0px' },
  )
  $$('[data-reveal], [data-split]').forEach(el => revealIO.observe(el))
  const playIO = new IntersectionObserver(es => es.forEach(e => e.target.classList.toggle('in-view', e.isIntersecting)), { threshold: 0.15 })
  $$('.tile, .card').forEach(el => playIO.observe(el))

  /* ───────────── nav + progress ───────────── */
  const nav = $('.nav')
  const bar = $('.progress i')
  let scrollQueued = false
  const onScroll = () => {
    if (scrollQueued) return
    scrollQueued = true
    requestAnimationFrame(() => {
      scrollQueued = false
      const y = scrollY
      nav.classList.toggle('scrolled', y > 24)
      const h = document.documentElement.scrollHeight - innerHeight
      bar.style.setProperty('--p', h > 0 ? Math.min(1, y / h).toFixed(4) : '0')
    })
  }
  addEventListener('scroll', onScroll, { passive: true })
  onScroll()

  /* ───────────── pointer effects ───────────── */
  if (finePointer && !reduce) {
    // 커서를 따라오는 빛
    const aura = $('.aura')
    let tx = -999, ty = -999, ax = -999, ay = -999, auraRunning = false
    const auraFrame = () => {
      ax += (tx - ax) * 0.12
      ay += (ty - ay) * 0.12
      aura.style.setProperty('--ax', `${ax.toFixed(1)}px`)
      aura.style.setProperty('--ay', `${ay.toFixed(1)}px`)
      if (Math.abs(tx - ax) + Math.abs(ty - ay) > 0.5) requestAnimationFrame(auraFrame)
      else auraRunning = false
    }
    addEventListener('pointermove', e => {
      tx = e.clientX
      ty = e.clientY
      if (ax < -900) { ax = tx; ay = ty }
      if (!auraRunning) { auraRunning = true; requestAnimationFrame(auraFrame) }
    }, { passive: true })

    // 카드 위의 스포트라이트
    $$('.card, .tile').forEach(card => {
      card.addEventListener('pointermove', e => {
        const r = card.getBoundingClientRect()
        card.style.setProperty('--sx', `${e.clientX - r.left}px`)
        card.style.setProperty('--sy', `${e.clientY - r.top}px`)
      })
    })

    // 자석 버튼
    $$('.magnetic').forEach(btn => {
      btn.addEventListener('pointermove', e => {
        const r = btn.getBoundingClientRect()
        btn.style.setProperty('--mx', `${((e.clientX - r.left - r.width / 2) * 0.28).toFixed(1)}px`)
        btn.style.setProperty('--my', `${((e.clientY - r.top - r.height / 2) * 0.35).toFixed(1)}px`)
      })
      btn.addEventListener('pointerleave', () => { btn.style.setProperty('--mx', '0px'); btn.style.setProperty('--my', '0px') })
    })

    // 히어로 무대 기울이기
    const stage = $('#hero-stage')
    const hero = $('.hero')
    hero.addEventListener('pointermove', e => {
      const r = stage.getBoundingClientRect()
      const nx = (e.clientX - (r.left + r.width / 2)) / r.width
      const ny = (e.clientY - (r.top + r.height / 2)) / r.height
      stage.style.setProperty('--ty', `${(nx * 6).toFixed(2)}deg`)
      stage.style.setProperty('--tx', `${(-ny * 5).toFixed(2)}deg`)
    })
    hero.addEventListener('pointerleave', () => { stage.style.setProperty('--tx', '0deg'); stage.style.setProperty('--ty', '0deg') })
  }

  /* ───────────── background constellation ───────────── */
  function sky() {
    const canvas = $('#sky')
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let w = 0, h = 0, pts = []
    const mouse = { x: -1e4, y: -1e4 }
    const resize = () => {
      const dpr = Math.min(devicePixelRatio || 1, 2)
      w = innerWidth
      h = innerHeight
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const n = Math.round(Math.min(120, Math.max(36, (w * h) / 15000)))
      pts = Array.from({ length: n }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.28,
        vy: (Math.random() - 0.5) * 0.28,
        r: Math.random() * 1.5 + 0.6,
        mint: Math.random() < 0.45,
      }))
    }
    let resizeTimer = 0
    addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 150) })
    addEventListener('pointermove', e => { mouse.x = e.clientX; mouse.y = e.clientY }, { passive: true })
    document.addEventListener('pointerleave', () => { mouse.x = mouse.y = -1e4 })
    resize()
    const LINK = 118, PUSH = 150
    let running = true
    const frame = () => {
      if (!running) return
      ctx.clearRect(0, 0, w, h)
      for (const p of pts) {
        p.x += p.vx
        p.y += p.vy
        if (p.x < -10) p.x = w + 10
        if (p.x > w + 10) p.x = -10
        if (p.y < -10) p.y = h + 10
        if (p.y > h + 10) p.y = -10
        const dx = p.x - mouse.x, dy = p.y - mouse.y
        const d = Math.hypot(dx, dy)
        if (d < PUSH && d > 0.1) {
          const f = (1 - d / PUSH) * 0.9
          p.x += (dx / d) * f
          p.y += (dy / d) * f
        }
      }
      ctx.lineWidth = 1
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i]
        for (let j = i + 1; j < pts.length; j++) {
          const b = pts[j]
          const dx = a.x - b.x, dy = a.y - b.y
          if (Math.abs(dx) > LINK || Math.abs(dy) > LINK) continue
          const d = Math.hypot(dx, dy)
          if (d < LINK) {
            ctx.strokeStyle = `rgba(165, 172, 235, ${((1 - d / LINK) * 0.2).toFixed(3)})`
            ctx.beginPath()
            ctx.moveTo(a.x, a.y)
            ctx.lineTo(b.x, b.y)
            ctx.stroke()
          }
        }
        const md = Math.hypot(a.x - mouse.x, a.y - mouse.y)
        if (md < 190) {
          ctx.strokeStyle = `rgba(242, 132, 92, ${((1 - md / 190) * 0.45).toFixed(3)})`
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(mouse.x, mouse.y)
          ctx.stroke()
        }
      }
      for (const p of pts) {
        ctx.fillStyle = p.mint ? 'rgba(110, 231, 200, 0.8)' : 'rgba(242, 132, 92, 0.8)'
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.fill()
      }
      requestAnimationFrame(frame)
    }
    document.addEventListener('visibilitychange', () => {
      const was = running
      running = !document.hidden
      if (running && !was) requestAnimationFrame(frame)
    })
    requestAnimationFrame(frame)
  }
  if (!reduce) sky()

  /* ───────────── hero: two terminals talking ───────────── */
  function makeTerm(el, gate) {
    const lines = $('.lines', el)
    const MAX = 16
    const term = {
      clear() { lines.textContent = '' },
      add(text, cls = '') {
        const p = document.createElement('p')
        if (cls) p.className = cls
        p.textContent = text
        lines.append(p)
        while (lines.children.length > MAX) lines.firstElementChild.remove()
        return p
      },
      async type(text, cls = 'you') {
        const p = term.add('', `${cls} caret`)
        for (const c of text) {
          await gate.wait()
          p.textContent += c
          await sleep(26 + Math.random() * 34)
        }
        p.classList.remove('caret')
        return p
      },
      async spin(text, ms) {
        const p = term.add('', 'tool')
        const s = document.createElement('span')
        s.className = 'spin'
        p.append(s, ` ${text}`)
        const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
        const t0 = performance.now()
        let k = 0
        while (performance.now() - t0 < ms) {
          s.textContent = frames[k++ % frames.length]
          await sleep(80)
        }
        return p
      },
    }
    return term
  }

  function visibleWire() {
    return $$('.wire svg').find(s => s.getBoundingClientRect().width > 0)
  }

  // 연결선을 따라 꼬리 달린 패킷이 날아간다. 크기는 화면 픽셀 기준으로 맞춘다.
  function packet(svg, { back = false, color, label, dur = 1250 }) {
    return new Promise(resolve => {
      const path = $('.track', svg)
      const len = path.getTotalLength()
      const vb = svg.viewBox.baseVal
      const box = svg.getBoundingClientRect()
      const scale = Math.min(box.width / vb.width, box.height / vb.height) || 1
      const px = v => v / scale
      const layer = $('.packets', svg)
      const tail = document.createElementNS(NS, 'path')
      tail.setAttribute('d', path.getAttribute('d'))
      tail.setAttribute('class', 'pk-tail')
      tail.style.stroke = color
      tail.style.color = color
      tail.style.strokeWidth = px(3.5)
      const seg = len * 0.26
      tail.setAttribute('stroke-dasharray', `${seg} ${len * 2}`)
      const glow = document.createElementNS(NS, 'circle')
      glow.setAttribute('r', px(12))
      glow.setAttribute('fill', color)
      glow.setAttribute('opacity', '0.22')
      const head = document.createElementNS(NS, 'circle')
      head.setAttribute('r', px(5))
      head.setAttribute('fill', color)
      const tag = document.createElementNS(NS, 'g')
      tag.setAttribute('class', 'pk-tag')
      const rect = document.createElementNS(NS, 'rect')
      rect.setAttribute('stroke', color)
      rect.setAttribute('rx', px(9))
      rect.style.strokeWidth = px(1)
      const text = document.createElementNS(NS, 'text')
      text.setAttribute('fill', color)
      text.setAttribute('font-size', px(12))
      text.setAttribute('dominant-baseline', 'central')
      text.textContent = `🔒 ${label}`
      tag.append(rect, text)
      layer.append(tail, glow, head, tag)
      const tw = text.getComputedTextLength()
      rect.setAttribute('width', tw + px(16))
      rect.setAttribute('height', px(22))
      text.setAttribute('x', px(8))
      text.setAttribute('y', px(11))
      tween(dur, t => {
        const e = easeInOut(t)
        const d = back ? len * (1 - e) : len * e
        const pt = path.getPointAtLength(d)
        head.setAttribute('cx', pt.x)
        head.setAttribute('cy', pt.y)
        glow.setAttribute('cx', pt.x)
        glow.setAttribute('cy', pt.y)
        tail.setAttribute('stroke-dashoffset', back ? -d : seg - d)
        tag.setAttribute('transform', `translate(${pt.x - (tw + px(16)) / 2} ${pt.y - px(36)})`)
        const fade = t < 0.12 ? t / 0.12 : t > 0.88 ? (1 - t) / 0.12 : 1
        tag.setAttribute('opacity', fade.toFixed(3))
        tail.setAttribute('opacity', fade.toFixed(3))
      }).then(() => {
        tail.remove(); glow.remove(); head.remove(); tag.remove()
        resolve()
      })
    })
  }

  function heroStatic(me, peer) {
    me.add('› coworker 연결됨 · web-app (Codex)', 'tool')
    me.add('웹 팀에 로그인 응답 token 필드 바뀐 거 반영됐는지 물어봐', 'you')
    me.add('⏺ coworker.send_question → web-app', 'tool')
    me.add('← web-app: 반영됐어요 · 근거 auth.ts:42', 'in-peer')
    me.add('← web-app: (사람이 정함) API 먼저 배포', 'in-peer')
    me.add('합의문 저장 · ~/.coworker/agreements/', 'file')
    peer.add('← api-server: token 필드 바뀐 것 반영됐나요?', 'in-me')
    peer.add('✓ auth.ts:42 에서 새 token 필드를 읽고 있음', 'ok')
    peer.add('⏸ 정해야 하는 질문이라 사람에게 묻는 중', 'warn')
    peer.add('동료가 정함: API 먼저 배포', 'ok')
    peer.add('합의문 저장 · ~/.coworker/agreements/', 'file')
  }

  async function hero() {
    const stage = $('#hero-stage')
    if (!stage) return
    const gate = makeGate(stage)
    const me = makeTerm($('[data-term="me"]'), gate)
    const peer = makeTerm($('[data-term="peer"]'), gate)
    if (reduce) { heroStatic(me, peer); return }
    const wMe = $('.watcher.me'), wPeer = $('.watcher.peer')
    const stateMe = $('.state', wMe), statePeer = $('.state', wPeer)
    const choice = $('.choice', wPeer), pointer = $('.pointer', choice), pickA = $('[data-pick="a"]', choice)
    const wait = async ms => { await gate.wait(); await sleep(ms) }
    const send = async (back, label) => {
      await gate.wait()
      const svg = visibleWire()
      if (svg) await packet(svg, { back, label, color: back ? '#6EE7C8' : '#F2845C' })
    }
    await sleep(900)
    for (;;) {
      me.clear(); peer.clear()
      stateMe.textContent = '지켜보는 중'; statePeer.textContent = '지켜보는 중'
      me.add('› coworker 연결됨 · web-app (Codex)', 'tool')
      peer.add('› coworker 연결됨 · api-server (Claude Code)', 'tool')
      await wait(600)
      await me.type('웹 팀에 로그인 응답 token 필드 바뀐 거 반영됐는지 물어봐')
      await wait(300)
      me.add('⏺ coworker.send_question → web-app', 'tool')
      await send(false, '질문')
      peer.add('← api-server: 로그인 응답 token 필드 바뀐 것 반영됐나요?', 'in-me')
      await wait(350)
      const reading = await peer.spin('src/api/auth.ts 읽는 중', 1300)
      reading.className = 'ok'
      reading.textContent = '✓ auth.ts:42 에서 새 token 필드를 읽고 있음'
      await wait(300)
      peer.add('⏺ coworker.reply → api-server', 'tool')
      await send(true, '답')
      me.add('← web-app: 반영됐어요 · 근거 auth.ts:42', 'in-peer')
      stateMe.textContent = '알림 받음 · 반영 완료'
      await wait(1100)

      await me.type('배포는 어느 쪽이 먼저 할지도 물어봐')
      me.add('⏺ coworker.send_question → web-app', 'tool')
      await send(false, '질문')
      peer.add('← api-server: 배포 순서를 정해야 해요. 누가 먼저?', 'in-me')
      await wait(400)
      peer.add('⏸ 정해야 하는 질문이라 사람에게 묻는 중', 'warn')
      peer.add('⏺ coworker.check_with_human', 'tool')
      await send(true, '확인 중')
      me.add('← web-app: 사람에게 확인 중…', 'in-peer')
      wPeer.classList.add('deciding')
      statePeer.textContent = '결정하는 중'
      choice.classList.add('show')
      await wait(900)
      pointer.classList.add('go')
      await wait(950)
      pointer.classList.add('press')
      pickA.classList.add('picked')
      await wait(220)
      pointer.classList.remove('press')
      await wait(800)
      choice.classList.remove('show')
      wPeer.classList.remove('deciding')
      statePeer.textContent = '결정함 · API 먼저'
      peer.add('동료가 정함: API 먼저 배포', 'ok')
      peer.add('⏺ coworker.reply → api-server', 'tool')
      await send(true, '사람의 결정')
      me.add('← web-app: (사람이 정함) API 먼저 배포', 'in-peer')
      await wait(600)

      me.add('⏺ coworker.write_agreement', 'tool')
      await send(false, '합의문')
      me.add('합의문 저장 · ~/.coworker/agreements/', 'file')
      peer.add('합의문 저장 · ~/.coworker/agreements/', 'file')
      stateMe.textContent = '합의문 읽는 중'
      statePeer.textContent = '합의문 읽는 중'
      await wait(3400)
      pointer.classList.remove('go')
      pickA.classList.remove('picked')
    }
  }
  hero()

  /* ───────────── why: the copy-paste loop ───────────── */
  async function why() {
    const loop = $('.loop')
    if (!loop) return
    const hops = $$('.hop', loop)
    const counter = $('[data-tick]')
    const runner = $('.runner', loop)
    const dot = document.createElement('i')
    dot.className = 'runner-dot'
    loop.append(dot)
    const center = el => ({ x: el.offsetLeft + el.offsetWidth / 2, y: el.offsetTop + el.offsetHeight / 2 })
    const fitRunner = () => {
      const a = center(hops[0]), c = center(hops[2])
      Object.assign(runner.style, { left: `${a.x}px`, top: `${a.y}px`, width: `${c.x - a.x}px`, height: `${c.y - a.y}px`, transform: 'none' })
    }
    fitRunner()
    addEventListener('resize', fitRunner)
    if (reduce) { counter.textContent = '37'; hops[0].classList.add('lit'); return }
    const gate = makeGate(loop)
    let n = 0, k = 0
    for (;;) {
      await gate.wait()
      const a = center(hops[k % 4]), b = center(hops[(k + 1) % 4])
      await tween(850, t => {
        const e = easeInOut(t)
        dot.style.transform = `translate(${(a.x + (b.x - a.x) * e).toFixed(1)}px, ${(a.y + (b.y - a.y) * e).toFixed(1)}px)`
      })
      k++
      hops.forEach(h => h.classList.remove('lit'))
      hops[k % 4].classList.add('lit')
      counter.textContent = String(++n)
      counter.animate?.([{ transform: 'scale(1.35)' }, { transform: 'scale(1)' }], { duration: 300, easing: 'ease-out' })
      await sleep(320)
    }
  }
  why()

  /* ───────────── how: scrollytelling ───────────── */
  function story() {
    const scene = $('.scene')
    const steps = $$('.step')
    if (!scene || !steps.length) return
    const code = $('.codebox .typed')
    const caption = $('.caption')
    let current = 0
    let typing = 0
    const typeCode = async () => {
      const full = code.dataset.text
      const body = full.slice(0, -8), sum = full.slice(-8)
      const id = ++typing
      if (reduce) { code.textContent = body; const s = document.createElement('span'); s.className = 'sum'; s.textContent = sum; code.append(s); return }
      code.textContent = ''
      for (let i = 0; i <= body.length; i += 3) {
        if (id !== typing) return
        code.textContent = body.slice(0, i)
        await sleep(14)
      }
      const s = document.createElement('span')
      s.className = 'sum'
      code.append(s)
      for (let i = 1; i <= sum.length; i++) {
        if (id !== typing) return
        s.textContent = sum.slice(0, i)
        await sleep(45)
      }
    }
    const setStep = n => {
      if (n === current) return
      current = n
      scene.dataset.step = String(n)
      steps.forEach(s => s.classList.toggle('active', Number(s.dataset.step) === n))
      // 좁은 화면에서는 그림 아래 자막으로 지금 단계를 보여 준다.
      const step = steps.find(s => Number(s.dataset.step) === n)
      if (caption && step) {
        $('.num', caption).textContent = $('.num', step).textContent
        $('h3', caption).textContent = $('h3', step).textContent
        $('p', caption).innerHTML = $('p', step).innerHTML
        if (!reduce) caption.animate?.([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.2,.8,.2,1)' })
      }
      if (n === 1) typeCode()
      else typing++
    }
    const io = new IntersectionObserver(
      es => es.forEach(e => { if (e.isIntersecting) setStep(Number(e.target.dataset.step)) }),
      { rootMargin: '-45% 0px -45% 0px' },
    )
    steps.forEach(s => io.observe(s))
    setStep(1)
  }
  story()

  /* ───────────── tiles ───────────── */
  async function scramble() {
    const el = $('.scramble')
    if (!el || reduce) return
    const plain = el.dataset.plain
    const glyphs = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz0123456789+/=#%&@'
    const noise = () => glyphs[(Math.random() * glyphs.length) | 0]
    const gate = makeGate(el)
    const chars = [...plain]
    for (;;) {
      await gate.wait()
      el.textContent = plain
      await sleep(1300)
      for (let k = 0; k <= chars.length; k++) {
        await gate.wait()
        el.textContent = chars.map((c, i) => (i < k ? noise() : c)).join('')
        await sleep(45)
      }
      const t0 = performance.now()
      while (performance.now() - t0 < 1500) {
        el.textContent = chars.map(() => noise()).join('')
        await sleep(70)
      }
      for (let k = 0; k <= chars.length; k++) {
        await gate.wait()
        el.textContent = chars.map((c, i) => (i < k ? c : noise())).join('')
        await sleep(55)
      }
      await sleep(900)
    }
  }
  scramble()

  async function feed() {
    const list = $('.feed')
    if (!list) return
    const items = [
      ['k-q', '질문', 'api-server → web-app · token 필드 반영?'],
      ['k-a', '답', 'web-app → api-server · 반영됨 auth.ts:42'],
      ['k-q', '질문', 'api-server → web-app · 배포 순서?'],
      ['k-n', '알림', 'web-app · 사람에게 확인 중'],
      ['k-a', '답', 'web-app · 사람이 정함: API 먼저'],
      ['k-g', '합의문', 'api-server · 로그인 API 변경'],
    ]
    const push = ([cls, kind, text]) => {
      const li = document.createElement('li')
      li.className = cls
      const b = document.createElement('b')
      b.textContent = kind
      li.append(b, text)
      list.append(li)
      while (list.children.length > 4) list.firstElementChild.remove()
    }
    if (reduce) { items.slice(-4).forEach(push); return }
    const gate = makeGate(list)
    for (let k = 0; ; k++) {
      await gate.wait()
      push(items[k % items.length])
      await sleep(1500)
    }
  }
  feed()

  /* ───────────── install tabs + copy ───────────── */
  function tabs() {
    const list = $('.tabs')
    if (!list) return
    const btns = $$('[role="tab"]', list)
    const ink = $('.tab-ink', list)
    const moveInk = btn => {
      ink.style.width = `${btn.offsetWidth}px`
      ink.style.transform = `translateX(${btn.offsetLeft - 5}px)`
    }
    const select = (btn, focus) => {
      btns.forEach(b => {
        const on = b === btn
        b.setAttribute('aria-selected', String(on))
        b.tabIndex = on ? 0 : -1
        $(`#${b.getAttribute('aria-controls')}`).hidden = !on
      })
      moveInk(btn)
      if (focus) btn.focus()
    }
    btns.forEach((b, i) => {
      b.addEventListener('click', () => select(b))
      b.addEventListener('keydown', e => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
        e.preventDefault()
        select(btns[(i + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length], true)
      })
    })
    // Windows 에서 열었으면 Windows 탭부터 보여 준다.
    const startWin = /Windows/i.test(navigator.userAgent)
    select(startWin ? btns[1] : btns[0])
    addEventListener('resize', () => moveInk(btns.find(b => b.getAttribute('aria-selected') === 'true')))
    document.fonts?.ready.then(() => moveInk(btns.find(b => b.getAttribute('aria-selected') === 'true')))
  }
  tabs()

  $$('.copy').forEach(btn => {
    btn.addEventListener('click', async () => {
      const text = btn.previousElementSibling.textContent
      let ok = false
      try { await navigator.clipboard.writeText(text); ok = true } catch {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.append(ta)
        ta.select()
        try { ok = document.execCommand('copy') } catch {}
        ta.remove()
      }
      btn.textContent = ok ? '복사됨' : '실패'
      btn.classList.toggle('done', ok)
      setTimeout(() => { btn.textContent = '복사'; btn.classList.remove('done') }, 1600)
    })
  })

  /* ───────────── faq ───────────── */
  $$('.faq-list details').forEach(d => {
    const summary = $('summary', d)
    const body = $('div', d)
    summary.addEventListener('click', e => {
      if (reduce || !body.animate) return
      e.preventDefault()
      const opts = { duration: 380, easing: 'cubic-bezier(.2,.8,.2,1)' }
      if (d.open) {
        const h = body.offsetHeight
        body.animate([{ height: `${h}px`, opacity: 1 }, { height: '0px', opacity: 0 }], { ...opts, duration: 260 }).onfinish = () => { d.open = false }
      } else {
        d.open = true
        const h = body.offsetHeight
        body.animate([{ height: '0px', opacity: 0 }, { height: `${h}px`, opacity: 1 }], opts)
      }
    })
  })
})()
