# Agent skills and Homebrew tap — drafts (EN11 · 2026-10-01)

Files only. Nothing here is published yet: publishing to ClawHub, a GitHub skills tap or a Homebrew tap is an outward action and waits for the owner's approval.

| File | What it is | Where it would go |
|---|---|---|
| `attach-elanous/SKILL.md` | A standalone skill (agentskills.io format: `name` · `description` · optional `license` · `compatibility` · `metadata`) that lets OpenClaw, Hermes, Codex and opencode users hand a task to Elanous through the CLI or connect its MCP server. It does not depend on files bundled with our Claude Code plugin. | ClawHub `clawhub skill publish ./attach-elanous` (Hermes picks ClawHub up through its source adapters) · or `~/.agents/skills/attach-elanous/` by hand |
| `../homebrew/elanous.rb` | A formula that installs the npm release with bun | `ElanvitalAI/homebrew-tap/Formula/elanous.rb` → `brew install elanvitalai/tap/elanous` |

## Before publishing

1. Approval for the outward step (ClawHub account and publish · tap repository).
2. Formula: run `brew install --build-from-source ./elanous.rb` and `brew test elanous` on a clean machine. Not measured yet — the npm package declares `bun >= 1.3.5`, and installing it on a machine without bun is a separate open check (R6).
3. Skill: load it in at least one of OpenClaw or Hermes and confirm the agent calls `elanous harness say` with a self-contained sentence.

Source for formats and publish paths: `내부 문서 `RESEARCH-entrances-for-codex-claude-openclaw-hermes-users-2026-10-01`` §1c · §3.
