# 09-28 대표 지시 대조 표본

## SCQA
- S — 아래 22건은 요청에 제공된 «요지» 표본이다. 원문 전사는 제공되지 않았다. 빈 격리 상태에 가짜 Linear 식별자 ELA-1~22로 입력하고 실제 LLM에 **22건 묶음 판정 1회**를 요청했다.
- C — 🅢 손 분배 결과 원장은 이 입력에 포함되지 않았다. 지어낼 수 없다. LLM의 우선순위와 의존도 요지만으로 낸 가설이다.
- Q — (비움 — C 와 같은 말이다)
- A — 판단과 카드 쓰기 실행은 기록하되, 손 분배가 확인되기 전에는 일치·틀림을 모두 **판정 불가**로 둔다. 실제 Linear 생성이나 운영 보드 반영으로 읽지 않는다.

**손 분배 일치율: 판정 불가 (확인 가능 0/22 · 일치 ?/0).** 0%나 100%가 아니다. 재는 명령: `bun test src/steward/triage.test.ts src/steward/steward-cards.test.ts` (이 문서의 22개 손 분배가 모두 `미확인`인지 단언; 산출 `18 pass`, `0 fail`). 로컬 재측정: `bun .elanous-test/scratch/steward-compare.ts` → `verified=0/22 agreement=unmeasured` (무시되는 관측 스크립트). 실제 분배 원장을 확보해야 일치율을 계산할 수 있다.

| # | 지시 (제공된 요지 · 원문 아님) | 스튜어드 rung / 우선 / HITL · disposition | 🅢 손 분배 | 일치/틀림 | 한 줄 이유 |
|---:|---|---|---|---|---|
| 1 | PTY 인텔리전스 우선 | 3 / 1 / — · now | 미확인 | 판정 불가 | 범위와 우선 적용 대상을 먼저 확인해야 한다. |
| 2 | 로그인 브라우저 갈래 | hitl / 2 / security · hitl | 미확인 | 판정 불가 | 로그인 경로 변경이 인증 동작에 영향을 줄 수 있다고 판단했다. |
| 3 | Claude Code 는 PTY 경로만 | 4 / 1 / — · now | 미확인 | 판정 불가 | PTY 경로 제한을 검증 가능한 구현 목표로 봤다. |
| 4 | 공개 docs PTY 정리 | hitl / 2 / public · hitl | 미확인 | 판정 불가 | 공개 문서 변경을 대외 공개로 분류했다. |
| 5 | 플러그인·마켓 RFC(codex 호환) | 3 / 2 / — · now | 미확인 | 판정 불가 | Codex 호환 범위 조사가 선행한다고 판단했다. |
| 6 | 유료는 천천히 | hitl / 2 / money · hitl | 미확인 | 판정 불가 | 유료화 속도를 금전 정책 결정으로 분류했다. |
| 7 | 플러그인 우선 | 3 / 1 / — · now | 미확인 | 판정 불가 | 무엇에 비해 우선인지 범위를 확인해야 한다. |
| 8 | 워크플로 커스텀 노드 편집기 | 4 / 3 / — · now | 미확인 | 판정 불가 | 구현과 검증이 필요한 기능 목표로 봤다. |
| 9 | 편집기 한 화면 두 모드 | 4 / 3 / — · wait | 미확인 | 판정 불가 | 8번 편집기에 의존한다고 판단했다. |
| 10 | 기본 스킬셋 마켓 팩 | 4 / 3 / — · wait | 미확인 | 판정 불가 | 5번 마켓 규격 조사에 의존한다고 판단했다. |
| 11 | 티저 네 소구점 확장 | 4 / 3 / — · now | 미확인 | 판정 불가 | 공개 지시가 명시되지 않은 콘텐츠 제작으로 봤다. |
| 12 | 티저 v2 PTY 메인 오늘 | 4 / 1 / — · now | 미확인 | 판정 불가 | 결과물을 확인할 수 있는 제작 목표로 봤다. |
| 13 | 티저 v3 블록버스터 | 4 / 3 / — · wait | 미확인 | 판정 불가 | 12번 v2에 의존하는 후속 목표로 봤다. |
| 14 | 영어 남성 VO | 4 / 3 / — · now | 미확인 | 판정 불가 | 구매나 공개가 명시되지 않은 제작 결과물로 봤다. |
| 15 | Resolve·AE·Blender·Higgsfield | 3 / 3 / — · now | 미확인 | 판정 불가 | 도구 이름만 있어 수행할 작업을 확인해야 한다. |
| 16 | 편집 블러 ⊕ 라이브 금액 제거 | 4 / 2 / — · now | 미확인 | 판정 불가 | 편집 결과를 검증할 수 있는 목표로 봤다. |
| 17 | 오늘 밤 v0.2.4 릴리스 루프 | hitl / 1 / public · hitl | 미확인 | 판정 불가 | 외부 공개를 수반하는 릴리스라고 판단했다. |
| 18 | 0.2.5 릴리스 루프 보강 | 4 / 2 / — · wait | 미확인 | 판정 불가 | 17번 릴리스 루프에 의존한다고 판단했다. |
| 19 | 통합관제(포트) 구현 부족 수리 | 4 / 2 / — · now | 미확인 | 판정 불가 | 재현과 수리 결과를 검증할 수 있다고 판단했다. |
| 20 | 키체인 창 근본 수리 | hitl / 1 / security · hitl | 미확인 | 판정 불가 | 자격 증명 처리에 영향이 있을 수 있다고 판단했다. |
| 21 | 지시를 Linear 태스크로 | 4 / 1 / — · now | 미확인 | 판정 불가 | 지시별 Linear 태스크 반영을 검증 가능한 목표로 봤다. |
| 22 | 루프 에이전트 정식 기능·매뉴얼 | 4 / 3 / — · now | 미확인 | 판정 불가 | 구현·문서 결과로 검증할 수 있다고 판단했다. |

