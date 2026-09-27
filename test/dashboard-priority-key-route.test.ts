import { describe, expect, test } from 'bun:test';

import {
  routeDashboardPriorityKey,
  type DashboardPriorityKeyRouteDeps,
} from '../src/dashboard/input/dashboard-priority-key-route.js';
import type { Key } from '../src/tui.js';

function key(name: string, mods: Partial<Key> = {}): Key {
  return { name, ctrl: false, shift: false, ...mods };
}

function createDeps(overrides: Partial<DashboardPriorityKeyRouteDeps<string>> = {}) {
  const calls: string[] = [];
  const deps: DashboardPriorityKeyRouteDeps<string> = {
    isForceQuitChord: () => { calls.push('force-quit-check'); return false; },
    // PR-S1V.4-wiring · Step 0x voice entry chord (idle → fire) and
    // Step 0c voice active dispatch (active → host.maybeHandleKey).
    // Default mocks return false so existing tests are unaffected.
    routeVoiceEnterChord: () => { calls.push('voice-enter'); return false; },
    routeVoiceModeKey: () => { calls.push('voice-active'); return false; },
    routeVoiceChatRealtimeChord: () => { calls.push('voice-chat-chord'); return false; },
    routeVoiceChatActiveKey: async () => { calls.push('voice-chat-active'); return false; },
    routeBellKey: () => { calls.push('bell'); return false; },
    dispatchPreKey: () => { calls.push('pre'); return false; },
    routeExclusiveTerminalModalKey: () => { calls.push('terminal'); return false; },
    routeArmedChordKey: () => { calls.push('chord'); return false; },
    armPrefixChord: () => { calls.push('arm'); return false; },
    isHardQuitKey: () => { calls.push('quit-check'); return false; },
    matchGlobalAction: () => { calls.push('global-match'); return null; },
    runGlobalAction: (action) => { calls.push(`global-run:${action}`); },
    routeLayoutModalKey: () => { calls.push('layout'); return false; },
    ...overrides,
  };
  return { calls, deps };
}

