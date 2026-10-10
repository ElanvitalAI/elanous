<p align="center"><img src="https://elanous.ai/media/brand/elanous-180.png" width="112" alt="Elanous mark"></p>

# Elanous

> **Public beta** — install it today; provided as is (Apache-2.0). The big update lands on October 28, 2026 — news at [elanous.ai](https://elanous.ai).
> **공개 베타** — 지금 설치해 쓸 수 있습니다. 정식판 전까지 있는 그대로(Apache-2.0) 제공합니다. 2026년 10월 28일 대규모 업데이트 — 소식은 [elanous.ai](https://elanous.ai). <!-- announce:allow B11 -->

> **élan, and nous** — The red point at the center is *élan* — the drive to move on its own. The three white blades around it are *nous* — the mind that brings order. They turn one way — observe, understand, heal — widening a little with every turn. A spark meets a mind and keeps widening itself. That is Elanous.

**Elanous is the conductor that coordinates many AI agents and brings back only finished results.**
It works with Codex and Claude (beta) — and gives them wings.

- **Loop agents** — a team of AI on duty for the work that repeats, kept at it until it is done.
- **Graph engineering** — work you hand over runs as an execution graph: a work manual you can see, edit and share.
- **On top: one sentence to start** — the smart wizard turns a request into a plan, an execution graph or a plugin.
- **Support: harness and PTY intelligence** — it drives other coding agents in real terminals, and carries each change through implementation, tests, review and merge.
- **Foundation: observe, understand, heal** — every layer stands on a system that watches itself, understands the context and repairs what it can.

For code, you describe a change in one sentence. elanous writes the goal document,
creates an isolated git worktree, runs a child agent inside it, gates the
result with tests, reviews it unattended, opens a pull request and, when the
gates and the review hold, merges it. You are called when
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

Pin a version with `ELANOUS_VERSION=<version>` in front of `bash` (versions are
listed on the [releases page](https://github.com/ElanvitalAI/elanous/releases)). Each version
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
## How it works

Loop agents and execution graphs carry the work: the graph keeps repeated
work on a known path, and the loop agents handle what falls off it. Under
them, three abilities engage on a single request:

| | What it means | The real commands |
|---|---|---|
| **Eyes** | Read another process's screen, the web, a live browser — without owning them | `elanous pty snapshot <ref>` · firecrawl · omni-crawl · aside · CDP |
| **Hands** | Actually type — into files, and into someone else's TUI | tool loop (Read/Edit/Write/Bash) · `elanous pty text\|key <ref>` |
| **Memory** | What it went through is loaded into the next turn automatically | `elanous memory` · `elanous self recall` |

Two more properties follow from that:

- **Rigid *and* dynamic.** The contract — gates, unattended review, the
  run ledger — is fixed. The path taken through it is not.
  Workflows (`elanous wf`) and harness runs now share one execution
  graph — one name, one canvas, one set of triggers — and YAML workflows
  run on it through a compatibility layer. Merging the executors
  themselves is still in progress.
- **The eyes are partly borrowed.** Web and browser sight leans on paid
  services (firecrawl, grok inside omni-crawl, aside, CDP). elanous records
  *what stops working without each one* in `catalog/resources.yaml`.

> Lineage: `sync-skills` → `skillpad` → a 3-pane TUI chassis → **this**.
> The TUI still ships and still works, but it is one interface among
> several (CLI, NEXUS/PWA dashboard, MCP, chat channels), not the point
> of the project.
## The harness — how a sentence becomes a merged change

`elanous` carries a **self-implementation harness**. You describe a change
in one sentence or one file; the harness writes a goal document, creates
an isolated git worktree, runs a child agent inside it, gates the result
with the test suite, opens a pull request and, when the gates and the
review hold, merges it.

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

⚠️ Working in other repositories is experimental: `elanous harness say --target <path>`
picks the target repository, but the supported scope is not settled yet.
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
| What shipped | [Releases](https://github.com/ElanvitalAI/elanous/releases) |
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
bun test                    # full suite — see AGENTS.md for the gate discipline
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

## References / 참고한 오픈소스

elanous studied the design and patterns of many open-source projects — the full list with repositories and licenses is in [내부 문서 `REFERENCES`). The most-referenced: [opencode](https://github.com/anomalyco/opencode) · [openclaw](https://github.com/openclaw/openclaw) · [hermes-agent](https://github.com/nousresearch/hermes-agent) · [t3code](https://github.com/pingdotgg/t3code) · [codex](https://github.com/openai/codex) · [gemini-cli](https://github.com/google-gemini/gemini-cli) · [agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol) · [deer-flow](https://github.com/bytedance/deer-flow).

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
