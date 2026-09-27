---
name: elanous-handoff
description: Hand a task to elanous, the user's local agent orchestrator. Use when the user asks to "give this to elanous", "queue this for later", or to delegate follow-up work (a bug, a refactor, a doc update) instead of doing it now.
---

# Hand a task to elanous

elanous runs on the user's machine and keeps a task queue. The `elanous_task_submit` tool (from the `elanous` MCP server in this plugin) puts one task on that queue. Nothing runs until the owner approves it in elanous.

1. Write the task so someone without this conversation can do it:
   - `title` — one line, what should be done.
   - `description` — why, where (file paths, links), and how to tell it is done.
   - `priority` — `low`, `medium` or `high` (default `medium`).
   - `ref` — a stable id for the item if there is one (issue key, PR URL, note path). Submitting the same `ref` again updates that task instead of adding a second one.
   - `url` — a link back to where it came from, if any.
2. Call `elanous_task_submit` once per task.
3. Tell the user the task id it returned, and that it waits for approval in elanous.

If the tool says the elanous daemon is not running, tell the user to start it with `elanous nexus`, then try again. Do not retry in a loop.
