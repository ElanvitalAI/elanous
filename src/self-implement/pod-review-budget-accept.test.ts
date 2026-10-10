import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { runSelfImplement } from './orchestrator.js';
import { classifyPodReviewBudgetResidue } from './review-finding-recurrence.js';
import { seams } from './test-seams.js';
import { repairInputsFromBody } from '../harness/helper-repair.js';

const f = (id: string, item: string) => ({ id, item });
const a = '`Foo.bar()` is missing a guard';
const aReworded = 'The guard for `Foo.bar()` is still absent';
const b = '`Other.run()` must be checked';
const c = '`New.path()` must be checked';

test('residue compares prior ids or nonempty keys, with no previous round remaining unmeasured', () => {
  expect(classifyPodReviewBudgetResidue([f('A2', aReworded), f('B', b)], [f('A', a), f('B', b)])).toEqual({
    status: 'all-repeated', repeatedIds: ['A2', 'B'], newIds: [], keyOnlyRepeatedIds: ['A2'],
  });
  expect(classifyPodReviewBudgetResidue([f('A', a), f('C', c)], [f('A', a)])).toEqual({
    status: 'has-new', repeatedIds: ['A'], newIds: ['C'], keyOnlyRepeatedIds: [],
  });
  expect(classifyPodReviewBudgetResidue([f('A', a)], undefined).status).toBe('unmeasured');
  expect(classifyPodReviewBudgetResidue([f('A', a)], []).status).toBe('unmeasured');
  expect(classifyPodReviewBudgetResidue([f('new', '\t')], [f('old', '  ')])).toEqual({
    status: 'has-new', repeatedIds: [], newIds: ['new'], keyOnlyRepeatedIds: [],
  });
});

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};

async function runPod(reviews: string[][], gatePassed = true) {
  const root = mkdtempSync(join(tmpdir(), 'pod-budget-'));
  const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
  const opened: Array<{ draft?: boolean; body: string }> = [];
  const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
  let mergeCalls = 0;
  const off = debug.registerSink({ name: `pod-budget-${root}`, emit: ({ category, event, data }) => {
    if (category === 'self-implement.review-budget' && event === 'pod-accept-decision') {
      events.push({ category, event, data: data as Record<string, unknown> });
    }
  } });
  const prior = process.env.ELANOUS_SUBSTRATE;
  process.env.ELANOUS_SUBSTRATE = 'pod';
  try {
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    writeFileSync(join(root, 'README.md'), 'base\n');
    git(root, 'add', 'README.md');
    git(root, 'commit', '-m', 'base');
    git(root, 'checkout', '-b', 'test/pod-budget');
    let index = 0;
    const result = await runSelfImplement({
      feature: 'Fix the target', maxReworkRounds: reviews.length - 1, memory: false, autoMerge: true,
      seams: seams({
        createWorktree: async () => ({ path: root, branch: 'test/pod-budget', resolvedBase: git(root, 'rev-parse', 'main') }),
        implement: async () => {
          writeFileSync(join(root, 'change.ts'), 'export const fixed = true;\n');
          return { ok: true, summary: 'implemented' };
        },
        changedFilesForGateRoute: () => ['change.ts'],
        gate: async () => ({ passed: gatePassed, log: gatePassed ? 'ok' : 'failed' }),
        reviewDiff: async () => ({ verdict: 'fail', mustFix: reviews[Math.min(index++, reviews.length - 1)]!, shouldFix: [], reviewed: true, summary: 'blocked' }),
        preservationHasChanges: () => true,
        writeRunLedger: (entry) => { ledger.push({ event: entry.event, data: entry.data as Record<string, unknown> }); },
        mergePr: async () => { mergeCalls += 1; return { merged: true }; },
        openPr: async (input) => {
          opened.push({ draft: input.draft, body: input.body });
          return { url: 'https://example.test/pr/7', number: 7 };
        },
      }),
    });
    return { result, opened, events, ledger, mergeCalls };
  } finally {
    off();
    if (prior === undefined) delete process.env.ELANOUS_SUBSTRATE;
    else process.env.ELANOUS_SUBSTRATE = prior;
    rmSync(root, { recursive: true, force: true });
  }
}

