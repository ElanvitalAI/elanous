# Drive elanous from your coding agent

A coding agent that speaks MCP can drive elanous — the steps below use Claude Code and Codex as examples. Once connected, the agent can check what elanous is running, read its logs, and hand it a change to build.

This page walks through the loop: connect, observe, and launch a goal. Every command below was run end to end, first with Claude Code and then with Codex, against a throwaway elanous setup.

## What you get

| From your agent | MCP tool | What it does |
|---|---|---|
| "What is elanous running?" | `ops_status` | Snapshot or health check of missions, tasks, loops and schedules (read-only) |
| "Why did that fail?" | `logs_query` | Recent logs from every surface, filtered by level, category or time window (read-only) |
| "Build this for me." | `SelfImplement` | Starts the harness: goal → isolated worktree → tests → review → draft pull request |
| Context about the machine | `ContextBootstrap`, `ContextSessionsList`, `ContextPtysList` | Workspace, sessions and terminals elanous can see |

The server exposes more tools (terminals, tasks, skills). Ask your agent to list them, or use `ContextToolsList`.

## 1. Register the server

elanous ships a stdio MCP server: `elanous mcp serve`.

**Claude Code**

```bash
claude mcp add elanous -- elanous mcp serve
```

**Codex** — add to `~/.codex/config.toml`:

```toml
[mcp_servers.elanous]
command = "elanous"
args = ["mcp", "serve"]
# Let these elanous tools run without a prompt in `codex exec`.
default_tools_approval_mode = "approve"
enabled_tools = ["ops_status", "logs_query", "SelfImplement"]
```

`codex exec` runs with approvals set to "never". Without `default_tools_approval_mode`, every elanous call fails as "approval required". Keep `enabled_tools` short, so only the tools you mean to allow run unattended.

## 2. Try it safely first

Point the server at a throwaway config and state directory, and turn on observe-only. In observe-only mode, `SelfImplement` records the request and returns, without creating a worktree or a pull request.

```bash
mkdir -p /tmp/elanous-try/cfg /tmp/elanous-try/state
export ELANOUS_STATE_DIR=/tmp/elanous-try/state
elanous --config-dir /tmp/elanous-try/cfg where --json      # "kind" must not be your real setup
elanous --config-dir /tmp/elanous-try/cfg config set tools.selfImplement.observeOnly true
```

Then pass that setup to the agent for one run, without changing its saved configuration.

**Claude Code** — a one-off MCP config file (`try-mcp.json`):

```json
{
  "mcpServers": {
    "elanous": {
      "type": "stdio",
      "command": "elanous",
      "args": ["--config-dir", "/tmp/elanous-try/cfg", "mcp", "serve"],
      "env": { "ELANOUS_STATE_DIR": "/tmp/elanous-try/state" }
    }
  }
}
```

```bash
claude -p "Call ops_status (snapshot), then SelfImplement with feature 'Add a --json flag to a hello command', then logs_query for the last 10 minutes. Report each result." \
  --mcp-config try-mcp.json --strict-mcp-config \
  --allowedTools "mcp__elanous__ops_status,mcp__elanous__SelfImplement,mcp__elanous__logs_query"
```

**Codex** — override the server for this run only with `-c`:

```bash
codex exec --skip-git-repo-check -s read-only \
  -c 'mcp_servers.elanous.command="elanous"' \
  -c 'mcp_servers.elanous.args=["--config-dir","/tmp/elanous-try/cfg","mcp","serve"]' \
  -c 'mcp_servers.elanous.env={ELANOUS_STATE_DIR="/tmp/elanous-try/state"}' \
  -c 'mcp_servers.elanous.default_tools_approval_mode="approve"' \
  -c 'mcp_servers.elanous.enabled_tools=["ops_status","SelfImplement","logs_query"]' \
  "Call ops_status (health), then SelfImplement with feature 'Add a --quiet flag to a hello command', then logs_query for the last 10 minutes. Report each result."
```

What came back in our run:

- `ops_status` answered with a snapshot. Schedule health reflects the machine's real scheduler, even in a throwaway setup.
- `SelfImplement` returned `ok: true, observed: true`: the request was recorded and nothing was built.
- `logs_query` returned 0 entries on the very first call, because no daemon had written logs to the fresh state directory yet. Later calls returned entries.

## 3. Launch a real goal

When you are ready, drop the throwaway flags (use your normal setup) and ask your agent in plain words, for example "use the harness to add a --json flag to the status command". The agent calls `SelfImplement`. elanous writes the goal, builds it in its own git worktree, tests and reviews it, and opens a draft pull request. Your working tree is not touched.

Prefer the terminal? The same harness is one command away: `elanous harness say "<sentence>"` (add `--dry-run` to see the plan first). See [The harness](harness.md).

## 4. Watch it

Ask the agent again, in plain words:

- "Is anything failing?" → `ops_status` with `action: health`
- "What happened in the last 30 minutes?" → `logs_query` with `sinceMinutes`, `level` or `category`

## The other direction: elanous drives the agent

MCP is how your agent drives elanous. ACP is the reverse: elanous starts Claude Code, Codex or Grok as a child agent and drives it. `elanous acp list` shows the backends this build knows; `elanous acp test --backend <id>` sends one prompt as a smoke test.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Codex says the elanous call "required approval" | Set `default_tools_approval_mode = "approve"` and `enabled_tools` for the elanous server |
| `logs_query` returns nothing | The daemon has not written logs to this state directory yet; start it once (`elanous start`) |
| `SelfImplement` returns `observed: true` but nothing happens | Observe-only is on: `elanous config set tools.selfImplement.observeOnly false` |
