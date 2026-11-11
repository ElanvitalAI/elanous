# Demo scene 4: briefing to three requirements

The `demo-brief-to-requirements` graph joins the source-linked scene 2 briefing and the scene 3 accepted suggestion. Its [input contract](references/input-contract.md) accepts both the normalized fixture and the actual absorb `groups/scrapIds` plus suggestion/build records. It checks the owner and source links; absent capacity is labeled as a scene 4 demo assumption of 100,000 users. The output is exactly three lines in `requirements.txt` and a provenance receipt in `requirements.json`.

```sh
elanous graph run plugins/demo-brief-to-requirements/graphs/brief-to-requirements.yaml \
  --input '{"briefPath":"/ABS/PATH/plugins/demo-brief-to-requirements/examples/ticketing-brief.json","outDir":"/ABS/PATH/receipt"}' --json
```

The three lines are the architecture model's user input. The model's structured design JSON then enters the existing `architecture-deliverables` graph through `structuredDesignPath` to create Excalidraw, PNG, HTML and PDF. The bridge invokes no model, so the 11-16 run can keep Solar as its only model. The design pack selection belongs to the KnowledgeQuery routing stage; this graph does not claim that a pack was selected.

The example is a fixture. A full demo receipt must replace its briefing, suggestion and source IDs with the actual scene 2 and scene 3 records, then record the model response and the architecture graph run ID. The test-universe bridge run `9bed2d02-54c4-41ef-aaf1-cc270f7b1d01` is stored at `seat-state/R-TICKET/demo-brief-test/graph-runs/demo-brief-to-requirements/`.

## Scene 4 TUI output graph

`graphs/scene4-architecture.yaml` declares `knowledge → normalize → render → verify`. The classic TUI activates it for exactly three ticketing architecture lines that contain scale, queue, seat, and payment constraints. Before the model turn, `KnowledgeQuery` retrieves cited cards from installed pack `ticketing-architecture-public@0.2.0` and adds their summaries to the model context. The model turn runs in a temporary independent directory with no exploratory tools, then restores the user's directory. Scene 4 defaults to a complete draft with explicit assumptions rather than waiting for missing-policy answers; an explicit request to ask first uses ordinary chat. After the model turn, the graph checks the answer for queue, seat, payment and durable-ledger evidence, creates `structured-design.json` and `architecture-rfc.md` with KGS card references, then invokes the shared `architecture-deliverables` graph. The PDF appendix includes the same card references. The final receipt requires a KGS card reference and verified Excalidraw, PNG and PDF. Missing evidence fails before publication.

The graph can also run from `elanous graph run` with JSON input fields `prompt`, `answer`, `outDir`, `stateRoot`, `resourceRoot`, `architecturePluginRoot`, and `graphPath`. Paths must be absolute; `prompt` must be exactly three lines. `answer` is the completed model text, not a fixture identifier. This is a scene-specific pack route; general automatic pack selection remains the KnowledgeQuery routing owner's work.

The structured adapter emits a **generic** architecture for scene 4; the GCP deployment choice belongs to scene 5. Its cost entry is zero with an explicit unmeasured formula, never a quoted cloud price. Outputs live under the current instance root at `scene4-architecture/<run-id>/`. The final TUI line links `architecture/verification.json`; `knowledge.json` and `source.json` preserve the pack call and answer hash.
