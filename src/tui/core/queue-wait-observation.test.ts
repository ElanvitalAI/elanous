import { expect, spyOn, test } from 'bun:test';
import { createNextTuiQueue } from './queue.js';

test('queue wait is measured from acceptance to delivery, independently of notice occurrence', () => {
  let now = 10_000;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const queue = createNextTuiQueue({ log: () => {}, turnLifeLog: (event, data) => events.push({ event, data }) });
    const first = queue.enqueue('person');
    now = 10_200;
    const second = queue.enqueueNotice('mail', 'seat-mail', { msgId: 42, occurredAt: 500 });
    expect(first).toMatchObject({ enqueuedAt: 10_000 });
    expect(second).toMatchObject({ enqueuedAt: 10_200 });
    now = 10_750;
    queue.dequeue();
    now = 11_100;
    queue.dequeue();
    expect(events.filter(({ event }) => event === 'turn-life:event-dequeued').map(({ data }) => ({
      itemId: data.itemId, waitMs: data.waitMs,
    }))).toEqual([{ itemId: first.id, waitMs: 750 }, { itemId: second.id, waitMs: 900 }]);
  } finally {
    clock.mockRestore();
  }
});
