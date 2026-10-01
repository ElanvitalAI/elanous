# doc-draft

Drafts one document from a request: an executive one-pager, a promo/event post, or a memo. **Drafts only; never published.** It does not post, send, or pay for anything.

Run from the repository without installing the plugin (install it for COO to discover `doc-draft`):

```sh
elanous graph run plugins/doc-draft/graphs/doc-draft.yaml --input '{"kind":"exec-onepager","topic":"Summarize the event readiness check for leadership"}' --json
```

Inputs: `kind` (required: `exec-onepager`, `promo-post`, `memo`), `topic` (required one-line request), `context` (optional previous seat results or source summary), `audience` (optional), `language` (optional, default `ko`), and `outDir` (optional, default beside the graph run state file). The `examples/brief-sample.json` keys are read by the COO planner; its values are illustrative only.

The `draft` step calls `elanous ask --bare --json` from a fresh empty temporary folder, then `check` checks the draft and asks for a review against the requested items and source context. An older CLI that rejects `--bare` falls back to `ask --json`. `DOC_DRAFT_ELANOUS_BIN` substitutes the CLI executable in tests. Each step emits final-line JSON; failures route to `failed`. Only after `check` succeeds does `report` write `outDir/draft.md` (one Markdown title line plus body), with final-line JSON `{ "outcome": "ok", "file": "…/draft.md", "words": 123 }`. An executive one-pager includes 요약, 핵심 숫자, 결정 요청, and 다음 단계; missing figures are marked as unprovided rather than invented. If `draft.md` already exists in `outDir`, `report` fails without replacing it; choose a fresh output directory for a new run. No publication or delivery happens.
