import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ORIGINAL_ASK_MARKER } from '../self-implement/goal-author.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout, spyOn, test } from 'bun:test';

// `ask dry-run`·`progress` 시험은 실제 골 문서 검사기와 실제 워커를 지나 파일당 5초 기본 상한을
// 넘긴다(실측 5.9~6.8초). 상한을 파일 단위로 올려 부하에 따른 flake 를 없앤다 — 시험 동작은 불변.
setDefaultTimeout(30_000);
import { resolveHarnessTarget } from '../self-implement/harness-target-options.js';
import { loadRunLedger, runLedgerDir, appendRunLedgerEntry } from '../self-implement/run-ledger.js';
import { readRunStopRecord } from '../self-implement/run-stop.js';
import { debug } from '../debug/log.js';
import { addHarnessQueue, listHarnessQueue, removeHarnessQueue, tickHarnessQueue, type HarnessQueueDeps } from './harness-queue.js';
import { getUserConfig, setUserConfigOverlay } from '../user-config.js';
import { LogStore, logsDbPath } from '../mss/logging/log-store.js';
import * as podDispatch from './harness-pod-dispatch.js';
import { runSelfOrchestrateCliCommand } from '../self-dev/orchestrate-cli.js';
import { formatOrchestrateResultLine } from '../self-dev/orchestrate-summary-line.js';
import { RELEASE_PATH_LABEL } from '../self-dev/release-path-guard.js';
import { runDraftSweep } from '../self-dev/draft-sweep.js';
import { decideDraft } from '../self-dev/draft-triage-rules.js';
import { runHarnessPlanRfc } from './harness-plan-rfc.js';
import { parsePodPool, PodPoolScheduler } from '../task-orchestrator/surfaces/pod-pool.js';
import { HostPoolLease } from '../pod-lease/host-lease.js';
import { createFakeKubectl } from '../ux-sim/fake-kubectl.js';
import { createFakeGh } from '../ux-sim/fake-gh.js';
import { podSelfImplementSpawn, type Kubectl } from '../task-orchestrator/surfaces/self-implement-pod.js';
import { Command } from 'commander';
import { assessRunningRuns, buildRunProgressRows, renderRunProgressTable } from '../self-implement/running-runs.js';
import type { RunningRunsResult } from '../self-implement/running-runs.js';
import { launchRegistryDir, removeLaunchBinding, writeLaunchBinding } from './launch-registry.js';
import { psProcessStartMs } from './harness-stop.js';
import { DevPipelineError } from '../self-dev/dev-pipeline.js';
import { GRAPH_SPECS } from '../self-implement/graph-templates.js';
import type { GraphOverlaySpec } from '../self-implement/graph-overlay-yaml.js';
import { setJourneyOverlaysForTesting } from '../self-dev/graph-journey-route.js';
import { Worker } from 'node:worker_threads';
import { shouldRunCliEntry } from './progress-worker-runtime.js';
import {
  DEFAULT_HARNESS_PROCESS_THRESHOLDS,
  HARNESS_PROCESS_LONG_RUNNING_ELAPSED_SECONDS,
  HARNESS_PROCESS_RESOURCE_CPU_PERCENT,
  associateHarnessProcessWorktree,
  buildHarnessProcessReport,
  classifyHarnessProcess,
  classifyHarnessPodExit,
  recordHarnessPodStop,
  harnessPodRunId,
  defaultLookupHarnessProcessLedger,
  formatHarnessProcessElapsed,
  installHarnessCliCommand,
  harnessQueueDirectSay,
  killHarnessProcess,
  githubDraftSweepAdapters,
  githubDraftSweepPreviewAdapters,
  supersedeMergedGoalDrafts,
  draftSweepRunStatus,
  observeHarnessLaunchdPids,
  parseHarnessProcessPsOutput,
  parseLaunchctlListOutput,
  parseProcessOwnershipEnv,
  parsePsEwwOwnershipEnv,
  readProcessOwnership,
  renderHarnessProcessLastActivity,
  renderHarnessProcessReport,
  resolveHarnessProcessLastActivity,
  resolveHarnessProcessLaunchdEvidence,
  resolveHarnessProcessOwnership,
  resolveHarnessProcessParentStatus,
  setHarnessAskMarkerInspectorForTesting,
  setHarnessProgressWorkerObserverForTesting,
  queryProgressBounded,
  type ProgressWorkerLifecycle,
  setHarnessUnpressedDecisionSignalInspectorForTesting,
  type HarnessLaunchdPidObservation,
  type HarnessProcessLedgerLookup,
  type HarnessProcessListObservation,
  type HarnessProcessRecord,
  type HarnessWorktreeListObservation,
  openHarnessProcessHandle,
} from './harness-cli-command.js';

const harnessTestCwd = process.cwd();
afterEach(() => { process.chdir(harnessTestCwd); });

const MEASURED_LAUNCHCTL_LIST = [
  '46480   0     com.elanous.nexus',
  '4421    -15   com.elanous.openai-relay',
  '-       127   com.elanous.control',
].join('\n');

const MEASURED_OWNERSHIP_ENV = [
  'ELANOUS_RUN_ID=run-5da31123-1fe3-49b7-a5d0-998740374d3c',
  'ELANOUS_ORIGIN_SESSION=7507f456-2b74-4a6a-ad2c-1a09c8851577',
  'ELANOUS_STATE_DIR=/Users/example/source/axon/monad-agent/.elanous-test',
].join('\0');

const MEASURED_PS_EWW_ARGV = 'bun bin/elanous.mjs --test self implement';
const MEASURED_PS_EWW = [
  '  PID   TT  STAT      TIME COMMAND',
  [
    '45806   ??  S      0:00.01 bun bin/elanous.mjs --test self implement',
    'PATH=/usr/bin',
    'ELANOUS_RUN_ID=run-6ecb1a67-f650-48d9-86f5-88715e91746c',
    'ELANOUS_ORIGIN_SESSION=7507f456-2b74-4a6a-ad2c-1a09c8851577',
    'ELANOUS_STATE_DIR=/Users/example/source/axon/monad-agent/.elanous-test',
    'HOME=/tmp',
  ].join(' '),
].join('\n');

const MEASURED_PS_EWW_OWNERSHIP = {
  status: 'observed' as const,
  runId: 'run-6ecb1a67-f650-48d9-86f5-88715e91746c',
  originSession: '7507f456-2b74-4a6a-ad2c-1a09c8851577',
  stateDir: '/Users/example/source/axon/monad-agent/.elanous-test',
};

