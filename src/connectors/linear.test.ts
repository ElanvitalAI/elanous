import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLedger } from './event-ledger.js';
import { createLinearAttachment, createLinearIssue, createLinearTeamIssue, fetchLinearIssueStateType, fetchLinearIssues, fetchLinearProjectIssues, moveLinearIssueToStateType, parseLinearWebhook, toTaskRequest, uploadLinearFile, verifyLinearWebhook } from './linear.js';

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

test('GraphQL excludes wish-labeled issues across pages even when their titles look like wishes', async () => {
  const pages: Array<string | null> = [];
  const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
    const after = JSON.parse(init!.body as string).variables.after as string | null;
    pages.push(after);
    return Response.json({ data: { issues: {
      nodes: after
        ? [{ ...issue(2, 4), title: '원해요', labels: { nodes: [{ name: 'other' }] } }]
        : [{ ...issue(1, 1), title: '만들어 줘', labels: { nodes: [{ name: 'wish' }] } },
          { ...issue(2, 2), title: '해 줘', labels: { nodes: [{ name: 'WISH' }] } },
          { ...issue(3, 3), title: '있으면 좋겠다', labels: { nodes: [] } }],
      pageInfo: { hasNextPage: !after, endCursor: after ? null : 'next' },
    } } });
  };
  const events = await fetchLinearIssues({ apiKey: 'key', teamKey: 'ELA', excludeLabel: 'wish', fetch: fakeFetch as typeof fetch });
  expect(pages).toEqual([null, 'next']);
  expect(events.map(event => event.identifier)).toEqual(['ELA-4', 'ELA-3']);
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

test('project name resolves exactly, pages issues, omits done and keeps requested fields', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    calls.push(body);
    if (body.query.includes('CooProjects')) return Response.json({ data: { projects: { nodes: [{ id: 'project-1', name: '외부 행정·큰 일 (COO)' }], pageInfo: { hasNextPage: false } } } });
    const node = (n: number, type = 'started') => ({ identifier: `COO-${n}`, title: `행정 ${n}`, url: `https://linear.app/issue/COO-${n}`, state: { name: '진행', type }, dueDate: n === 4 ? null : `2026-10-0${n}`, priority: n, assignee: { name: '담당' }, updatedAt: '2026-10-01T00:00:00Z' });
    return Response.json({ data: { issues: body.variables.after
      ? { nodes: [node(3), node(4)], pageInfo: { hasNextPage: false } }
      : { nodes: [node(1), node(2, 'completed'), node(5, 'canceled')], pageInfo: { hasNextPage: true, endCursor: 'next' } } } });
  }) as unknown as typeof fetch;
  const result = await fetchLinearProjectIssues({ apiKey: 'key', project: '외부 행정·큰 일 (COO)', fetch: fakeFetch });
  expect(result.map(i => i.identifier)).toEqual(['COO-1', 'COO-3', 'COO-4']);
  expect(result.truncated).toBe(false);
  expect(result[0]).toMatchObject({ dueDate: '2026-10-01', state: { name: '진행', type: 'started' }, assignee: { name: '담당' } });
  expect(calls).toHaveLength(3);
  expect((calls[1]!.variables as { projectId: string }).projectId).toBe('project-1');
  expect(calls[1]!.query).toContain('dueDate priority assignee { name } updatedAt');
  expect((await fetchLinearProjectIssues({ apiKey: 'key', project: '외부 행정·큰 일 (COO)', includeDone: true, fetch: fakeFetch })).map(i => i.identifier)).toEqual(['COO-1', 'COO-2', 'COO-5', 'COO-3', 'COO-4']);
});

