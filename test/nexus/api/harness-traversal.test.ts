import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRunTraversal, displayTitle, handleHarnessRunTraversalGet } from '../../../src/nexus/api/harness-traversal.js';
import type { RunLedgerEntry } from '../../../src/self-implement/run-ledger.js';

// Real ledger of run-c0a47484 (10-08 07:17–07:49 KST · PR #24937), reduced to the events the traversal reads.
const fixture: RunLedgerEntry[] = readFileSync(join(import.meta.dir, '../../fixtures/harness-traversal/run-c0a47484-rework-twice.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((line) => JSON.parse(line) as RunLedgerEntry);
const RUN = 'run-c0a47484-84ec-4737-9754-e68f8a7f266e';

describe('buildRunTraversal — real finished run', () => {
  const wire = buildRunTraversal(RUN, fixture);

  test('orders the node visits the run actually took, with revisit counts', () => {
    expect(wire.steps.map((step) => `${step.node}×${step.visit}`)).toEqual([
      'implement×1', 'gate×1', 'review×1', 'rework×1', 'implement×2', 'gate×2', 'review×2', 'main-sync×1', 'regate×1', 'open-pr×1',
    ]);
    expect(wire.graphId).toBe('self-implement');
    expect(wire.status).toBe('completed');
    expect(wire.prNumber).toBe(24937);
  });

  test('outcomes: first review fails (→ rework), second converges by refutation, PR opens', () => {
    const [, , review1, , , , review2, , , openPr] = wire.steps;
    expect(review1!.outcome).toBe('fail');
    expect(review1!.detail).toContain('꼭 고칠 것 3');
    expect(review2!.outcome).toBe('pass');
    expect(review2!.detail).toContain('반박 수렴');
    expect(openPr!.outcome).toBe('pass');
    expect(openPr!.detail).toContain('#24937');
    // merge-decision is written in the regate window, just before open-pr is entered — it still shows.
    expect(openPr!.detail).toContain('병합 결정 auto');
  });

  test('durations come from the gap to the next entry, the last from the terminal status', () => {
    expect(wire.steps[0]!.durationMs).toBe(Date.parse(wire.steps[1]!.at) - Date.parse(wire.steps[0]!.at));
    expect(wire.steps.at(-1)!.durationMs).not.toBeNull();
    expect(wire.steps.every((step) => step.durationMs === null || step.durationMs >= 0)).toBe(true);
  });

  test('title is the first goal line only, with paths shrunk to basenames', () => {
    expect(wire.title).toBe('대상 경로: ReleaseStrip.tsx — 릴리스 줄 런 표시');
    expect(wire.title).not.toContain('/');
    expect(displayTitle('a ~/.elanous/x/y.json · ../b/c.ts\nbody')).toBe('a y.json · c.ts');
    expect(displayTitle('대상 경로: src/a.ts · src/b [truncated; originalChars=7722]')).toBe('대상 경로: a.ts · b');
  });
});

describe('buildRunTraversal — live run', () => {
  test('without a terminal status the last node is running', () => {
    const cut = fixture.filter((entry) => Date.parse(entry.timestamp!) <= Date.parse('2026-10-07T22:30:00Z'));
    const wire = buildRunTraversal(RUN, cut);
    expect(wire.status).toBe('running');
    expect(wire.steps.at(-1)).toMatchObject({ node: 'implement', visit: 2, outcome: null, durationMs: null });
  });

  test('a failed terminal turns the last node red', () => {
    const cut = fixture.filter((entry) => Date.parse(entry.timestamp!) <= Date.parse('2026-10-07T22:28:00Z'));
    const wire = buildRunTraversal(RUN, [...cut, { timestamp: '2026-10-07T22:29:00.000Z', runId: RUN, event: 'run-status', data: { runStatus: 'abandoned', stage: 'review' } }]);
    expect(wire.steps.at(-1)).toMatchObject({ node: 'review', outcome: 'fail' });
  });
});

describe('buildRunTraversal — declared journey nodes', () => {
  test('any node the runtime enters becomes a step; a generic pipeline-node-exit decides its outcome', () => {
    const at = (s: number) => new Date(Date.UTC(2026, 9, 8, 3, 0, s)).toISOString();
    const wire = buildRunTraversal('run-x', [
      { timestamp: at(0), runId: 'run-x', event: 'pipeline-node-entry', data: { graphId: 'self-implement', node: 'dispatch', round: 0 } },
      { timestamp: at(5), runId: 'run-x', event: 'pipeline-node-exit', data: { node: 'dispatch', outcome: 'fail', detail: '이미지 동기화 실패' } },
      { timestamp: at(6), runId: 'run-x', event: 'pipeline-node-entry', data: { graphId: 'self-implement', node: 'heal', round: 0 } },
    ]);
    expect(wire.steps.map((step) => [step.node, step.outcome])).toEqual([['dispatch', 'fail'], ['heal', null]]);
    expect(wire.steps[0]!.detail).toBe('이미지 동기화 실패');
    const multi = buildRunTraversal('run-y', [
      { timestamp: at(0), runId: 'run-y', event: 'pipeline-node-entry', data: { node: 'dispatch' } },
      { timestamp: at(1), runId: 'run-y', event: 'pipeline-node-exit', data: { node: 'dispatch', outcome: 'pass', detail: '줄\n바꿈' } },
    ]);
    expect(multi.steps[0]!.detail).toBe('줄 바꿈');
  });
});

describe('handleHarnessRunTraversalGet', () => {
  const get = (query: string, loadLedger: (id: string) => RunLedgerEntry[] | null) =>
    handleHarnessRunTraversalGet(new Request(`http://x/v1/harness/run-traversal${query}`), { loadLedger });

  test('400 without a runId or with a path-like runId', async () => {
    expect(get('', () => fixture).status).toBe(400);
    expect(get('?runId=../etc', () => fixture).status).toBe(400);
  });

  test('404 when no ledger exists', () => {
    expect(get('?runId=run-missing', () => null).status).toBe(404);
  });

  test('200 with the traversal', async () => {
    const response = get(`?runId=${RUN}`, () => fixture);
    expect(response.status).toBe(200);
    const body = await response.json() as { steps: unknown[]; runId: string };
    expect(body.runId).toBe(RUN);
    expect(body.steps).toHaveLength(10);
  });

  test('422 when the ledger is unreadable', () => {
    expect(get(`?runId=${RUN}`, () => { throw new Error('bad'); }).status).toBe(422);
  });
});
