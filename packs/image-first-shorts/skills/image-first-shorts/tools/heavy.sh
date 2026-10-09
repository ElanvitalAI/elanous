#!/usr/bin/env bash
# 출처: 공냥이 AI 실험실 «악역영애 말포이» AI 영상 제작 키트(https://malfoy-meme-making.vercel.app/) · 원작자 허락(2026-10-08) · 출처 명기 조건
# 변경: 키트 _tools/heavy.sh 를 mac 용으로 옮김 — flock(util-linux) 대신 mkdir 원자 락 ⊕ 죽은 pid 회수 · 슬롯 수 HEAVY_SLOTS(기본 2) · 락 위치 HEAVY_LOCK_DIR
# 무거운 작업(렌더·대량 ffmpeg·매팅·hyperframes check)을 동시에 HEAVY_SLOTS 개까지만 돌리는 세마포어.
# 사용: heavy.sh <명령...>
SLOTS="${HEAVY_SLOTS:-2}"
LOCK_DIR="${HEAVY_LOCK_DIR:-${TMPDIR:-/tmp}/ifs-heavy}"
mkdir -p "$LOCK_DIR"
[[ $# -eq 0 ]] && { echo "usage: heavy.sh <command...>" >&2; exit 2; }
while true; do
  for s in $(seq 1 "$SLOTS"); do
    L="$LOCK_DIR/slot-$s"
    if mkdir "$L" 2>/dev/null; then
      echo $$ > "$L/pid"
      trap 'rm -rf "$L"' EXIT INT TERM
      echo "[heavy] slot $s/$SLOTS: $*" >&2
      nice -n 5 "$@"; rc=$?
      exit $rc
    fi
    # 죽은 소유자의 락은 회수한다(재부팅·kill -9 뒤 영구 대기 방지)
    owner=$(cat "$L/pid" 2>/dev/null || true)
    if [[ -n "$owner" ]] && ! kill -0 "$owner" 2>/dev/null; then rm -rf "$L"; fi
  done
  sleep 5
done
