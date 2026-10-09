import { expect, test } from 'bun:test';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLedger } from './event-ledger.js';
import { linearConnector } from './linear.js';
import type { ExternalTaskEvent, TaskConnector } from './types.js';

test('TaskConnector preserves external task event identity and creation fields', () => {
  const connector: TaskConnector = linearConnector;
  const event: ExternalTaskEvent = {
    provider: 'linear', eventId: 'delivery-1', kind: 'created', ref: 'issue-5',
    identifier: 'ELA-5', title: 'Issue 5', body: 'Question?', url: 'https://linear.app/issue/ELA-5',
    priority: 'urgent', occurredAt: '2026-09-27T00:00:00Z',
  };
  const legacyProvidersStillAllowed: 'linear' | 'asana' extends ExternalTaskEvent['provider'] ? true : false = true;
  const defaultHasNoNewProviders: Exclude<ExternalTaskEvent['provider'], 'linear' | 'asana'> extends never ? true : false = true;
  const defaultConnectorStillBounded: Exclude<TaskConnector['provider'], 'linear' | 'asana'> extends never ? true : false = true;
  expect(legacyProvidersStillAllowed).toBe(true);
  expect(defaultConnectorStillBounded).toBe(true);
  expect(defaultHasNoNewProviders).toBe(true);
  expect(connector.provider).toBe(event.provider);
  expect(connector.idempotencyKey(event)).toBe(event.eventId);
  expect(connector.parse({ type: 'Issue', action: 'create', data: {
    id: event.ref, identifier: event.identifier, title: event.title, description: event.body,
    url: event.url, priority: 1, updatedAt: event.occurredAt,
  } }, event.eventId)).toEqual(event);
});

