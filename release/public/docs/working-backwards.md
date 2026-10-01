# Working backwards

Start from the result you want, then let the harness build toward it. Writing the finished result first is the fastest way to find what is still unclear — before any code is written.

## 1. Write the result as if it were done

Write three or four sentences, as if you were announcing the change:

```markdown
Status now answers in JSON. Anyone scripting against elanous can run
`elanous status --json` and read the same fields they see on screen,
without parsing text. The plain output does not change.
```

If a sentence is hard to write, that is the part you have not decided yet. Decide it now, not during review.

## 2. Turn it into a goal document

Each sentence becomes part of a [goal document](harness.md#from-a-goal-document): the files it may touch, the situation today, what is missing, and a **decision signal** — the check that proves the result is real.

```markdown
target paths: src/cli/status.ts · src/cli/status.test.ts

# Status answers in JSON

## Situation
`elanous status` prints text only.

## Complication
Scripts have to parse the text, and they break when the wording changes.

## Question
(empty — the complication already says it)

## Answer
decision signal: condition = run `bun test src/cli/status.test.ts`; observation = the new --json case; expected = it passes, and fails if the flag is removed.
```

The decision signal is your announcement turned into a test: it passes on a correct change and fails on a wrong one.

## 3. Read the plan before anything runs

```bash
elanous harness plan "status answers in JSON for scripts"
```

`harness plan` writes the plan and stops. Compare it with your paragraph from step 1 — if the plan is solving a different problem, fix the goal, not the code.

## 4. Launch

```bash
elanous harness ask 내부 문서 `status-json`
```

Add `--no-auto-merge` if you want to stop at the pull request and review it yourself.

## 5. Check the result against the paragraph

When the change lands, read your paragraph from step 1 again and try each sentence yourself. Anything that is not true yet becomes the next goal.

See [The harness](harness.md) for every entrance and option.
