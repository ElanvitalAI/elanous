// #16 (click fold is one-way) · #19 (no one-step «unfold all» from the input) — 10-14 대표.
import { describe, expect, test } from 'bun:test';

import { createContextRegistry } from '../src/context.js';
import { FoldStack } from '../src/fold-stack.js';
import { createAttachmentRowMap } from '../src/log-pane/attachment-row-map.js';
import { createDashboardLogClickDeps } from '../src/dashboard/log-click-runtime.js';
import { tryAttachmentHitAtBodyRow } from '../src/log-pane/click-dispatch.js';
import { resolveDashboardChatMainLogCommand } from '../src/dashboard/input/chat-main-log-command.js';
import { createDashboardChordActionRunner, matchDashboardChordAction } from '../src/dashboard/input/dashboard-chord-actions.js';
import { registerLogFoldInputBinding, LOG_FOLD_TOGGLE_ALL_ACTION } from '../src/dashboard/input/log-fold-binding.js';
import {
  armChordLeader, getAction, keyEvent, resolveInputEvent,
  __resetActionRegistryForTests, __resetBindingsForTests, __resetChordStateForTests, __resetContextForTests,
} from '../src/input-core/index.js';
import type { Key } from '../src/tui.js';

function clickDeps(foldStack: FoldStack, chatLines: string[]) {
  return createDashboardLogClickDeps({
    termSize: () => ({ rows: 40, cols: 120 }),
    computePaneH: () => 20,
    computeLogH: () => 18,
    chatLinesLength: () => chatLines.length,
    chatScrollOffset: () => 0,
    logFrozenTailIndex: () => null,
    chatFooterLine: () => null,
    attachmentRowMap: createAttachmentRowMap(),
    contextRegistry: createContextRegistry(),
    setWorkingFocus: () => {},
    pushTypedModal: () => null,
    onAttachmentAction: () => {},
    draw: () => {},
    debug: { enabled: false, log: () => {} },
    foldStack,
  });
}

// A tool block folded to header + preview + «… (4 more lines folded)» hint.
const COLLAPSED = ['tool: UpdateGoal', '  first', '  … (4 more lines folded)'];
const EXPANDED = ['tool: UpdateGoal', '  first', '  second', '  third', '  fourth', '  fifth'];

function foldedLog(): { chatLines: string[]; foldStack: FoldStack } {
  const chatLines = ['before', ...COLLAPSED, 'after'];
  const foldStack = new FoldStack({ chatLines });
  foldStack.push({
    kind: 'static', expanded: false, lineStart: 1, lineEnd: 1 + COLLAPSED.length,
    rerender: (isExpanded) => isExpanded ? EXPANDED : COLLAPSED,
  });
  return { chatLines, foldStack };
}

describe('#16 click fold is two-way', () => {
  test('clicking the hint row expands; clicking the same row again folds back', () => {
    const { chatLines, foldStack } = foldedLog();
    const deps = clickDeps(foldStack, chatLines);
    expect(tryAttachmentHitAtBodyRow(3, { row: 3, col: 4 }, deps)).toBe('popup-opened');
    expect(chatLines).toEqual(['before', ...EXPANDED, 'after']);
    expect(tryAttachmentHitAtBodyRow(3, { row: 3, col: 4 }, deps)).toBe('popup-opened');
    expect(chatLines).toEqual(['before', ...COLLAPSED, 'after']);
  });

  test('the last line of an expanded block folds it; a middle body row does not', () => {
    const { chatLines, foldStack } = foldedLog();
    foldStack.setAll(true);
    const deps = clickDeps(foldStack, chatLines);
    expect(tryAttachmentHitAtBodyRow(4, { row: 4, col: 4 }, deps)).toBe('no-attachment');
    expect(foldStack.snapshot()[0]?.expanded).toBe(true);
    expect(tryAttachmentHitAtBodyRow(6, { row: 6, col: 4 }, deps)).toBe('popup-opened');
    expect(chatLines).toEqual(['before', ...COLLAPSED, 'after']);
  });

  test('an expansion by key forgets an older click row', () => {
    const { chatLines, foldStack } = foldedLog();
    const deps = clickDeps(foldStack, chatLines);
    tryAttachmentHitAtBodyRow(3, { row: 3, col: 4 }, deps);
    foldStack.toggleTop();
    foldStack.toggleTop();
    expect(foldStack.isExpandedCollapseLine(3)).toBe(false);
    expect(foldStack.isExpandedCollapseLine(1)).toBe(true);
  });
});

