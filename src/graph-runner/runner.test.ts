import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setPluginCredentials } from '../plugins/install/plugin-credentials.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { decideGraphApproval, latestGraphRun, listGraphRuns, manageGraphRun, releaseNodeFailureDetail, resolveUnit, runGraph, runGraphClassifyNode, verifyReleaseCommandRoot, type GraphRunOptions } from './runner.js';
import { classifyReworkBudgetShadow } from '../self-implement/classify-shadow.js';
import { createReworkBudgetJudgment, REWORK_BUDGET_JUDGMENT } from '../self-implement/rework-budget-judgment.js';
import { getElanousConfigDir, resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { debug } from '../debug/log.js';
import { subscribeInsideEvent } from '../nexus/api/inside-events.js';
import { readFailureInbox, recordFailureEvent } from '../self-implement/heal-intake.js';
import { runSelfImplement } from '../self-implement/orchestrator.js';
import { seams } from '../self-implement/test-seams.js';
import type { DecisionEntry } from '../decisions/decision-ledger.js';
import { createGraphEventBus, publishNodeGraphEvent } from './graph-events.js';
import { classifyGateShadow } from '../../scripts/release-loop/gate-triage-node.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('release export-check failure detail classifies marker, tool and timeout and scrubs absolute paths', () => {
  expect(releaseNodeFailureDetail(JSON.stringify({ outcome: 'fail', summary: 'export failed', tail: 'absolute-home-path /Users/alice/work/repo/src/app.ts:17' }), '/Users/alice/work/repo', (value) => value))
    .toMatchObject({ kind: 'export-detection', markers: ['absolute-home-path'], locations: ['<repo>/src/app.ts:17'] });
  expect(releaseNodeFailureDetail(JSON.stringify({ outcome: 'error', summary: 'export tool failed', diagnostics: ['scripts/public-export.ts:42 TS9999: missing input'] }), '/repo', (value) => value))
    .toMatchObject({ kind: 'tool-error', markers: [], locations: ['scripts/public-export.ts:42'] });
  expect(releaseNodeFailureDetail(JSON.stringify({ outcome: 'fail', summary: 'PWA build timed out', tail: 'ETIMEDOUT after 300000ms' }), '/repo', (value) => value))
    .toMatchObject({ kind: 'timeout', stderrTail: 'ETIMEDOUT after 300000ms', markers: [], locations: [] });
});

test('release export-check failures preserve scrubbed details in run output and debug events', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-failure-detail-sim-'));
  dirs.push(root);
  const previousState = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = root;
  const pluginDir = join(root, 'plugins', 'local', 'failure-detail-plugin', '1.0.0');
  const graphsDir = join(pluginDir, 'graphs');
  mkdirSync(graphsDir, { recursive: true });
  writeFileSync(join(pluginDir, 'plugin.ts'), 'export default {}');
  writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ id: 'failure-detail-plugin', version: '1.0.0', main: './plugin.ts',
    contributes: { connectors: [{ id: 'service', fields: [{ name: 'TOKEN', env: 'FAILURE_DETAIL_TOKEN' }] }] } }));
  setPluginCredentials('failure-detail-plugin', { TOKEN: 'secret-token' }, root);
  writeFileSync(join(graphsDir, 'recipes.yaml'), 'export-check:\n  command: "fake export check"\n');
  const graph = join(graphsDir, 'failure-detail.yaml');
  writeFileSync(graph, [
    'graph_id: release-failure-detail-sim', 'version: 1', 'entry_node: export-check', 'terminal_nodes: [done, failed]', 'nodes:',
    '  - { node_id: export-check, kind: agent, recipe: "cmd:export-check", max_visits: 1 }',
    '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }',
    '  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }',
    'edges:', '  - { from: export-check, on: outcome, map: { ok: done, fail: failed } }', '',
  ].join('\n'));
  const cases: Array<{ runId: string; payload: Record<string, unknown>; kind: string; marker?: string; location?: string; extraLocations?: string[] }> = [
    { runId: 'export-marker', payload: { outcome: 'fail', summary: 'export detected leaks', tail: 'absolute-home-path /Users/alice/private/repo/src/app.ts:17 token=secret-token', 'secret-token': 'credential as object key', nested: { '/tmp/a/file.ts': 'first path value', '/tmp/b/file.ts': 'second path value' } }, kind: 'export-detection', marker: 'absolute-home-path' },
    { runId: 'tool-error', payload: { outcome: 'error', summary: 'export tool failed', diagnostics: ['/tmp/build/src/export.ts:42 TS5101: missing input', 'C:\\Users\\builder\\work\\src\\export.ts:44 TS1001: windows path', '\\\\server\\private\\src\\export.ts:45 TS1002: network path', 'diagnostic:/tmp/build/src/entry.ts:43 TS1003: colon path', 'diagnostic->/tmp/secret-token/src/leak.ts:46 TS1004: secret path'] }, kind: 'tool-error', location: '<absolute-path>/export.ts:42', extraLocations: ['<absolute-path>/export.ts:44', '<absolute-path>/entry.ts:43', '<absolute-path>/leak.ts:46'] },
    { runId: 'timeout', payload: { outcome: 'fail', summary: 'PWA build timeout', tail: 'ETIMEDOUT /tmp/private/build.ts:9 token=secret-token' }, kind: 'timeout', location: '<absolute-path>/build.ts:9' },
  ];
  (cases[1]!.payload.diagnostics as string[]).push('diagnostic-/tmp/private/file.ts:47 TS1005: hyphen separator');
  (cases[1]!.payload.diagnostics as string[]).push('diagnostic./tmp/private/dot.ts:48 TS1006: dot separator');
  cases[1]!.extraLocations!.push('<absolute-path>/file.ts:47', '<absolute-path>/dot.ts:48');
  try {
    for (const item of cases) {
      const result = await runGraph(graph, { runId: item.runId, deps: { root, runBash: async () => ({ stdout: JSON.stringify(item.payload), stderr: '', exitCode: 1 }) } });
      const node = result.nodes.find((record) => record.nodeId === 'export-check');
      const output = JSON.parse(String(node?.output ?? '{}')) as Record<string, any>;
      expect(output.failureDetail).toMatchObject({ kind: item.kind });
      if (item.marker) expect(output.failureDetail.markers).toContain(item.marker);
      if (item.location) expect(output.failureDetail.locations).toContain(item.location);
      for (const location of item.extraLocations ?? []) expect(output.failureDetail.locations).toContain(location);
      if (item.runId === 'export-marker') {
        expect(Object.values(output.nested as Record<string, string>).sort()).toEqual(['first path value', 'second path value']);
      }
      expect(JSON.stringify(node)).not.toContain('secret-token');
      expect(JSON.stringify(node)).not.toContain('/Users/');
      expect(JSON.stringify(node)).not.toContain('/tmp/');
      const event = debug.events(500).find((entry) => entry.category === 'release-loop.node' && entry.event === 'failed' && (entry.data as any)?.runId === item.runId);
      expect(event?.data).toMatchObject({ kind: item.kind, markers: output.failureDetail.markers, locations: output.failureDetail.locations });
      expect((event?.data as any)?.stderrTail).toBeTruthy();
      if (item.marker) expect((event?.data as any)?.markers).toContain(item.marker);
      if (item.location) expect((event?.data as any)?.locations).toContain(item.location);
      for (const location of item.extraLocations ?? []) expect((event?.data as any)?.locations).toContain(location);
      expect((event?.data as any)?.stderrTail).toContain(item.marker ?? (item.runId === 'timeout' ? 'ETIMEDOUT' : 'TS5101'));
      expect(JSON.stringify(event?.data)).not.toContain('secret-token');
      expect(JSON.stringify(event?.data)).not.toContain('/Users/');
      expect(JSON.stringify(event?.data)).not.toContain('/tmp/');
    }
    const longSuccess = await runGraph(graph, { runId: 'long-success', deps: { root, runBash: async () => ({ stdout: JSON.stringify({ outcome: 'ok', note: 'x'.repeat(1_500) }), stderr: '', exitCode: 0 }) } });
    const longOutput = JSON.parse(String(longSuccess.nodes.find((record) => record.nodeId === 'export-check')?.output ?? '{}')) as Record<string, string>;
    expect(longOutput.note).toHaveLength(1_500);
  } finally {
    if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previousState;
  }
  expect(releaseNodeFailureDetail(JSON.stringify({ outcome: 'fail', summary: 'already scrubbed', tail: '<repo>/src/app.ts:17' }), '/Users/alice/work/repo', (value) => value))
    .toMatchObject({ locations: ['<repo>/src/app.ts:17'], stderrTail: '<repo>/src/app.ts:17' });
  expect(releaseNodeFailureDetail(JSON.stringify({ outcome: 'fail', summary: 'already scrubbed', tail: '<absolute-path>/app.ts:17' }), '/Users/alice/work/repo', (value) => value))
    .toMatchObject({ locations: ['<absolute-path>/app.ts:17'], stderrTail: '<absolute-path>/app.ts:17' });
});

function runGraphWithGrowthScope(path: string, options: GraphRunOptions = {}): ReturnType<typeof runGraph> {
  return runGraph(path, { ...options, deps: { ...options.deps, growthScope: 'task-agent' } });
}

async function withIsolatedClassifyState<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'graph-classify-state-'));
  dirs.push(root);
  const previous = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = root;
  try { return await run(root); }
  finally {
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previous;
  }
}

test('self-implement consumers run the same persisted classify node and preserve verdicts', async () => withIsolatedClassifyState(async (root) => {
  const before = new Set(listGraphRuns(root).runs.map(run => run.statePath));
  const seen: string[] = [];
  const shadow = await classifyReworkBudgetShadow('BUDGET: EXTEND', async ({ prompt }) => {
    seen.push(prompt);
    return 'EXTEND';
  });
  const judgment = await createReworkBudgetJudgment(async ({ prompt }) => {
    seen.push(prompt);
    return 'EXTEND';
  })(REWORK_BUDGET_JUDGMENT, { kind: 'review', goal: 'fix' });
  expect(shadow).toMatchObject({ picked: 'EXTEND', ok: true });
  expect(judgment).toMatchObject({ output: 'EXTEND', verdict: 'continue', ok: true });
  expect(seen).toHaveLength(2);
  const runs = listGraphRuns(root).runs.filter(run => run.graphId === 'self-implement-classify' && !before.has(run.statePath));
  expect(runs).toHaveLength(2);
  const shadowRun = runs.find(run => (run.input as { caller?: string }).caller === 'rework-budget-shadow');
  const judgmentRun = runs.find(run => (run.input as { caller?: string }).caller === 'rework-budget-judgment');
  expect((shadowRun?.input as { arguments: string }).arguments).toBe('BUDGET: EXTEND');
  expect((judgmentRun?.input as { arguments: string }).arguments).toContain('"observations"');
  const observed = debug.events(500).filter(entry => entry.category === 'graph.classify' && entry.event === 'node-result' &&
    runs.some(run => run.runId === (entry.data as { runId?: string }).runId));
  expect(observed.map(entry => (entry.data as { caller: string }).caller).sort()).toEqual(['rework-budget-judgment', 'rework-budget-shadow']);
  for (const entry of observed) {
    const run = runs.find(candidate => candidate.runId === (entry.data as { runId: string }).runId)!;
    expect(entry.data).toMatchObject({ nodeId: 'classify', caller: (run.input as { caller: string }).caller,
      input: (run.input as { arguments: string }).arguments, verdict: 'EXTEND', output: 'EXTEND', ok: true });
  }
  for (const run of [shadowRun, judgmentRun]) {
    expect(run?.nodes[0]).toMatchObject({ nodeId: 'classify', ok: true, executed: true });
    expect(run?.input).toMatchObject({ arguments: expect.any(String), classify: { classes: expect.arrayContaining(['EXTEND']) } });
    expect(JSON.parse(run?.nodes[0]?.output as string)).toMatchObject({ input: (run?.input as { arguments: string }).arguments,
      verdict: 'EXTEND', output: 'EXTEND', ok: true });
    expect(JSON.parse(readFileSync(run!.statePath, 'utf8')).nodes[0].output).toBe(run?.nodes[0]?.output);
  }
}));

test('isolated self-implement rework round records matching shadow and judgment classify ledgers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-classify-round-'));
  dirs.push(root);
  const previous = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = root;
  const observations: Array<{ event: string; data: Record<string, unknown> }> = [];
  try {
    await runSelfImplement({ feature: 'classify production rework round', maxReworkRounds: 1, memory: false,
      seams: seams({ gateResults: [false, true],
        diagnose: async () => 'BUDGET: EXTEND\nREASON: retry the narrow fix',
        classifyCallLLM: async () => 'EXTEND',
        writeRunLedger: entry => { observations.push({ event: entry.event, data: entry.data }); },
      }),
    });
    const budget = observations.find(entry => entry.event === 'rework-budget');
    expect(budget?.data).toMatchObject({ verdict: 'EXTEND', evidence: { modelReasoning: 'EXTEND' } });
    const fabric = observations.find(entry => entry.event === 'rework-budget-fabric-shadow');
    expect(fabric?.data).toMatchObject({ runId: budget?.data.runId, legacyVerdict: 'EXTEND', fabricPicked: 'EXTEND', agree: true });
    const runs = listGraphRuns(root).runs.filter(run => run.graphId === 'self-implement-classify');
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      const saved = JSON.parse(readFileSync(run.statePath, 'utf8'));
      expect(saved).toMatchObject({ status: 'done', path: ['classify', 'done'],
        input: { arguments: expect.any(String), classify: { classes: expect.arrayContaining(['EXTEND']) } },
        nodes: [{ nodeId: 'classify', ok: true, executed: true }, { nodeId: 'done' }],
      });
      expect(JSON.parse(saved.nodes[0].output)).toMatchObject({ input: saved.input.arguments,
        verdict: 'EXTEND', output: 'EXTEND', ok: true });
    }
    expect(runs.some(run => (run.input as { arguments: string }).arguments.startsWith('BUDGET: EXTEND'))).toBe(true);
    expect(runs.some(run => (run.input as { arguments: string }).arguments.includes('"observations"'))).toBe(true);
    expect(runs.map(run => (run.input as { caller?: string }).caller).sort()).toEqual(['rework-budget-judgment', 'rework-budget-shadow']);
    expect(typeof budget?.data.runId).toBe('string');
    // Replayable receipt for the cell's «실물» box: GRAPH_CLASSIFY_RECEIPT=1 prints the saved ledgers this production round wrote.
    if (process.env.GRAPH_CLASSIFY_RECEIPT === '1') {
      for (const run of runs) {
        const saved = JSON.parse(readFileSync(run.statePath, 'utf8'));
        console.log(`[receipt] ${JSON.stringify({ runId: saved.runId, status: saved.status, path: saved.path, caller: saved.input.caller,
          input: saved.input.arguments, classes: saved.input.classify.classes, classifyNode: JSON.parse(saved.nodes[0].output) })}`);
      }
      console.log(`[receipt] ${JSON.stringify({ ledger: 'rework-budget', verdict: budget?.data.verdict })}`);
      console.log(`[receipt] ${JSON.stringify({ ledger: 'rework-budget-fabric-shadow', legacyVerdict: fabric?.data.legacyVerdict,
        fabricPicked: fabric?.data.fabricPicked, agree: fabric?.data.agree })}`);
    }
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previous;
  }
}, 20_000);

test('graph classify wraps workflow retries, unknown and failures without changing the result', async () => withIsolatedClassifyState(async (root) => {
  const node = { id: 'classify', classify: { input: '$ARGUMENTS', classes: ['EXTEND'], retries: 1, retryDelayMs: 0 } };
  const ctx = { arguments: 'evidence', artifactsDir: '', outputs: {}, resolvedProvider: undefined, resolvedModel: undefined, toolPolicy: {} };
  let attempts = 0;
  const resolved = await runGraphClassifyNode(node, ctx, async () => ++attempts === 1 ? 'not sure' : 'EXTEND');
  expect(resolved).toMatchObject({ ok: true, output: 'EXTEND' });
  expect(attempts).toBe(2);
  const unknown = await runGraphClassifyNode(node, ctx, async () => 'not sure');
  expect(unknown).toMatchObject({ ok: true, output: 'unknown' });
  const failed = await runGraphClassifyNode(node, ctx, async () => { throw new Error('offline'); });
  expect(failed).toMatchObject({ ok: false, output: 'unknown', error: 'offline' });
  const ledger = latestGraphRun('self-implement-classify', root);
  expect(JSON.parse(ledger!.nodes[0]!.output as string)).toMatchObject({ input: 'evidence', verdict: 'unknown', output: 'unknown', error: 'offline' });
  expect(ledger?.path).toEqual(['classify', 'failed']);
}));

test('graph classify node keeps dry runs off the LLM and records the real verdict', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-classify-dry-'));
  dirs.push(root);
  const graph = join(root, 'classify.yaml');
  writeFileSync(join(root, 'recipes.yaml'), '{}\n');
  writeFileSync(graph, ['graph_id: classify-dry', 'version: 1', 'entry_node: classify', 'terminal_nodes: [done, failed]', 'nodes:',
    '  - { node_id: classify, kind: classify, recipe: none, max_visits: 1 }',
    '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }',
    '  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }',
    'edges:', '  - { from: classify, on: outcome, map: { ok: done, fail: failed } }', ''].join('\n'));
  const input = { arguments: 'evidence', classify: { input: '$ARGUMENTS', classes: ['EXTEND'] } };
  let calls = 0;
  const callLLM = async () => { calls++; return 'EXTEND'; };
  const dry = await runGraph(graph, { input, dryRun: true, deps: { root, callLLM } });
  expect(calls).toBe(0);
  expect(dry.nodes[0]).toMatchObject({ nodeId: 'classify', executed: false });
  expect(dry.nodes[0]?.output).toBeUndefined();
  const real = await runGraph(graph, { input, deps: { root, callLLM } });
  expect(calls).toBe(1);
  expect(real).toMatchObject({ status: 'done', path: ['classify', 'done'] });
  expect(JSON.parse(real.nodes[0]!.output as string)).toMatchObject({ verdict: 'EXTEND', ok: true });
});

test('unit resolver discovers verb units in nested graphs/units/verbs', () => {
  const unit = resolveUnit('verb-make-doc@1', join(process.cwd(), 'graphs/work/research-report.yaml'));
  expect(unit.path).toBe(join(process.cwd(), 'graphs/units/verbs/make-doc.yaml'));
});

test('release command root accepts a clean checkout with 25k tracked paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-command-root-25k-'));
  try {
    execFileSync('git', ['init', '--quiet', root]);
    for (let index = 0; index < 25_000; index++) {
      writeFileSync(join(root, `tracked-${String(index).padStart(5, '0')}-${'x'.repeat(40)}`), '');
    }
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=release-root-test', '-c', 'user.email=release-root-test@invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: root });

    const cutTip = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    expect(verifyReleaseCommandRoot(root, cutTip)).toBe(realpathSync(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);

function fixture(command: string, loop = false): { graph: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'graph-runner-'));
  dirs.push(root);
  writeFileSync(join(root, 'recipes.yaml'), `first:\n  command: "${command}"\nsecond:\n  command: "exit 0"\n`);
  const graph = join(root, 'graph.yaml');
  writeFileSync(graph, `graph_id: test-graph\nversion: 1\nentry_node: first\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: first, kind: agent, recipe: 'cmd:first', max_visits: 1 }\n  - { node_id: second, kind: agent, recipe: 'cmd:second', max_visits: 1 }\n  - { node_id: done, kind: gate, max_visits: 1 }\n  - { node_id: failed, kind: gate, max_visits: 1 }\nedges:\n  - from: first\n    on: outcome\n    map: { ok: ${loop ? 'first' : 'second'}, fail: failed }\n  - from: second\n    on: outcome\n    map: { ok: done, fail: failed }\n`);
  return { graph, root };
}

test('graph runner emits node lifecycle phases and isolates failing observer hooks', async () => {
  const { graph, root } = fixture('printf first');
  const events: Array<{ phase: string; nodeId: string; visit: number; nextNodeId?: string }> = [];
  const envelope: Array<{ eventId: string; seq: number; source: string; phase: string; attempt: number; data: { phase: string; visit: number } }> = [];
  const failures: Array<{ event: string; data: Record<string, unknown> }> = [];
  const unsubscribe = subscribeInsideEvent((event) => {
    if (event.kind === 'node.lifecycle') events.push({ phase: String(event.phase), nodeId: String(event.nodeId), visit: Number(event.visit),
      ...(typeof event.nextNodeId === 'string' ? { nextNodeId: event.nextNodeId } : {}) });
  });
  try {
    const run = await runGraph(graph, { deps: { root,
      nodeLifecycle: (event) => { envelope.push(event); throw new Error('release-loop observer unavailable'); },
      log: (event, data) => { if (event === 'node-lifecycle-hook-failed') failures.push({ event, data }); },
    } });
    expect(run.status).toBe('done');
  } finally { unsubscribe(); }
  expect(events.map(({ nodeId, phase }) => `${nodeId}:${phase}`)).toEqual([
    'first:arrival', 'first:start', 'first:end', 'first:leave',
    'second:arrival', 'second:start', 'second:end', 'second:leave',
    'done:arrival', 'done:start', 'done:end', 'done:leave',
  ]);
  expect(events.find((event) => event.nodeId === 'first' && event.phase === 'leave')?.nextNodeId).toBe('second');
  expect(events.every((event) => event.visit === 1)).toBe(true);
  expect(envelope.map((event) => event.seq)).toEqual(envelope.map((_, index) => index + 1));
  expect(new Set(envelope.map((event) => event.eventId)).size).toBe(envelope.length);
  expect(envelope.every((event) => event.source === 'graph-runner' && event.attempt === event.data.visit && event.phase === event.data.phase)).toBe(true);
  expect(failures).toHaveLength(events.length);
});

test('node lifecycle hook can shadow-classify events then switch to operational traffic updates mid-run', async () => {
  const { graph, root } = fixture('printf first');
  let mode: 'shadow' | 'operational' = 'shadow';
  let matchedShadowEvents = 0;
  const shadowEvents: string[] = [];
  const trafficUpdates: string[] = [];
  const expected = ['first:arrival', 'first:start', 'first:end'];
  let releaseTransition!: () => void;
  let transitionStarted!: () => void;
  let graphReachedDone!: () => void;
  let beforeNodes = 0;
  const transitionGate = new Promise<void>((resolve) => { releaseTransition = resolve; });
  const transition = new Promise<void>((resolve) => { transitionStarted = resolve; });
  const graphDone = new Promise<void>((resolve) => { graphReachedDone = resolve; });
  const run = runGraph(graph, { deps: { root,
    beforeNode: () => { if (++beforeNodes === 3) graphReachedDone(); },
    nodeLifecycle: async (event) => {
      const observed = `${event.nodeId}:${event.phase}`;
      if (mode === 'shadow') {
        shadowEvents.push(observed);
        if (expected[matchedShadowEvents] === observed) matchedShadowEvents++;
        if (matchedShadowEvents >= 3) {
          transitionStarted();
          await transitionGate;
          mode = 'operational';
        }
      } else if (event.phase === 'arrival') {
        trafficUpdates.push(`traffic-update:${event.nodeId}`);
      }
    },
  } });
  await transition;
  await graphDone;
  expect(trafficUpdates).toEqual([]);
  releaseTransition();
  const result = await run;
  expect(result.status).toBe('done');
  expect(shadowEvents).toEqual(['first:arrival', 'first:start', 'first:end']);
  expect(trafficUpdates).toEqual(['traffic-update:second', 'traffic-update:done']);
  expect(String(mode)).toBe('operational');
});

test('node lifecycle observers are serialized without blocking graph execution and flush before return', async () => {
  const { graph, root } = fixture('printf first');
  const observed: string[] = [];
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  let graphReachedDone!: () => void;
  const firstObserverStarted = new Promise<void>((resolve) => { firstStarted = resolve; });
  const doneReached = new Promise<void>((resolve) => { graphReachedDone = resolve; });
  const firstObserverGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let visits = 0;
  let observerInFlight = false;
  let concurrentObservers = false;
  const run = runGraph(graph, { deps: { root,
    beforeNode: () => { if (++visits === 3) graphReachedDone(); },
    nodeLifecycle: async (event) => {
      if (observerInFlight) concurrentObservers = true;
      observerInFlight = true;
      if (event.nodeId === 'first' && event.phase === 'arrival') {
        firstStarted();
        await firstObserverGate;
      }
      observed.push(`${event.nodeId}:${event.phase}`);
      observerInFlight = false;
    },
  } });

  await firstObserverStarted;
  await doneReached;
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(observed).toEqual([]);
  releaseFirst();
  const result = await run;

  expect(result.status).toBe('done');
  expect(concurrentObservers).toBe(false);
  expect(observed.slice(0, 4)).toEqual(['first:arrival', 'first:start', 'first:end', 'first:leave']);
  expect(observed.at(-1)).toBe('done:leave');
});

test('resuming an already completed visit does not emit a duplicate lifecycle', async () => {
  const { graph, root } = fixture('printf first');
  const initialEvents: string[] = [];
  const first = await runGraph(graph, { deps: { root, nodeLifecycle: (event) => { initialEvents.push(`${event.nodeId}:${event.phase}`); } } });
  expect(first.status).toBe('done');
  const saved = JSON.parse(readFileSync(first.statePath, 'utf8')) as Record<string, unknown>;
  saved.status = 'running';
  delete saved.reason;
  writeFileSync(first.statePath, `${JSON.stringify(saved, null, 2)}\n`);

  const resumedEvents: string[] = [];
  const resumed = await runGraph(graph, { resumeRunId: first.runId,
    deps: { root, nodeLifecycle: (event) => { resumedEvents.push(`${event.nodeId}:${event.phase}`); } } });

  expect(resumed.status).toBe('done');
  expect(resumedEvents).toEqual([]);
  expect(initialEvents.at(-1)).toBe('done:leave');
});

test('lifecycle envelope ids and sequence continue across a resumed run', async () => {
  const { graph, root } = fixture('exit 1');
  const firstEvents: Array<{ eventId: string; seq: number }> = [];
  const first = await runGraph(graph, { deps: { root, nodeLifecycle: (event) => { firstEvents.push(event); } } });
  expect(first.status).toBe('failed');
  const resumedEvents: Array<{ eventId: string; seq: number }> = [];
  const resumed = await runGraph(graph, { resumeRunId: first.runId, fromNodeId: 'first', deps: { root,
    nodeLifecycle: (event) => { resumedEvents.push(event); } } });

  expect(resumed.status).toBe('failed');
  expect(firstEvents.length).toBeGreaterThan(0);
  expect(resumedEvents.length).toBeGreaterThan(0);
  expect(resumedEvents[0]!.seq).toBeGreaterThan(firstEvents.at(-1)!.seq);
  expect(new Set([...firstEvents, ...resumedEvents].map((event) => event.eventId)).size).toBe(firstEvents.length + resumedEvents.length);
});

test('an unknown node recipe is rejected before publishing lifecycle events', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(join(root, 'recipes.yaml'), 'second:\n  command: "exit 0"\n');
  const source = readFileSync(graph, 'utf8').replace("recipe: 'cmd:first'", "recipe: 'cmd:missing'");
  writeFileSync(graph, source);
  const phases: string[] = [];

  await expect(runGraph(graph, { deps: { root, nodeLifecycle: (event) => { phases.push(`${event.nodeId}:${event.phase}`); } } }))
    .rejects.toThrow();

  expect(phases).toEqual([]);
});

test('a post-arrival binding validation exception emits exactly one leave', async () => {
  const { graph, root } = fixture('exit 0');
  const phases: string[] = [];

  await expect(runGraph(graph, { deps: { root,
    nodeLifecycle: (event) => { phases.push(`${event.nodeId}:${event.phase}`); },
    validateNodeBinding: () => { throw new Error('injected binding validation failure'); },
  } })).rejects.toThrow('injected binding validation failure');

  expect(phases).toEqual(['first:arrival', 'first:leave']);
});

