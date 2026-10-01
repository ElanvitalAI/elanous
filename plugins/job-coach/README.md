# job-coach — AI 직무코치

**S** 인터뷰에서 직무 후보를 추출해 공공데이터포털의 NCS 능력단위와 비교하고, 외부 코스 조사로 보고서를 작성한다. **C** 실제 NCS 키와 코스 출처가 없으면 매칭·추천을 지어낼 수 없다. **Q** 이 패키지를 받은 사용자가 어떻게 실행하고 결과를 확인하는가? **A** 아래 실행 방법과 검증 방법을 따른다.

## 개인 모드 · 기업 HRD 모드

개인 모드(`report.yaml`)는 `## 희망 직무`, `## 경험`, `## 보유 역량` 인터뷰를 읽고 직무 후보 → NCS 매칭 → 검증된 과정 조사 → 자기보고 역량 갭 → 개인 보고서로 진행한다. NCS 키가 없으면 실패하며 확인된 과정 URL이 없으면 추천을 `미확인`으로 표시한다. 개인 보고서의 다섯 섹션과 기존 `research` 재시도 계약은 유지한다.

기업 HRD 모드(`report-enterprise.yaml`)는 `## 기업 개요`, `## 교육 대상`, `## 현업 과제`, `## 교육 목표`, `## 현재 역량`, `## 교육 제약`의 인터뷰를 받는다. 가상 회사·가상 직원으로 입력을 시험하고 실제 직원 정보나 내부 정책을 예시 파일에 싣지 않는다. 같은 NCS 조회를 재사용해 니즈 → 현업 과제 → NCS → AI 적합성(비AI 대안 포함) → 역량 → 로드맵 → 교육 명세와 운영 경로를 만든 뒤 일곱 섹션을 판정한다. 섹션 또는 근거가 누락되면 보고 단계로 한 번 되돌리고 다시 판정한다. 인터뷰 진술은 자기보고이고, NCS 코드·과정/URL·사내 정책 및 AI 도입 승인은 조회·확인 전에는 `미확인`이다.

```sh
elanous graph run /absolute/path/to/installed/job-coach/graphs/report-enterprise.yaml --input '{"interview":"/private/path/to/fictional-enterprise.md"}' --json
```

### 기업 모드 샘플 입력 (가상 정보만)

다음은 **가상 인물** 민서 하와 **가상 회사** 푸른달 스튜디오의 예시다. 이미지 경로는 실제 사진이 아닌 플레이스홀더이며, 인터뷰 안의 참고용 표기일 뿐이다. 그래프 입력 필드는 `interview` 하나로, 이미지 파일을 읽거나 전송하는 입력은 없다. 비공개 작업 디렉터리에 `fictional-enterprise.md`로 저장한 뒤 위 명령의 `interview` 경로를 그 파일의 절대 경로로 바꾼다.

```markdown
## 기업 개요
푸른달 스튜디오 (가상 회사). 이미지 참고 경로: /placeholder/images/fictional-company.png

## 교육 대상
민서 하 (가상 인물), 문서 기획 담당자

## 현업 과제
가상 행사 안내 문서의 기획

## 교육 목표
행사 안내 문서를 요구사항에 맞게 기획한다

## 현재 역량
문서 작성 경험 (자기보고)

## 교육 제약
예산과 승인 여부 미확인
```

### 입력·출력과 프라이버시 경계

입력은 기업 모드 인터뷰 Markdown **파일의 비공개 절대 경로**를 담은 `--input '{"interview":"/private/path/to/fictional-enterprise.md"}'`이다. 위 여섯 `##` 섹션이 필요하다. 실제 직원 이름·사진·인사정보·사내 기밀을 샘플, 명령 인자 또는 공개 저장소에 넣지 않는다. 실제 인터뷰를 사용할 경우에도 민감 정보를 제거하고 접근 제한된 저장소에서만 실행한다. 그래프 러너는 입력·노드 stdout을 런 상태와 컨텍스트 JSON에 저장하므로 **파일 경로만 인자로 넘겨도 보고서와 런 상태에는 인터뷰에서 파생된 직무·역량이 남는다**. 파일 경로가 개인정보 비노출이나 무저장을 보장하는 것은 아니다.

출력은 CLI의 상태 JSON(`statePath`와 `done`/`failed`) 및 그 상태 경로와 같은 디렉터리의 `<run-id>/report.md`다. 보고서는 아래 일곱 섹션으로 구성된다. NCS 조회가 실패하면 `failed`로 끝나며 확인되지 않은 과정·URL 및 내부 승인 여부는 `미확인`으로 남긴다. **No-send boundary:** 이 그래프 실행은 보고서를 로컬에 작성하는 경로이며 메신저·이메일로 보고서를 보내거나 마켓에 게시하는 단계가 없다. `--no-send` 플래그를 지원한다고 가정하지 않는다. 다만 NCS API 조회 및 외부 과정 조사는 네트워크 요청이므로 오프라인·무외부전송 실행이 아니다. 보고서 배포나 마켓 게시/시장 출시는 이 플러그인 README의 범위 밖이다.

