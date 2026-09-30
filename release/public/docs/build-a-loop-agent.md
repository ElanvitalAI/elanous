# Build a loop agent

This walks through a real, small loop that ships in the repository: **every morning, list open draft pull requests older than three days.** Files: `graphs/examples/stale-draft-digest/`.

## 1. The graph

```yaml
# graphs/examples/stale-draft-digest/stale-draft-digest.yaml
graph_id: stale-draft-digest
version: 1
loop:
  title: Stale draft PR digest
  trigger: { cron: "0 9 * * *" }
entry_node: collect
terminal_nodes: [done, failed]
nodes:
  - { node_id: collect, kind: agent, recipe: 'cmd:collect', max_visits: 1 }
  - { node_id: report,  kind: agent, recipe: 'cmd:report',  max_visits: 1 }
  - { node_id: done,    kind: gate,  max_visits: 1 }
  - { node_id: failed,  kind: gate,  max_visits: 1 }
edges:
  - { from: collect, on: outcome, map: { ok: report, none: done, fail: failed, error: failed } }
  - { from: report,  on: outcome, map: { ok: done, fail: failed, error: failed } }
```

- **Nodes** are steps. `kind` says what sort of step it is (`agent` does work, `gate` checks or ends, `judge` decides, `hitl` waits for a person).
- **Edges** go by outcome. Here `collect` goes to `report` when it found something (`ok`) and straight to `done` when there was nothing (`none`).
- `max_visits` caps how often a step may run in one round, so a loop that goes back to fix something cannot spin forever.

## 2. The recipes — what each step runs

```yaml
# graphs/examples/stale-draft-digest/recipes.yaml
collect:
  command: "bun graphs/examples/stale-draft-digest/digest.ts collect"
  timeout_ms: 60000
report:
  command: "bun graphs/examples/stale-draft-digest/digest.ts report"
  timeout_ms: 30000
```

A recipe is a shell command. If the **last line it prints is a JSON object**, that object is the step's output, and its `outcome` field picks the edge. A later step reads earlier outputs from the file named in `ELANOUS_GRAPH_CONTEXT` (`{ input, outputs }`) — see `digest.ts`.

## 3. Try it

```bash
elanous graph run graphs/examples/stale-draft-digest/stale-draft-digest.yaml --dry-run            # path only
elanous graph run graphs/examples/stale-draft-digest/stale-draft-digest.yaml --input '{"days":3}'  # one real round
```

Every round is saved under the state folder (`graph-runs/stale-draft-digest/`), and every step start and end is logged, so the round shows up in the web app's Live and Trace views.

## 4. Put it on a trigger

The graph's own `loop.trigger` (here `cron: "0 9 * * *"`) is the schedule:

```bash
elanous loop start stale-draft-digest          # preview the crontab change
elanous loop start stale-draft-digest --yes    # apply it
elanous loop stop stale-draft-digest --yes     # remove it again
```

## 5. Going further

- **Decide, don't just run** — a `judge` step can send a round back (for example "the report is empty → collect again") within `max_visits`.
- **Ask a person** — a `hitl` step with a recipe `approval: "<question>"` stops the round until someone approves.
- **Your own step kinds and sharing** — a plugin can add step kinds (`nodes`) and ship whole loops; see [Build a plugin](build-a-plugin.md). Package the loop in a plugin and others install it by name: `elanous plugin add <plugin>@<market>`.
