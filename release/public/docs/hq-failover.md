# Keeping the HQ running when a machine fails

A fleet can move its `control` seat between candidates; see [Running elanous on several machines](multi-machine.md). **HQ** is a different job: it is the one machine allowed to write the operational ledgers and run side-effecting work. A second machine keeps a verified copy, but must not start polling, publishing or writing merely because the first machine is unreachable.

Available from **0.2.13**: the `elanous hq` commands, and the replication scripts under `scripts/hq/` (shipped inside the installed package and present in a source checkout at the same path).

This page explains the lease, the standby copy and a safe move in either direction. Examples use `home` (the current HQ), `standby` (the replacement) and `arbiter` (a third, private-network machine). Replace these with your actual host names and paths. The commands that operate on ledgers are for an installed, **production** elanous, not a test instance. Do not put lease records, tokens or operational state on a public address.

## 1. Know which machine owns what

| Machine | Job |
|---|---|
| `home` | Runs the HQ daemon, channels and scheduled writers while it holds the lease. Sends snapshots to `standby`. |
| `standby` | Receives snapshots and reports whether it can reach the holder. Runs HQ writers only after acquiring a newer lease generation and promoting the verified copy. |
| `arbiter` | Keeps `~/.elanous-hq/lease.json` and alone decides automatic promotion. It need not host the full HQ state. |

The lease holder is the source of replication, not necessarily the machine called `home`: after promotion, `standby` sends snapshots **back** to `home`. The arbiter probes home machines over the private network with Tailscale ping and Nexus health, not SSH into them. HQ hosts contact the arbiter to read and update the lease; the holder may contact the standby for quorum.

Keep three paths distinct: the installed code, the host's live state, and the received `~/.elanous-standby/` snapshot. Never treat a received copy as live state just by pointing a daemon at `latest`. A promoted host may have its own unrelated live `~/.elanous`; choose a separate, deliberate HQ state directory instead.

## 2. Prepare both hosts before moving anything

Install the same compatible elanous build, Bun, `sqlite3`, `rsync`, SSH and Tailscale on the relevant hosts. Arrange private SSH from **each HQ candidate to the arbiter** and from the current holder to the standby. Configure each host's own `hq.hostName` and `hq.arbiter`; the arbiter runs its own check against its **local** lease store. Give the replacement a distinct host-local config directory if its existing elanous state belongs to another workload. Pass that directory with `--config-dir`; an environment variable called `ELANOUS_CONFIG_DIR` does not switch the HQ configuration for the replication wrapper.

Check the paths and identities on each HQ candidate, then check the arbiter from each candidate:

```sh
elanous hq host set <this-host-name>
elanous hq lease status --json
ssh -o BatchMode=yes <arbiter> true
```

`hq host set` saves a host-local identity outside copied config/state. If both `hq.hostName` and the host-local name are set, make them agree; inspect any `hq.lease` `hostname-mismatch` observation rather than assuming a copied config is authoritative. Verify the holder's Nexus health through the private-network TLS mapping (`tailscale serve status` on the holder), and verify a `tailscale ping -c 1 --timeout 5s <holder>` from the arbiter. Nexus normally listens on loopback; a tailnet IP request without its HTTPS serve mapping is not the same health check. Check the actual health URL or set `hq.healthUrls.<host>` rather than copying an example domain.

Inventory the existing cron and service launchers before duplicating them. The replacement's polling, publishing, trading and ledger-writing launchers must remain **inactive** until it holds the lease, and every writer you intend to transfer must be covered by a fence. A running job started before a fence was installed does not become fenced retroactively.

## 3. Establish and inspect the HQ lease

On the current HQ, after the arbiter is reachable:

```sh
elanous hq lease acquire
elanous hq lease status --json
```

Check that `holder` is this host and `generation` is the expected new number. A different unexpired holder refuses acquisition; do not edit `lease.json` or force an old generation into place. `elanous hq lease renew`, `status` and `release` are also available; refused lease mutations exit nonzero. The record is compare-and-swap protected at the arbiter. Its default TTL is 1,500 seconds; a new acquisition after an expired or released lease increases the generation.

Once a host has seen a generation, it remembers the highest one outside the copied HQ data. Check with `elanous hq seen` (exit 0 when seen, exit 3 when never seen). A missing arbiter record **after** a generation has been seen is not permission to fall back to the old default source. Before the first lease only, a deliberately configured default source can send bootstrap snapshots; after that, the lease determines the direction.

## 4. Keep the holder and arbiter checking

Run `elanous hq heartbeat` on **both** HQ candidates every ten minutes. The holder renews; the non-holder reports its view of the holder and stays standby. Run `elanous hq arbiter-check` on the arbiter every ten minutes, staggered from candidate heartbeats. Install these jobs as persistent scheduled work and inspect their actual service/cron status. **Do not put the heartbeat behind `hq fence`: the non-holder must still report its view.**

