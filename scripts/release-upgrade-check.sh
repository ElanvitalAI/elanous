#!/usr/bin/env bash
# 업데이트(마이그레이션) 검증 — «이전 공개판을 쓰던 사용자»가 새 판으로 올려도 상태가 살아남는가 (대표 2026-09-27 · 릴리스 절차 한 칸).
#   빈 배포판 컨테이너 → 이전 공개판 설치(공개 설치기 · ELANOUS_VERSION=<from>) → setup · 기억 · 설정 · 로그를 만든다
#   → 후보 묶음으로 설치기를 다시 돈다(사용자가 업데이트하는 길) → 새 판 · 기억 · 설정 키 · 상태 파일 · 로그 · doctor 를 잰다.
#
#   bash scripts/release-upgrade-check.sh --from 0.2.2 [--candidate <elanous.tgz>] [BASE…]
#     --candidate 없으면 이 체크아웃을 `bun pm pack` 한다(⚠️ 내부본 — 발행 전엔 prepare 산출의 공개 묶음을 준다).
#     BASE 기본 = ubuntu:24.04 debian:12
# ⛔ 컨테이너는 systemd·재부팅을 못 잰다(데몬 상주 마이그레이션은 베어 VM 몫). 판정은 줄마다 `[upgrade] <칸> ok|FAIL`.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
FROM=""; CAND=""; BASES=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --from) FROM="${2:-}"; shift 2 ;;
    --candidate) CAND="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    -*) echo "⛔ unknown option: $1" >&2; exit 2 ;;
    *) BASES+=("$1"); shift ;;
  esac
done
[ -n "$FROM" ] || { echo "⛔ --from <previous public version> is required" >&2; exit 2; }
[ "${#BASES[@]}" -gt 0 ] || BASES=(ubuntu:24.04 debian:12)
command -v docker >/dev/null 2>&1 || { echo "⛔ docker not on PATH" >&2; exit 127; }
docker info >/dev/null 2>&1 || { echo "⛔ docker engine is not running" >&2; exit 1; }

OUT="${ELANOUS_UPGRADE_CHECK_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/elanous-upgrade-check.XXXXXX")}"
CTX="$OUT/ctx"; mkdir -p "$CTX"
if [ -n "$CAND" ]; then
  [ -f "$CAND" ] || { echo "⛔ candidate not found: $CAND" >&2; exit 2; }
  cp "$CAND" "$CTX/elanous.tgz"
else
  echo "▶ packing this checkout (internal) → $CTX" >&2
  (cd "$ROOT" && bun pm pack --destination "$CTX" >/dev/null 2>&1) || { echo "⛔ bun pm pack failed" >&2; exit 1; }
  mv "$(ls "$CTX"/*.tgz | head -1)" "$CTX/elanous.tgz"
fi
cp "$ROOT/scripts/install.sh" "$ROOT/docker/upgrade/Dockerfile" "$ROOT/docker/upgrade/upgrade-probe.sh" "$CTX/"

rc=0
for base in "${BASES[@]}"; do
  tag="$(printf '%s' "$base" | tr ':/' '--')"
  if docker build -t "elanous-upgrade:$tag" --build-arg BASE="$base" "$CTX" > "$OUT/build-$tag.log" 2>&1; then
    docker run --rm -e FROM="$FROM" "elanous-upgrade:$tag" > "$OUT/run-$tag.log" 2>&1
    grep '^\[upgrade\] .* FAIL' "$OUT/run-$tag.log" | sed "s/^/$base  /"
    verdict="$(grep '^\[upgrade\] verdict' "$OUT/run-$tag.log" | tail -1)"
    echo "$base  ${verdict:-[upgrade] no verdict — $OUT/run-$tag.log}"
    case "$verdict" in *"verdict ok"*) ;; *) rc=1 ;; esac
  else
    echo "$base  build FAILED — $OUT/build-$tag.log"; rc=1
  fi
done
echo "logs: $OUT" >&2
exit $rc
