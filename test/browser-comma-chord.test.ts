// Browser-pane comma-chord runtime tests.
//
// Covers the chord state machine end-to-end: arming on `,`, dispatch
// of `,v` / `,s` continuations, Korean IME aliases, timeout
// behaviour, unknown-continuation surfacing.

import { describe, expect, test, beforeEach } from 'bun:test';
import {
  createBrowserChordRuntime,
  __resetBrowserChordRuntimeForTests,
} from '../src/dashboard/browser-chord-runtime.js';
import {
  __resetChordStateForTests,
  isChordArmed,
} from '../src/input-core/chord-state.js';
import type { Key } from '../src/tui.js';

interface SpyState {
  hintShown: number;
  hintCleared: number;
  edits: number;
  summaries: number;
  notices: Array<{ level: string; msg: string }>;
}

function makeRuntime(): {
  rt: ReturnType<typeof createBrowserChordRuntime>;
  spy: SpyState;
} {
  const spy: SpyState = {
    hintShown: 0, hintCleared: 0, edits: 0, summaries: 0, notices: [],
  };
  const rt = createBrowserChordRuntime({
    showChordHint: () => { spy.hintShown += 1; },
    clearChordHint: () => { spy.hintCleared += 1; },
    onEditFocused: () => { spy.edits += 1; },
    onSummarizeFocused: () => { spy.summaries += 1; },
    notice: (level, msg) => { spy.notices.push({ level, msg }); },
  });
  return { rt, spy };
}

function k(name: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}): Key {
  return { name, ctrl: mods.ctrl ?? false, shift: mods.shift ?? false, alt: mods.alt };
}

describe('browser comma chord — arming', () => {
  beforeEach(() => {
    __resetBrowserChordRuntimeForTests();
    __resetChordStateForTests();
  });

  test('comma arms the leader and shows the hint', async () => {
    const { rt, spy } = makeRuntime();
    const consumed = await rt.tryHandleKey(k(','));
    expect(consumed).toBe(true);
    expect(isChordArmed()).toBe(true);
    expect(spy.hintShown).toBe(1);
    expect(spy.edits + spy.summaries).toBe(0);
  });

  test('Korean IME ㅁ also arms the leader', async () => {
    const { rt, spy } = makeRuntime();
    const consumed = await rt.tryHandleKey(k('ㅁ'));
    expect(consumed).toBe(true);
    expect(isChordArmed()).toBe(true);
    expect(spy.hintShown).toBe(1);
  });

  test('Ctrl+, does NOT arm (modifier-bearing keys reserved)', async () => {
    const { rt, spy } = makeRuntime();
    const consumed = await rt.tryHandleKey(k(',', { ctrl: true }));
    expect(consumed).toBe(false);
    expect(isChordArmed()).toBe(false);
    expect(spy.hintShown).toBe(0);
  });

  test('non-comma single key falls through (no arm, not consumed)', async () => {
    const { rt } = makeRuntime();
    const consumed = await rt.tryHandleKey(k('j'));
    expect(consumed).toBe(false);
    expect(isChordArmed()).toBe(false);
  });
});

describe('browser comma chord — continuations', () => {
  beforeEach(() => {
    __resetBrowserChordRuntimeForTests();
    __resetChordStateForTests();
  });

  test(',v fires the editor action', async () => {
    const { rt, spy } = makeRuntime();
    await rt.tryHandleKey(k(','));
    const consumed = await rt.tryHandleKey(k('v'));
    expect(consumed).toBe(true);
    expect(spy.edits).toBe(1);
    expect(spy.summaries).toBe(0);
    // Chord cleared after continuation.
    expect(isChordArmed()).toBe(false);
  });

  test(',s fires the summarize action', async () => {
    const { rt, spy } = makeRuntime();
    await rt.tryHandleKey(k(','));
    const consumed = await rt.tryHandleKey(k('s'));
    expect(consumed).toBe(true);
    expect(spy.summaries).toBe(1);
    expect(spy.edits).toBe(0);
  });

  test('Korean IME continuations: ㅁ → ㅍ fires editor', async () => {
    const { rt, spy } = makeRuntime();
    await rt.tryHandleKey(k('ㅁ'));
    await rt.tryHandleKey(k('ㅍ'));
    expect(spy.edits).toBe(1);
  });

  test('Korean IME continuations: ㅁ → ㄴ fires summary', async () => {
    const { rt, spy } = makeRuntime();
    await rt.tryHandleKey(k('ㅁ'));
    await rt.tryHandleKey(k('ㄴ'));
    expect(spy.summaries).toBe(1);
  });

  test('mixed: , (US) → ㅍ (IME) still fires editor', async () => {
    // The user might switch IME between the two key presses. The
    // continuation is matched by physical-key alias, not by leader
    // origin.
    const { rt, spy } = makeRuntime();
    await rt.tryHandleKey(k(','));
    await rt.tryHandleKey(k('ㅍ'));
    expect(spy.edits).toBe(1);
  });

  test('unknown continuation surfaces a hint, swallows the key', async () => {
    const { rt, spy } = makeRuntime();
    await rt.tryHandleKey(k(','));
    const consumed = await rt.tryHandleKey(k('q'));
    expect(consumed).toBe(true);
    expect(spy.notices).toHaveLength(1);
    expect(spy.notices[0]!.msg).toContain(',q');
    expect(spy.edits + spy.summaries).toBe(0);
  });

  test('chord state cleared even on unknown continuation', async () => {
    const { rt } = makeRuntime();
    await rt.tryHandleKey(k(','));
    await rt.tryHandleKey(k('q'));
    expect(isChordArmed()).toBe(false);
  });
});

describe('browser comma chord — re-arming + isolation', () => {
  beforeEach(() => {
    __resetBrowserChordRuntimeForTests();
    __resetChordStateForTests();
  });

  test('pressing comma twice rearms (timer reset)', async () => {
    const { rt, spy } = makeRuntime();
    await rt.tryHandleKey(k(','));
    await rt.tryHandleKey(k(','));
    expect(spy.hintShown).toBe(2);
    expect(isChordArmed()).toBe(true);
    // Now `v` should still resolve to edit.
    await rt.tryHandleKey(k('v'));
    expect(spy.edits).toBe(1);
  });

  test('after a successful chord, fresh `j` falls through normally', async () => {
    const { rt } = makeRuntime();
    await rt.tryHandleKey(k(','));
    await rt.tryHandleKey(k('v'));
    const consumed = await rt.tryHandleKey(k('j'));
    expect(consumed).toBe(false);
  });

  test('runtime tryHandleKey is idempotent across instances', async () => {
    const { rt: r1, spy: s1 } = makeRuntime();
    await r1.tryHandleKey(k(','));
    // Different runtime instance — but the underlying chord-state is
    // a module-level singleton. The contract is "leader is browser-
    // comma → consumes regardless of which runtime created it".
    const { rt: r2, spy: s2 } = makeRuntime();
    await r2.tryHandleKey(k('v'));
    expect(s2.edits).toBe(1);
    expect(s1.edits).toBe(0);
  });
});
