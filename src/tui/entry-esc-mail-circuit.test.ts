import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { doorOutcomeOf } from './turn-events/door-wire.js';
import { createSeatMailAdapter } from './turn-events/mail-adapter.js';

/**
 * [턴 근본 배선 #5] OP decision ① (TC #91067): an Esc is a cancelled turn, not a failed one — two Escs must not open the
 * mail circuit (a new mail would wait 15–240 s). Real adapter, fake clock; entry hands it the real outcome.
 */
describe('two Escs never park new seat mail', () => {
  const rig = () => {
    let clock = 1_000_000;
    const adapter = createSeatMailAdapter({ now: () => clock });
    return { adapter, tick: (ms: number) => { clock += ms; } };
  };

  test('Esc ×2 (cancelled): circuit stays closed and a new mail is granted at once (≤ 20 s · here 0 s)', () => {
    const { adapter } = rig();
    for (const id of [1, 2]) {
      expect(adapter.claim('notice', [id]).granted).toEqual([id]);
      const settled = adapter.settle('notice', [id], doorOutcomeOf('cancelled'));
      expect(settled.seen).toEqual([]);
      expect(settled.retry).toEqual([id]);
    }
    expect(adapter.circuitOpen('notice')).toBe(false);
    expect(adapter.claim('notice', [3])).toEqual({ granted: [3], duplicate: [], waiting: [] });
  });

  test('contrast — the same two turns as failures open the circuit and park the new mail (the delay OP saw)', () => {
    const { adapter, tick } = rig();
    for (const id of [1, 2]) {
      adapter.claim('notice', [id]);
      adapter.settle('notice', [id], doorOutcomeOf('failed'));
    }
    expect(adapter.circuitOpen('notice')).toBe(true);
    expect(adapter.claim('notice', [3]).waiting).toEqual([3]);
    tick(240_000); // 출처: mail-adapter MAIL_BACKOFF_MAX_MS — past the longest back-off the circuit lets mail through again
    expect(adapter.claim('notice', [3]).granted).toEqual([3]);
  });

  test('entry passes the real turn outcome (Esc = cancelled · stall = stopped) to the watcher’s adapter', () => {
    const entry = readFileSync(new URL('./entry.ts', import.meta.url), 'utf8');
    expect(entry.includes('seatMailWatcher.noteTurnFinished(turnResponded, doorOutcomeOf(doorTurnKind));')).toBe(true);
    expect(entry.includes("doorTurnKind = turnStallHandled && outcome.kind === 'cancelled' ? 'stopped' : outcome.kind;")).toBe(true);
    expect(doorOutcomeOf('cancelled')).toBe('cancelled');
    expect(doorOutcomeOf('stopped')).toBe('stopped');
  });
});
