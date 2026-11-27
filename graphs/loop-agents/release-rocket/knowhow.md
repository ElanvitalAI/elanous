# 발행 매니저 — 노하우 팩 (씨앗 · seat KNOWHOW 항목 형식)

> 씨앗 출처: seat-state/OPS/OPS-RULES.md 발행 케이던스 · OP 기억(컷은 늦게·예행은 먼저 11-25 · 하드 예행 T−4h 11-18 · 크리티컬 아닌 🟡 면제 후 정시 발행 11-22 · 컷 +5분 실재 확인 11-15).

## K-RELEASE-ROCKET-001 컷은 늦게, 예행은 먼저 (2026-11-25)
- 상황: 다음 판의 시각을 정하거나 예행을 언제 열지 판단할 때.
- 처방(힐링): 예행 22:00(전날) · 컷 04:00(발행 2시간 전) · 발행 06:00. 예행이 22:15 까지 안 열렸으면 바로 연다(dry-run 부분 · push·publish 없음).
- 재는 명령: eln release graph status
- 종류: playbook
- 검증: 2026-11-25 참 (대표 11-25 «컷은 늦게 · 예행은 먼저»)
- 출처: OPS-RULES 발행 케이던스 · 상태: active

## K-RELEASE-ROCKET-002 크리티컬 아닌 노랑은 면제 후 정시 발행 (2026-11-22)
- 상황: 발행 2시간 안인데 노랑 칸이 남아 있을 때.
- 처방(힐링): P0·MUST·block 이 아닌 노랑은 면제(known-issue) 후보로 묶어 OP 에 한 통 제안한다. 크리티컬은 따로. 발행 시각을 넘기면 서저리 퀵패스.
- 재는 명령: eln release checklist summary
- 종류: heuristic
- 검증: 2026-11-22 참 (대표 11-22 «크리티컬 아닌 🟡 면제 후 정시 발행»)
- 출처: OPS-RULES §발행 면제 · 상태: active

## K-RELEASE-ROCKET-003 하드 예행은 T−4h 안에 실경로로 (2026-11-18)
- 상황: 예행이 dry-run 만 돌고 실경로(prebuild·push·게이트 Pod)를 안 밟았을 때.
- 처방(힐링): 발행 T−4h 안에 실경로 하드 예행을 한 번 돈다. 예행 영수(rehearsal-receipt.json)가 실발행의 권고 입력이다.
- 재는 명령: eln release graph status
- 종류: warning
- 검증: 2026-11-18 참 (대표 11-18 하드 예행 필수)
- 출처: OP 기억 hard-rehearsal-t-minus-4h · 상태: active

## K-RELEASE-ROCKET-004 컷 +5분에 발행 가지·런이 실재하는지 본다 (2026-11-15)
- 상황: 컷 시각이 지났는데 «컷 됐다» 는 말만 있을 때.
- 처방(힐링): 컷 +5분에 발행 런의 cut 단계 상태와 발행 가지를 직접 본다. 런이 없으면 컷은 안 된 것 — 늦은 이정표로 세고 OP 에 올린다.
- 재는 명령: eln release graph status
- 종류: fact
- 검증: 2026-11-15 참 (11-26 발행 런 미생성 사례)
- 출처: OP 기억 op-check-cut-actually-started · 상태: active
