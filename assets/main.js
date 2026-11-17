// AI Co-worker Without Me · 소개 페이지의 움직임과 단추.
// 밖으로 보내는 것은 없다. 모션을 켰는지 껐는지만 이 브라우저에 기억한다(localStorage의 cw-motion).
// 맨 위 메뉴를 접고 펴는 일은 index.html 안에 있다(그리기 전에 한 번 재야 해서).
(() => {
  'use strict'

  const root = document.documentElement
  const $ = (selector, from = document) => from.querySelector(selector)
  const $$ = (selector, from = document) => [...from.querySelectorAll(selector)]
  const EASE = 'cubic-bezier(.22, 1, .36, 1)'
  // 이 스크립트가 왔다는 표시. 오지 않으면 index.html이 숨겨 둔 것을 스스로 푼다.
  window.cwReady = true

  // ── 모션 켬/끔 ──
  // <html class="on">이면 켠 것이다. 단추(data-motion)는 여러 곳에 있고 모두 같은 값을 바꾼다.
  const watchers = new Set()
  const motion = {
    get on() {
      return root.classList.contains('on')
    },
    set(on, keep = true) {
      root.classList.toggle('on', on)
      if (keep) {
        try {
          localStorage.setItem('cw-motion', on ? 'on' : 'off')
        } catch {}
      }
      label()
      for (const tell of watchers) tell(on)
    },
    watch(tell) {
      watchers.add(tell)
    },
  }
  const label = () => {
    for (const button of $$('[data-motion]')) button.textContent = motion.on ? '모션 끄기' : '모션 켜기'
  }
  label()
  document.addEventListener('click', event => {
    if (event.target.closest('[data-motion]')) motion.set(!motion.on)
  })
  // 고른 적이 없으면 운영체제의 「동작 줄이기」가 바뀔 때 따라간다
  const calm = matchMedia('(prefers-reduced-motion: reduce)')
  calm.addEventListener('change', () => {
    let saved = null
    try {
      saved = localStorage.getItem('cw-motion')
    } catch {}
    if (!saved) motion.set(!calm.matches, false)
  })

  // 화면에 보이는지 알려 준다. 움직이는 것은 보이는 동안에만 돈다.
  const visible = (el, tell, margin = '0px') => {
    if (!('IntersectionObserver' in window)) {
      tell(true)
      return
    }
    new IntersectionObserver(entries => tell(entries[entries.length - 1].isIntersecting), { rootMargin: margin }).observe(el)
  }

  // 선을 따라 점이 건너간다. dir 1은 왼쪽에서 오른쪽, -1은 그 반대. 다 건너가면 풀리는 약속을 돌려준다.
  const send = (wire, dir = 1) => {
    const spark = $('.spark', wire)
    if (!spark || !motion.on) return Promise.resolve()
    const width = wire.clientWidth
    const from = dir > 0 ? 0 : width
    const to = dir > 0 ? width : 0
    const run = spark.animate(
      [
        { translate: from + 'px 0', opacity: 0, scale: 0.6 },
        { opacity: 1, scale: 1, offset: 0.15 },
        { opacity: 1, scale: 1, offset: 0.8 },
        { translate: to + 'px 0', opacity: 0, scale: 0.6 },
      ],
      { duration: 760, easing: 'cubic-bezier(.45, 0, .2, 1)' },
    )
    return run.finished.catch(() => {})
  }

  // ── 첫 화면의 예시 대화 ──
  // 질문 → 답 → 사람의 결정 → 합의문의 차례로 흐르고, 끝나면 처음부터 다시 흐른다.
  // 모션을 끄면 다 끝난 모습으로 멈춘다(스크립트가 없을 때의 모습과 같다).
  const ready = () => root.classList.remove('boot')
  const scene = $('#scene')
  if (scene) {
    const msgs = $$('.msg', scene)
    const note = $('.msg.note', scene)
    const wire = $('.wire', scene)
    const state = $('.state', scene)
    const stateText = $('.state-text', scene)
    let timer = 0
    let run = 0
    let at = 0
    let playing = false
    let seen = false

    const say = (text, kind) => {
      stateText.textContent = text
      state.dataset.kind = kind
      if (motion.on) state.animate([{ opacity: 0, translate: '0 5px' }, { opacity: 1, translate: '0 0' }], { duration: 320, easing: EASE })
    }
    const show = index => msgs[index].classList.add('show')
    // 차례마다: [다음 차례까지 기다릴 시간(ms), 할 일]
    const beats = [
      [900, () => say('연결됨', 'idle')],
      [
        2700,
        () => {
          show(0)
          send(wire, 1)
          wire.dataset.flow = 'fwd'
          say('답 기다리는 중', 'wait')
        },
      ],
      [
        2700,
        mine => {
          delete wire.dataset.flow
          send(wire, -1).then(() => {
            if (mine !== run) return
            show(1)
            say('답 받음', 'ok')
          })
        },
      ],
      [
        2500,
        () => {
          show(2)
          say('사람에게 확인 중', 'ask')
        },
      ],
      [
        2500,
        () => {
          note.classList.add('picked')
          send(wire, 1)
          say('사람이 정함', 'ok')
        },
      ],
      [
        6500,
        () => {
          show(3)
          say('합의문 저장됨', 'agree')
        },
      ],
      [
        700,
        () => {
          for (const msg of msgs) msg.classList.remove('show')
        },
      ],
    ]
    const step = () => {
      const [wait, act] = beats[at]
      act(run)
      timer = setTimeout(() => {
        at = (at + 1) % beats.length
        if (at === 0) note.classList.remove('picked')
        step()
      }, wait)
    }
    const start = () => {
      if (playing) return
      playing = true
      run++
      at = 0
      for (const msg of msgs) msg.classList.remove('show')
      note.classList.remove('picked')
      scene.classList.add('play')
      step()
    }
    const stop = () => {
      if (!playing) return
      playing = false
      run++
      clearTimeout(timer)
      scene.classList.remove('play')
      delete wire.dataset.flow
      note.classList.add('picked')
      for (const msg of msgs) msg.classList.remove('show')
      stateText.textContent = '합의문 저장됨'
      state.dataset.kind = 'agree'
    }
    const sync = () => (motion.on && seen && !document.hidden ? start() : stop())
    visible(scene, on => {
      seen = on
      sync()
      ready()
    })
    motion.watch(sync)
    document.addEventListener('visibilitychange', sync)
  } else {
    ready()
  }

  // ── "coworker를 쓰면" 카드: 두 AI 사이를 점이 오간다(묻고, 조금 뒤 답이 온다) ──
  const direct = $('#direct')
  if (direct) {
    const wire = $('.wire', direct)
    let timer = 0
    let seen = false
    let dir = 1
    const beat = () => {
      send(wire, dir)
      dir = -dir
      timer = setTimeout(beat, dir > 0 ? 2800 : 1300)
    }
    const sync = () => {
      clearTimeout(timer)
      dir = 1
      if (motion.on && seen && !document.hidden) timer = setTimeout(beat, 600)
    }
    visible(direct, on => {
      seen = on
      sync()
    })
    motion.watch(sync)
    document.addEventListener('visibilitychange', sync)
  }

  // ── 아래 구역은 화면에 들어올 때 한 번 나타난다 ──
  // 나란히 있는 것들은 순서대로 조금씩 늦게 나타난다(--i).
  if ('IntersectionObserver' in window) {
    const reveals = $$('.reveal')
    for (const el of reveals) {
      if (el.style.getPropertyValue('--i')) continue
      const mates = [...el.parentElement.children].filter(mate => mate.classList.contains('reveal'))
      const index = mates.indexOf(el)
      if (index > 0) el.style.setProperty('--i', String(Math.min(index, 5)))
    }
    const watch = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          entry.target.classList.add('in')
          watch.unobserve(entry.target)
        }
      },
      { rootMargin: '0px 0px -6% 0px', threshold: 0.06 },
    )
    for (const el of reveals) watch.observe(el)
  }

  // ── 메뉴에 지금 보고 있는 구역을 표시한다 ──
  // 브라우저가 스스로 표시하면(scroll-target-group) 읽어 주는 프로그램에 알릴 값만 맞춘다. 아니면 직접 본다.
  const links = $$('#site-menu a[href^="#"]')
  if (CSS.supports('scroll-target-group: auto')) {
    let waiting = 0
    const sync = () => {
      const current = $('.header-inner a:target-current')
      for (const link of links) link.setAttribute('aria-current', link === current ? 'true' : 'false')
    }
    // 화면이 멈춘 뒤에 맞춘다. scrollend가 오지 않는 경우(바로 건너뛴 이동, 크기 바뀜)에도 맞도록 조금 뒤에 한 번 더 본다.
    const later = () => {
      clearTimeout(waiting)
      waiting = setTimeout(sync, 150)
    }
    sync()
    document.addEventListener('scrollend', sync)
    addEventListener('scroll', later, { passive: true })
    addEventListener('resize', later)
  } else if ('IntersectionObserver' in window) {
    const spy = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          for (const link of links) {
            const on = link.getAttribute('href') === '#' + entry.target.id
            link.classList.toggle('target-current', on)
            link.setAttribute('aria-current', on ? 'true' : 'false')
          }
        }
      },
      { rootMargin: '-50% 0px -50% 0px', threshold: 0 },
    )
    // 메뉴에 없는 앞쪽 구역(첫 화면, 왜)도 지켜봐서, 거기에 있을 때는 아무 표시도 하지 않는다
    for (const id of ['hero', 'why', ...links.map(link => link.getAttribute('href').slice(1))]) {
      const target = document.getElementById(id)
      if (target) spy.observe(target)
    }
  }

  // ── 대화 화면 미리보기 ──
  // 데모(demo/)를 정해진 크기로 그려 칸의 너비에 맞게 줄여 보여 준다. 누를 수 없는 그림처럼 다룬다.
  // 가까이 왔을 때 불러오고, 모션을 끄면 뺀다.
  const shot = $('#shot')
  const view = $('#shotView')
  if (shot && view) {
    const WIDTH = 1180
    let frame = null
    let near = false
    const fit = () => view.style.setProperty('--k', String(view.clientWidth / WIDTH))
    if ('ResizeObserver' in window) new ResizeObserver(fit).observe(view)
    fit()
    const sync = () => {
      if (motion.on && near && !frame) {
        const made = document.createElement('iframe')
        made.title = '대화 화면 데모 미리보기'
        made.setAttribute('aria-hidden', 'true')
        made.setAttribute('scrolling', 'no')
        made.tabIndex = -1
        made.inert = true
        made.addEventListener('load', () => {
          if (frame !== made) return
          made.classList.add('ready')
          shot.classList.add('has-frame')
        })
        made.src = 'demo/'
        frame = made
        view.prepend(made)
      } else if (!motion.on && frame) {
        frame.remove()
        frame = null
        shot.classList.remove('has-frame')
      }
    }
    visible(
      shot,
      on => {
        if (on) near = true
        sync()
      },
      '700px 0px',
    )
    motion.watch(sync)
  }

  // ── 명령 복사 ──
  // 단추의 commandfor가 가리키는 글을 복사하고, 결과를 단추 옆 말풍선에 적는다(읽어 주는 프로그램도 읽는다).
  const timers = new WeakMap()
  let lastMessage = ''
  const report = (button, ok) => {
    const tip = button.nextElementSibling
    clearTimeout(timers.get(button))
    button.removeAttribute('data-copied')
    button.removeAttribute('data-failed')
    let message = ok ? '복사됨' : '복사하지 못했습니다'
    // 같은 말이 이어지면 읽어 주지 않는 프로그램이 있어, 보이지 않는 빈칸을 붙여 다른 말로 만든다
    if (message === lastMessage) message += String.fromCharCode(160)
    lastMessage = message
    tip.textContent = ''
    void button.offsetWidth
    button.setAttribute(ok ? 'data-copied' : 'data-failed', '')
    requestAnimationFrame(() => {
      tip.textContent = message
    })
    timers.set(
      button,
      setTimeout(() => {
        button.removeAttribute('data-copied')
        button.removeAttribute('data-failed')
        tip.textContent = ''
      }, 2000),
    )
  }
  const copy = async (button, target) => {
    const text = target.innerText.trim()
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      report(button, true)
    } catch {
      report(button, false)
    }
  }
  if ('CommandEvent' in window) {
    // command 이벤트는 위로 올라오지 않아서 내려가는 길에 잡는다
    document.addEventListener(
      'command',
      event => {
        if (event.command === '--copy') copy(event.source, event.target)
      },
      true,
    )
  } else {
    document.addEventListener('click', event => {
      const button = event.target.closest('button[command="--copy"]')
      if (!button) return
      const target = document.getElementById(button.getAttribute('commandfor'))
      if (target) copy(button, target)
    })
  }

  // ── 설치 순서: Windows에서 열면 Windows 쪽을 먼저 보여 준다 ──
  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || ''
  if (/win/i.test(platform)) {
    const win = $('input[name="os"][value="win"]')
    if (win) win.checked = true
  }
})()
