import { createHash } from 'node:crypto'

// 우편함 번호는 주인만 아는 비밀의 해시다. 중계 서버와 브릿지가 같이 쓴다.
// 브릿지가 relay.ts 를 불러오면 플러그인으로 묶을 때 중계 서버 코드까지 딸려 들어가므로 따로 둔다.
export const boxOf = (secret: string) => createHash('sha256').update(secret).digest('base64url').slice(0, 22)