describe('harness CLI command', () => {
  // 정지·발사 환경(자식 프로세스)이 물려주는 저작 등급 seam — 시험은 «자기가 세운» 값만 본다.
  const AUTHOR_GRADE_SEAM_ENV = ['ELANOUS_AUTHOR_GRADE', 'ELANOUS_POD_AUTHOR_ON_POD', 'ELANOUS_POD_AUTHOR_GRADE', 'ELANOUS_POD_AUTHOR_GRADE_SOURCE'] as const;
  let ambientAuthorGradeSeam: Array<string | undefined> = [];
  beforeEach(() => {
    ambientAuthorGradeSeam = AUTHOR_GRADE_SEAM_ENV.map((key) => process.env[key]);
    for (const key of AUTHOR_GRADE_SEAM_ENV) delete process.env[key];
  });
  afterEach(() => {
    AUTHOR_GRADE_SEAM_ENV.forEach((key, index) => {
      const value = ambientAuthorGradeSeam[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
    ambientAuthorGradeSeam = [];
  });

  it('depth >= 1 ignores --nested-elanous allow and the launch stays refused', async () => {
    const program = new Command().exitOverride();
    const seen: Array<string | undefined> = [];
    installHarnessCliCommand(program, {
      registerSink: async () => {},
      resolveSurface: async () => 'harness',
      say: async (_words, opts) => { seen.push(opts.nestedElanous); },
      launchGate: { readBudget: async () => ({ action: 'proceed', reasons: ['within budget'] }), activeRuns: () => [] },
    });
    const prev = process.env.ELANOUS_NESTED_DEPTH;
    const logs: Array<{ category: string; event: string; data: unknown }> = [];
    const originalLog = debug.log;
    debug.log = ((category: string, event: string, data?: unknown) => {
      logs.push({ category, event, data });
    }) as typeof debug.log;
    process.env.ELANOUS_NESTED_DEPTH = '1';
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      await program.parseAsync(['harness', 'say', 'hello', '--nested-elanous', 'allow'], { from: 'user' });
      expect(seen).toEqual([]);
      expect(logs).toContainEqual({ category: 'agent-mission.nested', event: 'allow-ignored', data: { depth: 1 } });
      expect(errors.some((line) => line.includes('allow-ignored'))).toBe(true);
      expect(process.exitCode).toBe(1);
    } finally {
      console.error = originalError;
      debug.log = originalLog;
      process.exitCode = 0;
      if (prev === undefined) delete process.env.ELANOUS_NESTED_DEPTH;
      else process.env.ELANOUS_NESTED_DEPTH = prev;
    }
  });

  it('harness say author-grade flag overrides config and absent config stays full', async () => {
    const seen: Array<{ authorGrade?: string; authorGradeSource?: string }> = [];
    const { program } = install(undefined, async (_words, opts) => { seen.push({ authorGrade: opts.authorGrade, authorGradeSource: opts.authorGradeSource }); });
    const prior = getUserConfig().harness;
    try {
      setUserConfigOverlay((config) => ({ ...config, harness: { ...prior, authorGrade: 'full' } }));
      await program.parseAsync(['harness', 'say', 'same sentence', '--author-grade', 'lite'], { from: 'user' });
      expect(seen.at(-1)).toEqual({ authorGrade: 'lite', authorGradeSource: 'flag' });
      setUserConfigOverlay((config) => ({ ...config, harness: { ...prior, authorGrade: 'lite' } }));
      await program.parseAsync(['harness', 'say', 'same sentence'], { from: 'user' });
      expect(seen.at(-1)).toEqual({ authorGrade: 'lite', authorGradeSource: 'config' });
      setUserConfigOverlay((config) => ({ ...config, harness: { ...prior, authorGrade: undefined } }));
      await program.parseAsync(['harness', 'say', 'same sentence'], { from: 'user' });
      expect(seen.at(-1)).toEqual({ authorGrade: undefined, authorGradeSource: undefined });
      process.env.ELANOUS_AUTHOR_GRADE = 'lite';
      await program.parseAsync(['harness', 'say', 'same sentence'], { from: 'user' });
      expect(seen.at(-1)).toEqual({ authorGrade: 'lite', authorGradeSource: 'env' });
      await program.parseAsync(['harness', 'say', 'same sentence', '--author-grade', 'full'], { from: 'user' });
      expect(seen.at(-1)).toEqual({ authorGrade: 'full', authorGradeSource: 'flag' });
    } finally {
      setUserConfigOverlay(null);
    }
  });

  it('depth 0 keeps --nested-elanous allow on the launch options', async () => {
    const program = new Command().exitOverride();
    const seen: Array<string | undefined> = [];
    installHarnessCliCommand(program, {
      registerSink: async () => {},
      resolveSurface: async () => 'harness',
      say: async (_words, opts) => { seen.push(opts.nestedElanous); },
      launchGate: { readBudget: async () => ({ action: 'proceed', reasons: ['within budget'] }), activeRuns: () => [] },
    });
    const prev = process.env.ELANOUS_NESTED_DEPTH;
    delete process.env.ELANOUS_NESTED_DEPTH;
    try {
      await program.parseAsync(['harness', 'say', 'hello', '--nested-elanous', 'allow'], { from: 'user' });
      expect(seen).toEqual(['allow']);
    } finally {
      if (prev === undefined) delete process.env.ELANOUS_NESTED_DEPTH;
      else process.env.ELANOUS_NESTED_DEPTH = prev;
    }
  });

  function install(
    ask?: Parameters<typeof installHarnessCliCommand>[1]['ask'],
    say?: Parameters<typeof installHarnessCliCommand>[1]['say'],
    plan?: Parameters<typeof installHarnessCliCommand>[1]['plan'],
    processObservation?: Parameters<typeof installHarnessCliCommand>[1]['processObservation'],
    mission?: Parameters<typeof installHarnessCliCommand>[1]['mission'],
    missionLoop?: Parameters<typeof installHarnessCliCommand>[1]['missionLoop'],
    draftSweep?: Parameters<typeof installHarnessCliCommand>[1]['draftSweep'],
    podDispatchTask?: Parameters<typeof installHarnessCliCommand>[1]['podDispatchTask'],
    launchGate: NonNullable<Parameters<typeof installHarnessCliCommand>[1]['launchGate']> = {
      readBudget: async () => ({ action: 'proceed', reasons: ['within budget'] }), activeRuns: () => [],
    },
  ) {
    const program = new Command().exitOverride();
    const harness = installHarnessCliCommand(program, {
      registerSink: async () => {},
      resolveSurface: async () => 'harness',
      ask,
      say,
      plan,
      processObservation,
      mission,
      missionLoop,
      draftSweep,
      podDispatchTask,
      launchGate,
    });
    return { program, harness };
  }

  async function captureLog(run: () => Promise<unknown>): Promise<string[]> {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      await run();
    } finally {
      console.log = original;
    }
    return lines;
  }

  async function captureError(run: () => Promise<unknown>): Promise<string[]> {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      await run();
    } finally {
      console.error = original;
    }
    return lines;
  }

  function processFixture(
    overrides: Partial<HarnessProcessRecord> & Pick<HarnessProcessRecord, 'pid'>,
  ): HarnessProcessRecord {
    return {
      ppid: 1,
      cpuPercent: 0.1,
      elapsedSeconds: 12,
      command: 'bun bin/elanous.mjs --test harness processes',
      ownership: { status: 'observed' },
      ...overrides,
    };
  }

  async function runProcesses(
    records: HarnessProcessListObservation | readonly HarnessProcessRecord[],
    worktrees: HarnessWorktreeListObservation | readonly string[] = [],
    launchd: HarnessLaunchdPidObservation = {
      status: 'failed',
      reason: 'launchctl not invoked in test',
    },
    lookupLedger: HarnessProcessLedgerLookup = () => null,
    nowMs?: number,
  ): Promise<string[]> {
    const { program } = install(undefined, undefined, undefined, {
      listProcesses: () => records,
      listWorktrees: () => worktrees,
      observeLaunchdPids: () => launchd,
      lookupLedger,
      ...(nowMs === undefined ? {} : { nowMs }),
    });
    return captureLog(() => program.parseAsync(['node', 'elanous', 'harness', 'processes']));
  }

  test('harness say and ask --seat stamp launch env and pass resolved cwd seat to handlers', async () => {
    const previous = process.env.ELANOUS_HARNESS_SEAT;
    const previousLaunch = process.env.ELANOUS_HARNESS_QUEUE_LAUNCH;
    delete process.env.ELANOUS_HARNESS_QUEUE_LAUNCH;
    const received: Array<{ kind: string; seat: string | undefined; env: string | undefined }> = [];
    const { program } = install(async (_file, opts) => { received.push({ kind: 'ask', seat: opts.seat, env: process.env.ELANOUS_HARNESS_SEAT }); },
      async (_words, opts) => { received.push({ kind: 'say', seat: opts.seat, env: process.env.ELANOUS_HARNESS_SEAT }); });
    try {
      await program.parseAsync(['node', 'elanous', 'harness', 'say', 'objective', '--seat', 'UX', '--no-queue']);
      await program.parseAsync(['node', 'elanous', 'harness', 'ask', 'goal.md', '--seat', 'TC', '--no-queue']);
      expect(received).toEqual([{ kind: 'say', seat: 'UX', env: 'UX' }, { kind: 'ask', seat: 'TC', env: 'TC' }]);
      expect(process.env.ELANOUS_HARNESS_SEAT).toBe(previous);
      setUserConfigOverlay((config) => ({ ...config, loops: { ...config.loops,
        orchestrator: { ...config.loops?.orchestrator!, seatTrees: { OP: [process.cwd()] } } } }));
      await program.parseAsync(['node', 'elanous', 'harness', 'say', 'inferred', '--no-queue']);
      expect(received.at(-1)).toEqual({ kind: 'say', seat: 'OP', env: 'OP' });
      setUserConfigOverlay(null);
      process.env.ELANOUS_HARNESS_SEAT = 'MK';
      await program.parseAsync(['node', 'elanous', 'harness', 'say', 'unassigned']);
      expect(received.at(-1)).toEqual({ kind: 'say', seat: undefined, env: undefined });
      process.env.ELANOUS_HARNESS_QUEUE_LAUNCH = 'hq-fixture';
      process.env.ELANOUS_HARNESS_SEAT = 'MK';
      await program.parseAsync(['node', 'elanous', 'harness', 'say', 'queued']);
      expect(received.at(-1)).toEqual({ kind: 'say', seat: 'MK', env: 'MK' });
    } finally {
      if (previousLaunch === undefined) delete process.env.ELANOUS_HARNESS_QUEUE_LAUNCH;
      else process.env.ELANOUS_HARNESS_QUEUE_LAUNCH = previousLaunch;
      setUserConfigOverlay(null);
      if (previous === undefined) delete process.env.ELANOUS_HARNESS_SEAT;
      else process.env.ELANOUS_HARNESS_SEAT = previous;
    }
  });

  test('harness.queue.directSay off (default): direct say keeps the old path — no enqueue, no refusal, handler output and exit kept', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-queue-off-'));
    const queue: HarnessQueueDeps = { root, log: () => {}, launch: async () => { throw Error('queue must not launch'); } };
    let calls = 0;
    const program = new Command().exitOverride();
    installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness',
      say: async () => { calls += 1; console.log('direct output'); process.exitCode = 7; },
      ask: async () => { calls += 1; console.log('direct ask output'); process.exitCode = 7; }, queue });
    const goal = join(root, 'goal.md');
    writeFileSync(goal, '대상 경로: src/x.ts\n칸: ONEDOOR-2\n');
    const oldExit = process.exitCode;
    const oldFlag = process.env.ELANOUS_HARNESS_QUEUE_DIRECT_SAY;
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      delete process.env.ELANOUS_HARNESS_QUEUE_DIRECT_SAY;
      setUserConfigOverlay((config) => ({ ...config, harness: { ...config.harness, queue: { ...config.harness?.queue, directSay: false } } }));
      for (let i = 0; i < 2; i += 1) {
        process.exitCode = 0;
        expect(await captureLog(() => program.parseAsync(['node', 'elanous', 'harness', 'say', 'same words · 칸: ONEDOOR-2', '--seat', 'TC', '--substrate', 'local']))).toContain('direct output');
        expect(process.exitCode).toBe(7);
      }
      await program.parseAsync(['node', 'elanous', 'harness', 'say', 'emergency', '--seat', 'TC', '--substrate', 'local', '--no-queue']);
      // Off also covers ask and a seat inferred from the working tree: both stay on the direct path.
      setUserConfigOverlay((config) => ({ ...config, harness: { ...config.harness, queue: { ...config.harness?.queue, directSay: false } },
        loops: { ...config.loops, orchestrator: { ...config.loops?.orchestrator!, seatTrees: { OP: [process.cwd()] } } } }));
      process.exitCode = 0;
      expect(await captureLog(() => program.parseAsync(['node', 'elanous', 'harness', 'ask', goal, '--substrate', 'local']))).toContain('direct ask output');
      expect(process.exitCode).toBe(7);
      process.exitCode = 0;
      expect(await captureLog(() => program.parseAsync(['node', 'elanous', 'harness', 'say', 'inferred seat', '--substrate', 'local']))).toContain('direct output');
      expect(calls).toBe(5);
      expect(listHarnessQueue(queue)).toEqual([]);
      expect(log.mock.calls.filter(([category]) => category === 'harness.queue')).toEqual([]);
    } finally {
      log.mockRestore(); process.exitCode = oldExit ?? 0; setUserConfigOverlay(null);
      if (oldFlag === undefined) delete process.env.ELANOUS_HARNESS_QUEUE_DIRECT_SAY; else process.env.ELANOUS_HARNESS_QUEUE_DIRECT_SAY = oldFlag;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('HARNESS-FULL-GRAPH 2판: a launch overlay routing intake.direct → queue sends a real say into the queue with directSay off; --no-queue still wins', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-queue-graph-'));
    const launches: string[][] = [];
    const queue: HarnessQueueDeps = { root, authorShadow: () => {}, idleRequest: () => {},
      processes: () => [], pool: () => ({ running: 0, pending: 0, reserved: 0, limit: 8 }),
      launch: async (_item, args) => { launches.push(args); return 901; }, log: () => {} };
    let direct = 0;
    const program = new Command().exitOverride();
    installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness',
      say: async () => { direct += 1; }, queue });
    const intakeEdge = GRAPH_SPECS['self-implement']!.edges.findIndex((edge) => edge.from === 'intake');
    const oldExit = process.exitCode;
    const oldFlag = process.env.ELANOUS_HARNESS_QUEUE_DIRECT_SAY;
    try {
      delete process.env.ELANOUS_HARNESS_QUEUE_DIRECT_SAY;
      setUserConfigOverlay((config) => ({ ...config, harness: { ...config.harness, queue: { ...config.harness?.queue, directSay: false } } }));
      setJourneyOverlaysForTesting([{
        overlayId: 'always-queue-tc', target: 'self-implement', stage: 'launch', appliesWhen: 'seat == TC',
        patch: [{ op: 'replace', path: `/edges/${intakeEdge}/map/direct`, value: 'queue' }],
      } as GraphOverlaySpec]);
      process.exitCode = 0;
      await program.parseAsync(['node', 'elanous', 'harness', 'say', 'graph routed', '--seat', 'TC', '--substrate', 'local']);
      expect(direct).toBe(0);
      expect(launches).toEqual([['harness', 'say', 'graph routed', '--seat', 'TC', '--substrate', 'local']]);
      expect(listHarnessQueue(queue)).toMatchObject([{ status: 'launched', seat: 'TC', input: 'graph routed' }]);
      // The overlay's condition does not hold for MK, and --no-queue is a precondition the graph cannot override.
      await program.parseAsync(['node', 'elanous', 'harness', 'say', 'other seat', '--seat', 'MK', '--substrate', 'local']);
      await program.parseAsync(['node', 'elanous', 'harness', 'say', 'emergency', '--seat', 'TC', '--substrate', 'local', '--no-queue']);
      expect(direct).toBe(2);
      expect(launches).toHaveLength(1);
    } finally {
      setJourneyOverlaysForTesting(undefined); setUserConfigOverlay(null); process.exitCode = oldExit ?? 0;
      if (oldFlag === undefined) delete process.env.ELANOUS_HARNESS_QUEUE_DIRECT_SAY; else process.env.ELANOUS_HARNESS_QUEUE_DIRECT_SAY = oldFlag;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('harnessQueueDirectSay reads env only when config leaves it unset; anything else is off', () => {
    const pin = (value: boolean | undefined) => setUserConfigOverlay((config) => {
      const { directSay: _drop, ...queue } = config.harness?.queue ?? {};
      return { ...config, harness: { ...config.harness, queue: value === undefined ? queue : { ...queue, directSay: value } } };
    });
    try {
    pin(undefined); // isolate from any operator setting: the key is absent, so env decides
    expect(getUserConfig().harness?.queue?.directSay).toBeUndefined();
    expect(harnessQueueDirectSay({})).toBe(false);
    expect(harnessQueueDirectSay({ ELANOUS_HARNESS_QUEUE_DIRECT_SAY: '1' })).toBe(true);
    expect(harnessQueueDirectSay({ ELANOUS_HARNESS_QUEUE_DIRECT_SAY: 'true' })).toBe(true);
    expect(harnessQueueDirectSay({ ELANOUS_HARNESS_QUEUE_DIRECT_SAY: '0' })).toBe(false);
    expect(harnessQueueDirectSay({ ELANOUS_HARNESS_QUEUE_DIRECT_SAY: 'yes please' })).toBe(false);
    pin(false);
    expect(harnessQueueDirectSay({ ELANOUS_HARNESS_QUEUE_DIRECT_SAY: '1' })).toBe(false); // config false > env 1
    pin(true);
    expect(harnessQueueDirectSay({ ELANOUS_HARNESS_QUEUE_DIRECT_SAY: '0' })).toBe(true); // config true > env 0
    } finally { setUserConfigOverlay(null); }
  });

  describe('harness.queue.directSay on', () => {
    let oldFlag: string | undefined;
    beforeEach(() => {
      oldFlag = process.env.ELANOUS_HARNESS_QUEUE_DIRECT_SAY; process.env.ELANOUS_HARNESS_QUEUE_DIRECT_SAY = '1';
      setUserConfigOverlay((config) => ({ ...config, harness: { ...config.harness, queue: { ...config.harness?.queue, directSay: true } } }));
    });
    afterEach(() => {
      setUserConfigOverlay(null);
      if (oldFlag === undefined) delete process.env.ELANOUS_HARNESS_QUEUE_DIRECT_SAY; else process.env.ELANOUS_HARNESS_QUEUE_DIRECT_SAY = oldFlag;
    });

    test('unmarked say/ask queue and tick the requested item, while capped say waits with one reason', async () => {
      const root = mkdtempSync(join(tmpdir(), 'cli-queue-'));
      const goal = join(root, 'goal.md');
      writeFileSync(goal, 'an existing goal');
      const launches: string[][] = [];
      const queue: HarnessQueueDeps = { root, authorShadow: () => {}, idleRequest: () => {},
        processes: () => [], pool: () => ({ running: 0, pending: 0, reserved: 0, limit: 8 }),
        launch: async (_item, args) => { launches.push(args); return 901; }, log: () => {} };
      const program = new Command().exitOverride();
      installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness',
        say: async () => { throw Error('parent must not dispatch'); }, ask: async () => { throw Error('parent must not dispatch'); }, queue });
      const before = process.exitCode;
      try {
        process.exitCode = 0;
        await program.parseAsync(['node', 'elanous', 'harness', 'say', 'verbatim', 'request', '--seat', 'TC']);
        expect(listHarnessQueue(queue)).toMatchObject([{ status: 'launched', kind: 'say', seat: 'TC', input: 'verbatim request' }]);
        expect(launches).toEqual([['harness', 'say', 'verbatim request', '--seat', 'TC']]);
        expect(process.exitCode).toBe(0);
        await program.parseAsync(['node', 'elanous', 'harness', 'ask', goal, '--seat', 'UX']);
        expect(listHarnessQueue(queue)).toMatchObject([{ status: 'launched' }, { status: 'launched', kind: 'ask', seat: 'UX', input: goal }]);
        expect(launches).toHaveLength(2);
        expect(process.exitCode).toBe(0);
        // Keep config directSay true while env says 0: precedence and seat inference are checked together.
        setUserConfigOverlay((config) => ({ ...config, harness: { ...config.harness, queue: { ...config.harness?.queue, directSay: true } },
          loops: { ...config.loops, orchestrator: { ...config.loops?.orchestrator!, seatTrees: { OP: [process.cwd()] } } } }));
        process.env.ELANOUS_HARNESS_QUEUE_DIRECT_SAY = '0';
        await program.parseAsync(['node', 'elanous', 'harness', 'say', 'inferred']);
        expect(listHarnessQueue(queue).at(-1)).toMatchObject({ seat: 'OP', status: 'launched', kind: 'say' });
        expect(launches).toHaveLength(3);
        await program.parseAsync(['node', 'elanous', 'harness', 'say', 'explicit-substrate', '--seat', 'MK', '--substrate', 'local']);
        expect(launches.at(-1)).toEqual(['harness', 'say', 'explicit-substrate', '--seat', 'MK', '--substrate', 'local']);
      } finally { setUserConfigOverlay(null); process.exitCode = before ?? 0; rmSync(root, { recursive: true, force: true }); }
    });

    test('capped unmarked say persists once, reports its own blocking reason and launches zero', async () => {
      const root = mkdtempSync(join(tmpdir(), 'cli-queue-cap-'));
      const launches: string[][] = [];
      const queue: HarnessQueueDeps = { root, authorShadow: () => {}, idleRequest: () => {},
        processes: () => [{ pid: 900, seat: 'TC' }], cap: () => 1,
        pool: () => ({ running: 0, pending: 0, reserved: 0, limit: 8 }),
        launch: async (_item, args) => { launches.push(args); return 901; }, log: () => {} };
      const program = new Command().exitOverride();
      installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness',
        say: async () => { throw Error('must wait'); }, queue });
      const before = process.exitCode;
      try {
        process.exitCode = 0;
        const lines = await captureLog(() => program.parseAsync(['node', 'elanous', 'harness', 'say', 'blocked', '--seat', 'TC']));
        expect(lines.filter((line) => line.startsWith('대기열에 들어갔다 — '))).toEqual([
          '대기열에 들어갔다 — seat TC: 1/1 (injectedCap.TC=1 · releaseGate.TC=4 · seatCaps.TC=8)',
        ]);
        expect(listHarnessQueue(queue)).toMatchObject([{ status: 'queued', waitingReason: 'seat TC: 1/1 (injectedCap.TC=1 · releaseGate.TC=4 · seatCaps.TC=8)' }]);
        expect(launches).toHaveLength(0);
        expect(process.exitCode).toBe(0);
      } finally { process.exitCode = before ?? 0; rmSync(root, { recursive: true, force: true }); }
    });

    test('an existing queue head keeps a new direct say waiting without launching a different item', async () => {
      const root = mkdtempSync(join(tmpdir(), 'cli-queue-fifo-'));
      const launches: string[][] = [];
      const queue: HarnessQueueDeps = { root, authorShadow: () => {}, idleRequest: () => {},
        processes: () => [], pool: () => ({ running: 0, pending: 0, reserved: 0, limit: 8 }),
        launch: async (_item, args) => { launches.push(args); return 901; }, log: () => {} };
      const head = await addHarnessQueue({ seat: 'TC', say: 'already waiting' }, queue);
      const program = new Command().exitOverride();
      installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness',
        say: async () => { throw Error('must not dispatch'); }, queue });
      const oldExit = process.exitCode;
      try {
        process.exitCode = 0;
        const lines = await captureLog(() => program.parseAsync(['node', 'elanous', 'harness', 'say', 'new', '--seat', 'TC']));
        expect(lines.filter((line) => line.startsWith('대기열에 들어갔다 — '))).toEqual(['대기열에 들어갔다 — 앞선 대기열 항목 차례']);
        expect(listHarnessQueue(queue)).toMatchObject([{ id: head.id, status: 'queued' },
          { status: 'queued', waitingReason: '앞선 대기열 항목 차례' }]);
        expect(launches).toEqual([]);
        expect(process.exitCode).toBe(0);
      } finally { process.exitCode = oldExit ?? 0; rmSync(root, { recursive: true, force: true }); }
    });

    test('a direct say launched at once through the real queue launcher keeps the child output, cwd and exit code; a second say for the same cell is refused', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-queue-real-'));
      const owner = mkdtempSync(join(tmpdir(), 'cli-queue-owner-'));
      const stub = join(dir, 'stub.ts');
      writeFileSync(stub, "if (process.env.STUB_SIGNAL) process.kill(process.pid, 'SIGTERM');\nconsole.log('STUB ' + JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) })); process.exitCode = 7;\n");
      const driver = join(dir, 'driver.ts');
      const src = join(import.meta.dir, 'harness-cli-command.ts');
      // The fixture lives outside this repository; resolve Commander from this checkout explicitly.
      writeFileSync(driver, [
        `import { Command } from ${JSON.stringify(join(import.meta.dir, '..', '..', 'node_modules', 'commander', 'index.js'))};`,
        `import { installHarnessCliCommand } from ${JSON.stringify(src)};`,
        `const root = ${JSON.stringify(join(dir, 'state'))};`,
        `const queue = { root, authorShadow: () => {}, idleRequest: () => {}, processes: () => [], cap: () => 4, log: () => {},`,
        `  pool: () => ({ running: 0, pending: 0, reserved: 0, limit: 8 }), launchCommand: ${JSON.stringify(stub)} };`,
        `const program = new Command().exitOverride();`,
        `installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness',`,
        `  say: async () => { throw new Error('direct dispatch must not run'); }, queue });`,
        `await program.parseAsync(['node', 'elanous', ...process.argv.slice(2)]);`,
      ].join('\n'));
      mkdirSync(join(dir, 'state', 'harness'), { recursive: true });
      const env = { ...process.env, ELANOUS_STATE_DIR: join(dir, 'state'), ELANOUS_CONFIG_DIR: join(dir, 'config') };
      delete (env as Record<string, string | undefined>).ELANOUS_HARNESS_QUEUE_LAUNCH;
      const run = (words: string) => Bun.spawnSync(['bun', driver, 'harness', 'say', words, '--seat', 'TC', '--substrate', 'local'],
        { cwd: owner, env, stdout: 'pipe', stderr: 'pipe' });
      try {
        const first = run('probe · 칸: ONEDOOR-2');
        const out = first.stdout.toString();
        expect(first.exitCode).toBe(7);
        const line = out.split('\n').find((l) => l.startsWith('STUB '));
        expect(line).toBeDefined();
        const seen = JSON.parse(line!.slice(5)) as { cwd: string; args: string[] };
        expect(realpathSync(seen.cwd)).toBe(realpathSync(owner));
        expect(seen.args).toContain('probe · 칸: ONEDOOR-2');
        // The finished row is retryable (exit 7), so the same cell may be sent again; a queued twin is refused.
        const twinRow = await addHarnessQueue({ seat: 'MK', say: 'queued twin · 칸: HQ-FENCE-RAIL' }, { root: join(dir, 'state') });
        const twin = run('another sentence · 칸: HQ-FENCE-RAIL');
        expect(twin.exitCode).toBe(1);
        expect(twin.stderr.toString().split('\n').filter((l) => l.startsWith('발사 거절 — '))).toHaveLength(1);
        expect(twin.stdout.toString()).not.toContain('STUB ');
        // Clear the MK head first: with it queued, round-robin would make the next TC say wait for MK's turn.
      await removeHarnessQueue(twinRow.id, { root: join(dir, 'state') });
      // A child killed by a signal still ends the parent (no hang waiting for a missed close) with a non-zero code.
        const killed = Bun.spawnSync(['bun', driver, 'harness', 'say', 'signal probe', '--seat', 'TC', '--substrate', 'local'],
          { cwd: owner, env: { ...env, STUB_SIGNAL: '1' }, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
        expect(killed.signalCode ?? null).toBeNull();
        expect(killed.exitCode).not.toBe(0);
        expect(killed.stdout.toString()).not.toContain('STUB ');
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(owner, { recursive: true, force: true });
      }
    }, 60_000);

    test('when a separate real tick launches the new row first, the direct say reports that launch; a row left launching ends non-zero', async () => {
      for (const mode of ['launched', 'launching'] as const) {
        const root = mkdtempSync(join(tmpdir(), `cli-queue-race-${mode}-`));
        const launches: string[][] = [];
        let racer: Awaited<ReturnType<typeof tickHarnessQueue>> | undefined;
        const queue: HarnessQueueDeps = { root, authorShadow: () => {}, idleRequest: () => {}, processes: () => [], cap: () => 4,
          pool: () => ({ running: 0, pending: 0, reserved: 0, limit: 8 }), log: () => {},
          launch: async (_item, args) => {
            launches.push(args);
            if (mode === 'launching') throw new Error('spawn failed after reservation');
            return 901;
          },
          // A separate, real tick runs between the CLI's enqueue and the CLI's own tick.
          afterEnqueue: async () => { try { racer = await tickHarnessQueue(queue); } catch { racer = undefined; } } };
        const program = new Command().exitOverride();
        installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness',
          say: async () => { throw Error('must not dispatch'); }, queue });
        const oldExit = process.exitCode;
        try {
          process.exitCode = 0;
          const lines = await captureLog(() => program.parseAsync(['node', 'elanous', 'harness', 'say', `raced ${mode}`, '--seat', 'TC']));
          expect(launches).toHaveLength(1); // only the racing tick launched — the CLI did not launch it a second time
          if (mode === 'launched') {
            expect(racer?.outcome).toBe('launched');
            expect(lines.filter((line) => line.startsWith('다른 대기열 tick 이 이미 발사했다 — ') && line.includes('pid 901'))).toHaveLength(1);
            expect(process.exitCode).toBe(0);
          } else {
            expect(listHarnessQueue(queue)[0]?.status).toBe('launching');
            expect(lines.some((line) => line.startsWith('다른 대기열 tick 이 이미 발사했다'))).toBe(false);
            expect(process.exitCode).toBe(1);
          }
        } finally { process.exitCode = oldExit ?? 0; rmSync(root, { recursive: true, force: true }); }
      }
    });

    test('marked say does not requeue; --no-queue bypass logs once and preserves handler output and exit', async () => {
      const root = mkdtempSync(join(tmpdir(), 'cli-queue-bypass-'));
      const queue: HarnessQueueDeps = { root, log: () => {} };
      const program = new Command().exitOverride();
      installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness',
        say: async () => { console.log('same output'); process.exitCode = 7; }, queue });
      const oldLaunch = process.env.ELANOUS_HARNESS_QUEUE_LAUNCH;
      const oldSeat = process.env.ELANOUS_HARNESS_SEAT;
      const oldExit = process.exitCode;
      const log = spyOn(debug, 'log').mockImplementation(() => {});
      try {
        process.env.ELANOUS_HARNESS_QUEUE_LAUNCH = 'hq-marked';
        process.env.ELANOUS_HARNESS_SEAT = 'MK';
        process.exitCode = 0;
        expect(await captureLog(() => program.parseAsync(['node', 'elanous', 'harness', 'say', 'marked']))).toContain('same output');
        expect(listHarnessQueue(queue)).toEqual([]);
        expect(process.exitCode).toBe(7);
        await program.parseAsync(['node', 'elanous', 'harness', 'say', 'marked', '--seat', 'TC']);
        expect(listHarnessQueue(queue)).toEqual([]);
        delete process.env.ELANOUS_HARNESS_QUEUE_LAUNCH;
        process.exitCode = 0;
        expect(await captureLog(() => program.parseAsync(['node', 'elanous', 'harness', 'say', 'emergency', '--seat', 'UX', '--no-queue']))).toContain('same output');
        expect(process.exitCode).toBe(7);
        expect(listHarnessQueue(queue)).toEqual([]);
        expect(log.mock.calls.filter(([category, event]) => category === 'harness.queue' && event === 'bypass'))
          .toEqual([['harness.queue', 'bypass', { seat: 'UX', reason: '--no-queue' }]]);
      } finally {
        log.mockRestore(); process.exitCode = oldExit ?? 0;
        if (oldLaunch === undefined) delete process.env.ELANOUS_HARNESS_QUEUE_LAUNCH;
        else process.env.ELANOUS_HARNESS_QUEUE_LAUNCH = oldLaunch;
        if (oldSeat === undefined) delete process.env.ELANOUS_HARNESS_SEAT;
        else process.env.ELANOUS_HARNESS_SEAT = oldSeat;
        rmSync(root, { recursive: true, force: true });
      }
    });

  });

  test('processes --kill checks repository, owning run and terminal status before sending one SIGTERM', async () => {
    const root = '/tmp/owned-elanous-repo';
    const signals: Array<[number, string]> = [];
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const record = processFixture({ pid: 541, elapsedSeconds: 12,
      command: `bun ${root}/bin/elanous.mjs self orchestrate --goal-file x.md`,
      ownership: { status: 'observed', runId: 'run-a' } });
    const deps = {
      repositoryRoot: root, listProcesses: () => [record], readStartTime: () => 'Thu Oct  2 22:49:07 2026',
      lookupLedger: () => [{ event: 'run-status', data: { runStatus: 'running' }, timestamp: new Date().toISOString() }],
      openProcessHandle: (pid: number) => ({ signal: (signal: NodeJS.Signals) => { signals.push([pid, signal]); }, close: () => {} }),
    };
    try {
      expect(killHarnessProcess(542, false, deps).outcome).toBe('refused');
      expect(killHarnessProcess(541, false, { ...deps, repositoryRoot: '/tmp/other-repo' }).outcome).toBe('refused');
      expect(killHarnessProcess(541, false, { ...deps, listProcesses: () => [{ ...record, command: `bun /tmp/other-repo/bin/elanous.mjs self orchestrate --goal-file ${root}/goal.md` }] }).outcome).toBe('refused');
      expect(killHarnessProcess(541, false, { ...deps, listProcesses: () => [{ ...record, command: 'bun bin/elanous.mjs self orchestrate --goal-file x.md', cwd: root }] }).runState).toBe('running');
      expect(killHarnessProcess(541, false, { ...deps, listProcesses: () => [{ ...record, command: 'bun bin/elanous.mjs self orchestrate --goal-file x.md', cwd: '/tmp/other-repo' }] }).outcome).toBe('refused');
      expect(killHarnessProcess(541, false, { ...deps, readStartTime: () => '' }).reason).toBe('process start time unreadable');
      expect(killHarnessProcess(541, false, deps)).toMatchObject({ outcome: 'refused', owned: true, runState: 'running' });
      for (const status of ['unknown', 'future-state', '']) {
        expect(killHarnessProcess(541, true, { ...deps, lookupLedger: () => [
          { event: 'run-status', data: { runStatus: status } },
        ] })).toMatchObject({ outcome: 'refused', owned: true, reason: 'owning run status unconfirmed' });
      }
      expect(killHarnessProcess(541, true, { ...deps, lookupLedger: () => [
        { event: 'run-status', data: {} },
      ] })).toMatchObject({ outcome: 'refused', reason: 'owning run status unconfirmed' });
      expect(signals).toEqual([]);
      let reads = 0;
      expect(killHarnessProcess(541, true, { ...deps, readStartTime: () => (++reads === 1 ? 'Thu Oct  2 22:49:07 2026' : 'Thu Oct  2 22:49:08 2026') }).reason).toBe('pid start time changed');
      expect(signals).toEqual([]);
      const terminal = { ...deps, lookupLedger: () => [{ event: 'run-status', data: { runStatus: 'completed' } }] };
      const { program } = install(undefined, undefined, undefined, { ...terminal, write: () => {} });
      await program.parseAsync(['node', 'elanous', 'harness', 'processes', '--kill', '541']);
      expect(signals).toEqual([[541, 'SIGTERM']]);
      expect(log).toHaveBeenCalledWith('harness.processes', 'kill', expect.objectContaining({ pid: 541, owned: true, runState: 'completed', outcome: 'sent' }));
      expect(killHarnessProcess(541, true, deps).outcome).toBe('sent');
      expect(signals).toHaveLength(2);
    } finally { log.mockRestore(); }
  });

  test('processes --kill signals only its pinned handle even when the PID is reused in the same second', () => {
    const root = '/tmp/owned-elanous-repo';
    const pid = 541;
    let currentIdentity = 'original';
    const signaled: string[] = [];
    const closed: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const deps = {
      repositoryRoot: root,
      listProcesses: () => [processFixture({ pid, command: `bun ${root}/bin/elanous.mjs self orchestrate --goal-file goal.md`,
        ownership: { status: 'observed' as const, runId: 'run-a' } })],
      openProcessHandle: () => {
        const capturedIdentity = currentIdentity;
        return { signal: () => { signaled.push(capturedIdentity); }, close: () => { closed.push(capturedIdentity); } };
      },
      readStartTime: () => { currentIdentity = 'replacement'; return 'Thu Oct  2 22:49:07 2026'; },
      lookupLedger: () => [{ event: 'run-status', data: { runStatus: 'completed' } }],
    };
    try {
      expect(killHarnessProcess(pid, false, deps).outcome).toBe('sent');
      expect(signaled).toEqual(['original']);
      expect(closed).toEqual(['original']);
      expect(killHarnessProcess(pid, false, { ...deps, openProcessHandle: () => { throw new Error('pidfd unsupported'); } }))
        .toMatchObject({ outcome: 'refused', reason: 'pid-bound signaling unavailable: pidfd unsupported' });
      expect(signaled).toEqual(['original']);
    } finally { log.mockRestore(); }
  });

  test('Linux pidfd delivers SIGTERM to the checked child, not via a later PID lookup', async () => {
    if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) return;
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      const pid = child.pid!;
      const root = '/tmp/owned-elanous-repo';
      const exit = new Promise<{ signal: NodeJS.Signals | null }>((resolve) => {
        child.once('exit', (_code, signal) => resolve({ signal }));
      });
      expect(killHarnessProcess(pid, false, {
        repositoryRoot: root,
        listProcesses: () => [processFixture({ pid, command: `bun ${root}/bin/elanous.mjs self orchestrate --goal-file goal.md`,
          ownership: { status: 'observed', runId: 'run-a' } })],
        readStartTime: () => 'Thu Oct  2 22:49:07 2026',
        lookupLedger: () => [{ event: 'run-status', data: { runStatus: 'completed' } }],
      })).toMatchObject({ outcome: 'sent', owned: true });
      expect(await exit).toEqual({ signal: 'SIGTERM' });
    } finally { child.kill(); log.mockRestore(); }
  });

  test('goal PR and runId show the authored goal, recorded outcome and matching universe', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-goal-'));
    const goalsDir = join(root, 'goals');
    const runsDir = join(root, 'runs');
    mkdirSync(goalsDir);
    mkdirSync(runsDir);
    const runId = 'run-cli-child';
    writeFileSync(join(goalsDir, 'GOAL-cli.txt'), 'Build the CLI\n- KanId: TC-7\n## 실행 기록\n- runId: run-cli-child\n  stage: merged\n  outcome: completed\n  prNumber: 42\n');
    writeFileSync(join(runsDir, 'parent.json'), JSON.stringify({ runId: 'parent', createdAt: 1, updatedAt: 2,
      supervisorStopReason: 'converged', results: [{ runId, status: 'done', stage: 'merged', prNumber: 42 }] }));
    const program = new Command().exitOverride();
    const harness = installHarnessCliCommand(program, {
      registerSink: async () => {}, resolveSurface: async () => 'harness', goalLookup: { goalsDir, runsDir },
    });
    const previousExit = process.exitCode;
    try {
      expect(harness.commands.map((command) => command.name())).toContain('goal');
      expect(harness.commands.find((command) => command.name() === 'goal')?.helpInformation()).toContain('<reference>');
      for (const reference of ['42', runId]) {
        process.exitCode = 0;
        const lines = await captureLog(() => program.parseAsync(['node', 'elanous', 'harness', 'goal', reference]));
        expect(lines).toEqual([[
          '골: Build the CLI', `runId: ${runId}`, '칸 id: TC-7', 'PR: #42',
          'stage/결과: merged / completed', '종결 사유: converged', '찾은 우주: 시험',
          '원장: 찾음', '골 문서: 찾음',
        ].join('\n')]);
        expect(process.exitCode).toBe(0);
      }
      const json = await captureLog(() => program.parseAsync(['node', 'elanous', 'harness', 'goal', '#42', '--json']));
      expect(json).toHaveLength(1);
      expect(JSON.parse(json[0]!)).toEqual({
        goalBody: 'Build the CLI\n- KanId: TC-7', goalFile: join(goalsDir, 'GOAL-cli.txt'), kanId: 'TC-7', runId,
        record: { runId, stage: 'merged', outcome: 'completed', prNumber: 42 },
        runState: { runId: 'parent', createdAt: 1, updatedAt: 2, supervisorStopReason: 'converged',
          results: [{ runId, status: 'done', stage: 'merged', prNumber: 42 }] },
      });
      expect(process.exitCode).toBe(0);
    } finally { process.exitCode = previousExit ?? 0; rmSync(root, { recursive: true, force: true }); }
  });

  test('goal missing run ledger or goal document is explicit and exits 1 in human and JSON modes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-goal-missing-'));
    const goalsDir = join(root, 'goals');
    const runsDir = join(root, 'runs');
    mkdirSync(goalsDir);
    mkdirSync(runsDir);
    writeFileSync(join(goalsDir, 'GOAL-only.md'), 'Only authored\n## 실행 기록\n- runId: run-no-ledger\n  stage: merged\n  outcome: completed\n  prNumber: 17\n');
    writeFileSync(join(runsDir, 'run-no-document.json'), JSON.stringify({ runId: 'run-no-document',
      createdAt: 1, updatedAt: 2, results: [] }));
    const program = new Command().exitOverride();
    installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness',
      goalLookup: { goalsDir, runsDir } });
    const previousExit = process.exitCode;
    try {
      for (const [reference, missing] of [['17', '원장에 없음'], ['run-no-document', '골 문서에 없음'],
        ['999', '원장에 없음']] as const) {
        process.exitCode = 0;
        const lines = await captureLog(() => program.parseAsync(['node', 'elanous', 'harness', 'goal', reference]));
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain(missing);
        expect(lines[0]).toContain('찾은 우주: 시험');
        expect(process.exitCode).toBe(1);
        process.exitCode = 0;
        const json = await captureLog(() => program.parseAsync(['node', 'elanous', 'harness', 'goal', reference, '--json']));
        expect(json).toHaveLength(1);
        const parsed = JSON.parse(json[0]!);
        expect(Object.keys(parsed).sort()).toEqual(['goalBody', 'goalFile', 'kanId', 'record', 'runId', 'runState']);
        expect(parsed[missing === '원장에 없음' ? 'runState' : 'goalFile']).toBeNull();
        expect(process.exitCode).toBe(1);
      }
    } finally { process.exitCode = previousExit ?? 0; rmSync(root, { recursive: true, force: true }); }
  });

  test('drafts metrics JSON includes overlap from injected adapters and preserves draft counts when overlap throws', async () => {
    const lines: string[] = [];
    const now = new Date('2026-10-08T12:00:00Z');
    const adapters = {
      listDrafts: async () => [], listMerged: async () => [], listRecentClosed: async () => [],
      getActiveClaimOwner: async () => undefined, getRunStatus: async () => undefined,
      listLiveBranches: async () => new Set<string>(), setLabels: async () => {}, closeDraft: async () => {},
    };
    let fail = false;
    const overlapAdapters = {
      ...adapters,
      listPreflightRows: async () => {
        if (fail) throw new Error('overlap source offline');
        return [{ ts: now.toISOString(), data: { runId: 'run-abcdef1234', blockers: [],
          warnings: [{ kind: 'open-pr', name: '#42' }], paths: ['src/a.ts'],
          openPrs: { state: 'checked' }, liveRuns: { state: 'checked' } } }];
      },
      listSalvagedRows: async () => [],
    };
    const { program } = install(undefined, undefined, undefined, undefined, undefined, undefined,
      { adapters, overlapAdapters, repository: () => 'my/repo', now: () => now, write: (line) => lines.push(line) });
    const previousExit = process.exitCode;
    try {
      process.exitCode = 0;
      await program.parseAsync(['node', 'elanous', 'harness', 'drafts', 'metrics', '--json']);
      expect(lines).toHaveLength(1);
      const measured = JSON.parse(lines[0]!);
      expect(measured).toMatchObject({ repository: 'my/repo', inventory: 0, needsOwner: 0, overlap: { launches24h: 1 } });
      expect(process.exitCode).toBe(0);
      fail = true;
      lines.length = 0;
      await program.parseAsync(['node', 'elanous', 'harness', 'drafts', 'metrics', '--json']);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toEqual({ ...measured, overlap: null });
      expect(process.exitCode).toBe(0);
    } finally { process.exitCode = previousExit ?? 0; }
  });

  test('draft sweep is installed by default; dry-run and apply pass repository and actions through the CLI', async () => {
    const labels: unknown[] = [];
    const closed: unknown[] = [];
    const pages: unknown[] = [];
    const statuses: unknown[] = [];
    const lines: string[] = [];
    const draft = { number: 43, title: 'old goal', branch: 'self-impl/old',
      labels: ['elanous:stalled'], createdAt: '2026-09-01T00:00:00Z' };
    const adapters = {
      listDrafts: async (page: number, size: number, repository: string) => {
        pages.push(['drafts', page, size, repository]);
        return page === 1 ? [draft] : [];
      },
      listMerged: async (page: number, size: number, repository: string) => {
        pages.push(['merged', page, size, repository]);
        return [];
      },
      getRunStatus: async (...args: unknown[]) => { statuses.push(args); return 'failed'; },
      listLiveBranches: async () => new Set<string>(),
      setLabels: async (...args: unknown[]) => { labels.push(args); },
      closeDraft: async (...args: unknown[]) => { closed.push(args); },
    };
    const { program, harness } = install(undefined, undefined, undefined, undefined, undefined, undefined,
      { adapters, repository: () => 'default/repo', write: (line) => lines.push(line) });
    const drafts = harness.commands.find((command) => command.name() === 'drafts')!;
    expect(drafts.commands.find((command) => command.name() === 'sweep')?.options.map((option) => option.long))
      .toEqual(['--apply', '--json', '--repo', '--close-cap', '--max-pages', '--max-drafts', '--max-merged', '--emit-apply-plan', '--apply-plan-file']);
    await program.parseAsync(['node', 'elanous', 'harness', 'drafts', 'sweep', '--json', '--repo', 'my/repo']);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ repository: 'my/repo', apply: false, complete: true,
      entries: [{ number: 43, action: 'close', applied: false }] });
    expect(pages).toContainEqual(['drafts', 1, 100, 'my/repo']);
    expect(statuses).toEqual([[draft, 'my/repo']]);
    expect(closed).toEqual([]);
    expect(labels).toEqual([]);
    await program.parseAsync(['node', 'elanous', 'harness', 'drafts', 'sweep', '--apply']);
    expect(statuses).toEqual([[draft, 'my/repo'], [draft, 'default/repo']]);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toEqual(['default/repo', 43]);
    expect(labels).toEqual([['default/repo', 43, { add: 'elanous:swept:stale-ended-run', remove: [] }]]);
    expect(lines.at(-2)).toContain('#43 close:');
    expect(lines.at(-1)).toBe('못 본 초안 0 · 이번에 닫음 1 · 처리 중 0 · 표식 만료 0 · 24h 넘음 1 · 정리 대상 0 · 수확 대기 0 · 막힘 0');
  });

  test('draft sweep JSON waits for the stdout write callback when emitting a large result', async () => {
    const drafts = Array.from({ length: 80 }, (_, index) => ({
      number: 10_000 + index, title: `draft ${index}`, branch: `self-impl/draft-${index}`,
      labels: [], body: '', createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
    }));
    const adapters = {
      listDrafts: async (page: number) => page === 1 ? drafts : [],
      listMerged: async () => [],
      listLiveBranches: async () => new Set<string>(),
      getRunStatus: async () => undefined,
      setLabels: async () => {},
      closeDraft: async () => {},
    };
    const { program } = install(undefined, undefined, undefined, undefined, undefined, undefined,
      { adapters, repository: () => 'owner/repo' });
    const originalWrite = process.stdout.write;
    const originalLog = console.log;
    const previousExitCode = process.exitCode;
    let output = '';
    let finishWrite: (() => void) | undefined;
    process.exitCode = 0;
    process.stdout.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
      output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
      finishWrite = () => done?.();
      return false;
    }) as typeof process.stdout.write;
    console.log = () => { throw new Error('draft sweep JSON must use the awaited stdout helper'); };
    try {
      let settled = false;
      const action = program.parseAsync(['node', 'elanous', 'harness', 'drafts', 'sweep', '--json'])
        .finally(() => { settled = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(Buffer.byteLength(output)).toBeGreaterThan(65_536);
      expect(output.endsWith('\n')).toBe(true);
      expect(settled).toBe(false);
      finishWrite?.();
      await action;
      expect(settled).toBe(true);
      expect(process.exitCode).toBe(0);
    } finally {
      process.stdout.write = originalWrite;
      console.log = originalLog;
      process.exitCode = previousExitCode ?? 0;
    }
  });

  test('draft sweep --close-cap overrides config tools.selfImplement.draftSweepCloseCap; an invalid config falls back to 10', async () => {
    const drafts = Array.from({ length: 40 }, (_, i) => ({ number: 300 + i, title: `goal ${i}`, branch: `self-impl/cap-${i}`,
      labels: ['elanous:stalled'], createdAt: '2026-09-01T00:00:00Z' }));
    const adapters = {
      listDrafts: async (page: number) => page === 1 ? drafts : [],
      listMerged: async () => [],
      getRunStatus: async () => 'failed',
      listLiveBranches: async () => new Set<string>(),
      setLabels: async () => {},
      closeDraft: async () => {},
    };
    let configCap: unknown = 30;
    const lines: string[] = [];
    const { program } = install(undefined, undefined, undefined, undefined, undefined, undefined,
      { adapters, repository: () => 'default/repo', write: (line) => lines.push(line), closeCapConfig: () => configCap });
    const run = async (...extra: string[]) => {
      await program.parseAsync(['node', 'elanous', 'harness', 'drafts', 'sweep', '--json', ...extra]);
      return JSON.parse(lines.at(-1)!) as { closed: number; closeCap: number; closeCapSource: string };
    };
    expect(await run()).toMatchObject({ closed: 30, closeCap: 30, closeCapSource: 'config' });
    expect(await run('--close-cap', '5')).toMatchObject({ closed: 5, closeCap: 5, closeCapSource: 'flag' });
    configCap = 500;
    const errors = await captureError(() => run());
    expect(errors.join('\n')).toContain('draftSweepCloseCap');
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ closed: 10, closeCap: 10, closeCapSource: 'default' });
  });

  test('draft sweep outside a git checkout uses harness.repo and never calls gh repo view', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'draft-sweep-outside-'));
    const previous = process.cwd();
    const gh = process.env.GH_REPO;
    delete process.env.GH_REPO;
    const calls: string[][] = [];
    const lines: string[] = [];
    const adapters = {
      listDrafts: async (_page: number, _size: number, repository: string) => {
        calls.push(['list', repository]);
        return [];
      },
      listMerged: async () => [],
      getRunStatus: async () => undefined,
      listLiveBranches: async () => new Set<string>(),
      setLabels: async () => {},
      closeDraft: async () => {},
    };
    const { program } = install(undefined, undefined, undefined, undefined, undefined, undefined, {
      adapters,
      execute: (args) => { calls.push(args); return 'gh/should-not-run'; },
      write: (line) => lines.push(line),
    });
    setUserConfigOverlay((config) => ({ ...config, harness: { ...config.harness, repo: 'config/repo' } }));
    const previousExit = process.exitCode;
    try {
      process.chdir(outside);
      await program.parseAsync(['node', 'elanous', 'harness', 'drafts', 'sweep', '--json']);
      expect(calls.filter((args) => args[0] === 'repo' && args[1] === 'view')).toEqual([]);
      expect(calls).toContainEqual(['list', 'config/repo']);
      expect(JSON.parse(lines.at(-1)!).repository).toBe('config/repo');

      calls.length = 0;
      lines.length = 0;
      setUserConfigOverlay(null);
      process.exitCode = 0;
      const errors = await captureError(() => program.parseAsync(['node', 'elanous', 'harness', 'drafts', 'sweep', '--json']));
      expect(calls.filter((args) => args[0] === 'repo' && args[1] === 'view')).toEqual([]);
      expect(errors.join('\n')).toContain('저장소 이름 없음 — --repo 또는 harness.repo 설정');
      expect(errors.join('\n')).not.toContain('\n    at ');
      expect(process.exitCode).toBe(1);
    } finally {
      process.chdir(previous);
      if (gh === undefined) delete process.env.GH_REPO;
      else process.env.GH_REPO = gh;
      setUserConfigOverlay(null);
      process.exitCode = previousExit ?? 0;
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('draft sweep reports fresh claims and expired claims in JSON and the human summary', async () => {
    const lines: string[] = [];
    const now = Date.now();
    const draft = (number: number, hours: number) => ({ number, title: 'goal', branch: `self-impl/${number}`,
      labels: ['elanous:running'], createdAt: new Date(now - 72 * 3_600_000).toISOString(),
      updatedAt: new Date(now - hours * 3_600_000).toISOString() });
    const adapters = {
      listDrafts: async () => [draft(1, 2), draft(2, 7)], listMerged: async () => [],
      getRunStatus: async () => undefined, listLiveBranches: async () => new Set<string>(),
      setLabels: async () => {}, closeDraft: async () => {},
    };
    const { program } = install(undefined, undefined, undefined, undefined, undefined, undefined,
      { adapters, repository: () => 'my/repo', write: (line) => lines.push(line) });
    await program.parseAsync(['node', 'elanous', 'harness', 'drafts', 'sweep', '--json']);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ claimed: 1, claimExpired: 1, closed: 1 });
    await program.parseAsync(['node', 'elanous', 'harness', 'drafts', 'sweep']);
    expect(lines.at(-1)).toBe('못 본 초안 0 · 이번에 닫음 1(dry-run) · 처리 중 1 · 표식 만료 1 · 24h 넘음 2 · 정리 대상 0 · 수확 대기 0 · 막힘 0');
  });

  test('RUN-TTL GitHub adapters: open self-impl listing, head commit time, and a durable memo journal', async () => {
    const { githubRunTtlAdapters } = await import('./harness-cli-command.js');
    const root = mkdtempSync(join(tmpdir(), 'run-ttl-adapter-'));
    const calls: string[][] = [];
    const execute = (args: string[]) => {
      calls.push(args);
      if (args[1]?.includes('pulls?state=open')) return JSON.stringify([
        { number: 5, title: 't', draft: true, state: 'open', head: { ref: 'self-impl/a', sha: 'abc' }, base: { ref: 'main' }, labels: [], created_at: '2026-10-01T00:00:00Z', merged_at: null },
        { number: 6, title: 't', draft: true, state: 'open', head: { ref: 'feature/x', sha: 'def' }, base: { ref: 'main' }, labels: [], created_at: '2026-10-01T00:00:00Z', merged_at: null },
      ]);
      if (args[1]?.includes('commits?sha=abc')) return JSON.stringify([{ sha: 'abc', commit: { committer: { date: '2026-10-02T00:00:00Z' } } }]);
      throw new Error(`unexpected gh ${args.join(' ')}`);
    };
    try {
      const adapters = await githubRunTtlAdapters('my/repo', execute, async (args) => execute(args), root);
      const open = await adapters.listOpenPrs();
      expect(open).toEqual([{ number: 5, branch: 'self-impl/a', labels: [], createdAt: '2026-10-01T00:00:00Z', headSha: 'abc' }]);
      expect(await adapters.lastCommitAt(open[0]!)).toBe('2026-10-02T00:00:00Z');
      expect(adapters.memoSent!('5:abc')).toBe(false);
      adapters.recordMemoSent!('5:abc');
      const reopened = await githubRunTtlAdapters('my/repo', execute, async (args) => execute(args), root);
      expect(reopened.memoSent!('5:abc')).toBe(true);
      expect(reopened.memoSent!('5:new')).toBe(false);
      // An unreadable journal (here: a directory where the file should be) cannot prove «once».
      const broken = mkdtempSync(join(tmpdir(), 'run-ttl-adapter-broken-'));
      mkdirSync(join(broken, 'run-ttl', 'memos.jsonl'), { recursive: true });
      const unreadable = await githubRunTtlAdapters('my/repo', execute, async (args) => execute(args), broken);
      expect(() => unreadable.memoSent!('5:abc')).toThrow();
      rmSync(broken, { recursive: true, force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('draft sweep runs the RUN-TTL step: shadow by default (no writes), live from tools.selfImplement.runTtl', async () => {
    const lines: string[] = [];
    const now = Date.now();
    const labels: unknown[] = [];
    const memos: unknown[] = [];
    const adapters = {
      listDrafts: async () => [], listMerged: async () => [],
      getRunStatus: async () => undefined, listLiveBranches: async () => new Set<string>(),
      setLabels: async () => {}, closeDraft: async () => {},
    };
    const runTtl = {
      listOpenPrs: async () => [{ number: 7, branch: 'self-impl/old', labels: [], createdAt: new Date(now - 72 * 3_600_000).toISOString(), headSha: 'abc' }],
      lastCommitAt: async () => new Date(now - 48 * 3_600_000).toISOString(),
      resolveRun: async () => ({ alive: false as const, reason: 'owner-run-unknown' }),
      sendMemo: (...args: unknown[]) => { memos.push(args); },
      addLabel: (...args: unknown[]) => { labels.push(args); },
    };
    const { program } = install(undefined, undefined, undefined, undefined, undefined, undefined,
      { adapters, runTtl, repository: () => 'my/repo', write: (line) => lines.push(line) });
    try {
      await program.parseAsync(['node', 'elanous', 'harness', 'drafts', 'sweep', '--json']);
      expect(JSON.parse(lines.at(-1)!).runTtl).toMatchObject({ mode: 'shadow', stale: [7], label: [7] });
      expect(labels).toEqual([]);
      setUserConfigOverlay((config) => ({ ...config, tools: { ...config.tools,
        selfImplement: { ...config.tools.selfImplement, runTtl: { mode: 'live' } } } }));
      await program.parseAsync(['node', 'elanous', 'harness', 'drafts', 'sweep', '--json']);
      expect(JSON.parse(lines.at(-1)!).runTtl).toMatchObject({ mode: 'live', label: [7] });
      expect(labels).toEqual([[7, 'elanous:needs-rebase']]);
      expect(memos).toEqual([]);
    } finally {
      setUserConfigOverlay(null);
    }
  });

  test('draft sweep RUN-TTL: tools.selfImplement.runTtl.cap bounds the whole sweep at one action', async () => {
    const lines: string[] = [];
    const now = Date.now();
    const labels: unknown[] = [];
    const adapters = {
      listDrafts: async () => [], listMerged: async () => [],
      getRunStatus: async () => undefined, listLiveBranches: async () => new Set<string>(),
      setLabels: async () => {}, closeDraft: async () => {},
    };
    const stalePr = (number: number, commitHoursAgo: number) => ({
      number, branch: `self-impl/${number}`, labels: [],
      createdAt: new Date(now - 96 * 3_600_000).toISOString(), headSha: `sha${number}`,
    });
    const runTtl = {
      listOpenPrs: async () => [stalePr(11, 48), stalePr(12, 60)],
      lastCommitAt: async (pr: { number: number }) => new Date(now - (pr.number === 12 ? 60 : 48) * 3_600_000).toISOString(),
      resolveRun: async () => ({ alive: false as const, reason: 'owner-run-unknown' }),
      sendMemo: (...args: unknown[]) => { throw new Error(`unexpected memo ${JSON.stringify(args)}`); },
      addLabel: (...args: unknown[]) => { labels.push(args); },
    };
    const { program } = install(undefined, undefined, undefined, undefined, undefined, undefined,
      { adapters, runTtl, repository: () => 'my/repo', write: (line) => lines.push(line) });
    try {
      setUserConfigOverlay((config) => ({ ...config, tools: { ...config.tools,
        selfImplement: { ...config.tools.selfImplement, runTtl: { mode: 'live', cap: 1 } } } }));
      await program.parseAsync(['node', 'elanous', 'harness', 'drafts', 'sweep', '--json']);
      expect(JSON.parse(lines.at(-1)!).runTtl).toMatchObject({ mode: 'live', label: [12], skippedOverCap: [11] });
      expect(labels).toEqual([[12, 'elanous:needs-rebase']]);
    } finally {
      setUserConfigOverlay(null);
    }
  });

  test('draft sweep apply transitions stale running label before close and dry-run leaves both untouched', async () => {
    const labels: unknown[] = [];
    const closed: unknown[] = [];
    const lines: string[] = [];
    const adapters = {
      listDrafts: async () => [{ number: 44, title: 'pending goal', branch: 'self-impl/old',
        labels: ['elanous:running'], createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' }],
      listMerged: async () => [],
      getRunStatus: async () => 'failed',
      listLiveBranches: async () => new Set<string>(),
      setLabels: async (...args: unknown[]) => { labels.push(args); },
      closeDraft: async (...args: unknown[]) => { closed.push(args); },
    };
    const { program } = install(undefined, undefined, undefined, undefined, undefined, undefined,
      { adapters, repository: () => 'my/repo', write: (line) => lines.push(line) });
    await program.parseAsync(['node', 'elanous', 'harness', 'drafts', 'sweep', '--json']);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ apply: false,
      entries: [{ statusLabel: 'elanous:stalled', applied: false }] });
    expect(labels).toEqual([]);
    expect(closed).toEqual([]);
    await program.parseAsync(['node', 'elanous', 'harness', 'drafts', 'sweep', '--json', '--apply']);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ apply: true,
      entries: [{ statusLabel: 'elanous:stalled', applied: true }] });
    expect(labels).toEqual([
      ['my/repo', 44, { add: 'elanous:stalled', remove: ['elanous:running'] }],
      ['my/repo', 44, { add: 'elanous:swept:claim-expired', remove: [] }],
    ]);
    expect(closed).toHaveLength(1);
  });

  test('drafts claim labels a draft, removes other states, records owner/note, and release transitions running to stalled', async () => {
    const requests: string[][] = [];
    let labels = [{ name: 'elanous:stalled' }, { name: 'elanous:from-harness' }];
    const lines: string[] = [];
    const { program, harness } = install(undefined, undefined, undefined, undefined, undefined, undefined, {
      repository: () => 'my/repo', write: (line) => lines.push(line), now: () => new Date('2026-09-30T00:00:00Z'),
      execute: (args) => {
        requests.push(args);
        if (args[0] === 'api') return JSON.stringify({ number: 123, state: 'open', draft: true, labels });
        return '';
      },
    });
    expect(harness.commands.find((command) => command.name() === 'drafts')?.commands.map((command) => command.name()))
      .toEqual(['claim', 'metrics', 'sweep']);
    await program.parseAsync(['node', 'elanous', 'harness', 'drafts', 'claim', '123', '--owner', 'T', '--note', '재작업 중']);
    expect(requests).toEqual([
      ['api', 'repos/my/repo/pulls/123'],
      ['pr', 'edit', '123', '--repo', 'my/repo', '--add-label', 'elanous:running', '--remove-label', 'elanous:stalled'],
      ['pr', 'comment', '123', '--repo', 'my/repo', '--body', '🔧 처리 중 — owner T · 2026-09-30T00:00:00.000Z · 재작업 중'],
    ]);
    expect(lines).toEqual(['#123 claim: my/repo']);
    requests.length = 0;
    labels = [{ name: 'elanous:running' }];
    await program.parseAsync(['node', 'elanous', 'harness', 'drafts', 'claim', '123', '--release', '--repo', 'my/repo']);
    expect(requests).toEqual([
      ['api', 'repos/my/repo/pulls/123'],
      ['pr', 'edit', '123', '--repo', 'my/repo', '--add-label', 'elanous:stalled', '--remove-label', 'elanous:running'],
      ['pr', 'comment', '123', '--repo', 'my/repo', '--body', '🔧 처리 끝 — 2026-09-30T00:00:00.000Z'],
    ]);
  });

  test('drafts claim release rejects a missing or conflicting running state without gh writes', async () => {
    const writes: string[][] = [];
    let labels = [{ name: 'elanous:stalled' }];
    const { program } = install(undefined, undefined, undefined, undefined, undefined, undefined, {
      repository: () => 'my/repo', execute: (args) => {
        if (args[0] !== 'api') writes.push(args);
        return JSON.stringify({ number: 123, state: 'open', draft: true, labels });
      },
    });
    const previousExit = process.exitCode;
    try {
      for (const state of [[{ name: 'elanous:stalled' }],
        [{ name: 'elanous:running' }, { name: 'elanous:stalled' }]]) {
        labels = state;
        process.exitCode = 0;
        const errors = await captureError(() => program.parseAsync(['node', 'elanous', 'harness', 'drafts', 'claim', '123', '--release']));
        expect(errors).toEqual(['❌ --release 는 running 이 유일한 상태인 draft 에만 사용 가능']);
        expect(writes).toEqual([]);
        expect(process.exitCode).toBe(1);
      }
    } finally { process.exitCode = previousExit ?? 0; }
  });

  test('drafts claim refuses idea-approval or ready PR without any gh writes', async () => {
    const writes: string[][] = [];
    let labels = [{ name: 'elanous:idea-approval' }];
    let draft = true;
    const { program } = install(undefined, undefined, undefined, undefined, undefined, undefined, {
      repository: () => 'my/repo', execute: (args) => {
        if (args[0] !== 'api') writes.push(args);
        return JSON.stringify({ number: 123, state: 'open', draft, labels });
      },
    });
    const previousExit = process.exitCode;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        process.exitCode = 0;
        const errors = await captureError(() => program.parseAsync(['node', 'elanous', 'harness', 'drafts', 'claim', '123', '--owner', 'T']));
        expect(errors).toEqual(['❌ 열린 draft 이고 idea-approval 이 아닌 PR 만 claim 할 수 있음']);
        expect(writes).toEqual([]);
        expect(process.exitCode).toBe(1);
        labels = [];
        draft = false;
      }
    } finally { process.exitCode = previousExit ?? 0; }
  });

  test('drafts claim and release refuse closed or merged drafts without gh writes', async () => {
    const requests: string[][] = [];
    let mergedAt: string | null = null;
    const { program } = install(undefined, undefined, undefined, undefined, undefined, undefined, {
      repository: () => 'my/repo', execute: (args) => {
        requests.push(args);
        return JSON.stringify({ number: 123, state: 'closed', draft: true,
          merged_at: mergedAt, labels: [{ name: 'elanous:running' }] });
      },
    });
    const previousExit = process.exitCode;
    try {
      for (const mergeTime of [null, '2026-09-29T00:00:00Z']) {
        mergedAt = mergeTime;
        for (const options of [['--owner', 'T'], ['--release']]) {
          process.exitCode = 0;
          const errors = await captureError(() => program.parseAsync(['node', 'elanous', 'harness', 'drafts', 'claim', '123', ...options]));
          expect(errors).toEqual(['❌ 열린 draft 이고 idea-approval 이 아닌 PR 만 claim 할 수 있음']);
          expect(process.exitCode).toBe(1);
        }
      }
      expect(requests).toEqual(Array.from({ length: 4 }, () => ['api', 'repos/my/repo/pulls/123']));
    } finally { process.exitCode = previousExit ?? 0; }
  });

  test('merge-time GitHub adapter reuses open-draft inventory and liveness without listing closed PRs', async () => {
    const ghFake = createFakeGh({ repository: 'my/repo', prs: [
      { number: 90, title: 'same goal', branch: 'self-impl/merged-goalid-abcd-new', closed: true,
        createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', mergedAt: '2026-10-02T00:00:00Z' },
      { number: 1, title: 'same goal', branch: 'self-impl/old-goalid-abcd-r1', draft: true,
        labels: ['elanous:stalled'], createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
      { number: 2, title: 'same goal', branch: 'self-impl/release-goalid-abcd-r2', draft: true,
        labels: ['elanous:stalled', RELEASE_PATH_LABEL], createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
      { number: 3, title: 'another goal', branch: 'self-impl/other', draft: true,
        labels: ['elanous:stalled'], createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
      { number: 4, title: 'same goal', branch: 'self-impl/live-goalid-abcd-r4', draft: true,
        labels: ['elanous:stalled'], createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
    ] });
    const requests = ghFake.calls;
    const gh = ghFake.api;
    const git = (_cwd: string, args: string[]) => ({ status: 0, stderr: '', stdout: args[0] === 'config'
      ? 'https://github.com/my/repo.git' : 'worktree /tmp/live\nbranch refs/heads/self-impl/live-goalid-abcd-r4\n' });
    await supersedeMergedGoalDrafts(90, '/tmp/launch-tree', gh, git);
    expect(requests[0]).toEqual(['api', 'repos/my/repo/pulls/90']);
    const inventoryQuery = requests.find((args) => args[0] === 'api' && args[1] === 'graphql')?.[3] ?? '';
    expect(inventoryQuery).toContain('p1: pullRequest');
    expect(inventoryQuery).toContain('p2: pullRequest');
    expect(inventoryQuery).toContain('p3: pullRequest');
    expect(inventoryQuery).toContain('p4: pullRequest');
    expect(requests.filter((args) => args[0] === 'label')).toEqual([
      ['label', 'create', 'elanous:swept:superseded-by', '--repo', 'my/repo', '--color', '6A737D',
        '--description', 'Draft sweep close reason; reopen this PR to restore it', '--force'],
    ]);
    expect(requests.filter((args) => args[0] === 'pr')).toEqual([
      ['pr', 'edit', '1', '--repo', 'my/repo', '--add-label', 'elanous:superseded', '--remove-label', 'elanous:stalled'],
      ['pr', 'edit', '1', '--repo', 'my/repo', '--add-label', 'elanous:swept:superseded-by'],
      ['pr', 'close', '1', '--repo', 'my/repo'],
    ]);
    requests.length = 0;
    await expect(supersedeMergedGoalDrafts(90, '/tmp/launch-tree', () => { throw new Error('GitHub unavailable'); }, git))
      .rejects.toThrow('GitHub unavailable');
    expect(requests).toEqual([]);
    await expect(supersedeMergedGoalDrafts(90, '/tmp/launch-tree', gh,
      (_cwd, args) => ({ status: 1, stdout: '', stderr: `unavailable: ${args[0]}` })))
      .rejects.toThrow('Merge repository unavailable');
    expect(requests).toEqual([]);
  });

  test('merge-time explicit same-cell cleanup reads only the merged PR when Supersedes is absent', async () => {
    const requests: string[][] = [];
    const gh = (args: string[]) => {
      requests.push(args);
      if (args[1] === 'repos/my/repo/pulls/90') return JSON.stringify({
        number: 90, state: 'closed', title: 'merged', head: { ref: 'feature/merged' }, labels: [],
        created_at: '2026-10-01T00:00:00Z', merged_at: '2026-10-02T00:00:00Z', body: '칸: CELL-A',
      });
      throw new Error('unexpected GitHub call');
    };
    const git = () => ({ status: 0, stdout: 'https://github.com/my/repo.git', stderr: '' });
    await supersedeMergedGoalDrafts(90, '/tmp/launch-tree', gh, git, { onlyExplicitSameCell: true });
    expect(requests).toEqual([['api', 'repos/my/repo/pulls/90']]);
  });

  test('merge-time explicit same-cell cleanup verifies MERGED and writes label, replacement comment, close', async () => {
    const writes: string[][] = [];
    const merged = { number: 90, state: 'closed', title: 'new cell draft', head: { ref: 'self-impl/new-cell' },
      labels: [], created_at: '2026-10-01T00:00:00Z', merged_at: '2026-10-02T00:00:00Z',
      body: '칸: CELL-A\n카드: card-a\n\nSupersedes: #7' };
    const gh = (args: string[]) => {
      if (args[0] === 'pr' || args[0] === 'label') { writes.push(args); return ''; }
      if (args[1] === 'repos/my/repo/pulls/90') return JSON.stringify(merged);
      if (args[1]?.includes('state=open')) return JSON.stringify([{ number: 7, draft: true, state: 'open',
        title: 'old cell draft', head: { ref: 'self-impl/old-cell' }, labels: [{ name: 'elanous:running' }],
        created_at: '2026-09-30T00:00:00Z', merged_at: null, body: '칸: CELL-A\n카드: card-a' }]);
      if (args[1]?.includes('/files?') || args[1]?.includes('/comments?')) return '[]';
      return '{}';
    };
    const git = (_cwd: string, args: string[]) => ({ status: 0, stderr: '', stdout: args[0] === 'config'
      ? 'https://github.com/my/repo.git' : '' });
    await supersedeMergedGoalDrafts(90, '/tmp/launch-tree', gh, git, { onlyExplicitSameCell: true });
    expect(writes.map((args) => args.slice(0, 3))).toEqual([
      ['pr', 'edit', '7'], ['pr', 'comment', '7'], ['pr', 'close', '7'],
    ]);
    expect(writes[1]?.at(-1)).toContain('Same-cell draft superseded by merged PR #90 (https://github.com/my/repo/pull/90). Branch preserved.');
  });

  test('same-cell comment inventory refuses a 100-page partial read before any cleanup write', async () => {
    const requests: string[][] = [];
    const adapters = githubDraftSweepAdapters((args) => {
      requests.push(args);
      if (args[1]?.includes('/comments?')) return JSON.stringify(Array.from({ length: 100 }, () => ({ body: 'old' })));
      throw new Error('unexpected GitHub call');
    });
    await expect(adapters.listIssueComments!('my/repo', 7)).rejects.toThrow('Same-cell comment inventory exceeded pagination limit');
    expect(requests).toHaveLength(100);
    expect(requests.every((args) => args[0] === 'api')).toBe(true);
  });

  test('merge-time lookup uses edited GitHub goal metadata and refuses unmerged or incomplete PRs', async () => {
    const writes: string[][] = [];
    const merged = { number: 90, state: 'closed', draft: false, title: 'edited goal',
      head: { ref: 'self-impl/edited' }, labels: [], body: '칸: UX 10-04\n골: edited goal',
      created_at: '2026-10-01T00:00:00Z', merged_at: '2026-10-02T00:00:00Z' };
    let observed: Record<string, unknown> = merged;
    const gh = (args: string[]) => {
      if (args[0] === 'pr' || args[0] === 'label') { writes.push(args); return ''; }
      if (args[1] === 'repos/my/repo/pulls/90') return JSON.stringify(observed);
      if (args[1]?.includes('state=open')) return JSON.stringify([
        { number: 1, draft: true, title: 'edited goal', head: { ref: 'self-impl/old' },
          labels: [{ name: 'elanous:stalled' }], created_at: '2026-09-01T00:00:00Z', merged_at: null,
          body: '칸: UX 10-04\n골: edited goal' },
      ]);
      if (args[1]?.includes('/files?')) return '[]';
      throw new Error(`unexpected lookup ${args.join(' ')}`);
    };
    const git = (_cwd: string, args: string[]) => ({ status: 0, stderr: '', stdout: args[0] === 'config'
      ? 'https://github.com/my/repo.git' : 'worktree /tmp/main\nbranch refs/heads/main\n' });
    await supersedeMergedGoalDrafts(90, '/tmp/launch-tree', gh, git);
    expect(writes).toEqual([
      ['pr', 'edit', '1', '--repo', 'my/repo', '--add-label', 'elanous:superseded', '--remove-label', 'elanous:stalled'],
      ['label', 'create', 'elanous:swept:superseded-by', '--repo', 'my/repo', '--color', '6A737D',
        '--description', 'Draft sweep close reason; reopen this PR to restore it', '--force'],
      ['pr', 'edit', '1', '--repo', 'my/repo', '--add-label', 'elanous:swept:superseded-by'],
      ['pr', 'close', '1', '--repo', 'my/repo'],
    ]);
    for (const invalid of [{ ...merged, merged_at: null }, { ...merged, number: 91 },
      { ...merged, head: null }, { ...merged, created_at: 'invalid' },
      { ...merged, merged_at: '2026-09-01T00:00:00Z' }]) {
      observed = invalid;
      writes.length = 0;
      await expect(supersedeMergedGoalDrafts(90, '/tmp/launch-tree', gh, git))
        .rejects.toThrow('Merged PR metadata unavailable');
      expect(writes).toEqual([]);
    }
  });

  test('GitHub adapters page the full draft and merged inventory and pass label/close arguments without deleting branches', async () => {
    const requests: string[][] = [];
    const pr = (number: number, draft: boolean, merged = false) => ({
      number, draft, title: `goal ${number}`, head: { ref: `self-impl/${number}` }, base: { ref: 'main' },
      labels: [{ name: 'elanous:running' }], created_at: '2026-09-01T00:00:00Z',
      merged_at: merged ? '2026-09-02T00:00:00Z' : null,
    });
    const adapters = githubDraftSweepAdapters((args) => {
      requests.push(args);
      if (args[0] !== 'api') return '';
      const endpoint = args[1]!;
      if (endpoint.includes('/files?') || endpoint.includes('/comments?')) return '[]';
      if (endpoint.includes('state=open')) return JSON.stringify(endpoint.endsWith('&page=1')
        ? Array.from({ length: 100 }, (_, i) => pr(i + 1, true)) : [pr(101, true), pr(102, false)]);
      return JSON.stringify(endpoint.endsWith('&page=1')
        ? Array.from({ length: 100 }, (_, i) => pr(i + 201, false, true)) : [pr(301, false, true), pr(302, false, false)]);
    });
    expect((await adapters.listDrafts(1, 100, 'my/repo'))).toHaveLength(100);
    expect((await adapters.listDrafts(2, 100, 'my/repo')).map((entry) => entry.number)).toEqual([101]);
    expect((await adapters.listMerged(1, 100, 'my/repo'))).toHaveLength(100);
    expect((await adapters.listMerged(2, 100, 'my/repo')).map((entry) => entry.number)).toEqual([301]);
    expect(requests.filter((args) => args[0] === 'api' && args[1]?.includes('state='))).toEqual([
      ['api', 'repos/my/repo/pulls?state=open&per_page=100&page=1'],
      ['api', 'repos/my/repo/pulls?state=open&per_page=100&page=2'],
      ['api', 'repos/my/repo/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1'],
      ['api', 'repos/my/repo/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=2'],
    ]);
    await adapters.setLabels('my/repo', 3, { add: 'elanous:stalled', remove: ['elanous:running'] });
    await adapters.setLabels('my/repo', 3, { add: 'elanous:swept:superseded-by', remove: [] });
    await adapters.closeDraft('my/repo', 3);
    expect(requests.slice(-4)).toEqual([
      ['pr', 'edit', '3', '--repo', 'my/repo', '--add-label', 'elanous:stalled', '--remove-label', 'elanous:running'],
      ['label', 'create', 'elanous:swept:superseded-by', '--repo', 'my/repo', '--color', '6A737D',
        '--description', 'Draft sweep close reason; reopen this PR to restore it', '--force'],
      ['pr', 'edit', '3', '--repo', 'my/repo', '--add-label', 'elanous:swept:superseded-by'],
      ['pr', 'close', '3', '--repo', 'my/repo'],
    ]);
    expect(requests.some((args) => args.includes('--comment') || args[0] === 'comment')).toBe(false);
    await adapters.setLabels('my/repo', 4, { add: 'elanous:swept:superseded-by', remove: [] });
    expect(requests.filter((args) => args[0] === 'label' && args[1] === 'create')).toHaveLength(1);
  });

  test('draft sweep completes a 301-row merged inventory across four closed-PR pages', async () => {
    const requests: string[][] = [];
    const pr = (number: number, merged: boolean) => ({
      number, draft: false, title: `merged ${number}`, head: { ref: `self-impl/${number}` }, base: { ref: 'main' },
      labels: [], created_at: '2026-10-20T00:00:00Z', updated_at: '2026-10-23T00:00:00Z',
      merged_at: merged ? '2026-10-22T00:00:00Z' : null,
    });
    const execute = (args: string[]) => {
      requests.push(args);
      const endpoint = args[1] ?? '';
      if (endpoint.includes('state=open')) return JSON.stringify([{
        ...pr(1, false), draft: true, head: { ref: 'self-impl/open-draft' }, created_at: '2026-10-21T00:00:00Z', merged_at: null,
      }]);
      if (endpoint.includes('state=closed')) {
        const page = Number(/&page=(\d+)/.exec(endpoint)?.[1]);
        if (page <= 3) return JSON.stringify(Array.from({ length: 100 }, (_, index) => pr((page - 1) * 100 + index + 1001, true)));
        return JSON.stringify([pr(1301, true)]);
      }
      throw new Error(`unexpected GitHub request: ${endpoint}`);
    };
    const executeAsync = async (args: string[]) => {
      const query = args.find((arg) => arg.startsWith('query=')) ?? '';
      const repository: Record<string, unknown> = {};
      for (const [, rawNumber] of query.matchAll(/p(\d+): pullRequest\(number: (\d+)\)/g)) {
        const number = Number(rawNumber);
        repository[`p${number}`] = {
          number,
          files: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } },
          comments: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } },
          reviews: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } },
          mergeCommit: null,
        };
      }
      return JSON.stringify({ data: { repository } });
    };
    const git = (_cwd: string, args: string[]) => ({ status: 0, stderr: '',
      stdout: args[0] === 'config' ? 'https://github.com/my/repo.git' : '' });
    const adapters = githubDraftSweepPreviewAdapters({ maxInventoryPages: 100 }, execute, git, process.cwd(), executeAsync);

    const merged = [
      ...(await adapters.listMerged(1, 100, 'my/repo')),
      ...(await adapters.listMerged(2, 100, 'my/repo')),
      ...(await adapters.listMerged(3, 100, 'my/repo')),
      ...(await adapters.listMerged(4, 100, 'my/repo')),
    ];

    expect(merged).toHaveLength(301);
    expect((await adapters.inventoryStatus?.())?.complete).toBe(true);
    expect(requests.filter((args) => args[1]?.includes('state=closed'))).toHaveLength(4);
    const stateRoot = mkdtempSync(join(tmpdir(), 'draft-sweep-301-state-'));
    const previousState = process.env.ELANOUS_STATE_DIR;
    const previousConfig = process.env.ELANOUS_CONFIG_DIR;
    const sweepRequests: string[][] = [];
    const sweepAdapters = githubDraftSweepPreviewAdapters({ maxInventoryPages: 100 }, (args) => {
      sweepRequests.push(args);
      return execute(args);
    }, git, process.cwd(), executeAsync);
    try {
      process.env.ELANOUS_STATE_DIR = join(stateRoot, 'state');
      process.env.ELANOUS_CONFIG_DIR = join(stateRoot, 'config');
      const classified = await runDraftSweep({ repository: 'my/repo', adapters: sweepAdapters, now: new Date('2026-10-24T00:00:00Z') });
      expect(classified).toMatchObject({ complete: true, apply: false });
      expect(classified.entries).toHaveLength(1);
      expect(sweepRequests.filter((args) => args[1]?.includes('state=closed'))).toHaveLength(4);

      const cappedRequests: string[][] = [];
      const cappedAdapters = githubDraftSweepPreviewAdapters({ maxInventoryPages: 100, maxMerged: 1 }, (args) => {
        cappedRequests.push(args);
        return execute(args);
      }, git, process.cwd(), executeAsync);
      const capped = await runDraftSweep({ repository: 'my/repo', adapters: cappedAdapters, apply: true,
        now: new Date('2026-10-24T00:00:00Z') });
      expect(capped).toMatchObject({ complete: false, apply: true,
        error: 'merged PR inventory capped at 1 records (301 records listed)' });
      expect(cappedRequests.some((args) => args[0] === 'pr' || args[1]?.startsWith('repos/my/repo/issues/'))).toBe(false);
    } finally {
      if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previousState;
      if (previousConfig === undefined) delete process.env.ELANOUS_CONFIG_DIR; else process.env.ELANOUS_CONFIG_DIR = previousConfig;
      rmSync(stateRoot, { recursive: true, force: true });
    }
  }, 60_000);

  test('draft sweep apply honors the configured inventory page cap and fails closed', async () => {
    const requests: string[][] = [];
    const draft = {
      number: 1, draft: true, title: 'kept draft', head: { ref: 'ordinary/kept' }, base: { ref: 'main' },
      labels: [{ name: 'elanous:keep' }], created_at: '2025-01-01T00:00:00Z', updated_at: '2026-10-24T00:00:00Z', merged_at: null,
    };
    const drafts = Array.from({ length: 11 }, (_, index) => ({ ...draft, number: index + 1, title: `kept draft ${index + 1}` }));
    const closedPage = (page: number) => Array.from({ length: 100 }, (_, index) => ({
      number: 10_000 + page * 100 + index, draft: false, title: `closed ${page}-${index}`,
      head: { ref: `ordinary/${page}-${index}` }, base: { ref: 'main' }, labels: [],
      created_at: '2025-01-01T00:00:00Z', updated_at: '2026-10-23T00:00:00Z', merged_at: null,
    }));
    const execute = (args: string[]) => {
      const endpoint = args[1] ?? '';
      requests.push(args);
      if (endpoint.endsWith('/status')) return JSON.stringify({ state: 'success' });
      if (endpoint.includes('/check-runs')) return JSON.stringify({ total_count: 0, check_runs: [] });
      if (endpoint === 'graphql') {
        const query = args.find((arg) => arg.startsWith('query=')) ?? '';
        const repository: Record<string, unknown> = {};
        for (const [, alias, rawNumber] of query.matchAll(/(p\d+): pullRequest\(number: (\d+)\)/g)) {
          repository[alias!] = {
            number: Number(rawNumber), headRefOid: 'a'.repeat(40), headRef: { target: { committedDate: '2026-10-24T00:00:00Z' } },
            files: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } },
            comments: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } },
            reviews: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } }, mergeCommit: null,
          };
        }
        return JSON.stringify({ data: { repository } });
      }
      const state = /state=(open|closed)/.exec(endpoint)?.[1];
      const page = Number(/&page=(\d+)/.exec(endpoint)?.[1] ?? '1');
      if (state === 'open') return JSON.stringify(page === 1 ? drafts : []);
      if (state === 'closed') return JSON.stringify(page <= 3 ? closedPage(page) : page === 4 ? [closedPage(4)[0]] : []);
      throw new Error(`unexpected GitHub request: ${endpoint}`);
    };
    const writes: string[] = [];
    const previousExitCode = process.exitCode ?? 0;
    const stateRoot = mkdtempSync(join(tmpdir(), 'draft-sweep-apply-cap-state-'));
    const previousCwd = process.cwd();
    const gitRoot = join(stateRoot, 'git-root');
    mkdirSync(gitRoot, { recursive: true });
    execFileSync('git', ['init', '-q', gitRoot]);
    execFileSync('git', ['-C', gitRoot, 'remote', 'add', 'origin', 'https://github.com/ElanvitalAI/elanous.git']);
    const previousState = process.env.ELANOUS_STATE_DIR;
    const previousConfig = process.env.ELANOUS_CONFIG_DIR;
    const program = new Command().exitOverride();
    installHarnessCliCommand(program, {
      registerSink: async () => {}, resolveSurface: async () => 'harness',
      draftSweep: {
        repository: () => 'ElanvitalAI/elanous', execute, write: (line) => writes.push(line),
        residueReplay: { listLedgers: () => [] },
      },
    });
    try {
      process.chdir(gitRoot);
      process.env.ELANOUS_STATE_DIR = join(stateRoot, 'state');
      process.env.ELANOUS_CONFIG_DIR = join(stateRoot, 'config');
      await program.parseAsync(['node', 'elanous', 'harness', 'drafts', 'sweep', '--apply', '--json',
        '--repo', 'ElanvitalAI/elanous', '--max-pages', '2', '--max-drafts', '300', '--max-merged', '1000']);
      const result = JSON.parse(writes[0]!);
      expect(result).toMatchObject({ complete: false, apply: true, error: 'closed PR inventory capped at 2 pages (200 rows observed)' });
      expect(process.exitCode).toBe(1);
      expect(requests.filter((args) => args[1]?.includes('state=closed'))).toHaveLength(2);
      expect(requests.some((args) => args[1]?.includes('state=closed') && args[1]?.includes('page=3'))).toBe(false);
      expect(requests.some((args) => args[0] === 'pr' && ['edit', 'close'].includes(args[1] ?? '')
        || args[0] === 'api' && args.some((arg) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(arg)))).toBe(false);

      requests.length = 0;
      writes.length = 0;
      process.exitCode = previousExitCode ?? 0;
      const defaultProgram = new Command().exitOverride();
      installHarnessCliCommand(defaultProgram, {
        registerSink: async () => {}, resolveSurface: async () => 'harness',
        draftSweep: {
          repository: () => 'ElanvitalAI/elanous', execute, write: (line) => writes.push(line),
          residueReplay: { listLedgers: () => [] },
        },
      });
      await defaultProgram.parseAsync(['node', 'elanous', 'harness', 'drafts', 'sweep', '--apply', '--json', '--repo', 'ElanvitalAI/elanous']);
      const defaultResult = JSON.parse(writes[0]!);
      expect(defaultResult).toMatchObject({ complete: true, apply: true });
      expect(requests.filter((args) => args[1]?.includes('state=closed'))).toHaveLength(4);
      expect(defaultResult.entries).toHaveLength(11);
      expect(requests.some((args) => args[0] === 'pr' && ['edit', 'close'].includes(args[1] ?? '')
        || args[0] === 'api' && args.some((arg) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(arg)))).toBe(false);
    } finally {
      process.chdir(previousCwd);
      if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previousState;
      if (previousConfig === undefined) delete process.env.ELANOUS_CONFIG_DIR; else process.env.ELANOUS_CONFIG_DIR = previousConfig;
      rmSync(stateRoot, { recursive: true, force: true });
      process.exitCode = previousExitCode ?? 0;
    }
  }, 60_000);

  test('GitHub sweep adapter supplies file coverage and harvest evidence from the merged PR', async () => {
    const adapters = githubDraftSweepAdapters((args) => {
      const endpoint = args[1]!;
      if (endpoint.includes('state=open')) return JSON.stringify([{
        number: 1, draft: true, title: 'draft', head: { ref: 'self-impl/d' }, labels: [],
        created_at: '2026-09-01T00:00:00Z', merged_at: null, body: '칸: UX 10-03',
      }]);
      if (endpoint.includes('state=closed')) return JSON.stringify([{
        number: 2, draft: false, title: 'new title', head: { ref: 'other' }, base: { ref: 'main' }, labels: [],
        created_at: '2026-09-01T00:00:00Z', merged_at: '2026-09-02T00:00:00Z',
        body: '칸: UX 10-03', merge_commit_sha: 'sha',
      }, {
        number: 4, draft: false, title: 'unlanded', head: { ref: 'other-branch' }, base: { ref: 'feature' }, labels: [],
        created_at: '2026-09-01T00:00:00Z', merged_at: '2026-09-03T00:00:00Z', body: '칸: UX 10-03',
      }]);
      if (endpoint.includes('/files?')) return JSON.stringify([{ filename: 'src/a.ts' }]);
      if (endpoint.includes('/pulls/1/commits?')) return JSON.stringify([
        { sha: 'draft-commit', commit: { committer: { date: '2026-09-01T12:00:00Z' } } },
      ]);
      if (endpoint.includes('/commits/draft-commit?')) return JSON.stringify({ files: [{ filename: 'src/a.ts' }] });
      if (endpoint.includes('/comments?')) return JSON.stringify([{ body: 'landing-verified: superseded #1' }]);
      if (endpoint.endsWith('/commits/sha')) return JSON.stringify({ commit: { message: 'Shipped (수확 #1)' } });
      throw new Error(`Unexpected GitHub request: ${endpoint}`);
    });
    expect(await adapters.listDrafts(1, 100, 'my/repo')).toMatchObject([
      { number: 1, body: '칸: UX 10-03', changedFiles: ['src/a.ts'] },
    ]);
    expect(await adapters.listMerged(1, 100, 'my/repo')).toMatchObject([
      { number: 2, body: '칸: UX 10-03', mergedAt: '2026-09-02T00:00:00Z', changedFiles: ['src/a.ts'],
        mergeCommitMessage: 'Shipped (수확 #1)', landingVerifiedComments: ['landing-verified: superseded #1'] },
    ]);
    const [harvested] = await adapters.listDrafts(1, 100, 'my/repo');
    const latestFileChanges = await adapters.getLatestFileChanges?.(harvested!, 'my/repo');
    expect(latestFileChanges).toEqual({ 'src/a.ts': '2026-09-01T12:00:00Z' });
    const merged = await adapters.listMerged(1, 100, 'my/repo');
    expect(decideDraft({ draft: harvested!, mergedTwins: merged, runStatus: 'completed', ageHours: 1,
      liveBranches: new Set() })).toMatchObject({ action: 'close', reason: 'superseded-by #2 (harvest #1)' });
    expect(decideDraft({ draft: { ...harvested!, number: 3, latestFileChanges }, mergedTwins: merged, runStatus: 'completed',
      ageHours: 1, liveBranches: new Set() })).toMatchObject({ action: 'close', reason: 'superseded-by #2 (all-files-landed)' });
  });

  test('a draft whose file list reaches the GitHub cap has no provable file list and never closes as all-files-landed', async () => {
    const fullPage = (page: number) => JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ filename: `src/f${page}-${i}.ts` })));
    const adapters = githubDraftSweepAdapters((args) => {
      const endpoint = args[1]!;
      if (endpoint.includes('state=open')) return JSON.stringify([{
        number: 1, draft: true, title: 'huge draft', head: { ref: 'self-impl/huge' }, labels: [],
        created_at: '2026-09-01T00:00:00Z', merged_at: null, body: '칸: UX 10-03',
      }]);
      if (endpoint.includes('state=closed')) return JSON.stringify([{
        number: 2, draft: false, title: 'later', head: { ref: 'self-impl/huge' }, base: { ref: 'main' }, labels: [],
        created_at: '2026-09-01T00:00:00Z', merged_at: '2026-09-02T00:00:00Z', body: '칸: UX 10-03',
      }]);
      // GitHub returns 30 full pages (3,000 files) and then an empty page: the cut looks like a normal end.
      const files = /\/pulls\/(\d+)\/files\?per_page=100&page=(\d+)/.exec(endpoint);
      if (files) return Number(files[2]) <= 30 ? fullPage(Number(files[2])) : '[]';
      if (endpoint.includes('/comments?')) return '[]';
      throw new Error(`Unexpected GitHub request: ${endpoint}`);
    });
    const [draft] = await adapters.listDrafts(1, 100, 'my/repo');
    expect(draft!.changedFiles).toBeUndefined();
    const merged = await adapters.listMerged(1, 100, 'my/repo');
    const decision = decideDraft({ draft: { ...draft!, title: 'different title', branch: 'self-impl/other' }, mergedTwins: merged,
      runStatus: 'completed', ageHours: 1, liveBranches: new Set() });
    expect(decision.reason).not.toContain('all-files-landed');
  });

  test('GitHub sweep adapter recognizes final results only for the same PR and owned run', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'draft-final-'));
    const previous = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = stateDir;
    try {
      const logPath = logsDbPath();
      mkdirSync(join(stateDir, 'run-ledger'), { recursive: true });
      writeFileSync(join(stateDir, 'run-ledger', 'run-owned.jsonl'), `${JSON.stringify({ runId: 'run-owned', event: 'pr-opened',
        timestamp: '2026-09-01T00:00:00Z', data: { number: 43, repository: 'my/repo' } })}\n`);
      mkdirSync(join(stateDir, 'logs'), { recursive: true });
      const store = new LogStore(logPath);
      try {
        store.insertBatch([
          { surface: 'harness', rec: { ts: new Date().toISOString(), category: 'self-implement.result', event: 'final',
            data: { runId: 'unowned-run', prNumber: 43 } } },
        ]);
      } finally { store.close(); }
      const adapters = githubDraftSweepAdapters(() => '[]');
      const target = { number: 43, branch: 'self-impl/goal', title: 'draft', labels: [],
        createdAt: '2026-09-01T00:00:00Z' };
      expect(await adapters.hasFinalRunResult?.(target, 'my/repo')).toBe(false);
      const owned = new LogStore(logPath);
      try {
        owned.insertBatch([{ surface: 'harness', rec: { ts: new Date().toISOString(), category: 'self-implement.result',
          event: 'final', data: { runId: 'run-owned', prNumber: 43 } } }]);
      } finally { owned.close(); }
      expect(await adapters.hasFinalRunResult?.(target, 'my/repo')).toBe(true);
      writeFileSync(join(stateDir, 'run-ledger', 'run-current.jsonl'), `${JSON.stringify({ runId: 'run-current', event: 'pr-opened',
        timestamp: '2026-09-02T00:00:00Z', data: { number: 43, repository: 'my/repo' } })}\n`);
      const open = { number: 43, draft: true, title: 'draft', head: { ref: target.branch }, labels: [],
        created_at: target.createdAt, merged_at: null };
      const rerunAdapters = githubDraftSweepAdapters((args) => args[1]?.includes('state=open')
        ? JSON.stringify([open]) : '[]');
      const [current] = await rerunAdapters.listDrafts(1, 100, 'my/repo');
      expect(current?.runId).toBe('run-current');
      expect(await rerunAdapters.getRunStatus(current!, 'my/repo')).toBeUndefined();
      expect(await rerunAdapters.hasFinalRunResult?.(current!, 'my/repo')).toBe(false);
      const sweepAdapters = githubDraftSweepAdapters((args) => args[1]?.includes('state=open')
        ? JSON.stringify([{ ...open, labels: [{ name: 'elanous:stalled' }] }]) : '[]', (_cwd, args) => ({
        status: 0, stderr: '', stdout: args[0] === 'config'
          ? 'https://github.com/my/repo.git' : `worktree /tmp/retained\nbranch refs/heads/${target.branch}\n`,
      }));
      const inspect = () => runDraftSweep({ repository: 'my/repo', adapters: sweepAdapters,
        now: new Date('2026-09-30T00:00:00Z') });
      expect((await inspect()).entries[0]).toMatchObject({ action: 'keep', reason: 'live' });
      expect(await rerunAdapters.hasFinalRunResult?.({ ...target, runId: 'run-owned' }, 'my/repo')).toBe(true);
      const currentStore = new LogStore(logPath);
      try {
        currentStore.insertBatch([{ surface: 'harness', rec: { ts: new Date().toISOString(), category: 'self-implement.result',
          event: 'final', data: { runId: 'run-current', prNumber: 43 } } }]);
      } finally { currentStore.close(); }
      expect(await rerunAdapters.hasFinalRunResult?.(current!, 'my/repo')).toBe(true);
      expect((await inspect()).entries[0]).toMatchObject({ action: 'close',
        reason: 'stale-ended-run (self-implement.result final; worktree is not live)' });
      expect(await rerunAdapters.hasFinalRunResult?.({ ...target, number: 44, branch: 'self-impl/other' }, 'my/repo')).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previous;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test('GitHub sweep adapter reads the latest claim owner for the expired-claim comment', async () => {
    const requests: string[][] = [];
    const adapters = githubDraftSweepAdapters((args) => {
      requests.push(args);
      return JSON.stringify([
        [{ body: '🔧 처리 중 — owner S · 2026-09-28T17:00:00.000Z' }],
        [{ body: '🔧 처리 중 — owner T · 2026-09-29T17:00:00.000Z · 재작업 중' }, { body: 'unrelated' }],
      ]);
    });
    expect(await adapters.getClaimOwner?.('my/repo', 123)).toBe('T');
    expect(requests).toEqual([['api', '--paginate', '--slurp', 'repos/my/repo/issues/123/comments?per_page=100']]);
  });

  test('preserves legacy census PASS while exposing a dismissed exact-head review as dismissed', async () => {
    const adapters = githubDraftSweepAdapters((args) => {
      const endpoint = args[1] ?? '';
      if (endpoint === 'repos/my/repo/pulls/123') return JSON.stringify({ head: { sha: 'a'.repeat(40) } });
      if (endpoint.includes('/pulls/123/reviews?')) return JSON.stringify([{ state: 'DISMISSED', body: 'VERDICT: PASS',
        submitted_at: '2026-10-21T00:00:00Z', commit_id: 'a'.repeat(40) }]);
      if (endpoint.includes('/issues/123/comments?')) return JSON.stringify([{ body: 'VERDICT: PASS' }]);
      if (endpoint.includes(`/commits/${'a'.repeat(40)}/status`)) return JSON.stringify({ state: 'success' });
      if (endpoint.includes(`/commits/${'a'.repeat(40)}/check-runs`)) return JSON.stringify({ total_count: 1, check_runs: [{ conclusion: 'success' }] });
      throw new Error(`unexpected endpoint: ${endpoint}`);
    });
    const posture = await adapters.getReviewGate?.({ number: 123, branch: 'self-impl/draft', title: 'draft',
      labels: [], createdAt: '2026-10-20T00:00:00Z' }, 'my/repo');
    expect(posture).toMatchObject({ review: 'pass', gate: 'pass', triageReview: 'dismissed' });
  });

  test('paginates all REST reviews and exposes the latest exact-head state', async () => {
    const requests: string[] = [];
    const head = 'a'.repeat(40);
    const adapters = githubDraftSweepAdapters((args) => {
      const endpoint = args[1] ?? '';
      requests.push(endpoint);
      if (endpoint === 'graphql') throw new Error('force REST fallback');
      if (endpoint === 'repos/my/repo/pulls/123') return JSON.stringify({ head: { sha: head } });
      if (endpoint === `repos/my/repo/pulls/123/reviews?per_page=100&page=1`) return JSON.stringify(Array.from({ length: 100 }, (_, index) => ({
        state: 'COMMENTED', body: `old review ${index}`, submitted_at: '2026-10-20T00:00:00Z', commit_id: null,
      })));
      if (endpoint === `repos/my/repo/pulls/123/reviews?per_page=100&page=2`) return JSON.stringify([{ state: 'APPROVED',
        body: 'current head approved', submitted_at: '2026-10-21T00:00:00Z', commit_id: head }]);
      if (endpoint === 'repos/my/repo/issues/123/comments?per_page=100&page=1') return JSON.stringify([{ body: 'VERDICT: PASS' }]);
      if (endpoint === `repos/my/repo/commits/${head}/status`) return JSON.stringify({ state: 'success' });
      if (endpoint === `repos/my/repo/commits/${head}/check-runs?per_page=100&page=1`) return JSON.stringify({ total_count: 1, check_runs: [{ conclusion: 'success' }] });
      throw new Error(`unexpected endpoint: ${endpoint}`);
    });
    const posture = await adapters.getReviewGate?.({ number: 123, branch: 'self-impl/draft', title: 'draft',
      labels: [], createdAt: '2026-10-20T00:00:00Z' }, 'my/repo');
    expect(posture).toMatchObject({ review: 'pass', gate: 'pass', triageReview: 'approved' });
    expect(requests).toContain('repos/my/repo/pulls/123/reviews?per_page=100&page=2');
  });

  test('exact-head gate reads all check-run pages before reporting pass', async () => {
    const head = 'b'.repeat(40);
    const requests: string[] = [];
    const adapters = githubDraftSweepAdapters((args) => {
      const endpoint = args[1] ?? '';
      requests.push(endpoint);
      if (endpoint === `repos/my/repo/pulls/123`) return JSON.stringify({ head: { sha: head } });
      if (endpoint.includes('/pulls/123/reviews?')) return JSON.stringify([]);
      if (endpoint.includes('/issues/123/comments?')) return JSON.stringify([]);
      if (endpoint === `repos/my/repo/commits/${head}/status`) return JSON.stringify({ state: 'success' });
      if (endpoint === `repos/my/repo/commits/${head}/check-runs?per_page=100&page=1`)
        return JSON.stringify({ total_count: 101, check_runs: Array.from({ length: 100 }, () => ({ conclusion: 'success' })) });
      if (endpoint === `repos/my/repo/commits/${head}/check-runs?per_page=100&page=2`)
        return JSON.stringify({ total_count: 101, check_runs: [{ conclusion: 'failure' }] });
      throw new Error(`unexpected endpoint: ${endpoint}`);
    });
    const posture = await adapters.getReviewGate?.({ number: 123, branch: 'self-impl/draft', title: 'draft', labels: [],
      createdAt: '2026-10-20T00:00:00Z' }, 'my/repo');
    expect(posture?.gate).toBe('fail');
    expect(requests).toContain(`repos/my/repo/commits/${head}/check-runs?per_page=100&page=2`);
  });

  test('serializes concurrent check-run pagination and retries transient 403 before reading a complete inventory', async () => {
    const head = 'd'.repeat(40);
    let active = 0;
    let maxActive = 0;
    let checkRunCalls = 0;
    const delays: number[] = [];
    const adapters = githubDraftSweepPreviewAdapters({
      checkRunRetryDelaysMs: [5], checkRunSleep: async (ms) => { delays.push(ms); },
    }, () => '', () => ({ status: 0, stdout: '', stderr: '' }), process.cwd(), async (args) => {
      const endpoint = args[1] ?? '';
      if (/\/pulls\/\d+$/.test(endpoint)) return JSON.stringify({ head: { sha: head } });
      if (endpoint.includes('/reviews?') || endpoint.includes('/comments?')) return '[]';
      if (endpoint.endsWith('/status')) return JSON.stringify({ state: 'success' });
      if (endpoint.includes('/check-runs?')) {
        active++; maxActive = Math.max(maxActive, active); checkRunCalls++;
        await new Promise((resolve) => setTimeout(resolve, 2));
        active--;
        if (checkRunCalls === 1) throw new Error('gh api exit=1: HTTP 403 secondary rate limit');
        return JSON.stringify({ total_count: 1, check_runs: [{ conclusion: 'success' }] });
      }
      throw new Error(`unexpected endpoint: ${endpoint}`);
    });
    const drafts = [123, 124].map((number) => ({ number, branch: `self-impl/${number}`, title: 'draft', labels: [], createdAt: '2026-10-20T00:00:00Z' }));
    const postures = await Promise.all(drafts.map((draft) => adapters.getReviewGate?.(draft, 'my/repo')));
    expect(postures).toHaveLength(2);
    expect(postures.every((posture) => posture?.gate === 'pass')).toBe(true);
    expect(maxActive).toBe(1);
    expect(delays).toEqual([5]);
  });

  test('fails closed when check-run inventory returns an incomplete page', async () => {
    const head = 'e'.repeat(40);
    const adapters = githubDraftSweepPreviewAdapters({ checkRunRetryDelaysMs: [], checkRunSleep: async () => {} }, (args) => {
      const endpoint = args[1] ?? '';
      if (endpoint === 'repos/my/repo/pulls/123') return JSON.stringify({ head: { sha: head } });
      if (endpoint.includes('/reviews?') || endpoint.includes('/comments?')) return '[]';
      if (endpoint.endsWith('/status')) return JSON.stringify({ state: 'success' });
      if (endpoint.includes('/check-runs?')) return JSON.stringify({ total_count: 2, check_runs: [{ conclusion: 'success' }] });
      throw new Error(`unexpected endpoint: ${endpoint}`);
    });
    await expect(adapters.getReviewGate?.({ number: 123, branch: 'self-impl/draft', title: 'draft', labels: [],
      createdAt: '2026-10-20T00:00:00Z' }, 'my/repo')).rejects.toThrow('check-run inventory incomplete');
    expect(await adapters.inventoryStatus?.()).toMatchObject({ complete: false, reason: expect.stringContaining('check-run inventory incomplete') });
    expect((await adapters.inventoryStatus?.())?.reason).toContain('may have changed during pagination');
  });

  test('keeps exact-head gate unknown when combined status has no state', async () => {
    const head = 'c'.repeat(40);
    const adapters = githubDraftSweepAdapters((args) => {
      const endpoint = args[1] ?? '';
      if (endpoint === 'repos/my/repo/pulls/123') return JSON.stringify({ head: { sha: head } });
      if (endpoint.includes('/pulls/123/reviews?') || endpoint.includes('/issues/123/comments?')) return JSON.stringify([]);
      if (endpoint === `repos/my/repo/commits/${head}/status`) return JSON.stringify({});
      if (endpoint === `repos/my/repo/commits/${head}/check-runs?per_page=100&page=1`)
        return JSON.stringify({ total_count: 1, check_runs: [{ conclusion: 'success' }] });
      throw new Error(`unexpected endpoint: ${endpoint}`);
    });
    const posture = await adapters.getReviewGate?.({ number: 123, branch: 'self-impl/draft', title: 'draft', labels: [],
      createdAt: '2026-10-20T00:00:00Z' }, 'my/repo');
    expect(posture).not.toHaveProperty('gate');
  });

  test('draft sweep reads closed PRs only back to the oldest open draft — a large repository does not exhaust pagination', async () => {
    const requests: string[] = [];
    const closedPage = (page: number) => Array.from({ length: 100 }, (_, i) => ({
      number: 10_000 - page * 100 - i, draft: false, title: `old ${page}-${i}`, head: { ref: `b-${page}-${i}` }, base: { ref: 'main' }, labels: [],
      created_at: '2026-01-01T00:00:00Z', merged_at: '2026-01-02T00:00:00Z',
      // page 1 is newer than the oldest draft; page 2 ends before it
      updated_at: page === 1 ? '2026-09-20T00:00:00Z' : '2026-09-05T00:00:00Z',
    }));
    const adapters = githubDraftSweepAdapters((args) => {
      requests.push(args[1]!);
      if (args[1]!.includes('/files?') || args[1]!.includes('/comments?')) return '[]';
      if (args[1]!.includes('state=open')) return JSON.stringify([{ number: 1, draft: true, title: 'd', head: { ref: 'self-impl/d' },
        labels: [], created_at: '2026-09-10T00:00:00Z', merged_at: null }]);
      const page = Number(/&page=(\d+)/.exec(args[1]!)![1]);
      if (page > 2) throw new Error('paged past the oldest draft');
      return JSON.stringify(closedPage(page));
    });
    expect(await adapters.listMerged(1, 100, 'my/repo')).toHaveLength(100);
    expect(requests.filter((r) => r.includes('state=closed'))).toHaveLength(2);

    const none = githubDraftSweepAdapters((args) => {
      if (args[1]!.includes('state=closed')) throw new Error('no drafts — closed listing is not needed');
      return '[]';
    });
    expect(await none.listMerged(1, 100, 'my/repo')).toEqual([]);
  });

  test('bounded draft preview streams page progress and reports a capped partial inventory before enriching more PRs', async () => {
    const requests: string[] = [];
    const progress: Array<{ state: 'open' | 'closed'; page: number; rows: number }> = [];
    const openPage = Array.from({ length: 100 }, (_, index) => ({
      number: index + 1, draft: true, title: `draft ${index + 1}`, head: { ref: `self-impl/${index + 1}` },
      labels: [], created_at: '2026-09-01T00:00:00Z', merged_at: null,
    }));
    const adapters = githubDraftSweepPreviewAdapters({
      maxInventoryPages: 1, maxDrafts: 5, maxMerged: 5,
      onInventoryProgress: (event) => progress.push(event),
    }, (args) => {
      const endpoint = args[1] ?? '';
      requests.push(endpoint);
      if (args[0] === 'api' && endpoint === 'graphql') {
        const query = args.find((arg) => arg.startsWith('query=')) ?? '';
        const data: Record<string, unknown> = {};
        for (const [, number] of query.matchAll(/p(\d+): pullRequest/g)) data[`p${number}`] = {
          number: Number(number), headRefOid: `h${number}`,
          files: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } },
          comments: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } },
          reviews: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } },
        };
        return JSON.stringify({ data: { repository: data } });
      }
      if (endpoint.includes('state=open')) return JSON.stringify(openPage);
      if (endpoint.includes('state=closed')) throw new Error('bounded preview must stop at its page cap');
      return '[]';
    });

    const rows = await adapters.listDrafts(1, 100, 'my/repo');
    expect(rows.map((row) => row.number)).toEqual([1, 2, 3, 4, 5]);
    expect(progress).toEqual([{ state: 'open', page: 1, rows: 100 }]);
    expect(await adapters.inventoryStatus?.()).toEqual({ complete: false,
      reason: 'open PR inventory capped at 1 pages (100 rows observed)' });
    expect(requests.filter((endpoint) => endpoint.includes('state=open'))).toHaveLength(1);
  });

  test('bounded preview retains earlier pages and exposes the timeout reason when a later inventory page fails', async () => {
    const requests: string[] = [];
    const progress: Array<{ state: 'open' | 'closed'; page: number; rows: number }> = [];
    const openPage = Array.from({ length: 100 }, (_, index) => ({
      number: index + 1, draft: true, title: `draft ${index + 1}`, head: { ref: `self-impl/${index + 1}` },
      labels: [], created_at: '2026-09-01T00:00:00Z', merged_at: null,
    }));
    const adapters = githubDraftSweepPreviewAdapters({
      maxInventoryPages: 2, maxDrafts: 5, maxMerged: 5,
      onInventoryProgress: (event) => progress.push(event),
    }, (args) => {
      const endpoint = args[1] ?? '';
      requests.push(endpoint);
      if (args[0] === 'api' && endpoint === 'graphql') {
        const query = args.find((arg) => arg.startsWith('query=')) ?? '';
        const data: Record<string, unknown> = {};
        for (const [, number] of query.matchAll(/p(\d+): pullRequest/g)) data[`p${number}`] = {
          number: Number(number), headRefOid: `h${number}`,
          files: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } },
          comments: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } },
          reviews: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } },
        };
        return JSON.stringify({ data: { repository: data } });
      }
      if (/state=open.*&page=1$/.test(endpoint)) return JSON.stringify(openPage);
      if (/state=open.*&page=2$/.test(endpoint)) throw new Error('GitHub request timed out');
      throw new Error(`unexpected endpoint: ${endpoint}`);
    });

    const rows = await adapters.listDrafts(1, 100, 'my/repo');
    expect(rows.map((row) => row.number)).toEqual([1, 2, 3, 4, 5]);
    expect(progress).toEqual([{ state: 'open', page: 1, rows: 100 }]);
    const status = await adapters.inventoryStatus?.();
    expect(status?.complete).toBe(false);
    expect(status?.reason).toContain('stopped after 1 pages (100 rows)');
    expect(status?.reason).toContain('GitHub request timed out');
    expect(requests.filter((endpoint) => endpoint.includes('state=open'))).toHaveLength(2);
  });

  test('draft sweep never treats a different or unverified cwd repository as an absent branch', async () => {
    const pr = { number: 9, draft: true, title: 'goal', head: { ref: 'self-impl/live' },
      labels: [{ name: 'elanous:stalled' }], created_at: '2026-09-01T00:00:00Z', merged_at: null };
    const gitCalls: string[][] = [];
    const gitCwds: string[] = [];
    let origin = 'git@github.com:other/repo.git';
    let worktreeStatus = 0;
    let worktreeBranch = 'self-impl/unrelated';
    const adapters = githubDraftSweepAdapters(
      (args) => args[0] === 'api' && args[1]?.includes('state=open') ? JSON.stringify([pr]) : '[]',
      (cwd, args) => {
        gitCwds.push(cwd);
        gitCalls.push(args);
        if (args[0] === 'config') return { status: 0, stdout: `${origin}\n`, stderr: '' };
        return { status: worktreeStatus, stdout: `worktree /tmp/other\nbranch refs/heads/${worktreeBranch}\n`, stderr: '' };
      },
    );
    const closed: number[] = [];
    const sweep = async (repository: string) => {
      return runDraftSweep({ repository, apply: true, now: new Date('2026-10-01T00:00:00Z'), adapters: {
        ...adapters,
        getRunStatus: async () => 'failed',
        hasFinalRunResult: async () => false,
        setLabels: async () => {},
        closeDraft: async (_repository, number) => { closed.push(number); },
      } });
    };
    expect(await adapters.listLiveBranches('my/repo')).toBeUndefined();
    expect(gitCalls).toEqual([['config', '--get', 'remote.origin.url']]);
    expect(gitCwds).toEqual([process.cwd()]);
    expect(await sweep('my/repo')).toMatchObject({ complete: false, entries: [] });
    expect(closed).toEqual([]);

    origin = 'https://github.com/my/repo.git';
    worktreeBranch = 'self-impl/live';
    expect(await adapters.listLiveBranches('my/repo')).toEqual(new Set(['self-impl/live']));
    expect(await sweep('my/repo')).toMatchObject({ complete: true, entries: [{ number: 9, action: 'keep' }] });
    expect(closed).toEqual([]);

    worktreeStatus = 1;
    expect(await adapters.listLiveBranches('my/repo')).toBeUndefined();
    expect(await sweep('my/repo')).toMatchObject({ complete: false, entries: [] });
    expect(closed).toEqual([]);
    origin = 'file:///tmp/unverified';
    expect(await adapters.listLiveBranches('my/repo')).toBeUndefined();
  });

  test('run-status attribution requires repository as well as PR number, and leaves unowned ledgers unknown', () => {
    const ledger = (runId: string, data: Record<string, unknown>, status: string) => ({
      runId, ledgerDirectory: '/tmp/ledger', ledgerPath: `/tmp/ledger/${runId}.jsonl`, targetName: null,
      entries: [
        { runId, event: 'pr-opened', data },
        { runId, event: 'run-status', data: { runStatus: status } },
      ],
    });
    const foreign = ledger('run-foreign', { number: 43, repository: 'other/repo' }, 'failed');
    const unowned = ledger('run-unowned', { number: 43 }, 'failed');
    const owned = ledger('run-owned', { number: 43, url: 'https://github.com/my/repo/pull/43' }, 'completed');
    const live = new Map([['run-foreign', 'failed'], ['run-owned', 'running']]);
    expect(draftSweepRunStatus([foreign, unowned], live, 'my/repo', 43)).toBeUndefined();
    expect(draftSweepRunStatus([foreign, unowned, owned], live, 'my/repo', 43)).toBe('running');
    expect(draftSweepRunStatus([foreign, unowned, owned], live, 'other/repo', 43)).toBe('failed');
    expect(draftSweepRunStatus([foreign, unowned, owned], live, 'my/repo', 44)).toBeUndefined();
    expect(draftSweepRunStatus([ledger('run-disputed', {
      number: 43, repo: 'my/repo', url: 'https://github.com/other/repo/pull/43',
    }, 'failed')], live, 'my/repo', 43)).toBeUndefined();
    expect(draftSweepRunStatus([owned, ledger('run-conflict', { number: 43, repo: 'my/repo' }, 'failed')],
      live, 'my/repo', 43)).toBe('running');
    expect(draftSweepRunStatus([
      ledger('run-old', { number: 43, repository: 'my/repo' }, 'completed'),
      ledger('run-new', { number: 43, repository: 'my/repo' }, 'failed'),
    ], new Map([['run-new', 'running']]), 'my/repo', 43)).toBe('running');
    expect(draftSweepRunStatus([{
      ...owned, entries: [...owned.entries, { runId: owned.runId, event: 'pr-opened', data: { number: 43 } }],
    }], live, 'my/repo', 43)).toBeUndefined();
  });

  test('draft sweep refuses malformed repository before adapters run and reports incomplete inventory in JSON', async () => {
    let calls = 0;
    const lines: string[] = [];
    const adapters = {
      listDrafts: async () => { calls++; throw new Error('GitHub listing failed'); },
      listMerged: async () => [],
      getRunStatus: async () => undefined,
      listLiveBranches: async () => new Set<string>(),
      setLabels: async () => { throw new Error('unexpected label'); },
      closeDraft: async () => { throw new Error('unexpected close'); },
    };
    const { program } = install(undefined, undefined, undefined, undefined, undefined, undefined,
      { adapters, repository: () => 'default/repo', write: (line) => lines.push(line) });
    const prior = process.exitCode;
    try {
      process.exitCode = 0;
      const errors = await captureError(() => program.parseAsync(['node', 'elanous', 'harness', 'drafts', 'sweep', '--apply', '--repo', '../other']));
      expect(errors).toEqual(['❌ invalid --repo (expected owner/name): ../other']);
      expect(calls).toBe(0);
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
      await program.parseAsync(['node', 'elanous', 'harness', 'drafts', 'sweep', '--json', '--apply']);
      expect(JSON.parse(lines.at(-1)!)).toMatchObject({ repository: 'default/repo', apply: true,
        complete: false, entries: [], error: 'GitHub listing failed' });
      expect(process.exitCode).toBe(1);
    } finally { process.exitCode = prior ?? 0; }
  });
  test('draft sweep prints the first gh error as one line with no stack and exits non-zero', async () => {
    const lines: string[] = [];
    const events: unknown[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: unknown) => {
      if (category === 'drafts.cleanup' && event === 'failed') events.push(data);
    }) as typeof debug.log);
    const adapters = {
      listDrafts: async () => { throw new Error('gh: Command failed\n    at ChildProcess.exithandler (node:child_process:1:1)'); },
      listMerged: async () => [],
      getRunStatus: async () => undefined,
      listLiveBranches: async () => new Set<string>(),
      setLabels: async () => {},
      closeDraft: async () => {},
    };
    const { program } = install(undefined, undefined, undefined, undefined, undefined, undefined,
      { adapters, repository: () => 'my/repo', write: (line) => lines.push(line) });
    const prior = process.exitCode;
    try {
      process.exitCode = 0;
      await program.parseAsync(['node', 'elanous', 'harness', 'drafts', 'sweep', '--json']);
      const parsed = JSON.parse(lines.at(-1)!);
      expect(parsed).toMatchObject({ complete: false, error: 'gh: Command failed' });
      expect(parsed.error).not.toContain('\n');
      expect(parsed.error).not.toContain('at ChildProcess');
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
      lines.length = 0;
      await program.parseAsync(['node', 'elanous', 'harness', 'drafts', 'sweep']);
      expect(lines.some((line) => line === 'gh: Command failed')).toBe(true);
      expect(lines.join('\n')).not.toContain('at ChildProcess');
      expect(process.exitCode).toBe(1);
      expect(events).toEqual([{ reason: 'gh: Command failed' }, { reason: 'gh: Command failed' }]);
      process.exitCode = 0;
      events.length = 0;
      const checkout = mkdtempSync(join(tmpdir(), 'draft-sweep-gh-missing-'));
      const { execFileSync: realExec } = await import('node:child_process');
      realExec('git', ['init', '-q', checkout]);
      const previousCwd = process.cwd();
      const gh = spyOn(await import('node:child_process'), 'execFileSync').mockImplementation(((file: string, ...rest: unknown[]) => {
        if (file === 'git') return realExec(file, ...(rest as [string[]]));
        throw new Error('Executable not found: gh\n    at execFileSync (node:child_process:1:1)');
      }) as typeof realExec);
      try {
        process.chdir(checkout);
        const unnamed = install();
        const errors = await captureError(() => unnamed.program.parseAsync(['node', 'elanous', 'harness', 'drafts', 'sweep']));
        expect(errors).toEqual(['❌ Executable not found: gh']);
        expect(errors.join('\n')).not.toContain('at execFileSync');
        expect(process.exitCode).toBe(1);
        expect(events).toEqual([{ reason: 'Executable not found: gh' }]);
      } finally {
        process.chdir(previousCwd);
        gh.mockRestore();
        rmSync(checkout, { recursive: true, force: true });
      }
    } finally {
      process.exitCode = prior ?? 0;
      log.mockRestore();
    }
  });

  test('launch gate blocks same-goal say and exhausted budget before either local or Pod dispatch; force bypasses only duplicate', async () => {
    const calls: string[] = [];
    const observed: string[] = [];
    const events: unknown[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: unknown) => {
      if (category === 'execution-loop.launch-gate' && event === 'decision') events.push(data);
    }) as typeof debug.log);
    let budget: 'proceed' | 'stop' | 'wait-reset' = 'proceed';
    const gate = {
      activeRuns: (id: string) => { observed.push(id); return ['run-active']; },
      readBudget: async () => ({ action: budget, reasons: ['limit reached'] }),
    };
    const { program, harness } = install(async () => { calls.push('ask'); }, async () => { calls.push('say'); },
      undefined, undefined, undefined, undefined, undefined, undefined, gate);
    const pod = spyOn(podDispatch, 'dispatchHarnessOnPod').mockImplementation(() => 0);
    const goal = join(tmpdir(), `launch-gate-${crypto.randomUUID()}.md`);
    writeFileSync(goal, '# Goal\n- GoalId: 1234567890abcdef\n\nbody');
    const previousExit = process.exitCode;
    try {
      for (const name of ['ask', 'say']) {
        expect(harness.commands.find((command) => command.name() === name)!.options.map((option) => option.long)).toContain('--force-gate');
      }
      process.exitCode = 0;
      const duplicate = await captureError(() => program.parseAsync(['node', 'elanous', 'harness', 'say', 'repeat', 'this']));
      expect(duplicate).toEqual(['❌ launch gate: blocked-duplicate — same-goal active runs: run-active']);
      expect(process.exitCode).toBe(3);
      expect(calls).toEqual([]);
      expect(observed).toEqual([`request-${createHash('sha256').update('repeat this').digest('hex').slice(0, 32)}`]);
      process.exitCode = 0;
      const podDuplicate = await captureError(() => program.parseAsync(['node', 'elanous', 'harness', 'ask', goal, '--substrate', 'pod', '--pod-pool', 'pool-test:1']));
      expect(podDuplicate).toEqual(['❌ launch gate: blocked-duplicate — same-goal active runs: run-active']);
      expect(process.exitCode).toBe(3);
      expect(pod).toHaveBeenCalledTimes(0);
      process.exitCode = 0;
      await captureError(() => program.parseAsync(['node', 'elanous', 'harness', 'say', 'repeat', 'this', '--force-preflight']));
      expect(process.exitCode).toBe(3);
      expect(calls).toEqual([]);
      process.exitCode = 0;
      const forced = await captureError(() => program.parseAsync(['node', 'elanous', 'harness', 'say', 'repeat', 'this', '--force-gate']));
      expect(forced).toEqual([]);
      expect(calls).toEqual(['say']);
      expect(events).toContainEqual(expect.objectContaining({ action: 'proceed', forceLaunch: true }));
      budget = 'stop';
      process.exitCode = 0;
      const denied = await captureError(() => program.parseAsync(['node', 'elanous', 'harness', 'ask', goal, '--force-gate']));
      expect(denied).toEqual(['❌ launch gate: blocked-budget — limit reached']);
      expect(process.exitCode).toBe(3);
      expect(calls).toEqual(['say']);
      expect(pod).toHaveBeenCalledTimes(0);
      expect(observed.at(-1)).toBe('1234567890abcdef');
      process.exitCode = 0;
      const noIdGoal = join(tmpdir(), `launch-no-id-${crypto.randomUUID()}.md`);
      writeFileSync(noIdGoal, '# Goal without id\n');
      try {
        const noId = await captureError(() => program.parseAsync(['node', 'elanous', 'harness', 'ask', noIdGoal]));
        expect(noId).toEqual(['❌ launch gate: blocked-budget — limit reached']);
        expect(process.exitCode).toBe(3);
        expect(calls).toEqual(['say']);
      } finally { rmSync(noIdGoal, { force: true }); }
      budget = 'wait-reset';
      process.exitCode = 0;
      const reset = await captureError(() => program.parseAsync(['node', 'elanous', 'harness', 'say', 'repeat', 'this', '--force-gate']));
      expect(reset).toEqual(['❌ launch gate: wait-reset — limit reached']);
      expect(process.exitCode).toBe(3);
      expect(calls).toEqual(['say']);
    } finally { process.exitCode = previousExit ?? 0; pod.mockRestore(); log.mockRestore(); rmSync(goal, { force: true }); }
  });

  test('say refuses a live authored run whose original request exactly matches before dispatch', async () => {
    const ask = 'repeat this';
    const goal = join(tmpdir(), `launch-authored-${crypto.randomUUID()}.md`);
    writeFileSync(goal, `# Authored goal\n- GoalId: abcdef0123456789\n${ORIGINAL_ASK_MARKER}\n\`\`\`text\n${ask}\n\`\`\`\n`);
    let dispatched = 0;
    const gate: NonNullable<Parameters<typeof installHarnessCliCommand>[1]['launchGate']> = {
      readBudget: async () => ({ action: 'proceed', reasons: [] }),
      queryRuns: () => ({ completeness: 'complete', pty: { unreadable: [] }, entries: [{
        runId: 'run-live', status: 'running', ledgerDirectories: ['/ledger'], ptyRefs: [{ id: 'pty-live', instance: 'test', kind: 'test' }],
      }] }) as unknown as ReturnType<NonNullable<NonNullable<Parameters<typeof installHarnessCliCommand>[1]['launchGate']>['queryRuns']>>,
      loadLedger: () => [{ runId: 'run-live', event: 'start', goalId: 'abcdef0123456789', data: { goalFile: goal } }],
    };
    const { program } = install(undefined, async () => { dispatched++; },
      undefined, undefined, undefined, undefined, undefined, undefined, gate);
    const previousExit = process.exitCode;
    try {
      process.exitCode = 0;
      const errors = await captureError(() => program.parseAsync(['node', 'elanous', 'harness', 'say', 'repeat', 'this']));
      expect(errors).toEqual(['❌ launch gate: blocked-duplicate — same-goal active runs: run-live']);
      expect(process.exitCode).toBe(3);
      expect(dispatched).toBe(0);
    } finally { process.exitCode = previousExit ?? 0; rmSync(goal, { force: true }); }
  });

  test('launch gate warnings permit ask/say dispatch and dry-run performs no budget or run lookup', async () => {
    const calls: unknown[] = [];
    const observed: string[] = [];
    const gate = {
      activeRuns: (id: string) => { observed.push(id); return 'unknown' as const; },
      readBudget: async () => ({ action: 'next-provider' as const, reasons: ['first exhausted', 'fallback ready'] }),
    };
    const { program } = install(async (path) => { calls.push(['ask', path]); }, async (words) => { calls.push(['say', words]); },
      undefined, undefined, undefined, undefined, undefined, undefined, gate);
    const goal = join(tmpdir(), `launch-warning-${crypto.randomUUID()}.md`);
    const previousExit = process.exitCode;
    process.exitCode = 0;
    writeFileSync(goal, '# Goal\n- GoalId: 1234567890abcdef\n\nbody');
    try {
      await captureLog(() => program.parseAsync(['node', 'elanous', 'harness', 'ask', goal, '--dry-run']));
      expect(observed).toEqual([]);
      expect(calls).toEqual([]);
      const askWarnings = await captureError(() => program.parseAsync(['node', 'elanous', 'harness', 'ask', goal]));
      const sayWarnings = await captureError(() => program.parseAsync(['node', 'elanous', 'harness', 'say', 'new', 'goal']));
      expect(askWarnings).toEqual(['⚠️ launch gate: active runs unknown · first exhausted · fallback ready']);
      expect(sayWarnings).toEqual(askWarnings);
      expect(calls).toEqual([['ask', goal], ['say', ['new', 'goal']]]);
      expect(observed[0]).toBe('1234567890abcdef');
      expect(observed).toHaveLength(2);
      expect(process.exitCode).toBe(0);
    } finally { process.exitCode = previousExit ?? 0; rmSync(goal, { force: true }); }
  });

  test('ask keeps its default options without graph authority forwarding', async () => {
    const received: unknown[] = [];
    const { program } = install(async (_goalPath, options) => { received.push(options); });
    await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/tmp/goal.md']);
    expect(received).toEqual([{ supervise: true, supervisorSource: 'default' }]);
    expect(program.commands.find((command) => command.name() === 'harness')?.commands.find((command) => command.name() === 'ask')?.options.some((option) => option.long === '--graph')).toBe(false);
  });

  test('exposes and forwards force-preflight only when ask or say explicitly requests it', async () => {
    const received: unknown[] = [];
    const { program, harness } = install(
      async (goalPath, options) => { received.push(['ask', goalPath, options]); },
      async (words, options) => { received.push(['say', words, options]); },
    );
    for (const name of ['ask', 'say'] as const) {
      const options = harness.commands.find((command) => command.name() === name)!.options;
      const longs = options.map((option) => option.long);
      expect(longs).toContain('--force-preflight');
      expect(options.find((option) => option.long === '--force-preflight')?.description)
        .toBe('전제 검사 막힘을 명시 요청으로 우회(관측에 남음)');
      expect(longs).not.toContain('--no-launch-decomposition');
    }

    await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/tmp/goal.md']);
    await program.parseAsync(['node', 'elanous', 'harness', 'say', 'write', 'goal']);
    await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/tmp/goal.md', '--force-preflight']);
    await program.parseAsync(['node', 'elanous', 'harness', 'say', 'write', 'goal', '--force-preflight']);

    expect(received).toEqual([
      ['ask', '/tmp/goal.md', { supervise: true, supervisorSource: 'default' }],
      ['say', ['write', 'goal'], { supervise: true, supervisorSource: 'default' }],
      ['ask', '/tmp/goal.md', { forcePreflight: true, supervise: true, supervisorSource: 'default' }],
      ['say', ['write', 'goal'], { forcePreflight: true, supervise: true, supervisorSource: 'default' }],
    ]);
  });

  test('ask and say expose and forward --target and --yes without exposing them to plan', async () => {
    const received: unknown[] = [];
    const { program, harness } = install(
      async (goalPath, options) => { received.push(['ask', goalPath, options]); },
      async (words, options) => { received.push(['say', words, options]); },
    );
    for (const name of ['ask', 'say'] as const) {
      expect(harness.commands.find((command) => command.name() === name)!.options.map((option) => option.long)).toEqual(expect.arrayContaining(['--target', '--yes']));
    }
    expect(harness.commands.find((command) => command.name() === 'plan')!.options.map((option) => option.long)).not.toContain('--target');
    expect(harness.commands.find((command) => command.name() === 'plan')!.options.map((option) => option.long)).not.toContain('--yes');

    await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/tmp/goal.md', '--target', '/tmp/repo', '--yes']);
    await program.parseAsync(['node', 'elanous', 'harness', 'say', 'write', 'goal', '--target', '/tmp/dir', '--yes']);
    await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/tmp/no-target.md']);

    expect(received).toEqual([
      ['ask', '/tmp/goal.md', { target: '/tmp/repo', yes: true, supervise: true, supervisorSource: 'default' }],
      ['say', ['write', 'goal'], { target: '/tmp/dir', yes: true, supervise: true, supervisorSource: 'default' }],
      ['ask', '/tmp/no-target.md', { supervise: true, supervisorSource: 'default' }],
    ]);
  });

  test('a refused non-git launch returns exit 2 with one actionable error line', async () => {
    const prior = process.exitCode;
    const { program } = install(async () => {
      throw new DevPipelineError('git 저장소가 필요합니다 — `git init` 하거나 `--yes` 로 다시 · (다음 판: 그림자 저장소 — RFC P19)', 2);
    });
    try {
      const errors = await captureError(() => program.parseAsync(['node', 'elanous', 'harness', 'ask', '/tmp/goal.md']));
      expect(process.exitCode).toBe(2);
      expect(errors).toEqual(['❌ git 저장소가 필요합니다 — `git init` 하거나 `--yes` 로 다시 · (다음 판: 그림자 저장소 — RFC P19)']);
    } finally {
      process.exitCode = prior ?? 0;
    }
  });

  test('pod ask/say refuse --target with code 2 before dispatch; target-free ask still dispatches', async () => {
    const dispatch = spyOn(podDispatch, 'dispatchHarnessOnPod').mockImplementation(() => 0);
    const events: Array<{ category: string; event: string; data: unknown }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: unknown) => {
      events.push({ category, event, data });
    }) as typeof debug.log);
    const localCalls: string[] = [];
    const { program } = install(
      async () => { localCalls.push('ask'); },
      async () => { localCalls.push('say'); },
    );
    const previousExit = process.exitCode;
    try {
      for (const [entrance, args, target] of [
        ['ask', ['/tmp/goal.md'], '/x'],
        ['say', ['write', 'goal'], '/tmp/other'],
      ] as const) {
        process.exitCode = 0;
        const errors = await captureError(() => program.parseAsync([
          'node', 'elanous', 'harness', entrance, ...args, '--substrate', 'pod', '--pod-pool', 'pool-test:1', '--target', target,
        ]));
        expect(errors).toEqual([
          '`--target` 은 Pod 경로에서 아직 지원하지 않는다 — 로컬로 돌리거나 `--target` 을 빼라',
          'Pod 로 특정 원천을 주려면 `--source`',
        ]);
        expect(process.exitCode).toBe(2);
        expect(dispatch).toHaveBeenCalledTimes(0);
        expect(localCalls).toEqual([]);
      }
      expect(events.filter(({ category, event }) => category === 'harness.pod' && event === 'target-refused'))
        .toEqual([
          { category: 'harness.pod', event: 'target-refused', data: { target: '/x' } },
          { category: 'harness.pod', event: 'target-refused', data: { target: '/tmp/other' } },
        ]);
      process.exitCode = 0;
      await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/tmp/goal.md', '--substrate', 'pod', '--pod-pool', 'pool-test:1']);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ entrance: 'cli-harness-ask', input: '/tmp/goal.md', podPool: 'pool-test:1' }), expect.objectContaining({ onOutput: expect.any(Function) }));
      expect(process.exitCode).toBe(0);
    } finally {
      dispatch.mockRestore();
      log.mockRestore();
      process.exitCode = previousExit ?? 0;
    }
  });

  test('nonzero Pod exit appends one stop and preserves the previous ledger and exit classification', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-run-stop-'));
    const previous = process.env.ELANOUS_STATE_DIR;
    const exit = process.exitCode;
    const runId = 'run-12345678-1234-1234-1234-123456789abc';
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const dispatch = spyOn(podDispatch, 'dispatchHarnessOnPod').mockImplementation((_args, callbacks) => {
      callbacks?.onOutput?.(`[self-dev] 1 goal 병렬 실행 · run ${runId}\n${JSON.stringify([{ error: { code: 'pod-job-failed', message: 'pod-job-failed: childError=OOMKilled' } }])}`);
      return 1;
    });
    try {
      process.env.ELANOUS_STATE_DIR = root;
      appendRunLedgerEntry({ runId, event: 'start', data: { original: true } }, runLedgerDir(root));
      const { program } = install(async () => {}, async () => {}, undefined, undefined, undefined, undefined, undefined,
        async () => ({ cardId: 'card', mode: 'observe', decisions: {} as never }));
      process.exitCode = 0;
      await program.parseAsync(['node', 'elanous', 'harness', 'say', 'a request', '--substrate', 'pod', '--pod-pool', 'pool-test:1']);
      const ledger = loadRunLedger(runId, runLedgerDir(root))!;
      expect(ledger.filter((entry) => entry.event === 'stop')).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ event: 'start', data: { original: true } });
      const stop = readRunStopRecord(ledger[1]!);
      expect(stop).toBeDefined();
      const candidateDir = join(root, 'self-implement', 'knowhow-candidates');
      const files = readdirSync(candidateDir).filter((name) => name.endsWith('.json'));
      expect(files).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(candidateDir, files[0]!), 'utf8')))
        .toMatchObject({ reason: 'pod-job-failed', stage: 'pod-exit', occurrences: 1, runIds: [runId] });
      expect(ledger[1]).toMatchObject({ event: 'stop', data: { class: 'pod-died', terminationReason: 'pod-job-failed', cause: 'Pod exit 1: pod-failure — OOMKilled', evidenceRef: expect.any(String), nextMove: expect.any(String) } });
      expect(log).toHaveBeenCalledWith('harness.pod', 'exit-classified', expect.objectContaining({ runId, reason: 'pod-failure', status: 1 }));
      expect(process.exitCode).toBe(1);
      await program.parseAsync(['node', 'elanous', 'harness', 'say', 'a request', '--substrate', 'pod', '--pod-pool', 'pool-test:1']);
      expect(loadRunLedger(runId, runLedgerDir(root))!.filter((entry) => entry.event === 'stop')).toHaveLength(1);
    } finally {
      dispatch.mockRestore(); log.mockRestore(); process.exitCode = exit ?? 0;
      if (previous === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Pod ask/say record one host decision before dispatch and mark only a successful observation', async () => {
    const goal = join(tmpdir(), `pod-observe-${crypto.randomUUID()}.md`);
    writeFileSync(goal, '## Goal metadata\n- GoalId: 1234567890abcdef\n\nImplement the widget\n## TRACED PATHS\n- src/widget.ts\n');
    const calls: unknown[] = [];
    const dispatch = spyOn(podDispatch, 'dispatchHarnessOnPod').mockImplementation((args) => {
      calls.push(['pod', args]);
      return 0;
    });
    let fail = false;
    const records: unknown[] = [];
    const record = async (input: Parameters<NonNullable<Parameters<typeof installHarnessCliCommand>[1]['podDispatchTask']>>[0]) => {
      records.push(input);
      calls.push(['host', input]);
      if (fail) throw new Error('observation failed');
      return { cardId: 'card-host', mode: 'observe' as const, decisions: {} as never };
    };
    const { program } = install(async () => {}, async () => {}, undefined, undefined, undefined, undefined, undefined, record);
    const exit = process.exitCode;
    try {
      process.exitCode = 0;
      await captureError(() => program.parseAsync(['node', 'elanous', 'harness', 'ask', goal, '--substrate', 'pod', '--pod-pool', 'pool-test:1', '--target', '/tmp/other']));
      expect(process.exitCode).toBe(2);
      process.exitCode = 0;
      await captureLog(() => program.parseAsync(['node', 'elanous', 'harness', 'say', 'write', 'goal', '--substrate', 'pod', '--dry-run']));
      expect(records).toHaveLength(0);
      expect(dispatch).toHaveBeenCalledTimes(0);
      process.exitCode = 0;
      await program.parseAsync(['node', 'elanous', 'harness', 'ask', goal, '--substrate', 'pod', '--pod-pool', 'pool-test:1']);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ goalId: '1234567890abcdef', goalText: '## Goal metadata\n- GoalId: 1234567890abcdef\n\nImplement the widget\n## TRACED PATHS\n- src/widget.ts\n', targetPaths: ['src/widget.ts'], spec: { input: { file: goal } } });
      expect(calls.map((entry) => (entry as string[])[0])).toEqual(['host', 'pod']);
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ entrance: 'cli-harness-ask', input: goal, podPool: 'pool-test:1', dispatchRecorded: true });
      fail = true;
      await program.parseAsync(['node', 'elanous', 'harness', 'say', 'write', 'goal', '--substrate', 'pod', '--pod-pool', 'pool-test:1']);
      expect(records).toHaveLength(2);
      expect(records[1]).toMatchObject({ goalId: expect.stringMatching(/^request-[0-9a-f]{32}$/), goalText: 'write goal', targetPaths: [], spec: { input: { text: 'write goal' } } });
      expect(calls.map((entry) => (entry as string[])[0])).toEqual(['host', 'pod', 'host', 'pod']);
      expect(dispatch.mock.calls[1]?.[0]).toMatchObject({ entrance: 'cli-harness-say', input: 'write goal', podPool: 'pool-test:1' });
      expect(dispatch.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ onOutput: expect.any(Function) }));
      expect(process.exitCode).toBe(0);
    } finally {
      dispatch.mockRestore();
      process.exitCode = exit ?? 0;
      rmSync(goal, { force: true });
    }
  });

  test('harness ask reports an occupied-path preflight as launch-failed through the parent CLI', async () => {
    const root = mkdtempSync(join(tmpdir(), `pod-preflight-parent-${crypto.randomUUID()}-`));
    const origin = mkdtempSync(join(tmpdir(), `pod-preflight-origin-${crypto.randomUUID()}-`));
    const goal = join(root, 'goal.md');
    const previousCwd = process.cwd();
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Harness CLI test']);
    execFileSync('git', ['-C', root, 'config', 'user.email', 'harness-cli@example.invalid']);
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'occupied.ts'), 'export {};\n');
    writeFileSync(goal, 'Original ask (verbatim, unmodified):\n```\n신설: src/occupied.ts\n```\n## TRACED PATHS\n- src/occupied.ts\n');
    execFileSync('git', ['-C', root, 'add', '.']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'occupied path fixture']);
    execFileSync('git', ['clone', '-q', '--bare', root, origin]);
    execFileSync('git', ['-C', root, 'remote', 'add', 'origin', origin]);
    execFileSync('git', ['-C', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
    const previousState = process.env.ELANOUS_STATE_DIR;
    const previousExit = process.exitCode;
    const errors: string[] = [];
    const logs: Array<{ category: string; event: string; data: unknown }> = [];
    const originalError = console.error;
    const originalLog = debug.log;
    process.chdir(root);
    process.env.ELANOUS_STATE_DIR = root;
    process.exitCode = 0;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    debug.log = ((category: string, event: string, data?: unknown) => { logs.push({ category, event, data }); }) as typeof debug.log;
    try {
      const { program } = install(async () => {}, async () => {});
      await program.parseAsync(['node', 'elanous', 'harness', 'ask', goal, '--substrate', 'pod', '--pod-pool', 'pool-test:1']);

      expect(process.exitCode).toBe(2);
      const output = errors.join('\n');
      expect(output).toMatch(/\[self-dev\] run (run-[0-9a-f-]+) \[preflight:new-path-occupied:[0-9a-f-]+\]/);
      const runId = output.match(/\[self-dev\] run (run-[0-9a-f-]+) /)?.[1];
      expect(runId).toBeDefined();
      expect(loadRunLedger(runId!)?.some((entry) => entry.event === 'preflight-refused' && entry.data.path === 'src/occupied.ts')).toBe(true);
      expect(logs).toContainEqual(expect.objectContaining({ category: 'harness.pod', event: 'exit-classified', data: expect.objectContaining({ runId, reason: 'preflight-refused', status: 2 }) }));
      expect(loadRunLedger(runId!)?.some((entry) => entry.event === 'stop' && entry.data.class === 'launch-failed')).toBe(true);
    } finally {
      console.error = originalError;
      debug.log = originalLog;
      process.exitCode = previousExit ?? 0;
      process.chdir(previousCwd);
      if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousState;
      rmSync(root, { recursive: true, force: true });
      rmSync(origin, { recursive: true, force: true });
    }
  });

  test('Pod say forwards --goal-type document without --pod-memory to the dispatcher', async () => {
    const dispatch = spyOn(podDispatch, 'dispatchHarnessOnPod').mockImplementation(() => 0);
    const previousExit = process.exitCode;
    try {
      process.exitCode = 0;
      const { program } = install(async () => {}, async () => {}, undefined, undefined, undefined, undefined, undefined,
        async () => ({ cardId: 'card', mode: 'observe', decisions: {} as never }));
      await program.parseAsync(['node', 'elanous', 'harness', 'say', 'write guide', '--goal-type', 'document', '--substrate', 'pod', '--pod-pool', 'pool-test:1']);
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ entrance: 'cli-harness-say', input: 'write guide', goalType: 'document' });
      expect(dispatch.mock.calls[0]?.[0].podMemory).toBeUndefined();
    } finally { dispatch.mockRestore(); process.exitCode = previousExit ?? 0; }
  });

  test('real harness ask/say entrances forward the pool to self orchestration; N=2 holds a third kubectl Job apply', async () => {
    const goal = join(tmpdir(), `pod-admission-${crypto.randomUUID()}.md`);
    // The orchestrate done-boundary gate withholds goals without the three
    // «완료 경계» declarations, so each goal text carries them to reach spawn.
    const withDoneBoundary = (title: string) => [
      title,
      '- 완료 경계 코드: kubectl Job 적용이 admission 예산 안에서만 나간다',
      '- 완료 경계 실물: 셋째 Job 이 대기열에서 풀려 적용된다',
      '- 완료 경계 증거 명령: bun test src/harness/harness-cli-command.test.ts',
    ].join('\n');
    const firstGoal = withDoneBoundary('First distinct goal');
    const secondGoal = withDoneBoundary('Second distinct goal');
    const thirdGoal = withDoneBoundary('Third distinct goal');
    writeFileSync(goal, firstGoal);
    const leaseRoot = mkdtempSync(join(tmpdir(), 'pod-admission-lease-'));
    const pool = new PodPoolScheduler(parsePodPool('fake:3'), { hostLease: new HostPoolLease('n2-fixture', { dir: leaseRoot, processStart: () => 'fixture' }), status: () => ({
      recommended: 2, accountSlots: 99, limitedBy: 'capacity', reason: null,
      capacitySlots: 3, memorySlots: 3, placeableSlots: 3, running: 0, pending: 0,
    }), pollMs: 2 });
    const fakeKubectl = createFakeKubectl({ context: 'fake', node: 'fake-node', jobState: 'running' });
    const applied: string[] = [];
    const appliedWaiters: Array<() => void> = [];
    const waitForApplied = async (count: number) => {
      while (applied.length < count) await new Promise<void>((resolve) => appliedWaiters.push(resolve));
    };
    const completed = new Set<string>();
    const kubectl: Kubectl = (args, input) => {
      if (args.includes('apply') && input) {
        const object = JSON.parse(input) as { kind: string; metadata: { name: string } };
        const result = fakeKubectl.kubectl(args, input);
        if (result.status !== 0) return result;
        if (object.kind === 'Job') { applied.push(object.metadata.name); appliedWaiters.splice(0).forEach((resolve) => resolve()); }
        return result;
      }
      if (args.includes('get') && args.includes('job')) {
        const name = args[args.indexOf('job') + 1]!;
        if (!fakeKubectl.hasJob(name)) return { status: 1, stdout: '', stderr: 'NotFound' };
        if (args.some((arg) => arg.includes('.status.conditions[*].type'))) {
          return { status: 0, stdout: completed.has(name) ? 'Complete' : '', stderr: '' };
        }
        if (args.some((arg) => arg.includes('.metadata.uid'))) return { status: 0, stdout: name + '-uid ', stderr: '' };
        return fakeKubectl.kubectl(args, input);
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const spawn = podSelfImplementSpawn({ pool, kubectl, env: {}, repoUrl: 'not-a-github-repository',
      credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 't' }), pollMs: 2 });
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const jobs: ReturnType<typeof spawn>[] = [];
    const forwarded: string[] = [];
    const receivedGoals: string[] = [];
    const runs: ReturnType<typeof runSelfOrchestrateCliCommand>[] = [];
    const dispatch = spyOn(podDispatch, 'dispatchHarnessOnPod').mockImplementation((input) => {
      // PROC1: the goal travels as a file path, never as argv text.
      const goalText = input.entrance === 'cli-harness-ask' ? readFileSync(input.input, 'utf8') : input.input;
      const args = podDispatch.podOrchestrateArgs(input, '/goal-file.md');
      forwarded.push(args[args.indexOf('--pod-pool') + 1]!);
      expect(args).not.toContain(goalText);
      receivedGoals.push(goalText);
      const index = runs.length;
      runs.push(runSelfOrchestrateCliCommand({ goals: [{ feature: goalText }], concurrency: 1,
        runtime: { spawn: (jobInput) => {
          const job = spawn({ ...jobInput, spaceId: `goal-${index}`, signal: controllers[index]!.signal });
          jobs.push(job);
          return job;
        } },
      }));
      return 0;
    });
    const { program } = install(async () => {}, async () => {});
    const previousExit = process.exitCode;
    const waitUntil = async (predicate: () => boolean) => {
      for (let i = 0; i < 100 && !predicate(); i++) await Bun.sleep(5);
      expect(predicate()).toBe(true);
    };
    try {
      process.exitCode = 0;
      await program.parseAsync(['node', 'elanous', 'harness', 'ask', goal, '--substrate', 'pod', '--pod-pool', 'fake:3']);
      await program.parseAsync(['node', 'elanous', 'harness', 'say', secondGoal, '--substrate', 'pod', '--pod-pool', 'fake:3']);
      expect(forwarded).toEqual(['fake:3', 'fake:3']);
      expect(receivedGoals).toEqual([firstGoal, secondGoal]);
      const third = runSelfOrchestrateCliCommand({
        goals: [{ feature: thirdGoal }], concurrency: 1, runtime: { spawn: (input) => {
          const job = spawn({ ...input, signal: controllers[2]!.signal });
          jobs.push(job);
          return job;
        } },
      });
      await waitForApplied(2);
      expect(pool.admissionSnapshot()).toMatchObject({ active: 2, queued: 1 });
      expect(applied[0]).toContain('goal-0');
      expect(applied[1]).toContain('goal-1');
      expect(pool.admissionSnapshot()).toMatchObject({ active: 2, queued: 1 });
      await Bun.sleep(10);
      expect(applied).toHaveLength(2);
      completed.add(applied[0]!);
      await jobs[0]!.done;
      await waitForApplied(3);
      expect(applied[2]).not.toContain('goal-0');
      expect(applied[2]).not.toContain('goal-1');
      completed.add(applied[1]!);
      completed.add(applied[2]!);
      await Promise.all(jobs.slice(1).map((job) => job.done));
      expect((await third).ok).toBe(true);
      expect((await Promise.all(runs)).every((result) => result.ok)).toBe(true);
    } finally {
      dispatch.mockRestore();
      controllers.forEach((controller) => controller.abort());
      for (const name of applied) completed.add(name);
      await Promise.all(jobs.map((job) => job.done));
      process.exitCode = previousExit ?? 0;
      rmSync(goal, { force: true });
      rmSync(leaseRoot, { recursive: true, force: true });
    }
  }, 20_000);

  test('Pod ask with an unreadable goal still reaches Pod dispatch without falsely claiming a host recording', async () => {
    const missing = join(tmpdir(), `pod-observe-missing-${crypto.randomUUID()}.md`);
    const records: unknown[] = [];
    const dispatch = spyOn(podDispatch, 'dispatchHarnessOnPod').mockImplementation(() => 0);
    const exit = process.exitCode;
    try {
      process.exitCode = 0;
      const { program } = install(async () => {}, undefined, undefined, undefined, undefined, undefined, undefined,
        async (input) => { records.push(input); return { cardId: 'card', mode: 'observe', decisions: {} as never }; });
      await program.parseAsync(['node', 'elanous', 'harness', 'ask', missing, '--substrate', 'pod', '--pod-pool', 'pool-test:1']);
      expect(records).toEqual([]);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ entrance: 'cli-harness-ask', input: missing, podPool: 'pool-test:1' });
      expect(process.exitCode).toBe(0);
    } finally {
      dispatch.mockRestore();
      process.exitCode = exit ?? 0;
    }
  });

  test('missing Pod result distinguishes signal, human stop, last supervisor verdict, PR, and absent launch', () => {
    const runId = 'run-12345678-1234-1234-1234-123456789abc';
    const pr = 'https://github.com/example/repo/pull/42';
    const entry = (event: string, data: Record<string, unknown> = {}) => ({ runId, event, data });
    const ledger = (entries: NonNullable<ReturnType<typeof import('../self-implement/run-ledger.js').loadRunLedger>>) => ({
      runId, loadLedger: () => entries, hasJobApplied: () => false, supervisorDecision: () => undefined,
      loadCheckpoint: () => null,
    });
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(harnessPodRunId(`prefix\n[self-dev] 1 goal 병렬 실행 · run ${runId}\n`)).toBe(runId);
      expect(harnessPodRunId('no run')).toBeUndefined();
      expect(harnessPodRunId('[self-dev] 1 goal 병렬 실행 · run run-12345678')).toBe('run-12345678');
      let tail = '';
      let rememberedRunId: string | undefined;
      for (const chunk of [`[self-dev] 1 goal 병렬 실행 · run ${runId}\n`, 'x'.repeat(17_000)]) {
        tail = (tail + chunk).slice(-16_000);
        rememberedRunId ??= harnessPodRunId(tail);
      }
      expect(tail).not.toContain(runId);
      expect(classifyHarnessPodExit({ status: 1 }, tail, {
        ...ledger([entry('human-stop')]), runId: rememberedRunId,
      }).lines).toEqual(['사람이 멈춘 런이다']);
      expect(classifyHarnessPodExit({ status: null, signal: 'SIGTERM' }, '', ledger([])).lines[0])
        .toStartWith('런이 멈췄다(SIGTERM)');
      expect(classifyHarnessPodExit({ status: 143 }, '', ledger([])).lines[0])
        .toStartWith('런이 멈췄다(SIGTERM)');
      // harness stop records human-stop and then signals — the recorded stop is the more specific reason.
      expect(classifyHarnessPodExit({ status: null, signal: 'SIGTERM' }, '', ledger([
        entry('human-stop'), entry('pr-opened', { url: pr }),
      ])).lines).toEqual(['사람이 멈춘 런이다', `PR 이 남아 있다: ${pr}`]);
      expect(classifyHarnessPodExit({ status: 1 }, '', ledger([entry('human-stop')])).lines)
        .toEqual(['사람이 멈춘 런이다']);
      // Round 3: a run id merely quoted in the output is another run — never read its ledger.
      const quoted: string[] = [];
      expect(classifyHarnessPodExit({ status: 1 }, 'started run-0f5f7c5f', {
        loadLedger: (id) => { quoted.push(id); return id === 'run-0f5f7c5f' ? [entry('human-stop')] : null; },
        hasJobApplied: () => false, supervisorDecision: () => undefined, loadCheckpoint: () => null,
      }).lines).toEqual(['Pod 실행 여부 또는 종료 이유를 확인하지 못했다']);
      expect(quoted).toEqual([]);
      expect(classifyHarnessPodExit({ status: 1 }, '', ledger([
        entry('rework-budget', { verdict: 'converged', reason: '기존 판정' }), entry('human-stop'),
      ])).lines).toEqual(['사람이 멈춘 런이다']);
      expect(classifyHarnessPodExit({ status: 1 }, '', ledger([
        entry('rework-budget', { verdict: 'CONTRACT-CONFLICT', reason: 'first' }),
        entry('rework-budget', { verdict: 'UNCONVERGEABLE', reason: '수렴 안 함\nsecond' }),
        entry('pr-opened', { url: pr }),
      ])).lines).toEqual(['감독 판정: UNCONVERGEABLE — 수렴 안 함', `PR 이 남아 있다: ${pr}`]);
      // Round 3: a continuing verdict is not why the run ended.
      for (const verdict of ['EXTEND', 'SUFFICIENT']) {
        const continuing = classifyHarnessPodExit({ status: 1 }, '', ledger([
          entry('rework-budget', { verdict: 'UNCONVERGEABLE', reason: '옛 판정' }),
          entry('rework-budget', { verdict, reason: '계속' }),
        ]));
        expect(continuing.reason).toBe('supervisor');
        expect(continuing.lines).toEqual(['감독 판정: UNCONVERGEABLE — 옛 판정']);
        const onlyContinuing = classifyHarnessPodExit({ status: 1 }, '', ledger([entry('rework-budget', { verdict, reason: '계속' })]));
        expect(onlyContinuing.reason).toBe('unknown');
        expect(onlyContinuing.lines).toEqual(['Pod 실행 여부 또는 종료 이유를 확인하지 못했다']);
      }
      expect(classifyHarnessPodExit({ status: 1 }, '', ledger([
        entry('run-status', { stage: 'review-blocked', supervisorReason: 'HITL 승인 필요' }),
      ])).lines).toEqual(['감독 판정: review-blocked — HITL 승인 필요']);
      expect(classifyHarnessPodExit({ status: 1 }, 'started run-0f5f7c5f', {
        ...ledger([]), runId: undefined, loadLedger: (id) => id === 'run-0f5f7c5f' ? [
          { runId: id, event: 'pr-opened', data: { url: pr } },
        ] : null,
      }).lines).toEqual(['Pod 실행 여부 또는 종료 이유를 확인하지 못했다']);
      expect(classifyHarnessPodExit({ status: 1 }, '', {
        ...ledger([]), supervisorDecision: () => ({ stopReason: 'needs-human', why: '승인 대기' }),
      }).lines).toEqual(['감독 판정: needs-human — 승인 대기']);
      expect(classifyHarnessPodExit({ status: 1 }, '', {
        ...ledger([]), loadCheckpoint: () => ({
          runId, createdAt: 1, updatedAt: 2, supervisorStopReason: 'needs-human',
          results: [{ prUrl: pr } as never],
        }),
      }).lines).toEqual(['감독 판정: needs-human', `PR 이 남아 있다: ${pr}`]);
      expect(classifyHarnessPodExit({ status: 1 }, '', {
        ...ledger([entry('rework-budget', { verdict: 'EXTEND', reason: '과거 판정' })]),
        supervisorDecision: () => ({ stopReason: 'converged', why: '완주' }),
      }).lines).toEqual(['감독 판정: converged — 완주']);
      expect(classifyHarnessPodExit({ status: 1 }, `created ${pr}`, ledger([])).lines)
        .toEqual(['Pod 실행 여부 또는 종료 이유를 확인하지 못했다', `PR 이 남아 있다: ${pr}`]);
      expect(classifyHarnessPodExit({ status: 1 }, '', ledger([entry('job-applied')])).lines)
        .toEqual(['Pod 실행 여부 또는 종료 이유를 확인하지 못했다']);
      expect(classifyHarnessPodExit({ status: 1 }, '', ledger([entry('job-applied')])).reason).toBe('unknown');
      expect(classifyHarnessPodExit({ status: 1 }, '', {
        ...ledger([entry('job-applied')]), hasJobApplied: () => true,
      }).lines).toEqual(['Pod 실행 여부 또는 종료 이유를 확인하지 못했다']);
      expect(classifyHarnessPodExit({ status: 1 }, '', ledger([entry('pod-child-run', { job: 'si-x' })])).lines)
        .toEqual(['Pod 실행 여부 또는 종료 이유를 확인하지 못했다']);
      const noLaunch = classifyHarnessPodExit({ status: 1 }, '', ledger([]));
      expect(noLaunch.lines)
        .toEqual(['Pod 실행에 닿지 못했다 — 풀·컨텍스트·SSH 연결을 확인하거나 `--substrate local` 로 명시하라']);
      expect(noLaunch.reason).toBe('no-launch');
      expect(classifyHarnessPodExit({ status: 1 }, '', {
        loadLedger: () => { throw new Error('runId should not be invented'); },
        hasJobApplied: () => false, supervisorDecision: () => undefined, loadCheckpoint: () => null,
      }).lines).toEqual(['Pod 실행 여부 또는 종료 이유를 확인하지 못했다']);
      expect(classifyHarnessPodExit({ status: 1 }, `[${JSON.stringify({ error: { code: 'pod-job-failed', message: 'childError=child failed\\nlog' } })}]`, ledger([])).lines)
        .toEqual(['Pod 안 자식이 실패했다 — child failed']);
      expect(classifyHarnessPodExit({ status: 1 }, '', { ...ledger([]), hasJobApplied: () => true }).lines)
        .toEqual(['Pod 실행 여부 또는 종료 이유를 확인하지 못했다']);
      expect(classifyHarnessPodExit({ status: 1 }, '', { ...ledger([]), hasJobApplied: () => undefined }).lines)
        .toEqual(['Pod 실행 여부 또는 종료 이유를 확인하지 못했다']);
      expect(log).toHaveBeenCalledWith('harness.pod', 'exit-classified',
        { runId, reason: 'unknown', status: 1, signal: null });
      expect(log).toHaveBeenCalledWith('harness.pod', 'exit-classified',
        { runId, reason: 'pod-failure', status: 1, signal: null });
      expect(log).toHaveBeenCalledWith('harness.pod', 'exit-classified',
        { runId, reason: 'signal', status: null, signal: 'SIGTERM' });
      expect(log).toHaveBeenCalledWith('harness.pod', 'exit-classified',
        { runId, reason: 'human-stop', status: 1, signal: null });
      expect(log).toHaveBeenCalledWith('harness.pod', 'exit-classified',
        { runId, reason: 'supervisor', status: 1, signal: null });
      expect(log).toHaveBeenCalledWith('harness.pod', 'exit-classified',
        { runId, reason: 'no-launch', status: 1, signal: null });
    } finally { log.mockRestore(); }
  });

  test('unknown Pod exits use recognizable output tail causes without misattributing bare exits', () => {
    const deps = { loadLedger: () => null, hasJobApplied: () => undefined,
      supervisorDecision: () => undefined, loadCheckpoint: () => null };
    for (const [output, reason] of [
      ['pod-error: Pod pool unavailable', 'pod-error'],
      ['❌ launch gate: blocked-duplicate — active run', 'launch-gate-blocked'],
      ['Error: ENOBUFS, buffer full', 'ENOBUFS'],
      ['Job si-x failed (OOMKilled/137)', 'OOMKilled'],
      ['❌ blocked · task B — DEP_FAILED', 'dep-blocked'],
      ['❌ blocked · task C — DEPENDENCY_NEEDS_HUMAN', 'dep-blocked'],
      ['❌ blocked · task D — DEP_BLOCKED_REBASE_READY', 'dep-blocked'],
    ] as const) {
      const result = classifyHarnessPodExit({ status: 1 }, output, deps);
      expect(result.reason).toBe(reason);
      expect(result.lines[0]).toContain(reason);
    }
    expect(classifyHarnessPodExit({ status: 1 }, 'unrelated output', deps).reason).toBe('unknown');
    expect(classifyHarnessPodExit({ status: 1 }, '❌ blocked · DEPENDENCY_NEEDS_HUMAN', {
      ...deps, loadLedger: () => [{ runId: 'run-0f5f7c5f', event: 'human-stop', data: {} }],
      runId: 'run-0f5f7c5f',
    }).reason).toBe('human-stop');
  });

  test('an unreadable or missing ledger never proves a Pod launch was absent', () => {
    for (const loadLedger of [
      () => { throw new Error('unreadable ledger'); },
      () => null,
    ]) {
      const result = classifyHarnessPodExit({ status: 1 }, 'started run-0f5f7c5f', {
        loadLedger,
        hasJobApplied: () => false,
        supervisorDecision: () => undefined,
        loadCheckpoint: () => null,
      });
      expect(result.lines).toEqual(['Pod 실행 여부 또는 종료 이유를 확인하지 못했다']);
      expect(result.reason).toBe('unknown');
    }
  });

  test('job-applied lookup checks runId even when output names another si job', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-exit-'));
    const previousState = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = root;
    const store = new LogStore(join(root, 'logs', 'logs.db'));
    const runId = 'run-0f5f7c5f';
    try {
      store.insertBatch([{ rec: { ts: new Date().toISOString(), category: 'self-implement.pod', event: 'job-applied',
        data: { runId, job: 'si-actual' } }, surface: 'cli' }]);
      const result = classifyHarnessPodExit({ status: 1 }, `started ${runId} si-stale`, {
        loadLedger: () => [], supervisorDecision: () => undefined, loadCheckpoint: () => null,
      });
      expect(result.lines).toEqual(['Pod 실행 여부 또는 종료 이유를 확인하지 못했다']);
      const runIdOnly = 'run-4e6ba007';
      store.insertBatch([{ rec: { ts: new Date().toISOString(), category: 'self-implement.pod', event: 'job-applied',
        data: { runId: runIdOnly } }, surface: 'cli' }]);
      expect(classifyHarnessPodExit({ status: 1 }, `started ${runIdOnly} si-stale`, {
        loadLedger: () => [], supervisorDecision: () => undefined, loadCheckpoint: () => null,
      }).lines).toEqual(['Pod 실행 여부 또는 종료 이유를 확인하지 못했다']);
    } finally {
      store.close();
      if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousState;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('ask and say retain runId from a single oversized output chunk before bounding the tail', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-run-id-'));
    const previousState = process.env.ELANOUS_STATE_DIR;
    const runId = `run-${crypto.randomUUID()}`;
    mkdirSync(join(root, 'run-ledger'));
    writeFileSync(join(root, 'run-ledger', `${runId}.jsonl`),
      `${JSON.stringify({ runId, event: 'human-stop', data: {} })}\n`);
    process.env.ELANOUS_STATE_DIR = root;
    const dispatch = spyOn(podDispatch, 'dispatchHarnessOnPod').mockImplementation((_input, deps) => {
      deps?.onOutput?.(`[self-dev] 1 goal 병렬 실행 · run ${runId}\n${'x'.repeat(17_000)}`);
      return 1;
    });
    const previousExit = process.exitCode;
    try {
      for (const args of [['ask', '/tmp/goal.md'], ['say', 'write', 'goal']]) {
        process.exitCode = 0;
        const errors = await captureError(() => install(async () => {}, async () => {}).program.parseAsync([
          'node', 'elanous', 'harness', ...args, '--substrate', 'pod', '--pod-pool', 'pool-test:1',
        ]));
        expect(errors).toEqual(['사람이 멈춘 런이다']);
        expect(process.exitCode).toBe(1);
      }
    } finally {
      dispatch.mockRestore();
      process.exitCode = previousExit ?? 0;
      if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousState;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('POD-EXIT-REASON-SHOWN: real Pod producer pod-child-failed output reaches ask/say CLI as the Pod reason, not unknown', async () => {
    const previousExit = process.exitCode;
    const dispatch = spyOn(podDispatch, 'dispatchHarnessOnPod');
    const { program } = install(async () => {}, async () => {}, undefined, undefined, undefined, undefined, undefined,
      async () => ({ cardId: 'card', mode: 'observe', decisions: {} as never }));
    // Injected readers: the «before» classification must not read this machine's ledgers or checkpoints.
    const noLedger = { loadLedger: () => [], supervisorDecision: () => undefined, loadCheckpoint: () => null, hasJobApplied: () => true };
    try {
      for (const [entrance, stage, childResult] of [
        ['ask', 'review-blocked', { stage: 'review-blocked', ok: false, prNumber: 8 }],
        ['say', 'review-blocked', { stage: 'review-blocked', ok: false, prNumber: 9, prUrl: 'https://github.com/o/r/pull/9' }],
        ['say', 'host-regate-failed', { stage: 'merge-ready', ok: true, prNumber: 8, checkedHeadCommit: 'b'.repeat(40) }],
      ] as const) {
        const logs = JSON.stringify(childResult);
        const kubectl: Kubectl = (args) => {
          if (args.includes('current-context')) return { status: 0, stdout: 'test-context\n', stderr: '' };
          if (args.some((arg) => arg.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
          if (args.some((arg) => arg.includes('conditions[?(@.type=="Failed")].reason'))) return { status: 0, stdout: '', stderr: '' };
          if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Complete', stderr: '' };
          if (args.includes('logs')) return { status: 0, stdout: logs, stderr: '' };
          return { status: 0, stdout: '', stderr: '' };
        };
        // Real producer: src/task-orchestrator/surfaces/self-implement-pod.ts emits pod-child-failed with the Pod reason.
        const produced = await podSelfImplementSpawn({
          kubectl, credentials: () => ({ elanousAuth: '{"m":1}', codexAuth: '{"c":1}', ghToken: 'gho_x' }),
          ...(stage === 'host-regate-failed' ? { hostRegate: async () => ({ passed: false, failures: [{ step: 'test-interference', detail: 'combined fail' }], os: process.platform }) } : {}),
        })({ feature: 'x', spaceId: `cli-pod-${stage}-${entrance}`, autoMerge: true }).done;
        expect(produced.exitCode).toBe(1);
        expect(produced.disposition?.stage).toBe(stage);
        expect(produced.error?.code).toBe('pod-child-failed');
        const podReason = produced.error!.message;
        expect(podReason.length).toBeGreaterThan(0);
        // The failed-job mapping of src/self-dev/orchestrate.ts (error ⊕ disposition stage ⊕ prUrl), then the real summary line.
        const job = { feature: 'x', status: 'failed' as const, error: produced.error!,
          ...(produced.disposition?.stage ? { stage: produced.disposition.stage } : {}),
          ...(produced.disposition?.prUrl ? { prUrl: produced.disposition.prUrl } : {}) };
        const output = `[self-dev] 완료 — 0/1 done\n${formatOrchestrateResultLine(job)}\n`;
        // Before: the summary printed only the code for pod-child-failed, so the classifier fell to unknown.
        const before = output.replace(`pod-child-failed: ${podReason}`, 'pod-child-failed');
        expect(before).not.toBe(output);
        expect(classifyHarnessPodExit({ status: 1 }, before, noLedger).reason).toBe('unknown');
        // After: the Pod reason survives.
        expect(classifyHarnessPodExit({ status: 1 }, output, noLedger)).toEqual({ reason: 'pod-failure', lines: [`Pod 안 자식이 실패했다 — ${podReason.split('\\n', 1)[0]}`] });
        dispatch.mockImplementation((_input, deps) => { deps?.onOutput?.(output); return 1; });
        process.exitCode = 0;
        const errors = await captureError(() => program.parseAsync([
          'node', 'elanous', 'harness', entrance, entrance === 'ask' ? '/tmp/goal.md' : 'write goal',
          '--substrate', 'pod', '--pod-pool', 'pool-test:1',
        ]));
        expect(errors).toEqual([`Pod 안 자식이 실패했다 — ${podReason.split('\\n', 1)[0]}`]);
        expect(process.exitCode).toBe(1);
      }
    } finally { dispatch.mockRestore(); process.exitCode = previousExit ?? 0; }
  });

  test('pod ask distinguishes a failed child result from a launch failure', async () => {
    const previousExit = process.exitCode;
    const record = async () => ({ cardId: 'card', mode: 'observe' as const, decisions: {} as never });
    const dispatch = spyOn(podDispatch, 'dispatchHarnessOnPod').mockImplementation((_input, deps) => {
      deps?.onOutput?.(JSON.stringify([{ status: 'failed', error: { code: 'pod-job-failed', message: 'Job si-x failed (container=Error/1) — childStage=error · childError=draft PR 생성 실패\nself-implement PR gh 실패: GraphQL: API rate limit already exceeded' } }]) + '\n');
      return 1;
    });
    try {
      const { program } = install(async () => {}, undefined, undefined, undefined, undefined, undefined, undefined, record);
      process.exitCode = 0;
      const child = await captureError(() => program.parseAsync(['node', 'elanous', 'harness', 'ask', '/tmp/goal.md', '--substrate', 'pod', '--pod-pool', 'pool-test:1']));
      expect(child).toEqual(['Pod 안 자식이 실패했다 — draft PR 생성 실패']);
      expect(dispatch.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ onOutput: expect.any(Function) }));
      expect(process.exitCode).toBe(1);
      dispatch.mockImplementation((_input, deps) => {
        deps?.onOutput?.('[self-dev] 완료 — 0/1 done\n  ❌ failed · x — pod-job-failed: Job si-x failed (container=Error/1) — childStage=error · childError=draft PR 생성 실패\n');
        return 1;
      });
      process.exitCode = 0;
      const summary = await captureError(() => program.parseAsync(['node', 'elanous', 'harness', 'ask', '/tmp/goal.md', '--substrate', 'pod', '--pod-pool', 'pool-test:1']));
      expect(summary).toEqual(['Pod 안 자식이 실패했다 — draft PR 생성 실패']);
      dispatch.mockImplementation((_input, deps) => {
        deps?.onOutput?.(JSON.stringify([{ status: 'failed', error: { code: 'pod-oom-killed', message: 'Job si-x failed (OOMKilled/137)' } }]) + '\n');
        return 1;
      });
      process.exitCode = 0;
      const oom = await captureError(() => program.parseAsync(['node', 'elanous', 'harness', 'ask', '/tmp/goal.md', '--substrate', 'pod', '--pod-pool', 'pool-test:1']));
      expect(oom).toEqual(['Pod 실행이 실패했다 — Job si-x failed (OOMKilled/137)']);
      dispatch.mockImplementation((_input, deps) => {
        deps?.onOutput?.(JSON.stringify([{ status: 'failed', error: { code: 'pod-error', message: 'Pod 풀 준비 실패' } }]) + '\n');
        return 1;
      });
      process.exitCode = 0;
      const setup = await captureError(() => program.parseAsync(['node', 'elanous', 'harness', 'ask', '/tmp/goal.md', '--substrate', 'pod', '--pod-pool', 'pool-test:1']));
      expect(setup).toEqual(['Pod 실행이 실패했다 — Pod 풀 준비 실패']);
      dispatch.mockImplementation((_input, deps) => {
        deps?.onOutput?.(JSON.stringify([{ status: 'failed', error: { code: 'pod-job-failed', message: 'Job si-x failed (container=Error/1) — childError=no-result-line' } }]) + '\n');
        return 1;
      });
      process.exitCode = 0;
      const missing = await captureError(() => program.parseAsync(['node', 'elanous', 'harness', 'ask', '/tmp/goal.md', '--substrate', 'pod', '--pod-pool', 'pool-test:1']));
      expect(missing).toEqual(['Pod 실행이 실패했다 — Job si-x failed (container=Error/1) — childError=no-result-line']);
      dispatch.mockImplementation(() => 1);
      process.exitCode = 0;
      const launch = await captureError(() => program.parseAsync(['node', 'elanous', 'harness', 'ask', '/tmp/goal.md', '--substrate', 'pod', '--pod-pool', 'pool-test:1']));
      expect(launch).toEqual(['Pod 실행 여부 또는 종료 이유를 확인하지 못했다']);
      expect(process.exitCode).toBe(1);
      dispatch.mockImplementation(() => 143);
      process.exitCode = 0;
      const { program: sayProgram } = install(async () => {}, async () => {}, undefined, undefined, undefined, undefined, undefined, record);
      const stopped = await captureError(() => sayProgram.parseAsync(['node', 'elanous', 'harness', 'say', 'write', 'goal', '--substrate', 'pod', '--pod-pool', 'pool-test:1']));
      expect(stopped).toEqual(['런이 멈췄다(SIGTERM) — `harness stop` 이나 세션 종료일 수 있다 · 그 전까지 만든 PR 은 남아 있다']);
      expect(process.exitCode).toBe(143);
    } finally { dispatch.mockRestore(); process.exitCode = previousExit ?? 0; }
  });

  test('ask and say expose and forward opaque --correlation without exposing it to plan or mission', async () => {
    const received: unknown[] = [];
    const { program, harness } = install(
      async (goalPath, options) => { received.push(['ask', goalPath, options]); },
      async (words, options) => { received.push(['say', words, options]); },
      undefined,
      undefined,
      async () => {},
    );
    for (const name of ['ask', 'say'] as const) {
      const command = harness.commands.find((candidate) => candidate.name() === name)!;
      expect(command.options.map((option) => option.long)).toContain('--correlation');
      expect(command.helpInformation()).toContain('--correlation <id>');
    }
    expect(harness.commands.find((command) => command.name() === 'plan')!.options.map((option) => option.long)).not.toContain('--correlation');
    expect(harness.commands.find((command) => command.name() === 'mission')!.options.map((option) => option.long)).not.toContain('--correlation');

    await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/tmp/goal.md', '--correlation', 'request/run:opaque']);
    await program.parseAsync(['node', 'elanous', 'harness', 'say', 'write', 'goal', '--correlation', 'say-correlation']);
    await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/tmp/no-correlation.md']);

    expect(received).toEqual([
      ['ask', '/tmp/goal.md', { correlation: 'request/run:opaque', supervise: true, supervisorSource: 'default' }],
      ['say', ['write', 'goal'], { correlation: 'say-correlation', supervise: true, supervisorSource: 'default' }],
      ['ask', '/tmp/no-correlation.md', { supervise: true, supervisorSource: 'default' }],
    ]);
  });

  test('ask and say expose and forward canonical --goal-type while invalid values fail before dry-run', async () => {
    const received: unknown[] = [];
    const { program, harness } = install(
      async (goalPath, options) => { received.push(['ask', goalPath, options]); },
      async (words, options) => { received.push(['say', words, options]); },
    );
    for (const name of ['ask', 'say'] as const) {
      expect(harness.commands.find((command) => command.name() === name)!.options.map((option) => option.long)).toContain('--goal-type');
    }
    await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/tmp/goal.md', '--goal-type', 'research']);
    await program.parseAsync(['node', 'elanous', 'harness', 'say', 'write', 'goal', '--goal-type', 'document']);
    expect(received).toEqual([
      ['ask', '/tmp/goal.md', { goalType: 'research', supervise: true, supervisorSource: 'default' }],
      ['say', ['write', 'goal'], { goalType: 'document', supervise: true, supervisorSource: 'default' }],
    ]);
    await expect(program.parseAsync(['node', 'elanous', 'harness', 'ask', '/tmp/goal.md', '--goal-type', 'nonsense', '--dry-run']))
      .rejects.toThrow(/implement.*research.*document.*operate/);
  });

  test('ask dry-run does not show a configurable graph authority or dispatch', async () => {
    const received: unknown[] = [];
    const { program } = install(async (_goalPath, options) => { received.push(options); });
    const lines = await captureLog(() => program.parseAsync([
      'node', 'elanous', 'harness', 'ask', '/tmp/goal.md', '--dry-run',
    ]));
    expect(received).toEqual([]);
    expect(lines.some((line) => line.includes('graph authority:'))).toBe(false);
  });

  test('registers the RFC-only plan entrance while retaining ask/say handlers', async () => {
    const received: unknown[] = [];
    const { program, harness } = install(
      async (goalPath, options) => { received.push(['ask', goalPath, options]); },
      async (words, options) => { received.push(['say', words, options]); },
    );
    const plan = harness.commands.find((command) => command.name() === 'plan')!;
    expect(harness.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(['ask', 'say', 'plan', 'processes']),
    );
    expect(plan.helpInformation()).toContain('harness plan [options] <sentence...>');
    expect(plan.helpInformation()).toContain('RFC를 쓰고 실행하지 않는다');

    await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/tmp/goal.md']);
    await program.parseAsync(['node', 'elanous', 'harness', 'say', 'write', 'goal']);
    expect(received).toEqual([
      ['ask', '/tmp/goal.md', { supervise: true, supervisorSource: 'default' }],
      ['say', ['write', 'goal'], { supervise: true, supervisorSource: 'default' }],
    ]);

    // ⓐ 주입 경로 — «옵션이 어떤 모양으로 넘어가나»만 잰다.
    //   ⛔⭐ 이 시험은 「RFC 가 실제로 쓰이나」를 «못 답한다» — 주입된 콜백이 스스로 파일을 만들기 때문이다
    //     (무인 리뷰가 이것을 GOODHART 로 잡았다). 그 질문은 아래 ⓑ 가 «주입 없이» 답한다.
    const planCalls: unknown[] = [];
    const { program: planProgram } = install(undefined, undefined, async (sentence, options) => {
      planCalls.push([sentence, options]);
    });
    await planProgram.parseAsync(['node', 'elanous', 'harness', 'plan', 'write', 'RFC', 'only']);
    // ⭐ 형제 문(ask·say)과 «같은» 정규화 모양이어야 한다(위 기대를 보라) ⊕ plan 만 dryRun 을 더 싣는다.
    expect(planCalls).toEqual([[['write', 'RFC', 'only'], {
      dryRun: false,
      supervise: true,
      supervisorSource: 'default',
    }]]);
  });

  test('CLI 기본 분기 — plan 주입이 «없으면» runHarnessPlanRfc 로 «간다» (배선)', async () => {
    // ⛔⭐ 이것이 GOODHART 를 막는 시험이다 — 주입된 `plan` 콜백이 스스로 파일을 만들면
    //   그 시험은 「배선」을 못 답한다(무인 리뷰 1차 지적). 여기서는 `plan` 을 «안 주고»
    //   기본 분기가 가는 자리(`planRfc`)를 잡아 «무엇이 어떤 인자로 불렸나»를 잰다.
    const rfcCalls: unknown[] = [];
    const program = new Command();
    installHarnessCliCommand(program, {
      registerSink: async () => {},
      resolveSurface: async () => 'harness',
      ask: async () => {},
      say: async () => {},
      // ⛔ plan 은 «주지 않는다» — 그것이 이 시험의 요지다
      planRfc: (async (goal: string, options?: { dryRun?: boolean }) => {
        rfcCalls.push([goal, options]);
        return { path: 'docs/RFC-x-2026-09-04.md', markdown: '', openQuestions: [], dryRun: options?.dryRun === true };
      }) as never,
    });
    await program.parseAsync(['node', 'elanous', 'harness', 'plan', 'write', 'RFC', 'only', '--dry-run']);
    expect(rfcCalls).toEqual([['write RFC only', { dryRun: true }]]);
  });

  test('주입이 «없으면» plan 문이 실제 RFC 저작 경로로 간다 (배선)', async () => {
    // ⛔⭐ 위 ⓐ 가 못 답하는 것을 여기서 답한다 — ***주입 없이*** 실제 배선을 탄다.
    //   저작기(LLM)는 심으로 갈아 끼우되, 「어느 함수가 불렸나 · 어디에 쓰이나」는 «진짜»를 잰다.
    const repo = mkdtempSync(join(tmpdir(), 'harness-plan-wiring-'));
    mkdirSync(join(repo, 'docs'));
    const previousCwd = process.cwd();
    process.chdir(repo);
    try {
      const authored = {
        markdown: '# Authored RFC\n',
        title: 'x',
        arcs: [] as never[],
        openQuestions: [] as string[],
      };
      // 쓰는 판 — 실제로 파일이 생겨야 한다
      const wrote = await runHarnessPlanRfc('write RFC only', {}, {
        author: async () => authored,
        resolve: async () => '',
        now: () => new Date('2026-09-04T00:00:00Z'),
        rootDir: repo,
        print: () => {},
        env: { ELANOUS_HARNESS_SPACE_ID: '' },
      });
      expect(wrote.dryRun).toBe(false);
      expect(wrote.path.startsWith('docs/RFC-')).toBe(true);
      expect(existsSync(join(repo, wrote.path))).toBe(true);
      expect(readFileSync(join(repo, wrote.path), 'utf8')).toBe('# Authored RFC\n');

      // ⭐ dry-run 판 — «이미 있는데도» 죽지 않고, 아무것도 «안 쓴다»
      const before = readFileSync(join(repo, wrote.path), 'utf8');
      const preview = await runHarnessPlanRfc('write RFC only', { dryRun: true }, {
        author: async () => ({ ...authored, markdown: '# CHANGED\n' }),
        resolve: async () => '',
        now: () => new Date('2026-09-04T00:00:00Z'),
        rootDir: repo,
        print: () => {},
        env: { ELANOUS_HARNESS_SPACE_ID: '' },
      });
      expect(preview.dryRun).toBe(true);
      expect(preview.path).toBe(wrote.path);
      expect(readFileSync(join(repo, wrote.path), 'utf8')).toBe(before);
    } finally {
      process.chdir(previousCwd);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('registers mission only when injected and forwards its id with an explicit executor', async () => {
    expect(install().harness.commands.map((command) => command.name())).not.toContain('mission');

    const received: unknown[] = [];
    const { program, harness } = install(undefined, undefined, undefined, undefined, async (missionId, opts) => {
      received.push([missionId, opts]);
    });

    expect(harness.commands.map((command) => command.name())).toContain('mission');
    await program.parseAsync(['node', 'elanous', 'harness', 'mission', 'apm-default']);
    await program.parseAsync(['node', 'elanous', 'harness', 'mission', 'apm-self', '--executor', 'self-implement']);

    expect(received).toEqual([
      ['apm-default', {}],
      ['apm-self', { executor: 'self-implement' }],
    ]);
  });

  test('rejects retired staged executor while retaining the self-implement choice', async () => {
    const { program, harness } = install(undefined, undefined, undefined, undefined, async () => {});
    const mission = harness.commands.find((command) => command.name() === 'mission')!;
    expect(mission.helpInformation()).toContain('self-implement');
    expect(mission.helpInformation()).not.toContain('staged');
    await expect(program.parseAsync(['node', 'elanous', 'harness', 'mission', 'apm-staged', '--executor', 'staged'])).rejects.toThrow(/staged/);
  });

  test('multiple mission IDs use the loop, render every outcome, and preserve the single-ID handler', async () => {
    const single: unknown[] = [];
    const loops: unknown[] = [];
    const { program } = install(
      undefined,
      undefined,
      undefined,
      undefined,
      async (...args) => { single.push(args); },
      async (missionIds, opts) => {
        loops.push([missionIds, opts]);
        return [
          { missionId: 'apm-solved', status: 'solved', terminal: 'deployed' },
          { missionId: 'apm-gone', status: 'not-found', detail: '미션 미존재' },
          { missionId: 'apm-refused', status: 'refused', detail: 'not coding' },
          { missionId: 'apm-error', status: 'error', detail: 'boom' },
        ];
      },
    );

    await program.parseAsync(['node', 'elanous', 'harness', 'mission', 'apm-single']);
    const lines = await captureLog(() => program.parseAsync([
      'node', 'elanous', 'harness', 'mission', 'apm-solved', 'apm-gone', 'apm-refused', 'apm-error', '--executor', 'self-implement',
    ]));

    expect(single).toEqual([['apm-single', {}]]);
    expect(loops).toEqual([[[
      'apm-solved', 'apm-gone', 'apm-refused', 'apm-error',
    ], { executor: 'self-implement' }]]);
    expect(lines).toEqual([
      "🧩 미션 'apm-solved' — solved: deployed",
      "🧩 미션 'apm-gone' — not-found: 미션 미존재",
      "🧩 미션 'apm-refused' — refused: not coding",
      "🧩 미션 'apm-error' — error: boom",
    ]);
  });

  test('multi-mission dry-run lists every planned launch without calling the loop', async () => {
    const loops: unknown[] = [];
    const { program } = install(
      undefined,
      undefined,
      undefined,
      undefined,
      async () => {},
      async (...args) => { loops.push(args); return []; },
    );

    const lines = await captureLog(() => program.parseAsync([
      'node', 'elanous', 'harness', 'mission', 'apm-one', 'apm-two', '--dry-run',
    ]));

    expect(loops).toEqual([]);
    expect(lines).toEqual([
      '[dry-run] 입력: apm-one apm-two',
      '[dry-run] 입구: cli-harness-mission',
      '[dry-run] 시작 예정: 기존 미션 apm-one, apm-two read · 순차 하니스 실행기',
      '[dry-run] 전제 검사: ask 마커만 돌렸다 · 원격 조회(열린 PR·런 원장)는 돌리지 않음',
      '[dry-run] ask 마커 — 골 문서가 아직 없다 (⛔ 「경고 없음」이 아니다)',
    ]);
  });

  test('ask dry-run renders marker warnings without dispatching', async () => {
    const goalPath = join(tmpdir(), `harness-dry-run-warning-${crypto.randomUUID()}.md`);
    writeFileSync(goalPath, '# Goal\n');
    try {
      const calls: unknown[] = [];
      const { program } = install(async (...args) => { calls.push(args); });
      const lines = await captureLog(() => program.parseAsync(['node', 'elanous', 'harness', 'ask', goalPath, '--dry-run']));
      expect(calls).toEqual([]);
      expect(lines).toContain('[dry-run] 전제 검사: ask 마커·릴리스 노트 린트만 돌렸다 · 원격 조회(열린 PR·런 원장)는 돌리지 않음');
      expect(lines).toContain('[dry-run] ⚠️ ask 마커 — ❌ 불변식 — 마커가 «없다» (제목형 "## 불변식" 은 마커가 아니다 ⇒ "불변식: <문장>" 줄로 쓴다)');
    } finally {
      rmSync(goalPath, { force: true });
    }
  });

  test('ask dry-run prints missing release-note fields as warnings without dispatching', async () => {
    const goalPath = join(tmpdir(), `harness-release-note-${crypto.randomUUID()}.md`);
    writeFileSync(goalPath, '## 릴리스 노트\n- 한 줄: Fix startup\n- 종류: fix\n');
    try {
      const calls: unknown[] = [];
      const { program } = install(async (...args) => { calls.push(args); });
      const lines = await captureLog(() => program.parseAsync(['node', 'elanous', 'harness', 'ask', goalPath, '--dry-run']));
      expect(calls).toEqual([]);
      expect(lines.filter((line) => line.startsWith('[dry-run] ⚠️ 릴리스 노트 —'))).toEqual([
        expect.stringContaining('문서 invalid or missing'),
        expect.stringContaining('대상 invalid or missing'),
      ]);
    } finally {
      rmSync(goalPath, { force: true });
    }
  });

  test('ask dry-run reports an unreadable goal document distinctly without dispatching', async () => {
    const goalPath = join(tmpdir(), `harness-dry-run-missing-${crypto.randomUUID()}.md`);
    const calls: unknown[] = [];
    const { program } = install(async (...args) => { calls.push(args); });

    const lines = await captureLog(() => program.parseAsync(['node', 'elanous', 'harness', 'ask', goalPath, '--dry-run']));

    expect(calls).toEqual([]);
    expect(lines.some((line) => line.startsWith('[dry-run] ⚠️ ask 마커 — 골 문서 판독 실패: ENOENT: no such file or directory, open '))).toBe(true);
      expect(lines).toContain('[dry-run] 골 종류·템플릿: 읽지 못함 · 미상');
      expect(lines.some((line) => line.startsWith('[dry-run] ⚠️ 릴리스 노트 —'))).toBe(false);

  });

  test('ask dry-run reports clean markers from a real inspectable goal and inspection failures distinctly', async () => {
    const goalPath = join(tmpdir(), `harness-dry-run-inspection-${crypto.randomUUID()}.md`);
    writeFileSync(goalPath, `대상 경로: scripts/ask-marker-check.ts

불변식: scripts/ask-marker-check.ts 를 계속 쓴다.
경계: 다른 스크립트는 대상이 아니다.
판정 신호: 조건 = 검사기가 export를 센다; 관측 = rg -c 'export function inspectAskMarkers' scripts/ask-marker-check.ts; 기대 = 1 이상.
`);
    try {
      const clean = await captureLog(() => install(async () => {}).program.parseAsync(['node', 'elanous', 'harness', 'ask', goalPath, '--dry-run']));
      expect(clean).toContain('[dry-run] ✅ ask 마커 — 경고 없음');
      expect(clean.filter((line) => line.includes('⚠️ ask 마커') || line.includes('❌ ask 마커'))).toEqual([]);

      setHarnessAskMarkerInspectorForTesting(() => { throw new Error('inspection broke'); });
      const failed = await captureLog(() => install(async () => {}).program.parseAsync(['node', 'elanous', 'harness', 'ask', goalPath, '--dry-run']));
      expect(failed).toContain('[dry-run] ⚠️ ask 마커 — 검사 실패: inspection broke');
    } finally {
      setHarnessAskMarkerInspectorForTesting(undefined);
      rmSync(goalPath, { force: true });
    }
  });

  test('ask dry-run renders real unpressed-decision-signal warnings without dispatching', async () => {
    const goalPath = join(tmpdir(), `harness-dry-run-unpressed-${crypto.randomUUID()}.md`);
    writeFileSync(goalPath, `대상 경로: src/harness/harness-cli-command.ts

불변식: src/harness/harness-cli-command.ts 를 계속 쓴다.
경계: src/self-dev/launch-preflight.ts 는 이 골에서 바꾸지 않는다.
판정 신호: 조건 = 경로; 관측 = bun test src/harness/harness-cli-command.test.ts; 기대 = 경고
판정 신호: 조건 = 기판; 관측 = 그 기판으로 자식을 하나 돌려 main-tree-reject 0 을 보여라; 기대 = 0
`);
    try {
      const calls: unknown[] = [];
      const { program } = install(async (...args) => { calls.push(args); });
      const lines = await captureLog(() => program.parseAsync(['node', 'elanous', 'harness', 'ask', goalPath, '--dry-run']));
      expect(calls).toEqual([]);
      expect(lines).toContain('[dry-run] 전제 검사: ask 마커·릴리스 노트 린트만 돌렸다 · 원격 조회(열린 PR·런 원장)는 돌리지 않음');
      expect(lines.some((line) => line.includes('안 눌릴 신호'))).toBe(true);
      expect(lines.some((line) => line.startsWith('[dry-run] ⚠️ ask 마커 — ') && line.includes('안 눌릴 신호'))).toBe(true);
    } finally {
      rmSync(goalPath, { force: true });
    }
  });

  test('ask dry-run reports unpressed-signal inspection failure without swallowing remaining dry-run output', async () => {
    const goalPath = join(tmpdir(), `harness-dry-run-unpressed-fail-${crypto.randomUUID()}.md`);
    writeFileSync(goalPath, `대상 경로: src/harness/harness-cli-command.ts

불변식: src/harness/harness-cli-command.ts 를 계속 쓴다.
경계: src/self-dev/launch-preflight.ts 는 이 골에서 바꾸지 않는다.
판정 신호: 조건 = 산문; 관측 = 산문으로만 적었다; 기대 = 문면을 유지한다
`);
    try {
      setHarnessUnpressedDecisionSignalInspectorForTesting(() => {
        throw new Error('first line\nsecond line');
      });
      const calls: unknown[] = [];
      const { program } = install(async (...args) => { calls.push(args); });
      const lines = await captureLog(() => program.parseAsync(['node', 'elanous', 'harness', 'ask', goalPath, '--dry-run']));
      expect(calls).toEqual([]);
      expect(lines).toContain('[dry-run] 입력: ' + goalPath);
      expect(lines).toContain('[dry-run] 입구: cli-harness-ask');
      expect(lines).toContain('[dry-run] 시작 예정: 워크트리 · 브랜치 · 자식 · 파이프라인');
      expect(lines).toContain('[dry-run] 전제 검사: ask 마커·릴리스 노트 린트만 돌렸다 · 원격 조회(열린 PR·런 원장)는 돌리지 않음');
      expect(lines).toContain('[dry-run] ⚠️ ask 마커 — ⚠️ ask 마커 — 안 눌릴 신호 검사 실패: first line');
      expect(lines.some((line) => line.includes('second line'))).toBe(false);
      expect(lines.some((line) => line.includes('✅ ask 마커 — 경고 없음'))).toBe(false);
      expect(lines.some((line) => line.startsWith('[dry-run] 골 종류·템플릿:'))).toBe(true);
    } finally {
      setHarnessUnpressedDecisionSignalInspectorForTesting(undefined);
      rmSync(goalPath, { force: true });
    }
  });

  test('ask dry-run injected inspector remains exclusive of unpressed-signal inspection', async () => {
    const goalPath = join(tmpdir(), `harness-dry-run-injected-exclusive-${crypto.randomUUID()}.md`);
    writeFileSync(goalPath, `대상 경로: src/harness/harness-cli-command.ts

불변식: src/harness/harness-cli-command.ts 를 계속 쓴다.
경계: src/self-dev/launch-preflight.ts 는 이 골에서 바꾸지 않는다.
판정 신호: 조건 = 기판; 관측 = 그 기판으로 자식을 하나 돌려 main-tree-reject 0 을 보여라; 기대 = 0
`);
    try {
      setHarnessAskMarkerInspectorForTesting(() => ['⚠️ injected-only']);
      setHarnessUnpressedDecisionSignalInspectorForTesting(() => {
        throw new Error('must not run');
      });
      const calls: unknown[] = [];
      const { program } = install(async (...args) => { calls.push(args); });
      const lines = await captureLog(() => program.parseAsync(['node', 'elanous', 'harness', 'ask', goalPath, '--dry-run']));
      expect(calls).toEqual([]);
      expect(lines).toContain('[dry-run] ⚠️ ask 마커 — ⚠️ injected-only');
      expect(lines.filter((line) => line.includes('⚠️ ask 마커'))).toEqual([
        '[dry-run] ⚠️ ask 마커 — ⚠️ injected-only',
      ]);
      expect(lines.some((line) => line.includes('안 눌릴 신호'))).toBe(false);
      expect(lines.some((line) => line.includes('검사 실패'))).toBe(false);
      expect(lines.some((line) => line.includes('must not run'))).toBe(false);
    } finally {
      setHarnessAskMarkerInspectorForTesting(undefined);
      setHarnessUnpressedDecisionSignalInspectorForTesting(undefined);
      rmSync(goalPath, { force: true });
    }
  });

  test('mission dry-run prints the launch plan and does not call its injected handler', async () => {
    const calls: unknown[] = [];
    const { program } = install(undefined, undefined, undefined, undefined, async (...args) => { calls.push(args); });

    const lines = await captureLog(() => program.parseAsync([
      'node', 'elanous', 'harness', 'mission', 'apm-dry-run', '--dry-run',
    ]));

    expect(calls).toEqual([]);
    expect(lines).toEqual([
      '[dry-run] 입력: apm-dry-run',
      '[dry-run] 입구: cli-harness-mission',
      '[dry-run] 시작 예정: 기존 미션 read · 워크트리 · 하니스 실행기',
      '[dry-run] 전제 검사: ask 마커만 돌렸다 · 원격 조회(열린 PR·런 원장)는 돌리지 않음',
      '[dry-run] ask 마커 — 골 문서가 아직 없다 (⛔ 「경고 없음」이 아니다)',
    ]);
  });


  // ⛔⭐⭐ 🩸 2026-09-12 — ***등록은 됐는데 «전달»이 «안» 됐다.***
  //    `--child-llm-effort` 를 옵션으로 «달았고» 판정 함수도 맞았는데,
  //    `normalizeHarnessAskSayOptions` 가 그 칸을 «안 실어서» 조용히 사라졌다.
  //    🔑 실물에서 잡은 방법 = ***해석 줄에 `effort=` 가 «안 찍혔다»***.
  //    ⛔ 그래서 이 시험은 「옵션이 있나」가 «아니라» ***「그 값이 «건너편»에 닿나」***를 문다.
  test('🩸 say 가 --child-llm-effort 를 «실어 보낸다» (등록 ≠ 전달)', async () => {
    // ⛔ `let … | null` 로 두면 TS 가 «null 로 좁혀» 캐스트를 막는다 — 배열로 담는다(기존 시험 방식).
    const seen: Record<string, unknown>[] = [];
    const { program } = install(undefined, async (_text: unknown, opts: unknown) => {
      seen.push(opts as Record<string, unknown>);
    });
    await program.parseAsync([
      'node', 'x', 'harness', 'say', '문장',
      '--child-llm-provider', 'openai-codex',
      '--child-llm-model', 'gpt-6-astra',
      '--child-llm-effort', 'xhigh',
      // ⛔ `--dry-run` 을 «주지 않는다» — 그 플래그는 콜백 «전»에 조기 반환한다(그래서 못 잡는다).
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.childLlmEffort).toBe('xhigh');   // ⛔ 이 단언이 그 결함의 «전부»다
    expect(seen[0]!.childLlmModel).toBe('gpt-6-astra');
  });

  // ⛔ 이 자는 던지지 «않는다» — `runInjectedHarnessHandler` 가 잡아 stderr ⊕ exitCode=1 로 낸다.
  //    그래서 기존 `--child-llm-model` 시험과 «같은 방식»으로 단언한다.
  test('⛔ 상한을 넘는 effort 는 «발사 전에» 거부되고 «두 값을 다» 말한다', async () => {
    const called: unknown[] = [];
    const { program } = install(undefined, async (...a: unknown[]) => { called.push(a); });
    const previousExit = process.exitCode;
    try {
      const err = await captureError(() => program.parseAsync([
        'node', 'elanous', 'harness', 'say', '문장',
        // 🩸 2026-09-23 실측으로 codex 모델 상한이 전부 `max` 가 됐다(`model-catalog.ts`) — 초과 예는 상한이 낮은 모델로 잰다.
        '--child-llm-provider', 'anthropic',
        '--child-llm-model', 'claude-haiku-4-5',
        '--child-llm-effort', 'high',
      ]));
      expect(called).toEqual([]);                       // ⛔ 자식이 «안» 떴다
      expect(err.join('\n')).toContain('high');
      expect(err.join('\n')).toContain('claude-haiku-4-5');
      expect(err.join('\n')).toContain('low');          // 상한
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExit ?? 0;
    }
  });

  test('⛔ provider 없이 effort 만 오면 «조용히 무시하지 않는다»', async () => {
    const called: unknown[] = [];
    const { program } = install(undefined, async (...a: unknown[]) => { called.push(a); });
    const previousExit = process.exitCode;
    try {
      const err = await captureError(() => program.parseAsync([
        'node', 'elanous', 'harness', 'say', '문장', '--child-llm-effort', 'high',
      ]));
      expect(called).toEqual([]);
      expect(err.join('\n')).toContain('--child-llm-provider 필요');
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExit ?? 0;
    }
  });

  test('ask and say expose child LLM flags while plan exposes repeatable role LLM flags', async () => {
    const { harness, program } = install(async () => {}, async () => {}, async () => {});
    for (const name of ['ask', 'say'] as const) {
      const longs = harness.commands.find((command) => command.name() === name)!.options.map((option) => option.long);
      expect(longs).toEqual(expect.arrayContaining([
        '--json',
        '--base',
        '--no-auto-merge',
        '--observe-only',
        '--no-supervise',
        '--dry-run',
        '--child-llm-provider',
        '--child-llm-model',
      ]));
      expect(longs).not.toContain('--role-llm');
    }

    const planLongs = harness.commands.find((command) => command.name() === 'plan')!.options.map((option) => option.long);
    expect(planLongs).toEqual(expect.arrayContaining([
      '--json',
      '--base',
      '--no-auto-merge',
      '--observe-only',
      '--no-supervise',
      '--dry-run',
      '--role-llm',
    ]));
    expect(planLongs).not.toContain('--child-llm-provider');
    expect(planLongs).not.toContain('--child-llm-model');

    try {
      await expect(program.parseAsync([
        'node', 'elanous', 'harness', 'ask', '--role-llm', 'implement=grok', '/tmp/goal.md',
      ])).rejects.toThrow(/unknown option '--role-llm'/);
      await expect(program.parseAsync([
        'node', 'elanous', 'harness', 'plan', '--child-llm-provider', 'grok', 'write', 'plan',
      ])).rejects.toThrow(/unknown option '--child-llm-provider'/);
    } finally {
      process.exitCode = 0;
    }
  });

  test('unknown --child-llm-model dies before ask/say handlers and names the value plus candidates', async () => {
    const received: unknown[] = [];
    const { program } = install(
      async (...args) => { received.push(['ask', ...args]); },
      async (...args) => { received.push(['say', ...args]); },
    );
    const previousExit = process.exitCode;
    try {
      const askErr = await captureError(() => program.parseAsync([
        'node', 'elanous', 'harness', 'ask',
        '--child-llm-provider', 'grok', '--child-llm-model', 'not-a-real-model',
        '/tmp/goal.md',
      ]));
      expect(received).toEqual([]);
      expect(askErr.join('\n')).toMatch(/--child-llm-model 알 수 없음: not-a-real-model/);
      expect(askErr.join('\n')).toContain('grok-4.6');
      expect(process.exitCode).toBe(1);

      process.exitCode = 0;
      const sayErr = await captureError(() => program.parseAsync([
        'node', 'elanous', 'harness', 'say',
        '--child-llm-provider', 'grok', '--child-llm-model', 'not-a-real-model',
        'write', 'goal',
      ]));
      expect(received).toEqual([]);
      expect(sayErr.join('\n')).toMatch(/--child-llm-model 알 수 없음: not-a-real-model/);
      expect(sayErr.join('\n')).toContain('grok-4.6');
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExit ?? 0;
    }
  });

  test('unknown --child-llm-model dies before ask/say --dry-run and names the value plus candidates', async () => {
    const received: unknown[] = [];
    const { program } = install(
      async (...args) => { received.push(['ask', ...args]); },
      async (...args) => { received.push(['say', ...args]); },
    );
    const previousExit = process.exitCode;
    try {
      let askLog: string[] = [];
      const askErr = await captureError(async () => {
        askLog = await captureLog(() => program.parseAsync([
          'node', 'elanous', 'harness', 'ask', '--dry-run',
          '--child-llm-provider', 'grok', '--child-llm-model', 'not-a-real-model',
          '/tmp/goal.md',
        ]));
      });
      expect(received).toEqual([]);
      expect(askLog.join('\n')).not.toMatch(/\[dry-run\]/);
      expect(askErr.join('\n')).toMatch(/--child-llm-model 알 수 없음: not-a-real-model/);
      expect(askErr.join('\n')).toContain('grok-4.6');
      expect(process.exitCode).toBe(1);

      process.exitCode = 0;
      let sayLog: string[] = [];
      const sayErr = await captureError(async () => {
        sayLog = await captureLog(() => program.parseAsync([
          'node', 'elanous', 'harness', 'say', '--dry-run',
          '--child-llm-provider', 'grok', '--child-llm-model', 'not-a-real-model',
          'write', 'goal',
        ]));
      });
      expect(received).toEqual([]);
      expect(sayLog.join('\n')).not.toMatch(/\[dry-run\]/);
      expect(sayErr.join('\n')).toMatch(/--child-llm-model 알 수 없음: not-a-real-model/);
      expect(sayErr.join('\n')).toContain('grok-4.6');
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExit ?? 0;
    }
  });

  test('supplied --child-llm-model with omitted/blank provider or blank model dies before ask/say handlers', async () => {
    const received: unknown[] = [];
    const { program } = install(
      async (...args) => { received.push(['ask', ...args]); },
      async (...args) => { received.push(['say', ...args]); },
    );
    const previousExit = process.exitCode;
    const cases: Array<{ argv: string[]; error: RegExp; candidate?: string }> = [
      {
        argv: ['ask', '--child-llm-model', 'not-a-real-model', '/tmp/goal.md'],
        error: /--child-llm-provider 필요\(--child-llm-model과 함께\)/,
      },
      {
        argv: ['ask', '--child-llm-provider', '  ', '--child-llm-model', 'not-a-real-model', '/tmp/goal.md'],
        error: /--child-llm-provider 필요\(--child-llm-model과 함께\)/,
      },
      {
        argv: ['ask', '--child-llm-provider', 'grok', '--child-llm-model', '  ', '/tmp/goal.md'],
        error: /--child-llm-model 알 수 없음:/,
        candidate: 'grok-4.6',
      },
      {
        argv: ['say', '--child-llm-model', 'not-a-real-model', 'write', 'goal'],
        error: /--child-llm-provider 필요\(--child-llm-model과 함께\)/,
      },
      {
        argv: ['say', '--child-llm-provider', '  ', '--child-llm-model', 'not-a-real-model', 'write', 'goal'],
        error: /--child-llm-provider 필요\(--child-llm-model과 함께\)/,
      },
      {
        argv: ['say', '--child-llm-provider', 'grok', '--child-llm-model', '  ', 'write', 'goal'],
        error: /--child-llm-model 알 수 없음:/,
        candidate: 'grok-4.6',
      },
    ];
    try {
      for (const testCase of cases) {
        process.exitCode = 0;
        const err = await captureError(() => program.parseAsync(['node', 'elanous', 'harness', ...testCase.argv]));
        expect(received).toEqual([]);
        expect(err.join('\n')).toMatch(testCase.error);
        if (testCase.candidate) expect(err.join('\n')).toContain(testCase.candidate);
        expect(process.exitCode).toBe(1);
      }
    } finally {
      process.exitCode = previousExit ?? 0;
    }
  });

  test('valid or omitted --child-llm-model still dispatches ask/say handlers unchanged', async () => {
    const received: unknown[] = [];
    const { program } = install(
      async (goalPath, options) => { received.push(['ask', goalPath, options]); },
      async (words, options) => { received.push(['say', words, options]); },
    );
    await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/tmp/goal.md']);
    await program.parseAsync([
      'node', 'elanous', 'harness', 'ask',
      '--child-llm-provider', 'grok', '--child-llm-model', 'grok-4.6',
      '/tmp/goal.md',
    ]);
    await program.parseAsync(['node', 'elanous', 'harness', 'say', 'write', 'goal']);
    expect(received).toEqual([
      ['ask', '/tmp/goal.md', { supervise: true, supervisorSource: 'default' }],
      ['ask', '/tmp/goal.md', {
        supervise: true,
        supervisorSource: 'default',
        childLlmProvider: 'grok',
        childLlmModel: 'grok-4.6',
      }],
      ['say', ['write', 'goal'], { supervise: true, supervisorSource: 'default' }],
    ]);
  });

  test('ask dry-run reports a present template and clean marker inspection without dispatching', async () => {
    const goalPath = join(mkdtempSync(join(tmpdir(), 'harness-dry-run-')), 'implement.md');
    writeFileSync(goalPath, 'Implement goal\n- GoalType: implement\n');
    const calls: unknown[] = [];
    const { program } = install(async (...args) => { calls.push(args); });

    try {
      setHarnessAskMarkerInspectorForTesting(() => []);
      const lines = await captureLog(() => program.parseAsync([
        'node', 'elanous', 'harness', 'ask', '--dry-run', goalPath,
      ]));

      expect(calls).toEqual([]);
      expect(lines).toEqual([
        '[harness] substrate=local (default)',
        `[dry-run] 입력: ${goalPath}`,
        '[dry-run] 입구: cli-harness-ask',
        '[dry-run] 시작 예정: 워크트리 · 브랜치 · 자식 · 파이프라인',
        '[dry-run] 전제 검사: ask 마커·릴리스 노트 린트만 돌렸다 · 원격 조회(열린 PR·런 원장)는 돌리지 않음',
        '[dry-run] ✅ ask 마커 — 경고 없음',
        '[dry-run] 골 종류·템플릿: implement · self-implement',
      ]);
    } finally {
      setHarnessAskMarkerInspectorForTesting(undefined);
      rmSync(goalPath, { force: true });
    }
  });

  test('ask and say dry-run preview distinct resolved target statuses without dispatching', async () => {
    const home = resolveHarnessTarget(tmpdir()).canonicalHome;
    if (!home) throw new Error('expected resolved target home');
    const inHome = mkdtempSync(join(home, 'harness-target-dry-run-'));
    const received: unknown[] = [];
    const { program } = install(
      async (...args) => { received.push(['ask', args]); },
      async (...args) => { received.push(['say', args]); },
    );

    try {
      const askLines = await captureLog(() => program.parseAsync([
        'node', 'elanous', 'harness', 'ask', '--dry-run', '--target', inHome, '/tmp/goal.md',
      ]));
      const previousExit = process.exitCode;
      process.exitCode = 0;
      try {
        const sayLines = await captureLog(() => program.parseAsync([
          'node', 'elanous', 'harness', 'say', '--dry-run', '--target', '/tmp', 'write', 'goal',
        ]));
        expect(sayLines).toContain(`[dry-run] target: ${realpathSync('/tmp')} · outside-home`);
        expect(process.exitCode).toBe(0);
      } finally {
        process.exitCode = previousExit ?? 0;
      }

      expect(received).toEqual([]);
      expect(askLines).toContain(`[dry-run] target: ${inHome} · non-git-dir`);
    } finally {
      rmSync(inHome, { force: true, recursive: true });
    }
  }, 60_000); // spawns the CLI four times — 17s alone on mbp (bun 1.4.2); the 5s default measured the machine, not the code

  test('ask dry-run gives --goal-type precedence over declared and default goal types', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-dry-run-'));
    const declaredGoalPath = join(root, 'declared-research.md');
    const undeclaredGoalPath = join(root, 'undeclared.md');
    writeFileSync(declaredGoalPath, 'Research goal\n- GoalType: research\n');
    writeFileSync(undeclaredGoalPath, 'Undeclared goal\n');
    const { program } = install(async () => {});

    try {
      const declaredLines = await captureLog(() => program.parseAsync([
        'node', 'elanous', 'harness', 'ask', '--dry-run', '--goal-type', 'document', declaredGoalPath,
      ]));
      const undeclaredLines = await captureLog(() => program.parseAsync([
        'node', 'elanous', 'harness', 'ask', '--dry-run', '--goal-type', 'research', undeclaredGoalPath,
      ]));

      expect(declaredLines.at(-1)).toBe('[dry-run] 골 종류·템플릿: document · document-loop');
      expect(undeclaredLines.at(-1)).toBe('[dry-run] 골 종류·템플릿: research · research-loop');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('ask dry-run reports template absence for a readable goal type', async () => {
    const goalPath = join(mkdtempSync(join(tmpdir(), 'harness-dry-run-')), 'document.md');
    writeFileSync(goalPath, 'Document goal\n- GoalType: document\n');
    const { program } = install(async () => {});

    try {
      const lines = await captureLog(() => program.parseAsync([
        'node', 'elanous', 'harness', 'ask', '--dry-run', goalPath,
      ]));

      expect(lines.at(-1)).toBe('[dry-run] 골 종류·템플릿: document · document-loop');
    } finally {
      rmSync(goalPath, { force: true });
    }
  });

  test('ask dry-run distinguishes an unreadable goal type from template absence', async () => {
    const goalPath = join(mkdtempSync(join(tmpdir(), 'harness-dry-run-')), 'unknown.md');
    writeFileSync(goalPath, 'Unknown goal\n- GoalType: unsupported\n');
    const { program } = install(async () => {});

    try {
      const lines = await captureLog(() => program.parseAsync([
        'node', 'elanous', 'harness', 'ask', '--dry-run', goalPath,
      ]));

      expect(lines.at(-1)).toBe('[dry-run] 골 종류·템플릿: 미상 · 미상');
      expect(lines.at(-1)).not.toContain('템플릿 없음');
    } finally {
      rmSync(goalPath, { force: true });
    }
  });

  test('ask dry-run separates «could not read the file» from «type is malformed»', async () => {
    // ⛔ 둘이 같은 문면이면 사람이 오타를 찾는 대신 경로를 의심한다(그 반대도 같다).
    const missing = join(mkdtempSync(join(tmpdir(), 'harness-dry-run-')), 'absent.md');
    const { program } = install(async () => {});

    const lines = await captureLog(() => program.parseAsync([
      'node', 'elanous', 'harness', 'ask', '--dry-run', missing,
    ]));

    expect(lines.at(-1)).toBe('[dry-run] 골 종류·템플릿: 읽지 못함 · 미상');
    expect(lines.at(-1)).not.toBe('[dry-run] 골 종류·템플릿: 미상 · 미상');
  });

  test('processes is read-only and distinguishes empty, failed, and incomplete observations', async () => {
    const { harness } = install();
    const processes = harness.commands.find((command) => command.name() === 'processes');
    expect(processes?.description()).toMatch(/읽기 전용/);
    expect(processes?.options.map((option) => option.long)).not.toEqual(
      expect.arrayContaining(['--kill', '--signal', '--reap']),
    );

    const empty = await runProcesses([]);
    expect(empty.join('\n')).toContain('관찰 대상 없음');
    expect(empty.join('\n')).toContain('프로세스를 죽이지 않는다');

    const failed = await runProcesses({
      status: 'failed',
      stage: 'ps-exec',
      reason: 'ps: command not found',
    });
    expect(failed.join('\n')).toContain('관찰 실패/확인 불가 (ps-exec: ps: command not found)');
    expect(failed.join('\n')).not.toContain('관찰 대상 없음');

    const incomplete = parseHarnessProcessPsOutput([
      '    12861     1  98.9 12-08:00:00 bun bin/elanous.mjs --test pr land --dry-run',
      'not-a-process-table',
    ].join('\n'));
    expect(incomplete.status).toBe('incomplete');
    const incompleteLines = await runProcesses(incomplete);
    expect(incompleteLines.join('\n')).toContain('불완전 관측');
    expect(incompleteLines.join('\n')).not.toContain('관찰 대상 없음');
  });

  test('process reports separately disclose excluded ps rows without classifying them', async () => {
    const excludedOnly = parseHarnessProcessPsOutput([
      '12862 1 99.0 12-08:00:00 codex app-server',
      '12863 1 0.1 02:00:00 node worker.js',
    ].join('\n'));
    expect(excludedOnly).toMatchObject({ status: 'ok', excludedCount: 2, records: [] });
    const excludedLines = await runProcesses(excludedOnly);
    const excludedText = excludedLines.join('\n');
    expect(excludedText).toContain('모집단 제외 2행');
    expect(excludedText).toContain('제외 기준: command에 elanous.mjs가 없고 시험 데몬·러너 대상도 아닌 행');
    expect(excludedText).toContain('분류 제외 0행');
    expect(excludedText).toContain('부모 생존 제외 0행');
    expect(excludedText).toContain('자원소비 0 · 장기실행만 0');
    expect(excludedText).not.toContain('pid=12862');
    expect(excludedText).not.toContain('pid=12863');

    const includedOnly = parseHarnessProcessPsOutput(
      '12861 1 98.9 12-08:00:00 bun bin/elanous.mjs --test harness processes',
    );
    expect(includedOnly).toMatchObject({ status: 'ok', excludedCount: 0 });
    const includedText = (await runProcesses(includedOnly)).join('\n');
    expect(includedText).not.toContain('모집단 제외');
    expect(includedText).not.toContain('제외 기준:');

    const mixed = parseHarnessProcessPsOutput([
      '12861 1 98.9 12-08:00:00 bun bin/elanous.mjs --test harness processes',
      '12862 1 99.0 12-08:00:00 codex app-server',
      'not-a-process-table',
    ].join('\n'));
    expect(mixed).toMatchObject({ status: 'incomplete', malformedCount: 1, excludedCount: 1 });
    const mixedText = (await runProcesses(mixed)).join('\n');
    expect(mixedText).toContain('해석 실패 1행');
    expect(mixedText).toContain('모집단 제외 1행');
    expect(mixedText).toContain('자원소비 1 · 장기실행만 0');
    expect(mixedText).not.toContain('pid=12862');
  });

  test('fake ps keeps legacy groups unchanged while reporting orphan test daemons and gate runners as read-only garbage', async () => {
    const daemonCommand = 'bun /tmp/elanous-nexus-cli-X/daemon.ts /private/tmp/elanous-nexus-cli-X/.elanous-test';
    const longCommand = 'bun bin/elanous.mjs --test harness processes';
    const ps = [
      `101 1 80.0 03:00:00 ${daemonCommand}`,
      '102 1 70.0 04:00:00 bun test /tmp/elanous/repo.worktrees/self-impl/gate.test.ts',
      `103 1 60.0 04:00:00 ${longCommand}`,
      '104 1 0.1 04:00:00 bun /opt/current/node_modules/elanous/bin/elanous.mjs nexus run',
      `105 1 0.1 00:30:00 ${daemonCommand}`,
      `106 1 0.1 04:00:00 ${daemonCommand} extra`,
    ].join('\n');
    const listed = parseHarnessProcessPsOutput(ps);
    expect(listed.status).toBe('ok');
    if (listed.status !== 'ok') throw new Error('expected ps observation');
    expect(listed.records.map(({ pid }) => pid)).toEqual([101, 102, 103, 104, 105, 106]);
    const report = buildHarnessProcessReport(listed, [], DEFAULT_HARNESS_PROCESS_THRESHOLDS, 'subset',
      { status: 'ok', pids: [106] }, () => null);
    expect(report.resourceConsuming.map(({ pid }) => pid)).toEqual([103]);
    expect(report.longRunningOnly.map(({ pid }) => pid)).toEqual([104]);
    expect(report.garbage.map(({ pid, reason }) => ({ pid, reason }))).toEqual([
      { pid: 101, reason: 'orphan-test-daemon' },
      { pid: 102, reason: 'orphan-test-runner' },
      { pid: 103, reason: 'orphan-elanous' },
    ]);
    const lines = await runProcesses(listed, [], { status: 'ok', pids: [106] });
    expect(lines).toContain('자원소비 1 · 장기실행만 1');
    expect(lines).toContain('가비지 3:');
    expect(lines).not.toContain('관찰 대상 없음');
    expect(lines.at(-3)).toContain(`pid=101 ppid=1 elapsed=3h 00m reason=orphan-test-daemon command=${daemonCommand}`);
    expect(lines.at(-2)).toContain('pid=102 ppid=1 elapsed=4h 00m reason=orphan-test-runner command=bun test');
    expect(lines.at(-1)).toContain(`pid=103 ppid=1 elapsed=4h 00m reason=orphan-elanous command=${longCommand}`);
    const listedBaseline = parseHarnessProcessPsOutput([ps.split('\n')[2], ps.split('\n')[3]].join('\n'));
    const baseline = buildHarnessProcessReport(listedBaseline, [], DEFAULT_HARNESS_PROCESS_THRESHOLDS,
      'subset', { status: 'ok', pids: [106] }, () => null);
    expect(report.resourceConsuming.map(({ pid }) => pid)).toEqual(baseline.resourceConsuming.map(({ pid }) => pid));
    expect(report.longRunningOnly.map(({ pid }) => pid)).toEqual(baseline.longRunningOnly.map(({ pid }) => pid));
  });

  test('garbage command display stops at 120 characters', () => {
    const command = `bun /tmp/elanous-nexus-X/daemon.ts /tmp/.elanous-test ${'x'.repeat(150)}`;
    const report = buildHarnessProcessReport([processFixture({ pid: 89, elapsedSeconds: 11_000, command })]);
    const rendered = renderHarnessProcessReport(report);
    expect(rendered.at(-1)).toEndWith(`command=${command.slice(0, 120)}`);
    expect(rendered.at(-1)).not.toContain(command);
    expect(rendered).toContain('가비지 1:');
  });

  test('process reports classify only parent-absent processes and retain worktree, launchd, and ownership distinctions', async () => {
    const managed = processFixture({
      pid: 46480,
      ppid: 1,
      cpuPercent: 0.4,
      elapsedSeconds: 8 * 3600,
      cwd: '/tmp/self-impl-nexus',
      cwdStatus: 'observed',
    });
    const burning = processFixture({
      pid: 12861,
      ppid: 1,
      cpuPercent: 98.9,
      elapsedSeconds: 90,
      cwd: '/tmp/self-impl-orphan',
      cwdStatus: 'observed',
      ownership: MEASURED_PS_EWW_OWNERSHIP,
    });
    const livingParent = processFixture({ pid: 76, ppid: 1, cwdStatus: 'observed' });
    const child = processFixture({
      pid: 77,
      ppid: 76,
      cpuPercent: 98.9,
      elapsedSeconds: 8 * 3600,
      cwdStatus: 'observed',
    });

    const lines = await runProcesses(
      [managed, burning, livingParent, child],
      ['/tmp/self-impl-nexus', '/tmp/self-impl-orphan'],
      { status: 'ok', pids: [46480] },
    );
    const text = lines.join('\n');

    expect(text).toContain('분류 제외 1행');
    expect(text).toContain('부모 생존 제외 1행');
    expect(text).toContain('자원소비 1 · 장기실행만 1');
    expect(text).toContain('lastActivity 자: 런 원장 전이만 (로그 스토어는 안 본다)');
    expect(text).toContain('pid=12861 ppid=1 elapsed=1m 30s cpu=98.9% worktree=/tmp/self-impl-orphan lastActivity=없음 · 원장만');
    expect(text).toContain('pid=46480 ppid=1 elapsed=8h 00m cpu=0.4% worktree=/tmp/self-impl-nexus lastActivity=미상');
    expect(text).toContain('  launchd=launchd 가 관리한다');
    expect(text).toContain('  launchd=근거 없음');
    expect(text).toContain('ownership=run=run-6ecb1a67-f650-48d9-86f5-88715e91746c');
    expect(text).not.toContain('pid=77');
    expect(text).not.toContain('pid=76');
  });

  test('process rows attach last ledger activity without changing classification counts', async () => {
    const nowMs = Date.parse('2026-08-29T16:00:00.000Z');
    const lastEvent = '2026-08-29T15:59:55.000Z';
    const hold = processFixture({
      pid: 23117,
      ppid: 1,
      cpuPercent: 0.1,
      elapsedSeconds: 32 * 3600 + 54 * 60,
      cwd: '/tmp/self-impl-hold',
      cwdStatus: 'observed',
      ownership: {
        status: 'observed',
        runId: 'run-5da31123-1fe3-49b7-a5d0-998740374d3c',
        originSession: '7507f456-2b74-4a6a-ad2c-1a09c8851577',
      },
    });
    const missingRunId = processFixture({
      pid: 4242,
      ppid: 1,
      cpuPercent: 0.2,
      elapsedSeconds: 8 * 3600,
      cwdStatus: 'observed',
      ownership: { status: 'observed' },
    });
    const unreadLedger = processFixture({
      pid: 9001,
      ppid: 1,
      cpuPercent: 0.3,
      elapsedSeconds: 9 * 3600,
      cwdStatus: 'observed',
      ownership: { status: 'observed', runId: 'run-6ecb1a67-f650-48d9-86f5-88715e91746c' },
    });
    const burning = processFixture({
      pid: 12861,
      ppid: 1,
      cpuPercent: 98.9,
      elapsedSeconds: 90,
      cwdStatus: 'observed',
      ownership: { status: 'observed', runId: 'run-5da31123-1fe3-49b7-a5d0-998740374d3c' },
    });

    const lookupLedger: HarnessProcessLedgerLookup = (runId) => {
      if (runId === 'run-5da31123-1fe3-49b7-a5d0-998740374d3c') {
        return [{ timestamp: lastEvent }];
      }
      throw new Error('ledger unreadable');
    };

    const lines = await runProcesses(
      [hold, missingRunId, unreadLedger, burning],
      [],
      { status: 'failed', reason: 'launchctl not invoked in test' },
      lookupLedger,
      nowMs,
    );
    const text = lines.join('\n');

    expect(text).toContain('자원소비 1 · 장기실행만 3');
    expect(text).toContain('lastActivity 자: 런 원장 전이만 (로그 스토어는 안 본다)');
    expect(text).toContain(`pid=23117 ppid=1 elapsed=32h 54m cpu=0.1% worktree=unassociated lastActivity=${lastEvent} (5s) · 원장만`);
    expect(text).toContain('pid=4242 ppid=1 elapsed=8h 00m cpu=0.2% worktree=unassociated lastActivity=미상');
    expect(text).toContain('pid=9001 ppid=1 elapsed=9h 00m cpu=0.3% worktree=unassociated lastActivity=조회 실패 · 원장만');
    expect(text).toContain(`pid=12861 ppid=1 elapsed=1m 30s cpu=98.9% worktree=unassociated lastActivity=${lastEvent} (5s) · 원장만`);
    expect(HARNESS_PROCESS_RESOURCE_CPU_PERCENT).toBe(50);
    expect(HARNESS_PROCESS_LONG_RUNNING_ELAPSED_SECONDS).toBe(60 * 60);
  });

  test('launchctl parsing and evidence retain managed, no-evidence, and unqueried states', () => {
    expect(parseLaunchctlListOutput(MEASURED_LAUNCHCTL_LIST)).toEqual([46480, 4421]);
    expect(parseLaunchctlListOutput('-       0     com.elanous.control\n')).toEqual([]);

    const observed = observeHarnessLaunchdPids({
      platform: 'darwin',
      execLaunchctlList: () => MEASURED_LAUNCHCTL_LIST,
    });
    expect(observed).toEqual({ status: 'ok', pids: [46480, 4421] });

    const unavailable = observeHarnessLaunchdPids({
      platform: 'linux',
      execLaunchctlList: () => MEASURED_LAUNCHCTL_LIST,
    });
    expect(unavailable.status).toBe('failed');

    expect(resolveHarnessProcessLaunchdEvidence(46480, observed)).toBe('managed');
    expect(resolveHarnessProcessLaunchdEvidence(9001, observed)).toBe('no-evidence');
    expect(resolveHarnessProcessLaunchdEvidence(46480, unavailable)).toBe('unqueried');
  });

  test('NUL-delimited ownership parsing preserves values and does not trust flattened argv tokens', () => {
    expect(parseProcessOwnershipEnv(MEASURED_OWNERSHIP_ENV)).toEqual({
      status: 'observed',
      runId: 'run-5da31123-1fe3-49b7-a5d0-998740374d3c',
      originSession: '7507f456-2b74-4a6a-ad2c-1a09c8851577',
      stateDir: '/Users/example/source/axon/monad-agent/.elanous-test',
    });

    expect(parseProcessOwnershipEnv([
      'bun bin/elanous.mjs',
      'ELANOUS_RUN_ID=forged',
      'ELANOUS_ORIGIN_SESSION=forged',
      'ELANOUS_STATE_DIR=/tmp/forged',
    ].join(' '))).toEqual({ status: 'observed' });

    expect(parseProcessOwnershipEnv([
      'ELANOUS_RUN_ID=run-5da31123-1fe3-49b7-a5d0-998740374d3c',
      'ELANOUS_ORIGIN_SESSION=7507f456-2b74-4a6a-ad2c-1a09c8851577',
      'ELANOUS_STATE_DIR=/tmp/elanous state dir/.elanous-test',
    ].join('\0'))).toEqual({
      status: 'observed',
      runId: 'run-5da31123-1fe3-49b7-a5d0-998740374d3c',
      originSession: '7507f456-2b74-4a6a-ad2c-1a09c8851577',
      stateDir: '/tmp/elanous state dir/.elanous-test',
    });
  });

  test('ps eww ownership parsing requires a confirmed argv prefix and preserves state paths with spaces', () => {
    expect(parsePsEwwOwnershipEnv(MEASURED_PS_EWW, MEASURED_PS_EWW_ARGV))
      .toEqual(MEASURED_PS_EWW_OWNERSHIP);

    const forgedArgv = [
      MEASURED_PS_EWW_ARGV,
      'ELANOUS_RUN_ID=run-forged-from-argv',
      'ELANOUS_ORIGIN_SESSION=session-forged',
      'ELANOUS_STATE_DIR=/tmp/forged',
    ].join(' ');
    const forgedOutput = [
      '  PID   TT  STAT      TIME COMMAND',
      `45806   ??  S      0:00.01 ${forgedArgv} PATH=/usr/bin HOME=/tmp`,
    ].join('\n');
    expect(parsePsEwwOwnershipEnv(forgedOutput, forgedArgv)).toEqual({ status: 'observed' });

    const embeddedArgv = [
      '  PID   TT  STAT      TIME COMMAND',
      `45806   ??  S      0:00.01 /usr/bin/env ${MEASURED_PS_EWW_ARGV} ELANOUS_RUN_ID=forged`,
    ].join('\n');
    expect(parsePsEwwOwnershipEnv(embeddedArgv, MEASURED_PS_EWW_ARGV)).toEqual({
      status: 'unknown',
      reason: 'ps eww: argv prefix unconfirmed',
    });

    const spacedStateDir = '/tmp/elanous state dir/.elanous-test';
    const spacedOutput = [
      '  PID   TT  STAT      TIME COMMAND',
      [
        '45806   ??  S      0:00.01',
        MEASURED_PS_EWW_ARGV,
        'PATH=/usr/bin',
        'ELANOUS_RUN_ID=run-6ecb1a67-f650-48d9-86f5-88715e91746c',
        'ELANOUS_ORIGIN_SESSION=7507f456-2b74-4a6a-ad2c-1a09c8851577',
        `ELANOUS_STATE_DIR=${spacedStateDir}`,
        'HOME=/tmp',
      ].join(' '),
    ].join('\n');
    expect(parsePsEwwOwnershipEnv(spacedOutput, MEASURED_PS_EWW_ARGV)).toEqual({
      ...MEASURED_PS_EWW_OWNERSHIP,
      stateDir: spacedStateDir,
    });
  });

  test('ownership reading falls through from Linux environ to ps eww and distinguishes absent from unknown', () => {
    const fromProc = readProcessOwnership(12861, {
      execProcessEnv: () => MEASURED_OWNERSHIP_ENV,
    });
    expect(fromProc.status).toBe('observed');

    const fromPs = readProcessOwnership(45806, {
      readLinuxEnviron: () => {
        throw new Error("ENOENT: no such file or directory, open '/proc/45806/environ'");
      },
      execPsEww: () => MEASURED_PS_EWW,
      execPsArgv: () => MEASURED_PS_EWW_ARGV,
    });
    expect(fromPs).toEqual(MEASURED_PS_EWW_OWNERSHIP);

    const absent = readProcessOwnership(12345, {
      execPsEww: () => '  PID   TT  STAT      TIME COMMAND\n12345 ?? S 0:00.01 /usr/bin/ssh PATH=/usr/bin HOME=/tmp',
      execPsArgv: () => '/usr/bin/ssh',
    });
    const unread = readProcessOwnership(12345, {
      execPsEww: () => {
        throw new Error('ps eww: no such process');
      },
    });
    expect(absent).toEqual({ status: 'observed' });
    expect(unread).toEqual({ status: 'unknown', reason: 'ps eww: no such process' });
    expect(resolveHarnessProcessOwnership({ ownership: absent })).toEqual(absent);
    expect(resolveHarnessProcessOwnership({ ownership: unread })).toEqual(unread);
    expect(resolveHarnessProcessOwnership({})).toEqual({
      status: 'unknown',
      reason: 'ownership unconfirmed',
    });
  });

  test('live child ownership carries ELANOUS identifiers', async () => {
    const runId = 'run-live-ps-eww-ownership';
    const originSession = '7507f456-2b74-4a6a-ad2c-1a09c8851577';
    const stateDir = '/Users/example/source/axon/monad-agent/.elanous-test';
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      env: {
        ...process.env,
        ELANOUS_RUN_ID: runId,
        ELANOUS_ORIGIN_SESSION: originSession,
        ELANOUS_STATE_DIR: stateDir,
      },
      stdio: 'ignore',
    });

    try {
      expect(child.pid).toBeDefined();
      await Bun.sleep(150);
      expect(readProcessOwnership(child.pid!)).toEqual({
        status: 'observed',
        runId,
        originSession,
        stateDir,
      });
    } finally {
      child.kill();
    }
  });
});

describe('harness process classification/report helpers', () => {
  function syntheticProcess(
    overrides: Partial<HarnessProcessRecord> & Pick<HarnessProcessRecord, 'pid'>,
  ): HarnessProcessRecord {
    return {
      ppid: 1,
      cpuPercent: 0.1,
      elapsedSeconds: 12,
      command: 'bun bin/elanous.mjs --test harness processes',
      cwdStatus: 'observed',
      ownership: { status: 'observed' },
      ...overrides,
    };
  }

  test('classifies resource-consuming and long-running-only parent-absent processes', () => {
    const burning = syntheticProcess({
      pid: 12861,
      cpuPercent: 98.9,
      elapsedSeconds: 12 * 3600 + 8 * 60,
      cwd: '/tmp/self-impl-orphan',
    });
    const idle = syntheticProcess({
      pid: 4242,
      cpuPercent: 0.4,
      elapsedSeconds: 8 * 3600,
      cwd: '/tmp/self-impl-idle',
    });
    const quiet = syntheticProcess({
      pid: 77,
      ppid: 76,
      cpuPercent: 1.2,
      elapsedSeconds: 30,
    });
    const records = [burning, idle, quiet];
    const worktrees = ['/tmp/self-impl-orphan', '/tmp/self-impl-idle'];
    const livePids = new Set(records.map((record) => record.pid));

    expect(DEFAULT_HARNESS_PROCESS_THRESHOLDS).toEqual({
      resourceCpuPercent: HARNESS_PROCESS_RESOURCE_CPU_PERCENT,
      longRunningElapsedSeconds: HARNESS_PROCESS_LONG_RUNNING_ELAPSED_SECONDS,
    });
    expect(classifyHarnessProcess(burning)).toBe('resource-consuming');
    expect(classifyHarnessProcess(idle)).toBe('long-running-only');
    expect(classifyHarnessProcess(quiet)).toBeUndefined();
    expect(resolveHarnessProcessParentStatus(burning, livePids, 'complete')).toBe('absent');
    expect(associateHarnessProcessWorktree(burning, worktrees)).toEqual({
      status: 'associated',
      path: '/tmp/self-impl-orphan',
    });
    expect(formatHarnessProcessElapsed(burning.elapsedSeconds)).toBe('12h 08m');

    const report = buildHarnessProcessReport(records, worktrees);
    expect(report.resourceConsuming.map((row) => row.pid)).toEqual([12861]);
    expect(report.longRunningOnly.map((row) => row.pid)).toEqual([4242]);

    const rendered = renderHarnessProcessReport(report).join('\n');
    expect(rendered).toContain('자원소비:');
    expect(rendered).toContain('장기실행만:');
    expect(rendered).toContain('worktree=/tmp/self-impl-orphan');
    expect(rendered).toContain('lastActivity=미상');
    expect(report.longRunningOnly[0]?.lastActivity).toEqual({ status: 'unknown' });
  });

  test('lastActivity is observed from the last ledger event and never estimated', () => {
    const nowMs = Date.parse('2026-08-29T16:00:00.000Z');
    const timestamp = '2026-08-29T15:59:55.000Z';
    const observed = resolveHarnessProcessLastActivity(
      { status: 'observed', runId: 'run-5da31123-1fe3-49b7-a5d0-998740374d3c' },
      () => [{ timestamp }],
      nowMs,
    );
    expect(observed).toEqual({ status: 'observed', timestamp, ageSeconds: 5 });
    expect(renderHarnessProcessLastActivity(observed)).toBe(`${timestamp} (5s)`);

    expect(resolveHarnessProcessLastActivity({ status: 'observed' })).toEqual({ status: 'unknown' });
    expect(resolveHarnessProcessLastActivity({ status: 'unknown', reason: 'ownership unconfirmed' }))
      .toEqual({ status: 'unknown' });
    expect(renderHarnessProcessLastActivity({ status: 'unknown' })).toBe('미상');

    const owned = { status: 'observed' as const, runId: 'run-6ecb1a67-f650-48d9-86f5-88715e91746c' };
    expect(resolveHarnessProcessLastActivity(owned, () => null)).toEqual({ status: 'absent' });
    expect(resolveHarnessProcessLastActivity(owned, () => [])).toEqual({ status: 'unreadable' });
    expect(resolveHarnessProcessLastActivity(owned, () => [{ timestamp: '' }])).toEqual({ status: 'unreadable' });
    expect(resolveHarnessProcessLastActivity(owned, () => [{ timestamp: 'not-a-date' }])).toEqual({ status: 'unreadable' });
    expect(resolveHarnessProcessLastActivity(owned, () => {
      throw new Error('ledger unreadable');
    })).toEqual({ status: 'lookup-failed' });

    const absentText = renderHarnessProcessLastActivity({ status: 'absent' });
    const failedText = renderHarnessProcessLastActivity({ status: 'lookup-failed' });
    const unreadableText = renderHarnessProcessLastActivity({ status: 'unreadable' });
    expect(absentText).toBe('없음');
    expect(failedText).toBe('조회 실패');
    expect(unreadableText).toBe('시각 못 읽음');
    expect(failedText).not.toBe(absentText);
    expect(unreadableText).not.toBe(absentText);
    expect(unreadableText).not.toBe(failedText);
  });

  test('lookup failure and confirmed ledger absence render as different lastActivity strings', () => {
    const failed = syntheticProcess({
      pid: 9001,
      cpuPercent: 0.3,
      elapsedSeconds: 9 * 3600,
      ownership: { status: 'observed', runId: 'run-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
    });
    const missing = syntheticProcess({
      pid: 9002,
      cpuPercent: 0.3,
      elapsedSeconds: 9 * 3600,
      ownership: { status: 'observed', runId: 'run-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' },
    });
    const lookupLedger: HarnessProcessLedgerLookup = (runId) => {
      if (runId === 'run-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') {
        throw new Error('ledger unreadable');
      }
      return null;
    };
    const report = buildHarnessProcessReport(
      [failed, missing],
      [],
      DEFAULT_HARNESS_PROCESS_THRESHOLDS,
      'subset',
      { status: 'failed', reason: 'launchctl not invoked in test' },
      lookupLedger,
    );
    const text = renderHarnessProcessReport(report).join('\n');
    const failedLine = 'pid=9001 ppid=1 elapsed=9h 00m cpu=0.3% worktree=unassociated lastActivity=조회 실패 · 원장만';
    const absentLine = 'pid=9002 ppid=1 elapsed=9h 00m cpu=0.3% worktree=unassociated lastActivity=없음 · 원장만';
    expect(text).toContain('lastActivity 자: 런 원장 전이만 (로그 스토어는 안 본다)');
    expect(text).toContain(failedLine);
    expect(text).toContain(absentLine);
    expect(failedLine).not.toBe(absentLine);
    expect(report.longRunningOnly.map((row) => row.lastActivity.status)).toEqual(['lookup-failed', 'absent']);
  });

  test('defaultLookupHarnessProcessLedger does not collapse lookup failure into absence', () => {
    expect(defaultLookupHarnessProcessLedger('run-ffffffff-ffff-ffff-ffff-ffffffffffff')).toBeNull();
    expect(() => defaultLookupHarnessProcessLedger('../escape')).toThrow(/invalid runId/);
  });

  test('an empty report explicitly states that no processes were observed', () => {
    const report = buildHarnessProcessReport([]);
    expect(report.observationStatus).toBe('ok');
    expect(report.resourceConsuming).toEqual([]);
    expect(report.longRunningOnly).toEqual([]);
    expect(report.parentUnknown).toEqual([]);
    expect(renderHarnessProcessReport(report)).toContain('관찰 대상 없음');
  });
});

test('draft sweep gh calls pass an explicit env built from process.env (cron minimal PATH — Bun resolves against the startup PATH otherwise)', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(import.meta.dir, 'harness-cli-command.ts'), 'utf8') as string;
  const calls = [...source.matchAll(/execFileSync\('gh',[\s\S]*?\)\s*[;.)]/g)].map((m) => m[0]);
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.filter((call) => !/\benv\b/.test(call))).toEqual([]);
  expect(source).toContain('const env = ghAutomationEnv(process.env);');
});

test('harness progress: queries running runs as harness.progress and prints the progress table; --json prints the same row array', async () => {
  const callers: (string | undefined)[] = [];
  const result = assessRunningRuns([{ runId: 'run-p', lifecycle: 'live', ledgerDirectory: '/state/run-p', lastActivityTimestamp: '2026-10-11T00:00:00.000Z' } as never], {
    refs: [{ instance: 'prod', id: 'pty-p', kind: 'shell', alive: true, runId: 'run-p' }], unreadable: [],
  });
  const progress = {
    query: ((options?: { caller?: string }) => { callers.push(options?.caller); return result; }) as never,
    nowMs: () => Date.parse('2026-10-11T00:30:00.000Z'),
  };
  const program = new Command().exitOverride();
  installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness', progress });
  const printed: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); };
  try {
    await program.parseAsync(['node', 'elanous', 'harness', 'progress']);
    await program.parseAsync(['node', 'elanous', 'harness', 'progress', '--json']);
  } finally {
    console.log = original;
  }
  expect(callers).toEqual(['harness.progress', 'harness.progress']);
  expect(printed[0]).toBe(renderRunProgressTable(result, Date.parse('2026-10-11T00:30:00.000Z')));
  expect(printed[0]).toContain('run-p · running · 단계 미관측 · 진입 미관측 · 마지막 진전 2026-10-11T00:00:00.000Z (경과 30m0s) · pty prod:pty-p');
  expect(JSON.parse(printed[1]!)).toEqual(buildRunProgressRows(result, Date.parse('2026-10-11T00:30:00.000Z')));
});

test('harness progress --json: an unreadable ledger without completeness=partial still puts the partial-observation header on stderr', async () => {
  const base = assessRunningRuns([{ runId: 'run-q', lifecycle: 'live', ledgerDirectory: '/state/run-q' } as never], { refs: [], unreadable: [] });
  const result = { ...base, ledger: { ...base.ledger, unreadableLedgerCount: 1 } };
  expect(result.completeness).toBeUndefined();
  const progress = { query: (() => result) as never, nowMs: () => Date.parse('2026-10-11T00:30:00.000Z') };
  const program = new Command().exitOverride();
  installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness', progress });
  const printed: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    await program.parseAsync(['node', 'elanous', 'harness', 'progress', '--json']);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  expect(JSON.parse(printed[0]!)).toEqual(buildRunProgressRows(result, Date.parse('2026-10-11T00:30:00.000Z')));
  expect(errors).toHaveLength(1);
  expect(errors[0]).toStartWith('부분 관측 — 최소');
  expect(errors[0]).toContain('읽지 못한 원장: 목록 미관측');
  expect(errors[0]).not.toContain('없음');
});

test('harness progress --pid: a recorded live local binding returns only its run', async () => {
  const result = assessRunningRuns([
    { runId: 'run-local', lifecycle: 'live', ledgerDirectory: '/state/run-local' } as never,
    { runId: 'run-other', lifecycle: 'live', ledgerDirectory: '/state/run-other' } as never,
  ], { refs: [
    { instance: 'prod', id: 'pty-local', kind: 'shell', alive: true, runId: 'run-local' },
    { instance: 'prod', id: 'pty-other', kind: 'shell', alive: true, runId: 'run-other' },
  ], unreadable: [] });
  const queries: unknown[] = [];
  const program = new Command().exitOverride();
  installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness', progress: {
    bindingRunIds: () => ['run-local'],
    readBinding: () => ({ pid: 4242, startedAt: 10_450, cwd: '/local' }),
    processStartMs: () => 10_000,
    query: ((options: unknown) => { queries.push(options); return result; }) as never,
    nowMs: () => 20_000,
  } });
  const printed: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); };
  try {
    await program.parseAsync(['node', 'elanous', 'harness', 'progress', '--pid', '4242']);
    await program.parseAsync(['node', 'elanous', 'harness', 'progress', '--pid', '4242', '--json']);
  } finally { console.log = original; }
  expect(queries).toEqual([
    { runIds: ['run-local'], caller: 'harness.progress.pid', timeBudgetMs: 7_000 },
    { runIds: ['run-local'], caller: 'harness.progress.pid', timeBudgetMs: 7_000 },
  ]);
  expect(printed[0]).toContain('pid 4242 · run-local · running');
  expect(printed[0]).not.toContain('run-other');
  expect(JSON.parse(printed[1]!)).toMatchObject({ pid: 4242, observation: 'observed', runId: 'run-local' });
  expect(JSON.parse(printed[1]!).progress).toEqual(buildRunProgressRows(result, 20_000)[0]);
});