test('a transient ledger persist exception closes the visit and resume continues its lifecycle sequence', async () => {
  const { graph, root } = fixture('exit 0');
  const runId = 'transient-persist-after-arrival';
  const statePath = join(root, 'graph-runs', 'test-graph', `${runId}.json`);
  const firstEvents: Array<{ phase: string; seq: number; eventId: string }> = [];
  let failedPersist = false;

  await expect(runGraph(graph, { runId, deps: { root,
    nodeLifecycle: (event) => { firstEvents.push({ phase: event.phase, seq: event.seq, eventId: event.eventId }); },
    beforePersist: (state) => {
      if (!failedPersist && state.graphEventSequence === 3) {
        failedPersist = true;
        throw new Error('transient ledger persist failure');
      }
    },
  } })).rejects.toThrow('transient ledger persist failure');

  expect(firstEvents.map((event) => event.phase)).toEqual(['arrival', 'start', 'leave']);
  expect(firstEvents.filter((event) => event.phase === 'leave')).toHaveLength(1);
  const failedState = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
  expect(failedState.graphEventSequence).toBe(firstEvents.at(-1)!.seq);
  failedState.status = 'failed';
  failedState.reason = 'resume lifecycle sequence test';
  writeFileSync(statePath, `${JSON.stringify(failedState, null, 2)}\n`);

  const resumedEvents: Array<{ phase: string; seq: number; eventId: string }> = [];
  const resumed = await runGraph(graph, { resumeRunId: runId, fromNodeId: 'first', deps: { root,
    nodeLifecycle: (event) => { resumedEvents.push({ phase: event.phase, seq: event.seq, eventId: event.eventId }); },
  } });

  expect(resumed.status).toBe('done');
  expect(resumedEvents[0]!.seq).toBeGreaterThan(firstEvents.at(-1)!.seq);
  expect(new Set([...firstEvents, ...resumedEvents].map((event) => event.eventId)).size)
    .toBe(firstEvents.length + resumedEvents.length);
});

test('runGraph publishes ordered node lifecycle events and dispatches matching node subscriptions', async () => {
  const { graph, root } = fixture('echo ok');
  const yaml = readFileSync(graph, 'utf8').replace(
    '- { node_id: first, kind: agent, recipe: \'cmd:first\', max_visits: 1 }',
    '- node_id: first\n    kind: agent\n    recipe: handler:emit-event\n    max_visits: 1\n    emits: [release.gate.failed]',
  ).replace(
    '- { node_id: second, kind: agent, recipe: \'cmd:second\', max_visits: 1 }',
    '- node_id: second\n    kind: agent\n    recipe: \'cmd:second\'\n    max_visits: 1\n    subscribes:\n      - event: release.gate.failed\n        match: { nodeId: first }\n        action: wake\n      - event: node-end\n        match: { nodeId: first, ok: true }\n        action: wake',
  );
  writeFileSync(graph, yaml);
  const bus = createGraphEventBus();
  bus.registerType('release.gate.failed');
  const events: { type: string; runId: string; source: { nodeId?: string }; sequence: number }[] = [];
  const dispatches: { nodeId: string; action: string; runId: string; sourceNodeId?: string }[] = [];
  const edgeProposalResults: string[] = [];
  bus.subscribe((event) => { events.push(event); });
  const options: GraphRunOptions = { eventBus: bus, deps: {
    root,
    runBash: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
    inProcessHandlers: { 'emit-event': async (context) => {
      await context.emitEvent?.('release.gate.failed', { severity: 'introduced' });
      return { ok: true, outcome: 'ok' };
    } },
    proposeGraphEdge: async (proposal) => { edgeProposalResults.push(proposal.mode ?? 'live');
      return { disposition: 'added', reason: 'live policy approved' }; },
    dispatchGraphSubscription: async ({ nodeId, action, event, proposeEdge }) => {
      dispatches.push({ nodeId, action, runId: event.runId, sourceNodeId: event.source.nodeId });
      if (proposeEdge) {
        const result = await proposeEdge({ from: 'first', to: nodeId, triggerEvent: event.type, rationale: 'exercise the edge proposal port' });
        edgeProposalResults.push(result.disposition);
      }
      if (proposeEdge) await expect(proposeEdge({ from: 'first', to: nodeId, triggerEvent: event.type,
        rationale: 'blank shadow axis is refused', mode: 'shadow', unmeasuredAxis: '  ' }))
        .rejects.toThrow('shadow graph edge proposal requires a non-empty unmeasuredAxis');
    },
  } };
  const states = await Promise.all([
    runGraph(graph, { ...options, runId: 'event-dispatch-a' }),
    runGraph(graph, { ...options, runId: 'event-dispatch-b' }),
  ]);
  expect(states.map((state) => state.status)).toEqual(['done', 'done']);
  for (const runId of ['event-dispatch-a', 'event-dispatch-b']) {
    expect(events.filter((event) => event.runId === runId && event.source.nodeId === 'first').map((event) => event.type))
      .toEqual(['node-arrival', 'node-start', 'release.gate.failed', 'node-end', 'node-leave']);
    expect(dispatches.filter((dispatch) => dispatch.runId === runId).map((dispatch) => dispatch.sourceNodeId))
      .toEqual(['first', 'first']);
  }
  expect(events.map((event) => event.sequence)).toEqual(events.map((_event, index) => index + 1));
  expect(dispatches.map(({ nodeId, action }) => [nodeId, action])).toEqual([
    ['second', 'wake'], ['second', 'wake'], ['second', 'wake'], ['second', 'wake'],
  ]);
  expect(edgeProposalResults.filter((result) => result === 'live')).toHaveLength(4);
  expect(edgeProposalResults.filter((result) => result === 'added')).toHaveLength(4);
});

test('appended wake continuation keeps normal, fail-closed, and recovery-only routes', async () => {
  for (const repairOutcome of ['ok', 'fail', 'error', 'recovery-required'] as const) {
    const { graph, root } = fixture('printf first');
    writeFileSync(join(root, 'recipes.yaml'), `second:\n  command: "printf second"\nrepair:\n  command: "printf repair"\nrepair-recovery:\n  approval: "recover only after bounded receipt lookup exhaustion?"\n`);
    const yaml = readFileSync(graph, 'utf8').replace(
      '- { node_id: first, kind: agent, recipe: \'cmd:first\', max_visits: 1 }',
      "- node_id: first\n    kind: agent\n    recipe: handler:append-event\n    max_visits: 1\n    emits: [release.test.append-wake]").replace(
      '- { node_id: second, kind: agent, recipe: \'cmd:second\', max_visits: 1 }',
      "- node_id: second\n    kind: agent\n    recipe: 'cmd:second'\n    max_visits: 2\n    subscribes: [{ event: release.test.append-wake, match: { nodeId: first }, action: wake }]").replace(
      '- { node_id: failed, kind: gate, max_visits: 1 }',
      "- { node_id: failed, kind: gate, max_visits: 1 }\n  - { node_id: recover, kind: hitl, recipe: 'approval:repair-recovery', max_visits: 1 }");
    writeFileSync(graph, yaml);
    const state = await runGraph(graph, { runId: `append-wake-${repairOutcome}`, deps: {
      root,
      inProcessHandlers: { 'append-event': async (context) => {
        await context.emitEvent?.('release.test.append-wake', {});
        return { ok: true, outcome: 'ok' };
      } },
      runBash: async (command) => command.includes('repair') && repairOutcome !== 'ok'
        ? { exitCode: repairOutcome === 'fail' ? 1 : 2, stdout: JSON.stringify({ outcome: repairOutcome }), stderr: 'injected repair failure' }
        : { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok' }), stderr: '' },
      dispatchGraphSubscription: async (dispatch) => {
        if (!dispatch.appendGraph) throw new Error('append graph port was not provided');
        const result = await dispatch.appendGraph({
          nodes: [{ nodeId: 'repair', kind: 'agent', recipe: 'cmd:repair', maxVisits: 1 }],
          edges: [{ from: 'repair', on: 'outcome', map: { ok: 'second', fail: 'failed', error: 'failed', 'recovery-required': 'recover' } }],
          entryNodeId: 'repair', returnTo: 'second', failureTo: 'failed', reason: 'exercise appended wake continuation',
        });
        expect(result.disposition).toBe('appended');
      },
    } });
    expect(state.path).toContain('repair');
    const expectedEnd = repairOutcome === 'recovery-required' ? 'awaiting-approval'
      : repairOutcome === 'ok' ? 'done' : 'failed';
    if (expectedEnd === 'awaiting-approval') {
      expect(state.status).toBe(expectedEnd);
      expect(state.path.at(-1)).toBe('recover');
      continue;
    }
    if (state.path.at(-1) !== expectedEnd) throw new Error(`expected ${expectedEnd}, received ${JSON.stringify({ status: state.status, path: state.path,
      reason: state.reason, nodes: state.nodes.map((node) => ({ nodeId: node.nodeId, ok: node.ok, exit: node.exit,
        reason: node.reason, error: node.error, output: node.output })) })}`);
  }
});

test('runGraph publishes release.gate.failed only with complete triage evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-gate-triage-event-'));
  dirs.push(root);
  const graph = join(root, 'release-loop.yaml');
  const sha = 'a'.repeat(40);
  writeFileSync(join(root, 'recipes.yaml'), [
    'gate:', '  command: "bun scripts/release-loop/gate-node.ts --json"',
    'gate-triage:', '  command: "bun scripts/release-loop/gate-triage-node.ts"',
  ].join('\n') + '\n');
  writeFileSync(graph, [
    'graph_id: release-loop', 'version: 1', 'entry_node: gate', 'terminal_nodes: [done, failed]', 'nodes:',
    "  - { node_id: gate, kind: gate, recipe: 'cmd:gate', max_visits: 2 }",
    "  - { node_id: gate-triage, kind: judge, recipe: 'cmd:gate-triage', max_visits: 1 }",
    "  - { node_id: done, kind: gate, recipe: 'none', max_visits: 1 }",
    "  - { node_id: failed, kind: gate, recipe: 'none', max_visits: 1 }", 'edges:',
    '  - { from: gate, on: outcome, map: { ok: done, fail: gate-triage, error: gate-triage } }',
    '  - { from: gate-triage, on: outcome, map: { ok: done, fail: failed, error: failed } }',
  ].join('\n') + '\n');

  const triageCases: Array<{ name: string; triage: Record<string, unknown>; publishes: boolean }> = [
    { name: 'minimal stub', triage: { outcome: 'ok', verdict: 'pass' }, publishes: false },
    { name: 'empty values', triage: { classification: '', commit: '', introduced: [null] }, publishes: false },
    { name: 'malformed introduced', triage: { classification: 'load', commit: sha, introduced: [null] }, publishes: false },
    { name: 'empty introduced', triage: { classification: 'load', commit: sha, introduced: [] }, publishes: false },
    { name: 'valid evidence', triage: { classification: 'load', commit: sha, introduced: ['src/example.test.ts > fails'], reason: 'measured load', outcome: 'ok' }, publishes: true },
  ];
  for (const [index, item] of triageCases.entries()) {
    const bus = createGraphEventBus();
    const events: string[] = [];
    const progressPhases: string[] = [];
    const progressHosts: Array<unknown> = [];
    bus.subscribe((event) => { if (event.type === 'release.gate.failed') events.push(event.eventId); });
    bus.subscribe((event) => { if (event.type === 'release.gate.progress') {
      progressPhases.push(String(event.data?.phase)); progressHosts.push(event.data?.host);
    } });
    const state = await runGraph(graph, { runId: `triage-evidence-${index}`, input: { version: '0.3.5', previousVersion: '0.3.4' }, eventBus: bus,
      deps: { root, releaseGraphEventAdapters: false, runBash: async (command, opts) => {
        if (command.includes('gate-triage-node.ts')) return (() => {
          const context = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as { input: Record<string, unknown> };
          return { exitCode: 0, stdout: `${JSON.stringify({ ...item.triage,
            ...(item.publishes ? { gateExecutionId: context.input.adaptiveGateExecutionId } : {}) })}\n`, stderr: '' };
        })();
        const progressPath = opts.env?.ELANOUS_GATE_PROGRESS_FILE;
        if (progressPath) {
          const rows = ['shard-planning', 'collection', 'classification', 'verdict']
            .map((phase) => JSON.stringify({ phase, shardIndex: 1, shardTotal: 1, host: index === 0 ? 'node-c-호스트' : 'sim-host', durationMs: 10,
              failureCount: 0, introduced: 0, preexisting: 0, unmeasured: 0 }));
          const payload = Buffer.from(`${rows.join('\n')}\n`);
          if (index === 0) {
            const splitAt = payload.indexOf(Buffer.from('호스트')) + 1;
            writeFileSync(progressPath, payload.subarray(0, splitAt));
            await new Promise((resolve) => setTimeout(resolve, 150));
            appendFileSync(progressPath, payload.subarray(splitAt));
          } else writeFileSync(progressPath, payload);
        }
        return { exitCode: 1, stdout: `${JSON.stringify({ outcome: 'fail', commit: sha, introduced: ['src/example.test.ts > fails'] })}\n`, stderr: '' };
      } } });
    expect(state.status, item.name).toBe('done');
    expect(events, item.name).toHaveLength(item.publishes ? 1 : 0);
    expect(progressPhases).toEqual(['shard-planning', 'collection', 'classification', 'verdict']);
    if (index === 0) expect(progressHosts).toContain('node-c-호스트');
  }

  const staleGateBus = createGraphEventBus();
  const staleGateEvents: string[] = [];
  staleGateBus.subscribe((event) => { if (event.type === 'release.gate.failed') staleGateEvents.push(event.eventId); });
  let staleTriageRuns = 0;
  await expect(runGraph(graph, { runId: 'stale-gate-execution-id', input: { version: '0.3.5', previousVersion: '0.3.4' },
    eventBus: staleGateBus, deps: { root, releaseGraphEventAdapters: false, runBash: async (command) => {
      if (command.includes('gate-node.ts')) return { exitCode: 1,
        stdout: `${JSON.stringify({ outcome: 'fail', commit: sha, introduced: ['src/example.test.ts > fails'], executionId: 'prior-gate-execution' })}\n`, stderr: '' };
      if (command.includes('gate-triage-node.ts')) staleTriageRuns++;
      return { exitCode: 0, stdout: `${JSON.stringify({ classification: 'load', commit: sha,
        introduced: ['src/example.test.ts > fails'], outcome: 'ok' })}\n`, stderr: '' };
    } } })).rejects.toThrow('gate output execution id does not match the current gate execution');
  expect(staleTriageRuns).toBe(0);
  expect(staleGateEvents).toEqual([]);

  const legacyRunId = 'legacy-gate-execution-id-resume';
  const legacyBus = createGraphEventBus();
  const legacyEvents: string[] = [];
  legacyBus.subscribe((event) => { if (event.type === 'release.gate.failed') legacyEvents.push(event.eventId); });
  let legacyGateVisits = 0;
  const legacyRunBash: NonNullable<GraphRunOptions['deps']>['runBash'] = async (command, opts) => {
    if (command.includes('gate-node.ts')) {
      legacyGateVisits++;
      return { exitCode: 1, stdout: `${JSON.stringify({ outcome: 'fail', commit: sha, introduced: ['src/example.test.ts > fails'] })}\n`, stderr: '' };
    }
    if (command.includes('gate-triage-node.ts')) {
      const contextPath = opts.env?.ELANOUS_GRAPH_CONTEXT;
      if (!contextPath) throw new Error('graph runner context path is missing');
      const context = JSON.parse(readFileSync(contextPath, 'utf8')) as { input: Record<string, unknown> };
      return { exitCode: 0, stdout: `${JSON.stringify({ classification: 'load', commit: sha,
        introduced: ['src/example.test.ts > fails'], outcome: 'ok', gateExecutionId: context.input.adaptiveGateExecutionId })}\n`, stderr: '' };
    }
    return { exitCode: 0, stdout: `${JSON.stringify({ outcome: 'ok' })}\n`, stderr: '' };
  };
  const legacyDeps = { root, releaseGraphEventAdapters: false, runBash: legacyRunBash };
  await expect(runGraph(graph, { runId: legacyRunId, input: { version: '0.3.5', previousVersion: '0.3.4' },
    deps: { ...legacyDeps, beforeNode: () => { if (legacyGateVisits === 1) throw new Error('interrupt after legacy gate'); } } }))
    .rejects.toThrow('interrupt after legacy gate');
  const legacyPath = join(root, 'graph-runs', 'release-loop', `${legacyRunId}.json`);
  const legacySaved = JSON.parse(readFileSync(legacyPath, 'utf8')) as { nodes: Array<{ nodeId: string; executionId?: string; output?: unknown }> };
  const oldGate = legacySaved.nodes.find((record) => record.nodeId === 'gate')!;
  delete oldGate.executionId;
  const oldGateOutput = JSON.parse(String(oldGate.output)) as Record<string, unknown>;
  delete oldGateOutput.executionId;
  oldGate.output = JSON.stringify(oldGateOutput);
  writeFileSync(legacyPath, `${JSON.stringify({ ...legacySaved, status: 'running' }, null, 2)}\n`);
  const legacyResumed = await runGraph(graph, { resumeRunId: legacyRunId, input: { version: '0.3.5', previousVersion: '0.3.4' },
    eventBus: legacyBus, deps: legacyDeps });
  expect(legacyResumed.status).toBe('done');
  expect(legacyGateVisits).toBe(2);
  expect(legacyEvents).toHaveLength(1);
  expect(legacyResumed.nodes.filter((record) => record.nodeId === 'gate').at(-1)?.executionId).toEqual(expect.any(String));
});

test('failed adaptive repair waits at HITL on the same run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-adaptive-resume-'));
  dirs.push(root);
  const graph = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const runId = 'adaptive-repair-resume-same-run';
  const commit = 'd'.repeat(40);
  const failureId = 'src/example.test.ts > introduced regression';
  let gateVisits = 0;
  let repairVisits = 0;
  const runBash: NonNullable<GraphRunOptions['deps']>['runBash'] = async (command, opts) => {
    if (command.includes('gate-node.ts --json')) {
      gateVisits++;
      return gateVisits === 1
        ? { exitCode: 1, stdout: JSON.stringify({ outcome: 'regression', commit, introduced: [failureId], preexisting: 0,
          fixed: null, knownEnv: 0, knownEnvCleared: [], stalledEnv: [], rcNonzeroNoFailures: [], durationMs: 10 }), stderr: '' }
        : { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', commit, introduced: [] }), stderr: '' };
    }
    if (command.includes('gate-triage-node.ts')) {
      const context = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as { input: Record<string, unknown> };
      const triage = classifyGateShadow({ outcome: 'regression', commit, introduced: [failureId], preexisting: 0,
        fixed: null, knownEnv: 0, knownEnvCleared: [], stalledEnv: [], rcNonzeroNoFailures: [], durationMs: 10 });
      return { exitCode: 0, stdout: JSON.stringify({ ...triage, gateExecutionId: context.input.adaptiveGateExecutionId }), stderr: '' };
    }
    if (command.includes('gate-repair-node.ts')) {
      repairVisits++;
      return { exitCode: 1, stdout: JSON.stringify({ outcome: 'fail' }), stderr: 'injected repair failure' };
    }
    return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok' }), stderr: '' };
  };
  const input = { version: '0.3.7', previousVersion: '0.3.6', gateExecutor: 'pod' };

  const first = await runGraph(graph, { runId, input, deps: { root, runBash } });
  expect(first.status).toBe('awaiting-approval');
  expect(first.pending?.nodeId).toBe('gate-heal-decision');
  expect(first.path).toContain('gate-heal-decision');
  const repairId = first.path.find((nodeId) => /^gate-repair-[a-f0-9]{12}$/.test(nodeId));
  expect(repairId).toBeTruthy();
  expect(first.path).toContain(repairId!);
  expect(first.adaptiveGateNodeAppends).toHaveLength(1);
  expect(repairVisits).toBe(1);
  expect(gateVisits).toBe(1);
  expect(first.adaptiveGateNodeAppends).toMatchObject([{ request: { node: { nodeId: repairId } } }]);
});

test('release resume validates the adaptive repair return edge after a failed retried gate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-adaptive-return-resume-'));
  dirs.push(root);
  const graph = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const runId = 'adaptive-return-resume-same-run';
  const commit = 'e'.repeat(40);
  const failureId = 'src/example.test.ts > introduced regression';
  let gateVisits = 0;
  let repairVisits = 0;
  const runBash: NonNullable<GraphRunOptions['deps']>['runBash'] = async (command, opts) => {
    if (command.includes('gate-node.ts --json')) {
      gateVisits++;
      return gateVisits < 3
        ? { exitCode: 1, stdout: JSON.stringify({ outcome: 'regression', commit, introduced: [failureId], preexisting: 0,
          fixed: null, knownEnv: 0, knownEnvCleared: [], stalledEnv: [], rcNonzeroNoFailures: [], durationMs: 10 }), stderr: '' }
        : { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', commit, introduced: [] }), stderr: '' };
    }
    if (command.includes('gate-triage-node.ts')) {
      const context = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as { input: Record<string, unknown> };
      const triage = classifyGateShadow({ outcome: 'regression', commit, introduced: [failureId], preexisting: 0,
        fixed: null, knownEnv: 0, knownEnvCleared: [], stalledEnv: [], rcNonzeroNoFailures: [], durationMs: 10 });
      return { exitCode: 0, stdout: JSON.stringify({ ...triage, gateExecutionId: context.input.adaptiveGateExecutionId }), stderr: '' };
    }
    if (command.includes('gate-repair-node.ts')) {
      repairVisits++;
      return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok' }), stderr: '' };
    }
    return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok' }), stderr: '' };
  };
  const input = { version: '0.3.7', previousVersion: '0.3.6', gateExecutor: 'pod' };

  const first = await runGraph(graph, { runId, input, deps: { root, runBash } });
  expect(first.status).toBe('failed');
  const repairId = first.path.find((nodeId) => /^gate-repair-[a-f0-9]{12}$/.test(nodeId));
  expect(repairId).toBeTruthy();
  expect(first.path.lastIndexOf('gate')).toBe(first.path.indexOf(repairId!) + 1);
  expect(gateVisits).toBe(2);
  expect(repairVisits).toBe(1);

  const savedState = readFileSync(first.statePath, 'utf8');
  const mismatched = JSON.parse(savedState) as { subscriptionGraphAppends: Array<{ eventId: string }> };
  mismatched.subscriptionGraphAppends[0]!.eventId = 'mismatched-adaptive-event';
  writeFileSync(first.statePath, `${JSON.stringify(mismatched, null, 2)}\n`);
  await expect(runGraph(graph, { resumeRunId: runId, fromNodeId: 'version-release', input, deps: { root, runBash } }))
    .rejects.toThrow('saved run path does not follow graph edges');
  writeFileSync(first.statePath, savedState);

  const resumed = await runGraph(graph, { resumeRunId: runId, fromNodeId: 'version-release', input, deps: { root, runBash } });
  expect(resumed.runId).toBe(runId);
  expect(resumed.status).toBe('done');
  expect(gateVisits).toBe(3);
  expect(repairVisits).toBe(1);
});

test('runGraph routes on a matching live adaptive event vocabulary edge and keeps unmatched proposals off-path', async () => {
  for (const matchesTrigger of [true, false]) {
    const { graph, root } = fixture('printf first');
    writeFileSync(graph, readFileSync(graph, 'utf8').replace(
      '- { node_id: first, kind: agent, recipe: \'cmd:first\', max_visits: 1 }',
      '- node_id: first\n    kind: agent\n    recipe: handler:emit-event\n    max_visits: 1\n    emits: [release.gate.failed]',
    ).replace(
      '  - { node_id: done, kind: gate, max_visits: 1 }',
      '  - { node_id: adaptive, kind: agent, recipe: \'cmd:second\', max_visits: 1, subscribes: [{ event: release.gate.failed, action: reroute }] }\n  - { node_id: done, kind: gate, max_visits: 1 }',
    ).replace(
      '  - from: second\n',
      '  - from: adaptive\n    on: outcome\n    map: { ok: second, fail: failed }\n  - from: second\n',
    ));
    const bus = createGraphEventBus();
    bus.registerType('release.gate.failed');
    const edgeResults: unknown[] = [];
    const state = await runGraph(graph, { eventBus: bus, deps: { root,
      inProcessHandlers: { 'emit-event': async (context) => {
        await context.emitEvent?.('release.gate.failed', { code: 'new-incident' });
        return { ok: true, outcome: 'ok' };
      } },
      dispatchGraphSubscription: async ({ event, nodeId, proposeEdge }) => {
        if (event.type !== 'release.gate.failed' || nodeId !== 'adaptive' || !proposeEdge) return;
        const triggerEvent = matchesTrigger ? event.type : 'release.incident.new-code';
        const result = await proposeEdge({ from: 'first', to: 'adaptive', triggerEvent,
          rationale: 'new incident vocabulary routes the affected release node', mode: 'live' });
        edgeResults.push(result);
      },
    } });
    expect(edgeResults).toEqual([{ disposition: 'added', reason: 'event vocabulary and run-local edge persisted' }]);
    expect(state.status).toBe('done');
    expect(state.path.includes('adaptive')).toBe(matchesTrigger);
    expect(state.adaptiveGraphVocabulary).toContain(matchesTrigger ? 'release.gate.failed' : 'release.incident.new-code');
    expect(state.adaptiveGraphEdges).toMatchObject([{ from: 'first', to: 'adaptive',
      triggerEvent: matchesTrigger ? 'release.gate.failed' : 'release.incident.new-code', rationale: 'new incident vocabulary routes the affected release node' }]);
  }
});

test('GraphEventBus serializes concurrent publishers and rejects unregistered vocabulary', async () => {
  const bus = createGraphEventBus();
  bus.registerType('release.gate.failed');
  const delivered: number[] = [];
  bus.subscribe(async (event) => { await Bun.sleep(1); delivered.push(event.sequence); });
  const [first, second] = await Promise.all([
    bus.publish({ graphId: 'release-loop', runId: 'concurrent', type: 'release.gate.failed', source: { kind: 'node', nodeId: 'gate' } }),
    bus.publish({ graphId: 'release-loop', runId: 'concurrent', type: 'node-start', source: { kind: 'node', nodeId: 'gate-bisect' } }),
  ]);
  expect([first.sequence, second.sequence]).toEqual([1, 2]);
  expect(delivered).toEqual([1, 2]);
  await expect(bus.publish({ graphId: 'release-loop', runId: 'concurrent', type: 'release.unknown', source: { kind: 'runner' } }))
    .rejects.toThrow('unregistered graph event type: release.unknown');
  await expect(publishNodeGraphEvent(bus, { graphId: 'release-loop', runId: 'concurrent', type: 'release.gate.failed',
    source: { kind: 'node', nodeId: 'prepare' } }, ['release.prepare.failed']))
    .rejects.toThrow('node prepare emitted undeclared graph event: release.gate.failed');
});

test('GraphEventBus queues an awaited reentrant publish and continues after a handler failure', async () => {
  const bus = createGraphEventBus();
  bus.registerType('release.follow-up');
  const delivered: string[] = [];
  bus.subscribe(async (event) => {
    delivered.push(`first:${event.type}`);
    if (event.type === 'node-start') await bus.publish({ graphId: event.graphId, runId: event.runId,
      type: 'release.follow-up', source: { kind: 'runner' } });
    if (event.type === 'node-end') throw new Error('subscriber failed');
  });
  bus.subscribe((event) => { delivered.push(`second:${event.type}`); });
  await expect(bus.publish({ graphId: 'g', runId: 'reentrant', type: 'node-end', source: { kind: 'runner' } }))
    .rejects.toThrow('graph event reentrant:1 delivery failed');
  await bus.publish({ graphId: 'g', runId: 'reentrant', type: 'node-start', source: { kind: 'runner' } });
  await bus.flush();
  expect(delivered).toEqual([
    'first:node-end', 'second:node-end',
    'first:node-start', 'second:node-start', 'first:release.follow-up', 'second:release.follow-up',
  ]);
});