The arbiter's check calls the holder unreachable only if **both** Tailscale ping and Nexus health fail. Promotion requires two consecutive checks in which the arbiter cannot reach the holder **and** the standby has a fresh report (no older than 25 minutes) that it cannot reach that same holder. One dual-unreachable check alone does not promote; a stale standby report or a reachable holder resets the streak. Failure of only one of the two probes still counts the holder as reachable. Absence of SSH access from the arbiter to home machines is intentional. Inspect `elanous hq lease status --json` and `elanous logs --category hq.lease` for `standby`, `arbiter-check` and `promoted`, rather than predicting a promotion from a machine's SSH failure alone.

## 5. Fence every single-writer action

Wrap the *command that actually writes or sends*, on both candidate hosts:

```sh
elanous hq fence --role cron -- <scheduled-command> <arguments>
elanous hq fence --role telegram-poller -- <poller-command> <arguments>
```

Use the matching role for other work: `seat-loop`, `release-run`, `conatus`, `git-push` and, for CLI ledger writes, `ledger-cli`. A denied fenced command prints `hq fence: skip …` and exits **0** without running the child; a successful cron exit alone therefore does **not** prove work ran. Allowed children receive `ELANOUS_HQ_GENERATION`. Check `elanous logs --category hq.fence` for `allowed` or `skipped`, reason, holder and generation. CLI ledger writes fail closed after a lease was seen; an explicit `--hq-override` is an observed exceptional bypass, not routine failover.

If the arbiter is down, the holder may continue while it can reach the standby, or while its last confirmation is still within its TTL. With neither connection and an expired confirmation, the fence skips (`no-quorum-expired`). A returning old HQ skips as `not-holder`, or `stale-generation` when it learns that the standby has a newer generation. Do not configure `hq.failOpenRoles` as a blanket recovery switch: the exception can permit work without quorum but does not override a newer generation. Do not run two unfenced Telegram pollers, publication jobs, trading cycles or git pushers.

## 6. Send snapshots from the current holder

The same `scripts/hq/hq-standby.sh` body runs on both HQ hosts. Its caller supplies `HQ_REP_PEER` (the other host), `HQ_REP_DEFAULT_SOURCE` (only for pre-lease bootstrap), and, when necessary, `HQ_REP_CONFIG_DIR` and `HQ_REP_STATE_DIR`. Run its `core`, `big`, `obs` and `vault` modes from a checkout of the matching code. The wrapper selects `direct` only before any lease has ever been seen on the configured default source; after that, it uses `hq fence --role cron` or skips. The source state must contain `release/features.sqlite` or the copy refuses to run: this prevents an empty or unrelated state directory from becoming the newest standby generation.

| Tier | What it carries | Example schedule |
|---|---|---|
| `core` | Small canonical ledgers, decisions, schedules and release checklists | every 10 minutes |
| `big` | Canonical databases larger than 20 MiB | four times daily |
| `obs` | Logs and surface events; a new HQ can start observation afresh | four times daily |
| `vault` | Optional one-way Obsidian reading copy; excludes workspace state and trash, does not delete receiver files | hourly |

SQLite databases are snapshotted through `.backup`, not copied while live. Large files go by delta transfer rather than a whole copy every ten minutes. Each tier has a timestamped generation, `MANIFEST.json`, `SHA256SUMS` and a receiver-side `latest` link that advances only after checksum verification. `config.json` in the snapshot has its host-local `hq` block removed; keep each host's own HQ config. Runtime sessions, active worktrees and running jobs are **not** replicated. Secrets do not go into the optional survival subset on the arbiter or object storage; provision required credentials separately, privately, on the replacement.

## 7. Verify the received copy, not just the send log

On the **receiver**, from the checkout containing the verifier:

```sh
bun scripts/hq/standby-verify.ts --root ~/.elanous-standby \
  --tier core,big --max-age-min core=30,big=400
```

Expect a one-line `hq-standby verify … OK` with generation, age, source host and `ok checked/entries`; exit 0 means the selected tiers passed. `FAIL` (exit 1), an unreadable tier, a missing `latest`, a source host you did not expect, or a stale generation is **not** a promotion-ready copy. The verifier checks the manifest and every listed checksum, not just whether a link exists. The send wrapper may report a skip with exit 0, and its own observational verification does not fail the replication cron; run the receiver check explicitly before promotion. `core` can lag up to its schedule interval and `big` up to its longer interval. For a planned move or return, even a recent copy is not final: follow sections 8–9 to drain writes, send both tiers again and verify them on the receiver before changing the lease. The exact acceptable age during ordinary standby operation depends on your installed schedule.

## 8. Promote a verified standby

