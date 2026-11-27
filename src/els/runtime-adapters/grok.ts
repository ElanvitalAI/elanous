// ELS-RUNTIME-ADAPTERS — grok CLI. Treated as a text agent: the attachment is the quoted absolute path in its input line.

import { executableOf, pathOps, statusFromScreen, textOps, WORKING_HINT } from './common.js';
import type { RuntimeAdapter, ScreenRules } from './types.js';

const screen: ScreenRules = { busy: [WORKING_HINT] };

export const grokAdapter: RuntimeAdapter = {
  id: 'grok',
  label: 'grok-cli',
  detect: (pane) => executableOf(pane.cmdline) === 'grok',
  screen,
  status: (text, exited) => statusFromScreen(screen, text, exited),
  insertAttachment: (_pane, files) => pathOps(files),
  insertText: (_pane, text) => textOps(text),
  interrupt: () => [{ kind: 'keys', bytes: '\u001b' }],
  capabilities: { attach: true, mention: false, images: false, sendTurn: true },
};
