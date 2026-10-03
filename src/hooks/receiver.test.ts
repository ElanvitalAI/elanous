import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { openMsgStore } from '../msg/msg-store.js';
import { gatherSeatInputs } from '../seat-loop/seat-loop.js';
import { dispatchHook } from './dispatch.js';
import { parseEventsConfig } from '../user-config.js';
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
    expect(await (await fetch(new URL('/hooks/health', server.url))).json()).toEqual({ ok: true, queued: 0, reportsQueued: 0 });
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

test('signed Linear issue routes to one TC work card and one wake; duplicates do not redeliver', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hooks-route-'));
  const woken: string[] = [];
  const server = startHookReceiver({ port: 0, root, now: () => now, secrets: { linear: 'key' }, retryBaseMs: 10,
    events: parseEventsConfig({ mode: 'on', routes: [{ source: 'linear', kind: 'Issue:create', seat: 'TC', loop: 'seat' }] }),
    wakeSeat: async seat => { woken.push(seat); } });
  try {
    const raw = JSON.stringify({ type: 'Issue', action: 'create', webhookTimestamp: now, data: { id: 'issue-1', title: 'Build it', url: 'https://linear.app/test/issue/1' } });
    const send = () => fetch(new URL('/hooks/linear', server.url), { method: 'POST', headers: { 'Linear-Signature': signature(raw, 'key'), 'Linear-Delivery': 'delivery-1' }, body: raw });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    await waitFor(() => server.queue.count() === 0 && woken.length === 1);
    const store = openMsgStore(join(root, 'msg', 'messages.db'));
    try {
      expect(store.listByRecipient('TC')).toMatchObject([{ to: 'TC', kind: 'hook-task', body: expect.stringContaining('Build it') }]);
      expect(store.listByRecipient('OP')).toHaveLength(0);
      expect(store.db.query('SELECT source, kind, seat, loop, mode, woken FROM hook_work_cards').all())
        .toEqual([{ source: 'linear', kind: 'Issue:create', seat: 'TC', loop: 'seat', mode: 'on', woken: 1 }]);
      expect(woken).toEqual(['TC']);
      const inputs = await gatherSeatInputs('TC', { root, versions: () => [], schedules: () => [] });
      expect(inputs.requests).toMatchObject([{ source: 'hook', kind: 'hook-task', title: expect.stringContaining('Build it') }]);
    } finally { store.close(); }
  } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('unmatched signed event falls back to OP and default shadow records card with zero deliveries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hooks-shadow-'));
  const woken: string[] = [];
  const server = startHookReceiver({ port: 0, root, now: () => now, secrets: { linear: 'key' }, retryBaseMs: 10,
    events: parseEventsConfig({ routes: [{ source: 'asana', kind: 'task:changed', seat: 'TC', loop: 'seat' }] }),
    wakeSeat: async seat => { woken.push(seat); } });
  try {
    const raw = JSON.stringify({ type: 'Issue', action: 'create', webhookTimestamp: now, data: { id: 'issue-2', title: 'Shadow issue' } });
    expect((await fetch(new URL('/hooks/linear', server.url), { method: 'POST', headers: { 'Linear-Signature': signature(raw, 'key'), 'Linear-Delivery': 'delivery-2' }, body: raw })).status).toBe(200);
    await waitFor(() => server.queue.count() === 0);
    const store = openMsgStore(join(root, 'msg', 'messages.db'));
    try {
      expect(store.db.query('SELECT seat, mode, message_id FROM hook_work_cards').all()).toEqual([{ seat: 'OP', mode: 'shadow', message_id: null }]);
      expect(store.listByRecipient('OP')).toHaveLength(0);
      expect(store.listByRecipient('TC')).toHaveLength(0);
      expect(woken).toHaveLength(0);
    } finally { store.close(); }
  } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('an unmatched signed live event delivers one OP work card and wakes OP once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hooks-op-'));
  const woken: string[] = [];
  const server = startHookReceiver({ port: 0, root, now: () => now, secrets: { linear: 'key' }, retryBaseMs: 10,
    events: parseEventsConfig({ mode: 'on', routes: [] }), wakeSeat: async seat => { woken.push(seat); } });
  try {
    const raw = JSON.stringify({ type: 'Issue', action: 'create', webhookTimestamp: now, data: { id: 'issue-op', title: 'Unrouted' } });
    expect((await fetch(new URL('/hooks/linear', server.url), { method: 'POST', headers: { 'Linear-Signature': signature(raw, 'key'), 'Linear-Delivery': 'delivery-op' }, body: raw })).status).toBe(200);
    await waitFor(() => server.queue.count() === 0 && woken.length === 1);
    const store = openMsgStore(join(root, 'msg', 'messages.db'));
    try {
      expect(store.listByRecipient('OP')).toMatchObject([{ kind: 'hook-task', body: expect.stringContaining('Unrouted') }]);
      expect(store.listByRecipient('TC')).toHaveLength(0);
      expect(woken).toEqual(['OP']);
    } finally { store.close(); }
  } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('signed Linear assignee and status changes deliver exactly one card to the assigned seat; bad signatures are rejected', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hooks-linear-update-'));
  const woken: string[] = [];
  const server = startHookReceiver({ port: 0, root, now: () => now, secrets: { linear: 'linear-key' }, retryBaseMs: 10,
    events: parseEventsConfig({ mode: 'on', linearAssignees: { 'linear-user-mk': 'MK' } }), wakeSeat: async seat => { woken.push(seat); } });
  try {
    for (const [change, delivery, assignee] of [
      ['assigneeId', 'assigned', {}], ['stateId', 'status', { name: 'OP' }],
    ] as const) {
      const raw = JSON.stringify({ type: 'Issue', action: 'update', webhookTimestamp: now, updatedFrom: { [change]: 'old' },
        data: { id: 'issue-1', title: `Changed ${change}`, assigneeId: 'linear-user-mk', assignee, url: 'https://linear.app/issue/1' } });
      const headers = { 'Linear-Signature': signature(raw, 'linear-key'), 'Linear-Delivery': delivery };
      expect((await fetch(new URL('/hooks/linear', server.url), { method: 'POST', headers, body: raw })).status).toBe(200);
      expect((await fetch(new URL('/hooks/linear', server.url), { method: 'POST', headers, body: raw })).status).toBe(200);
      await waitFor(() => server.queue.count() === 0 && woken.length === (delivery === 'assigned' ? 1 : 2));
      expect((await fetch(new URL('/hooks/linear', server.url), { method: 'POST', headers: { ...headers, 'Linear-Signature': '0'.repeat(64), 'Linear-Delivery': `bad-${delivery}` }, body: raw })).status).toBe(401);
    }
    const store = openMsgStore(join(root, 'msg', 'messages.db'));
    try {
      expect(store.listByRecipient('MK')).toHaveLength(2);
      expect(store.listByRecipient('OP')).toHaveLength(0);
      expect(store.db.query('SELECT source, kind, seat, mode FROM hook_work_cards ORDER BY event_key').all())
        .toEqual([{ source: 'linear', kind: 'Issue:update', seat: 'MK', mode: 'on' }, { source: 'linear', kind: 'Issue:update', seat: 'MK', mode: 'on' }]);
      expect(woken).toEqual(['MK', 'MK']);
    } finally { store.close(); }
  } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('unmapped Linear assignee ID is not misdelivered to OP; mapping rejects invalid seats', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hooks-linear-unmapped-'));
  const config = parseEventsConfig({ mode: 'on', linearAssignees: { 'linear-user-1': 'INVALID', 'linear-user-2': 'UX' } });
  expect(config.linearAssignees['linear-user-1']).toBeUndefined();
  expect(config.linearAssignees['linear-user-2']).toBe('UX');
  const server = startHookReceiver({ port: 0, root, now: () => now, secrets: { linear: 'key' }, retryBaseMs: 10,
    events: config, wakeSeat: async () => {} });
  try {
    const raw = JSON.stringify({ type: 'Issue', action: 'update', webhookTimestamp: now, updatedFrom: { stateId: 'old' },
      data: { id: 'issue-unmapped', title: 'Unmapped assignee', assigneeId: 'linear-user-1', assignee: { name: 'OP' } } });
    expect((await fetch(new URL('/hooks/linear', server.url), { method: 'POST', headers: {
      'Linear-Signature': signature(raw, 'key'), 'Linear-Delivery': 'unmapped-1' }, body: raw })).status).toBe(200);
    await Bun.sleep(60);
    expect(server.queue.count()).toBe(1);
    const store = openMsgStore(join(root, 'msg', 'messages.db'));
    try {
      expect(store.listByRecipient('OP')).toHaveLength(0);
      expect(store.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hook_work_cards'").all()).toHaveLength(0);
    } finally { store.close(); }
  } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('Linear events.routes overrides the signed assignee seat', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hooks-linear-override-'));
  const server = startHookReceiver({ port: 0, root, now: () => now, secrets: { linear: 'key' }, retryBaseMs: 10,
    events: parseEventsConfig({ mode: 'on', linearAssignees: { 'linear-user-mk': 'MK' }, routes: [{ source: 'linear', kind: 'Issue:update', seat: 'UX', loop: 'seat' }] }),
    wakeSeat: async () => {} });
  try {
    const raw = JSON.stringify({ type: 'Issue', action: 'update', webhookTimestamp: now, updatedFrom: { stateId: 'old' },
      data: { id: 'issue-override', title: 'Status changed', assigneeId: 'linear-user-mk', assignee: { name: 'OP' } } });
    expect((await fetch(new URL('/hooks/linear', server.url), { method: 'POST', headers: {
      'Linear-Signature': signature(raw, 'key'), 'Linear-Delivery': 'override-1' }, body: raw })).status).toBe(200);
    await waitFor(() => server.queue.count() === 0);
    const store = openMsgStore(join(root, 'msg', 'messages.db'));
    try { expect(store.listByRecipient('UX')).toHaveLength(1); expect(store.listByRecipient('MK')).toHaveLength(0); }
    finally { store.close(); }
  } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('GitHub check failure and PR review request route to TC; events.routes can override and shadow stays silent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hooks-github-'));
  const woken: string[] = [];
  const server = startHookReceiver({ port: 0, root, secrets: { github: 'github-key' }, retryBaseMs: 10,
    events: parseEventsConfig({ mode: 'on', routes: [{ source: 'github', kind: 'pull_request:review_requested', seat: 'UX', loop: 'seat' }] }),
    wakeSeat: async seat => { woken.push(seat); } });
  try {
    const send = (event: string, body: object, delivery: string, secret = 'github-key') => {
      const raw = JSON.stringify(body);
      return fetch(new URL('/hooks/github', server.url), { method: 'POST', headers: {
        'X-GitHub-Event': event, 'X-GitHub-Delivery': delivery, 'X-Hub-Signature-256': `sha256=${signature(raw, secret)}` }, body: raw });
    };
    const failed = { action: 'completed', check_run: { id: 21, conclusion: 'failure', name: 'build', html_url: 'https://github.com/o/r/runs/21' } };
    expect((await send('check_run', failed, 'failure-1')).status).toBe(200);
    expect((await send('check_run', failed, 'failure-1')).status).toBe(200);
    await waitFor(() => server.queue.count() === 0 && woken.length === 1);
    expect((await send('check_run', failed, 'bad', 'wrong-key')).status).toBe(401);
    expect((await send('check_run', { ...failed, check_run: { ...failed.check_run, conclusion: 'success' } }, 'success')).status).toBe(200);
    expect((await send('pull_request', { action: 'review_requested', pull_request: { id: 22, title: 'Review', html_url: 'https://github.com/o/r/pull/22' } }, 'review-1')).status).toBe(200);
    await waitFor(() => server.queue.count() === 0 && woken.length === 2);
    const store = openMsgStore(join(root, 'msg', 'messages.db'));
    try {
      expect(store.listByRecipient('TC')).toHaveLength(1);
      expect(store.listByRecipient('TC')[0]?.body).toContain('Check failed: build');
      expect(store.listByRecipient('UX')).toHaveLength(1);
      expect(store.listByRecipient('OP')).toHaveLength(0);
      expect(store.db.query('SELECT source, kind, seat FROM hook_work_cards ORDER BY event_key').all()).toEqual([
        { source: 'github', kind: 'check_run:completed', seat: 'TC' },
        { source: 'github', kind: 'pull_request:review_requested', seat: 'UX' },
      ]);
      expect(woken).toEqual(['TC', 'UX']);
    } finally { store.close(); }
  } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
  const shadow = mkdtempSync(join(tmpdir(), 'hooks-github-shadow-'));
  const silent = startHookReceiver({ port: 0, root: shadow, secrets: { github: 'github-key' }, retryBaseMs: 10 });
  try {
    const raw = JSON.stringify({ action: 'completed', check_run: { id: 23, conclusion: 'failure', name: 'test', html_url: 'https://github.com/o/r/runs/23' } });
    expect((await fetch(new URL('/hooks/github', silent.url), { method: 'POST', body: raw, headers: {
      'X-GitHub-Event': 'check_run', 'X-GitHub-Delivery': 'shadow-check', 'X-Hub-Signature-256': `sha256=${signature(raw, 'github-key')}` } })).status).toBe(200);
    await waitFor(() => silent.queue.count() === 0);
    const store = openMsgStore(join(shadow, 'msg', 'messages.db'));
    try {
      expect(store.db.query('SELECT seat, mode, message_id FROM hook_work_cards').all()).toEqual([{ seat: 'TC', mode: 'shadow', message_id: null }]);
      expect(store.listByRecipient('TC')).toHaveLength(0);
    } finally { store.close(); }
  } finally { silent.stop(); rmSync(shadow, { recursive: true, force: true }); }
});

test('wake failure retries once without posting a second inbox message', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hooks-wake-retry-'));
  const event = { provider: 'linear' as const, eventId: 'retry-1', kind: 'Issue:create',
    task: { eventId: 'retry-1', title: 'Retry wake', external: { provider: 'linear' as const, ref: 'issue-3' } } };
  const config = parseEventsConfig({ mode: 'on', routes: [{ source: 'linear', kind: 'Issue:create', seat: 'TC', loop: 'seat' }] });
  let wakes = 0;
  try {
    await expect(dispatchHook(event, root, config, async () => { wakes++; throw new Error('wake unavailable'); })).rejects.toThrow('wake unavailable');
    await dispatchHook(event, root, config, async () => { wakes++; });
    await dispatchHook(event, root, config, async () => { wakes++; });
    const store = openMsgStore(join(root, 'msg', 'messages.db'));
    try {
      expect(store.listByRecipient('TC')).toHaveLength(1);
      expect(store.db.query('SELECT woken FROM hook_work_cards').all()).toEqual([{ woken: 1 }]);
      expect(wakes).toBe(2);
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('events on + seat loop off: card stays delivered, wake is terminal (woken 3) and not retried', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hooks-seat-off-'));
  const event = { provider: 'linear' as const, eventId: 'off-1', kind: 'Issue:create',
    task: { eventId: 'off-1', title: 'Seat off', external: { provider: 'linear' as const, ref: 'issue-9' } } };
  const config = parseEventsConfig({ mode: 'on', routes: [{ source: 'linear', kind: 'Issue:create', seat: 'TC', loop: 'seat' }] });
  let wakes = 0;
  try {
    await dispatchHook(event, root, config, async () => { wakes++; return { seat: 'TC', status: 'skipped-off' }; });
    await dispatchHook(event, root, config, async () => { wakes++; return { seat: 'TC', status: 'skipped-off' }; });
    const store = openMsgStore(join(root, 'msg', 'messages.db'));
    try {
      expect(store.listByRecipient('TC')).toHaveLength(1);
      expect(store.db.query('SELECT woken, wake_status FROM hook_work_cards').all()).toEqual([{ woken: 3, wake_status: 'skipped-off' }]);
      expect(wakes).toBe(1);
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('events on + shadow seat loop: wake is recorded as shadow, not as a real run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hooks-seat-shadow-'));
  const event = { provider: 'linear' as const, eventId: 'shadow-1', kind: 'Issue:create',
    task: { eventId: 'shadow-1', title: 'Seat shadow', external: { provider: 'linear' as const, ref: 'issue-10' } } };
  const config = parseEventsConfig({ mode: 'on', routes: [{ source: 'linear', kind: 'Issue:create', seat: 'TC', loop: 'seat' }] });
  try {
    await dispatchHook(event, root, config, async () => ({ seat: 'TC', status: 'shadow' }));
    const store = openMsgStore(join(root, 'msg', 'messages.db'));
    try {
      expect(store.db.query('SELECT woken, wake_status FROM hook_work_cards').all()).toEqual([{ woken: 1, wake_status: 'shadow' }]);
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('concurrent dispatches of the same event claim one wake while it is pending', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hooks-concurrent-'));
  const event = { provider: 'linear' as const, eventId: 'concurrent-1', kind: 'Issue:create',
    task: { eventId: 'concurrent-1', title: 'One wake', external: { provider: 'linear' as const, ref: 'issue-4' } } };
  const config = parseEventsConfig({ mode: 'on', routes: [{ source: 'linear', kind: 'Issue:create', seat: 'TC', loop: 'seat' }] });
  let releaseWake!: () => void;
  const heldWake = new Promise<void>(resolve => { releaseWake = resolve; });
  const woken: string[] = [];
  const wake = async (seat: string) => { woken.push(seat); await heldWake; };
  try {
    const first = dispatchHook(event, root, config, wake);
    try {
      expect(woken).toEqual(['TC']);
      await dispatchHook(event, root, config, wake);
      expect(woken).toEqual(['TC']);
    } finally { releaseWake(); }
    await first;
    await dispatchHook(event, root, config, wake);
    const store = openMsgStore(join(root, 'msg', 'messages.db'));
    try {
      expect(store.listByRecipient('TC')).toHaveLength(1);
      expect(store.db.query('SELECT woken FROM hook_work_cards').all()).toEqual([{ woken: 1 }]);
      expect(woken).toEqual(['TC']);
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an expired wake claim is reclaimed atomically without reposting and stale owners cannot overwrite it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hooks-expired-'));
  const event = { provider: 'linear' as const, eventId: 'expired-1', kind: 'Issue:create',
    task: { eventId: 'expired-1', title: 'Recover wake', external: { provider: 'linear' as const, ref: 'issue-5' } } };
  const config = parseEventsConfig({ mode: 'on', routes: [{ source: 'linear', kind: 'Issue:create', seat: 'TC', loop: 'seat' }] });
  let time = 1_700_000_000_000;
  let releaseOld!: () => void;
  const oldWake = new Promise<void>(resolve => { releaseOld = resolve; });
  let wakes = 0;
  try {
    const stale = dispatchHook(event, root, config, async () => { wakes++; await oldWake; }, () => time);
    try {
      const store = openMsgStore(join(root, 'msg', 'messages.db'));
      try {
        expect(store.db.query('SELECT woken, wake_lease_until FROM hook_work_cards').all())
          .toEqual([{ woken: 2, wake_lease_until: time + 120_000 }]);
        expect(store.listByRecipient('TC')).toHaveLength(1);
      } finally { store.close(); }
      await dispatchHook(event, root, config, async () => { wakes++; }, () => time + 119_999);
      expect(wakes).toBe(1);
      time += 120_000;
      let releaseNew!: () => void;
      const newWake = new Promise<void>(resolve => { releaseNew = resolve; });
      const recovered = dispatchHook(event, root, config, async () => { wakes++; await newWake; }, () => time);
      try {
        await dispatchHook(event, root, config, async () => { wakes++; }, () => time);
        expect(wakes).toBe(2);
        releaseOld();
        await stale;
        const mid = openMsgStore(join(root, 'msg', 'messages.db'));
        try { expect(mid.db.query('SELECT woken FROM hook_work_cards').all()).toEqual([{ woken: 2 }]); }
        finally { mid.close(); }
      } finally { releaseNew(); }
      await recovered;
      await dispatchHook(event, root, config, async () => { wakes++; }, () => time + 1);
      const done = openMsgStore(join(root, 'msg', 'messages.db'));
      try {
        expect(done.listByRecipient('TC')).toHaveLength(1);
        expect(done.db.query('SELECT woken, wake_claim, wake_lease_until FROM hook_work_cards').all())
          .toEqual([{ woken: 1, wake_claim: null, wake_lease_until: null }]);
        expect(wakes).toBe(2);
      } finally { done.close(); }
    } finally { releaseOld(); await stale; }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('forwarding goes to hooks.primaryUrl (the nexus API), and a missing or non-http address is refused', () => {
  expect(hooksPrimaryUrl({ hooks: { primaryUrl: 'https://mbp.example.ts.net' } }).origin).toBe('https://mbp.example.ts.net');
  expect(() => hooksPrimaryUrl({})).toThrow('hooks.primaryUrl missing');
  expect(() => hooksPrimaryUrl({ hooks: { primaryUrl: 'file:///etc/passwd' } })).toThrow('http(s)');
});