test('project name ambiguity and no match fail rather than guessing', async () => {
  const fakeFetch = (async (_url: string, init: RequestInit) => Response.json({ data: { projects: { nodes: [{ id: 'a', name: 'same' }, { id: 'b', name: 'same' }], pageInfo: { hasNextPage: false } } } })) as unknown as typeof fetch;
  await expect(fetchLinearProjectIssues({ apiKey: 'key', project: 'same', fetch: fakeFetch })).rejects.toThrow('프로젝트 이름이 여럿과 맞습니다');
  await expect(fetchLinearProjectIssues({ apiKey: 'key', project: 'missing', fetch: fakeFetch })).rejects.toThrow('프로젝트 이름과 맞는 항목이 없습니다');
});

test('project issue fetch caps at 250 while walking pages', async () => {
  let requests = 0;
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const { variables } = JSON.parse(init.body as string);
    requests++;
    const nodes = Array.from({ length: variables.first }, (_, i) => ({ identifier: `COO-${requests}-${i}`, state: { name: '진행', type: 'started' } }));
    return Response.json({ data: { issues: { nodes, pageInfo: { hasNextPage: true, endCursor: `page-${requests}` } } } });
  }) as unknown as typeof fetch;
  const issues = await fetchLinearProjectIssues({ apiKey: 'key', project: '12345678-1234-1234-1234-123456789abc', fetch: fetchFn });
  expect(issues).toHaveLength(250);
  expect(issues.truncated).toBe(true);
  expect(requests).toBe(3);
});

test('createLinearIssue carries parent, assignee and due date into the Linear mutation', async () => {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string) as { query: string; variables: Record<string, unknown> };
    calls.push(body);
    return Response.json({ data: body.query.includes('DecisionProjectTeam')
      ? { project: { teams: { nodes: [{ id: 'team-1', states: { nodes: [{ id: 'state-started', type: 'started' }] } }] } } }
      : { issueCreate: { success: true, issue: { id: 'issue-child' } } } });
  }) as typeof fetch;
  await expect(createLinearIssue({ apiKey: 'key', projectId: 'project-1', title: 'child', description: 'desc',
    parentId: 'issue-parent', assigneeId: 'user-1', dueDate: '2026-11-04', stateType: 'started', fetch: fakeFetch })).resolves.toBe('issue-child');
  expect(calls).toHaveLength(2);
  expect(calls[1]!.variables.input).toEqual({ teamId: 'team-1', projectId: 'project-1', title: 'child', description: 'desc',
    parentId: 'issue-parent', assigneeId: 'user-1', dueDate: '2026-11-04', stateId: 'state-started' });
});

test('createLinearIssue uses a team workflow for projectless parent and child issues', async () => {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(init!.body as string) as { query: string; variables: Record<string, unknown> };
    calls.push(request);
    if (request.query.includes('LinearTeamByKey')) return Response.json({ data: { teams: { nodes: [{ id: 'team-1', states: { nodes: [{ id: 'started', type: 'started' }] } }] } } });
    return Response.json({ data: { issueCreate: { success: true, issue: { id: 'issue-1' } } } });
  }) as typeof fetch;
  await expect(createLinearIssue({ apiKey: 'key', teamKey: 'DEMO', title: 'parent', description: 'grounded', dueDate: '2026-11-05', stateType: 'started', fetch: fakeFetch }))
    .resolves.toBe('issue-1');
  expect(calls[1]!.variables).toEqual({ input: { teamId: 'team-1', title: 'parent', description: 'grounded', dueDate: '2026-11-05', stateId: 'started' } });
  expect(calls[1]!.variables.input).not.toHaveProperty('projectId');
});

test('projectless team issue resolves a unique team key and omits projectId from issueCreate', async () => {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    calls.push(request);
    return request.query.includes('LinearTeamByKey')
      ? Response.json({ data: { teams: { nodes: [{ id: 'team-id' }] } } })
      : Response.json({ data: { issueCreate: { success: true, issue: { id: 'issue-id' } } } });
  }) as typeof fetch;
  await expect(createLinearTeamIssue({ apiKey: 'key', teamKey: ' DEMO ', title: ' test ', description: ' details ', fetch: fakeFetch }))
    .resolves.toBe('issue-id');
  expect(calls[0]!.variables).toEqual({ key: 'DEMO' });
  expect(calls[1]!.variables).toEqual({ input: { teamId: 'team-id', title: 'test', description: 'details' } });
  expect(calls[1]!.variables.input).not.toHaveProperty('projectId');
});

