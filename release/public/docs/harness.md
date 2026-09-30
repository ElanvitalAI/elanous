# The harness

The harness is how elanous makes a change: you describe it, elanous writes a goal, implements it in an isolated git worktree, runs the tests, reviews the diff unattended, and opens (or merges) a pull request. You are only asked when it cannot decide on its own.

## Pick the entrance

| Where you are | Use |
|---|---|
| A terminal, with one sentence in mind | `elanous harness say "<sentence>"` |
| A terminal, with a goal document already written | `elanous harness ask <goal.md>` |
| You want the plan, not the change | `elanous harness plan "<sentence>"` |
| Inside the TUI | `/harness` |

If unsure: in a terminal use `harness say`; in the TUI use `/harness`.

## From one sentence

```bash
elanous harness say "add a --json flag to the status command"
```

1. elanous turns the sentence into a goal document (situation, complication, question, answer — plus the checks that decide "done").
2. It checks the goal before launching and tells you what it could not verify.
3. A child agent implements the goal in its own worktree, so your working tree is never touched.
4. The change is tested, reviewed, and landed as a pull request.

Try `--dry-run` first to see the launch plan without starting anything:

```bash
elanous harness say --dry-run "add a --json flag to the status command"
```

## From a goal document

Write the goal yourself when the sentence would leave too much to guess:

```bash
elanous harness ask 내부 문서 `add-json-flag`
```

A goal document is Markdown. The parts the harness reads:

```markdown
target paths: src/cli/status.ts · src/cli/status.test.ts

# Add a --json flag to the status command

## Situation
What exists today.

## Complication
What is wrong or missing, with the evidence you have.

## Question
What must be answered.

## Answer
decision signal: condition = run `bun test src/cli/status.test.ts`; observation = the new --json case; expected = it passes, and fails if the flag is removed.
```

- `target paths:` must be the **first non-empty line**. It names the files the change may touch.
- A `decision signal:` needs all three parts — `condition`, `observation`, `expected` — or it is not counted. Write one that passes on a correct change **and fails on a wrong one**.
- ⬜ Known limit: invariant and boundary markers are currently recognised only with their Korean labels (`불변식:` and `경계:`). English labels for them are planned.

## Options you will use

These apply to both `harness say` and `harness ask`:

| Option | What it does |
|---|---|
| `--dry-run` | Print the launch plan; change nothing |
| `--no-auto-merge` | Stop at the pull request and leave the merge to you |
| `--base <branch>` | Branch to start from |
| `--goal-type <type>` | `implement`, `research`, `document` or `operate` |
| `--child-llm-provider <id>` ⊕ `--child-llm-model <id>` | Choose the model that writes the code (set both) |
| `--child-llm-effort <level>` | Reasoning effort for that model (`minimal` … `max`); refused if the model does not support it |
| `--json` | Structured output |

`harness plan` also takes `--role-llm <role>=<provider>[/<tier>]` (repeatable) to choose a model per role — for example `implement=grok/best` or `review=anthropic`.

## Watching and cleaning up

| Command | What it shows or does |
|---|---|
| `elanous harness worktrees` | Every worktree the harness made, and whether it is safe to remove |
| `elanous harness clean` | Remove finished harness worktrees — a dry run unless you add `--yes`; worktrees with an open pull request are always kept |
| `elanous harness stop <runId>` | Stop one run — its orchestrator process, and its Kubernetes job if it ran on a cluster |
| `elanous harness processes` | The processes this repository started, grouped by resource use and age (read-only; kills nothing) |
| `elanous self run-ledger` | The observation ledger of a run |
| `elanous logs --space <runId>` | The log of one run |

## Other repositories

⬜ Not verified yet: running the harness on a repository other than elanous itself, end to end. `--dry-run` works in any git repository; a full run there has not been measured. Until it is, expect rough edges and use `--no-auto-merge`.

See also: [Commands you will use](commands.md) · [Troubleshooting](troubleshooting.md).
