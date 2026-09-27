import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLedger } from '../connectors/event-ledger.js';
import { applyLinearEvents, runLinearSetKey, runLinearSetWebhookSecret, runLinearSync, runLinearWebhook } from './connector-cli.js';
import { parseLinearWebhook } from '../connectors/linear.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('production connector command exposes signed internal receive and secret setup', async () => {
  const { program } = await import('../index.js');
  const linear = program.commands.find(command => command.name() === 'connector')!
    .commands.find(command => command.name() === 'linear')!;
  const receive = linear.commands.find(command => command.name() === 'receive')!;
  expect(receive).toBeDefined();
  expect(receive.options.map(option => option.long)).toEqual(['--signature', '--delivery']);
  expect(linear.commands.some(command => command.name() === 'set-webhook-secret')).toBe(true);
});

test('two syncs post twice then skip seen; output, JSON and logs never reveal the key', async () => {
  const root = mkdtempSync(join(tmpdir(), 'connector-cli-'));
  roots.push(root);
  const ledger = new EventLedger(join(root, 'connectors', 'events.jsonl'));
  const posts: Array<{ body: any; headers: Record<string, string> }> = [];
  const output: string[] = [];
  const logs: unknown[] = [];
  const secret = 'linear-private-key-sentinel';
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('api.linear.app')) {
      return Response.json({ data: { issues: { nodes: [5, 6].map(n => ({ id: `id-${n}`, identifier: `ELA-${n}`, title: `Issue ${n}`, description: 'Question?', url: `https://linear.app/ELA-${n}`, priority: n === 5 ? 1 : 2, updatedAt: '2026-09-27T00:00:00Z' })), pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    if (init?.method === 'GET') return Response.json({ tasks: posts.map((post, index) => ({ id: `tox-${index + 1}`, generatedBy: post.body.external })) });
    posts.push({ body: JSON.parse(init!.body as string), headers: init!.headers as Record<string, string> });
    return Response.json({ taskId: `tox-${posts.length}`, created: true });
  };
  const deps = { ledger, fetch: fakeFetch as typeof fetch, getSecret: async () => secret, bearerToken: 'nexus-test-token', baseUrl: 'http://127.0.0.1:31415', output: (s: string) => output.push(s), log: ((...args: unknown[]) => logs.push(args)) as any };
  expect(await runLinearSync({ team: 'ELA' }, deps)).toBe(0);
  expect(posts).toHaveLength(2);
  expect(posts[0]?.body).toMatchObject({ title: 'ELA-5 Issue 5', priority: 'high', description: '원래 우선순위: Urgent\n\nQuestion?', external: { provider: 'linear', ref: 'id-5', team: 'ELA' } });
  expect(posts[0]?.headers['x-elanous-trace-id']).toBeTruthy();
  expect(posts[0]?.headers.Authorization).toBe('Bearer nexus-test-token');
  expect(posts[1]?.headers['x-elanous-trace-id']).not.toBe(posts[0]?.headers['x-elanous-trace-id']);
  expect(logs.filter((entry: any) => entry[1] === 'posted').map((entry: any) => entry[2].traceId))
    .toEqual(posts.map(post => post.headers['x-elanous-trace-id']));
  expect(await runLinearSync({ team: 'ELA', json: true }, deps)).toBe(0);
  expect(posts).toHaveLength(2);
  expect(output.join('\n')).toContain('skipped-seen');
  expect(logs.some((entry: any) => entry[1] === 'skipped-seen')).toBe(true);
  expect(JSON.stringify({ output, logs })).not.toContain(secret);
  expect(JSON.stringify({ output, logs })).not.toContain('nexus-test-token');
});

test('seen Linear issue missing from Nexus is recreated; present issue and failed list read are skipped', async () => {
  const root = mkdtempSync(join(tmpdir(), 'connector-recreate-'));
  roots.push(root);
  const ledger = new EventLedger(join(root, 'events.jsonl'));
  const events = ['id-11', 'id-12'].map((id, index) => parseLinearWebhook({
    type: 'Issue', action: 'update', data: {
      id, identifier: `ELA-${11 + index}`, title: 'Issue', priority: 2, updatedAt: '2026-09-27T00:00:00Z',
    },
  }, `${id}-delivery`)!);
  for (const event of events) ledger.record('linear', event.eventId, { ref: event.ref, occurredAt: event.occurredAt });
  const posts: string[] = [];
  const output: string[] = [];
  const logs: unknown[] = [];
  const token = 'private-nexus-bearer';
  let listFails = false;
  let detailFails = false;
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
    if (init?.method === 'GET' && String(url).endsWith('/v1/tasks')) {
      return listFails ? Response.json({}, { status: 500 }) : Response.json({ tasks: [{ id: 'tox-11' }] });
    }
    if (init?.method === 'GET' && String(url).endsWith('/v1/tasks/tox-11')) {
      return detailFails ? Response.json({}, { status: 500 }) : Response.json({ task: { id: 'tox-11', generatedBy: { kind: 'external', provider: 'linear', ref: 'id-11' } } });
    }
    expect(init?.method).toBe('POST');
    const ref = JSON.parse(init!.body as string).external.ref as string;
    posts.push(ref);
    return Response.json({ taskId: `tox-${ref}`, created: true });
  };
  const deps = { ledger, fetch: fakeFetch as typeof fetch, bearerToken: token, baseUrl: 'http://127.0.0.1:31415',
    output: (line: string) => output.push(line), log: ((...args: unknown[]) => logs.push(args)) as any };
  expect(await applyLinearEvents(events, { json: true }, deps)).toBe(0);
  expect(posts).toEqual(['id-12']);
  expect(JSON.parse(output[0]!)).toEqual([
    { issue: 'ELA-11', taskId: null, status: 'skipped-seen' },
    { issue: 'ELA-12', taskId: 'tox-id-12', status: 'recreated' },
  ]);
  expect(logs.some((entry: any) => entry[1] === 'posted' && entry[2].ref === 'id-12')).toBe(true);
  listFails = true;
  output.length = 0;
  expect(await applyLinearEvents(events, { json: true }, deps)).toBe(0);
  expect(posts).toEqual(['id-12']);
  expect(JSON.parse(output[0]!)).toEqual(events.map(event => ({ issue: event.identifier, taskId: null, status: 'skipped-seen' })));
  listFails = false;
  detailFails = true;
  output.length = 0;
  expect(await applyLinearEvents(events, { json: true }, deps)).toBe(0);
  expect(posts).toEqual(['id-12']);
  expect(JSON.parse(output[0]!)).toEqual(events.map(event => ({ issue: event.identifier, taskId: null, status: 'skipped-seen' })));
  expect(JSON.stringify({ output, logs })).not.toContain(token);
});

test('sync isolates a 500 from other issues, skips Done, and retries only the failed issue', async () => {
  const root = mkdtempSync(join(tmpdir(), 'connector-batch-'));
  roots.push(root);
  const ledger = new EventLedger(join(root, 'events.jsonl'));
  const output: string[] = [];
  const logs: unknown[] = [];
  const posts: Array<{ title: string; description: string; priority: string; external: { ref: string; team: string } }> = [];
  const apiKey = 'linear-private-key-sentinel';
  const token = 'nexus-private-token-sentinel';
  let failUrgent = true;
  const updatedAt = '2026-09-27T00:00:00Z';
  const issues = [
    { id: 'urgent', identifier: 'ELA-11', title: '[eln] Urgent', priority: 1, state: { type: 'started' } },
    { id: 'long', identifier: 'ELA-12', title: `[eln] ${'L'.repeat(120)}`, priority: 2, state: { type: 'unstarted' } },
    { id: 'done', identifier: 'ELA-13', title: '[eln] Done', priority: 3, state: { type: 'completed' } },
    { id: 'normal', identifier: 'ELA-14', title: '[eln] Normal', priority: 0, state: { type: 'started' } },
  ].map(issue => ({ ...issue, description: 'Original body', updatedAt }));
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('api.linear.app')) return Response.json({ data: { issues: { nodes: issues, pageInfo: { hasNextPage: false } } } });
    if (init?.method === 'GET') return Response.json({ tasks: posts.map(post => ({ id: `tox-${post.external.ref}`, generatedBy: { provider: 'linear', ref: post.external.ref } })) });
    const body = JSON.parse(init!.body as string) as typeof posts[number];
    posts.push(body);
    if (body.title.length > 80 || body.priority === 'urgent') return Response.json({ reason: 'rejected' }, { status: 400 });
    if (body.external.ref === 'urgent' && failUrgent) return Response.json({ reason: 'unavailable' }, { status: 500 });
    return Response.json({ taskId: `tox-${body.external.ref}`, created: true });
  };
  const deps = { ledger, fetch: fakeFetch as typeof fetch, getSecret: async () => apiKey, bearerToken: token,
    baseUrl: 'http://127.0.0.1:31415', output: (line: string) => output.push(line), log: ((...args: unknown[]) => logs.push(args)) as any };
  expect(await runLinearSync({ team: 'ELA', prefix: '[eln]' }, deps)).toBe(1);
  expect(posts.map(post => post.external.ref)).toEqual(['urgent', 'long', 'normal']);
  expect(posts[0]).toMatchObject({ priority: 'high', description: '원래 우선순위: Urgent\n\nOriginal body', external: { team: 'ELA' } });
  expect(posts[1]!.title.length).toBe(80);
  expect(posts[1]!.title.endsWith('…')).toBe(true);
  expect(output).toEqual([
    'ELA-11\t-\tfailed\tNexus POST /v1/tasks HTTP 500',
    'ELA-12\ttox-long\tcreated',
    'ELA-14\ttox-normal\tcreated',
  ]);
  expect(ledger.seen('linear', `urgent:${updatedAt}`)).toBe(false);
  expect(ledger.seen('linear', `long:${updatedAt}`)).toBe(true);
  expect(ledger.seen('linear', `normal:${updatedAt}`)).toBe(true);
  expect(ledger.seen('linear', `done:${updatedAt}`)).toBe(false);
  expect(JSON.stringify({ output, logs })).not.toContain(apiKey);
  expect(JSON.stringify({ output, logs })).not.toContain(token);
  failUrgent = false;
  output.length = 0;
  expect(await runLinearSync({ team: 'ELA', prefix: '[eln]', json: true }, deps)).toBe(0);
  expect(posts.map(post => post.external.ref)).toEqual(['urgent', 'long', 'normal', 'urgent']);
  expect(JSON.parse(output[0]!)).toEqual([
    { issue: 'ELA-11', taskId: 'tox-urgent', status: 'created' },
    { issue: 'ELA-12', taskId: null, status: 'skipped-seen' },
    { issue: 'ELA-14', taskId: null, status: 'skipped-seen' },
  ]);
  expect(ledger.seen('linear', `urgent:${updatedAt}`)).toBe(true);
  expect(output[0]).not.toContain(apiKey);
});

