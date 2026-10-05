import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enqueueSeatGoal, finishSeatGoal, listSeatGoals, scheduleSeatGoals, seatGoalQueuePath } from './seat-goal-queue.js';

function fixture(run: (root: string, now: () => Date) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'seat-goal-queue-'));
  const now = () => new Date('2026-10-01T10:00:00.000Z');
  return Promise.resolve().then(() => run(root, now)).finally(() => rmSync(root, { recursive: true, force: true }));
}

test('prerequisites require an existing successful goal; failed dependencies cannot launch', () => fixture(async (root, now) => {
  const first = enqueueSeatGoal({ id: 'first', seat: 'TC', goal: 'first goal' }, { root, now });
  expect(() => enqueueSeatGoal({ id: 'missing-child', seat: 'TC', goal: 'missing', prerequisites: ['unknown'] }, { root, now }))
    .toThrow('missing prerequisite unknown');
  enqueueSeatGoal({ id: 'second', seat: 'TC', goal: 'second goal', prerequisites: [first.id] }, { root, now });
  const launched: string[] = [];
  const options = { root, now, maxConcurrent: 2, seatCaps: { TC: 2 }, launch: (goal: { id: string }) => { launched.push(goal.id); } };
  expect((await scheduleSeatGoals(options)).goal?.id).toBe('first');
  expect((await scheduleSeatGoals(options)).reason).toBe('prerequisites');
  finishSeatGoal(first.id, 'succeeded', { root, now });
  expect((await scheduleSeatGoals(options)).goal?.id).toBe('second');
  expect(launched).toEqual(['first', 'second']);
  enqueueSeatGoal({ id: 'failed-parent', seat: 'MK', goal: 'failure' }, { root, now });
  enqueueSeatGoal({ id: 'blocked-child', seat: 'MK', goal: 'blocked', prerequisites: ['failed-parent'] }, { root, now });
  expect((await scheduleSeatGoals(options)).goal?.id).toBe('failed-parent');
  finishSeatGoal('failed-parent', 'failed', { root, now });
  await scheduleSeatGoals(options);
  expect(listSeatGoals({ root }).find((goal) => goal.id === 'blocked-child')?.status).toBe('expired');
}));

test('global and per-seat concurrency remain reserved until explicit completion', () => fixture(async (root, now) => {
  for (const [id, seat] of [['a', 'TC'], ['b', 'TC'], ['c', 'MK'], ['d', 'UX']] as const) {
    enqueueSeatGoal({ id, seat, goal: id }, { root, now });
  }
  const launches: string[] = [];
  const options = { root, now, maxConcurrent: 2, seatCaps: { TC: 1 }, launch: (goal: { id: string }) => { launches.push(goal.id); } };
  expect((await scheduleSeatGoals(options)).goal?.id).toBe('a');
  expect((await scheduleSeatGoals(options)).goal?.id).toBe('c');
  expect((await scheduleSeatGoals(options)).reason).toBe('global-cap');
  expect(launches).toEqual(['a', 'c']);
  finishSeatGoal('c', 'succeeded', { root, now });
  expect((await scheduleSeatGoals(options)).goal?.id).toBe('d');
  expect((await scheduleSeatGoals(options)).outcome).toBe('waiting');
  finishSeatGoal('a', 'failed', { root, now });
  expect((await scheduleSeatGoals(options)).goal?.id).toBe('b');
  expect(() => finishSeatGoal('a', 'succeeded', { root, now })).toThrow('not running');
}));

test('a seat cap blocks its seat even when a global slot is free', () => fixture(async (root, now) => {
  enqueueSeatGoal({ id: 'first', seat: 'TC', goal: 'first' }, { root, now });
  enqueueSeatGoal({ id: 'next', seat: 'TC', goal: 'next' }, { root, now });
  const options = { root, now, maxConcurrent: 3, seatCaps: { TC: 1 }, launch: () => {} };
  expect((await scheduleSeatGoals(options)).goal?.id).toBe('first');
  expect(await scheduleSeatGoals(options)).toMatchObject({ outcome: 'waiting', reason: 'seat-cap' });
  finishSeatGoal('first', 'succeeded', { root, now });
  expect((await scheduleSeatGoals(options)).goal?.id).toBe('next');
}));

