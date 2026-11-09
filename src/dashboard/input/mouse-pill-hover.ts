import { pillAtColumn, type PillBound, type PillName } from '../../status/pills.js';
import type { HoverTarget } from '../../ui/hover-tracker.js';

/** IDX-5 Phase 1 — default pill tooltip map. Explained to the user:
 *  what the pill IS, what clicking IT DOES. Terse (single line)
 *  because Tooltip widget paints as `▕ text` — no wrap. */
export const DEFAULT_PILL_TOOLTIPS: Readonly<Record<PillName, string>> = {
  workingDir: 'Working directory — click to switch to a recent cwd',
  model: 'Active model — click to pick from rotation',
  mode: 'Operating mode — click to switch (general / sync / control)',
  shellRollup: 'Shell handles — click to attach or inspect',
  virtualWindow: 'Virtual window — click to open window picker',
  workspaceDock: 'Parked windows — click to inspect docked or dormant entries',
  conversationPopup: 'Conversation popups — click to focus or restore',
  acpSending: 'ACP sticky send — click to inspect in-flight ACP surface state',
};

/** IDX-5 Phase 1 — compute the HoverTarget for a mouse position over
 *  the status-bar row. `statusRow` and `row` are 1-indexed (matches
 *  DisplayMouseEvent.row). Returns null for anything outside the
 *  status bar, including the neighbouring row. Exported for tests. */
export function pillHoverTarget(
  pills: readonly PillBound[],
  statusRow: number | null,
  row: number,
  col: number,
  tooltipFor: (name: PillName) => string | null = (n) => DEFAULT_PILL_TOOLTIPS[n] ?? null,
): HoverTarget | null {
  if (statusRow === null) return null;
  // Accept status row exact or one-above — matches the click tolerance
  // (see openPillPopup's nearStatusRow rule). Avoids flicker when the
  // visual top edge of a pill cell emits row-1.
  if (row !== statusRow && row !== statusRow - 1) return null;
  const col0 = col - 1;
  const hit = pillAtColumn(pills, col0);
  if (!hit) return null;
  const tt = tooltipFor(hit.name);
  return {
    id: `pill:${hit.name}`,
    kind: 'status-bar-pill',
    tooltipText: tt ?? undefined,
  };
}

