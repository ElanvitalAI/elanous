#!/usr/bin/env bash
# 회원 서버(elanous-members) 정식 배포 길 — MEMBERS-DEPLOY-PATH (설계: 내부 문서 `MEMBERS-DEPLOY-PATH`).
#
# 상황: 11-15 21:45 배포는 일회용 호스트 스크립트(member-37877-unit-switch.py)가 drop-in 경로를 바꾸고
#       재기동한 뒤 health 401 만 보고 deploy=ok 를 찍었다. 그 사이 운영 apps 의 데모 slot 이 사라져
#       member connect 가 503 이 됐다. 이 스크립트는 그 일회용 스크립트들을 대신하는 «얇은 지휘자»다.
# 순서: 릴리스를 새 불변 폴더에 들임 → 사전 점검 → (선택) 사전 훅(A176 DB 백업) → members-release-switch.sh switch
#       → health 폴링(유한 횟수) → (선택) slot 스모크 → (선택) 사후 훅 → 두 번째 apps verify(늦은 소실) → 릴리스 재대조.
#       health·스모크·사후 훅이 실패하면 같은 switch 스크립트를 거꾸로(새→옛) 불러 되돌린다.
#
#   bash scripts/members/members-deploy.sh \
#     (--release-tarball <tar.gz> [--tarball-sha256 <hex>] | --release-dir <dir>) \
#     --state-root <dir> --dropin <file> --old-release <dir> --health-url <url> \
#     [--releases-root <dir>] [--release-name <name>] [--txn-root <dir>] [--service <unit>] \
#     [--health-expect <code>] [--health-attempts <n>] [--health-interval <sec>] \
#     [--smoke-slot <slug> --smoke-url <url with {slot}> --smoke-expect <code[,code]>] \
#     [--pre-hook <cmd>] [--post-hook <cmd>] [--min-free-mb <n>] [--no-install] [--bun <path>] [--dry-run]
#
# 종료 코드: 0 성공 · 1 사전 점검/들이기 실패(서비스 손대기 전) · 2 인자 · 3 switch 가드가 막고 되돌림
#            4 health 실패 → 되돌림 · 5 되돌림까지 실패(사람 확인) · 6 스모크/사후 훅 실패 → 되돌림
#            7 health 뒤 apps 소실(늦은 소실) — 자동 되돌림 없음, 거래 폴더 보존 · 8 릴리스 내용이 바뀜
# ⛔ 이 스크립트는 ssh·gcloud·IAP·docker 를 부르지 않는다 — 회원 호스트 안에서 주인(N04/OP)이 돌린다.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SWITCH="$HERE/members-release-switch.sh"

TARBALL=""; TARBALL_SHA=""; RELEASE_DIR=""; STATE_ROOT=""; DROPIN=""; OLD_RELEASE=""; HEALTH_URL=""
RELEASES_ROOT=""; RELEASE_NAME=""; TXN_ROOT=""; SERVICE="elanous-nexus.service"
# 익명 /v1/members/home 은 401 이 정상이다(/v1/health 는 404 라 health 문이 아니다).
HEALTH_EXPECT="401"          # 출처: #38015 · MEMBER-37877 런북 «Baseline health» 익명 401
HEALTH_ATTEMPTS="30"         # 출처: #38015 · MEMBER-37877 런북 3단계 90초 마감 = 30회 × 3초
HEALTH_INTERVAL="3"          # 출처: #38015 · 위와 같은 90초 마감
CURL_MAX_TIME="5"            # 출처: #38015 · 한 번의 probe 가 90초 마감을 혼자 먹지 않게
MIN_FREE_MB="2048"           # 출처: #38015 · MEMBER-37877 런북 — 아카이브 185MB ⊕ node_modules ~1GB 의 약 두 배
SMOKE_SLOT=""; SMOKE_URL=""; SMOKE_EXPECT=""; PRE_HOOK=""; POST_HOOK=""; INSTALL=1; BUN="bun"; DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --release-tarball) TARBALL="${2:-}"; shift 2 ;;
    --tarball-sha256) TARBALL_SHA="${2:-}"; shift 2 ;;
    --release-dir) RELEASE_DIR="${2:-}"; shift 2 ;;
    --state-root) STATE_ROOT="${2:-}"; shift 2 ;;
    --dropin) DROPIN="${2:-}"; shift 2 ;;
    --old-release) OLD_RELEASE="${2:-}"; shift 2 ;;
    --health-url) HEALTH_URL="${2:-}"; shift 2 ;;
    --releases-root) RELEASES_ROOT="${2:-}"; shift 2 ;;
    --release-name) RELEASE_NAME="${2:-}"; shift 2 ;;
    --txn-root) TXN_ROOT="${2:-}"; shift 2 ;;
    --service) SERVICE="${2:-}"; shift 2 ;;
    --health-expect) HEALTH_EXPECT="${2:-}"; shift 2 ;;
    --health-attempts) HEALTH_ATTEMPTS="${2:-}"; shift 2 ;;
    --health-interval) HEALTH_INTERVAL="${2:-}"; shift 2 ;;
    --smoke-slot) SMOKE_SLOT="${2:-}"; shift 2 ;;
    --smoke-url) SMOKE_URL="${2:-}"; shift 2 ;;
    --smoke-expect) SMOKE_EXPECT="${2:-}"; shift 2 ;;
    --pre-hook) PRE_HOOK="${2:-}"; shift 2 ;;
    --post-hook) POST_HOOK="${2:-}"; shift 2 ;;
    --min-free-mb) MIN_FREE_MB="${2:-}"; shift 2 ;;
    --no-install) INSTALL=0; shift ;;
    --bun) BUN="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "⛔ 알 수 없는 인자: $1" >&2; exit 2 ;;
  esac
