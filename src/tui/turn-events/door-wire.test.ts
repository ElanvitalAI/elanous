import { describe, expect, test } from 'bun:test';
import { createEntryTurnDoor, doorOutcomeOf, humanFirstDetail, nextDoorOpener, runDoorTurn } from './door-wire.js';

const facts = (over: Partial<{ draft: string; unread: number; last: number; now: number }> = {}) => ({
  draft: () => over.draft ?? '',
  unreadKeys: () => over.unread ?? 0,
  lastHumanKeyAt: () => over.last ?? 0,
  now: () => over.now ?? 100_000,
});

describe('humanFirstDetail — a person goes first', () => {
  test('draft · unread keys · 10 s quiet window, in that order; otherwise null', () => {
    expect(humanFirstDetail(facts({ draft: 'hi', unread: 2 }))).toBe('buffer');
    expect(humanFirstDetail(facts({ unread: 1 }))).toBe('unread-keys');
    expect(humanFirstDetail(facts({ last: 95_000, now: 100_000 }))).toBe('quiet-window');
    expect(humanFirstDetail(facts({ last: 90_000, now: 100_000 }))).toBeNull();
    expect(humanFirstDetail(facts())).toBeNull();
  });
});

describe('doorOutcomeOf', () => {
  test('completed → responded · cancelled → cancelled · failed or unknown → failed', () => {
    expect(doorOutcomeOf('completed')).toBe('responded');
    expect(doorOutcomeOf('cancelled')).toBe('cancelled');
    expect(doorOutcomeOf('failed')).toBe('failed');
    expect(doorOutcomeOf('stopped')).toBe('stopped');
    expect(doorOutcomeOf(undefined)).toBe('failed');
  });
});

describe('createEntryTurnDoor — the entry holder (C6 shapes)', () => {
  const entry = (typing: () => string | null = () => null) => {
    const offers: string[] = [];
    const holder = createEntryTurnDoor({ humanFirst: typing, onOffer: (reason) => { offers.push(reason); }, now: () => 5 });
    return { holder, offers };
  };

  test('queueWake then Enter before the notice starts: the person runs, the notice turn cannot begin, one turn', () => {
    const { holder, offers } = entry();
    const notice = holder.reserveAuto();
    expect(notice).toEqual({ token: 'door-1', reservedAt: 5 });
    expect(holder.reserveHuman()).toEqual({ token: 'door-2', reservedAt: 5 });
    expect(holder.door.holds(notice!)).toBe(false);
    expect(holder.beginTurn()).toBe(true);
    expect(holder.beginTurn()).toBe(false);
    expect(holder.door.state()).toBe('running');
    holder.endTurn('completed');
    expect(holder.door.state()).toBe('idle');
    expect(offers).toEqual(['turn-end']);
  });

  test('boot backlog while a person types: no automatic reservation, the held offer rings after their turn', () => {
    let typing: string | null = 'buffer';
    const { holder, offers } = entry(() => typing);
    expect(holder.reserveAuto()).toBeNull();
    holder.reserveHuman();
    typing = null;
    expect(holder.beginTurn()).toBe(true);
    holder.endTurn('cancelled');
    expect(offers).toEqual(['turn-end']);
  });

  test('an opener with nothing to start releases its hold; a second release and an idle endTurn are no-ops', () => {
    const { holder } = entry();
    const r = holder.reserveAuto()!;
    holder.releaseIfUnstarted(r);
    holder.releaseIfUnstarted(r);
    holder.endTurn('completed');
    expect(holder.door.state()).toBe('idle');
    expect(holder.beginTurn()).toBe(false);
  });

  test('a started turn is not released by its opener; the turn end frees it', () => {
    const { holder } = entry();
    const r = holder.reserveAuto()!;
    expect(holder.beginTurn()).toBe(true);
    holder.releaseIfUnstarted(r);
    expect(holder.door.state()).toBe('running');
    expect(holder.reserveAuto()).toBeNull();
    holder.endTurn('failed');
    expect(holder.door.busy()).toBe(false);
  });
});

describe('nextDoorOpener — CAPSULE-C2-FU: a queued person line opens first', () => {
  test('person head beats a held notice; then the held notice; then a queued notice; else none', () => {
    expect(nextDoorOpener({ headKind: 'user', hasHeldNotice: true })).toBe('person');
    expect(nextDoorOpener({ headKind: 'user', hasHeldNotice: false })).toBe('person');
    expect(nextDoorOpener({ headKind: 'notice', hasHeldNotice: true })).toBe('held-notice');
    expect(nextDoorOpener({ headKind: null, hasHeldNotice: true })).toBe('held-notice');
    expect(nextDoorOpener({ headKind: 'notice', hasHeldNotice: false })).toBe('queue-notice');
    expect(nextDoorOpener({ headKind: null, hasHeldNotice: false })).toBe('none');
  });

  test('line A queued in a turn, the turn ends inside the quiet window: A is offered at once, not held 10 s', () => {
    const offers: string[] = [];
    const holder = createEntryTurnDoor({ humanFirst: () => 'quiet-window', nextIsHuman: () => true,
      onOffer: (reason) => { offers.push(reason); }, now: () => 5 });
    expect(holder.reserveHuman()).toEqual({ token: 'door-1', reservedAt: 5 });
    expect(holder.beginTurn()).toBe(true);
    holder.door.offer('event');
    holder.endTurn('completed');
    expect(offers).toEqual(['turn-end']);
    expect(holder.reserveAuto()).toBeNull();
    expect(holder.reserveHuman()).toEqual({ token: 'door-2', reservedAt: 5 });
  });
});

describe('runDoorTurn — CAPSULE-C2-FU: a turn start that throws never locks the door', () => {
  const holder = () => createEntryTurnDoor({ humanFirst: () => null, onOffer: () => {}, now: () => 5 });

  test('body throws before busy: rethrown, door idle, the next person turn begins', () => {
    const h = holder();
    expect(h.reserveAuto()).toEqual({ token: 'door-1', reservedAt: 5 });
    expect(() => runDoorTurn(h, () => false, () => { throw new Error('render defect'); })).toThrow('render defect');
    expect(h.door.state()).toBe('idle');
    expect(h.reserveHuman()).toEqual({ token: 'door-2', reservedAt: 5 });
    expect(h.beginTurn()).toBe(true);
  });

  test('body throws after busy: the door stays running for the turn end; refused begin runs no body', () => {
    const h = holder();
    h.reserveAuto();
    expect(() => runDoorTurn(h, () => true, () => { throw new Error('late'); })).toThrow('late');
    expect(h.door.state()).toBe('running');
    let ran = 0;
    expect(runDoorTurn(h, () => true, () => { ran += 1; })).toBe(false);
    expect(ran).toBe(0);
    expect(runDoorTurn(null, () => false, () => { ran += 1; })).toBe(true);
    expect(ran).toBe(1);
  });
});
