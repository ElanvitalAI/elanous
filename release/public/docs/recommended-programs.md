# Recommended programs and services

elanous runs on very little: **Bun, git and one way to reach a language
model**. Everything else on this page is optional — but each one opens a
part of elanous that is otherwise closed or runs in a weaker form. This page
says what each program or service unlocks, what happens without it, and how
to set it up on macOS, Linux and Windows (WSL2).

`elanous doctor` checks most of them on your machine and names what is still
locked. See [Doctor](doctor.md).

:::tip Where keys go
A service key is read from its environment variable, or from a file in
`~/.cache/` named after the variable in lower case — for example
`~/.cache/firecrawl_api_key` for `FIRECRAWL_API_KEY`. The file needs only the
key on one line. Keep it readable by you only (`chmod 600`).
:::

## At a glance

| | What it unlocks | Without it |
|---|---|---|
| **Bun**, **git** | elanous itself | elanous does not start |
| **A model subscription** (ChatGPT via Codex, or another provider) | Chat, the harness, every agent | Nothing thinks — there is no free model floor |
| **GitHub CLI** (`gh`) | Pull requests, landing changes | The harness still works on a branch, but cannot open or merge PRs |
| **ripgrep**, **Node.js** | Fast code search; the Codex CLI | Weaker search; no Codex backend |
| **Grok** | A second model, web search, a coding agent backend | Fewer models and agents to switch to |
| **Firecrawl**, **Tavily** | Full-page crawl and better web search | A free search (DuckDuckGo + Jina) takes over |
| **Chrome** (or Chromium/Edge) | Agents that look at and use web pages | Browser tools say "Chrome unavailable" |
| **Aside browser** | A browser agent backend and page checks through Aside | The default Chrome path is used |
| **Claude Code** | A coding agent backend on your Claude subscription | Other backends |
| **Tailscale** | The web app on your phone, tablet and other computers | The web app works on this machine only |
| **Obsidian** | The Vault menu and saved notes | Any Markdown folder still works |
| **Telegram / Discord bots** | Talking to elanous and getting alerts on your phone | Terminal and web app only |
| **Linear** | Issues arriving as tasks | Tasks come from Telegram, the web app and the terminal |
| **ElevenLabs** | High-quality voice | Free voices (edge-tts, macOS `say`) |
| **ffmpeg**, **ImageMagick** | Video, audio and image steps | Those steps are skipped or fail |

## The base

### Bun and git — required

The installer fetches Bun for you. git must already be there.

