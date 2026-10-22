# 골 수용선 검증 메뉴

S: 골의 수용선은 실행 경로·시뮬레이션·운영 사건 등 서로 다른 주장을 담는다. C: 방법 이름만 고르면 증거가 그 주장을 뒷받침하지 않을 수 있다. Q: 수용선마다 어떤 검증을 선택해야 하나? A: 아래 표에서 **증명할 주장과 실제 입력 경계**를 먼저 맞춘 뒤 방법 하나 이상을 고른다. 표는 안내이며 골 발사를 막는 관문이 아니다.

드물거나 만들기 어려운 사건 무대는 저장소 정본 [`04-mock-scenarios.md`](04-mock-scenarios.md)에서 고른다. 기존 무대가 검증 경계와 맞지 않으면 그 문서의 카탈로그 빈칸을 가리키고 새 무대를 제안한다.

| 방법 | 무엇을 증명하나 | 언제 고르나 | 재는 명령 한 줄 | 무대 예 | 정본 |
|---|---|---|---|---|---|
| test 우주 `--test` CLI 실행 | 지정한 CLI 명령이 격리 test 인스턴스에서 실행되고, 그 명령의 수용 결과를 내는가; 한 명령 시험은 다른 CLI 진입점·운영 설정·TUI/PTY 계약을 증명하지 않는다 | CLI 명령 자체가 수용선일 때. 설정 격리는 대상 명령의 실제 읽기/쓰기 경계를 별도로 확인한다; TUI/PTY는 라이브 확인을 고른다 | `bun bin/elanous.mjs --test <CLI 명령> <인자>` | [MS-01](04-mock-scenarios.md#ms-01) · [MS-02](04-mock-scenarios.md#ms-02) · [MS-03](04-mock-scenarios.md#ms-03) — 해당 골에서 실제 `--test` 생산 명령을 특정한 경우 | [UX 시뮬레이션 장치](../manual/MANUAL-ux-simulation-devices-2026-08-23.md) §1·§3; [라이브 확인 사다리](../manual/MANUAL-live-verification-agent-l2-l3-2026-07-26.md) |
| `src/ux-sim` 시뮬레이션 | 실제 함수·위젯 렌더 경로가 고정 입력에서 어떤 상태·화면을 만드는가 | 결정적 함수 경계나 반복 비용이 큰 상호작용 상태를 잴 때 | `bun test -- 'src/ux-sim/<관련 시험 파일>.test.ts'` | [카탈로그 빈칸: ux-sim](04-mock-scenarios.md#catalog-gaps) | [UX 시뮬레이션 장치](../manual/MANUAL-ux-simulation-devices-2026-08-23.md) §1·§2 |
| mock 시나리오 | 드문 오류·만료·네트워크 사건에서 허용한 실제 경로가 기대 화면·로그·증거를 내는가 | 자연 발생을 기다리기 어렵고 시나리오 trigger가 해당 실패 경계를 대표할 때 | `bun bin/elanous.mjs --test sim run scenarios/ux-sim/provider-4xx-no-provider.yaml` | [카탈로그 빈칸: CLI sim run](04-mock-scenarios.md#cli-sim-run-gap) | [UX 시뮬레이션 장치](../manual/MANUAL-ux-simulation-devices-2026-08-23.md) §1·§4 |
| Docker 격리, node-b 이미지 pin | node-b에서 고정한 컨테이너 이미지로 현재 checkout을 mount해 실제 명령이 재현되는가 | 컨테이너 경계·도구 설치·이미지 차이가 수용선의 입력일 때; mount된 checkout이 검증 대상 소스임을 확인 | `docker run --rm -v "$PWD:/work" -w /work <이미지>@sha256:<고정 digest> <검증 명령>` | [카탈로그 빈칸: Docker](04-mock-scenarios.md#catalog-gaps) | [세션 빠른 길](../manual/MANUAL-seat-agent-quickstart-2026-10-12.md) §변경 범위 게이트; 실제 이미지·digest는 목표/실행 환경에서 고정 |
| `eln logs` / `debug.log` 관측 | 지정 인스턴스에 실행 이벤트가 보존됐는가; 결과의 instance 값을 목표 인스턴스와 대조한다 | 로그 방출·도달·상태 전이가 수용선일 때; 함수 호출만으로 도달을 주장하지 않을 때 | `eln logs --instance <prod-or-test:repo> --exact-category <category> --event <event> --since 30m --limit 20 --json --json-data` | [카탈로그 빈칸: 로그 관측](04-mock-scenarios.md#catalog-gaps) | [관측 방법론](../manual/MANUAL-observation-methodology-2026-07-26.md) §1·§6; [라이브 확인 사다리](../manual/MANUAL-live-verification-agent-l2-l3-2026-07-26.md) |
| 열차 사이드 gate | PR 변경 집합이 지정 gate 호스트에서 통합 기준선과 함께 검사되는가 | PR 변경 파일의 통합 회귀·원격 substrate 결과가 수용 조건일 때 | `eln self gate --changed --base origin/main --remote node-b` | [카탈로그 빈칸: 사이드 gate](04-mock-scenarios.md#catalog-gaps) | [세션 빠른 길](../manual/MANUAL-seat-agent-quickstart-2026-10-12.md) §변경 범위 게이트 |
| 운영 실물 로그 관측 | 운영 인스턴스에서 지정 사건 로그가 run ID와 함께 보존됐는가; 로그만으로 인과나 사용자 영향까지 증명하지는 않는다 | 운영 데이터·사건이 동작의 입력이고, 실제 입력과 결과에 공통 run ID/상관 키가 있을 때 | `eln logs --instance prod --category <category> --event <event> --grep <runId> --since 30m --limit 20 --json --json-data` | [카탈로그 빈칸: 운영 실물](04-mock-scenarios.md#catalog-gaps) | [TUI 라이브 검증](../manual/MANUAL-tui-live-verification-2026-08-03.md) §4; [관측 방법론](../manual/MANUAL-observation-methodology-2026-07-26.md) |

## 선택 원칙

- 운영 실물은 **운영 데이터·사건이 동작의 입력일 때만** 고른다. 시험 우주에서 같은 입력을 만들 수 있으면 먼저 격리 경로를 쓴다. 로그 조회는 사건의 보존만 증명하므로, 실제 입력과 결과의 연결은 run ID/상관 키를 따라 별도로 확인한다.
- 시뮬레이션은 실제 함수/렌더 경계의 동작을 증명할 수 있지만, 그 코드가 실제 실행 경로에 연결됐다는 사실까지 증명하지는 않는다. 필요하면 test 우주 CLI 경로를 짝으로 둔다. 위 `sim run` 명령은 CLI 시나리오 경로를 재생하며 TUI/PTY 실행을 뜻하지 않는다.
- 로그는 호출 여부와 저장소 도달 여부를 구분한다. 범주·이벤트·인스턴스·시간 창을 수용선에 적고, 조회 결과의 instance 값을 확인한다. 입력과 결과를 상관 지을 때는 동일 run ID/상관 키를 가진 양쪽 이벤트를 각각 확인한다.
- Docker digest와 운영 대상은 골 또는 실행 계획에서 실제 값으로 고정한다. 자리표시자 명령을 실행 증거로 세지 않는다.
- **merge SHA와 타입검사는 수용선이 아니다.** 각각 통합 이력과 정적 타입 상태의 근거일 뿐, 요구 동작을 증명하는 검증 방법을 대신하지 않는다.
- 빈 검증 결과도 골 발사를 막지 않는다. 무엇을 재지 못했는지 명시하고 발사 뒤 관측·판단 근거로 남긴다.
