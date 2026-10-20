import { describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { landOrderLedgerPath } from './land-order-ledger.js';
import { classifyLandFailure, landRetryPending, liveLandArgs, type TaskAgentLiveMove } from './live-moves.js';
import { CATCH_UP_CAP, defaultCatchUpMain, defaultRequestRegate, overlapEvidencePath, parseRegateResult, REJUDGE_HEAD_CAP, regateResultPath, regateRunArgs, rejudgeCandidates, rejudgeCardOnHead, rejudgeAsyncResultCard, rejudgeCompletedTaskRegate, rejudgeShadowCard, regateUnmeasured, remoteBoundRunTerminal, type CatchUpGit, type CatchUpRequest, type CatchUpResult, type RegateRequest } from './rejudge-on-head.js';
import { captureReviewResults, rejudgeCompletedTaskReview, reviewResultPath, TA_REVIEW_COMPLETION_CARD_ENV, TA_REVIEW_COMPLETION_RESULT_ENV, TA_REVIEW_COMPLETION_STATE_ENV } from './review-result-capture.js';
import { readTaskCard, writeTaskCards, type TaskCard } from './task-hand.js';
import { setUserConfigOverlay } from '../user-config.js';
import { debug } from '../debug/log.js';
import { repairReviewDigest } from './repair-review.js';
import { listGraphRuns } from '../graph-runner/runner.js';
import type { RepairLaunchRequest } from './repair-cycle.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const D = 'd'.repeat(40);
const E = 'e'.repeat(40);
const F = 'f'.repeat(40);
const URL = 'https://github.com/o/r/pull/30';
const reviewJson = (head: string, over: Record<string, unknown> = {}) => JSON.stringify({ pr: '30', verdict: 'pass', mustFix: [], shouldFix: [], reviewed: true, reviewRoute: 'api', headCommit: head, ...over });

function fixture(opts: { regates?: TaskCard['regates']; landAttempts?: TaskCard['landAttempts'] } = {}) {
  const statePath = join(mkdtempSync(join(tmpdir(), 'ta-rejudge-')), 'task-agent-actions.json');
  const pathA = reviewResultPath(statePath, 'ta-rj-1', 30, A);
  // 런 멈춤 때: 머리 A 리뷰 요청 ⊕ 회수(fail · must-fix 2) — #26030 실측 꼴.
  const seed: TaskCard = {
    id: 'ta-rj-1', text: 'feature ask', seat: 'TC', checklistId: 'CELL-RJ', createdAt: '2026-10-11T00:00:00.000Z', status: 'launched', runId: 'run-rj',
    pr: { number: 30, url: URL },
    reviewRequests: [{ pr: 30, head: A, at: '2026-10-11T00:10:00.000Z', resultPath: pathA }],
    history: [{ at: '2026-10-11T00:20:00.000Z', event: 'live-move-result', kind: 'review', pr: 30, head: A, verdict: 'fail', reviewed: true, mustFix: 2, reviewRoute: 'api', resultPath: pathA, effect: 'review result captured · verdict fail · reviewed true · must-fix 2' }],
    ...(opts.regates ? { regates: opts.regates } : {}),
    ...(opts.landAttempts ? { landAttempts: opts.landAttempts } : {}),
  };
  writeTaskCards(statePath, [seed]);
  let head = A;
  let clock = new Date('2026-10-11T01:00:00.000Z');
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  const regateRequests: RegateRequest[] = [];
  const reviewRequests: Array<{ pr: number; resultPath?: string }> = [];
  const lands: Array<{ pr: number; head: string; overlapEvidence?: string }> = [];
  const catchUpRequests: CatchUpRequest[] = [];
  let regateOutcome: ((request: RegateRequest) => void) | undefined;
  let reviewOutcome: ((path: string) => void) | undefined;
  let catchUpOutcome: ((request: CatchUpRequest) => CatchUpResult | Promise<CatchUpResult>) | undefined;
  // TA-LAND-RETRY-ON-INFRA — land 결과 차례(비면 병합 성공).
  const landOutcomes: Array<{ status: number; stdout: string; stderr?: string }> = [];
  const deps = (moves: TaskAgentLiveMove[] = ['review', 'propose-land']) => ({
    liveMoves: new Set(moves),
    prFiles: async () => ['src/feature.ts'],
    log: (_c: string, event: string, data: Record<string, unknown>) => { logs.push({ event, data }); },
    requestRegate: async (request: RegateRequest) => { regateRequests.push(request); regateOutcome?.(request); },
    catchUpMain: async (request: CatchUpRequest) => {
      catchUpRequests.push(request);
      if (!catchUpOutcome) return { decision: 'failed' as const, reason: 'catchUpMain not stubbed', fromBase: request.fromBase };
      return await catchUpOutcome(request);
    },
    live: {
      statePath,
      now: () => clock,
      repoCandidates: () => [{ source: 'host' as const, cwd: '/repo' }],
      prHead: async () => ({ head, state: 'OPEN', url: URL, branch: 'feature' }),
      requestReview: async (pr: number, _intent: string, _cwd?: string, capture?: { resultPath: string }) => {
        reviewRequests.push({ pr, ...(capture ? { resultPath: capture.resultPath } : {}) });
        if (capture && reviewOutcome) { mkdirSync(dirname(capture.resultPath), { recursive: true }); reviewOutcome(capture.resultPath); }
      },
      landPrHead: async () => ({ head, state: 'OPEN', isDraft: false, url: URL, branch: 'feature' }),
      land: async (pr: number, landHead: string, _cwd: string, o?: { overlapEvidence?: string }) => {
        lands.push({ pr, head: landHead, ...(o?.overlapEvidence ? { overlapEvidence: o.overlapEvidence } : {}) });
        return landOutcomes.shift() ?? { status: 0, stdout: 'merged' };
      },
    },
  });
  const writeRegate = (passed: boolean, over: Record<string, unknown> = {}) => (request: RegateRequest) => {
    mkdirSync(dirname(request.resultPath), { recursive: true });
    writeFileSync(request.resultPath, JSON.stringify({ pr: request.pr, head: request.head, passed, status: passed ? 'passed' : 'failed', ...(passed ? { baseCommit: BASE } : {}), failures: passed ? [] : [{ step: 'typecheck', detail: 'error TS1' }], ...over }));
  };
  return {
    statePath, logs, regateRequests, reviewRequests, lands, catchUpRequests, deps, writeRegate,
    card: () => readTaskCard('ta-rj-1', statePath)!,
    setHead: (value: string) => { head = value; },
    setClock: (iso: string) => { clock = new Date(iso); },
    onRegate: (fn: typeof regateOutcome) => { regateOutcome = fn; },
    onReview: (fn: typeof reviewOutcome) => { reviewOutcome = fn; },
    onCatchUp: (fn: typeof catchUpOutcome) => { catchUpOutcome = fn; },
    queueLand: (...next: typeof landOutcomes) => { landOutcomes.push(...next); },
    decisions: () => logs.filter((entry) => entry.event === 'rejudge-on-head').map((entry) => `${entry.data.step}:${entry.data.decision}`),
  };
}

describe('TA-REJUDGE-ON-HEAD — 런 멈춤 뒤 머리가 바뀌면 재게이트·리뷰·land 를 다시 판단한다', () => {
  test('goal-only PR remains a measured target-diff-0 stop across rejudge ticks', async () => {
    const f = fixture();
    const queried: Array<[number, string]> = [];
    const guard = { ...f.deps(), prFiles: async (pr: number, url: string) => {
      queried.push([pr, url]);
      return ['docs/goals/GOAL-generated.md'];
    } };
    const first = await rejudgeCardOnHead('ta-rj-1', guard);
    const second = await rejudgeCardOnHead('ta-rj-1', guard);
    expect(first.at(-1)).toMatchObject({ decision: 'goal-only-pr', step: 'target' });
    expect(second.at(-1)).toMatchObject({ decision: 'goal-only-pr', step: 'target' });
    expect(f.regateRequests).toHaveLength(0);
    expect(f.reviewRequests).toHaveLength(0);
    expect(f.lands).toHaveLength(0);
    expect(queried).toEqual([[30, URL], [30, URL]]);
    expect(f.card().history.filter((row) => row.event === 'rejudge-on-head' && row.effect === 'goal-only-pr')).toHaveLength(1);
  });
  test('adopted unchanged head gets its first review request, then only one pending request', async () => {
    const f = fixture();
    writeTaskCards(f.statePath, [{ ...f.card(), taLand: true,
      adoptedPr: { pr: 30, url: URL, head: A, at: '2026-10-11T00:30:00.000Z' },
      reviewRequests: [], history: [] }]);
    await rejudgeCardOnHead(f.card().id, f.deps());
    expect(f.decisions()).toContain('review:review-requested');
    expect(f.reviewRequests).toHaveLength(1);
    await rejudgeCardOnHead(f.card().id, f.deps());
    expect(f.decisions()).toContain('review:review-pending');
    expect(f.reviewRequests).toHaveLength(1);
    expect(f.regateRequests).toHaveLength(0);
  });

  test('adopted unchanged head routes captured failure to repair and captured pass to regate', async () => {
    const failed = fixture();
    writeTaskCards(failed.statePath, [{ ...failed.card(), taLand: true,
      adoptedPr: { pr: 30, url: URL, head: A, at: '2026-10-11T00:30:00.000Z' } }]);
    await rejudgeCardOnHead(failed.card().id, failed.deps());
    expect(failed.decisions()).toEqual(['review:repair-needed']);
    expect(failed.regateRequests).toHaveLength(0);
    expect(failed.reviewRequests).toHaveLength(0);

    const passed = fixture();
    writeTaskCards(passed.statePath, [{ ...passed.card(), taLand: true,
      adoptedPr: { pr: 30, url: URL, head: A, at: '2026-10-11T00:30:00.000Z' },
      history: [{ at: '2026-10-11T00:20:00.000Z', event: 'live-move-result', kind: 'review', pr: 30,
        head: A, verdict: 'pass', reviewed: true, mustFix: 0, effect: 'review result captured · verdict pass · reviewed true · must-fix 0' }] }]);
    await rejudgeCardOnHead(passed.card().id, passed.deps());
    expect(passed.decisions()).toContain('regate:regate-requested');
    expect(passed.regateRequests).toHaveLength(1);
    expect(passed.reviewRequests).toHaveLength(0);
  });

  test('configured queue path takes exact-head captured review to one queue request without host regate or direct land', async () => {
    const f = fixture();
    const resultPath = f.card().reviewRequests![0]!.resultPath!;
    mkdirSync(dirname(resultPath), { recursive: true });
    writeFileSync(resultPath, reviewJson(A));
    writeTaskCards(f.statePath, [{ ...f.card(), taLand: true, history: [{ at: '2026-10-11T00:20:00.000Z', event: 'live-move-result',
      kind: 'review', pr: 30, head: A, verdict: 'pass', reviewed: true, mustFix: 0, resultPath,
      effect: 'review result captured · verdict pass · reviewed true · must-fix 0' }] }]);
    const queue: Array<{ pr: number; head: string; reviewResult: string }> = [];
    const base = f.deps();
    const deps = { ...base, live: { ...base.live,
      landQueueConfig: { command: '/ops/land-enqueue.sh', remote: 'node-c' },
      landWorktree: { localHead: () => A, localBranch: () => 'feature' },
      queueLanding: async (request: { pr: number; head: string; reviewResult: string }) => {
        queue.push(request); return { status: 0, stdout: 'OK #30 queued' };
      },
    } };
    expect((await rejudgeCardOnHead(f.card().id, { ...deps, landBudget: { max: 0, requested: 0 } })).at(-1))
      .toMatchObject({ step: 'land', decision: 'tick-cap' });
    expect(queue).toHaveLength(0);
    expect(f.card().landAttempts ?? []).toHaveLength(0);
    const sharedLandBudget = { max: 1, requested: 0 };
    expect((await rejudgeCardOnHead(f.card().id, { ...deps, landBudget: sharedLandBudget })).at(-1))
      .toMatchObject({ step: 'land', decision: 'queued' });
    expect(sharedLandBudget.requested).toBe(1);
    expect(queue).toEqual([expect.objectContaining({ pr: 30, head: A, reviewResult: resultPath })]);
    expect(f.card().landAttempts).toEqual([expect.objectContaining({ pr: 30, head: A, ok: true })]);
    expect(f.regateRequests).toHaveLength(0);
    expect(f.lands).toHaveLength(0);
    expect((await rejudgeCardOnHead(f.card().id, deps)).at(-1)).toMatchObject({ step: 'land', decision: 'queue-skipped' });
    expect(queue).toHaveLength(1);
    const direct = fixture();
    const directHead = '1'.repeat(40);
    direct.setHead(directHead);
    direct.onRegate(direct.writeRegate(true));
    direct.onReview((path) => writeFileSync(path, reviewJson(directHead)));
    await rejudgeCardOnHead(direct.card().id, direct.deps());
    direct.setClock('2026-10-11T01:10:00.000Z');
    expect((await rejudgeCardOnHead(direct.card().id, { ...direct.deps(), landBudget: sharedLandBudget })).at(-1))
      .toMatchObject({ step: 'land', decision: 'tick-cap' });
    expect(direct.lands).toHaveLength(0);
  });

  test('captured exact-head must-fix enters next-move and launches one same-PR repair worker', async () => {
    const f = fixture();
    const resultPath = f.card().reviewRequests![0]!.resultPath!;
    mkdirSync(dirname(resultPath), { recursive: true });
    const text = reviewJson(A, { verdict: 'fail', mustFix: ['fix assertion one', 'fix assertion two'] });
    writeFileSync(resultPath, text);
    writeTaskCards(f.statePath, [{ ...f.card(), history: f.card().history.map((entry) => entry.resultPath === resultPath
      ? { ...entry, reviewSha256: repairReviewDigest(text) } : entry) }]);
    const launched: Array<{ pr: number; head: string; resultPath: string }> = [];
    const deps = { ...f.deps(['review', 'propose-land', 'narrow-relaunch']),
      requestRepair: async (request: { pr: number; head: string; resultPath: string }) => { launched.push(request); } };
    await rejudgeCardOnHead(f.card().id, deps);
    expect(f.decisions()).toContain('repair:repair-requested');
    expect(launched).toHaveLength(1);
    expect(launched[0]).toMatchObject({ pr: 30, head: A });
    expect(f.card().repairs?.[0]).toMatchObject({ pr: 30, head: A, move: 'narrow-relaunch', status: 'requested' });
    await rejudgeCardOnHead(f.card().id, deps);
    expect(launched).toHaveLength(1);
    expect(f.decisions()).toContain('repair:repair-pending');
  });

  test('repair reads the captured review file, rejects changed bytes, and ignores a later request for the same head', async () => {
    const f = fixture();
    const path = f.card().reviewRequests![0]!.resultPath!;
    const text = reviewJson(A, { verdict: 'fail', mustFix: ['captured fix one', 'captured fix two'] });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    const laterPath = `${path}.later`;
    // A later request exists, but its result has not been captured; it cannot substitute its path.
    writeTaskCards(f.statePath, [{ ...f.card(),
      reviewRequests: [...f.card().reviewRequests!, { pr: 30, head: A, at: '2026-10-11T00:30:00.000Z', resultPath: laterPath }],
      history: f.card().history.map((entry) => entry.resultPath === path ? { ...entry, reviewSha256: repairReviewDigest(text) } : entry) }]);
    const launched: RepairLaunchRequest[] = [];
    const deps = { ...f.deps(['review', 'propose-land', 'narrow-relaunch']), requestRepair: async (request: RepairLaunchRequest) => { launched.push(request); } };
    await rejudgeCardOnHead(f.card().id, deps);
    expect(launched).toHaveLength(1);
    expect(readFileSync(launched[0]!.goalFile, 'utf8')).toContain('captured fix one');
    expect(readFileSync(launched[0]!.goalFile, 'utf8')).not.toContain('wrong fix');
    const g = fixture();
    const p = g.card().reviewRequests![0]!.resultPath!;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
    writeTaskCards(g.statePath, [{ ...g.card(), history: g.card().history.map((entry) => entry.resultPath === p
      ? { ...entry, reviewSha256: repairReviewDigest(text) } : entry) }]);
    writeFileSync(p, reviewJson(A, { verdict: 'fail', mustFix: ['mutated'] }));
    await rejudgeCardOnHead(g.card().id, { ...g.deps(['review', 'propose-land', 'narrow-relaunch']), requestRepair: async () => { throw new Error('must not launch'); } });
    expect(g.decisions()).toContain('review:review-requested');
    expect(g.reviewRequests).toHaveLength(1);
  });

  test('legacy captured review without a digest requests one replacement review before repair', async () => {
    const f = fixture();
    const oldPath = f.card().reviewRequests![0]!.resultPath!;
    mkdirSync(dirname(oldPath), { recursive: true });
    writeFileSync(oldPath, reviewJson(A, { verdict: 'fail', mustFix: ['old bytes cannot be trusted'] }));
    f.onReview((path) => writeFileSync(path, reviewJson(A, { verdict: 'fail', mustFix: ['fresh exact-head fix'] })));
    const launched: RepairLaunchRequest[] = [];
    const deps = { ...f.deps(['review', 'narrow-relaunch']), requestRepair: async (request: RepairLaunchRequest) => { launched.push(request); } };
    await rejudgeCardOnHead(f.card().id, deps);
    expect(f.decisions()).toContain('review:review-requested');
    expect(f.reviewRequests).toHaveLength(1);
    expect(f.reviewRequests[0]!.resultPath).not.toBe(oldPath);
    await rejudgeCardOnHead(f.card().id, deps);
    expect(f.reviewRequests).toHaveLength(1);
    captureReviewResults(f.statePath);
    await rejudgeCardOnHead(f.card().id, deps);
    expect(launched).toHaveLength(1);
    expect(readFileSync(launched[0]!.goalFile, 'utf8')).toContain('fresh exact-head fix');
  });

  test('taLand reviewed draft becomes ready before its first host regate', async () => {
    const f = fixture();
    let draft = true;
    let readyCalls = 0;
    writeTaskCards(f.statePath, [{ ...f.card(), taLand: true,
      history: [{ at: '2026-10-11T00:10:00.000Z', event: 'rejudge-on-head', kind: 'review', pr: 30, head: A, effect: 'review-requested' },
        { at: '2026-10-11T00:20:00.000Z', event: 'live-move-result', kind: 'review', pr: 30,
          head: A, verdict: 'warn', reviewed: true, mustFix: 0, effect: 'review result captured · verdict warn · reviewed true · must-fix 0' }] }]);
    const deps = { ...f.deps(),
      live: { ...f.deps().live, landPrHead: async () => ({ head: A, state: 'OPEN', url: URL, isDraft: draft }) },
      readyPr: async () => { readyCalls += 1; draft = false; return { ok: true, reason: 'ready' }; },
    };
    const first = await rejudgeCardOnHead(f.card().id, deps);
    expect(first.map((item) => `${item.step}:${item.decision}`)).toContain('ready:ready-confirmed');
    expect(first.map((item) => `${item.step}:${item.decision}`)).toContain('regate:regate-requested');
    expect(readyCalls).toBe(1);
    expect(f.regateRequests).toHaveLength(1);
    await rejudgeCardOnHead(f.card().id, deps);
    expect(readyCalls).toBe(1);
    expect(f.regateRequests).toHaveLength(1);
  });

  test('draft-only regate failure retries the same ready head exactly once', async () => {
    const f = fixture();
    const reviewPath = reviewResultPath(f.statePath, 'ta-rj-1', 30, A);
    mkdirSync(dirname(reviewPath), { recursive: true });
    writeFileSync(reviewPath, reviewJson(A));
    const failed = { pr: 30, head: A, at: '2026-10-11T00:40:00.000Z', passed: false, status: 'failed',
      detail: 'pr-head: PR head, base commit, ready state or open state unavailable or changed (state=OPEN · isDraft=true)' };
    writeTaskCards(f.statePath, [{ ...f.card(), taLand: true, regates: [failed],
      history: [{ at: '2026-10-11T00:20:00.000Z', event: 'live-move-result', kind: 'review', pr: 30,
        head: A, verdict: 'pass', reviewed: true, mustFix: 0, effect: 'review result captured · verdict pass · reviewed true · must-fix 0' }] }]);
    const deps = { ...f.deps(), live: { ...f.deps().live, landPrHead: async () => ({ head: A, state: 'OPEN', url: URL, isDraft: false }) },
      readyPr: async () => { throw new Error('already ready must not invoke gh'); } };
    f.onRegate(f.writeRegate(true));
    const first = await rejudgeCardOnHead(f.card().id, deps);
    expect(first.at(-1)?.decision).toBe('regate-requested');
    expect(f.card().regates?.at(-1)?.readyRetry).toBe(true);
    expect(f.card().regates?.at(-1)?.passed).toBeUndefined();
    expect(f.regateRequests[0]?.resultPath).toContain('-after-ready.json');
    expect((await rejudgeCardOnHead(f.card().id, deps)).at(-1)?.decision).toBe('landed');
    expect(f.regateRequests).toHaveLength(1);
    expect(f.lands).toHaveLength(1);
  });

  test('failed ready operation does not launch a host regate', async () => {
    const f = fixture();
    writeTaskCards(f.statePath, [{ ...f.card(), taLand: true,
      history: [{ at: '2026-10-11T00:20:00.000Z', event: 'live-move-result', kind: 'review', pr: 30,
        head: A, verdict: 'pass', reviewed: true, mustFix: 0, effect: 'review result captured · verdict pass · reviewed true · must-fix 0' }] }]);
    const deps = { ...f.deps(), live: { ...f.deps().live, landPrHead: async () => ({ head: A, state: 'OPEN', url: URL, isDraft: true }) },
      readyPr: async () => ({ ok: false, reason: 'permission denied' }) };
    expect((await rejudgeCardOnHead(f.card().id, deps)).at(-1)?.decision).toBe('ready-failed');
    expect(f.regateRequests).toHaveLength(0);
    expect(f.lands).toHaveLength(0);
  });

  test('remote child terminal + exact PR binding allow one HQ review, then normal rejudge', async () => {
    const f = fixture();
    const child = 'run-child-1234';
    writeTaskCards(f.statePath, [{ ...f.card(), taLand: true, parentHost: { host: 'node-b', pid: 123 }, runChildId: child,
      reviewRequests: [], history: [] }]);
    const parentRows = [{ runId: 'run-rj', event: 'pod-child-run', data: { childRunId: child } }];
    const childRows = [{ runId: child, event: 'pr-opened', data: { number: 30, url: URL } },
      { runId: child, event: 'run-status', data: { runStatus: 'completed' } }];
    const load = (id: string) => id === 'run-rj' ? parentRows : id === child ? childRows : null;
    expect(remoteBoundRunTerminal(f.card(), load)).toBe(true);
    expect(rejudgeCandidates({ [f.card().id]: f.card() })).toEqual([f.card().id]);
    const deps = { ...f.deps(), remoteRunTerminal: (card: TaskCard) => remoteBoundRunTerminal(card, load) };
    expect((await rejudgeCardOnHead(f.card().id, deps)).at(-1)?.decision).toBe('review-requested');
    expect(f.reviewRequests).toHaveLength(1);
    expect(f.card().reviewRequests).toHaveLength(1);
    await rejudgeCardOnHead(f.card().id, deps);
    expect(f.reviewRequests).toHaveLength(1);
  });

  test('remote bootstrap refuses running, unlinked, wrong-PR and local cards; review OFF remains shadow', async () => {
    const f = fixture();
    const child = 'run-child-1234';
    const parentRows = [{ runId: 'run-rj', event: 'pod-child-run', data: { childRunId: child } }];
    const childRows = [{ runId: child, event: 'pr-opened', data: { number: 30, url: URL } },
      { runId: child, event: 'run-status', data: { runStatus: 'completed' } }];
    const load = (id: string) => id === 'run-rj' ? parentRows : id === child ? childRows : null;
    const remote: TaskCard = { ...f.card(), taLand: true, parentHost: { host: 'node-b', pid: 123 }, runChildId: child, reviewRequests: [], history: [] };
    expect(remoteBoundRunTerminal(remote, (id) => id === child ? childRows.slice(0, 1) : parentRows)).toBe(false);
    expect(remoteBoundRunTerminal(remote, (id) => id === child ? childRows : [])).toBe(false);
    expect(remoteBoundRunTerminal(remote, (id) => id === child ? [{ ...childRows[0]!, data: { number: 31, url: URL } }, childRows[1]!] : parentRows)).toBe(false);
    expect(remoteBoundRunTerminal({ ...remote, parentHost: undefined }, load)).toBe(false);
    writeTaskCards(f.statePath, [remote]);
    const deps = { ...f.deps(), remoteRunTerminal: () => false };
    expect((await rejudgeCardOnHead(remote.id, deps)).at(-1)?.decision).toBe('not-started');
    expect(f.reviewRequests).toHaveLength(0);
    expect((await rejudgeCardOnHead(remote.id, { ...deps, remoteRunTerminal: () => true, liveMoves: new Set<TaskAgentLiveMove>() })).at(-1)?.decision).toBe('would-review');
    expect(f.reviewRequests).toHaveLength(0);
  });
  test('result files → default async shadow rejudge → land decision log and zero land attempts', async () => {
    const f = fixture();
    const head = 'a7'.repeat(20);
    const reviewPath = reviewResultPath(f.statePath, 'ta-rj-1', 30, head);
    const regatePath = regateResultPath(f.statePath, 'ta-rj-1', 30, head);
    mkdirSync(dirname(reviewPath), { recursive: true });
    mkdirSync(dirname(regatePath), { recursive: true });
    writeFileSync(reviewPath, reviewJson(head));
    writeFileSync(regatePath, JSON.stringify({ pr: 30, head, passed: true, status: 'passed', baseCommit: BASE, failures: [] }));
    writeTaskCards(f.statePath, [{ ...f.card(), taLand: true, project: { target: dirname(f.statePath) },
      reviewRequests: [{ pr: 30, head, at: '2026-10-11T00:40:00.000Z', resultPath: reviewPath }],
      regates: [{ pr: 30, head, at: '2026-10-11T00:45:00.000Z', resultPath: regatePath }], history: [] }]);
    const landCalls: string[] = [];
    const shadow: Array<Record<string, unknown>> = [];
    const log = spyOn(debug, 'log').mockImplementation((_category, event, data) => {
      if (event === 'rejudge-shadow' && data && typeof data === 'object') shadow.push(data as Record<string, unknown>);
    });
    setUserConfigOverlay((cfg) => ({ ...cfg, taskAgent: { ...cfg.taskAgent, liveMoves: ['review', 'propose-land'] } }));
    try {
      const outcomes = await rejudgeAsyncResultCard('ta-rj-1', f.statePath, {
        prHead: async () => ({ head, state: 'OPEN', branch: 'feature', url: URL }),
        landPrHead: async () => ({ head, state: 'OPEN', isDraft: false, branch: 'feature', url: URL }),
        landWorktree: { localHead: () => head },
        land: async (_pr, landedHead) => { landCalls.push(landedHead); return { status: 0, stdout: 'merged' }; },
      });
      expect(outcomes.at(-1)?.decision).toBe('would-land');
      await rejudgeAsyncResultCard('ta-rj-1', f.statePath, {
        prHead: async () => ({ head, state: 'OPEN', branch: 'feature', url: URL }),
        landPrHead: async () => ({ head, state: 'OPEN', isDraft: false, branch: 'feature', url: URL }),
        landWorktree: { localHead: () => head },
        land: async (_pr, landedHead) => { landCalls.push(landedHead); return { status: 0, stdout: 'merged' }; },
      });
      expect(shadow).toMatchObject([{ card: 'ta-rj-1', head12: head.slice(0, 12), decision: 'land' }]);
      expect(shadow).toHaveLength(1);
      const reboundReview = reviewResultPath(f.statePath, 'ta-rj-1', 31, head);
      const reboundRegate = regateResultPath(f.statePath, 'ta-rj-1', 31, head);
      writeFileSync(reboundReview, reviewJson(head, { pr: '31' }));
      writeFileSync(reboundRegate, JSON.stringify({ pr: 31, head, passed: true, status: 'passed', baseCommit: BASE, failures: [] }));
      writeTaskCards(f.statePath, [{ ...f.card(), pr: { number: 31, url: 'https://github.com/o/r/pull/31' },
        reviewRequests: [{ pr: 31, head, at: '2026-10-11T00:50:00.000Z', resultPath: reboundReview }],
        regates: [{ pr: 31, head, at: '2026-10-11T00:55:00.000Z', resultPath: reboundRegate }],
        history: [...(f.card().history ?? []), { at: '2026-10-11T00:50:00.000Z', event: 'live-move-result', kind: 'review', pr: 31, head,
          verdict: 'pass', reviewed: true, mustFix: 0, reviewRoute: 'api', resultPath: reboundReview, effect: 'review result captured' }] }]);
      await rejudgeAsyncResultCard('ta-rj-1', f.statePath, {
        repoCandidates: () => [{ source: 'host', cwd: dirname(f.statePath) }],
        prHead: async () => ({ head, state: 'OPEN', branch: 'feature', url: 'https://github.com/o/r/pull/31' }),
      });
      expect(shadow).toHaveLength(2);
      expect((f.card().history ?? []).filter((item) => item.event === 'rejudge-shadow').map((item) =>
        ({ pr: item.pr, head: item.head, effect: item.effect }))).toEqual([
        { pr: 30, head, effect: 'land' }, { pr: 31, head, effect: 'land' },
      ]);
      expect(f.card().landAttempts).toBeUndefined();
      expect(landCalls).toEqual([]);
    } finally { setUserConfigOverlay(null); log.mockRestore(); }
  });

  test('shadow decision is not recorded on a card rebound while PR head is read', async () => {
    const f = fixture();
    const head = 'a8'.repeat(20);
    const reviewPath = reviewResultPath(f.statePath, 'ta-rj-1', 30, head);
    const regatePath = regateResultPath(f.statePath, 'ta-rj-1', 30, head);
    mkdirSync(dirname(reviewPath), { recursive: true });
    mkdirSync(dirname(regatePath), { recursive: true });
    writeFileSync(reviewPath, reviewJson(head));
    writeFileSync(regatePath, JSON.stringify({ pr: 30, head, passed: true, status: 'passed', baseCommit: BASE, failures: [] }));
    writeTaskCards(f.statePath, [{ ...f.card(), taLand: true,
      reviewRequests: [{ pr: 30, head, at: '2026-10-11T00:40:00.000Z', resultPath: reviewPath }],
      regates: [{ pr: 30, head, at: '2026-10-11T00:45:00.000Z', resultPath: regatePath }], history: [] }]);
    const shadow: Array<Record<string, unknown>> = [];
    const log = spyOn(debug, 'log').mockImplementation((_category, event, data) => {
      if (event === 'rejudge-shadow' && data && typeof data === 'object') shadow.push(data as Record<string, unknown>);
    });
    try {
      await rejudgeAsyncResultCard('ta-rj-1', f.statePath, {
        repoCandidates: () => [{ source: 'host', cwd: dirname(f.statePath) }],
        prHead: async () => {
          writeTaskCards(f.statePath, [{ ...f.card(), pr: { number: 31, url: 'https://github.com/o/r/pull/31' } }]);
          return { head, state: 'OPEN', branch: 'feature', url: URL };
        },
      });
      expect(shadow).toEqual([]);
      expect(f.card().history.some((entry) => entry.event === 'rejudge-shadow')).toBe(false);
    } finally { log.mockRestore(); }
  });

  test('completed worker cannot record a shadow decision for a newer PR head', async () => {
    const f = fixture();
    writeTaskCards(f.statePath, [{ ...f.card(), taLand: true, history: [] }]);
    const shadow: Array<Record<string, unknown>> = [];
    const log = spyOn(debug, 'log').mockImplementation((_category, event, data) => {
      if (event === 'rejudge-shadow' && data && typeof data === 'object') shadow.push(data as Record<string, unknown>);
    });
    try {
      await expect(rejudgeAsyncResultCard('ta-rj-1', f.statePath, {
        repoCandidates: () => [{ source: 'host', cwd: dirname(f.statePath) }],
        prHead: async () => ({ head: B, state: 'OPEN', branch: 'feature', url: URL }),
      }, { pr: 30, head: A })).rejects.toThrow('head does not match');
      expect(shadow).toEqual([]);
      expect(f.card().history.some((entry) => entry.event === 'rejudge-shadow')).toBe(false);
    } finally { log.mockRestore(); }
  });

  test('completed worker cannot record a shadow decision after its result path is replaced', async () => {
    const f = fixture();
    const resultPath = reviewResultPath(f.statePath, 'ta-rj-1', 30, A);
    const request = { pr: 30, head: A, at: '2026-10-11T00:40:00.000Z', resultPath };
    writeTaskCards(f.statePath, [{ ...f.card(), taLand: true, reviewRequests: [request], history: [] }]);
    const shadow: Array<Record<string, unknown>> = [];
    const log = spyOn(debug, 'log').mockImplementation((_category, event, data) => {
      if (event === 'rejudge-shadow' && data && typeof data === 'object') shadow.push(data as Record<string, unknown>);
    });
    try {
      await rejudgeAsyncResultCard('ta-rj-1', f.statePath, {
        repoCandidates: () => [{ source: 'host', cwd: dirname(f.statePath) }],
        prHead: async () => {
          writeTaskCards(f.statePath, [{ ...f.card(), reviewRequests: [{ ...request, resultPath: `${resultPath}.replacement` }] }]);
          return { head: A, state: 'OPEN', branch: 'feature', url: URL };
        },
      }, { pr: 30, head: A, kind: 'review', resultPath });
      expect(shadow).toEqual([]);
      expect(f.card().history.some((entry) => entry.event === 'rejudge-shadow')).toBe(false);
    } finally { log.mockRestore(); }
  });

  test('detached review and regate completion record shadow decisions without a live move', async () => {
    const f = fixture();
    const head = 'b7'.repeat(20);
    f.setHead(head);
    const resultPath = reviewResultPath(f.statePath, 'ta-rj-1', 30, head);
    mkdirSync(dirname(resultPath), { recursive: true });
    writeFileSync(resultPath, reviewJson(head));
    writeTaskCards(f.statePath, [{ ...f.card(), taLand: true,
      reviewRequests: [{ pr: 30, head, at: '2026-10-11T00:40:00.000Z', resultPath }],
      history: [] }]);
    f.onRegate(f.writeRegate(true));
    const env = { [TA_REVIEW_COMPLETION_CARD_ENV]: 'ta-rj-1', [TA_REVIEW_COMPLETION_STATE_ENV]: f.statePath, [TA_REVIEW_COMPLETION_RESULT_ENV]: resultPath };
    expect(await rejudgeCompletedTaskReview(env, undefined, f.deps())).toBe(true);
    expect(f.regateRequests).toHaveLength(0);
    const regatePath = regateResultPath(f.statePath, 'ta-rj-1', 30, head);
    mkdirSync(dirname(regatePath), { recursive: true });
    writeFileSync(regatePath, JSON.stringify({ pr: 30, head, passed: true, status: 'passed', baseCommit: BASE, failures: [] }));
    writeTaskCards(f.statePath, [{ ...f.card(), regates: [{ pr: 30, head, at: '2026-10-11T00:45:00.000Z', resultPath: regatePath }] }]);
    expect(await rejudgeCompletedTaskRegate('ta-rj-1', 30, head, regatePath, f.statePath, undefined, f.deps())).toBe(true);
    expect(f.card().regates?.[0]?.passed).toBe(true);
    expect(f.card().history.some((entry) => entry.event === 'async-result-rejudge' && entry.resultPath === regatePath)).toBe(true);
    expect(f.card().landAttempts).toBeUndefined();
    expect(f.lands).toHaveLength(0);
    expect(await rejudgeCompletedTaskRegate('ta-rj-1', 30, head, regatePath, f.statePath, undefined, f.deps())).toBe(false);
  });

  test('review and regate completion racing on one card/head execute no land in shadow phase', async () => {
    const f = fixture();
    const head = 'c7'.repeat(20);
    f.setHead(head);
    const reviewPath = reviewResultPath(f.statePath, 'ta-rj-1', 30, head);
    const regatePath = regateResultPath(f.statePath, 'ta-rj-1', 30, head);
    mkdirSync(dirname(reviewPath), { recursive: true });
    mkdirSync(dirname(regatePath), { recursive: true });
    writeFileSync(reviewPath, reviewJson(head));
    writeFileSync(regatePath, JSON.stringify({ pr: 30, head, passed: true, status: 'passed', baseCommit: BASE, failures: [] }));
    writeTaskCards(f.statePath, [{ ...f.card(), taLand: true,
      reviewRequests: [{ pr: 30, head, at: '2026-10-11T00:40:00.000Z', resultPath: reviewPath }],
      regates: [{ pr: 30, head, at: '2026-10-11T00:45:00.000Z', resultPath: regatePath }], history: [] }]);
    const env = { [TA_REVIEW_COMPLETION_CARD_ENV]: 'ta-rj-1', [TA_REVIEW_COMPLETION_STATE_ENV]: f.statePath, [TA_REVIEW_COMPLETION_RESULT_ENV]: reviewPath };
    await Promise.all([
      rejudgeCompletedTaskReview(env, undefined, f.deps()),
      rejudgeCompletedTaskRegate('ta-rj-1', 30, head, regatePath, f.statePath, undefined, f.deps()),
    ]);
    expect(f.lands).toHaveLength(0);
    expect(f.card().landAttempts).toBeUndefined();
  });

  test('regate completion claims exact card/head/result once, with no recursive recall', async () => {
    const f = fixture();
    const resultPath = regateResultPath(f.statePath, 'ta-rj-1', 30, A);
    writeTaskCards(f.statePath, [{ ...f.card(), taLand: true, regates: [{ pr: 30, head: A, at: '2026-10-11T01:00:00.000Z', resultPath }] }]);
    mkdirSync(dirname(resultPath), { recursive: true });
    writeFileSync(resultPath, JSON.stringify({ pr: 30, head: A, passed: true, baseCommit: BASE, failures: [] }));
    const calls: string[] = [];
    const tick = async (cardId: string, statePath: string) => { calls.push(`${cardId}:${statePath}`); return [{ decision: 'would-land', pr: 30, toHead: A }]; };
    expect(await rejudgeCompletedTaskRegate('ta-rj-1', 30, A, resultPath, f.statePath, tick)).toBe(true);
    expect(await rejudgeCompletedTaskRegate('ta-rj-1', 30, A, resultPath, f.statePath, tick)).toBe(false);
    expect(await rejudgeCompletedTaskRegate('ta-rj-1', 30, B, resultPath, f.statePath, tick)).toBe(false);
    expect(calls).toEqual([`ta-rj-1:${f.statePath}`]);
    expect(f.card().history.filter((entry) => entry.event === 'async-result-rejudge')).toHaveLength(1);
  });

  test('regate completion cannot mark old head after rejudge moved to a newer head', async () => {
    const f = fixture();
    const resultPath = regateResultPath(f.statePath, 'ta-rj-1', 30, A);
    writeTaskCards(f.statePath, [{ ...f.card(), taLand: true, regates: [{ pr: 30, head: A, at: '2026-10-11T01:00:00.000Z', resultPath }] }]);
    mkdirSync(dirname(resultPath), { recursive: true });
    writeFileSync(resultPath, JSON.stringify({ pr: 30, head: A, passed: true, baseCommit: BASE, failures: [] }));
    let calls = 0;
    await expect(rejudgeCompletedTaskRegate('ta-rj-1', 30, A, resultPath, f.statePath, async () => {
      calls++;
      return [{ decision: 'would-regate', pr: 30, toHead: B }];
    })).rejects.toThrow('head does not match');
    expect(calls).toBe(2);
    expect(f.card().history.some((entry) => entry.event === 'async-result-rejudge')).toBe(false);
  });

  test('regate completion rejects a result for the card’s former PR', async () => {
    const f = fixture();
    const resultPath = regateResultPath(f.statePath, 'ta-rj-1', 30, A);
    writeTaskCards(f.statePath, [{ ...f.card(), pr: { number: 31, url: 'https://github.com/o/r/pull/31' }, taLand: true,
      regates: [{ pr: 30, head: A, at: '2026-10-11T01:00:00.000Z', resultPath }] }]);
    mkdirSync(dirname(resultPath), { recursive: true });
    writeFileSync(resultPath, JSON.stringify({ pr: 30, head: A, passed: true, baseCommit: BASE, failures: [] }));
    let calls = 0;
    expect(await rejudgeCompletedTaskRegate('ta-rj-1', 30, A, resultPath, f.statePath, async () => { calls++; })).toBe(false);
    expect(calls).toBe(0);
    expect(f.card().history.some((entry) => entry.event === 'async-result-rejudge')).toBe(false);
  });

  test('regate completion does not mark success after the card closes during rejudge', async () => {
    const f = fixture();
    const resultPath = regateResultPath(f.statePath, 'ta-rj-1', 30, A);
    writeTaskCards(f.statePath, [{ ...f.card(), taLand: true,
      regates: [{ pr: 30, head: A, at: '2026-10-11T01:00:00.000Z', resultPath }] }]);
    mkdirSync(dirname(resultPath), { recursive: true });
    writeFileSync(resultPath, JSON.stringify({ pr: 30, head: A, passed: true, baseCommit: BASE, failures: [] }));
    expect(await rejudgeCompletedTaskRegate('ta-rj-1', 30, A, resultPath, f.statePath, async () => {
      writeTaskCards(f.statePath, [{ ...f.card(), status: 'failed' }]);
      return [{ decision: 'would-land', pr: 30, toHead: A }];
    })).toBe(true);
    expect(f.card().history.some((entry) => entry.event === 'async-result-rejudge')).toBe(false);
  });

  test('regate completion does not mark success after a conflicting result replaces its pending entry', async () => {
    const f = fixture();
    const resultPath = regateResultPath(f.statePath, 'ta-rj-1', 30, A);
    writeTaskCards(f.statePath, [{ ...f.card(), taLand: true,
      regates: [{ pr: 30, head: A, at: '2026-10-11T01:00:00.000Z', resultPath }] }]);
    mkdirSync(dirname(resultPath), { recursive: true });
    writeFileSync(resultPath, JSON.stringify({ pr: 30, head: A, passed: true, baseCommit: BASE, failures: [] }));
    expect(await rejudgeCompletedTaskRegate('ta-rj-1', 30, A, resultPath, f.statePath, async () => {
      writeTaskCards(f.statePath, [{ ...f.card(), regates: [{ pr: 30, head: A, at: '2026-10-11T01:00:00.000Z', resultPath, passed: false }] }]);
      return [{ decision: 'would-land', pr: 30, toHead: A }];
    })).toBe(true);
    expect(f.card().history.some((entry) => entry.event === 'async-result-rejudge')).toBe(false);
  });

  test('failed regate result cannot gain a success marker from a later successful rejudge', async () => {
    const f = fixture();
    const resultPath = regateResultPath(f.statePath, 'ta-rj-1', 30, A);
    writeTaskCards(f.statePath, [{ ...f.card(), taLand: true,
      regates: [{ pr: 30, head: A, at: '2026-10-11T01:00:00.000Z', resultPath }] }]);
    mkdirSync(dirname(resultPath), { recursive: true });
    writeFileSync(resultPath, JSON.stringify({ pr: 30, head: A, passed: false, status: 'failed', failures: [{ step: 'typecheck', detail: 'red' }] }));
    expect(await rejudgeCompletedTaskRegate('ta-rj-1', 30, A, resultPath, f.statePath, async () => [{ decision: 'would-land', pr: 30, toHead: A }])).toBe(true);
    expect(f.card().history.some((entry) => entry.event === 'async-result-rejudge')).toBe(false);
  });

  test('regate completion releases its claim after a rejudge exception', async () => {
    const f = fixture();
    const resultPath = regateResultPath(f.statePath, 'ta-rj-1', 30, A);
    writeTaskCards(f.statePath, [{ ...f.card(), taLand: true, regates: [{ pr: 30, head: A, at: '2026-10-11T01:00:00.000Z', resultPath }] }]);
    mkdirSync(dirname(resultPath), { recursive: true });
    writeFileSync(resultPath, JSON.stringify({ pr: 30, head: A, passed: true, baseCommit: BASE, failures: [] }));
    let calls = 0;
    expect(await rejudgeCompletedTaskRegate('ta-rj-1', 30, A, resultPath, f.statePath, async () => {
      expect(f.card().history.some((entry) => entry.event === 'async-result-rejudge')).toBe(false);
      if (++calls === 1) throw new Error('transient');
      return [{ decision: 'would-land', pr: 30, toHead: A }];
    })).toBe(true);
    expect(calls).toBe(2);
    expect(await rejudgeCompletedTaskRegate('ta-rj-1', 30, A, resultPath, f.statePath, async () => { calls++; })).toBe(false);
    expect(f.card().history.some((entry) => entry.event === 'async-result-rejudge' && entry.effect === 'completion callback succeeded')).toBe(true);
  });

  test('two failed completion attempts leave the card eligible for the next rejudge cycle', async () => {
    const f = fixture();
    const resultPath = regateResultPath(f.statePath, 'ta-rj-1', 30, A);
    writeTaskCards(f.statePath, [{ ...f.card(), taLand: true, regates: [{ pr: 30, head: A, at: '2026-10-11T01:00:00.000Z', resultPath }] }]);
    mkdirSync(dirname(resultPath), { recursive: true });
    writeFileSync(resultPath, JSON.stringify({ pr: 30, head: A, passed: true, baseCommit: BASE, failures: [] }));
    let calls = 0;
    await expect(rejudgeCompletedTaskRegate('ta-rj-1', 30, A, resultPath, f.statePath, async () => {
      calls++;
      throw new Error('still unavailable');
    })).rejects.toThrow('still unavailable');
    expect(calls).toBe(2);
    expect(f.card().history.some((entry) => entry.event === 'async-result-rejudge')).toBe(false);
    expect(rejudgeCandidates({ [f.card().id]: f.card() })).toEqual([f.card().id]);
  });

  test('머리 그대로(A) · 리뷰 결과가 없으면 land 하지 않고 head-unchanged 로 멈춘다', async () => {
    const f = fixture();
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.regateRequests).toEqual([]);
    expect(f.reviewRequests).toEqual([]);
    expect(f.lands).toEqual([]);
    expect(f.decisions()).toEqual(['target:head-unchanged']);
  });

  test('같은 머리 · pass must-fix 0 · 기존 live는 조기 반환하고 shadow만 재게이트를 제안한다', async () => {
    const head = A;
    const f = fixture();
    const reviewPath = reviewResultPath(f.statePath, 'ta-rj-1', 30, head);
    mkdirSync(dirname(reviewPath), { recursive: true });
    writeFileSync(reviewPath, reviewJson(head));
    writeTaskCards(f.statePath, [{ ...f.card(),
      reviewRequests: [{ pr: 30, head, at: '2026-10-11T00:40:00.000Z', resultPath: reviewPath }],
      history: [{ at: '2026-10-11T00:45:00.000Z', event: 'live-move-result', kind: 'review', pr: 30, head, verdict: 'pass', reviewed: true, mustFix: 0, reviewRoute: 'api', resultPath: reviewPath }] }]);
    f.onRegate(f.writeRegate(true));
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    await rejudgeCardOnHead('ta-rj-1', { ...f.deps(), shadowSameHead: true });
    expect(f.decisions()).toEqual(['target:head-unchanged', 'target:head-unchanged']);
    const shadow = await rejudgeShadowCard('ta-rj-1', f.statePath, f.deps());
    expect(shadow.some((item) => item.decision === 'would-regate')).toBe(true);
    expect(f.regateRequests).toEqual([]);
    expect(f.lands).toEqual([]);
  });

  test('같은 머리 · pass must-fix 0 · 기존 통과 재게이트를 재사용해 land', async () => {
    const head = 'cd'.repeat(20);
    const f = fixture({ regates: [{ pr: 30, head, at: '2026-10-11T00:30:00.000Z', passed: true, status: 'passed', baseCommit: BASE }] });
    f.setHead(head);
    const reviewPath = reviewResultPath(f.statePath, 'ta-rj-1', 30, head);
    mkdirSync(dirname(reviewPath), { recursive: true });
    writeFileSync(reviewPath, reviewJson(head));
    writeTaskCards(f.statePath, [{ ...f.card(),
      reviewRequests: [{ pr: 30, head, at: '2026-10-11T00:40:00.000Z', resultPath: reviewPath }],
      history: [{ at: '2026-10-11T00:45:00.000Z', event: 'live-move-result', kind: 'review', pr: 30, head, verdict: 'pass', reviewed: true, mustFix: 0, reviewRoute: 'api', resultPath: reviewPath }] }]);
    const outcomes = await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.regateRequests).toEqual([]);
    expect(f.lands).toEqual([{ pr: 30, head, overlapEvidence: overlapEvidencePath(f.statePath, 'ta-rj-1', 30, head) }]);
    expect(outcomes.at(-1)).toMatchObject({ step: 'land', decision: 'landed' });
  });

  test('같은 머리 · warn must-fix 0 · 기존 통과 재게이트를 재사용해 land', async () => {
    const head = 'e1'.repeat(20);
    const f = fixture({ regates: [{ pr: 30, head, at: '2026-10-11T00:30:00.000Z', passed: true, status: 'passed', baseCommit: BASE }] });
    f.setHead(head);
    const reviewPath = reviewResultPath(f.statePath, 'ta-rj-1', 30, head);
    mkdirSync(dirname(reviewPath), { recursive: true });
    writeFileSync(reviewPath, reviewJson(head, { verdict: 'warn' }));
    writeTaskCards(f.statePath, [{ ...f.card(),
      reviewRequests: [{ pr: 30, head, at: '2026-10-11T00:40:00.000Z', resultPath: reviewPath }],
      history: [{ at: '2026-10-11T00:45:00.000Z', event: 'live-move-result', kind: 'review', pr: 30, head, verdict: 'warn', reviewed: true, mustFix: 0, reviewRoute: 'api', resultPath: reviewPath }] }]);
    const outcomes = await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.regateRequests).toEqual([]);
    expect(f.lands).toHaveLength(1);
    expect(outcomes.at(-1)).toMatchObject({ step: 'land', decision: 'landed' });
  });

  test('같은 머리 · pass must-fix 0 · 기존 live는 재게이트와 land를 새로 시작하지 않는다', async () => {
    const f = fixture();
    const head = 'a1'.repeat(20);
    f.setHead(head);
    const reviewPath = reviewResultPath(f.statePath, 'ta-rj-1', 30, head);
    mkdirSync(dirname(reviewPath), { recursive: true });
    writeFileSync(reviewPath, reviewJson(head));
    const card = f.card();
    writeTaskCards(f.statePath, [{ ...card,
      reviewRequests: [{ pr: 30, head, at: '2026-10-11T00:40:00.000Z', resultPath: reviewPath }],
      history: [{ at: '2026-10-11T00:45:00.000Z', event: 'live-move-result', kind: 'review', pr: 30, head, verdict: 'pass', reviewed: true, mustFix: 0, reviewRoute: 'api', resultPath: reviewPath }] }]);
    f.onRegate(f.writeRegate(true));
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.regateRequests).toEqual([]);
    f.setClock('2026-10-11T01:05:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.card().regates).toBeUndefined();
    expect(f.lands).toEqual([]);
    expect(f.decisions()).toEqual(['target:head-unchanged', 'target:head-unchanged']);
  });

  test('머리 A→B → 재게이트 1회 ⊕ 리뷰 재요청 1회 · 같은 머리 다음 틱은 0회', async () => {
    const f = fixture();
    f.setHead(B);
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.regateRequests).toEqual([{ card: 'ta-rj-1', pr: 30, head: B, repoRoot: '/repo', resultPath: regateResultPath(f.statePath, 'ta-rj-1', 30, B) }]);
    expect(f.reviewRequests).toEqual([{ pr: 30, resultPath: reviewResultPath(f.statePath, 'ta-rj-1', 30, B) }]);
    expect(f.decisions()).toEqual(['regate:regate-requested', 'review:review-requested']);
    expect(f.card().regates).toEqual([{ pr: 30, head: B, at: '2026-10-11T01:00:00.000Z', resultPath: regateResultPath(f.statePath, 'ta-rj-1', 30, B) }]);
    expect(f.card().history.filter((item) => item.event === 'rejudge-on-head').map((item) => `${item.kind}:${item.effect}`)).toEqual(['regate:regate-requested', 'review:review-requested']);
    expect(f.logs.find((entry) => entry.event === 'rejudge-on-head')?.data).toMatchObject({ card: 'ta-rj-1', pr: 30, fromHead: A, toHead: B, step: 'regate' });
    f.setClock('2026-10-11T01:05:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.regateRequests).toHaveLength(1);
    expect(f.reviewRequests).toHaveLength(1);
    expect(f.lands).toEqual([]);
  });

  test('재게이트 fail → 리뷰가 pass ⊕ must-fix 0 이어도 land 0', async () => {
    const f = fixture();
    f.setHead(B);
    f.onRegate(f.writeRegate(false));
    f.onReview((path) => writeFileSync(path, reviewJson(B)));
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    f.setClock('2026-10-11T01:10:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.card().regates?.[0]).toMatchObject({ head: B, passed: false, status: 'failed', detail: 'typecheck: error TS1' });
    expect(f.lands).toEqual([]);
    expect(f.decisions()).toContain('land:not-landing');
  });

  test('재게이트 pass ⊕ 리뷰 must-fix 1 → land 0', async () => {
    const f = fixture();
    f.setHead(B);
    f.onRegate(f.writeRegate(true));
    f.onReview((path) => writeFileSync(path, reviewJson(B, { verdict: 'pass', mustFix: ['still broken'] })));
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    f.setClock('2026-10-11T01:10:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.card().regates?.[0]).toMatchObject({ passed: true, baseCommit: BASE });
    expect(f.lands).toEqual([]);
    expect(f.decisions()).toContain('repair:would-repair');
  });

  test('재게이트 pass ⊕ 지금 머리 pass ⊕ must-fix 0 → land 한 번 · --overlap-evidence 파일 내용이 맞다', async () => {
    const f = fixture();
    f.setHead(B);
    f.onRegate(f.writeRegate(true));
    f.onReview((path) => writeFileSync(path, reviewJson(B)));
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    f.setClock('2026-10-11T01:10:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    const evidence = overlapEvidencePath(f.statePath, 'ta-rj-1', 30, B);
    expect(f.lands).toEqual([{ pr: 30, head: B, overlapEvidence: evidence }]);
    expect(JSON.parse(readFileSync(evidence, 'utf8'))).toEqual({
      pr: 30, head: B, gate: { head: B, baseCommit: BASE, passed: true }, reviewResult: reviewResultPath(f.statePath, 'ta-rj-1', 30, B),
    });
    expect(f.decisions().at(-1)).toBe('land:landed');
    // 다음 틱 — 같은 머리는 다시 land 하지 않는다(executeLiveLand 의 머리 이력).
    f.setClock('2026-10-11T01:20:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.lands).toHaveLength(1);
  });

  // LAND-ORDER-LEDGER — land 단계 뒤 원장 한 줄(executeLiveLand 직후 append · 같은 pr+head 는 한 줄).
  test('LAND-ORDER-LEDGER — land 단계 뒤 원장 1행(pr·head·cardId·gateBase·리뷰 판정·land 결과 · 관측 appended)', async () => {
    const f = fixture();
    // 머리는 40자 hex sha — 다른 시험과 머리(주기 표시)가 겹치지 않게 새 조합을 쓴다.
    const G = 'd1'.repeat(20);
    f.setHead(G);
    f.onRegate(f.writeRegate(true));
    f.onReview((path) => writeFileSync(path, reviewJson(G)));
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    f.setClock('2026-10-11T01:05:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    const rows = readFileSync(landOrderLedgerPath(f.statePath), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(rows).toEqual([{ pr: 30, head: G, cardId: 'ta-rj-1', gateBase: BASE, reviewVerdict: 'pass', mustFix: 0, landOk: true, landClass: null, at: '2026-10-11T01:05:00.000Z' }]);
    expect(f.logs.filter((entry) => entry.event === 'appended' || entry.event === 'append-failed'))
      .toEqual([{ event: 'appended', data: { pr: 30, head: G } }]);
  });

  // TA-LAND-RETRY-ON-INFRA — #26030 실측 재현(10-11 04:30): 첫 land 가 TA 쪽 인프라 결손으로 죽고 같은 머리 재시도가 막혔다.
  const EXPECTED_HEAD_LOCAL = '✗ expected-head: PR OPEN non-draft, matching local HEAD and clean worktree required';
  // 주기 표시(`rejudge:<card>:<head>`)는 모듈 전역이다 — 시험마다 다른 새 머리를 써서 앞 시험의 착지 주기와 겹치지 않게.
  const readyB = async (f: ReturnType<typeof fixture>, head: string) => {
    f.setHead(head);
    f.onRegate(f.writeRegate(true));
    f.onReview((path) => writeFileSync(path, reviewJson(head)));
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    f.setClock('2026-10-11T01:10:00.000Z');
  };

  test('TA land review-missing refusal enters recover@1, requests a fresh exact-head review, then re-enters land admission once', async () => {
    const f = fixture();
    const head = 'e7'.repeat(20);
    await readyB(f, head);
    f.queueLand({ status: 1, stdout: '', stderr: '✗ overlap-evidence: review-missing: captured review file unavailable' });
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(listGraphRuns(dirname(f.statePath)).runs.some((run) => run.graphId === 'task-agent-recover-review'
      && run.unitCalls?.[0]?.entry === 'request-review' && run.unitCalls[0].exit === 'rework' && run.status === 'done')).toBe(true);
    expect(f.lands).toHaveLength(1);
    expect(f.reviewRequests).toHaveLength(2);
    expect(f.reviewRequests[1]?.resultPath).not.toBe(f.reviewRequests[0]?.resultPath);
    expect(f.decisions()).toContain('review:review-requested');
    f.setClock('2026-10-11T01:20:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.lands).toHaveLength(2);
    expect(f.card().landAttempts?.map((attempt) => attempt.class ?? null)).toEqual(['recovery', null]);
    const busy = '✗ heavy-remote: 원격 게이트 gate-host-busy node-b saturated';
    expect(classifyLandFailure({ status: 1, stderr: busy })).toEqual({ class: 'recovery', reason: 'gate-host-busy' });
    const busyAt = new Date(Date.now() - 31_000).toISOString();
    const busyCard = { ...f.card(), landAttempts: [{ pr: 30, head, at: busyAt, ok: false, class: 'recovery' as const, reason: 'gate-host-busy' }] };
    expect(landRetryPending(busyCard, 30, head)).toBe(false);
    const admitted = { ...busyCard, history: [...(busyCard.history ?? []), { at: busyAt, event: 'rejudge-on-head', kind: 'land', effect: 'recover-wait-retry', pr: 30, head }] };
    expect(landRetryPending(admitted, 30, head)).toBe(true);
  });

  test('TA host-busy refusal records its real graph decision and retries through land only after 30 seconds', async () => {
    const f = fixture();
    const head = 'e8'.repeat(20);
    await readyB(f, head);
    f.queueLand({ status: 1, stdout: '', stderr: '✗ heavy-remote: 원격 게이트 gate-host-busy node-b saturated' });
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.lands).toHaveLength(1);
    expect(listGraphRuns(dirname(f.statePath)).runs.some((run) => run.graphId === 'task-agent-recover-wait'
      && run.unitCalls?.[0]?.entry === 'wait-retry' && run.unitCalls[0].exit === 'rework' && run.status === 'done')).toBe(true);
    expect(f.card().history?.some((event) => event.event === 'rejudge-on-head' && event.kind === 'land'
      && event.effect === 'recover-wait-retry' && event.head === head)).toBe(true);
    const clock = spyOn(Date, 'now').mockReturnValue(new Date('2026-10-11T01:10:00.000Z').getTime());
    try {
      expect(landRetryPending(f.card(), 30, head)).toBe(false);
      await rejudgeCardOnHead('ta-rj-1', f.deps());
      expect(f.lands).toHaveLength(1);
      f.setClock('2026-10-11T01:10:31.000Z');
      clock.mockReturnValue(new Date('2026-10-11T01:10:31.000Z').getTime());
      expect(landRetryPending(f.card(), 30, head)).toBe(true);
      await rejudgeCardOnHead('ta-rj-1', f.deps());
      expect(f.lands).toHaveLength(2);
    } finally {
      clock.mockRestore();
    }
  });

  test('TA-LAND-RETRY-ON-INFRA — infra 로 죽은 land 는 다음 틱에 같은 머리로 한 번 더 · 성공하면 landed', async () => {
    const f = fixture();
    await readyB(f, D);
    f.queueLand({ status: 1, stdout: '', stderr: EXPECTED_HEAD_LOCAL });
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.decisions().at(-1)).toBe('land:land-rejected');
    const rejected = f.logs.filter((entry) => entry.event === 'rejudge-on-head').at(-1)!.data.reason as string;
    expect(rejected).toContain('land-class infra (precondition-local-head-clean-tree) · attempt 1 · retry allowed on this head');
    f.setClock('2026-10-11T01:20:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.lands.map((entry) => entry.head)).toEqual([D, D]);
    expect(f.decisions().at(-1)).toBe('land:landed');
    expect(f.card().landAttempts?.map((entry) => [entry.ok, entry.class ?? null])).toEqual([[false, 'infra'], [true, null]]);
  });

  test('TA-LAND-RETRY-ON-INFRA — infra 두 번이면 세 번째 틱은 land 0', async () => {
    const f = fixture();
    await readyB(f, E);
    f.queueLand({ status: 1, stdout: '', stderr: EXPECTED_HEAD_LOCAL }, { status: 1, stdout: '', stderr: EXPECTED_HEAD_LOCAL });
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    f.setClock('2026-10-11T01:20:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    f.setClock('2026-10-11T01:30:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.lands).toHaveLength(2);
    expect(f.decisions().at(-1)).toBe('land:land-rejected');
    expect(f.card().landAttempts?.map((entry) => [entry.ok, entry.class])).toEqual([[false, 'infra'], [false, 'infra']]);
  });

  test('TA-LAND-RETRY-ON-INFRA — judgement 로 거절된 land 는 같은 머리 재시도 0', async () => {
    const f = fixture();
    await readyB(f, F);
    f.queueLand({ status: 1, stdout: '', stderr: '✗ expected-head: overlap merge approval unavailable for the reviewed head' });
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.logs.filter((entry) => entry.event === 'rejudge-on-head').at(-1)!.data.reason).toContain('land-class judgement');
    f.setClock('2026-10-11T01:20:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.lands).toHaveLength(1);
  });

  test('TA-LAND-RETRY-ON-INFRA — 판단한 머리(A) 그대로여도 그 머리 land 가 infra 로 죽어 재시도가 남았으면 재게이트부터 다시 간다 · judgement 면 head-unchanged', async () => {
    const infra = fixture({ landAttempts: [{ pr: 30, head: A, at: '2026-10-11T00:30:00.000Z', ok: false, detail: EXPECTED_HEAD_LOCAL, class: 'infra', reason: 'precondition-local-head-clean-tree' }] });
    await rejudgeCardOnHead('ta-rj-1', infra.deps());
    expect(infra.decisions()).not.toContain('target:head-unchanged');
    expect(infra.regateRequests.map((request) => request.head)).toEqual([A]);
    const judged = fixture({ landAttempts: [{ pr: 30, head: A, at: '2026-10-11T00:30:00.000Z', ok: false, detail: 'x', class: 'judgement', reason: 'x' }] });
    await rejudgeCardOnHead('ta-rj-1', judged.deps());
    expect(judged.decisions()).toEqual(['target:head-unchanged']);
  });

  // REJUDGE base-stale — `pr land --overlap-evidence` 가 «재게이트 뒤 main 이 PR 파일을 건드리며 움직였다»로 거절하면(#26060),
  //   같은 머리라도 새 base 위에서 재게이트를 한 번 더 청하고, 그 결과 base 로 증거를 다시 써 다음 틱에 land 한다.
  const BASE2 = '0'.repeat(40);
  const STALE_LAND = {
    status: 1, stdout: '',
    stderr: [
      `✗ overlap-evidence: base-stale-overlap: gate ${BASE.slice(0, 12)} ≠ origin/main ${BASE2.slice(0, 12)} · 1/2 window commits touch PR files (${BASE2.slice(0, 12)}): src/x.ts`,
      '✗ expected-head: overlap merge approval unavailable for the reviewed head',
    ].join('\n'),
  };
  const lastReason = (f: ReturnType<typeof fixture>) => f.logs.filter((entry) => entry.event === 'rejudge-on-head').at(-1)!.data.reason as string;

  test('REJUDGE base-stale — classifyLandFailure: base-stale-overlap(⊕ 딸린 expected-head 줄)는 «base-stale» 갈래 · 다른 ✗ 줄이 섞이면 judgement', () => {
    expect(classifyLandFailure(STALE_LAND)).toMatchObject({ class: 'base-stale' });
    expect(classifyLandFailure(STALE_LAND).reason).toStartWith('base-stale-overlap:');
    expect(classifyLandFailure({ ...STALE_LAND, stderr: `${STALE_LAND.stderr}\n✗ typecheck: blocked` }).class).toBe('judgement');
    expect(classifyLandFailure({ status: 1, stdout: '', stderr: '✗ overlap-evidence: base-window-unmeasured: x' }).class).toBe('judgement');
  });

  test('REJUDGE base-stale — land 가 base-stale-overlap 이면 같은 머리 재게이트 1 → 통과 → land 재시도 1(새 base 증거)', async () => {
    const f = fixture();
    const H = '4'.repeat(40);
    await readyB(f, H);
    f.queueLand(STALE_LAND);
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.lands).toHaveLength(1);
    expect(f.decisions().at(-1)).toBe('land:land-rejected');
    expect(lastReason(f)).toContain('land-class base-stale');
    expect(f.card().landAttempts?.map((entry) => [entry.ok, entry.class])).toEqual([[false, 'base-stale']]);
    expect(f.card().history.filter((item) => item.event === 'land-retry-on-infra').at(-1)).toMatchObject({ kind: 'base-stale', effect: 'awaiting-regate' });
    // 다음 틱 — 새 base 위 재게이트를 한 번 청한다(관측: step regate · reason base-stale-overlap).
    f.onRegate(f.writeRegate(true, { baseCommit: BASE2 }));
    f.setClock('2026-10-11T01:20:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.regateRequests.map((request) => request.head)).toEqual([H, H]);
    expect(f.regateRequests[1]!.resultPath).not.toBe(f.regateRequests[0]!.resultPath);
    expect(f.lands).toHaveLength(1);
    const regateLog = f.logs.filter((entry) => entry.event === 'rejudge-on-head' && entry.data.step === 'regate').at(-1)!.data;
    expect(regateLog).toMatchObject({ step: 'regate', decision: 'regate-requested', toHead: H });
    expect(regateLog.reason as string).toStartWith('base-stale-overlap');
    expect(f.card().regates?.filter((entry) => entry.head === H).at(-1)).toMatchObject({ staleBase: BASE });
    // 그다음 틱 — 재게이트 통과(base BASE2) → 새 증거로 land 재시도 1.
    f.setClock('2026-10-11T01:30:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.lands.map((entry) => entry.head)).toEqual([H, H]);
    expect(f.decisions().at(-1)).toBe('land:landed');
    expect(JSON.parse(readFileSync(overlapEvidencePath(f.statePath, 'ta-rj-1', 30, H), 'utf8')).gate).toEqual({ head: H, baseCommit: BASE2, passed: true });
    expect(f.card().landAttempts?.map((entry) => [entry.ok, entry.class ?? null])).toEqual([[false, 'base-stale'], [true, null]]);
    f.setClock('2026-10-11T01:40:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.lands).toHaveLength(2);
    expect(f.regateRequests).toHaveLength(2);
  });

  test('REJUDGE base-stale — 같은 머리·같은 base 로는 재게이트를 두 번 안 한다(틱 반복 · 결과 base 가 그대로면 catch-up)', async () => {
    const f = fixture();
    const H = '45'.repeat(20);
    const NEW = 'aa'.repeat(20);
    await readyB(f, H);
    f.queueLand(STALE_LAND);
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    f.onRegate(undefined);
    f.setClock('2026-10-11T01:20:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    f.setClock('2026-10-11T01:25:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.regateRequests).toHaveLength(2);
    expect(f.decisions()).toContain('regate:awaiting-regate-result');
    // 재게이트가 «같은» base(BASE)로 돌아왔다 — 멱등 키로 재게이트 0 · catch-up merge·push 1회.
    f.writeRegate(true, { baseCommit: BASE })(f.regateRequests[1]!);
    f.onCatchUp(async (request) => ({
      decision: 'pushed', reason: 'merged origin/main', fromBase: request.fromBase, toBase: BASE2, newHead: NEW, pushArgs: ['push', 'origin', 'HEAD:feature'],
    }));
    f.setClock('2026-10-11T01:30:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.regateRequests).toHaveLength(2);
    expect(f.lands).toHaveLength(1);
    expect(f.catchUpRequests).toHaveLength(1);
    expect(f.catchUpRequests[0]).toMatchObject({ head: H, fromBase: BASE, branch: 'feature' });
    expect(f.decisions().at(-1)).toBe('catch-up:pushed');
    expect(f.logs.filter((entry) => entry.event === 'rejudge-on-head' && entry.data.step === 'catch-up').at(-1)!.data).toMatchObject({
      step: 'catch-up', decision: 'pushed', fromBase: BASE, toBase: BASE2, newHead: NEW,
    });
    // 같은 머리 다음 틱 — 이미 이 머리에 catch-up 했으므로 0.
    f.setClock('2026-10-11T01:40:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.catchUpRequests).toHaveLength(1);
    expect(f.regateRequests).toHaveLength(2);
  });

  test(`REJUDGE base-stale — 재요청도 상한(${REJUDGE_HEAD_CAP})에 든다 · 넘으면 멈춤 ⊕ 사유`, async () => {
    const H = '46'.repeat(20);
    const f = fixture({
      regates: [
        ...['1', '2'].map((d) => ({ pr: 30, head: d.repeat(40), at: '2026-10-11T00:30:00.000Z', passed: false, status: 'failed' })),
        { pr: 30, head: H, at: '2026-10-11T00:40:00.000Z', passed: true, status: 'passed', baseCommit: BASE },
      ],
      landAttempts: [{ pr: 30, head: H, at: '2026-10-11T00:50:00.000Z', ok: false, detail: STALE_LAND.stderr, class: 'base-stale' as 'judgement', reason: 'base-stale-overlap: gate x' }],
    });
    f.setHead(H);
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.regateRequests).toEqual([]);
    expect(f.lands).toEqual([]);
    expect(f.decisions()).toEqual(['regate:cap-reached']);
    expect(lastReason(f)).toContain('base-stale-overlap');
    expect(f.card().history.at(-1)).toMatchObject({ event: 'rejudge-on-head', kind: 'regate', effect: 'cap-reached', head: H });
  });

  test('REJUDGE base-stale — base-advanced-disjoint 로 통과한 land 는 종전대로 landed · 재게이트 재요청 0', async () => {
    const f = fixture();
    const H = '47'.repeat(20);
    await readyB(f, H);
    f.queueLand({ status: 0, stdout: `✓ overlap-evidence: base-advanced-disjoint — gate base ${BASE.slice(0, 12)} ⊂ head ${H.slice(0, 12)}` });
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.decisions().at(-1)).toBe('land:landed');
    f.setClock('2026-10-11T01:20:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.regateRequests).toHaveLength(1);
    expect(f.lands).toHaveLength(1);
  });

  test('재게이트 결과에 baseCommit 이 없으면 증거가 불완전 — land 0 · 사유 줄', async () => {
    const f = fixture();
    f.setHead(B);
    f.onRegate((request) => { f.writeRegate(true)(request); writeFileSync(request.resultPath, JSON.stringify({ pr: 30, head: B, passed: true, status: 'passed', failures: [] })); });
    f.onReview((path) => writeFileSync(path, reviewJson(B)));
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    f.setClock('2026-10-11T01:10:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.lands).toEqual([]);
    expect(f.card().history.at(-1)).toMatchObject({ event: 'rejudge-on-head', kind: 'land', effect: 'not-landing' });
    expect(f.card().history.at(-1)!.detail).toContain('regate baseCommit missing');
  });

  test('증거 파일을 못 쓰면 land 0(종전 인자로 부르지 않는다)', async () => {
    const f = fixture();
    writeFileSync(join(dirname(f.statePath), 'overlap-evidence'), 'not a directory');
    f.setHead(B);
    f.onRegate(f.writeRegate(true));
    f.onReview((path) => writeFileSync(path, reviewJson(B)));
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    f.setClock('2026-10-11T01:10:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.lands).toEqual([]);
    expect(f.card().history.at(-1)!.detail).toContain('overlap evidence write failed');
  });

  test('B 재게이트 결과가 나오기 전에 머리가 C 로 바뀌어도 B 결과는 카드에 회수되고 C 는 따로 판단된다', async () => {
    const f = fixture();
    const C = 'd'.repeat(40);
    f.setHead(B);
    f.onRegate(f.writeRegate(true));
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    f.setHead(C);
    f.setClock('2026-10-11T01:10:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.card().regates?.map((entry) => [entry.head, entry.passed])).toEqual([[B, true], [C, undefined]]);
    expect(f.regateRequests.map((request) => request.head)).toEqual([B, C]);
    expect(f.decisions()).toContain('regate:regate-passed');
  });

  // TA-LAND-WARN-MUSTFIX0 — 회수 결과의 land 판정은 정본 규칙: verdict ∈ {pass, warn} ⊕ reviewed ⊕ must-fix 숫자 0 ⊕ 그 머리.
  test.each([
    ['warn ⊕ must-fix 0 ⊕ reviewed → land 1', { verdict: 'warn' }, 1, '5'],
    ['warn ⊕ must-fix 1 → land 0', { verdict: 'warn', mustFix: ['x'] }, 0, '6'],
    ['warn ⊕ must-fix unknown → land 0', { verdict: 'warn', mustFix: [1] }, 0, '7'],
    ['pass ⊕ must-fix 0 → land 1 (unchanged)', { verdict: 'pass' }, 1, '8'],
    ['fail → land 0', { verdict: 'fail' }, 0, '9'],
    ['warn ⊕ must-fix 0 but reviewed:false → land 0', { verdict: 'warn', reviewed: false }, 0, 'e'],
  ] as const)('rejudge land: %s', async (_name, over, lands, digit) => {
    // 머리를 사례마다 다르게 — land 의 «주기당 한 번»(모듈 범위 cycle 집합)이 앞 사례의 같은 머리와 겹치지 않게.
    const head = digit.repeat(40);
    const f = fixture();
    f.setHead(head);
    f.onRegate(f.writeRegate(true));
    f.onReview((path) => writeFileSync(path, reviewJson(head, over)));
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    f.setClock('2026-10-11T01:10:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.lands).toHaveLength(lands);
    if (lands === 0) expect(f.decisions().at(-1)).toBe(digit === '6' ? 'repair:would-repair' : 'land:not-landing');
  });

  test('직접 land도 공유 틱 예산을 지키고 실제 시도한 뒤에만 소비한다', async () => {
    const f = fixture();
    const head = '2'.repeat(40);
    f.setHead(head);
    f.onRegate(f.writeRegate(true));
    f.onReview((path) => writeFileSync(path, reviewJson(head)));
    await rejudgeCardOnHead(f.card().id, f.deps());
    f.setClock('2026-10-11T01:10:00.000Z');
    const capped = { max: 0, requested: 0 };
    expect((await rejudgeCardOnHead(f.card().id, { ...f.deps(), landBudget: capped })).at(-1))
      .toMatchObject({ step: 'land', decision: 'tick-cap' });
    expect(f.lands).toHaveLength(0);
    expect(capped.requested).toBe(0);
    const allowed = { max: 1, requested: 0 };
    expect((await rejudgeCardOnHead(f.card().id, { ...f.deps(), landBudget: allowed })).at(-1))
      .toMatchObject({ step: 'land', decision: 'landed' });
    expect(f.lands).toHaveLength(1);
    expect(allowed.requested).toBe(1);
  });

  test('propose-land 가 허용 밖이면 재게이트·land 0(리뷰 재요청만)', async () => {
    const f = fixture();
    f.setHead(B);
    await rejudgeCardOnHead('ta-rj-1', f.deps(['review']));
    expect(f.regateRequests).toEqual([]);
    expect(f.reviewRequests).toHaveLength(1);
    expect(f.decisions()).toEqual(['regate:would-regate', 'review:review-requested']);
  });

  test('review 만 허용된 틱에 B 리뷰를 요청한 뒤 propose-land 를 켜면 다음 틱에 B 재게이트가 정확히 한 번', async () => {
    const f = fixture();
    f.setHead(B);
    await rejudgeCardOnHead('ta-rj-1', f.deps(['review']));
    expect(f.reviewRequests).toHaveLength(1);
    f.setClock('2026-10-11T01:05:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    f.setClock('2026-10-11T01:06:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.regateRequests.map((request) => request.head)).toEqual([B]);
    expect(f.reviewRequests).toHaveLength(1);
  });

  test(`재게이트한 머리가 상한(${REJUDGE_HEAD_CAP})에 닿으면 새 머리는 멈춘다 — 재게이트·리뷰 0 · 사유 줄`, async () => {
    const heads = ['1', '2', '3'].map((d) => d.repeat(40));
    const f = fixture({ regates: heads.map((h) => ({ pr: 30, head: h, at: '2026-10-11T00:30:00.000Z', passed: false, status: 'failed' })) });
    f.setHead(B);
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.regateRequests).toEqual([]);
    expect(f.reviewRequests).toEqual([]);
    expect(f.decisions()).toEqual(['regate:cap-reached']);
    expect(f.card().history.at(-1)).toMatchObject({ event: 'rejudge-on-head', kind: 'regate', effect: 'cap-reached', head: B });
  });

  test('TA-REGATE-UNMEASURED — draft pr-head 거부(unmeasured) 3번은 상한을 소진하지 않는다 · 새 머리는 다시 잰다', async () => {
    const draft = 'pr-head: PR head, base commit, ready state or open state unavailable or changed (state=OPEN · isDraft=true · base=main@x)';
    const heads = ['1', '2', '3'].map((d) => d.repeat(40));
    // 새 결과(status=unmeasured) 둘 ⊕ 옛 결과(noMerge 에 status 없음 · draft 문면) 하나.
    const f = fixture({ regates: heads.map((h, i) => ({ pr: 30, head: h, at: '2026-10-11T00:30:00.000Z', passed: false,
      ...(i < 2 ? { status: 'unmeasured' } : {}), detail: draft })) });
    f.setHead(B);
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.decisions()).not.toContain('regate:cap-reached');
    expect(f.decisions()).toContain('regate:regate-requested');
    expect(f.regateRequests.map((request) => request.head)).toEqual([B]);
  });

  test('TA-REGATE-UNMEASURED — 진짜 실패 3번은 unmeasured 가 섞여도 그대로 상한을 소진한다', async () => {
    const draft = 'pr-head: PR head, base commit, ready state or open state unavailable or changed (state=OPEN · isDraft=true · base=main@x)';
    const failed = ['1', '2', '3'].map((d) => ({ pr: 30, head: d.repeat(40), at: '2026-10-11T00:30:00.000Z', passed: false, status: 'failed', detail: 'typecheck: error TS1' }));
    const unmeasured = ['4', '5'].map((d) => ({ pr: 30, head: d.repeat(40), at: '2026-10-11T00:31:00.000Z', passed: false, status: 'unmeasured', detail: draft }));
    const f = fixture({ regates: [...unmeasured, ...failed] });
    f.setHead(B);
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.regateRequests).toEqual([]);
    expect(f.decisions()).toEqual(['regate:cap-reached']);
    expect(f.logs.find((entry) => entry.event === 'rejudge-on-head')?.data.reason).toContain('re-gated 3 times already (cap 3 · unmeasured 2 not counted)');
  });

  test('TA-REGATE-UNMEASURED — 회수한 결과가 unmeasured 면 regate-failed 가 아니라 regate-unmeasured 로 적는다', async () => {
    const f = fixture();
    f.setHead(B);
    f.onRegate(f.writeRegate(false, { status: 'unmeasured', failures: [{ step: 'pr-head', detail: 'PR head ... (state=OPEN · isDraft=true · base=main@x)' }] }));
    f.onReview((path) => writeFileSync(path, reviewJson(B)));
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.card().regates?.[0]).toMatchObject({ passed: false, status: 'unmeasured' });
    expect(f.decisions()).toContain('regate:regate-unmeasured');
    expect(f.decisions()).not.toContain('regate:regate-failed');
    expect(f.lands).toEqual([]);
  });

  test('TA-REGATE-UNMEASURED — 회수한 결과가 진짜 실패(status=failed)면 regate-failed 그대로', async () => {
    const f = fixture();
    f.setHead(B);
    f.onRegate(f.writeRegate(false));
    f.onReview((path) => writeFileSync(path, reviewJson(B)));
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.decisions()).toContain('regate:regate-failed');
    expect(f.decisions()).not.toContain('regate:regate-unmeasured');
  });

  test('regateUnmeasured — status unmeasured ⊕ 옛 draft 문면만 · 통과·진짜 실패·결과 없음은 아니다', () => {
    expect(regateUnmeasured({ passed: false, status: 'unmeasured' })).toBe(true);
    expect(regateUnmeasured({ passed: false, detail: 'pr-head: x (state=OPEN · isDraft=true · base=main@y)' })).toBe(true);
    expect(regateUnmeasured({ passed: false, status: 'failed', detail: 'typecheck: error' })).toBe(false);
    expect(regateUnmeasured({ passed: false, status: 'no-result' })).toBe(false);
    expect(regateUnmeasured({ passed: true, status: 'unmeasured' })).toBe(false);
    expect(regateUnmeasured({ passed: undefined })).toBe(false);
  });

  test('상한은 잠금 안에서 다시 잰다 — 판단 뒤 다른 틱이 머리를 채웠으면 claim 하지 않는다', async () => {
    const heads = ['1', '2'].map((d) => d.repeat(40));
    const f = fixture({ regates: heads.map((h) => ({ pr: 30, head: h, at: '2026-10-11T00:30:00.000Z', passed: false, status: 'failed' })) });
    f.setHead(B);
    const deps = f.deps();
    // 판단은 2개를 봤지만(카드·regates 스냅숏은 gh 조회 «전»에 읽는다), gh 조회 사이 다른 틱이 세 번째 머리를 claim 했다.
    let ghLookups = 0;
    const prHead = deps.live.prHead;
    deps.live.prHead = async () => {
      ghLookups++;
      writeTaskCards(f.statePath, [{ ...f.card(), regates: [...f.card().regates!, { pr: 30, head: '9'.repeat(40), at: '2026-10-11T00:59:00.000Z' }] }]);
      deps.live.prHead = prHead;
      return prHead();
    };
    await rejudgeCardOnHead('ta-rj-1', deps);
    expect(f.regateRequests).toEqual([]);
    expect(ghLookups).toBe(1);
    expect(f.card().regates).toHaveLength(3);
    expect(f.decisions()).toEqual(['regate:cap-reached']);
    // 잠금 밖 검사(스냅숏 2개)는 통과했고 잠금 안 재검사가 막았다 — 사유가 그 경로를 말한다.
    expect(f.logs.find((entry) => entry.event === 'rejudge-on-head')?.data.reason).toContain('claim-time recheck');
    expect(f.card().history.at(-1)).toMatchObject({ event: 'rejudge-on-head', kind: 'regate', effect: 'cap-reached' });
  });

  test('재게이트 결과가 상한 시간 안에 안 오면 «결과 없음» 실패로 적고 land 0', async () => {
    const f = fixture();
    f.setHead(B);
    f.onReview((path) => writeFileSync(path, reviewJson(B)));
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    f.setClock('2026-10-11T02:31:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.card().regates?.[0]).toMatchObject({ passed: false, status: 'no-result' });
    expect(f.lands).toEqual([]);
  });

  test('카드 PR 에 URL 이 없으면 gh·재게이트·리뷰 0', async () => {
    const f = fixture();
    writeTaskCards(f.statePath, [{ ...f.card(), pr: 30 }]);
    f.setHead(B);
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.regateRequests).toEqual([]);
    expect(f.reviewRequests).toEqual([]);
    expect(f.decisions()).toEqual(['target:pr-url-unknown']);
  });

  test('parseRegateResult — 모양이 틀린 칸(baseCommit 숫자 등)은 결과로 받지 않는다', () => {
    expect(parseRegateResult(JSON.stringify({ pr: 30, head: B, passed: true, baseCommit: 7 }), 30, B)).toBeNull();
    expect(parseRegateResult(JSON.stringify({ pr: 30, head: B, passed: true, failures: [1] }), 30, B)).toBeNull();
    expect(parseRegateResult(JSON.stringify({ pr: 30, head: B, passed: true, baseCommit: BASE }), 30, B)).toMatchObject({ passed: true, baseCommit: BASE });
    expect(parseRegateResult(JSON.stringify({ pr: 31, head: B, passed: true }), 30, B)).toBeNull();
  });

  test('대상 — 묶인 PR 로 TA 리뷰를 요청한 카드만', () => {
    const f = fixture();
    const card = f.card();
    expect(rejudgeCandidates({ [card.id]: card, other: { ...card, id: 'other', reviewRequests: [] } })).toEqual(['ta-rj-1']);
  });

  test('주기 후보는 72시간 넘긴 카드를 로그 콜백으로 건너뛰고 mf0·새 카드 순으로 돈다', () => {
    const f = fixture();
    const now = new Date('2026-10-19T00:00:00.000Z');
    const base = { ...f.card(), createdAt: '2026-10-18T00:00:00.000Z' };
    const card = (id: string, pr: number, createdAt: string, mf0 = false): TaskCard => ({ ...base, id, createdAt,
      pr: { number: pr, url: `https://github.com/o/r/pull/${pr}` },
      reviewRequests: [{ pr, head: A, at: createdAt }], history: mf0 ? [{ at: createdAt, event: 'live-move-result', kind: 'review',
        pr, head: A, verdict: 'pass', reviewed: true, mustFix: 0, effect: 'review result captured' }] : [] });
    const old = card('old', 31, '2026-10-15T00:00:00.000Z');
    const fresh = card('fresh', 32, '2026-10-18T23:00:00.000Z');
    const ready = card('ready', 33, '2026-10-18T12:00:00.000Z', true);
    const boundary = card('boundary', 34, '2026-10-16T00:00:00.000Z');
    const skipped: string[] = [];
    expect(rejudgeCandidates({ old, fresh, ready, boundary }, { now, maxAgeHours: 72, currentHeads: new Map([['ready', A]]),
      onAgeSkip: (item) => skipped.push(item.id) }))
      .toEqual(['ready', 'fresh', 'boundary']);
    expect(skipped).toEqual(['old']);
    expect(rejudgeCandidates({ fresh, ready }, { now, currentHeads: new Map([['ready', B]]) })).toEqual(['fresh', 'ready']);
  });

  test('MERGED/CLOSED bound PR is recorded once and excluded from future ticks', async () => {
    for (const state of ['MERGED', 'CLOSED'] as const) {
      const f = fixture();
      const deps = { ...f.deps(), live: { ...f.deps().live, prHead: async () => ({ head: B, state, url: URL }) } };
      expect((await rejudgeCardOnHead(f.card().id, deps)).at(-1)?.decision).toBe('pr-not-open');
      const first = f.card().prTerminal;
      expect(first).toMatchObject({ pr: 30, url: URL, head: B, state, at: '2026-10-11T01:00:00.000Z' });
      expect(rejudgeCandidates({ [f.card().id]: f.card() })).toEqual([]);
      f.setClock('2026-10-11T02:00:00.000Z');
      await rejudgeCardOnHead(f.card().id, deps);
      expect(f.card().prTerminal).toEqual(first);
      expect(f.regateRequests).toHaveLength(0);
      expect(f.reviewRequests).toHaveLength(0);
      expect(f.lands).toHaveLength(0);
    }
  });

  test('verified train closes a component card once without a new repair or regate', async () => {
    const f = fixture();
    // A run-bound component can be train-landed even when its older card has no taLand flag.
    const oldTerminal = { pr: 30, url: URL, head: B, state: 'CLOSED' as const, at: '2026-10-11T00:30:00.000Z' };
    writeTaskCards(f.statePath, [{ ...f.card(), prTerminal: oldTerminal }]);
    let observedHead = B;
    const deps = { ...f.deps(), trainLanding: () => ({ componentPr: 30, integrationPr: 91, mergeSha: BASE, train: 'c2' }),
      live: { ...f.deps().live, prHead: async () => ({ head: observedHead, state: 'CLOSED', url: URL }) } };
    expect((await rejudgeCardOnHead(f.card().id, deps)).at(-1)?.decision).toBe('landed-via-train');
    expect(f.card()).toMatchObject({ status: 'done', trainLanding: { componentPr: 30, integrationPr: 91, mergeSha: BASE },
      prTerminal: { state: 'CLOSED' } });
    expect(f.card().prTerminal).toEqual(oldTerminal);
    expect(f.card().history.filter((entry) => entry.event === 'landed-via-train')).toHaveLength(1);
    await rejudgeCardOnHead(f.card().id, deps);
    expect(f.card().history.filter((entry) => entry.event === 'landed-via-train')).toHaveLength(1);
    observedHead = BASE;
    await rejudgeCardOnHead(f.card().id, deps);
    expect(f.card().history.filter((entry) => entry.event === 'landed-via-train')).toHaveLength(1);
    expect(f.card().prTerminal?.head).toBe(BASE);
    expect(rejudgeCandidates({ [f.card().id]: f.card() })).toEqual([]);
    expect(f.regateRequests).toHaveLength(0);
    expect(f.reviewRequests).toHaveLength(0);
    expect(f.lands).toHaveLength(0);
  });

  test('an unreviewed CLOSED PR without train proof keeps the old start guard', async () => {
    const f = fixture();
    writeTaskCards(f.statePath, [{ ...f.card(), reviewRequests: [], history: [] }]);
    const deps = { ...f.deps(), trainLanding: () => null,
      live: { ...f.deps().live, prHead: async () => ({ head: B, state: 'CLOSED', url: URL }) } };
    expect((await rejudgeCardOnHead(f.card().id, deps)).at(-1)?.decision).toBe('not-started');
    expect(f.card().prTerminal).toBeUndefined();
    expect(f.card().status).toBe('launched');
    expect(f.regateRequests).toHaveLength(0);
  });

  test('terminal marker applies only to its exact binding; explicit rejudge clears it after reopen', async () => {
    const f = fixture();
    const terminal = { pr: 30, url: URL, head: A, state: 'CLOSED' as const, at: '2026-10-11T00:30:00.000Z' };
    writeTaskCards(f.statePath, [{ ...f.card(), prTerminal: terminal }]);
    expect(rejudgeCandidates({ [f.card().id]: f.card() })).toEqual([]);
    const reopened = { ...f.deps(), live: { ...f.deps().live, prHead: async () => ({ head: A, state: 'OPEN', url: URL }) } };
    await rejudgeCardOnHead(f.card().id, reopened);
    expect(f.card().prTerminal).toBeUndefined();
    expect(rejudgeCandidates({ [f.card().id]: f.card() })).toEqual([f.card().id]);

    writeTaskCards(f.statePath, [{ ...f.card(), pr: { number: 31, url: 'https://github.com/o/r/pull/31' }, prTerminal: terminal,
      reviewRequests: [{ pr: 31, head: A, at: '2026-10-11T00:10:00.000Z' }] }]);
    expect(rejudgeCandidates({ [f.card().id]: f.card() })).toEqual([f.card().id]);
  });

  test('liveLandArgs — 증거가 있으면 --overlap-evidence <file> · 없으면 종전 인자 그대로', () => {
    const base = liveLandArgs('/e/bin/elanous.mjs', '/u', 30, B, '/repo');
    expect(base).toEqual(['/e/bin/elanous.mjs', '--config-dir', '/u', 'pr', 'land', '--cwd', '/repo', '--pr', '30', '--expected-head', B]);
    expect(liveLandArgs('/e/bin/elanous.mjs', '/u', 30, B, '/repo', '/s/overlap-evidence/x.json')).toEqual([...base, '--overlap-evidence', '/s/overlap-evidence/x.json']);
  });

  const NEW_HEAD = 'ab'.repeat(20);
  const catchUpLog = (f: ReturnType<typeof fixture>) => f.logs.filter((entry) => entry.event === 'rejudge-on-head' && entry.data.step === 'catch-up').at(-1)?.data;

  test('catch-up — 같은 base 재게이트 → merge·push 1회 → 새 머리 재게이트 요청', async () => {
    const f = fixture();
    const H = '48'.repeat(20);
    await readyB(f, H);
    f.queueLand(STALE_LAND);
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    f.onRegate(f.writeRegate(true, { baseCommit: BASE }));
    f.setClock('2026-10-11T01:20:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    f.onCatchUp(async (request) => {
      f.setHead(NEW_HEAD);
      return { decision: 'pushed', reason: 'merged origin/main', fromBase: request.fromBase, toBase: BASE2, newHead: NEW_HEAD, pushArgs: ['push', 'origin', 'HEAD:feature'] };
    });
    f.setClock('2026-10-11T01:30:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.catchUpRequests).toHaveLength(1);
    expect(['push', 'origin', 'HEAD:feature']).not.toContain('--force');
    expect(catchUpLog(f)).toMatchObject({ step: 'catch-up', decision: 'pushed', fromBase: BASE, toBase: BASE2, newHead: NEW_HEAD });
    expect(f.lands).toHaveLength(1);
    f.onRegate(f.writeRegate(true, { baseCommit: BASE2 }));
    f.onReview((path) => writeFileSync(path, reviewJson(NEW_HEAD)));
    f.setClock('2026-10-11T01:40:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.regateRequests.map((request) => request.head)).toEqual([H, H, NEW_HEAD]);
    expect(f.decisions()).toContain('regate:regate-requested');
    expect(f.regateRequests[2]!.resultPath).toBe(regateResultPath(f.statePath, 'ta-rj-1', 30, NEW_HEAD));
  });

  test('catch-up — stale 재게이트에 baseCommit 없음 → 같은 길(merge·push)', async () => {
    const H = '49'.repeat(20);
    const f = fixture({
      regates: [{ pr: 30, head: H, at: '2026-10-11T00:40:00.000Z', passed: true, status: 'passed' }],
      landAttempts: [{ pr: 30, head: H, at: '2026-10-11T00:50:00.000Z', ok: false, detail: STALE_LAND.stderr, class: 'base-stale', reason: 'base-stale-overlap: gate x' }],
    });
    f.setHead(H);
    f.onCatchUp(async (request) => ({
      decision: 'pushed', reason: 'merged origin/main', fromBase: request.fromBase, toBase: BASE2, newHead: NEW_HEAD, pushArgs: ['push', 'origin', 'HEAD:feature'],
    }));
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.regateRequests).toEqual([]);
    expect(f.catchUpRequests).toHaveLength(1);
    expect(f.catchUpRequests[0]).toMatchObject({ head: H, branch: 'feature' });
    expect(f.catchUpRequests[0]!.fromBase).toBeUndefined();
    expect(catchUpLog(f)).toMatchObject({ step: 'catch-up', decision: 'pushed', toBase: BASE2, newHead: NEW_HEAD });
    expect(f.lands).toEqual([]);
  });

  test('catch-up — merge 충돌 → abort ⊕ needs-owner', async () => {
    const f = fixture();
    const H = '4a'.repeat(20);
    await readyB(f, H);
    f.queueLand(STALE_LAND);
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    f.onRegate(f.writeRegate(true, { baseCommit: BASE }));
    f.setClock('2026-10-11T01:20:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    f.onCatchUp(async (request) => ({
      decision: 'conflict', reason: 'main 따라잡기 충돌 · 파일 src/x.ts', fromBase: request.fromBase, toBase: BASE2, files: ['src/x.ts'],
    }));
    f.setClock('2026-10-11T01:30:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.catchUpRequests).toHaveLength(1);
    expect(f.lands).toHaveLength(1);
    expect(f.regateRequests).toHaveLength(2);
    expect(catchUpLog(f)).toMatchObject({ step: 'catch-up', decision: 'conflict', fromBase: BASE, toBase: BASE2 });
    expect(lastReason(f)).toContain('main 따라잡기 충돌 · 파일 src/x.ts');
    expect(f.card().history.at(-1)).toMatchObject({ event: 'rejudge-on-head', kind: 'catch-up', effect: 'conflict' });
  });

  test(`catch-up — N(${CATCH_UP_CAP}) 회 뒤 cap-reached`, async () => {
    const H = '4b'.repeat(20);
    const pathH = reviewResultPath(join(mkdtempSync(join(tmpdir(), 'ta-rejudge-cap-')), 'x'), 'ta-rj-1', 30, H);
    const f = fixture({
      regates: [{ pr: 30, head: H, at: '2026-10-11T00:40:00.000Z', passed: true, status: 'passed', baseCommit: BASE, staleBase: BASE }],
    });
    mkdirSync(dirname(pathH), { recursive: true });
    writeFileSync(pathH, reviewJson(H));
    const prior = Array.from({ length: CATCH_UP_CAP }, (_, i) => ({
      at: `2026-10-11T00:5${i}:00.000Z`, event: 'rejudge-on-head' as const, kind: 'catch-up', pr: 30, head: `${i}`.repeat(40), effect: 'pushed', detail: 'prior',
    }));
    writeTaskCards(f.statePath, [{
      ...f.card(),
      reviewRequests: [...(f.card().reviewRequests ?? []), { pr: 30, head: H, at: '2026-10-11T00:45:00.000Z', resultPath: pathH }],
      history: [
        ...f.card().history,
        { at: '2026-10-11T00:46:00.000Z', event: 'live-move-result', kind: 'review', pr: 30, head: H, verdict: 'pass', reviewed: true, mustFix: 0, reviewRoute: 'api', resultPath: pathH, effect: 'review result captured · verdict pass · reviewed true · must-fix 0' },
        ...prior,
      ],
    }]);
    f.setHead(H);
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.catchUpRequests).toEqual([]);
    expect(f.regateRequests).toEqual([]);
    expect(f.lands).toEqual([]);
    expect(f.decisions().at(-1)).toBe('catch-up:cap-reached');
    expect(catchUpLog(f)).toMatchObject({ step: 'catch-up', decision: 'cap-reached', fromBase: BASE });
  });

  test('catch-up — 상한은 «실제 push» 만 센다(충돌 ⊕ cap-reached 표지 뒤 새 머리는 다시 시도)', async () => {
    // 옛 머리 X 에서 충돌 → 다음 틱 같은 머리 «already catch-up» cap-reached 표지 → 사람이 새 머리 H 를 올렸다.
    const H = '4c'.repeat(20);
    const X = '4d'.repeat(20);
    const pathH = reviewResultPath(join(mkdtempSync(join(tmpdir(), 'ta-rejudge-cap-attempt-')), 'x'), 'ta-rj-1', 30, H);
    const f = fixture({
      regates: [{ pr: 30, head: H, at: '2026-10-11T00:40:00.000Z', passed: true, status: 'passed', baseCommit: BASE, staleBase: BASE }],
    });
    mkdirSync(dirname(pathH), { recursive: true });
    writeFileSync(pathH, reviewJson(H));
    writeTaskCards(f.statePath, [{
      ...f.card(),
      reviewRequests: [...(f.card().reviewRequests ?? []), { pr: 30, head: H, at: '2026-10-11T00:45:00.000Z', resultPath: pathH }],
      history: [
        ...f.card().history,
        { at: '2026-10-11T00:46:00.000Z', event: 'live-move-result', kind: 'review', pr: 30, head: H, verdict: 'pass', reviewed: true, mustFix: 0, reviewRoute: 'api', resultPath: pathH, effect: 'review result captured · verdict pass · reviewed true · must-fix 0' },
        { at: '2026-10-11T00:30:00.000Z', event: 'rejudge-on-head' as const, kind: 'catch-up', pr: 30, head: X, effect: 'conflict', detail: 'main 따라잡기 충돌 · 파일 src/x.ts' },
        { at: '2026-10-11T00:35:00.000Z', event: 'rejudge-on-head' as const, kind: 'catch-up', pr: 30, head: X, effect: 'cap-reached', detail: 'already catch-up on this head — needs owner' },
      ],
    }]);
    f.setHead(H);
    f.onCatchUp(async (request) => ({
      decision: 'pushed', reason: 'merged origin/main', fromBase: request.fromBase, toBase: BASE2, newHead: NEW_HEAD, pushArgs: ['push', 'origin', 'HEAD:feature'],
    }));
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.catchUpRequests).toHaveLength(1);
    expect(f.catchUpRequests[0]).toMatchObject({ head: H });
    expect(catchUpLog(f)).toMatchObject({ step: 'catch-up', decision: 'pushed', newHead: NEW_HEAD });
  });

  test('catch-up — push 인자에 --force 0', async () => {
    const calls: string[][] = [];
    const work = '/tmp/ta-catch-up-wt';
    const git: CatchUpGit = (cwd, args) => {
      calls.push([cwd, ...args]);
      if (args[0] === 'fetch' && args[2] === 'refs/heads/main') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'fetch' && args[2]?.startsWith('pull/')) return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'rev-parse' && args[1] === 'FETCH_HEAD') {
        const prev = calls.at(-2)?.slice(1).join(' ') ?? '';
        return { status: 0, stdout: prev.includes('refs/heads/main') ? BASE2 : B, stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'add') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'config') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'merge' && args[1] === '--no-ff') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { status: 0, stdout: NEW_HEAD, stderr: '' };
      if (args[0] === 'push') return { status: 0, stdout: 'ok', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'remove') return { status: 0, stdout: '', stderr: '' };
      return { status: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
    };
    const result = await defaultCatchUpMain({ cwd: '/repo', pr: 30, head: B, branch: 'feature', fromBase: BASE, worktreePath: work }, git);
    expect(result).toMatchObject({ decision: 'pushed', fromBase: BASE, toBase: BASE2, newHead: NEW_HEAD });
    expect(result.pushArgs).toEqual(['push', 'origin', 'HEAD:feature']);
    expect(result.pushArgs?.includes('--force') || result.pushArgs?.includes('-f')).toBeFalsy();
    const push = calls.find((entry) => entry[1] === 'push');
    expect(push).toEqual([work, 'push', 'origin', 'HEAD:feature']);
    expect(push?.includes('--force') || push?.includes('-f')).toBeFalsy();
    expect(calls.some((entry) => entry.includes('rebase') || entry.includes('reset') || entry.includes('--force-with-lease'))).toBe(false);
    expect(calls.some((entry) => entry[1] === 'config' && entry[2] === 'rerere.enabled')).toBe(true);
    expect(calls.some((entry) => entry[1] === 'merge' && entry[2] === '--no-ff')).toBe(true);
  });

  test('catch-up — defaultCatchUpMain 충돌이면 merge --abort ⊕ 파일 목록', async () => {
    const calls: string[][] = [];
    const work = '/tmp/ta-catch-up-conflict';
    const git: CatchUpGit = (_cwd, args) => {
      calls.push(args);
      if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'rev-parse' && args[1] === 'FETCH_HEAD') {
        const prev = calls.at(-2)?.join(' ') ?? '';
        return { status: 0, stdout: prev.includes('refs/heads/main') ? BASE2 : B, stderr: '' };
      }
      if (args[0] === 'worktree') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'config') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'merge' && args[1] === '--no-ff') return { status: 1, stdout: '', stderr: 'CONFLICT' };
      if (args[0] === 'diff') return { status: 0, stdout: 'src/x.ts\nsrc/y.ts\n', stderr: '' };
      if (args[0] === 'merge' && args[1] === '--abort') return { status: 0, stdout: '', stderr: '' };
      return { status: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
    };
    const result = await defaultCatchUpMain({ cwd: '/repo', pr: 30, head: B, branch: 'feature', fromBase: BASE, worktreePath: work }, git);
    expect(result).toMatchObject({ decision: 'conflict', fromBase: BASE, toBase: BASE2, files: ['src/x.ts', 'src/y.ts'] });
    expect(result.reason).toBe('main 따라잡기 충돌 · 파일 src/x.ts, src/y.ts');
    expect(calls.some((entry) => entry[0] === 'merge' && entry[1] === '--abort')).toBe(true);
    expect(calls.some((entry) => entry[0] === 'push')).toBe(false);
  });

  test('defaultRequestRegate — 같은 우주·진입점의 `tasks regate-run` 을 PR 저장소에서 떼어 띄운다(stdio ignore)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ta-rejudge-spawn-'));
    const seen: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    const fakeSpawn = ((command: string, args: string[], options: Record<string, unknown>) => {
      seen.push({ command, args, options });
      return { pid: 7, once: (event: string, listener: () => void) => { if (event === 'spawn') queueMicrotask(listener); return undefined; }, removeListener: () => undefined, unref: () => undefined };
    }) as unknown as import('../cli/tasks-cli.js').DetachedSpawn;
    const request = { card: 'ta-rj-1', pr: 30, head: B, repoRoot: dir, resultPath: join(dir, 'regate-results', 'x.json') };
    await defaultRequestRegate(request, { spawn: fakeSpawn, entry: '/e/bin/elanous.mjs', configDir: '/u' });
    expect(seen).toEqual([{ command: process.execPath, args: regateRunArgs('/e/bin/elanous.mjs', '/u', request), options: { detached: true, stdio: 'ignore', cwd: dir } }]);
    expect(regateRunArgs('/e/bin/elanous.mjs', '/u', request)).toEqual(['/e/bin/elanous.mjs', '--config-dir', '/u', 'tasks', 'regate-run', '--card', 'ta-rj-1', '--pr', '30', '--head', B, '--repo', dir, '--out', request.resultPath]);
  });

  test('defaultRequestRegate runs on node-b and streams its JSON into the HQ result path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ta-remote-regate-'));
    const worker = join(dir, 'fake-eln');
    writeFileSync(worker, `#!/bin/sh\nout=\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = --out ]; then shift; out="$1"; fi\n  shift\ndone\nprintf '%s\\n' '{"pr":30,"head":"${B}","passed":true,"status":"passed","baseCommit":"${BASE}","failures":[]}' > "$out"\nprintf '%s\\n' 'worker progress must not reach result JSON'\n`);
    chmodSync(worker, 0o755);
    const seen: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    const fakeSpawn = ((command: string, args: string[], options: Record<string, unknown>) => {
      seen.push({ command, args, options });
      const run = spawnSync('sh', ['-c', args[6]!], { stdio: options.stdio as never });
      expect(run.status).toBe(0);
      return { pid: 7, once: (event: string, listener: () => void) => { if (event === 'spawn') queueMicrotask(listener); return undefined; }, removeListener: () => undefined, unref: () => undefined };
    }) as unknown as import('../cli/tasks-cli.js').DetachedSpawn;
    const request = { card: 'ta-rj-1', pr: 30, head: B, repoRoot: '/hq/repo', resultPath: join(dir, 'regate-results', 'x.json') };
    await defaultRequestRegate(request, { spawn: fakeSpawn, remote: { host: 'node-b', cwd: dir, elanous: worker, configDir: dir } });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.command).toBe('ssh');
    expect(seen[0]!.args.slice(0, 5)).toEqual(['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5']);
    expect(seen[0]!.args[5]).toBe('node-b');
    expect(seen[0]!.args[6]).toContain(`--repo ${dir} --out /tmp/elanous-ta-regate-`);
    expect(seen[0]!.options.stdio).toEqual(['ignore', expect.any(Number), 'ignore']);
    expect(parseRegateResult(readFileSync(request.resultPath, 'utf8'), 30, B)).toMatchObject({ passed: true, baseCommit: BASE });
  });
});
