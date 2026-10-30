# 설치

coworker를 처음 쓰는 사람이 설치하고 동료와 처음 연결하기까지의 순서다. Mac과 Windows를 나눠 적었다. 자기 PC에 맞는 쪽만 따라 하면 된다. 쓰는 법을 더 자세히 보려면 [README](README.md)를 본다.

- [Mac](#mac)
- [Windows](#windows)
- [처음 연결하기 (Mac·Windows 같음)](#처음-연결하기-macwindows-같음)
- [새 판으로 올리기](#새-판으로-올리기)

## 필요한 것

- Claude Code나 Codex. 개인 계정(Claude Pro·Max, ChatGPT)으로 쓴다. 둘 중 하나만 있어도 된다. 회사 Team·Enterprise 계정으로 로그인한 Claude Code는 관리자가 채널을 켜 두지 않으면 채널이 막힌다. 그래도 AI가 기다리기 도구로 받아서 쓸 수는 있다.
- [Bun](https://bun.sh). 아래에서 설치한다.
- 두 PC가 같은 사내망에 있거나 회사 VPN에 들어와 있어야 한다. VPN 없이 다른 네트워크에 있으면 중계 서버가 필요하다. README의 [중계 서버](README.md#vpn-없이-다른-네트워크의-동료와-중계-서버)를 본다.
- 쓰기 전에 각자 개인 계정의 학습 설정을 끈다.
  - Claude: [claude.ai/settings/data-privacy-controls](https://claude.ai/settings/data-privacy-controls)에서 Claude 모델 개선에 데이터를 쓰는 설정을 끈다. Claude Code 사용분도 이 설정을 따른다.
  - Codex: ChatGPT 설정 → 데이터 제어에서 「모든 사용자를 위한 모델 개선(Improve the model for everyone)」을 끈다.

## Mac

터미널에서 한다.

### 1. Bun

```
curl -fsSL https://bun.sh/install | bash
```

터미널을 새로 열고 `bun --version`으로 확인한다. 이미 깔려 있으면 `bun upgrade`로 최신으로 올린다. 1.3.x 같은 예전 Bun도 켜지기는 하지만 최신을 쓴다.

### 2. 플러그인

Claude Code:

```
claude plugin install coworker --marketplace BrilliantTiger/ai-coworker-without-me@release
```

Codex:

```
codex plugin marketplace add BrilliantTiger/ai-coworker-without-me@release
codex plugin add coworker@ai-coworker-without-me
```

쓰는 것만 설치하면 된다. Codex는 처음 켤 때 필요한 패키지를 스스로 깔아서 몇 초 걸린다.

### 3. 허용 창 줄이기 (Claude Code, 해도 되고 안 해도 된다)

Claude Code는 coworker 도구를 쓸 때마다 허용 창을 띄운다. 읽기만 하는 도구는 허용 창 없이 쓰게 하려면 `~/.claude/settings.json`에 아래를 넣는다. 파일이 이미 있으면 `permissions.allow` 목록에 네 줄만 더한다.

```json
{
  "permissions": {
    "allow": [
      "mcp__plugin_coworker_coworker__wait_for_message",
      "mcp__plugin_coworker_coworker__inbox",
      "mcp__plugin_coworker_coworker__list_connections",
      "mcp__plugin_coworker_coworker__read_conversation"
    ]
  }
}
```

질문 보내기, 답하기처럼 상대에게 보내는 도구는 계속 허용 창이 뜬다. 무엇이 나가는지 보고 허용한다.

Codex는 따로 할 것이 없다. 읽기만 하는 도구는 승인 없이 쓰고, 보내는 도구는 쓸 때마다 승인을 묻는다.

### 4. 켜기

Claude Code는 coworker를 쓸 프로젝트 폴더에서 채널 옵션을 붙여 켠다.

```
claude --dangerously-load-development-channels plugin:coworker@ai-coworker-without-me
```

- 경고 화면이 뜨면 「I am using this for local development」를 고른다. 직접 만든 채널이라 켤 때마다 뜬다.
- 시작 화면 아래에 `Channels (experimental) messages from plugin:coworker@… inject directly in this session`이 보이고, 그 바로 아래에 `plugin:coworker@…`로 시작하는 경고 줄이 없으면 된 것이다.
- 경고 줄이 있으면 채널이 켜지지 않은 것이다. 이대로 두면 상대가 보낸 것이 세션에 들어오지 않는다. 옵션 없이 다시 켜면 AI가 기다리기 도구로 받는다.
- 이렇게 켜야 상대가 보낸 것이 세션에 바로 들어오고 AI가 알아서 답한다. 옵션 없이 켜도 쓸 수는 있지만, AI가 기다리기 도구를 붙잡고 기다린다.
- 플러그인을 깐 뒤 옵션 없이 처음 켠 세션에는 이렇게 켜라는 안내가 한 번 뜬다.

**`claude-cw`로 줄이기.** 이 옵션은 `settings.json`에 넣을 수 없고 켤 때마다 붙여야 한다. 별칭을 한 번 만들어 두면 `claude-cw`만 치면 된다.

```
echo "alias claude-cw='claude --dangerously-load-development-channels plugin:coworker@ai-coworker-without-me'" >> ~/.zshrc
```

터미널을 새로 열고 `claude-cw`로 켠다. `claude-cw --resume`처럼 다른 옵션도 그대로 붙는다. bash를 쓰면 `~/.zshrc` 대신 `~/.bashrc`에 넣는다.

Codex는 그냥 켠다.

### 5. 방화벽

Mac 방화벽을 켜 두었으면 브릿지를 처음 열 때 `bun`이 들어오는 연결을 받게 할지 묻는 창이 뜬다. 「허용」을 누른다.

이제 [처음 연결하기](#처음-연결하기-macwindows-같음)로 간다.

## Windows

PowerShell에서 한다.

### 1. Bun

```
powershell -c "irm bun.sh/install.ps1 | iex"
```

PowerShell을 새로 열고 `bun --version`으로 확인한다.

이미 깔려 있으면 최신으로 올린다.

- 위 명령으로 깔았으면: `bun upgrade`
- chocolatey로 깔았으면: 관리자 PowerShell에서 `choco upgrade bun -y`

1.3.x 같은 예전 Bun도 켜지기는 하지만 최신을 쓴다.

### 2. 플러그인

Claude Code:

```
claude plugin install coworker --marketplace BrilliantTiger/ai-coworker-without-me@release
```

Codex:

```
codex plugin marketplace add BrilliantTiger/ai-coworker-without-me@release
codex plugin add coworker@ai-coworker-without-me
```

쓰는 것만 설치하면 된다. Codex는 처음 켤 때 필요한 패키지를 스스로 깔아서 몇 초 걸린다.

### 3. 허용 창 줄이기 (Claude Code, 해도 되고 안 해도 된다)

`%USERPROFILE%\.claude\settings.json`에 아래를 넣는다. 파일이 이미 있으면 `permissions.allow` 목록에 네 줄만 더한다.

```json
{
  "permissions": {
    "allow": [
      "mcp__plugin_coworker_coworker__wait_for_message",
      "mcp__plugin_coworker_coworker__inbox",
      "mcp__plugin_coworker_coworker__list_connections",
      "mcp__plugin_coworker_coworker__read_conversation"
    ]
  }
}
```

질문 보내기, 답하기처럼 상대에게 보내는 도구는 계속 허용 창이 뜬다. 무엇이 나가는지 보고 허용한다.

### 4. 켜기

Claude Code는 coworker를 쓸 프로젝트 폴더에서 채널 옵션을 붙여 켠다.

```
claude --dangerously-load-development-channels plugin:coworker@ai-coworker-without-me
```

- 경고 화면이 뜨면 「I am using this for local development」를 고른다. 직접 만든 채널이라 켤 때마다 뜬다.
- 시작 화면 아래에 `Channels (experimental) messages from plugin:coworker@… inject directly in this session`이 보이고, 그 바로 아래에 `plugin:coworker@…`로 시작하는 경고 줄이 없으면 된 것이다.
- 경고 줄이 있으면 채널이 켜지지 않은 것이다. 이대로 두면 상대가 보낸 것이 세션에 들어오지 않는다. 옵션 없이 다시 켜면 AI가 기다리기 도구로 받는다.
- 플러그인을 깐 뒤 옵션 없이 처음 켠 세션에는 이렇게 켜라는 안내가 한 번 뜬다.

**`claude-cw`로 줄이기.** 이 옵션은 `settings.json`에 넣을 수 없고 켤 때마다 붙여야 한다. PowerShell에서 아래를 한 번 실행하면 `claude`가 있는 폴더에 `claude-cw.cmd`가 생긴다.

```
Set-Content "$(Split-Path (Get-Command claude).Source)\claude-cw.cmd" '@claude --dangerously-load-development-channels plugin:coworker@ai-coworker-without-me %*'
```

이제 PowerShell이나 명령 프롬프트에서 `claude-cw`로 켠다. `claude-cw --resume`처럼 다른 옵션도 그대로 붙는다. PowerShell 프로필에 함수로 넣는 방법은 실행 정책에 막힐 수 있어서 파일로 만든다.

Codex는 그냥 켠다. PowerShell에서 켠 Codex는 세션 이름에 프로젝트 폴더가 빠지고 `Codex @ <컴퓨터 이름>`으로 나온다. 이름을 정하려면 "이름을 ○○로 해서 브릿지 열어줘"처럼 말한다.

### 5. 방화벽

Windows는 Mac보다 신경 쓸 것이 많다.

- **처음 브릿지를 열면 방화벽 허용 창이 뜬다.** 「개인 네트워크」에 체크하고 「허용」을 누른다.
- **이 PC의 네트워크가 「공용」으로 잡혀 있으면** 「개인 네트워크」 허용만으로는 막힌다. 설정 → 네트워크 및 인터넷에서 연결된 네트워크를 「개인 네트워크」로 바꾼다.
- **허용 창에서 「취소」를 눌렀으면** Windows가 bun을 막는 규칙을 만들고 다시 묻지 않는다. 아래로 확인한다. `Inbound | Block`이 있으면 막혀 있는 것이다.

  ```
  Get-NetFirewallApplicationFilter | Where-Object Program -like '*bun*' | ForEach-Object { $r = $_ | Get-NetFirewallRule; '{0} | {1} | {2} | {3}' -f $_.Program, $r.Direction, $r.Action, $r.Profile }
  ```

  관리자 PowerShell에서 아래로 푼다.

  ```
  Get-NetFirewallApplicationFilter | Where-Object Program -like '*bun*' | Get-NetFirewallRule | Set-NetFirewallRule -Action Allow -Profile Private
  ```

- **관리자 권한이 없어 방화벽을 못 바꾸면** 이 PC에서는 브릿지를 열지 않는다. 상대가 연 브릿지에 연결만 하면 된다. 들어오는 연결이 막혀 있어도 이쪽에서 나가는 연결로 대화가 된다.

### 6. WSL 안에서 Claude나 Codex를 돌릴 때만

WSL은 기본 설정에서 바깥과 다른 네트워크에 있어서 다른 PC가 들어올 수 없다. `%USERPROFILE%\.wslconfig`에 아래를 넣고 PowerShell에서 `wsl --shutdown`으로 WSL을 다시 켠다.

```
[wsl2]
networkingMode=mirrored
```

이제 [처음 연결하기](#처음-연결하기-macwindows-같음)로 간다.

## 처음 연결하기 (Mac·Windows 같음)

두 사람 모두 위 설치를 마치고 세션을 새로 켠 뒤에 한다. 설치하기 전에 켜 둔 세션에는 coworker가 보이지 않는다.

1. **한 사람이 브릿지를 연다.** 들어오는 연결을 받을 수 있는 쪽이 연다. Windows에서 방화벽을 못 바꾸면 그쪽은 열지 않는다. 모르면 아무나 먼저 열고, 안 되면 역할을 바꾼다.

   > coworker 브릿지 열어줘

   AI가 `cw1.`로 시작하는 연결 코드, 포트, 이 PC의 주소들, 대화 보기 링크를 보여 준다.

2. **연결 코드를 메신저로 동료에게 보낸다.** `cw1.`부터 끝까지 한 줄 전체를 보낸다. 코드는 한 번만 쓸 수 있고 한 시간이 지나면 못 쓴다.

3. **동료가 자기 세션에서 연결한다.**

   > 이 코드로 coworker 연결해줘: cw1.…

4. **연결됐는지 본다.** 양쪽 AI가 "연결됐다"고 알려 준다. "연결 상태 보여줘"라고 했을 때 상대가 `reachable: true`로 나오면 된 것이다.

5. **물어본다.**

   > 저쪽에 ○○ 물어봐

   상대 AI가 코드나 문서에 답이 있으면 바로 답하고, 결정이 필요하면 상대 사람에게 묻는다. 주고받을 때마다 AI가 각자 세션에 정리해서 알려 준다. 대화 보기 링크를 브라우저로 열면 오간 내용이 그때그때 보인다.

6. **끝낸다.** 대화가 끝나면 질문한 쪽 AI가 합의문을 쓴다. 양쪽 PC의 `~/.coworker/agreements/`에 파일로 남는다. 그만하려면 "브릿지 닫아줘"라고 한다.

### 연결이 안 되면

브릿지를 연 쪽이 AI가 보여 준 IP와 포트를 동료에게 알려 주고, 동료가 자기 PC에서 통신이 되는지 본다.

- Mac: `nc -vz <IP> <포트>`. `succeeded`가 나오면 된다.
- Windows(PowerShell): `Test-NetConnection <IP> -Port <포트>`. `TcpTestSucceeded : True`가 나오면 된다.

IP가 여러 개면 하나씩 해 본다. 모두 안 되면 역할을 바꿔 동료가 브릿지를 열고 다시 해 본다. 양쪽 다 안 되면 사내 방화벽이나 VPN이 PC끼리 통신을 막고 있는 것이다. 사내 IT에 이렇게 요청한다.

> 사내망과 VPN 대역의 PC끼리 TCP 7700~7799 포트로 들어오는 연결을 허용해 주세요. 동료 PC끼리 AI 도구가 직접 통신하는 데 씁니다.

AI가 전하는 오류별로 할 일은 README의 [오류별로 할 일](README.md#오류별로-할-일)에 있다.

## 새 판으로 올리기

두 사람의 판이 다르면 연결 코드를 못 읽거나 기능이 맞지 않는다. [GitHub 릴리스](https://github.com/BrilliantTiger/ai-coworker-without-me/releases)에 새 판이 나오면 둘 다 올리고 세션을 새로 켠다. 켜 둔 세션은 예전 판으로 계속 돈다. Mac과 Windows 명령이 같다.

Claude Code:

```
claude plugin marketplace update ai-coworker-without-me
claude plugin update coworker@ai-coworker-without-me
```

`Plugin "coworker" updated from <예전 판> to <새 판>`이 나오면 된 것이다. `already at the latest version`이면 이미 최신이다.

Codex:

```
codex plugin marketplace upgrade ai-coworker-without-me
codex plugin add coworker@ai-coworker-without-me
```

`add`를 다시 하면 플러그인 폴더를 통째로 새 판으로 바꾼다. 필요한 패키지는 다음에 켤 때 다시 깐다.

### 지금 깔린 판 보기

판은 `0.1.0` 같은 번호로 맞춘다. 최신 판은 [GitHub 릴리스](https://github.com/BrilliantTiger/ai-coworker-without-me/releases)에 있다. 설치 명령의 `@release`는 릴리스한 판만 받는다는 뜻이다.

- Claude Code: `claude plugin list`의 `coworker@ai-coworker-without-me` 아래 `Version:`
- Codex: `codex plugin list`의 `coworker@ai-coworker-without-me` 줄 `VERSION`
