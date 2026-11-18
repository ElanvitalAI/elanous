#!/usr/bin/env bash
# 회원 서버(elanous-members) 릴리스 전환 ⊕ 운영 앱 보존 가드 — MEMBERS-DEPLOY-PRESERVE-APPS.
#
# 상황: 11-15 21:45:52 배포(main 81200b1b)에서 운영 상태 루트의 apps/ 아래 데모 slot 디렉터리가
#       사라졌고(apps mtime 12:45:52Z · 새 PID 기동 직전), member connect 가 503
#       («app is not mounted or app authentication is unavailable») 을 냈다. 지운 주체는 아직 미확정이다.
# 원칙: 운영 앱 데이터(<state-root>/apps)는 «바뀌는 릴리스 트리 밖»에 있어야 하고, 전환은 그것을
#       «건드리지 않았음»을 전·후로 직접 대조한다. 줄어들면 실패하고 이전 상태로 돌아간다. 조용한 소실 0.
#
#   bash scripts/members/members-release-switch.sh snapshot --state-root <dir> --txn <dir>
#   bash scripts/members/members-release-switch.sh verify   --state-root <dir> --txn <dir>
#   bash scripts/members/members-release-switch.sh switch   --state-root <dir> --txn <dir> \
#        --old-release <dir> --new-release <dir> --dropin <systemd drop-in> [--service <unit>]
#   bash scripts/members/members-release-switch.sh restore  --state-root <dir> --txn <dir> [--service <unit>]
#
# - restore: 서비스를 «정지»하고 그 거래 폴더(이전 snapshot)의 사라진 slot 만 되살린 뒤 같은 목록인지 확인한다.
#   재기동은 하지 않는다 — 호출자가 그 다음 옛 릴리스로 전환한다(app-host 는 시동 때 한 번만 apps/ 를 마운트).
#
# - snapshot: apps/ 의 마운트 대상(app.yaml 이 있는 직속 디렉터리 — loadNexusAppHost 와 같은 기준)의
#   이름·app.yaml 해시 목록과 slot 사본을 owner-only 거래 폴더에 남긴다. 회원 DB·자격은 복사하지 않는다.
# - verify: apps/ 가 실재하고(심볼릭 링크 아님) 스냅숏의 모든 slot 이 같은 app.yaml 해시로 남았는지 본다.
# - switch: 릴리스·거래 폴더가 상태 루트와 겹치면 거부 → snapshot → drop-in 의 옛 경로를 새 경로로 원자 교체
#   → daemon-reload·restart → verify. 실패하면 drop-in 복원·재기동 ⊕ 사라진 slot 만(이미 있는 것은 덮지 않음)
#   거래 사본에서 되살리고 rc≠0 으로 끝난다.
# ⛔ 이 스크립트는 원격 접속·클라우드 호출을 하지 않는다 — 회원 호스트 안에서 주인이 돌린다.
set -euo pipefail

MODE="${1:-}"; [ $# -gt 0 ] && shift
STATE_ROOT=""; TXN=""; OLD_RELEASE=""; NEW_RELEASE=""; DROPIN=""; SERVICE="elanous-nexus.service"
while [ $# -gt 0 ]; do
  case "$1" in
    --state-root) STATE_ROOT="${2:-}"; shift 2 ;;
    --txn) TXN="${2:-}"; shift 2 ;;
    --old-release) OLD_RELEASE="${2:-}"; shift 2 ;;
    --new-release) NEW_RELEASE="${2:-}"; shift 2 ;;
    --dropin) DROPIN="${2:-}"; shift 2 ;;
    --service) SERVICE="${2:-}"; shift 2 ;;
    *) echo "⛔ 알 수 없는 인자: $1" >&2; exit 2 ;;
  esac
done

die() { echo "⛔ $*" >&2; exit "${EXIT_CODE:-1}"; }
[ -n "$STATE_ROOT" ] || die "--state-root 가 필요하다"
[ -n "$TXN" ] || die "--txn 이 필요하다"
[ -d "$STATE_ROOT" ] || die "상태 루트가 없다: $STATE_ROOT"
STATE_ROOT="$(cd "$STATE_ROOT" && pwd -P)"
APPS="$STATE_ROOT/apps"
INVENTORY="$TXN/apps-inventory.tsv"

