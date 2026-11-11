# Sim-world device catalog fragments

`devices/<MD-id>.json` is the source for one device's membership in historical sim-world catalog versions. Keep the version list sorted and add a new device by adding its own file. A removal omits the version from that device's list; re-adding the device later adds the later version back.

Runtime world membership is assembled from these device fragments and the current `sourceModules`. The checked-in `src/sim-world-device-catalog-history.json` preserves prior version membership; the current membership is always read from fragments and the current catalog. Adding a device at a new current version does not edit the shared history file. Historical memberships are checked against the baseline, so a fragment cannot retroactively add or remove a device.

When advancing `deviceCatalogVersion`, first set membership for the new version in each device fragment. Then run `bun scripts/generate-sim-world-device-catalogs.ts --refresh-history` once to freeze the previous current version in the history file. Refresh refuses to change a version already present in the baseline; it only adds a missing previous-current version. Run `bun scripts/generate-sim-world-device-catalogs.ts --check` to verify that the historical baseline matches the fragments.

The independent-writer simulation merges real catalog source-module fragments and device membership fragments, then runs the normal loader and history refresh command. It verifies that both additions appear in the new current snapshot while the shared history file stays untouched by the PR changes.

The merge train uses the `uxsim-history` driver when two branches have refreshed the aggregate history. It combines version keys and membership additions, then regenerates and validates the result against the per-device fragments. Add membership in the device fragments first; the train writes the aggregate history.

```sh
bun scripts/generate-sim-world-device-catalogs.ts
bun test scripts/generate-sim-world-device-catalogs.test.ts
```