done

RUN_TXN=""
LOG_FILE=""
utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# 관측 줄: 한 줄 = 한 단계 · 값(비밀·회원 데이터)은 싣지 않는다.
obs() {
  local line; line="members-deploy step=$1 result=$2 utc=$(utc)${3:+ $3}"
  echo "$line"
  if [ -n "$LOG_FILE" ]; then echo "$line" >> "$LOG_FILE"; fi
}
die() {
  local code="$1"; shift
  echo "⛔ $*" >&2
  if [ -n "$LOG_FILE" ]; then echo "members-deploy step=exit result=fail code=$code utc=$(utc)" >> "$LOG_FILE"; fi
  if [ -n "$RUN_TXN" ]; then echo "   거래 폴더: $RUN_TXN" >&2; fi
  exit "$code"
}
usage_die() { echo "⛔ $*" >&2; exit 2; }

# ── 인자 검사 ────────────────────────────────────────────────────────────────
if [ -n "$TARBALL" ] && [ -n "$RELEASE_DIR" ]; then usage_die "--release-tarball 과 --release-dir 중 하나만 준다"; fi
[ -n "$TARBALL" ] || [ -n "$RELEASE_DIR" ] || usage_die "--release-tarball 또는 --release-dir 이 필요하다"
for pair in "state-root:$STATE_ROOT" "dropin:$DROPIN" "old-release:$OLD_RELEASE" "health-url:$HEALTH_URL"; do
  [ -n "${pair#*:}" ] || usage_die "--${pair%%:*} 가 필요하다"
done
for pair in "health-attempts:$HEALTH_ATTEMPTS" "health-interval:$HEALTH_INTERVAL" "min-free-mb:$MIN_FREE_MB" "health-expect:$HEALTH_EXPECT"; do
  case "${pair#*:}" in ''|*[!0-9]*) usage_die "--${pair%%:*} 는 음이 아닌 정수다: ${pair#*:}" ;; esac
done
[ "$HEALTH_ATTEMPTS" -ge 1 ] || usage_die "--health-attempts 는 1 이상이다"
if [ -n "$SMOKE_SLOT" ]; then
  [ -n "$SMOKE_URL" ] && [ -n "$SMOKE_EXPECT" ] || usage_die "--smoke-slot 에는 --smoke-url 과 --smoke-expect 가 함께 필요하다"
  case "$SMOKE_SLOT" in *[!A-Za-z0-9._-]*|.*) usage_die "--smoke-slot 이름이 이상하다: $SMOKE_SLOT" ;; esac
