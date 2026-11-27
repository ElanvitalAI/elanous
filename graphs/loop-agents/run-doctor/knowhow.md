# 런 닥터 — 노하우 팩 (씨앗 · seat KNOWHOW 항목 형식)

> 씨앗 출처: seat-state/OP/LANDING-KNOWHOW.md L5·L7·L9·L27 · seat-state/OPS/OPS-RULES.md §착지 가속 · 11-27 처리량 정책 ④ · 내부 문서 `RFC-run-doctor-and-postmortem-as-early-force-2026-10-14`. 배운 것은 knowhow/learned.md 에 쌓인다.

## K-RUN-DOCTOR-001 시험 전 단계 RED 는 기반 RED — 다른 호스트로 즉시 (2026-11-18)
- 상황: fetch-head bad object · checkout · frozen-install 처럼 시험 전에 RED 가 났을 때.
- 처방(힐링): 작성자에게 넘기지 않는다. 다른 허용 호스트로 같은 PR 을 한 번 재실행하고, 같은 호스트가 반복되면 RES 에 저장소 수리를 올린다.
- 재는 명령: ~/elanous-hq/seat-state/RES/tools/pregate <PR> --host <다른 호스트> --plan
- 종류: playbook
- 검증: 2026-11-18 참 (#38520 node-b fetch-head → minim5 · #38561 → aws1 PASS)
- 출처: LANDING-KNOWHOW L5 · 상태: active

## K-RUN-DOCTOR-002 changed-tsc exit 124 = 시간 초과 — 호스트 문제다 (2026-11-27)
- 상황: RED 마지막 단계가 changed-tsc 이고 receipt 의 마지막 step exit 가 124 일 때(전체 승격·기준선 캐시 미스로 20~28분).
- 처방(힐링): 내용 오류가 아니다. 부하 낮은 다른 호스트로 한 번 재실행. 같은 호스트에서 반복되면 tsc-timeout@<host> 교훈으로 올려 배정을 줄인다.
- 재는 명령: tar xOf <PREGATE-RED 폴더>/red.tar receipt.json
- 종류: heuristic
- 검증: 2026-11-27 참 (#40355 minim5 22.6분 changed-tsc exit 124)
- 출처: seat-state/RES/evidence/PREGATE-RED · 상태: active

## K-RUN-DOCTOR-003 main 도 같은 이름으로 실패하면 착지 차단이 아니다 (2026-11-27)
- 상황: baseline-focused 단계에서 RED 이고 실패 이름이 main 과 같을 때.
- 처방(힐링): 기존 간섭으로 진단하고 재실행하지 않는다. 이름 대조만으로 새 실패가 0 이면 착지 줄이 막지 않는다. FOCUSED_NEW_FAILURE 만 작성자 수리.
- 재는 명령: (없음)
- 종류: fact
- 검증: 2026-11-27 참 (OPS-RULES 처리량 정책 ④)
- 출처: OPS-RULES 11-27 «기준선 실패 = 착지 차단 아님» · LANDING-KNOWHOW L7 · 상태: active

## K-RUN-DOCTOR-004 래칫·규칙 RED 는 작성자 몫 — 원문 줄로 넘긴다 (2026-11-18)
- 상황: rules-and-ratchets · interference-ratchet · diff-check 에서 RED 일 때.
- 처방(힐링): 재실행해도 같다. 진단 카드에 원문 단계와 처방(시험 본문 동적 import → 정적 import · 끝 공백 등)을 적어 작성자에 넘긴다.
- 재는 명령: (없음)
- 종류: heuristic
- 검증: 2026-11-18 참 (#38642 interference-ratchet capsule-frame.test.ts body-dynamic-import)
- 출처: LANDING-KNOWHOW L9 · 상태: active

## K-RUN-DOCTOR-005 수리는 head 당 한 번 — 처방이 반복되면 구조로 (2026-10-14)
- 상황: 같은 head 를 또 재실행하고 싶을 때.
- 처방(힐링): 두 번째 재실행은 하지 않는다. 같은 꼴이 3회 반복되면 교훈 후보 → 부검반이 칸으로 옮긴다. 처방 효능은 재성공 비율로 잰다.
- 재는 명령: eln loop agent run-doctor status
- 종류: heuristic
- 검증: 2026-10-14 참 (RFC-run-doctor-and-postmortem §3·§6)
- 출처: 내부 문서 `RFC-run-doctor-and-postmortem-as-early-force-2026-10-14` · 상태: active
