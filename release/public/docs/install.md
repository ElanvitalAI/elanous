# Install

elanous runs on **Bun** (not Node) on macOS, Linux and WSL2; Windows native PowerShell is experimental.

## One line

```bash
curl -fsSL https://github.com/ElanvitalAI/elanous/releases/latest/download/install.sh | bash
```

The `elanous` package is also on npm (`npm i -g elanous`), but it needs **Bun 1.3.5+** on your PATH — without Bun the first run stops with "bun: No such file". The one-line installer above sets Bun up for you, so it is the simpler path.

Coming from **monad** (0.1.x)? Don't use `monad update` to move — see [Moving from monad](update-and-uninstall.md#moving-from-monad).

The installer:

- downloads the latest release and checks it against `SHA256SUMS` — a mismatch stops the install,
- installs `bun` with its official installer if it is missing, at the version pinned in `.bun-version` (turn this off with `--no-bootstrap-bun`; `ELANOUS_BUN_VERSION=latest` lifts the pin),
- installs into `~/.local/share/elanous` (override with `--prefix PATH` or `ELANOUS_INSTALL_PREFIX`),
- adds `~/.local/share/elanous/bin` to your shell `PATH` (skip with `--no-modify-path`),
- if a command it needs is missing, names **all** of them in one install line (without `sudo` when you are root),
- ends by telling you the next step based on what it found (for example, whether you are logged in yet).

Open a new shell, then check:

```bash
elanous --version     # prints the version and the commit it was built from
elanous doctor        # what this machine still needs — a report, not a gate
```

Pin a version with `ELANOUS_VERSION` (Elanous releases start at 0.2.0):

```bash
curl -fsSL https://github.com/ElanvitalAI/elanous/releases/latest/download/install.sh | ELANOUS_VERSION=0.2.0 bash
```

## Windows (native PowerShell) — experimental

```powershell
irm https://github.com/ElanvitalAI/elanous/releases/latest/download/install.ps1 | iex
elanous --version
```

It installs into `%LOCALAPPDATA%\elanous` (override with `-Prefix PATH` or `ELANOUS_INSTALL_PREFIX`) with the same layout as below — `current` is a directory junction, so no administrator rights are needed — and adds `bin` to your PowerShell profile (skip with `-NoModifyPath`). WSL2 remains the recommended way to run the harness on Windows.

## From a bare Linux machine

A bare image may not even have `curl`, and the one-line installer needs it to download itself.
If you run the installer as **root** on Debian or Ubuntu, it installs any missing `unzip` and `git` itself (one `apt-get update` and `install`; turn this off with `--no-install-deps`).
As a regular user it only tells you what is missing, so install the basics first:

```bash
sudo apt-get update && sudo apt-get install -y curl ca-certificates unzip git
curl -fsSL https://github.com/ElanvitalAI/elanous/releases/latest/download/install.sh | bash
source ~/.bashrc
elanous --version && elanous doctor
```

Then add what the terminal and harness features need (measured on a fresh Debian 12):

```bash
sudo apt-get install -y build-essential ripgrep   # C++ build tools for the terminal (node-pty) · ripgrep
elanous doctor --fix --yes                        # builds node-pty
```

The Codex CLI needs **Node.js 20 or newer** — Debian 12's own `nodejs` package is 18, so install Node from [nodejs.org](https://nodejs.org/en/download) (or your distribution's Node 20+ source) before `npm install -g @openai/codex`.

That is enough to boot. To run the daemon and the harness, let `doctor` fix what it can — the node-pty rebuild, a pinned static `gh` and the Python environment (`python3-venv`, with `--sudo`). It does **not** install Node or the Codex CLI: install Node.js 20+ as above, then `npm install -g @openai/codex`.

```bash
elanous doctor --fix --yes --sudo
```

- ⚠️ Do **not** install `gh` from Debian/Ubuntu apt — those packages (Debian 12: 2.23, Ubuntu 24.04: 2.45) are older than the 2.80 the harness needs. `elanous doctor --fix --yes` fetches a pinned one.
- If terminal features stay dark, run `elanous doctor --fix --yes` again — it rebuilds `node-pty` for the installed version. Re-running the installer on the same version does not.
- Prefer to install by hand? `sudo apt-get install -y build-essential ripgrep`, Node 20+ and `npm install -g @openai/codex` are the equivalent.

## Run the daemon in the background

```bash
elanous nexus install --systemd-user    # Linux: active, enabled, and survives reboots without a login
elanous nexus install --launchd         # macOS
```

The daemon's port answers about 30 seconds after it starts.

## From a checkout

```bash
git clone https://github.com/ElanvitalAI/elanous && cd elanous
bash scripts/install.sh               # same installer, installing this checkout (folder named by commit)
```

## Layout

```
~/.local/share/elanous/
  versions/<version>/            one folder per installed version (older ones are kept)
  current -> versions/…          the active version
  bin/elanous                      the command on your PATH
  install.json                   what is installed, from where, which commit
```

Your settings, logins and logs live in `~/.elanous`; your memory lives in `~/.local/share/elanous/memory` (inside the install folder). The installer never touches either, and the uninstaller removes only what the installer created (`versions/`, `current`, `bin/`, `install.json`) and names everything it keeps.

## Update, roll back, uninstall

```bash
elanous self-update                              # latest release; the previous version stays for rollback
elanous self-update --version 0.2.3              # a specific release
ln -sfn versions/<previous> ~/.local/share/elanous/current      # roll back
curl -fsSL https://github.com/ElanvitalAI/elanous/releases/latest/download/uninstall.sh | bash
```

If you run the background service, restart it after an update — see [troubleshooting](troubleshooting.md#the-service-still-runs-the-old-version).

## Error reports

When Elanous hits an error, it sends a short report to the Elanous team so we can fix it. This is on by default, and the first run prints one line that says so and how to turn it off.

- **Sent:** the error code, the message and stack trace (secrets and your home directory removed, file paths cut to the file name), the Elanous version and commit, where it happened (terminal UI, web app, CLI or daemon), your OS and CPU type, whether the background service was running, and a random install ID that is not derived from your machine or account.
- **Not sent:** your name, email or Telegram user — unless you turn that on yourself (`elanous config set errorReports.identity true` plus `errorReports.email`).
- **How often:** the same error at most once an hour. If sending fails, one copy is kept and sent again the next time Elanous starts, at most once a day.
- **Kept:** 30 days, then deleted automatically.
- **Turn off:** `elanous config set errorReports.enabled false`

## Known limits

- On Linux, `node-pty` has no prebuilt binary; elanous falls back to Bun's own PTY and nothing breaks. `elanous doctor --fix --yes` rebuilds it when a C++ toolchain is present.
- If `bun install` silently skips an optional dependency on Linux, check whether `TMPDIR` and Bun's cache are on different filesystems — `elanous doctor` reports it as `bun-tmpdir`, and `elanous doctor --fix --yes` adds the fix to your shell startup file. See [troubleshooting](troubleshooting.md#bun-skips-an-optional-dependency).
- If the service log says the web app is not built, set `ELANOUS_PWA_STATIC_DIR` to a built web app folder (`apps/pwa/out` in a checkout, after `elanous nexus build`).

Next: [quickstart](quickstart.md).
