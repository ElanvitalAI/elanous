// STEWARD-R1-ROSTER-RANK-JSON — the steward graph persists its snapshot as JSON between nodes (r0 → r1 …). #40654 put a
// Map (OP's roster rank) into `snapshot.pull.rosterRank`; `JSON.stringify(new Map())` is `{}`, so from 11-28 03:30Z every
// live R1 tick died on «rank?.get is not a function» and the graph never reached x (beacon · GUARDIAN-HAND-SLA · digest):
// 14 ticks in a row, ✋ at GUARDIAN unanswered 38–113 min. Expectations are literals (rule 11).
import { describe, expect, test } from 'bun:test';
import { comparePull, legacyPullPolicy, rosterRank, rosterRankOf, rosterRankRecord } from '../../kit/work-pull/index.js';
import { emptyScopeState, movableCells, DEFAULT_LIVE_R1, type Snapshot } from './model.js';

const NOW = Date.parse('2026-11-28T03:30:00.000Z');
const ago = (min: number): string => new Date(NOW - min * 60_000).toISOString();

function snapWith(rank: unknown): Snapshot {
  return {
    nowMs: NOW, hq: 'OP', coordinators: ['TC'], parent: { TC: 'OP', 'TC-H-CX-1': 'TC' },
    seats: [{ seat: 'TC-H-CX-1', activity: 'idle', idleForMs: 30 * 60_000 }, { seat: 'OP', activity: 'working', idleForMs: null }],
    version: '0.3.39',
    cells: [
      { id: 'ROSTER-C', title: 'c', status: 'yellow', owner: 'OP', priority: 'P1', updatedAt: ago(300) },
      { id: 'ROSTER-A', title: 'a', status: 'yellow', owner: 'OP', priority: 'P1', updatedAt: ago(200) },
      { id: 'ROSTER-B', title: 'b', status: 'yellow', owner: 'OP', priority: 'P1', updatedAt: ago(100) },
    ],
    prs: [], merged: [], receipts: [], verdicts: [], hosts: [], utilAgeMs: 0, openHands: [], sourceErrors: [],
    pull: { policy: legacyPullPolicy(), ...(rank === undefined ? {} : { rosterRank: rank as Record<string, number> }) },
  } as Snapshot;
}

// The snapshot as the next graph node reads it: written to the run file, parsed back.
const throughRunFile = (s: Snapshot): Snapshot => JSON.parse(JSON.stringify(s)) as Snapshot;
const order = (s: Snapshot): string[] => movableCells(s, 'OP', emptyScopeState(), DEFAULT_LIVE_R1).map((c) => c.id);

describe('roster rank survives the run file', () => {
  const ledger = { version: '0.3.39', cells: ['ROSTER-B', 'ROSTER-A', 'ROSTER-C'] };

  test('11-28 03:30Z shape: a Map that went through JSON (`{}`) no longer throws — unranked order (oldest first)', () => {
    const broken = throughRunFile(snapWith(rosterRank(ledger, '0.3.39')));
    expect(broken.pull?.rosterRank).toEqual({});
    expect(order(broken)).toEqual(['ROSTER-C', 'ROSTER-A', 'ROSTER-B']);
  });

  test('the record form (what sources.ts now writes) keeps OP\'s roster order across the run file', () => {
    const map = rosterRank(ledger, '0.3.39')!;
    expect(order(throughRunFile(snapWith(rosterRankRecord(map))))).toEqual(['ROSTER-B', 'ROSTER-A', 'ROSTER-C']);
    // …and the in-process Map orders the same
    expect(order(snapWith(map))).toEqual(['ROSTER-B', 'ROSTER-A', 'ROSTER-C']);
  });

  test('rosterRankOf: Map · record · missing id · malformed value · null', () => {
    expect(rosterRankOf(new Map([['X', 2]]), 'X')).toBe(2);
    expect(rosterRankOf({ X: 0 }, 'X')).toBe(0);
    expect(rosterRankOf({ X: 0 }, 'Y')).toBe(Number.POSITIVE_INFINITY);
    expect(rosterRankOf({ X: 'first' } as unknown as Record<string, number>, 'X')).toBe(Number.POSITIVE_INFINITY);
    expect(rosterRankOf(null, 'X')).toBe(Number.POSITIVE_INFINITY);
    expect(rosterRankOf({ toString: 1 } as unknown as Record<string, number>, 'hasOwnProperty')).toBe(Number.POSITIVE_INFINITY);
  });

  test('comparePull takes either shape', () => {
    const p = legacyPullPolicy();
    expect(comparePull({ id: 'A', priority: 'P1' }, { id: 'B', priority: 'P1' }, p, { A: 1, B: 0 })).toBe(1);
    expect(comparePull({ id: 'A', priority: 'P1' }, { id: 'B', priority: 'P1' }, p, new Map([['A', 0]]))).toBe(-1);
  });
});
