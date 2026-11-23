import { describe, expect, test } from 'bun:test';
import { createSeatMailAdapter, mailTurnEvent } from './mail-adapter.js';

function fixture() {
  let at = 1_000_000;
  const logs: Array<[string, Record<string, unknown>]> = [];
  const life: Array<[string, Record<string, unknown>]> = [];
  const mail = createSeatMailAdapter({ now: () => at, pollMs: 15_000, log: (event, data) => { logs.push([event, data]); },
    turnLifeLog: (event, data) => { life.push([event, data]); } });
  return { mail, logs, life, advance: (ms: number) => { at += ms; }, now: () => at };
}

describe('createSeatMailAdapter — one msgId, one owner (D9)', () => {
  test('the plan absorbed #87012 first: the notice watcher seeing it is a duplicate, not a second turn', () => {
    const { mail, logs } = fixture();
    expect(mail.claim('plan', [87012])).toEqual({ granted: [87012], duplicate: [], waiting: [] });
    expect(mail.claim('notice', [87012, 87013])).toEqual({ granted: [87013], duplicate: [87012], waiting: [] });
    expect(mail.owner(87012)).toBe('plan');
    expect(logs[0]).toEqual(['mail-adapter-duplicate', { path: 'notice', msgIds: [87012], owners: ['plan'] }]);
  });

  test('the same path claiming its own msgId again (next poll) is granted, not a duplicate', () => {
    const { mail } = fixture();
    mail.claim('notice', [5]);
    expect(mail.claim('notice', [5, 5])).toEqual({ granted: [5], duplicate: [], waiting: [] });
  });

  test('answered mail never opens a turn again on any path', () => {
    const { mail } = fixture();
    mail.claim('notice', [7]);
    expect(mail.settle('notice', [7], 'responded')).toEqual({ seen: [7], retry: [], gaveUp: [], retryAt: 1_000_000 });
    expect(mail.claim('notice', [7])).toEqual({ granted: [], duplicate: [7], waiting: [] });
    expect(mail.claim('mail-wake', [7])).toEqual({ granted: [], duplicate: [7], waiting: [] });
    expect(mail.owner(7)).toBe('done');
  });

  test('settle touches only the owning path: a mail-wake turn cannot mark the notice path\'s mail seen', () => {
    const { mail } = fixture();
    mail.claim('notice', [9]);
    expect(mail.settle('mail-wake', [9], 'responded').seen).toEqual([]);
    expect(mail.owner(9)).toBe('notice');
  });

  test('release before any turn frees the msgId for another path, with no attempt counted', () => {
    const { mail } = fixture();
    mail.claim('notice', [11]);
    mail.release('notice', [11]);
    expect(mail.owner(11)).toBeNull();
    expect(mail.claim('plan', [11]).granted).toEqual([11]);
  });
});

