#!/usr/bin/env bash
# Claude Code Stop hook; hook data travels only through stdin to the bounded extractor.
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)" || exit 0
bun "$SCRIPT_DIR/emit.ts" stop </dev/stdin >/dev/null 2>&1 || true
