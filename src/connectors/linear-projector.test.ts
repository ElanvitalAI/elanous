import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLedger } from './event-ledger.js';
import { projectLinearTask } from './linear-projector.js';
import type { TaskStatus } from '../task-orchestrator/types.js';

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
      if (status === 'failed') expect(api.calls[2]!.variables.input.body).toContain('Run failed');
      expect(ledger.seenChange('linear', 'issue-id', '2026-09-28T12:00:01.000Z')).toBe(true);
      expect(ledger.seenChange('linear', 'issue-id', '2026-09-28T12:00:02.000Z')).toBe(true);
      expect(readFileSync(ledger.path, 'utf8').trim().split('\n')).toHaveLength(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('non-Linear tasks and statuses outside the four projection states make no API or ledger writes', async () => {
  const api = fakeLinearApi(states);
  for (const task of [linearTask('running', 'asana'), linearTask('backlog'), linearTask('ready'), linearTask('blocked')]) {
    expect(await projectLinearTask({ task, apiKey: 'key', fetch: api.fetchFn })).toBe(false);
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
