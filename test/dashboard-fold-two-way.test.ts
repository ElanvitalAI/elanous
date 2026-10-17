// #16 (click fold is one-way) · #19 (no one-step «unfold all» from the input) — 10-14 대표.
import { describe, expect, test } from 'bun:test';

import { createContextRegistry } from '../src/context.js';
import { FoldStack } from '../src/fold-stack.js';
import { createAttachmentRowMap } from '../src/log-pane/attachment-row-map.js';
import { createDashboardLogClickDeps, createFoldClickScrollAnchor } from '../src/dashboard/log-click-runtime.js';
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

// #81 (대표 10-17) — the old onAfterToggle pinned every toggle to the tail, so
// expanding a block near the bottom pushed its header up and the same screen
// spot then hit the body (expanded-body-reject). A click keeps the top row.
describe('#81 a click fold keeps its screen spot', () => {
  // computeLogH 18 → body 17 rows, no footer → 17 content rows.
  const CONTENT_H = 17;
  const FILLER = 20;

  function scrolledLog(opts: { anchored: boolean; scrollOffset?: number; frozen?: number }) {
    const chatLines = [...Array.from({ length: FILLER }, (_, i) => `line ${i}`), ...COLLAPSED, 'after'];
    const scroll = { offset: opts.scrollOffset ?? -1, frozen: opts.frozen ?? null as number | null };
    const pinTail = (): void => { scroll.offset = -1; };
    const anchor = createFoldClickScrollAnchor({
      getScrollOffset: () => scroll.offset,
      setScrollOffset: (o) => { scroll.offset = o; },
      maxScroll: () => Math.max(0, chatLines.length - CONTENT_H),
      getFrozenTail: () => scroll.frozen,
      setFrozenTail: (i) => { scroll.frozen = i; },
      lineCount: () => chatLines.length,
    }, pinTail);
    const foldStack = new FoldStack({
      chatLines,
      onAfterToggle: opts.anchored ? (t, d) => anchor.onAfterToggle(t, d) : pinTail,
    });
    foldStack.push({
      kind: 'static', expanded: false, lineStart: FILLER, lineEnd: FILLER + COLLAPSED.length,
      rerender: (isExpanded) => isExpanded ? EXPANDED : COLLAPSED,
    });
    const deps = createDashboardLogClickDeps({
      termSize: () => ({ rows: 40, cols: 120 }),
      computePaneH: () => 20,
      computeLogH: () => 18,
      chatLinesLength: () => chatLines.length,
      chatScrollOffset: () => scroll.offset,
      logFrozenTailIndex: () => scroll.frozen,
      chatFooterLine: () => null,
      attachmentRowMap: createAttachmentRowMap(),
      contextRegistry: createContextRegistry(),
      setWorkingFocus: () => {},
      pushTypedModal: () => null,
      onAttachmentAction: () => {},
      draw: () => {},
      debug: { enabled: false, log: () => {} },
      foldStack,
      ...(opts.anchored ? { foldClickAnchor: anchor } : {}),
    });
    const tailTop = (): number => Math.max(0, chatLines.length - CONTENT_H);
    return { chatLines, foldStack, deps, scroll, tailTop, anchor };
  }
  const click = (deps: ReturnType<typeof createDashboardLogClickDeps>, row: number) =>
    tryAttachmentHitAtBodyRow(row, { row, col: 4 }, deps);

  test('pinned to the tail: expand from the header, the same spot again folds back', () => {
    const { chatLines, foldStack, deps, scroll, tailTop } = scrolledLog({ anchored: true });
    const headerRow = FILLER - tailTop();
    expect(click(deps, headerRow)).toBe('popup-opened');
    expect(foldStack.snapshot()[0]?.expanded).toBe(true);
    // The header stays on the clicked row instead of scrolling up.
    expect(scroll.offset).toBe(FILLER - headerRow);
    expect(click(deps, headerRow)).toBe('popup-opened');
    expect(foldStack.snapshot()[0]?.expanded).toBe(false);
    expect(chatLines.slice(FILLER)).toEqual([...COLLAPSED, 'after']);
    // Folded back to the bottom → follows the tail again.
    expect(scroll.offset).toBe(-1);
  });

  test('3 rounds of expand → same spot → fold all succeed', () => {
    const { foldStack, deps, tailTop } = scrolledLog({ anchored: true });
    const headerRow = FILLER - tailTop();
    for (let i = 0; i < 3; i++) {
      expect(click(deps, headerRow)).toBe('popup-opened');
      expect(foldStack.snapshot()[0]?.expanded).toBe(true);
      expect(click(deps, headerRow)).toBe('popup-opened');
      expect(foldStack.snapshot()[0]?.expanded).toBe(false);
    }
  });

  test('a body row still does not fold; the first line does', () => {
    const { foldStack, deps, tailTop } = scrolledLog({ anchored: true });
    const hintRow = FILLER + 2 - tailTop();
    expect(click(deps, hintRow)).toBe('popup-opened');
    const headerRow = FILLER - (FILLER + 2 - hintRow);
    // Body row between the header and the expanding row.
    expect(click(deps, headerRow + 1)).toBe('no-attachment');
    expect(foldStack.snapshot()[0]?.expanded).toBe(true);
    expect(click(deps, headerRow)).toBe('popup-opened');
    expect(foldStack.snapshot()[0]?.expanded).toBe(false);
  });

  test('① scrolled up: a click expand does not jump to the tail, even when new output arrives', () => {
    const { chatLines, foldStack, deps, scroll, anchor } = scrolledLog({ anchored: true, scrollOffset: 4 });
    expect(click(deps, FILLER - 4)).toBe('popup-opened');
    expect(foldStack.snapshot()[0]?.expanded).toBe(true);
    expect(scroll.offset).toBe(4);
    chatLines.push('new output');
    anchor.reconcile();
    expect(scroll.offset).toBe(4);
  });

  test('② following the tail: after a click expand, new output pins the tail again', () => {
    const { chatLines, foldStack, deps, scroll, tailTop, anchor } = scrolledLog({ anchored: true });
    expect(click(deps, FILLER - tailTop())).toBe('popup-opened');
    expect(foldStack.snapshot()[0]?.expanded).toBe(true);
    // Paints before any new output keep the header under the click.
    anchor.reconcile();
    expect(scroll.offset).toBeGreaterThanOrEqual(0);
    expect(scroll.frozen).toBeNull();
    chatLines.push('new output');
    anchor.reconcile();
    expect(scroll.offset).toBe(-1);
    expect(scroll.frozen).toBeNull();
  });

  test('② a manual scroll after the click expand wins over tail-follow', () => {
    const { chatLines, deps, scroll, tailTop, anchor } = scrolledLog({ anchored: true });
    click(deps, FILLER - tailTop());
    scroll.offset = 2;
    chatLines.push('new output');
    anchor.reconcile();
    expect(scroll.offset).toBe(2);
  });

  test('a frozen tail past the block moves with the expand', () => {
    const { deps, scroll } = scrolledLog({ anchored: true, scrollOffset: 4, frozen: FILLER + COLLAPSED.length + 1 });
    click(deps, FILLER - 4);
    expect(scroll.frozen).toBe(FILLER + EXPANDED.length + 1);
  });

  test('the f key (toggleTop) still pins to the tail', () => {
    const { foldStack, scroll } = scrolledLog({ anchored: true, scrollOffset: 4 });
    foldStack.toggleTop();
    expect(scroll.offset).toBe(-1);
  });

  test('control — the tail-pinning host rejects the same-spot second click (the #81 bug)', () => {
    const { foldStack, deps, tailTop } = scrolledLog({ anchored: false });
    const headerRow = FILLER - tailTop();
    expect(click(deps, headerRow)).toBe('popup-opened');
    expect(click(deps, headerRow)).toBe('no-attachment');
    expect(foldStack.snapshot()[0]?.expanded).toBe(true);
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
