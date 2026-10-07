// WT-X-1 — ANSI escape sequence builder for the mobile modifier bar.
//
// Pure functions only — no React, no globals. Given a logical key
// (Esc / Tab / Shift+Enter / arrow / Page Up / Page Down) plus an optional modifier state (Ctrl / Alt),
// produce the byte sequence iPad PWA users expect when typing on a
// physical keyboard.
//
// Why a separate module: keeping the sequence map declarative makes
// it trivial to (1) unit-test against the xterm/VT220 reference,
// (2) extend with F-keys later, and
// (3) reuse from any future caller (voice macro · skill · ⌘K
// palette) without dragging the React component along.
//
// Reference: xterm `modifyOtherKeys` v2 + VT220 control sequences
// summarised at https://invisible-island.net/xterm/ctlseqs/ctlseqs.html
// CSI mod numbers (used as the second param after `\x1b[1;`):
//   2 = Shift · 3 = Alt · 4 = Shift+Alt · 5 = Ctrl ·
//   6 = Shift+Ctrl · 7 = Alt+Ctrl · 8 = Shift+Alt+Ctrl

export type ModifierKey = 'esc' | 'tab' | 'shift-enter' | 'up' | 'down' | 'left' | 'right' | 'pageup' | 'pagedown';

export interface ModifierState {
  ctrl: boolean;
  alt: boolean;
}

/** No modifiers active — useful as a default. */
export const NO_MODIFIERS: ModifierState = { ctrl: false, alt: false };

/** Compute the CSI modifier number from a state. Returns null when
 *  no modifier is active (caller should emit the bare CSI form, e.g.
 *  `\x1b[A` for Up rather than `\x1b[1;1A`). Mirrors xterm's encoding. */
function csiModifier(state: ModifierState): number | null {
  if (!state.ctrl && !state.alt) return null;
  // Per xterm: mod = 1 + (shift?1:0) + (alt?2:0) + (ctrl?4:0)
  // We omit Shift in the v1 button set so the lookup is a straight
  // boolean OR of Ctrl(+4) / Alt(+2). Final value is `1 + mods`.
  let mods = 0;
  if (state.alt) mods += 2;
  if (state.ctrl) mods += 4;
  return 1 + mods;
}

const ARROW_FINAL: Record<'up' | 'down' | 'left' | 'right', string> = {
  up: 'A',
  down: 'B',
  right: 'C',
  left: 'D',
};

/** Build the byte sequence sent to the daemon's terminal/input ACP
 *  method. Returns a plain string; the caller passes it as `data`
 *  alongside sessionId/terminalId/peerId.
 *
 *  Behaviour matrix (v1):
 *  - Esc: `\x1b` plain · `\x1b\x1b` with Alt · Ctrl ignored (Ctrl+Esc
 *    has no standard mapping; passthrough as plain Esc).
 *  - Tab: `\x09` plain · `\x1b\x09` with Alt · Ctrl ignored (Ctrl+Tab
 *    is browser-reserved; Ctrl+I is just Tab itself anyway).
 *  - Shift+Enter: `\x1b\r` (ESC CR) regardless of Ctrl/Alt.
 *  - Page Up/Down: `\x1b[5~` / `\x1b[6~` plain · CSI modifier when active.
 *  - Arrows: `\x1b[A/B/C/D` plain · `\x1b[1;<mod>A/B/C/D` with any
 *    modifier (Ctrl=5, Alt=3, Ctrl+Alt=7).
 */
export function buildKeySequence(key: ModifierKey, modifiers: ModifierState = NO_MODIFIERS): string {
  switch (key) {
    case 'esc':
      // Alt+Esc → ESC ESC (xterm convention). Ctrl+Esc has no widely-
      // supported mapping; degrade gracefully to plain Esc.
      return modifiers.alt ? '\x1b\x1b' : '\x1b';
    case 'tab':
      return modifiers.alt ? '\x1b\x09' : '\x09';
    case 'shift-enter':
      // Shift+Enter → newline without submit (ESC CR); Ctrl/Alt do not change it.
      return '\x1b\r';
    case 'pageup':
    case 'pagedown': {
      const number = key === 'pageup' ? 5 : 6;
      const mod = csiModifier(modifiers);
      return mod === null ? `\x1b[${number}~` : `\x1b[${number};${mod}~`;
    }
    case 'up':
    case 'down':
    case 'left':
    case 'right': {
      const final = ARROW_FINAL[key];
      const mod = csiModifier(modifiers);
      return mod === null ? `\x1b[${final}` : `\x1b[1;${mod}${final}`;
    }
  }
}

/** Only a single typed character can take a software Ctrl/Alt toggle;
 *  focus reports, escape sequences and pastes pass through untouched. */
export function canApplyStickyModifiers(data: string): boolean {
  return data.length === 1;
}

/** Apply a software Ctrl/Alt toggle only to a single typed character. */
export function applyStickyModifiers(data: string, mods: ModifierState): string {
  if (!canApplyStickyModifiers(data)) return data;
  const code = data.toUpperCase().charCodeAt(0);
  const transformed = mods.ctrl && code >= 64 && code <= 95
    ? String.fromCharCode(code - 64)
    : data;
  return mods.alt ? `\x1b${transformed}` : transformed;
}

/** Subset of keys that are themselves modifiers — used by the UI to
 *  decide whether a button click should toggle state vs trigger a
 *  send + auto-release of any active modifiers. */
export type ModifierToggleKey = 'ctrl' | 'alt';

export function isModifierToggleKey(k: string): k is ModifierToggleKey {
  return k === 'ctrl' || k === 'alt';
}