test('GraphEventBus reports reentrant delivery failures to their owning run', async () => {
  const bus = createGraphEventBus();
  bus.registerType('release.follow-up');
  let releaseNested!: () => void;
  const nestedDelivered = new Promise<void>((resolve) => { releaseNested = resolve; });
  bus.subscribe(async (event) => {
    if (event.type === 'node-start' && event.runId === 'run-a')
      await bus.publish({ graphId: event.graphId, runId: event.runId, type: 'release.follow-up', source: { kind: 'runner' } });
    if (event.type === 'release.follow-up' && event.runId === 'run-a') {
      releaseNested();
      throw new Error('run-a subscriber failed');
    }
  });
  const runA = bus.publish({ graphId: 'g', runId: 'run-a', type: 'node-start', source: { kind: 'runner' } });
  await runA;
  await nestedDelivered;
  await bus.publish({ graphId: 'g', runId: 'run-b', type: 'node-end', source: { kind: 'runner' } });
  await bus.flush({ graphId: 'g', runId: 'run-b' });
  await expect(bus.flush({ graphId: 'g', runId: 'run-a' })).rejects.toThrow('reentrant graph event delivery failed');
});

test('aborting a graph cancels the active command and prevents dispatch of later nodes', async () => {
  const { graph, root } = fixture('sleep 30');
  const controller = new AbortController();
  let commandSignal: AbortSignal | undefined;
  const running = runGraph(graph, { signal: controller.signal, deps: { root, runBash: async (_command, options) => {
    commandSignal = options.signal;
    return new Promise((resolve, reject) => options.signal?.addEventListener('abort', () => reject(new Error('command aborted')), { once: true }));
  } } });
  await Bun.sleep(0);
  controller.abort();
  const run = await running;
  expect(commandSignal).toBe(controller.signal);
  expect(run).toMatchObject({ status: 'failed', reason: 'cancelled', path: ['first'] });
  expect(run.path).not.toContain('second');
});

test('explicit fan-out runs concurrently and reruns a completed branch when its input receipt changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-fanout-'));
  dirs.push(root);
  const graph = join(root, 'graph.yaml');
  writeFileSync(join(root, 'recipes.yaml'), [
    'version-release:', '  command: commit-source',
    'start:', '  command: "printf \'{\\\"outcome\\\":\\\"ok\\\"}\'"',
    'a:', '  command: branch-a', 'b:', '  command: branch-b', '',
  ].join('\n'));
  writeFileSync(graph, `graph_id: operate-loop
version: 1
entry_node: version-release
terminal_nodes: [landed, operate-blocked]
nodes:
  - { node_id: version-release, kind: git, recipe: 'cmd:version-release', max_visits: 1 }
  - { node_id: start, kind: agent, recipe: 'cmd:start', max_visits: 1 }
  - { node_id: a, kind: agent, recipe: 'cmd:a', max_visits: 1, needs: [start] }
  - { node_id: b, kind: agent, recipe: 'cmd:b', max_visits: 1, needs: [start] }
  - { node_id: joined, kind: gate, recipe: none, max_visits: 1, needs: [a, b] }
  - { node_id: landed, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: operate-blocked, kind: gate, recipe: none, max_visits: 1 }
edges:
  - { from: version-release, on: outcome, map: { ok: start, fail: operate-blocked } }
  - { from: start, on: outcome, map: { fail: operate-blocked, error: operate-blocked } }
  - { from: joined, on: outcome, map: { ok: landed, fail: operate-blocked } }
`);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['add', 'graph.yaml', 'recipes.yaml'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=release-root-test', '-c', 'user.email=release-root-test@invalid', 'commit', '--quiet', '-m', 'fanout source'], { cwd: root });
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const branchArtifact = join(root, 'branch-b-artifact.txt');
  let failA = true;
  let active = 0;
  let maxActive = 0;
  const startedBranches = new Set<string>();
  let releaseBothStarted!: () => void;
  const bothStarted = new Promise<void>((resolve) => { releaseBothStarted = resolve; });
  const counts = new Map<string, number>();
  let releaseBranchA!: () => void;
  const branchAGate = new Promise<void>((resolve) => { releaseBranchA = resolve; });
  let finishBranchB!: () => void;
  const branchBFinished = new Promise<void>((resolve) => { finishBranchB = resolve; });
  const deps = { root, runBash: async (command: string) => {
    if (command === 'commit-source') return { stdout: JSON.stringify({ outcome: 'ok', commit: sourceCommit }), stderr: '', exitCode: 0 };
    if (command === 'branch-a' || command === 'branch-b') {
      counts.set(command, (counts.get(command) ?? 0) + 1);
      active++;
      maxActive = Math.max(maxActive, active);
      startedBranches.add(command);
      if (startedBranches.size === 2) releaseBothStarted();
      if (command === 'branch-a') await branchAGate;
      else { await bothStarted; writeFileSync(branchArtifact, 'branch-b-artifact'); finishBranchB(); }
      active--;
      const ok = command === 'branch-a' ? !failA : true;
      return { stdout: JSON.stringify({ outcome: ok ? 'ok' : 'fail', result: command === 'branch-b' ? { artifacts: [branchArtifact] } : command }),
        stderr: '', exitCode: ok ? 0 : 1 };
    }
    return { stdout: '{"outcome":"ok"}', stderr: '', exitCode: 0 };
  } };
  const runId = 'fanout-incremental-persist';
  const firstPromise = runGraph(graph, { runId, input: { releaseInput: 'before' }, deps });
  await branchBFinished;
  const parentStatePath = join(root, 'graph-runs', 'operate-loop', `${runId}.json`);
  let observedBranchCompletion = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(parentStatePath)) {
      const saved = JSON.parse(readFileSync(parentStatePath, 'utf8'));
      const branches = saved.fanOuts?.['start:ok']?.branches;
      if (branches?.a?.status === 'running' && branches?.b?.status === 'done') {
        observedBranchCompletion = true;
        break;
      }
    }
    await Bun.sleep(5);
  }
  expect(observedBranchCompletion).toBe(true);
  releaseBranchA();
  const first = await firstPromise;
  expect(maxActive).toBe(2);
  expect(first.status).toBe('failed');
  const fork = first.fanOuts?.['start:ok'];
  expect(fork?.branches.a).toMatchObject({ status: 'failed', output: expect.any(String), artifactSha256: expect.any(String) });
  expect(fork?.branches.b).toMatchObject({ status: 'done', output: expect.any(String), artifactSha256: expect.any(String),
    completionReceipt: { inputSha256: expect.any(String), commit: expect.any(String), artifactSha256: expect.any(String) } });
  const childLedgerPath = join(root, 'graph-runs', 'operate-loop', `${fork!.branches.b!.runId}.json`);
  const childLedger = JSON.parse(readFileSync(childLedgerPath, 'utf8')) as { nodes: Array<{ nodeId: string; completionReceipt?: unknown }> };
  expect(childLedger.nodes.find((node) => node.nodeId === 'b')?.completionReceipt).toMatchObject({
    inputSha256: expect.any(String), commit: sourceCommit, artifactSha256: expect.any(String),
  });
  const successfulBranch = { ...fork!.branches.b! };

  await expect(runGraph(graph, { resumeRunId: first.runId, fromNodeId: 'a', deps }))
    .rejects.toThrow("--from cannot resume fan-out branch 'a'; resume from fan-out source 'start' instead");
  const unchanged = await runGraph(graph, { resumeRunId: first.runId, fromNodeId: 'start', deps });
  expect(unchanged.status).toBe('failed');
  expect(counts).toEqual(new Map([['branch-a', 2], ['branch-b', 1]]));
  writeFileSync(branchArtifact, 'tampered-artifact');
  const artifactChanged = await runGraph(graph, { resumeRunId: first.runId, fromNodeId: 'start', deps });
  expect(artifactChanged.status).toBe('failed');
  expect(counts).toEqual(new Map([['branch-a', 3], ['branch-b', 2]]));
  const savedState = JSON.parse(readFileSync(first.statePath, 'utf8')) as { input: unknown };
  savedState.input = { releaseInput: 'after' };
  writeFileSync(first.statePath, JSON.stringify(savedState));
  failA = false;
  const resumed = await runGraph(graph, { resumeRunId: first.runId, fromNodeId: 'start', deps });
  expect(resumed.status).toBe('done');
  expect(counts).toEqual(new Map([['branch-a', 4], ['branch-b', 3]]));
  expect(resumed.fanOuts?.['start:ok']?.branches.b?.completionReceipt?.inputSha256)
    .not.toBe(successfulBranch.completionReceipt?.inputSha256);
  expect(resumed.path).toEqual(['version-release', 'start', 'joined', 'landed']);
}, 30_000);

test('pre-prepare join failure includes the failed branch run, node, and first output line', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-pre-prepare-join-diagnostic-'));
  dirs.push(root);
  const graph = join(root, 'graph.yaml');
  writeFileSync(join(root, 'recipes.yaml'), [
    'start:', '  command: start',
    'prepare-code:', '  command: prepare-code',
    'prepare-docs:', '  command: prepare-docs', '',
  ].join('\n'));
  writeFileSync(graph, `graph_id: graph-join-diagnostic
version: 1
entry_node: start
terminal_nodes: [done, failed]
nodes:
  - { node_id: start, kind: agent, recipe: 'cmd:start', max_visits: 1 }
  - { node_id: prepare-code, kind: agent, recipe: 'cmd:prepare-code', max_visits: 1 }
  - { node_id: prepare-docs, kind: agent, recipe: 'cmd:prepare-docs', max_visits: 1 }
  - { node_id: pre-prepare-join, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }
edges:
  - { from: start, on: outcome, branches: { ok: [prepare-code, prepare-docs] }, join: pre-prepare-join }
  - { from: pre-prepare-join, on: outcome, map: { ok: done, fail: failed } }
`);
  const deps = { root, runBash: async (command: string) => {
    if (command === 'prepare-code') return { stdout: '{"outcome":"fail","diagnostic":"prepare failed: src/example.ts:14 TS2304"}\nsecond output line', stderr: '', exitCode: 1 };
    if (command === 'prepare-docs') return { stdout: '{"outcome":"fail","diagnostic":"prepare failed: docs/example.md:8 missing reference"}\nsecond docs output line', stderr: '', exitCode: 1 };
    return { stdout: '{"outcome":"ok"}', stderr: '', exitCode: 0 };
  } };
  const run = await runGraph(graph, { runId: 'pre-prepare-join-diagnostic', deps });
  expect(run.status).toBe('failed');
  const branches = run.fanOuts?.['start:ok']?.branches;
  expect(branches?.['prepare-code']).toMatchObject({ status: 'failed', runId: expect.any(String) });
  expect(branches?.['prepare-docs']).toMatchObject({ status: 'failed', runId: expect.any(String) });
  const joinRecord = run.nodes.find((node) => node.nodeId === 'pre-prepare-join');
  expect(joinRecord).toMatchObject({ ok: false });
  const diagnostics = JSON.parse(joinRecord!.reason!.replace(/^join failed: /, '')).failedBranches;
  expect(diagnostics).toEqual([
    { nodeId: 'prepare-code', runId: branches!['prepare-code']!.runId, error: 'bash exit 1',
      outputFirstLine: '{"outcome":"fail","diagnostic":"prepare failed: src/example.ts:14 TS2304"}' },
    { nodeId: 'prepare-docs', runId: branches!['prepare-docs']!.runId, error: 'bash exit 1',
      outputFirstLine: '{"outcome":"fail","diagnostic":"prepare failed: docs/example.md:8 missing reference"}' },
  ]);
  expect(joinRecord!.reason).not.toContain('second output line');
  expect(joinRecord!.reason).not.toContain('second docs output line');
});

test('explicit fan-out reruns a completed branch when current source commit differs from its receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-fanout-source-commit-'));
  dirs.push(root);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const graph = join(root, 'graph.yaml');
  writeFileSync(join(root, 'recipes.yaml'), 'version-release:\n  command: commit-source\nstart:\n  command: start\na:\n  command: branch-a\nb:\n  command: branch-b\n');
  writeFileSync(graph, `graph_id: operate-loop
version: 1
entry_node: version-release
terminal_nodes: [landed, operate-blocked]
nodes:
  - { node_id: version-release, kind: git, recipe: 'cmd:version-release', max_visits: 1 }
  - { node_id: start, kind: agent, recipe: 'cmd:start', max_visits: 1 }
  - { node_id: a, kind: agent, recipe: 'cmd:a', max_visits: 1, needs: [start] }
  - { node_id: b, kind: agent, recipe: 'cmd:b', max_visits: 1, needs: [start] }
  - { node_id: joined, kind: gate, recipe: none, max_visits: 1, needs: [a, b] }
  - { node_id: landed, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: operate-blocked, kind: gate, recipe: none, max_visits: 1 }
edges:
  - { from: version-release, on: outcome, map: { ok: start, fail: operate-blocked } }
  - { from: start, on: outcome, branches: { ok: [a, b], fail: [operate-blocked, landed] }, join: joined }
  - { from: joined, on: outcome, map: { ok: landed, fail: operate-blocked } }
`);
  execFileSync('git', ['add', 'graph.yaml', 'recipes.yaml'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=release-root-test', '-c', 'user.email=release-root-test@invalid', 'commit', '--quiet', '-m', 'fanout source'], { cwd: root });
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  let failA = true;
  const counts = new Map<string, number>();
  const deps = { root, runBash: async (command: string) => {
    if (command === 'commit-source') return { stdout: JSON.stringify({ outcome: 'ok', commit: sourceCommit }), stderr: '', exitCode: 0 };
    if (command === 'branch-a' || command === 'branch-b') {
      counts.set(command, (counts.get(command) ?? 0) + 1);
      const ok = command !== 'branch-a' || !failA;
      return { stdout: JSON.stringify({ outcome: ok ? 'ok' : 'fail' }), stderr: '', exitCode: ok ? 0 : 1 };
    }
    return { stdout: '{"outcome":"ok"}', stderr: '', exitCode: 0 };
  } };
  const first = await runGraph(graph, { runId: 'fanout-source-commit', deps });
  expect(first.status).toBe('failed');
  expect(counts.get('branch-b')).toBe(1);

  writeFileSync(join(root, 'source-change'), 'changed');
  execFileSync('git', ['add', 'source-change'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=release-root-test', '-c', 'user.email=release-root-test@invalid', 'commit', '--quiet', '-m', 'move source'], { cwd: root });
  failA = false;
  const resumed = await runGraph(graph, { resumeRunId: first.runId, fromNodeId: 'start', deps });
  expect(resumed.status).toBe('done');
  expect(counts.get('branch-b')).toBe(2);
}, 30_000);

test('fan-out scheduler enforces the graph concurrency cap and serializes shared resource locks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-fanout-locks-'));
  dirs.push(root);
  const graph = join(root, 'graph.yaml');
  writeFileSync(join(root, 'recipes.yaml'), [
    'start:', '  command: "printf \'{\\"outcome\\":\\"ok\\"}\'"',
    'a:', '  command: resource-a', 'b:', '  command: resource-b', 'c:', '  command: independent-c', '',
  ].join('\n'));
  writeFileSync(graph, `graph_id: operate-loop
version: 1
max_parallel_nodes: 2
entry_node: start
terminal_nodes: [landed, operate-blocked]
nodes:
  - { node_id: start, kind: agent, recipe: 'cmd:start', max_visits: 1 }
  - { node_id: a, kind: agent, recipe: 'cmd:a', max_visits: 1, resource_locks: [checkout] }
  - { node_id: b, kind: agent, recipe: 'cmd:b', max_visits: 1, resource_locks: [checkout] }
  - { node_id: c, kind: agent, recipe: 'cmd:c', max_visits: 1 }
  - { node_id: joined, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: landed, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: operate-blocked, kind: gate, recipe: none, max_visits: 1 }
edges:
  - from: start
    on: outcome
    branches: { ok: [a, b, c] }
    join: joined
  - { from: joined, on: outcome, map: { ok: landed, fail: operate-blocked } }
`);
  let releaseA!: () => void;
  let signalAc!: () => void;
  const heldA = new Promise<void>((resolve) => { releaseA = resolve; });
  const startedAc = new Promise<void>((resolve) => { signalAc = resolve; });
  const started: string[] = [];
  let active = 0;
  let maximumActive = 0;
  let aFinished = false;
  let bStartedAfterA = false;
  const deps = { root, runBash: async (command: string) => {
    if (command === 'resource-a' || command === 'resource-b' || command === 'independent-c') {
      started.push(command);
      active++;
      maximumActive = Math.max(maximumActive, active);
      if (command === 'resource-a') {
        signalAc();
        await heldA;
        aFinished = true;
      } else if (command === 'resource-b') bStartedAfterA = aFinished;
      else signalAc();
      active--;
      return { stdout: '{"outcome":"ok"}', stderr: '', exitCode: 0 };
    }
    return { stdout: '{"outcome":"ok"}', stderr: '', exitCode: 0 };
  } };
  const run = runGraph(graph, { deps });
  await startedAc;
  await Bun.sleep(10);
  expect(started).toEqual(['resource-a', 'independent-c']);
  releaseA();
  const result = await run;
  expect(result.status).toBe('done');
  expect(maximumActive).toBe(2);
  expect(bStartedAfterA).toBe(true);
});

test('fan-out without a configured cap keeps all legacy branches concurrent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-fanout-default-cap-'));
  dirs.push(root);
  writeFileSync(join(root, 'recipes.yaml'), ['a:', '  command: a', 'b:', '  command: b', 'c:', '  command: c',
    'd:', '  command: d', 'e:', '  command: e', ''].join('\n'));
  const graph = join(root, 'graph.yaml');
  writeFileSync(graph, [
    'graph_id: operate-loop', 'version: 1', 'entry_node: start', 'terminal_nodes: [landed, operate-blocked]',
    'nodes:',
    '  - { node_id: start, kind: gate, recipe: none, max_visits: 1 }',
    '  - { node_id: a, kind: agent, recipe: cmd:a, max_visits: 1 }',
    '  - { node_id: b, kind: agent, recipe: cmd:b, max_visits: 1 }',
    '  - { node_id: c, kind: agent, recipe: cmd:c, max_visits: 1 }',
    '  - { node_id: d, kind: agent, recipe: cmd:d, max_visits: 1 }',
    '  - { node_id: e, kind: agent, recipe: cmd:e, max_visits: 1 }',
    '  - { node_id: joined, kind: gate, recipe: none, max_visits: 1 }',
    '  - { node_id: landed, kind: gate, recipe: none, max_visits: 1 }',
    '  - { node_id: operate-blocked, kind: gate, recipe: none, max_visits: 1 }',
    'edges:',
    '  - from: start',
    '    on: outcome',
    '    branches: { ok: [a, b, c, d, e] }',
    '    join: joined',
    '  - { from: joined, on: outcome, map: { ok: landed, fail: operate-blocked } }',
  ].join('\n'));
  let active = 0;
  let maximumActive = 0;
  const result = await runGraph(graph, { deps: { root, runBash: async () => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    await Bun.sleep(20);
    active--;
    return { stdout: '{"outcome":"ok"}', stderr: '', exitCode: 0 };
  } } });
  expect(result.status).toBe('done');
  expect(maximumActive).toBe(5);
});

// A real ledger resolves release versions from git (seconds); park tests only need a card id.
function fakeGrowthDecision() {
  const entries: DecisionEntry[] = [];
  return { ledger: { raiseOnce: (value: Record<string, unknown>) => {
    const entry = { ...value, id: `D-fake-${entries.length + 1}`, status: 'open' } as DecisionEntry;
    entries.push(entry);
    return entry;
  } }, list: () => entries };
}

function approvalFixture(): { graph: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'graph-approval-'));
  dirs.push(root);
  writeFileSync(join(root, 'recipes.yaml'), 'a:\n  command: "exit 0"\ngate:\n  approval: "Publish now?"\nb:\n  command: "exit 0"\n');
  const graph = join(root, 'graph.yaml');
  writeFileSync(graph, `graph_id: approval-graph
version: 1
entry_node: a
terminal_nodes: [done, failed]
nodes:
  - { node_id: a, kind: agent, recipe: 'cmd:a', max_visits: 1 }
  - { node_id: gate, kind: judge, recipe: 'approval:gate', max_visits: 1 }
  - { node_id: b, kind: agent, recipe: 'cmd:b', max_visits: 1 }
  - { node_id: done, kind: gate, max_visits: 1 }
  - { node_id: failed, kind: gate, max_visits: 1 }
edges:
  - { from: a, to: gate }
  - from: gate
    on: outcome
    map: { ok: b, fail: failed }
  - { from: b, to: done }
`);
  return { graph, root };
}

function unitFixture(innerSteps = 3, parentAllowance?: number, callAllowance?: number): { graph: string; root: string; unit: string } {
  const root = mkdtempSync(join(tmpdir(), 'graph-unit-'));
  dirs.push(root);
  const unitDir = join(root, 'units');
  mkdirSync(unitDir);
  const graph = join(root, 'graph.yaml');
  const unit = join(unitDir, 'worker.yaml');
  writeFileSync(join(root, 'recipes.yaml'), '{}\n');
  writeFileSync(join(unitDir, 'recipes.yaml'), `produce:
  command: >-
    bun -e 'const c=JSON.parse(require("fs").readFileSync(process.env.ELANOUS_GRAPH_CONTEXT,"utf8")); console.log(JSON.stringify({answer:c.input.request==="hello"?"world":"unexpected"}))'
`);
  writeFileSync(graph, `graph_id: parent
version: 1
entry_node: invoke
terminal_nodes: ${parentAllowance === undefined ? '[done, failed]' : '[done, failed, needs-human]'}
${parentAllowance === undefined ? '' : `allowance: { inner_steps: ${parentAllowance} }\n`}
nodes:
  - node_id: invoke
    kind: subgraph
    recipe: none
    max_visits: 1
    call: worker@1
    budget: { inner_steps: ${innerSteps} }
${callAllowance === undefined ? '' : `    allowance: { inner_steps: ${callAllowance} }\n`}
    contract: { inputs: [request], tools: read-only, outputs: [answer] }
  - { node_id: done, kind: gate, max_visits: 1 }
  - { node_id: failed, kind: gate, max_visits: 1 }
${parentAllowance === undefined ? '' : '  - { node_id: needs-human, kind: gate, max_visits: 1 }\n'}
edges:
  - { from: invoke, on: outcome, map: { done: done, failed: failed${parentAllowance === undefined ? '' : ', needs-human: needs-human, rework: needs-human'} } }
`);
  writeFileSync(unit, `graph_id: worker
version: 1
unit: { inputs: [request], outputs: [answer], exits: ${parentAllowance === undefined ? '[done, failed]' : '[done, failed, needs-human, rework]'} }
entry_node: produce
terminal_nodes: ${parentAllowance === undefined ? '[done, failed]' : '[done, failed, needs-human, rework]'}
nodes:
  - { node_id: produce, kind: agent, recipe: 'cmd:produce', max_visits: 1 }
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }
${parentAllowance === undefined ? '' : '  - { node_id: needs-human, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: rework, kind: gate, recipe: none, max_visits: 1 }\n'}
edges:
  - { from: produce, on: outcome, map: { ok: done, fail: failed } }
`);
  return { graph, root, unit };
}

function unitFixtureWithPriorResult(result: string | null | 'absent' = 'from-previous-verb'): { graph: string; root: string; unit: string } {
  const fixture = unitFixture();
  writeFileSync(join(fixture.root, 'recipes.yaml'), `seed:\n  command: >-\n    printf '%s' '${result === 'absent' ? '{"other":"no-result"}' : JSON.stringify({ result })}'\n`);
  writeFileSync(join(fixture.root, 'units', 'recipes.yaml'), `produce:\n  command: >-\n    bun -e 'const c=JSON.parse(require("fs").readFileSync(process.env.ELANOUS_GRAPH_CONTEXT,"utf8")); console.log(JSON.stringify({answer:c.input.prior}))'\n`);
  writeFileSync(fixture.graph, readFileSync(fixture.graph, 'utf8')
    .replace('entry_node: invoke', 'entry_node: seed')
    .replace('  - node_id: invoke', "  - { node_id: seed, kind: agent, recipe: 'cmd:seed', max_visits: 1 }\n  - node_id: invoke")
    .replace('contract: { inputs: [request], tools: read-only, outputs: [answer] }',
      'contract: { inputs: [prior], tools: read-only, outputs: [answer] }')
    .replace('edges:\n  - { from: invoke', 'edges:\n  - { from: seed, to: invoke }\n  - { from: invoke'));
  writeFileSync(fixture.unit, readFileSync(fixture.unit, 'utf8')
    .replace('inputs: [request]', 'inputs: [prior]'));
  return fixture;
}

test('subgraph runs a child with contracted input/output and linked ledgers plus enter/exit events', async () => {
  const { graph, root } = unitFixture();
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const parent = await runGraph(graph, { runId: 'parent-1', input: { request: 'hello' }, deps: { root,
    log: (event, data) => { events.push({ event, data }); },
  } });
  expect(parent.status).toBe('done');
  expect(parent.path).toEqual(['invoke', 'done']);
  expect(parent.unitCalls).toHaveLength(1);
  const childRunId = parent.unitCalls![0]!.childRunId;
  expect(typeof childRunId).toBe('string');
  expect(parent.unitCalls![0]).toMatchObject({ node: 'invoke', unit: 'worker', version: 1, hash: expect.any(String),
    exit: 'done', steps: 2 });
  expect(parent.nodes[0]).toMatchObject({ executed: true, output: '{"outcome":"done","answer":"world"}' });
  const child = JSON.parse(readFileSync(join(root, 'graph-runs', 'worker', `${childRunId}.json`), 'utf8'));
  expect(child).toMatchObject({ runId: childRunId, graphId: 'worker', parentRunId: parent.runId, status: 'done', input: { request: 'hello' } });
  expect(JSON.parse(readFileSync(parent.statePath, 'utf8')).unitCalls).toEqual(parent.unitCalls);
  expect(events.filter(entry => entry.event === 'graph.unit')).toMatchObject([
    { data: { phase: 'enter', runId: parent.runId, childRunId } },
    { data: { phase: 'exit', runId: parent.runId, childRunId, exit: 'done', steps: 2 } },
  ]);
  expect(debug.events(500).filter(entry => entry.category === 'graph.unit' &&
    (entry.data as { runId?: string })?.runId === parent.runId).map(entry => entry.event)).toEqual(['enter', 'exit']);
});

test('GRAPH-UNIT-SPAN-DURATION: one unit visit carries monotonic enter/exit stamps and a non-negative duration', async () => {
  const { graph, root } = unitFixture();
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  let clock = 5_000;
  const parent = await runGraph(graph, { runId: 'parent-span', input: { request: 'hello' }, deps: { root,
    monotonicMs: () => { const now = clock; clock += 250; return now; },
    log: (event, data) => { events.push({ event, data }); },
  } });
  expect(parent.status).toBe('done');
  expect(parent.path).toEqual(['invoke', 'done']);
  const unitEvents = events.filter(entry => entry.event === 'graph.unit');
  const enter = unitEvents.find(entry => entry.data.phase === 'enter');
  const exit = unitEvents.find(entry => entry.data.phase === 'exit')!;
  const childRunId = parent.unitCalls![0]!.childRunId;
  // Same (runId, unit, visit): the two originals name the same visit and carry its bounds.
  expect(enter?.data).toMatchObject({ runId: parent.runId, childRunId, nodeId: 'invoke', unit: 'worker', visit: 1, enteredAtMs: 5_000 });
  expect(exit.data).toMatchObject({ runId: parent.runId, childRunId, nodeId: 'invoke', unit: 'worker', visit: 1,
    enteredAtMs: 5_000, exitedAtMs: 5_250, durationMs: 250 });
  const durationMs = exit.data.durationMs as number;
  expect(durationMs).toBe((exit.data.exitedAtMs as number) - (enter?.data.enteredAtMs as number));
  expect(durationMs).toBeGreaterThanOrEqual(0);
  // The span rides the ledger entry the run persists, not only the event stream.
  expect(parent.unitCalls![0]).toMatchObject({ visit: 1, enteredAtMs: 5_000, exitedAtMs: 5_250, durationMs });
  expect(JSON.parse(readFileSync(parent.statePath, 'utf8')).unitCalls[0])
    .toMatchObject({ visit: 1, enteredAtMs: 5_000, exitedAtMs: 5_250, durationMs });
  expect(debug.events(500).filter(entry => entry.category === 'graph.unit' &&
    (entry.data as { runId?: string }).runId === parent.runId)
    .map(entry => ({ event: entry.event, visit: (entry.data as { visit?: number }).visit })))
    .toEqual([{ event: 'enter', visit: 1 }, { event: 'exit', visit: 1 }]);
  // Replayable receipt for the cell's «실물» box: GRAPH_UNIT_SPAN_RECEIPT=1 prints the
  // enter/exit originals of this production run and the duration computed from them.
  if (process.env.GRAPH_UNIT_SPAN_RECEIPT === '1') {
    console.log(`[span] enter ${JSON.stringify(enter?.data)}`);
    console.log(`[span] exit ${JSON.stringify(exit.data)}`);
    console.log(`[span] duration ${JSON.stringify({ runId: parent.runId, unit: 'worker', visit: 1,
      entered: enter?.data.enteredAtMs, exited: exit.data.exitedAtMs, durationMs })}`);
  }
});

