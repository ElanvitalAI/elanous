// runSelfImplement — Fix A rework 루프(gate 실패 시 clean 에러 재주입 self-heal) 테스트

import { afterAll, afterEach, beforeAll, beforeEach, describe, test, expect } from 'bun:test';
import { buildReviewIntent } from '../agent-substrate/review-intent.js';
import { REVIEW_FINDING_KEY_VERSION, reviewFindingKey as sharedReviewFindingKey } from '../agent-substrate/review-finding-key.js';
import { parse as parsePrComment } from '../agent-substrate/pr-comment-meta.js';
import type { ReviewArtifactInput } from '../agent-substrate/review-artifact.js';
import { MAX_OFF_DIFF_EVIDENCE_RESULT_CHARS } from './off-diff-evidence.js';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { defaultSeams, preservationHasChanges, parseBehindCount, removeMatchingGoalCopy, toReviewIntentInput } from './seams.js';
import { runSelfImplementCliCommand } from './self-implement-cli.js';
import { GoalRunStore } from './goal-run-store.js';
import { appendRunLedgerEntry, runLedgerPath } from './run-ledger.js';
import { compactForLog, debug } from '../debug/log.js';
import { LogStore } from '../mss/logging/log-store.js';
import { instanceNameForStateDir } from '../instance-identity.js';
import { getAskUserQuestionResolver, setAskUserQuestionResolver } from '../ask-user-question/tool.js';
import { setUserConfigOverlay } from '../user-config.js';
import { createSession, subscribeSession } from '../session/index.js';
import { DEFAULT_STEP_TIMEOUTS, collectRunFacts, completionIntentOf, federationObservation, GATE_TIMEOUT_UNMEASURED_MERGE_REASON, mainSyncObservation, postSyncGateObservation, appendGoalExecutionRecord, assembleBlockedDraftPrBody, BLOCKED_DRAFT_UNCLASSIFIED_CLASSIFICATION, blockedDraftClassificationRecord, formatBlockedDraftClassificationSection, assessQuotaExhaustion, attachAbandonedClassification, boundReadableText, buildImplementAbortRecord, buildRefutationGuidance, citedReviewSymbols, clarificationResolverSkipHint, countDocsMarkdownDeletions, DECLARED_SCOPE_OUTSIDE_NAME_CAP, DECOMPOSITION_FALLBACK_PATHS_OBSERVATION_LIMIT, decompositionFallbackObservation, declaredScopeUnmadeLine, detectDeclaredScopeDiff, decideGateFailureDisposition, extractSupervisorReason, formatImplementAbortProgressLine, incrementRunAttemptOrdinal, inferDecompositionShadow, GITHUB_PR_BODY_MAX_CHARS, IMPLEMENT_ABORT_REASON_MAX_CHARS, isShardSiblingLookupEligible, loopTtlMin, makeRunObserver, MAX_TRACKED_RUN_ATTEMPT_ORDINALS, normalizeReviewFindingKey, observeRunOutcome, persistImplementAbortChildSummary, queryStructuredChildProviderErrors, readRunAttemptOrdinal, repeatedBlockingFindingIds, resolveDecisionSignalPress, reworkBudgetRecurrenceDisagreementObservation, reviewFindingKey, reviewerCanSelfReadObservation, prTitle, runSelfImplement, RUN_START_FEATURE_MAX_CHARS, shortNormalizedReviewFindingHash, slugifyFeature, SUPERVISOR_REASON_RECORD_MAX_CHARS, UNMEASURED_ATTEMPT_ORDINAL, withStepTimeout, withRefreshedRunFacts, StepTimeoutError, MAX_CITED_REVIEW_SYMBOL_CHARS, MAX_CITED_REVIEW_SYMBOLS_PER_RUN, MAX_DIFF_EVIDENCE_CHARS, type GoalExecutionRecord, type ReviewDiffContext, type SelfImplementReview, type SelfImplementSeams, quotaSignalAppliesTo } from './orchestrator.js';
import { classifyAbandonedRun } from './abandoned-classification.js';
import { stableMustFixId } from './reflect-mustfix.js';
import { WORKTREE_BRANCH_PREFIX, plannedSelfImplBranch } from '../harness/worktree-branch-prefix.js';
import { branchGoalId } from '../cli/pr-lineage.js';
import { parseGoalType } from './goal-author.js';
import type { DocumentReferenceStatus } from './self-implement-runtime.js';
import { DEV_PIPELINE_SINK_SURFACE } from './self-cli-sink-surface.js';
import { PIPELINE_EDGES_BY_NODE, PIPELINE_GRAPH_ID, TERMINAL_STAGES_BY_NODE, pipelineGraphIdentity, pipelineGraphVersion, type PipelineNodeId } from './pipeline-shape.js';

const isolatedStateDir = mkdtempSync(join(tmpdir(), 'elanous-orchestrator-goal-run-store-'));
const priorStateDir = process.env.ELANOUS_STATE_DIR;

beforeAll(() => {
  process.env.ELANOUS_STATE_DIR = isolatedStateDir;
});

afterAll(() => {
  if (priorStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = priorStateDir;
  rmSync(isolatedStateDir, { recursive: true, force: true });
});

import { seams as baseSeams } from './test-seams.js';
const seams = (over: Parameters<typeof baseSeams>[0]): SelfImplementSeams => baseSeams({
  inspectCodexRotation: (() => ({ reason: 'no-candidate', candidateCount: 0, knownAccountCount: 0 })) as SelfImplementSeams['inspectCodexRotation'],
  ...over,
});
import type { DecisionSignalPressResult } from './decision-signal-press.js';
import type { SoftStopRequestRead } from '../harness/control-inbox.js';

// 이 파일의 재작업 기계 시험은 «예산 기본값»이 아니라 «기계»를 잰다 — 2026-09-24 대표 결정으로 기본값이
//   { shadowStop:false, maxRounds:3 } 이 됐으므로, 옛 기본(판정만 기록 · 상한 6)을 여기서 고정한다.
//   기본값 자체는 test/user-config-self-implement-auto-open-pr.test.ts 가 잰다. 자기 오버레이를 거는 시험은 그 값이 이긴다.
const PINNED_REWORK_BUDGET = { shadowStop: true, maxRounds: 6 } as const;
const REVIEW_GOAL_TEXT = '# Goal\n- GoalId: ee1733e0ae11fea7\n\n## PROBLEM\nA reproducible review fixture.\n\n## ACCEPTANCE CRITERIA\n- Preserve the review result.\n';
const REVIEW_GOAL_DIRECTORY = mkdtempSync(join(tmpdir(), 'elanous-review-goal-fixture-'));
const REVIEW_GOAL_FILE = join(REVIEW_GOAL_DIRECTORY, 'GOAL-review.txt');
const PRIVATE_REVIEW_GOAL = 'docs/goals/GOAL-atomic-backlink-updates-prevent-stuck-inheritance-6a9a7f40-2026-07-31.txt';
const reviewGoalFile = () => existsSync(PRIVATE_REVIEW_GOAL) ? PRIVATE_REVIEW_GOAL : REVIEW_GOAL_FILE;
const PRIVATE_BUDGET_GOAL = 'docs/goals/GOAL-base-expose-base-red-status-after-child-test-fixes-827c21cc-2026-07-31.txt';
const budgetGoalFile = () => existsSync(PRIVATE_BUDGET_GOAL) ? PRIVATE_BUDGET_GOAL : REVIEW_GOAL_FILE;
beforeAll(() => { writeFileSync(REVIEW_GOAL_FILE, REVIEW_GOAL_TEXT); });
afterAll(() => { rmSync(REVIEW_GOAL_DIRECTORY, { recursive: true, force: true }); });
beforeEach(() => {
  setUserConfigOverlay((config) => ({
    ...config,
    tools: { ...config.tools, selfImplement: { ...config.tools.selfImplement, reworkBudget: { ...PINNED_REWORK_BUDGET } } },
  }));
});
afterEach(() => { setUserConfigOverlay(null); });

describe('run-origin ledger attribution', () => {
  test('each run writes exactly one run-origin with host metadata via the ledger seam', async () => {
    const before = process.env.ELANOUS_HOST_ID;
    const substrate = process.env.ELANOUS_SUBSTRATE;
    const optionalKeys = ['ELANOUS_POD_NAME', 'ELANOUS_NODE_NAME', 'ELANOUS_POD_NAMESPACE', 'ELANOUS_IMAGE_COMMIT'] as const;
    const previousOptional = optionalKeys.map((key) => process.env[key]);
    process.env.ELANOUS_HOST_ID = '01HOSTTEST';
    delete process.env.ELANOUS_SUBSTRATE;
    process.env.ELANOUS_POD_NAME = 'pod-a';
    process.env.ELANOUS_NODE_NAME = 'node-b';
    process.env.ELANOUS_POD_NAMESPACE = 'namespace-c';
    process.env.ELANOUS_IMAGE_COMMIT = 'commit-d';
    // 🩸 2026-09-25 공개본 시험 대조: 앞 시험 파일이 남긴 `ELANOUS_RUN_ID` 를 두 런이 «물려받아» 같은 runId 가 됐다
    //    (`ensureRunIdentity` 는 env 에 있으면 재발급하지 않는다 — 계약이다). ⇒ 런마다 비우고 끝나면 되돌린다.
    const runIdBefore = process.env.ELANOUS_RUN_ID;
    try {
      const ledgers: Array<Array<import('./run-ledger.js').RunLedgerEntry>> = [];
      for (let index = 0; index < 2; index++) {
        const entries: Array<import('./run-ledger.js').RunLedgerEntry> = [];
        ledgers.push(entries);
        delete process.env.ELANOUS_RUN_ID;
        await runSelfImplement({
          feature: `origin fixture ${index}`, observeOnly: true,
          seams: seams({ writeRunLedger: (entry) => entries.push(entry) }),
        });
      }
      for (const entries of ledgers) {
        const origins = entries.filter((entry) => entry.event === 'run-origin');
        expect(origins).toHaveLength(1);
        expect(origins[0]!.data).toMatchObject({
          hostId: '01HOSTTEST', hostname: expect.any(String), substrate: 'host',
          platform: process.platform, arch: process.arch,
          elanousVersion: JSON.parse(readFileSync(join(import.meta.dir, '../../package.json'), 'utf8')).version,
          podName: 'pod-a', nodeName: 'node-b', podNamespace: 'namespace-c', imageCommit: 'commit-d',
          instance: expect.any(String),
        });
        expect(origins[0]!.runId).toMatch(/^run-[0-9a-f-]{36}$/);
      }
      expect(ledgers[0]![0]!.runId).not.toBe(ledgers[1]![0]!.runId);
    } finally {
      if (runIdBefore === undefined) delete process.env.ELANOUS_RUN_ID;
      else process.env.ELANOUS_RUN_ID = runIdBefore;
      if (before === undefined) delete process.env.ELANOUS_HOST_ID;
      else process.env.ELANOUS_HOST_ID = before;
      if (substrate === undefined) delete process.env.ELANOUS_SUBSTRATE;
      else process.env.ELANOUS_SUBSTRATE = substrate;
      optionalKeys.forEach((key, index) => {
        const value = previousOptional[index];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
    }
  });
});

describe('post-merge goal copy cleanup', () => {
  const goal = 'docs/goals/GOAL-copy.md';
  // 정리 심은 가짜로 끼우니 골 파일은 저장소 밖 임시 폴더에 둔다 — 실제 작업 트리의 docs/goals 를 건드리지 않고,
  // docs/goals 가 없는 트리(공개본)에서도 돈다.
  const goalRoot = mkdtempSync(join(tmpdir(), 'goal-copy-cleanup-'));
  const goalFile = join(goalRoot, goal);
  beforeEach(() => { mkdirSync(dirname(goalFile), { recursive: true }); writeFileSync(goalFile, '# Copy goal\n'); });
  afterEach(() => { rmSync(goalFile, { force: true }); });
  afterAll(() => { rmSync(goalRoot, { recursive: true, force: true }); });
  const mergedSeams = (overrides: Partial<SelfImplementSeams['postMergeCleanup']> = {}) => {
    const calls: string[] = [];
    const cleanup = {
      enabled: true,
      listActiveTerminalDirectories: () => ({ ok: true, value: [] }),
      isWorktreeInUse: () => false,
      readWorktreePorcelain: () => '',
      resolveMainRepoRoot: () => '/launch',
      removeWorktree: () => { calls.push('worktree'); },
      removeBranch: () => { calls.push('branch'); },
      removeMatchingGoalCopy: () => { calls.push('copy'); return { outcome: 'removed' as const, reason: 'identical-untracked-copy' }; },
      ...overrides,
    };
    return { calls, cleanup };
  };

  test('confirmed merge removes an identical untracked copy after worktree and branch cleanup', async () => {
    const { calls, cleanup } = mergedSeams();
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const result = await runSelfImplement({ feature: 'merge copy', goalFile, autoMerge: true, memory: false,
      writeGoalExecutionRecord: () => {}, writeGoalRunRecord: () => {},
      seams: seams({
        defaultBranchRef: () => 'origin/main',
        reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'ok', reviewed: true, diffTruncated: false }),
        mergePr: async () => ({ merged: true, baseRefName: 'main' }),
        postMergeCleanup: { ...cleanup, removeMatchingGoalCopy: (root, file, branch) => {
          expect([root, file, branch]).toEqual(['/launch', goalFile, 'origin/main']);
          return cleanup.removeMatchingGoalCopy(root, file, branch);
        } },
        writeRunLedger: (entry) => { events.push({ event: entry.event, data: entry.data }); },
      }),
    });
    expect(result.merged).toBe(true);
    expect(calls).toEqual(['worktree', 'branch', 'copy']);
    expect(events.find((e) => e.event === 'post-merge-cleanup-goal-copy')?.data).toMatchObject({ goalFile, outcome: 'removed', reason: 'identical-untracked-copy' });
  });

  test.each(['content-differs', 'remote-unreadable', 'tracked', 'outside-repository'] as const)('keeps copy when %s', async (reason) => {
    const { calls, cleanup } = mergedSeams({ removeMatchingGoalCopy: () => ({ outcome: 'kept', reason }) });
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    await runSelfImplement({ feature: `merge ${reason}`, goalFile, autoMerge: true, memory: false,
      writeGoalExecutionRecord: () => {}, writeGoalRunRecord: () => {},
      seams: seams({ defaultBranchRef: () => 'origin/main',
        reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'ok', reviewed: true, diffTruncated: false }),
        mergePr: async () => ({ merged: true, baseRefName: 'main' }), postMergeCleanup: cleanup,
        writeRunLedger: (entry) => { events.push({ event: entry.event, data: entry.data }); },
      }),
    });
    expect(calls).toEqual(['worktree', 'branch']);
    expect(events.find((e) => e.event === 'post-merge-cleanup-goal-copy')?.data).toMatchObject({ goalFile, outcome: 'kept', reason });
  });

  test('production seam compares bytes and preserves differing, tracked and outside files', () => {
    const root = mkdtempSync(join(tmpdir(), 'merged-goal-copy-'));
    const origin = mkdtempSync(join(tmpdir(), 'merged-goal-origin-'));
    const goal = 'docs/goals/GOAL-copy.md';
    const file = join(root, goal);
    const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    try {
      mkdirSync(dirname(file), { recursive: true });
      expect(git('init', '-q', '-b', 'main').status).toBe(0);
      writeFileSync(file, Buffer.from([0, 255, 10]));
      expect(git('add', goal).status).toBe(0);
      expect(git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'goal').status).toBe(0);
      expect(spawnSync('git', ['init', '--bare', '-q', origin]).status).toBe(0);
      expect(git('remote', 'add', 'origin', origin).status).toBe(0);
      expect(git('push', '-q', 'origin', 'main').status).toBe(0);
      expect(removeMatchingGoalCopy(root, file, 'origin/main')).toMatchObject({ outcome: 'kept', reason: 'tracked' });
      expect(git('rm', '--cached', '-q', goal).status).toBe(0);
      writeFileSync(file, Buffer.from([0, 254, 10]));
      expect(removeMatchingGoalCopy(root, file, 'origin/main')).toMatchObject({ outcome: 'kept', reason: 'content-differs' });
      expect(existsSync(file)).toBe(true);
      expect(git('remote', 'remove', 'origin').status).toBe(0);
      writeFileSync(file, Buffer.from([0, 255, 10]));
      expect(removeMatchingGoalCopy(root, file, 'origin/main')).toMatchObject({ outcome: 'kept', reason: 'remote-unreadable' });
      expect(existsSync(file)).toBe(true);
      expect(removeMatchingGoalCopy(root, join(tmpdir(), 'GOAL-outside.md'), 'origin/main').outcome).toBe('kept');
      expect(git('remote', 'add', 'origin', origin).status).toBe(0);
      expect(removeMatchingGoalCopy(root, file, 'origin/main')).toMatchObject({ outcome: 'removed' });
      expect(existsSync(file)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(origin, { recursive: true, force: true }); }
  });
});

describe('runSelfImplement — parent soft-stop marker', () => {
  test('a post-start marker before the gate does not call the gate seam and records before-gate', async () => {
    let gateCalls = 0;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const requestedAt = new Date(Date.now() + 60_000).toISOString();
    const read: SoftStopRequestRead = { status: 'present', request: { version: 1, requestedAt } };
    const result = await runSelfImplement({
      feature: 'stop before gate',
      seams: seams({
        parentSoftStopSpaceId: 'parent-space',
        readSoftStopRequestStatus: () => read,
        gate: async () => {
          gateCalls += 1;
          return { passed: true, log: 'ok' };
        },
        writeRunLedger: (entry) => events.push({ event: entry.event, data: entry.data }),
      }),
    });
    expect(gateCalls).toBe(0);
    expect(result.stage).toBe('soft-stopped');
    expect(result.worktreePath).toBeTruthy();
    expect(result.branch).toBeTruthy();
    const honored = events.filter((entry) => entry.event === 'soft-stop-honored');
    expect(honored).toHaveLength(1);
    expect(honored[0]?.data.beforeNode).toBe('gate');
  });

  test('without a space seam or harness env, the parent reads the child worktree space that self send targets', async () => {
    const previousSpaceId = process.env.ELANOUS_HARNESS_SPACE_ID;
    const previousSpace = process.env.ELANOUS_HARNESS_SPACE;
    delete process.env.ELANOUS_HARNESS_SPACE_ID;
    delete process.env.ELANOUS_HARNESS_SPACE;
    const readIds: string[] = [];
    let gateCalls = 0;
    try {
      const result = await runSelfImplement({
        feature: 'stop from the child space id',
        seams: seams({
          createWorktree: async ({ branch, base }) => ({ path: '/wt/self-impl-goalid-0123456789abcdef-some-feature-slug', branch, base }),
          readSoftStopRequestStatus: (spaceId) => {
            readIds.push(spaceId);
            return { status: 'present', request: { version: 1, requestedAt: new Date(Date.now() + 60_000).toISOString() } };
          },
          gate: async () => { gateCalls += 1; return { passed: true, log: 'ok' }; },
        }),
      });
      expect(readIds[0]).toBe('self-impl-goalid-0123456789abcdef-some-feature-slug');
      expect(gateCalls).toBe(0);
      expect(result.stage).toBe('soft-stopped');
    } finally {
      if (previousSpaceId === undefined) delete process.env.ELANOUS_HARNESS_SPACE_ID; else process.env.ELANOUS_HARNESS_SPACE_ID = previousSpaceId;
      if (previousSpace === undefined) delete process.env.ELANOUS_HARNESS_SPACE; else process.env.ELANOUS_HARNESS_SPACE = previousSpace;
    }
  });

  test('a pre-start marker does not stop the run and the gate seam still runs', async () => {
    let gateCalls = 0;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const read: SoftStopRequestRead = {
      status: 'present',
      request: { version: 1, requestedAt: '2000-01-01T00:00:00.000Z' },
    };
    const result = await runSelfImplement({
      feature: 'ignore previous stop',
      completion: 'worktree-only',
      seams: seams({
        parentSoftStopSpaceId: 'parent-space',
        readSoftStopRequestStatus: () => read,
        gate: async () => {
          gateCalls += 1;
          return { passed: true, log: 'ok' };
        },
        writeRunLedger: (entry) => events.push({ event: entry.event, data: entry.data }),
      }),
    });
    expect(gateCalls).toBe(1);
    expect(result.stage).not.toBe('soft-stopped');
    expect(events.filter((entry) => entry.event === 'soft-stop-honored')).toHaveLength(0);
  });

  test('a failed marker read is neither stop-requested nor no-stop and the run continues', async () => {
    let gateCalls = 0;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const result = await runSelfImplement({
      feature: 'unreadable stop marker',
      completion: 'worktree-only',
      seams: seams({
        parentSoftStopSpaceId: 'parent-space',
        readSoftStopRequestStatus: () => ({ status: 'read-failed', code: 'EACCES' }),
        gate: async () => {
          gateCalls += 1;
          return { passed: true, log: 'ok' };
        },
        writeRunLedger: (entry) => events.push({ event: entry.event, data: entry.data }),
      }),
    });
    expect(gateCalls).toBe(1);
    expect(result.stage).not.toBe('soft-stopped');
    const failed = events.filter((entry) => entry.event === 'soft-stop-read-failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.data.beforeNode).toBe('gate');
    expect(events.filter((entry) => entry.event === 'soft-stop-honored')).toHaveLength(0);
    expect(events.filter((entry) => entry.event === 'soft-stop-request-absent')).toHaveLength(0);
  });
});

describe('runSelfImplement — shared worktree branch prefix', () => {
  test('default branch passed to createWorktree uses the harness shared prefix', async () => {
    let createdBranch = '';
    await runSelfImplement({
      feature: 'Shared Prefix',
      seams: seams({
        createWorktree: async ({ branch, base }) => {
          createdBranch = branch;
          return { path: `/wt/${branch}`, branch, base, resolvedBase: 'a'.repeat(40), invokedHead: 'a'.repeat(40) };
        },
      }),
    });
    expect(createdBranch).toBe(`${WORKTREE_BRANCH_PREFIX}${slugifyFeature('Shared Prefix')}`);
  });

  test('embeds goalId so branchGoalId reads it back from the created branch', async () => {
    let createdBranch = '';
    const goalId = '667c0b5f0fa204d6';
    const feature = 'Carry goal id on the branch';
    await runSelfImplement({
      feature,
      goalId,
      seams: seams({
        createWorktree: async ({ branch, base }) => {
          createdBranch = branch;
          return { path: `/wt/${branch}`, branch, base, resolvedBase: 'a'.repeat(40), invokedHead: 'a'.repeat(40) };
        },
      }),
    });
    expect(createdBranch).toBe(plannedSelfImplBranch(feature, goalId));
    expect(branchGoalId(createdBranch)).toBe(goalId);
  });

  test('keeps an explicit branchName even when goalId is present', async () => {
    let createdBranch = '';
    await runSelfImplement({
      feature: 'ignored for naming',
      goalId: '667c0b5f0fa204d6',
      branchName: 'custom/keep-me',
      seams: seams({
        createWorktree: async ({ branch }) => {
          createdBranch = branch;
          return { path: `/wt/${branch}`, branch };
        },
      }),
    });
    expect(createdBranch).toBe('custom/keep-me');
    expect(branchGoalId(createdBranch)).toBeNull();
  });

  test('observeOnly generated branch also carries goalId', async () => {
    const goalId = '97a1dfd4f7bb6837';
    const feature = 'observe only still names the branch';
    const result = await runSelfImplement({
      feature,
      goalId,
      observeOnly: true,
      seams: seams({}),
    });
    expect(result.branch).toBe(plannedSelfImplBranch(feature, goalId));
    expect(branchGoalId(result.branch ?? '')).toBe(goalId);
  });
});

describe('runSelfImplement — worktree-only completion', () => {
  test.each([
    ['approved', async (): Promise<boolean> => true],
    ['declined', async (): Promise<boolean> => false],
    ['no approver', undefined],
  ] as const)('finishes worktree-only mode before PR approval when no decision signal is red (%s)', async (_approval, approvePr) => {
    let approvePrCalls = 0;
    let openPrCalls = 0;
    const result = await runSelfImplement({
      feature: `worktree-only completion ${_approval}`,
      completion: 'worktree-only',
      seams: seams({
        ...(approvePr ? { approvePr: async () => { approvePrCalls++; return approvePr(); } } : { approvePr: undefined }),
        openPr: async () => { openPrCalls++; return { url: 'https://pr/should-not-open', number: 1 }; },
      }),
    });

    expect(result).toMatchObject({ ok: true, stage: 'worktree-completed', node: 'open-pr', outcome: 'completed' });
    expect(result.detail).toBe('worktree-only completion: PR creation skipped');
    expect(approvePrCalls).toBe(0);
    expect(openPrCalls).toBe(0);
  });

  test('falls back to PR decline when worktree-only mode has a red decision signal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'worktree-only-red-signal-'));
    const goalFile = join(root, 'GOAL.txt');
    try {
      writeFileSync(goalFile, ['Candidate decision signal:', 'Observation: `rg -c ^missing artifact.ts`'].join('\n'));
      const result = await runSelfImplement({
        feature: 'worktree-only red signal',
        completion: 'worktree-only',
        goalFile,
        seams: seams({
          createWorktree: async () => ({ path: root, branch: 'self-impl/worktree-only-red-signal' }),
          approvePr: async () => false,
        }),
      });

      expect(result).toMatchObject({ ok: false, stage: 'pr-declined', outcome: 'abandoned' });
      expect(result.decisionSignalPress?.pressedRed).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a baseline-only decision signal does not set decisionSignalRed and its count is on merge-decision', async () => {
    const root = mkdtempSync(join(tmpdir(), 'worktree-only-baseline-signal-'));
    const goalFile = join(root, 'GOAL.txt');
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = (debug as { log: typeof debug.log }).log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    const baselineOnly: DecisionSignalPressResult = {
      classification: { kinds: null, observations: null },
      pressedGreen: [],
      pressedRed: [],
      pressedBaselineOnly: [{
        signal: 'Candidate decision signal:',
        command: 'bun test src/example.test.ts',
        exitCode: 1,
        stdout: '(fail) a > x',
        durationMs: 1,
        baselineFailedNames: ['a > x'],
      }],
      unpressed: [],
      pressedCount: 1,
    };
    try {
      writeFileSync(goalFile, ['Candidate decision signal:', 'Observation: `bun test src/example.test.ts`'].join('\\n'));
      const result = await runSelfImplement({
        feature: 'worktree-only baseline-only signal',
        completion: 'worktree-only',
        autoMerge: true,
        goalFile,
        seams: seams({
          createWorktree: async () => ({ path: root, branch: 'self-impl/worktree-only-baseline-signal' }),
          approvePr: async () => { throw new Error('baseline-only must not ask for approval'); },
          openPr: async () => { throw new Error('baseline-only must not open a PR'); },
        }),
        decisionSignalPressSources: {
          stat: () => ({ isFile: () => true }),
          read: () => readFileSync(goalFile, 'utf8'),
          inspectKinds: () => null,
          inspectObservations: () => null,
          inspectSignals: () => [{ signal: 'Candidate decision signal:', command: 'bun test src/example.test.ts', kind: 'unit-test' }],
          press: () => baselineOnly,
        },
      });
      expect(result).toMatchObject({ ok: true, stage: 'worktree-completed', outcome: 'completed' });
      expect(result.mergeReason).not.toBe('decision-signal-red');
      expect(result.decisionSignalPress?.pressedRed).toEqual([]);
      expect(result.decisionSignalPress?.pressedBaselineOnly).toHaveLength(1);
      expect(events.find((entry) => entry.event === 'merge-decision')?.data).toMatchObject({
        decisionSignalBaselineOnly: 1,
      });
      expect(events.find((entry) => entry.event === 'merge-decision')?.data.reason).not.toBe('decision-signal-red');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a pressedRed signal still blocks auto-merge', async () => {
    const root = mkdtempSync(join(tmpdir(), 'auto-merge-red-signal-'));
    const goalFile = join(root, 'GOAL.txt');
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = (debug as { log: typeof debug.log }).log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    const pressedRed: DecisionSignalPressResult = {
      classification: { kinds: null, observations: null },
      pressedGreen: [],
      pressedRed: [{
        signal: 'Candidate decision signal:',
        command: 'bun test src/example.test.ts',
        exitCode: 1,
        stdout: '(fail) a > y',
        durationMs: 1,
        baselineReason: 'baseline passed: a > y',
      }],
      pressedBaselineOnly: [],
      unpressed: [],
      pressedCount: 1,
    };
    try {
      writeFileSync(goalFile, ['Candidate decision signal:', 'Observation: `bun test src/example.test.ts`'].join('\\n'));
      const result = await runSelfImplement({
        feature: 'pressed red still blocks merge',
        autoMerge: true,
        goalFile,
        seams: seams({
          createWorktree: async () => ({ path: root, branch: 'self-impl/pressed-red-blocks' }),
          reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'review pass', reviewed: true, diffTruncated: false }),
          mergePr: async () => { throw new Error('pressedRed must prevent auto-merge'); },
          approvePr: async () => false,
        }),
        decisionSignalPressSources: {
          stat: () => ({ isFile: () => true }),
          read: () => readFileSync(goalFile, 'utf8'),
          inspectKinds: () => null,
          inspectObservations: () => null,
          inspectSignals: () => [{ signal: 'Candidate decision signal:', command: 'bun test src/example.test.ts', kind: 'unit-test' }],
          press: () => pressedRed,
        },
      });
      expect(result).toMatchObject({ ok: false, stage: 'pr-declined', mergeReason: 'decision-signal-red' });
      expect(result.decisionSignalPress?.pressedRed).toHaveLength(1);
      expect(events.find((entry) => entry.event === 'merge-decision')?.data).toMatchObject({
        decision: 'hitl',
        reason: 'decision-signal-red',
        decisionSignalBaselineOnly: 0,
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps PR completion on the existing decline path without approval', async () => {
    const result = await runSelfImplement({
      feature: 'PR completion still declines',
      completion: 'pr',
      seams: seams({ approvePr: async () => false }),
    });

    expect(result).toMatchObject({ ok: false, stage: 'pr-declined', outcome: 'abandoned' });
  });

  test('keeps an unspecified completion mode on the existing decline path without approval', async () => {
    const result = await runSelfImplement({
      feature: 'unspecified completion still declines',
      seams: seams({ approvePr: async () => false }),
    });

    expect(result).toMatchObject({ ok: false, stage: 'pr-declined', outcome: 'abandoned' });
  });
});

describe('runSelfImplement — document reference wiring', () => {
  test('forwards resolved references unchanged across the initial and rework rounds', async () => {
    const documentReferences = [{ path: 'README.md', result: { kind: 'ok' as const, contents: 'reference' } }];
    const received: Array<readonly DocumentReferenceStatus[]> = [];
    await runSelfImplement({
      feature: 'document reference round wiring',
      documentReferences,
      maxReworkRounds: 1,
      seams: seams({
        gateResults: [false, true],
        implement: async (ctx) => {
          received.push(ctx.documentReferences!);
          return { ok: true, summary: 'impl' };
        },
      }),
    });
    expect(received).toEqual([documentReferences, documentReferences]);
  });

  test('keeps the existing seam call shape when document references are omitted', async () => {
    let received: Record<string, unknown> | undefined;
    await runSelfImplement({
      feature: 'default document reference wiring',
      seams: seams({
        implement: async (ctx) => {
          received = ctx as Record<string, unknown>;
          return { ok: true, summary: 'impl' };
        },
      }),
    });
    expect(received).not.toHaveProperty('documentReferences');
  });
});

describe('runSelfImplement — child LLM wiring', () => {
  test('forwards one explicit child LLM unchanged across the initial and rework rounds', async () => {
    const received: Array<{ childLlm?: { provider: string; model: string; source: 'flag' | 'config' }; escalateTier?: string }> = [];
    await runSelfImplement({
      feature: 'child LLM round wiring',
      childLlm: { provider: 'anthropic', model: 'claude-sonnet', source: 'flag' },
      maxReworkRounds: 1,
      seams: seams({
        gateResults: [false, true],
        implement: async (ctx) => {
          received.push({ childLlm: ctx.childLlm, escalateTier: ctx.escalateTier });
          return { ok: true, summary: 'impl' };
        },
      }),
    });
    expect(received).toEqual([
      { childLlm: { provider: 'anthropic', model: 'claude-sonnet', source: 'flag' }, escalateTier: undefined },
      { childLlm: { provider: 'anthropic', model: 'claude-sonnet', source: 'flag' }, escalateTier: 'sol' },
    ]);
  });

  test('keeps the existing seam call shape when child LLM is omitted', async () => {
    let received: Record<string, unknown> | undefined;
    await runSelfImplement({
      feature: 'default child LLM wiring',
      seams: seams({
        implement: async (ctx) => {
          received = ctx as Record<string, unknown>;
          return { ok: true, summary: 'impl' };
        },
      }),
    });
    expect(received).not.toHaveProperty('childLlm');
  });

  test('rejects an incomplete child LLM selection by naming both required fields', async () => {
    await expect(runSelfImplement({
      feature: 'invalid child LLM wiring',
      childLlm: { provider: 'anthropic' } as never,
      seams: seams({}),
    })).rejects.toThrow('childLlm.provider and childLlm.model must both be non-empty');
  });
});

describe('runSelfImplement — escalation triage wiring', () => {
  test('runSelfImplement calls escalation triage only for the final sol retry and consumes its judgement in that child input', async () => {
    const received: Array<{ escalateTier?: string; feature: string }> = [];
    const diagnosisPurposes: Array<{ round: number; purpose?: string }> = [];
    await runSelfImplement({
      feature: 'escalation triage wiring',
      maxReworkRounds: 1,
      seams: seams({
        gateResults: [false, true],
        diagnose: async ({ round, purpose }) => {
          diagnosisPurposes.push({ round, purpose });
          return purpose === 'escalation-triage'
            ? 'TRIAGE: rewrite the contract'
            : 'BUDGET: EXTEND\nREASON: preserve retry';
        },
        implement: async ({ escalateTier, feature }) => {
          received.push({ escalateTier, feature });
          return { ok: true, summary: 'impl' };
        },
      }),
    });

    expect(diagnosisPurposes).toEqual([
      { round: 1, purpose: 'budget' },
      { round: 1, purpose: 'escalation-triage' },
    ]);
    expect(received).toEqual([
      { escalateTier: undefined, feature: 'escalation triage wiring' },
      { escalateTier: 'sol', feature: expect.stringContaining('TRIAGE: rewrite the contract') },
    ]);
  });

  test('EXTEND that moves the final tier leaves the now non-escalated retry without triage', async () => {
    const purposes: Array<{ round: number; purpose?: string }> = [];
    const received: Array<string | undefined> = [];
    await runSelfImplement({
      feature: 'extend moves escalation',
      maxReworkRounds: 2,
      seams: seams({
        gateResults: [false, false, true],
        diagnose: async ({ round, purpose }) => {
          purposes.push({ round, purpose });
          return purpose === 'escalation-triage'
            ? 'TRIAGE: must not be called'
            : 'BUDGET: EXTEND\nREASON: one more retry';
        },
        implement: async ({ escalateTier }) => {
          received.push(escalateTier);
          return { ok: true, summary: 'impl' };
        },
      }),
    });

    expect(received).toEqual([undefined, undefined, undefined]);
    expect(purposes).toEqual([
      { round: 1, purpose: 'budget' },
      { round: 2, purpose: 'budget' },
    ]);
  });

  test('runSelfImplement observes triage failure and continues the sol retry', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const received: Array<{ escalateTier?: string; feature: string }> = [];
      await runSelfImplement({
        feature: 'escalation triage failure',
        maxReworkRounds: 1,
        seams: seams({
        gateResults: [false, true],
        diagnose: async ({ purpose }) => {
          if (purpose === 'escalation-triage') throw new Error('triage unavailable');
          return 'BUDGET: EXTEND\nREASON: preserve retry';
        },
        implement: async ({ escalateTier, feature }) => {
            received.push({ escalateTier, feature });
            return { ok: true, summary: 'impl' };
          },
        }),
      });
      expect(received.map(({ escalateTier }) => escalateTier)).toEqual([undefined, 'sol']);
      expect(received[1]!.feature).not.toContain('트리아지 판단');
      expect(events).toContainEqual(expect.objectContaining({
        event: 'rework-triage',
        data: expect.objectContaining({ round: 1, escalateTier: 'sol', status: 'failed' }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('defaultSeams escalation-triage LLM failure remains failed and the sol retry continues', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const productionDiagnose = defaultSeams({
        llmReview: async () => { throw new Error('production triage unavailable'); },
      }).diagnose!;
      const received: Array<{ escalateTier?: string; feature: string }> = [];
      await runSelfImplement({
        feature: 'production escalation triage failure',
        maxReworkRounds: 1,
        seams: seams({
          gateResults: [false, true],
          diagnose: async (input) => input.purpose === 'escalation-triage'
            ? productionDiagnose(input)
            : 'BUDGET: EXTEND\nREASON: preserve retry',
          implement: async ({ escalateTier, feature }) => {
            received.push({ escalateTier, feature });
            return { ok: true, summary: 'impl' };
          },
        }),
      });
      expect(received.map(({ escalateTier }) => escalateTier)).toEqual([undefined, 'sol']);
      expect(received[1]!.feature).not.toContain('트리아지 판단');
      expect(events).toContainEqual(expect.objectContaining({
        event: 'rework-triage',
        data: expect.objectContaining({ round: 1, escalateTier: 'sol', status: 'failed', error: 'production triage unavailable' }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('review-caused rework preserves its non-escalated tier policy', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const s = revSeams({ reviews: [{ verdict: 'fail', mustFix: ['review correction'] }, { verdict: 'pass', reviewed: true }] });
      s.diagnose = async () => 'BUDGET: EXTEND\nREASON: preserve retry';
      const received: Array<string | undefined> = [];
      s.implement = async ({ escalateTier }) => {
        received.push(escalateTier);
        return { ok: true, summary: 'impl' };
      };

      await runSelfImplement({ feature: 'review no escalation triage', maxReworkRounds: 1, seams: s });

      expect(received).toEqual([undefined, undefined]);
      const reworkObservation = events.find(({ event }) => event === 'rework')?.data;
      expect(reworkObservation).not.toHaveProperty('triageStatus');
      expect(reworkObservation).not.toHaveProperty('triageJudgement');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });
});

describe('runSelfImplement — gate execution observation', () => {
  test('gated 관측은 스킵과 실행된 테스트 스텝을 구분하고 스코프 사실을 보존한다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await runSelfImplement({
        feature: 'skipped gate observation',
        seams: seams({ gate: async () => ({
          passed: true,
          log: 'gate',
          testStepExecuted: false,
          scopeReason: 'no-related-tests',
          unverified: ['src/changed.ts'],
          importerTestsNotRun: { total: 2, files: ['test/importer-a.test.ts', 'test/importer-b.test.ts'], truncated: false, unresolvedRelativeSpecifiers: 0 },
          missingTestFiles: 0,
          testDeclarationDecline: null,
        }) }),
      });
      await runSelfImplement({
        feature: 'executed gate observation',
        seams: seams({ gate: async () => ({
          passed: true,
          log: 'gate',
          testStepExecuted: true,
          scopeReason: 'changed-tests',
          unverified: [],
          importerTestsNotRun: null,
          missingTestFiles: 0,
          testDeclarationDecline: 3,
          reflectGateFacts: { introduced: 0, preexisting: 2, unknown: 1, unknownReason: 'baseline-unavailable', childResponsibility: 'none' },
        }) }),
      });
      await runSelfImplement({
        feature: 'absent importer observation',
        seams: seams({ gate: async () => ({ passed: true, log: 'gate' }) }),
      });
      await runSelfImplement({
        feature: 'partial gate attribution observation',
        seams: seams({ gate: async () => ({
          passed: true,
          log: 'gate',
          importerTestsNotRun: { total: 0, files: [], truncated: false, unresolvedRelativeSpecifiers: 0 },
          reflectGateFacts: { introduced: 0, preexisting: undefined, unknown: undefined } as never,
        }) }),
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }

    const gated = events.filter((entry) => entry.event === 'gated' && 'gateExecuted' in entry.data).map((entry) => entry.data);
    expect(gated).toContainEqual(expect.objectContaining({
      passed: true,
      round: 0,
      testStepExecuted: false,
      scopeReason: 'no-related-tests',
      unverified: ['src/changed.ts'],
      importerTestsNotRun: { total: 2, files: ['test/importer-a.test.ts', 'test/importer-b.test.ts'], truncated: false, unresolvedRelativeSpecifiers: 0 },
      missingTestFiles: 0,
      testDeclarationDecline: null,
    }));
    expect(gated).toContainEqual(expect.objectContaining({ passed: true, round: 0, testStepExecuted: true, scopeReason: 'changed-tests', unverified: [], importerTestsNotRun: null, missingTestFiles: 0, testDeclarationDecline: 3, introduced: 0, preexisting: 2, unknown: 1, unknownReason: 'baseline-unavailable', childResponsibility: 'none' }));
    const absentImporterTestsNotRun = gated.find((data) => !('importerTestsNotRun' in data) && !('introduced' in data));
    expect(absentImporterTestsNotRun).toEqual(expect.objectContaining({ passed: true, round: 0 }));
    expect(absentImporterTestsNotRun).not.toHaveProperty('importerTestsNotRun');
    const zeroImporterTestsNotRun = gated.find((data) => {
      const observation = data.importerTestsNotRun as { total?: number } | undefined;
      return observation?.total === 0;
    });
    expect(zeroImporterTestsNotRun).toEqual(expect.objectContaining({
      importerTestsNotRun: { total: 0, files: [], truncated: false, unresolvedRelativeSpecifiers: 0 },
    }));
    expect(zeroImporterTestsNotRun?.importerTestsNotRun).not.toBe(null);
    expect(gated[0]).not.toHaveProperty('introduced');
    expect(gated[0]).not.toHaveProperty('childResponsibility');
    const partialAttribution = gated.find((data) => data.introduced === 0 && !('preexisting' in data) && !('unknown' in data));
    expect(partialAttribution).toEqual(expect.objectContaining({ passed: true, round: 0, introduced: 0 }));
    expect(partialAttribution).not.toHaveProperty('preexisting');
    expect(partialAttribution).not.toHaveProperty('unknown');
  });

  test('gated 관측은 종료 시점 1분 부하를 항상 기록하며 못 읽으면 null로 남긴다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await runSelfImplement({
        feature: 'readable end load observation',
        seams: seams({ sampleLoadAtEnd: () => 12.5 }),
      });
      await runSelfImplement({
        feature: 'unreadable end load observation',
        seams: seams({ sampleLoadAtEnd: () => { throw new Error('load unavailable'); } }),
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }

    const gated = events.filter((entry) => entry.event === 'gated' && 'gateExecuted' in entry.data).map((entry) => entry.data);
    expect(gated).toContainEqual(expect.objectContaining({ passed: true, gateExecuted: true, loadAtEnd: 12.5 }));
    expect(gated).toContainEqual(expect.objectContaining({ passed: true, gateExecuted: true, loadAtEnd: null }));
    for (const data of gated) expect(data).toHaveProperty('loadAtEnd');
  });

  test('⛔ gated 관측이 「통과」와 «실행 여부»를 가른다 — 안 돌린 것을 통과로 세지 않는다', async () => {
    // 🩸 계기(2026-09-08): 승격을 켠 첫 research 런이 게이트를 «건너뛰고» 화면에 `gate 통과` 를 찍었다.
    //   원장의 걸음은 정직했는데(gate 노드 없음) 이 칸이 없어서 「돌았나」를 원장으로 못 물었다.
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await runSelfImplement({
        feature: 'gate executed flag',
        seams: seams({ gate: async () => ({ passed: true, log: 'gate' }) }),
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    const gated = events.filter((entry) => entry.event === 'gated' && 'gateExecuted' in entry.data).map((entry) => entry.data);
    expect(gated.length).toBeGreaterThan(0);
    // goal type 부재는 implement-loop 으로 fallback 하므로 기본 ON에서도 게이트가 «돈다».
    for (const data of gated) expect({ gateExecuted: data.gateExecuted }).toEqual({ gateExecuted: true });
  });

  test('⭐ 승격을 켠 research 골은 게이트를 «안 돌린다» — 그동안 실물로만 확인되던 갈래', async () => {
    // 🩸 이 시험이 없어서 「건너뛰는 쪽」은 격리 실물 런으로만 확인됐다(2026-09-08).
    //   ⛔ 실물은 재현이 비싸고 회귀를 «다음 런까지» 못 잡는다.
    const goalFile = join(mkdtempSync(join(tmpdir(), 'graph-auth-')), 'GOAL.md');
    writeFileSync(goalFile, '대상 경로: docs/x.md\n- GoalId: 1111111111111111\n- GoalType: research\n\n# 연구 골\n');
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    let gateCalls = 0;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await runSelfImplement({
        feature: 'research goal skips the gate',
        goalFile,
        seams: seams({
          gate: async () => { gateCalls++; return { passed: true, log: 'gate' }; },
          // ⛔ 라우터의 입력을 «주입»한다 — 문서만 바뀐 판이어야 건너뛴다(못 세면 fail-safe 로 «돈다»).
          changedFilesForGateRoute: () => ['docs/RESEARCH-x.md'],
        }),
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      rmSync(goalFile, { force: true });
    }

    // 실행 경로가 남긴 실제 권위 이벤트의 칸과 값은 그대로다.
    const resolved = events.filter((entry) => entry.event === 'graph-authority-resolved').map((entry) => entry.data);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toEqual(expect.objectContaining({
      graphAuthoritative: true, graphAuthoritativeSource: 'default', activeGraphId: 'research-loop',
    }));
    // ⑴ 게이트 «심»이 한 번도 안 불렸다 — 이름만 안 남긴 것이 아니다.
    expect(gateCalls).toBe(0);
    // ⑵ 그 사실이 원장에 «값»으로 남는다(출처는 항상 default).
    const skipped = events.filter((entry) => entry.event === 'gate-skipped-by-graph').map((entry) => entry.data);
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped[0]).toEqual(expect.objectContaining({
      graphAuthoritative: true, graphAuthoritativeSource: 'default', activeGraphId: 'research-loop',
      reason: 'documents-only', changedFileCount: 1,
    }));
    // ⑶ 「통과」와 「실행 여부」가 갈린다.
    const gated = events.filter((entry) => entry.event === 'gated' && 'gateExecuted' in entry.data).map((entry) => entry.data);
    for (const data of gated) expect({ gateExecuted: data.gateExecuted }).toEqual({ gateExecuted: false });
  });

  test('🚨 승격을 켠 research 골이라도 «코드»가 바뀌면 게이트를 «돌린다» — 구멍 ⓐ 를 막는 줄', async () => {
    // ⛔ 이 시험이 없으면 「research 는 게이트를 건너뛴다」가 «코드를 만진 판»에도 적용된다.
    //   그 구멍은 2026-09-08 승격 첫 판에 «실제로 열려 있었다».
    const goalFile = join(mkdtempSync(join(tmpdir(), 'graph-auth-')), 'GOAL.md');
    writeFileSync(goalFile, '대상 경로: docs/x.md\n- GoalId: 2222222222222222\n- GoalType: research\n\n# 연구 골\n');
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    let gateCalls = 0;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await runSelfImplement({
        feature: 'research goal that touches code still gates',
        goalFile,
        seams: seams({
          gate: async () => { gateCalls++; return { passed: true, log: 'gate' }; },
          changedFilesForGateRoute: () => ['docs/RESEARCH-x.md', 'src/x.ts'],   // ← 코드가 섞였다
        }),
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      rmSync(goalFile, { force: true });
    }

    expect(gateCalls).toBeGreaterThan(0);                                   // ⑴ 게이트가 «돌았다»
    expect(events.filter((e) => e.event === 'gate-skipped-by-graph')).toEqual([]);  // ⑵ 건너뛰지 «않았다»
    const gated = events.filter((entry) => entry.event === 'gated' && 'gateExecuted' in entry.data).map((entry) => entry.data);
    expect(gated.length).toBeGreaterThan(0);
    for (const data of gated) {
      expect({ gateExecuted: data.gateExecuted, gateRouteReason: data.gateRouteReason })
        .toEqual({ gateExecuted: true, gateRouteReason: 'code-changed' });   // ⑶ 사유가 값으로 남는다
    }
  });

  test('🩸 걸음과 «신원»이 갈리지 않는다 — 원장의 graphId·graphVersion 이 «도는 템플릿»을 따른다', async () => {
    // 계기(2026-09-08): 승격을 켠 research 런이 investigate 를 밟았는데 원장의 graphVersion 은
    //   «옛 TS 해시»였다. ⇒ 사후에 「어느 선언으로 돈 걸음인가」를 못 묻는다 — 조인이 거짓말한다.
    const goalFile = join(mkdtempSync(join(tmpdir(), 'graph-ident-')), 'GOAL.md');
    writeFileSync(goalFile, '대상 경로: docs/x.md\n- GoalId: 3333333333333333\n- GoalType: research\n\n# 연구 골\n');
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await runSelfImplement({
        feature: 'graph identity follows the active template',
        goalFile,
        seams: seams({
          gate: async () => ({ passed: true, log: 'gate' }),
          changedFilesForGateRoute: () => ['docs/RESEARCH-x.md'],
        }),
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      rmSync(goalFile, { force: true });
    }
    const entries = events.filter((e) => e.event === 'pipeline-node-entry').map((e) => e.data);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      // ⛔ 「research-loop 을 밟는데 신원은 self-implement」가 «안 나와야» 한다.
      expect({ graphId: entry.graphId }).toEqual({ graphId: 'research-loop' });
    }
  });
});

function terminalG2Seams(opts: { mergeStatus: 'merged' | 'up-to-date' | 'llm-resolved' | 'conflict-unresolved'; gateResults: boolean[] }): SelfImplementSeams {
  let gateCall = 0;
  return {
    writeRunLedger: () => {},
    // ⛔⭐ 진짜 쿼터 갱신은 총 상한 40초를 «다 쓰고» 돌아온다(실측 40,003ms) — 안 막으면 이 시험들이 타임아웃한다.
    refreshCodexQuotaSignals: async () => ({}),
    createWorktree: async ({ branch, base }) => ({ path: `/wt/${branch}`, branch, base, resolvedBase: 'a'.repeat(40), invokedHead: 'a'.repeat(40) }),
    implement: async () => ({ ok: true, summary: 'impl' }),
    gate: async () => ({ passed: opts.gateResults[Math.min(gateCall++, opts.gateResults.length - 1)]!, log: 'gate' }),
    commitWork: () => {},
    defaultBranchRef: () => 'origin/main',
    mergeMain: async () => ({ status: opts.mergeStatus }),
    openPr: async () => ({ url: 'https://pr/terminal', number: 7 }),
    readPrDiff: async () => '',
    readPrCommitShas: async () => ({ baseCommit: 'base-sha', headCommit: 'checked-head-sha' }),
    approvePr: async () => true,
  };
}

describe('runSelfImplement — review-context carryover', () => {
  test('observes headline comments separately from carried items', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const original = (debug as { log: typeof debug.log }).log;
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ category, event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await runSelfImplement({
        feature: 'review-context carryover observation',
        base: 'feature/base-pr',
        seams: seams({
          findAppliedReviewItems: async () => ({ basePrLocated: true, items: [], headlineComments: 1 }),
        }),
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }

    expect(events).toContainEqual(expect.objectContaining({
      category: 'self-implement',
      event: 'review-context-carried',
      data: expect.objectContaining({ base: 'feature/base-pr', basePrLocated: true, carriedItems: 0, headlineComments: 1 }),
    }));
  });

  test('carries prior same-goal ledger findings before reading PR comments', async () => {
    const goalId = 'a'.repeat(16);
    const store = new GoalRunStore();
    try {
      store.insert('/unused-goal-file', {
        runId: 'prior-ledger-carryover',
        stage: 'pr-opened',
        outcome: 'completed',
        ok: true,
        startedAt: '2026-08-08T00:00:00.000Z',
        rounds: 1,
        lastReviewFindings: {
          items: ['ledger finding one', 'ledger finding two'],
          itemCount: 2,
          shownChars: 36,
          totalChars: 36,
          truncated: false,
          fullyIncludedItems: 2,
          truncatedItems: 0,
          omittedItems: 0,
        },
      }, goalId);
    } finally {
      store.close();
    }

    const carried = await defaultSeams({}).findAppliedReviewItems!('feature/no-pr-needed', goalId);
    expect(carried).toEqual(expect.objectContaining({
      source: 'ledger',
      items: ['ledger finding one', 'ledger finding two'],
    }));
  });

  test('looks up and observes ledger carryover when only goalId is available', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const calls: Array<{ branch: string; goalId: string | undefined }> = [];
    const original = (debug as { log: typeof debug.log }).log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      if (event === 'review-context-carried') events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await runSelfImplement({
        feature: 'goalId-only ledger carryover',
        goalId: 'b'.repeat(16),
        seams: seams({
          findAppliedReviewItems: async (branch, goalId) => {
            calls.push({ branch, goalId });
            return { basePrLocated: false, items: ['ledger finding'], source: 'ledger' };
          },
        }),
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }

    expect(calls).toEqual([{ branch: '', goalId: 'b'.repeat(16) }]);
    expect(events.map(({ data }) => data)).toContainEqual(expect.objectContaining({
      base: undefined,
      source: 'ledger',
      carriedItems: 1,
    }));
  });

  test('does not look up carryover without base or goalId', async () => {
    let calls = 0;
    await runSelfImplement({
      feature: 'no carryover identifiers',
      seams: seams({
        findAppliedReviewItems: async () => {
          calls++;
          return { basePrLocated: false, items: [] };
        },
      }),
    });

    expect(calls).toBe(0);
  });

  test('observes PR fallback and unavailable carryover sources independently', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = (debug as { log: typeof debug.log }).log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      if (event === 'review-context-carried') events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await runSelfImplement({
        feature: 'PR fallback source',
        base: 'feature/pr-fallback',
        seams: seams({ findAppliedReviewItems: async () => ({ basePrLocated: true, items: ['PR finding'], source: 'pr-comment' }) }),
      });
      await runSelfImplement({
        feature: 'unavailable source',
        base: 'feature/no-source',
        seams: seams({ findAppliedReviewItems: async () => ({ basePrLocated: false, items: [], source: 'unavailable' }) }),
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }

    expect(events.map(({ data }) => data)).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'pr-comment', carriedItems: 1 }),
      expect.objectContaining({ source: 'unavailable', carriedItems: 0 }),
    ]));
  });
});

describe('runSelfImplement — Fix A rework', () => {
  test('gate 1패스 통과 → rework 없이 pr-opened', async () => {
    const features: string[] = [];
    const r = await runSelfImplement({ feature: 'F', seams: seams({ gateResults: [true], features }) });
    expect(r.stage).toBe('pr-opened');
    expect(r.outcome).toBe('completed');
    expect(r.supervisorWantedContinue).toBeUndefined();
    expect(features.length).toBe(1);   // implement 1회(rework 없음)
  });

  test('runs without a goal file observe why no execution record was written', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const original = (debug as { log: typeof debug.log }).log;
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ category, event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    let executionRecordWriterCalls = 0;
    const writeGoalExecutionRecord = () => {
      executionRecordWriterCalls++;
      throw new Error('a goal-file-less run must not write an execution record');
    };
    try {
      await runSelfImplement({
        feature: 'observe no goal file execution record',
        runId: 'run-no-goal-file-record',
        writeGoalExecutionRecord,
        seams: seams({ gateResults: [true] }),
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }

    expect(executionRecordWriterCalls).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({
      category: 'self-implement',
      event: 'start',
      data: expect.objectContaining({
        feature: 'observe no goal file execution record',
        base: null,
        draft: true,
        goalSource: 'no-goal-file',
        goalFile: null,
      }),
    }));
    expect(events).toContainEqual({
      category: 'self-implement',
      event: 'goal-execution-record',
      data: { runId: 'run-no-goal-file-record', goalFile: null, reason: 'no-goal-file' },
    });
  });

  test('start observation records active provider identity while preserving every existing start key', async () => {
    const originEnv = {
      ELANOUS_ORIGIN_AGENT: process.env.ELANOUS_ORIGIN_AGENT,
      ELANOUS_ORIGIN_ROOT: process.env.ELANOUS_ORIGIN_ROOT,
      ELANOUS_ORIGIN_SESSION: process.env.ELANOUS_ORIGIN_SESSION,
    };
    process.env.ELANOUS_ORIGIN_AGENT = 'test-origin-agent';
    process.env.ELANOUS_ORIGIN_ROOT = 'test-origin-root';
    process.env.ELANOUS_ORIGIN_SESSION = 'test-origin-session';

    try {
      const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
      await runSelfImplement({
      feature: 'record active provider identity',
      runId: 'run-active-provider-identity',
      goalId: 'goal-active-provider-identity',
      seams: seams({
        inspectActiveProvider: () => ({ provider: 'grok', model: 'grok-4.6-heavy', auth: 'oauth', authDetail: 'subscription' }),
        writeRunLedger: (entry) => {
          ledger.push({ event: entry.event, data: entry.data });
          appendRunLedgerEntry(entry, isolatedStateDir);
        },
      }),
    });

    const start = ledger.find((entry) => entry.event === 'start')!.data;
    const path = runLedgerPath('run-active-provider-identity', isolatedStateDir);
    const ledgerStart = JSON.parse(readFileSync(path, 'utf8').split('\n').find((line) => JSON.parse(line).event === 'start')!).data;
    expect({ provider: ledgerStart.provider, model: ledgerStart.model }).toEqual({ provider: 'grok', model: 'grok-4.6-heavy' });
    expect(ledgerStart).toMatchObject({ provider: 'grok', model: 'grok-4.6-heavy' });
    expect(start).toMatchObject({ provider: 'grok', model: 'grok-4.6-heavy', auth: 'oauth' });
    for (const key of ['base', 'branch', 'draft', 'feature', 'goalFile', 'goalId', 'goalSource', 'nestDepth', 'parentSessionId', 'runId', 'willFork']) {
      expect(start).toHaveProperty(key);
    }
    expect(start).toMatchObject({ parentSessionId: null, willFork: false });
    expect(start).toMatchObject({
      originAgent: 'test-origin-agent',
      originRoot: 'test-origin-root',
      originSession: 'test-origin-session',
    });
    } finally {
      for (const [name, value] of Object.entries(originEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test('start ledger persists the launch repository root and an absolute launch-cwd goal path', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'start-target-root-'));
    const launch = join(directory, 'repo');
    const launchCwd = join(launch, 'nested');
    const relativeGoal = 'docs/goals/x.md';
    const previousCwd = process.cwd();
    const runId = 'run-start-target-root';
    try {
      mkdirSync(join(launch, '.git'), { recursive: true });
      mkdirSync(join(launchCwd, 'docs', 'goals'), { recursive: true });
      writeFileSync(join(launchCwd, relativeGoal), '# Goal\n');
      process.chdir(launchCwd);
      await runSelfImplement({ feature: 'launch target root', runId, goalFile: relativeGoal, memory: false,
        writeGoalExecutionRecord: () => {}, writeGoalRunRecord: () => {},
        seams: seams({ writeRunLedger: (entry) => appendRunLedgerEntry(entry, directory) }),
      });
      const start = JSON.parse(readFileSync(runLedgerPath(runId, directory), 'utf8').split('\n').find((line) => line && JSON.parse(line).event === 'start')!).data;
      // 실행 경로는 실제 경로(cwd)를 적는다 — macOS 는 tmpdir 이 /var → /private/var 조상 링크라 realpath 로 비교한다(골 점검표 ⑨).
      expect(start).toMatchObject({ targetRoot: realpathSync(launch), goalFile: join(realpathSync(launchCwd), relativeGoal), goalSource: 'authored-goal-file' });
      expect(start).toHaveProperty('branch');
    } finally {
      process.chdir(previousCwd);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('start ledger uses absolute launch cwd when there is no git repository', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'start-nongit-root-'));
    const previousCwd = process.cwd();
    const runId = 'run-start-nongit-root';
    try {
      process.chdir(directory);
      await runSelfImplement({ feature: 'non-git target root', runId, memory: false,
        seams: seams({ writeRunLedger: (entry) => appendRunLedgerEntry(entry, directory) }),
      });
      const start = JSON.parse(readFileSync(runLedgerPath(runId, directory), 'utf8').split('\n').find((line) => line && JSON.parse(line).event === 'start')!).data;
      expect(start).toMatchObject({ targetRoot: realpathSync(directory), goalFile: null, goalSource: 'no-goal-file' });
    } finally {
      process.chdir(previousCwd);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('start ledger records a three-piece identity with zero-based position and self-excluded siblings', async () => {
    const ledger: Array<{ event: string; shardId?: string; siblingShardIds?: string[]; pieceIndex?: number; pieceTotal?: number }> = [];
    const feature = `implement the second piece\n\n## Shard identity\n${JSON.stringify({
      shardId: 'shard-b', totalShards: 3, position: 2, siblings: [
        { shardId: 'shard-a' }, { shardId: 'shard-b' }, { shardId: 'shard-c' },
      ],
    })}`;

    await runSelfImplement({
      feature,
      runId: 'run-shard-identity',
      seams: seams({ writeRunLedger: (entry) => ledger.push(entry) }),
    });

    expect(ledger.find((entry) => entry.event === 'start')).toMatchObject({
      shardId: 'shard-b', siblingShardIds: ['shard-a', 'shard-c'], pieceIndex: 1, pieceTotal: 3,
    });
  });

  test.each([
    ['unsharded request', 'implement without a shard identity'],
    ['malformed identity', 'implement with malformed identity\n\n## Shard identity\n{broken'],
  ])('start ledger records the unsharded fallback for a %s', async (_name, feature) => {
    const ledger: Array<{ event: string; shardId?: string; siblingShardIds?: string[]; pieceIndex?: number; pieceTotal?: number }> = [];

    const result = await runSelfImplement({
      feature,
      runId: `run-shard-fallback-${_name.replaceAll(' ', '-')}`,
      seams: seams({ writeRunLedger: (entry) => ledger.push(entry) }),
    });

    expect(result.ok).toBe(true);
    expect(ledger.find((entry) => entry.event === 'start')).toEqual(expect.objectContaining({ pieceTotal: 1 }));
    expect(ledger.find((entry) => entry.event === 'start')).not.toHaveProperty('shardId');
    expect(ledger.find((entry) => entry.event === 'start')).not.toHaveProperty('siblingShardIds');
    expect(ledger.find((entry) => entry.event === 'start')).not.toHaveProperty('pieceIndex');
  });

  test('start observation distinguishes missing provider values from a failed provider inspection', async () => {
    const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
    const capture = (entry: { event: string; data: Record<string, unknown> }) => { ledger.push(entry); };
    await runSelfImplement({
      feature: 'record absent provider values',
      runId: 'run-provider-values-absent',
      seams: seams({
        inspectActiveProvider: () => ({ provider: undefined as unknown as string, model: undefined as unknown as string, auth: undefined as unknown as 'none', authDetail: 'absent' }),
        writeRunLedger: capture,
      }),
    });
    await runSelfImplement({
      feature: 'survive provider inspection failure',
      runId: 'run-provider-inspection-failure',
      seams: seams({
        inspectActiveProvider: () => { throw new Error('provider inspection failed'); },
        writeRunLedger: capture,
      }),
    });

    const absent = ledger.find((entry) => entry.event === 'start' && entry.data.runId === 'run-provider-values-absent')!.data;
    const failed = ledger.find((entry) => entry.event === 'start' && entry.data.runId === 'run-provider-inspection-failure')!.data;
    expect(absent).toMatchObject({ provider: null, model: null, auth: null });
    expect(failed).toMatchObject({ provider: 'unknown', model: 'unknown', auth: 'unknown' });
  });

  // ⛔⭐ `OBS-T101` §ⓐ — 로그에는 실리는데 «원장 SQLite» 에는 0건이던 자리다(2026-08-19 02:2x 실측).
  //   원장은 GoalExecutionRecord 를 JSON 으로 굳히므로 ***이 타입에 없으면 영영 안 남는다.***
  //   ⇒ 이 회귀는 «조립 배선»을 문다 — 순수 함수 테스트만으론 배선을 지워도 초록이다(`MEAS-T83`).
  test('연합 조각의 원장 record 에 연합 키가 굳는다', async () => {
    const records: GoalExecutionRecord[] = [];
    await runSelfImplement({
      feature: [
        'federated shard ledger record',
        '## Shard identity',
        JSON.stringify({ orchestrationId: 'orch-ledger', shardId: 'task:ledger', totalShards: 3, position: 2 }),
      ].join('\n'),
      runId: 'run-ledger-federation',
      goalFile: 'docs/goals/GOAL-ledger-federation-probe.txt',
      writeGoalExecutionRecord: (_path, record) => { records.push(record); },
      seams: seams({ gateResults: [true] }),
    });
    expect(records[0]).toMatchObject({
      runId: 'run-ledger-federation',
      orchestrationId: 'orch-ledger',
      shardId: 'task:ledger',
      shardPosition: 1,        // position 2 → pieceIndex 1 (원장이 «자기 손으로» 번역한다)
      pieceTotal: 3,
    });
  });

  test('correlation을 받은 런은 terminal record에 같은 값을 남겨 조회 키가 된다', async () => {
    const records: GoalExecutionRecord[] = [];
    await runSelfImplement({
      feature: 'correlated run ledger record',
      runId: 'run-ledger-correlation',
      correlationId: 'request-zzz',
      goalFile: 'docs/goals/GOAL-ledger-correlation-probe.txt',
      writeGoalExecutionRecord: (_path, record) => { records.push(record); },
      seams: seams({ gateResults: [true] }),
    });

    expect(records).toEqual([expect.objectContaining({ runId: 'run-ledger-correlation', correlationId: 'request-zzz' })]);
    expect(records.filter((record) => record.correlationId === 'request-zzz').map((record) => record.runId))
      .toEqual(['run-ledger-correlation']);
  });

  test('correlation 없는 런은 terminal record에 빈 correlation 칸을 만들지 않는다', async () => {
    const records: GoalExecutionRecord[] = [];
    await runSelfImplement({
      feature: 'solo run ledger record',
      runId: 'run-ledger-solo',
      goalFile: 'docs/goals/GOAL-ledger-solo-probe.txt',
      writeGoalExecutionRecord: (_path, record) => { records.push(record); },
      seams: seams({ gateResults: [true] }),
    });
    expect(records[0]).toMatchObject({ runId: 'run-ledger-solo' });
    expect('correlationId' in records[0]!).toBe(false);
    expect('orchestrationId' in records[0]!).toBe(false);
    expect('shardId' in records[0]!).toBe(false);
    expect('pieceTotal' in records[0]!).toBe(false);
  });

  test('start observation preserves the supplied correlation through the terminal record', async () => {
    const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
    const records: GoalExecutionRecord[] = [];
    const feature = 'correlated start observation';
    const goalFile = 'docs/goals/GOAL-correlated-start-observation-probe.txt';
    await runSelfImplement({
      feature,
      runId: 'run-correlated-start-observation',
      correlationId: 'request-start-zzz',
      goalFile,
      writeGoalExecutionRecord: (_path, record) => { records.push(record); },
      seams: seams({
        gateResults: [true],
        writeRunLedger: (entry) => { ledger.push({ event: entry.event, data: entry.data }); },
      }),
    });

    const start = ledger.find((entry) => entry.event === 'start')!.data;
    expect(start).toMatchObject({
      feature,
      base: null,
      draft: true,
      goalFile: resolve(goalFile),
      goalSource: 'authored-goal-file',
      correlationId: 'request-start-zzz',
    });
    expect(records).toEqual([expect.objectContaining({ correlationId: start.correlationId })]);
  });

  test('start observation preserves short features and discloses bounded feature metadata', async () => {
    const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
    const shortFeature = 'short start-observation feature';
    const longFeature = 'x'.repeat(RUN_START_FEATURE_MAX_CHARS + 1);
    const capture = (entry: { event: string; data: Record<string, unknown> }) => { ledger.push(entry); };

    await runSelfImplement({
      feature: shortFeature,
      runId: 'run-start-feature-short',
      seams: seams({ gateResults: [true], writeRunLedger: capture }),
    });
    await runSelfImplement({
      feature: longFeature,
      runId: 'run-start-feature-long',
      seams: seams({ gateResults: [true], writeRunLedger: capture }),
    });

    const shortStart = ledger.find((entry) => entry.event === 'start' && entry.data.runId === 'run-start-feature-short')!.data;
    expect(shortStart).toMatchObject({
      feature: shortFeature,
      featureTruncated: false,
      featureOriginalChars: shortFeature.length,
      base: null,
      draft: true,
      goalFile: null,
      goalSource: 'no-goal-file',
    });

    const longStart = ledger.find((entry) => entry.event === 'start' && entry.data.runId === 'run-start-feature-long')!.data;
    const bounded = boundReadableText(longFeature, RUN_START_FEATURE_MAX_CHARS);
    expect(longStart).toMatchObject({
      feature: bounded.text,
      featureTruncated: true,
      featureOriginalChars: longFeature.length,
      base: null,
      draft: true,
      goalFile: null,
      goalSource: 'no-goal-file',
    });
    expect((longStart.feature as string).length).toBeLessThanOrEqual(RUN_START_FEATURE_MAX_CHARS);
  });

  test('start observation omits correlationId when the run has none', async () => {
    const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
    await runSelfImplement({
      feature: 'uncorrelated start observation',
      runId: 'run-uncorrelated-start-observation',
      seams: seams({
        gateResults: [true],
        writeRunLedger: (entry) => { ledger.push({ event: entry.event, data: entry.data }); },
      }),
    });

    const start = ledger.find((entry) => entry.event === 'start')!.data;
    expect('correlationId' in start).toBe(false);
  });

  test('start observation records the supplied goal file while preserving its source without changing it', async () => {
    const goalFile = 'docs/goals/GOAL-start-observation-goal-file.txt';
    const goalFileExistedBefore = existsSync(goalFile);
    const goalFileBefore = goalFileExistedBefore ? readFileSync(goalFile, 'utf8') : undefined;
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const records: GoalExecutionRecord[] = [];
    const original = (debug as { log: typeof debug.log }).log;
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ category, event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await runSelfImplement({
        feature: 'observe supplied goal file',
        runId: 'run-start-goal-file',
        goalFile,
        writeGoalExecutionRecord: (_path, record) => { records.push(record); },
        seams: seams({ gateResults: [true] }),
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }

    expect(records).toEqual([expect.objectContaining({ runId: 'run-start-goal-file' })]);
    expect(existsSync(goalFile)).toBe(goalFileExistedBefore);
    if (goalFileExistedBefore) expect(readFileSync(goalFile, 'utf8')).toBe(goalFileBefore!);
    expect(events).toContainEqual(expect.objectContaining({
      category: 'self-implement',
      event: 'start',
      data: expect.objectContaining({
        feature: 'observe supplied goal file',
        base: null,
        draft: true,
        goalSource: 'authored-goal-file',
        goalFile: resolve(goalFile),
      }),
    }));
  });

  test('file-backed execution records use an injected collector without changing the goal directory', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'elanous-goal-records-'));
    const goalFile = join(directory, 'GOAL-record.txt');
    writeFileSync(goalFile, '# Record goal\n');
    const snapshotGoals = () => readdirSync(directory)
      .filter((entry) => statSync(join(directory, entry)).isFile())
      .sort()
      .map((entry) => [entry, readFileSync(join(directory, entry), 'utf8')] as const);
    const before = snapshotGoals();
    const records: Array<{ goalFile: string; record: { runId: string; stage: string; outcome: string; ok: boolean } }> = [];

    await runSelfImplement({
      feature: 'record through injected collector',
      runId: 'run-injected-goal-record',
      goalFile,
      writeGoalExecutionRecord: (path, record) => { records.push({ goalFile: path, record }); },
      seams: seams({ gateResults: [true] }),
    });

    expect(records).toEqual([expect.objectContaining({
      goalFile,
      record: expect.objectContaining({ runId: 'run-injected-goal-record', stage: 'pr-opened', outcome: 'completed', ok: true }),
    })]);
    // ⛔⭐ `toBe` 는 **참조 동일성**이라 매 호출 새 배열을 내는 `snapshotGoals()` 에는
    //   ***오염 여부와 무관하게 항상 실패***한다(2026-08-03 인수 실측 · 리뷰가 그 실패를
    //   「오염이 반복된다」로 읽어 런 둘이 죽었다). 값 비교여야 한다.
    expect(snapshotGoals()).toEqual(before);
    rmSync(directory, { recursive: true, force: true });
  });

  test('copies AskFile from the goal header onto the ledger record and omits the field when the line is absent', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'elanous-orchestrator-ask-file-'));
    const withAskFile = join(directory, 'GOAL-with-ask-file.txt');
    const withoutAskFile = join(directory, 'GOAL-without-ask-file.txt');
    writeFileSync(withAskFile, 'Ask lineage\n- GoalId: 0123456789abcdef\n- GoalType: implement\n- AskFile: docs/goals/ASK-x.md\n\n');
    writeFileSync(withoutAskFile, 'No ask lineage\n- GoalId: 0123456789abcdef\n- GoalType: implement\n\n');
    const records: GoalExecutionRecord[] = [];
    try {
      for (const [runId, goalFile] of [['with-ask-file', withAskFile], ['without-ask-file', withoutAskFile]] as const) {
        await runSelfImplement({
          feature: `record ${runId}`,
          runId: `run-${runId}`,
          goalFile,
          writeGoalExecutionRecord: (_path, record) => { records.push(record); },
          seams: seams({ gateResults: [true] }),
        });
      }
      expect(records[0]?.askFile).toBe('docs/goals/ASK-x.md');
      expect(records[1]).not.toHaveProperty('askFile');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('records declared, default, and malformed GoalType provenance from leading metadata', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'elanous-orchestrator-goal-type-'));
    const goalFiles = {
      declared: join(directory, 'GOAL-declared.txt'),
      defaulted: join(directory, 'GOAL-default.txt'),
      malformed: join(directory, 'GOAL-malformed.txt'),
    };
    writeFileSync(goalFiles.declared, 'Declared goal\n- GoalId: 0123456789abcdef\n- GoalType: research\n\n');
    writeFileSync(goalFiles.defaulted, 'Default goal\n- GoalId: 0123456789abcdef\n\n');
    writeFileSync(goalFiles.malformed, 'Malformed goal\n- GoalId: 0123456789abcdef\n- GoalType: research\n- GoalType: unknown\n\n');
    const records: GoalExecutionRecord[] = [];
    try {
      for (const [runId, goalFile] of Object.entries(goalFiles)) {
        await runSelfImplement({
          feature: `record ${runId} goal type`,
          runId: `run-goal-type-${runId}`,
          goalFile,
          writeGoalExecutionRecord: (_path, record) => { records.push(record); },
          seams: seams({
            gateResults: [true],
            reviewScopeDiff: async () => 'diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n+debug.log(\'self-implement\', \'goal-type-test\', {});',
            reviewBaselineObservationSource: async () => '',
          }),
        });
      }
      expect(records).toEqual([
        expect.objectContaining({ goalType: 'research', goalTypeSource: 'declared', observationMeasurementSkipped: 'non-implement-goal-type' }),
        expect.objectContaining({ goalType: parseGoalType(readFileSync(goalFiles.defaulted, 'utf8')), goalTypeSource: 'default', observationMeasurementBasis: 'new-observation-name' }),
        expect.objectContaining({ goalTypeSource: 'malformed', observationMeasurementBasis: 'new-observation-name' }),
      ]);
      expect(records[0]).not.toHaveProperty('observationMeasurementBasis');
      expect(records[1]).not.toHaveProperty('observationMeasurementSkipped');
      expect(records[2]).not.toHaveProperty('goalType');
      expect(records[2]).not.toHaveProperty('observationMeasurementSkipped');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('appendGoalExecutionRecord serializes available GoalType provenance and leaves malformed types absent', () => {
    const directory = mkdtempSync(join(tmpdir(), 'elanous-goal-type-record-'));
    const declaredGoal = join(directory, 'GOAL-declared.txt');
    const malformedGoal = join(directory, 'GOAL-malformed.txt');
    writeFileSync(declaredGoal, '# Goal\n');
    writeFileSync(malformedGoal, '# Goal\n');
    try {
      appendGoalExecutionRecord(declaredGoal, {
        runId: 'declared-goal-type', stage: 'pr-opened', outcome: 'completed', ok: true,
        goalType: 'research', goalTypeSource: 'declared',
      });
      appendGoalExecutionRecord(malformedGoal, {
        runId: 'malformed-goal-type', stage: 'pr-opened', outcome: 'completed', ok: true,
        goalTypeSource: 'malformed',
      });
      expect(readFileSync(declaredGoal, 'utf8')).toContain('  goalType: research\n  goalTypeSource: declared\n');
      expect(readFileSync(malformedGoal, 'utf8')).toContain('  goalTypeSource: malformed\n');
      expect(readFileSync(malformedGoal, 'utf8')).not.toContain('  goalType:');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('writes document and SQLite records independently through injected seams', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'elanous-orchestrator-dual-record-'));
    const goalFile = join(directory, 'GOAL-dual-record.txt');
    writeFileSync(goalFile, '- GoalId: 0123456789abcdef\n');
    const documentRecords: GoalExecutionRecord[] = [];
    const sqliteRecords: GoalExecutionRecord[] = [];
    try {
      await runSelfImplement({
        feature: 'dual execution record',
        runId: 'run-dual-record',
        goalFile,
        writeGoalExecutionRecord: (_path, record) => { documentRecords.push(record); },
        writeGoalRunRecord: (_path, record) => { sqliteRecords.push(record); },
        seams: seams({ gateResults: [true] }),
      });
      expect(documentRecords).toEqual([expect.objectContaining({ runId: 'run-dual-record', goalContentHash: expect.any(String) })]);
      expect(sqliteRecords).toEqual([expect.objectContaining({ runId: 'run-dual-record', goalContentHash: documentRecords[0]!.goalContentHash })]);

      const documentSurvivesSqliteFailure: GoalExecutionRecord[] = [];
      await runSelfImplement({
        feature: 'document survives SQLite failure',
        runId: 'run-document-survives',
        goalFile,
        writeGoalExecutionRecord: (_path, record) => { documentSurvivesSqliteFailure.push(record); },
        writeGoalRunRecord: () => { throw new Error('injected SQLite failure'); },
        seams: seams({ gateResults: [true] }),
      });
      expect(documentSurvivesSqliteFailure).toHaveLength(1);

      const sqliteSurvivesDocumentFailure: GoalExecutionRecord[] = [];
      await runSelfImplement({
        feature: 'SQLite survives document failure',
        runId: 'run-sqlite-survives',
        goalFile,
        writeGoalExecutionRecord: () => { throw new Error('injected document failure'); },
        writeGoalRunRecord: (_path, record) => { sqliteSurvivesDocumentFailure.push(record); },
        seams: seams({ gateResults: [true] }),
      });
      expect(sqliteSurvivesDocumentFailure).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('terminal records hash only the goal body, remain stable after appending a record, and omit unreadable goal hashes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'elanous-orchestrator-goal-hash-'));
    const plainGoal = join(directory, 'GOAL-plain.txt');
    const recordedGoal = join(directory, 'GOAL-recorded.txt');
    const changedGoal = join(directory, 'GOAL-changed.txt');
    const unreadableGoal = join(directory, 'GOAL-missing.txt');
    const body = '- GoalId: 0123456789abcdef\n# Same body\n';
    writeFileSync(plainGoal, body);
    writeFileSync(recordedGoal, `${body}## 실행 기록\n- runId: previous\n`);
    writeFileSync(changedGoal, '- GoalId: 0123456789abcdef\n# Changed body\n');
    const records: GoalExecutionRecord[] = [];
    const textGoal = join(directory, 'GOAL-text.txt');
    const sqliteRecords: GoalExecutionRecord[] = [];
    writeFileSync(textGoal, body.trimEnd());
    try {
      for (const [index, goalFile] of [plainGoal, recordedGoal, changedGoal, unreadableGoal].entries()) {
        await runSelfImplement({
          feature: `goal hash ${index}`,
          runId: `run-goal-hash-${index}`,
          goalFile,
          writeGoalExecutionRecord: (_path, record) => { records.push(record); },
          seams: seams({ gateResults: [true] }),
        });
      }
      expect(records[0]!.goalContentHash).toBe(records[1]!.goalContentHash);
      expect(records[0]!.goalContentHash).not.toBe(records[2]!.goalContentHash);
      expect(records[3]!.goalContentHash).toBeUndefined();

      for (const runId of ['run-goal-hash-text-first', 'run-goal-hash-text-second']) {
        await runSelfImplement({
          feature: 'goal hash text record stability',
          runId,
          goalFile: textGoal,
          writeGoalRunRecord: (_path, record) => { sqliteRecords.push(record); },
          seams: seams({ gateResults: [true] }),
        });
      }
      expect(sqliteRecords).toHaveLength(2);
      expect(sqliteRecords[0]!.goalContentHash).toBe(sqliteRecords[1]!.goalContentHash);
      expect(readFileSync(textGoal, 'utf8')).toContain('## 실행 기록');
      expect(readFileSync(textGoal, 'utf8')).toContain(`  goalContentHash: ${sqliteRecords[0]!.goalContentHash}`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('execution record counts review findings repeated across rounds, not duplicate entries within one round', async () => {
    const records: Array<{ runId: string; stage: string; outcome: string; ok: boolean; startedAt?: string; completedAt?: string; durationMs?: number; rounds?: number; repeatedReviewFindings?: boolean; repeatedReviewFindingCount?: number; tier?: string; model?: string }> = [];
    await runSelfImplement({
      feature: 'execution record summary',
      runId: 'run-execution-record-summary',
      goalFile: reviewGoalFile(),
      maxReworkRounds: 1,
      writeGoalExecutionRecord: (_path, record) => { records.push(record); },
      seams: revSeams({
        reviews: [
          { verdict: 'fail', mustFix: ['same finding', 'same finding'] },
          { verdict: 'fail', mustFix: ['same finding'] },
        ],
      }),
    });

    expect(records).toEqual([expect.objectContaining({
      runId: 'run-execution-record-summary',
      stage: 'pr-opened',
      outcome: 'budget-exhausted',
      ok: true,
      startedAt: expect.any(String),
      completedAt: expect.any(String),
      durationMs: expect.any(Number),
      rounds: 3,
      repeatedReviewFindingKeyVersion: 'reviewFindingKey-v1',
      repeatedReviewFindings: true,
      repeatedReviewFindingCount: 1,
      verbatimRepeatedReviewFindingCount: 1,
      reviewFindingComparisonRoundCount: 3,
      tier: 'none',
    })]);
    expect(records[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('execution record does not count duplicate must-fix entries from one review as repeated findings', async () => {
    const records: Array<{ repeatedReviewFindings?: boolean; repeatedReviewFindingCount?: number; normalizedRepeatedReviewFindingCount?: number }> = [];
    await runSelfImplement({
      feature: 'deduplicate one review findings',
      runId: 'run-deduplicate-one-review',
      goalFile: reviewGoalFile(),
      maxReworkRounds: 0,
      writeGoalExecutionRecord: (_path, record) => { records.push(record); },
      seams: revSeams({
        reviews: [{ verdict: 'fail', mustFix: ['same finding', 'same finding'] }],
      }),
    });

    expect(records).toEqual([expect.objectContaining({
      repeatedReviewFindings: false,
      repeatedReviewFindingCount: 0,
      normalizedRepeatedReviewFindingCount: 0,
    })]);
  });

  test('execution record omits repeat comparison basis without multiple finding-bearing review rounds', async () => {
    const singleRoundRecords: GoalExecutionRecord[] = [];
    const noFindingRecords: GoalExecutionRecord[] = [];
    const goalFile = reviewGoalFile();

    await runSelfImplement({
      feature: 'single review comparison basis unavailable',
      runId: 'run-single-review-comparison-basis',
      goalFile,
      maxReworkRounds: 0,
      writeGoalExecutionRecord: (_path, record) => { singleRoundRecords.push(record); },
      seams: revSeams({ reviews: [{ verdict: 'fail', mustFix: ['one finding'] }] }),
    });
    await runSelfImplement({
      feature: 'no findings comparison basis unavailable',
      runId: 'run-no-findings-comparison-basis',
      goalFile,
      writeGoalExecutionRecord: (_path, record) => { noFindingRecords.push(record); },
      seams: revSeams({ reviews: [{ verdict: 'pass', mustFix: [] }] }),
    });

    expect(singleRoundRecords).toEqual([expect.objectContaining({
      repeatedReviewFindings: false,
      repeatedReviewFindingCount: 0,
    })]);
    expect(singleRoundRecords[0]).not.toHaveProperty('reviewFindingComparisonRoundCount');
    expect(noFindingRecords[0]).not.toHaveProperty('repeatedReviewFindingCount');
    expect(noFindingRecords[0]).not.toHaveProperty('reviewFindingComparisonRoundCount');
  });

  test('appendGoalExecutionRecord serializes repeat comparison basis only when available', () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-execution-record-repeat-basis-'));
    const basisGoalFile = join(directory, 'GOAL-basis.txt');
    const unavailableGoalFile = join(directory, 'GOAL-unavailable.txt');
    writeFileSync(basisGoalFile, '# Goal\n');
    writeFileSync(unavailableGoalFile, '# Goal\n');
    try {
      appendGoalExecutionRecord(basisGoalFile, {
        runId: 'run-repeat-basis', stage: 'review-blocked', outcome: 'budget-exhausted', ok: false,
        repeatedReviewFindingCount: 0, reviewFindingComparisonRoundCount: 2,
      });
      appendGoalExecutionRecord(unavailableGoalFile, {
        runId: 'run-repeat-basis-unavailable', stage: 'review-blocked', outcome: 'budget-exhausted', ok: false,
        repeatedReviewFindingCount: 0,
      });

      expect(readFileSync(basisGoalFile, 'utf8')).toContain('  repeatedReviewFindingCount: 0\n  reviewFindingComparisonRoundCount: 2\n');
      expect(readFileSync(unavailableGoalFile, 'utf8')).not.toContain('reviewFindingComparisonRoundCount:');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('execution record separately counts normalized review findings repeated across rounds', async () => {
    const records: GoalExecutionRecord[] = [];
    const roundZeroFindings = [
      'Restore `writeFileSync` failure 101 must be explicit',
      'Reverse `section` 202 must keep its note',
      'New export `FormatReverse` 303 needs a consumer',
      'Goodhart test 404 must cover the `core path`',
    ];
    const roundOneFindings = [
      'restore `writeFileSync` failure must be explicit',
      'reverse `section` must keep its note',
      'new export `FormatReverse` needs a consumer',
      'goodhart test must cover the `core path`',
    ];
    await runSelfImplement({
      feature: 'normalized execution record summary',
      runId: 'run-normalized-execution-record-summary',
      goalFile: reviewGoalFile(),
      maxReworkRounds: 1,
      writeGoalExecutionRecord: (_path, record) => { records.push(record); },
      seams: revSeams({
        reviews: [
          { verdict: 'fail', mustFix: roundZeroFindings },
          { verdict: 'fail', mustFix: roundOneFindings },
        ],
      }),
    });

    expect(records).toEqual([expect.objectContaining({
      repeatedReviewFindingKeyVersion: 'reviewFindingKey-v1',
      repeatedReviewFindings: true,
      repeatedReviewFindingCount: 4,
      verbatimRepeatedReviewFindingCount: 0,
      normalizedRepeatedReviewFindingCount: 4,
      normalizedRepeatedReviewFindingOccurrences: roundOneFindings.map((finding) => expect.objectContaining({
        hash: expect.any(String),
        firstSeenRound: 0,
        repeatedAtRound: 1,
        occurrence: 1,
        observedRoundCount: 2,
      })),
      symbolKeyedReviewFindingCount: 8,
      proseFallbackReviewFindingCount: 0,
    })]);
  });

  test('counts a normalized finding once when it repeats across three rounds', async () => {
    const records: GoalExecutionRecord[] = [];
    await runSelfImplement({
      feature: 'three round normalized finding',
      runId: 'run-three-round-normalized-finding',
      goalFile: reviewGoalFile(),
      maxReworkRounds: 2,
      writeGoalExecutionRecord: (_path, record) => { records.push(record); },
      seams: revSeams({
        reviews: [
          { verdict: 'fail', mustFix: ['Restore `writeFileSync` failure 101 must be explicit'] },
          { verdict: 'fail', mustFix: ['restore `writeFileSync` failure must be explicit'] },
          { verdict: 'fail', mustFix: ['RESTORE `writeFileSync` failure 303 must be explicit'] },
        ],
      }),
    });

    expect(records).toEqual([expect.objectContaining({
      repeatedReviewFindings: true,
      repeatedReviewFindingCount: 1,
      verbatimRepeatedReviewFindingCount: 0,
      normalizedRepeatedReviewFindingCount: 1,
      normalizedRepeatedReviewFindingOccurrences: [
        { hash: expect.any(String), firstSeenRound: 0, repeatedAtRound: 1, occurrence: 1, observedRoundCount: 2 },
        { hash: expect.any(String), firstSeenRound: 0, repeatedAtRound: 2, occurrence: 2, observedRoundCount: 3 },
      ],
      symbolKeyedReviewFindingCount: 3,
      proseFallbackReviewFindingCount: 0,
    })]);
  });

  test('forwards non-contiguous normalized repeats to diagnose with observed rounds and isolates each run', async () => {
    const alternatingTelemetry: NonNullable<Parameters<NonNullable<SelfImplementSeams['diagnose']>>[0]['reviewFindingTelemetry']>[] = [];
    const alternating = revSeams({
      reviews: [
        { verdict: 'fail', mustFix: ['Restore `validateRun` coverage'] },
        { verdict: 'fail', mustFix: ['Document `renderRun` output'] },
        { verdict: 'fail', mustFix: ['restore `validateRun` regression coverage'] },
        { verdict: 'pass', reviewed: true },
      ],
    });
    alternating.diagnose = async ({ reviewFindingTelemetry }) => {
      alternatingTelemetry.push(reviewFindingTelemetry!);
      return 'BUDGET: EXTEND\nREASON: continue';
    };
    await runSelfImplement({ feature: 'alternating review findings', runId: 'run-alternating-review-findings', maxReworkRounds: 3, seams: alternating });

    expect(alternatingTelemetry.at(-1)).toEqual(expect.objectContaining({
      normalizedReviewFindingRepeatCounts: [expect.objectContaining({
        firstSeenRound: 0,
        repeatedAtRound: 2,
        occurrence: 1,
        observedRoundCount: 2,
      })],
    }));

    const allNewTelemetry: NonNullable<Parameters<NonNullable<SelfImplementSeams['diagnose']>>[0]['reviewFindingTelemetry']>[] = [];
    const allNew = revSeams({
      reviews: [
        { verdict: 'fail', mustFix: ['Restore `alpha` coverage'] },
        { verdict: 'fail', mustFix: ['Document `beta` output'] },
        { verdict: 'pass', reviewed: true },
      ],
    });
    allNew.diagnose = async ({ reviewFindingTelemetry }) => {
      allNewTelemetry.push(reviewFindingTelemetry!);
      return 'BUDGET: EXTEND\nREASON: continue';
    };
    await runSelfImplement({ feature: 'all new review findings', runId: 'run-all-new-review-findings', maxReworkRounds: 2, seams: allNew });
    expect(allNewTelemetry.at(-1)?.normalizedReviewFindingRepeatCounts).toEqual([]);

    const singleRoundTelemetry: NonNullable<Parameters<NonNullable<SelfImplementSeams['diagnose']>>[0]['reviewFindingTelemetry']>[] = [];
    const singleRound = revSeams({
      reviews: [{ verdict: 'fail', mustFix: ['Restore `singleRound` coverage'] }, { verdict: 'pass', reviewed: true }],
    });
    singleRound.diagnose = async ({ reviewFindingTelemetry }) => {
      singleRoundTelemetry.push(reviewFindingTelemetry!);
      return 'BUDGET: EXTEND\nREASON: continue';
    };
    await runSelfImplement({ feature: 'single review finding round', runId: 'run-single-review-finding-round', maxReworkRounds: 1, seams: singleRound });
    expect(singleRoundTelemetry).toEqual([expect.objectContaining({ normalizedReviewFindingRepeatCounts: [] })]);
  });

  test('counts partial normalized reappearances once per round and does not retain findings between runs', async () => {
    const partialTelemetry: NonNullable<Parameters<NonNullable<SelfImplementSeams['diagnose']>>[0]['reviewFindingTelemetry']>[] = [];
    const partial = revSeams({
      reviews: [
        { verdict: 'fail', mustFix: ['Restore `alpha` coverage', 'Document `beta` output'] },
        { verdict: 'fail', mustFix: ['restore `alpha` regression coverage', 'Restore `alpha` regression coverage'] },
        { verdict: 'pass', reviewed: true },
      ],
    });
    partial.diagnose = async ({ reviewFindingTelemetry }) => {
      partialTelemetry.push(reviewFindingTelemetry!);
      return 'BUDGET: EXTEND\nREASON: continue';
    };
    await runSelfImplement({ feature: 'partial repeated findings', runId: 'run-partial-repeated-findings', maxReworkRounds: 2, seams: partial });
    expect(partialTelemetry.at(-1)?.normalizedReviewFindingRepeatCounts).toEqual([
      expect.objectContaining({ firstSeenRound: 0, repeatedAtRound: 1, occurrence: 1, observedRoundCount: 2 }),
    ]);

    const isolatedTelemetry: NonNullable<Parameters<NonNullable<SelfImplementSeams['diagnose']>>[0]['reviewFindingTelemetry']>[] = [];
    const isolated = revSeams({
      reviews: [
        { verdict: 'fail', mustFix: ['restore `alpha` later'] },
        { verdict: 'pass', reviewed: true },
      ],
    });
    isolated.diagnose = async ({ reviewFindingTelemetry }) => {
      isolatedTelemetry.push(reviewFindingTelemetry!);
      return 'BUDGET: EXTEND\nREASON: continue';
    };
    await runSelfImplement({ feature: 'isolated review findings', runId: 'run-isolated-review-findings', maxReworkRounds: 1, seams: isolated });
    expect(isolatedTelemetry).toEqual([expect.objectContaining({ normalizedReviewFindingRepeatCounts: [] })]);
  });

  test('observes a cited symbol repeated across distinct normalized findings without changing the normalized axis', async () => {
    const records: GoalExecutionRecord[] = [];
    await runSelfImplement({
      feature: 'cited review symbol observation',
      runId: 'run-cited-review-symbol-observation',
      goalFile: reviewGoalFile(),
      maxReworkRounds: 2,
      writeGoalExecutionRecord: (_path, record) => { records.push(record); },
      seams: revSeams({
        reviews: [
          { verdict: 'fail', mustFix: ['Removed coverage from `rfcGoalProseSection`'] },
          { verdict: 'fail', mustFix: ['Existing test for `rfcGoalProseSection` was deleted'] },
          { verdict: 'fail', mustFix: ['Restore `rfcGoalProseSection` regression coverage'] },
        ],
      }),
    });

    expect(records).toEqual([expect.objectContaining({
      repeatedReviewFindingKeyVersion: 'reviewFindingKey-v1',
      repeatedReviewFindings: true,
      repeatedReviewFindingCount: 1,
      verbatimRepeatedReviewFindingCount: 0,
      normalizedRepeatedReviewFindingCount: 1,
      symbolKeyedReviewFindingCount: 3,
      proseFallbackReviewFindingCount: 0,
      citedReviewSymbolRepeatCount: 1,
      citedReviewSymbolOccurrences: [
        expect.objectContaining({ symbol: 'rfcGoalProseSection', firstSeenRound: 0, lastSeenRound: 2, occurrence: 2 }),
      ],
    })]);
    expect(citedReviewSymbols('Use `rfcGoalProseSection` and `rfcGoalProseSection`')).toEqual([
      expect.objectContaining({ symbol: 'rfcGoalProseSection' }),
    ]);
  });

  test('uses a shared cited-symbol set as the cross-round finding key while prose-only findings remain distinct', async () => {
    const records: GoalExecutionRecord[] = [];
    await runSelfImplement({
      feature: 'symbol keyed review finding observations',
      runId: 'run-symbol-keyed-review-finding-observations',
      goalFile: reviewGoalFile(),
      maxReworkRounds: 1,
      writeGoalExecutionRecord: (_path, record) => { records.push(record); },
      seams: revSeams({
        reviews: [
          { verdict: 'fail', mustFix: ['Verify arrival logs from `debug.log` and `.elanous-test/logs.db`'] },
          { verdict: 'fail', mustFix: ['Confirm both ` .elanous-test/logs.db ` and `debug.log` receive the event'] },
        ],
      }),
    });

    const symbolKey = 'symbol:[".elanous-test/logs.db","debug.log"]';
    expect(reviewFindingKey('Verify arrival logs from `debug.log` and `.elanous-test/logs.db`')).toEqual(sharedReviewFindingKey('Verify arrival logs from `debug.log` and `.elanous-test/logs.db`'));
    expect(reviewFindingKey('Confirm both ` .elanous-test/logs.db ` and `debug.log` receive the event')).toEqual(sharedReviewFindingKey('Confirm both ` .elanous-test/logs.db ` and `debug.log` receive the event'));
    expect(reviewFindingKey('Verify arrival logs from `debug.log` and `.elanous-test/logs.db`')).toEqual({ key: symbolKey, source: 'symbol' });
    expect(shortNormalizedReviewFindingHash(symbolKey)).toBe(createHash('sha256').update(symbolKey).digest('hex').slice(0, 8));
    expect(records).toEqual([expect.objectContaining({
      normalizedRepeatedReviewFindingCount: 1,
      normalizedRepeatedReviewFindingOccurrences: [expect.objectContaining({
        hash: createHash('sha256').update(symbolKey).digest('hex').slice(0, 8),
        firstSeenRound: 0,
        repeatedAtRound: 1,
        occurrence: 1,
      })],
      symbolKeyedReviewFindingCount: 2,
      proseFallbackReviewFindingCount: 0,
    })]);

    const proseOnlyRecords: GoalExecutionRecord[] = [];
    await runSelfImplement({
      feature: 'prose fallback review finding observations',
      runId: 'run-prose-fallback-review-finding-observations',
      goalFile: reviewGoalFile(),
      maxReworkRounds: 1,
      writeGoalExecutionRecord: (_path, record) => { proseOnlyRecords.push(record); },
      seams: revSeams({
        reviews: [
          { verdict: 'fail', mustFix: ['Verify that the arrival log is persisted'] },
          { verdict: 'fail', mustFix: ['Confirm the event reaches durable storage'] },
        ],
      }),
    });
    expect(proseOnlyRecords).toEqual([expect.objectContaining({
      repeatedReviewFindingKeyVersion: REVIEW_FINDING_KEY_VERSION,
      repeatedReviewFindings: false,
      repeatedReviewFindingCount: 0,
      verbatimRepeatedReviewFindingCount: 0,
      normalizedRepeatedReviewFindingCount: 0,
      symbolKeyedReviewFindingCount: 0,
      proseFallbackReviewFindingCount: 2,
    })]);
  });

  test('observes cumulative symbol-keyed and prose-fallback finding counts for every completed review round', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const original = (debug as { log: typeof debug.log }).log;
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ category, event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await runSelfImplement({
        feature: 'reviewed finding count observations',
        maxReworkRounds: 1,
        seams: revSeams({
          reviews: [
            { verdict: 'fail', mustFix: ['Restore `reviewRound` coverage'] },
            { verdict: 'fail', mustFix: ['Document the observation event'] },
          ],
        }),
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }

    const reviewed = events.filter((entry) => entry.category === 'self-implement' && entry.event === 'reviewed' && 'round' in entry.data);
    expect(reviewed.map(({ data }) => data)).toEqual([
      expect.objectContaining({ round: 0, symbolKeyedReviewFindingCount: 1, proseFallbackReviewFindingCount: 0 }),
      expect.objectContaining({ round: 1, symbolKeyedReviewFindingCount: 1, proseFallbackReviewFindingCount: 1 }),
    ]);
  });

  test('normalizes review finding keys in the specified order and uses a fixed short SHA-256 identifier', () => {
    const normalized = normalizeReviewFindingKey('  FIX `Symbol99` 42\n NOW  ');
    expect(normalized).toBe('fix now');
    expect(shortNormalizedReviewFindingHash(normalized)).toBe('0d563489');
    expect(shortNormalizedReviewFindingHash(normalized)).toMatch(/^[0-9a-f]{8}$/);
  });

  test('terminal records retain available environment anchors and omit unavailable anchors from both ledgers', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-execution-record-environment-'));
    const completeGoalFile = join(directory, 'GOAL-complete.txt');
    const partialGoalFile = join(directory, 'GOAL-partial.txt');
    writeFileSync(completeGoalFile, '- GoalId: 0123456789abcdef\n');
    writeFileSync(partialGoalFile, '- GoalId: 0123456789abcdef\n');
    const previousSpace = process.env.ELANOUS_HARNESS_SPACE;
    const previousSpaceId = process.env.ELANOUS_HARNESS_SPACE_ID;
    process.env.ELANOUS_HARNESS_SPACE = 'self-implement';
    process.env.ELANOUS_HARNESS_SPACE_ID = 'parent-space';
    const completeRecords: GoalExecutionRecord[] = [];
    const partialRecords: GoalExecutionRecord[] = [];
    try {
      await runSelfImplement({
        feature: 'complete environment anchor record', runId: 'run-complete-environment', goalFile: completeGoalFile,
        writeGoalExecutionRecord: (path, record) => { completeRecords.push(record); appendGoalExecutionRecord(path, record); },
        seams: seams({ createWorktree: async ({ branch, base }) => ({ path: `/wt/${branch}`, branch, base, resolvedBase: 'b'.repeat(40), invokedHead: 'a'.repeat(40) }) }),
      });
      process.env.ELANOUS_HARNESS_SPACE_ID = '';
      await runSelfImplement({
        feature: 'partial environment anchor record', runId: 'run-partial-environment', goalFile: partialGoalFile,
        writeGoalExecutionRecord: (path, record) => { partialRecords.push(record); appendGoalExecutionRecord(path, record); },
        seams: seams({
          createWorktree: async ({ branch, base }) => ({ path: `/wt/${branch}`, branch, base }),
          approvePr: async () => false,
        }),
      });
    } finally {
      if (previousSpace === undefined) delete process.env.ELANOUS_HARNESS_SPACE;
      else process.env.ELANOUS_HARNESS_SPACE = previousSpace;
      if (previousSpaceId === undefined) delete process.env.ELANOUS_HARNESS_SPACE_ID;
      else process.env.ELANOUS_HARNESS_SPACE_ID = previousSpaceId;
    }

    expect(completeRecords).toEqual([expect.objectContaining({
      resolvedBase: 'b'.repeat(40), prNumber: 7, parentHarnessSpaceId: 'parent-space',
      configRoot: expect.any(String), stateRoot: expect.any(String),
    })]);
    const completeText = readFileSync(completeGoalFile, 'utf8');
    expect(completeText).toContain(`  resolvedBase: ${'b'.repeat(40)}\n  prNumber: 7\n  parentHarnessSpaceId: parent-space\n`);
    expect(completeText).toContain('  configRoot: ');
    expect(completeText).toContain('  stateRoot: ');

    expect(partialRecords).toEqual([expect.not.objectContaining({
      resolvedBase: expect.anything(), prNumber: expect.anything(), parentHarnessSpaceId: expect.anything(),
    })]);
    const partialText = readFileSync(partialGoalFile, 'utf8');
    expect(partialText).not.toContain('  resolvedBase:');
    expect(partialText).not.toContain('  prNumber:');
    expect(partialText).not.toContain('  parentHarnessSpaceId:');
  });

  test('extractSupervisorReason selects the first REASON line, trims it, bounds it, and omits missing or blank reasons', () => {
    expect(extractSupervisorReason('BUDGET: EXTEND\nREASON:   first reason  \nREASON: later reason')).toBe('first reason');
    expect(extractSupervisorReason('REASON:   \nREASON: retained reason')).toBeUndefined();
    expect(extractSupervisorReason('BUDGET: EXTEND\nREASON:   ')).toBeUndefined();
    expect(extractSupervisorReason('BUDGET: EXTEND')).toBeUndefined();
    expect(extractSupervisorReason(`REASON: ${'x'.repeat(SUPERVISOR_REASON_RECORD_MAX_CHARS + 1)}`))
      .toBe('x'.repeat(SUPERVISOR_REASON_RECORD_MAX_CHARS));
  });

  test('appendGoalExecutionRecord serializes supervisor verdict and reason when present', () => {
    const goalFile = `${mkdtempSync(join(tmpdir(), 'goal-execution-record-supervisor-verdict-'))}/GOAL.txt`;
    writeFileSync(goalFile, '# Goal\n');

    appendGoalExecutionRecord(goalFile, {
      runId: 'run-supervisor-verdict', stage: 'review-blocked', outcome: 'abandoned', ok: false,
      supervisorVerdict: 'CONTRACT-CONFLICT', supervisorReason: 'contract and implementation conflict',
    });

    expect(readFileSync(goalFile, 'utf8')).toContain('  supervisorVerdict: CONTRACT-CONFLICT\n  supervisorReason: contract and implementation conflict\n');
  });

  test('CONTRACT-CONFLICT는 기존 상한 안에서 계속하며 원장과 다음 자식에 계획 수정 사실 및 감독 이유를 전달한다', async () => {
    const goalFile = `${mkdtempSync(join(tmpdir(), 'goal-execution-record-plan-revision-'))}/GOAL.txt`;
    const features: string[] = [];
    const records: GoalExecutionRecord[] = [];
    const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
    let openedBody = '';
    writeFileSync(goalFile, '# Goal\n\n## PROBLEM\nOriginal contract remains readable.\n\n## ACCEPTANCE CRITERIA\n- AC-1: Keep the legacy API.\n');
    const supervised = seams({ gateResults: [false, true], features });
    supervised.writeRunLedger = (entry) => { ledger.push({ event: entry.event, data: entry.data }); };
    supervised.openPr = async ({ body, head }) => { openedBody = body; return { url: `https://pr/${head}`, number: 7 }; };
    supervised.diagnose = async () => 'BUDGET: CONTRACT-CONFLICT\nREASON: 골 보존 기준이 현장 API와 어긋난다\nTARGET: - AC-1: Keep the legacy API.\nEXPECTED: - AC-1: Keep the legacy API.\nREPLACEMENT: - AC-1: Preserve the supported runtime API.\n계획을 수정해 구현을 계속하라';

    const result = await runSelfImplement({
      feature: 'plan revision supervision', maxReworkRounds: 1, goalFile, seams: supervised,
      writeGoalExecutionRecord: (path, record) => { records.push(record); appendGoalExecutionRecord(path, record); },
    });

    expect(result).toMatchObject({ ok: true, stage: 'pr-opened', supervisorReason: '골 보존 기준이 현장 API와 어긋난다' });
    expect(records).toEqual([expect.objectContaining({ supervisorVerdict: 'CONTRACT-CONFLICT', supervisorReason: '골 보존 기준이 현장 API와 어긋난다' })]);
    const persistedGoal = readFileSync(goalFile, 'utf8');
    expect(persistedGoal).toContain('  supervisorVerdict: CONTRACT-CONFLICT\n  supervisorReason: 골 보존 기준이 현장 API와 어긋난다\n');
    expect(persistedGoal).toContain('## PROBLEM\nOriginal contract remains readable.');
    expect(persistedGoal).toContain('- AC-1: Preserve the supported runtime API.');
    expect(persistedGoal).toContain('## SUPERVISOR PLAN REVISIONS\n- verdict: CONTRACT-CONFLICT\n  - round: 1\n  - reason: 골 보존 기준이 현장 API와 어긋난다\n  - target: - AC-1: Keep the legacy API.\n  - previous: - AC-1: Keep the legacy API.\n  - replacement: - AC-1: Preserve the supported runtime API.\n  - application: applied');
    expect(features).toHaveLength(2);
    expect(features[1]).toContain('[감독 계획 수정 지시 — 현장이 기존 계획과 어긋남]');
    expect(features[1]).toContain('감독 이유: 골 보존 기준이 현장 API와 어긋난다');
    expect(features[1]).toContain('- 적용: applied');
    expect(features[1]).not.toContain('골 문서는 이 라운드에서 고쳐 쓰지 않는다');
    expect(ledger.find(({ event }) => event === 'rework-budget')!.data).toMatchObject({ contractConflictDisposition: 'first-observed', contractConflictRelaxation: { target: '- AC-1: Keep the legacy API.', expected: '- AC-1: Keep the legacy API.', replacement: '- AC-1: Preserve the supported runtime API.', application: 'applied' } });
    expect(openedBody).toContain('## 감독 수용 기준 완화');
    expect(openedBody).toContain('- 이전: - AC-1: Keep the legacy API.');
    expect(openedBody).toContain('- 완화: - AC-1: Preserve the supported runtime API.');
    expect(openedBody).toContain('- 이유: 골 보존 기준이 현장 API와 어긋난다');
  });

  test('supervisor relaxation appears in blocked-draft and review-budget PRs only when recorded', async () => {
    const target = '- AC-1: Preserve the blocked-run context.';
    const diagnosis = `BUDGET: CONTRACT-CONFLICT\nREASON: blocked-run contract correction\nTARGET: ${target}\nEXPECTED: ${target}\nREPLACEMENT: - AC-1: Preserve the corrected blocked-run context.`;
    const captureBlockedDraft = async (withRelaxation: boolean): Promise<string> => {
      let body = '';
      const s = seams({ gateResults: [false, false] });
      s.openPr = async (input) => { body = input.body; return { url: 'https://pr/blocked', number: 11 }; };
      if (withRelaxation) s.diagnose = async () => diagnosis;
      await runSelfImplement({ feature: 'blocked draft relaxation body', maxReworkRounds: 1, seams: s });
      return body;
    };
    const captureReviewBudget = async (withRelaxation: boolean): Promise<string> => {
      let body = '';
      const s = revSeams({
        gateResults: [false, true, true],
        reviews: [
          { verdict: 'fail', mustFix: ['blocked finding'] },
          { verdict: 'fail', mustFix: ['blocked finding'] },
        ],
      });
      s.openPr = async (input) => { body = input.body; return { url: 'https://pr/review-budget', number: 12 }; };
      if (withRelaxation) s.diagnose = async () => diagnosis;
      await runSelfImplement({ feature: 'review budget relaxation body', autoMerge: true, maxReworkRounds: 1, seams: s });
      return body;
    };

    const blockedWithRelaxation = await captureBlockedDraft(true);
    const reviewBudgetWithRelaxation = await captureReviewBudget(true);
    const blockedWithoutRelaxation = await captureBlockedDraft(false);
    const reviewBudgetWithoutRelaxation = await captureReviewBudget(false);

    for (const body of [blockedWithRelaxation, reviewBudgetWithRelaxation]) {
      expect(body).toContain('## 감독 수용 기준 완화');
      expect(body).toContain(`- 대상: ${target}`);
    }
    expect(blockedWithoutRelaxation).not.toContain('## 감독 수용 기준 완화');
    expect(reviewBudgetWithoutRelaxation).not.toContain('## 감독 수용 기준 완화');
  });

  test('supervisor REASON survives a later merge terminal result and goal record', async () => {
    const goalFile = `${mkdtempSync(join(tmpdir(), 'goal-execution-record-merge-reason-'))}/GOAL.txt`;
    writeFileSync(goalFile, '# Goal\n');
    const records: GoalExecutionRecord[] = [];
    const supervised = seams({ gateResults: [false, true] });
    supervised.diagnose = async () => 'BUDGET: EXTEND\nREASON: merge after the bounded retry';
    supervised.mergeMain = async () => ({ status: 'merged', base: 'origin/main' });

    const result = await runSelfImplement({
      feature: 'merge terminal supervisor reason', maxReworkRounds: 1, autoMerge: true, goalFile, seams: supervised,
      writeGoalExecutionRecord: (_path, record) => { records.push(record); },
    });

    expect(result).toMatchObject({ stage: 'pr-opened', supervisorReason: 'merge after the bounded retry' });
    expect(records).toEqual([expect.objectContaining({ supervisorReason: 'merge after the bounded retry' })]);
  });

  test('runSelfImplement은 수용된 반박 뒤 동일 ID 재발을 rework-budget에 별도 기록한다', async () => {
    const dismissed = '잘못된 `src/dismissed.ts` 인증 경로 지적';
    const ordinary = '미해결 `src/ordinary.ts` 오류 경로 지적';
    const dismissedId = stableMustFixId(dismissed);
    const acceptanceQuote = '- Checkable requested criterion: recurrence';
    const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
    let implementation = 0;
    let reviewCall = 0;
    const s2 = seams({
      gateResults: [true, true, true, true],
      implement: async () => ({
        ok: true,
        summary: ++implementation === 2
          ? `REFUTE [${dismissedId}] ${JSON.stringify(acceptanceQuote)} — 코드와 인용 경로가 지적을 반박한다.`
          : 'implementation complete',
      }),
      reviewDiff: async () => {
        reviewCall += 1;
        return reviewCall === 1
          ? { verdict: 'fail' as const, mustFix: [dismissed, ordinary], shouldFix: [], summary: 'first', reviewed: true }
          : reviewCall === 2
            ? { verdict: 'fail' as const, mustFix: [dismissed, ordinary], shouldFix: [], summary: 'second', reviewed: true }
            : reviewCall === 3
              ? { verdict: 'fail' as const, mustFix: [dismissed, ordinary], shouldFix: [], summary: 'third', reviewed: true }
              : { verdict: 'pass' as const, mustFix: [], shouldFix: [], summary: 'done', reviewed: true };
      },
    });
    s2.writeRunLedger = (entry) => { ledger.push({ event: entry.event, data: entry.data }); };
    s2.diagnose = async () => reviewCall === 2
      ? `BUDGET: EXTEND\nREASON: retry\nREFUTE [${dismissedId}]: ACCEPT`
      : 'BUDGET: EXTEND\nREASON: retry';

    const result = await runSelfImplement({
      feature: `recurrence telemetry wiring\n${acceptanceQuote}\n${buildRefutationGuidance()}`,
      maxReworkRounds: 3,
      seams: s2,
    });

    expect(result).toMatchObject({ ok: true, stage: 'pr-opened' });
    expect(ledger).toContainEqual(expect.objectContaining({
      event: 'refute-supervisor-adjudicated',
      data: expect.objectContaining({ findingIds: [dismissedId], acceptedCount: 1 }),
    }));
    const splitBudget = ledger.filter(({ event }) => event === 'rework-budget')
      .map(({ data }) => data)
      .find((data) => data.previouslyDismissedRepeatedReviewFindingCount === 1);
    expect(splitBudget).toMatchObject({
      normalizedRepeatedReviewFindingCount: 2,
      ordinaryRepeatedReviewFindingCount: 1,
      previouslyDismissedRepeatedReviewFindingCount: 1,
    });
  });

  test('rework-budget recurrence disagreement helper는 심볼 반복과 차단 반복의 존재 여부 갈림만 값으로 남긴다', () => {
    const recurrence = (symbolRepeatCount: number) => ({
      normalizedRepeatedReviewFindingCount: symbolRepeatCount,
      ordinaryRepeatedReviewFindingCount: symbolRepeatCount,
      previouslyDismissedRepeatedReviewFindingCount: 0,
      citedReviewSymbolRepeatCount: symbolRepeatCount,
      citedReviewSymbolBaseNameRepeatCount: 0,
      comparableFindings: Math.max(1, symbolRepeatCount),
      reviewFindingKeyRepeatCount: 0,
    });
    const cases = [
      { blockingIds: [] as string[], symbolCount: 0, terminalUnconvergeable: false, expected: { recurrenceDisagreement: false, recurrenceDisagreementKind: 'none', recurrenceDisagreementTerminalUnconvergeable: false } },
      { blockingIds: [] as string[], symbolCount: 1, terminalUnconvergeable: true, expected: { recurrenceDisagreement: true, recurrenceDisagreementKind: 'symbol-repeat-without-blocking-repeat', recurrenceDisagreementTerminalUnconvergeable: true } },
      { blockingIds: ['blocking-only'], symbolCount: 0, terminalUnconvergeable: true, expected: { recurrenceDisagreement: true, recurrenceDisagreementKind: 'blocking-repeat-without-symbol-repeat', recurrenceDisagreementTerminalUnconvergeable: true } },
      { blockingIds: [] as string[], symbolCount: 1, terminalUnconvergeable: false, expected: { recurrenceDisagreement: true, recurrenceDisagreementKind: 'symbol-repeat-without-blocking-repeat', recurrenceDisagreementTerminalUnconvergeable: false } },
      { blockingIds: ['a', 'b'], symbolCount: 1, terminalUnconvergeable: false, expected: { recurrenceDisagreement: false, recurrenceDisagreementKind: 'none', recurrenceDisagreementTerminalUnconvergeable: false } },
      { blockingIds: ['a'], symbolCount: 2, terminalUnconvergeable: true, expected: { recurrenceDisagreement: false, recurrenceDisagreementKind: 'none', recurrenceDisagreementTerminalUnconvergeable: false } },
    ];
    for (const { blockingIds, symbolCount, terminalUnconvergeable, expected } of cases) {
      expect(reworkBudgetRecurrenceDisagreementObservation(blockingIds, recurrence(symbolCount), terminalUnconvergeable)).toMatchObject({
        ...expected,
        recurrenceDisagreementSymbolRepeatCount: symbolCount,
        recurrenceDisagreementBlockingRepeatCount: blockingIds.length,
      });
    }
    expect(reworkBudgetRecurrenceDisagreementObservation(undefined, null, true)).toEqual({
      recurrenceDisagreement: null,
      recurrenceDisagreementKind: 'unmeasured',
      recurrenceDisagreementSymbolRepeatCount: null,
      recurrenceDisagreementBlockingRepeatCount: null,
      recurrenceDisagreementTerminalUnconvergeable: null,
    });
  });

  test('runSelfImplement은 같은 rework-budget 관측에 측정된 recurrence disagreement와 실제 blocked 결말 여부를 함께 싣는다', async () => {
    const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
    let reviewCall = 0;
    const s2 = seams({ gateResults: [true, true, true] });
    s2.writeRunLedger = (entry) => { ledger.push({ event: entry.event, data: entry.data }); };
    s2.reworkBudgetReviewFindingRecurrence = () => ({
      normalizedRepeatedReviewFindingCount: 0,
      ordinaryRepeatedReviewFindingCount: 0,
      previouslyDismissedRepeatedReviewFindingCount: 0,
      citedReviewSymbolRepeatCount: 0,
      citedReviewSymbolBaseNameRepeatCount: 1,
      comparableFindings: 1,
      reviewFindingKeyRepeatCount: 0,
    });
    s2.reviewDiff = async () => {
      reviewCall += 1;
      return reviewCall === 1
        ? { verdict: 'fail' as const, mustFix: ['`Alpha.close()` is still broken'], shouldFix: [], summary: 'first', reviewed: true }
        : { verdict: 'fail' as const, mustFix: ['`Beta.open()` is still broken'], shouldFix: [], summary: 'second', reviewed: true };
    };
    let diagnoseCall = 0;
    s2.diagnose = async () => {
      diagnoseCall += 1;
      return diagnoseCall === 1
        ? 'BUDGET: EXTEND\nREASON: collect one more measured review round'
        : 'BUDGET: UNCONVERGEABLE\nREASON: repeated symbol-level finding did not converge';
    };

    await runSelfImplement({ feature: 'observe recurrence disagreement terminal', maxReworkRounds: 2, reworkBudgetShadowStop: false, seams: s2 });

    const budget = ledger.filter(({ event }) => event === 'rework-budget').at(-1)?.data;
    expect(budget).toMatchObject({
      verdict: 'UNCONVERGEABLE',
      stopped: true,
      exit: 'blocked',
      repeatedBlockingFindingCount: 0,
      citedReviewSymbolBaseNameRepeatCount: 1,
      recurrenceDisagreement: true,
      recurrenceDisagreementKind: 'symbol-repeat-without-blocking-repeat',
      recurrenceDisagreementSymbolRepeatCount: 1,
      recurrenceDisagreementBlockingRepeatCount: 0,
      recurrenceDisagreementTerminalUnconvergeable: true,
    });
  });

  test('주입 recurrence는 total과 split을 한 출처에서 원자적으로 기록한다', async () => {
    const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
    const injectedRecurrence = {
      normalizedRepeatedReviewFindingCount: 3,
      ordinaryRepeatedReviewFindingCount: 2,
      previouslyDismissedRepeatedReviewFindingCount: 1,
      citedReviewSymbolRepeatCount: 0,
      citedReviewSymbolBaseNameRepeatCount: 0,
      comparableFindings: 0,
      reviewFindingKeyRepeatCount: 0,
    };
    const s2 = seams({ gateResults: [false, true] });
    s2.writeRunLedger = (entry) => { ledger.push({ event: entry.event, data: entry.data }); };
    s2.reworkBudgetReviewFindingRecurrence = () => injectedRecurrence;
    s2.diagnose = async () => 'BUDGET: EXTEND\nREASON: inspect injected recurrence';

    await runSelfImplement({ feature: 'atomic injected recurrence', maxReworkRounds: 1, seams: s2 });

    const budget = ledger.filter(({ event }) => event === 'rework-budget').at(-1)?.data;
    expect(budget).toMatchObject({
      normalizedRepeatedReviewFindingCount: injectedRecurrence.normalizedRepeatedReviewFindingCount,
      ordinaryRepeatedReviewFindingCount: injectedRecurrence.ordinaryRepeatedReviewFindingCount,
      previouslyDismissedRepeatedReviewFindingCount: injectedRecurrence.previouslyDismissedRepeatedReviewFindingCount,
      citedReviewSymbolRepeatCount: injectedRecurrence.citedReviewSymbolRepeatCount,
      citedReviewSymbolBaseNameRepeatCount: injectedRecurrence.citedReviewSymbolBaseNameRepeatCount,
      reviewFindingComparableCount: injectedRecurrence.comparableFindings,
      reviewFindingKeyRepeatCount: injectedRecurrence.reviewFindingKeyRepeatCount,
      recurrenceDisagreement: null,
      recurrenceDisagreementKind: 'unmeasured',
      recurrenceDisagreementSymbolRepeatCount: 0,
      recurrenceDisagreementBlockingRepeatCount: null,
      recurrenceDisagreementTerminalUnconvergeable: null,
    });
    const ordinary = budget?.ordinaryRepeatedReviewFindingCount;
    const dismissed = budget?.previouslyDismissedRepeatedReviewFindingCount;
    const normalized = budget?.normalizedRepeatedReviewFindingCount;
    if (typeof ordinary !== 'number' || typeof dismissed !== 'number' || typeof normalized !== 'number') {
      throw new Error('complete injected recurrence was not recorded');
    }
    expect(ordinary + dismissed).toBe(normalized);
  });

  test('⭐⭐ rework-budget 판사 입력과 원장이 같은 판정 전 예측 성적을 보존한다', async () => {
    // ⛔ 리뷰 #10607 must-fix: helper 결과만 비교하는 시험은 「판사 입력과 관측에 함께 배선됐나」를 증명하지 못한다.
    const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
    const predictionInputs: Array<Parameters<NonNullable<SelfImplementSeams['diagnose']>>[0]['judgePredictionAccuracy']> = [];
    const s2 = seams({ gateResults: [false, false, false, true] });
    s2.writeRunLedger = (entry) => { ledger.push({ event: entry.event, data: entry.data }); };
    s2.diagnose = async ({ judgePredictionAccuracy }) => {
      predictionInputs.push(judgePredictionAccuracy);
      return 'BUDGET: EXTEND\nREASON: 한 라운드 안에 해결 가능하다';
    };

    await runSelfImplement({ feature: 'judge prediction telemetry', maxReworkRounds: 3, seams: s2 });

    const budgets = ledger.filter(({ event }) => event === 'rework-budget').map(({ data }) => data);
    expect(budgets.length).toBeGreaterThan(1);
    expect(predictionInputs[0]).toBeUndefined();

    for (const [index, budget] of budgets.entries()) {
      expect(Object.keys(budget)).toEqual(expect.arrayContaining([
        'judgePredictedBefore', 'judgeFulfilledBefore', 'judgeMissedBefore', 'judgePendingBefore',
      ]));
      const input = predictionInputs[index];
      if (input) {
        const observed = budget as Record<'judgePredictedBefore' | 'judgeFulfilledBefore' | 'judgeMissedBefore' | 'judgePendingBefore', number>;
        expect(input).toEqual({
          predicted: observed.judgePredictedBefore,
          fulfilled: observed.judgeFulfilledBefore,
          missed: observed.judgeMissedBefore,
          pending: observed.judgePendingBefore,
        });
      }
    }

    // 첫 라운드는 이력이 없어 정확도 사실을 만들지 않고, 원장 관측 계약은 기존대로 0을 보존한다.
    expect(budgets[0]).toMatchObject({ judgePredictedBefore: 0, judgeMissedBefore: 0 });

    // 반복 EXTEND의 미이행 예측은 이후 판사 입력과 원장에서 함께 증가한다.
    const missed = budgets.map((budget) => budget.judgeMissedBefore as number);
    expect(missed[missed.length - 1]).toBeGreaterThan(missed[0]!);
    expect(predictionInputs.at(-1)?.missed).toBe(missed[missed.length - 1]);
  });

  test('rework-budget ledger observes first and repeated CONTRACT-CONFLICT dispositions while omitting non-conflicts', async () => {
    const conflictLedger: Array<{ event: string; data: Record<string, unknown> }> = [];
    const conflicting = seams({ gateResults: [false, false, true] });
    conflicting.writeRunLedger = (entry) => { conflictLedger.push({ event: entry.event, data: entry.data }); };
    conflicting.diagnose = async () => 'BUDGET: CONTRACT-CONFLICT\nREASON: the contract conflicts with the implementation';

    const conflictResult = await runSelfImplement({
      feature: 'observe repeated contract conflicts', maxReworkRounds: 2, seams: conflicting,
    });

    expect(conflictResult).toMatchObject({ ok: true, stage: 'pr-opened' });
    const conflictBudgets = conflictLedger.filter(({ event }) => event === 'rework-budget').map(({ data }) => data);
    expect(conflictBudgets).toHaveLength(2);
    expect(conflictBudgets[0]).toMatchObject({
      round: 1,
      verdict: 'CONTRACT-CONFLICT',
      contractConflictDisposition: 'first-observed',
      applied: false,
      stopped: false,
      exit: 'continue',
    });
    expect(conflictBudgets[1]).toMatchObject({
      round: 2,
      verdict: 'CONTRACT-CONFLICT',
      contractConflictDisposition: 'repeated',
      applied: false,
      stopped: false,
      exit: 'continue',
    });

    const nonConflictLedger: Array<{ event: string; data: Record<string, unknown> }> = [];
    const nonConflicting = seams({ gateResults: [false, true] });
    nonConflicting.writeRunLedger = (entry) => { nonConflictLedger.push({ event: entry.event, data: entry.data }); };
    nonConflicting.diagnose = async () => 'BUDGET: EXTEND\nREASON: continue with the existing contract';

    await runSelfImplement({ feature: 'omit non-conflict disposition', maxReworkRounds: 1, seams: nonConflicting });

    const nonConflictBudget = nonConflictLedger.find(({ event }) => event === 'rework-budget')!.data;
    expect(nonConflictBudget).toMatchObject({ verdict: 'EXTEND', applied: true, stopped: false, exit: 'continue' });
    expect(nonConflictBudget).not.toHaveProperty('contractConflictDisposition');
  });

  test('CONTRACT-CONFLICT가 아닌 감독 판정은 골 문서를 바꾸지 않는다', async () => {
    const goalFile = `${mkdtempSync(join(tmpdir(), 'goal-execution-record-non-conflict-'))}/GOAL.txt`;
    const originalGoal = '# Goal\n\n## PROBLEM\nOriginal contract remains readable.\n';
    writeFileSync(goalFile, originalGoal);
    const supervised = seams({ gateResults: [false, true] });
    supervised.diagnose = async () => 'BUDGET: EXTEND\nREASON: continue with the existing contract';

    await runSelfImplement({
      feature: 'non-conflict supervision', maxReworkRounds: 1, goalFile, seams: supervised,
      writeGoalExecutionRecord: () => {},
    });

    expect(readFileSync(goalFile, 'utf8')).toBe(originalGoal);
  });

  test('실제 defaultSeams 감독 문면은 REFUTE 없이도 구현과 계약이 양립 불가하면 CONTRACT-CONFLICT를 허용한다', async () => {
    const prompts: string[] = [];
    const productionSeams = defaultSeams({
      llmReview: async (prompt) => {
        prompts.push(prompt);
        return 'BUDGET: CONTRACT-CONFLICT\nREASON: 보존 계약의 API 형태가 현장 구현과 양립하지 않는다';
      },
    });

    const diagnosis = await productionSeams.diagnose!({
      runId: 'run-contract-conflict-without-refute', note: '[리뷰 must-fix — 반드시 반영]\n- 계약 충돌', kind: 'review', round: 1,
      cwd: process.cwd(), goal: '골 수용·보존 계약과 현장 API가 충돌한다.', history: [], effectiveMax: 2,
    });

    expect(diagnosis).toContain('BUDGET: CONTRACT-CONFLICT');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('타당한 자식 REFUTE는 이 판단의 근거가 될 수 있지만 제출이 없어도 구현과 계약만으로 동시에 만족시킬 수 없는 충돌이면 이 값을 선택한다.');
    expect(prompts[0]).toContain('TARGET: <## ACCEPTANCE CRITERIA 안의 전체 원문 한 줄>, EXPECTED: <그 TARGET 행의 현재 한 줄>, REPLACEMENT: <그 TARGET 행에서 완화한 한 줄>');
    expect(prompts[0]).toContain('## ACCEPTANCE CRITERIA 안에서 정확히 한 수용 기준 행');
    expect(prompts[0]).not.toContain('자식 REFUTE 제출(라운드');
  });

  test('terminal records retain EXTEND after a successful rework and omit verdict without supervision', async () => {
    const goalFile = `${mkdtempSync(join(tmpdir(), 'goal-execution-record-last-supervisor-verdict-'))}/GOAL.txt`;
    writeFileSync(goalFile, '# Goal\n');
    const supervisedRecords: GoalExecutionRecord[] = [];
    const supervised = seams({ gateResults: [false, true] });
    supervised.diagnose = async () => 'BUDGET: EXTEND\nREASON: one more round';

    await runSelfImplement({
      feature: 'record successful EXTEND supervision',
      runId: 'run-successful-extend-record',
      goalFile,
      writeGoalExecutionRecord: (path, record) => {
        supervisedRecords.push(record);
        appendGoalExecutionRecord(path, record);
      },
      seams: supervised,
    });

    const unsupervisedRecords: GoalExecutionRecord[] = [];
    await runSelfImplement({
      feature: 'record unsupervised completion',
      runId: 'run-unsupervised-record',
      goalFile,
      writeGoalExecutionRecord: (_path, record) => { unsupervisedRecords.push(record); },
      seams: seams({ gateResults: [true] }),
    });

    expect(supervisedRecords).toEqual([expect.objectContaining({
      runId: 'run-successful-extend-record', ok: true, stage: 'pr-opened', supervisorVerdict: 'EXTEND', supervisorReason: 'one more round',
    })]);
    expect(readFileSync(goalFile, 'utf8')).toContain('  supervisorVerdict: EXTEND\n  supervisorReason: one more round\n');
    expect(unsupervisedRecords).toEqual([expect.not.objectContaining({ supervisorVerdict: expect.anything(), supervisorReason: expect.anything() })]);
  });

  test('appendGoalExecutionRecord serializes normalized findings literally and omits an empty occurrence array', () => {
    const goalFile = `${mkdtempSync(join(tmpdir(), 'goal-execution-record-normalized-'))}/GOAL.txt`;
    writeFileSync(goalFile, '# Goal\n');
    appendGoalExecutionRecord(goalFile, {
      runId: 'run-normalized-serialization', stage: 'review-blocked', outcome: 'budget-exhausted', ok: false,
      repeatedReviewFindingKeyVersion: 'reviewFindingKey-v1',
      repeatedReviewFindings: true,
      repeatedReviewFindingCount: 1,
      verbatimRepeatedReviewFindingCount: 1,
      normalizedRepeatedReviewFindingCount: 1,
      normalizedRepeatedReviewFindingOccurrences: [{ hash: '8becc44f', firstSeenRound: 0, repeatedAtRound: 2, occurrence: 2 }],
      symbolKeyedReviewFindingCount: 1,
      proseFallbackReviewFindingCount: 2,
    });
    expect(readFileSync(goalFile, 'utf8')).toBe('# Goal\n## 실행 기록\n- runId: run-normalized-serialization\n  stage: review-blocked\n  outcome: budget-exhausted\n  ok: false\n  repeatedReviewFindingKeyVersion: reviewFindingKey-v1\n  repeatedReviewFindings: true\n  repeatedReviewFindingCount: 1\n  verbatimRepeatedReviewFindingCount: 1\n  normalizedRepeatedReviewFindingCount: 1\n  normalizedRepeatedReviewFinding: hash=8becc44f firstSeenRound=0 repeatedAtRound=2 occurrence=2\n  symbolKeyedReviewFindingCount: 1\n  proseFallbackReviewFindingCount: 2\n');

    const citedGoalFile = `${mkdtempSync(join(tmpdir(), 'goal-execution-record-cited-symbol-'))}/GOAL.txt`;
    writeFileSync(citedGoalFile, '# Goal\n');
    appendGoalExecutionRecord(citedGoalFile, {
      runId: 'run-cited-symbol-serialization', stage: 'review-blocked', outcome: 'budget-exhausted', ok: false,
      citedReviewSymbolRepeatCount: 1,
      citedReviewSymbolOccurrences: [{ hash: '72ad3e29754e2c13', symbol: 'rfcGoalProseSection', firstSeenRound: 0, lastSeenRound: 2, occurrence: 2 }],
    });
    expect(readFileSync(citedGoalFile, 'utf8')).toContain('  citedReviewSymbolRepeatCount: 1\n  citedReviewSymbol: hash=72ad3e29754e2c13 symbol="rfcGoalProseSection" firstSeenRound=0 lastSeenRound=2 occurrence=2\n');

    const emptyGoalFile = `${mkdtempSync(join(tmpdir(), 'goal-execution-record-empty-normalized-'))}/GOAL.txt`;
    writeFileSync(emptyGoalFile, '# Goal\n');
    appendGoalExecutionRecord(emptyGoalFile, {
      runId: 'run-empty-normalized-serialization', stage: 'pr-opened', outcome: 'completed', ok: true,
      normalizedRepeatedReviewFindingCount: 0,
      normalizedRepeatedReviewFindingOccurrences: [],
    });
    const emptyWritten = readFileSync(emptyGoalFile, 'utf8');
    expect(emptyWritten).toContain('  normalizedRepeatedReviewFindingCount: 0\n');
    expect(emptyWritten).not.toContain('  normalizedRepeatedReviewFinding:');
  });

  test('serializes cited symbols as bounded JSON values and caps collection without changing normalized observations', async () => {
    const injectedSymbol = 'line-one\nfirstSeenRound=99\\control`quote';
    const goalFile = `${mkdtempSync(join(tmpdir(), 'goal-execution-record-safe-cited-symbol-'))}/GOAL.txt`;
    writeFileSync(goalFile, '# Goal\n');
    appendGoalExecutionRecord(goalFile, {
      runId: 'run-safe-cited-symbol-serialization', stage: 'review-blocked', outcome: 'budget-exhausted', ok: false,
      citedReviewSymbolRepeatCount: 1,
      citedReviewSymbolOccurrences: [{ hash: 'test-symbol-hash', symbol: injectedSymbol, firstSeenRound: 0, lastSeenRound: 1, occurrence: 1 }],
    });
    const written = readFileSync(goalFile, 'utf8');
    expect(written).toContain(`  citedReviewSymbol: hash=test-symbol-hash symbol=${JSON.stringify(injectedSymbol)} firstSeenRound=0 lastSeenRound=1 occurrence=1\n`);
    expect(written).not.toContain('  citedReviewSymbol: symbol=line-one\n');

    expect(MAX_CITED_REVIEW_SYMBOL_CHARS).toBe(256);
    const oversizedSymbol = 'x'.repeat(MAX_CITED_REVIEW_SYMBOL_CHARS + 1);
    expect(citedReviewSymbols(`Use \`${oversizedSymbol}\``)).toEqual([
      expect.objectContaining({ symbol: 'x'.repeat(MAX_CITED_REVIEW_SYMBOL_CHARS) }),
    ]);

    const records: GoalExecutionRecord[] = [];
    const symbols = Array.from({ length: MAX_CITED_REVIEW_SYMBOLS_PER_RUN + 1 }, (_, index) => `symbol${index}`);
    const finding = `Missing coverage ${symbols.map((symbol) => `\`${symbol}\``).join(' ')}`;
    await runSelfImplement({
      feature: 'bounded cited review symbols',
      runId: 'run-bounded-cited-review-symbols',
      memory: false,
      goalFile: (() => {
        const path = `${mkdtempSync(join(tmpdir(), 'bounded-cited-review-symbols-'))}/GOAL.txt`;
        writeFileSync(path, '# Goal\n');
        return path;
      })(),
      maxReworkRounds: 1,
      writeGoalExecutionRecord: (_path, record) => { records.push(record); },
      seams: revSeams({ reviews: [
        { verdict: 'fail', mustFix: [finding] },
        { verdict: 'fail', mustFix: [finding] },
      ] }),
    });
    expect(records).toEqual([expect.objectContaining({
      normalizedRepeatedReviewFindingCount: 1,
      citedReviewSymbolRepeatCount: MAX_CITED_REVIEW_SYMBOLS_PER_RUN,
      citedReviewSymbolOccurrences: expect.arrayContaining([
        expect.objectContaining({ symbol: 'symbol0', firstSeenRound: 0, lastSeenRound: 1, occurrence: 1 }),
      ]),
    })]);
    expect(records[0]!.citedReviewSymbolOccurrences).toHaveLength(MAX_CITED_REVIEW_SYMBOLS_PER_RUN);
    expect(records[0]!.citedReviewSymbolOccurrences).not.toContainEqual(expect.objectContaining({ symbol: `symbol${MAX_CITED_REVIEW_SYMBOLS_PER_RUN}` }));
  }, 20_000);

  test('bounds cited-symbol records across rounds and distinguishes long symbols with matching previews', async () => {
    const prefix = 'x'.repeat(MAX_CITED_REVIEW_SYMBOL_CHARS);
    const first = `${prefix}-first`;
    const second = `${prefix}-second`;
    const records: GoalExecutionRecord[] = [];
    await runSelfImplement({
      feature: 'bounded cited symbol aggregates',
      runId: 'run-bounded-cited-symbol-aggregates',
      memory: false,
      goalFile: (() => {
        const path = `${mkdtempSync(join(tmpdir(), 'bounded-cited-symbol-aggregates-'))}/GOAL.txt`;
        writeFileSync(path, '# Goal\n');
        return path;
      })(),
      maxReworkRounds: 4,
      writeGoalExecutionRecord: (_path, record) => { records.push(record); },
      seams: revSeams({ reviews: Array.from({ length: 5 }, () => ({
        verdict: 'fail' as const,
        mustFix: [`Distinct prose names \`${first}\` and \`${second}\``],
      })) }),
    });

    const cited = records[0]!.citedReviewSymbolOccurrences!;
    expect(cited).toHaveLength(2);
    expect(cited.map(({ hash }) => hash)).toEqual(expect.arrayContaining([
      createHash('sha256').update(first).digest('hex').slice(0, 16),
      createHash('sha256').update(second).digest('hex').slice(0, 16),
    ]));
    expect(cited).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: prefix, firstSeenRound: 0, lastSeenRound: 4, occurrence: 4 }),
    ]));
    expect(records[0]!.citedReviewSymbolRepeatCount).toBe(2);
  }, 20_000);

  test('execution record retains the last review finding texts and their budget accounting', async () => {
    const records: GoalExecutionRecord[] = [];
    await runSelfImplement({
      feature: 'last review finding texts',
      runId: 'run-last-review-finding-texts',
      goalFile: reviewGoalFile(),
      maxReworkRounds: 0,
      writeGoalExecutionRecord: (_path, record) => { records.push(record); },
      seams: revSeams({ reviews: [{ verdict: 'fail', mustFix: ['first raw finding', 'second raw finding'] }] }),
    });

    expect(records).toEqual([expect.objectContaining({
      lastReviewFindings: {
        items: ['first raw finding', 'second raw finding'],
        itemCount: 2,
        shownChars: 35,
        totalChars: 35,
        truncated: false,
        fullyIncludedItems: 2,
        truncatedItems: 0,
        omittedItems: 0,
      },
    })]);
  });

  test('execution record omits last review findings when the last review has no findings', async () => {
    const records: GoalExecutionRecord[] = [];
    await runSelfImplement({
      feature: 'no last review findings',
      runId: 'run-no-last-review-findings',
      goalFile: reviewGoalFile(),
      writeGoalExecutionRecord: (_path, record) => { records.push(record); },
      seams: revSeams({ reviews: [{ verdict: 'pass', mustFix: [] }] }),
    });

    expect(records).toHaveLength(1);
    expect(records[0]).not.toHaveProperty('lastReviewFindings');
  });

  test('execution record marks oversized last review findings as truncated', async () => {
    const records: GoalExecutionRecord[] = [];
    const oversizedFindings = ['a'.repeat(7_000), 'b'.repeat(7_000)];
    await runSelfImplement({
      feature: 'oversized last review findings',
      runId: 'run-oversized-last-review-findings',
      goalFile: reviewGoalFile(),
      maxReworkRounds: 0,
      writeGoalExecutionRecord: (_path, record) => { records.push(record); },
      seams: revSeams({ reviews: [{ verdict: 'fail', mustFix: oversizedFindings }] }),
    });

    expect(records[0]!.lastReviewFindings).toEqual(expect.objectContaining({
      itemCount: 2,
      shownChars: 12_000,
      totalChars: 14_000,
      truncated: true,
      fullyIncludedItems: 0,
      truncatedItems: 2,
      omittedItems: 0,
    }));
    expect(records[0]!.lastReviewFindings!.items).toEqual([
      expect.stringMatching(/^a+.*\[\d+ chars omitted from review finding\] \.\.\.$/),
      expect.stringMatching(/^b+.*\[\d+ chars omitted from review finding\] \.\.\.$/),
    ]);
  });

  test('appendGoalExecutionRecord omits unavailable optional fields while preserving the original four lines', () => {
    const goalFile = `${mkdtempSync(join(tmpdir(), 'goal-execution-record-'))}/GOAL.txt`;
    writeFileSync(goalFile, '# Goal\n');
    appendGoalExecutionRecord(goalFile, {
      runId: 'run-append-summary', stage: 'pr-opened', outcome: 'completed', ok: true,
      startedAt: '2026-08-03T00:00:00.000Z', completedAt: '2026-08-03T00:00:01.000Z', durationMs: 1000, rounds: 1,
    });
    const written = readFileSync(goalFile, 'utf8');
    expect(written).toContain('- runId: run-append-summary\n  stage: pr-opened\n  outcome: completed\n  ok: true');
    expect(written).toContain('  startedAt: 2026-08-03T00:00:00.000Z\n  completedAt: 2026-08-03T00:00:01.000Z\n  durationMs: 1000\n  rounds: 1');
    expect(written).not.toContain('failureClassification:');
    expect(written).not.toContain('repeatedReviewFindings:');
    expect(written).not.toContain('tier:');
  });

  test('gate 실패→rework→통과: implement 2회·2차 feature 에 gate 에러 주입', async () => {
    const features: string[] = [];
    const r = await runSelfImplement({ feature: 'F', maxReworkRounds: 2, seams: seams({ gateResults: [false, true], features }) });
    expect(r.stage).toBe('pr-opened');          // rework 로 self-heal → 성공
    expect(features.length).toBe(2);            // 최초 + rework 1회
    expect(features[1]).toContain('gate 실패'); // 2차 프롬프트에 gate 에러 재주입
    expect(features[1]).toContain('refFacts');  // clean 에러가 goal-loop 에 전달
  });

  test('a goal document the harness copies into the worktree is passed as a seeded path, not counted as the child change', async () => {
    // 2026-09-24: 복사된 골 문서가 «변경»으로 세어져, 아무것도 못 한 자식이 ok:true 로 리뷰까지 갔다.
    const launchDir = mkdtempSync(join(process.cwd(), '.tmp-seeded-goal-'));
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'seeded-goal-worktree-'));
    const goalFile = join(launchDir, 'GOAL-seeded.md');
    const seen: Array<readonly string[] | undefined> = [];
    writeFileSync(goalFile, '# Seeded goal\n');
    try {
      await runSelfImplement({
        feature: 'seeded goal path', goalFile, maxReworkRounds: 0,
        seams: seams({
          createWorktree: async ({ branch, base }) => ({ path: worktreeRoot, branch, base }),
          implement: async (ctx) => {
            seen.push(ctx.harnessSeededPaths);
            return { ok: true, summary: 'done' };
          },
          gateResults: [true],
        }),
      });
      const relativeGoal = `${relative(process.cwd(), launchDir).split(sep).join('/')}/GOAL-seeded.md`;
      expect(existsSync(join(worktreeRoot, relativeGoal))).toBe(true);
      expect(seen[0]).toEqual([relativeGoal]);
    } finally {
      rmSync(launchDir, { recursive: true, force: true });
      rmSync(worktreeRoot, { recursive: true, force: true });
    }
  });

  test('opt-in artifact deficit reworks a no-diff completion and injects the exact recovery note', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'artifact-output-rework-'));
    const worktree = join(directory, 'worktree');
    const goalFile = join(directory, 'GOAL-artifact-output.md');
    const features: string[] = [];
    mkdirSync(worktree, { recursive: true });
    try {
      expect(spawnSync('git', ['init', '-q'], { cwd: worktree }).status).toBe(0);
      writeFileSync(goalFile, '# Artifact output\n');
      const result = await runSelfImplement({
        feature: 'artifact output recovery', goalFile, requireOutputArtifacts: true, maxReworkRounds: 1,
        seams: seams({
          features,
          createWorktree: async ({ branch, base }) => ({ path: worktree, branch, base }),
          implement: async ({ feature }) => {
            features.push(feature);
            if (features.length === 2) writeFileSync(join(worktree, 'implemented.ts'), 'export const recovered = true;\n');
            return { ok: true, summary: 'child claims completion' };
          },
          gateResults: [true, true],
        }),
      });
      expect(features).toHaveLength(2);
      expect(features[1]).toContain('Artifact output incomplete: missing code');
      expect(result.stage).toBe('pr-opened');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000); // 📏 2026-09-26: 부하 아래 5~6초 — 기본 5초에 걸려 하루 세 번 «통합 깨짐»·기준선 오진을 냈다(run-c6292393 등)

  test('rework note 전문을 artifact로 보존하고 기존 tail·감독 입력을 유지한다', async () => {
    const original = (debug as { log: typeof debug.log }).log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const artifacts: Array<{ origin: string; runId: string; round: number; kind: string; note: string }> = [];
    const note = `gate failed: ${'detailed failure '.repeat(40)}`;
    const histories: Array<readonly string[]> = [];
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await runSelfImplement({
        feature: 'persist complete rework note',
        runId: 'run-rework-artifact',
        maxReworkRounds: 1,
        seams: seams({
          gateResults: [false, true],
          gate: async () => ({ passed: artifacts.length > 0, log: note }),
          diagnose: async ({ history, purpose }) => {
            if (purpose === 'budget') histories.push(history);
            return purpose === 'escalation-triage' ? 'TRIAGE: resolve the failure' : 'BUDGET: EXTEND\nREASON: continue';
          },
          persistReworkNoteArtifact: (input) => { artifacts.push(input); return { path: '/artifacts/rework.json' }; },
        }),
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }

    const persistedNote = `[gate 실패]\n${note}`;
    expect(artifacts).toEqual([expect.objectContaining({ origin: 'self-implement-rework', runId: 'run-rework-artifact', round: 1, note: persistedNote })]);
    expect(histories).toEqual([[]]);
    const rework = events.find((entry) => entry.event === 'rework')!.data;
    expect(rework).toMatchObject({ round: 1, noteTail: persistedNote.slice(-240), noteLength: persistedNote.length, artifactPath: '/artifacts/rework.json' });
    expect(JSON.stringify(rework)).not.toContain(persistedNote);
  });

  test('rework-note artifact failure is fail-soft and retains the existing rework observation', async () => {
    const original = (debug as { log: typeof debug.log }).log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const result = await runSelfImplement({
        feature: 'rework artifact failure stays fail soft',
        maxReworkRounds: 1,
        seams: seams({
          gateResults: [false, true],
          persistReworkNoteArtifact: () => { throw new Error('artifact unavailable'); },
        }),
      });
      expect(result.stage).toBe('pr-opened');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }

    expect(events).toContainEqual(expect.objectContaining({ event: 'rework-artifact-failed', data: expect.objectContaining({ round: 1, kind: 'gate' }) }));
    expect(events).toContainEqual(expect.objectContaining({ event: 'rework', data: expect.objectContaining({ round: 1, noteTail: expect.any(String), noteLength: expect.any(Number) }) }));
  });

  test('PR 생성 뒤 라운드 대화를 순서대로 게시하고 RFC 메타를 보존한다', async () => {
    const comments: Array<{ number: number; body: string }> = [];
    const r = await runSelfImplement({
      feature: 'round comments',
      runId: 'run-round-comments',
      maxReworkRounds: 1,
      seams: seams({
        gateResults: [false, true],
        postPrComment: async (comment) => { comments.push(comment); },
      }),
    });

    expect(r.stage).toBe('pr-opened');
    expect(comments).toHaveLength(3);
    expect(comments.map(({ body }) => parsePrComment(body))).toEqual([
      { role: 'author', round: 0, run: 'run-round-comments' },
      { role: 'reviewer', round: 0, run: 'run-round-comments' },
      { role: 'author', round: 1, run: 'run-round-comments' },
    ]);
  });

  test('리뷰 지적과 자식 반영 요약을 provenance에 맞는 라운드 코멘트로 보존한다', async () => {
    const comments: Array<{ number: number; body: string }> = [];
    const s = revSeams({
      reviews: [
        { verdict: 'fail', mustFix: ['고유 리뷰 지적: retry policy를 보존하라'] },
        { verdict: 'pass', reviewed: true },
      ],
    });
    let implementationRound = 0;
    s.implement = async () => ({
      ok: true,
      summary: implementationRound++ === 0
        ? '고유 자식 요약: 최초 구현 완료'
        : '고유 자식 요약: retry policy 반영 완료',
    });
    s.postPrComment = async (comment) => { comments.push(comment); };

    const result = await runSelfImplement({
      feature: 'review conversation preservation',
      runId: 'run-review-conversation',
      maxReworkRounds: 1,
      seams: s,
    });

    expect(result.stage).toBe('pr-opened');
    expect(comments).toHaveLength(4);
    expect(parsePrComment(comments[0]!.body)).toEqual({ role: 'author', round: 0, run: 'run-review-conversation' });
    expect(comments[0]!.body).toContain('고유 자식 요약: 최초 구현 완료');
    expect(comments[0]!.body).not.toContain('고유 리뷰 지적');
    expect(parsePrComment(comments[1]!.body)).toEqual({ role: 'reviewer', round: 0, run: 'run-review-conversation' });
    expect(comments[1]!.body).toContain('고유 리뷰 지적: retry policy를 보존하라');
    expect(comments[1]!.body).not.toContain('고유 자식 요약');
    expect(parsePrComment(comments[2]!.body)).toEqual({ role: 'author', round: 1, run: 'run-review-conversation' });
    expect(comments[2]!.body).toContain('고유 자식 요약: retry policy 반영 완료');
    expect(parsePrComment(comments[3]!.body)).toEqual({ role: 'reviewer', round: 1, run: 'run-review-conversation' });
  });

  test('PR comment 게시 실패는 warn을 남기고 다음 코멘트와 PR 결과를 계속 처리한다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const posted: string[] = [];
    const original = (debug as { log: typeof debug.log }).log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      let calls = 0;
      const r = await runSelfImplement({
        feature: 'post comment fail soft',
        maxReworkRounds: 1,
        seams: seams({
          gateResults: [false, true],
          postPrComment: async ({ body }) => {
            calls++;
            if (calls === 1) throw new Error('comment transport failed');
            posted.push(body);
          },
        }),
      });
      expect(r.stage).toBe('pr-opened');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(posted).toHaveLength(2);
    expect(events).toContainEqual(expect.objectContaining({ event: 'pr.comment.post-failed' }));
  });

  test('최종 gate 실패 라운드도 draft PR 직후 역할별 코멘트로 게시한다', async () => {
    const comments: Array<{ number: number; body: string }> = [];
    const result = await runSelfImplement({
      feature: 'terminal gate conversation',
      runId: 'run-terminal-gate-conversation',
      maxReworkRounds: 0,
      seams: seams({
        gateResults: [false],
        postPrComment: async (comment) => { comments.push(comment); },
      }),
    });

    expect(result).toMatchObject({ stage: 'gate-failed', prNumber: 7 });
    expect(comments.map(({ body }) => parsePrComment(body))).toEqual([
      { role: 'author', round: 0, run: 'run-terminal-gate-conversation' },
      { role: 'reviewer', round: 0, run: 'run-terminal-gate-conversation' },
      { role: 'author', round: 1, run: 'run-terminal-gate-conversation' },
    ]);
    expect(comments.at(-1)).toEqual(expect.objectContaining({ number: 7, body: expect.stringContaining('Rework salvage status: parked.\n\n- reason: not-hard-cap-extend') }));
  });

  test('장문 gate 기록은 RFC 헤더를 보존하며 GitHub 본문 상한 아래로 절단한다', async () => {
    const comments: Array<{ number: number; body: string }> = [];
    const hugeGateLog = 'x'.repeat(70_000);
    await runSelfImplement({
      feature: 'bounded comment',
      maxReworkRounds: 0,
      seams: seams({
        gate: async () => ({ passed: false, log: hugeGateLog }),
        postPrComment: async (comment) => { comments.push(comment); },
      }),
    });

    const reviewerComment = comments.find(({ body }) => parsePrComment(body)?.role === 'reviewer')!.body;
    expect(reviewerComment.length).toBeLessThanOrEqual(60_000);
    expect(parsePrComment(reviewerComment)).toMatchObject({ role: 'reviewer', round: 0 });
    expect(reviewerComment).toContain('characters omitted; original body length');
  });

  test('없는 PR comment seam은 warn을 남기고 PR을 계속 연다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = (debug as { log: typeof debug.log }).log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const r = await runSelfImplement({ feature: 'missing comment seam', seams: seams({}) });
      expect(r.stage).toBe('pr-opened');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(events).toContainEqual(expect.objectContaining({
      event: 'pr.comment.seam-missing',
      data: expect.objectContaining({ buffered: 1 }),
    }));
  });

  test('gate 계속 실패 → maxRework 소진 후 gate-failed(implement maxRework+1회)', async () => {
    const features: string[] = [];
    const r = await runSelfImplement({ feature: 'F', maxReworkRounds: 2, seams: seams({ gateResults: [false, false, false], features }) });
    expect(r.stage).toBe('gate-failed');
    expect(r.outcome).toBe('budget-exhausted');
    expect(r.supervisorWantedContinue).toBeUndefined();
    expect(features.length).toBe(3);            // 최초 + rework 2회
    expect(r.detail).toContain('2 rework');
  });

  test('적응형-lag 수정: 마지막 base 라운드 진전(실패↓)이 그 라운드 소진 판정에 반영돼 연장', async () => {
    // maxRework=2(base 상한). gate 실패 fail 수 2→2→1(round 2 에서 진전). 종전(lag)엔 round 2 의 진전이
    // top-of-loop effectiveMax(직전까지만)에 없어 round 2 에서 소진 정지(implement 3회·gate-failed).
    // 수정 후: round 2 failCount push 後 상한 재계산(2→1 진전 → +1=3) → round 3 연장 → round 3 통과.
    const features: string[] = [];
    const gateLogs = ['2 fail', '2 fail', '1 fail'];   // rounds 0·1·2 실패(진전)·round 3 통과
    let gc = 0;
    const s = seams({ features });
    s.gate = async () => {
      const failing = gc < 3;
      const log = failing ? gateLogs[gc]! : 'ok';
      gc++;
      return { passed: !failing, log };
    };
    const r = await runSelfImplement({ feature: 'F', maxReworkRounds: 2, seams: s });
    expect(r.stage).toBe('pr-opened');   // 연장된 round 3 에서 통과(종전이면 round 2 에서 gate-failed)
    expect(features.length).toBe(4);     // 최초 + rework 3회(2회가 아니라 3회 — 진전이 상한을 연장)
  });

  test('maxReworkRounds:0 → 단발(rework 없음·gate 실패 즉시 gate-failed)', async () => {
    const features: string[] = [];
    const r = await runSelfImplement({ feature: 'F', maxReworkRounds: 0, seams: seams({ gateResults: [false], features }) });
    expect(r.stage).toBe('gate-failed');
    expect(features.length).toBe(1);            // rework 없음
  });

  test('구현 실패 → aborted(rework 안 함)', async () => {
    const r = await runSelfImplement({
      feature: 'F', maxReworkRounds: 2,
      seams: seams({ gateResults: [true], implement: async () => ({ ok: false, summary: 'impl fail' }) }),
    });
    expect(r.stage).toBe('aborted');
  });

  test('off-diff-evidence는 EVIDENCE가 전혀 없는 요약도 0 카운터와 함께 항상 관측한다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = (debug as { log: typeof debug.log }).log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await runSelfImplement({ feature: 'no evidence', seams: seams({ implement: async () => ({ ok: true, summary: 'plain child summary' }) }) });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(events).toContainEqual(expect.objectContaining({
      event: 'off-diff-evidence',
      data: expect.objectContaining({ round: 0, evidenceStringCount: 0, kept: 0, discardedMissingVerify: 0, discardedEmptyClaim: 0, missingResult: 0, orphanResult: 0, truncatedResult: 0, anchoredEvidence: 0, harvestedEvidenceStatus: 'empty', harvestedEvidenceKept: 0, harvestedEvidenceTotal: 0 }),
    }));
    const found = events.find((e) => e.event === 'off-diff-evidence');
    expect(found && 'harvestedEvidence' in found.data).toBe(false);
  });

  // ★ I-9 (수용 기준 6) — 수확한 증거가 **blocked draft PR 본문까지** 실리는지. 파서만 고정하면
  //    "팠는데 사람에게 안 보이는" 자리가 남는다.
  test('⭐ blocked draft PR 본문이 수확한 증거를 싣는다(그리고 다시 자르지 않는다)', async () => {
    let body = '';
    const evidence = `EVIDENCE: tsc 돌렸다 || bun run tsc\nRESULT: ${'P'.repeat(120)}`;
    const s2 = seams({ gateResults: [false, false, false, false] });
    s2.implement = async () => ({ ok: true, summary: '꼬리엔 없다', evidenceTranscript: evidence });
    s2.openPr = async (opts) => { body = opts.body; return { url: 'https://x/1', number: 1 }; };
    await runSelfImplement({ feature: 'evidence in pr body', maxReworkRounds: 0, seams: s2 });

    expect(body).toContain('## 자식이 남긴 증거');
    expect(body).toContain('bun run tsc');
    expect(body).toContain('P'.repeat(120));   // ⛔ 이중 절단으로 최신 RESULT 가 날아가지 않는다
  });

  // ★ I-9 — **성공(비차단) PR** 도 증거를 실어야 한다. blocked 쪽만 실으면 통과한 PR 에서 증거가 사라진다.
  test('⭐ 성공 경로 PR 본문도 수확한 증거를 싣는다', async () => {
    let body = '';
    const evidence = 'EVIDENCE: tsc 돌렸다 || bun run scripts/ci-typecheck-changed.ts\nRESULT: [tsc-gate] PASS';
    const s3 = seams({});
    s3.implement = async () => ({ ok: true, summary: '꼬리엔 없다', evidenceTranscript: evidence });
    s3.openPr = async (opts) => { body = opts.body; return { url: 'https://x/2', number: 2 }; };
    await runSelfImplement({ feature: 'evidence in success pr', seams: s3 });

    expect(body).toContain('## 자식이 남긴 증거');
    expect(body).toContain('bun run scripts/ci-typecheck-changed.ts');
    expect(body).toContain('[tsc-gate] PASS');
  });

  test('PR 본문은 골 파일 경로만 조건부로 싣고 blocked 관측 앵커를 보존한다', async () => {
    const goalFile = reviewGoalFile();
    // ⛔⭐ **`runId` 를 못 박는다** — 이 테스트는 «두 런»의 본문을 문자 단위로 비교한다. 본문에
    //   런 사실(`- runId: …`)이 실리면서, 런마다 새로 생성되는 그 값 하나 때문에 두 본문이
    //   영영 달라졌다. 재는 것은 「골 파일 줄 말고는 같은가」이지 「runId 가 같은가」가 아니다.
    const pinnedRunId = 'run-goal-file-pr-body-fixed';
    const captureBody = async (gateResults?: boolean[], file?: string): Promise<string> => {
      let body = '';
      const s = seams(gateResults ? { gateResults } : {});
      s.openPr = async (opts) => { body = opts.body; return { url: 'https://x/goal-body', number: 10 }; };
      await runSelfImplement({
        feature: 'goal file PR body',
        maxReworkRounds: 0,
        runId: pinnedRunId,
        ...(file ? { goalFile: file, writeGoalExecutionRecord: () => {} } : {}),
        seams: s,
      });
      return body;
    };

    const successWithoutGoal = await captureBody();
    const successWithGoal = await captureBody(undefined, goalFile);
    const blockedWithoutGoal = await captureBody([false]);
    const blockedWithGoal = await captureBody([false], goalFile);

    for (const body of [successWithoutGoal, blockedWithoutGoal]) {
      expect(body).not.toContain('- 골 파일:');
      expect(body).not.toContain(goalFile);
    }
    for (const body of [successWithGoal, blockedWithGoal]) {
      expect(body).toContain(`- 골 파일: ${goalFile}`);
      const requestAt = body.indexOf('## 요청');
      const goalAt = body.indexOf('- 골 파일:');
      const featureAt = body.indexOf('goal file PR body');
      expect(requestAt).toBeGreaterThanOrEqual(0);
      expect(goalAt).toBeGreaterThan(requestAt);
      expect(featureAt).toBeGreaterThan(goalAt);
      expect(body.indexOf('## 구현 요약')).toBeGreaterThan(featureAt);
    }
    const stripGoalFileMetadata = (body: string) => body
      .replace(`- 골 파일: ${goalFile}\n`, '')
      .replace(`이 런의 골 문서: ${goalFile} — 하니스가 발사 때 쓴 산출물이다. diff 에 있는 것이 정상이며 시험 부작용이 아니다.\n\n`, '');
    expect(stripGoalFileMetadata(successWithGoal)).toBe(successWithoutGoal);
    expect(stripGoalFileMetadata(blockedWithGoal)).toBe(blockedWithoutGoal);
    expect(blockedWithGoal.split('\n')).toContain('## 사람 판단 필요');
    expect(successWithGoal.indexOf('## 요청')).toBeLessThan(successWithGoal.indexOf('## 구현 요약'));
    expect(successWithGoal.indexOf('## 구현 요약')).toBeLessThan(successWithGoal.indexOf('## 리뷰 intent'));
    expect(successWithGoal.indexOf('## 리뷰 intent')).toBeLessThan(successWithGoal.indexOf('## Gate'));
    expect(blockedWithGoal).toContain('## 요청');
    expect(blockedWithGoal).toContain('## 구현 요약');
    expect(blockedWithGoal).toContain('## Gate');

    const inTreeAbsolute = resolve(process.cwd(), 'src/self-implement/orchestrator.test.ts');
    for (const body of [await captureBody(undefined, inTreeAbsolute), await captureBody([false], inTreeAbsolute)]) {
      expect(body).toContain('- 골 파일: src/self-implement/orchestrator.test.ts');
      expect(body).not.toContain(`- 골 파일: ${inTreeAbsolute}`);
      expect(body).not.toMatch(/- 골 파일: \//);
      const goalAt = body.indexOf('- 골 파일:');
      expect(goalAt).toBeGreaterThan(body.indexOf('## 요청'));
      expect(body.indexOf('goal file PR body')).toBeGreaterThan(goalAt);
    }

    const artifactsRoot = join(process.cwd(), '.artifacts');
    mkdirSync(artifactsRoot, { recursive: true });
    const inRepoNestedDir = mkdtempSync(join(artifactsRoot, 'goal-file-nested-git-'));
    mkdirSync(join(inRepoNestedDir, '.git'));
    mkdirSync(join(inRepoNestedDir, 'docs', 'goals'), { recursive: true });
    const inRepoNestedGoal = join(inRepoNestedDir, 'docs', 'goals', 'nested-in-repo-git-goal.txt');
    writeFileSync(inRepoNestedGoal, 'in-repo nested git goal\n');
    try {
      const inRepoNestedRelative = relative(process.cwd(), inRepoNestedGoal).split(sep).join('/');
      for (const body of [await captureBody(undefined, inRepoNestedGoal), await captureBody([false], inRepoNestedGoal)]) {
        expect(body).toContain(`- 골 파일: ${inRepoNestedGoal}`);
        expect(body).not.toContain(`- 골 파일: ${inRepoNestedRelative}`);
        expect(body).not.toContain('- 골 파일: docs/goals/nested-in-repo-git-goal.txt');
        expect(body).not.toContain('- 골 파일: docs/');
      }
    } finally {
      rmSync(inRepoNestedDir, { recursive: true, force: true });
    }

    const externalDir = mkdtempSync(join(tmpdir(), 'goal-file-outside-'));
    const externalGoal = join(externalDir, 'outside-goal.txt');
    writeFileSync(externalGoal, 'external goal\n');
    const externalGitDir = mkdtempSync(join(tmpdir(), 'goal-file-outside-git-'));
    mkdirSync(join(externalGitDir, '.git'));
    mkdirSync(join(externalGitDir, 'docs', 'goals'), { recursive: true });
    const externalGitGoal = join(externalGitDir, 'docs', 'goals', 'outside-git-goal.txt');
    writeFileSync(externalGitGoal, 'external git goal\n');
    const nestedGitDir = mkdtempSync(join(tmpdir(), 'goal-file-nested-git-'));
    mkdirSync(join(nestedGitDir, '.git'));
    mkdirSync(join(nestedGitDir, 'inner', '.git'), { recursive: true });
    mkdirSync(join(nestedGitDir, 'inner', 'docs', 'goals'), { recursive: true });
    const nestedGitGoal = join(nestedGitDir, 'inner', 'docs', 'goals', 'nested-git-goal.txt');
    writeFileSync(nestedGitGoal, 'nested git goal\n');
    try {
      for (const body of [await captureBody(undefined, externalGoal), await captureBody([false], externalGoal)]) {
        expect(body).toContain(`- 골 파일: ${externalGoal}`);
        expect(body).not.toContain('- 골 파일: docs/');
        expect(body).not.toContain('- 골 파일: outside-goal.txt');
      }
      for (const body of [await captureBody(undefined, externalGitGoal), await captureBody([false], externalGitGoal)]) {
        expect(body).toContain(`- 골 파일: ${externalGitGoal}`);
        expect(body).not.toContain('- 골 파일: docs/goals/outside-git-goal.txt');
        expect(body).not.toContain('- 골 파일: docs/');
      }
      for (const body of [await captureBody(undefined, nestedGitGoal), await captureBody([false], nestedGitGoal)]) {
        expect(body).toContain(`- 골 파일: ${nestedGitGoal}`);
        expect(body).not.toContain('- 골 파일: docs/goals/nested-git-goal.txt');
        expect(body).not.toContain('- 골 파일: inner/docs/goals/nested-git-goal.txt');
        expect(body).not.toContain('- 골 파일: docs/');
      }
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
      rmSync(externalGitDir, { recursive: true, force: true });
      rmSync(nestedGitDir, { recursive: true, force: true });
    }

    const symlinkFixtureRoot = mkdtempSync(join(artifactsRoot, 'goal-file-symlink-in-repo-'));
    const symlinkExternalDir = mkdtempSync(join(tmpdir(), 'goal-file-symlink-external-'));
    const symlinkExternalGoal = join(symlinkExternalDir, 'outside-via-symlink.txt');
    writeFileSync(symlinkExternalGoal, 'external via symlink\n');
    const symlinkOtherGitDir = mkdtempSync(join(tmpdir(), 'goal-file-symlink-other-git-'));
    mkdirSync(join(symlinkOtherGitDir, '.git'));
    mkdirSync(join(symlinkOtherGitDir, 'docs', 'goals'), { recursive: true });
    const symlinkOtherGitGoal = join(symlinkOtherGitDir, 'docs', 'goals', 'other-git-via-symlink.txt');
    writeFileSync(symlinkOtherGitGoal, 'other git via symlink\n');
    mkdirSync(join(symlinkFixtureRoot, 'docs', 'goals'), { recursive: true });
    const inRepoSymlinkToExternal = join(symlinkFixtureRoot, 'docs', 'goals', 'link-to-external.txt');
    const inRepoSymlinkToOtherGit = join(symlinkFixtureRoot, 'docs', 'goals', 'link-to-other-git.txt');
    symlinkSync(symlinkExternalGoal, inRepoSymlinkToExternal);
    symlinkSync(symlinkOtherGitGoal, inRepoSymlinkToOtherGit);
    try {
      const inRepoSymlinkToExternalRelative = relative(process.cwd(), inRepoSymlinkToExternal).split(sep).join('/');
      const inRepoSymlinkToOtherGitRelative = relative(process.cwd(), inRepoSymlinkToOtherGit).split(sep).join('/');
      for (const body of [await captureBody(undefined, inRepoSymlinkToExternal), await captureBody([false], inRepoSymlinkToExternal)]) {
        expect(body).toContain(`- 골 파일: ${inRepoSymlinkToExternal}`);
        expect(body).not.toContain(`- 골 파일: ${inRepoSymlinkToExternalRelative}`);
        expect(body).not.toContain('- 골 파일: docs/goals/link-to-external.txt');
        expect(body).not.toContain('- 골 파일: outside-via-symlink.txt');
        expect(body).not.toContain('- 골 파일: docs/');
      }
      for (const body of [await captureBody(undefined, inRepoSymlinkToOtherGit), await captureBody([false], inRepoSymlinkToOtherGit)]) {
        expect(body).toContain(`- 골 파일: ${inRepoSymlinkToOtherGit}`);
        expect(body).not.toContain(`- 골 파일: ${inRepoSymlinkToOtherGitRelative}`);
        expect(body).not.toContain('- 골 파일: docs/goals/link-to-other-git.txt');
        expect(body).not.toContain('- 골 파일: docs/goals/other-git-via-symlink.txt');
        expect(body).not.toContain('- 골 파일: docs/');
      }
    } finally {
      rmSync(symlinkFixtureRoot, { recursive: true, force: true });
      rmSync(symlinkExternalDir, { recursive: true, force: true });
      rmSync(symlinkOtherGitDir, { recursive: true, force: true });
    }
  });

  // ★ I-9 (리뷰 4R) — 수확본이 **미주입·공백**일 때도 PR 본문이 거짓말하지 않아야 한다.
  //    파서는 요약으로 폴백하는데 PR 본문만 "(없음)" 이라 적으면 **두 소스 규칙이 갈린다**.
  test.each([
    ['미주입', undefined],
    ['공백', '   \n  '],
  ] as const)('⭐ 수확본이 %s 이면 PR 본문도 요약에서 수확한다(성공·차단 둘 다)', async (_label, evidenceTranscript) => {
    const summaryWithEvidence = 'EVIDENCE: 요약에만 있다 || bun run x\nRESULT: OK-FROM-SUMMARY';
    for (const gateResults of [undefined, [false, false, false, false]]) {
      let body = '';
      const sx = seams(gateResults ? { gateResults } : {});
      sx.implement = async () => ({ ok: true, summary: summaryWithEvidence, ...(evidenceTranscript !== undefined ? { evidenceTranscript } : {}) });
      sx.openPr = async (opts) => { body = opts.body; return { url: 'https://x/9', number: 9 }; };
      await runSelfImplement({ feature: 'fallback pr body', maxReworkRounds: 0, seams: sx });

      expect(body).toContain('## 자식이 남긴 증거');
      expect(body).toContain('OK-FROM-SUMMARY');
      expect(body).not.toContain('(없음 — 자식이 `EVIDENCE:`/`RESULT:` 줄을 남기지 않았다)');
    }
  });

  // ★ I-24 — 골이 이름으로 요구한 증거의 충족을 **관측이 나른다**. 순수 함수만 재면 배선이 안 잡힌다.
  test('⭐ 하니스 셸 체크 실행과 0건이 debug 관측에 실린다', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const original = (debug as { log: typeof debug.log }).log;
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ category, event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    const observedSeams = () => seams({
      createWorktree: async ({ branch, base }) => ({ path: process.cwd(), branch, base, resolvedBase: 'a'.repeat(40), invokedHead: 'a'.repeat(40) }),
    });
    try {
      await runSelfImplement({
        feature: '골\n## REQUIRED EVIDENCE\n- [shell] 하니스 셸 체크 || echo ok',
        seams: observedSeams(),
      });
      await runSelfImplement({
        feature: '골\n## REQUIRED EVIDENCE\n- [legacy] 기존 요구',
        seams: observedSeams(),
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    const checks = events.filter((entry) => entry.category === 'self-implement' && entry.event === 'required-evidence-check-run');
    expect(checks[0]?.data).toMatchObject({
      count: 1,
      runs: [expect.objectContaining({ tag: 'shell', command: 'echo ok', exitCode: 0, durationMs: expect.any(Number) })],
    });
    expect(checks[1]?.data).toEqual({ count: 0, runs: [] });
  }, 10_000);

  test('⭐ 요구된 증거의 충족/결손이 관측에 실린다(요구가 없으면 필드도 없다)', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = (debug as { log: typeof debug.log }).log;
    (debug as { log: typeof debug.log }).log = ((_c, event, data) => { events.push({ event, data: data as Record<string, unknown> }); }) as typeof debug.log;
    try {
      await runSelfImplement({
        feature: '골\n## REQUIRED EVIDENCE\n- [tsc] 타입검사\n- [mutation] 깨뜨리기',
        seams: seams({ implement: async () => ({ ok: true, summary: 'EVIDENCE: [tsc] 돌렸다 || cmd\nRESULT: PASS' }) }),
      });
      await runSelfImplement({ feature: '요구 없는 골', seams: seams({ implement: async () => ({ ok: true, summary: 'EVIDENCE: a || b\nRESULT: c' }) }) });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    const found = events.filter((e) => e.event === 'off-diff-evidence');
    expect(found[0]?.data).toMatchObject({ requiredEvidence: 2, coveredEvidence: 1, missingEvidence: ['mutation'] });
    expect(found.some((e) => e.data.requiredEvidence === undefined && e.data.kept === 1)).toBe(true);
    const noRequirementMergeDecision = events.find((e) => e.event === 'merge-decision' && e.data.requiredEvidence === undefined);
    expect(noRequirementMergeDecision).toBeDefined();
    expect(noRequirementMergeDecision!.data).toMatchObject({ evidenceCoverageMeasured: false });
    expect('uncoveredEvidence' in noRequirementMergeDecision!.data).toBe(false);
    expect('evidenceSource' in noRequirementMergeDecision!.data).toBe(false);
    expect('anchoredEvidence' in noRequirementMergeDecision!.data).toBe(false);
  });

  // ★ MEAS-T11 — 정직한 분모가 **관측까지 실려야** 충전율을 조회로 물을 수 있다. 파서만 고정하면
  //    배선 누락이 안 잡힌다(오늘 같은 계열 결손 세 번째).
  test('⭐ 관측이 낱말 수와 앵커 줄 수를 **둘 다** 나른다(분모가 갈린다)', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = (debug as { log: typeof debug.log }).log;
    (debug as { log: typeof debug.log }).log = ((_c, event, data) => { events.push({ event, data: data as Record<string, unknown> }); }) as typeof debug.log;
    try {
      await runSelfImplement({ feature: 'denominator', seams: seams({
        implement: async () => ({
          ok: true,
          // 낱말 3 · 앵커 1 — 둘이 갈리는 입력
          summary: 'EVIDENCE 를 남기라고 했다\n`EVIDENCE: 예시 || cmd`\nEVIDENCE: 진짜 || cmd\nRESULT: ok',
        }),
      }) });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    const found = events.find((e) => e.event === 'off-diff-evidence');
    expect(found?.data).toMatchObject({ evidenceStringCount: 3, anchoredEvidence: 1, kept: 1 });
  });

  // ★ I-23 — 파서가 절단을 세는 것만으로는 부족하다. **관측까지 실려야** "500자 상한이 부족한가" 를
  //    조회로 물을 수 있다. 이 통합 회귀가 없으면 wiring 이탈이 조용히 난다.
  test('⭐ off-diff-evidence 관측이 RESULT 절단 수를 함께 나른다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = (debug as { log: typeof debug.log }).log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    const summary = `EVIDENCE: 긴 결과 || cmd\nRESULT: ${'x'.repeat(MAX_OFF_DIFF_EVIDENCE_RESULT_CHARS + 1)}`;
    try {
      await runSelfImplement({ feature: 'truncated evidence', seams: seams({ implement: async () => ({ ok: true, summary }) }) });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(events).toContainEqual(expect.objectContaining({
      event: 'off-diff-evidence',
      data: expect.objectContaining({ round: 0, kept: 1, truncatedResult: 1 }),
    }));
  });

  // ★ I-9 — 오케스트레이터가 **수확본**을 판다는 것을 고정한다. 종전엔 꼬리 2000자에서 팠고,
  //    자식이 먼저 돌린 tsc·뮤테이션 출력이 창 밖으로 밀려 파서에 도달조차 못 했다(RUN-T6).
  test('⭐⭐ 증거를 꼬리 요약이 아니라 수확본에서 판다(주입 시) · 미주입이면 요약 폴백', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = (debug as { log: typeof debug.log }).log;
    (debug as { log: typeof debug.log }).log = ((_c, event, data) => { events.push({ event, data: data as Record<string, unknown> }); }) as typeof debug.log;
    try {
      await runSelfImplement({ feature: 'harvested', seams: seams({
        implement: async () => ({
          ok: true,
          summary: '꼬리에는 증거가 없다',
          evidenceTranscript: 'EVIDENCE: tsc 돌렸다 || bun run tsc\nRESULT: PASS',
        }),
      }) });
      await runSelfImplement({ feature: 'fallback', seams: seams({
        implement: async () => ({ ok: true, summary: 'EVIDENCE: 요약에 있다 || cmd\nRESULT: ok' }),
      }) });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    const found = events.filter((e) => e.event === 'off-diff-evidence');
    expect(found[0]?.data).toMatchObject({ kept: 1, evidenceSource: 'harvested' });
    expect(found.some((e) => e.data.evidenceSource === 'summary-tail' && e.data.kept === 1)).toBe(true);
  });

  test('⭐ 관측이 수확된 증거 본문을 PR 과 같은 값으로 나른다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = (debug as { log: typeof debug.log }).log;
    (debug as { log: typeof debug.log }).log = ((_c, event, data) => { events.push({ event, data: data as Record<string, unknown> }); }) as typeof debug.log;
    const evidence = [
      'EVIDENCE: [requested] tsc 돌렸다 || bun run tsc',
      'RESULT: PASS',
      'EVIDENCE: [preservation] 게이트 통과 || bun test focused',
      'RESULT: 1 pass',
    ].join('\n');
    let prBodyText = '';
    try {
      const s = seams({});
      s.implement = async () => ({ ok: true, summary: '꼬리엔 없다', evidenceTranscript: evidence });
      s.openPr = async (opts) => { prBodyText = opts.body; return { url: 'https://x/1', number: 1 }; };
      await runSelfImplement({ feature: 'harvest body in observation', seams: s });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    const found = events.find((e) => e.event === 'off-diff-evidence');
    expect(found?.data).toMatchObject({
      harvestedEvidenceStatus: 'complete',
      harvestedEvidenceKept: 2,
      harvestedEvidenceTotal: 2,
      harvestedEvidence: evidence,
    });
    expect(prBodyText).toContain(evidence);
  });

  test('⭐ 수확이 비면 empty, 상한을 넘으면 truncated — 같은 값이 아니다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = (debug as { log: typeof debug.log }).log;
    (debug as { log: typeof debug.log }).log = ((_c, event, data) => { events.push({ event, data: data as Record<string, unknown> }); }) as typeof debug.log;
    const pair = (i: number) => `EVIDENCE: 주장${i} || cmd${i}\nRESULT: ${'r'.repeat(80)}`;
    const overflow = Array.from({ length: 80 }, (_, i) => pair(i)).join('\n');
    try {
      await runSelfImplement({ feature: 'empty harvest', seams: seams({ implement: async () => ({ ok: true, summary: 'plain' }) }) });
      await runSelfImplement({ feature: 'truncated harvest', seams: seams({ implement: async () => ({ ok: true, summary: overflow }) }) });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    const observations = events.filter((e) => e.event === 'off-diff-evidence').map((e) => e.data);
    expect(observations[0]).toMatchObject({ harvestedEvidenceStatus: 'empty', harvestedEvidenceKept: 0, harvestedEvidenceTotal: 0 });
    expect('harvestedEvidence' in observations[0]!).toBe(false);
    expect(observations[1]?.harvestedEvidenceStatus).toBe('truncated');
    expect(Number(observations[1]?.harvestedEvidenceTotal)).toBeGreaterThan(Number(observations[1]?.harvestedEvidenceKept));
    expect(String(observations[1]?.harvestedEvidence)).toContain('레코드 생략]');
    expect(observations[0]?.harvestedEvidenceStatus).not.toBe(observations[1]?.harvestedEvidenceStatus);
  });

  test('diff 추가 줄의 파일 증거가 요구 태그를 충족하고 넓힌 원천을 관측한다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await runSelfImplement({
        feature: '골\n## REQUIRED EVIDENCE\n- [file-only] 파일 증거',
        seams: seams({
          implement: async () => ({ ok: true, summary: '화면에는 증거가 없다' }),
          reviewScopeDiff: async () => 'diff --git a/reports/evidence.md b/reports/evidence.md\n+++ b/reports/evidence.md\n+EVIDENCE: [file-only] diff 안에만 있다 || bun test focused\n+RESULT: 1 pass\n-context is ignored',
        }),
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(events.find((entry) => entry.event === 'off-diff-evidence')?.data).toMatchObject({
      kept: 1, requiredEvidence: 1, coveredEvidence: 1, missingEvidence: [], evidenceSource: 'diff-added-lines', diffEvidenceStatus: 'available',
    });
  });

  test('증거 없는 diff는 종전 계산을 유지하고 seam 실패·상한을 관측한다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await runSelfImplement({
        feature: '골\n## REQUIRED EVIDENCE\n- [summary] 요약 증거',
        seams: seams({
          implement: async () => ({ ok: true, summary: 'EVIDENCE: [summary] 기존 요약 || cmd\nRESULT: pass' }),
          reviewScopeDiff: async () => '+const unrelated = true;',
        }),
      });
      await runSelfImplement({
        feature: '실패 골',
        seams: seams({
          implement: async () => ({ ok: true, summary: 'plain child summary' }),
          reviewScopeDiff: async () => { throw new Error('diff unavailable'); },
        }),
      });
      await runSelfImplement({
        feature: '상한 골',
        seams: seams({
          implement: async () => ({ ok: true, summary: 'plain child summary' }),
          reviewScopeDiff: async () => `+EVIDENCE: ${'x'.repeat(MAX_DIFF_EVIDENCE_CHARS + 1)}`,
        }),
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    const observations = events.filter((entry) => entry.event === 'off-diff-evidence').map((entry) => entry.data);
    expect(observations[0]).toMatchObject({ kept: 1, requiredEvidence: 1, coveredEvidence: 1, missingEvidence: [], evidenceSource: 'summary-tail' });
    expect('diffEvidenceStatus' in observations[0]!).toBe(false);
    expect(observations[1]).toMatchObject({ kept: 0, evidenceSource: 'summary-tail', diffEvidenceStatus: 'failed', diffEvidenceChars: 0 });
    expect(observations[2]).toMatchObject({ kept: 0, evidenceSource: 'diff-added-lines', diffEvidenceStatus: 'available', diffEvidenceChars: MAX_DIFF_EVIDENCE_CHARS, diffEvidenceTruncated: true });
  });

  test('review diff는 resolved base를 쓰고 없으면 origin/main으로 폴백한다', async () => {
    const calls: Array<{ prBase: string | undefined; baseOrigin: string | undefined }> = [];
    await runSelfImplement({
      feature: 'resolved review base',
      base: 'stacked-parent',
      seams: seams({
        createWorktree: async ({ branch, base }) => ({ path: `/wt/${branch}`, branch, base, resolvedBase: 'b'.repeat(40) }),
        reviewScopeDiff: async (_cwd, prBase, _runId, baseOrigin) => {
          calls.push({ prBase, baseOrigin });
          return '';
        },
      }),
    });
    await runSelfImplement({
      feature: 'fallback review base',
      seams: seams({
        createWorktree: async ({ branch, base }) => ({ path: `/wt/${branch}`, branch, base }),
        reviewScopeDiff: async (_cwd, prBase, _runId, baseOrigin) => {
          calls.push({ prBase, baseOrigin });
          return '';
        },
      }),
    });

    expect(calls).toEqual([
      { prBase: 'b'.repeat(40), baseOrigin: 'resolved-base' },
      { prBase: 'origin/main', baseOrigin: 'default-origin-main' },
    ]);
  });

  test('diff seam 미주입이면 조회하지 않고 종전 원천·결과를 유지하며 unavailable을 관측한다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await runSelfImplement({
        feature: '골\n## REQUIRED EVIDENCE\n- [summary-only] 요약 증거',
        seams: seams({
          implement: async () => ({ ok: true, summary: 'EVIDENCE: [summary-only] 기존 요약 || cmd\nRESULT: pass' }),
        }),
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(events.find((entry) => entry.event === 'off-diff-evidence')?.data).toMatchObject({
      kept: 1,
      requiredEvidence: 1,
      coveredEvidence: 1,
      missingEvidence: [],
      evidenceSource: 'summary-tail',
      diffEvidenceStatus: 'unavailable',
      diffEvidenceChars: 0,
      diffEvidenceTruncated: false,
    });
  });

  test('off-diff-evidence는 대소문자·형식과 무관한 EVIDENCE 문자열 횟수로 자식 미작성과 파서 결손을 구분하고 매 rework 라운드에 남긴다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = (debug as { log: typeof debug.log }).log;
    let implementations = 0;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await runSelfImplement({
        feature: 'unparseable evidence',
        maxReworkRounds: 1,
        seams: seams({
          gateResults: [false, true],
          implement: async () => ({ ok: true, summary: ++implementations === 1 ? 'evidence but not a parser marker; Evidence again' : 'EvIdEnCe only' }),
        }),
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    const observations = events.filter((entry) => entry.event === 'off-diff-evidence').map((entry) => entry.data);
    expect(observations).toEqual([
      expect.objectContaining({ round: 0, evidenceStringCount: 2, kept: 0, discardedMissingVerify: 0, discardedEmptyClaim: 0, missingResult: 0, orphanResult: 0 }),
      expect.objectContaining({ round: 1, evidenceStringCount: 1, kept: 0, discardedMissingVerify: 0, discardedEmptyClaim: 0, missingResult: 0, orphanResult: 0 }),
    ]);
  });

  test('변경 없이 완료 검증 disposition은 implemented 관측에 싣고 기존 aborted 경로를 유지한다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = (debug as { log: typeof debug.log }).log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const r = await runSelfImplement({
        feature: 'F',
        seams: seams({
          implement: async () => ({ ok: false, completionDisposition: 'completed-without-changes', summary: 'verified existing seam' }),
        }),
      });
      expect(r).toMatchObject({ ok: false, stage: 'aborted', outcome: 'abandoned' });
      expect(events).toContainEqual(expect.objectContaining({
        event: 'implemented', data: expect.objectContaining({ ok: false, completionDisposition: 'completed-without-changes', round: 0 }),
      }));
      expect(events).toContainEqual(expect.objectContaining({
        event: 'abandoned-classification',
        data: expect.objectContaining({
          classification: 'report-deficit',
          completionDisposition: 'completed-without-changes',
          mustFixReported: false,
        }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('비대상 로그만 본 런은 기존 report-deficit 분류를 유지한다', async () => {
    const result = await runSelfImplement({
      feature: 'ignore unrelated log category',
      seams: seams({
        implement: async () => {
          debug.log('other.category', 'ignored', { provider: 'ignored', message: 'ignored' });
          return { ok: false, completionDisposition: 'completed-without-changes', summary: 'report missing' };
        },
      }),
    });
    expect(result.abandonedClassification).toMatchObject({
      classification: 'report-deficit',
      classificationBasis: 'terminal-state-not-reviewed',
    });
  });

  test('default seam은 child state universe의 구조화된 provider 오류를 read-only로 집계한다', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'elanous-child-provider-log-'));
    const store = new LogStore(join(stateDir, 'logs', 'logs.db'), { instance: instanceNameForStateDir(stateDir) });
    try {
      store.insertBatch([{ surface: 'dev-pipeline', rec: {
        ts: new Date().toISOString(), category: 'llm.router.error', event: 'streamLLM', level: 'error',
        data: { provider: 'openai-codex', message: 'Codex API error: upstream' },
      } }]);
      const result = await defaultSeams({ stateDir }).queryChildProviderErrors!({ runId: 'child-log-run', sinceMs: 0, untilMs: Date.now() });
      expect(result).toMatchObject({ status: 'found', providerErrorCount: 1, credentialFailureCount: 0, lastProviderError: { provider: 'openai-codex', message: 'Codex API error: upstream' } });
    } finally {
      store.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test('default seam은 child provider 로그 조회의 성공과 실패 뒤 store를 닫는다', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'elanous-child-provider-close-'));
    mkdirSync(join(stateDir, 'logs'), { recursive: true });
    writeFileSync(join(stateDir, 'logs', 'logs.db'), '');
    const originalOpenReadOnly = LogStore.openReadOnly;
    let closeCalls = 0;
    try {
      (LogStore as typeof LogStore & { openReadOnly: typeof LogStore.openReadOnly }).openReadOnly = (() => ({
        queryAll: () => [],
        close: () => { closeCalls++; },
      })) as unknown as typeof LogStore.openReadOnly;
      await expect(defaultSeams({ stateDir }).queryChildProviderErrors!({ runId: 'close-success', sinceMs: 0, untilMs: 1 })).resolves.toEqual({ status: 'none' });
      expect(closeCalls).toBe(1);

      (LogStore as typeof LogStore & { openReadOnly: typeof LogStore.openReadOnly }).openReadOnly = (() => ({
        queryAll: () => { throw new Error('query failed'); },
        close: () => { closeCalls++; },
      })) as unknown as typeof LogStore.openReadOnly;
      await expect(defaultSeams({ stateDir }).queryChildProviderErrors!({ runId: 'close-failure', sinceMs: 0, untilMs: 1 })).resolves.toMatchObject({ status: 'unavailable', reason: 'query failed' });
      expect(closeCalls).toBe(2);
    } finally {
      (LogStore as typeof LogStore & { openReadOnly: typeof LogStore.openReadOnly }).openReadOnly = originalOpenReadOnly;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test('elanous dev sink surface의 공유 값은 기존 attribution을 보존한다', () => {
    expect(DEV_PIPELINE_SINK_SURFACE).toBe('dev-pipeline');
  });

  test('elanous dev 생산자는 공유 sink surface를 import한다', () => {
    const cliSource = readFileSync(resolve(import.meta.dir, '../index.ts'), 'utf8');

    expect(cliSource).toContain("import { DEV_PIPELINE_SINK_SURFACE } from './self-implement/self-cli-sink-surface.js';");
  });

  test('elanous dev 생산자는 공유 sink surface를 등록한다', () => {
    const cliSource = readFileSync(resolve(import.meta.dir, '../index.ts'), 'utf8');

    expect(cliSource).toContain('registerStandaloneLogSink(DEV_PIPELINE_SINK_SURFACE)');
  });

  test('자식 provider 오류 소비자는 공유 sink surface를 조회한다', () => {
    const orchestratorSource = readFileSync(resolve(import.meta.dir, 'orchestrator.ts'), 'utf8');

    expect(orchestratorSource).toContain("import { DEV_PIPELINE_SINK_SURFACE } from './self-cli-sink-surface.js';");
    expect(orchestratorSource).toContain('surfaces: [DEV_PIPELINE_SINK_SURFACE]');
  });

  test('구조화된 자식 router 오류는 provider-error로 분류하고 자격 거부를 분리한다', async () => {
    const row = (over: Partial<{ instance: string; surface: string; category: string; ts_ms: number; data: string }> = {}) => ({
      id: 1, ts: '2026-08-17T13:44:48.899Z', ts_ms: 100, level: 'error', instance: 'test:child', surface: 'dev-pipeline', category: 'llm.router.error', event: 'streamLLM', session_id: null, trace_id: null,
      data: JSON.stringify({ provider: 'openai-codex', durationMs: 81429, message: 'Codex API error: upstream' }), ...over,
    });
    const matching = queryStructuredChildProviderErrors(['test:child'], 0, 200, (query) => {
      expect(query).toMatchObject({ instances: ['test:child'], surfaces: [DEV_PIPELINE_SINK_SURFACE], exactCategories: ['llm.router.error'], sinceMs: 0, untilMs: 200 });
      return [row()];
    });
    expect(matching).toMatchObject({ status: 'found', providerErrorCount: 1, credentialFailureCount: 0, lastProviderError: { provider: 'openai-codex', message: 'Codex API error: upstream' } });
    expect(queryStructuredChildProviderErrors([], 0, 200, () => [])).toMatchObject({ status: 'unavailable' });
    expect(queryStructuredChildProviderErrors(['test:child'], 0, 200, () => [])).toEqual({ status: 'none' });
    expect(queryStructuredChildProviderErrors(['test:child'], 0, 200, () => { throw new Error('logs unavailable'); })).toMatchObject({ status: 'unavailable' });
    const result = await runSelfImplement({
      feature: 'child structured provider error',
      runId: 'child-provider-run',
      seams: seams({
        implement: async () => ({ ok: false, completionDisposition: 'completed-without-changes', summary: 'child stopped' }),
        queryChildProviderErrors: async ({ runId, sinceMs, untilMs }) => {
          expect(runId).toBe('child-provider-run');
          expect(untilMs).toBeGreaterThanOrEqual(sinceMs);
          return matching;
        },
      }),
    });
    expect(result.abandonedClassification).toMatchObject({ classification: 'provider-error', providerError: true });
  });

  test('provider-error abandoned classification carries the start provider identity only when known', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const capture = (entry: { event: string; data: Record<string, unknown> }) => { events.push(entry); };

    await runSelfImplement({
      feature: 'known provider error identity',
      runId: 'known-provider-error-identity',
      seams: seams({
        inspectActiveProvider: () => ({ provider: 'openai-codex', model: 'gpt-5.6-terra', auth: 'oauth', authDetail: 'subscription' }),
        writeRunLedger: capture,
        implement: async () => {
          debug.log('llm.router.error', 'streamLLM', { provider: 'openai-codex', message: 'upstream failed' });
          return { ok: false, completionDisposition: 'completed-without-changes', summary: 'provider stopped' };
        },
      }),
    });
    const knownStart = events.find((entry) => entry.event === 'start' && entry.data.runId === 'known-provider-error-identity')!.data;
    const knownClassification = events.find((entry) => entry.event === 'abandoned-classification' && entry.data.runId === 'known-provider-error-identity')!.data;
    expect(knownClassification).toMatchObject({
      classification: 'provider-error',
      providerError: true,
      provider: knownStart.provider,
      model: knownStart.model,
    });
    expect(knownClassification).not.toHaveProperty('auth');
    expect(knownClassification).not.toHaveProperty('authDetail');

    await runSelfImplement({
      feature: 'unknown provider error identity',
      runId: 'unknown-provider-error-identity',
      seams: seams({
        inspectActiveProvider: () => ({ provider: undefined as unknown as string, model: undefined as unknown as string, auth: 'oauth', authDetail: 'subscription' }),
        writeRunLedger: capture,
        implement: async () => {
          debug.log('llm.router.error', 'streamLLM', { provider: 'openai-codex', message: 'upstream failed' });
          return { ok: false, completionDisposition: 'completed-without-changes', summary: 'provider stopped' };
        },
      }),
    });
    const unknownClassification = events.find((entry) => entry.event === 'abandoned-classification' && entry.data.runId === 'unknown-provider-error-identity')!.data;
    expect(unknownClassification).toMatchObject({ classification: 'provider-error', providerError: true });
    expect(unknownClassification).not.toHaveProperty('provider');
    expect(unknownClassification).not.toHaveProperty('model');

    await runSelfImplement({
      feature: 'non-provider classification remains unchanged',
      runId: 'non-provider-classification-identity',
      seams: seams({
        writeRunLedger: capture,
        implement: async () => ({ ok: false, completionDisposition: 'completed-without-changes', summary: 'report missing' }),
      }),
    });
    const nonProviderClassification = events.find((entry) => entry.event === 'abandoned-classification' && entry.data.runId === 'non-provider-classification-identity')!.data;
    expect(nonProviderClassification).toMatchObject({
      runId: 'non-provider-classification-identity',
      classification: 'report-deficit',
      classificationBasis: 'terminal-state-not-reviewed',
      mustFixReported: false,
      completionDisposition: 'completed-without-changes',
    });
    expect(nonProviderClassification).not.toHaveProperty('provider');
    expect(nonProviderClassification).not.toHaveProperty('model');
  });

  test('자식 로그 조회는 부재·불일치·실패에서 부모 오류 계수를 보존한다', async () => {
    const ignored = queryStructuredChildProviderErrors(['test:child'], 0, 200, (query) => {
      const rows = [
        { instance: 'other', surface: 'harness', category: 'llm.router.error' },
        { instance: 'test:child', surface: 'other', category: 'llm.router.error' },
        { instance: 'test:child', surface: 'harness', category: 'other.category' },
      ];
      return rows.filter((entry) => query.instances?.includes(entry.instance) && query.surfaces?.includes(entry.surface) && query.exactCategories?.includes(entry.category)) as never[];
    });
    expect(ignored).toEqual({ status: 'none' });
    const result = await runSelfImplement({
      feature: 'parent provider error survives child query unavailable',
      seams: seams({
        implement: async () => {
          debug.log('llm.router.error', 'streamLLM', { provider: 'parent', message: 'parent error' });
          return { ok: false, completionDisposition: 'completed-without-changes', summary: 'stopped' };
        },
        queryChildProviderErrors: async () => ({ status: 'unavailable', reason: 'child instance unknown' }),
      }),
    });
    expect(result.abandonedClassification).toMatchObject({ classification: 'provider-error', providerError: true });
  });

  test('run별 provider 오류 sink는 마지막 대상 오류만 분류에 연결하고 종료 시 해제한다', async () => {
    const originalRegisterSink = debug.registerSink;
    const originalLog = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> | undefined }> = [];
    let activeSinks = 0;
    let unregisterCalls = 0;
    const registerSink = debug.registerSink.bind(debug);
    (debug as { log: typeof debug.log }).log = ((category, event, data, options) => {
      events.push({ event, data: data as Record<string, unknown> | undefined });
      return originalLog.call(debug, category, event, data, options);
    }) as typeof debug.log;
    (debug as { registerSink: typeof debug.registerSink }).registerSink = ((sink) => {
      activeSinks++;
      const unregister = registerSink(sink);
      return () => {
        unregisterCalls++;
        activeSinks--;
        unregister();
      };
    }) as typeof debug.registerSink;
    try {
      const result = await runSelfImplement({
        feature: 'provider error classification',
        seams: seams({
          implement: async () => {
            debug.log('other.category', 'ignored', { provider: 'ignored', message: 'ignored' });
            debug.log('llm.router.error', 'streamLLM', { provider: 'first', message: 'first error' });
            debug.log('llm.router.error', 'streamLLM', { provider: 'last', message: 'last error' });
            return { ok: false, completionDisposition: 'completed-without-changes', summary: 'provider failed' };
          },
        }),
      });
      expect(result.abandonedClassification).toMatchObject({
        classification: 'provider-error',
        classificationBasis: 'environment-provider-error-outranks-run-stage-evidence',
        providerError: true,
      });
      expect(result.providerErrors).toEqual({ count: 2, provider: 'last', category: 'other' });
      expect(events).toContainEqual({
        event: 'provider-error-observed',
        data: expect.objectContaining({ count: 2, provider: 'last', message: 'last error' }),
      });
      expect(activeSinks).toBe(0);
      expect(unregisterCalls).toBe(1);
    } finally {
      (debug as { registerSink: typeof debug.registerSink }).registerSink = originalRegisterSink;
      (debug as { log: typeof debug.log }).log = originalLog;
    }
  });

  test('run result exposes quota, credential and other provider errors; omits field when none', async () => {
    for (const [message, category] of [
      ['403 personal-team-blocked:spending-limit', 'quota'],
      ['429 usage_limit_reached', 'quota'],
      ['401 unauthorized', 'credential'],
      ['upstream failed', 'other'],
    ] as const) {
      const result = await runSelfImplement({
        feature: `provider failure ${category}`,
        seams: seams({ implement: async () => {
          debug.log('llm.router.error', 'streamLLM', { provider: 'grok', message });
          return { ok: false, completionDisposition: 'completed-without-changes', summary: 'failed' };
        } }),
      });
      expect(result.providerErrors).toEqual({ count: 1, provider: 'grok', category });
    }
    const noError = await runSelfImplement({ feature: 'no provider error', seams: seams({
      implement: async () => ({ ok: false, completionDisposition: 'completed-without-changes', summary: 'no provider error' }),
    }) });
    expect(noError).not.toHaveProperty('providerErrors');
  });

  test('implement timeout forwards provider error classification and unregisters its sink', async () => {
    const originalRegisterSink = debug.registerSink;
    const registerSink = debug.registerSink.bind(debug);
    let activeSinks = 0;
    let unregisterCalls = 0;
    (debug as { registerSink: typeof debug.registerSink }).registerSink = ((sink) => {
      activeSinks++;
      const unregister = registerSink(sink);
      return () => {
        unregisterCalls++;
        activeSinks--;
        unregister();
      };
    }) as typeof debug.registerSink;
    try {
      const result = await runSelfImplement({
        feature: 'provider error timeout classification',
        stepTimeouts: { implement: 20 },
        seams: seams({
          implement: async () => {
            debug.log('llm.router.error', 'streamLLM', { provider: 'timeout-provider', message: 'provider overloaded' });
            return new Promise(() => {});
          },
        }),
      });
      expect(result).toMatchObject({ stage: 'timed-out', outcome: 'abandoned' });
      expect(result.abandonedClassification).toMatchObject({
        classification: 'provider-error',
        classificationBasis: 'environment-provider-error-outranks-run-stage-evidence',
        providerError: true,
      });
      expect(activeSinks).toBe(0);
      expect(unregisterCalls).toBe(1);
    } finally {
      (debug as { registerSink: typeof debug.registerSink }).registerSink = originalRegisterSink;
    }
  });

  test('implement timeout aborts the seam signal and logs one correlated abort event', async () => {
    const originalLog = debug.log;
    const events: Array<Record<string, unknown>> = [];
    let receivedSignal: AbortSignal | undefined;
    (debug as { log: typeof debug.log }).log = ((category, event, data, options) => {
      if (category === 'self-implement' && event === 'implement-timeout-abort') events.push((data ?? {}) as Record<string, unknown>);
      return originalLog.call(debug, category, event, data, options);
    }) as typeof debug.log;
    try {
      const result = await runSelfImplement({
        feature: 'timeout abort propagation',
        runId: 'run-implement-timeout-abort',
        stepTimeouts: { implement: 20 },
        seams: seams({
          implement: async ({ signal }) => {
            receivedSignal = signal;
            return new Promise(() => {});
          },
        }),
      });
      expect(result).toMatchObject({ stage: 'timed-out', outcome: 'abandoned' });
      expect(receivedSignal?.aborted).toBe(true);
      expect(events).toEqual([{ runId: 'run-implement-timeout-abort', round: 0, ms: 20 }]);
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
    }
  });

  test('timely implementation preserves its result without aborting its signal', async () => {
    let receivedSignal: AbortSignal | undefined;
    const result = await runSelfImplement({
      feature: 'timely implementation signal preservation',
      seams: seams({
        implement: async ({ signal }) => {
          receivedSignal = signal;
          return { ok: true, summary: 'impl' };
        },
      }),
    });
    expect(result.ok).toBe(true);
    expect(receivedSignal?.aborted).toBe(false);
  });

  test('provider error sink unregister failure preserves the terminal run result', async () => {
    const originalRegisterSink = debug.registerSink;
    const registerSink = debug.registerSink.bind(debug);
    let unregisterCalls = 0;
    (debug as { registerSink: typeof debug.registerSink }).registerSink = ((sink) => {
      const unregister = registerSink(sink);
      return () => {
        unregisterCalls++;
        unregister();
        throw new Error('unregister failure');
      };
    }) as typeof debug.registerSink;
    try {
      const result = await runSelfImplement({
        feature: 'unregister remains fail-soft',
        seams: seams({
          implement: async () => ({ ok: false, completionDisposition: 'completed-without-changes', summary: 'report missing' }),
        }),
      });
      expect(result.abandonedClassification).toMatchObject({
        classification: 'report-deficit',
        classificationBasis: 'terminal-state-not-reviewed',
      });
      expect(unregisterCalls).toBe(1);
    } finally {
      (debug as { registerSink: typeof debug.registerSink }).registerSink = originalRegisterSink;
    }
  });

  test('abandoned 분류는 실제 clean worktree의 세 신호를 결과와 관측 원장에 함께 보존한다', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'abandoned-orchestrator-'));
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = (debug as { log: typeof debug.log }).log;
    try {
      expect(spawnSync('git', ['init', '-q'], { cwd: repo }).status).toBe(0);
      (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
        events.push({ event, data: data as Record<string, unknown> });
      }) as typeof debug.log;
      const r = await runSelfImplement({
        feature: 'classification is preserved',
        seams: seams({
          createWorktree: async ({ branch, base }) => ({ path: repo, branch, base }),
          implement: async () => ({ ok: false, completionDisposition: 'completed-without-changes', summary: 'completed but report missing' }),
        }),
      });
      expect(r).toMatchObject({
        stage: 'aborted',
        outcome: 'abandoned',
        abandonedClassification: {
          classification: 'report-deficit',
          worktreeClean: true,
          completionDisposition: 'completed-without-changes',
          mustFixReported: false,
        },
      });
      expect(events).toContainEqual(expect.objectContaining({
        event: 'abandoned-classification',
        data: expect.objectContaining(r.abandonedClassification!),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('a declared document goal reaches abandoned classification as artifact-deficit', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'abandoned-document-goal-'));
    const worktree = join(directory, 'worktree');
    const goalFile = join(directory, 'GOAL-document.txt');
    mkdirSync(worktree);
    try {
      expect(spawnSync('git', ['init', '-q'], { cwd: worktree }).status).toBe(0);
      writeFileSync(join(worktree, 'docs.md'), 'draft artifact\n');
      writeFileSync(goalFile, 'Document artifact goal\n- GoalType: document\n');
      const result = await runSelfImplement({
        feature: 'document artifact',
        goalFile,
        writeGoalExecutionRecord: () => {},
        seams: seams({
          createWorktree: async ({ branch, base }) => ({ path: worktree, branch, base }),
          implement: async () => ({ ok: false, summary: 'artifact was unfinished' }),
        }),
      });
      expect(result.abandonedClassification).toMatchObject({
        classification: 'artifact-deficit',
        classificationBasis: 'non-implement-goal-type-artifact-deficit',
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  // EVIDENCE: [requested] declared document GoalType가 attachAbandonedClassification을 거쳐 artifact-deficit/basis로 기록된다 || bun test src/self-implement/orchestrator.test.ts
  // RESULT: 263 pass, 0 fail, Ran 263 tests across 1 file.
  // EVIDENCE: [preservation] abandoned ledger·observer wiring과 structured decomposition seam의 현재 계약을 회귀한다 || bun test src/self-implement/orchestrator.test.ts
  // RESULT: 263 pass, 0 fail, Ran 263 tests across 1 file.
  test('persists actual abandoned classification pairs to the durable run ledger', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'abandoned-ledger-record-'));
    const cleanWorktree = join(directory, 'clean-worktree');
    const goalFile = join(directory, 'GOAL-abandoned-ledger.txt');
    const goalRunStore = new GoalRunStore(join(directory, 'self-implement', 'goal-runs.db'));
    writeFileSync(goalFile, '- GoalId: 0123456789abcdef\n');
    mkdirSync(cleanWorktree);
    try {
      expect(spawnSync('git', ['init', '-q'], { cwd: cleanWorktree }).status).toBe(0);
      for (const [runId, worktreePath] of [
        ['run-clean-no-must-fix', cleanWorktree],
        ['run-unreadable-no-must-fix', join(directory, 'missing-worktree')],
      ] as const) {
        await runSelfImplement({
          feature: `persist ${runId}`,
          runId,
          goalFile,
          writeGoalExecutionRecord: () => {},
          writeGoalRunRecord: (path, record, goalId) => { goalRunStore.insert(path, record, goalId); },
          seams: seams({
            createWorktree: async ({ branch, base }) => ({ path: worktreePath, branch, base }),
            implement: async () => ({ ok: false, summary: 'abandoned for ledger classification' }),
          }),
        });
      }

      expect(goalRunStore.byRunId('run-clean-no-must-fix')[0]?.record).toMatchObject({
        outcome: 'abandoned',
        failureClassification: 'report-deficit',
        classificationBasis: 'terminal-state-not-reviewed',
      });
      expect(goalRunStore.byRunId('run-unreadable-no-must-fix')[0]?.record).toMatchObject({
        outcome: 'abandoned',
        failureClassification: 'implementation-deficit',
        classificationBasis: 'no-must-fix-without-clean-worktree-or-completed-without-changes',
      });
    } finally {
      goalRunStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('gate 통과했으나 approvePr 없음 → pr-declined(fail-closed·rework 무관)', async () => {
    const s = seams({ gateResults: [true] });
    delete (s as { approvePr?: unknown }).approvePr;
    const r = await runSelfImplement({ feature: 'F', seams: s });
    expect(r.stage).toBe('pr-declined');
  });

});

describe('runSelfImplement — reviewed artifact observation', () => {
  test('must-fix 원문과 goal file 원문을 지속 artifact에 넘기고 reviewed 로그에는 포인터만 남긴다', async () => {
    const original = (debug as { log: typeof debug.log }).log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const artifacts: unknown[] = [];
    const mustFix = `보존해야 하는 상세 지적 ${'내용 '.repeat(90)}`;
    const goalFile = reviewGoalFile();
    try {
      (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
        events.push({ event, data: data as Record<string, unknown> });
      }) as typeof debug.log;
      await runSelfImplement({
        feature: 'persist review output',
        goalFile,
        // ⛔⭐⭐ `goalFile` 을 주면 `recordGoalExecution` 이 **실제 저장소 파일에 append** 한다.
        //   이 주입이 빠져 이 테스트가 `docs/goals/GOAL-atomic-backlink-…` 에 합성 기록을
        //   써 넣었고(`durationMs: 0`), 그 변조가 PR 에 실렸다(2026-08-03 인수 실측).
        //   ⇒ ***`goalFile` 을 주는 테스트는 «반드시» 수집기를 같이 준다.***
        writeGoalExecutionRecord: () => {},
        seams: seams({
          reviewDiff: async () => ({ verdict: 'warn', mustFix: [mustFix], shouldFix: ['후속 정리'], summary: 'review', reviewed: true }),
          persistReviewArtifact: (input) => { artifacts.push(input); return { path: '/artifacts/review.json' }; },
        }),
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(artifacts).toEqual([expect.objectContaining({ findings: [mustFix, '후속 정리'], mustFix: [mustFix], shouldFix: ['후속 정리'], goalFile })]);
    const reviewed = events.find((entry) => entry.event === 'reviewed')!.data;
    expect(reviewed).toMatchObject({
      reviewed: true,
      mustFix: 1,
      shouldFix: 1,
      findingIds: [stableMustFixId(mustFix), stableMustFixId('후속 정리')],
      artifactPath: '/artifacts/review.json',
      symbolKeyedReviewFindingCount: 0,
      proseFallbackReviewFindingCount: 1,
    });
    expect(Object.prototype.hasOwnProperty.call(reviewed, 'failureReason')).toBe(false);
    expect(JSON.stringify(reviewed)).not.toContain(mustFix);
    expect(JSON.stringify(reviewed).length).toBeLessThan(310);
  });

  test('미실행 리뷰는 reviewed와 선택적 실패 사유를 관측하고 통과 문구를 내지 않는다', async () => {
    const original = (debug as { log: typeof debug.log }).log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const progress: string[] = [];
    try {
      (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
        events.push({ event, data: data as Record<string, unknown> });
      }) as typeof debug.log;
      await runSelfImplement({
        feature: 'review unavailable',
        seams: seams({
          reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'review unavailable', reviewed: false, failureReason: 'reviewer unavailable' }),
          onProgress: ({ stage, message }) => { if (stage === 'reviewed') progress.push(message); },
        }),
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(events.find((entry) => entry.event === 'reviewed')!.data).toMatchObject({
      verdict: 'pass', mustFix: 0, shouldFix: 0, findingIds: [], reviewed: false, failureReason: 'reviewer unavailable',
    });
    expect(progress).toEqual(['리뷰 미실행 (reviewer unavailable)']);
    expect(events).toContainEqual(expect.objectContaining({
      event: 'refute-not-submitted',
      data: expect.objectContaining({ refutableCount: 0, findingIds: [], submittedCount: 0, refutationGuidancePresented: false, refutationAcknowledged: 0 }),
    }));
  });

  test('실행된 깨끗한 리뷰는 기존 진행 접두부와 비교 전 추이를 함께 낸다', async () => {
    const progress: string[] = [];
    await runSelfImplement({
      feature: 'review completed',
      seams: seams({
        reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'review completed', reviewed: true }),
        onProgress: ({ stage, message }) => { if (stage === 'reviewed') progress.push(message); },
      }),
    });
    expect(progress).toEqual(['리뷰: pass (must-fix 0·should-fix 0) · 추이 0 (아직 못 잰다)']);
  });

  test('미실행 리뷰는 완료된 리뷰 must-fix 추이를 오염시키지 않는다', async () => {
    const progress: string[] = [];
    const s = revSeams({
      reviews: [
        { verdict: 'fail', reviewed: false, mustFix: ['unexecuted finding'] },
        { verdict: 'fail', mustFix: ['completed finding', 'completed finding 2'] },
        { verdict: 'pass', mustFix: [] },
      ],
      withApprove: false,
    });
    s.onProgress = ({ stage, message }) => { if (stage === 'reviewed') progress.push(message); };
    await runSelfImplement({ feature: 'unexecuted review trend isolation', maxReworkRounds: 2, seams: s });

    expect(progress).toEqual([
      '리뷰 미실행',
      '리뷰: fail (must-fix 2·should-fix 0) · 추이 2 (아직 못 잰다)',
      '리뷰: pass (must-fix 0·should-fix 0) · 추이 2→0 (줄고 있다)',
    ]);
  });

  test('must-fix 추이를 조건부 반사 없이 모든 reviewed 진행 줄에 판정한다', async () => {
    const collect = async (counts: number[]): Promise<string[]> => {
      const progress: string[] = [];
      const s = revSeams({
        reviews: counts.map((count, index) => ({
          verdict: index === counts.length - 1 ? 'pass' : 'fail',
          mustFix: Array.from({ length: count }, (_, finding) => `finding ${index}-${finding}`),
        })),
        withApprove: false,
      });
      s.onProgress = ({ stage, message }) => { if (stage === 'reviewed') progress.push(message); };
      await runSelfImplement({ feature: `review trend ${counts.join('-')}`, maxReworkRounds: counts.length - 1, seams: s });
      return progress;
    };

    await expect(collect([2, 3, 1])).resolves.toEqual([
      expect.stringContaining('리뷰: fail (must-fix 2·should-fix 0) · 추이 2 (아직 못 잰다)'),
      expect.stringContaining('리뷰: fail (must-fix 3·should-fix 0) · 추이 2→3 (진동)'),
      expect.stringContaining('리뷰: pass (must-fix 1·should-fix 0) · 추이 2→3→1 (진동)'),
    ]);
    await expect(collect([4, 3, 2])).resolves.toEqual([
      expect.any(String),
      expect.any(String),
      expect.stringContaining('추이 4→3→2 (줄고 있다)'),
    ]);
    await expect(collect([2, 3, 2, 3])).resolves.toEqual([
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.stringContaining('추이 2→3→2→3 (진동)'),
    ]);
  });

  test('goal-file-less runs omit goalFile from persisted review input', async () => {
    const artifacts: ReviewArtifactInput[] = [];
    await runSelfImplement({
      feature: 'persist review output without goal file',
      seams: seams({
        reviewDiff: async () => ({ verdict: 'warn', mustFix: [], shouldFix: [], summary: 'review', reviewed: true }),
        persistReviewArtifact: (input) => { artifacts.push(input); return { path: '/artifacts/review.json' }; },
      }),
    });
    expect(artifacts).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(artifacts[0]!, 'goalFile')).toBe(false);
  });
});

describe('runSelfImplement — reviewed canSelfRead observation', () => {
  async function reviewedObservation(review: SelfImplementReview): Promise<Record<string, unknown>> {
    const original = (debug as { log: typeof debug.log }).log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    try {
      (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
        events.push({ event, data: data as Record<string, unknown> });
      }) as typeof debug.log;
      await runSelfImplement({
        feature: 'reviewer capability observation',
        seams: seams({ reviewDiff: async () => review }),
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    return events.find((entry) => entry.event === 'reviewed')!.data;
  }

  const cleanReview = { verdict: 'pass' as const, mustFix: [] as string[], shouldFix: [] as string[], summary: 'review', reviewed: true };

  test('reviewerCanSelfReadObservation keeps yes, no, and unknown as three distinct values', () => {
    expect(reviewerCanSelfReadObservation(true)).toBe('yes');
    expect(reviewerCanSelfReadObservation(false)).toBe('no');
    expect(reviewerCanSelfReadObservation(undefined)).toBe('unknown');
    expect(reviewerCanSelfReadObservation(undefined)).not.toBe('no');
    expect(reviewerCanSelfReadObservation(false)).not.toBe('unknown');
    expect(reviewerCanSelfReadObservation(true)).not.toBe('unknown');
  });

  test('심이 스스로 읽을 수 있다고 선언하면 리뷰 판정 관측에 yes 가 실린다', async () => {
    const reviewed = await reviewedObservation({ ...cleanReview, canSelfRead: true });
    expect(reviewed.canSelfRead).toBe('yes');
    expect(reviewed).toMatchObject({ verdict: 'pass', mustFix: 0, shouldFix: 0, reviewed: true });
  });

  test('심이 능력을 선언하지 않으면 unknown 이 실리고 no 와 다른 값이다', async () => {
    const reviewed = await reviewedObservation(cleanReview);
    expect(reviewed.canSelfRead).toBe('unknown');
    expect(reviewed.canSelfRead).not.toBe('no');
    expect(Object.prototype.hasOwnProperty.call(reviewed, 'canSelfRead')).toBe(true);
    expect(reviewed).toMatchObject({
      verdict: 'pass', mustFix: 0, shouldFix: 0, findingIds: [], reviewed: true,
      symbolKeyedReviewFindingCount: 0, proseFallbackReviewFindingCount: 0,
    });
    expect(Object.prototype.hasOwnProperty.call(reviewed, 'failureReason')).toBe(false);
  });

  test('심이 스스로 읽을 수 없다고 선언하면 no 가 실리고 unknown 과 다른 값이다', async () => {
    const reviewed = await reviewedObservation({ ...cleanReview, canSelfRead: false });
    expect(reviewed.canSelfRead).toBe('no');
    expect(reviewed.canSelfRead).not.toBe('unknown');
    expect(reviewed).toMatchObject({ verdict: 'pass', mustFix: 0, shouldFix: 0, reviewed: true });
  });

  test('기존 리뷰 관측 필드와 진행 문면은 그대로다', async () => {
    const original = (debug as { log: typeof debug.log }).log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const progress: string[] = [];
    try {
      (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
        events.push({ event, data: data as Record<string, unknown> });
      }) as typeof debug.log;
      await runSelfImplement({
        feature: 'review completed',
        seams: seams({
          reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'review completed', reviewed: true }),
          onProgress: ({ stage, message }) => { if (stage === 'reviewed') progress.push(message); },
        }),
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    const reviewed = events.find((entry) => entry.event === 'reviewed')!.data;
    expect(reviewed).toMatchObject({
      verdict: 'pass', mustFix: 0, shouldFix: 0, findingIds: [], reviewed: true,
      symbolKeyedReviewFindingCount: 0, proseFallbackReviewFindingCount: 0,
    });
    expect(Object.prototype.hasOwnProperty.call(reviewed, 'failureReason')).toBe(false);
    expect(progress).toEqual(['리뷰: pass (must-fix 0·should-fix 0) · 추이 0 (아직 못 잰다)']);
  });
});

describe('runSelfImplement — worktree base observation', () => {
  test('integration ancestry와 base 출처를 관측하고, non-integration base를 warn한다', async () => {
    const original = (debug as { log: typeof debug.log }).log;
    const events: Array<{ event: string; data: Record<string, unknown>; opt?: { level?: string } }> = [];
    (debug as { log: typeof debug.log }).log = ((_category, event, data, opt) => {
      events.push({ event, data: data as Record<string, unknown>, opt: opt as { level?: string } | undefined });
    }) as typeof debug.log;
    try {
      const createWorktree = async ({ branch, base }: { branch: string; base?: string }) => ({
        path: `/wt/${branch}`,
        branch,
        base,
        resolvedBase: base === 'release' ? 'b'.repeat(40) : 'a'.repeat(40),
        invokedHead: 'c'.repeat(40),
        baseIsIntegration: base === 'release' ? false : true,
      });
      await runSelfImplement({
        feature: 'explicit stacked base',
        base: 'release',
        baseSource: 'human',
        baseSelectionRule: 'explicit',
        seams: seams({ createWorktree }),
      });
      await runSelfImplement({ feature: 'default integration base', seams: seams({ createWorktree }) });
      await runSelfImplement({
        feature: 'default feature base',
        seams: seams({ createWorktree: async ({ branch }) => ({
          path: `/wt/${branch}`,
          branch,
          resolvedBase: 'd'.repeat(40),
          invokedHead: 'c'.repeat(40),
          baseIsIntegration: false,
        }) }),
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    const worktrees = events.filter((entry) => entry.event === 'worktree' && 'baseIsIntegration' in entry.data).map((entry) => entry.data);
    expect(worktrees).toEqual([
      expect.objectContaining({ requestedBase: 'release', requestedBaseSource: 'human', baseSelectionRule: 'explicit', resolvedBase: 'b'.repeat(40), invokedHead: 'c'.repeat(40), invokedHeadDiffers: true, baseIsIntegration: false }),
      expect.objectContaining({ requestedBase: null, requestedBaseSource: 'automatic', baseSelectionRule: null, resolvedBase: 'a'.repeat(40), invokedHead: 'c'.repeat(40), invokedHeadDiffers: true, baseIsIntegration: true }),
      expect.objectContaining({ requestedBase: null, requestedBaseSource: 'automatic', baseSelectionRule: null, resolvedBase: 'd'.repeat(40), invokedHead: 'c'.repeat(40), invokedHeadDiffers: true, baseIsIntegration: false }),
    ]);
    const warnings = events.filter((entry) => entry.event === 'worktree-base-warning');
    expect(warnings).toHaveLength(2);
    expect(warnings.map((warning) => warning.data)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resolvedBase: 'b'.repeat(40), baseIsIntegration: false, requestedBaseSource: 'human',
        message: '⚠️ resolved base is known not to be an ancestor of origin/main.',
      }),
      expect.objectContaining({
        resolvedBase: 'd'.repeat(40), baseIsIntegration: false, requestedBaseSource: 'automatic',
        message: '⚠️ resolved base is known not to be an ancestor of origin/main.',
      }),
    ]));
    expect(warnings.every((warning) => warning.opt?.level === 'warn')).toBe(true);
  });

  test('baseIsIntegration 이 판정 불가(undefined)면 판정 불가 문면으로 warn한다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_c, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await runSelfImplement({
        feature: 'undeterminable base',
        seams: seams({ createWorktree: async ({ branch }) => ({
          path: `/wt/${branch}`,
          branch,
          resolvedBase: 'e'.repeat(40),
          invokedHead: 'c'.repeat(40),
          // ⭐ 판정 불가 — 필드를 **생략**한다(빈 값을 싣지 않는다).
        }) }),
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    const worktree = events.find((entry) => entry.event === 'worktree' && 'baseIsIntegration' in entry.data)!.data;
    expect(worktree.baseIsIntegration).toBeNull();
    const warnings = events.filter((entry) => entry.event === 'worktree-base-warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.data).toMatchObject({
      baseIsIntegration: null,
      message: '⚠️ unable to determine whether resolved base is an ancestor of origin/main.',
    });
  });
});

describe('runSelfImplement — traversal shadow wiring', () => {
  function capturePipelineEvents(): {
    events: Array<{ event: string; data: Record<string, unknown>; opt?: { compact?: { arrayMax?: number } } }>;
    restore: () => void;
  } {
    const original = (debug as { log: typeof debug.log }).log;
    const events: Array<{ event: string; data: Record<string, unknown>; opt?: { compact?: { arrayMax?: number } } }> = [];
    (debug as { log: typeof debug.log }).log = ((_category, event, data, opt) => {
      events.push({ event, data: data as Record<string, unknown>, opt: opt as { compact?: { arrayMax?: number } } | undefined });
    }) as typeof debug.log;
    return { events, restore: () => { (debug as { log: typeof debug.log }).log = original; } };
  }

  test('declared nodes are reached with ordered legal traversals across main-sync and rework paths', async () => {
    const { events, restore } = capturePipelineEvents();
    try {
      await runSelfImplement({ feature: 'regate', seams: terminalG2Seams({ mergeStatus: 'llm-resolved', gateResults: [true, true] }) });
      await runSelfImplement({ feature: 'sync direct', seams: terminalG2Seams({ mergeStatus: 'up-to-date', gateResults: [true] }) });
      await runSelfImplement({ feature: 'recheck', seams: terminalG2Seams({ mergeStatus: 'merged', gateResults: [true, true] }) });
      await runSelfImplement({ feature: 'review', seams: seams({ reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'review', reviewed: true }) }) });
      await runSelfImplement({ feature: 'plain', seams: seams({}) });
      await runSelfImplement({ feature: 'rework', maxReworkRounds: 1, seams: seams({ gateResults: [false, true] }) });
      await runSelfImplement({ feature: 'merge', autoMerge: true, seams: seams({ reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'review', reviewed: true, diffTruncated: false }), mergePr: async () => ({ merged: true }) }) });
    } finally {
      restore();
    }

    const entryEvents = events.filter((entry) => entry.event === 'pipeline-node-entry');
    const observed = new Set(entryEvents.map((entry) => entry.data.node));
    const expected = new Set(Object.keys(PIPELINE_EDGES_BY_NODE));
    expect(observed).toEqual(expected);

    const traversals = events.filter((entry) => entry.event === 'pipeline-traversal-shadow');
    expect(traversals).toHaveLength(7);
    expect(traversals.map((entry) => entry.data)).toEqual(expect.arrayContaining([
      expect.objectContaining({ classification: 'legal-terminal-match', observedNodes: ['implement', 'gate', 'main-sync', 'regate', 'open-pr'], terminalNode: 'open-pr' }),
      expect.objectContaining({ classification: 'legal-terminal-match', observedNodes: ['implement', 'gate', 'main-sync', 'open-pr'], terminalNode: 'open-pr' }),
      expect.objectContaining({ classification: 'legal-terminal-match', observedNodes: ['implement', 'gate', 'open-pr'], terminalNode: 'open-pr' }),
      expect.objectContaining({ classification: 'legal-terminal-match', observedNodes: ['implement', 'gate', 'rework', 'implement', 'gate', 'open-pr'], terminalNode: 'open-pr' }),
    ]));
  });

  test('preserves an eight-node traversal and its count through the default log compactor', async () => {
    const { events, restore } = capturePipelineEvents();
    try {
      await runSelfImplement({
        feature: 'eight-node traversal',
        seams: seams({
          checkPipelineTraversal: () => ({
            classification: 'legal-terminal-match',
            terminalResolution: 'observed',
            observedNodes: [
              'implement', 'gate', 'review', 'rework', 'main-sync', 'regate', 'open-pr', 'merge',
            ],
            terminalNode: 'merge',
          }),
        }),
      });
    } finally {
      restore();
    }

    const traversal = events.find((entry) => entry.event === 'pipeline-traversal-shadow')!;
    const compacted = compactForLog(traversal.data, traversal.opt?.compact);
    expect(traversal.opt).toEqual({ compact: { arrayMax: Number.MAX_SAFE_INTEGER } });
    expect(traversal.data).toMatchObject({ observedNodeCount: 8 });
    expect(compacted.observedNodes).toEqual([
      'implement', 'gate', 'review', 'rework', 'main-sync', 'regate', 'open-pr', 'merge',
    ]);
    expect(compacted.observedNodes).not.toContainEqual({ _more: expect.any(Number) });
  });

  // ⭐ RFC §5 1단계 «게이트 ⑵» — 그림자 구간의 「골 종류」축. ⛔ 「골 파일 없음」과 「못 읽음」을 가른다.
  test('1단계 ⑵ — 그림자 관측이 goalTypeSource 를 «닫힌 값»으로 단다', async () => {
    const seen: Array<{ event: string; data: Record<string, unknown> }> = [];
    const { restore } = capturePipelineEvents();
    try {
      await runSelfImplement({
        feature: 'goal-kind-axis', runId: 'run-goal-kind-axis', memory: false,
        seams: seams({ observePipeline: (event, data) => { seen.push({ event, data }); } }),
      });
    } finally { restore(); }
    const shadows = seen.filter((e) => e.event === 'pipeline-traversal-shadow');
    expect(shadows.length).toBeGreaterThan(0);                       // ⛔ 분모
    const CLOSED = ['declared', 'default', 'malformed', 'no-goal-file', 'unreadable'];
    for (const s of shadows) expect(CLOSED).toContain(String(s.data.goalTypeSource));
    // 이 런은 골 파일을 안 준다 ⇒ 「없음」이지 「못 읽음」이 아니다
    expect(shadows.every((s) => s.data.goalTypeSource === 'no-goal-file')).toBe(true);
  });

  // ⭐ RFC §5 «0단계» — 원장 줄이 「어느 선언으로 걸었나」를 답한다. ⛔ 이것 없이는
  //   「선언을 바꿔서 나아졌나」를 원리상 못 잰다. 반증: 신원 spread 를 지우면 이 시험이 «빨강»이다.
  test('attempt ordinals increment per canonical runId, remain stable per attempt, and join all pipeline event kinds', async () => {
    const seen: Array<{ event: string; data: Record<string, unknown> }> = [];
    const runId = 'run-attempt-ordinal-reentry';
    const observer = (event: string, data: Record<string, unknown>) => { seen.push({ event, data }); };
    await runSelfImplement({ feature: 'attempt ordinal first', runId, memory: false, seams: seams({ observePipeline: observer }) });
    const firstAttempt = seen.filter((entry) => entry.data.attemptOrdinal === 1);
    expect(firstAttempt.length).toBeGreaterThan(0);
    expect(new Set(firstAttempt.map((entry) => entry.data.attemptOrdinal))).toEqual(new Set([1]));

    await runSelfImplement({ feature: 'attempt ordinal second', runId, memory: false, seams: seams({ observePipeline: observer }) });
    const secondAttempt = seen.filter((entry) => entry.data.attemptOrdinal === 2);
    expect(secondAttempt.length).toBeGreaterThan(0);
    expect(new Set(secondAttempt.map((entry) => entry.data.attemptOrdinal))).toEqual(new Set([2]));
    for (const event of ['pipeline-node-entry', 'pipeline-traversal-shadow', 'graph-visit-budget']) {
      const ordinals = new Set(secondAttempt.filter((entry) => entry.event === event).map((entry) => entry.data.attemptOrdinal));
      expect(ordinals).toEqual(new Set([2]));
    }
  });

  test('attempt ordinal state is bounded and reports lookup failures explicitly', () => {
    expect(readRunAttemptOrdinal('')).toBe(UNMEASURED_ATTEMPT_ORDINAL);
    expect(readRunAttemptOrdinal('run-attempt-ordinal-missing')).toBe(UNMEASURED_ATTEMPT_ORDINAL);
    expect(incrementRunAttemptOrdinal('run-attempt-ordinal-read')).toBe(1);
    expect(readRunAttemptOrdinal('run-attempt-ordinal-read')).toBe(1);
    expect(incrementRunAttemptOrdinal('run-attempt-ordinal-read')).toBe(2);
    expect(readRunAttemptOrdinal('run-attempt-ordinal-read')).toBe(2);

    const evictedRunId = 'run-attempt-ordinal-evicted';
    incrementRunAttemptOrdinal(evictedRunId);
    for (let index = 0; index < MAX_TRACKED_RUN_ATTEMPT_ORDINALS; index++) {
      incrementRunAttemptOrdinal(`run-attempt-ordinal-cap-${index}`);
    }
    expect(readRunAttemptOrdinal(evictedRunId)).toBe(UNMEASURED_ATTEMPT_ORDINAL);
  });

  test('0단계 — 모든 파이프라인 관측이 graphId·graphVersion 을 «단다»', async () => {
    const seen: Array<{ event: string; data: Record<string, unknown> }> = [];
    const { restore } = capturePipelineEvents();
    try {
      await runSelfImplement({
        feature: 'graph-identity', runId: 'run-graph-identity', memory: false,
        seams: seams({ observePipeline: (event, data) => { seen.push({ event, data }); } }),
      });
    } finally { restore(); }
    // ⛔ 분모가 0이면 «통과가 아니라 unmeasured» 다 — RFC §5 0단계가 그렇게 못 박았다.
    expect(seen.length).toBeGreaterThan(0);
    // 📏 2026-09-08 정정: 신원은 이제 «도는 템플릿»에서 온다(YAML 이 출처).
    //   ⛔ 옛 pipelineGraphIdentity() 를 기대하면 걸음과 신원이 갈린 판을 «통과시킨다».
    //   ⇒ 여기서 묻는 것은 「값이 있나 ⊕ 모든 관측이 «같은» 신원을 다나」다.
    const ids = new Set(seen.map((e) => `${String(e.data.graphId)}@${String(e.data.graphVersion)}`));
    expect(ids.size).toBe(1);
    const [only] = [...ids];
    expect(only).not.toContain('undefined');
    const withGraph = seen.filter((e) => typeof e.data.graphId === 'string' && typeof e.data.graphVersion === 'string');
    expect(withGraph).toHaveLength(seen.length);
  });

  test.each(['pod', undefined] as const)('node entry compares the pod run contract on %s substrate without blocking', async (substrate) => {
    const originalContract = process.env.ELANOUS_RUN_CONTRACT;
    const originalSubstrate = process.env.ELANOUS_SUBSTRATE;
    const originalLog = debug.log;
    const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
    const log: Array<{ event: string; data: Record<string, unknown>; level: unknown }> = [];
    process.env.ELANOUS_RUN_CONTRACT = JSON.stringify({ substrate: 'pod', profile: 'test-profile', effects: 'draft-pr' });
    if (substrate === undefined) delete process.env.ELANOUS_SUBSTRATE;
    else process.env.ELANOUS_SUBSTRATE = substrate;
    (debug as { log: typeof debug.log }).log = ((_category, event, data, options) => {
      log.push({ event, data: data as Record<string, unknown>, level: options?.level });
    }) as typeof debug.log;
    try {
      const result = await runSelfImplement({
        feature: 'contract node entry', runId: `run-contract-entry-${substrate ?? 'local'}`, memory: false,
        seams: seams({ writeRunLedger: ({ event, data }) => { ledger.push({ event, data }); } }),
      });
      expect(result.node).toBe('open-pr');
      const entries = ledger.filter(({ event }) => event === 'pipeline-node-entry');
      expect(entries.length).toBeGreaterThan(0);
      const honored = substrate === 'pod';
      for (const { data } of entries) {
        expect(data).toMatchObject({
          contractSubstrate: 'pod', actualSubstrate: substrate ?? 'local', contractHonored: honored,
          profile: 'test-profile', effects: 'draft-pr', effectsHonored: 'unmeasured',
        });
      }
      expect(ledger.filter(({ event }) => event === 'graph-run-contract-resolved')).toHaveLength(1);
      const violations = log.filter(({ event }) => event === 'graph-contract-violation');
      expect(ledger.filter(({ event }) => event === 'graph-contract-violation')).toHaveLength(honored ? 0 : entries.length);
      expect(violations).toHaveLength(honored ? 0 : entries.length);
      for (const violation of violations) {
        expect(violation.level).toBe('warn');
        expect(violation.data).toMatchObject({
          node: expect.any(String), round: expect.any(Number),
          contractSubstrate: 'pod', actualSubstrate: 'local',
        });
      }
      expect(violations.map(({ data }) => [data.node, data.round])).toEqual(entries.filter(() => !honored).map(({ data }) => [data.node, data.round]));
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
      if (originalContract === undefined) delete process.env.ELANOUS_RUN_CONTRACT;
      else process.env.ELANOUS_RUN_CONTRACT = originalContract;
      if (originalSubstrate === undefined) delete process.env.ELANOUS_SUBSTRATE;
      else process.env.ELANOUS_SUBSTRATE = originalSubstrate;
    }
  });

  test('0단계 — pipeline-node-entry가 현재 그래프의 노드 선언 판정을 기록한다', async () => {
    const seen: Array<{ event: string; data: Record<string, unknown> }> = [];
    await runSelfImplement({
      feature: 'node declaration status', runId: 'run-node-declaration-status', memory: false,
      seams: seams({ observePipeline: (event, data) => { seen.push({ event, data }); } }),
    });
    const entries = seen.filter((entry) => entry.event === 'pipeline-node-entry');
    expect(entries.length).toBeGreaterThan(0);
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ data: expect.objectContaining({ graphId: 'self-implement', node: 'implement', nodeDeclarationStatus: 'declared' }) }),
    ]));
  });

  // ⭐ `graphVersion` 은 «선언 내용»의 해시다 — 값이 있고, 안정적이고, id 와 «다른 값»이다.
  test('0단계 — graphVersion 은 값이 있고 부르는 때마다 같다', () => {
    const a = pipelineGraphVersion();
    const b = pipelineGraphVersion();
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/u);
    expect(a).not.toBe(PIPELINE_GRAPH_ID);
  });

  test('enabling additive traversal instrumentation preserves result and every existing observation', async () => {
    const run = async (observePipeline: SelfImplementSeams['observePipeline']) => {
      const { events, restore } = capturePipelineEvents();
      const pipelineEvents: Array<{ event: string; data: Record<string, unknown> }> = [];
      try {
        const result = await runSelfImplement({
          feature: 'invariance', runId: 'run-pipeline-invariance', memory: false,
          seams: seams({ observePipeline: observePipeline === false ? false : (event, data) => { pipelineEvents.push({ event, data }); } }),
        });
        return { result, existing: events, pipelineEvents };
      } finally {
        restore();
      }
    };

    const disabled = await run(false);
    const enabled = await run(() => {});
      expect(enabled.result).toEqual(disabled.result);
      const withoutTerminalSequence = (entries: typeof enabled.existing) => entries.map(({ data, ...entry }) => {
        const { terminalSeq: _terminalSeq, ...existingData } = data;
        return { ...entry, data: existingData };
      });
      expect(withoutTerminalSequence(enabled.existing)).toEqual(withoutTerminalSequence(disabled.existing));
      expect(enabled.pipelineEvents.filter(({ event }) => event !== 'graph-visit-budget')).toEqual([
        expect.objectContaining({ event: 'pipeline-node-entry', data: expect.objectContaining({ node: 'implement', round: 0, runId: 'run-pipeline-invariance' }) }),
        expect.objectContaining({ event: 'pipeline-node-entry', data: expect.objectContaining({ node: 'gate', round: 0, runId: 'run-pipeline-invariance' }) }),
        expect.objectContaining({ event: 'pipeline-node-entry', data: expect.objectContaining({ node: 'open-pr', round: 0, runId: 'run-pipeline-invariance' }) }),
        expect.objectContaining({ event: 'pipeline-traversal-shadow', data: expect.objectContaining({ classification: 'legal-terminal-match', terminalNode: 'open-pr', runId: 'run-pipeline-invariance' }) }),
      ]);
      const budgetEvents = enabled.pipelineEvents.filter(({ event }) => event === 'graph-visit-budget');
      expect(budgetEvents.map(({ data }) => data.node)).toEqual(['implement', 'gate', 'open-pr']);
  });

  test('checker and pipeline observer failures are fail-soft', async () => {
    const baseline = await runSelfImplement({ feature: 'observer baseline', runId: 'run-observer-fail-soft', memory: false, seams: seams({ observePipeline: false }) });
    const rejected = await runSelfImplement({
      feature: 'observer baseline', runId: 'run-observer-fail-soft', memory: false,
      seams: seams({
        checkPipelineTraversal: () => { throw new Error('checker unavailable'); },
        observePipeline: () => Promise.reject(new Error('observer unavailable')),
      }),
    });
    const thrown = await runSelfImplement({
      feature: 'observer baseline', runId: 'run-observer-fail-soft', memory: false,
      seams: seams({ observePipeline: () => { throw new Error('observer unavailable'); } }),
    });
    expect(rejected).toEqual(baseline);
    expect(thrown).toEqual(baseline);
  });

  test('unexpected errors rethrow unchanged after exactly one unclassifiable traversal record', async () => {
    const pipelineEvents: Array<{ event: string; data: Record<string, unknown> }> = [];
    const failure = new Error('unexpected implement failure');
    await expect(runSelfImplement({
      feature: 'unexpected failure', runId: 'run-unexpected-failure', memory: false,
      seams: seams({
        implement: async () => { throw failure; },
        observePipeline: (event, data) => { pipelineEvents.push({ event, data }); },
      }),
    })).rejects.toBe(failure);
    expect(pipelineEvents.filter((entry) => entry.event === 'pipeline-traversal-shadow')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ classification: 'unclassifiable', terminalNode: null, observedNodes: ['implement'], runId: 'run-unexpected-failure' }) }),
    ]);
  });

  test('rethrows the original exception when its description access or coercion fails', async () => {
    const messageGetterFailure = Object.create(Error.prototype) as Error;
    Object.defineProperty(messageGetterFailure, 'message', {
      get(): never { throw new Error('message getter failed'); },
    });
    const coercionFailure = {
      toString(): never { throw new Error('string coercion failed'); },
    };

    for (const failure of [messageGetterFailure, coercionFailure]) {
      await expect(runSelfImplement({
        feature: 'unsafe exception description', memory: false,
        seams: seams({ implement: async () => { throw failure; } }),
      })).rejects.toBe(failure);
    }
  });

  // ⛔⭐⭐⭐ 잡히지 않은 예외로 죽어도 «종결이 남아야» 한다 (2026-08-11 · 🅣 71차 · 대표 「종료 때 정리」).
  //   실측: 미완 57 중 ≈38 이 어느 원장에도 종결이 없었고 멈춘 자리가 «전부 노드 안»이었다.
  //   그 유령이 발사 전 검사에 걸려 «실제 발사»를 두 번 막았다.
  test('uncaught exception still writes a terminal run-status with failureKind crashed', async () => {
    const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
    const failure = new Error('unexpected implement failure');
    await expect(runSelfImplement({
      feature: 'crash terminal', runId: 'run-terminal-crashed', memory: false,
      seams: seams({
        writeRunLedger: (entry) => { ledger.push({ event: entry.event, data: entry.data }); },
        implement: async () => { throw failure; },
      }),
    })).rejects.toBe(failure);
    const runStatus = ledger.filter((entry) => entry.event === 'run-status');
    expect(runStatus.length).toBeGreaterThan(0);
    expect(runStatus.at(-1)!.data).toMatchObject({ runStatus: 'failed', failureKind: 'crashed' });
  });

  test('records one fail-soft HITL terminal retrospective for normal, timeout, and rethrown exception exits', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const original = (debug as { log: typeof debug.log }).log;
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ category, event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    const failure = new Error('unexpected implement failure');
    try {
      await runSelfImplement({
        feature: 'normal terminal', runId: 'run-terminal-normal', parentSessionId: 'parent-normal', memory: false,
        seams: seams({ forkSession: async () => 'session-normal' }),
      });
      await runSelfImplement({
        feature: 'timeout terminal', runId: 'run-terminal-timeout', parentSessionId: 'parent-timeout', memory: false,
        stepTimeouts: { gate: 20 },
        seams: seams({ forkSession: async () => 'session-timeout', gate: () => new Promise(() => {}) as Promise<{ passed: boolean }> }),
      });
      await expect(runSelfImplement({
        feature: 'exception terminal', runId: 'run-terminal-exception', parentSessionId: 'parent-exception', memory: false,
        seams: seams({ forkSession: async () => 'session-exception', implement: async () => { throw failure; } }),
      })).rejects.toBe(failure);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }

    const retrospectives = events.filter((entry) => entry.category === 'self-dev.hitl' && entry.data.action === 'run-terminal');
    expect(retrospectives).toEqual([
      expect.objectContaining({ event: 'decision-surfaced', data: expect.objectContaining({
        runId: 'run-terminal-normal', stage: 'pr-opened', outcome: 'completed', supervisorVerdict: null, abandonedClassification: null,
        sessionId: 'session-normal', parentSessionId: 'parent-normal', terminalSeq: 1, terminalSeqScope: 'process',
      }) }),
      expect.objectContaining({ event: 'decision-surfaced', data: expect.objectContaining({
        runId: 'run-terminal-timeout', stage: 'timed-out', outcome: 'abandoned', supervisorVerdict: null,
        sessionId: 'session-timeout', parentSessionId: 'parent-timeout', terminalSeq: 1, terminalSeqScope: 'process',
      }) }),
      expect.objectContaining({ event: 'escalation', data: expect.objectContaining({
        runId: 'run-terminal-exception', pattern: 'exception', decision: 'rethrow', stage: null, outcome: null, supervisorVerdict: null, abandonedClassification: null,
        sessionId: 'session-exception', parentSessionId: 'parent-exception', terminalSeq: 1, terminalSeqScope: 'process', terminalUnknownReason: 'Error', error: 'unexpected implement failure',
      }) }),
    ]);
  });

  test('sequences terminal HITL provenance per runId within this process', async () => {
    const events: Array<{ category: string; data: Record<string, unknown> }> = [];
    const original = (debug as { log: typeof debug.log }).log;
    (debug as { log: typeof debug.log }).log = ((category, _event, data) => {
      events.push({ category, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      for (const runId of ['run-terminal-sequence-same', 'run-terminal-sequence-same', 'run-terminal-sequence-other']) {
        await runSelfImplement({ feature: `terminal sequence ${runId}`, runId, memory: false, seams: seams({}) });
      }
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }

    const terminalEvents = events.filter((entry) => entry.category === 'self-dev.hitl' && entry.data.action === 'run-terminal');
    expect(terminalEvents.map(({ data }) => ({
      runId: data.runId,
      sessionId: data.sessionId,
      parentSessionId: data.parentSessionId,
      terminalSeq: data.terminalSeq,
      terminalSeqScope: data.terminalSeqScope,
    }))).toEqual([
      { runId: 'run-terminal-sequence-same', sessionId: null, parentSessionId: null, terminalSeq: 1, terminalSeqScope: 'process' },
      { runId: 'run-terminal-sequence-same', sessionId: null, parentSessionId: null, terminalSeq: 2, terminalSeqScope: 'process' },
      { runId: 'run-terminal-sequence-other', sessionId: null, parentSessionId: null, terminalSeq: 1, terminalSeqScope: 'process' },
    ]);
  });
});

describe('runSelfImplement — terminal pipeline nodes', () => {
  test('every exercised terminal result is declared by its producing node', async () => {
    const results = await Promise.all([
      runSelfImplement({ feature: 'implement', seams: seams({ implement: async () => ({ ok: false, summary: 'failed' }) }) }),
      runSelfImplement({ feature: 'timeout', stepTimeouts: { gate: 20 }, seams: seams({ gate: () => new Promise(() => {}) as Promise<{ passed: boolean }> }) }),
      runSelfImplement({ feature: 'rework', maxReworkRounds: 0, seams: seams({ gateResults: [false] }) }),
      runSelfImplement({ feature: 'review rework', maxReworkRounds: 0, seams: seams({ reviewDiff: async () => ({ verdict: 'fail', mustFix: ['fix'], shouldFix: [], summary: 'fix', reviewed: true }) }) }),
      runSelfImplement({ feature: 'declined', seams: (() => { const s = seams({}); delete (s as { approvePr?: unknown }).approvePr; return s; })() }),
      runSelfImplement({ feature: 'sync', seams: terminalG2Seams({ mergeStatus: 'conflict-unresolved', gateResults: [true] }) }),
      runSelfImplement({ feature: 'regate', seams: terminalG2Seams({ mergeStatus: 'llm-resolved', gateResults: [true, false] }) }),
      runSelfImplement({ feature: 'recheck', seams: terminalG2Seams({ mergeStatus: 'merged', gateResults: [true, false] }) }),
      runSelfImplement({ feature: 'opened', seams: seams({}) }),
      runSelfImplement({ feature: 'merged', autoMerge: true, seams: seams({ reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'review', reviewed: true, diffTruncated: false }), mergePr: async () => ({ merged: true }) }) }),
      runSelfImplement({ feature: 'merge fallback', autoMerge: true, seams: seams({ reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'review', reviewed: true, diffTruncated: false }), mergePr: async () => ({ merged: false }) }) }),
    ]);

    for (const result of results) {
      expect(TERMINAL_STAGES_BY_NODE[result.node] as readonly string[]).toContain(result.stage);
    }
    expect(results.map((result) => result.node)).toEqual([
      'implement', 'implement', 'rework', 'open-pr', 'open-pr', 'main-sync', 'regate', 'regate', 'open-pr', 'merge', 'merge',
    ] satisfies readonly PipelineNodeId[]);
  });

  test('gate-failed identifies rework and post-sync regate separately', async () => {
    const [rework, conflictRegate, cleanRegate] = await Promise.all([
      runSelfImplement({ feature: 'rework', maxReworkRounds: 0, seams: seams({ gateResults: [false] }) }),
      runSelfImplement({ feature: 'regate', seams: terminalG2Seams({ mergeStatus: 'llm-resolved', gateResults: [true, false] }) }),
      runSelfImplement({ feature: 'recheck', seams: terminalG2Seams({ mergeStatus: 'merged', gateResults: [true, false] }) }),
    ]);

    expect([rework, conflictRegate, cleanRegate]).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'gate-failed', node: 'rework' }),
      expect.objectContaining({ stage: 'gate-failed', node: 'regate' }),
    ]));
    expect(conflictRegate).toMatchObject({ stage: 'gate-failed', node: 'regate' });
    expect(cleanRegate).toMatchObject({ stage: 'gate-failed', node: 'regate' });
  });

  test('post-sync timeout-only gate failure with no child responsibility continues and retains the exemption in its result', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = (debug as { log: typeof debug.log }).log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const s = terminalG2Seams({ mergeStatus: 'merged', gateResults: [true, false] });
      let call = 0;
      s.gate = async () => call++ === 0
        ? { passed: true, log: 'gate' }
        : { passed: false, log: 'timeout', reflectGateFacts: { introduced: 0, preexisting: 0, unknown: 0, timedOut: 1, childResponsibility: 'none' } };
      const result = await runSelfImplement({ feature: 'timeout-only regate exemption', seams: s });
      expect(result).toMatchObject({ ok: true, stage: 'pr-opened', node: 'open-pr', gate: { passed: false, reflectGateFacts: { introduced: 0, preexisting: 0, unknown: 0, timedOut: 1, childResponsibility: 'none' } } });
      expect(events).toContainEqual(expect.objectContaining({
        event: 'gate.postsync',
        data: expect.objectContaining({ passed: false, introduced: 0, preexisting: 0, unknown: 0, timedOut: 1, childResponsibility: 'none', exempted: true }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test.each([
    ['timeout', { introduced: 0, preexisting: 0, unknown: 0, timedOut: 1 }],
    ['flaky rerun', { introduced: 0, preexisting: 0, unknown: 0, timedOut: 0, flakyRerun: 1 }],
  ] as const)('post-sync %s only without child attribution continues under human confirmation', async (_label, facts) => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => { events.push({ event, data: data as Record<string, unknown> }); }) as typeof debug.log;
    let approvals = 0;
    let merges = 0;
    try {
      const s = terminalG2Seams({ mergeStatus: 'merged', gateResults: [true, false] });
      s.gate = async (_cwd, ctx) => ctx?.mode === 'postsync'
        ? { passed: false, log: 'timed out', reflectGateFacts: facts }
        : { passed: true, log: 'ok' };
      s.reviewDiff = async () => ({ verdict: 'warn', mustFix: [], shouldFix: [], summary: 'reviewed', reviewed: true, diffTruncated: false });
      s.approvePr = async () => { approvals++; return true; };
      s.mergePr = async () => { merges++; return { merged: true }; };
      const result = await runSelfImplement({ feature: 'post-sync timeout human confirmation', autoMerge: true, seams: s });
      expect(result).toMatchObject({ stage: 'pr-opened', mergeReason: GATE_TIMEOUT_UNMEASURED_MERGE_REASON, gate: { passed: false } });
      expect(approvals).toBe(1);
      expect(merges).toBe(0);
      expect(events.filter(({ event }) => event === 'post-sync-gate-timeout-only-continued')).toHaveLength(1);
      expect(events.find(({ event }) => event === 'post-sync-gate-timeout-only-continued')?.data)
        .toMatchObject({ introduced: 0, unknown: 0, timedOut: facts.timedOut });
      expect(events.filter(({ event }) => event === 'merge-decision')).toHaveLength(1);
      expect(events.filter(({ event }) => event === 'merge-decision').at(-1)?.data).toMatchObject({ decision: 'hitl', reason: GATE_TIMEOUT_UNMEASURED_MERGE_REASON });
    } finally { (debug as { log: typeof debug.log }).log = original; }
  });

  test('post-sync timeout-only after LLM conflict resolution also continues without automatic merge', async () => {
    const s = terminalG2Seams({ mergeStatus: 'llm-resolved', gateResults: [true, false] });
    s.gate = async (_cwd, ctx) => ctx?.mode === 'postsync'
      ? { passed: false, log: 'timeout', reflectGateFacts: { introduced: 0, preexisting: 0, unknown: 0, timedOut: 1 } }
      : { passed: true, log: 'ok' };
    s.reviewDiff = async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'clean', reviewed: true, diffTruncated: false });
    let merged = 0;
    s.mergePr = async () => { merged++; return { merged: true }; };
    const result = await runSelfImplement({ feature: 'llm-resolved timeout-only', autoMerge: true, seams: s });
    expect(result).toMatchObject({ stage: 'pr-opened', gate: { passed: false }, mergeReason: GATE_TIMEOUT_UNMEASURED_MERGE_REASON });
    expect(merged).toBe(0);
  });

  test('post-sync timeout-only regate requires human approval before opening an auto-authorized PR', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => { events.push({ event, data: data as Record<string, unknown> }); }) as typeof debug.log;
    try {
      const s = terminalG2Seams({ mergeStatus: 'merged', gateResults: [true, false] });
      let approvals = 0;
      s.approvePr = async () => { approvals++; return false; };
      s.reviewDiff = async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'clean', reviewed: true, diffTruncated: false });
      let opened = 0;
      s.openPr = async () => { opened++; return { url: 'https://pr/unexpected', number: 99 }; };
      s.gate = async (_cwd, ctx) => {
        expect(events.filter(({ event }) => event === 'merge-decision')).toHaveLength(0);
        return ctx?.mode === 'postsync'
          ? { passed: false, log: 'timeout', reflectGateFacts: { introduced: 0, preexisting: 0, unknown: 0, timedOut: 1 } }
          : { passed: true, log: 'ok' };
      };
      const result = await runSelfImplement({ feature: 'post-sync timeout declined approval', autoMerge: true, seams: s });
      expect(result).toMatchObject({ stage: 'pr-declined', mergeReason: GATE_TIMEOUT_UNMEASURED_MERGE_REASON });
      expect(result.mergeApprovalReceived).toBeUndefined();
      expect(approvals).toBe(1);
      expect(events.filter(({ event }) => event === 'merge-decision')).toHaveLength(1);
      expect(events.find(({ event }) => event === 'merge-decision')?.data).toMatchObject({ decision: 'hitl', reason: GATE_TIMEOUT_UNMEASURED_MERGE_REASON });
      expect(events.find(({ event }) => event === 'post-sync-gate-timeout-only-continued')?.data).toMatchObject({ introduced: 0, unknown: 0, timedOut: 1 });
      expect(opened).toBe(0);
    } finally { (debug as { log: typeof debug.log }).log = original; }
  });

  test('human approval of the initial gate does not approve a later post-sync timeout', async () => {
    const s = terminalG2Seams({ mergeStatus: 'merged', gateResults: [true, false] });
    const approvals: Array<string | undefined> = [];
    let opened = 0;
    s.approvePr = async ({ gateLog }) => {
      approvals.push(gateLog);
      return approvals.length === 1;
    };
    s.openPr = async () => { opened++; return { url: 'https://pr/unexpected', number: 99 }; };
    s.gate = async (_cwd, ctx) => ctx?.mode === 'postsync'
      ? { passed: false, log: 'post-sync timeout', reflectGateFacts: { introduced: 0, preexisting: 0, unknown: 0, timedOut: 1 } }
      : { passed: true, log: 'initial gate passed' };
    const result = await runSelfImplement({ feature: 'initial approval cannot authorize later timeout', seams: s });
    expect(approvals).toEqual(['initial gate passed', expect.stringContaining('post-sync timeout')]);
    expect(approvals[1]).toContain(`post-sync gate timeout-only (introduced=0, unknown=0, timedOut=1, flakyRerun=unmeasured); merge reason: ${GATE_TIMEOUT_UNMEASURED_MERGE_REASON}`);
    expect(result).toMatchObject({ ok: false, stage: 'pr-declined', mergeReason: GATE_TIMEOUT_UNMEASURED_MERGE_REASON, gate: { passed: false } });
    expect(opened).toBe(0);
  });

  test('post-sync introduced regression remains an integration-break interruption even with timeout evidence', async () => {
    const ledger: Array<{ event: string }> = [];
    const s = terminalG2Seams({ mergeStatus: 'merged', gateResults: [true, false] });
    s.writeRunLedger = (entry) => { ledger.push(entry); };
    let call = 0;
    s.gate = async () => call++ === 0
      ? { passed: true, log: 'gate' }
      : { passed: false, log: 'introduced regression', reflectGateFacts: { introduced: 1, preexisting: 0, unknown: 0, timedOut: 1, childResponsibility: 'none' } };
    const result = await runSelfImplement({ feature: 'introduced regate regression', seams: s });
    expect(result).toMatchObject({ ok: false, stage: 'gate-failed', node: 'regate' });
    expect(result.detail).toContain('integration break');
    expect(ledger.filter(({ event }) => event === 'post-sync-gate-timeout-only-continued')).toHaveLength(0);
  });
});

describe('판정 입력 배관 — 생산에서 실제로 닿는가', () => {
  test('사실 0은 재작업, 측정된 unknown·기존 실패는 조기 중단, 책임 근거가 없으면 일반 재작업', () => {
    const zero = { introduced: 0, preexisting: 0, unknown: 0, childResponsibility: 'none' };
    expect(decideGateFailureDisposition(zero)).toBe('rework-facts-unmeasured');
    expect(decideGateFailureDisposition({ ...zero, unknown: 1, unknownReason: 'test-result-unavailable' })).toBe('escalate-child-unrelated');
    expect(decideGateFailureDisposition({ ...zero, preexisting: 1 })).toBe('escalate-child-unrelated');
    expect(decideGateFailureDisposition({ ...zero, unknownReason: 'budget-exceeded' })).toBe('escalate-child-unrelated');
    expect(decideGateFailureDisposition({ introduced: 0, preexisting: 0, unknown: 0 })).toBe('rework');
  });

  test('사실 0인 첫 gate 실패는 로그를 자식에게 전달해 재작업하고 다음 통과 후 리뷰로 간다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = (debug as { log: typeof debug.log }).log;
    const features: string[] = [];
    let gates = 0;
    let reviews = 0;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const result = await runSelfImplement({
        feature: 'F', maxReworkRounds: 1,
        seams: seams({
          features,
          gate: async () => gates++ === 0
            ? { passed: false, log: '[test] FAIL unmeasured', reflectGateFacts: { introduced: 0, preexisting: 0, unknown: 0, childResponsibility: 'none' } }
            : { passed: true, log: '[test] PASS' },
          reviewDiff: async () => { reviews++; return { verdict: 'pass', mustFix: [], shouldFix: [], summary: 'ok', reviewed: true }; },
        }),
      });
      expect(result.stage).toBe('pr-opened');
      expect(gates).toBe(2);
      expect(features).toHaveLength(2);
      expect(features[1]).toContain('[test] FAIL unmeasured');
      expect(reviews).toBeGreaterThan(0);
      expect(events).toContainEqual(expect.objectContaining({
        event: 'gate-failed-facts-unmeasured',
        data: expect.objectContaining({ round: 0, introduced: 0, preexisting: 0, unknown: 0, childResponsibility: 'none' }),
      }));
      expect(events).not.toContainEqual(expect.objectContaining({ event: 'gate-failed-child-unrelated-escalated' }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });
  test('자식 책임 없는 gate 실패는 재작업 없이 환경 결손 사유로 draft PR을 보존하고 즉시 사람에게 올린다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = (debug as { log: typeof debug.log }).log;
    const features: string[] = [];
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const result = await runSelfImplement({
        feature: 'F',
        maxReworkRounds: 2,
        seams: seams({
          features,
          gate: async () => ({
            passed: false,
            log: '[test] FAIL bun test x',
            reflectGateFacts: { introduced: 0, preexisting: 0, unknown: 1, unknownReason: 'module-load-error', childResponsibility: 'none' },
          }),
        }),
      });
      expect(result).toMatchObject({ stage: 'gate-failed', node: 'rework', outcome: 'abandoned', prNumber: 7 });
      expect(result.detail).toContain('environment deficiency is unrelated to the child');
      expect(result.detail).not.toContain('unconvergeable');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }

    expect(features).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      event: 'gate-failed-child-unrelated-escalated',
      data: expect.objectContaining({ round: 0, childResponsibility: 'none', introduced: 0, preexisting: 0, unknown: 1, unknownReason: 'module-load-error' }),
    }));
  });

  test('실패 시험 0건에 같은 미검증 집합이 두 라운드 연속이면 재작업을 멈추고 사람에게 올린다(run-7dd4cce6)', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = (debug as { log: typeof debug.log }).log;
    const features: string[] = [];
    let gates = 0;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const result = await runSelfImplement({
        feature: 'F',
        maxReworkRounds: 4,
        seams: seams({
          features,
          gate: async () => {
            gates++;
            // 순서가 바뀌어도 같은 집합이다.
            const unverified = gates % 2 ? ['src/b.ts', 'src/a.ts'] : ['src/a.ts', 'src/b.ts'];
            return { passed: false, log: '[test] 0 fail · unverified 2', unverified, reflectGateFacts: { introduced: 0, preexisting: 0, unknown: 0, childResponsibility: 'none' } };
          },
        }),
      });
      expect(result).toMatchObject({ stage: 'gate-failed', node: 'rework', outcome: 'abandoned' });
      expect(result.detail).toContain('same 2 unverified file(s)');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(gates).toBe(2);
    expect(features).toHaveLength(2);
    expect(events).toContainEqual(expect.objectContaining({
      event: 'gate-failed-unverified-repeat-escalated',
      data: expect.objectContaining({ round: 1, unverified: ['src/a.ts', 'src/b.ts'], unverifiedCount: 2 }),
    }));
  });

  test('미검증 집합이 바뀌거나 실패 시험이 있으면 반복으로 세지 않는다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = (debug as { log: typeof debug.log }).log;
    let gates = 0;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await runSelfImplement({
        feature: 'F',
        maxReworkRounds: 2,
        seams: seams({
          gate: async () => {
            gates++;
            if (gates === 1) return { passed: false, log: '[test] 0 fail', unverified: ['src/a.ts'], reflectGateFacts: { introduced: 0, preexisting: 0, unknown: 0, childResponsibility: 'none' } };
            if (gates === 2) return { passed: false, log: '[test] 0 fail', unverified: ['src/a.ts', 'src/c.ts'], reflectGateFacts: { introduced: 0, preexisting: 0, unknown: 0, childResponsibility: 'none' } };
            return { passed: false, log: '[test] 1 fail', unverified: ['src/a.ts', 'src/c.ts'], reflectGateFacts: { introduced: 1, preexisting: 0, unknown: 0 } };
          },
        }),
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(gates).toBe(3);
    expect(events).not.toContainEqual(expect.objectContaining({ event: 'gate-failed-unverified-repeat-escalated' }));
  });

  test('baseline 예산 초과는 환경 결손으로 부르지 않고 예산과 범위 파일 수를 원장·종료 사유에 남긴다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = (debug as { log: typeof debug.log }).log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const result = await runSelfImplement({
        feature: 'budget range',
        seams: seams({
          gate: async () => ({
            passed: false,
            log: '[test] FAIL baseline budget exceeded',
            reflectGateFacts: {
              introduced: 0,
              preexisting: 0,
              unknown: 1,
              unknownReason: 'budget-exceeded',
              baselineBudgetMs: 600_000,
              baselineFileCount: 8,
              childResponsibility: 'none',
            },
          }),
        }),
      });
      expect(result.detail).toContain('baseline budget was exhausted before its test range could be measured: 600000ms across 8 file(s): budget-exceeded');
      expect(result.detail).not.toContain('environment deficiency');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }

    expect(events).toContainEqual(expect.objectContaining({
      event: 'gate-failed-child-unrelated-escalated',
      data: expect.objectContaining({
        unknownReason: 'budget-exceeded',
        baselineBudgetMs: 600_000,
        baselineFileCount: 8,
      }),
    }));
  });

  // ⛔ 대조군 — 면책이 아닌 평범한 gate 실패에는 그 문구가 붙지 않는다(무조건 붙이면 무의미하다).
  test('타임아웃뿐인 gate 실패(도입 0 · 미분류 0 · 자식 책임 없음)는 재작업 없이 리뷰로 가고 병합은 hitl 이다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = (debug as { log: typeof debug.log }).log;
    const features: string[] = [];
    let reviewCalls = 0;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const result = await runSelfImplement({
        feature: 'timeout-only unmeasured',
        autoMerge: true,
        maxReworkRounds: 2,
        seams: seams({
          features,
          gate: async () => ({
            passed: false,
            log: 'timeout only',
            reflectGateFacts: { introduced: 0, preexisting: 1, unknown: 0, timedOut: 4, childResponsibility: 'none' },
          }),
          reviewDiff: async () => {
            reviewCalls += 1;
            return { verdict: 'pass', mustFix: [], shouldFix: [], summary: 'clean', reviewed: true, diffTruncated: false };
          },
          mergePr: async () => ({ merged: true }),
        }),
      });
      expect(result).toMatchObject({
        ok: true,
        stage: 'pr-opened',
        node: 'open-pr',
        mergeReason: GATE_TIMEOUT_UNMEASURED_MERGE_REASON,
      });
      expect(result).not.toHaveProperty('merged');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(reviewCalls).toBe(1);
    expect(features).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      event: 'gate-timeout-only-continued-to-review',
      data: expect.objectContaining({ introduced: 0, preexisting: 1, unknown: 0, timedOut: 4, childResponsibility: 'none' }),
    }));
    expect(events).not.toContainEqual(expect.objectContaining({ event: 'gate-failed-child-unrelated-escalated' }));
    expect(events.find((entry) => entry.event === 'merge-decision')?.data).toMatchObject({
      decision: 'hitl',
      reason: GATE_TIMEOUT_UNMEASURED_MERGE_REASON,
    });
  });

  test('재실행 강등만 있는 gate 실패(도입 0 · 미분류 0 · timedOut 0 · flakyRerun 1 · 자식 책임 없음)는 리뷰로 가고 병합은 hitl 이다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = (debug as { log: typeof debug.log }).log;
    const features: string[] = [];
    let reviewCalls = 0;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const result = await runSelfImplement({
        feature: 'flaky-rerun only unmeasured',
        autoMerge: true,
        maxReworkRounds: 2,
        seams: seams({
          features,
          gate: async () => ({
            passed: false,
            log: 'flaky rerun only',
            reflectGateFacts: { introduced: 0, preexisting: 0, unknown: 0, timedOut: 0, flakyRerun: 1, childResponsibility: 'none' },
          }),
          reviewDiff: async () => {
            reviewCalls += 1;
            return { verdict: 'pass', mustFix: [], shouldFix: [], summary: 'clean', reviewed: true, diffTruncated: false };
          },
          mergePr: async () => ({ merged: true }),
        }),
      });
      expect(result).toMatchObject({
        ok: true,
        stage: 'pr-opened',
        node: 'open-pr',
        mergeReason: GATE_TIMEOUT_UNMEASURED_MERGE_REASON,
      });
      expect(result).not.toHaveProperty('merged');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(reviewCalls).toBe(1);
    expect(features).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      event: 'gate-timeout-only-continued-to-review',
      data: expect.objectContaining({ introduced: 0, unknown: 0, timedOut: 0, childResponsibility: 'none' }),
    }));
    expect(events.find((entry) => entry.event === 'merge-decision')?.data).toMatchObject({
      decision: 'hitl',
      reason: GATE_TIMEOUT_UNMEASURED_MERGE_REASON,
    });
  });

  test('타임아웃이 있어도 도입이 1이면 지금처럼 재작업으로 간다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = (debug as { log: typeof debug.log }).log;
    const features: string[] = [];
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const result = await runSelfImplement({
        feature: 'introduced with timeout',
        maxReworkRounds: 2,
        seams: seams({
          features,
          gate: async () => ({
            passed: false,
            log: 'introduced plus timeout',
            reflectGateFacts: { introduced: 1, preexisting: 1, unknown: 0, timedOut: 4, childResponsibility: 'none' },
          }),
        }),
      });
      expect(result).toMatchObject({ stage: 'gate-failed', node: 'rework', outcome: 'abandoned' });
      expect(result.detail).toContain('environment deficiency is unrelated to the child');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(features).toHaveLength(1);
    expect(events).not.toContainEqual(expect.objectContaining({ event: 'gate-timeout-only-continued-to-review' }));
    expect(events).toContainEqual(expect.objectContaining({
      event: 'gate-failed-child-unrelated-escalated',
      data: expect.objectContaining({ introduced: 1, preexisting: 1, unknown: 0, childResponsibility: 'none' }),
    }));
  });

  test('타임아웃뿐인데 자식 책임이 미판정이면 면책으로 접지 않고 재작업으로 간다', async () => {
    const features: string[] = [];
    let calls = 0;
    const s = seams({ features });
    s.gate = async () => ({
      passed: calls++ > 0,
      log: 'timeout unjudged',
      reflectGateFacts: { introduced: 0, preexisting: 1, unknown: 0, timedOut: 4 },
    });
    const result = await runSelfImplement({ feature: 'unjudged timeout', maxReworkRounds: 1, seams: s });
    expect(result.stage).toBe('pr-opened');
    expect(features).toHaveLength(2);
    expect(features[1]).toContain('timeout unjudged');
    expect(features[1]).not.toContain('자식이 수복할 수 없는');
  });

  test('자식 책임이 있는 gate 실패는 기존처럼 재작업을 계속한다', async () => {
    const features: string[] = [];
    let calls = 0;
    const s = seams({ features });
    s.gate = async () => ({
      passed: calls++ > 0,
      log: '[test] FAIL bun test x',
      reflectGateFacts: { introduced: 2, preexisting: 0, unknown: 0 },
    });
    const result = await runSelfImplement({ feature: 'F', maxReworkRounds: 1, seams: s });
    expect(result.stage).toBe('pr-opened');
    expect(features).toHaveLength(2);
    expect(features[1]).not.toContain('자식이 수복할 수 없는');
  });

  // ⛔⭐ OBS-S10 — reviewScopeDiff 가 선언만 되고 생산 번들에 안 얹혀 있어 diff 증거 경로가
  //   오늘 런 9/9 unavailable 이었다. 생산 seam 이 그 키를 실제로 갖는지 본다.
  test('생산 seam 번들이 reviewScopeDiff 및 PR 본문 보존 seam을 실제로 담는다', () => {
    const productionSeams = defaultSeams();
    expect(typeof productionSeams.reviewScopeDiff).toBe('function');
    expect(typeof productionSeams.persistPrBodyArtifact).toBe('function');
  });
});

describe('runSelfImplement — supervisor fills authored UNVERIFIABLE slots', () => {
  test('production orchestration passes gate, review, and round context to the independent goal-slot checker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'supervisor-goal-wiring-'));
    const goalFile = join(root, 'GOAL.txt');
    writeFileSync(goalFile, 'Goal\n\n## 불변식\n- UNVERIFIABLE\n\n## 판정 신호\n- UNVERIFIABLE\n');
    let independentlyChecked = false;
    const s = revSeams({ reviews: [{ verdict: 'pass', reviewed: true }] });
    s.independentlyCheckGoalSlots = async (document) => {
      // ⭐ 기대값이 아니라 **관측값**이 실린다 — 두 절이 서로 다른 것을 말한다.
      independentlyChecked = document.includes('filled-by: supervisor@round-0')
        && document.includes('조건 — ')
        && document.includes('이 라운드에서 관측됨 — fail 0')
        && document.includes('이번 라운드 관측값 — fail 0');
      return independentlyChecked;
    };
    s.gate = async () => ({
      passed: true,
      log: [
        '[test] PASS bun test test/goal-supervisor-fill.test.ts — 5 pass | 0 fail',
        '[gate-baseline] introduced=0, preexisting=0, unknown=0, precondition-unmet=0',
      ].join('\n'),
    });
    await runSelfImplement({ feature: 'F', goalFile, seams: s });
    expect(independentlyChecked).toBe(true);
    expect(readFileSync(goalFile, 'utf8')).toContain('filled-by: supervisor@round-0');
  });
});

describe('runSelfImplement — pre-launch authored clarification escalation', () => {
  test('resolver skip hints name the corrective setting and unattended-proceeding contract for all skip reasons', () => {
    const disabledHint = clarificationResolverSkipHint('disabled');
    const timeoutHint = clarificationResolverSkipHint('timeout-not-configured');
    const unattendedHint = clarificationResolverSkipHint('unattended-proceeds-unanswered');

    expect(disabledHint).toContain('tools.selfImplement.clarificationEscalation.enabled');
    expect(disabledHint).not.toContain('tools.selfImplement.clarificationEscalation.timeoutMs');
    expect(timeoutHint).toContain('tools.selfImplement.clarificationEscalation.timeoutMs');
    expect(unattendedHint).toBe('무인 발사(비-TTY)라 사람 대기를 설치하지 않는다 — LLM 릴레이가 못 답한 되묻기는 미답으로 진행한다 (대표 2026-09-14)');
    expect(new Set([disabledHint, timeoutHint, unattendedHint])).toHaveLength(3);
  });

  // 비TTY harness는 사람 대기 리졸버를 설치하지 않고 기존 비차단 폴백으로 진행한다.
  test('⭐ stdinIsInteractive=false 면 사람 리졸버를 설치하지 않고 미답으로 런을 계속한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clarification-non-tty-'));
    const goalFile = join(root, 'GOAL.txt');
    writeFileSync(goalFile, [
      'Goal', '- Clarification:', '  - id: delivery_scope', '  - header: Delivery',
      '  - question: Which surface?', '  - options:', '    - label: Telegram', '      description: Send there.',
      '    - label: Discord', '      description: Send there.',
      '  - answer: DEFERRED-UNTIL: Which surface?', '',
    ].join('\n'));
    setUserConfigOverlay((config) => ({
      ...config,
      tools: {
        ...config.tools,
        selfImplement: {
          ...config.tools.selfImplement,
          clarificationEscalation: { enabled: true, timeoutMs: 20 },
        },
      },
    }));
    const originalLog = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const progress: Array<{ stage: string; message: string }> = [];
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ event: `${category}:${event}`, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      setAskUserQuestionResolver(null);
      const result = await runSelfImplement({
        feature: 'non-tty clarification', goalFile,
        writeGoalExecutionRecord: () => {},
        seams: seams({
          stdinIsInteractive: () => false,
          onProgress: (event) => { progress.push(event); },
          escalateGoalClarifications: async () => ({
            output: "AskUserQuestion failed: delivery='terminal' requires a HITL resolver, but none is installed in this surface.",
            absenceReason: 'no-delivery-resolver',
          }),
        }),
      });
      expect(result.stage).toBe('pr-opened');
      expect(events).toContainEqual(expect.objectContaining({
        event: 'self-implement:clarification-resolver-skipped',
        data: expect.objectContaining({
          reason: 'unattended-proceeds-unanswered',
          hint: clarificationResolverSkipHint('unattended-proceeds-unanswered'),
        }),
      }));
      expect(events).not.toContainEqual(expect.objectContaining({
        event: 'ask-user-question.dispatch:end',
        data: expect.objectContaining({ surface: 'file' }),
      }));
      expect(getAskUserQuestionResolver()).toBe(null);
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
      setUserConfigOverlay(null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('progress 관측은 typed stage·runId·bounded message을 남기고 양쪽 sink 실패를 독립적으로 흡수한다', async () => {
    const runId = 'progress-observation-run';
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const received: Array<{ stage: string; message: string }> = [];
    const originalLog = debug.log;
    let throwFirstProgressObservation = true;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      if (throwFirstProgressObservation && event === 'start') {
        throwFirstProgressObservation = false;
        throw new Error('observation unavailable');
      }
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await runSelfImplement({
        feature: 'progress observation',
        runId,
        seams: seams({
          onProgress: (event) => {
            received.push(event);
            if (event.stage === 'worktree') throw new Error('surface unavailable');
          },
        }),
      });
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
    }

    expect(received.map(({ stage }) => stage)).toContain('start');
    expect(received.map(({ stage }) => stage)).toContain('worktree');
    expect(events).toContainEqual(expect.objectContaining({
      event: 'worktree',
      data: expect.objectContaining({ runId, message: expect.any(String) }),
    }));
    const stages = events.filter((entry) => ['implementing', 'implemented', 'gating'].includes(entry.event) && 'message' in entry.data);
    expect(stages).toHaveLength(3);
    expect(stages.map(({ event }) => event)).toEqual(['implementing', 'implemented', 'gating']);
    expect(stages.every(({ data }) => data.runId === runId)).toBe(true);
  });

  test('awaiting-clarification progress observation keeps runId and bounds long messages', async () => {
    const runId = 'awaiting-clarification-run';
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const originalLog = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await runSelfImplement({
        feature: 'long progress observation',
        runId,
        seams: seams({
          createWorktree: async ({ branch, base }) => ({
            path: `/wt/${branch}${'x'.repeat(501)}`,
            branch,
            base,
            owner: 'test-owner',
          }),
        }),
      });
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
    }

    const worktree = events.find((entry) => entry.event === 'worktree' && String(entry.data.message).startsWith('격리 worktree 준비됨:'));
    expect(worktree!.data).toEqual(expect.objectContaining({
      runId,
      message: expect.any(String),
    }));
    expect((worktree!.data.message as string).length).toBe(500);
  });

  test('되묻기 없는 런은 기존 진행 순서를 유지하고 clarification 대기를 통지하지 않는다', async () => {
    const stages: string[] = [];
    const result = await runSelfImplement({
      feature: 'no clarification progress',
      seams: seams({ onProgress: ({ stage }) => { stages.push(stage); } }),
    });

    expect(result.stage).toBe('pr-opened');
    expect(stages).toEqual([
      'start', 'worktree', 'implementing', 'implemented',
      'gating', 'gated', 'pr-opening', 'pr-opened',
    ]);
    expect(stages).not.toContain('awaiting-clarification');
  });

  test('disabled resolver emits its existing skipped observation without installing and continues the run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clarification-disabled-'));
    const goalFile = join(root, 'GOAL.txt');
    writeFileSync(goalFile, [
      'Goal', '- Clarification:', '  - id: delivery_scope', '  - header: Delivery',
      '  - question: Which surface?', '  - options:', '    - label: Telegram', '      description: Send there.',
      '  - answer: DEFERRED-UNTIL: Which surface?', '',
    ].join('\n'));
    setUserConfigOverlay((config) => ({
      ...config,
      tools: {
        ...config.tools,
        selfImplement: {
          ...config.tools.selfImplement,
          clarificationEscalation: { enabled: false },
        },
      },
    }));
    const originalLog = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      setAskUserQuestionResolver(null);
      let resolverDuringClarification: unknown = 'unset';
      const result = await runSelfImplement({
        feature: 'disabled clarification observation', goalFile,
        writeGoalExecutionRecord: () => {},
        seams: seams({
          escalateGoalClarifications: async () => {
            resolverDuringClarification = getAskUserQuestionResolver();
            return { output: "AskUserQuestion failed: delivery='telegram' requires a HITL resolver, but none is installed in this surface." };
          },
        }),
      });
      setUserConfigOverlay((config) => ({
        ...config,
        tools: {
          ...config.tools,
          selfImplement: {
            ...config.tools.selfImplement,
            clarificationEscalation: { enabled: true },
          },
        },
      }));
      const timeoutResult = await runSelfImplement({
        feature: 'timeout configuration observation', goalFile,
        writeGoalExecutionRecord: () => {},
        seams: seams({
          escalateGoalClarifications: async () => ({
            output: "AskUserQuestion failed: delivery='telegram' requires a HITL resolver, but none is installed in this surface.",
          }),
        }),
      });
      expect(events.filter((entry) => entry.event === 'clarification-resolver-skipped')).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            reason: 'disabled',
            hint: clarificationResolverSkipHint('disabled'),
          }),
        }),
        expect.objectContaining({
          data: expect.objectContaining({
            reason: 'timeout-not-configured',
            hint: clarificationResolverSkipHint('timeout-not-configured'),
          }),
        }),
      ]);
      expect(resolverDuringClarification).toBe(null);
      expect(result.stage).toBe('pr-opened');
      expect(timeoutResult.stage).toBe('pr-opened');
      expect(getAskUserQuestionResolver()).toBe(null);
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
      setUserConfigOverlay(null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('scopes the opt-in clarification resolver to dispatch, restores only its own resolver, and continues after no response', async () => {
    const root = mkdtempSync(join(tmpdir(), 'supervisor-clarification-resolver-scope-'));
    const goalFile = join(root, 'GOAL.txt');
    writeFileSync(goalFile, [
      'Goal', '- Clarification:', '  - id: delivery_scope', '  - header: Delivery',
      '  - question: Which surface?', '  - options:', '    - label: Telegram', '      description: Send there.',
      '    - label: Discord', '      description: Send there.',
      '  - includeOther: true', '  - answer: DEFERRED-UNTIL: Which surface?', '',
    ].join('\n'));
    const originalResolver = getAskUserQuestionResolver();
    setUserConfigOverlay((config) => ({
      ...config,
      tools: {
        ...config.tools,
        selfImplement: {
          ...config.tools.selfImplement,
          clarificationEscalation: { enabled: true, timeoutMs: 20 },
        },
      },
    }));
    try {
      setAskUserQuestionResolver(null);
      let resolverDuringClarification: unknown;
      let resolverDuringImplement: unknown;
      const noResponse = await runSelfImplement({
        feature: 'resolver cleanup after no response', goalFile,
        writeGoalExecutionRecord: () => {},
        seams: seams({
          escalateGoalClarifications: async () => {
            resolverDuringClarification = getAskUserQuestionResolver();
            return { output: '{"answers":{},"cancelled":true}', result: { answers: {}, cancelled: true } };
          },
          implement: async () => {
            resolverDuringImplement = getAskUserQuestionResolver();
            return { ok: true, summary: 'impl' };
          },
        }),
      });
      expect(noResponse.stage).toBe('pr-opened');
      expect(resolverDuringClarification).not.toBeNull();
      expect(resolverDuringImplement).toBeNull();
      expect(getAskUserQuestionResolver()).toBeNull();

      const replacementResolver = async () => ({ answers: {} });
      await runSelfImplement({
        feature: 'external replacement survives clarification cleanup', goalFile,
        seams: seams({
          escalateGoalClarifications: async () => {
            setAskUserQuestionResolver(replacementResolver);
            return { output: '{}', result: { answers: {} } };
          },
          implement: async () => ({ ok: true, summary: 'impl' }),
        }),
      });
      expect(getAskUserQuestionResolver()).toBe(replacementResolver);

      let existingDuringClarification: unknown;
      await runSelfImplement({
        feature: 'existing resolver remains owned by caller', goalFile,
        seams: seams({
          escalateGoalClarifications: async () => {
            existingDuringClarification = getAskUserQuestionResolver();
            return { output: '{}', result: { answers: {} } };
          },
          implement: async () => ({ ok: true, summary: 'impl' }),
        }),
      });
      expect(existingDuringClarification).toBe(replacementResolver);
      expect(getAskUserQuestionResolver()).toBe(replacementResolver);

      setAskUserQuestionResolver(null);
      let releaseFirst!: () => void;
      const firstPaused = new Promise<void>((resolve) => { releaseFirst = resolve; });
      let firstEntered!: () => void;
      const firstEnteredClarification = new Promise<void>((resolve) => { firstEntered = resolve; });
      const firstRun = runSelfImplement({
        feature: 'first concurrent clarification run', goalFile,
        seams: seams({
          escalateGoalClarifications: async () => {
            firstEntered();
            await firstPaused;
            return { output: '{}', result: { answers: {} } };
          },
          implement: async () => ({ ok: true, summary: 'impl' }),
        }),
      });
      await firstEnteredClarification;
      const firstResolver = getAskUserQuestionResolver();
      expect(firstResolver).not.toBeNull();

      let releaseSecond!: () => void;
      const secondPaused = new Promise<void>((resolve) => { releaseSecond = resolve; });
      let secondEntered!: () => void;
      const secondEnteredClarification = new Promise<void>((resolve) => { secondEntered = resolve; });
      let resolverAfterFirstRelease: unknown;
      const secondRun = runSelfImplement({
        feature: 'second concurrent clarification run', goalFile,
        seams: seams({
          escalateGoalClarifications: async () => {
            secondEntered();
            await secondPaused;
            resolverAfterFirstRelease = getAskUserQuestionResolver();
            return { output: '{}', result: { answers: {} } };
          },
          implement: async () => ({ ok: true, summary: 'impl' }),
        }),
      });
      await secondEnteredClarification;
      releaseFirst();
      await firstRun;
      expect(getAskUserQuestionResolver()).toBe(firstResolver);
      releaseSecond();
      await secondRun;
      expect(resolverAfterFirstRelease).toBe(firstResolver);
      expect(getAskUserQuestionResolver()).toBeNull();
    } finally {
      setUserConfigOverlay(null);
      setAskUserQuestionResolver(originalResolver);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('delivers unresolved document questions before the supervisor starts implementation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'supervisor-clarification-wiring-'));
    const goalFile = join(root, 'GOAL.txt');
    writeFileSync(goalFile, [
      'Goal', '- Clarification:', '  - id: delivery_scope', '  - header: Delivery',
      '  - question: Which surface?', '  - options:', '    - label: Telegram', '      description: Send there.',
      '    - label: Discord', '      description: Send there.', '  - includeOther: true',
      '  - answer: DEFERRED-UNTIL: Which surface?', '',
    ].join('\n'));
    const order: string[] = [];
    try {
      const s = seams({
        implement: async () => { order.push('implement'); return { ok: true, summary: 'impl' }; },
        escalateGoalClarifications: async (request, dispatchContext) => {
          order.push('escalate');
          expect(request).toMatchObject({ delivery: 'discord', questions: [{ id: 'delivery_scope' }] });
          expect(dispatchContext).toEqual({ sessionId: 'elanous-session-parent' });
          return { output: '{}', result: { answers: { delivery_scope: 'Discord' } } };
        },
      });
      await runSelfImplement({
        feature: 'F',
        goalFile,
        clarificationDelivery: 'discord',
        parentSessionId: 'elanous-session-parent',
        seams: s,
      });
      expect(order).toEqual(['escalate', 'implement']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('resolves telegram parent-session origin delivery while retaining input delivery as the fallback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'supervisor-clarification-origin-delivery-'));
    const sessionRoot = join(root, 'sessions');
    const goalFile = join(root, 'GOAL.txt');
    const priorSessionRoot = process.env.ELANOUS_SESSION_ROOT;
    writeFileSync(goalFile, [
      'Goal', '- Clarification:', '  - id: delivery_scope', '  - header: Delivery',
      '  - question: Which surface?', '  - options:', '    - label: Telegram', '      description: Send there.',
      '  - answer: DEFERRED-UNTIL: Which surface?', '',
    ].join('\n'));
    process.env.ELANOUS_SESSION_ROOT = sessionRoot;
    const parent = createSession({}, sessionRoot);
    subscribeSession(parent.id, { surface: 'telegram', endpoint: '1234' }, { now: '2026-08-12T00:00:00.000Z' }, sessionRoot);
    try {
      let dispatchRequest: Record<string, unknown> | undefined;
      let dispatchContext: unknown;
      await runSelfImplement({
        feature: 'origin delivery wiring',
        goalFile,
        clarificationDelivery: 'discord',
        parentSessionId: parent.id,
        seams: seams({
          escalateGoalClarifications: async (request, context) => {
            dispatchRequest = request;
            dispatchContext = context;
            return { output: '{}', result: { answers: { delivery_scope: 'Telegram' } } };
          },
        }),
      });
      expect(dispatchContext).toEqual({ sessionId: parent.id });
      expect(dispatchRequest).toMatchObject({ delivery: 'telegram', questions: [{ id: 'delivery_scope' }] });
    } finally {
      if (priorSessionRoot === undefined) delete process.env.ELANOUS_SESSION_ROOT;
      else process.env.ELANOUS_SESSION_ROOT = priorSessionRoot;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('uses the actual missing-resolver dispatch output to stamp terminal fallback and continue unattended implementation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'supervisor-clarification-terminal-fallback-'));
    const goalFile = join(root, 'GOAL.txt');
    writeFileSync(goalFile, [
      'Goal', '- Clarification:', '  - id: delivery_scope', '  - header: Delivery',
      '  - question: Which surface?', '  - options:', '    - label: Telegram', '      description: Send there.',
      '    - label: Discord', '      description: Send there.', '  - includeOther: true', '  - answer: DEFERRED-UNTIL: Which surface?', '',
    ].join('\n'));
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const originalLog = debug.log;
    const originalResolver = getAskUserQuestionResolver();
    const originalWrite = process.stdout.write;
    const terminal: string[] = [];
    let implemented = false;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    setAskUserQuestionResolver(null);
    (process.stdout.write as unknown as (chunk: string) => boolean) = (chunk) => {
      terminal.push(chunk);
      return true;
    };
    try {
      const result = await runSelfImplement({
        feature: 'F',
        goalFile,
        clarificationDelivery: 'telegram',
        seams: seams({
          implement: async () => { implemented = true; return { ok: true, summary: 'impl' }; },
        }),
      });
      expect(result).toMatchObject({ ok: true, stage: 'pr-opened' });
      expect(implemented).toBe(true);
      expect(terminal.join('')).toContain('Goal clarification fallback (terminal; non-blocking)');
      expect(terminal.join('')).toContain('Which surface?');
      expect(events).toContainEqual(expect.objectContaining({
        event: 'clarification-escalation',
        data: expect.objectContaining({ outcome: 'fallback', delivery: 'telegram', fallbackSurface: 'terminal', unanswered: 1, escalated: 1 }),
      }));
    } finally {
      (process.stdout.write as unknown as (chunk: string) => boolean) = originalWrite as unknown as (chunk: string) => boolean;
      setAskUserQuestionResolver(originalResolver);
      (debug as { log: typeof debug.log }).log = originalLog;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('continues after clarification timeout, notifies the existing progress surface, and records unanswered question identifiers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'supervisor-clarification-timeout-'));
    const goalFile = join(root, 'GOAL.txt');
    writeFileSync(goalFile, [
      'Goal', '- Clarification:', '  - id: delivery_scope', '  - header: Delivery',
      '  - question: Which surface?', '  - options:', '    - label: Telegram',
      '      description: Send there.', '  - answer: DEFERRED-UNTIL: Which surface?',
      '- Clarification:', '  - id: review_scope', '  - header: Review',
      '  - question: Which review?', '  - options:', '    - label: Focused',
      '      description: Review only changed files.', '  - answer: DEFERRED-UNTIL: Which review?', '',
    ].join('\n'));
    const progress: Array<{ stage: string; message: string }> = [];
    const records: GoalExecutionRecord[] = [];
    let implemented = false;
    try {
      const result = await runSelfImplement({
        feature: 'timeout continuation', runId: 'run-clarification-timeout-continuation', goalFile,
        writeGoalExecutionRecord: (_path, record) => { records.push(record); },
        seams: seams({
          onProgress: (event) => { progress.push(event); },
          implement: async () => { implemented = true; return { ok: true, summary: 'impl' }; },
          escalateGoalClarifications: async () => {
            rmSync(goalFile);
            return { output: 'timed out' };
          },
        }),
      });
      expect(result).toMatchObject({ ok: true, stage: 'pr-opened' });
      expect(implemented).toBe(true);
      expect(progress).toContainEqual(expect.objectContaining({
        message: expect.stringContaining('미답 2개 (delivery_scope, review_scope)를 두고 진행'),
      }));
      expect(records).toEqual([expect.objectContaining({
        runId: 'run-clarification-timeout-continuation',
        clarificationTimeoutUnanswered: 2,
        clarificationTimeoutQuestionIds: ['delivery_scope', 'review_scope'],
      })]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('records zero rounds for a terminal failure before implementation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'supervisor-clarification-failure-'));
    const goalFile = join(root, 'GOAL.txt');
    writeFileSync(goalFile, [
      'Goal', '- Clarification:', '  - id: delivery_scope', '  - header: Delivery',
      '  - question: Which surface?', '  - options:', '    - label: Telegram',
      '      description: Send there.', '  - includeOther: true', '  - answer: DEFERRED-UNTIL: Which surface?', '',
    ].join('\n'));
    const records: Array<{ runId: string; stage: string; outcome: string; ok: boolean; rounds?: number }> = [];
    let implemented = false;
    try {
      const result = await runSelfImplement({
        feature: 'F',
        runId: 'run-zero-round-terminal-record',
        goalFile,
        writeGoalExecutionRecord: (_path, record) => { records.push(record); },
        seams: seams({
          implement: async () => { implemented = true; return { ok: true, summary: 'impl' }; },
          escalateGoalClarifications: async () => { throw new Error('HITL delivery unavailable'); },
        }),
      });
      expect(result).toMatchObject({ ok: false, stage: 'aborted', detail: expect.stringContaining('goal clarification escalation failed') });
      expect(implemented).toBe(false);
      expect(records).toEqual([expect.objectContaining({
        runId: 'run-zero-round-terminal-record', stage: 'aborted', outcome: 'abandoned', ok: false, rounds: 0,
      })]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('resolves a relative goal file from the created worktree root before implementation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'supervisor-clarification-root-relative-'));
    const relativeGoalFile = 'docs/goals/GOAL-root-relative.txt';
    const goalFile = join(root, relativeGoalFile);
    mkdirSync(join(root, 'docs/goals'), { recursive: true });
    writeFileSync(goalFile, [
      'Goal', '- Clarification:', '  - id: delivery_scope', '  - header: Delivery',
      '  - question: Which surface?', '  - options:', '    - label: Telegram', '      description: Send there.',
      '    - label: Discord', '      description: Send there.', '  - includeOther: true',
      '  - answer: DEFERRED-UNTIL: Which surface?', '',
    ].join('\n'));
    const order: string[] = [];
    try {
      const result = await runSelfImplement({
        feature: 'F',
        goalFile: relativeGoalFile,
        seams: seams({
          createWorktree: async ({ branch, base }) => ({ path: root, branch, base }),
          implement: async () => { order.push('implement'); return { ok: true, summary: 'impl' }; },
          escalateGoalClarifications: async () => { order.push('escalate'); return { output: '{}', result: { answers: {} } }; },
        }),
      });
      expect(result.stage).toBe('pr-opened');
      expect(order).toEqual(['escalate', 'implement']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('falls back from an unreadable current-directory candidate to a readable worktree-root goal file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'supervisor-clarification-unreadable-fallback-'));
    const fixture = `.orchestrator-goal-read-fallback-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const relativeGoalFile = `${fixture}/GOAL.txt`;
    const cwdCandidate = join(process.cwd(), relativeGoalFile);
    const rootGoalFile = join(root, relativeGoalFile);
    mkdirSync(cwdCandidate, { recursive: true });
    mkdirSync(join(root, fixture), { recursive: true });
    writeFileSync(rootGoalFile, [
      'Goal', '- Clarification:', '  - id: delivery_scope', '  - header: Delivery',
      '  - question: Which surface?', '  - options:', '    - label: Telegram', '      description: Send there.',
      '  - includeOther: true', '  - answer: DEFERRED-UNTIL: Which surface?', '',
    ].join('\n'));
    const order: string[] = [];
    try {
      const result = await runSelfImplement({
        feature: 'F',
        goalFile: relativeGoalFile,
        seams: seams({
          createWorktree: async ({ branch, base }) => ({ path: root, branch, base }),
          escalateGoalClarifications: async () => { order.push('escalate'); return { output: '{}', result: { answers: {} } }; },
          implement: async () => { order.push('implement'); return { ok: true, summary: 'impl' }; },
        }),
      });
      expect(result.stage).toBe('pr-opened');
      expect(order).toEqual(['escalate', 'implement']);
    } finally {
      rmSync(join(process.cwd(), fixture), { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('unavailable goal file aborts before implementation and records the clarification-escalation reason', async () => {
    const root = mkdtempSync(join(tmpdir(), 'supervisor-clarification-missing-goal-'));
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    let implemented = false;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const result = await runSelfImplement({
        feature: 'F',
        goalFile: 'docs/goals/MISSING.txt',
        seams: seams({
          createWorktree: async ({ branch, base }) => ({ path: root, branch, base }),
          implement: async () => { implemented = true; return { ok: true, summary: 'impl' }; },
        }),
      });
      expect(result).toMatchObject({ ok: false, stage: 'aborted', detail: 'goal file unavailable: docs/goals/MISSING.txt' });
      expect(implemented).toBe(false);
      expect(events).toContainEqual(expect.objectContaining({
        event: 'clarification-escalation',
        data: expect.objectContaining({ goalFile: 'docs/goals/MISSING.txt', outcome: 'failed', reason: 'goal-file-unavailable' }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('without a goal file it preserves direct implementation without clarification escalation', async () => {
    const order: string[] = [];
    await runSelfImplement({
      feature: 'F',
      seams: seams({
        implement: async () => { order.push('implement'); return { ok: true, summary: 'impl' }; },
        escalateGoalClarifications: async () => { order.push('escalate'); return { output: '{}', result: { answers: {} } }; },
      }),
    });
    expect(order).toEqual(['implement']);
  });
});

describe('runSelfImplement — --ground round-0 codebase grounding', () => {
  test.each([
    ['omitted', undefined],
    ['explicitly false', false],
  ] as const)('ground %s → grounding seam 없이 disabled observation을 남기고 원 목표를 전달', async (_name, ground) => {
    const features: string[] = [];
    const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
    let groundCalls = 0;
    await runSelfImplement({
      feature: 'original goal', ground, memory: false,
      seams: seams({
        features,
        groundGoal: async () => { groundCalls++; return 'GROUND'; },
        writeRunLedger: (entry) => { ledger.push({ event: entry.event, data: entry.data }); },
      }),
    });
    expect(groundCalls).toBe(0);
    expect(features[0]).toBe('original goal');
    const groundEvents = ledger.filter((entry) => entry.event === 'ground');
    expect(groundEvents).toHaveLength(1);
    expect(groundEvents[0]).toMatchObject({
      event: 'ground',
      data: { injected: false, chars: 0 },
    });
  });

  test('ground ON → 대상 worktree cwd를 넘기고 grounding block을 round-0 objective 앞에 주입하며 기존 payload를 보존', async () => {
    const features: string[] = [];
    const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
    let groundingCwd = '';
    const grounding = '## CODEBASE grounding\n- src/real.ts: realExport';
    await runSelfImplement({
      feature: 'original goal', ground: true, memory: false,
      seams: seams({
        features,
        groundGoal: async (_goal, deps) => { groundingCwd = deps.cwd; return grounding; },
        writeRunLedger: (entry) => { ledger.push({ event: entry.event, data: entry.data }); },
      }),
    });
    expect(groundingCwd).toStartWith('/wt/self-impl/original-goal-');
    expect(features[0]).toBe(`${grounding}\n\noriginal goal`);
    const groundEvents = ledger.filter((entry) => entry.event === 'ground');
    expect(groundEvents).toHaveLength(1);
    expect(groundEvents[0]).toMatchObject({
      event: 'ground',
      data: { injected: true, chars: grounding.length },
    });
  });

  test('grounding seam 오류 → fail-soft으로 원 목표를 계속 구현', async () => {
    const features: string[] = [];
    await runSelfImplement({
      feature: 'original goal', ground: true, memory: false,
      seams: seams({ features, groundGoal: async () => { throw new Error('grounding unavailable'); } }),
    });
    expect(features[0]).toBe('original goal');
  });
});

describe('runSelfImplement — 구조적 정합(«해석된» 기본 브랜치 자동 merge·INCIDENT PR머지↔스택 갭)', () => {
  test('★ se 스택 base(origin/se/) → mergeMain seam 호출 (머지된 PR 반영·LLM 충돌해결)', async () => {
    const merged: string[] = [];
    await runSelfImplement({ feature: 'F', base: 'origin/se/prev-phase', seams: seams({ mergeMain: async (wt: string) => { merged.push(wt); return { status: 'merged' }; } }) });
    expect(merged.length).toBe(1);   // se 스택 base → origin/main merge 호출(#4962 async LLM resolver)
  });

  // ⭐⭐ 재개(resume) 경로의 해석 실패 — pre-PR 과 «같은 결과·같은 어휘»여야 한다.
  //   ⛔ 종전엔 이 자리의 광범위한 `catch {}` 가 예외를 «관측 없이» 삼켰다(리뷰 must-fix).
  //   ⇒ 아래 둘이 「없다」와 「못 읽었다」를 각각 문다. 둘 다 병합기를 «안» 부른다.
  function captureResumeMerge(): { events: Array<{ event: string; data: Record<string, unknown> }>; restore: () => void } {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: (data ?? {}) as Record<string, unknown> });
    }) as typeof debug.log;
    return { events, restore: () => { (debug as { log: typeof debug.log }).log = original; } };
  }

  test('재개 경로 — 기본 브랜치가 «없으면» 병합기를 안 부르고 셋째 결과를 관측한다', async () => {
    const merged: string[] = [];
    const { events, restore } = captureResumeMerge();
    try {
      const s = seams({ mergeMain: async (wt: string) => { merged.push(wt); return { status: 'merged' as const }; } });
      s.defaultBranchRef = () => null;
      await runSelfImplement({ feature: 'F', base: 'origin/se/prev-phase', seams: s });
    } finally { restore(); }
    expect(merged.length).toBe(0);
    const data = events.find((entry) => entry.event === 'resume-merge')?.data;
    expect(data).toMatchObject({ status: 'default-branch-unresolved', mergeTarget: null, defaultBranchResolved: false });
    expect('resolveError' in (data ?? {})).toBe(false);   // 「없다」에는 사유가 «안» 붙는다
  });

  test('재개 경로 — 해석이 «예외»를 던져도 같은 결과이고, 사유가 이름으로 남는다', async () => {
    const merged: string[] = [];
    const { events, restore } = captureResumeMerge();
    try {
      const s = seams({ mergeMain: async (wt: string) => { merged.push(wt); return { status: 'merged' as const }; } });
      s.defaultBranchRef = () => { throw new Error('ref 조회 실패'); };
      await runSelfImplement({ feature: 'F', base: 'origin/se/prev-phase', seams: s });
    } finally { restore(); }
    expect(merged.length).toBe(0);                        // ⛔ 예외가 삼켜져 «조용히» 넘어가지 않는다
    const data = events.find((entry) => entry.event === 'resume-merge')?.data;
    expect(data).toMatchObject({ status: 'default-branch-unresolved', mergeTarget: null, defaultBranchResolved: false });
    expect(String((data as { resolveError?: unknown }).resolveError)).toContain('ref 조회 실패');
  });

  test('★ main/undefined base → mergeMain skip (강제 merge 회귀 방지)', async () => {
    const merged: string[] = [];
    const mm = async (wt: string) => { merged.push(wt); return { status: 'merged' as const }; };
    await runSelfImplement({ feature: 'F', base: 'main', seams: seams({ mergeMain: mm }) });
    await runSelfImplement({ feature: 'F', seams: seams({ mergeMain: mm }) });   // undefined base
    expect(merged.length).toBe(0);   // main/undefined → skip(이미 최신)
  });
});

// ── review-gated merge (2026-07-21) ─────────────────────────────────────────
type ContextBudgetObservation = {
  contextItemCount: number;
  contextShownChars: number;
  contextTotalChars: number;
  contextTruncated: boolean;
  contextFullyIncludedItems: number;
  contextTruncatedItems: number;
  contextOmittedItems: number;
};
type Rev = { verdict: 'pass' | 'warn' | 'fail'; reviewed?: boolean; mustFix?: string[]; shouldFix?: string[]; contextBudget?: ContextBudgetObservation };
function revSeams(opts: {
  gateResults?: boolean[]; reviews?: Rev[]; merged?: boolean;
  features?: string[]; withApprove?: boolean;
}): SelfImplementSeams {
  const gateResults = opts.gateResults ?? [true];
  const reviews = opts.reviews ?? [{ verdict: 'pass', reviewed: true }];
  let gi = 0; let ri = 0;
  const features = opts.features ?? [];
  const s: SelfImplementSeams = {
    stdinIsInteractive: () => false,
    refreshCodexQuotaSignals: async () => ({ accounts: [] }),
    inspectCodexRotation: (() => ({ reason: 'no-candidate', candidateCount: 0, knownAccountCount: 0 })) as SelfImplementSeams['inspectCodexRotation'],
    escalateGoalClarifications: async () => ({ output: '{}', result: { answers: {} } }),
    queryRunChain: () => ({ entries: [] }),
    writeRunLedger: () => {},
    enqueueControlMemo: () => {},
    createWorktree: async ({ branch, base }) => ({ path: `/wt/${branch}`, branch, base, resolvedBase: 'a'.repeat(40), invokedHead: 'a'.repeat(40) }),
    implement: async ({ feature }) => { features.push(feature); return { ok: true, summary: 'impl' }; },
    gate: async () => ({ passed: gateResults[Math.min(gi++, gateResults.length - 1)]!, log: 'gate' }),
    defaultBranchRef: () => 'origin/main',
    reviewDiff: async () => {
      const r = reviews[Math.min(ri++, reviews.length - 1)]!;
      const reviewed = r.reviewed ?? true;
      // ⚠️ 실제 `reviewPullRequest` 는 리뷰가 돌면(reviewed:true) **항상** diff 예산을 함께 낸다
      //   (`pr-reviewer.ts` — reviewed:true 와 diffBudget 이 한 반환에 묶여 있다). 자동 병합 조건이
      //   `diffTruncated === false` 를 요구하므로(#5557 · 잘린 리뷰는 부재 없음의 근거가 될 수 없다),
      //   목이 그 사실을 빠뜨리면 "리뷰는 돌았는데 예산 미보고" 라는 **현실에 없는 상태**를 만든다.
      return {
        verdict: r.verdict,
        mustFix: r.mustFix ?? (r.verdict === 'fail' ? ['정의 누락'] : []),
        shouldFix: r.shouldFix ?? [],
        summary: 'review',
        reviewed,
        ...(reviewed ? { diffTruncated: false, diffShownChars: 100, diffTotalChars: 100, diffOmittedFiles: 0 } : {}),
        ...(r.contextBudget ?? {}),
      };
    },
    openPr: async ({ head, draft }) => { (openPrCalls as { head: string; draft?: boolean }[]).push({ head, draft }); return { url: `https://pr/${head}`, number: 9 }; },
    readPrDiff: async () => '',
    readPrCommitShas: async () => ({ baseCommit: 'base-sha', headCommit: 'checked-head-sha' }),
    mergePr: async () => ({ merged: opts.merged ?? true }),
    judgmentCallLLM: async ({ prompt }) => prompt.match(/BUDGET:\s*(EXTEND|SUFFICIENT|UNCONVERGEABLE)/)?.[1] ?? 'EXTEND',
    decomposeShadowGoals: async () => ({ goals: [], decomposition: { recommendedMaxTasks: 6, actualTaskCount: 0, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'single-no-subtasks' } }),
  };
  if (opts.withApprove !== false) s.approvePr = async () => true;
  return s;
}
let openPrCalls: { head: string; draft?: boolean }[] = [];

describe('runSelfImplement — rework-budget repeated blocking findings', () => {
  test('keeps absent or legacy blocking IDs unknown instead of flattening them to an empty overlap', () => {
    const finding = { id: stableMustFixId('blocker'), item: 'blocker' };
    expect(repeatedBlockingFindingIds([finding], undefined)).toBeUndefined();
    expect(repeatedBlockingFindingIds([finding], [])).toEqual([]);
  });

  test('records a deduplicated partial overlap of consecutive blocking IDs, not should-fix IDs or the current round itself', async () => {
    const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
    const alpha = 'blocking alpha';
    const beta = 'blocking beta';
    const s = revSeams({});
    s.writeRunLedger = (entry) => { ledger.push({ event: entry.event, data: entry.data }); };
    let review = 0;
    s.reviewDiff = async () => {
      review++;
      return review === 1
        ? { verdict: 'fail', mustFix: [alpha, beta], shouldFix: ['shared should-fix'], summary: 'first', reviewed: true, diffTruncated: false, diffShownChars: 1, diffTotalChars: 1, diffOmittedFiles: 0 }
        : review === 2
          ? { verdict: 'fail', mustFix: [beta, beta, 'blocking gamma'], shouldFix: ['shared should-fix'], summary: 'second', reviewed: true, diffTruncated: false, diffShownChars: 1, diffTotalChars: 1, diffOmittedFiles: 0 }
          : { verdict: 'pass', mustFix: [], shouldFix: [], summary: 'done', reviewed: true, diffTruncated: false, diffShownChars: 1, diffTotalChars: 1, diffOmittedFiles: 0 };
    };
    s.diagnose = async () => 'BUDGET: EXTEND\nREASON: continue';
    await runSelfImplement({ feature: 'partial consecutive blocking overlap', maxReworkRounds: 2, seams: s });

    const budgetEvents = ledger.filter(({ event }) => event === 'rework-budget').map(({ data }) => data);
    expect(budgetEvents).toHaveLength(2);
    expect(budgetEvents[0]).toMatchObject({ repeatedBlockingFindingCount: null, repeatedBlockingFindingIds: null });
    expect(budgetEvents[1]).toMatchObject({
      repeatedBlockingFindingCount: 1,
      repeatedBlockingFindingIds: [stableMustFixId(beta)],
      round: 2,
    });
    expect(budgetEvents[1]!.repeatedBlockingFindingIds).not.toContain(stableMustFixId('shared should-fix'));
  });

  test('joins adaptive-cap and repeat-count to rework-budget with the run and goal identity while preserving their payloads and category', async () => {
    const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
    const logs: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const s = revSeams({
      reviews: [
        { verdict: 'fail', mustFix: ['preserve `joinIdentity` evidence'] },
        { verdict: 'pass', mustFix: [] },
      ],
    });
    s.writeRunLedger = (entry) => { ledger.push({ event: entry.event, data: entry.data }); };
    s.diagnose = async () => 'BUDGET: EXTEND\nREASON: continue';
    const originalLog = (debug as { log: typeof debug.log }).log;
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      logs.push({ category, event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await runSelfImplement({
        feature: 'rework observation identity join',
        runId: 'rework-observation-run',
        goalId: 'rework-observation-goal',
        maxReworkRounds: 1,
        seams: s,
      });
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
    }

    const adaptiveCaps = ledger.filter(({ event }) => event === 'adaptive-cap').map(({ data }) => data);
    const repeatCounts = ledger.filter(({ event }) => event === 'repeat-count').map(({ data }) => data);
    const reworkBudgets = ledger.filter(({ event }) => event === 'rework-budget').map(({ data }) => data);
    expect(adaptiveCaps).not.toHaveLength(0);
    expect(repeatCounts).not.toHaveLength(0);
    expect(reworkBudgets).not.toHaveLength(0);
    const adaptiveCap = adaptiveCaps.at(-1)!;
    const repeatCount = repeatCounts.at(-1)!;
    const reworkBudget = reworkBudgets.at(-1)!;
    expect(logs).toContainEqual(expect.objectContaining({
      category: 'self-dev.rework',
      event: 'adaptive-cap',
      data: expect.objectContaining({ runId: 'rework-observation-run', goalId: 'rework-observation-goal' }),
    }));
    expect(logs).toContainEqual(expect.objectContaining({
      category: 'self-dev.rework',
      event: 'repeat-count',
      data: expect.objectContaining({ runId: 'rework-observation-run', goalId: 'rework-observation-goal' }),
    }));

    expect(adaptiveCap).toMatchObject({
      failCountTrend: expect.anything(),
      maxRework: 1,
      reason: expect.any(String),
      repeatSignal: expect.anything(),
      runId: 'rework-observation-run',
      goalId: 'rework-observation-goal',
    });
    expect(repeatCount).toMatchObject({
      round: 0,
      counts: expect.any(Array),
      longestId: expect.any(String),
      longestConsecutiveRounds: 1,
      keySources: expect.any(Array),
      runId: 'rework-observation-run',
      goalId: 'rework-observation-goal',
    });
    expect(reworkBudget).toMatchObject({
      runId: adaptiveCap.runId,
      goalId: adaptiveCap.goalId,
    });
    expect(reworkBudget).toMatchObject({
      runId: repeatCount.runId,
      goalId: repeatCount.goalId,
    });
  });

  test('preserves legacy log options without evaluating their unrelated getters and swallows category getter failures', () => {
    const calls: Array<{ category: string; event: string; data: Record<string, unknown>; opt: unknown }> = [];
    const observe = makeRunObserver('observer-run', 'observer-goal', ((category, event, data, opt) => {
      calls.push({ category, event, data: data as Record<string, unknown>, opt });
    }) as typeof debug.log, () => {});

    observe('without-options', { preserved: true });
    expect(calls).toEqual([{
      category: 'self-implement',
      event: 'without-options',
      data: { preserved: true, runId: 'observer-run', goalId: 'observer-goal' },
      opt: undefined,
    }]);

    const legacyOptions = { level: 'warn' as const };
    observe('legacy-options', { preserved: true }, legacyOptions);
    expect(calls.at(-1)).toMatchObject({ category: 'self-implement', event: 'legacy-options' });
    expect(calls.at(-1)?.opt).toBe(legacyOptions);

    const guardedLegacyOptions = Object.defineProperties({}, {
      level: { get() { throw new Error('legacy level getter evaluated'); } },
      compact: { get() { throw new Error('legacy compact getter evaluated'); } },
    });
    expect(() => observe('guarded-legacy-options', { still: 'continues' }, guardedLegacyOptions)).not.toThrow();
    expect(calls.at(-1)?.opt).toBe(guardedLegacyOptions);

    const categoryOptions = { category: 'self-dev.rework', level: 'warn' as const };
    observe('category-options', { preserved: true }, categoryOptions);
    expect(calls.at(-1)).toMatchObject({ category: 'self-dev.rework', event: 'category-options', opt: { level: 'warn' } });
    expect(calls.at(-1)?.opt).not.toBe(categoryOptions);

    const throwingOptions = Object.defineProperty({}, 'category', {
      get() { throw new Error('option getter failed'); },
    });
    expect(() => observe('throwing-options', { still: 'continues' }, throwingOptions)).not.toThrow();
    expect(calls).toHaveLength(4);
  });

  test('records normalized and cited-symbol recurrence alongside the existing exact blocking overlap, including zero and unknown states', async () => {
    const repeatedLedger: Array<{ event: string; data: Record<string, unknown> }> = [];
    const repeated = revSeams({
      reviews: [
        { verdict: 'fail', mustFix: ['Restore `reviewFindingLedger` coverage 101'] },
        { verdict: 'fail', mustFix: ['Restore `reviewFindingLedger` regression coverage 202'] },
      ],
    });
    repeated.writeRunLedger = (entry) => { repeatedLedger.push({ event: entry.event, data: entry.data }); };
    repeated.diagnose = async () => 'BUDGET: EXTEND\nREASON: continue';
    await runSelfImplement({ feature: 'rework budget recurrence axes', maxReworkRounds: 1, seams: repeated });

    expect(repeatedLedger.find(({ event, data }) => event === 'rework-budget'
      && data.repeatedBlockingFindingCount === 0
      && data.normalizedRepeatedReviewFindingCount === 0
      && data.citedReviewSymbolRepeatCount === 1)?.data).toMatchObject({
      repeatedBlockingFindingCount: 0,
      normalizedRepeatedReviewFindingCount: 0,
      ordinaryRepeatedReviewFindingCount: 0,
      previouslyDismissedRepeatedReviewFindingCount: 0,
      citedReviewSymbolRepeatCount: 1,
      reviewFindingKeyRepeatCount: 1,
    });

    const nonRepeatedLedger: Array<{ event: string; data: Record<string, unknown> }> = [];
    const nonRepeated = revSeams({
      reviews: [
        { verdict: 'fail', mustFix: ['Restore `firstReviewFinding` coverage'] },
        { verdict: 'fail', mustFix: ['Document `secondReviewFinding` output'] },
      ],
    });
    nonRepeated.writeRunLedger = (entry) => { nonRepeatedLedger.push({ event: entry.event, data: entry.data }); };
    nonRepeated.diagnose = async () => 'BUDGET: EXTEND\nREASON: continue';
    await runSelfImplement({ feature: 'rework budget non-recurrence axes', maxReworkRounds: 1, seams: nonRepeated });

    expect(nonRepeatedLedger.find(({ event, data }) => event === 'rework-budget'
      && data.repeatedBlockingFindingCount === 0
      && data.normalizedRepeatedReviewFindingCount === 0
      && data.citedReviewSymbolRepeatCount === 0)?.data).toMatchObject({
      repeatedBlockingFindingCount: 0,
      normalizedRepeatedReviewFindingCount: 0,
      citedReviewSymbolRepeatCount: 0,
      reviewFindingKeyRepeatCount: 0,
    });

    const unavailableLedger: Array<{ event: string; data: Record<string, unknown> }> = [];
    const unavailable = revSeams({ gateResults: [false, true] });
    unavailable.writeRunLedger = (entry) => { unavailableLedger.push({ event: entry.event, data: entry.data }); };
    unavailable.diagnose = async () => 'BUDGET: EXTEND\nREASON: continue';
    await runSelfImplement({ feature: 'rework budget unavailable recurrence axes', maxReworkRounds: 1, seams: unavailable });

    expect(unavailableLedger.find(({ event }) => event === 'rework-budget')!.data).toMatchObject({
      repeatedBlockingFindingCount: null,
      normalizedRepeatedReviewFindingCount: null,
      citedReviewSymbolRepeatCount: null,
      reviewFindingKeyRepeatCount: null,
    });
  });

  test.each([
    ['disjoint blocking findings', ['first blocker'], ['second blocker'], 0, []],
    ['only should-fix overlap', ['first blocker'], ['second blocker'], 0, []],
  ])('records known empty overlap for %s', async (_name, firstMustFix, secondMustFix, expectedCount, expectedIds) => {
    const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
    const s = revSeams({});
    s.writeRunLedger = (entry) => { ledger.push({ event: entry.event, data: entry.data }); };
    let review = 0;
    s.reviewDiff = async () => {
      review++;
      return review === 1
        ? { verdict: 'fail', mustFix: firstMustFix, shouldFix: ['shared should-fix'], summary: 'first', reviewed: true, diffTruncated: false, diffShownChars: 1, diffTotalChars: 1, diffOmittedFiles: 0 }
        : review === 2
          ? { verdict: 'fail', mustFix: secondMustFix, shouldFix: ['shared should-fix'], summary: 'second', reviewed: true, diffTruncated: false, diffShownChars: 1, diffTotalChars: 1, diffOmittedFiles: 0 }
          : { verdict: 'pass', mustFix: [], shouldFix: [], summary: 'done', reviewed: true, diffTruncated: false, diffShownChars: 1, diffTotalChars: 1, diffOmittedFiles: 0 };
    };
    s.diagnose = async () => 'BUDGET: EXTEND\nREASON: continue';
    await runSelfImplement({ feature: _name, maxReworkRounds: 2, seams: s });

    const secondBudget = ledger.filter(({ event }) => event === 'rework-budget').at(1)!.data;
    expect(secondBudget).toMatchObject({ repeatedBlockingFindingCount: expectedCount, repeatedBlockingFindingIds: expectedIds });
  });
});

describe('runSelfImplement — verify-by-breaking merge observation', () => {
  test('구조화 gate 결과를 문자열 파싱 없이 merge-decision에 전달한다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = (debug as { log: typeof debug.log }).log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      if (event === 'merge-decision') events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const s = revSeams({ reviews: [{ verdict: 'pass', reviewed: true }], merged: true });
      s.gate = async () => ({
        passed: true,
        log: 'Verify-by-breaking: skipped; reason=not-used-for-this-observation',
        verifyByBreaking: { ran: true, distinguishes: 2, 'does-not-distinguish': 1, unknown: 3 },
      });
      const result = await runSelfImplement({ feature: 'verify-by-breaking merge observation', autoMerge: true, seams: s });
      expect(result).toMatchObject({ stage: 'merged', merged: true });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }

    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({
      decision: 'auto',
      reason: 'review-clean-armed',
      verifyByBreaking: { ran: true, distinguishes: 2, 'does-not-distinguish': 1, unknown: 3 },
    });
  });

  // ⭐ 통과의 «이유»를 둘로 가른다 — ⛔ 막지는 «않는다»(대표 판단 2026-08-11: ⓐ 문면만 · `JDG-T36`).
  //   📏 근거: merge-decision 300건 전수에서 verifyByBreaking 이 실린 auto 8건 중 ***5건***이
  //     ran=true·distinguishes=0 이었고 그 다섯이 «전부» `review-clean-armed` 였다.
  const mergeReasonCases: Array<[string, { ran: boolean; distinguishes: number; 'does-not-distinguish': number; unknown: number; missingAtBase?: number; skippedReason?: string }, string, boolean]> = [
    ['base에 시험 파일이 없음', { ran: true, distinguishes: 0, 'does-not-distinguish': 0, unknown: 0, missingAtBase: 1 }, 'review-clean-verify-nothing-at-base', true],
    ['돌았는데 아무것도 안 가름(does-not-distinguish)', { ran: true, distinguishes: 0, 'does-not-distinguish': 2, unknown: 0 }, 'review-clean-verify-inconclusive', true],
    ['돌았는데 전부 unknown', { ran: true, distinguishes: 0, 'does-not-distinguish': 0, unknown: 1 }, 'review-clean-verify-inconclusive', true],
    ['하나라도 갈랐다', { ran: true, distinguishes: 1, 'does-not-distinguish': 3, unknown: 2 }, 'review-clean-armed', true],
    // ⛔ ran=false 는 «다른 것»이다 — 자식이 테스트를 안 건드린 경우이고 skippedReason 이 이미 가른다.
    ['아예 안 돌았다(skipped)', { ran: false, distinguishes: 0, 'does-not-distinguish': 0, unknown: 0, skippedReason: 'no-edited-tests' }, 'review-clean-armed', true],
  ];

  test.each(mergeReasonCases)('%s → reason 이 갈리고 병합 자체는 그대로다', async (_label, verifyByBreaking, expectedReason, expectedMerged) => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = (debug as { log: typeof debug.log }).log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      if (event === 'merge-decision') events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const s = revSeams({ reviews: [{ verdict: 'pass', reviewed: true }], merged: true });
      s.gate = async () => ({ passed: true, log: 'gate ok', verifyByBreaking });
      const result = await runSelfImplement({ feature: 'merge reason split', autoMerge: true, seams: s });
      // ⛔ 핵심 불변식: 이 변경은 «막지 않는다». 네 경우 모두 병합이 그대로 일어난다.
      expect(result).toMatchObject({ stage: 'merged', merged: expectedMerged });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({ decision: 'auto', reason: expectedReason });
  });

  test('두 이유가 서로 다른 값이다 — 모집단이 0이 아님을 같이 단언한다', async () => {
    const seen: string[] = [];
    const original = (debug as { log: typeof debug.log }).log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      if (event === 'merge-decision') seen.push(String((data as Record<string, unknown>).reason));
    }) as typeof debug.log;
    try {
      for (const verifyByBreaking of [
        { ran: true, distinguishes: 0, 'does-not-distinguish': 1, unknown: 0 },
        { ran: true, distinguishes: 1, 'does-not-distinguish': 0, unknown: 0 },
      ]) {
        const s = revSeams({ reviews: [{ verdict: 'pass', reviewed: true }], merged: true });
        s.gate = async () => ({ passed: true, log: 'gate ok', verifyByBreaking });
        await runSelfImplement({ feature: 'merge reason contrast', autoMerge: true, seams: s });
      }
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(seen).toHaveLength(2);          // ⛔ 모집단이 0이면 아래 단언이 공허하게 참이 된다
    expect(seen[0]).not.toBe(seen[1]);
  });
});

describe('runSelfImplement — reviewer context budget merge observation', () => {
  const cases: Array<[string, ContextBudgetObservation | undefined]> = [
    ['truncated', { contextItemCount: 1, contextShownChars: 12_000, contextTotalChars: 12_010, contextTruncated: true, contextFullyIncludedItems: 0, contextTruncatedItems: 1, contextOmittedItems: 0 }],
    ['untruncated', { contextItemCount: 1, contextShownChars: 13, contextTotalChars: 13, contextTruncated: false, contextFullyIncludedItems: 1, contextTruncatedItems: 0, contextOmittedItems: 0 }],
    ['absent', undefined],
  ];

  test.each(cases)('%s context is recorded without changing automatic merge', async (_label, contextBudget) => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = (debug as { log: typeof debug.log }).log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      if (event === 'merge-decision') events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const result = await runSelfImplement({
        feature: 'context budget observation',
        autoMerge: true,
        seams: revSeams({ reviews: [{ verdict: 'pass', reviewed: true, contextBudget }], merged: true }),
      });
      expect(result).toMatchObject({ stage: 'merged', merged: true });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }

    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({ verdict: 'pass', decision: 'auto', reason: 'review-clean-armed' });
    if (contextBudget) expect(events[0]!.data).toMatchObject(contextBudget);
    else expect(Object.keys(events[0]!.data).some((key) => key.startsWith('context'))).toBe(false);
  });
});

// ── ⭐ 사전승인(autoOpenPr)이 병합 게이트를 우회하지 않는다 (리뷰 #5463) ──
// `tools.selfImplement.autoOpenPr` 는 **PR 개설 승인만** 앞당긴다. 오케스트레이터
// 수준에서 보면 그건 `approvePr → true` 와 동치다 — 그 상태로도 `autoMerge` 없이는
// 절대 병합되지 않아야 한다(개설과 병합은 다른 게이트).
describe('runSelfImplement — 사전승인은 개설까지만(병합 무우회)', () => {
  test('approvePr=true(사전승인 등가) + autoMerge 미지정 → PR 만 열리고 병합 안 함', async () => {
    openPrCalls = [];
    let mergeCalls = 0;
    const s = revSeams({ reviews: [{ verdict: 'pass', reviewed: true }], merged: true });
    s.mergePr = async () => { mergeCalls++; return { merged: true }; };
    const r = await runSelfImplement({ feature: 'F', seams: s });   // autoMerge 없음
    expect(openPrCalls).toHaveLength(1);       // 개설은 된다(사전승인)
    expect(mergeCalls).toBe(0);                // 병합은 안 된다
    expect(r.merged).not.toBe(true);
    expect(r.stage).not.toBe('merged');
  });

  test('사전승인 + autoMerge 라도 리뷰가 clean 아니면 병합 안 함', async () => {
    openPrCalls = [];
    let mergeCalls = 0;
    const s = revSeams({ reviews: [{ verdict: 'fail', reviewed: true }], merged: true });
    s.mergePr = async () => { mergeCalls++; return { merged: true }; };
    const r = await runSelfImplement({ feature: 'F', autoMerge: true, maxReworkRounds: 0, seams: s });
    expect(mergeCalls).toBe(0);
    expect(r.merged).not.toBe(true);
  });
});

describe('runSelfImplement — lineage supersede after auto-merge', () => {
  test('closes the earlier same-askFile draft once, with the merged PR number in the comment', async () => {
    const goalFile = join(mkdtempSync(join(tmpdir(), 'lineage-supersede-')), 'GOAL.md');
    writeFileSync(goalFile, '- GoalId: 0123456789abcdef\n- GoalType: implement\n- AskFile: docs/goals/ASK-a.md\n\n');
    const closes: Array<{ number: number; comment: string }> = [];
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const s = revSeams({ reviews: [{ verdict: 'pass', reviewed: true }], merged: true });
    s.openPr = async ({ head }) => ({ url: `https://pr/${head}`, number: 300 });
    const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
    s.writeRunLedger = (entry) => { ledger.push({ event: entry.event, data: entry.data }); };
    s.lineageSupersede = {
      listOpenDrafts: () => [{ number: 100, runId: 'run-older', openedAt: '2020-01-01T00:00:00.000Z' }],
      readRunLedger: () => [{ timestamp: '2020-01-01T00:00:00.000Z', runId: 'run-older', event: 'start', data: { askFile: 'docs/goals/ASK-a.md' } }],
      closeDraft: (input) => { closes.push(input); },
    };
    const original = (debug as { log: typeof debug.log }).log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const result = await runSelfImplement({
        feature: 'lineage supersede',
        goalFile,
        autoMerge: true,
        writeGoalExecutionRecord: () => {},
        seams: s,
      });
      expect(result.stage).toBe('merged');
      expect(result.merged).toBe(true);
      expect(result.prNumber).toBe(300);
      expect(closes).toHaveLength(1);
      expect(closes[0]!.number).toBe(100);
      expect(closes[0]!.comment).toContain('#300');
      expect(closes[0]!.comment).toContain('docs/goals/ASK-a.md');
      expect(closes[0]!.comment).toContain('대체됨: 같은 계보');
      const observed = events.filter((entry) => entry.event === 'lineage-supersede');
      expect(observed).toHaveLength(1);
      expect(observed[0]!.data.closed).toEqual([100]);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      rmSync(dirname(goalFile), { recursive: true, force: true });
    }
    expect(ledger.some((entry) => entry.event === 'pr-opened' && entry.data.number === 300)).toBe(true);
  });

  test('does not close drafts when auto-merge is not armed', async () => {
    const closes: number[] = [];
    const s = revSeams({ reviews: [{ verdict: 'pass', reviewed: true }] });
    s.lineageSupersede = {
      listOpenDrafts: () => [{ number: 100, runId: 'run-older', openedAt: '2020-01-01T00:00:00.000Z' }],
      readRunLedger: () => [{ timestamp: '2020-01-01T00:00:00.000Z', runId: 'run-older', event: 'start', data: { askFile: 'docs/goals/ASK-a.md' } }],
      closeDraft: ({ number }) => { closes.push(number); },
    };
    const result = await runSelfImplement({ feature: 'not auto merge', seams: s });
    expect(result.stage).toBe('pr-opened');
    expect(closes).toEqual([]);
  });

  test('a close failure stays observation-only and the merge result stays merged', async () => {
    const goalFile = join(mkdtempSync(join(tmpdir(), 'lineage-supersede-fail-')), 'GOAL.md');
    writeFileSync(goalFile, '- GoalId: 0123456789abcdef\n- GoalType: implement\n- AskFile: docs/goals/ASK-a.md\n\n');
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const s = revSeams({ reviews: [{ verdict: 'pass', reviewed: true }], merged: true });
    s.lineageSupersede = {
      listOpenDrafts: () => [{ number: 100, runId: 'run-older', openedAt: '2020-01-01T00:00:00.000Z' }],
      readRunLedger: () => [{ timestamp: '2020-01-01T00:00:00.000Z', runId: 'run-older', event: 'start', data: { askFile: 'docs/goals/ASK-a.md' } }],
      closeDraft: () => { throw new Error('gh down'); },
    };
    const original = (debug as { log: typeof debug.log }).log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const result = await runSelfImplement({
        feature: 'lineage close fails',
        goalFile,
        autoMerge: true,
        writeGoalExecutionRecord: () => {},
        seams: s,
      });
      expect(result.stage).toBe('merged');
      expect(result.ok).toBe(true);
      const observed = events.filter((entry) => entry.event === 'lineage-supersede');
      expect(observed).toHaveLength(1);
      expect(observed[0]!.data.ok).toBe(false);
      expect(observed[0]!.data.closed).toEqual([]);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      rmSync(dirname(goalFile), { recursive: true, force: true });
    }
  });
});

describe('runSelfImplement — review-gated merge', () => {
  test('리뷰 clean + --auto-merge → merged(자동 병합)', async () => {
    openPrCalls = [];
    const r = await runSelfImplement({ feature: 'F', autoMerge: true, seams: revSeams({ reviews: [{ verdict: 'pass', reviewed: true }], merged: true }) });
    expect(r.stage).toBe('merged');
    expect(r.merged).toBe(true);
    expect(openPrCalls[0]!.draft).toBe(false);   // auto-merge=non-draft
  });

  test('리뷰 must-fix → rework → clean → merged', async () => {
    const features: string[] = [];
    const r = await runSelfImplement({
      feature: 'F', autoMerge: true, maxReworkRounds: 2,
      seams: revSeams({ reviews: [{ verdict: 'fail', mustFix: ['refFacts 미정의'] }, { verdict: 'pass', reviewed: true }], features }),
    });
    expect(r.stage).toBe('merged');
    expect(features.length).toBe(2);                    // rework 1회
    expect(features[1]).toContain('리뷰 must-fix');      // 리뷰 지적 재주입
    expect(features[1]).toContain('refFacts');
  });

  test('리뷰 must-fix 재시도는 같은 라운드의 승격 대신 base 모델을 다시 사용한다', async () => {
    const tiers: Array<string | undefined> = [];
    const s = revSeams({ reviews: [{ verdict: 'fail', mustFix: ['보완 필요'] }, { verdict: 'pass', reviewed: true }] });
    s.implement = async ({ escalateTier }) => {
      tiers.push(escalateTier);
      return { ok: true, summary: 'impl' };
    };

    await runSelfImplement({ feature: 'review retry tier', maxReworkRounds: 2, seams: s });

    expect(tiers).toEqual([undefined, undefined]);
  });

  test('게이트 실패 재시도는 같은 라운드의 기존 sol 승격을 유지한다', async () => {
    const tiers: Array<string | undefined> = [];
    const s = seams({ gateResults: [false, true] });
    s.implement = async ({ escalateTier }) => {
      tiers.push(escalateTier);
      return { ok: true, summary: 'impl' };
    };

    await runSelfImplement({ feature: 'gate retry tier', maxReworkRounds: 2, seams: s });

    expect(tiers).toEqual([undefined, 'sol']);
  });

  test('리뷰 must-fix rework은 게이트가 이미 구별 못 한 파일과 보강 행동을 자식에게 준다', async () => {
    const features: string[] = [];
    const s = revSeams({ reviews: [{ verdict: 'fail', mustFix: ['경계 사례를 고쳐라'] }, { verdict: 'pass', reviewed: true }], features });
    s.gate = async () => ({
      passed: true,
      log: 'gate ok',
      verifyByBreaking: {
        ran: true, distinguishes: 1, 'does-not-distinguish': 2, unknown: 0,
        files: [
          { file: 'src/example.test.ts', classification: 'does-not-distinguish' },
          { file: 'test/example-evidence.test.ts', classification: 'does-not-distinguish' },
          { file: 'test/distinguishes.test.ts', classification: 'distinguishes' },
        ],
      },
    });

    await runSelfImplement({ feature: 'F', maxReworkRounds: 2, seams: s });

    expect(features[1]).toContain('구별하지 못했다');
    expect(features[1]).toContain('src/example.test.ts, test/example-evidence.test.ts');
    expect(features[1]).toContain('실패하고 수정 후에는 통과하도록 테스트 또는 증거를 보강하라');
  });

  test.each([
    ['판정 미실행', { ran: false, distinguishes: 0, 'does-not-distinguish': 0, unknown: 0, skippedReason: 'no-edited-tests' }],
    ['구별 못 한 파일 없음', { ran: true, distinguishes: 2, 'does-not-distinguish': 0, unknown: 0, files: [{ file: 'test/distinguishes.test.ts', classification: 'distinguishes' as const }] }],
  ])('리뷰 must-fix rework은 %s이면 기존 글을 늘리지 않는다', async (_label, verifyByBreaking) => {
    const features: string[] = [];
    const s = revSeams({ reviews: [{ verdict: 'fail', mustFix: ['경계 사례를 고쳐라'] }, { verdict: 'pass', reviewed: true }], features });
    s.gate = async () => ({ passed: true, log: 'gate ok', verifyByBreaking });

    await runSelfImplement({ feature: 'F', maxReworkRounds: 2, seams: s });

    expect(features[1]).toContain('[리뷰 must-fix — 반드시 반영]\n- 경계 사례를 고쳐라');
    expect(features[1]).not.toContain('[verify-by-breaking]');
  });

  // ⭐ 통합 회귀(리뷰 should-fix) — 판정기·git reader·관측 wiring 을 **따로** 검증하면
  //    "실제 worktree 의 상태가 분류를 좌우한다" 는 계약이 어디서도 안 잡힌다.
  //    ⇒ 실제 git 트리를 만들어 dirty/clean 두 경우를 `observeRunOutcome` 로 통과시킨다.
  test('실제 worktree 의 porcelain 이 abandoned 분류를 좌우한다 (dirty=구현결손 · clean=보고결손)', () => {
    const root = mkdtempSync(join(tmpdir(), 'abandoned-cls-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: root });
      spawnSync('git', ['config', 'user.email', 't@e.st'], { cwd: root });
      spawnSync('git', ['config', 'user.name', 'test'], { cwd: root });
      writeFileSync(join(root, 'a.txt'), 'seed\n');
      spawnSync('git', ['add', '-A'], { cwd: root });
      spawnSync('git', ['commit', '-qm', 'seed'], { cwd: root });

      const seen: Array<{ event: string; data: Record<string, unknown> }> = [];
      const ledgerEntries: Array<{ event: string }> = [];
      const observe = makeRunObserver('run-integration', ((_c, event, data) => {
        seen.push({ event, data: data as Record<string, unknown> });
      }) as typeof debug.log, undefined, (entry) => ledgerEntries.push(entry));

      // clean → 보고 결손
      observeRunOutcome(observe, { node: 'rework', stage: 'review-blocked', outcome: 'abandoned', worktreePath: root, review: undefined, completionDisposition: undefined, supervisorVerdict: undefined, mergeApprovalReceived: undefined, abandonedClassification: undefined, mergeReason: undefined });
      expect(seen.filter((e) => e.event === 'abandoned-classification').at(-1)?.data)
        .toMatchObject({ classification: 'report-deficit', worktreeClean: true });

      // dirty → 구현 결손
      writeFileSync(join(root, 'b.txt'), 'uncommitted\n');
      observeRunOutcome(observe, { node: 'rework', stage: 'review-blocked', outcome: 'abandoned', worktreePath: root, review: undefined, completionDisposition: undefined, supervisorVerdict: undefined, mergeApprovalReceived: undefined, abandonedClassification: undefined, mergeReason: undefined });
      expect(seen.filter((e) => e.event === 'abandoned-classification').at(-1)?.data)
        .toMatchObject({ classification: 'implementation-deficit', worktreeClean: false });

      observeRunOutcome(observe, { node: 'main-sync', stage: 'timed-out', outcome: 'abandoned', worktreePath: root, review: undefined, completionDisposition: undefined, supervisorVerdict: undefined, mergeApprovalReceived: true, abandonedClassification: undefined, mergeReason: undefined });
      expect(seen.filter((e) => e.event === 'abandoned-classification').at(-1)?.data)
        .toMatchObject({ classification: 'merge-approved-abandoned', mergeApprovalReceived: true });

      observeRunOutcome(observe, { node: 'open-pr', stage: 'pr-declined', outcome: 'abandoned', worktreePath: root, review: undefined, completionDisposition: undefined, supervisorVerdict: undefined, mergeApprovalReceived: undefined, abandonedClassification: undefined, mergeReason: undefined });
      expect(seen.filter((e) => e.event === 'abandoned-classification').at(-1)?.data)
        .toMatchObject({ classification: 'pr-declined', worktreeClean: false, mustFixReported: false });
      expect(ledgerEntries.filter((entry) => entry.event === 'run-status')).toEqual([
        expect.objectContaining({ runId: 'run-integration', data: expect.objectContaining({ runStatus: 'failed', failureKind: 'review' }) }),
        expect.objectContaining({ runId: 'run-integration', data: expect.objectContaining({ runStatus: 'failed', failureKind: 'review' }) }),
        expect.objectContaining({ runId: 'run-integration', data: expect.objectContaining({ runStatus: 'failed', failureKind: 'timed-out' }) }),
        expect.objectContaining({ runId: 'run-integration', data: expect.objectContaining({ runStatus: 'cancelled' }) }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ⛔ 원본 회귀 복원 — 자율 런이 이 테스트를 진단기 시나리오로 **교체**했다(리뷰 should-fix).
  //    새 초점 테스트는 아래에 그대로 두고, 원래 경로(rework 예산 소진)의 보장을 되살린다.
  test('review-budget follow-up persists actual findings and PR coordinates in the run ledger', async () => {
    const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
    const s = revSeams({ reviews: [
      { verdict: 'fail', mustFix: ['first follow-up', 'second follow-up'] },
      { verdict: 'fail', mustFix: ['first follow-up', 'second follow-up'] },
    ] });
    s.openPr = async () => ({ url: 'https://pr/accepted', number: 88 });
    s.writeRunLedger = (entry) => { ledger.push({ event: entry.event, data: entry.data }); };

    await runSelfImplement({ feature: 'F', autoMerge: true, maxReworkRounds: 1, seams: s });

    expect(ledger.find((entry) => entry.event === 'run-status')?.data).toMatchObject({
      mergeReason: 'review-budget-follow-up-required',
      followUpMustFix: ['first follow-up', 'second follow-up'],
      followUpMustFixCount: 2,
      prNumber: 88,
      prUrl: 'https://pr/accepted',
    });
  });

  test('review-budget follow-up does not invent absent findings or PR coordinates', () => {
    const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
    const observe = makeRunObserver('review-budget-absent', (() => {}) as typeof debug.log, undefined, (entry) => ledger.push({ event: entry.event, data: entry.data }));

    observeRunOutcome(observe, {
      node: 'open-pr', stage: 'pr-opened', outcome: 'budget-exhausted', worktreePath: undefined,
      review: undefined, completionDisposition: undefined, supervisorVerdict: undefined,
      mergeApprovalReceived: undefined, abandonedClassification: undefined, mergeReason: 'review-budget-follow-up-required',
      followUpMustFix: [], followUpMustFixCount: 0,
    });

    const data = ledger.find((entry) => entry.event === 'run-status')!.data;
    expect(data).toMatchObject({ followUpMustFix: [], followUpMustFixCount: 0 });
    expect(data).not.toHaveProperty('prNumber');
    expect(data).not.toHaveProperty('prUrl');
  });

  test('non-follow-up terminal status preserves the existing ledger shape without follow-up fields or PR coordinates', () => {
    const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
    const observe = makeRunObserver('ordinary-terminal', (() => {}) as typeof debug.log, undefined, (entry) => ledger.push({ event: entry.event, data: entry.data }));

    observeRunOutcome(observe, {
      node: 'open-pr', stage: 'pr-opened', outcome: 'completed', worktreePath: undefined,
      review: undefined, completionDisposition: undefined, supervisorVerdict: undefined,
      mergeApprovalReceived: undefined, abandonedClassification: undefined, mergeReason: 'review-must-fix',
      followUpMustFix: ['must remain non-ledger data'], followUpMustFixCount: 1,
      prNumber: 89, prUrl: 'https://pr/ordinary',
    });

    const data = ledger.find((entry) => entry.event === 'run-status')!.data;
    expect(data).toMatchObject({ mergeReason: 'review-must-fix', runStatus: 'completed' });
    expect(data).not.toHaveProperty('followUpMustFix');
    expect(data).not.toHaveProperty('followUpMustFixCount');
    expect(data).not.toHaveProperty('prNumber');
    expect(data).not.toHaveProperty('prUrl');
  });

  test('gate-passing review-budget exhaustion opens a non-draft PR and names every follow-up must-fix', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      let draft: boolean | undefined;
      const s = revSeams({ reviews: [
        { verdict: 'fail', mustFix: ['first follow-up', 'second follow-up'] },
        { verdict: 'fail', mustFix: ['first follow-up', 'second follow-up'] },
      ] });
      s.openPr = async (input) => { draft = input.draft; return { url: 'https://pr/accepted', number: 88 }; };
      const r = await runSelfImplement({ feature: 'F', autoMerge: true, maxReworkRounds: 1, seams: s });
      expect(r).toMatchObject({
        ok: true,
        stage: 'pr-opened',
        outcome: 'budget-exhausted',
        mergeReason: 'review-budget-follow-up-required',
        followUpMustFixCount: 2,
        followUpMustFix: ['first follow-up', 'second follow-up'],
        prNumber: 88,
      });
      expect(draft).toBe(false);
      expect(events).toContainEqual(expect.objectContaining({
        event: 'review-budget-acceptance',
        data: expect.objectContaining({ action: 'accepted', gateMeasured: true, unresolvedMustFixCount: 2, unresolvedMustFix: ['first follow-up', 'second follow-up'], autoMerge: false }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('review failure with no named must-fix retains the existing normal PR path', async () => {
    let draft: boolean | undefined;
    const s = revSeams({ reviews: [
      { verdict: 'fail', mustFix: [] },
      { verdict: 'fail', mustFix: [] },
    ] });
    s.openPr = async (input) => { draft = input.draft; return { url: 'https://pr/blocked', number: 89 }; };
    const r = await runSelfImplement({ feature: 'F', autoMerge: true, maxReworkRounds: 1, seams: s });
    expect(r).toMatchObject({ ok: true, stage: 'pr-opened', outcome: 'completed', mergeReason: 'review-must-fix', prNumber: 89 });
    expect(draft).toBe(true);
  });

  test('CONTRACT-CONFLICT 뒤 supervisor-abandoned이 되면 실제 종결 관측은 must-fix보다 충돌 분류를 우선한다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = (debug as { log: typeof debug.log }).log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const s = revSeams({ reviews: [
        { verdict: 'fail', mustFix: ['same blocking finding'] },
        { verdict: 'fail', mustFix: ['same blocking finding'] },
        { verdict: 'fail', mustFix: ['same blocking finding'] },
        { verdict: 'fail', mustFix: ['same blocking finding'] },
      ] });
      let diagnoseCalls = 0;
      s.diagnose = async () => ++diagnoseCalls === 1
        ? 'BUDGET: CONTRACT-CONFLICT\nREASON: acceptance criterion conflicts with the review'
        : 'BUDGET: UNCONVERGEABLE\nREASON: actual structured finding remains';
      s.judgmentCallLLM = async () => 'UNCONVERGEABLE';
      let shadowObservation: { goalId?: string | null; runId?: string | null } | undefined;
      s.decomposeShadowGoals = async (_feature, options) => {
        shadowObservation = options?.observation && {
          goalId: options.observation.goalId,
          runId: options.observation.runId,
        };
        return {
        goals: [
          { id: 'one', feature: 'first independent goal' },
          { id: 'two', feature: 'second independent goal' },
        ],
        decomposition: { recommendedMaxTasks: 6, actualTaskCount: 2, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'decomposed' },
        };
      };
      const r = await runSelfImplement({ feature: 'F', goalId: 'goal-shadow', runId: 'run-shadow', autoMerge: true, maxReworkRounds: 5, reworkBudgetShadowStop: false, seams: s });
      expect(shadowObservation).toEqual({ goalId: 'goal-shadow', runId: 'run-shadow' });
      expect(r).toMatchObject({
        stage: 'review-blocked',
        outcome: 'abandoned',
        supervisorVerdict: 'CONTRACT-CONFLICT',
        goalCauseObserved: true,
      });
      expect(events).toContainEqual(expect.objectContaining({
        event: 'abandoned-classification',
        data: expect.objectContaining({
          classification: 'contract-conflict',
          worktreeClean: undefined,
          supervisorVerdict: 'CONTRACT-CONFLICT',
          mustFixReported: true,
        }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('명시적 CONTRACT-CONFLICT는 must-fix가 있어도 실제 abandoned 관측을 contract-conflict로 분류한다', () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const ledgerEntries: Array<{ event: string }> = [];
    const observe = makeRunObserver('contract-conflict', ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log, undefined, (entry) => ledgerEntries.push(entry));

    observeRunOutcome(observe, {
      node: 'rework',
      stage: 'review-blocked',
      outcome: 'abandoned',
      worktreePath: undefined,
      completionDisposition: undefined,
      supervisorVerdict: 'CONTRACT-CONFLICT',
      goalCauseObserved: true,
      mergeApprovalReceived: undefined,
      abandonedClassification: undefined,
      mergeReason: undefined,
      review: {
        verdict: 'fail',
        mustFix: ['review demand'],
        shouldFix: [],
        summary: 'review demand conflicts with the goal',
        reviewed: true,
      },
    });

    expect(events).toContainEqual(expect.objectContaining({
      event: 'abandoned-classification',
      data: expect.objectContaining({
        classification: 'contract-conflict',
        supervisorVerdict: 'CONTRACT-CONFLICT',
        goalCauseObserved: true,
        mustFixReported: true,
      }),
    }));
    expect(ledgerEntries).toContainEqual(expect.objectContaining({
      event: 'run-status',
      runId: 'contract-conflict',
      data: expect.objectContaining({ runStatus: 'failed', failureKind: 'review' }),
    }));
  });

  // ⛔⭐⭐⭐ **provider 게이트 — 순수 판정으로 «결정론적으로» 문다**(3R should-fix).
  //   ⚠️ 초판은 통합 테스트였는데 «이 환경의 기본 provider 가 codex» 라 게이트를 지워도 통과했다.
  //     ⇒ 그 자체가 `F18`(환경이 한쪽 분기를 영영 안 실행시킨다)이라 순수 함수로 뽑아 다시 짰다.
  test('quotaSignalAppliesTo — codex 가 아니면 신호가 있어도 «안 쓴다»', () => {
    expect(quotaSignalAppliesTo('openai-codex', true)).toBe(true);
    expect(quotaSignalAppliesTo('anthropic', true)).toBeUndefined();   // ⛔ 오분류 회귀 방어
    expect(quotaSignalAppliesTo('grok', true)).toBeUndefined();
    expect(quotaSignalAppliesTo(undefined, true)).toBeUndefined();      // 모르면 안 쓴다
    expect(quotaSignalAppliesTo('openai-codex', undefined)).toBeUndefined();
  });

  test('assessQuotaExhaustion keeps a single below-threshold Codex account available even without rotation candidates', () => {
    const snapshot = { reason: 'no-candidate', candidateCount: 0, currentUsedPercent: 40, thresholdPercent: 95 };
    expect(assessQuotaExhaustion('openai-codex', snapshot)).toEqual({ exhausted: false, accountAvailability: snapshot });
    expect(assessQuotaExhaustion('openai-codex', { reason: 'no-candidate', candidateCount: 0, thresholdPercent: 95 }).exhausted).toBe(true);
    expect(assessQuotaExhaustion('openai-codex', { reason: 'no-candidate', candidateCount: 0, currentUsedPercent: 40 }).exhausted).toBe(true);
    expect(assessQuotaExhaustion('openai-codex', { ...snapshot, currentUsedPercent: 95 }).exhausted).toBe(true);
    expect(assessQuotaExhaustion('openai-codex', { ...snapshot, reason: 'reset-credit-available' }).exhausted).toBe(true);
  });

  test('account-aware quota assessment preserves available, exhausted, unknown, and non-Codex states', () => {
    const available = assessQuotaExhaustion('openai-codex', { reason: 'rotated', candidateCount: 2 });
    // ⭐ candidateCount 가 «0 이 아니어도» exhausted 다 — 「후보는 2개 있었는데 «전부 임계 초과»」라는 뜻이다.
    const exhausted = assessQuotaExhaustion('openai-codex', { reason: 'no-candidate', candidateCount: 2 });
    const noEligibleAccounts = assessQuotaExhaustion('openai-codex', { reason: 'no-candidate', candidateCount: 0 });
    const unknown = assessQuotaExhaustion('openai-codex', { reason: 'no-candidate', candidateCount: undefined });
    const nonCodex = assessQuotaExhaustion('anthropic', { reason: 'no-candidate', candidateCount: 2 });

    expect(available.exhausted).toBe(false);
    expect(exhausted.exhausted).toBe(true);
    expect(noEligibleAccounts.exhausted).toBe(true);
    expect(unknown.exhausted).toBeUndefined();
    expect(nonCodex.exhausted).toBeUndefined();
    expect(quotaSignalAppliesTo('anthropic', true)).toBeUndefined();

    const classified = classifyAbandonedRun({
      worktreePorcelain: ' M unfinished.ts',
      supervisorVerdict: 'UNCONVERGEABLE',
      goalCauseObserved: true,
      quotaAccountAvailability: available.accountAvailability,
      mustFixReported: false,
    });
    expect(classified).toMatchObject({
      classification: 'goal-unconvergeable-candidate',
      quotaAccountAvailability: { reason: 'rotated', candidateCount: 2 },
    });
  });

  test('single-account no-candidate 400 request rejection is recorded as provider-error through runSelfImplement', async () => {
    const s = seams({
      implement: async () => {
        debug.log('llm.router.error', 'streamLLM', { provider: 'openai-codex', message: 'HTTP 400 invalid_request_error: model request rejected' });
        return { ok: false, completionDisposition: 'completed-without-changes', summary: 'request rejected' };
      },
    });
    s.currentProviderName = () => 'openai-codex';
    s.inspectCodexRotation = (() => ({ reason: 'no-candidate', candidateCount: 0 })) as SelfImplementSeams['inspectCodexRotation'];
    const result = await runSelfImplement({ feature: 'single-account request rejection', seams: s });
    expect(result.providerErrors).toEqual({ count: 1, provider: 'openai-codex', category: 'request' });
    expect(result.quotaExhaustionAssessment?.exhausted).toBe(true);
    expect(result.abandonedClassification).toMatchObject({
      classification: 'provider-error',
      classificationBasis: 'provider-request-rejection-outranks-account-availability',
      quotaExhausted: true,
      providerError: true,
    });
  });

  test('attachAbandonedClassification preserves an inner account snapshot without another rotation inspection', () => {
    let inspections = 0;
    const attached = attachAbandonedClassification({
      ok: false,
      stage: 'gate-failed',
      node: 'rework',
      outcome: 'abandoned',
      quotaExhaustionAssessment: assessQuotaExhaustion('openai-codex', { reason: 'rotated', candidateCount: 2 }),
    } as Parameters<typeof attachAbandonedClassification>[0], undefined, false, false, (() => {
      inspections++;
      return { reason: 'no-candidate', candidateCount: 0 };
    }) as SelfImplementSeams['inspectCodexRotation'], 'openai-codex');

    expect(inspections).toBe(0);
    expect(attached.quotaExhaustionAssessment).toEqual({
      exhausted: false,
      accountAvailability: { reason: 'rotated', candidateCount: 2 },
    });
    expect(attached.abandonedClassification).toMatchObject({
      quotaAccountAvailability: { reason: 'rotated', candidateCount: 2 },
    });
    expect(attached.abandonedClassification?.classification).not.toBe('quota-exhausted');
  });

  test('codex no-candidate cannot mask a grok child UNCONVERGEABLE verdict; default codex still exhausts', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ category, event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      for (const childLlm of [{ provider: 'grok', model: 'grok-4.7', source: 'flag' } as const, undefined]) {
        const s = revSeams({ reviews: [
          { verdict: 'fail', mustFix: ['first blocking finding'] },
          { verdict: 'fail', mustFix: ['repeated blocking finding'] },
        ] });
        s.currentProviderName = () => 'openai-codex';
        s.inspectCodexRotation = (() => ({ reason: 'no-candidate', candidateCount: 3, knownAccountCount: 3,
          currentUsedPercent: 95, thresholdPercent: 95 })) as SelfImplementSeams['inspectCodexRotation'];
        let supervisorVerdicts = 0;
        s.diagnose = async ({ purpose }) => {
          if (purpose === 'escalation-triage') return 'TRIAGE: retry';
          supervisorVerdicts++;
          return supervisorVerdicts === 1
            ? 'BUDGET: EXTEND\nREASON: establish a comparison round'
            : 'BUDGET: UNCONVERGEABLE\nREASON: repeated findings cannot converge';
        };
        s.judgmentCallLLM = async () => 'UNCONVERGEABLE';
        s.decomposeShadowGoals = async () => ({
          goals: [{ id: 'one', feature: 'first independent goal' }, { id: 'two', feature: 'second independent goal' }],
          decomposition: { recommendedMaxTasks: 6, actualTaskCount: 2, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'decomposed' as const },
        });
        const result = await runSelfImplement({ feature: 'run provider quota attribution', maxReworkRounds: 2, reworkBudgetShadowStop: false, ...(childLlm ? { childLlm } : {}), seams: s });
        expect(supervisorVerdicts).toBe(2);
        expect(result).toMatchObject({ stage: 'review-blocked', outcome: 'abandoned', supervisorVerdict: 'UNCONVERGEABLE' });
        expect(result.abandonedClassification?.classification).toBe(childLlm ? 'goal-unconvergeable-candidate' : 'quota-exhausted');
        expect(result.quotaExhaustionAssessment?.exhausted).toBe(childLlm ? undefined : true);
        expect(events.filter(({ category, event }) => category === 'self-implement.abandoned' && event === 'quota-provider').at(-1)?.data)
          .toMatchObject({ runProvider: childLlm?.provider ?? 'openai-codex', defaultProvider: 'openai-codex', used: !childLlm });
      }
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('actual abandoned orchestration paths use the injected rotation authority and retain account grounds', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = (debug as { log: typeof debug.log }).log;
    let rotationInspections = 0;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const s = revSeams({ gateResults: [false, false] });
      let diagnoses = 0;
      s.diagnose = async ({ purpose }) => {
        if (purpose === 'escalation-triage') return 'TRIAGE: focus the retry';
        return ++diagnoses === 1
          ? 'BUDGET: EXTEND\nREASON: one more rework round is needed'
          : 'BUDGET: UNCONVERGEABLE\nREASON: implementation cannot converge';
      };
      s.judgmentCallLLM = async ({ prompt }) => prompt.match(/BUDGET:\s*(EXTEND|UNCONVERGEABLE)/)?.[1] ?? 'EXTEND';
      s.decomposeShadowGoals = async () => ({
        goals: [
          { id: 'one', feature: 'first independent goal' },
          { id: 'two', feature: 'second independent goal' },
        ],
        decomposition: { recommendedMaxTasks: 6, actualTaskCount: 2, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'decomposed' as const },
      });
      s.currentProviderName = () => 'openai-codex';
      s.inspectCodexRotation = (() => {
        rotationInspections++;
        // A second read would report no candidates. Both production paths must retain this first snapshot.
        return rotationInspections === 1
          ? { reason: 'rotated', candidateCount: 2 }
          : { reason: 'no-candidate', candidateCount: 0 };
      }) as SelfImplementSeams['inspectCodexRotation'];

      const result = await runSelfImplement({ feature: 'account availability prevents quota masking', maxReworkRounds: 2, seams: s });

      expect(diagnoses).toBe(4);
      expect(rotationInspections).toBe(1);
      expect(result).toMatchObject({
        stage: 'gate-failed',
        outcome: 'abandoned',
        quotaExhaustionAssessment: { exhausted: false, accountAvailability: { reason: 'rotated', candidateCount: 2 } },
        abandonedClassification: {
          quotaAccountAvailability: { reason: 'rotated', candidateCount: 2 },
        },
      });
      expect(result.abandonedClassification?.classification).not.toBe('quota-exhausted');
      const classifications = events.filter(({ event }) => event === 'abandoned-classification');
      expect(classifications).toHaveLength(1);
      expect(classifications[0]!.data).toMatchObject({
        quotaAccountAvailability: { reason: 'rotated', candidateCount: 2 },
      });
      expect(classifications[0]!.data.classification).not.toBe('quota-exhausted');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('pr-declined abandoned observation keeps its own classification despite a dirty worktree', () => {
    const repo = mkdtempSync(join(tmpdir(), 'pr-declined-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: repo });
      writeFileSync(join(repo, 'artifact.ts'), 'export const artifact = true;\n');

      const events: Array<{ event: string; data: Record<string, unknown> }> = [];
      const ledgerEntries: Array<{ event: string }> = [];
      const observe = makeRunObserver('pr-declined', ((_category, event, data) => {
        events.push({ event, data: data as Record<string, unknown> });
      }) as typeof debug.log, undefined, (entry) => ledgerEntries.push(entry));

      observeRunOutcome(observe, {
        node: 'open-pr',
        stage: 'pr-declined',
        outcome: 'abandoned',
        worktreePath: repo,
        review: { verdict: 'fail', mustFix: [], shouldFix: [], summary: 'PR declined', reviewed: true },
        completionDisposition: undefined,
        supervisorVerdict: undefined,
        mergeApprovalReceived: undefined,
        abandonedClassification: undefined,
        mergeReason: undefined,
      });

      expect(events).toContainEqual(expect.objectContaining({
        event: 'abandoned-classification',
        data: expect.objectContaining({ classification: 'pr-declined', worktreeClean: false, mustFixReported: false }),
      }));
      expect(ledgerEntries).toContainEqual(expect.objectContaining({
        event: 'run-status',
        runId: 'pr-declined',
        data: expect.objectContaining({ runStatus: 'cancelled' }),
      }));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('⚠️ 안전: --auto-merge 지만 리뷰 fail-soft(reviewed=false) → 자동병합 금지·HITL(draft PR)', async () => {
    openPrCalls = [];
    const r = await runSelfImplement({ feature: 'F', autoMerge: true, seams: revSeams({ reviews: [{ verdict: 'pass', reviewed: false }] }) });
    expect(r.stage).toBe('pr-opened');       // 자동병합 안 함
    expect(r.merged).toBeUndefined();
    expect(openPrCalls[0]!.draft).toBe(true); // HITL=draft
  });

  test('리뷰 clean 이지만 --auto-merge 없음 → pr-opened(draft·HITL)', async () => {
    openPrCalls = [];
    const r = await runSelfImplement({ feature: 'F', seams: revSeams({ reviews: [{ verdict: 'pass', reviewed: true }] }) });
    expect(r.stage).toBe('pr-opened');
    expect(openPrCalls[0]!.draft).toBe(true);
  });

  test('auto-merge 결정에서 gh 병합 실패 → pr-opened(수동 병합)', async () => {
    const r = await runSelfImplement({ feature: 'F', autoMerge: true, seams: revSeams({ reviews: [{ verdict: 'pass', reviewed: true }], merged: false }) });
    expect(r.stage).toBe('pr-opened');
    expect(r.merged).toBe(false);
  });
});

describe('defaultSeams — pinned auto-merge', () => {
  test('PR base/head SHA를 먼저 고정하고 그 SHA 쌍에서 직접 diff를 산출한다', async () => {
    const calls: string[][] = [];
    const run = ((command: string, args: readonly string[]) => {
      calls.push([command, ...args]);
      if (command === 'gh') return { status: 0, stdout: '{"baseRefOid":"base-sha","headRefOid":"head-sha","baseRefName":"actual-retargeted-base"}\n', stderr: '' };
      return { status: 0, stdout: 'fixed diff\n', stderr: '' };
    }) as typeof spawnSync;
    const s = defaultSeams({ spawnSync: run });
    const commits = await s.readPrCommitShas!({ number: 9, cwd: '/wt' });
    const diff = await s.readPrDiff!({ number: 9, cwd: '/wt', ...commits });
    expect(commits).toEqual({ baseCommit: 'base-sha', headCommit: 'head-sha', baseRefName: 'actual-retargeted-base' });
    expect(diff).toBe('fixed diff\n');
    expect(calls).toEqual([
      ['gh', 'pr', 'view', '9', '--json', 'baseRefOid,headRefOid,baseRefName'],
      ['git', 'diff', '--no-ext-diff', '--unified', 'base-sha...head-sha'],
    ]);
  });

  test('로컬에 고정 SHA가 없으면 원격 compare로 같은 SHA 쌍의 diff를 읽는다', async () => {
    const calls: string[][] = [];
    const run = ((command: string, args: readonly string[]) => {
      calls.push([command, ...args]);
      if (command === 'git') return { status: 128, stdout: '', stderr: 'fatal: Invalid symmetric difference expression base-sha...head-sha\n' };
      if (args[0] === 'repo') return { status: 0, stdout: 'owner/repo\n', stderr: '' };
      return { status: 0, stdout: 'remote fixed diff\n', stderr: '' };
    }) as typeof spawnSync;

    await expect(defaultSeams({ spawnSync: run }).readPrDiff!({ number: 9, cwd: '/wt', baseCommit: 'base-sha', headCommit: 'head-sha' })).resolves.toBe('remote fixed diff\n');
    expect(calls).toEqual([
      ['git', 'diff', '--no-ext-diff', '--unified', 'base-sha...head-sha'],
      ['gh', 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
      ['gh', 'api', 'repos/owner/repo/compare/base-sha...head-sha', '-H', 'Accept: application/vnd.github.diff'],
    ]);
  });

  test.each([
    ['base', 'base-sha'],
    ['head', 'head-sha'],
  ])('원격 compare도 404면 없는 %s SHA를 오류에 명시한다', async (missingLabel, missingSha) => {
    const run = ((command: string, args: readonly string[]) => {
      if (command === 'git') return { status: 128, stdout: '', stderr: 'fatal: Invalid symmetric difference expression base-sha...head-sha\n' };
      if (args[0] === 'repo') return { status: 0, stdout: 'owner/repo\n', stderr: '' };
      if (args[1]?.includes('/compare/')) return { status: 1, stdout: '', stderr: 'HTTP 404 Not Found' };
      return args[1]?.endsWith(`/${missingSha}`)
        ? { status: 1, stdout: '', stderr: 'HTTP 404 Not Found' }
        : { status: 0, stdout: '{"sha":"present"}\n', stderr: '' };
    }) as typeof spawnSync;

    await expect(defaultSeams({ spawnSync: run }).readPrDiff!({ number: 9, cwd: '/wt', baseCommit: 'base-sha', headCommit: 'head-sha' }))
      .rejects.toThrow(`git diff fixed commits failed: ${missingLabel} SHA ${missingSha} is missing from remote repository (HTTP 404)`);
  });

  test('confirmed merge는 gh merge 성공 뒤 MERGED 상태와 관측 base 및 merge commit을 확인한다', async () => {
    const calls: string[][] = [];
    const run = ((command: string, args: readonly string[]) => {
      calls.push([command, ...args]);
      if (args.includes('mergeCommit')) return { status: 0, stdout: '{"mergeCommit":{"oid":"merged-sha"}}\n', stderr: '' };
      if (args[0] === 'pr' && args[1] === 'view') return { status: 0, stdout: '{"state":"MERGED","baseRefName":"actual-parent-branch"}\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    }) as typeof spawnSync;
    const result = await defaultSeams({ spawnSync: run }).mergePr!({ number: 9, cwd: '/wt', matchHeadCommit: 'checked-head-sha' });
    expect(result).toEqual({ merged: true, baseRefName: 'actual-parent-branch', mergeCommit: 'merged-sha' });
    expect(calls).toEqual([
      ['gh', 'pr', 'merge', '9', '--squash', '--match-head-commit', 'checked-head-sha'],
      ['gh', 'pr', 'view', '9', '--json', 'state,baseRefName'],
      ['gh', 'pr', 'view', '9', '--json', 'mergeCommit'],
    ]);
  });

  test.each([
    ['command failure', 1, '', 'network unavailable'],
    ['malformed JSON', 0, '{broken', ''],
    ['missing SHA', 0, '{"mergeCommit":null}', ''],
  ])('confirmed merge keeps its result when mergeCommit lookup has %s', async (_case, status, stdout, stderr) => {
    const calls: string[][] = [];
    const run = ((command: string, args: readonly string[]) => {
      calls.push([command, ...args]);
      if (args.includes('mergeCommit')) return { status, stdout, stderr };
      if (args[1] === 'view') return { status: 0, stdout: '{"state":"MERGED","baseRefName":"main"}', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    }) as typeof spawnSync;
    expect(await defaultSeams({ spawnSync: run }).mergePr!({ number: 9, cwd: '/wt' }))
      .toEqual({ merged: true, baseRefName: 'main' });
    expect(calls).toEqual([
      ['gh', 'pr', 'merge', '9', '--squash'],
      ['gh', 'pr', 'view', '9', '--json', 'state,baseRefName'],
      ['gh', 'pr', 'view', '9', '--json', 'mergeCommit'],
    ]);
  });

  test('state가 OPEN이면 merge commit을 조회하지 않고 실패 결과를 유지한다', async () => {
    const calls: string[][] = [];
    const run = ((command: string, args: readonly string[]) => {
      calls.push([command, ...args]);
      if (args[1] === 'view') return { status: 0, stdout: '{"state":"OPEN","baseRefName":"main"}', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    }) as typeof spawnSync;
    expect(await defaultSeams({ spawnSync: run }).mergePr!({ number: 9, cwd: '/wt' }))
      .toEqual({ merged: false, detail: 'PR state is OPEN after merge command' });
    expect(calls).toEqual([
      ['gh', 'pr', 'merge', '9', '--squash'],
      ['gh', 'pr', 'view', '9', '--json', 'state,baseRefName'],
    ]);
  });

  test('pinned 즉시 병합이 실패하면 --auto를 큐잉하지 않고 PR을 열린 상태로 둔다', async () => {
    const calls: string[][] = [];
    const run = ((command: string, args: readonly string[]) => {
      calls.push([command, ...args]);
      return { status: 1, stdout: '', stderr: 'head changed' };
    }) as typeof spawnSync;
    const result = await defaultSeams({ spawnSync: run }).mergePr!({ number: 9, cwd: '/wt', matchHeadCommit: 'checked-head-sha' });
    expect(result.merged).toBe(false);
    expect(calls).toEqual([
      ['gh', 'pr', 'merge', '9', '--squash', '--match-head-commit', 'checked-head-sha'],
    ]);
  });
});

describe('runSelfImplement — docs Markdown 대량 삭제 auto-merge guard', () => {
  const docsDiff = (deletions: number, path = 'docs/ROADMAP.md') => [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    ...Array.from({ length: deletions }, (_, index) => `-deleted line ${index}`),
  ].join('\n');

  test('docs 마크다운에서 500줄 이상 삭제하는 diff는 자동머지되지 않고 pr-opened로 끝난다', async () => {
    const original = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    try {
      (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
        events.push({ event, data: data as Record<string, unknown> });
      }) as typeof debug.log;
      let mergeCalls = 0;
      const s = revSeams({ reviews: [{ verdict: 'pass', reviewed: true }] });
      s.readPrDiff = async () => docsDiff(500);
      s.mergePr = async () => { mergeCalls++; return { merged: true }; };
      const result = await runSelfImplement({ feature: 'docs deletion', autoMerge: true, seams: s });
      expect(result.stage).toBe('pr-opened');
      expect(result.detail).toContain('docs Markdown deletion count 500 meets threshold 500');
      expect(mergeCalls).toBe(0);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'auto-merge-docs-deletion-guard', data: expect.objectContaining({ docsMarkdownDeletions: 500, threshold: 500, blocked: true }) }),
    ]));
  });

  // ⛔⭐⭐ 「이유가 마지막 줄에 실린다」는 «판정이 막은 경우»만 물면 반쪽이다 — `canAuto` 가 «참»이었는데
  //    집행 직전에 막히는 경로가 둘 더 있다(가드 · 삭제 임계 · 병합 시도 실패). 그 경로들이 이유를
  //    «결과에» 싣지 않으면 사람이 보는 줄이 침묵한다(무인 리뷰 must-fix 2R).
  test('canAuto 였는데 docs 삭제 임계로 막히면 그 사실이 결과의 mergeReason 에 남는다', async () => {
    const s = revSeams({ reviews: [{ verdict: 'pass', reviewed: true }] });
    s.readPrDiff = async () => docsDiff(500);
    let mergeCalls = 0;
    s.mergePr = async () => { mergeCalls++; return { merged: true }; };
    const result = await runSelfImplement({ feature: 'docs deletion reason', autoMerge: true, seams: s });
    expect(mergeCalls).toBe(0);
    // ⭐ 「무언가 실렸다」가 아니라 «그 값»을 문다 — 아무 문자열이나 통과하면 회귀가 아니다.
    expect(result).toMatchObject({ stage: 'pr-opened', mergeReason: 'docs-deletion-threshold' });
  });

  // ⛔⭐ 반론을 «회귀로» 못 박는다 — 무인 리뷰가 5R 에서 *"canAuto=true 인데 approvePr 가 거부되면
  //    pr-declined 로 끝나 이유가 안 나온다"* 를 must-fix 로 냈다. 소스상 `approved = canAuto ? true : …`
  //    라 그 경로는 «도달 불가»다. 말로만 반론하면 다음 사람이 다시 같은 지적을 한다 ⇒ 실행으로 고정한다.
  test('canAuto 면 approvePr 가 거부해도 pr-declined 로 가지 않는다 (리뷰 5R 반론의 회귀)', async () => {
    const s = revSeams({ reviews: [{ verdict: 'pass', reviewed: true }] });
    let approveCalls = 0;
    s.approvePr = async () => { approveCalls++; return false; };   // ⛔ 거부해도
    const result = await runSelfImplement({ feature: 'canauto bypasses approval', autoMerge: true, seams: s });
    expect(result.stage).not.toBe('pr-declined');
    // ⭐ 그리고 approvePr 는 «불리지도 않는다» — canAuto 가 그 분기를 통째로 건너뛴다.
    expect(approveCalls).toBe(0);
  });

  test('canAuto 였는데 가드 평가를 못하면 merge-guard-unevaluated 가 결과에 남는다', async () => {
    const s = revSeams({ reviews: [{ verdict: 'pass', reviewed: true }] });
    // ⭐ 가드는 seam 이 없을 때 뜬다 — 「없음」을 만들어 그 경로를 «강제»한다.
    delete (s as { readPrCommitShas?: unknown }).readPrCommitShas;
    let mergeCalls = 0;
    s.mergePr = async () => { mergeCalls++; return { merged: true }; };
    const result = await runSelfImplement({ feature: 'merge guard reason', autoMerge: true, seams: s });
    expect(mergeCalls).toBe(0);
    expect(result).toMatchObject({ stage: 'pr-opened', mergeReason: 'merge-guard-unevaluated' });
  });

  test('canAuto 였는데 병합 시도가 실패하면 그 사실이 결과의 mergeReason 에 남는다', async () => {
    const s = revSeams({ reviews: [{ verdict: 'pass', reviewed: true }] });
    s.mergePr = async () => ({ merged: false, detail: 'not mergeable' });
    const result = await runSelfImplement({ feature: 'merge attempt failed', autoMerge: true, seams: s });
    expect(result).toMatchObject({ stage: 'pr-opened', merged: false, mergeReason: 'merge-attempt-failed' });
  });

  test('docs 마크다운에서 499줄 삭제하는 diff는 자동머지된다', async () => {
    let mergeCalls = 0;
    const s = revSeams({ reviews: [{ verdict: 'pass', reviewed: true }] });
    s.readPrDiff = async () => docsDiff(499);
    s.mergePr = async () => { mergeCalls++; return { merged: true }; };
    const result = await runSelfImplement({ feature: 'docs boundary', autoMerge: true, seams: s });
    expect(result.stage).toBe('merged');
    expect(mergeCalls).toBe(1);
  });

  test('소스 코드 파일의 대량 삭제는 이 가드가 막지 않는다', async () => {
    let mergeCalls = 0;
    const s = revSeams({ reviews: [{ verdict: 'pass', reviewed: true }] });
    s.readPrDiff = async () => docsDiff(1_000, 'src/large-module.ts');
    s.mergePr = async () => { mergeCalls++; return { merged: true }; };
    const result = await runSelfImplement({ feature: 'source deletion', autoMerge: true, seams: s });
    expect(result.stage).toBe('merged');
    expect(mergeCalls).toBe(1);
  });

  test('diff 읽기 seam이 주입되지 않으면 자동머지하지 않고 그 사실을 관측으로 남긴다', async () => {
    const original = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    try {
      (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
        events.push({ event, data: data as Record<string, unknown> });
      }) as typeof debug.log;
      let mergeCalls = 0;
      const s = revSeams({ reviews: [{ verdict: 'pass', reviewed: true }] });
      delete s.readPrDiff;
      s.mergePr = async () => { mergeCalls++; return { merged: true }; };
      const result = await runSelfImplement({ feature: 'missing diff seam', autoMerge: true, seams: s });
      expect(result.stage).toBe('pr-opened');
      expect(result.detail).toContain('readPrDiff seam unavailable');
      expect(mergeCalls).toBe(0);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'auto-merge-docs-deletion-guard', data: expect.objectContaining({ blocked: true, guardFailure: 'readPrDiff seam unavailable' }) }),
    ]));
  });

  test('diff 읽기 seam 실패 또는 비정상 결과면 자동머지하지 않는다', async () => {
    for (const readPrDiff of [
      async () => { throw new Error('diff service unavailable'); },
      async () => null as unknown as string,
    ]) {
      let mergeCalls = 0;
      const s = revSeams({ reviews: [{ verdict: 'pass', reviewed: true }] });
      s.readPrDiff = readPrDiff;
      s.mergePr = async () => { mergeCalls++; return { merged: true }; };
      const result = await runSelfImplement({ feature: 'unreadable diff', autoMerge: true, seams: s });
      expect(result.stage).toBe('pr-opened');
      expect(result.detail).toContain('automatic merge blocked');
      expect(mergeCalls).toBe(0);
    }
  });

  test('quoted 한글·공백 docs Markdown 경로의 500줄 삭제도 자동머지를 차단한다', async () => {
    let mergeCalls = 0;
    const s = revSeams({ reviews: [{ verdict: 'pass', reviewed: true }] });
    s.readPrDiff = async () => [
      'diff --git "a/docs/\\355\\225\\234\\352\\270\\200 \\353\\254\\270\\354\\204\\234.md" "b/docs/\\355\\225\\234\\352\\270\\200 \\353\\254\\270\\354\\204\\234.md"',
      '--- "a/docs/한글 문서.md"',
      '+++ "b/docs/한글 문서.md"',
      ...Array.from({ length: 500 }, (_, index) => `-deleted line ${index}`),
    ].join('\n');
    s.mergePr = async () => { mergeCalls++; return { merged: true }; };
    const result = await runSelfImplement({ feature: 'quoted docs deletion', autoMerge: true, seams: s });
    expect(result.stage).toBe('pr-opened');
    expect(result.detail).toContain('docs Markdown deletion count 500 meets threshold 500');
    expect(mergeCalls).toBe(0);
  });

  test('quoted 비문서 경로의 대량 삭제는 이 가드가 막지 않는다', async () => {
    let mergeCalls = 0;
    const s = revSeams({ reviews: [{ verdict: 'pass', reviewed: true }] });
    s.readPrDiff = async () => [
      'diff --git "a/src/\\355\\225\\234\\352\\270\\200 \\353\\252\\250\\353\\223\\210.ts" "b/src/\\355\\225\\234\\352\\270\\200 \\353\\252\\250\\353\\223\\210.ts"',
      '--- "a/src/한글 모듈.ts"',
      '+++ "b/src/한글 모듈.ts"',
      ...Array.from({ length: 1_000 }, (_, index) => `-deleted line ${index}`),
    ].join('\n');
    s.mergePr = async () => { mergeCalls++; return { merged: true }; };
    const result = await runSelfImplement({ feature: 'quoted source deletion', autoMerge: true, seams: s });
    expect(result.stage).toBe('merged');
    expect(mergeCalls).toBe(1);
  });

  test('해석할 수 없는 diff --git header는 fail-closed로 자동머지를 막는다', async () => {
    let mergeCalls = 0;
    const s = revSeams({ reviews: [{ verdict: 'pass', reviewed: true }] });
    s.readPrDiff = async () => 'diff --git "a/docs/unterminated.md b/docs/unterminated.md';
    s.mergePr = async () => { mergeCalls++; return { merged: true }; };
    const result = await runSelfImplement({ feature: 'malformed diff header', autoMerge: true, seams: s });
    expect(result.stage).toBe('pr-opened');
    expect(result.detail).toContain('automatic merge blocked: readPrDiff failed: unparseable diff --git header');
    expect(mergeCalls).toBe(0);
  });

  test('docs Markdown에서 ---로 시작하는 실제 삭제 내용도 삭제량으로 센다', async () => {
    let mergeCalls = 0;
    const s = revSeams({ reviews: [{ verdict: 'pass', reviewed: true }] });
    s.readPrDiff = async () => docsDiff(499).concat('\n---actual deleted content');
    s.mergePr = async () => { mergeCalls++; return { merged: true }; };
    const result = await runSelfImplement({ feature: 'docs header precision', autoMerge: true, seams: s });
    expect(result.stage).toBe('pr-opened');
    expect(mergeCalls).toBe(0);
  });

  test('docs 아래 대문자 확장자 Markdown 문서의 대량 삭제도 자동머지되지 않는다', async () => {
    let mergeCalls = 0;
    const s = revSeams({ reviews: [{ verdict: 'pass', reviewed: true }] });
    s.readPrDiff = async () => docsDiff(500, 'docs/FOO.MD');
    s.mergePr = async () => { mergeCalls++; return { merged: true }; };
    const result = await runSelfImplement({ feature: 'uppercase docs extension', autoMerge: true, seams: s });
    expect(result.stage).toBe('pr-opened');
    expect(mergeCalls).toBe(0);
  });

  test('검사한 head와 다른 head로는 병합을 호출하지 않는다', async () => {
    const diffInputs: Array<{ baseCommit: string; headCommit: string }> = [];
    const mergeCalls: Array<{ matchHeadCommit?: string }> = [];
    const s = revSeams({ reviews: [{ verdict: 'pass', reviewed: true }] });
    s.readPrCommitShas = async () => ({ baseCommit: 'base-sha', headCommit: 'checked-head-sha' });
    s.readPrDiff = async ({ baseCommit, headCommit }) => {
      diffInputs.push({ baseCommit, headCommit });
      return docsDiff(1);
    };
    s.mergePr = async ({ matchHeadCommit }) => {
      mergeCalls.push({ matchHeadCommit });
      return { merged: false, detail: 'gh rejected changed head' };
    };
    await runSelfImplement({ feature: 'head race guard', autoMerge: true, seams: s });
    expect(diffInputs).toEqual([{ baseCommit: 'base-sha', headCommit: 'checked-head-sha' }]);
    expect(mergeCalls).toEqual([{ matchHeadCommit: 'checked-head-sha' }]);
  });

  test('A → B → A 중 B의 가변 PR diff가 안전해도 고정된 A diff만 검사한다', async () => {
    const inspected: string[] = [];
    let mergeCalls = 0;
    const s = revSeams({ reviews: [{ verdict: 'pass', reviewed: true }] });
    s.readPrCommitShas = async () => ({ baseCommit: 'base-sha', headCommit: 'A' });
    s.readPrDiff = async ({ headCommit }) => {
      inspected.push(headCommit);
      return headCommit === 'A' ? docsDiff(500) : docsDiff(0);
    };
    s.mergePr = async () => { mergeCalls++; return { merged: true }; };
    const result = await runSelfImplement({ feature: 'ABA head race guard', autoMerge: true, seams: s });
    expect(inspected).toEqual(['A']);
    expect(result.stage).toBe('pr-opened');
    expect(result.detail).toContain('docs Markdown deletion count 500');
    expect(mergeCalls).toBe(0);
  });

  test('동일한 검사 head만 --match-head-commit으로 묶어 병합한다', async () => {
    const mergeCalls: Array<{ matchHeadCommit?: string }> = [];
    const s = revSeams({ reviews: [{ verdict: 'pass', reviewed: true }] });
    s.readPrDiff = async () => docsDiff(1);
    s.readPrCommitShas = async () => ({ baseCommit: 'base-sha', headCommit: 'checked-head-sha' });
    s.mergePr = async ({ matchHeadCommit }) => {
      mergeCalls.push({ matchHeadCommit });
      return { merged: false, detail: 'gh rejected --match-head-commit' };
    };
    const result = await runSelfImplement({ feature: 'pinned head merge', autoMerge: true, seams: s });
    expect(result.stage).toBe('pr-opened');
    expect(mergeCalls).toEqual([{ matchHeadCommit: 'checked-head-sha' }]);
  });

  test('head SHA seam이 미주입이면 자동 병합하지 않고 그 사실을 관측에 남긴다', async () => {
    const original = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    try {
      (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
        events.push({ event, data: data as Record<string, unknown> });
      }) as typeof debug.log;
      const mergeCalls: Array<{ matchHeadCommit?: string }> = [];
      const s = revSeams({ reviews: [{ verdict: 'pass', reviewed: true }] });
      s.readPrDiff = async () => docsDiff(1);
      delete s.readPrCommitShas;
      s.mergePr = async ({ matchHeadCommit }) => { mergeCalls.push({ matchHeadCommit }); return { merged: true }; };
      const result = await runSelfImplement({ feature: 'missing head seam', autoMerge: true, seams: s });
      expect(result.stage).toBe('pr-opened');
      expect(result.detail).toContain('readPrCommitShas seam unavailable');
      expect(mergeCalls).toEqual([]);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'auto-merge-head-guard', data: expect.objectContaining({ protected: false, blocked: true, reason: 'readPrCommitShas seam unavailable' }) }),
    ]));
  });

  test('인용된 경로 해석을 self-review-cli에 위임한 뒤에도 기존 인용 경로 테스트가 통과한다', () => {
    expect(countDocsMarkdownDeletions([
      'diff --git "a/docs/\\355\\225\\234\\352\\270\\200 \\353\\254\\270\\354\\204\\234.MD" "b/docs/\\355\\225\\234\\352\\270\\200 \\353\\254\\270\\354\\204\\234.MD"',
      '--- "a/docs/한글 문서.MD"',
      '+++ "b/docs/한글 문서.MD"',
      '-deleted',
    ].join('\n'))).toBe(1);
  });
});

// ★ G2 — PR-직전 기본 브랜치 정합(병렬 auto-merge 충돌회피) 테스트
describe('runSelfImplement — G2 PR-直前 main-싱크', () => {
  function g2Seams(opts: { mergeStatus: 'merged' | 'up-to-date' | 'llm-resolved' | 'conflict-unresolved' | 'error'; gateResults?: boolean[]; order?: string[]; gateContexts?: Array<{ runId?: string; mode?: 'postsync' } | undefined> }): SelfImplementSeams {
    const gateResults = opts.gateResults ?? [true];
    let gateCall = 0;
    const order = opts.order ?? [];
    const gateContexts = opts.gateContexts;
    return {
      writeRunLedger: () => {},
      // ⛔⭐⭐ 이 심이 «없으면» 진짜 쿼터 갱신이 돈다 — 그것은 총 상한 40초를 «다 쓰고» 돌아온다
      //   (실측 2026-09-12: 단독 호출 40,003ms). 그래서 이 블록의 시험이 5초에서도 30초에서도
      //   ***전부 타임아웃***했다(19~23건 · 최소 3주). 매달린 게 아니라 «예산»이었다.
      refreshCodexQuotaSignals: async () => ({}),
      createWorktree: async ({ branch, base }) => ({ path: `/wt/${branch}`, branch, base, resolvedBase: 'a'.repeat(40), invokedHead: 'a'.repeat(40) }),
      implement: async () => ({ ok: true, summary: 'impl' }),
      gate: async (_cwd, ctx) => { const passed = gateResults[Math.min(gateCall, gateResults.length - 1)]!; gateCall++; gateContexts?.push(ctx); order.push(`gate:${passed}`); return { passed, log: passed ? 'ok' : 'tsc err', ...(gateCall === 2 ? { scopeReason: 'changed-tests', measuredFileCount: 3, comparisonBase: 'merge-base-sha' } : {}) }; },
      commitWork: () => { order.push('commit'); },
      defaultBranchRef: () => 'origin/main',
      mergeMain: async () => { order.push('mergeMain'); return { status: opts.mergeStatus }; },
      openPr: async ({ head }) => { order.push('openPr'); return { url: `https://pr/${head}`, number: 7 }; },
      approvePr: async () => true,
    };
  }

  test('up-to-date → 재-gate 없이 PR 개설·commit→mergeMain→openPr 순', async () => {
    const order: string[] = [];
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const r = await runSelfImplement({ feature: 'F', seams: g2Seams({ mergeStatus: 'up-to-date', gateResults: [true], order }) });
      expect(r.stage).toBe('pr-opened');
      expect(order).toEqual(['gate:true', 'commit', 'mergeMain', 'openPr']); // commit 이 merge 전, 재-gate 없음
      expect(events.filter((entry) => entry.event === 'gate.postsync')).toHaveLength(0);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('호출부가 기본 브랜치를 한 번 해석해 병합 seam까지 변경 없이 전달하고 관측한다', async () => {
    const order: string[] = [];
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const s = g2Seams({ mergeStatus: 'up-to-date', gateResults: [true], order });
      let resolutions = 0;
      let receivedTarget: string | undefined;
      s.defaultBranchRef = () => { resolutions++; order.push('resolve'); return 'main'; };
      s.mergeMain = async (_worktreePath, mergeTarget) => { receivedTarget = mergeTarget; order.push(`mergeMain:${mergeTarget}`); return { status: 'up-to-date' }; };
      await runSelfImplement({ feature: 'F', seams: s });
      expect(resolutions).toBe(1);
      expect(receivedTarget).toBe('main');
      expect(order).toEqual(['gate:true', 'commit', 'resolve', 'mergeMain:main', 'openPr']);
      expect(events.find((entry) => entry.event === 'pre-pr-sync')?.data).toMatchObject({ status: 'up-to-date', mergeTarget: 'main', defaultBranchResolved: true });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('로컬 master도 해석값 그대로 병합·관측·진행 문구에 쓴다', async () => {
    const order: string[] = [];
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const progress: string[] = [];
    const originalLog = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const s = g2Seams({ mergeStatus: 'merged', gateResults: [true, true], order });
      s.defaultBranchRef = () => 'master';
      s.onProgress = ({ message }) => { progress.push(message); };
      s.mergeMain = async (_worktreePath, mergeTarget) => {
        order.push(`mergeMain:${mergeTarget}`);
        return { status: 'merged' };
      };
      const result = await runSelfImplement({ feature: 'F', seams: s });
      expect(result.stage).toBe('pr-opened');
      expect(order).toEqual(['gate:true', 'commit', 'mergeMain:master', 'gate:true', 'openPr']);
      expect(events.find((entry) => entry.event === 'pre-pr-sync')?.data).toMatchObject({ status: 'merged', mergeTarget: 'master', defaultBranchResolved: true });
      expect(progress.join('')).toContain('master 정합됨');
      expect(progress.join('')).not.toContain('main 정합됨');
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
    }
  });

  test('기본 브랜치를 해석하지 못하면 병합기를 호출하지 않고 셋째 결과를 관측한다', async () => {
    const order: string[] = [];
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const s = g2Seams({ mergeStatus: 'up-to-date', gateResults: [true], order });
      s.defaultBranchRef = () => { order.push('resolve'); return null; };
      const r = await runSelfImplement({ feature: 'F', seams: s });
      expect(r).toMatchObject({ stage: 'merge-conflict', detail: 'pre-PR main sync default-branch-unresolved' });
      expect(order).toEqual(['gate:true', 'commit', 'resolve']);
      expect(events.find((entry) => entry.event === 'pre-pr-sync')?.data).toMatchObject({ status: 'default-branch-unresolved', mergeTarget: null, defaultBranchResolved: false });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  // ⭐⭐ 「없다(null)」와 «못 읽었다(throw)»는 «다른 입력»인데 «같은 결과»로 끝나야 한다.
  //   ⛔ 종전엔 pre-PR 경로가 예외를 그대로 던져 셋째 결과로 «정규화되지 않았다»(리뷰 must-fix).
  //   그리고 「못 읽었다」는 이름(resolveError)을 달아 «없다»와 관측에서 구분된다.
  test('기본 브랜치 해석이 «예외»를 던져도 같은 셋째 결과로 끝나고 사유가 이름으로 남는다', async () => {
    const order: string[] = [];
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const s = g2Seams({ mergeStatus: 'up-to-date', gateResults: [true], order });
      s.defaultBranchRef = () => { order.push('resolve'); throw new Error('git ref 조회 실패'); };
      const r = await runSelfImplement({ feature: 'F', seams: s });
      // 결과는 null 일 때와 «같다» — 사람이 두 실패를 다르게 배우지 않는다
      expect(r).toMatchObject({ stage: 'merge-conflict', detail: 'pre-PR main sync default-branch-unresolved' });
      expect(order).toEqual(['gate:true', 'commit', 'resolve']);   // 병합기를 «안» 부른다
      const data = events.find((entry) => entry.event === 'pre-pr-sync')?.data;
      expect(data).toMatchObject({ status: 'default-branch-unresolved', mergeTarget: null, defaultBranchResolved: false });
      // ⭐ 그러나 관측은 둘을 «가른다» — 「못 읽었다」에만 사유가 붙는다
      expect(String((data as { resolveError?: unknown }).resolveError)).toContain('git ref 조회 실패');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('conflict-unresolved → merge-conflict escalate·PR 미개설', async () => {
    const order: string[] = [];
    const r = await runSelfImplement({ feature: 'F', seams: g2Seams({ mergeStatus: 'conflict-unresolved', gateResults: [true], order }) });
    expect(r.stage).toBe('merge-conflict');
    expect(r.ok).toBe(false);
    expect(order).not.toContain('openPr'); // 자동병합 차단
  });

  test('merged(클린) → 기존 full 재-gate·통과 시 PR (합침 후 테스트 재검)', async () => {
    const order: string[] = [];
    const gateContexts: Array<{ runId?: string } | undefined> = [];
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const r = await runSelfImplement({
        feature: 'F',
        seams: g2Seams({ mergeStatus: 'merged', gateResults: [true, true], order, gateContexts }),
      });
      expect(r.stage).toBe('pr-opened');
      expect(order).toEqual(['gate:true', 'commit', 'mergeMain', 'gate:true', 'openPr']);
      expect(gateContexts).toHaveLength(2);
      expect(gateContexts[0]?.runId).toBeString();
      expect(gateContexts[1]?.runId).toBe(gateContexts[0]?.runId);
      expect(events).toContainEqual(expect.objectContaining({
        event: 'gate.postsync',
        data: expect.objectContaining({ passed: true, mode: 'full', branch: expect.any(String), scopeReason: 'changed-tests' }),
      }));
      expect(events.filter((entry) => entry.event === 'gate.postsync')).toHaveLength(1);
      expect(events.some((entry) => entry.event === 'gate.postsync' && entry.data.mode === 'tsc')).toBe(false);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('merged → 재-gate 범위값이 없으면 postsync에 unavailable을 남긴다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const s = g2Seams({ mergeStatus: 'merged', gateResults: [true, true] });
      s.gate = async () => ({ passed: true, log: 'ok' });
      const r = await runSelfImplement({ feature: 'F', seams: s });
      expect(r.stage).toBe('pr-opened');
      expect(events).toContainEqual(expect.objectContaining({
        event: 'gate.postsync',
        data: expect.objectContaining({ passed: true, mode: 'full', branch: expect.any(String), scopeReason: 'unavailable' }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('merged(클린) 통과는 sync 뒤·merge 전에 full 재-gate를 남기고 착지를 막지 않는다', async () => {
    const order: string[] = [];
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const s = g2Seams({ mergeStatus: 'merged', gateResults: [true, true], order });
      s.mergePr = async () => { order.push('mergePr'); return { merged: true }; };
      s.readPrDiff = async () => '';
      s.readPrCommitShas = async () => ({ baseCommit: 'base-sha', headCommit: 'checked-head-sha' });
      s.reviewDiff = async () => ({
        verdict: 'pass',
        mustFix: [],
        shouldFix: [],
        summary: 'review',
        reviewed: true,
        diffTruncated: false,
        diffShownChars: 100,
        diffTotalChars: 100,
        diffOmittedFiles: 0,
      });
      const r = await runSelfImplement({ feature: 'F', autoMerge: true, seams: s });
      expect(r).toMatchObject({ stage: 'merged', ok: true });
      expect(order).toEqual(['gate:true', 'commit', 'mergeMain', 'gate:true', 'openPr', 'mergePr']);
      expect(order.indexOf('mergeMain')).toBeLessThan(order.indexOf('gate:true', 1));
      expect(order.indexOf('gate:true', 1)).toBeLessThan(order.indexOf('mergePr'));
      expect(events).toContainEqual(expect.objectContaining({
        event: 'gate.postsync',
        data: expect.objectContaining({ passed: true, mode: 'full', branch: expect.any(String), scopeReason: 'changed-tests' }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('merged → 합침이 테스트를 깨뜨리면 gate-failed·draft PR 보존·자동병합 차단', async () => {
    const order: string[] = [];
    let opened: { draft?: boolean; body: string } | undefined;
    let mergeCalls = 0;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
    const s = g2Seams({ mergeStatus: 'merged', gateResults: [true, false], order });
    s.openPr = async ({ draft, body }) => { opened = { draft, body }; order.push('openPr'); return { url: 'https://pr/clean-merge-break', number: 8 }; };
    s.mergePr = async () => { mergeCalls++; return { merged: true }; };
    const r = await runSelfImplement({
      feature: 'F',
      autoMerge: true,
      seams: {
        ...s,
        reviewDiff: async () => ({
          verdict: 'pass',
          mustFix: [],
          shouldFix: [],
          summary: 'review',
          reviewed: true,
          diffTruncated: false,
          diffShownChars: 100,
          diffTotalChars: 100,
          diffOmittedFiles: 0,
        }),
      },
    });
    expect(r).toMatchObject({ stage: 'gate-failed', node: 'regate', prUrl: expect.any(String) });
    expect(order).toEqual(['gate:true', 'commit', 'mergeMain', 'gate:false', 'openPr']);
    expect(opened).toEqual(expect.objectContaining({ draft: true }));
    expect(opened!.body).toContain('gate failed after main-sync (clean-merge integration break)');
    expect(mergeCalls).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({
      event: 'gate.postsync',
      data: expect.objectContaining({ passed: false, mode: 'full', branch: expect.any(String), scopeReason: 'changed-tests' }),
    }));
    expect(opened!.body).toContain('## Gate');
    expect(opened!.body).toContain('tsc err');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('post-sync preservation passes the resolved worktree base to the change seam', async () => {
    let changeContext: { cwd: string; base?: string } | undefined;
    const s = g2Seams({ mergeStatus: 'llm-resolved', gateResults: [true, false] });
    s.preservationHasChanges = (ctx) => { changeContext = ctx; return true; };
    const r = await runSelfImplement({ feature: 'F', seams: s });
    expect(r).toMatchObject({ stage: 'gate-failed', prUrl: expect.any(String) });
    expect(changeContext).toEqual({ cwd: expect.stringContaining('/wt/'), base: 'origin/main' });
  });

  test('llm-resolved progress reports formatter-provided size change and its unavailable fallback', async () => {
    const sizedProgress: string[] = [];
    const sized = g2Seams({ mergeStatus: 'llm-resolved', gateResults: [true, true] });
    sized.mergeMain = async () => ({
      status: 'llm-resolved',
      resolvedFiles: ['src/user-config.ts'],
      sizeChange: {
        files: [{ file: 'src/user-config.ts', beforeLines: 5648, afterLines: 79, deltaLines: -5569 }],
        totalBeforeLines: 5648,
        totalAfterLines: 79,
        totalDeltaLines: -5569,
      },
    });
    sized.onProgress = ({ message }) => { sizedProgress.push(message); };
    expect((await runSelfImplement({ feature: 'F', seams: sized })).stage).toBe('pr-opened');
    expect(sizedProgress).toContain('origin/main 충돌해결됨 — llm-resolved (LLM 종합 1파일: src/user-config.ts); 규모 변화: 5648→79줄(-5569) [src/user-config.ts 5648→79줄(-5569)] — 통합 결과 full 재-gate…');

    const unavailableProgress: string[] = [];
    const unavailable = g2Seams({ mergeStatus: 'llm-resolved', gateResults: [true, true] });
    unavailable.onProgress = ({ message }) => { unavailableProgress.push(message); };
    expect((await runSelfImplement({ feature: 'F', seams: unavailable })).stage).toBe('pr-opened');
    expect(unavailableProgress).toContain('origin/main 충돌해결됨 — llm-resolved; 규모 변화: 못 쟀다 — 통합 결과 full 재-gate…');
  });

  test('llm-resolved(충돌해결) → full 재-gate·통과 시 PR (통합 리스크 큼)', async () => {
    const order: string[] = [];
    const gateContexts: Array<{ runId?: string } | undefined> = [];
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const r = await runSelfImplement({
        feature: 'F',
        seams: g2Seams({ mergeStatus: 'llm-resolved', gateResults: [true, true], order, gateContexts }),
      });
      expect(r.stage).toBe('pr-opened');
      expect(order).toEqual(['gate:true', 'commit', 'mergeMain', 'gate:true', 'openPr']); // full 재-gate 한 번
      expect(order.filter((step) => step.startsWith('gate:'))).toHaveLength(2);
      expect(gateContexts).toHaveLength(2);
      expect(gateContexts[0]?.runId).toBeString();
      expect(gateContexts[0]?.runId).not.toBe('');
      expect(gateContexts[1]?.runId).toBe(gateContexts[0]?.runId);
      expect(gateContexts[0]?.runId).toBe(r.runId);
      expect(events).toContainEqual(expect.objectContaining({
        event: 'gate.postsync',
        data: expect.objectContaining({ passed: true, mode: 'full', branch: expect.any(String), scopeReason: 'changed-tests' }),
      }));
      expect(events.filter((entry) => entry.event === 'gate.postsync')).toHaveLength(1);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('llm-resolved → full 재-gate 실패 시 gate-failed·draft PR 보존', async () => {
    const order: string[] = [];
    const r = await runSelfImplement({ feature: 'F', seams: g2Seams({ mergeStatus: 'llm-resolved', gateResults: [true, false], order }) });
    expect(r).toMatchObject({ stage: 'gate-failed', prUrl: expect.any(String) });
    expect(order).toContain('openPr');
  });

  test('llm-resolved 실패에서 자식 책임 없음은 면책을 보류하고 draft만 보존한다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const order: string[] = [];
      const s = g2Seams({ mergeStatus: 'llm-resolved', gateResults: [true, false], order });
      s.gate = async (_cwd, context) => context?.mode === 'postsync'
        ? { passed: false, log: 'baseline unavailable', reflectGateFacts: { introduced: 0, preexisting: 0, unknown: 1, childResponsibility: 'none' } }
        : { passed: true, log: 'ok' };
      const r = await runSelfImplement({ feature: 'F', autoMerge: true, seams: s });
      expect(r).toMatchObject({ ok: false, stage: 'gate-failed', node: 'regate', detail: 'gate failed after main-sync (conflict-resolved exemption withheld)' });
      expect(order).toContain('openPr');
      expect(order).not.toContain('mergePr');
      expect(events).toContainEqual(expect.objectContaining({
        event: 'gate.postsync',
        data: expect.objectContaining({ syncStatus: 'llm-resolved', childResponsibility: 'none', exempted: false, exemptionWithheld: true }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('llm-resolved 통과는 계속하고 면책 보류가 없음을 관측한다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const r = await runSelfImplement({ feature: 'F', seams: g2Seams({ mergeStatus: 'llm-resolved', gateResults: [true, true] }) });
      expect(r).toMatchObject({ ok: true, stage: 'pr-opened', node: 'open-pr' });
      expect(events).toContainEqual(expect.objectContaining({
        event: 'gate.postsync',
        data: expect.objectContaining({ syncStatus: 'llm-resolved', exempted: false, exemptionWithheld: false }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('llm-resolved 자식 책임 실패는 기존 통합 깨짐 사유로 draft만 보존한다', async () => {
    const order: string[] = [];
    const s = g2Seams({ mergeStatus: 'llm-resolved', gateResults: [true, false], order });
    s.gate = async (_cwd, context) => context?.mode === 'postsync'
      ? { passed: false, log: 'introduced failure', reflectGateFacts: { introduced: 1, preexisting: 0, unknown: 0 } }
      : { passed: true, log: 'ok' };
    const r = await runSelfImplement({ feature: 'F', autoMerge: true, seams: s });
    expect(r).toMatchObject({ ok: false, stage: 'gate-failed', node: 'regate', detail: 'gate failed after main-sync (conflict-resolved integration break)' });
    expect(order).toContain('openPr');
    expect(order).not.toContain('mergePr');
  });

  test('merged 실패에서 자식 책임 없음은 계속하고 실제 면책을 관측한다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const s = g2Seams({ mergeStatus: 'merged', gateResults: [true, false] });
      s.gate = async (_cwd, context) => context?.mode === 'postsync'
        ? { passed: false, log: 'baseline unavailable', reflectGateFacts: { introduced: 0, preexisting: 0, unknown: 1, childResponsibility: 'none' } }
        : { passed: true, log: 'ok' };
      const r = await runSelfImplement({ feature: 'F', seams: s });
      expect(r).toMatchObject({ ok: true, stage: 'pr-opened', node: 'open-pr' });
      expect(events).toContainEqual(expect.objectContaining({
        event: 'gate.postsync',
        data: expect.objectContaining({ syncStatus: 'merged', childResponsibility: 'none', exempted: true, exemptionWithheld: false }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('정합 후 재게이트는 postsync 모드로 호출되고 측정 파일 수·comparison base를 관측한다', async () => {
    const gateContexts: Array<{ runId?: string; mode?: 'postsync' } | undefined> = [];
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const r = await runSelfImplement({
        feature: 'F',
        seams: g2Seams({ mergeStatus: 'merged', gateResults: [true, true], gateContexts }),
      });
      expect(r.stage).toBe('pr-opened');
      expect(gateContexts[0]?.mode).toBeUndefined();
      expect(gateContexts[1]?.mode).toBe('postsync');
      expect(events).toContainEqual(expect.objectContaining({
        event: 'gate.postsync',
        data: expect.objectContaining({
          passed: true,
          mode: 'full',
          scopeReason: 'changed-tests',
          measuredFileCount: 3,
          comparisonBase: 'merge-base-sha',
        }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('작업 트리가 비어도 merge-base 변경 범위가 관측되면 postsync payload에 0이 아닌 수가 남는다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const s = g2Seams({ mergeStatus: 'merged', gateResults: [true, true] });
      s.gate = async (_cwd, ctx) => ctx?.mode === 'postsync'
        ? { passed: true, log: 'ok', scopeReason: 'no-related-tests', measuredFileCount: 2, comparisonBase: 'abc123def' }
        : { passed: true, log: 'ok', scopeReason: 'no-changes', measuredFileCount: 0 };
      const r = await runSelfImplement({ feature: 'F', seams: s });
      expect(r.stage).toBe('pr-opened');
      expect(events).toContainEqual(expect.objectContaining({
        event: 'gate.postsync',
        data: expect.objectContaining({
          passed: true,
          scopeReason: 'no-related-tests',
          measuredFileCount: 2,
          comparisonBase: 'abc123def',
        }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('빈 postsync 범위는 passed:false로 차단되고 측정 불가를 관측한다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const s = g2Seams({ mergeStatus: 'merged', gateResults: [true, false] });
      s.gate = async (_cwd, ctx) => ctx?.mode === 'postsync'
        ? { passed: false, log: 'unmeasured', scopeReason: 'unmeasured', measuredFileCount: 0, comparisonBase: 'abc123def' }
        : { passed: true, log: 'ok', scopeReason: 'no-changes', measuredFileCount: 0 };
      const r = await runSelfImplement({ feature: 'F', seams: s });
      expect(r).toMatchObject({ stage: 'gate-failed', node: 'regate' });
      expect(events).toContainEqual(expect.objectContaining({
        event: 'gate.postsync',
        data: expect.objectContaining({
          passed: false,
          scopeReason: 'unmeasured',
          measuredFileCount: 0,
          comparisonBase: 'abc123def',
        }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('타입 오류가 있는 통합 트리는 postsync 재게이트가 실패하고 차단 경로를 탄다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const s = g2Seams({ mergeStatus: 'merged', gateResults: [true, false] });
      s.gate = async (_cwd, ctx) => ctx?.mode === 'postsync'
        ? { passed: false, log: "src/broken.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.", scopeReason: 'no-related-tests', measuredFileCount: 1, comparisonBase: 'deadbeef' }
        : { passed: true, log: 'ok' };
      const r = await runSelfImplement({ feature: 'F', seams: s });
      expect(r).toMatchObject({ stage: 'gate-failed', node: 'regate', prUrl: expect.any(String) });
      expect(events).toContainEqual(expect.objectContaining({
        event: 'gate.postsync',
        data: expect.objectContaining({
          passed: false,
          scopeReason: 'no-related-tests',
          measuredFileCount: 1,
          comparisonBase: 'deadbeef',
        }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('mergeMain error 의 errorStep·errorDetail 을 pre-pr-sync 관측과 merge-conflict 진행 문면에 싣는다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const progress: string[] = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const s = g2Seams({ mergeStatus: 'error', gateResults: [true] });
      s.onProgress = ({ message }) => { progress.push(message); };
      s.mergeMain = async () => ({ status: 'error', errorStep: 'fetch', errorDetail: 'fatal: unable to access' });
      const r = await runSelfImplement({ feature: 'F', seams: s });
      expect(r).toMatchObject({ stage: 'merge-conflict', detail: 'pre-PR main sync error' });
      expect(events.find((entry) => entry.event === 'pre-pr-sync')?.data).toMatchObject({
        status: 'error',
        errorStep: 'fetch',
        errorDetail: 'fatal: unable to access',
      });
      expect(progress.join('\n')).toContain('정합 error (fetch)');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('commitWork/mergeMain seam 없으면 G2 skip(fail-safe·종전 동작)', async () => {
    const order: string[] = [];
    // g2Seams 에서 mergeMain/commitWork 제거
    const s = g2Seams({ mergeStatus: 'merged', gateResults: [true], order });
    delete (s as { mergeMain?: unknown }).mergeMain;
    delete (s as { commitWork?: unknown }).commitWork;
    const r = await runSelfImplement({ feature: 'F', seams: s });
    expect(r.stage).toBe('pr-opened');
    expect(order).toEqual(['gate:true', 'openPr']); // G2 미발동
  });
});

describe('runSelfImplement — loop-agent registry wiring', () => {
  test('registers the resolved worktree run as active and closes the same loopId as ended', async () => {
    const registrations: SelfImplementSeams['registerLoopAgent'] extends ((input: infer Input) => void) | undefined ? Input[] : never[] = [];
    const result = await runSelfImplement({
      feature: 'loop registry wiring',
      runId: 'run-loop-registry',
      goalId: 'goal-loop-registry',
      memory: false,
      seams: seams({ registerLoopAgent: (input) => { registrations.push(input); } }),
    });

    expect(result.ok).toBe(true);
    expect(registrations).toHaveLength(2);
    expect(registrations[0]).toMatchObject({
      loopId: 'self-implement:run-loop-registry',
      name: 'Self-implement: loop registry wiring',
      summary: 'Autonomous self-implement run run-loop-registry',
      loopKind: 'autonomous',
      lifecycle: 'ephemeral',
      missionId: 'goal-loop-registry',
      status: 'active',
    });
    expect(registrations[0]!.ttlMin).toBe(loopTtlMin({}));
    expect(registrations[1]).toMatchObject({ loopId: registrations[0]!.loopId, status: 'ended' });
  });

  test('registers a TTL matching actual rework implementation and gate timeout budgets', async () => {
    const registrations: SelfImplementSeams['registerLoopAgent'] extends ((input: infer Input) => void) | undefined ? Input[] : never[] = [];
    const stepTimeouts = { implement: 8_400_000, gate: 960_000, review: 600_000 };
    const observedTimeouts: Array<{ step: string; ms: number }> = [];
    let implementCalls = 0;
    let gateCalls = 0;
    const result = await runSelfImplement({
      feature: 'loop registry TTL rework',
      runId: 'run-loop-registry-ttl',
      maxReworkRounds: 1,
      stepTimeouts,
      memory: false,
      seams: seams({
        withStepTimeout: async (promise, ms, step) => {
          observedTimeouts.push({ step, ms });
          return promise;
        },
        gate: async () => {
          gateCalls++;
          return { passed: gateCalls === 2, log: gateCalls === 1 ? 'retry required' : 'ok' };
        },
        implement: async () => {
          implementCalls++;
          return { ok: true, summary: 'impl' };
        },
        registerLoopAgent: (input) => { registrations.push(input); },
      }),
    });

    const implementBudgets = observedTimeouts.filter(({ step }) => step === 'implement').map(({ ms }) => ms);
    const gateBudgets = observedTimeouts.filter(({ step }) => step === 'gate').map(({ ms }) => ms);
    const expectedTtlMin = Math.ceil((
      DEFAULT_STEP_TIMEOUTS.worktree + DEFAULT_STEP_TIMEOUTS.decomposition + DEFAULT_STEP_TIMEOUTS.merge + DEFAULT_STEP_TIMEOUTS.pr
      + implementBudgets.reduce((total, ms) => total + ms, 0)
      + gateBudgets.reduce((total, ms) => total + ms, 0)
      + (implementCalls * stepTimeouts.review)
    ) / 60_000);
    expect(result.ok).toBe(true);
    expect(implementCalls).toBe(2);
    expect(gateCalls).toBe(2);
    expect(implementBudgets).toEqual([stepTimeouts.implement, stepTimeouts.implement]);
    expect(gateBudgets).toEqual([stepTimeouts.gate, stepTimeouts.gate]);
    expect(registrations).toHaveLength(2);
    expect(registrations[0]!.ttlMin).toBe(expectedTtlMin);
    expect(registrations[1]).toMatchObject({ loopId: registrations[0]!.loopId, status: 'ended' });
  });

  test('keeps a successful run verdict when loop registry registration throws', async () => {
    const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
    const result = await runSelfImplement({
      feature: 'loop registry fail soft',
      runId: 'run-loop-registry-failure',
      memory: false,
      seams: seams({
        registerLoopAgent: () => { throw new Error('registry unavailable'); },
        writeRunLedger: (entry) => { ledger.push({ event: entry.event, data: entry.data }); },
      }),
    });

    expect(result.ok).toBe(true);
    expect(ledger.filter((entry) => entry.event === 'loop-agent-registration-failed')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({
        loopId: 'self-implement:run-loop-registry-failure', status: 'active', failureCount: 1, reason: 'registry unavailable',
      }) }),
      expect.objectContaining({ data: expect.objectContaining({
        loopId: 'self-implement:run-loop-registry-failure', status: 'ended', failureCount: 2, reason: 'registry unavailable',
      }) }),
    ]);
  });
});

describe('B 근본수리 — 단계 wall-clock 가드(6h 좀비 차단·관측·자기인지·힐링)', () => {
  test('preserves every default step timeout except the two-hour implement cap', () => {
    expect(DEFAULT_STEP_TIMEOUTS).toEqual({
      worktree: 90_000,
      implement: 7_200_000,
      gate: 900_000,
      review: 480_000,
      merge: 480_000,
      pr: 300_000,
      decomposition: 30_000,
    });
  });

  test('withStepTimeout — 상한 초과 시 StepTimeoutError(어느 step 인지 실림)', async () => {
    const hang = new Promise<number>(() => {}); // 영원히 pending
    let caught: unknown;
    try { await withStepTimeout(hang, 30, 'review'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(StepTimeoutError);
    expect((caught as StepTimeoutError).step).toBe('review');
    expect((caught as StepTimeoutError).ms).toBe(30);
  });

  test('withStepTimeout — 정상 완료면 값 그대로(false-trigger 없음)', async () => {
    expect(await withStepTimeout(Promise.resolve(42), 1000, 'gate')).toBe(42);
  });

  test('hang 하는 seam(gate) → timed-out 로 정직 종결(무한대기 아님)', async () => {
    const r = await runSelfImplement({
      feature: 'F',
      stepTimeouts: { gate: 40 },
      seams: seams({ gate: () => new Promise(() => {}) as Promise<{ passed: boolean }> }),
    });
    expect(r.stage).toBe('timed-out');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('gate');   // 어느 단계가 끊겼나 = 자기인지
    expect(r.worktreePath).toStartWith('/wt/self-impl/f-');
    expect(r.detail).toContain('worktree 회수 경로: /wt/self-impl/f');
    expect(r.detail).not.toContain('보존');
  });

  test('worktree seam hang → timed-out 에 worktreePath 없음(생성 전은 보존 단정 금지)', async () => {
    const r = await runSelfImplement({
      feature: 'F',
      stepTimeouts: { worktree: 40 },
      seams: seams({ createWorktree: () => new Promise(() => {}) as Promise<never> }),
    });
    expect(r.stage).toBe('timed-out');
    expect(r.worktreePath).toBeUndefined();
    expect(r.detail).toContain('worktree 생성 전');
    expect(r.detail).not.toContain('보존');
  });

  test('review seam hang → timed-out(step=review)', async () => {
    const r = await runSelfImplement({
      feature: 'F',
      stepTimeouts: { review: 40 },
      seams: seams({ reviewDiff: () => new Promise(() => {}) as Promise<never> }),
    });
    expect(r.stage).toBe('timed-out');
    expect(r.detail).toContain('review');
  });

  test('auto-approved merge decision followed by main-sync timeout is merge-approved-abandoned, not implementation-deficit', async () => {
    const s = revSeams({ reviews: [{ verdict: 'pass', reviewed: true }] });
    let regates = 0;
    let opened = 0;
    const originalGate = s.gate;
    s.gate = async (...args) => { regates++; return originalGate(...args); };
    s.openPr = async () => { opened++; return { url: 'https://pr/unexpected', number: 42 }; };
    s.commitWork = () => {};
    s.mergeMain = () => new Promise(() => {}) as Promise<never>;
    const r = await runSelfImplement({ feature: 'F', autoMerge: true, stepTimeouts: { merge: 40 }, seams: s });
    expect(regates).toBe(1);
    expect(opened).toBe(0);
    expect(r).toMatchObject({
      stage: 'timed-out',
      mergeApprovalReceived: true,
      abandonedClassification: expect.objectContaining({
        classification: 'merge-approved-abandoned',
        mergeApprovalReceived: true,
      }),
    });
  });
});

describe('runSelfImplement — 리뷰 컨텍스트 주입(Facet B)', () => {
  const shardedFeature = (feature: string): string => `${feature}\n\n## Shard identity\n${JSON.stringify({ shardId: 'current-shard', totalShards: 2, position: 1, siblings: [{ shardId: 'current-shard' }, { shardId: 'sibling-shard' }] })}`;

  test.each([
    [{ pieceTotal: 1 }, false],
    [{ pieceTotal: 2 }, true],
  ])('shard sibling lookup eligibility is %s → %s', (shardIdentity, expected) => {
    expect(isShardSiblingLookupEligible(shardIdentity)).toBe(expected);
  });

  test('reviewDiff 에 goal(등가계약) 컨텍스트를 주입한다', async () => {
    let seenGoal: string | undefined;
    const s = seams({
      reviewDiff: async (_cwd: string, ctx?: { goal?: string }) => {
        seenGoal = ctx?.goal;
        return { verdict: 'pass' as const, mustFix: [], shouldFix: [], summary: 's', reviewed: true };
      },
    });
    await runSelfImplement({ feature: 'MY_GOAL_XYZ_TOKEN', seams: s });
    expect(seenGoal).toBe('MY_GOAL_XYZ_TOKEN');
  });

  test('production review adapter sends ledger goal provenance only as evidence and preserves unknown provenance', async () => {
    const prompts: string[] = [];
    const knownGoalId = 'a1b2c3d4e5f60718';
    const goalDocumentPath = resolve(process.cwd(), 'docs/goals/GOAL-harness-authored.md');
    const section = (prompt: string, heading: string): string | undefined => {
      const start = prompt.indexOf(`${heading}\n`);
      if (start < 0) return undefined;
      const bodyStart = start + heading.length + 1;
      const next = prompt.indexOf('\n## ', bodyStart);
      return prompt.slice(bodyStart, next < 0 ? undefined : next);
    };
    const provenanceIsEvidenceOnly = (prompt: string): boolean => {
      const intent = section(prompt, '## Phase intent');
      const evidence = section(prompt, '## Evidence');
      return Boolean(evidence?.includes(goalDocumentPath) && !intent?.includes(goalDocumentPath));
    };
    const production = defaultSeams({
      reviewScopeDiff: async () => 'diff --git a/src/example.ts b/src/example.ts\n+const changed = true;',
      llmReview: async (prompt) => {
        prompts.push(prompt);
        return 'VERDICT: PASS\nSUMMARY: reviewed';
      },
    });
    const store = new GoalRunStore();
    try {
      store.insert(goalDocumentPath, { runId: 'prior-ledger-run', stage: 'pr-opened', outcome: 'completed', ok: true }, knownGoalId);
    } finally {
      store.close();
    }

    const known = seams({});
    known.reviewDiff = production.reviewDiff;
    known.goalDocumentPathByGoalId = production.goalDocumentPathByGoalId;
    await runSelfImplement({ feature: 'known provenance goal', goalId: knownGoalId, runId: 'known-review-run', seams: known });

    const unknown = seams({});
    unknown.reviewDiff = production.reviewDiff;
    unknown.goalDocumentPathByGoalId = production.goalDocumentPathByGoalId;
    await runSelfImplement({ feature: 'unknown provenance goal', goalId: 'ffffffffffffffff', runId: 'unknown-review-run', seams: unknown });

    const unavailable = seams({});
    unavailable.reviewDiff = production.reviewDiff;
    unavailable.goalDocumentPathByGoalId = () => { throw new Error('ledger unavailable'); };
    await runSelfImplement({ feature: 'unavailable provenance goal', goalId: 'eeeeeeeeeeeeeeee', runId: 'unavailable-review-run', seams: unavailable });

    expect(prompts).toHaveLength(3);
    expect(provenanceIsEvidenceOnly(prompts[0]!)).toBe(true);
    expect(section(prompts[0]!, '## Phase intent')).toContain('known-review-run');
    const mutatedIntent = prompts[0]!.replace('known provenance goal', `known provenance goal\n${goalDocumentPath}`);
    expect(provenanceIsEvidenceOnly(mutatedIntent)).toBe(false);
    expect(section(prompts[1]!, '## Phase intent')).toContain('unknown-review-run');
    expect(section(prompts[2]!, '## Phase intent')).toContain('unavailable-review-run');
    for (const prompt of prompts.slice(1)) {
      expect(prompt).not.toContain('Harness-authored goal document path');
      expect(prompt).not.toContain(goalDocumentPath);
    }
  });

  test('does not query shard siblings when review is not configured or the child is in round zero', async () => {
    let calls = 0;
    await runSelfImplement({
      feature: 'no sibling consumer',
      runId: 'current-run',
      seams: seams({ queryRunChain: () => { calls++; return { entries: [] }; } }),
    });
    expect(calls).toBe(0);
  });

  test('unsharded review skips the ledger query and records why', async () => {
    const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
    let calls = 0;
    await runSelfImplement({
      feature: 'unsharded review context',
      runId: 'unsharded-run',
      seams: seams({
        writeRunLedger: (entry) => ledger.push(entry),
        queryRunChain: () => { calls++; return { entries: [] }; },
        reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 's', reviewed: true }),
      }),
    });
    expect(calls).toBe(0);
    expect(ledger).toContainEqual(expect.objectContaining({ event: 'shard-sibling-query', data: expect.objectContaining({ purpose: 'review-context', status: 'skipped', reason: 'not-sharded', pieceTotal: 1 }) }));
  });

  test('producer-computed shard siblings reach the initial review unchanged and marked untruncated', async () => {
    let seen: ReviewDiffContext | undefined;
    let calls = 0;
    await runSelfImplement({
      feature: shardedFeature('sibling context'),
      runId: 'current-run',
      seams: seams({
        queryRunChain: () => {
          calls++;
          return { entries: [{ runId: 'current-run', shardSiblings: [
            { runId: 'sibling-0', shardId: 'shard-0', pieceIndex: 0 },
            { runId: 'sibling-2', shardId: 'shard-2', pieceIndex: 2 },
          ] }] };
        },
        reviewDiff: async (_cwd, context) => {
          seen = context;
          return { verdict: 'pass', mustFix: [], shouldFix: [], summary: 's', reviewed: true };
        },
      }),
    });
    expect(calls).toBe(1);
    expect(seen?.shardSiblings).toEqual({
      items: [
        { runId: 'sibling-0', shardId: 'shard-0', pieceIndex: 0 },
        { runId: 'sibling-2', shardId: 'shard-2', pieceIndex: 2 },
      ],
      shownItems: 2,
      totalItems: 2,
      omittedItems: 0,
      truncated: false,
    });
  });

  test('bounds sibling identifiers by code points while preserving item order and count metadata', async () => {
    let seen: ReviewDiffContext | undefined;
    const exact = 'a'.repeat(160);
    const longUnicode = '😀'.repeat(161);
    const siblings = [
      { runId: exact, shardId: exact, pieceIndex: 0 },
      { runId: longUnicode, shardId: longUnicode, pieceIndex: 1 },
      ...Array.from({ length: 15 }, (_, pieceIndex) => ({ runId: `later-${pieceIndex}`, shardId: `later-${pieceIndex}`, pieceIndex: pieceIndex + 2 })),
    ];
    await runSelfImplement({
      feature: shardedFeature('bounded sibling identifiers'),
      runId: 'current-run',
      seams: seams({
        queryRunChain: () => ({ entries: [{ runId: 'current-run', shardSiblings: siblings }] }),
        reviewDiff: async (_cwd, context) => {
          seen = context;
          return { verdict: 'pass', mustFix: [], shouldFix: [], summary: 's', reviewed: true };
        },
      }),
    });
    const projection = seen!.shardSiblings!;
    expect(projection).toMatchObject({ shownItems: 16, totalItems: 17, omittedItems: 1, truncated: true });
    expect(projection.items.map((sibling) => sibling.pieceIndex)).toEqual(Array.from({ length: 16 }, (_, index) => index));
    expect(projection.items[0]).toMatchObject({ runId: exact, shardId: exact });
    expect(Array.from(projection.items[1]!.runId)).toHaveLength(160);
    expect(Array.from(projection.items[1]!.shardId!)).toHaveLength(160);
    expect(projection.items[1]).toMatchObject({ runId: `${'😀'.repeat(159)}…`, shardId: `${'😀'.repeat(159)}…` });
  });

  test('sharded review distinguishes an empty lookup from a failed lookup without stopping review', async () => {
    for (const [name, queryRunChain, status] of [
      ['empty', () => ({ entries: [{ runId: 'current-run', shardSiblings: [] }] }), 'succeeded-without-siblings'],
      ['failure', () => { throw new Error('ledger unavailable'); }, 'failed'],
    ] as const) {
      const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
      let reviewed = false;
      const result = await runSelfImplement({
        feature: shardedFeature(`shard lookup ${name}`),
        runId: 'current-run',
        seams: seams({
          writeRunLedger: (entry) => ledger.push(entry),
          queryRunChain,
          reviewDiff: async (_cwd, context) => {
            reviewed = true;
            expect(context?.shardSiblings).toBeUndefined();
            return { verdict: 'pass', mustFix: [], shouldFix: [], summary: 's', reviewed: true };
          },
        }),
      });
      expect(result.ok).toBe(true);
      expect(reviewed).toBe(true);
      expect(ledger).toContainEqual(expect.objectContaining({ event: 'shard-sibling-query', data: expect.objectContaining({ purpose: 'review-context', status, pieceTotal: 2 }) }));
    }
  });

  test('unsharded rework skips the sibling ledger query while preserving the later-round gate', async () => {
    const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
    let calls = 0;
    let reviewCalls = 0;
    await runSelfImplement({
      feature: 'unsharded rework context',
      runId: 'unsharded-rework-run',
      maxReworkRounds: 1,
      seams: seams({
        writeRunLedger: (entry) => ledger.push(entry),
        queryRunChain: () => { calls++; return { entries: [] }; },
        reviewDiff: async () => ++reviewCalls === 1
          ? { verdict: 'fail', mustFix: ['repair'], shouldFix: [], summary: 'first', reviewed: true }
          : { verdict: 'pass', mustFix: [], shouldFix: [], summary: 'second', reviewed: true },
      }),
    });
    expect(reviewCalls).toBe(2);
    expect(calls).toBe(0);
    expect(ledger).toContainEqual(expect.objectContaining({ event: 'shard-sibling-query', data: expect.objectContaining({ purpose: 'rework-context', status: 'skipped', reason: 'not-sharded', pieceTotal: 1 }) }));
  });

  test('unsharded run leaves sibling context absent rather than unknown', async () => {
    let seen: ReviewDiffContext | undefined;
    await runSelfImplement({
      feature: 'unsharded context',
      runId: 'unsharded-run',
      seams: seams({
        queryRunChain: () => ({ entries: [{ runId: 'unsharded-run', shardSiblings: [] }] }),
        reviewDiff: async (_cwd, context) => {
          seen = context;
          return { verdict: 'pass', mustFix: [], shouldFix: [], summary: 's', reviewed: true };
        },
      }),
    });
    expect(seen).toBeDefined();
    expect(seen?.shardSiblings).toBeUndefined();
  });

  test('every rework review receives the bounded producer sibling projection with explicit truncation', async () => {
    const contexts: ReviewDiffContext[] = [];
    let reviewCall = 0;
    const siblings = Array.from({ length: 17 }, (_, pieceIndex) => ({ runId: `sibling-${pieceIndex}`, shardId: `shard-${pieceIndex}`, pieceIndex }));
    await runSelfImplement({
      feature: shardedFeature('bounded sibling context'),
      runId: 'bounded-run',
      maxReworkRounds: 1,
      seams: seams({
        queryRunChain: () => ({ entries: [{ runId: 'bounded-run', shardSiblings: siblings }] }),
        reviewDiff: async (_cwd, context) => {
          contexts.push(context!);
          return ++reviewCall === 1
            ? { verdict: 'fail', mustFix: ['repair'], shouldFix: [], summary: 'first', reviewed: true }
            : { verdict: 'pass', mustFix: [], shouldFix: [], summary: 'second', reviewed: true };
        },
      }),
    });
    expect(contexts).toHaveLength(2);
    for (const context of contexts) {
      expect(context.shardSiblings).toMatchObject({ shownItems: 16, totalItems: 17, omittedItems: 1, truncated: true });
      expect(context.shardSiblings?.items.map((sibling) => sibling.pieceIndex)).toEqual(Array.from({ length: 16 }, (_, index) => index));
    }
  });
  test('passes only merged sibling PRs to later implementation rounds with bounded metadata', async () => {
    const contexts: Array<Record<string, unknown>> = [];
    let calls = 0;
    await runSelfImplement({
      feature: shardedFeature('landed sibling context'),
      runId: 'current-run',
      maxReworkRounds: 1,
      seams: seams({
        queryRunChain: () => ({ entries: [
          { runId: 'current-run', shardSiblings: Array.from({ length: 18 }, (_, pieceIndex) => ({ runId: `sibling-${pieceIndex}`, shardId: `shard-${pieceIndex}`, pieceIndex })) },
          ...Array.from({ length: 18 }, (_, pieceIndex) => ({ runId: `sibling-${pieceIndex}`, prNumber: pieceIndex + 100, merged: pieceIndex !== 1, shardSiblings: [] })),
        ] }),
        implement: async (context) => {
          contexts.push(context as unknown as Record<string, unknown>);
          return { ok: true, summary: 'implemented' };
        },
        reviewDiff: async () => ++calls === 1
          ? { verdict: 'fail', mustFix: ['repair'], shouldFix: [], summary: 'first', reviewed: true }
          : { verdict: 'pass', mustFix: [], shouldFix: [], summary: 'second', reviewed: true },
      }),
    });
    expect(contexts[0]!.roundContext).toBeUndefined();
    expect(contexts[1]!.roundContext).toMatchObject({
      round: 1,
      landedSiblings: { shownItems: 16, totalItems: 17, omittedItems: 1, truncated: true },
    });
    expect((contexts[1]!.roundContext as { landedSiblings: { items: Array<{ prNumber: number }> } }).landedSiblings.items).not.toContainEqual(expect.objectContaining({ prNumber: 101 }));
  });

  test('does not add landed sibling context when siblings are absent or unmerged', async () => {
    const contexts: Array<Record<string, unknown>> = [];
    let calls = 0;
    await runSelfImplement({
      feature: shardedFeature('unlanded sibling context'),
      runId: 'current-run',
      maxReworkRounds: 1,
      seams: seams({
        queryRunChain: () => ({ entries: [
          { runId: 'current-run', shardSiblings: [{ runId: 'sibling-1', shardId: 'shard-1', pieceIndex: 1 }] },
          { runId: 'sibling-1', prNumber: 123, merged: false, shardSiblings: [] },
        ] }),
        implement: async (context) => {
          contexts.push(context as unknown as Record<string, unknown>);
          return { ok: true, summary: 'implemented' };
        },
        reviewDiff: async () => ++calls === 1
          ? { verdict: 'fail', mustFix: ['repair'], shouldFix: [], summary: 'first', reviewed: true }
          : { verdict: 'pass', mustFix: [], shouldFix: [], summary: 'second', reviewed: true },
      }),
    });
    expect(contexts[1]!.roundContext).toEqual(expect.objectContaining({ round: 1, effectiveMax: 1 }));
    expect(contexts[1]!.roundContext).not.toHaveProperty('landedSiblings');
  });
});

describe('runSelfImplement — 반사-기각(Facet C)', () => {
  function captureRunEvents(): {
    events: Array<{ event: string; data: Record<string, unknown>; level?: string }>;
    restore: () => void;
  } {
    const original = (debug as { log: typeof debug.log }).log;
    const events: Array<{ event: string; data: Record<string, unknown>; level?: string }> = [];
    (debug as { log: typeof debug.log }).log = ((_category, event, data, opt) => {
      events.push({ event, data: data as Record<string, unknown>, level: opt?.level });
    }) as typeof debug.log;
    return { events, restore: () => { (debug as { log: typeof debug.log }).log = original; } };
  }

  test('must-fix 전부 rejected → rework 없이 수렴(verdict warn·mustFix clear·기각 shouldFix 감사기록)', async () => {
    const features: string[] = [];
    const s = seams({
      features,
      // reviewed:true 면 실제 리뷰어는 예산도 함께 낸다(위 목 주석 참조 · #5557 자동병합 조건).
      reviewDiff: async () => ({ verdict: 'fail' as const, mustFix: ['등가계약 밖 지적'], shouldFix: [], summary: 's', reviewed: true, diffTruncated: false, diffShownChars: 100, diffTotalChars: 100, diffOmittedFiles: 0 }),
      reflectMustFix: async ({ mustFix }) => ({ accepted: [], rejected: mustFix.map((item) => ({ item, reason: '등가계약 밖' })) }),
    });
    const r = await runSelfImplement({ feature: 'F', maxReworkRounds: 2, seams: s });
    expect(r.stage).toBe('pr-opened');        // 수렴 → 병합결정(review-blocked 아님)
    expect(features.length).toBe(1);           // rework 없음 — 반사가 계약 밖 잡음을 끊음
    expect(r.review?.verdict).toBe('warn');    // fail→warn 강등(머지 가능·auto 는 --auto-merge 시만)
    expect(r.review?.mustFix).toEqual([]);     // must-fix clear
    expect(r.review?.shouldFix.some((x) => x.includes('reflect-rejected'))).toBe(true); // 몰래 안 버림
  });

  test('⭐ 반사 기각이 «사람 산출»에 나온다 — 전부 기각이면 자동 병합 «바로 앞»에 fail→warn 을 적는다', async () => {
    // ⛔ 이 단언이 없으면 「값은 원장에 있는데 사람에겐 안 보인다」가 조용히 되돌아온다(2026-08-12 [S] 제보).
    const progress: string[] = [];
    const s = seams({
      reviewDiff: async () => ({ verdict: 'fail' as const, mustFix: ['등가계약 밖 지적'], shouldFix: [], summary: 's', reviewed: true, diffTruncated: false, diffShownChars: 100, diffTotalChars: 100, diffOmittedFiles: 0 }),
      // ⭐ 사유에 «개행»을 넣는다 — 진행 줄이 한 줄이어야 한다는 계약을 이 입력이 문다
      reflectMustFix: async ({ mustFix }) => ({ accepted: [], rejected: mustFix.map((item) => ({ item, reason: '등가계약\n  밖이다' })) }),
      onProgress: ({ message }) => { progress.push(message); },
    });
    const r = await runSelfImplement({ feature: 'F', maxReworkRounds: 2, seams: s });
    expect(r.review?.verdict).toBe('warn');
    const reflectLine = progress.find((m) => m.startsWith('반사 기각'));
    expect(reflectLine).toBe('반사 기각 1건 · 남은 must-fix 0건 — 기각: 등가계약 밖 지적 ← 등가계약 밖이다');
    expect(reflectLine).toContain('등가계약 밖 지적');
    expect(reflectLine).not.toContain('\n');
    const downgradeIndex = progress.findIndex((m) => m.includes('fail → warn'));
    expect(downgradeIndex).toBeGreaterThanOrEqual(0);
    // ⭐ 「왜 병합되나」의 답이 병합 줄 «앞»에 있어야 한다
    // ⛔⭐ 「왜 병합되나」의 답이 ***다음 단계 «바로 앞»***이어야 한다 — 사이에 다른 줄이 끼면 깨진다.
    //   ⚠️ 이 심에는 `--auto-merge` 가 없어 다음 단계가 「PR 생성…」이다(실측). 둘 다 문다.
    expect(progress[downgradeIndex + 1]).toMatch(/^(PR 생성…|자동 병합)/);
    expect(progress.filter((m) => m.startsWith('반사 기각'))).toHaveLength(1);
  });

  test('일부만 reject → 사람 산출에 «남은 수»가 보이고 rejected 는 재주입 안 함', async () => {
    const progress: string[] = [];
    let reviewCall = 0;
    const s = seams({
      reviewDiff: async () => {
        reviewCall++;
        return reviewCall === 1
          ? { verdict: 'fail' as const, mustFix: ['진짜 버그', '가짜 지적'], shouldFix: [], summary: 's', reviewed: true }
          : { verdict: 'pass' as const, mustFix: [], shouldFix: [], summary: 's', reviewed: true };
      },
      reflectMustFix: async () => ({ accepted: ['진짜 버그'], rejected: [{ item: '가짜 지적', reason: '무관' }] }),
      onProgress: ({ message }) => { progress.push(message); },
    });
    await runSelfImplement({ feature: 'F', maxReworkRounds: 2, seams: s });
    expect(progress).toContain('반사 기각 1건 · 남은 must-fix 1건 — 기각: 가짜 지적 ← 무관');
    // ⛔ 부분 기각은 «강등이 아니다» — 그 줄은 나오면 안 된다
    expect(progress.some((m) => m.includes('fail → warn'))).toBe(false);
  });

  test('여러 반사 기각은 item을 사유보다 먼저 두고 각각 공백을 한 줄로 접는다', async () => {
    const progress: string[] = [];
    const s = seams({
      reviewDiff: async () => ({ verdict: 'fail' as const, mustFix: ['첫  고유\n지적', '둘째\t고유 지적'], shouldFix: [], summary: 's', reviewed: true }),
      reflectMustFix: async ({ mustFix }) => ({
        accepted: [],
        rejected: [
          { item: mustFix[0]!, reason: '첫  사유\n내용' },
          { item: mustFix[1]!, reason: '둘째\t사유 내용' },
        ],
      }),
      onProgress: ({ message }) => { progress.push(message); },
    });

    await runSelfImplement({ feature: 'F', maxReworkRounds: 2, seams: s });

    expect(progress).toContain('반사 기각 2건 · 남은 must-fix 0건 — 기각: 첫 고유 지적 ← 첫 사유 내용 / 기각: 둘째 고유 지적 ← 둘째 사유 내용');
  });

  test('canonical finding-key로 반복 must-fix를 두 반사 경로에만 조립하고 occurrence·observedRounds를 보존한다', async () => {
    const finding = '첫 리뷰의 `src/example.ts` 누락';
    const equivalentFinding = '둘째 리뷰의 `src/example.ts` 누락';
    const unmatched = '다른 `src/other.ts` 지적';
    const reflected: Array<{ mustFix: string[]; recurrenceHistory?: unknown }> = [];
    let reviewCall = 0;
    let implementation = 0;
    const result = await runSelfImplement({
      feature: 'recurrence reflect forwarding\n- Checkable requested criterion: recurrence',
      maxReworkRounds: 2,
      seams: seams({
        implement: async () => ({ ok: true, summary: ++implementation === 2
          ? `REFUTE [${stableMustFixId(finding)}] ${JSON.stringify('- Checkable requested criterion: recurrence')} — repeated finding.`
          : 'initial' }),
        reviewDiff: async () => {
          reviewCall++;
          return reviewCall === 1
            ? { verdict: 'fail' as const, mustFix: [finding], shouldFix: [], summary: 'first', reviewed: true }
            : reviewCall === 2
              ? { verdict: 'fail' as const, mustFix: [equivalentFinding, unmatched], shouldFix: [], summary: 'second', reviewed: true }
              : { verdict: 'pass' as const, mustFix: [], shouldFix: [], summary: 'done', reviewed: true };
        },
        reflectMustFix: async (input) => {
          reflected.push({ mustFix: [...input.mustFix], recurrenceHistory: input.recurrenceHistory });
          return { accepted: [...input.mustFix], rejected: [] };
        },
      }),
    });

    expect(result.stage).toBe('pr-opened');
    const repeatedHistory = [{ findingId: stableMustFixId(equivalentFinding), occurrence: 1, observedRounds: [0, 1] }];
    expect(reflected).toContainEqual({ mustFix: [equivalentFinding, unmatched], recurrenceHistory: repeatedHistory });
    expect(reflected).toContainEqual({
      mustFix: [finding],
      recurrenceHistory: [{ findingId: stableMustFixId(finding), occurrence: 1, observedRounds: [0, 1] }],
    });
    expect(reflected.find((input) => input.mustFix.includes(unmatched))?.recurrenceHistory).not.toContainEqual(expect.objectContaining({ findingId: stableMustFixId(unmatched) }));
    expect(reflected[0]!.recurrenceHistory).toBeUndefined();
  });

  test('공용 심볼 겹침으로 산문이 다른 must-fix의 반복 이력을 반사자에게 전달한다', async () => {
    const first = '첫 지적: `src/shared.ts`의 계약 누락';
    const repeated = '둘째 지적: `src/shared.ts`의 오류 경로 누락';
    const reflected: Array<{ mustFix: string[]; recurrenceHistory?: unknown }> = [];
    let reviewCall = 0;
    await runSelfImplement({
      feature: 'symbol-overlap recurrence',
      maxReworkRounds: 2,
      seams: seams({
        reviewDiff: async () => ++reviewCall === 1
          ? { verdict: 'fail' as const, mustFix: [first], shouldFix: [], summary: 'first', reviewed: true }
          : reviewCall === 2
            ? { verdict: 'fail' as const, mustFix: [repeated], shouldFix: [], summary: 'second', reviewed: true }
            : { verdict: 'pass' as const, mustFix: [], shouldFix: [], summary: 'done', reviewed: true },
        reflectMustFix: async (input) => {
          reflected.push({ mustFix: [...input.mustFix], recurrenceHistory: input.recurrenceHistory });
          return { accepted: [...input.mustFix], rejected: [] };
        },
      }),
    });
    expect(reflected).toContainEqual({
      mustFix: [repeated],
      recurrenceHistory: [{ findingId: stableMustFixId(repeated), occurrence: 1, observedRounds: [0, 1] }],
    });
  });

  test('비추이적 심볼 겹침은 연결된 세 라운드를 하나의 반복 이력으로 귀속한다', async () => {
    const first = '첫 지적 `src/a.ts`';
    const bridge = '가교 지적 `src/a.ts`와 `src/b.ts`';
    const last = '마지막 지적 `src/b.ts`';
    const reflected: Array<{ mustFix: string[]; recurrenceHistory?: unknown }> = [];
    let reviewCall = 0;
    await runSelfImplement({
      feature: 'non-transitive symbol-overlap recurrence',
      maxReworkRounds: 3,
      seams: seams({
        reviewDiff: async () => {
          reviewCall++;
          const finding = [first, bridge, last][reviewCall - 1];
          return finding
            ? { verdict: 'fail' as const, mustFix: [finding], shouldFix: [], summary: `round ${reviewCall}`, reviewed: true }
            : { verdict: 'pass' as const, mustFix: [], shouldFix: [], summary: 'done', reviewed: true };
        },
        reflectMustFix: async (input) => {
          reflected.push({ mustFix: [...input.mustFix], recurrenceHistory: input.recurrenceHistory });
          return { accepted: [...input.mustFix], rejected: [] };
        },
      }),
    });
    expect(reflected).toContainEqual({
      mustFix: [last],
      recurrenceHistory: [{ findingId: stableMustFixId(last), occurrence: 2, observedRounds: [0, 1, 2] }],
    });
  });

  test('같은 라운드의 가교 심볼 지적이 독립 그룹을 합쳐도 중복 라운드를 반복으로 오인하지 않는다', async () => {
    const left = '왼쪽 지적 `src/a.ts`';
    const right = '오른쪽 지적 `src/b.ts`';
    const bridge = '가교 지적 `src/a.ts`와 `src/b.ts`';
    const reflected: Array<{ mustFix: string[]; recurrenceHistory?: unknown }> = [];
    await runSelfImplement({
      feature: 'same-round bridge does not recur',
      maxReworkRounds: 1,
      seams: seams({
        reviewDiff: async () => ({ verdict: 'fail' as const, mustFix: [left, right, bridge], shouldFix: [], summary: 'one round', reviewed: true }),
        reflectMustFix: async (input) => {
          reflected.push({ mustFix: [...input.mustFix], recurrenceHistory: input.recurrenceHistory });
          return { accepted: [...input.mustFix], rejected: [] };
        },
      }),
    });
    expect(reflected).toContainEqual({ mustFix: [left, right, bridge], recurrenceHistory: undefined });
  });

  test('trimmed recurrence lookup forwards history for whitespace-padded repeated finding', async () => {
    const finding = '반복 `src/shared.ts` 지적';
    const reflected: Array<{ mustFix: string[]; recurrenceHistory?: unknown }> = [];
    let reviewCall = 0;
    await runSelfImplement({
      feature: 'trimmed recurrence lookup',
      maxReworkRounds: 2,
      seams: seams({
        reviewDiff: async () => ++reviewCall === 1
          ? { verdict: 'fail' as const, mustFix: [finding], shouldFix: [], summary: 'first', reviewed: true }
          : reviewCall === 2
            ? { verdict: 'fail' as const, mustFix: [`  ${finding}  `], shouldFix: [], summary: 'second', reviewed: true }
            : { verdict: 'pass' as const, mustFix: [], shouldFix: [], summary: 'done', reviewed: true },
        reflectMustFix: async (input) => {
          reflected.push({ mustFix: [...input.mustFix], recurrenceHistory: input.recurrenceHistory });
          return { accepted: [...input.mustFix], rejected: [] };
        },
      }),
    });
    expect(reflected).toContainEqual({
      mustFix: [`  ${finding}  `],
      recurrenceHistory: [{ findingId: stableMustFixId(`  ${finding}  `), occurrence: 1, observedRounds: [0, 1] }],
    });
  });

  test('인용 없는 지적 비교는 비교불가·런 신원으로 관측되고 반복 이력으로 넘기지 않는다', async () => {
    const first = '첫 산문 지적';
    const second = '둘째 산문 지적';
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
    const reflected: Array<{ mustFix: string[]; recurrenceHistory?: unknown }> = [];
    const original = debug.log;
    let reviewCall = 0;
    const s = seams({
      reviewDiff: async () => ++reviewCall === 1
        ? { verdict: 'fail' as const, mustFix: [first], shouldFix: [], summary: 'first', reviewed: true }
        : reviewCall === 2
          ? { verdict: 'fail' as const, mustFix: [second], shouldFix: [], summary: 'second', reviewed: true }
          : { verdict: 'pass' as const, mustFix: [], shouldFix: [], summary: 'done', reviewed: true },
      reflectMustFix: async (input) => {
        reflected.push({ mustFix: [...input.mustFix], recurrenceHistory: input.recurrenceHistory });
        return { accepted: [...input.mustFix], rejected: [] };
      },
    });
    s.writeRunLedger = (entry) => { ledger.push({ event: entry.event, data: entry.data }); };
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ category, event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await runSelfImplement({
        feature: 'unmeasurable recurrence',
        runId: 'recurrence-observation-run',
        maxReworkRounds: 2,
        seams: s,
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(reflected.find((input) => input.mustFix.includes(second))?.recurrenceHistory).toBeUndefined();
    const comparisons = events.filter(({ event }) => event === 'recurrence-comparison');
    expect(comparisons).toHaveLength(1);
    expect(comparisons[0]).toMatchObject({
      category: 'self-dev.rework',
      data: {
        round: 1,
        recurrencePredicate: 'comparable-with-shared-symbol',
        comparable: false,
        sharedSymbolCount: 0,
        runId: 'recurrence-observation-run',
      },
    });
    expect(comparisons[0]!.data).toHaveProperty('overlapRatio', undefined);
    expect(comparisons[0]!.data).not.toHaveProperty('goalId');
    expect(ledger.filter(({ event }) => event === 'recurrence-comparison')).toEqual([
      { event: 'recurrence-comparison', data: comparisons[0]!.data },
    ]);
  });

  test('recurrence comparisons preserve their payload and join the run ledger by run and goal identity', async () => {
    const finding = '반복 `src/shared.ts` 지적';
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    let reviewCall = 0;
    const s = seams({
      reviewDiff: async () => ++reviewCall === 1
        ? { verdict: 'fail' as const, mustFix: [finding], shouldFix: [], summary: 'first', reviewed: true }
        : reviewCall === 2
          ? { verdict: 'fail' as const, mustFix: [finding], shouldFix: [], summary: 'second', reviewed: true }
          : { verdict: 'pass' as const, mustFix: [], shouldFix: [], summary: 'done', reviewed: true },
    });
    s.writeRunLedger = (entry) => { ledger.push({ event: entry.event, data: entry.data }); };
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ category, event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await runSelfImplement({
        feature: 'recurrence observation identity join',
        runId: 'recurrence-observation-run',
        goalId: 'recurrence-observation-goal',
        maxReworkRounds: 2,
        seams: s,
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    const comparisons = events.filter(({ event }) => event === 'recurrence-comparison');
    expect(comparisons).toHaveLength(1);
    expect(comparisons[0]).toMatchObject({
      category: 'self-dev.rework',
      data: {
        round: 1,
        recurrencePredicate: 'comparable-with-shared-symbol',
        comparable: true,
        sharedSymbolCount: 1,
        overlapRatio: 1,
        runId: 'recurrence-observation-run',
        goalId: 'recurrence-observation-goal',
      },
    });
    expect(ledger.filter(({ event }) => event === 'recurrence-comparison')).toEqual([
      { event: 'recurrence-comparison', data: comparisons[0]!.data },
    ]);
  });

  test('repetition-citing rejection is observable without changing the reflect verdict', async () => {
    const finding = '반복 `src/example.ts` 지적';
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    let reviewCall = 0;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await runSelfImplement({
        feature: 'recurrence rejection observation',
        maxReworkRounds: 2,
        seams: seams({
          reviewDiff: async () => ++reviewCall === 1
            ? { verdict: 'fail' as const, mustFix: [finding], shouldFix: [], summary: 'first', reviewed: true }
            : { verdict: 'fail' as const, mustFix: [finding], shouldFix: [], summary: 'second', reviewed: true },
          reflectMustFix: async (input) => input.recurrenceHistory?.length
            ? { accepted: [], rejected: input.mustFix.map((item) => ({ item, reason: 'occurrence=1 observedRounds=[0, 1]' })) }
            : { accepted: [...input.mustFix], rejected: [] },
        }),
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(events).toContainEqual(expect.objectContaining({
      event: 'review-reflect',
      data: expect.objectContaining({
        round: 1,
        acceptedCount: 0,
        rejectedCount: 1,
        rejections: [{ item: finding, reason: 'occurrence=1 observedRounds=[0, 1]' }],
        recurrenceHistoryCount: 1,
        recurrenceCitedRejectionCount: 1,
      }),
    }));
  });

  test('review-reflect records zero recurrence-history denominator without changing existing counts', async () => {
    const finding = '첫 라운드 `src/example.ts` 지적';
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await runSelfImplement({
        feature: 'zero recurrence denominator observation',
        maxReworkRounds: 1,
        seams: seams({
          reviewDiff: async () => ({ verdict: 'fail' as const, mustFix: [finding], shouldFix: [], summary: 'first', reviewed: true }),
          reflectMustFix: async (input) => ({ accepted: [], rejected: input.mustFix.map((item) => ({ item, reason: 'scope outside' })) }),
        }),
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(events).toContainEqual(expect.objectContaining({
      event: 'review-reflect',
      data: expect.objectContaining({
        round: 0,
        acceptedCount: 0,
        rejectedCount: 1,
        rejections: [{ item: finding, reason: 'scope outside' }],
        recurrenceHistoryCount: 0,
        recurrenceCitedRejectionCount: 0,
      }),
    }));
  });

  test('⭐ 반사가 «아무것도 기각하지 않아도» 한 줄 낸다 — 「안 돌았다」와 구분된다', async () => {
    // ⛔ 이것이 없으면 「반사가 돌았고 다 받았다」와 「반사가 «아예 안 돌았다»」가 사람 산출에서 같다.
    const progress: string[] = [];
    let reviewCall = 0;
    const s = seams({
      reviewDiff: async () => {
        reviewCall++;
        return reviewCall === 1
          ? { verdict: 'fail' as const, mustFix: ['진짜 버그'], shouldFix: [], summary: 's', reviewed: true }
          : { verdict: 'pass' as const, mustFix: [], shouldFix: [], summary: 's', reviewed: true };
      },
      reflectMustFix: async ({ mustFix }) => ({ accepted: [...mustFix], rejected: [] }),
      onProgress: ({ message }) => { progress.push(message); },
    });
    await runSelfImplement({ feature: 'F', maxReworkRounds: 2, seams: s });
    expect(progress).toContain('반사 기각 0건 · 남은 must-fix 1건');
  });

  test('일부만 reject → accepted 만 rework 재주입(rejected 는 재주입 안 함)', async () => {
    const features: string[] = [];
    let reviewCall = 0;
    const s = seams({
      features,
      reviewDiff: async () => {
        reviewCall++;
        return reviewCall === 1
          ? { verdict: 'fail' as const, mustFix: ['진짜 버그', '가짜 지적'], shouldFix: [], summary: 's', reviewed: true }
          : { verdict: 'pass' as const, mustFix: [], shouldFix: [], summary: 's', reviewed: true };
      },
      reflectMustFix: async () => ({ accepted: ['진짜 버그'], rejected: [{ item: '가짜 지적', reason: '무관' }] }),
    });
    const r = await runSelfImplement({ feature: 'F', maxReworkRounds: 2, seams: s });
    expect(r.stage).toBe('pr-opened');
    expect(features.length).toBe(2);              // rework 1회(accepted 있으니)
    expect(features[1]).toContain('진짜 버그');    // accepted 재주입
    expect(features[1]).not.toContain('가짜 지적'); // rejected 는 재주입 안 함
  });

  test('유효 REFUTE는 당시 자식에게 준 원본 must-fix 안정 ID로 감독에게 별도 회부되고 다음 리뷰 배열에 재매핑되지 않는다', async () => {
    const quote = '- Checkable preservation criterion: 기존 must-fix 반영 경로를 바꾸지 않는다.';
    const originalFinding = '기존 경로를 바꿔라';
    const findingId = stableMustFixId(originalFinding);
    const legacyGuidanceInGoal = '반론 검토 결과를 반드시 제출하라: 있으면 위 REFUTE 형식으로 회부하고, 없으면 정확히 `REFUTE: NONE` 한 줄을 남겨라.';
    const feature = `F\n${quote}\n${legacyGuidanceInGoal}`;
    const features: string[] = [];
    const seen: Array<{ mustFix: string[]; refutations: unknown }> = [];
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    let implementation = 0;
    let reviewCall = 0;
    const s = seams({
      features,
      implement: async ({ feature: childFeature }) => {
        features.push(childFeature);
        return {
          ok: true,
          summary: ++implementation === 1 ? 'initial' : `REFUTE [${findingId}] ${JSON.stringify(quote)} — 기존 경로와 충돌한다.`,
        };
      },
      reviewDiff: async () => ++reviewCall === 1
        ? { verdict: 'fail' as const, mustFix: [originalFinding], shouldFix: [], summary: 'first', reviewed: true }
        : { verdict: 'pass' as const, mustFix: [], shouldFix: ['재정렬된 다음 리뷰'], summary: 'second', reviewed: true },
      reflectMustFix: async (input) => {
        seen.push({ mustFix: input.mustFix, refutations: input.refutations });
        return { accepted: input.mustFix, rejected: [] };
      },
    });
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const result = await runSelfImplement({ feature, maxReworkRounds: 1, seams: s });
      expect(result.stage).toBe('pr-opened');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(features[1]).toContain(`- [${findingId}] ${originalFinding}`);
    expect(features[1]).toContain(legacyGuidanceInGoal);
    expect(features[1]).toContain(buildRefutationGuidance());
    expect(buildRefutationGuidance()).toContain('`REFUTE: NONE — <reason>`');
    expect(buildRefutationGuidance()).not.toContain('정확히 `REFUTE: NONE` 한 줄');
    expect(seen).toEqual([
      { mustFix: [originalFinding], refutations: undefined },
      {
        mustFix: [originalFinding],
        refutations: [{ findingId, finding: originalFinding, quote, kind: 'preservation-contract', reason: '기존 경로와 충돌한다.' }],
      },
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      event: 'review-refute-adjudicated',
      data: expect.objectContaining({ submittedCount: 1, acceptedMustFixCount: 1, rejectedMustFixCount: 0 }),
    }));
  });

  test('REFUTE 제출과 감독 판정을 동일 runId 원장에 순서대로 기록하고 진단 입력으로 전달한다', async () => {
    const quote = '- Checkable preservation criterion: 기존 경로를 유지한다.';
    const finding = '기존 경로를 바꿔라';
    const findingId = stableMustFixId(finding);
    const ledger: Array<{ event: string; runId: string; data: Record<string, unknown> }> = [];
    const diagnoses: Array<{ refutations?: unknown; refutationRound?: number }> = [];
    let implementation = 0;
    let reviewCall = 0;
    const result = await runSelfImplement({
      feature: `F\n${quote}`,
      runId: 'run-refute-ledger',
      maxReworkRounds: 2,
      seams: seams({
        writeRunLedger: (entry) => { ledger.push(entry); },
        implement: async () => ({ ok: true, summary: ++implementation === 1 ? 'initial' : `REFUTE [${findingId}] ${JSON.stringify(quote)} — 현장 구현과 충돌한다.` }),
        reviewDiff: async () => ++reviewCall <= 2
          ? { verdict: 'fail' as const, mustFix: [finding], shouldFix: [], summary: 'failed', reviewed: true }
          : { verdict: 'pass' as const, mustFix: [], shouldFix: [], summary: 'passed', reviewed: true },
        diagnose: async (input) => { diagnoses.push(input); return `BUDGET: SUFFICIENT\nREASON: refute considered\nREFUTE [${findingId}]: ACCEPT`; },
        reflectMustFix: async (input) => ({ accepted: input.mustFix, rejected: [] }),
      }),
    });
    expect(result.stage).toBe('pr-opened');
    expect(diagnoses).toHaveLength(2);
    expect(diagnoses[1]).toEqual(expect.objectContaining({ refutationRound: 1, refutations: [expect.objectContaining({ findingId, quote, reason: '현장 구현과 충돌한다.' })] }));
    const submitted = ledger.find(({ event }) => event === 'refute-submitted');
    const adjudicated = ledger.find(({ event }) => event === 'refute-supervisor-adjudicated');
    expect(submitted).toEqual(expect.objectContaining({ runId: 'run-refute-ledger', data: expect.objectContaining({ round: 1, submittedCount: 1, refutationGuidancePresented: true, kinds: { 'preservation-contract': 1, 'requested-criterion': 0, 'invariant-candidate': 0, 'must-fix-conflict': 0, 'missing-cited-path': 0, 'found-cited-path': 0 } }) }));
    expect(adjudicated).toEqual(expect.objectContaining({ runId: 'run-refute-ledger', data: expect.objectContaining({ round: 1, diagnosisRound: 2, submittedCount: 1, acceptedCount: 1, rejectedCount: 0, adjudications: [{ findingId, verdict: 'accepted' }] }) }));
    expect(ledger.indexOf(submitted!)).toBeLessThan(ledger.indexOf(adjudicated!));
  });

  test('BUDGET: SUFFICIENT 단독 응답은 REFUTE 수락·기각 원장 이벤트를 만들지 않는다', async () => {
    const quote = '- Checkable preservation criterion: 기존 경로를 유지한다.';
    const finding = '기존 경로를 바꿔라';
    const findingId = stableMustFixId(finding);
    const ledger: Array<{ event: string }> = [];
    let implementation = 0;
    let reviewCall = 0;
    await runSelfImplement({
      feature: `F\n${quote}`,
      runId: 'run-refute-budget-only',
      maxReworkRounds: 2,
      seams: seams({
        writeRunLedger: (entry) => { ledger.push(entry); },
        implement: async () => ({ ok: true, summary: ++implementation === 1 ? 'initial' : `REFUTE [${findingId}] ${JSON.stringify(quote)} — 현장 구현과 충돌한다.` }),
        reviewDiff: async () => ++reviewCall <= 2
          ? { verdict: 'fail' as const, mustFix: [finding], shouldFix: [], summary: 'failed', reviewed: true }
          : { verdict: 'pass' as const, mustFix: [], shouldFix: [], summary: 'passed', reviewed: true },
        diagnose: async () => 'BUDGET: SUFFICIENT\nREASON: refute considered',
        reflectMustFix: async (input) => ({ accepted: input.mustFix, rejected: [] }),
      }),
    });
    expect(ledger.some(({ event }) => event === 'refute-submitted')).toBe(true);
    expect(ledger.some(({ event }) => event === 'refute-supervisor-adjudicated')).toBe(false);
  });

  test.each([
    ['ACCEPT 후 REJECT', ['ACCEPT', 'REJECT']],
    ['REJECT 후 ACCEPT', ['REJECT', 'ACCEPT']],
  ])('상충 감독 판정(%s)은 확정 원장 이벤트와 수락·기각 집계를 만들지 않는다', async (_name, verdicts) => {
    const quote = '- Checkable preservation criterion: 기존 경로를 유지한다.';
    const finding = '기존 경로를 바꿔라';
    const findingId = stableMustFixId(finding);
    const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
    let implementation = 0;
    let reviewCall = 0;
    await runSelfImplement({
      feature: `F\n${quote}`,
      runId: `run-refute-conflict-${verdicts.join('-').toLowerCase()}`,
      maxReworkRounds: 2,
      seams: seams({
        writeRunLedger: (entry) => { ledger.push(entry); },
        implement: async () => ({ ok: true, summary: ++implementation === 1 ? 'initial' : `REFUTE [${findingId}] ${JSON.stringify(quote)} — 현장 구현과 충돌한다.` }),
        reviewDiff: async () => ++reviewCall <= 2
          ? { verdict: 'fail' as const, mustFix: [finding], shouldFix: [], summary: 'failed', reviewed: true }
          : { verdict: 'pass' as const, mustFix: [], shouldFix: [], summary: 'passed', reviewed: true },
        diagnose: async () => `BUDGET: SUFFICIENT\nREASON: conflicting refute verdicts\nREFUTE [${findingId}]: ${verdicts[0]}\nREFUTE [${findingId}]: ${verdicts[1]}`,
        reflectMustFix: async (input) => ({ accepted: input.mustFix, rejected: [] }),
      }),
    });
    expect(ledger.some(({ event }) => event === 'refute-submitted')).toBe(true);
    expect(ledger.some(({ event }) => event === 'refute-supervisor-adjudicated')).toBe(false);
  });

  test('동일 감독 판정의 중복은 한 건의 확정 판정으로만 원장에 기록한다', async () => {
    const quote = '- Checkable preservation criterion: 기존 경로를 유지한다.';
    const finding = '기존 경로를 바꿔라';
    const findingId = stableMustFixId(finding);
    const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
    let implementation = 0;
    let reviewCall = 0;
    await runSelfImplement({
      feature: `F\n${quote}`,
      runId: 'run-refute-duplicate-accept',
      maxReworkRounds: 2,
      seams: seams({
        writeRunLedger: (entry) => { ledger.push(entry); },
        implement: async () => ({ ok: true, summary: ++implementation === 1 ? 'initial' : `REFUTE [${findingId}] ${JSON.stringify(quote)} — 현장 구현과 충돌한다.` }),
        reviewDiff: async () => ++reviewCall <= 2
          ? { verdict: 'fail' as const, mustFix: [finding], shouldFix: [], summary: 'failed', reviewed: true }
          : { verdict: 'pass' as const, mustFix: [], shouldFix: [], summary: 'passed', reviewed: true },
        diagnose: async () => `BUDGET: SUFFICIENT\nREASON: repeated refute verdict\nREFUTE [${findingId}]: ACCEPT\nREFUTE [${findingId}]: ACCEPT`,
        reflectMustFix: async (input) => ({ accepted: input.mustFix, rejected: [] }),
      }),
    });
    expect(ledger.filter(({ event }) => event === 'refute-supervisor-adjudicated')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          acceptedCount: 1,
          rejectedCount: 0,
          adjudications: [{ findingId, verdict: 'accepted' }],
        }),
      }),
    ]);
  });

  test('REFUTE 없는 실제 review rework는 refute-not-submitted를 관측하고 기존 외부 결과와 reflect 호출 수를 보존한다', async () => {
    const features: string[] = [];
    const reflected: string[][] = [];
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    let reviewCall = 0;
    const s = seams({
      features,
      reviewDiff: async () => ++reviewCall === 1
        ? { verdict: 'fail' as const, mustFix: ['진짜 버그'], shouldFix: [], summary: 'first', reviewed: true }
        : { verdict: 'pass' as const, mustFix: [], shouldFix: [], summary: 'second', reviewed: true },
      reflectMustFix: async (input) => {
        reflected.push(input.mustFix);
        return { accepted: input.mustFix, rejected: [] };
      },
    });
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const result = await runSelfImplement({ feature: 'F', maxReworkRounds: 1, seams: s });
      expect(result.stage).toBe('pr-opened');
      expect(result.review?.verdict).toBe('pass');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(reflected).toEqual([['진짜 버그']]);
    expect(features).toHaveLength(2);
    expect(events).toContainEqual(expect.objectContaining({
      event: 'refute-not-submitted',
      data: expect.objectContaining({
        refutableCount: 1,
        findingIds: [stableMustFixId('진짜 버그')],
        submittedCount: 0,
        refutationGuidancePresented: true,
        refutationAcknowledged: false,
      }),
    }));
    expect(events).not.toContainEqual(expect.objectContaining({ event: 'review-refute-submitted' }));
  });

  test('형식이 손상된 REFUTE는 refute-rejected에 단계와 findingId만 남기고 반론으로 수용하지 않는다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    let reviewCall = 0;
    const s = seams({
      implement: async ({ feature }) => ({ ok: true, summary: feature.includes('[리뷰 must-fix') ? 'REFUTE [MF-deadbeef]"인용" — 이유' : 'initial' }),
      reviewDiff: async () => ++reviewCall === 1
        ? { verdict: 'fail' as const, mustFix: ['진짜 버그'], shouldFix: [], summary: 'first', reviewed: true }
        : { verdict: 'pass' as const, mustFix: [], shouldFix: [], summary: 'second', reviewed: true },
      reflectMustFix: async (input) => ({ accepted: input.mustFix, rejected: [] }),
    });
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const result = await runSelfImplement({ feature: 'F', maxReworkRounds: 1, seams: s });
      expect(result.stage).toBe('pr-opened');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(events).toContainEqual(expect.objectContaining({
      event: 'refute-rejected',
      data: expect.objectContaining({ round: 1, stage: 'prefix', findingId: 'MF-deadbeef' }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      event: 'refute-not-submitted',
      data: expect.objectContaining({ refutableCount: 1, submittedCount: 0 }),
    }));
  });

  test('REFUTE: NONE과 REFUTEX는 제출 후보가 아니므로 refute-rejected 관측을 만들지 않는다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    let reviewCall = 0;
    const s = seams({
      implement: async ({ feature }) => ({ ok: true, summary: feature.includes('[리뷰 must-fix') ? 'REFUTE: NONE\nREFUTEX [MF-deadbeef] "인용" — 이유' : 'initial' }),
      reviewDiff: async () => ++reviewCall === 1
        ? { verdict: 'fail' as const, mustFix: ['진짜 버그'], shouldFix: [], summary: 'first', reviewed: true }
        : { verdict: 'pass' as const, mustFix: [], shouldFix: [], summary: 'second', reviewed: true },
      reflectMustFix: async (input) => ({ accepted: input.mustFix, rejected: [] }),
    });
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const result = await runSelfImplement({ feature: 'F', maxReworkRounds: 1, seams: s });
      expect(result.stage).toBe('pr-opened');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(events).not.toContainEqual(expect.objectContaining({ event: 'refute-rejected' }));
    expect(events).toContainEqual(expect.objectContaining({
      event: 'refute-not-submitted',
      data: expect.objectContaining({ refutationAcknowledged: true }),
    }));
  });

  test('이유 포함·legacy·미선언 무반론은 refute-not-submitted 한 행에서 서로 구별된다', async () => {
    const summaries = ['REFUTE: NONE — 모든 finding이 골 계약과 양립한다.', 'REFUTE: NONE', '선언 없음'];
    const payloads: Record<string, unknown>[] = [];
    for (const summary of summaries) {
      const events: Array<{ event: string; data: Record<string, unknown> }> = [];
      const original = debug.log;
      let reviewCall = 0;
      const s = seams({
        implement: async ({ feature }) => ({ ok: true, summary: feature.includes('[리뷰 must-fix') ? summary : 'initial' }),
        reviewDiff: async () => ++reviewCall === 1
          ? { verdict: 'fail' as const, mustFix: ['진짜 버그'], shouldFix: [], summary: 'first', reviewed: true }
          : { verdict: 'pass' as const, mustFix: [], shouldFix: [], summary: 'second', reviewed: true },
        reflectMustFix: async (input) => ({ accepted: input.mustFix, rejected: [] }),
      });
      (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
        events.push({ event, data: data as Record<string, unknown> });
      }) as typeof debug.log;
      try {
        await runSelfImplement({ feature: 'F', maxReworkRounds: 1, seams: s });
      } finally {
        (debug as { log: typeof debug.log }).log = original;
      }
      payloads.push(events.find(({ event, data }) => event === 'refute-not-submitted' && data.round === 1)!.data);
    }
    expect(payloads).toEqual([
      expect.objectContaining({ refutationAcknowledged: true, refutationAcknowledgementReason: '모든 finding이 골 계약과 양립한다.' }),
      expect.objectContaining({ refutationAcknowledged: true }),
      expect.objectContaining({ refutationAcknowledged: false }),
    ]);
    expect(payloads[1]).not.toHaveProperty('refutationAcknowledgementReason');
    expect(payloads[2]).not.toHaveProperty('refutationAcknowledgementReason');
  });

  test('REFUTE: NONE은 반론 0건이 검토된 결과임을 refute-not-submitted 관측에 남긴다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    let reviewCall = 0;
    const s = seams({
      implement: async ({ feature }) => ({ ok: true, summary: feature.includes('[리뷰 must-fix') ? 'REFUTE: NONE' : 'initial' }),
      reviewDiff: async () => ++reviewCall === 1
        ? { verdict: 'fail' as const, mustFix: ['진짜 버그'], shouldFix: [], summary: 'first', reviewed: true }
        : { verdict: 'pass' as const, mustFix: [], shouldFix: [], summary: 'second', reviewed: true },
      reflectMustFix: async (input) => ({ accepted: input.mustFix, rejected: [] }),
    });
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const result = await runSelfImplement({ feature: 'F', maxReworkRounds: 1, seams: s });
      expect(result.stage).toBe('pr-opened');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(events).toContainEqual(expect.objectContaining({
      event: 'refute-not-submitted',
      data: expect.objectContaining({ refutableCount: 1, submittedCount: 0, refutationAcknowledged: true }),
    }));
    expect(events).not.toContainEqual(expect.objectContaining({ event: 'review-refute-submitted' }));
  });

  test('seam 불완전 partition({accepted:[],rejected:[]}) → silent-drop 방지(미분류 must-fix default-accept·rework)', async () => {
    const features: string[] = [];
    let reviewCall = 0;
    const s = seams({
      features,
      reviewDiff: async () => {
        reviewCall++;
        return reviewCall === 1
          ? { verdict: 'fail' as const, mustFix: ['진짜 버그'], shouldFix: [], summary: 's', reviewed: true }
          : { verdict: 'pass' as const, mustFix: [], shouldFix: [], summary: 's', reviewed: true };
      },
      reflectMustFix: async () => ({ accepted: [], rejected: [] }), // 불완전: 아무것도 분류 안 함
    });
    const r = await runSelfImplement({ feature: 'F', maxReworkRounds: 2, seams: s });
    expect(r.stage).toBe('pr-opened');           // 수렴 아님(silent-drop 방지)
    expect(features.length).toBe(2);             // 미분류 must-fix 는 유지 → rework
    expect(features[1]).toContain('진짜 버그');   // default-accept 재주입
  });

  test('전부 rejected 수렴 + --auto-merge armed → 자동 병합(HITL 아님)', async () => {
    const s = seams({
      // reviewed:true 면 실제 리뷰어는 예산도 함께 낸다(#5557 자동병합 조건 — 예산 미보고는 HITL).
      reviewDiff: async () => ({ verdict: 'fail' as const, mustFix: ['계약 밖 지적'], shouldFix: [], summary: 's', reviewed: true, diffTruncated: false, diffShownChars: 100, diffTotalChars: 100, diffOmittedFiles: 0 }),
      reflectMustFix: async ({ mustFix }) => ({ accepted: [], rejected: mustFix.map((item) => ({ item, reason: '등가계약 밖 사유' })) }),
      mergePr: async () => ({ merged: true }),
    });
    const r = await runSelfImplement({ feature: 'F', autoMerge: true, seams: s });
    expect(r.stage).toBe('merged');   // warn 강등 → --auto-merge armed → 자동 병합
    expect(r.merged).toBe(true);
  });

  test('반사 수렴 종료는 일반 완료와 구별되고 정상 상태·기각 수를 terminal events에 보존한다', async () => {
    const { events, restore } = captureRunEvents();
    try {
      const normal = await runSelfImplement({ feature: 'normal completion', runId: 'normal-completion', seams: seams({}) });
      const reflected = await runSelfImplement({
        feature: 'reflected completion',
        runId: 'reflected-completion',
        autoMerge: true,
        seams: seams({
          reviewDiff: async () => ({ verdict: 'fail' as const, mustFix: ['계약 밖 지적'], shouldFix: [], summary: 's', reviewed: true, diffTruncated: false }),
          reflectMustFix: async ({ mustFix }) => ({ accepted: [], rejected: mustFix.map((item) => ({ item, reason: '등가계약 밖 사유' })) }),
          mergePr: async () => ({ merged: true }),
        }),
      });
      expect(normal).toMatchObject({ outcome: 'completed', completionStatus: 'completed' });
      expect(reflected).toMatchObject({ stage: 'merged', outcome: 'completed', completionStatus: 'review-reflect-converged', reviewReflectRejectedCount: 1, merged: true });
    } finally {
      restore();
    }

    const terminal = events.filter((entry) => entry.event === 'run-status' || entry.event === 'run-rollup');
    expect(terminal.filter((entry) => entry.data.runId === 'normal-completion')).toHaveLength(2);
    expect(terminal.filter((entry) => entry.data.runId === 'reflected-completion')).toHaveLength(2);
    for (const event of terminal.filter((entry) => entry.data.runId === 'normal-completion')) {
      expect(event.data).toMatchObject({ runStatus: 'completed', completionStatus: 'completed' });
      expect(event.level).toBeUndefined();
    }
    for (const event of terminal.filter((entry) => entry.data.runId === 'reflected-completion')) {
      expect(event.data).toMatchObject({ runStatus: 'completed', completionStatus: 'review-reflect-converged', reviewReflectRejectedCount: 1 });
      expect(event.data).not.toHaveProperty('failureKind');
      expect(event.level).toBeUndefined();
    }
  });

  test('반사가 기각 0건이면 일반 완료와 구별되며 terminal events에 0을 보존한다', async () => {
    const { events, restore } = captureRunEvents();
    try {
      const result = await runSelfImplement({
        feature: 'reflection without rejection',
        runId: 'reflection-zero-rejection',
        maxReworkRounds: 1,
        seams: seams({
          reviewDiff: async () => ({ verdict: 'fail' as const, mustFix: ['실제 버그'], shouldFix: [], summary: 's', reviewed: true, diffTruncated: false }),
          reflectMustFix: async ({ mustFix }) => ({ accepted: mustFix, rejected: [] }),
        }),
      });
      expect(result).toMatchObject({ stage: 'pr-opened', outcome: 'budget-exhausted', reviewReflectRejectedCount: 0 });
      expect(result).not.toHaveProperty('completionStatus');
    } finally {
      restore();
    }

    for (const event of events.filter((entry) => (entry.event === 'run-status' || entry.event === 'run-rollup') && entry.data.runId === 'reflection-zero-rejection')) {
      expect(event.data).toMatchObject({ runStatus: 'completed', reviewReflectRejectedCount: 0 });
      expect(event.data).not.toHaveProperty('completionStatus');
      expect(event.level).toBeUndefined();
    }
  });

  test('반사 기각 수는 여러 라운드에 누적되고 마지막 0건 반사 뒤에도 terminal 상태에 남는다', async () => {
    const { events, restore } = captureRunEvents();
    let reviewCall = 0;
    try {
      const result = await runSelfImplement({
        feature: 'multi-round reflection total',
        runId: 'multi-round-reflection-total',
        maxReworkRounds: 2,
        seams: seams({
          reviewDiff: async () => {
            reviewCall++;
            return reviewCall === 1
              ? { verdict: 'fail' as const, mustFix: ['구현할 버그', '기각할 지적'], shouldFix: [], summary: 'first', reviewed: true, diffTruncated: false }
              : { verdict: 'fail' as const, mustFix: ['구현한 버그'], shouldFix: [], summary: 'second', reviewed: true, diffTruncated: false };
          },
          reflectMustFix: async ({ mustFix }) => mustFix.includes('기각할 지적')
            ? { accepted: ['구현할 버그'], rejected: [{ item: '기각할 지적', reason: '등가계약 밖' }] }
            : { accepted: mustFix, rejected: [] },
        }),
      });
      expect(result).toMatchObject({ stage: 'pr-opened', outcome: 'budget-exhausted', reviewReflectRejectedCount: 1 });
    } finally {
      restore();
    }
    for (const event of events.filter((entry) => (entry.event === 'run-status' || entry.event === 'run-rollup') && entry.data.runId === 'multi-round-reflection-total')) {
      expect(event.data).toMatchObject({ runStatus: 'completed', reviewReflectRejectedCount: 1 });
    }
  });

  test('반사 뒤 timeout terminal도 누적 기각 수를 공통 종료 조립에서 보존한다', async () => {
    const { events, restore } = captureRunEvents();
    let reviewCall = 0;
    try {
      const result = await runSelfImplement({
        feature: 'reflection then timeout',
        runId: 'reflection-then-timeout',
        maxReworkRounds: 2,
        stepTimeouts: { implement: 10 },
        seams: seams({
          reviewDiff: async () => ({ verdict: 'fail' as const, mustFix: ['구현할 버그', '기각할 지적'], shouldFix: [], summary: 'first', reviewed: true, diffTruncated: false }),
          reflectMustFix: async () => ({ accepted: ['구현할 버그'], rejected: [{ item: '기각할 지적', reason: '등가계약 밖' }] }),
          implement: async () => ++reviewCall === 1 ? { ok: true, summary: 'first' } : await new Promise<never>(() => {}),
        }),
      });
      expect(result).toMatchObject({ stage: 'timed-out', outcome: 'abandoned', reviewReflectRejectedCount: 1 });
      expect(result).not.toHaveProperty('completionStatus');
    } finally {
      restore();
    }
    for (const event of events.filter((entry) => (entry.event === 'run-status' || entry.event === 'run-rollup') && entry.data.runId === 'reflection-then-timeout')) {
      expect(event.data).toMatchObject({ runStatus: 'failed', reviewReflectRejectedCount: 1 });
      expect(event.data).not.toHaveProperty('completionStatus');
    }
  });

  test('라운드 간 reject 감사 보존 — rework 후 새 review 재할당돼도 이전 라운드 reflect-rejected 가 최종에 남는다', async () => {
    const features: string[] = [];
    let reviewCall = 0;
    const s = seams({
      features,
      reviewDiff: async () => {
        reviewCall++;
        return reviewCall === 1
          ? { verdict: 'fail' as const, mustFix: ['진짜 버그', '가짜 지적'], shouldFix: [], summary: 's', reviewed: true }
          : { verdict: 'pass' as const, mustFix: [], shouldFix: [], summary: 's(new·이전 shouldFix 없음)', reviewed: true };
      },
      reflectMustFix: async () => ({ accepted: ['진짜 버그'], rejected: [{ item: '가짜 지적', reason: '등가계약 밖 사유' }] }),
    });
    const r = await runSelfImplement({ feature: 'F', maxReworkRounds: 2, seams: s });
    expect(r.stage).toBe('pr-opened');
    expect(features.length).toBe(2);   // rework(accepted 있으니)
    // round1 새 review 로 재할당됐어도 round0 의 reflect-rejected 감사가 최종 review 에 보존
    expect(r.review?.shouldFix.some((x) => x.includes('reflect-rejected') && x.includes('가짜 지적'))).toBe(true);
  });

  test('reflectMustFix 미주입 → 종전 동작(전체 must-fix 재주입·무회귀)', async () => {
    const features: string[] = [];
    let reviewCall = 0;
    const s = seams({
      features,
      reviewDiff: async () => {
        reviewCall++;
        return reviewCall === 1
          ? { verdict: 'fail' as const, mustFix: ['버그1', '버그2'], shouldFix: [], summary: 's', reviewed: true }
          : { verdict: 'pass' as const, mustFix: [], shouldFix: [], summary: 's', reviewed: true };
      },
      // reflectMustFix 미주입
    });
    const r = await runSelfImplement({ feature: 'F', maxReworkRounds: 2, seams: s });
    expect(r.stage).toBe('pr-opened');
    expect(features[1]).toContain('버그1');
    expect(features[1]).toContain('버그2');   // 반사 없으면 전부 재주입(종전)
  });
});

// ── K run-identity 소유권 (2026-07-26 실측 갭) ─────────────────────────────────────
//   라이브 관측이 `run-identity propagate {"runId":""}` 를 찍었다 — `elanous self run <runId>` 조인 불가.
//   계약: self-implement **1회 호출**이 run 의 경계 → 리워크 라운드 전부가 같은 non-empty runId 를 받는다.
describe('runSelfImplement — run-identity 소유권', () => {
  const RUN_ID_ENV = 'ELANOUS_RUN_ID';
  const withoutInherited = async <T>(fn: () => Promise<T>): Promise<T> => {
    const prev = process.env[RUN_ID_ENV];
    delete process.env[RUN_ID_ENV];
    try { return await withoutRunLedgerLeak(fn); } finally { if (prev !== undefined) process.env[RUN_ID_ENV] = prev; }
  };

  const withoutRunLedgerLeak = async <T>(fn: () => Promise<T>): Promise<T> => {
    const stateDir = mkdtempSync(join(tmpdir(), 'elanous-orchestrator-ledger-'));
    const ledgerDir = join(stateDir, 'run-ledger');
    const previousStateDir = process.env.ELANOUS_STATE_DIR;
    try {
      process.env.ELANOUS_STATE_DIR = stateDir;
      const result = await fn();
      const ledgerFiles = readdirSync(stateDir, { withFileTypes: true })
        .find((entry) => entry.name === 'run-ledger' && entry.isDirectory())
        ? readdirSync(ledgerDir, { withFileTypes: true }).filter((entry) => entry.isFile())
        : [];
      expect(ledgerFiles).toEqual([]);
      return result;
    } finally {
      if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  };

  test('★ 상속 없어도 implement seam 이 받는 runId 는 비어 있지 않다(종전엔 "")', async () => {
    const seen: Array<string | undefined> = [];
    await withoutInherited(() => runSelfImplement({
      feature: 'F', maxReworkRounds: 0,
      seams: seams({
        implement: async ({ runId }) => { seen.push(runId); return { ok: true, summary: 'impl' }; },
      }),
    }));
    expect(seen.length).toBe(1);
    expect(seen[0]).toBeTruthy();
    expect(seen[0]).toMatch(/^run-[A-Za-z0-9-]+$/);
  });

  test('★ 리워크 라운드 전부가 **하나의** runId 를 공유한다(라운드별 mint 금지)', async () => {
    const seen: Array<string | undefined> = [];
    await withoutInherited(() => runSelfImplement({
      feature: 'F', maxReworkRounds: 2,
      seams: seams({
        gateResults: [false, false, true],
        implement: async ({ runId }) => { seen.push(runId); return { ok: true, summary: 'impl' }; },
      }),
    }));
    expect(seen.length).toBeGreaterThan(1);           // 리워크가 실제로 돌았다
    expect(new Set(seen).size).toBe(1);               // 그러나 run 은 하나
    expect(seen[0]).toBeTruthy();
  });

  // ⭐ 리뷰 must-fix — 실제 결함 조건은 "명시적 빈/공백 문자열"이다. `??` 는 그것을 채택해 계약을 깨뜨렸다.
  test.each([['빈 문자열', ''], ['공백만', '   '], ['정규화 후 빈 값', '///']])(
    '★ 명시 runId 가 %s 이면 채택하지 않고 mint 로 폴백(항상 non-empty)', async (_label, bad) => {
      const seen: Array<string | undefined> = [];
      await withoutInherited(() => runSelfImplement({
        feature: 'F', maxReworkRounds: 0, runId: bad as string,
        seams: seams({
          implement: async ({ runId }) => { seen.push(runId); return { ok: true, summary: 'impl' }; },
        }),
      }));
      expect(seen[0]).toBeTruthy();
      expect(seen[0]).toMatch(/^run-[A-Za-z0-9-]+$/);
    });

  test('★ 명시 runId 가 공백/불안전 문자를 포함하면 정규화해 쓴다(run-store 파일명·manifest 키 안전)', async () => {
    const seen: Array<string | undefined> = [];
    await withoutInherited(() => runSelfImplement({
      feature: 'F', maxReworkRounds: 0, runId: '  run/../evil id  ',
      seams: seams({
        implement: async ({ runId }) => { seen.push(runId); return { ok: true, summary: 'impl' }; },
      }),
    }));
    expect(seen[0]).toBeTruthy();
    expect(seen[0]).not.toContain('/');
    expect(seen[0]).not.toContain(' ');
    expect(seen[0]).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test('호출자가 runId 를 지정하면 그것을 그대로 쓴다(중첩 계보 명시 전파)', async () => {
    const seen: Array<string | undefined> = [];
    await withoutRunLedgerLeak(() => runSelfImplement({
      feature: 'F', maxReworkRounds: 0, runId: 'run-explicit',
      seams: seams({
        implement: async ({ runId }) => { seen.push(runId); return { ok: true, summary: 'impl' }; },
      }),
    }));
    expect(seen).toEqual(['run-explicit']);
  });
});


describe('runSelfImplement review intent wiring', () => {
  test('preserves a goal-only review intent in the PR body when internal review is disabled', async () => {
    let body = '';
    const s = seams({
      openPr: async (input) => { body = input.body; return { url: 'https://pr/intent', number: 10 }; },
    });
    const result = await runSelfImplement({ feature: '보존할 골', seams: s });
    expect(result.stage).toBe('pr-opened');
    // ⚠️ **인접성은 더 이상 단언하지 않는다** — 이 테스트가 재려던 것은 「골이 리뷰 intent 절에
    //   보존되나」이지 「목표가 그 절의 «첫 줄»인가」가 아니다. 런 사실 블록이 좌표를 리뷰어에게
    //   닿게 하려고 맨 앞으로 갔다(`review-intent.ts` 의 그 자리 주석 참조).
    // ⛔⭐ **그러나 「절이 있다」와 「골이 그 절 «안»에 있다」를 따로 재면 아무것도 증명 못 한다**
    //   (리뷰 should-fix — 내 초판이 그렇게 느슨했다). 절을 «추출»해서 그 안을 단언한다.
    const reviewIntentSection = body.split('## 리뷰 intent\n')[1]?.split('\n## ')[0] ?? '';
    expect(reviewIntentSection).not.toBe('');
    expect(reviewIntentSection).toContain('목표\n보존할 골');
  });

  test('round one carries the prior effective must-fix to both reviewDiff and child rework feature', async () => {
    const contexts: Array<{ round?: number; appliedLastRound?: readonly string[] }> = [];
    const features: string[] = [];
    let reviewCall = 0;
    const s = seams({ gateResults: [true, true] });
    s.implement = async ({ feature }) => {
      features.push(feature);
      return { ok: true, summary: 'impl' };
    };
    s.reviewDiff = async (_cwd, ctx) => {
      contexts.push(ctx ?? {});
      reviewCall += 1;
      return reviewCall === 1
        ? { verdict: 'fail', mustFix: ['첫 라운드 수정'], shouldFix: [], summary: 'fail', reviewed: true }
        : { verdict: 'pass', mustFix: [], shouldFix: [], summary: 'pass', reviewed: true };
    };
    const result = await runSelfImplement({ feature: 'F', maxReworkRounds: 1, seams: s });
    expect(result.stage).toBe('pr-opened');
    expect(features).toHaveLength(2);
    expect(features[0]).not.toContain('직전 라운드에 지적받아 반영한 것');
    expect(features[1]).toContain('[리뷰 must-fix — 반드시 반영]\n- 첫 라운드 수정');
    expect(features[1]).toContain('[직전 라운드에 지적받아 반영한 것]\n- 첫 라운드 수정');
    expect(features[1]).not.toContain('판단하라');
    expect(contexts).toHaveLength(2);
    expect(contexts[0]!.round).toBe(0);
    expect(contexts[1]!.round).toBe(1);
    expect(contexts[1]!.appliedLastRound).toEqual(['첫 라운드 수정']);
  });

  // ⭐ **실제로 무엇이 실리는지**를 못박는다(사후 리뷰 must-fix — 종전 테스트는 합성 gate 결과가
  //   준 `scopeBoundaries` 를 검사해, 파이프라인에 **생산자가 없다**는 사실을 가렸다).
  //   지금 채워지는 블록은 **목표 + 직전 라운드 반영분** 둘뿐이고, 수용기준·스코프 경계의
  //   생산자는 RFC P3(자기 합성)이다. 그 전까지 비어 있는 것이 **정직한 상태**다.
  // ⭐⭐ 사후 리뷰 must-fix — 종전 테스트는 경계가 없는 `feature: 'F'` 만 써서 **부재를 정당화**하는
  //   Goodhart 였다. 골에 절이 **있을 때** 4블록이 실제로 리뷰어와 PR 본문에 실리는지를 재야 한다.
  test('⭐ 골에 절이 있으면 4블록이 리뷰어와 PR 본문에 실제로 실린다', async () => {
    const goal = [
      '게이트 스코프를 고친다.', '',
      '## 수용기준', '- 변경 파일만 검증한다.', '',
      '## 하지 말 것', '- 풀 스위트 폴백을 되살리지 말 것.', '',
    ].join('\n');
    let body = '';
    const s2 = seams({
      gate: async () => ({ passed: true, log: 'gate' }),
      reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'pass', reviewed: true }),
      openPr: async (input) => { body = input.body; return { url: 'https://pr/4b', number: 12 }; },
    });
    await runSelfImplement({ feature: goal, seams: s2 });
    const seenIntent = body.split('## 리뷰 intent\n')[1] ?? '';
    expect(seenIntent).toContain('수용기준\n- 변경 파일만 검증한다.');
    expect(seenIntent).toContain('의도적 스코프 경계\n- 풀 스위트 폴백을 되살리지 말 것.');
    // 4블록 순서(라운드 0 이라 '직전 반영분' 은 없다).
    expect(seenIntent.indexOf('목표')).toBeLessThan(seenIntent.indexOf('수용기준'));
    expect(seenIntent.indexOf('수용기준')).toBeLessThan(seenIntent.indexOf('의도적 스코프 경계'));
    // ★ 중복 제거 — 골의 절이 목표 블록에 다시 들어가지 않는다(예산 낭비 차단).
    expect(seenIntent.split('변경 파일만 검증한다.').length - 1).toBe(1);
  });

  // ⭐⭐ **리뷰어가 실제로 받는 `phaseIntent`** 를 관측한다(리뷰 must-fix — PR 본문만 보면 리뷰
  //   경로의 회귀를 못 잡는다). 기본 seam 의 `reviewDiff` 를 **실제 diff 가 있는 임시 repo** 로
  //   태워, 리뷰 프롬프트의 `## Phase intent` 절에 4블록이 실렸는지 단정한다.
  test('⭐ 기본 seam 의 reviewDiff 가 4블록 intent 를 리뷰어에게 넘긴다 (리뷰 경로 런타임)', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { spawnSync } = await import('node:child_process');
    const repo = mkdtempSync(join(tmpdir(), 'rvw-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: repo });
      writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');   // untracked = diff 있음
      let prompt = '';
      const base = defaultSeams({ llmReview: async (p: string) => {
        prompt = p;
        return '{"verdict":"pass","mustFix":[],"shouldFix":[]}';
      } });
      const goal = [
        '게이트 스코프를 고친다.', '',
        '## 수용기준', '- 변경 파일만 검증한다.', '',
        '## 하지 말 것', '- 풀 스위트 폴백을 되살리지 말 것.',
      ].join('\n');
      await base.reviewDiff!(repo, { goal, round: 1, appliedLastRound: ['이전 라운드 수정'] });
      const intent = (prompt.split('## Phase intent\n')[1] ?? '').split('\n## ')[0] ?? '';
      expect(intent).toContain('수용기준\n- 변경 파일만 검증한다.');
      expect(intent).toContain('직전 라운드 반영분\n- 이전 라운드 수정');
      expect(intent).toContain('의도적 스코프 경계\n- 풀 스위트 폴백을 되살리지 말 것.');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);

  // ⛔⭐⭐ **커밋 제목 배선 회귀** — 종전엔 커밋 제목을 리뷰 루프 안(자식이 파일만 남긴 상태)에서만
  //   걷어, `commitWork` 가 만드는 커밋 제목이 PR 본문 `## 리뷰 intent` 에서 누락됐다.
  //   ⚠️⭐ **이 테스트가 «무엇을» 재는지 정직하게 적는다**(리뷰 should-fix — 종전 주석은 `defaultSeams`
  //     를 태운다고 썼는데 실제로는 이 파일의 `seams()` 헬퍼에 `commitWork`·`openPr` 를 «대체»해 쓴다):
  //     ✅ 재는 것  — 실제 git repo 에서 `commitTitles()`/`changedFiles()` 가 걷은 값이
  //                  `buildReviewIntent` 를 지나 PR 본문까지 «닿는가»(수집 시점 포함).
  //     ⛔ 안 재는 것 — 프로덕션 `openPr` 의 커밋 시점. 그것은 대체돼 있고, 원리적으로도 본문에
  //                  못 실린다(위 `withRefreshedRunFacts` 자리의 주석 참조).
  test('⭐ 커밋 제목·변경 파일이 PR 본문 런 사실 블록에 실린다 (수집→조립→본문 배선)', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'runfacts-'));
    try {
      spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
      spawnSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
      spawnSync('git', ['config', 'user.name', 't'], { cwd: repo });
      writeFileSync(join(repo, 'seed.txt'), 'seed\n');
      spawnSync('git', ['add', '-A'], { cwd: repo });
      spawnSync('git', ['commit', '-qm', 'seed commit'], { cwd: repo });
      // fork 지점을 origin/main 이 아니라 로컬 main 으로 잡을 수 있게 tracking 을 만든다.
      spawnSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: repo });

      let body = '';
      const runId = 'run-final-commit-wiring';
      const base = seams({
        // 자식은 파일만 남긴다 — 실제 최종 커밋은 orchestrator 의 commitWork 가 루프 뒤에서 만든다.
        implement: async ({ cwd }) => {
          writeFileSync(join(cwd, 'feature.ts'), 'export const wired = true;\n');
          return { ok: true, summary: 'EVIDENCE: [requested] a || b\nRESULT: c' };
        },
        createWorktree: async () => ({ path: repo, branch: 'se/final-commit-wiring', resolvedBase: 'a'.repeat(40), invokedHead: 'a'.repeat(40) }),
        // 실제 git 커밋을 만든다 — collectRunFacts(commitTitles) 가 이 최종 커밋을 봐야 한다.
        commitWork: (cwd, message) => { spawnSync('git', ['add', '-A'], { cwd }); spawnSync('git', ['commit', '-qm', message], { cwd }); },
        mergeMain: async () => ({ status: 'up-to-date' }),
        reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'pass', reviewed: true }),
        openPr: async (input) => { body = input.body; return { url: 'https://pr/runfacts', number: 21 }; },
      });

      const result = await runSelfImplement({ feature: '런 사실 배선을 확인한다.', runId, seams: base });
      expect(result.stage).toBe('pr-opened');
      const intent = body.split('## 리뷰 intent\n')[1] ?? '';
      expect(intent).toContain('런 사실 — 리뷰어가 관측과 잇는 좌표');
      expect(intent).toContain(`runId: ${runId}`);
      // ⭐ 최종 커밋 제목 — orchestrator 가 commitWork(prTitle(feature)) 로 만든 그 커밋.
      expect(intent).toContain('커밋: 런 사실 배선을 확인한다.');
      // ⭐ 변경 파일 — 자식이 남긴 feature.ts 가 커밋에 담겨 changedFiles 로 실린다.
      expect(intent).toContain('변경 파일: feature.ts');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);

  // 대조 — 골이 산문뿐이면 없는 기준을 지어내지 않는다(빈 헤더 금지).
  test('골에 절이 없으면 목표 블록만 — 없는 기준을 만들지 않는다', async () => {
    let body = '';
    const s2 = seams({
      gate: async () => ({ passed: true, log: 'gate' }),
      reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'pass', reviewed: true }),
      openPr: async (input) => { body = input.body; return { url: 'https://pr/1b', number: 13 }; },
    });
    await runSelfImplement({ feature: '그냥 산문 골입니다.', seams: s2 });
    const intent = body.split('## 리뷰 intent\n')[1] ?? '';
    expect(intent).toContain('목표');
    expect(intent).not.toContain('수용기준');
    expect(intent).not.toContain('의도적 스코프 경계');
  });
});


describe('runSelfImplement — rework budget judgment', () => {
  test('records every judgment observation state and preserves evidence through local log compaction', async () => {
    const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
    const events: Array<{ event: string; data: Record<string, unknown>; opt?: { compact?: { stringMax?: number; arrayMax?: number; maxDepth?: number } } }> = [];
    const reasoning = 'EXTEND because the gate failure has one bounded fix.';
    const original = (debug as { log: typeof debug.log }).log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data, opt) => {
      events.push({ event, data: data as Record<string, unknown>, opt: opt as { compact?: { stringMax?: number; arrayMax?: number; maxDepth?: number } } | undefined });
    }) as typeof debug.log;
    const s = seams({ gateResults: [false, true] });
    s.writeRunLedger = (entry) => { ledger.push({ event: entry.event, data: entry.data }); };
    s.diagnose = async () => 'BUDGET: EXTEND\\nREASON: one bounded fix';
    s.judgmentCallLLM = async () => reasoning;

    try {
      const result = await runSelfImplement({ feature: 'evidence observation', maxReworkRounds: 1, seams: s });
      expect(result.stage).toBe('pr-opened');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }

    const budget = ledger.find(({ event }) => event === 'rework-budget')!;
    expect(budget).toMatchObject({
      data: expect.objectContaining({
        evidence: {
          observations: {
            goal: { state: 'present', value: expect.any(String) },
            outcome: { state: 'empty', value: { 'rework-budget': { ok: true, output: 'EXTEND', durationMs: expect.any(Number) } } },
            history: { state: 'empty', value: [] },
            kind: { state: 'present', value: 'gate' },
          },
          modelReasoning: reasoning,
        },
      }),
    });
    const event = events.find(({ event }) => event === 'rework-budget')!;
    const compacted = compactForLog(event.data, event.opt?.compact);
    const rawEvidence = event.data.evidence as { observations: { goal: { state: string; value: string } } };
    const evidence = compacted.evidence as { observations: { goal: { state: string; value: string }; outcome: { state: string; value: unknown } }; modelReasoning: string };
    expect(event.opt).toEqual({ compact: { stringMax: 256, arrayMax: 6, maxDepth: 5 } });
    expect(evidence.observations.goal).toEqual(rawEvidence.observations.goal);
    expect(evidence.observations.goal.state).toBe('present');
    expect(evidence.observations.outcome.state).toBe('empty');
    expect(evidence.modelReasoning).toBe(reasoning);
    expect(evidence.observations.goal.value).not.toEqual({ _compact_depth_exceeded: true });
  });

  test('hard cap이 마지막 EXTEND를 무효화하면 budget-exhausted·계속 의사·경고를 남긴다', async () => {
    const { debug } = await import('../debug/log.js');
    const original = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown>; opt?: { level?: string } }> = [];
    (debug as { log: typeof debug.log }).log = ((_category, event, data, opt) => {
      events.push({ event, data: data as Record<string, unknown>, opt: opt as { level?: string } | undefined });
    }) as typeof debug.log;
    try {
      const launches: Array<{ goalFile: string; base: string; salvageAttempt: number }> = [];
      const comments: Array<{ number: number; body: string }> = [];
      const s = seams({ gateResults: [false, false, false, false, false, false] });
      s.diagnose = async () => 'BUDGET: EXTEND\nREASON: 한 라운드 내 보완 가능';
      s.readReworkSalvageEvidence = async () => ({ clean: true, aheadCommits: 2 });
      s.launchReworkSalvage = async (input) => { launches.push(input); };
      s.postPrComment = async (comment) => { comments.push(comment); };
      const result = await runSelfImplement({ feature: 'F', goalFile: budgetGoalFile(), writeGoalExecutionRecord: () => {}, maxReworkRounds: 2, seams: s });
      expect(result).toMatchObject({ ok: false, stage: 'gate-failed', outcome: 'budget-exhausted', salvage: 'launched', supervisorWantedContinue: true });
      expect(launches).toEqual([{ goalFile: budgetGoalFile(), base: expect.stringMatching(/^self-impl\//), salvageAttempt: 1 }]);
      expect(comments).toContainEqual(expect.objectContaining({ number: 7, body: expect.stringContaining('Rework salvage status: launched.') }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    const warning = events.find((event) => event.event === 'rework-budget-warning');
    expect(warning?.data).toMatchObject({ hardCap: 6, verdict: 'EXTEND' });
    expect(warning?.data.message).toBe('⚠️ 감독이 EXTEND 를 냈으나 하드 상한(6)에 막혀 예산이 늘지 않았다.');
    expect(warning?.opt).toEqual({ level: 'warn' });
    expect(events).toContainEqual(expect.objectContaining({
      event: 'rework-salvage',
      data: expect.objectContaining({ action: 'launched', branch: expect.stringMatching(/^self-impl\//), goalFile: budgetGoalFile(), clean: true, aheadCommits: 2 }),
    }));
  });

  // ★ RUN-T5 — 인수 발사는 **보존(커밋·push) 뒤**여야 한다. 먼저 띄우면 자식이 `--base <그 브랜치>`
  //    로 뜰 때 그 브랜치가 아직 origin 에 없어 assertBaseBranchOnOrigin 이 던질 수 있다.
  //    ⛔ 두 갈래는 **상호 배타**라 한 실행으로는 하나만 탄다 — 둘 다 명시적으로 돌린다(리뷰 1R).
  test.each([
    ['gate-failed', false],
    ['review-blocked', true],
  ] as const)('⭐ 발사는 산출 보존(openPr) 뒤에 일어난다 — %s 갈래', async (_label, gatePasses) => {
    const order: string[] = [];
    const s2 = seams(gatePasses ? {} : { gateResults: [false, false, false, false, false, false] });
    s2.diagnose = async () => 'BUDGET: EXTEND\nREASON: 한 라운드 내 보완 가능';
    s2.readReworkSalvageEvidence = async () => ({ clean: true, aheadCommits: 2 });
    s2.launchReworkSalvage = async () => { order.push('launch'); };
    s2.openPr = async () => { order.push('preserve'); return { url: 'https://x/7', number: 7 }; };
    if (gatePasses) {
      s2.reviewDiff = async () => ({ verdict: 'fail', mustFix: ['남은 지적'], shouldFix: [], summary: 'r', reviewed: true });
    }
    const r = await runSelfImplement({ feature: 'F', goalFile: budgetGoalFile(), writeGoalExecutionRecord: () => {}, maxReworkRounds: 2, seams: s2 });

    expect(r.stage).toBe(gatePasses ? 'pr-opened' : 'gate-failed');
    expect(order).toEqual(gatePasses ? ['preserve'] : ['preserve', 'launch']);
  });

  test('provider-error hard-cap salvage launches with its environment reason in the observation', async () => {
    const original = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    (debug as { log: typeof debug.log }).log = ((category, event, data, options) => {
      events.push({ event, data: data as Record<string, unknown> });
      return original.call(debug, category, event, data, options);
    }) as typeof debug.log;
    try {
      const launches: Array<{ goalFile: string; base: string; salvageAttempt: number }> = [];
      const s = seams({ gateResults: [false, false, false, false, false, false] });
      s.diagnose = async () => 'BUDGET: EXTEND\nREASON: provider interruption can resume';
      s.launchReworkSalvage = async (input) => { launches.push(input); };
      s.implement = async () => {
        debug.log('llm.router.error', 'streamLLM', { provider: 'test-provider', message: 'provider unavailable' });
        return { ok: true, summary: 'impl' };
      };

      const result = await runSelfImplement({ feature: 'provider salvage', goalFile: budgetGoalFile(), writeGoalExecutionRecord: () => {}, maxReworkRounds: 2, seams: s });

      expect(result).toMatchObject({ ok: false, stage: 'gate-failed', outcome: 'budget-exhausted', salvage: 'launched' });
      expect(launches).toEqual([{ goalFile: budgetGoalFile(), base: expect.stringMatching(/^self-impl\//), salvageAttempt: 1 }]);
      expect(events).toContainEqual(expect.objectContaining({
        event: 'rework-salvage',
        data: expect.objectContaining({ action: 'launched', reason: 'environment-provider-error', abandonedClassification: 'provider-error' }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('an already-salvaged hard-cap run parks without launching a chain', async () => {
    const original = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => { events.push({ event, data: data as Record<string, unknown> }); }) as typeof debug.log;
    try {
      let launches = 0;
      const comments: Array<{ number: number; body: string }> = [];
      const s = seams({ gateResults: [false, false, false, false, false, false] });
      s.diagnose = async () => 'BUDGET: EXTEND\nREASON: 한 라운드 내 보완 가능';
      s.readReworkSalvageEvidence = async () => ({ clean: true, aheadCommits: 2 });
      s.launchReworkSalvage = async () => { launches++; };
      s.postPrComment = async (comment) => { comments.push(comment); };
      const result = await runSelfImplement({ feature: 'F', goalFile: budgetGoalFile(), writeGoalExecutionRecord: () => {}, salvageAttempt: 1, maxReworkRounds: 2, seams: s });
      expect(result).toMatchObject({ outcome: 'budget-exhausted', salvage: 'parked' });
      expect(launches).toBe(0);
      expect(comments).toContainEqual(expect.objectContaining({ number: 7, body: expect.stringContaining('Rework salvage status: parked.\n\n- reason: already-salvaged') }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(events).toContainEqual(expect.objectContaining({ event: 'rework-salvage', data: expect.objectContaining({ action: 'parked', reason: 'already-salvaged' }) }));
  });

  test('a salvage status comment failure is observed without blocking the launched follow-up', async () => {
    const original = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => { events.push({ event, data: data as Record<string, unknown> }); }) as typeof debug.log;
    try {
      const launches: Array<{ goalFile: string; base: string; salvageAttempt: number }> = [];
      const s = seams({ gateResults: [false, false, false, false, false, false] });
      s.diagnose = async () => 'BUDGET: EXTEND\nREASON: 한 라운드 내 보완 가능';
      s.readReworkSalvageEvidence = async () => ({ clean: true, aheadCommits: 2 });
      s.launchReworkSalvage = async (input) => { launches.push(input); };
      s.postPrComment = async ({ body }) => {
        if (body.includes('Rework salvage status:')) throw new Error('salvage comment transport failed');
      };
      const result = await runSelfImplement({ feature: 'F', goalFile: budgetGoalFile(), writeGoalExecutionRecord: () => {}, maxReworkRounds: 2, seams: s });
      expect(result).toMatchObject({ stage: 'gate-failed', salvage: 'launched' });
      expect(launches).toHaveLength(1);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(events).toContainEqual(expect.objectContaining({
      event: 'pr.comment.post-failed',
      data: expect.objectContaining({ number: 7, salvageAction: 'launched', error: 'salvage comment transport failed' }),
    }));
  });

  test('implementation failure does not inspect or launch salvage', async () => {
    let evidenceReads = 0;
    let launches = 0;
    const s = seams({ implement: async () => ({ ok: false, summary: 'implementation failed' }) });
    s.readReworkSalvageEvidence = async () => { evidenceReads++; return { clean: true, aheadCommits: 2 }; };
    s.launchReworkSalvage = async () => { launches++; };
    const result = await runSelfImplement({ feature: 'F', goalFile: budgetGoalFile(), writeGoalExecutionRecord: () => {}, seams: s });
    expect(result).toMatchObject({ stage: 'aborted', outcome: 'abandoned' });
    expect(evidenceReads).toBe(0);
    expect(launches).toBe(0);
  });

  test('gate failure without hard-cap EXTEND parks and posts its existing reason without inspecting or launching salvage', async () => {
    const original = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      let evidenceReads = 0;
      let launches = 0;
      const comments: Array<{ number: number; body: string }> = [];
      const s = seams({ gateResults: [false] });
      s.readReworkSalvageEvidence = async () => { evidenceReads++; return { clean: true, aheadCommits: 2 }; };
      s.launchReworkSalvage = async () => { launches++; };
      s.postPrComment = async (comment) => { comments.push(comment); };
      const result = await runSelfImplement({ feature: 'F', goalFile: budgetGoalFile(), writeGoalExecutionRecord: () => {}, maxReworkRounds: 0, seams: s });
      expect(result).toMatchObject({ stage: 'gate-failed', outcome: 'budget-exhausted', salvage: 'parked', prNumber: 7 });
      expect(evidenceReads).toBe(0);
      expect(launches).toBe(0);
      expect(comments).toContainEqual(expect.objectContaining({ number: 7, body: expect.stringContaining('Rework salvage status: parked.\n\n- reason: not-hard-cap-extend') }));
      expect(events).toContainEqual(expect.objectContaining({ event: 'rework-salvage', data: expect.objectContaining({ action: 'parked', reason: 'not-hard-cap-extend' }) }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('UNCONVERGEABLE does not inspect or launch salvage even when committed output exists', async () => {
    const original = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    let evidenceReads = 0;
    let launches = 0;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const s = seams({ gateResults: [false, false] });
      s.diagnose = async () => 'BUDGET: UNCONVERGEABLE\nREASON: 반복 지적';
      s.judgmentCallLLM = async () => 'UNCONVERGEABLE';
      s.readReworkSalvageEvidence = async () => { evidenceReads++; return { clean: true, aheadCommits: 2 }; };
      s.launchReworkSalvage = async () => { launches++; };
      const result = await runSelfImplement({ feature: 'F', goalFile: budgetGoalFile(), writeGoalExecutionRecord: () => {}, maxReworkRounds: 2, seams: s });
      expect(result.outcome).toBe('abandoned');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(evidenceReads).toBe(0);
    expect(launches).toBe(0);
    expect(events.filter((entry) => entry.event === 'rework-salvage')).toHaveLength(0);
  });

  test('diagnose가 이력·골·kind·현재 상한을 받고 항목별·최근 라운드 상한이 적용된다', async () => {
    const seen: Array<{ runId: string; goal: string; kind: string; history: readonly string[]; effectiveMax: number; purpose?: string }> = [];
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => { events.push({ event, data: data as Record<string, unknown> }); }) as typeof debug.log;
    let diagnoseCall = 0;
    const s = seams({ gateResults: [false, false, false, false, false, true] });
    s.diagnose = async (ctx) => {
      if (ctx.purpose === 'escalation-triage') return 'TRIAGE: focus the retry';
      seen.push(ctx);
      diagnoseCall++;
      return diagnoseCall < 5 ? 'BUDGET: EXTEND\nREASON: 새 지적이 좁아짐' : 'BUDGET: EXTEND\nREASON: 마지막 수정';
    };
    let r;
    try {
      r = await runSelfImplement({ feature: 'GOAL_ACCEPTANCE_BOUNDARY', maxReworkRounds: 2, seams: s });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(r.stage).toBe('pr-opened');
    expect(seen).toHaveLength(5);
    expect(seen.map((entry) => entry.effectiveMax)).toEqual([2, 3, 4, 5, 6]);
    expect(typeof seen[0]!.runId).toBe('string');
    expect(seen[0]).toMatchObject({ goal: 'GOAL_ACCEPTANCE_BOUNDARY', kind: 'gate', effectiveMax: 2 });
    expect(events.find(({ event }) => event === 'rework-budget')?.data.runId).toBe(seen[0]!.runId);
    // ⭐ 이력은 **이전** 라운드만 — 현재 지적(`note`)은 이력에서 빠진다(자기 자신과 비교 금지·오탐 수리
    //   2026-07-27). 보관은 5라운드고 현재분 1건을 빼므로 판단자는 설계대로 최대 4라운드를 본다.
    expect(seen[4]!.history).toHaveLength(4);
    expect(seen[4]!.history.every((item) => item.length <= 1200)).toBe(true);
    // 첫 상담(round 1)은 비교 대상이 없다 — 이력이 비어야 "반복" 주장이 애초에 불가능하다.
    expect(seen[0]!.history).toHaveLength(0);
    // ⭐ 제목이 "이력을 받는다"이므로 **내용**을 단정한다(리뷰 should-fix — 개수만 세면 이력이 비어도 통과).
    //   이력의 존재 이유는 판단자가 *"같은 지적이 반복되나"* 를 보는 것이라, 종류 표지가 남아야 한다.
    expect(seen[4]!.history.every((item) => item.includes('gate 실패'))).toBe(true);
  });

  test('재작업 진단은 격리된 동일 goalId prior-runs 투영을 fail-soft로 전달한다', async () => {
    const goalFile = join(mkdtempSync(join(tmpdir(), 'goal-prior-runs-')), 'GOAL.md');
    writeFileSync(goalFile, '# Goal\n');
    const store = new GoalRunStore(':memory:');
    try {
      store.insert(goalFile, { runId: 'prior-run', stage: 'gate-failed', outcome: 'budget-exhausted', ok: false, lastReviewFindings: { items: ['same finding'], itemCount: 1, shownChars: 12, totalChars: 12, truncated: false, fullyIncludedItems: 1, truncatedItems: 0, omittedItems: 0 } }, 'same-goal');
      const seen: Array<unknown> = [];
      const s = seams({ gateResults: [false, true], priorRunsByGoalId: (goalId, limit) => store.priorRunsByGoalId(goalId, limit) });
      s.diagnose = async (ctx) => {
        seen.push(ctx.priorRuns);
        return 'BUDGET: EXTEND\nREASON: one more round';
      };
      await runSelfImplement({ feature: 'F', goalId: 'same-goal', goalFile, maxReworkRounds: 1, writeGoalExecutionRecord: () => {}, seams: s });
      expect(seen).toEqual([{
        priorRuns: [expect.objectContaining({ runId: 'prior-run', outcome: 'budget-exhausted', mustFixDigest: ['same finding'] })],
        total: 1,
        truncated: false,
      }]);
    } finally {
      store.close();
    }
  });

  test('재작업 진단은 prior-runs 조회 예외에도 null을 전달하고 계속 실행한다', async () => {
    const seen: Array<unknown> = [];
    const s = seams({ gateResults: [false, true], priorRunsByGoalId: () => { throw new Error('ledger unavailable'); } });
    s.diagnose = async (ctx) => {
      seen.push(ctx.priorRuns);
      return 'BUDGET: EXTEND\nREASON: one more round';
    };
    const result = await runSelfImplement({ feature: 'F', goalId: 'same-goal-query-failure', maxReworkRounds: 1, writeGoalExecutionRecord: () => {}, seams: s });
    expect(result.stage).toBe('pr-opened');
    expect(seen).toEqual([null]);
  });

  test('SUFFICIENT는 review rework를 즉시 끝내지만 남은 must-fix로 auto-merge를 무장하지 않는다', async () => {
    openPrCalls = [];
    let implementationCalls = 0;
    let mergeCalls = 0;
    const s = revSeams({ reviews: [{ verdict: 'fail', mustFix: ['스타일 논쟁'], reviewed: true }] });
    s.implement = async () => { implementationCalls++; return { ok: true, summary: 'impl' }; };
    s.diagnose = async () => 'BUDGET: SUFFICIENT\nREASON: gate는 통과했고 남은 지적은 비블로커다';
    s.mergePr = async () => { mergeCalls++; return { merged: true }; };
    const r = await runSelfImplement({ feature: 'F', autoMerge: true, maxReworkRounds: 2, reworkBudgetShadowStop: false, seams: s });
    expect(r.stage).toBe('pr-opened');
    expect(implementationCalls).toBe(1);
    expect(mergeCalls).toBe(0);
    expect(openPrCalls[0]!.draft).toBe(true);
  });

  // ⭐ 실전 오탐 회귀 가드(run-9135a622 · 2026-07-27) — 첫 rework 상담에는 비교할 이전 라운드가 없다.
  //   그때 UNCONVERGEABLE 을 그대로 집행하면 **게이트를 통과한 런이 1라운드 만에 죽는다**(실측).
  test('첫 상담(이전 라운드 0)의 UNCONVERGEABLE 은 종료시키지 않고 decomposition shadow도 남기지 않는다', async () => {
    const original = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      let implementationCalls = 0;
      const s = revSeams({ reviews: [{ verdict: 'fail', mustFix: ['같은 지적'] }, { verdict: 'pass' }] });
      s.implement = async () => { implementationCalls++; return { ok: true, summary: 'impl' }; };
      s.diagnose = async () => 'BUDGET: UNCONVERGEABLE\nREASON: 같은 지적이 반복된다';
      await runSelfImplement({ feature: 'src/a.ts and docs/b.md', maxReworkRounds: 2, seams: s });
      expect(implementationCalls).toBeGreaterThan(1);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(events.filter((entry) => entry.event === 'decomposition-shadow')).toHaveLength(0);
  });

  test('decomposition shadow derives splittability solely from deterministic eligible paths', () => {
    expect(inferDecompositionShadow('src/a.ts and docs/b.md')).toEqual({
      splittable: true,
      candidatePieceCount: 2,
      paths: ['src/a.ts', 'docs/b.md'],
      reason: '2 eligible path(s) produce 2 candidate piece(s).',
    });
    expect(inferDecompositionShadow('src/a.ts')).toMatchObject({
      splittable: false,
      candidatePieceCount: 1,
      paths: ['src/a.ts'],
    });
  });

  test('UNCONVERGEABLE은 비교 대상이 생긴 뒤 review와 gate rework를 실패로 끝내되 산출물을 draft PR로 보존한다', async () => {
    const { debug } = await import('../debug/log.js');
    const original = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const progressLines: string[] = [];
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      let implementationCalls = 0;
      let diagnoseCall = 0;
      let reviewPr: { draft?: boolean; body: string } | undefined;
      let mergeCalls = 0;
      const reviewSeams = revSeams({ reviews: [{ verdict: 'fail', mustFix: ['첫 지적'] }, { verdict: 'fail', mustFix: ['마지막 must-fix'] }] });
      reviewSeams.implement = async () => { implementationCalls++; return { ok: true, summary: 'impl' }; };
      reviewSeams.openPr = async ({ draft, body }) => { reviewPr = { draft, body }; return { url: 'https://pr/review-blocked', number: 41 }; };
      reviewSeams.mergePr = async () => { mergeCalls++; return { merged: true }; };
      reviewSeams.diagnose = async () => (++diagnoseCall === 1
        ? 'BUDGET: EXTEND\nREASON: 아직 판단 이르다'
        : 'BUDGET: UNCONVERGEABLE\nREASON: 같은 지적이 반복된다');

      let gateDiagnoseCalls = 0;
      let gatePr: { draft?: boolean; body: string } | undefined;
      const gateSeams = seams({ gateResults: [false] });
      gateSeams.openPr = async ({ draft, body }) => { gatePr = { draft, body }; return { url: 'https://pr/gate-failed', number: 42 }; };
      gateSeams.diagnose = async () => (++gateDiagnoseCalls === 1
        ? 'BUDGET: EXTEND\nREASON: 아직 판단 이르다'
        : 'BUDGET: UNCONVERGEABLE\nREASON: gate failure cannot converge');

      reviewSeams.onProgress = ({ message }) => { progressLines.push(message); };
      gateSeams.onProgress = ({ message }) => { progressLines.push(message); };
      const reviewResult = await runSelfImplement({ feature: 'review', autoMerge: true, maxReworkRounds: 5, reworkBudgetShadowStop: false, seams: reviewSeams });
      const gateResult = await runSelfImplement({ feature: 'src/a.ts and docs/b.md', maxReworkRounds: 5, reworkBudgetShadowStop: false, seams: gateSeams });

      for (const result of [reviewResult, gateResult]) {
        expect(TERMINAL_STAGES_BY_NODE[result.node] as readonly string[]).toContain(result.stage);
      }
      expect(reviewResult).toMatchObject({ ok: false, stage: 'review-blocked', node: 'rework', outcome: 'abandoned', prUrl: 'https://pr/review-blocked', prNumber: 41 });
      expect(gateResult).toMatchObject({ ok: false, stage: 'gate-failed', node: 'rework', outcome: 'abandoned', prUrl: 'https://pr/gate-failed', prNumber: 42 });
      expect(reviewResult.supervisorWantedContinue).toBeUndefined();
      expect(gateResult.supervisorWantedContinue).toBeUndefined();
      expect(implementationCalls).toBe(2);
      expect(reviewResult.detail).toContain('unconvergeable');
      expect(gateResult.detail).toContain('unconvergeable');
      expect(reviewPr).toMatchObject({ draft: true });
      expect(gatePr).toMatchObject({ draft: true });
      expect(reviewPr?.body).toContain('verdict: UNCONVERGEABLE');
      expect(reviewPr?.body).toContain('reason: 같은 지적이 반복된다');
      expect(reviewPr?.body).toContain('rework rounds: 2');
      expect(reviewPr?.body).toContain('마지막 must-fix');
      expect(reviewPr?.body).toContain('- 분해 판정 (경로 세기 폴백): 쪼갤 수 없음 — 분해기가 조각을 내지 못해 경로 세기로 폴백');
      expect(gatePr?.body).toContain('- 분해 판정 (경로 세기 폴백): 조각 후보 2개 (src/a.ts, docs/b.md) — 분해기가 조각을 내지 못해 경로 세기로 폴백');
      expect(mergeCalls).toBe(0);
      expect(events.filter((entry) => entry.event === 'rework-blocked-draft-pr')).toEqual(expect.arrayContaining([
        expect.objectContaining({ data: expect.objectContaining({ number: 41, autoMerge: false, rounds: 2 }) }),
        expect.objectContaining({ data: expect.objectContaining({ number: 42, autoMerge: false, rounds: 2 }) }),
      ]));
      // ⛔⭐ `arrayContaining` «만»으로는 중복 발생도 통과한다(리뷰 should-fix ②).
      //    ⇒ 종결 런당 «정확히 몇 줄»인지를 개수로 먼저 고정하고, 그 다음 내용을 본다.
      const shadows = events.filter((entry) => entry.event === 'decomposition-shadow');
      expect(shadows).toHaveLength(2);
      expect(shadows).toEqual(expect.arrayContaining([
        expect.objectContaining({ data: expect.objectContaining({ splittable: true, candidatePieceCount: 2, paths: ['src/a.ts', 'docs/b.md'], reason: '2 eligible path(s) produce 2 candidate piece(s).' }) }),
        expect.objectContaining({ data: expect.objectContaining({ splittable: false, candidatePieceCount: 0, paths: [] }) }),
      ]));
      expect(events.filter((entry) => entry.event === 'rework-budget')).toEqual(expect.arrayContaining([
        expect.objectContaining({ data: expect.objectContaining({ verdict: 'UNCONVERGEABLE', stopped: true, exit: 'blocked' }) }),
      ]));
      expect(progressLines).toEqual(expect.arrayContaining([
        '분해 판정 (경로 세기 폴백): 조각 후보 2개 (src/a.ts, docs/b.md) — 분해기가 조각을 내지 못해 경로 세기로 폴백',
        '분해 판정 (경로 세기 폴백): 쪼갤 수 없음 — 분해기가 조각을 내지 못해 경로 세기로 폴백',
      ]));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('decompositionShadow enabled는 실제 UNCONVERGEABLE 종료에서 조각 종류와 의존 관계를 한 번 관측한다', async () => {
    const original = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const progressLines: string[] = [];
    let body = '';
    let decomposeCalls = 0;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    setUserConfigOverlay((config) => ({
      ...config,
      tools: {
        ...config.tools,
        selfImplement: { ...config.tools.selfImplement, decompositionShadow: { enabled: true } },
      },
    }));
    try {
      let diagnoseCalls = 0;
      const s = revSeams({ reviews: [{ verdict: 'fail', mustFix: ['첫 지적'] }, { verdict: 'fail', mustFix: ['반복 지적'] }] });
      s.diagnose = async () => (++diagnoseCalls === 1
        ? 'BUDGET: EXTEND\nREASON: 비교 이력을 만든다'
        : 'BUDGET: UNCONVERGEABLE\nREASON: 반복되어 수렴할 수 없다');
      s.decomposeShadowGoals = async () => {
        decomposeCalls++;
        return {
          goals: [
            { id: 'config', feature: 'configure decomposition shadow', dependsOn: [], goalType: 'implement', hotPaths: ['src/config.ts'] },
            { id: 'observe', feature: 'observe decomposition results', dependsOn: ['config'], hotPaths: [] },
          ],
          decomposition: { recommendedMaxTasks: 6, actualTaskCount: 2, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'decomposed' },
        };
      };
      s.openPr = async ({ body: draftBody }) => { body = draftBody; return { url: 'https://pr/decomposition', number: 11 }; };
      s.onProgress = ({ message }) => { progressLines.push(message); };

      await expect(runSelfImplement({ feature: 'F', maxReworkRounds: 5, reworkBudgetShadowStop: false, seams: s }))
        .resolves.toMatchObject({
          stage: 'review-blocked',
          outcome: 'abandoned',
          supervisorVerdict: 'UNCONVERGEABLE',
          goalCauseObserved: true,
          abandonedClassification: {
            classification: 'goal-unconvergeable-candidate',
            classificationBasis: 'supervisor-unconvergeable-goal-candidate',
            supervisorVerdict: 'UNCONVERGEABLE',
            goalCauseObserved: true,
          },
        });
    } finally {
      setUserConfigOverlay(null);
      (debug as { log: typeof debug.log }).log = original;
    }

    expect(decomposeCalls).toBe(1);
    const observed = events.filter((entry) => entry.event === 'decomposition-shadow-goals');
    expect(observed).toHaveLength(1);
    expect(observed[0]?.data).toMatchObject({
      round: 2,
      pieceCount: 2,
      pieces: [
        { id: 'config', feature: 'configure decomposition shadow', dependsOn: [], goalType: 'implement', hotPaths: ['src/config.ts'] },
        { id: 'observe', feature: 'observe decomposition results', dependsOn: ['config'] },
      ],
    });
    expect(events.filter((entry) => entry.event === 'decomposition-shadow')).toHaveLength(1);
    expect(events.filter((entry) => entry.event === 'decomposition-shadow-fallback')).toHaveLength(0);
    expect(progressLines).toEqual(expect.arrayContaining([
      '분해 판정 (구조화 분해기): 조각 2개',
      '  - config (종류: implement, 의존: 없음)',
      '  - observe (종류: 없음, 의존: config)',
    ]));
    expect(body).toContain('- config (종류: implement, 의존: 없음)');
    expect(body).toContain('- observe (종류: 없음, 의존: config)');
  });

  test('budget-stop terminal decomposition distinguishes two pieces in result, observation, and execution records without scheduling a retry', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'terminal-decomposition-classification-'));
    const goalFile = join(directory, 'GOAL-terminal-decomposition.txt');
    const goalRunStore = new GoalRunStore(join(directory, 'self-implement', 'goal-runs.db'));
    const original = (debug as { log: typeof debug.log }).log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    writeFileSync(goalFile, '- GoalId: 49f6ca39e8c0e954\n');
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    setUserConfigOverlay((config) => ({
      ...config,
      tools: {
        ...config.tools,
        selfImplement: { ...config.tools.selfImplement, decompositionShadow: { enabled: true } },
      },
    }));
    try {
      const runCase = async (name: string, goals: Array<{ id: string; feature: string }>, expected: {
        classification: string;
        classificationBasis: string;
        goalCauseObserved?: true;
      }) => {
        const executionRecords: GoalExecutionRecord[] = [];
        const eventStart = events.length;
        let diagnosisCalls = 0;
        let decompositionCalls = 0;
        const s = revSeams({ reviews: [{ verdict: 'fail', mustFix: ['first blocking finding'] }, { verdict: 'fail', mustFix: ['repeated blocking finding'] }] });
        s.diagnose = async () => (++diagnosisCalls === 1
          ? 'BUDGET: EXTEND\nREASON: establish a comparison round'
          : 'BUDGET: UNCONVERGEABLE\nREASON: budget stop cannot converge');
        s.decomposeShadowGoals = async () => {
          decompositionCalls++;
          return {
            goals,
            decomposition: { recommendedMaxTasks: 6, actualTaskCount: goals.length, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: goals.length >= 2 ? 'decomposed' as const : 'single-no-subtasks' as const },
          };
        };

        const result = await runSelfImplement({
          feature: `terminal decomposition ${name}`,
          runId: `run-terminal-decomposition-${name}`,
          goalFile,
          maxReworkRounds: 5,
          reworkBudgetShadowStop: false,
          writeGoalExecutionRecord: (_path, record) => { executionRecords.push(record); },
          writeGoalRunRecord: (path, record, goalId) => { goalRunStore.insert(path, record, goalId); },
          seams: s,
        });

        expect(diagnosisCalls).toBe(2);
        expect(decompositionCalls).toBe(1);
        expect(result).toMatchObject({
          outcome: 'abandoned',
          supervisorVerdict: 'UNCONVERGEABLE',
          abandonedClassification: expected,
          ...(expected.goalCauseObserved ? { goalCauseObserved: true } : {}),
        });
        if (!expected.goalCauseObserved) expect(result.goalCauseObserved).toBeUndefined();
        expect(executionRecords).toEqual([expect.objectContaining({
          failureClassification: expected.classification,
          classificationBasis: expected.classificationBasis,
          ...(expected.goalCauseObserved ? { goalCauseObserved: true } : {}),
        })]);
        expect(goalRunStore.byRunId(`run-terminal-decomposition-${name}`)[0]?.record).toMatchObject({
          failureClassification: expected.classification,
          classificationBasis: expected.classificationBasis,
          ...(expected.goalCauseObserved ? { goalCauseObserved: true } : {}),
        });
        const classificationEvents = events.slice(eventStart).filter((entry) => entry.event === 'abandoned-classification' && entry.data.classification === expected.classification);
        expect(classificationEvents).toHaveLength(1);
        expect(classificationEvents[0]?.data).toMatchObject({
          ...(expected.goalCauseObserved ? { goalCauseObserved: true } : {}),
        });
        if (!expected.goalCauseObserved) {
          expect('goalCauseObserved' in executionRecords[0]!).toBe(false);
          expect('goalCauseObserved' in goalRunStore.byRunId(`run-terminal-decomposition-${name}`)[0]!.record).toBe(false);
          expect('goalCauseObserved' in classificationEvents[0]!.data).toBe(false);
        }
      };

      await runCase('two-pieces', [
        { id: 'one', feature: 'first independent piece' },
        { id: 'two', feature: 'second independent piece' },
      ], {
        classification: 'goal-unconvergeable-candidate',
        classificationBasis: 'supervisor-unconvergeable-goal-candidate',
        goalCauseObserved: true,
      });
      await runCase('no-pieces', [], {
        classification: 'implementation-deficit',
        classificationBasis: 'must-fix-reported',
      });
      await runCase('one-piece', [{ id: 'only', feature: 'a single piece is insufficient' }], {
        classification: 'implementation-deficit',
        classificationBasis: 'must-fix-reported',
      });
    } finally {
      setUserConfigOverlay(null);
      (debug as { log: typeof debug.log }).log = original;
      goalRunStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('decompositionShadow 분해기 실패는 UNCONVERGEABLE 종료와 draft PR을 경로 세기 폴백으로 보존한다', async () => {
    const original = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    let body = '';
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    setUserConfigOverlay((config) => ({
      ...config,
      tools: {
        ...config.tools,
        selfImplement: { ...config.tools.selfImplement, decompositionShadow: { enabled: true } },
      },
    }));
    try {
      let diagnoseCalls = 0;
      const s = revSeams({ reviews: [{ verdict: 'fail', mustFix: ['첫 지적'] }, { verdict: 'fail', mustFix: ['반복 지적'] }] });
      s.diagnose = async () => (++diagnoseCalls === 1
        ? 'BUDGET: EXTEND\nREASON: 비교 이력을 만든다'
        : 'BUDGET: UNCONVERGEABLE\nREASON: 반복되어 수렴할 수 없다');
      s.decomposeShadowGoals = async () => { throw new Error('decomposition unavailable'); };
      s.openPr = async ({ body: draftBody }) => { body = draftBody; return { url: 'https://pr/blocked', number: 8 }; };

      await expect(runSelfImplement({ feature: 'src/a.ts and docs/b.md', maxReworkRounds: 5, reworkBudgetShadowStop: false, seams: s }))
        .resolves.toMatchObject({ stage: 'review-blocked', outcome: 'abandoned', prUrl: 'https://pr/blocked' });
    } finally {
      setUserConfigOverlay(null);
      (debug as { log: typeof debug.log }).log = original;
    }

    expect(body).toContain('분해 판정 (경로 세기 폴백): 조각 후보 2개 (src/a.ts, docs/b.md) — 분해기 실패로 경로 세기로 폴백');
    expect(events.filter((entry) => entry.event === 'decomposition-shadow-goals')).toHaveLength(0);
    expect(events.filter((entry) => entry.event === 'decomposition-shadow')).toHaveLength(1);
  });

  test('decompositionShadow 동기 폴백은 빈 조각과 분해기 예외를 구분해 한 번씩 관측하고 진행 산출과 종료를 보존한다', async () => {
    const original = debug.log;
    const fallbackEvents: Array<{ event: string; data: Record<string, unknown> }> = [];
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      fallbackEvents.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    setUserConfigOverlay((config) => ({
      ...config,
      tools: {
        ...config.tools,
        selfImplement: { ...config.tools.selfImplement, decompositionShadow: { enabled: true } },
      },
    }));
    try {
      for (const [name, decomposeShadowGoals, reason] of [
        ['empty', async () => ({
          goals: [],
          decomposition: { recommendedMaxTasks: 6, actualTaskCount: 0, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'decomposed' as const },
        }), 'no-fragments'],
        ['failed', async () => { throw new Error('decomposition unavailable'); }, 'decomposer-failed'],
      ] as const) {
        let diagnoseCalls = 0;
        let body = '';
        const progressLines: string[] = [];
        const s = revSeams({ reviews: [{ verdict: 'fail', mustFix: ['첫 지적'] }, { verdict: 'fail', mustFix: ['반복 지적'] }] });
        s.diagnose = async () => (++diagnoseCalls === 1
          ? 'BUDGET: EXTEND\nREASON: 비교 이력을 만든다'
          : 'BUDGET: UNCONVERGEABLE\nREASON: 반복되어 수렴할 수 없다');
        s.decomposeShadowGoals = decomposeShadowGoals;
        s.openPr = async ({ body: draftBody }) => { body = draftBody; return { url: `https://pr/${name}`, number: 10 }; };
        s.onProgress = ({ message }) => { progressLines.push(message); };

        await expect(runSelfImplement({ feature: 'src/a.ts and docs/b.md', maxReworkRounds: 5, reworkBudgetShadowStop: false, seams: s }))
          .resolves.toMatchObject({ stage: 'review-blocked', outcome: 'abandoned', prUrl: `https://pr/${name}` });

        const observed = fallbackEvents.filter((entry) => entry.event === 'decomposition-shadow-fallback' && entry.data.reason === reason);
        expect(observed).toHaveLength(1);
        expect(observed[0]?.data).toMatchObject({ round: 2, reason });
        expect(observed[0]?.data.reason).not.toBe('deadline-exceeded');
        expect(progressLines).toContain(`분해 판정 (경로 세기 폴백): 조각 후보 2개 (src/a.ts, docs/b.md) — ${reason === 'no-fragments' ? '분해기가 조각을 내지 못해 경로 세기로 폴백' : '분해기 실패로 경로 세기로 폴백'}`);
        expect(body).toContain(reason === 'no-fragments' ? '분해기가 조각을 내지 못해 경로 세기로 폴백' : '분해기 실패로 경로 세기로 폴백');
      }
    } finally {
      setUserConfigOverlay(null);
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('decomposition fallback observation preserves zero and omits unreadable shadow values', () => {
    expect(decompositionFallbackObservation({ candidatePieceCount: 0, paths: [] })).toEqual({
      fallbackCandidatePieceCount: 0,
      fallbackPaths: [],
      fallbackPathsTruncated: false,
    });
    expect(decompositionFallbackObservation({
      get candidatePieceCount(): number { throw new Error('unreadable'); },
      paths: [],
    })).toEqual({});
  });

  test('decomposition fallback observation caps paths and reports truncation', () => {
    const paths = Array.from({ length: DECOMPOSITION_FALLBACK_PATHS_OBSERVATION_LIMIT + 2 }, (_, index) => `src/path-${index}.ts`);
    expect(decompositionFallbackObservation({ candidatePieceCount: paths.length, paths })).toEqual({
      fallbackCandidatePieceCount: paths.length,
      fallbackPaths: paths.slice(0, DECOMPOSITION_FALLBACK_PATHS_OBSERVATION_LIMIT),
      fallbackPathsTruncated: true,
    });
  });

  test('decompositionShadow deadline은 UNCONVERGEABLE 종료를 막지 않고 늦은 성공 조각을 별도 관측에 보존한다', async () => {
    const original = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const progressLines: string[] = [];
    let body = '';
    let diagnoseCalls = 0;
    let release!: (value: Awaited<ReturnType<NonNullable<SelfImplementSeams['decomposeShadowGoals']>>>) => void;
    const deferred = new Promise<Parameters<NonNullable<SelfImplementSeams['decomposeShadowGoals']>>[0] extends never ? never : Awaited<ReturnType<NonNullable<SelfImplementSeams['decomposeShadowGoals']>>>>((resolve) => { release = resolve; });
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const s = revSeams({ reviews: [{ verdict: 'fail', mustFix: ['첫 지적'] }, { verdict: 'fail', mustFix: ['반복 지적'] }] });
      s.diagnose = async () => (++diagnoseCalls === 1
        ? 'BUDGET: EXTEND\nREASON: 비교 이력을 만든다'
        : 'BUDGET: UNCONVERGEABLE\nREASON: 반복되어 수렴할 수 없다');
      s.decomposeShadowGoals = async () => await deferred;
      s.openPr = async ({ body: draftBody }) => { body = draftBody; return { url: 'https://pr/timeout', number: 9 }; };
      s.onProgress = ({ message }) => { progressLines.push(message); };

      const fallbackPaths = Array.from(
        { length: DECOMPOSITION_FALLBACK_PATHS_OBSERVATION_LIMIT + 2 },
        (_, index) => `src/path-${index}.ts`,
      );
      await expect(runSelfImplement({
        feature: fallbackPaths.join(' and '),
        maxReworkRounds: 5,
        reworkBudgetShadowStop: false,
        stepTimeouts: { decomposition: 5 },
        seams: s,
      })).resolves.toMatchObject({ stage: 'review-blocked', outcome: 'abandoned', prUrl: 'https://pr/timeout' });

      const fallback = `분해 판정 (경로 세기 폴백): 조각 후보 ${fallbackPaths.length}개 (${fallbackPaths.join(', ')}) — 분해기 시간 초과로 경로 세기로 폴백`;
      expect(progressLines).toContain(fallback);
      expect(body).toContain(fallback);
      const deadlineEvents = events.filter((entry) => entry.event === 'decomposition-shadow-wait-exceeded');
      expect(deadlineEvents).toHaveLength(1);
      expect(deadlineEvents[0]?.data).toMatchObject({
        round: 2,
        deadlineMs: 5,
        reason: 'deadline-exceeded',
        fallbackCandidatePieceCount: fallbackPaths.length,
        fallbackPaths: fallbackPaths.slice(0, DECOMPOSITION_FALLBACK_PATHS_OBSERVATION_LIMIT),
        fallbackPathsTruncated: true,
      });
      expect(events.filter((entry) => entry.event === 'decomposition-shadow-fallback')).toHaveLength(0);

      release({
        goals: [{ id: 'late-piece', feature: 'late decomposition result', dependsOn: [], hotPaths: ['src/late.ts'] }],
        decomposition: { recommendedMaxTasks: 6, actualTaskCount: 1, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'decomposed' },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: 'decomposition-shadow-late-settled', data: expect.objectContaining({ status: 'fulfilled', outcome: 'structured-fragments', pieceCount: 1, pieces: [expect.objectContaining({ id: 'late-piece', hotPaths: ['src/late.ts'] })] }) }),
      ]));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('decompositionShadow deadline은 0개 폴백을 값 획득 실패와 구분해 기존 키를 한 번 보존한다', async () => {
    const original = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    let diagnoseCalls = 0;
    let release!: (value: Awaited<ReturnType<NonNullable<SelfImplementSeams['decomposeShadowGoals']>>>) => void;
    const deferred = new Promise<Awaited<ReturnType<NonNullable<SelfImplementSeams['decomposeShadowGoals']>>>>((resolve) => { release = resolve; });
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const s = revSeams({ reviews: [{ verdict: 'fail', mustFix: ['첫 지적'] }, { verdict: 'fail', mustFix: ['반복 지적'] }] });
      s.diagnose = async () => (++diagnoseCalls === 1
        ? 'BUDGET: EXTEND\nREASON: 비교 이력을 만든다'
        : 'BUDGET: UNCONVERGEABLE\nREASON: 반복되어 수렴할 수 없다');
      s.decomposeShadowGoals = async () => await deferred;

      await expect(runSelfImplement({
        feature: '시간 초과 폴백은 경로 없음',
        maxReworkRounds: 5,
        reworkBudgetShadowStop: false,
        stepTimeouts: { decomposition: 5 },
        seams: s,
      })).resolves.toMatchObject({ stage: 'review-blocked', outcome: 'abandoned' });

      const deadlineEvents = events.filter((entry) => entry.event === 'decomposition-shadow-wait-exceeded');
      expect(deadlineEvents).toHaveLength(1);
      expect(deadlineEvents[0]?.data).toEqual(expect.objectContaining({
        round: 2,
        deadlineMs: 5,
        reason: 'deadline-exceeded',
        fallbackCandidatePieceCount: 0,
        fallbackPaths: [],
        fallbackPathsTruncated: false,
      }));

      release({
        goals: [],
        decomposition: { recommendedMaxTasks: 6, actualTaskCount: 0, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'single-no-subtasks' },
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('decompositionShadow deadline 뒤 실패도 늦음과 분해 실패를 구분해 관측한다', async () => {
    const original = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    let reject!: (reason?: unknown) => void;
    const deferred = new Promise<never>((_resolve, rejectPromise) => { reject = rejectPromise; });
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      let diagnoseCalls = 0;
      const s = revSeams({ reviews: [{ verdict: 'fail', mustFix: ['첫 지적'] }, { verdict: 'fail', mustFix: ['반복 지적'] }] });
      s.diagnose = async () => (++diagnoseCalls === 1
        ? 'BUDGET: EXTEND\nREASON: 비교 이력을 만든다'
        : 'BUDGET: UNCONVERGEABLE\nREASON: 반복되어 수렴할 수 없다');
      s.decomposeShadowGoals = async () => await deferred;

      await expect(runSelfImplement({ feature: 'src/a.ts', maxReworkRounds: 5, reworkBudgetShadowStop: false, stepTimeouts: { decomposition: 5 }, seams: s }))
        .resolves.toMatchObject({ stage: 'review-blocked', outcome: 'abandoned' });
      reject(new Error('late decomposition failure'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: 'decomposition-shadow-wait-exceeded', data: expect.objectContaining({ reason: 'deadline-exceeded' }) }),
        expect.objectContaining({ event: 'decomposition-shadow-late-settled', data: expect.objectContaining({ status: 'rejected', outcome: 'decomposer-failed', error: 'late decomposition failure' }) }),
      ]));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('단일 구조화 조각도 UNCONVERGEABLE 진행 줄과 draft PR에 경로 세기 없이 유지한다', async () => {
    const progressLines: string[] = [];
    let body = '';
    let diagnoseCalls = 0;
    const s = revSeams({ reviews: [{ verdict: 'fail', mustFix: ['첫 지적'] }, { verdict: 'fail', mustFix: ['반복 지적'] }] });
    s.diagnose = async () => (++diagnoseCalls === 1
      ? 'BUDGET: EXTEND\nREASON: 비교 이력을 만든다'
      : 'BUDGET: UNCONVERGEABLE\nREASON: 반복되어 수렴할 수 없다');
    s.decomposeShadowGoals = async (feature) => ({
      goals: [{ id: 'atomic', feature, dependsOn: [] }],
      decomposition: { recommendedMaxTasks: 6, actualTaskCount: 1, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'single-no-subtasks' },
    });
    s.openPr = async ({ body: draftBody }) => { body = draftBody; return { url: 'https://pr/atomic', number: 10 }; };
    s.onProgress = ({ message }) => { progressLines.push(message); };

    await expect(runSelfImplement({
      feature: 'src/a.ts and docs/b.md',
      maxReworkRounds: 5,
      reworkBudgetShadowStop: false,
      seams: s,
    })).resolves.toMatchObject({ stage: 'review-blocked', outcome: 'abandoned', prUrl: 'https://pr/atomic' });

    expect(progressLines).toEqual(expect.arrayContaining([
      '분해 판정 (구조화 분해기): 조각 1개',
      '  - atomic (종류: 없음, 의존: 없음)',
    ]));
    expect(progressLines.join('\n')).not.toContain('경로 세기 폴백');
    expect(body).toContain('- 분해 판정 (구조화 분해기): 조각 1개');
    expect(body).toContain('- atomic (종류: 없음, 의존: 없음)');
    expect(body).not.toContain('경로 세기 폴백');
  });

  test('기본 decompositionShadow 비활성에서도 UNCONVERGEABLE은 구조화 조각·의존 관계를 진행 줄과 draft PR에 싣는다', async () => {
    const original = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const progressLines: string[] = [];
    let decomposeCalls = 0;
    let body = '';
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      let diagnoseCalls = 0;
      const s = revSeams({ reviews: [{ verdict: 'fail', mustFix: ['첫 지적'] }, { verdict: 'fail', mustFix: ['반복 지적'] }] });
      s.diagnose = async () => (++diagnoseCalls === 1
        ? 'BUDGET: EXTEND\nREASON: 비교 이력을 만든다'
        : 'BUDGET: UNCONVERGEABLE\nREASON: 반복되어 수렴할 수 없다');
      s.decomposeShadowGoals = async () => {
        decomposeCalls++;
        return {
          goals: [
            { id: 'prepare', feature: 'prepare decomposition', dependsOn: [] },
            { id: 'render', feature: 'render decomposition', dependsOn: ['prepare'] },
          ],
          decomposition: { recommendedMaxTasks: 6, actualTaskCount: 2, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'decomposed' },
        };
      };
      s.openPr = async ({ body: draftBody }) => { body = draftBody; return { url: 'https://pr/blocked', number: 8 }; };
      s.onProgress = ({ message }) => { progressLines.push(message); };

      await expect(runSelfImplement({ feature: 'F', maxReworkRounds: 5, reworkBudgetShadowStop: false, seams: s }))
        .resolves.toMatchObject({ stage: 'review-blocked', outcome: 'abandoned' });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }

    expect(decomposeCalls).toBe(1);
    expect(events.filter((entry) => entry.event === 'decomposition-shadow-goals')).toHaveLength(1);
    expect(progressLines).toEqual(expect.arrayContaining([
      '분해 판정 (구조화 분해기): 조각 2개',
      '  - prepare (종류: 없음, 의존: 없음)',
      '  - render (종류: 없음, 의존: prepare)',
    ]));
    expect(body).toContain('- 분해 판정 (구조화 분해기): 조각 2개');
    expect(body).toContain('- prepare (종류: 없음, 의존: 없음)');
    expect(body).toContain('- render (종류: 없음, 의존: prepare)');
  });

  // ⛔ 기본값(shadowStop=on) 회귀 자물쇠 — 이 테스트가 지키는 것은 **집행하지 않는다** 이다.
  //    한 하니스 자식이 이것을 shadowStop=false 케이스로 갈아치웠고(무인 리뷰 must-fix),
  //    그러면 기본 동작이 무방비가 된다. 둘은 **다른 계약**이라 둘 다 있어야 한다.
  test('기본 shadowStop은 review SUFFICIENT를 집행하지 않고 다음 rework를 수행한다', async () => {
    const features: string[] = [];
    const s = revSeams({
      features,
      reviews: [
        { verdict: 'fail', mustFix: ['첫 지적'] },
        { verdict: 'fail', mustFix: ['둘째 지적'] },
        { verdict: 'pass' },
      ],
    });
    s.diagnose = async () => 'BUDGET: SUFFICIENT\nREASON: 남은 지적은 비블로커다';
    const r = await runSelfImplement({ feature: 'F', maxReworkRounds: 2, reworkBudgetShadowStop: true, seams: s });
    expect(r.stage).toBe('pr-opened');
    expect(features).toHaveLength(3);
  });

  test('shadowStop=false는 review SUFFICIENT를 즉시 적용해 PR 단계로 진행한다', async () => {
    const features: string[] = [];
    const s = revSeams({
      features,
      reviews: [{ verdict: 'fail', mustFix: ['비블로커 지적'] }],
    });
    s.diagnose = async () => 'BUDGET: SUFFICIENT\nREASON: 남은 지적은 비블로커다';
    const r = await runSelfImplement({ feature: 'F', maxReworkRounds: 2, reworkBudgetShadowStop: false, seams: s });
    expect(r.stage).toBe('pr-opened');
    expect(features).toHaveLength(1);
  });

  test('shadowStop=true는 근거 있는 UNCONVERGEABLE를 집행하지 않고 다음 rework를 수행한다', async () => {
    const features: string[] = [];
    let diagnoseCall = 0;
    const s = revSeams({
      features,
      reviews: [
        { verdict: 'fail', mustFix: ['첫 지적'] },
        { verdict: 'fail', mustFix: ['둘째 지적'] },
        { verdict: 'pass' },
      ],
    });
    s.diagnose = async () => (++diagnoseCall === 1
      ? 'BUDGET: EXTEND\nREASON: 비교 이력을 만든다'
      : 'BUDGET: UNCONVERGEABLE\nREASON: 같은 지적이 반복된다');
    const r = await runSelfImplement({ feature: 'F', maxReworkRounds: 2, reworkBudgetShadowStop: true, seams: s });
    expect(r.stage).toBe('pr-opened');
    expect(features).toHaveLength(3);
  });

  // ⭐ 관측 계약(리뷰 should-fix) — 이 PR 의 **산출이 측정**이다. 집행을 유예해도 `shadowed`·`wouldExit`
  //   가 로그에 안 실리면 *"정지했다면 옳았을까"* 를 나중에 채점할 수 없고, 그러면 그림자 모드는
  //   그냥 "종료를 끈 것"에 지나지 않는다. 반환값이 아니라 **소비자가 받는 payload** 를 고정한다.
  test('그림자 정지 판정은 shadowed·wouldExit 를 관측에 싣는다(사후 채점 가능성)', async () => {
    const { debug } = await import('../debug/log.js');
    const original = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => { events.push({ event, data: data as Record<string, unknown> }); }) as typeof debug.log;
    let diagnoseCall = 0;
    try {
      const s = revSeams({
        reviews: [
          { verdict: 'fail', mustFix: ['첫 지적'] },
          { verdict: 'fail', mustFix: ['둘째 지적'] },
          { verdict: 'pass' },
        ],
      });
      s.diagnose = async () => (++diagnoseCall === 1
        ? 'BUDGET: EXTEND\nREASON: 비교 이력을 만든다'
        : 'BUDGET: UNCONVERGEABLE\nREASON: 같은 지적이 반복된다');
      await runSelfImplement({ feature: 'F', maxReworkRounds: 2, reworkBudgetShadowStop: true, seams: s });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    const budgets = events.filter((e) => e.event === 'rework-budget');
    // 라운드 1 = EXTEND — 그림자 대상이 아니다(연장은 반사실을 파괴하지 않으므로 항상 집행).
    expect(budgets[0]?.data).toMatchObject({ verdict: 'EXTEND', shadowed: false, applied: true, carriedBudgetAfter: 3 });
    expect(budgets[0]?.data.wouldExit).toBeUndefined();
    // 라운드 2 = UNCONVERGEABLE — 집행하지 않았고, 집행했다면 무엇이 됐을지가 남는다.
    expect(budgets[1]?.data).toMatchObject({
      verdict: 'UNCONVERGEABLE',
      shadowed: true,
      wouldExit: 'blocked',
      stopped: false,      // 런은 계속됐다 = 반사실이 보존됐다
      applied: false,
      carriedBudgetBefore: 3,
      carriedBudgetAfter: 3,
    });
  });

  test('그림자 SUFFICIENT 는 wouldExit:proceed 로 남는다', async () => {
    const { debug } = await import('../debug/log.js');
    const original = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => { events.push({ event, data: data as Record<string, unknown> }); }) as typeof debug.log;
    try {
      const s = revSeams({
        reviews: [
          { verdict: 'fail', mustFix: ['첫 지적'] },
          { verdict: 'fail', mustFix: ['둘째 지적'] },
          { verdict: 'pass' },
        ],
      });
      s.diagnose = async () => 'BUDGET: SUFFICIENT\nREASON: 남은 지적은 비블로커다';
      await runSelfImplement({ feature: 'F', maxReworkRounds: 2, reworkBudgetShadowStop: true, seams: s });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    const budget = events.find((e) => e.event === 'rework-budget');
    expect(budget?.data).toMatchObject({ verdict: 'SUFFICIENT', shadowed: true, wouldExit: 'proceed', stopped: false });
  });

  // ⚠️ 사유 구분(수용 기준) — 가드로 무시된 판정은 **그림자가 아니다.** 하나는 "근거 없는 판정을
  //   무시한 것"이고 다른 하나는 "근거 있을 수도 있는 판정을 측정 위해 유예한 것"이다. 채점할 때
  //   둘을 섞으면 오탐률이 그림자 표본을 오염시킨다.
  test('가드로 무시된 UNCONVERGEABLE 은 shadowed:false — 그림자와 사유가 구분된다', async () => {
    const { debug } = await import('../debug/log.js');
    const original = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => { events.push({ event, data: data as Record<string, unknown> }); }) as typeof debug.log;
    try {
      const s = seams({ gateResults: [false, true] });
      s.diagnose = async () => 'BUDGET: UNCONVERGEABLE\nREASON: 같은 지적이 반복된다';
      await runSelfImplement({ feature: 'F', reworkBudgetShadowStop: true, seams: s });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    const budget = events.find((e) => e.event === 'rework-budget');
    expect(budget?.data).toMatchObject({ verdict: 'UNCONVERGEABLE', shadowed: false, historyRounds: 0 });
    expect(budget?.data.wouldExit).toBeUndefined();
  });

  test('미주입 judgment provider는 기존 판정으로 폴백하지 않고 fail-close한다', async () => {
    const s = seams({ gateResults: [false, false, false] });
    s.diagnose = async () => 'BUDGET: EXTEND\nREASON: 한 라운드면 된다';
    delete (s as { judgmentCallLLM?: unknown }).judgmentCallLLM;
    await expect(runSelfImplement({ feature: 'F', maxReworkRounds: 2, seams: s }))
      .rejects.toThrow('rework-budget@v1 requires a judgment provider');
  });

  test('unsupported classification falls back once to the adaptive cap and completes the next round', async () => {
    const events: Array<{ event: string; data: Record<string, unknown>; level?: string }> = [];
    const features: string[] = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data, opt) => {
      events.push({ event, data: data as Record<string, unknown>, level: opt?.level });
    }) as typeof debug.log;
    try {
      const s = seams({ features, gateResults: [false, true] });
      s.diagnose = async () => 'BUDGET: EXTEND\nREASON: repair gate';
      s.judgmentCallLLM = async () => 'unknown';
      const result = await runSelfImplement({ feature: 'unsupported classification once', maxReworkRounds: 1, seams: s });
      expect(result).toMatchObject({ stage: 'pr-opened', ok: true });
      expect(features).toHaveLength(2);
      expect(features[1]).toContain('[라운드 1/1');
      const fallback = events.filter(({ event }) => event === 'rework-budget-unresolved-fallback');
      expect(fallback).toHaveLength(1);
      expect(fallback[0]).toMatchObject({ level: 'warn', data: { round: 1, consecutive: 1, error: expect.stringContaining('classification did not resolve a supported class') } });
      expect(String(fallback[0]!.data.error).length).toBeLessThanOrEqual(200);
    } finally { (debug as { log: typeof debug.log }).log = original; }
  });

  test('two consecutive unsupported classifications preserve the draft and decomposition instead of throwing', async () => {
    const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
    const features: string[] = [];
    const opened: Array<{ draft?: boolean; body: string }> = [];
    let decomposeCalls = 0;
    const repo = mkdtempSync(join(tmpdir(), 'unresolved-budget-preservation-'));
    const preservedBodyPath = join(repo, 'blocked-draft-body.md');
    const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    try {
      expect(git('init', '-q').status).toBe(0);
      expect(git('config', 'user.email', 'test@example.com').status).toBe(0);
      expect(git('config', 'user.name', 'Test').status).toBe(0);
      writeFileSync(join(repo, 'artifact.ts'), 'export const baseline = true;\n');
      expect(git('add', 'artifact.ts').status).toBe(0);
      expect(git('commit', '-qm', 'baseline').status).toBe(0);
      const base = git('rev-parse', 'HEAD').stdout.trim();
      const artifact = 'export const preservedWork = "unresolved-budget";\n';
      const s = seams({ features, gateResults: [false, false, false] });
      s.createWorktree = async ({ branch }) => ({ path: repo, branch, resolvedBase: base });
      s.implement = async ({ feature }) => { features.push(feature); writeFileSync(join(repo, 'artifact.ts'), artifact); return { ok: true, summary: 'preserved artifact.ts' }; };
      s.preservationHasChanges = ({ cwd, base: preservationBase }) => preservationHasChanges(cwd, preservationBase);
      s.writeRunLedger = ({ event, data }) => { ledger.push({ event, data }); };
      s.diagnose = async () => 'BUDGET: EXTEND\nREASON: try repair';
      s.judgmentCallLLM = async () => 'unknown';
      s.decomposeShadowGoals = async () => { decomposeCalls++; return { goals: [], decomposition: { recommendedMaxTasks: 6, actualTaskCount: 0, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'single-no-subtasks' } }; };
      s.openPr = async ({ draft, body, cwd }) => {
        expect(cwd).toBe(repo);
        expect(readFileSync(join(cwd, 'artifact.ts'), 'utf8')).toBe(artifact);
        writeFileSync(preservedBodyPath, body);
        opened.push({ draft, body });
        return { url: 'https://pr/unresolved', number: 81 };
      };
      const result = await runSelfImplement({ feature: 'src/a.ts and docs/b.md', maxReworkRounds: 3, seams: s });
      expect(result).toMatchObject({ stage: 'gate-failed', node: 'rework', worktreePath: repo, prUrl: 'https://pr/unresolved', supervisorVerdict: 'UNCONVERGEABLE' });
      expect(result.detail).toContain('rework-budget classification unresolved ×2');
      expect(readFileSync(join(result.worktreePath!, 'artifact.ts'), 'utf8')).toBe(artifact);
      expect(git('diff', base, '--', 'artifact.ts').stdout).toContain('preservedWork');
      expect(features).toHaveLength(2);
      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatchObject({ draft: true, body: expect.stringContaining('rework-budget classification unresolved ×2') });
      expect(readFileSync(preservedBodyPath, 'utf8')).toContain('rework-budget classification unresolved ×2');
      expect(readFileSync(preservedBodyPath, 'utf8')).toContain('preserved artifact.ts');
      expect(decomposeCalls).toBe(1);
      expect(ledger.filter(({ event }) => event === 'rework-budget-unresolved-fallback').map(({ data }) => data.consecutive)).toEqual([1, 2]);
      expect(ledger.filter(({ event }) => event === 'rework-blocked-draft-pr')).toHaveLength(1);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test('an explicitly unsupported class error uses the same bounded fallback', async () => {
    const features: string[] = [];
    const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
    const s = seams({ features, gateResults: [false, true] });
    s.writeRunLedger = ({ event, data }) => { ledger.push({ event, data }); };
    s.diagnose = async () => 'BUDGET: EXTEND\nREASON: retry';
    const failure = `rework-budget@v1 returned unsupported class '${'x'.repeat(240)}'`;
    s.judgmentCallLLM = async () => { throw new Error(failure); };
    const result = await runSelfImplement({ feature: 'unsupported class', maxReworkRounds: 1, seams: s });
    expect(result.stage).toBe('pr-opened');
    expect(features).toHaveLength(2);
    expect(ledger.filter(({ event }) => event === 'rework-budget-unresolved-fallback')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ round: 1, consecutive: 1, error: failure.slice(0, 200) }) }),
    ]);
  });

  test('judgment executor 오류는 fail-soft diagnose 경로로 삼켜지지 않는다', async () => {
    const features: string[] = [];
    const s = seams({ features, gateResults: [false, true] });
    s.diagnose = async () => 'BUDGET: EXTEND\nREASON: 한 라운드면 된다';
    s.judgmentCallLLM = async () => { throw new Error('judgment executor down'); };
    await expect(runSelfImplement({ feature: 'F', seams: s })).rejects.toThrow('judgment executor down');
    expect(features).toHaveLength(1);
  });

  test('workflow provider의 네 분류는 실제 rework 실행 결말과 일치한다', async () => {
    const extendFeatures: string[] = [];
    const extend = seams({ features: extendFeatures, gateResults: [false, true] });
    extend.diagnose = async () => 'BUDGET: EXTEND\nREASON: 진단 입력';
    extend.judgmentCallLLM = async () => 'EXTEND';
    await expect(runSelfImplement({ feature: 'F', seams: extend })).resolves.toMatchObject({ stage: 'pr-opened' });
    expect(extendFeatures).toHaveLength(2);

    const gateSufficientFeatures: string[] = [];
    const gateSufficient = seams({ features: gateSufficientFeatures, gateResults: [false, true] });
    gateSufficient.diagnose = async () => 'BUDGET: SUFFICIENT\nREASON: 진단 입력';
    gateSufficient.judgmentCallLLM = async () => 'SUFFICIENT';
    await expect(runSelfImplement({ feature: 'F', seams: gateSufficient })).resolves.toMatchObject({ stage: 'pr-opened' });
    expect(gateSufficientFeatures).toHaveLength(2);

    const reviewSufficientFeatures: string[] = [];
    const reviewSufficient = revSeams({ features: reviewSufficientFeatures, reviews: [{ verdict: 'fail', mustFix: ['비블로커'] }] });
    reviewSufficient.diagnose = async () => 'BUDGET: SUFFICIENT\nREASON: 진단 입력';
    reviewSufficient.judgmentCallLLM = async () => 'SUFFICIENT';
    await expect(runSelfImplement({ feature: 'F', reworkBudgetShadowStop: false, seams: reviewSufficient }))
      .resolves.toMatchObject({ stage: 'pr-opened' });
    expect(reviewSufficientFeatures).toHaveLength(1);

    let calls = 0;
    const abandonFeatures: string[] = [];
    const abandon = revSeams({ features: abandonFeatures, reviews: [{ verdict: 'fail', mustFix: ['반복'] }] });
    abandon.diagnose = async () => 'BUDGET: UNCONVERGEABLE\nREASON: 진단 입력';
    abandon.judgmentCallLLM = async () => ++calls === 1 ? 'EXTEND' : 'UNCONVERGEABLE';
    await expect(runSelfImplement({ feature: 'F', maxReworkRounds: 5, reworkBudgetShadowStop: false, seams: abandon }))
      .resolves.toMatchObject({ stage: 'review-blocked', outcome: 'abandoned' });
    expect(abandonFeatures).toHaveLength(2);
  });

  test('diagnose 예외는 종전 fail-count 폴백을 타서 gate 실패 후 3회 구현한다', async () => {
    const features: string[] = [];
    const s = seams({ features, gateResults: [false, false, false] });
    s.diagnose = async () => { throw new Error('judge unavailable'); };
    const r = await runSelfImplement({ feature: 'F', maxReworkRounds: 2, seams: s });
    expect(r.stage).toBe('gate-failed');
    expect(features).toHaveLength(3);
  });

  test('판정 관측은 verdict·근거·입력 이력을 발화한다', async () => {
    const { debug } = await import('../debug/log.js');
    const original = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => { events.push({ event, data: data as Record<string, unknown> }); }) as typeof debug.log;
    try {
      const s = seams({ gateResults: [false, true] });
      s.diagnose = async () => 'BUDGET: EXTEND\nREASON: 새 지적이 좁아짐';
      await runSelfImplement({ feature: 'F', seams: s });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    const event = events.find((entry) => entry.event === 'rework-budget');
    const supervision = events.find((entry) => entry.event === 'run-supervision.verdict');
    // ⚠️ `historyRounds` 는 **판단자에게 실제로 전달된** 이력 수다(현재 지적 제외). 첫 상담이므로 0.
    //    `reworkHistory.length`(현재분 포함)를 싣던 종전 값은 판단자가 본 것을 **거짓 보고**했다 —
    //    이 PR 이 고치는 결함과 같은 형태가 관측 층에도 있었다(리뷰 should-fix).
    expect(event?.data).toMatchObject({ round: 1, verdict: 'EXTEND', reason: '새 지적이 좁아짐', effectiveMaxBefore: 2, effectiveMaxAfter: 3, carriedBudgetAfter: 3, historyRounds: 0, kind: 'gate', applied: true, stopped: false, shadowed: false, supervisionVerdict: 'continue' });
    expect(event?.data).toHaveProperty('carriedBudgetBefore', undefined);
    expect(supervision?.data).toMatchObject({ moment: 'between-round', round: 1, kind: 'gate', effectiveMax: 3, supervisionVerdict: 'continue' });
  });

  // ⭐ 수용기준 2 의 관측 계약(리뷰 must-fix) — 가드가 종료를 막았어도 **판정 자체는 남아야** 한다.
  //   그래야 나중에 "거짓 UNCONVERGEABLE 이 몇 번 났나"(오탐률)를 로그만으로 잴 수 있다.
  //   남지 않으면 가드는 문제를 **숨기는** 장치가 된다.
  test('다음 감독은 이전 감독 판정만 시간순으로 받아 세 번째 판정에 앞선 둘을 본다', async () => {
    const received: Array<readonly { round: number; verdict: string; reason: string }[]> = [];
    const s = seams({ gateResults: [false, false, false, true] });
    s.diagnose = async ({ supervisorDecisionHistory }) => {
      received.push([...(supervisorDecisionHistory ?? [])]);
      return `BUDGET: EXTEND\nREASON: ${received.length}번째 감독 판정`;
    };

    await expect(runSelfImplement({ feature: 'F', maxReworkRounds: 3, seams: s }))
      .resolves.toMatchObject({ stage: 'pr-opened' });

    expect(received).toEqual([
      [],
      [{ round: 1, verdict: 'EXTEND', reason: '1번째 감독 판정' }],
      [
        { round: 1, verdict: 'EXTEND', reason: '1번째 감독 판정' },
        { round: 2, verdict: 'EXTEND', reason: '2번째 감독 판정' },
      ],
    ]);
  });

  test('가드가 막은 UNCONVERGEABLE 도 판정·근거가 관측에 남는다(오탐률 측정 가능)', async () => {
    const { debug } = await import('../debug/log.js');
    const original = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => { events.push({ event, data: data as Record<string, unknown> }); }) as typeof debug.log;
    try {
      const s = seams({ gateResults: [false, true] });
      s.diagnose = async () => 'BUDGET: UNCONVERGEABLE\nREASON: 같은 지적이 반복된다';
      await runSelfImplement({ feature: 'F', seams: s });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    const event = events.find((entry) => entry.event === 'rework-budget');
    expect(event?.data).toMatchObject({
      round: 1,
      verdict: 'UNCONVERGEABLE',            // 판정은 그대로 기록된다
      reason: '같은 지적이 반복된다',
      historyRounds: 0,                     // 비교 대상이 없었다 = 가드가 걸린 이유
      applied: false,                       // 그래서 집행하지 않았다
      stopped: false,                       // 루프는 계속됐다
    });
  });
});

describe('runSelfImplement — fabric classify 그림자(B0)', () => {
  test('그림자가 던져도 rework 제어 흐름은 바뀌지 않는다(권한 0 · 무회귀)', async () => {
    const features: string[] = [];
    const s = seams({ gateResults: [false, true], features });
    s.diagnose = async () => 'BUDGET: EXTEND\nREASON: 한 라운드면 된다';
    // 그림자 LLM 이 매번 실패한다 — 실 판정·예산·종료 어디에도 닿으면 안 된다.
    s.classifyCallLLM = async () => { throw new Error('shadow llm down'); };
    const r = await runSelfImplement({ feature: 'F', seams: s });
    expect(r.stage).toBe('pr-opened');   // rework 1회 후 정상 완주
    expect(features.length).toBe(2);     // implement 2회 = 그림자가 라운드를 삼키지 않았다
  });

  test('그림자 seam 미주입 = 종전 동작과 동일(무회귀)', async () => {
    const features: string[] = [];
    const s = seams({ gateResults: [false, true], features });
    s.diagnose = async () => 'BUDGET: EXTEND\nREASON: 한 라운드면 된다';
    const r = await runSelfImplement({ feature: 'F', seams: s });
    expect(r.stage).toBe('pr-opened');
    expect(features.length).toBe(2);
  });

  test('선언 rework-budget 제공자와 B0 그림자를 각각 실행한다', async () => {
    const s = seams({ gateResults: [false, true] });
    s.diagnose = async () => 'BUDGET: EXTEND\nREASON: 한 라운드면 된다';
    let providerCalls = 0;
    let shadowCalls = 0;
    s.judgmentCallLLM = async () => { providerCalls++; return 'EXTEND'; };
    s.classifyCallLLM = async () => { shadowCalls++; return 'EXTEND'; };
    const result = await runSelfImplement({ feature: 'F', seams: s });
    expect(result.stage).toBe('pr-opened');
    expect(providerCalls).toBe(1);
    expect(shadowCalls).toBe(1);
  });

  test('그림자 관측은 실 판정과 나란히 남고, 비교 불가는 기록하지 않는다', async () => {
    const { debug } = await import('../debug/log.js');
    const original = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    (debug as { log: typeof debug.log }).log = ((_c, event, data) => { events.push({ event, data: data as Record<string, unknown> }); }) as typeof debug.log;
    try {
      const s = seams({ gateResults: [false, true] });
      s.diagnose = async () => 'BUDGET: EXTEND\nREASON: 한 라운드면 된다';
      s.classifyCallLLM = async () => 'EXTEND';
      await runSelfImplement({ feature: 'F', seams: s });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    const shadow = events.find((e) => e.event === 'rework-budget-fabric-shadow');
    expect(shadow?.data).toMatchObject({
      round: 1,
      fabricPicked: 'EXTEND',
      legacyVerdict: 'EXTEND',
      agree: true,          // 양쪽이 다 있을 때만 기록된다
      fabricOk: true,
    });
  });
});

describe('runSelfImplement — lifecycle screen run rollup', () => {
  function captureRunEvents(): {
    events: Array<{ event: string; data: Record<string, unknown>; level?: string }>;
    restore: () => void;
  } {
    const original = (debug as { log: typeof debug.log }).log;
    const events: Array<{ event: string; data: Record<string, unknown>; level?: string }> = [];
    (debug as { log: typeof debug.log }).log = ((_category, event, data, opt) => {
      events.push({ event, data: data as Record<string, unknown>, level: opt?.level });
    }) as typeof debug.log;
    return { events, restore: () => { (debug as { log: typeof debug.log }).log = original; } };
  }

  test('records progress delivery separately from the exact run-rollup for unwired and wired seams', async () => {
    const { events, restore } = captureRunEvents();
    const received: Array<{ stage: string; message: string }> = [];
    try {
      await runSelfImplement({ feature: 'unwired progress', runId: 'progress-unwired', seams: seams({}) });
      await runSelfImplement({
        feature: 'wired progress',
        runId: 'progress-wired',
        parentSessionId: 'requester-session',
        seams: seams({ onProgress: (event) => { received.push(event); } }),
      });
    } finally {
      restore();
    }

    const delivery = (runId: string) => events.find((entry) => entry.event === 'progress-delivery' && entry.data.runId === runId);
    const unwired = delivery('progress-unwired');
    const wired = delivery('progress-wired');
    expect(unwired).toBeDefined();
    expect(wired).toBeDefined();
    const unwiredCount = unwired!.data.unwired;
    const deliveredCount = wired!.data.delivered;
    expect(typeof unwiredCount).toBe('number');
    expect(typeof deliveredCount).toBe('number');
    expect(unwired!.data).toMatchObject({ delivered: 0, callbackFailed: 0 });
    expect(wired!.data).toMatchObject({ unwired: 0, callbackFailed: 0 });
    expect(unwiredCount).toBeGreaterThan(0);
    expect(deliveredCount).toBeGreaterThan(0);
    expect(received.length).toBeGreaterThan(0);
    const unwiredOutcomes = events.filter((entry) => entry.event === 'progress-delivery-outcome' && entry.data.runId === 'progress-unwired');
    const wiredOutcomes = events.filter((entry) => entry.event === 'progress-delivery-outcome' && entry.data.runId === 'progress-wired');
    expect(unwiredOutcomes.every((entry) => entry.data.status === 'surface-callback-unwired' && entry.data.requesterSession === null)).toBe(true);
    expect(wiredOutcomes.every((entry) => entry.data.status === 'delivered' && entry.data.requesterSession === 'requester-session')).toBe(true);
    expect(events.filter((entry) => entry.event === 'run-rollup')).toHaveLength(2);
  });

  test('records callback-failed progress delivery while the run continues to its terminal observation', async () => {
    const { events, restore } = captureRunEvents();
    let result: Awaited<ReturnType<typeof runSelfImplement>> | undefined;
    try {
      result = await runSelfImplement({
        feature: 'failed progress callback',
        runId: 'progress-callback-failed',
        seams: seams({ onProgress: () => { throw new Error('progress sink unavailable'); } }),
      });
    } finally {
      restore();
    }

    const delivery = events.find((entry) => entry.event === 'progress-delivery' && entry.data.runId === 'progress-callback-failed');
    const outcomes = events.filter((entry) => entry.event === 'progress-delivery-outcome' && entry.data.runId === 'progress-callback-failed');
    expect(result?.stage).toBe('pr-opened');
    expect(delivery?.data).toMatchObject({ delivered: 0, unwired: 0 });
    expect(delivery?.data.callbackFailed).toBeGreaterThan(0);
    expect(outcomes.some((entry) => entry.data.status === 'callback-failed' && entry.data.requesterSession === null && entry.level === 'warn')).toBe(true);
    expect(events.some((entry) => entry.event === 'run-rollup' && entry.data.runId === 'progress-callback-failed')).toBe(true);
  });

  test('emits one ordered run-rollup from classifications forwarded by multiple rounds', async () => {
    const { events, restore } = captureRunEvents();
    let round = 0;
    try {
      const s = seams({ gateResults: [false, false], implement: async ({ onLifecycleScreenClassification }) => {
        onLifecycleScreenClassification?.(round++ === 0 ? 'agree' : 'signal-incomplete');
        return { ok: true, summary: 'impl' };
      } });
      const result = await runSelfImplement({ feature: 'rollup', runId: 'run-rollup-ordered', maxReworkRounds: 1, seams: s });
      expect(result.stage).toBe('gate-failed');
    } finally {
      restore();
    }

    const rollups = events.filter((entry) => entry.event === 'run-rollup');
    expect(rollups).toEqual([{
      event: 'run-rollup',
      data: {
        stage: 'gate-failed',
        runStatus: 'failed',
        failureKind: 'review',
        roundClassifications: ['agree', 'signal-incomplete'],
        roundCount: 2,
        completionBlockedBy: 'signal-incomplete',
        runId: 'run-rollup-ordered',
        prNumber: 7,
      },
      level: 'warn',
    }]);
  });

  test('signal-incomplete prevents a successful stage from being recorded as completed', async () => {
    const { events, restore } = captureRunEvents();
    try {
      const result = await runSelfImplement({
        feature: 'incomplete lifecycle',
        runId: 'run-signal-incomplete',
        autoMerge: true,
        seams: seams({
          implement: async ({ onLifecycleScreenClassification }) => {
            onLifecycleScreenClassification?.('signal-incomplete');
            return { ok: true, summary: 'impl' };
          },
          reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'review pass', reviewed: true, diffTruncated: false }),
          mergePr: async () => { throw new Error('signal-incomplete must not auto-merge'); },
        }),
      });
      expect(result.stage).toBe('pr-opened');
    } finally {
      restore();
    }

    expect(events.find((entry) => entry.event === 'merge-decision')?.data).toMatchObject({
      verdict: 'pass', decision: 'hitl', reason: 'signal-incomplete',
    });
    // ⛔⭐ 빈 배열이면 아래 루프 본문이 «한 번도» 안 돌아 «공허하게» 통과한다(리뷰 must-fix).
    //    ⇒ 두 이벤트가 실제로 있었다는 것을 «먼저» 못 박고 나서 값을 문다.
    expect(events.filter((entry) => entry.event === 'run-status' || entry.event === 'run-rollup')
      .map((entry) => entry.event).sort()).toEqual(['run-rollup', 'run-status']);
    for (const event of events.filter((entry) => entry.event === 'run-status' || entry.event === 'run-rollup')) {
      expect(event.data).toMatchObject({
        runStatus: 'failed',
        failureKind: 'review',
        completionBlockedBy: 'signal-incomplete',
      });
      expect(event.level).toBe('warn');
    }
  });

  test('uses the latest classification for status, rollup, and auto-merge while preserving prior incompleteness', async () => {
    const { events, restore } = captureRunEvents();
    let round = 0;
    let mergeCalls = 0;
    try {
      const result = await runSelfImplement({
        feature: 'reworked lifecycle',
        runId: 'run-recovered-lifecycle',
        autoMerge: true,
        maxReworkRounds: 1,
        seams: seams({
          gateResults: [false, true],
          implement: async ({ onLifecycleScreenClassification }) => {
            onLifecycleScreenClassification?.(round++ === 0 ? 'signal-incomplete' : 'agree');
            return { ok: true, summary: 'impl' };
          },
          reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'review pass', reviewed: true, diffTruncated: false }),
          mergePr: async () => { mergeCalls++; return { merged: true }; },
        }),
      });
      expect(result).toMatchObject({ stage: 'merged', merged: true });
      expect(result).not.toHaveProperty('mergeReason');
    } finally {
      restore();
    }

    expect(mergeCalls).toBe(1);
    expect(events.find((entry) => entry.event === 'merge-decision')?.data).toMatchObject({ decision: 'auto', reason: 'review-clean-armed' });
    // ⛔⭐ 빈 배열이면 아래 루프 본문이 «한 번도» 안 돌아 «공허하게» 통과한다(리뷰 must-fix).
    //    ⇒ 두 이벤트가 실제로 있었다는 것을 «먼저» 못 박고 나서 값을 문다.
    expect(events.filter((entry) => entry.event === 'run-status' || entry.event === 'run-rollup')
      .map((entry) => entry.event).sort()).toEqual(['run-rollup', 'run-status']);
    for (const event of events.filter((entry) => entry.event === 'run-status' || entry.event === 'run-rollup')) {
      expect(event.data).toMatchObject({ runStatus: 'completed', priorSignalIncomplete: true });
      expect(event.data).not.toHaveProperty('completionBlockedBy');
      expect(event.level).toBeUndefined();
    }
  });

  test('keeps the latest signal-incomplete blocked and exposes its existing merge reason', async () => {
    const { events, restore } = captureRunEvents();
    try {
      const result = await runSelfImplement({
        feature: 'latest incomplete lifecycle',
        runId: 'run-latest-incomplete',
        autoMerge: true,
        seams: seams({
          implement: async ({ onLifecycleScreenClassification }) => {
            onLifecycleScreenClassification?.('signal-incomplete');
            return { ok: true, summary: 'impl' };
          },
          reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'review pass', reviewed: true, diffTruncated: false }),
        }),
      });
      expect(result).toMatchObject({ stage: 'pr-opened', mergeReason: 'signal-incomplete' });
    } finally {
      restore();
    }

    expect(events.find((entry) => entry.event === 'merge-decision')?.data).toMatchObject({ decision: 'hitl', reason: 'signal-incomplete' });
    // ⛔⭐ 빈 배열이면 아래 루프 본문이 «한 번도» 안 돌아 «공허하게» 통과한다(리뷰 must-fix).
    //    ⇒ 두 이벤트가 실제로 있었다는 것을 «먼저» 못 박고 나서 값을 문다.
    expect(events.filter((entry) => entry.event === 'run-status' || entry.event === 'run-rollup')
      .map((entry) => entry.event).sort()).toEqual(['run-rollup', 'run-status']);
    for (const event of events.filter((entry) => entry.event === 'run-status' || entry.event === 'run-rollup')) {
      expect(event.data).toMatchObject({ runStatus: 'failed', completionBlockedBy: 'signal-incomplete' });
      expect(event.level).toBe('warn');
    }
  });

  test('emits an empty classification list without a placeholder when no round reports one', async () => {
    const { events, restore } = captureRunEvents();
    try {
      const result = await runSelfImplement({ feature: 'empty rollup', runId: 'run-rollup-empty', seams: seams({}) });
      expect(result.stage).toBe('pr-opened');
    } finally {
      restore();
    }

    const rollup = events.find((entry) => entry.event === 'run-rollup');
    expect(rollup).toEqual({
      event: 'run-rollup',
      data: {
        stage: 'pr-opened',
        runStatus: 'completed',
        completionStatus: 'completed',
        roundClassifications: [],
        roundCount: 1,
        runId: 'run-rollup-empty',
        prNumber: 7,
      },
      level: undefined,
    });
  });

  test('last run-rollup alone reports the opened PR number', async () => {
    const { events, restore } = captureRunEvents();
    try {
      const result = await runSelfImplement({
        feature: 'rollup pr present',
        runId: 'run-rollup-pr-present',
        seams: seams({
          openPr: async () => ({ url: 'https://pr/rollup-present', number: 4242 }),
        }),
      });
      expect(result).toMatchObject({ stage: 'pr-opened', prNumber: 4242 });
    } finally {
      restore();
    }

    const rollups = events.filter((entry) => entry.event === 'run-rollup');
    expect(rollups).toHaveLength(1);
    expect(rollups[0]!.data.prNumber).toBe(4242);
    expect(rollups[0]!.data).toMatchObject({
      stage: 'pr-opened',
      runStatus: 'completed',
      roundClassifications: [],
      roundCount: 1,
      runId: 'run-rollup-pr-present',
    });
  });

  test('absent PR and unknown PR stay distinct and invent no number', async () => {
    const { events, restore } = captureRunEvents();
    try {
      const noneResult = await runSelfImplement({
        feature: 'rollup pr none',
        runId: 'run-rollup-pr-none',
        maxReworkRounds: 0,
        seams: seams({
          gateResults: [false],
          preservationHasChanges: () => false,
          openPr: async () => { throw new Error('must not invent a PR'); },
        }),
      });
      const unknownResult = await runSelfImplement({
        feature: 'rollup pr unknown',
        runId: 'run-rollup-pr-unknown',
        seams: seams({
          openPr: async () => ({ url: 'https://pr/rollup-unknown', number: Number.NaN }),
        }),
      });
      expect(noneResult.stage).toBe('gate-failed');
      expect('prNumber' in noneResult).toBe(false);
      expect(unknownResult.stage).toBe('pr-opened');
      expect(Number.isFinite(unknownResult.prNumber as number)).toBe(false);
    } finally {
      restore();
    }

    const noneRollup = events.find((entry) => entry.event === 'run-rollup' && entry.data.runId === 'run-rollup-pr-none');
    const unknownRollup = events.find((entry) => entry.event === 'run-rollup' && entry.data.runId === 'run-rollup-pr-unknown');
    expect(noneRollup?.data.prNumber).toBe('none');
    expect(unknownRollup?.data.prNumber).toBe('unknown');
    expect(noneRollup?.data.prNumber).not.toBe(unknownRollup?.data.prNumber);
    expect(typeof noneRollup?.data.prNumber).not.toBe('number');
    expect(typeof unknownRollup?.data.prNumber).not.toBe('number');
  });

  test('existing run-rollup fields keep their names while ordinary run-status omits PR coordinates', async () => {
    const { events, restore } = captureRunEvents();
    try {
      const result = await runSelfImplement({
        feature: 'rollup field preservation',
        runId: 'run-rollup-field-preservation',
        seams: seams({}),
      });
      expect(result.stage).toBe('pr-opened');
    } finally {
      restore();
    }

    const rollup = events.find((entry) => entry.event === 'run-rollup');
    const status = events.find((entry) => entry.event === 'run-status');
    expect(rollup?.data).toMatchObject({
      stage: 'pr-opened',
      runStatus: 'completed',
      roundClassifications: [],
      roundCount: 1,
      runId: 'run-rollup-field-preservation',
    });
    expect(rollup?.data).not.toHaveProperty('failureKind');
    expect(rollup?.data).not.toHaveProperty('completionBlockedBy');
    expect(rollup?.level).toBeUndefined();
    expect(status?.data).toMatchObject({
      stage: 'pr-opened',
      runStatus: 'completed',
    });
    expect(status?.data).not.toHaveProperty('prNumber');
    expect(status?.data).not.toHaveProperty('prUrl');
    expect(Object.keys(rollup!.data).sort()).toEqual([
      'completionStatus', 'prNumber', 'roundClassifications', 'roundCount', 'runId', 'runStatus', 'stage',
    ]);
  });
});

describe('runSelfImplement — all non-convergence preservation exits', () => {
  test('round exhaustion, implement abort, post-sync regate, and typecheck recheck preserve a draft PR with truthful missing state', async () => {
    const original = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const opened: Array<{ draft?: boolean; body: string }> = [];
      let mergeCalls = 0;
      const capture = (s: SelfImplementSeams): SelfImplementSeams => ({
        ...s,
        preservationHasChanges: () => true,
        openPr: async ({ draft, body }) => {
          opened.push({ draft, body });
          return { url: `https://pr/preserved-${opened.length}`, number: opened.length };
        },
        mergePr: async () => { mergeCalls++; return { merged: true }; },
      });
      const review = await runSelfImplement({ feature: 'review', autoMerge: true, maxReworkRounds: 0, seams: capture(revSeams({ reviews: [{ verdict: 'fail', mustFix: ['unresolved'] }] })) });
      const gate = await runSelfImplement({ feature: 'gate', autoMerge: true, maxReworkRounds: 0, seams: capture(seams({ gateResults: [false] })) });
      const aborted = await runSelfImplement({ feature: 'abort', autoMerge: true, seams: capture(seams({ implement: async () => ({ ok: false, summary: 'soft timeout interrupted implementation' }) })) });
      const regate = await runSelfImplement({ feature: 'regate', autoMerge: true, seams: capture(terminalG2Seams({ mergeStatus: 'llm-resolved', gateResults: [true, false] })) });
      const recheck = await runSelfImplement({ feature: 'recheck', autoMerge: true, seams: capture(terminalG2Seams({ mergeStatus: 'merged', gateResults: [true, false] })) });

      expect(review).toMatchObject({ ok: true, stage: 'pr-opened', mergeReason: 'review-budget-follow-up-required', prUrl: expect.any(String), prNumber: expect.any(Number) });
      for (const result of [gate, aborted, regate, recheck]) {
        expect(result).toMatchObject({ ok: false, prUrl: expect.any(String), prNumber: expect.any(Number) });
      }
      expect(opened).toHaveLength(5);
      expect(opened[0]!.draft).toBe(false);
      expect(opened.slice(1).every((pr) => pr.draft === true)).toBe(true);
      expect(mergeCalls).toBe(0);
      expect(opened[0]!.body).toContain('## Follow-up must-fix (1)\n- unresolved');
      expect(opened[1]!.body).toContain('gate failed after');
      expect(opened[2]!.body).toContain('implement aborted');
      expect(opened[2]!.body).toContain('verdict: (예산 판정 미실행)');
      expect(opened[2]!.body).toContain('(게이트 미실행)');
      expect(opened[2]!.body).toContain('## Main-sync typecheck\n(타입 재검 미실행)');
      expect(opened[3]!.body).toContain('gate failed after main-sync');
      expect(opened[4]!.body).toContain('gate failed after main-sync (clean-merge integration break)');
      expect(opened[4]!.body).toContain('## Gate');
      expect(opened[4]!.body).toContain('```\ngate\n```');
      expect(events.filter((entry) => entry.event === 'rework-blocked-draft-pr')).toHaveLength(4);
      expect(events).toContainEqual(expect.objectContaining({
        event: 'review-budget-acceptance',
        data: expect.objectContaining({ action: 'accepted', unresolvedMustFixCount: 1, autoMerge: false }),
      }));

      const emptyGate = await runSelfImplement({
        feature: 'empty gate log', maxReworkRounds: 0,
        seams: capture(seams({ gate: async () => ({ passed: false, log: '' }) })),
      });
      expect(emptyGate.stage).toBe('gate-failed');
      expect(opened.at(-1)!.body).toContain('(게이트 실행됨 · 로그 없음)');
      expect(opened.at(-1)!.body).not.toContain('(게이트 미실행)');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('post-sync custom-base-only clean branch skips draft PR and records no-changes', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'preserve-post-sync-'));
    const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    const original = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    let opened = 0;
    let postSyncCustomBaseGateCall = 0;
    try {
      git('init', '-b', 'main');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      writeFileSync(join(repo, 'README.md'), 'base\n');
      git('add', '-A');
      git('commit', '-m', 'base');
      git('checkout', '-b', 'release');
      const initialRelease = git('rev-parse', 'HEAD').stdout.trim();
      git('checkout', '-b', 'self-impl/no-artifact');
      git('checkout', 'release');
      writeFileSync(join(repo, 'release-only.ts'), 'export const upstream = true;\n');
      git('add', '-A');
      git('commit', '-m', 'release advances');
      git('checkout', 'self-impl/no-artifact');
      git('merge', '--no-edit', 'release');
      (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
        events.push({ event, data: data as Record<string, unknown> });
      }) as typeof debug.log;
      const result = await runSelfImplement({
        feature: 'custom-base-only no-op',
        base: 'release',
        seams: seams({
          createWorktree: async () => ({ path: repo, branch: 'self-impl/no-artifact', resolvedBase: initialRelease }),
          gate: async () => {
            const passed = (++postSyncCustomBaseGateCall) === 1;
            return { passed, log: passed ? 'ok' : 'post-sync gate failed' };
          },
          commitWork: () => {},
          mergeMain: async () => ({ status: 'merged' }),
          preservationHasChanges: ({ cwd, base }) => preservationHasChanges(cwd, base),
          openPr: async () => { opened++; return { url: 'https://pr/unexpected', number: 99 }; },
          approvePr: async () => true,
        }),
      });
      expect(result).toMatchObject({ stage: 'gate-failed', node: 'regate' });
      expect('prUrl' in result).toBe(false);
      expect(opened).toBe(0);
      expect(events).toContainEqual(expect.objectContaining({
        event: 'rework-blocked-draft-pr',
        data: expect.objectContaining({ skipped: 'no-changes', stage: 'gate-failed' }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('classifies unreadable and press-failed goal files without throwing or claiming they are missing', () => {
    const baseSources = {
      stat: () => ({ isFile: () => true }),
      read: () => 'Situation: readable goal',
      inspectKinds: () => null,
      inspectObservations: () => null,
      inspectSignals: () => [],
      press: () => ({ classification: { kinds: null, observations: null }, pressedGreen: [], pressedRed: [], pressedBaselineOnly: [], unpressed: [], pressedCount: 0 }),
    };
    const missing = resolveDecisionSignalPress('missing-GOAL.txt', process.cwd(), {
      ...baseSources,
      stat: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    });
    const inspectionFailed = resolveDecisionSignalPress('restricted-GOAL.txt', process.cwd(), {
      ...baseSources,
      stat: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
    });
    const readFailed = resolveDecisionSignalPress('GOAL.txt', process.cwd(), {
      ...baseSources,
      read: () => { throw new Error('EACCES'); },
    });
    const pressFailed = resolveDecisionSignalPress('GOAL.txt', process.cwd(), {
      ...baseSources,
      inspectSignals: () => [{ signal: 'candidate', command: 'rg -c candidate artifact.ts', kind: 'real' as const }],
      press: () => { throw new Error('spawn failure'); },
    });

    expect(missing).toEqual({ decisionSignalPressReason: 'goal-file-not-found' });
    expect(inspectionFailed).toEqual({ decisionSignalPressReason: 'goal-file-inspection-failed' });
    expect(readFailed).toEqual({ decisionSignalPressReason: 'goal-file-read-failed' });
    expect(pressFailed).toEqual({ decisionSignalPressReason: 'decision-signal-press-failed' });
    expect(inspectionFailed.decisionSignalPressReason).not.toBe('goal-file-not-found');
    expect(readFailed.decisionSignalPressReason).not.toBe('goal-file-not-found');
    expect(pressFailed.decisionSignalPressReason).not.toBe('goal-file-not-found');
  });

  test('returns the exact pressed decision signal for red pre-merge stops and omits it when unpressed', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'decision-signal-result-'));
    const goalFile = join(repo, 'GOAL.txt');
    const original = (debug as { log: typeof debug.log }).log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      writeFileSync(join(repo, 'artifact.ts'), 'export const artifact = true;\n');
      writeFileSync(goalFile, [
        'Candidate decision signal:',
        'Observation: `rg -c ^missing artifact.ts`',
      ].join('\n'));
      const result = await runSelfImplement({
        feature: 'red decision signal pre-merge stop',
        goalFile,
        autoMerge: true,
        seams: seams({
          createWorktree: async () => ({ path: repo, branch: 'self-impl/decision-signal-result' }),
          implement: async () => ({ ok: true, completionDisposition: 'completed-without-changes', summary: 'verified existing worktree' }),
          reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'review pass', reviewed: true, diffTruncated: false }),
          commitWork: () => {},
          mergeMain: async () => ({ status: 'error' }),
        }),
      });

      const eventPress = events.find((entry) => entry.event === 'merge-decision')?.data.decisionSignalPress as typeof result.decisionSignalPress;
      expect(result).toMatchObject({ stage: 'merge-conflict' });
      expect(result).not.toHaveProperty('completionDisposition');
      expect(result.decisionSignalPress).toBe(eventPress);
      expect(result.decisionSignalPress).toMatchObject({
        pressedCount: 1,
        pressedGreen: [],
        pressedRed: [expect.objectContaining({ signal: 'Candidate decision signal:', command: 'rg -c ^missing artifact.ts' })],
      });

      const unpressed = await runSelfImplement({
        feature: 'unpressed decision signal',
        seams: seams({
          createWorktree: async () => ({ path: repo, branch: 'self-impl/unpressed-decision-signal' }),
          implement: async () => ({ ok: true, completionDisposition: 'completed-without-changes', summary: 'verified existing worktree' }),
        }),
      });
      expect(unpressed).toMatchObject({ stage: 'pr-opened', completionDisposition: 'completed-without-changes' });
      expect(unpressed).not.toHaveProperty('decisionSignalPress');
      const unpressedEvent = events.filter((entry) => entry.event === 'merge-decision').at(-1)?.data;
      expect(unpressedEvent?.decisionSignalPressReason).toBe('goal-file-not-provided');

      const missingGoalFile = join(repo, 'missing-goal.txt');
      writeFileSync(missingGoalFile, 'Situation: goal initially exists\n');
      const missingGoalFileRun = await runSelfImplement({
        feature: 'missing decision signal goal file',
        goalFile: missingGoalFile,
        seams: seams({
          createWorktree: async () => ({ path: repo, branch: 'self-impl/missing-decision-signal-goal-file' }),
          implement: async () => {
            rmSync(missingGoalFile);
            return { ok: true, completionDisposition: 'completed-without-changes', summary: 'goal file removed after implementation began' };
          },
        }),
      });
      expect(missingGoalFileRun).toMatchObject({ stage: 'pr-opened' });
      const missingEvent = events.filter((entry) => entry.event === 'merge-decision').at(-1)?.data;
      expect(missingEvent?.decisionSignalPressReason).toBe('goal-file-not-found');

      const directoryGoalFile = join(repo, 'goal-directory');
      writeFileSync(directoryGoalFile, 'Situation: goal initially exists\n');
      const nonFileGoal = await runSelfImplement({
        feature: 'non-file decision signal goal',
        goalFile: directoryGoalFile,
        seams: seams({
          createWorktree: async () => ({ path: repo, branch: 'self-impl/non-file-decision-signal-goal' }),
          implement: async () => {
            rmSync(directoryGoalFile);
            mkdirSync(directoryGoalFile);
            return { ok: true, completionDisposition: 'completed-without-changes', summary: 'goal file replaced with directory after implementation began' };
          },
        }),
      });
      expect(nonFileGoal).toMatchObject({ stage: 'pr-opened' });
      const nonFileEvent = events.filter((entry) => entry.event === 'merge-decision').at(-1)?.data;
      expect(nonFileEvent?.decisionSignalPressReason).toBe('goal-file-not-a-file');

      const noSignalsGoalFile = join(repo, 'no-signals-goal.txt');
      writeFileSync(noSignalsGoalFile, 'Situation: no declared decision signals\n');
      const noDeclaredSignals = await runSelfImplement({
        feature: 'no declared decision signals',
        goalFile: noSignalsGoalFile,
        seams: seams({
          createWorktree: async () => ({ path: repo, branch: 'self-impl/no-declared-decision-signals' }),
          implement: async () => ({ ok: true, completionDisposition: 'completed-without-changes', summary: 'verified existing worktree' }),
        }),
      });
      expect(noDeclaredSignals).toMatchObject({ stage: 'pr-opened' });
      const noSignalsEvent = events.filter((entry) => entry.event === 'merge-decision').at(-1)?.data;
      expect(noSignalsEvent?.decisionSignalPressReason).toBe('no-declared-signals');
      expect(new Set([
        unpressedEvent?.decisionSignalPressReason,
        missingEvent?.decisionSignalPressReason,
        noSignalsEvent?.decisionSignalPressReason,
      ]).size).toBe(3);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('preserves the exact green decision signal names and count on merged and pre-merge hitl returns', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'decision-signal-result-paths-'));
    const goalFile = join(repo, 'GOAL.txt');
    const original = (debug as { log: typeof debug.log }).log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      writeFileSync(join(repo, 'artifact.ts'), 'export const artifact = true;\n');
      writeFileSync(goalFile, [
        'Candidate decision signal:',
        'Observation: `rg -c ^export artifact.ts`',
        'Candidate decision signal:',
        'Observation: `rg -c ^export artifact.ts`',
      ].join('\n'));
      const expectedGreen = [
        expect.objectContaining({ signal: 'Candidate decision signal:', command: 'rg -c ^export artifact.ts' }),
        expect.objectContaining({ signal: 'Candidate decision signal:', command: 'rg -c ^export artifact.ts' }),
      ];
      const mergeDecision = (): unknown => events.filter((entry) => entry.event === 'merge-decision').at(-1)?.data.decisionSignalPress;

      const merged = await runSelfImplement({
        feature: 'green decision signal merged',
        goalFile,
        autoMerge: true,
        seams: seams({
          createWorktree: async () => ({ path: repo, branch: 'self-impl/green-decision-signal-merged' }),
          reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'review pass', reviewed: true, diffTruncated: false }),
          mergePr: async () => ({ merged: true }),
        }),
      });
      expect(merged).toMatchObject({ stage: 'merged', merged: true });
      expect(merged.decisionSignalPress as unknown).toBe(mergeDecision());
      expect(merged.decisionSignalPress?.pressedCount).toBe(2);
      expect(merged.decisionSignalPress?.pressedGreen).toEqual(expectedGreen);
      expect(merged.decisionSignalPress?.pressedRed).toEqual([]);

      const preMergeHitl = await runSelfImplement({
        feature: 'green decision signal pre-merge hitl',
        goalFile,
        autoMerge: true,
        seams: seams({
          createWorktree: async () => ({ path: repo, branch: 'self-impl/green-decision-signal-hitl' }),
          implement: async ({ onLifecycleScreenClassification }) => {
            onLifecycleScreenClassification?.('signal-incomplete');
            return { ok: true, summary: 'impl' };
          },
          reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'review pass', reviewed: true, diffTruncated: false }),
          mergePr: async () => { throw new Error('signal-incomplete must prevent auto-merge'); },
        }),
      });
      expect(preMergeHitl).toMatchObject({ stage: 'pr-opened', mergeReason: 'signal-incomplete' });
      expect(preMergeHitl.decisionSignalPress as unknown).toBe(mergeDecision());
      expect(preMergeHitl.decisionSignalPress?.pressedCount).toBe(2);
      expect(preMergeHitl.decisionSignalPress?.pressedGreen).toEqual(expectedGreen);
      expect(preMergeHitl.decisionSignalPress?.pressedRed).toEqual([]);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('implement abort with committed work opens one draft PR through the real preservation seam', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'preserve-aborted-'));
    const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    const original = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const opened: Array<{ draft?: boolean; body: string }> = [];
    try {
      git('init', '-b', 'main');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      writeFileSync(join(repo, 'README.md'), 'base\n');
      git('add', '-A');
      git('commit', '-m', 'base');
      const base = git('rev-parse', 'HEAD').stdout.trim();
      git('checkout', '-b', 'self-impl/aborted-artifact');
      writeFileSync(join(repo, 'artifact.ts'), 'export const preserved = true;\n');
      const goalFile = join(repo, 'GOAL.txt');
      writeFileSync(goalFile, [
        'Candidate decision signal:',
        'Observation: `rg -c ^export artifact.ts`',
        'Candidate decision signal:',
        'Observation: `rg -c ^missing artifact.ts`',
      ].join('\n'));
      git('add', '-A');
      git('commit', '-m', 'preserved artifact');
      (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
        events.push({ event, data: data as Record<string, unknown> });
      }) as typeof debug.log;

      const result = await runSelfImplement({
        feature: 'committed artifact abort',
        goalFile,
        seams: seams({
          createWorktree: async () => ({ path: repo, branch: 'self-impl/aborted-artifact', resolvedBase: base }),
          implement: async () => ({ ok: false, summary: 'implementation interrupted' }),
          preservationHasChanges: ({ cwd, base: preservationBase }) => preservationHasChanges(cwd, preservationBase),
          openPr: async ({ draft, body }) => {
            opened.push({ draft, body });
            return { url: 'https://pr/preserved-abort', number: 91 };
          },
        }),
      });

      expect(opened).toHaveLength(1);
      expect(opened[0]!.draft).toBe(true);
      expect(result).toMatchObject({ stage: 'aborted', prUrl: 'https://pr/preserved-abort', prNumber: 91 });
      expect(opened[0]!.body).toContain('verdict: (예산 판정 미실행)');
      expect(opened[0]!.body).toContain('(게이트 미실행)');
      expect(events).toContainEqual(expect.objectContaining({
        event: 'rework-blocked-draft-pr',
        data: expect.objectContaining({
          stage: 'aborted', number: 91,
          reviewMustFixTrend: '아직 못 잰다',
          lastMustFix: null,
          findingIds: [],
          decisionSignal: expect.objectContaining({
            status: 'measured', pressedCount: 2,
            pressedGreen: [expect.stringContaining('rg -c ^export artifact.ts')],
            pressedRed: [expect.stringContaining('rg -c ^missing artifact.ts')],
            unpressed: [],
          }),
        }),
      }));
      expect(events.some((entry) => entry.event === 'rework-blocked-draft-pr' && 'skipped' in entry.data)).toBe(false);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('implement abort presses each declared bounded decision signal exactly once in the preserved worktree', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'preserve-aborted-decision-signal-'));
    const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    const countPath = join(repo, 'decision-signal-count.txt');
    try {
      git('init', '-b', 'main');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      writeFileSync(join(repo, 'README.md'), 'base\n');
      git('add', '-A');
      git('commit', '-m', 'base');
      const base = git('rev-parse', 'HEAD').stdout.trim();
      git('checkout', '-b', 'self-impl/aborted-decision-signal');
      writeFileSync(join(repo, 'artifact.ts'), 'export const preserved = true;\n');
      writeFileSync(join(repo, 'preserved-signal.test.ts'), [
        "import { appendFileSync } from 'node:fs';",
        "import { test } from 'bun:test';",
        "test('records the preserved-worktree signal press', () => appendFileSync('decision-signal-count.txt', 'pressed\\n'));",
      ].join('\n'));
      const goalFile = join(repo, 'GOAL.txt');
      writeFileSync(goalFile, [
        'Candidate decision signal:',
        'Observation: `bun test preserved-signal.test.ts`',
      ].join('\n'));
      git('add', '-A');
      git('commit', '-m', 'preserved artifact and signal');

      const result = await runSelfImplement({
        feature: 'committed artifact abort signal once',
        goalFile,
        seams: seams({
          createWorktree: async () => ({ path: repo, branch: 'self-impl/aborted-decision-signal', resolvedBase: base }),
          implement: async () => ({ ok: false, summary: 'implementation interrupted' }),
          preservationHasChanges: ({ cwd, base: preservationBase }) => preservationHasChanges(cwd, preservationBase),
          openPr: async () => ({ url: 'https://pr/preserved-abort', number: 91 }),
        }),
      });

      expect(result).toMatchObject({ stage: 'aborted', prNumber: 91 });
      expect(readFileSync(countPath, 'utf8')).toBe('pressed\n');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('판정 신호가 «없는» 골이면 중단 기록은 unmeasured 로 남는다 — ⛔ 「초록」으로 접지 않는다', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'preserve-aborted-'));
    const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    const original = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const opened: Array<{ draft?: boolean; body: string }> = [];
    try {
      git('init', '-b', 'main');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      writeFileSync(join(repo, 'README.md'), 'base\n');
      git('add', '-A');
      git('commit', '-m', 'base');
      const base = git('rev-parse', 'HEAD').stdout.trim();
      git('checkout', '-b', 'self-impl/aborted-artifact');
      writeFileSync(join(repo, 'artifact.ts'), 'export const preserved = true;\n');
      const goalFile = join(repo, 'GOAL.txt');
      // ⛔ 판정 신호를 «선언하지 않은» 골 — 이 시험의 전부다.
      writeFileSync(goalFile, 'PROBLEM\nSituation: 신호를 선언하지 않는다.\n');
      git('add', '-A');
      git('commit', '-m', 'preserved artifact');
      (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
        events.push({ event, data: data as Record<string, unknown> });
      }) as typeof debug.log;

      const result = await runSelfImplement({
        feature: 'committed artifact abort',
        goalFile,
        seams: seams({
          createWorktree: async () => ({ path: repo, branch: 'self-impl/aborted-artifact', resolvedBase: base }),
          implement: async () => ({ ok: false, summary: 'implementation interrupted' }),
          preservationHasChanges: ({ cwd, base: preservationBase }) => preservationHasChanges(cwd, preservationBase),
          openPr: async ({ draft, body }) => {
            opened.push({ draft, body });
            return { url: 'https://pr/preserved-abort', number: 91 };
          },
        }),
      });

      expect(opened).toHaveLength(1);
      expect(opened[0]!.draft).toBe(true);
      expect(result).toMatchObject({ stage: 'aborted', prUrl: 'https://pr/preserved-abort', prNumber: 91 });
      expect(opened[0]!.body).toContain('verdict: (예산 판정 미실행)');
      expect(opened[0]!.body).toContain('(게이트 미실행)');
      expect(events).toContainEqual(expect.objectContaining({
        event: 'rework-blocked-draft-pr',
        data: expect.objectContaining({
          stage: 'aborted', number: 91,
          decisionSignal: expect.objectContaining({
            // ⛔ 신호 «부재»는 「못 쟀다」이지 「초록」이 아니다 — 🅢 가 계약에 박은 한계 ⒜.
            status: 'unmeasured', pressedCount: 0,
          }),
        }),
      }));
      expect(events.some((entry) => entry.event === 'rework-blocked-draft-pr' && 'skipped' in entry.data)).toBe(false);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('draft PR failure preserves the assembled verdict body, reports its artifact, and isolates persistence failure', async () => {
    const progressMessages: string[] = [];
    const persisted: Array<{ origin: string; body: string; originalChars: number }> = [];
    const success = await runSelfImplement({
      feature: 'blocked draft persistence',
      maxReworkRounds: 0,
      seams: seams({
        gateResults: [false],
        preservationHasChanges: () => true,
        openPr: async () => { throw new Error('remote unavailable'); },
        persistPrBodyArtifact: (input) => {
          persisted.push(input);
          return { path: '/tmp/blocked-draft-verdict.md' };
        },
        onProgress: (event) => { progressMessages.push(event.message); },
      }),
    });
    expect(success).toMatchObject({ ok: false, stage: 'gate-failed' });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ origin: 'self-implement-blocked-draft-pr-open-failed' });
    expect(persisted[0]!.body).toContain('verdict: (예산 판정 미실행)');
    expect(persisted[0]!.body).toContain('gate failed');
    expect(progressMessages).toContain('중단 산출물의 draft PR 생성 실패(worktree·branch 보존 · 판정 본문 보존: /tmp/blocked-draft-verdict.md)');

    const persistenceFailureMessages: string[] = [];
    const persistenceFailure = await runSelfImplement({
      feature: 'blocked draft persistence failure',
      maxReworkRounds: 0,
      seams: seams({
        gateResults: [false],
        preservationHasChanges: () => true,
        openPr: async () => { throw new Error('remote unavailable'); },
        persistPrBodyArtifact: () => { throw new Error('artifact store unavailable'); },
        onProgress: (event) => { persistenceFailureMessages.push(event.message); },
      }),
    });
    expect(persistenceFailure).toMatchObject({ ok: false, stage: 'gate-failed' });
    expect(persistenceFailureMessages).toContain('중단 산출물의 draft PR 생성 실패(worktree·branch 보존 · 판정 본문 보존 실패: artifact store unavailable)');

    let preOpenPersistenceCalls = 0;
    await expect(runSelfImplement({
      feature: 'blocked draft pre-open failure',
      maxReworkRounds: 0,
      seams: seams({
        gateResults: [false],
        preservationHasChanges: () => { throw new Error('preservation check unavailable'); },
        persistPrBodyArtifact: () => {
          preOpenPersistenceCalls++;
          return { path: '/tmp/unexpected.md' };
        },
      }),
    })).rejects.toThrow('preservation check unavailable');
    expect(preOpenPersistenceCalls).toBe(0);
  });

  test('successful blocked draft PR creation does not persist a second artifact', async () => {
    let persistenceCalls = 0;
    const result = await runSelfImplement({
      feature: 'successful blocked draft',
      maxReworkRounds: 0,
      seams: seams({
        gateResults: [false],
        preservationHasChanges: () => true,
        openPr: async () => ({ url: 'https://pr/successful-blocked-draft', number: 91 }),
        persistPrBodyArtifact: () => {
          persistenceCalls++;
          return { path: '/tmp/unexpected.md' };
        },
      }),
    });
    expect(result).toMatchObject({ ok: false, stage: 'gate-failed', prUrl: 'https://pr/successful-blocked-draft', prNumber: 91 });
    expect(persistenceCalls).toBe(0);
  });

  test('no changes skips draft PR and records why', async () => {
    const original = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    let opened = 0;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const result = await runSelfImplement({
        feature: 'no-op', maxReworkRounds: 0,
        seams: seams({ gateResults: [false], preservationHasChanges: () => false, openPr: async () => { opened++; return { url: 'https://pr/unexpected', number: 99 }; } }),
      });
      expect(result.stage).toBe('gate-failed');
      expect('prUrl' in result).toBe(false);
      expect('prNumber' in result).toBe(false);
      expect(opened).toBe(0);
      expect(events).toContainEqual(expect.objectContaining({
        event: 'rework-blocked-draft-pr', data: expect.objectContaining({ skipped: 'no-changes', stage: 'gate-failed' }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('worktree-only completion stopped by repeated review must-fix keeps the blocked body and never opens a PR', async () => {
    const original = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const progress: string[] = [];
    const persisted: Array<{ origin: string; body: string; originalChars: number }> = [];
    let opened = 0;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      let diagnoseCall = 0;
      const reviewSeams = revSeams({
        reviews: [
          { verdict: 'fail', reviewed: true, mustFix: ['repeated must-fix'] },
          { verdict: 'fail', reviewed: true, mustFix: ['repeated must-fix'] },
        ],
      });
      reviewSeams.preservationHasChanges = () => true;
      reviewSeams.openPr = async () => { opened++; return { url: 'https://pr/unexpected', number: 99 }; };
      reviewSeams.persistPrBodyArtifact = (input) => {
        persisted.push(input);
        return { path: '/tmp/blocked-worktree-only.md' };
      };
      reviewSeams.onProgress = (event) => { progress.push(event.message); };
      reviewSeams.diagnose = async () => (++diagnoseCall === 1
        ? 'BUDGET: EXTEND\nREASON: 아직 판단 이르다'
        : 'BUDGET: UNCONVERGEABLE\nREASON: 같은 must-fix가 반복된다');
      const result = await runSelfImplement({
        feature: 'worktree-only repeated must-fix',
        completion: 'worktree-only',
        maxReworkRounds: 5,
        reworkBudgetShadowStop: false,
        seams: reviewSeams,
      });
      expect(result.stage).toBe('review-blocked');
      expect('prUrl' in result).toBe(false);
      expect('prNumber' in result).toBe(false);
      expect(opened).toBe(0);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject({ origin: 'self-implement-blocked-draft-pr-worktree-only' });
      expect(persisted[0]!.body).toContain('사람 판단 필요');
      expect(persisted[0]!.body).toContain('## 중단 사유');
      expect(persisted[0]!.body).toContain('## 중단 원인 분류');
      expect(persisted[0]!.body).toContain('## 자식이 남긴 증거');
      expect(persisted[0]!.body).toContain('repeated must-fix');
      const blocked = events.filter((entry) => entry.event === 'rework-blocked-draft-pr');
      expect(blocked).toEqual([expect.objectContaining({
        data: expect.objectContaining({
          skipped: 'worktree-only',
          stage: 'review-blocked',
          prBodyArtifactPath: '/tmp/blocked-worktree-only.md',
          worktreePath: result.worktreePath,
          branch: result.branch,
        }),
      })]);
      expect(progress.some((line) => line.includes('/tmp/blocked-worktree-only.md') && line.includes(String(result.worktreePath)) && line.includes(String(result.branch)))).toBe(true);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('the same repeated review must-fix stop with completion pr still opens the draft PR', async () => {
    let opened = 0;
    let draft: boolean | undefined;
    let diagnoseCall = 0;
    const reviewSeams = revSeams({
      reviews: [
        { verdict: 'fail', reviewed: true, mustFix: ['repeated must-fix'] },
        { verdict: 'fail', reviewed: true, mustFix: ['repeated must-fix'] },
      ],
    });
    reviewSeams.preservationHasChanges = () => true;
    reviewSeams.openPr = async ({ draft: isDraft }) => {
      opened++;
      draft = isDraft;
      return { url: 'https://pr/blocked-pr-mode', number: 41 };
    };
    reviewSeams.diagnose = async () => (++diagnoseCall === 1
      ? 'BUDGET: EXTEND\nREASON: 아직 판단 이르다'
      : 'BUDGET: UNCONVERGEABLE\nREASON: 같은 must-fix가 반복된다');
    const result = await runSelfImplement({
      feature: 'pr repeated must-fix',
      completion: 'pr',
      maxReworkRounds: 5,
      reworkBudgetShadowStop: false,
      seams: reviewSeams,
    });
    expect(result).toMatchObject({ ok: false, stage: 'review-blocked', prUrl: 'https://pr/blocked-pr-mode', prNumber: 41 });
    expect(opened).toBe(1);
    expect(draft).toBe(true);
  });

  test('very long child summary keeps a readable abort reason distinct from the preserved full summary', async () => {
    const original = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const opened: Array<{ draft?: boolean; body: string }> = [];
    const persisted: Array<{ childSummary: string; childSummaryChars: number; reason: string; round: number; stage: 'review-blocked' | 'gate-failed' | 'aborted' }> = [];
    const uniqueMarker = 'WHY-STOPPED-SOFT-TIMEOUT';
    const childSummary = `${uniqueMarker}: ${'x'.repeat(96_000)}-CHILD-SUMMARY-TAIL`;
    const artifactPath = '/tmp/implement-abort-child-summary.block';
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const result = await runSelfImplement({
        feature: 'long abort summary',
        seams: seams({
          implement: async () => ({
            ok: false,
            summary: childSummary,
            terminalStatus: { reached: false, changed: true, toolCalls: 0, timedOut: true },
          }),
          preservationHasChanges: () => true,
          persistImplementAbortArtifact: (input) => {
            persisted.push({ childSummary: input.childSummary, childSummaryChars: input.childSummaryChars, reason: input.reason, round: input.round, stage: input.stage });
            return { path: artifactPath };
          },
          openPr: async ({ draft, body }) => {
            if (body.length > GITHUB_PR_BODY_MAX_CHARS) {
              throw new Error(`GitHub PR body exceeds ${GITHUB_PR_BODY_MAX_CHARS} chars (${body.length})`);
            }
            opened.push({ draft, body });
            return { url: 'https://pr/long-abort', number: 77 };
          },
        }),
      });

      const abortEvent = events.find((entry) => entry.event === 'rework-blocked-draft-pr');
      expect(result).toMatchObject({ ok: false, stage: 'aborted', prUrl: 'https://pr/long-abort', prNumber: 77, detail: childSummary });
      expect(opened).toHaveLength(1);
      expect(opened[0]!.draft).toBe(true);
      expect(opened[0]!.body.length).toBeLessThanOrEqual(GITHUB_PR_BODY_MAX_CHARS);
      expect(opened[0]!.body).toContain(`- reason: implement aborted: ${uniqueMarker}`);
      expect(opened[0]!.body).toContain('[truncated; originalChars=');
      expect(opened[0]!.body).toContain('- reason truncated: true');
      expect(opened[0]!.body).toContain(`- child summary chars: ${childSummary.length}`);
      expect(opened[0]!.body).toContain(`- child summary artifact: ${artifactPath}`);
      expect(opened[0]!.body).toContain('- child terminal status: reached=false; changed=true; toolCalls=0; timedOut=true');
      expect(opened[0]!.body).toContain('## 구현 요약');
      expect(opened[0]!.body).toContain(`(자식 요약 전문은 영속 산출물에 보존 — ${artifactPath})`);
      expect(opened[0]!.body).not.toContain(childSummary);
      expect(opened[0]!.body).not.toContain('CHILD-SUMMARY-TAIL');
      expect(persisted).toEqual([{ childSummary, childSummaryChars: childSummary.length, reason: expect.stringMatching(/^implement aborted: WHY-STOPPED-SOFT-TIMEOUT/), round: 0, stage: 'aborted' }]);
      expect(persisted[0]!.childSummary).toBe(childSummary);
      const reasonLine = opened[0]!.body.split('\n').find((line) => line.startsWith('- reason: '))!;
      expect(reasonLine.length).toBeLessThanOrEqual(IMPLEMENT_ABORT_REASON_MAX_CHARS + '- reason: '.length);
      expect(reasonLine).not.toContain('CHILD-SUMMARY-TAIL');
      expect(reasonLine).not.toContain(childSummary);
      expect(abortEvent?.data).toEqual(expect.objectContaining({
        stage: 'aborted',
        number: 77,
        reason: expect.stringMatching(/^implement aborted: WHY-STOPPED-SOFT-TIMEOUT/),
        reasonTruncated: true,
        childSummaryChars: childSummary.length,
        childSummaryArtifactPath: artifactPath,
      }));
      expect(String(abortEvent?.data.reason).length).toBeLessThanOrEqual(IMPLEMENT_ABORT_REASON_MAX_CHARS);
      expect(String(abortEvent?.data.reason)).toContain('[truncated; originalChars=');
      expect(String(abortEvent?.data.reason)).not.toContain('CHILD-SUMMARY-TAIL');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('all PR-opening paths cap oversized bodies, persist their full artifacts, preserve follow-up must-fix, and observe truncation', async () => {
    const hugeSummary = `summary ${'x'.repeat(GITHUB_PR_BODY_MAX_CHARS)}`;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const opened: Array<{ body: string; draft?: boolean }> = [];
    const persisted: Array<{ origin: string; body: string; originalChars: number }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const capture = (s: SelfImplementSeams): SelfImplementSeams => ({
        ...s,
        persistPrBodyArtifact: (input) => {
          persisted.push(input);
          return { path: '/tmp/full-pr-body.md' };
        },
        openPr: async ({ body, draft }) => {
          opened.push({ body, draft });
          return { url: 'https://pr/bounded', number: opened.length };
        },
      });
      await runSelfImplement({
        feature: 'blocked body',
        maxReworkRounds: 0,
        seams: capture(seams({ gateResults: [false], implement: async () => ({ ok: true, summary: hugeSummary }) })),
      });
      const reviewSeams = revSeams({ reviews: [
        { verdict: 'fail', mustFix: ['must fix'] },
        { verdict: 'fail', mustFix: ['must fix'] },
      ] });
      reviewSeams.implement = async () => ({ ok: true, summary: hugeSummary });
      await runSelfImplement({ feature: 'follow-up body', autoMerge: true, maxReworkRounds: 1, seams: capture(reviewSeams) });
      await runSelfImplement({
        feature: 'normal body',
        seams: capture(seams({ implement: async () => ({ ok: true, summary: hugeSummary }) })),
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(opened).toHaveLength(3);
    expect(persisted).toHaveLength(3);
    for (const { body } of opened) {
      expect(body.length).toBeLessThanOrEqual(GITHUB_PR_BODY_MAX_CHARS);
      expect(body).toContain('[truncated; originalChars=');
      expect(body).toContain('full PR body artifact: /tmp/full-pr-body.md');
    }
    for (const artifact of persisted) {
      expect(artifact.originalChars).toBeGreaterThan(GITHUB_PR_BODY_MAX_CHARS);
      expect(artifact.body.length).toBe(artifact.originalChars);
    }
    expect(opened[1]!.body).toContain('## Follow-up must-fix (1)\n- must fix');
    expect(persisted[1]!.body).toContain('## Follow-up must-fix (1)\n- must fix');
    for (const event of ['rework-blocked-draft-pr', 'review-budget-acceptance', 'pr-opened']) {
      expect(events).toContainEqual(expect.objectContaining({
        event,
        data: expect.objectContaining({ prBodyTruncated: true, prBodyOriginalChars: expect.any(Number) }),
      }));
    }

    const reason = 'preserve this abort reason';
    const priority = assembleBlockedDraftPrBody('priority body', 'summary', {
      salvageStatusExpected: false,
      reason,
      rounds: 0,
      undeliveredSupervisorInputs: [],
      evidence: `child evidence ${'e'.repeat(GITHUB_PR_BODY_MAX_CHARS)}`,
      gate: { passed: false, log: `gate log ${'g'.repeat(GITHUB_PR_BODY_MAX_CHARS)}` },
    });
    expect(priority.truncated).toBe(true);
    expect(priority.body).toContain(`- reason: ${reason}`);
    expect(priority.body).not.toContain('gate log');

    const exactLimit = 'n'.repeat(GITHUB_PR_BODY_MAX_CHARS);
    const exact = boundReadableText(exactLimit, GITHUB_PR_BODY_MAX_CHARS);
    expect(exact).toEqual({ text: exactLimit, truncated: false, originalChars: GITHUB_PR_BODY_MAX_CHARS });
  });

  test('default PR body artifact persists the full normal PR body and its marker points to that file', async () => {
    const summary = `default artifact ${'x'.repeat(GITHUB_PR_BODY_MAX_CHARS)}`;
    let openedBody = '';
    await runSelfImplement({
      feature: 'default artifact body',
      seams: seams({
        implement: async () => ({ ok: true, summary }),
        openPr: async ({ body }) => {
          openedBody = body;
          return { url: 'https://pr/default-artifact', number: 98 };
        },
      }),
    });

    const match = /full PR body artifact: ([^\]]+)/.exec(openedBody);
    expect(match?.[1]).toBeDefined();
    const artifactPath = match![1]!;
    expect(existsSync(artifactPath)).toBe(true);
    const fullBody = readFileSync(artifactPath, 'utf8');
    expect(fullBody.length).toBeGreaterThan(GITHUB_PR_BODY_MAX_CHARS);
    expect(fullBody).toContain(summary);
    expect(openedBody.length).toBeLessThanOrEqual(GITHUB_PR_BODY_MAX_CHARS);
  });

  test('does not open a PR when preserving an oversized full body artifact fails', async () => {
    let opened = 0;
    await expect(runSelfImplement({
      feature: 'artifact failure body',
      seams: seams({
        implement: async () => ({ ok: true, summary: `summary ${'x'.repeat(GITHUB_PR_BODY_MAX_CHARS)}` }),
        persistPrBodyArtifact: () => { throw new Error('artifact store unavailable'); },
        openPr: async () => {
          opened++;
          return { url: 'https://pr/unexpected', number: 99 };
        },
      }),
    })).rejects.toThrow('artifact store unavailable');
    expect(opened).toBe(0);
  });

  test('does not open a PR when an artifact path cannot fit a readable truncation marker', async () => {
    let opened = 0;
    await expect(runSelfImplement({
      feature: 'oversized artifact path body',
      seams: seams({
        implement: async () => ({ ok: true, summary: `summary ${'x'.repeat(GITHUB_PR_BODY_MAX_CHARS)}` }),
        persistPrBodyArtifact: () => ({ path: `/tmp/${'p'.repeat(2_000)}.md` }),
        openPr: async () => {
          opened++;
          return { url: 'https://pr/unexpected', number: 99 };
        },
      }),
    })).rejects.toThrow('artifact path is too long');
    expect(opened).toBe(0);
  });

  test('implement-abort artifact preserves the abort round and stage through the injected persist seam', () => {
    const persisted: Array<Record<string, unknown>> = [];

    persistImplementAbortChildSummary((input) => {
      persisted.push(input);
      return { path: '/tmp/implement-abort-round-2.block' };
    }, {
      origin: 'self-implement-abort',
      runId: 'run-round-2',
      childSummary: 'implementation stopped',
      childSummaryChars: 'implementation stopped'.length,
      reason: 'implement aborted: implementation stopped',
      reasonTruncated: false,
      round: 2,
      stage: 'aborted',
    });

    expect(persisted).toEqual([{
      origin: 'self-implement-abort',
      runId: 'run-round-2',
      childSummary: 'implementation stopped',
      childSummaryChars: 'implementation stopped'.length,
      reason: 'implement aborted: implementation stopped',
      reasonTruncated: false,
      round: 2,
      stage: 'aborted',
    }]);
  });

  test('implement-abort artifact default persistence stores the abort round and stage in extra', () => {
    const artifactStateDir = mkdtempSync(join(tmpdir(), 'elanous-implement-abort-artifact-'));
    const priorArtifactStateDir = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = artifactStateDir;
    try {
      const artifact = persistImplementAbortChildSummary(undefined, {
        origin: 'self-implement-abort',
        runId: 'run-round-2-default',
        childSummary: 'implementation stopped',
        childSummaryChars: 'implementation stopped'.length,
        reason: 'implement aborted: implementation stopped',
        reasonTruncated: false,
        round: 2,
        stage: 'aborted',
      });
      const metadata = JSON.parse(readFileSync(`${artifact.path}.meta.json`, 'utf8')) as { extra?: Record<string, unknown> };

      expect(metadata.extra).toMatchObject({
        runId: 'run-round-2-default',
        reason: 'implement aborted: implementation stopped',
        reasonTruncated: false,
        childSummaryChars: 'implementation stopped'.length,
        round: 2,
        stage: 'aborted',
      });
    } finally {
      if (priorArtifactStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = priorArtifactStateDir;
      rmSync(artifactStateDir, { recursive: true, force: true });
    }
  });

  test('GitHub PR body cap rejects an unbounded 96k summary and accepts the bounded abort body', async () => {
    const uniqueMarker = 'WHY-STOPPED-SOFT-TIMEOUT';
    const childSummary = `${uniqueMarker}: ${'x'.repeat(96_000)}-CHILD-SUMMARY-TAIL`;
    const artifact = persistImplementAbortChildSummary(() => ({ path: '/tmp/implement-abort-96k.block' }), {
      origin: 'self-implement-abort',
      runId: 'run-96k',
      childSummary,
      childSummaryChars: childSummary.length,
      reason: 'implement aborted: WHY-STOPPED-SOFT-TIMEOUT',
      reasonTruncated: true,
      round: 2,
      stage: 'aborted',
    });
    const unbounded = assembleBlockedDraftPrBody('long abort summary', childSummary, {
      salvageStatusExpected: false,
      reason: 'implement aborted: WHY-STOPPED-SOFT-TIMEOUT',
      rounds: 0,
      undeliveredSupervisorInputs: [],
      reasonTruncated: true,
      childSummaryChars: childSummary.length,
    });
    expect(unbounded.originalChars).toBeGreaterThan(GITHUB_PR_BODY_MAX_CHARS);
    expect(unbounded.truncated).toBe(true);
    expect(unbounded.body.length).toBeLessThanOrEqual(GITHUB_PR_BODY_MAX_CHARS);
    expect(unbounded.body).toContain('[truncated; originalChars=');
    expect(unbounded.body).toContain('- reason: implement aborted: WHY-STOPPED-SOFT-TIMEOUT');
    expect(unbounded.body).toContain('- reason truncated: true');

    const bounded = assembleBlockedDraftPrBody(
      'long abort summary',
      `(자식 요약 전문은 영속 산출물에 보존 — ${artifact.path})`,
      {
        salvageStatusExpected: false,
        reason: 'implement aborted: WHY-STOPPED-SOFT-TIMEOUT',
        rounds: 0,
        undeliveredSupervisorInputs: [],
        reasonTruncated: true,
        childSummaryChars: childSummary.length,
        childSummaryArtifact: artifact,
      },
    );
    expect(bounded.truncated).toBe(false);
    expect(bounded.body.length).toBeLessThanOrEqual(GITHUB_PR_BODY_MAX_CHARS);
    expect(bounded.body).not.toContain(childSummary);
    expect(bounded.body).toContain(`- child summary artifact: ${artifact.path}`);

    const justOver = `${'n'.repeat(GITHUB_PR_BODY_MAX_CHARS + 1)}`;
    const justUnder = `${'n'.repeat(GITHUB_PR_BODY_MAX_CHARS)}`;
    const over = boundReadableText(justOver, GITHUB_PR_BODY_MAX_CHARS);
    const under = boundReadableText(justUnder, GITHUB_PR_BODY_MAX_CHARS);
    expect(over.truncated).toBe(true);
    expect(over.text.length).toBeLessThanOrEqual(GITHUB_PR_BODY_MAX_CHARS);
    expect(under.truncated).toBe(false);
    expect(under.text).toBe(justUnder);

    const openPr = async (body: string) => {
      if (body.length > GITHUB_PR_BODY_MAX_CHARS) throw new Error(`GitHub PR body exceeds ${GITHUB_PR_BODY_MAX_CHARS} chars (${body.length})`);
      return { url: 'https://pr/cap', number: 1 };
    };
    await expect(openPr(childSummary)).rejects.toThrow(/GitHub PR body exceeds 65536/);
    await expect(openPr(bounded.body)).resolves.toEqual({ url: 'https://pr/cap', number: 1 });
  });
});

describe('assembleBlockedDraftPrBody — child terminal status', () => {
  test('renders supplied false values and preserves the status after a long child summary truncates the reason', () => {
    const childSummary = `screen-frame ${'x'.repeat(IMPLEMENT_ABORT_REASON_MAX_CHARS * 4)}`;
    const status = { reached: false, changed: true, toolCalls: 0, timedOut: true };
    const abort = buildImplementAbortRecord(childSummary, status);
    const assembled = assembleBlockedDraftPrBody('terminal status', childSummary, {
      salvageStatusExpected: false,
      reason: abort.reason,
      rounds: 0,
      undeliveredSupervisorInputs: [],
      reasonTruncated: abort.reasonTruncated,
      terminalStatus: abort.terminalStatus,
    });

    expect(abort.reasonTruncated).toBe(true);
    expect(abort.reason.length).toBeLessThanOrEqual(IMPLEMENT_ABORT_REASON_MAX_CHARS);
    expect(assembled.body).toContain('- child terminal status: reached=false; changed=true; toolCalls=0; timedOut=true');
  });

  test('omits the terminal status line when no structured status was supplied', () => {
    const assembled = assembleBlockedDraftPrBody('terminal status absent', 'child summary', {
      salvageStatusExpected: false,
      reason: 'implement aborted: child summary',
      rounds: 0,
      undeliveredSupervisorInputs: [],
    });

    expect(assembled.body).not.toContain('- child terminal status:');
    expect(assembled.body).not.toContain('reached=false; changed=false; toolCalls=0; timedOut=false');
  });
});

const BLOCKED_DRAFT_PR_SALVAGE_STATUS_INSTRUCTION = '자동 병합은 중지했습니다. 자동 후속 처리는 이 경로에서 별도로 실행될 수 있으므로, 아래 salvage 상태를 확인한 뒤 이 draft PR의 처분을 판단합니다.';
const BLOCKED_DRAFT_PR_INTERRUPTION_REASON_INSTRUCTION = '자동 병합은 중지했습니다. 아래 중단 사유의 verdict·reason·rework rounds를 보고 이 draft PR의 처분을 판단합니다.';

describe('assembleBlockedDraftPrBody — salvage status expected', () => {
  const interruptionState = {
    reason: 'gate failed after 0 rework round(s)',
    rounds: 1,
    undeliveredSupervisorInputs: [] as const,
    verdict: 'UNCONVERGEABLE' as const,
  };

  test('keeps the salvage-status instruction only when the caller says salvage can follow', () => {
    const following = assembleBlockedDraftPrBody('salvage follows', 'summary', {
      salvageStatusExpected: true,
      ...interruptionState,
    });
    expect(following.body.split('\n')).toContain('## 사람 판단 필요');
    expect(following.body).toContain('## 중단 사유');
    expect(following.body).toContain('- verdict: UNCONVERGEABLE');
    expect(following.body).toContain(`- reason: ${interruptionState.reason}`);
    expect(following.body).toContain('- rework rounds: 1');
    expect(following.body).toContain(BLOCKED_DRAFT_PR_SALVAGE_STATUS_INSTRUCTION);
    expect(following.body).not.toContain(BLOCKED_DRAFT_PR_INTERRUPTION_REASON_INSTRUCTION);
  });

  test('omits the salvage-status instruction when the caller says salvage cannot follow', () => {
    const notFollowing = assembleBlockedDraftPrBody('salvage does not follow', 'summary', {
      salvageStatusExpected: false,
      ...interruptionState,
    });
    expect(notFollowing.body.split('\n')).toContain('## 사람 판단 필요');
    expect(notFollowing.body).toContain('## 중단 사유');
    expect(notFollowing.body).toContain('- verdict: UNCONVERGEABLE');
    expect(notFollowing.body).toContain(`- reason: ${interruptionState.reason}`);
    expect(notFollowing.body).toContain('- rework rounds: 1');
    expect(notFollowing.body).not.toContain(BLOCKED_DRAFT_PR_SALVAGE_STATUS_INSTRUCTION);
    expect(notFollowing.body).not.toContain('아래 salvage 상태');
    expect(notFollowing.body).toContain(BLOCKED_DRAFT_PR_INTERRUPTION_REASON_INSTRUCTION);
  });

  test('a live hard-cap path that later calls salvageHardCap keeps the salvage-status instruction', async () => {
    let body = '';
    const s = seams({ gateResults: [false] });
    s.openPr = async (opts) => { body = opts.body; return { url: 'https://pr/salvage-follows', number: 7 }; };
    const result = await runSelfImplement({ feature: 'F', maxReworkRounds: 0, seams: s });
    expect(result).toMatchObject({ stage: 'gate-failed', salvage: 'parked' });
    expect(body.split('\n')).toContain('## 사람 판단 필요');
    expect(body).toContain('## 중단 사유');
    expect(body).toContain(BLOCKED_DRAFT_PR_SALVAGE_STATUS_INSTRUCTION);
    expect(body).not.toContain(BLOCKED_DRAFT_PR_INTERRUPTION_REASON_INSTRUCTION);
  });

  test('a live UNCONVERGEABLE path omits the salvage-status instruction', async () => {
    let body = '';
    const s = seams({ gateResults: [false, false] });
    s.diagnose = async () => 'BUDGET: UNCONVERGEABLE\nREASON: 반복 지적';
    s.judgmentCallLLM = async () => 'UNCONVERGEABLE';
    s.openPr = async (opts) => { body = opts.body; return { url: 'https://pr/no-salvage', number: 11 }; };
    const result = await runSelfImplement({ feature: 'F', maxReworkRounds: 2, seams: s });
    expect(result.outcome).toBe('abandoned');
    expect(body.split('\n')).toContain('## 사람 판단 필요');
    expect(body).toContain('## 중단 사유');
    expect(body).toContain('- verdict: UNCONVERGEABLE');
    expect(body).not.toContain(BLOCKED_DRAFT_PR_SALVAGE_STATUS_INSTRUCTION);
    expect(body).not.toContain('아래 salvage 상태');
    expect(body).toContain(BLOCKED_DRAFT_PR_INTERRUPTION_REASON_INSTRUCTION);
  });
});

describe('assembleBlockedDraftPrBody — unfinished-run classification', () => {
  const interruptionState = {
    salvageStatusExpected: false,
    reason: 'gate failed after 0 rework round(s)',
    rounds: 1,
    undeliveredSupervisorInputs: [] as const,
    verdict: 'UNCONVERGEABLE' as const,
  };

  test('puts a named classifier result in human and machine-readable form and keeps the existing anchors', () => {
    const abandonedClassification = classifyAbandonedRun({
      worktreePorcelain: ' M src/self-implement/orchestrator.ts',
      supervisorVerdict: 'CONTRACT-CONFLICT',
      stage: 'gate-failed',
      mustFixReported: false,
    });
    const assembled = assembleBlockedDraftPrBody('unfinished classification', 'summary', {
      ...interruptionState,
      abandonedClassification,
    });
    const record = blockedDraftClassificationRecord(abandonedClassification);

    expect(abandonedClassification.classification).toBe('contract-conflict');
    expect(assembled.body.split('\n')).toContain('## 사람 판단 필요');
    expect(assembled.body).toContain('## 중단 사유');
    expect(assembled.body).toContain('## 중단 원인 분류');
    expect(assembled.body).toContain(`- 중단 원인: ${record.classification}`);
    expect(assembled.body).toContain(`- classification: ${record.classification}`);
    expect(assembled.body).toContain(`- classificationBasis: ${record.classificationBasis}`);
    expect(assembled.body).toContain(JSON.stringify(record));
    expect(formatBlockedDraftClassificationSection(abandonedClassification).join('\n').trim()).not.toBe('');
  });

  test('names an unclassified outcome instead of leaving a blank slot', () => {
    const assembled = assembleBlockedDraftPrBody('unclassified unfinished', 'summary', interruptionState);
    const record = blockedDraftClassificationRecord(undefined);

    expect(record.classification).toBe(BLOCKED_DRAFT_UNCLASSIFIED_CLASSIFICATION);
    expect(assembled.body.split('\n')).toContain('## 사람 판단 필요');
    expect(assembled.body).toContain('## 중단 사유');
    expect(assembled.body).toContain('## 중단 원인 분류');
    expect(assembled.body).toContain(`- 중단 원인: ${BLOCKED_DRAFT_UNCLASSIFIED_CLASSIFICATION} (분류를 못 함)`);
    expect(assembled.body).toContain(`- classification: ${BLOCKED_DRAFT_UNCLASSIFIED_CLASSIFICATION}`);
    expect(assembled.body).toContain(JSON.stringify(record));
    expect(assembled.body).not.toMatch(/- classification:\s*$/m);
    expect(formatBlockedDraftClassificationSection(undefined).join('\n').trim()).not.toBe('');
  });

  test('a live unfinished run writes the named cause into the draft PR body and observes it', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    let body = '';
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const s = seams({ gateResults: [false, false] });
      s.diagnose = async () => 'BUDGET: UNCONVERGEABLE\nREASON: 반복 지적';
      s.judgmentCallLLM = async () => 'UNCONVERGEABLE';
      s.openPr = async (opts) => { body = opts.body; return { url: 'https://pr/classified', number: 11 }; };
      const result = await runSelfImplement({ feature: 'F', maxReworkRounds: 2, seams: s });
      expect(result.outcome).toBe('abandoned');
      expect(body.split('\n')).toContain('## 사람 판단 필요');
      expect(body).toContain('## 중단 사유');
      expect(body).toContain('## 중단 원인 분류');
      const observed = events.filter((entry) => entry.event === 'blocked-draft-classification');
      expect(observed).toHaveLength(1);
      expect(observed[0]!.data.classification).toEqual(expect.any(String));
      expect(observed[0]!.data.classification).not.toBe(BLOCKED_DRAFT_UNCLASSIFIED_CLASSIFICATION);
      const record = {
        classification: String(observed[0]!.data.classification),
        classificationBasis: String(observed[0]!.data.classificationBasis),
        worktreeClean: observed[0]!.data.worktreeClean ?? null,
      };
      expect(body).toContain(`- classification: ${record.classification}`);
      expect(body).toContain(JSON.stringify(record));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('a successful merged run does not execute the blocked-draft classification path', async () => {
    const events: Array<{ event: string }> = [];
    const original = debug.log;
    let body = '';
    (debug as { log: typeof debug.log }).log = ((_category, event) => {
      events.push({ event });
    }) as typeof debug.log;
    try {
      const s = seams({
        reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'review', reviewed: true, diffTruncated: false }),
        mergePr: async () => ({ merged: true }),
        openPr: async (opts) => { body = opts.body; return { url: 'https://pr/merged', number: 3 }; },
      });
      const result = await runSelfImplement({ feature: 'F', autoMerge: true, seams: s });
      expect(result).toMatchObject({ stage: 'merged', merged: true, outcome: 'completed' });
      expect(events.filter((entry) => entry.event === 'blocked-draft-classification')).toEqual([]);
      expect(body).not.toContain('## 중단 원인 분류');
      expect(body).not.toContain('## 사람 판단 필요');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });
});

describe('buildImplementAbortRecord — reason and child summary stay distinct', () => {
  test('short summary stays untruncated and is not mixed back into a second field', () => {
    const record = buildImplementAbortRecord('soft timeout interrupted implementation');
    expect(record).toEqual({
      reason: 'implement aborted: soft timeout interrupted implementation',
      childSummary: 'soft timeout interrupted implementation',
      reasonTruncated: false,
      childSummaryChars: 'soft timeout interrupted implementation'.length,
      failureKind: 'timeout',
    });
    expect(record.reason.length).toBeLessThanOrEqual(IMPLEMENT_ABORT_REASON_MAX_CHARS);
  });

  test('long reason keeps the readable head and discloses the omitted original length', () => {
    const longReason = `implement aborted: ${'y'.repeat(400)}`;
    const bounded = boundReadableText(longReason, IMPLEMENT_ABORT_REASON_MAX_CHARS);
    expect(bounded.truncated).toBe(true);
    expect(bounded.text.startsWith('implement aborted: ')).toBe(true);
    expect(bounded.text).toContain(`[truncated; originalChars=${longReason.length}]`);
    expect(bounded.text.length).toBeLessThanOrEqual(IMPLEMENT_ABORT_REASON_MAX_CHARS);
    expect(bounded.text).not.toBe(longReason);
  });

  test('96k-char child summary is preserved in full and never copied into the reason', () => {
    const childSummary = `WHY-STOPPED: ${'z'.repeat(96_000)}-TAIL`;
    const record = buildImplementAbortRecord(childSummary);
    expect(record.childSummary).toBe(childSummary);
    expect(record.childSummaryChars).toBe(childSummary.length);
    expect(record.reasonTruncated).toBe(true);
    expect(record.failureKind).toBeNull();
    expect(record.reason.startsWith('implement aborted: WHY-STOPPED:')).toBe(true);
    expect(record.reason).toContain(`[truncated; originalChars=${`implement aborted: ${childSummary}`.length}]`);
    expect(record.reason.length).toBeLessThanOrEqual(IMPLEMENT_ABORT_REASON_MAX_CHARS);
    expect(record.reason).not.toContain('-TAIL');
    expect(record.reason).not.toContain(childSummary);
  });

  test('boundReadableText never exceeds maxChars for non-positive or marker-shorter limits', () => {
    const long = 'implement aborted: ' + 'q'.repeat(500);
    for (const maxChars of [-10, -1, 0, 1, 5, 11, 12, 36, 37]) {
      const bounded = boundReadableText(long, maxChars);
      const limit = Math.max(0, maxChars);
      expect(bounded.text.length).toBeLessThanOrEqual(limit);
      expect(bounded.originalChars).toBe(long.length);
      expect(bounded.truncated).toBe(true);
      if (maxChars <= 0) expect(bounded.text).toBe('');
      else expect(bounded.text.length).toBeGreaterThan(0);
    }
    expect(boundReadableText('short', 0)).toEqual({ text: '', truncated: true, originalChars: 5 });
    expect(boundReadableText('short', -3)).toEqual({ text: '', truncated: true, originalChars: 5 });
    expect(boundReadableText('', -3)).toEqual({ text: '', truncated: false, originalChars: 0 });
    const fitsMarker = boundReadableText(long, 11);
    expect(fitsMarker.text).toBe('[truncated]');
    expect(fitsMarker.text.length).toBeLessThanOrEqual(11);
    const oneChar = boundReadableText(long, 1);
    expect(oneChar.text).toBe('…');
    expect(oneChar.text.length).toBe(1);
  });
});

describe('formatImplementAbortProgressLine — abort progress keeps a colon-free base unless a reason summary attaches', () => {

  // ⛔ 📏 2026-08-27 🅣 — 절단을 «코드 단위»로 하면 이모지가 반으로 쪼개진다.
  //   실측: `'🅣'.repeat(200)` 을 `.slice(0, 117)` 하면 꼬리에 짝 잃은 `\ud83c` 가 남고
  //   화면·로그에 깨진 글리프가 찍힌다. 이 저장소의 중단 사유는 이모지를 «자주» 담는다.
  //   ⇒ 이 시험이 그 재발을 문다(`R-CLM16`).
  test('이모지 사유를 잘라도 짝 잃은 서로게이트를 남기지 않는다', () => {
    const line = formatImplementAbortProgressLine('🅣'.repeat(200));
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(lone.test(line)).toBe(false);
    expect(line.endsWith('...')).toBe(true);
  });
  test('undefined reason stays the existing 구현 실패 line without a colon', () => {
    const line = formatImplementAbortProgressLine(undefined);
    expect(line).toBe('중단 — 구현 실패');
    expect(line).not.toContain(':');
  });

  test('whitespace-only reason is treated as absent', () => {
    expect(formatImplementAbortProgressLine('   ')).toBe('중단 — 구현 실패');
  });

  test('a present reason attaches its first line after a colon', () => {
    expect(formatImplementAbortProgressLine('gate 실패: tsc 오류 2건'))
      .toBe('중단 — 구현 실패: gate 실패: tsc 오류 2건');
  });

  test('leading and trailing whitespace on the first line is trimmed', () => {
    expect(formatImplementAbortProgressLine('  gate 실패: tsc 오류 2건  '))
      .toBe('중단 — 구현 실패: gate 실패: tsc 오류 2건');
  });

  test('consecutive spaces and tabs on the first line collapse to a single space', () => {
    expect(formatImplementAbortProgressLine('gate  실패:\ttsc 오류 2건'))
      .toBe('중단 — 구현 실패: gate 실패: tsc 오류 2건');
  });

  test('a 200-char first line plus a second line keeps 117 chars, ellipsis, and no newline', () => {
    const firstLine = 'a'.repeat(200);
    const line = formatImplementAbortProgressLine(`${firstLine}\nsecond line of abort reason`);
    expect(line).toBe(`중단 — 구현 실패: ${firstLine.slice(0, 117)}...`);
    expect(line).not.toContain('\n');
    expect(line).not.toContain('second line');
    expect(line.slice('중단 — 구현 실패: '.length)).toHaveLength(120);
  });

  test('toolCalls 0 puts the no-tool-call fact ahead of the reason first line', () => {
    const line = formatImplementAbortProgressLine('무언가 실패', 0);
    expect(line).toContain('자식이 도구를 한 번도 부르지 않았다');
    expect(line).toContain('무언가 실패');
    expect(line).toBe('중단 — 구현 실패: 자식이 도구를 한 번도 부르지 않았다 (구현 이전에 죽었다) · 무언가 실패');
  });

  test('toolCalls greater than 0 keeps the legacy one-argument line', () => {
    expect(formatImplementAbortProgressLine('무언가 실패', 3)).toBe(formatImplementAbortProgressLine('무언가 실패'));
  });

  test('undefined toolCalls matches the one-argument caller', () => {
    expect(formatImplementAbortProgressLine('무언가 실패', undefined)).toBe(formatImplementAbortProgressLine('무언가 실패'));
  });

  test('toolCalls 0 with an empty reason has no trailing separator', () => {
    const line = formatImplementAbortProgressLine(undefined, 0);
    expect(line).toContain('자식이 도구를 한 번도 부르지 않았다');
    expect(line.endsWith(' ·')).toBe(false);
    expect(line).toBe('중단 — 구현 실패: 자식이 도구를 한 번도 부르지 않았다 (구현 이전에 죽었다)');
  });

  test('toolCalls 0 clips only the reason part and keeps the fixed phrase whole', () => {
    const reason = '한'.repeat(300);
    const line = formatImplementAbortProgressLine(reason, 0);
    const prefix = '중단 — 구현 실패: 자식이 도구를 한 번도 부르지 않았다 (구현 이전에 죽었다) · ';
    expect(line.startsWith(prefix)).toBe(true);
    expect(line.slice(prefix.length)).toBe(`${'한'.repeat(117)}...`);
    expect(Array.from(line.slice(prefix.length))).toHaveLength(120);
  });

  test('toolCalls 0 with a 200-emoji reason leaves no lone surrogate', () => {
    const line = formatImplementAbortProgressLine('🅣'.repeat(200), 0);
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(lone.test(line)).toBe(false);
    expect(line).toContain('자식이 도구를 한 번도 부르지 않았다');
    expect(line.endsWith('...')).toBe(true);
  });
});

// ⭐⭐ S3 (2026-07-29) — 리뷰어의 증거 채널이 워크트리 diff 하나라 diff 밖 이행을 증명할 수 없어
// 같은 지적이 반복되고 런이 UNCONVERGEABLE 로 죽었다(실측 2건 · 한 번은 자식이 **이미 이행한 것**
// 때문에 죽었다). 자식 요약의 EVIDENCE 줄을 분류해 리뷰 ctx 로 나른다.
describe('runSelfImplement — gate worktree freshness evidence', () => {
  test('behind=3은 증빙·관측에 남기되 기존 실행 증빙과 gate 판정은 보존한다', async () => {
    const original = debug.log;
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    let seenEvidence: string | undefined;
    try {
      (debug as { log: typeof debug.log }).log = ((category, event, data) => {
        events.push({ category, event, data: data as Record<string, unknown> });
      }) as typeof debug.log;
      const gate = { passed: true, steps: [{ name: 'test', ok: true, summary: 'unchanged' }], log: '[test] PASS bun test test/chat-text-input-paste.test.ts — Ran 1 tests across 1 file\n1 pass\n0 fail' } as never;
      await runSelfImplement({
        feature: 'freshness',
        seams: seams({
          gate: async () => gate,
          gateWorktreeBehindMain: async () => 3,
          reviewDiff: async (_cwd, ctx) => {
            seenEvidence = ctx?.gateEvidenceNote;
            return { verdict: 'pass', mustFix: [], shouldFix: [], summary: 'ok', reviewed: true };
          },
        }),
      });
      expect(seenEvidence).toContain('[worktree] origin/main 대비 3 commits behind (local ref; no fetch)');
      expect(seenEvidence).toContain('[test] PASS bun test test/chat-text-input-paste.test.ts — Ran 1 tests across 1 file');
      expect(events.some((entry) => entry.category === 'self-implement'
        && entry.event === 'gate-worktree-freshness'
        && entry.data.behind === 3
        && entry.data.round === 0)).toBe(true);
      const freshness = events.find((entry) => entry.event === 'gate-worktree-freshness');
      expect(freshness?.data).not.toHaveProperty('path');
      expect(freshness?.data).not.toHaveProperty('cwd');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('freshness seam은 동일 gate 입력의 passed·steps[].ok·summary를 바꾸지 않는다', async () => {
    const observed: Array<{ passed: boolean; steps: Array<{ ok: boolean; summary: string }> }> = [];
    for (const freshness of [0, 3] as const) {
      const gate = {
        passed: true,
        steps: [{ name: 'test', ok: true, skipped: false, summary: 'pass' }],
        log: '1 pass\n0 fail\nRan 1 tests across 1 file',
      };
      await runSelfImplement({
        feature: 'freshness verdict invariant',
        seams: seams({
          gate: async () => gate,
          gateWorktreeBehindMain: async () => freshness,
          reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'ok', reviewed: true }),
        }),
      });
      observed.push({
        passed: gate.passed,
        steps: gate.steps.map((step: { ok: boolean; summary: string }) => ({ ok: step.ok, summary: step.summary })),
      });
    }
    expect(observed[1]).toEqual(observed[0]);
    expect(observed[0]).toEqual({ passed: true, steps: [{ ok: true, summary: 'pass' }] });
  });

  test('behind=0은 기존 실행 증빙과 정확히 같고 unknown은 증빙·관측에 정직하게 남는다', async () => {
    const original = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const executionEvidence = '## Gate execution evidence\n[test] PASS bun test test/chat-text-input-paste.test.ts — Ran 1 tests across 1 file\n1 pass\n0 fail';
    const evidence: string[] = [];
    try {
      (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
        events.push({ event, data: data as Record<string, unknown> });
      }) as typeof debug.log;
      for (const freshness of [0, undefined] as const) {
        await runSelfImplement({
          feature: 'freshness',
          seams: seams({
            gate: async () => ({ passed: true, steps: [{ name: 'test', ok: true, summary: 'unchanged' }], log: executionEvidence.split('\n').slice(1).join('\n') }) as never,
            gateWorktreeBehindMain: async () => freshness,
            reviewDiff: async (_cwd, ctx) => {
              evidence.push(ctx?.gateEvidenceNote ?? '');
              return { verdict: 'pass', mustFix: [], shouldFix: [], summary: 'ok', reviewed: true };
            },
          }),
        });
      }
      expect(evidence[0]).toBe(executionEvidence);
      expect(evidence[1]).toContain('origin/main 대비 뒤처짐: unknown (local ref unavailable; no fetch)');
      expect(events.some((entry) => entry.event === 'gate-worktree-freshness'
        && entry.data.behind === 'unknown'
        && entry.data.round === 0)).toBe(true);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  // ⭐ 리뷰 should-fix(2026-07-30) — 종전 테스트는 원본 `gate` 객체의 **비변이**만 봤다.
  //   그것은 "판정 불변" 의 대리 지표이지 판정 자체가 아니다 ⇒ 결과·리뷰 입력의 **판정 필드를 직접 비교**한다.
  test('판정 불변: behind 유무가 run 결과 stage/ok 와 리뷰 입력의 gate 판정 필드를 바꾸지 않는다', async () => {
    const gateLog = '[test] PASS bun test a/b.test.ts — Ran 1 tests across 1 file\n1 pass\n0 fail';
    const runWith = async (behind: number | undefined) => {
      let reviewGatePassed: unknown;
      let reviewSteps: unknown;
      const result = await runSelfImplement({
        feature: 'freshness-verdict',
        seams: seams({
          gate: async () => ({ passed: true, steps: [{ name: 'test', ok: true, summary: 'pass' }], log: gateLog }) as never,
          gateWorktreeBehindMain: async () => behind,
          reviewDiff: async (_cwd, ctx) => {
            reviewGatePassed = (ctx as { gate?: { passed?: boolean } } | undefined)?.gate?.passed;
            reviewSteps = (ctx as { gate?: { steps?: unknown } } | undefined)?.gate?.steps;
            return { verdict: 'pass', mustFix: [], shouldFix: [], summary: 'ok', reviewed: true };
          },
        }),
      });
      return { stage: result.stage, ok: result.ok, reviewGatePassed, reviewSteps };
    };
    const behindRun = await runWith(3);
    const freshRun = await runWith(0);
    const unknownRun = await runWith(undefined);
    // ⭐ 무엇이 동일해야 하는지: 종결 stage · ok · 리뷰어가 본 gate 판정 필드
    expect(behindRun.stage).toBe(freshRun.stage);
    expect(unknownRun.stage).toBe(freshRun.stage);
    expect(behindRun.ok).toBe(freshRun.ok);
    expect(unknownRun.ok).toBe(freshRun.ok);
    expect(behindRun.reviewGatePassed).toEqual(freshRun.reviewGatePassed);
    expect(unknownRun.reviewGatePassed).toEqual(freshRun.reviewGatePassed);
    expect(behindRun.reviewSteps).toEqual(freshRun.reviewSteps);
    // ⭐ 리뷰 must-fix(2026-07-30) — **모든 조회 상태**에 대해 완결한다(unknown 도 fresh 와 같아야 한다).
    expect(unknownRun.reviewSteps).toEqual(freshRun.reviewSteps);
  });
});

describe('runSelfImplement — diff 밖 이행 증거가 리뷰어에게 간다', () => {
  test('⭐ verify 있는 주장은 reviewDiff ctx 로 가고, 버린 수는 관측에 남는다', async () => {
    const original = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    let seenCtx: { diffOutsideClaims?: readonly { claim: string; verify: string; result?: string }[]; gateEvidenceNote?: string } | undefined;
    (debug as { log: typeof debug.log }).log = ((_c, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await runSelfImplement({
        feature: 'evidence',
        seams: seams({
          implement: async () => ({
            ok: true,
            summary: [
              'done',
              'EVIDENCE: 격리에서 draft PR 이 열리는 것을 봤다 || elanous logs --category dev-pipeline',
              'RESULT: draft PR #42 opened',
              'RESULT: 짝 없는 결과',
              'EVIDENCE: 확인 방법 없는 주장',
              'EVIDENCE:  || 주장 없는 명령',
            ].join('\n'),
          }),
          gate: async () => ({ passed: true, log: '23 pass\n0 fail\nRan 1 tests across 1 file' }),
          reviewDiff: async (_cwd, ctx) => {
            seenCtx = ctx as typeof seenCtx;
            return { verdict: 'pass', mustFix: [], shouldFix: [], summary: 'ok', reviewed: true };
          },
        }),
      });
      expect(seenCtx?.diffOutsideClaims).toEqual([
        { claim: '격리에서 draft PR 이 열리는 것을 봤다', verify: 'elanous logs --category dev-pipeline', result: 'draft PR #42 opened' },
      ]);
      expect(seenCtx?.gateEvidenceNote).toContain('Ran 1 tests across 1 file');
      // ⛔ 조용히 버리면 관측값이 항상 0 이 되어 거짓 초록이 된다(#5920 리뷰 must-fix).
      const obs = events.find((e) => e.event === 'off-diff-evidence');
      // ⛔ 두 결손 필드를 **둘 다** 단언한다(리뷰 should-fix) — 하나만 보면 다른 하나의
      //    전달이 빠지는 회귀를 못 잡는다.
      expect(obs?.data).toMatchObject({ kept: 1, discardedMissingVerify: 1, discardedEmptyClaim: 1, missingResult: 2, orphanResult: 1 });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('EVIDENCE 줄이 없으면 ctx 에 채널을 만들지 않는다 (빈 배열로 꾸미지 않는다)', async () => {
    let seenCtx: { diffOutsideClaims?: unknown } | undefined;
    await runSelfImplement({
      feature: 'no-evidence',
      seams: seams({
        implement: async () => ({ ok: true, summary: 'done' }),
        reviewDiff: async (_cwd, ctx) => {
          seenCtx = ctx as typeof seenCtx;
          return { verdict: 'pass', mustFix: [], shouldFix: [], summary: 'ok', reviewed: true };
        },
      }),
    });
    expect(seenCtx).toBeDefined();
    expect('diffOutsideClaims' in (seenCtx ?? {})).toBe(false);
  });

  test('⭐ 매 라운드 off-diff-evidence를 남겨 자식 요약의 EVIDENCE 문자열을 모두 센다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    let implementCalls = 0;
    (debug as { log: typeof debug.log }).log = ((_c, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await runSelfImplement({
        feature: 'round evidence observation',
        maxReworkRounds: 1,
        seams: seams({
          gateResults: [false, true],
          implement: async () => ({
            ok: true,
            summary: implementCalls++ === 0
              ? 'Grep({"pattern":"EVIDENCE"})\n서술의 EVIDENCE 낱말'
              : 'Grep({"pattern":"EVIDENCE"})\r\n서술의 EVIDENCE 낱말\r\n  EVIDENCE: parser delimiter 없이도 줄머리 형식이다',
          }),
        }),
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }

    const observations = events.filter((entry) => entry.event === 'off-diff-evidence').map((entry) => entry.data);
    expect(observations).toEqual([
      expect.objectContaining({ round: 0, evidenceStringCount: 2, kept: 0, discardedMissingVerify: 0, discardedEmptyClaim: 0, missingResult: 0, orphanResult: 0 }),
      expect.objectContaining({ round: 1, evidenceStringCount: 3, kept: 0, discardedMissingVerify: 1, discardedEmptyClaim: 0, missingResult: 1, orphanResult: 0 }),
    ]);
  });
});

describe('parseBehindCount — 부분 파싱 금지(미지 불변식)', () => {
  test('출력 전체가 십진 정수일 때만 수를 낸다', () => {
    expect(parseBehindCount('3\n')).toBe(3);
    expect(parseBehindCount('  0  ')).toBe(0);
  });
  test('⛔ 부분 파싱을 거부한다 — 조용한 거짓이 되지 않게 unknown 이다', () => {
    expect(parseBehindCount('3garbage')).toBeUndefined();
    expect(parseBehindCount('fatal: bad revision')).toBeUndefined();
    expect(parseBehindCount('')).toBeUndefined();
    expect(parseBehindCount('-1')).toBeUndefined();
    expect(parseBehindCount('1e3')).toBeUndefined();
  });
});

// ⭐⭐⭐ JDG-S4·S5 셋째 얼굴 — **배선 회귀**(리뷰 1R should-fix). 빌더만 테스트하면
// orchestrator → ReviewDiffContext → intent 사이가 끊겨도 초록이다(원장: dep-inject seam must be wired).
describe('evidenceCoverage 가 리뷰 컨텍스트까지 간다 (JDG-S4/S5)', () => {
  test('디자인 판정의 통과·불일치·측정 불가 값을 관측·리뷰에 전달하고 기존 정보 필드를 보존한다', async () => {
    const outcomes = [
      { ok: true as const, documentPath: '/wt/DESIGN.md', craftDirectory: '/craft', availableRulebooks: ['color'], declaredRulebooks: ['color'], unavailableRulebooks: [] },
      { ok: true as const, documentPath: '/wt/DESIGN.md', craftDirectory: '/craft', availableRulebooks: ['color'], declaredRulebooks: ['color', 'missing'], unavailableRulebooks: ['missing'] },
      { ok: false as const, blockedOn: 'craft-directory' as const, path: '/craft' },
    ];
    const contexts: ReviewDiffContext[] = [];
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ category, event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      for (const designCheck of outcomes) {
        const result = await runSelfImplement({
          feature: 'goal\n## REQUIRED EVIDENCE\n- [requested] review context',
          seams: seams({
            implement: async () => ({ ok: true, summary: 'impl', evidenceTranscript: 'EVIDENCE: [requested] review context || command\nRESULT: pass' }),
            gate: async () => ({
              passed: true,
              log: 'gate evidence',
              baselineFailures: [{ attribution: 'preexisting', name: 'existing failure' }],
            }) as never,
            resolveDesignCheck: () => designCheck,
            reviewDiff: async (_cwd, context) => {
              contexts.push(context!);
              return { verdict: 'pass', mustFix: [], shouldFix: [], summary: 'review', reviewed: true };
            },
          }),
        });
        expect(result.stage).toBe('pr-opened');
      }
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }

    const designCheckEvents = events.filter(({ category, event }) => category === 'self-implement' && event === 'design-check');
    expect(designCheckEvents).toHaveLength(outcomes.length);
    expect(designCheckEvents.map(({ data }) => data)).toEqual([
      expect.objectContaining({ status: 'available', declaredCount: 1, availableCount: 1, unavailableCount: 0, unavailableRulebooks: [] }),
      expect.objectContaining({ status: 'available', declaredCount: 2, availableCount: 1, unavailableCount: 1, unavailableRulebooks: ['missing'] }),
      expect.objectContaining({ status: 'blocked', blockedOn: 'craft-directory', path: '/craft' }),
    ]);
    expect(contexts.map((context) => context.designCheck)).toEqual(outcomes);
    for (const context of contexts) {
      expect(context.evidenceCoverage).toMatchObject({ required: 1, covered: 1, missing: [] });
      expect(context.gateEvidenceNote).toContain('origin/main 대비 뒤처짐: unknown');
      expect(context.preexistingTestFailures).toEqual(['existing failure']);
    }
    const blockedIntent = buildReviewIntent(toReviewIntentInput(contexts[2])!);
    expect(blockedIntent).toContain('측정 불가: craft-directory');
    expect(blockedIntent).toContain('경로: /craft');
  });

  test('게이트 importerTestsNotRun 관측을 리뷰 문맥과 intent에 그대로 전달하고 0/비0 구별을 보존한다', async () => {
    const observations = [
      {
        total: 2,
        files: ['src/example-a.test.ts', 'src/example-b.test.ts'],
        truncated: true,
        unresolvedRelativeSpecifiers: 5,
      },
      {
        total: 0,
        files: [],
        truncated: false,
        unresolvedRelativeSpecifiers: 5,
      },
    ] as const;
    const contexts: ReviewDiffContext[] = [];
    for (const importerTestsNotRun of observations) {
      const result = await runSelfImplement({
        feature: 'importer test observation',
        seams: seams({
          gate: async () => ({ passed: true, log: 'gate', importerTestsNotRun }),
          reviewDiff: async (_cwd, context) => {
            contexts.push(context!);
            return { verdict: 'pass', mustFix: [], shouldFix: [], summary: 'review', reviewed: true };
          },
        }),
      });
      expect(result.stage).toBe('pr-opened');
    }

    expect(contexts.map((context) => context.importerTestsNotRun)).toEqual([...observations]);
    const firstIntent = buildReviewIntent(toReviewIntentInput(contexts[0])!);
    expect(firstIntent).toContain('총수: 2');
    expect(firstIntent).toContain('src/example-a.test.ts, src/example-b.test.ts');
    expect(firstIntent).toContain('파일 목록 절단: 예');
    expect(firstIntent).toContain('못 푼 상대 경로 지정자: 5');
    const unresolvedOnlyIntent = buildReviewIntent(toReviewIntentInput(contexts[1])!);
    expect(unresolvedOnlyIntent).toContain('총수: 0');
    expect(unresolvedOnlyIntent).toContain('못 푼 상대 경로 지정자: 5');
  });

  test('골이 REQUIRED EVIDENCE 태그를 주면 reviewDiff 가 충족도를 받는다', async () => {
    let seen: unknown;
    let seenCtx: unknown;
    const goal = [
      '태그를 요구하는 골',
      '',
      '## REQUIRED EVIDENCE',
      '- [alpha] 첫 확인',
      '- [beta] 둘째 확인',
    ].join('\n');
    await runSelfImplement({
      feature: goal,
      seams: seams({
        implement: async () => ({ ok: true, summary: 'impl', evidenceTranscript: 'EVIDENCE: [alpha] 첫 확인 || cmd\nRESULT: ok' }),
        reviewDiff: async (_cwd, ctx) => { seenCtx = ctx; seen = (ctx as { evidenceCoverage?: unknown } | undefined)?.evidenceCoverage; return { verdict: 'pass', mustFix: [], shouldFix: [], summary: 'r', reviewed: true, diffTruncated: false }; },
      }),
    });
    expect(seen).toEqual({
      required: 2,
      covered: 1,
      missing: ['beta'],
      coveredByLimitation: [],
      uncovered: ['beta'],
      coveredByLimitationCount: 0,
      uncoveredCount: 1,
      limitationCount: 0,
    });
    // ⛔⭐ 리뷰 2R must-fix — 위 단언은 **이음매 한쪽**만 본다. 실제 `ctx` 를 **진짜 빌더**에 넣어
    //   `orchestrator → ReviewDiffContext → buildReviewIntent → intent` 를 가로지른다(모의 없음).
    const intent = buildReviewIntent(seenCtx as Parameters<typeof buildReviewIntent>[0]);
    expect(intent).toContain('골이 요구한 증거 태그');
    expect(intent).toContain('태그 2개');
    expect(intent).toContain('매칭 1개');
    expect(intent).toContain('누락: beta');
  });

  test('Author limitation 덮임은 요구를 보존하면서 auto merge를 막지 않고, 실제 미덮임은 required-evidence-uncovered로 막는다', async () => {
    const events: Array<Record<string, unknown>> = [];
    const original = (debug as { log: typeof debug.log }).log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      if (event === 'merge-decision') events.push(data as Record<string, unknown>);
    }) as typeof debug.log;
    try {
      const reviewDiff = async () => ({ verdict: 'pass' as const, mustFix: [], shouldFix: [], summary: 'review pass', reviewed: true, diffTruncated: false });
      const coveredGoal = [
        'goal',
        '## REQUIRED EVIDENCE',
        '- [wiring] changed unit is reached from the existing caller',
        '## 답하지 못하는 것',
        '- Author limitation: changed unit is reached from the existing caller',
      ].join('\n');
      const uncoveredGoal = [
        'goal',
        '## REQUIRED EVIDENCE',
        '- [wiring] changed unit is reached from the existing caller',
        '## 답하지 못하는 것',
        '- Author limitation: another requirement',
      ].join('\n');
      const covered = await runSelfImplement({ feature: coveredGoal, autoMerge: true, seams: seams({ reviewDiff, mergePr: async () => ({ merged: true }) }) });
      const uncovered = await runSelfImplement({ feature: uncoveredGoal, autoMerge: true, seams: seams({ reviewDiff, mergePr: async () => ({ merged: true }) }) });
      expect(covered.stage).toBe('merged');
      expect(uncovered.stage).toBe('pr-opened');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(events).toEqual([
      expect.objectContaining({
        decision: 'auto', reason: 'review-clean-armed', evidenceCoverageMeasured: true, requiredEvidence: 1, coveredEvidence: 0,
        coveredByLimitationEvidence: ['wiring'], uncoveredEvidence: [], coveredByLimitationCount: 1, uncoveredCount: 0,
      }),
      expect.objectContaining({
        decision: 'hitl', reason: 'required-evidence-uncovered', evidenceCoverageMeasured: true, requiredEvidence: 1, coveredEvidence: 0,
        coveredByLimitationEvidence: [], uncoveredEvidence: ['wiring'], coveredByLimitationCount: 0, uncoveredCount: 1,
      }),
    ]);
  });

  test('Author limitation 덮임과 실제 미덮임을 같은 merge-decision에 남기고 자동 병합을 막는다', async () => {
    const events: Array<Record<string, unknown>> = [];
    let mergeCalls = 0;
    const original = (debug as { log: typeof debug.log }).log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      if (event === 'merge-decision') events.push(data as Record<string, unknown>);
    }) as typeof debug.log;
    try {
      const goal = [
        'goal',
        '## REQUIRED EVIDENCE',
        '- [wiring] changed unit is reached from the existing caller',
        '- [preservation] existing condition remains unchanged',
        '## 답하지 못하는 것',
        '- Author limitation: changed unit is reached from the existing caller',
      ].join('\n');
      const result = await runSelfImplement({
        feature: goal,
        autoMerge: true,
        seams: seams({
          reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'review pass', reviewed: true, diffTruncated: false }),
          mergePr: async () => { mergeCalls++; return { merged: true }; },
        }),
      });

      expect(result).toMatchObject({ stage: 'pr-opened', mergeReason: 'required-evidence-uncovered' });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }

    expect(mergeCalls).toBe(0);
    expect(events).toEqual([
      expect.objectContaining({
        decision: 'hitl',
        reason: 'required-evidence-uncovered',
        evidenceCoverageMeasured: true,
        requiredEvidence: 2,
        coveredByLimitationEvidence: ['wiring'],
        uncoveredEvidence: ['preservation'],
        coveredByLimitationCount: 1,
        uncoveredCount: 1,
      }),
    ]);
  });

  test('2개 요구 증거가 전부 누락되고 signal-incomplete이면 pass를 자동 머지나 completed로 굳히지 않는다', async () => {
    const original = (debug as { log: typeof debug.log }).log;
    const events: Array<{ event: string; data: Record<string, unknown>; level?: string }> = [];
    let mergeCalls = 0;
    (debug as { log: typeof debug.log }).log = ((_category, event, data, opt) => {
      events.push({ event, data: data as Record<string, unknown>, level: opt?.level });
    }) as typeof debug.log;
    try {
      const requiredEvidence = ['- [requested] required evidence', '- [preservation] required evidence'].join('\n');
      const result = await runSelfImplement({
        feature: `goal\n## REQUIRED EVIDENCE\n${requiredEvidence}`,
        autoMerge: true,
        seams: seams({
          implement: async ({ onLifecycleScreenClassification }) => {
            onLifecycleScreenClassification?.('signal-incomplete');
            return { ok: true, summary: 'no evidence was submitted' };
          },
          reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'review pass', reviewed: true, diffTruncated: false }),
          mergePr: async () => { mergeCalls++; return { merged: true }; },
        }),
      });
      expect(result.stage).toBe('pr-opened');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }

    expect(mergeCalls).toBe(0);
    expect(events.find((entry) => entry.event === 'merge-decision')?.data).toMatchObject({
      verdict: 'pass', decision: 'hitl', reason: 'required-evidence-uncovered', requiredEvidence: 2, coveredEvidence: 0,
      evidenceSource: 'summary-tail', anchoredEvidence: 0,
    });
    // ⛔⭐ 빈 배열이면 아래 루프 본문이 «한 번도» 안 돌아 «공허하게» 통과한다(리뷰 must-fix).
    //    ⇒ 두 이벤트가 실제로 있었다는 것을 «먼저» 못 박고 나서 값을 문다.
    expect(events.filter((entry) => entry.event === 'run-status' || entry.event === 'run-rollup')
      .map((entry) => entry.event).sort()).toEqual(['run-rollup', 'run-status']);
    for (const event of events.filter((entry) => entry.event === 'run-status' || entry.event === 'run-rollup')) {
      expect(event.data).toMatchObject({
        runStatus: 'failed',
        failureKind: 'review',
        completionBlockedBy: 'signal-incomplete',
      });
      expect(event.level).toBe('warn');
    }
  });

  test('골에 태그가 없으면 충족도를 안 보낸다 — 빈 계약을 만들지 않는다', async () => {
    let seen: unknown = 'unset';
    await runSelfImplement({
      feature: '태그 없는 골',
      seams: seams({
        reviewDiff: async (_cwd, ctx) => { seen = (ctx as { evidenceCoverage?: unknown } | undefined)?.evidenceCoverage; return { verdict: 'pass', mustFix: [], shouldFix: [], summary: 'r', reviewed: true, diffTruncated: false }; },
      }),
    });
    expect(seen).toBeUndefined();
  });

  // ⛔⭐⭐⭐ 리뷰 3R must-fix — 위 둘도 **프로덕션 어댑터의 매핑을 우회**한다. 실제로 그 매핑
  //   (`seams.ts` 의 `intentInput`)이 **필드별 명시**라 `evidenceCoverage` 가 빠져 있었고,
  //   ⇒ 값이 `ReviewDiffContext` 까지만 오고 **리뷰어 프롬프트에는 안 갔다**(프로덕션 죽은 코드).
  //   ⇒ 그 매핑을 **순수 함수로 뽑아**(`toReviewIntentInput`) git·네트워크 없이 직접 본다.
  test('프로덕션 매핑이 충족도를 리뷰 intent 입력으로 나른다', () => {
    const input = toReviewIntentInput({
      goal: '골 본문',
      round: 1,
      evidenceCoverage: {
        required: 2, covered: 1, missing: ['beta'], coveredByLimitation: [], uncovered: ['beta'], coveredByLimitationCount: 0, uncoveredCount: 1, limitationCount: 0,
      },
    });
    expect(input?.evidenceCoverage).toEqual({
      required: 2, covered: 1, missing: ['beta'], coveredByLimitation: [], uncovered: ['beta'], coveredByLimitationCount: 0, uncoveredCount: 1, limitationCount: 0,
    });
  });

  // ⛔⭐⭐⭐ 리뷰 4R must-fix — 위 둘은 `defaultSeams.reviewDiff` 가 `toReviewIntentInput` 호출을
  //   **지우거나 우회해도** 통과한다. ⇒ **프로덕션 어댑터를 실제로 통과**시킨다(git·LLM 은 주입 대체).
  test('프로덕션 reviewDiff 어댑터가 만든 phaseIntent 에 충족도가 실린다', async () => {
    // ⚠️ `llmReview` 는 **프롬프트 문자열을 받는 LLM 호출**이다(리뷰 결과를 만드는 것이 아니다).
    //   그래서 `phaseIntent` 는 그 **프롬프트 안**에 들어온다 — 거기서 잡는다.
    let prompt = '';
    const seamsForReview = defaultSeams({
      reviewScopeDiff: async () => 'diff --git a/x.ts b/x.ts\n+const a = 1;\n',
      llmReview: async (p: string) => { prompt = p; return JSON.stringify({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'r' }); },
    });
    const review = await seamsForReview.reviewDiff!('/any/worktree', {
      goal: '골 본문',
      round: 1,
      evidenceCoverage: {
        required: 2, covered: 1, missing: ['beta'], coveredByLimitation: [], uncovered: ['beta'], coveredByLimitationCount: 0, uncoveredCount: 1, limitationCount: 0,
      },
    });
    expect(review.reviewed).toBe(true);
    expect(prompt).toContain('골이 요구한 증거 태그');
    expect(prompt).toContain('태그 2개');
    expect(prompt).toContain('누락: beta');
  });

  // ⛔⭐⭐⭐ 리뷰 must-fix — 위 둘은 `evidenceCoverage` «만» 지킨다. 런 사실 셋(runId·커밋·변경 파일)은
  //   같은 어댑터를 지나가는데 그 경로에 회귀가 «없었다» ⇒ `toReviewIntentInput` 에서 세 줄을
  //   지워도 통과했다. ⭐ 여기서는 `openPr`·`commitWork` 를 **대체하지 않는다** — 순수 어댑터와
  //   프로덕션 `reviewDiff` 만 통과시켜, 「시점」이 아니라 「배선」을 정직하게 잰다.
  // ⛔⭐⭐⭐ 리뷰 must-fix — 재수집이 실패·빈 결과일 때 «옛 값이 최종 사실로 남던» 자리.
  //   ⭐ 틀린 좌표는 빈 좌표보다 나쁘다: 빈 칸은 「없다」를 말하고 틀린 칸은 「이것이다」를 말한다.
  test('런 사실 갱신은 재수집이 비면 옛 값을 «지운다» — 덮어쓰기가 아니다', () => {
    const stale = { goal: '골', commits: ['옛 커밋'], changedFiles: ['src/old.ts'] };
    const cleared = withRefreshedRunFacts(stale, {});
    expect('commits' in cleared).toBe(false);
    expect('changedFiles' in cleared).toBe(false);
    expect(cleared.goal).toBe('골');
  });

  test('런 사실 갱신은 한 종류만 걷혀도 나머지 옛 종류를 남기지 않는다', () => {
    const stale = { goal: '골', commits: ['옛 커밋'], changedFiles: ['src/old.ts'] };
    const refreshed = withRefreshedRunFacts(stale, { commits: ['새 커밋'] });
    expect(refreshed.commits).toEqual(['새 커밋']);
    expect('changedFiles' in refreshed).toBe(false);
  });

  test('프로덕션 매핑이 런 사실 셋을 리뷰 intent 입력으로 나른다', () => {
    const input = toReviewIntentInput({
      goal: '골 본문',
      round: 1,
      runId: 'run-abc123',
      commits: ['첫 커밋 제목', '둘째 커밋 제목'],
      changedFiles: ['src/a.ts', 'src/b.ts'],
    });
    expect(input?.runId).toBe('run-abc123');
    expect(input?.commits).toEqual(['첫 커밋 제목', '둘째 커밋 제목']);
    expect(input?.changedFiles).toEqual(['src/a.ts', 'src/b.ts']);
  });

  test('프로덕션 매핑은 빈 런 사실을 키째 빼서 빈 블록을 만들지 않는다', () => {
    const input = toReviewIntentInput({ goal: '골 본문', round: 1, runId: '  ', commits: [], changedFiles: [] });
    expect(input).toBeDefined();
    expect('runId' in input!).toBe(false);
    expect('commits' in input!).toBe(false);
    expect('changedFiles' in input!).toBe(false);
  });

  test('프로덕션 reviewDiff 어댑터가 만든 phaseIntent 에 런 사실과 골 문서가 실린다', async () => {
    let prompt = '';
    const seamsForReview = defaultSeams({
      reviewScopeDiff: async () => 'diff --git a/x.ts b/x.ts\n+const a = 1;\n',
      llmReview: async (p: string) => { prompt = p; return JSON.stringify({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'r' }); },
    });
    const review = await seamsForReview.reviewDiff!('/any/worktree', {
      goal: '골 본문',
      goalFile: 'docs/goals/GOAL-x-2026-09-14.md',
      round: 1,
      runId: 'run-abc123',
      commits: ['첫 커밋 제목'],
      changedFiles: ['src/a.ts'],
    });
    expect(review.reviewed).toBe(true);
    expect(prompt).toContain('run-abc123');
    expect(prompt).toContain('첫 커밋 제목');
    expect(prompt).toContain('src/a.ts');
    expect(prompt).toContain('이 런의 골 문서: docs/goals/GOAL-x-2026-09-14.md — 하니스가 발사 때 쓴 산출물이다. diff 에 있는 것이 정상이며 시험 부작용이 아니다.');
  });
});

// ⭐ RUN-S1 — 브랜치 슬러그 충돌(두 런이 한 워크트리를 동시에 고쳤다) 회귀 가드.
// 실측: 한국어 골 셋이 슬러그의 읽기용 앞부분에서 전부 `grounded-N-unverified-code-candidates-ge`
// 로 붕괴했고 그중 둘이 완전히 같았다(`grounded-7-…`). 원인은 `[^a-z0-9]` 를 전부 버리는 정규화라
// 비-ASCII 본문이 사라지고 뒤따르는 ASCII 보일러플레이트만 남는 것.
describe('slugifyFeature — 브랜치 유일성 (RUN-S1)', () => {
  const boilerplate = (n: number, ask: string) =>
    `${ask}\ngrounded: ${n} unverified code candidates (general search scope)\n\n## PROBLEM\n…`;

  test('본문이 전부 비-ASCII 여서 읽기용 앞부분이 같아져도 브랜치는 갈린다', () => {
    const a = slugifyFeature(boilerplate(7, '연쇄로 이어진 골 문서들이 원래 무엇을 달성하려던 것인지 적혀 있지 않다'));
    const b = slugifyFeature(boilerplate(7, '한 골에서 갈라져 나온 후속 골들이 전부 끝났는지 볼 수 없다'));
    // 읽기용 앞부분은 실제로 같다 — 이것이 사고의 기전이었다.
    expect(a.replace(/-[0-9a-f]{8}$/, '')).toBe(b.replace(/-[0-9a-f]{8}$/, ''));
    // ⭐ 그럼에도 최종 슬러그는 달라야 한다.
    expect(a).not.toBe(b);
  });

  test('같은 feature 는 같은 슬러그다 — --resume 이 같은 브랜치를 찾는다', () => {
    const f = boilerplate(5, '골 노드에 신원이 없어 그래프가 경로에 묶인다');
    expect(slugifyFeature(f)).toBe(slugifyFeature(f));
  });

  test('읽기용 앞부분을 보존하고 8자 다이제스트를 붙인다', () => {
    expect(slugifyFeature('Fix the branch slug collision')).toBe(
      `fix-the-branch-slug-collision-${createHash('sha256').update('Fix the branch slug collision').digest('hex').slice(0, 8)}`,
    );
  });

  test('비어 있는 feature 도 브랜치로 쓸 수 있다', () => {
    expect(slugifyFeature('…')).toMatch(/^feature-[0-9a-f]{8}$/);
  });
});

describe('runSelfImplement — quota refresh', () => {
  test('quota refresh seam failure is fail-soft and the run completes normally', async () => {
    const result = await runSelfImplement({
      feature: 'quota refresh failure remains non-blocking',
      seams: seams({
        refreshCodexQuotaSignals: async () => { throw new Error('quota unavailable'); },
      }),
    });
    expect(result.stage).toBe('pr-opened');
    expect(result.outcome).toBe('completed');
  });

  // ⛔⭐⭐ 리뷰 should-fix — 위 시험은 «던져도 안 죽는다»만 문다. 그러면 배선을 «통째로 지워도»
  //   통과한다(부르지 않으면 던질 일도 없다). ⇒ 정상 경로에서 «정확히 한 번» 불리는지도 문다.
  //   오늘 이 트랙이 배운 것과 같은 축이다: 「테스트가 코드를 무는가」 ≠ 「그 코드가 실행 경로에 있는가」.
  test('quota refresh seam is invoked exactly once on the normal path and the run proceeds', async () => {
    let calls = 0;
    const result = await runSelfImplement({
      feature: 'quota refresh runs once before the pipeline proceeds',
      seams: seams({
        refreshCodexQuotaSignals: async () => { calls += 1; return { accounts: [] }; },
      }),
    });
    expect(calls).toBe(1);
    expect(result.stage).toBe('pr-opened');
    expect(result.outcome).toBe('completed');
  });
});

// ⛔⭐⭐ 이 블록은 #7736 이 «지운 4,732줄과 함께» 들어왔던 것이다.
//   그 PR 은 구현은 옳았으나 «기존 테스트를 지워» revert 됐다(#7738).
//   ⇒ 구현과 이 테스트만 되살리고 ***삭제는 되살리지 않는다***. 테스트 수는 «늘어야» 한다.
describe('runSelfImplement — PR title path extraction', () => {
  test('uses only first-line paths for the PR title and the main-sync commit message', async () => {
    let prTitle = '';
    let commitTitle = '';
    const s = seams({
      commitWork: (_cwd, message) => { commitTitle = message; },
      mergeMain: async () => ({ status: 'up-to-date' }),
      openPr: async ({ title, head }) => {
        prTitle = title;
        return { url: `https://pr/${head}`, number: 7 };
      },
    });
    await runSelfImplement({
      feature: '대상 경로: src/self-implement/orchestrator.ts 및 src/self-implement/orchestrator.test.ts 의 prTitle 함수를 고친다.\n구현 요약은 제목 재료가 아니다.',
      seams: s,
    });

    expect(prTitle).toBe('src/self-implement: orchestrator.ts, orchestrator.test.ts');
    expect(prTitle).not.toStartWith('대상 경로');
    expect(commitTitle).toBe(prTitle);
    expect(prTitle.length).toBeLessThanOrEqual(72);
  });

  test('uses the optional prose title before extracting first-line paths and leaves branch naming on the original feature', async () => {
    let openedTitle = '';
    let createdBranch = '';
    const s = seams({
      createWorktree: async ({ branch }) => {
        createdBranch = branch;
        return { path: process.cwd(), branch };
      },
      openPr: async ({ title, head }) => {
        openedTitle = title;
        return { url: `https://pr/${head}`, number: 7 };
      },
    });
    const feature = '대상 경로: src/self-implement/orchestrator.ts · src/self-implement/orchestrator.test.ts\n제목: 산문 제목이 경로 목록보다 우선한다';
    await runSelfImplement({ feature, seams: s });

    expect(openedTitle).toBe('산문 제목이 경로 목록보다 우선한다');
    expect(createdBranch).toBe(`${WORKTREE_BRANCH_PREFIX}${slugifyFeature(feature)}`);
  });

  test.each(['', '   '])('falls back to the unchanged path title for a missing or whitespace-only prose title (%j)', async (titleValue) => {
    let openedTitle = '';
    const s = seams({
      openPr: async ({ title, head }) => {
        openedTitle = title;
        return { url: `https://pr/${head}`, number: 7 };
      },
    });
    await runSelfImplement({
      feature: `대상 경로: src/self-implement/orchestrator.ts · src/self-implement/orchestrator.test.ts\n제목: ${titleValue}`,
      seams: s,
    });

    expect(openedTitle).toBe('src/self-implement: orchestrator.ts, orchestrator.test.ts');
  });

  test('truncates a 100-character prose title to the existing 72-character limit', async () => {
    const proseTitle = 'P'.repeat(100);
    let openedTitle = '';
    const s = seams({
      openPr: async ({ title, head }) => {
        openedTitle = title;
        return { url: `https://pr/${head}`, number: 7 };
      },
    });
    await runSelfImplement({ feature: `대상 경로: src/a.ts\n제목: ${proseTitle}`, seams: s });

    expect(openedTitle).toBe(`${proseTitle.slice(0, 69)}...`);
    expect(openedTitle).toHaveLength(72);
  });

  test('preserves the exact 72-character first-line fallback when no path exists', async () => {
    const first = 'A'.repeat(80);
    let prTitle = '';
    const s = seams({
      openPr: async ({ title, head }) => {
        prTitle = title;
        return { url: `https://pr/${head}`, number: 7 };
      },
    });
    await runSelfImplement({ feature: `${first}\nsrc/ignored.ts must not affect the title`, seams: s });

    expect(prTitle).toBe(`${first.slice(0, 69)}...`);
    expect(prTitle).toHaveLength(72);
  });

  test.each([
    '/tmp/src/foo.ts',
    'https://host/src/foo.ts',
    '../src/foo.ts',
    'foo/../../src/bar.ts',
    String.raw`C:\repo\src\foo.ts`,
    String.raw`C:\repo/src/foo.ts/more`,
  ])('falls back exactly for a non-repository-relative path token (%s)', async (invalidPath) => {
    const first = `대상 경로: ${invalidPath} 의 제목을 고친다.`;
    let prTitle = '';
    let commitTitle = '';
    const s = seams({
      commitWork: (_cwd, message) => { commitTitle = message; },
      mergeMain: async () => ({ status: 'up-to-date' }),
      openPr: async ({ title, head }) => {
        prTitle = title;
        return { url: `https://pr/${head}`, number: 7 };
      },
    });
    await runSelfImplement({ feature: first, seams: s });

    expect(prTitle).toBe(first);
    expect(commitTitle).toBe(first);
  });

  test('extracts comma-delimited paths without whitespace into a shared directory title', async () => {
    let prTitle = '';
    const s = seams({
      openPr: async ({ title, head }) => {
        prTitle = title;
        return { url: `https://pr/${head}`, number: 7 };
      },
    });
    await runSelfImplement({ feature: '대상 경로: src/a.ts,src/b.ts 의 제목을 고친다.', seams: s });

    expect(prTitle).toBe('src: a.ts, b.ts');
    expect(prTitle).toHaveLength(15);
  });

  test('observes cumulative must-fix repeat counts through the rework execution loop', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    let reviewCall = 0;
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ category, event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const result = await runSelfImplement({
        feature: 'repeat-count observation',
        maxReworkRounds: 2,
        seams: seams({
          reviewDiff: async () => ++reviewCall === 1
            ? { verdict: 'fail' as const, mustFix: ['Call `validateRun` before persisting the review result.'], shouldFix: [], summary: 'failed', reviewed: true }
            : reviewCall === 2
              ? { verdict: 'fail' as const, mustFix: ['Guard the result write through `validateRun` after validation.'], shouldFix: [], summary: 'failed', reviewed: true }
              : { verdict: 'pass' as const, mustFix: [], shouldFix: [], summary: 'passed', reviewed: true },
        }),
      });
      expect(result.stage).toBe('pr-opened');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }

    const findingKey = 'symbol:["validateRun"]';
    expect(events.filter(({ category, event }) => category === 'self-dev.rework' && event === 'repeat-count')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({
        round: 0,
        counts: [{ id: findingKey, consecutiveRounds: 1 }],
        longestId: findingKey,
        longestConsecutiveRounds: 1,
        keySources: [{ key: findingKey, source: 'symbol' }],
      }) }),
      expect.objectContaining({ data: expect.objectContaining({
        round: 1,
        counts: [{ id: findingKey, consecutiveRounds: 2 }],
        longestId: findingKey,
        longestConsecutiveRounds: 2,
        keySources: [{ key: findingKey, source: 'symbol' }],
      }) }),
    ]);
  });

  test('keeps at least one filename when many first-line paths exceed the title limit', async () => {
    let prTitle = '';
    const s = seams({
      openPr: async ({ title, head }) => {
        prTitle = title;
        return { url: `https://pr/${head}`, number: 7 };
      },
    });
    await runSelfImplement({
      feature: `대상 경로: ${Array.from({ length: 8 }, (_, index) => `src/very-long-directory-name/component-${index}.test.ts`).join(', ')}`,
      seams: s,
    });

    expect(prTitle).toContain('component-0.test.ts');
    expect(prTitle.length).toBeLessThanOrEqual(72);
  });

  test('truncates a single overlong filename without passing an empty PR or commit title', async () => {
    const fileName = `${'a'.repeat(80)}.test.ts`;
    let prTitle = '';
    let commitTitle = '';
    const s = seams({
      commitWork: (_cwd, message) => { commitTitle = message; },
      mergeMain: async () => ({ status: 'up-to-date' }),
      openPr: async ({ title, head }) => {
        prTitle = title;
        return { url: `https://pr/${head}`, number: 7 };
      },
    });
    await runSelfImplement({ feature: `대상 경로: src/${fileName} 의 제목을 고친다.`, seams: s });

    expect(prTitle).not.toBe('');
    expect(prTitle).toBe(`${fileName.slice(0, 69)}...`);
    expect(prTitle).toHaveLength(72);
    expect(commitTitle).toBe(prTitle);
  });

  const unpairedSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  async function openedPrTitle(feature: string): Promise<string> {
    let title = '';
    await runSelfImplement({
      feature,
      seams: seams({
        openPr: async ({ title: opened, head }) => {
          title = opened;
          return { url: `https://pr/${head}`, number: 7 };
        },
      }),
    });
    return title;
  }

  test('uses the first markdown H1 before assembling first-line paths', async () => {
    const title = await openedPrTitle('# 관측 축을 하나 더 싣는다\nsrc/a/b.ts, src/a/c.ts');
    expect(title).toBe('관측 축을 하나 더 싣는다');
  });

  test('skips a shell comment inside a fenced bash block and uses the first-line prose title', () => {
    const shellComment = '⛔ 그 스크립트 머리말이 «변수 격리» 셋을 못 박았다';
    const feature = [
      '판정 신호가 기본 인자로 실물에서 한 번 돌려 보라를 요구하지 않으면 그 줄을 제목으로 쓴다',
      '',
      'Original ask (verbatim, unmodified):',
      '```bash',
      `# ${shellComment}`,
      'echo ok',
      '```',
    ].join('\n');
    const title = prTitle(feature);
    expect(title).toBe('판정 신호가 기본 인자로 실물에서 한 번 돌려 보라를 요구하지 않으면 그 줄을 제목으로 쓴다');
    expect(title).not.toContain(shellComment);
  });

  test('a shorter inner fence does not close the outer four-backtick fence that wraps the verbatim ask', () => {
    // 🩸 GOAL 문서의 실제 모양 — 원래 ask 를 ```` 로 싸고, 그 안에 ``` 블록들과 ```bash 블록이 있다.
    const shellComment = '⛔ 그 스크립트 머리말이 «변수 격리» 셋을 못 박았다';
    const feature = [
      '판정 신호가 기본 인자로 실물에서 한 번 돌려 보라를 요구하지 않으면 픽스처로 초록인 자가 착지한다',
      '- GoalId: c6b799485c24e04f',
      'Original ask (verbatim, unmodified):',
      '````',
      '## Complication',
      '```',
      '표 한 줄',
      '```',
      '```bash',
      `# ${shellComment}`,
      'echo ok',
      '```',
      '````',
    ].join('\n');
    const title = prTitle(feature);
    expect(title).toBe('판정 신호가 기본 인자로 실물에서 한 번 돌려 보라를 요구하지 않으면 픽스처로 초록인 자가 착지한다');
    expect(title).not.toContain(shellComment);
  });

  test('a GOAL document whose first line is a path list takes the H1 inside the verbatim original ask', () => {
    // 🩸 실물 모양(#20055 가 경로 요약 제목으로 착지): 첫 줄 `대상 경로:` · 진짜 제목은 인용된 ask 안의 H1 · 그 안에 ```bash 주석도 있다.
    const feature = [
      '대상 경로: src/self-implement/gate-baseline.ts · src/self-implement/gate-baseline.test.ts',
      '- GoalId: 0123456789abcdef',
      '',
      'Original ask (verbatim, unmodified):',
      '````',
      '대상 경로: src/self-implement/gate-baseline.ts · src/self-implement/gate-baseline.test.ts',
      '',
      '# 「타임아웃뿐이면 리뷰로 간다」가 기존 실패 하나 옆에서는 발동하지 않는다',
      '```bash',
      '# 셸 주석은 제목이 아니다',
      '```',
      '````',
    ].join('\n');
    expect(prTitle(feature)).toBe('「타임아웃뿐이면 리뷰로 간다」가 기존 실패 하나 옆에서는 발동하지 않는다');
  });

  test('skips a shell comment inside a tilde fence and uses the first-line prose title', () => {
    const shellComment = '틸드 펜스 안의 셸 주석';
    const feature = [
      '첫 줄 평문 제목이 틸드 펜스 주석보다 먼저다',
      '',
      '~~~bash',
      `# ${shellComment}`,
      'echo ok',
      '~~~',
    ].join('\n');
    const title = prTitle(feature);
    expect(title).toBe('첫 줄 평문 제목이 틸드 펜스 주석보다 먼저다');
    expect(title).not.toContain(shellComment);
  });

  test('uses a markdown H1 outside a fenced block even when a shell comment sits inside it', () => {
    const feature = [
      '대상 경로: src/a/b.ts',
      '```bash',
      '# 펜스 안 주석',
      '```',
      '# 진짜 제목',
    ].join('\n');
    expect(prTitle(feature)).toBe('진짜 제목');
  });

  test('keeps the prose title ahead of a markdown H1', async () => {
    const title = await openedPrTitle('대상 경로: src/a/b.ts\n제목: 진짜 제목\n# 다른 제목');
    expect(title).toBe('진짜 제목');
  });

  test('does not treat a markdown H2 as an H1 fallback', async () => {
    const title = await openedPrTitle('src/a/b.ts, src/a/c.ts\n## 두 번째 수준');
    expect(title).toBe('src/a: b.ts, c.ts');
  });

  test('uses the first of several markdown H1 lines', async () => {
    const title = await openedPrTitle('# 첫째\n# 둘째\nsrc/a/b.ts');
    expect(title).toBe('첫째');
  });

  test('skips an empty markdown H1 and assembles first-line paths', async () => {
    const title = await openedPrTitle('src/a/b.ts, src/a/c.ts\n# ');
    expect(title).toBe('src/a: b.ts, c.ts');
  });

  test('keeps the path-assembled title when neither a prose title nor an H1 exists', async () => {
    const title = await openedPrTitle('src/a/b.ts, src/a/c.ts');
    expect(title).toBe('src/a: b.ts, c.ts');
  });

  test('does not leave an unpaired surrogate when truncating emoji-heavy titles', async () => {
    const proseTitle = `${'가'.repeat(60)}${'🅣'.repeat(10)}`;
    const title = await openedPrTitle(`대상 경로: src/a.ts\n제목: ${proseTitle}`);
    expect(title).toBe(proseTitle);
    expect(unpairedSurrogate.test(title)).toBe(false);
    expect(Array.from(title)).toHaveLength(70);
  });

  test('leaves a title of 72 code points or fewer uncut', async () => {
    const proseTitle = `${'가'.repeat(62)}${'🅣'.repeat(10)}`;
    expect(Array.from(proseTitle)).toHaveLength(72);
    const title = await openedPrTitle(`대상 경로: src/a.ts\n제목: ${proseTitle}`);
    expect(title).toBe(proseTitle);
    expect(unpairedSurrogate.test(title)).toBe(false);
  });

  test('truncates an overlong emoji title on a code-point boundary', async () => {
    const proseTitle = `${'가'.repeat(63)}${'🅣'.repeat(10)}`;
    expect(Array.from(proseTitle)).toHaveLength(73);
    const title = await openedPrTitle(`대상 경로: src/a.ts\n제목: ${proseTitle}`);
    expect(title).toBe(`${Array.from(proseTitle).slice(0, 69).join('')}...`);
    expect(Array.from(title)).toHaveLength(72);
    expect(unpairedSurrogate.test(title)).toBe(false);
  });
});

describe('runSelfImplement — supervisor input next-round reinjection', () => {
  test('sends a terminal supervisor-only proposal once to the active child inbox', async () => {
    const features: string[] = [];
    const deliveries: Array<{ state: string; reason?: string }> = [];
    const inbox: Array<{ spaceId: string; memo: string }> = [];
    const s = revSeams({ features, gateResults: [true], reviews: [{ verdict: 'pass', reviewed: true }] });
    s.enqueueControlMemo = (spaceId, memo) => { inbox.push({ spaceId, memo: typeof memo === 'string' ? memo : memo.body }); };
    s.implement = async ({ feature, onSupervisorInput }) => {
      features.push(feature);
      onSupervisorInput?.('다음 라운드에서 회귀 테스트를 추가하라', (state, reason) => deliveries.push({ state, reason }));
      return { ok: true, summary: 'impl' };
    };

    const result = await runSelfImplement({ feature: '감독 단독 제안 정상 종결', seams: s });

    expect(result.stage).toBe('pr-opened');
    expect(features).toHaveLength(1);
    expect(inbox).toEqual([{ spaceId: 'feature-5a9c816d', memo: '다음 라운드에서 회귀 테스트를 추가하라' }]);
    expect(deliveries).toEqual([{ state: 'inbox-delivered' }]);
  });

  test('gate failure carries a concurrent supervisor proposal into the next rework prompt without using the inbox', async () => {
    const features: string[] = [];
    const inbox: Array<{ spaceId: string; memo: string }> = [];
    const s = revSeams({ features, gateResults: [false, true], reviews: [{ verdict: 'pass', reviewed: true }] });
    s.enqueueControlMemo = (spaceId, memo) => { inbox.push({ spaceId, memo: typeof memo === 'string' ? memo : memo.body }); };
    let calls = 0;
    s.implement = async ({ feature, onSupervisorInput }) => {
      features.push(feature);
      if (calls++ === 0) onSupervisorInput?.('gate와 함께 전달할 감독 제안');
      return { ok: true, summary: 'impl' };
    };

    const result = await runSelfImplement({ feature: 'gate와 감독 병합', maxReworkRounds: 1, seams: s });

    expect(result.stage).toBe('pr-opened');
    expect(features).toHaveLength(2);
    expect(features[1]).toContain('[gate 실패]');
    expect(features[1]).toContain('[감독 input 제안 — 다음 라운드에서 반드시 검토]');
    expect(features[1]).toContain('gate와 함께 전달할 감독 제안');
    expect(inbox).toEqual([]);
  });

  test('review must-fix carries a concurrent supervisor proposal into the next rework input', async () => {
    const features: string[] = [];
    const s = revSeams({
      features,
      gateResults: [true, true],
      reviews: [
        { verdict: 'fail', reviewed: true, mustFix: ['리뷰 blocker'] },
        { verdict: 'pass', reviewed: true },
      ],
    });
    let calls = 0;
    s.implement = async ({ feature, onSupervisorInput }) => {
      features.push(feature);
      if (calls++ === 0) onSupervisorInput?.('리뷰와 함께 전달할 감독 제안');
      return { ok: true, summary: 'impl' };
    };

    const result = await runSelfImplement({ feature: '리뷰와 감독 재투입', maxReworkRounds: 1, seams: s });

    expect(result.stage).toBe('pr-opened');
    expect(features).toHaveLength(2);
    expect(features[1]).toContain('[리뷰 must-fix — 반드시 반영]');
    expect(features[1]).toContain('[감독 input 제안 — 다음 라운드에서 반드시 검토]');
    expect(features[1]).toContain('리뷰와 함께 전달할 감독 제안');
  });

  test('records a named inbox-send-failed result and preserves the memo when terminal inbox publication throws', async () => {
    const deliveries: Array<{ state: string; reason?: string }> = [];
    const inbox: Array<{ spaceId: string; memo: string }> = [];
    let draftBody = '';
    const s = revSeams({ gateResults: [false], reviews: [{ verdict: 'pass', reviewed: true }] });
    s.enqueueControlMemo = (spaceId, memo) => {
      inbox.push({ spaceId, memo: typeof memo === 'string' ? memo : memo.body });
      throw new Error('inbox unavailable');
    };
    s.openPr = async ({ body }) => {
      draftBody = body;
      return { url: 'https://pr/inbox-send-failed', number: 94 };
    };
    s.implement = async ({ onSupervisorInput }) => {
      onSupervisorInput?.('인박스 실패를 기록하라', (state, reason) => deliveries.push({ state, reason }));
      return { ok: true, summary: 'impl' };
    };

    const result = await runSelfImplement({ feature: '터미널 인박스 실패 기록', maxReworkRounds: 0, seams: s });

    expect(result.stage).toBe('gate-failed');
    expect(inbox).toEqual([expect.objectContaining({ spaceId: expect.any(String), memo: '인박스 실패를 기록하라' })]);
    expect(deliveries).toEqual([{ state: 'inbox-send-failed', reason: 'inbox-send-failed' }]);
    expect(draftBody).toContain('인박스 실패를 기록하라');
    expect(draftBody).toContain('- reason: inbox-send-failed');
  });

  test('empty supervisor input does not create a next round and terminates its callback as not delivered', async () => {
    const features: string[] = [];
    const deliveries: Array<{ state: string; reason?: string }> = [];
    const s = revSeams({ features });
    s.implement = async ({ feature, onSupervisorInput }) => {
      features.push(feature);
      onSupervisorInput?.('   ', (state, reason) => deliveries.push({ state, reason }));
      return { ok: true, summary: 'impl' };
    };

    await runSelfImplement({ feature: '빈 감독 제안', seams: s });
    expect(features.every((feature) => !feature.includes('[감독 input 제안'))).toBe(true);
    expect(deliveries).toEqual([{ state: 'not-delivered', reason: 'empty-supervisor-input' }]);
  });

  test('supervisor-only input does not invoke a next-round implementation that could fail synchronously', async () => {
    const deliveries: Array<{ state: string; reason?: string }> = [];
    const s = revSeams({ gateResults: [true], reviews: [{ verdict: 'pass', reviewed: true }] });
    s.implement = (({ onSupervisorInput }) => {
      onSupervisorInput?.('다음 호출 실패를 보고하라', (state, reason) => deliveries.push({ state, reason }));
      return Promise.resolve({ ok: true, summary: 'impl' });
    }) as SelfImplementSeams['implement'];

    const result = await runSelfImplement({ feature: '동기 호출 실패 차단', seams: s });

    expect(result.stage).toBe('pr-opened');
    expect(deliveries).toEqual([{ state: 'inbox-delivered' }]);
  });

  test('final-round gate failure preserves undelivered supervisor instructions in the draft and observation without creating a next round', async () => {
    const original = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const deliveries: Array<{ state: string; reason?: string }> = [];
      const features: string[] = [];
      let draftBody = '';
      const inbox: Array<{ spaceId: string; memo: string }> = [];
      const s = revSeams({ features, gateResults: [false] });
      s.enqueueControlMemo = (spaceId, memo) => { inbox.push({ spaceId, memo: typeof memo === 'string' ? memo : memo.body }); };
      s.openPr = async ({ body }) => {
        draftBody = body;
        return { url: 'https://pr/final-gate-delivery', number: 91 };
      };
      s.implement = async ({ feature, onSupervisorInput }) => {
        features.push(feature);
        onSupervisorInput?.('첫 수리 지시', (state, reason) => deliveries.push({ state, reason }));
        onSupervisorInput?.('둘째 수리 지시', (state, reason) => deliveries.push({ state, reason }));
        return { ok: true, summary: 'impl' };
      };

      const result = await runSelfImplement({ feature: 'final gate delivery', maxReworkRounds: 0, seams: s });

      expect(result.stage).toBe('gate-failed');
      expect(features).toHaveLength(1);
      expect(deliveries).toEqual([
        { state: 'not-delivered', reason: 'superseded-by-later-supervisor-input' },
        { state: 'inbox-delivered', reason: undefined },
      ]);
      expect(inbox).toEqual([expect.objectContaining({ spaceId: expect.any(String), memo: '둘째 수리 지시' })]);
      expect(draftBody).toContain('## 미배달 감독 수리 지시');
      expect(draftBody).toContain('첫 수리 지시');
      expect(draftBody).not.toContain('둘째 수리 지시');
      expect(draftBody).not.toContain('- reason: rework-round-limit');
      expect(events.filter((entry) => entry.event === 'rework-blocked-draft-pr')).toEqual(expect.arrayContaining([
        expect.objectContaining({ data: expect.objectContaining({
          number: 91,
          undeliveredSupervisorInputCount: 1,
          undeliveredSupervisorInputs: [
            { text: '첫 수리 지시', reason: 'superseded-by-later-supervisor-input' },
          ],
        }) }),
      ]));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('delivers only the latest supervisor instruction after multiple inputs and preserves superseded input in the draft and observation', async () => {
    const original = debug.log;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const features: string[] = [];
      const deliveries: Array<{ text: string; state: string; reason?: string }> = [];
      let draftBody = '';
      const s = revSeams({ features, gateResults: [false, false] });
      s.openPr = async ({ body }) => {
        draftBody = body;
        return { url: 'https://pr/superseded-supervisor', number: 93 };
      };
      let calls = 0;
      s.implement = async ({ feature, onSupervisorInput }) => {
        features.push(feature);
        if (calls++ === 0) {
          onSupervisorInput?.('앞선 감독 지시', (state, reason) => deliveries.push({ text: '앞선 감독 지시', state, reason }));
          onSupervisorInput?.('최종 감독 지시', (state, reason) => deliveries.push({ text: '최종 감독 지시', state, reason }));
        }
        return { ok: true, summary: 'impl' };
      };

      const result = await runSelfImplement({ feature: 'superseded supervisor input', maxReworkRounds: 1, seams: s });

      expect(result.stage).toBe('gate-failed');
      expect(features).toHaveLength(2);
      expect(features[1]).not.toContain('앞선 감독 지시');
      expect(features[1]).toContain('최종 감독 지시');
      expect(deliveries).toEqual([
        { text: '앞선 감독 지시', state: 'not-delivered', reason: 'superseded-by-later-supervisor-input' },
        { text: '최종 감독 지시', state: 'prompt-included' },
        { text: '최종 감독 지시', state: 'delivered' },
      ]);
      expect(draftBody).toContain('앞선 감독 지시');
      expect(draftBody).toContain('- reason: superseded-by-later-supervisor-input');
      expect(draftBody).not.toContain('최종 감독 지시');
      expect(events.filter((entry) => entry.event === 'rework-blocked-draft-pr')).toEqual(expect.arrayContaining([
        expect.objectContaining({ data: expect.objectContaining({
          number: 93,
          undeliveredSupervisorInputCount: 1,
          undeliveredSupervisorInputs: [
            { text: '앞선 감독 지시', reason: 'superseded-by-later-supervisor-input' },
          ],
        }) }),
      ]));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('blocked draft explicitly distinguishes no supervisor instruction from an instruction delivered to a rework round', async () => {
    const noInstruction = assembleBlockedDraftPrBody('F', 'summary', {
      salvageStatusExpected: false,
      reason: 'blocked',
      rounds: 0,
      undeliveredSupervisorInputs: [],
    });
    expect(noInstruction.body).toContain('(없음 — 감독 수리 지시가 없었거나 모든 지시가 다음 라운드에 전달됨)');

    const features: string[] = [];
    let draftBody = '';
    const s = revSeams({ features, gateResults: [false, false] });
    s.openPr = async ({ body }) => {
      draftBody = body;
      return { url: 'https://pr/delivered-supervisor', number: 92 };
    };
    let calls = 0;
    s.implement = async ({ feature, onSupervisorInput }) => {
      features.push(feature);
      if (calls++ === 0) onSupervisorInput?.('다음 라운드로 배달할 지시');
      return { ok: true, summary: 'impl' };
    };

    const result = await runSelfImplement({ feature: 'delivered supervisor instruction', maxReworkRounds: 1, seams: s });

    expect(result.stage).toBe('gate-failed');
    expect(features).toHaveLength(2);
    expect(features[1]).toContain('다음 라운드로 배달할 지시');
    expect(draftBody).toContain('(없음 — 감독 수리 지시가 없었거나 모든 지시가 다음 라운드에 전달됨)');
    expect(draftBody).not.toContain('다음 라운드로 배달할 지시');
  });

  test('final-round review blocker with a concurrent supervisor task preserves a draft instead of accepting review-only salvage', async () => {
    const deliveries: Array<{ state: string; reason?: string }> = [];
    let draft: boolean | undefined;
    const s = revSeams({ gateResults: [true], reviews: [{ verdict: 'fail', reviewed: true, mustFix: ['fix review'] }] });
    s.openPr = async ({ draft: openedDraft, head }) => {
      draft = openedDraft;
      return { url: `https://pr/${head}`, number: 7 };
    };
    s.implement = async ({ onSupervisorInput }) => {
      onSupervisorInput?.('review failure fix', (state, reason) => deliveries.push({ state, reason }));
      return { ok: true, summary: 'impl' };
    };

    const result = await runSelfImplement({ feature: 'final review delivery', maxReworkRounds: 0, seams: s });

    expect(result).toMatchObject({ stage: 'review-blocked', ok: false });
    expect(draft).toBe(true);
    expect(deliveries).toEqual([{ state: 'inbox-delivered', reason: undefined }]);
  });

  test('async implement rejection terminates callbacks queued by that implement call', async () => {
    const deliveries: Array<{ state: string; reason?: string }> = [];
    const s = revSeams({});
    s.implement = async ({ onSupervisorInput }) => {
      onSupervisorInput?.('rejection recovery', (state, reason) => deliveries.push({ state, reason }));
      throw new Error('async implement rejection');
    };

    await expect(runSelfImplement({ feature: 'async reject delivery', seams: s })).rejects.toThrow('async implement rejection');
    expect(deliveries).toEqual([{ state: 'not-delivered', reason: 'next-round-implement-rejected' }]);
  });

  test('implement timeout terminates callbacks queued by that implement call', async () => {
    const deliveries: Array<{ state: string; reason?: string }> = [];
    const s = revSeams({});
    s.implement = async ({ onSupervisorInput }) => {
      onSupervisorInput?.('timeout recovery', (state, reason) => deliveries.push({ state, reason }));
      return new Promise(() => {});
    };

    const result = await runSelfImplement({ feature: 'timeout delivery', stepTimeouts: { implement: 20 }, seams: s });
    expect(result.stage).toBe('timed-out');
    expect(deliveries).toEqual([{ state: 'not-delivered', reason: 'next-round-implement-timeout' }]);
  });

  // ⛔⭐ 위 테스트는 입력을 **promise 가 멈추기 «전»** 에 동기 큐잉하므로, 「타임아웃 «뒤»에
  //   늦게 도착하는 입력」 경로를 짚지 못한다(무인 리뷰 must-fix · 2026-08-14).
  //   `withStepTimeout` 은 자식 promise 를 «취소하지 않는다» — 자식은 계속 살아서 나중에 콜백을 부른다.
  //   닫는 표식이 없으면 그 입력이 이미 비워진 큐에 다시 쌓여 **영영 종결되지 않는다**.
  test('supervisor input arriving after the implement timeout is closed out, not queued', async () => {
    const deliveries: Array<{ state: string; reason?: string }> = [];
    const s = revSeams({});
    let lateInput: ((text: string, updateDelivery?: (state: string, reason?: string) => void) => void) | undefined;
    s.implement = (({ onSupervisorInput }: { onSupervisorInput?: typeof lateInput }) => {
      lateInput = onSupervisorInput;
      return new Promise(() => {});   // 끝나지 않는다 — 타임아웃이 확정된 뒤에도 자식은 살아 있다
    }) as unknown as typeof s.implement;

    const result = await runSelfImplement({ feature: 'late supervisor delivery', stepTimeouts: { implement: 20 }, seams: s });
    expect(result.stage).toBe('timed-out');
    expect(deliveries).toEqual([]);   // 아직 아무도 안 보냈다

    // ⭐ 여기서부터가 이 테스트의 본체 — 타임아웃이 «확정된 뒤» 자식이 늦게 보낸다.
    lateInput?.('타임아웃 뒤 늦게 도착한 감독 입력', (state, reason) => deliveries.push({ state, reason }));
    expect(deliveries).toEqual([{ state: 'not-delivered', reason: 'late-supervisor-input' }]);
  });

  test('records the latest supervisor-only proposal as inbox-delivered when no failed rework requires another round', async () => {
    const features: string[] = [];
    const deliveries: Array<{ text: string; state: string; reason?: string }> = [];
    const s = revSeams({ features, gateResults: [true], reviews: [{ verdict: 'pass', reviewed: true }] });
    s.implement = async ({ feature, onSupervisorInput }) => {
      features.push(feature);
      for (const text of ['첫 감독 제안', '둘째 감독 제안']) {
        onSupervisorInput?.(text, (state, reason) => deliveries.push({ text, state, reason }));
      }
      return { ok: true, summary: 'impl' };
    };

    const result = await runSelfImplement({ feature: '복수 감독 제안 정상 종결', seams: s });

    expect(result.stage).toBe('pr-opened');
    expect(features).toHaveLength(1);
    expect(deliveries).toEqual([
      { text: '첫 감독 제안', state: 'not-delivered', reason: 'superseded-by-later-supervisor-input' },
      { text: '둘째 감독 제안', state: 'inbox-delivered', reason: undefined },
    ]);
  });

  test('review blocker wins terminal classification while preserving the concurrent supervisor proposal', async () => {
    const features: string[] = [];
    const s = revSeams({
      features,
      gateResults: [true, true],
      reviews: [
        { verdict: 'fail', reviewed: true, mustFix: ['리뷰 blocker'] },
        { verdict: 'fail', reviewed: true, mustFix: ['리뷰 blocker'] },
      ],
    });
    let calls = 0;
    s.implement = async ({ feature, onSupervisorInput }) => {
      features.push(feature);
      if (calls++ === 0) onSupervisorInput?.('감독 병합 제안');
      return { ok: true, summary: 'impl' };
    };
    s.diagnose = async () => 'BUDGET: UNCONVERGEABLE\nREASON: review blocker remains';

    const result = await runSelfImplement({ feature: '리뷰와 감독 병합', maxReworkRounds: 1, seams: s });

    expect(features[1]).toContain('감독 병합 제안');
    expect(features[1]).toContain('리뷰 blocker');
    expect(result.stage).toBe('review-blocked');
  });
});


describe('main-sync 관측 payload (OBS-T96 🅐)', () => {
  // 🚨 이 회귀가 막는 것: `mergeTarget` 을 `opts.base` 로 채우는 형태.
  //   정합 seam 은 «호출부가 해석한 대상»과 병합한다(llm-conflict-merge.ts:87 은 그 대상을 인자로 받는다).
  //   그래서 관측의 `mergeTarget` 은 «그 대상»이어야 하고, 사람이 준 `--base` 는 `runBase` 로 «따로» 실린다.
  //   둘을 한 칸에 합치면 --base 를 준 런에서 ***관측이 거짓을 낸다***.
  //
  // ⛔⭐ 그리고 이 describe 는 «항상 origin/main» 을 단정하지 않는다 — 그것이 옛 계약이다.
  //   아래 셋 중 마지막이 그 «구별력»을 갖는다: origin/main 이 아닌 대상을 주면 그대로 실려야 한다.
  //   ⇒ origin/main «만» 넘기는 시험들은 「전달된다」와 「박혀 있다」를 가르지 못한다.
  test('base 를 준 런에서도 mergeTarget 은 «해석된 대상»이고 runBase 는 «따로» 실린다', () => {
    const observation = mainSyncObservation({ status: 'merged', resolvedFiles: [] }, 'origin/main', 'legacy-human-base', 'wt/x');
    expect(observation.mergeTarget).toBe('origin/main');
    expect(observation.runBase).toBe('legacy-human-base');
  });

  test('base 가 없으면 runBase 칸을 «만들지 않는다» — 기본값을 사실로 단정하지 않는다', () => {
    const observation = mainSyncObservation({ status: 'merged' }, 'origin/main', undefined, 'wt/x');
    expect('runBase' in observation).toBe(false);
    expect(observation.mergeTarget).toBe('origin/main');
  });

  // ⭐ 구별력 — 원격이 없는 저장소는 origin/main 이 «안 풀린다». 그때 해석기가 내는 다른 이름이
  //   관측에 그대로 실려야 한다. 이 시험이 실패하면 그 자리가 다시 문자열을 박은 것이다.
  test('해석된 대상이 origin/main 이 «아니어도» 그대로 실린다 — 이름을 박지 않는다', () => {
    for (const target of ['main', 'master', 'origin/master'] as const) {
      const observation = mainSyncObservation({ status: 'merged', resolvedFiles: [] }, target, undefined, 'wt/x');
      expect(observation.mergeTarget).toBe(target);
    }
  });

  test('LLM 병합의 규모·선언 손실·미측정 사실을 관측에 보존한다', () => {
    const sizeChange = { totalDeltaLines: -12 };
    const testDeclarationLoss = [{ file: 'src/x.test.ts', ours: 3, theirs: 3, merged: 1 }];
    const observation = mainSyncObservation({
      status: 'conflict-unresolved',
      sizeChange,
      testDeclarationLoss,
      testDeclarationUnmeasured: ['src/y.test.ts'],
    }, 'origin/main', undefined, 'wt/x');
    expect(observation).toMatchObject({ sizeChange, testDeclarationLoss, testDeclarationUnmeasured: ['src/y.test.ts'] });
    expect('errorStep' in observation).toBe(false);
    expect('errorDetail' in observation).toBe(false);
  });

  test('errorStep·errorDetail 이 있으면 pre-pr-sync 관측 모양에 싣고 없으면 칸을 만들지 않는다', () => {
    const withError = mainSyncObservation({
      status: 'error',
      errorStep: 'fetch',
      errorDetail: 'fatal: unable to access',
    }, 'origin/main', undefined, 'wt/x');
    expect(withError).toMatchObject({ status: 'error', errorStep: 'fetch', errorDetail: 'fatal: unable to access' });
    const withoutError = mainSyncObservation({ status: 'merged' }, 'origin/main', undefined, 'wt/x');
    expect('errorStep' in withoutError).toBe(false);
    expect('errorDetail' in withoutError).toBe(false);
  });

  test('정합에 관여한 파일을 «이름»으로 싣되 배열 상한 6을 넘지 않는다', () => {
    const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const observation = mainSyncObservation({ status: 'llm-resolved', resolvedFiles: files }, 'origin/main', undefined, 'wt/x');
    expect(observation.resolved).toBe(8);                    // 전체 수는 그대로 답한다
    expect(observation.resolvedFileNames).toEqual(files.slice(0, 6));
  });
});

describe('정합 뒤 게이트 관측 payload (OBS-T96 🅐)', () => {
  const detect = (output: string) => /not found in module/.test(output);

  test('통과면 진단 칸을 «만들지 않는다» — 성공 경로 payload 는 그대로다', () => {
    const observation = postSyncGateObservation({ passed: true, scopeReason: 'changed-files' }, 'wt/x', detect, 'merged');
    expect(observation.passed).toBe(true);
    expect('moduleLoadFailure' in observation).toBe(false);
    expect('testStepExecuted' in observation).toBe(false);
  });

  test('재게이트가 잰 범위 파일 수와 comparison base를 항상 남긴다', () => {
    const measured = postSyncGateObservation(
      { passed: true, scopeReason: 'changed-tests', measuredFileCount: 4, comparisonBase: 'abc' },
      'wt/x', detect, 'merged');
    expect(measured).toMatchObject({ measuredFileCount: 4, comparisonBase: 'abc' });
    const empty = postSyncGateObservation(
      { passed: false, scopeReason: 'unmeasured', measuredFileCount: 0, comparisonBase: 'abc' },
      'wt/x', detect, 'merged');
    expect(empty).toMatchObject({ passed: false, measuredFileCount: 0, comparisonBase: 'abc', scopeReason: 'unmeasured' });
  });

  test('실패면 모듈 로드 실패 여부와 테스트 실행 여부를 «값»으로 답한다', () => {
    const observation = postSyncGateObservation(
      { passed: false, log: "Export named 'tierModel' not found in module 'x.ts'", testStepExecuted: false },
      'wt/x', detect, 'merged');
    expect(observation.moduleLoadFailure).toBe(true);
    expect(observation.testStepExecuted).toBe(false);
  });

  test('실패인데 테스트 실행 여부를 «모르면» null 로 남긴다 — false 로 단정하지 않는다', () => {
    const observation = postSyncGateObservation({ passed: false, log: '1 fail' }, 'wt/x', detect, 'merged');
    expect(observation.moduleLoadFailure).toBe(false);
    expect(observation.testStepExecuted).toBe(null);
  });

  test('clean merged 실패만 자식 책임 없음 면책으로 기록한다', () => {
    const observation = postSyncGateObservation(
      { passed: false, reflectGateFacts: { introduced: 0, preexisting: 2, unknown: 1, childResponsibility: 'none' } },
      'wt/x', detect, 'merged');
    expect(observation).toMatchObject({ syncStatus: 'merged', passed: false, childResponsibility: 'none', exempted: true, exemptionWithheld: false });
  });

  test('LLM 해소 뒤 자식 책임 없음 실패는 면책을 보류해 두 boolean을 구별한다', () => {
    const observation = postSyncGateObservation(
      { passed: false, reflectGateFacts: { introduced: 0, preexisting: 2, unknown: 1, childResponsibility: 'none' } },
      'wt/x', detect, 'llm-resolved');
    expect(observation).toMatchObject({ syncStatus: 'llm-resolved', passed: false, childResponsibility: 'none', exempted: false, exemptionWithheld: true });
  });

  test('통과와 자식 책임 실패는 면책 보류가 아니다', () => {
    const passed = postSyncGateObservation({ passed: true }, 'wt/x', detect, 'llm-resolved');
    const responsible = postSyncGateObservation(
      { passed: false, reflectGateFacts: { introduced: 1, preexisting: 0, unknown: 0, childResponsibility: 'child' } },
      'wt/x', detect, 'llm-resolved');
    expect(passed).toMatchObject({ syncStatus: 'llm-resolved', exempted: false, exemptionWithheld: false });
    expect(responsible).toMatchObject({ childResponsibility: 'child', exempted: false, exemptionWithheld: false });
  });

  test('실패면 gate가 계산한 introduced·preexisting·unknown·timedOut 귀속 수를 모두 기록한다', () => {
    const observation = postSyncGateObservation(
      { passed: false, log: 'timeout', reflectGateFacts: { introduced: 1, preexisting: 2, unknown: 3, timedOut: 4 } },
      'wt/x', detect, 'merged');
    expect(observation).toMatchObject({ introduced: 1, preexisting: 2, unknown: 3, timedOut: 4 });
  });
});


describe('연합 키 관측 (대표 "원장은 T 세션 쪽" · §ⓐ§ⓑ 공통 근본)', () => {
  // 🚨 이 회귀가 막는 것: 홀로 도는 런에 pieceTotal=1 을 붙여 「연합인 척」하게 만드는 형태.
  //   그러면 전수 조회에서 「연합 런 = 전부」가 되어 그 수가 «그럴듯하게» 무의미해진다.
  test('연합이 아니면 «아무 칸도» 만들지 않는다', () => {
    expect(federationObservation({ pieceTotal: 1 })).toEqual({});
  });

  test('orchestrationId 만 있어도 연합으로 본다 — 조인 키가 그것이다', () => {
    const observation = federationObservation({ pieceTotal: 1, orchestrationId: 'orch-1' });
    expect(observation.orchestrationId).toBe('orch-1');
    expect(observation.pieceTotal).toBe(1);
  });

  test('조각 수가 2 이상이면 연합이다 — id 가 아직 없어도', () => {
    expect(federationObservation({ pieceTotal: 5 }).pieceTotal).toBe(5);
  });

  test('형제 목록은 상한 6 이지만 «전체 수»를 따로 답한다 — 분모를 잃지 않는다', () => {
    const siblings = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];
    const observation = federationObservation({ pieceTotal: 9, orchestrationId: 'o', siblingShardIds: siblings });
    expect(observation.siblingShardIds).toEqual(siblings.slice(0, 6));
    expect(observation.siblingShardCount).toBe(8);
  });

  test('shardId·위치·읽기 실패 사유를 그대로 싣는다', () => {
    const observation = federationObservation({
      pieceTotal: 3, orchestrationId: 'o', shardId: 'task:abc', pieceIndex: 2,
      shardIdentityReadFailure: 'malformed-json',
    } as unknown as Parameters<typeof federationObservation>[0]);
    expect(observation.shardId).toBe('task:abc');
    expect(observation.shardPosition).toBe(2);
    expect(observation.shardIdentityReadFailure).toBe('malformed-json');
  });
});


describe('makeRunObserver 가 연합 키를 «로그에» 실어 보낸다 (배선 회귀 · OBS-T101)', () => {
  // 🚨 이 회귀가 막는 것: observed 에서 연합 spread 를 «지우는» 것.
  //   ⛔ 앞 판본의 반증은 «두 변이를 동시에» 해서 어느 것이 물렸는지 못 갈랐다 —
  //     배선을 지워도 순수 함수 테스트는 통과한다(무인 리뷰 must-fix 2026-08-19).
  //   ⇒ 반증도 「한 번에 하나」여야 한다. 이 회귀는 «배선만» 문다.
  const capture = () => {
    const logged: { category: string; event: string; data: Record<string, unknown> }[] = [];
    const ledger: Record<string, unknown>[] = [];
    const log = ((category: string, event: string, data: Record<string, unknown>) => {
      logged.push({ category, event, data });
    }) as unknown as Parameters<typeof makeRunObserver>[2];
    return { logged, ledger, log };
  };

  test('연합 런이면 로그 payload 에 orchestrationId·shardId 가 실린다', () => {
    const { logged, ledger, log } = capture();
    const observe = makeRunObserver('run-x', 'goal-1', log, (entry) => { ledger.push(entry as unknown as Record<string, unknown>); }, {
      pieceTotal: 4, orchestrationId: 'orch-7', shardId: 'task:zz', pieceIndex: 1,
    });
    observe('probe', { some: 'value' });
    expect(logged).toHaveLength(1);
    expect(logged[0]!.data.orchestrationId).toBe('orch-7');
    expect(logged[0]!.data.shardId).toBe('task:zz');
    expect(logged[0]!.data.shardPosition).toBe(1);
    expect(logged[0]!.data.runId).toBe('run-x');       // 기존 필드는 그대로다
    expect(logged[0]!.data.some).toBe('value');
  });

  test('연합이 아니면 로그 payload 에 연합 칸이 «없다» — 홀로 도는 런이 연합인 척하지 않는다', () => {
    const { logged, ledger, log } = capture();
    const observe = makeRunObserver('run-y', 'goal-2', log, (entry) => { ledger.push(entry as unknown as Record<string, unknown>); });
    observe('probe', { some: 'value' });
    expect('orchestrationId' in logged[0]!.data).toBe(false);
    expect('shardId' in logged[0]!.data).toBe(false);
    expect('pieceTotal' in logged[0]!.data).toBe(false);
  });

  test('shardId «단독»이어도 연합으로 본다 — 조각 식별자가 있으면 연합이다', () => {
    expect(federationObservation({ pieceTotal: 1, shardId: 'task:solo' }).shardId).toBe('task:solo');
  });

  test('event data 가 같은 키를 가지면 «연합 값이 이긴다» — 조인 키가 흔들리면 못 묶는다', () => {
    const { logged, ledger, log } = capture();
    const observe = makeRunObserver('run-z', undefined, log, (entry) => { ledger.push(entry as unknown as Record<string, unknown>); }, {
      pieceTotal: 2, orchestrationId: 'orch-real',
    });
    observe('probe', { orchestrationId: 'orch-from-data' });
    expect(logged[0]!.data.orchestrationId).toBe('orch-real');
  });
});


describe('완료 «의도» — 「어디까지 가려 했나」 (원장 · R6 축)', () => {
  // 🚨 이 칸이 없으면 원장의 (completed, pr-opened) 70건을 «정상/미완»으로 못 가른다.
  //   ⛔ 「merged 만 성공」으로 세면 그 70건이 거짓 실패가 되고,
  //     「끝났으면 성공」으로 세면 review-blocked 가 거짓 성공이 된다(🅢 가 잡은 병).
  //   ⇒ 성공 판정은 ***intent × stage*** 로 나온다.
  test('autoMerge 를 «명시»한 런은 auto-merge 의도다', () => {
    expect(completionIntentOf({ autoMerge: true })).toBe('auto-merge');
  });

  test('completion 네 값을 그대로 보존하며 legacy autoMerge 입력을 계속 해석한다', () => {
    for (const completion of ['worktree-only', 'pr', 'auto-merge', 'unmanned'] as const) {
      expect(completionIntentOf({ completion })).toBe(completion);
    }
    expect(completionIntentOf({})).toBe('not-auto-merge');
    expect(completionIntentOf({ autoMerge: false })).toBe('not-auto-merge');
  });

  test('completion=auto-merge는 legacy autoMerge=true와 같이 자동 병합한다', async () => {
    const result = await runSelfImplement({
      feature: 'completion auto-merge compatibility',
      completion: 'auto-merge',
      seams: seams({
        reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'review', reviewed: true, diffTruncated: false }),
        mergePr: async () => ({ merged: true }),
      }),
    });
    expect(result).toMatchObject({ stage: 'merged', merged: true });
  });

  test('명시 completion=pr은 충돌하는 legacy autoMerge를 이겨 원장과 병합 실행을 일치시킨다', async () => {
    const records: GoalExecutionRecord[] = [];
    const goalFile = join(isolatedStateDir, 'GOAL-completion-pr-overrides-legacy-auto-merge.txt');
    writeFileSync(goalFile, '# completion intent ledger probe\n');
    let mergeCalls = 0;
    const result = await runSelfImplement({
      feature: 'explicit PR completion overrides legacy auto-merge',
      completion: 'pr',
      autoMerge: true,
      goalFile,
      writeGoalExecutionRecord: (_path, record) => { records.push(record); },
      seams: seams({
        reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'review', reviewed: true, diffTruncated: false }),
        mergePr: async () => { mergeCalls += 1; return { merged: true }; },
      }),
    });

    expect(records).toEqual([expect.objectContaining({ completionIntent: 'pr' })]);
    expect(mergeCalls).toBe(0);
    expect(result).toMatchObject({ stage: 'pr-opened', mergeReason: 'no-auto-flag' });
    expect('merged' in result).toBe(false);
  });

  test('원장 record 에 완료 의도가 굳는다 — 배선 회귀', async () => {
    const records: GoalExecutionRecord[] = [];
    await runSelfImplement({
      feature: 'completion intent ledger probe',
      runId: 'run-ledger-intent',
      goalFile: 'docs/goals/GOAL-ledger-intent-probe.txt',
      autoMerge: true,
      writeGoalExecutionRecord: (_path, record) => { records.push(record); },
      seams: seams({ gateResults: [true] }),
    });
    expect(records[0]).toMatchObject({ runId: 'run-ledger-intent', completionIntent: 'auto-merge' });
  });
});


describe('원장에 「달성 근사값」이 굳는다 (JDG-T60)', () => {
  // 🚨 원장 18칸에 「달성」을 재는 칸이 «하나도» 없었다 — goalContentHash·goalType 은 골의 «정체»다.
  //   ⇒ 「조각별로 다 통과했는데 연합 목표는 미달」을 ***원리상 셀 수 없었다***(🅢 실증 2026-08-19).
  //   ⛔ 이 값은 «근사값»이다 — 요구 증거는 「골이 선언한 것」이고 미션 목표와 같다는 보장이 없다.
  test('요구 증거를 측정하지 «못한» 런에는 칸을 만들지 않는다 — 0 으로 채우지 않는다', async () => {
    const records: GoalExecutionRecord[] = [];
    await runSelfImplement({
      feature: 'no required evidence probe',
      runId: 'run-evidence-absent',
      goalFile: 'docs/goals/GOAL-evidence-absent-probe.txt',
      writeGoalExecutionRecord: (_path, record) => { records.push(record); },
      seams: seams({ gateResults: [true] }),
    });
    expect(records[0]).toMatchObject({ runId: 'run-evidence-absent' });
    expect('requiredEvidence' in records[0]!).toBe(false);
    expect('coveredEvidence' in records[0]!).toBe(false);
  });
});

describe('blocked draft PR open failure body preservation', () => {
  test('defaultSeams without arguments exposes the production PR-body artifact seam', () => {
    expect(typeof defaultSeams().persistPrBodyArtifact).toBe('function');
  });

  test('persists the assembled review verdict and must-fix body when opening the blocked draft PR fails', async () => {
    const persisted: Array<{ origin: string; body: string; originalChars: number }> = [];
    const progress: string[] = [];
    const s = seams({ gateResults: [false] });
    s.implement = async () => ({ ok: true, summary: 'review verdict: fail\nmust-fix: preserve this must-fix' });
    s.openPr = async () => { throw new Error('remote unavailable'); };
    s.persistPrBodyArtifact = (input) => {
      persisted.push(input);
      return { path: '/tmp/blocked-draft-pr-body.md' };
    };
    s.onProgress = ({ stage, message }) => { if (stage === 'aborted') progress.push(message); };

    const result = await runSelfImplement({ feature: 'persist blocked verdict', maxReworkRounds: 0, seams: s });

    expect(result).toMatchObject({ ok: false, stage: 'gate-failed', outcome: 'budget-exhausted' });
    expect(persisted).toEqual([expect.objectContaining({
      origin: 'self-implement-blocked-draft-pr-open-failed',
      originalChars: expect.any(Number),
    })]);
    expect(persisted[0]!.body).toContain('gate failed');
    expect(persisted[0]!.body).toContain('preserve this must-fix');
    expect(progress).toEqual([expect.stringContaining('판정 본문 보존: /tmp/blocked-draft-pr-body.md')]);
  });

  test('reports persistence failure while retaining the blocked-draft aborted flow', async () => {
    const progress: string[] = [];
    const s = seams({ gateResults: [false] });
    s.openPr = async () => { throw new Error('remote unavailable'); };
    s.persistPrBodyArtifact = () => { throw new Error('artifact unavailable'); };
    s.onProgress = ({ stage, message }) => { if (stage === 'aborted') progress.push(message); };

    const result = await runSelfImplement({ feature: 'failed blocked persistence', maxReworkRounds: 0, seams: s });

    expect(result).toMatchObject({ ok: false, stage: 'gate-failed', outcome: 'budget-exhausted' });
    expect(progress).toEqual([expect.stringContaining('판정 본문 보존 실패: artifact unavailable')]);
    expect(progress.join('\n')).not.toContain('판정 본문 보존:');
  });

  test('does not persist the body when the blocked draft PR opens successfully', async () => {
    let persisted = 0;
    const s = seams({ gateResults: [false] });
    s.persistPrBodyArtifact = () => { persisted++; return { path: '/tmp/unexpected.md' }; };

    const result = await runSelfImplement({ feature: 'successful blocked draft', maxReworkRounds: 0, seams: s });

    expect(result).toMatchObject({ ok: false, stage: 'gate-failed', prNumber: 7 });
    expect(persisted).toBe(0);
  });
});

describe('successful-run PR open failure reports preserved worktree·branch', () => {
  const remoteUnavailable = "self-implement PR push 실패: fatal: 'origin' does not appear to be a git repository";

  test('review-passed run reports branch and worktree with interrupted-path vocabulary, keeps the raw error, and does not succeed', async () => {
    const progress: string[] = [];
    const branch = 'self-impl/reviewed-pr-open-fail';
    const worktreePath = '/wt/self-impl/reviewed-pr-open-fail';
    const outcome = await runSelfImplementCliCommand('reviewed PR open failure', { openPr: true }, {
      resolveWantAutoReview: () => false,
      pipelineDeps: {
        runGit: () => ({ status: 0, stdout: 'origin\n', stderr: '' }),
        runSelfImplement: (options) => runSelfImplement({
          ...options,
          seams: seams({
            gateResults: [true],
            createWorktree: async () => ({ path: worktreePath, branch, resolvedBase: 'a'.repeat(40), invokedHead: 'a'.repeat(40) }),
            reviewDiff: async () => ({
              verdict: 'warn',
              mustFix: [],
              shouldFix: ['후속 1', '후속 2', '후속 3', '후속 4', '후속 5', '후속 6'],
              summary: 'review',
              reviewed: true,
              diffTruncated: false,
              diffShownChars: 100,
              diffTotalChars: 100,
              diffOmittedFiles: 0,
            }),
            openPr: async () => { throw new Error(remoteUnavailable); },
            onProgress: ({ message }) => { progress.push(message); },
          }),
        }),
      },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected CLI failure outcome');
    expect(outcome.exitCode).toBe(1);
    const visible = `${progress.join('\n')}\n${outcome.message}`;
    expect(visible).toContain('worktree·branch 보존');
    expect(visible).toContain(branch);
    expect(visible).toContain(worktreePath);
    expect(visible).toContain('draft PR 생성 실패');
    expect(outcome.message).toContain(remoteUnavailable);
    expect(outcome.message.indexOf('worktree·branch 보존')).toBeLessThan(outcome.message.indexOf(remoteUnavailable));
  });

  test('openPr HTTP 422 failure is on the pr-open-failed observation and the aborted progress line', async () => {
    const ghError = 'gh: HTTP 422 Validation Failed';
    const branch = 'self-impl/http-422-pr-open-fail';
    const worktreePath = '/wt/self-impl/http-422-pr-open-fail';
    const progress: Array<{ stage: string; message: string }> = [];
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    let caught: unknown;
    try {
      await runSelfImplement({
        feature: 'openPr HTTP 422 surfaces the gh error',
        seams: seams({
          gateResults: [true],
          createWorktree: async () => ({ path: worktreePath, branch, resolvedBase: 'a'.repeat(40), invokedHead: 'a'.repeat(40) }),
          reviewDiff: async () => ({
            verdict: 'warn' as const,
            mustFix: [],
            shouldFix: ['후속 1'],
            summary: 'review',
            reviewed: true,
            diffTruncated: false,
            diffShownChars: 100,
            diffTotalChars: 100,
            diffOmittedFiles: 0,
          }),
          openPr: async () => { throw new Error(ghError); },
          writeRunLedger: (entry) => { events.push({ event: entry.event, data: entry.data }); },
          onProgress: (event) => { progress.push(event); },
        }),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(ghError);
    const observed = events.filter((entry) => entry.event === 'pr-open-failed');
    expect(observed).toHaveLength(1);
    expect(observed[0]!.data).toMatchObject({
      branch,
      worktreePath,
      error: ghError,
    });
    const aborted = progress.filter((event) => event.stage === 'aborted').map((event) => event.message);
    expect(aborted.some((message) => message.includes('HTTP 422'))).toBe(true);
    expect(aborted.some((message) => message.includes('draft PR 생성 실패') && !message.includes('HTTP 422'))).toBe(false);
  });
  test('a long worktree path does not push HTTP 422 off the 500-char aborted progress line', async () => {
    const ghError = 'gh: HTTP 422 Validation Failed';
    const branch = `self-impl/${'branch-segment-'.repeat(40)}http-422`;
    const worktreePath = `/wt/${'very-long-worktree-directory-name-'.repeat(40)}http-422`;
    expect(branch.length + worktreePath.length).toBeGreaterThan(500);
    const progress: Array<{ stage: string; message: string }> = [];
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    let caught: unknown;
    try {
      await runSelfImplement({
        feature: 'openPr HTTP 422 survives a long preserved path',
        seams: seams({
          gateResults: [true],
          createWorktree: async () => ({ path: worktreePath, branch, resolvedBase: 'a'.repeat(40), invokedHead: 'a'.repeat(40) }),
          reviewDiff: async () => ({
            verdict: 'warn' as const,
            mustFix: [],
            shouldFix: ['후속 1'],
            summary: 'review',
            reviewed: true,
            diffTruncated: false,
            diffShownChars: 100,
            diffTotalChars: 100,
            diffOmittedFiles: 0,
          }),
          openPr: async () => { throw new Error(ghError); },
          writeRunLedger: (entry) => { events.push({ event: entry.event, data: entry.data }); },
          onProgress: (event) => { progress.push(event); },
        }),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(ghError);
    const observed = events.filter((entry) => entry.event === 'pr-open-failed');
    expect(observed).toHaveLength(1);
    expect(observed[0]!.data).toMatchObject({
      branch,
      worktreePath,
      error: ghError,
    });
    const aborted = progress.filter((event) => event.stage === 'aborted').map((event) => event.message);
    expect(aborted).toHaveLength(1);
    expect(aborted[0]!.length).toBeLessThanOrEqual(500);
    expect(aborted[0]).toContain('HTTP 422');
    expect(aborted[0]).toContain(ghError);
  });

  test('successful PR-open run still returns pr-opened with exit-success shape', async () => {
    const progress: Array<{ stage: string; message: string }> = [];
    const result = await runSelfImplement({
      feature: 'successful PR open regression',
      seams: seams({
        gateResults: [true],
        reviewDiff: async () => ({
          verdict: 'warn',
          mustFix: [],
          shouldFix: ['후속 정리'],
          summary: 'review',
          reviewed: true,
          diffTruncated: false,
          diffShownChars: 100,
          diffTotalChars: 100,
          diffOmittedFiles: 0,
        }),
        onProgress: (event) => { progress.push(event); },
      }),
    });
    expect(result).toMatchObject({ ok: true, stage: 'pr-opened', outcome: 'completed', prNumber: 7 });
    expect(progress.map(({ stage }) => stage)).toContain('pr-opening');
    expect(progress.map(({ stage }) => stage)).toContain('pr-opened');
    expect(progress.some(({ message }) => message.includes('PR 생성…'))).toBe(true);
    expect(progress.some(({ message }) => message.includes('worktree·branch 보존'))).toBe(false);
  });
});

function goalDocumentWithDeclaredTargets(targets: string): string {
  return [
    '## PROBLEM',
    'Situation: GROUNDED — declared-scope-diff fixture.',
    '',
    'Original ask (verbatim, unmodified):',
    '```',
    `대상 경로: ${targets}`,
    '고친다.',
    '```',
    '',
    '## ACCEPTANCE CRITERIA',
    '- keep the verbatim ask.',
  ].join('\n');
}

describe('collectRunFacts — 성공한 빈 변경 목록을 보존한다', () => {
  test('변경 목록을 읽어 빈 배열이면 changedFiles 키와 빈 배열을 함께 반환한다', () => {
    const root = mkdtempSync(join(tmpdir(), 'collect-run-facts-empty-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: root });
      expect(collectRunFacts(root)).toMatchObject({ changedFiles: [] });
      expect('changedFiles' in collectRunFacts(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('declaredScopeUnmadeLine — ***「하나도 안 만들었나」만 말한다***', () => {
  // ⛔⭐⭐ 🩸 2026-09-12 — A/B 네 판이 `docs/`·`TASK.md` 만 둔 채 ***「구현 완료 · gate 통과」***로 찍혔다.
  //    골은 `index.html`·`style.css` 를 «선언»했는데 ***그것을 보는 자가 «없었다»***.
  //    ⛔ 그런데 ***`unmadeCount > 0` 은 «결함이 아니다»*** — 골의 「대상 경로」는 이미 있는 파일을 자주 대고,
  //       한 조각이 그중 하나만 건드리는 것은 «정상»이다([T] 2026-09-12).
  //    ⇒ 🔑 찾는 신호는 ***`unmade === declared`***(하나도 안 채웠다)뿐이다.
  const diff = (goal: string, changed: readonly string[]) =>
    detectDeclaredScopeDiff({ goalDocument: goalDocumentWithDeclaredTargets(goal), changedFiles: changed });

  test('🩸 하나도 안 채우면 «이름을 대고» 말한다', () => {
    const line = declaredScopeUnmadeLine(diff('index.html · style.css', ['docs/note.md', 'TASK.md']));
    expect(line).toContain('2개');
    expect(line).toContain('index.html');
    expect(line).toContain('style.css');
  });

  test('⛔ 셋 중 «하나»만 채운 런은 «조용하다» — 부분 달성은 정상이다', () => {
    const d = diff('a.ts · b.ts · c.ts', ['a.ts']);
    expect(d.unmadeCount).toBe(2);          // 관측은 «남는다»
    expect(d.declaredCount).toBe(3);
    expect(declaredScopeUnmadeLine(d)).toBeNull();   // ⛔ 사람 줄은 «안 나온다»
  });

  test('⛔ 전부 채우면 조용하다', () => {
    expect(declaredScopeUnmadeLine(diff('a.ts · b.ts', ['a.ts', 'b.ts']))).toBeNull();
  });

  test('⛔ 「못 쟀다」(unknown)면 조용하다 — 지어내지 않는다', () => {
    expect(declaredScopeUnmadeLine(detectDeclaredScopeDiff({ goalDocument: null, changedFiles: ['x.ts'] }))).toBeNull();
  });

  test('⛔ 선언이 «0개»면 조용하다 — 0 으로 나누지 않는다', () => {
    const d = detectDeclaredScopeDiff({ goalDocument: goalDocumentWithDeclaredTargets(''), changedFiles: ['x.ts'] });
    expect(declaredScopeUnmadeLine(d)).toBeNull();
  });
});

describe('detectDeclaredScopeDiff — 선언한 대상 밖 변경', () => {
  test('대상 밖 파일이 바뀌면 수와 이름을 남긴다', () => {
    const diff = detectDeclaredScopeDiff({
      goalDocument: goalDocumentWithDeclaredTargets('src/in.ts · src/also.ts'),
      changedFiles: ['src/in.ts', 'src/outside.ts', 'docs/other.md'],
    });
    expect(diff).toEqual({
      status: 'known',
      outsideCount: 2,
      outsideNames: ['src/outside.ts', 'docs/other.md'],
      // ⭐ 선언 둘 중 `src/in.ts` 만 채웠다 ⇒ unmade 는 «1». ⛔ 이것은 «결함이 아니다»([T] 2026-09-12).
      unmadeCount: 1, unmadeNames: ['src/also.ts'], declaredCount: 2,
      nameCapReached: false,
    });
  });

  test('대상 안에서만 바뀌면 수는 0 이다', () => {
    const diff = detectDeclaredScopeDiff({
      goalDocument: goalDocumentWithDeclaredTargets('src/self-implement'),
      changedFiles: ['src/self-implement/orchestrator.ts', 'src/self-implement/orchestrator.test.ts'],
    });
    expect(diff.status).toBe('known');
    expect(diff.outsideCount).toBe(0);
    expect(diff.outsideNames).toEqual([]);
    expect(diff.nameCapReached).toBe(false);
  });

  test('변경 목록을 못 얻으면 unknown-changed-files 이고 수를 만들지 않는다', () => {
    const diff = detectDeclaredScopeDiff({
      goalDocument: goalDocumentWithDeclaredTargets('src/in.ts · src/also.ts'),
      changedFiles: undefined,
    });
    expect(diff).toEqual({
      status: 'unknown-changed-files',
      outsideCount: null,
      outsideNames: [],
      nameCapReached: false,
      unmadeCount: null,
      unmadeNames: [],
      declaredCount: null,
    });
    expect(declaredScopeUnmadeLine(diff)).toBeNull();
  });

  test('변경 목록을 읽어 빈 배열이면 known 이고 선언 대상을 전부 안 만든 것으로 센다', () => {
    const diff = detectDeclaredScopeDiff({
      goalDocument: goalDocumentWithDeclaredTargets('src/in.ts · src/also.ts'),
      changedFiles: [],
    });
    expect(diff.status).toBe('known');
    expect(diff.unmadeCount).toBe(diff.declaredCount);
    expect(declaredScopeUnmadeLine(diff)).toContain('하나도');
  });

  test('선언을 못 읽으면 0 이 아니라 unknown 이다', () => {
    expect(detectDeclaredScopeDiff({
      goalDocument: '## PROBLEM\n본문만 있고 ask 블록이 없다.',
      changedFiles: ['src/outside.ts'],
    })).toEqual({
      status: 'unknown',
      outsideCount: null,
      outsideNames: [],
      nameCapReached: false,
      unmadeCount: null, unmadeNames: [], declaredCount: null,
    });
    expect(detectDeclaredScopeDiff({
      goalDocument: null,
      changedFiles: ['src/outside.ts'],
    }).status).toBe('unknown');
    expect(detectDeclaredScopeDiff({
      changedFiles: ['src/outside.ts'],
    }).outsideCount).toBeNull();
  });

  test('상한보다 많이 바뀌면 상한만큼의 이름과 상한 도달 사실이 남는다', () => {
    const outside = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts', 'h.ts'];
    const diff = detectDeclaredScopeDiff({
      goalDocument: goalDocumentWithDeclaredTargets('src/in.ts'),
      changedFiles: ['src/in.ts', ...outside],
      nameCap: DECLARED_SCOPE_OUTSIDE_NAME_CAP,
    });
    expect(diff.status).toBe('known');
    expect(diff.outsideCount).toBe(8);
    expect(diff.outsideNames).toEqual(outside.slice(0, DECLARED_SCOPE_OUTSIDE_NAME_CAP));
    expect(diff.nameCapReached).toBe(true);
  });
});

describe('declared-scope-diff 관측 착지 — 완주·중단 판정은 그대로, 산출에 값이 실린다', () => {
  test('이 착지 이전과 같은 입력의 완주 런은 pr-opened/completed 이고 관측에 대상 밖 변경이 실린다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scope-diff-complete-'));
    const repo = join(root, 'repo');
    const goalFile = join(root, 'GOAL-scope-diff.txt');
    mkdirSync(repo);
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
      spawnSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
      spawnSync('git', ['config', 'user.name', 't'], { cwd: repo });
      mkdirSync(join(repo, 'src'), { recursive: true });
      writeFileSync(join(repo, 'src', 'in.ts'), 'export const inScope = true;\n');
      spawnSync('git', ['add', '-A'], { cwd: repo });
      spawnSync('git', ['commit', '-qm', 'seed'], { cwd: repo });
      spawnSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: repo });
      writeFileSync(goalFile, goalDocumentWithDeclaredTargets('src/in.ts'), 'utf8');

      const result = await runSelfImplement({
        feature: 'declared scope complete regression',
        goalFile,
        seams: seams({
          implement: async ({ cwd }) => {
            writeFileSync(join(cwd, 'src', 'in.ts'), 'export const inScope = true;\nexport const touched = true;\n');
            writeFileSync(join(cwd, 'src', 'outside.ts'), 'export const leaked = true;\n');
            return { ok: true, summary: 'impl' };
          },
          createWorktree: async () => ({ path: repo, branch: 'se/scope-diff-complete', resolvedBase: 'a'.repeat(40), invokedHead: 'a'.repeat(40) }),
          commitWork: (cwd, message) => { spawnSync('git', ['add', '-A'], { cwd }); spawnSync('git', ['commit', '-qm', message], { cwd }); },
          mergeMain: async () => ({ status: 'up-to-date' }),
          reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'pass', reviewed: true }),
        }),
      });

      expect(result).toMatchObject({ ok: true, stage: 'pr-opened', outcome: 'completed' });
      const scope = events.find((entry) => entry.event === 'declared-scope-diff');
      expect(scope?.data).toMatchObject({
        declaredScopeDiffStatus: 'known',
        declaredScopeOutsideCount: 1,
        declaredScopeOutsideNames: ['src/outside.ts'],
        declaredScopeOutsideNameCapReached: false,
      });
      expect(events.some((entry) => entry.event === 'boundary-violated')).toBe(false);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test('이 착지 이전과 같은 입력의 중단 런은 판정이 같고, 선언을 못 읽으면 unknown 이 실린다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const result = await runSelfImplement({
        feature: 'declared scope abort regression',
        seams: seams({
          implement: async () => ({ ok: false, summary: 'child stopped' }),
        }),
      });
      expect(result.ok).toBe(false);
      expect(result.outcome).toBe('abandoned');
      const scope = events.find((entry) => entry.event === 'declared-scope-diff');
      expect(scope?.data).toMatchObject({
        declaredScopeDiffStatus: 'unknown',
        declaredScopeOutsideCount: null,
        declaredScopeOutsideNames: [],
        declaredScopeOutsideNameCapReached: false,
      });
      const status = events.find((entry) => entry.event === 'run-status');
      expect(status?.data).toMatchObject({ stage: result.stage, runStatus: 'failed' });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('하나도 안 만든 사람 줄은 그대로 두고, 그 옆에서 경계 글로브에 닿은 파일을 말한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scope-diff-boundary-'));
    const repo = join(root, 'repo');
    const goalFile = join(root, 'GOAL-boundary.txt');
    mkdirSync(repo);
    const progress: Array<{ stage: string; message: string }> = [];
    try {
      spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
      spawnSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
      spawnSync('git', ['config', 'user.name', 't'], { cwd: repo });
      mkdirSync(join(repo, 'src', 'nexus'), { recursive: true });
      writeFileSync(join(repo, 'src', 'kept.ts'), 'export const kept = true;\n');
      spawnSync('git', ['add', '-A'], { cwd: repo });
      spawnSync('git', ['commit', '-qm', 'seed'], { cwd: repo });
      spawnSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: repo });
      writeFileSync(goalFile, [
        goalDocumentWithDeclaredTargets('src/kept.ts · src/also.ts'),
        '',
        '경계: `src/nexus/**` 는 이 골이 아니다.',
      ].join('\n'), 'utf8');

      const result = await runSelfImplement({
        feature: 'declared scope boundary beside unmade',
        goalFile,
        seams: seams({
          implement: async ({ cwd }) => {
            writeFileSync(join(cwd, 'src', 'nexus', 'gateway.ts'), 'export const leaked = true;\n');
            writeFileSync(join(cwd, 'note.md'), 'outside and not a boundary\n');
            return { ok: true, summary: 'impl' };
          },
          createWorktree: async () => ({ path: repo, branch: 'se/scope-diff-boundary', resolvedBase: 'a'.repeat(40), invokedHead: 'a'.repeat(40) }),
          commitWork: (cwd, message) => { spawnSync('git', ['add', '-A'], { cwd }); spawnSync('git', ['commit', '-qm', message], { cwd }); },
          mergeMain: async () => ({ status: 'up-to-date' }),
          reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'pass', reviewed: true }),
          onProgress: (event) => { progress.push(event); },
        }),
      });

      expect(result).toMatchObject({ ok: true, stage: 'pr-opened', outcome: 'completed' });
      const unmade = progress.find((entry) => entry.stage === 'declared-targets-unmade');
      expect(unmade?.message).toContain('하나도');
      expect(unmade?.message).toContain('src/kept.ts');
      const violated = progress.find((entry) => entry.stage === 'boundary-violated');
      expect(violated?.message).toContain('src/nexus/gateway.ts');
      expect(violated?.message).not.toContain('note.md');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('runSelfImplement — 예산 판정기는 must-fix 문장을 받는다', () => {
  test('세 must-fix 문장의 앞 40자가 판정 이음매 입력에 각각 들어 있다', async () => {
    const sentence = (title: string): string => {
      const body = `${title}: 이 지적은 완결된 문장으로 결함의 제목과 요지를 함께 설명한다. `;
      return body.repeat(Math.ceil(400 / body.length)).slice(0, 400);
    };
    const findings = [sentence('첫째 제목 문서분류'), sentence('둘째 제목 부정형통과'), sentence('셋째 제목 임시디렉터리')];
    expect(findings.map((finding) => finding.length)).toEqual([400, 400, 400]);
    const seen: Array<{ note: string; history: readonly string[]; purpose?: string }> = [];
    const s = revSeams({
      reviews: [
        { verdict: 'fail', mustFix: findings },
        { verdict: 'pass', reviewed: true },
      ],
    });
    s.diagnose = async (input) => {
      seen.push({ note: input.note, history: input.history, purpose: input.purpose });
      return 'BUDGET: SUFFICIENT\nREASON: 문장을 읽고 비블로커로 본다';
    };
    await runSelfImplement({ feature: 'must-fix sentences reach the budget judge', maxReworkRounds: 2, seams: s });
    const budget = seen.find((input) => input.purpose === undefined || input.purpose === 'budget');
    expect(budget).toBeDefined();
    for (const finding of findings) {
      expect(budget!.note).toContain(finding.slice(0, 40));
    }
    expect(budget!.note).not.toMatch(/^`?[A-Za-z]+`?(\s·\s|$)/);
  });
});

describe('runSelfImplement — harness fork seam wiring', () => {
  test('parentSessionId 가 있으면 start observation에 기록하고 forkSession seam 을 호출한다', async () => {
    const forked: string[] = [];
    const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
    await runSelfImplement({
      feature: 'harness origin wiring',
      parentSessionId: 'parent-session',
      seams: seams({
        forkSession: async (parentSessionId) => {
          forked.push(parentSessionId);
          return 'child-session';
        },
        writeRunLedger: (entry) => ledger.push({ event: entry.event, data: entry.data }),
      }),
    });
    expect(forked).toEqual(['parent-session']);
    expect(ledger.find((entry) => entry.event === 'start')?.data).toMatchObject({
      parentSessionId: 'parent-session',
      willFork: true,
    });
  });
});
