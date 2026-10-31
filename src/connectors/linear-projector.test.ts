import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLedger } from './event-ledger.js';
import { projectLinearTask } from './linear-projector.js';
import type { TaskStatus } from '../task-orchestrator/types.js';
import { createArtifactStore } from '../artifact/store.js';
import { defaultArtifactBaseDir } from '../artifact/paths.js';

const linearTask = (status: TaskStatus, provider: 'linear' | 'asana' = 'linear') => ({
  id: 'task:1234', status, generatedBy: { kind: 'external' as const, provider, ref: 'issue-id' },
  lastExecutionId: 'exec:1234', notes: ['[ACCEPTANCE check failed]'],
});

function fakeLinearApi(states: Array<{ id: string; name: string }>) {
  const calls: Array<{ query: string; variables: Record<string, any> }> = [];
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(init!.body as string);
    calls.push(request);
    if (request.query.includes('ProjectorIssue')) return Response.json({ data: { issue: { team: { states: { nodes: states } } }, viewer: { id: 'api-owner-id' } } });
    if (request.query.includes('ProjectorUpdate')) return Response.json({ data: { issueUpdate: { success: true, issue: { updatedAt: '2026-09-28T12:00:01.000Z' } } } });
    return Response.json({ data: { commentCreate: { success: true, comment: { id: 'comment-id', issue: { updatedAt: '2026-09-28T12:00:02.000Z' } } } } });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const states = [
  { id: 'in-progress-id', name: 'In Progress' }, { id: 'in-review-id', name: 'In Review' },
  { id: 'done-id', name: 'Done' }, { id: 'todo-id', name: 'Todo' },
];

test('Linear-origin running/review/done/failed resolve team states, write comments, and ledger both changes', async () => {
  for (const [status, stateId, comment] of [
    ['running', 'in-progress-id', 'elanous 실행 시작'],
    ['review', 'in-review-id', '사람 확인'],
    ['done', 'done-id', 'elanous 실행 완료'],
    ['failed', 'todo-id', 'elanous 실행 실패'],
  ] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'linear-projector-'));
    try {
      const ledger = new EventLedger(join(dir, 'events.jsonl'));
      const api = fakeLinearApi(states);
      expect(await projectLinearTask({ task: linearTask(status), apiKey: 'key', ledger, fetch: api.fetchFn,
        assigneeId: 'elanous-user-id', execution: { output: 'Run output', error: { code: 'E', message: 'Run failed' } },
      })).toBe(true);
      expect(api.calls.map(call => call.query.includes('ProjectorIssue') ? 'read' : call.query.includes('ProjectorUpdate') ? 'update' : 'comment')).toEqual(['read', 'update', 'comment']);
      expect(api.calls[1]!.variables).toEqual({ id: 'issue-id', input: {
        stateId, ...(status === 'running' ? { assigneeId: 'elanous-user-id' } : {}),
      } });
      expect(api.calls[2]!.variables.input.body).toContain(comment);
      if (status === 'failed') expect(api.calls[2]!.variables.input.body).not.toContain('Run failed');
      if (status === 'done') expect(api.calls[2]!.variables.input.body).not.toContain('Run output');
      expect(ledger.seenChange('linear', 'issue-id', '2026-09-28T12:00:01.000Z')).toBe(true);
      expect(ledger.seenChange('linear', 'issue-id', '2026-09-28T12:00:02.000Z')).toBe(true);
      expect(readFileSync(ledger.path, 'utf8').trim().split('\n')).toHaveLength(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('non-Linear tasks and unsupported statuses make no API writes, even without an API key', async () => {
  const api = fakeLinearApi(states);
  for (const task of [linearTask('running', 'asana'), linearTask('backlog'), linearTask('ready'), linearTask('blocked')]) {
    expect(await projectLinearTask({ task, apiKey: '', fetch: api.fetchFn })).toBe(false);
  }
  expect(api.calls).toHaveLength(0);
});

test('workflow state lookup uses the issue team, not a hard-coded state ID or global state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'linear-projector-'));
  try {
    const api = fakeLinearApi([{ id: 'team-specific-done-id', name: 'done' }]);
    expect(await projectLinearTask({ task: linearTask('done'), apiKey: 'key', fetch: api.fetchFn,
      ledger: new EventLedger(join(dir, 'events.jsonl')) })).toBe(true);
    expect(api.calls[1]?.variables.input.stateId).toBe('team-specific-done-id');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('running resolves the API actor as assignee when none is explicitly supplied', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'linear-projector-'));
  try {
    const api = fakeLinearApi(states);
    expect(await projectLinearTask({ task: linearTask('running'), apiKey: 'key', fetch: api.fetchFn,
      ledger: new EventLedger(join(dir, 'events.jsonl')) })).toBe(true);
    expect(api.calls[1]?.variables.input).toEqual({ stateId: 'in-progress-id', assigneeId: 'api-owner-id' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('missing team state rejects before any outgoing change', async () => {
  const api = fakeLinearApi([{ id: 'other-id', name: 'Other' }]);
  await expect(projectLinearTask({ task: linearTask('review'), apiKey: 'key', fetch: api.fetchFn })).rejects.toThrow('Linear team workflow state not found: In Review');
  expect(api.calls).toHaveLength(1);
});

test('a rejected comment preserves the successful issue update in the ledger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'linear-projector-'));
  try {
    const ledger = new EventLedger(join(dir, 'events.jsonl'));
    const api = fakeLinearApi(states);
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      if ((init?.body as string).includes('ProjectorComment')) return Response.json({ errors: [{ message: 'comment rejected' }] });
      return api.fetchFn(url, init);
    }) as typeof fetch;
    await expect(projectLinearTask({ task: linearTask('done'), apiKey: 'key', ledger, fetch: fetchFn })).rejects.toThrow('Linear GraphQL returned errors');
    expect(ledger.seenChange('linear', 'issue-id', '2026-09-28T12:00:01.000Z')).toBe(true);
    expect(readFileSync(ledger.path, 'utf8').trim().split('\n')).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('GraphQL rejection does not record an outgoing change that did not succeed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'linear-projector-'));
  try {
    const ledger = new EventLedger(join(dir, 'events.jsonl'));
    const api = fakeLinearApi(states);
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      if ((init?.body as string).includes('ProjectorUpdate')) return Response.json({ errors: [{ message: 'invalid state' }] });
      return api.fetchFn(url, init);
    }) as typeof fetch;
    await expect(projectLinearTask({ task: linearTask('done'), apiKey: 'key', ledger, fetch: fetchFn })).rejects.toThrow('Linear GraphQL returned errors');
    expect(ledger.seenChange('linear', 'issue-id', '2026-09-28T12:00:01.000Z')).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('secretary child completion writes progress, derives sibling checkboxes from live UUID states, and does not batch-close parent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'linear-secretary-projector-'));
  try {
  const ledger = new EventLedger(join(dir, 'events.jsonl'));
  const requests: Array<{ query: string; variables: Record<string, any> }> = [];
  const childUpdatedAt = new Date(Date.now() - 1000).toISOString();
  const parentUpdatedAt = new Date(Date.now() - 500).toISOString();
  const statesById: Record<string, string> = { 'child-1': 'started', 'child-2': 'unstarted' };
  const parentDescription = '<!-- elanous-linear-secretary-checklist:start -->\n- [ ] first\n- [ ] second\n<!-- elanous-linear-secretary-checklist:end -->';
  const manifest = '<!-- elanous-linear-secretary-manifest:start -->\n'
    + '{"parentIssueId":"parent-1","tasks":[{"issueId":"child-1","title":"first"},{"issueId":"child-2","title":"second"}]}\n'
    + '<!-- elanous-linear-secretary-manifest:end -->';
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    const req = JSON.parse(init!.body as string) as { query: string; variables: Record<string, any> };
    requests.push(req);
    if (req.query.includes('LinearIssueStatus')) return Response.json({ data: { issue: { state: { type: statesById[req.variables.id] } } } });
    if (req.query.includes('LinearIssueUpdatedAt')) return Response.json({ data: { issue: { updatedAt: req.variables.id === 'child-1' ? childUpdatedAt : parentUpdatedAt } } });
    if (req.query.includes('DecisionIssueStates')) return Response.json({ data: { issue: { team: { states: { nodes: [
      { id: 'started-id', name: 'In Progress', type: 'started' }, { id: 'done-id', name: 'Done', type: 'completed' },
    ] } } } } });
    if (req.query.includes('DecisionIssueClose')) {
      statesById[req.variables.id] = req.variables.input.stateId === 'done-id' ? 'completed' : 'started';
      return Response.json({ data: { issueUpdate: { success: true } } });
    }
    if (req.query.includes('DecisionComment')) return Response.json({ data: { commentCreate: { success: true, comment: { id: 'comment-1' } } } });
    if (req.query.includes('LinearIssueDescription($id')) return Response.json({ data: { issue: { description: parentDescription } } });
    return Response.json({ data: { issueUpdate: { success: true } } });
  }) as typeof fetch;
  expect(await projectLinearTask({ task: { ...linearTask('done'), title: 'first', generatedBy: { kind: 'external', provider: 'linear', ref: 'child-1' }, description: `${manifest}\nwork description` },
    apiKey: 'key', ledger, fetch: fetchFn, execution: { output: 'checklist item complete' } })).toBe(true);
  expect(requests.some(request => request.query.includes('ProjectorIssue'))).toBe(false);
  const comment = requests.find(request => request.query.includes('DecisionComment'))!.variables.input.body;
  expect(comment).toContain('요약: 하위 작업을 완료했습니다.');
  expect(comment).not.toContain('checklist item complete');
  const parentUpdate = requests.find(request => request.query.includes('LinearIssueDescriptionUpdate'))!.variables.input.description as string;
  expect(parentUpdate).toContain('- [x] first');
  expect(parentUpdate).toContain('- [ ] second');
  expect(requests.map(request => request.query.match(/(?:query|mutation) (\w+)/)?.[1])).toEqual([
    'LinearIssueStatus', 'DecisionIssueStates', 'DecisionIssueClose', 'DecisionComment', 'LinearIssueDescription',
    'LinearIssueStatus', 'LinearIssueStatus', 'LinearIssueDescriptionUpdate', 'LinearIssueUpdatedAt', 'LinearIssueUpdatedAt',
  ]);
  expect(ledger.seenOutgoingChange('linear', 'child-1', childUpdatedAt)).toBe(true);
  expect(ledger.seenOutgoingChange('linear', 'parent-1', parentUpdatedAt)).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('TOX projector uploads and attaches only the real approved capture for the same run and secretary parent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'linear-projector-capture-'));
  const priorStateDir = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = dir;
  const store = createArtifactStore({ baseDir: defaultArtifactBaseDir() });
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2]);
  const artifact = store.put('capture', bytes, { origin: 'browser-runtime', producer: 'browser-runtime', extra: {
    runId: 'run-capture-1', linearIssueId: 'parent-1', externalShare: true,
    sharePolicy: 'linear-approved', sensitivity: 'public',
  } });
  const captureArtifacts = [{ path: artifact.path, mimeType: 'image/png', runId: 'run-capture-1', linearIssueId: 'parent-1',
    externalShare: true, sensitivity: 'public', createdAt: artifact.meta.createdAt }];
  const manifest = '<!-- elanous-linear-secretary-manifest:start -->\n'
    + '{"parentIssueId":"parent-1","tasks":[{"issueId":"child-1","title":"first"}]}\n'
    + '<!-- elanous-linear-secretary-manifest:end -->';
  const calls: Array<{ query?: string; variables?: Record<string, any>; method?: string; body?: unknown }> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === 'https://upload.linear.test/signed' && init?.method === 'PUT') {
      calls.push({ method: init.method, body: init.body });
      return new Response(null, { status: 200 });
    }
    const request = JSON.parse(init!.body as string) as { query: string; variables: Record<string, any> };
    calls.push(request);
    if (request.query.includes('LinearIssueStatus')) return Response.json({ data: { issue: { state: { type: 'started' } } } });
    if (request.query.includes('LinearFileUpload')) return Response.json({ data: { fileUpload: { success: true, uploadFile: {
      uploadUrl: 'https://upload.linear.test/signed', assetUrl: 'https://asset.linear.app/run-capture.png', headers: [{ key: 'x-signed', value: 'yes' }],
    } } } });
    if (request.query.includes('LinearAttachmentCreate')) return Response.json({ data: { attachmentCreate: { success: true, attachment: { id: 'capture-attachment' } } } });
    if (request.query.includes('LinearIssueUpdatedAt')) return Response.json({ data: { issue: { updatedAt: new Date().toISOString() } } });
    if (request.query.includes('DecisionIssueStates')) return Response.json({ data: { issue: { team: { states: { nodes: [
      { id: 'started-id', name: 'In Progress', type: 'started' }, { id: 'done-id', name: 'Done', type: 'completed' },
    ] } } } } });
    if (request.query.includes('DecisionComment')) return Response.json({ data: { commentCreate: { success: true, comment: { id: 'comment-1' } } } });
    if (request.query.includes('LinearIssueDescription($id')) return Response.json({ data: { issue: { description: '<!-- elanous-linear-secretary-checklist:start -->\n- [ ] first\n<!-- elanous-linear-secretary-checklist:end -->' } } });
    return Response.json({ data: { issueUpdate: { success: true } } });
  }) as typeof fetch;
  try {
    expect(await projectLinearTask({ task: { ...linearTask('done'), title: 'first', generatedBy: { kind: 'external', provider: 'linear', ref: 'child-1' }, description: manifest }, apiKey: 'key', fetch: fetchFn,
      execution: { runId: 'run-capture-1', captureArtifacts, output: 'finished demo' } })).toBe(true);
    expect(calls.some(call => call.method === 'PUT' && Buffer.from(call.body as Uint8Array).equals(bytes))).toBe(true);
    const comment = calls.find(call => call.query?.includes('DecisionComment'))!.variables!.input.body as string;
    expect(comment).toContain('https://asset.linear.app/run-capture.png');
    expect(calls.some(call => call.query?.includes('LinearAttachmentCreate'))).toBe(true);
  } finally {
    store._resetForTest();
    if (priorStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = priorStateDir;
    rmSync(dir, { recursive: true, force: true });
  }
});
