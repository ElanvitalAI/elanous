# 레일 캐너리 — 노하우 팩 (씨앗 · seat KNOWHOW 항목 형식)

> 씨앗 출처: 11-28 밤 사고 셋(#40735 → #40740 · GH 미러 insteadOf · GH-BUDGET-GOVERNOR 300/300) · src/land-graph/rail-watch.ts(교체 전후 스모크 비교).

## K-RAIL-CANARY-001 이전 빌드에서 깨져 있던 것은 회귀가 아니다 (2026-11-29)
- 상황: 교체 직후 탐침이 깨졌는데 이전 빌드의 마지막 읽기도 깨져 있었을 때.
- 처방(힐링): 되돌리지 않는다 — 빌드 탓이 아니다(호스트·설정·바깥). 사실 줄에만 남기고 그 탐침의 주인(착지 줄 · RES)이 본다.
- 재는 명령: eln loop agent rail-canary status
- 종류: rule
- 검증: 2026-11-29 참 (rail-watch «known break» 와 같은 판정)
- 출처: RAIL-CANARY-AUTO-ROLLBACK · 상태: active

## K-RAIL-CANARY-002 되돌린 빌드를 레일이 다시 깔면 카드만 (2026-11-29)
- 상황: 같은 sha 가 다시 설치되고 또 회귀할 때(main 이 아직 안 고쳐짐).
- 처방(힐링): 두 번째 자동 되돌림은 없다 — OP 카드(한도)로 넘긴다. main 수리(revert PR) 또는 레일 HOLD 가 답이다.
- 재는 명령: cat ~/.elanous/loop-agents/rail-canary/canary.json
- 종류: rule
- 검증: 2026-11-29 참 (sim SUP-CANARY-FLAP)
- 출처: RAIL-CANARY-AUTO-ROLLBACK · 상태: active
