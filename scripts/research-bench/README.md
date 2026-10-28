신설: scripts/research-bench/README.md
# Research harness benchmark

## SCQA

**S** — The 10/31 positioning decision needs evidence about Elanous research quality and its Bloom-native research design.

**C** — A product-default comparison mixes harness and model effects. Bloom stages and graph layouts also need isolated comparisons under one model and fixed questions.

**Q** — How do we compare the products, measure Bloom's contribution, and test the recommended stage layout under either the default API cap or an explicitly approved uncapped run?

**A** — Run the same ten questions across a controlled pair, Bloom ablation, product-default pair, and Elanous layout ablation. Start with three questions, review the measurement, then run all ten. Keep manifests, raw answers, scores, latency, and spend in private evidence.

## Experiment matrix

| Cell | Comparison | Bloom instruction | Layout | Harnesses |
|---|---|---|---|---|
| A0 | Controlled baseline and no-Bloom ablation | None | Baseline | Elanous + Claude Code, both Opus 5.5 |
| A1 | Bloom ablation | Stages 1–3 | Baseline | Elanous + Claude Code, both Opus 5.5 |
| A2 | Bloom ablation | Stages 1–5 | Baseline | Elanous + Claude Code, both Opus 5.5 |
| A3 | Bloom ablation | Stages 1–6 | Baseline | Elanous + Claude Code, both Opus 5.5 |
| B | Product comparison | None | Product defaults | Elanous installed default + Claude Code defaults |
| P1 | Layout ablation | Stages 1–6 | Linear 1→6 | Elanous, Opus 5.5 |
| P5 | Layout ablation | Stages 1–6 | Front 6 reverse design; parallel 1/3; 4/5 loop; final 6 | Elanous, Opus 5.5 |
| P5-no-front6 | Layout ablation | Stages 1–6 | P5 without front 6 | Elanous, Opus 5.5 |

A0 is also the no-Bloom ablation baseline. A1–A3 add cumulative Bloom scaffolding to the same question; the question text stays unchanged. The product cell uses Elanous's installed default configuration (gpt-6-luna) against Claude Code defaults; it is not a controlled model comparison. OP deferred role-routed Elanous best-config measurement to B2 after 0.2.40. Layout cells measure Elanous architecture only. The 10 questions cover finance, technology, and market; at least four require analysis/evaluation.

## Run order and budget

- Pilot: the first-listed question in each of the finance, technology, and market domains across all eight cells, 39 total invocations (24 Elanous API calls, 15 Claude subscription calls).
- Execution-validation smoke: a configurable number of first-listed questions in A0 only, each as one matched Claude/Elanous pair. This checks runtime, timeout recovery, and cost collection; do not score it.
- Full: 10 questions in all eight cells, 130 total invocations (80 Elanous API calls, 50 Claude subscription calls).
- Default runs use the approved Elanous API cap of $200. After each Elanous call, read its `llm-usage` event, calculate token cost at official rates, and append to the private ledger. Do not start the next pair once cumulative Elanous API spend reaches $160 (80%). Finish the current matched pair. Claude Code subscription calls are recorded at $0 API spend and do not consume that cap. Use `--no-cost-cap` only when OP explicitly authorizes an uncapped run; manifests and ledgers mark both cap fields `null`.
- Opus 5.5 rates are $4/MTok input, $20/MTok output, $5/MTok 5-minute cache writes, and $0.20/MTok cache reads. The official price table is [Anthropic prompt-cache pricing](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) and [Claude Opus pricing](https://www.anthropic.com/claude/opus). Other Elanous models use the price estimate in their `llm-usage` event; an unknown API price stops the run.
- Pair order alternates for the controlled cells by question and cell. Every invocation starts a fresh session. Never pass one answer to another run.
- Collect per-cell rubric scores, actual provider spend, elapsed time, source count/quality, resolution level, tool traces, and failure/unknown notes. Report paired deltas and uncertainty; ten questions do not support broad population claims.

## Commands

```bash
bun scripts/research-bench/run.ts --dry-run
bun scripts/research-bench/run.ts --live --smoke-pairs 3 --baseline-sha <main-commit-sha> --config <private-config.json> --no-cost-cap --approval-ref OP#42096 --out ~/elanous-hq/seat-state/OP/evidence/20261026/askop-model-vs-harness
bun scripts/research-bench/run.ts --live --pilot --baseline-sha <main-commit-sha> --config <private-config.json> --max-total-cost-usd 200 --out ~/elanous-hq/seat-state/OP/evidence/20261026/askop-model-vs-harness
bun scripts/research-bench/run.ts --live --pilot --baseline-sha <main-commit-sha> --config <private-config.json> --no-cost-cap --approval-ref OP#42096 --out ~/elanous-hq/seat-state/OP/evidence/20261026/askop-model-vs-harness
bun scripts/research-bench/run.ts --live --full --baseline-sha <main-commit-sha> --config <private-config.json> --max-total-cost-usd 200 --out ~/elanous-hq/seat-state/OP/evidence/20261026/askop-model-vs-harness
```

The private config is version 2 and has adapters for A0, A1, A2, A3, B, P1, P5, and P5-no-front6, plus a baseline version probe. The probe must report the exact `--baseline-sha` requested before any live invocation starts. Smoke validation selects one question each from finance, technology, and market (one to three pairs), and its results are not scored. Adapter arguments are arrays, never shell strings; `{prompt}` is required and the other values may be interpolated when the adapter supports them. Each adapter declares model, tool-policy ID, turn limit, timeout, and a usage source. A0–A3 use Opus 5.5, eight tool turns, a 10-minute timeout, and a common research tool-policy ID; the Elanous config sets the Anthropic turn cap to eight, while Claude Code uses `--max-turns 8`. Elanous adapters query `eln logs --category llm.usage --event llm-usage --json --json-data --session {sessionId}` after each invocation; Claude Code adapters emit `stream-json` usage. Tool names differ slightly between CLI surfaces (Elanous `ListDir`, Claude Code `LS`); each call records the model reported by its usage source and token usage, using `unknown` when the source omits the model. Product defaults may differ by design.

## Scoring and evidence

Use `rubric.md` with blinded harness/model labels. Two raters score independently; a third resolves any two-point disagreement. Report per-question and per-dimension results, latency, and actual API spend. Outputs go only to private `seat-state/OP/evidence/`; never commit provider answers. Keep question and rubric versions fixed for regression comparisons.
