#!/bin/sh
# HQ-REP replication body — the same file runs on both HQ hosts (OP 10-04 10:09 · «되돌리기 방향»).
# The lease holder is the source, the other host is the standby: mbp → node-b today, node-b → mbp once node-b holds the lease.
# Called by each host's short cron shim (~/.elanous/bin/hq-standby.sh: lock ⊕ fetch ⊕ detach origin/main) with:
#   HQ_REP_PEER=<the other host's ssh name>  HQ_REP_DEFAULT_SOURCE=<lease names of the pre-lease source, comma list>
#   [HQ_REP_SURVIVAL=<host>,s3://bucket/prefix]  [HQ_REP_STATE_DIR=<canonical ledgers · default ~/.elanous>]
#   sh scripts/hq/hq-standby.sh core|big|obs|vault
# HQ_REP_STATE_DIR (OP 10-04 11:27): on node-b the promoted HQ state lives in ~/.elanous-hqstate — its live ~/.elanous is the
# Pod host's own state and must never be copied as HQ ledgers. The copy refuses a state dir without release/features.sqlite
# (an empty or wrong root would otherwise become the standby's newest generation).
# Direction comes from scripts/hq/standby-role.ts: `fenced` → the copy runs under `elanous hq fence --role cron`
# (TC HQ-FENCE decides · skip exits 0), `direct` → no lease yet and this is the default source, `skip` → no lease, not it.
MODE="$1"
ts() { date '+%Y-%m-%dT%H:%M:%S%z'; }
# Production ledgers on every host — a source-tree command resolves the test universe otherwise.
# HQ_REP_CONFIG_DIR (TC drill step 0 · 10-04 11:5x): node-b keeps its hq settings (hq.hostName=node-b) in ~/.elanous-hqcfg
# because its live ~/.elanous is the Pod host's; the role check and `hq fence` must read the same lease name as HQ-HB.
# ⚠️ The config dir moves only by the `--config-dir` flag (src/elanous-config-dir.ts) — an ELANOUS_CONFIG_DIR env is ignored.
export ELANOUS_STATE_DIR="$HOME/.elanous"
CFG="${HQ_REP_CONFIG_DIR:-$HOME/.elanous}"
STATE="${HQ_REP_STATE_DIR:-$HOME/.elanous}"
case "$MODE" in core|big|obs|vault) ;; *) echo "$(ts) hq-standby skip: unknown mode $MODE"; exit 2 ;; esac
[ -n "$HQ_REP_PEER" ] || { echo "$(ts) hq-standby skip($MODE): HQ_REP_PEER not set"; exit 2; }
[ -n "$HQ_REP_DEFAULT_SOURCE" ] || { echo "$(ts) hq-standby skip($MODE): HQ_REP_DEFAULT_SOURCE not set"; exit 2; }
verify_received() {
  # Verification is observational: a broken or not-yet-received copy must not fail replication's cron exit status.
  bun scripts/hq/standby-verify.ts --root "$HOME/.elanous-standby" --tier core,big --max-age-min core=30,big=400 || :
}
ROLE=$(bun scripts/hq/standby-role.ts --config-dir "$CFG" --default-source "$HQ_REP_DEFAULT_SOURCE" 2>/dev/null) || ROLE=fenced
case "$ROLE" in
  skip) if [ "$MODE" = core ]; then verify_received; else echo "$(ts) hq-standby skip($MODE): standby — no lease yet and this host is not the default source"; fi; exit 0 ;;
  direct) set -- ;;
  *) ROLE=fenced; set -- bun bin/elanous.mjs --config-dir "$CFG" hq fence --role cron -- ;;
esac
echo "$(ts) hq-standby run($MODE) role=$ROLE state=$STATE → $HQ_REP_PEER at $(git rev-parse --short HEAD 2>/dev/null)"
if [ "$MODE" = vault ]; then
  # Obsidian vault: one-way copy to the standby (no --delete; workspace state and trash stay local; --update keeps newer files there).
  V="$HOME/Obsidian/ElanvitalAI/"
  "$@" rsync -a --update --exclude '.obsidian/workspace*' --exclude '.trash/' "$V" "$HQ_REP_PEER:$V" 2>&1 \
    && echo "$(ts) hq-standby vault done rc=0 (a fence skip line above means nothing was copied)" || { echo "$(ts) hq-standby vault FAILED"; exit 1; }
  exit 0
fi
# In core fenced mode the guard runs inside the fence: a non-holder need not have HQ source ledgers.
if [ "$MODE" != core ] || [ "$ROLE" = direct ]; then
  [ -f "$STATE/release/features.sqlite" ] || { echo "$(ts) hq-standby skip($MODE): $STATE has no release/features.sqlite — not an HQ state dir, nothing copied"; exit 1; }
fi
SURV=""
[ "$MODE" = core ] && [ -n "$HQ_REP_SURVIVAL" ] && SURV="--survival $HQ_REP_SURVIVAL"
# The fence exits 0 both after copying and after skipping. Mark execution inside the fence,
# not by parsing its diagnostic text: only the skipped host owns a received copy to verify.
if [ "$MODE" = core ] && [ "$ROLE" = fenced ]; then
  FENCE_RAN=$(mktemp) || { echo "$(ts) hq-standby FAILED: cannot track fence execution"; exit 1; }
  # shellcheck disable=SC2086 — SURV is either empty or two words.
  COPY_OUT=$("$@" sh -c '
    [ -f "$1/release/features.sqlite" ] || { echo "hq-standby skip(core): $1 has no release/features.sqlite — not an HQ state dir, nothing copied"; exit 1; }
    printf "ran\n" > "$2"; shift 2; exec "$@"
  ' sh "$STATE" "$FENCE_RAN" env ELANOUS_STATE_DIR="$STATE" bun scripts/hq/standby-snapshot.ts --tier "$MODE" --push "$HQ_REP_PEER" $SURV 2>&1)
  COPY_RC=$?
  [ -z "$COPY_OUT" ] || printf '%s\n' "$COPY_OUT"
  if [ "$COPY_RC" -eq 0 ] && [ ! -s "$FENCE_RAN" ]; then verify_received; fi
  rm -f "$FENCE_RAN"
  exit "$COPY_RC"
fi
# shellcheck disable=SC2086 — SURV is either empty or two words.
"$@" env ELANOUS_STATE_DIR="$STATE" bun scripts/hq/standby-snapshot.ts --tier "$MODE" --push "$HQ_REP_PEER" $SURV 2>&1