describe('routeDashboardPriorityKey', () => {
  test('runs priority stages in order until one handles the key', async () => {
    const { calls, deps } = createDeps({
      routeExclusiveTerminalModalKey: () => { calls.push('terminal'); return true; },
    });

    const result = await routeDashboardPriorityKey(key('x'), deps);

    expect(result).toEqual({ type: 'handled' });
    expect(calls).toEqual(['force-quit-check', 'voice-enter', 'voice-active', 'voice-chat-chord', 'voice-chat-active', 'bell', 'terminal']);
  });

  test('returns quit before global action or layout routing', async () => {
    const { calls, deps } = createDeps({
      isHardQuitKey: () => { calls.push('quit-check'); return true; },
    });

    const result = await routeDashboardPriorityKey(key('q', { ctrl: true }), deps);

    expect(result).toEqual({ type: 'quit' });
    expect(calls).toEqual([
      'force-quit-check', 'voice-enter', 'voice-active', 'voice-chat-chord', 'voice-chat-active', 'bell', 'terminal', 'pre', 'chord', 'arm', 'quit-check',
    ]);
  });

  test('runs matched global action before layout routing', async () => {
    const { calls, deps } = createDeps({
      matchGlobalAction: () => { calls.push('global-match'); return 'toggle-log-zoom'; },
    });

    const result = await routeDashboardPriorityKey(key('z', { ctrl: true, shift: true }), deps);

    expect(result).toEqual({ type: 'handled' });
    expect(calls).toEqual([
      'force-quit-check',
      'voice-enter',
      'voice-active',
      'voice-chat-chord',
      'voice-chat-active',
      'bell',
      'terminal',
      'pre',
      'chord',
      'arm',
      'quit-check',
      'global-match',
      'global-run:toggle-log-zoom',
    ]);
  });

  test('falls through when no priority stage claims the key', async () => {
    const { calls, deps } = createDeps();

    const result = await routeDashboardPriorityKey(key('j'), deps);

    expect(result).toEqual({ type: 'passthrough' });
    expect(calls).toEqual([
      'force-quit-check',
      'voice-enter',
      'voice-active',
      'voice-chat-chord',
      'voice-chat-active',
      'bell',
      'terminal',
      'pre',
      'chord',
      'arm',
      'quit-check',
      'global-match',
      'layout',
    ]);
  });

  // Regression: terminal modal must claim keys BEFORE input-core
  // dispatchPreKey. Otherwise user-defined / chord bindings (Ctrl+B
  // s/c/g, custom Ctrl+A, etc.) fire as elanous actions while the
  // user is interacting with a child PTY (claude / codex / shell).
  // Per user feedback: "터미널 모드에서는 최대한 엘라누스의 키 파이어링을
  // 줄이는 것 검토 필요. 터미널 안의 ctrl+a, ctrl+b 등 특수 처리키가
  // 많이 보이므로." Bell remains step 1 because bell modals visually
  // overlay the popup terminal.
  test('forwards question-view ownership to pre-key dispatch after terminal routing', async () => {
    const dispatched: Array<string | undefined> = [];
    const { calls, deps } = createDeps({
      inputOwner: 'question-view',
      dispatchPreKey: (_key, targetHandlerName) => {
        calls.push('pre');
        dispatched.push(targetHandlerName);
        return true;
      },
    });

    const result = await routeDashboardPriorityKey(key('x'), deps);

    expect(result).toEqual({ type: 'handled' });
    expect(dispatched).toEqual(['question-view']);
    expect(calls).toEqual([
      'force-quit-check', 'voice-enter', 'voice-active', 'voice-chat-chord', 'voice-chat-active', 'bell', 'terminal', 'pre',
    ]);
  });

  test('keeps untargeted pre-key dispatch when question-view does not own input', async () => {
    const dispatched: Array<string | undefined> = [];
    const { deps } = createDeps({
      inputOwner: 'chat-main',
      dispatchPreKey: (_key, targetHandlerName) => {
        dispatched.push(targetHandlerName);
        return true;
      },
    });

    await routeDashboardPriorityKey(key('x'), deps);

    expect(dispatched).toEqual([undefined]);
  });

  test('does not call pre-key dispatch when a terminal modal claims a question-owned key', async () => {
    const { calls, deps } = createDeps({
      inputOwner: 'question-view',
      routeExclusiveTerminalModalKey: () => { calls.push('terminal'); return true; },
      dispatchPreKey: () => { calls.push('pre'); return true; },
    });

    const result = await routeDashboardPriorityKey(key('x'), deps);

    expect(result).toEqual({ type: 'handled' });
    expect(calls).toEqual(['force-quit-check', 'voice-enter', 'voice-active', 'voice-chat-chord', 'voice-chat-active', 'bell', 'terminal']);
  });

  test('terminal modal claim wins over input-core dispatchPreKey (regression)', async () => {
    const { calls, deps } = createDeps({
      routeExclusiveTerminalModalKey: () => { calls.push('terminal'); return true; },
      dispatchPreKey: () => { calls.push('pre'); return true; }, // would have claimed
    });

    const result = await routeDashboardPriorityKey(key('b', { ctrl: true }), deps);

    expect(result).toEqual({ type: 'handled' });
    expect(calls).toEqual(['force-quit-check', 'voice-enter', 'voice-active', 'voice-chat-chord', 'voice-chat-active', 'bell', 'terminal']);  // 'pre' never runs
  });

  // The bell-then-terminal order matters: a notification bell modal
  // is layered visually on top of the popup terminal, so it gets the
  // first claim. This protects the bell's "press 1/2/3 to focus" UX
  // from being eaten by the popup PTY.
  test('bell still claims before terminal when both are open', async () => {
    const { calls, deps } = createDeps({
      routeBellKey: () => { calls.push('bell'); return true; },
      routeExclusiveTerminalModalKey: () => { calls.push('terminal'); return true; },
    });

    const result = await routeDashboardPriorityKey(key('1'), deps);

    expect(result).toEqual({ type: 'handled' });
    expect(calls).toEqual(['force-quit-check', 'voice-enter', 'voice-active', 'voice-chat-chord', 'voice-chat-active', 'bell']);  // 'terminal' never runs
  });

  test('Alt+W no longer closes a popup before bell routing', async () => {
    const { calls, deps } = createDeps({
      routeBellKey: () => { calls.push('bell'); return true; },
      routeExclusiveTerminalModalKey: () => { calls.push('terminal'); return true; },
    });

    const result = await routeDashboardPriorityKey(key('w', { alt: true }), deps);
    expect(result).toEqual({ type: 'handled' });
    expect(calls).toEqual(['force-quit-check', 'voice-enter', 'voice-active', 'voice-chat-chord', 'voice-chat-active', 'bell']);
  });

  // Regression: Ctrl+Shift+Q (force-quit chord) wins over EVERYTHING,
  // even bell + popup terminal claims. User: "ctrl+q 전체 강제 종료
  // 컨셉은 남았으면 좋겠습니다. 터미널모드에서는 잘 사용하지 않을
  // 복잡 패턴으로 리 어사인 해도 됩니다." Plain Ctrl+Q forwards to
  // the child PTY when popup is active (avoids breaking emacs
  // quoted-insert and similar bindings); Ctrl+Shift+Q is the
  // preserved escape hatch.
  test('Ctrl+Shift+Q force-quit wins over bell + popup terminal (regression)', async () => {
    const { calls, deps } = createDeps({
      isForceQuitChord: () => { calls.push('force-quit-check'); return true; },
      routeBellKey: () => { calls.push('bell'); return true; },        // would have claimed
      routeExclusiveTerminalModalKey: () => { calls.push('terminal'); return true; },  // would have claimed
    });

    const result = await routeDashboardPriorityKey(key('q', { ctrl: true, shift: true }), deps);

    expect(result).toEqual({ type: 'quit' });
    expect(calls).toEqual(['force-quit-check']);  // bell + terminal never run
  });

  test('Ctrl+\\\\ force-quit wins over bell + popup terminal (terminal-safe alias)', async () => {
    const { calls, deps } = createDeps({
      isForceQuitChord: () => { calls.push('force-quit-check'); return true; },
      routeBellKey: () => { calls.push('bell'); return true; },
      routeExclusiveTerminalModalKey: () => { calls.push('terminal'); return true; },
    });

    const result = await routeDashboardPriorityKey(key('\\', { ctrl: true }), deps);

    expect(result).toEqual({ type: 'quit' });
    expect(calls).toEqual(['force-quit-check']);
  });
});
