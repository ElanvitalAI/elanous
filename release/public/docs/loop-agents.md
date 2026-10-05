# Loop agents

A **loop agent** is a piece of work elanous repeats on its own: every morning, when something arrives, or after every merge. Each loop is three things:

| Part | What it is |
|---|---|
| **Graph** | The shape of one round — steps, checks and where to go when a step succeeds or fails. See [Graph engineering](graph-engineering.md). |
| **Trigger** | When a round starts — a schedule (cron), an event (a new request, a webhook), or you. |
| **Lifecycle** | Each round is saved as it walks, so a stopped round can resume; a failed round tells you where it stopped and why. |

elanous ships an example loop, `stale-draft-digest` (every morning, list open draft pull requests older than a few days). The loops elanous uses to build itself (daily intake, self-healing, release) are in the same folder, but they need that project's own setup and are not meant to run on your machine.

## For everyone — see and run loops

The `loop` commands find the loops that ship with your installed copy, from any folder:

```bash
elanous loop list                        # each loop: trigger (cron), enabled or not, last run, next run
elanous loop status stale-draft-digest   # one loop with its recent runs
elanous loop run stale-draft-digest --dry-run   # walk the steps without running anything
elanous loop start stale-draft-digest    # preview the schedule change · add --yes to apply it
elanous loop stop stale-draft-digest --yes      # remove the schedule
elanous schedule list                    # everything that runs on a schedule
```

To run a graph file directly, give its path — `elanous graph run <path/to/graph.yaml> --dry-run`; a relative path is read from the folder you are in.

`start` and `stop` only preview until you add `--yes`.

## For owners — the steward

The **steward** is elanous's own task loop. What you ask for becomes a task (a Linear issue), and the steward decides, for each task, whether it is already done, which tool should do it (a shell line, research, a harness run, a coding agent), what it depends on, and whether it needs you.

It only asks you about money, publishing, security and anything that cannot be undone. The first version only records its decisions so you can compare them with your own before it acts.

```bash
elanous directive add "Add a Usage section to the README" --dry-run   # preview the task; drop --dry-run to create the Linear issue
elanous card list                        # tasks as cards
elanous card show <id>                   # one card and its sections
elanous loop start steward               # preview the schedule (every 15 minutes, 08:00-23:00, and on new directives) · add --yes to apply
```

The steward needs a Linear connection and is off until you start it.

The **landing-and-healing loop** (`landing-heal`) watches the harness's own pull requests for review findings that must be fixed and for checks that are due after a merge. It is off by default too — `elanous loop status landing-heal` shows its schedule.

## For operators — the orchestrator

When work crosses loops, these layers have different jobs:

| Layer | Job |
|---|---|
| Seat loops | Pick up queued work for their area and report progress. |
| Steward | Triage tasks, dependencies and decisions that need a person. |
| Orchestrator | Turn requests into cards and release work, choose an order, hand off eligible work and reconcile the results. |

A work request becomes a card, then a work cell, then a proposed release placement before handoff. The orchestrator graph names the path **intake → split → place → delegate → reconcile → report**: collect open request cards, propose cells, place eligible cells on a release, queue a request for the relevant seat loop, check progress, and report the outcome. Placement and handoff depend on eligible work and available integrations; a proposal is not a completed launch.

Set `loops.orchestrator.mode` to `shadow` (the default) to record proposals and would-be handoffs without placing work or sending requests. Set it to `live` to place eligible work and actually queue requests for seat loops. A queued request is not itself a completed run.

| The orchestrator can do on its own | It must leave to a person |
|---|---|
| Record proposals and outcomes; order work; in live mode, add a request to the seat loop's queue. | Spending money, making external commitments, irreversible publication or security decisions: raise a human decision card rather than acting alone. |

Check the loop and recent activity without starting work:

```bash
elanous loop status orchestrator
elanous loop activity
```

## For developers — build your own

See [Build a loop agent](build-a-loop-agent.md).
