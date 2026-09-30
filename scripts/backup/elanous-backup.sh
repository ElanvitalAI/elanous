#!/usr/bin/env bash
# elanous 의 «되돌릴 수 없는» 상태를 GCS 로 뜬다.
#
#   bash scripts/backup/elanous-backup.sh --dry-run          ⛔ 처음 쓰는 창은 반드시 이것부터
#   bash scripts/backup/elanous-backup.sh
#   bash scripts/backup/elanous-backup.sh --install          ⭐ ~/.elanous/bin/ 에 «심는다»(크론이 이걸 부른다)
#
# ⛔⭐ **왜 「심는」 단계가 있나** — 크론을 «어느 저장소 트리»에 묶으면 그 트리가 pull 하기 «전»까지
#    백업이 «조용히 안 돈다». 이 저장소가 반복해 겪는 「설치했는데 안 돈다」가 바로 그것이다.
#    ⇒ 크론은 트리에 안 묶인 `~/.elanous/bin/elanous-backup.sh` 를 부르고, 이 파일이 그 사본의 «출처»다.
#    ⚠️ 그래서 사본은 «늙는다» — 심은 사본은 자기 출처와 심은 시각을 «스스로 말한다»(아래 헤더).
#
# ⛔⭐ **무엇을 담고 무엇을 «안» 담는지가 이 스크립트의 본체다.** 아래 목록은 «재서» 정했다(2026-08-26):
#
#   담는다 — git 에도 없고 다시 만들 수도 없는 것
#     ~/.elanous/memory/knowledge.db          자기 지식        ⭐ 가장 대체 불가
#     ~/.elanous/memory/surface_events.db     표면 사건
#     ~/.elanous/logs/logs.db                 관측             (두 트랙이 매일 캐는 자산)
#     ~/.elanous/tasks/tasks.db               미션·태스크
#     ~/.elanous/run-ledger/                  런 원장
#     ~/.elanous/checkpoints/                 체크포인트
#     <각 트리>/.elanous-test/{run-ledger,tasks}   ⭐ 원장은 «한 트리»가 아니다 — 전체의 절반 이상이 밖에 있다
#
#   ⛔ 안 담는다 — «이유를 적는다»
#     ⭐⭐ 2026-08-31(40차): 이 목록을 ***`~/.elanous/` 최상위 «전수»***로 맞췄다.
#        🚨 계기 — `botlab`·`sessions`·`conatus` 가 ***「담는다」에도 「안 담는다」에도 «없었다»***.
#           ⇒ 🔑 ***목록에 «없는 것」은 「검토했으나 뺐다」가 아니라 「아무도 안 봤다」다.***
#     docs/goals/            git 이 이미 갖는다(추적 파일 3,955개 실측). 담으면 «두 번» 지키는 것이다
#     ~/.elanous/worktrees/    131GB · git worktree 라 «재구성된다»
#     ~/.elanous/harness-screens/  1.2GB · 관측 부산물이고 원장이 그 참조를 갖는다
#     ~/.elanous/backups/      171M · ***백업의 백업***이다(crontab 스냅샷) — 원본이 이미 담긴다
#     ~/.elanous/compact-archive/  415M · 압축 «부산물» — 원본 세션이 위에서 담긴다
#     ~/.elanous/dist/ · pty/ · debug/ · debug-tap/   빌드 산출·PTY 잔재·디버그 탭 — «재생성»된다
#     ~/.elanous/nexus/ · autopilot/ · workflows-runs/ · artifacts/
#        ⚠️ ***판단 보류***: 재생성 여부가 이 축에서 «불확실»하다(압축 4~7M 로 싸다).
#        🙋 소유 트랙(🅣·🅢)에 물어 「다시 만들 수 있나」를 «재서» 정한다 — ⛔ 그때까지 «없다」로 두지 않고
#           이 줄로 ***「봤고, 아직 안 정했다」***를 남긴다.
#
# ⛔⭐ 그리고 **살아 있는 SQLite 를 «그대로 복사하지 않는다»** — WAL 이 따로 놀아 깨진 스냅샷이 된다.
#    `VACUUM INTO` 로 «일관된» 스냅샷을 뜬다(읽기 트랜잭션 하나라 쓰는 쪽을 막지 않는다).
# ⚠️ 이것은 «관측 조회»가 아니라 «스냅샷»이다 — CLAUDE.md 의 「logs.db 직접 read 금지」는 조회 규율이고,
#    조회는 여전히 `elanous logs` 로만 한다.
set -uo pipefail

