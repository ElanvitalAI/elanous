import { expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph } from '../../src/graph-runner/runner.js';
import { parse as parseYaml } from 'yaml';
import type { GraphContext } from './node-verdict.js';
import { runTrafficNode } from './traffic-node.js';
import { applyReleaseTrafficEvent, trafficOptionsFromConfig, type TrafficFile } from './traffic-transition.js';

const GRAPH = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
const RECIPES = join(import.meta.dir, '../../graphs/release/recipes.yaml');

// The graph test launches the actual traffic recipe as a child Bun process, including under gate-pod load.
setDefaultTimeout(60_000);

test('named release graph lowers traffic after gate and restores it only after verify succeeds', async () => {
  const graph = parseYaml(readFileSync(GRAPH, 'utf8')) as {
    nodes: Array<{ node_id: string; kind: string; recipe?: string }>;
    edges: Array<{ from: string; on: string; map: Record<string, string> }>;
  };
  const recipes = parseYaml(readFileSync(RECIPES, 'utf8')) as Record<string, { command: string }>;
  const edge = (from: string) => graph.edges.find((item) => item.from === from && item.on === 'outcome')?.map;
  const gateTraffic = 'traffic-gate-passed';
  const verifyTraffic = 'traffic-verify-complete';

  expect(edge('gate')).toMatchObject({ ok: gateTraffic, fail: 'gate-triage', error: 'gate-triage' });
  expect(edge(gateTraffic)).toEqual({ ok: 'mac-smoke', fail: 'mac-smoke', error: 'mac-smoke' });
  expect(edge('verify')).toMatchObject({ ok: verifyTraffic, fail: 'version-dev-bump-after-failure', error: 'version-dev-bump-after-failure' });
  expect(edge(verifyTraffic)).toEqual({ ok: 'vault-note', fail: 'vault-note', error: 'vault-note' });

  for (const [nodeId, recipeId] of [[gateTraffic, 'traffic-gate-passed'], [verifyTraffic, 'traffic-verify-complete']]) {
    const node = graph.nodes.find((item) => item.node_id === nodeId);
    expect(node).toMatchObject({ kind: 'gate', recipe: `cmd:${recipeId}` });
    expect(recipes[recipeId]?.command).toBe(`bun scripts/release-loop/traffic-node.ts ${nodeId}`);
  }

  const root = mkdtempSync(join(tmpdir(), 'release-traffic-graph-'));
  const trafficFile = join(root, 'traffic.json');
  const initial: TrafficFile = {
    global: 'yellow', reason: 'preserve-reason', updatedAt: 'preserve-time', extra: { preserve: true },
    seats: { ...Object.fromEntries(['OP', 'TC', 'MK', 'UX'].map((seat) => [seat, { perCycle: 8, keep: seat }])), EXTRA: 17 as unknown as Record<string, unknown> },
  };
  writeFileSync(trafficFile, JSON.stringify(initial));
  let afterGate: TrafficFile | undefined;
  let afterVerify: TrafficFile | undefined;
  try {
    const state = await runGraph(GRAPH, {
      input: { version: '0.2.34-rc.2', previousVersion: '0.2.33' },
      deps: {
        root,
        runBash: async (command, options) => {
          const env = options.env ?? {};
          const contextPath = env.ELANOUS_GRAPH_CONTEXT!;
          const context = JSON.parse(contextPath.trimStart().startsWith('{') ? contextPath : readFileSync(contextPath, 'utf8')) as GraphContext;
          if (context.nodeId === gateTraffic || context.nodeId === verifyTraffic) {
            const recipeId = context.nodeId === gateTraffic ? 'traffic-gate-passed' : 'traffic-verify-complete';
            expect(command).toBe(recipes[recipeId]?.command);
            const [executable, ...args] = command.split(/\s+/);
            const run = spawnSync(executable!, args, {
              cwd: join(import.meta.dir, '../..'), encoding: 'utf8',
              env: { ...process.env, ...env, ELANOUS_RELEASE_TRAFFIC_FILE: trafficFile, ELANOUS_STATE_DIR: join(root, 'state') },
            });
            if (run.status !== 0 || run.error) throw new Error(`traffic recipe failed: ${context.nodeId}: ${run.stderr || run.error || run.status}`);
            const snapshot = JSON.parse(readFileSync(trafficFile, 'utf8')) as TrafficFile;
            if (context.nodeId === gateTraffic) afterGate = snapshot;
            else afterVerify = snapshot;
            return { exitCode: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
          }
          return { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass","summary":"fixture"}\n', stderr: '' };
        },
      },
    });

    expect(state.status).toBe('done');
    expect(state.path).toContain(gateTraffic);
    expect(state.path).toContain(verifyTraffic);
    expect(afterGate).toMatchObject({ global: 'yellow', reason: 'preserve-reason', updatedAt: 'preserve-time' });
    expect(['OP', 'TC', 'MK', 'UX'].every((seat) => afterGate?.seats[seat]?.perCycle === 3)).toBe(true);
    expect(afterVerify).toMatchObject({ global: 'green', reason: 'preserve-reason', updatedAt: 'preserve-time', extra: { preserve: true } });
    expect(['OP', 'TC', 'MK', 'UX'].every((seat) => afterVerify?.seats[seat]?.perCycle === 6 && afterVerify.seats[seat]?.keep === seat)).toBe(true);
    expect(afterVerify?.seats.EXTRA as unknown).toBe(17);
    expect(afterVerify?.releaseLifecycle).toMatchObject({ runId: state.runId, version: '0.2.34-rc.2', stage: 2, event: 'verify-complete', startedAt: state.startedAt });

    const sameRunContext: GraphContext = { runId: state.runId, input: { version: '0.2.34-rc.2', previousVersion: '0.2.33' }, outputs: {} };
    const beforeSameRunReplay = readFileSync(trafficFile, 'utf8');
    expect(await applyReleaseTrafficEvent(sameRunContext, 'gate-passed', { trafficFile })).toMatchObject({ applied: true, stage: 2, reason: 'already-applied' });
    expect(readFileSync(trafficFile, 'utf8')).toBe(beforeSameRunReplay);

    const previousContext: GraphContext = { runId: `older-${state.runId}`, input: { version: '0.2.33', previousVersion: '0.2.32' }, outputs: {} };
    const before = readFileSync(trafficFile, 'utf8');
    expect(await applyReleaseTrafficEvent(previousContext, 'gate-passed', { trafficFile })).toMatchObject({ applied: false, reason: 'different-run-is-current' });
    expect(readFileSync(trafficFile, 'utf8')).toBe(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('traffic writer failure reports to OP and records fail while graph warning edges continue', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-traffic-writer-failure-'));
  const reports: string[] = [];
  const context: GraphContext = {
    nodeId: 'traffic-gate-passed', runId: 'failed-writer-run',
    input: { version: '0.2.34', previousVersion: '0.2.33' }, outputs: {},
  };
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (line?: unknown) => output.push(String(line ?? ''));
  try {
    const exitCode = await runTrafficNode(context.nodeId, {
      ELANOUS_GRAPH_CONTEXT: JSON.stringify(context), ELANOUS_STATE_DIR: root,
    }, {
      options: { trafficFile: join(root, 'missing-traffic.json') },
      report: (body) => reports.push(body),
    });
    expect(exitCode).toBe(1);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('traffic file does not exist');
    expect(reports[0]).toContain('failed-writer-run');
    const result = JSON.parse(output.at(-1)!) as { outcome: string; verdict: string; summary: string };
    expect(result).toMatchObject({ outcome: 'fail', verdict: 'fail' });
    expect(result.summary).toContain('release graph continues with warning');
  } finally { console.log = originalLog; rmSync(root, { recursive: true, force: true }); }
});

test('an ignored gate event reports that the traffic reduction was not applied', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-traffic-stale-gate-'));
  const trafficFile = join(root, 'traffic.json');
  writeFileSync(trafficFile, JSON.stringify({
    global: 'yellow',
    seats: Object.fromEntries(['OP', 'TC', 'MK', 'UX'].map((seat) => [seat, { perCycle: 8 }])),
    releaseLifecycle: {
      runId: 'newer-run', version: '0.2.35', stage: 1, event: 'gate-passed',
      startedAt: '2026-10-19T01:00:00.000Z', updatedAt: '2026-10-19T01:10:00.000Z',
    },
  } satisfies TrafficFile));
  const stale: GraphContext = {
    nodeId: 'traffic-gate-passed', runId: 'stale-run', startedAt: '2026-10-19T00:00:00.000Z',
    input: { version: '0.2.34', previousVersion: '0.2.33' }, outputs: {},
  };
  const reports: string[] = [];
  try {
    expect(await runTrafficNode('traffic-gate-passed', {
      ELANOUS_GRAPH_CONTEXT: JSON.stringify(stale), ELANOUS_STATE_DIR: root,
    }, {
      options: { trafficFile }, report: (body) => reports.push(body),
    })).toBe(1);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('stale-run');
    expect(reports[0]).toContain('different-run-is-current');
    expect(JSON.parse(readFileSync(trafficFile, 'utf8'))).toMatchObject({ releaseLifecycle: { runId: 'newer-run' } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a same-version retry replaces an incomplete gate run and rejects its late verify', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-traffic-retry-'));
  const trafficFile = join(root, 'traffic.json');
  writeFileSync(trafficFile, JSON.stringify({
    global: 'yellow',
    seats: Object.fromEntries(['OP', 'TC', 'MK', 'UX'].map((seat) => [seat, { perCycle: 8 }])),
  } satisfies TrafficFile));
  const prior: GraphContext = { runId: 'first-attempt', startedAt: '2026-10-19T00:00:00.000Z', input: { version: '0.2.34-rc.2', previousVersion: '0.2.33' }, outputs: { 'npm-publish': { outcome: 'ok' } } };
  const retry: GraphContext = { runId: 'retry-attempt', startedAt: '2026-10-19T01:00:00.000Z', input: { version: '0.2.34-rc.2', previousVersion: '0.2.33' }, outputs: { 'npm-publish': { outcome: 'ok' } } };
  try {
    expect(await applyReleaseTrafficEvent(prior, 'gate-passed', { trafficFile }))
      .toMatchObject({ applied: true, stage: 1 });
    expect(await applyReleaseTrafficEvent(retry, 'gate-passed', { trafficFile }))
      .toMatchObject({ applied: true, stage: 1 });
    const retryState = JSON.parse(readFileSync(trafficFile, 'utf8')) as TrafficFile;
    expect(retryState.releaseLifecycle).toMatchObject({ runId: 'retry-attempt', version: '0.2.34-rc.2', stage: 1 });
    expect(['OP', 'TC', 'MK', 'UX'].every((seat) => retryState.seats[seat]?.perCycle === 3)).toBe(true);

    const beforeLateVerify = readFileSync(trafficFile, 'utf8');
    expect(await applyReleaseTrafficEvent(prior, 'verify-complete', { trafficFile }))
      .toMatchObject({ applied: false, reason: 'different-run-is-current' });
    expect(readFileSync(trafficFile, 'utf8')).toBe(beforeLateVerify);

    expect(await applyReleaseTrafficEvent(retry, 'verify-complete', { trafficFile }))
      .toMatchObject({ applied: true, stage: 2 });
    const verified = JSON.parse(readFileSync(trafficFile, 'utf8')) as TrafficFile;
    expect(verified.global).toBe('green');
    expect(['OP', 'TC', 'MK', 'UX'].every((seat) => verified.seats[seat]?.perCycle === 6)).toBe(true);

    const nextRetry: GraphContext = { runId: 'post-verify-retry', startedAt: '2026-10-19T02:00:00.000Z', input: retry.input, outputs: {} };
    const beforeCompletedRetry = readFileSync(trafficFile, 'utf8');
    expect(await applyReleaseTrafficEvent(nextRetry, 'gate-passed', { trafficFile }))
      .toMatchObject({ applied: false, stage: 2, reason: 'different-run-is-current' });
    expect(readFileSync(trafficFile, 'utf8')).toBe(beforeCompletedRetry);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('legacy traffic policy overrides do not change fixed rates', () => {
  const options = trafficOptionsFromConfig({}, {
    trafficFile: '/tmp/release-traffic-fixed-rates.json', trafficHalfPerCycle: 1, trafficFullPerCycle: 2,
  } as Parameters<typeof trafficOptionsFromConfig>[1]);
  expect(options).toEqual({ trafficFile: '/tmp/release-traffic-fixed-rates.json' });
});

test('blank traffic path values fall through and nonblank values are trimmed', () => {
  for (const envValue of ['', '   ']) {
    expect(trafficOptionsFromConfig({ ELANOUS_RELEASE_TRAFFIC_FILE: envValue }, {
      trafficFile: '/config/traffic.json',
    } as Parameters<typeof trafficOptionsFromConfig>[1])).toEqual({ trafficFile: '/config/traffic.json' });
  }
  expect(trafficOptionsFromConfig({ ELANOUS_RELEASE_TRAFFIC_FILE: ' /env/traffic.json ' }, {
    trafficFile: '/config/traffic.json',
  } as Parameters<typeof trafficOptionsFromConfig>[1])).toEqual({ trafficFile: '/env/traffic.json' });
  expect(trafficOptionsFromConfig({}, { trafficFile: ' /config/traffic.json ' } as Parameters<typeof trafficOptionsFromConfig>[1]))
    .toEqual({ trafficFile: '/config/traffic.json' });
  expect(trafficOptionsFromConfig({}, { trafficFile: '   ' } as Parameters<typeof trafficOptionsFromConfig>[1])).toEqual({});
  expect(trafficOptionsFromConfig({}, { trafficFile: { unexpected: true } } as unknown as Parameters<typeof trafficOptionsFromConfig>[1])).toEqual({});
});

test('traffic transition has no implicit production file path and records a skipped node', async () => {
  expect(trafficOptionsFromConfig({}, {})).toEqual({});
  const context: GraphContext = {
    nodeId: 'traffic-gate-passed', runId: 'unconfigured-run',
    input: { version: '0.2.34', previousVersion: '0.2.33' }, outputs: {},
  };
  const output: string[] = [];
  const reports: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { output.push(args.map(String).join(' ')); };
  try {
    expect(await runTrafficNode(context.nodeId, { ELANOUS_GRAPH_CONTEXT: JSON.stringify(context) }, {
      options: {}, report: (body) => reports.push(body),
    })).toBe(1);
  } finally { console.log = originalLog; }
  expect(output.some((line) => line.includes('traffic-file-unset: gate-passed skipped'))).toBe(true);
  expect(JSON.parse(output.at(-1)!).outcome).toBe('fail');
  expect(reports).toHaveLength(1);
  expect(reports[0]).toContain('traffic-file-unset');
});

test('a verified run recovers traffic after OP clears an earlier gate write lock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-traffic-gate-write-failure-'));
  const trafficFile = join(root, 'traffic.json');
  writeFileSync(trafficFile, JSON.stringify({
    global: 'yellow',
    seats: Object.fromEntries(['OP', 'TC', 'MK', 'UX'].map((seat) => [seat, { perCycle: 3 }])),
    releaseLifecycle: {
      runId: 'earlier-attempt', version: '0.2.34-rc.2', stage: 1, event: 'gate-passed',
      startedAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:10:00.000Z',
    },
  } satisfies TrafficFile));
  const current: GraphContext = {
    nodeId: 'traffic-verify-complete', runId: 'verified-attempt', startedAt: '2026-10-19T01:00:00.000Z',
    input: { version: '0.2.34-rc.2', previousVersion: '0.2.33' }, outputs: { 'npm-publish': { outcome: 'ok' } },
  };
  const reports: string[] = [];
  try {
    mkdirSync(`${trafficFile}.lock.d`);
    writeFileSync(`${trafficFile}.lock.d/pid`, `${process.pid}\n`);
    expect(await runTrafficNode('traffic-gate-passed', {
      ELANOUS_GRAPH_CONTEXT: JSON.stringify({ ...current, nodeId: 'traffic-gate-passed' }), ELANOUS_STATE_DIR: root,
    }, {
      options: { trafficFile, lockTimeoutMs: 20 },
      report: (body) => reports.push(body),
    })).toBe(1);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('verified-attempt');
    expect(reports[0]).toContain('traffic-lock-timeout');
    expect(reports[0]).toContain('stale 의심 경로');
    rmSync(`${trafficFile}.lock.d`, { recursive: true, force: true });

    expect(await applyReleaseTrafficEvent(current, 'verify-complete', { trafficFile }))
      .toMatchObject({ applied: true, stage: 2 });
    const recovered = JSON.parse(readFileSync(trafficFile, 'utf8')) as TrafficFile;
    expect(recovered.global).toBe('green');
    expect(['OP', 'TC', 'MK', 'UX'].every((seat) => recovered.seats[seat]?.perCycle === 6)).toBe(true);
    expect(recovered.releaseLifecycle).toMatchObject({ runId: 'verified-attempt', stage: 2 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the TypeScript traffic writer leaves a suspected stale lock for OP to inspect', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-traffic-stale-lock-'));
  const trafficFile = join(root, 'traffic.json');
  writeFileSync(trafficFile, JSON.stringify({
    global: 'yellow',
    seats: Object.fromEntries(['OP', 'TC', 'MK', 'UX'].map((seat) => [seat, { perCycle: 8 }])),
  } satisfies TrafficFile));
  const lock = `${trafficFile}.lock.d`;
  mkdirSync(lock);
  writeFileSync(`${lock}/pid`, '2147483647\n');
  const staleTime = new Date(Date.now() - 120_000);
  utimesSync(lock, staleTime, staleTime);
  const before = readFileSync(trafficFile, 'utf8');
  try {
    await expect(applyReleaseTrafficEvent({
      runId: 'stale-lock-operator-recovery', input: { version: '0.2.34', previousVersion: '0.2.33' }, outputs: {},
    }, 'gate-passed', { trafficFile, lockTimeoutMs: 20 })).rejects.toThrow('traffic lock timeout');
    expect(readFileSync(`${lock}/pid`, 'utf8')).toBe('2147483647\n');
    expect(readFileSync(trafficFile, 'utf8')).toBe(before);
    expect(readdirSync(root).some((name) => name.includes('.lock.d.stale.'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
