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

## For developers — build your own

See [Build a loop agent](build-a-loop-agent.md).