# ── 자기 설치 ────────────────────────────────────────────────────────────────
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
INSTALLED="$HOME/.elanous/bin/elanous-backup.sh"
for a in "$@"; do
  if [ "$a" = "--install" ]; then
    mkdir -p "$(dirname "$INSTALLED")"
    { printf '# ⛔ 이 파일은 «사본»이다. 출처: %s\n# 심은 시각: %s\n' "$SELF" "$(date -u +%FT%TZ)"; cat "$SELF"; } > "$INSTALLED"
    chmod +x "$INSTALLED"
    echo "심었다 → $INSTALLED"
    head -2 "$INSTALLED" | sed 's/^/  /'
    # ⛔⭐⭐ **출처는 «운영 트리»여야 한다** (2026-08-31 · 🅕 40차 · 심자마자 거짓 양성을 냈다)
    #    🚨 사람의 «작업 트리»에서 심으면, 그 트리를 편집할 때마다 아래 낡음 검사가
    #       ***「사본이 다르다」로 «거짓 양성»***을 낸다 — 사본은 main 과 같은데도 그렇다.
    #    🔑 운영 트리(tree-sync 가 20분마다 main 으로 당기는 곳)를 가리켜야
    #       「다르다」가 ***「사본이 main 보다 뒤처졌다」***라는 «쓸모 있는» 뜻이 된다.
    #    🔁 2026-09-26: pilot 트리는 사라졌다 — 운영 출처는 이제 «설치본»이다(매일 04:33 main 으로 갱신).
    case "$SELF" in
      */.local/share/elanous/*) : ;;
      *) echo "  ⚠️ ⛔ 출처가 «설치본이 아니다» — 이 트리를 편집하면 낡음 검사가 «거짓 양성»을 낸다."
         echo "     ⇒ 설치본에서 다시 심어라:  bash $HOME/.local/share/elanous/current/node_modules/elanous/scripts/backup/elanous-backup.sh --install" ;;
    esac
    exit 0
  fi
done

# 🪞⛔⭐⭐⭐ **«심은 사본»이 자기 낡음을 «스스로» 말한다** (2026-08-31 · 🅕 40차)
#    🚨 실물: 크론이 부르는 사본이 ***4일 낡아* 있었고, ***그 사실을 아무도 안 물었다***.
#       그날 마침 다른 착지가 없어서 «무해»했을 뿐이다 — 다음번엔 아니다.
#    ⛔ 이 파일 머리말이 *「사본은 «늙는다»」*고 «이미» 적어 뒀고 출처·시각을 심어 두는 장치까지 있는데,
#       ***그것을 «읽는» 자가 없었다.*** ⇒ 「만들어져 있는데 안 닿는다」의 전형이다.
#    ⭐ 그래서 판정을 «밖»에 두지 않고 여기 둔다 — 크론이 부르는 것은 «이 사본»이므로,
#       ***자기가 자기 출처와 견주는 것***이 이 축에서 유일하게 «항상 도는» 자리다.
#    ⛔ 최신이면 «침묵»한다 — 늘 붙는 줄은 곧 배경이 된다(39차 규율 3b).
#    🚨⛔⭐⭐ **「침묵」의 뜻을 «넓게» 읽지 마라**(2026-08-31 · 40차 실측):
#       이 대조는 ***사본 ↔ «출처 트리»***다 — ***사본 ↔ main 이 «아니다».***
#       📏 실물: 착지 뒤 pilot 이 아직 안 당겨서 ***사본==pilot(침묵)인데 main 과는 «셋» 달랐다***
#          (계획 15 vs 18). ⇒ 그때 「최신이다」로 읽으면 «틀린다».
#       🔑 ⇒ 「침묵 = 출처와 같다」이고, ***「출처가 main 과 같나」는 «다른 자»가 답한다***
#          (카나리아 `fresh` — 당김 주기 안인지까지 본다).
#    ⛔ 그리고 «막지 않는다» — 낡았어도 백업은 도는 게 낫다. 이것은 관문이 아니라 ***귀속***이다.
SRC_LINE="$(head -1 "$SELF" 2>/dev/null)"
case "$SRC_LINE" in
  '# ⛔ 이 파일은 «사본»이다. 출처: '*)
    ORIGIN="${SRC_LINE#*출처: }"
    if [ ! -f "$ORIGIN" ]; then
      echo "⚠️ 사본 대조 «못 했다» — 출처가 없다: $ORIGIN (⛔ 「최신」이 아니다)"
    elif ! diff -q <(tail -n +3 "$SELF") "$ORIGIN" >/dev/null 2>&1; then
      echo "⚠️⛔ ***이 사본은 출처와 «다르다»*** — $(head -2 "$SELF" | tail -1 | sed 's/^# //')"
      echo "   출처: $ORIGIN · 다시 심어라:  bash $ORIGIN --install"
    fi
    ;;
  *)
    # ⛔ 「머리말이 없다」를 «최신»으로 읽지 않는다 — 옛 판으로 심었거나 손으로 복사한 것이다.
    #    📏 2026-08-31 실측: 심어져 있던 사본이 «정확히» 이 상태였다.
    [ "$SELF" = "$INSTALLED" ] && echo "⚠️ 이 사본에 «출처 머리말»이 없다 — 낡았는지 «잴 수 없다». bash <트리>/scripts/backup/elanous-backup.sh --install"
    ;;
esac

# ⛔⭐ 크론 PATH 에는 «Homebrew 가 없다» — 2026-08-27 실물로 값을 치렀다.
#    이 스크립트의 «첫 무인 발화»(04:20)가 200M 을 다 만들어 놓고 마지막 줄에서 죽었다:
#        ~/.elanous/bin/elanous-backup.sh: line 126: ***gcloud: command not found***
#        ⛔ 업로드 실패
#    ⇒ 🔑 크론의 기본 PATH 는 /usr/bin:/bin:/usr/sbin:/sbin 이고 gcloud 는 /opt/homebrew/bin 에 있다.
#    ⛔ 「내 셸에서 되니까 된다」가 그 병이다 — 로그인 셸의 PATH 는 크론에 «없다».
GCLOUD=""
# 🔁 2026-09-26: PATH 를 «먼저» 본다 — crontab 찾기와 같은 꼴. 크론 PATH 엔 Homebrew 가 없어 결과는 같고,
#    시험이 PATH 앞에 둔 스텁을 «건너뛰고» 진짜 gcloud 를 부르는 구멍(🅕 실측: 가짜 HOME 으로 진짜 cp 가 돌았다)을 막는다.
for c in "$(command -v gcloud 2>/dev/null || true)" /opt/homebrew/bin/gcloud /usr/local/bin/gcloud "$HOME/google-cloud-sdk/bin/gcloud"; do
  [ -n "$c" ] && [ -x "$c" ] && { GCLOUD="$c"; break; }
done
if [ -z "$GCLOUD" ]; then
  echo "⛔ gcloud 를 «못 찾았다» (PATH=$PATH) — 담기 전에 멈춘다(200M 을 만들고 버리지 않는다)"
  exit 1
fi

# ⛔ 크론은 로그인 셸 PATH 에 기대면 안 된다. GCLOUD 와 같은 «이름을 찾아 쓰는» 꼴로,
#    기본 cron PATH 에도 있는 후보를 먼저 확인한다. 원격 수집이나 ~/.elanous/backups/ 재백업은 하지 않는다.
CRONTAB=""
# PATH 앞의 명시 wrapper/stub를 먼저 존중한 뒤, cron 기본 PATH 후보를 순회한다.
# GCLOUD의 후보 탐색과 같은 꼴이며, cron이 가진 `/usr/bin:/bin:/usr/sbin:/sbin`만으로도 풀린다.
for c in "$(command -v crontab 2>/dev/null || true)" /usr/bin/crontab /bin/crontab /usr/sbin/crontab /sbin/crontab; do
  [ -n "$c" ] && [ -x "$c" ] && { CRONTAB="$c"; break; }
done

BUCKET="${ELANOUS_BACKUP_BUCKET:-gs://monad-backup-pearlplaygroud}"
# 🔐 자격 묶음은 «다른» 곳으로 간다 — age 로 암호화한 파일 «하나»만, 비공개 S3 버킷으로(2026-09-26 · 대표).
SECRETS_BUCKET="${ELANOUS_BACKUP_SECRETS_BUCKET:-s3://elanvital-ops-backup}"
RECIPIENT_FILE="${ELANOUS_BACKUP_RECIPIENT_FILE:-$HOME/.elanous/backup-key/recipient.txt}"
DRY=0
# 🏷️ 「무인(cron)인가」 — ⛔ 안 주면 「미상」. 「손」으로 «가정하지 않는다».
BACKUP_SOURCE=unknown
_prev=""
for a in "$@"; do
  case "$_prev" in
    --source) case "$a" in cron|manual) BACKUP_SOURCE="$a" ;; *) BACKUP_SOURCE=unknown ;; esac ;;
  esac
  case "$a" in
    --dry-run) DRY=1 ;;
    --bucket) shift; BUCKET="${1:-$BUCKET}" ;;
    gs://*) BUCKET="$a" ;;
    s3://*) SECRETS_BUCKET="$a" ;;
  esac
  _prev="$a"
done

HOST="$(scutil --get LocalHostName 2>/dev/null || hostname -s)"
STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
DEST="$BUCKET/$HOST/$STAMP"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/elanous-backup-XXXXXX")"
# ⛔ 오류 파일을 staging «안»에 두면 그것까지 «올라간다»(첫 판에서 빈 .err 4개가 올라갔다).
ERRDIR="$(mktemp -d "${TMPDIR:-/tmp}/elanous-backup-err-XXXXXX")"
# 🔐 평문 자격이 닿는 «유일한» 자리 — 권한 700 · 종료 시 지운다. ⛔ 평문 tar 는 여기에도 만들지 않는다(파이프로 age 에 흘린다).
SECDIR="$(mktemp -d "${TMPDIR:-/tmp}/elanous-backup-sec-XXXXXX")"; chmod 700 "$SECDIR"
trap 'rm -rf "$STAGE" "$ERRDIR" "$SECDIR"' EXIT

human() { du -sh "$1" 2>/dev/null | cut -f1; }
note()  { printf "  %-42s %8s  %s\n" "$1" "$2" "${3:-}"; }

echo "═══ 담을 것을 «세운다» (staging: $STAGE) ═══"

# ── SQLite: 일관된 스냅샷 ────────────────────────────────────────────────────
# 📋⛔⭐⭐ **「담기로 «계획»한 수」를 «센다»** (2026-08-31 · 40차 · 무인 리뷰 must-fix · `#14607`)
#    🚨 옛 판의 최종 판정은 ***「로컬 스테이징 개수 == 원격 개수」***였다.
#       ⛔ 그런데 스냅샷이 실패하면 그것은 ***애초에 스테이징에 «없다»*** — 그래서 두 수가 «맞고» ✅ 로 끝난다.
#    ⇒ 🔑 ***결손이 「성공」처럼 보인다*** — 이 파일이 고치려던 바로 그 형태가 «실패 경로»에 그대로 있었다.
#    ✅ 그래서 세는 축을 «셋»으로 가른다: 계획(PLANNED) · 담김(스테이징) · 실패(FAILED).
#       ⛔ 「발견 수」와 「담긴 수」를 같은 값으로 두지 않는다.
PLANNED=0
# ⛔ helper 가 «직접» 센다 — 그래서 선언이 helper 보다 «앞»에 있어야 한다.
FAILED=0
snap_db() {
  local src="$1" name="$2"
  # ⛔ «없는 것»은 계획에 안 넣는다 — 그것은 결손이 아니라 「이 기계엔 그게 없다」다.
  [ -f "$src" ] || { note "$name" "-" "⛔ 없다 — 건너뛴다"; return 0; }
  PLANNED=$((PLANNED+1))
  local out="$STAGE/$name.db"
  if ! sqlite3 "$src" "VACUUM INTO '$out'" 2>"$ERRDIR/$name.err"; then
    # ⛔ 실패를 «조용히» 삼키지 않는다 — 그러면 백업에 «구멍»이 생기고 아무도 모른다
    note "$name" "-" "⛔ 스냅샷 실패: $(head -c 90 "$ERRDIR/$name.err")"
    # ⛔⭐ 실패를 «여기»서 센다 — 호출부가 `|| FAILED=…` 를 «기억»해야 하는 형태는 언젠가 잊힌다
    #    (무인 리뷰 must-fix `#14609`: snap_dir 은 실제로 그것을 «안» 하고 있었다).
    FAILED=$((FAILED+1))
    return 1
  fi
  gzip -f "$out"
  note "$name" "$(human "$out.gz")" "← $(human "$src") (VACUUM INTO ⊕ gzip)"
}

# ── 디렉터리: tar.gz ────────────────────────────────────────────────────────
snap_dir() {
  local src="$1" name="$2"
  [ -d "$src" ] || { note "$name" "-" "⛔ 없다 — 건너뛴다"; return 0; }
  PLANNED=$((PLANNED+1))
  local out="$STAGE/$name.tar.gz"
  # ⛔⭐⭐ **`tar` 실패를 «삼키지» 않는다** (무인 리뷰 must-fix `#14609`)
  #    🚨 옛 판은 `2>/dev/null` 로 오류를 버리고 실패해도 note 를 「성공처럼」 찍었다.
  #       ⇒ 반쪽 tarball 이 스테이징에 남으면 ***계획=담김 · 실패=0*** 이라 «완전한 백업»으로 보인다.
  if ! tar -czf "$out" -C "$(dirname "$src")" "$(basename "$src")" 2>"$ERRDIR/$name.err"; then
    # ⛔ 반쪽 산출을 «남기지 않는다» — 남기면 개수만 맞고 내용이 없다
    rm -f "$out"
    note "$name" "-" "⛔ 묶기 실패: $(head -c 90 "$ERRDIR/$name.err")"
    FAILED=$((FAILED+1))
    return 1
  fi
  note "$name" "$(human "$out")" "← $(human "$src")"
}

# ── 이 기계의 살아 있는 crontab ─────────────────────────────────────────────
snap_crontab() {
  local name="machine-crontab"
  local out="$STAGE/$name"
  if [ -z "$CRONTAB" ]; then
    note "$name" "-" "⛔ crontab 을 «못 찾았다» (PATH=$PATH)"
    FAILED=$((FAILED+1))
    return 1
  fi
  if ! "$CRONTAB" -l >"$out" 2>"$ERRDIR/$name.err"; then
    rm -f "$out"
    # 🩸⛔⭐⭐ **「크론이 «없다»」와 「읽기가 «실패»했다」를 종료 코드로는 «못 가른다»** (2026-09-02 · 43차 자기 검토)
    #    📏 실측 — ***둘 다 rc=1*** 이다:
    #       macOS      `sudo crontab -l`  ⇒  `crontab: no crontab for root`
    #       VM(Linux)  `sudo crontab -l`  ⇒  `no crontab for root`
    #    ⇒ 공통 조각 `no crontab for` 로 가른다. ⛔ 이 갈림이 «없으면» 크론이 «없는» 기계에서
    #       백업이 영영 「⛔ 구멍이 있다」로 끝난다 — 결손이 아닌 사실을 결손 칸에 넣는 것이다.
    #    ⛔⭐ 문면이 다른 cron 이면 «실패» 쪽으로 떨어진다 — 그것이 ***안전한 방향***이다
    #       (거짓 경보는 사람이 읽고 끝나지만, 조용한 구멍은 아무도 모른다).
    if grep -q 'no crontab for' "$ERRDIR/$name.err" 2>/dev/null; then
      note "$name" "-" "이 기계엔 크론이 없다 — 건너뛴다 ($(head -c 60 "$ERRDIR/$name.err" | tr -d '\n'))"
      return 0
    fi
    note "$name" "-" "⛔ crontab -l 실패: $(head -c 90 "$ERRDIR/$name.err")"
    FAILED=$((FAILED+1))
    return 1
  fi
  if [ ! -s "$out" ]; then
    rm -f "$out"
    note "$name" "-" "이 기계엔 크론이 없다 — 건너뛴다"
    return 0
  fi
  # 🔒⛔⭐⭐⭐ **자격이 실린 crontab 은 «안 담는다»** (2026-09-02 · 43차 자기 리뷰 must-fix)
  #
  # 🚨 이 걸음은 ***새 데이터 흐름***을 연다 — 살아 있는 crontab 전문이 «원격(GCS)»으로 간다.
  #    ⛔ 오늘 이 기계의 crontab 에 자격이 «없다»는 것은 ***한 번의 실측***이지 «런타임 보장»이 아니다.
  #    🔑 그리고 올라간 뒤에는 ***되돌릴 수 없다*** — 이 저장소의 그 규율 그대로다.
  # ⇒ 담기 «전»에 재고, 걸리면 ***담지 않고 «구멍»으로 낸다***.
  #    ⛔ 「가리고 담기」를 안 한다 — 가린 복원본은 «복원이 아니다»(조용히 못 쓰는 사본이 된다).
  #    ⛔ 「경고만 하고 담기」도 안 한다 — 그러면 사람이 읽기 «전»에 이미 나가 있다.
  #    ⇒ ✅ ***안전한 방향은 「안 담고 이름을 대는 것」***이다. 사람이 자격을 크론 밖으로 옮기면 다음 회차가 담는다.
  # ⛔ **맞은 «값»을 절대 안 낸다** — 줄 번호만. (42차가 「이유를 보여 주자」가 「무엇이든 나가는 문」이 된 값을 치렀다.)
  # ⛔⭐⭐ **값을 «문자 집합»으로 가르려던 첫 판이 «양쪽으로» 틀렸다** (2026-09-02 · 43차 자기 리뷰 2차)
  #    🩸 거짓 양성: `.?` 가 아무 글자나 한 칸 먹어 ***`API_KEY_FILE=/abcdefghijklmnop` 가 걸렸다***
  #       (내 첫 시험은 `~/.config/…` 라 둘째 `/` 가 «우연히» 끊어 줘서 «숨었다» — GOODHART).
  #    🩸 거짓 음성: 값 문자에서 `/` 를 빼서 ***`AWS_SECRET_ACCESS_KEY=abc/def…` 를 «놓쳤다»***
  #       (진짜 AWS 비밀은 `/`·`+` 를 «담는다»).
  # 🔑 ⇒ 가르는 축은 「값 «전체»의 문자」가 아니라 ***「값의 «첫 글자»」***다:
  #       `/`·`~`·`$`·`.` 로 시작하면 ***경로·변수***이고, 글자/숫자로 시작하면 ***리터럴 자격***이다.
  #    ⇒ 첫 글자만 좁히고 «나머지는 공백만 아니면» 받는다 ⇒ 슬래시 든 비밀도 문다.
  # ⛔ 상대 경로(`keys/abcdefghijklmnop`)는 걸린다 — 크론은 절대 경로를 쓰므로 드물고, ***안전한 방향***이다.
  local CRED_RE='(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY)[A-Za-z0-9_]*[[:space:]]*=[[:space:]]*"?'"'"'?[A-Za-z0-9+][^[:space:]]{15,}|sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|[Bb]earer[[:space:]]+[A-Za-z0-9._+/=-]{20,}'
  # 🩸⛔⭐ **`-i` 가 «필수»다** (2026-09-02 · 43차 자기 리뷰 3차 must-fix)
  #    🚨 셸 환경 변수는 소문자로도 쓴다 — `api_key=…` · `aws_secret_access_key=…` 가 «그대로 올라갔다».
  #    ⛔ 대소문자를 구별하는 자는 ***자기가 무엇을 놓치는지 말하지 않는다*** — 조용히 통과시킨다.
  local hits
  hits="$(grep -niE "$CRED_RE" "$out" 2>/dev/null | cut -d: -f1 | tr '\n' ' ')"
  if [ -n "${hits// /}" ]; then
    # 🔐 데이터 백업(GCS)에는 «안» 담는다 — 대신 원문을 자격 묶음으로 넘겨 «암호화해서» 담는다(아래 🔐 단계).
    #    ⛔ 판정은 그대로 둔다(FAILED+1): 「평문 크론에 자격이 있다」는 사실 자체를 계속 사람에게 보인다.
    mv -f "$out" "$SECDIR/machine-crontab.raw" 2>/dev/null || rm -f "$out"
    note "$name" "-" "⛔ 자격처럼 보이는 값이 있어 «안 담았다» — 줄: ${hits}(⛔ 값은 안 낸다). 크론 밖으로 옮겨라"
    FAILED=$((FAILED+1))
    return 1
  fi
  PLANNED=$((PLANNED+1))
  note "$name" "$(human "$out")" "← crontab -l ($(wc -c < "$out" | tr -d ' ') bytes)"
}

snap_db "$HOME/.elanous/memory/knowledge.db"      "elanous-knowledge"
snap_db "$HOME/.elanous/memory/surface_events.db" "elanous-surface-events"
snap_db "$HOME/.elanous/logs/logs.db"             "elanous-logs"
snap_db "$HOME/.elanous/tasks/tasks.db"           "elanous-tasks"
snap_dir "$HOME/.elanous/run-ledger"              "elanous-run-ledger"
snap_dir "$HOME/.elanous/checkpoints"             "elanous-checkpoints"
# 로컬 사용자 crontab 하나만 담는다. 이 호출이 snap_crontab의 실행 경로이며 원격/스냅샷 더미는 범위 밖이다.
snap_crontab
# 🤖⛔⭐⭐ **봇 기억**(2026-08-31 · 40차) — ⛔ 이 파일의 「담는다」 원칙에 «정확히» 걸리는데 «빠져» 있었다.
#    📏 그 안에 있는 것: `canary-tally.json`(판정 이력 «전부») · `never-red-seen.json`(빨강 기억)
#       · `redpath-coverage.json` · 훈련/복원/백업 원장 · 회차 산출(사람에게 간 브리핑의 «원본»)
#    🚨 `canary-tally.json` 을 잃으면 ***38~40차가 매달린 「며칠째」 축이 «통째로» 사라진다*** —
#       그리고 그것은 ***로그가 아니라 「기억」***이라 로그 백업으로 «복구되지 않는다».
#    📏 크기 7.4M(2026-08-31) ⇒ 담는 값이 압도적이다.
#    ⛔ 트리별 `.elanous-test/botlab` 은 «안» 담는다 — 격리 우주의 시험 산출이고 운영 판정이 아니다.
snap_dir "$HOME/.elanous/botlab"                 "elanous-botlab"
# 💬⛔⭐⭐ **대화 세션**(2026-08-31 · 40차) — ⛔ 「담는다」 원칙에 걸리는데 «이유 없이» 빠져 있었다.
#    📏 140M → 압축 ***34M***. `elanous session search` 가 읽는 «그 파일들»이고, 사람과 나눈 말은
#       ***어디에도 다시 없다***(git 에도 로그에도 «전문»이 없다).
snap_dir "$HOME/.elanous/sessions"               "elanous-sessions"
# 🧠⛔⭐⭐ **conatus** — `autopilot_goals.db` · `autopilot_missions.db` 가 여기 산다.
#    📏 138M → 압축 ***33M***. 골·미션 «상태»라 잃으면 그 축의 이력이 통째로 사라진다.
snap_dir "$HOME/.elanous/conatus"                "elanous-conatus"
# 원격 기계의 관측 미러는 이 기계에만 남은 유일한 로컬 사본이다.
snap_dir "$HOME/.elanous/mirrors"                "elanous-mirrors"

# ⭐ 트리마다 흩어진 원장 — ⛔ 「한 트리만 세면 절반 이상을 잃는다」(골 저작 매뉴얼 §0 의 실측)
TREES=0
while IFS= read -r led; do
  tree="$(basename "$(dirname "$(dirname "$led")")")"
  parent="$(basename "$(dirname "$(dirname "$(dirname "$led")")")")"
  snap_dir "$led" "tree-$parent-$tree-run-ledger"
  TREES=$((TREES+1))
done < <(find "$HOME/source" -maxdepth 4 -type d -path '*/.elanous-test/run-ledger' 2>/dev/null)
echo "  (트리 원장 $TREES 개)"

