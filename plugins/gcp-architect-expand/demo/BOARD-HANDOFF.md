# Integrated demo scene 6 · board artifact handoff

Owner boundary from OP's `DEMO-1114-1116-INTEGRATED-SCENARIO.md`: R-GCPX produces the diagram/PDF; ABSORB-3 and PWA-1 own the development-board events and card UI. This handoff does not assert that an MVP was built, tested, or deployed.

After the scene 5 fake-world approval and document verification, `demo/run.py` writes `board-attachments.json` beside the artifacts. Its card payload contains:

| Field | Meaning |
|---|---|
| `cardTitle`, `proposalId`, `inputSha256` | Tie the board card to the ticketing design and GCP proposal |
| `status: artifacts-ready` | Diagram/PDF exist and passed the output gate |
| `deploymentStatus: unverified` | No deployment claim is inferred from documents |
| `attachments[]` | Exact `BoardCardResponse/board.card` entries: `{kind, title, url, mime, sha256, producedBy}` for `diagram-source`, `diagram`, `pdf`, `html` |
| `consumerRule` | Relative URLs are test-universe references only; publish exact bytes, then regenerate with `--attachment-url-base` for an authenticated HTTPS or app-relative URL |

Scene 6 board owner steps: ingest the `attachments` array into the optional `board.card` field without changing existing card fields; if absent, use `[]`. Verify each file against its SHA-256, publish the exact bytes through the application's authenticated attachment route, and regenerate the URLs with `--attachment-url-base`. `producedBy` is the graph node id (`diagram` or `pdf`). The card's `개발 중 → 시험 → 배포됨` progression must come from harness/board events, not from this manifest. Until that consumer is connected, the TUI offers local file open choices and the manifest remains a reviewable handoff.

Test-universe output directory: `.elanous-test/gcp-architect-demo/run-*/board-attachments.json`. The checked-in sample is `plugins/gcp-architect-expand/sim/sample-output/board-attachments.json`.
