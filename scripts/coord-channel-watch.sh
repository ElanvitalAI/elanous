#!/bin/bash
# ch5730-watch.sh — 조율 채널 감시자의 **단일 인스턴스 런처**
#
# ⭐ 채널 번호는 «인자»다 — 기본값은 아래 `PR_NUM`, 정본은 `MANUAL-multi-agent-coordination-channel` 머리말이다.
#   ⛔ 채널이 바뀌면 이 파일의 기본값 «한 줄»과 그 매뉴얼 머리말 «둘»만 고친다(이름은 안 바꾼다).
#    (2026-08-12 #5730→#8328 · 08-25 #8328→#12577 · 09-10 #12577→#16815 · 09-27 #16815→#20798).
#    ⛔ 채널은 «막힐 수 있다» — GitHub 은 코멘트 2500 을 넘기면 댓글을 차단한다. 그때의 절차 =
#    `내부 문서 `COORDINATION-CHANNEL`` 「채널이 막히면 — 순서」.
#
# ⛔ 무엇을 푸는가 — 함정 ④(모니터 중복)의 «형태» 판본.
#    MANUAL-multi-agent-coordination-channel-2026-07-28.md §「PID 파일 규율」이
#    **문장으로** 적어 둔 것을 실행 가능한 형태로 옮긴 것이다.
#    ⇒ 그 문장은 지켜지지 않았다(2026-08-05 44/45차 실측): 살아 있던 `[S]` 감시자는
#      PID 파일을 **안 썼고**, /tmp 의 owner 파일은 39차(08-04) pid 를 가리키고 있었다.
#      매 창이 인라인 eval 을 다시 붙여 넣는 한 규율은 다시 샌다.
#
# ⭐ 핵심 계약 — `ensure` 는 **이미 돌고 있으면 아무것도 안 한다**(중복이 원천적으로 안 생긴다).
#    잠금을 잡았을 때만 루프를 **포그라운드**로 돈다 ⇒ 호출자가 백그라운드로 띄우면
#    산출이 그 세션으로 그대로 스트리밍된다(로그 파일을 따로 폴링할 필요가 없다).
#
# ⛔ 비대칭 — 「중복 알림은 성가시고, 잘못된 종료는 침묵을 만든다」(매뉴얼 실측).
#    ⇒ 이 스크립트는 **자기 것이라고 증명된 것만** 죽인다(pid ⊕ 기동시각 동시 일치).
#      증명이 안 되면 죽이지 않고 «말만» 한다.
#
# ⛔ pgrep 금지 — `( … ) &` 서브셸의 argv 엔 본문이 없어 살아 있어도 안 잡힌다(매뉴얼 실측).
#    ⇒ 소유 판정은 **오직 PID 파일 ⊕ 기동시각**으로 한다. argv 스캔(`discover`)은
#      «못 잡던 것을 알려 주는» 보조일 뿐이고, 그것을 근거로 죽이지 않는다.
#
# 사용:
#   scripts/ch5730-watch.sh ensure   [--track S]   # 없으면 띄우고 있으면 그대로 둔다 (기본)
#   scripts/ch5730-watch.sh status   [--track S]   # ⭐ 「사나」 ⊕ ***「배달이 어디로 가나」***
#   scripts/ch5730-watch.sh stop     [--track S]
#   scripts/ch5730-watch.sh restart  [--track S]
#   scripts/ch5730-watch.sh adopt --pid N [--track S]   # 이미 떠 있는 감시자를 잠금에 등록
#   scripts/ch5730-watch.sh discover                    # argv 로 «등록 안 된» 감시자 찾기(보조)
#   scripts/ch5730-watch.sh delivery --pid N [--track S] # 임의 pid 의 stdout 이 «어디로 가나»(진단·테스트)
#
# 트랙 태그는 --track 또는 $MY_PREFIX(**[S] → S)에서 온다. ⛔ 파일 이름을 트랙별로 가른다 —
# 공용 이름이면 S 가 T 의 «정상» 감시를 죽이고 아무도 모른다(매뉴얼 §72).
#
# ⭐ 무엇을 «보나» (2026-08-08 [T] 60차에 둘째 면이 붙었다)
#   ① 대화 코멘트  issues/<n>/comments          — 종전부터
#   ② ⭐ PR «본문»  pulls/<n> 의 .body           — CH_WATCH_BODY=0 으로 끈다
#   ⛔ 인라인 리뷰 코멘트는 «의도적으로» 안 본다 — 매뉴얼이 「조율은 대화 코멘트로만」이라 못 박았다.
#      ⇒ 리뷰 인라인에 판정을 남기면 상대의 감시에 «안 잡힌다».
#
# 환경 노브: CH_PR · CH_REPO · CH_INTERVAL(기본 60) · CH_BODY_CHARS(기본 1500) · CH_WATCH_BODY(기본 1)

set -u

PR_NUM="${CH_PR:-23032}"  # ⛔ 2026-10-03: #20798 가 2,500 상한 → 채널 «6»(OP)  # ⛔ 2026-09-27: #16815 가 2,500 상한에 닿아 채널 «5» 로 옮김(🅞 · 벽에 «닿은 뒤» — 미리 못 옮겼다)
#   📏 이력: #5730(07-28~08-12) → #8328(08-11~08-25) → #12577(08-25~09-10) → #16815(09-10~09-27) → #20798(09-27~10-03) → #23032.
#   ***수명이 «2주 안팎»이다 — 세 판이 전부 그랬다.*** 다음 벽은 09-24 언저리.
#   🩹 발신이 rc=1 이면 먼저 세라: gh api repos/ElanvitalAI/elanous/issues/<n> --jq .comments
REPO="${CH_REPO:-ElanvitalAI/elanous}"
INTERVAL="${CH_INTERVAL:-60}"
BODY_CHARS="${CH_BODY_CHARS:-1500}"
# ⛔⭐⭐⭐ PR «본문» 감시 (2026-08-08 [T] 60차) — 종전엔 «대화 코멘트»만 봤다.
#   대표 이 *"실시간 감지가 안 보인다"* 로 물어 매뉴얼 §3층 진단을 돌렸더니 **배달은 정상**이었고
#   (L1 정본 계수 1 · L2 등록 ✅ · L3 넷 중 넷 수신), 그 대조에서 이것이 나왔다:
#   ***상시 교리는 「#5730 «본문» 로드맵 «우선»」인데 감시자는 본문을 «한 번도» 안 봤다.***
#   ⇒ 대표·상대가 본문을 고치면 이 창은 «영영» 모른다. 0 으로 끌 수 있다.
BODY_WATCH="${CH_WATCH_BODY:-1}"
# ⛔⭐⭐⭐ 침묵이 «셋»을 뜻하는데 셋이 «같은 모양»이었다 (2026-08-12 · 대표 *"비정상 종료는 시스템 수리 건"*)
#   ⓐ 프로세스가 죽었다   ⓑ 살아 있는데 배달이 «파일»로 샌다   ⓒ 조회가 계속 실패해 «눈이 멀었다»
#   ⇒ 셋 다 화면에서 「새 발신 없음」과 구별되지 않았고, 사람은 언제나 «가장 편한 해석»으로 읽는다:
#     *"오늘은 상대가 조용하네"*. ⛔ 무기한으로.
#   ⭐ 그래서 감시자가 «주기적으로 자기 상태를 말한다» — 그러면 ***침묵이 정상이 아니라 결함 신호***가 된다.
#   🪞 그리고 이 원칙은 ***이 파일 `poll_body` 머리말에 이미 적혀 있었다***
#      (*"널·부분·손실 상태가 정상 상태와 구별되지 않으면 그 자는 거짓을 생산한다"*).
#      ⛔ 본문 감시엔 걸려 있고 «코멘트 조회 경로»엔 «안» 걸려 있었다 —
#      📌 ***원칙을 「아는 것」과 그 원칙이 「모든 경로에 걸린 것」은 다른 축이다.***
#   ⚠️ 출력이 많으면 소비자(Monitor)가 감시를 «정지»시킨다 ⇒ 하트비트는 «드물게». 0 이면 끈다.
HEARTBEAT_EVERY="${CH_HEARTBEAT_EVERY:-30}"   # 주기 N회마다 ♥ 한 줄 (기본 30회 ≈ 30분)
WATCH_CYCLES=0            # 돈 주기 수
WATCH_FAILS=0             # ⭐ «연속» 실패 수 — 0 이 아니면 그 감시자는 눈이 멀어 있다
WATCH_LAST_OK=""          # 마지막으로 «성공한» 조회 시각 ⛔ 빈 값은 「없음」이 아니라 «한 번도 성공 못 함»
WATCH_EXIT_ANNOUNCED=0    # 종료 줄 중복 방지(INT→EXIT 로 trap 이 두 번 돈다)
# 「거의 비었다」로 «의심»할 자수 — 이 아래로 떨어지면 «변경»이 아니라 «의심»으로 말한다.
BODY_MIN="${CH_BODY_MIN:-100}"