| | Setup |
|---|---|
| macOS | `xcode-select --install` gives you git. |
| Linux | `sudo apt-get install -y git unzip` — Bun's own installer fails without `unzip`. |
| Windows | Use WSL2 and follow the Linux line. Native PowerShell is experimental — see [Install](install.md#windows-native-powershell--experimental). |

### A model — required

elanous needs at least one way to reach a language model. The simplest is a
**ChatGPT subscription through the Codex CLI**:

```bash
npm install -g @openai/codex    # needs Node.js
elanous login openai-codex
```

Other providers (Grok, Anthropic, Gemini, OpenRouter) and how to mix them
are in [Providers](providers.md) and [Codex subscription](codex-subscription.md).

### GitHub CLI (`gh`) — strongly recommended

The harness uses `gh` to open, update and merge pull requests. It needs
version 2.80 or later.

| | Setup |
|---|---|
| macOS | `brew install gh` |
| Linux | `elanous doctor --fix --yes` installs a current one. Do not use the distribution's `apt` package — it is too old. |
| Windows (WSL2) | Same as Linux. |

Then sign in once: `gh auth login`.

### ripgrep and Node.js — recommended

- **ripgrep** (`rg`) makes code search fast for agents. macOS
  `brew install ripgrep` · Debian/Ubuntu `sudo apt-get install -y ripgrep` ·
  Fedora `sudo dnf install ripgrep`.
- **Node.js** is needed only because the Codex CLI runs on it. macOS
  `brew install node` · Debian/Ubuntu `sudo apt-get install -y nodejs npm`.

### Build tools and Python — optional

- A C/C++ compiler and `make` let elanous build its native terminal module.
  On Linux it falls back to Bun's built-in terminal support without them.
  macOS `xcode-select --install` · Debian/Ubuntu
  `sudo apt-get install -y build-essential` · Fedora
  `sudo dnf install gcc-c++ make` — then `elanous doctor --fix --yes`.
- Python is used by a few skills. `elanous python setup --yes` prepares an
  environment for them.

## Seeing the world — search, crawl and the browser

These are the programs and services elanous uses to read the web. None is
required: a free search tier (DuckDuckGo for search, Jina Reader for pages)
always works without a key. The paid services give fuller pages and better
results.

### Firecrawl — full pages and whole sites

Crawls and scrapes pages (including pages that need JavaScript), maps whole
sites, and searches developer documentation. Also used for web search.

- Key: `FIRECRAWL_API_KEY` (or `~/.cache/firecrawl_api_key`).
- Without it: search and page reading fall back to the free tier.

### Tavily — web search

A search engine built for agents.

- Key: `TAVILY_API_KEY` (or `~/.cache/tavily_api_key`).
- The crawl skill uses it as soon as the key is there. The chat's built-in
  web search uses it only after
  `elanous config set webSearch.tavily.enabled true`.
- Without it: the free tier.

### Jina — page reader

Works **without a key**. A key (`JINA_API_KEY`) only raises the rate limit.

### Grok (xAI) — a model, a search engine and an agent

Grok does three jobs in elanous: another model for chat and the harness, a
web-search provider that also covers X and Reddit, and a coding agent
backend (`elanous agent-mission mission --backend grok`).

- Either a key — `XAI_API_KEY` (or `~/.cache/xai_api_key`) — or the `grok`
  CLI signed in to your xAI account.
- Without it: other models and backends; X and Reddit coverage in search is
  thinner.

### Apify — bulk posts from X

Collects many posts at once for analysis. Key: `APIFY_TOKEN`. There is no
free replacement for this one job.

### Chrome, Chromium or Edge — agents that use web pages

Agents use a real browser through the Chrome DevTools Protocol to open pages,
read what is on screen and click through them. The web app's self-checks use
it too.

| | What elanous finds |
|---|---|
| macOS | `/Applications/Google Chrome.app` |
| Linux | `google-chrome`, `chromium` or the snap package |
| Windows (WSL2) | Chrome or Edge **installed on Windows** — no Linux browser needed |

Point elanous at another build with `ELANOUS_CHROME_BIN`. Browsers such as
Arc, Dia or Aside can be driven the same way while they are open, but not
started by elanous.

### Aside browser — a browser agent

With the Aside browser's command-line tool (`aside`) on your `PATH`, elanous can hand a whole task to Aside
(`elanous agent-mission mission --backend aside`) and check pages through an
Aside session. Without it, the Chrome path above is used.

## Agents you can hand work to

`elanous agent-mission` runs another coding agent in a terminal that
elanous watches and you can open from the web app
([Terminal](pwa-terminal.md)). Each backend uses **your own subscription**
for that tool — elanous removes API keys from its environment so a
subscription is not silently billed as API use.

| Backend | Program to install and sign in |
|---|---|
| `codex` (default) | Codex CLI — `npm install -g @openai/codex`, then `codex login` |
| `claude` | Claude Code — install it and sign in with your Claude account |
| `grok` | The `grok` CLI from xAI — `grok login` |
| `gemini` | Google's Antigravity CLI (`agy`) — sign in once by hand |
| `aside` | The Aside browser CLI (`aside`) |

## Reaching elanous from anywhere

### Tailscale — the web app across your devices

Tailscale connects your own computers and phones over a private network. With
the web app shared from an always-on Elanous host, you can open the same
workspace from a phone or tablet away from home, or from another computer on
your tailnet. A headset or glasses can use it too if they have a browser that
can open the web app. This is useful for checking work and reaching the host's
web app remotely; it does not install Elanous on each device or make the host
redundant.

**Where this connects:** This sharing setup provides a remote-access path
to the web app. The `pwa share enable` step does not add content to the
absorption loop, adaptive grounding, daily external trend watching or
marketing; those are separate workflows.

Set it up in this order:

1. Install Tailscale on the Elanous host and each device from
   [tailscale.com/download](https://tailscale.com/download) — the macOS app
   bundle or `brew install tailscale` both work. elanous looks for the CLI
   in that order: the macOS app bundle first
   (`/Applications/Tailscale.app/Contents/MacOS/Tailscale`), then
   `/opt/homebrew/bin` (Homebrew), then your `PATH`.
2. Sign in on each device and join the host's tailnet. Keep Tailscale
   running on the host and confirm it is connected.
3. If another person will use their own account, invite them to the tailnet
   from the Tailscale admin console → **Users** → **Invite external users**:
   by email, or by generating and sharing an invite link. The invited person
   opens the link, signs in with their own account, and the devices they
   connect join your tailnet. Inviting needs an Owner, Admin or IT admin
   role; see
   [Tailscale's invite guide](https://tailscale.com/docs/features/sharing/how-to/invite-any-user)
   for the current procedure.
4. On the host, enable sharing for the web app:

   ```bash
   elanous nexus pwa share enable
   ```

5. Open the shared URL from a browser on a signed-in phone, tablet or other
   device. See [The web app](pwa.md#use-it-from-another-device).

Check the host's Tailscale connection and its MagicDNS name with this
read-only command:

```bash
tailscale status --json
```

The host should report `BackendState` as `Running`; `Self.DNSName` identifies
its MagicDNS name. Check the active Serve configuration independently with:

```bash
tailscale serve status --json
```

`elanous nexus pwa share enable` forwards the Nexus web app through Tailscale
Serve's TLS-terminated TCP mode on the daemon's port, mounted under
`/app/showroom/`. A successful command prints the share URL with your
tailnet's MagicDNS name for the host; use that exact URL on another device
in the same tailnet. The port is part of the URL. In the Serve
status JSON, find `TCP["<port>"]` using the port printed in that URL; its
`TCPForward` should target `localhost:<port>` and `TerminateTLS` should name
the host. If sharing fails, confirm that Tailscale is running and that the
Nexus daemon has a known port, then retry the command. These status checks do
not by themselves prove another device can open the app.

One macOS quirk to know when scripting these checks: the app-bundle binary
behaves as a GUI app when its environment is empty — for example when a
daemon (with no `TERM`) runs the check — prints "The Tailscale GUI failed to
start", and exits 0 with no JSON, so a status check reads as failure while
Tailscale itself is fine. Set `TAILSCALE_BE_CLI=1` in the environment you
give the CLI to pin command-line behavior; elanous does this for its own
checks (measured 2026-09-27).

Tailscale is optional: without it, the web app remains available on the host
but is not shared through this tailnet path. The documented benefit here is
remote access to the web app; no increase in automation or host availability
has been measured for this guide.

### Telegram and Discord

Talk to elanous and receive alerts from your phone.

```bash
elanous onboarding telegram    # asks for the bot token from @BotFather
elanous onboarding discord
```

You can also connect both from the web app's Settings. See
[Telegram](telegram.md) and [Discord](discord.md).

### Linear

Issues in Linear arrive as elanous tasks. See
[Tasks and intake](tasks-and-intake.md).

## Notes, voice and media

### Obsidian

The web app's **Vault** menu reads and edits an Obsidian vault, and saved
summaries land there. Any folder of Markdown files works; Obsidian itself
only makes browsing nicer. Choose the folder with
`elanous onboarding obsidian` or in the web app's Settings. See
[Vault](pwa-vault.md).

### Voice

| | What it gives | Setup |
|---|---|---|
| ElevenLabs | Natural speech and streaming speech-to-text | `ELEVENLABS_API_KEY` |
| edge-tts | Free speech | `pip install edge-tts`, and `sox` |
| macOS `say` | Free speech, macOS only | built in |

Without ElevenLabs, elanous uses edge-tts and then `say` — whichever is
actually installed (edge-tts counts only when both `edge-tts` and `sox` are
found). On Linux there is no `say`, so install edge-tts and `sox` if you want
speech without a paid key.

### Video, audio, images and text in pictures

| Program | Used for | Setup |
|---|---|---|
| ffmpeg | Video and audio steps | macOS `brew install ffmpeg` · Linux `sudo apt-get install -y ffmpeg` |
| ImageMagick (`magick`) | Image steps | macOS `brew install imagemagick` · Linux `sudo apt-get install -y imagemagick` |
| sox | Audio conversion (and edge-tts) | macOS `brew install sox` · Linux `sudo apt-get install -y sox` |
| Upstage | Reading text from images and documents | `UPSTAGE_API_KEY`; without it, a vision model reads them |
| Supadata | YouTube transcripts | `SUPADATA_API_KEY` |

## Check what you have

```bash
elanous doctor
```

prints every key it found (never the value), every program it looked for,
what you can and cannot do yet, and how to fix each gap.
`elanous doctor --fix --yes` installs what it safely can.
