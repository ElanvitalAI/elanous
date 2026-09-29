import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { defaultSeams, REVIEW_SCOPE_UNMEASURABLE } from './seams.js';
import { resetLiveDetailCacheForTesting, writeLiveDetail } from '../live/detail-switch.js';

describe('defaultSeams decision observations', () => {
  const previousStateDir = process.env.ELANOUS_STATE_DIR;
  const stateRoot = mkdtempSync(join(tmpdir(), 'seams-decision-state-'));
  beforeAll(() => {
    process.env.ELANOUS_STATE_DIR = stateRoot;
    writeLiveDetail({ scope: 'all', ttlMin: 30 });
    resetLiveDetailCacheForTesting();
  });
  afterAll(() => {
    if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previousStateDir;
    resetLiveDetailCacheForTesting();
    rmSync(stateRoot, { recursive: true, force: true });
  });

  test('gate scope decision follows its existing log without changing the gate result', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'seams-decision-gate-'));
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => { events.push({ category, event, data: data ?? {} }); }) as never);
    try {
      for (const args of [['init', '-b', 'main'], ['config', 'user.email', 'test@example.com'], ['config', 'user.name', 'Test']]) {
        expect(spawnSync('git', args, { cwd: repo }).status).toBe(0);
      }
      writeFileSync(join(repo, 'README.md'), 'base\n');
      expect(spawnSync('git', ['add', 'README.md'], { cwd: repo }).status).toBe(0);
      expect(spawnSync('git', ['commit', '-m', 'base'], { cwd: repo }).status).toBe(0);
      const result = await defaultSeams({ runIntegrityGate: () => ({ passed: true, steps: [], log: 'gate ok' }) }).gate(repo, { runId: 'run-gate-decision' });
      expect(result.passed).toBe(true);
      expect(result.log).toContain('gate ok');
      const index = events.findIndex(({ event }) => event === 'gate.scope');
      expect(index).toBeGreaterThanOrEqual(0);
      expect(events[index + 1]).toMatchObject({ category: 'harness.decision', event: 'decision', data: { kind: 'VERIFY', runId: 'run-gate-decision', reason: 'no-changes', target: '시험 생략 · 나머지 게이트' } });
    } finally {
      log.mockRestore();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('gate emission failure preserves the gate verdict and original gate.scope log', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'seams-decision-gate-fail-soft-'));
    const events: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string) => {
      events.push(`${category}:${event}`);
      if (category === 'harness.decision') throw new Error('decision sink unavailable');
    }) as never);
    try {
      expect(spawnSync('git', ['init', '-b', 'main'], { cwd: repo }).status).toBe(0);
      writeFileSync(join(repo, 'README.md'), 'base\n');
      expect(spawnSync('git', ['add', 'README.md'], { cwd: repo }).status).toBe(0);
      expect(spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'base'], { cwd: repo }).status).toBe(0);
      resetLiveDetailCacheForTesting();
      const result = await defaultSeams({ runIntegrityGate: () => ({ passed: true, steps: [], log: 'gate ok' }) }).gate(repo, { runId: 'run-gate-fail-soft' });
      expect(result.passed).toBe(true);
      expect(result.log).toContain('gate ok');
      const index = events.indexOf('self-implement:gate.scope');
      expect(index).toBeGreaterThanOrEqual(0);
      expect(events[index + 1]).toBe('harness.decision:decision');
    } finally {
      log.mockRestore();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('each review.done branch emits directly after the unchanged log and keeps its result', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      events.push({ category, event, data: data ?? {} });
    }) as never);
    try {
      const opts = { llmReview: async () => 'VERDICT: PASS' };
      const unmeasurable = await defaultSeams({ ...opts, reviewScopeDiff: async () => REVIEW_SCOPE_UNMEASURABLE }).reviewDiff!('/tmp/unmeasurable', { runId: 'run-review', round: 1 });
      resetLiveDetailCacheForTesting();
      const noDiff = await defaultSeams({ ...opts, reviewScopeDiff: async () => '' }).reviewDiff!('/tmp/no-diff', { runId: 'run-review', round: 2 });
      resetLiveDetailCacheForTesting();
      const reviewed = await defaultSeams({ ...opts, reviewScopeDiff: async () => '+changed' }).reviewDiff!('/tmp/changed', { runId: 'run-review', round: 3 });
      resetLiveDetailCacheForTesting();
      const unavailable = await defaultSeams({ llmReview: async () => { throw new Error('reviewer unavailable'); }, reviewScopeDiff: async () => '+changed' })
        .reviewDiff!('/tmp/unavailable', { runId: 'run-review', round: 4 });
      expect(unmeasurable).toMatchObject({ verdict: 'fail', reviewed: false, failureReason: 'unmeasurable-scope' });
      expect(noDiff).toMatchObject({ verdict: 'pass', reviewed: false, failureReason: 'no-diff' });
      expect(reviewed).toMatchObject({ verdict: 'pass', reviewed: true });
      expect(unavailable).toMatchObject({ verdict: 'pass', reviewed: false, failureReason: 'reviewer unavailable' });
      const decisions = events.filter(({ event }) => event === 'review.done');
      expect(decisions.map(({ data }) => data)).toEqual([
        expect.objectContaining({ verdict: 'fail', reviewed: false, reason: 'unmeasurable-scope', round: 1 }),
        expect.objectContaining({ verdict: 'pass', reviewed: false, reason: 'no-diff', round: 2 }),
        expect.objectContaining({ verdict: 'pass', reviewed: true, round: 3 }),
        expect.objectContaining({ verdict: 'pass', reviewed: false, failureReason: 'reviewer unavailable', round: 4 }),
      ]);
      for (const decision of decisions) {
        expect(events[events.indexOf(decision) + 1]).toMatchObject({ category: 'harness.decision', event: 'decision', data: { kind: 'VERIFY', runId: 'run-review' } });
      }
    } finally {
      log.mockRestore();
    }
  });

  test('real review forwards only the first must-fix sentence to the decision reason', async () => {
    resetLiveDetailCacheForTesting();
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      events.push({ category, event, data: data ?? {} });
    }) as never);
    try {
      const result = await defaultSeams({
        llmReview: async () => 'VERDICT: FAIL\nMUST-FIX:\n- src/a.ts 에서 null 검사가 빠졌다\n- 두 번째 지적',
        reviewScopeDiff: async () => '+changed',
      }).reviewDiff!('/tmp/changed', { runId: 'run-review-findings' });
      expect(result.mustFix.length).toBeGreaterThan(0);
      const event = events.find(({ category, event }) => category === 'harness.decision' && event === 'decision');
      expect(event?.data.reason).toContain('null 검사가 빠졌다');
      expect(event?.data.reason).not.toContain('두 번째 지적');
      expect(event?.data.refs).toMatchObject({ mustFix: result.mustFix.length, shouldFix: result.shouldFix.length });
    } finally {
      log.mockRestore();
    }
  });

  test('decision emission failure cannot change review results or unchanged review.done logging', async () => {
    const events: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string) => {
      events.push(`${category}:${event}`);
      if (category === 'harness.decision') throw new Error('decision sink unavailable');
    }) as never);
    try {
      const result = await defaultSeams({ llmReview: async () => 'unused', reviewScopeDiff: async () => REVIEW_SCOPE_UNMEASURABLE })
        .reviewDiff!('/tmp/unmeasurable', { runId: 'run-review-fail-soft' });
      expect(result).toMatchObject({ verdict: 'fail', reviewed: false, failureReason: 'unmeasurable-scope' });
      expect(events).toEqual(['self-implement:review.done', 'harness.decision:decision']);
    } finally {
      log.mockRestore();
    }
  });

  test('decision emission failure leaves pinned merge failure unchanged', async () => {
    const events: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string) => {
      events.push(`${category}:${event}`);
      if (category === 'harness.decision') throw new Error('decision sink unavailable');
    }) as never);
    try {
      resetLiveDetailCacheForTesting();
      const merge = defaultSeams({ spawnSync: (() => ({ status: 1, stdout: '', stderr: 'head mismatch' })) as unknown as typeof spawnSync }).mergePr!;
      expect(await merge({ cwd: '/tmp', number: 44, matchHeadCommit: 'fixed-sha' })).toEqual({ merged: false, detail: 'head mismatch' });
      expect(events).toEqual(['self-implement:merge.gh', 'harness.decision:decision']);
    } finally {
      log.mockRestore();
    }
  });

  test('pinned merge failure keeps its status and emits immediately after merge.gh', async () => {
    resetLiveDetailCacheForTesting();
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      events.push({ category, event, data: data ?? {} });
    }) as never);
    try {
      const merge = defaultSeams({ spawnSync: (() => ({ status: 1, stdout: '', stderr: 'head mismatch' })) as unknown as typeof spawnSync }).mergePr!;
      expect(await merge({ cwd: '/tmp', number: 42, matchHeadCommit: 'fixed-sha' })).toEqual({ merged: false, detail: 'head mismatch' });
      const index = events.findIndex(({ event }) => event === 'merge.gh');
      expect(index).toBeGreaterThanOrEqual(0);
      expect(events[index]?.data).toEqual({ number: 42, mergeExit: 1, stateExit: null, prState: null, merged: false });
      expect(events[index + 1]).toMatchObject({ category: 'harness.decision', event: 'decision', data: { kind: 'ESCALATE', phase: 'land', refs: { pr: 42 }, target: '사람' } });
    } finally {
      log.mockRestore();
    }
  });

  test('confirmed and unconfirmed PR states emit after merge.gh without changing results', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      events.push({ category, event, data: data ?? {} });
    }) as never);
    try {
      for (const [state, merged] of [['MERGED', true], ['OPEN', false]] as const) {
        resetLiveDetailCacheForTesting();
        const run = defaultSeams({
          spawnSync: ((_command: string, args: readonly string[]) => {
            if (args.includes('mergeCommit')) return { status: 0, stdout: '{"mergeCommit":null}', stderr: '' };
            if (args.includes('state,baseRefName')) return { status: 0, stdout: JSON.stringify({ state }), stderr: '' };
            return { status: 0, stdout: '', stderr: '' };
          }) as unknown as typeof spawnSync,
        });
        const result = await run.mergePr!({ cwd: '/tmp', number: 43 });
        expect(result.merged).toBe(merged);
        const index = events.map(({ event }) => event).lastIndexOf('merge.gh');
        expect(events[index]?.data).toMatchObject({ number: 43, merged, prState: state });
        expect(events[index + 1]).toMatchObject({ category: 'harness.decision', event: 'decision', data: { kind: merged ? 'SHIP' : 'ESCALATE', phase: 'land', refs: { pr: 43 }, target: merged ? '병합 완료' : '사람' } });
      }
    } finally {
      log.mockRestore();
    }
  });
});