sha() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# 실재하는 경로의 물리 경로 · 아직 없는 경로는 부모를 풀어 잇는다.
physical() {
  local path="$1"
  if [ -d "$path" ]; then (cd "$path" && pwd -P); return; fi
  local parent; parent="$(dirname "$path")"
  [ -d "$parent" ] || die "부모 폴더가 없다: $parent"
  echo "$(cd "$parent" && pwd -P)/$(basename "$path")"
}

# 두 경로가 같거나 한쪽이 다른 쪽 안에 있으면 겹친다 — 릴리스 교체·정리가 상태 루트를 지울 수 있다.
refuse_overlap() {
  local label="$1" path; path="$(physical "$2")"
  case "$path/" in "$STATE_ROOT/"*) die "$label 경로가 상태 루트 안에 있다: $path" ;; esac
  case "$STATE_ROOT/" in "$path/"*) die "$label 경로가 상태 루트를 품는다: $path" ;; esac
}

list_slots() {
  [ -d "$APPS" ] && [ ! -L "$APPS" ] || return 0
  local dir
  for dir in "$APPS"/*/; do
    [ -d "$dir" ] || continue
    dir="${dir%/}"
    [ -L "$dir" ] && continue
    [ -f "$dir/app.yaml" ] || continue
    printf '%s\t%s\n' "$(basename "$dir")" "$(sha "$dir/app.yaml")"
  done | LC_ALL=C sort
}

do_snapshot() {
  refuse_overlap "거래 폴더" "$TXN"
  [ -d "$APPS" ] && [ ! -L "$APPS" ] || die "apps 폴더가 없다(또는 심볼릭 링크): $APPS — 전환 전에 먼저 확인한다"
  if [ -e "$TXN" ] && [ -n "$(ls -A "$TXN" 2>/dev/null)" ]; then die "거래 폴더가 비어 있지 않다: $TXN"; fi
  mkdir -p "$TXN/slots"; chmod 700 "$TXN"
  list_slots > "$INVENTORY"
  local slug _hash
  while IFS=$'\t' read -r slug _hash; do
    [ -n "$slug" ] || continue
    cp -a "$APPS/$slug" "$TXN/slots/$slug"
  done < "$INVENTORY"
  echo "📸 apps 스냅숏: slot $(grep -c . "$INVENTORY" || true)개 · $INVENTORY"
}

# 0 = 보존됨 · 1 = 소실/변경(사유를 stderr 로)
check_preserved() {
  [ -f "$INVENTORY" ] || die "스냅숏이 없다: $INVENTORY"
  if [ ! -d "$APPS" ] || [ -L "$APPS" ]; then echo "⛔ apps 폴더가 사라졌다: $APPS" >&2; return 1; fi
  local before after missing=0 slug hash now
  before="$(grep -c . "$INVENTORY" || true)"
  after="$(list_slots | grep -c . || true)"
  while IFS=$'\t' read -r slug hash; do
    [ -n "$slug" ] || continue
    if [ ! -f "$APPS/$slug/app.yaml" ] || [ -L "$APPS/$slug" ]; then
      echo "⛔ slot 이 사라졌다: $slug" >&2; missing=1; continue
    fi
    now="$(sha "$APPS/$slug/app.yaml")"
    [ "$now" = "$hash" ] || { echo "⛔ slot app.yaml 이 바뀌었다: $slug" >&2; missing=1; }
  done < "$INVENTORY"
  if [ "$before" -gt 0 ] && [ "$after" -eq 0 ]; then echo "⛔ 마운트 대상 slot 이 $before → 0 으로 줄었다" >&2; missing=1; fi
  [ "$missing" -eq 0 ] || return 1
  echo "✅ apps 보존: slot $before → $after"
}

restore_missing_slots() {
  mkdir -p "$APPS"
  local slug _hash
  while IFS=$'\t' read -r slug _hash; do
    [ -n "$slug" ] || continue
    [ -e "$APPS/$slug" ] && continue          # 있는 것은 덮지 않는다(다르면 사람 판단)
    cp -a "$TXN/slots/$slug" "$APPS/.restore-$slug"
    mv "$APPS/.restore-$slug" "$APPS/$slug"
    echo "♻️  slot 복원: $slug" >&2
  done < "$INVENTORY"
}

restart_service() {
  systemctl --user daemon-reload && systemctl --user restart "$SERVICE"
}

stop_service() {
  systemctl --user stop "$SERVICE"
}

do_switch() {
  [ -n "$OLD_RELEASE" ] && [ -n "$NEW_RELEASE" ] && [ -n "$DROPIN" ] || die "--old-release · --new-release · --dropin 이 필요하다"
  refuse_overlap "옛 릴리스" "$OLD_RELEASE"
  refuse_overlap "새 릴리스" "$NEW_RELEASE"
  [ -f "$NEW_RELEASE/bin/elanous.mjs" ] || die "새 릴리스 진입점이 없다: $NEW_RELEASE/bin/elanous.mjs"
  [ -f "$DROPIN" ] || die "drop-in 이 없다: $DROPIN"
  grep -qF "$OLD_RELEASE" "$DROPIN" || die "drop-in 에 옛 릴리스 경로가 없다 — 이미 바뀌었나 확인한다"
  do_snapshot
  cp -p "$DROPIN" "$TXN/dropin.before"
  # 글자 그대로 바꾼다(bash 판마다 다른 치환문 따옴표·& 해석을 피한다).
  local rest out=""; rest="$(cat "$DROPIN")"
  while [[ "$rest" == *"$OLD_RELEASE"* ]]; do
    out+="${rest%%"$OLD_RELEASE"*}$NEW_RELEASE"; rest="${rest#*"$OLD_RELEASE"}"
  done
  printf '%s\n' "$out$rest" > "$DROPIN.tmp-switch"
  mv "$DROPIN.tmp-switch" "$DROPIN"
  local switched=0
  if restart_service; then switched=1; else echo "⛔ 새 릴리스 재기동 실패" >&2; fi
  if [ "$switched" -eq 1 ] && check_preserved; then
    echo "deploy=ok release=$NEW_RELEASE"
    return 0
  fi
  # ⛔ 순서가 본체다: app-host 는 시동할 때 한 번만 apps/ 를 읽어 마운트한다(app-host.ts:850-861).
  #    slot 을 «먼저» 디스크에 되살리고 «그 다음» 옛 릴리스를 띄워야 503 이 남지 않는다.
  echo "↩️  되돌림: 정지 → drop-in 복원 ⊕ 사라진 slot 복원 → 확인 → 옛 릴리스 재기동 → 확인" >&2
  stop_service || echo "⚠️  서비스 정지 실패 — 계속 되돌린다" >&2
  cp -p "$TXN/dropin.before" "$DROPIN"
  restore_missing_slots
  local restored=0
  if check_preserved; then restored=1; else echo "⛔ 재기동 전 slot 복원 확인 실패" >&2; fi
  restart_service || { restored=0; echo "⛔ 옛 릴리스 재기동도 실패 — 즉시 사람 확인" >&2; }
  if [ "$restored" -eq 1 ] && check_preserved; then echo "deploy=rolled-back apps=restored" >&2
  else echo "deploy=rolled-back apps=NOT-restored — 거래 폴더 $TXN 을 보존하고 사람 확인" >&2; fi
  EXIT_CODE=3 die "배포 실패: 운영 앱 보존 가드가 막았다(조용한 소실 0)"
}

do_restore() {
  [ -s "$INVENTORY" ] || die "복원할 스냅숏이 없다: $INVENTORY"
  stop_service || echo "⚠️  서비스 정지 실패 — 계속 복원한다" >&2
  restore_missing_slots
  check_preserved || EXIT_CODE=3 die "거래 사본으로도 slot 을 되살리지 못했다 — $TXN 보존 · 사람 확인"
  echo "restore=ok txn=$TXN"
}

case "$MODE" in
  snapshot) do_snapshot ;;
  restore) do_restore ;;
  verify) check_preserved || EXIT_CODE=3 die "운영 앱 보존 가드 실패" ;;
  switch) do_switch ;;
  *) die "snapshot · verify · switch · restore 중 하나를 준다" ;;
esac
