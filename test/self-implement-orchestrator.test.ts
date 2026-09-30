// P0 · self-implement 오케스트레이터 순수 시퀀서 테스트 (2026-07-19).
// 모든 seam 을 fake 로 주입 — 실 git/session/PR 무접촉.

import { describe, it, expect, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { debug } from '../src/debug/log.js';
import { boundReadableText, buildImplementAbortRecord, classifyObservationMeasurement, formatImplementAbortProgressLine, IMPLEMENT_ABORT_REASON_MAX_CHARS, makeRunObserver, runSelfImplement, slugifyFeature, type GoalExecutionRecord, type SelfImplementSeams } from '../src/self-implement/orchestrator.js';
import { DEFAULT_BRANCH_WORKTREE_BASE } from '../src/git-fs/worktree.js';
import { plannedSelfImplBranch } from '../src/harness/worktree-branch-prefix.js';
import { appendRunLedgerEntry, loadRunLedger, queryMergeAttribution, queryMergedRunLedgers } from '../src/self-implement/run-ledger.js';
import { insertGoalRunRecord, loadGoalRunRecordsByRunId } from '../src/self-implement/goal-run-store.js';
import { PIPELINE_EDGES_BY_NODE, type PipelineNodeId } from '../src/self-implement/pipeline-shape.js';
import { getUserConfig } from '../src/user-config.js';
import { seams as sharedTestSeams } from '../src/self-implement/test-seams.js';

/** 전 단계 통과하는 기본 fake seam. 개별 테스트가 필요한 부분만 override. */
function okSeams(over: Partial<SelfImplementSeams> = {}): SelfImplementSeams {
  return {
    // ⛔⭐⭐⭐ 기본을 «무동작»으로 — 안 채우면 실제 계정 스토어를 읽고 codex 자식을 띄우고
    //   ~/.elanous/budget 에 쓴다(= 테스트가 «운영 쿼터를 소모»한다 · 리뷰 must-fix).
    refreshCodexQuotaSignals: async () => ({ accounts: [] }),
    writeRunLedger: () => {},
    createWorktree: async ({ branch, base }) => ({ path: `/tmp/wt/${branch}`, branch, base, resolvedBase: 'a'.repeat(40), invokedHead: 'a'.repeat(40) }),
    implement: async () => ({ ok: true, summary: '구현 완료' }),
    gate: async () => ({ passed: true, log: 'ok' }),
    reviewBaselineObservationSource: async () => '',
    judgmentCallLLM: async ({ prompt }) => prompt.match(/BUDGET:\s*(EXTEND|SUFFICIENT|UNCONVERGEABLE)/)?.[1] ?? 'EXTEND',
    openPr: async ({ head }) => ({ url: `https://gh/pr/1?head=${head}`, number: 1 }),
    approvePr: async () => true, // fail-closed 이므로 happy path 는 명시 승인 필요
    defaultBranchRef: () => 'origin/main',
    // UNCONVERGEABLE 종료가 라이브 분해기(최대 T.decomposition)를 기다리지 않게 결정론 seam 으로 끊는다.
    decomposeShadowGoals: async () => ({
      goals: [],
      decomposition: { recommendedMaxTasks: 6, actualTaskCount: 0, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'single-no-subtasks' },
    }),
    ...over,
  };
}

describe('makeRunObserver — run JSONL ledger', () => {
  it('writes exactly the injected observer event list in order to one run ledger', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'elanous-run-ledger-'));
    const previous = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = stateDir;
    const observed: string[] = [];
    try {
      const observe = makeRunObserver('ledger-order', 'goal-1', ((_category: string, event: string) => { observed.push(event); }) as typeof debug.log, appendRunLedgerEntry);
      observe('first', { ordinal: 1 });
      observe('second', { ordinal: 2 });
      const ledger = loadRunLedger('ledger-order');
      expect(ledger).not.toBeNull();
      expect(ledger!.map((entry) => entry.event)).toEqual(observed);
      expect(ledger).toEqual([
        expect.objectContaining({ runId: 'ledger-order', event: 'first', goalId: 'goal-1', data: expect.objectContaining({ ordinal: 1, runId: 'ledger-order', goalId: 'goal-1' }) }),
        expect.objectContaining({ runId: 'ledger-order', event: 'second', goalId: 'goal-1', data: expect.objectContaining({ ordinal: 2, runId: 'ledger-order', goalId: 'goal-1' }) }),
      ]);
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previous;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('keeps the injected observation log when ledger writing fails', () => {
    const observed: string[] = [];
    const observe = makeRunObserver(
      'ledger-fail',
      ((_category: string, event: string) => { observed.push(event); }) as typeof debug.log,
      undefined,
      () => { throw new Error('ledger unavailable'); },
    );
    observe('still-observed', { value: true });
    expect(observed).toEqual(['still-observed']);
  });

  it('distinguishes a missing ledger from invalid ids, corrupt JSONL, and read failures', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'elanous-run-ledger-'));
    try {
      expect(loadRunLedger('missing', stateDir)).toBeNull();
      expect(() => loadRunLedger('../invalid', stateDir)).toThrow('invalid runId');
      writeFileSync(join(stateDir, 'corrupt.jsonl'), '{not json}\n');
      expect(() => loadRunLedger('corrupt', stateDir)).toThrow('invalid run ledger JSON at line 1');
      expect(() => loadRunLedger('read-failure', stateDir, () => {
        const error = new Error('permission denied') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      })).toThrow('unable to read run ledger');
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe('queryMergedRunLedgers — multi-run merge facts', () => {
  it('collects merged events across readable ledgers while counting an unreadable ledger', () => {
    const ledgerDir = mkdtempSync(join(tmpdir(), 'elanous-merged-ledgers-'));
    try {
      appendRunLedgerEntry({ timestamp: '2026-08-05T10:00:00.000Z', runId: 'run-00000000-0000-0000-0000-000000007158', event: 'merged', data: { number: 7158, merged: true, detail: null } }, ledgerDir);
      appendRunLedgerEntry({ timestamp: '2026-08-05T11:00:00.000Z', runId: 'run-00000000-0000-0000-0000-000000007161', event: 'merged', data: { number: 7161, merged: false, detail: 'blocked' } }, ledgerDir);
      appendRunLedgerEntry({ timestamp: '2026-08-05T12:00:00.000Z', runId: 'run-00000000-0000-0000-0000-000000009999', event: 'pr-opened', data: { number: 9999 } }, ledgerDir);
      writeFileSync(join(ledgerDir, 'run-00000000-0000-0000-0000-000000009998.jsonl'), '{not json}\n');

      const result = queryMergedRunLedgers({ dir: ledgerDir });

      expect(result.entries).toEqual([
        { prNumber: 7158, merged: true, runId: 'run-00000000-0000-0000-0000-000000007158', timestamp: '2026-08-05T10:00:00.000Z' },
        { prNumber: 7161, merged: false, runId: 'run-00000000-0000-0000-0000-000000007161', timestamp: '2026-08-05T11:00:00.000Z' },
      ]);
      expect(result.excludedMergedEntryCount).toBe(0);
      expect(result.excludedLedgerCount).toBe(0);
      expect(result.unreadableLedgerCount).toBe(1);
      expect(result.ledgerDirectory).toBe(ledgerDir);
      expect(result.ledgerDirectoryMissing).toBe(false);
      expect(result).toMatchObject({
        scope: 'self-implement-run-ledger',
        note: expect.stringContaining('excludes review-loop and merges performed outside elanous'),
      });
    } finally {
      rmSync(ledgerDir, { recursive: true, force: true });
    }
  });

  it('excludes every merged entry from ledgers with multiple merged events while retaining normal ledgers', () => {
    const ledgerDir = mkdtempSync(join(tmpdir(), 'elanous-contaminated-merged-ledgers-'));
    try {
      appendRunLedgerEntry({ timestamp: '2026-08-05T10:00:00.000Z', runId: 'run-00000000-0000-0000-0000-000000007173', event: 'merged', data: { number: 1, merged: true } }, ledgerDir);
      appendRunLedgerEntry({ timestamp: '2026-08-05T10:01:00.000Z', runId: 'run-00000000-0000-0000-0000-000000007173', event: 'merged', data: { number: 7173, merged: true } }, ledgerDir);
      appendRunLedgerEntry({ timestamp: '2026-08-05T11:00:00.000Z', runId: 'run-00000000-0000-0000-0000-000000007158', event: 'merged', data: { number: 7158, merged: true } }, ledgerDir);

      const result = queryMergedRunLedgers({ dir: ledgerDir });

      expect(result.entries).toEqual([
        { prNumber: 7158, merged: true, runId: 'run-00000000-0000-0000-0000-000000007158', timestamp: '2026-08-05T11:00:00.000Z' },
      ]);
      expect(result.excludedMergedEntryCount).toBe(2);
      expect(result.excludedLedgerCount).toBe(1);
      expect(result.note).toContain('two or more merged events');
    } finally {
      rmSync(ledgerDir, { recursive: true, force: true });
    }
  });

  it('excludes a ledger when a malformed merged event accompanies a valid merged event', () => {
    const ledgerDir = mkdtempSync(join(tmpdir(), 'elanous-malformed-contaminated-ledger-'));
    try {
      appendRunLedgerEntry({ timestamp: '2026-08-05T10:00:00.000Z', runId: 'run-00000000-0000-0000-0000-000000007174', event: 'merged', data: { detail: 'missing merge fields' } }, ledgerDir);
      appendRunLedgerEntry({ timestamp: '2026-08-05T10:01:00.000Z', runId: 'run-00000000-0000-0000-0000-000000007174', event: 'merged', data: { number: 7173, merged: true } }, ledgerDir);

      const result = queryMergedRunLedgers({ dir: ledgerDir });

      expect(result.entries).toEqual([]);
      expect(result.excludedMergedEntryCount).toBe(2);
      expect(result.excludedLedgerCount).toBe(1);
    } finally {
      rmSync(ledgerDir, { recursive: true, force: true });
    }
  });

  it('filters by inclusive timestamp range and distinguishes a missing directory from an empty one', () => {
    const ledgerDir = mkdtempSync(join(tmpdir(), 'elanous-merged-range-'));
    const missingDir = join(ledgerDir, 'missing');
    try {
      appendRunLedgerEntry({ timestamp: '2026-08-05T10:00:00.000Z', runId: 'run-00000000-0000-0000-0000-000000000001', event: 'merged', data: { number: 1, merged: true } }, ledgerDir);
      appendRunLedgerEntry({ timestamp: '2026-08-05T11:00:00.000Z', runId: 'run-00000000-0000-0000-0000-000000000002', event: 'merged', data: { number: 2, merged: true } }, ledgerDir);
      appendRunLedgerEntry({ timestamp: '2026-08-05T12:00:00.000Z', runId: 'run-00000000-0000-0000-0000-000000000003', event: 'merged', data: { number: 3, merged: true } }, ledgerDir);

      expect(queryMergedRunLedgers({ dir: ledgerDir, from: '2026-08-05T11:00:00.000Z', to: '2026-08-05T11:00:00.000Z' }).entries)
        .toEqual([{ prNumber: 2, merged: true, runId: 'run-00000000-0000-0000-0000-000000000002', timestamp: '2026-08-05T11:00:00.000Z' }]);
      expect(queryMergedRunLedgers({ dir: ledgerDir })).toMatchObject({ ledgerDirectory: ledgerDir, ledgerDirectoryMissing: false });
      expect(queryMergedRunLedgers({ dir: missingDir })).toMatchObject({ entries: [], ledgerDirectory: missingDir, unreadableLedgerCount: 0, ledgerDirectoryMissing: true });
    } finally {
      rmSync(ledgerDir, { recursive: true, force: true });
    }
  });
});

describe('queryMergeAttribution — observable merge attribution facts', () => {
  it('attributes merged:false directly to a human handoff after a merge attempt without inventing an unattributable count', () => {
    const ledgerDir = mkdtempSync(join(tmpdir(), 'elanous-merge-attribution-'));
    try {
      appendRunLedgerEntry({ timestamp: '2026-08-05T10:00:00.000Z', runId: 'run-00000000-0000-0000-0000-000000007158', event: 'merged', data: { number: 7158, merged: true } }, ledgerDir);
      appendRunLedgerEntry({ timestamp: '2026-08-05T10:30:00.000Z', runId: 'run-00000000-0000-0000-0000-000000007159', event: 'merged', data: { number: 7159, merged: false } }, ledgerDir);
      appendRunLedgerEntry({ timestamp: '2026-08-05T11:00:00.000Z', runId: 'run-00000000-0000-0000-0000-000000000101', event: 'run-status', data: { stage: 'pr-opened', node: 'open-pr' } }, ledgerDir);
      appendRunLedgerEntry({ timestamp: '2026-08-05T11:30:00.000Z', runId: 'run-00000000-0000-0000-0000-000000000102', event: 'run-status', data: { stage: 'pr-opened', node: 'open-pr' } }, ledgerDir);
      appendRunLedgerEntry({ timestamp: '2026-08-05T12:00:00.000Z', runId: 'run-00000000-0000-0000-0000-000000000103', event: 'run-status', data: { stage: 'pr-opened', node: 'merge' } }, ledgerDir);
      appendRunLedgerEntry({ timestamp: '2026-08-05T13:00:00.000Z', runId: 'run-00000000-0000-0000-0000-000000000104', event: 'run-status', data: { stage: 'aborted', node: 'implement' } }, ledgerDir);
      appendRunLedgerEntry({ timestamp: '2026-08-05T14:00:00.000Z', runId: 'run-00000000-0000-0000-0000-000000000105', event: 'run-status', data: { stage: 'review-blocked', node: 'merge' } }, ledgerDir);
      appendRunLedgerEntry({ timestamp: '2026-08-05T15:00:00.000Z', runId: 'run-00000000-0000-0000-0000-000000000106', event: 'run-status', data: { stage: 'timed-out', node: 'merge' } }, ledgerDir);
      appendRunLedgerEntry({ timestamp: '2026-08-05T16:00:00.000Z', runId: 'run-00000000-0000-0000-0000-000000000107', event: 'merged', data: { number: 1, merged: true } }, ledgerDir);
      appendRunLedgerEntry({ timestamp: '2026-08-05T16:01:00.000Z', runId: 'run-00000000-0000-0000-0000-000000000107', event: 'merged', data: { number: 2, merged: true } }, ledgerDir);
      appendRunLedgerEntry({ timestamp: '2026-08-05T16:02:00.000Z', runId: 'run-00000000-0000-0000-0000-000000000107', event: 'run-status', data: { stage: 'pr-opened', node: 'open-pr' } }, ledgerDir);

      const result = queryMergeAttribution({ dir: ledgerDir });

      expect(result.elanousMergedEntries).toEqual([
        { prNumber: 7158, merged: true, runId: 'run-00000000-0000-0000-0000-000000007158', timestamp: '2026-08-05T10:00:00.000Z' },
      ]);
      expect(result.handedToHumanWithoutMergeAttemptCount).toBe(2);
      expect(result.handedToHumanAfterMergeAttemptCount).toBe(2);
      expect(result.ledgerDirectory).toBe(ledgerDir);
      expect(result).toMatchObject({
        unattributable: {
          status: 'not-countable',
          reason: expect.stringContaining('cannot be counted'),
        },
        excludedMergedEntryCount: 2,
        excludedLedgerCount: 1,
        note: expect.stringContaining('does not read the log-store observations for review-loop auto-merged events or MergePullRequest tool calls'),
      });
      expect(result.unattributable).not.toHaveProperty('count');
      expect(JSON.stringify(result)).not.toContain('ratio');
      expect(JSON.stringify(result)).not.toContain('independence');
    } finally {
      rmSync(ledgerDir, { recursive: true, force: true });
    }
  });

  it('uses one terminal status per non-merged run and applies the range to every attribution bucket', () => {
    const ledgerDir = mkdtempSync(join(tmpdir(), 'elanous-merge-attribution-range-'));
    try {
      appendRunLedgerEntry({ timestamp: '2026-08-05T09:00:00.000Z', runId: 'run-00000000-0000-0000-0000-000000000201', event: 'run-status', data: { stage: 'pr-opened', node: 'open-pr' } }, ledgerDir);
      appendRunLedgerEntry({ timestamp: '2026-08-05T10:00:00.000Z', runId: 'run-00000000-0000-0000-0000-000000000202', event: 'merged', data: { number: 1, merged: true } }, ledgerDir);
      appendRunLedgerEntry({ timestamp: '2026-08-05T10:30:00.000Z', runId: 'run-00000000-0000-0000-0000-000000000203', event: 'run-status', data: { stage: 'pr-opened', node: 'open-pr' } }, ledgerDir);
      appendRunLedgerEntry({ timestamp: '2026-08-05T10:31:00.000Z', runId: 'run-00000000-0000-0000-0000-000000000203', event: 'run-status', data: { stage: 'pr-opened', node: 'open-pr' } }, ledgerDir);
      appendRunLedgerEntry({ timestamp: '2026-08-05T10:40:00.000Z', runId: 'run-00000000-0000-0000-0000-000000000204', event: 'run-status', data: { stage: 'pr-opened', node: 'open-pr' } }, ledgerDir);
      appendRunLedgerEntry({ timestamp: '2026-08-05T10:41:00.000Z', runId: 'run-00000000-0000-0000-0000-000000000204', event: 'run-status', data: { stage: 'pr-opened', node: 'merge' } }, ledgerDir);
      appendRunLedgerEntry({ timestamp: '2026-08-05T10:50:00.000Z', runId: 'run-00000000-0000-0000-0000-000000000205', event: 'merged', data: { number: 2, merged: true } }, ledgerDir);
      appendRunLedgerEntry({ timestamp: '2026-08-05T10:51:00.000Z', runId: 'run-00000000-0000-0000-0000-000000000205', event: 'run-status', data: { stage: 'pr-opened', node: 'open-pr' } }, ledgerDir);

      const result = queryMergeAttribution({
        dir: ledgerDir,
        from: '2026-08-05T10:00:00.000Z',
        to: '2026-08-05T10:59:59.999Z',
      });

      expect(result.elanousMergedEntries.map((entry) => entry.runId)).toEqual([
        'run-00000000-0000-0000-0000-000000000202',
        'run-00000000-0000-0000-0000-000000000205',
      ]);
      expect(result.handedToHumanWithoutMergeAttemptCount).toBe(1);
      expect(result.handedToHumanAfterMergeAttemptCount).toBe(1);
    } finally {
      rmSync(ledgerDir, { recursive: true, force: true });
    }
  });

  it('reports the absolute ledger directory for relative and missing directories', () => {
    const ledgerDir = mkdtempSync(join(tmpdir(), 'elanous-merge-attribution-directory-'));
    const relativeDir = relative(process.cwd(), ledgerDir) || '.';
    const missingDir = join(ledgerDir, 'missing');
    try {
      expect(queryMergeAttribution({ dir: relativeDir })).toMatchObject({ ledgerDirectory: ledgerDir, ledgerDirectoryMissing: false });
      expect(queryMergeAttribution({ dir: missingDir })).toMatchObject({ ledgerDirectory: missingDir, ledgerDirectoryMissing: true });
    } finally {
      rmSync(ledgerDir, { recursive: true, force: true });
    }
  });

  it('does not mutate ledger fixtures while querying', () => {
    const ledgerDir = mkdtempSync(join(tmpdir(), 'elanous-merge-attribution-read-only-'));
    try {
      appendRunLedgerEntry({ timestamp: '2026-08-05T10:00:00.000Z', runId: 'human-open-pr', event: 'run-status', data: { stage: 'pr-opened', node: 'open-pr' } }, ledgerDir);
      const path = join(ledgerDir, 'human-open-pr.jsonl');
      const beforeText = readFileSync(path, 'utf8');

      queryMergeAttribution({ dir: ledgerDir });

      expect(readFileSync(path, 'utf8')).toBe(beforeText);
    } finally {
      rmSync(ledgerDir, { recursive: true, force: true });
    }
  });
});

describe('observation measurement classification', () => {
  it('distinguishes new observation names, fields on existing observations, and unrelated changes', () => {
    const newName = classifyObservationMeasurement("diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n+debug.log('self-implement', 'landing-observed', { runId });");
    const existingFields = classifyObservationMeasurement("diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n debug.log('self-implement', 'existing-event', {\n   runId,\n+  measurementBasis: 'named',\n });");
    const unrelated = classifyObservationMeasurement("diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n+const pragma = 'WAL';");

    expect([newName, existingFields, unrelated]).toEqual([
      'new-observation-name',
      'existing-observation-fields',
      'no-observation',
    ]);
    expect(new Set([newName, existingFields, unrelated]).size).toBe(3);
  });

  it('recognizes an existing name from baseline source outside the changed hunk', () => {
    const baselineSource = "debug.log('self-implement', 'existing-event', { runId });";
    const reusedElsewhere = classifyObservationMeasurement(
      "diff --git a/src/new-location.ts b/src/new-location.ts\n--- a/src/new-location.ts\n+++ b/src/new-location.ts\n+debug.log('self-implement', 'existing-event', { runId, measurementBasis: 'named' });",
      baselineSource,
    );

    expect(reusedElsewhere).toBe('existing-observation-fields');
  });

  it('scans executable template interpolations while ignoring static strings and comments', () => {
    const trivia = classifyObservationMeasurement("diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n+// debug.log('self-implement', 'comment-event', {})\n+const example = \"observeEvent('string-event', {})\";\n+const template = `debug.log('self-implement', 'static-template-event', {})`;\n");
    const interpolation = classifyObservationMeasurement("diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n+const dynamic = `example ${(() => { const escaped = '\\}'; return debug.log('self-implement', 'template-event', { nested: { value: true } }); })()}`;");

    expect([trivia, interpolation]).toEqual(['no-observation', 'new-observation-name']);
  });

  it('limits runtime scanning to parser-compatible JS and TS sources', () => {
    const unsupportedComments = classifyObservationMeasurement([
      "diff --git a/src/events.py b/src/events.py\n--- a/src/events.py\n+++ b/src/events.py\n+# debug.log('self-implement', 'python-comment', {})",
      "diff --git a/src/events.rb b/src/events.rb\n--- a/src/events.rb\n+++ b/src/events.rb\n+# observeEvent('ruby-comment', {})",
    ].join('\n'));
    const nonRuntime = classifyObservationMeasurement([
      "diff --git a/docs/example.md b/docs/example.md\n--- a/docs/example.md\n+++ b/docs/example.md\n+debug.log('self-implement', 'document-event', {});",
      "diff --git a/test/fixtures/events.ts b/test/fixtures/events.ts\n--- a/test/fixtures/events.ts\n+++ b/test/fixtures/events.ts\n+debug.log('self-implement', 'fixture-event', {});",
      "diff --git a/src/__snapshots__/events.ts.snap b/src/__snapshots__/events.ts.snap\n--- a/src/__snapshots__/events.ts.snap\n+++ b/src/__snapshots__/events.ts.snap\n+debug.log('self-implement', 'snapshot-event', {});",
      "diff --git a/generated/events.ts b/generated/events.ts\n--- a/generated/events.ts\n+++ b/generated/events.ts\n+debug.log('self-implement', 'generated-event', {});",
    ].join('\n'));

    expect([unsupportedComments, nonRuntime]).toEqual(['no-observation', 'no-observation']);
  });
});

describe('runSelfImplement — 파이프라인 시퀀싱', () => {
  // ⛔ 이름이 «검증하는 것»과 같아야 한다 — 종전 이름은 "goal execution summary 를 같은 원장에 쓴다"
  //    였는데 실제로는 골 문서 writer 만 확인한다. 이름이 거짓 명세면 다음 사람이 없는 보장을 믿는다.
  it('writes terminal run-status to the run ledger while the goal execution summary stays in the goal document', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'elanous-run-ledger-'));
    const previous = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = stateDir;
    const records: Array<Record<string, unknown>> = [];
    const storedRecords: Array<Record<string, unknown>> = [];
    try {
      const result = await runSelfImplement({
        feature: 'ledger terminal events',
        runId: 'ledger-terminal',
        goalFile: '/goal.txt',
        writeGoalExecutionRecord: (_goalFile, record) => { records.push(record as unknown as Record<string, unknown>); },
        writeGoalRunRecord: (_goalFile, record) => { storedRecords.push(record as unknown as Record<string, unknown>); },
        seams: okSeams({ writeRunLedger: appendRunLedgerEntry }),
      });
      const entries = loadRunLedger(result.runId)!;
      const status = entries.find((entry) => entry.event === 'run-status');
      expect(status).toEqual(expect.objectContaining({ data: expect.objectContaining({ stage: result.stage }) }));
      // ⛔ `goal-execution-record` 가 원장에 있어야 한다고 «고정하지 않는다» — 그것은 골 문서(사람이 여는
      //    자리)의 종결 요약이고 관측 관문을 지나지 않는다. 그걸 요구하면 원장을 채우려고 관문에
      //    이벤트를 태우게 되고, 이 착지의 불변식이 뒤집힌다(리뷰 must-fix).
      //    ⇒ 종결 요약은 «골 문서에» 그대로 쓰인다는 것만 확인한다.
      expect(records[0]).toEqual(expect.objectContaining({ outcome: result.outcome, ok: result.ok }));
      expect(records[0]).not.toHaveProperty('observationMeasurementBasis');
      expect(storedRecords[0]).not.toHaveProperty('observationMeasurementBasis');
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previous;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('uses the injected ledger writer for the inner merged observer', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'elanous-merged-ledger-seam-'));
    const previous = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = stateDir;
    const writtenEvents: string[] = [];
    try {
      const result = await runSelfImplement({
        feature: 'merged ledger seam',
        runId: 'merged-ledger-seam',
        autoMerge: true,
        seams: okSeams({
          writeRunLedger: (entry) => { writtenEvents.push(entry.event); },
          reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'review', reviewed: true, diffTruncated: false, diffShownChars: 100, diffTotalChars: 100, diffOmittedFiles: 0 }),
          readPrDiff: async () => 'diff --git a/src/x.ts b/src/x.ts\n',
          readPrCommitShas: async () => ({ baseCommit: 'base-sha', headCommit: 'checked-head-sha' }),
          mergePr: async () => ({ merged: true }),
        }),
      });

      expect(result.stage).toBe('merged');
      expect(writtenEvents).toContain('merged');
      expect(loadRunLedger(result.runId)).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previous;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('전 단계 통과 → pr-opened', async () => {
    const r = await runSelfImplement({ feature: 'add foo endpoint', seams: okSeams() });
    expect(r.ok).toBe(true);
    expect(r.stage).toBe('pr-opened');
    expect(r.prNumber).toBe(1);
    // 기본 브랜치는 기존 feature 해시 뒤에 이 실행에서 확정한 runId의 접미사를 붙인다.
    expect(r.branch).toBe(plannedSelfImplBranch('add foo endpoint', undefined, r.runId));
    expect(r.branch).toMatch(/^self-impl\/add-foo-endpoint-[0-9a-f]{8}-r[a-z0-9]{6}$/);
  });

  it('writes the classified review diff through the real goal-run store without changing the result', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'observation-measurement-record-'));
    const goalFile = join(directory, 'GOAL.txt');
    const dbPath = join(directory, 'goal-runs.db');
    const goalId = '9cf5b61d6079c81f';
    writeFileSync(goalFile, `- GoalId: ${goalId}\nobservation measurement goal\n`);
    const documentRecords: Array<Record<string, unknown>> = [];
    try {
      const result = await runSelfImplement({
        feature: 'observation field landing',
        goalFile,
        goalId,
        writeGoalExecutionRecord: (_goalFile, record) => { documentRecords.push(record as unknown as Record<string, unknown>); },
        writeGoalRunRecord: (file, record, id) => { insertGoalRunRecord(file, record, id, dbPath); },
        seams: okSeams({
          implement: async () => ({ ok: true, summary: 'implemented', changedFiles: ['src/example.ts'] }),
          reviewBaselineObservationSource: async () => "debug.log('self-implement', 'existing-event', { runId });",
          reviewScopeDiff: async () => "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n+debug.log('self-implement', 'existing-event', { runId, measurementBasis: 'named' });",
        }),
      });

      expect(result).toMatchObject({ ok: true, stage: 'pr-opened' });
      expect(documentRecords[0]).toEqual(expect.objectContaining({ observationMeasurementBasis: 'existing-observation-fields' }));
      expect(loadGoalRunRecordsByRunId(result.runId, dbPath)[0]?.record).toEqual(expect.objectContaining({ observationMeasurementBasis: 'existing-observation-fields' }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('persists supervisor REASON only when the rework-budget diagnosis provides one without changing terminal results', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'supervisor-reason-ledger-'));
    try {
      for (const [index, diagnosis] of ['BUDGET: EXTEND\nREASON: preserve the established interface', 'BUDGET: EXTEND\nREASON:   '].entries()) {
        const goalFile = join(directory, `GOAL-${index}.txt`);
        const records: GoalExecutionRecord[] = [];
        writeFileSync(goalFile, `- GoalId: supervisor-reason-${index}\n`);
        const result = await runSelfImplement({
          feature: 'persist supervisor reason', runId: `supervisor-reason-${index}`, goalFile, maxReworkRounds: 1,
          writeGoalExecutionRecord: () => {},
          writeGoalRunRecord: (_file, record) => { records.push(record); },
          seams: okSeams({
            gate: (() => { let calls = 0; return async () => ({ passed: ++calls > 1, log: 'needs rework' }); })(),
            diagnose: async () => diagnosis,
          }),
        });
        expect(result).toMatchObject({ ok: true, stage: 'pr-opened', outcome: 'completed' });
        if (index === 0) expect(records[0]).toMatchObject({ supervisorVerdict: 'EXTEND', supervisorReason: 'preserve the established interface' });
        else expect(records[0]).not.toHaveProperty('supervisorReason');
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('persists truncated, untruncated, and absent reviewer context observations distinctly through the goal-run ledger', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'reviewer-context-budget-ledger-'));
    const goalFile = join(directory, 'GOAL.txt');
    const dbPath = join(directory, 'goal-runs.db');
    const goalId = 'reviewer-context-budget-ledger';
    const reviews = [
      { reviewed: true, budget: { itemCount: 1, shownChars: 12_000, totalChars: 12_010, truncated: true, fullyIncludedItems: 0, truncatedItems: 1, omittedItems: 0 } },
      { reviewed: true, budget: { itemCount: 1, shownChars: 13, totalChars: 13, truncated: false, fullyIncludedItems: 1, truncatedItems: 0, omittedItems: 0 } },
      // A fail-soft/non-run review can carry stale fields; it must not become a completed-review ledger observation.
      { reviewed: false, budget: { itemCount: 1, shownChars: 13, totalChars: 13, truncated: false, fullyIncludedItems: 1, truncatedItems: 0, omittedItems: 0 } },
    ] as const;
    try {
      for (const [index, { reviewed, budget }] of reviews.entries()) {
        writeFileSync(goalFile, `- GoalId: ${goalId}\nreviewer context budget ledger goal\n`);
        const result = await runSelfImplement({
          feature: 'persist reviewer context budget',
          runId: `reviewer-context-budget-${index}`,
          goalId,
          goalFile,
          writeGoalExecutionRecord: () => {},
          writeGoalRunRecord: (file, record, id) => { insertGoalRunRecord(file, record, id, dbPath); },
          seams: okSeams({
            reviewDiff: async () => ({
              verdict: 'pass', mustFix: [], shouldFix: [], summary: 'review', reviewed,
              diffTruncated: false, diffShownChars: 100, diffTotalChars: 100, diffOmittedFiles: 0,
              contextItemCount: budget.itemCount, contextShownChars: budget.shownChars,
              contextTotalChars: budget.totalChars, contextTruncated: budget.truncated,
              contextFullyIncludedItems: budget.fullyIncludedItems,
              contextTruncatedItems: budget.truncatedItems, contextOmittedItems: budget.omittedItems,
            }),
          }),
        });
        const stored = loadGoalRunRecordsByRunId(result.runId, dbPath)[0]?.record;
        if (reviewed) expect(stored?.reviewerContextBudget).toEqual(budget);
        else expect(stored).not.toHaveProperty('reviewerContextBudget');
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps measurement unknown when the complete baseline source cannot be read', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'observation-baseline-unknown-'));
    const goalFile = join(directory, 'GOAL.txt');
    const records: Array<Record<string, unknown>> = [];
    writeFileSync(goalFile, 'unknown baseline goal\n');
    try {
      const result = await runSelfImplement({
        feature: 'unknown observation baseline',
        goalFile,
        writeGoalExecutionRecord: (_goalFile, record) => { records.push(record as unknown as Record<string, unknown>); },
        writeGoalRunRecord: () => {},
        seams: okSeams({
          reviewScopeDiff: async () => "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n+debug.log('self-implement', 'possibly-existing', { runId });",
          reviewBaselineObservationSource: async () => undefined,
        }),
      });

      expect(result).toMatchObject({ ok: true, stage: 'pr-opened' });
      expect(records[0]).not.toHaveProperty('observationMeasurementBasis');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps measurement unknown when the diff read fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'observation-measurement-unknown-'));
    const goalFile = join(directory, 'GOAL.txt');
    const records: Array<Record<string, unknown>> = [];
    writeFileSync(goalFile, 'unknown measurement goal\n');
    try {
      const result = await runSelfImplement({
        feature: 'unknown measurement',
        goalFile,
        writeGoalExecutionRecord: (_goalFile, record) => { records.push(record as unknown as Record<string, unknown>); },
        writeGoalRunRecord: () => {},
        seams: okSeams({ reviewScopeDiff: async () => { throw new Error('diff unavailable'); } }),
      });

      expect(result).toMatchObject({ ok: true, stage: 'pr-opened' });
      expect(records[0]).not.toHaveProperty('observationMeasurementBasis');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves an earlier valid measurement when a later rework diff read fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'observation-measurement-rework-'));
    const goalFile = join(directory, 'GOAL.txt');
    const records: Array<Record<string, unknown>> = [];
    let diffCall = 0;
    let reviewCall = 0;
    writeFileSync(goalFile, 'preserve measurement goal\n');
    try {
      const result = await runSelfImplement({
        feature: 'preserve measurement across rework',
        goalFile,
        maxReworkRounds: 1,
        writeGoalExecutionRecord: (_goalFile, record) => { records.push(record as unknown as Record<string, unknown>); },
        writeGoalRunRecord: () => {},
        seams: okSeams({
          reviewScopeDiff: async () => {
            diffCall += 1;
            if (diffCall > 1) throw new Error('later diff unavailable');
            return "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n+debug.log('self-implement', 'landing-observed', { runId });";
          },
          reviewDiff: async () => {
            reviewCall += 1;
            return reviewCall === 1
              ? { verdict: 'fail', mustFix: ['fix it'], shouldFix: [], summary: 'fix', reviewed: true }
              : { verdict: 'pass', mustFix: [], shouldFix: [], summary: 'ok', reviewed: true };
          },
        }),
      });

      expect(result).toMatchObject({ ok: true, stage: 'pr-opened' });
      expect(diffCall).toBe(2);
      expect(records[0]).toEqual(expect.objectContaining({ observationMeasurementBasis: 'new-observation-name' }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('start 관측이 자연어 파생 goalFile보다 자연어 출처를 우선하고, authored·무파일 런을 구분한다', async () => {
    const starts: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'start') starts.push(data ?? {});
    }) as never);
    try {
      await runSelfImplement({ feature: 'authored source', goalFile: '/goal.txt', runId: 'goal-source-authored', seams: okSeams() });
      await runSelfImplement({ feature: 'natural source', naturalLanguageDispatch: true, goalFile: '/derived-goal.txt', runId: 'goal-source-natural', seams: okSeams() });
      await runSelfImplement({ feature: 'unattributed source', runId: 'goal-source-unattributed', seams: okSeams() });
    } finally {
      log.mockRestore();
    }
    expect(starts).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: 'goal-source-authored', goalSource: 'authored-goal-file', feature: 'authored source', branch: expect.any(String), base: null, draft: true, willFork: false, nestDepth: expect.any(Number) }),
      expect.objectContaining({ runId: 'goal-source-natural', goalSource: 'natural-language-dispatch', feature: 'natural source', branch: expect.any(String), base: null, draft: true, willFork: false, nestDepth: expect.any(Number) }),
      expect.objectContaining({ runId: 'goal-source-unattributed', goalSource: 'no-goal-file', feature: 'unattributed source', branch: expect.any(String), base: null, draft: true, willFork: false, nestDepth: expect.any(Number) }),
    ]));
  });

  it('result runId equals the run-identity record for the same run', async () => {
    const identities: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'own') identities.push(data ?? {});
    }) as never);
    let result: Awaited<ReturnType<typeof runSelfImplement>>;
    try {
      result = await runSelfImplement({ feature: 'addressable', runId: 'run-result-joins-log', seams: okSeams() });
    } finally {
      log.mockRestore();
    }
    expect(result!.runId).toBe('run-result-joins-log');
    expect(identities).toContainEqual(expect.objectContaining({ runId: result!.runId, source: 'explicit' }));
  });

  // ⚠️ 위 테스트는 runId 를 명시해 `explicit` 경로만 통과시킨다 — re-resolve 드리프트를 못 잡는다
  //   (사후 리뷰 must-fix 2026-07-28). mint/inherit 두 경로에서 **반환값과 own 기록의 동일성**을 고정한다.
  //   재resolve 가 들어오면 mint 는 새 값을 만들고 inherit 는 env 를 읽으므로 여기서 갈라진다.
  it('result runId equals the own record on the minted path (no explicit id)', async () => {
    const identities: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_c: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'own') identities.push(data ?? {});
    }) as never);
    const priorEnv = process.env.ELANOUS_RUN_ID;
    delete process.env.ELANOUS_RUN_ID;                       // mint 경로 강제
    let result: Awaited<ReturnType<typeof runSelfImplement>>;
    try {
      result = await runSelfImplement({ feature: 'minted addressable', seams: okSeams() });
    } finally {
      log.mockRestore();
      if (priorEnv === undefined) delete process.env.ELANOUS_RUN_ID; else process.env.ELANOUS_RUN_ID = priorEnv;
    }
    expect(result!.runId).toBeTruthy();
    expect(identities).toContainEqual(expect.objectContaining({ runId: result!.runId, source: 'minted' }));
  });

  // ⚠️ 이것은 **드리프트 테스트가 아니다**(뮤테이션으로 확인 · 2026-07-28): inherited 경로는 두 resolve 가
  //   같은 env(`ELANOUS_RUN_ID`)를 읽으므로 **구조적으로 드리프트할 수 없다**. 이 테스트가 고정하는 것은
  //   "env 가 준 id 가 result·기록 양쪽에 그대로 온다" 이고, 드리프트를 잡는 것은 위 minted 테스트다.
  it('result runId is the env-supplied id on the inherited path (NOT a drift test — see note)', async () => {
    const identities: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_c: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'own') identities.push(data ?? {});
    }) as never);
    const priorEnv = process.env.ELANOUS_RUN_ID;
    process.env.ELANOUS_RUN_ID = 'run-inherited-addressable';  // inherit 경로 강제
    let result: Awaited<ReturnType<typeof runSelfImplement>>;
    try {
      result = await runSelfImplement({ feature: 'inherited addressable', seams: okSeams() });
    } finally {
      log.mockRestore();
      if (priorEnv === undefined) delete process.env.ELANOUS_RUN_ID; else process.env.ELANOUS_RUN_ID = priorEnv;
    }
    expect(result!.runId).toBe('run-inherited-addressable');
    expect(identities).toContainEqual(expect.objectContaining({ runId: result!.runId, source: 'inherited' }));
  });

  it('SelfImplementResult cannot silently omit its run identity', () => {
    const legacyCallerResult: Omit<import('../src/self-implement/orchestrator.js').SelfImplementResult, 'runId'> = {
      ok: true,
      stage: 'pr-opened',
      node: 'open-pr',
      outcome: 'completed',
    };
    const requiresRunIdentity = (_result: import('../src/self-implement/orchestrator.js').SelfImplementResult): void => {};
    // @ts-expect-error runId is the only omitted required field, so an old caller cannot represent a no-id run as omission.
    requiresRunIdentity(legacyCallerResult);
    expect('runId' in legacyCallerResult).toBe(false);
  });

  it('③ 구현 실패 → aborted (gate·PR 미실행)', async () => {
    let gateCalled = false;
    const r = await runSelfImplement({
      feature: 'x',
      seams: okSeams({
        implement: async () => ({ ok: false, summary: '빌드 실패' }),
        gate: async () => { gateCalled = true; return { passed: true }; },
      }),
    });
    expect(r.stage).toBe('aborted');
    expect(r.ok).toBe(false);
    expect(gateCalled).toBe(false);
    expect(r.detail).toBe('빌드 실패');
  });

  it('failed implement round attaches the abort-reason summary to the progress line and leaves the draft 중단 사유 section unchanged', async () => {
    const childSummary = 'gate 실패: tsc 오류 2건';
    const abort = buildImplementAbortRecord(childSummary);
    const expectedSection = [
      '## 중단 사유',
      `- verdict: (예산 판정 미실행)`,
      `- reason: ${abort.reason}`,
      '- rework rounds: 0',
      '- reason truncated: false',
      `- child summary chars: ${childSummary.length}`,
      '- child summary artifact: /tmp/implement-abort-progress.block',
      '',
    ].join('\n');
    const progress: Array<{ stage: string; message: string }> = [];
    const observations: Record<string, unknown>[] = [];
    let body = '';
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'implement-abort-reason') observations.push(data ?? {});
    }) as never);
    try {
      const result = await runSelfImplement({
        feature: 'x',
        seams: okSeams({
          implement: async () => ({ ok: false, summary: childSummary }),
          preservationHasChanges: () => true,
          persistImplementAbortArtifact: () => ({ path: '/tmp/implement-abort-progress.block' }),
          openPr: async (input) => { body = input.body; return { url: 'https://pr/abort', number: 9 }; },
          onProgress: (event) => { progress.push(event); },
        }),
      });
      expect(result.stage).toBe('aborted');
      expect(result.ok).toBe(false);
      const aborted = progress.find((event) => event.stage === 'aborted');
      expect(aborted?.message).toBe(formatImplementAbortProgressLine(abort.reason));
      expect(aborted?.message).toBe(`중단 — 구현 실패: ${abort.reason}`);
      const sectionStart = body.indexOf('## 중단 사유');
      const sectionEnd = body.indexOf('\n## ', sectionStart + 1);
      expect(sectionStart).toBeGreaterThanOrEqual(0);
      expect(sectionEnd).toBeGreaterThan(sectionStart);
      expect(body.slice(sectionStart, sectionEnd)).toBe(expectedSection);
      // ⭐ 단위를 이름에 담는다(`R-CLM16`) — 「글자 수」와 UTF-16 코드 «단위»는 다르다.
      expect(observations).toContainEqual(expect.objectContaining({
        hasReason: true,
        reasonCodePoints: Array.from(abort.reason).length,
        reasonCodeUnits: abort.reason.length,
        toolCalls: null,
      }));
    } finally {
      log.mockRestore();
    }
  });

  it('zero toolCalls abort progress names the no-tool-call fact and records toolCalls 0', async () => {
    const childSummary = '무언가 실패';
    const progress: Array<{ stage: string; message: string }> = [];
    const observations: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'implement-abort-reason') observations.push(data ?? {});
    }) as never);
    try {
      const result = await runSelfImplement({
        feature: 'x',
        seams: okSeams({
          implement: async () => ({ ok: false, summary: childSummary, toolCalls: 0 }),
          onProgress: (event) => { progress.push(event); },
        }),
      });
      expect(result.stage).toBe('aborted');
      const aborted = progress.find((event) => event.stage === 'aborted');
      expect(aborted?.message).toBe(formatImplementAbortProgressLine(buildImplementAbortRecord(childSummary).reason, 0));
      expect(aborted?.message).toContain('자식이 도구를 한 번도 부르지 않았다');
      expect(aborted?.message).toContain('무언가 실패');
      expect(observations).toContainEqual(expect.objectContaining({ toolCalls: 0 }));
    } finally {
      log.mockRestore();
    }
  });

  it('positive toolCalls abort progress stays the legacy line and records the count', async () => {
    const childSummary = '무언가 실패';
    const abort = buildImplementAbortRecord(childSummary);
    const progress: Array<{ stage: string; message: string }> = [];
    const observations: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'implement-abort-reason') observations.push(data ?? {});
    }) as never);
    try {
      await runSelfImplement({
        feature: 'x',
        seams: okSeams({
          implement: async () => ({ ok: false, summary: childSummary, toolCalls: 3 }),
          onProgress: (event) => { progress.push(event); },
        }),
      });
      const aborted = progress.find((event) => event.stage === 'aborted');
      expect(aborted?.message).toBe(formatImplementAbortProgressLine(abort.reason));
      expect(aborted?.message).toBe(formatImplementAbortProgressLine(abort.reason, 3));
      expect(aborted?.message).not.toContain('자식이 도구를 한 번도 부르지 않았다');
      expect(observations).toContainEqual(expect.objectContaining({ toolCalls: 3 }));
    } finally {
      log.mockRestore();
    }
  });

  it('records rate-limited when the full child summary contains a provider rate-limit phrase', () => {
    const childSummary = 'Codex API error: 429 rate limit exceeded';
    const record = buildImplementAbortRecord(childSummary);
    expect(record.failureKind).toBe('rate-limited');
    expect(record.reason).toBe('implement aborted: Codex API error: 429 rate limit exceeded');
    expect(record.childSummary).toBe(childSummary);
    expect(record.reasonTruncated).toBe(false);
    expect(record.childSummaryChars).toBe(childSummary.length);
  });

  it('classifies a later rate-limit line even when the truncated reason keeps a success head', () => {
    const childSummary = [
      '구현 완료',
      'log: child started successfully',
      `progress: ${'x'.repeat(300)}`,
      'progress: writing files',
      '429 rate limit exceeded',
    ].join('\n');
    const record = buildImplementAbortRecord(childSummary);
    const expectedReason = boundReadableText(`implement aborted: ${childSummary.trim()}`, IMPLEMENT_ABORT_REASON_MAX_CHARS);
    expect(record.failureKind).toBe('rate-limited');
    expect(record.reason).toBe(expectedReason.text);
    expect(record.reasonTruncated).toBe(true);
    expect(record.reason.startsWith('implement aborted: 구현 완료')).toBe(true);
    expect(record.reason).not.toContain('429');
    expect(record.reason).not.toContain('rate limit');
    expect(record.childSummary).toBe(childSummary);
    expect(record.childSummary).toContain('429 rate limit exceeded');
  });

  it('keeps failureKind null for unknown failures and leaves other abort values unchanged', () => {
    const childSummary = '빌드 실패';
    const record = buildImplementAbortRecord(childSummary);
    expect(record.failureKind).toBeNull();
    expect(record.reason).toBe('implement aborted: 빌드 실패');
    expect(record.childSummary).toBe(childSummary);
    expect(record.reasonTruncated).toBe(false);
    expect(record.childSummaryChars).toBe(childSummary.length);
  });

  it('keeps the positional truncated reason character-identical for the same child output', () => {
    const childSummary = `구현 완료\n${'x'.repeat(400)}\n429 rate limit exceeded`;
    const record = buildImplementAbortRecord(childSummary);
    const expectedReason = boundReadableText(`implement aborted: ${childSummary.trim()}`, IMPLEMENT_ABORT_REASON_MAX_CHARS);
    expect(record.reason).toBe(expectedReason.text);
    expect(record.reasonTruncated).toBe(expectedReason.truncated);
    expect(record.childSummary).toBe(childSummary);
    expect(record.childSummaryChars).toBe(childSummary.length);
  });

  it('puts the same failureKind on the abort record and the post-abort observation', async () => {
    const childSummary = [
      '구현 완료',
      'log: child started successfully',
      `progress: ${'x'.repeat(300)}`,
      'progress: writing files',
      '429 rate limit exceeded',
    ].join('\n');
    const record = buildImplementAbortRecord(childSummary);
    const persisted: Array<Record<string, unknown>> = [];
    const observations: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'rework-blocked-draft-pr') observations.push(data ?? {});
    }) as never);
    try {
      const result = await runSelfImplement({
        feature: 'x',
        seams: okSeams({
          implement: async () => ({ ok: false, summary: childSummary }),
          preservationHasChanges: () => true,
          persistImplementAbortArtifact: (input) => {
            persisted.push(input);
            return { path: '/tmp/implement-abort-failure-kind.block' };
          },
        }),
      });
      expect(result.stage).toBe('aborted');
      expect(result.ok).toBe(false);
      expect(observations).toContainEqual(expect.objectContaining({
        stage: 'aborted',
        failureKind: record.failureKind,
        reason: record.reason,
        reasonTruncated: record.reasonTruncated,
        childSummaryChars: record.childSummaryChars,
        childSummaryArtifactPath: '/tmp/implement-abort-failure-kind.block',
      }));
      expect(observations[0]!.failureKind).toBe(record.failureKind);
      expect(record.failureKind).toBe('rate-limited');
      expect(persisted).toEqual([{
        origin: 'self-implement-abort',
        runId: result.runId,
        childSummary,
        childSummaryChars: childSummary.length,
        reason: record.reason,
        reasonTruncated: record.reasonTruncated,
        round: 0,
        stage: 'aborted',
      }]);
      expect(persisted[0]).not.toHaveProperty('failureKind');
    } finally {
      log.mockRestore();
    }
  });

  it('observes null failureKind for unknown failures without changing artifact metadata', async () => {
    const childSummary = '빌드 실패';
    const record = buildImplementAbortRecord(childSummary);
    const persisted: Array<Record<string, unknown>> = [];
    const observations: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'rework-blocked-draft-pr') observations.push(data ?? {});
    }) as never);
    try {
      const result = await runSelfImplement({
        feature: 'x',
        seams: okSeams({
          implement: async () => ({ ok: false, summary: childSummary }),
          preservationHasChanges: () => true,
          persistImplementAbortArtifact: (input) => {
            persisted.push(input);
            return { path: '/tmp/implement-abort-unknown-kind.block' };
          },
        }),
      });
      expect(record.failureKind).toBeNull();
      expect(observations).toContainEqual(expect.objectContaining({
        stage: 'aborted',
        failureKind: null,
        reason: 'implement aborted: 빌드 실패',
        reasonTruncated: false,
        childSummaryChars: childSummary.length,
        childSummaryArtifactPath: '/tmp/implement-abort-unknown-kind.block',
      }));
      expect(observations[0]!.failureKind).toBe(record.failureKind);
      expect(persisted).toEqual([{
        origin: 'self-implement-abort',
        runId: result.runId,
        childSummary,
        childSummaryChars: childSummary.length,
        reason: record.reason,
        reasonTruncated: false,
        round: 0,
        stage: 'aborted',
      }]);
    } finally {
      log.mockRestore();
    }
  });

  it('abandoned 구현 런을 세 기존 신호로 분류해 경고 관측에 남긴다', async () => {
    const observations: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'abandoned-classification') observations.push(data ?? {});
    }) as never);
    try {
      const result = await runSelfImplement({
        feature: 'x',
        seams: okSeams({
          inspectCodexRotation: (() => ({ reason: 'no-candidate', candidateCount: 0, knownAccountCount: 0 })) as SelfImplementSeams['inspectCodexRotation'],
          implement: async () => ({ ok: false, summary: '완료 보고가 사라짐', completionDisposition: 'completed-without-changes' }),
        }),
      });
      expect(result).toMatchObject({
        ok: false,
        stage: 'aborted',
        outcome: 'abandoned',
        completionDisposition: 'completed-without-changes',
      });
    } finally {
      log.mockRestore();
    }
    expect(observations).toEqual([
      expect.objectContaining({
        classification: 'report-deficit',
        worktreeClean: undefined,
        completionDisposition: 'completed-without-changes',
        mustFixReported: false,
      }),
    ]);
  });

  it('④ gate 실패 → gate-failed draft PR 보존', async () => {
    let draft: boolean | undefined;
    const r = await runSelfImplement({
      feature: 'x',
      seams: okSeams({
        gate: async () => ({ passed: false, log: '2 tests failed' }),
        openPr: async (input) => { draft = input.draft; return { url: '', number: 0 }; },
      }),
    });
    expect(r.stage).toBe('gate-failed');
    expect(draft).toBe(true);
    expect(r.gate?.passed).toBe(false);
  });

  it('⑤ approvePr seam 없음 → fail-closed(pr-declined·PR 미실행)', async () => {
    let prCalled = false;
    const seams = okSeams({ openPr: async () => { prCalled = true; return { url: '', number: 0 }; } });
    delete (seams as { approvePr?: unknown }).approvePr; // approver 제거 → 자동승인 금지
    const r = await runSelfImplement({ feature: 'x', seams });
    expect(r.stage).toBe('pr-declined');
    expect(prCalled).toBe(false);
    expect(r.detail).toContain('fail-closed');
  });

  it('⑤ HITL 미승인 → pr-declined (PR 미실행)', async () => {
    let prCalled = false;
    const r = await runSelfImplement({
      feature: 'x',
      seams: okSeams({
        approvePr: async () => false,
        openPr: async () => { prCalled = true; return { url: '', number: 0 }; },
      }),
    });
    expect(r.stage).toBe('pr-declined');
    expect(prCalled).toBe(false);
  });

  it('⑤ HITL 승인 → pr-opened', async () => {
    const r = await runSelfImplement({ feature: 'x', seams: okSeams({ approvePr: async () => true }) });
    expect(r.stage).toBe('pr-opened');
    expect(r.ok).toBe(true);
  });

  it('parentSessionId + forkSession → 포크 세션이 implement 에 전달', async () => {
    let implSessionId: string | undefined = 'unset';
    const r = await runSelfImplement({
      feature: 'x', parentSessionId: 'parent-1',
      seams: okSeams({
        forkSession: async (p) => `fork-of-${p}`,
        implement: async ({ sessionId }) => { implSessionId = sessionId; return { ok: true, summary: 's' }; },
      }),
    });
    expect(r.sessionId).toBe('fork-of-parent-1');
    expect(implSessionId).toBe('fork-of-parent-1');
    expect(r.stage).toBe('pr-opened');
  });

  it('fork seam 없으면 fork 없이 진행(sessionId undefined)', async () => {
    const r = await runSelfImplement({ feature: 'x', parentSessionId: 'p', seams: okSeams() });
    expect(r.sessionId).toBeUndefined();
    expect(r.stage).toBe('pr-opened');
  });

  it('worktree 관측은 요청 base·해소된 시작 SHA·호출 트리 HEAD와 차이를 함께 기록한다', async () => {
    const worktrees: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'worktree') worktrees.push(data ?? {});
    }) as never);
    try {
      await runSelfImplement({
        feature: 'explicit base',
        base: 'feature/base',
        seams: okSeams({
          createWorktree: async ({ branch, base }) => ({ path: `/tmp/wt/${branch}`, branch, base, resolvedBase: 'a'.repeat(40), invokedHead: 'b'.repeat(40) }),
        }),
      });
      await runSelfImplement({
        feature: 'default base',
        seams: okSeams({
          createWorktree: async ({ branch, base }) => ({ path: `/tmp/wt/${branch}`, branch, base, resolvedBase: 'c'.repeat(40), invokedHead: 'c'.repeat(40) }),
        }),
      });
    } finally {
      log.mockRestore();
    }
    expect(worktrees).toContainEqual(expect.objectContaining({
      requestedBase: 'feature/base',
      resolvedBase: 'a'.repeat(40),
      invokedHead: 'b'.repeat(40),
      invokedHeadDiffers: true,
    }));
    expect(worktrees).toContainEqual(expect.objectContaining({
      requestedBase: null,
      resolvedBase: 'c'.repeat(40),
      invokedHead: 'c'.repeat(40),
      invokedHeadDiffers: false,
    }));
  });

  it('draft 기본 true, base/branchName 전달', async () => {
    let seen: { draft?: boolean; base?: string; head?: string } = {};
    await runSelfImplement({
      feature: 'x', base: 'develop', branchName: 'feat/custom',
      seams: okSeams({ openPr: async (o) => { seen = o; return { url: 'u', number: 2 }; } }),
    });
    expect(seen.draft).toBe(true);
    expect(seen.base).toBe('develop');
    expect(seen.head).toBe('feat/custom');
  });

  it('auto-review 거절 사유를 PR 본문과 구조화 관측으로 노출한다', async () => {
    let body = '';
    const decisions: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'declined') decisions.push(data ?? {});
    }) as never);
    try {
      await runSelfImplement({
        feature: 'production code로 배포한다', autoReview: true,
        seams: okSeams({ openPr: async (opts) => { body = opts.body; return { url: 'u', number: 2 }; } }),
      });
    } finally {
      log.mockRestore();
    }
    expect(body).toContain('## Auto-review label not applied');
    expect(body).toContain('위험 신호: 외부 배포/운영 반영');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.eligible).toBe(false);
    expect(decisions[0]?.riskHits).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: '외부 배포/운영 반영' }),
    ]));
    expect(decisions[0]?.suppressedRiskHits).toEqual([]);
  });

  it('auto-review 관측은 억제된 hit을 부재와 구별한다', async () => {
    const decisions: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'eligible') decisions.push(data ?? {});
    }) as never);
    try {
      await runSelfImplement({ feature: 'do not deploy this module', autoReview: true, seams: okSeams() });
    } finally {
      log.mockRestore();
    }
    expect(decisions).toContainEqual(expect.objectContaining({
      eligible: true,
      riskHits: [],
      suppressedRiskHits: [expect.objectContaining({ reason: '외부 배포/운영 반영' })],
    }));
  });

  it('slugifyFeature — 비ASCII만이면 fallback', () => {
    // ⭐ #6268(RUN-S1) 이후 sha256 8자 접미가 붙는다. 값이 아니라 형태를 단언한다.
    expect(slugifyFeature('Add Foo Bar')).toMatch(/^add-foo-bar-[0-9a-f]{8}$/);
    expect(slugifyFeature('한국어 기능')).toMatch(/^feature-[0-9a-f]{8}$/);
  });

  it.each(['pass', 'warn'] as const)('완전한 %s 리뷰는 auto-merge를 유지한다', async (verdict) => {
    let merged = false;
    let approved = false;
    const r = await runSelfImplement({
      feature: 'x', autoMerge: true,
      seams: okSeams({
        reviewDiff: async () => ({ verdict, mustFix: [], shouldFix: [], summary: 'review', reviewed: true, diffTruncated: false, diffShownChars: 100, diffTotalChars: 100, diffOmittedFiles: 0 }),
        readPrDiff: async () => 'diff --git a/src/x.ts b/src/x.ts\n',
        readPrCommitShas: async () => ({ baseCommit: 'base-sha', headCommit: 'checked-head-sha' }),
        approvePr: async () => { approved = true; return true; },
        mergePr: async () => { merged = true; return { merged: true }; },
      }),
    });
    expect(r.stage).toBe('merged');
    expect(merged).toBe(true);
    expect(approved).toBe(false);
  });

  it.each(['pass', 'warn'] as const)('잘린 %s 리뷰는 HITL로 보내고 자동 병합하지 않는다', async (verdict) => {
    let merged = false;
    let approved = false;
    const decisions: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'merge-decision') decisions.push(data ?? {});
    }) as never);
    try {
      const r = await runSelfImplement({
        feature: 'x', autoMerge: true,
        seams: okSeams({
          reviewDiff: async () => ({ verdict, mustFix: [], shouldFix: [], summary: 'review', reviewed: true, diffTruncated: true, diffShownChars: 23_394, diffTotalChars: 45_225, diffOmittedFiles: 0 }),
          approvePr: async () => { approved = true; return true; },
          mergePr: async () => { merged = true; return { merged: true }; },
        }),
      });
      expect(r.stage).toBe('pr-opened');
    } finally {
      log.mockRestore();
    }
    expect(approved).toBe(true);
    expect(merged).toBe(false);
    expect(decisions).toContainEqual(expect.objectContaining({
      decision: 'hitl', reason: 'review-diff-truncated',
      diffTruncated: true, diffShownChars: 23_394, diffTotalChars: 45_225, diffOmittedFiles: 0,
    }));
  });

  it.each([false, true])('fail verdict은 diffTruncated=%s여도 종전대로 HITL이다', async (diffTruncated) => {
    let merged = false;
    let approved = false;
    const r = await runSelfImplement({
      feature: 'x', autoMerge: true,
      seams: okSeams({
        reviewDiff: async () => ({ verdict: 'fail', mustFix: [], shouldFix: [], summary: 'review', reviewed: true, diffTruncated, diffShownChars: diffTruncated ? 60 : 100, diffTotalChars: 100, diffOmittedFiles: 0 }),
        approvePr: async () => { approved = true; return true; },
        mergePr: async () => { merged = true; return { merged: true }; },
      }),
    });
    expect(r.stage).toBe('pr-opened');
    expect(approved).toBe(true);
    expect(merged).toBe(false);
  });

  it('예산 없는 실제 리뷰는 완전하다고 가정하지 않고 HITL로 보낸다', async () => {
    let merged = false;
    const decisions: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'merge-decision') decisions.push(data ?? {});
    }) as never);
    try {
      const r = await runSelfImplement({
        feature: 'x', autoMerge: true,
        seams: okSeams({
          reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'review', reviewed: true }),
          approvePr: async () => true,
          mergePr: async () => { merged = true; return { merged: true }; },
        }),
      });
      expect(r.stage).toBe('pr-opened');
    } finally {
      log.mockRestore();
    }
    expect(merged).toBe(false);
    expect(decisions).toContainEqual(expect.objectContaining({ decision: 'hitl', reason: 'review-diff-budget-unknown' }));
  });

  it.each(['no-diff', 'review-not-run'] as const)('%s 예산 부재는 자동 병합 근거가 아니다', async (mode) => {
    let merged = false;
    const seams = okSeams({
      approvePr: async () => true,
      mergePr: async () => { merged = true; return { merged: true }; },
      ...(mode === 'no-diff' ? {
        reviewDiff: async () => ({ verdict: 'pass' as const, mustFix: [], shouldFix: [], summary: 'no diff', reviewed: false }),
      } : {}),
    });
    if (mode === 'review-not-run') delete (seams as { reviewDiff?: unknown }).reviewDiff;
    const r = await runSelfImplement({ feature: 'x', autoMerge: true, seams });
    expect(r.stage).toBe('pr-opened');
    expect(merged).toBe(false);
  });

  it('23개의 요구 증거 중 0개면 pass 리뷰도 HITL로 내려 자동 병합하지 않는다', async () => {
    const decisions: Record<string, unknown>[] = [];
    let merged = false;
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'merge-decision') decisions.push(data ?? {});
    }) as never);
    try {
      const required = Array.from({ length: 23 }, (_, index) => `- [criterion-${index + 1}] required evidence ${index + 1}`).join('\n');
      const result = await runSelfImplement({
        feature: `evidence gate\n## REQUIRED EVIDENCE\n${required}\n## ACCEPTANCE CRITERIA`,
        autoMerge: true,
        seams: okSeams({
          implement: async () => ({ ok: true, summary: 'implemented without required evidence' }),
          reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'review pass', reviewed: true, diffTruncated: false }),
          approvePr: async () => true,
          mergePr: async () => { merged = true; return { merged: true }; },
        }),
      });
      expect(result.stage).toBe('pr-opened');
    } finally {
      log.mockRestore();
    }
    expect(merged).toBe(false);
    expect(decisions).toContainEqual(expect.objectContaining({
      verdict: 'pass', decision: 'hitl', reason: 'required-evidence-uncovered',
      requiredEvidence: 23, coveredEvidence: 0,
    }));
  });
});

