/** ⛔⭐⭐⭐ NEXUS 데몬과 PWA 가 «공유하는» REST 경로 계약. **이 잎은 import-free 로 남는다.**
 *
 *  ## 왜 이 파일이 있나
 *
 *  📏 2026-08-22 실측(16차 `[F]`): 15차가 세운 자(`scripts/f12-sweep.ts --bucket-b`)의
 *  **희소성 상위 다섯이 전부 라우트 경로**였다 — 데몬이 상수로 «선언»한 경로를
 *  다른 파일이 ***문자열로 베껴*** 쓰고 있었다.
 *
 *  ```
 *  apps/pwa/src/lib/devices-api.ts          '/v1/devices'                ↔ DEVICES_PATH
 *  apps/pwa/src/lib/idle-nudge-api.ts       '/v1/idle-nudge/preview'     ↔ IDLE_NUDGE_PATH
 *  apps/pwa/src/lib/morning-showroom-api.ts '/v1/morning-digest/showroom'↔ MORNING_SHOWROOM_PATH
 *  apps/pwa/src/lib/fluent-chain-api.ts     '/v1/next-fluent/dispatch'   ↔ NEXT_FLUENT_DISPATCH_PATH
 *  src/nexus/api/http-server.ts             '/v1/dist/manifest.plist'    ↔ MANIFEST_PATH   ← 데몬 «안»에서
 *  ```
 *
 *  ⛔ **갈리면 조용하다.** 한쪽만 바꾸면 타입도 시험도 안 깨지고 «404 로만» 드러난다.
 *  📏 16차에 그 부류(같은 계약이 여러 자리에 베껴져 하나만 자란 것)가 ***두 번 실제 결함이었다***:
 *    `#11050` — 배달 상태 union 이 네 자리에 각자 있었고 하나가 안 따라와 **PWA 빌드가 멈췄다**.
 *    `#11061` — 위젯 블록을 만드는 자리가 셋인데 결과를 싣는 곳이 둘이라 **위젯이 비어 있었다**.
 *  ⇒ 그래서 이번엔 «터지기 전에» 접는다.
 *
 *  ## ⛔ 왜 `devices.ts` 같은 구현 모듈에서 직접 import 하지 않나
 *
 *  브라우저가 그것을 import 하면 ***데몬 그래프를 통째로 번들에 끌어온다***.
 *  15차가 같은 이유로 `src/tool-runtime/mcp-route-path.ts` 를 «잎»으로 세웠고,
 *  이 파일은 그 선례를 그대로 따른다 — ⛔ **여기에 어떤 import 도 추가하지 마라.**
 *
 *  🔎 이 계약이 다시 갈렸는지 재는 명령:
 *  ```bash
 *  bun run scripts/f12-sweep.ts --bucket-b | grep -E "scarcest|/v1/"
 *  bun test test/rest-route-paths-single-home.test.ts
 *  ``` */

/** `GET /v1/devices` — 디바이스 함대 스냅샷. */
export const DEVICES_PATH = '/v1/devices';

/** Owner-only idea PR review and merge. */
export const APPROVALS_MERGES_PATH = '/v1/approvals/merges';

/** `POST /v1/templates/capability-preview` — 템플릿 능력 미리보기.
 *  📏 이 여섯째는 앞 다섯을 접자 «자가 곧바로 다음 후보로 올려 준 것»이다 — 같은 부류라 같이 접었다. */
export const TEMPLATE_CAPABILITY_PREVIEW_PATH = '/v1/templates/capability-preview';

/** `GET /v1/dist/manifest.plist` — iOS OTA 설치 매니페스트(사람이 사파리로 연다). */
export const MANIFEST_PATH = '/v1/dist/manifest.plist';

/** `/v1/dist/` — OTA 배포 접두. 설치 페이지(`/v1/dist/` · `/v1/dist/install`)와
 *  IPA 스트림(`/v1/dist/<파일>.ipa`)이 «같은» 접두로 갈린다.
 *
 *  📏 2026-08-22 실측: 이 값이 `dist.ts` 에 선언돼 있는데 ***`http-server.ts` 의 디스패처가
 *  세 자리에서 문자열로 베끼고 있었다*** — `#11096` 이 접은 것과 «같은 파일·같은 형태»다.
 *  ⇒ 자(`f12-sweep --bucket-b`)가 접은 뒤 이 값을 **희소성 1위**로 올려 줬다. */
export const IPA_PATH_PREFIX = '/v1/dist/';

/** `POST /v1/idle-nudge/preview` — 유휴 넛지 미리보기. */
export const IDLE_NUDGE_PATH = '/v1/idle-nudge/preview';

/** `POST /v1/morning-digest/showroom` — 아침 쇼룸. */
export const MORNING_SHOWROOM_PATH = '/v1/morning-digest/showroom';

/** `POST /v1/next-fluent/dispatch` — 칩 1-클릭 액션 실행. */
export const NEXT_FLUENT_DISPATCH_PATH = '/v1/next-fluent/dispatch';
