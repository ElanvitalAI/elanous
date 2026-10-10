import { describe, expect, test } from 'bun:test';
import { calculateSeatBaseShares, budgetTrafficTick, decideSpawn, SEAT_CAP_STALE_RUN_MINUTES, SEAT_CAP_UNKNOWN_SEAT_CAP, seatCapDetails, seatCapExclusion, seatCapReason } from './budget.js';

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

test('cap provenance orders the winner first, preserves ties, and marks unreadable values ?', () => {
  const smallerGate = seatCapDetails({ seat: 'TC', caps: { TC: 10 }, gate: { TC: 4 } });
  expect(smallerGate).toEqual({ cap: 4, seatCaps: 10, releaseGate: 4, winners: ['releaseGate'] });
  expect(seatCapReason('TC', 13, smallerGate)).toBe('seat TC: 13/4 (releaseGate.TC=4 · seatCaps.TC=10)');
  const smallerSeat = seatCapDetails({ seat: 'TC', caps: { TC: 2 }, gate: { TC: 7 } });
  expect(seatCapReason('TC', 2, smallerSeat)).toBe('seat TC: 2/2 (seatCaps.TC=2 · releaseGate.TC=7)');
  const tie = seatCapDetails({ seat: 'TC', caps: { TC: 4 }, gate: { TC: 4 } });
  expect(tie.winners).toEqual(['releaseGate', 'seatCaps']);
  expect(seatCapReason('TC', 4, tie)).toBe('seat TC: 4/4 (releaseGate.TC=4 · seatCaps.TC=4)');
  const unreadable = seatCapDetails({ seat: 'TC', caps: { TC: NaN }, gate: { TC: 4 } });
  expect(unreadable).toEqual({ cap: 0, seatCaps: '?', releaseGate: 4, winners: [] });
  expect(seatCapReason('TC', 0, unreadable)).toBe('seat TC: 0/0 (releaseGate.TC=4 · seatCaps.TC=?)');
  expect(decideSpawn({ seat: 'TC', running: 0, caps: { TC: NaN }, gate: { TC: 4 } }).allow).toBe(false);
});

test('injected cap is an independent candidate that cannot raise the configured limit', () => {
  const higher = { seat: 'TC' as const, caps: { TC: 2 }, gate: { TC: 7 }, injectedCap: 10 };
  expect(decideSpawn({ ...higher, running: 2 })).toEqual({ allow: false, reason: 'seat-cap', cap: 2 });
  expect(seatCapDetails(higher)).toEqual({ cap: 2, seatCaps: 2, releaseGate: 7, injectedCap: 10, winners: ['seatCaps'] });
  expect(seatCapReason('TC', 2, seatCapDetails(higher))).toBe('seat TC: 2/2 (seatCaps.TC=2 · releaseGate.TC=7 · injectedCap.TC=10)');
  const lower = seatCapDetails({ ...higher, injectedCap: 1 });
  expect(lower.winners).toEqual(['injectedCap']);
  expect(seatCapReason('TC', 1, lower)).toBe('seat TC: 1/1 (injectedCap.TC=1 · releaseGate.TC=7 · seatCaps.TC=2)');
  const unknown = seatCapDetails({ ...higher, injectedCap: NaN });
  expect(unknown).toEqual({ cap: 0, seatCaps: 2, releaseGate: 7, injectedCap: '?', winners: [] });
  expect(seatCapReason('TC', 0, unknown)).toBe('seat TC: 0/0 (releaseGate.TC=7 · seatCaps.TC=2 · injectedCap.TC=?)');
});

test('invalid cap inputs cannot permit a spawn', () => {
  expect(decideSpawn({ seat: 'TC', running: 0, caps: { TC: NaN } })).toEqual({ allow: false, reason: 'seat-cap', cap: 0 });
  expect(decideSpawn({ seat: 'TC', running: 0, gate: { TC: -1 } })).toEqual({ allow: false, reason: 'seat-cap', cap: 0 });
});

