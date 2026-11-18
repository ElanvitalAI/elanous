import { describe, expect, test } from 'bun:test';
import { capsuleDoneFromGraphRun, capsuleDoneFromHarnessNotification } from './capsule-sources.js';

const NOTE = { taskId: 'h-1', agentName: 'harness-codex', label: 'fix lint', state: 'done' as const, durationMs: 90_000, finishedAt: 100_000 };

describe('B4 — harness child and graph run → capsule-done', () => {
  test('harness notification: done/error/aborted → ok/failed/cancelled · times from duration · label first', () => {
    expect(capsuleDoneFromHarnessNotification(NOTE, 's-1')).toEqual({
      type: 'capsule-done', capsuleId: 'h-1', kind: 'harness', sessionId: 's-1',
      startedAt: 10_000, endedAt: 100_000, status: 'ok', summary: 'fix lint · ok · 90s',
    });
    expect(capsuleDoneFromHarnessNotification({ ...NOTE, state: 'error' }, 's-1')?.status).toBe('failed');
    expect(capsuleDoneFromHarnessNotification({ ...NOTE, state: 'aborted', label: undefined }, 's-1')?.summary)
      .toBe('harness-codex · cancelled · 90s');
  });

  test('a running progress notice (#38537 line-watch) is not a completion → null · no fake capsule-done', () => {
    expect(capsuleDoneFromHarnessNotification({ ...NOTE, state: 'running' }, 's-1')).toBeNull();
  });

  test('harness supplement never reopens a turn → null', () => {
    expect(capsuleDoneFromHarnessNotification({ ...NOTE, completionDelivery: 'supplement' }, 's-1')).toBeNull();
  });

  test('graph run: done/failed → ok/failed · approval wait and dry run → null', () => {
    const wake = { graphId: 'g', runId: 'r-9', status: 'done' as const, dryRun: false };
    expect(capsuleDoneFromGraphRun(wake, 's-1', 5_000, 65_000)).toEqual({
      type: 'capsule-done', capsuleId: 'graph:g/r-9', kind: 'graph', sessionId: 's-1',
      startedAt: 5_000, endedAt: 65_000, status: 'ok', summary: 'g/r-9 · ok',
    });
    expect(capsuleDoneFromGraphRun({ ...wake, status: 'failed' }, 's-1', 0, 1)?.status).toBe('failed');
    expect(capsuleDoneFromGraphRun({ ...wake, status: 'awaiting-approval', nodeId: 'n' }, 's-1', 0, 1)).toBeNull();
    expect(capsuleDoneFromGraphRun({ ...wake, dryRun: true }, 's-1', 0, 1)).toBeNull();
  });
});
