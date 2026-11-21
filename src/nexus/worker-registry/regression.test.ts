import { afterEach, expect, test } from 'bun:test';
import { WorkerRegistryStore } from './store.js';
import { bindWorkerRegistryFront, MAX_WORKER_WATCH_STREAMS } from './api.js';

const stores: WorkerRegistryStore[] = [];
function fresh() { const store = new WorkerRegistryStore(':memory:'); stores.push(store); return store; }
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

test('desired-state mutation advances revision and records steer; missing worker does not', () => {
  const store = fresh();
  store.registerWorker({ id: 'w', kind: 'cli' });
  const before = store.snapshot();
  store.setDesiredState('w', 'idle');
  const after = store.snapshot();
  expect(after.revision).toBeGreaterThan(before.revision);
  expect(after.workers[0]?.desiredState).toBe('idle');
  expect(store.eventsSince(before.revision).map(e => [e.type, e.fromState, e.toState])).toEqual([['steer', null, 'idle']]);
  expect(store.setDesiredState('absent', 'done')).toBeUndefined();
  expect(store.currentRevision()).toBe(after.revision);
});

test('rotation clears omitted endpoint and SHA but same-generation partial updates preserve them', () => {
  const store = fresh();
  store.upsertHost({ name: 'h', principal: 'a', elsEndpoint: 'http://127.0.0.1:1984', elsVersionSha: 'old' });
  expect(store.upsertHost({ name: 'h', principal: 'a' }).elsVersionSha).toBe('old');
  const rotated = store.upsertHost({ name: 'h', principal: 'b' });
  expect(rotated.generation).toBe(2);
  expect(rotated.elsEndpoint).toBeNull();
  expect(rotated.elsVersionSha).toBeNull();
  const replacement = store.upsertHost({ name: 'h', principal: 'c', elsEndpoint: 'http://127.0.0.1:1985', elsVersionSha: 'new' });
  expect([replacement.elsEndpoint, replacement.elsVersionSha]).toEqual(['http://127.0.0.1:1985', 'new']);
});

test('SSE replays, delivers each live event exactly once, and stops delivering after cancel', async () => {
  const store = fresh();
  store.registerWorker({ id: 'w', kind: 'cli' });
  const reader = bindWorkerRegistryFront(store).sseFromLastEventId('0').getReader();
  const decoder = new TextDecoder();
  const timeout = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
  const frames: string[] = [];
  expect(decoder.decode((await reader.read()).value)).toContain('"type":"registered"');
  store.setActualState('w', 'idle');
  const live = await Promise.race([reader.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('live SSE timeout')), 500))]);
  frames.push(decoder.decode(live.value));
  expect(frames[0]).toContain('"type":"state"');
  // 같은 사건이 다시 오지 않는다: 새 사건이 없으면 후속 read 는 보류 상태로 남는다.
  const pending = reader.read();
  expect(await Promise.race([pending, timeout(300, 'quiet' as const)])).toBe('quiet'); // 출처: #39114 (watch 폴링 100ms 의 3주기 대기)
  expect(frames.filter((f) => f.includes('"type":"state"'))).toHaveLength(1);
  await reader.cancel();
  // cancel 뒤 보류 read 는 값 없이 종료되고, 이후 변경은 이 구독으로 배달되지 않는다.
  const settled = await pending;
  expect(settled.done).toBe(true);
  expect(settled.value).toBeUndefined();
  expect(() => store.setActualState('w', 'done')).not.toThrow();
  expect((await reader.read()).done).toBe(true);
});

test('cancel releases the stream slot so capacity is available again', async () => {
  const store = fresh();
  const front = bindWorkerRegistryFront(store);
  const readers = Array.from({ length: MAX_WORKER_WATCH_STREAMS }, () => front.sseFromLastEventId('0').getReader());
  expect(() => front.sseFromLastEventId('0')).toThrow('watch capacity exceeded');
  await readers[0]!.cancel();
  const again = front.sseFromLastEventId('0').getReader();
  await again.cancel();
  for (const reader of readers.slice(1)) await reader.cancel();
});
