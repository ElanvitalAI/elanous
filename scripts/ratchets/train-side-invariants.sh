#!/usr/bin/env bash
# Train-side sentinel for the HARD regressions and release-critical invariants. Run on the
# merged side tree before the changed-file gate; never interpret a missing test
# or an incomplete run as a pass.
set -u

files=(
  scripts/ratchets/test-interference-patterns.test.ts
  scripts/ratchets/next-tui-entry-budget.test.ts
  src/domains/finance-cli.test.ts
  src/instance/state-dir-provenance-ratchet.test.ts
  src/self-implement/graph-yaml.test.ts
  src/self-implement/self-cli-sink-surface.test.ts
  test/identity-env.test.ts
  test/no-absolute-path-imports.test.ts
  test/scenarios/integration.test.ts
  test/rules-contract.test.ts
  test/hook-order-sweep.test.ts
  src/cli/g6a-commands.test.ts
  test/spawn-sync-max-buffer.test.ts
  test/telegram-coding-model-terra.test.ts
)

if [[ ${1:-} == --list ]]; then
  printf '%s\n' "${files[@]}"
  exit 0
fi
if [[ $# -gt 1 ]]; then
  echo 'TRAIN_INVARIANTS_UNMEASURED invalid-arguments'
  exit 2
fi
cd "${1:-.}" || { echo 'TRAIN_INVARIANTS_UNMEASURED repo-unreadable'; exit 2; }
command -v bun >/dev/null 2>&1 || { echo 'TRAIN_INVARIANTS_UNMEASURED bun-missing'; exit 2; }

for file in "${files[@]}"; do
  if [[ ! -f $file ]]; then
    echo "TRAIN_INVARIANTS_UNMEASURED missing-file=$file"
    exit 2
  fi
done

for file in "${files[@]}"; do
  echo "TRAIN_INVARIANTS_START $file"
  bun test "$file"
  rc=$?
  if [[ $rc -ne 0 ]]; then
    echo "TRAIN_INVARIANTS_FAIL file=$file rc=$rc"
    exit 1
  fi
done
echo "TRAIN_INVARIANTS_PASS files=${#files[@]}"
