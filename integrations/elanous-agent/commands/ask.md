---
description: Ask elanous to work on the user's request, optionally in the background
argument-hint: [--background|--wait] <request>
allowed-tools: Task
---

Use the Task tool to invoke the `elanous:elanous-delegate` subagent exactly once. Pass the user's request **verbatim**; do not rewrite or summarize it. Treat a leading `--background` as detached execution and a leading `--wait` (or no flag) as foreground; strip only that mode flag before handing over the exact request. Tell the delegate which mode was chosen. Show its output unchanged. If no request was provided, ask the user for one instead of starting a task.

Request: $ARGUMENTS
