import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as yaml } from 'yaml';
import { decideGraphApproval, runGraph as runGraphActual, type GraphRunOptions, type GraphRunState } from '../../src/graph-runner/runner.js';
import { collectGraphEvents } from '../../src/graph-runner/graph-notify.js';
import { runPrLand as realRunPrLand } from '../../src/cli/pr-cli.js';
import { ClaimsLedger } from '../../src/claims/claims-ledger.js';
import { addItem, setItem } from '../../src/release-loop/checklist.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../../src/elanous-config-dir.js';
import { makePrManager, type CmdRunner } from '../../src/autopilot/pr-manager.js';
import { publicNotes, runPublish as realRunPublish } from './publish-node.js';
import { runPrepare } from './prepare-node.js';
import { runUpgrade } from './upgrade-node.js';
import { runDocsLand } from './docs-land-node.js';
import { runVerify } from './verify-node.js';
import { runAutoApprove } from './auto-approve-node.js';
import { classifyGateShadow } from './gate-triage-node.js';
import { runVaultNote } from './vault-note-node.js';
import type { GraphContext } from './node-verdict.js';
import { afterEach as freezeIsolationAfterEach, beforeEach as freezeIsolationBeforeEach } from 'bun:test';
import { rmSync as freezeIsolationRm } from 'node:fs';
import { resetEffectiveInstanceRoot as freezeIsolationReset } from '../../src/instance/resolve.js';
import { simCli } from '../../src/ux-sim/in-process-cli.js';

// Both freeze authorities are isolated for merge and publish fixtures: the operational root (injected or
// subprocess HOME) and the local universe (ELANOUS_STATE_DIR). Never read or write the real ~/.elanous.
let isolatedFreezeRoot = '';
let isolatedStateDirForFreeze = '';
let savedStateDirForFreeze: string | undefined;
freezeIsolationBeforeEach(() => {
  isolatedFreezeRoot = mkdtempSync(join(tmpdir(), 'pr-land-freeze-'));
  isolatedStateDirForFreeze = mkdtempSync(join(tmpdir(), 'pr-land-state-'));
  savedStateDirForFreeze = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = isolatedStateDirForFreeze;
  freezeIsolationReset();
});
freezeIsolationAfterEach(() => {
  if (savedStateDirForFreeze === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = savedStateDirForFreeze;
  freezeIsolationReset();
  freezeIsolationRm(isolatedFreezeRoot, { recursive: true, force: true });
  freezeIsolationRm(isolatedStateDirForFreeze, { recursive: true, force: true });
});
const runPrLand: typeof realRunPrLand = (opts = {}, deps = {}) => realRunPrLand(opts, { prodFreezeRoot: isolatedFreezeRoot, ...deps });
const runPublish: typeof realRunPublish = (run, prodFreezeRoot, clock, approvalRoot) =>
  realRunPublish(run, prodFreezeRoot ?? isolatedFreezeRoot, clock, approvalRoot);
function recordApprovalFixture() {
  const runId = 'fixture-run';
  const decidedAt = '2026-10-19T00:00:00.000Z';
  const approval = { outcome: 'approved', graphId: 'release-loop', runId, nodeId: 'approve-publish', decidedAt };
  const dir = join(isolatedStateDirForFreeze, 'graph-runs', 'release-loop');
  const file = join(dir, `${runId}.json`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ graphId: 'release-loop', runId, path: ['auto-approve', 'approve-publish', 'publish'],
    nodes: [{ nodeId: 'approve-publish', ok: true, decidedAt, output: JSON.stringify(approval) }] }));
  writeFileSync(`${file}.2.decision.json`, JSON.stringify({ nodeId: 'approve-publish', decision: 'approved', decidedAt }));
  return approval;
}

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

// Historical release fixtures exercise the audited route explicitly. The production default is legacy.
const runGraph: typeof runGraphActual = (path, options = {}) => {
  if (!path.startsWith(join(import.meta.dir, '../..', 'graphs', 'release')) || options.dryRun) return runGraphActual(path, options);
  const runBash = options.deps?.runBash;
  return runGraphActual(path, { ...options,
    ...(options.input && typeof options.input === 'object' && !Array.isArray(options.input)
      ? { input: { cutSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', candidatePath: 'fixture:release-graph', ...options.input,
        graphCutover: 'audit', graphCutoverEvidenceId: 'test-hard-rehearsal-and-shadow' } } : {}),
    ...(runBash ? { deps: { ...options.deps, runBash: async (command, args) => {
      const contextPath = args.env?.ELANOUS_GRAPH_CONTEXT;
      let context: { graphId?: string; nodeId?: string } | undefined;
      if (contextPath) {
        context = JSON.parse(readFileSync(contextPath, 'utf8')) as { graphId?: string; nodeId?: string };
        if (context.graphId === 'pod-reuse-prep' && context.nodeId === 'pending')
          return { exitCode: 0, stdout: JSON.stringify({ outcome: 'legacy', verdict: 'legacy', reason: 'prep-body-pending', receiptPath: '' }), stderr: '' };
      }
      if (command.includes('gate-cutover-switch-node.ts')) return Promise.resolve(spawnSync('/bin/bash', ['-c', command], {
        cwd: join(import.meta.dir, '../..'), env: { ...process.env, ...args.env }, encoding: 'utf8',
      })).then(result => ({ exitCode: result.status ?? 2, stdout: result.stdout, stderr: result.stderr }));
      const result = await runBash(command, args);
      // Source: release cutoff records the pinned cutoff SHA; older graph fixtures omitted this production field.
      if (context?.graphId === 'release-loop' && context.nodeId === 'cutoff' && result.exitCode === 0) {
        try {
          const output = JSON.parse(result.stdout) as Record<string, unknown>;
          if (!output.cutoff || typeof output.cutoff !== 'object') output.cutoff = { sha: 'a'.repeat(40) };
          return { ...result, stdout: JSON.stringify(output) };
        } catch { /* Preserve malformed fixture output so the graph still fails closed. */ }
      }
      return result;
    } } } : {}),
  });
};

test('release graph CLI dry-run previews automatic route without executing commands', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-cli-dry-run-'));
  try {
    const run = await simCli(['graph', 'run', 'graphs/release/release-loop.yaml', '--dry-run', '--json', '--input', '{"version":"9.9.9","previousVersion":"0.2.3"}'], {
      mode: 'spawn', allowPaths: [['graph', 'run']], stateRoot: root, cwd: join(import.meta.dir, '../..'), env: { NODE_ENV: 'test' },
    });
    expect(run.exitCode).toBe(0);
    const output = JSON.parse(run.stdout.trim().split('\n').at(-1)!) as { status: string; path: string[]; plannedPath?: string[]; executed: number; pending?: { nodeId: string; message: string } };
    expect(output.status).toBe('done');
    expect(output.path).toEqual(['version-release', 'readiness-countdown', 'traffic-cut-start', 'cutoff', 'pre-gate-join', 'cloud-approval-check', 'cloud-join', 'pod-reuse-prep', 'gate', 'cloud-leave-ok', 'gate-cutover-switch', 'traffic-gate-passed', 'pre-prepare-join', 'prepare', 'upgrade', 'tui', 'docs', 'known-issues', 'notes-check', 'auto-approve', 'publish', 'npm-publish', 'traffic-npm-published', 'release-post-publish-join', 'verify', 'traffic-verify-complete', 'pwa-formal-update', 'vault-note', 'release-story', 'ops-upgrade', 'done']);
    expect(output.plannedPath).toEqual(['version-release', 'readiness-countdown', 'traffic-cut-start', 'cutoff', 'checklist-gate', 'regression-suite', 'prefetch', 'pre-gate-join', 'cloud-approval-check', 'cloud-join', 'pod-reuse-prep', 'gate', 'cloud-leave-ok', 'gate-cutover-switch', 'traffic-gate-passed', 'export-check', 'pwa', 'mac-smoke', 'pre-prepare-join', 'prepare', 'upgrade', 'tui', 'docs', 'known-issues', 'notes-check', 'auto-approve', 'publish', 'npm-publish', 'traffic-npm-published', 'docs-land', 'version-dev-bump', 'release-post-publish-join', 'verify', 'traffic-verify-complete', 'pwa-formal-update', 'vault-note', 'release-story', 'ops-upgrade', 'done']);
    expect(output.pending).toBeUndefined();
    expect(output.executed).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('graph dry-run previews automatic path without executing commands', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-graph-'));
  try {
    const state = await runGraph(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), {
      input: { version: '9.9.9', previousVersion: '0.2.3' }, deps: { root, runBash: async () => { throw new Error('dry-run executed command'); } }, dryRun: true,
    });
    expect(state.status).toBe('done');
    expect(state.path).toEqual(['version-release', 'readiness-countdown', 'traffic-cut-start', 'cutoff', 'pre-gate-join', 'cloud-approval-check', 'cloud-join', 'pod-reuse-prep', 'gate', 'cloud-leave-ok', 'gate-cutover-switch', 'traffic-gate-passed', 'pre-prepare-join', 'prepare', 'upgrade', 'tui', 'docs', 'known-issues', 'notes-check', 'auto-approve', 'publish', 'npm-publish', 'traffic-npm-published', 'release-post-publish-join', 'verify', 'traffic-verify-complete', 'pwa-formal-update', 'vault-note', 'release-story', 'ops-upgrade', 'done']);
    expect(state.plannedPath).toEqual(['version-release', 'readiness-countdown', 'traffic-cut-start', 'cutoff', 'checklist-gate', 'regression-suite', 'prefetch', 'pre-gate-join', 'cloud-approval-check', 'cloud-join', 'pod-reuse-prep', 'gate', 'cloud-leave-ok', 'gate-cutover-switch', 'traffic-gate-passed', 'export-check', 'pwa', 'mac-smoke', 'pre-prepare-join', 'prepare', 'upgrade', 'tui', 'docs', 'known-issues', 'notes-check', 'auto-approve', 'publish', 'npm-publish', 'traffic-npm-published', 'docs-land', 'version-dev-bump', 'release-post-publish-join', 'verify', 'traffic-verify-complete', 'pwa-formal-update', 'vault-note', 'release-story', 'ops-upgrade', 'done']);
    expect(state.pending).toBeUndefined();
    expect(state.executed).toBe(0);
    expect(state.nodes.every((node) => !node.executed)).toBe(true);
    expect(JSON.parse(readFileSync(state.statePath, 'utf8')).plannedPath).toEqual(state.plannedPath);
    const graph = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), 'utf8')) as { edges: Array<{ from: string; map?: Record<string, string> }> };
    expect(graph.edges.filter((e) => Object.values(e.map ?? {}).includes('publish')).map((e) => e.from)).toEqual(['auto-approve', 'approve-publish']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function elapsedSeconds(startedAt: string | undefined, endedAt: string | undefined): number | null {
  const start = Date.parse(startedAt ?? '');
  const end = Date.parse(endedAt ?? '');
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? (end - start) / 1000 : null;
}

function releaseDurations(state: GraphRunState): { totalSeconds: number | null; gateToPublishSeconds: number | null } {
  const gate = state.nodes.find((node) => node.nodeId === 'gate');
  const publish = state.nodes.find((node) => node.nodeId === 'publish');
  return { totalSeconds: elapsedSeconds(state.startedAt, state.finishedAt),
    gateToPublishSeconds: elapsedSeconds(gate?.endedAt, publish?.startedAt) };
}

test('serial release baseline: RFC #24935 recorded figures (not a live measurement) vs projected savings, and graph boundaries', () => {
  // #24935 measured one 0.2.19 ledger: gate end → publish start ≈663s (11.1m).
  // A1's ≈646s (10.8m) is a projection, not a measured reduction; post-change runs measured: 0.
  const rfc = { measuredPostGateSeconds: 663, projectedA1SavingsSeconds: 646, measuredA1Runs: 0 };
  expect(rfc.measuredPostGateSeconds / 60).toBeCloseTo(11.1, 1);
  expect(rfc.projectedA1SavingsSeconds / 60).toBeCloseTo(10.8, 1);
  expect(rfc.measuredA1Runs).toBe(0);
  expect(rfc.measuredPostGateSeconds - rfc.projectedA1SavingsSeconds).toBe(17);
  expect(releaseDurations({ startedAt: '2026-10-08T00:00:00Z', finishedAt: '2026-10-08T01:15:00Z',
    nodes: [{ nodeId: 'gate', endedAt: '2026-10-08T00:00:00Z' },
      { nodeId: 'publish', startedAt: '2026-10-08T00:11:03Z' }] } as GraphRunState)).toEqual({ totalSeconds: 4500, gateToPublishSeconds: 663 });
  expect(releaseDurations({ nodes: [{ nodeId: 'gate' }, { nodeId: 'publish' }] } as GraphRunState)).toEqual({ totalSeconds: null, gateToPublishSeconds: null });
  const graph = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), 'utf8')) as {
    nodes: Array<{ node_id: string; recipe?: string; needs?: string[]; call?: string }>;
    edges: Array<{ from: string; map?: Record<string, string>; branches?: Record<string, string[]>; join?: string; warning_branches?: string[] }>;
  };
  expect(graph.nodes.find((node) => node.node_id === 'prefetch')?.recipe).toBe('cmd:docs');
  expect(graph.nodes.find((node) => node.node_id === 'tui')?.recipe).toBe('cmd:docs');
  expect(graph.nodes.find((node) => node.node_id === 'docs')?.recipe).toBe('cmd:docs');
  const next = (from: string) => {
    const edge = graph.edges.find((candidate) => candidate.from === from);
    return edge?.map?.ok ?? null;
  };
  // The historical RFC figures remain a serial measurement; current concurrency is declared on join-node needs.
  expect(next('traffic-gate-passed')).toBeNull();
  expect(['gate', 'gate-cutover-switch', 'receipt-audit', 'pre-gate-join', 'cloud-approval-check', 'cloud-join', 'cloud-leave-ok', 'cloud-leave-fail', 'pre-prepare-join', 'prepare', 'upgrade', 'tui', 'docs', 'known-issues', 'notes-check', 'auto-approve']
    .map(next)).toEqual(['cloud-leave-ok', null, 'traffic-gate-passed', 'cloud-approval-check', 'cloud-join', 'pod-reuse-prep', 'gate-cutover-switch', 'emergency-switch', 'prepare', 'upgrade', 'tui', 'docs', 'known-issues', 'notes-check', 'auto-approve', 'publish']);
  expect(graph.edges.find((edge) => edge.from === 'cutoff')).toMatchObject({ warning_branches: ['prefetch'] });
  expect(graph.nodes.find((node) => node.node_id === 'checklist-gate')?.needs).toEqual(['cutoff']);
  expect(graph.nodes.find((node) => node.node_id === 'prefetch')?.needs).toEqual(['cutoff']);
  expect(graph.nodes.find((node) => node.node_id === 'export-check')?.needs).toEqual(['traffic-gate-passed']);
  expect(graph.nodes.find((node) => node.node_id === 'regression-suite')?.needs).toEqual(['cutoff']);
  expect(graph.nodes.find((node) => node.node_id === 'pre-gate-join')?.needs).toEqual(['checklist-gate', 'regression-suite', 'prefetch']);
  expect(graph.edges.find((edge) => edge.from === 'pre-gate-join')?.map).toEqual({ ok: 'cloud-approval-check', fail: 'traffic-failed-restore', error: 'traffic-failed-restore' });
  expect(graph.nodes.find((node) => node.node_id === 'pod-reuse-prep')?.call).toBe('pod-reuse-prep@1');
  expect(graph.edges.find((edge) => edge.from === 'cloud-join')?.map).toEqual({ ok: 'pod-reuse-prep', fail: 'cloud-leave-join-fail', error: 'cloud-leave-join-fail' });
  expect(graph.edges.find((edge) => edge.from === 'pod-reuse-prep')?.map).toEqual({ reuse: 'gate', legacy: 'gate', skip: 'gate', failed: 'gate', error: 'gate' });
  expect(graph.edges.find((edge) => edge.from === 'gate')?.map).toEqual({ ok: 'cloud-leave-ok', waived: 'receipt-audit', fail: 'cloud-leave-fail', error: 'cloud-leave-error' });
  expect(graph.nodes.find((node) => node.node_id === 'emergency-switch')).toMatchObject({ kind: 'judge', recipe: 'cmd:emergency-switch' });
  expect(graph.nodes.find((node) => node.node_id === 'emergency-gate')).toMatchObject({ kind: 'gate', recipe: 'cmd:emergency-gate' });
  expect(graph.edges.find((edge) => edge.from === 'emergency-switch')?.map).toMatchObject({ switch: 'emergency-gate', 'stay-normal': 'gate-triage' });
  expect(graph.edges.find((edge) => edge.from === 'emergency-gate')?.map).toEqual({ ok: 'traffic-gate-passed', fail: 'traffic-failed-restore', error: 'traffic-failed-restore' });
  expect(graph.edges.find((edge) => edge.from === 'receipt-audit')?.map).toEqual({ ok: 'traffic-gate-passed', fail: 'residual-run', error: 'traffic-failed-restore' });
  expect(graph.edges.find((edge) => edge.from === 'residual-run')?.map).toEqual({ ok: 'receipt-audit-recheck', fail: 'emergency-switch', error: 'gate-triage' });
  expect(graph.edges.find((edge) => edge.from === 'gate-heal-decision')?.map)
    .toEqual({ ok: 'gate-same-run-recheck', 'waived-known-issue': 'traffic-gate-passed', fail: 'traffic-failed-restore', error: 'traffic-failed-restore' });
  expect(graph.edges.find((edge) => edge.from === 'gate-same-run-recheck')?.map)
    .toEqual({ ok: 'gate', fail: 'traffic-failed-restore', error: 'traffic-failed-restore' });
  expect(graph.edges.find((edge) => edge.from === 'traffic-gate-passed')).toMatchObject({
    warning_branches: ['mac-smoke'],
  });
  expect(graph.nodes.find((node) => node.node_id === 'pre-prepare-join')?.needs).toEqual(['mac-smoke', 'pwa', 'export-check']);
  expect(graph.edges.find((edge) => edge.from === 'pre-prepare-join')?.map).toEqual({ ok: 'prepare', fail: 'traffic-failed-restore', error: 'traffic-failed-restore' });
  expect(graph.edges.find((edge) => edge.from === 'tui')?.map).toEqual({ ok: 'docs', fail: 'traffic-failed-restore', error: 'traffic-failed-restore' });
  expect(graph.edges.find((edge) => edge.from === 'docs')?.map).toEqual({ ok: 'known-issues', fail: 'traffic-failed-restore', error: 'traffic-failed-restore' });
  expect(graph.edges.find((edge) => edge.from === 'auto-approve')?.map).toEqual({ ok: 'publish', fail: 'approve-publish', error: 'approve-publish' });
  expect(graph.edges.find((edge) => edge.from === 'approve-publish')?.map).toEqual({ ok: 'publish', fail: 'traffic-failed-restore' });
  expect(graph.edges.find((edge) => edge.from === 'publish')?.map).toEqual({ ok: 'npm-publish', partial: 'approve-continue', unknown: 'approve-continue', fail: 'approve-continue', error: 'approve-continue' });
});

