import { expect, test } from 'bun:test';
import { linearConnector } from './linear.js';
import type { ExternalTaskEvent, TaskConnector } from './types.js';

test('TaskConnector preserves external task event identity and creation fields', () => {
  const connector: TaskConnector = linearConnector;
  const event: ExternalTaskEvent = {
    provider: 'linear', eventId: 'delivery-1', kind: 'created', ref: 'issue-5',
    identifier: 'ELA-5', title: 'Issue 5', body: 'Question?', url: 'https://linear.app/issue/ELA-5',
    priority: 'urgent', occurredAt: '2026-09-27T00:00:00Z',
  };
  expect(connector.provider).toBe(event.provider);
  expect(connector.idempotencyKey(event)).toBe(event.eventId);
  expect(connector.parse({ type: 'Issue', action: 'create', data: {
    id: event.ref, identifier: event.identifier, title: event.title, description: event.body,
    url: event.url, priority: 1, updatedAt: event.occurredAt,
  } }, event.eventId)).toEqual(event);
});