test('a 500 on the first issue does not prevent later issues from posting', async () => {
  const root = mkdtempSync(join(tmpdir(), 'connector-first-failure-'));
  roots.push(root);
  const ledger = new EventLedger(join(root, 'events.jsonl'));
  const first = parseLinearWebhook({ type: 'Issue', action: 'create', data: {
    id: 'first', identifier: 'ELA-11', title: 'First', updatedAt: '2026-09-27T00:00:00Z', priority: 1,
  } }, 'first-event')!;
  const second = parseLinearWebhook({ type: 'Issue', action: 'create', data: {
    id: 'second', identifier: 'ELA-12', title: 'Second', updatedAt: '2026-09-27T00:00:00Z', priority: 2,
  } }, 'second-event')!;
  const posts: string[] = [];
  const output: string[] = [];
  const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'GET') return Response.json({ tasks: posts.map(ref => ({ id: `tox-${ref}`, generatedBy: { provider: 'linear', ref } })) });
    const ref = JSON.parse(init!.body as string).external.ref as string;
    posts.push(ref);
    return ref === 'first' ? Response.json({}, { status: 500 }) : Response.json({ taskId: 'tox-second' });
  };
  expect(await applyLinearEvents([first, second], { team: 'ELA' }, { ledger, fetch: fakeFetch as typeof fetch,
    bearerToken: 'test-token', baseUrl: 'http://127.0.0.1:31415', output: line => output.push(line), log: (() => {}) as any })).toBe(1);
  expect(posts).toEqual(['first', 'second']);
  expect(output).toEqual(['ELA-11\t-\tfailed\tNexus POST /v1/tasks HTTP 500', 'ELA-12\ttox-second\tcreated']);
  expect(ledger.seen('linear', first.eventId)).toBe(false);
  expect(ledger.seen('linear', second.eventId)).toBe(true);
});

