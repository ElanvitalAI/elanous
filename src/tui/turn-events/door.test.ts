import { describe, expect, test } from 'bun:test';
import type { DoorReservation, TurnEvent } from '../../turn-capsule/contract.js';
import { createTurnDoor } from './door.js';

function fixture(opts: { typing?: string | null } = {}) {
  let typing: string | null = opts.typing ?? null;
  const offers: string[] = [];
  const logs: Array<[string, Record<string, unknown>]> = [];
  const door = createTurnDoor({
    humanFirst: () => typing,
    onOffer: (reason) => { offers.push(reason); },
    now: () => 1000,
    log: (event, data) => { logs.push([event, data]); },
  });
  return { door, offers, logs, setTyping: (next: string | null) => { typing = next; } };
}

function held(result: ReturnType<ReturnType<typeof createTurnDoor>['reserve']>): DoorReservation {
  if (!result.ok) throw new Error(`expected a reservation, got ${result.refusal}`);
  return result.reservation;
}

const MAIL: TurnEvent = { id: 'ev-1', source: 'mail', dedupeKey: 'msg:42', arrivedAt: 1, text: 'mail 42' };

describe('createTurnDoor — reserve is synchronous and single', () => {
  test('two reserves on an idle door: the first holds, the second is refused busy', () => {
    const { door } = fixture();
    const first = door.reserve();
    const second = door.reserve();
    expect(first).toEqual({ ok: true, reservation: { token: 'door-1', reservedAt: 1000 } });
    expect(second).toEqual({ ok: false, refusal: 'busy' });
    expect(door.busy()).toBe(true);
    expect(door.state()).toBe('reserved');
  });

  test('a person typing refuses an automatic reserve with human-first and leaves the door idle', () => {
    const { door } = fixture({ typing: 'buffer' });
    expect(door.reserve()).toEqual({ ok: false, refusal: 'human-first' });
    expect(door.state()).toBe('idle');
    expect(door.bellPending()).toBe(true);
  });

  test('CAPSULE-C2-FU: every reservation is logged with its token and who took it (turn-life correlation)', () => {
    const { door, logs } = fixture();
    door.reserve();
    door.reserveForHuman();
    expect(logs.filter(([event]) => event === 'door-reserved')).toEqual([
      ['door-reserved', { token: 'door-1', by: 'auto' }],
      ['door-reserved', { token: 'door-2', by: 'human' }],
    ]);
  });

  test('reserve → start → end walks idle → reserved → running → idle', () => {
    const { door } = fixture();
    const r = held(door.reserve());
    door.start(r, [MAIL]);
    expect(door.state()).toBe('running');
    door.end(r, 'responded');
    expect(door.state()).toBe('idle');
    expect(door.busy()).toBe(false);
  });

  test('end before start is refused and the door stays reserved', () => {
    const { door, logs } = fixture();
    const r = held(door.reserve());
    door.end(r, 'responded');
    expect(door.state()).toBe('reserved');
    expect(logs).toContainEqual(['door-end-refused', { token: 'door-1', outcome: 'responded', state: 'reserved' }]);
  });

  test('release returns a reservation that started nothing; a released token cannot start', () => {
    const { door, logs } = fixture();
    const r = held(door.reserve());
    door.release(r);
    expect(door.state()).toBe('idle');
    door.start(r, []);
    expect(door.state()).toBe('idle');
    expect(logs).toContainEqual(['door-start-refused', { token: 'door-1', why: 'not-held', state: 'idle' }]);
  });
});

describe('createTurnDoor — a person goes first', () => {
  test('reserveForHuman ignores typing (it is the person) and holds the door', () => {
    const { door } = fixture({ typing: 'unread-keys' });
    expect(door.reserveForHuman()).toEqual({ ok: true, reservation: { token: 'door-1', reservedAt: 1000 } });
  });

  test('reserveForHuman replaces an automatic reservation that has not started; the old holder no longer holds', () => {
    const { door, logs } = fixture();
    const auto = held(door.reserve());
    const human = held(door.reserveForHuman());
    expect(human.token).toBe('door-2');
    expect(door.holds(auto)).toBe(false);
    expect(door.holds(human)).toBe(true);
    door.start(auto, [MAIL]);
    expect(door.state()).toBe('reserved');
    expect(logs).toContainEqual(['door-superseded', { token: 'door-1', by: 'human' }]);
  });

  test('a running turn is not replaced: reserveForHuman is refused busy', () => {
    const { door } = fixture();
    const r = held(door.reserve());
    door.start(r, [MAIL]);
    expect(door.reserveForHuman()).toEqual({ ok: false, refusal: 'busy' });
  });
});

describe('createTurnDoor — offers are never dropped (one bell)', () => {
  test('an idle door with no typing hands the offer to the opener', () => {
    const { door, offers } = fixture();
    door.offer('event');
    expect(offers).toEqual(['event']);
  });

  test('three offers while busy ring once, as turn-end, when the turn ends', () => {
    const { door, offers } = fixture();
    const r = held(door.reserve());
    door.start(r, []);
    door.offer('event');
    door.offer('watchdog');
    door.offer('event');
    expect(offers).toEqual([]);
    door.end(r, 'responded');
    expect(offers).toEqual(['turn-end']);
    expect(door.bellPending()).toBe(false);
  });

  test('an offer held for a typing person rings after that person’s turn ends', () => {
    const { door, offers, setTyping } = fixture({ typing: 'quiet-window' });
    door.offer('boot');
    expect(offers).toEqual([]);
    const human = held(door.reserveForHuman());
    setTyping(null);
    door.start(human, []);
    door.end(human, 'responded');
    expect(offers).toEqual(['turn-end']);
  });

  test('a superseded automatic offer rings again after the person’s turn (loss 0)', () => {
    const { door, offers } = fixture();
    held(door.reserve());
    const human = held(door.reserveForHuman());
    door.start(human, []);
    door.end(human, 'cancelled');
    expect(offers).toEqual(['turn-end']);
  });

  test('an opener that reserves and releases inside the ring does not loop', () => {
    let calls = 0;
    const door = createTurnDoor({
      humanFirst: () => null,
      onOffer: () => {
        calls += 1;
        const res = door.reserve();
        if (res.ok) door.release(res.reservation);
      },
    });
    const r = door.reserve();
    if (!r.ok) throw new Error('reserve');
    door.offer('event');
    door.release(r.reservation);
    expect(calls).toBe(1);
    expect(door.state()).toBe('idle');
  });
});

describe('createTurnDoor — CAPSULE-C2-FU: human-first holds automatic events only', () => {
  test('a person typing holds the offer, but not when the next opener is a queued person line', () => {
    let nextIsHuman = false;
    const offers: string[] = [];
    const door = createTurnDoor({ humanFirst: () => 'quiet-window', nextIsHuman: () => nextIsHuman,
      onOffer: (reason) => { offers.push(reason); }, now: () => 1000 });
    door.offer('event');
    expect(offers).toEqual([]);
    expect(door.bellPending()).toBe(true);
    nextIsHuman = true;
    door.offer('event');
    expect(offers).toEqual(['event']);
    expect(door.reserve()).toEqual({ ok: false, refusal: 'human-first' });
  });
});
