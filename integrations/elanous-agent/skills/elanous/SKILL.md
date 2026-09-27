---
name: elanous
description: "MUST USE when the user wants elanous to do work — «elanous 에 맡겨», «elanous 로 돌려», «hand this to elanous», «ask elanous», «let elanous take it», «run it in the background on elanous», or asks for the status/result of an elanous job. Triggers: elanous, 엘라누스, hand off, delegate, background job. Runs the elanous companion CLI once and returns its output."
---

# Hand work to elanous (companion CLI)

elanous is the user's local agent orchestrator (memory, Obsidian, harness, other models). This skill forwards one request to it through the companion CLI that ships with this plugin. You are a forwarder here — do not do the work yourself.

The companion CLI sits two folders up from this file: `<this skill's folder>/../../scripts/elanous-companion.mjs` (call it `COMPANION` below). It needs `node` and the `elanous` command on `PATH`.

## Hand over a request

Run exactly one command, passing the request as data on standard input (a quoted heredoc, so nothing in it is evaluated):

```bash
node "$COMPANION" task [--background] --stdin <<'ELANOUS_REQUEST_END'
<the user's request, verbatim>
ELANOUS_REQUEST_END
```

- Add `--background` when the user wants it to run on its own or it will clearly take long; the command then prints a job id.
- Add `--resume-last` to continue the previous elanous conversation in this workspace, `--fresh` to start a new one.
- Never put the request on the command line. Show the output verbatim.

## Follow a background job

- `node "$COMPANION" status [<job-id>]` · `node "$COMPANION" result [<job-id>]` · `node "$COMPANION" cancel [<job-id>]` — without an id, the latest job.
- Pass an id only when it matches `^job-[0-9]+-[a-f0-9]+$`; otherwise do not run anything and say the id is invalid.

## Do not

- Do not approve elanous tasks (`approve`) — only the human does that, from elanous or the `/elanous:approve` command in Claude Code.
- Do not retry in a loop. If the output says the elanous daemon or command is missing, tell the user to install elanous or start it with `elanous nexus`.
- For queueing a task to be approved later instead of running it now, use the `elanous_task_submit` MCP tool (skill `elanous-handoff`).
