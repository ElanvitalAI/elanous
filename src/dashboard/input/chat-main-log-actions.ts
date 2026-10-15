import type { FoldMode } from '../../log-entry.js';
import type { LogTurnSeparatorMode } from '../log-turn-separator-mode.js';

export function dashboardLogHelpLines(): string[] {
  return [
    '\u276f /log',
    'Usage:',
    '  /log size <+N|-N|=N|reset>  Adjust log pane height (bias rows).',
    '  /log clear                  Clear the log (same as /clear, Ctrl+L).',
    '  /log copy                   Copy the entire log (same as Alt+A).',
    '  /log input                  Return focus to the input (same as Alt+U).',
    '  /log freeze                 Show scroll-freeze status + queued-line count.',
    '  /log turn <off|rule|time|both|now>  Insert/toggle between-turn separator (rule + optional clock).',
    '  /log fold <line|task-unit|kind-unit>  Set fold mode: line (budget), task-unit (tool headers), kind-unit (same-kind ops).',
    '  /log unfold [all]           Expand every folded block now (same as /log fold off).',
    '  /log fold all               Collapse every folded block back.',
    '  /log filter <query>         Filter visible log rows by substring.',
    '  /log filter clear           Clear the active visible-row filter.',
    '  /log search [query]         Open search modal (no query) or jump to first match.',
    '  /log search clear           Drop the active search highlight.',
    '  /log solo                   Toggle chat-only layout (same as /chat, Ctrl+B z).',
    '',
    'Shortcuts (log pane focus — click Log or press Tab):',
    '  + / =    Grow log by 1 row',
    '  - / _    Shrink log by 1 row',
    '  0        Reset log height to default',
    '  Alt+A    Copy entire log (SSH-aware, auto OSC 52)',
    '  Alt+B    Copy the block under cursor',
    '  Alt+G/Y/F  Copy last message / code / media',
    '  Alt+U    Return focus to input',
    '  j/k PgUp/PgDn G/g  Scroll / jump',
    '  s        Open in-pane search modal',
    '  n / Shift+N  Next / previous match (after a search)',
    '  Esc      Clear active search highlight',
    '  f / F    Toggle the latest folded block / every folded block',
    '  Ctrl+X f (anywhere, incl. input) toggles every folded block.',
    '  Ctrl+L   Clear log',
    '  Ctrl+\u2191/\u2193 (anywhere) also resizes; Ctrl+0 resets.',
  ];
}

export type DashboardLogTurnAction =
  | { kind: 'emit-now'; nextModeWhileEmitting: LogTurnSeparatorMode }
  | { kind: 'set-mode'; mode: LogTurnSeparatorMode; message: string }
  | { kind: 'show-status'; message: string; usage: string };

export type DashboardLogSizeAction =
  | { kind: 'reset'; nextBias: number; message: string }
  | { kind: 'set'; nextBias: number; message: string }
  | { kind: 'invalid'; message: string };

type DashboardLogFoldAction =
  | { kind: 'set-mode'; mode: FoldMode; message: string }
  | { kind: 'invalid'; message: string; usage: string };

export type DashboardLogFilterAction =
  | { kind: 'clear'; message: string }
  | { kind: 'show-status'; message: string }
  | { kind: 'apply'; query: string; message: string };

export type DashboardLogSearchAction =
  | { kind: 'clear'; message: string }
  | { kind: 'open-modal' }
  | { kind: 'apply'; query: string };

export function resolveDashboardLogTurnAction(
  arg: string,
  currentMode: LogTurnSeparatorMode,
): DashboardLogTurnAction {
  if (arg === 'now') {
    return {
      kind: 'emit-now',
      nextModeWhileEmitting: currentMode === 'off' ? 'both' : currentMode,
    };
  }
  if (arg === 'off' || arg === 'rule' || arg === 'time' || arg === 'both') {
    return {
      kind: 'set-mode',
      mode: arg,
      message: `  log turn separator → ${arg}`,
    };
  }
  if (arg === 'on') {
    return {
      kind: 'set-mode',
      mode: 'both',
      message: '  log turn separator → both (rule + timestamp)',
    };
  }
  return {
    kind: 'show-status',
    message: `  current turn separator: ${currentMode}`,
    usage: '  /log turn off | rule | time | both | on | now',
  };
}

export function resolveDashboardLogFoldAction(
  mode: string,
  currentMode: FoldMode,
): DashboardLogFoldAction {
  const nextMode = !mode
    ? (currentMode === 'line' ? 'task-unit' : currentMode === 'task-unit' ? 'kind-unit' : 'line')
    : mode;

  if (nextMode === 'line' || nextMode === 'task-unit' || nextMode === 'kind-unit') {
    const meaning = nextMode === 'line'
      ? 'line-budget folding (default)'
      : nextMode === 'task-unit'
        ? 'task-unit folding (tool bodies collapsed to headers)'
        : 'kind-unit folding (adjacent same-kind operations collapsed together)';
    return {
      kind: 'set-mode',
      mode: nextMode,
      message: `  log fold mode → ${nextMode} (${meaning})`,
    };
  }

  return {
    kind: 'invalid',
    message: `  unknown log fold mode: ${mode || '(empty)'}`,
    usage: '  /log fold line | task-unit | kind-unit',
  };
}

export function resolveDashboardLogSizeAction(
  delta: string,
  currentBias: number,
): DashboardLogSizeAction {
  if (!delta || delta === 'reset' || delta === '0') {
    return {
      kind: 'reset',
      nextBias: 0,
      message: `  log height bias reset → 0 (current: ${0})`,
    };
  }

  const isAbs = delta.startsWith('=');
  const raw = parseInt(isAbs ? delta.slice(1) : delta, 10);
  if (!Number.isFinite(raw)) {
    return {
      kind: 'invalid',
      message: '  /log size expects +N, -N, =N, or "reset". Try /log help.',
    };
  }

  const nextBias = isAbs ? raw : (currentBias + raw);
  return {
    kind: 'set',
    nextBias,
    message: `  log height bias → ${nextBias}`,
  };
}

export function resolveDashboardLogFilterAction(
  query: string,
  currentFilterQuery: string,
  activeCount: number,
): DashboardLogFilterAction {
  if (!query || query === 'clear' || query === 'off') {
    if (query === 'clear' || query === 'off') {
      return {
        kind: 'clear',
        message: '  log filter cleared.',
      };
    }
    return {
      kind: 'show-status',
      message: currentFilterQuery
        ? `  current log filter: "${currentFilterQuery}" (${activeCount} rows)`
        : '  log filter inactive.',
    };
  }

  return {
    kind: 'apply',
    query,
    message: `  log filter "${query}" → ${activeCount} visible row${activeCount === 1 ? '' : 's'}`,
  };
}

export function resolveDashboardLogSearchAction(
  query: string,
): DashboardLogSearchAction {
  if (!query || query === 'clear' || query === 'off') {
    if (query === 'clear' || query === 'off') {
      return {
        kind: 'clear',
        message: '  log search cleared.',
      };
    }
    return {
      kind: 'open-modal',
    };
  }

  return {
    kind: 'apply',
    query,
  };
}
