// PLAN-chat-hud-multi-surface-port-2026-05-13 §4 M5 — source-side wires
// that push the existing `renderTokenGauge` + `renderVariantBadge`
// values into HUD segments so the M3 mirror can forward them and the
// PWA M4 renderer can render the gauge bar + variant chip.
//
// Pre-M5 state: both renderers existed (`src/chat/hud-render.ts`) but
// were used only by the TUI chat header line — never landed on the HUD
// strip, never reached the PWA. M5 closes that loop with one
// `setSegment` call each, idempotent via the dedupe added to
// `panes/hud.ts setSegment`.
//
// Keys + priorities are constants so M3 mirror tests + PWA renderer
// tests can lock the contract.

import {
  setSegment,
  clearSegment,
  type HudState,
} from '../panes/hud.js';
import {
  renderTokenGauge,
  renderVariantBadge,
  type VariantBadgeInput,
} from './hud-render.js';
import type { ChatRenderingHudConfig } from '../user-config/chat.js';

/** HUD key for the token context-fill gauge. PWA `<ChatHud>` recognises
 *  this key as a gauge-bar candidate (M4 `GAUGE_KEYS`). */
export const TOKEN_GAUGE_SEGMENT_KEY = 'token-gauge';

/** Priority puts the gauge to the right of variant + workspace but to
 *  the left of the agent-activity badge — matches the Claude Code
 *  reference image (§3.3) row order. */
export const TOKEN_GAUGE_SEGMENT_PRIORITY = 5;

/** HUD key for the system-prompt variant badge. */
export const VARIANT_SEGMENT_KEY = 'variant';

/** Priority 1 = leftmost — variant + provider identification reads
 *  first in the TUI HUD line. */
export const VARIANT_SEGMENT_PRIORITY = 1;

/** Push (or clear when context budget is unknown) the token gauge
 *  segment. Idempotent: panes/hud.ts setSegment dedupes deep-equal
 *  writes so this is safe to call on every redraw. */
export function setTokenGaugeSegment(
  hud: HudState,
  used: number,
  max: number,
  cfg: Pick<ChatRenderingHudConfig, 'gaugeWarnRatio' | 'gaugeDangerRatio'>,
): void {
  if (!Number.isFinite(used) || !Number.isFinite(max) || max <= 0) {
    clearSegment(hud, TOKEN_GAUGE_SEGMENT_KEY);
    return;
  }
  const value = renderTokenGauge(used, max, cfg);
  setSegment(hud, TOKEN_GAUGE_SEGMENT_KEY, value, TOKEN_GAUGE_SEGMENT_PRIORITY);
}

/** Push the system-prompt variant badge segment. Same idempotency as
 *  `setTokenGaugeSegment`. */
export function setVariantBadgeSegment(
  hud: HudState,
  input: VariantBadgeInput,
): void {
  const value = renderVariantBadge(input);
  setSegment(hud, VARIANT_SEGMENT_KEY, value, VARIANT_SEGMENT_PRIORITY);
}
