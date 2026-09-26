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
| **clear** | Clears the screen. |
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
- You can pick the agent provider and see the session and cost for the month.

## Use it from several devices

Open the same terminal on another device (see
[The web app (PWA)](pwa.md#use-it-from-another-device)) and both see the same
screen. A badge shows how many devices are attached, and a short "typing"
flash appears when someone else types.

## Troubleshooting

- **The page stays on «터미널 이름을 준비하는 중…» (preparing the terminal
  name)** — reload the page.
- **Keys go missing right after opening** (before 0.2.2) — wait until the
  status says `ACP: 연결됨` (connected), then type.
- **The page does not load at all** — see [The web app (PWA)](pwa.md).
