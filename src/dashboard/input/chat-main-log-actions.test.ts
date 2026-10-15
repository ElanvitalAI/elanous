import { describe, expect, test } from 'bun:test';

import type { FoldMode } from '../../log-entry.js';
import {
  dashboardLogHelpLines,
  resolveDashboardLogFoldAction,
  resolveDashboardLogSizeAction,
  resolveDashboardLogTurnAction,
} from './chat-main-log-actions.js';

describe('dashboardLogHelpLines', () => {
  test('exposes /log fold with line, task-unit, and kind-unit', () => {
    // `/log fold all` (#19 bulk collapse) is a separate row; the mode row stays one.
    const foldLines = dashboardLogHelpLines().filter((line) => /^\s*\/log fold </.test(line));
    expect(foldLines).toHaveLength(1);
    expect(dashboardLogHelpLines().filter((line) => /^\s*\/log (unfold|fold all)\b/.test(line))).toHaveLength(2);
    expect(foldLines[0]).toContain('line');
    expect(foldLines[0]).toContain('task-unit');
    expect(foldLines[0]).toContain('kind-unit');
  });
});

describe('resolveDashboardLogFoldAction', () => {
  test('empty argument cycles line → task-unit → kind-unit → line', () => {
    expect(resolveDashboardLogFoldAction('', 'line')).toEqual({
      kind: 'set-mode',
      mode: 'task-unit',
      message: '  log fold mode → task-unit (task-unit folding (tool bodies collapsed to headers))',
    });
    expect(resolveDashboardLogFoldAction('', 'task-unit')).toEqual({
      kind: 'set-mode',
      mode: 'kind-unit',
      message: '  log fold mode → kind-unit (kind-unit folding (adjacent same-kind operations collapsed together))',
    });
    expect(resolveDashboardLogFoldAction('', 'kind-unit')).toEqual({
      kind: 'set-mode',
      mode: 'line',
      message: '  log fold mode → line (line-budget folding (default))',
    });
  });

  test('empty argument returns to the starting mode after three steps', () => {
    const start: FoldMode = 'line';
    const first = resolveDashboardLogFoldAction('', start);
    expect(first).toEqual({
      kind: 'set-mode',
      mode: 'task-unit',
      message: '  log fold mode → task-unit (task-unit folding (tool bodies collapsed to headers))',
    });
    const second = resolveDashboardLogFoldAction('', first.kind === 'set-mode' ? first.mode : start);
    expect(second).toEqual({
      kind: 'set-mode',
      mode: 'kind-unit',
      message: '  log fold mode → kind-unit (kind-unit folding (adjacent same-kind operations collapsed together))',
    });
    const third = resolveDashboardLogFoldAction('', second.kind === 'set-mode' ? second.mode : start);
    expect(third).toEqual({
      kind: 'set-mode',
      mode: start,
      message: '  log fold mode → line (line-budget folding (default))',
    });
  });

  test('selects explicit FoldMode values imported from log-entry', () => {
    const lineMode: FoldMode = 'line';
    const taskUnitMode: FoldMode = 'task-unit';

    expect(resolveDashboardLogFoldAction(lineMode, taskUnitMode)).toEqual({
      kind: 'set-mode',
      mode: 'line',
      message: '  log fold mode → line (line-budget folding (default))',
    });
    expect(resolveDashboardLogFoldAction(taskUnitMode, lineMode)).toEqual({
      kind: 'set-mode',
      mode: 'task-unit',
      message: '  log fold mode → task-unit (task-unit folding (tool bodies collapsed to headers))',
    });
    expect(resolveDashboardLogFoldAction('kind-unit', lineMode)).toEqual({
      kind: 'set-mode',
      mode: 'kind-unit',
      message: '  log fold mode → kind-unit (kind-unit folding (adjacent same-kind operations collapsed together))',
    });
  });

  test('returns usage for invalid mode arguments', () => {
    expect(resolveDashboardLogFoldAction('body', 'line')).toEqual({
      kind: 'invalid',
      message: '  unknown log fold mode: body',
      usage: '  /log fold line | task-unit | kind-unit',
    });
  });

});

describe('existing dashboard log action resolvers', () => {
  test('preserves representative turn and size behavior', () => {
    expect(resolveDashboardLogTurnAction('now', 'off')).toEqual({
      kind: 'emit-now',
      nextModeWhileEmitting: 'both',
    });
    expect(resolveDashboardLogTurnAction('', 'rule')).toEqual({
      kind: 'show-status',
      message: '  current turn separator: rule',
      usage: '  /log turn off | rule | time | both | on | now',
    });
    expect(resolveDashboardLogSizeAction('', 3)).toEqual({
      kind: 'reset',
      nextBias: 0,
      message: '  log height bias reset → 0 (current: 0)',
    });
    expect(resolveDashboardLogSizeAction('+2', 3)).toEqual({
      kind: 'set',
      nextBias: 5,
      message: '  log height bias → 5',
    });
  });
});