describe('runSelfImplement — cross-run review context', () => {
  it('carries base PR applied items into round-zero review exactly once', async () => {
    let calls = 0;
    const contexts: Array<{ round?: number; appliedLastRound?: readonly string[] } | undefined> = [];
    const result = await runSelfImplement({
      feature: 'x', base: 'feature/existing',
      seams: okSeams({
        findAppliedReviewItems: async (branch) => { calls += 1; expect(branch).toBe('feature/existing'); return { basePrLocated: true, items: ['preserve prior rule'], headlineComments: 1 }; },
        reviewDiff: async (_cwd, context) => { contexts.push(context); return { verdict: 'pass', mustFix: [], shouldFix: [], summary: 'ok', reviewed: true }; },
      }),
    });
    expect(result.stage).toBe('pr-opened');
    expect(calls).toBe(1);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.round).toBe(0);
    expect(contexts[0]?.appliedLastRound).toEqual(['preserve prior rule']);
  });

  it('inside-run must-fix replaces carried context after round zero', async () => {
    const contexts: Array<{ round?: number; appliedLastRound?: readonly string[] } | undefined> = [];
    let reviewCall = 0;
    const result = await runSelfImplement({
      feature: 'x', base: 'feature/existing', maxReworkRounds: 1,
      seams: okSeams({
        findAppliedReviewItems: async () => ({ basePrLocated: true, items: ['cross-run item'], headlineComments: 1 }),
        reviewDiff: async (_cwd, context) => {
          contexts.push(context);
          reviewCall += 1;
          return reviewCall === 1
            ? { verdict: 'fail', mustFix: ['inside-run item'], shouldFix: [], summary: 'fix', reviewed: true }
            : { verdict: 'pass', mustFix: [], shouldFix: [], summary: 'ok', reviewed: true };
        },
      }),
    });
    expect(result.stage).toBe('pr-opened');
    expect(contexts.length).toBe(2);
    expect(contexts[0]?.round).toBe(0);
    expect(contexts[0]?.appliedLastRound?.join('\n')).toBe('cross-run item');
    expect(contexts[1]?.round).toBe(1);
    expect(contexts[1]?.appliedLastRound?.join('\n')).toBe('inside-run item');
  });

  it.each([
    ['default-branch sentinel', DEFAULT_BRANCH_WORKTREE_BASE, async () => ({ basePrLocated: false, items: [] as string[], headlineComments: 0 }), 'default-branch-sentinel'],
    ['missing base PR', 'feature/missing', async () => ({ basePrLocated: false, items: [] as string[], headlineComments: 0 }), 'base-pr-not-found'],
    ['lookup failure', 'feature/unavailable', async () => { throw new Error('gh unavailable'); }, 'lookup-failed'],
  ] as const)('observes %s as a distinct carried-context reason', async (_caseName, base, findAppliedReviewItems, reason) => {
    const observations: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'review-context-carried') observations.push(data ?? {});
    }) as never);
    let context: { appliedLastRound?: readonly string[] } | undefined;
    try {
      const result = await runSelfImplement({
        feature: 'x', base,
        seams: okSeams({
          findAppliedReviewItems,
          reviewDiff: async (_cwd, seen) => { context = seen; return { verdict: 'pass', mustFix: [], shouldFix: [], summary: 'ok', reviewed: true }; },
        }),
      });
      expect(result.stage).toBe('pr-opened');
    } finally {
      log.mockRestore();
    }
    expect(context?.appliedLastRound).toBeUndefined();
    expect(observations).toContainEqual(expect.objectContaining({ base, basePrLocated: false, carriedItems: 0, reason }));
  });

  it('omits the carried-context reason when the base PR is located', async () => {
    const observations: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'review-context-carried') observations.push(data ?? {});
    }) as never);
    try {
      const result = await runSelfImplement({
        feature: 'x', base: 'feature/existing',
        seams: okSeams({
          findAppliedReviewItems: async () => ({ basePrLocated: true, items: ['preserve prior rule'], headlineComments: 1 }),
        }),
      });
      expect(result.stage).toBe('pr-opened');
    } finally {
      log.mockRestore();
    }
    expect(observations).toContainEqual(expect.objectContaining({ base: 'feature/existing', basePrLocated: true, carriedItems: 1 }));
    expect(observations[0]).not.toHaveProperty('reason');
  });
});


