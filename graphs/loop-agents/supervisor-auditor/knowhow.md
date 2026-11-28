# 감독 감사관 — 노하우 팩 (씨앗 · seat KNOWHOW 항목 형식)

> 씨앗 출처: seat-state/OP/tools/loop-agent-live-check.sh · seat-state/OP/evidence/20261128/SUPERVISOR-AUDIT-15.md · SUPERVISOR-AUDIT-16.md · loop-agent-live.log (Claude 세션 크론 11-28).

## K-SUPERVISOR-AUDITOR-001 행동 0 의 이유부터 본다 (2026-11-28)
- 상황: «보기만 함» 으로 주인 카드를 쓸 때.
- 처방(힐링): 지난 60분 교정 일지의 거절·실패 줄 중 가장 많은 것을 카드에 붙인다 — 권한 밖(rights.actions) · 쿨다운 · 멈춤(연속 실패)이 대부분이다. 거절이 0 이면 몸이 아무것도 계획하지 않은 것(plan 이 빈 것)이다.
- 재는 명령: eln loop agent <id> journal --since 1h
- 종류: playbook
- 검증: 2026-11-28 참 (16시 감사 — silence-watch 27h 위반은 행동 6 이라 보기만 함 아님)
- 출처: SUPERVISOR-AUDITOR-LOOP · 상태: active

## K-SUPERVISOR-AUDITOR-002 KPI 없음은 아직 KPI 를 안 단 에이전트다 (2026-11-28)
- 상황: judge-butler · land-steward 처럼 자기 몸(bespoke)으로 도는 에이전트가 «KPI 없음» 으로 나올 때.
- 처방(힐링): 정상화 대상이 아니라 그 에이전트 칸(KPI 연결 PR)의 일이다 — 사다리를 타지 않고 원장 표에만 남긴다.
- 재는 명령: eln loop agent list
- 종류: fact
- 검증: 2026-11-28 참 (P2 #40679)
- 출처: SUPERVISOR-AUDITOR-LOOP · 상태: active