기업 보고서는 `기업 개요 및 교육 대상`, `교육 니즈`, `직무·과제 및 NCS`, `AI 적합성`, `역량 진단`, `교육 로드맵`, `교육 명세·운영 경로` 순서다. NCS 조회에 실패하면 매칭을 발명하지 않고 런을 실패로 종료한다. `run-report` 스킬은 개인 보고서 진입이며 기업 모드는 다섯 개 기업 스킬(`enterprise-needs`, `enterprise-task-analysis`, `enterprise-ai-fit`, `enterprise-competency`, `enterprise-roadmap`)과 기업 그래프를 이용한다.

## 실행

공공데이터포털 [한국산업인력공단 NCS 기준정보 조회](https://www.data.go.kr/data/15128213/openapi.do) 활용신청 후 키를 **환경변수 `NCS_SERVICE_KEY`** 로 설정한다. 설치 시 `credentials` 이벤트의 `ncs.serviceKey` 에 입력하는 경로는 플러그인 설치기가 담당한다. 저장소에는 키를 넣지 않는다. `.mcp.json`은 MCP stdio 서버를 번들로 제공한다. 레시피는 러너가 제공하는 `ELANOUS_GRAPH_DIR`을 기준으로 번들 스크립트를 찾고, MCP의 `${CODEX_PLUGIN_ROOT}`는 Codex가 설치한 플러그인의 절대 경로로 치환한다. 런타임에는 `bun`과 PATH의 `elanous research --json`가 필요하다. 중첩 elanous 호출은 그래프를 돌린 우주를 그대로 따른다(`--test` 를 붙이지 않는다 — 저장소 밖에서는 `--test` 가 격리 루트를 못 정해 멈춘다). 인터뷰 파일은 `## 희망 직무`, `## 경험`, `## 보유 역량`을 포함해야 한다.

```sh
elanous graph run /absolute/path/to/installed/job-coach/graphs/report.yaml --input '{"interview":"/absolute/path/to/installed/job-coach/examples/interview-sample.md"}' --json
```

`job-coach:report` 별칭은 이 변경 범위의 그래프 CLI에서 아직 인식하지 않는다. 파일 경로로 실행해야 한다(`elanous plugin add`는 별도 골). 실행 결과의 `statePath`가 `<state>/graph-runs/job-coach-report/<run-id>.json`이고, 보고서는 같은 디렉터리의 `<run-id>/report.md`다. 실패 시 결과를 그럴듯하게 채우지 않고 `failed`로 끝난다. 주의: 실행 그래프 러너는 입력과 노드 stdout을 런 상태·컨텍스트 JSON에 보관하므로 실제 인터뷰 파일 **내용**을 그래프 입력·로그에 넣지 말고 비공개 경로만 건넨다. 프로필은 경험 원문 대신 건수만 산출하지만 직무 후보·보유 역량은 런 상태에 남는다. 런 상태 저장소는 접근제한된 개인용이어야 한다. `research`는 검색 링크를 추천으로 취급하지 않고 HTTPS 발행 페이지의 `Course` 구조화 메타데이터를 읽어 실제 과정인지 확인한 뒤, 과정 이름·설명이 NCS 능력단위 이름과 일치하는 경우에만 근거와 출처를 붙인다. 일반 문서·무관한 강좌·확인 불가 링크는 추천하지 않는다. 해당 과정이 없으면 보고서에 `확인된 관련 교육 과정 없음 (추천 미확인)`을 표시한다. `judge`는 빈 섹션이나 확인된 과정이 없는 첫 실행이면 `research`로 한 번 되돌린다. dry-run은 HTTP·연구·보고서 생성을 수행하지 않는다(런 상태 JSON은 저장한다):

```sh
elanous graph run /absolute/path/to/installed/job-coach/graphs/report.yaml --dry-run --json
bun test src/plugins/examples/job-coach.test.ts
```

Codex에서는 `run-report` 스킬을 실행한다. elanous MCP 그래프가 있으면 그것을 우선 호출하고 없으면 NCS MCP, 외부 검색, 나머지 두 스킬로 단계를 수행한다. 로컬 마켓 인덱스는 이 패키지의 `.agents/plugins/marketplace.json`이다. `codex plugin marketplace add <job-coach 경로>` 후 `codex plugin add job-coach@job-coach-local`로 격리 Codex 홈에도 설치할 수 있다. 원본 인터뷰는 비공개로 유지하고 가상 샘플만 저장소에 포함한다.