test('projectless team issue fails closed for a missing or ambiguous team key', async () => {
  const fakeFetch = (async () => Response.json({ data: { teams: { nodes: [{ id: 'one' }, { id: 'two' }] } } })) as unknown as typeof fetch;
  await expect(createLinearTeamIssue({ apiKey: 'key', teamKey: 'DEMO', title: 'test', fetch: fakeFetch })).rejects.toThrow('ambiguous');
});

test('projectless team issue refuses a requested workflow state that the team does not have', async () => {
  const calls: string[] = [];
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const query = JSON.parse(String(init?.body)).query as string;
    calls.push(query);
    return Response.json({ data: { teams: { nodes: [{ id: 'team-id', states: { nodes: [] } }] } } });
  }) as typeof fetch;
  await expect(createLinearTeamIssue({ apiKey: 'key', teamKey: 'DEMO', title: 'test', stateType: 'started', fetch: fakeFetch }))
    .rejects.toThrow('workflow state not found');
  expect(calls).toEqual([expect.stringContaining('LinearTeamByKey')]);
});

test('Linear attachmentCreate accepts HTTPS image URLs and rejects insecure URLs', async () => {
  let variables: Record<string, unknown> | undefined;
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    variables = JSON.parse(init!.body as string).variables;
    return Response.json({ data: { attachmentCreate: { success: true, attachment: { id: 'attachment-1' } } } });
  }) as typeof fetch;
  await expect(createLinearAttachment({ apiKey: 'key', issueId: 'issue-1', title: '진행 캡처', url: 'https://example.test/capture.png', fetch: fakeFetch })).resolves.toBe('attachment-1');
  expect(variables?.input).toEqual({ issueId: 'issue-1', title: '진행 캡처', url: 'https://example.test/capture.png' });
  await expect(createLinearAttachment({ apiKey: 'key', issueId: 'issue-1', title: 'bad', url: 'file:///capture.png', fetch: fakeFetch })).rejects.toThrow('HTTPS');
  await expect(createLinearAttachment({ apiKey: 'key', issueId: 'issue-1', title: 'bad', url: 'http://example.test/capture.png', fetch: fakeFetch })).rejects.toThrow('HTTPS');
});

test('Linear fileUpload requests a signed URL, copies required headers, and PUTs bytes server-side', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    if (String(url) === 'https://api.linear.app/graphql') return Response.json({ data: { fileUpload: { success: true, uploadFile: {
      uploadUrl: 'https://uploads.linear.app/signed', assetUrl: 'https://asset.linear.app/capture.png', headers: [{ key: 'x-storage-token', value: 'signed' }],
    } } } });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  const bytes = Buffer.from([137, 80, 78, 71]);
  await expect(uploadLinearFile({ apiKey: 'key', filename: 'capture.png', contentType: 'image/png', body: bytes, fetch: fakeFetch }))
    .resolves.toBe('https://asset.linear.app/capture.png');
  const graphql = JSON.parse(calls[0]!.init.body as string) as { query: string; variables: Record<string, unknown> };
  expect(graphql.query).toContain('fileUpload(contentType: $contentType, filename: $filename, size: $size)');
  expect(graphql.variables).toEqual({ contentType: 'image/png', filename: 'capture.png', size: 4 });
  expect(calls[1]!.url).toBe('https://uploads.linear.app/signed');
  expect(calls[1]!.init.method).toBe('PUT');
  expect(calls[1]!.init.body).toEqual(new Uint8Array(bytes));
  expect(new Headers(calls[1]!.init.headers).get('x-storage-token')).toBe('signed');
});