test('harness progress --pid: unlinked, Pod, exited and reused PIDs remain unobserved', async () => {
  const cases = [
    { name: 'unlinked', ids: [] as string[], binding: null, start: null },
    { name: 'Pod', ids: ['run-remote'], binding: { pid: 4242, startedAt: 10_000, cwd: '/local', podName: 'pod-1' }, start: 10_000 },
    { name: 'exited', ids: ['run-ended'], binding: { pid: 4242, startedAt: 10_000, cwd: '/local' }, start: null },
    { name: 'reused', ids: ['run-reused'], binding: { pid: 4242, startedAt: 10_000, cwd: '/local' }, start: 20_000 },
    { name: 'reused within old tolerance', ids: ['run-reused-near'], binding: { pid: 4242, startedAt: 10_450, cwd: '/local' }, start: 12_000 },
    { name: 'ambiguous', ids: ['run-one', 'run-two'], binding: { pid: 4242, startedAt: 10_000, cwd: '/local' }, start: 10_000 },
    { name: 'local and Pod share PID', ids: ['run-local', 'run-remote'], binding: { pid: 4242, startedAt: 10_000, cwd: '/local' }, start: 10_000 },
  ];
  for (const scenario of cases) {
    let queried = false;
    const program = new Command().exitOverride();
    installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness', progress: {
      bindingRunIds: () => scenario.ids,
      readBinding: (runId) => scenario.name === 'local and Pod share PID' && runId === 'run-remote'
        ? { ...scenario.binding!, podName: 'pod-1' } : scenario.binding,
      processStartMs: () => scenario.start,
      query: (() => { queried = true; throw new Error('must not query'); }) as never,
    } });
    const printed: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); };
    try { await program.parseAsync(['node', 'elanous', 'harness', 'progress', '--pid', '4242', '--json']); }
    finally { console.log = original; }
    expect(printed, scenario.name).toEqual(['{"pid":4242,"observation":"unobserved","runId":null,"progress":null}']);
    expect(queried, scenario.name).toBe(false);
  }
});

