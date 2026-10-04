import { expect, test } from 'bun:test';
import { decideSpawn } from './budget.js';

test('configured seat caps and default four-per-seat gate both constrain spawn', () => {
  expect(decideSpawn({ seat: 'TC', running: 3, caps: { TC: 8 } })).toEqual({ allow: true, reason: 'within-cap', cap: 4 });
  expect(decideSpawn({ seat: 'TC', running: 4, caps: { TC: 8 } })).toEqual({ allow: false, reason: 'seat-cap', cap: 4 });
  expect(decideSpawn({ seat: 'OP', running: 1, caps: { OP: 2 } })).toEqual({ allow: true, reason: 'within-cap', cap: 2 });
  expect(decideSpawn({ seat: 'OP', running: 2, caps: { OP: 2 } })).toEqual({ allow: false, reason: 'seat-cap', cap: 2 });
  expect(decideSpawn({ seat: 'UX', running: 4 })).toEqual({ allow: false, reason: 'seat-cap', cap: 4 });
});

test('a lower release gate wins; a higher gate cannot raise the configured cap', () => {
  expect(decideSpawn({ seat: 'MK', running: 1, caps: { MK: 6 }, gate: { MK: 2 } })).toEqual({ allow: true, reason: 'within-cap', cap: 2 });
  expect(decideSpawn({ seat: 'MK', running: 2, caps: { MK: 6 }, gate: { MK: 2 } })).toEqual({ allow: false, reason: 'seat-cap', cap: 2 });
  expect(decideSpawn({ seat: 'OP', running: 3, caps: { OP: 3 }, gate: { OP: 20 } })).toEqual({ allow: false, reason: 'seat-cap', cap: 3 });
  expect(decideSpawn({ seat: 'TC', running: 0, caps: { TC: 0 }, gate: { TC: 8 } })).toEqual({ allow: false, reason: 'seat-cap', cap: 0 });
  expect(decideSpawn({ seat: 'TC', running: 0, gate: { TC: 0 } })).toEqual({ allow: false, reason: 'seat-cap', cap: 0 });
});

test('missing or invalid running measurement fails closed even below a free cap', () => {
  for (const running of [undefined, null, NaN, -1, Infinity, 0.5]) {
    expect(decideSpawn({ seat: 'TC', running, caps: { TC: 8 } })).toEqual({ allow: false, reason: 'unknown-running', cap: 4 });
  }
});

test('seat budgets remain independent of other seats in caps and gate', () => {
  expect(decideSpawn({ seat: 'UX', running: 3, caps: { UX: 6, TC: 1 }, gate: { TC: 0 } }))
    .toEqual({ allow: true, reason: 'within-cap', cap: 4 });
  expect(decideSpawn({ seat: 'TC', running: 0, caps: { UX: 6, TC: 1 }, gate: { TC: 0 } }))
    .toEqual({ allow: false, reason: 'seat-cap', cap: 0 });
});

test('invalid cap inputs cannot permit a spawn', () => {
  expect(decideSpawn({ seat: 'TC', running: 0, caps: { TC: NaN } })).toEqual({ allow: false, reason: 'seat-cap', cap: 0 });
  expect(decideSpawn({ seat: 'TC', running: 0, gate: { TC: -1 } })).toEqual({ allow: false, reason: 'seat-cap', cap: 0 });
});
