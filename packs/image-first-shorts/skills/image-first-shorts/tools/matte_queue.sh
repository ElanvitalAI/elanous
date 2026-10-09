#!/usr/bin/env bash
# 출처: 공냥이 AI 실험실 «악역영애 말포이» AI 영상 제작 키트(https://malfoy-meme-making.vercel.app/) · 원작자 허락(2026-10-08) · 출처 명기 조건
# 원본: 키트 tools/_tools/matte_queue.sh · 변경(mac): 경로 인자화 · stat -f · 인월드 컷 판별을 하드코딩 이름 대신 SKIP_LIST 파일(줄당 컷 id) ·
#   기본 AI 백엔드 MATTE_AI_BACKEND(cpu) 실패 시 --fast 키 단독으로 재시도 · 무거운 작업 세마포어(heavy.sh) 아래에서 돈다
# SRC/*.mp4 를 순서대로 매팅해 DST/<id>.webm. 작업 중엔 .part.webm → 끝나면 이름 변경(반쪽 파일을 완성본으로 착각 방지).
#   matte_queue.sh <SRC> <DST>   · IDLE_MIN(기본 0 = 새 파일 없으면 바로 끝) · SKIP_LIST(인월드 컷 id 목록 파일)
SRC=${1:?SRC}; DST=${2:?DST}
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IDLE_MIN=${IDLE_MIN:-0}; idle_since=$(date +%s)
mkdir -p "$DST"
while true; do
  did=0
  for f in "$SRC"/*.mp4; do
    [ -e "$f" ] || continue
    b=$(basename "$f" .mp4)
    if [ -n "${SKIP_LIST:-}" ] && grep -qx "$b" "$SKIP_LIST" 2>/dev/null; then continue; fi
    [ -f "$DST/$b.webm" ] && continue
    [ $(( $(date +%s) - $(stat -f %m "$f") )) -lt 20 ] && continue
    echo "[matte] $b $(date +%T)"
    rm -f "$DST/$b.part.webm" "$DST/$b.part_qc.jpg"
    if "$HERE/heavy.sh" "$HERE/matte.sh" "$f" "$DST/$b.part.webm" > "$DST/$b.log" 2>&1 \
       || { echo "[retry-fast] $b"; "$HERE/heavy.sh" "$HERE/matte.sh" "$f" "$DST/$b.part.webm" --fast >> "$DST/$b.log" 2>&1; }; then
      mv -f "$DST/$b.part.webm" "$DST/$b.webm"; mv -f "$DST/$b.part_qc.jpg" "$DST/${b}_qc.jpg" 2>/dev/null
      echo "[ok] $b $(grep -o '"matte_s_per_frame": [0-9.]*' "$DST/$b.log" | tail -1)"
    else
      echo "[fail] $b"
    fi
    did=1
  done
  [ $did -eq 1 ] && { idle_since=$(date +%s); continue; }
  [ $(( $(date +%s) - idle_since )) -ge $(( IDLE_MIN * 60 )) ] && break
  sleep 30
done
echo "=== queue empty $(date +%T)"
