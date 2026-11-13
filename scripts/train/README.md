# Repository train runners

The executable train batch and manager sources live in `scripts/train/legacy/` and are invoked by the manual graphs in `graphs/train/`. The worker loop is versioned as `scripts/train/train-auto-loop.sh`; on first launch it pins its installed package root even if the caller has a stale `TRAIN_SOURCE_ROOT`, then carries that pin into its runtime snapshot and launches the batch and memory helper from that root. The queue, lock, host capacity, memory ledger, artifacts, and guarded landing scripts remain operational state under `~/elanous-hq/seat-state/OP/`. Both graph commands resolve their Python sources from the installed package root through `ELANOUS_RUNTIME_ROOT`; the Python sources resolve their imported helpers from their own directory.

## Source snapshot

The source was copied from the active mshq train on 2026-11-12 08:08 KST. The batch was refreshed after an 08:16 KST hotfix, and the manager after a later REST open-PR discovery hotfix. SHA-256 before the import-path edits and the repository-only express duplicate fix:

| Operational source | SHA-256 |
|---|---|
| `seat-state/OPT/train-batch-live.py` | `30039137dec98755bd42e44e16dfa62d917e71acdef142ea310c12bb3e1b96bf` |
| `seat-state/OP/tools/train-manager.py` | `e8a8b78b7166cf9ac0fb4ab91719e9185b05820c44ec9cffe6aff32185b07cc4` |
| `seat-state/OP/tools/gate-tier.py` | `16fdf3514801b540b72eedfa122e374affe73205286c48bc5ce4a0067210263c` |
| `seat-state/OP/tools/gate-tier-lanes.py` | `27e1be4b1ea2e154e5985566bfc8922b8284a5f2ad0c1de3abc4e2229c29db45` |
| `seat-state/OP/tools/train-memory.py` | `6a3705dcb3962c97bfd1c70e310e85d7bf810b5f8c0c399403d716b95b891064` |
| `seat-state/OP/tools/train-auto-loop.sh` | `2f5653118993c47cf18e7d5763d7c8abeb7abe7776bab565f7ae20d267934508` |

The batch and manager imports now point at the versioned sibling files. The batch snapshot includes the 08:16 KST live hotfix that removed gate-wide `BUN_OPTIONS`; the manager includes REST open-PR pagination and fixes one nested-quote f-string that failed to parse on minim5's Python 3.9. The repository manager also prevents express duplicate assignment. Existing operational state and guarded landing paths are unchanged. The source snapshot must be compared with the active operational runner before cutover; later operational hotfixes need a follow-up commit.

## Run paths

The graph input pins the queue, repository checkout, and full base SHA. Dry-run is the default. Live batch and manager ticks require `op_watching: true` in the input; the batch still applies its own `--live` guards. Do not start a second train manager while the operational loop is running.

```sh
eln graph run graphs/train/train-batch.yaml --input '{"queue":"/absolute/land-queue.tsv","repo":"/absolute/integration-repo","base":"<40-hex-SHA>"}'
eln graph run graphs/train/train-manager.yaml --dry-run
```

The installed package contains `graphs/train/` and `scripts/train/`; run the same graph path from the installed package root to bind its executable source to that package revision. After a PR lands and a package is installed on a train host, point the operator's manager and worker launchers at the installed `graphs/train/train-manager.yaml` and `scripts/train/train-auto-loop.sh` paths. Verify the batch source path in the graph receipt and the worker's `TRAIN_SOURCE_ROOT` pin, then retire the old direct Python launcher. Do this during an OP-controlled train window so no duplicate workers start.

## Measured baseline dependencies

On minim5, 2026-11-12 08:1x KST: Python 3.9.6 with `argparse`, `fcntl`, `sqlite3`, and `subprocess` available; `python3`, `git`, `gh`, `bun`, `zsh`, `ssh`, `scp`, and `eln` all resolve on PATH. The graph run uses the installed Elanous CLI and its package dependencies. The Python train still relies on operational queue and helper shell scripts at the paths above. This measurement is a host inventory, not a full live landing proof.