test('cutoff routes through checklist-gate before the costly gate', () => {
  const graph = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), 'utf8')) as {
    nodes: Array<{ node_id: string; kind: string; recipe?: string; max_visits: number; needs?: string[] }>;
    edges: Array<{ from: string; map: Record<string, string>; branches?: Record<string, string[]>; warning_branches?: string[] }>;
  };
  const recipes = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/recipes.yaml'), 'utf8')) as Record<string, { command?: string; timeout_ms?: number }>;
  expect(graph.nodes.find((node) => node.node_id === 'checklist-gate')).toMatchObject({ kind: 'gate', recipe: 'cmd:checklist-gate', max_visits: 1 });
  expect(graph.edges.find((edge) => edge.from === 'cutoff')?.map).toEqual({ fail: 'traffic-failed-restore', error: 'traffic-failed-restore' });
  expect(graph.edges.find((edge) => edge.from === 'export-check')).toBeUndefined();
  expect(graph.nodes.find((node) => node.node_id === 'regression-suite')?.needs).toEqual(['cutoff']);
  expect(graph.nodes.find((node) => node.node_id === 'pre-gate-join')?.needs).toEqual(['checklist-gate', 'regression-suite', 'prefetch']);
  expect(graph.edges.find((edge) => edge.from === 'checklist-gate')).toBeUndefined();
  expect(recipes['checklist-gate']).toEqual({ command: 'bun scripts/release-loop/checklist-gate-node.ts', timeout_ms: 600000 });
  expect(graph.nodes.find((node) => node.node_id === 'gate-same-run-recheck')).toMatchObject({ kind: 'gate', recipe: 'cmd:gate-same-run-recheck', max_visits: 1 });
  expect(recipes['gate-same-run-recheck']).toEqual({ command: 'bun scripts/release-loop/gate-same-run-recheck-node.ts', timeout_ms: 600000 });
  // source: #35950 - M2.1 visit bounds derive from receipt-audit to residual-run to re-audit paths; gate permits repair/recheck returns.
  expect(graph.nodes.find((node) => node.node_id === 'receipt-audit')).toMatchObject({ kind: 'gate', recipe: 'cmd:receipt-audit', max_visits: 3 });
  // source: #35950 - M2.1 visit bounds derive from receipt-audit to residual-run to re-audit paths; gate permits repair/recheck returns.
  expect(graph.nodes.find((node) => node.node_id === 'residual-run')).toMatchObject({ kind: 'gate', recipe: 'cmd:gate', max_visits: 3 });
  // source: #35950 - M2.1 visit bounds derive from receipt-audit to residual-run to re-audit paths; gate permits repair/recheck returns.
  expect(graph.nodes.find((node) => node.node_id === 'receipt-audit-recheck')).toMatchObject({ kind: 'gate', recipe: 'cmd:receipt-audit', max_visits: 3 });
  // source: #35950 - M2.1 visit bounds derive from receipt-audit to residual-run to re-audit paths; gate permits repair/recheck returns.
  expect(recipes['receipt-audit']).toEqual({ command: 'bun scripts/release-loop/gate-file-receipt-audit-node.ts', timeout_ms: 1_800_000 });
});

