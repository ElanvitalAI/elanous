import { describe, expect, test } from 'bun:test';
import { FULL_DAY, KPI_LOOP_DAY, runDay, runDedupCase, runPacingCase, runPullWaitingCase } from './federation-day-world.js';

describe('SIM-FEDERATION-DAY', () => {
  test('H4 · the real gate drops a legitimate drive after 5 self-started opens, though 10 mail turns came between', () => {
    const rows = runPacingCase();
    expect(rows.map((r) => r.result)).toEqual([
      'opened', 'opened', 'opened', 'opened', 'opened',
      'Cap pacing:run-cap 5/5 no-retryAt',
      'opened',
      'Cap pacing:run-cap 5/5 no-retryAt',
    ]);
  });

  test('H5 · the real tool loop blocks re-reads of a changing file inside one long turn (none in a 4-round turn)', async () => {
    const [before, after] = await runDedupCase();
    expect(before!.rounds).toBe(4);
    expect(before!.blocked).toEqual([]);
    expect(after!.rounds).toBe(30);
    expect(after!.blocked).toEqual(['Read', 'ListDir', 'Read', 'ListDir', 'Read', 'Read']);
  });

  test('a full day is deterministic per seed and arm', () => {
    const a = runDay('B', 7);
    const b = runDay('B', 7);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.hours).toBe(8);
  });

  test('arm A (before #40092) never drives; arm B drops drives at the pacing run cap', () => {
    const a = runDay('A', 1);
    const b = runDay('B', 1);
    expect(a.seats.OP.driveOpened).toBe(0);
    expect(b.seats.OP.driveRunCapDropped).toBe(27); // seed 1 · 8 h
  });

  test('arm D (retunes) — no duplicate hand wakes, no stale order execution, one steer per incident', () => {
    const d = runDay('D', 1);
    expect(d.dupWakesPerH).toBe(0);
    expect(d.staleExecutions).toBe(0);
    expect(d.incidentSteers).toBe(1);
    expect(d.seats.OP.driveRunCapDropped).toBe(0);
  });

  test('scenario switches turn day events off', () => {
    const quiet = runDay('B', 1, { ...FULL_DAY, hours: 2, flood: false, incident: false, railMigration: false });
    expect(quiet.floodFolded).toBe(0);
    expect(quiet.incidentSteers).toBe(0);
  });

  test('KPI loop · a standing goal with a non-idempotent SeatAssign repeats the same assign; rail 28 (idempotent assign ⊕ live steward refuses foreign assigns) stops it', () => {
    const before = runDay('B', 1, KPI_LOOP_DAY);
    const rail28 = runDay('E', 1, KPI_LOOP_DAY);
    expect(before.maxSameAssignPer20m).toBe(40); // seed 1 · ops 16:46–17:00: MVP-B ×9
    expect(rail28.maxSameAssignPer20m).toBe(1);
    expect(rail28.idempotentNoops).toBe(40);
    expect(rail28.stewardRefusals).toBe(2805);
  });

  test('rail 30 · hands own cells waiting on JUD ⊕ coordinator-owned board: before idles with work; after pulls leader-held cells, no double claim', () => {
    const before = runPullWaitingCase('before', 1);
    const after = runPullWaitingCase('after', 1);
    expect([before.idleWithWorkHandMin, before.claims, before.coordinatorCellClaims, before.stewardWakes]).toEqual([1768, 4, 0, 72]);
    expect([after.idleWithWorkHandMin, after.workNextCalls, after.claims, after.coordinatorCellClaims, after.stewardWakes, after.takeWorkNextNudges]).toEqual([120, 48, 32, 28, 16, 16]);
    expect([before.doubleClaims, after.doubleClaims]).toEqual([0, 0]);
    expect([before.cellsGreen, after.cellsGreen]).toEqual([32, 45]);
  });
});
