import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/** [턴 근본 배선 #3] C3 (CC-4 #89716): one mail owner shared by the watcher and the plan, behind stage C3 only. */
describe('entry wires the C3 seat-mail adapter', () => {
  const entry = readFileSync(new URL('./entry.ts', import.meta.url), 'utf8');

  test('one adapter is always created (no switch) before the plan runtime', () => {
    const created = entry.indexOf("const seatMailAdapter: SeatMailAdapter | null = createSeatMailAdapter(");
    const plan = entry.indexOf('createSeatMailPlanRuntime({');
    expect(created).not.toBe(-1);
    expect(plan).toBeGreaterThan(created);
    expect(entry.includes("readCapsuleStage('C3'")).toBe(false);
  });

  test('the plan and the watcher get the same adapter; flag off passes none', () => {
    const plan = entry.slice(entry.indexOf('createSeatMailPlanRuntime({'), entry.indexOf('if (booted.runtime)'));
    const watcher = entry.slice(entry.indexOf('createSeatMailArrivalWatcher(process.cwd(), queue, {'), entry.indexOf('seatMailWatcher.start();'));
    expect(plan.includes('...(seatMailAdapter ? { mailAdapter: seatMailAdapter } : {})')).toBe(true);
    expect(watcher.includes('...(seatMailAdapter ? { mailAdapter: seatMailAdapter } : {})')).toBe(true);
  });

  test('the turn end settles by the real outcome only with the adapter; mail-wake folds only with it (D9)', () => {
    expect(entry.includes('if (seatMailAdapter) seatMailWatcher.noteTurnFinished(turnResponded, doorOutcomeOf(doorTurnKind));')).toBe(true);
    expect(entry.includes('else seatMailWatcher.noteTurnFinished(turnResponded);')).toBe(true);
    expect(entry.includes('enableSeatMailWake: seatMailAdapter === null,')).toBe(true);
  });
});
