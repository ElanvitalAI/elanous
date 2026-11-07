import { expect, test } from 'bun:test';
import { routeDashboardPriorityKey } from './dashboard-priority-key-route.js';
import type { Key } from '../../tui.js';

test('routes classic sidetab keys before chat-main input dispatch', async () => {
  const calls: string[] = [];
  const key: Key = { name: 's', ctrl: false, shift: false };
  const result = await routeDashboardPriorityKey(key, {
    inputOwner: 'chat-main',
    isForceQuitChord: () => false,
    routeBellKey: () => false,
    routeSidetabKey: () => {
      calls.push('sidetab');
      return true;
    },
    dispatchPreKey: () => {
      calls.push('input');
      return false;
    },
    routeExclusiveTerminalModalKey: () => false,
    routeArmedChordKey: () => false,
    armPrefixChord: () => false,
    isHardQuitKey: () => false,
    matchGlobalAction: () => null,
    runGlobalAction: () => {},
    routeLayoutModalKey: () => false,
  });

  expect(result).toEqual({ type: 'handled' });
  expect(calls).toEqual(['sidetab']);
});