For a planned move, use this order while the old HQ **still holds the lease**:

1. Stop **new application writes and launches** on the old host (pollers, schedules, CLI writers and senders); keep the lease heartbeat and the fenced replication path available. Wait for already-running writes, sends, children and retries to finish, and inspect the actual run/delivery records. A fence does not stop a child that started before it was installed.
2. **After the last write has finished**, send a final fenced `core` **and** `big` snapshot from the old lease holder to the replacement using the holder's configured `scripts/hq/hq-standby.sh core` and `scripts/hq/hq-standby.sh big` wrapper (or its installed cron shim). Wait for both transfers to finish. A wrapper's exit 0 can mean `hq fence: skip`; inspect its output for a real generation in each tier. Keep new writers stopped throughout this copy and handoff.
3. On the **replacement**, run the receiver verifier in section 7. Check `OK` for both tiers, source host = old holder, and `core` and `big` generation IDs = the **final transfers after the last write**, not merely generations that look recent. If either transfer skipped, failed or has the wrong source/generation, do not release or acquire the lease: fix and repeat the final copy and receiver check while the old lease remains held. Verify the receiving host's local configuration and credentials without printing secrets.
4. **While the old HQ still holds the lease and both hosts' new writers remain stopped**, promote the *verified final* `core` and `big` generations into a **new HQ state directory** on the replacement, not into its unrelated live state. From the replacement's checkout, check the dry-run generation IDs against step 3 and then copy:

```sh
bun scripts/hq/standby-promote.ts --standby ~/.elanous-standby \
  --to ~/.elanous-hqstate --hq-config ~/.elanous-hqcfg --dry-run
bun scripts/hq/standby-promote.ts --standby ~/.elanous-standby \
  --to ~/.elanous-hqstate --hq-config ~/.elanous-hqcfg
```

   Replace the example paths with a **new, nonexistent** state target and the replacement's host-local config directory. Check the `promoted` output lists the *same final* `core` and `big` generation IDs as step 3, `features=yes`, `pollers=off` and the replacement's `hq` host name. The script refuses an existing target, verifies each generation before copying, merges the host's `hq` config, and leaves Telegram and Discord pollers disabled in the promoted config. If promotion fails or lists a different generation, keep the old lease and repeat the final transfer, receiver verification and promotion into a fresh target. Keep the promoted target isolated from writers: the old holder's lease does **not** authorize the replacement to run them.
5. With services still stopped on the replacement, update their **state directory** to the promoted target (`~/.elanous-hqstate` in this example), including the daemon, channel launchers and cron jobs via `ELANOUS_STATE_DIR`, and the replication wrapper via `HQ_REP_STATE_DIR`; keep their **configuration directory** pointed at that host's own HQ config (`--config-dir ~/.elanous-hqcfg` for CLI launchers, `HQ_REP_CONFIG_DIR` for the wrapper). Inspect the actual service definitions and effective paths to confirm none of them will read the replacement's old `~/.elanous` or the received `~/.elanous-standby/`. Do not start writers yet. Only **after** the verified copy has been promoted and all HQ services point to it, release the lease **on the old holder**, then acquire it **on the replacement**:

```sh
# old HQ, only after its writers and in-flight work have stopped
elanous hq lease release
# replacement HQ
elanous hq lease acquire
elanous hq lease status --json
```

Confirm the new holder and an increased generation **before** starting the replacement's fenced services. For an unplanned outage, do **not** claim the lease by editing its file or issuing an unconditional acquire while the old holder may still write. Wait for the arbiter's two dual-unreachable checks and check the `promoted` observation and lease status. On the replacement, run section 7's receiver check and then use the dry run and copy commands in step 4 to promote the verified `core` and `big` into a **new HQ state directory** (not its unrelated live state). Set and inspect service state/configuration paths as in step 5, but do not release or acquire the automatically promoted lease again.

A successful copy is **not** permission to start senders: check the new lease holder and generation, install/check credentials, then deliberately enable only the correctly fenced daemon, channels and writers and verify one delivery origin. Do not copy the old host's `hq.hostName`, host-local lease state or running sessions. Check the application from an independent client and check that each external delivery has one origin. If the old host cannot be shown stopped or fenced, keep the replacement's senders off until the lease and generation make that check reliable.

## 9. Return to the former HQ without losing new writes

Do not simply wake the old HQ: its old generation must remain standby. Once the replacement holds the lease, its replication wrapper sends `core` and `big` **back** to the former holder. Verify the received generations there with the same receiver command in section 7; their manifest source must be the replacement. For a round-trip rehearsal, write a unique non-secret marker under the current HQ state's `hq-drill/round-trip.jsonl`, send a fenced `core` snapshot, and verify **exactly one** matching marker on the former HQ's received copy. Check that the former HQ's own send wrapper says `hq fence: skip cron — not-holder`.