describe('createSeatMailAdapter — failed turns back off per path (D10 · L7)', () => {
  test('a failed turn parks its mail for one poll period; claim waits, then due() hands it back', () => {
    const { mail, advance } = fixture();
    mail.claim('notice', [21]);
    expect(mail.settle('notice', [21], 'failed')).toEqual({ seen: [], retry: [21], gaveUp: [], retryAt: 1_015_000 });
    expect(mail.claim('notice', [21])).toEqual({ granted: [], duplicate: [], waiting: [21] });
    expect(mail.due('notice')).toEqual([]);
    advance(15_000);
    expect(mail.due('notice')).toEqual([21]);
    expect(mail.claim('notice', [21]).granted).toEqual([21]);
  });

  test('the second failed turn of the same mail gives it up (left unseen) — never a third turn', () => {
    const { mail, advance } = fixture();
    mail.claim('notice', [22]);
    mail.settle('notice', [22], 'failed');
    advance(15_000);
    mail.claim('notice', [22]);
    expect(mail.settle('notice', [22], 'failed')).toEqual({ seen: [], retry: [], gaveUp: [22], retryAt: 1_045_000 });
    expect(mail.claim('notice', [22])).toEqual({ granted: [], duplicate: [22], waiting: [] });
  });

  test('two failed turns in a row open the path\'s circuit: NEW mail waits too, other paths do not', () => {
    const { mail, advance } = fixture();
    mail.claim('notice', [31]);
    mail.settle('notice', [31], 'failed');
    mail.claim('notice', [32]);
    mail.settle('notice', [32], 'failed');
    expect(mail.circuitOpen('notice')).toBe(true);
    expect(mail.claim('notice', [33])).toEqual({ granted: [], duplicate: [], waiting: [33] });
    expect(mail.claim('plan', [34]).granted).toEqual([34]);
    advance(30_000);
    expect(mail.circuitOpen('notice')).toBe(false);
    expect(mail.claim('notice', [33]).granted).toEqual([33]);
  });

  test('20 failing turns in a row: each mail is retried at most once, the back-off doubles and caps at 240s', () => {
    const { mail, advance, now } = fixture();
    const retries: number[] = [];
    const waits: number[] = [];
    for (let turn = 0; turn < 20; turn += 1) {
      const id = 100 + turn;
      const ids = [...mail.due('notice'), id];
      const { granted } = mail.claim('notice', ids);
      const out = mail.settle('notice', granted, 'failed');
      retries.push(out.retry.length);
      waits.push(out.retryAt - now());
      advance(out.retryAt - now());
    }
    // one retry per turn = the newest mail's single retry; the older one is given up on its second turn
    expect(retries).toEqual(Array.from({ length: 20 }, () => 1));
    expect(waits.slice(0, 6)).toEqual([15_000, 30_000, 60_000, 120_000, 240_000, 240_000]);
    expect(waits.at(-1)).toBe(240_000);
    // every mail that failed twice is given up: nothing is still owned past its second turn
    expect(mail.owner(100)).toBe('done');
  });

  test('cancelled and stopped are not failures: mail is due at once and the circuit stays shut, but only one re-injection (SEAT-MAIL-COALESCE-NOTICE)', () => {
    const { mail } = fixture();
    mail.claim('notice', [41]);
    expect(mail.settle('notice', [41], 'cancelled')).toEqual({ seen: [], retry: [41], gaveUp: [], retryAt: 1_000_000 });
    expect(mail.circuitOpen('notice')).toBe(false);
    expect(mail.due('notice')).toEqual([41]);
    expect(mail.settle('notice', [41], 'stopped')).toEqual({ seen: [], retry: [], gaveUp: [41], retryAt: 1_000_000 });
    expect(mail.owner(41)).toBe('done');
    expect(mail.circuitOpen('notice')).toBe(false);
    expect(mail.due('notice')).toEqual([]);
  });

  test('an answered turn closes the circuit and resets the back-off', () => {
    const { mail } = fixture();
    mail.claim('notice', [51]);
    mail.settle('notice', [51], 'failed');
    mail.claim('notice', [52]);
    mail.settle('notice', [52], 'failed');
    expect(mail.circuitOpen('notice')).toBe(true);
    mail.claim('plan', [53]);
    mail.settle('plan', [53], 'responded');
    expect(mail.circuitOpen('notice')).toBe(true); // another path's answer says nothing about this one
    mail.settle('notice', [], 'responded');
    expect(mail.circuitOpen('notice')).toBe(false);
  });
});

describe('createSeatMailAdapter — ledger read errors retry soon (D10 database is locked)', () => {
  test('1s, 2s, 4s, 8s, then never beyond the 15s poll period; a good read resets', () => {
    const { mail } = fixture();
    expect([1, 2, 3, 4, 5, 6].map(() => mail.readFailed('notice'))).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000]);
    mail.readOk('notice');
    expect(mail.readFailed('notice')).toBe(1_000);
  });
});

describe('createSeatMailAdapter — turn-life events (OBSERVE-TURN-LIFE)', () => {
  test('a duplicate, a failed settle and a read retry each leave one turn-life line with the mail:<id> correlation id', () => {
    const { mail, life } = fixture();
    mail.claim('plan', [61]);
    mail.claim('notice', [61]);
    mail.claim('notice', [62]);
    mail.settle('notice', [62], 'failed');
    mail.readFailed('notice');
    expect(life).toEqual([
      ['turn-life:mail-deduped', { eventId: 'mail:61', msgId: 61, path: 'notice', owner: 'plan' }],
      ['turn-life:mail-backoff', { path: 'notice', outcome: 'failed', eventIds: ['mail:62'], retry: [62], gaveUp: [],
        failures: 1, retryAt: 1_015_000, circuitOpen: false }],
      ['turn-life:mail-read-retry', { path: 'notice', readFailures: 1, inMs: 1_000 }],
    ]);
  });

  test('a throwing turn-life sink never changes the adapter\'s answer', () => {
    const mail = createSeatMailAdapter({ now: () => 0, turnLifeLog: () => { throw new Error('sink down'); } });
    mail.claim('plan', [1]);
    expect(mail.claim('notice', [1])).toEqual({ granted: [], duplicate: [1], waiting: [] });
  });
});

describe('mailTurnEvent', () => {
  test('one dedupe key per msgId; urgent mail ranks above ordinary mail', () => {
    expect(mailTurnEvent({ msgId: 89028, text: 'TC: 당신 칸', arrivedAt: 5, urgent: false }))
      .toEqual({ id: 'mail-89028', source: 'mail', dedupeKey: 'mail:89028', arrivedAt: 5, text: 'TC: 당신 칸' });
    expect(mailTurnEvent({ msgId: 1, text: 'x', arrivedAt: 5, urgent: true }).source).toBe('urgent-mail');
  });
});
