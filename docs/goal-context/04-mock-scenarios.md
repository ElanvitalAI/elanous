# 재사용 검증 무대 카탈로그

S: 골 저작기와 Pod 자식은 HQ의 private `seat-state` 파일을 읽지 못한다. C: 검증 메뉴가 개념만 제시하면 실제 수용선을 쓸 때 사건 무대와 실행 경계가 다시 발명된다. Q: 어떤 재사용 무대를 고르고 무엇을 채워야 하나? A: 아래 공통 템플릿과 MS-01~05를 저장소 정본으로 둔다. 각 무대는 특정 입력·환경에서 증명하는 범위만 보장하며, 빠진 명령이나 정리는 해당 골에서 채운다.

이 카탈로그는 `docs/goal-context/03-verification-menu.md`의 검증 방법을 구체적인 무대와 연결한다. 초기 원본은 `~/elanous-hq/seat-state/OP/MOCK-SCENARIO-CATALOG.md`이며, 이 저장소 파일이 착지하면 저장소 쪽이 정본이다.

## 표준 템플릿

한 시나리오마다 다음 필드를 채운다. 자리표시자는 실행 전에 실제 값으로 바꾼다.

```text
### MS-<번호> <짧은 이름>
- 증명하는 동작: <무엇이 일어나야 하나 — 한 문장>
- 언제 쓰나: <운영에서 드물거나 기다려야 하는 사건 · 어떤 칸 꼴에>
- 우주: test(--test) | Docker 격리(node-b 이미지 pin) | ux-sim | 임시 git 저장소 | 격리 HOME
- 무대 세우기(명령 · 연산자 없는 줄 여러 개): ...
- 실행(생산 진입점을 지나는 명령): ...
- 판정(무엇을 보면 통과): rc · 출력 문구 · 원장 행 · 파일 해시 불변 …
- 치우기: ...
- 함정: <운영 우주 오염 · 비밀값 · push 금지 …>
- 출처: <green-e4 파일 · 칸 · 자리 · 날짜>
```

원본 카탈로그에서 제공하지 않은 값은 `원본에 미기재`로 표시했다. 실행 계획은 이 빈칸을 해당 골의 다섯 줄 검증 계획으로 구체화한다.
아래 명령은 재사용 계획의 템플릿이다. 골에서 실제 값을 채워 실행 결과를 남기기 전에는 동작 검증 증거로 인용하지 않는다.

## 검증 무대

### <a id="ms-01"></a> MS-01 시험 판 무대(체크리스트 fixture)

- **증명하는 동작:** 칸·카드를 읽는 생산 CLI가 실제 체크리스트 행으로 동작한다.
- **언제 쓰나:** test 우주 체크리스트가 비어 있어 운영 칸이 있어야 보이는 기능을 시험할 때.
- **우주:** test (`--test`).
- **무대 세우기:** `bun bin/elanous.mjs --test release checklist add <시험칸> "<제목>" --version 9.9.9 --owner <자리>`
- **실행:** 대상 기능의 생산 CLI를 `--test`로 실행한다(예: `tasks work-order build`).
- **판정:** 종료 코드 0과 목표가 요구한 정규화 필드를 확인한다. `unknownFields`를 다루는 목표일 때만 그 보존도 판정한다.
- **치우기:** 원본 미기재. 시험 인스턴스를 재사용하지 않는지 계획에 적는다.
- **함정:** 운영 원장을 복사하지 않는다. `config sync-test`를 쓸 때 비밀값 제거를 확인한다.
- **출처:** `~/elanous-hq/seat-state/MK/green-e4/ENTRANCE-WORK-ORDER-BUILD.md`.

### <a id="ms-02"></a> MS-02 실패 런 무대(release resume)