test('GRAPH-UNIT-SPAN-DURATION: a clock that runs backwards clamps the visit duration to zero', async () => {
  const { graph, root } = unitFixture();
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const readings = [9_000, 8_000];
  let cursor = 0;
  const parent = await runGraph(graph, { runId: 'parent-span-backwards', input: { request: 'hello' }, deps: { root,
    monotonicMs: () => readings[Math.min(cursor++, readings.length - 1)]!,
    log: (event, data) => { events.push({ event, data }); },
  } });
  expect(parent.status).toBe('done');
  const exit = events.find(entry => entry.event === 'graph.unit' && entry.data.phase === 'exit')!;
  expect(exit.data).toMatchObject({ visit: 1, enteredAtMs: 9_000, exitedAtMs: 8_000, durationMs: 0 });
  expect(parent.unitCalls![0]).toMatchObject({ visit: 1, enteredAtMs: 9_000, exitedAtMs: 8_000, durationMs: 0 });
});

test('GRAPH-UNIT-SPAN-DURATION: two visits of one unit get distinct visit ids and their own span', async () => {
  const { graph, root } = unitFixture();
  writeFileSync(graph, `graph_id: parent
version: 1
entry_node: first
terminal_nodes: [done, failed]
nodes:
  - node_id: first
    kind: subgraph
    recipe: none
    max_visits: 1
    call: worker@1
    budget: { inner_steps: 3 }
    contract: { inputs: [request], tools: read-only, outputs: [answer] }
  - node_id: second
    kind: subgraph
    recipe: none
    max_visits: 1
    call: worker@1
    budget: { inner_steps: 3 }
    contract: { inputs: [request], tools: read-only, outputs: [answer] }
  - { node_id: done, kind: gate, max_visits: 1 }
  - { node_id: failed, kind: gate, max_visits: 1 }
edges:
  - { from: first, on: outcome, map: { done: second, failed: failed } }
  - { from: second, on: outcome, map: { done: done, failed: failed } }
`);
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  let clock = 1_000;
  const parent = await runGraph(graph, { runId: 'parent-span-twice', input: { request: 'hello' },
    deps: { root, monotonicMs: () => { const now = clock; clock += 250; return now; },
      log: (event, data) => { events.push({ event, data }); } } });
  expect(parent.status).toBe('done');
  expect(parent.path).toEqual(['first', 'second', 'done']);
  expect(parent.unitCalls!.map(call => call.visit)).toEqual([1, 2]);
  expect(new Set(parent.unitCalls!.map(call => call.childRunId)).size).toBe(2);
  const spans = events.filter(entry => entry.event === 'graph.unit' && entry.data.phase !== undefined)
    .map(entry => entry.data as { phase: string; visit: number; enteredAtMs: number; exitedAtMs?: number; durationMs?: number });
  expect(spans.map(span => `${span.phase}:${span.visit}`)).toEqual(['enter:1', 'exit:1', 'enter:2', 'exit:2']);
  for (const visit of [1, 2]) {
    const enter = spans.find(span => span.phase === 'enter' && span.visit === visit)!;
    const exit = spans.find(span => span.phase === 'exit' && span.visit === visit)!;
    expect(exit.enteredAtMs).toBe(enter.enteredAtMs);
    expect(exit.durationMs).toBe(exit.exitedAtMs! - enter.enteredAtMs);
    expect(exit.durationMs).toBeGreaterThanOrEqual(0);
    expect(parent.unitCalls![visit - 1]).toMatchObject({ visit, enteredAtMs: enter.enteredAtMs, durationMs: exit.durationMs });
  }
  expect(spans[1]!.exitedAtMs!).toBeLessThan(spans[2]!.enteredAtMs!);
});

test('GRAPH-UNIT-SPAN-DURATION: a resumed run continues the visit sequence instead of reusing visit 1', async () => {
  const { graph, root } = unitFixture();
  writeFileSync(join(root, 'recipes.yaml'), "post:\n  command: 'printf posted'\n");
  writeFileSync(graph, readFileSync(graph, 'utf8')
    .replace('    max_visits: 1\n    call: worker@1', '    max_visits: 2\n    call: worker@1')
    .replace('  - { node_id: done', "  - { node_id: post, kind: agent, recipe: 'cmd:post', max_visits: 2 }\n  - { node_id: done")
    .replace('edges:\n  - { from: invoke, on: outcome, map: { done: done, failed: failed } }',
      'edges:\n  - { from: invoke, on: outcome, map: { done: post, failed: failed } }\n  - { from: post, on: outcome, map: { ok: done, fail: failed } }'));
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  let postRuns = 0;
  let clock = 1_000;
  const deps = { root,
    monotonicMs: () => { const now = clock; clock += 100; return now; },
    log: (event: string, data: Record<string, unknown>) => { events.push({ event, data }); },
    runBash: async (body: string) => body === 'printf posted'
      ? { stdout: 'posted', stderr: '', exitCode: postRuns++ === 0 ? 1 : 0 }
      : { stdout: JSON.stringify({ answer: 'world' }), stderr: '', exitCode: 0 } };
  const first = await runGraph(graph, { runId: 'parent-span-resume', input: { request: 'hello' }, deps });
  expect(first.status).toBe('failed');
  expect(first.unitCalls!.map(call => call.visit)).toEqual([1]);
  const resumed = await runGraph(graph, { resumeRunId: first.runId, fromNodeId: 'invoke', deps });
  expect(resumed.status).toBe('done');
  // A restart rewinds the ledger, but the same runId must not hand out visit 1 twice:
  // the two lifetimes of this run are two distinct (runId, unit, visit) spans.
  expect(resumed.unitCalls!.map(call => call.visit)).toEqual([2]);
  const visitIds = events.filter(entry => entry.event === 'graph.unit' && entry.data.phase === 'enter')
    .map(entry => (entry.data as { visit: number }).visit);
  expect(visitIds).toEqual([1, 2]);
  const resumedCall = resumed.unitCalls![0]!;
  expect(resumedCall.durationMs).toBe(resumedCall.exitedAtMs! - resumedCall.enteredAtMs!);
  expect(resumedCall.durationMs).toBeGreaterThanOrEqual(0);
});

test('child allowance clamps to the parent remainder and records the clamp before the child runs', async () => {
  const { graph, root } = unitFixture(8, 3, 6);
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const result = await runGraph(graph, { input: { request: 'hello' }, deps: { root,
    runBash: async () => ({ stdout: '{"answer":"world"}', stderr: '', exitCode: 0 }),
    log: (event, data) => { events.push({ event, data }); },
  } });
  expect(result.status).toBe('done');
  expect(result.path).toEqual(['invoke', 'done']);
  expect(result.unitCalls?.[0]?.steps).toBe(2);
  expect(events.find(entry => entry.event === 'graph.unit' && entry.data.phase === 'allowance-clamped')?.data)
    .toMatchObject({ requested: 6, granted: 2, remaining: 2 });
});

test('zero inherited allowance skips child execution and follows needs-human', async () => {
  const { graph, root } = unitFixture(8, 1);
  let executions = 0;
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const result = await runGraph(graph, { input: { request: 'hello' }, deps: { root,
    runBash: async () => { executions++; return { stdout: '{"answer":"world"}', stderr: '', exitCode: 0 }; },
    log: (event, data) => { events.push({ event, data }); },
  } });
  expect(result.status).toBe('failed');
  expect(result.path).toEqual(['invoke', 'needs-human']);
  expect(executions).toBe(0);
  expect(result.unitCalls).toBeUndefined();
  expect(JSON.parse(result.nodes[0]!.output as string)).toEqual({ outcome: 'needs-human' });
  expect(events.some(entry => entry.event === 'graph.unit' && entry.data.phase === 'allowance-exhausted' && entry.data.remaining === 0)).toBe(true);
});

