import { expect, test } from 'bun:test';
import { savedAppBuildApprovalResumeInput, savedAppBuildApprovalStartInput } from './cli-publish-approval-resume.js';
import type { GraphRunState } from '../runner.js';
import { createHash } from 'node:crypto';

const graphFile = '/tmp/elanous/plugins/elanous-app-build/graph/app-build.yaml';
const input = { appSlug: 'owner-slot', context: { memberId: 'owner-a' } };
const pendingExpiresAt = '2026-11-16T09:00:00.000Z';
const snapshot = 'graph: { id: app-build }\nnodes:\n  - { id: publish-approval, type: capability, requires: app-build.publish-approval@1 }\n';
const state = (changes: Partial<GraphRunState> = {}): GraphRunState => ({
  graphId: 'app-build', runId: 'run-a', graphPath: graphFile, status: 'failed',
  statePath: '/tmp/elanous/graph-runs/app-build/run-a.json',
  path: ['source-reserve', 'review-publish', 'publish-approval', 'failed'], input,
  graphSnapshot: { graphSha: createHash('sha256').update(snapshot).digest('hex'), recipesSha: 'b'.repeat(64) },
  nodes: [{ nodeId: 'publish-approval', executionId: 'visit-a', ok: false, exit: 1, executed: true,
    error: `APP_BUILD_APPROVAL_PRESENTATION_RETRYABLE:${pendingExpiresAt}` }],
  executed: 0, dryRun: false, ...changes,
} as GraphRunState);

test('same failed app-build run keeps its saved owner and slug; foreign graph or changed status cannot resume', () => {
  const at = Date.parse('2026-11-16T08:59:00.000Z');
  const check = (changes: Partial<GraphRunState> = {}) => savedAppBuildApprovalResumeInput(state(changes), graphFile,
    at, () => snapshot);
  expect(check())
    .toEqual({ input, pendingExpiresAt, executionId: 'visit-a' });
  expect(() => check({ graphPath: '/tmp/foreign.yaml' })).toThrow();
  expect(() => check({ status: 'done' })).toThrow();
  expect(() => check({ input: { appSlug: 'model-slot' } })).toThrow();
  expect(() => check({ path: ['source-reserve', 'failed'] })).toThrow();
  expect(() => check({ path: ['publish-approval', 'publish-approval', 'failed'] })).toThrow();
  expect(() => check({ graphSnapshot: undefined })).toThrow();
  expect(() => check({ nodes: [] })).toThrow();
  expect(() => check({ nodes: [{ nodeId: 'publish-approval', executionId: 'visit-a', ok: true }] as GraphRunState['nodes'] })).toThrow();
  expect(() => check({ nodes: [{ nodeId: 'publish-approval', executionId: 'visit-a', ok: false, exit: 1, executed: true,
    error: 'owner approval unavailable or refused' }] })).toThrow();
  expect(() => check({ nodes: [{ nodeId: 'publish', ok: true, executed: true, exit: 0 }, ...state().nodes] })).toThrow();
  expect(() => savedAppBuildApprovalResumeInput(state(), graphFile, Date.parse(pendingExpiresAt), () => snapshot)).toThrow();
  expect(() => savedAppBuildApprovalResumeInput(state(), graphFile, at, () => { throw new Error('missing snapshot'); })).toThrow();
  expect(() => savedAppBuildApprovalResumeInput(state(), graphFile, at, () => snapshot + '\n')).toThrow();
  const otherNode = state({ path: ['source-reserve', 'verify-repair', 'failed'], nodes: [{
    nodeId: 'verify-repair', executionId: 'visit-a', ok: false, exit: 1, executed: true,
    error: `APP_BUILD_APPROVAL_PRESENTATION_RETRYABLE:${pendingExpiresAt}` }] });
  expect(() => savedAppBuildApprovalResumeInput(otherNode, graphFile, at, () => snapshot)).toThrow();
  const duplicated = snapshot + '  - { id: another-approval, type: capability, requires: app-build.publish-approval@1 }\n';
  expect(() => savedAppBuildApprovalResumeInput(state({ graphSnapshot: {
    graphSha: createHash('sha256').update(duplicated).digest('hex'), recipesSha: 'b'.repeat(64) } }),
  graphFile, at, () => duplicated)).toThrow();
});

test('formal start accepts only the saved approved review visit', () => {
  const inputSha256 = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const decidedAt = '2026-11-16T08:01:00.000Z';
  const readDecision = () => JSON.stringify({ nodeId: 'review-publish', decision: 'approved',
    inputSha256, decidedAt });
  const approved = state({ status: 'awaiting-approval', path: ['source-reserve', 'review-publish'],
    nodes: [], pending: { nodeId: 'review-publish', message: 'approve', since: '2026-11-16T08:00:00.000Z',
      decision: 'approved', decidedAt, inputSha256 } });
  expect(savedAppBuildApprovalStartInput(approved, graphFile, readDecision)).toBe(input);
  expect(() => savedAppBuildApprovalStartInput(state({ ...approved, pending: undefined }), graphFile, readDecision)).toThrow();
  expect(() => savedAppBuildApprovalStartInput(state({ ...approved, pending: {
    ...approved.pending!, decision: 'rejected' } }), graphFile, readDecision)).toThrow();
  expect(() => savedAppBuildApprovalStartInput(state({ ...approved, path: ['review-publish', 'review-publish'] }), graphFile, readDecision)).toThrow();
  expect(() => savedAppBuildApprovalStartInput(state({ ...approved, nodes: [{ nodeId: 'publish', ok: true,
    executed: true, exit: 0 }] }), graphFile, readDecision)).toThrow();
  expect(() => savedAppBuildApprovalStartInput(approved, graphFile, () => JSON.stringify({
    nodeId: 'review-publish', decision: 'approved', inputSha256: '0'.repeat(64), decidedAt }))).toThrow();
});
