import { expect, test } from 'bun:test';
import type { GraphApproval } from '../../lib/graph-approvals-api';
import { createLatestRequestGate, graphApprovalCard } from './graph-approval-card';

const item: GraphApproval = {
  graphId: 'release-loop', runId: 'one', nodeId: 'approve-publish', message: 'Publish release?',
  since: '2026-09-29T00:00:00Z', path: ['prepare', 'approve-publish'],
  recent: [{ nodeId: 'prepare', ok: true, outcome: 'ready', summary: 'Checked' }, { nodeId: 'verify', ok: false }],
};

test('human title, paused step, elapsed time, message and recent outcomes', () => {
  expect(graphApprovalCard(item, Date.parse(item.since) + 65 * 60_000)).toEqual({
    title: '릴리스 발행', nodeId: 'approve-publish', waiting: '1시간 전', message: 'Publish release?',
    recent: ['✓ prepare · ready · Checked', '✗ verify'],
  });
  expect(graphApprovalCard({ ...item, graphId: 'announce-loop' }).title).toBe('공지');
  expect(graphApprovalCard({ ...item, graphId: 'custom-loop' }).title).toBe('custom-loop');
  expect(graphApprovalCard(item, Date.parse(item.since)).waiting).toBe('방금 전');
});

test('latest-request gate: a list started before the decision refresh is ignored', () => {
  const gate = createLatestRequestGate();
  const beforeDecision = gate.begin();
  gate.begin(); // decision invalidates in-flight lists
  const afterDecision = gate.begin();
  expect(gate.isLatest(afterDecision)).toBe(true);
  expect(gate.isLatest(beforeDecision)).toBe(false);
});

test('a step that exited 0 but reported outcome fail is marked as not passed', () => {
  const card = graphApprovalCard({
    graphId: 'release-loop', runId: 'r', nodeId: 'approve-publish', message: 'm', since: '2026-09-29T00:00:00Z', path: [],
    recent: [{ nodeId: 'notes-check', ok: true, outcome: 'ok' }, { nodeId: 'auto-approve', ok: true, outcome: 'fail' }, { nodeId: 'x', ok: false }],
  });
  expect(card.recent).toEqual(['✓ notes-check · ok', '✗ auto-approve · fail', '✗ x']);
});