# 🚨⭐⭐ **트리마다 흩어진 «미션·태스크»** (2026-08-31 · 🅕 40차 · ***선언↔실물이 갈려 있었다***)
#    ⛔ 이 파일 머리말은 담는 것으로 «`<각 트리>/.elanous-test/{run-ledger,tasks}`» 라고 «둘»을 적었는데,
#       ***코드는 `run-ledger` «하나»만 돌고 있었다.*** 실측(2026-08-31): 트리별 `tasks.db` ***5개***가
#       존재하는데 GCS 회차엔 `tree-*-tasks*` 가 «한 개도» 없었다.
#    🔑 그리고 그 결손이 «조용했다» — 회차는 매일 초록이었고 「10개 올렸다」고 말했다.
#       ***「무엇을 담기로 했나」와 「무엇을 담았나」를 견주는 자가 없으면 결손은 «성공»처럼 보인다.***
#    ⛔ `tasks.db` 는 config-dir 스코프라 «격리 우주의 미션 이력»이 여기 산다 — git 에도 없고 다시 못 만든다.
#       ⇒ 이 파일의 「담는다」 원칙(*git 에도 없고 다시 만들 수도 없는 것*)에 정확히 걸린다.
TREE_TASKS=0
while IFS= read -r tdb; do
  # ⛔ 경로 깊이가 원장과 «다르다» — 원장은 «디렉터리»(…/.elanous-test/run-ledger)이고
  #    이쪽은 «파일»(…/.elanous-test/tasks/tasks.db)이라 한 칸 더 올라가야 트리 이름이 나온다.
  ttree="$(basename "$(dirname "$(dirname "$(dirname "$tdb")")")")"
  tparent="$(basename "$(dirname "$(dirname "$(dirname "$(dirname "$tdb")")")")")"
  snap_db "$tdb" "tree-$tparent-$ttree-tasks" || true
  TREE_TASKS=$((TREE_TASKS+1))
