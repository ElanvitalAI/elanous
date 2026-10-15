import { expect, test } from 'bun:test';
import { handleProjectAutopsy, type ProjectAutopsyDeps } from './project-autopsy.js';

const PROJECT_1 = '11111111-1111-4111-8111-111111111111';
const PROJECT_2 = '22222222-2222-4222-8222-222222222222';
const project = { id: PROJECT_1, name: 'Example', createdAt: '2026-10-14T00:00:00Z' };
const request = () => new Request(`http://nexus.test/v1/projects/${PROJECT_1}/autopsy`);

test('project autopsy uses explicit project IDs and excludes matching text from other projects', async () => {
  const deps: ProjectAutopsyDeps = {
    getProject: () => project,
    readRuns: () => [
      { runId: 'run-a', projectId: PROJECT_1, status: 'failed', startedAt: '2026-10-14T00:00:00Z', version: null,
        path: ['Example'], nodes: [
          { nodeId: 'gate', ok: false, summary: 'merge conflict in Example', facts: { verdict: 'fail' } },
          { nodeId: 'review', ok: true, summary: 'passed' },
        ] },
      { runId: 'run-b', projectId: PROJECT_2, status: 'failed', startedAt: '2026-10-14T00:00:00Z', version: null,
        path: ['Example'], nodes: [{ nodeId: 'gate', ok: false, summary: 'merge conflict in Example' }] },
      { runId: 'run-c', status: 'failed', startedAt: '2026-10-14T00:00:00Z', version: null,
        path: ['Example'], nodes: [{ nodeId: 'gate', ok: false, summary: 'merge conflict in Example' }] },
    ],
    listApprovals: () => [
      { runId: 'run-a', projectId: PROJECT_1, message: 'Example needs approval', requestedAt: 1 },
      { runId: 'run-b', projectId: PROJECT_2, message: 'Example needs approval', requestedAt: 2 },
      { runId: 'run-c', message: 'Example needs approval', requestedAt: 3 },
    ],
  };
  const response = handleProjectAutopsy(request(), PROJECT_1, deps);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    project: { id: PROJECT_1, name: 'Example' },
    attribution: { status: 'partial', reason: 'ledger-project-id-missing' },
    failures: [{ runId: 'run-a', nodeId: 'gate', kind: 'conflict', verdict: 'fail' }],
    causes: [{ kind: 'conflict', count: 1, runs: ['run-a'] }],
    proposals: [{ runId: 'run-a' }],
    pendingApprovals: 1,
  });
});

test('project autopsy labels unassigned ledgers unavailable instead of guessing from text', async () => {
  const response = handleProjectAutopsy(request(), PROJECT_1, {
    getProject: () => project,
    readRuns: () => [{ runId: 'run-a', status: 'failed', startedAt: '2026-10-14T00:00:00Z', version: null,
      path: ['Example'], nodes: [{ nodeId: 'gate', ok: false, summary: 'Example failed' }] }],
    listApprovals: () => [{ runId: 'run-a', message: 'Example needs approval', requestedAt: 1 }],
  });
  expect(await response.json()).toMatchObject({
    attribution: { status: 'unavailable', reason: 'ledger-project-id-missing' },
    failures: [], causes: [], proposals: [], pendingApprovals: 0,
  });
});

test('an approval ID alone cannot establish ownership when run rows are unassigned', async () => {
  const response = handleProjectAutopsy(request(), PROJECT_1, {
    getProject: () => project,
    readRuns: () => [{ runId: 'run-a', status: 'failed', startedAt: '2026-10-14T00:00:00Z', version: null,
      path: ['Example'], nodes: [{ nodeId: 'gate', ok: false, summary: 'Example failed' }] }],
    listApprovals: () => [{ runId: 'run-a', projectId: PROJECT_1, message: 'Example approval', requestedAt: 1 }],
  });
  expect(await response.json()).toMatchObject({
    attribution: { status: 'unavailable', reason: 'ledger-project-id-missing' },
    failures: [], causes: [], proposals: [], pendingApprovals: 0,
  });
});

test('autopsy marks bounded lists and states that cause counts cover returned failures', async () => {
  const response = handleProjectAutopsy(request(), PROJECT_1, {
    getProject: () => project,
    readRuns: () => [{ runId: 'run-a', projectId: PROJECT_1, status: 'failed',
      startedAt: '2026-10-14T00:00:00Z', version: null, path: [],
      nodes: Array.from({ length: 51 }, (_, index) => ({
        nodeId: `gate-${index}`, ok: false, summary: 'merge conflict',
      })) }],
    listApprovals: () => Array.from({ length: 21 }, (_, index) => ({
      runId: `approval-${index}`, projectId: PROJECT_1, message: 'approve', requestedAt: index,
    })),
  });
  const body = await response.json() as {
    failures: unknown[]; causes: Array<{ count: number }>;
    proposals: unknown[]; pendingApprovals: number;
    coverage: { failuresTruncated: boolean; proposalsTruncated: boolean; causeCounts: string };
  };
  expect(body.failures).toHaveLength(50);
  expect(body.causes[0]?.count).toBe(50);
  expect(body.proposals).toHaveLength(20);
  expect(body.pendingApprovals).toBe(21);
  expect(body.coverage).toEqual({ failuresTruncated: true, proposalsTruncated: true,
    causeCounts: 'returned-failures' });
});

test('project autopsy keeps unreadable runs and malformed IDs distinct', async () => {
  expect(handleProjectAutopsy(request(), '%', { getProject: () => project }).status).toBe(400);
  const unavailable = handleProjectAutopsy(request(), PROJECT_1, {
    getProject: () => project, readRuns: () => 'unavailable', listApprovals: () => [],
  });
  expect(unavailable.status).toBe(500);
  expect(await unavailable.json()).toEqual({ error: 'runs-unavailable' });
});
