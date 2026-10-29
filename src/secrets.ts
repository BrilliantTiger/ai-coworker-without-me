// 보내기 전에 비밀값으로 보이는 것을 찾는다. 찾으면 보내지 않는다.
// 상대 AI가 달라고 해서든 AI가 실수로 붙여서든, 열쇠·토큰·비밀번호가 이 PC 밖으로 나가지 않게 한다.
// 흔한 열쇠·토큰 모양과 「password = 값」 같은 대입을 본다.
// 자리표시(<redacted>, ***, your_api_key)와 코드에서 값을 읽는 곳(process.env.API_KEY)은 비밀값으로 보지 않는다.

type Rule = { kind: string; re: RegExp; value?: number }

const KEYWORDS = 'password|passwd|passphrase|secret|api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|비밀번호|패스워드|암호'

const RULES: Rule[] = [
  { kind: 'private key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
  { kind: 'AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { kind: 'GitLab token', re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: 'Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: 'Anthropic API key', re: /\bsk-ant-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/g },
  { kind: 'OpenAI API key', re: /\bsk-(?!ant-)(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/g },
  { kind: 'Stripe key', re: /\b[sr]k_live_[A-Za-z0-9]{20,}/g },
  { kind: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'JSON web token', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: 'password in a URL', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]+)@/gi, value: 1 },
  { kind: 'bearer token', re: /\bBearer\s+([A-Za-z0-9._~+/-]{20,}=*)/g, value: 1 },
  { kind: 'password or secret', re: new RegExp(`(?:${KEYWORDS})["']?\\s*[:=]\\s*["']?([^\\s"'\`,;]{6,})`, 'gi'), value: 1 },
]

// 값 자리에 들어 있어도 비밀값이 아닌 것.
const PLACEHOLDER = [
  /^<.*>$/,
  /^\[.*\]$/,
  /^\{\{.*\}\}$/,
  /^\$\{.*\}$/,
  /^\$[A-Za-z_]\w*$/,
  /^%[A-Za-z_]\w*%$/,
  /^[*x•.]+$/i,
  /^(?:redacted|hidden|masked|changeme|example|placeholder|password|passwd|secret|dummy|test|null|none|undefined|required|optional)$/i,
  /^(?:your|my|the)[_-]/i,
  // 코드에서 값을 읽는 곳: process.env.API_KEY, config.password, getenv(...), PASSWORD_FROM_ENV
  /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+/,
  /^[A-Za-z_$][\w$]*\(/,
  /^[A-Z][A-Z0-9_]*$/,
  // 파일 경로
  /^(?:[A-Za-z]:)?[\\/]/,
  /^~?\.{0,2}[\\/]/,
]

// 모양이 정해진 열쇠·토큰은 그대로 비밀값이다. 대입한 값만 자리표시인지 본다.
// 「password: string」처럼 설명하는 말은 넘기고, 숫자나 기호가 섞인 값만 비밀번호로 본다.
const looksLikeSecret = (rule: Rule, value: string) => {
  if (rule.value === undefined) return true
  if (PLACEHOLDER.some(p => p.test(value))) return false
  if (rule.kind === 'password or secret') return /[^A-Za-z가-힣]/.test(value)
  return true
}

export type Found = { kind: string; field: string; preview: string }

export function findSecrets(fields: Record<string, string | undefined>): Found[] {
  const found: Found[] = []
  for (const [field, text] of Object.entries(fields)) {
    if (!text) continue
    for (const rule of RULES)
      for (const m of text.matchAll(rule.re)) {
        const value = m[rule.value ?? 0] ?? m[0]
        if (!looksLikeSecret(rule, value)) continue
        // 찾은 값은 다시 보여 주지 않는다. 앞 네 글자만 남겨 어디인지 알게 한다.
        found.push({ kind: rule.kind, field, preview: `${value.slice(0, 4)}…` })
      }
  }
  return found
}

export function assertNoSecrets(fields: Record<string, string | undefined>) {
  const found = findSecrets(fields)
  if (!found.length) return
  const what = [...new Set(found.map(f => `${f.kind} in ${f.field} ("${f.preview}")`))].join(', ')
  throw new Error(
    `nothing was sent: this looks like it contains a secret (${what}). Remove it or replace it with a placeholder such as <redacted>. If the other side really needs it, tell your human; humans share secrets their own way, never through coworker.`,
  )
}
