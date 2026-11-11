import { expect, test } from 'bun:test';
import { NexusEventBus } from './event-bus.js';
import { handleSseEvents } from './events.js';
import type { NexusEvent } from '../state/state.js';

test('board.card SSE data is emitted only for the member scope verified by the route', async () => {
  const bus = new NexusEventBus();
  const response = handleSseEvents(bus, new URL('https://nexus.test/v1/events?topics=board.card'), 'member-a');
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  await reader.read(); // Initial connection comment.
  bus.publish({ ts: 1, kind: 'board.card', memberId: 'member-b', detail: { cardId: 'private-b' } });
  bus.publish({ ts: 2, kind: 'board.card', memberId: 'member-a', detail: { cardId: 'visible-a' } });
  let payload = '';
  while (!payload.includes('visible-a')) {
    const { value, done } = await reader.read();
    if (done) break;
    payload += decoder.decode(value);
  }
  expect(payload).toContain('visible-a');
  expect(payload).not.toContain('private-b');
  await reader.cancel();
});

test('briefing.ready uses the same verified member boundary when it is subscribed alone', async () => {
  const bus = new NexusEventBus();
  const response = handleSseEvents(bus, new URL('https://nexus.test/v1/events?topics=briefing.ready'), 'member-a');
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  await reader.read();
  bus.publish({ ts: 1, kind: 'briefing.ready', memberId: 'member-b', detail: { title: 'private' } } as unknown as NexusEvent);
  bus.publish({ ts: 2, kind: 'briefing.ready', memberId: 'member-a', detail: { title: 'visible' } } as unknown as NexusEvent);
  let payload = '';
  while (!payload.includes('visible')) {
    const { value, done } = await reader.read();
    if (done) break;
    payload += decoder.decode(value);
  }
  expect(payload).toContain('visible');
  expect(payload).not.toContain('private');
  await reader.cancel();
});

test('an unscoped global event stream never exposes member board events', async () => {
  const bus = new NexusEventBus();
  const response = handleSseEvents(bus, new URL('https://nexus.test/v1/events?topics=board.card'));
  const reader = response.body!.getReader();
  await reader.read();
  bus.publish({ ts: 1, kind: 'board.card', memberId: 'member-a', detail: { cardId: 'private-a' } });
  const pending = reader.read();
  let settled = false;
  void pending.then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(settled).toBe(false);
  await reader.cancel();
  await pending;
});

test('operator streams retain briefing.ready while board cards remain owner scoped', async () => {
  const bus = new NexusEventBus();
  const response = handleSseEvents(bus, new URL('https://nexus.test/v1/events?topics=briefing.ready,board.card'), { operatorBriefings: true });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  await reader.read();
  bus.publish({ ts: 1, kind: 'board.card', memberId: 'member-a', detail: { cardId: 'private-card' } });
  bus.publish({ ts: 2, kind: 'briefing.ready', memberId: 'member-a', detail: { briefingId: 'briefing-a' } } as unknown as NexusEvent);
  let payload = '';
  while (!payload.includes('briefing-a')) {
    const { value, done } = await reader.read();
    if (done) break;
    payload += decoder.decode(value);
  }
  expect(payload).toContain('briefing-a');
  expect(payload).not.toContain('private-card');
  await reader.cancel();
});
