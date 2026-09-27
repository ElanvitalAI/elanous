import { expect, test } from 'bun:test';
import { decideTick, initialWatchState, type WatchState } from './role-watch.js';
import type { RoleLeaseDoc } from './role-lease.js';
import type { RoleObjectRead } from '../cli/role-cli.js';

function memory() {
  let doc: RoleLeaseDoc | undefined;
  let gen = 0;
  const read = (): RoleObjectRead => doc ? { kind: 'present', text: JSON.stringify(doc), gen: String(gen) } : { kind: 'absent' };
  const write = (next: RoleLeaseDoc, ifGen: string) => {
    if (String(gen) !== ifGen) return false;
    doc = next; gen++;
    return true;
  };
  return { read, write, get doc() { return doc; }, get gen() { return gen; } };
}

function machine(me: string, store: ReturnType<typeof memory>, beforeWrite?: () => void, rank?: number) {
  let state: WatchState = initialWatchState;
  const events: string[] = [];
  const tick = (now = 100, takeoverTicks = 5) => {
    const d = decideTick(state, store.read(), { me, rank, takeoverTicks, now });
    state = d.state;
    if (d.doc) beforeWrite?.();
    const event = d.doc ? store.write(d.doc, d.ifGen!) ? d.action : 'cas-rejected' : d.action;
    if (event === 'cas-rejected') state = initialWatchState;
    else if (d.doc) state = { generation: d.doc.generation, unchangedTicks: 0, absentTicks: 0 };
    events.push(event);
    return d;
  };
  return { tick, events };
}

test('two machines claim, renew for ten ticks, stall, take over at rank times five and never auto-return', () => {
  const store = memory(), mbp = machine('mbp', store, undefined, 1), node-b = machine('node-b', store, undefined, 2);
  mbp.tick(); node-b.tick();
  expect(store.doc?.holder).toBe('mbp');
  expect(node-b.events).toEqual(['observe']);
  for (let i = 0; i < 10; i++) { mbp.tick(); node-b.tick(); }
  expect(store.doc?.holder).toBe('mbp');
  expect(node-b.events).not.toContain('takeover');
  for (let i = 0; i < 9; i++) expect(node-b.tick().action).toBe('observe');
  expect(node-b.tick().action).toBe('takeover');
  expect(store.doc).toMatchObject({ holder: 'node-b', state: 'held' });
  expect(mbp.tick().action).toBe('observe');
  expect(store.doc?.holder).toBe('node-b');
  expect(store.doc?.generation).toBe(store.gen);
});

test('intervening renewal defeats takeover CAS; candidate resets observation', () => {
  const store = memory(), mbp = machine('mbp', store, undefined, 1);
  const node-b = machine('node-b', store, () => mbp.tick(), 2);
  mbp.tick();
  for (let i = 0; i < 10; i++) expect(node-b.tick().action).toBe('observe');
  expect(node-b.tick().action).toBe('takeover');
  expect(node-b.events.at(-1)).toBe('cas-rejected');
  expect(store.doc?.holder).toBe('mbp');
  expect(node-b.tick().action).toBe('observe');
});

test('60-second observer before every 60-second renewal cannot take over after one unchanged read', () => {
  const store = memory(), mbp = machine('mbp', store, undefined, 1), node-b = machine('node-b', store, undefined, 2);
  mbp.tick(0);
  node-b.tick(0, 2);
  for (let minute = 1; minute <= 10; minute++) {
    const beforeRenew = node-b.tick(minute * 60_000, 2);
    expect(beforeRenew.action).toBe('observe');
    expect(store.doc?.holder).toBe('mbp');
    mbp.tick(minute * 60_000 + 1, 2);
  }
  expect(node-b.events).not.toContain('takeover');
  expect(store.doc?.holder).toBe('mbp');
  expect(() => node-b.tick(11 * 60_000 - 1, 1)).toThrow('takeover-ticks must be at least 2');
  expect(store.doc?.holder).toBe('mbp');
});

test('pending handoff only recipient accepts; corrupt or unreadable lease never takes over', () => {
  const store = memory(), mbp = machine('mbp', store, undefined, 1), node-b = machine('node-b', store, undefined, 2);
  expect(node-b.tick().action).toBe('observe');
  expect(store.doc).toBeUndefined();
  mbp.tick();
  store.write({ holder: 'node-b', from: 'mbp', state: 'handing-off', generation: 2, renewedAt: 10 }, String(store.gen));
  for (let i = 0; i < 10; i++) expect(mbp.tick().action).toBe('observe');
  expect(store.doc).toMatchObject({ state: 'handing-off', holder: 'node-b' });
  expect(node-b.tick().action).toBe('accept');
  expect(store.doc).toMatchObject({ holder: 'node-b', state: 'held' });
  const cfg = { me: 'node-b', rank: 2, takeoverTicks: 5, now: 0 };
  expect(() => decideTick(initialWatchState, { kind: 'unmeasured', why: 'offline' }, cfg)).toThrow('offline');
  expect(() => decideTick(initialWatchState, { kind: 'present', text: '{', gen: '3' }, cfg)).toThrow('invalid lease JSON');
});

test('absent seat candidates claim at their own rank threshold; noncandidate never claims', () => {
  for (const [rank, threshold] of [[1, 1], [2, 3], [3, 6]] as const) {
    let state = initialWatchState;
    for (let tick = 1; tick <= threshold; tick++) {
      const decision = decideTick(state, { kind: 'absent' }, { me: `node-${rank}`, rank, takeoverTicks: 3, now: tick });
      expect(decision.action).toBe(tick === threshold ? 'claim' : 'observe');
      state = decision.state;
    }
  }
  let state = initialWatchState;
  for (let tick = 0; tick < 12; tick++) {
    const d = decideTick(state, { kind: 'absent' }, { me: 'edge', takeoverTicks: 3, now: tick });
    expect(d.action).toBe('observe'); state = d.state;
  }
  expect(() => decideTick(initialWatchState, { kind: 'absent' }, { me: 'invalid', rank: 100, takeoverTicks: 3, now: 0 }))
    .toThrow('rank must be an integer from 1 to 99');
});

test('stalled held lease is taken over at rank times takeoverTicks only by candidates', () => {
  const read: RoleObjectRead = { kind: 'present', gen: '7', text: JSON.stringify({ holder: 'other', generation: 7, state: 'held', renewedAt: 0 }) };
  for (const rank of [2, 3, undefined]) {
    let state = initialWatchState;
    for (let unchanged = 0; unchanged <= 12; unchanged++) {
      const d = decideTick(state, read, { me: 'node', rank, takeoverTicks: 3, now: 10 });
      expect(d.action).toBe(rank !== undefined && unchanged >= rank * 3 ? 'takeover' : 'observe');
      state = d.state;
    }
  }
});
