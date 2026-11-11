# Mock scenario catalog fragments

Device review history lives in `reviews/`, one JSON file per review. `deviceKey` names the device or simulation cell and `review` preserves the original review line. Add a new file when a device changes; do not append a review to `.rules/30-harness/testing-gates.md`. The rule points here, and `bun test test/rules-contract.test.ts` checks the fragments and prevents duplicate lines in the rule.

The device manual's marked catalog block is generated from these catalog fragments. After changing a device, run `bun scripts/generate-ux-sim-device-manual.ts`; the merge train regenerates the merged tree from the combined fragments. Do not hand edit the marked block.

Fragments are the canonical catalog data. Add one JSON file to the relevant collection directory, using a five-digit order slot, `--`, a lowercase identity slug, and the first eight hex digits of the identity's SHA-256. Order slots are local to each collection; concurrent additions may share a slot because the identity suffix keeps their files separate and gives the merge a stable order. Prefer the next slot after the current maximum in steps of ten; use an unused gap when inserting into an established order. Do not commit `src/ux-sim/mock-scenario-catalog.json`; it is an ignored generated artifact.

Runtime readers assemble fragments in sorted file-name order. `--check` validates the schema, duplicate IDs, and deterministic output without reading or writing the generated JSON artifact. A release/package step that needs a JSON file can generate it locally with the generator command.

```sh
bun scripts/generate-mock-scenario-catalog.ts
bun scripts/generate-mock-scenario-catalog.ts --check
bun test scripts/generate-mock-scenario-catalog.test.ts src/ux-sim/mock-scenario-catalog.test.ts
```