test('subgraph prior input receives the previous node result', async () => {
  const { graph, root } = unitFixtureWithPriorResult();
  try {
    const result = await runGraph(graph, { deps: { root } });
    expect(result.status).toBe('done');
    expect(result.path).toEqual(['seed', 'invoke', 'done']);
    expect(result.nodes.find(node => node.nodeId === 'invoke')?.output)
      .toBe('{"outcome":"done","answer":"from-previous-verb"}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('explicit input prior takes precedence over the previous node result', async () => {
  const { graph, root } = unitFixtureWithPriorResult();
  try {
    const result = await runGraph(graph, { input: { prior: 'explicit-input' }, deps: { root } });
    expect(result.status).toBe('done');
    expect(result.nodes.find(node => node.nodeId === 'invoke')?.output)
      .toBe('{"outcome":"done","answer":"explicit-input"}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unit prior input defaults to an empty object when the previous result is absent', async () => {
  const { graph, root } = unitFixtureWithPriorResult('absent');
  try {
    const result = await runGraph(graph, { deps: { root } });
    expect(result.status).toBe('done');
    expect(result.path).toEqual(['seed', 'invoke', 'done']);
    expect(result.nodes.find(node => node.nodeId === 'invoke')?.output)
      .toBe('{"outcome":"done","answer":{}}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unit prior input preserves an explicit null previous result', async () => {
  const { graph, root } = unitFixtureWithPriorResult(null);
  try {
    const result = await runGraph(graph, { deps: { root } });
    expect(result.status).toBe('done');
    expect(result.nodes.find(node => node.nodeId === 'invoke')?.output)
      .toBe('{"outcome":"done","answer":null}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unit named terminal exits are returned as outcomes and select the parent route', async () => {
  const { graph, root, unit } = unitFixture();
  try {
    writeFileSync(unit, readFileSync(unit, 'utf8').replaceAll('done', 'rework'));
    writeFileSync(graph, readFileSync(graph, 'utf8').replace('map: { done: done, failed: failed }',
      'map: { rework: done, failed: failed }'));
    const result = await runGraph(graph, { input: { request: 'hello' }, deps: { root } });
    expect(result.status).toBe('done');
    expect(result.path).toEqual(['invoke', 'done']);
    expect(result.unitCalls?.[0]?.exit).toBe('rework');
    expect(result.nodes[0]?.output).toBe('{"outcome":"rework","answer":"world"}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a unit failed exit still selects its declared parent outcome edge', async () => {
  const { graph, root, unit } = unitFixture();
  try {
    writeFileSync(join(root, 'units', 'recipes.yaml'), `produce:\n  command: >-\n    printf '%s' '{"outcome":"failed","answer":"world"}'\n`);
    writeFileSync(unit, readFileSync(unit, 'utf8').replace('map: { ok: done, fail: failed }',
      'map: { failed: failed, ok: done }'));
    writeFileSync(graph, readFileSync(graph, 'utf8').replace('map: { done: done, failed: failed }',
      'map: { done: done, failed: done }'));
    const result = await runGraph(graph, { input: { request: 'hello' }, deps: { root } });
    expect(result.status).toBe('done');
    expect(result.path).toEqual(['invoke', 'done']);
    expect(result.unitCalls?.[0]?.exit).toBe('failed');
    expect(result.nodes[0]?.output).toBe('{"outcome":"failed","answer":"world"}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a multi-entry unit starts at the call-selected entry and rejects an undeclared entry before execution', async () => {
  const { graph, root, unit } = unitFixture();
  writeFileSync(unit, readFileSync(unit, 'utf8')
    .replace('exits: [done, failed]', 'exits: [done, failed], entries: [produce, alternate]')
    .replace('  - { node_id: done, kind: gate', "  - { node_id: alternate, kind: agent, recipe: 'cmd:produce', max_visits: 1 }\n  - { node_id: done, kind: gate")
    .replace('  - { from: produce, on: outcome, map: { ok: done, fail: failed } }',
      '  - { from: produce, on: outcome, map: { ok: done, fail: failed } }\n  - { from: alternate, on: outcome, map: { ok: done, fail: failed } }'));
  const original = readFileSync(graph, 'utf8');
  writeFileSync(graph, original.replace('    call: worker@1', '    call: worker@1\n    call_entry: alternate'));
  const run = await runGraph(graph, { input: { request: 'hello' }, deps: { root,
    runBash: async () => ({ stdout: '{"answer":"alternate"}', stderr: '', exitCode: 0 }),
  } });
  expect(run.status).toBe('done');
  const child = JSON.parse(readFileSync(join(root, 'graph-runs', 'worker', `${run.unitCalls![0]!.childRunId}.json`), 'utf8'));
  expect(child.path).toEqual(['alternate', 'done']);
  expect(child.entryNodeId).toBe('alternate');
  expect(run.unitCalls![0]?.entry).toBe('alternate');
  expect(run.nodes[0]?.output).toBe('{"outcome":"done","answer":"alternate"}');

  writeFileSync(graph, original);
  const events: Array<Record<string, unknown>> = [];
  const defaultRun = await runGraph(graph, { input: { request: 'hello' }, deps: { root,
    runBash: async () => ({ stdout: '{"answer":"default"}', stderr: '', exitCode: 0 }),
    log: (event, data) => { if (event === 'graph.unit') events.push(data); },
  } });
  const defaultChild = JSON.parse(readFileSync(join(root, 'graph-runs', 'worker', `${defaultRun.unitCalls![0]!.childRunId}.json`), 'utf8'));
  expect(defaultChild.path).toEqual(['produce', 'done']);
  expect(defaultChild.entryNodeId).toBe('produce');
  expect(defaultRun.unitCalls![0]?.entry).toBe('produce');
  expect(events.map(event => event.entry)).toEqual(['produce', 'produce']);

  writeFileSync(graph, original.replace('    call: worker@1', '    call: worker@1\n    call_entry: missing'));
  let invoked = 0;
  await expect(runGraph(graph, { input: { request: 'hello' }, deps: { root,
    runBash: async () => { invoked++; return { stdout: '{}', stderr: '', exitCode: 0 }; },
  } })).rejects.toThrow('unit entry mismatch');
  expect(invoked).toBe(0);
});

test('subgraph reads contracted output from the producing record despite intervening nodes', async () => {
  const { graph, root, unit } = unitFixture(4);
  writeFileSync(join(root, 'units', 'recipes.yaml'), `${readFileSync(join(root, 'units', 'recipes.yaml'), 'utf8')}inspect:\n  command: 'echo inspected'\n`);
  writeFileSync(unit, readFileSync(unit, 'utf8')
    .replace("  - { node_id: done, kind: gate", "  - { node_id: inspect, kind: agent, recipe: 'cmd:inspect', max_visits: 1 }\n  - { node_id: done, kind: gate")
    .replace('map: { ok: done, fail: failed } }', 'map: { ok: inspect, fail: failed } }\n  - { from: inspect, on: outcome, map: { ok: done, fail: failed } }'));
  const run = await runGraph(graph, { input: { request: 'hello' }, deps: { root,
    runBash: async (_body, opts) => ({ stdout: opts.env?.ELANOUS_GRAPH_CONTEXT &&
      JSON.parse(readFileSync(opts.env.ELANOUS_GRAPH_CONTEXT, 'utf8')).nodeId === 'produce'
      ? '{"answer":"world"}' : 'inspected', stderr: '', exitCode: 0 }),
  } });
  expect(run.status).toBe('done');
  expect(run.nodes[0]?.output).toBe('{"outcome":"done","answer":"world"}');
  expect(run.unitCalls?.[0]?.steps).toBe(3);
});

test('subgraph rejects incompatible contracts, missing inputs/outputs, over-budget work and cycles', async () => {
  const { graph, root, unit } = unitFixture();
  const original = readFileSync(graph, 'utf8');
  const deps = { root, runBash: async () => ({ stdout: '{"answer":"world"}', stderr: '', exitCode: 0 }) };
  writeFileSync(graph, original.replace('outputs: [answer]', 'outputs: [other]'));
  await expect(runGraph(graph, { input: { request: 'hello' }, deps })).rejects.toThrow('unit contract mismatch');
  expect(existsSync(join(root, 'graph-runs'))).toBe(false);
  writeFileSync(graph, original);
  const rejectedEvents: Array<{ event: string; data: Record<string, unknown> }> = [];
  const noInput = await runGraph(graph, { deps: { ...deps, log: (event, data) => { rejectedEvents.push({ event, data }); } } });
  expect(rejectedEvents.filter(entry => entry.event === 'graph.unit')).toEqual([]);
  expect(noInput.status).toBe('failed');
  expect(noInput.nodes[0]).toMatchObject({ executed: false, error: expect.stringContaining('unit input missing') });
  expect(noInput.nodes[0]?.failure).toMatchObject({
    errorCode: 'GRAPH_UNIT_INPUT_MISSING',
    message: expect.stringContaining('unit input missing'),
    stage: 'unit-invocation',
  });
  expect(rejectedEvents.find(entry => entry.event === 'node-end')?.data).toMatchObject({
    ok: false,
    reason: expect.stringContaining('unit input missing'),
    failure: { errorCode: 'GRAPH_UNIT_INPUT_MISSING', stage: 'unit-invocation' },
  });
  expect(noInput.executed).toBe(0);
  expect(JSON.parse(readFileSync(noInput.statePath, 'utf8')).nodes[0].executed).toBe(false);
  expect(noInput.unitCalls).toBeUndefined();
  expect(existsSync(join(root, 'graph-runs', 'worker'))).toBe(false);
  const noOutput = await runGraph(graph, { input: { request: 'hello' }, deps: { root,
    runBash: async () => ({ stdout: '{}', stderr: '', exitCode: 0 }) } });
  expect(noOutput.status).toBe('failed');
  expect(noOutput.nodes[0]?.error).toContain('unit output missing');
  writeFileSync(graph, original.replace('inner_steps: 3', 'inner_steps: 1'));
  const budget = await runGraph(graph, { input: { request: 'hello' }, deps });
  expect(budget.status).toBe('failed');
  expect(budget.nodes[0]?.error).toContain('unit inner_steps exceeded');
  writeFileSync(graph, original);
  writeFileSync(unit, readFileSync(unit, 'utf8').replace('  - { node_id: produce, kind: agent, recipe: \'cmd:produce\', max_visits: 1 }',
    '  - { node_id: produce, kind: subgraph, recipe: none, max_visits: 1, call: worker@1, budget: { inner_steps: 4 }, contract: { inputs: [request], tools: read-only, outputs: [answer] } }')
    .replace('map: { ok: done, fail: failed }', 'map: { done: done, failed: failed }'));
  await expect(runGraph(graph, { input: { request: 'hello' }, deps })).rejects.toThrow('unit cycle');
});

test('unit source changed after validation has no enter/exit or child ledger', async () => {
  const { graph, root, unit } = unitFixture();
  const events: string[] = [];
  const run = await runGraph(graph, { input: { request: 'hello' }, deps: { root,
    beforeNode: () => { if (events.length === 0) writeFileSync(unit, `${readFileSync(unit, 'utf8')}\n`); events.push('visited'); },
    log: event => { if (event === 'graph.unit') events.push(event); },
  } });
  expect(run.status).toBe('failed');
  expect(run.nodes[0]).toMatchObject({ executed: false, error: expect.stringContaining('unit source changed before call') });
  expect(run.executed).toBe(0);
  expect(JSON.parse(readFileSync(run.statePath, 'utf8')).nodes[0].executed).toBe(false);
  expect(events).not.toContain('graph.unit');
  expect(run.unitCalls).toBeUndefined();
  expect(existsSync(join(root, 'graph-runs', 'worker'))).toBe(false);
});

test('nested units reject a fourth level before any command, and child failure keeps both ledgers linked', async () => {
  const { graph, root, unit } = unitFixture();
  const source = readFileSync(unit, 'utf8');
  const unitDir = join(root, 'units');
  for (const [id, next] of [['worker', 'level-2'], ['level-2', 'level-3'], ['level-3', 'level-4']] as const) {
    const content = source.replace('graph_id: worker', `graph_id: ${id}`)
      .replace('  - { node_id: produce, kind: agent, recipe: \'cmd:produce\', max_visits: 1 }',
        `  - { node_id: produce, kind: subgraph, recipe: none, max_visits: 1, call: ${next}@1, budget: { inner_steps: 20 }, contract: { inputs: [request], tools: read-only, outputs: [answer] } }`)
      .replace('map: { ok: done, fail: failed }', 'map: { done: done, failed: failed }');
    writeFileSync(join(unitDir, `${id}.yaml`), content);
  }
  writeFileSync(join(unitDir, 'level-4.yaml'), source.replace('graph_id: worker', 'graph_id: level-4'));
  let calls = 0;
  await expect(runGraph(graph, { input: { request: 'hello' }, deps: { root, runBash: async () => {
    calls++;
    return { stdout: '', stderr: '', exitCode: 0 };
  } } })).rejects.toThrow('unit nesting exceeds depth 3');
  expect(calls).toBe(0);
  writeFileSync(unit, source);
  const failed = await runGraph(graph, { input: { request: 'hello' }, deps: { root,
    runBash: async () => ({ stdout: '{"answer":"unavailable"}', stderr: '', exitCode: 1 }) } });
  expect(failed.status).toBe('failed');
  expect(failed.unitCalls).toHaveLength(1);
  const child = JSON.parse(readFileSync(join(root, 'graph-runs', 'worker', `${failed.unitCalls![0]!.childRunId}.json`), 'utf8'));
  expect(child.parentRunId).toBe(failed.runId);
  expect(child.status).toBe('failed');
  expect(failed.unitCalls![0]!.exit).toBe('failed');
});

test('subgraph dry run plans the walk without a child run, unit event or unitCalls entry', async () => {
  const { graph, root } = unitFixture();
  const events: string[] = [];
  let calls = 0;
  const run = await runGraph(graph, { dryRun: true, input: { request: 'hello' }, deps: { root,
    runBash: async () => { calls++; return { stdout: '{"answer":"world"}', stderr: '', exitCode: 0 }; },
    log: event => { events.push(event); } } });
  expect(run.status).toBe('done');
  expect(run.path).toEqual(['invoke', 'done']);
  expect(run.nodes[0]).toMatchObject({ executed: false });
  expect(run.executed).toBe(0);
  expect(run.unitCalls).toBeUndefined();
  expect(calls).toBe(0);
  expect(events).not.toContain('graph.unit');
  expect(existsSync(join(root, 'graph-runs', 'worker'))).toBe(false);
});

test('child unit events carry parentRunId; contract mismatch and budget exhaustion emit graph.unit events', async () => {
  const { graph, root } = unitFixture();
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const parent = await runGraph(graph, { input: { request: 'hello' }, deps: { root, log: (event, data) => { events.push({ event, data }); } } });
  const childRunId = parent.unitCalls![0]!.childRunId;
  const childEvents = events.filter(entry => entry.data.runId === childRunId);
  expect(childEvents.length).toBeGreaterThan(0);
  expect(childEvents.every(entry => entry.data.parentRunId === parent.runId)).toBe(true);
  expect(events.filter(entry => entry.data.runId === parent.runId).some(entry => 'parentRunId' in entry.data && entry.event !== 'graph.unit')).toBe(false);

  const original = readFileSync(graph, 'utf8');
  writeFileSync(graph, original.replace('outputs: [answer]', 'outputs: [other]'));
  await expect(runGraph(graph, { input: { request: 'hello' }, deps: { root } })).rejects.toThrow('unit contract mismatch');
  expect(debug.events(500).some(entry => entry.category === 'graph.unit' && entry.event === 'contract-mismatch' &&
    (entry.data as { nodeId?: string })?.nodeId === 'invoke')).toBe(true);

  writeFileSync(graph, original.replace('inner_steps: 3', 'inner_steps: 1'));
  const budgetEvents: Array<{ event: string; data: Record<string, unknown> }> = [];
  const budget = await runGraph(graph, { input: { request: 'hello' }, deps: { root,
    runBash: async () => ({ stdout: '{"answer":"world"}', stderr: '', exitCode: 0 }),
    log: (event, data) => { budgetEvents.push({ event, data }); } } });
  expect(budget.status).toBe('failed');
  expect(budgetEvents.filter(entry => entry.event === 'graph.unit' && entry.data.runId === budget.runId).map(entry => entry.data.phase))
    .toEqual(['enter', 'budget-exhausted', 'exit']);
});

test('installed plugin graphs receive only their own credential environment', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-credential-'));
  dirs.push(root);
  const previous = process.env.ELANOUS_STATE_DIR;
  const previousOwn = process.env.SAMPLE_PLUGIN_KEY;
  const previousOther = process.env.OTHER_PLUGIN_KEY;
  process.env.ELANOUS_STATE_DIR = root;
  try {
    for (const name of ['sample-plugin', 'other-plugin']) {
      const path = join(root, 'plugins', 'local', name, '1.0.0');
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'plugin.ts'), 'export default {}');
      writeFileSync(join(path, 'plugin.json'), JSON.stringify({ id: name, version: '1.0.0', main: './plugin.ts',
        contributes: { connectors: [{ id: 'service', fields: [{ name: 'KEY', env: `${name.replace('-', '_').toUpperCase()}_KEY` }] }] } }));
    }
    setPluginCredentials('sample-plugin', { KEY: 'sample-secret' }, root);
    setPluginCredentials('other-plugin', { KEY: 'other-secret' }, root);
    const { graph: source } = fixture('exit 0');
    const graph = join(root, 'plugins', 'local', 'sample-plugin', '1.0.0', 'graphs', 'graph.yaml');
    mkdirSync(join(graph, '..'), { recursive: true });
    writeFileSync(graph, readFileSync(source, 'utf8'));
    writeFileSync(join(graph, '..', 'recipes.yaml'), readFileSync(join(source, '..', 'recipes.yaml'), 'utf8')
      .replaceAll('command: "exit 0"', 'command: "exit 0"\n  dry_run_command: "exit 0"'));
    const envs: NodeJS.ProcessEnv[] = [];
    process.env.OTHER_PLUGIN_KEY = 'inherited-other-secret';
    process.env.SAMPLE_PLUGIN_KEY = 'inherited-own-secret';
    const run = await runGraph(graph, { deps: { root, runBash: async (_body, opts) => {
      envs.push(opts.env!);
      return { stdout: 'sample-secret', stderr: '', exitCode: 0 };
    } } });
    expect(run.status).toBe('done');
    expect(envs).toHaveLength(2);
    expect(envs[0]?.SAMPLE_PLUGIN_KEY).toBe('sample-secret');
    expect(envs[0]?.OTHER_PLUGIN_KEY).toBeUndefined();
    expect(JSON.stringify(run.nodes)).toContain('[REDACTED]');
    expect(JSON.stringify(run)).not.toContain('sample-secret');
    expect(JSON.stringify(run)).not.toContain('other-secret');
    envs.length = 0;
    const preview = await runGraph(graph, { dryRun: true, deps: { root, runBash: async (_body, opts) => {
      envs.push(opts.env!);
      return { stdout: 'sample-secret', stderr: '', exitCode: 0 };
    } } });
    expect(preview.status).toBe('done');
    expect(envs).toHaveLength(2);
    expect(envs[0]?.SAMPLE_PLUGIN_KEY).toBe('sample-secret');
    expect(envs[0]?.OTHER_PLUGIN_KEY).toBeUndefined();
    expect(JSON.stringify(preview)).not.toContain('sample-secret');
    const outside = await runGraph(source, { deps: { root, runBash: async (_body, opts) => {
      expect(opts.env?.SAMPLE_PLUGIN_KEY).toBeUndefined();
      expect(opts.env?.OTHER_PLUGIN_KEY).toBeUndefined();
      return { stdout: '', stderr: '', exitCode: 0 };
    } } });
    expect(outside.status).toBe('done');
  } finally {
    if (previousOther === undefined) delete process.env.OTHER_PLUGIN_KEY;
    else process.env.OTHER_PLUGIN_KEY = previousOther;
    if (previousOwn === undefined) delete process.env.SAMPLE_PLUGIN_KEY;
    else process.env.SAMPLE_PLUGIN_KEY = previousOwn;
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previous;
  }
});

test('first write and approval resume stamp the runner pid and its process start', async () => {
  const { graph, root } = approvalFixture();
  let started = 1_000_000;
  const deps = { root, processStartMs: () => started, runBash: async () => {
    const files = join(root, 'graph-runs', 'approval-graph');
    const initial = JSON.parse(readFileSync(join(files, 'owner-check.json'), 'utf8'));
    expect(initial).toMatchObject({ pid: process.pid, pidStartedAt: new Date(started).toISOString() });
    return { stdout: '', stderr: '', exitCode: 0 };
  } };
  const first = await runGraph(graph, { runId: 'owner-check', deps });
  expect(JSON.parse(readFileSync(first.statePath, 'utf8'))).toMatchObject({ pid: process.pid, pidStartedAt: new Date(started).toISOString() });
  decideGraphApproval(first.graphId, first.runId, 'approved', 'operator', root);
  started += 10_000;
  const resumed = await runGraph(graph, { resumeRunId: first.runId, deps });
  expect(resumed.pid).toBe(process.pid);
  expect(JSON.parse(readFileSync(first.statePath, 'utf8')).pidStartedAt).toBe(new Date(started).toISOString());
});

test('stop during a new run prevents its node completion from overwriting the failed ledger', async () => {
  const { graph, root } = fixture('exit 0');
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const ongoing = runGraph(graph, { runId: 'concurrent-stop', deps: { root, runBash: async () => {
    entered();
    await blocked;
    return { stdout: '', stderr: '', exitCode: 0 };
  } } });
  await started;
  const file = join(root, 'graph-runs', 'test-graph', 'concurrent-stop.json');
  try {
    manageGraphRun('test-graph', 'concurrent-stop', 'stop', root, () => null);
  } finally { release(); }
  await expect(ongoing).rejects.toThrow('run was stopped or ownership changed');
  expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ status: 'failed', stoppedAt: expect.any(String) });
});

test('a command that exits before its pid start can be measured still completes', async () => {
  const { graph, root } = fixture('true');
  const state = await runGraph(graph, { deps: { root, processStartMs: pid => pid === process.pid ? Date.now() - process.uptime() * 1_000 : null } });
  expect(state.status).toBe('done');
  expect(state.nodes[0]).toMatchObject({ nodeId: 'first', ok: true, exit: 0 });
});

test('an unverified child still running is terminated rather than accepted as an unowned node', async () => {
  const { graph, root } = fixture('sleep 5');
  const state = await runGraph(graph, { deps: { root, processStartMs: pid => pid === process.pid ? Date.now() - process.uptime() * 1_000 : null } });
  expect(state.status).toBe('failed');
  expect(state.nodes[0]?.ok).toBe(false);
});

test('bash recipes without timeout_ms receive a finite default timeout', async () => {
  const { graph, root } = fixture('exit 0');
  let timeoutMs: number | undefined;
  const result = await runGraph(graph, { deps: { root, runBash: async (_body, opts) => {
    timeoutMs = opts.timeoutMs;
    return { stdout: '', stderr: '', exitCode: 0 };
  } } });
  expect(result.status).toBe('done');
  expect(timeoutMs).toBe(5 * 60 * 1_000);
});

test('bash recipes preserve an explicit timeout_ms and persist timed-out execution as a failure', async () => {
  const { graph, root } = fixture('sleep 1');
  writeFileSync(join(root, 'recipes.yaml'), `first:\n  command: "sleep 1"\n  timeout_ms: 30\nsecond:\n  command: "exit 0"\n`);
  const result = await runGraph(graph, { runId: 'timeout-failure', deps: { root } });
  const saved = JSON.parse(readFileSync(result.statePath, 'utf8'));
  expect(result.status).toBe('failed');
  expect(result.nodes[0]).toMatchObject({ nodeId: 'first', ok: false, exit: null, executed: true, error: expect.any(String) });
  expect(saved.status).toBe('failed');
  expect(saved.nodes[0]).toMatchObject({ nodeId: 'first', ok: false, exit: null, executed: true, error: expect.any(String) });
});

test('bash recipes pass through an explicit timeout_ms unchanged', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(join(root, 'recipes.yaml'), `first:\n  command: "exit 0"\n  timeout_ms: 1234\nsecond:\n  command: "exit 0"\n`);
  let timeoutMs: number | undefined;
  const result = await runGraph(graph, { deps: { root, runBash: async (_body, opts) => {
    timeoutMs ??= opts.timeoutMs;
    return { stdout: '', stderr: '', exitCode: 0 };
  } } });
  expect(result.status).toBe('done');
  expect(timeoutMs).toBe(1234);
});

test('failed command-spawn nodes persist exit and masked stderr tail on node-end', async () => {
  const { graph, root } = fixture('exit 0');
  const previousState = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = root;
  const pluginDir = join(root, 'plugins', 'local', 'sample-plugin', '1.0.0');
  const graphsDir = join(pluginDir, 'graphs');
  mkdirSync(graphsDir, { recursive: true });
  writeFileSync(join(pluginDir, 'plugin.ts'), 'export default {}');
  writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ id: 'sample-plugin', version: '1.0.0', main: './plugin.ts',
    contributes: { connectors: [{ id: 'service', fields: [{ name: 'KEY', env: 'SAMPLE_PLUGIN_KEY' }] }] } }));
  setPluginCredentials('sample-plugin', { KEY: 'node-secret' }, root);
  const pluginGraph = join(graphsDir, 'graph.yaml');
  writeFileSync(pluginGraph, readFileSync(graph, 'utf8'));
  writeFileSync(join(graphsDir, 'recipes.yaml'), readFileSync(join(root, 'recipes.yaml'), 'utf8'));
  const stderrLines = Array.from({ length: 45 }, (_, index) => `stderr line ${index + 1}`);
  stderrLines[44] = 'failed with node-secret';
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  try {
    const failed = await runGraph(pluginGraph, { runId: 'failure-reason', deps: { root,
      runBash: async () => ({ stdout: '', stderr: stderrLines.join('\n'), exitCode: 7 }),
      log: (event, data) => events.push({ event, data }),
    } });
    const expectedReason = [...stderrLines.slice(-40, -1), 'failed with [REDACTED]'].join('\n');
    expect(failed.nodes[0]).toMatchObject({ exit: 7, reason: expectedReason });
    expect(failed.nodes[0]?.reason?.split('\n')).toHaveLength(40);
    expect(JSON.stringify(failed.nodes)).not.toContain('node-secret');
    expect(events.find(entry => entry.event === 'node-end' && entry.data.nodeId === 'first')?.data)
      .toMatchObject({ ok: false, exit: 7, reason: expectedReason });

    const successful = await runGraph(pluginGraph, { runId: 'success-no-reason', deps: { root,
      runBash: async () => ({ stdout: '', stderr: 'node-secret on successful stderr', exitCode: 0 }),
    } });
    expect(successful.nodes[0]).toMatchObject({ exit: 0, ok: true });
    expect(successful.nodes[0]).not.toHaveProperty('reason');

    const emptyFailure = await runGraph(pluginGraph, { runId: 'empty-failure-reason', deps: { root,
      runBash: async () => ({ stdout: '', stderr: '', exitCode: 9 }),
    } });
    expect(emptyFailure.nodes[0]).toMatchObject({ exit: 9, ok: false });
    expect(emptyFailure.nodes[0]).toMatchObject({
      reason: expect.stringContaining('bash exit 9'),
      failure: { errorCode: 'GRAPH_NODE_FAILED', stage: 'command-execution', message: expect.stringContaining('bash exit 9') },
    });
  } finally {
    if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previousState;
  }
});

test('two successful commands reach done and persist both outcomes', async () => {
  const { graph, root } = fixture('exit 0');
  const result = await runGraph(graph, { runId: 'success', deps: { root } });
  expect(result.status).toBe('done');
  expect(result.path).toEqual(['first', 'second', 'done']);
  expect(result.executed).toBe(2);
  expect(result.unitCalls).toBeUndefined();
  expect(result.parentRunId).toBeUndefined();
  expect(result.statePath).toBe(join(root, 'graph-runs', 'test-graph', 'success.json'));
  expect(existsSync(join(root, 'heal', 'inbox.jsonl'))).toBe(false);
  expect(JSON.parse(readFileSync(result.statePath, 'utf8')).nodes.slice(0, 2)).toEqual([
    expect.objectContaining({ nodeId: 'first', executionId: expect.any(String), ok: true, exit: 0, executed: true, output: '', startedAt: expect.any(String), endedAt: expect.any(String), seconds: expect.any(Number) }),
    expect.objectContaining({ nodeId: 'second', executionId: expect.any(String), ok: true, exit: 0, executed: true, output: '', startedAt: expect.any(String), endedAt: expect.any(String), seconds: expect.any(Number) }),
  ]);
});

function expectNodeTimes(record: { startedAt?: string; endedAt?: string; seconds?: number } | undefined): void {
  expect(record?.startedAt).toBe(new Date(Date.parse(record!.startedAt!)).toISOString());
  expect(record?.endedAt).toBe(new Date(Date.parse(record!.endedAt!)).toISOString());
  expect(Date.parse(record!.startedAt!)).toBeLessThanOrEqual(Date.parse(record!.endedAt!));
  expect(record!.seconds).toBeGreaterThanOrEqual(0);
}

test('legacy dotted run identifiers keep their filename and reload on restart', async () => {
  const { graph, root } = fixture('exit 1');
  const failed = await runGraph(graph, { runId: 'legacy.run-1', deps: { root } });
  expect(failed.statePath).toBe(join(root, 'graph-runs', 'test-graph', 'legacy.run-1.json'));
  expect(latestGraphRun('test-graph', root)?.runId).toBe('legacy.run-1');
  expect(failed.status).toBe('failed');
  const resumed = await runGraph(graph, { resumeRunId: 'legacy.run-1', fromNodeId: 'first', deps: { root,
    runBash: async () => ({ stdout: '', stderr: '', exitCode: 0 }) } });
  expect(resumed.status).toBe('done');
  expect(resumed.statePath).toBe(failed.statePath);
  expect(resumed.resume?.from).toBe('first');
});

test('GRAPH-NODE-TIMES: each run node records start, end and seconds in the ledger, and no running node is left behind', async () => {
  const { graph, root } = fixture('sleep 0.2');
  const result = await runGraph(graph, { runId: 'timed', deps: { root } });
  const saved = JSON.parse(readFileSync(result.statePath, 'utf8'));
  for (const record of saved.nodes) expectNodeTimes(record);
  expect(saved.nodes[0].seconds).toBeGreaterThanOrEqual(0.15);
  expect(Date.parse(saved.nodes[0].endedAt)).toBeLessThanOrEqual(Date.parse(saved.nodes[1].startedAt));
  expect(saved.currentNode).toBeUndefined();
});

test('GRAPH-NODE-TIMES: the ledger names the running node and its start while it runs', async () => {
  const { graph, root } = fixture('exit 0');
  let seen: { currentNode?: { nodeId: string; executionId: string; startedAt: string }; nodes: unknown[] } | undefined;
  const result = await runGraph(graph, { runId: 'running', deps: { root, runBash: async () => {
    seen ??= JSON.parse(readFileSync(join(root, 'graph-runs', 'test-graph', 'running.json'), 'utf8'));
    return { stdout: '', stderr: '', exitCode: 0 };
  } } });
  expect(seen?.nodes).toEqual([]);
  expect(seen?.currentNode).toEqual({ nodeId: 'first', executionId: expect.any(String), startedAt: expect.any(String) });
  expect(result.nodes[0]?.startedAt).toBe(seen!.currentNode!.startedAt);
});

test('GRAPH-NODE-TIMES: a failed node records its times too', async () => {
  const { graph, root } = fixture('exit 1');
  const result = await runGraph(graph, { deps: { root } });
  expect(result.nodes[0]).toMatchObject({ ok: false, exit: 1 });
  expectNodeTimes(result.nodes[0]);
});

test('GRAPH-NODE-TIMES: a stopped node keeps its start and ends at the stop', async () => {
  const { graph, root } = fixture('exit 0');
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const ongoing = runGraph(graph, { runId: 'timed-stop', deps: { root, runBash: async () => {
    entered();
    await blocked;
    return { stdout: '', stderr: '', exitCode: 0 };
  } } });
  await started;
  let stopped;
  try { stopped = manageGraphRun('test-graph', 'timed-stop', 'stop', root, () => null); }
  finally { release(); }
  await expect(ongoing).rejects.toThrow('run was stopped or ownership changed');
  expect(stopped.nodes[0]).toMatchObject({ nodeId: 'first', error: 'stopped before node completed', endedAt: stopped.stoppedAt });
  expectNodeTimes(stopped.nodes[0]);
  expect(stopped.currentNode).toBeUndefined();
});

test('GRAPH-NODE-TIMES: stopping a run whose older runner never named the running node records only the stop as its end', async () => {
  const { root } = fixture('exit 0');
  const dir = join(root, 'graph-runs', 'test-graph');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'legacy-stop.json');
  writeFileSync(file, JSON.stringify({ graphId: 'test-graph', runId: 'legacy-stop', startedAt: '2026-10-06T00:00:00.000Z', status: 'running',
    pid: 999999, pidStartedAt: '2026-10-06T00:00:00.000Z', path: ['first'], nodes: [], executed: 0, dryRun: false, statePath: file }, null, 2));
  const stopped = manageGraphRun('test-graph', 'legacy-stop', 'stop', root, () => null);
  expect(stopped.nodes).toEqual([{ nodeId: 'first', ok: false, exit: null, executed: false, error: 'stopped before node completed', endedAt: stopped.stoppedAt }]);
});

test('GRAPH-NODE-TIMES: --from keeps earlier node times and writes new times for re-run nodes; an old ledger without times still resumes', async () => {
  const { graph, root } = fixture('printf original');
  let calls = 0;
  const deps = { root, runBash: async () => {
    calls++;
    return { stdout: 'x', stderr: '', exitCode: calls === 2 ? 1 : 0 };
  } };
  const first = await runGraph(graph, { runId: 'timed-restart', deps });
  expect(first.status).toBe('failed');
  const ledger = JSON.parse(readFileSync(first.statePath, 'utf8'));
  // An older ledger: the preserved node has no times at all.
  const legacyFirst = { ...ledger.nodes[0] };
  delete legacyFirst.startedAt; delete legacyFirst.endedAt; delete legacyFirst.seconds;
  writeFileSync(first.statePath, JSON.stringify({ ...ledger, nodes: [legacyFirst, ...ledger.nodes.slice(1)] }, null, 2));
  const resumed = await runGraph(graph, { resumeRunId: first.runId, fromNodeId: 'second', deps });
  expect(resumed.status).toBe('done');
  expect(resumed.nodes[0]).toEqual(legacyFirst);
  expectNodeTimes(resumed.nodes[1]);
  expect(Date.parse(resumed.nodes[1]!.startedAt!)).toBeGreaterThanOrEqual(Date.parse(ledger.nodes[1].endedAt));

  const timed = await runGraph(graph, { runId: 'timed-restart-2', deps: { root, runBash: async () => ({ stdout: '', stderr: '', exitCode: 1 }) } });
  expect(timed.status).toBe('failed');
  const again = await runGraph(graph, { resumeRunId: timed.runId, fromNodeId: 'first', deps: { root } });
  expectNodeTimes(again.nodes[0]);

  // A timed earlier node survives --from byte for byte.
  let third = 0;
  const thirdDeps = { root, runBash: async () => ({ stdout: '', stderr: '', exitCode: ++third === 2 ? 1 : 0 }) };
  const failedSecond = await runGraph(graph, { runId: 'timed-restart-3', deps: thirdDeps });
  expectNodeTimes(failedSecond.nodes[0]);
  const kept = await runGraph(graph, { resumeRunId: failedSecond.runId, fromNodeId: 'second', deps: thirdDeps });
  expect(kept.nodes[0]).toEqual(failedSecond.nodes[0]);
  expect(Date.parse(kept.nodes[1]!.startedAt!)).toBeGreaterThanOrEqual(Date.parse(failedSecond.nodes[1]!.endedAt!));
  expect(kept.resume?.at).toBeDefined();
  expectNodeTimes(kept.nodes[1]);
});

test('each cmd receives its own context file with input and previous stdout', async () => {
  const { graph, root } = fixture('printf first-output');
  writeFileSync(join(root, 'recipes.yaml'), `first:
  command: 'printf first-output'
second:
  command: 'printf "%s" "$ELANOUS_GRAPH_CONTEXT"'
`);
  const seen: Array<{ path: string; context: unknown }> = [];
  const result = await runGraph(graph, { runId: 'context-run', input: { request: 'hello' }, deps: {
    root,
    runBash: async (body, opts) => {
      const path = opts.env?.ELANOUS_GRAPH_CONTEXT;
      expect(path).toBeTruthy();
      seen.push({ path: path!, context: JSON.parse(readFileSync(path!, 'utf8')) });
      return { stdout: body.includes('first-output') ? 'first-output' : 'second-output', stderr: '', exitCode: 0 };
    },
  } });
  expect(seen).toHaveLength(2);
  expect(seen[0]?.path).not.toBe(seen[1]?.path);
  expect(seen[0]?.context).toEqual({ graphId: 'test-graph', runId: 'context-run', startedAt: result.startedAt, executionId: expect.any(String), nodeId: 'first', input: { request: 'hello' }, outputs: {} });
  expect(seen[1]?.context).toEqual({ graphId: 'test-graph', runId: 'context-run', startedAt: result.startedAt, executionId: expect.any(String), nodeId: 'second', input: { request: 'hello' }, outputs: { first: 'first-output' } });
  expect(result.input).toEqual({ request: 'hello' });
  expect(result.nodes.slice(0, 2).map((node) => node.output)).toEqual(['first-output', 'second-output']);
  expect(JSON.parse(readFileSync(result.statePath, 'utf8')).input).toEqual({ request: 'hello' });
});

test('prompt recipe executes through injected LLM with saved input and preceding structured output', async () => {
  const { graph, root } = fixture('printf first-output');
  writeFileSync(graph, readFileSync(graph, 'utf8').replace("kind: agent, recipe: 'cmd:second'", "kind: prompt, recipe: 'prompt:second'"));
  writeFileSync(join(root, 'recipes.yaml'), `first:\n  command: 'printf first-output'\nsecond:\n  prompt: 'Request $ARGUMENTS; prior $first.output.value; all $first.output'\n`);
  const seen: string[] = [];
  const state = await runGraph(graph, { input: { request: 'hello' }, deps: { root,
    runBash: async () => ({ stdout: '{"value":"saved"}\n', stderr: '', exitCode: 0 }),
    callLLM: async prompt => { seen.push(prompt); return 'LLM answer'; },
  } });
  expect(seen).toEqual(['Request {"request":"hello"}; prior saved; all {"value":"saved"}']);
  expect(state.status).toBe('done');
  expect(state.executed).toBe(2);
  expect(state.nodes[1]).toMatchObject({ nodeId: 'second', executed: true, ok: true, output: 'LLM answer' });
  expect(JSON.parse(readFileSync(state.statePath, 'utf8')).nodes[1].output).toBe('LLM answer');
});

test('successive prompt nodes resolve persisted input and the previous LLM output', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(graph, readFileSync(graph, 'utf8').replaceAll('kind: agent, recipe: \'cmd:', 'kind: prompt, recipe: \'prompt:'));
  writeFileSync(join(root, 'recipes.yaml'), `first:\n  prompt: 'Read $ARGUMENTS'\nsecond:\n  prompt: 'Answer $first.output.value for $ARGUMENTS'\n`);
  const prompts: string[] = [];
  const state = await runGraph(graph, { input: 'original', deps: { root,
    runBash: async () => { throw new Error('prompt must not run bash'); },
    callLLM: async body => {
      prompts.push(body);
      return prompts.length === 1 ? '{"value":"from-model"}' : 'finished';
    },
  } });
  expect(prompts).toEqual(['Read original', 'Answer from-model for original']);
  expect(state.status).toBe('done');
  expect(state.executed).toBe(2);
  expect(state.nodes.slice(0, 2).map(node => node.output)).toEqual(['{"value":"from-model"}', 'finished']);
  expect(JSON.parse(readFileSync(state.statePath, 'utf8')).input).toBe('original');
});

test('prompt output names an outcome and an injected LLM failure takes the fail edge', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(graph, readFileSync(graph, 'utf8')
    .replace("kind: agent, recipe: 'cmd:second'", "kind: prompt, recipe: 'prompt:second'")
    .replace('map: { ok: done, fail: failed }', 'map: { rejected: failed, ok: done, fail: failed }'));
  writeFileSync(join(root, 'recipes.yaml'), `first:\n  command: 'exit 0'\nsecond:\n  prompt: 'Decide $ARGUMENTS'\n`);
  const deps = { root, runBash: async () => ({ stdout: '', stderr: '', exitCode: 0 }), callLLM: async () => '{"outcome":"rejected"}' };
  const named = await runGraph(graph, { input: 'publish?', deps });
  expect(named.path).toEqual(['first', 'second', 'failed']);
  expect(named.nodes[1]).toMatchObject({ ok: true, output: '{"outcome":"rejected"}' });
  const failed = await runGraph(graph, { deps: { ...deps, callLLM: async () => { throw new Error('model unavailable'); } } });
  expect(failed.path).toEqual(['first', 'second', 'failed']);
  expect(failed.nodes[1]).toMatchObject({ ok: false, error: 'model unavailable' });
});

test('prompt after approval resolves saved input and prior outputs on resume', async () => {
  const { graph, root } = approvalFixture();
  writeFileSync(graph, readFileSync(graph, 'utf8').replace("kind: agent, recipe: 'cmd:b'", "kind: prompt, recipe: 'prompt:b'"));
  writeFileSync(join(root, 'recipes.yaml'), `a:\n  command: 'exit 0'\ngate:\n  approval: 'Publish now?'\nb:\n  prompt: 'Input $ARGUMENTS; first $a.output; decision $gate.output.outcome'\n`);
  const prompts: string[] = [];
  const deps = { root, runBash: async () => ({ stdout: 'previous', stderr: '', exitCode: 0 }),
    callLLM: async (prompt: string) => { prompts.push(prompt); return 'resumed'; } };
  const paused = await runGraph(graph, { input: 'original', deps });
  expect(paused.status).toBe('awaiting-approval');
  decideGraphApproval(paused.graphId, paused.runId, 'approved', 'owner', root);
  const resumed = await runGraph(graph, { resumeRunId: paused.runId, input: 'replacement', deps });
  expect(prompts).toEqual(['Input original; first previous; decision approved']);
  expect(resumed.status).toBe('done');
  expect(resumed.nodes.find(node => node.nodeId === 'b')?.output).toBe('resumed');
});

test('prompt dry run skips LLM and missing references fail without calling LLM', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(graph, readFileSync(graph, 'utf8').replace("kind: agent, recipe: 'cmd:second'", "kind: prompt, recipe: 'prompt:second'"));
  writeFileSync(join(root, 'recipes.yaml'), `first:\n  command: 'exit 0'\nsecond:\n  prompt: 'Missing $first.output.absent'\n`);
  const deps = { root, runBash: async () => ({ stdout: '{"value":"saved"}', stderr: '', exitCode: 0 }),
    callLLM: async () => { throw new Error('LLM must not run'); } };
  const dry = await runGraph(graph, { dryRun: true, deps });
  expect(dry.status).toBe('done');
  expect(dry.executed).toBe(0);
  const run = await runGraph(graph, { deps });
  expect(run.status).toBe('failed');
  expect(run.nodes[1]).toMatchObject({ ok: false, executed: true, error: 'missing prompt reference: $first.output.absent' });
});

test('prompt without an injected LLM fails the node instead of calling a real provider', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(graph, readFileSync(graph, 'utf8').replace("kind: agent, recipe: 'cmd:second'", "kind: prompt, recipe: 'prompt:second'"));
  writeFileSync(join(root, 'recipes.yaml'), `first:\n  command: 'exit 0'\nsecond:\n  prompt: 'Hello $ARGUMENTS'\n`);
  const run = await runGraph(graph, { input: 'x', deps: { root, runBash: async () => ({ stdout: '', stderr: '', exitCode: 0 }) } });
  expect(run.status).toBe('failed');
  expect(run.nodes[1]).toMatchObject({ ok: false, executed: true, error: 'prompt node requires an injected LLM (deps.callLLM)' });
});

test('real bash reads ELANOUS_GRAPH_CONTEXT and previous command output', async () => {
  const { graph, root } = fixture('printf first-output');
  writeFileSync(join(root, 'recipes.yaml'), `first:
  command: 'printf first-output'
second:
  command: 'cat "$ELANOUS_GRAPH_CONTEXT"'
`);
  const result = await runGraph(graph, { input: ['payload'], deps: { root } });
  expect(result.status).toBe('done');
  expect(JSON.parse(result.nodes[1]?.output as string)).toEqual({
    graphId: result.graphId, runId: result.runId, startedAt: result.startedAt, executionId: expect.any(String), nodeId: 'second', input: ['payload'], outputs: { first: 'first-output' },
  });
});

test('failed run restarts at saved node, keeps preceding output, and reports node progress', async () => {
  const { graph, root } = fixture('printf original');
  const calls: string[] = [];
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  const deps = { root, log: (event: string, data: Record<string, unknown>) => logs.push({ event, data }),
    runBash: async (body: string, opts: { env?: NodeJS.ProcessEnv }) => {
      calls.push(body);
      if (calls.length > 1) {
        expect(JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')).outputs.first).toBe('original');
        return { stdout: 'broken', stderr: '', exitCode: calls.length === 2 ? 1 : 0 };
      }
      return { stdout: 'original', stderr: '', exitCode: 0 };
    } };
  const first = await runGraph(graph, { runId: 'restart', deps });
  expect(first.status).toBe('failed');
  expect(first.path).toEqual(['first', 'second', 'failed']);
  const resumed = await runGraph(graph, { resumeRunId: first.runId, fromNodeId: 'second', deps });
  expect(resumed.status).toBe('done');
  expect(resumed.path).toEqual(['first', 'second', 'done']);
  expect(resumed.executed).toBe(2);
  expect(calls).toHaveLength(3);
  expect(resumed.nodes[0]).toEqual(first.nodes[0]);
  expect(resumed.resume).toMatchObject({ from: 'second', previousStatus: 'failed', at: expect.any(String) });
  expect(JSON.parse(readFileSync(first.statePath, 'utf8')).resume).toEqual(resumed.resume);
  expect(logs.filter((entry) => entry.event === 'node-start' && entry.data.nodeId === 'first')).toHaveLength(1);
});

test('budget-exceeded release resume requires a reason and records the reset execution counter', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-runner-budget-resume-'));
  dirs.push(root);
  const graph = join(root, 'graph.yaml');
  writeFileSync(join(root, 'recipes.yaml'), "cutoff:\n  command: 'bun scripts/release-loop/node-verdict.ts cutoff'\n");
  writeFileSync(graph, [
    'graph_id: release-loop', 'version: 1', 'entry_node: cutoff', 'terminal_nodes: [done, failed]', 'nodes:',
    "  - { node_id: cutoff, kind: agent, recipe: 'cmd:cutoff', max_visits: 1 }",
    '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }',
    '  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }', 'edges:',
    '  - { from: cutoff, on: outcome, map: { ok: done, fail: failed, error: failed } }', '',
  ].join('\n'));
  let calls = 0;
  const deps = { root, runBash: async () => ({ stdout: '', stderr: '', exitCode: ++calls === 1 ? 1 : 0 }) };
  const stopped = await runGraph(graph, { runId: 'budget-resume', deps });
  const saved = JSON.parse(readFileSync(stopped.statePath, 'utf8')) as Record<string, unknown>;
  saved.status = 'budget-exceeded';
  writeFileSync(stopped.statePath, JSON.stringify(saved));
  await expect(runGraph(graph, { resumeRunId: stopped.runId, fromNodeId: 'cutoff', deps }))
    .rejects.toThrow('use --resume-budget-exceeded --reason');
  const resumed = await runGraph(graph, { resumeRunId: stopped.runId, fromNodeId: 'cutoff',
    releaseBudgetExceededResume: { reason: 'resume after explicit budget review' }, deps });
  expect(resumed.status).toBe('done');
  expect(resumed.resume).toMatchObject({ previousStatus: 'budget-exceeded', budgetReset: {
    reason: 'resume after explicit budget review', priorExecuted: 1, resumedPrefixExecuted: 0, priorUnitCalls: 0, resumedPrefixUnitCalls: 0,
  } });
});

test('restart preserves a failed warning-only predecessor but refuses a branching failure', async () => {
  for (const advisory of [true, false]) {
    const { graph, root } = fixture('exit 1');
    const source = readFileSync(graph, 'utf8');
    writeFileSync(graph, source.replace('map: { ok: second, fail: failed }', advisory
      ? 'map: { ok: second, fail: second, error: second }'
      : 'map: { ok: done, fail: second, error: second }'));
    let secondRuns = 0;
    const deps = { root, runBash: async (body: string) => ({
      exitCode: body === 'exit 1' ? 1 : secondRuns++ === 0 ? 1 : 0,
      stdout: '', stderr: '',
    }) };
    const failed = await runGraph(graph, { deps });
    expect(failed.path).toEqual(['first', 'second', 'failed']);
    expect(failed.nodes[0]?.ok).toBe(false);
    if (!advisory) {
      await expect(runGraph(graph, { resumeRunId: failed.runId, fromNodeId: 'second', deps }))
        .rejects.toThrow('cannot preserve a failed predecessor');
      continue;
    }
    const resumed = await runGraph(graph, { resumeRunId: failed.runId, fromNodeId: 'second', deps });
    expect(resumed.status).toBe('done');
    expect(resumed.nodes[0]).toEqual(failed.nodes[0]);
    expect(secondRuns).toBe(2);
  }
});

test('restart refuses nodes outside the failed path or changed graph and leaves state intact', async () => {
  const { graph, root } = fixture('exit 1');
  const first = await runGraph(graph, { deps: { root } });
  const before = readFileSync(first.statePath, 'utf8');
  for (const fromNodeId of ['second', 'failed', 'absent']) {
    await expect(runGraph(graph, { resumeRunId: first.runId, fromNodeId, deps: { root } })).rejects.toThrow('--from node');
    expect(readFileSync(first.statePath, 'utf8')).toBe(before);
  }
  await expect(runGraph(graph, { fromNodeId: 'first', deps: { root } })).rejects.toThrow('--from requires --resume');
  writeFileSync(join(root, 'recipes.yaml'), readFileSync(join(root, 'recipes.yaml'), 'utf8').replace('exit 1', 'exit 0'));
  await expect(runGraph(graph, { resumeRunId: first.runId, fromNodeId: 'first', useCurrentGraph: true, deps: { root } })).rejects.toThrow('graph or recipes changed');
  expect(readFileSync(first.statePath, 'utf8')).toBe(before);
});

test('new runs preserve exact graph and recipe bytes and resume from that snapshot after installed files change', async () => {
  const { graph, root } = fixture('printf original');
  const originalGraph = readFileSync(graph, 'utf8');
  const recipes = join(root, 'recipes.yaml');
  const originalRecipes = readFileSync(recipes, 'utf8');
  const calls: string[] = [];
  const deps = { root, runBash: async (body: string) => {
    calls.push(body);
    return { stdout: body.includes('original') ? 'original' : '', stderr: '', exitCode: calls.length === 2 ? 1 : 0 };
  } };
  const first = await runGraph(graph, { deps });
  const snapshot = `${first.statePath}.graph`;
  expect(readFileSync(join(snapshot, 'graph.yaml'), 'utf8')).toBe(originalGraph);
  expect(readFileSync(join(snapshot, 'recipes.yaml'), 'utf8')).toBe(originalRecipes);
  expect(JSON.parse(readFileSync(first.statePath, 'utf8')).graphSnapshot).toEqual({
    graphSha: createHash('sha256').update(originalGraph).digest('hex'),
    recipesSha: createHash('sha256').update(originalRecipes).digest('hex'),
  });
  writeFileSync(graph, originalGraph.replace('graph_id: test-graph', 'graph_id: installed-graph'));
  writeFileSync(recipes, originalRecipes.replace('exit 0', 'exit 7'));
  await expect(runGraph(graph, { resumeRunId: first.runId, fromNodeId: 'second', useCurrentGraph: true, deps })).rejects.toThrow('graph or recipes changed since failed run');
  const resumed = await runGraph(graph, { resumeRunId: first.runId, fromNodeId: 'second', deps });
  expect(resumed.status).toBe('done');
  expect(resumed.resume?.graph).toBe('snapshot');
  expect(resumed.nodes[0]).toEqual(first.nodes[0]);
  expect(calls).toHaveLength(3);
});

test('tampered snapshot refuses resume before replaying any command', async () => {
  const { graph, root } = fixture('exit 1');
  const first = await runGraph(graph, { deps: { root } });
  const snapshot = join(`${first.statePath}.graph`, 'recipes.yaml');
  writeFileSync(snapshot, readFileSync(snapshot, 'utf8').replace('exit 1', 'exit 0'));
  const before = readFileSync(first.statePath, 'utf8');
  await expect(runGraph(graph, { resumeRunId: first.runId, fromNodeId: 'first', deps: { root } })).rejects.toThrow('graph snapshot changed since run started');
  expect(readFileSync(first.statePath, 'utf8')).toBe(before);
});

test('snapshot source hash mismatch refuses --from without truncating the saved failed path', async () => {
  const { graph, root } = fixture('exit 1');
  const first = await runGraph(graph, { deps: { root } });
  expect(first.path).toEqual(['first', 'failed']);
  const snapshot = join(`${first.statePath}.graph`, 'recipes.yaml');
  const changed = readFileSync(snapshot, 'utf8').replace('exit 1', 'exit 0');
  writeFileSync(snapshot, changed);
  const ledger = JSON.parse(readFileSync(first.statePath, 'utf8'));
  ledger.graphSnapshot.recipesSha = createHash('sha256').update(changed).digest('hex');
  writeFileSync(first.statePath, JSON.stringify(ledger));
  const before = readFileSync(first.statePath, 'utf8');
  await expect(runGraph(graph, { resumeRunId: first.runId, fromNodeId: 'first', deps: { root } }))
    .rejects.toThrow('graph snapshot changed since run started');
  expect(readFileSync(first.statePath, 'utf8')).toBe(before);
});

test('snapshot recipes still run current node scripts after repair', async () => {
  const { graph, root } = fixture('exit 0');
  const script = join(root, 'repair.sh');
  writeFileSync(script, 'exit 1\n');
  writeFileSync(join(root, 'recipes.yaml'), `first:\n  command: "exit 0"\nsecond:\n  command: "bash '${script}'"\n`);
  const first = await runGraph(graph, { deps: { root } });
  expect(first.status).toBe('failed');
  writeFileSync(script, 'exit 0\n');
  const resumed = await runGraph(graph, { resumeRunId: first.runId, fromNodeId: 'second', deps: { root } });
  expect(resumed.status).toBe('done');
  expect(resumed.nodes[0]).toEqual(first.nodes[0]);
});

test('a legacy run without snapshot uses current graph and the original hash guard', async () => {
  const { graph, root } = fixture('exit 1');
  const first = await runGraph(graph, { deps: { root } });
  const legacy = JSON.parse(readFileSync(first.statePath, 'utf8'));
  delete legacy.graphSnapshot;
  rmSync(`${first.statePath}.graph`, { recursive: true });
  writeFileSync(first.statePath, JSON.stringify(legacy));
  writeFileSync(graph, readFileSync(graph, 'utf8') + '\n');
  await expect(runGraph(graph, { resumeRunId: first.runId, fromNodeId: 'first', deps: { root } })).rejects.toThrow('graph or recipes changed since failed run');
  writeFileSync(graph, readFileSync(graph, 'utf8').slice(0, -1));
  const resumed = await runGraph(graph, { resumeRunId: first.runId, fromNodeId: 'first', deps: { root } });
  expect(resumed.resume?.graph).toBe('current');
});

test('failed publication cannot skip or replay approval with --from', async () => {
  const { graph, root } = approvalFixture();
  writeFileSync(graph, readFileSync(graph, 'utf8').replace('- { from: b, to: done }', '- { from: b, on: outcome, map: { ok: done, fail: failed } }'));
  let calls = 0;
  const deps = { root, runBash: async () => ({ stdout: '', stderr: '', exitCode: ++calls === 2 ? 1 : 0 }) };
  const pending = await runGraph(graph, { deps });
  await expect(runGraph(graph, { resumeRunId: pending.runId, fromNodeId: 'b', deps })).rejects.toThrow('failed, non-dry run');
  decideGraphApproval(pending.graphId, pending.runId, 'approved', 'reviewer', root);
  const failed = await runGraph(graph, { resumeRunId: pending.runId, deps });
  expect(failed.status).toBe('failed');
  const original = readFileSync(failed.statePath, 'utf8');
  await expect(runGraph(graph, { resumeRunId: failed.runId, fromNodeId: 'a', deps })).rejects.toThrow('across an approval');
  await expect(runGraph(graph, { resumeRunId: failed.runId, fromNodeId: 'gate', deps })).rejects.toThrow('across an approval');
  expect(readFileSync(failed.statePath, 'utf8')).toBe(original);
  const resumed = await runGraph(graph, { resumeRunId: failed.runId, fromNodeId: 'b', deps });
  expect(resumed.status).toBe('done');
  expect(resumed.nodes[1]).toMatchObject({ nodeId: 'gate', ok: true, decidedBy: 'reviewer' });
  expect(calls).toBe(3);
});

test('failed first command branches to failed without executing second', async () => {
  const { graph, root } = fixture('exit 1');
  const result = await runGraph(graph, { deps: { root } });
  expect(result.status).toBe('failed');
  expect(result.path).toEqual(['first', 'failed']);
  expect(result.nodes[0]).toMatchObject({ ok: false, exit: 1 });
  expect(result.executed).toBe(1);
});

test('real release-loop failed node writes one heal inbox line without running downstream commands', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-release-heal-'));
  dirs.push(root);
  const graph = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  let calls = 0;
  const result = await runGraph(graph, { deps: { root, runBash: async () => {
    calls++;
    return { stdout: '', stderr: 'release failed', exitCode: 1 };
  } } });
  expect(result.status).toBe('failed');
  expect(result.path).toEqual(['version-release', 'failed']);
  expect(result.nodes[0]).toMatchObject({ ok: false, exit: 1 });
  expect(result.executed).toBe(1);
  expect(calls).toBe(1);
  expect(JSON.parse(readFileSync(result.statePath, 'utf8')).status).toBe('failed');
  const lines = readFileSync(join(root, 'heal', 'inbox.jsonl'), 'utf8').trimEnd().split('\n');
  expect(lines).toHaveLength(1);
  expect(readFailureInbox({}, root)).toEqual([{
    source: 'release-run', kind: 'graph-run', ref: `${result.graphId}/${result.runId}`,
    summary: `Graph ${result.graphId}/${result.runId} failed at failed`, at: result.finishedAt!,
  }]);
});

test('failed heal-loop sends one OP alert and does not enqueue a recursive heal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-heal-loop-alert-'));
  dirs.push(root);
  const graph = join(root, 'heal-loop.yaml');
  writeFileSync(graph, ['graph_id: heal-loop', 'version: 1', 'entry_node: failed', 'terminal_nodes: [failed]', 'nodes:',
    '  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }', 'edges:', ''].join('\n'));
  writeFileSync(join(root, 'recipes.yaml'), '{}\n');
  const alerts: string[] = [];
  const result = await runGraph(graph, { runId: 'heal-loop-test-run', deps: { root, postOpAlert: (body) => alerts.push(body) } });
  expect(result.status).toBe('failed');
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toContain('heal-loop-test-run');
  expect(alerts[0]).toContain('Graph heal-loop/heal-loop-test-run failed at failed');
  expect(JSON.parse(readFileSync(result.statePath, 'utf8')).status).toBe('failed');
  expect(existsSync(join(root, 'heal', 'inbox.jsonl'))).toBe(false);
});

