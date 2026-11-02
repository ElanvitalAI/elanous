# Steward shadow graphs

`entrance-dispatch-shadow.yaml` is a read-only baseline observer for the HQ TA dispatcher. It reads dispatcher-owned input files and the output log; it must never run `ta-dispatcher.sh`, execute its embedded picker, launch a task, access remote hosts, or mutate dispatcher state. It reports shell event counts only.

The dispatcher output has local `HH:MM:SS` timestamps but no cycle identifier. The observer parses timestamps in KST, assigns dates in log order (including midnight rollover), and starts a new inferred group when the gap between decision lines is at least `traffic.json.cycleSec` (default 300 seconds). These groups are only a log summary; they do not prove picker cycles or selected candidate sets.

Input digests are read before and after log/config capture. Missing or changing required files make the baseline snapshot incomplete. The graph currently has no production snapshot producer or isolated picker fixture, so it always reports candidate parity as `unmeasured`; it does not run the dispatcher's embedded Python or infer graph picks from incomplete inputs. `src/task-agent/entrance-shadow.ts` defines the pure input/judgment contract and is exercised through the graph's decision-record path and mock tests. A future producer and isolated comparison implementation must provide immutable observation snapshots and pass the picker safety requirements before parity can be measured.

`skip-memo.tsv` is included in the read-only input digest for inventory only. The current observer does not use it to calculate parity or persist a cycle baseline.