done < <(find "$HOME/source" -maxdepth 5 -type f -path '*/.elanous-test/tasks/tasks.db' 2>/dev/null)
echo "  (트리 태스크 $TREE_TASKS 개)"

# ── 🔐 자격 묶음: 명시 허용 목록 → tar | age → .age 한 파일 ──────────────────────────
# 대표 2026-09-26: «재로그인 안내는 원하는 백업이 아니다 — 자격까지». 계기 = MCP 로그인값 유실.
# ⛔ 불변식 셋: ① 평문은 $SECDIR(700) 밖에 안 쓴다 — tar 출력을 곧바로 age 로 흘려 평문 묶음 파일조차 안 만든다
#              ② 올리는 것은 `.age` 한 파일뿐이다 ③ 출력에는 «이름과 바이트»만 — 내용은 한 줄도 안 낸다.
# ⛔ 디렉터리를 통째로 담지 않는다 — `~/.codex` 는 4.8GB 대부분이 대화 기록이다(2026-09-26 실측).
SECRET_ITEMS=()   # $HOME 기준 상대 경로
add_secret() { [ -e "$HOME/$1" ] && SECRET_ITEMS+=("$1"); return 0; }
for f in auth.json acp-token export-redactions.tsv config.json ssh-hosts.json; do add_secret ".elanous/$f"; done
for d in "$HOME"/.codex "$HOME"/.codex-*; do
  [ -d "$d" ] || continue; b="$(basename "$d")"
  add_secret "$b/auth.json"; add_secret "$b/config.toml"