test('harness progress --pid reads a recorded local binding from the launch registry', async () => {
  const registry = mkdtempSync(join(tmpdir(), 'harness-progress-pid-'));
  const runId = `run-pid-registry-${Date.now()}`;
  const podRunId = `${runId}-pod`;
  const startedAt = psProcessStartMs(process.pid);
  expect(startedAt).not.toBeNull();
  const result = assessRunningRuns([{ runId, lifecycle: 'live', ledgerDirectory: `/state/${runId}` } as never], {
    refs: [{ instance: 'prod', id: 'pty-registry', kind: 'shell', alive: true, runId }], unreadable: [],
  });
  const program = new Command().exitOverride();
  const printed: string[] = [];
  const original = console.log;
  const originalTmpDir = process.env.TMPDIR;
  try {
    process.env.TMPDIR = registry;
    expect(writeLaunchBinding(runId, { pid: process.pid, startedAt: startedAt!, cwd: process.cwd() })).not.toBeNull();
    expect(launchRegistryDir()).toStartWith(registry);
    installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness', progress: {
      query: (() => result) as never,
    } });
    console.log = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); };
    await program.parseAsync(['node', 'elanous', 'harness', 'progress', '--pid', String(process.pid), '--json']);
    expect(writeLaunchBinding(podRunId, { pid: process.pid, startedAt: startedAt!, cwd: process.cwd(), podName: 'pod-1' })).not.toBeNull();
    await program.parseAsync(['node', 'elanous', 'harness', 'progress', '--pid', String(process.pid), '--json']);
    removeLaunchBinding(runId);
    await program.parseAsync(['node', 'elanous', 'harness', 'progress', '--pid', String(process.pid), '--json']);
  } finally {
    console.log = original;
    if (originalTmpDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpDir;
    rmSync(registry, { recursive: true, force: true });
  }
  expect(JSON.parse(printed[0]!)).toMatchObject({ pid: process.pid, observation: 'observed', runId });
  expect(JSON.parse(printed[1]!)).toEqual({ pid: process.pid, observation: 'unobserved', runId: null, progress: null });
  expect(JSON.parse(printed[2]!)).toEqual({ pid: process.pid, observation: 'unobserved', runId: null, progress: null });
  expect(printed).toHaveLength(3);
});


