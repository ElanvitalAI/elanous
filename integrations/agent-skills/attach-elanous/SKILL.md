---
name: attach-elanous
description: Hand a coding task to Elanous, a local agent that takes one sentence through plan, implementation, tests, review and a pull request. Use when the user wants a change carried all the way to a PR ("have Elanous do it", "run it end to end", "open a PR for this"), or wants to connect Elanous to this agent as an MCP server.
summary: Hand one coding task to Elanous, a local agent that carries it through plan, code, tests, review and a pull request.
license: Apache-2.0
compatibility: Requires the `elanous` CLI on PATH (macOS, Linux, Windows) and a git repository. Uses the user's own model subscriptions.
metadata:
  homepage: https://elanous.ai
  docs: https://docs.elanous.ai/using-elanous/harness
---

# Attach Elanous

Elanous runs on the user's machine. Given one sentence, it writes a goal, works in an isolated git worktree, runs the tests that the change touches, reviews the result, and opens a pull request. Its decisions are recorded on the user's machine.

You are handing work over here. Do not also do the same change yourself.

## 1. Check that Elanous is there

```bash
elanous --version
```

If the command is missing, tell the user how to install it and stop:

```bash
curl -fsSL https://github.com/ElanvitalAI/elanous/releases/latest/download/install.sh | bash
```

First-time setup, run by the user (they sign in to their own accounts):

```bash
elanous doctor
elanous login openai-codex      # or another provider the user already pays for
```

## 2. Hand over one task

Run from inside the user's repository:

```bash
elanous harness say "<one sentence: what to change, and how to tell it is done>"
```

Write the sentence so that someone without this conversation can do it. Name the files or folders when you know them, for example:

```bash
elanous harness say "add a --json flag to the status command; the existing status tests must still pass"
```

Useful options:

| Option | Use it when |
|---|---|
| `--dry-run` | The user wants to see the plan before anything runs |
| `--no-auto-merge` | The user wants to review and merge the PR themselves |
| `--target <dir>` | The work belongs to a different directory than the current one |

The command prints a run id. Report it to the user together with what was asked. Elanous continues on its own and reports the result, usually as a pull request.

## 3. Connect Elanous as an MCP server (optional)

Elanous ships a stdio MCP server. Register it in the agent's MCP configuration:

```json
{
  "mcpServers": {
    "elanous": { "command": "elanous", "args": ["mcp", "serve"] }
  }
}
```

After a restart, list the server's tools and use them instead of the CLI when they cover the request.

## Examples

1. Preview first, then run:

   ```bash
   elanous harness say --dry-run "add a --json flag to the status command; the existing status tests must still pass"
   elanous harness say "add a --json flag to the status command; the existing status tests must still pass"
   ```

2. Leave the merge to the user:

   ```bash
   elanous harness say --no-auto-merge "fix the date parsing in src/report.ts so that 2026-10-02 is not read as UTC midnight; add a test"
   ```

3. Connect Elanous to this agent once, then use its tools:

   ```json
   { "mcpServers": { "elanous": { "command": "elanous", "args": ["mcp", "serve"] } } }
   ```

## What to tell the user

- Elanous decides and acts on its own inside an isolated worktree. Whether the PR is merged automatically follows the user's setting — `--no-auto-merge` leaves it for review.
- It uses the user's existing subscriptions (for example a ChatGPT plan through Codex). It does not need a new API key for that path.
- If a run stops, ask the user to look at the run in Elanous; do not retry the same sentence in a loop.
