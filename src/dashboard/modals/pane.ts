// TR-P3: Ctrl+M <key> chord + modal-hint line for the tabletMini /
// tabletTwo compact levels.
//
// When the viewport is too narrow to fit every pane inline, the
// policy marks the overflow as modalDeferred and the dashboard
// renders a tiny hint above the input row: "deferred: Ctrl+M
// p=preview, l=log, c=scratch". The user taps `Ctrl+M` then one of
// the shortcut letters; the dashboard calls openPane(paneId) which
// pops the pane's current render into a transient modal (reusing
// showTransientTerminalModal from VW-P2).
//
// No auto-popup — we surface the option but never steal focus.

import type { KeyEvent } from '../../display/types.js';
import type { PaneFocus, WorkingDirView } from '../../workspace-types.js';
import type { PaneVisibility } from '../../views/pane-policy.js';

export const PANE_MODAL_CHORD_TIMEOUT_MS = 1000;

/** Fixed mapping of PaneFocus → chord body letter. Exported so the
 *  dashboard can iterate when registering each pane's chord binding
 *  against the DisplayCoordinator (FU-1 port). */
export const SHORTCUT_TABLE: Record<PaneFocus, string> = {
  browser: 'b',
  preview: 'p',
  log: 'l',
  scratch: 'c',
  obsidian: 'o',
  input: 'i',
  'skill-browser': 'k',
  'skill-file': 'f',
  // Scheduler view (WorkingDirView 4) chord keys — restored alongside
  // the PaneFocus `scheduler-*` variants in workspace-types.ts.
  'scheduler-board': 'b',
  'scheduler-inspector': 'n',
  'scheduler-paused': 'u',
  'scheduler-active': 'a',
  'scheduler-ready': 'r',
  'scheduler-draft': 'd',
  'agent-roster': 'g',
  'agent-detail': 'e',
  'agent-log': 'L',
  'debug-events': 'E',
  'debug-detail': 'D',
  'debug-stack': 'S',
  'debug-prompts': 'P',
  'sessions-sidebar': 's',
};

/** View-aware widget target for the browser pane. View 3 rebinds the
 *  browser surface to `wd-working-browser`; other views use the
 *  canonical `wd-browser`. Kept as a tiny pure helper so the tablet
 *  modal wiring can follow the same rule and tests can pin it. */
export function browserWidgetInstanceIdForView(view: WorkingDirView): string {
  return view === 3 ? 'wd-working-browser' : 'wd-browser';
}

export function shortcutFor(pane: PaneFocus): string {
  return SHORTCUT_TABLE[pane] ?? pane.charAt(0);
}

/** Resolve a shortcut key to a pane within a candidate set. Returns
 *  null when the key doesn't match any candidate. First-match wins
 *  when multiple panes share a letter (shouldn't happen in the
 *  default table but protects custom views). */
export function paneForShortcut(key: string, candidates: readonly PaneFocus[]): PaneFocus | null {
  const lower = key.toLowerCase();
  for (const pane of candidates) {
    if (shortcutFor(pane).toLowerCase() === lower) return pane;
  }
  return null;
}

// ─── Hint rendering ──────────────────────────────────────────────

/** Render the "deferred panes hint" line. Returns null when the
 *  viewport is wide enough to show everything, or when there are
 *  no deferred panes.
 *
 *  Task 2 · T-3 — when both `browser` and `preview` are in the
 *  deferred list, append a `B=browser+preview` shortcut so the user
 *  discovers the 2×1 pane-multi-modal chord. The capital-B shortcut
 *  is distinct from the lowercase single-pane letters above so the
 *  same chord prefix cleanly dispatches both.
 *
 *  `tabletModeActive` overrides the viewport check — manual `/tablet
 *  on` on a wide terminal should still show the hint so the user
 *  can find the Ctrl+M shortcut set. Default false preserves prior
 *  behaviour. */
export function renderPaneModalHint(
  visibility: PaneVisibility,
  termCols: number,
  tabletModeActive: boolean = false,
): string | null {
  const narrowLevel = visibility.compactLevel === 'tabletMini' || visibility.compactLevel === 'tabletTwo';
  if (!narrowLevel && !tabletModeActive) return null;
  if (visibility.modalDeferred.length === 0) return null;

  const entries = visibility.modalDeferred.map(pane => `${shortcutFor(pane)}=${pane}`);
  // T-3 suffix — surface the 2×1 multi-modal shortcut when both
  // browser and preview are reachable this way. Avoids cluttering
  // the hint in scheduler / debug views where the combo doesn't
  // apply.
  const hasBrowserAndPreview =
    visibility.modalDeferred.includes('browser') &&
    visibility.modalDeferred.includes('preview');
  if (hasBrowserAndPreview) {
    entries.push('B=browser+preview');
  }
  const label = 'Ctrl+M ';
  const prefix = label + entries.join(' ');

  if (prefix.length <= termCols - 2) return prefix;

  // Too wide — truncate with ellipsis.
  const maxBody = Math.max(10, termCols - label.length - 3);
  let acc = '';
  for (const e of entries) {
    const next = acc ? `${acc} ${e}` : e;
    if (next.length > maxBody) {
      acc = acc ? `${acc} …` : `${e} …`;
      break;
    }
    acc = next;
  }
  return label + acc;
}

// ─── Chord state machine ─────────────────────────────────────────

export type PaneModalChordResult = 'passthrough' | 'armed' | 'consumed' | 'cancelled';

export interface PaneModalChordState {
  armed: boolean;
  armedAt: number;
}

export interface PaneModalChordStep {
  deferred: readonly PaneFocus[];
  openPane: (pane: PaneFocus) => void;
}

export interface PaneModalChord {
  readonly state: PaneModalChordState;
  handleKey(ev: KeyEvent, step: PaneModalChordStep): PaneModalChordResult;
  reset(): void;
}

const isPrefix = (ev: KeyEvent): boolean => {
  const n = (ev.name ?? '').toLowerCase();
  // 'ㅡ' is the Korean jamo on the physical `m` key.
  return !!ev.ctrl && (n === 'm' || n === 'ㅡ');
};

export function createPaneModalChord(now: () => number = () => Date.now()): PaneModalChord {
  const state: PaneModalChordState = { armed: false, armedAt: 0 };

  const handleKey = (ev: KeyEvent, step: PaneModalChordStep): PaneModalChordResult => {
    if (state.armed && (now() - state.armedAt) > PANE_MODAL_CHORD_TIMEOUT_MS) {
      state.armed = false;
    }
    if (!state.armed) {
      if (isPrefix(ev)) {
        state.armed = true;
        state.armedAt = now();
        return 'armed';
      }
      return 'passthrough';
    }
    state.armed = false;
    const name = (ev.name ?? '').toLowerCase();
    if (!name) return 'cancelled';
    const pane = paneForShortcut(name, step.deferred);
    if (!pane) return 'cancelled';
    try { step.openPane(pane); } catch { /* swallow to guarantee cancellation */ }
    return 'consumed';
  };

  return {
    state,
    handleKey,
    reset() { state.armed = false; },
  };
}
