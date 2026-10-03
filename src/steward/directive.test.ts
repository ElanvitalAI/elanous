import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addDirective, directiveHash, loadDirectiveOrigin, loadDirectiveOrigins } from './directive.js';

function fakeLinear() {
  const calls: Array<{ query: string; variables: Record<string, any>; headers: Record<string, string> }> = [];
  let issue: { id: string; identifier: string; title: string; description: string } | undefined;
  const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, any> };
    calls.push({ query, variables, headers: init?.headers as Record<string, string> });
    if (query.includes('teams(')) return Response.json({ data: { teams: { nodes: [{ id: 'team-1' }] } } });
    if (query.includes('issues(')) return Response.json({ data: { issues: { nodes: issue ? [{ ...issue, state: { type: 'started' } }] : [], pageInfo: { hasNextPage: false, endCursor: null } } } });
    if (query.includes('issueLabels(')) return Response.json({ data: { issueLabels: { nodes: [{ id: 'label-1', name: 'from-directive' }] } } });
    if (query.includes('issueCreate(')) {
      issue = { id: 'issue-1', identifier: 'ELA-1', title: variables.input.title, description: variables.input.description };
      return Response.json({ data: { issueCreate: { success: true, issue } } });
    }
    if (query.includes('commentCreate(')) return Response.json({ data: { commentCreate: { success: true } } });
    return Response.json({ errors: [{ message: 'unexpected operation' }] });
  };
  return { calls, fetch: fetchFn as typeof fetch };
}

test('directive creates a Linear issue then repeats as a comment, without leaking its credential', async () => {
  const fake = fakeLinear();
  const deps = { fetch: fake.fetch, getSecret: async () => 'private-token', team: 'ELA', now: () => new Date('2026-09-28T00:00:00Z') };
  expect((await addDirective('PTY 우선', { source: 'telegram' }, deps)).status).toBe('created');
  expect((await addDirective('  PTY   우선 ', { source: 'tui' }, deps)).status).toBe('repeated');
  expect(fake.calls.filter(c => c.query.includes('issueCreate('))).toHaveLength(1);
  expect(fake.calls.filter(c => c.query.includes('commentCreate('))).toHaveLength(1);
  const created = fake.calls.find(c => c.query.includes('issueCreate('))!.variables.input;
  expect(created).toMatchObject({ teamId: 'team-1', labelIds: ['label-1'], priority: 0 });
  expect(created.description).toContain('출처: telegram');
  expect(created.description).toContain('2026-09-28T00:00:00.000Z');
  expect(JSON.stringify(fake.calls.map(c => c.variables))).not.toContain('private-token');
  expect(fake.calls.every(c => c.headers.Authorization === 'private-token')).toBe(true);
});

test('Telegram directive origin is stored per created and repeated issue, never in Linear or as a token', async () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-directive-origin-'));
  const fake = fakeLinear();
  const deps = { root, fetch: fake.fetch, getSecret: async () => 'key', team: 'ELA' };
  try {
    await addDirective('Build this', { source: 'telegram', origin: { chatId: 11, botId: '123', threadId: 3 } }, deps);
    const path = join(root, 'steward', 'origins', 'ELA-1.json');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ channel: 'telegram', chatId: 11, botId: '123', threadId: 3 });
    expect(readFileSync(path, 'utf8')).not.toContain('SECRET');
    await addDirective('Build this', { source: 'telegram', origin: { chatId: 22, botId: '456:SECRET' } }, deps);
    expect(readFileSync(path, 'utf8')).not.toContain('SECRET');
    expect(loadDirectiveOrigins(root, 'ELA-1')).toEqual([
      { channel: 'telegram', chatId: 11, botId: '123', threadId: 3 },
      { channel: 'telegram', chatId: 22 },
    ]);
    await addDirective('Build this', { source: 'telegram', origin: { chatId: 22, botId: '456' } }, deps);
    await addDirective('Build this', { source: 'telegram', origin: { chatId: 11, botId: '123', threadId: 3 } }, deps);
    expect(loadDirectiveOrigins(root, 'ELA-1')).toEqual([
      { channel: 'telegram', chatId: 11, botId: '123', threadId: 3 },
      { channel: 'telegram', chatId: 22 },
      { channel: 'telegram', chatId: 22, botId: '456' },
    ]);
    expect(loadDirectiveOrigin(root, 'ELA-1')).toMatchObject({ chatId: 11, botId: '123' });
    expect(JSON.stringify(fake.calls.map(call => call.variables))).not.toContain('chatId');
    expect(JSON.stringify(fake.calls.map(call => call.variables))).not.toContain('SECRET');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('22 supplied directive summaries each dry-run without network access', async () => {
  const lines = readFileSync('docs/goal-context/steward-directives-2026-09-28.md', 'utf8').split('\n');
  const samples = lines.filter(line => /^\| (?:[1-9]|1[0-9]|2[0-2]) \|/.test(line)).map(line => line.split('|')[2]!.trim());
  expect(samples).toHaveLength(22);
  const results = await Promise.all(samples.map(text => addDirective(text, { dryRun: true }, {
    getSecret: async () => { throw new Error('secret accessed'); },
    fetch: (() => { throw new Error('network'); }) as unknown as typeof fetch,
  })));
  expect(results.every(result => result.status === 'dry-run')).toBe(true);
});