done
add_secret ".grok/auth.json"; add_secret ".grok/config.toml"
for f in .config/gh/hosts.yml .aws/credentials .aws/config .npmrc .cargo/credentials.toml .ssh; do add_secret "$f"; done
for f in credentials.db access_tokens.db application_default_credentials.json active_config configurations legacy_credentials; do
  add_secret ".config/gcloud/$f"
done
add_secret "Library/Application Support/Higgsfield/Blender/auth.json"
add_secret "Library/Application Support/Higgsfield/Blender/mcp"
add_secret ".aside/accounts.json"
for f in "$HOME"/Library/LaunchAgents/com.elanous.*.plist; do [ -f "$f" ] && add_secret "Library/LaunchAgents/$(basename "$f")"; done
# API 키 캐시 — 이름은 `src/cli/doctor-fix.ts` defaultKeyNames() 와 같은 규칙: .env.example 의 `KEY=` 를 소문자로.
KEY_CACHE_DIR="${ELANOUS_KEY_CACHE_DIR:-$HOME/.cache}"
ENV_EXAMPLE="$(cd "$(dirname "$SELF")/../.." 2>/dev/null && pwd)/.env.example"
case "$SRC_LINE" in '# ⛔ 이 파일은 «사본»이다. 출처: '*) ENV_EXAMPLE="$(cd "$(dirname "${SRC_LINE#*출처: }")/../.." 2>/dev/null && pwd)/.env.example" ;; esac
KEY_CACHE_N=0; KEY_CACHE_OUTSIDE=0
if [ -f "$ENV_EXAMPLE" ]; then
  while IFS= read -r k; do
    [ -f "$KEY_CACHE_DIR/$k" ] || continue
    case "$KEY_CACHE_DIR/" in
      "$HOME"/*) add_secret "${KEY_CACHE_DIR#"$HOME"/}/$k"; KEY_CACHE_N=$((KEY_CACHE_N+1)) ;;
      # ⛔ 홈 밖 캐시는 «조용히 빼지 않는다» — 묶음은 홈 기준 경로라 못 담으니 실패로 센다(리뷰 must-fix).
      *) KEY_CACHE_OUTSIDE=$((KEY_CACHE_OUTSIDE+1)) ;;
    esac
  done < <(sed -nE 's/^[[:space:]]*(#[[:space:]]*)?([A-Z][A-Z0-9_]*)=.*/\2/p' "$ENV_EXAMPLE" | tr 'A-Z' 'a-z' | sort -u)
