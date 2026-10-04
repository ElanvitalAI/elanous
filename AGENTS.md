# AGENTS.md

Instructions for coding agents (and humans) working in this repository.

## What elanous is

elanous is a self-hosting agent runtime: a CLI, a local daemon, and a harness that
turns a one-line request into a goal document, runs an implementer in an isolated
git worktree, gates it with tests, reviews it, and opens a pull request.

## Philosophy

- elanous should converge on a goal itself rather than make a person judge every step.
- It observes its own actions, understands the context, then heals what it can; when it cannot, it brings the evidence to a person.
- Checklists, decisions and run ledgers are the source of truth; documents describe what those records show. See [What is Elanous](내부 문서 `intro`).
- Say only what you have measured, with the command that measures it: `bun bin/elanous.mjs self run-ledger <runId>` inspects run evidence. See [The harness](내부 문서 `harness`).
- A person supplies requirements and makes decisions; elanous does the work and escalates when necessary.
- Raise decisions in SCQA form: Situation, Complication, Question, Answer. See [Drive elanous from your coding agent](내부 문서 `drive-from-a-coding-agent`).

## Driving elanous from a coding agent

Hand a change to elanous rather than editing it directly when it needs an isolated build, gates and review:

- `bun bin/elanous.mjs harness say "<one line>"` — Hand over a one-sentence change request; see [The harness](내부 문서 `harness`).
- `bun bin/elanous.mjs harness ask <goal.md>` — Hand over an already written goal document; see [The harness](내부 문서 `harness`).
- `bun bin/elanous.mjs loop status --all` — Inspect the loops and their runs; see [Loop agents](내부 문서 `loop-agents`).
- `bun bin/elanous.mjs wf` — Explore workflows, the bodies of graph nodes; see [Graph engineering](내부 문서 `graph-engineering`).
- `bun bin/elanous.mjs agent-mission mission --backend codex "<request>"` — Let elanous drive another coding agent in a PTY; see [PTY intelligence](내부 문서 `pty-intelligence`).
- `bun bin/elanous.mjs decisions raise` — Raise a decision card when a choice needs a person; see [Drive elanous from your coding agent](내부 문서 `drive-from-a-coding-agent`) for the required fields.

## Toolchain

- Runtime and package manager: **bun** (see `package.json` `engines`).
- Install dependencies: `bun install`
- Run the CLI from a checkout: `bun bin/elanous.mjs <command>`
- Health check: `bun bin/elanous.mjs doctor` — names every missing credential and what stops working without it.

## Working agreement

- Read `git status` before editing. Keep unrelated changes out of your commit.
- Reproduce a defect through its real entry point before fixing it. A unit test that
  never reaches the execution path is not proof that the path works.
- Prefer extending an existing owner (module, command, catalog entry) over adding a
  parallel one. Search first: `rg -uu <name>`.
- Do not hard-code model names. Resolve them from the tier ladder
  (`src/model-tier/`) so a model migration does not leave stale names behind.
- Observability is part of the change: autonomous or self-healing logic records its
  decisions with `debug.log('<component>.<subsystem>', '<event>', data)`.

## Tests

- Run the tests for the files you changed: `bun test <path>`.
- Type-check changed files: `bun run scripts/ci-typecheck-changed.ts`.
- The full suite is `bun run test:deterministic`. Judge a change by whether it adds a
  **new** failure, not by the absolute count.
- A new test should fail when the change is reverted. Check that before you rely on it.

## Pull requests

- One coherent change per PR. Describe the situation, the problem, and what changed.
- Include the commands you ran and their results.
- Do not commit local state: `.elanous/` (goal documents, logs, run artifacts) is
  ignored on purpose.