test('Linear state helper supports the Todo, In Progress and Done state types', async () => {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string);
    calls.push(body);
    return Response.json({ data: body.query.includes('IssueStates')
      ? { issue: { team: { states: { nodes: [{ id: 'todo', type: 'unstarted' }, { id: 'doing', type: 'started' }, { id: 'done', type: 'completed' }] } } } }
      : { issueUpdate: { success: true } } });
  }) as typeof fetch;
  await moveLinearIssueToStateType({ apiKey: 'key', issueId: 'issue-1', type: 'unstarted', fetch: fakeFetch });
  await moveLinearIssueToStateType({ apiKey: 'key', issueId: 'issue-1', type: 'started', fetch: fakeFetch });
  await moveLinearIssueToStateType({ apiKey: 'key', issueId: 'issue-1', type: 'completed', fetch: fakeFetch });
  expect(calls.filter(call => call.query.includes('DecisionIssueClose')).map(call => (call.variables.input as { stateId: string }).stateId)).toEqual(['todo', 'doing', 'done']);
});

test('project query filters done before the 250-item cap so later open issues remain visible', async () => {
  const completed = Array.from({ length: 250 }, (_, i) => ({ identifier: `DONE-${i}`, state: { name: '완료', type: 'completed' } }));
  const open = { identifier: 'OPEN-251', title: '남은 일', url: 'https://linear.app/issue/OPEN-251', state: { name: '진행', type: 'started' }, dueDate: null, priority: 1, assignee: null, updatedAt: '2026-10-02T00:00:00Z' };
  const all = [...completed, open];
  let requests = 0;
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    requests++;
    const { query, variables } = JSON.parse(init.body as string);
    const visible = query.includes('state: { type: { nin: ["completed", "canceled"] } }') ? [open] : all;
    const start = Number(variables.after ?? 0);
    const end = Math.min(start + variables.first, visible.length);
    return Response.json({ data: { issues: { nodes: visible.slice(start, end), pageInfo: { hasNextPage: end < visible.length, endCursor: String(end) } } } });
  }) as unknown as typeof fetch;
  const project = '12345678-1234-1234-1234-123456789abc';
  expect((await fetchLinearProjectIssues({ apiKey: 'key', project, fetch: fakeFetch })).map(i => i.identifier)).toEqual(['OPEN-251']);
  expect(requests).toBe(1);
  expect(await fetchLinearProjectIssues({ apiKey: 'key', project, includeDone: true, fetch: fakeFetch })).toHaveLength(250);
});

test('GraphQL rejects a repeated pagination cursor rather than fetching forever', async () => {
  const fakeFetch = async () => Response.json({ data: { issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'same' } } } });
  await expect(fetchLinearIssues({ apiKey: 'key', teamKey: 'ELA', fetch: fakeFetch as unknown as typeof fetch }))
    .rejects.toThrow('pagination cursor missing or repeated');
});

test('issue briefing can detect Done and move the issue back to an active state', async () => {
  const linearIssueId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const fetchFn = async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    calls.push(request);
    if (request.query.includes('LinearIssueStatus')) return Response.json({ data: { issue: { state: { type: 'completed' } } } });
    if (request.query.includes('DecisionIssueStates')) return Response.json({ data: { issue: { team: { states: { nodes: [{ id: 'started-id', type: 'started' }] } } } } });
    return Response.json({ data: { issueUpdate: { success: true } } });
  };
  expect(await fetchLinearIssueStateType({ apiKey: 'test', issueId: linearIssueId, fetch: fetchFn as typeof fetch })).toBe('completed');
  await moveLinearIssueToStateType({ apiKey: 'test', issueId: linearIssueId, type: 'started', fetch: fetchFn as typeof fetch });
  expect(calls[2]?.variables).toEqual({ id: linearIssueId, input: { stateId: 'started-id' } });
});
