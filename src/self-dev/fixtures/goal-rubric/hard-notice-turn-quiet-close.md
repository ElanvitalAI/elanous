대상 경로: src/core-turn/run-core-turn.ts · src/chat/interjection.ts · src/tui/core/queue.ts · src/core-turn/notice-quiet-close.test.ts
- GoalType: implement

NOTICE-TURN-QUIET-CLOSE — 우편·깨움(notice) 턴이 «보고할 것 없음»이면 산문 보고 없이 한 줄 영수로 끝나게 한다(openclaw heartbeat notify=false 패턴). 지금은 사건마다 턴이 열리고 자리가 «받음 · 할 일 없음» 산문을 쓴다.

S(상황): 근거 = ~/elanous-hq/seat-state/OP/RESEARCH-agent-loop-compare-1122.md 표 #2. 자리 우편 턴의 입구 = src/core-turn/run-core-turn.ts(seat-mail mid-turn) · src/chat/interjection.ts(buildInterjectionMessage · FEDERATION_WORK_ORDER_NOTE «받은 턴 첫 줄에 받음 + 첫 행동») · src/tui/core/queue.ts(notice 항목).
C(문제): 정보성·상태 우편(이미 mail_digest 로 접힘)에도 턴마다 산문 답이 나온다 — 자리 턴 수·토큰을 쓰고 OP 수신을 늘린다.
Q(물음): notice 턴에서 모델이 구조화 응답(도구 또는 예약 토큰 — 기존 도구 표면에 맞는 가장 작은 꼴)으로 «notify=false» 를 내면 TUI/전사에는 한 줄 영수만 남고 산문 보고가 없으면 닫힌다. 일감이 있는 우편(업무 지시)은 지금처럼 받음 + 첫 행동.
A(답): notice 턴 전용 조용한 종결 계약을 더한다 — 정보성 notice 의 프롬프트에 «할 일 없으면 조용히 종결» 안내 ⊕ 종결 신호 판정(정규식 문면 판정 금지 · 구조화 신호로) ⊕ 렌더는 한 줄 영수. 업무 지시 우편·사람 입력 턴에는 적용하지 않는다.

불변식: 사람 입력 턴·업무 지시 우편 턴의 동작은 같다 · 정규식으로 문장을 분류하지 않는다(대표 11-20) · 옵션·깃발을 만들지 않는다.
경계: 위 대상 경로 ⊕ 새 시험. classic TUI(src/dashboard)는 건드리지 않는다.
판정 신호: 조건 = 정보성 notice 1건 · 가짜 LLM 이 조용한 종결 신호를 냄; 관측 = bun test src/core-turn/notice-quiet-close.test.ts; 기대 = 전사 산문 0 · 영수 한 줄 · 업무 지시 우편은 종전 첫 줄 단언 통과.

완료선:
- 정보성 notice + 조용한 종결 = 산문 0 · 영수 1줄 — 새 시험
- 업무 지시 우편·사람 입력 = 종전 동작 — 같은 시험 ⊕ 기존 interjection/notice 시험 회귀 0

범위 밖=FU: NOTICE-FOLD-BEFORE-PROMPT(사건을 다음 프롬프트 앞에 접기 · 상한 N)

판정: T1 · 기능 판정자 1명 · 보안 불요

증거 규칙: 같은 head 영수 sha ⊕ focused exit 0 = 충분 · PR 제목/본문에 칸 ID NOTICE-TURN-QUIET-CLOSE