describe('#19 unfold every fold in one step', () => {
  test('setAll opens and closes every static fold in an explicit direction', () => {
    const chatLines = ['a', 'b-fold', 'c', 'd-fold'];
    const foldStack = new FoldStack({ chatLines });
    foldStack.push({ kind: 'static', expanded: false, lineStart: 1, lineEnd: 2, rerender: (x) => x ? ['b1', 'b2'] : ['b-fold'] });
    foldStack.push({ kind: 'static', expanded: false, lineStart: 3, lineEnd: 4, rerender: (x) => x ? ['d1', 'd2', 'd3'] : ['d-fold'] });
    expect(foldStack.setAll(true)).toBe(2);
    expect(chatLines).toEqual(['a', 'b1', 'b2', 'c', 'd1', 'd2', 'd3']);
    expect(chatLines.some((line) => line.includes('fold'))).toBe(false);
    expect(foldStack.setAll(true)).toBe(0);
    expect(foldStack.setAll(false)).toBe(2);
    expect(chatLines).toEqual(['a', 'b-fold', 'c', 'd-fold']);
    expect(foldStack.toggleAll()).toBe(2);
    expect(chatLines).toEqual(['a', 'b1', 'b2', 'c', 'd1', 'd2', 'd3']);
  });

  test('/log unfold [all] · /log fold off open everything; /log fold all closes; modes are unchanged', () => {
    expect(resolveDashboardChatMainLogCommand(['unfold'])).toEqual({ kind: 'fold-all', expanded: true });
    expect(resolveDashboardChatMainLogCommand(['unfold', 'all'])).toEqual({ kind: 'fold-all', expanded: true });
    expect(resolveDashboardChatMainLogCommand(['fold', 'off'])).toEqual({ kind: 'fold-all', expanded: true });
    expect(resolveDashboardChatMainLogCommand(['fold', 'all'])).toEqual({ kind: 'fold-all', expanded: false });
    expect(resolveDashboardChatMainLogCommand(['fold', 'line'])).toEqual({ kind: 'fold', mode: 'line' });
    expect(resolveDashboardChatMainLogCommand(['unfold', 'bogus'])).toEqual({ kind: 'unknown', subcommand: 'unfold bogus' });
  });

  test('Ctrl+X f (chord) toggles every fold from any focus — plain f/ㄹ after the leader, not Ctrl+F', () => {
    const key = (name: string, ctrl = false): Key => ({ name, ctrl, shift: false });
    expect(matchDashboardChordAction(key('f'))).toEqual({ kind: 'toggle-all-folds' });
    expect(matchDashboardChordAction(key('ㄹ'))).toEqual({ kind: 'toggle-all-folds' });
    expect(matchDashboardChordAction(key('f', true))).toBeNull();
    let toggled = 0;
    const noop = () => {};
    const run = createDashboardChordActionRunner({
      focusBrowser: noop, focusObsidian: noop, reopenScratch: noop, toggleBell: noop, focusSessions: noop,
      cycleSessions: noop, closePane: () => true, reopenPanes: noop, openPaneModal: noop, toggleLogZoom: noop,
      openPreviewTerminal: noop, togglePreviewTerminalExpand: noop, toggleAllFolds: () => { toggled++; },
    });
    void run({ kind: 'toggle-all-folds' });
    expect(toggled).toBe(1);
  });
});

describe('#19 Ctrl+X f from the input — the input-core path', () => {
  const reset = (): void => {
    __resetChordStateForTests(); __resetBindingsForTests(); __resetActionRegistryForTests(); __resetContextForTests();
  };

  test('the textarea-armed ctrl+x leader resolves f to the bulk toggle, which opens the real fold stack', async () => {
    reset();
    try {
      const { chatLines, foldStack } = foldedLog();
      registerLogFoldInputBinding(() => { foldStack.toggleAll(); });
      // What the input textarea does on Ctrl+X (src/chat/index.ts `arm-chord`).
      armChordLeader('ctrl+x');
      const resolved = resolveInputEvent(keyEvent({ name: 'f', ctrl: false, shift: false }));
      expect(resolved?.actionId).toBe(LOG_FOLD_TOGGLE_ALL_ACTION);
      expect(resolved?.matcher).toBe('ctrl+x f');
      await getAction(resolved!.actionId)!.handler();
      expect(chatLines).toEqual(['before', ...EXPANDED, 'after']);
      // Without the leader, a plain `f` stays a typed letter (no binding).
      expect(resolveInputEvent(keyEvent({ name: 'f', ctrl: false, shift: false }))).toBeNull();
    } finally {
      reset();
    }
  });
});