test('HARNESS-PROGRESS-HANG: a stalled provider stops inside the bound, keeps the rows it already has, and records progress-command-stalled', async () => {
  const events: unknown[][] = [];
  const originalDebugLog = debug.log;
  debug.log = ((...args: unknown[]) => { events.push(args); }) as typeof debug.log;
  const program = new Command().exitOverride();
  installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness', progress: {
    query: (() => new Promise(() => {})) as never,
    nowMs: () => Date.parse('2026-10-11T00:30:00.000Z'),
    timeoutMs: 25,
  } as never });
  const printed: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  let hung = false;
  const startedAt = Date.now();
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<boolean>((done) => { watchdog = setTimeout(() => done(true), 3_000); });
  try {
    hung = await Promise.race([
      program.parseAsync(['node', 'elanous', 'harness', 'progress', '--json']).then(() => false),
      guard,
    ]);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    console.log = originalLog;
    console.error = originalError;
    debug.log = originalDebugLog;
  }
  expect(hung).toBe(false);
  expect(Date.now() - startedAt).toBeLessThan(3_000);
  expect(JSON.parse(printed[0]!)).toEqual([]);
  const stallCall = events.find((args) => args[1] === 'progress-command-stalled');
  expect(stallCall?.[0]).toBe('harness.progress');
  expect(stallCall?.[2]).toMatchObject({
    event: 'progress-command-stalled', stage: 'run-query', reason: 'timeout',
    timeoutMs: 25, preservedRowCount: 0, caller: 'harness.progress',
  });
  expect(typeof (stallCall?.[2] as { observedAt?: unknown } | undefined)?.observedAt).toBe('string');
  expect(errors[0]).toContain('progress-command-stalled');
  expect(JSON.parse(errors[1]!)).toMatchObject({ event: 'progress-command-stalled', stage: 'run-query', reason: 'timeout', timeoutMs: 25 });
});