CMD="ensure"
TRACK=""
ADOPT_PID=""

while [ $# -gt 0 ]; do
  case "$1" in
    ensure|status|stop|restart|adopt|discover|delivery) CMD="$1" ;;
    --track) shift; TRACK="${1:-}" ;;
    --pid)   shift; ADOPT_PID="${1:-}" ;;
    -h|--help) sed -n '1,40p' "$0"; exit 0 ;;
    *) echo "⛔ 모르는 인자: $1" >&2; exit 2 ;;
  esac
  shift
done

# 트랙 태그 — 인자 > $MY_PREFIX. ⛔ 둘 다 없으면 «추측하지 않고» 선다.
if [ -z "$TRACK" ]; then
  TRACK=$(printf '%s' "${MY_PREFIX:-}" | tr -cd 'A-Za-z')
fi
if [ -z "$TRACK" ]; then
  echo "⛔ 트랙을 모른다 — --track S 를 주거나 MY_PREFIX 를 설정하라." >&2
  echo "   (공용 이름으로 돌면 다른 트랙의 정상 감시를 죽인다 — 그래서 추측하지 않는다.)" >&2
  exit 2
fi

# 🆕 2026-09-24 (🅞 보고): 「나에게 온 «요청»」 표지가 🅢 로 고정돼 있었다 — `--track O` 감시에서 🅢·🅣 앞 요청이
#   «🅞 에게 온 요청»으로 뜨고, 🅞 앞 요청은 일반어(부탁드립니다)가 없으면 안 떴다.
#   ⇒ 표지를 트랙 정본(scripts/coord-tracks.json)에서 $TRACK 으로 찾아 식을 짓는다. 일반어는 «내 표지와 함께»일 때만.
#   🆕 09-30 역할 재편: 신원이 2글자 id(TC) ⊕ 직함(CTO) ⊕ 옛 alias(O) 셋이다 — --track 은 id·alias 어느 쪽도 받고,
#   «내 글» 거르기와 «나에게 온 요청» 표지는 셋을 다 본다(전환기엔 옛 접두로 쓴 글도 내 글이다).
ENTRY=$(jq -c --arg t "$TRACK" '[.tracks[] | select(.id == $t or .alias == $t)][0] // empty' "$(dirname "$0")/coord-tracks.json" 2>/dev/null)
MARK=$(printf '%s' "$ENTRY" | jq -r '.mark // empty' 2>/dev/null)
SELF_ID=$(printf '%s' "$ENTRY" | jq -r '.id // empty' 2>/dev/null); SELF_ID=${SELF_ID:-$TRACK}
SELF_ALIAS=$(printf '%s' "$ENTRY" | jq -r '.alias // empty' 2>/dev/null); SELF_ALIAS=${SELF_ALIAS:-$SELF_ID}
SELF_TITLE=$(printf '%s' "$ENTRY" | jq -r '.title // empty' 2>/dev/null)
NAMES_ADDR="\\\\[$SELF_ID\\\\] 님|\\\\[$SELF_ALIAS\\\\] 님|$SELF_ID 님|$SELF_ID 께${SELF_TITLE:+|$SELF_TITLE 님|$SELF_TITLE 께}"
if [ -n "$MARK" ]; then
  REQ_ADDR="$MARK 께|$MARK 에게|$MARK 께서|$MARK 에 요청|$MARK 님|$NAMES_ADDR"
  REQ_MARK="$MARK"
else
  echo "⚠️ 트랙 정본에서 $TRACK 의 표지를 못 찾았다 — 요청 표지는 [$TRACK] 님 만 본다" >&2
  REQ_ADDR="$NAMES_ADDR"
  REQ_MARK="\\\\[$TRACK\\\\]"
fi

TMP="${TMPDIR:-/tmp}"
PIDFILE="$TMP/ch${PR_NUM}-$TRACK.pid"
LOCKDIR="$TMP/ch${PR_NUM}-$TRACK.lock"
# 본문 기준선 — ⭐ 프로세스가 아니라 «파일»에 둔다. 그래서 감시가 죽어 있던 구간의 본문 변경도
# 부활 «첫 주기»에 뜬다(매뉴얼 §「부활 구간은 못 본다」의 **본문 축만** 닫힌다 — 코멘트 축은 그대로).
BODYFILE="$TMP/ch${PR_NUM}-$TRACK.body"
# 코멘트 기준선(since)도 «파일»에 둔다(RFC-coordination-cost §7a · C1 · 09-30) — 재기동·30분 만기 재무장 뒤에도
# 끊긴 자리부터 이어 읽는다. 24시간보다 오래된 기준선은 버리고 지금부터(한 번에 쏟아지는 것 방지).
SINCEFILE="$TMP/ch${PR_NUM}-$TRACK.since"

# 기동시각 — 소유 판정의 유일한 근거(PID 는 재사용된다). 공백은 정규화해서 비교한다.
proc_started() {
  ps -o lstart= -p "$1" 2>/dev/null | tr -s ' ' | sed 's/^ //; s/ $//'
}

# 살아 있고 «내 기록과 일치하는» 감시자의 pid 를 낸다. 아니면 빈 문자열.
# ⇒ 이 함수가 「중복인가」의 유일한 판정자다.
holder_pid() {
  [ -f "$PIDFILE" ] || return 0
  local rec pid started now
  rec=$(cat "$PIDFILE" 2>/dev/null) || return 0
  pid="${rec%%|*}"
  started="${rec#*|}"
  case "$pid" in ''|*[!0-9]*) return 0 ;; esac
  now=$(proc_started "$pid")
  [ -n "$now" ] && [ "$now" = "$started" ] && printf '%s' "$pid"
  return 0
}

