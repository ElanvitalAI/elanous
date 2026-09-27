# elanous-agent plugin

Lets Claude Code, Codex and Grok hand a task to a local elanous daemon.

- MCP server `elanous` → `elanous mcp serve` (needs the `elanous` command on `PATH`).
- Tool `elanous_task_submit` → `POST /v1/tasks` on the daemon of the current elanous universe, as provider `agent-plugin` and ref `<client name>:<your ref>`. The task waits for approval (`tox.external.autoRun` can pre-approve).
- Skill `elanous-handoff` tells the agent when and how to queue an approval-gated MCP task.
- Claude Code slash commands call the dependency-free Node companion CLI, independently of MCP:
  - `/elanous:ask [--background|--wait] <request>` delegates a foreground agent turn (default), or starts a detached job and returns its id. `/elanous:ask --wait` waits for the reply.
  - `/elanous:status [job-id] [--json]` shows job status (default: last job in this workspace).
  - `/elanous:result [job-id] [--json]` returns a completed reply or the current job status.
  - `/elanous:cancel [job-id]` stops a detached job and its agent child.
  - `/elanous:approve <task-id>` is human-invoked only; it approves an external daemon task using the local `acp-token`.
- The `elanous-delegate` subagent hands blocked or long investigations to elanous without flooding the main context. It does not handle simple requests.
- Requires Node and `elanous` on `PATH` (or `ELANOUS_BIN`). Job state is stored in `${CLAUDE_PLUGIN_DATA:-$HOME/.cache/elanous-companion}/state/<workspace-sha256-prefix>/`; the tool working directory is `CLAUDE_PROJECT_DIR` or the current directory. The companion passes `--tool-cwd` and retries with the project as process cwd only when an older agent CLI rejects that exact option. `--resume-last` continues the last session in that workspace; `--fresh` forces a new session. SessionEnd removes finished jobs for its Claude session, leaving running jobs alive.

Manifests: `.claude-plugin/plugin.json` (Claude Code; Grok reads the same) · `.codex-plugin/plugin.json` (Codex).

Try it locally:

```bash
claude --plugin-dir integrations/elanous-agent          # Claude Code, this session only; then /elanous:ask --wait hello
claude plugin validate integrations/elanous-agent
grok plugin validate integrations/elanous-agent
grok plugin install ./integrations/elanous-agent --trust
```
