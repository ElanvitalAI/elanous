# Commands you will use

`elanous --help` lists everything; `elanous <command> --help` shows the options of one command. This page covers the ones a user needs day to day.

## Getting set up

| Command | What it does |
|---|---|
| `elanous start` | One command to begin: finds a model, starts the background service if needed and opens the web app (`--tui` for the terminal UI) |
| `elanous doctor` | Report which credentials resolve and from where, plus a readiness section (provider, `gh` sign-in, `PATH`, background service version, Linux `TMPDIR`) — `--json` for machines |
| `elanous doctor --fix` / `--fix --yes` | Show / apply the reversible repairs (the `PATH` block, key-cache permissions, the Linux `TMPDIR` block); startup files are backed up first. A missing git is offered interactively on a terminal; everything else needs `--yes` |
| `elanous setup` | Walk through missing setup steps (`--non-interactive` only reports) |
| `elanous login openai-codex` | Sign in with a ChatGPT subscription |
| `elanous login status` / `elanous login logout <provider>` | List / forget stored sign-ins |
| `elanous usage` | How much each account has left (subscription and credit are shown separately) |
| `elanous where` | Which instance this process uses, and why |

## Getting work done

| Command | What it does |
|---|---|
| `elanous harness say "<sentence>"` | Turn one sentence into a change: goal → worktree → tests → review → PR or branch |
| `elanous harness ask <goal.md>` | Same, from a goal document you wrote |
| `elanous harness plan "<sentence>"` | Write the plan (an RFC) without running it |
| `elanous ask "<question>"` | One question, one answer, new session |
| `elanous chat "<message>"` | One message in the current session |
| `elanous agent "<task>"` | One turn with file and shell tools |
| `elanous repl` | Multi-turn session in the shell |
| `elanous` | The terminal UI |

Useful `harness say` / `harness ask` options: `--dry-run` (plan only), `--no-auto-merge` (leave the PR for you), `--target <dir>` (work on another directory), `--child-llm-provider <id> --child-llm-model <id>` (pick the model that writes the code).

## Keeping an eye on it

| Command | What it does |
|---|---|
| `elanous logs --since 30m` | Logs from every surface; filter with `--category`, `--event`, `--grep` |
| `elanous harness worktrees` | Worktrees the harness made, and whether each is safe to remove |
| `elanous harness clean` | Remove finished harness worktrees (dry run unless `--yes`; open PRs are always kept) |
| `elanous ops status` | What the autonomous parts are doing right now |

## Tasks, loops and plugins

| Command | What it does |
|---|---|
| `elanous tasks list` / `elanous tasks approve <id>` | See queued tasks / approve one that came from outside |
| `elanous card list` / `elanous card show <id>` | Tasks as cards, and one card with its sections |
| `elanous directive add "<instruction>" --dry-run` | Preview an instruction as a Linear issue; drop `--dry-run` to create it |
| `elanous loop list` / `status` / `run` | Loop agents — see [Loop agents](loop-agents.md) |
| `elanous plugin add` / `list` / `remove` | Install and manage plugins — see [Plugins](plugins.md) |

## Settings and models

| Command | What it does |
|---|---|
| `elanous config get [path]` / `elanous config set <path> <value>` | Read / change settings (secrets are hidden) |
| `elanous config path` | Which config file is active |
| `elanous provider` | The active model provider, model and sign-in state |
| `elanous tier` | Which model each tier (budget … best) maps to per provider |

## The background service

| Command | What it does |
|---|---|
| `elanous nexus run` | Start the service (web app, chat bots, remote control) |
| `elanous nexus status` / `elanous nexus stop` | Check / stop it |
| `elanous nexus install --launchd` (macOS) · `--systemd-user` (Linux) | Run it at login; API keys are read from the key cache, not written into the service file |
| `elanous nexus build` | Build the web app (from a checkout — see [install](install.md#known-limits)) |
| `elanous nexus restart-needed` | Say whether the running service needs a restart, only a web-app build, or nothing (exit 0 none · 10 build · 11 restart · 2 unknown) |
| `elanous update [--restart]` | Update to the latest release (`--version <v>` for a specific one; from a checkout, reinstall that checkout); restart the service only if it is needed and you passed `--restart`. Same as `self-update`. `elanous update --auto on` updates daily |
