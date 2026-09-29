# PTY intelligence — elanous drives terminals and coding agents

elanous can work a terminal the way a person does: it reads the screen, types,
presses keys, clicks with the mouse, waits, and decides what to do next. It
uses this to drive a plain shell, other coding agents such as Codex and
Claude Code, and another copy of elanous itself — and you can watch all of it
live in the web app.

It does not always reach for a coding agent. For each mission it measures the
machine first and starts from the **lowest rung** that can do the job.

> Everything runs on your machine, as your user, with your own subscriptions.
> elanous never types a password and never reads cookies or credential files.

## Three directions

| Direction | What happens | Example |
|---|---|---|
| **elanous → agent** | elanous opens a terminal (PTY), starts a shell or an agent CLI, and drives it: typing, keys, mouse, reading the screen, deciding when it is done. | Start Codex, answer its trust prompt, paste the mission, wait for the diff. |
| **agent → file → next agent** | One agent leaves its result somewhere — a diff, a summary, a file — and that becomes the input of elanous or of another agent. | Codex writes the change; a second agent reviews the diff file; elanous gates it. |
| **agent → elanous** | An agent calls elanous through its official integration (MCP), for example to start a harness run, read logs or control a terminal. | Codex or Claude Code calls elanous tools from inside its own session. |

The three combine: elanous drives one agent, hands its output to another, and
that agent can call back into elanous to run the gated harness and open the PR.

## The tool ladder

| Rung | Tool | When |
|---|---|---|
| 0 | **Environment check** | Always first — OS, shell, package managers, which CLIs are installed, whether agents are signed in (yes/no only). |
| 1 | **Shell and text tools** | One or two lines of `jq`, `awk`, `sed`, `rg`, `curl`, `ffmpeg`. |
| 2 | **Domain CLIs** | `git`, `gh`, `docker`, `kubectl`, `elanous …` |
| 3 | **elanous capabilities (MCP/ACP)** | Memory, logs, notes, skills, terminal control. |
| 4 | **elanous harness** | A code change that needs gates, review and a PR. |
| 5 | **Coding agents** | Large builds or a second pair of eyes — Codex, Claude Code. |

See where a mission would start, without running anything:

```bash
elanous env profile            # what this machine has (read only)
elanous agent-mission plan "sum the amount column of this CSV as JSON"
# Starting rung: 1 · tool: jq
```

If a tool the rung needs is missing, elanous installs it by typing the
package-manager line in the shell and then checks it with the smallest real
job (not `--version`). A line that needs `sudo` is handed to you instead.

## Research before it acts

When a mission needs outside knowledge — an unfamiliar CLI, a library's docs,
an error message — elanous searches several engines at once and shows the
fan-out as it happens:

```bash
elanous research "Miller mlr convert csv to json" --limit 3
elanous research "…" --json      # results with per-engine timing and hit counts
```

Research results are treated as data. elanous never runs a command it found on
a web page as-is.

## Mouse

Some terminal apps turn on mouse mode. elanous can click and scroll in them:

```bash
elanous pty mouse <ref> <column> <row>           # left click (1-based)
elanous pty mouse <ref> 10 5 --button right
elanous pty mouse <ref> 1 1 --scroll down
```

If the app has not turned mouse mode on, the click is refused rather than sent
as stray characters.

## Drive a coding agent on a mission

```bash
elanous agent-mission mission --backend codex "add retries to the payment client"
elanous agent-mission mission --backend claude --evidence test --test-path src/pay.test.ts "…"
elanous agent-mission mission --backend codex --plugin elanous-basics@elanous "make this PDF folder searchable"
elanous agent-mission mission --chain codex,claude,elanous "…"   # build → review → evidence and pull request
```

elanous opens the agent in a PTY inside a separate git worktree, drives it to
the end, and closes the mission only when the evidence gate passes (`doc`,
`tsc` or `test`). Claude Code is driven through its terminal by default; only the
opt-in `agent-mission mission --headless` flag runs Claude's non-interactive mode instead. When an agent first opens a folder and asks
whether to trust it, elanous answers that screen before it types the mission.

- `--plugin <name>@<market>` — elanous opens the agent's own plugin screen
  (`/plugins` in Codex, `/plugin install` in Claude Code), installs the plugin
  from that marketplace, and then runs the mission with its skill. The official
  marketplace is `elanous` (see [Plugins](plugins.md)).
- `--chain` — one mission passes through several agents in order, for example
  Codex builds, Claude Code reviews, and elanous checks the evidence and opens
  the pull request. The reviewer gets the builder's diff and the next agent
  gets a short summary — never the raw screen.

## Watch it

Every terminal elanous drives appears in the web app's **Terminal** menu, with
the agent's name and a strip showing what elanous just did and why. Several
terminals can sit side by side. See [Terminal](pwa-terminal.md) and
[Live](pwa-live.md).

## Sign-in

When an agent shows a sign-in screen, elanous stops and sends you the link or
device code — it does not sign in for you.

*Coming next:* if you have signed in once in a browser profile that elanous
can drive, elanous will approve the agent's sign-in page in that browser —
but only when the page is a plain "authorize" or "enter code" screen. Any
password, two-step, captcha or passkey prompt goes back to you.

## Status

| Piece | Status |
|---|---|
| Environment check, tool ladder, research, mouse, installing missing tools | Available |
| Driving Codex / Claude Code / elanous in a PTY | Available (Claude Code needs you signed in) |
| Handing results from one agent to the next in one mission (`--chain`) | Available |
| Installing a plugin inside the agent's own screen (`--plugin`) | Available for Codex (recorded end to end) · Claude Code uses `/plugin install` |
| Browser-assisted sign-in | In progress |
