import { expect, test } from 'bun:test';
import { createNextTuiQueue } from './core/queue.js';
import { createSeatMailArrivalWatcher } from './seat-mail-arrival.js';

test('watch health follows real reads, loss and recovery, not timer creation', () => {
  let tick = () => {};
  let mode: 'ok' | 'error' | 'missing' = 'ok';
  const queue = createNextTuiQueue({ log: () => {} });
  const watcher = createSeatMailArrivalWatcher('/tmp', queue, {
    messages: { read: () => { if (mode === 'error') throw Error('locked'); return mode === 'missing' ? null : { seat: 'TEST', messages: [] }; } },
    timer: { set: fn => { tick = fn; return 1; }, clear: () => {} },
    retryTimer: { set: () => 2, clear: () => {} }, onReadError: () => {}, log: () => {},
  });
  expect(watcher.getStatus()).toBe('stopped');
  watcher.start(); expect(watcher.getStatus()).toBe('starting');
  tick(); expect(watcher.getStatus()).toBe('running');
  mode = 'error'; tick(); expect(watcher.getStatus()).toBe('read-error');
  mode = 'missing'; tick(); expect(watcher.getStatus()).toBe('read-error');
  mode = 'ok'; tick(); expect(watcher.getStatus()).toBe('running');
  watcher.stop(); expect(watcher.getStatus()).toBe('stopped');
  watcher.poll(); expect(watcher.getStatus()).toBe('stopped');
});

test('timer setup failure is observable and can be retried', () => {
  let fail = true;
  const watcher = createSeatMailArrivalWatcher('/tmp', createNextTuiQueue({ log: () => {} }), {
    timer: { set: () => { if (fail) throw Error('timer failed'); return 1; }, clear: () => {} },
  });
  expect(() => watcher.start()).toThrow('timer failed');
  expect(watcher.getStatus()).toBe('start-error');
  fail = false; watcher.start(); expect(watcher.getStatus()).toBe('starting');
  watcher.stop(); expect(watcher.getStatus()).toBe('stopped');
});
