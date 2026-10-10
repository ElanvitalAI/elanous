# The TUI

elanous's TUI is a 3-pane layout (skills / preview / chat) — a real file manager, not a chat with a sidebar. Plugins can remap what lives in each pane.

## Attachments

Drop a path inline in your question; the dashboard tokenizes, extracts,
and attaches it automatically:

| Extension | Kind  | Extractor                              | Byte cap      |
|-----------|-------|----------------------------------------|---------------|
| `.txt`    | text  | UTF-8 readFile                         | 20 KB         |
| `.md`     | md    | UTF-8 readFile                         | 20 KB         |
| `.pdf`    | pdf   | `pdf-parse` v2 (`PDFParse.getText`)    | 20 KB         |
| `.docx`   | docx  | `mammoth.extractRawText`               | 20 KB         |
| `.xlsx`   | xlsx  | `xlsx` → all sheets, first 100 rows ea | 20 KB         |
| `.png`    | image | sharp resize (1568×1568, JPEG ladder)  | 3 MB encoded  |
| `.jpg` `.jpeg` | image | same                              | 3 MB encoded  |
| `.gif`    | image | same (static frame)                    | 3 MB encoded  |
| `.webp`   | image | same                                   | 3 MB encoded  |

Text-kind attachments are prepended as labeled code-fenced sections
ahead of your question. Images ride as multimodal ContentBlocks when the
routed model can read images.

Paths accepted: absolute (`/path/to/f.pdf`), home-relative (`~/doc.pdf`),
`./` or `../`, and quoted (`"name with space.pdf"`). URLs are skipped.
Symlinks resolve to their canonical target (two links → one attachment).

## Slash commands

The commands you will use most. The TUI has more — open the help overlay with `/help` (or `/?`) for the full list.

| Command | Alias | Purpose |
|---------|-------|---------|
| `/harness <sentence>` | | Hand work to the harness (also `plan`, `runs`, `stop <id>`) |
| `/run-skill <name> [args]` | `/rs`, `/run` | Execute a SKILL.md |
| `/provider` | `/p` | List providers + availability |
| `/model [name]` | `/m` | Switch the active model (lists them with no argument) |
| `/reasoning [off\|low\|medium\|high\|xhigh]` | `/r`, `/think` | Reasoning level |
| `/resume [id]` | | Pick a past session, or load one by id prefix |
| `/fork` | | Copy this session into a new one |
| `/session list\|load\|new` | `/sess` | Manage sessions |
| `/remaining` | | What each account has left |
| `/memory list\|search\|add` | `/mem` | Memory |
| `/directive <text>` | | Record an instruction as a Linear issue |
| `/design` | `/design-check` | Design rulebooks this repository declares |
| `/term` | `/terminal` | Terminal modal (spawn, attach, switch) |
| `/setup` | | Setup wizard guide (`/setup reset` re-runs it next start) |
| `/context` | `/ctx` | Table of attached files |
| `/context clear [big]` | | Drop all attachments (or ≥100KB ones) |
| `/context drop <id>` | | Drop a single attachment |
| `/paste` | | Attach clipboard image (macOS) |
| `/sync` | `/s` | Enter sync mode |
| `/plugin list\|activate\|deactivate\|reload` | `/plugins` | Manage plugins |
| `/clear` | `/cls` | Clear log pane (keeps attachments) |
| `/help` | `/?` | Keybinding overlay |
| `/quit` | `/q`, `/exit` | Exit |

`elanous keys` prints every keybinding and slash command.

## Folded internal notes in chat

When a final reply contains a `[NO FINAL SYNTHESIS]` tail, the TUI shows the
preceding text and folds the tail into one `● Internal notes folded · N lines ·
press f to expand` line. With the log pane focused, press `f` to expand the
most recent fold; press it again to collapse it. The tail is still available
when expanded. Replies without that marker keep their usual display.

## Argument autocomplete

After typing a command name and a space, Tab / Up / Down navigate
argument suggestions. Enter on an empty current arg accepts the
selection and submits. Prefix filter is live: `/plugin activate s` + Tab
completes to `sync` without scrolling.

- `/plugin <subcmd>` → list, activate, deactivate, reload
- `/plugin activate <name>` → every discovered plugin (built-in + user)
- `/context drop <id>` → attachment ids currently in the registry
- `/run-skill <name>` → skill directory names under `~/.claude/skills/`

## Log pane clipboard copy

With the log pane focused (backtick `` ` `` or Tab-cycle):

| Key / mouse | Action |
|---|---|
| `y` | Copy the most recent output block to the system clipboard |
| `Y` | Copy the entire log buffer |
| Right-click inside log pane | Copy the block under the mouse cursor |

Blocks are delimited by the blank separator lines the dashboard inserts
between prompts / responses. ANSI codes are stripped before writing so
the pasted text is plain.

## Terminal compatibility

Elanous uses SGR mouse reporting (`CSI ?1000h` + `?1006h`). Most
modern terminals forward mouse events to the app when this is enabled.

| Terminal | Mouse / right-click | Notes |
|---|---|---|
| **Ghostty** (macOS, Linux) | Works out of the box | SGR mouse is forwarded. If a terminal-level context menu ever intercepts, hold `Option` to bypass it for that click. |
| **Kitty** | Works out of the box | Best experience — native CSI-u keyboard protocol supported too. |
| **WezTerm** | Works; may need `enable_kitty_keyboard = true` | For the Ctrl+Shift+V paste chord in particular. |
| **iTerm2** | Works after enabling "Applications in terminal may access clipboard" + "Report mouse events" | Defaults are usually fine for normal right-click. |
| **Apple Terminal.app** | Right-click opens macOS menu | Fall back to the `y` / `Y` keystrokes. Clipboard write via `pbcopy` still works. |
| **VS Code integrated terminal** | Right-click copies selection by default | Use `y` / `Y` or set "terminal.integrated.rightClickBehavior" to `default`. |

If right-click doesn't feel right on your terminal, `y` / `Y` keystrokes
do the same thing and work everywhere.

Anything that doesn't start with `/` goes to the LLM Q&A path. Inline
file paths are tokenized before submit so you can mix them freely:

```
summarize Q3 findings: ~/Q3.pdf and ~/chart.png
```