- **증명하는 동작:** 실패한 발행/예행 런에서 resume이 실행 가능한 계획을 내고 저장된 런 원장은 불변이다.
- **언제 쓰나:** 실제 발행 실패를 기다려야 하는 복구 경로를 시험할 때.
- **우주:** test 및 push하지 않는 로컬 시험 가지.
- **무대 세우기:** 저장소의 격리 임시 clone에서 시험 판 `9.9.9`를 만든다; `release/9.9.9` 로컬 가지는 `origin/main`에서 만든다; 저장 런 JSON은 gate 실패·attempt 0·저장 commit이 가지 조상인 상태로 둔다. 현재 작업 저장소에는 이 가지를 만들지 않는다.
- **실행:** `bun bin/elanous.mjs --test release resume --dry-run <실패 런 경로>`
- **판정:** 종료 코드 0, 계획 출력, 런 JSON 해시가 전후 동일, attempt 파일 없음.
- **치우기:** 임시 시험 판·로컬 가지·런 JSON만 제거한다. 실제 발행 기록은 건드리지 않는다.
- **함정:** 원본은 `--dry-run` 경계와 push 금지를 요구한다. 실패 상태를 운영에 만들지 않는다.
- **출처:** `~/elanous-hq/seat-state/MK/green-e4/RELEASE-RECOVER-ONE-STEP.md`.

### <a id="ms-03"></a> MS-03 격리 self-implement 한 바퀴

- **증명하는 동작:** `runSelfImplement` 생산 진입점이 실제 기능을 부르고 원장에 남긴다.
- **언제 쓰나:** 함수 단위 시험을 넘어 격리된 self-implement 한 실행에서 호출과 기록을 확인할 때.
- **우주:** 격리 HOME 및 test.
- **무대 세우기:** 원본에 미기재. 골에 격리 HOME·test 설정과 Pod가 열 수 있는 저장소 내 시험 경로를 명시한다. 이를 제시할 수 없으면 이 장면을 재사용하지 말고 새 무대를 제안한다.
- **실행:** 원본에 미기재. `runSelfImplement`를 부르는 실제 생산 진입점과 한 바퀴 명령, 저장소 내 계약 시험 경로를 골에서 특정한다. HQ 증거 파일만으로 완료를 판정하지 않는다.
- **판정:** 원본 표본은 round 0 호출 1/0 및 `K-TC-777` 산출 크기 0보다 큼을 기록했다. 새 골은 필요한 원장 행과 출력 조건을 구체화한다.
- **치우기:** 원본에 미기재. 격리 HOME만 제거하고 운영 HOME은 사용하지 않는다.
- **함정:** 함수 직접 호출이나 합성 결과만으로 생산 경로 연결을 주장하지 않는다.
- **출처:** `~/elanous-hq/seat-state/TC/green-e4/TA-KNOWHOW-PACK.md`.

### <a id="ms-04"></a> MS-04 실제 git ⊕ 생산 PrManager

- **증명하는 동작:** 실제 git 상태에 의존하는 PR 재사용·회수 동작을 확인한다.
- **언제 쓰나:** 가지·원격·커밋 상태가 결과를 가르는 생산 PR 관리 경로를 시험할 때.
- **우주:** 임시 git 저장소에서 실제 git을 실행하고, GitHub API 경계는 CmdRunner stub으로 둔다.
- **무대 세우기:** 임시 bare 저장소·seed·clone을 사용한다. 구체 명령은 원본에 미기재. 골에 Pod가 열 수 있는 저장소 내 시험 경로를 명시하고, 그런 경로가 없으면 새 무대를 제안한다.
- **실행:** 생산 `PrManager` 경로를 부르는 시험 명령은 원본에 미기재. 골에서 명령과 계약 시험 파일을 특정한다.
- **판정:** 원본 카탈로그는 실제 git 시험 8개 통과를 보고하지만, 원본 시험 경로가 저장소에서 확인되기 전에는 재사용 증거로 세지 않는다. 새 실행 결과에는 GitHub 경계가 stub임을 명시한다.
- **치우기:** 임시 저장소를 제거한다.
- **함정:** 운영 GitHub를 호출하지 않는다.
- **출처:** `~/elanous-hq/seat-state/OPC/green-e4/PR-SAME-CELL-REUSE.md`.

### <a id="ms-05"></a> MS-05 생산 호출부 확인(배선)

