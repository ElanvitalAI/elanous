# External commands

Beyond Bun and git, elanous spawns these. None are needed to boot; each gates
one capability. `elanous doctor` shows which ones this machine has, and
`elanous env profile` describes the environment it detected.

| command | used for |
|---|---|
| `git`, `bun` | everything (required) |
| `gh` | pull requests, harness base selection |
| `rg` (ripgrep) | code search — **the test suite needs it too** |
| `codex` | ACP delegate / harness implement on the codex backend |
| `claude`, `gemini`, `grok` | coding agents elanous drives in a terminal (`agent-mission --backend`) |
| `tailscale` | sharing the web app with your other devices (`nexus pwa share`) |
| `docker` | optional container runtime (for example OpenDesign previews in [Design systems](design.md)) |
| `kubectl` | running harness work on a Kubernetes cluster |
| Chrome or Chromium | browser checks and page capture over the DevTools protocol |
| `tmux` | naming the session when the terminal UI runs inside tmux |
| `curl`, `ssh`, `rsync`, `unzip` | fetching, remote nodes, installers |
| `crontab` | scheduled missions |
| `ffmpeg`, `magick`, `sox`, `tesseract`, `chafa` | media / ad pipeline, OCR, terminal images |
| `python3` | a few skills |
| `open`, `say`, `osascript` | macOS only, and guarded by `process.platform` |

📏 A fresh WSL2 Ubuntu had **none** of `rg`, `gh`, `ffmpeg`, `zsh`, `java`,
`jq`, `codex`, `node` or `npm`. A full test run there produced 47
`Executable not found in $PATH` lines: `rg` ×31, `ffmpeg` ×4, `zsh` ×3,
`grok` ×1 (plus `gh` and `java` failures reported differently).