describe('runSelfImplement — diagnose review-finding telemetry', () => {
  it('passes accumulated cited, normalized, and symbol-count evidence to the optional diagnose seam', async () => {
    const diagnoses: Array<Parameters<NonNullable<SelfImplementSeams['diagnose']>>[0]> = [];
    let reviewCalls = 0;
    let diagnoseSettled = 0;
    const result = await runSelfImplement({
      feature: 'x', maxReworkRounds: 1,
      seams: okSeams({
        reviewDiff: async () => {
          reviewCalls += 1;
          return reviewCalls === 1
            ? { verdict: 'fail', mustFix: ['`exampleSymbol`: repeated finding'], shouldFix: [], summary: 'fix', reviewed: true }
            : { verdict: 'fail', mustFix: ['`exampleSymbol`: repeated finding'], shouldFix: [], summary: 'fix again', reviewed: true };
        },
        diagnose: async (ctx) => {
          diagnoses.push(ctx);
          diagnoseSettled += 1;
          return diagnoses.length === 1
            ? 'BUDGET: EXTEND\nREASON: gather the next review telemetry'
            : 'BUDGET: UNCONVERGEABLE\nREASON: repeated';
        },
        decomposeShadowGoals: async () => ({
          goals: [],
          decomposition: { recommendedMaxTasks: 6, actualTaskCount: 0, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'single-no-subtasks' },
        }),
      }),
      reworkBudgetShadowStop: false,
    });
    expect(diagnoseSettled).toBe(2);
    expect(result).toMatchObject({ ok: false, stage: 'review-blocked', outcome: 'abandoned' });
    expect(diagnoses).toContainEqual(expect.objectContaining({
      reviewFindingTelemetry: expect.objectContaining({
        symbolKeyedReviewFindingCount: 2,
        citedReviewSymbolOccurrences: [expect.objectContaining({ symbol: 'exampleSymbol', firstSeenRound: 0, lastSeenRound: 1, occurrence: 1 })],
        normalizedReviewFindingRepeatCounts: [expect.objectContaining({ firstSeenRound: 0, repeatedAtRound: 1, occurrence: 1 })],
      }),
    }));
  }, 10_000);
});

