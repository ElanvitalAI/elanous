import { expect, test } from 'bun:test';
import { createNextTuiQueue } from './queue.js';

test.each(['esc', 'timeout-15m', 'stream-stall'] as const)('resume carries %s at idle exactly once', (reason) => {
  const q = createNextTuiQueue({ log: () => {}, turnLifeLog: () => {} });
  q.enqueue('one', 'steer'); q.enqueue('two');
  q.markInterrupted(reason);
  expect(q.settle('')).toEqual({ kind: 'resubmit', count: 2 });
  expect(q.steerCount).toBe(0);
  const batch = q.drain();
  expect(batch.kind).toBe('batch');
  if (batch.kind !== 'batch') return;
  expect(batch.items[0]?.interruptReason).toBe(reason);
  expect(batch.items[0]?.afterInterrupt).toBe(true);
  expect(batch.items[1]?.interruptReason).toBeUndefined();
  expect(q.dequeue()).toEqual({ kind: 'none' });
});

test('reason follows actual priority and does not leak after all pending items are cancelled', () => {
  const q = createNextTuiQueue({ log: () => {}, turnLifeLog: () => {} });
  q.enqueueNotice('ordinary', 'seat-mail');
  q.markInterrupted('timeout-15m'); q.settle('');
  const urgent = q.enqueueNotice('urgent', 'seat-mail', { urgent: true });
  const next = q.dequeue();
  expect(next.kind).toBe('submit');
  if (next.kind === 'submit') { expect(next.id).toBe(urgent.id); expect(next.interruptReason).toBe('timeout-15m'); }
  const old = q.dequeue();
  if (old.kind === 'submit') expect(old.interruptReason).toBeUndefined();
  const cancelled = q.enqueue('cancel'); q.markInterrupted('esc'); q.settle(''); q.cancel(cancelled.id);
  q.enqueue('new');
  const fresh = q.dequeue();
  if (fresh.kind === 'submit') expect(fresh.interruptReason).toBeUndefined();
});

test('first interruption wins before idle, legacy result shape stays unchanged', () => {
  const q = createNextTuiQueue({ log: () => {}, turnLifeLog: () => {} });
  q.enqueue('x'); q.markInterrupted('stream-stall'); q.markInterrupted('esc'); q.settle('');
  q.markInterrupted('esc'); q.settle('');
  const item = q.dequeue();
  if (item.kind === 'submit') expect(item.interruptReason).toBe('stream-stall');
  q.enqueue('legacy'); q.markInterrupted(); q.settle('');
  const legacy = q.dequeue();
  expect(legacy.kind === 'submit' && 'interruptReason' in legacy).toBe(false);
});

test.each(['dequeue', 'drain'] as const)('priority change after settle keeps interruption metadata together on first %s', (method) => {
  const q = createNextTuiQueue({ log: () => {}, turnLifeLog: () => {} });
  const ordinary = q.enqueueNotice('ordinary', 'seat-mail');
  q.markInterrupted('timeout-15m');
  expect(q.settle('')).toEqual({ kind: 'resubmit', count: 1 });
  const urgent = q.enqueueNotice('urgent', 'seat-mail', { urgent: true });
  if (method === 'dequeue') {
    expect(q.dequeue()).toMatchObject({ id: urgent.id, afterInterrupt: true, interruptReason: 'timeout-15m' });
    expect(q.dequeue()).toMatchObject({ id: ordinary.id, afterInterrupt: false });
  } else {
    const first = q.drain(); const second = q.drain();
    expect(first.kind === 'batch' && first.items[0]).toMatchObject({ id: urgent.id, afterInterrupt: true, interruptReason: 'timeout-15m' });
    expect(second.kind === 'batch' && second.items[0]).toEqual({ id: ordinary.id, kind: 'notice', text: 'ordinary', afterInterrupt: false });
  }
});

test('cancelling the original head transfers both interruption fields to the next idle item', () => {
  const q = createNextTuiQueue({ log: () => {}, turnLifeLog: () => {} });
  const first = q.enqueue('first'); const second = q.enqueue('second');
  q.markInterrupted('esc'); q.settle(''); q.cancel(first.id);
  expect(q.dequeue()).toMatchObject({ id: second.id, afterInterrupt: true, interruptReason: 'esc' });
});