## 실행 기록 (격리 트리)
- 이 표의 판정 원자료는 `triageIssues`가 22건 묶음 실제 LLM 응답을 검증한 뒤 `scheduleTriage`가 만든 `.elanous-test/scratch/steward-decisions.json`이다. 출처는 로컬 관측 자료로 diff에 포함되지 않으며, 표의 판정 행은 그 시점의 스냅샷이다. 🅢 손 분배 원장은 끝내 제공되지 않았다.
- `bun .elanous-test/scratch/steward-llm-probe.ts` → `cards=22 intake+triage=22`. 이 스크립트는 위 22개 요지를 가짜 Linear 이슈로 만들고 LLM에 한 번 묶음 판정, `triageIssues`와 `scheduleTriage`를 거쳐 **격리된** `.elanous-test/steward-sample` CardStore에 기록한다. 원시 응답 `.elanous-test/scratch/steward-raw.txt`, 스케줄 `.elanous-test/scratch/steward-decisions.json` (둘 다 무시되는 로컬 관측 자료). 다시 읽기: `bun .elanous-test/scratch/steward-card-list.ts` → `cards=22 intake+triage=22`. 재실행은 LLM 비결정성 때문에 새 판정을 더할 수 있다. 공개/돈/보안 판정은 `hitl`로 기록됐고, 의존 4건은 `wait`였다. 테스트의 가짜 판단과 이 실제 LLM 표본을 섞지 않는다.
- `bun test src/steward/triage.test.ts src/steward/steward-cards.test.ts` → `18 pass`, `0 fail`. 판정 셋→카드 셋·두 칸·주인·멱등·HITL·report 쓰기 예외·observe의 스폰/발사/병합 없음과 가짜 Linear 22건의 sync→triage→schedule→report에서 카드 22장·각 두 칸은 해당 두 테스트 파일에서 검사한다. `steward-cards.test.ts`는 지시 body의 `출처:`·`시각:` 메타데이터를 인입 칸으로 옮기되 비공개 본문은 복사하지 않는 경우도 확인한다.
- 변이 반증: `src/steward/steward-cards.ts`의 HITL 강제 disposition을 입력 disposition 그대로 기록하도록 바꾸고 `bun test src/steward/steward-cards.test.ts`를 실행하자 `(fail) a forced HITL rung cannot be written as now even from an inconsistent schedule [0.14ms]` (`2 pass`, `1 fail`). 그 한 줄을 원복하고 같은 파일만 다시 돌리자 `3 pass`, `0 fail`; 이후 테스트를 추가해 현재 최종 집중 실행은 위 `18 pass`, `0 fail`이다.
- `bun bin/elanous.mjs self typecheck` → 변경 파일 타입 검사 통과. CLI 판정 신호 `bun .elanous-test/scratch/steward-cli-probe.ts` → `cards=22 intake+triage=22`: 로컬 판정 파일을 `.elanous-test/task-cards`에 기록한 뒤 격리 `NODE_ENV=test` 자식에서 `bun bin/elanous.mjs --test card list --json`의 반환 JSON을 실제로 파싱·집계한다. 일반 환경의 `bun bin/elanous.mjs --test card list --json`은 부모 `~/.elanous/config.json` 부재로 `[test-isolation] config 분기 실패: ENOENT`를 출력해 기동 거부됐으므로, 위 관측은 **격리 NODE_ENV=test 경로**에 한한다.
- 표의 🅢 손 분배 22칸은 원장이 미제공이라 모두 미확인이다. `내부 문서 `RFC-loop-agents-first-class-steward-and-lifecycle-2026-09-28`` §6은 «대조할 것»만 요구하고 행별 손 분배는 싣지 않는다. 외부 근거 조회: `bun .elanous-test/scratch/steward-gh-lookup.ts` (GitHub 인증 환경변수가 있으면 사용) → 인증 조회 `status:200`, #21761 본문은 «표본 22건 ↔ 손 분배 대조표 후속»이라고만 적고 손 분배 자체는 없다. 앞선 무인증 조회 `404 Not Found`를 원장 부재 근거로 사용하지 않는다. `bun .elanous-test/scratch/steward-gh-evidence.ts`로 인증 조회한 #21717·#21741의 원문에도 표본 목록과 대조 요구만 있고 행별 손 분배는 없다. `bun .elanous-test/scratch/steward-gh-prs.ts`는 해당 기간 인증 검색으로 PR 373건을 읽었고 «손 분배»가 명시된 것은 위 세 PR의 대조 요구뿐이었다. 개별 관련 PR(예: #21636 로그인 브라우저, #21638 공개 docs)은 산출·담당의 **부분 근거**이나 22건 전체 🅢 손 분배 표 또는 rung·우선·HITL의 동일 기준 대조 원장은 아니다. 실제 22건 일치율과 운영 보드 표시는 검증되지 않았다. 이슈 생성·실제 Linear 연동·15분 자동 기동도 수행하지 않았다.
