import { expect, test } from 'bun:test';
import { createNextTuiQueue } from './queue.js';
import { createChildNoticeProducers } from './notice-producers.js';

test('person precedes urgent mail, then ordinary notices, FIFO within each lane', () => {
  const queue = createNextTuiQueue({ log: () => {} });
  const producer = createChildNoticeProducers(queue);
  queue.enqueueNotice('ordinary-1', 'capsule-done');
  producer.seatMessageArrived({ id: 11, sender: 'OP', body: '🔴 urgent-1' });
  queue.enqueueNotice('ordinary-2', 'event-watch');
  producer.seatMessageArrived({ id: 12, sender: 'OP', body: '⚡ urgent-2' });
  queue.enqueue('person');
  expect(Array.from({ length: 5 }, () => {
    const item = queue.dequeue();
    return item.kind === 'submit' ? item.msgId ?? item.text : 'none';
  })).toEqual(['person', 11, 12, 'ordinary-1', 'ordinary-2']);
});

test('drain does not mix urgent mail with ordinary notices', () => {
  const queue = createNextTuiQueue({ log: () => {} });
  const producer = createChildNoticeProducers(queue);
  queue.enqueueNotice('ordinary', 'capsule-done');
  producer.seatMessageArrived({ id: 21, sender: 'OP', body: '🔴 urgent' });
  const first = queue.drain();
  expect(first.kind === 'batch' ? first.items.length : 0).toBe(1);
  expect(queue.pendingTexts).toEqual(['ordinary']);
});
