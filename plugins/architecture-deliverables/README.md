# architecture-deliverables

시스템 아키텍처·클라우드 확장 설계의 **공용 출력 계약**이다. 플러그인 manifest의 `outputContract`가 필수 파일, 전문 도식 표기, PDF 구성을 선언하고, Graph v2가 `design → diagram → pdf → verify`를 실행한다. 네 노드는 `architecture.design@1`부터 `architecture.verify@1`까지의 capability 계약을 사용한다. `graphProviders` 선언이 공용 `src/graph-runner/architecture-output` 실행기를 선택하고, 이 실행기가 Excalidraw/CSS/PDF 템플릿을 호출한다. 검증 실패는 `failed`로 간다.

## 구조화 설계 입력 seam

기본 입력은 `structuredDesignPath`가 가리키는 JSON이다. [입력 JSON Schema](references/structured-design.schema.json), [일반 설계 예시](examples/structured-general.json), [티켓팅 GCP 예시](examples/structured-ticketing-gcp.json)를 따른다. `deployment.provider`는 `generic` 또는 `gcp`다. 공용 설계기는 `nodes`의 계층·영역, `flows`의 출발·도착·형식, 요구사항·보안·용량·비용·대안·결정 표를 받아 Excalidraw와 HTML 원고를 생성한다. 일반 모드는 편집 가능한 벡터 도형을, GCP 모드는 공식 아이콘 출처 경로와 해시 검증을 사용한다. `resourceRoot`는 기존 diagram-master 렌더러와 PDF 조판기를 가진 저장소의 절대 경로다.

```sh
elanous graph run plugins/architecture-deliverables/graphs/architecture-deliverables.yaml \
  --input '{"structuredDesignPath":"/ABS/PATH/plugins/architecture-deliverables/examples/structured-ticketing-gcp.json","outDir":"/ABS/PATH/output","resourceRoot":"/ABS/PATH"}' --json
```

`nodes`는 ID·label·layer·zone·service를, `flows`는 from·to·label·kind를 요구한다. `layer`는 users/edge/application/data/observability/security, `zone`은 external/project/vpc, 흐름 형식은 sync/async/telemetry다. 일반 모드에서는 deployment의 project/region/vpc 값을 각각 시스템 범위/영역/네트워크 이름으로 표시한다. 현재 템플릿의 배치는 users·security=external, edge=project, application·data·observability=vpc로 고정한다. 계층별 노드 상한은 2–3개다. GCP 모드의 공식 아이콘은 [출처 레지스트리](references/official-gcp-icons.json)의 `assets` 키와 정확히 일치하는 `icon` 경로로 지정하며 최소 3개가 필요하다. 비용 숫자는 입력의 가정값이며 실제 견적 검증은 별도다.

이미 조판된 자산을 가진 경우에는 [완성 자산 입력 예시](examples/legacy-finished-input.json)의 `designHtmlPath`와 `diagramSourcePath`를 쓰는 기존 경로도 유지한다. 두 입력 모드는 함께 사용할 수 없다.

## GCP 확장 소비자 계약

GCP 확장 플러그인은 제안·용량·비용·보안 판단을 구조화 설계 JSON으로 투영한 뒤 `src/graph-runner/architecture-deliverables.ts`의 `runArchitectureDeliverables({ pluginRoot, structuredDesignPath, outDir, resourceRoot, stateRoot })`를 호출한다. 이 함수가 공용 v2 그래프를 실행하고 검증 영수증을 확인한다. CLI의 `graph run`도 공용 플러그인 manifest를 확인해 같은 provider를 등록한다. 결과가 `done`이고 `verification.json.status=verified`일 때만 Excalidraw·PNG·PDF를 보드 첨부로 넘긴다. GCP 확장 플러그인에는 별도 다이어그램 스타일, 아이콘 바이트, PDF 템플릿, 출력 검증기를 두지 않는다.

기존 `designHtmlPath`·`diagramSourcePath` 입력은 같은 v2 그래프에서 계속 받는다. 실행 그래프와 렌더·조판·검증 구현은 각각 하나다.

| 산출물 | 경로 | 생성·검증 |
|---|---|---|
| 편집 가능한 도식 | `architecture.excalidraw` | `diagram-master` Excalidraw JSON |
| 렌더 | `architecture.png` | 기존 `skills/diagram-master/references/engines/excalidraw/render_excalidraw.py` |
| 편집 가능한 PDF 원고 | `architecture.html` | 배경·요구사항·구성도·데이터 흐름·보안 등급·비용 예측·절감안·대안·결정 기록 |
| 전달 문서 | `architecture.pdf` | 기존 `skills/lecture-note-digitizer/references/convert_to_pdf.py` (Playwright A4) |
| 검증 영수증 | `verification.json` | Excalidraw 구조, PNG/PDF 시그니처, PDF 추출 본문의 9절 확인 |

