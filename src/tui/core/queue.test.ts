import { describe, expect, test } from 'bun:test';
import { createNextTuiQueue, nextTuiPushNowDecision } from './queue.js';

describe('Next TUI busy-turn queue (fixed responses)', () => {
  test('submissions leave one per settled turn in FIFO order', () => {
    const queue = createNextTuiQueue();
    expect(queue.enqueue('first')).toBe(1);
    expect(queue.enqueue('/help')).toBe(2);
    expect(queue.settle('draft')).toEqual({ kind: 'wake' });
    expect(queue.dequeue()).toEqual({ kind: 'submit', text: 'first', remaining: 1 });
    expect(queue.pendingTexts).toEqual(['/help']);
    expect(queue.settle('draft')).toEqual({ kind: 'wake' });
    expect(queue.dequeue()).toEqual({ kind: 'submit', text: '/help', remaining: 0 });
    expect(queue.settle('draft')).toEqual({ kind: 'none' });
  });

  test('interruption restores every queued submission ahead of the draft', () => {
    const queue = createNextTuiQueue();
    queue.enqueue('first');
    queue.enqueue('second');
    queue.markInterrupted();
    expect(queue.settle('draft')).toEqual({ kind: 'restore', text: 'first\nsecond\ndraft', count: 2 });
    expect(queue.count).toBe(0);
    expect(queue.settle('draft')).toEqual({ kind: 'none' });
  });

  test('an empty interrupted queue does not replace the draft', () => {
    const queue = createNextTuiQueue();
    queue.markInterrupted();
    expect(queue.settle('draft')).toEqual({ kind: 'none' });
    expect(queue.interrupted).toBe(false);
  });

  test('Ctrl+Up recalls all queued submissions in order ahead of the unsent draft', () => {
    const queue = createNextTuiQueue();
    queue.enqueue('first');
    queue.enqueue('second');
    expect(queue.recall('draft')).toEqual({ text: 'first\nsecond\ndraft', count: 2 });
    expect(queue.count).toBe(0);
    expect(queue.settle('first\nsecond\ndraft')).toEqual({ kind: 'none' });
  });
});

test('push-now defers while any tool is active, including non-shell tools', () => {
  expect(nextTuiPushNowDecision([])).toBe('interrupt');
  expect(nextTuiPushNowDecision(['Bash'])).toBe('deferred');
  expect(nextTuiPushNowDecision(['Read'])).toBe('deferred');
  expect(nextTuiPushNowDecision(['Agent'])).toBe('deferred');
  expect(nextTuiPushNowDecision(['Read', 'Bash'])).toBe('deferred');
});
