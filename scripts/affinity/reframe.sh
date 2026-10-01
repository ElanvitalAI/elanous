#!/usr/bin/env bash
# 🖼️ Affinity 리프레임 한 줄 — reframe.js 에 설정을 «박아» 넣고 MCP 로 실행한다.
#   쓰는 법: reframe.sh <src.png> <out.png> <W> <H> [blur] [mirror:0|1]
#   ⛔ 종료코드: 0 됐다 · 1 실패 · 2 ***못 쟀다***(Affinity 가 안 떠 있다 — 실패가 «아니다»)
set -u
SRC="${1:?src}"; OUT="${2:?out}"; W="${3:?width}"; H="${4:?height}"
BLUR="${5:-40}"; MIRROR="${6:-0}"   # ⛔ 기본 «꺼짐» — 실측으로 정했다(reframe.js §②)
AFF="${AFF_PY:-$HOME/obsidian/ElanvitalAI/30. Permanent Notes/35. Creator/Tools/affinity/aff.py}"
HERE="$(cd "$(dirname "$0")" && pwd)"

# ⛔⭐ 「못 쟀다」를 «먼저» 가른다 — 앱이 꺼져 있으면 그것은 실패가 아니라 측정 불가다.
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:6767/sse 2>/dev/null || true)
if [ "$code" != "200" ]; then
  echo "⚠️ Affinity MCP 에 «못 붙었다»(http_code='${code:-없음}') — 앱이 떠 있고 EnableMCPServer 가 켜져야 한다" >&2
  echo "   ⇒ MANUAL-affinity-mcp-automation-2026-09-20.md §1" >&2
  exit 2
fi
[ -f "$SRC" ] || { echo "⛔ 원본이 없다: $SRC" >&2; exit 1; }

# ⛔⭐⭐ ***MCP 파일시스템 권한은 «경로»로 갈린다*** — 실측 2026-09-22:
#   ~/Desktop/…  ✅ 내보내진다
#   /tmp/…       ⛔ Error: PERMISSION_DENIED  (at Document.export)
#   🔑 그런데 그 실패가 ***스크립트 «맨 끝»에서*** 난다 — 문서를 다 만들고 나서 죽는다.
#     ⇒ 「스크립트가 틀렸나」와 구별이 안 되고, 그때까지의 시간도 버린다.
#   ⇒ 그래서 «치기 전»에 여기서 막는다.
case "$OUT" in
  /tmp/*|/private/tmp/*|/var/*)
    echo "⛔ 이 경로로는 Affinity 가 «못 내보낸다»(PERMISSION_DENIED): $OUT" >&2
    echo "   ⇒ 홈 아래(예: ~/Desktop/…)로 내보내고, 필요하면 그 뒤에 옮겨라" >&2
    exit 1 ;;
esac

# ⛔ 설정을 JSON 으로 «만들어» 치환한다 — 셸 인용을 두 겹으로 겹치지 않는다.
CFG=$(SRC="$SRC" OUT="$OUT" W="$W" H="$H" BLUR="$BLUR" MIRROR="$MIRROR" python3 -c '
import json, os
print(json.dumps({"src": os.environ["SRC"], "out": os.environ["OUT"],
                  "width": int(os.environ["W"]), "height": int(os.environ["H"]),
                  "blur": float(os.environ["BLUR"]), "mirror": os.environ["MIRROR"] == "1"}))')

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/reframe.XXXXXX") || { echo "⛔ 임시 스크립트를 만들지 못했다" >&2; exit 1; }
TMP="$TMP_DIR/reframe.js"
CFG="$CFG" python3 -c '
import os, io, sys
src = io.open(sys.argv[1], encoding="utf-8").read()
io.open(sys.argv[2], "w", encoding="utf-8").write(src.replace("__CFG__", os.environ["CFG"]))' \
  "$HERE/reframe.js" "$TMP"

out=$(python3 "$AFF" run "$TMP" 2>&1); rc=$?
rm -f "$TMP"
rmdir "$TMP_DIR"
echo "$out"
# ⛔ aff.py 는 스크립트 «안»의 오류도 exit 0 으로 낼 수 있다 — 산출을 «읽어서» 가른다.
if printf '%s' "$out" | grep -qE '^Error:|Uncaught|TypeError|ReferenceError'; then exit 1; fi
[ $rc -ne 0 ] && exit 1
[ -f "$OUT" ] || { echo "⛔ 산출 파일이 «없다»: $OUT" >&2; exit 1; }
exit 0
