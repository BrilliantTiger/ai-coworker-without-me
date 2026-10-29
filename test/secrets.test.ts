import { expect, test } from 'bun:test'
import { assertNoSecrets, findSecrets } from '../src/secrets'

// 진짜 열쇠 모양이 저장소에 그대로 남지 않게 시험 값은 이어 붙여 만든다.
const join = (...parts: string[]) => parts.join('')

test('finds common keys and tokens', () => {
  const samples: [string, string][] = [
    ['private key', join('-----BEGIN OPENSSH ', 'PRIVATE KEY-----\nabc')],
    ['AWS access key', join('AKIA', 'Q3EGZ7YBLHPX4K2M')],
    ['GitHub token', join('gh', 'p_', 'a1B2'.repeat(9))],
    ['GitHub token', join('github', '_pat_', '11ABCDEFG0123456789abcdef')],
    ['Slack token', join('xo', 'xb-', '123456789012-abcdef')],
    ['Anthropic API key', join('sk-', 'ant-api03-', 'Zx9'.repeat(10))],
    ['OpenAI API key', join('sk-', 'proj-', 'Qw3'.repeat(10))],
    ['Google API key', join('AI', 'za', 'Sy', 'A1b2C3d4'.repeat(4), 'x')],
    ['JSON web token', join('ey', 'JhbGciOiJIUzI1NiJ9.', 'ey', 'JzdWIiOiIxMjM0In0.', 'c2lnbmF0dXJlMTIz')],
    ['password in a URL', 'postgres://app:S3cr3t!x@db.internal:5432/main'],
    ['bearer token', join('Authorization: Bearer ', 'abc123DEF456ghi789JKL0')],
    ['password or secret', 'DB_PASSWORD=hunter2!'],
    ['password or secret', '"client_secret": "a8f3k2l9m1"'],
    ['password or secret', '비밀번호: qwer1234'],
  ]
  for (const [kind, text] of samples) expect(findSecrets({ text }).map(f => f.kind)).toContain(kind)
})

test('lets ordinary text, placeholders and code that reads secrets through', () => {
  const fine = [
    'The login form has a password field and a "forgot password" link.',
    'password: string',
    'apiKey: process.env.OPENAI_API_KEY',
    'password = ${DB_PASSWORD}',
    'token: <redacted>',
    'secret=***',
    'API_KEY=your_api_key_here',
    'client_secret: getSecret("app")',
    'postgres://app:<password>@db.internal/main',
    'commit 3f9c2a1e8b7d6c5a4b3c2d1e0f9a8b7c6d5e4f3a and uuid 0f8fad5b-d9cb-469f-a165-70867728950e',
    'see https://example.com/docs and run sk-learn later',
    'the secret_key setting lives in ~/.config/app/settings.toml',
  ]
  for (const text of fine) expect(findSecrets({ text })).toEqual([])
})

test('refuses to send, without repeating the secret', () => {
  const token = join('gh', 'p_', 'Zz9Y'.repeat(9))
  let error = ''
  try {
    assertNoSecrets({ question: 'Can you check this?', context: `use ${token}` })
  } catch (e) {
    error = (e as Error).message
  }
  expect(error).toMatch(/^nothing was sent/)
  expect(error).toContain('GitHub token in context')
  expect(error).not.toContain(token)
  expect(() => assertNoSecrets({ question: 'What is 2+2?', context: undefined })).not.toThrow()
})
