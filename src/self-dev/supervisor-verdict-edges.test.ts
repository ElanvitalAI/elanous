import { test, expect, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { loadSelfDevRun, saveSelfDevRun } from './run-store.js';
import { decideNextRun, superviseRun, SUPERVISOR_STOP_REASONS, type SupervisorStopReason } from './run-supervisor.js';
import { SUPERVISOR_VERDICT_EDGES, routeSupervisorVerdict } from './supervisor-verdict-edges.js';
import type { SelfDevJobResult } from './orchestrate.js';

test('verdict edges cover the complete runtime stop vocabulary without extras', () => {
  const expected = [
    'converged', 'human-stopped', 'parent-signals-red', 'needs-human', 'no-actionable-work',
    'harvestable-awaiting-human', 'handed-off-to-salvage', 'max-rounds', 'no-progress',
    'provider-exhausted', 'step-timeout', 'decomposable-no-progress', 'review-unobserved',
    'deliverable-unobserved', 'deliverable-merged',
  ] as const satisfies readonly SupervisorStopReason[];
  expect([...SUPERVISOR_STOP_REASONS].sort()).toEqual([...expected].sort());
  expect(Object.keys(SUPERVISOR_VERDICT_EDGES).sort()).toEqual([...SUPERVISOR_STOP_REASONS].sort());
  for (const reason of SUPERVISOR_STOP_REASONS) {
    expect(routeSupervisorVerdict(reason).meaning.length).toBeGreaterThan(0);
    expect(routeSupervisorVerdict(reason).next).not.toBe('proposal');
  }
});

test('needs-human routes actionable open PRs to harvest but real gates to human-gate', () => {
  const open: Pick<SelfDevJobResult, 'status' | 'stage' | 'merged' | 'prNumber' | 'mergeReason'> = {
    status: 'done', stage: 'pr-opened', merged: false, prNumber: 24168, mergeReason: 'merge-pending',
  };
  expect(routeSupervisorVerdict('needs-human', [open]).next).toBe('harvest');
  expect(routeSupervisorVerdict('needs-human', [{ ...open, mergeReason: undefined }]).next).toBe('harvest');
  expect(routeSupervisorVerdict('needs-human', []).next).toBe('human-gate');
  expect(routeSupervisorVerdict('needs-human', [{ ...open, blockReason: 'parent-unlanded' }]).next).toBe('human-gate');
  for (const mergeReason of ['decision-signal-red', 'signal-incomplete', 'parent-unlanded', 'human-gate']) {
    expect(routeSupervisorVerdict('needs-human', [{ ...open, mergeReason }]).next).toBe('human-gate');
  }
  expect(routeSupervisorVerdict('needs-human', [{ ...open, merged: true }]).next).toBe('human-gate');
  // Mixed run: one actionable open PR, another goal's result at a human gate → the run stays at the human gate.
  const other = { status: 'blocked' as const, stage: 'gate', mergeReason: 'human-gate' };
  expect(routeSupervisorVerdict('needs-human', [open, other]).next).toBe('human-gate');
  expect(routeSupervisorVerdict('needs-human', [open, { ...other, mergeReason: 'decision-signal-red' }]).next).toBe('human-gate');
  const blocked = { taskId: 'parent', feature: 'parent', status: 'blocked' as const, blockReason: 'parent-unlanded' as const };
  const decision = decideNextRun({ results: [blocked] });
  expect(decision.stopReason).toBe('needs-human');
  expect(routeSupervisorVerdict(decision.stopReason!, [blocked]).next).toBe('human-gate');
});

test('unknown strings propose; existing human-gate values remain visible', () => {
  expect(routeSupervisorVerdict('new-stop').next).toBe('proposal');
  for (const reason of ['max-rounds', 'provider-exhausted', 'step-timeout'] as const) {
    expect(routeSupervisorVerdict(reason).next).toBe('human-gate');
  }
});

test('stalled superviseRun records scope-decompose in log, checkpoint and returned results', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'verdict-edge-'));
  const runId = 'verdict-stall';
  const failed = { taskId: 'stuck', feature: 'stuck', status: 'failed' as const, stage: 'error', runId,
    error: { code: 'SELF_IMPL_FAILED', message: "error: cannot lock ref 'refs/remotes/origin/main': is at abc123" } };
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    saveSelfDevRun({ runId, createdAt: 1, updatedAt: 1, results: [failed] }, dir);
    let reruns = 0;
    const out = await superviseRun({
      initial: [failed], runStore: { runId, operatorDir: dir }, limits: { maxRounds: 9, stallRounds: 1 },
      sweepPendingMerges: async () => ({ pending: 0, merged: 0 }),
      rerun: async (previous) => { reruns++; return previous; },
    });
    expect(reruns).toBe(1);
    expect(out[0]?.next).toBe('scope-decompose');
    expect(loadSelfDevRun(runId, dir)).toMatchObject({ supervisorStopReason: 'no-progress', next: 'scope-decompose' });
    expect(log).toHaveBeenCalledWith('self-dev.supervisor', 'verdict-edge', {
      runId, reason: 'no-progress', next: 'scope-decompose',
    });
  } finally {
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});
