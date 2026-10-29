// 합의문: 대화를 마치고 양쪽 AI가 남기는 정리. 사람은 이걸 놓고 논의한다.
// AI 둘이 서로 맞장구치다 틀린 결론에 합의하지 않게, 확인한 사실(근거와 누가 확인했는지)과 추측을 나눠 적는다.

// checkedBy 는 그 사실을 직접 확인한 세션 이름이다.
export type Fact = { fact: string; evidence: string; checkedBy: string }

export type Agreement = {
  by: string
  conclusion: string
  facts: Fact[]
  guesses: string[]
  disagreements: string[]
  forHumans: string[]
}

const isText = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max
const isList = (v: unknown) => Array.isArray(v) && v.length <= 50 && v.every(s => isText(s, 2000))

export function isAgreement(a: unknown): a is Agreement {
  const v = a as Agreement
  return (
    !!v &&
    isText(v.by, 200) &&
    isText(v.conclusion, 5000) &&
    Array.isArray(v.facts) &&
    v.facts.length <= 50 &&
    v.facts.every(f => !!f && isText(f.fact, 2000) && isText(f.evidence, 2000) && isText(f.checkedBy, 200)) &&
    isList(v.guesses) &&
    isList(v.disagreements) &&
    isList(v.forHumans)
  )
}

const bullets = (items: string[]) => (items.length ? items.map(i => `- ${i}`).join('\n') : '- 없음')

export function renderAgreement(a: Agreement): string {
  const facts = a.facts.length ? a.facts.map(f => `- ${f.fact}\n  - 근거: ${f.evidence}\n  - 확인한 쪽: ${f.checkedBy}`).join('\n') : '- 없음'
  return [
    `## 결론\n\n${a.conclusion}`,
    `## 확인한 사실과 근거\n\n${facts}`,
    `## 추측 (아무도 확인하지 않음)\n\n${bullets(a.guesses)}`,
    `## 의견이 갈린 점\n\n${bullets(a.disagreements)}`,
    `## 사람이 정할 것\n\n${bullets(a.forHumans)}`,
  ].join('\n\n')
}
