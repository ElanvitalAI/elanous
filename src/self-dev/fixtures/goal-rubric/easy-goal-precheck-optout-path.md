대상 경로: src/self-dev/ask-launch-flow.ts · src/self-dev/ask-launch-flow-precheck-optout.test.ts
- GoalType: implement

GOAL-PRECHECK-OPTOUT-PATH — 발사 전 분해 권고를 끈 발사(decomposeBeforeLaunch === false)는 골 사전 검토(GOAL-PRECHECK)도 건너뛴다. opt-out 경로에서도 사전 검토를 돌리고, needs-rewrite 면 같은 방식으로 멈춘다.

S(상황): src/self-dev/ask-launch-flow.ts 의 `if (launchDecision)` 갈래 — 기본 경로는 골 문서를 읽은 직후 precheckGoalDocument(src/self-dev/goal-precheck.ts)를 부르고 needs-rewrite 면 stopped-by-preflight 를 돌려준다. `input.decomposeBeforeLaunch === false` 갈래는 recommendLaunchDecomposition 만 부르고 문서를 읽지 않는다(«opt-out 은 문서 읽기를 건너뛴다» 계약 · 기존 시험 'pre-launch decomposition opt-out bypasses the final goal-document read').
C(문제): #40391 PR 본문 실패 경로 표 «분해 권고 opt-out → 사전 검토도 건너뜀(알려진 한계)» — opt-out 발사는 정책 대조 없이 나간다.
Q(물음): opt-out 경로에서도 사전 검토 판정이 나오고(needs-rewrite = 정지 · fixed = 고친 문서 기록 · pass = 문서 그대로), 기존 opt-out 시험의 «분해 권고용 최종 읽기 없음» 계약은 사전 검토 읽기 1회만 더해진 것으로 갱신되면 닫힌다.
A(답): opt-out 갈래에서 문서를 한 번 읽어 precheckGoalDocument 를 부르고(읽기 실패 = 종전처럼 발사 · 관측), 결과 처리는 기본 경로와 같은 함수로 묶는다(복사 금지).

불변식: 기본 경로 동작·문면은 같다 · opt-out 경로는 분해 권고를 여전히 하지 않는다.
경계: ask-launch-flow.ts · 새 시험 파일 · 필요하면 기존 opt-out 시험 기대(읽기 수) 갱신.
판정 신호: 조건 = decomposeBeforeLaunch false · 완료선 명령이 없는 골; 관측 = bun test src/self-dev/ask-launch-flow-precheck-optout.test.ts; 기대 = stopped-by-preflight · blocker GOAL-PRECHECK 단언 통과.

완료선:
- opt-out 경로 needs-rewrite = 정지 · pass = 발사 — 새 시험
- 기존 ask-launch-flow 시험 회귀 0 — bun test src/self-dev/ask-launch-flow

범위 밖=FU: 없음

판정: T1 · 기능 판정자 1명 · 보안 불요

증거 규칙: 같은 head 영수 sha ⊕ focused exit 0 = 충분 · PR 제목/본문에 칸 ID GOAL-PRECHECK-OPTOUT-PATH
