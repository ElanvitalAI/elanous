#!/bin/bash
#
# DEMO-1126 A&B — 11-26(목) 20:00 AI&B 발표 · els 오케스트레이션 시험 우주 실연 스크립트
# 칸: ELS-ORCH-DEMO-SCENARIO(0.3.34 P0 · UX 대본) · 대본 = 내부 문서 `DEMO-1126-AIB-ELS-ORCH-RUNBOOK`
# 설계 정본: 내부 문서 `ELS-ORCHESTRATION` §5 · v4 조정(대표 11-23 21:1x~21:2x) = ~/elanous-hq/seat-state/OP/orders/ELS-ORCH-DEMO-1126.md
#
# 원칙(정본 §5 + v4 + OP #134482):
#   · 실매매 0 · 고지 «정보 제공·판단 보조이며 투자 권유 아님»
#   · 합성 사고는 전부 «[합성]» 표시 + 출처 주석 — 실제 운영 사고로 오인 금지
#   · 실제 msg 원장 격리 미검증 — flood 실발송 전 무조건 중단(fail-closed HOLD).
#     dry-run 계획은 ELANOUS_HISTORY_DIR 이 시험 우주 상태루트 안일 때만 출력.
#   · 삭제 명령 없음 — 상태루트·로그·영수는 보존(정리는 리허설 뒤 사람 몫)
#
# 단계:
#   boot     시험 우주 기동(nexus run --test · 고립 history) → /app/ 200 확인
#   flood    2막 «HQ 가 스스로 돈다» — 합성 사고 30통(폭주 12 · 승인 8 · 도구거부 6 · 착지0 4)
#   briefs   3막 «에이전트가 에이전트를 부린다» — 리서치 위임봉투 3(뉴스·감성·시장) 인쇄(부작용 0)
#   check    헬스·pid 생존 점검 + [receipt]
#   capture  80×24 · 발표 해상도 캡처(screencapture) → evidence 경로
#   teardown pidfile 의 nexus 데몬만 TERM 정지(명령 불일치 시 거부)
#
# --dry-run: [plan] 줄만 인쇄(부작용 0) — 단위 시험(aib-orch-1126-run.test.ts)은 이 모드로 검증.
# 사용 예:
#   scripts/demo/aib-orch-1126-run.sh --phase boot --dry-run
#   ELANOUS_HISTORY_DIR=<상태루트>/history scripts/demo/aib-orch-1126-run.sh --phase flood
#
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
ELN="$REPO_ROOT/bin/elanous.mjs"

PORT_MIN=31500
PORT_MAX=31599
DEFAULT_PORT=31561
DEFAULT_STATE_DIR="$REPO_ROOT/.elanous-test/demo-1126"
DEFAULT_EVIDENCE_DIR="$HOME/elanous-hq/seat-state/UX/demo-1126/evidence"
HEALTH_PATH="/app/"
BOOT_TIMEOUT_SEC=90

DRY_RUN=0
PHASE=""
PORT="$DEFAULT_PORT"
STATE_DIR="$DEFAULT_STATE_DIR"
EVIDENCE_DIR="$DEFAULT_EVIDENCE_DIR"
HISTORY_DIR="${ELANOUS_HISTORY_DIR:-}"

usage() {
  echo "Usage: $0 --phase <boot|flood|briefs|check|capture|teardown> [--dry-run] [--port N(31500-31599)] [--state-dir D] [--evidence-dir D]"
  echo "  flood 실발송은 격리 검증 전 HOLD; dry-run 계획에는 ELANOUS_HISTORY_DIR=<시험 우주 상태루트>/history 필수."
}

refuse() { echo "[refuse] $*" >&2; exit 3; }

while [ $# -gt 0 ]; do
  case "$1" in
    --phase) PHASE="${2:?--phase needs a value}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --port) PORT="${2:?--port needs a value}"; shift 2 ;;
    --state-dir) STATE_DIR="${2:?--state-dir needs a value}"; shift 2 ;;
    --evidence-dir) EVIDENCE_DIR="${2:?--evidence-dir needs a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[ -n "$PHASE" ] || { usage >&2; exit 2; }
case "$PHASE" in boot|flood|briefs|check|capture|teardown) ;; *) echo "unknown phase: $PHASE" >&2; exit 2 ;; esac
case "$PORT" in
  ''|*[!0-9]*) echo "port not a number: $PORT" >&2; exit 2 ;;
esac
if [ "$PORT" -lt "$PORT_MIN" ] || [ "$PORT" -gt "$PORT_MAX" ]; then
  echo "port $PORT out of demo range $PORT_MIN-$PORT_MAX" >&2; exit 2
fi

PIDFILE="$STATE_DIR/nexus.pid"
BOOT_LOG="$STATE_DIR/boot.log"

