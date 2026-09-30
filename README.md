# Elanous

> **Beta** — Elanous is provided as is (Apache-2.0) until the stable release. Get stable release news at [elanous.ai](https://elanous.ai).
> **베타** — 정식 릴리스 전까지 Elanous 는 있는 그대로(Apache-2.0) 제공됩니다. 정식 릴리스 소식은 [elanous.ai](https://elanous.ai) 에서 받으세요. <!-- announce:allow B11 -->

> The name joins *élan* (the drive to act) and *nous* (mind). The agent
> observes itself, reasons about what it sees, and repairs itself; a person is called only when it cannot (一約之觀).

**A self-healing coding harness where eyes, hands, and memory all turn on
one sentence — an agent that develops agents.**

You describe a change in one sentence. elanous writes the goal document,
creates an isolated git worktree, runs a child agent inside it, gates the
result with tests, reviews it unattended, and merges. You are called when
the system cannot converge — not at every step.

```bash
elanous harness say "add a --json flag to the status command"
```
## Install

One line — the installer fetches the latest release, verifies it against
`SHA256SUMS`, installs Bun first if it is missing (the pinned version in
[`.bun-version`](.bun-version)), and puts `elanous` on your `PATH`:

```bash
curl -fsSL https://github.com/ElanvitalAI/elanous/releases/latest/download/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://github.com/ElanvitalAI/elanous/releases/latest/download/install.ps1 | iex
```

Pin a version with `ELANOUS_VERSION=0.1.1` in front of `bash`. Each version
lives in its own folder under `~/.local/share/elanous/versions/`, and
`~/.local/share/elanous/current` points at the active one, so older versions
stay on disk for rollback.

### From a bare Linux machine

A bare image may not even have `curl`. Install the basics, then the one line;
if anything else is missing the installer names all of it in a single
install line (without `sudo` when you are root):

```bash
sudo apt-get update && sudo apt-get install -y curl ca-certificates unzip git
curl -fsSL https://github.com/ElanvitalAI/elanous/releases/latest/download/install.sh | bash
source ~/.bashrc                      # or open a new shell
elanous --version && elanous doctor
```

To run the daemon and the harness, let `doctor` install the tools it needs —
build tools and the node-pty rebuild, a pinned static `gh`, `rg`, Node and
the Codex CLI (about 80 seconds on a bare Debian 12 VM):

```bash
elanous doctor --fix --yes --sudo
elanous login openai-codex              # ChatGPT subscription, device code, no API key
gh auth login
elanous nexus run                       # daemon · web app at http://127.0.0.1:31415/app/
```

⚠️ Do not install `gh` from Debian/Ubuntu apt — those packages are older
than the 2.80 the harness needs; `doctor --fix --yes` fetches a pinned one.
To keep the daemon running across reboots: `elanous nexus install --systemd-user`
(Linux) or `elanous nexus install --launchd` (macOS).

### Update and uninstall

```bash
elanous self-update                     # latest release (keeps the previous version for rollback)
curl -fsSL https://github.com/ElanvitalAI/elanous/releases/latest/download/uninstall.sh | bash
```

Uninstall removes what the installer created (`versions/`, `current`, `bin/`,
`install.json`) and the `PATH` lines it added. Your memories
(`~/.local/share/elanous/memory`) and your state in `~/.elanous` — logins, logs,
ledgers, config — stay.

## What you still need — `elanous doctor`

```bash
elanous doctor        # every credential the code reads: is it resolved, and from where
```

`elanous doctor` is a **report, not a gate** — **nothing is required to boot**.
`elanous --version`, `elanous where`, `elanous config get` and `elanous usage` all
work with zero credentials. Each key you add unlocks one capability; see
[`.env.example`](.env.example). The primary path for LLM access is a
**subscription**, not an API key (`elanous login openai-codex`) — details in
[Codex subscription](https://docs.elanous.ai/models/codex-subscription/).

## Quick start

```bash
elanous harness say "add a --json flag to the status command"   # one sentence
elanous harness ask 내부 문서 `MY-ASK`                        # a written goal
```

See the [Quickstart](https://docs.elanous.ai/getting-started/quickstart/).
## What makes it different

Most agents do one of these well. elanous's claim is that **all three
engage on a single request**.

| | What it means | The real commands |
|---|---|---|
| **Eyes** | Read another process's screen, the web, a live browser — without owning them | `elanous pty snapshot <ref>` · firecrawl · omni-crawl · aside · CDP |
| **Hands** | Actually type — into files, and into someone else's TUI | tool loop (Read/Edit/Write/Bash) · `elanous pty text\|key <ref>` |
| **Memory** | What it went through is loaded into the next turn automatically | `elanous memory` · `elanous self recall` |

Two more properties follow from that:

- **Rigid *and* dynamic.** The contract — gates, unattended review, the
  run ledger — is fixed. The path taken through it is not.
  ⚠️ Today these are *two* runtimes (the harness pipeline and
  `elanous wf`'s DAG); connecting them is open work.
- **The eyes are partly borrowed.** Web and browser sight leans on paid
  services (firecrawl, grok inside omni-crawl, aside, CDP). elanous records
  *what stops working without each one* in `catalog/resources.yaml`.
  ⚠️ 20 of 27 credentialed entries have that field empty today.

> Lineage: `sync-skills` → `skillpad` → a 3-pane TUI chassis → **this**.
> The TUI still ships and still works, but it is one surface among
> several (CLI, NEXUS/PWA dashboard, MCP, chat channels), not the point
> of the project.
## The harness — how a sentence becomes a merged change

`elanous` carries a **self-implementation harness**. You describe a change
in one sentence or one file; the harness writes a goal document, creates
an isolated git worktree, runs a child agent inside it, gates the result
with the test suite, and opens a pull request.

```bash
elanous harness say "add a --json flag to the status command"   # one sentence
elanous harness ask 내부 문서 `MY-ASK`                        # a written goal
elanous harness plan "..."                                      # write an RFC, do not execute
elanous harness worktrees                                       # what worktrees exist, and who owns them
```

What each run leaves behind, so a failure can be read afterwards:

- a **goal document** under `docs/goals/`
- an isolated **worktree** and branch, owned by the run id
- a **run ledger** entry (`elanous self run-ledger <id>`)
- structured logs (`elanous logs --category <c>`)

⚠️ The harness currently assumes it is operating on *this* repository in
several places — notably the default integrity gate runs
`bun bin/elanous.mjs --help`, which does not exist in a foreign project.
Running the harness against another repository is **not supported yet**.
## Documentation

All documentation lives at **[docs.elanous.ai](https://docs.elanous.ai/)** (한국어: [/ko](https://docs.elanous.ai/ko/)). <!-- announce:allow B11 -->

| Goal | Start here |
|---|---|
| Install, update, uninstall | [Install](https://docs.elanous.ai/getting-started/install/) · [Update and uninstall](https://docs.elanous.ai/getting-started/update-and-uninstall/) |
| First run | [Quickstart](https://docs.elanous.ai/getting-started/quickstart/) · [Commands you will use](https://docs.elanous.ai/using-elanous/commands/) |
| Models and logins | [Providers](https://docs.elanous.ai/models/providers/) · [Codex subscription](https://docs.elanous.ai/models/codex-subscription/) |
| Sessions and the TUI | [Sessions](https://docs.elanous.ai/using-elanous/sessions/) · [The TUI](https://docs.elanous.ai/using-elanous/tui/) |
| Chat channels | [Telegram](https://docs.elanous.ai/surfaces/telegram/) · [Discord](https://docs.elanous.ai/surfaces/discord/) |
| Settings and tools | [Configuration](https://docs.elanous.ai/reference/configuration/) · [External commands](https://docs.elanous.ai/reference/external-commands/) · [Source layout](https://docs.elanous.ai/concepts/source-layout/) |
| Something failed | [Troubleshooting](https://docs.elanous.ai/help/troubleshooting/) |
| What shipped | [Releases](https://docs.elanous.ai/releases/0-1-0/) |
## Requirements

- **bun** — the tested version is pinned in [`.bun-version`](.bun-version); the
  installer, the pod image and `elanous doctor` all follow it. Node cannot run
  elanous (`bin/elanous.mjs` imports TypeScript directly).
- **macOS** is the primary target; **Linux** and **WSL2** are exercised (on
  WSL2 keep the repository on the Linux filesystem, not `/mnt/c`);
  **Windows** native PowerShell is experimental.
## Develop on elanous itself

```bash
git clone https://github.com/ElanvitalAI/elanous && cd elanous
bun install
bun run src/index.ts        # dashboard (TUI)
bun test                    # full suite (4,199 test files) — see AGENTS.md for the gate discipline
```

Link the CLI so `elanous` works anywhere:
```bash
bun link                    # in this repo
bun link elanous         # in any other project (or just globally)
elanous                       # launches the dashboard (interactive TUI)
elanous nexus run             # launches the NEXUS daemon (PWA + meta-api · headless)
```

Or run the first-run wizard (persists to `~/.elanous/config.json`):
```bash
elanous setup
```
## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
