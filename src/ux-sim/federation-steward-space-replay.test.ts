// SIM-STEWARD-SPACE-FLOOD-1125 — the 행정관 graph on the A/B world (seed 20261125) through the real node runner, shadow.
// The 11-25 15:37 shadow tick flooded coordinators (OP escalate 64 · TC 45 · JUD 32). A tick must give: assign/dispatch
// for idle×work matches, defer for capacity, exception rows only for refused/ambiguous work, ≤ 1 card per scope ≤ 10 lines.
// Expected values are literals (rule 11). $SIM_OUT (optional) receives the outcome JSON.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildWorld } from './federation-steward-ab-world.js';
import { runSpaceTick, snapshotFromWorld, sourcesFromSnapshot } from './federation-steward-space-replay.js';

const SEED = 20261125;

describe('steward space on the A/B world', () => {
  test('minute 55: six idle hands are matched, the rest defers, no escalate row, no card over 10 lines', () => {
    const world = buildWorld(SEED);
    const snap = snapshotFromWorld(world, 55 * 60);
    expect(snap.seats.filter((s) => s.activity === 'idle').length).toBe(6);
    const out = runSpaceTick(sourcesFromSnapshot(snap), snap.nowMs);
    if (process.env.SIM_OUT) { mkdirSync(process.env.SIM_OUT, { recursive: true }); writeFileSync(join(process.env.SIM_OUT, 'steward-space-world.json'), JSON.stringify(out, null, 1)); }
    expect(Object.keys(out)).toEqual(['JUD', 'OP', 'TC']);
    for (const scope of Object.values(out)) {
      expect(scope.counts.escalate ?? 0).toBe(0);
      // 출처: 내부 문서 `LOOP-AGENTS` §2 — one exception card ≤ 10 lines (#40086 cap)
      if (scope.card) expect(scope.card.lines).toBeLessThanOrEqual(10);
    }
    // Real matching happened: idle hands got cells or judge work, receipt-less PRs got a pregate slot.
    const matched = Object.values(out).reduce((n, s) => n + (s.counts.assign ?? 0) + (s.counts['judge-assign'] ?? 0) + (s.counts.wake ?? 0), 0);
    const dispatched = Object.values(out).reduce((n, s) => n + (s.counts.dispatch ?? 0), 0);
    // 출처: #40086 — seed 20261125 world at :55 measured assign 4 · judge 2 · dispatch 1; WAKE-OWNER ⊕ PULL default (11-25
    // 16:4x · 17:1x): the three TC hands idle on their own cells are woken there and the free TC hand is nudged to pull
    // (wake 4); no P0/demo cell is left for HQ to push (assign 0).
    expect(matched).toBe(6);
    expect([out.TC?.counts.wake, out.OP?.counts.assign ?? 0, out.JUD?.counts['judge-assign']]).toEqual([4, 0, 2]);
    // 출처: #40086 — same measurement
    expect(dispatched).toBe(1);
  });

  test('a hand that just went idle (status.since 2 min) is not «free» even if its last event is old', () => {
    const world = buildWorld(SEED);
    const snap = snapshotFromWorld(world, 55 * 60);
    const idle = snap.seats.filter((s) => s.activity === 'idle').map((s) => s.seat);
    const fresh = Object.fromEntries(idle.map((seat) => [seat, snap.nowMs - 2 * 60_000]));
    const out = runSpaceTick(sourcesFromSnapshot(snap, fresh), snap.nowMs);
    expect(Object.values(out).reduce((n, s) => n + (s.counts.assign ?? 0) + (s.counts['judge-assign'] ?? 0), 0)).toBe(0);
    expect(Object.values(out).reduce((n, s) => n + (s.counts.escalate ?? 0), 0)).toBe(0);
  });
});
