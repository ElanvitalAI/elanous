// ── 렌더 카테고리 SSOT (OH9 · 2026-07-24) ────────────────────────────────
//
// `debug.log(category, …)` 의 카테고리 중 "렌더/입력 프레임 노이즈"에 해당하는
// 것들을 판정하는 **단일 진실원(SSOT)**. OH9 "렌더 로그 2층"이 요구하는
// 두 소비처가 이 정의를 공유한다:
//
//   1. 발화 게이트 — `src/debug/log.ts` 의 `log()` 진입부. `_renderSuppressed`
//      가 켜지면 렌더 카테고리는 모든 싱크(file/store/mirror/ring)에서 무음.
//      진단 강도 축(`debug.enabled` = mirror||verbose||diag||keytrace)과 **직교** —
//      대표는 상시 diag+ 로 운용하므로 "진단은 켜두고 렌더만 끄는" 별도 스위치.
//   2. 조회 넛지 — `src/cli/logs-cli.ts` 의 `renderGatedHint()`. 렌더 카테고리를
//      조회하면 "기본 OFF 게이트라 빈 결과가 정상일 수 있다"고 안내(INCIDENT
//      #5277 오진 재발 방지). 발화 게이트와 같은 집합을 봐야 힌트가 정직하다.
//
// 대상 카테고리(PLAN §4.2 라인 306-317 전수·대분류):
//   dashboard.*(draw · frame-compose · chat.stream · host-chrome · …) ·
//   cursor.*(cursor.coordinator.*) · key.* · mouse.* · input-core.* · vw.* ·
//   pane.* · modal.* · chat.*Picker/chat.picker.*/chat.input.*/chat.modal.*/
//   chat.global.*/chat.chord · iul.* · hud.* · layout.persistence.* ·
//   surface.registry.* · voice.auto-tts(+voice.toggle.*/voice.chat.*) ·
//   acp.broadcast · llm.tool-exposure · ux.render/ux.event(+ux.render.telegram) ·
//   draw/render · log.buffer.trim/log.wheel
//
// ⚠️ 제외(PLAN 명시):
//   - `input.submit` — 렌더가 아니라 **턴 시작 신호**. `input-core.*` 는 포함하되
//     `input.*`(input.submit 등)는 건드리지 않는다.
//   - `acp.stream` — PLAN §4.2 목록에 명시 없음 → **보수적 제외**. acp.broadcast 만
//     렌더로 본다(스트림 델타는 대화 콘텐츠일 수 있어 무음이 위험).

/** exact-or-dotted-prefix 로 매칭되는 렌더 네임스페이스.
 *  `cat === p || cat.startsWith(p + '.')` — 순수 네임스페이스 접두. */
export const RENDER_CATEGORY_PREFIXES: readonly string[] = [
  'dashboard',        // draw · frame-compose · chat.stream · host-chrome · dock.chrome · masks …
  'cursor',           // cursor.coordinator.* 포함(전 cursor.*)
  'key',              // key.* (key.trace.* 포함 — keytrace firehose 도 렌더 축)
  'mouse',
  'input-core',       // ⚠️ input.* (input.submit) 아님 — input-core 만
  'vw',
  'pane',
  'modal',
  'iul',
  'hud',
  'draw',
  'render',
  'layout.persistence',
  'surface.registry',
  'ux.render',        // ux.render · ux.render.telegram
  'ux.event',
  'voice.toggle',     // voice.toggle.*
  'voice.chat',       // voice.chat.*
  'chat.picker',      // chat.picker.*
  'chat.input',       // chat.input.*
  'chat.modal',       // chat.modal.*
  'chat.global',      // chat.global.*
];

/** 정확 일치 렌더 카테고리(접두가 아니라 이 이름 자체). */
export const RENDER_CATEGORY_EXACT: ReadonlySet<string> = new Set([
  'acp.broadcast',
  'llm.tool-exposure',
  'voice.auto-tts',   // 33건·빈도 3위
  'log.buffer.trim',
  'log.wheel',
  'chat.chord',
]);

/**
 * Render suppression exemptions. Every entry needs a reason because this list
 * overrides the broad render namespaces above and must remain auditable.
 */
