import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph } from '../../src/graph-runner/runner.js';
import type { GraphContext } from './node-verdict.js';
import { runTrafficNode } from './traffic-node.js';
import { applyReleaseTrafficEvent, type TrafficFile } from './traffic-transition.js';

const GRAPH = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
const TRAFFIC_NODES = new Set(['traffic-cut-start', 'traffic-gate-passed', 'traffic-npm-published', 'traffic-verify-complete', 'traffic-failed-restore']);

async function scenario(failNode?: 'pwa' | 'docs-land') {
  const root = mkdtempSync(join(tmpdir(), 'release-traffic-events-'));
  const trafficFile = join(root, 'traffic.json');
  const initial: TrafficFile = {
    global: 'green', reason: 'operator-policy', extra: { untouched: true },
    seats: Object.fromEntries(['OP', 'TC', 'MK', 'UX'].map(seat => [seat, { perCycle: 8, keep: seat }])),
  };
  writeFileSync(trafficFile, JSON.stringify(initial));
  const snapshots = new Map<string, TrafficFile>();
  const reports: string[] = [];
  try {
    const runBash = async (command: string, options: { env?: NodeJS.ProcessEnv }) => {
        const env = options.env ?? {};
        const location = env.ELANOUS_GRAPH_CONTEXT!;
        const context = JSON.parse(location.trimStart().startsWith('{') ? location : readFileSync(location, 'utf8')) as GraphContext;
        if (TRAFFIC_NODES.has(context.nodeId ?? '')) {
          expect(command).toBe(`bun scripts/release-loop/traffic-node.ts ${context.nodeId}`);
          const lines: string[] = [];
          const prior = console.log;
          console.log = (value?: unknown) => { lines.push(String(value ?? '')); };
          let exitCode: number;
          try {
            exitCode = await runTrafficNode(context.nodeId, { ...env, ELANOUS_GRAPH_CONTEXT: JSON.stringify(context) },
              { options: { trafficFile }, report: body => reports.push(body) });
          } finally { console.log = prior; }
          snapshots.set(context.nodeId!, JSON.parse(readFileSync(trafficFile, 'utf8')) as TrafficFile);
          return { exitCode, stdout: `${lines.at(-1)}\n`, stderr: '' };
        }
        const failed = context.nodeId === failNode;
        return { exitCode: failed ? 1 : 0,
          stdout: JSON.stringify({ outcome: failed ? 'fail' : 'ok', verdict: failed ? 'fail' : 'pass', summary: 'fixture' }) + '\n', stderr: '' };
      };
    const state = await runGraph(GRAPH, {
      input: { version: '0.2.38-rc.1', previousVersion: '0.2.37' },
      deps: { root, runBash },
    });
    return { state, initial, snapshots, reports, trafficFile,
      resume: (fromNodeId: string) => runGraph(GRAPH, { resumeRunId: state.runId, fromNodeId, deps: { root, runBash } }),
      cleanup: () => rmSync(root, { recursive: true, force: true }) };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}

test('graph events move gate → half → full and reject an old run', async () => {
  const run = await scenario();
  try {
    expect(run.state.status).toBe('done');
    expect(run.snapshots.get('traffic-cut-start')?.global).toBe('gate');
    expect(run.snapshots.get('traffic-gate-passed')?.global).toBe('yellow');
    expect(run.snapshots.get('traffic-gate-passed')?.seats.OP.perCycle).toBe(3);
    expect(run.snapshots.get('traffic-npm-published')?.global).toBe('green');
    expect(run.snapshots.get('traffic-npm-published')?.seats.OP.perCycle).toBe(6);
    expect(run.snapshots.get('traffic-verify-complete')?.releaseLifecycle).toMatchObject({ runId: run.state.runId, stage: 2 });
    const before = readFileSync(run.trafficFile, 'utf8');
    expect(await applyReleaseTrafficEvent({ runId: 'old-run', startedAt: '2026-10-01T00:00:00Z',
      input: { version: '0.2.37', previousVersion: '0.2.36' }, outputs: {} }, 'failed', { trafficFile: run.trafficFile }))
      .toMatchObject({ applied: false, reason: 'different-run-is-current' });
    expect(readFileSync(run.trafficFile, 'utf8')).toBe(before);
  } finally { run.cleanup(); }
});

test('a failure before npm publish restores the exact pre-cut mode', async () => {
  const run = await scenario('pwa');
  try {
    expect(run.state.path).toContain('traffic-failed-restore');
    const restored = run.snapshots.get('traffic-failed-restore')!;
    expect(restored.global).toBe(run.initial.global);
    expect(restored.seats.OP.perCycle).toBe(8);
    expect(restored.reason).toBe(run.initial.reason);
    expect(restored.extra).toEqual(run.initial.extra);
    expect(restored.releaseLifecycle).toMatchObject({ runId: run.state.runId, stage: 3, event: 'failed' });
    const before = readFileSync(run.trafficFile, 'utf8');
    expect(await applyReleaseTrafficEvent({ runId: run.state.runId, startedAt: run.state.startedAt,
      input: { version: '0.2.38-rc.1', previousVersion: '0.2.37' }, outputs: {} }, 'gate-passed', { trafficFile: run.trafficFile }))
      .toMatchObject({ applied: false, reason: 'run-already-failed' });
    expect(readFileSync(run.trafficFile, 'utf8')).toBe(before);
    expect(await applyReleaseTrafficEvent({ runId: run.state.runId, startedAt: run.state.startedAt, nodeId: 'traffic-gate-passed',
      input: { version: '0.2.38-rc.1', previousVersion: '0.2.37' }, outputs: {} }, 'gate-passed', { trafficFile: run.trafficFile }))
      .toMatchObject({ applied: true, stage: 1 });
    expect((JSON.parse(readFileSync(run.trafficFile, 'utf8')) as TrafficFile).seats.OP.perCycle).toBe(3);
    expect(await applyReleaseTrafficEvent({ runId: run.state.runId, startedAt: run.state.startedAt, nodeId: 'traffic-npm-published',
      input: { version: '0.2.38-rc.1', previousVersion: '0.2.37' }, outputs: { 'npm-publish': { outcome: 'ok' } } }, 'npm-published', { trafficFile: run.trafficFile }))
      .toMatchObject({ applied: true, stage: 2 });
  } finally { run.cleanup(); }
});

test('a failure after npm publish keeps full traffic and reports the follow-up failure', async () => {
  const run = await scenario('docs-land');
  try {
    expect(run.state.path).toContain('traffic-npm-published');
    expect(run.state.path).toContain('traffic-failed-restore');
    const published = run.snapshots.get('traffic-failed-restore')!;
    expect(published.global).toBe('green');
    expect(published.seats.OP.perCycle).toBe(6);
    expect(published.releaseLifecycle).toMatchObject({ runId: run.state.runId, stage: 2, event: 'npm-published' });
    expect(run.reports.some(body => body.includes('published-keeps-full'))).toBe(true);
  } finally { run.cleanup(); }
});

test('a same-run retry from traffic-cut-start reopens the gate after restoration', async () => {
  const run = await scenario('pwa');
  try {
    expect(await applyReleaseTrafficEvent({ runId: run.state.runId, startedAt: run.state.startedAt, nodeId: 'traffic-cut-start',
      input: { version: '0.2.38-rc.1', previousVersion: '0.2.37' }, outputs: {} }, 'cut-start', { trafficFile: run.trafficFile }))
      .toMatchObject({ applied: true, stage: 0 });
    const file = JSON.parse(readFileSync(run.trafficFile, 'utf8')) as TrafficFile;
    expect(file.global).toBe('gate');
    expect(file.releaseLifecycle?.beforeCut?.global).toBe(run.initial.global);
  } finally { run.cleanup(); }
});

test('graph resume reruns the cut node and restores traffic again after a second failure', async () => {
  const run = await scenario('pwa');
  try {
    const resumed = await run.resume('traffic-cut-start');
    expect(resumed.status).toBe('failed');
    expect(resumed.path).toContain('traffic-cut-start');
    expect(resumed.path.slice(-3)).toEqual(['pwa', 'traffic-failed-restore', 'failed']);
    expect(run.snapshots.get('traffic-cut-start')?.global).toBe('gate');
    const restored = JSON.parse(readFileSync(run.trafficFile, 'utf8')) as TrafficFile;
    expect(restored.global).toBe(run.initial.global);
    expect(restored.seats.OP.perCycle).toBe(8);
    expect(restored.releaseLifecycle).toMatchObject({ runId: run.state.runId, event: 'failed', stage: 3 });
  } finally { run.cleanup(); }
});

test('a failure without a cut record reports missing baseline without changing traffic', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-traffic-no-cut-'));
  const trafficFile = join(root, 'traffic.json');
  const before = JSON.stringify({ global: 'yellow', seats: Object.fromEntries(['OP', 'TC', 'MK', 'UX'].map(seat => [seat, { perCycle: 4 }])) });
  try {
    writeFileSync(trafficFile, before);
    expect(await applyReleaseTrafficEvent({ runId: 'run-no-cut', nodeId: 'traffic-failed-restore',
      input: { version: '0.2.38-rc.1', previousVersion: '0.2.37' }, outputs: {} }, 'failed', { trafficFile }))
      .toMatchObject({ applied: false, reason: 'before-cut-unmeasured' });
    expect(readFileSync(trafficFile, 'utf8')).toBe(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a later run of the same version retains the first pre-cut baseline', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-traffic-retry-baseline-'));
  const trafficFile = join(root, 'traffic.json');
  const initial: TrafficFile = { global: 'green', seats: Object.fromEntries(['OP', 'TC', 'MK', 'UX'].map(seat => [seat, { perCycle: 8 }])) };
  const first = { runId: 'first-run', startedAt: '2026-10-25T00:00:00Z', input: { version: '0.2.38-rc.1', previousVersion: '0.2.37' }, outputs: {} };
  const next = { runId: 'second-run', startedAt: '2026-10-25T01:00:00Z', input: first.input, outputs: {} };
  try {
    writeFileSync(trafficFile, JSON.stringify(initial));
    expect((await applyReleaseTrafficEvent(first, 'cut-start', { trafficFile })).applied).toBe(true);
    expect((await applyReleaseTrafficEvent(first, 'gate-passed', { trafficFile })).applied).toBe(true);
    expect((await applyReleaseTrafficEvent(next, 'cut-start', { trafficFile })).applied).toBe(true);
    const retried = JSON.parse(readFileSync(trafficFile, 'utf8')) as TrafficFile;
    expect(retried.releaseLifecycle?.beforeCut).toMatchObject({ global: 'green', perCycle: { OP: 8 } });
    expect((await applyReleaseTrafficEvent(next, 'failed', { trafficFile })).applied).toBe(true);
    const restored = JSON.parse(readFileSync(trafficFile, 'utf8')) as TrafficFile;
    expect(restored.global).toBe('green');
    expect(restored.seats.OP.perCycle).toBe(8);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('verify success can repair a missed full transition after a same-run retry', async () => {
  const run = await scenario('pwa');
  try {
    expect(await applyReleaseTrafficEvent({ runId: 'later-run', startedAt: '2026-10-26T01:00:00Z',
      nodeId: 'traffic-verify-complete', input: { version: '0.2.38-rc.1', previousVersion: '0.2.37' }, outputs: {} },
    'verify-complete', { trafficFile: run.trafficFile }))
      .toMatchObject({ applied: false, reason: 'npm-publish-unconfirmed' });
    expect(await applyReleaseTrafficEvent({ runId: run.state.runId, startedAt: run.state.startedAt,
      nodeId: 'traffic-verify-complete', input: { version: '0.2.38-rc.1', previousVersion: '0.2.37' },
      outputs: { 'npm-publish': { outcome: 'ok' } } }, 'verify-complete', { trafficFile: run.trafficFile }))
      .toMatchObject({ applied: true, stage: 2 });
    const file = JSON.parse(readFileSync(run.trafficFile, 'utf8')) as TrafficFile;
    expect(file.global).toBe('green');
    expect(file.seats.OP.perCycle).toBe(6);
  } finally { run.cleanup(); }
});