test('open pre-existing issue with the same normalized text gets a repeat comment', async () => {
  const calls: string[] = [];
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    calls.push(query);
    if (query.includes('teams(')) return Response.json({ data: { teams: { nodes: [{ id: 'team-1' }] } } });
    if (query.includes('issues(')) return Response.json({ data: { issues: { nodes: [{ id: 'old', identifier: 'ELA-42', title: 'PTY 우선', description: '', state: { type: 'started' } }], pageInfo: { hasNextPage: false, endCursor: null } } } });
    if (query.includes('commentCreate(')) return Response.json({ data: { commentCreate: { success: true } } });
    throw new Error('unexpected issue creation');
  }) as typeof fetch;
  expect((await addDirective(' PTY   우선 ', {}, { team: 'ELA', fetch: fetchFn, getSecret: async () => 'key' }))).toMatchObject({ status: 'repeated', issue: 'ELA-42' });
  expect(calls.filter(query => query.includes('commentCreate('))).toHaveLength(1);
});

test('missing from-directive label is created before issue creation', async () => {
  let createdLabel = false;
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, any> };
    if (query.includes('teams(')) return Response.json({ data: { teams: { nodes: [{ id: 'team-1' }] } } });
    if (query.includes('issues(')) return Response.json({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
    if (query.includes('issueLabels(')) return Response.json({ data: { issueLabels: { nodes: [] } } });
    if (query.includes('issueLabelCreate(')) { createdLabel = true; expect(variables.input.teamId).toBe('team-1'); return Response.json({ data: { issueLabelCreate: { success: true, issueLabel: { id: 'label-new' } } } }); }
    if (query.includes('issueCreate(')) { expect(variables.input.labelIds).toEqual(['label-new']); return Response.json({ data: { issueCreate: { success: true, issue: { identifier: 'ELA-4' } } } }); }
    throw new Error('unexpected GraphQL operation');
  }) as typeof fetch;
  expect((await addDirective('새 지시', {}, { team: 'ELA', fetch: fetchFn, getSecret: async () => 'key' })).status).toBe('created');
  expect(createdLabel).toBe(true);
});

test('completed issues do not suppress a new directive with the same normalized text', async () => {
  const hash = directiveHash('복구 작업');
  let created = 0;
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    if (query.includes('teams(')) return Response.json({ data: { teams: { nodes: [{ id: 'team-1' }] } } });
    if (query.includes('issues(')) return Response.json({ data: { issues: { nodes: [{ id: 'old', identifier: 'ELA-1', title: '복구 작업', description: `[directive-hash:${hash}]`, state: { type: 'completed' } }], pageInfo: { hasNextPage: false, endCursor: null } } } });
    if (query.includes('issueLabels(')) return Response.json({ data: { issueLabels: { nodes: [{ id: 'label-1', name: 'from-directive' }] } } });
    if (query.includes('issueCreate(')) { created++; return Response.json({ data: { issueCreate: { success: true, issue: { identifier: 'ELA-2' } } } }); }
    throw new Error('comment on closed issue');
  }) as typeof fetch;
  expect((await addDirective('복구 작업', {}, { team: 'ELA', fetch: fetchFn, getSecret: async () => 'key' })).issue).toBe('ELA-2');
  expect(created).toBe(1);
});

test('Linear request failures do not expose credential values', async () => {
  const secret = 'private-token-unique';
  const fetchFn = (async () => Response.json({ errors: [{ message: `bad request ${secret}` }] })) as unknown as typeof fetch;
  let message = '';
  try { await addDirective('check credential', {}, { team: 'ELA', getSecret: async () => secret, fetch: fetchFn }); }
  catch (error) { message = String(error); }
  expect(message).toContain('Linear GraphQL returned errors');
  expect(message).not.toContain(secret);
});

test('dry-run accepts sample without credentials, network or writes', async () => {
  const result = await addDirective('유료는 천천히', { dryRun: true }, { getSecret: async () => { throw new Error('secret accessed'); }, fetch: (() => { throw new Error('network'); }) as unknown as typeof fetch });
  expect(result).toEqual({ status: 'dry-run', hash: directiveHash('유료는 천천히') });
});
