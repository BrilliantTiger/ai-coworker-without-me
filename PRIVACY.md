# Privacy

[한국어](#개인정보)

AI Co-worker Without Me has no server run by its authors and collects nothing. It has no analytics or telemetry.

## What leaves your computer

Only when you open a bridge or connect with a code, and only to the sessions you connected (and, with a group code, the rest of that group):

- What your AI sends: questions, the background it attaches, answers, notes that it is asking you, agreements, and your decisions from a question window (the option you picked and anything you wrote there).
- Your session's name (project folder, Claude Code or Codex, computer name) and the addresses and port in your connection code.

Messages go straight to the other computer over your office network or VPN. If you set a relay server, they can also pass through that relay, which whoever runs it sets up. Everything is encrypted end to end (NaCl box), so the relay cannot read or change it. The relay sees only a mailbox number, when something passed and how large it was. It holds a request in memory for up to 40 seconds until the other session picks it up and writes nothing to disk.

Update check: when coworker runs as an installed plugin, it reads the plugin manifest from GitHub (raw.githubusercontent.com, this project's release branch) shortly after it starts and every six hours, to see whether a newer release exists. GitHub sees your IP address, as with any download. Nothing about you or your conversations is sent. If a newer release exists, coworker runs the plugin update command of your app (Claude Code or Codex). Turn this off with the plugin setting Auto update = off, or `COWORKER_AUTO_UPDATE=off`.

Before anything is sent, values that look like secrets (keys, tokens, passwords) are blocked and nothing goes out.

What you send also reaches the other person's AI session, under the terms of their Claude or Codex account.

## What stays on your computer

- `~/.coworker/bridges/<port>.json`: the open bridge and its last connection code, readable only by you. Deleted when the bridge closes.
- `~/.coworker/sessions/<session>.json`: what a session needs to come back after it restarts: its keys, the sessions it is connected to, its conversations, messages not yet delivered or read, unused connection codes, questions you have not answered yet in a question window, and the port and token of its conversation view link, so the link stays the same. Readable only by you. Deleted when you close the bridge.
- `~/.coworker/agreements/`: agreements with the conversation they came from. Kept until you delete them.
- `~/.coworker/hint-shown`: marks that the hint on starting Claude Code as a channel was passed on.
- If you use the coworker app (the Claude plugin directory edition): the app file `~/.coworker/coworker.js`, its log `~/.coworker/app.log`, and what starts it at login (`~/Library/LaunchAgents/com.brillianttiger.coworker.plist` on Mac, a `coworker.lnk` shortcut in the Startup folder on Windows). The app listens only on `127.0.0.1:7690` and refuses requests from web pages.
- The conversation viewer serves the session's conversations at `127.0.0.1` only, behind a token in its link, while the session is open.

## Contact

Open an issue at https://github.com/BrilliantTiger/ai-coworker-without-me/issues.

---

# 개인정보

AI Co-worker Without Me는 만든 사람이 운영하는 서버가 없고, 아무것도 모으지 않는다. 사용 통계나 원격 수집도 없다.

## 이 PC 밖으로 나가는 것

브릿지를 열거나 코드로 연결했을 때만, 연결한 세션(그룹 코드면 그 그룹)에만 간다.

- AI가 보내는 것: 질문, 질문에 붙인 배경, 답, 사람에게 확인 중이라는 알림, 합의문, 질문 창에서 내가 정한 것(고른 보기와 거기에 쓴 말).
- 세션 이름(프로젝트 폴더, Claude Code나 Codex, 컴퓨터 이름)과 연결 코드에 든 주소와 포트.

메시지는 사내망이나 VPN으로 상대 PC에 바로 간다. 중계 서버를 설정했으면 그 서버를 거칠 수도 있다. 중계 서버는 띄운 사람이 마련한다. 모든 내용은 양 끝에서 암호화(NaCl box)하므로 중계 서버는 읽거나 고치지 못한다. 중계 서버가 아는 것은 우편함 번호, 언제 얼마만큼 오갔는지뿐이다. 요청은 상대 세션이 가져갈 때까지 메모리에 최대 40초 두고, 디스크에는 아무것도 쓰지 않는다.

보내기 전에 비밀값으로 보이는 것(열쇠, 토큰, 비밀번호)을 찾으면 막고 아무것도 보내지 않는다.

보낸 내용은 상대의 AI 세션에도 들어간다. 그쪽은 상대가 쓰는 Claude나 Codex 계정의 약관을 따른다.

업데이트 확인: 플러그인으로 설치해 쓰면, coworker가 켜지고 잠시 뒤와 그 뒤 6시간마다 GitHub(raw.githubusercontent.com, 이 저장소의 release 브랜치)에서 플러그인 매니페스트를 읽어 새 판이 있는지 본다. 여느 다운로드처럼 GitHub는 IP 주소를 안다. 나나 대화에 관한 것은 아무것도 보내지 않는다. 새 판이 있으면 쓰는 앱(Claude Code나 Codex)의 플러그인 업데이트 명령을 돌린다. 끄려면 플러그인 설정의 Auto update를 off로 하거나 `COWORKER_AUTO_UPDATE=off`로 둔다.

## 이 PC에 남는 것

- `~/.coworker/bridges/<포트>.json`: 열린 브릿지와 마지막 연결 코드. 본인만 읽을 수 있고, 브릿지를 닫으면 지워진다.
- `~/.coworker/sessions/<세션>.json`: 세션을 다시 켰을 때 되살릴 것. 이 세션의 키, 연결된 세션, 대화, 아직 못 보냈거나 AI가 못 읽은 메시지, 아직 쓰지 않은 연결 코드, 아직 답하지 않은 질문 창, 그리고 대화 보기 링크가 바뀌지 않게 그 포트와 토큰이다. 본인만 읽을 수 있고, 브릿지를 닫으면 지워진다.
- `~/.coworker/agreements/`: 합의문과 그 대화 기록. 지울 때까지 남는다.
- `~/.coworker/hint-shown`: Claude Code를 채널로 켜는 법 안내를 한 번 전했다는 표시.
- coworker 앱(Claude 플러그인 디렉터리판)을 쓰면: 앱 파일 `~/.coworker/coworker.js`, 기록 `~/.coworker/app.log`, 로그인할 때 앱을 켜는 설정(Mac은 `~/Library/LaunchAgents/com.brillianttiger.coworker.plist`, Windows는 시작프로그램 폴더의 `coworker.lnk`). 앱은 `127.0.0.1:7690`에서만 열리고 웹페이지가 보낸 요청은 거절한다.
- 대화 보기 화면은 세션이 살아 있는 동안 `127.0.0.1`에서만, 링크에 든 토큰을 알아야 열린다.

## 연락

https://github.com/BrilliantTiger/ai-coworker-without-me/issues 에 이슈를 남긴다.
