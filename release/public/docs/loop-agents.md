# Loop agents

A **loop agent** is a piece of work elanous repeats on its own: every morning, when something arrives, or after every merge. Each loop is three things:

| Part | What it is |
|---|---|
| **Graph** | The shape of one round — steps, checks and where to go when a step succeeds or fails. See [Graph engineering](graph-engineering.md). |
| **Trigger** | When a round starts — a schedule (cron), an event (a new request, a webhook), or you. |
| **Lifecycle** | Each round is saved as it walks, so a stopped round can resume; a failed round tells you where it stopped and why. |

elanous ships an example loop, `stale-draft-digest` (every morning, list open draft pull requests older than a few days). The loops elanous uses to build itself (daily intake, self-healing, release) are in the same folder, but they need that project's own setup and are not meant to run on your machine.

## For everyone — see and run loops

Loops are found in the `graphs/` folder of the directory you run these commands from. With the one-line installer that folder is inside the installed copy, so go there first (in a checkout, stay in the checkout):

```bash
cd ~/.local/share/elanous/current/node_modules/elanous   # installed copy; skip in a checkout
```

Run elsewhere, `loop list` prints `[]` and `graph run graphs/…` cannot find the file.

```bash
elanous graph run graphs/examples/stale-draft-digest/stale-draft-digest.yaml --dry-run   # walk the steps without running anything
elanous schedule list                                          # what runs on a schedule
elanous schedule disable <id>                                  # pause a scheduled loop (reversible)
```

Every loop in one list:

```bash
elanous loop list                        # each loop: trigger (cron), enabled or not, last run, next run
elanous loop status stale-draft-digest   # one loop with its recent runs
elanous loop run stale-draft-digest --dry-run   # walk the steps without running anything
elanous loop start stale-draft-digest    # preview the schedule change · add --yes to apply it
elanous loop stop stale-draft-digest --yes      # remove the schedule
```

`start` and `stop` only preview until you add `--yes`.

## For owners — the steward

The **steward** is elanous's own task loop. What you ask for becomes a task (a Linear issue), and the steward decides, for each task, whether it is already done, which tool should do it (a shell line, research, a harness run, a coding agent), what it depends on, and whether it needs you.

It only asks you about money, publishing, security and anything that cannot be undone. The first version only records its decisions so you can compare them with your own before it acts.

*Status:* in progress (see the release notes).

## For developers — build your own

See [Build a loop agent](build-a-loop-agent.md).
