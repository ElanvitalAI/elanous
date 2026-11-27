// ELS-RUNTIME-ADAPTERS — Claude Code. Its input box understands «@<path>» file mentions (quoted when the path has spaces);
// a pasted image path becomes an image. Busy = «esc to interrupt»; the prompt row is «│ > ».

import { executableOf, mentionOps, statusFromScreen, textOps, WORKING_HINT } from './common.js';
import type { RuntimeAdapter, ScreenRules } from './types.js';

// 출처: pane-status.ts (moved) — Claude Code's box prompt is «│ > ».
export const CLAUDE_PROMPT_HEAD = '❯|│\\s*>';
// Claude Code's permission prompt: «Do you want to proceed?» with numbered choices.
const asking = (text: string): boolean => /Do you want to (?:proceed|make this edit|create|run)/i.test(text.split('\n').slice(-14).join('\n'));
const screen: ScreenRules = { busy: [WORKING_HINT], promptHead: CLAUDE_PROMPT_HEAD, asking };

export const claudeAdapter: RuntimeAdapter = {
  id: 'claude',
  label: 'claude-code',
  detect: (pane) => executableOf(pane.cmdline) === 'claude',
  screen,
  status: (text, exited) => statusFromScreen(screen, text, exited),
  insertAttachment: (_pane, files) => mentionOps(files),
  insertText: (_pane, text) => textOps(text),
  interrupt: () => [{ kind: 'keys', bytes: '\u001b' }],
  capabilities: { attach: true, mention: true, images: true, sendTurn: true },
};