To return, keep the replacement's lease in force while you stop **new application writes and launches** there and wait for all in-flight writes, sends, children and retries to finish; inspect their run/delivery records. Leave the lease heartbeat and its fenced replication path running. **After the last write**, send a final fenced `core` **and** `big` snapshot from the replacement to the former HQ with its configured `scripts/hq/hq-standby.sh core` and `scripts/hq/hq-standby.sh big` wrapper (or its installed cron shim), and wait for both transfers to finish. On the **former HQ**, run section 7's receiver verifier and require `OK` for both tiers, source host = replacement, and generation IDs matching these **post-write final transfers**; an earlier fresh copy or a fence skip is not enough. Keep writers stopped on both hosts. If either transfer or verification fails, keep the replacement's lease and retry; do not transfer the lease.

Use the promotion script from section 8 with the former HQ as receiver, substituting a **new, nonexistent target path** for `--to` and the former host's own HQ configuration for `--hq-config`. It refuses to overwrite an existing state directory: stop services, preserve the old live state separately and explicitly switch the HQ services to the newly promoted state only after confirming its final `core` and `big` generations and host identity. **Only after the final receiver check and copy** does the current holder release its lease; the former HQ acquires the next generation, checks `lease status`, and only then starts fenced writers. Check the direction has reversed again. If notes changed on the replacement's optional vault copy, merge them before opening the old vault; `rsync --update` will not resolve concurrent edits of the same file for you. A rollback of processes without the *return* copy loses writes made after promotion.

## 10. Keep decisions moving while human seats are away

HQ failover moves ledgers and service responsibility, not a person's open terminal, PTY or agent session. On the new HQ without reattached human seat sessions, `elanous steward mode rescue` permits a narrow continuation: launch queued goals, harvest finished runs, send blocked-work notices and raise decision cards. It refuses publishing, release runs, outside posting, deletion, configuration changes and forced git actions; inspect `elanous logs --category steward.rescue` for accepted actions and `refused`. When a human seat session is attached again, set `elanous steward mode shadow` on the **new** HQ; it does not switch automatically. Check the setting with `elanous steward mode --json`. Rescue is not permission to bypass the lease fence or to revive the old host's runtime.

## 11. What a real drill measured

One full drill on three machines — lease, fenced copy, a simulated holder outage, promotion, a return trip and the lease handed back — took **23 minutes** end to end.

| Step | Measured |
|---|---|
| Promote the standby copy into a new state folder (`core` then `big`) | 4 seconds |
| Round trip: a marker written on the new HQ appears in the former HQ's received copy | 9 seconds |
| One `core` transfer (about 73 MB, changed blocks only) | 6–9 seconds |
| One `big` transfer (about 680 MB, changed blocks only) | 5–8 seconds |

**RPO** — how much you can lose — follows the tier schedule. `core` is at most about ten minutes old. `big` runs every six hours, so a promotion can carry a `big` generation that is hours old. In the drill it was three and a half hours. Run one `big` snapshot from the holder right before a planned promotion to bring that down to minutes. Writes made directly on the old HQ after the lease moved are **not** fenced yet and must be found and replayed by hand; the drill found two.

## 12. Diagnose a stalled or unsafe move

| You see | Check and do |
|---|---|
| No fresh `core` or `big` | On the *receiving* host run the verifier in section 7. Check the holder's snapshot log, `HQ_REP_STATE_DIR/release/features.sqlite`, SSH and the configured peer. A successful skip is not a successful copy. |
| The wrong host appears as holder or source | Compare `elanous hq lease status --json`, host-local identity/config and snapshot manifest source. Do not copy `hq` config from the other machine. Use `--config-dir` for a distinct HQ config directory. |
| Arbiter cannot contact the holder | Check tailnet ping **and** the holder's served HTTPS Nexus health endpoint. A failed SSH to a home host is not the arbiter's health test. Read the two-view streak and freshness before expecting promotion. |
| Work skips after the arbiter record disappears | Check `elanous hq seen` and `hq.fence` reason `no-lease-after-seen`. Restore the arbiter/lease safely; do not reinstate pre-lease default-source mode. |
| Returned old HQ starts sending again | Inspect `hq.fence` for `not-holder` or `stale-generation`; stop any unfenced writers. Do not enable old senders until its newer-generation lease and returned snapshot are verified. |
| Both arbiter and standby are unreachable | With expired local confirmation the holder stops fenced work (`no-quorum-expired`). Repair quorum rather than bypassing the fence. |

The CLI status and logs show **software decisions**, not proof that a disconnected machine is powered off or that a previously started sender has finished. In an ambiguous partition, keep new senders disabled; independently isolate or verify the old sender and check external deliveries before resuming. Do not turn a missing observation into a green failover report.