test('heal-loop no-edge failure remains persisted when its OP alert callback throws', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-heal-loop-no-edge-alert-'));
  dirs.push(root);
  const graph = join(root, 'heal-loop.yaml');
  writeFileSync(graph, ['graph_id: heal-loop', 'version: 1', 'entry_node: first', 'terminal_nodes: [done, failed]', 'nodes:',
    "  - { node_id: first, kind: agent, recipe: 'cmd:first', max_visits: 1 }",
    '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }',
    '  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }', 'edges:', ''].join('\n'));
  writeFileSync(join(root, 'recipes.yaml'), 'first:\n  command: "fake first command"\n');
  let alerts = 0;
  const result = await runGraph(graph, { runId: 'heal-loop-no-edge-run', deps: { root,
    runBash: async () => ({ stdout: '{"outcome":"ok"}', stderr: '', exitCode: 0 }),
    postOpAlert: () => { alerts++; throw new Error('mailbox unavailable'); },
  } });
  expect(result.status).toBe('failed');
  expect(JSON.parse(readFileSync(result.statePath, 'utf8')).status).toBe('failed');
  expect(alerts).toBe(1);
  expect(existsSync(join(root, 'heal', 'inbox.jsonl'))).toBe(false);
});

test('release-loop with no outgoing edge records the failed run exactly once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-release-no-edge-'));
  dirs.push(root);
  const graph = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const source = readFileSync(graph, 'utf8').replace('ok: traffic-cut-start, fail: failed, error: failed', 'fail: failed, error: failed');
  const local = join(root, 'release-loop.yaml');
  writeFileSync(local, source);
  writeFileSync(join(root, 'recipes.yaml'), readFileSync(join(import.meta.dir, '../../graphs/release/recipes.yaml'), 'utf8'));
  const run = await runGraph(local, { deps: { root, runBash: async () => ({ stdout: '{"outcome":"ok"}', stderr: '', exitCode: 0 }) } });
  expect(run.status).toBe('failed');
  expect(run.path).toEqual(['version-release']);
  expect(readFailureInbox({}, root)).toEqual([{
    source: 'release-run', kind: 'graph-run', ref: `${run.graphId}/${run.runId}`,
    summary: `Graph ${run.graphId}/${run.runId} failed after version-release (no outgoing edge)`, at: run.finishedAt!,
  }]);
  expect(readFileSync(join(root, 'heal', 'inbox.jsonl'), 'utf8').trimEnd().split('\n')).toHaveLength(1);
});

test('a broken heal inbox does not replace either persisted release failure verdict and exposes a replay path', async () => {
  for (const branch of ['terminal', 'no-edge']) {
    const root = mkdtempSync(join(tmpdir(), 'graph-release-heal-broken-'));
    dirs.push(root);
    const graph = join(root, 'release-loop.yaml');
    const source = readFileSync(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), 'utf8');
    writeFileSync(graph, branch === 'no-edge' ? source.replace('ok: traffic-cut-start, fail: failed, error: failed', 'fail: failed, error: failed') : source);
    writeFileSync(join(root, 'recipes.yaml'), readFileSync(join(import.meta.dir, '../../graphs/release/recipes.yaml'), 'utf8'));
    mkdirSync(join(root, 'heal'));
    writeFileSync(join(root, 'heal', 'inbox.jsonl'), '{invalid-json}\n');
    const result = await runGraph(graph, { runId: `broken-${branch}`, deps: { root, runBash: async () => ({
      stdout: branch === 'terminal' ? '{"outcome":"fail"}' : '{"outcome":"ok"}', stderr: '', exitCode: branch === 'terminal' ? 1 : 0,
    }) } });
    expect(result.status).toBe('failed');
    expect(JSON.parse(readFileSync(result.statePath, 'utf8')).status).toBe('failed');
    expect(readFileSync(join(root, 'heal', 'inbox.jsonl'), 'utf8')).toBe('{invalid-json}\n');
    expect(debug.events(500).filter(entry => entry.category === 'heal.intake' && entry.event === 'record-failed' &&
      (entry.data as { ref?: string })?.ref === `${result.graphId}/${result.runId}`)).toMatchObject([
      { level: 'error', data: { source: 'release-run', kind: 'graph-run', ref: `${result.graphId}/${result.runId}`,
        statePath: result.statePath, error: expect.stringContaining('SyntaxError') } },
    ]);
    writeFileSync(join(root, 'heal', 'inbox.jsonl'), '');
    expect(recordFailureEvent({ source: 'release-run', kind: 'graph-run', ref: `${result.graphId}/${result.runId}`,
      summary: `Graph ${result.graphId}/${result.runId} failed`, at: result.finishedAt! }, root)).toEqual({ folded: false });
    expect(readFailureInbox({}, root)).toHaveLength(1);
  }
});

test('missing outcome mapping uses fallback without executing the second command', async () => {
  const { graph, root } = fixture('exit 1');
  writeFileSync(graph, readFileSync(graph, 'utf8').replace('map: { ok: second, fail: failed }', 'map: { ok: second }\n    fallback:\n      - { node: failed, requires: [] }'));
  const result = await runGraph(graph, { deps: { root } });
  expect(result.status).toBe('failed');
  expect(result.path).toEqual(['first', 'failed']);
  expect(result.executed).toBe(1);
  expect(existsSync(join(root, 'heal', 'inbox.jsonl'))).toBe(false);
});

test('a revisit beyond max_visits is blocked before running again', async () => {
  const { graph, root } = fixture('exit 0', true);
  const result = await runGraph(graph, { deps: { root } });
  expect(result.status).toBe('budget-exceeded');
  expect(result.path).toEqual(['first']);
  expect(result.executed).toBe(1);
  expect(JSON.parse(readFileSync(result.statePath, 'utf8')).status).toBe('budget-exceeded');
});

test('unregistered inherited recipe is rejected before any command executes', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(graph, readFileSync(graph, 'utf8').replace('cmd:second', 'cmd:toString'));
  let executed = 0;
  await expect(runGraph(graph, { deps: { root, runBash: async () => {
    executed++;
    return { stdout: '', stderr: '', exitCode: 0 };
  } } })).rejects.toThrow('unknown command recipe for second: cmd:toString');
  expect(executed).toBe(0);
});

test('unsupported terminal name cannot silently report a failed branch as done', async () => {
  const { graph, root } = fixture('exit 1');
  writeFileSync(graph, readFileSync(graph, 'utf8')
    .replace('terminal_nodes: [done, failed]', 'terminal_nodes: [done, rejected]')
    .replace('node_id: failed', 'node_id: rejected')
    .replaceAll('fail: failed', 'fail: rejected'));
  let executed = 0;
  await expect(runGraph(graph, { deps: { root, runBash: async () => {
    executed++;
    return { stdout: '', stderr: '', exitCode: 1 };
  } } })).rejects.toThrow('unsupported terminal node: rejected');
  expect(executed).toBe(0);
});

test('loop named terminals preserve success and failure status', async () => {
  const cases: Array<{ graphId: string; terminal: string; command: string; status: 'done' | 'failed' }> = [
    { graphId: 'default-loop', terminal: 'landed', command: 'exit 0', status: 'done' },
    { graphId: 'default-loop', terminal: 'stopped', command: 'exit 1', status: 'failed' },
    { graphId: 'document-loop', terminal: 'landed', command: 'exit 0', status: 'done' },
    { graphId: 'document-loop', terminal: 'document-blocked', command: 'exit 1', status: 'failed' },
    { graphId: 'document-loop', terminal: 'needs-human', command: 'exit 1', status: 'failed' },
    { graphId: 'operate-loop', terminal: 'landed', command: 'exit 0', status: 'done' },
    { graphId: 'operate-loop', terminal: 'operate-blocked', command: 'exit 1', status: 'failed' },
    { graphId: 'operate-loop', terminal: 'needs-human', command: 'exit 1', status: 'failed' },
    { graphId: 'research-loop', terminal: 'landed', command: 'exit 0', status: 'done' },
    { graphId: 'research-loop', terminal: 'needs-human', command: 'exit 1', status: 'failed' },
  ];
  // Keep the executable mapping tied to the checked-in loop declarations.
  for (const graphId of ['default-loop', 'document-loop', 'operate-loop', 'research-loop']) {
    const declared = parseYaml(readFileSync(join(import.meta.dir, `../../graphs/${graphId}.yaml`), 'utf8')).terminal_nodes as string[];
    const covered = cases.filter(item => item.graphId === graphId).map(item => item.terminal);
    expect(new Set(covered)).toEqual(new Set(declared));
  }
  for (const { graphId, terminal, command, status } of cases) {
    const { graph, root } = fixture(command);
    writeFileSync(graph, readFileSync(graph, 'utf8')
      .replace('graph_id: test-graph', `graph_id: ${graphId}`)
      .replace('terminal_nodes: [done, failed]', `terminal_nodes: [${terminal}]`)
      .replaceAll(status === 'done' ? 'done' : 'failed', terminal));
    const result = await runGraph(graph, { deps: { root, runBash: async (body: string) => ({
      stdout: '', stderr: '', exitCode: body === 'exit 1' ? 1 : 0,
    }) } });
    expect(result.status).toBe(status);
    expect(result.reason).toBe(terminal);
    expect(result.path.at(-1)).toBe(terminal);
    expect(JSON.parse(readFileSync(result.statePath, 'utf8')).reason).toBe(terminal);
  }
});

test('checked-in research loop reaches landed in runner plan and failure parks at needs-human', async () => {
  const shippedPath = join(import.meta.dir, '../../graphs/research-loop.yaml');
  const shipped = parseYaml(readFileSync(shippedPath, 'utf8')) as Record<string, unknown>;
  const root = mkdtempSync(join(tmpdir(), 'research-loop-runner-fixture-'));
  dirs.push(root);
  const graph = join(root, 'research-loop.yaml');
  writeFileSync(graph, '{}\n');
  writeFileSync(join(root, 'recipes.yaml'), 'fixture-work:\n  command: "fixture-work"\n');

  // The checked-in graph is passed unchanged through the production planner for the normal route.
  const planned = await runGraph(shippedPath, { dryRun: true, deps: { root } });
  expect(planned).toMatchObject({ status: 'done', reason: 'landed' });
  expect(planned.path.at(-1)).toBe('landed');
  expect(planned.executed).toBe(0);

  // Keep the shipped identity and terminal contract while narrowing execution to a deterministic branch fixture.
  const fixtureGraph = {
    graph_id: shipped.graph_id,
    version: shipped.version,
    entry_node: 'fixture-work',
    terminal_nodes: shipped.terminal_nodes,
    nodes: [
      { node_id: 'fixture-work', kind: 'agent', recipe: 'cmd:fixture-work', max_visits: 1 },
      { node_id: 'after-work', kind: 'agent', recipe: 'cmd:fixture-work', max_visits: 1 },
      { node_id: 'landed', kind: 'gate', recipe: 'none', max_visits: 1 },
      { node_id: 'needs-human', kind: 'gate', recipe: 'none', max_visits: 1 },
    ],
    edges: [
      { from: 'fixture-work', on: 'outcome', map: { ok: 'after-work', fail: 'needs-human' } },
      { from: 'after-work', to: 'landed' },
    ],
  };
  const run = async (exitCode: 0 | 1) => {
    const commands: string[] = [];
    const result = await runGraph(graph, { graphSource: JSON.stringify(fixtureGraph), deps: {
      root,
      runBash: async (body: string) => {
        commands.push(body);
        return { stdout: '', stderr: '', exitCode };
      },
    } });
    return { result, commands };
  };

  const success = await run(0);
  expect(success.result).toMatchObject({ status: 'done', reason: 'landed', path: ['fixture-work', 'after-work', 'landed'] });
  expect(success.commands).toHaveLength(2);

  const failure = await run(1);
  expect(failure.result).toMatchObject({ status: 'failed', reason: 'needs-human', path: ['fixture-work', 'needs-human'] });
  expect(failure.commands).toHaveLength(1);
});

test('loop graph still rejects undeclared terminal names before running', async () => {
  for (const graphId of ['default-loop', 'document-loop', 'operate-loop', 'research-loop']) {
    for (const terminal of ['done', 'failed', 'blocked', 'rejected']) {
      const { graph, root } = fixture('exit 0');
      writeFileSync(graph, `graph_id: ${graphId}\nversion: 1\nentry_node: first\nterminal_nodes: [${terminal}]\nnodes:\n  - { node_id: first, kind: agent, recipe: 'cmd:first', max_visits: 1 }\n  - { node_id: ${terminal}, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - { from: first, to: ${terminal} }\n`);
      let executed = 0;
      await expect(runGraph(graph, { deps: { root, runBash: async () => {
        executed++;
        return { stdout: '', stderr: '', exitCode: 0 };
      } } })).rejects.toThrow(`unsupported terminal node: ${terminal}`);
      expect(executed).toBe(0);
    }
  }
});

test('harness loop template without recipes sidecar is planned by dry run and refused for a real run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-runner-loop-plan-'));
  dirs.push(root);
  const graph = join(root, 'research-loop.yaml');
  // No recipes.yaml beside it: the recipes are harness labels, and `changed-files` has no runner condition.
  writeFileSync(graph, `graph_id: research-loop\nversion: 1\nentry_node: work\nterminal_nodes: [landed, needs-human]\nnodes:\n  - { node_id: work, kind: agent, recipe: headless-goal-loop, max_visits: 1 }\n  - { node_id: gate, kind: gate, recipe: gate-baseline, max_visits: 1 }\n  - { node_id: merge, kind: git, recipe: seams-gh-merge-squash, max_visits: 1 }\n  - { node_id: landed, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: needs-human, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - { from: work, on: changed-files, map: { code-changed: gate, documents-only: merge } }\n  - { from: gate, on: outcome, map: { pass: merge, fail: needs-human } }\n  - { from: merge, on: outcome, map: { ok: needs-human, merged: landed, fail: needs-human } }\n`);
  let executed = 0;
  const runBash = async () => { executed++; return { stdout: '', stderr: '', exitCode: 0 }; };
  await expect(runGraph(graph, { deps: { root, runBash } })).rejects.toThrow('graph run only plans it with --dry-run');
  const planned = await runGraph(graph, { dryRun: true, deps: { root, runBash } });
  expect(planned.status).toBe('done');
  expect(planned.reason).toBe('landed');
  expect(planned.path).toEqual(['work', 'merge', 'landed']);
  expect(planned.executed).toBe(0);
  expect(executed).toBe(0);
  expect(planned.nodes.map(node => node.output === undefined ? undefined : JSON.parse(String(node.output)).outcome)).toEqual(['documents-only', 'merged', undefined]);
  // A loop whose declared edges never reach a success terminal fails before walking.
  writeFileSync(graph, readFileSync(graph, 'utf8').replace('merged: landed', 'merged: needs-human'));
  await expect(runGraph(graph, { dryRun: true, deps: { root, runBash } })).rejects.toThrow('has no declared route from work to a success terminal');
  expect(executed).toBe(0);
});

test('ops recipes register a human-readable publication approval', () => {
  const recipes = parseYaml(readFileSync(join(import.meta.dir, '../../graphs/ops/recipes.yaml'), 'utf8'));
  expect(recipes['publish-approval']).toEqual({ approval: '공개 발행을 승인하시겠습니까?' });
});

