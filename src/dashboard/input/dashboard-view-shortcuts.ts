import type { Key } from '../../tui.js';

/**
 * Match global dashboard view-switch shortcuts.
 *
 * Modified-key protocols report `Ctrl+<digit>` as a control key with
 * the digit in `key.name`.
 */
export function matchDashboardViewShortcut(key: Key): string | null {
  if (!key.ctrl || key.shift || key.alt) return null;
  if (/^[1-9]$/.test(key.name)) return key.name;
  return null;
}
