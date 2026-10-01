#!/usr/bin/env bash
# 🎬 Affinity 엔드카드 한 줄. 쓰는 법: endcard.sh <out.png> <W> <H> <제목> <부제> <하단>
# ⛔ 종료코드: 0 됐다 · 1 실패 · 2 «못 쟀다»(Affinity 가 안 떠 있다)
set -u
OUT="${1:?out}"; W="${2:?w}"; H="${3:?h}"; TITLE="${4:?title}"; TAG="${5:-}"; FOOT="${6:-}"
AFF="${AFF_PY:-$HOME/obsidian/ElanvitalAI/30. Permanent Notes/35. Creator/Tools/affinity/aff.py}"
HERE="$(cd "$(dirname "$0")" && pwd)"

code=$(curl -s -o /dev/null -w '%{http_code}' -I --max-time 3 http://localhost:6767/sse 2>/dev/null || true)
[ "$code" = "200" ] || { echo "⚠️ Affinity MCP 에 «못 붙었다»(code='${code:-없음}')" >&2; exit 2; }
case "$OUT" in /tmp/*|/private/tmp/*|/var/*)
  echo "⛔ 이 경로로는 «못 내보낸다»(PERMISSION_DENIED): $OUT" >&2; exit 1 ;; esac

CFG=$(OUT="$OUT" W="$W" H="$H" T="$TITLE" G="$TAG" F="$FOOT" python3 -c '
import json, os
print(json.dumps({"out": os.environ["OUT"], "width": int(os.environ["W"]), "height": int(os.environ["H"]),
                  "title": os.environ["T"], "tagline": os.environ["G"], "footer": os.environ["F"]}))')
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/endcard.XXXXXX") || { echo "⛔ 임시 스크립트를 만들지 못했다" >&2; exit 1; }
TMP="$TMP_DIR/endcard.js"
CFG="$CFG" python3 -c '
import os, io, sys
io.open(sys.argv[2], "w", encoding="utf-8").write(
  io.open(sys.argv[1], encoding="utf-8").read().replace("__CFG__", os.environ["CFG"]))' "$HERE/endcard.js" "$TMP"
out=$(python3 "$AFF" run "$TMP" 2>&1); rc=$?
rm -f "$TMP"; rmdir "$TMP_DIR"; echo "$out"
printf '%s' "$out" | grep -qE '^Error:|Uncaught|TypeError|ReferenceError' && exit 1
[ $rc -ne 0 ] && exit 1
[ -f "$OUT" ] || { echo "⛔ 산출이 «없다»: $OUT" >&2; exit 1; }
exit 0
