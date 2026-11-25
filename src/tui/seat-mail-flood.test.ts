import { describe, expect, test } from 'bun:test';
import { createFloodMeter, floodExempt } from './seat-mail-flood.js';
import { keepLive } from './held-expiry.js';
import { seatMailOnArrived } from './seat-mail-on-arrived.js';
import { turnOpenedByMail } from './self-wake-coach-feed.js';

const T0 = Date.parse('2026-11-25T09:00:00.000Z');

describe('SEAT-MAIL-FLOOD meter', () => {
  test('11th ordinary mail in 10 min enters flood; exempt mail still opens; exit below 5', () => {
    const events: string[] = [];
    const meter = createFloodMeter('OP', (e, d) => events.push(`${e}:${d.seat}:${d.rate}`));
    const opened: boolean[] = [];
    for (let i = 0; i < 12; i += 1) opened.push(meter.note({ kind: 'info' }, T0 + i * 10_000).open);
    expect(opened).toEqual([true, true, true, true, true, true, true, true, true, true, false, false]);
    expect(events).toEqual(['enter:OP:11']);
    expect(meter.note({ kind: 'info', crownDirective: '12' }, T0 + 130_000).open).toBe(true);
    expect(meter.note({ kind: 'alert' }, T0 + 140_000).open).toBe(true);
    expect(meter.note({ kind: 'request', origin: { kind: 'human' } }, T0 + 150_000).open).toBe(true);
    expect(meter.note({ kind: 'request' }, T0 + 160_000).open).toBe(false);
    expect(meter.state(T0 + 160_000 + 10 * 60_000).flood).toBe(false);
    expect(events).toEqual(['enter:OP:11', 'exit:OP:0']);
    expect(floodExempt({ kind: 'hand-raise' })).toBe(true);
    expect(floodExempt({ kind: 'request', priority: 1 })).toBe(true);
    expect(floodExempt({ kind: 'request', priority: 0 })).toBe(false);
  });
  test('arrival door: a flooded idle seat does not knock for ordinary mail', () => {
    let knocks = 0;
    let now = T0;
    const door = seatMailOnArrived({ busy: () => false, injectKey: () => { knocks += 1; }, queueWake: 'wake',
      flood: createFloodMeter('OP'), now: () => now });
    for (let i = 0; i < 12; i += 1) { now = T0 + i * 10_000; door([{ msgId: i + 1, seat: 'OP', text: `m${i + 1}`, kind: 'request' }]); }
    expect(knocks).toBe(10);
    door([{ msgId: 99, seat: 'OP', text: 'crown', kind: 'request', crownDirective: '5' }]);
    expect(knocks).toBe(11);
  });
});

describe('DIRECTIVE-EXPIRY held queue', () => {
  test('a held notice whose ledger row lapsed is dropped at flush; unknown / live kept', () => {
    const items = [{ id: 'a', msgId: 1 }, { id: 'b', msgId: 2 }, { id: 'c' }, { id: 'd', msgId: 4 }];
    const expiry = new Map<number, string | null>([[1, '2026-11-25T08:59:00.000Z'], [2, '2026-11-25T11:00:00.000Z'], [4, null]]);
    const r = keepLive(items, (id) => expiry.get(id), T0);
    expect(r.kept.map((x) => x.id)).toEqual(['b', 'c', 'd']);
    expect(r.dropped).toEqual([1]);
  });
});

describe('RAIL30 ② — G folds count on the Q9 meter', () => {
  test('12 folds in 2 min engage flood mode; ordinary mail then stays closed, crown still opens', () => {
    const events: string[] = [];
    const meter = createFloodMeter('OP', (e, d) => events.push(`${e}@${d.rate}`));
    const t0 = 1_800_000_000_000;
    const state = meter.noteFolded(Array.from({ length: 12 }, (_, i) => t0 + i * 10_000), t0 + 120_000);
    expect(state).toEqual({ flood: true, rate: 12 });
    expect(events).toEqual(['enter@12']);
    expect(meter.note({ kind: 'request' }, t0 + 125_000).open).toBe(false);
    expect(meter.note({ kind: 'request', crownDirective: '701' }, t0 + 126_000).open).toBe(true);
  });

  test('turnOpenedByMail: agent mail · msg-wake · a seat-mail notice count; self-wake · goal drive · a person do not', () => {
    expect(turnOpenedByMail({ kind: 'agent' })).toBe(true);
    expect(turnOpenedByMail({ kind: 'system', origin: 'msg-wake' })).toBe(true);
    expect(turnOpenedByMail(undefined, 'seat-mail')).toBe(true);
    expect(turnOpenedByMail({ kind: 'system', origin: 'scheduled' })).toBe(false);
    expect(turnOpenedByMail({ kind: 'system', origin: 'goal-continue' })).toBe(false);
    expect(turnOpenedByMail({ kind: 'human' })).toBe(false);
    expect(turnOpenedByMail(undefined, 'work-pull')).toBe(false);
  });
});
