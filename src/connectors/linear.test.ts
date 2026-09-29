import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLedger } from './event-ledger.js';
import { fetchLinearIssues, parseLinearWebhook, toTaskRequest, verifyLinearWebhook } from './linear.js';

const now = Date.now();
const issue = (priority: number, n: number) => ({ id: `id-${n}`, identifier: `ELA-${n}`, title: `Issue ${n}`, description: 'What is done?', url: `https://linear.app/issue/ELA-${n}`, priority, updatedAt: new Date(now).toISOString() });
const payload = { type: 'Issue', action: 'create', webhookTimestamp: now, data: issue(1, 5) };
const rawBody = JSON.stringify(payload);
const signature = createHmac('sha256', 'known-secret').update(rawBody).digest('hex');

test('known signature accepts exact raw body, rejects a changed byte', () => {
  expect(verifyLinearWebhook({ rawBody, signature, secret: 'known-secret', now })).toEqual({ ok: true });
  expect(verifyLinearWebhook({ rawBody: rawBody.replace('Issue 5', 'Issue 6'), signature, secret: 'known-secret', now })).toEqual({ ok: false, reason: 'invalid-signature' });
});

test('validly signed 2-minute-old timestamp cannot be replayed', () => {
  const stale = JSON.stringify({ ...payload, webhookTimestamp: now - 120_000 });
  expect(verifyLinearWebhook({ rawBody: stale, signature: createHmac('sha256', 'known-secret').update(stale).digest('hex'), secret: 'known-secret', now }))
    .toEqual({ ok: false, reason: 'timestamp-outside-window' });
});

test('timestamp window accepts its boundary and rejects future, missing and non-integer timestamps', () => {
  const signed = (webhookTimestamp: unknown) => {
    const rawBody = JSON.stringify({ ...payload, webhookTimestamp });
    return verifyLinearWebhook({ rawBody, signature: createHmac('sha256', 'known-secret').update(rawBody).digest('hex'), secret: 'known-secret', now });
  };
  expect(signed(now - 60_000)).toEqual({ ok: true });
  expect(signed(now + 60_001)).toEqual({ ok: false, reason: 'timestamp-outside-window' });
  expect(signed(null)).toEqual({ ok: false, reason: 'timestamp-outside-window' });
  expect(signed(now + 0.5)).toEqual({ ok: false, reason: 'timestamp-outside-window' });
});

test('Issue create parses stable reference and delivery event id; other events ignored', () => {
  expect(parseLinearWebhook(payload, 'delivery-1')).toMatchObject({ eventId: 'delivery-1', kind: 'created', ref: 'id-5', identifier: 'ELA-5', priority: 'urgent' });
  expect(parseLinearWebhook({ ...payload, action: 'update' }, 'delivery-2')).toMatchObject({ eventId: 'delivery-2', kind: 'updated', ref: 'id-5' });
  expect(parseLinearWebhook({ ...payload, type: 'Comment' }, 'delivery-2')).toBeNull();
  expect(parseLinearWebhook({ ...payload, action: 'remove' }, 'delivery-2')).toBeNull();
  expect(parseLinearWebhook(payload, '')).toBeNull();
});

test('GraphQL fetch maps priorities 1, 2, 3, 4, 0 to TOX and retains identifier in title', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return Response.json({ data: { issues: { nodes: [1, 2, 3, 4, 0].map((p, i) => issue(p, i + 5)), pageInfo: { hasNextPage: false, endCursor: null } } } });
  };
  const events = await fetchLinearIssues({ apiKey: 'test-key', teamKey: 'ELA', fetch: fakeFetch as typeof fetch });
  expect(calls[0]?.url).toBe('https://api.linear.app/graphql');
  expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe('test-key');
  expect(events.map(e => e.eventId)).toEqual([5, 6, 7, 9, 8].map(n => `id-${n}:${new Date(now).toISOString()}`));
  expect(events.map(e => e.priority)).toEqual(['urgent', 'high', 'medium', null, 'low']);
  expect(events.map(e => toTaskRequest(e).priority)).toEqual(['high', 'high', 'medium', 'medium', 'low']);
  expect(events.map(e => toTaskRequest(e).title)).toEqual([5, 6, 7, 9, 8].map(n => `ELA-${n} Issue ${n}`));
  expect(toTaskRequest(events[0]!).description).toBe('원래 우선순위: Urgent\n\nWhat is done?');
  expect(toTaskRequest(events[0]!).external).toEqual({ provider: 'linear', ref: 'id-5', url: 'https://linear.app/issue/ELA-5', team: 'ELA' });
});

test('GraphQL walks pages and filters by title prefix or label and updatedAt', async () => {
  const pages: Array<string | null> = [];
  const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
    const after = JSON.parse(init!.body as string).variables.after as string | null;
    pages.push(after);
    return Response.json({ data: { issues: {
      nodes: after ? [{ ...issue(2, 8), title: 'Other', labels: { nodes: [{ name: 'lab' }] } }, issue(4, 9)]
        : [{ ...issue(1, 5), title: 'lab First' }, { ...issue(3, 6), updatedAt: '2020-01-01T00:00:00Z', title: '[lab] Old' }],
      pageInfo: { hasNextPage: !after, endCursor: after ? null : 'page-2' },
    } } });
  };
  const events = await fetchLinearIssues({ apiKey: 'test-key', teamKey: 'ELA', labelOrPrefix: 'lab', since: '2026-01-01', fetch: fakeFetch as typeof fetch });
  expect(pages).toEqual([null, 'page-2']);
  expect(events.map(e => e.identifier)).toEqual(['ELA-5', 'ELA-8']);
});