test('shared resource loop assigns weighted shares and retains physical caps above the spawn default gate', () => {
  const caps = { OP: 2, TC: 4, MK: 6, UX: 2 };
  const yellow = (owner: string) => ({ id: owner, title: owner, owner, status: 'yellow' as const });
  expect(calculateSeatBaseShares({ totalSlots: 8, currentRound: [yellow('MK'), yellow('TC')],
    nextRound: [yellow('OP')], seatCaps: caps })).toEqual({ OP: 2, TC: 3, MK: 3, UX: 0 });
  const result = budgetTrafficTick({ processes: [{ seat: 'MK', command: 'bun bin/elanous.mjs harness ask goal', elapsedSeconds: 2400 }],
    now: new Date('2026-10-05T00:00:00Z'), caps, openCells: [yellow('MK')], nextRound: [], totalSlots: 12 });
  expect(result.seats[2]).toMatchObject({ seat: 'MK', cap: 6, baseShare: 6, running: 1, launchCap: 6, idle: true });
});

test('observation retains a pending MK cell with zero running even when launch approval is false', () => {
  const input = { now: new Date('2026-10-05T00:00:00Z'), caps: { OP: 2, TC: 4, MK: 6, UX: 2 },
    processes: [], openCells: [{ id: 'MK-WAIT', title: 'waiting', owner: 'MK', status: 'yellow' as const }],
    nextRound: [], totalSlots: 0 };
  const scheduled = budgetTrafficTick(input).seats[2];
  expect(scheduled).toMatchObject({ running: 0, idle: false, nextCell: null });
  const observed = budgetTrafficTick({ ...input, retainQueuedCells: true }).seats[2];
  expect(observed).toMatchObject({ running: 0, idle: false, nextCell: input.openCells[0] });
});

describe('seatCapExclusion (SEAT-CAP-STALE)', () => {
  const now = Date.parse('2026-10-06T22:00:00Z');
  const min = 60_000;
  test('a progressing seat run holds its seat; stale, soft-stopped and seat-less runs do not', () => {
    expect(seatCapExclusion({ kind: 'run', seat: 'TC', progressAt: now - 5 * min }, now)).toBeNull();
    expect(seatCapExclusion({ kind: 'run', seat: 'TC' }, now)).toBeNull();
    expect(seatCapExclusion({ kind: 'run', seat: 'TC', progressAt: now - 40 * min }, now)).toEqual({ reason: 'stale', idleMin: 40 });
    expect(seatCapExclusion({ kind: 'run', seat: 'TC', progressAt: now - 40 * min }, now, { staleRunMinutes: 60 })).toBeNull();
    expect(seatCapExclusion({ kind: 'run', seat: 'MK', progressAt: now - min, stopReason: 'harvestable-awaiting-human' }, now))
      .toEqual({ reason: 'soft-stopped', idleMin: 1 });
    expect(seatCapExclusion({ kind: 'run', progressAt: now }, now)).toEqual({ reason: 'unknown-seat', idleMin: 0 });
  });
  test('a launched row without a live process is dead only after the launch grace', () => {
    const row = { kind: 'row' as const, status: 'launched', receipt: 'started' as const, live: false };
    expect(seatCapExclusion({ ...row, launchedAt: now - 10 * min }, now)).toEqual({ reason: 'dead-row', idleMin: 10 });
    expect(seatCapExclusion({ ...row, launchedAt: now - 10_000 }, now)).toBeNull();
    expect(seatCapExclusion({ ...row, launchedAt: now - 10 * min, live: true }, now)).toBeNull();
    expect(seatCapExclusion({ ...row, launchedAt: now - 10 * min, receipt: null }, now)).toEqual({ reason: 'dead-row', idleMin: 10 });
    expect(seatCapExclusion({ ...row }, now)).toBeNull();
    expect(seatCapExclusion({ ...row, status: 'queued', launchedAt: now - 10 * min }, now)).toBeNull();
    expect(SEAT_CAP_STALE_RUN_MINUTES).toBe(30);
    expect(SEAT_CAP_UNKNOWN_SEAT_CAP).toBe(2);
  });
});