history_under_state() {
  # dry-run 은 부작용 0 — mkdir 없이 문자열 방위로만 판정.
  [ -n "$HISTORY_DIR" ] || return 1
  local hist_abs="" state_abs=""
  if [ "$DRY_RUN" = 0 ]; then mkdir -p -- "$STATE_DIR"; fi
  if [ -d "$HISTORY_DIR" ]; then hist_abs="$(cd -- "$HISTORY_DIR" && pwd)"; else hist_abs="$HISTORY_DIR"; fi
  if [ -d "$STATE_DIR" ]; then state_abs="$(cd -- "$STATE_DIR" && pwd)"; else state_abs="$STATE_DIR"; fi
  case "$hist_abs" in "$state_abs"/*) return 0 ;; *) return 1 ;; esac
}

health_ok() {
  curl -fsS --max-time 5 "http://127.0.0.1:$PORT$HEALTH_PATH" -o /dev/null
}

phase_boot() {
  if [ "$DRY_RUN" = 1 ]; then
    echo "[plan] mkdir -p $STATE_DIR/history"
    echo "[plan] cd $REPO_ROOT && nohup setsid bun $ELN nexus run --test --port $PORT --history-dir $STATE_DIR/history >> $BOOT_LOG 2>&1 & echo \$! > $PIDFILE"
    echo "[plan] curl http://127.0.0.1:$PORT$HEALTH_PATH (최대 ${BOOT_TIMEOUT_SEC}s 초 폴링)"
    echo "[receipt] phase=boot dry-run=1 port=$PORT marker=DEMO1126_BOOT_PLANNED"
    return 0
  fi
  mkdir -p -- "$STATE_DIR/history"
  ( cd "$REPO_ROOT" && nohup setsid bun "$ELN" nexus run --test --port "$PORT" --history-dir "$STATE_DIR/history" >>"$BOOT_LOG" 2>&1 & echo $! >"$PIDFILE" )
  local i=0
  until health_ok; do
    i=$((i+1)); [ "$i" -le "$BOOT_TIMEOUT_SEC" ] || { echo "[fail] /app/ 헬스 ${BOOT_TIMEOUT_SEC}s 초과 — $BOOT_LOG 확인" >&2; exit 4; }
    sleep 1
  done
  echo "[receipt] phase=boot port=$PORT pid=$(cat "$PIDFILE") app=200 marker=DEMO1126_BOOT_DONE"
}

flood_post() {
  # 이 함수 자체도 계획 전용: 향후 호출 경로가 바뀌어도 실발송을 허용하지 않는다.
  [ "$DRY_RUN" = 1 ] || refuse "실제 msg 원장 격리 미검증 — flood 발송 전 fail-closed HOLD"
  # $1 index · $2 category · $3 detail
  local body
  body="$(printf '[합성] DEMO-1126 2막 합성 사고 #%s/30 — %s: %s — 출처: DEMO-1126 실연 스크립트(합성 · 실제 사고 아님 · 실매매 0)' "$1" "$2" "$3")"
  echo "[plan] bun $ELN msg post --from SIM --to OP --kind alert --body \"$body\""
}

phase_flood() {
  # msg post 의 실제 원장은 ELANOUS_HISTORY_DIR 로 격리되지 않는다.
  # 검증된 격리 경로가 생기기 전에는 환경값·헬스와 무관하게 발송 전 차단한다.
  [ "$DRY_RUN" = 1 ] || refuse "실제 msg 원장 격리 미검증 — flood 발송 전 fail-closed HOLD"
  history_under_state || refuse "ELANOUS_HISTORY_DIR(${HISTORY_DIR:-미설정}) 이 시험 우주 상태루트($STATE_DIR) 안이 아님 — 운영 원장 오발송 방지 fail-closed"
  local idx=0 label="" rest="" n="" detail="" k=""
  for spec in \
    "우편 폭주:12:동시 우편 유입 과다(큐 적체)" \
    "승인 프롬프트:8:HITL 승인 대기열 급증(사람 대기)" \
    "도구 거부:6:control-allow 거부 연속(권한 없음)" \
    "착지 0:4:열차 착지 0건(수거 정체)"
  do
    label="${spec%%:*}"; rest="${spec#*:}"; n="${rest%%:*}"; detail="${rest#*:}"
    for k in $(seq 1 "$n"); do
      idx=$((idx+1))
      flood_post "$idx" "$label" "$detail"
    done
  done
  echo "[receipt] phase=flood posts=$idx marker=DEMO1126_FLOOD_DONE dry-run=$DRY_RUN"
}

phase_briefs() {
  # 3막 위임봉투 — 인쇄만(부작용 0). 발표자가 els 탭 3개(new/send)에 직접 입력.
  # 원칙: news 탭 = firecrawl 단독(OP #134482 · exa·tavily 대체 금지) · market KIS = uv run --with requests 고정.
  echo "[brief news] 2027 한국 주식시장 전망 — 뉴스·증권사 리포트: 한국 주식 2027 전망 헤드라인 5~10개(firecrawl 단독). 완료 기준: 출처 URL ≥5 · 각 1줄 요지."
  echo "[brief sentiment] 2027 한국 주식시장 전망 — 여론·감성: 웹·X 스캔, 투자자·전문가 감성(긍/부/중립 + 대표 인용 ≥3). 완료 기준: 비율 한 줄 + 인용 3."
  echo "[brief market] 2027 한국 주식시장 전망 — 시장 데이터: EODHD 지수·환율·금리·SOX ⊕ 한투 외국인·기관 수급·업종(KIS uv run --with requests 고정). 완료 기준: 지표 표 1장 + 수급 방향 한 줄."
  echo "[note] 고지: 정보 제공·판단 보조이며 투자 권유 아님 · 실매매 0 · 패널 페르소나는 역할 기반 6(거시·사이클·수급·환율·반도체·리스크) 60~90초 상한 병렬 · 실존 멘토 흉내 0(멘토 시드는 이름+요지 출처 인용만) · aside 탭은 선택(막히면 빼고 진행)"
  echo "[receipt] phase=briefs briefs=3 marker=DEMO1126_BRIEFS_PRINTED dry-run=$DRY_RUN"
}

phase_check() {
  if [ "$DRY_RUN" = 1 ]; then
    echo "[plan] curl http://127.0.0.1:$PORT$HEALTH_PATH"
    echo "[plan] ps -p \$(cat $PIDFILE) — nexus 생존 확인"
    echo "[receipt] phase=check dry-run=1"
    return 0
  fi
  health_ok || { echo "[fail] /app/ 헬스 실패(port $PORT)" >&2; exit 4; }
  local pid=""; [ -f "$PIDFILE" ] && pid="$(cat "$PIDFILE")"
  local alive="no"
  if [ -n "$pid" ] && ps -p "$pid" >/dev/null 2>&1; then alive="yes"; fi
  echo "[receipt] phase=check app=200 pid=${pid:-none} alive=$alive state=$STATE_DIR port=$PORT"
}

phase_capture() {
  local stamp; stamp="$(date +%Y%m%d-%H%M)"
  if [ "$DRY_RUN" = 1 ]; then
    echo "[plan] mkdir -p $EVIDENCE_DIR"
    echo "[plan] 터미널 80×24 로: stty rows 24 cols 80 → 스크린샷 $EVIDENCE_DIR/act-80x24-$stamp.png"
    echo "[plan] screencapture -x $EVIDENCE_DIR/act-presentation-$stamp.png"
    echo "[receipt] phase=capture dry-run=1 evidence=$EVIDENCE_DIR"
    return 0
  fi
  mkdir -p -- "$EVIDENCE_DIR"
  if [ "$(stty size 2>/dev/null || echo '')" = "24 80" ]; then
    screencapture -x "$EVIDENCE_DIR/act-80x24-$stamp.png"
    echo "[receipt] phase=capture 80x24=$EVIDENCE_DIR/act-80x24-$stamp.png"
  else
    echo "[hint] 80×24 샷은 터미널을 stty rows 24 cols 80 로 맞추고 재실행 — 이번은 발표 해상도만."
  fi
  screencapture -x "$EVIDENCE_DIR/act-presentation-$stamp.png"
  echo "[receipt] phase=capture presentation=$EVIDENCE_DIR/act-presentation-$stamp.png"
}

phase_teardown() {
  if [ "$DRY_RUN" = 1 ]; then
    echo "[plan] pid=\$(cat $PIDFILE) → ps -o command= 확인(«nexus run --test» 만) → kill <pid>"
    echo "[receipt] phase=teardown dry-run=1"
    return 0
  fi
  if [ ! -f "$PIDFILE" ]; then echo "[skip] pidfile 없음($PIDFILE) — 정지할 데몬 없음"; return 0; fi
  local pid; pid="$(cat "$PIDFILE")"
  case "$pid" in ''|*[!0-9]*) echo "[refuse] pidfile 내용이 숫자 아님: $pid" >&2; exit 5 ;; esac
  local cmd=""; cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  if [ -z "$cmd" ]; then echo "[skip] pid $pid 이미 없음"; return 0; fi
  case "$cmd" in
    *"nexus run"*" --test"*) kill "$pid"; echo "[receipt] phase=teardown pid=$pid term" ;;
    *) echo "[refuse] pid $pid 명령이 «nexus run --test» 아님: $cmd" >&2; exit 5 ;;
  esac
}

case "$PHASE" in
  boot) phase_boot ;;
  flood) phase_flood ;;
  briefs) phase_briefs ;;
  check) phase_check ;;
  capture) phase_capture ;;
  teardown) phase_teardown ;;
esac