test('a mock messenger server exercises the task connector contract without changing the ledger format', async () => {
  // Synthetic messenger protocol, not a registered transport or inbound route.
  const connector: TaskConnector<'mock-messenger'> = {
    provider: 'mock-messenger',
    verify: ({ rawBody, signature, secret }) => {
      if (!secret) return { ok: false, reason: 'invalid-signature' };
      const expected = createHmac('sha256', secret).update(rawBody).digest();
      const supplied = /^[a-f0-9]{64}$/i.test(signature) ? Buffer.from(signature, 'hex') : Buffer.alloc(0);
      return supplied.length === expected.length && timingSafeEqual(supplied, expected)
        ? { ok: true } : { ok: false, reason: 'invalid-signature' };
    },
    parse: (body, deliveryId) => {
      if (!deliveryId || !body || typeof body !== 'object') return null;
      const message = body as Record<string, unknown>;
      if (message.type !== 'message' || typeof message.id !== 'string' || !message.id ||
          typeof message.text !== 'string' || typeof message.sentAt !== 'string' ||
          !Number.isFinite(Date.parse(message.sentAt))) return null;
      return {
        provider: 'mock-messenger', eventId: deliveryId, kind: 'created', ref: message.id,
        title: message.text, body: message.text, url: '', priority: null,
        occurredAt: message.sentAt,
      };
    },
    idempotencyKey: event => event.eventId,
  };
  const secret = 'fixture-secret';
  const deliveryId = 'delivery-1';
  const payload = { type: 'message', id: 'msg-7', text: 'Hello', sentAt: '2026-10-08T00:00:00Z' };
  const rawBody = JSON.stringify(payload);
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
  const root = mkdtempSync(join(tmpdir(), 'mock-messenger-contract-'));
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch: request => new Response(
      new URL(request.url).pathname === '/tampered' ? `${rawBody} ` : rawBody,
      { headers: { 'x-delivery-id': deliveryId, 'x-signature': signature } },
    ),
  });
  try {
    const ledger = new EventLedger(join(root, 'events.jsonl'));
    const response = await fetch(`http://127.0.0.1:${server.port}/message`);
    const deliveredBody = await response.text();
    const deliveredSignature = response.headers.get('x-signature') ?? '';
    const deliveredId = response.headers.get('x-delivery-id') ?? '';
    expect(connector.verify({ rawBody: deliveredBody, signature: deliveredSignature, secret })).toEqual({ ok: true });
    expect(connector.verify({ rawBody: new TextEncoder().encode(deliveredBody), signature: deliveredSignature, secret })).toEqual({ ok: true });
    expect(connector.verify({ rawBody: deliveredBody, signature: 'not-hex', secret })).toEqual({ ok: false, reason: 'invalid-signature' });
    expect(connector.verify({ rawBody: deliveredBody, signature: deliveredSignature, secret: 'wrong-secret' })).toEqual({ ok: false, reason: 'invalid-signature' });
    expect(connector.verify({ rawBody: deliveredBody, signature: deliveredSignature, secret: '' })).toEqual({ ok: false, reason: 'invalid-signature' });
    const tampered = await fetch(`http://127.0.0.1:${server.port}/tampered`);
    expect(connector.verify({ rawBody: await tampered.text(), signature: tampered.headers.get('x-signature') ?? '', secret }))
      .toEqual({ ok: false, reason: 'invalid-signature' });
    expect(connector.parse({ type: 'heartbeat' }, deliveredId)).toBeNull();
    expect(connector.parse({ type: 'message', id: 7, text: 'Hello', sentAt: payload.sentAt }, deliveredId)).toBeNull();
    expect(connector.parse({ type: 'message', id: 'msg-7', text: 7, sentAt: payload.sentAt }, deliveredId)).toBeNull();
    expect(connector.parse({ ...payload, sentAt: 'not-a-date' }, deliveredId)).toBeNull();
    expect(connector.parse({ ...payload, id: '' }, deliveredId)).toBeNull();
    expect(connector.parse(null, deliveredId)).toBeNull();
    expect(connector.parse(payload, '')).toBeNull();
    const event = connector.parse(JSON.parse(deliveredBody), deliveredId);
    expect(event).toEqual({
      provider: 'mock-messenger', eventId: deliveryId, kind: 'created', ref: 'msg-7',
      title: 'Hello', body: 'Hello', url: '', priority: null, occurredAt: payload.sentAt,
    });
    expect(event).not.toBeNull();
    if (!event) throw new Error('mock messenger did not produce an event');
    const key = connector.idempotencyKey(event);
    expect(key).toBe(deliveryId);
    expect(ledger.record(event.provider, key, { ref: event.ref, occurredAt: event.occurredAt })).toBe(true);
    expect(ledger.record(event.provider, key, { ref: event.ref, occurredAt: event.occurredAt })).toBe(false);
    expect(ledger.record(event.provider, 'redelivery-2', { ref: event.ref, occurredAt: event.occurredAt })).toBe(false);
    expect(new EventLedger(ledger.path).seen(event.provider, key)).toBe(true);
    expect(ledger.seen('linear', key)).toBe(false);
    expect(ledger.record('linear', key, { ref: event.ref, occurredAt: event.occurredAt })).toBe(true);
    const next = connector.parse({ ...payload, text: 'Hello again', sentAt: '2026-10-08T00:01:00Z' }, 'delivery-2');
    expect(next?.kind).toBe('created');
    expect(next?.body).toBe('Hello again');
    expect(next && ledger.record(next.provider, connector.idempotencyKey(next), { ref: next.ref, occurredAt: next.occurredAt })).toBe(true);
    const outgoing = { ref: 'msg-9', occurredAt: '2026-10-08T00:02:00Z' };
    const now = Date.parse(outgoing.occurredAt) + 1_000;
    expect(ledger.record(connector.provider, 'outgoing:msg-9', outgoing)).toBe(true);
    expect(ledger.seenOutgoingChange(connector.provider, outgoing.ref, outgoing.occurredAt, now)).toBe(true);
    expect(ledger.seenOutgoingChange('linear', outgoing.ref, outgoing.occurredAt, now)).toBe(false);
    expect(ledger.seenOutgoingChange(connector.provider, outgoing.ref, outgoing.occurredAt, now + 24 * 60 * 60 * 1_000)).toBe(false);
    const persisted = readFileSync(ledger.path, 'utf8');
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain(signature);
    expect(persisted.trim().split('\n').map(line => JSON.parse(line))).toEqual([
      { provider: 'mock-messenger', eventId: deliveryId, ref: 'msg-7', occurredAt: payload.sentAt },
      { provider: 'linear', eventId: deliveryId, ref: 'msg-7', occurredAt: payload.sentAt },
      { provider: 'mock-messenger', eventId: 'delivery-2', ref: 'msg-7', occurredAt: '2026-10-08T00:01:00Z' },
      { provider: 'mock-messenger', eventId: 'outgoing:msg-9', ...outgoing },
    ]);
  } finally {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