# ⛔⭐⭐⭐ 「종료」를 «죽었을 때만» 말한다 (2026-08-06 [T] 51차 실측).
#   종전엔 `kill "$h" && echo "… 종료"` 였는데 ***`kill` 의 exit 0 은 「신호를 «보냈다»」이지
#   「«죽었다»」가 아니다.*** SIGTERM 은 `sleep` 안에 있는 이 루프를 못 죽였고, 스크립트는
#   살아 있는 프로세스를 「종료」라고 출력했다 ⇒ restart 가 «둘째를 띄워» 감시자가 둘이 됐다.
#   그리고 그 중복은 「종료」 출력을 믿은 쪽에서 «보이지 않았다».
#
#   ⇒ SIGTERM → 확인 → SIGKILL → 확인 → «본 것»을 말한다. 안 죽었으면 실패로 말한다.
#   ⛔ 대상은 holder_pid 가 pid ⊕ 기동시각으로 «증명한» 것뿐이다 — 이 함수는 그 규율을 안 바꾼다.
kill_and_verify() {
  local pid="$1" label="$2" i
  kill "$pid" 2>/dev/null || true
  for i in 1 2 3 4 5 6; do
    [ -n "$(proc_started "$pid")" ] || { echo "✅ [$TRACK] $label $pid 종료(TERM)"; return 0; }
    sleep 0.5
  done
  kill -9 "$pid" 2>/dev/null || true
  for i in 1 2 3 4; do
    [ -n "$(proc_started "$pid")" ] || { echo "✅ [$TRACK] $label $pid 종료(KILL — TERM 을 안 받았다)"; return 0; }
    sleep 0.5
  done
  echo "⛔ [$TRACK] $label $pid 이 «안 죽었다» — TERM·KILL 둘 다 보냈다. 손으로 확인하라" >&2
  return 1
}

# ⛔⭐⭐⭐ 「살아있음」과 「배달된다」는 «다른 층»이다 (2026-08-08 · `[S]` 57차 실측 → `[T]` 60차 착지).
#   [S] 가 감시자를 `nohup … > <파일> 2>&1 &` 로 걸었더니:
#     ✅ ps 살아 있음  ·  ✅ status "감시 살아있음"   ⇒ 🚨 배달은 «0»
#   stdout 이 «파일»로 갔기 때문이다. ***모든 자가 초록인데 아무것도 안 온다.***
#   ⚠️ 매뉴얼 §「3층 진단」이 이미 *"L1·L2 가 초록이어도 L3 는 끊길 수 있다"* 라 적었는데,
#      ***그 L3 를 재는 자가 없었다*** — 사람이 「채널 최신과 내가 받은 것」을 손으로 대조해야 했다.
#
#   🧩 이것이 이 저장소가 2026-08-08 하루에 «다섯» 만난 한 형태다:
#      압축 그림자 침묵 · 연합 조회 exit 0 · G10 durationMs=0 인데 「회귀」 · 본문 사각지대 · 이것.
#        ***널·부분·손실 상태가 정상 상태와 구별되지 않으면 그 자는 거짓을 생산한다.***
#   ⇒ status 는 「사나」에 더해 ***「어디로 가나」***를 말한다.
#
# ⛔ 그리고 «못 쟀으면» 「정상」이라 말하지 않는다 — 「모른다」로 낸다.
#    (안 그러면 이 함수 자신이 고치려는 형태를 다시 만든다.)
# ⛔⭐ `lsof` 를 «상한»을 걸고 부른다 (무인 리뷰 must-fix ③).
#   lsof 는 죽은 마운트·느린 FS 에서 «멈춘다». 상한이 없으면 그 순간 `status` 자체가 무기한 걸리고,
#   ***이 함수가 고치려는 「초록인데 아무것도 안 온다」의 판본을 진단기가 다시 만든다.***
#   ⛔ macOS 에는 `timeout(1)` 이 «없다»(이 창 실측 — GNU coreutils 미설치) ⇒ 손으로 상한을 건다.
#   ⊕ `-n -P` 로 DNS·포트 조회를 끈다 — 멈추는 가장 흔한 원인이다.
LSOF_WAIT_TICKS="${CH_LSOF_TICKS:-10}"   # 0.5s × 10 = 5초
# ⛔ 비-수치면 산술식이 `set -u` 아래서 «unbound variable» 로 스크립트를 죽인다(리뷰 should-fix ④).
#    ⇒ 진단기가 죽으면 그것도 「초록인데 아무것도 안 온다」다. 조용히 기본값으로 내린다.
case "$LSOF_WAIT_TICKS" in ''|*[!0-9]*) LSOF_WAIT_TICKS=10 ;; esac

lsof_fd1() {
  local pid="$1" tmpf lp i
  # ⚠️ 이름을 «pid 별로 결정론»으로 둔다(리뷰 should-fix ③) — 중단으로 정리를 못 해도
  #    같은 대상의 다음 호출이 덮어쓰므로 임시파일이 «무한히 쌓이지 않는다».
  #    ⛔ 남는 창은 있다: 이 명령이 SIGINT/TERM 으로 «중간에» 끊기면 그 한 파일과
  #      최대 5초짜리 lsof 하나가 남는다. short-lived 진단 경로라 그 범위로 «둔다».
  tmpf="$TMP/ch${PR_NUM}-lsof.$pid"
  rm -f "$tmpf" 2>/dev/null || true
  lsof -n -P -p "$pid" -a -d 1 -Ftn > "$tmpf" 2>/dev/null &
  lp=$!
  for ((i = 0; i < LSOF_WAIT_TICKS; i++)); do
    kill -0 "$lp" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$lp" 2>/dev/null; then
    kill -9 "$lp" 2>/dev/null || true
    wait "$lp" 2>/dev/null || true
    rm -f "$tmpf"
    return 1                       # 시간 초과 — 「모름」이지 「정상」이 아니다
  fi
  wait "$lp" 2>/dev/null || true
  cat "$tmpf" 2>/dev/null || true
  rm -f "$tmpf"
  return 0
}

