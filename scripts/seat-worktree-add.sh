#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 || $# -gt 4 ]]; then
  echo "usage: $0 <seat> <cell> <branch> [base]" >&2
  exit 64
fi

seat=$1
cell=$2
branch=$3
base=${4:-origin/main}
[[ "$seat" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ && "$cell" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || {
  echo "seat and cell must be plain path components" >&2
  exit 64
}
repo=$(git rev-parse --show-toplevel)
work_root=${ELANOUS_HQ_WORK_ROOT:-"$HOME/elanous-hq/work"}
tree="$work_root/$seat-$cell"

if [[ -e "$tree" ]]; then
  echo "seat worktree path already exists: $tree" >&2
  exit 73
fi
mkdir -p "$work_root"
git -C "$repo" worktree add -b "$branch" "$tree" "$base"
ELANOUS_SEAT_WT_REPO="$repo" ELANOUS_SEAT_WT_TREE="$tree" bun -e '
  const { linkWorktreeDependencies } = await import(process.env.ELANOUS_SEAT_WT_REPO + "/src/git-fs/worktree.ts");
  const result = linkWorktreeDependencies(process.env.ELANOUS_SEAT_WT_REPO, process.env.ELANOUS_SEAT_WT_TREE);
  console.log(JSON.stringify(result));
'
echo "worktree: $tree"
