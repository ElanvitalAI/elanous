# Configuration

## Where things live

| What | Where |
|---|---|
| The program | `~/.local/share/elanous` (see [install](install.md#layout)) |
| Settings | `elanous config path` prints the active file |
| Sign-ins, logs, sessions, worktree state | `~/.elanous` |
| API keys | the key cache: `~/.cache/<variable name in lower case>`, e.g. `~/.cache/xai_api_key` |

Nothing in `~/.elanous` or the key cache is touched by installing or upgrading.

## Changing settings

```bash
elanous config get                         # everything (secrets redacted)
elanous config get llm.provider            # one value, by dotted path
elanous config set llm.provider openai-codex
elanous config unset llm.model
```

Settings are re-read when the file changes, so most changes apply to a running service without a restart.

## API keys

elanous reads a key from the key cache first and from the environment second. The cache is what the background service uses, because a service started at login does not see your shell's environment.

To add a key without it appearing on screen:

```bash
umask 177 && printf '%s' "$KEY" > ~/.cache/openrouter_api_key    # file mode 600
```

or, from a checkout, `bash scripts/add-api-key.sh OPENROUTER_API_KEY`. `elanous nexus install` (`--launchd` on macOS, `--systemd-user` on Linux) also moves provider keys it finds in your shell into the cache instead of writing them into the service file. To make elanous use the environment and ignore the cache for one run, set `ELANOUS_KEEP_ENV_KEYS=1`.

## Settings you are most likely to change

| Path | Meaning |
|---|---|
| `llm.provider` | Default model provider (`openai-codex`, `grok`, `openrouter`, `anthropic`, `gemini`, `local`, …) |
| `llm.model` | Default model for that provider (leave unset to use the provider's default tier) |
| `llm.fallbackChain` | Where to go when every Codex account is used up: `codex-rotate` (another Codex account) and `grok`; other names are ignored. Default is both — set `["codex-rotate"]` to never fall back to Grok |
| `roleLlm` | A different model per role (planning, review, …) |

See [providers](providers.md) for what each provider needs.

## Environment variables

| Variable | Meaning |
|---|---|
| `ELANOUS_INSTALL_PREFIX` | Install location (installer) |
| `ELANOUS_PWA_STATIC_DIR` | Folder the service serves the web app from |
| `ELANOUS_KEEP_ENV_KEYS=1` | Use environment variables instead of the key cache |
| `--config-dir <dir>` (flag) | Use another config/state root — e.g. to keep a test setup apart |
| `--test` (flag) | Run an isolated test instance rooted in the current git tree |

## `config.json` sections

`~/.elanous/config.json` holds user-level settings beyond env vars.
(Older builds wrote `~/.config/elanous/config.json`; that path still appears in
the source but the live config directory is `~/.elanous` — check yours with
`elanous config path`.)

| Section     | Purpose                                                                  |
|-------------|--------------------------------------------------------------------------|
| `llm`       | provider (`auto`/`openai-codex`/`grok`/`openai`/`anthropic`/`gemini`/`openrouter`/`local`), |
|             | `apiKey`, `model`, `baseUrl` (for local / codex proxies)                 |
| `skills`    | `activeSet` preset + `dirs[]` — scan multiple SKILL.md roots at once     |
| `obsidian`  | `vault` (absolute path)                                                  |
| `telegram`  | `enabled`, `botToken`, `allowedUsers[]`, `homeChannel`                   |
| `onboarding`| `completed`, `completedAt`, `version`                                    |

**Skill dir presets** — `claudecode` (`~/.claude/skills`, default), `opencode`
(`~/.config/opencode/skills`), `codex` (`~/.codex/skills`),
`hermes` (`~/.hermes/skills`), `openclaw` (`~/.openclaw/workspace/skills`),
or `custom` for your own paths. Multiple dirs can be scanned
simultaneously (first-dir-wins on name collisions).

Re-run the wizard any time: `elanous onboarding` (or one step, for example `elanous onboarding telegram`).

