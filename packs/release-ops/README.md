# Release operations policy pack

This pack is the checked-in source of release gate method policy. `scripts/release-loop/gate-method.ts` loads `policy.yaml` before the release graph is started and selects the executor from the rehearsal decision table. The configured `release.loop.gatePodPool` supplies the pool; the gate pins the measured cut commit to its image.

## Selection rule

- The latest usable hard rehearsal, ordered by its `endedAt` time, selects a declared executor/pool row. If any hard-stamp file is malformed or has a version/step mismatch, the whole rehearsal set is treated as unmeasured; equal latest timestamps are also ambiguous. An unusable latest rehearsal does not fall back to an older stamp. In each case selection falls back to the declared policy default.
- Every other rehearsal result, including missing or unmeasured evidence, falls back to the declared policy default. It never changes a regression into a host run.
- A hand `--gate-executor` request must match the policy selection. A mismatch fails closed; it cannot silently disable the configured pool, shard plan, or image pin. The separate `RELEASE-FLAG-POLICY-GUARD` cell will surface exceptions as a T−60 decision with an explicit reason and expiry.
- A policy-selected release gate must carry `gateImagePin: cut-commit`. The gate pins each Pod job's `imageCommit` and source checkout to the resolved `version-release` commit; a missing or unsupported pin fails closed. The executor event records both values for observation.

## 0.2.40 measured case

The 0.2.40 hard rehearsal recorded `outcome: ok`, `executor: pod`; applying the decision table selects Pod for 0.2.41. The 0.2.40 manual host workaround had no expiry and caused configured Pod warm-pool settings to be ignored. The pack records that interference as historical through 0.2.40, with a clear condition and an expiry. It is expired for a newly built 0.2.41 release run and is not an active executor exception.

Every future workaround entry must include both `expiresAfterVersion` and `clearCondition`. The loader rejects either missing field so an unbounded workaround cannot silently become policy.

The `workaround.executor` field is retrospective metadata. This pack does not activate exceptions from `knownInterferences`; a mismatch always fails closed, including before an entry's recorded expiry.