export const RENDER_CATEGORY_EXEMPTIONS: ReadonlyMap<string, string> = new Map([
  ['dashboard.setWorkingFocus', 'Focus-transition decisions explain who moved focus and why.'],
  // ⛔⭐⭐⭐ 2026-08-19 (`OBS-T128`) — 이 둘은 «렌더 소음»이 아니라 ***턴 제어 판정 이벤트***다.
  //   🚨 값비싼 이력: 「스트리밍 중 친 발화가 큐에 안 쌓인다」를 조사하며 «판정용 프로브»를 새로 만들었는데,
  //     그 프로브가 하필 `dashboard.*` 라 여기에서 함께 음소거됐다. 그 「0」 위에서
  //     ***네 개의 관측 항목(`OBS-T124`~`T127`)과 세 창이 틀린 결론으로 움직였다.***
  //     반증은 로그가 아니라 «화면»이 냈다 — 큐 표시가 실제로 그려지고 있었다.
  //   📌 교훈: ***판정 프로브를 판정 «대상»과 같은 네임스페이스에 두면, 대상을 끄는 스위치가 자를 같이 끈다.***
  //   ⛔ 접두 전체(`dashboard`)를 풀지 «않는다» — 그러면 진짜 렌더 소음이 되살아난다. 이 둘만 뗀다.
  ['dashboard.turn-typeahead', 'Mid-turn input queueing decisions — which key was consumed, what was queued, and when it drains. Turn-control judgment, not frame noise.'],
  ['dashboard.streaming-key', 'Streaming-window key ownership — whether a key reached the streaming dispatcher at all. This is the probe that answers "is the ladder live?", so it must survive render mute.'],
  // ⛔ 2026-10-17 (`TUI-H8-SEAT-BOOT-LOG-MUTED`) — 자리 부트 카드는 «항상성» 이벤트다(렌더 소음 아님).
  //   `/session new` 뒤 카드가 실렸는지를 `logs --all --include-test` 로도 0행으로 만들어
  //   «카드가 빠졌다»와 «음소거됐다»를 가를 수 없었다. 접두 전체는 풀지 않고 이것만 뗀다.
  //   (`tui.autoturn`·`tui.wakeup`·`tui.autowake` 는 `tui` 가 렌더 접두가 아니라 애초에 안 잘린다.)
  ['dashboard.seat-boot', 'Seat boot card lifecycle — conversation-start, card-injected, card-skipped. Homeostasis evidence that the seat card reached the turn, not frame noise.'],
]);

/** Reject an exemption without its required, human-readable rationale. */
export function assertRenderCategoryExemptions(exemptions: ReadonlyMap<string, string>): void {
  for (const [category, reason] of exemptions) {
    if (category.trim().length === 0 || reason.trim().length === 0) {
      throw new Error(`Render category exemption requires a reason: ${category || '(empty category)'}`);
    }
  }
}

assertRenderCategoryExemptions(RENDER_CATEGORY_EXEMPTIONS);

/** 동적 카테고리 — `chat.update${kind}Picker`(chat/pickers/modal-runtime.ts) 등
 *  `chat.*Picker` 접미. 정적 접두로는 못 잡아 별도 정규식. */
const CHAT_PICKER_SUFFIX_RE = /^chat\..*Picker$/;

/** 조회면·조회 넛지에 노출할 대표 렌더 접두(하위 집합 — UX 문구용).
 *  게이트는 `isRenderCategory` 를 쓰고, 이건 힌트 문자열의 예시 접두일 뿐. */
export const RENDER_ORIENTED_PREFIXES: readonly string[] = [
  'key', 'mouse', 'cursor', 'dashboard', 'draw', 'render',
];

/** 이 카테고리가 렌더/입력 프레임 노이즈인가 — 발화 게이트·조회 넛지 공용 판정. */
export function isRenderCategory(category: string): boolean {
  const c = category.trim();
  if (c.length === 0) return false;
  for (const exemptCategory of RENDER_CATEGORY_EXEMPTIONS.keys()) {
    if (c === exemptCategory || c.startsWith(`${exemptCategory}.`)) return false;
  }
  if (RENDER_CATEGORY_EXACT.has(c)) return true;
  if (CHAT_PICKER_SUFFIX_RE.test(c)) return true;
  for (const p of RENDER_CATEGORY_PREFIXES) {
    if (c === p || c.startsWith(`${p}.`)) return true;
  }
  return false;
}
