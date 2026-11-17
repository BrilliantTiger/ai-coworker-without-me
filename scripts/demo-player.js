// 소개 사이트의 대화 화면 데모. 서버 대신 미리 만들어 둔 꾸민 대화를 시간에 맞춰 화면에 흘려보낸다.
// 화면 스크립트보다 먼저 돌아서, 화면이 세션에 붙으려고 쓰는 것(EventSource, fetch)을 꾸민 것으로 바꿔 둔다.
// 아무것도 밖으로 보내지 않는다. 이름은 익명(A, B, C)이고 실제 사람이나 세션이 아니다.
;(() => {
  const demo = window.COWORKER_DEMO
  const started = Date.now()
  const pins = new Set()
  const sources = new Set()
  // 지금 몇 바퀴째의 몇 번째 장면인지.
  const scene = () => {
    const elapsed = Date.now() - started
    const at = elapsed % demo.length
    let index = 0
    while (index + 1 < demo.frames.length && demo.frames[index + 1].at <= at) index++
    return { loop: Math.floor(elapsed / demo.length), index }
  }
  // 장면의 내용. 미리 만들 때 넣은 시각을 지금 시각에 맞게 옮기고, 화면에서 고정한 대화에 표시를 붙인다.
  const dataNow = () => {
    const { loop, index } = scene()
    const shift = started + loop * demo.length - demo.base
    const moved = JSON.stringify(demo.frames[index].state).replace(/"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)"/g, (all, iso) => '"' + new Date(Date.parse(iso) + shift).toISOString() + '"')
    const state = JSON.parse(moved)
    for (const c of state.conversations) if (pins.has(c.id)) c.pinned = true
    return JSON.stringify(state)
  }
  const emit = () => {
    const data = dataNow()
    for (const source of sources) if (source.onmessage) source.onmessage({ data })
  }
  let last = ''
  setInterval(() => {
    const { loop, index } = scene()
    const key = loop + ':' + index
    if (key === last) return
    last = key
    emit()
  }, 200)

  // 화면은 세션이 밀어 주는 내용을 EventSource 로 받는다. 여기서는 위의 장면을 준다.
  window.EventSource = class {
    static get CLOSED() {
      return 2
    }
    constructor() {
      this.readyState = 1
      this.onmessage = null
      this.onerror = null
      sources.add(this)
      setTimeout(() => {
        if (sources.has(this) && this.onmessage) this.onmessage({ data: dataNow() })
      }, 0)
    }
    close() {
      this.readyState = 2
      sources.delete(this)
    }
  }

  // 화면이 세션에 보내는 두 요청(대화 고정, 접근키 만들기)에는 여기서 답한다.
  const realFetch = window.fetch.bind(window)
  const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  window.fetch = async (url, options) => {
    const path = String(url)
    if (options && options.method === 'POST' && path.endsWith('/pin')) {
      const body = JSON.parse(options.body || '{}')
      for (const id of body.threads || []) body.pinned ? pins.add(id) : pins.delete(id)
      emit()
      return json({ changed: (body.threads || []).length })
    }
    if (options && options.method === 'POST' && path.endsWith('/code')) {
      // 진짜 코드가 아니다. 모양만 같은 글자다.
      const bytes = crypto.getRandomValues(new Uint8Array(96))
      const code = 'cw1.' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      return json({ code, expires: new Date(Date.now() + 60 * 60000).toISOString() })
    }
    return realFetch(url, options)
  }

  // 데모라는 것을 알리고, 소개 페이지로 돌아가는 길을 둔다.
  const note = document.createElement('a')
  note.href = '../'
  note.textContent = '데모 · 꾸민 대화입니다 · 소개로 돌아가기'
  note.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:40;padding:8px 12px;border-radius:99px;font:600 12.5px/1 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic","Segoe UI",sans-serif;color:#fff;background:rgba(40,44,70,.92);text-decoration:none;box-shadow:0 4px 14px rgba(0,0,0,.3)'
  document.body.append(note)
})()
