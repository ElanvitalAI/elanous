// ── Keybinding registry (catalog, not dispatcher) ──
//
// A static, single-source-of-truth table of every keybinding and slash
// command elanous exposes. The TUI dispatcher (dashboard.ts) still holds
// the actual handler logic — rewriting that is invasive and risky —
// but the help surfaces (F1, `/keys`, `elanous keys`) pull from HERE so
// users can discover bindings without spelunking source.
//
// When you add a new key in dashboard.ts, widgets, plugins, or a
// slash command, also add an entry here. A test at the bottom would
// be nice (walk every binding and assert it exists in source) but for
// now we trust the review process — docs drift is cheaper than over-
// engineered introspection.

import { SLASH_COMMANDS } from './chat/index.js';

export interface KeyBinding {
  keys: string[];       // one or more equivalent key strokes
  action: string;       // short imperative verb phrase
  context: KeyContext;
  note?: string;
}

export type KeyContext =
  | 'global'            // works anywhere in the dashboard
  | 'pane'              // pane-focus mode (not typing in input)
  | 'input'             // chat input bar
  | 'log'               // log pane focused
  | 'browser'           // files / obsidian / skills browser
  | 'preview'           // preview pane
  | 'select'            // multi-select picker (sync / skills)
  | 'memo'              // memo editor
  | 'clipboard'         // clipboard-history overlay
  | 'widget-list'       // list widget
  | 'widget-md';        // markdown widget

