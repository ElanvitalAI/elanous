#!/bin/zsh
# res-actuator.sh <step> <host> <leaseId> — the ONE seam through which the RES graphs touch a machine
# (src/res-graphs/res-nodes.ts · RES-READY-POOL-RESERVATION). Sims/test universe set ELANOUS_RES_ACTUATOR to a fake.
#   start|stop  → OP/tools/cloud-vm.sh (writes the cloud cost ledger on start and stop)
#   sanitize    → ssh: stale /tmp pregate dirs · git worktree prune · disk ≥ 15% free · MemAvailable ≥ 4 GiB (no kill)
#   catchup     → RES/tools/rail-catchup.py (accepts the graph-issued permit RES/graph-state/rail-permits/<host>.json)
#   auth        → OP/tools/codex-mirror-push.sh <host> when present, else verify ~/.codex/auth.json on the host
#   smoke       → RES/tools/pregate.py <PR> --light --host <host> (PR = $ELANOUS_RES_SMOKE_PR or newest open non-draft PR)
#   inflight    → count of running pregate workers on the host (prints an integer)
#   image       → TODO actuator (golden image snapshot) — exits 3 until an image API is wired
set -u
export PATH=$HOME/.bun/bin:$HOME/.local/bin:$HOME/.local/share/elanous/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
step=${1:?step}; host=${2:?host}; lease=${3:-manual}
SS=${ELANOUS_SEAT_STATE:-$HOME/elanous-hq/seat-state}
ssh_() { ssh -o BatchMode=yes -o ConnectTimeout=8 "$host" "$@"; }
case $step in
  start) exec "$SS/OP/tools/cloud-vm.sh" start "$host" --reason "res lease $lease" --source res-graph ;;
  stop)  exec "$SS/OP/tools/cloud-vm.sh" stop "$host" --reason "res lease $lease end" --source res-graph ;;
  sanitize)
    for i in {1..30}; do ssh_ true 2>/dev/null && break; sleep 10; done   # late boot: ssh up to 5 min
    ssh_ 'set -e
      find /tmp -maxdepth 1 -name "pregate-*" -mtime +1 -exec rm -rf {} + 2>/dev/null || true
      find /tmp -maxdepth 1 -name "elanous-*" -mtime +1 -exec rm -rf {} + 2>/dev/null || true
      for r in ~/elanous-hq/repo.git ~/elanous-hq/repo-fresh.git; do [ -d "$r" ] && git -C "$r" worktree prune || true; done
      pct=$(df -P ~ | awk "NR==2{gsub(\"%\",\"\",\$5); print 100-\$5}")
      mem=$(awk "/MemAvailable/{print int(\$2/1048576)}" /proc/meminfo 2>/dev/null || echo 99)
      echo "{\"diskFreePct\":$pct,\"memAvailGiB\":$mem}"
      [ "$pct" -ge 15 ] && [ "$mem" -ge 4 ]' ;;
  catchup) exec python3 "$SS/RES/tools/rail-catchup.py" --host "$host" --ssh-wait 300 ;;
  auth)
    if [ -x "$SS/OP/tools/codex-mirror-push.sh" ]; then exec "$SS/OP/tools/codex-mirror-push.sh" "$host"; fi
    ssh_ 'test -s ~/.codex/auth.json && echo codex-auth-present' ;;
  smoke)
    pr=${ELANOUS_RES_SMOKE_PR:-$(gh pr list --repo ElanvitalAI/elanous --state open --search draft:false -L 1 --json number -q '.[0].number' 2>/dev/null)}
    [ -n "$pr" ] || { echo "no smoke PR" >&2; exit 2; }
    exec python3 "$SS/RES/tools/pregate.py" "$pr" --light --host "$host" ;;
  inflight) ssh_ 'ps -eo args | grep -c "[h]eavy-slot.py --class review"' 2>/dev/null || echo 0 ;;
  image) echo "image actuator not wired (TODO: AMI/GCE image snapshot)" >&2; exit 3 ;;
  *) echo "unknown step $step" >&2; exit 2 ;;
esac
