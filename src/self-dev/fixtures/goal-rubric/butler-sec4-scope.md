대상 경로: src/judge-butler/done-when.ts · src/judge-butler/judge-butler-sim.test.ts
- GoalType: implement

BUTLER-SEC4-SCOPE — 판정 집사의 보안 4종(security-4) 분류가 시험 파일·fixture·문서 경로까지 보안 경로로 세어, 증거가 다 있는 PR 을 JUD 로 올린다. 실행 코드만 보안 4종을 만들게 한다.

S(상황): src/judge-butler/done-when.ts 의 SECURITY4_PATHS 정규식과 security4Hits(files) 가 PR 의 바뀐 파일마다 보안 경로 꼴을 찾는다. 하나라도 맞으면 judgeCell 이 kind 'security' 로 JUD/Terra 에 올린다.
C(문제): rail 76 · 판정 집사 첫 tick 02:01Z — security-4 올림 11건 vs 초록 1건. 올라간 경로 대부분이 시험 파일이 remote-exec 꼴에 걸린 것이다: onboarding-pty.test.ts ×3 · entry-compact-chrome-pty.test.ts · task-pin-rows-pty.test.ts · agent-spawn-guard.test.ts.
Q(물음): 어떤 파일이 PR 을 security-4 로 만들 수 있나 — 실행 코드만.
A(답): security4Hits 가 실행 코드가 아닌 경로(시험 파일 · fixture · 스냅숏 · 문서)는 건너뛴다. 시험 파일과 실행 코드가 같이 바뀌면 실행 코드로 security-4 다.

불변식: 실행 코드 경로의 security-4 판정은 지금과 같다(LLM 0).
경계: done-when.ts 와 그 시험 파일만.
판정 신호: 조건 = rail 76 의 시험 경로만 바뀐 PR; 관측 = bun test src/judge-butler; 기대 = security4Hits 빈 배열 · 실행 코드 형제 파일을 더하면 그 파일로 hit 단언 통과.

완료선:
- 시험·fixture·문서만 바뀐 PR 은 security-4 가 아니다 — src/judge-butler/judge-butler-sim.test.ts
- 실행 코드가 함께 바뀌면 그 파일로 security-4 — 같은 시험

범위 밖=FU: 없음

검증 예산: 원격 집중 1회 `bun test src/judge-butler` ⊕ 대조 실험이라 PR 은 열지 않아도 된다

판정: T1 · 기능 판정자 1명 · 보안 불요

라운드 상한: r3

증거 규칙: 손 결과(#40337)와 대조하는 사전 점검 실험