export const KEYBINDINGS: KeyBinding[] = [
  // ── Global ────────────────────────────────────────────────
  { keys: ['Ctrl+Q', 'q'],         action: 'Quit application',               context: 'global' },
  { keys: ['Ctrl+1'],              action: 'Switch to View 1 (skills+chat)', context: 'global' },
  { keys: ['Ctrl+2'],              action: 'Switch to View 2 (working dir)', context: 'global' },
  { keys: ['Ctrl+3'],              action: 'Switch to View 3 (obsidian + working)', context: 'global' },
  { keys: ['Ctrl+4'],              action: 'Switch to Agents view',          context: 'global' },
  { keys: ['Ctrl+5'],              action: 'Switch to Debug view',           context: 'global' },
  { keys: ['Ctrl+6'],              action: 'Switch to Scheduler view',       context: 'global' },
  // VP3 — Ctrl+7 switches to the Widget Playground view (V7). Requires
  // kitty-keyboard or xterm modifyOtherKeys (both enabled on startup).
  // `/view 7` is the portable fallback for plain xterm.
  { keys: ['Ctrl+7', 'Ctrl+/ (fallback)'], action: 'Switch to View 7 — Widget Playground (or /view 7)', context: 'global' },
  // FU-1/FU-2 — opener + chord shortcuts. 모두 coordinator.registerKeyBinding
  // 경유. Q4 (substrate Occam, 2026-05-03): Korean IME alias 는 중앙
  // KEY_ALIAS_TABLE (input-core/key-alias-table.ts) 가 lookup 시
  // 자동 흡수. 바인딩은 라틴 형태만 선언.
  { keys: ['Ctrl+K', 'Ctrl+ㅏ'],   action: 'Open SSH remote picker',         context: 'global', note: 'FU-1 — registerKeyBinding({handler})' },
  { keys: ['Ctrl+P', 'Ctrl+ㅔ'],   action: 'Open finder (file picker)',      context: 'global', note: 'FU-1 — registerKeyBinding({handler})' },
  { keys: ['Ctrl+M', 'Ctrl+ㅡ'],   action: 'Arm pane-modal chord (1 s window; next letter opens deferred pane)', context: 'global', note: 'FU-1 — coordinator chord, SHORTCUT_TABLE' },
  { keys: ['Ctrl+B'],             action: 'Background running child tasks (while streaming; turn continues)', context: 'global' },
  { keys: ['Ctrl+X', 'Ctrl+ㅌ'],   action: 'Arm dashboard pane chord (1 s window)', context: 'pane' },
  { keys: ['Ctrl+X Ctrl+W'],       action: 'Focus working-dir browser',      context: 'global', note: 'pane-browse chord' },
  { keys: ['Ctrl+X Ctrl+O'],       action: 'Focus Obsidian browser',         context: 'global', note: 'pane-browse chord' },
  { keys: ['Ctrl+X Ctrl+S'],       action: 'Reopen scratchpad (pane-browse)', context: 'global' },
  { keys: ['Ctrl+X s'],            action: 'Enter sync mode (chat input)',   context: 'input' },
  { keys: ['Ctrl+X g'],            action: 'Exit sync/control mode → general (chat input)', context: 'input' },
  { keys: ['Ctrl+X S'],            action: 'Focus sessions sidebar',        context: 'pane' },
  { keys: ['Ctrl+X n'],            action: 'Advance to next session + focus sidebar', context: 'pane' },
  { keys: ['Ctrl+X p'],            action: 'Retreat to previous session + focus sidebar', context: 'pane' },
  { keys: ['Ctrl+X c'],            action: 'Enter control mode (chat input)', context: 'input' },
  { keys: ['Ctrl+X x'],            action: 'Close focused pane',             context: 'pane' },
  { keys: ['Ctrl+X z'],            action: 'Toggle log zoom',               context: 'pane' },
  { keys: ['Ctrl+X t'],            action: 'Open preview terminal',          context: 'pane' },
  { keys: ['Ctrl+X e'],            action: 'Toggle preview terminal expansion', context: 'pane' },
  { keys: ['Ctrl+X f'],            action: 'Toggle all log folds',          context: 'pane' },
  { keys: ['Alt+N', 'Alt+ㅜ'],     action: 'Next virtual window (fast-switch, no chord)',       context: 'global', note: 'VW-U2 — guarded by list().length>1' },
  { keys: ['Alt+P', 'Alt+ㅔ'],     action: 'Prev virtual window (fast-switch, no chord)',       context: 'global', note: 'VW-U2' },
  { keys: ['Alt+1..9'],            action: 'Switch directly to Nth virtual window',             context: 'global', note: 'VW-U2 — guarded by list().length>1' },
  { keys: ['Alt+0'],               action: 'Open window picker (fast, no chord)',               context: 'global', note: 'VW-U2' },
  { keys: ['Ctrl+X b'],            action: 'Toggle notification bell modal',  context: 'pane', note: 'NT5 — open/close bell modal with unread + error filter' },
  { keys: ['Ctrl+Shift+V', 'Ctrl+Shift+ㅍ'], action: 'Enter Voice mode (Space hold push-to-talk · Esc to exit)', context: 'global', note: 'PR-S1V.4 — voice-input-host · kitty >3u on entry · brand prefix routing' },
  { keys: ['Alt+S', 'Alt+ㄴ'], action: 'Toggle continuous voice-chat mode (real-time STT + auto-TTS · ESC or chord again to exit)', context: 'global', note: '2026-05-03 — moved from Alt+R to free R for reasoning cycle (V/D/R mnemonic)' },
  { keys: ['Alt+R', 'Alt+ㄱ'], action: 'Cycle reasoning level (off → low → medium → high → xhigh). Codex / Claude reasoning models only — no-op on grok/gemini', context: 'global', note: '2026-05-03 — provider-agnostic ReasoningLevel cycle, same effect as `/reasoning` slash. V/D/R mnemonic: V=voice control (Ctrl+Shift+V), D=batch dictation (Space-longpress), R=reasoning' },
  { keys: ['Alt+M', 'Alt+ㅡ'], action: 'Cycle active LLM provider through rotation pool (e.g. qwen3.6 local → claude haiku cloud → grok-fast). Toast shows new active entry. Empty pool → hint to /setup.', context: 'global', note: '2026-05-05 — same effect as `/provider next` slash. Mnemonic: M = Model. Pairs with V/D/R: V=voice, D=dictation, R=reasoning, M=model' },
  { keys: ['F1', '?'],             action: 'Toggle help overlay',            context: 'global' },
  // Plan-Mode UX P1.4 (2026-05-05) — Shift+Tab globally toggles plan
  // mode (read-only planning posture). When plan inactive: enters
  // plan mode + chat hint with the plan file path. When active: hint
  // to use `/plan exit` or ask the assistant to call ExitPlanMode for
  // the 3-way modal. Pane backward-cycle (entry below) still fires
  // for users focused on a pane — coordinator routes global first.
  { keys: ['Shift+Tab'],           action: 'Toggle plan mode (read-only planning posture)', context: 'global', note: 'Plan-Mode UX P1.4 — Codex/Claude-fork lineage' },

  // ── Pane navigation ──────────────────────────────────────
  { keys: ['Tab'],                 action: 'Cycle pane focus forward',       context: 'pane' },
  { keys: ['Shift+Tab'],           action: 'Cycle pane focus backward',      context: 'pane', note: '2026-05-05 — global Shift+Tab is plan-toggle; pane backward cycle remains as fallback' },
  { keys: ['`'],                   action: 'Toggle log pane focus',          context: 'pane', note: 'backtick' },
  { keys: ['Ctrl+G'],              action: 'Focus log pane (from anywhere)', context: 'global' },
  { keys: ['Ctrl+T'],              action: 'Toggle → chat input',            context: 'pane', note: 'also Ctrl+M on Kitty-protocol terminals' },
  { keys: ['/', 'i'],              action: 'Enter chat input',               context: 'pane' },
  { keys: ['Esc'],                 action: 'Return to pane mode (if in input/overlay)', context: 'global' },

  // ── Chat input ───────────────────────────────────────────
  { keys: ['Enter'],               action: 'Submit message or slash command', context: 'input' },
  { keys: ['Shift+Enter', 'Alt+Enter', 'Ctrl+J'], action: 'Insert newline', context: 'input', note: 'Shift+Enter 가 안 되는 터미널은 Alt+Enter / Ctrl+J' },
  { keys: ['Ctrl+Shift+V'],        action: 'Paste clipboard image',          context: 'input' },
  { keys: ['Ctrl+T'],              action: 'Toggle → pane mode',             context: 'input', note: 'also Ctrl+M on Kitty-protocol terminals' },
  { keys: ['Tab'],                 action: 'Autocomplete slash command / path', context: 'input' },
  { keys: ['Esc'],                 action: 'Abort current stream or exit input', context: 'input' },
  { keys: ['Enter (while answering)'], action: 'Queue message — inserted at the next tool boundary', context: 'input', note: '10-14 steer' },
  { keys: ['Enter on empty input (while answering)'], action: 'Push queued messages now — interrupt if running tools are cancelable, else first at next boundary', context: 'input', note: '10-14 steer' },
  { keys: ['Ctrl+↑'],              action: 'Recall all queued messages into the input', context: 'input', note: '10-14 — was last one only' },

  // ── Browsers (files / obsidian / skills) ─────────────────
  { keys: ['j', '↓'],              action: 'Move cursor down',               context: 'browser' },
  { keys: ['k', '↑'],              action: 'Move cursor up',                 context: 'browser' },
  { keys: ['g', 'Home'],           action: 'Jump to top',                    context: 'browser' },
  { keys: ['G', 'End'],            action: 'Jump to bottom',                 context: 'browser' },
  { keys: ['PageUp', 'Ctrl+U'],    action: 'Page up',                        context: 'browser' },
  { keys: ['PageDown', 'Ctrl+D'],  action: 'Page down',                      context: 'browser' },
  { keys: ['←'],                   action: 'Go up to parent directory',      context: 'browser', note: 'TR-P5' },
  { keys: ['→'],                   action: 'Enter directory at cursor',      context: 'browser', note: 'TR-P5' },
  { keys: ['Enter'],               action: 'Open directory / attach file',   context: 'browser' },
  { keys: ['p'],                   action: 'Attach current file (stay in pane)', context: 'browser' },
  { keys: ['s'],                   action: 'Attach directory contents',      context: 'browser' },

  // ── Preview pane ─────────────────────────────────────────
  { keys: ['j', 'k'],              action: 'Scroll preview by line',         context: 'preview' },
  { keys: ['PageUp', 'PageDown'],  action: 'Scroll preview by page',         context: 'preview' },
  { keys: ['w'],                   action: 'Preview from Working dir',       context: 'preview' },
  { keys: ['o'],                   action: 'Preview from Obsidian vault',    context: 'preview' },
  { keys: ['k'],                   action: 'Preview current skill',          context: 'preview' },
  { keys: ['s'],                   action: 'Smart preview source pick',      context: 'preview' },
  { keys: ['m'],                   action: 'Open memo editor on current file', context: 'preview' },

  // ── Log pane ─────────────────────────────────────────────
  { keys: ['j', '↓'],              action: 'Scroll log down one line',       context: 'log' },
  { keys: ['k', '↑'],              action: 'Scroll log up one line',         context: 'log' },
  { keys: ['Ctrl+D'],              action: 'Scroll log down half page',      context: 'log' },
  { keys: ['Ctrl+U'],              action: 'Scroll log up half page',        context: 'log' },
  { keys: ['PageDown'],            action: 'Scroll log down one page',       context: 'log' },
  { keys: ['PageUp'],              action: 'Scroll log up one page',         context: 'log' },
  { keys: ['g', 'Home'],           action: 'Jump log to top',                context: 'log' },
  { keys: ['G', 'End'],            action: 'Jump log to tail (auto-follow)', context: 'log' },
  { keys: ['Ctrl+L'],              action: 'Clear log',                      context: 'log' },
  { keys: ['y'],                   action: 'Copy last chat block',           context: 'log' },
  { keys: ['Y'],                   action: 'Copy entire log',                context: 'log' },
  { keys: ['Ctrl+Shift+P'],        action: 'Open last assistant media preview', context: 'log' },
  { keys: ['r'],                   action: 'Toggle raw / rendered view',     context: 'log' },
  { keys: ['+', '='],              action: 'Grow log pane (1 row)',          context: 'log' },
  { keys: ['-', '_'],              action: 'Shrink log pane (1 row)',        context: 'log' },
  { keys: ['0'],                   action: 'Reset log pane size',            context: 'log' },

  // ── Selection picker (sync / multi-select) ───────────────
  { keys: ['Space', '*'],          action: 'Toggle current item',            context: 'select' },
  { keys: ['a'],                   action: 'Select / deselect all',          context: 'select' },
  { keys: ['Enter'],               action: 'Confirm selection',              context: 'select' },
  { keys: ['Esc'],                 action: 'Cancel selection',               context: 'select' },

  // ── Memo editor ──────────────────────────────────────────
  { keys: ['Ctrl+S'],              action: 'Save memo',                      context: 'memo' },
  { keys: ['Esc'],                 action: 'Cancel memo',                    context: 'memo' },

  // ── Clipboard history overlay ────────────────────────────
  { keys: ['c'],                   action: 'Clear clipboard history',        context: 'clipboard' },
  { keys: ['l'],                   action: 'Exit clipboard view',            context: 'clipboard' },
  { keys: ['Enter'],               action: 'Paste selected clipboard entry', context: 'clipboard' },

  // ── List widget ──────────────────────────────────────────
  { keys: ['j', 'k'],              action: 'Move cursor',                    context: 'widget-list' },
  { keys: ['g', 'G'],              action: 'Top / bottom',                   context: 'widget-list' },
  { keys: ['Space'],               action: 'Toggle item',                    context: 'widget-list' },
  { keys: ['a'],                   action: 'Select all',                     context: 'widget-list' },

  // ── Markdown widget ──────────────────────────────────────
  { keys: ['j', 'k'],              action: 'Scroll by line',                 context: 'widget-md' },
  { keys: ['PageUp', 'PageDown'],  action: 'Scroll by page',                 context: 'widget-md' },
  { keys: ['g'],                   action: 'Jump to top',                    context: 'widget-md' },
];

