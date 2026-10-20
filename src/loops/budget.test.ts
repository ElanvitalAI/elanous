import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calculateSeatBaseShares, budgetTrafficTick, computeTrafficMetrics24h, decideSpawn, readTrafficSamples24h, recordTrafficSample24h, SEAT_CAP_STALE_RUN_MINUTES, SEAT_CAP_UNKNOWN_SEAT_CAP, seatCapDetails, seatCapExclusion, seatCapReason } from './budget.js';
import type { TrafficSeatRow } from './orchestrator/traffic.js';

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

describe('calculateSeatBaseShares minShare (CAP-DYN seat minimum)', () => {
  const yellow = (owner: string) => ({ id: owner, title: owner, owner, status: 'yellow' as const });

  test('minShare 2 with weights TC 20 / MK 1 over 10 slots gives MK at least 2 and sums to 10', () => {
    const currentRound = Array.from({ length: 10 }, () => yellow('TC'));
    const result = calculateSeatBaseShares({ totalSlots: 10, currentRound, nextRound: [yellow('MK')],
      seatCaps: { OP: 4, TC: 10, MK: 6, UX: 6 }, minShare: 2 });
    expect(result.MK).toBeGreaterThanOrEqual(2);
    expect(result.OP + result.TC + result.MK + result.UX).toBe(10);
    expect(result).toEqual({ OP: 0, TC: 8, MK: 2, UX: 0 });
  });

  test('omitting minShare keeps the weighted-only result unchanged', () => {
    const args = { totalSlots: 8, currentRound: [yellow('MK'), yellow('TC')], nextRound: [yellow('OP')],
      seatCaps: { OP: 2, TC: 4, MK: 6, UX: 2 } };
    expect(calculateSeatBaseShares(args)).toEqual({ OP: 2, TC: 3, MK: 3, UX: 0 });
    expect(calculateSeatBaseShares({ ...args, minShare: 0 })).toEqual(calculateSeatBaseShares(args));
  });

  test('minimums exceeding totalSlots fill largest-weight seats first and never exceed the pool', () => {
    const result = calculateSeatBaseShares({ totalSlots: 4,
      currentRound: [yellow('TC'), yellow('TC'), yellow('MK'), yellow('OP')], nextRound: [yellow('MK')],
      seatCaps: { OP: 4, TC: 8, MK: 6, UX: 4 }, minShare: 2 });
    expect(result).toEqual({ OP: 0, TC: 2, MK: 2, UX: 0 });
    expect(result.OP + result.TC + result.MK + result.UX).toBe(4);
  });

  test('a seat without yellow cells never receives a minimum', () => {
    const result = calculateSeatBaseShares({ totalSlots: 10, currentRound: [yellow('TC')], nextRound: [],
      seatCaps: { OP: 4, TC: 10, MK: 6, UX: 6 }, minShare: 2 });
    expect(result).toEqual({ OP: 0, TC: 10, MK: 0, UX: 0 });
  });

  test('a floor is clipped by the seat cap and invalid minShare fails closed', () => {
    const args = { totalSlots: 12, currentRound: [yellow('TC'), yellow('TC'), yellow('MK')], nextRound: [],
      seatCaps: { OP: 4, TC: 10, MK: 2, UX: 4 } };
    expect(calculateSeatBaseShares({ ...args, minShare: 5 })).toEqual({ OP: 0, TC: 10, MK: 2, UX: 0 });
    expect(() => calculateSeatBaseShares({ ...args, minShare: -1 })).toThrow(RangeError);
    expect(() => calculateSeatBaseShares({ ...args, minShare: 1.5 })).toThrow(RangeError);
  });
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

test('24h metrics aggregate utilization, wait and preemption over the verbatim sample journal', () => {
  const root = mkdtempSync(join(tmpdir(), 'budget-24h-'));
  try {
    const now = new Date('2026-10-18T03:00:00Z');
    const row = (over: Partial<TrafficSeatRow>): TrafficSeatRow => ({
      seat: 'TC', running: 2, cap: 4, baseShare: 1, borrowed: 0, lent: 0,
      launchCap: 2, idleFor: null, idle: false, nextCell: null, ...over,
    });
    recordTrafficSample24h(root, {
      at: new Date(now.getTime() - 60 * 60_000).toISOString(),
      seats: [row({ running: 2, cap: 4, borrowed: 1, lent: 0 })],
    });
    recordTrafficSample24h(root, {
      at: now.toISOString(),
      seats: [row({ running: 1, cap: 4, idle: true, idleFor: 7, nextCell: { id: 'c1', title: 't', owner: 'TC/x', status: 'yellow' } })],
    });
    // 창 밖 관측은 24h 창에서 제외된다
    recordTrafficSample24h(root, {
      at: new Date(now.getTime() - 30 * 24 * 60 * 60_000).toISOString(),
      seats: [row({ running: 4 })],
    });
    const samples = readTrafficSamples24h(root, now);
    expect(samples).toHaveLength(2);
    const metrics = computeTrafficMetrics24h(samples);
    expect(metrics.running).toBe(3);
    expect(metrics.capacity).toBe(8);
    expect(metrics.utilizationRate).toBeCloseTo(0.375);
    expect(metrics.meanWaitMinutes).toBe(7);
    expect(metrics.waitSamples).toBe(1);
    expect(metrics.preemptedSeatTicks).toBe(1);
    expect(metrics.sampledTicks).toBe(2);
    expect(metrics.firstSampleAt).not.toBeNull();
    expect(metrics.lastSampleAt).toBe(now.toISOString());
    // 빈 저널: 지표는 영이 아니라 관측 부재(0 · null)다
    const empty = computeTrafficMetrics24h([]);
    expect(empty.utilizationRate).toBe(0);
    expect(empty.meanWaitMinutes).toBeNull();
    expect(empty.preemptedSeatTicks).toBe(0);
    expect(empty.sampledTicks).toBe(0);
    // 좁힌 창: 30분 창은 1시간 전 샘플을 자른다
    expect(readTrafficSamples24h(root, now, 30)).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
