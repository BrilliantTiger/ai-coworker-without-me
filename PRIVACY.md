# Privacy

[한국어](#개인정보)

AI Co-worker Without Me has no server run by its authors and collects nothing. It has no analytics or telemetry.

## What leaves your computer

Only when you open a bridge or connect with a code, and only to the sessions you connected (and, with a group code, the rest of that group):

- What your AI sends: questions, the background it attaches, answers, notices, notes that it is asking you, attached files, agreements, and your decisions from a question window (the option you picked and anything you wrote there).
- With a group code or a private code: your session's name (project folder, Claude Code or Codex, computer name) and the addresses and port in your connection code.
- With an outside code (`open_bridge` with `outside: true`): only the relay mailbox URL, public key, one-time token, a mark that it is an outside code, and the checksum in the code, and by default only the AI tool name (`Claude Code` or `Codex`) as your session's name. None of this computer's internal or VPN addresses, `.local` name, `127.0.0.1`, or port is put in the code or sent later. An outside code is always private (the session that joins is neither connected with nor told about any other session, and no other session is told about it, its name or its address; a question to "everyone" does not go to it), travels only through your configured relay, and blocks this computer's name, account name, home folder or paths under it, project folder path, and internal or VPN addresses from leaving in messages, files, agreements or logs towards that peer. The same check covers everything your session says about itself: its name, model and reasoning effort, whether your AI wrote them or they were set from the conversation view.
- What that check refuses: every address in the private and VPN ranges (`10.x`, `172.16`–`172.31.x`, `192.168.x`, `100.64`–`100.127.x`), also one that is not this computer's (an example in a document, another machine's address), and any text that contains this computer's account name, also when it names an account on another machine. A file goes to an outside session only when it is UTF-8 text that passes the check; text in another encoding (UTF-16 and so on) and files that are not text are refused, because their content cannot be checked.
- A session that joins with an outside code sends nothing about its machine either: no address and no port of its computer in its greeting (the address list is empty and the port field repeats the relay's port from the code), and as its name only the AI tool name or a name its human chose, also when that session already had a bridge open for colleagues. What it sends afterwards passes the same check. A session on version 0.12 that joins with an outside code still sends its usual name (project folder, tool, computer name), its addresses and its port in its greeting; the maker shows the name as given and drops the addresses and the port without storing them.
- Which AI tool your session is (Claude Code or Codex), and its model and reasoning effort when known. The sessions you connect to see them.

Messages go straight to the other computer over your office network or VPN. If you set a relay server, they can also pass through that relay, which whoever runs it sets up. Everything is encrypted end to end (NaCl box), so the relay cannot read or change it. The relay sees only a mailbox number, when something passed and how large it was. It holds a request in memory for up to 40 seconds until the other session picks it up and writes nothing to disk.

Update check: when coworker runs as an installed plugin, it reads the plugin manifest from GitHub (raw.githubusercontent.com, this project's release branch) shortly after it starts and every six hours, to see whether a newer release exists. GitHub sees your IP address, as with any download. Nothing about you or your conversations is sent. If a newer release exists, coworker runs the plugin update command of your app (Claude Code or Codex). Turn this off with the plugin setting Auto update = off, or `COWORKER_AUTO_UPDATE=off`. The coworker app (the `serve` that the directory plugin connects to) reads the same manifest on the same schedule. If a newer release exists, it downloads that release's `coworker.js` from GitHub (github.com, this project's releases) and replaces its own file. Turn this off with `COWORKER_AUTO_UPDATE=off`.

Before anything is sent, values that look like secrets (keys, tokens, passwords) are blocked and nothing goes out.

## What the maker of an outside code learns about the session that joins

- The name it gives: the AI tool name only, or a name its human chose, from a session on this version; the usual name with project folder and computer name from a session on version 0.12.
- Its AI tool, model and reasoning effort as it states them, and the list of what its version can do.
- Its public key and the short id made from it, and a token it hands over for rejoining.
- Everything it sends: questions, background, answers, notices, agreements, and, only if the bridge was opened to take files from outside sessions, files with their names; each with the time it arrived.
- Nothing else. The addresses and the port that a session puts in its greeting are dropped and not stored, and the maker never sends to an address that session names: the session comes to the maker's relay mailbox and picks up what is for it. The maker therefore does not ask it for its connection log or for the state of its question window. The maker never sees the network address of the session that joins. Whoever runs the relay sees that address, with the times and sizes of what passed, and never the content.

What a session that joined with an outside code may leave on the maker's computer is limited: at most 5 such sessions at a time on one bridge, and from each at most 20 conversations, 200 messages, 64 KiB in one message and 2 MiB in total; more is refused and that session is told why. Its files are refused unless the bridge was opened to take them, and then at most 20 MiB for each session. With these defaults one outside session leaves under 8 MiB on the maker's computer. The numbers are settings (`COWORKER_OUTSIDE_MAX_SESSIONS`, `…_CONVERSATIONS`, `…_MESSAGES`, `…_MESSAGE_KB`, `…_TOTAL_MB`, `…_FILES_MB`).

What you send also reaches the other person's AI session, under the terms of their Claude or Codex account.

## What stays on your computer

- `~/.coworker/bridges/<port>.json`: the open bridge and its last connection code, readable only by you. Deleted when the bridge closes.
- `~/.coworker/sessions/<session>.json`: what a session needs to come back after it restarts: its keys, the sessions it is connected to, its conversations, messages not yet delivered or read, unused connection codes, questions you have not answered yet in a question window, and the port and token of its conversation view link, so the link stays the same. Readable only by you. Deleted when you close the bridge.
- A keeper process (from 0.14.0). When a bridge is open, coworker starts one small process outside the AI session. While the session runs, it only watches and opens no port. If the session closes while the bridge is open, the keeper opens the same bridge port with the same keys, receives what the connected sessions send, saves it in the session file above, and shows you a desktop notification. It opens no other port and does not serve the conversation viewer. It tells the connected sessions that your AI session is closed. It ends when the session starts again, when you close the bridge, or when you run `bun coworker.js keep stop`. It gets only the path and coworker settings from the session's environment, not API keys or other variables. Set `COWORKER_KEEP=off` to have no keeper.
- `~/.coworker/agreements/`: agreements with the conversation they came from. Kept until you delete them.
- `~/.coworker/files/<session>/`: files sent with messages. `received/<conversation>/` holds the files you received, readable only by you, and they are kept until you delete them. `out/` holds a copy of each file that still waits to be delivered, and `partial/` holds pieces of files that are still arriving; both are deleted when the message is delivered or the bridge closes. Files travel sealed in the same way as messages, so a relay cannot read them. A file is saved only when its size and sha256 match what the sender said.
- `~/.coworker/hint-shown`: marks that the hint on starting Claude Code as a channel was passed on.
- If you use the coworker app (the Claude plugin directory edition): the app file `~/.coworker/coworker.js`, its log `~/.coworker/app.log`, and what starts it at login (`~/Library/LaunchAgents/com.brillianttiger.coworker.plist` on Mac, a `coworker.lnk` shortcut in the Startup folder on Windows). The app listens only on `127.0.0.1:7690` and refuses requests from web pages.
- The conversation viewer serves the session's conversations while the session is open, behind a token in its link: on this computer only (`127.0.0.1`) unless you set a viewer address (`COWORKER_VIEWER_ADDRESS`, or Viewer address in the plugin settings), and then also at that one address of this computer, on the same port, never on every network interface. The setting takes an address written out, or the word `tailscale` for this computer's one address in 100.64.0.0/10 (another network that uses the same range would match too); a name is not accepted. With the setting, the links coworker shows you use that address. Whoever has the link and can reach that address can read the conversation, make an access key and pin a conversation, and nothing else; nothing but the token in the link stands in between, and the page travels over plain `http`. Set only an address that you alone reach, such as your own VPN. The link is treated as a secret: text or a file that holds it is not sent to another session. This check finds the link only as it is written; it does not find a link that is split, encoded (percent-encoding, base64), compressed, or in a file in another text encoding (UTF-16). The page loads nothing from the network: its styles, scripts and motion are all in the page itself. You can do two things on the page: make a new connection code, and pin a conversation to the top of the list. Both requests go only to the session on this computer, from a page opened at `127.0.0.1`, `localhost` or the viewer address. A pin is kept with the session's saved state and is not sent to the other side.
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
- 외부용 코드(`open_bridge`의 `outside: true`)로 이었을 때: 코드에는 중계 서버의 우편함 주소, 공개키, 일회용 토큰, 외부용 코드라는 표시, 확인용 글자만 들어가고, 세션 이름은 기본으로 AI 도구 이름(`Claude Code`나 `Codex`)만 나간다. 이 PC의 사내·VPN 주소, `.local` 이름, `127.0.0.1`, 포트는 코드에도 그 뒤의 통신에도 들어가지 않는다. 외부용 코드는 언제나 개인용 코드라서 다른 세션과는 이어지지도 서로 알려 주지도 않으며(이름도 알리지 않고, 「모두에게」 묻는 질문도 가지 않는다), 설정한 중계 서버로만 오가고, 글·파일·합의문·연결 기록에 이 컴퓨터의 이름, 계정 이름, 홈 폴더와 그 아래 경로, 프로젝트 폴더 경로, 사내·VPN 주소가 들어 있으면 보내기 전에 막는다. 이 세션이 자기에 관해 알리는 것(이름, 모델, effort)도 같은 확인을 거친다. AI가 적었든 대화 보기 화면에서 적었든 같다.
- 그 확인이 막는 것: 사설·VPN 대역의 모든 주소(`10.x`, `172.16`~`172.31.x`, `192.168.x`, `100.64`~`100.127.x`). 이 컴퓨터의 주소가 아니어도(문서의 예시, 다른 컴퓨터의 주소) 막는다. 그리고 이 컴퓨터의 계정 이름이 든 모든 글. 다른 컴퓨터의 계정을 말한 것이어도 막는다. 외부 세션에게 가는 파일은 UTF-8 글이고 이 확인을 통과한 것만 보낸다. 다른 인코딩의 글(UTF-16 등)과 글이 아닌 파일은 내용을 확인할 수 없어서 보내지 않는다.
- 외부용 코드로 들어가는 세션도 자기 컴퓨터에 관한 것을 보내지 않는다. 인사에 이 컴퓨터의 주소와 포트를 적지 않고(주소 목록은 비우고, 포트 자리에는 코드에 있던 중계 서버의 포트를 그대로 적는다), 이름은 AI 도구 이름이나 사람이 정한 이름만 보낸다. 동료용 브릿지를 이미 열어 둔 세션이어도 같다. 그 뒤에 보내는 것도 같은 확인을 거친다. 0.12 판 세션이 외부용 코드로 들어가면 인사에 평소의 이름(프로젝트 폴더, 도구, 컴퓨터 이름)과 자기 주소·포트를 적어 보낸다. 코드를 만든 쪽은 그 이름은 받은 대로 보이고, 주소와 포트는 저장하지 않고 버린다.
- 이 세션이 어느 AI 도구인지(Claude Code나 Codex), 그리고 알 수 있으면 모델과 effort. 연결한 세션이 본다.

메시지는 사내망이나 VPN으로 상대 PC에 바로 간다. 중계 서버를 설정했으면 그 서버를 거칠 수도 있다. 중계 서버는 띄운 사람이 마련한다. 모든 내용은 양 끝에서 암호화(NaCl box)하므로 중계 서버는 읽거나 고치지 못한다. 중계 서버가 아는 것은 우편함 번호, 언제 얼마만큼 오갔는지뿐이다. 요청은 상대 세션이 가져갈 때까지 메모리에 최대 40초 두고, 디스크에는 아무것도 쓰지 않는다.

보내기 전에 비밀값으로 보이는 것(열쇠, 토큰, 비밀번호)을 찾으면 막고 아무것도 보내지 않는다.

## 외부용 코드를 만든 쪽이, 그 코드로 들어온 세션에 관해 알게 되는 것

- 그 세션이 알려 주는 이름: 이 판의 세션이면 AI 도구 이름이나 사람이 정한 이름뿐이고, 0.12 판의 세션이면 프로젝트 폴더와 컴퓨터 이름이 든 평소의 이름이다. 어느 쪽이든 한 줄, 80자까지만 두고, 보이지 않는 글자는 빼며 대괄호는 소괄호로 바꾼다. 이 이름은 그 세션이 정한 글일 뿐이어서, 만든 쪽은 그 세션을 이름이 아니라 「외부 세션」 표시와 짧은 ID로 가린다.
- 그 세션이 적은 대로의 AI 도구, 모델, effort, 그리고 그 판이 할 수 있는 것의 목록.
- 그 세션의 공개키와 거기서 만든 짧은 ID, 다시 들어올 때 쓰라고 건넨 토큰.
- 그 세션이 보낸 모든 것: 질문, 배경, 답, 알림, 합의문, 그리고 외부 세션의 파일을 받기로 하고 연 브릿지에서만 파일과 그 이름. 각각 도착한 시각과 함께 남는다.
- 그 밖에는 없다. 세션이 인사에 적어 보낸 주소와 포트는 버리고 저장하지 않으며, 만든 쪽은 그 세션이 적어 준 어떤 주소로도 보내지 않는다. 그 세션이 만든 쪽의 중계 서버 우편함에 와서 자기 앞으로 온 것을 가져간다. 그래서 만든 쪽은 그 세션에 연결 기록이나 질문 창 상태를 묻지 않는다. 만든 쪽은 들어온 세션의 네트워크 주소를 보지 못한다. 그 주소와 오간 시각·크기는 중계 서버를 운영하는 쪽이 보고, 내용은 보지 못한다.

외부용 코드로 들어온 세션이 만든 쪽 컴퓨터에 남길 수 있는 양에는 한도가 있다. 한 브릿지에 그런 세션은 한 번에 5개까지이고, 세션마다 대화 20개, 글 200개, 글 하나에 64 KiB, 모두 합쳐 2 MiB까지다. 넘으면 받지 않고 그 세션에 까닭을 알린다. 파일은 받기로 하고 연 브릿지에서만 받고, 그때도 세션마다 20 MiB까지다. 이 기본값에서 외부 세션 하나가 만든 쪽 컴퓨터에 남기는 것은 8 MiB를 넘지 않는다. 숫자는 설정으로 바꾼다(`COWORKER_OUTSIDE_MAX_SESSIONS`, `…_CONVERSATIONS`, `…_MESSAGES`, `…_MESSAGE_KB`, `…_TOTAL_MB`, `…_FILES_MB`).

보낸 내용은 상대의 AI 세션에도 들어간다. 그쪽은 상대가 쓰는 Claude나 Codex 계정의 약관을 따른다.

업데이트 확인: 플러그인으로 설치해 쓰면, coworker가 켜지고 잠시 뒤와 그 뒤 6시간마다 GitHub(raw.githubusercontent.com, 이 저장소의 release 브랜치)에서 플러그인 매니페스트를 읽어 새 판이 있는지 본다. 여느 다운로드처럼 GitHub는 IP 주소를 안다. 나나 대화에 관한 것은 아무것도 보내지 않는다. 새 판이 있으면 쓰는 앱(Claude Code나 Codex)의 플러그인 업데이트 명령을 돌린다. 끄려면 플러그인 설정의 Auto update를 off로 하거나 `COWORKER_AUTO_UPDATE=off`로 둔다. coworker 앱(디렉터리판 플러그인이 붙는 `serve`)도 같은 때에 같은 매니페스트를 읽는다. 새 판이 있으면 그 릴리스의 `coworker.js`를 GitHub(github.com, 이 저장소의 릴리스)에서 받아 자기 파일을 바꾼다. 끄려면 `COWORKER_AUTO_UPDATE=off`로 둔다.

## 이 PC에 남는 것

- `~/.coworker/bridges/<포트>.json`: 열린 브릿지와 마지막 연결 코드. 본인만 읽을 수 있고, 브릿지를 닫으면 지워진다.
- `~/.coworker/sessions/<세션>.json`: 세션을 다시 켰을 때 되살릴 것. 이 세션의 키, 연결된 세션, 대화, 아직 못 보냈거나 AI가 못 읽은 메시지, 아직 쓰지 않은 연결 코드, 아직 답하지 않은 질문 창, 그리고 대화 보기 링크가 바뀌지 않게 그 포트와 토큰이다. 본인만 읽을 수 있고, 브릿지를 닫으면 지워진다.
- 지킴이 프로세스(0.14.0부터). 브릿지가 열리면 coworker가 AI 세션 밖에 작은 프로세스를 하나 세운다. 세션이 살아 있는 동안에는 지켜보기만 하고 포트를 열지 않는다. 브릿지가 열린 채 세션이 닫히면, 지킴이가 같은 키로 쓰던 브릿지 포트를 열어 연결된 세션이 보낸 것을 받고, 위의 세션 파일에 저장하고, 데스크톱 알림을 띄운다. 다른 포트는 열지 않고 대화 보기 화면도 열지 않는다. 연결된 세션에는 이쪽 AI 세션이 닫혀 있다고 알린다. 세션을 다시 켜거나, 브릿지를 닫거나, `bun coworker.js keep stop`을 돌리면 끝난다. 세션의 환경변수 가운데 경로와 coworker 설정만 물려받고, API 키 같은 것은 물려받지 않는다. `COWORKER_KEEP=off`를 두면 지킴이를 세우지 않는다.
- `~/.coworker/agreements/`: 합의문과 그 대화 기록. 지울 때까지 남는다.
- `~/.coworker/files/<세션>/`: 글에 붙여 주고받은 파일. `received/<대화>/`에는 받은 파일이 본인만 읽게 저장되고, 지울 때까지 남는다. `out/`에는 아직 상대에게 가지 못한 파일의 사본이, `partial/`에는 받고 있는 파일의 조각이 있다. 둘 다 글이 넘어가거나 브릿지를 닫으면 지워진다. 파일은 글과 같은 방식으로 봉인되어 가므로 중계 서버는 읽지 못한다. 파일은 크기와 sha256이 보낸 쪽이 적은 것과 같을 때만 저장한다.
- `~/.coworker/hint-shown`: Claude Code를 채널로 켜는 법 안내를 한 번 전했다는 표시.
- coworker 앱(Claude 플러그인 디렉터리판)을 쓰면: 앱 파일 `~/.coworker/coworker.js`, 기록 `~/.coworker/app.log`, 로그인할 때 앱을 켜는 설정(Mac은 `~/Library/LaunchAgents/com.brillianttiger.coworker.plist`, Windows는 시작프로그램 폴더의 `coworker.lnk`). 앱은 `127.0.0.1:7690`에서만 열리고 웹페이지가 보낸 요청은 거절한다.
- 대화 보기 화면은 세션이 살아 있는 동안, 링크에 든 토큰을 알아야 열린다. 대화 보기 주소(`COWORKER_VIEWER_ADDRESS`, 플러그인 설정의 Viewer address)를 정하지 않으면 이 PC에서만(`127.0.0.1`) 열리고, 정하면 이 PC의 그 주소 하나에서도 같은 포트로 열린다(모든 네트워크에서 열지는 않는다). 설정에는 숫자로 적은 주소나, 이 PC의 `100.64.0.0/10` 주소 하나를 뜻하는 `tailscale`만 적을 수 있다(같은 범위를 쓰는 다른 네트워크의 주소도 여기에 든다). 이름은 받지 않는다. 정하면 coworker가 보여 주는 링크가 그 주소로 나온다. 링크를 알고 그 주소에 닿을 수 있는 사람은 누구든 그 대화를 읽고, 접근키를 만들고, 대화를 고정할 수 있다. 그 밖의 일은 할 수 없다. 링크에 든 토큰 말고는 막는 것이 없고, 화면은 암호화되지 않은 `http`로 오간다. 나만 닿는 주소(내 VPN)만 적는다. 링크는 비밀값으로 다뤄서, 링크가 들어 있는 글이나 파일은 상대 세션에 보내지 않는다. 이 확인은 링크가 적힌 그대로 들어 있을 때만 찾는다. 나눠 적었거나, 다른 꼴로 바꿔 적었거나(%로 바꾼 글자, base64), 압축했거나, 다른 글자 인코딩(UTF-16)으로 된 파일에 들어 있으면 찾지 못한다. 화면은 밖에서 아무것도 받아 오지 않는다. 모양, 스크립트, 움직임이 모두 화면 안에 들어 있다. 화면에서 할 수 있는 일은 둘이다: 접근키(연결 코드)를 새로 만드는 것, 그리고 대화를 목록 맨 위에 고정하는 것. 두 요청 모두 이 PC의 세션에만 가고, `127.0.0.1`, `localhost`, 대화 보기 주소로 연 화면에서만 받는다. 고정은 세션이 되살릴 것과 함께 이 PC에 남고 상대에게는 가지 않는다.
- Claude Code에서는 브릿지가 열려 있는 동안 플러그인이 채팅창 위에 카드를 그린다. 그러려고 `~/.coworker/sessions/<세션>.json`에서 대화 보기 주소를 읽고, `127.0.0.1`의 대화 보기 서버에 짧은 요약을 묻는다. 요약에는 연결된 세션의 이름과 그 세션이 무엇으로 도는지, 각각 닿는지, 대화와 글의 수, 답이나 사람의 결정을 기다리는 대화의 수, 최근 글 몇 개의 앞부분이 있다. 방금 온 글은 잠깐 펼쳐 보인다. 또 이 PC의 세션에 Claude Code의 모델과 effort를 알려 준다. 이 가운데 이 PC 밖으로 나가는 것은 위에 적은 모델과 effort뿐이다.

## 연락

https://github.com/BrilliantTiger/ai-coworker-without-me/issues 에 이슈를 남긴다.