fi
HAS_RAW_CRON=0; [ -s "$SECDIR/machine-crontab.raw" ] && HAS_RAW_CRON=1

AGE=""
for c in /opt/homebrew/bin/age /usr/local/bin/age "$(command -v age 2>/dev/null || true)"; do
  [ -n "$c" ] && [ -x "$c" ] && { AGE="$c"; break; }
done
AWS=""
for c in "$(command -v aws 2>/dev/null || true)" /opt/homebrew/bin/aws /usr/local/bin/aws; do
  [ -n "$c" ] && [ -x "$c" ] && { AWS="$c"; break; }
done
SECRETS_STATE=skipped      # skipped | ok | failed
SECRETS_REASON=""
SECRETS_FILE="$SECDIR/secrets.tar.age"
SECRETS_DEST="$SECRETS_BUCKET/$HOST/$STAMP/secrets.tar.age"
echo
echo "═══ 🔐 자격 묶음 (암호화 → $SECRETS_BUCKET) ═══"
N_SECRETS=$(( ${#SECRET_ITEMS[@]} + HAS_RAW_CRON + KEY_CACHE_OUTSIDE ))
if [ "$N_SECRETS" -eq 0 ]; then
  echo "  담을 자격이 없다 — 건너뛴다"
else
  for it in ${SECRET_ITEMS[@]+"${SECRET_ITEMS[@]}"}; do note "secret:$it" "$(human "$HOME/$it")"; done
  [ "$HAS_RAW_CRON" = 1 ] && note "secret:machine-crontab.raw" "$(human "$SECDIR/machine-crontab.raw")" "← 평문 백업에서 뺀 크론 원문"
  echo "  (항목 $N_SECRETS · API 키 캐시 $KEY_CACHE_N$([ "$KEY_CACHE_OUTSIDE" -gt 0 ] && echo " · ⛔ 홈 밖 캐시 $KEY_CACHE_OUTSIDE"))"
  if [ "$KEY_CACHE_OUTSIDE" -gt 0 ]; then
    SECRETS_STATE=failed; SECRETS_REASON="API 키 캐시 $KEY_CACHE_OUTSIDE 개가 홈 밖($KEY_CACHE_DIR)이라 못 담는다 — ELANOUS_KEY_CACHE_DIR 를 홈 안으로"
  elif [ -z "$AGE" ]; then
    SECRETS_STATE=failed; SECRETS_REASON="age 를 못 찾았다 (brew install age)"
  elif [ ! -s "$RECIPIENT_FILE" ]; then
    SECRETS_STATE=failed; SECRETS_REASON="공개 열쇠 파일이 없다: $RECIPIENT_FILE"
  else
    TAR_ARGS=(-C "$HOME")
    for it in ${SECRET_ITEMS[@]+"${SECRET_ITEMS[@]}"}; do TAR_ARGS+=("$it"); done
    [ "$HAS_RAW_CRON" = 1 ] && TAR_ARGS+=(-C "$SECDIR" machine-crontab.raw)
    # ⛔ pipefail 이 켜져 있으므로 tar 가 실패해도 여기서 잡힌다(파이프 뒤 rc 가 아니다).
    if tar -cf - "${TAR_ARGS[@]}" 2>"$ERRDIR/secrets-tar.err" \
         | "$AGE" -r "$(head -1 "$RECIPIENT_FILE" | tr -d '[:space:]')" -o "$SECRETS_FILE" 2>"$ERRDIR/secrets-age.err"; then
      SECRETS_STATE=ok
      note "secrets.tar.age" "$(human "$SECRETS_FILE")" "← tar | age -r (평문 묶음 파일 없음)"
    else
      rm -f "$SECRETS_FILE"
      SECRETS_STATE=failed
      SECRETS_REASON="묶기/암호화 실패: $(head -c 90 "$ERRDIR/secrets-tar.err" "$ERRDIR/secrets-age.err" 2>/dev/null | tr '\n' ' ')"
    fi
  fi
  rm -f "$SECDIR/machine-crontab.raw"
fi

TOTAL="$(du -sh "$STAGE" 2>/dev/null | cut -f1)"
echo
STAGED=$(ls -1 "$STAGE" 2>/dev/null | wc -l | tr -d ' ')
echo "합계 $TOTAL → $DEST"
# 🔢⛔⭐ **선언↔실물** — 「담기로 한 수」와 「담긴 수」를 «견준다». ⛔ 하나만 세면 결손이 안 보인다.
printf "📋 계획 %s · 담김 %s · 실패 %s  %s\n" "$PLANNED" "$STAGED" "$FAILED" \
  "$([ "$PLANNED" = "$STAGED" ] && [ "$FAILED" = "0" ] && echo ✅ || echo '⛔ 구멍이 있다')"
[ "$FAILED" -gt 0 ] && echo "⛔ 스냅샷 실패 $FAILED 건 — 위를 읽어라. 백업에 «구멍»이 있다."
case "$SECRETS_STATE" in
  ok)      echo "🔐 자격 묶음 ✅ 암호화됨 → $SECRETS_DEST" ;;
  skipped) echo "🔐 자격 묶음 — 담을 자격이 없어 건너뛰었다" ;;
  failed)  echo "🔐 자격 묶음 ⛔ 실패 — $SECRETS_REASON" ;;