- **증명하는 동작:** 착지한 함수가 시험 코드 밖의 생산 경로에서 호출된다.
- **언제 쓰나:** helper·패키지·생산 호출부 연결을 수용선으로 삼을 때.
- **우주:** 검증 대상 PR 커밋(`HEAD`)의 생산 소스 검사. 런타임 동작 자체는 별도의 해당 우주에서 검증한다.
- **무대 세우기:** 대상 함수 이름과 production source 범위를 정한다.
- **실행:** PR 검증 대상 커밋을 checkout한 저장소 루트에서 골에 정한 생산 소스 범위로 실행한다. 예: `git grep -n -F '<함수이름>(' HEAD -- <생산-소스-경로>`
- **판정:** 검색은 후보를 찾는 단계다. 생산 소스의 파일·행을 열어 함수 선언·주석이 아닌 실제 호출 문장임을 확인하고 근거로 남긴다. 이 grep의 0건만으로 미배선을 판정하지 않는다. 별칭·재수출·줄바꿈 호출을 포함해 심볼 참조나 AST/수동 검색으로 범위를 확인한 뒤에도 호출부가 없을 때 미배선으로 기록한다.
- **치우기:** 파일 변경 없음.
- **함정:** `HEAD`가 검증할 PR 커밋인지, 검색 경로가 그 기능의 전체 생산 소스 범위인지 먼저 확인한다. 테스트만 제외하는 등 경로 필터는 골에 적는다. 별칭·재수출·줄바꿈 호출은 단순 grep이 놓칠 수 있으므로 결과 0건을 완전성으로 보지 않는다. 소스 확인은 호출부 존재만 증명하고 런타임 실행·결과를 증명하지 않으므로 해당 시험도 추가로 고른다.
- **출처:** `~/elanous-hq/seat-state/MK/green-e4/ALREADY-BUILT-HINT.md`; `~/elanous-hq/seat-state/TC/green-e4/REVIEW-FINDING-PATH-HEAD-CHECK.md`; `~/elanous-hq/seat-state/TC/green-e4/CLAUDE-FAILOVER.md`. E4 과업에서 미측정·미완료면 별도 E4 절차에 따라 FU 제목 파일을 만든다. 이는 MS-05의 pass 판정이 아니다.

## <a id="catalog-gaps"></a> 현재 카탈로그 빈칸

기존 MS가 방법의 증거 경계와 맞지 않으면 억지로 연결하지 않고 새 무대 제안으로 잇는다. 이 절은 실행 증거가 아니라 빈칸 표시다.

| 방법 | 아직 없는 표준 무대 |
|---|---|
| ux-sim 시뮬레이션 | 실제 함수·렌더 경계를 재사용 입력으로 실행하는 구체 시나리오 |
| <a id="cli-sim-run-gap"></a>CLI `sim run` mock 시나리오 | 명시한 mock 입력을 허용된 실제 경로에 통과시켜 기대 결과를 판정하는 별도 CLI 무대 |
| Docker 격리 | Pod 실패 봉투를 고정된 node-b 이미지와 checkout에서 재현 |
| 열차 사이드 gate | 같은 PR head의 통합·원격 gate 결과를 확인하는 대기열/receipt 장면 |
| 운영 실물 | 운영 데이터·실제 사건을 입력으로 하는 대상별 기록; 공통 fixture는 만들지 않음 |
| 로그 관측 | 지정 인스턴스에서 이벤트를 조회하고 실제 로그 필드·시간 창·상관 키를 확인하는 장면 |

## UX simulation device index

The UX simulation device catalog is [`src/ux-sim/mock-scenario-catalog.json`](../../src/ux-sim/mock-scenario-catalog.json). Its IDs use the `UX-MS-` prefix so they do not collide with the reusable verification scenes MS-01–05 defined above.

```bash
bun scripts/ux-sim.ts list
bun scripts/ux-sim.ts show UX-MS-01
```

Each UX entry names the real implementation, focused tests, injected condition, observations, and expected verdict. The list includes child report deficit, release gate regression, review cap/no verdict, Pod credential failure, UI/gate stall, landing train rejection, and Pod pool/query error. The catalog contract test requires every runtime TypeScript module in `src/ux-sim/` to be indexed and checks that referenced files exist.

The catalog is a reference index: `list` and `show` do not execute every entry through ScenarioV0. This run evidence contract applies only to an actual ScenarioV0 YAML execution in test mode: it generates a UUID `runId`, emits `ux.sim.scenario/completed` with that value in `data.runId`, verifies the row in `<test-state>/logs/logs.db`, and writes the same ID into a per-run evidence artifact. Missing persisted event evidence makes that run fail. Other script and test fixture roots remain discovery candidates; this catalog does not claim every repository fake or stub is reusable.
