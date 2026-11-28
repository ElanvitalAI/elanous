# 수호자 — 노하우 팩 (씨앗 · seat KNOWHOW 항목 형식)

> 씨앗 출처: 내부 문서 `GUARDIAN` §2~§8 · 내부 문서 `FEDERATION-ORG` §2·§5 · 11-27 아침 전수조사(node-b load 135/32 · 고아 300+). 배운 것은 knowhow/learned.md 에 쌓인다(같은 실패 3회 → 원인 있는 한 줄 · 다음 맥박의 plan 이 읽는다).

## K-GUARDIAN-001 과부하 호스트는 경로부터 돌린다 — 정리는 그다음 (2026-11-27)
- 상황: 한 호스트 load/ncpu 가 1.0 을 넘고 다른 로컬 호스트는 한가할 때.
- 처방(힐링): 임대관이 다음 pregate·TA·게이트를 가장 한가한 로컬로 보낸다(route.json). 대식세포가 그 호스트의 고아를 정확 PID 로 걷는다. 유료 VM 은 켜지 않고 OP 에 묻는다.
- 재는 명령: eln loop guardian world
- 종류: playbook
- 검증: 2026-11-27 참 (node-b 135/32 · minim5 1.9/18)
- 출처: GUARDIAN §7 · FEDERATION-ORG §5 · 상태: active

## K-GUARDIAN-002 재기동이 세 번 안 먹히면 감독자가 아니라 대상이 죽었다 (2026-11-27)
- 상황: 트리거 레지스트리가 창마다 다시 쏘고 재시도해도 같은 감독자가 계속 dead·결과 나쁨으로 보일 때.
- 처방(힐링): 수호자는 재기동하지 않는다(11-28 P1 — 깨움·예외 카드는 레지스트리 하나). 결과가 오래 나쁘면 주인(L0)에게 «재부착» 제안 한 장 — 새 대상·목표로 다시 붙인다. 은퇴는 없다.
- 재는 명령: eln loop trigger list · eln loop guardian status
- 종류: heuristic
- 검증: 2026-11-27 참 (FEDERATION-ORG §4 «환자를 잃은 의사»)
- 출처: FEDERATION-ORG §4 · 상태: active

## K-GUARDIAN-003 본 것은 사건이다 — 정상으로 돌아올 때까지 닫지 않는다 (2026-11-27)
- 상황: 탐지기가 정상 아닌 것을 봤을 때.
- 처방(힐링): kit/case-ledger 사건을 연다 → 정책 안 사다리(normalize)를 돈다 → 다시 봐서 정상이면 resolved. 정책 밖이거나 SLA 가 지나면 주인에게 한 장(escalated). «본 채로» 남기지 않는다.
- 재는 명령: eln loop guardian status · <state>/cases/guardian-*.jsonl
- 종류: playbook
- 검증: 2026-11-27 참 (대표 «1. 본다 2. 정상화»)
- 출처: DETECT-TO-ACTION · 상태: active