test('approval pauses without running b; undecided resume stays pending; decision resumes without replaying a', async () => {
  const { graph, root } = approvalFixture();
  const calls: string[] = [];
  const events: string[] = [];
  const deps = { root, runBash: async (body: string) => { calls.push(body); return { stdout: '', stderr: '', exitCode: 0 }; },
    log: (event: string) => { events.push(event); } };
  const first = await runGraph(graph, { runId: 'approved-run', deps });
  expect(first.status).toBe('awaiting-approval');
  expect(first.pending).toMatchObject({ nodeId: 'gate', message: 'Publish now?' });
  expect(first.pending?.since).toBeTruthy();
  expect(first.path).toEqual(['a', 'gate']);
  expect(first.executed).toBe(1);
  expect(calls).toEqual(['exit 0']);
  expect(events).toContain('approval-pending');
  const undecided = await runGraph(graph, { resumeRunId: first.runId, deps });
  expect(undecided.status).toBe('awaiting-approval');
  expect(undecided.path).toEqual(['a', 'gate']);
  expect(undecided.pending?.since).toBe(first.pending?.since);
  expect(calls).toHaveLength(1);
  decideGraphApproval(first.graphId, first.runId, 'approved', 'reviewer', root);
  const resumed = await runGraph(graph, { resumeRunId: first.runId, deps });
  expect(resumed.status).toBe('done');
  expect(resumed.path).toEqual(['a', 'gate', 'b', 'done']);
  expect(resumed.nodes[1]).toMatchObject({ nodeId: 'gate', ok: true, decidedBy: 'reviewer' });
  expect(resumed.nodes[1]?.decidedAt).toBeTruthy();
  expect(resumed.executed).toBe(2);
  expect(calls).toHaveLength(2);
  expect(JSON.parse(readFileSync(resumed.statePath, 'utf8')).status).toBe('done');
  expect(() => decideGraphApproval(first.graphId, first.runId, 'approved', 'reviewer', root)).toThrow('not awaiting');
});

test('resume keeps persisted input and exposes pre-approval outputs to the next cmd', async () => {
  const { graph, root } = approvalFixture();
  const contexts: Array<{ graphId: string; runId: string; startedAt: string; executionId: string; nodeId: string; input: unknown; outputs: Record<string, unknown> }> = [];
  const deps = { root, runBash: async (_body: string, opts: { env?: NodeJS.ProcessEnv }) => {
    contexts.push(JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')));
    return { stdout: `output-${contexts.length}`, stderr: '', exitCode: 0 };
  } };
  const first = await runGraph(graph, { runId: 'resume-context', input: { original: true }, deps });
  expect(first.status).toBe('awaiting-approval');
  expect(JSON.parse(readFileSync(first.statePath, 'utf8')).input).toEqual({ original: true });
  decideGraphApproval(first.graphId, first.runId, 'approved', 'reviewer', root);
  const resumed = await runGraph(graph, { resumeRunId: first.runId, input: { original: false }, deps });
  expect(resumed.input).toEqual({ original: true });
  expect(contexts).toEqual([
    { graphId: first.graphId, runId: first.runId, startedAt: first.startedAt!, executionId: expect.any(String), nodeId: 'a', input: { original: true }, outputs: {} },
    { graphId: first.graphId, runId: first.runId, startedAt: first.startedAt!, executionId: expect.any(String), nodeId: 'b', input: { original: true }, outputs: { a: 'output-1', gate: expect.objectContaining({ outcome: 'approved', decidedBy: 'reviewer' }) } },
  ]);
  expect(JSON.parse(readFileSync(resumed.statePath, 'utf8')).input).toEqual({ original: true });
});

test('rejected approval routes to failed, and approval cannot be decided twice', async () => {
  const { graph, root } = approvalFixture();
  const calls: string[] = [];
  const deps = { root, runBash: async (body: string) => { calls.push(body); return { stdout: '', stderr: '', exitCode: 0 }; } };
  const first = await runGraph(graph, { deps });
  decideGraphApproval(first.graphId, first.runId, 'rejected', 'owner', root);
  expect(() => decideGraphApproval(first.graphId, first.runId, 'approved', 'owner', root)).toThrow('not awaiting an undecided approval');
  const result = await runGraph(graph, { resumeRunId: first.runId, deps });
  expect(result.status).toBe('failed');
  expect(result.path).toEqual(['a', 'gate', 'failed']);
  expect(result.nodes[1]).toMatchObject({ nodeId: 'gate', ok: false, decidedBy: 'owner' });
  expect(result.executed).toBe(1);
  expect(calls).toHaveLength(1);
});

test('decision claim remains authoritative when a stale undecided state is persisted', async () => {
  const { graph, root } = approvalFixture();
  const deps = { root, runBash: async () => ({ stdout: '', stderr: '', exitCode: 0 }) };
  const first = await runGraph(graph, { deps });
  const stale = readFileSync(first.statePath, 'utf8');
  const decided = decideGraphApproval(first.graphId, first.runId, 'approved', 'operator', root);
  expect(decided.pending?.decision).toBe('approved');
  writeFileSync(first.statePath, stale);
  expect(() => decideGraphApproval(first.graphId, first.runId, 'rejected', 'late', root)).toThrow('not awaiting an undecided approval');
  const resumed = await runGraph(graph, { resumeRunId: first.runId, deps });
  expect(resumed.status).toBe('done');
  expect(resumed.nodes[1]).toMatchObject({ ok: true, decidedBy: 'operator' });
});

test('a reused run id cannot overwrite a paused or decided run or inherit its decision', async () => {
  const { graph, root } = approvalFixture();
  const calls: string[] = [];
  const deps = { root, runBash: async (body: string) => { calls.push(body); return { stdout: '', stderr: '', exitCode: 0 }; } };
  const first = await runGraph(graph, { runId: 'fixed-id', deps });
  const original = readFileSync(first.statePath, 'utf8');
  await expect(runGraph(graph, { runId: first.runId, deps })).rejects.toThrow('run id already exists');
  expect(readFileSync(first.statePath, 'utf8')).toBe(original);
  decideGraphApproval(first.graphId, first.runId, 'approved', 'owner', root);
  await expect(runGraph(graph, { runId: first.runId, deps })).rejects.toThrow('run id already exists');
  expect(calls).toHaveLength(1);
  const result = await runGraph(graph, { resumeRunId: first.runId, deps });
  expect(result.status).toBe('done');
  expect(calls).toHaveLength(2);
  await expect(runGraph(graph, { runId: first.runId, deps })).rejects.toThrow('run id already exists');
  unlinkSync(first.statePath);
  await expect(runGraph(graph, { runId: first.runId, deps })).rejects.toThrow('run id already exists');
  expect(calls).toHaveLength(2);
});

test('concurrent resumes cannot run a downstream command twice', async () => {
  const { graph, root } = approvalFixture();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[] = [];
  const deps = { root, runBash: async (body: string) => {
    calls.push(body);
    if (calls.length === 2) { entered(); await held; }
    return { stdout: '', stderr: '', exitCode: 0 };
  } };
  const first = await runGraph(graph, { deps });
  decideGraphApproval(first.graphId, first.runId, 'approved', 'owner', root);
  const ongoing = runGraph(graph, { resumeRunId: first.runId, deps });
  await started;
  try {
    await expect(runGraph(graph, { resumeRunId: first.runId, deps })).rejects.toThrow('run is already being resumed');
    expect(calls).toHaveLength(2);
  } finally { release(); }
  expect((await ongoing).status).toBe('done');
  expect(calls).toHaveLength(2);
  await expect(runGraph(graph, { resumeRunId: first.runId, deps })).rejects.toThrow('run is not awaiting approval');
});

test('approval dry run follows success path without executing commands or waiting', async () => {
  const { graph, root } = approvalFixture();
  const result = await runGraph(graph, { dryRun: true, deps: { root, runBash: async () => { throw new Error('executed'); } } });
  expect(result.status).toBe('done');
  expect(result.pending).toBeUndefined();
  expect(result.path).toEqual(['a', 'gate', 'b', 'done']);
  expect(result.executed).toBe(0);
});

test('approval recipe must exist in its own registry slot before running a command', async () => {
  const { graph, root } = approvalFixture();
  writeFileSync(graph, readFileSync(graph, 'utf8').replace('approval:gate', 'approval:toString'));
  let calls = 0;
  await expect(runGraph(graph, { deps: { root, runBash: async () => { calls++; return { stdout: '', stderr: '', exitCode: 0 }; } } }))
    .rejects.toThrow('unknown command recipe for gate: approval:toString');
  expect(calls).toBe(0);
  writeFileSync(graph, readFileSync(graph, 'utf8').replace('approval:toString', 'approval:a'));
  await expect(runGraph(graph, { deps: { root, runBash: async () => { calls++; return { stdout: '', stderr: '', exitCode: 0 }; } } }))
    .rejects.toThrow('unknown command recipe for gate: approval:a');
  expect(calls).toBe(0);
});

test('resuming against a changed approval message refuses to apply an old decision', async () => {
  const { graph, root } = approvalFixture();
  const first = await runGraph(graph, { deps: { root, runBash: async () => ({ stdout: '', stderr: '', exitCode: 0 }) } });
  decideGraphApproval(first.graphId, first.runId, 'approved', 'owner', root);
  writeFileSync(join(root, 'recipes.yaml'), readFileSync(join(root, 'recipes.yaml'), 'utf8').replace('Publish now?', 'Publish something else?'));
  await expect(runGraph(graph, { resumeRunId: first.runId, useCurrentGraph: true, deps: { root } })).rejects.toThrow('approval source changed since run was paused');
  expect(JSON.parse(readFileSync(first.statePath, 'utf8')).status).toBe('awaiting-approval');
});

test('snapshot resume keeps the original approval decision bound after installed recipes change', async () => {
  const { graph, root } = approvalFixture();
  const deps = { root, runBash: async () => ({ stdout: '', stderr: '', exitCode: 0 }) };
  const first = await runGraph(graph, { deps });
  decideGraphApproval(first.graphId, first.runId, 'approved', 'owner', root);
  const recipes = join(root, 'recipes.yaml');
  writeFileSync(recipes, readFileSync(recipes, 'utf8').replace('Publish now?', 'Changed message?'));
  const resumed = await runGraph(graph, { resumeRunId: first.runId, deps });
  expect(resumed.status).toBe('done');
  expect(resumed.resume?.graph).toBe('snapshot');
  expect(resumed.nodes[1]).toMatchObject({ nodeId: 'gate', ok: true, decidedBy: 'owner' });
});

test('old approval cannot authorize a changed downstream command or branch with the same graph id and prompt', async () => {
  for (const mutation of ['command', 'branch']) {
    const { graph, root } = approvalFixture();
    const calls: string[] = [];
    const deps = { root, runBash: async (body: string) => { calls.push(body); return { stdout: '', stderr: '', exitCode: 0 }; } };
    const first = await runGraph(graph, { deps });
    expect(first.approvalSourceHash).toMatch(/^[a-f0-9]{64}$/);
    decideGraphApproval(first.graphId, first.runId, 'approved', 'owner', root);
    const file = mutation === 'command' ? join(root, 'recipes.yaml') : graph;
    const before = readFileSync(file, 'utf8');
    writeFileSync(file, mutation === 'command'
      ? before.replace('b:\n  command: "exit 0"', 'b:\n  command: "exit 1"')
      : before.replace('map: { ok: b, fail: failed }', 'map: { ok: failed, fail: b }'));
    await expect(runGraph(graph, { resumeRunId: first.runId, useCurrentGraph: true, deps })).rejects.toThrow('approval source changed since run was paused');
    expect(calls).toEqual(['exit 0']);
    expect(JSON.parse(readFileSync(first.statePath, 'utf8'))).toMatchObject({ status: 'awaiting-approval', pending: { nodeId: 'gate' } });
    expect(() => decideGraphApproval(first.graphId, first.runId, 'rejected', 'late', root)).toThrow('not awaiting an undecided approval');
  }
});

test('visit budget persists over resumed approval and blocks a second traversal', async () => {
  const { graph, root } = approvalFixture();
  writeFileSync(graph, readFileSync(graph, 'utf8').replace('from: b, to: done', 'from: b, to: a'));
  const calls: string[] = [];
  const deps = { root, runBash: async (body: string) => { calls.push(body); return { stdout: '', stderr: '', exitCode: 0 }; } };
  const first = await runGraph(graph, { deps });
  decideGraphApproval(first.graphId, first.runId, 'approved', 'owner', root);
  const resumed = await runGraph(graph, { resumeRunId: first.runId, deps });
  expect(resumed.status).toBe('budget-exceeded');
  expect(resumed.path).toEqual(['a', 'gate', 'b']);
  expect(calls).toHaveLength(2);
});

test('dry run assumes ok and never invokes the injected command executor', async () => {
  const { graph, root } = fixture('exit 1');
  const result = await runGraph(graph, { dryRun: true, deps: { root, runBash: async () => { throw new Error('executed'); } } });
  expect(result.status).toBe('done');
  expect(result.path).toEqual(['first', 'second', 'done']);
  expect(result.executed).toBe(0);
});

// R1 의 빠진 칸(🅣 2026-09-26): 노드 산출의 마지막 JSON 줄 `outcome` 이 간선 map 의 키면 그 갈래로 간다 · 다음 노드는 구조 산출을 받는다.
function namedOutcomeFixture(): { graph: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'graph-named-outcome-'));
  const graph = join(root, 'g.yaml');
  writeFileSync(join(root, 'recipes.yaml'), [
    `classify:\n  command: "bun -e \\"const c=JSON.parse(require('fs').readFileSync(process.env.ELANOUS_GRAPH_CONTEXT,'utf8')); console.log('thinking'); console.log(JSON.stringify({outcome:c.input.kind, seen:c.input.kind}))\\""`,
    `a:\n  command: "echo a"`,
    `b:\n  command: "bun -e \\"const c=JSON.parse(require('fs').readFileSync(process.env.ELANOUS_GRAPH_CONTEXT,'utf8')); console.log(JSON.stringify({got:c.outputs.classify.seen}))\\""`,
  ].join('\n') + '\n');
  writeFileSync(graph, `graph_id: named-outcome\nversion: 1\nentry_node: classify\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: classify, kind: judge, recipe: 'cmd:classify', max_visits: 1 }\n  - { node_id: a, kind: agent, recipe: 'cmd:a', max_visits: 1 }\n  - { node_id: b, kind: agent, recipe: 'cmd:b', max_visits: 1 }\n  - { node_id: done, kind: gate, max_visits: 1 }\n  - { node_id: failed, kind: gate, max_visits: 1 }\nedges:\n  - from: classify\n    on: outcome\n    map: { alpha: a, beta: b, ok: a, fail: failed }\n  - from: a\n    on: outcome\n    map: { ok: done, fail: failed }\n  - from: b\n    on: outcome\n    map: { ok: done, fail: failed }\n`);
  return { graph, root };
}

test('a catalog role with a sibling recipes.yaml command runs like cmd', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-role-recipe-'));
  dirs.push(root);
  const graph = join(root, 'graph.yaml');
  writeFileSync(join(root, 'recipes.yaml'), 'triage:\n  command: "printf \'{\\"outcome\\":\\"exhausted\\"}\'"\n');
  writeFileSync(graph, `graph_id: role-graph
version: 1
entry_node: judge
terminal_nodes: [done, failed]
nodes:
  - { node_id: judge, kind: judge, recipe: triage, max_visits: 1 }
  - { node_id: done, kind: gate, max_visits: 1 }
  - { node_id: failed, kind: gate, max_visits: 1 }
edges:
  - from: judge
    on: outcome
    map: { exhausted: failed, ok: done, fail: failed }
`);
  const result = await runGraph(graph, { deps: { root }, runId: 'role-ok' });
  expect(result.path).toEqual(['judge', 'failed']);
  expect(result.executed).toBe(1);
  expect(result.status).toBe('failed');
});

test('a bare recipe is rejected before execution when it is not a catalog role or has no command', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-role-reject-'));
  dirs.push(root);
  const graph = join(root, 'graph.yaml');
  writeFileSync(join(root, 'recipes.yaml'), 'not-a-role:\n  command: "exit 0"\ntriage:\n  approval: "not a command"\n');
  writeFileSync(graph, `graph_id: role-reject
version: 1
entry_node: n
terminal_nodes: [done, failed]
nodes:
  - { node_id: n, kind: judge, recipe: not-a-role, max_visits: 1 }
  - { node_id: done, kind: gate, max_visits: 1 }
  - { node_id: failed, kind: gate, max_visits: 1 }
edges:
  - from: n
    on: outcome
    map: { ok: done, fail: failed }
`);
  let executed = 0;
  await expect(runGraph(graph, { deps: { root, runBash: async () => { executed++; return { stdout: '', stderr: '', exitCode: 0 }; } } }))
    .rejects.toThrow('unknown command recipe for n: not-a-role');
  expect(executed).toBe(0);
  writeFileSync(graph, readFileSync(graph, 'utf8').replace('recipe: not-a-role', 'recipe: triage'));
  await expect(runGraph(graph, { deps: { root, runBash: async () => { executed++; return { stdout: '', stderr: '', exitCode: 0 }; } } }))
    .rejects.toThrow('unknown command recipe for n: triage');
  expect(executed).toBe(0);
});

test('pending.notifiedAt survives the notification persist path and readGraphRun reload', async () => {
  const { graph, root } = approvalFixture();
  const paused = await runGraph(graph, { runId: 'notify-stamp', deps: { root, runBash: async () => ({ stdout: '', stderr: '', exitCode: 0 }) } });
  expect(paused.status).toBe('awaiting-approval');
  const reloaded = latestGraphRun(paused.graphId, root);
  expect(reloaded?.runId).toBe(paused.runId);
  expect(reloaded?.pending?.notifiedAt).toBe(paused.pending?.notifiedAt);
  expect(reloaded?.pending?.notifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(JSON.parse(readFileSync(paused.statePath, 'utf8')).pending.notifiedAt).toBe(paused.pending?.notifiedAt);
  const again = await runGraph(graph, { resumeRunId: paused.runId, deps: { root, runBash: async () => { throw new Error('replayed'); } } });
  expect(again.pending?.notifiedAt).toBe(paused.pending?.notifiedAt);
  expect(latestGraphRun(paused.graphId, root)?.pending?.notifiedAt).toBe(paused.pending?.notifiedAt);
});

test('a stopped run cannot resume without --from, and a running run can still resume', async () => {
  const { graph, root } = fixture('printf first-output');
  const finished = await runGraph(graph, { runId: 'stop-vs-resume', deps: { root, runBash: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }) } });
  const state = JSON.parse(readFileSync(finished.statePath, 'utf8'));
  state.status = 'running';
  state.path = ['first'];
  state.nodes = [state.nodes[0]];
  state.executed = 1;
  writeFileSync(finished.statePath, JSON.stringify(state));
  const calls: string[] = [];
  const deps = { root, runBash: async (body: string) => { calls.push(body); return { stdout: 'ok', stderr: '', exitCode: 0 }; } };
  const running = await runGraph(graph, { resumeRunId: 'stop-vs-resume', deps });
  expect(running.status).toBe('done');
  expect(calls).toEqual(['exit 0']);
  state.status = 'failed';
  state.stoppedAt = new Date().toISOString();
  writeFileSync(finished.statePath, JSON.stringify(state));
  await expect(runGraph(graph, { resumeRunId: 'stop-vs-resume', deps })).rejects.toThrow('run is not awaiting approval');
  expect(calls).toEqual(['exit 0']);
});

test('resuming a running run skips completed command nodes', async () => {
  const { graph, root } = fixture('printf first-output');
  const calls: string[] = [];
  const finished = await runGraph(graph, { runId: 'running-resume', deps: { root, runBash: async (body: string) => {
    calls.push(body);
    return { stdout: body.includes('first-output') ? '{"outcome":"ok"}\n' : 'second-output', stderr: '', exitCode: 0 };
  } } });
  const saved = JSON.parse(readFileSync(finished.statePath, 'utf8'));
  saved.status = 'running';
  saved.path = ['first'];
  saved.nodes = [saved.nodes[0]];
  saved.executed = 1;
  delete saved.pending;
  writeFileSync(finished.statePath, `${JSON.stringify(saved)}\n`);
  const resumed = await runGraph(graph, { resumeRunId: 'running-resume', deps: { root, runBash: async (body: string) => {
    calls.push(body);
    return { stdout: 'resumed-second', stderr: '', exitCode: 0 };
  } } });
  expect(resumed.status).toBe('done');
  expect(resumed.path).toEqual(['first', 'second', 'done']);
  expect(resumed.executed).toBe(2);
  expect(resumed.nodes.filter((node) => node.nodeId === 'first')).toHaveLength(1);
  expect(calls.filter((body) => body.includes('first-output'))).toHaveLength(1);
  expect(JSON.parse(readFileSync(resumed.statePath, 'utf8')).nodes[0].output).toBe('{"outcome":"ok"}\n');
});

test('a loop resume branches from the last visit, not the first execution record', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-loop-resume-'));
  dirs.push(root);
  const graph = join(root, 'graph.yaml');
  writeFileSync(join(root, 'recipes.yaml'), 'judge:\n  command: "printf judge"\n');
  writeFileSync(graph, `graph_id: loop-resume
version: 1
entry_node: judge
terminal_nodes: [done, failed]
nodes:
  - { node_id: judge, kind: judge, recipe: 'cmd:judge', max_visits: 3 }
  - { node_id: done, kind: gate, max_visits: 1 }
  - { node_id: failed, kind: gate, max_visits: 1 }
edges:
  - from: judge
    on: outcome
    map: { again: judge, stop: done, ok: done, fail: failed }
`);
  let calls = 0;
  const seeded = await runGraph(graph, { runId: 'loop-resume', deps: { root, runBash: async () => ({ stdout: '{"outcome":"again"}\n', stderr: '', exitCode: 0 }) } });
  const saved = JSON.parse(readFileSync(seeded.statePath, 'utf8'));
  saved.status = 'running';
  saved.path = ['judge', 'judge'];
  saved.nodes = [
    { nodeId: 'judge', ok: true, exit: 0, executed: true, output: '{"outcome":"again"}\n' },
    { nodeId: 'judge', ok: true, exit: 0, executed: true, output: '{"outcome":"stop"}\n' },
  ];
  saved.executed = 2;
  delete saved.pending;
  writeFileSync(seeded.statePath, `${JSON.stringify(saved)}\n`);
  const resumed = await runGraph(graph, { resumeRunId: 'loop-resume', deps: { root, runBash: async () => {
    calls++;
    throw new Error('replayed judge');
  } } });
  expect(resumed.status).toBe('done');
  expect(resumed.path).toEqual(['judge', 'judge', 'done']);
  expect(calls).toBe(0);
});

test('awaiting-approval without pending is refused, while running without pending resumes', async () => {
  const { graph, root } = fixture('printf first-output');
  const finished = await runGraph(graph, { runId: 'corrupt-approval', deps: { root, runBash: async () => ({ stdout: '{"outcome":"ok"}\n', stderr: '', exitCode: 0 }) } });
  const saved = JSON.parse(readFileSync(finished.statePath, 'utf8'));
  saved.status = 'awaiting-approval';
  saved.path = ['first'];
  saved.nodes = [saved.nodes[0]];
  saved.executed = 1;
  delete saved.pending;
  writeFileSync(finished.statePath, `${JSON.stringify(saved)}\n`);
  await expect(runGraph(graph, { resumeRunId: 'corrupt-approval', deps: { root, runBash: async () => { throw new Error('should not run'); } } })).rejects.toThrow('run is not awaiting approval');
  saved.status = 'running';
  writeFileSync(finished.statePath, `${JSON.stringify(saved)}\n`);
  const resumed = await runGraph(graph, { resumeRunId: 'corrupt-approval', deps: { root, runBash: async () => ({ stdout: 'second', stderr: '', exitCode: 0 }) } });
  expect(resumed.status).toBe('done');
  expect(resumed.path).toEqual(['first', 'second', 'done']);
});

test('a node\'s last-line JSON outcome picks the matching branch and the next node receives the structured output', async () => {
  const { graph, root } = namedOutcomeFixture();
  try {
    const state = await runGraph(graph, { input: { kind: 'beta' }, deps: { root } });
    expect(state.status).toBe('done');
    expect(state.path).toEqual(['classify', 'b', 'done']);
    expect(String(state.nodes.find((n) => n.nodeId === 'b')?.output)).toContain('"got":"beta"');
    // map 에 없는 이름은 종전 ok 간선으로
    const other = await runGraph(graph, { input: { kind: 'gamma' }, deps: { root }, runId: 'run-gamma' });
    expect(other.path).toEqual(['classify', 'a', 'done']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('grow on follows an added outcome edge to done; off retains fallback', async () => {
  const { graph, root } = fixture('exit 0');
  const source = readFileSync(graph, 'utf8');
  const output = '{"outcome":"needs-research"}\n';
  const proposer = () => ({ node: { nodeId: 'research', kind: 'agent', recipe: 'none', maxVisits: 1,
    contract: { inputs: [], tools: 'read-only', outputs: [] } }, returnTo: 'second', reason: 'research is needed' });
  const calls: string[] = [];
  const runBash = async (body: string) => { calls.push(body); return { stdout: calls.length === 1 || calls.length === 3 ? output : '', stderr: '', exitCode: 0 }; };
  const off = await runGraph(graph, { deps: { root, runBash, growthProposer: () => { throw new Error('off invoked proposer'); } } });
  expect(off.path).toEqual(['first', 'second', 'done']);
  expect(off.growth).toBeUndefined();
  writeFileSync(graph, `grow: on\n${source}`);
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  const on = await runGraphWithGrowthScope(graph, { deps: { root, runBash, growthProposer: proposer, log: (event, data) => { logs.push({ event, data }); } } });
  expect(on.status).toBe('done');
  const added = debug.events(500).filter((entry) => entry.category === 'graph.run' && entry.event === 'edge-added' &&
    (entry.data as { runId?: string })?.runId === on.runId);
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({ data: { graphId: 'test-graph', runId: on.runId, from: 'first', outcome: 'needs-research', to: 'research' } });
  expect(on.path).toEqual(['first', 'research', 'second', 'done']);
  expect(on.growth).toHaveLength(1);
  expect(JSON.parse(readFileSync(on.statePath, 'utf8')).growth).toEqual(on.growth);
  expect(logs.filter((entry) => entry.event === 'edge-added')).toEqual([{ event: 'edge-added', data: {
    graphId: 'test-graph', runId: on.runId, from: 'first', outcome: 'needs-research', to: 'research',
  } }]);
});

test('grow off preserves the fallback edge for an unknown outcome without calling the proposer', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(graph, readFileSync(graph, 'utf8').replace('map: { ok: second, fail: failed }',
    'map: { fail: failed }\n    fallback:\n      - { node: second, requires: [] }'));
  const result = await runGraph(graph, { deps: { root,
    runBash: async () => ({ stdout: '{"outcome":"needs-research"}\n', stderr: '', exitCode: 0 }),
    growthProposer: () => { throw new Error('off invoked proposer'); },
  } });
  expect(result.status).toBe('done');
  expect(result.path).toEqual(['first', 'second', 'done']);
  expect(result.growth).toBeUndefined();
});

test('Pod env admits graph growth only for the exact harness scope', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(graph, `grow: on\n${readFileSync(graph, 'utf8')}`);
  const previous = process.env.ELANOUS_GRAPH_GROWTH_SCOPE;
  const proposerCalls: string[] = [];
  let bashCalls = 0;
  const runBash = async () => ({ stdout: ++bashCalls === 1 ? '{"outcome":"needs-research"}\n' : '{"outcome":"ok"}\n', stderr: '', exitCode: 0 });
  const proposer = () => {
    proposerCalls.push('called');
    return { node: { nodeId: 'research', kind: 'agent' as const, recipe: 'none', maxVisits: 1,
      contract: { inputs: [], tools: 'read-only' as const, outputs: [] } }, returnTo: 'second', reason: 'research needed' };
  };
  try {
    process.env.ELANOUS_GRAPH_GROWTH_SCOPE = 'harness';
    const admitted = await runGraph(graph, { deps: { root, runBash, growthProposer: proposer } });
    expect(admitted.path).toEqual(['first', 'research', 'second', 'done']);
    expect(proposerCalls).toHaveLength(1);

    proposerCalls.length = 0;
    bashCalls = 0;
    process.env.ELANOUS_GRAPH_GROWTH_SCOPE = 'task-agent';
    const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
    const rejected = await runGraph(graph, { deps: { root, runBash, growthProposer: proposer, log: (event, data) => logs.push({ event, data }) } });
    expect(rejected.path).toEqual(['first', 'second', 'done']);
    expect(rejected.growth).toBeUndefined();
    expect(proposerCalls).toHaveLength(0);
    expect(logs).toContainEqual({ event: 'growth-scope-rejected', data: expect.objectContaining({ reason: 'not-allowlisted' }) });
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_GRAPH_GROWTH_SCOPE;
    else process.env.ELANOUS_GRAPH_GROWTH_SCOPE = previous;
  }
});

test('rejected growth retains the original fallback and records its reason', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(graph, `grow: on\n${readFileSync(graph, 'utf8')}`);
  const result = await runGraphWithGrowthScope(graph, { deps: { root, runBash: async () => ({ stdout: '{"outcome":"new"}\n', stderr: '', exitCode: 0 }),
    growthProposer: () => ({ node: { nodeId: 'done', kind: 'agent', recipe: 'none', maxVisits: 1,
      contract: { inputs: [], tools: 'read-only', outputs: [] } }, returnTo: 'second', reason: 'invalid' }) } });
  expect(result.path).toEqual(['first', 'second', 'done']);
  expect(result.growth).toBeUndefined();
  expect(result.growthRejections?.[0]?.reason).toContain('invalid-growth');
});

test('an accepted growth survives an interrupted run and resume follows its saved edge without proposing again', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(graph, `grow: on\n${readFileSync(graph, 'utf8')}`);
  const deps = { root, runBash: async (body: string) => ({ stdout: body.includes('exit 0') ? '{"outcome":"new"}\n' : '', stderr: '', exitCode: 0 }),
    growthProposer: () => ({ node: { nodeId: 'research', kind: 'agent', recipe: 'none', maxVisits: 1,
      contract: { inputs: [], tools: 'read-only', outputs: [] } }, returnTo: 'second', reason: 'need research' }) };
  const first = await runGraphWithGrowthScope(graph, { deps });
  expect(first.path).toEqual(['first', 'research', 'second', 'done']);
  const saved = JSON.parse(readFileSync(first.statePath, 'utf8'));
  saved.status = 'running';
  saved.path = ['first'];
  saved.nodes = [saved.nodes[0]];
  saved.executed = 1;
  writeFileSync(first.statePath, JSON.stringify(saved));
  const resumed = await runGraph(graph, { resumeRunId: first.runId, deps: { root,
    runBash: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    growthProposer: () => { throw new Error('already accepted growth proposed twice'); } } });
  expect(resumed.status).toBe('done');
  expect(resumed.path).toEqual(['first', 'research', 'second', 'done']);
  expect(resumed.growth).toEqual(first.growth);
});

