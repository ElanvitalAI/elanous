# 09-28 대표 지시 대조 표본

## SCQA
- S — 아래 22건은 요청에 제공된 «요지» 표본이다. 원문 전사는 제공되지 않았다.
- C — 🅢 손 분배 결과 원장은 이 입력에 포함되지 않았다. 지어낼 수 없다.
- Q — (비움 — C 와 같은 말이다)
- A — 이 표의 «손 분배»는 근거가 생길 때까지 미확인으로 두고, 가짜 LLM 모의 출력만 기록한다. 이 문서를 원문 기록으로 오인하지 않는다.

| # | 제공된 요지 (원문 아님) | 🅢 손 분배 | 모의 스튜어드 rung / 의존 / disposition | 대조 |
|---:|---|---|---|---|
| 1 | PTY 인텔리전스 우선 | 미확인 | 모의 4 · 의존 없음 · now | 판정 불가 |
| 2 | 로그인 브라우저 갈래 | 미확인 | 모의 4 · 의존 없음 · now | 판정 불가 |
| 3 | Claude Code 는 PTY 경로만 | 미확인 | 모의 4 · 의존 없음 · now | 판정 불가 |
| 4 | 공개 docs PTY 정리 | 미확인 | 모의 hitl/public · 의존 없음 · hitl | 판정 불가 |
| 5 | 플러그인·마켓 RFC(codex 호환) | 미확인 | 모의 4 · 의존 없음 · now | 판정 불가 |
| 6 | 유료는 천천히 | 미확인 | 모의 hitl/money · 의존 없음 · hitl | 판정 불가 |
| 7 | 플러그인 우선 | 미확인 | 모의 4 · 의존 없음 · now | 판정 불가 |
| 8 | 워크플로 커스텀 노드 편집기 | 미확인 | 모의 4 · 의존 없음 · now | 판정 불가 |
| 9 | 편집기 한 화면 두 모드 | 미확인 | 모의 4 · 의존 없음 · now | 판정 불가 |
| 10 | 기본 스킬셋 마켓 팩 | 미확인 | 모의 4 · 의존 없음 · now | 판정 불가 |
| 11 | 티저 네 소구점 확장 | 미확인 | 모의 4 · 의존 없음 · now | 판정 불가 |
| 12 | 티저 v2 PTY 메인 오늘 | 미확인 | 모의 4 · 의존 없음 · now | 판정 불가 |
| 13 | 티저 v3 블록버스터 | 미확인 | 모의 4 · 의존 없음 · now | 판정 불가 |
| 14 | 영어 남성 VO | 미확인 | 모의 4 · 의존 없음 · now | 판정 불가 |
| 15 | Resolve·AE·Blender·Higgsfield | 미확인 | 모의 4 · 의존 없음 · now | 판정 불가 |
| 16 | 편집 블러 ⊕ 라이브 금액 제거 | 미확인 | 모의 4 · 의존 없음 · now | 판정 불가 |
| 17 | 오늘 밤 v0.2.4 릴리스 루프 | 미확인 | 모의 4 · 의존 없음 · now | 판정 불가 |
| 18 | 0.2.5 릴리스 루프 보강 | 미확인 | 모의 4 · 의존 없음 · now | 판정 불가 |
| 19 | 통합관제(포트) 구현 부족 수리 | 미확인 | 모의 4 · 의존 없음 · now | 판정 불가 |
| 20 | 키체인 창 근본 수리 | 미확인 | 모의 hitl/security · 의존 없음 · hitl | 판정 불가 |
| 21 | 지시를 Linear 태스크로 | 미확인 | 모의 4 · 의존 없음 · now | 판정 불가 |
| 22 | 루프 에이전트 정식 기능·매뉴얼 | 미확인 | 모의 4 · 의존 없음 · now | 판정 불가 |

`bun test src/steward/directive.test.ts src/steward/triage.test.ts`는 가짜 Linear·가짜 LLM의 기능 검증이며 위 표의 실제 분배 일치율을 측정하지 않는다. `elanous directive add --dry-run` 은 네트워크 없이 단일 지시의 해시만 미리 본다. 가짜 LLM(rung=4·의존 없음·priority=2) 트리아지 22건의 모의값을 위에 모두 적었다. 가짜 LLM 분류에서 HITL 세 건, now 19건이다. 이 모의값을 실제 LLM의 판단으로 읽지 않는다. 실제 이슈 22건 생성·실제 LLM 트리아지·손 분배 대조는 수행되지 않았다.

## 검증 기록 (격리 트리)
- 표본 22건: `bun test src/steward/directive.test.ts src/steward/triage.test.ts` — `16 pass` · `0 fail` (각각 `bun test src/steward/directive.test.ts` = `7 pass`, `bun test src/steward/triage.test.ts` = `9 pass`). 가짜 Linear·LLM에서 dry-run 22건, triage 22건, HITL 네 분류, 의존 정렬, observe 스폰 0. `src/steward/triage.test.ts`의 22행 루프가 표의 모의값을 행별로 대조하며 HITL 3건을 단언한다. **실제 🅢 분배와의 일치율은 판정 불가**(원장 미제공).
- `bun bin/elanous.mjs graph run graphs/steward/steward.yaml --dry-run --json` — `"status":"done","path":["sync","triage","schedule","report","done"],"executed":0`.
- `bun bin/elanous.mjs directive add '티저 v2 PTY 메인 오늘' --dry-run` — `dry-run\t-\t69bb2a078275b0f26378b248e18bfaa4a73b3c899fb12ef52b0e39a7019a0fcf` (실제 Linear 호출 없음).
- 변이 확인: `triage.ts`에서 강제 HITL `rung: hitlReason ? 'hitl' : ...`를 `rung: d.rung ...`으로 바꾸면 `bun test src/steward/triage.test.ts`의 실패 행은 `(fail) LLM decisions emit route/escalate and mandatory HITL for paid sale [0.79ms]` (`6 pass`, `2 fail`: 표본 대조도 실패). 복원 후 `bun test src/steward/directive.test.ts src/steward/triage.test.ts` = `16 pass`, `0 fail`.
- `bun bin/elanous.mjs self typecheck` — `✅ 변경 파일 타입 검사 통과 (9개 파일 검사·baseline 무시·스코프: git diff HEAD ⊕ untracked — 커밋된 변경은 «안 본다»)`.
- 경계: 이 YAML의 `loop.trigger`는 선언적 메타데이터이고, 스케줄 데몬에 자동 등록되었다는 근거는 없다. `--test graph run`은 이 격리 트리에 `~/.elanous/config.json`이 없어 기동 거부됐다; 위 `graph run --dry-run`은 `executed:0`인 경로 확인만 증명한다. 실제 15분 자동 실행·실제 Linear/LLM/Telegram 연동은 미검증. 사람 손 분배 원장 미제공으로 22건 실제 일치·불일치 비교도 불가능하다.

증거 좌표: 이슈 생성·동일 지시 댓글 `src/steward/directive.ts` / `directive.test.ts`; 의존·상한·예산·HITL `src/steward/triage.ts` / `triage.test.ts`; observe 스폰 0 `graphs/steward/steward.yaml`(sync→triage→schedule→report→done만) 및 `triage.test.ts`; 자격 비노출 `directive.test.ts`(Authorization만) · `triage.test.ts`(저장 파일 비노출). 현시점 표본의 대조 열은 모두 미측정이며 실제 Linear 이슈 생성 결과로 주장하지 않는다.