describe('runSelfImplement — supervision vocabulary observation', () => {
  async function observeRework(kind: 'gate' | 'review', verdict: 'EXTEND' | 'SUFFICIENT' | 'UNCONVERGEABLE'): Promise<Record<string, unknown>[]> {
    const observations: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'rework-budget') observations.push(data ?? {});
    }) as never);
    const closedDiagnose = async () => `BUDGET: ${verdict}\nREASON: test`;
    const closedDecompose: NonNullable<SelfImplementSeams['decomposeShadowGoals']> = async () => ({
      goals: [],
      decomposition: { recommendedMaxTasks: 6, actualTaskCount: 0, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'single-no-subtasks' },
    });
    try {
      if (kind === 'gate') {
        await runSelfImplement({
          feature: 'x', maxReworkRounds: 1,
          seams: okSeams({
            gate: async () => ({ passed: false, log: '1 fail' }),
            diagnose: closedDiagnose,
            decomposeShadowGoals: closedDecompose,
          }),
        });
      } else {
        let reviewCalls = 0;
        await runSelfImplement({
          feature: 'x', maxReworkRounds: 1,
          seams: okSeams({
            reviewDiff: async () => {
              reviewCalls += 1;
              return verdict === 'UNCONVERGEABLE' || reviewCalls === 1
                ? { verdict: 'fail', mustFix: ['fix'], shouldFix: [], summary: 'fix', reviewed: true }
                : { verdict: 'pass', mustFix: [], shouldFix: [], summary: 'ok', reviewed: true };
            },
            diagnose: closedDiagnose,
            decomposeShadowGoals: closedDecompose,
          }),
          reworkBudgetShadowStop: false,
        });
      }
      return observations;
    } finally {
      log.mockRestore();
    }
  }

  it.each([
    ['EXTEND', 'gate', 'continue', false, 'continue'],
    ['SUFFICIENT', 'gate', 'continue', false, 'continue'],
    ['SUFFICIENT', 'review', 'complete', true, 'proceed'],
    ['UNCONVERGEABLE', 'review', 'abandon', true, 'blocked'],
  ] as const)('%s/%s maps the contract verdict to the executed stop/exit outcome', async (classification, kind, supervisionVerdict, stopped, exit) => {
    expect(await observeRework(kind, classification)).toContainEqual(expect.objectContaining({
      verdict: classification,
      kind,
      supervisionVerdict,
      stopped,
      exit,
    }));
  }, 10_000);
});

