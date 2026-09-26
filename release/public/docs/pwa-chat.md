# Chat — talk to elanous in the browser

The **Chat** menu of the web app is a conversation with elanous. Replies
stream in as they are written, and you can attach photos and files or talk to
it with your voice.

The menu's labels are partly in Korean today, so this page gives each label
as it appears on screen, with the meaning in brackets.

## The top bar

| Item | What it does |
|---|---|
| **sess:** | The current session. Click the id to copy it. Double-click the new-chat button to start an empty session; the old one stays in the session list. The menu next to it (**세션 메뉴** — session menu) starts a new chat or shows the session id and message count. |
| **이번 달 $…** (this month) | What elanous has spent this month, and the share of your budget when a budget is set. It turns to a warning colour when you pass your notify threshold. It reads **budget —** when the daemon cannot report it. |
| Microphone cost | What voice input and read-aloud have cost this month. |
| **provider** | The LLM provider for this session — keep **(default)** to use your configured one, or pick claude, gemini, grok or codex. |
| Tool surface (**default**) | Click to switch between the daemon's normal tools and **readonly** (the agent can look but not change anything). |
| **음성 대기** (voice waiting) | Voice status. The voice controls turn listening, spoken replies and the voice panel on or off. |

## Write a message

- Type in the box at the bottom and press Enter to send. Shift+Enter starts a
  new line.
- Buttons next to the box: attach a photo (camera or file), attach files,
  **save a photo as a note** (it becomes a Markdown note), and a
  **voice memo** — hold it down to record; the memo goes to intake.
- The pill on the left (**elanous** by default) picks the backend that
  answers: elanous's own LLM rotation, or the Codex, Claude Code or Gemini
  command-line tools.

## Meta commands

Lines that start with `:` are handled in the browser, not sent to the model.
Type `:help` to list them:

| Command | What it does |
|---|---|
| `:session` | Show the current session id. |
| `:fork` | Start a fresh session id. |
| `:provider <name>` | Set the provider for this session. |
| `:budget` | Show this month's spend and the notify threshold. |
| `:history [N]` | Summarise the last N turns on screen (default 10). |
| `:clear` | Clear the messages on screen. |

## Troubleshooting

- **The spend reads «budget —»** — the daemon could not report it; it tries
  again every minute.
- **The page does not load at all** — see [The web app (PWA)](pwa.md).
