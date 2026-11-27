// ELS-RUNTIME-ADAPTERS — the fallback: a shell (or any program els does not know). Not an attach target (no agent reads
// its input line); insertText pastes text, interrupt = ctrl+c.

import { executableOf, pathOps, statusFromScreen, textOps } from './common.js';
import type { RuntimeAdapter, ScreenRules } from './types.js';

export const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'fish', 'nu', 'pwsh', 'dash', 'ksh', 'tcsh', 'csh']);
const screen: ScreenRules = { busy: [] };

export const shellAdapter: RuntimeAdapter = {
  id: 'shell',
  detect: (pane) => SHELLS.has(executableOf(pane.cmdline)),
  screen,
  status: (text, exited) => statusFromScreen(screen, text, exited),
  insertAttachment: (_pane, files) => pathOps(files),
  insertText: (_pane, text) => textOps(text),
  interrupt: () => [{ kind: 'keys', bytes: '\u0003' }],
  capabilities: { attach: false, mention: false, images: false, sendTurn: false },
};
