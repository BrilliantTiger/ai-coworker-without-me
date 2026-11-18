# Privacy

[한국어](#개인정보)

AI Co-worker Without Me has no server run by its authors and collects nothing. It has no analytics or telemetry.

## What leaves your computer

Only when you open a bridge or connect with a code, and only to the sessions you connected (and, with a group code, the rest of that group):

- What your AI sends: questions, the background it attaches, answers, notices, notes that it is asking you, attached files, agreements, and your decisions from a question window (the option you picked and anything you wrote there).
- With a group code or a private code: your session's name (project folder, Claude Code or Codex, computer name) and the addresses and port in your connection code.
- With an outside code (`open_bridge` with `outside: true`): only the relay mailbox URL, public key, one-time token and checksum in the code, and by default only the AI tool name (`Claude Code` or `Codex`) as your session's name. None of this computer's internal or VPN addresses, `.local` name, `127.0.0.1`, or port is put in the code or sent later. An outside code is always private (the session that joins is neither connected with nor told about any other session, and no other session is told about it or its address), travels only through your configured relay, and blocks this computer's name, account name, home folder or paths under it, project folder path, and internal or VPN addresses from leaving in messages, files, agreements or logs towards that peer.
- Which AI tool your session is (Claude Code or Codex), and its model and reasoning effort when known. The sessions you connect to see them.

Messages go straight to the other computer over your office network or VPN. If you set a relay server, they can also pass through that relay, which whoever runs it sets up. Everything is encrypted end to end (NaCl box), so the relay cannot read or change it. The relay sees only a mailbox number, when something passed and how large it was. It holds a request in memory for up to 40 seconds until the other session picks it up and writes nothing to disk.

Update check: when coworker runs as an installed plugin, it reads the plugin manifest from GitHub (raw.githubusercontent.com, this project's release branch) shortly after it starts and every six hours, to see whether a newer release exists. GitHub sees your IP address, as with any download. Nothing about you or your conversations is sent. If a newer release exists, coworker runs the plugin update command of your app (Claude Code or Codex). Turn this off with the plugin setting Auto update = off, or `COWORKER_AUTO_UPDATE=off`. The coworker app (the `serve` that the directory plugin connects to) reads the same manifest on the same schedule. If a newer release exists, it downloads that release's `coworker.js` from GitHub (github.com, this project's releases) and replaces its own file. Turn this off with `COWORKER_AUTO_UPDATE=off`.

Before anything is sent, values that look like secrets (keys, tokens, passwords) are blocked and nothing goes out.

What you send also reaches the other person's AI session, under the terms of their Claude or Codex account.

## What stays on your computer

- `~/.coworker/bridges/<port>.json`: the open bridge and its last connection code, readable only by you. Deleted when the bridge closes.
- `~/.coworker/sessions/<session>.json`: what a session needs to come back after it restarts: its keys, the sessions it is connected to, its conversations, messages not yet delivered or read, unused connection codes, questions you have not answered yet in a question window, and the port and token of its conversation view link, so the link stays the same. Readable only by you. Deleted when you close the bridge.
- `~/.coworker/agreements/`: agreements with the conversation they came from. Kept until you delete them.
- `~/.coworker/files/<session>/`: files sent with messages. `received/<conversation>/` holds the files you received, readable only by you, and they are kept until you delete them. `out/` holds a copy of each file that still waits to be delivered, and `partial/` holds pieces of files that are still arriving; both are deleted when the message is delivered or the bridge closes. Files travel sealed in the same way as messages, so a relay cannot read them. A file is saved only when its size and sha256 match what the sender said.
- `~/.coworker/hint-shown`: marks that the hint on starting Claude Code as a channel was passed on.
- If you use the coworker app (the Claude plugin directory edition): the app file `~/.coworker/coworker.js`, its log `~/.coworker/app.log`, and what starts it at login (`~/Library/LaunchAgents/com.brillianttiger.coworker.plist` on Mac, a `coworker.lnk` shortcut in the Startup folder on Windows). The app listens only on `127.0.0.1:7690` and refuses requests from web pages.
- The conversation viewer serves the session's conversations at `127.0.0.1` only, behind a token in its link, while the session is open. The page loads nothing from the network: its styles, scripts and motion are all in the page itself. You can do two things on the page: make a new connection code, and pin a conversation to the top of the list. Both requests go only to the session on this computer. A pin is kept with the session's saved state and is not sent to the other side.
- In Claude Code, the plugin draws a card above the prompt while a bridge is open. To draw it, it reads the viewer's address from `~/.coworker/sessions/<session>.json` and asks the viewer at `127.0.0.1` for a short summary: the names of the connected sessions and what they run, whether each can be reached, how many conversations and messages there are, how many wait for an answer or a human's decision, and the first part of the last few messages. It shows a message that just arrived for a short while. It also tells the session on this computer which model and effort Claude Code runs. None of this leaves this computer, except the model and effort, which go to the sessions you connect to as listed above.

## Contact

Open an issue at https://github.com/BrilliantTiger/ai-coworker-without-me/issues.

---

# 개인정보

AI Co-worker Without Me는 만든 사람이 운영하는 서버가 없고, 아무것도 모으지 않는다. 사용 통계나 원격 수집도 없다.

## 이 PC 밖으로 나가는 것

브릿지를 열거나 코드로 연결했을 때만, 연결한 세션(그룹 코드면 그 그룹)에만 간다.

- AI가 보내는 것: 질문, 질문에 붙인 배경, 답, 알림, 사람에게 확인 중이라는 알림, 붙여 보낸 파일, 합의문, 질문 창에서 내가 정한 것(고른 보기와 거기에 쓴 말).
- 그룹 코드·개인용 코드로 이었을 때: 세션 이름(프로젝트 폴더, Claude Code나 Codex, 컴퓨터 이름)과 연결 코드에 든 주소와 포트.
- 외부용 코드(`open_bridge`의 `outside: true`)로 이었을 때: 코드에는 중계 서버의 우편함 주소, 공개키, 일회용 토큰, 확인용 글자만 들어가고, 세션 이름은 기본으로 AI 도구 이름(`Claude Code`나 `Codex`)만 나간다. 이 PC의 사내·VPN 주소, `.local` 이름, `127.0.0.1`, 포트는 코드에도 그 뒤의 통신에도 들어가지 않는다. 외부용 코드는 언제나 개인용 코드라서 다른 세션과는 이어지지도 서로 알려 주지도 않으며, 설정한 중계 서버로만 오가고, 글·파일·합의문·연결 기록에 이 컴퓨터의 이름, 계정 이름, 홈 폴더와 그 아래 경로, 프로젝트 폴더 경로, 사내·VPN 주소가 들어 있으면 보내기 전에 막는다.
- 이 세션이 어느 AI 도구인지(Claude Code나 Codex), 그리고 알 수 있으면 모델과 effort. 연결한 세션이 본다.

메시지는 사내망이나 VPN으로 상대 PC에 바로 간다. 중계 서버를 설정했으면 그 서버를 거칠 수도 있다. 중계 서버는 띄운 사람이 마련한다. 모든 내용은 양 끝에서 암호화(NaCl box)하므로 중계 서버는 읽거나 고치지 못한다. 중계 서버가 아는 것은 우편함 번호, 언제 얼마만큼 오갔는지뿐이다. 요청은 상대 세션이 가져갈 때까지 메모리에 최대 40초 두고, 디스크에는 아무것도 쓰지 않는다.

보내기 전에 비밀값으로 보이는 것(열쇠, 토큰, 비밀번호)을 찾으면 막고 아무것도 보내지 않는다.

보낸 내용은 상대의 AI 세션에도 들어간다. 그쪽은 상대가 쓰는 Claude나 Codex 계정의 약관을 따른다.

업데이트 확인: 플러그인으로 설치해 쓰면, coworker가 켜지고 잠시 뒤와 그 뒤 6시간마다 GitHub(raw.githubusercontent.com, 이 저장소의 release 브랜치)에서 플러그인 매니페스트를 읽어 새 판이 있는지 본다. 여느 다운로드처럼 GitHub는 IP 주소를 안다. 나나 대화에 관한 것은 아무것도 보내지 않는다. 새 판이 있으면 쓰는 앱(Claude Code나 Codex)의 플러그인 업데이트 명령을 돌린다. 끄려면 플러그인 설정의 Auto update를 off로 하거나 `COWORKER_AUTO_UPDATE=off`로 둔다. coworker 앱(디렉터리판 플러그인이 붙는 `serve`)도 같은 때에 같은 매니페스트를 읽는다. 새 판이 있으면 그 릴리스의 `coworker.js`를 GitHub(github.com, 이 저장소의 릴리스)에서 받아 자기 파일을 바꾼다. 끄려면 `COWORKER_AUTO_UPDATE=off`로 둔다.

## 이 PC에 남는 것

- `~/.coworker/bridges/<포트>.json`: 열린 브릿지와 마지막 연결 코드. 본인만 읽을 수 있고, 브릿지를 닫으면 지워진다.
- `~/.coworker/sessions/<세션>.json`: 세션을 다시 켰을 때 되살릴 것. 이 세션의 키, 연결된 세션, 대화, 아직 못 보냈거나 AI가 못 읽은 메시지, 아직 쓰지 않은 연결 코드, 아직 답하지 않은 질문 창, 그리고 대화 보기 링크가 바뀌지 않게 그 포트와 토큰이다. 본인만 읽을 수 있고, 브릿지를 닫으면 지워진다.
- `~/.coworker/agreements/`: 합의문과 그 대화 기록. 지울 때까지 남는다.
- `~/.coworker/files/<세션>/`: 글에 붙여 주고받은 파일. `received/<대화>/`에는 받은 파일이 본인만 읽게 저장되고, 지울 때까지 남는다. `out/`에는 아직 상대에게 가지 못한 파일의 사본이, `partial/`에는 받고 있는 파일의 조각이 있다. 둘 다 글이 넘어가거나 브릿지를 닫으면 지워진다. 파일은 글과 같은 방식으로 봉인되어 가므로 중계 서버는 읽지 못한다. 파일은 크기와 sha256이 보낸 쪽이 적은 것과 같을 때만 저장한다.
- `~/.coworker/hint-shown`: Claude Code를 채널로 켜는 법 안내를 한 번 전했다는 표시.
- coworker 앱(Claude 플러그인 디렉터리판)을 쓰면: 앱 파일 `~/.coworker/coworker.js`, 기록 `~/.coworker/app.log`, 로그인할 때 앱을 켜는 설정(Mac은 `~/Library/LaunchAgents/com.brillianttiger.coworker.plist`, Windows는 시작프로그램 폴더의 `coworker.lnk`). 앱은 `127.0.0.1:7690`에서만 열리고 웹페이지가 보낸 요청은 거절한다.
- 대화 보기 화면은 세션이 살아 있는 동안 `127.0.0.1`에서만, 링크에 든 토큰을 알아야 열린다. 화면은 밖에서 아무것도 받아 오지 않는다. 모양, 스크립트, 움직임이 모두 화면 안에 들어 있다. 화면에서 할 수 있는 일은 둘이다: 접근키(연결 코드)를 새로 만드는 것, 그리고 대화를 목록 맨 위에 고정하는 것. 두 요청 모두 이 PC의 세션에만 간다. 고정은 세션이 되살릴 것과 함께 이 PC에 남고 상대에게는 가지 않는다.
- Claude Code에서는 브릿지가 열려 있는 동안 플러그인이 채팅창 위에 카드를 그린다. 그러려고 `~/.coworker/sessions/<세션>.json`에서 대화 보기 주소를 읽고, `127.0.0.1`의 대화 보기 서버에 짧은 요약을 묻는다. 요약에는 연결된 세션의 이름과 그 세션이 무엇으로 도는지, 각각 닿는지, 대화와 글의 수, 답이나 사람의 결정을 기다리는 대화의 수, 최근 글 몇 개의 앞부분이 있다. 방금 온 글은 잠깐 펼쳐 보인다. 또 이 PC의 세션에 Claude Code의 모델과 effort를 알려 준다. 이 가운데 이 PC 밖으로 나가는 것은 위에 적은 모델과 effort뿐이다.

## 연락

https://github.com/BrilliantTiger/ai-coworker-without-me/issues 에 이슈를 남긴다.