describe('runSelfImplement — terminal outcome observation', () => {
  it('clears an earlier EXTEND when the current round has no structured verdict', async () => {
    let diagnoses = 0;
    const result = await runSelfImplement({
      feature: 'x', maxReworkRounds: 0,
      seams: okSeams({
        gate: async () => ({ passed: false, log: 'still failing' }),
        diagnose: async () => ++diagnoses === 1 ? 'BUDGET: EXTEND\nREASON: one more round' : 'unstructured diagnosis',
        judgmentCallLLM: async () => diagnoses === 1 ? 'EXTEND' : 'SUFFICIENT',
      }),
    });
    expect(result).toMatchObject({ ok: false, stage: 'gate-failed', outcome: 'budget-exhausted' });
    expect(result).not.toHaveProperty('supervisorWantedContinue');
  });

  it('records a warning and continuation disagreement when the hard cap voids EXTEND', async () => {
    const warnings: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'rework-budget-warning') warnings.push(data ?? {});
    }) as never);
    try {
      const result = await runSelfImplement({
        feature: 'x', maxReworkRounds: 5,
        seams: okSeams({
          gate: async () => ({ passed: false, log: 'still failing' }),
          diagnose: async () => 'BUDGET: EXTEND\nREASON: one more round',
        }),
      });
      expect(result).toMatchObject({ ok: false, stage: 'gate-failed', outcome: 'budget-exhausted', supervisorWantedContinue: true });
    } finally {
      log.mockRestore();
    }
    const hardCap = getUserConfig().tools.selfImplement.reworkBudget.maxRounds;
    expect(warnings).toContainEqual(expect.objectContaining({
      hardCap,
      verdict: 'EXTEND',
      message: `⚠️ 감독이 EXTEND 를 냈으나 하드 상한(${hardCap})에 막혀 예산이 늘지 않았다.`,
    }));
  });

  it('keeps completed output free of supervisor continuation state', async () => {
    const completed = await runSelfImplement({ feature: 'x', seams: okSeams() });
    expect(completed).toMatchObject({ ok: true, outcome: 'completed' });
    expect(completed).not.toHaveProperty('supervisorWantedContinue');
  });

  it('observes the declared pipeline shape without changing the returned result', async () => {
    const shadows: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'pipeline-shape-shadow') shadows.push(data ?? {});
    }) as never);
    try {
      const result = await runSelfImplement({
        feature: 'x',
        seams: okSeams({ gate: async () => ({ passed: false, log: 'gate failure' }) }),
      });
      expect(result).toMatchObject({ ok: false, stage: 'gate-failed' });
    } finally {
      log.mockRestore();
    }
    expect(shadows).toContainEqual(expect.objectContaining({
      stage: 'gate-failed',
      nodes: ['rework', 'regate'],
      ambiguous: true,
      declared: true,
    }));
  });
});