test('Linear fetch failures cannot expose the API key in the returned error', async () => {
  const key = 'linear-private-key-sentinel';
  const fakeFetch = async () => { throw new Error(`request with ${key} failed`); };
  await expect(runLinearSync({ team: 'ELA' }, { getSecret: async () => key, fetch: fakeFetch as unknown as typeof fetch }))
    .rejects.toEqual(new Error('Linear GraphQL request failed'));
});

test('Nexus fetch failures are reported without exposing its bearer token', async () => {
  const root = mkdtempSync(join(tmpdir(), 'connector-safe-error-'));
  roots.push(root);
  const token = 'nexus-private-token-sentinel';
  const event = parseLinearWebhook({ type: 'Issue', action: 'create', data: {
    id: 'id-5', identifier: 'ELA-5', title: 'Issue 5', updatedAt: '2026-09-27T00:00:00Z', priority: 1,
  } }, 'delivery-1')!;
  const output: string[] = [];
  const logs: unknown[] = [];
  const ledger = new EventLedger(join(root, 'events.jsonl'));
  const fakeFetch = async () => { throw new Error(`request with ${token} failed`); };
  expect(await applyLinearEvents([event], { json: true }, { ledger, bearerToken: token,
    baseUrl: 'http://127.0.0.1:31415', fetch: fakeFetch as unknown as typeof fetch,
    output: line => output.push(line), log: ((...args: unknown[]) => logs.push(args)) as any })).toBe(1);
  expect(JSON.parse(output[0]!)).toEqual([{ issue: 'ELA-5', taskId: null, status: 'failed', reason: 'Nexus POST /v1/tasks request failed' }]);
  expect(ledger.seen('linear', event.eventId)).toBe(false);
  expect(JSON.stringify({ output, logs })).not.toContain(token);
});

