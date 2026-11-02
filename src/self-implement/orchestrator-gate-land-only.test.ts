import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deferredGateEnqueueAuthorized, deferredGateQueueEligible, runSelfImplement } from './orchestrator.js';
import { enqueueThroughPinnedLandTrain } from './seams.js';
import { integrateTrain, runTrain } from './merge-train.js';
import { seams } from './test-seams.js';

const roots: string[] = [];
const priorEnv = new Map<string, string | undefined>();
afterEach(() => {
  for (const [key, value] of priorEnv) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  priorEnv.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function env(key: string, value: string): void {
  if (!priorEnv.has(key)) priorEnv.set(key, process.env[key]);
  process.env[key] = value;
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

test('deferred gate enqueue requires explicit auto-merge consent and a non-draft request', () => {
  expect(deferredGateEnqueueAuthorized({ autoMerge: true, draft: false })).toBe(true);
  expect(deferredGateEnqueueAuthorized({ autoMerge: false, draft: false })).toBe(false);
  expect(deferredGateEnqueueAuthorized({ autoMerge: true, draft: true })).toBe(false);
  expect(deferredGateEnqueueAuthorized({ completion: 'pr', autoMerge: true, draft: false })).toBe(false);
});

test('deferred gate enqueue preserves every pre-existing auto-merge eligibility guard', () => {
  const eligible = {
    gateTimedOut: false, reviewed: true, reviewDeferredToHost: false, reviewVerdict: 'warn', reviewMustFixCount: 0,
    reviewDiffComplete: true, requiredEvidenceMissing: false, latestSignalIncomplete: false, decisionSignalRed: false,
  };
  expect(deferredGateQueueEligible({ autoMerge: true, draft: false }, eligible)).toBe(true);
  for (const key of ['gateTimedOut', 'requiredEvidenceMissing', 'latestSignalIncomplete', 'decisionSignalRed'] as const) {
    expect(deferredGateQueueEligible({ autoMerge: true, draft: false }, { ...eligible, [key]: true })).toBe(false);
  }
  expect(deferredGateQueueEligible({ autoMerge: true, draft: false }, { ...eligible, reviewVerdict: 'fail' })).toBe(false);
  expect(deferredGateQueueEligible({ autoMerge: true, draft: false }, { ...eligible, reviewMustFixCount: 1 })).toBe(false);
  expect(deferredGateQueueEligible({ autoMerge: true, draft: false }, { ...eligible, reviewDiffComplete: false })).toBe(false);
  expect(deferredGateQueueEligible({ autoMerge: true, draft: false }, { ...eligible, reviewed: false })).toBe(false);
});

test('opened self-implement PR uses the land-enqueue contract and train gates its integrated SHA', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-land-only-'));
  roots.push(root);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'fixture');
  git(repo, 'config', 'user.email', 'fixture@localhost');
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'fixture base');
  const base = git(repo, 'rev-parse', 'HEAD');
  const remote = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', remote);
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'checkout', '-qb', 'self-impl/gate-land-only');
  writeFileSync(join(repo, 'candidate.ts'), 'export const candidate = true;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'fixture candidate');
  const head = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'push', '-q', 'origin', 'HEAD');
  const prNumber = 74201;
  const runId = 'run-gate-land-only-fixture';
  const goalFile = join(root, 'GOAL-fixture.txt');
  writeFileSync(goalFile, '# Goal\n- GoalId: 6c21a4c8df170001\n\n## PROBLEM\nA gate deferral fixture.\n\n## ACCEPTANCE CRITERIA\n- Keep the candidate pinned.\n');
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  let gateCalls = 0;
  let openedDraft: boolean | undefined;
  const queueDir = join(root, 'queue');
  const evidenceDir = join(root, 'evidence');
  const reviewDir = join(root, 'review-results');
  mkdirSync(queueDir);
  mkdirSync(evidenceDir);
  mkdirSync(reviewDir);
  const queueFile = join(queueDir, 'land-queue.tsv');
  const draftState = join(root, 'draft-state');
  const landEnqueueStub = join(root, 'land-enqueue-stub.sh');
  writeFileSync(draftState, 'true\n');
  writeFileSync(landEnqueueStub, `#!/bin/sh
pr="$1"; owner="$2"; shift 2
[ "$pr" = "${prNumber}" ] && [ "$owner" = "train:MK" ] && [ "$1" = "--expected-head" ] && [ "$2" = "${head}" ] || exit 2
headprefix="$(printf '%.12s' "$2")"
review="$LAND_RR_DIR/fixture-\${pr}-$headprefix.json"
grep -q '"reviewed":true' "$review" && grep -q '"headCommit":"${head}"' "$review" && grep -q '"model":"gpt-6.1-terra"' "$review" || exit 3
printf '%s\\t%s\\t/train/MK-train\\t%s/overlap-evidence-%s.json\\n' "$pr" "$2" "$LAND_EVDIR" "$pr" > "$LAND_Q"
printf '{"pr":%s,"head":"%s","reviewResult":"%s"}\\n' "$pr" "$2" "$review" > "$LAND_EVDIR/overlap-evidence-$pr.json"
printf 'false\\n' > "$DRAFT_STATE"
printf 'OK #%s head=%.12s headFull=%s pinned\\n' "$pr" "$2" "$2"
`);
  chmodSync(landEnqueueStub, 0o755);
  writeFileSync(join(reviewDir, `fixture-${prNumber}-${head.slice(0, 12)}.json`), JSON.stringify({
    pr: prNumber, headCommit: head, reviewed: true, verdict: 'pass', mustFix: [], model: 'gpt-6.1-terra',
  }));
  env('LAND_Q', queueFile);
  env('LAND_EVDIR', evidenceDir);
  env('LAND_RR_DIR', reviewDir);
  env('LAND_SEAT_TREE', repo);
  env('LAND_GATE_ROOT', join(root, 'gate-root'));
  env('DRAFT_STATE', draftState);
  env('ELANOUS_SEAT', 'MK');

  const result = await runSelfImplement({
    runId,
    feature: 'gate deferred to pinned landing train fixture',
    autoMerge: true,
    draft: false,
    goalFile,
    seams: seams({
      createWorktree: async () => ({ path: repo, branch: 'self-impl/gate-land-only', base: 'origin/main', resolvedBase: base, invokedHead: base }),
      implement: async () => ({ ok: true, summary: 'fixture implementation complete' }),
      gate: async () => { gateCalls++; return { passed: true, log: 'legacy run-stage gate must not run' }; },
      reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'fixture review', reviewed: true, diffTruncated: false }),
      mergeMain: async () => ({ status: 'merged' }),
      defaultBranchRef: () => 'origin/main',
      commitWork: () => {},
      openPr: async ({ draft }) => {
        openedDraft = draft;
        return { url: `https://fixture.invalid/pull/${prNumber}`, number: prNumber };
      },
      readPrFiles: async () => ['candidate.ts'],
      readPrCommitShas: async () => ({ baseCommit: base, headCommit: head, baseRefName: 'main' }),
      writeRunLedger: (entry) => { events.push({ event: entry.event, data: entry.data }); },
      enqueueGateDeferredPr: (input) => enqueueThroughPinnedLandTrain(input, { scriptPath: landEnqueueStub }),
    }),
  });

  expect(result).toMatchObject({ ok: true, stage: 'pr-opened', prNumber });
  expect(openedDraft).toBe(true);
  expect(gateCalls).toBe(0);
  expect(events.filter((entry) => entry.event === 'harness.gate-deferred-to-land').map((entry) => entry.data.mode))
    .toEqual(['run-stage', 'postsync']);
  expect(events.find((entry) => entry.event === 'gate.postsync')?.data).toMatchObject({ mode: 'deferred-to-land', gateExecuted: false });
  expect(events.find((entry) => entry.event === 'goal-slot-fill-unmeasured')?.data).toMatchObject({ runId, gateExecuted: false });
  expect(events.filter((entry) => entry.event === 'goal-slot-fill-unmeasured')).toHaveLength(1);

  const queueRows = readFileSync(queueFile, 'utf8').trim().split(/\r?\n/).map((row) => row.split('\t'));
  const pinned = queueRows.filter((entry) => entry[0] === String(prNumber));
  expect(pinned).toHaveLength(1);
  expect(pinned[0]).toEqual([String(prNumber), head, '/train/MK-train', join(evidenceDir, `overlap-evidence-${prNumber}.json`)]);
  expect(readFileSync(draftState, 'utf8').trim()).toBe('false');
  expect(events.filter((entry) => entry.event === 'gate-deferred-to-land-enqueued')).toHaveLength(1);
  expect(readFileSync(join(evidenceDir, `overlap-evidence-${prNumber}.json`), 'utf8')).toContain(head);

  const trainGateShas: string[] = [];
  const train = await runTrain(pinned.map((entry) => ({ number: Number(entry[0]), head: entry[1]!, files: ['candidate.ts'] })), {
    integrate: (batch) => integrateTrain(repo, base, batch),
    gate: (integratedSha, numbers) => { trainGateShas.push(integratedSha); expect(numbers).toEqual([prNumber]); return 'pass'; },
    observe: () => {},
  });
  expect(train).toMatchObject({ verdicts: [{ number: prNumber, verdict: 'pass' }], gatesRun: 1, integrations: 1 });
  expect(trainGateShas).toHaveLength(1);
  expect(trainGateShas[0]).not.toBe(head);
  expect(/^[0-9a-f]{40}$/.test(trainGateShas[0]!)).toBe(true);
}, 30_000);
