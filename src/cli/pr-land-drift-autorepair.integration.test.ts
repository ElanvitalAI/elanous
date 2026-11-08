import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { classifyTypecheckDrift, planDriftRepair, type TypecheckDriftDependencies } from './pr-land-drift-repair.js';
import { ensurePrLandHeavyRemote } from './pr-land-heavy-remote.js';
import { GATE_REMOTE_DEFAULTS } from '../self-implement/gate-remote.js';
import { program } from '../index.js';
import { runTrain, type TrainCandidate } from '../self-implement/merge-train.js';
import { runRepairCycle } from '../task-agent/repair-cycle.js';
import { readTaskCard, writeTaskCards, type TaskCard } from '../task-agent/task-hand.js';
import { runQueuedLanding } from '../task-agent/land-queue.js';

const HEAD = 'a'.repeat(40);
const OLD_BASE = 'b'.repeat(40);
const FAIL_BASE = 'c'.repeat(40);
const REPAIRED_HEAD = 'd'.repeat(40);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('simulates attribution through repaired-head queue admission; repair execution and GitHub push remain fake boundaries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'land-drift-integration-'));
  roots.push(root);
  const receipt = {
    schema: 1 as const, key: 'e'.repeat(64), verdict: 'passed' as const, headCommit: HEAD, baseCommit: OLD_BASE,
    bunVersion: '1.4.2', lockfileHash: 'absent', radiusFiles: ['src/changed.ts'],
    checks: ['changed-file-typecheck'], envFingerprint: 'sim', savedAt: '2026-11-07T00:00:00.000Z',
  };
  const gitResponse = (stdout: string) => ({ status: 0, stdout, stderr: '' });
  const driftDeps: TypecheckDriftDependencies = {
    loadGateReceipts: () => ({ [receipt.key]: receipt }),
    git: (args) => {
      if (args[0] === 'merge-base') return gitResponse('');
      if (args[0] === 'rev-list') return gitResponse('1\n');
      if (args[0] === 'ls-tree') return gitResponse('100644 blob object\tsrc/changed.ts\0');
      if (args[0] === 'show') return gitResponse(args[1]?.startsWith(OLD_BASE + ':')
        ? 'export interface ChangedType { existing: string }\n'
        : 'export interface ChangedType { existing: string; required: number }\n');
      if (args[1] === '--name-only') return gitResponse('src/changed.ts\n');
      return gitResponse('+++ b/src/changed.ts\n+export interface ChangedType { existing: string; required: number }\n');
    },
  };
  const tscOutput = "src/consumer.ts(8,3): error TS2741: Property 'required' is missing in type '{}' but required in type 'ChangedType'.";
  const drift = classifyTypecheckDrift({
    repo: root, headCommit: HEAD, failBase: FAIL_BASE, tscOutput, receiptPath: join(root, 'receipts'),
  }, driftDeps);
  expect(drift.verdict).toBe('drift');

  const candidates: TrainCandidate[] = [
    { number: 11, head: '1'.repeat(40), files: ['src/other.ts'] },
    { number: 22, head: HEAD, files: ['src/changed.ts', 'src/consumer.ts'] },
  ];
  const culpritPlans: Array<{ pr: number; plan: ReturnType<typeof planDriftRepair> | { action: 'reorder'; with: number } }> = [];
  const train = await runTrain(candidates, {
    integrate: () => ({ commitSha: 'f'.repeat(40), conflicts: [] }),
    gate: (_commit, prs) => prs.length === 2 ? 'fail' : prs[0] === 22 ? 'fail' : 'pass',
    classifyCulprit: (pr) => planDriftRepair({
      pr, head: HEAD, failedBase: FAIL_BASE, output: tscOutput, result: drift,
      prFiles: ['src/changed.ts', 'src/consumer.ts'], attemptsByHead: 0, attemptsByPr: 0,
    }),
    onCulpritPlans: (plans) => { culpritPlans.push(...plans); },
    observe: () => {},
  });
  expect(train.verdicts).toEqual([{ number: 11, verdict: 'pass' }, { number: 22, verdict: 'fail' }]);
  expect(culpritPlans).toHaveLength(1);
  expect(culpritPlans[0]).toMatchObject({ pr: 22, plan: { action: 'launch', boundaryFiles: ['src/changed.ts', 'src/consumer.ts'] } });
  const repairPlan = culpritPlans[0]!.plan;
  expect(repairPlan.action).toBe('launch');
  if (repairPlan.action !== 'launch') throw new Error('expected an attributed drift repair plan');
  const goal = repairPlan.goal;

  const statePath = join(root, 'task-agent-actions.json');
  const card: TaskCard = {
    id: 'ta-drift-22', text: 'repair main-drift typecheck failure', seat: 'TC',
    createdAt: '2026-11-07T00:00:00.000Z', status: 'launched', history: [],
    pr: { number: 22, url: 'https://github.com/ElanvitalAI/elanous/pull/22' },
    childLlm: { provider: 'openai-codex', model: 'gpt-6-sol' },
  };
  writeTaskCards(statePath, [card]);
  const repairRequests: Array<{ pr: number; head: string; goalFile: string }> = [];
  const repair = await runRepairCycle({
    card: readTaskCard(card.id, statePath)!, statePath, repo: root, pr: 22, head: HEAD, branch: 'feature/drift',
    mustFix: ['repair the measured main drift'], goalOverride: goal,
    liveMoves: new Set(['narrow-relaunch', 'salvage-relaunch', 'alternative']),
    now: new Date('2026-11-07T01:00:00.000Z'),
    modelAvailability: { codexSubscription: false, grokSubscription: false },
    request: async (request) => { repairRequests.push({ pr: request.pr, head: request.head, goalFile: request.goalFile }); },
    observeLaunch: () => {},
  });
  expect(repair.decision).toBe('repair-requested');
  expect(repairRequests).toHaveLength(1);
  expect(repairRequests[0]).toMatchObject({ pr: 22, head: HEAD });
  expect(readFileSync(repairRequests[0]!.goalFile, 'utf8')).toContain('Property');
  expect(readTaskCard(card.id, statePath)?.repairs?.[0]).toMatchObject({ status: 'requested', pr: 22, head: HEAD });

  const main = '9'.repeat(40);
  const landingHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim();
  const queuePath = '/ops/land-enqueue.sh';
  const entry = '/ops/bin/elanous.mjs';
  const reviewResult = join(root, 'review-results', 'pr-22.json');
  const review = JSON.stringify({ pr: 22, headCommit: landingHead, basedOn: main,
    basedOnReview: 'baseline.json', verdict: 'pass', reviewed: true, mustFix: [] });
  mkdirSync(join(root, 'review-results'), { recursive: true });
  writeFileSync(reviewResult, review);

  let remoteRc: 0 | 1 = 0;
  let remoteCalls = 0;
  const remoteModule = await import('../self-implement/gate-remote.js');
  const dispatch = spyOn(remoteModule, 'dispatchHeavyCheck').mockImplementation(async (options) => {
    remoteCalls++;
    const remoteSummary = {
      head40: landingHead, base40: main, envKey: 'fake-node-c|bun|test', shards: 0, cohort: [], shardsDetail: [],
      verdict: remoteRc === 0 ? 'passed' : 'failed', exitCode: remoteRc,
      introduced: 0, preexisting: 0, unknown: 0, preconditionUnmet: 0, unrunImporters: 0,
    };
    const encoded = Buffer.from(JSON.stringify(remoteSummary)).toString('base64');
    const runner: import('../self-implement/gate-remote.js').GateRemoteRunner = {
      local: () => ({ rc: 0, stdout: '', stderr: '' }),
      ssh: () => ({ rc: 0, stdout: `summary.json\n${encoded}\n__GATE_ARTIFACTS_END__\n`, stderr: '' }),
    };
    await options.onRemoteOutcome?.({ kind: 'ran', rc: remoteRc,
      stdout: Buffer.from(remoteRc === 0 ? 'remote gate pass\n' : 'remote gate failed\n'), stderr: Buffer.alloc(0),
      commit: landingHead, host: 'node-c', ms: 3 }, 'node-c', runner);
    return remoteRc;
  });

  const originalTrack = process.env.ELANOUS_TRACK;
  const originalTrainGate = process.env.ELANOUS_TRAIN_GATE;
  const originalExitCode = process.exitCode;
  delete process.env.ELANOUS_TRACK;
  delete process.env.ELANOUS_TRAIN_GATE;
  const runLanding = async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const queued = await runQueuedLanding({
      card: card.id, pr: 22, head: landingHead, cwd: process.cwd(), statePath,
      reviewResult, command: queuePath, remote: 'node-c', entry, configDir: root,
    }, {
      recover: async () => ({ plan: {} as never, executed: false }),
      run: async (command, args) => {
        calls.push({ command, args });
        if (args.includes('self') && args.includes('gate')) {
          process.exitCode = 0;
          await program.parseAsync(['node', entry, '--config-dir', root, ...args.slice(args.indexOf('self'))]);
          return { status: Number(process.exitCode ?? 0), stdout: '', stderr: '' };
        }
        if (args.includes('origin/main') && args.includes('rev-parse')) return { status: 0, stdout: main + '\n', stderr: '' };
        if (args.includes('HEAD') && args.includes('rev-parse')) return { status: 0, stdout: landingHead + '\n', stderr: '' };
        if (command === 'gh') return { status: 0, stdout: JSON.stringify({ headRefOid: landingHead, state: 'OPEN', isDraft: false }), stderr: '' };
        if (command === queuePath) return { status: 0, stdout: 'OK #22 head=' + landingHead.slice(0, 12) + '\n', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    return { queued, calls };
  };

  try {
    const passed = await runLanding();
    expect(remoteCalls).toBe(1);
    expect(passed.queued.status).toBe(0);
    expect(passed.queued.stdout).toContain('queued #22 head ' + landingHead.slice(0, 12));
    expect(passed.calls.at(-1)).toMatchObject({ command: queuePath, args: ['22', process.cwd(), '--review', reviewResult, '--expected-head', landingHead] });

    remoteRc = 1;
    const failed = await runLanding();
    expect(remoteCalls).toBe(2);
    expect(failed.queued.status).toBe(1);
    expect(failed.queued.stderr).toContain('remote-changed-gate');
    expect(failed.calls.some(({ command }) => command === queuePath)).toBe(false);
  } finally {
    dispatch.mockRestore();
    if (originalTrack === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = originalTrack;
    if (originalTrainGate === undefined) delete process.env.ELANOUS_TRAIN_GATE; else process.env.ELANOUS_TRAIN_GATE = originalTrainGate;
    process.exitCode = originalExitCode ?? 0;
  }

});
