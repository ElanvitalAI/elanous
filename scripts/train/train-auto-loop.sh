#!/bin/zsh
# Pin the installed package root before the loop snapshots itself into artifacts.
# A stale caller environment must not redirect a fresh launcher to another runner.
if [[ ${TRAIN_LOOP_SNAPSHOT:-0} != 1 ]]; then
  export TRAIN_SOURCE_ROOT=${0:A:h:h:h}
elif [[ -z ${TRAIN_SOURCE_ROOT:-} ]]; then
  print -u2 'snapshot train source root missing'
  exit 2
fi
[[ -f $TRAIN_SOURCE_ROOT/scripts/train/legacy/train-batch-live.py ]] || { print -u2 "versioned train batch source missing: $TRAIN_SOURCE_ROOT"; exit 2; }
# 실행 중 원본이 바뀌어도 현재 루프는 시작 시점 사본으로 끝까지 돈다.
if [[ ${TRAIN_LOOP_SNAPSHOT:-0} != 1 ]]; then
  snapshot_dir=$HOME/elanous-hq/seat-state/OP/train-artifacts/loop-snapshots
  mkdir -p "$snapshot_dir" || exit 1
  snapshot=$(mktemp "$snapshot_dir/train-auto-loop.XXXXXX") || exit 1
  cp "$0" "$snapshot" || { rm -f "$snapshot"; exit 1; }
  chmod 700 "$snapshot"
  TRAIN_LOOP_SNAPSHOT=1 TRAIN_LOOP_SNAPSHOT_PATH="$snapshot" exec zsh "$snapshot" "$@"