esac

if [ "$DRY" = "1" ]; then
  echo "[dry-run] 올리지 않았다. 위 목록이 «올라갈 것»이다."
  # ⛔ 예행에서도 「구멍」을 «초록으로» 끝내지 않는다 — 예행의 뜻은 「이대로 올라간다」이므로.
  [ "$FAILED" -gt 0 ] || [ "$PLANNED" != "$STAGED" ] && exit 1
  [ "$SECRETS_STATE" = failed ] && exit 1
  exit 0
fi

echo "═══ 올린다 ═══"
# ⛔⭐ 파이프 뒤 rc 는 «후단 것»이다 — `if ! cmd | tail` 은 tail 의 rc(항상 0)를 읽어
#   ***업로드 실패를 조용히 성공으로 만든다***(실증: `if ! false 2>&1 | tail -3` 은 안 잡는다).
#   ✅ 산출은 그대로 tail -3 으로 줄이되, ***rc 는 파이프 «전»에서 받는다***. (🅕 제보 2026-09-21 · `R-GIT2`)
UPLOAD_LOG=$("$GCLOUD" storage cp -r "$STAGE"/* "$DEST/" 2>&1); UPLOAD_RC=$?
printf '%s\n' "$UPLOAD_LOG" | tail -3
if [ "$UPLOAD_RC" -ne 0 ]; then
  echo "⛔ 업로드 실패 (rc=$UPLOAD_RC)"; exit 1
fi

if [ "$SECRETS_STATE" = ok ]; then
  if [ -z "$AWS" ]; then
    SECRETS_STATE=failed; SECRETS_REASON="aws CLI 를 못 찾았다 (PATH=$PATH)"
  else
    S_LOG=$("$AWS" s3 cp "$SECRETS_FILE" "$SECRETS_DEST" --only-show-errors 2>&1); S_RC=$?
    if [ "$S_RC" -ne 0 ]; then
      SECRETS_STATE=failed; SECRETS_REASON="S3 업로드 실패 (rc=$S_RC): $(printf '%s' "$S_LOG" | head -c 120)"
    else
      # ⛔ 「올렸다」로 끝내지 않는다 — 저쪽 크기를 «다시» 잰다
      R_SIZE=$("$AWS" s3 ls "$SECRETS_DEST" 2>/dev/null | awk '{print $3}' | head -1)
      L_SIZE=$(wc -c < "$SECRETS_FILE" | tr -d ' ')
      if [ "$R_SIZE" = "$L_SIZE" ]; then
        echo "🔐 자격 묶음 업로드 ✅ ${L_SIZE} bytes → $SECRETS_DEST"
      else
        SECRETS_STATE=failed; SECRETS_REASON="원격 크기(${R_SIZE:-없음}) ≠ 로컬(${L_SIZE})"
      fi
    fi
  fi
  [ "$SECRETS_STATE" = failed ] && echo "🔐 자격 묶음 ⛔ 실패 — $SECRETS_REASON"
fi

# ── ⛔ 「올렸다」로 끝내지 않는다 — «저쪽에서» 세어 본다 ──────────────────────
echo "═══ 판정 — 원격에서 «다시 센다» ═══"
REMOTE=$("$GCLOUD" storage ls -l "$DEST/**" 2>/dev/null | grep -vE '^TOTAL' | wc -l | tr -d ' ')
LOCAL=$(ls -1 "$STAGE" | wc -l | tr -d ' ')
printf "  로컬 %s개 · 원격 %s개  %s\n" "$LOCAL" "$REMOTE" "$([ "$LOCAL" = "$REMOTE" ] && echo ✅ || echo '⛔ 수가 다르다')"
"$GCLOUD" storage ls -l "$DEST/**" 2>/dev/null | grep -vE '^TOTAL' | awk '{printf "    %10s  %s\n", $1, $NF}' | head -20
# 🧾⛔⭐⭐ **회차의 «완전성»을 남긴다** (2026-08-31 · 40차)
#    🚨 이 저장소의 카나리아 `(백업) age` 는 ***회차의 「존재」와 「나이」***만 본다.
#       그 검사의 주석이 스스로 적었다 — *「산출은 /tmp/bash.log 로만 가고 «사람이 열어야 안다»」*.
#    ⛔ 그런데 같은 날 더한 「계획·담김·실패」 회계가 ***정확히 그 자리***에 있었다.
#       ⇒ 🔑 ***구멍이 있는 백업이 「11.3시간 전 · 회차 6개」로 «초록»이 된다.***
#    ✅ 그래서 원장으로 «닿게» 한다 — ⛔ 「만들어져 있는데 안 닿는다」를 내 손으로 하나 더 만들지 않는다.
#    ⚠️ 이 줄은 ***판정 «앞»***에 둔다 — 실패한 회차일 때가 «가장 남겨야 할» 때다.
BACKUP_LEDGER="${ELANOUS_STATE_DIR:-$HOME/.elanous}/botlab/backup-runs.jsonl"
mkdir -p "$(dirname "$BACKUP_LEDGER")" 2>/dev/null
printf '{"at":"%s","dest":"%s","planned":%s,"staged":%s,"failed":%s,"uploaded":%s,"secrets":"%s"}\n' \
  "$(date -u +%FT%TZ)" "$DEST" "${PLANNED:-0}" "${LOCAL:-0}" "${FAILED:-0}" "${REMOTE:-0}" "${SECRETS_STATE:-skipped}" \
  >> "$BACKUP_LEDGER" 2>/dev/null \
  && echo "  🧾 회차 판정 기록 — $BACKUP_LEDGER" \
  || echo "  ⚠️⛔ 회차 판정을 «못 남겼다» — 카나리아가 이 회차의 «완전성»을 못 본다"

# ── 🩺 `S1` — 이 회차가 «끝났다»를 VM 에 남긴다 (생존력 RFC §1 · 🅕 45차) ────────
# ⚠️ ***판정 «앞»***에 둔다 — 바로 위 원장이 같은 이유로 여기 있다: ***실패한 회차일 때가 «가장
#    남겨야 할» 때***인데, 아래 두 `exit 1` 뒤에 두면 그 회차엔 심박이 «안 간다».
# ⛔⭐ 그리고 이 파일은 ***`~/.elanous/bin/` 으로 «심어져» 도는 사본***이다(머리말 참조).
#    ⇒ 저장소 자리를 «출처 머리말»에서 되짚는다. ⛔ 사본 자리(`~/.elanous/bin`)에서 되짚으면 못 찾는다.
HB_REPO=""
case "$SRC_LINE" in
  '# ⛔ 이 파일은 «사본»이다. 출처: '*) HB_REPO="$(cd "$(dirname "${SRC_LINE#*출처: }")/../.." 2>/dev/null && pwd)" ;;
  *) HB_REPO="$(cd "$(dirname "$SELF")/../.." 2>/dev/null && pwd)" ;;
esac
BACKUP_OK=1
{ [ "$LOCAL" = "$REMOTE" ] && [ "$FAILED" = "0" ] && [ "$PLANNED" = "$LOCAL" ] && [ "$SECRETS_STATE" != failed ]; } && BACKUP_OK=0
if [ "${ELANOUS_BACKUP_NO_HEARTBEAT:-0}" = "1" ]; then
  echo "  (심박 끔 — ELANOUS_BACKUP_NO_HEARTBEAT=1 · 시험 전용)" >&2
elif [ -n "$HB_REPO" ] && [ -f "$HB_REPO/scripts/botlab/heartbeat-emit.sh" ]; then
  # 심박은 «운영» 우주로 — 백업이 뜨는 것이 운영 ~/.elanous 이다. 크론은 환경변수가 없고 소스 트리는
  # 트리 파생 시험 우주로 풀려(`where` layer=tree-derived) 심박이 «격리라 안 밀었다»로 3일 멎었다(09-30).
  ELANOUS_STATE_DIR="${ELANOUS_STATE_DIR:-$HOME/.elanous}" ELANOUS_CONFIG_DIR="${ELANOUS_CONFIG_DIR:-$HOME/.elanous}" \
    bash "$HB_REPO/scripts/botlab/heartbeat-emit.sh" backup "$BACKUP_OK" "$HB_REPO" "$BACKUP_SOURCE"
else
  echo "  ⚠️ 심박을 «못 보냈다» — 저장소 자리를 못 찾았다(HB_REPO=${HB_REPO:-없음})" >&2
fi

[ "$LOCAL" = "$REMOTE" ] || exit 1
# ⛔⭐ **올렸어도 «구멍»이 있으면 성공으로 끝내지 않는다** (무인 리뷰 must-fix · `#14607`)
#    ⚠️ 업로드는 «막지 않는다» — 반쪽 백업이라도 없는 것보다 낫다. 막는 것은 ***「성공했다」는 말***이다.
if [ "$FAILED" -gt 0 ] || [ "$PLANNED" != "$LOCAL" ]; then
  echo "⛔ 올렸지만 «완전하지 않다» — 계획 $PLANNED · 담김 $LOCAL · 실패 $FAILED"
  exit 1
fi
if [ "$SECRETS_STATE" = failed ]; then
  echo "⛔ 데이터는 올렸지만 «자격 묶음»이 실패했다 — $SECRETS_REASON"
  exit 1
fi