fi
[ -d "$STATE_ROOT" ] || die 1 "상태 루트가 없다: $STATE_ROOT"
STATE_ROOT="$(cd "$STATE_ROOT" && pwd -P)"
[ -d "$STATE_ROOT/apps" ] && [ ! -L "$STATE_ROOT/apps" ] || die 1 "apps 폴더가 없다(또는 심볼릭 링크): $STATE_ROOT/apps"
[ -d "$OLD_RELEASE" ] || die 1 "옛 릴리스가 없다: $OLD_RELEASE"
[ -f "$DROPIN" ] || die 1 "drop-in 이 없다: $DROPIN"
[ -f "$SWITCH" ] || die 1 "switch 스크립트가 없다: $SWITCH"

sha() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}
physical() {
  local path="$1"
  if [ -d "$path" ]; then (cd "$path" && pwd -P); return; fi
  local parent; parent="$(dirname "$path")"
  [ -d "$parent" ] || die 1 "부모 폴더가 없다: $parent"
  echo "$(cd "$parent" && pwd -P)/$(basename "$path")"
}
refuse_overlap() {
  local label="$1" path; path="$(physical "$2")"
  case "$path/" in "$STATE_ROOT/"*) die 1 "$label 경로가 상태 루트 안에 있다: $path" ;; esac
  case "$STATE_ROOT/" in "$path/"*) die 1 "$label 경로가 상태 루트를 품는다: $path" ;; esac
}

# drop-in 과의 글자 대조·switch 인자에는 받은 글자 그대로 쓰고, 같은지 비교만 물리 경로로 한다.
OLD_PHYS="$(physical "$OLD_RELEASE")"
refuse_overlap "옛 릴리스" "$OLD_RELEASE"

# ── 새 릴리스 자리 정하기 ─────────────────────────────────────────────────────
if [ -n "$RELEASE_DIR" ]; then
  [ -d "$RELEASE_DIR" ] || die 1 "릴리스 폴더가 없다: $RELEASE_DIR"
  refuse_overlap "새 릴리스" "$RELEASE_DIR"
  NEW_RELEASE="$(physical "$RELEASE_DIR")"
  [ -f "$NEW_RELEASE/bin/elanous.mjs" ] || die 1 "새 릴리스 진입점이 없다: $NEW_RELEASE/bin/elanous.mjs"
