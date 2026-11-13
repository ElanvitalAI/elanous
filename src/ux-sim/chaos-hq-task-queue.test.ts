import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChaosTaskQueue } from './chaos-hq-task-queue.js';
import { createFakePsDevice } from './fake-ps.js';

test('reopened queue rejects dead/stale PID and fenced generation; only live replacement completes', () => {
  const root = mkdtempSync(join(tmpdir(), 'chaos-task-test-'));
  try {
    const path = join(root, 'tasks.json');
    const queue = new ChaosTaskQueue(path);
    const ps = createFakePsDevice({ processes: [{ id: 'loop', host: 'mshq', releaseVersion: 'sim' }] });
    const oldWorker = { host: 'mshq', pid: ps.find('loop', 'mshq')!.pid, generation: 7 };
    queue.initialize([{ id: 'independent-task', loop: 'loop' }]);
    expect(queue.claim('loop', oldWorker, ps, false)).toBe(false);
    expect(queue.claim('loop', oldWorker, ps, true)).toBe(true);
    ps.kill('loop', 'mshq');
    expect(queue.complete('loop', oldWorker, ps, true, 10)).toBe(false);
    ps.restart('loop', 'mshq');
    const worker = { host: 'mshq', pid: ps.find('loop', 'mshq')!.pid, generation: 8 };
    expect(worker.pid).not.toBe(oldWorker.pid);
    expect(queue.complete('loop', oldWorker, ps, true, 20)).toBe(false);
    const reopened = new ChaosTaskQueue(path);
    reopened.recover(ps, 'mshq', 8);
    expect(reopened.snapshot()[0]?.state).toBe('pending');
    expect(reopened.claim('loop', oldWorker, ps, true)).toBe(false);
    expect(reopened.claim('loop', worker, ps, true)).toBe(true);
    expect(reopened.complete('loop', { ...worker, generation: 7 }, ps, true, 30)).toBe(false);
    expect(reopened.complete('loop', worker, ps, false, 30)).toBe(false);
    expect(reopened.complete('loop', worker, ps, true, 40)).toBe(true);
    expect(new ChaosTaskQueue(path).snapshot()[0]).toMatchObject({
      id: 'independent-task', state: 'done', completedAt: 40, worker: { generation: 8, pid: worker.pid },
    });
    expect(reopened.complete('loop', worker, ps, true, 50)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Monkey same-generation reassignment rejects old callback PID after replacement claim', () => {
  const root = mkdtempSync(join(tmpdir(), 'chaos-stale-ack-'));
  try {
    const path = join(root, 'tasks.json');
    const ps = createFakePsDevice({ processes: [{ id: 'loop', host: 'mshq', releaseVersion: 'sim' }] });
    const queue = new ChaosTaskQueue(path);
    const oldWorker = { host: 'mshq', pid: ps.find('loop', 'mshq')!.pid, generation: 7 };
    queue.initialize([{ id: 'interrupted-task', loop: 'loop' }]);
    expect(queue.claim('loop', oldWorker, ps, true)).toBe(true);
    ps.kill('loop', 'mshq');
    ps.restart('loop', 'mshq');
    const replacement = { ...oldWorker, pid: ps.find('loop', 'mshq')!.pid };
    expect(replacement.pid).not.toBe(oldWorker.pid);
    const reopened = new ChaosTaskQueue(path);
    reopened.recover(ps, 'mshq', 7);
    expect(reopened.claim('loop', oldWorker, ps, true)).toBe(false);
    expect(reopened.claim('loop', replacement, ps, true)).toBe(true);
    const assigned = reopened.snapshot();
    // Delayed callback carries its original PID even though host, loop and generation match.
    expect(reopened.complete('loop', oldWorker, ps, true, 30)).toBe(false);
    expect(reopened.snapshot()).toEqual(assigned);
    expect(new ChaosTaskQueue(path).complete('loop', oldWorker, ps, true, 31)).toBe(false);
    expect(reopened.complete('loop', replacement, ps, true, 40)).toBe(true);
    expect(reopened.snapshot()[0]).toMatchObject({ id: 'interrupted-task', state: 'done',
      worker: replacement, completedAt: 40 });
    expect(reopened.complete('loop', oldWorker, ps, true, 50)).toBe(false);
    expect(reopened.snapshot()[0]?.completedAt).toBe(40);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