test('GraphQL returns Urgent issues first so they are created before High ones', async () => {
  const fakeFetch = async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ data: { issues: {
    nodes: [issue(4, 21), issue(2, 22), issue(0, 23), issue(1, 24), issue(3, 25), issue(1, 26)],
    pageInfo: { hasNextPage: false, endCursor: null },
  } } });
  const events = await fetchLinearIssues({ apiKey: 'test-key', teamKey: 'ELA', fetch: fakeFetch as typeof fetch });
  expect(events.map(e => e.identifier)).toEqual(['ELA-24', 'ELA-26', 'ELA-22', 'ELA-23', 'ELA-25', 'ELA-21']);
});

test('GraphQL requests state type and excludes completed, canceled and duplicate issues', async () => {
  let query = '';
  const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
    query = JSON.parse(init!.body as string).query;
    return Response.json({ data: { issues: { nodes: [
      { ...issue(1, 11), state: { type: 'started' } },
      { ...issue(2, 12), state: { type: 'completed' } },
      { ...issue(3, 13), state: { type: 'canceled' } },
      { ...issue(4, 14), state: { type: 'duplicate' } },
      { ...issue(0, 15), state: { type: 'unstarted' } },
    ], pageInfo: { hasNextPage: false } } } });
  };
  const events = await fetchLinearIssues({ apiKey: 'test-key', teamKey: 'ELA', fetch: fakeFetch as typeof fetch });
  expect(query).toContain('state { type }');
  expect(events.map(e => e.identifier)).toEqual(['ELA-11', 'ELA-15']);
});

test('task title truncates at 80 characters with ellipsis after identifier', () => {
  const event = parseLinearWebhook({ type: 'Issue', action: 'create', data: { ...issue(1, 16), title: 'A'.repeat(120) } }, 'long-title')!;
  const task = toTaskRequest(event);
  expect(task.title).toBe(`ELA-16 ${'A'.repeat(72)}…`);
  expect(task.title.length).toBe(80);
  expect(task.priority).toBe('high');
  expect(task.external.team).toBe('ELA');
});

test('webhook and pull ignore recent projector echoes but retain unrelated and later issue changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'linear-echo-'));
  try {
    const ledger = new EventLedger(join(dir, 'events.jsonl'));
    const updatedAt = new Date().toISOString();
    const ownIssue = { ...issue(1, 5), updatedAt };
    const otherIssue = { ...issue(2, 6), updatedAt };
    ledger.record('linear', 'outgoing:state:id-5:hash', { ref: ownIssue.id, occurredAt: updatedAt });
    expect(parseLinearWebhook({ type: 'Issue', action: 'update', data: ownIssue }, 'own-delivery', ledger)).toBeNull();
    expect(parseLinearWebhook({ type: 'Issue', action: 'update', data: otherIssue }, 'other-delivery', ledger)?.eventId).toBe('other-delivery');
    expect(parseLinearWebhook({ type: 'Issue', action: 'update', data: { ...ownIssue, updatedAt: new Date(Date.parse(updatedAt) + 1000).toISOString() } }, 'later-delivery', ledger)?.eventId).toBe('later-delivery');
    const fakeFetch = (async () => Response.json({ data: { issues: { nodes: [ownIssue, otherIssue, { ...ownIssue, updatedAt: new Date(Date.parse(updatedAt) + 1000).toISOString() }], pageInfo: { hasNextPage: false } } } })) as unknown as typeof fetch;
    const events = await fetchLinearIssues({ apiKey: 'key', teamKey: 'ELA', ledger, fetch: fakeFetch });
    expect(events.map(event => event.eventId)).toEqual([`id-5:${new Date(Date.parse(updatedAt) + 1000).toISOString()}`, `id-6:${updatedAt}`]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an inbound ledger entry or an old projector entry does not suppress a normal webhook change', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linear-echo-'));
  try {
    const ledger = new EventLedger(join(dir, 'events.jsonl'));
    const currentIssue = { ...issue(1, 5), updatedAt: new Date().toISOString() };
    const oldIssue = { ...issue(2, 6), updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() };
    ledger.record('linear', 'inbound-delivery', { ref: currentIssue.id, occurredAt: currentIssue.updatedAt });
    ledger.record('linear', 'outgoing:state:id-6:hash', { ref: oldIssue.id, occurredAt: oldIssue.updatedAt });
    expect(parseLinearWebhook({ type: 'Issue', action: 'update', data: currentIssue }, 'new-delivery', ledger)?.eventId).toBe('new-delivery');
    expect(parseLinearWebhook({ type: 'Issue', action: 'update', data: oldIssue }, 'old-delivery', ledger)?.eventId).toBe('old-delivery');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('GraphQL rejects a repeated pagination cursor rather than fetching forever', async () => {
  const fakeFetch = async () => Response.json({ data: { issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'same' } } } });
  await expect(fetchLinearIssues({ apiKey: 'key', teamKey: 'ELA', fetch: fakeFetch as unknown as typeof fetch }))
    .rejects.toThrow('pagination cursor missing or repeated');
});
