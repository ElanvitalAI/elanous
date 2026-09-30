# Source layout

`src/` is several thousand files (count them with `git ls-files src | wc -l`). The map below is the entry layer only — it is not
the whole tree, and anything not listed here lives under a subdirectory.

```
bin/elanous.mjs       — distribution entry. imports src/index.ts (bun only; node cannot run it)
src/
  index.ts          — CLI command registration (commander)
  dashboard/        — 3-pane TUI + slash dispatch
  self-implement/   — goal authoring, the implementation loop, run ledger
  self-dev/         — launch preflight, decomposition, gate scoping
  harness/          — worktree lifecycle, plan/ask entry points
  git-fs/           — worktree creation, retry/lock discipline
  autopilot/build/  — the integrity gate (test · cli-smoke)
  registry/         — provider + model catalog loading (catalog/*.yaml)
  web-search/       — tavily · grok · firecrawl adapters
  llm.ts            — provider adapters + message assembly
  tui.ts render.ts context.ts extractors.ts — terminal, rendering, attachments
```