describe('runSelfImplement — traversal shadow observation', () => {
  it('공용 test seam이 해석 대상과 병합 seam을 제공해 정합 경로에 직접 도달한다', async () => {
    const mergeTargets: string[] = [];
    const result = await runSelfImplement({
      feature: 'shared seam main sync',
      seams: sharedTestSeams({
        commitWork: () => {},
        mergeMain: async (_worktreePath, mergeTarget) => {
          mergeTargets.push(mergeTarget);
          return { status: 'up-to-date' };
        },
      }),
    });
    expect(result).toMatchObject({ ok: true, stage: 'pr-opened' });
    expect(mergeTargets).toEqual(['origin/main']);
  });

  it('wires entry observations for every declared node across reachable seam scenarios', async () => {
    const entries = new Set<PipelineNodeId>();
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'pipeline-node-entry') entries.add(data?.node as PipelineNodeId);
    }) as never);
    try {
      let gates = 0;
      await runSelfImplement({ feature: 'rework', maxReworkRounds: 1, seams: okSeams({ gate: async () => ({ passed: ++gates > 1 }) }) });
      await runSelfImplement({
        feature: 'regate', base: 'origin/se/base',
        seams: okSeams({ commitWork: () => {}, mergeMain: async () => ({ status: 'llm-resolved' }) }),
      });
      await runSelfImplement({
        feature: 'typecheck', base: 'origin/se/base',
        seams: okSeams({ commitWork: () => {}, mergeMain: async () => ({ status: 'merged' }) }),
      });
      await runSelfImplement({
        feature: 'merge', autoMerge: true,
        seams: okSeams({
          reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'ok', reviewed: true, diffTruncated: false }),
          readPrDiff: async () => 'diff --git a/src/x.ts b/src/x.ts\n',
          readPrCommitShas: async () => ({ baseCommit: 'base-sha', headCommit: 'checked-head-sha' }),
          mergePr: async () => ({ merged: true }),
        }),
      });
    } finally {
      log.mockRestore();
    }
    const expected = new Set(Object.keys(PIPELINE_EDGES_BY_NODE) as PipelineNodeId[]);
    expect(entries).toEqual(expected);
  });

  it('observes the traversal classification and preserves the result when checking fails', async () => {
    const shadows: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'pipeline-traversal-shadow') shadows.push(data ?? {});
    }) as never);
    let ordinary: Awaited<ReturnType<typeof runSelfImplement>>;
    let failedCheck: Awaited<ReturnType<typeof runSelfImplement>>;
    try {
      ordinary = await runSelfImplement({ feature: 'same', runId: 'run-same', seams: okSeams() });
      failedCheck = await runSelfImplement({
        feature: 'same', runId: 'run-same',
        seams: okSeams({ checkPipelineTraversal: () => { throw new Error('shadow unavailable'); } }),
      });
    } finally {
      log.mockRestore();
    }
    expect(failedCheck!).toEqual(ordinary!);
    expect(shadows).toContainEqual(expect.objectContaining({
      classification: 'legal-terminal-match', observedNodes: ['implement', 'gate', 'open-pr'], terminalNode: 'open-pr',
    }));
    expect(shadows).toContainEqual(expect.objectContaining({
      classification: 'unclassifiable', terminalNode: 'open-pr', error: 'shadow unavailable',
    }));
  });
});

