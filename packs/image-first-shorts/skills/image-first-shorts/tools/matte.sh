#!/usr/bin/env bash
# 출처: 공냥이 AI 실험실 «악역영애 말포이» AI 영상 제작 키트(https://malfoy-meme-making.vercel.app/) · 원작자 허락(2026-10-08) · 출처 명기 조건
# 원본: 키트 tools/05_matte/matte.sh · 변경(mac): bash 3.2 호환(소문자 변환 tr) · 경로 하드코딩 제거(MATTE_PY·U2NET_HOME) ·
#   기본 AI 백엔드 cpu, --coreml 로 Apple 가속 · QC 시트는 composite.py 의존 대신 내장 파이썬(체커 합성)으로 새로 씀
# 블루 단색(#1E3CFF) 캐릭터 클립 → 알파 영상(VP9 alpha WebM 기본).
#   matte.sh <in.mp4> <out.webm|out.mov> [--png DIR] [--mov PATH] [--fast] [--coreml] [--ai-every N] [--crf N] [--start S --duration D] [-- keyer 인자...]
#   QC 시트(<out>_qc.jpg: 25/50/75% 지점 체커 합성)를 옆에 쓴다.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="${MATTE_PY:-python3}"
export U2NET_HOME="${U2NET_HOME:-$HOME/.u2net}" ORT_LOGGING_LEVEL=3
[[ $# -lt 2 ]] && { sed -n 4,7p "$0"; exit 1; }
IN="$1"; OUT="$2"; shift 2
AI=(--ai); BACKEND="${MATTE_AI_BACKEND:-cpu}"; EXTRA=(); PNG=""; MOV=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --png) PNG="$2"; shift 2;;
    --mov) MOV="$2"; shift 2;;
    --fast) AI=(); shift;;
    --cpu) BACKEND=cpu; shift;;
    --coreml) BACKEND=coreml; shift;;
    --ai-every|--crf|--start|--duration) EXTRA+=("$1" "$2"); shift 2;;
    --) shift; EXTRA+=("$@"); break;;
    *) echo "unknown option: $1" >&2; exit 1;;
  esac
done
[[ -f "$IN" ]] || { echo "no input: $IN" >&2; exit 1; }
mkdir -p "$(dirname "$OUT")"
LOW="$(printf '%s' "$OUT" | tr '[:upper:]' '[:lower:]')"
case "$LOW" in
  *.webm) OUTARGS=(--webm "$OUT");;
  *.mov)  OUTARGS=(--mov "$OUT");;
  *) echo "output must be .webm or .mov" >&2; exit 1;;
esac
[[ -n "$MOV" ]] && OUTARGS+=(--mov "$MOV")
[[ -n "$PNG" ]] && OUTARGS+=(--png-dir "$PNG")
[[ ${#AI[@]} -gt 0 ]] && AI+=(--ai-backend "$BACKEND")
"$PY" "$HERE/keyer.py" "$IN" "${OUTARGS[@]}" ${AI[@]+"${AI[@]}"} ${EXTRA[@]+"${EXTRA[@]}"}

QC="${OUT%.*}_qc.jpg"; TMPQ="$(mktemp -d)"
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT")
DEC=(); [[ "$LOW" == *.webm ]] && DEC=(-c:v libvpx-vp9)
for p in 25 50 75; do
  T=$(python3 -c "print(${DUR}*${p}/100)")
  ffmpeg -v error -y -ss "$T" ${DEC[@]+"${DEC[@]}"} -i "$OUT" -frames:v 1 -pix_fmt rgba "$TMPQ/$p.png"
done
"$PY" - "$QC" "$TMPQ" <<'PYQC'
import sys, cv2, numpy as np
rows = []
for p in (25, 50, 75):
    im = cv2.imread(f"{sys.argv[2]}/{p}.png", cv2.IMREAD_UNCHANGED).astype(np.float32)
    h, w = im.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    checker = np.where(((yy // 24 + xx // 24) % 2)[..., None] == 0, 200.0, 120.0) * np.ones(3)
    red = np.zeros_like(im[..., :3]); red[..., 2] = 255.0
    a = im[..., 3:4] / 255.0
    comp = lambda bg: im[..., :3] * a + bg * (1 - a)
    alpha = np.repeat(im[..., 3:4], 3, axis=2)
    rows.append(np.hstack([comp(checker), comp(red), alpha]))
out = np.vstack(rows)
scale = 0.35
cv2.imwrite(sys.argv[1], cv2.resize(out, None, fx=scale, fy=scale).astype(np.uint8))
PYQC
rm -rf "$TMPQ"
echo "done: $OUT  (qc: $QC)"