test('endAt is exclusive; notBefore is inclusive and expiry survives restarts', () => fixture(async (root, now) => {
  const endAt = '2026-10-01T10:01:00.000Z';
  enqueueSeatGoal({ id: 'window', seat: 'TC', goal: 'window', notBefore: '2026-10-01T10:01:00.000Z', endAt: '2026-10-01T10:02:00.000Z' }, { root, now });
  enqueueSeatGoal({ id: 'expired', seat: 'MK', goal: 'expired', endAt }, { root, now });
  const launches: string[] = [];
  const options = { root, maxConcurrent: 2, seatCaps: {}, launch: (goal: { id: string }) => { launches.push(goal.id); } };
  expect((await scheduleSeatGoals({ ...options, now })).goal?.id).toBe('expired');
  finishSeatGoal('expired', 'succeeded', { root, now });
  expect((await scheduleSeatGoals({ ...options, now })).reason).toBe('not-before');
  expect((await scheduleSeatGoals({ ...options, now: () => new Date(endAt) })).goal?.id).toBe('window');
  enqueueSeatGoal({ id: 'too-late', seat: 'UX', goal: 'too late', endAt }, { root, now });
  expect(() => enqueueSeatGoal({ id: 'already-past', seat: 'UX', goal: 'past', endAt },
    { root, now: () => new Date(endAt) })).toThrow('endAt has passed');
  expect((await scheduleSeatGoals({ ...options, now: () => new Date(endAt) })).outcome).toBe('empty');
  expect(listSeatGoals({ root }).find((goal) => goal.id === 'too-late')?.status).toBe('expired');
  expect(launches).toEqual(['expired', 'window']);
}));

test('a goal ending while waiting for the queue write lock expires without launching', () => fixture(async (root, now) => {
  enqueueSeatGoal({ id: 'deadline', seat: 'TC', goal: 'deadline', endAt: '2026-10-01T10:01:00.000Z' }, { root, now });
  const marker = join(root, 'lock-released');
  const holder = Bun.spawn(['bun', join(import.meta.dir, 'seat-goal-queue-lock.fixture.ts'), seatGoalQueuePath(root), marker], {
    stdout: 'pipe', stderr: 'pipe',
  });
  try {
    const ready = await holder.stdout.getReader().read();
    expect(new TextDecoder().decode(ready.value)).toContain('LOCKED');
    expect(existsSync(marker)).toBe(false);
    const launched: string[] = [];
    const result = await scheduleSeatGoals({
      root, now: () => new Date(existsSync(marker) ? '2026-10-01T10:01:00.000Z' : '2026-10-01T10:00:00.000Z'),
      maxConcurrent: 1, seatCaps: {}, launch: (goal) => { launched.push(goal.id); },
    });
    expect(result.outcome).toBe('empty');
    expect(launched).toEqual([]);
    expect(listSeatGoals({ root }).find((goal) => goal.id === 'deadline')).toMatchObject({
      status: 'expired', finishedAt: '2026-10-01T10:01:00.000Z',
    });
  } finally {
    await holder.exited;
  }
}));

test('parallel ticks claim one goal once and retain an uncertain launch reservation', () => fixture(async (root, now) => {
  enqueueSeatGoal({ id: 'once', seat: 'TC', goal: 'once' }, { root, now });
  const options = { root, now, maxConcurrent: 1, seatCaps: {}, launch: async () => { throw new Error('uncertain launch'); } };
  const results = await Promise.allSettled([scheduleSeatGoals(options), scheduleSeatGoals(options)]);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(listSeatGoals({ root }).find((goal) => goal.id === 'once')?.status).toBe('running');
}));
