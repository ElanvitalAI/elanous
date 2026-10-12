import { describe, expect, test } from 'bun:test';
import { decideMinihDrain, minihStandardCapacity, parsePodPool, PodPoolScheduler } from './pod-pool.js';

describe('node-c capacity and drain decision (not wired into allocation)', () => {
  test('home has one standard slot; external has two', () => {
    expect(minihStandardCapacity('home')).toBe(1);
    expect(minihStandardCapacity('external')).toBe(2);
    expect(decideMinihDrain('home', 0)).toEqual({ capacity: 1, runningPods: 0, drainNewAdmissions: false, availableSlots: 1 });
    expect(decideMinihDrain('external', 0)).toEqual({ capacity: 2, runningPods: 0, drainNewAdmissions: false, availableSlots: 2 });
  });

  test('returning home drains excess new admissions without evicting running Pods', () => {
    expect(decideMinihDrain('home', 2)).toEqual({ capacity: 1, runningPods: 2, drainNewAdmissions: true, availableSlots: 0 });
    expect(decideMinihDrain('home', 1)).toEqual({ capacity: 1, runningPods: 1, drainNewAdmissions: false, availableSlots: 0 });
    expect(decideMinihDrain('external', 2)).toEqual({ capacity: 2, runningPods: 2, drainNewAdmissions: false, availableSlots: 0 });
    expect(decideMinihDrain('home', 0, 2)).toEqual({ capacity: 1, runningPods: 0, drainNewAdmissions: true, availableSlots: 0 });
    expect(() => decideMinihDrain('home', -1)).toThrow(RangeError);
  });

  test('policy is not wired into pool allocation: existing configured capacity remains effective', async () => {
    let occupied = 1;
    const pool = new PodPoolScheduler(parsePodPool('pool-node-c@node-c:2'), {
      occupancy: () => ({ 'pool-node-c': { occupied } }),
    });
    expect(decideMinihDrain('home', occupied).availableSlots).toBe(0);
    const acquired = await pool.tryAcquire();
    expect(acquired?.context).toBe('pool-node-c');
    expect(pool.snapshot()).toEqual({ 'pool-node-c': 1 });
    occupied = 2;
    expect(decideMinihDrain('home', occupied).drainNewAdmissions).toBe(true);
    expect(pool.snapshot()).toEqual({ 'pool-node-c': 1 });
    pool.release(acquired!);
    expect(pool.snapshot()).toEqual({ 'pool-node-c': 0 });
  });
});
