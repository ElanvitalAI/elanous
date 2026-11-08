#!/usr/bin/env bash
# Link the complete dependency set into a disposable checkout before any tests run.
set -euo pipefail

usage() {
  echo "usage: remote-worktree-setup.sh [--dry-run] <source-repo> <isolated-repo>" >&2
  exit 2
}

dry_run=0
if [[ ${1:-} == --dry-run ]]; then
  dry_run=1
  shift
fi
[[ $# == 2 ]] || usage

source_repo=$(cd "$1" 2>/dev/null && pwd -P) || { echo "source repository missing: $1" >&2; exit 2; }
isolated_repo=$(cd "$2" 2>/dev/null && pwd -P) || { echo "isolated repository missing: $2" >&2; exit 2; }
[[ "$source_repo" != "$isolated_repo" ]] || { echo "source and isolated repository must differ" >&2; exit 2; }

source_root_modules=$(cd "$source_repo/node_modules" 2>/dev/null && pwd -P) || { echo "root dependencies missing: $source_repo/node_modules" >&2; exit 2; }
source_pwa_modules=$(cd "$source_repo/apps/pwa/node_modules" 2>/dev/null && pwd -P) || { echo "PWA dependencies missing: $source_repo/apps/pwa/node_modules" >&2; exit 2; }
target_root_modules="$isolated_repo/node_modules"
target_pwa_modules="$isolated_repo/apps/pwa/node_modules"

[[ -d "$isolated_repo/apps/pwa" ]] || { echo "isolated PWA directory missing: $isolated_repo/apps/pwa" >&2; exit 2; }

check_link() {
  local source=$1 target=$2 label=$3 existing
  if [[ -L "$target" ]]; then
    existing=$(cd "$target" 2>/dev/null && pwd -P) || { echo "$label dependency link is broken: $target" >&2; return 2; }
    [[ "$existing" == "$source" ]] || { echo "$label dependency link points elsewhere: $target -> $existing" >&2; return 2; }
    printf 'already-linked %s: %s -> %s\n' "$label" "$target" "$source"
  elif [[ -e "$target" ]]; then
    echo "$label dependency target already exists and is not a symlink: $target" >&2
    return 2
  else
    printf '%s link %s: %s -> %s\n' "$( [[ $dry_run == 1 ]] && echo would || echo create )" "$label" "$target" "$source"
  fi
}

check_link "$source_root_modules" "$target_root_modules" root
check_link "$source_pwa_modules" "$target_pwa_modules" PWA

if [[ $dry_run == 1 ]]; then
  echo "dry-run: both dependency links are ready"
  exit 0
fi

[[ -L "$target_root_modules" ]] || ln -s "$source_root_modules" "$target_root_modules"
[[ -L "$target_pwa_modules" ]] || ln -s "$source_pwa_modules" "$target_pwa_modules"
[[ -d "$target_root_modules" && -d "$target_pwa_modules" ]] || { echo "dependency links did not resolve" >&2; exit 1; }
echo "ready: root and apps/pwa dependency links installed"
