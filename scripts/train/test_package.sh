#!/usr/bin/env bash
set -euo pipefail

repo=$(git rev-parse --show-toplevel)
head=$(git rev-parse HEAD)
scratch=$(mktemp -d "${TMPDIR:-/tmp}/train-package-${head:0:12}-XXXXXX")
mkdir -p "$scratch/state"
: > "$scratch/queue.tsv"

tarball=$(cd "$repo" && npm pack --ignore-scripts --pack-destination "$scratch" --silent)
tar -xzf "$scratch/$tarball" -C "$scratch"
ln -s "$repo/node_modules" "$scratch/package/node_modules"
test -f "$scratch/package/scripts/train/train-auto-loop.sh"
test -f "$scratch/package/scripts/train/legacy/train-gate-remeasure.py"
zsh -n "$scratch/package/scripts/train/train-auto-loop.sh"
if grep -Fq 'seat-state/OPT/train-batch-live.py' "$scratch/package/scripts/train/train-auto-loop.sh"; then
  echo 'packed worker still launches the unversioned batch' >&2
  exit 1
fi
mkdir -p "$scratch/fake-home"
if HOME="$scratch/fake-home" zsh "$scratch/package/scripts/train/train-auto-loop.sh" > "$scratch/worker-smoke.log" 2>&1; then
  echo 'worker unexpectedly started without an operational host registry' >&2
  exit 1
fi
grep -Fq 'train-hosts.tsv' "$scratch/worker-smoke.log"
if HOME="$scratch/fake-home" TRAIN_SOURCE_ROOT="$scratch/stale-source" \
    zsh "$scratch/package/scripts/train/train-auto-loop.sh" > "$scratch/worker-stale-root.log" 2>&1; then
  echo 'worker unexpectedly started with a stale caller source root' >&2
  exit 1
fi
grep -Fq 'train-hosts.tsv' "$scratch/worker-stale-root.log"
if grep -Fq 'versioned train batch source missing' "$scratch/worker-stale-root.log"; then
  echo 'worker trusted the stale caller source root' >&2
  exit 1
fi

input=$(python3 - "$scratch/queue.tsv" "$repo" "$head" <<'PY'
import json
import sys
print(json.dumps({'queue': sys.argv[1], 'repo': sys.argv[2], 'base': sys.argv[3]}))
PY
)

cd "$scratch/package"
bun bin/elanous.mjs --config-dir "$scratch/state" graph run graphs/train/train-batch.yaml --input "$input"

# Exercise the manager's real graph node with an empty queue in an isolated home.
# Its eln fetch is a local no-op; origin/main is a local empty commit.
manager_home="$scratch/manager-home"
mkdir -p "$manager_home/elanous-hq/seats/OP" "$manager_home/elanous-hq/seat-state/OP" "$scratch/fake-bin"
: > "$manager_home/elanous-hq/seat-state/OP/land-queue.tsv"
printf '#!/bin/sh\nexit 0\n' > "$scratch/fake-bin/eln"
chmod +x "$scratch/fake-bin/eln"
git -C "$manager_home/elanous-hq/seats/OP" init -q
git -C "$manager_home/elanous-hq/seats/OP" -c user.name=Train -c user.email=train@example.invalid commit -q --allow-empty -m baseline
git -C "$manager_home/elanous-hq/seats/OP" update-ref refs/remotes/origin/main HEAD
HOME="$manager_home" PATH="$scratch/fake-bin:$PATH" bun bin/elanous.mjs --config-dir "$scratch/manager-state" graph run graphs/train/train-manager.yaml --input '{"op_watching":true}'
grep -Fq 'queue=0 idle' "$manager_home/elanous-hq/seat-state/OP/train-manager.log"
echo "packageRoot=$scratch/package head=$head"