describe('runSelfImplement — in-round judge context forwarding', () => {
  it('passes existing rework values only to the rework implement call', async () => {
    const contexts: Array<Record<string, unknown> | undefined> = [];
    let gateCalls = 0;
    const result = await runSelfImplement({
      feature: 'preserve original goal', maxReworkRounds: 1,
      seams: okSeams({
        implement: async (ctx) => { contexts.push(ctx.roundContext); return { ok: true, summary: 'done' }; },
        gate: async () => ({ passed: ++gateCalls > 1, log: 'gate failure note' }),
      }),
    });
    expect(result.stage).toBe('pr-opened');
    expect(contexts).toEqual([
      undefined,
      { round: 1, effectiveMax: 1, previousRoundFailure: '[gate 실패]\ngate failure note' },
    ]);
  });
});

describe('runSelfImplement — PR title via openPr seam', () => {
  it('opens with the first markdown H1 when no prose title exists', async () => {
    let title = '';
    await runSelfImplement({
      feature: '# 관측 축을 하나 더 싣는다\nsrc/a/b.ts, src/a/c.ts',
      seams: okSeams({
        openPr: async (input) => {
          title = input.title;
          return { url: 'https://pr/h1', number: 3 };
        },
      }),
    });
    expect(title).toBe('관측 축을 하나 더 싣는다');
  });

  it('keeps the prose title ahead of a markdown H1 through openPr', async () => {
    let title = '';
    await runSelfImplement({
      feature: '대상 경로: src/a/b.ts\n제목: 진짜 제목\n# 다른 제목',
      seams: okSeams({
        openPr: async (input) => {
          title = input.title;
          return { url: 'https://pr/prose', number: 4 };
        },
      }),
    });
    expect(title).toBe('진짜 제목');
  });

  it('assembles first-line paths when neither a prose title nor an H1 exists', async () => {
    let title = '';
    await runSelfImplement({
      feature: 'src/a/b.ts, src/a/c.ts',
      seams: okSeams({
        openPr: async (input) => {
          title = input.title;
          return { url: 'https://pr/paths', number: 5 };
        },
      }),
    });
    expect(title).toBe('src/a: b.ts, c.ts');
  });
});
