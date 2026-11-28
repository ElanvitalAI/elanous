# 연방 분석관 — 노하우 팩 (씨앗 · seat KNOWHOW 항목 형식)

> 씨앗 출처: seat-state/OP/design-archive-1126/fed-ontology-bottleneck-REPORT.md(«Δ 변화» 30분 절 · 11-26 23:2x ~ 11-28 00:00) · fed-chatlog-metrics.py · fed-topology.py · fed-sim-v2-topology.py.

## K-FED-ANALYST-001 숫자 정의는 분석 스크립트와 같다 (2026-11-28)
- 상황: 기계 비율 · 고유벡터 · 답 없는 간선을 잴 때.
- 처방(힐링): 기계 = ORCHESTRATOR·LAND-GRAPH 발신 또는 템플릿 본문(창 전체 우편 기준) · 고유벡터 = 무향 가중 거듭제곱 200회 · 답 없는 간선 = 요청 3통 이상 간선 중 답 80% 미만(루프 에이전트 발신 제외) · 잠든 간선 = mail-route 잠든 표 ⊕ 창 없는 주소로 간 우편.
- 재는 명령: eln fed analyze --json
- 종류: fact
- 검증: 2026-11-28 참 (Claude 분석 2300 · 2330 · 0000 창과 대조 — PR 본문 대조표)
- 출처: FED-ANALYST-LOOP-AGENT · 상태: active

## K-FED-ANALYST-002 과거 창은 그 시각의 상태로 읽는다 (2026-11-28)
- 상황: 지난 창을 다시 재거나 대조할 때.
- 처방(힐링): `--at <창 끝>` 이면 열린 ✋ 는 그 시각까지의 닫힘만 본다(openHands asOf) · fed kpi 는 창 끝 기준 · 처리량 제어기 판정은 창 끝 뒤 5분 안 또는 앞 20분 안의 줄만. 판(P0 노랑)·트리거 예외는 지금 값뿐이다(시점 조회 없음) — 대조할 때 이 둘은 차이로 적는다.
- 재는 명령: eln fed analyze --at <ISO> --mail <창>/mail.jsonl --panes <창>/screens/panes.tsv
- 종류: playbook
- 검증: 2026-11-28 참
- 출처: FED-ANALYST-LOOP-AGENT · 상태: active