test('HARNESS-PROGRESS-HANG: a provider answering after the bound keeps its rows and is still recorded as stalled', async () => {
  const result = assessRunningRuns(
    [{ runId: 'run-slow', lifecycle: 'live', ledgerDirectory: '/state/run-slow', lastActivityTimestamp: '2026-10-11T00:00:00.000Z' } as never],
    { refs: [], unreadable: [] },
  );
  const events: unknown[][] = [];
  const originalDebugLog = debug.log;
  debug.log = ((...args: unknown[]) => { events.push(args); }) as typeof debug.log;
  const program = new Command().exitOverride();
  installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness', progress: {
    query: (() => {
      const until = Date.now() + 40;
      while (Date.now() < until) { /* hold the thread past the bound, then answer */ }
      return result;
    }) as never,
    nowMs: () => Date.parse('2026-10-11T00:30:00.000Z'),
    timeoutMs: 10,
  } as never });
  const printed: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    await program.parseAsync(['node', 'elanous', 'harness', 'progress', '--json']);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    debug.log = originalDebugLog;
  }
  expect(JSON.parse(printed[0]!)).toEqual(buildRunProgressRows(result, Date.parse('2026-10-11T00:30:00.000Z')));
  const stallCall = events.find((args) => args[1] === 'progress-command-stalled');
  expect(stallCall?.[2]).toMatchObject({ stage: 'run-query', reason: 'timeout', timeoutMs: 10, preservedRowCount: 1 });
  expect(errors[0]).toContain('progress-command-stalled');
});

