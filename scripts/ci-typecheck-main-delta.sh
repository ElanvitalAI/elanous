#!/usr/bin/env bash
# Pinned landing TSC guard: compare the integrated commit against its exact main baseline.
set -euo pipefail

BASE_SHA=${1:-}
if [[ ! "$BASE_SHA" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "error: expected a pinned 40-character main baseline SHA" >&2
  exit 2
fi

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "error: repository root unavailable" >&2; exit 2; }
git -C "$ROOT" cat-file -e "${BASE_SHA}^{commit}" 2>/dev/null || { echo "error: main baseline commit unavailable: $BASE_SHA" >&2; exit 2; }
# Share dependencies for speed only when resolution inputs match. If they differ,
# install the pinned main baseline from its own lockfile in the detached worktree.
dependency_changes=$(git -C "$ROOT" diff --name-only "$BASE_SHA" HEAD) || { echo "error: dependency diff unavailable" >&2; exit 2; }
dependency_changes=$(printf '%s\n' "$dependency_changes" | awk '/(^|\/)(package\.json|bun\.lock(\.b)?|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bunfig\.toml)$/')
INSTALL_BASELINE=0
if [[ -n "$dependency_changes" ]]; then
  printf '[tsc-main-delta] dependency inputs changed; installing pinned-main dependencies independently:\n%s\n' "$dependency_changes"
  INSTALL_BASELINE=1
fi
TMP=$(mktemp -d "${TMPDIR:-/var/tmp}/elanous-tsc-delta.XXXXXXXX") || { echo "error: temporary directory unavailable" >&2; exit 2; }
BASE_TREE="$TMP/base"

cleanup() {
  git -C "$ROOT" worktree remove --force "$BASE_TREE" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

git -C "$ROOT" worktree add --quiet --detach "$BASE_TREE" "$BASE_SHA" || { echo "error: main baseline worktree unavailable" >&2; exit 2; }
if [[ "$INSTALL_BASELINE" == 1 ]]; then
  (cd "$BASE_TREE" && bun install --frozen-lockfile) || { echo "error: pinned-main dependency install failed" >&2; exit 2; }
else
  ln -s "$ROOT/node_modules" "$BASE_TREE/node_modules" || { echo "error: baseline dependency link unavailable" >&2; exit 2; }
fi

run_tsc() {
  local tree="$1" label="$2" rc
  local log="$TMP/$label.log" diagnostics="$TMP/$label.diagnostics"
  if (cd "$tree" && NODE_OPTIONS='--max-old-space-size=12288' bunx tsc --noEmit --pretty false) >"$log" 2>&1; then rc=0; else rc=$?; fi
  if [[ "$rc" != 0 && "$rc" != 1 && "$rc" != 2 ]]; then
    cat "$log" >&2
    echo "error: $label tsc did not complete (rc=$rc)" >&2
    return 2
  fi
  awk '
    function flush() {
      if (active) {
        # Keep path/code/full text as the key; only ignore line/column drift. A moved
        # diagnostic is intentionally treated as new so cross-file errors stay visible.
        sub(/\([0-9]+,[0-9]+\): error TS/, ": error TS", block)
        print block
      }
      active = 0; block = ""
    }
    /^[^[:space:]].*: error TS[0-9]+:/ { flush(); block = $0; active = 1; next }
    active && /^[[:space:]]+/ { sub(/^[[:space:]]+/, ""); block = block " | " $0; next }
    { flush() }
    END { flush() }
  ' "$log" >"$TMP/$label.raw-diagnostics"
  LC_ALL=C sort "$TMP/$label.raw-diagnostics" >"$diagnostics"
  if [[ "$rc" != 0 && ! -s "$diagnostics" ]]; then
    cat "$log" >&2
    echo "error: $label tsc failed without parseable TypeScript diagnostics (rc=$rc)" >&2
    return 2
  fi
  if [[ "$rc" == 0 && -s "$diagnostics" ]]; then
    cat "$log" >&2
    echo "error: $label tsc returned success with diagnostics" >&2
    return 2
  fi
  printf '%s\n' "$rc"
}

BASE_RC=$(run_tsc "$BASE_TREE" baseline) || exit $?
HEAD_RC=$(run_tsc "$ROOT" integration) || exit $?
LC_ALL=C comm -13 "$TMP/baseline.diagnostics" "$TMP/integration.diagnostics" >"$TMP/new.diagnostics"
new_count=$(wc -l <"$TMP/new.diagnostics" | tr -d ' ')
printf '[tsc-main-delta] base=%s base_rc=%s head=%s head_rc=%s baseline_errors=%s head_errors=%s new_errors=%s\n' \
  "$BASE_SHA" "$BASE_RC" "$(git -C "$ROOT" rev-parse HEAD)" "$HEAD_RC" \
  "$(wc -l <"$TMP/baseline.diagnostics" | tr -d ' ')" "$(wc -l <"$TMP/integration.diagnostics" | tr -d ' ')" "$new_count"
if [[ "$new_count" != 0 ]]; then
  echo "error: main-baseline tsc introduced $new_count TypeScript diagnostic(s)" >&2
  cat "$TMP/new.diagnostics" >&2
  exit 1
fi
