# 기차 매니저 — 노하우 팩 (씨앗 · seat KNOWHOW 항목 형식)

> 씨앗 출처: seat-state/OP/LANDING-KNOWHOW.md (L1 · L14 · L22) · src/land-graph/land-graph.ts landOrder (#40285) · 같은 핫파일 PR 직렬 착지 노하우(11-26).

## K-TRAIN-MANAGER-001 main 진전 뒤 충돌 — 같은 파일 대기 PR 은 순서표로 (2026-11-18)
- 상황: 한 PR 이 착지한 직후 같은 파일을 건드린 대기 PR 이 merge-tree 충돌로 거부된다.
- 처방(힐링): 착지 전에 같은 파일 줄의 순서를 정한다(순서표). 거부된 PR 은 주인이 main 위 새 가지에 cherry-pick(merge·rebase 금지) → light pregate.
- 재는 명령: eln land graph status
- 종류: playbook
- 검증: 2026-11-18 참 (LANDING-KNOWHOW L1 · #38545 #38561 #38563)
- 출처: LANDING-KNOWHOW L1 · 상태: active

## K-TRAIN-MANAGER-002 충돌 피해 PR 은 줄에서 먼저 착지 (2026-11-26)
- 상황: 같은 줄 PR 이 충돌 거부를 여러 번 받는다(#40285 한 저녁 5회).
- 처방(힐링): 최근 2시간 안에 옛 head 에서 충돌 거부를 받고 main 을 병합한 PR 이 줄에서 가장 신선하다 — 먼저 착지시키고 나머지는 번호순. land-graph landOrder 가 이 판정이다.
- 재는 명령: eln land graph plan
- 종류: heuristic
- 검증: 2026-11-26 참 (src/land-graph/land-graph.ts landOrder)
- 출처: THROUGHPUT-CONTROLLER · land-graph landOrder · 상태: active

## K-TRAIN-MANAGER-003 각자 초록이어도 합친 main 이 타입 빨강일 수 있다 (2026-11-18)
- 상황: 같은 타입 표면을 건드린 두 PR 이 각자 light·isolation PASS 인데 합친 main 에서 tsc 빨강(TS2741).
- 처방(힐링): 같은 파일/타입 표면 PR 쌍은 직렬로 — 앞 PR 착지 뒤 뒤 PR 은 main 병합 후 changed-tsc 를 보고 착지. 빨강이면 1줄 수리 PR 선착지.
- 재는 명령: (없음)
- 종류: warning
- 검증: 2026-11-18 참 (LANDING-KNOWHOW L22 · #38537×#38605)
- 출처: LANDING-KNOWHOW L22 · 상태: active

## K-TRAIN-MANAGER-004 hold 는 JUD 거부권만 막는다 — 순서는 hold 로 걸지 않는다 (2026-11-27)
- 상황: 줄의 뒤 PR 을 잠깐 멈추고 싶을 때.
- 처방(힐링): land-graph 는 거부권 주인(JUD)의 hold 만 막고 다른 자리의 hold 는 기록만 하고 무시한다. 순서는 착지 집사 정책 팩(graphs/loop-agents/land-steward/policies.yaml lane_order.pins)에 PR 로 넣는다 — 기차 매니저는 핀을 TC 에 제안만 한다.
- 재는 명령: eln land graph status
- 종류: fact
- 검증: 2026-11-27 참 (src/land-graph/land-graph.ts holdVerdict)
- 출처: land-graph holdVerdict · org land-authority · 상태: active

## K-TRAIN-MANAGER-005 직렬 상한 — 시간당 착지 10 을 넘기려면 병렬 pregate (2026-11-18)
- 상황: 착지가 시간당 10 근처에서 멈춘다.
- 처방(힐링): pregate 는 병렬로 먼저 돌리고 잠금 안에서는 merge 만 한다. 영수증 재사용(≤10 커밋). 같은 파일만 직렬.
- 재는 명령: eln land graph status
- 종류: heuristic
- 검증: 2026-11-18 참 (LANDING-KNOWHOW L14)
- 출처: LANDING-KNOWHOW L14 · 상태: active