delivery_of() {
  local pid="$1" out t n
  case "$pid" in
    ''|*[!0-9]*) printf '⚠️ «못 쟀다»(감시자 pid 를 «증명하지 못했다») — 「정상」이 아니라 «모름»이다'; return 0 ;;
  esac
  command -v lsof >/dev/null 2>&1 || { printf '⚠️ «못 쟀다»(lsof 없음) — 「정상」이 아니라 «모름»이다'; return 0; }
  if ! out=$(lsof_fd1 "$pid"); then
    printf '⚠️ «못 쟀다»(lsof 가 %s틱 안에 안 끝나 죽였다) — 「정상」이 아니라 «모름»이다' "$LSOF_WAIT_TICKS"
    return 0
  fi
  t=$(printf '%s\n' "$out" | sed -n 's/^t//p' | head -1)
  n=$(printf '%s\n' "$out" | sed -n 's/^n//p' | head -1)
  if [ -z "$t" ]; then
    printf '⚠️ «못 쟀다»(lsof 가 fd 1 을 안 준다) — 「정상」이 아니라 «모름»이다'
    return 0
  fi
  case "$t" in
    unix|PIPE|FIFO)
      printf '✅ 스트리밍(%s) — 띄운 창으로 «간다»' "$t" ;;
    CHR|VCHR)
      # ⛔ 문자 장치라고 «다» 터미널이 아니다(무인 리뷰 must-fix ②) — /dev/zero·/dev/random 도 CHR 이다.
      #    ⇒ tty 로 «증명된» 것만 ✅ 로 말하고, 나머지는 «모름»이다.
      case "$n" in
        /dev/null)          printf '🚨 /dev/null — ⛔ 산출이 «버려진다». 「살아있음」은 배달의 증거가 아니다' ;;
        /dev/tty*|/dev/pts/*) printf '✅ 터미널 %s — 사람이 «보는» 화면' "$n" ;;
        *)                  printf '⚠️ «모름»(문자 장치 %s 인데 tty 가 아니다) — 「정상」이라 말하지 않는다' "$n" ;;
      esac ;;
    REG|VREG)
      printf '🚨 «파일» %s — ⛔ 살아 있어도 그 창엔 «안 온다». Monitor(persistent) «안»에서 다시 걸어라' "$n" ;;
    *)
      printf '⚠️ «모름»(모르는 대상 type=%s name=%s) — 「정상」이라 말하지 않는다' "$t" "$n" ;;
  esac
}

record_pid() {
  printf '%s|%s\n' "$1" "$(proc_started "$1")" > "$PIDFILE"
}

release_lock() { rm -rf "$LOCKDIR" 2>/dev/null || true; }

# ⛔⭐⭐⭐ 죽을 때 «내 것일 때만» 놓는다 (2026-08-06 [T] 51차 실측).
#   종전 trap 은 `rm -f "$PIDFILE"; release_lock` 이라 ***소유권을 안 보고 지웠다.***
#   그래서 이런 순서가 성립했다:
#     ① restart 가 옛 감시(A)를 «못 죽이고» 새 감시(B)를 띄운다 → PIDFILE=B
#     ② 나중에 사람이 A 를 죽인다 → A 의 EXIT trap 이 «B 의» 기록과 잠금을 지운다
#     ③ 다음 ensure 는 「등록된 감시 없음」을 보고 «셋째»를 띄운다
#   ⇒ ***중복을 막으려던 장치가 중복을 만드는 경로였다.*** 실측으로 ②까지 재현됐다(3921 이 살아 있는데
#      status 가 「등록된 감시 없음」 · adopt 로 복구).
release_if_mine() {
  local rec pid
  rec=$(cat "$PIDFILE" 2>/dev/null) || { release_lock; return 0; }
  pid="${rec%%|*}"
  # 기록이 «내» pid 가 아니면 남의 것이다 — 손대지 않는다(잠금도 그의 것이다).
  [ "$pid" = "$$" ] || return 0
  # ⛔⭐ BODYFILE 은 «일부러» 안 지운다 — 그것이 다음 기동에서 「죽어 있던 구간의 본문 변경」을
  #    잡아 주는 유일한 근거다. 지우면 부활할 때마다 기준선이 리셋돼 그 구간이 영영 사라진다.
  rm -f "$PIDFILE"; release_lock
}

# 잠금 획득 — 성공 0 / 이미 «살아 있는» 소유자 있음 1.
# 잠금 디렉토리가 남아 있어도 소유자가 죽었으면 회수한다(창이 죽으면 trap 이 안 돈다).
acquire_lock() {
  if mkdir "$LOCKDIR" 2>/dev/null; then return 0; fi
  [ -n "$(holder_pid)" ] && return 1
  rm -rf "$LOCKDIR" 2>/dev/null || true
  mkdir "$LOCKDIR" 2>/dev/null || return 1
  return 0
}

# ⛔⭐⭐⭐ 조상 사슬 — 「폴 자식」과 「감시자 본체」를 가르는 유일한 자 (2026-08-17 [T] 99차).
#   📏 실측: `status` 가 *"등록 안 된 감시자 — 중복의 씨앗"* 이라 가리킨 pid 는 감시자가 «아니라»
#      ***등록된 감시자 자신이 매 주기 띄우는 `gh api …/issues/<n>/comments` 자식***이었다.
#      (그 argv 의 jq 필터가 「[T] 접두 제외」 = 바로 그 감시자의 질의였다.)
#   🚨 그리고 그 거짓 양성이 시키는 처방(`adopt --pid <N>`)이 «진짜 중복»을 만든다:
#      그 pid 는 몇 초 뒤 죽으므로 PIDFILE 에 죽을 pid 가 박히고 → holder_pid 가 「없음」이 되고
#      → 다음 `ensure` 가 둘째를 띄운다. ***중복을 막는 장치가 중복의 원인이 되는 경로.***
#   ⇒ 그래서 argv 만 보지 않고 «조상»을 본다. 상한 12단은 순환·좀비 방어다.
ancestors_of() {
  local p="$1" i=0
  while [ -n "$p" ] && [ "$p" != "0" ] && [ "$p" != "1" ] && [ "$i" -lt 12 ]; do
    printf '%s\n' "$p"
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
    i=$((i + 1))
  done
}

# 이 pid 가 «감시자 프로세스 자체»인가 — argv 가 이 스크립트인 것만 참.
# ⛔ `gh`·`jq`·`sleep` 같은 자식은 여기서 거짓이다. 그것이 이 함수의 존재 이유다.
is_watcher_proc() {
  ps -o command= -p "$1" 2>/dev/null | grep -qE 'coord-channel-watch\.sh|ch5730-watch\.sh'
}

# 조상 사슬(자기 포함)에 target 이 있나 — 「내 감시자의 자손인가」를 묻는다.
has_ancestor() {
  local target="$1" p
  for p in $(ancestors_of "$2"); do
    [ "$p" = "$target" ] && return 0
  done
  return 1
}

# 조상 사슬에서 «가장 위» 감시자 프로세스 = 감시자 «본체».
# ⛔ 가장 «가까운» 것을 쓰면 안 된다 — 폴 루프가 서브셸이면 그 서브셸도 같은 argv 를 갖는다.
#    그 중간 pid 를 「미등록 감시자」로 세면 거짓 양성이 그대로 돌아온다.
top_watcher_ancestor() {
  local p last=""
  for p in $(ancestors_of "$1"); do
    is_watcher_proc "$p" && last="$p"
  done
  printf '%s' "$last"
}

# argv 로 «등록 안 된» 감시자를 찾는다 — 보조 관측이다.
# ⛔ 이 결과로 죽이지 않는다: 서브셸로 띄운 감시자는 여기 «안 잡히므로»,
#    0행을 「없다」로 읽으면 안 된다(매뉴얼 §80 · pgrep 이 영영 안 맞는 이유와 같다).
# ⭐ 그리고 «잡힌 것»도 그대로 세지 않는다 — 조회 프로세스는 감시자 «본체»로 접어서 센다.
#    그래서 감시자 하나가 폴 자식을 몇 개 띄우든 이 목록의 행은 «하나»다(정렬·중복 제거).
discover_untracked() {
  local mine
  mine=$(holder_pid)
  ps -eo pid=,lstart=,command= 2>/dev/null \
    | grep "issues/${PR_NUM}/comments" \
    | grep -v grep \
    | while read -r p rest; do
        [ "$p" = "$$" ] && continue
        # ⛔ 내 감시자(등록된 것)나 이 명령 자신의 자손이면 «중복이 아니다» — 자기 폴 자식이다.
        [ -n "$mine" ] && has_ancestor "$mine" "$p" && continue
        has_ancestor "$$" "$p" && continue
        local owner
        owner=$(top_watcher_ancestor "$p")
        if [ -n "$owner" ]; then
          printf '  pid=%s  %s  (감시자 본체 — 조회 pid=%s 의 조상)\n' \
            "$owner" "$(proc_started "$owner")" "$p"
        else
          # ⚠️ 조상에서 감시자를 못 찾았다 = 이 스크립트가 안 띄운 조회다(사람이 손으로 친 gh 등).
          #    ⛔ 「감시자」라고 부르지 않는다 — 이름을 틀리면 처방도 틀린다.
          printf '  pid=%s  %s  ⚠️ 조회 프로세스인데 조상에 «감시자가 없다»(손으로 친 gh 일 수 있다)\n' \
            "$p" "$(printf '%s' "$rest" | cut -c1-40)"
        fi
      done | sort -u
}

body_short_hash() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" 2>/dev/null | cut -c1-12
  else
    cksum "$1" 2>/dev/null | awk '{print $1}'
  fi
}

# ⛔⭐⭐⭐ 본문을 한 번 재고, «바뀌었을 때만» 한 줄을 낸다.
#
# ⛔ `updated_at` 을 자로 쓰지 않는다 — 그 값은 «코멘트» 활동에도 움직인다.
#    📏 실측(2026-08-08): pulls/5730 의 body updated_at=09:36:43Z 가 그 시각 «코멘트» 발신
#       시각과 «같았다». ⇒ 「본문이 바뀌었나」를 그 값으로 물으면 항상 「예」다 = 판별력 0.
#    ⇒ 본문 «자체»를 들고 파일 비교한다(cmp).
#
# ⛔⭐⭐ 그리고 이 함수는 「조회 실패」와 「빈 본문」을 «다른 값»으로 낸다.
#    그 둘을 같게 두는 것이 바로 이 변경이 고치려는 형태이고, 같은 형태를 이 저장소가
#    2026-08-08 하루에 «넷» 만났다(압축 그림자 침묵 · 연합 조회 exit 0 ·
#    G10 durationMs=0 인데 「회귀」 · 그리고 이 사각지대).
#      ***널·부분·손실 상태가 정상 상태와 구별되지 않으면 그 자는 거짓을 생산한다.***
#    ⇒ ⓐ 조회 실패면 기준선을 «전진시키지 않는다»(`last` 규율과 같은 형태)
#      ⓑ 「있던 본문이 갑자기 거의 비었다」는 «변경»이 아니라 «의심»으로 말한다
# ⛔⭐⭐⭐ 조회 «경로가 둘»인 이유 — 2026-08-17 실측(102차 `[T]`).
#   REST `repos/<o>/<r>/issues/<n>` 계열이 이 저장소·이 토큰에서 ***일관되게 404*** 를 냈다.
#   ⛔ 「일시적 네트워크」가 아니다: 같은 순간 `pulls/<n>` 은 200 · `has_issues=true` ·
#     토큰 scope 에 `repo` 있음 · `gh pr comment`/`pr view --comments` 도 «정상».
#     ⇒ 원인은 우리 쪽이 아니라 «그 경로 하나»이고, 그동안 감시자는 45분간 눈이 멀었다.
#   🔑 그리고 그 침묵은 정확히 이 파일이 막으려던 것이다 —
#     「상대가 조용하다」와 「내가 못 본다」가 같은 화면이 된다.
#     ⛔ 실패를 «말하는» 것만으로는 부족하다. 말하면서도 45분간 아무것도 못 봤다.
#   ⇒ 그래서 ***죽은 경로 하나에 감시를 걸지 않는다***. PR 네이티브(GraphQL)로 폴백한다.
#   ⚠️ GraphQL 은 `since` 를 안 받는다 ⇒ 최근 N 개를 받아 «여기서» 시각으로 자른다.
#     그래서 한 주기에 N 개보다 많이 오면 놓칠 수 있다 — 그 경우 REST 가 정상일 때보다 약하다.
#     ⛔ 그러니 폴백은 «폴백»이고, 쓰이면 그 사실이 화면에 남는다.
COMMENT_FALLBACK_LAST="${CH_FALLBACK_LAST:-50}"
# ⛔ 폴백 «사용»도 첫 회 ⊕ 그 뒤 드물게만 알린다. 이 파일이 실패 알림에 이미 쓰는 규율이고,
#   그것을 폴백에 «안 걸었더니» 매 주기 한 줄이 나가 소비자(Monitor)가 감시를 정지시킬 뻔했다.
#   ⇒ 되살린 감시를 소음으로 다시 죽이지 않는다. 0 이면 아예 안 알린다.
FALLBACK_NOTICE_EVERY="${CH_FALLBACK_NOTICE_EVERY:-30}"
FALLBACK_USES=0
# ⛔⭐⭐ 왜 «파일»로 신호하나 — 2026-08-17 실측(같은 창이 자기 수리를 관측해 잡았다).
#   fetch_comments 는 `out=$(fetch_comments …)` 로 불린다. 명령 치환은 «서브셸»이라
#   그 안에서 올린 변수는 «빠져나오지 못한다». 그래서 첫 판의 빈도 제한은 «안 먹었고»,
#   같은 프로세스가 「누적 1회」를 세 번 냈다(카운터가 매번 0 에서 시작했다).
#   ⇒ 📌 카운트와 판정은 «부모 셸»에서 한다. 서브셸은 「썼다」는 사실만 파일로 남긴다.
#   🔑 형태: ***상태를 서브셸에 두면 그 상태는 조용히 사라진다*** — 이 저장소의
#     「파이프를 통과하면 성패가 사라진다」와 같은 뿌리다.
FALLBACK_FLAG="${TMPDIR:-/tmp}/ch-watch-fallback-$PR_NUM-$TRACK.$$"

emit_comments() {  # $1=JSONL (line, archive, comment)
  local out="$1" deferred
  [ -n "$out" ] || return 0
  if [ "${COORD_WATCH_SKIP_OTHERS_REPORTS:-}" = "1" ]; then
    deferred=$(printf '%s\n' "$out" | jq -c 'select(.archive) | .comment') || return 1
    if [ -n "$deferred" ]; then
      mkdir -p "$HOME/.elanous/coord" || return 1
      printf '%s\n' "$deferred" >> "$HOME/.elanous/coord/$SELF_ID-reports.jsonl" || return 1
    fi
  fi
  if [ "${COORD_WATCH_SKIP_OTHERS_REPORTS:-}" = "1" ]; then
    printf '%s\n' "$out" | jq -r 'select(.archive | not) | .line' || return 1
  else
    printf '%s\n' "$out" | jq -r '.line' || return 1
  fi
}

fetch_comments() {   # $1=since(ISO8601) → stdout=포맷된 신규 행 · rc=0 성공 / rc=1 두 경로 다 실패
  local since="$1" out fmt
  # 두 경로가 «같은 형태»를 내도록 정규화된 객체 하나만 본다: {id, created_at, login, body}
  # 🆕⭐ 「나에게 «온 요청»」을 앞머리에 «표지»로 단다(2026-08-28 · 138차).
  #   📏 실측: 🅕 의 요청(`🅢 께 — pilot 트리 git pull 부탁드립니다`)을 ***1시간 반*** 놓쳤다.
  #     그 글은 필터를 «통과»했고 창에도 떴다 — 그런데 다른 글 사이에 섞여 «요청»으로 안 보였다.
  #   🔑 그러므로 결손은 「고르기」가 아니라 ***「고른 뒤 «구분»하지 않은 것」***이다.
  #   ⛔ 표지를 «본문 앞»에 둔다 — 뒤에 두면 BODY_CHARS 절단에 잘려 사라진다.
  fmt=$(cat <<JQ
select(((.body | sub("^[[:space:]#]+"; "")) | (startswith("**[$SELF_ID]") or startswith("[$SELF_ID]") or startswith("**[$SELF_ALIAS]") or startswith("[$SELF_ALIAS]"))) | not)
| . as \$comment
| ((.body | split("\n")[0] | capture("^[[:space:]#]*[*][*][[][^]]+[]][*][*][^\n]*→[[:space:]]*(?<to>[^\n]+?)[[:space:]]*·[[:space:]]*(?<kind>요청|결정|사고|보고|정정)[[:space:]]*·")) // null) as \$envelope
| (if \$envelope == null then false else
     (\$envelope.to | split("·") | map(gsub("^[[:space:]]+|[[:space:]]+$"; "")))
     | any(.[]; . == "$SELF_ID" or . == "$SELF_ALIAS" or . == "전원")
   end) as \$mine
| ((.body | test("$REQ_ADDR")) or ((.body | test("$REQ_MARK")) and (.body | test("부탁드립니다|부탁합니다")))) as \$legacy_request
| (\$envelope != null and \$envelope.kind == "보고" and (\$mine | not)) as \$archive
| {comment: \$comment, archive: \$archive,
   line: ("[#$PR_NUM 신규 id=" + (.id|tostring) + " " + .created_at + " @" + .login + "]"
     + (if \$mine and \$envelope.kind == "결정" then " 🙋 나에게 «결정»"
        elif \$mine and \$envelope.kind == "요청" then " 🙋 나에게 «요청»"
        else "" end)
     + (if \$legacy_request then " 🙋‼️ 나에게 온 «요청»" else "" end)
     + (if \$envelope != null and (\$envelope.kind == "사고" or \$envelope.kind == "정정") then " 🚨"
        elif \$archive then " 📄 보고" else "" end)
     + " " + (.body[:$BODY_CHARS] | gsub("\n"; " ⏎ ")))}
JQ
)
  if out=$(gh api --paginate "repos/$REPO/issues/$PR_NUM/comments?since=$since" \
             --jq ".[] | {id, created_at, login: .user.login, body} | $fmt" 2>/dev/null); then
    emit_comments "$out"; return $?
  fi
  local owner="${REPO%%/*}" name="${REPO##*/}"
  if out=$(gh api graphql -f query="query{repository(owner:\"$owner\",name:\"$name\"){pullRequest(number:$PR_NUM){comments(last:$COMMENT_FALLBACK_LAST){nodes{databaseId createdAt author{login} body}}}}}" \
             --jq ".data.repository.pullRequest.comments.nodes[]
                   | {id: .databaseId, created_at: .createdAt, login: (.author.login // \"«알 수 없음»\"), body}
                   | select(.created_at > \"$since\")
                   | $fmt" 2>/dev/null); then
    # ⭐ 폴백이 «쓰였다»는 사실만 남긴다 — 세는 것도 알릴지 정하는 것도 «부모 셸»이 한다.
    #   ⛔ 여기서 세면 서브셸과 함께 사라진다(위 머리말).
    : > "$FALLBACK_FLAG" 2>/dev/null || true
    emit_comments "$out"; return $?
  fi
  return 1
}

poll_body() {
  [ "$BODY_WATCH" = "1" ] || return 0
  local new prev_len new_len d oldh newh
  new="$BODYFILE.new"
  # ⛔ exit 코드로 «실패»를 가른다 — 빈 산출만 보고 「본문이 비었다」로 읽지 않는다.
  if ! gh api "repos/$REPO/pulls/$PR_NUM" --jq '.body // ""' > "$new" 2>/dev/null; then
    rm -f "$new"
    return 0
  fi
  new_len=$(wc -c < "$new" | tr -d ' ')
  # 첫 기준선 — 이벤트를 «안» 낸다(기동 배너가 이미 알린다). 안 그러면 매 재시작이 「본문 변경」이 된다.
  if [ ! -f "$BODYFILE" ]; then
    mv "$new" "$BODYFILE"
    return 0
  fi
  if cmp -s "$BODYFILE" "$new"; then rm -f "$new"; return 0; fi
  prev_len=$(wc -c < "$BODYFILE" | tr -d ' ')
  oldh=$(body_short_hash "$BODYFILE")
  newh=$(body_short_hash "$new")
  if [ "$new_len" -lt "$BODY_MIN" ] && [ "$prev_len" -ge "$BODY_MIN" ]; then
    printf '⚠️ [#%s «본문» 거의 비었다 %s] %s → %s자 · «조회는 성공했다» — 사람이 지웠거나 API 가 부분을 줬다. 손으로 확인하라\n' \
      "$PR_NUM" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$prev_len" "$new_len"
  else
    # 한 이벤트 = 한 알림 — diff 를 ⏎ 로 접는다(매뉴얼 §gsub 규율과 같은 이유).
    d=$(diff -u "$BODYFILE" "$new" 2>/dev/null | tail -n +3 | grep -E '^[+-]' \
        | head -c "$BODY_CHARS" | sed 's/$/ ⏎/' | tr -d '\n')
    printf '[#%s «본문» 변경 %s] %s → %s자 (Δ%+d) · %s→%s ⏎ %s\n' \
      "$PR_NUM" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$prev_len" "$new_len" \
      "$((new_len - prev_len))" "$oldh" "$newh" "$d"
  fi
  mv "$new" "$BODYFILE"
}

# ⛔⭐⭐ 비정상 종료가 «스트림에» 흔적을 남기게 한다.
#   종전 trap 은 `release_if_mine` «만» 이라 잠금을 놓고 ***한 줄도 안 찍었다*** ⇒ 소비자에겐
#   「감시자가 죽었다」와 「새 소식이 없다」가 «같은 모양»이었다. 실제로 2026-08-12 에 그렇게 잃었다.
#   ⛔ 소유권·잠금 로직은 «한 줄도» 안 바꾼다 — 이 함수는 «말만» 덧붙이고 그대로 위임한다.
announce_exit() {
  local sig="${1:-EXIT}"
  if [ "$WATCH_EXIT_ANNOUNCED" = "0" ]; then
    WATCH_EXIT_ANNOUNCED=1
    printf '⛔ [watch-%s-%s 종료 %s] 신호=%s · 돈 주기=%s · 마지막 성공 조회=%s · 연속 실패=%s\n' \
      "$PR_NUM" "$TRACK" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$sig" \
      "$WATCH_CYCLES" "${WATCH_LAST_OK:-«한 번도 성공 못 함»}" "$WATCH_FAILS"
  fi
  release_if_mine
}

watch_loop() {
  local last now out
  # ⚠️ 재시작하면 그 사이 구간을 놓친다 — 매뉴얼 §63 대로 한 번 훑고 걸라는 안내를 남긴다.
  echo "[watch-$PR_NUM-$TRACK 기동 pid=$$] 이 줄 이후로 «신규»만 뜬다"
  echo "  ⚠️ 죽었다 살아난 것이면 그 사이 구간은 이 감시가 «못 본다» —"
  echo "     gh pr view $PR_NUM --comments 로 한 번 훑고 시작하라(매뉴얼 §63)."
  if [ "$BODY_WATCH" != "1" ]; then
    echo "  📄 «본문» 감시 OFF (CH_WATCH_BODY=0) — 본문 로드맵이 바뀌어도 «안 뜬다»"
  elif [ -f "$BODYFILE" ]; then
    echo "  📄 «본문» 감시 ON · 직전 기준선 있음($(wc -c < "$BODYFILE" | tr -d ' ')자)"
    echo "     ⇒ ⭐ 감시가 «죽어 있던 구간»의 본문 변경도 첫 주기에 뜬다"
  else
    echo "  📄 «본문» 감시 ON · 기준선 «없음» ⇒ 첫 주기를 기준선으로 삼고 이벤트를 안 낸다"
  fi
  last=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if [ -s "$SINCEFILE" ]; then
    local saved; saved=$(head -1 "$SINCEFILE" 2>/dev/null)
    if [[ "$saved" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
       && [ -z "$(find "$SINCEFILE" -mmin +1440 2>/dev/null)" ]; then
      last="$saved"
      echo "  🔁 코멘트 기준선 이어 읽기 since=$last (파일 $SINCEFILE) — 죽어 있던 구간도 첫 주기에 뜬다"
    fi
  fi
  while true; do
    sleep "$INTERVAL"
    now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    WATCH_CYCLES=$((WATCH_CYCLES + 1))
    # ⛔ last 는 «성공한 fetch 에서만» 전진한다 — 실패에 전진시키면 그 구간이 영영 사라진다.
    # ⛔⭐ 자기 발신 제외는 «접두 두 형태»를 다 문다 (2026-08-11 71차 · 대표 *"스스로를 왜 감시하죠"*).
    #    종전엔 `**[T]` 하나만 봐서 내가 `[T] …`(별표 없이) 쓴 글이 «내 창으로 되돌아왔다».
    #    📏 실측: 최근 100 코멘트 중 `**[S]**` 23 · `**[T]**` 11(걸러짐) · `[T] …` **7**(샜다).
    #    ⇒ 규율(「별표를 붙여 써라」)이 아니라 도구가 문다.
    # ⛔⭐⭐ **세 번째 형태 — 마크다운 «제목»**(2026-08-14 86차). 위 두 형태를 다 물어도
    #    `## [S] …` 처럼 제목 표시가 «앞»에 오면 `startswith` 가 한 번도 안 맞는다.
    #    📏 실측: 그날 [S] 발신 «전부»가 그 형태였고 «전부» 자기 창으로 되돌아왔다(글마다 한 번씩 깨어남).
    #    🔑 CLAUDE.md 가 *"신원 접두는 기술적 요구 — startswith 판정 ⇒ 첫 문자열"* 이라 이미 못 박았는데,
    #    ***문장으로만 있고 형태가 강제하지 않아 하루 종일 어겨졌다.*** ⇒ 여기서도 도구가 문다:
    #    앞의 `#` 과 공백을 «걷어낸 뒤» 기존 두 형태를 본다(원문은 그대로 출력한다).
    rm -f "$FALLBACK_FLAG" 2>/dev/null || true
    if out=$(fetch_comments "$last"); then
      # ⭐ 부모 셸에서 «센다» — 첫 회 ⊕ 그 뒤 드물게만 알린다. 소음은 감시를 죽인다.
      if [ -e "$FALLBACK_FLAG" ]; then
        FALLBACK_USES=$((FALLBACK_USES + 1))
        if [ "$FALLBACK_NOTICE_EVERY" -gt 0 ] \
           && { [ "$FALLBACK_USES" = "1" ] || [ $((FALLBACK_USES % FALLBACK_NOTICE_EVERY)) = "0" ]; }; then
          printf '⚠️ [#%s REST issues 경로 실패 → PR(GraphQL) 폴백 · 최근 %s개만 본다 · 누적 %s회]\n' \
            "$PR_NUM" "$COMMENT_FALLBACK_LAST" "$FALLBACK_USES"
        fi
        rm -f "$FALLBACK_FLAG" 2>/dev/null || true
      fi
      [ -n "$out" ] && printf '%s\n' "$out"
      last="$now"
      printf '%s\n' "$last" > "$SINCEFILE" 2>/dev/null || true
      # ⭐ 실패하다 «돌아왔으면» 한 줄로 말한다 — 조용히 복구되면 아무도 «공백 구간»이 있었음을 모른다.
      if [ "$WATCH_FAILS" -gt 0 ]; then
        printf '✅ [#%s 조회 «회복» %s] 연속 실패 %s회 뒤 성공 — 그 사이도 since=%s 로 «이어 붙였다»(놓친 것 없음)\n' \
          "$PR_NUM" "$now" "$WATCH_FAILS" "${WATCH_LAST_OK:-«한 번도 성공 못 함»}"
        WATCH_FAILS=0
      fi
      WATCH_LAST_OK="$now"
    else
      # ⛔⭐ 여기가 이 수리의 «본체»다 — 종전엔 이 갈래가 «완전히 조용»했다.
      #   gh 인증이 만료되면 프로세스는 살아 있고 잠금은 잡혀 있고 화면은 조용하다. 무기한으로.
      WATCH_FAILS=$((WATCH_FAILS + 1))
      # ⚠️ 매 주기마다 내면 시끄러워 소비자가 감시를 «정지»시킨다 ⇒ 첫 실패 ⊕ 그 뒤 드물게만.
      if [ "$WATCH_FAILS" = "1" ] || [ $((WATCH_FAILS % 10)) = "0" ]; then
        printf '⛔ [#%s 조회 «실패» %s] 연속 %s회 · 마지막 성공=%s — ⚠️ 이것은 「새 발신 없음」이 «아니다». gh 인증·네트워크를 보라\n' \
          "$PR_NUM" "$now" "$WATCH_FAILS" "${WATCH_LAST_OK:-«한 번도 성공 못 함»}"
      fi
    fi
    # ⛔ 코멘트 조회가 실패해도 본문은 «따로» 잰다 — 두 면은 서로의 실패에 묶이지 않는다.
    poll_body
    # ⭐⭐ 하트비트 — 이 줄이 «없으면» 침묵이 정상과 구별되지 않는다.
    #   ⭐ 배달을 «같이» 싣는다: 살아 있는데 파일로 새는 상태(ⓑ)가 이 한 줄로 보이게.
    if [ "$HEARTBEAT_EVERY" -gt 0 ] && [ $((WATCH_CYCLES % HEARTBEAT_EVERY)) = "0" ]; then
      printf '♥ [watch-%s-%s %s] 주기=%s · 마지막 성공 조회=%s · 연속 실패=%s · 배달=%s\n' \
        "$PR_NUM" "$TRACK" "$now" "$WATCH_CYCLES" "${WATCH_LAST_OK:-«한 번도 성공 못 함»}" \
        "$WATCH_FAILS" "$(delivery_of "$$")"
    fi
  done
}

case "$CMD" in
  status)
    h=$(holder_pid)
    if [ -n "$h" ]; then
      echo "✅ [$TRACK] 감시 살아있음 · pid=$h · 기동=$(proc_started "$h")"
      # ⛔ 「사나」만 말하면 «파일로 새는» 감시자가 초록으로 보인다(위 delivery_of 머리말).
      echo "   📮 배달 → $(delivery_of "$h")"
    elif [ -f "$PIDFILE" ]; then
      echo "⛔ [$TRACK] PID 파일은 있으나 그 프로세스가 «내 것이 아니다»(죽었거나 pid 재사용)"
      echo "   기록: $(cat "$PIDFILE")"
    else
      echo "⛔ [$TRACK] 등록된 감시 없음"
    fi
    u=$(discover_untracked)
    if [ -n "$u" ]; then
      echo "⚠️ 등록 안 된 #$PR_NUM 감시자가 argv 에 보인다 — 중복의 씨앗이다:"
      echo "$u"
      echo "   ⇒ 내 것이면 adopt --pid <N> 로 등록하고, 남의 트랙이면 «건드리지 마라»."
    fi
    ;;

  adopt)
    [ -n "$ADOPT_PID" ] || { echo "⛔ --pid 가 필요하다" >&2; exit 2; }
    s=$(proc_started "$ADOPT_PID")
    [ -n "$s" ] || { echo "⛔ pid=$ADOPT_PID 는 살아 있지 않다" >&2; exit 1; }
    # ⛔⭐⭐⭐ 「살아 있다」만 보고 등록하면 «몇 초 뒤 사라질» 폴 자식이 잠금 주인이 된다.
    #   ⇒ holder_pid 가 곧 「없음」이 되고 다음 ensure 가 «진짜 둘째»를 띄운다.
    #   📏 2026-08-17 실측: status 의 거짓 양성이 정확히 그 pid(gh 폴 자식)를 가리키고 있었다.
    #   ⇒ ***이 관문이 없으면 「중복 방지」 명령이 중복을 만든다.***
    if ! is_watcher_proc "$ADOPT_PID"; then
      echo "⛔ pid=$ADOPT_PID 는 «감시자가 아니다» — 등록하지 않았다" >&2
      echo "   argv: $(ps -o command= -p "$ADOPT_PID" 2>/dev/null | cut -c1-80)" >&2
      w=$(top_watcher_ancestor "$ADOPT_PID")
      if [ -n "$w" ]; then
        echo "   ⇒ 이것은 pid=$w 감시자의 «자식»이다. 등록할 것이 있다면 그 pid 를 줘라." >&2
      else
        echo "   ⇒ 조상에도 감시자가 없다. 띄우려면 adopt 가 아니라 ensure 를 써라." >&2
      fi
      exit 1
    fi
    mkdir "$LOCKDIR" 2>/dev/null || true
    record_pid "$ADOPT_PID"
    echo "✅ [$TRACK] pid=$ADOPT_PID 를 잠금에 등록했다 · 기동=$s"
    echo "   ⇒ 이제 ensure 가 이것을 보고 «둘째를 안 띄운다»"
    ;;

  stop)
    h=$(holder_pid)
    if [ -n "$h" ]; then
      # ⛔ 못 죽였으면 기록을 «지우지 않는다» — 지우면 살아 있는 감시자가 「없는 것」이 되고
      #    다음 ensure 가 둘째를 띄운다(release_if_mine 머리말의 ③ 과 같은 경로).
      kill_and_verify "$h" "감시" || {
        echo "⛔ [$TRACK] 기록을 «유지한다» — 살아 있는 것을 「없다」로 만들지 않는다." >&2
        exit 1
      }
    else
      # ⛔ 증명 못 하면 죽이지 않는다 — 잘못된 종료는 «침묵»을 만든다.
      echo "⛔ [$TRACK] 죽일 대상을 «증명하지 못했다» — 아무것도 죽이지 않았다"
      [ -f "$PIDFILE" ] && echo "   기록: $(cat "$PIDFILE")"
    fi
    rm -f "$PIDFILE"; release_lock
    ;;

  restart)
    h=$(holder_pid)
    # ⛔⭐ 못 죽였으면 «둘째를 띄우지 않는다» — 그것이 이 스크립트가 막으려던 바로 그 상태다.
    #    종전엔 kill 성공 여부와 무관하게 아래로 내려가 새 루프를 띄웠고, 그래서
    #    2026-08-06 에 [T] 감시자가 «둘» 이 됐다(옛것 05:43 + 새것 15:39).
    if [ -n "$h" ]; then
      kill_and_verify "$h" "기존 감시" || {
        echo "⛔ [$TRACK] 기존 감시를 못 죽였다 ⇒ 새 감시를 띄우지 «않는다»(중복 금지)." >&2
        exit 1
      }
    fi
    rm -f "$PIDFILE"; release_lock
    acquire_lock || { echo "⛔ 잠금을 못 잡았다" >&2; exit 1; }
    trap 'announce_exit EXIT' EXIT; trap 'announce_exit INT; exit 130' INT; trap 'announce_exit TERM; exit 143' TERM
    record_pid "$$"
    watch_loop
    ;;

  ensure)
    if ! acquire_lock; then
      h=$(holder_pid)
      # ⛔⭐⭐ 잠금은 «못 잡았는데» 소유자를 «증명 못 하는» 경우가 있다(무인 리뷰 must-fix ①).
      #    종전엔 그 상태에도 `✅ 이미 감시 중 · pid=`(빈 pid)를 냈다 —
      #    ***이 PR 이 고치려는 「측정 실패를 정상으로 보고」의 판본을 이 PR 이 만들고 있었다.***
      if [ -z "$h" ]; then
        echo "⚠️ [$TRACK] 잠금이 «남의 것»인데 소유자를 «증명하지 못했다» — 둘째를 띄우지 않았다"
        echo "   ⛔ 이것은 「정상」이 아니라 «모름»이다. 기록을 보고, 유령이면 restart 하라"
        [ -f "$PIDFILE" ] && echo "   기록: $(cat "$PIDFILE")"
        exit 0
      fi
      echo "✅ [$TRACK] 이미 감시 중 · pid=$h — «둘째를 띄우지 않았다»"
      # ⛔⭐ 여기가 특히 중요하다 — 「이미 돌고 있다」를 보고 «안심»하고 돌아서는 자리다.
      #    그 감시자가 «파일»로 새고 있으면 이 창은 영영 아무것도 못 받는다.
      echo "   📮 배달 → $(delivery_of "$h")"
      echo "   바꾸려면: $0 restart --track $TRACK"
      exit 0
    fi
    trap 'announce_exit EXIT' EXIT; trap 'announce_exit INT; exit 130' INT; trap 'announce_exit TERM; exit 143' TERM
    record_pid "$$"
    u=$(discover_untracked)
    if [ -n "$u" ]; then
      echo "⚠️ 등록 안 된 #$PR_NUM 감시자가 argv 에 보인다 — 같은 코멘트가 두 번 올 수 있다:"
      echo "$u"
      echo "   ⇒ 내 옛 창의 것이면 그 창에서 끄거나 adopt 로 등록하라(남의 트랙이면 건드리지 마라)."
    fi
    watch_loop
    ;;

  delivery)
    # ⭐ 진단 보조 ⊕ ***회귀 테스트의 진입점*** — 임의 pid 의 stdout 이 «어디로 가나»만 말한다.
    #   ⛔ 감시 상태를 안 본다(잠금·PID 파일 무접촉). 그래서 테스트가 «네트워크 없이»
    #      분류 전수(파일·null·파이프·비-tty CHR·죽은 pid·lsof 없음)를 돌 수 있다.
    [ -n "$ADOPT_PID" ] || { echo "⛔ --pid 가 필요하다" >&2; exit 2; }
    printf '%s\n' "$(delivery_of "$ADOPT_PID")"
    ;;

  discover)
    u=$(discover_untracked)
    if [ -n "$u" ]; then echo "$u"; else
      echo "(argv 에 안 잡힘 — ⛔ 「없다」가 아니다: 서브셸 감시자는 여기 원래 안 잡힌다)"
    fi
    ;;
esac
