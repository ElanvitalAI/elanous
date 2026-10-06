import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { readFailureInbox } from './heal-intake.js';
import { runSelfImplement } from './orchestrator.js';
import { seams } from './test-seams.js';

const roots: string[] = [];
function isolatedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'heal-harness-wire-'));
  roots.push(root);
  setElanousConfigDir(root);
  return root;
}
afterEach(() => {
  resetElanousConfigDir();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('terminal gate failure writes one harness-run line with stage, runId and first goal line; a repeated run folds', async () => {
  const root = isolatedRoot();
  const options = { feature: 'Repair the gate\nmore context', runId: 'heal-gate-run', memory: false, maxReworkRounds: 0,
    seams: seams({ gateResults: [false] }) };
  const first = await runSelfImplement(options);
  expect(first).toMatchObject({ ok: false, stage: 'gate-failed', runId: options.runId });
  await runSelfImplement({ ...options, seams: seams({ gateResults: [false] }) });
  expect(readFailureInbox({}, root)).toEqual([{
    source: 'harness-run', kind: 'gate-failed', ref: options.runId, summary: 'Repair the gate', at: expect.any(String),
  }]);
});

test('successful run and cancelled PR leave the heal inbox empty', async () => {
  const root = isolatedRoot();
  const success = await runSelfImplement({ feature: 'Complete the goal', runId: 'heal-success', memory: false,
    completion: 'worktree-only', seams: seams({}) });
  const cancelled = await runSelfImplement({ feature: 'Decline a PR', runId: 'heal-cancelled', memory: false,
    seams: seams({ approvePr: async () => false }) });
  expect(success).toMatchObject({ ok: true, stage: 'worktree-completed' });
  expect(cancelled.stage).toBe('pr-declined');
  expect(readFailureInbox({}, root)).toEqual([]);
});

test('a supervisor-blocked review reaches the inbox with its terminal stage', async () => {
  const root = isolatedRoot();
  const s = seams({ gateResults: [true, true] });
  s.reviewDiff = async () => ({ verdict: 'fail', mustFix: ['fix this'], shouldFix: [], summary: 'blocked', reviewed: true });
  s.diagnose = async () => 'BUDGET: UNCONVERGEABLE\nREASON: finding did not converge';
  const result = await runSelfImplement({ feature: 'Fix the review', runId: 'heal-review', memory: false,
    maxReworkRounds: 0, reworkBudgetShadowStop: false, seams: s });
  expect(result.stage).toBe('review-blocked');
  expect(readFailureInbox({}, root).map(({ source, kind, ref, summary }) => ({ source, kind, ref, summary }))).toEqual([
    { source: 'harness-run', kind: 'review-blocked', ref: 'heal-review', summary: 'Fix the review' },
  ]);
});

test('timeout and an uncaught crash each reach the terminal inbox once', async () => {
  const root = isolatedRoot();
  const timeout = await runSelfImplement({ feature: 'Timeout goal', runId: 'heal-timeout', memory: false,
    stepTimeouts: { gate: 5 }, seams: seams({ gate: () => new Promise(() => {}) }) });
  const failure = new Error('unexpected child crash');
  await expect(runSelfImplement({ feature: 'Crash goal', runId: 'heal-crash', memory: false,
    seams: seams({ implement: async () => { throw failure; } }) })).rejects.toBe(failure);
  expect(timeout.stage).toBe('timed-out');
  expect(readFailureInbox({}, root).map(({ source, kind, ref, summary }) => ({ source, kind, ref, summary }))).toEqual([
    { source: 'harness-run', kind: 'timed-out', ref: 'heal-timeout', summary: 'Timeout goal' },
    { source: 'harness-run', kind: 'crashed', ref: 'heal-crash', summary: 'Crash goal' },
  ]);
});

test('a run that spends maxRework and stops on a draft PR records one failure and one heal classification', async () => {
  const root = isolatedRoot();
  const result = await runSelfImplement({
    feature: 'POD7 gate introduced stays in another file',
    runId: 'heal-rework-cap',
    memory: false,
    maxReworkRounds: 0,
    seams: seams({
      gate: async () => ({
        passed: true,
        log: 'gate named introduced 1 outside the child diff',
        reflectGateFacts: { introduced: 1, preexisting: 0, unknown: 0 },
      }),
      reviewDiff: async () => ({
        verdict: 'fail',
        mustFix: ['src/other.ts still fails and the child never opened it'],
        shouldFix: [],
        summary: 'introduced stays',
        reviewed: true,
      }),
      diagnose: async () => 'BUDGET: SUFFICIENT\\nREASON: cap reached',
    }),
  });
  expect(result).toMatchObject({
    stage: 'pr-opened',
    outcome: 'completed',
    ok: true,
    runId: 'heal-rework-cap',
  });
  const inbox = readFailureInbox({}, root);
  expect(inbox).toHaveLength(1);
  expect(inbox[0]).toMatchObject({
    source: 'harness-run',
    kind: 'rework-cap-exhausted',
    ref: 'heal-rework-cap',
  });
  expect(inbox[0]!.summary).toContain('code-defect');
  expect(inbox[0]!.summary).toContain('relaunch');
  expect(inbox[0]!.summary).toContain('gate introduced: introduced=1');
  expect(inbox[0]!.summary).toContain('review must-fix: src/other.ts still fails and the child never opened it');
  const heal = debug.events(200).filter(entry => entry.category === 'self-implement'
    && entry.event === 'rework-cap-heal'
    && (entry.data as { runId?: string }).runId === 'heal-rework-cap');
  expect(heal).toHaveLength(1);
  expect(heal[0]!.data).toMatchObject({
    defectClass: 'code-defect',
    nextAction: 'relaunch',
    evidence: [
      'gate introduced: introduced=1',
      'review must-fix: src/other.ts still fails and the child never opened it',
    ],
  });
});

test('failed heal write logs one error and cannot change the terminal result', async () => {
  const root = isolatedRoot();
  writeFileSync(join(root, 'heal'), 'not a directory');
  const result = await runSelfImplement({ feature: 'Keep failure result', runId: 'heal-write-fails', memory: false,
    maxReworkRounds: 0, seams: seams({ gateResults: [false] }) });
  expect(result).toMatchObject({ ok: false, stage: 'gate-failed', outcome: 'budget-exhausted', runId: 'heal-write-fails' });
  expect(debug.events(100).filter(entry => entry.category === 'self-implement' && entry.event === 'heal-intake-record-failed'
    && (entry.data as { runId?: string }).runId === 'heal-write-fails')).toHaveLength(1);
});
