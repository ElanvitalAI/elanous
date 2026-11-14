---
name: absorb/build
description: Turn an explicitly accepted app suggestion into an isolated app artifact for simulation.
---

# Build an accepted suggestion

Use only the owner-verified suggestion and the member app slot returned by the store connector. Generate the smallest static app page that implements the accepted suggestion. Return `result.artifact` as `{ manifestYaml, html }`: `manifestYaml` is a valid `elanous.app/v0` manifest whose `slug` matches the suggested app ID and whose frontend is `static-export` with `out: out`; `html` is the complete generated HTML page. Do not claim that JSON alone is a deployed app or return an empty artifact. The host validates this draft and writes `app.yaml` and `out/index.html` under the verified member and current run before simulation.

Also return `result.service` as the concise service name from the ask and `result.capacityAssumption` with `concurrentUsers`, `rationale`, `source`, and `userSpecified`. Preserve an explicit load target from the ask exactly; cite that text in the rationale, set `source` to `user-input`, and `userSpecified` to true. If the ask has no load target, provide a clearly labeled provisional simulation estimate and say that it was not supplied by the member (`source: model-estimate`, `userSpecified: false`). Do not present an estimate as a member requirement. Do not publish. The graph sends only the host-materialized artifact to isolated simulation and publishes only after a passing receipt for the same bundle.

## Board attachment handoff

The graph may receive `input.attachments` from the upstream architecture handoff. Preserve supplied diagram and PDF references for the released board event; do not invent attachment paths, hashes, or producer names. The fake test universe may use the checked-in artifact manifest. A real board surface must publish the exact bytes through its authenticated attachment route before displaying them.
