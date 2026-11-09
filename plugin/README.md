# AI Co-worker Without Me · 플러그인

이 폴더가 Claude Code와 Codex에 설치되는 플러그인이다. 동료끼리 각자 쓰는 AI가 사내망이나 VPN에서 직접 묻고 답하게 해 준다.

```
claude plugin install coworker --marketplace BrilliantTiger/ai-coworker-without-me@release
```

Codex는 `codex plugin marketplace add BrilliantTiger/ai-coworker-without-me@release` 뒤에 `codex plugin add coworker@ai-coworker-without-me`로 설치한다. 설치와 쓰는 법은 저장소의 [README](https://github.com/BrilliantTiger/ai-coworker-without-me#readme)와 [INSTALL.md](https://github.com/BrilliantTiger/ai-coworker-without-me/blob/main/INSTALL.md)에 있고, 무엇이 PC 밖으로 나가는지는 [PRIVACY.md](https://github.com/BrilliantTiger/ai-coworker-without-me/blob/main/PRIVACY.md)에 있다.

- `coworker.js`: MCP 서버. 저장소의 `src/`를 `bun run build`로 묶은 파일이다. 쓰는 패키지(@modelcontextprotocol/sdk, zod, tweetnacl)가 모두 들어 있어서 사용자 PC에서 아무것도 깔지 않는다. 고칠 때는 `src/`를 고치고 다시 묶는다.
- `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`: Claude Code와 Codex가 읽는 설정이다. 둘 다 `bun --no-install`로 `coworker.js`를 띄운다. 필요한 것은 [Bun](https://bun.sh) 하나다.
