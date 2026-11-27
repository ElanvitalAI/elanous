# 런 슈퍼바이저 — 노하우 팩 (씨앗 · seat KNOWHOW 항목 형식)

> 씨앗 출처: seat-state/RES/tools/PREGATE.md · pregate.py inflight 잠금 · PREGATE-GREEN 소요 분포(11-27 실측) · src/harness/harness-incidents.ts T-cell 분류 · MEMORY «pkill 금지». 배운 것은 knowhow/learned.md 에 쌓인다.

## K-RUN-SUPERVISOR-001 pregate 는 90분이면 좀비다 (2026-11-27)
- 상황: inflight 잠금의 pid 가 살아 있고 pregate 가 오래 끝나지 않을 때.
- 처방(힐링): PREGATE-GREEN 소요는 중앙 3분·p99 18분·최대 47분, changed-tsc 는 스스로 약 28분에 exit 124 로 끝난다. 90분을 넘긴 런처만 좀비로 본다 — 그 전에는 기다린다.
- 재는 명령: eln loop agent run-supervisor status
- 종류: fact
- 검증: 2026-11-27 참 (PREGATE-GREEN SUMMARY.json minutes 2324건 · PREGATE-RED changed-tsc exit 124)
- 출처: seat-state/RES/evidence/PREGATE-GREEN · PREGATE-RED · 상태: active

## K-RUN-SUPERVISOR-002 종료는 정확 PID 만 — 명령줄과 나이를 다시 읽은 뒤 (2026-11-20)
- 상황: 좀비 런처를 끝내야 할 때.
- 처방(힐링): pkill·killall·패턴 kill 금지(macOS pkill 은 패턴 뒤 -U 를 패턴으로 읽는다 · 11-20 mbp 사고). ps 로 pid 의 명령줄(pregate.py ⊕ head12)과 경과 시간을 다시 읽고, 신호 직전에 한 번 더 같은지 확인한 뒤 SIGTERM. --worker 는 원격 절반이라 건드리지 않는다.
- 재는 명령: ps -o etime=,command= -p <pid>
- 종류: warning
- 검증: 2026-11-20 참 (no-pkill-macos-pattern-trap)
- 출처: MEMORY no-pkill-macos-pattern-trap · CLAUDE.local «pkill 금지» · 상태: active

## K-RUN-SUPERVISOR-003 죽은 pid 잠금은 pregate 가 스스로 회수한다 (2026-11-18)
- 상황: inflight 잠금이 남아 있는데 그 pid 가 없을 때.
- 처방(힐링): 지우지 않는다. pregate.py acquire_inflight_lock 이 다음 획득 때 dead-pid 를 stale-events.tsv 에 적고 회수한다. 런처를 SIGTERM 하면 atexit 해제가 안 돌아도 같은 경로로 회수된다 — 그래서 재발사가 막히지 않는다.
- 재는 명령: (없음)
- 종류: fact
- 검증: 2026-11-27 참 (pregate.py acquire_inflight_lock)
- 출처: seat-state/RES/tools/pregate.py · 상태: active

## K-RUN-SUPERVISOR-004 종결 줄 없는 런은 stop 한 줄로 닫아 넘긴다 (2026-11-18)
- 상황: run-ledger 에 start 는 있는데 stop·run-status 종결이 없고 사건이 2시간 끊겼을 때.
- 처방(힐링): 원장에 stop 한 줄(class unclassified · site run-supervisor:no-progress)만 더한다(append-only · 런마다 한 줄). STOP-AUTOHEAL 과 eln tasks doctor 가 그 줄을 읽어 재발사·수확을 정한다. 30분 진전 없음은 «멈춤» 관찰만(T-cell no-progress-30m).
- 재는 명령: eln tasks doctor <card>
- 종류: playbook
- 검증: 2026-11-27 참 (src/self-implement/run-stop.ts appendRunStopEntryOnce · harness-incidents T-cell)
- 출처: TA-LAUNCH-STDIO-EVIDENCE-RETAIN · src/harness/harness-incidents.ts · 상태: active
