# AI Co-worker Without Me

Let your AI ask your coworker's AI directly. With coworker, a Claude Code session on your computer and a Claude Code or Codex session on a coworker's computer ask and answer each other over the office network or a company VPN. You stop copying AI output into a messenger and pasting the reply back. The humans watch, make the decisions the AIs bring to them, and read the agreement the AIs write at the end, with the facts that were checked kept apart from guesses.

There is no central server: the two computers connect to each other directly, and everything is encrypted end to end.

## What this plugin contains

This plugin contains no code. It connects Claude Code to the **coworker app**, which you install and run on your own computer, at `http://127.0.0.1:7690/mcp`, and it adds a skill that tells Claude what to do when the app is not running. The app is a single file, `coworker.js`, from this project's [GitHub releases](https://github.com/BrilliantTiger/ai-coworker-without-me/releases), and it needs [Bun](https://bun.sh).

## Install the app

Mac:

```
mkdir -p ~/.coworker && curl -fsSL https://github.com/BrilliantTiger/ai-coworker-without-me/releases/latest/download/coworker.js -o ~/.coworker/coworker.js && bun ~/.coworker/coworker.js autostart on
```

Windows (PowerShell):

```
New-Item -ItemType Directory -Force "$HOME\.coworker" | Out-Null; curl.exe -fsSL https://github.com/BrilliantTiger/ai-coworker-without-me/releases/latest/download/coworker.js -o "$HOME\.coworker\coworker.js"; bun "$HOME\.coworker\coworker.js" autostart on
```

`autostart on` starts the app now and at every login (a LaunchAgent on Mac, a Startup shortcut on Windows). `autostart off` stops it. The full guide, with firewall notes, is in [INSTALL.md](https://github.com/BrilliantTiger/ai-coworker-without-me/blob/main/INSTALL.md).

## Use it

Say "open a coworker bridge". Your AI shows a connection code; send it to your coworker, whose AI connects with it. From then on the AIs ask and answer each other until you say stop. Decisions come back to you; nothing is decided for you.

## Privacy

The app listens only on `127.0.0.1` and refuses requests from web pages. Messages go only to the sessions you connected, encrypted end to end; nothing goes to the authors of this project. See [PRIVACY.md](https://github.com/BrilliantTiger/ai-coworker-without-me/blob/main/PRIVACY.md).

Independent open source (MIT). Not affiliated with Anthropic or OpenAI.
