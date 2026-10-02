# Agent skills and Homebrew tap — ready to publish (EN11 · 2026-10-02)

Files only. Nothing here is published: ClawHub, a GitHub skills tap and a Homebrew tap are outward actions and wait for the owner's approval (checklist EN11 · 0.2.8).

| File | What it is | Where it goes |
|---|---|---|
| `attach-elanous/SKILL.md` | Standalone skill (agentskills.io: `name` · `description` · `license` · `compatibility` · `metadata`, plus ClawHub `summary`). Lets OpenClaw, Hermes, Codex and opencode users hand a task to Elanous through the CLI or connect its MCP server. Three examples. | ClawHub (Hermes lists ClawHub through its source adapters) · or `~/.agents/skills/attach-elanous/` by hand |
| `../homebrew/elanous.rb` | Formula: installs the npm release with bun. Name `elanous` = the CLI; the desktop app takes the cask `elanous-desktop` in the same tap. | `ElanvitalAI/homebrew-tap/Formula/elanous.rb` → `brew install elanvitalai/tap/elanous` |

## Checked on 2026-10-02 (before publishing)

| Check | Result |
|---|---|
| Every command and flag in the skill exists in the released CLI (0.2.7): `harness say` · `--dry-run` · `--no-auto-merge` · `--target` · `mcp serve` · `doctor` · `login openai-codex` | ✅ `elanous <cmd> --help` |
| Docs link in the skill (`using-elanous/harness`) is a published page | ✅ `website/pages.json` |
| License in the skill and formula matches npm | ✅ `npm view elanous license` → Apache-2.0 |
| Formula `url` ⊕ `sha256` = npm 0.2.7 | ✅ `curl … | shasum -a 256` |
| Formula steps outside Homebrew: unpack → `bun install --production` → `bun bin/elanous.mjs --version` with an empty HOME | ✅ rc 0 · prints 0.2.7 (3 postinstalls blocked by bun; the CLI still runs) |
| `brew style` | ✅ apart from the Sorbet/frozen-string cops that apply to Homebrew's own code |
| Real `brew install` ⊕ `brew test` | 🔲 not run here — on the owner's machine `/opt/homebrew/bin` comes before the running Elanous on PATH, so a brew install would shadow it. Run it on a clean machine (step B3). |
| Skill loaded by OpenClaw or Hermes | 🔲 not run — step A3 |

## Publishing (after approval)

### A. ClawHub skill (Hermes follows)
1. Account: a GitHub account at least 14 days old owns the ClawHub publisher (`ElanvitalAI` org or the owner).
2. `clawhub login`
3. Dry run, then publish:
   ```bash
   clawhub skill publish ./integrations/agent-skills/attach-elanous --slug attach-elanous --name "Attach Elanous" \
     --categories development,automation --topics elanous,coding-agent,pull-request --dry-run
   # same without --dry-run
   ```
   New skills start at 1.0.0. They stay hidden until ClawHub's automated security review finishes.
4. Check: `clawhub` search shows `attach-elanous`. In Hermes, `hermes skills` search finds it through the ClawHub source. Load it in one agent and ask «have Elanous add a --json flag»: the agent must run `elanous harness say` with a self-contained sentence.

### B. Homebrew tap
1. Create the public repository `ElanvitalAI/homebrew-tap` (outward · owner approval).
2. Copy `integrations/homebrew/elanous.rb` to `Formula/elanous.rb` and push.
3. On a clean macOS machine (no Elanous installed): `brew install elanvitalai/tap/elanous` → `brew test elanous` → `elanous --version`.
4. Every release: bump `url` and `sha256` together (`curl -sL https://registry.npmjs.org/elanous/-/elanous-<v>.tgz | shasum -a 256`). 0.2.8 is due 10-02 07:15 — bump before the first publish.

### C. After publishing
- Add «Homebrew» and «ClawHub / Hermes» lines to the install section of elanous.ai and the public docs — only after B3 and A4 pass.

Sources: `내부 문서 `RESEARCH-entrances-for-codex-claude-openclaw-hermes-users-2026-10-01`` §3 · https://docs.openclaw.ai/clawhub/publishing (read 2026-10-02).
