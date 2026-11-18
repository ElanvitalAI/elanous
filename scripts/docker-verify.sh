#!/usr/bin/env bash
# 배포판 설치 검증 매트릭스 — 빈 배포판 이미지에서 «설치 한 번 → doctor --fix --yes --sudo → doctor» 를 잰다.
# 매뉴얼: 내부 문서 `MANUAL-environment-setup-by-platform-2026-09-20` §2f
#
#   bash scripts/docker-verify.sh                     # 실측한 여섯 이미지 전부(병렬)
#   bash scripts/docker-verify.sh debian:12 fedora:latest
#
# ⛔ 컨테이너는 베어 VM 을 «대체하지 않는다» — systemd·재부팅·서비스 등록은 여기서 못 잰다(§2c 의 VM 몫).
# 판정: 줄마다 `fix_rc` (doctor --fix 종료 코드) · `doctor_rc` · 남은 manual 항목. 로그는 출력 디렉토리에 남는다.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [ "$#" -eq 0 ]; then
  set -- ubuntu:24.04 ubuntu:26.04 debian:12 fedora:latest amazonlinux:2023 amazonlinux:2
fi
command -v docker >/dev/null 2>&1 || { echo "⛔ docker not on PATH (macOS: start OrbStack or Docker Desktop)" >&2; exit 127; }
docker info >/dev/null 2>&1 || { echo "⛔ docker engine is not running" >&2; exit 1; }

OUT="${ELANOUS_DOCKER_VERIFY_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/elanous-docker-verify.XXXXXX")}"
CTX="$OUT/ctx"
mkdir -p "$CTX"
echo "▶ packing this checkout → $CTX" >&2
(cd "$ROOT" && bun pm pack --destination "$CTX" >/dev/null 2>&1) || { echo "⛔ bun pm pack failed" >&2; exit 1; }
TGZ="$(ls "$CTX"/*.tgz 2>/dev/null | head -1)"
[ -n "$TGZ" ] || { echo "⛔ no tarball produced in $CTX" >&2; exit 1; }
mv "$TGZ" "$CTX/elanous.tgz"
# bun pm pack drops the gitignored apps/pwa/out — materialize it (install.sh exits 4 without it).
(cd "$ROOT" && bun -e 'import { packPwaOutput } from "./scripts/lib/pack-pwa-output.ts"; packPwaOutput(process.argv[1], process.argv[2]);' "$ROOT" "$CTX/elanous.tgz") || { echo "⛔ PWA build missing: apps/pwa/out/index.html (build it first: bun bin/elanous.mjs nexus build)" >&2; exit 1; }
cp "$ROOT/scripts/install.sh" "$ROOT/docker/verify/Dockerfile" "$CTX/"

for base in "$@"; do
  tag="$(printf '%s' "$base" | tr ':/' '--')"
  (
    if docker build -t "elanous-verify:$tag" --build-arg BASE="$base" "$CTX" > "$OUT/build-$tag.log" 2>&1; then
      docker run --rm "elanous-verify:$tag" > "$OUT/run-$tag.log" 2>&1
      verdict="$(grep '^\[verify\]' "$OUT/run-$tag.log" | tail -1)"
      # 마지막 doctor(수정 «뒤»)의 「준비 상태:」 블록에서 manual 로 남은 항목만.
      left="$(awk '/^준비 상태:/{blk=""; on=1; next} on && /^[^ ]/{on=0} on{blk=blk $0 "\n"} END{printf "%s", blk}' "$OUT/run-$tag.log" | grep -E '^  [a-z-]+: manual' | sed -E 's/^  ([a-z-]+):.*/\1/' | sort -u | tr '\n' ' ')"
      echo "$base  ${verdict:-[verify] no verdict}  manual: ${left:-none}"
    else
      echo "$base  build FAILED — $OUT/build-$tag.log"
    fi
  ) &
done
wait
echo "logs: $OUT" >&2
