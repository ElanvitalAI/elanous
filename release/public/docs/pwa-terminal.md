# Terminal — live shells in the browser

The **Terminal** menu of the web app opens real shells on the machine that
runs the elanous daemon. You can keep several open, use them from a phone or
tablet, attach files, and talk to an agent about what is on screen.

The menu's labels are partly in Korean today, so this page gives each label
as it appears on screen, with the meaning in brackets.

> The shell runs on the daemon's machine, as your user, in the folder the
> daemon was started from. Anything you type there runs for real.

## Open a terminal

- **+** at the top opens a new terminal. Each one gets a tab with its name;
  **×** or **끝내기** (end) closes it.
- The status at the top right shows how many terminals are open and whether
  they are alive.
- The bar under the tabs switches between three views:
  - **터미널** (terminal) — your shells.
  - **🖥 TUI 관측** (watch the TUI) — a read-only live view of the elanous
    terminal UI running in another window on the daemon's machine.
  - **PTY 목록** (PTY list) — every terminal the daemon knows about, with its
    history.
- **▦ 나란히** (side by side) shows up to three live terminals next to each
  other — agent terminals first. Each pane names its agent and has a strip
  with what elanous just did there and why. Pick the panes from the chips at
  the top; the address keeps your choice (`?wall=<id>,<id>`), so you can share
  the view.

The connection status (`ACP: 연결됨` — connected) is shown in the corner of
the terminal. From 0.2.2, keys you type while it still says `연결 중`
(connecting) are held and sent in order once it connects. In earlier versions,
wait for `연결됨` before you type — keys typed while connecting can be lost.

## Type on a phone or tablet

On a touch screen a key bar appears under the terminal with **Esc**, **Tab**,
the arrow keys and sticky **Ctrl** and **Alt** — tap Ctrl, then a letter, to
send Ctrl+letter. A modifier releases itself after a few seconds if you do
not use it.

## Toolbar

| Button | What it does |
|---|---|
| **clear** | Clears the screen in this browser. The shell itself keeps running as it was. |
| Camera | Takes a photo (or picks one) and puts its file path into the terminal. |
| File | Attaches one or more files and puts their paths into the terminal. You can also drag files onto the terminal. |
| **Live** | Shares your camera with the agent while it is on. |
| **voice→stdin** | Speak, and the words are typed into the terminal. |
| **record** | Records the terminal session on the daemon. |

## Terminal Chat Dock

Under the terminal is a chat box tied to the current terminal:

- Plain text asks an agent about the terminal — it can see what is on screen.
- Lines that start with `:` stay local. Type `:help` to list them; for example
  `:tab next`, `:tab prev`, `:cwd` and `:capture`.
- It shows the session and what the agent has cost this month.

## Use it from several devices

Open the same terminal on another device (see
[The web app (PWA)](pwa.md#use-it-from-another-device)) and both see the same
screen. A badge shows how many devices are attached, and a short "typing"
flash appears when someone else types.

Reopening a terminal tab — after a browser restart, or from another browser —
returns you to the same shell that is still running; it does not start a new
one.

## Watch an agent's terminal from a link

:::info Since 0.2.3
:::

When elanous drives a coding CLI (codex, Claude Code, grok) in a terminal of
its own, it prints a link to that terminal as soon as the terminal starts:

- `elanous agent-mission` prints `[agent-mission] pty=<id> watch=<link>` on
  its first lines, and the finished result carries the same link.
- A harness run prints a `[surface-link] url=<link>` progress line.
- A harness run started from Telegram also sends the link to that chat once.

The link has the form `https://<your-tailnet-name>/app/term/?pty=<id>` and
works on your tailnet only. Opening it shows that terminal's screen live,
refreshed about once a second, with the terminal id at the top:

- It starts **읽기 전용** (read-only) — you watch; your keys go nowhere.
- **takeover** lets you type into it (the label changes to **입력 가능** —
  typing enabled). **release** gives control back.
- **닫기** (close) returns to your own terminals.

Picking a row in **PTY 목록** (PTY list) opens the same live view.

When the terminal ends the view stops with «PTY 가 끝났습니다» (the PTY has
ended). «소유 프로세스에 닿지 않습니다» (the owning process cannot be
reached) means the process that runs it stopped answering.

## Troubleshooting

- **The page stays on «터미널 이름을 준비하는 중…» (preparing the terminal
  name)** — reload the page.
- **Keys go missing right after opening** (before 0.2.2) — wait until the
  status says `ACP: 연결됨` (connected), then type.
- **The page does not load at all** — see [The web app (PWA)](pwa.md).
