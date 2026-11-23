import { expect, test } from 'bun:test';
import { createTurnEventBus } from './bus.js';
import { createCapsuleEventAdapters } from './adapters.js';

test('watch lines and capsule completions become separately deduplicated events', () => {
  const bus = createTurnEventBus();
  const calls: string[] = [];
  const adapters = createCapsuleEventAdapters({ bus, offer: () => calls.push('offer'), log: () => {} });
  expect(adapters.watch({ id: 'line-1', text: 'ready', at: 1 })).toEqual({ duplicate: false });
  expect(adapters.watch({ id: 'line-1', text: 'ready', at: 1 })).toEqual({ duplicate: true });
  const done = { type: 'capsule-done' as const, capsuleId: 'cap-1', kind: 'shell' as const,
    sessionId: 'session-1', startedAt: 1, endedAt: 2, status: 'failed' as const, summary: 'exit 1' };
  expect(adapters.done(done)).toEqual({ duplicate: false });
  expect(adapters.done(done)).toEqual({ duplicate: true });
  expect(bus.pending().map(row => [row.id, row.source, row.text])).toEqual([
    ['capsule-done:session-1:cap-1', 'capsule-done', 'exit 1'], ['watch:line-1', 'watch', 'ready'],
  ]);
  expect(calls).toEqual(['offer', 'offer']);
});

test('different sessions remain distinct and observation errors do not block offers', () => {
  const bus = createTurnEventBus();
  let offered = 0;
  const adapters = createCapsuleEventAdapters({ bus, offer: () => { offered++; }, log: () => { throw new Error('sink'); } });
  const done = { type: 'capsule-done' as const, capsuleId: 'same', kind: 'agent' as const,
    sessionId: 'one', startedAt: 1, endedAt: 2, status: 'ok' as const, summary: 'done' };
  adapters.done(done);
  adapters.done({ ...done, sessionId: 'two' });
  expect(bus.pending().map(row => row.id)).toEqual(['capsule-done:one:same', 'capsule-done:two:same']);
  expect(offered).toBe(2);
});
