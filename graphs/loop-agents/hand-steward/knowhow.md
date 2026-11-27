# 행정관 — 노하우 팩 (씨앗 · seat KNOWHOW 항목 형식)

> 씨앗 출처: src/loops/op-next-action.ts (b)(c) · src/steward/space/work-next-cli.ts OP-PULL-HINT · src/seat/model-by-difficulty.ts · src/seat/seat-assign.ts SEAT-ASSIGN-GUARD · OP 기억(pull 기본 11-25 · 소총 일에 탱크 금지 11-17).

## K-HAND-STEWARD-001 배정은 push 가 아니라 pull 힌트로 (2026-11-27)
- 상황: 놀고 있는 손에 칸을 주고 싶을 때.
- 처방(힐링): [SEAT-ASSIGN] 우편 폭주(11-27 15:24Z 27통) 뒤로 기본은 priorityOrder 앞에 올리고 손에게 힌트를 건다. 손은 eln work next 로 잡는다. 힌트는 한 임대(45분) 뒤 만료.
- 재는 명령: eln work next
- 종류: playbook
- 검증: 2026-11-27 참 (src/steward/space/work-next-cli.ts addPullHints)
- 출처: OP-PUSH-BUDGET · OP-PULL-HINT · 상태: active

## K-HAND-STEWARD-002 모델은 칸 난이도대로 (2026-11-27)
- 상황: 칸을 손에게 걸 때 어떤 모델로 돌릴지.
- 처방(힐링): 핫파일·보안4·RED/tsc·재배정 횟수로 점수 → hard=terra · medium=luna · easy=glm. 계정이 95% 넘으면 한 단계 아래. seat-model/<SEAT>.json 에 쓰면 손 탭이 다음 턴에 바꾼다.
- 재는 명령: (없음)
- 종류: fact
- 검증: 2026-11-27 참 (src/seat/model-by-difficulty.ts)
- 출처: MODEL-BY-DIFFICULTY (대표 11-27 07:3x) · 상태: active

## K-HAND-STEWARD-003 준비 칸 = 노랑 · 주인 없음 · 선행 닫힘 · umbrella/decision 아님 (2026-11-26)
- 상황: 어떤 칸을 손에게 줄 수 있는지 판단할 때.
- 처방(힐링): 선행 칸이 초록/완료가 아니면 주지 않는다. umbrella·decision 칸은 절대 배정하지 않는다. 준비 칸이 없으면 쪼개기는 OP 몫(45분 이하 칸).
- 재는 명령: eln release checklist list
- 종류: heuristic
- 검증: 2026-11-26 참 (src/loops/op-next-action.ts (b)(c))
- 출처: OP-NEXT-BEST-ACTION · 상태: active

## K-HAND-STEWARD-004 판정 손과 지금 판 밖 칸은 건드리지 않는다 (2026-11-27)
- 상황: 놀고 있는 JUD 손이 보이거나 옛 판 칸이 남아 있을 때.
- 처방(힐링): 판정 손(JUD*)에는 구현 칸을 주지 않는다. 지금 판(release.graph.version) 칸만 — 옛 판 칸 배정이 손을 다음 판에서 빼낸 사고(11-27 0.3.37 칸 35통)가 있었다.
- 재는 명령: (없음)
- 종류: warning
- 검증: 2026-11-27 참 (src/seat/seat-assign.ts SEAT-ASSIGN-GUARD)
- 출처: SEAT-ASSIGN-GUARD · 상태: active
