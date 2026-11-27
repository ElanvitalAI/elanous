// ELS-RUNTIME-ADAPTERS — codex CLI. Its composer has an «@» file search; a pasted «@<path>» stays in the line as text the
// model reads (it opens the file with its own tools). Busy = «esc to interrupt»; the prompt row is «› ».

import { executableOf, mentionOps, statusFromScreen, textOps, WORKING_HINT } from './common.js';
import type { RuntimeAdapter, ScreenRules } from './types.js';

export const CODEX_PROMPT_HEAD = '›';
// codex's approval prompt: «Allow command?» / «Would you like to run the following command?» with y/n choices.
const asking = (text: string): boolean => /(?:Would you like to (?:run|make)|Allow (?:command|edits)\?)/i.test(text.split('\n').slice(-14).join('\n'));
const screen: ScreenRules = { busy: [WORKING_HINT], promptHead: CODEX_PROMPT_HEAD, asking };

export const codexAdapter: RuntimeAdapter = {
  id: 'codex',
  label: 'codex-cli',
  detect: (pane) => executableOf(pane.cmdline) === 'codex',
  screen,
  status: (text, exited) => statusFromScreen(screen, text, exited),
  insertAttachment: (_pane, files) => mentionOps(files),
  insertText: (_pane, text) => textOps(text),
  interrupt: () => [{ kind: 'keys', bytes: '\u001b' }],
  capabilities: { attach: true, mention: true, images: true, sendTurn: true },
};