test('missing secret exits 2 and dry-run neither posts nor marks seen', async () => {
  const output: string[] = [];
  expect(await runLinearSync({ team: 'ELA' }, { getSecret: async () => undefined, output: s => output.push(s) })).toBe(2);
  expect(output.join(' ')).toContain('connector.linear.apiKey');
  const root = mkdtempSync(join(tmpdir(), 'connector-dry-'));
  roots.push(root);
  const ledger = new EventLedger(join(root, 'events.jsonl'));
  let posts = 0;
  const fetchFn = async () => { posts++; return Response.json({ data: { issues: { nodes: [{ id: 'one', identifier: 'ELA-1', title: 'First', updatedAt: '2026-09-27T00:00:00Z', priority: 0 }], pageInfo: { hasNextPage: false } } } }); };
  expect(await runLinearSync({ team: 'ELA', dryRun: true }, { getSecret: async () => 'key', fetch: fetchFn as unknown as typeof fetch, ledger, output: () => {} })).toBe(0);
  expect(posts).toBe(1);
  expect(ledger.seen('linear', 'one:2026-09-27T00:00:00Z')).toBe(false);
});

test('a parsed webhook event shares the polling ledger and TOX apply path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'connector-webhook-'));
  roots.push(root);
  const ledger = new EventLedger(join(root, 'events.jsonl'));
  const event = parseLinearWebhook({ type: 'Issue', action: 'create', data: { id: 'id-5', identifier: 'ELA-5', title: 'Issue 5', updatedAt: '2026-09-27T00:00:00Z', priority: 1 } }, 'delivery-1');
  expect(event).not.toBeNull();
  const output: string[] = [];
  let posts = 0;
  const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'GET') return Response.json({ tasks: [{ id: 'tox-1', generatedBy: { provider: 'linear', ref: 'id-5' } }] });
    posts++;
    return Response.json({ taskId: 'tox-1', created: true });
  };
  const deps = { ledger, baseUrl: 'http://127.0.0.1:31415', bearerToken: 'nexus-test-token', fetch: fetchFn as unknown as typeof fetch, output: (line: string) => output.push(line), log: (() => {}) as any };
  expect(await applyLinearEvents([event!], {}, deps)).toBe(0);
  expect(await applyLinearEvents([event!], {}, deps)).toBe(0);
  expect(posts).toBe(1);
  expect(output.join(' ')).toContain('skipped-seen');
});

