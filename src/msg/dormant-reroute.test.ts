// DORMANT-ADDRESS REROUTE — census 11-27: RES ≥100 · REL 19 · REVIEW-2 13 · JUD-2 2 · ORCHESTRATOR ≥100 unread, no tab.
import { expect, test } from 'bun:test';
import { MsgStore } from './msg-store.js';
import { dormantReroute, liveByWake } from './dormant-reroute.js';

const T0 = Date.parse('2026-11-27T08:00:00.000Z');

test('REVIEW-2 / JUD-2 → JUD as a direct row with the rerouted-from ref', () => {
  const r = dormantReroute({ from: 'TC', to: 'REVIEW-2', body: 'review #40100 please', kind: 'request' });
  expect(r).toEqual({ to: 'JUD', refs: ['rerouted-from:REVIEW-2'], body: '[rerouted from REVIEW-2 · no live tab] review #40100 please', digest: false,
    note: 'REVIEW-2 has no live tab — rerouted to JUD' });
  expect(dormantReroute({ from: 'TC', to: 'JUD-2', body: 'x' })?.to).toBe('JUD');
});

test('RES · RES-INFRA → GUARDIAN (the guardian\'s postoffice reads and answers it) as a direct row', () => {
  for (const to of ['RES', 'RES-INFRA']) {
    const r = dormantReroute({ from: 'TC', to, body: 'host node-b slow' });
    expect(r).toEqual({ to: 'GUARDIAN', refs: [`rerouted-from:${to}`], body: `[rerouted from ${to} · no live tab] host node-b slow`, digest: false, note: `${to} has no live tab — rerouted to GUARDIAN` });
  }
});

test('REL · ORCHESTRATOR → OP digest; 🚨 → OP inbox at once', () => {
  for (const to of ['REL', 'ORCHESTRATOR']) {
    const r = dormantReroute({ from: 'TC', to, body: 'host node-b slow' });
    expect(r?.to).toBe('OP');
    expect(r?.digest).toBe(true);
    expect(r?.note).toBe(`${to} has no live tab — rerouted to OP (30-min digest «잠든 수신처»)`);
  }
  expect(dormantReroute({ from: 'TC', to: 'REL', body: '🚨 release blocked' })?.digest).toBe(false);
  expect(dormantReroute({ from: 'TC', to: 'REL', body: 'x', priority: 1 })?.digest).toBe(false);
});

test('never back to the sender (live bug #191271: OP → dormant RES came back to OP)', () => {
  expect(dormantReroute({ from: 'OP', to: 'RES', body: 'node-b disk 95%' })?.to).toBe('GUARDIAN');
  expect(dormantReroute({ from: 'op', to: 'RES-INFRA', body: 'x' })?.to).toBe('GUARDIAN');
  const g = dormantReroute({ from: 'GUARDIAN', to: 'RES', body: 'need RES approval: start aws1' });
  expect(g).toEqual({ to: 'OP', refs: ['rerouted-from:RES'], body: '[rerouted from RES · no live tab] need RES approval: start aws1', digest: true,
    note: 'RES has no live tab — rerouted to OP (30-min digest «잠든 수신처»)' });
  expect(dormantReroute({ from: 'JUD', to: 'REVIEW-2', body: 'x' })?.to).toBe('OP');
  // OP's mail for a box whose only other reader is OP stays where it was addressed
  expect(dormantReroute({ from: 'OP', to: 'REL', body: 'cut 04:00' })).toBeNull();
  expect(dormantReroute({ from: 'OP', to: 'ORCHESTRATOR', body: 'x' })).toBeNull();
  for (const from of ['OP', 'GUARDIAN', 'JUD', 'TC', 'RES-INFRA'])
    for (const to of ['RES', 'RES-INFRA', 'REL', 'ORCHESTRATOR', 'REVIEW-2', 'JUD-2']) {
      const r = dormantReroute({ from, to, body: 'x' });
      if (r) expect(r.to).not.toBe(from);
    }
});

test('live readers, release proofs, self-mail and live seats are not rerouted', () => {
  expect(dormantReroute({ from: 'TC', to: 'JUD', body: 'x' })).toBeNull();
  expect(dormantReroute({ from: 'TC', to: 'OP', body: 'x' })).toBeNull();
  expect(dormantReroute({ from: 'JUD', to: 'REL', body: 'DISPOSITION-ATTEST abc', kind: 'coord' })).toBeNull();
  expect(dormantReroute({ from: 'RES', to: 'RES', body: 'x' })).toBeNull();
  expect(dormantReroute({ from: 'TC', to: 'RES', body: 'x' }, { isLive: (a) => a === 'RES' })).toBeNull();
});

test('end to end: rerouted mail lands in the OP digest «잠든 수신처» section; JUD gets its row', () => {
  let now = T0;
  const store = new MsgStore(':memory:', { now: () => new Date(now) });
  const post = (from: string, to: string, body: string) => {
    const env = { from, to, body, kind: 'request' as const };
    const r = dormantReroute(env);
    return store.post(r ? { ...env, to: r.to, refs: r.refs, body: r.body } : env, { dedupe: true });
  };
  const toGuardian = post('TC', 'RES', 'node-b load 60 — move pregate?');
  expect(toGuardian.to).toBe('GUARDIAN');
  expect(post('UX', 'REL', 'cut note ready').digested).toBe(1);
  expect(post('TC', 'ORCHESTRATOR', 'assign TC next').digested).toBe(2); // OP's own post would stay at ORCHESTRATOR (never back to the sender)
  const jud = post('TC', 'REVIEW-2', 'review #40100');
  expect(jud.to).toBe('JUD');
  expect(store.list('JUD').map((m) => m.refs)).toEqual([['rerouted-from:REVIEW-2']]);
  const urgent = post('TC', 'REL', '🚨 release blocked');
  expect(urgent.id).toBeGreaterThan(0);
  expect(store.list('OP').map((m) => m.body)).toEqual(['[rerouted from REL · no live tab] 🚨 release blocked']);
  expect(store.list('GUARDIAN').map((m) => m.refs)).toEqual([['rerouted-from:RES']]);
  now = T0 + 31 * 60_000;
  const digest = store.flushOpDigestIfDue();
  expect(digest?.body).toContain('잠든 수신처 (no live tab · 2): ORCHESTRATOR 1 · REL 1');
  expect(digest?.body).toContain('  - TC → ORCHESTRATOR: assign TC next');
});

test('liveByWake: a live pane the wake resolver reaches keeps the mail at its address (revived tab · LA-R2)', () => {
  const live = liveByWake({ live: false, readRegistry: () => ({ status: 'ready', registry: { version: 1, seats: [{ address: 'RES', host: 'local', target: 'wR:p1', wake: 'herdr', replyBody: 'agent', optIn: true, runtime: 'codex' }] } }),
    listHerdrPanes: () => [{ paneId: 'wR:p1', status: 'idle' }], listPtys: () => [], readPane: () => null, hasOptIn: () => false });
  expect(dormantReroute({ from: 'TC', to: 'RES', body: 'back' }, { isLive: live })).toBeNull();
  expect(liveByWake({ live: false, readRegistry: () => ({ status: 'ready', registry: { version: 1, seats: [] } }), listHerdrPanes: () => [], listPtys: () => [], readPane: () => null, hasOptIn: () => false })('RES')).toBe(false);
});
