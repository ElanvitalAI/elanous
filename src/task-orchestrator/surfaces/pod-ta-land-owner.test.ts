/**
 * TA-LIVE-LAND-2 — `tasks hand --ta-land` marks a run (`ELANOUS_TA_LAND=1`). With `taskAgent.liveMoves` ∋ propose-land the
 * launching host re-gates a merge-ready Pod PR but does not merge; the PR stays OPEN non-draft for the task agent's
 * `executeLiveLand` → `pr land --expected-head`. Runs without the marker, or without propose-land, merge exactly as before.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../../debug/log.js';
import { podSelfImplementSpawn, type Kubectl } from './self-implement-pod.js';
import { recordTaskAgentShadowMove } from '../../task-agent/shadow.js';
import type { TaskCard } from '../../task-agent/task-hand.js';

/** The marker name is the contract TC launches with — spelled out so the test does not depend on the export. */
const TA_LAND_ENV = 'ELANOUS_TA_LAND';
import { superviseRun, type SupervisorJobResult } from '../../self-dev/run-supervisor.js';
import { orchestrateSelfDev } from '../../self-dev/orchestrate.js';
import type { HostRegateResult } from '../../self-implement/host-regate.js';

const CREDS = () => ({ elanousAuth: '{"m":1}', codexAuth: '{"c":1}', ghToken: 'gho_x' });
const HEAD = 'a'.repeat(40);
const MERGE_READY = JSON.stringify({ stage: 'merge-ready', ok: true, prUrl: 'https://github.com/o/r/pull/9', prNumber: 9, checkedHeadCommit: HEAD,
  review: { reviewed: true, verdict: 'pass', mustFix: [] }, reviewedHeadCommit: HEAD });

function fakeKubectl(logs: string): Kubectl {
  return (args) => {
    if (args.includes('current-context')) return { status: 0, stdout: 'test-context\n', stderr: '' };
    if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
    if (args.some((a) => a.includes('conditions[?(@.type=="Failed")].reason'))) return { status: 0, stdout: '', stderr: '' };
    if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Complete', stderr: '' };
    if (args.includes('logs')) return { status: 0, stdout: `${logs}\n`, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
}

type RegateRequest = { prNumber: number; headCommit: string; repoRoot: string; goalFile?: string; noMerge?: true };

async function run(opts: { env?: NodeJS.ProcessEnv; moves?: readonly string[]; movesThrow?: boolean; regate?: (r: RegateRequest) => Promise<HostRegateResult> }) {
  const received: RegateRequest[] = [];
  const events: Array<[string, Record<string, unknown>]> = [];
  const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
    if (category === 'self-implement.pod') events.push([event, data ?? {}]);
  }) as typeof debug.log);
  try {
    const r = await podSelfImplementSpawn({
      kubectl: fakeKubectl(MERGE_READY), sleep: async () => {}, credentials: CREDS,
      env: { ...process.env, ...(opts.env ?? {}) },
      taskAgentLiveMoves: () => { if (opts.movesThrow) throw new Error('config unreadable'); return new Set(opts.moves ?? []); },
      hostRegate: async (request) => { received.push(request); return (opts.regate ?? (async () => ({ passed: true, failures: [], os: process.platform })))(request); },
    })({ feature: 'ta land', spaceId: 'pod-ta-land', autoMerge: true }).done;
    return { r, received, events };
  } finally { spy.mockRestore(); }
}

