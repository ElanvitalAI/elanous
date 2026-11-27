# 감시자의 감시 — 노하우 팩 (씨앗 · seat KNOWHOW 항목 형식)

> 씨앗 출처: src/kit/heartbeat/index.ts 머리말(대표 11-25 «watchers fail silently») · seat-state/OP/design-archive-1126/SUPERVISORS-AND-MESSAGING-1127.md §2a·§3a · SUPERVISOR-REVIVE-1127 «감시 밖».

## K-WATCHERS-CHECK-001 판정 셋: DEAD · BROKEN · BLIND (2026-11-25)
- 상황: 감시자가 살아 있는지 판단할 때.
- 처방(힐링): beat 가 주기의 2배 넘게 없으면 DEAD · 마지막 3번이 전부 오류면 BROKEN · 원천이 움직였는데 3창 연속 saw 0 이거나 커서가 원천보다 앞서면 BLIND. DEAD 만 깨우기로 고친다 — BROKEN·BLIND 는 돌고 있으나 틀렸다.
- 재는 명령: eln watch status
- 종류: fact
- 검증: 2026-11-25 참 (src/kit/heartbeat/index.ts judgeWatchers)
- 출처: src/kit/heartbeat/index.ts · 상태: active

## K-WATCHERS-CHECK-002 beat 가 한 번도 없는 감독자는 «안 보임» 이 아니라 결손이다 (2026-11-27)
- 상황: 옛 watchers-check 가 beat 를 남긴 4개(release-graph-tick · res-patrol · trigger-tick · 자기)만 보던 때.
- 처방(힐링): 기대 목록 = 모든 v2 카드의 loop:<id> ⊕ 핵심 그래프 감시자. 기대했는데 beat 가 없으면 MISSING 으로 세고 트리거를 한 번 쏜다.
- 재는 명령: eln loop agent list
- 종류: warning
- 검증: 2026-11-27 참 (SUPERVISORS-AND-MESSAGING-1127 §2a watchers-check «감시 대상 4개뿐»)
- 출처: SUPERVISORS-AND-MESSAGING-1127 §2a · SUPERVISOR-REVIVE-1127 «감시 밖» · 상태: active

## K-WATCHERS-CHECK-003 카드만 보내면 아무도 안 고친다 — 깨우고, 안 되면 L0 한 장 (2026-11-27)
- 상황: 결손을 CLAUDE-OP 카드로만 알리던 옛 꼴(미확인 ≥100).
- 처방(힐링): 내 권한(트리거 한 번 발사)으로 먼저 닫는다. 30분 안 닫히면 OP 에 카드 한 장 · 같은 위반 중에는 다시 보내지 않는다.
- 재는 명령: eln loop agent watchers-check status
- 종류: playbook
- 검증: 2026-11-27 참 (SUPERVISORS-AND-MESSAGING-1127 §3a «watchers→CLAUDE-OP ≥100»)
- 출처: SUPERVISORS-AND-MESSAGING-1127 §3a «받는 이가 아무것도 안 함» · 상태: active

## K-WATCHERS-CHECK-004 같은 감독자가 반복해서 죽으면 깨우기를 멈추고 원인을 넘긴다 (2026-11-27)
- 상황: 깨운 감독자가 다시 DEAD 가 될 때(일주일 3번).
- 처방(힐링): 트리거 조건·cron·몸의 예외가 원인이다. 교훈 후보로 올리고, 주인 자리(카드의 supervisor)에 원인 확인을 넘긴다. 무한 깨우기는 소음이다.
- 재는 명령: eln loop trigger fires <id>
- 종류: heuristic
- 검증: 2026-11-27 참 (SUPERVISOR-REVIVE-1127 «환자를 잃은 의사»)
- 출처: SUPERVISOR-REVIVE-1127 · 상태: active
