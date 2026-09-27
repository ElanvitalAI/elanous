import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { toExternalTask, verifyWebhook } from './providers.js';

const now = 1_700_000_000_000;
const payload = (stamp: number) => Buffer.from(JSON.stringify({ type: 'Issue', action: 'create', webhookTimestamp: stamp, webhookId: 'hook-1', createdAt: '2026-01-01', data: { id: 'issue-1', identifier: 'ELA-1', title: 'Fix issue', url: 'https://linear.app/issue/1' } }));
const sign = (raw: Buffer, secret = 'linear-key') => createHmac('sha256', secret).update(raw).digest('hex');

describe('Linear validation', () => {
  test('signed current event is accepted and converted', () => {
    const raw = payload(now);
    const result = verifyWebhook('linear', raw, new Headers({ 'Linear-Signature': sign(raw), 'Linear-Delivery': 'delivery-1' }), 'linear-key', now);
    expect(result.ok).toBe(true);
    if (result.ok) expect(toExternalTask('linear', { ...(result.body as object), eventId: result.eventIds[0] })).toEqual({
      eventId: 'delivery-1', title: 'Fix issue', external: { provider: 'linear', ref: 'issue-1', url: 'https://linear.app/issue/1' },
    });
  });
  test('without delivery header uses webhookId and createdAt', () => {
    const raw = payload(now);
    const result = verifyWebhook('linear', raw, new Headers({ 'Linear-Signature': sign(raw) }), 'linear-key', now);
    expect(result.ok && result.eventIds).toEqual(['hook-1:2026-01-01']);
    if (result.ok) expect(toExternalTask('linear', result.body).eventId).toBe('hook-1:2026-01-01');
  });
  test('altered signature is rejected', () => {
    const raw = payload(now);
    const signature = sign(raw);
    expect(verifyWebhook('linear', raw, new Headers({ 'Linear-Signature': `0${signature.slice(1)}` }), 'linear-key', now)).toEqual({ ok: false, reason: 'bad-signature' });
  });
  test('signed 10-minute-old payload is stale', () => {
    const raw = payload(now - 600_000);
    expect(verifyWebhook('linear', raw, new Headers({ 'Linear-Signature': sign(raw) }), 'linear-key', now)).toEqual({ ok: false, reason: 'stale' });
  });
});

describe('Linear events that are not issue creation', () => {
  test('a signed comment event is accepted but ignored — refusing it would make Linear disable the webhook', () => {
    const raw = Buffer.from(JSON.stringify({ type: 'Comment', action: 'create', webhookTimestamp: now, data: { id: 'c-1', body: 'hi' } }));
    expect(verifyWebhook('linear', raw, new Headers({ 'Linear-Signature': sign(raw) }), 'linear-key', now))
      .toEqual({ ok: true, body: expect.anything(), eventIds: [], ignored: 'Comment:create' });
  });
  test('an unsigned comment event is still rejected', () => {
    const raw = Buffer.from(JSON.stringify({ type: 'Comment', action: 'create', webhookTimestamp: now, data: { id: 'c-1' } }));
    expect(verifyWebhook('linear', raw, new Headers({ 'Linear-Signature': '0'.repeat(64) }), 'linear-key', now)).toEqual({ ok: false, reason: 'bad-signature' });
  });
});
