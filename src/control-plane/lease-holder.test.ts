import { expect, test } from 'bun:test';
import { createLeaseHolderView } from './lease-holder.js';
import type { RoleLeaseRead } from '../roles/role-lease.js';

const lease = (holder: string, generation: number): RoleLeaseRead => ({
  kind: 'present', doc: { holder, generation, state: 'held', renewedAt: 1 },
});

test('lease holder view caches until ttl expires and refreshes the holder and generation', async () => {
  let time = 100;
  let reads = 0;
  let current = lease('node-b', 7);
  const view = createLeaseHolderView({ machine: 'mbp', now: () => time, ttlMs: 10_000, read: () => { reads++; return current; } });
  expect(await view.get()).toEqual({ holder: 'node-b', generation: 7, iAmHolder: false, known: true });
  current = lease('mbp', 8);
  time = 10_099;
  expect(await view.get()).toEqual({ holder: 'node-b', generation: 7, iAmHolder: false, known: true });
  expect(reads).toBe(1);
  time = 10_100;
  expect(await view.get()).toEqual({ holder: 'mbp', generation: 8, iAmHolder: true, known: true });
  expect(reads).toBe(2);
});

test('unmeasured, absent and thrown lease reads are unknown; concurrent requests share one read', async () => {
  let reads = 0;
  const view = createLeaseHolderView({ machine: 'mbp', ttlMs: 0, read: async () => {
    reads++;
    await Bun.sleep(1);
    return { kind: 'unmeasured', why: 'network' } as const;
  } });
  expect(await Promise.all([view.get(), view.get()])).toEqual([
    { holder: null, generation: null, iAmHolder: false, known: false },
    { holder: null, generation: null, iAmHolder: false, known: false },
  ]);
  expect(reads).toBe(1);
  expect((await createLeaseHolderView({ machine: 'mbp', read: () => ({ kind: 'absent' }) }).get()).known).toBe(false);
  expect((await createLeaseHolderView({ machine: 'mbp', read: () => { throw new Error('offline'); } }).get()).known).toBe(false);
});