test('RELEASE-GRAPH-RECEIPT-AUDIT: missing file receipts run a residual gate and repeat the audit before traffic resumes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-file-receipt-residual-'));
  let audits = 0;
  try {
    const state = await runGraph(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), {
      input: { version: '9.9.9', previousVersion: '0.2.3' }, deps: { root, runBash: async (_body, options) => {
        const nodeId = JSON.parse(readFileSync(options.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')).nodeId as string;
        if (nodeId === 'receipt-audit' && ++audits === 1)
          return { exitCode: 1, stdout: '{"outcome":"fail","verdict":"fail","summary":"missing file receipts"}\n', stderr: '' };
        return { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass","summary":"fixture"}\n', stderr: '' };
      } },
    });
    expect(state.path.slice(0, 14)).toEqual(['version-release', 'readiness-countdown', 'traffic-cut-start', 'cutoff', 'pre-gate-join', 'cloud-approval-check', 'cloud-join', 'pod-reuse-prep', 'gate', 'cloud-leave-ok',
      'gate-cutover-switch', 'receipt-audit', 'residual-run', 'receipt-audit-recheck']);
    expect(state.status).toBe('done');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('RELEASE-GRAPH-FANOUT: checklist gate overlaps prefetch and its failure restores traffic', async () => {
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const nodeTimes = new Map<string, { start: number; end: number }>();
  const run = async (checklistFails: boolean) => {
    const root = mkdtempSync(join(tmpdir(), 'release-checklist-prefetch-fanout-'));
    try {
      const state = await runGraph(graphPath, { input: { version: '9.9.9', previousVersion: '0.2.3' }, deps: { root, runBash: async (_body, options) => {
        const nodeId = JSON.parse(readFileSync(options.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')).nodeId as string;
        const start = performance.now();
        if (nodeId === 'checklist-gate') await Bun.sleep(120);
        if (nodeId === 'prefetch') await Bun.sleep(80);
        const end = performance.now();
        nodeTimes.set(nodeId, { start, end });
        const fail = checklistFails && nodeId === 'checklist-gate';
        return { exitCode: fail ? 1 : 0, stdout: JSON.stringify({ outcome: fail ? 'fail' : 'ok', verdict: fail ? 'fail' : 'pass', summary: 'fixture' }) + '\n', stderr: '' };
      } } });
      return state;
    } finally { rmSync(root, { recursive: true, force: true }); }
  };
  const passed = await run(false);
  const checklist = nodeTimes.get('checklist-gate')!;
  const prefetch = nodeTimes.get('prefetch')!;
  expect(checklist.start).toBeLessThan(prefetch.end);
  expect(prefetch.start).toBeLessThan(checklist.end);
  expect(passed.fanOuts?.['cutoff:ok']?.branches).toMatchObject({
    'checklist-gate': { status: 'done' }, prefetch: { status: 'done' },
  });
  nodeTimes.clear();
  const failed = await run(true);
  expect(failed.path).toEqual(['version-release', 'readiness-countdown', 'traffic-cut-start', 'cutoff', 'pre-gate-join', 'traffic-failed-restore', 'failed']);
  expect(failed.fanOuts?.['cutoff:ok']?.branches['checklist-gate']).toMatchObject({ status: 'failed' });
  expect(failed.path).not.toContain('gate');
}, 15_000);

test('public export check fails after gate and blocks prepare/publish', async () => {
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const graph = yaml(readFileSync(graphPath, 'utf8')) as {
    nodes: Array<{ node_id: string; kind: string; recipe?: string; max_visits: number; needs?: string[] }>;
    edges: Array<{ from: string; map: Record<string, string>; branches?: Record<string, string[]>; warning_branches?: string[] }>;
  };
  const recipes = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/recipes.yaml'), 'utf8')) as Record<string, { command?: string; timeout_ms?: number }>;
  expect(graph.nodes.find((node) => node.node_id === 'export-check')).toMatchObject({ kind: 'gate', recipe: 'cmd:export-check', max_visits: 1 });
  expect(graph.nodes.find((node) => node.node_id === 'mac-smoke')).toMatchObject({ kind: 'gate', recipe: 'cmd:mac-smoke', max_visits: 1 });
  expect(graph.edges.find((edge) => edge.from === 'export-check')).toBeUndefined();
  expect(graph.nodes.find((node) => node.node_id === 'regression-suite')?.needs).toEqual(['cutoff']);
  expect(graph.nodes.find((node) => node.node_id === 'pre-gate-join')?.needs).toEqual(['checklist-gate', 'regression-suite', 'prefetch']);
  expect(graph.edges.find((edge) => edge.from === 'gate')?.map).toEqual({ ok: 'cloud-leave-ok', waived: 'receipt-audit', fail: 'cloud-leave-fail', error: 'cloud-leave-error' });
  expect(recipes['mac-smoke']).toEqual({ command: 'bun scripts/release-loop/mac-smoke-node.ts', timeout_ms: 1_800_000 });
  expect(recipes['export-check']).toEqual({ command: 'bun scripts/release-loop/export-check-node.ts', timeout_ms: 1_800_000 });
  const root = mkdtempSync(join(tmpdir(), 'release-export-failed-'));
  try {
    const state = await runGraph(graphPath, { input: { version: '9.9.9', previousVersion: '0.2.3' }, deps: { root, runBash: async (body) => ({
      exitCode: body.includes('export-check-node.ts') ? 1 : 0,
      stdout: JSON.stringify(body.includes('export-check-node.ts') ? { outcome: 'fail', verdict: 'fail', summary: 'leak', step: 'export', tail: 'leak' } : { outcome: 'ok', verdict: 'pass', summary: 'fake' }) + '\n', stderr: '',
    }) } });
    expect(state.status).toBe('failed');
    expect(state.path).toContain('gate');
    expect(state.path).toContain('pre-prepare-join');
    expect(state.path).not.toContain('prepare');
    expect(state.path).not.toContain('publish');
    expect(state.fanOuts?.['cutoff:ok']?.branches).toMatchObject({ 'checklist-gate': { status: 'done' }, prefetch: { status: 'done' } });
    expect(state.fanOuts?.['traffic-gate-passed:ok']?.branches['export-check']).toMatchObject({ status: 'failed' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('mac-smoke fail and error are warning-only: the graph continues to pwa and publishing', async () => {
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  for (const outcome of ['fail', 'error'] as const) {
    const root = mkdtempSync(join(tmpdir(), 'release-mac-smoke-failed-'));
    try {
      const state = await runGraph(graphPath, { input: { version: '9.9.9', previousVersion: '0.2.3' }, deps: { root, runBash: async (body) => ({
        exitCode: body.includes('mac-smoke-node.ts') ? outcome === 'fail' ? 1 : 2 : 0,
        stdout: JSON.stringify(body.includes('mac-smoke-node.ts') ? { outcome, verdict: 'fail', summary: '측정 불가' } : { outcome: 'ok', verdict: 'pass', summary: 'fake' }) + '\n', stderr: '',
      }) } });
      expect(state.status).toBe('done');
      expect(state.path).toEqual(['version-release', 'readiness-countdown', 'traffic-cut-start', 'cutoff', 'pre-gate-join', 'cloud-approval-check', 'cloud-join', 'pod-reuse-prep', 'gate', 'cloud-leave-ok', 'gate-cutover-switch', 'receipt-audit', 'traffic-gate-passed', 'pre-prepare-join', 'prepare', 'upgrade', 'tui', 'docs', 'known-issues', 'notes-check', 'auto-approve', 'publish', 'npm-publish', 'traffic-npm-published', 'release-post-publish-join', 'verify', 'traffic-verify-complete', 'pwa-formal-update', 'vault-note', 'release-story', 'ops-upgrade', 'done']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('GATE-NODES-PARALLEL: a crashed or failed prefetch node never stops the release — the graph continues to the gate', async () => {
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  for (const outcome of ['fail', 'error'] as const) {
    const root = mkdtempSync(join(tmpdir(), 'release-prefetch-failed-'));
    try {
      const state = await runGraph(graphPath, { input: { version: '9.9.9', previousVersion: '0.2.3' }, deps: { root, runBash: async (body, opts) => {
        const prefetch = body.includes('docs-node.ts') && JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')).nodeId === 'prefetch';
        return prefetch ? { exitCode: outcome === 'fail' ? 1 : 2, stdout: '', stderr: 'worker spawn error' }
          : { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', verdict: 'pass', summary: 'fake' }) + '\n', stderr: '' };
      } } });
      expect(state.path.slice(0, 12)).toEqual(['version-release', 'readiness-countdown', 'traffic-cut-start', 'cutoff', 'pre-gate-join', 'cloud-approval-check', 'cloud-join', 'pod-reuse-prep', 'gate', 'cloud-leave-ok', 'gate-cutover-switch', 'receipt-audit']);
      expect(state.status).toBe('done');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('release notes-check gates approval with a recipe and failure routes', () => {
  const graph = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), 'utf8')) as {
    nodes: Array<{ node_id: string; kind: string; recipe?: string; max_visits: number }>;
    edges: Array<{ from: string; map: Record<string, string> }>;
  };
  const recipes = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/recipes.yaml'), 'utf8')) as Record<string, { command?: string; timeout_ms?: number }>;
  expect(graph.nodes.find((node) => node.node_id === 'notes-check')).toMatchObject({ node_id: 'notes-check', kind: 'gate', recipe: 'cmd:notes-check', max_visits: 1 });
  expect(graph.nodes.find((node) => node.node_id === 'known-issues')).toMatchObject({ kind: 'agent', recipe: 'cmd:known-issues', max_visits: 1 });
  expect(graph.edges.find((edge) => edge.from === 'docs')?.map).toEqual({ ok: 'known-issues', fail: 'traffic-failed-restore', error: 'traffic-failed-restore' });
  expect(graph.edges.find((edge) => edge.from === 'known-issues')?.map).toEqual({ ok: 'notes-check', fail: 'traffic-failed-restore', error: 'traffic-failed-restore' });
  expect(recipes['known-issues']).toEqual({ command: 'bun scripts/release-loop/known-issues-node.ts', timeout_ms: 600000 });
  expect(graph.edges.find((edge) => edge.from === 'notes-check')?.map).toEqual({ ok: 'auto-approve', fail: 'notes-repair', error: 'notes-repair' });
  expect(graph.edges.find((edge) => edge.from === 'notes-repair')?.map).toEqual({ ok: 'notes-recheck', fail: 'traffic-failed-restore', error: 'traffic-failed-restore' });
  expect(graph.edges.find((edge) => edge.from === 'notes-recheck')?.map).toEqual({ ok: 'auto-approve', fail: 'traffic-failed-restore', error: 'traffic-failed-restore' });
  expect(graph.nodes.find((node) => node.node_id === 'notes-repair')).toMatchObject({ kind: 'agent', recipe: 'cmd:docs', max_visits: 1 });
  expect(graph.nodes.find((node) => node.node_id === 'notes-recheck')).toMatchObject({ kind: 'gate', recipe: 'cmd:notes-check', max_visits: 1 });
  expect(graph.nodes.find((node) => node.node_id === 'auto-approve')).toMatchObject({ kind: 'gate', recipe: 'cmd:auto-approve', max_visits: 1 });
  expect(graph.nodes.find((node) => node.node_id === 'approve-publish')).toMatchObject({ kind: 'hitl', recipe: 'approval:publish' });
  expect(graph.edges.find((edge) => edge.from === 'auto-approve')?.map).toEqual({ ok: 'publish', fail: 'approve-publish', error: 'approve-publish' });
  expect(graph.edges.find((edge) => edge.from === 'approve-publish')?.map).toEqual({ ok: 'publish', fail: 'traffic-failed-restore' });
  expect(recipes['notes-check']).toEqual({ command: 'bun scripts/announce-loop/check-node.ts --json', timeout_ms: 600000 });
  expect(recipes['auto-approve']).toEqual({ command: 'bun scripts/release-loop/auto-approve-node.ts', timeout_ms: 600000 });
});

test('partial public publish waits for human approval and continues after publish without repeating it', () => {
  const graph = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), 'utf8')) as {
    nodes: Array<{ node_id: string; kind: string; recipe?: string }>;
    edges: Array<{ from: string; map?: Record<string, string> }>;
  };
  const recipes = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/recipes.yaml'), 'utf8')) as Record<string, { approval?: string; timeout_ms?: number }>;
  expect(graph.nodes.find((node) => node.node_id === 'approve-continue')).toMatchObject({ kind: 'hitl', recipe: 'approval:continue-publish' });
  expect(graph.edges.find((edge) => edge.from === 'publish')?.map).toEqual({ ok: 'npm-publish', partial: 'approve-continue', unknown: 'approve-continue', fail: 'approve-continue', error: 'approve-continue' });
  expect(graph.edges.find((edge) => edge.from === 'approve-continue')?.map).toEqual({ ok: 'npm-publish', fail: 'traffic-failed-restore', error: 'traffic-failed-restore' });
  expect(recipes['continue-publish']?.approval).toContain('npm-publish');
  expect(recipes['publish-command']?.timeout_ms).toBe(5_400_000);
});

test('partial publish resumes the same run at npm-publish after HITL without invoking publish twice', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-partial-publish-hitl-'));
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const calls: string[] = [];
  const runBash = async (body: string) => {
    calls.push(body);
    if (body.includes('bun scripts/release-loop/publish-node.ts')) return { exitCode: 2,
      stdout: JSON.stringify({ outcome: 'error', verdict: 'fail', partialPublish: { tag: 'v9.9.9', published: true },
        publishProcess: { status: null, stdout: '{"published":true}', stderr: 'timeout' } }) + '\n', stderr: '' };
    return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', verdict: 'pass', summary: 'fixture' }) + '\n', stderr: '' };
  };
  try {
    const first = await runGraph(graphPath, { input: { version: '9.9.9', previousVersion: '0.2.3' }, deps: { root, runBash } });
    expect(first.status).toBe('awaiting-approval');
    expect(first.path.slice(-2)).toEqual(['publish', 'approve-continue']);
    expect(first.pending?.nodeId).toBe('approve-continue');
    expect(calls.filter((body) => body.includes('bun scripts/release-loop/publish-node.ts'))).toHaveLength(1);
    decideGraphApproval(first.graphId, first.runId, 'approved', 'fixture-approver', root);
    const resumed = await runGraph(graphPath, { resumeRunId: first.runId, deps: { root, runBash } });
    expect(resumed.runId).toBe(first.runId);
    expect(resumed.status).toBe('done');
    expect(resumed.path).toContain('npm-publish');
    expect(calls.filter((body) => body.includes('bun scripts/release-loop/publish-node.ts'))).toHaveLength(1);
    expect(calls.some((body) => body.includes('npm-publish-node.ts'))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unknown publish status waits for human approval before npm-publish', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-unknown-publish-hitl-'));
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const calls: string[] = [];
  const runBash = async (body: string) => {
    calls.push(body);
    if (body.includes('bun scripts/release-loop/publish-node.ts')) return { exitCode: 0,
      stdout: JSON.stringify({ outcome: 'unknown', verdict: 'fail', summary: 'publication status is unknown',
        partialPublish: { published: 'unknown', pendingAssetsKnown: false, assetsVerified: false },
        publishProcess: { status: null, stdout: '', stderr: 'publish timed out without a result' } }) + '\n', stderr: '' };
    return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', verdict: 'pass', summary: 'fixture' }) + '\n', stderr: '' };
  };
  try {
    const first = await runGraph(graphPath, { input: { version: '9.9.9', previousVersion: '0.2.3' }, deps: { root, runBash } });
    expect(first.status).toBe('awaiting-approval');
    expect(first.path.slice(-2)).toEqual(['publish', 'approve-continue']);
    expect(first.pending?.nodeId).toBe('approve-continue');
    expect(calls.filter((body) => body.includes('bun scripts/release-loop/publish-node.ts'))).toHaveLength(1);
    expect(calls.some((body) => body.includes('npm-publish-node.ts'))).toBe(false);
    decideGraphApproval(first.graphId, first.runId, 'approved', 'fixture-approver', root);
    const resumed = await runGraph(graphPath, { resumeRunId: first.runId, deps: { root, runBash } });
    expect(resumed.runId).toBe(first.runId);
    expect(resumed.status).toBe('done');
    expect(resumed.path).toContain('npm-publish');
    expect(calls.filter((body) => body.includes('bun scripts/release-loop/publish-node.ts'))).toHaveLength(1);
    expect(calls.some((body) => body.includes('npm-publish-node.ts'))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('npm publish failure is fail-closed; only a successful publish continues to docs land', async () => {
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const graph = yaml(readFileSync(graphPath, 'utf8')) as { nodes: Array<{ node_id: string; kind: string; recipe?: string; max_visits: number }>; edges: Array<{ from: string; map: Record<string, string> }> };
  const recipes = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/recipes.yaml'), 'utf8')) as Record<string, { command?: string; timeout_ms?: number }>;
  expect(graph.nodes.find((node) => node.node_id === 'npm-publish')).toMatchObject({ kind: 'git', recipe: 'cmd:npm-publish', max_visits: 1 });
  expect(graph.edges.find((edge) => edge.from === 'publish')?.map).toEqual({ ok: 'npm-publish', partial: 'approve-continue', unknown: 'approve-continue', fail: 'approve-continue', error: 'approve-continue' });
  expect(graph.edges.find((edge) => edge.from === 'npm-publish')?.map).toEqual({ ok: 'traffic-npm-published', fail: 'traffic-failed-restore', error: 'traffic-failed-restore' });
  expect(recipes['npm-publish']).toEqual({ command: 'bun scripts/release-loop/npm-publish-node.ts', timeout_ms: 4_500_000 });
  expect(recipes['npm-publish']?.timeout_ms).toBeGreaterThan(40 * 60_000 + 2 * 300_000 + 83 * 15_000);
  for (const outcome of ['fail', 'error'] as const) {
    const root = mkdtempSync(join(tmpdir(), 'release-npm-failure-'));
    const commands: string[] = [];
    try {
      const state = await runGraph(graphPath, { input: { version: '9.9.9', previousVersion: '0.2.3' }, deps: { root, runBash: async (body) => {
        commands.push(body);
        return {
          exitCode: body.includes('npm-publish-node.ts') ? outcome === 'fail' ? 1 : 2 : 0,
          stdout: JSON.stringify(body.includes('npm-publish-node.ts') ? { outcome, verdict: 'fail', summary: 'E401' } : { outcome: 'ok', verdict: 'pass', summary: 'fake' }) + '\n', stderr: '',
        };
      } } });
      expect(state.status).toBe('failed');
      expect(state.path.slice(-3)).toEqual(['npm-publish', 'traffic-failed-restore', 'failed']);
      expect(JSON.parse(String(state.nodes.find((node) => node.nodeId === 'npm-publish')?.output))).toMatchObject({ outcome, summary: 'E401' });
      expect(commands.some((command) => command.includes('docs-land-node.ts'))).toBe(false);
      expect(commands.some((command) => command.includes('verify-node.ts'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('published graph vault-note recipe renders the cutoff manifest and keeps the route to ops-upgrade', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-vault-graph-'));
  const vault = join(root, 'vault');
  const version = '0.2.14';
  const cut = 'a'.repeat(40);
  try {
    const graph = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), 'utf8')) as { nodes: Array<{ node_id: string; recipe?: string }>; edges: Array<{ from: string; map: Record<string, string> }> };
    const recipes = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/recipes.yaml'), 'utf8')) as Record<string, { command?: string }>;
    expect(graph.nodes.find((node) => node.node_id === 'vault-note')?.recipe).toBe('cmd:vault-note');
    expect(recipes['vault-note']?.command).toBe('bun scripts/release-loop/vault-note-node.ts');
    // The vault note always continues to the release story, which then always continues to ops-upgrade (#24052).
    expect(graph.edges.find((edge) => edge.from === 'vault-note')?.map).toEqual({ ok: 'release-story', fail: 'release-story', error: 'release-story' });
    expect(graph.edges.find((edge) => edge.from === 'release-story')?.map).toEqual({ ok: 'ops-upgrade', fail: 'ops-upgrade', error: 'ops-upgrade' });
    const dir = join(root, 'release', version);
    mkdirSync(join(dir, 'prepared'), { recursive: true });
    writeFileSync(join(dir, 'release.json'), JSON.stringify({ version, tag: `v${version}`, sourceCommit: cut, publishedAt: '2026-10-05T09:00:00Z', publicRepo: 'ElanvitalAI/elanous' }));
    writeFileSync(join(dir, 'prepared', 'notes-draft.md'), '# Release\n- Change\n');
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version, baseline: { sha: 'b'.repeat(40) }, cutoff: { sha: cut }, in: [
      { sha: 'c'.repeat(40), title: '하니스 "검증" 개선', prNumber: 1, line: '하니스 "검증" 개선' },
      { sha: '', title: '지식 교훈 축적', line: '지식 교훈 축적' },
    ] }));
    expect(runVaultNote({ input: { version, previousVersion: '0.2.13' }, outputs: { verify: { outcome: 'ok' } } },
      { instanceRoot: root, productionRoot: root, vaultRoot: vault, checklist: () => [] }).outcome).toBe('ok');
    const content = readFileSync(join(vault, '40. Project/엘라누스 릴리스/0.x/0.2/엘라누스 v0.2.14 (2026-10-05).md'), 'utf8');
    expect(content).toContain('### 하니스 (1건)\n\n- 하니스 "검증" 개선 (#1)');
    expect(content).toContain('### 지식·교훈 (1건)\n\n- 지식 교훈 축적');
    expect(yaml(content.split('---\n')[1]!)).toMatchObject({ title: '엘라누스 v0.2.14 — 하니스 "검증" 개선 · 지식 교훈 축적' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ops-upgrade runs after verify and a failed host does not undo publication or dev bump', async () => {
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const graph = yaml(readFileSync(graphPath, 'utf8')) as { nodes: Array<{ node_id: string; kind: string; recipe?: string; max_visits: number }>; edges: Array<{ from: string; map: Record<string, string> }> };
  const recipes = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/recipes.yaml'), 'utf8')) as Record<string, { command?: string; timeout_ms?: number }>;
  expect(graph.nodes.find((node) => node.node_id === 'ops-upgrade')).toMatchObject({ kind: 'agent', recipe: 'cmd:ops-upgrade', max_visits: 1 });
  expect(graph.edges.find((edge) => edge.from === 'verify')?.map).toEqual({ ok: 'traffic-verify-complete', fail: 'traffic-failed-restore', error: 'traffic-failed-restore' });
  expect(graph.edges.find((edge) => edge.from === 'traffic-verify-complete')?.map).toEqual({ ok: 'pwa-formal-update', fail: 'pwa-formal-update', error: 'pwa-formal-update' });
  expect(graph.nodes.find((node) => node.node_id === 'pwa-formal-update')).toMatchObject({ kind: 'gate', recipe: 'cmd:pwa-formal-update' });
  expect(graph.edges.find((edge) => edge.from === 'pwa-formal-update')?.map).toEqual({ ok: 'vault-note', fail: 'traffic-failed-restore', error: 'traffic-failed-restore' });
  expect(graph.edges.find((edge) => edge.from === 'ops-upgrade')?.map).toEqual({ ok: 'done', fail: 'done', error: 'done' });
  expect(recipes['ops-upgrade']).toEqual({ command: 'bun scripts/release-loop/ops-upgrade-node.ts', timeout_ms: 1_200_000 });
  const root = mkdtempSync(join(tmpdir(), 'release-ops-failed-'));
  try {
    const state = await runGraph(graphPath, { input: { version: '9.9.9', previousVersion: '0.2.3' }, deps: { root, runBash: async (body) => ({
      exitCode: body.includes('ops-upgrade-node.ts') ? 1 : 0,
      stdout: JSON.stringify(body.includes('ops-upgrade-node.ts')
        ? { outcome: 'fail', verdict: 'fail', hosts: [{ host: 'node-b', ok: false, before: '9.9.8', after: '', error: '공급원에 판 없음 (404)' }] }
        : { outcome: 'ok', verdict: 'pass', summary: 'fake' }) + '\n', stderr: '',
    }) } });
    expect(state.status).toBe('done');
    expect(state.path.slice(-11)).toEqual(['publish', 'npm-publish', 'traffic-npm-published', 'release-post-publish-join', 'verify', 'traffic-verify-complete', 'pwa-formal-update', 'vault-note', 'release-story', 'ops-upgrade', 'done']);
    expect(state.fanOuts?.['traffic-npm-published:ok']?.branches['version-dev-bump']).toMatchObject({ status: 'done' });
    expect(JSON.parse(String(state.nodes.find((node) => node.nodeId === 'ops-upgrade')?.output))).toMatchObject({ outcome: 'fail', hosts: [{ host: 'node-b', ok: false }] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('RELEASE-GRAPH-FANOUT: post-publish main writers serialize and join failures report after both finish', async () => {
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const graph = yaml(readFileSync(graphPath, 'utf8')) as {
    nodes: Array<{ node_id: string; needs?: string[]; resource_locks?: string[] }>;
    edges: Array<{ from: string; map?: Record<string, string>; branches?: Record<string, string[]>; join?: string }>;
  };
  expect(graph.edges.find((edge) => edge.from === 'traffic-npm-published')?.map).toBeUndefined();
  expect(graph.nodes.find((node) => node.node_id === 'release-post-publish-join')?.needs).toEqual(['docs-land', 'version-dev-bump']);
  expect(graph.nodes.find((node) => node.node_id === 'docs-land')?.resource_locks).toEqual(['main-write']);
  expect(graph.nodes.find((node) => node.node_id === 'version-dev-bump')?.resource_locks).toEqual(['main-write']);
  expect(graph.edges.find((edge) => edge.from === 'release-post-publish-join')?.map).toEqual({ ok: 'verify', fail: 'traffic-failed-restore', error: 'traffic-failed-restore' });
  expect(graph.edges.find((edge) => edge.from === 'verify')?.map).toEqual({ ok: 'traffic-verify-complete', fail: 'traffic-failed-restore', error: 'traffic-failed-restore' });
  expect(graph.edges.find((edge) => edge.from === 'traffic-verify-complete')?.map).toEqual({ ok: 'pwa-formal-update', fail: 'pwa-formal-update', error: 'pwa-formal-update' });
  expect(graph.nodes.find((node) => node.node_id === 'pwa-formal-update')).toMatchObject({ kind: 'gate', recipe: 'cmd:pwa-formal-update' });
  expect(graph.edges.find((edge) => edge.from === 'pwa-formal-update')?.map).toEqual({ ok: 'vault-note', fail: 'traffic-failed-restore', error: 'traffic-failed-restore' });
  for (const [failing, nodeId] of [['docs-land-node.ts', 'docs-land'], ['version-node.ts dev-bump', 'version-dev-bump'], ['verify-node.ts', 'verify']] as const) {
    const root = mkdtempSync(join(tmpdir(), 'release-devbump-always-'));
    try {
      let activeMainWriters = 0;
      let maxActiveMainWriters = 0;
      let signalFirstMainWriter!: () => void;
      const firstMainWriterStarted = new Promise<void>((resolve) => { signalFirstMainWriter = resolve; });
      let releaseFirstMainWriter!: () => void;
      const firstMainWriterBarrier = new Promise<void>((resolve) => { releaseFirstMainWriter = resolve; });
      let firstMainWriterHeld = false;
      let secondMainWriterStarted = false;
      const mainWriterCalls = { docsLand: 0, versionDevBump: 0 };
      const statePromise = runGraph(graphPath, {
        input: { version: '9.9.9', previousVersion: '0.2.3' },
        deps: { root, runBash: async (body) => {
          const docsLand = body.includes('docs-land-node.ts');
          const versionDevBump = body.includes('version-node.ts dev-bump');
          if (docsLand || versionDevBump) {
            if (docsLand) mainWriterCalls.docsLand++;
            if (versionDevBump) mainWriterCalls.versionDevBump++;
            activeMainWriters++;
            maxActiveMainWriters = Math.max(maxActiveMainWriters, activeMainWriters);
            if (!firstMainWriterHeld) {
              firstMainWriterHeld = true;
              signalFirstMainWriter();
              await firstMainWriterBarrier;
            } else secondMainWriterStarted = true;
            activeMainWriters--;
          }
          const failed = body.includes(failing);
          return { exitCode: failed ? 1 : 0,
            stdout: JSON.stringify(failed ? { outcome: 'fail', verdict: 'fail', summary: '이미 있는 릴리스' } : { outcome: 'ok', verdict: 'pass', summary: 'fake' }) + '\n', stderr: '' };
        } },
      });
      await firstMainWriterStarted;
      expect(secondMainWriterStarted).toBe(false);
      releaseFirstMainWriter();
      const state = await statePromise;
      expect(state.status).toBe('failed');
      expect(mainWriterCalls).toEqual({ docsLand: 1, versionDevBump: 1 });
      expect(maxActiveMainWriters).toBe(1);
      // Both independent post-publish branches finish before the failed join routes to the failure tail.
      expect(state.fanOuts?.['traffic-npm-published:ok']?.branches['version-dev-bump']).toMatchObject({
        status: nodeId === 'version-dev-bump' ? 'failed' : 'done',
      });
      expect(state.path.slice(-4)).toEqual(nodeId === 'verify'
        ? ['release-post-publish-join', 'verify', 'traffic-failed-restore', 'failed']
        : ['traffic-npm-published', 'release-post-publish-join', 'traffic-failed-restore', 'failed']);
      // the failure stays reported as-is in the failing node's own output
      const output = nodeId === 'docs-land' || nodeId === 'version-dev-bump'
        ? state.fanOuts?.['traffic-npm-published:ok']?.branches[nodeId]?.output
        : state.nodes.find((node) => node.nodeId === nodeId)?.output;
      expect(JSON.parse(String(output))).toMatchObject({ outcome: 'fail', summary: '이미 있는 릴리스' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('release story follows vault note and every outcome continues to ops upgrade', async () => {
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const graph = yaml(readFileSync(graphPath, 'utf8')) as {
    nodes: Array<{ node_id: string; kind: string; recipe?: string; max_visits: number }>;
    edges: Array<{ from: string; map: Record<string, string> }>;
  };
  const recipes = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/recipes.yaml'), 'utf8')) as Record<string, { command?: string; timeout_ms?: number }>;
  expect(graph.nodes.find((node) => node.node_id === 'release-story')).toMatchObject({ kind: 'gate', recipe: 'cmd:release-story', max_visits: 1 });
  expect(recipes['release-story']).toEqual({ command: 'bun scripts/release-story/draft.ts --graph', timeout_ms: 600000 });
  expect(graph.edges.find((edge) => edge.from === 'vault-note')?.map).toEqual({ ok: 'release-story', fail: 'release-story', error: 'release-story' });
  expect(graph.edges.find((edge) => edge.from === 'release-story')?.map).toEqual({ ok: 'ops-upgrade', fail: 'ops-upgrade', error: 'ops-upgrade' });
  for (const outcome of ['ok', 'fail', 'error'] as const) {
    const root = mkdtempSync(join(tmpdir(), 'release-story-route-'));
    try {
      const state = await runGraph(graphPath, { input: { version: '9.9.9', previousVersion: '0.2.3' }, deps: { root, runBash: async (body) => ({
        exitCode: body.includes('release-story/draft.ts') ? outcome === 'ok' ? 0 : outcome === 'fail' ? 1 : 2 : 0,
        stdout: JSON.stringify(body.includes('release-story/draft.ts') ? { outcome, verdict: outcome === 'ok' ? 'pass' : 'fail', summary: 'injected story result' } : { outcome: 'ok', verdict: 'pass' }) + '\n', stderr: '',
      }) } });
      expect(state.status).toBe('done');
      expect(state.path.slice(-4)).toEqual(['vault-note', 'release-story', 'ops-upgrade', 'done']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('0.2.14 published graph executes the real story recipe into the isolated release directory and MK inbox once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-story-published-'));
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const version = '0.2.14';
  const story = join(root, 'release', version, 'story');
  const requests = join(root, 'seat-requests', 'requests.jsonl');
  try {
    const checklistDir = join(root, 'release', version);
    mkdirSync(checklistDir, { recursive: true });
    setElanousConfigDir(root);
    addItem(version, { id: 'STORY_214', title: 'New reading mode — details' });
    setItem(version, 'STORY_214', { status: 'green' }, 'MK');
    const ledger = new ClaimsLedger({ stateDir: root });
    ledger.add({ id: 'EXPORT_214', claim: 'New export mode is available.', audience: 'personal', owner: 'MK' });
    ledger.verify('EXPORT_214', { value: 'yes', command: 'bun measure-export.ts', measuredAt: new Date().toISOString(),
      validUntil: new Date(Date.now() + 86400000).toISOString(), by: 'MK' });
    ledger.link('EXPORT_214', { cell: 'STORY_214', version });
    // 실제 release/next.md 는 판 올림마다 비워진다 — 시험은 자기 판 노트 픽스처를 쓴다.
    const nextFixture = join(root, 'next.md');
    writeFileSync(nextFixture, '# next\n\n## User\n\n- A new public guide shows how to attach a coding session to an elanous seat.\n');
    const runBash = async (body: string, opts: { env?: NodeJS.ProcessEnv }) => {
      if (body.includes('release-story/draft.ts')) {
        const child = spawnSync(process.execPath, [join(import.meta.dir, '../release-story/draft.ts'), '--graph'], {
          cwd: join(import.meta.dir, '../..'), encoding: 'utf8', env: { ...opts.env, ELANOUS_STATE_DIR: root, ELANOUS_RELEASE_NEXT_PATH: nextFixture },
        });
        return { exitCode: child.status ?? 2, stdout: child.stdout, stderr: child.stderr };
      }
      return { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass"}\n', stderr: '' };
    };
    for (let i = 0; i < 2; i++) {
      const state = await runGraph(graphPath, { input: { version, previousVersion: '0.2.13' }, deps: { root, runBash } });
      expect(state.status).toBe('done');
      expect(state.path.slice(-4)).toEqual(['vault-note', 'release-story', 'ops-upgrade', 'done']);
      expect(JSON.parse(String(state.nodes.find((node) => node.nodeId === 'release-story')?.output))).toMatchObject({ outcome: 'ok', status: 'drafted' });
    }
    const announcement = readFileSync(join(story, 'announcement.md'), 'utf8');
    expect(announcement).toContain(version);
    const next = readFileSync(nextFixture, 'utf8');
    const selected = next.split(/\r?\n/).find((line) => /^- (?:feat — )?A new public guide/.test(line))?.replace(/^- (?:feat — )?/, '');
    expect(selected).toBeDefined();
    expect(announcement).toContain(`새 종류 후보: ${selected}\n- 출처: release/next.md\n- 재측정: 확인 명령 없음 — 게시 전 확인`);
    expect(announcement).not.toContain('재측정: bun measure-export.ts');
    expect(announcement).toContain('New export mode is available.');
    expect(announcement).toContain('CMO 게시 판단');
    expect(readFileSync(join(story, 'site-news.md'), 'utf8')).toContain(version);
    expect(readFileSync(join(story, 'manual-candidates.md'), 'utf8')).toContain('STORY_214 · New reading mode · 매뉴얼 언급 없음');
    const rows = readFileSync(requests, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, string>);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: `release-story:${version}`, seat: 'MK', source: 'release-story', version,
      status: 'pending', text: `${version} 공지 초안 준비됨: ${story}` });
  } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
});

type GraphNotifySetting = boolean | string | { on?: string | string[]; enabled?: boolean };
type ReleaseGraphNode = { node_id: string; notify?: GraphNotifySetting; max_visits: number };

const GRAPH_NOTIFY_KNOWN = new Set(['always', 'all', 'node', 'ok', 'fail', 'success', 'failure', 'approval']);

function notifyOnValues(notify: GraphNotifySetting | undefined): string[] {
  if (notify === undefined || typeof notify === 'boolean') return [];
  if (typeof notify === 'string') return [notify];
  if (notify.on === undefined) return [];
  return Array.isArray(notify.on) ? notify.on : [notify.on];
}

test('graph recipes carry fail notices and measured long-node timeouts', () => {
  const graph = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), 'utf8')) as { nodes: ReleaseGraphNode[] };
  const recipes = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/recipes.yaml'), 'utf8')) as Record<string, { timeout_ms?: number; command?: string; approval?: string }>;
  expect(graph.nodes.filter((node) => node.max_visits !== 1).map((node) => [node.node_id, node.max_visits])).toEqual([
    ['gate', 4], ['cloud-leave-ok', 4], ['cloud-leave-fail', 4], ['cloud-leave-error', 4], ['cloud-leave-join-fail', 4],
    ['gate-cutover-switch', 4], ['emergency-switch', 4], ['receipt-audit', 3], ['residual-run', 3], ['receipt-audit-recheck', 3], ['gate-triage', 3],
  ]);
  expect(graph.nodes.filter((node) => notifyOnValues(node.notify).length > 0 && notifyOnValues(node.notify).every((value) => value === 'fail')).map((node) => node.node_id)).toEqual(['gate', 'pwa', 'prepare', 'pwa-formal-update']);
  expect(recipes.gate?.timeout_ms).toBe(14_400_000);
  expect(recipes.pwa?.timeout_ms).toBe(1_800_000);
  expect(recipes['pwa-formal-update']?.timeout_ms).toBe(1_800_000);
  expect(recipes.prepare?.timeout_ms).toBe(1_800_000);
  expect(recipes.publish?.approval).toContain('되돌릴 수 없다');
  expect(recipes['publish-command']?.command).toContain('publish-node.ts');
});

test('publish and verify notify on ok and fail, and no node uses an unknown notify value', () => {
  const graph = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), 'utf8')) as { nodes: ReleaseGraphNode[] };
  for (const id of ['publish', 'verify'] as const) {
    const values = notifyOnValues(graph.nodes.find((node) => node.node_id === id)?.notify);
    expect(values).toContain('ok');
    expect(values).toContain('fail');
  }
  for (const node of graph.nodes) {
    for (const value of notifyOnValues(node.notify)) {
      expect(GRAPH_NOTIFY_KNOWN.has(value)).toBe(true);
    }
  }
  expect(graph.nodes.some((node) => notifyOnValues(node.notify).includes('start'))).toBe(false);
});

test('collectGraphEvents emits exactly one publish event for a fake publish-ok run', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-publish-notify-'));
  try {
    const graphsDir = join(root, 'graphs');
    mkdirSync(graphsDir);
    writeFileSync(join(graphsDir, 'release-loop.yaml'), readFileSync(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), 'utf8'));
    const runDir = join(root, 'graph-runs', 'release-loop');
    mkdirSync(runDir, { recursive: true });
    const runId = 'run-publish-ok';
    const statePath = join(runDir, `${runId}.json`);
    const state: GraphRunState = {
      graphId: 'release-loop', runId, status: 'done', path: ['publish'],
      nodes: [{ nodeId: 'publish', ok: true, exit: 0, executed: true }],
      executed: 1, dryRun: false, statePath,
    };
    writeFileSync(statePath, JSON.stringify(state));
    const events = collectGraphEvents({ root, graphsDir });
    expect(events).toHaveLength(1);
    expect(events.filter((event) => event.nodeId === 'publish')).toHaveLength(1);
    expect(events[0]).toMatchObject({ graphId: 'release-loop', nodeId: 'publish', kind: 'node', status: 'ok' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('measured graph decision publishes without human approval', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-auto-wiring-'));
  const repo = join(root, 'repo');
  const out = join(root, 'release', '0.2.5', 'prepared');
  const dist = join(out, 'dist');
  const graph = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const commands: string[] = [];
  try {
    mkdirSync(repo);
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(repo, '.bun-version'), `${Bun.version}\n`);
    for (let i = 0; i < 5; i++) writeFileSync(join(dist, `install-${i}`), 'fixture');
    const fake = async (body: string, opts: { env?: NodeJS.ProcessEnv }) => {
      commands.push(body);
      if (body.includes('auto-approve-node.ts')) {
        const context = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as GraphContext;
        const result = runAutoApprove(context, { instanceRoot: root, repo });
        return { exitCode: result.outcome === 'ok' ? 0 : 1, stdout: JSON.stringify(result) + '\n', stderr: '' };
      }
      const nodeId = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')).nodeId;
      const fields = nodeId === 'tui'
        ? { regress: { pass: 7, fail: 0, results: Array.from({ length: 7 }, (_, i) => ({ id: `R${i + 1}`, title: 'check', ok: true, reason: 'measured' })) } }
        : body.includes('gate-node.ts') ? { introduced: [] } : body.includes('prepare-node.ts') ? { out }
          : body.includes('docs-node.ts') ? { notes: join(root, 'notes.md') } : {};
      return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', verdict: 'pass', ...fields }) + '\n', stderr: '' };
    };
    const state = await runGraph(graph, { input: { version: '0.2.5', previousVersion: '0.2.4' }, deps: { root, runBash: fake } });
    const durations = releaseDurations(state);
    expect(durations.totalSeconds).toBeNumber();
    expect(durations.gateToPublishSeconds).toBeNumber();
    // This is an isolated fake-run clock check, not a post-change production speedup measurement.
    expect(state.status).toBe('done');
    expect(state.path).toContain('auto-approve');
    expect(state.path).not.toContain('approve-publish');
    expect(state.nodes.find((n) => n.nodeId === 'auto-approve')?.output).toContain('release-loop metrics');
    expect(commands.some((body) => body.includes('publish-node.ts'))).toBe(true);
    expect(readFileSync(join(root, 'release', '0.2.5', 'auto-approval.md'), 'utf8')).toContain('| 8 | installation files |');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('4/7 TUI result reaches HITL in the same graph run and cannot publish before approval', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-tui-hitl-'));
  const repo = join(root, 'repo');
  const out = join(root, 'release', '0.2.5', 'prepared');
  const graph = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const published: string[] = [];
  try {
    mkdirSync(repo);
    mkdirSync(join(out, 'dist'), { recursive: true });
    writeFileSync(join(repo, '.bun-version'), `${Bun.version}\n`);
    for (let i = 0; i < 5; i++) writeFileSync(join(out, 'dist', `install-${i}`), 'fixture');
    const runBash = async (body: string, opts: { env?: NodeJS.ProcessEnv }) => {
      const context = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as GraphContext;
      if (context.nodeId === 'auto-approve') {
        const result = runAutoApprove(context, { instanceRoot: root, repo });
        return { exitCode: result.outcome === 'ok' ? 0 : 1, stdout: JSON.stringify(result) + '\n', stderr: '' };
      }
      if (context.nodeId === 'publish') {
        const prior = process.env.ELANOUS_GRAPH_CONTEXT;
        process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify(context);
        try {
          const result = runPublish((command, args) => {
            if (command === 'git') return { status: 0, stdout: args[1]?.endsWith('pages.json')
              ? JSON.stringify({ pages: [] }) : '# 0.2.5\n\nRelease notes.\n', stderr: '' };
            if (command === 'bun' && args.includes('publish')) {
              published.push(context.runId!);
              return { status: 0, stdout: JSON.stringify({ ok: true, published: true, tag: 'v0.2.5', assets: [] }), stderr: '' };
            }
            throw new Error(`unexpected publish command: ${command}`);
          }, root, undefined, root);
          return { exitCode: result.outcome === 'ok' ? 0 : 1, stdout: JSON.stringify(result) + '\n', stderr: '' };
        } finally {
          if (prior === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
          else process.env.ELANOUS_GRAPH_CONTEXT = prior;
        }
      }
      const fields = context.nodeId === 'version-release' ? { commit: 'a'.repeat(40) }
        : context.nodeId === 'gate' ? { introduced: [] }
        : context.nodeId === 'prepare' ? { out, commit: 'a'.repeat(40) }
        : context.nodeId === 'docs' ? { notes: join(root, 'notes.md'), branch: 'release-docs/0.2.5' }
        : context.nodeId === 'tui' ? { regress: { pass: 4, fail: 3,
          results: Array.from({ length: 7 }, (_, i) => ({ id: `R${i + 1}`, title: 'check', ok: i < 4, reason: 'measured' })) } } : {};
      return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', verdict: 'pass', ...fields }) + '\n', stderr: '' };
    };
    const first = await runGraph(graph, { input: { version: '0.2.5', previousVersion: '0.2.4' }, deps: { root, runBash } });
    expect(first.status).toBe('awaiting-approval');
    expect(first.path.slice(-2)).toEqual(['auto-approve', 'approve-publish']);
    expect(first.pending?.nodeId).toBe('approve-publish');
    expect(published).toEqual([]);
    const auto = JSON.parse(String(first.nodes.find((node) => node.nodeId === 'auto-approve')?.output));
    expect(auto.tuiSubcheck).toMatchObject({ runId: first.runId, fail: 3, approvalRequired: true });
    const prior = process.env.ELANOUS_GRAPH_CONTEXT;
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ nodeId: 'publish', runId: first.runId,
      input: { version: '0.2.5', previousVersion: '0.2.4' },
      outputs: { 'auto-approve': auto, 'approve-publish': { outcome: 'approved', graphId: first.graphId,
        runId: first.runId, nodeId: 'approve-publish', decidedAt: new Date().toISOString() } } });
    try {
      expect(runPublish(() => { throw new Error('publish invoked before HITL'); }, root, undefined, root).outcome).toBe('fail');
    } finally {
      if (prior === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
      else process.env.ELANOUS_GRAPH_CONTEXT = prior;
    }
    decideGraphApproval(first.graphId, first.runId, 'approved', 'fixture-approver', root);
    const resumed = await runGraph(graph, { resumeRunId: first.runId, deps: { root, runBash } });
    expect(resumed.runId).toBe(first.runId);
    expect(published).toEqual([first.runId]);
    const approval = JSON.parse(String(resumed.nodes.find((node) => node.nodeId === 'approve-publish')?.output));
    expect(approval).toMatchObject({ outcome: 'approved', graphId: first.graphId, runId: first.runId, nodeId: 'approve-publish' });
    expect(approval.decidedAt).toBeString();
    const statePath = join(root, 'graph-runs', 'release-loop', `${first.runId}.json`);
    const persisted = JSON.parse(readFileSync(statePath, 'utf8')) as GraphRunState;
    expect(persisted.nodes.find((node) => node.nodeId === 'approve-publish')?.decidedAt).toBe(approval.decidedAt);
    const visit = persisted.path.indexOf('approve-publish') + 1;
    const claim = JSON.parse(readFileSync(`${statePath}.${visit}.decision.json`, 'utf8'));
    expect(claim).toMatchObject({ nodeId: 'approve-publish', decision: 'approved', decidedAt: approval.decidedAt });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('real graph commands stop at approval before publish', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-approval-'));
  try {
    const state = await runGraph(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), {
      input: { version: '9.9.9', previousVersion: '0.2.3' }, deps: { root, runBash: async (body) => ({ exitCode: body.includes('auto-approve-node.ts') ? 1 : 0, stdout: body.includes('auto-approve-node.ts') ? '{"outcome":"fail","verdict":"fail","summary":"unmeasured"}\n' : '{"outcome":"ok","verdict":"pass","summary":"fake"}\n', stderr: '' }) },
    });
    expect(state.status).toBe('awaiting-approval');
    expect(state.path).toEqual(['version-release', 'readiness-countdown', 'traffic-cut-start', 'cutoff', 'pre-gate-join', 'cloud-approval-check', 'cloud-join', 'pod-reuse-prep', 'gate', 'cloud-leave-ok', 'gate-cutover-switch', 'receipt-audit', 'traffic-gate-passed', 'pre-prepare-join', 'prepare', 'upgrade', 'tui', 'docs', 'known-issues', 'notes-check', 'auto-approve', 'approve-publish']);
    expect(state.pending?.nodeId).toBe('approve-publish');
    // Source: the release graph now runs pod-reuse-prep before its regression suite node and hard gate.
    expect(state.executed).toBe(21);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('real checklist gate stops the graph before the costly gate when a red item exists', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-checklist-failure-'));
  const ledger = join(root, '.elanous');
  const dir = join(ledger, 'release', '9.9.9');
  const commands: string[] = [];
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'checklist.json'), JSON.stringify({ version: '9.9.9', released: '', dev: '', items: [{ id: 'K13', title: 'Block release', status: 'red', updatedAt: new Date().toISOString(), updatedBy: 'TC' }], history: [] }));
    const state = await runGraph(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), {
      input: { version: '9.9.9', previousVersion: '0.2.3' },
      deps: { root, runBash: async (body, opts) => {
        commands.push(body);
        if (body.includes('checklist-gate-node.ts')) {
          const run = spawnSync(process.execPath, [join(import.meta.dir, 'checklist-gate-node.ts')], {
            cwd: join(import.meta.dir, '../..'), encoding: 'utf8', env: { ...opts.env, HOME: root, ELANOUS_STATE_DIR: ledger },
          });
          return { exitCode: run.status ?? 2, stdout: run.stdout, stderr: run.stderr };
        }
        return { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass"}\n', stderr: '' };
      } },
    });
    expect(state.status).toBe('failed');
    expect(state.path).toEqual(['version-release', 'readiness-countdown', 'traffic-cut-start', 'cutoff', 'pre-gate-join', 'traffic-failed-restore', 'failed']);
    expect(JSON.parse(String(state.fanOuts?.['cutoff:ok']?.branches['checklist-gate']?.output))).toMatchObject({ outcome: 'fail', red: ['K13'] });
    // Source: the regression suite is one additional command before the existing checklist join.
    expect(commands).toHaveLength(8);
    expect(commands.some((command) => command.includes('/gate-node.ts') && !command.includes('checklist-gate-node.ts'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('regression suite difference stops the release before the hard gate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-regression-suite-failure-'));
  const commands: string[] = [];
  try {
    const state = await runGraph(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), {
      input: { version: '9.9.9', previousVersion: '0.2.3' },
      deps: { root, runBash: async (body) => {
        commands.push(body);
        return body.includes('regression-suite-node.ts')
          ? { exitCode: 1, stdout: '{"outcome":"fail","verdict":"fail","summary":"one receipt changed"}\n', stderr: '' }
          : { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass","summary":"fixture"}\n', stderr: '' };
      } },
    });
    expect(state.status).toBe('failed');
    expect(state.path).toContain('pre-gate-join');
    expect(state.path).not.toContain('gate');
    expect(commands.some((command) => command.includes('regression-suite-node.ts'))).toBe(true);
    expect(commands.some((command) => command.includes('/gate-node.ts'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('gate regression routes to failed before preparing or publishing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-regression-'));
  const commands: string[] = [];
  try {
    const state = await runGraph(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), {
      input: { version: '9.9.9', previousVersion: '0.2.3' },
      deps: { root, runBash: async (body) => {
        commands.push(body);
        return body.includes('/gate-node.ts')
          ? { exitCode: 1, stdout: '{"outcome":"fail","verdict":"fail","summary":"new regression"}\n', stderr: '' }
          : { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass","summary":"fake"}\n', stderr: '' };
      } },
    });
    expect(state.status).toBe('failed');
    expect(state.path).toEqual(['version-release', 'readiness-countdown', 'traffic-cut-start', 'cutoff', 'pre-gate-join', 'cloud-approval-check', 'cloud-join', 'pod-reuse-prep', 'gate', 'cloud-leave-fail', 'emergency-switch', 'gate-triage', 'traffic-failed-restore', 'failed']);
    // Source: the regression suite command runs in the cutoff fan-out before this failing hard gate.
    expect(commands).toHaveLength(14);
    expect(commands.some((command) => command.includes('gate-triage-node.ts'))).toBe(true);
    expect(commands.some((command) => command.includes('publish-node.ts'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shadow triage error cannot turn a failed gate into a passing release', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-triage-error-'));
  try {
    const state = await runGraph(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), {
      input: { version: '9.9.9', previousVersion: '0.2.3' },
      deps: { root, runBash: async (body) => body.includes('/gate-triage-node.ts')
        ? { exitCode: 2, stdout: '{"outcome":"error","verdict":"fail","summary":"triage unavailable"}\n', stderr: '' }
        : body.includes('/gate-node.ts')
          ? { exitCode: 1, stdout: '{"outcome":"fail","verdict":"fail","summary":"regression"}\n', stderr: '' }
          : { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass","summary":"fake"}\n', stderr: '' } },
    });
    expect(state.status).toBe('awaiting-approval');
    expect(state.path).toEqual(['version-release', 'readiness-countdown', 'traffic-cut-start', 'cutoff', 'pre-gate-join', 'cloud-approval-check', 'cloud-join', 'pod-reuse-prep', 'gate', 'cloud-leave-fail', 'emergency-switch', 'gate-triage', 'gate-heal-decision']);
    expect(state.pending?.nodeId).toBe('gate-heal-decision');
    expect(state.path).not.toContain('publish');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rejecting adaptive gate repair restores traffic before the run fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-heal-rejected-'));
  try {
    const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
    const options = { deps: { root, runBash: async (body: string) => body.includes('/gate-triage-node.ts')
      ? { exitCode: 1, stdout: '{"outcome":"fail","verdict":"fail"}\n', stderr: '' }
      : body.includes('/gate-node.ts')
        ? { exitCode: 1, stdout: '{"outcome":"fail","verdict":"fail"}\n', stderr: '' }
        : { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass"}\n', stderr: '' } } };
    const waiting = await runGraph(graphPath, { runId: 'release-heal-rejected', input: { version: '9.9.9', previousVersion: '0.2.3' }, ...options });
    expect(waiting.status).toBe('awaiting-approval');
    expect(waiting.pending?.nodeId).toBe('gate-heal-decision');
    decideGraphApproval(waiting.graphId, waiting.runId, 'rejected', 'fixture-owner', root);
    const rejected = await runGraph(graphPath, { resumeRunId: waiting.runId, ...options });
    expect(rejected.status).toBe('failed');
    expect(rejected.path.slice(-3)).toEqual(['gate-heal-decision', 'traffic-failed-restore', 'failed']);
    expect(rejected.path).not.toContain('publish');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rejecting exhausted gate-repair recovery restores traffic before the run fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-repair-recovery-rejected-'));
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const commands: string[] = [];
  try {
    const runBash: NonNullable<GraphRunOptions['deps']>['runBash'] = async (body, opts) => {
      commands.push(body);
      if (body.includes('gate-node.ts --json'))
        return { exitCode: 1, stdout: JSON.stringify({ outcome: 'fail', commit: 'd'.repeat(40),
          introduced: ['src/example.test.ts > introduced regression'] }), stderr: '' };
      if (body.includes('gate-triage-node.ts')) {
        const context = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as { input: Record<string, unknown> };
        return { exitCode: 0, stdout: JSON.stringify({ ...classifyGateShadow({ outcome: 'regression',
          commit: 'd'.repeat(40), introduced: ['src/example.test.ts > introduced regression'], preexisting: 0,
          fixed: null, knownEnv: 0, knownEnvCleared: [], stalledEnv: [], rcNonzeroNoFailures: [], durationMs: 10 }),
          gateExecutionId: context.input.adaptiveGateExecutionId }), stderr: '' };
      }
      if (body.includes('gate-repair-node.ts'))
        return { exitCode: 2, stdout: JSON.stringify({ outcome: 'recovery-required', verdict: 'fail',
          summary: 'bounded landing receipt recovery exhausted' }), stderr: 'receipt recovery exhausted' };
      return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok' }), stderr: '' };
    };
    const options = { deps: { root, runBash } };
    const waiting = await runGraph(graphPath, { runId: 'release-repair-recovery-rejected',
      input: { version: '9.9.9', previousVersion: '0.2.3', gateExecutor: 'pod' }, ...options });
    expect(waiting.status).toBe('awaiting-approval');
    expect(waiting.pending?.nodeId).toBe('gate-repair-recovery');
    decideGraphApproval(waiting.graphId, waiting.runId, 'rejected', 'fixture-owner', root);
    const rejected = await runGraph(graphPath, { resumeRunId: waiting.runId, ...options });
    expect(rejected.status).toBe('failed');
    expect(rejected.path.slice(-3)).toEqual(['gate-repair-recovery', 'traffic-failed-restore', 'failed']);
    expect(commands.some((body) => body.includes('traffic-node.ts traffic-failed-restore'))).toBe(true);
    expect(rejected.path).not.toContain('publish');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('notes-check failure is repaired once and a still-failing recheck fails without approval or publishing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-notes-failure-'));
  const commands: string[] = [];
  try {
    const state = await runGraph(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), {
      input: { version: '9.9.9', previousVersion: '0.2.3' },
      deps: { root, runBash: async (body) => {
        commands.push(body);
        return body.includes('announce-loop/check-node.ts')
          ? { exitCode: 1, stdout: '{"outcome":"fail","findings":[{"rule":"B11"}]}\n', stderr: '' }
          : { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass"}\n', stderr: '' };
      } },
    });
    expect(state.status).toBe('failed');
    expect(state.path.slice(-7)).toEqual(['docs', 'known-issues', 'notes-check', 'notes-repair', 'notes-recheck', 'traffic-failed-restore', 'failed']);
    expect(commands.at(-2)).toContain('check-node.ts');
    expect(commands.at(-1)).toContain('traffic-node.ts traffic-failed-restore');
    expect(commands.filter((command) => command.includes('announce-loop/check-node.ts'))).toHaveLength(2);
    expect(commands.some((command) => command.includes('publish-node.ts'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('actual docs output reaches the real notes checker and B11 blocks approval', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-notes-wiring-'));
  const graph = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const notes = join(root, 'release/public/docs/releases/9.9.9.md');
  const page = join(root, 'release/public/docs/guide.md');
  const commands: string[] = [];
  const approvals: string[] = [];
  try {
    mkdirSync(join(root, 'release/9.9.9'), { recursive: true });
    mkdirSync(join(root, 'release/public/docs/releases'), { recursive: true });
    mkdirSync(join(root, 'website'), { recursive: true });
    writeFileSync(join(root, 'release/9.9.9/manifest.json'), JSON.stringify({ version: '9.9.9', in: [] }));
    writeFileSync(join(root, 'website/pages.json'), JSON.stringify({ pages: [] }));
    writeFileSync(page, '🟡 on main — next release');
    const state = await runGraph(graph, {
      input: { version: '9.9.9', previousVersion: '0.2.3' },
      deps: { root, log: (event) => { if (event === 'approval-pending') approvals.push(event); }, runBash: async (body, opts) => {
        commands.push(body);
        if (!body.includes('docs-node.ts') && !body.includes('announce-loop/check-node.ts')) {
          return { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass"}\n', stderr: '' };
        }
        if (body.includes('docs-node.ts')) {
          const nodeId = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')).nodeId as string;
          if (nodeId !== 'docs') return { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass"}\n', stderr: '' };
          const run = spawnSync(process.execPath, [join(import.meta.dir, 'docs-node.ts'), '--version', '9.9.9', '--base', root, '--json'], {
            cwd: root, encoding: 'utf8', env: { ...opts.env, ELANOUS_GRAPH_CONTEXT: '', ELANOUS_STATE_DIR: root },
          });
          expect(run.status).toBe(0);
          writeFileSync(notes, `${readFileSync(notes, 'utf8')}내부 제목\n`);
          return { exitCode: run.status ?? 2, stdout: run.stdout, stderr: run.stderr };
        }
        const run = spawnSync(process.execPath, [join(import.meta.dir, '../announce-loop/check-node.ts'), '--json'], {
          cwd: root, encoding: 'utf8', env: { ...opts.env, ELANOUS_STATE_DIR: root },
        });
        return { exitCode: run.status ?? 2, stdout: run.stdout, stderr: run.stderr };
      } },
    });
    const docs = JSON.parse(String(state.nodes.find((node) => node.nodeId === 'docs')?.output));
    const checked = JSON.parse(String(state.nodes.find((node) => node.nodeId === 'notes-check')?.output));
    expect(docs).toMatchObject({ outcome: 'ok', notes, flipped: [page] });
    expect(checked).toMatchObject({ ok: false, outcome: 'fail', checked: { files: 2 }, findings: [{ rule: 'B11', file: notes, text: '내부 제목' }] });
    expect(state.status).toBe('failed');
    expect(state.path.slice(-7)).toEqual(['docs', 'known-issues', 'notes-check', 'notes-repair', 'notes-recheck', 'traffic-failed-restore', 'failed']);
    expect(state.pending).toBeUndefined();
    expect(approvals).toEqual([]);
    expect(commands.some((command) => command.includes('publish-node.ts'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

describe('RELEASE-GRAPH-SELFHEAL: TDD 무대: 같은 production graph runner를 통과하는 mock', () => {
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const fullPassPath = ['version-release', 'readiness-countdown', 'traffic-cut-start', 'cutoff', 'pre-gate-join', 'cloud-approval-check', 'cloud-join', 'pod-reuse-prep', 'gate', 'cloud-leave-ok', 'gate-cutover-switch', 'receipt-audit', 'traffic-gate-passed',
    'pre-prepare-join', 'prepare', 'upgrade', 'tui', 'docs', 'known-issues', 'notes-check', 'auto-approve', 'publish',
    'npm-publish', 'traffic-npm-published', 'release-post-publish-join', 'verify', 'traffic-verify-complete', 'pwa-formal-update', 'vault-note', 'release-story', 'ops-upgrade', 'done'];

  function loadGraph() {
    return yaml(readFileSync(graphPath, 'utf8')) as {
      nodes: Array<{ node_id: string; kind: string; recipe?: string; max_visits: number }>;
      edges: Array<{ from: string; map: Record<string, string> }>;
    };
  }

  // Mock fixture on the production graph runner: check-node outcomes in call order (notes-check, then notes-recheck),
  // repair outcomes in call order (notes-repair). Every other node reports ok.
  function notesFixture(checks: Array<'ok' | 'fail' | 'error'>, repairs: Array<'ok' | 'fail' | 'error'> = ['ok']) {
    const commands: string[] = [];
    let checkIndex = 0;
    let repairIndex = 0;
    const runBash = async (body: string, opts: { env?: NodeJS.ProcessEnv }) => {
      commands.push(body);
      const nodeId = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')).nodeId as string;
      let outcome: 'ok' | 'fail' | 'error' = 'ok';
      if (nodeId === 'notes-check' || nodeId === 'notes-recheck') outcome = checks[checkIndex++] ?? 'ok';
      else if (nodeId === 'notes-repair') outcome = repairs[repairIndex++] ?? 'ok';
      return { exitCode: outcome === 'ok' ? 0 : outcome === 'fail' ? 1 : 2,
        stdout: JSON.stringify({ outcome, verdict: outcome === 'ok' ? 'pass' : 'fail', summary: `fixture ${nodeId}` }), stderr: '' };
    };
    return { commands, runBash };
  }

  test('notes-check fail/error 간선은 notes-repair로 가고 repair는 notes-recheck로 되돌린다 (간선·노드 순서)', () => {
    const graph = loadGraph();
    expect(graph.edges.find((edge) => edge.from === 'notes-check')?.map).toEqual({ ok: 'auto-approve', fail: 'notes-repair', error: 'notes-repair' });
    const repairMap = graph.edges.find((edge) => edge.from === 'notes-repair')?.map;
    expect(repairMap).toEqual({ ok: 'notes-recheck', fail: 'traffic-failed-restore', error: 'traffic-failed-restore' });
    const recheckMap = graph.edges.find((edge) => edge.from === 'notes-recheck')?.map;
    expect(recheckMap).toEqual({ ok: 'auto-approve', fail: 'traffic-failed-restore', error: 'traffic-failed-restore' });
    expect(Object.values(repairMap ?? {})).not.toContain('publish');
    expect(Object.values(recheckMap ?? {})).not.toContain('publish');
    expect(graph.nodes.find((node) => node.node_id === 'notes-repair')).toMatchObject({ kind: 'agent', recipe: 'cmd:docs', max_visits: 1 });
    expect(graph.nodes.find((node) => node.node_id === 'notes-recheck')).toMatchObject({ kind: 'gate', recipe: 'cmd:notes-check', max_visits: 1 });
  });

  test('notes-check fail fixture는 repair 노드 뒤 notes-check로 재진입한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'release-selfheal-recover-'));
    try {
      const { commands, runBash } = notesFixture(['fail', 'ok'], ['ok']);
      const state = await runGraph(graphPath, { input: { version: '9.9.9', previousVersion: '0.2.3' }, deps: { root, runBash } });
      expect(state.status).toBe('done');
      const notesCheckIndex = fullPassPath.indexOf('notes-check');
      expect(state.path).toEqual([...fullPassPath.slice(0, notesCheckIndex + 1), 'notes-repair', 'notes-recheck', ...fullPassPath.slice(notesCheckIndex + 1)]);
      expect(commands.filter((body) => body.includes('announce-loop/check-node.ts'))).toHaveLength(2);
      expect(state.nodes.filter((node) => node.nodeId === 'notes-repair')).toHaveLength(1);
      expect(state.nodes.filter((node) => node.nodeId === 'notes-recheck')).toHaveLength(1);
      expect(commands.some((body) => body.includes('publish-node.ts'))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('notes-check error fixture도 repair로 재진입한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'release-selfheal-error-'));
    try {
      const { runBash } = notesFixture(['error', 'ok'], ['ok']);
      const state = await runGraph(graphPath, { input: { version: '9.9.9', previousVersion: '0.2.3' }, deps: { root, runBash } });
      expect(state.status).toBe('done');
      const repairedAt = state.path.indexOf('notes-repair');
      expect(state.path.slice(repairedAt - 1, repairedAt + 2)).toEqual(['notes-check', 'notes-repair', 'notes-recheck']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('repair 실패 fixture는 publish에 도달하지 않는다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'release-selfheal-repair-fail-'));
    try {
      const { commands, runBash } = notesFixture(['fail'], ['fail']);
      const state = await runGraph(graphPath, { input: { version: '9.9.9', previousVersion: '0.2.3' }, deps: { root, runBash } });
      expect(state.status).toBe('failed');
      expect(state.path.slice(-4)).toEqual(['notes-check', 'notes-repair', 'traffic-failed-restore', 'failed']);
      expect(state.path).not.toContain('publish');
      expect(state.path).not.toContain('auto-approve');
      expect(commands.at(-2)).toContain('docs-node.ts');
      expect(commands.at(-1)).toContain('traffic-node.ts traffic-failed-restore');
      expect(commands.some((body) => body.includes('publish-node.ts'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('재검 실패 fixture는 publish에 도달하지 않는다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'release-selfheal-recheck-fail-'));
    try {
      const { commands, runBash } = notesFixture(['fail', 'fail'], ['ok']);
      const state = await runGraph(graphPath, { input: { version: '9.9.9', previousVersion: '0.2.3' }, deps: { root, runBash } });
      expect(state.status).toBe('failed');
      expect(state.path.slice(-5)).toEqual(['notes-check', 'notes-repair', 'notes-recheck', 'traffic-failed-restore', 'failed']);
      expect(state.path).not.toContain('publish');
      expect(commands.filter((body) => body.includes('announce-loop/check-node.ts'))).toHaveLength(2);
      expect(commands.some((body) => body.includes('publish-node.ts'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('기존 notes-check 성공 경로도 보존한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'release-selfheal-success-'));
    try {
      const { commands, runBash } = notesFixture(['ok']);
      const state = await runGraph(graphPath, { input: { version: '9.9.9', previousVersion: '0.2.3' }, deps: { root, runBash } });
      expect(state.status).toBe('done');
      expect(state.path).toEqual(fullPassPath);
      expect(state.path).not.toContain('notes-repair');
      expect(state.path).not.toContain('notes-recheck');
      expect(commands.filter((body) => body.includes('announce-loop/check-node.ts'))).toHaveLength(1);
      expect(commands.some((body) => body.includes('publish-node.ts'))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

test('approval resumes through publish, docs land, verify and dev bump with fake runner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-resume-'));
  const graph = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const commands: string[] = [];
  const fake = async (body: string) => {
    commands.push(body);
    const node = body.includes('version-node.ts release') ? 'version-release' : body.includes('prepare-node.ts') ? 'prepare'
      : body.includes('docs-node.ts') ? 'docs' : body.includes('publish-node.ts') ? 'publish' : 'other';
    const fields = node === 'version-release' ? { commit: 'a'.repeat(40) } : node === 'prepare'
      ? { commit: 'a'.repeat(40), candidate: join(root, 'elanous.tgz'), out: join(root, 'prepared') }
      : node === 'docs' ? { branch: 'release-docs/9.9.9', worktree: join(root, 'docs-tree') }
      : node === 'publish' ? { tag: 'v9.9.9' } : {};
    return { exitCode: body.includes('auto-approve-node.ts') ? 1 : 0, stdout: JSON.stringify({ outcome: body.includes('auto-approve-node.ts') ? 'fail' : 'ok', verdict: body.includes('auto-approve-node.ts') ? 'fail' : 'pass', summary: node, ...fields }) + '\n', stderr: '' };
  };
  try {
    const first = await runGraph(graph, { input: { version: '9.9.9', previousVersion: '0.2.3' }, deps: { root, runBash: fake } });
    expect(first.status).toBe('awaiting-approval');
    // Source: the regression suite adds one command to the existing preapproval release path.
    expect(commands).toHaveLength(23);
    decideGraphApproval(first.graphId, first.runId, 'approved', 'fake-approver', root);
    const resumed = await runGraph(graph, { resumeRunId: first.runId, deps: { root, runBash: fake } });
    expect(resumed.status).toBe('done');
    expect(resumed.path.slice(-12)).toEqual(['approve-publish', 'publish', 'npm-publish', 'traffic-npm-published', 'release-post-publish-join', 'verify', 'traffic-verify-complete', 'pwa-formal-update', 'vault-note', 'release-story', 'ops-upgrade', 'done']);
    // Source: the same regression suite command remains in the resumed release history.
    expect(commands).toHaveLength(34);
    expect(commands.some((command) => command.includes('publish-node.ts'))).toBe(true);
    expect(commands.some((command) => command.includes('npm-publish-node.ts'))).toBe(true);
    expect(commands.some((command) => command.includes('version-node.ts dev-bump'))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('real node entrypoints pass commit, candidate and worktree through graph contexts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-real-wiring-'));
  const bin = join(root, 'bin');
  const sha = 'a'.repeat(40);
  const graph = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const calls = join(root, 'calls');
  const trafficFile = join(root, 'traffic.json');
  const originalState = process.env.ELANOUS_STATE_DIR;
  try {
    mkdirSync(bin);
    writeFileSync(calls, '');
    writeFileSync(trafficFile, JSON.stringify({ global: 'green', seats: Object.fromEntries(['OP', 'TC', 'MK', 'UX'].map((seat) => [seat, { perCycle: 8 }])) }));
    const fixture = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.RELEASE_WIRING_ROOT;
const args = process.argv.slice(2);
const tool = path.basename(process.argv[1]);
fs.appendFileSync(path.join(root, 'calls'), tool + ' ' + args.join(' ') + '\\n');
const sha = 'a'.repeat(40);
if (tool === 'git') {
  if (args[0] === 'rev-parse') {
    const revision = args.includes('v0.2.3^{commit}') ? 'b'.repeat(40) : fs.existsSync(path.join(root,'dev-bump.done')) ? 'd'.repeat(40) : fs.existsSync(path.join(root,'release.done')) ? sha : 'c'.repeat(40);
    if (args[1] === 'HEAD' && JSON.parse(fs.readFileSync(path.join(process.cwd(),'package.json'),'utf8')).version === '0.2.5-dev.0') fs.writeFileSync(path.join(root,'dev-bump-head'), revision);
    console.log(revision);
  }
  else if (args[0] === 'show-ref') process.exit(1); // first docs attempt has no local release-docs branch
  else if (args[0] === 'ls-remote') {} // first docs attempt has no remote release-docs branch
  else if (args[0] === 'diff') console.log('release/public/docs/releases/0.2.4.md');
  else if (args[0] === 'show') {
    if (args[1] === 'origin/main:package.json') console.log(JSON.stringify({version:fs.existsSync(path.join(root,'dev-bump.done')) ? '0.2.5-dev.0' : fs.existsSync(path.join(root,'release.done')) ? '0.2.4' : '0.2.4-dev.0'}));
    else if (args[1].endsWith(':website/pages.json')) console.log(JSON.stringify({pages:[{id:'using-elanous/tasks-and-intake', source:'release/public/docs/tasks-and-intake.md'}]}));
    else console.log('# 0.2.4\\n\\n[Tasks and intake](tasks-and-intake.md)');
  } else if (args[0] === 'worktree' && args[1] === 'add') {
    const tree = args.includes('--detach') ? args[args.indexOf('--detach') + 1] : args[4];
    fs.mkdirSync(path.join(tree,'release/public/docs/releases'),{recursive:true});
    fs.mkdirSync(path.join(tree,'website'),{recursive:true});
    fs.writeFileSync(path.join(tree,'website/pages.json'),JSON.stringify({pages:[]}));
    if (fs.existsSync(path.join(tree,'release/public/docs/releases/0.2.4.md'))) process.exit(1);
    fs.writeFileSync(path.join(tree,'package.json'),JSON.stringify({name:'fixture',version:fs.existsSync(path.join(root,'release.done')) ? '0.2.4' : '0.2.4-dev.0'},null,2)+'\\n');
    fs.writeFileSync(path.join(tree,'bun.lock'),JSON.stringify({workspaces:{'':{name:'fixture',version:fs.existsSync(path.join(root,'release.done')) ? '0.2.4' : '0.2.4-dev.0',dependencies:{}}}}));
  } else if (args[0] === 'worktree' && args[1] === 'remove') fs.rmSync(args.at(-1),{recursive:true,force:true});
  else if (!['fetch','add','commit','push'].includes(args[0])) process.exit(1);
} else if (tool === 'bun') {
  if (args.includes('prepare')) {
    const out = args[args.indexOf('--out')+1];
    if (args[args.indexOf('--source')+1] !== sha || args[args.indexOf('--notes-from')+1] !== 'b'.repeat(40)) process.exit(1);
    fs.mkdirSync(path.join(out,'dist'),{recursive:true});
    fs.writeFileSync(path.join(out,'dist/elanous.tgz'),'candidate');
    for (const name of ['manifest.json','runtime.js','cli.js','package.json']) fs.writeFileSync(path.join(out,'dist',name),'fixture');
    fs.writeFileSync(path.join(root,'release/0.2.4/manifest.json'),JSON.stringify({version:'0.2.4',cutoff:{sha},in:[{sha:'a',title:'Release change',kind:'feat',line:'Release change'}]}));
    console.log(JSON.stringify({manifest:{version:'0.2.4',sourceCommit:sha,distDir:path.join(out,'dist')}}));
  } else if (args.includes('publish')) {
    if (!fs.existsSync(path.join(args[args.indexOf('--dir')+1],'dist/elanous.tgz'))) process.exit(1);
    if (!fs.readFileSync(args[args.indexOf('--notes-file')+1],'utf8').includes('https://docs.elanous.ai/using-elanous/tasks-and-intake')) process.exit(1);
    console.log(JSON.stringify({ok:true,published:true,tag:'v0.2.4',assets:[]}));
  } else if (args.includes('verify')) console.log(JSON.stringify({ok:true,notesPage:'ok'}));
  else if (args[1] === 'gh' && args[2] === 'pr' && args[3] === 'ready') console.log('✓ ready: 42');
  else if (args.includes('land') && args.includes('--hold')) console.log('✓ find: NONE\\n✓ upsert-ready: https://github.com/example/repo/pull/42 (새 PR)\\n✓ hold: https://github.com/example/repo/pull/42');
  else if (args.includes('land') && args.includes('--pr')) {
    const expectedHead = args[args.indexOf('--expected-head') + 1];
    if (expectedHead !== fs.readFileSync(path.join(root,'dev-bump-head'),'utf8')) process.exit(1);
    if (args.includes('--commit-message')) fs.writeFileSync(path.join(root,args[args.indexOf('--commit-message')+1] === 'release: 0.2.4' ? 'release.done' : 'dev-bump.done'),'yes');
    console.log('✓ merge: squash https://github.com/example/repo/pull/42');
  }
  else if (args.includes('land')) {
    if (args.includes('--commit-message')) fs.writeFileSync(path.join(root,'release.done'),'yes');
    console.log('✓ find: NONE\\n✓ upsert-ready: https://github.com/example/repo/pull/42 (새 PR)\\n✓ merge: squash https://github.com/example/repo/pull/42');
  }
  else if (args[0] !== 'install' && !args.some((arg) => arg.endsWith('deploy-pages.ts'))) process.exit(1);
} else if (tool === 'bash') console.log('ubuntu:24.04 [upgrade] verdict ok\\ndebian:12 [upgrade] verdict ok');
`;
    for (const tool of ['git', 'bun', 'bash']) {
      writeFileSync(join(bin, tool), fixture);
      chmodSync(join(bin, tool), 0o755);
    }
    process.env.ELANOUS_STATE_DIR = root;
    const env = { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}`, RELEASE_WIRING_ROOT: root,
      ELANOUS_STATE_DIR: root, ELANOUS_RELEASE_TRAFFIC_FILE: trafficFile };
    const real = async (body: string, opts: { env?: NodeJS.ProcessEnv }) => {
      const nodeId = body.includes('docs-node.ts') ? JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')).nodeId : undefined;
      if (nodeId === 'prefetch') {
        return { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass","summary":"prefetch fixture"}\n', stderr: '' };
      }
      // The tui node now enters through docs-node.ts (cache join → node-verdict.ts tui fallback); keep the costly TUI check isolated as before.
      if (nodeId === 'tui') {
        return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', verdict: 'pass', summary: 'isolated costly check' }) + '\n', stderr: '' };
      }
      if (body.includes('npm-publish-node.ts')) {
        return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', verdict: 'pass', npm: 'published', summary: 'isolated npm publish fixture' }) + '\n', stderr: '' };
      }
      if (body.includes('node-verdict.ts') || body.includes('gate-node.ts') || body.includes('gate-file-receipt-audit-node.ts') || body.includes('export-check-node.ts') || body.includes('pwa-formal-update-node.ts')) {
        return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', verdict: 'pass', summary: 'isolated costly check' }) + '\n', stderr: '' };
      }
      const run = spawnSync(process.execPath, [join(import.meta.dir, '../..', body.slice(4).split(' ')[0]!), ...body.slice(4).split(' ').slice(1)], {
        cwd: join(import.meta.dir, '../..'), encoding: 'utf8', env: { ...env, ELANOUS_GRAPH_CONTEXT: opts.env?.ELANOUS_GRAPH_CONTEXT },
      });
      return { exitCode: run.status ?? 2, stdout: run.stdout, stderr: run.stderr };
    };
    const first = await runGraph(graph, { input: { version: '0.2.4', previousVersion: '0.2.3' }, deps: { root, runBash: real } });
    expect(first.status).toBe('awaiting-approval');
    expect(first.path.slice(-2)).toEqual(['auto-approve', 'approve-publish']);
    expect(first.pending?.message).toContain('v0.2.4');
    expect(first.nodes.find((node) => node.nodeId === 'notes-check')?.ok).toBe(true);
    const nodeOutputs = first.nodes.filter((node) => node.output !== undefined).map((node) => [node.nodeId,
      JSON.parse(String(node.output).trim().split('\n').at(-1)!)] as const);
    const branchOutputs = Object.values(first.fanOuts ?? {}).flatMap((fanout) => Object.entries(fanout.branches)
      .filter(([, branch]) => branch.output !== undefined)
      .map(([branchId, branch]) => [branchId, JSON.parse(String(branch.output).trim().split('\n').at(-1)!)] as const));
    const outputs = Object.fromEntries([...nodeOutputs, ...branchOutputs]);
    expect(outputs['version-release'].commit).toBe(sha);
    expect(outputs.prepare.commit).toBe(sha);
    expect(outputs.prepare.candidate).toEndWith('dist/elanous.tgz');
    expect(outputs.docs.worktree).toEndWith('/tree');
    expect(JSON.parse(String(first.nodes.find((node) => node.nodeId === 'notes-check')?.output))).toMatchObject({ ok: true, checked: { files: 1 + outputs.docs.flipped.length } });
    expect(readFileSync(join(outputs.docs.worktree, 'release/public/docs/releases/0.2.4.md'), 'utf8')).toMatch(/^# 0\.2\.4\n\n## Behavior changes\n\n- Release change\n/);
    expect(JSON.parse(readFileSync(join(outputs.docs.worktree, 'website/pages.json'), 'utf8')).pages).toContainEqual(expect.objectContaining({ id: 'releases/0.2.4' }));
    decideGraphApproval(first.graphId, first.runId, 'approved', 'fixture-approver', root);
    const resumed = await runGraph(graph, { resumeRunId: first.runId, deps: { root, runBash: real } });
    expect(resumed.status).toBe('done');
    const transcript = readFileSync(calls, 'utf8');
    expect(transcript).toContain('pr land --commit-message release: 0.2.4');
    const devBumpHold = transcript.split('\n').find((line) => line.includes('pr land --commit-message version: 0.2.5-dev.0'));
    expect(devBumpHold).toContain('--hold');
    const devBumpHead = readFileSync(join(root, 'dev-bump-head'), 'utf8');
    const readyIndex = transcript.indexOf('gh pr ready 42');
    const pinnedLandIndex = transcript.indexOf('pr land --pr 42 --expected-head');
    expect(readyIndex).toBeGreaterThan(transcript.indexOf(devBumpHold!));
    expect(pinnedLandIndex).toBeGreaterThan(readyIndex);
    expect(transcript.slice(pinnedLandIndex).split('\n')[0]).toContain(`--expected-head ${devBumpHead}`);
    expect(transcript).toContain(`--candidate ${outputs.prepare.candidate}`);
    expect(transcript).toContain(`--cwd ${outputs.docs.worktree}`);
    expect(transcript).toContain('pr land --cwd');
    expect(transcript).toContain('release publish');
    const published = JSON.parse(String(resumed.nodes.find((node) => node.nodeId === 'publish')?.output).trim().split('\n').at(-1)!);
    expect(published.tag).toBe('v0.2.4');
    expect(transcript).toContain('release verify --version 0.2.4');
    expect(resumed.nodes.find((node) => node.nodeId === 'prepare')?.executed).toBe(true);
    const missing = { input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: { 'version-release': { commit: sha }, prepare: { outcome: 'ok', commit: sha } } };
    const badContext = join(root, 'missing-context.json');
    writeFileSync(badContext, JSON.stringify(missing));
    const rejected = spawnSync(process.execPath, [join(import.meta.dir, 'upgrade-node.ts')], { cwd: join(import.meta.dir, '../..'), encoding: 'utf8', env: { ...env, ELANOUS_GRAPH_CONTEXT: badContext } });
    expect(rejected.status).toBe(2);
    expect(JSON.parse(rejected.stdout.trim().split('\n').at(-1)!).summary).toContain('prepare.candidate required');
    writeFileSync(badContext, JSON.stringify({ ...missing, outputs: { ...missing.outputs, prepare: { outcome: 'ok', candidate: outputs.prepare.candidate } } }));
    const rejectedCommit = spawnSync(process.execPath, [join(import.meta.dir, 'upgrade-node.ts')], { cwd: join(import.meta.dir, '../..'), encoding: 'utf8', env: { ...env, ELANOUS_GRAPH_CONTEXT: badContext } });
    expect(rejectedCommit.status).toBe(2);
    expect(JSON.parse(rejectedCommit.stdout.trim().split('\n').at(-1)!).summary).toContain('prepare.commit required');
    writeFileSync(badContext, JSON.stringify({ ...missing, outputs: { ...missing.outputs, prepare: { outcome: 'ok', commit: sha, candidate: join(root, 'absent.tgz') } } }));
    const rejectedCandidate = spawnSync(process.execPath, [join(import.meta.dir, 'upgrade-node.ts')], { cwd: join(import.meta.dir, '../..'), encoding: 'utf8', env: { ...env, ELANOUS_GRAPH_CONTEXT: badContext } });
    expect(rejectedCandidate.status).toBe(2);
    expect(JSON.parse(rejectedCandidate.stdout.trim().split('\n').at(-1)!).summary).toContain('candidate missing');
    writeFileSync(badContext, JSON.stringify({ ...missing, outputs: { ...missing.outputs, prepare: { outcome: 'ok', commit: 'c'.repeat(40), candidate: outputs.prepare.candidate } } }));
    const rejectedMismatch = spawnSync(process.execPath, [join(import.meta.dir, 'upgrade-node.ts')], { cwd: join(import.meta.dir, '../..'), encoding: 'utf8', env: { ...env, ELANOUS_GRAPH_CONTEXT: badContext } });
    expect(rejectedMismatch.status).toBe(2);
    expect(JSON.parse(rejectedMismatch.stdout.trim().split('\n').at(-1)!).summary).toContain('prepare commit differs from release commit');
    const beforeMissingTree = readFileSync(calls, 'utf8');
    writeFileSync(badContext, JSON.stringify({ input: missing.input, outputs: { publish: { outcome: 'ok', tag: 'v0.2.4' }, docs: { outcome: 'ok', branch: 'release-docs/0.2.4' } } }));
    const rejectedTree = spawnSync(process.execPath, [join(import.meta.dir, 'docs-land-node.ts')], { cwd: join(import.meta.dir, '../..'), encoding: 'utf8', env: { ...env, ELANOUS_GRAPH_CONTEXT: badContext } });
    expect(rejectedTree.status).toBe(2);
    expect(JSON.parse(rejectedTree.stdout.trim().split('\n').at(-1)!).summary).toContain('docs.worktree required');
    expect(readFileSync(calls, 'utf8')).toBe(beforeMissingTree);
  } finally {
    if (originalState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = originalState;
    rmSync(root, { recursive: true, force: true });
  }
}, { timeout: 90_000 });

test('publish uses docs branch notes and page slugs when prerequisites pass', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-publish-success-'));
  const prior = process.env.ELANOUS_GRAPH_CONTEXT;
  const calls: Array<[string, string[]]> = [];
  try {
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ nodeId: 'publish', runId: 'fixture-run', input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: { 'approve-publish': recordApprovalFixture(),
      'version-release': { outcome: 'ok', commit: 'a'.repeat(40) }, gate: { outcome: 'ok' }, pwa: { outcome: 'ok' }, prepare: { outcome: 'ok', out: root, commit: 'a'.repeat(40) }, upgrade: { outcome: 'ok' }, tui: { outcome: 'ok' }, docs: { outcome: 'ok', branch: 'release-docs/0.2.4' },
    } });
    const result = runPublish((cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'git') return { status: 0, stderr: '', stdout: args[1]?.endsWith('pages.json') ? JSON.stringify({ pages: [{ id: 'using-elanous/tasks-and-intake', source: 'release/public/docs/tasks-and-intake.md' }] }) : '# 0.2.4\n\n[Tasks and intake](tasks-and-intake.md)\n' };
      const notes = readFileSync(args[args.indexOf('--notes-file') + 1]!, 'utf8');
      expect(notes).toContain('https://docs.elanous.ai/using-elanous/tasks-and-intake');
      expect(notes).not.toContain('.md)');
      return { status: 0, stderr: '', stdout: JSON.stringify({ ok: true, published: true, tag: 'v0.2.4', assets: [] }) };
    });
    expect(result.outcome).toBe('ok');
    expect(result.tag).toBe('v0.2.4');
    expect(calls.map(([cmd]) => cmd)).toEqual(['git', 'git', 'bun']);
    expect(calls.at(-1)?.[1]).toContain('--yes');
  } finally { if (prior === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = prior; rmSync(root, { recursive: true, force: true }); }
});

test('any failed prerequisite refuses publish without calling the release command', () => {
  const prior = process.env.ELANOUS_GRAPH_CONTEXT;
  try {
    for (const failed of ['gate', 'prepare', 'upgrade']) {
      const outputs: Record<string, unknown> = Object.fromEntries(['gate', 'prepare', 'upgrade', 'pwa', 'tui', 'docs'].map((node) => [node, { outcome: node === failed ? 'fail' : 'ok' }]));
      outputs['approve-publish'] = recordApprovalFixture();
      process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ nodeId: 'publish', runId: 'fixture-run', input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs });
      const result = runPublish(() => { throw new Error('release publish was called'); });
      expect(result).toMatchObject({ outcome: 'fail', verdict: 'fail' });
      expect(result.summary).toContain(failed);
    }
  } finally { if (prior === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = prior; }
});

test('publish accepts measured automatic approval but refuses incomplete metrics', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-auto-publish-'));
  const prior = process.env.ELANOUS_GRAPH_CONTEXT;
  try {
    const repo = join(root, 'repo');
    const out = join(root, 'release', '0.2.5', 'prepared');
    mkdirSync(join(out, 'dist'), { recursive: true });
    mkdirSync(repo);
    writeFileSync(join(repo, '.bun-version'), `${Bun.version}\n`);
    for (let i = 0; i < 5; i++) writeFileSync(join(out, 'dist', `install-${i}`), 'fixture');
    const input = { version: '0.2.5', previousVersion: '0.2.4' };
    const outputs: GraphContext['outputs'] = {
      'version-release': { outcome: 'ok', commit: 'a'.repeat(40) }, gate: { outcome: 'ok', introduced: [] }, pwa: { outcome: 'ok' },
      prepare: { outcome: 'ok', commit: 'a'.repeat(40), out }, upgrade: { outcome: 'ok' },
      tui: { outcome: 'ok', regress: { pass: 7, fail: 0,
        results: Array.from({ length: 7 }, (_, i) => ({ id: `R${i + 1}`, title: 'check', ok: true, reason: 'measured' })) } }, 'notes-check': { outcome: 'ok' },
      docs: { outcome: 'ok', notes: join(root, 'notes.md'), branch: 'release-docs/0.2.5' },
    };
    const approval = runAutoApprove({ runId: 'fixture-run', input, outputs }, { instanceRoot: root, repo });
    expect(approval).toMatchObject({ outcome: 'ok', decidedBy: 'release-loop metrics' });
    const metrics = approval.metrics;
    expect(metrics.some((metric) => metric.name === 'mac-smoke')).toBe(true);
    const publish = (approvalOutput: Record<string, unknown>, run: Parameters<typeof runPublish>[0]) => {
      process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ nodeId: 'publish', runId: 'fixture-run', input, outputs: { ...outputs, 'auto-approve': approvalOutput } });
      return runPublish(run);
    };
    const run = (cmd: string, args: string[]) => ({ status: 0, stderr: '', stdout: cmd === 'git'
      ? args[1]?.endsWith('pages.json') ? '{"pages":[]}' : '# 0.2.5\n\nBody\n'
      : '{"ok":true,"published":true,"tag":"v0.2.5","assets":[]}' });
    expect(publish(approval, run).outcome).toBe('ok');
    expect(publish({ ...approval, metrics: [...metrics, { name: 'mac-smoke', value: 'warn', verdict: 'pass' }] }, run).outcome).toBe('ok');
    const warningOnlyRow = metrics.find((metric) => metric.name === 'mac-smoke');
    expect(warningOnlyRow).toBeDefined();
    expect(publish({ ...approval, metrics: [...metrics, { ...warningOnlyRow!, name: 'tui-regress', value: 'warn' }] }, run).outcome).toBe('ok');
    for (const incomplete of [
      metrics.filter((metric) => metric.name !== 'installation files'),
      metrics.map((metric) => metric.name === 'installation files' ? { ...metric, verdict: 'unmeasured' as const } : metric),
    ]) {
      let calls = 0;
      const result = publish({ ...approval, metrics: incomplete }, (cmd, args) => {
        calls++;
        return run(cmd, args);
      });
      expect(result.outcome).toBe('fail');
      expect(calls).toBe(0);
    }
  } finally { if (prior === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = prior; rmSync(root, { recursive: true, force: true }); }
});

test('publish cannot report a tag that differs from the release CLI result', () => {
  const prior = process.env.ELANOUS_GRAPH_CONTEXT;
  try {
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ nodeId: 'publish', runId: 'fixture-run', input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: { 'approve-publish': recordApprovalFixture(),
      'version-release': { outcome: 'ok', commit: 'a'.repeat(40) }, gate: { outcome: 'ok' }, pwa: { outcome: 'ok' },
      prepare: { outcome: 'ok', commit: 'a'.repeat(40), out: '/tmp/prepared' }, upgrade: { outcome: 'ok' },
      tui: { outcome: 'ok' }, docs: { outcome: 'ok', branch: 'release-docs/0.2.4' },
    } });
    const run = (cmd: string, args: string[]) => ({ status: 0, stderr: '', stdout: cmd === 'git'
      ? args[1]?.endsWith('pages.json') ? JSON.stringify({ pages: [] }) : '# 0.2.4\n\nBody\n'
      : JSON.stringify({ ok: true, published: true, tag: 'v0.2.5', assets: [] }) });
    expect(() => runPublish(run)).toThrow('tag mismatch');
  } finally { if (prior === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = prior; }
});

test('publish refuses mismatched prepared commit without reading notes or calling release publish', () => {
  const prior = process.env.ELANOUS_GRAPH_CONTEXT;
  try {
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ nodeId: 'publish', runId: 'fixture-run', input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: { 'approve-publish': recordApprovalFixture(),
      'version-release': { outcome: 'ok', commit: 'a'.repeat(40) },
      gate: { outcome: 'ok' }, pwa: { outcome: 'ok' }, prepare: { outcome: 'ok', commit: 'b'.repeat(40), out: '/tmp/prepared' },
      upgrade: { outcome: 'ok' }, tui: { outcome: 'ok' }, docs: { outcome: 'ok', branch: 'release-docs/0.2.4' },
    } });
    expect(() => runPublish(() => { throw new Error('release publish was called'); })).toThrow('prepare commit differs from release commit');
  } finally { if (prior === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = prior; }
});

test('wrapper exit conventions distinguish failed command from incomplete run', () => {
  const prior = process.env.ELANOUS_GRAPH_CONTEXT;
  try {
    const context = { input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: { 'version-release': { commit: 'a'.repeat(40) }, gate: { outcome: 'ok' }, pwa: { outcome: 'ok' } } };
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify(context);
    const failed = runPrepare((command) => command === 'git' ? { status: 0, stdout: `${'b'.repeat(40)}\n`, stderr: '' } : { status: 1, stdout: '{"ok":false,"error":"build failed"}', stderr: '' });
    expect(failed).toMatchObject({ outcome: 'fail', verdict: 'fail' });
    expect(() => runPrepare((command) => command === 'git' ? { status: 0, stdout: `${'b'.repeat(40)}\n`, stderr: '' } : { status: 2, stdout: '', stderr: '' })).toThrow('prepare incomplete');
  } finally { if (prior === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = prior; }
});

test('publish refuses failed upgrade before running any release command', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-publish-'));
  const prior = process.env.ELANOUS_GRAPH_CONTEXT;
  let calls = 0;
  try {
    const file = join(root, 'context.json');
    writeFileSync(file, JSON.stringify({ nodeId: 'publish', runId: 'fixture-run', input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: { 'approve-publish': recordApprovalFixture(),
      gate: { outcome: 'ok' }, pwa: { outcome: 'ok' }, prepare: { outcome: 'ok' }, upgrade: { outcome: 'fail' }, tui: { outcome: 'ok' }, docs: { outcome: 'ok', branch: 'release-docs/0.2.4' },
    } }));
    process.env.ELANOUS_GRAPH_CONTEXT = file;
    const result = runPublish(() => { calls++; return { status: 0, stdout: '', stderr: '' }; });
    expect(result).toMatchObject({ outcome: 'fail', verdict: 'fail' });
    expect(result.summary).toContain('upgrade');
    expect(calls).toBe(0);
  } finally { if (prior === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = prior; rmSync(root, { recursive: true, force: true }); }
});

test('prepare uses prior tag commit and release commit from graph context', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-prepare-'));
  const prior = process.env.ELANOUS_GRAPH_CONTEXT;
  const calls: string[] = [];
  try {
    const sha = 'a'.repeat(40);
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: { 'version-release': { outcome: 'ok', commit: sha }, gate: { outcome: 'ok' }, pwa: { outcome: 'ok' } } });
    const result = runPrepare((cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      return cmd === 'git' ? { status: 0, stdout: `${'b'.repeat(40)}\n`, stderr: '' }
        : { status: 0, stdout: JSON.stringify({ manifest: { version: '0.2.4', sourceCommit: sha, distDir: join(args[args.indexOf('--out') + 1]!, 'dist') } }), stderr: '' };
    });
    expect(result.outcome).toBe('ok');
    expect(result.commit).toBe(sha);
    expect(calls[0]).toBe('git rev-parse --verify v0.2.3^{commit}');
    expect(calls[1]).toContain(`--source ${sha} --notes-from ${'b'.repeat(40)}`);
    expect(calls[1]).toContain('--out ');
  } finally { if (prior === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = prior; rmSync(root, { recursive: true, force: true }); }
});

test('graph docs refuses a missing upgrade output without generating documentation', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-docs-missing-upgrade-'));
  const notes = join(root, 'release/public/docs/releases/9.9.9.md');
  try {
    mkdirSync(join(root, 'release/9.9.9'), { recursive: true });
    mkdirSync(join(root, 'release/public/docs/releases'), { recursive: true });
    mkdirSync(join(root, 'website'), { recursive: true });
    writeFileSync(join(root, 'release/9.9.9/manifest.json'), JSON.stringify({ version: '9.9.9', in: [] }));
    writeFileSync(join(root, 'website/pages.json'), JSON.stringify({ pages: [] }));
    const graphContext = JSON.stringify({ input: { version: '9.9.9', previousVersion: '0.2.3', base: root }, outputs: { 'approve-publish': recordApprovalFixture(),
      gate: { outcome: 'ok' }, prepare: { outcome: 'ok' }, tui: { outcome: 'ok' },
    } });
    const run = spawnSync(process.execPath, [join(import.meta.dir, 'docs-node.ts'), '--json'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, ELANOUS_GRAPH_CONTEXT: graphContext, ELANOUS_STATE_DIR: root },
    });
    expect(run.status).toBe(1);
    const result = JSON.parse(run.stdout.trim().split('\n').at(-1)!);
    expect(result).toMatchObject({ outcome: 'error', verdict: 'fail' });
    expect(result.summary).toContain('upgrade did not pass');
    expect(readFileSync(join(root, 'website/pages.json'), 'utf8')).toBe('{"pages":[]}');
    expect(() => readFileSync(notes, 'utf8')).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('upgrade reports stderr-only failure reason', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-upgrade-stderr-'));
  const prior = process.env.ELANOUS_GRAPH_CONTEXT;
  try {
    const candidate = join(root, 'elanous.tgz');
    writeFileSync(candidate, 'fake');
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: { 'approve-publish': recordApprovalFixture(),
      prepare: { outcome: 'ok', candidate, commit: 'a'.repeat(40) }, 'version-release': { outcome: 'ok', commit: 'a'.repeat(40) },
    } });
    const result = runUpgrade(() => ({ status: 2, stdout: '', stderr: 'candidate archive cannot be opened\n' }));
    expect(result).toMatchObject({ outcome: 'error', verdict: 'fail' });
    expect(result.summary).toBe('upgrade failed (rc=2): candidate archive cannot be opened');
  } finally { if (prior === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = prior; rmSync(root, { recursive: true, force: true }); }
});

test('upgrade rejects incomplete verdict even on successful shell exit', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-upgrade-'));
  const prior = process.env.ELANOUS_GRAPH_CONTEXT;
  try {
    const candidate = join(root, 'elanous.tgz');
    writeFileSync(candidate, 'fake');
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: { prepare: { outcome: 'ok', candidate, commit: 'a'.repeat(40) }, 'version-release': { outcome: 'ok', commit: 'a'.repeat(40) } } });
    const result = runUpgrade(() => ({ status: 0, stdout: 'ubuntu:24.04 [upgrade] verdict ok\n', stderr: '' }));
    expect(result.outcome).toBe('fail');
    expect(result.summary).toContain('upgrade failed');
    const complete = runUpgrade(() => ({ status: 0, stdout: 'ubuntu:24.04  [upgrade] verdict ok\ndebian:12  [upgrade] verdict ok\n', stderr: '' }));
    expect(complete.outcome).toBe('ok');
    // 0.2.4: the check script appends `from= to=` after the verdict word.
    const suffixed = runUpgrade(() => ({ status: 0, stdout: 'ubuntu:24.04  [upgrade] verdict ok from=0.2.3 to=«0.2.4 0b373c7»\ndebian:12  [upgrade] verdict ok from=0.2.3 to=«0.2.4 0b373c7»\n', stderr: '' }));
    expect(suffixed.outcome).toBe('ok');
    const notOk = runUpgrade(() => ({ status: 0, stdout: 'ubuntu:24.04  [upgrade] verdict okay\ndebian:12  [upgrade] verdict ok\n', stderr: '' }));
    expect(notOk.outcome).not.toBe('ok');
  } finally { if (prior === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = prior; rmSync(root, { recursive: true, force: true }); }
});

test('docs land requires publish; after merge deploy precedes cleanup', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-docs-'));
  const prior = process.env.ELANOUS_GRAPH_CONTEXT;
  const calls: string[] = [];
  try {
    const context = { input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: { publish: { outcome: 'fail', tag: 'v0.2.4' }, docs: { branch: 'release-docs/0.2.4', worktree: join(root, 'tree') } } };
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify(context);
    expect(() => runDocsLand(() => { throw new Error('called before publish'); })).toThrow('publish must succeed');
    context.outputs.publish.outcome = 'ok';
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify(context);
    mkdirSync(join(root, 'tree'));
    const result = runDocsLand((cmd, args, cwd) => {
      calls.push(`${cmd} ${args.join(' ')} @ ${cwd ?? '.'}`);
      if (cmd === 'git' && args[0] === 'cat-file') return { status: 1, stdout: '', stderr: '' };   // 노트가 아직 main 에 없다
      return { status: 0, stdout: cmd === 'git' && args[0] === 'rev-parse' ? 'a'.repeat(40) : cmd === 'bun' && args.includes('land') ? '✓ find: NONE\n✓ upsert-ready: https://github.com/example/pull/1 (새 PR)\n✓ merge: squash https://github.com/example/pull/1' : '', stderr: '' };
    });
    expect(result.outcome).toBe('ok');
    context.outputs.publish.tag = 'v0.2.5';
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify(context);
    expect(() => runDocsLand(() => { throw new Error('land called for wrong tag'); })).toThrow('published tag/version mismatch');
    expect(calls.slice(0, 8).map((s) => s.split(' ')[0])).toEqual(['git', 'git', 'bun', 'git', 'git', 'git', 'bun', 'bun']);
    expect(calls[0]).toContain('fetch origin main');
    expect(calls[1]).toContain('cat-file -e origin/main:release/public/docs/releases/0.2.4.md');
    expect(calls[2]).toContain(`--cwd ${join(root, 'tree')}`);
    expect(calls[3]).toContain('fetch origin main');
    expect(calls[5]).toContain(`worktree add --detach`);
    expect(calls[5]).toContain('a'.repeat(40));
    expect(calls[6]).toContain('install --frozen-lockfile');
    expect(calls[7]).toContain('deploy-pages.ts --remote node-b --yes @ ');
    expect(calls[7]).toContain('/release-docs-deploy-');
    expect(calls.at(-1)).toContain('worktree remove --force');
  } finally { if (prior === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = prior; rmSync(root, { recursive: true, force: true }); }
});

test('pr land creates a missing docs PR before merging it', async () => {
  const calls: string[] = [];
  const lines: string[] = [];
  const url = 'https://github.com/example/repo/pull/42';
  const cwd = '/tmp/release-docs-fixture/tree';
  const run: CmdRunner = (command, args) => {
    if (command === 'gh' && args[0] === 'pr') {
      calls.push(`gh ${args.slice(0, 2).join(' ')}`);
      if (args[1] === 'list') return { ok: true, out: '' };
      if (args[1] === 'create') {
        expect(args).toContain('--head');
        expect(args).toContain('release-docs/0.2.4');
        expect(args).toContain('--base');
        expect(args).toContain('main');
        return { ok: true, out: url };
      }
      if (args[1] === 'merge') return { ok: true, out: '' };
      if (args[1] === 'view') return { ok: false, out: '' };
    }
    if (command === 'git' && args.includes('push')) calls.push('git push');
    return { ok: true, out: command === 'git' && args.includes('rev-list') ? '1' : command === 'git' && args[0] === 'remote' && args[1] === 'get-url' ? 'https://github.com/example/repo.git' : '' };
  };
  const code = await runPrLand({ cwd }, {
    manager: makePrManager(run), currentBranch: () => 'release-docs/0.2.4', resolveBase: () => 'origin/main',
    run,
    listUnfinishedRuns: () => [], listOpenPrs: () => [], isInteractive: () => false,
    queryRunningRuns: () => ({ entries: [] }) as never,
    runTypecheckGate: () => true, runIsolationGate: () => true, runMockModuleRestoreGate: () => true,
    runModelHardcodeGate: () => true, runDaemonPortGate: () => true, runPublicLeakGate: () => 0,
    runTestInterferenceGate: async () => 0, runAndroidGate: () => true, runIosGate: () => true, runPwaGate: () => true,
    out: { log: (line) => lines.push(line), error: (line) => lines.push(line) },
  });
  expect(code).toBe(0);
  expect(calls).toEqual(['gh pr list', 'git push', 'gh pr list', 'gh pr create', 'gh pr merge', 'gh pr view', 'gh pr view']);
  expect(lines.some((line) => line.includes('✓ upsert-ready:') && line.includes('(새 PR)'))).toBe(true);
  expect(lines.some((line) => line.includes('✓ merge: squash'))).toBe(true);
});

test('docs land refuses an upsert-only response without merge and never deploys', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-docs-'));
  const prior = process.env.ELANOUS_GRAPH_CONTEXT;
  const calls: string[] = [];
  try {
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: { 'approve-publish': recordApprovalFixture(),
      publish: { outcome: 'ok', tag: 'v0.2.4' }, docs: { branch: 'release-docs/0.2.4', worktree: join(root, 'tree') },
    } });
    mkdirSync(join(root, 'tree'));
    expect(() => runDocsLand((cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'git' && args[0] === 'cat-file') return { status: 1, stdout: '', stderr: '' };
      return { status: 0, stdout: '✓ upsert-ready: https://github.com/example/pull/1 (새 PR)', stderr: '' };
    })).toThrow('docs land incomplete');
    expect(calls.filter((c) => c.startsWith('bun '))).toEqual([`bun bin/elanous.mjs pr land --cwd ${join(root, 'tree')}`]);
  } finally { if (prior === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = prior; rmSync(root, { recursive: true, force: true }); }
});

test('verify requires deployed docs and a live release notes page', () => {
  const prior = process.env.ELANOUS_GRAPH_CONTEXT;
  try {
    const context = { input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: { 'docs-land': { outcome: 'fail' }, publish: { outcome: 'ok', tag: 'v0.2.4' } } };
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify(context);
    expect(() => runVerify(() => { throw new Error('called before deploy'); })).toThrow('docs must land');
    context.outputs['docs-land'].outcome = 'ok';
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify(context);
    expect(runVerify(() => ({ status: 0, stdout: JSON.stringify({ ok: true, notesPage: 'missing' }), stderr: '' })).outcome).toBe('fail');
    expect(runVerify(() => ({ status: 0, stdout: JSON.stringify({ ok: true, notesPage: 'ok' }), stderr: '' })).outcome).toBe('ok');
    context.outputs.publish.tag = 'v0.2.5';
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify(context);
    expect(() => runVerify(() => { throw new Error('verify called for wrong tag'); })).toThrow('published tag/version mismatch');
  } finally { if (prior === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = prior; }
});

test('publish body resolves flat markdown links through pages slug', () => {
  const pages = { pages: [{ id: 'using-elanous/tasks-and-intake', source: 'release/public/docs/tasks-and-intake.md' }] };
  const body = publicNotes('# 0.2.4\n\n[Tasks and intake](tasks-and-intake.md)\n', pages);
  expect(body).toContain('[Tasks and intake](https://docs.elanous.ai/using-elanous/tasks-and-intake)');
  expect(body).not.toContain('.md)');
  expect(body).not.toContain('# 0.2.4');
});


test('publish refuses when approve-publish did not approve, without calling any command', () => {
  const calls: string[] = [];
  const previous = process.env.ELANOUS_GRAPH_CONTEXT;
  try {
    for (const approval of [undefined, { outcome: 'rejected' }, null]) {
      const outputs: Record<string, unknown> = Object.fromEntries(['gate', 'prepare', 'upgrade', 'pwa', 'tui', 'docs'].map((node) => [node, { outcome: 'ok' }]));
      if (approval !== undefined) outputs['approve-publish'] = approval;
      process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ nodeId: 'publish', runId: 'fixture-run', input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs });
      const result = runPublish((cmd, args) => { calls.push(`${cmd} ${args.join(' ')}`); return { status: 0, stdout: '', stderr: '' }; });
      expect(result.outcome).toBe('fail');
      expect(result.summary).toContain('approve-publish');
    }
    expect(calls).toEqual([]);
  } finally { if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = previous; }
});


test('docs land retry: notes already on main → skip pr land and resume at deploy', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-docs-'));
  const prior = process.env.ELANOUS_GRAPH_CONTEXT;
  const calls: string[] = [];
  try {
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs: {
      publish: { outcome: 'ok', tag: 'v0.2.4' }, docs: { branch: 'release-docs/0.2.4', worktree: join(root, 'tree') } } });
    const result = runDocsLand((cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      return { status: 0, stdout: cmd === 'git' && args[0] === 'rev-parse' ? 'b'.repeat(40) : '', stderr: '' };   // cat-file 0 = 이미 main 에 있다 · 워크트리는 앞 판이 지웠다
    });
    expect(result.outcome).toBe('ok');
    expect(calls.some((c) => c.includes('pr land'))).toBe(false);
    expect(calls.some((c) => c.includes('deploy-pages.ts --remote node-b --yes'))).toBe(true);
  } finally { if (prior === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = prior; rmSync(root, { recursive: true, force: true }); }
});
