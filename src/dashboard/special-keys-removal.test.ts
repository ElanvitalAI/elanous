import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { Key } from '../tui.js';
import { createEscAbortGate } from '../esc-abort-gate.js';
import { applyTurnTypeaheadKey, createTurnTypeaheadState } from '../chat/turn-typeahead.js';
import { routeDashboardPriorityKey } from './input/dashboard-priority-key-route.js';
import { dispatchDashboardKey } from './input/key-dispatcher.js';
import type { DashboardKeyHandler } from './input/key-types.js';

test('classic TUI retains the simulated Escape abort gate and production typeahead transition', () => {
  const interaction = readFileSync(new URL('../ux-sim/interaction.ts', import.meta.url), 'utf8');
  const turnStates = readFileSync(new URL('../ux-sim/turn-states.ts', import.meta.url), 'utf8');
  expect(interaction).toContain('createEscAbortGate');
  expect(turnStates).toContain('applyTurnTypeaheadKey');
});

test('dashboard priority key entrypoint routes Escape abort and busy-turn text plus Enter to FIFO', async () => {
  const abortCtrl = new AbortController();
  const gate = createEscAbortGate({
    abortCtrl,
    getRunningCount: () => 0,
    mountModal: () => () => {},
    getViewport: () => ({ cols: 80, rows: 24 }),
  });
  let typeahead = createTurnTypeaheadState();
  const inputHandler: DashboardKeyHandler = {
    name: 'dashboard-input',
    handle: (key) => {
      if (key.name === 'escape') {
        gate.handleEscape();
        return 'consumed';
      }
      const result = applyTurnTypeaheadKey(typeahead, key);
      typeahead = result.state;
      return result.consumed ? 'consumed' : 'passthrough';
    },
  };
  const dispatchPreKey = (key: Key) =>
    dispatchDashboardKey(key, [inputHandler]).type === 'consumed';
  const deps = {
    isForceQuitChord: () => false,
    routeVoiceEnterChord: () => false,
    routeVoiceModeKey: () => false,
    routeVoiceChatRealtimeChord: () => false,
    routeVoiceChatActiveKey: () => false,
    routeBellKey: () => false,
    dispatchPreKey,
    routeExclusiveTerminalModalKey: () => false,
    routeArmedChordKey: () => false,
    armPrefixChord: () => false,
    isHardQuitKey: () => false,
    matchGlobalAction: () => null,
    runGlobalAction: () => {},
    routeLayoutModalKey: () => false,
  };

  expect(await routeDashboardPriorityKey({ name: 'escape' } as Key, deps)).toEqual({ type: 'handled' });
  expect(abortCtrl.signal.aborted).toBe(true);

  for (const name of ['o', 'k', 'enter']) {
    expect(await routeDashboardPriorityKey({ name } as Key, deps)).toEqual({ type: 'handled' });
  }
  expect(typeahead).toMatchObject({ buffer: '', queuedSubmissions: ['ok'] });
});
