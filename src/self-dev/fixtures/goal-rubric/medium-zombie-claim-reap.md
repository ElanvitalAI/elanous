대상 경로: src/steward/space/work-next-cli.ts · src/steward/space/work-next.ts · src/steward/space/zombie-claim.test.ts
- GoalType: implement

ZOMBIE-CLAIM-REAP — 우편을 안 읽는(미확인 N통 이상 · 가장 오래된 미확인 > 24h) 손은 프로세스가 살아 있어도 칸 점유 임대를 «끝남»으로 본다. 그래야 그 손이 쥔 노란 칸을 다른 손이 eln work next 로 당겨 간다.

S(상황): src/steward/space/work-next.ts:116 — 손 소유 칸은 boardLeaseUntilMs(칸, lastActiveMs(주인)) 가 지나야 다른 손이 당길 수 있다(임대 = 마지막 활동 + 45분 · LEASE_MINUTES). src/steward/space/work-next-cli.ts:88 lastActiveMs 는 활동 지도(active)에서 읽는다 — 우편을 쌓아 두고 일하지 않는 손도 «활동»이 있으면 임대가 계속 살아 있다.
C(문제): 11-27 실측 TC-H-REMOTE-1 = 미확인 우편 130통 · 가장 오래된 미확인 14.5일인데 working 으로 칸을 쥐고 있었다 — 그 칸은 아무도 못 당긴다.
Q(물음): 미확인 우편 ≥ 20통 ∧ 가장 오래된 미확인 > 24h 인 손의 lastActiveMs 가 «아주 오래 전»(임대 만료)으로 읽히고, eln work next 가 그 손의 칸을 다른 손에게 주면 닫힌다.
A(답): work-next-cli.ts 의 lastActiveMs 를 «미확인 우편 원장(src/msg/msg-store.ts readUnreadSummary 등 기존 읽기 함수)으로 좀비 판정 → undefined 또는 0» 으로 감싼다. 좀비 판정은 순수 함수(zombieSeat({unread, oldestUnreadAgeMs}))로 두고 시험한다. 원장을 못 읽으면 판정하지 않는다(종전 동작 · 관측 한 줄).

불변식: 미확인이 적거나 최근인 손의 임대는 지금과 같다 · 코디네이터·판정 자리 규칙(isCoordinator·isJudge)은 바꾸지 않는다 · 칸 owner 를 직접 고쳐 쓰지 않는다(당기는 쪽이 기존 swap 경로로 가져간다).
경계: work-next-cli.ts · work-next.ts(필요 시 순수 함수) · 새 시험 파일.
판정 신호: 조건 = 손 A(미확인 25통 · 최고령 30h · 활동 방금)가 쥔 칸 1 · 손 B 가 work next; 관측 = bun test src/steward/space/zombie-claim.test.ts; 기대 = B 가 그 칸을 받고 A(미확인 3통)인 경우엔 못 받는다는 단언 통과.

완료선:
- 좀비 손의 칸을 다른 손이 당긴다 · 정상 손의 칸은 못 당긴다 — src/steward/space/zombie-claim.test.ts
- 원장 읽기 실패 시 종전 동작 — 같은 시험

범위 밖=FU: ZOMBIE-CLAIM-REAP-NOTIFY(좀비 판정 손에게 한 줄 알림)

판정: T1 · 기능 판정자 1명 · 보안 불요

증거 규칙: 같은 head 영수 sha ⊕ focused exit 0 = 충분 · PR 제목/본문에 칸 ID ZOMBIE-CLAIM-REAP