// ── Grouping helpers ─────────────────────────────────────────────────

export const CONTEXT_LABELS: Record<KeyContext, string> = {
  global:        'Global',
  pane:          'Pane navigation',
  input:         'Chat input',
  log:           'Log pane',
  browser:       'File / Obsidian / Skill browser',
  preview:       'Preview pane',
  select:        'Multi-select picker',
  memo:          'Memo editor',
  clipboard:     'Clipboard history',
  'widget-list': 'List widget',
  'widget-md':   'Markdown widget',
};

export function keyBindingsByContext(): Record<KeyContext, KeyBinding[]> {
  const out = {} as Record<KeyContext, KeyBinding[]>;
  for (const k of Object.keys(CONTEXT_LABELS) as KeyContext[]) out[k] = [];
  for (const b of KEYBINDINGS) out[b.context].push(b);
  return out;
}

// ── Rendering ────────────────────────────────────────────────────────

/** Render a plain-text, column-aligned help table. Used by `elanous keys`
 *  and the `/keys` slash command. Context filter narrows to one group. */
export function renderKeyHelp(opts: { context?: KeyContext } = {}): string {
  const groups = keyBindingsByContext();
  const contexts = opts.context
    ? [opts.context]
    : Object.keys(groups) as KeyContext[];
  const lines: string[] = [];
  for (const ctx of contexts) {
    const items = groups[ctx];
    if (items.length === 0) continue;
    lines.push('');
    lines.push(`━━ ${CONTEXT_LABELS[ctx]} ━━`);
    const keyCol = Math.min(24, Math.max(...items.map(i => i.keys.join(' / ').length)));
    for (const item of items) {
      const k = item.keys.join(' / ').padEnd(keyCol);
      const note = item.note ? `   (${item.note})` : '';
      lines.push(`  ${k}  ${item.action}${note}`);
    }
  }
  // The slash-command footer belongs to the full (unfiltered) render only.
  // A context filter narrows output to a single key-binding context, so the
  // global command catalog must not be appended (it would otherwise leak
  // unrelated command descriptions into the narrowed view).
  if (!opts.context) {
    lines.push('');
    lines.push('━━ Slash commands ━━');
    const nameCol = Math.max(...SLASH_COMMANDS.map(c => c.name.length)) + 1;
    const aliasCol = Math.max(...SLASH_COMMANDS.map(c => (c.aliases ?? []).join(',').length)) + 1;
    for (const c of SLASH_COMMANDS) {
      const aliases = (c.aliases ?? []).map(a => '/' + a).join(', ');
      const name = ('/' + c.name).padEnd(nameCol + 1);
      const al = aliases.padEnd(aliasCol);
      lines.push(`  ${name}  ${al}  ${c.description}`);
    }
  }
  return lines.join('\n');
}