test('failed TOX POST does not record an event; retry can create it once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'connector-retry-'));
  roots.push(root);
  const ledger = new EventLedger(join(root, 'events.jsonl'));
  const event = parseLinearWebhook({ type: 'Issue', action: 'create', data: {
    id: 'id-5', identifier: 'ELA-5', title: 'Issue 5', updatedAt: '2026-09-27T00:00:00Z', priority: 1,
  } }, 'delivery-retry')!;
  let attempts = 0;
  const fetchFn = async () => ++attempts === 1
    ? Response.json({ error: 'unavailable' }, { status: 503 })
    : Response.json({ taskId: 'tox-5', created: true });
  const deps = { ledger, baseUrl: 'http://127.0.0.1:31415', bearerToken: 'test-token', fetch: fetchFn as unknown as typeof fetch, output: () => {}, log: (() => {}) as any };
  expect(await applyLinearEvents([event], {}, deps)).toBe(1);
  expect(ledger.seen('linear', event.eventId)).toBe(false);
  expect(await applyLinearEvents([event], {}, deps)).toBe(0);
  expect(ledger.seen('linear', event.eventId)).toBe(true);
  expect(attempts).toBe(2);
});

test('TOX deduplication records the event and reports the existing task id', async () => {
  const root = mkdtempSync(join(tmpdir(), 'connector-dedup-'));
  roots.push(root);
  const ledger = new EventLedger(join(root, 'events.jsonl'));
  const event = parseLinearWebhook({ type: 'Issue', action: 'update', data: {
    id: 'id-5', identifier: 'ELA-5', title: 'Issue 5', updatedAt: '2026-09-27T00:00:00Z', priority: 2,
  } }, 'delivery-dedup')!;
  const output: string[] = [];
  let posts = 0;
  const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'GET') return Response.json({ tasks: [{ id: 'existing-task', generatedBy: { provider: 'linear', ref: 'id-5' } }] });
    posts++;
    return Response.json({ taskId: 'existing-task', created: false });
  };
  const deps = { ledger, baseUrl: 'http://127.0.0.1:31415', bearerToken: 'test-token', fetch: fetchFn as unknown as typeof fetch, output: (line: string) => output.push(line), log: (() => {}) as any };
  expect(await applyLinearEvents([event], { json: true }, deps)).toBe(0);
  expect(JSON.parse(output[0]!)).toEqual([{ issue: 'ELA-5', taskId: 'existing-task', status: 'deduplicated' }]);
  expect(ledger.seen('linear', 'delivery-dedup')).toBe(true);
  expect(await applyLinearEvents([event], {}, deps)).toBe(0);
  expect(posts).toBe(1);
});