test('HARNESS-PROGRESS-HANG: normal and partial-observation providers never report a stall', async () => {
  const normal = assessRunningRuns(
    [{ runId: 'run-ok', lifecycle: 'live', ledgerDirectory: '/state/run-ok', lastActivityTimestamp: '2026-10-11T00:00:00.000Z' } as never],
    { refs: [{ instance: 'prod', id: 'pty-ok', kind: 'shell', alive: true, runId: 'run-ok' }], unreadable: [] },
  );
  const base = assessRunningRuns([{ runId: 'run-partial', lifecycle: 'live', ledgerDirectory: '/state/run-partial' } as never], { refs: [], unreadable: [] });
  const partial = { ...base, ledger: { ...base.ledger, unreadableLedgerCount: 1 } };
  const events: unknown[][] = [];
  const originalDebugLog = debug.log;
  debug.log = ((...args: unknown[]) => { events.push(args); }) as typeof debug.log;
  const runProgress = async (payload: unknown): Promise<{ printed: string[]; errors: string[] }> => {
    const program = new Command().exitOverride();
    installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness', progress: {
      query: (() => payload) as never,
      nowMs: () => Date.parse('2026-10-11T00:30:00.000Z'),
    } as never });
    const printed: string[] = [];
    const errors: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); };
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      await program.parseAsync(['node', 'elanous', 'harness', 'progress', '--json']);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    return { printed, errors };
  };
  try {
    const full = await runProgress(normal);
    expect(JSON.parse(full.printed[0]!)).toEqual(buildRunProgressRows(normal, Date.parse('2026-10-11T00:30:00.000Z')));
    expect(full.errors).toEqual([]);
    const shortened = await runProgress(partial);
    expect(JSON.parse(shortened.printed[0]!)).toEqual(buildRunProgressRows(partial, Date.parse('2026-10-11T00:30:00.000Z')));
    expect(shortened.errors[0]).toStartWith('부분 관측 — 최소');
  } finally {
    debug.log = originalDebugLog;
  }
  expect(events.filter((args) => args[1] === 'progress-command-stalled')).toEqual([]);
});