`designHtmlPath`와 `diagramSourcePath`는 설계자가 만든 **절대 경로**다. `design` 노드는 원고의 필수 절과 Excalidraw 구조를 확인해 `outDir`에 복사한다. 이후 그래프가 기존 렌더·조판 경로를 호출한다. 구조도 자체의 보안·성능 판단과 공급자 견적 검증은 사람의 설계 검토 대상이다. 비용 수치는 입력 원고가 가정과 산식을 밝혀야 한다. 검증기는 PDF에 절이 실제로 인쇄됐는지까지 확인한다.

참조 품질 계약은 사용자·엣지·앱·데이터·관측·보안 계층, 중첩된 시스템/영역/네트워크 경계, 실제 화살표와 번호가 붙은 흐름, 범례, 제목·버전을 요구한다. GCP 모드는 공식 클라우드 아이콘을 Excalidraw 원본에 내장한다. PDF는 표지·목차·요약·본문에 삽입한 도식·표·부록을 **한 파일**에 담는다. 검증기는 이 표기와 PDF 4쪽 이상을 확인한다. 현재 공식 아이콘 영수증은 Google Cloud 공식 core/category 아카이브의 PNG 자산을 출처 경로와 SHA-256으로 검증하는 허용 목록(`references/official-gcp-icons.json`)과 내장 바이트를 대조한다. 계약 범위는 일반 시스템 설계와 GCP 확장이다. 그래프는 별도 staging 디렉터리에서 완성·검증한 결과를 `.architecture-bundles/<generation>`에 보존하고 `.architecture-current` 포인터 하나를 원자적으로 교체한다. 기존 산출물 경로는 이 포인터를 따르는 별칭이다. 영수증을 소비하는 쪽은 `immutableDirectory` 경로의 산출물과 `sha256` 해시를 사용해 같은 세대를 고정해야 한다. 실패한 재실행은 이전 성공 세대를 유지하며 출력 폴더의 다른 파일은 건드리지 않는다. 설치본에서 기존 렌더러 경로를 찾지 못하면 입력 resourceRoot에 저장소 절대 경로를 지정한다. 레이아웃과 아키텍처의 타당성은 시각 검토와 설계 검토가 추가로 필요하다. 품질 비교 기준은 [Google Cloud 공식 아이콘](https://cloud.google.com/icons) 및 [AWS 공식 참조 다이어그램](https://docs.aws.amazon.com/reference-architecture-diagrams/)이다.

## 두 샘플 실행

```sh
elanous graph run plugins/architecture-deliverables/graphs/architecture-deliverables.yaml \
  --input '{"designHtmlPath":"/ABS/PATH/docs/samples/architecture-deliverables/cloud-sim/architecture.html","diagramSourcePath":"/ABS/PATH/docs/samples/architecture-deliverables/cloud-sim/architecture.excalidraw","outDir":"/tmp/architecture-deliverables-cloud-sim","resourceRoot":"/ABS/PATH"}' --json
```

`/ABS/PATH`는 저장소 절대 경로로 바꾼다. [클라우드 확장 샘플](../../docs/samples/architecture-deliverables/cloud-sim/architecture.pdf)은 v2 참조 품질 계약을 통과한 7쪽 통합 문서다. [티켓팅 RFC 샘플](../../docs/samples/architecture-deliverables/ticketing/architecture.pdf)은 이전 v1 계약 산출을 보존한 것으로 새 품질 기준의 합격 사례로 세지 않는다. 두 샘플의 비용은 가상 단가이며 실제 견적·운영 성능으로 주장하지 않는다. 티켓팅 근거는 [영상 RFC](../../내부 문서 `RFC-ticketing-from-video-1110`)다. 샘플 바이너리는 플러그인 보안 스캔이 읽는 패키지 밖의 `docs/samples/`에 둔다.

첫 도면·PDF 실행은 `skills/diagram-master/references`에서 `uv sync --extra python-engines`와 `uv run --extra python-engines playwright install chromium`을 자동 실행한다. `uv` 또는 설치 자원이 없으면 실행을 중단하고 같은 수동 명령을 한 줄로 안내한다. `render_template.html`의 Excalidraw ESM import는 확인된 `0.18.0`으로 고정했다.

[11-16 Solar Pro 4 티켓팅·GCP 확장 시뮬레이션](../../docs/samples/architecture-deliverables/solar-ticketing-gcp/architecture.pdf)은 같은 v2 형식의 6쪽 통합 PDF와 편집 원본·PNG·검증 영수증을 갖는다. `provenance.json`은 Solar 응답 세션과 해시를 기록한다. 세 줄 첫 답변의 도메인 팩 A/B 점수는 14/44·35/44이며, GCP 확장·비용 숫자는 같은 Solar 세션의 후속 턴에서 받았다. 비용은 가상 단가로 교정·검산한 값이다.
