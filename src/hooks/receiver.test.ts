import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { debug } from '../debug/log.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hooksPrimaryUrl, startHookReceiver } from './receiver.js';

const now = 1_700_000_000_000;
const signature = (raw: string, secret: string) => createHmac('sha256', secret).update(raw).digest('hex');
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await Bun.sleep(10); }
  throw new Error('timeout waiting for hook drain');
}

test('Asana handshake returns and saves secret; subsequent signed event reaches queue', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hooks-asana-'));
  let stored: string | undefined;
  const server = startHookReceiver({ port: 0, root, secrets: { saveAsana: async secret => { stored = secret; } }, forward: async () => 503, retryBaseMs: 100_000 });
  try {
    const response = await fetch(new URL('/hooks/asana', server.url), { method: 'POST', headers: { 'X-Hook-Secret': 'abc' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Hook-Secret')).toBe('abc');
    expect(stored).toBe('abc');
    const raw = JSON.stringify({ events: [{ action: 'changed', created_at: '2026-01-01', resource: { gid: 'gid-1' }, task: { name: 'Asana task', permalink_url: 'https://app.asana.com/0/1' } }] });
    const event = await fetch(new URL('/hooks/asana', server.url), { method: 'POST', headers: { 'X-Hook-Signature': signature(raw, 'abc') }, body: raw });
    expect(event.status).toBe(200);
    expect(server.queue.count()).toBe(1);
    expect(server.queue.entries()[0]?.task).toMatchObject({ title: 'Asana task', external: { provider: 'asana', ref: 'gid-1' } });
  } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('rejections disclose only provider and reason, never the signature or body', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hooks-rejected-'));
  const records: Array<{ event?: string; data?: unknown }> = [];
  const off = debug.registerSink({ name: 'hook-rejection-test', emit: (record) => {
    if (record.category === 'hooks.receiver') records.push(record);
  } });
  const server = startHookReceiver({ port: 0, root, now: () => now, secrets: { linear: 'key' }, forward: async () => 201 });
  try {
    const raw = JSON.stringify({ webhookTimestamp: now, data: { id: 'private-id', title: 'secret body' } });
    const signature = 'f'.repeat(64);
    const response = await fetch(new URL('/hooks/linear', server.url), { method: 'POST', headers: { 'Linear-Signature': signature }, body: raw });
    expect(response.status).toBe(401);
    expect(server.queue.count()).toBe(0);
    expect(records.map(record => ({ event: record.event, data: record.data }))).toEqual([
      { event: 'rejected', data: expect.objectContaining({ provider: 'linear', reason: 'bad-signature' }) },
    ]);
    const logged = JSON.stringify(records);
    expect(logged).not.toContain(signature);
    expect(logged).not.toContain('private-id');
    expect(logged).not.toContain('secret body');
  } finally { server.stop(); off(); rmSync(root, { recursive: true, force: true }); }
});

test('validated event is 200 with Primary unavailable, deduped, and retried through 201', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hooks-linear-'));
  let calls = 0;
  let success = 0;
  const server = startHookReceiver({ port: 0, root, now: () => now, retryBaseMs: 10, secrets: { linear: 'key' }, forward: async () => {
    calls++;
    if (calls < 3) return 503;
    success++;
    return 201;
  } });
  try {
    const raw = JSON.stringify({ type: 'Issue', action: 'create', webhookTimestamp: now, data: { id: 'issue-1', identifier: 'ELA-1', title: 'Linear task' } });
    const send = () => fetch(new URL('/hooks/linear', server.url), { method: 'POST', headers: { 'Linear-Signature': signature(raw, 'key'), 'Linear-Delivery': 'delivery-1' }, body: raw });
    expect((await send()).status).toBe(200);
    expect(server.queue.count()).toBe(1);
    expect(calls).toBe(0);
    expect((await send()).status).toBe(200);
    expect(server.queue.count()).toBe(1);
    await waitFor(() => calls === 3 && server.queue.count() === 0);
    expect(success).toBe(1);
    expect(server.queue.lastDelivered()).toBe(new Date(now).toISOString());
    expect(await (await fetch(new URL('/hooks/health', server.url))).json()).toEqual({ ok: true, queued: 0 });
    const wrong = await fetch(new URL('/hooks/linear', server.url), { method: 'POST', headers: { 'Linear-Signature': '0'.repeat(64) }, body: raw });
    expect(wrong.status).toBe(401);
    const old = JSON.stringify({ type: 'Issue', action: 'create', webhookTimestamp: now - 600_000, data: { id: 'issue-2', title: 'Old task' } });
    const stale = await fetch(new URL('/hooks/linear', server.url), { method: 'POST',
      headers: { 'Linear-Signature': signature(old, 'key'), 'Linear-Delivery': 'delivery-old' }, body: old });
    expect(stale.status).toBe(401);
    expect(server.queue.count()).toBe(0);
  } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('a signed non-issue Linear event is answered 200 and never queued or forwarded', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hooks-ignored-'));
  let calls = 0;
  const server = startHookReceiver({ port: 0, root, now: () => now, retryBaseMs: 10, secrets: { linear: 'key' }, forward: async () => { calls++; return 201; } });
  try {
    const raw = JSON.stringify({ type: 'Comment', action: 'create', webhookTimestamp: now, data: { id: 'c-1' } });
    const res = await fetch(new URL('/hooks/linear', server.url), { method: 'POST', headers: { 'Linear-Signature': signature(raw, 'key') }, body: raw });
    expect(res.status).toBe(200);
    await Bun.sleep(30);
    expect(server.queue.count()).toBe(0);
    expect(calls).toBe(0);
  } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('an Asana handshake is refused when no secret exists and saving was not armed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hooks-asana-'));
  const server = startHookReceiver({ port: 0, root, secrets: {} });
  try {
    const res = await fetch(new URL('/hooks/asana', server.url), { method: 'POST', headers: { 'X-Hook-Secret': 'attacker' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('x-hook-secret')).toBeNull();
  } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('forwarding goes to hooks.primaryUrl (the nexus API), and a missing or non-http address is refused', () => {
  expect(hooksPrimaryUrl({ hooks: { primaryUrl: 'https://mbp.example.ts.net' } }).origin).toBe('https://mbp.example.ts.net');
  expect(() => hooksPrimaryUrl({})).toThrow('hooks.primaryUrl missing');
  expect(() => hooksPrimaryUrl({ hooks: { primaryUrl: 'file:///etc/passwd' } })).toThrow('http(s)');
});
