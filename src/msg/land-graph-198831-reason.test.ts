import { expect, test } from 'bun:test';
import { MsgStore } from './msg-store.js';

test('same PR different reasons each arrive once; same reason repeats fold', () => {
  const store = new MsgStore(':memory:', { now: () => new Date('2026-11-27T07:00:00Z') });
  for (const reason of ['stall', 'conflict', 'stall', 'conflict'])
    store.post({ from: 'LAND-GRAPH', to: 'OP', kind: 'info', body: `[land-graph · ${reason}] #40579 detail` });
  const inbox = store.list('OP');
  expect(inbox).toHaveLength(2);
  expect(inbox.map((m) => m.body).sort()).toEqual(['[land-graph · conflict] #40579 detail', '[land-graph · stall] #40579 detail']);
  expect(store.pendingOpDigest()).toHaveLength(4);
  store.flushOpDigestIfDue({ force: true });
  store.post({ from: 'LAND-GRAPH', to: 'OP', kind: 'info', body: '[land-graph · stall] #40579 replay after flush' });
  expect(store.list('OP').filter((m) => m.from === 'LAND-GRAPH')).toHaveLength(3);
  expect(store.pendingOpDigest()).toHaveLength(1);
  store.post({ from: 'LAND-GRAPH', to: 'OP', kind: 'info', body: '[land-graph · stall] #40579 second repeat in new window' });
  expect(store.list('OP').filter((m) => m.from === 'LAND-GRAPH')).toHaveLength(3);
  store.post({ from: 'LAND-GRAPH', to: 'OP', kind: 'info', body: '[land-graph · new reason] #40579 detail' });
  expect(store.list('OP').filter((m) => m.from === 'LAND-GRAPH')).toHaveLength(4);
  store.close();
});
