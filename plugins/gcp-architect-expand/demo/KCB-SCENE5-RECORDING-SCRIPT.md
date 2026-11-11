# KCB 장면 5 · GCP 확장 판단 · 녹화 대본

정본 시나리오: `~/elanous-hq/seat-state/OP/DEMO-1114-1116-INTEGRATED-SCENARIO.md`의 장면 5. 장면 4의 티켓팅 설계 결과를 입력으로 받는다. 11-14에는 기본 모델, 11-16에는 같은 문면을 Solar 프로필로 사용한다. 모델 이름을 플러그인에서 지정하지 않는다.

## 라이브 화면 순서 (목표 경로)

| 시각 | 화면·조작 | 진행자 대사 |
|---|---|---|
| 00:00–00:04 | 장면 4 설계 파일을 준비한 뒤 classic TUI에 «GCP 확장안 실행해줘» 입력. ToolSearch에 `route:GCP 확장안` 검색, 선택된 `gcp_architect_expand` 실행 표시. | “설계 결과를 바탕으로 로컬 자원과 확장 후보를 확인합니다.” |
| 00:04–00:09 | 기존 관측 신호 CPU·메모리·디스크·대기열과 부족 판정 표시. | “테스트 우주에서는 CPU 93%, 메모리 91%, 디스크 92%, 대기 작업 14개입니다.” |
| 00:09–00:16 | 구매 API·좌석·결제는 로컬, 비식별 집계만 GCP Batch + Spot 제안. 서울 `asia-northeast3` 기본, `us-central1` 비교 표시. | “구매 경로는 로컬에 두고 재시도 가능한 비식별 집계만 확장합니다.” |
| 00:16–00:22 | 월 비용 칸은 **미산정**, 공식 SKU 계산식과 Spot·유휴 종료·리전/이그레스 비교 절감안 표시. 가격 숫자 표시 금지. | “실제 월 금액은 공식 SKU 조회 전까지 약속하지 않습니다. 산식과 절감 선택지를 먼저 보여 줍니다.” |
| 00:22–00:27 | 보안 등급 `internal`, 프로젝트 분리·Secret Manager 개별 접근·비공개 진입·리전 정책 표시. | “데이터 등급에 맞춰 접근과 네트워크 경계를 제안합니다.” |
| 00:27–00:32 | 사용자 승인 `y/N`, 기본 `N`. 녹화에서는 테스트 우주 `y`를 입력. 승인 전 자원 생성 0을 보인 후 가짜 프로젝트·비용 원장·유휴 종료를 표시. | “비용이 드는 단계는 사용자 승인 후에만 진행합니다. 지금은 가짜 GCP 세계로 확인합니다.” |
| 00:32–00:38 | 직접 runGraph가 공용 출력 그래프로 검증한 편집 도면·PNG·PDF를 보여 준다. 실제 보드 첨부는 통합 경로가 확인된 뒤 장면 6에서 본다. | “도면 원본과 설계 PDF가 준비됐습니다. 보드 첨부는 실제 통합 경로에서 확인합니다.” |

## 녹화 대체본 사용 조건

라이브에서 `ToolSearch(route:GCP 확장안) → 선택된 도구 → runGraph → 입력창 y/N`이 확인되면 라이브 화면을 사용한다. ToolSearch 노출 또는 실행 경계가 막히면 `docs/samples/gcp-architect-expand/kcb-scene5-fallback.mp4`를 **사전 녹화 대체본**이라고 밝히고 재생한다. 이 영상은 가짜 GCP 세계의 검증된 제안·산출을 목표 화면 순서로 편집한 재연이며, 실제 classic TUI 통합 실행 영수증으로 제시하지 않는다. 사용자에게 보이는 문면에는 내부 호칭을 넣지 않는다.

대체 영상의 마지막 도면·PDF 장면은 [직접 runGraph 영수증](graph-direct-test-world-receipt.json)의 공용 출력 그래프 산출물이다. 승인 후 가짜 프로젝트·유휴 종료 장면은 별도 fake-world 시뮬레이션이다. 직접 Graph 실행은 지출 승인 대기에서 멈췄다.

`ab56c614` 시험 스택의 실제 classic PTY에서는 짧은 문면이 ToolSearch를 첫 요청에 노출하고 route 검색과 입력창 `y`까지 통과했다. «티켓팅 설계를 바탕으로 …» 문면은 현재 deep-bloom 분기에서 ToolSearch가 빠지므로 라이브 진행에는 쓰지 않는다. 승인 후에는 classic TUI의 `verifiedOwner` 문맥 부재로 그래프가 차단됐다. 이 스택에서 도면·PDF를 같은 PTY 실행으로 만들었다고 말하지 않는다. [실측 영수증](classic-pty-live-ab56-receipt.json)을 참조한다.

## 검증 근거와 전환

- 제안: `sim/sample-output/proposal.json` — 가격 `unpriced`, 공식 가격 문서와 계산식만.
- 가짜 실행: `sim/sample-output/fake-world.json` — 승인 전 차단, 실 GCP 호출 0, 종료 후 활성 lease 0.
- 산출: `sim/sample-output/architecture.excalidraw`, `architecture.png`, `architecture-design.pdf`, `board-attachments.json`.
- 영상 마지막 프레임에서 장면 6으로 넘긴다. 보드의 개발/시험/배포 상태는 ABSORB-3·PWA가 실제 이벤트로 표시해야 한다.
