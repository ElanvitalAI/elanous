---
name: absorb/build
description: Turn an explicitly accepted app suggestion into an isolated app artifact for simulation.
---

# Build an accepted suggestion

Use only the owner-verified suggestion and the member app slot returned by the store connector. Make the smallest source change that implements the accepted suggestion and return the generated artifact with evidence linking it to the suggestion and app slot. Also return `result.service` as the concise service name from the ask and `result.capacityAssumption` with `concurrentUsers`, `rationale`, `source`, and `userSpecified`. Preserve an explicit load target from the ask exactly; cite that text in the rationale, set `source` to `user-input`, and `userSpecified` to true. If the ask has no load target, provide a clearly labeled provisional simulation estimate and say that it was not supplied by the member (`source: model-estimate`, `userSpecified: false`). Do not present an estimate as a member requirement. Do not publish. The graph must send this artifact to isolated simulation and publish only after the simulation produces a passing receipt for the same artifact.

## Board attachment handoff

The graph may receive `input.attachments` from the upstream architecture handoff. Preserve supplied diagram and PDF references for the released board event; do not invent attachment paths, hashes, or producer names. The fake test universe may use the checked-in artifact manifest. A real board surface must publish the exact bytes through its authenticated attachment route before displaying them.
