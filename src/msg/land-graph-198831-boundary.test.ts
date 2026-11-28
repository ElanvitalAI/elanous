import { expect, test } from 'bun:test';
import { MsgStore } from './msg-store.js';

const T0 = Date.parse('2026-11-27T07:00:00.000Z');
for (const seed of [1, 7, 42, 1127]) {
  test(`198831 seed ${seed}: first per PR/reason immediate; repeats folded; urgent direct`, () => {
    let now = T0, state = seed;
    const random = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
    const store = new MsgStore(':memory:', { now: () => new Date(now) });
    const events: Array<{ from: string; body: string; kind: string }> = [];
    for (let i = 0; i < 26; i++) for (let repeat = 0; repeat < 2; repeat++)
      events.push({ from: 'LAND-GRAPH', kind: 'info', body: `[land-graph · stall] #${40100 + i} ready 30+ min` });
    for (let i = 0; i < 18; i++) events.push({ from: 'ORCHESTRATOR', kind: 'info', body: `status ${i}` });
    for (let i = 0; i < 39; i++) events.push({ from: 'TC', kind: 'report', body: `seat ${i}` });
    events.push({ from: 'LAND-GRAPH', kind: 'info', body: '🚨 main broken' });
    events.push({ from: 'GUARDIAN', kind: 'cost-incident', body: 'cost incident' });
    const ordered = events.map((event) => ({ event, at: T0 + Math.floor(random() * 29 * 60_000) })).sort((a, b) => a.at - b.at);
    for (const { event, at } of ordered) { now = at; store.post({ ...event, to: 'OP' }); }
    const before = store.list('OP', 0, 500);
    const exceptions = before.filter((m) => m.body.startsWith('[land-graph · stall]'));
    expect(exceptions).toHaveLength(26);
    expect(new Set(exceptions.map((m) => /#\d+/u.exec(m.body)?.[0])).size).toBe(26);
    expect(before.filter((m) => m.from === 'TC')).toHaveLength(39);
    expect(before.filter((m) => m.body.startsWith('🚨') || m.kind === 'cost-incident')).toHaveLength(2);
    expect(store.pendingOpDigest()).toHaveLength(70);
    now = T0 + 60 * 60_000;
    store.flushOpDigestIfDue();
    const inbox = store.list('OP', 0, 500);
    const digests = inbox.filter((m) => m.from === 'SIGNAL-DIGEST');
    expect(digests).toHaveLength(1);
    expect(digests[0]!.body).toContain('[machine digest · 70 mails');
    for (let i = 0; i < 26; i++) expect(digests[0]!.body).toContain(`#${40100 + i} · stall · 2건`);
    expect(inbox.length - exceptions.length).toBeLessThanOrEqual(43);
    expect(store.pendingOpDigest()).toHaveLength(0);
    store.close();
  });
}