test('HARNESS-PROGRESS-HANG: a cooperative scan exposes its partial rows and deadline stage as a stall', async () => {
  const base = assessRunningRuns([], { refs: [], unreadable: [] });
  const result = { ...base, stalled: { stage: 'ledger-scan', reason: 'deadline-exceeded' } } as RunningRunsResult;
  const events: unknown[][] = [];
  const originalDebugLog = debug.log;
  debug.log = ((...args: unknown[]) => { events.push(args); }) as typeof debug.log;
  const program = new Command().exitOverride();
  installHarnessCliCommand(program, {
    registerSink: async () => {}, resolveSurface: async () => 'harness',
    progress: { query: (() => result) as never, timeoutMs: 8_000 },
  });
  const printed: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    await program.parseAsync(['node', 'elanous', 'harness', 'progress', '--json']);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    debug.log = originalDebugLog;
  }
  expect(JSON.parse(printed[0]!)).toEqual([]);
  expect(JSON.parse(errors[2]!)).toMatchObject({
    event: 'progress-command-stalled', stage: 'ledger-scan', reason: 'deadline-exceeded',
    timeoutMs: 8_000, preservedRowCount: 0,
  });
  expect(events.find((args) => args[1] === 'progress-command-stalled')?.[2]).toMatchObject({
    stage: 'ledger-scan', reason: 'deadline-exceeded',
  });
});

test('HARNESS-PROGRESS-HANG: harness progress --pid reports a stalled lookup beside the unchanged observation keys', async () => {
  const events: unknown[][] = [];
  const originalDebugLog = debug.log;
  debug.log = ((...args: unknown[]) => { events.push(args); }) as typeof debug.log;
  const program = new Command().exitOverride();
  installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness', progress: {
    bindingRunIds: () => ['run-local'],
    readBinding: () => ({ pid: 4242, startedAt: 10_450, cwd: '/local' }),
    processStartMs: () => 10_000,
    query: (() => new Promise(() => {})) as never,
    nowMs: () => 20_000,
    timeoutMs: 25,
  } as never });
  const printed: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { /* the stall line is asserted through the debug event below */ };
  try {
    await program.parseAsync(['node', 'elanous', 'harness', 'progress', '--pid', '4242', '--json']);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    debug.log = originalDebugLog;
  }
  expect(JSON.parse(printed[0]!)).toMatchObject({ pid: 4242, observation: 'unobserved', runId: null, progress: null });
  expect(JSON.parse(printed[0]!).stall).toMatchObject({ stage: 'run-query', reason: 'timeout', timeoutMs: 25, caller: 'harness.progress.pid', preservedRowCount: 0 });
  expect(events.find((args) => args[1] === 'progress-command-stalled')?.[2]).toMatchObject({ caller: 'harness.progress.pid' });
});

test('HARNESS-PROGRESS-HANG: ELANOUS_HARNESS_PROGRESS_TIMEOUT_MS lowers the bound without a test seam', async () => {
  const result = assessRunningRuns(
    [{ runId: 'run-env', lifecycle: 'live', ledgerDirectory: '/state/run-env', lastActivityTimestamp: '2026-10-11T00:00:00.000Z' } as never],
    { refs: [], unreadable: [] },
  );
  const events: unknown[][] = [];
  const originalDebugLog = debug.log;
  const previousBound = process.env.ELANOUS_HARNESS_PROGRESS_TIMEOUT_MS;
  debug.log = ((...args: unknown[]) => { events.push(args); }) as typeof debug.log;
  const program = new Command().exitOverride();
  installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness', progress: {
    query: (() => {
      const until = Date.now() + 30;
      while (Date.now() < until) { /* overrun the operator-supplied bound */ }
      return result;
    }) as never,
    nowMs: () => Date.parse('2026-10-11T00:30:00.000Z'),
  } as never });
  const printed: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { /* stall evidence is asserted through the debug event */ };
  try {
    process.env.ELANOUS_HARNESS_PROGRESS_TIMEOUT_MS = '5';
    await program.parseAsync(['node', 'elanous', 'harness', 'progress', '--json']);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    debug.log = originalDebugLog;
    if (previousBound === undefined) delete process.env.ELANOUS_HARNESS_PROGRESS_TIMEOUT_MS;
    else process.env.ELANOUS_HARNESS_PROGRESS_TIMEOUT_MS = previousBound;
  }
  expect(JSON.parse(printed[0]!)).toEqual(buildRunProgressRows(result, Date.parse('2026-10-11T00:30:00.000Z')));
  expect(events.find((args) => args[1] === 'progress-command-stalled')?.[2]).toMatchObject({ timeoutMs: 5, preservedRowCount: 1 });
});

test('HARNESS-PROGRESS-HANG: queryProgressBounded preserves rows when the async path has no result yet', async () => {
  const result = assessRunningRuns(
    [{ runId: 'run-late', lifecycle: 'live', ledgerDirectory: '/state/run-late', lastActivityTimestamp: '2026-10-11T00:00:00.000Z' } as never],
    { refs: [], unreadable: [] },
  );
  const events: unknown[][] = [];
  const originalDebugLog = debug.log;
  debug.log = ((...args: unknown[]) => { events.push(args); }) as typeof debug.log;
  let release!: (value: RunningRunsResult) => void;
  const query = (() => new Promise<RunningRunsResult>((done) => { release = done; })) as never;
  const startedAt = Date.now();
  try {
    const outcome = await queryProgressBounded({ caller: 'harness.progress' }, { query, timeoutMs: 5 });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(outcome.result).toBeNull();
    expect(outcome.stall).toMatchObject({
      event: 'progress-command-stalled', stage: 'run-query', reason: 'timeout',
      timeoutMs: 5, caller: 'harness.progress', preservedRowCount: 0,
    });
    release(result);
    await new Promise((done) => setTimeout(done, 20));
    const late = events.find((args) => args[1] === 'progress-command-late');
    expect(late?.[0]).toBe('harness.progress');
    expect(late?.[2]).toMatchObject({
      reason: 'late-value', timeoutMs: 5, caller: 'harness.progress',
      preservedRowCount: 1, result,
    });
  } finally {
    debug.log = originalDebugLog;
  }
});

test('HARNESS-PROGRESS-HANG: the real progress worker is spawned and terminated when the bound expires — no query injection', async () => {
  const lifecycle: ProgressWorkerLifecycle[] = [];
  setHarnessProgressWorkerObserverForTesting((event) => { lifecycle.push(event); });
  const startedAt = Date.now();
  try {
    const outcome = await queryProgressBounded({ caller: 'harness.progress' }, { timeoutMs: 5 });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(outcome.result).toBeNull();
    expect(outcome.stall).toMatchObject({
      event: 'progress-command-stalled', stage: 'run-query', reason: 'timeout',
      timeoutMs: 5, caller: 'harness.progress', preservedRowCount: 0,
    });
  } finally {
    setHarnessProgressWorkerObserverForTesting(undefined);
  }
  // 상한 뒤 유예 창 안에 워커가 «현재 행» 을 회신하면 'message' 가 추가로 관찰될 수 있다 —
  // 무응답이면 spawn → terminate 만 찍힌다. 두 경우 모두 «상한 내 종료»다.
  expect(lifecycle[0]?.event).toBe('spawn');
  expect(lifecycle.some((event) => event.event === 'terminate')).toBe(true);
  expect(lifecycle.some((event) => event.event === 'error')).toBe(false);
}, 20_000);

test('HARNESS-PROGRESS-HANG: the real progress worker answers inside a generous bound and is terminated — no query injection', async () => {
  const lifecycle: ProgressWorkerLifecycle[] = [];
  setHarnessProgressWorkerObserverForTesting((event) => { lifecycle.push(event); });
  try {
    const outcome = await queryProgressBounded({ caller: 'harness.progress' }, { timeoutMs: 60_000 });
    expect(outcome.stall).toBeNull();
    expect(outcome.result).not.toBeNull();
    expect(Array.isArray(outcome.result!.entries)).toBe(true);
  } finally {
    setHarnessProgressWorkerObserverForTesting(undefined);
  }
  expect(lifecycle.map((event) => event.event)).toEqual(['spawn', 'message', 'terminate']);
}, 90_000);

test('HARNESS-PROGRESS-HANG: the deploy entry re-entered inside a worker thread skips the CLI', async () => {
  expect(shouldRunCliEntry()).toBe(true);
  const startedAt = Date.now();
  const exited = await new Promise<{ code: number | null; elapsedMs: number; error?: string }>((done) => {
    const worker = new Worker(new URL('../../bin/elanous.mjs', import.meta.url));
    const timer = setTimeout(() => {
      void worker.terminate();
      done({ code: null, elapsedMs: Date.now() - startedAt });
    }, 8_000);
    worker.once('exit', (code) => { clearTimeout(timer); done({ code, elapsedMs: Date.now() - startedAt }); });
    worker.once('error', (error: unknown) => { clearTimeout(timer); done({ code: -1, elapsedMs: Date.now() - startedAt, error: String(error) }); });
  });
  expect(exited.error).toBeUndefined();
  expect(exited.code).toBe(0);
  expect(exited.elapsedMs).toBeLessThan(8_000);
}, 20_000);

test.skipIf(process.platform !== 'darwin')('macOS pid-bound handle: SIGTERM reaches the same process; a gone pid is refused (PROC1 · no pidfd on darwin)', async () => {
  const child = spawn('sleep', ['30']);
  await new Promise((done) => setTimeout(done, 150));
  const handle = openHarnessProcessHandle(child.pid!);
  const exited = new Promise((done) => child.once('exit', (_code, signal) => done(signal)));
  handle.signal('SIGTERM');
  handle.close();
  expect(await exited).toBe('SIGTERM');
  // The process is gone: a fresh handle cannot be bound and a stale one must not signal.
  expect(() => openHarnessProcessHandle(child.pid!)).toThrow();
  expect(() => handle.signal('SIGTERM')).toThrow();
});

describe('recordHarnessPodStop — AUT-POD-EXIT-UNCLASSIFIED wiring', () => {
  const noLedger = () => null;
  const unknownDeps = { loadLedger: noLedger, hasJobApplied: () => true, supervisorDecision: () => undefined, loadCheckpoint: () => null };
  const uniqueRunId = (tag: string) => `run-podexit-${tag}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const capture = () => {
    const entries: Array<{ event: string; data: Record<string, unknown> }> = [];
    return { entries, write: (entry: { event: string; data: Record<string, unknown> }) => { entries.push(entry); } };
  };

  test('lifts the full child facts from the parent ledger when the Pod output tail has no JSON', () => {
    const runId = uniqueRunId('scope-escape');
    const childEvidence = { classification: 'scope-escape', scopeEscape: true as const,
      abandonedClassification: { classification: 'implementation-deficit' },
      supervisorVerdict: 'UNCONVERGEABLE', goalCauseObserved: true as const,
      terminationReason: 'goal-only-rework-exhausted', accountAvailability: { reason: 'no-candidate', candidateCount: 0 },
      harvestable: true as const, prNumber: 30155,
      goalPlanRevision: { status: 'read' as const, attempted: 1, applied: 0, failureReasons: ['expected-text-not-found'] } };
    const { entries, write } = capture();
    expect(recordHarnessPodStop(runId, 1, { reason: 'pod-failure', lines: ['Pod 안 자식이 실패했다'] }, 'short tail', {
      loadLedger: (() => [
        { runId, event: 'pod-child-run', data: { job: 'current', childRunId: 'run-current' } },
        { runId, event: 'pod-child-evidence', data: { job: 'current', childRunId: 'run-current', childEvidence } },
      ]) as never,
      write: write as never,
    })).toBe(true);
    expect(entries[0]?.data).toMatchObject({ class: 'scope-escape', childEvidence });
  });

  test('the current no-evidence Pod marker masks an earlier scope escape', () => {
    const runId = uniqueRunId('scope-mask');
    const { entries, write } = capture();
    expect(recordHarnessPodStop(runId, 1, { reason: 'pod-failure', lines: ['Pod failed'] }, 'current failure', {
      loadLedger: (() => [
        { runId, event: 'pod-child-run', data: { job: 'old', childRunId: 'run-old' } },
        { runId, event: 'pod-child-evidence', data: { job: 'old', childRunId: 'run-old', childEvidence: { scopeEscape: true } } },
        { runId, event: 'pod-child-run', data: { job: 'new', childRunId: 'run-new' } },
        { runId, event: 'pod-child-evidence', data: { job: 'new', childRunId: 'run-new', childEvidence: null } },
      ]) as never,
      write: write as never,
    })).toBe(true);
    expect(entries[0]?.data.class).not.toBe('scope-escape');
    expect(entries[0]?.data.childEvidence).toBeUndefined();
  });

  test('① an unknown exit whose child died on ENOSPC records podExitClass child-error ⊕ the tail in the stop line', () => {
    const runId = uniqueRunId('enospc');
    const output = [`[self-dev] launching run ${runId}`, 'installing dependencies', 'Error: ENOSPC: no space left on device, write'].join('\n');
    const classified = classifyHarnessPodExit({ status: 1 }, output, { ...unknownDeps, runId });
    expect(classified.reason).toBe('unknown');
    const logSpy = spyOn(debug, 'log');
    const { entries, write } = capture();
    try {
      expect(recordHarnessPodStop(runId, 1, classified, output, { loadLedger: noLedger, write: write as never })).toBe(true);
      expect(logSpy.mock.calls.some(([category, event, data]) => category === 'harness.pod' && event === 'exit-classified-detail'
        && (data as { podExitClass?: string; tailLines?: number }).podExitClass === 'child-error'
        && (data as { tailLines?: number }).tailLines === 3)).toBe(true);
    } finally { logSpy.mockRestore(); }
    expect(entries).toHaveLength(1);
    const data = entries[0]!.data;
    expect(entries[0]!.event).toBe('stop');
    expect(data.podExitClass).toBe('child-error');
    expect(data.cause).toBe('Pod exit 1: child-error — Error: ENOSPC: no space left on device, write');
    expect(data.tail).toEqual([`[self-dev] launching run ${runId}`, 'installing dependencies', 'Error: ENOSPC: no space left on device, write']);
    expect(data.class).toBe('unclassified');
  });

  test('① the tail keeps at most five lines of at most 240 characters each', () => {
    const runId = uniqueRunId('bound');
    const long = `Error: ${'x'.repeat(400)}`;
    const output = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', long].join('\n');
    const { entries, write } = capture();
    expect(recordHarnessPodStop(runId, 1, { reason: 'unknown', lines: ['Pod 실행 여부 또는 종료 이유를 확인하지 못했다'] }, output, { loadLedger: noLedger, write: write as never })).toBe(true);
    const tail = entries[0]!.data.tail as string[];
    expect(tail).toHaveLength(5);
    expect(tail[0]).toBe('l3');
    expect(tail.every((line) => Array.from(line).length <= 240)).toBe(true);
  });

  test('② an already classified reason (no-launch) writes the same stop line as before — no podExitClass, no tail', () => {
    const runId = uniqueRunId('nolaunch');
    const output = 'Error: ENOSPC: no space left on device';
    const { entries, write } = capture();
    const logSpy = spyOn(debug, 'log');
    try {
      expect(recordHarnessPodStop(runId, 1, { reason: 'no-launch', lines: ['Pod 실행에 닿지 못했다 — 풀·컨텍스트·SSH 연결을 확인하거나 `--substrate local` 로 명시하라'] }, output, { loadLedger: noLedger, write: write as never })).toBe(true);
      expect(logSpy.mock.calls.some(([, event]) => event === 'exit-classified-detail')).toBe(false);
    } finally { logSpy.mockRestore(); }
    expect(Object.keys(entries[0]!.data).sort()).toEqual(['cause', 'class', 'evidenceRef', 'nextMove', 'site']);
    expect(entries[0]!.data).toEqual({
      class: 'launch-failed',
      site: 'pod-exit',
      cause: 'Pod exit 1: no-launch — 풀·컨텍스트·SSH 연결을 확인하거나 `--substrate local` 로 명시하라',
      evidenceRef: `logs:harness.pod/exit-classified:${runId}`,
      nextMove: 'Check Pod launch gate and pool, then relaunch',
    });
  });

  test('② OOMKilled stays byte-identical too', () => {
    const runId = uniqueRunId('oom');
    const { entries, write } = capture();
    expect(recordHarnessPodStop(runId, 137, { reason: 'OOMKilled', lines: ['Pod 종료 출력에서 확인한 원인: OOMKilled'] }, 'OOMKilled', { loadLedger: noLedger, write: write as never })).toBe(true);
    expect(entries[0]!.data).toEqual({
      class: 'pod-died', site: 'pod-exit', cause: 'Pod exit 137: OOMKilled', evidenceRef: `logs:harness.pod/exit-classified:${runId}`,
      nextMove: 'Inspect Pod exit classification and harvest the branch before relaunch',
    });
  });

  test('③ an empty output reads as podExitClass unknown with an empty tail, without throwing', () => {
    for (const output of ['', undefined]) {
      const runId = uniqueRunId('empty');
      const { entries, write } = capture();
      expect(recordHarnessPodStop(runId, 1, { reason: 'unknown', lines: ['Pod 실행 여부 또는 종료 이유를 확인하지 못했다'] }, output, { loadLedger: noLedger, write: write as never })).toBe(true);
      expect(entries[0]!.data.podExitClass).toBe('unknown');
      expect(entries[0]!.data.tail).toEqual([]);
      expect(entries[0]!.data.cause).toBe('Pod exit 1: unknown');
    }
  });
});

test('occupied new path preflight remains a deterministic refusal, not a Pod failure', () => {
  const attemptId = '01234567-89ab-cdef-0123-456789abcdef';
  const runId = 'run-0123456789abcdef';
  const line = `[self-dev] run ${runId} [preflight:new-path-occupied:${attemptId}] 신설 traced path 가 이미 점유됨: src/taken.ts — 골의 신설: 경로를 바로잡아야 한다`;
  const receipt = { runId, event: 'preflight-refused', data: { kind: 'occupied-new-traced-path', path: 'src/taken.ts', attemptId } };
  expect(classifyHarnessPodExit({ status: 2 }, `${line}\n`, {
    runId: receipt.runId, loadLedger: () => [receipt],
  })).toEqual({
    reason: 'preflight-refused', lines: [line],
  });
  // A Pod may print the same text; without the matching host receipt and refusal exit, it is not a host preflight.
  const podFailureEvidence = { runId: receipt.runId, event: 'job-applied', data: {} };
  expect(classifyHarnessPodExit({ status: 1 }, `${line}\n`, {
    runId: receipt.runId, loadLedger: () => [podFailureEvidence], hasJobApplied: () => true,
  }).reason).toBe('unknown');
  expect(classifyHarnessPodExit({ status: 2 }, `${line}\n`, {
    runId: receipt.runId, loadLedger: () => [podFailureEvidence], hasJobApplied: () => true,
  }).reason).toBe('unknown');
  const casesThatCannotProveRefusal = [
    { ...receipt, runId: 'run-ffffffffffffffff' },
    { ...receipt, data: { ...receipt.data, attemptId: 'fedcba98-7654-3210-fedc-ba9876543210' } },
    { ...receipt, data: { ...receipt.data, kind: 'other' } },
    { ...receipt, data: { ...receipt.data, path: 'src/other.ts' } },
  ];
  for (const invalidReceipt of casesThatCannotProveRefusal) {
    expect(classifyHarnessPodExit({ status: 2 }, `${line}\n`, {
      runId: receipt.runId, loadLedger: () => [invalidReceipt], hasJobApplied: () => true,
    }).reason).toBe('unknown');
  }
  expect(classifyHarnessPodExit({ status: null, signal: 'SIGTERM' }, `${line}\n`, {
    runId: receipt.runId, loadLedger: () => [receipt],
  }).reason).toBe('signal');
  // An append-only receipt from an earlier attempt with the same run ID cannot classify this attempt.
  expect(classifyHarnessPodExit({ status: 2 }, `${line}\n`, {
    runId: receipt.runId, loadLedger: () => [receipt, podFailureEvidence], hasJobApplied: () => true,
  }).reason).toBe('unknown');
  let stop: { site?: string; class?: string; cause?: string; nextMove?: string } | undefined;
  expect(recordHarnessPodStop('run-0123456789abcdef', 2, { reason: 'preflight-refused', lines: [line] }, line, {
    loadLedger: () => null,
    record: ((input: typeof stop) => { stop = input; return {} as never; }) as never,
  })).toBe(true);
  expect(stop).toMatchObject({
    site: 'preflight', class: 'launch-failed', cause: 'Preflight refused: occupied new traced path',
    nextMove: 'Correct the declared new path in the goal before relaunch',
  });
});
