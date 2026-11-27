# 부검반 — 노하우 팩 (씨앗 · seat KNOWHOW 항목 형식)

> 씨앗 출처: 내부 문서 `RFC-run-doctor-and-postmortem-as-early-force-2026-10-14` §1·§4 · seat-state/OP/LANDING-KNOWHOW.md 승화 사다리·L13 · OPS-RULES 11-27 처리량 정책 ③. 배운 것은 knowhow/learned.md 에 쌓인다.

## K-AUTOPSY-001 같은 원인 3회 = 구조 칸 (2026-10-14)
- 상황: 부검 원장에 같은 원인 꼴이 쌓일 때.
- 처방(힐링): 7일에 3회면 그 꼴의 칸을 하나 연다(꼴당 평생 1칸). 사망 진단서로만 쌓이면 같은 결손이 비용만 태운다 — 분류는 칸·재발사 입력으로 되먹여야 한다.
- 재는 명령: eln loop agent autopsy status
- 종류: playbook
- 검증: 2026-10-14 참 (RFC-run-doctor-and-postmortem §4 E3)
- 출처: 내부 문서 `RFC-run-doctor-and-postmortem-as-early-force-2026-10-14` · 상태: active

## K-AUTOPSY-002 원인은 구조 근거로 먼저 — 착지 거부 꼴·stop 꼴 (2026-11-25)
- 상황: 사망 원인을 정할 때.
- 처방(힐링): land-graph 거부 꼴(RefusalClass) · 런 stop class · 마지막 노드 결과를 먼저 쓴다. 닫힌 PR 은 그 PR 의 마지막 착지 거부 꼴. 글(닫는 말)은 마지막 수단이고, 근거가 없으면 unclassified 로 남겨 사람에게 올린다 — 지어내지 않는다.
- 재는 명령: eln land-graph status
- 종류: heuristic
- 검증: 2026-11-27 참 (src/land-graph/land-graph.ts RefusalClass · classifyLandExit)
- 출처: src/land-graph/land-graph.ts · MEMORY no-regex-grounding-root-fix · 상태: active

## K-AUTOPSY-003 닫힌 PR 은 대개 대체·24h 정리다 (2026-11-27)
- 상황: 병합 없이 닫힌 PR 을 분류할 때.
- 처방(힐링): 24시간 넘게 착지 안 된 PR 은 마무리 차선이 사유를 남기고 닫는다(되돌릴 수 있음). 닫는 말에 대체 PR 번호(→ #N)·쪼갬이 있으면 superseded·split. 착지 줄의 stale 행(이미 머지·닫힘)은 사망이 아니라 L13 꼴이다.
- 재는 명령: gh pr list --state closed --json number,closedAt,mergedAt
- 종류: fact
- 검증: 2026-11-27 참 (OPS-RULES 처리량 정책 ③ · LANDING-KNOWHOW L13)
- 출처: OPS-RULES 11-27 · LANDING-KNOWHOW L13 · 상태: active

## K-AUTOPSY-004 칸은 꼴당 하나 · 하루 둘 — 승화 사다리를 따른다 (2026-11-18)
- 상황: 반복 꼴이 여럿 한꺼번에 3회를 넘을 때.
- 처방(힐링): 하루 2칸까지만 열고 나머지는 다음 날. 승화 사다리 = 노하우 → 규칙 → 로직 → 시뮬 장면 → 손 조정 은퇴. 칸 본문에 사례(PR·런 id)를 붙인다.
- 재는 명령: (없음)
- 종류: heuristic
- 검증: 2026-11-18 참 (LANDING-KNOWHOW 승화 사다리 «같은 꼴 3회 이상 → 다음 날 칸»)
- 출처: seat-state/OP/LANDING-KNOWHOW.md · 상태: active