test('missing return edge falls back and records a rejection instead of executing a dead-end node', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(graph, `grow: on\n${readFileSync(graph, 'utf8')}`);
  const run = await runGraphWithGrowthScope(graph, { deps: { root, runBash: async () => ({ stdout: '{"outcome":"new"}\n', stderr: '', exitCode: 0 }),
    growthProposer: () => ({ node: { nodeId: 'dead-end', kind: 'agent', recipe: 'none', maxVisits: 1,
      contract: { inputs: [], tools: 'read-only', outputs: [] } }, reason: 'missing return' }) } });
  expect(run.status).toBe('done');
  expect(run.path).toEqual(['first', 'second', 'done']);
  expect(run.growth).toBeUndefined();
  expect(run.growthRejections?.[0]?.reason).toContain('invalid-growth');
});

test('a human growth decision resumes into the added edge or the original fallback without a second card', async () => {
  for (const choice of ['a', 'b'] as const) {
    const { graph, root } = fixture('exit 0');
    writeFileSync(graph, `grow: on\n${readFileSync(graph, 'utf8')}`);
    writeFileSync(join(root, 'recipes.yaml'), `${readFileSync(join(root, 'recipes.yaml'), 'utf8')}publish:\n  command: 'printf published'\n`);
    const entries: DecisionEntry[] = [];
    const ledger = { raiseOnce: (value: Record<string, unknown>, ref: string) => {
      const existing = entries.find(entry => entry.refs?.includes(ref));
      if (existing) return existing;
      const entry = { ...value, id: 'D-growth', status: 'open' } as DecisionEntry;
      entries.push(entry);
      return entry;
    } };
    const calls: string[] = [];
    const deps = { root, growthDecision: { ledger, list: () => entries },
      runBash: async (body: string) => { calls.push(body); return { stdout: calls.length === 1 ? '{"outcome":"new"}\n' : '', stderr: '', exitCode: 0 }; },
      growthProposer: () => ({ node: { nodeId: 'publish', kind: 'agent', recipe: 'cmd:publish', maxVisits: 1,
        contract: { inputs: [], tools: 'read-only', outputs: [] } }, returnTo: 'second', reason: 'publish' }) };
    const parked = await runGraphWithGrowthScope(graph, { deps });
    expect(parked.status).toBe('awaiting-approval');
    expect(parked.growthPark?.decisionId).toBe('D-growth');
    expect(parked.growthEvents?.map((event) => event.phase)).toEqual(['proposal', 'parked']);
    expect(entries).toHaveLength(1);
    await expect(runGraph(graph, { resumeRunId: parked.runId, deps })).rejects.toThrow('growth is parked for human confirmation');
    entries[0] = { ...entries[0]!, status: 'decided', choice, decidedBy: { kind: 'auto', agent: 'robot', delegation: 'test' } };
    await expect(runGraph(graph, { resumeRunId: parked.runId, deps })).rejects.toThrow('growth is parked for human confirmation');
    entries[0] = { ...entries[0]!, decidedBy: { kind: 'human' } };
    const resumed = await runGraph(graph, { resumeRunId: parked.runId, deps });
    expect(resumed.status).toBe('done');
    expect(resumed.path).toEqual(choice === 'a' ? ['first', 'publish', 'second', 'done'] : ['first', 'second', 'done']);
    expect(resumed.growth ?? []).toHaveLength(choice === 'a' ? 1 : 0);
    expect(resumed.growthEvents?.map((event) => event.phase)).toEqual(choice === 'a'
      ? ['proposal', 'parked', 'applied', 'undo-available']
      : ['proposal', 'parked', 'rejected']);
    if (choice === 'b') expect(resumed.growthEvents?.at(-1)).not.toHaveProperty('undo');
    expect(calls.some(body => body.includes('published'))).toBe(choice === 'a');
    expect(entries).toHaveLength(1);
  }
});

test('a recipe with both approval and command records its resolved command on the growth card and park', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(graph, `grow: on\n${readFileSync(graph, 'utf8')}`);
  writeFileSync(join(root, 'recipes.yaml'), `${readFileSync(join(root, 'recipes.yaml'), 'utf8')}publish:\n  approval: 'Publish now?'\n  command: 'printf published'\n`);
  const entries: DecisionEntry[] = [];
  const ledger = { raiseOnce: (value: Record<string, unknown>, ref: string) => {
    const entry = { ...value, id: 'D-approval-growth', status: 'open' } as DecisionEntry;
    entries.push(entry);
    return entry;
  } };
  const calls: string[] = [];
  const deps = { root, growthDecision: { ledger, list: () => entries },
    runBash: async (body: string) => { calls.push(body); return { stdout: calls.length === 1 ? '{"outcome":"new"}\n' : '', stderr: '', exitCode: 0 }; },
    growthProposer: () => ({ node: { nodeId: 'publish', kind: 'agent', recipe: 'approval:publish', maxVisits: 1,
      contract: { inputs: [], tools: 'read-only', outputs: [] } }, returnTo: 'second', reason: 'publish' }) };
  const parked = await runGraphWithGrowthScope(graph, { deps });
  expect(parked.status).toBe('awaiting-approval');
  expect(parked.growthPark).toMatchObject({ command: { command: 'printf published' }, approval: 'Publish now?' });
  expect(entries).toHaveLength(1);
  expect(entries[0]?.pendingQuestion).toContain('printf published');
  expect(entries[0]?.pendingQuestion).toContain('Publish now?');
  entries[0] = { ...entries[0]!, status: 'decided', choice: 'a', decidedBy: { kind: 'human' } };
  const resumed = await runGraph(graph, { resumeRunId: parked.runId, deps });
  expect(resumed.growth).toHaveLength(1);
  expect(resumed.path).toEqual(['first', 'publish']);
  expect(resumed.pending?.message).toBe('Publish now?');
  expect(calls).toEqual(['exit 0']);
  decideGraphApproval(resumed.graphId, resumed.runId, 'approved', 'person', root);
  const finished = await runGraph(graph, { resumeRunId: resumed.runId, deps });
  expect(finished.status).toBe('done');
  expect(finished.path).toEqual(['first', 'publish', 'second', 'done']);
  expect(calls).toEqual(['exit 0', 'printf published', 'exit 0']);
  expect(entries).toHaveLength(1);
});

test('a card cannot approve a changed parked node, command or approval', async () => {
  for (const mutation of ['node', 'command', 'approval'] as const) {
    const { graph, root } = fixture('exit 0');
    writeFileSync(graph, `grow: on\n${readFileSync(graph, 'utf8')}`);
    writeFileSync(join(root, 'recipes.yaml'), `${readFileSync(join(root, 'recipes.yaml'), 'utf8')}publish:\n  approval: 'Publish now?'\n  command: 'printf original'\n`);
    const entries: DecisionEntry[] = [];
    const ledger = { raiseOnce: (value: Record<string, unknown>) => {
      const entry = { ...value, id: 'D-target', status: 'open' } as DecisionEntry;
      entries.push(entry);
      return entry;
    } };
    const calls: string[] = [];
    const deps = { root, growthDecision: { ledger, list: () => entries },
      runBash: async (body: string) => { calls.push(body); return { stdout: '{"outcome":"new"}\n', stderr: '', exitCode: 0 }; },
      growthProposer: () => ({ node: { nodeId: 'publish', kind: 'agent', recipe: 'approval:publish', maxVisits: 1,
        contract: { inputs: [], tools: 'read-only', outputs: [] } }, returnTo: 'second', reason: 'publish' }) };
    const parked = await runGraphWithGrowthScope(graph, { deps });
    expect(parked.growthPark).toBeDefined();
    expect(entries).toHaveLength(1);
    entries[0] = { ...entries[0]!, status: 'decided', choice: 'a', decidedBy: { kind: 'human' } };
    const saved = JSON.parse(readFileSync(parked.statePath, 'utf8'));
    if (mutation === 'node') saved.growthPark.growth.node.contract.tools = 'git push';
    if (mutation === 'command') saved.growthPark.command.command = 'printf substituted';
    if (mutation === 'approval') saved.growthPark.approval = 'Approve something else?';
    writeFileSync(parked.statePath, JSON.stringify(saved));
    const before = readFileSync(parked.statePath, 'utf8');
    await expect(runGraph(graph, { resumeRunId: parked.runId, deps })).rejects.toThrow('growth approval target changed since card was raised');
    expect(readFileSync(parked.statePath, 'utf8')).toBe(before);
    expect(calls).toEqual(['exit 0']);
  }
});

test('a changed parked command cannot execute under its old human approval', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(graph, `grow: on\n${readFileSync(graph, 'utf8')}`);
  const recipes = join(root, 'recipes.yaml');
  writeFileSync(recipes, `${readFileSync(recipes, 'utf8')}publish:\n  command: 'printf original'\n`);
  const entries: DecisionEntry[] = [];
  const ledger = { raiseOnce: (value: Record<string, unknown>, ref: string) => {
    const existing = entries.find(entry => entry.refs?.includes(ref));
    if (existing) return existing;
    const entry = { ...value, id: `D-${entries.length + 1}`, status: 'open' } as DecisionEntry;
    entries.push(entry);
    return entry;
  } };
  const calls: string[] = [];
  const deps = { root, growthDecision: { ledger, list: () => entries },
    runBash: async (body: string) => { calls.push(body); return { stdout: calls.length === 1 ? '{"outcome":"new"}\n' : '', stderr: '', exitCode: 0 }; },
    growthProposer: () => ({ node: { nodeId: 'publish', kind: 'agent', recipe: 'cmd:publish', maxVisits: 1,
      contract: { inputs: [], tools: 'read-only', outputs: [] } }, returnTo: 'second', reason: 'publish' }) };
  const parked = await runGraphWithGrowthScope(graph, { deps });
  expect(parked.growthPark?.command?.command).toBe('printf original');
  expect(entries[0]?.pendingQuestion).toContain('printf original');
  entries[0] = { ...entries[0]!, status: 'decided', choice: 'a', decidedBy: { kind: 'human' } };
  writeFileSync(recipes, readFileSync(recipes, 'utf8').replace('printf original', 'printf changed'));
  const snapshot = join(`${parked.statePath}.graph`, 'recipes.yaml');
  writeFileSync(snapshot, readFileSync(snapshot, 'utf8').replace('printf original', 'printf changed'));
  const changedSource = readFileSync(snapshot, 'utf8');
  const saved = JSON.parse(readFileSync(parked.statePath, 'utf8'));
  saved.graphSnapshot.recipesSha = createHash('sha256').update(changedSource).digest('hex');
  saved.sourceHash = createHash('sha256').update(readFileSync(join(`${parked.statePath}.graph`, 'graph.yaml'), 'utf8')).update('\0').update(changedSource).digest('hex');
  writeFileSync(parked.statePath, JSON.stringify(saved));
  await expect(runGraph(graph, { resumeRunId: parked.runId, deps })).rejects.toThrow('growth command changed since approval');
  expect(calls).toEqual(['exit 0']);
  expect(JSON.parse(readFileSync(parked.statePath, 'utf8')).growthPark).toBeDefined();
});

test('an approval-only growth card cannot run a command added to its recipe after the card', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(graph, `grow: on\n${readFileSync(graph, 'utf8')}`);
  const recipes = join(root, 'recipes.yaml');
  writeFileSync(recipes, `${readFileSync(recipes, 'utf8')}publish:\n  approval: 'Publish now?'\n`);
  const entries: DecisionEntry[] = [];
  const ledger = { raiseOnce: (value: Record<string, unknown>) => {
    const entry = { ...value, id: 'D-added', status: 'open' } as DecisionEntry;
    entries.push(entry);
    return entry;
  } };
  const calls: string[] = [];
  const deps = { root, growthDecision: { ledger, list: () => entries },
    runBash: async (body: string) => { calls.push(body); return { stdout: calls.length === 1 ? '{"outcome":"new"}\n' : '', stderr: '', exitCode: 0 }; },
    growthProposer: () => ({ node: { nodeId: 'publish', kind: 'agent', recipe: 'approval:publish', maxVisits: 1,
      contract: { inputs: [], tools: 'read-only', outputs: [] } }, returnTo: 'second', reason: 'publish' }) };
  const parked = await runGraphWithGrowthScope(graph, { deps });
  expect(parked.growthPark?.approval).toBe('Publish now?');
  expect(parked.growthPark?.command).toBeUndefined();
  entries[0] = { ...entries[0]!, status: 'decided', choice: 'a', decidedBy: { kind: 'human' } };
  writeFileSync(recipes, readFileSync(recipes, 'utf8').replace("approval: 'Publish now?'\n", "approval: 'Publish now?'\n  command: 'printf added'\n"));
  const snapshot = join(`${parked.statePath}.graph`, 'recipes.yaml');
  writeFileSync(snapshot, readFileSync(recipes, 'utf8'));
  const changedSource = readFileSync(snapshot, 'utf8');
  const saved = JSON.parse(readFileSync(parked.statePath, 'utf8'));
  saved.graphSnapshot.recipesSha = createHash('sha256').update(changedSource).digest('hex');
  saved.sourceHash = createHash('sha256').update(readFileSync(join(`${parked.statePath}.graph`, 'graph.yaml'), 'utf8')).update('\0').update(changedSource).digest('hex');
  writeFileSync(parked.statePath, JSON.stringify(saved));
  await expect(runGraph(graph, { resumeRunId: parked.runId, deps })).rejects.toThrow('growth command changed since approval');
  expect(calls).toEqual(['exit 0']);
});

test('a recipe carrying an approval never runs as a bare cmd: command', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(join(root, 'recipes.yaml'), `first:\n  approval: 'Run first?'\n  command: 'printf leaked'\nsecond:\n  command: "exit 0"\n`);
  const calls: string[] = [];
  const deps = { root, runBash: async (body: string) => { calls.push(body); return { stdout: '', stderr: '', exitCode: 0 }; } };
  await expect(runGraph(graph, { deps })).rejects.toThrow('unknown command recipe for first');
  expect(calls).toEqual([]);
});

test('a rejected approval node never runs its command', async () => {
  const { graph, root } = approvalFixture();
  writeFileSync(join(root, 'recipes.yaml'), 'a:\n  command: "exit 0"\ngate:\n  approval: "Publish now?"\n  command: "printf gated"\nb:\n  command: "exit 0"\n');
  const calls: string[] = [];
  const deps = { root, runBash: async (body: string) => { calls.push(body); return { stdout: '', stderr: '', exitCode: 0 }; } };
  const first = await runGraph(graph, { deps });
  decideGraphApproval(first.graphId, first.runId, 'rejected', 'owner', root);
  const result = await runGraph(graph, { resumeRunId: first.runId, deps });
  expect(result.path).toEqual(['a', 'gate', 'failed']);
  expect(calls).toEqual(['exit 0']);
});

test('external side-effect growth parks and cannot be approved into execution', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(graph, `grow: on\n${readFileSync(graph, 'utf8')}`);
  const run = await runGraphWithGrowthScope(graph, { deps: { root, growthDecision: fakeGrowthDecision(), runBash: async () => ({ stdout: '{"outcome":"new"}\n', stderr: '', exitCode: 0 }),
    growthProposer: () => ({ node: { nodeId: 'publish', kind: 'agent', recipe: 'cmd:git push', maxVisits: 1,
      contract: { inputs: [], tools: 'git push', outputs: [] } }, returnTo: 'second', reason: 'push' }) } });
  expect(run.status).toBe('awaiting-approval');
  expect(run.path).toEqual(['first']);
  expect(run.pending?.message).toContain('사람 확인 필요');
  expect(run.growthPark).toMatchObject({ from: 'first', outcome: 'new', reason: expect.stringContaining('사람 확인 필요') });
  expect(run.growth).toBeUndefined();
  expect(() => decideGraphApproval(run.graphId, run.runId, 'approved', 'person', root)).toThrow('not awaiting');
  await expect(runGraph(graph, { resumeRunId: run.runId, deps: { root } })).rejects.toThrow('growth is parked for human confirmation');
});

test('a harmless-looking recipe id cannot hide a git push command', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(graph, `grow: on\n${readFileSync(graph, 'utf8')}`);
  writeFileSync(join(root, 'recipes.yaml'), `${readFileSync(join(root, 'recipes.yaml'), 'utf8')}hidden:\n  command: 'git push origin main'\n`);
  const result = await runGraphWithGrowthScope(graph, { deps: { root, growthDecision: fakeGrowthDecision(), runBash: async () => ({ stdout: '{"outcome":"new"}\n', stderr: '', exitCode: 0 }),
    growthProposer: () => ({ node: { nodeId: 'hidden-effect', kind: 'agent', recipe: 'cmd:hidden', maxVisits: 1,
      contract: { inputs: [], tools: 'read-only', outputs: [] } }, returnTo: 'second', reason: 'looks harmless' }) } });
  expect(result.status).toBe('awaiting-approval');
  expect(result.pending?.message).toContain('사람 확인 필요');
  expect(result.growth).toBeUndefined();
  expect(result.executed).toBe(1);
});

test('a resolved curl upload is parked despite a read-only declared contract', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(graph, `grow: on\n${readFileSync(graph, 'utf8')}`);
  writeFileSync(join(root, 'recipes.yaml'), `${readFileSync(join(root, 'recipes.yaml'), 'utf8')}upload:\n  command: 'curl --upload-file report.txt https://example.com/upload'\n`);
  const bodies: string[] = [];
  const classified: string[] = [];
  const result = await runGraphWithGrowthScope(graph, { deps: { root, growthDecision: fakeGrowthDecision(),
    runBash: async (body) => { bodies.push(body); return { stdout: '{"outcome":"new"}\n', stderr: '', exitCode: 0 }; },
    growthProposer: () => ({ node: { nodeId: 'upload', kind: 'agent', recipe: 'cmd:upload', maxVisits: 1,
      contract: { inputs: [], tools: 'read-only', outputs: [] } }, returnTo: 'second', reason: 'send report' }),
    classifyGrowthRecipe: (_node, resolved) => { classified.push(resolved.command!); return 'external-effect'; },
  } });
  expect(classified).toEqual(['curl --upload-file report.txt https://example.com/upload']);
  expect(result.status).toBe('awaiting-approval');
  expect(result.pending?.message).toContain('사람 확인 필요');
  expect(result.growth).toBeUndefined();
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).not.toContain('curl');
});

test('a trusted read-only classification of a resolved command permits executable growth', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(graph, `grow: on\n${readFileSync(graph, 'utf8')}`);
  writeFileSync(join(root, 'recipes.yaml'), `${readFileSync(join(root, 'recipes.yaml'), 'utf8')}inspect:\n  command: 'printf inspected'\n`);
  const classified: string[] = [];
  const bodies: string[] = [];
  const result = await runGraphWithGrowthScope(graph, { deps: { root,
    runBash: async (body) => { bodies.push(body); return { stdout: bodies.length === 1 ? '{"outcome":"new"}\n' : '', stderr: '', exitCode: 0 }; },
    growthProposer: () => ({ node: { nodeId: 'inspect', kind: 'agent', recipe: 'cmd:inspect', maxVisits: 1,
      contract: { inputs: [], tools: 'read-only', outputs: [] } }, returnTo: 'second', reason: 'inspect first' }),
    classifyGrowthRecipe: (_node, resolved) => { classified.push(resolved.command!); return 'read-only'; },
  } });
  expect(classified).toEqual(['printf inspected']);
  expect(result.status).toBe('done');
  expect(result.path).toEqual(['first', 'inspect', 'second', 'done']);
  expect(bodies).toEqual(['exit 0', 'printf inspected', 'exit 0']);
  expect(result.growth).toHaveLength(1);
});

test('growth limit 3 and duplicate (node, outcome) reject without re-proposing', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(graph, `grow: on\n${readFileSync(graph, 'utf8').replace('max_visits: 1 }', 'max_visits: 5 }')}`);
  let calls = 0;
  const run = await runGraphWithGrowthScope(graph, { deps: { root, runBash: async (_body, opts) => {
    const context = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8'));
    return { stdout: JSON.stringify({ outcome: context.nodeId === 'first' ? `new-${++calls}` : 'ok' }), stderr: '', exitCode: 0 };
  }, growthProposer: ({ outcome }) => ({ node: { nodeId: `added-${outcome}`, kind: 'agent', recipe: 'none', maxVisits: 1,
    contract: { inputs: [], tools: 'read-only', outputs: [] } }, returnTo: 'first', reason: outcome }) } });
  expect(run.growth).toHaveLength(3);
  expect(run.growthRejections?.at(-1)?.reason).toBe('growth limit 3 reached');
  expect(run.growthEvents?.filter((event) => event.phase === 'proposal')).toHaveLength(3);
  expect(run.growthEvents?.at(-1)?.phase).toBe('rejected');
  expect(run.path).toEqual(['first', 'added-new-1', 'first', 'added-new-2', 'first', 'added-new-3', 'first', 'second', 'done']);
  expect(calls).toBe(4);
});

test('growth proposal limit 8 rejects the ninth unmatched outcome without calling the proposer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-growth-cap-8-'));
  dirs.push(root);
  const graph = join(root, 'graph.yaml');
  writeFileSync(join(root, 'recipes.yaml'), 'first:\n  command: "exit 0"\n');
  writeFileSync(graph, `grow: on\ngraph_id: growth-cap-8\nversion: 1\nentry_node: first\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: first, kind: agent, recipe: 'cmd:first', max_visits: 11 }\n  - { node_id: done, kind: gate, max_visits: 1 }\n  - { node_id: failed, kind: gate, max_visits: 1 }\nedges:\n  - from: first\n    on: outcome\n    map: { ok: first, fail: failed }\n`);
  let nodeCalls = 0;
  let proposerCalls = 0;
  const run = await runGraphWithGrowthScope(graph, { deps: { root,
    runBash: async () => ({ stdout: JSON.stringify({ outcome: ++nodeCalls <= 9 ? `unmapped-${nodeCalls}` : 'fail' }), stderr: '', exitCode: 0 }),
    growthProposer: async () => { proposerCalls += 1; return undefined; },
  } });
  expect(run.growthAttempts).toBe(8);
  expect(proposerCalls).toBe(8);
  expect(nodeCalls).toBe(10);
  expect(run.path).toHaveLength(11);
  expect(run.growthEvents?.filter((event) => event.phase === 'proposal')).toHaveLength(8);
  expect(run.growthRejections?.at(-1)?.reason).toBe('growth proposal limit 8 reached');
  expect(run.growthRejections?.filter((event) => event.reason === 'growth proposal limit 8 reached')).toHaveLength(1);
  expect(run.growthEvents?.at(-1)?.phase).toBe('rejected');
  expect(run.growthEvents?.filter((event) => event.phase === 'rejected' && event.reason === 'growth proposal limit 8 reached')).toHaveLength(1);
});

test('one (node, outcome) growth is reused on a revisit rather than proposed again', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(graph, `grow: on\n${readFileSync(graph, 'utf8').replace('max_visits: 1 }', 'max_visits: 3 }')}`);
  let proposals = 0;
  const result = await runGraphWithGrowthScope(graph, { deps: { root, runBash: async (_body, opts) => ({
    stdout: JSON.stringify({ outcome: JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')).nodeId === 'first' ? 'new' : 'ok' }),
    stderr: '', exitCode: 0,
  }), growthProposer: () => { proposals++; return { node: { nodeId: 'research', kind: 'agent', recipe: 'none', maxVisits: 3,
    contract: { inputs: [], tools: 'read-only', outputs: [] } }, returnTo: 'first', reason: 'same outcome' }; } } });
  expect(proposals).toBe(1);
  expect(result.growth).toHaveLength(1);
  expect(result.status).toBe('budget-exceeded');
  expect(result.path).toEqual(['first', 'research', 'first', 'research', 'first', 'research']);
});

// 09-30 🅢: 작업 트리 `graph run … --config-dir ~/.elanous` 의 `cmd:` 자식이 코드 위치로 시험 우주를 새로 골랐다.
test('an explicit config dir pins the state-backed config root for every cmd child without forwarding an ignored config env', async () => {
  const { graph, root } = fixture('exit 0');
  const explicit = mkdtempSync(join(tmpdir(), 'graph-universe-'));
  const envs: NodeJS.ProcessEnv[] = [];
  const priorConfig = process.env.ELANOUS_CONFIG_DIR;
  const priorState = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_CONFIG_DIR = '/ignored/parent/config';
  try {
    setElanousConfigDir(explicit);
    const expectedConfig = getElanousConfigDir();
    const expectedState = effectiveInstanceRoot();
    const pinned = await runGraph(graph, { deps: { root, runBash: async (_body, opts) => { envs.push(opts.env!); return { stdout: '', stderr: '', exitCode: 0 }; } } });
    expect(pinned.status).toBe('done');
    expect(envs).toHaveLength(2);
    expect(envs.every((env) => env.ELANOUS_CONFIG_DIR === undefined && env.ELANOUS_STATE_DIR === expectedState)).toBe(true);
    expect(expectedConfig).toBe(expectedState);
    const child = Bun.spawnSync({
      cmd: [process.execPath, '-e', `import { getElanousConfigDir } from ${JSON.stringify(join(import.meta.dir, '../elanous-config-dir.ts'))}; console.log(getElanousConfigDir());`],
      env: envs[0], stdout: 'pipe', stderr: 'pipe',
    });
    expect(child.exitCode).toBe(0);
    expect(new TextDecoder().decode(child.stdout).trim()).toBe(expectedConfig);
    resetElanousConfigDir();
    envs.length = 0;
    process.env.ELANOUS_STATE_DIR = '/inherited/state';
    await runGraph(graph, { deps: { root, runBash: async (_body, opts) => { envs.push(opts.env!); return { stdout: '', stderr: '', exitCode: 0 }; } } });
    expect(envs).toHaveLength(2);
    expect(envs.every((env) => env.ELANOUS_CONFIG_DIR === undefined && env.ELANOUS_STATE_DIR === '/inherited/state')).toBe(true);
  } finally {
    resetElanousConfigDir();
    if (priorConfig === undefined) delete process.env.ELANOUS_CONFIG_DIR; else process.env.ELANOUS_CONFIG_DIR = priorConfig;
    if (priorState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = priorState;
    rmSync(explicit, { recursive: true, force: true });
  }
});