describe('TA-LIVE-LAND-2 — Pod host leaves the merge to the task agent only on opt-in', () => {
  test('marker ⊕ propose-land: host re-gates with noMerge and leaves the PR open (pr-opened · ta-land-owner)', async () => {
    const { r, received, events } = await run({ env: { [TA_LAND_ENV]: '1' }, moves: ['propose-land'] });
    expect(received).toEqual([{ prNumber: 9, headCommit: HEAD, repoRoot: expect.any(String), noMerge: true }]);
    expect(r.disposition).toMatchObject({ stage: 'pr-opened', merged: false, ok: true, mergeReason: 'ta-land-owner', prNumber: 9, checkedHeadCommit: HEAD,
      selfReview: { verdict: 'pass', head: HEAD }, hostRegate: { passed: true } });
    expect(r.exitCode).toBe(0);
    expect(events).toContainEqual(['ta-land-owner', expect.objectContaining({ pr: 9, head: HEAD, regatePassed: true })]);
  });

  test('no marker: host merges exactly as today (no noMerge)', async () => {
    const { r, received, events } = await run({ moves: ['propose-land'], env: { [TA_LAND_ENV]: '' } });
    expect(received).toEqual([{ prNumber: 9, headCommit: HEAD, repoRoot: expect.any(String) }]);
    expect(r.disposition).toMatchObject({ stage: 'merged', merged: true });
    expect(events.some(([event]) => event.startsWith('ta-land'))).toBe(false);
  });

  test('marker without propose-land configured: marker ignored, host merges as today', async () => {
    const { r, received, events } = await run({ env: { [TA_LAND_ENV]: '1' }, moves: ['review'] });
    expect(received).toEqual([{ prNumber: 9, headCommit: HEAD, repoRoot: expect.any(String) }]);
    expect(r.disposition).toMatchObject({ stage: 'merged', merged: true });
    expect(events).toContainEqual(['ta-land-marker-ignored', expect.objectContaining({ pr: 9, reason: 'propose-land-not-enabled' })]);
  });

  test('marker but taskAgent.liveMoves unreadable: merge as today and say why (distinct from not configured)', async () => {
    const { r, received, events } = await run({ env: { [TA_LAND_ENV]: '1' }, movesThrow: true });
    expect(received).toEqual([{ prNumber: 9, headCommit: HEAD, repoRoot: expect.any(String) }]);
    expect(r.disposition).toMatchObject({ stage: 'merged', merged: true });
    expect(events).toContainEqual(['ta-land-marker-ignored', expect.objectContaining({ pr: 9, reason: 'live-moves-unreadable', error: 'config unreadable' })]);
  });

  test('marker ⊕ propose-land but re-gate fails: same failure path as today', async () => {
    const { r } = await run({ env: { [TA_LAND_ENV]: '1' }, moves: ['propose-land'],
      regate: async () => ({ passed: false, failures: [{ step: 'test-interference', detail: 'combined fail' }], os: process.platform }) });
    expect(r.disposition).toMatchObject({ stage: 'host-regate-failed', merged: false, ok: false });
    expect(r.disposition?.mergeReason).toBeUndefined();
    expect(r.exitCode).toBe(1);
  });

  test('real runHostRegate with noMerge runs the gates but never calls gh pr merge', async () => {
    const { runHostRegate } = await import('../../self-implement/host-regate.js');
    const base = 'c'.repeat(40);
    const calls: string[] = [];
    const deps = {
      command: (bin: string, args: readonly string[]) => {
        const call = `${bin} ${args.join(' ')}`; calls.push(call);
        if (call === 'gh pr view 9 --json headRefOid,baseRefName,baseRefOid,state,isDraft') return { status: 0, stdout: JSON.stringify({ headRefOid: HEAD, baseRefName: 'main', baseRefOid: base, state: 'OPEN', isDraft: false }), stderr: '' };
        if (call === 'git rev-parse FETCH_HEAD') return { status: 0, stdout: calls.at(-2) === 'git fetch origin refs/heads/main' ? base : HEAD, stderr: '' };
        if (call === 'git rev-parse HEAD' || call === 'git rev-parse HEAD^1') return { status: 0, stdout: base, stderr: '' };
        if (call === 'git rev-parse HEAD^2') return { status: 0, stdout: HEAD, stderr: '' };
        if (call.startsWith('git merge-base')) return { status: 0, stdout: 'b'.repeat(40), stderr: '' };
        if (call.startsWith('git diff --name-only')) return { status: 0, stdout: 'src/x.ts\n', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      },
      makeTemp: () => mkdtempSync(join(tmpdir(), 'pod-ta-land-regate-')), removeTemp: (path: string) => rmSync(path, { recursive: true, force: true }),
      acquire: async () => () => {}, interference: async () => ({ passed: true }), log: () => {},
    };
    const { r } = await run({ env: { [TA_LAND_ENV]: '1' }, moves: ['propose-land'], regate: (request) => runHostRegate(request, deps) });
    expect(calls).toContain('bun scripts/ci-typecheck-changed.ts');
    expect(calls.some((call) => call.startsWith('gh pr merge'))).toBe(false);
    expect(r.disposition).toMatchObject({ stage: 'pr-opened', merged: false, ok: true, mergeReason: 'ta-land-owner', hostRegate: { passed: true, status: 'passed' } });
  });

  test('supervisor stop on the open PR: TA finds the card by the launched run id and lands only via pr land --expected-head', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-ta-land-card-'));
    try {
      const statePath = join(dir, 'task-agent-actions.json');
      const card: TaskCard = { id: 'ta-20261010-abc123', text: 'handed sentence', createdAt: '2026-10-10T00:00:00Z', status: 'launched', history: [], runId: 'run-parent-1', taLand: true };
      writeFileSync(statePath, JSON.stringify({ tasks: { [card.id]: card } }));
      // Pod result: orchestrator task id, authored feature (≠ card text), child run id (≠ card runId), no worktree.
      const result = { taskId: 'task-1', feature: 'authored goal text', status: 'done', stage: 'pr-opened', ok: true, merged: false, prNumber: 9,
        prUrl: 'https://github.com/o/r/pull/9', checkedHeadCommit: HEAD, mergeReason: 'ta-land-owner', runId: 'run-child-1',
        selfReview: { verdict: 'pass', head: HEAD, mustFixCount: 0 } } as unknown as SupervisorJobResult;
      const landed: Array<[number, string, string]> = [];
      const move = await recordTaskAgentShadowMove({ runId: 'run-child-1', stopReason: 'needs-human', results: [result], selfReview: { verdict: 'pass', head: HEAD, mustFixCount: 0 }, cycleId: 'run-child-1:ta-land-2' }, {
        log: () => {}, env: { ELANOUS_RUN_ID: 'run-parent-1' }, liveMoves: new Set(['propose-land']),
        live: {
          statePath, log: () => {},
          repoCandidates: () => [{ source: 'host', cwd: dir }],
          prHead: async () => ({ head: HEAD, state: 'OPEN', url: 'https://github.com/o/r/pull/9' }),
          landPrHead: async () => ({ head: HEAD, state: 'OPEN', isDraft: false, url: 'https://github.com/o/r/pull/9' }),
          land: async (pr, head, cwd) => { landed.push([pr, head, cwd]); return { status: 0, stdout: 'merged' }; },
        },
      });
      expect(move.move).toBe('propose-land');
      expect(move.liveMove).toMatchObject({ kind: 'land', card: card.id, ok: true, executed: true });
      expect(landed).toEqual([[9, HEAD, dir]]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('end to end: Pod result → orchestrator results → real supervisor stop → TA spawns `pr land --expected-head` for that PR/head', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-ta-land-e2e-'));
    const statePath = join(dir, 'task-agent-actions.json');
    const card: TaskCard = { id: 'ta-20261010-e2e001', text: 'handed sentence', createdAt: '2026-10-10T00:00:00Z', status: 'launched', history: [], runId: 'run-parent-e2e', taLand: true };
    writeFileSync(statePath, JSON.stringify({ tasks: { [card.id]: card } }));
    const originalSpawn = childProcess.spawn;
    const originalSpawnSync = childProcess.spawnSync;
    const spawned: string[][] = [];
    const spawnSpy = spyOn(childProcess, 'spawn').mockImplementation(((command: string, args: readonly string[], options: unknown) => {
      if (!args.includes('land')) return (originalSpawn as (...a: unknown[]) => unknown)(command, args, options);
      spawned.push([...args]);
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
      setTimeout(() => child.emit('close', 0), 0);
      return child;
    }) as unknown as typeof childProcess.spawn);
    const spawnSyncSpy = spyOn(childProcess, 'spawnSync').mockImplementation(((command: string, args: readonly string[], options: unknown) => {
      if (command !== 'gh') return (originalSpawnSync as (...a: unknown[]) => unknown)(command, args, options);
      return { status: 0, stdout: JSON.stringify({ headRefOid: HEAD, headRefName: 'self-impl/x', state: 'MERGED', url: 'https://github.com/o/r/pull/9', isDraft: false }), stderr: '', output: [], pid: 0, signal: null };
    }) as unknown as typeof childProcess.spawnSync);
    try {
      const spawn = podSelfImplementSpawn({
        kubectl: fakeKubectl(MERGE_READY), sleep: async () => {}, credentials: CREDS,
        env: { ...process.env, [TA_LAND_ENV]: '1' }, taskAgentLiveMoves: () => new Set(['propose-land']),
        hostRegate: async (request) => {
          expect(request.noMerge).toBe(true);
          return { passed: true, failures: [], os: process.platform, status: 'passed' };
        },
      });
      const initial = await orchestrateSelfDev({ goals: [{ feature: 'authored goal text', autoMerge: true } as never], concurrency: 1, spawn,
        readScreenTranscript: () => null, readScreenTail: () => null });
      expect(initial).toHaveLength(1);
      expect(initial[0]).toMatchObject({ status: 'done', stage: 'pr-opened', merged: false, prNumber: 9, mergeReason: 'ta-land-owner', selfReview: { verdict: 'pass', head: HEAD } });
      const moves: unknown[] = [];
      await superviseRun({
        initial, rerun: async (previous) => previous, runStore: { dir },
        taskAgentShadow: async (input) => {
          moves.push(await recordTaskAgentShadowMove(input, {
            log: () => {}, env: { ELANOUS_RUN_ID: 'run-parent-e2e' }, liveMoves: new Set(['propose-land']),
            live: {
              statePath, log: () => {},
              repoCandidates: () => [{ source: 'host', cwd: dir }],
              prHead: async () => ({ head: HEAD, state: 'OPEN', url: 'https://github.com/o/r/pull/9' }),
              landPrHead: async () => ({ head: HEAD, state: 'OPEN', isDraft: false, url: 'https://github.com/o/r/pull/9' }),
            },
          }));
        },
      });
      expect(moves).toHaveLength(1);
      expect(moves[0]).toMatchObject({ stopReason: 'needs-human', move: 'propose-land', liveMove: { kind: 'land', card: card.id, ok: true, executed: true } });
      expect(spawned).toHaveLength(1);
      const argv = spawned[0]!;
      expect(argv.slice(argv.indexOf('pr'))).toEqual(['pr', 'land', '--cwd', dir, '--pr', '9', '--expected-head', HEAD]);
    } finally {
      spawnSpy.mockRestore();
      spawnSyncSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
