import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isSavedBridge, routeId, type SavedBridge } from './bridge'

// 다시 켠 세션이 되살릴 브릿지 상태는 ~/.coworker/sessions/<이름표>.json 에 있다.
// 사람이 close_bridge 로 닫을 때만 지운다. 시간이 지났다고 지우지 않는다(사람이 정함, 2026-11-10).

export const savedPath = (home: string, id: string) => join(home, 'sessions', `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.json`)

export function readSaved(path: string): SavedBridge | undefined {
  try {
    const saved: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return isSavedBridge(saved) ? saved : undefined
  } catch {
    return undefined
  }
}

// 그 브릿지가 아직 다른 프로세스에서 돌고 있는지 본다. 그 포트에서 그 키의 주소가 답하면 돈다.
// 같은 세션을 두 창에서 이어 켰거나, Claude Code 안에서 띄운 다른 도구가 세션 ID를 물려받은 경우다.
export async function stillRunning(saved: SavedBridge): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${saved.port}/v1/${routeId(saved.publicKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(1000),
    })
    // 봉인되지 않은 요청이라 살아 있는 브릿지는 거절(403)한다. 다른 키의 브릿지나 다른 프로그램이면 404 등이 온다.
    return res.status === 403
  } catch {
    return false
  }
}

// stdio 서버가 뜰 때: 이 세션 ID로 저장해 둔 브릿지가 있고, 아무도 쓰고 있지 않으면 되살릴 것으로 돌려준다.
// Claude Code 가 서버를 다시 띄울 때는 앞 프로세스가 막 끝나는 중일 수 있어서 잠깐 기다린다.
// 그래도 다른 프로세스가 같은 브릿지를 돌리고 있으면 이 세션은 새 이름표를 쓴다(sessionId 없음).
export async function findSession(home: string, id: string | undefined): Promise<{ sessionId?: string; restore?: SavedBridge }> {
  if (!id) return {}
  const path = savedPath(home, id)
  const saved = readSaved(path)
  if (!saved) return { sessionId: id }
  for (let i = 0; i < 10; i++) {
    // 앞 프로세스가 끝나면서 마지막 상태를 남겼을 수 있으니 다시 읽는다.
    if (!(await stillRunning(saved))) return { sessionId: id, restore: readSaved(path) ?? saved }
    await Bun.sleep(200)
  }
  return {}
}

// 이 PC에 저장된 브릿지. 새 세션이 앞 세션의 브릿지를 이어받을 때 고른다. 최근에 저장한 것부터.
export function listSaved(home: string): { id: string; saved: SavedBridge }[] {
  let names: string[]
  try {
    names = readdirSync(join(home, 'sessions'))
  } catch {
    return []
  }
  const found: { id: string; saved: SavedBridge }[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const saved = readSaved(join(home, 'sessions', name))
    if (saved) found.push({ id: name.slice(0, -'.json'.length), saved })
  }
  return found.sort((a, b) => b.saved.savedAt.localeCompare(a.saved.savedAt))
}

// 브릿지가 멈춰 그 포트가 답하지 않을 때까지 기다린다. 대화 보기 화면의 포트도 빌 때까지 기다려, 이어받는 쪽이 같은 링크로 연다.
export async function waitUntilStopped(saved: SavedBridge) {
  for (let i = 0; i < 50 && (await stillRunning(saved)); i++) await Bun.sleep(100)
  if (!saved.viewer) return
  for (let i = 0; i < 30; i++) {
    try {
      await fetch(`http://127.0.0.1:${saved.viewer.port}/`, { signal: AbortSignal.timeout(300) })
    } catch {
      return
    }
    await Bun.sleep(100)
  }
}

// 저장하다 멈춘 프로세스가 남긴 임시 파일만 지운다. 상태 파일은 건드리지 않는다.
export function pruneSaved(home: string) {
  const dir = join(home, 'sessions')
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const path = join(dir, name)
    try {
      if (name.endsWith('.tmp') && Date.now() - statSync(path).mtimeMs > 60_000) rmSync(path, { force: true })
    } catch {}
  }
}
