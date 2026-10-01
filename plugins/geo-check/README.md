# geo-check

Run from the repository without installing the plugin:

```sh
elanous graph run plugins/geo-check/graphs/geo-check.yaml --input '{"brand":"Elanous","domain":"elanous.ai"}' --json
```

Inputs: `brand` (required name), `domain` (optional website; without it, citation is unknown rather than no), `questions` (optional array of up to 8 questions; `[]` generates five unbranded customer questions), `engines` (optional array of up to 3 distinct provider names; defaults to `openai-codex` and `grok`), and `outDir` (optional output directory, default beside the graph run state file). Questions are passed to each engine via `elanous ask --bare --json` (the question alone, with no Elanous preamble or session; an older `elanous` without `--bare` falls back to `elanous ask --json` and the answer row carries `bare: false`), and searched with `elanous research --json --limit 5`. Each step's final stdout line is JSON with `calls` and `errors`. For test fixtures, `GEO_CHECK_ELANOUS_BIN` substitutes the CLI executable.

Outputs: `report.md` has a one-line summary, question × engine mention/citation/rank/error table, evidence-linked suggestions when any question × engine cell is missing a mention or citation (no suggestions when no cells are missing), and the first 400 characters of each answer. `report.json` contains the same data and full answers. One engine can fail while the other completes; if every answer fails, the graph ends at `failed`. Research failures leave empty URL lists and an error count. The table is **a sample at that instant**, not a stable brand ranking: model answers change between runs.

Release note metadata: feat — New geo-check plugin measures whether AI answer engines mention and cite your brand, and suggests fixes · kind: feat · document: plugins/geo-check/README.md · target: next.

Every question is asked from a fresh empty folder, so files in the folder you run from (a brand repository, `AGENTS.md`, notes) never reach the answer engines. Rows marked `bare: false` passed through the Elanous assistant; when the brand being checked is Elanous itself, treat mentions in those rows as an upper bound.