test('signed internal receive and polling deduplicate the same revision in both orders', async () => {
  for (const first of ['sync', 'receive'] as const) {
    const root = mkdtempSync(join(tmpdir(), 'connector-cross-'));
    roots.push(root);
    const ledger = new EventLedger(join(root, 'events.jsonl'));
    const now = Date.now();
    const updatedAt = new Date(now).toISOString();
    const issue = { id: 'id-5', identifier: 'ELA-5', title: 'Issue 5', description: 'Question?', url: 'https://linear.app/issue/ELA-5', priority: 1, updatedAt };
    const rawBody = JSON.stringify({ type: 'Issue', action: 'update', webhookTimestamp: now, data: issue });
    const webhookSecret = 'webhook-private-sentinel';
    const apiKey = 'api-private-sentinel';
    const signature = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
    const output: string[] = [];
    const logs: unknown[] = [];
    const posts: RequestInit[] = [];
    const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('api.linear.app')) return Response.json({ data: { issues: { nodes: [issue], pageInfo: { hasNextPage: false } } } });
      if (init?.method === 'GET') return Response.json({ tasks: posts.length ? [{ id: 'tox-5', generatedBy: { provider: 'linear', ref: 'id-5' } }] : [] });
      posts.push(init!);
      return Response.json({ taskId: 'tox-5', created: true });
    };
    const deps = { ledger, fetch: fetchFn as typeof fetch, getSecret: async (id: string) => id === 'connector.linear.webhookSecret' ? webhookSecret : apiKey,
      baseUrl: 'http://127.0.0.1:31415', bearerToken: 'nexus-private-sentinel', output: (line: string) => output.push(line), log: ((...args: unknown[]) => logs.push(args)) as any };
    const sync = () => runLinearSync({ team: 'ELA' }, deps);
    const receive = (deliveryId: string, body = rawBody, sig = signature) => runLinearWebhook({ rawBody: body, signature: sig, deliveryId, now }, deps);
    expect(await (first === 'sync' ? sync() : receive('delivery-1'))).toBe(0);
    expect(posts).toHaveLength(1);
    expect(await (first === 'sync' ? receive('delivery-1') : sync())).toBe(0);
    expect(posts).toHaveLength(1);
    expect(ledger.seenChange('linear', issue.id, updatedAt)).toBe(true);
    expect(output.join(' ')).toContain('skipped-seen');
    expect(await receive('delivery-2', rawBody.replace('Issue 5', 'Issue 6'))).toBe(2);
    expect(await receive('delivery-3', JSON.stringify({ ...JSON.parse(rawBody), webhookTimestamp: now - 120_000 }), createHmac('sha256', webhookSecret).update(JSON.stringify({ ...JSON.parse(rawBody), webhookTimestamp: now - 120_000 })).digest('hex'))).toBe(2);
    expect(posts).toHaveLength(1);
    expect(JSON.stringify({ output, logs })).not.toContain(apiKey);
    expect(JSON.stringify({ output, logs })).not.toContain(webhookSecret);
    expect(JSON.stringify({ output, logs })).not.toContain('nexus-private-sentinel');
    const next = { ...issue, updatedAt: new Date(now + 1000).toISOString(), title: 'Issue 5 next' };
    const nextBody = JSON.stringify({ type: 'Issue', action: 'update', webhookTimestamp: now, data: next });
    expect(await receive('delivery-next', nextBody, createHmac('sha256', webhookSecret).update(nextBody).digest('hex'))).toBe(0);
    expect(posts).toHaveLength(2);
    expect(ledger.seenChange('linear', next.id, next.updatedAt)).toBe(true);
  }
});

test('set-key reads stdin dependency and saves without printing value', async () => {
  const output: string[] = [];
  let saved: [string, string] | undefined;
  expect(await runLinearSetKey({ readKey: async () => 'sensitive-key\n', setSecret: async (id, value) => { saved = [id, value]; }, output: s => output.push(s) })).toBe(0);
  expect(saved).toEqual(['connector.linear.apiKey', 'sensitive-key']);
  expect(output.join(' ')).not.toContain('sensitive-key');
  output.length = 0;
  expect(await runLinearSetWebhookSecret({ readKey: async () => 'webhook-sensitive\n', setSecret: async (id, value) => { saved = [id, value]; }, output: s => output.push(s) })).toBe(0);
  expect(saved).toEqual(['connector.linear.webhookSecret', 'webhook-sensitive']);
  expect(output.join(' ')).not.toContain('webhook-sensitive');
});