test('Pod repeated residue accepts gate-passing review budget with non-draft follow-up, HITL merge decision and no merge', async () => {
  const { result, opened, events, ledger, mergeCalls } = await runPod([[a], [a]]);
  expect(result).toMatchObject({ ok: true, stage: 'pr-opened', mergeReason: 'review-budget-follow-up-required', followUpMustFix: [a], followUpMustFixCount: 1 });
  expect(opened).toHaveLength(1);
  expect(opened[0]!.draft).toBe(false);
  expect(opened[0]!.body).toContain(`## Follow-up must-fix (1)\n- [repeated] ${a}`);
  expect(events).toContainEqual(expect.objectContaining({ event: 'pod-accept-decision', data: expect.objectContaining({ runId: result.runId, status: 'all-repeated', repeatedCount: 1, newCount: 0, keyOnlyRepeatedCount: 0, accepted: true, merge: 'hitl' }) }));
  // OP 18:1x (a): acceptance never auto-merges — the merge decision is hitl even with autoMerge on.
  expect(mergeCalls).toBe(0);
  expect(result.merged).not.toBe(true);
  const decisions = ledger.filter(({ event }) => event === 'merge-decision');
  expect(decisions).toHaveLength(1);
  expect(decisions[0]!.data).toMatchObject({ decision: 'hitl', reason: 'review-budget-follow-up-required', mustFixCount: 1, followUpMustFix: [a], prNumber: 7 });
  expect(decisions.some(({ data }) => data.decision === 'auto')).toBe(false);
  // The follow-up list lands in the run ledger too, not only in the result and PR body.
  expect(ledger.find(({ event }) => event === 'run-status')?.data).toMatchObject({ mergeReason: 'review-budget-follow-up-required', followUpMustFix: [a], followUpMustFixCount: 1, prNumber: 7 });
});

// Spec v2 (OP 18:1x (a)): only content-hash repeats are accepted. A reworded finding that matches only by
// review key is observed as repeated but stays on the draft path.
test('Pod reworded finding that repeats only by review key stays draft (spec v2: content-hash only)', async () => {
  const { result, opened, events, mergeCalls } = await runPod([[a], [aReworded]]);
  expect(result.stage === 'review-blocked' || result.stage === 'aborted').toBe(true);
  expect(opened.filter(({ draft }) => draft === false)).toHaveLength(0);
  expect(mergeCalls).toBe(0);
  expect(events).toContainEqual(expect.objectContaining({ event: 'pod-accept-decision', data: expect.objectContaining({ runId: result.runId, status: 'all-repeated', repeatedCount: 1, newCount: 0, keyOnlyRepeatedCount: 1, accepted: false, merge: 'hitl' }) }));
}, 20000);

// `[repeated]` marks each follow-up «entry» (one `- ` bullet). A multi-line finding keeps its continuation
// lines verbatim under that bullet, because the PR-body reader (`repairInputsFromBody`) folds continuation
// lines into the bullet's item — marking them too would corrupt the item text it hands to repair.
test('Pod multi-line repeated finding gets one marker per entry and round-trips through the PR-body reader', async () => {
  const multi = `${a}\n  detail: the guard is still absent on the retry path`;
  const { result, opened } = await runPod([[multi], [multi]]);
  expect(result).toMatchObject({ ok: true, stage: 'pr-opened', followUpMustFixCount: 1 });
  expect(opened[0]!.draft).toBe(false);
  expect(opened[0]!.body).toContain(`## Follow-up must-fix (1)\n- [repeated] ${multi}`);
  expect(repairInputsFromBody(opened[0]!.body).mustFix).toContain(`- [repeated] ${multi}`);
});

test('Pod newly keyed finding stays draft and logs the rejection', async () => {
  const { result, opened, events } = await runPod([[a], [c]]);
  expect(result.stage === 'review-blocked' || result.stage === 'aborted').toBe(true);
  expect(opened.filter(({ draft }) => draft === false)).toHaveLength(0);
  expect(opened[0]?.draft).toBe(true);
  expect(events).toContainEqual(expect.objectContaining({ event: 'pod-accept-decision', data: expect.objectContaining({ runId: result.runId, status: 'has-new', repeatedCount: 0, newCount: 1, accepted: false }) }));
}, 20000);

test('Pod mixed residue (repeated A plus new C) stays draft through the run path', async () => {
  const { result, opened, events } = await runPod([[a], [a, c]]);
  expect(result.stage === 'review-blocked' || result.stage === 'aborted').toBe(true);
  expect(opened.filter(({ draft }) => draft === false)).toHaveLength(0);
  expect(opened[0]?.draft).toBe(true);
  expect(events).toContainEqual(expect.objectContaining({ event: 'pod-accept-decision', data: expect.objectContaining({ runId: result.runId, status: 'has-new', repeatedCount: 1, newCount: 1, accepted: false }) }));
}, 20000);

test('Pod without a prior round stays draft and reports unmeasured', async () => {
  const { result, opened, events } = await runPod([[a]]);
  expect(result.stage === 'review-blocked' || result.stage === 'aborted').toBe(true);
  expect(opened.filter(({ draft }) => draft === false)).toHaveLength(0);
  expect(events).toContainEqual(expect.objectContaining({ event: 'pod-accept-decision', data: expect.objectContaining({ status: 'unmeasured', repeatedCount: 0, newCount: 0, accepted: false }) }));
});

// A failing gate never reaches the review-budget branch: the run ends on the gate-failed path, so the
// Pod residue classifier is not consulted and cannot widen acceptance past the gate.
test('Pod repeated residue does not override a failed gate', async () => {
  const { result, opened, events } = await runPod([[a], [a]], false);
  expect(result.ok).toBe(false);
  expect(result.stage).toBe('gate-failed');
  expect(opened.filter(({ draft }) => draft === false)).toHaveLength(0);
  expect(events).toHaveLength(0);
});
