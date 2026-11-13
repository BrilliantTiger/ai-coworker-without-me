import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

// 연결 기록. 까닭 모르게 끊겼을 때 사람이 무슨 일이 있었는지 볼 수 있게, 연결이 바뀐 순간만 한 줄씩 남긴다.
// 메시지 내용은 남기지 않는다. 언제, 누구와, 무엇이 실패했는지, 이 PC가 잠들었는지만 남긴다.
// id 가 있는 줄은 그 상대에 관한 것이고, 없는 줄은 이 PC 전체에 관한 것이다(브릿지를 열고 닫음, 잠자기, 주소 바뀜).
export type LogEntry = { at: string; event: string; id?: string; [field: string]: unknown }

const MAX_BYTES = 1 << 20
export const MAX_LOG_LINES = 300

export class LinkLog {
  constructor(readonly path?: string) {}

  write(event: string, fields: Record<string, unknown> = {}) {
    if (!this.path) return
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      // 1MB 를 넘으면 앞의 것을 .1 로 옮기고 새로 쓴다. 둘을 합쳐 2MB 를 넘지 않는다.
      if (existsSync(this.path) && statSync(this.path).size > MAX_BYTES) renameSync(this.path, `${this.path}.1`)
      appendFileSync(this.path, `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`, { mode: 0o600 })
    } catch {}
  }

  // 마지막 몇 줄. id 를 주면 그 상대에 관한 줄과 이 PC 전체에 관한 줄만 준다.
  read(options: { id?: string; lines?: number } = {}): LogEntry[] {
    if (!this.path) return []
    const lines = Math.min(Math.max(options.lines ?? 100, 1), MAX_LOG_LINES)
    const entries: LogEntry[] = []
    for (const file of [`${this.path}.1`, this.path]) {
      let text = ''
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      for (const line of text.split('\n')) {
        if (!line) continue
        try {
          const e = JSON.parse(line) as LogEntry
          if (!options.id || !e.id || e.id === options.id) entries.push(e)
        } catch {}
      }
    }
    return entries.slice(-lines)
  }
}
