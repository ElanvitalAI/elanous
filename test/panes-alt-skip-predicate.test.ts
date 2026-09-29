// Bundle B-7-α — skipWindowWhenStorePredicate unit tests.
//
// Direct predicate behaviour with window-shaped stubs.

import { describe, expect, test } from 'bun:test';

import { skipWindowWhenStorePredicate } from '../src/panes/alt-skip-predicate.js';
import {
  createVisualStateStore,
  PANE_FOCUS_POLICY,
  PANE_VISIBILITY,
} from '../src/panes/visual-state.js';

type PaneStub = { id: string };
function fakeWindow(id: number, panes: PaneStub[]) {
  return {
    id,
    listPanes: () => panes.map(p => ({ id: p.id })),
  };
}

describe('B-7-α · skipWindowWhenStorePredicate', () => {
  test('empty window (no panes) → never skip', () => {
    const store = createVisualStateStore();
    const skip = skipWindowWhenStorePredicate(store);
    expect(skip(fakeWindow(1, []))).toBe(false);
  });

  test('default state (no entries) → never skip', () => {
    const store = createVisualStateStore();
    const skip = skipWindowWhenStorePredicate(store);
    expect(skip(fakeWindow(1, [{ id: 'p1' }, { id: 'p2' }]))).toBe(false);
  });

  test('all panes skip-eligible (focusPolicy=skip) → skip', () => {
    const store = createVisualStateStore();
    store.setState({ windowId: '1', paneId: 'p1' }, { focusPolicy: PANE_FOCUS_POLICY.skip });
    store.setState({ windowId: '1', paneId: 'p2' }, { focusPolicy: PANE_FOCUS_POLICY.skip });
    const skip = skipWindowWhenStorePredicate(store);
    expect(skip(fakeWindow(1, [{ id: 'p1' }, { id: 'p2' }]))).toBe(true);
  });

  test('mixed — one normal, one skip → NOT skip (user reachability)', () => {
    const store = createVisualStateStore();
    store.setState({ windowId: '1', paneId: 'p1' }, { focusPolicy: PANE_FOCUS_POLICY.skip });
    // p2 stays default (normal)
    const skip = skipWindowWhenStorePredicate(store);
    expect(skip(fakeWindow(1, [{ id: 'p1' }, { id: 'p2' }]))).toBe(false);
  });

  test('hidden / dormant / no-focus all count as skip-eligible', () => {
    const store = createVisualStateStore();
    store.setState({ windowId: '1', paneId: 'p1' }, { visibility: PANE_VISIBILITY.hidden });
    store.setState({ windowId: '1', paneId: 'p2' }, { visibility: PANE_VISIBILITY.dormant });
    store.setState({ windowId: '1', paneId: 'p3' }, { focusPolicy: PANE_FOCUS_POLICY['no-focus'] });
    const skip = skipWindowWhenStorePredicate(store);
    expect(skip(fakeWindow(1, [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }]))).toBe(true);
  });

  test('transition skip → normal lifts skip flag', () => {
    const store = createVisualStateStore();
    const ref = { windowId: '1', paneId: 'p1' };
    store.setState(ref, { focusPolicy: PANE_FOCUS_POLICY.skip });
    const skip = skipWindowWhenStorePredicate(store);
    expect(skip(fakeWindow(1, [{ id: 'p1' }]))).toBe(true);
    store.setState(ref, { focusPolicy: PANE_FOCUS_POLICY.normal });
    expect(skip(fakeWindow(1, [{ id: 'p1' }]))).toBe(false);
  });

  test('windowId stringification — VW.id number → PaneRef.windowId string', () => {
    const store = createVisualStateStore();
    // Writer uses string '7'; predicate builds from window.id number 7.
    store.setState({ windowId: '7', paneId: 'p1' }, { focusPolicy: PANE_FOCUS_POLICY.skip });
    const skip = skipWindowWhenStorePredicate(store);
    expect(skip(fakeWindow(7, [{ id: 'p1' }]))).toBe(true);
    // Mismatch — different windowId → default state → NOT skip.
    expect(skip(fakeWindow(8, [{ id: 'p1' }]))).toBe(false);
  });
});