fi
snapshot_cleanup(){ [[ -n ${TRAIN_LOOP_SNAPSHOT_PATH:-} ]] && rm -f "$TRAIN_LOOP_SNAPSHOT_PATH"; }
# train-auto-loop.sh — OP 10-27 23:0x 대표 «이 기준으로 계속 · 빠르게 가속»
# 착지 줄에 2개 이상 쌓이면 열차(최대 4)를 쉬지 않고 연달아 띄운다. STOP_AT 이후에는 새 열차를 띄우지 않는다.
# 열차 게이트가 passed 인데 GitHub API 시간초과로 착지가 끊긴 PR 은 같은 summary 로 land-single 을 한 번 더 시도한다(판정 확인 뒤에만).
#
# OP 10-28 20:0x 대표 «열차 둘 병렬» — 같은 스크립트를 호스트마다 하나씩 띄운다(복사본 금지):
#   HOST=node-b  zsh train-auto-loop.sh   (열차 A)   HOST=node-c (B)   HOST=minim5 (C) …
# 호스트 N개: 등록부 seat-state/OP/train-hosts.tsv 한 줄(host·shards·run-id 접두) + 루프 하나. SHARDS·RUN_PREFIX·RETRY_HOST 환경변수로 덮어쓸 수 있다.
# 열차마다 자기 것: 배치 잠금 $Q.batch.lock.$HOST · 로그 train-auto-loop-$HOST.log · 산출 batch-$HOST-<id> · run-id(등록부 접두 · 호스트마다 다르다).
# 재판정(failed/unmeasured)은 기본 «자기 호스트»(RETRY_HOST=$HOST) — 남의 열차 호스트로 가면 게이트 둘이 겹쳐 OOM(10-28 193133).
# 서로 다른 PR: 고르기(dry-run)는 공용 선택 잠금 $Q.select.lock 안에서 하고, 고른 PR 을 claim 파일(train-claims/claim-$HOST.tsv)에 적는다.
#   다른 열차는 살아 있는 claim 의 PR 을 --exclude 로 뺀다. claim 은 열차가 끝나면 지우고, 주인 pid·배치 잠금 주인이 다 죽었으면 stale 로 무시한다.
# 병합 직렬화: land-single.sh 안의 병합 뮤텍스($Q.merge.lock)가 두 열차의 병합을 한 줄로 세운다(main-moved 좁은 재검 그대로).
HOST=${HOST:-node-b}
SLOT=${TRAIN_SLOT:-1}
[[ $SLOT == <-> && $SLOT -ge 1 ]] || { print -u2 "TRAIN_SLOT must be a positive integer"; exit 2; }
REG=$HOME/elanous-hq/seat-state/OP/train-hosts.tsv
row=$(awk -F'\t' -v h=$HOST '$1==h' $REG 2>/dev/null | head -1)
[[ -n $row ]] || { print -u2 "HOST=$HOST 가 등록부 $REG 에 없다"; exit 2; }
[[ $(print -r -- "$row" | cut -f8) == yes ]] || { print -u2 "HOST=$HOST 는 등록부상 gateHost 가 아니다"; exit 2; }
SHARDS=${SHARDS:-$(print -r -- $row | cut -f2)}; RP=${RUN_PREFIX-$(print -r -- $row | cut -f3)}; [[ $RP == - ]] && RP=''
[[ $SHARDS == <-> && $RP == (|<->) ]] || { print -u2 "등록부 줄이 이상하다: $row"; exit 2; }
dup=$(awk -F'\t' -v h=$HOST -v p="${RP:--}" '!/^#/ && $1!=h && $3==p' $REG | head -1); [[ -z $dup ]] || { print -u2 "run-id 접두 $RP 가 다른 호스트와 겹친다: $dup"; exit 2; }
RETRY_HOST=${RETRY_HOST:-$HOST}
MIN_PRS=${MIN_PRS:-2}  # 묶음 최소 PR 수(기본 2 · B=node-c 는 1 로 띄워 혼자 남은 PR 을 단독 급행)
WORKER_MODE=${TRAIN_WORKER_MODE:-0}
MANAGER_DIR=$HOME/elanous-hq/seat-state/OP/train-manager
ASSIGN_DIR=$MANAGER_DIR/assignments
WORKER_PID_FILE=$MANAGER_DIR/workers/$HOST-$SLOT.pid
ASSIGN_FILE=$ASSIGN_DIR/$HOST-$SLOT.json
Q=$HOME/elanous-hq/seat-state/OP/land-queue.tsv
TB=$TRAIN_SOURCE_ROOT/scripts/train/legacy/train-batch-live.py
MEMORY=$TRAIN_SOURCE_ROOT/scripts/train/legacy/train-memory.py
LS=$HOME/elanous-hq/seat-state/OP/tools/train-1016/night-train/land-single.sh
AR=$HOME/elanous-hq/seat-state/OP/train-artifacts
CL=$HOME/elanous-hq/seat-state/OP/train-claims
REPO=$HOME/elanous-hq/work/OP-release-0238
SEAT=$HOME/elanous-hq/seats/OP
PARK=$HOME/elanous-hq/seat-state/OP/tools/train-park.py
AMG=$HOME/elanous-hq/seat-state/OP/tools/train-conflict-resolve.sh
LOG=$AR/train-auto-loop-$HOST.log
SLOT_SUFFIX=''; [[ $SLOT == 1 ]] || SLOT_SUFFIX=.$SLOT
BL=$Q.batch.lock.$HOST$SLOT_SUFFIX
SL=$Q.select.lock
MYCLAIM=$CL/claim-$HOST${SLOT_SUFFIX/./-}.tsv
STOP_AT=${STOP_AT:-299912312359}  # expired 2026-11-06 hard rehearsal window; no implicit worker cutoff
mkdir -p $CL
log(){ print -r -- "$(date '+%m-%d %H:%M:%S') [$HOST] $*" >> $LOG; }
post(){ eln msg post --from OP --to OP --kind coord --body "$1" >/dev/null 2>&1; }
try_amg(){ log 'AMG preflight skipped; Railwright owns conflict-ladder stage 2'; }
alive(){ [[ "$1" == <-> ]] && kill -0 "$1" 2>/dev/null; }
lock_owner(){ jq -r .pid "$1/owner.json" 2>/dev/null; }
# 다른 열차들의 살아 있는 claim PR(쉼표). claim 줄 = pid<TAB>host<TAB>lockdir<TAB>prs. 주인 pid 도 배치 잠금 주인도 죽었으면 stale.
# OP 10-29 20:0x 대표 «열차 오르기 전 낮은 비용으로 거르기» — 비용 0 의 사전 거름 둘
#  ① 의심 명단(train-suspects.tsv · train-park.py 가 «귀속 불명» 후보를 적는다): 같은 배치에서 같이 실패한 후보끼리는 다시 같이 타지 않는다 — 줄 앞의 하나만 태워 귀속을 가른다. head 가 바뀌거나 TTL 이 지나면 풀린다.
#  ③ 2차 검색대 = 열차 B(node-c): 의심이 있으면 B 는 그 의심 하나만 단독으로 태운다(혼자 실패 = 귀속 확정 → strike · 통과 = 착지 ⊕ 의심 해제). A·C 는 의심을 아예 안 태운다.
#  ② head 신선도: 착지 줄의 head 와 GitHub 의 현재 head 가 다르면(주인이 수리 push 중) 태우지 않는다 — 옛 head 로 게이트를 태우는 낭비를 막는다.
precheck_ex(){
  python3 - "$Q" "$HOME/elanous-hq/seat-state/OP/train-suspects.tsv" "$HOST" "$HOME/elanous-hq/seat-state/OP/train-unmeasured-cooldowns-$HOST.tsv" "$1" <<'PY'
import sys, time, json, subprocess
q, sp, host, cooldown_path, base = sys.argv[1:6]
rows = [l.split('\t') for l in open(q).read().splitlines() if l.split('\t')[0].isdigit()]
order = {r[0]: i for i, r in enumerate(rows)}; head = {r[0]: r[1] for r in rows}
ex = []; follow = []
import os
try:
    cooldowns = [l.split('\t') for l in open(cooldown_path).read().splitlines() if l.split('\t')[0].isdigit()]
except FileNotFoundError:
    cooldowns = []
for fields in cooldowns:
    if len(fields) < 3: continue
    pr, cd_head, until = fields[:3]; rest = fields[3:]
    if pr in head and head[pr] == cd_head and until.isdigit() and int(until) > time.time():
        ex.append(pr)
        print(f'cooldown #{pr} host={host} until={until} batch={(rest[0] if rest else "unknown")}', file=sys.stderr)
try:
    sus = [l.split('\t') for l in open(sp).read().splitlines() if l.split('\t')[0].isdigit()]
except FileNotFoundError:
    sus = []
memory_path = os.path.expanduser('~/elanous-hq/seat-state/OP/train-memory.jsonl')
measured = set()
try:
    for line in open(memory_path, encoding='utf-8'):
        try:
            event = json.loads(line); key = event.get('key', {})
            if (event.get('schema') == 'elanous.memory.v1'
                    and key.get('base') == base.lower()
                    and event.get('eventType') == 'batch-gate'
                    and event.get('status') in ('passed', 'failed', 'precondition-unmet', 'conflict')):
                measured.add((str(key.get('pr')), str(key.get('head', '')).lower()))
        except Exception:
            continue
except FileNotFoundError:
    pass
for pr, row_head in head.items():
    if (pr, row_head.lower()) in measured:
        ex.append(pr)
        print(f'memory-skip #{pr} head={row_head[:12]} base={base[:12]}', file=sys.stderr)
for pr in head:
    try:
        cur = subprocess.run(['gh', 'pr', 'view', pr, '-R', 'ElanvitalAI/elanous', '--json', 'headRefOid', '-q', '.headRefOid'], capture_output=True, text=True, timeout=20).stdout.strip()
    except Exception:
        cur = ''
    if len(cur) == 40 and not cur.startswith(head[pr][:12]):
        # 대표 10-29 20:1x «필요 이상의 숙제를 주지 마라» — 표는 PR 을 따라간다: 새 head 에 통과 리뷰(웨이버 포함)가 있거나
        #   새 head 가 «리뷰된 head ⊕ main» merge 면(승계) 줄의 head 를 스스로 바꿔 태운다. 아니면 리뷰가 올 때까지 조용히 기다린다(재등록·우편 없음).
        import glob, os
        ok = None
        for f in glob.glob(os.path.expanduser(f'~/.elanous/review-results/*-{pr}-{cur[:12]}.json')):
            try:
                j = json.load(open(f))
            except Exception:
                continue
            if j.get('verdict') in ('pass', 'passed') and not j.get('mustFix') and str(j.get('headCommit', ''))[:12] == cur[:12]:
                ok = f; break
        if ok:
            follow.append((pr, cur, ok)); ex.append(pr); print(f'follow #{pr} {head[pr][:12]}→{cur[:12]} ({os.path.basename(ok)})', file=sys.stderr)
        else:
            ex.append(pr); print(f'wait-review #{pr} gh={cur[:12]}', file=sys.stderr)
live = sorted([f[0] for f in sus if f[0] in head and head[f[0]].startswith(f[1][:12]) and int(f[2]) > time.time() and f[0] not in ex], key=lambda p: order[p])
# 공항 검문(대표 10-29 20:0x): 일반 줄(A·C 묶음 열차)은 의심을 태우지 않는다 · 2차 검색대 = 열차 B(node-c · 혼자 출발) — 의심 하나만 단독으로 재서 귀속을 가른다
if host == 'node-c' and live:
    ex += [p for p in head if p != live[0]]
    print(f'2차 검색 #{live[0]} 단독', file=sys.stderr)
else:
    ex += live
tree = {r[0]: (r[2] if len(r) > 2 else '') for r in rows}
for pr, cur, rv in follow:
    # 정식 등록 도구로 다시 올린다 — 증거 JSON·리뷰 판정까지 새 head 로(줄 교체는 land-enqueue 가 잠금 안에서 한다). 이번 바퀴엔 태우지 않고 다음 바퀴에 새 증거로 탄다.
    try:
        r = subprocess.run(['zsh', os.path.expanduser('~/elanous-hq/seat-state/OP/tools/land-enqueue.sh'), pr, tree.get(pr) or 'train:auto-follow', '--review', rv, '--expected-head', cur], capture_output=True, text=True, timeout=600)
        print(f'follow #{pr} land-enqueue rc={r.returncode} {(r.stdout or r.stderr).strip().splitlines()[0][:160] if (r.stdout or r.stderr).strip() else ""}', file=sys.stderr)
    except Exception as e:
        print(f'follow #{pr} land-enqueue 실패 {e}', file=sys.stderr)
print(','.join(sorted(set(ex))))
PY
}
other_claims(){
  local f p h l prs active lock_pid out=()
  for f in $CL/claim-*.tsv(N); do
    [[ $f == $MYCLAIM ]] && continue
    IFS=$'\t' read -r p h l prs < $f || continue
    active=0
    if [[ -n $l && -d $l ]]; then
      lock_pid=$(lock_owner $l)
      alive "$lock_pid" && active=1
    elif alive "$p"; then
      active=1  # claim-to-lock launch window; loop still owns the imminent batch
    fi
    if (( active )); then out+=(${(s:,:)prs})
    else mv $f $f.stale-$(date +%H%M%S) 2>/dev/null; log "stale claim 정리 $f ($h claim=$p lock=${lock_pid:-absent})"; fi
  done
  print -r -- ${(j:,:)out}
}
sel_lock(){ local n=0 o; until mkdir $SL 2>/dev/null; do o=$(cat $SL/pid 2>/dev/null); if [[ -n $o ]] && ! alive $o; then mv $SL $SL.stale-$(date +%H%M%S) 2>/dev/null; continue; fi; sleep 3; (( ++n > 300 )) && return 1; done; print -r -- $$ > $SL/pid; }
sel_unlock(){ [[ $(cat $SL/pid 2>/dev/null) == $$ ]] && { rm -f $SL/pid; rmdir $SL; }; }
release_claim(){
  [[ -f $MYCLAIM ]] || return 0
  local p h l prs why=${1:-loop-transition}
  IFS=$'\t' read -r p h l prs < $MYCLAIM || true
  rm -f $MYCLAIM
  log "claim released reason=$why owner=${p:-?} prs=${prs:-?}"
}
record_express_land(){
  local pr=$1 head=$2 rid=$3 summary=$4 result=$5 land_status=failed
  [[ $result == 0 ]] && land_status=landed
  python3 "$MEMORY" append --source train --event-type land --pr "$pr" --head "$head" --base "$B" \
    --run-id "$rid" --status "$land_status" --data "{\"host\":\"$HOST\",\"summary\":\"$summary\",\"artifacts\":\"$A\"}" >/dev/null 2>&1 || \
    log "memory land append failed pr=$pr run=$rid"
}
# 신호로 죽어도 선택 잠금은 푼다. claim 은 남긴다 — 고아 배치가 돌면 배치 잠금 주인이 살아 있어 유효, 끝나면 stale 로 걷힌다.
worker_cleanup(){ [[ -f $WORKER_PID_FILE && $(cat $WORKER_PID_FILE 2>/dev/null) == $$ ]] && rm -f "$WORKER_PID_FILE"; }
trap 'sel_unlock; worker_cleanup; snapshot_cleanup' EXIT
trap 'exit 143' TERM INT HUP
log "start pid=$$ stop_at=$STOP_AT shards=$SHARDS retry=$RETRY_HOST runPrefix=${RP:-none} lock=$BL"
while :; do
  [ $(date +%Y%m%d%H%M) -ge $STOP_AT ] && { log "stop_at 도달 — 새 열차 없음"; post "[train-auto $HOST] $STOP_AT 이후 새 열차 정지(하드 예행 창)"; exit 0; }
  if [[ $WORKER_MODE == 1 ]]; then
    mkdir -p "$MANAGER_DIR/workers" "$ASSIGN_DIR"
    print -r -- $$ > "$WORKER_PID_FILE"
    if [[ ! -f $ASSIGN_FILE ]]; then sleep 5; continue; fi
    ASSIGN_RUNNING=$ASSIGN_FILE.running
    mv "$ASSIGN_FILE" "$ASSIGN_RUNNING" 2>/dev/null || { sleep 2; continue; }
    stage=$(jq -r '.stage // empty' "$ASSIGN_RUNNING")
    B=$(jq -r '.base // empty' "$ASSIGN_RUNNING")
    RID=$(jq -r '.runId // empty' "$ASSIGN_RUNNING")
    id=$(jq -r '.id // empty' "$ASSIGN_RUNNING")
    # The manager assignment is authoritative: retry the primary slot by default.
    RETRY_HOST=$(jq -r '.retryHost // .host // empty' "$ASSIGN_RUNNING")
    PREFLIGHT_SUMMARY=$(jq -r '.preflightSummary // empty' "$ASSIGN_RUNNING")
    auth=$(jq -r '.prs|join(",")' "$ASSIGN_RUNNING")
    EX=$(jq -r '(.exclude // [])|join(",")' "$ASSIGN_RUNNING")
    prs=(${(s:,:)auth})
    A=$AR/batch-$HOST-$id
    coupled_gate_bundle=0
    [[ $stage == express && $auth == '34447,34448,34455,34457,34458' ]] && coupled_gate_bundle=1
    if [[ ! $B =~ ^[0-9a-f]{40}$ || ! $RID == <1-> || ! $id == <1-> || -z $RETRY_HOST || ${#prs} -lt 1 || (${#prs} -gt 4 && $coupled_gate_bundle != 1) ]]; then
      log "manager assignment invalid · $ASSIGN_RUNNING"; mv "$ASSIGN_RUNNING" "$ASSIGN_RUNNING.invalid"; sleep 2; continue
    fi
    if ! python3 - "$Q" "$ASSIGN_RUNNING" <<'PYASSIGN'
import json, sys
queued = {}
for line in open(sys.argv[1], encoding='utf-8'):
    fields = line.rstrip('\n').split('\t')
    if fields and fields[0].isdigit() and len(fields) > 1:
        queued[fields[0]] = fields[1].lower()
data = json.load(open(sys.argv[2], encoding='utf-8'))
heads = data.get('heads', {})
ok = all(str(pr) in queued and queued[str(pr)] == str(head).lower()
         for pr, head in heads.items()) and set(heads) == set(data.get('prs', []))
raise SystemExit(0 if ok else 1)
PYASSIGN
    then
      log "manager assignment stale head/membership · $ASSIGN_RUNNING"; mv "$ASSIGN_RUNNING" "$ASSIGN_RUNNING.stale"; sleep 2; continue
    fi
    if [[ $stage == group && ${#prs} -lt 1 ]]; then log "manager group requires 1+ PR (OP 11-03 19:0x · 1건짜리도 태운다)"; mv "$ASSIGN_RUNNING" "$ASSIGN_RUNNING.invalid"; continue; fi
    if [[ $HOST == gcp1 || $HOST == gcp2 || $HOST == aws1 || $HOST == aws2 ]]; then
      sync_script=$(print -r -- "$row" | cut -f4)
      case "$sync_script" in
        '$HOME/'*) sync_script="$HOME/${sync_script#'$HOME/'}" ;;
        '~/'*) sync_script="$HOME/${sync_script#'~/'}" ;;
      esac
      sync_out=$(bash "$sync_script" 2>&1); sync_rc=$?
      sync_sha=${sync_out##*sha=}
      if [[ $sync_rc -ne 0 || $sync_out != "$HOST-main-sync ok sha="* || $sync_sha != $B ]]; then
        log "manager pre-dispatch bundle sync not ready rc=$sync_rc output=${sync_out[1,100]} selectedBase=${B[1,12]} synced=${sync_sha[1,12]} · assignment retained"
        mv "$ASSIGN_RUNNING" "$ASSIGN_FILE" 2>/dev/null || true; sleep 15; continue
      fi
    fi
    if [[ -d $BL ]]; then
      mv "$ASSIGN_RUNNING" "$ASSIGN_FILE" 2>/dev/null || true; sleep 10; continue
    fi
    sel_lock || { mv "$ASSIGN_RUNNING" "$ASSIGN_FILE" 2>/dev/null || true; sleep 10; continue; }
    conflicts=$(other_claims)
    overlap=$(python3 - "$auth" "$conflicts" <<'PY'
import sys
a=set(filter(None,sys.argv[1].split(','))); b=set(filter(None,sys.argv[2].split(',')))
print(','.join(sorted(a&b,key=int)))
PY
)
    allow_preflight_overlap=$(jq -r '.allowPreflightOverlap == true' "$ASSIGN_RUNNING" 2>/dev/null)
    if [[ -n $overlap && ( $stage != express || $allow_preflight_overlap != true ) ]]; then sel_unlock; log "manager assignment overlaps live claim #$overlap"; mv "$ASSIGN_RUNNING" "$ASSIGN_FILE" 2>/dev/null || true; sleep 10; continue; fi
    [[ -n $overlap ]] && log "OP-authorized parallel express preflight overlap #$overlap; land-single remains exact-head locked"
    printf '%s\t%s\t%s\t%s\n' $$ $HOST $BL $auth > $MYCLAIM.new && mv $MYCLAIM.new $MYCLAIM || { rm -f $MYCLAIM.new; sel_unlock; mv "$ASSIGN_RUNNING" "$ASSIGN_FILE" 2>/dev/null || true; sleep 5; continue; }
    sel_unlock
    log "manager assigned stage=$stage prs=$auth base=${B[1,12]} run=$RID slot=$SLOT"
    if [[ $stage == express && -n $PREFLIGHT_SUMMARY && -f $PREFLIGHT_SUMMARY ]] && \
       jq -e --arg profile train-always-ratchets-v1 \
         '.gateProfile == $profile and .trainAlwaysRatchets.status == "passed" and .trainAlwaysRatchets.exitCode == 0' \
         "$PREFLIGHT_SUMMARY" >/dev/null 2>&1; then
      row_head=$(jq -r --arg pr "${prs[1]}" '.heads[$pr]' "$ASSIGN_RUNNING")
      zsh "$LS" "$RID" "${prs[1]}" "$row_head" "${B[1,12]}" "$HOST" "$PREFLIGHT_SUMMARY" > $A.log 2>&1
      rc=$?
      record_express_land "${prs[1]}" "$row_head" "$RID" "$PREFLIGHT_SUMMARY" "$rc"
    else
      opts=()
      if [[ $stage == express ]]; then
        opts=(--express)
        [[ $coupled_gate_bundle == 1 ]] || opts+=(--preflight-only)
        [[ $allow_preflight_overlap == true ]] && opts+=(--allow-preflight-overlap)
      elif [[ $stage == preflight ]]; then
        opts=(--express --preflight-only)
      elif [[ $stage == group && ${#prs} -eq 1 ]]; then
        opts=(--express)  # OP 11-03 19:4x 1건짜리 group = 단독 급행(train-batch limit 1 규칙)
      fi
      python3 $TB --live --op-watching --authorize $auth --queue $Q --repo $REPO --base $B --limit ${#prs} --host $HOST \
        --artifacts $A --land-single $LS --side-main $B --run-id $RID --shards $SHARDS --gate-timeout 3600 \
        --exclude "$EX" --lock $BL --retry-host $RETRY_HOST $opts > $A.log 2>&1
      rc=$?
      if [[ $stage == express && $rc == 0 && $(jq -r '.status // empty' "$A/preflight-result.json" 2>/dev/null) == passed ]]; then
        row_head=$(jq -r --arg pr "${prs[1]}" '.heads[$pr]' "$ASSIGN_RUNNING")
        summary=$(jq -r '.summary // empty' "$A/preflight-result.json")
        zsh "$LS" "$RID" "${prs[1]}" "$row_head" "${B[1,12]}" "$HOST" "$summary" >> $A.log 2>&1
        rc=$?
        record_express_land "${prs[1]}" "$row_head" "$RID" "$summary" "$rc"
      fi
    fi
    res=$(tail -1 $A.log | cut -c1-200)
    log "manager done stage=$stage run=$RID rc=$rc · $res"
    release_claim manager-assignment-complete
    rm -f "$ASSIGN_RUNNING"
    continue
  fi
  # 자기 잠금·자기 프로세스만 본다(다른 호스트 열차는 안 본다)
  if [ -d $BL ]; then o=$(lock_owner $BL); alive $o || { mv $BL $BL.stale-auto-$(date +%H%M%S); log "죽은 잠금 정리 pid=$o"; }; fi
  if pgrep -f "train-batch-live.py --live .*--host $HOST " >/dev/null || [ -d $BL ]; then sleep 30; continue; fi
  release_claim batch-complete
  # 이미 병합·닫힌 PR 줄(착지 직후 상태 조회 시간초과로 남은 것)은 앞에서 걷어낸다 — land-single 과 같은 $Q.lock 안에서
  for pr in ${(f)"$(cut -f1 $Q 2>/dev/null | grep -E '^[0-9]+$' | head -6)"}; do
    st=$(cd $SEAT && timeout 60 eln gh pr view $pr --json state -q .state 2>/dev/null)
    if [ "$st" = MERGED ] || [ "$st" = CLOSED ]; then
      n=0; until mkdir $Q.lock 2>/dev/null; do sleep 1; (( ++n > 60 )) && break; done
      if (( n <= 60 )); then
        cp $Q $Q.bak-auto-$(date +%H%M%S); python3 -c "import sys;p=sys.argv[1];L=open(p).read().splitlines();open(p,'w').write(''.join(l+'\n' for l in L if l.split('\t')[0]!=sys.argv[2]))" $Q $pr
        rmdir $Q.lock; log "줄 정리 #$pr ($st)"
      fi
    fi
  done
  if [ $(cut -f1 $Q 2>/dev/null | grep -cE '^[0-9]+$') -lt $MIN_PRS ]; then sleep 60; continue; fi
  (cd $SEAT && eln git fetch origin main >/dev/null 2>&1)
  B=$(git -C $SEAT rev-parse origin/main 2>/dev/null)
  [[ "$B" =~ ^[0-9a-f]{40}$ ]] || { log "base 해석 실패"; sleep 60; continue; }
  # 선택은 공용 선택 잠금 안에서: 다른 열차 claim 을 빼고 고른 뒤 바로 내 claim 을 적는다
  sel_lock || { log "선택 잠금 대기 초과"; sleep 60; continue; }
  EX=$(other_claims)
  PX=$(precheck_ex "$B" 2>>$LOG); [[ -n $PX ]] && { log "사전 거름 제외=$PX"; EX=${EX:+$EX,}$PX; }
  sel=$(cd $SEAT && timeout 600 python3 $TB --dry-run --queue $Q --repo $REPO --base $B --limit ${MAX_PRS:-4} --exclude "$EX" 2>/dev/null | jq -r '[.selected[]?.pr]|join(",")' 2>/dev/null)
  if [ -z "$sel" ] || [ "$sel" = null ]; then sel_unlock; log "dry-run 선택 실패 (exclude=$EX)"; try_amg; sleep 60; continue; fi
  prs=(${(s:,:)sel})
  if [ ${#prs} -lt $MIN_PRS ]; then sel_unlock; log "충돌 없는 PR ${MIN_PRS}개 미만 · 선택=$sel · exclude=$EX"; try_amg; sleep 120; continue; fi
  XP=(); (( ${#prs} == 1 )) && XP=(--express)  # OP 10-29 18:0x 대표 «1개짜리는 그냥 열차 태워라 · 3번째 유휴(node-c)에» — MIN_PRS=1 열차만 단독 급행
  printf '%s\t%s\t%s\t%s\n' $$ $HOST $BL $sel > $MYCLAIM.new && mv $MYCLAIM.new $MYCLAIM || { rm -f $MYCLAIM.new; sel_unlock; log "claim write failed prs=$sel"; sleep 10; continue; }
  log "claim acquired owner=$$ prs=$sel lock=$BL"
  sel_unlock
  id=$(date +%H%M%S); A=$AR/batch-$HOST-$id; RID=$RP${id[1,4]}
  auth=${(j:,:)prs}
  log "launch $id prs=$auth base=${B[1,12]} exclude=$EX run=$RID"
  # GCP mirrors can lag main by several minutes. Sync immediately before batch dispatch;
  # fail closed on busy/error or if main moved since this batch was selected.
  if [[ $HOST == gcp1 || $HOST == gcp2 || $HOST == aws1 || $HOST == aws2 ]]; then  # OP 11-01 22:30 aws1 추가(미러 지연으로 «Not a valid object name» 거부 2회)
    sync_script=$(print -r -- "$row" | cut -f4)
    case "$sync_script" in
      '$HOME/'*) sync_script="$HOME/${sync_script#'$HOME/'}" ;;
      '~/'*) sync_script="$HOME/${sync_script#'~/'}" ;;
    esac
    sync_out=$(bash "$sync_script" 2>&1); sync_rc=$?
    sync_sha=${sync_out##*sha=}
    if [[ $sync_rc -ne 0 || $sync_out != "$HOST-main-sync ok sha="* || $sync_sha != $B ]]; then
      log "pre-dispatch bundle sync not ready rc=$sync_rc output=${sync_out[1,100]} selectedBase=${B[1,12]} synced=${sync_sha[1,12]} · batch not launched"
      release_claim pre-dispatch-sync-failed; sleep 5; continue
    fi
    log "pre-dispatch bundle sync ok sha=${sync_sha[1,12]}"
  fi
  python3 $TB --live --op-watching --authorize $auth --queue $Q --repo $REPO --base $B --limit ${#prs} --host $HOST \
    --artifacts $A --land-single $LS --side-main $B --run-id $RID --shards $SHARDS --gate-timeout 3600 \
    --exclude "$EX" --lock $BL --retry-host $RETRY_HOST $XP > $A.log 2>&1
  rc=$?; res=$(tail -1 $A.log | cut -c1-200)
  log "done $id rc=$rc · $res"
  # 게이트 통과 뒤 GitHub 시간초과로 끊긴 착지 보충(claim 은 보충이 끝날 때까지 쥔다)
  S=$(ls $A/summary-*-handoff.json(N) $A/summary-*-retry.json(N) $A/summary.json(N) 2>/dev/null | head -1)
  if [ -n "$S" ] && jq -e ' .verdict == "passed" and .exitCode == 0 and .typecheck.status == "passed" ' "$S" >/dev/null 2>&1; then
    gh_=$(jq -r '.gateRetry.to // empty' $A/manifest.json 2>/dev/null); gh_=${gh_:-$HOST}
    if [[ ${TRAIN_SUPPLEMENT_DISABLED:-0} == 1 ]]; then
      log "supplement disabled by TRAIN_SUPPLEMENT_DISABLED=1 batch=$id"
    elif [[ ! -f $A/manifest.json ]]; then
      log "supplement fail-closed: batch manifest missing batch=$id"
    else
    for pr in $prs; do
      if ! jq -e --arg pr "$pr" '
        (if (.gateRetry.members | type) == "array" then .gateRetry.members else (.members // []) end)
        | any(.[]; (.pr | tostring) == $pr)
      ' "$A/manifest.json" >/dev/null 2>&1; then
        log "보충 제외 #$pr · 최종 gate manifest 통과 멤버 아님(batch=$id)"
        continue
      fi
      st=$(cd $SEAT && timeout 60 eln gh pr view $pr --json state -q .state 2>/dev/null)
      [ "$st" = OPEN ] || continue
      h=$(awk -F'\t' -v p=$pr '$1==p{print $2}' $Q); [ -n "$h" ] || continue
      out=$(cd $SEAT && zsh $LS $RID $pr $h ${B[1,12]} $gh_ $S 2>&1 | grep -E 'MERGED|REFUS|FAIL|OVERLAP|INVALID|MUTEX' | head -1)
      log "보충 #$pr · $out"
    done
    fi
  elif [ $rc -ne 0 ]; then
    gate_tail=$(sed -n '/^REMOTE_GATE_LOG_TAIL_BEGIN$/,/^REMOTE_GATE_LOG_TAIL_END$/p' "$A/remote-gate.stdout.log" 2>/dev/null | sed '1d;$d')
    if [[ -n $gate_tail ]]; then
      MAIL_NL=$'\n'
      post "[train-auto $HOST] 열차 $id 거부 rc=$rc · $res · 원격 gate.log 마지막 20줄:${MAIL_NL}$gate_tail${MAIL_NL}로그 $A.log"
    else
      post "[train-auto $HOST] 열차 $id 거부 rc=$rc · $res · 로그 $A.log"
    fi
  fi
  # OP 10-28 21:3x 대표 승인: 같은 PR 이 연속 2회 귀속 실패(introduced)면 줄에서 빼고 parked.tsv + 주인 우편. unmeasured·인프라는 strike 없음.
  python3 $PARK --artifacts $A --batch $HOST-$id --queue $Q --repo $REPO --base $B --members $auth --host $RETRY_HOST >> $LOG 2>&1
  # OP 11-01 16:5x: unmeasured retry is host-local; let another host pick the same PR immediately.
  S=$(ls $A/summary-*-handoff.json(N) $A/summary-*-retry.json(N) $A/summary.json(N) 2>/dev/null | head -1)
  if [[ -n $S && "$(jq -r .verdict $S 2>/dev/null)" == unmeasured ]]; then
    python3 - "$Q" "$HOST" "$A" "$id" "$auth" <<'PY' >> $LOG 2>&1
import datetime, json, os, pathlib, sys, time
q, host, artifacts, batch, prs = sys.argv[1:]
queue = {f[0]: f[1] for line in open(q) if (f := line.rstrip('\n').split('\t')) and f[0].isdigit() and len(f) > 1}
path = pathlib.Path.home() / f'elanous-hq/seat-state/OP/train-unmeasured-cooldowns-{host}.tsv'
until = int(time.time()) + 3600
at = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')
rows = []
for pr in prs.split(','):
    head = queue.get(pr)
    if head and len(head) == 40:
        rows.append(f'{pr}\t{head}\t{until}\t{batch}\t{at}\t{artifacts}\n')
if rows:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, 'a') as out: out.writelines(rows)
    print(f'[cooldown] host={host} minutes=60 prs={prs} until={until} file={path}')
PY
  fi
  # OP 10-28 21:4x: HOLD_ON_UNMEASURED=1 이면 최종 요약이 unmeasured 인 배치 뒤 루프를 멈춘다(호스트 불안정 · 같은 PR 을 또 60분 묶지 않게).
  if [[ ${HOLD_ON_UNMEASURED:-0} == 1 ]]; then
    fs=$(ls $A/summary-*-handoff.json(N) $A/summary-*-retry.json(N) $A/summary.json(N) 2>/dev/null | head -1)
    if [[ -n $fs && "$(jq -r .verdict $fs 2>/dev/null)" == unmeasured ]]; then
      log "unmeasured($(jq -r .unmeasuredReason $fs)) → 보류(HOLD_ON_UNMEASURED) · 재기동은 OP"; post "[train-auto $HOST] 배치 $id unmeasured → 열차 보류 · $fs"; release_claim hold-unmeasured; exit 0
    fi
  fi
  release_claim batch-complete
  sleep 10
done