else
  [ -f "$TARBALL" ] || die 1 "릴리스 아카이브가 없다: $TARBALL"
  [ -n "$RELEASES_ROOT" ] || RELEASES_ROOT="$(dirname "$OLD_RELEASE")"
  [ -d "$RELEASES_ROOT" ] || die 1 "릴리스 루트가 없다: $RELEASES_ROOT"
  RELEASES_ROOT="$(physical "$RELEASES_ROOT")"
  # 릴리스 루트(보통 홈)는 상태 루트를 품어도 된다 — 겹치면 안 되는 것은 그 아래 «새 릴리스 폴더» 자신이다.
  case "$RELEASES_ROOT/" in "$STATE_ROOT/"*) die 1 "릴리스 루트 경로가 상태 루트 안에 있다: $RELEASES_ROOT" ;; esac
  if [ -z "$RELEASE_NAME" ]; then
    RELEASE_NAME="$(basename "$TARBALL")"; RELEASE_NAME="${RELEASE_NAME%.tar.gz}"; RELEASE_NAME="${RELEASE_NAME%.tgz}"
  fi
  case "$RELEASE_NAME" in ''|*/*|.*) die 2 "릴리스 이름이 이상하다: $RELEASE_NAME" ;; esac
  NEW_RELEASE="$RELEASES_ROOT/elanous-members-$RELEASE_NAME"
  # 불변: 같은 이름 폴더가 있으면 덮지 않는다(새 판 = 새 이름).
  [ ! -e "$NEW_RELEASE" ] || die 1 "새 릴리스 폴더가 이미 있다(덮어쓰기 금지 · 새 이름을 준다): $NEW_RELEASE"
fi
[ "$(physical "$NEW_RELEASE")" != "$OLD_PHYS" ] || die 1 "새 릴리스가 옛 릴리스와 같다: $NEW_RELEASE"
grep -qF "$OLD_RELEASE" "$DROPIN" || die 1 "drop-in 에 옛 릴리스 경로가 없다 — 이미 바뀌었나 확인한다: $OLD_RELEASE"

[ -n "$TXN_ROOT" ] || TXN_ROOT="$(dirname "$NEW_RELEASE")/.members-deploy-txn"
refuse_overlap "거래 루트" "$TXN_ROOT"

# ── dry-run: 계획만 ──────────────────────────────────────────────────────────
if [ "$DRY_RUN" -eq 1 ]; then
  echo "🧭 members-deploy 계획(dry-run · 아무것도 바꾸지 않는다)"
  if [ -n "$TARBALL" ]; then
    echo "  1. 들이기: $TARBALL → $NEW_RELEASE (새 폴더 · 덮어쓰기 금지)${TARBALL_SHA:+ · sha256 고정}"
    [ "$INSTALL" -eq 1 ] && echo "     의존성: ELANOUS_SKIP_POSTINSTALL=1 $BUN install --frozen-lockfile"
  else
    echo "  1. 들이기: 이미 들인 폴더 그대로 $NEW_RELEASE"
  fi
  echo "  2. 사전 점검: 디스크 여유 ≥ ${MIN_FREE_MB}MB · 릴리스/거래 폴더가 상태 루트 밖 · $SERVICE NeedDaemonReload=no"
  echo "  3. 사전 훅: ${PRE_HOOK:-(없음)}"
  echo "  4. 전환: members-release-switch.sh switch --old-release $OLD_RELEASE --new-release $NEW_RELEASE --dropin $DROPIN"
  echo "  5. health: $HEALTH_URL = $HEALTH_EXPECT · 최대 ${HEALTH_ATTEMPTS}회 · ${HEALTH_INTERVAL}초 간격 · 실패 시 되돌림"
  if [ -n "$SMOKE_SLOT" ]; then echo "  6. 스모크: slot $SMOKE_SLOT · ${SMOKE_URL//\{slot\}/$SMOKE_SLOT} ∈ {$SMOKE_EXPECT}"; else echo "  6. 스모크: (없음)"; fi
  echo "  7. 사후 훅: ${POST_HOOK:-(없음)}"
  echo "  8. 두 번째 apps verify(늦은 소실) · 릴리스 내용 재대조"
  echo "  거래 루트: $TXN_ROOT"
  obs plan dry-run "new=$NEW_RELEASE"
  exit 0
fi

# ── 거래 폴더 ────────────────────────────────────────────────────────────────
mkdir -p "$TXN_ROOT"; chmod 700 "$TXN_ROOT"
RUN_TXN="$TXN_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-$$"
[ ! -e "$RUN_TXN" ] || die 1 "거래 폴더가 이미 있다: $RUN_TXN"
mkdir -m 700 "$RUN_TXN"
LOG_FILE="$RUN_TXN/deploy.log"
obs start ok "old=$OLD_RELEASE new=$NEW_RELEASE service=$SERVICE"

# ── 사전 점검 1: 디스크 ──────────────────────────────────────────────────────
free_kb="$(df -Pk "$(dirname "$NEW_RELEASE")" | awk 'NR==2 {print $4}')"
case "$free_kb" in ''|*[!0-9]*) die 1 "디스크 여유를 읽지 못했다: $(dirname "$NEW_RELEASE")" ;; esac
[ $((free_kb / 1024)) -ge "$MIN_FREE_MB" ] || die 1 "디스크 여유가 모자라다: $((free_kb / 1024))MB < ${MIN_FREE_MB}MB"
obs preflight-disk ok "free_mb=$((free_kb / 1024))"

# ── 들이기 ───────────────────────────────────────────────────────────────────
if [ -n "$TARBALL" ]; then
  tar_sha="$(sha "$TARBALL")"
  if [ -n "$TARBALL_SHA" ] && [ "$tar_sha" != "$TARBALL_SHA" ]; then die 1 "아카이브 sha256 불일치: $tar_sha ≠ $TARBALL_SHA"; fi
  staging="$RELEASES_ROOT/.staging-$RELEASE_NAME-$$"
  [ ! -e "$staging" ] || die 1 "임시 들이기 폴더가 이미 있다: $staging"
  mkdir -m 755 "$staging"
  tar -xzf "$TARBALL" -C "$staging" || { rm -rf "$staging"; die 1 "아카이브 풀기 실패: $TARBALL"; }
  src_root="$staging"
  if [ ! -f "$staging/bin/elanous.mjs" ]; then
    # git archive --prefix 처럼 꼭대기 폴더가 하나 있으면 그 안을 릴리스로 본다.
    only=""; count=0
    for entry in "$staging"/* "$staging"/.[!.]*; do [ -e "$entry" ] || continue; count=$((count + 1)); only="$entry"; done
    if [ "$count" -eq 1 ] && [ -f "$only/bin/elanous.mjs" ]; then src_root="$only"; fi
  fi
  [ -f "$src_root/bin/elanous.mjs" ] || { rm -rf "$staging"; die 1 "아카이브에 bin/elanous.mjs 가 없다"; }
  if [ "$INSTALL" -eq 1 ] && [ ! -d "$src_root/node_modules" ]; then
    (cd "$src_root" && ELANOUS_SKIP_POSTINSTALL=1 "$BUN" install --frozen-lockfile) > "$RUN_TXN/install.log" 2>&1 \
      || { rm -rf "$staging"; die 1 "의존성 설치 실패 — $RUN_TXN/install.log"; }
  fi
  mv "$src_root" "$NEW_RELEASE"
  [ "$src_root" = "$staging" ] || rmdir "$staging"
  obs stage ok "release=$NEW_RELEASE tarball_sha256=$tar_sha"
else
  obs stage ok "release=$NEW_RELEASE mode=in-place"
fi
refuse_overlap "새 릴리스" "$NEW_RELEASE"

# 불변 대조용 영수증 — 진입점·의존성 고정 파일의 해시.
receipt() {
  local file
  for file in bin/elanous.mjs package.json bun.lock; do
    if [ -f "$NEW_RELEASE/$file" ]; then printf '%s\t%s\n' "$file" "$(sha "$NEW_RELEASE/$file")"; else printf '%s\t-\n' "$file"; fi
  done
}
receipt > "$RUN_TXN/release.receipt"

# ── 사전 점검 2: 유닛 상태 ───────────────────────────────────────────────────
# 11-15 런북: 디스크에서 사라진 drop-in 이 «적재된 채» 남아 있으면 daemon-reload 가 그 설정을 떨군다.
need_reload="$(systemctl --user show -p NeedDaemonReload --value "$SERVICE" 2>/dev/null || true)"
[ "$need_reload" != "yes" ] || die 1 "$SERVICE NeedDaemonReload=yes — reload 하면 적재된 설정을 잃을 수 있다 · 먼저 사람 확인"
obs preflight-unit ok "need_daemon_reload=${need_reload:-unknown}"

# ── 사전 훅(A176 DB 백업 등 · 묶지 않는다) ──────────────────────────────────
export MEMBERS_DEPLOY_TXN="$RUN_TXN" MEMBERS_DEPLOY_NEW_RELEASE="$NEW_RELEASE" MEMBERS_DEPLOY_OLD_RELEASE="$OLD_RELEASE" MEMBERS_DEPLOY_STATE_ROOT="$STATE_ROOT"
if [ -n "$PRE_HOOK" ]; then
  bash -c "$PRE_HOOK" || die 1 "사전 훅 실패 — 서비스는 손대지 않았다"
  obs pre-hook ok
fi

# switch 스크립트의 «deploy=…» 줄은 이 지휘자의 최종 판정과 헷갈리지 않게 «switch=…» 로 바꿔 싣는다.
run_switch() { bash "$SWITCH" "$@" 2>&1 | sed 's/^deploy=/switch=/'; }

rollback() {
  local why="$1" code="$2"
  # ⛔ 순서가 본체다: 역방향 switch 는 «지금» 상태를 스냅숏하므로, slot 이 이미 빠졌다면 줄어든 목록과 비교해 통과한다.
  #    그래서 정방향 전환 «전» 스냅숏($RUN_TXN/switch)으로 먼저 정지→복원→확인하고, 그 다음에 옛 릴리스로 되돌린다.
  echo "↩️  되돌림($why): 정지 → 전환 전 slot 복원 → 확인 → switch 거꾸로(새 → 옛) → 원본 대조" >&2
  if ! run_switch restore --state-root "$STATE_ROOT" --txn "$RUN_TXN/switch" --service "$SERVICE"; then
    obs rollback fail "why=$why stage=restore"
    die 5 "배포 실패: $why · 전환 전 slot 복원 실패 — 옛 릴리스를 slot 없이 띄우지 않는다 · $RUN_TXN/switch 보존 · 즉시 사람 확인"
  fi
  if run_switch switch --state-root "$STATE_ROOT" --txn "$RUN_TXN/rollback" \
      --old-release "$NEW_RELEASE" --new-release "$OLD_RELEASE" --dropin "$DROPIN" --service "$SERVICE"; then
    if bash "$SWITCH" verify --state-root "$STATE_ROOT" --txn "$RUN_TXN/switch" >/dev/null; then
      obs rollback ok "why=$why apps=original"
      echo "deploy=rolled-back why=$why"
      die "$code" "배포 실패: $why → 옛 릴리스로 되돌렸다"
    fi
    obs rollback fail "why=$why apps=CHANGED-since-switch"
    die 5 "배포 실패: $why · 옛 릴리스로 돌렸지만 apps 가 전환 전과 다르다 — $RUN_TXN/switch 보존 · 즉시 사람 확인"
  fi
  obs rollback fail "why=$why"
  die 5 "배포 실패: $why · 되돌림도 실패 — 즉시 사람 확인"
}

# ── 전환 ─────────────────────────────────────────────────────────────────────
if ! run_switch switch --state-root "$STATE_ROOT" --txn "$RUN_TXN/switch" \
    --old-release "$OLD_RELEASE" --new-release "$NEW_RELEASE" --dropin "$DROPIN" --service "$SERVICE"; then
  obs switch fail
  die 3 "전환 실패 — switch 스크립트가 막고 스스로 되돌렸다"
fi
obs switch ok

# ── health 폴링 ──────────────────────────────────────────────────────────────
probe() { curl -s -o /dev/null -w '%{http_code}' --max-time "$CURL_MAX_TIME" "$1" 2>/dev/null || true; }
attempt=0; code=""
while [ "$attempt" -lt "$HEALTH_ATTEMPTS" ]; do
  attempt=$((attempt + 1))
  code="$(probe "$HEALTH_URL")"
  if [ "$code" = "$HEALTH_EXPECT" ]; then break; fi
  if [ "$attempt" -lt "$HEALTH_ATTEMPTS" ]; then sleep "$HEALTH_INTERVAL"; fi
done
if [ "$code" != "$HEALTH_EXPECT" ]; then
  obs health fail "last=${code:-none} attempts=$attempt"
  rollback "health ${code:-none}≠$HEALTH_EXPECT" 4
fi
obs health ok "code=$code attempts=$attempt"

# ── 스모크: 알려진 slot 이 디스크와 응답 모두에 살아 있나 ──────────────────
if [ -n "$SMOKE_SLOT" ]; then
  [ -f "$STATE_ROOT/apps/$SMOKE_SLOT/app.yaml" ] || { obs smoke fail "slot=$SMOKE_SLOT disk=absent"; rollback "smoke slot $SMOKE_SLOT 디스크에 없음" 6; }
  smoke_code="$(probe "${SMOKE_URL//\{slot\}/$SMOKE_SLOT}")"
  case ",$SMOKE_EXPECT," in
    *",$smoke_code,"*) obs smoke ok "slot=$SMOKE_SLOT code=$smoke_code" ;;
    *) obs smoke fail "slot=$SMOKE_SLOT code=${smoke_code:-none}"; rollback "smoke ${smoke_code:-none}∉{$SMOKE_EXPECT}" 6 ;;
  esac
fi

# ── 사후 훅(A176 verify-post 등) ─────────────────────────────────────────────
if [ -n "$POST_HOOK" ]; then
  bash -c "$POST_HOOK" || { obs post-hook fail; rollback "사후 훅 실패" 6; }
  obs post-hook ok
fi

# ── 두 번째 verify: health 뒤 늦게 사라진 slot 을 잡는다 ────────────────────
if ! bash "$SWITCH" verify --state-root "$STATE_ROOT" --txn "$RUN_TXN/switch"; then
  obs verify-late fail
  echo "deploy=apps-lost-after-health" >&2
  die 7 "health 뒤 운영 apps 가 줄었다 — 자동 되돌림 안 함 · slot 사본: $RUN_TXN/switch/slots · 정지 → 복원 → 재기동 순서로 사람 확인"
fi
obs verify-late ok

if ! receipt | cmp -s - "$RUN_TXN/release.receipt"; then
  obs release-drift fail
  die 8 "배포 중 새 릴리스 내용이 바뀌었다: $NEW_RELEASE"
fi
obs release-drift ok
echo "deploy=ok release=$NEW_RELEASE txn=$RUN_TXN"
