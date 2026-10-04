import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ORIGINAL_ASK_MARKER } from '../self-implement/goal-author.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, spyOn, test } from 'bun:test';
import { resolveHarnessTarget } from '../self-implement/harness-target-options.js';
import { debug } from '../debug/log.js';
import { LogStore, logsDbPath } from '../mss/logging/log-store.js';
import * as podDispatch from './harness-pod-dispatch.js';
import { runSelfOrchestrateCliCommand } from '../self-dev/orchestrate-cli.js';
import { parsePodPool, PodPoolScheduler } from '../task-orchestrator/surfaces/pod-pool.js';
import { podSelfImplementSpawn, type Kubectl } from '../task-orchestrator/surfaces/self-implement-pod.js';
import { Command } from 'commander';
import { DevPipelineError } from '../self-dev/dev-pipeline.js';
import {
  DEFAULT_HARNESS_PROCESS_THRESHOLDS,
  HARNESS_PROCESS_LONG_RUNNING_ELAPSED_SECONDS,
  HARNESS_PROCESS_RESOURCE_CPU_PERCENT,
  associateHarnessProcessWorktree,
  buildHarnessProcessReport,
  classifyHarnessProcess,
  classifyHarnessPodExit,
  harnessPodRunId,
  defaultLookupHarnessProcessLedger,
  formatHarnessProcessElapsed,
  installHarnessCliCommand,
  killHarnessProcess,
  githubDraftSweepAdapters,
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
  setHarnessUnpressedDecisionSignalInspectorForTesting,
  type HarnessLaunchdPidObservation,
  type HarnessProcessLedgerLookup,
  type HarnessProcessListObservation,
  type HarnessProcessRecord,
  type HarnessWorktreeListObservation,
  openHarnessProcessHandle,
} from './harness-cli-command.js';

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
      .toEqual(['--apply', '--json', '--repo']);
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
    expect(closed[0]).toEqual(['default/repo', 43, expect.stringContaining('Branch preserved')]);
    expect(labels).toEqual([]);
    expect(lines.at(-2)).toContain('#43 close:');
    expect(lines.at(-1)).toBe('못 본 초안 0 · 이번에 닫음 1 · 처리 중 0 · 표식 만료 0');
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
    expect(lines.at(-1)).toBe('못 본 초안 0 · 이번에 닫음 1(dry-run) · 처리 중 1 · 표식 만료 1');
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
    expect(labels).toEqual([['my/repo', 44, { add: 'elanous:stalled', remove: ['elanous:running'] }]]);
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
      .toEqual(['claim', 'sweep']);
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
    } finally { process.exitCode = previousExit; }
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
    } finally { process.exitCode = previousExit; }
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
    } finally { process.exitCode = previousExit; }
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
    await adapters.closeDraft('my/repo', 3, 'Branch preserved.');
    expect(requests.slice(-2)).toEqual([
      ['pr', 'edit', '3', '--repo', 'my/repo', '--add-label', 'elanous:stalled', '--remove-label', 'elanous:running'],
      ['pr', 'close', '3', '--repo', 'my/repo', '--comment', 'Branch preserved.'],
    ]);
  });

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
    const { decideDraft } = await import('../self-dev/draft-triage-rules.js');
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
    const { decideDraft } = await import('../self-dev/draft-triage-rules.js');
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
      const { runDraftSweep } = await import('../self-dev/draft-sweep.js');
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
      const { runDraftSweep } = await import('../self-dev/draft-sweep.js');
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
        complete: false, entries: [], error: expect.stringContaining('GitHub listing failed') });
      expect(process.exitCode).toBe(1);
    } finally { process.exitCode = prior; }
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
    } finally { process.exitCode = previousExit; rmSync(goal, { force: true }); }
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
      process.exitCode = prior;
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
      expect(dispatch).toHaveBeenCalledWith({ entrance: 'cli-harness-ask', input: '/tmp/goal.md', podPool: 'pool-test:1' }, expect.objectContaining({ onOutput: expect.any(Function) }));
      expect(process.exitCode).toBe(0);
    } finally {
      dispatch.mockRestore();
      log.mockRestore();
      process.exitCode = previousExit;
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
      expect(dispatch.mock.calls[1]?.[0]).toEqual({ entrance: 'cli-harness-say', input: 'write goal', podPool: 'pool-test:1' });
      expect(dispatch.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ onOutput: expect.any(Function) }));
      expect(process.exitCode).toBe(0);
    } finally {
      dispatch.mockRestore();
      process.exitCode = exit;
      rmSync(goal, { force: true });
    }
  });

  test('real harness ask/say entrances forward the pool to self orchestration; N=2 holds a third kubectl Job apply', async () => {
    const goal = join(tmpdir(), `pod-admission-${crypto.randomUUID()}.md`);
    writeFileSync(goal, 'First distinct goal');
    const pool = new PodPoolScheduler(parsePodPool('fake:3'), { status: () => ({
      recommended: 2, accountSlots: 99, limitedBy: 'capacity', reason: null,
      capacitySlots: 3, memorySlots: 3, placeableSlots: 3, running: 0, pending: 0,
    }), pollMs: 2 });
    const applied: string[] = [];
    const completed = new Set<string>();
    const kubectl: Kubectl = (args, input) => {
      if (args.includes('apply') && input) {
        const object = JSON.parse(input) as { kind: string; metadata: { name: string } };
        if (object.kind === 'Job') applied.push(object.metadata.name);
      }
      if (args.some((arg) => arg.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
      if (args.includes('job') && args.includes('jsonpath={.status.conditions[*].type}')) {
        return { status: 0, stdout: completed.has(args[args.indexOf('job') + 1]!) ? 'Complete' : '', stderr: '' };
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
      await program.parseAsync(['node', 'elanous', 'harness', 'say', 'Second distinct goal', '--substrate', 'pod', '--pod-pool', 'fake:3']);
      expect(forwarded).toEqual(['fake:3', 'fake:3']);
      expect(receivedGoals).toEqual(['First distinct goal', 'Second distinct goal']);
      const third = runSelfOrchestrateCliCommand({
        goals: [{ feature: 'Third distinct goal' }], concurrency: 1, runtime: { spawn: (input) => {
          const job = spawn({ ...input, signal: controllers[2]!.signal });
          jobs.push(job);
          return job;
        } },
      });
      await waitUntil(() => applied.length === 2 && pool.admissionSnapshot().queued === 1);
      expect(applied[0]).toContain('goal-0');
      expect(applied[1]).toContain('goal-1');
      expect(pool.admissionSnapshot()).toMatchObject({ active: 2, queued: 1 });
      await Bun.sleep(10);
      expect(applied).toHaveLength(2);
      completed.add(applied[0]!);
      await jobs[0]!.done;
      await waitUntil(() => applied.length === 3);
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
      process.exitCode = previousExit;
      rmSync(goal, { force: true });
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
      expect(dispatch.mock.calls[0]?.[0]).toEqual({ entrance: 'cli-harness-ask', input: missing, podPool: 'pool-test:1' });
      expect(process.exitCode).toBe(0);
    } finally {
      dispatch.mockRestore();
      process.exitCode = exit;
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
      process.exitCode = previousExit;
      if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousState;
      rmSync(root, { recursive: true, force: true });
    }
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
    } finally { dispatch.mockRestore(); process.exitCode = previousExit; }
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
      const { runHarnessPlanRfc } = await import('./harness-plan-rfc.js');
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
        process.exitCode = previousExit;
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

test('draft sweep gh calls pass env: process.env (cron minimal PATH — Bun resolves against the startup PATH otherwise)', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(import.meta.dir, 'harness-cli-command.ts'), 'utf8') as string;
  const calls = [...source.matchAll(/execFileSync\('gh',[\s\S]*?\)\s*[;.)]/g)].map((m) => m[0]);
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.filter((call) => !call.includes('env: process.env'))).toEqual([]);
});


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
