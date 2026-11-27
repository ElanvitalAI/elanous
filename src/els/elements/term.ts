// ELS-POPUP-TERM (대표 11-26 18:5x «팝업 터미널») — the popup terminal as an overlay element: a real PTY shell running in a
// floating box above the panes (a scratch terminal / quake console). The PTY is an ordinary els pane — spawned through the
// server's PTY holder like every pane — kept in the reserved workspace POPUP_WS, which the attach view never lists. The
// layer only names that pane; the attach app (popup-term-client.ts) attaches to it, draws its screen inside the box, sends
// keys to it while the layer has focus and resizes it to the box. Ideas copied from classic (8/31 export):
// interactive-terminal-modal.ts (PTY in a modal, keys to the PTY, hide keeps the process) and terminal-popup-runtime.ts
// (/claude · /codex · /setup popups). src/dashboard is NOT imported (retired).
//
// Props carry a pane id at most — never a command: a layer opened by a tool can show a shell to the person, it can never
// choose what runs (a chosen command goes through `els term -- <cmd>`, i.e. the normal `new` door).

import type { ElementDef } from './element.js';
import { frameRows } from '../overlay-compose.js';

/** The reserved workspace that holds popup terminal panes (hidden from the side list, tabs and tiles). */
export const POPUP_WS = 'els-popup';
const PANE_ID = /^p[0-9a-z]{4,40}$/;

export interface TermProps {
  /** The popup pane (in POPUP_WS); absent = the attach app makes or reuses one, then sets it. */
  readonly pane?: string;
}

export function termProps(raw: unknown): TermProps | undefined {
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) return undefined;
  const value = (raw ?? {}) as Record<string, unknown>;
  if (value.pane === undefined) return {};
  return typeof value.pane === 'string' && PANE_ID.test(value.pane) ? { pane: value.pane } : undefined;
}

export const term: ElementDef<TermProps> = {
  kind: 'term',
  // popup band: above floats (files · Obsidian), below modals and toasts. pin all: a quake console follows every space.
  defaults: { band: 'popup', focus: 'owns', pin: 'all' },
  // popup and tile draw the live PTY in this view; a tab is the real pane itself (ctrl+b m docks it) — no host-pane copy.
  frames: ['popup', 'tile'],
  props: (raw) => termProps(raw),
  // Server side, atomic: no pane yet → the server's popup pane (reused or a fresh $SHELL). A client without it materializes.
  hydrate: (props, context) => { if (props.pane) return props; const pane = context.popupPane?.(); return pane ? { pane } : props; },
  rect: () => ({ anchor: 'top', w: '96%', h: '60%', dy: 1 }),
  // The live screen is drawn by the attach app (it holds the PTY stream); this is what a viewer without it shows.
  render: (props, size) => frameRows(' ⌨ Terminal ', [props.pane ? ' connecting…' : ' starting a shell…'], size),
};
