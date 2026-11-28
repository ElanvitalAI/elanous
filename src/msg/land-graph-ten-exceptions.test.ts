import { expect, test } from 'bun:test';
import { MsgStore } from './msg-store.js';

test('ten same-PR same-reason exceptions: one direct mail and one 30-minute digest', () => {
  const start = Date.parse('2026-11-27T07:00:00Z');
  let now = start;
  const store = new MsgStore(':memory:', { now: () => new Date(now) });
  try {
    for (let i = 0; i < 10; i++) {
      store.post({ from: 'LAND-GRAPH', to: 'OP', kind: 'info', body: '[land-graph · stall] #40579 ready 30+ min' });
    }
    expect(store.list('OP').filter(m => m.from === 'LAND-GRAPH')).toHaveLength(1);
    expect(store.pendingOpDigest()).toHaveLength(10);
    now = start + 30 * 60_000 - 1;
    expect(store.flushOpDigestIfDue()).toBeNull();
    expect(store.list('OP')).toHaveLength(1);
    now = start + 30 * 60_000;
    store.flushOpDigestIfDue();
    const inbox = store.list('OP');
    expect(inbox).toHaveLength(2);
    const digest = inbox.filter(m => m.from === 'SIGNAL-DIGEST');
    expect(digest).toHaveLength(1);
    expect(digest[0]!.body).toContain('#40579 · stall · 10건');
    expect(store.pendingOpDigest()).toHaveLength(0);
  } finally { store.close(); }
});
