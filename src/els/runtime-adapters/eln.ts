// ELS-RUNTIME-ADAPTERS — eln (the elanous TUI). Its composer understands «@<path>» (src/tui/input/at-picker.ts · quoted
// form «@"/a/my shot.png"» in image-mentions.ts; an image path reaches the model as an image).

import { mentionOps, promptRow, statusFromScreen, textOps, WORKING_HINT, executableOf } from './common.js';
import type { RuntimeAdapter, ScreenRules } from './types.js';

// 출처: eln's own working line shows «Turn running» (Korean UI: «응답 중») while a turn is in flight (moved from core.ts).
export const ELN_BUSY_SCREEN = /Turn running|응답 중/;
// 출처: src/tui/chat/working-row.ts — «Running Name(target) (<elapsed> • esc to interrupt)» while a tool runs (moved from pane-status.ts).
export const ELN_TOOL_ROW = /Running ([A-Za-z][\w.-]*)(?:\([^)]*\))?\s*\(([^•)]+?)\s*•\s*esc to interrupt/i;
// 출처: src/tui/input/composer.ts — eln's prompt row starts with «❯ » (moved from pane-status.ts).
export const ELN_PROMPT_HEAD = '❯';

/** eln's approval panel is up: the choice row pinned to the bottom (moved from core.ts — HITL gate). */
export const elnApprovalPending = (screen: string): boolean => {
  const bottom = screen.split('\n').slice(-8).join('').replace(/\s/g, '');
  return /(?:EnterdefaultN|Enter기본N)/.test(bottom)
    && /(?:yrun|yapprove|y실행|y승인)/.test(bottom)
    && /(?:Escdeny|Esc거부)/.test(bottom);
};

const ELN = new Set(['eln', 'elanous', 'elanous.mjs']);
const screen: ScreenRules = { busy: [WORKING_HINT, ELN_BUSY_SCREEN], promptHead: ELN_PROMPT_HEAD, tool: ELN_TOOL_ROW, asking: elnApprovalPending };

export const elnAdapter: RuntimeAdapter = {
  id: 'eln',
  detect: (pane) => ELN.has(executableOf(pane.cmdline)),
  screen,
  status: (text, exited) => statusFromScreen(screen, text, exited),
  insertAttachment: (_pane, files) => mentionOps(files),
  insertText: (_pane, text) => textOps(text),
  interrupt: () => [{ kind: 'keys', bytes: '\u001b' }],
  capabilities: { attach: true, mention: true, images: true, sendTurn: true },
};
