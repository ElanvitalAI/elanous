# Steward shadow graphs

`entrance-dispatch-shadow.yaml` is a read-only baseline observer for the HQ TA dispatcher. It reads dispatcher-owned input files and the output log; it must never run `ta-dispatcher.sh`, execute its embedded picker, launch a task, access remote hosts, or mutate dispatcher state. It reports shell event counts only.

The dispatcher output has local `HH:MM:SS` timestamps but no cycle identifier. The observer parses timestamps in KST, assigns dates in log order (including midnight rollover), and starts a new inferred group when the gap between decision lines is at least `traffic.json.cycleSec` (default 300 seconds). These groups are only a log summary; they do not prove picker cycles or selected candidate sets.

Input digests are read before and after log/config capture. Missing or changing required files make the baseline snapshot incomplete. The graph currently has no production snapshot producer or isolated picker fixture, so it always reports candidate parity as `unmeasured`; it does not run the dispatcher's embedded Python or infer graph picks from incomplete inputs. `src/task-agent/entrance-shadow.ts` defines the pure input/judgment contract and is exercised through the graph's decision-record path and mock tests. A future producer and isolated comparison implementation must provide immutable observation snapshots and pass the picker safety requirements before parity can be measured.

`skip-memo.tsv` is included in the read-only input digest for inventory only. The current observer does not use it to calculate parity or persist a cycle baseline.

## space.yaml — 행정관 (per-coordinator steward)

`space.yaml` is the coordinator's «행정관»: one logical instance per scope (`steward:<scope>`), scopes taken from the federation ladder (els journal ⊕ federation.yaml). Every node is a deterministic `cmd:` recipe (`src/steward/space/tick.ts`): R0 snapshot → R1 match → R2 receipt → R3 judge → R4 hand-off to the existing poller → R5 watch → R6 digest → X exceptions. A scope only acts when `loops.stewardSpace.scopes.<SCOPE>.mode` is `shadow` or `live` (default `off`); `eln steward space tick --shadow [--scope TC]` records «would do» rows only. Rows land in `<state>/steward/space/<SCOPE>/ledger.jsonl`; `eln steward space status` shows the last tick per scope. Cross-scope work (lending an idle hand, unresolvable rows) happens only in the HQ instance, never between scopes.

Schedule: `space.yaml` declares `root: 조율자`, so `eln loop start steward-space --yes` installs its `*/10` cron (one guarded `loop cron` line). The cron passes no input — only scopes set to shadow/live act. A tick's exceptions are refused or ambiguous rows only: a cell or PR with no free hand, or over the per-tick cap, is a `defer` row (capacity), and each scope sends at most one card of ≤ 10 lines plus a count. A hand is free once els `status.since` shows it has been idle ≥ 10 min.
