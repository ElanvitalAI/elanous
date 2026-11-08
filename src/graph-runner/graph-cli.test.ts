import { setDefaultTimeout, afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { writePeerEdit } from '../nexus/api/graph-peer-edit.js';
import { setPluginCredentials } from '../plugins/install/plugin-credentials.js';
import { Command } from 'commander';
import { registerGraphCommands } from './graph-cli.js';
import { runGraph } from './runner.js';
import { simCli } from '../ux-sim/in-process-cli.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const root = resolve(import.meta.dir, '../..');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function spawnGraphAt(stateRoot: string, cwd: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await simCli(['graph', ...args], {
    allowPaths: [['graph', 'adapt-report'], ['graph', 'promote', 'evaluate'], ['graph', 'tick'], ['graph', 'runs', 'list'], ['graph', 'approve'], ['graph', 'notify'], ['graph', 'run'], ['graph', 'status'], ['graph', 'runs', 'status']], stateRoot, cwd,
  });
  return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

async function spawnGraph(stateRoot: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return await spawnGraphAt(stateRoot, root, ...args);
}

async function runGraphInProcess(stateRoot: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await simCli(['graph', ...args], {
    allowPaths: [['graph', 'run'], ['graph', 'status'], ['graph', 'approve']], stateRoot,
  });
  return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

test('graph adapt-report measures same-goal A/A/B ledger paths, adaptations, landings and exclusions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-adapt-report-'));
  dirs.push(dir);
  const stateRoot = join(dir, 'state');
  const ledgerDir = join(stateRoot, 'run-ledger');
  mkdirSync(ledgerDir, { recursive: true });
  const goalId = 'goal-adapt-report';
  const event = (runId: string, name: string, data: Record<string, unknown>) => ({
    runId, goalId, timestamp: '2026-10-24T00:00:00Z', event: name, data,
  });
  const put = (suffix: number, entries: ReturnType<typeof event>[]) => {
    const runId = `run-00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
    writeFileSync(join(ledgerDir, `${runId}.jsonl`), entries.map(entry => JSON.stringify({ ...entry, runId })).join('\n') + '\n');
    return runId;
  };
  for (const [suffix, path, adapted, landed, calls] of [
    [1, ['A', 'done'], true, true, 2],
    [2, ['A', 'done'], false, false, 1],
    [3, ['B', 'done'], false, true, 0],
  ] as const) {
    const runId = `run-00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
    put(suffix, [event(runId, 'start', {}),
      event(runId, 'pipeline-traversal-shadow', { observedNodes: path }),
      ...(adapted ? [event(runId, 'graph-variant-applied', { graphId: 'self-implement', overlayId: 'variant-A' })] : []),
      event(runId, 'merged', { merged: landed, number: suffix })]);
    const graphDir = join(stateRoot, 'graph-runs', 'self-implement');
    mkdirSync(graphDir, { recursive: true });
    writeFileSync(join(graphDir, `${runId}.json`), JSON.stringify({ graphId: 'self-implement', runId,
      unitCalls: Array.from({ length: calls }, (_, index) => ({ node: `call-${index}`, unit: 'worker', version: 1,
        hash: 'hash', childRunId: `child-${index}`, exit: 'done', steps: 1 })) }));
  }
  const invalid = put(4, [event('ignored', 'start', {})]);
  writeFileSync(join(ledgerDir, `${invalid}.jsonl`), '{bad}\n');
  const other = `run-00000000-0000-4000-8000-${String(5).padStart(12, '0')}`;
  put(5, [event(other, 'start', {}), event(other, 'pipeline-traversal-shadow', { observedNodes: ['C'] })]
    .map(entry => ({ ...entry, goalId: 'other-goal' })));

  const result = await spawnGraph(stateRoot, 'adapt-report', '--goal', goalId, '--json');
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    goalId, runCount: 3, uniquePathSignatures: 2, unitCallCount: 3, adaptationCount: 1,
    adapted: { landed: 1, denominator: 1, rate: 1 },
    nonAdapted: { landed: 1, denominator: 2, rate: 0.5 },
    excludedCount: 1, exclusionReasons: { 'invalid-ledger': 1 },
  });
  const empty = await spawnGraph(stateRoot, 'adapt-report', '--goal', 'absent-goal');
  expect(empty.code).toBe(0);
  expect(empty.stdout).toContain('표본 0');
  expect(empty.stdout).not.toContain('착지율');
  const emptyJson = await spawnGraph(stateRoot, 'adapt-report', '--goal', 'absent-goal', '--json');
  expect(JSON.parse(emptyJson.stdout)).toMatchObject({ runCount: 0,
    adapted: { landed: 0, denominator: 0, rate: null },
    nonAdapted: { landed: 0, denominator: 0, rate: null } });
}, 120_000);

test('graph adapt-report windows by start time and separates in-flight and missing graph artifacts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-adapt-window-'));
  dirs.push(dir);
  const stateRoot = join(dir, 'state');
  const ledgerDir = join(stateRoot, 'run-ledger');
  const graphDir = join(stateRoot, 'graph-runs', 'self-implement');
  mkdirSync(ledgerDir, { recursive: true });
  mkdirSync(graphDir, { recursive: true });
  const goalId = 'window-goal';
  const put = (suffix: number, timestamp: string, artifact: boolean, terminal: boolean, parked = false) => {
    const runId = `run-00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
    const entry = (event: string, data: Record<string, unknown>) => JSON.stringify({ runId, goalId, timestamp, event, data });
    writeFileSync(join(ledgerDir, `${runId}.jsonl`), [entry('start', {}),
      entry('pipeline-traversal-shadow', { observedNodes: ['A', 'done'] }),
      ...(terminal ? [entry('run-status', { runStatus: 'completed' }), entry('merged', { merged: true })] : []),
      ...(parked ? [entry('run-status', { runStatus: 'parked' })] : []),
    ].join('\n') + '\n');
    if (artifact) writeFileSync(join(graphDir, `${runId}.json`), JSON.stringify({ runId, graphId: 'self-implement', unitCalls: [] }));
  };
  put(1, '2026-10-24T00:00:00Z', true, true); // before the window
  put(2, '2026-10-25T00:00:00Z', true, true); // included at lower bound
  put(3, '2026-10-25T01:00:00Z', true, false); // in flight
  put(4, '2026-10-25T02:00:00Z', false, true); // unmeasured, not a failed landing
  put(5, '2026-10-26T00:00:00Z', true, true); // excluded at upper bound
  put(6, '2026-10-25T03:00:00Z', true, false, true); // parked and resumable
  const result = await spawnGraph(stateRoot, 'adapt-report', '--goal', goalId,
    '--from', '2026-10-25T00:00:00Z', '--to', '2026-10-26T00:00:00Z', '--json');
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ runCount: 1,
    nonAdapted: { landed: 1, denominator: 1, rate: 1 },
    excludedCount: 4, exclusionReasons: { 'outside-start-window': 2, 'in-flight': 2 },
    unmeasuredCount: 1, unmeasuredReasons: { 'graph-run-missing': 1 },
    window: { since: '2026-10-25T00:00:00Z', until: '2026-10-26T00:00:00Z' } });
  const invalid = await spawnGraph(stateRoot, 'adapt-report', '--goal', goalId,
    '--from', '2026-10-27T00:00:00Z', '--to', '2026-10-26T00:00:00Z');
  expect(invalid.code).not.toBe(0);
  expect(invalid.stderr).toContain('invalid adaptation measurement window');
}, 120_000);

test('graph promote evaluates an injected same-trigger E4 ledger into a human-only overlay proposal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-promote-fixture-'));
  dirs.push(dir);
  const fixturePath = join(dir, 'evidence.json');
  const dates = ['2026-10-01', '2026-10-03', '2026-10-05', '2026-10-07', '2026-10-08'];
  const events = [
    ...dates.map((date, index) => ({ runId: `adapt-${index}`, timestamp: `${date}T00:00:00Z`, trigger: 'same-trigger', phase: 'adaptation', landed: index < 4 })),
    ...dates.map((date, index) => ({ runId: `base-${index}`, timestamp: `${date}T00:00:00Z`, trigger: 'same-trigger', phase: 'baseline', landed: index < 3 })),
    { runId: 'shadow-start', timestamp: '2026-10-09T00:00:00Z', trigger: 'same-trigger', phase: 'shadow', shadowAccepted: true },
    { runId: 'shadow-end', timestamp: '2026-10-16T00:00:00Z', trigger: 'same-trigger', phase: 'shadow', shadowAccepted: true },
  ];
  writeFileSync(fixturePath, JSON.stringify({ trigger: 'same-trigger', candidate: {
    overlayId: 'profile-repeat-path', target: 'self-implement', appliesWhen: 'profile == repeat-path',
    patch: [{ op: 'replace', path: '/nodes/0/maxVisits', value: 2 }],
  }, events }));

  const result = await spawnGraphAt(join(dir, 'test-state'), dir, 'promote', 'evaluate', '--fixture', fixturePath, '--json');
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    mockOnly: true, verdict: 'eligible-for-human-pr', blockers: [],
    metrics: { adaptationRuns: 5, adaptationLandingRate: 0.8, baselineRuns: 5,
      baselineLandingRate: 0.6, adaptationWindowDays: 7, shadowObservations: 2, shadowWindowDays: 7 },
    proposal: { action: 'proposal-only', promoted_from: ['adapt-0', 'adapt-1', 'adapt-2', 'adapt-3', 'adapt-4'],
      evidence: { source: 'injected-mock-fixture' }, overlay: { overlay_id: 'profile-repeat-path', stage: 'launch' },
      rollback: expect.any(String), patentReview: 'ELA-53 human review pending' },
  });
  expect(JSON.parse(result.stdout).metrics.landingDelta).toBeCloseTo(0.2);
  expect(existsSync(join(dir, 'profile-repeat-path.yaml'))).toBe(false);
}, 120_000);

test('graph promote keeps a mock candidate held when shadow evidence declines', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-promote-decline-'));
  dirs.push(dir);
  const fixturePath = join(dir, 'evidence.json');
  const dates = ['2026-10-01', '2026-10-03', '2026-10-05', '2026-10-07', '2026-10-08'];
  const events = [
    ...dates.map((date, index) => ({ runId: `adapt-${index}`, timestamp: `${date}T00:00:00Z`, trigger: 'same-trigger', phase: 'adaptation', landed: index < 4 })),
    ...dates.map((date, index) => ({ runId: `base-${index}`, timestamp: `${date}T00:00:00Z`, trigger: 'same-trigger', phase: 'baseline', landed: index < 3 })),
    { runId: 'shadow-start', timestamp: '2026-10-09T00:00:00Z', trigger: 'same-trigger', phase: 'shadow', shadowAccepted: true },
    { runId: 'shadow-end', timestamp: '2026-10-16T00:00:00Z', trigger: 'same-trigger', phase: 'shadow', shadowAccepted: false },
  ];
  writeFileSync(fixturePath, JSON.stringify({ trigger: 'same-trigger', candidate: {
    overlayId: 'profile-repeat-path', target: 'self-implement', appliesWhen: 'profile == repeat-path',
    patch: [{ op: 'replace', path: '/nodes/0/maxVisits', value: 2 }],
  }, events }));
  const result = await spawnGraphAt(join(dir, 'test-state'), dir, 'promote', 'evaluate', '--fixture', fixturePath, '--json');
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ mockOnly: true, verdict: 'held',
    blockers: ['shadow-evaluation-declined'] });
  expect(JSON.parse(result.stdout).proposal).toBeUndefined();
  expect(JSON.parse(result.stdout).metrics.landingDelta).toBeCloseTo(0.2);
  expect(existsSync(join(dir, 'profile-repeat-path.yaml'))).toBe(false);
}, 120_000);

test('graph wizard-run is exposed as the smart wizard request entrypoint', async () => {
  const program = new Command();
  registerGraphCommands(program);
  const graph = program.commands.find(command => command.name() === 'graph');
  expect(graph?.commands.some(command => command.name() === 'wizard-run')).toBe(true);
});

test('graph tick defaults to idle and --start passes JSON input, prints results, and does not restart a finished run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-cli-tick-'));
  dirs.push(dir);
  const stateRoot = join(dir, 'state');
  const graph = join(dir, 'graph.yaml');
  const executed = join(dir, 'executed');
  writeFileSync(join(dir, 'recipes.yaml'), `a:\n  command: "printf x >> '${executed}'"\n`);
  writeFileSync(graph, `graph_id: cli-tick\nversion: 1\nentry_node: a\nterminal_nodes: [done]\nnodes:\n  - { node_id: a, kind: agent, recipe: 'cmd:a', max_visits: 1, notify: false }\n  - { node_id: done, kind: gate, max_visits: 1 }\nedges:\n  - { from: a, to: done }\n`);
  const idle = await spawnGraphAt(stateRoot, dir, 'tick', graph, '--json');
  expect(idle.code).toBe(0);
  expect(JSON.parse(idle.stdout)).toEqual({ action: 'idle' });
  expect(existsSync(executed)).toBe(false);
  const started = await spawnGraphAt(stateRoot, dir, 'tick', graph, '--start', '--input', '{"job":7}', '--json');
  expect(started.code).toBe(0);
  expect(JSON.parse(started.stdout)).toMatchObject({ action: 'started', status: 'done', runId: expect.any(String) });
  expect(readFileSync(executed, 'utf8')).toBe('x');
  const runId = JSON.parse(started.stdout).runId as string;
  expect(JSON.parse(readFileSync(join(stateRoot, 'graph-runs', 'cli-tick', `${runId}.json`), 'utf8')).input).toEqual({ job: 7 });
  const following = await spawnGraphAt(stateRoot, dir, 'tick', graph);
  expect(following.code).toBe(0);
  expect(following.stdout).toContain('graph tick: idle');
  expect(readFileSync(executed, 'utf8')).toBe('x');
}, 30000);

test('graph YAML triggers.schedule fires through the workflow scheduler into graph tick and persists a run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-cli-schedule-'));
  dirs.push(dir);
  const stateRoot = join(dir, 'state');
  const graph = join(dir, 'graph.yaml');
  const executed = join(dir, 'executed');
  writeFileSync(join(dir, 'recipes.yaml'), `a:\n  command: "printf x >> '${executed}'"\n`);
  writeFileSync(graph, `graph_id: cli-scheduled\nloop:\n  trigger:\n    events: [release.cut.due]\nversion: 1\nentry_node: a\nterminal_nodes: [done]\ntriggers:\n  schedule: { type: interval, interval: 1000 }\nnodes:\n  - { node_id: a, kind: agent, recipe: 'cmd:a', max_visits: 1, notify: false }\n  - { node_id: done, kind: gate, max_visits: 1 }\nedges:\n  - { from: a, to: done }\n`);
  const controller = new AbortController();
  let childExitCode: number | null = null;
  const child = simCli(['--test', stateRoot, 'graph', 'tick', 'graph.yaml', '--schedule'], {
    mode: 'spawn', allowPaths: [['graph', 'tick']], stateRoot, cwd: dir, timeoutMs: 30_000, signal: controller.signal,
  });
  void child.then((result) => { childExitCode = result.exitCode; });
  try {
    for (let i = 0; i < 100 && !existsSync(executed); i++) {
      if (childExitCode !== null) break;
      await Bun.sleep(100);
    }
    expect(childExitCode).toBeNull();
    expect(readFileSync(executed, 'utf8')).toContain('x');
    const runDir = join(stateRoot, 'graph-runs', 'cli-scheduled');
    const deadline = Date.now() + 10_000;
    let saved: { graphId: string; runId: string; status: string } | undefined;
    while (Date.now() < deadline) {
      for (const name of existsSync(runDir) ? readdirSync(runDir).filter(name => name.endsWith('.json')) : []) {
        try {
          const state = JSON.parse(readFileSync(join(runDir, name), 'utf8')) as typeof saved;
          if (state?.status === 'done') saved = state;
        } catch { /* A run may still be writing its state; retry until the deadline. */ }
      }
      if (saved || childExitCode !== null) break;
      await Bun.sleep(100);
    }
    expect(saved?.status).toBe('done');
    expect(saved?.graphId).toBe('cli-scheduled');
    expect(typeof saved?.runId).toBe('string');
    const runs = await spawnGraphAt(stateRoot, dir, 'runs', 'list', '--graph', 'cli-scheduled', '--json');
    expect(runs.code).toBe(0);
    expect(JSON.parse(runs.stdout)).toContainEqual(expect.objectContaining({ runId: saved!.runId, status: 'done' }));
  } finally {
    controller.abort();
    await child;
  }
}, 30000);

test('graph triggers.webhook fires one graph tick', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-cli-webhook-'));
  dirs.push(dir);
  const stateRoot = join(dir, 'state');
  const graph = join(dir, 'graph.yaml');
  const executed = join(dir, 'executed');
  writeFileSync(join(dir, 'recipes.yaml'), `a:\n  command: "printf x >> '${executed}'"\n`);
  writeFileSync(graph, `graph_id: cli-webhook\nversion: 1\nentry_node: a\nterminal_nodes: [done]\ntriggers:\n  webhook: { method: POST, path: /hooks/graph }\nnodes:\n  - { node_id: a, kind: agent, recipe: 'cmd:a', max_visits: 1, notify: false }\n  - { node_id: done, kind: gate, max_visits: 1 }\nedges:\n  - { from: a, to: done }\n`);
  const controller = new AbortController();
  let out = '';
  const child = simCli(['--test', stateRoot, 'graph', 'tick', 'graph.yaml', '--webhook'], {
    mode: 'spawn', allowPaths: [['graph', 'tick']], stateRoot, cwd: dir, timeoutMs: 30_000, signal: controller.signal,
    onStdout: (chunk) => { out += chunk; },
  });
  try {
    const deadline = Date.now() + 20_000;
    while (!/http:\/\/127\.0\.0\.1:\d+/.test(out) && Date.now() < deadline) {
      await Bun.sleep(100);
    }
    const base = out.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    expect(base).toBeDefined();
    expect(existsSync(executed)).toBe(false);
    const missing = await fetch(`${base}/hooks/other`, { method: 'POST', body: '{}' });
    expect(missing.status).toBe(404);
    expect(existsSync(executed)).toBe(false);
    const hit = await fetch(`${base}/hooks/graph`, { method: 'POST', body: '{}' });
    expect(hit.status).toBe(202);
    const body = await hit.json() as { ok: boolean; runId: string; workflow: string };
    expect(body).toMatchObject({ ok: true, workflow: 'graph:cli-webhook' });
    expect(typeof body.runId).toBe('string');
    expect(readFileSync(executed, 'utf8')).toBe('x');
    const runs = readdirSync(join(stateRoot, 'graph-runs', 'cli-webhook')).filter(name => name.endsWith('.json'));
    expect(runs).toEqual([`${body.runId}.json`]);
  } finally {
    controller.abort();
    await child;
  }
}, 30000);

test('a scheduled mine graph refuses a later peer edit without killing its schedule', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-cli-mine-schedule-'));
  dirs.push(dir);
  const stateRoot = join(dir, 'state');
  const mineDir = join(stateRoot, 'graphs');
  mkdirSync(mineDir, { recursive: true });
  const graph = join(mineDir, 'g1.yaml');
  const executed = join(dir, 'executed');
  writeFileSync(join(mineDir, 'recipes.yaml'), `a:\n  command: "printf x >> '${executed}'"\n`);
  writeFileSync(graph, `graph_id: g1\nversion: 1\nentry_node: a\nterminal_nodes: [done]\ntriggers:\n  schedule: { type: interval, interval: 1000 }\nnodes:\n  - { node_id: a, kind: agent, recipe: 'cmd:a', max_visits: 1, notify: false }\n  - { node_id: done, kind: gate, max_visits: 1 }\nedges:\n  - { from: a, to: done }\n`);
  const controller = new AbortController();
  let childExitCode: number | null = null;
  let childResult: { stderr: string } | undefined;
  const child = simCli(['--test', stateRoot, 'graph', 'tick', graph, '--schedule'], {
    mode: 'spawn', allowPaths: [['graph', 'tick']], stateRoot, cwd: dir, timeoutMs: 30_000, signal: controller.signal,
  });
  void child.then((result) => { childExitCode = result.exitCode; childResult = result; });
  try {
    for (let i = 0; i < 150 && !existsSync(executed); i++) {
      if (childExitCode !== null) break;
      await Bun.sleep(100);
    }
    expect(readFileSync(executed, 'utf8')).toBe('x');
    writePeerEdit(mineDir, 'g1', { editedBy: 'peer:12345678', version: 'peer-v1', at: new Date().toISOString() });
    const before = readFileSync(executed, 'utf8');
    await Bun.sleep(2_500);
    expect(childExitCode).toBeNull();
    expect(readFileSync(executed, 'utf8')).toBe(before);
    expect(readdirSync(join(stateRoot, 'graph-runs', 'g1')).filter(name => name.endsWith('.json'))).toHaveLength(1);
  } finally {
    controller.abort();
    await child;
  }
  expect(childResult?.stderr).toContain('graph tick: refused: peer-edit-unapproved');
}, 30000);

test('graph tick waits for approval and resumes the same run without replaying completed nodes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-cli-tick-resume-'));
  dirs.push(dir);
  const stateRoot = join(dir, 'state');
  const graph = join(dir, 'graph.yaml');
  const executed = join(dir, 'executed');
  writeFileSync(join(dir, 'recipes.yaml'), `a:\n  command: "printf a >> '${executed}'"\ngate:\n  approval: "Publish?"\nb:\n  command: "printf b >> '${executed}'"\n`);
  writeFileSync(graph, `graph_id: cli-tick-resume\nversion: 1\nentry_node: a\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: a, kind: agent, recipe: 'cmd:a', max_visits: 1 }\n  - { node_id: gate, kind: judge, recipe: 'approval:gate', max_visits: 1, notify: false }\n  - { node_id: b, kind: agent, recipe: 'cmd:b', max_visits: 1 }\n  - { node_id: done, kind: gate, max_visits: 1 }\n  - { node_id: failed, kind: gate, max_visits: 1 }\nedges:\n  - { from: a, to: gate }\n  - from: gate\n    on: outcome\n    map: { ok: b, fail: failed }\n  - { from: b, to: done }\n`);
  const started = await spawnGraphAt(stateRoot, dir, 'tick', graph, '--start', '--json');
  expect(started.code).toBe(0);
  const first = JSON.parse(started.stdout);
  expect(first).toMatchObject({ action: 'started', status: 'awaiting-approval' });
  const waiting = await spawnGraphAt(stateRoot, dir, 'tick', graph, '--start', '--json');
  expect(waiting.code).toBe(0);
  expect(JSON.parse(waiting.stdout)).toEqual({ action: 'waiting', runId: first.runId, status: 'awaiting-approval' });
  expect(readFileSync(executed, 'utf8')).toBe('a');
  expect((await spawnGraphAt(stateRoot, dir, 'approve', 'cli-tick-resume', first.runId)).code).toBe(0);
  const resumed = await spawnGraphAt(stateRoot, dir, 'tick', graph, '--json');
  expect(resumed.code).toBe(0);
  expect(JSON.parse(resumed.stdout)).toEqual({ action: 'resumed', runId: first.runId, status: 'done' });
  expect(readFileSync(executed, 'utf8')).toBe('ab');
}, 30000);

test('release graph approve resumes publish immediately and rejection takes restore route', async () => {
  const exercise = async (reject: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), 'graph-release-approve-continue-'));
    dirs.push(dir);
    const stateRoot = join(dir, 'state');
    const graphRoot = join(dir, 'graphs');
    const releaseDir = join(graphRoot, 'release');
    mkdirSync(releaseDir, { recursive: true });
    const graphPath = join(releaseDir, 'release-loop.yaml');
    writeFileSync(graphPath, `graph_id: release-loop
version: 1
entry_node: approve-publish
terminal_nodes: [done, failed]
nodes:
  - { node_id: approve-publish, kind: hitl, recipe: 'approval:publish', max_visits: 1 }
  - { node_id: publish, kind: git, recipe: 'cmd:publish-command', max_visits: 1 }
  - { node_id: traffic-failed-restore, kind: gate, recipe: 'cmd:traffic-failed-restore', max_visits: 1 }
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }
edges:
  - from: approve-publish
    on: outcome
    map: { ok: publish, fail: traffic-failed-restore }
  - from: publish
    on: outcome
    map: { ok: done, fail: traffic-failed-restore, error: traffic-failed-restore }
  - { from: traffic-failed-restore, on: outcome, map: { ok: failed, fail: failed, error: failed } }
`);
    writeFileSync(join(releaseDir, 'recipes.yaml'), `publish-command:
  command: 'bun scripts/release-loop/publish-node.ts'
  timeout_ms: 60000
traffic-failed-restore:
  command: 'bun scripts/release-loop/traffic-node.ts traffic-failed-restore'
  timeout_ms: 60000
publish:
  approval: 'v{{input.version}} 공개 발행 — 되돌릴 수 없다. 승인하시겠습니까?'
`);
    const commands: string[] = [];
    const runBash = async (command: string) => {
      commands.push(command);
      return { stdout: '{"outcome":"ok"}', stderr: '', exitCode: 0 };
    };
    const waiting = await runGraph(graphPath, { input: { version: '0.2.42' }, deps: { root: stateRoot, runBash } });
    expect(waiting).toMatchObject({ graphId: 'release-loop', status: 'awaiting-approval', path: ['approve-publish'] });
    const laterWaiting = await runGraph(graphPath, { input: { version: '0.2.42' }, deps: { root: stateRoot, runBash } });
    expect(laterWaiting.status).toBe('awaiting-approval');

    const program = new Command();
    program.exitOverride();
    registerGraphCommands(program, { root: stateRoot, graphRoots: [graphRoot], runBash });
    await program.parseAsync(['node', 'test', 'graph', 'approve', 'release-loop', waiting.runId,
      ...(reject ? ['--reject'] : [])]);
    const final = JSON.parse(readFileSync(waiting.statePath, 'utf8'));
    const laterFinal = JSON.parse(readFileSync(laterWaiting.statePath, 'utf8'));
    return { final, laterFinal, commands };
  };

  const approved = await exercise(false);
  expect(approved.final).toMatchObject({ status: 'done', path: expect.arrayContaining(['approve-publish', 'publish']) });
  expect(approved.laterFinal.status).toBe('awaiting-approval');
  expect(approved.commands).toContain('bun scripts/release-loop/publish-node.ts');

  const rejected = await exercise(true);
  expect(rejected.final).toMatchObject({ status: 'failed', path: expect.arrayContaining(['approve-publish', 'traffic-failed-restore']) });
  expect(rejected.laterFinal.status).toBe('awaiting-approval');
  expect(rejected.commands).toContain('bun scripts/release-loop/traffic-node.ts traffic-failed-restore');
  expect(rejected.commands).not.toContain('bun scripts/release-loop/publish-node.ts');
}, 60000);

test('graph tick rejects invalid input and inputs without --start before creating any run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-cli-tick-input-'));
  dirs.push(dir);
  const graph = join(dir, 'graph.yaml');
  writeFileSync(graph, 'unused');
  const stateRoot = join(dir, 'state');
  for (const args of [['--input', '{}'], ['--start', '--input', '{bad'], ['--start', '--input', '[]'], ['--start', '--input', 'null']]) {
    const result = await spawnGraphAt(stateRoot, dir, 'tick', graph, ...args);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`graph tick: ${args[0] === '--input' ? '--input requires --start' : '--input must be a JSON object'}`);
    expect(result.stdout).toBe('');
  }
  expect(existsSync(join(stateRoot, 'graph-runs'))).toBe(false);
}, 30000);

test('graph notify --dry-run prints the target events without sending or writing the ledger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-cli-notify-'));
  dirs.push(dir);
  const stateRoot = join(dir, 'state');
  const runDir = join(stateRoot, 'graph-runs', 'cli-notice');
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(dir, 'graphs'));
  writeFileSync(join(dir, 'graphs', 'notice.yaml'), 'graph_id: cli-notice\nnodes:\n  - { node_id: gate }\n');
  const statePath = join(runDir, 'run-1.json');
  const state = { graphId: 'cli-notice', runId: 'run-1', status: 'awaiting-approval', path: ['gate'], nodes: [],
    pending: { nodeId: 'gate', message: 'Publish now?', since: '2026-01-01T00:00:00Z' }, executed: 0, dryRun: false, statePath };
  writeFileSync(statePath, JSON.stringify(state));
  const before = readFileSync(statePath, 'utf8');
  const preview = await spawnGraphAt(stateRoot, dir, 'notify', '--dry-run');
  expect(preview.code).toBe(0);
  expect(preview.stdout).toContain('Publish now?');
  expect(preview.stdout).toContain('Approve: elanous graph approve cli-notice run-1');
  expect(preview.stdout).toContain('pending graph notifications: 1');
  expect(readFileSync(statePath, 'utf8')).toBe(before);
  expect(existsSync(join(stateRoot, 'graph-runs', 'notifications.jsonl'))).toBe(false);
  const repeated = await spawnGraphAt(stateRoot, dir, 'notify', '--dry-run');
  expect(repeated.stdout).toBe(preview.stdout);
}, 30000);

test('in-process CLI awaits approval, reports message, records decision and resumes without replay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-cli-approval-'));
  dirs.push(dir);
  const stateRoot = join(dir, 'state');
  const graph = join(dir, 'graph.yaml');
  writeFileSync(join(dir, 'recipes.yaml'), `a:\n  command: "printf a >> '${join(dir, 'executions')}'"\ngate:\n  approval: "Publish now?"\nb:\n  command: "printf b >> '${join(dir, 'executions')}'"\n`);
  writeFileSync(graph, `graph_id: cli-approval
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
  const first = await runGraphInProcess(stateRoot, 'run', graph, '--json');
  expect(first.code).toBe(0);
  const pending = JSON.parse(first.stdout);
  expect(pending).toMatchObject({ graphId: 'cli-approval', status: 'awaiting-approval', pending: { nodeId: 'gate', message: 'Publish now?' } });
  expect(readFileSync(join(dir, 'executions'), 'utf8')).toBe('a');
  const status = await runGraphInProcess(stateRoot, 'status', pending.graphId);
  expect(status.stdout).toContain('awaiting-approval');
  expect(status.stdout).toContain('Publish now?');
  const undecided = await runGraphInProcess(stateRoot, 'run', graph, '--resume', pending.runId, '--json');
  expect(JSON.parse(undecided.stdout).status).toBe('awaiting-approval');
  expect(readFileSync(join(dir, 'executions'), 'utf8')).toBe('a');
  const approved = await runGraphInProcess(stateRoot, 'approve', pending.graphId, pending.runId, '--by', 'operator');
  expect(approved.code).toBe(0);
  const duplicate = await runGraphInProcess(stateRoot, 'approve', pending.graphId, pending.runId);
  expect(duplicate.code).toBe(1);
  expect(duplicate.stderr).toContain('not awaiting an undecided approval');
  const resumed = await runGraphInProcess(stateRoot, 'run', graph, '--resume', pending.runId, '--json');
  expect(resumed.code).toBe(0);
  expect(JSON.parse(resumed.stdout)).toMatchObject({ status: 'done', runId: pending.runId, executed: 2 });
  expect(readFileSync(join(dir, 'executions'), 'utf8')).toBe('ab');
  const after = await runGraphInProcess(stateRoot, 'approve', pending.graphId, pending.runId);
  expect(after.code).toBe(1);
  expect(after.stderr).toContain('not awaiting');
  const rejectedFirst = await runGraphInProcess(stateRoot, 'run', graph, '--json');
  expect(rejectedFirst.code).toBe(0);
  const rejectedId = JSON.parse(rejectedFirst.stdout).runId as string;
  const rejection = await runGraphInProcess(stateRoot, 'approve', 'cli-approval', rejectedId, '--reject', '--by', 'reviewer');
  expect(rejection.code).toBe(0);
  const failed = await runGraphInProcess(stateRoot, 'run', graph, '--resume', rejectedId, '--json');
  expect(failed.code).toBe(1);
  expect(JSON.parse(failed.stdout).status).toBe('failed');
  expect(JSON.parse(failed.stdout).nodes[1]).toMatchObject({ nodeId: 'gate', ok: false, decidedBy: 'reviewer' });
  expect(readFileSync(join(dir, 'executions'), 'utf8')).toBe('aba');
  const unnamedFirst = await runGraphInProcess(stateRoot, 'run', graph, '--json');
  expect(unnamedFirst.code).toBe(0);
  const unnamedId = JSON.parse(unnamedFirst.stdout).runId as string;
  const unnamedApproval = await runGraphInProcess(stateRoot, 'approve', 'cli-approval', unnamedId);
  expect(unnamedApproval.code).toBe(0);
  const unnamedStatus = await runGraphInProcess(stateRoot, 'status', 'cli-approval', '--json');
  expect(unnamedStatus.code).toBe(0);
  expect(JSON.parse(unnamedStatus.stdout).pending).toMatchObject({ decision: 'approved' });
  expect(JSON.parse(unnamedStatus.stdout).pending).not.toHaveProperty('decidedBy');
  const unnamedResumed = await runGraphInProcess(stateRoot, 'run', graph, '--resume', unnamedId, '--json');
  expect(unnamedResumed.code).toBe(0);
  expect(JSON.parse(unnamedResumed.stdout).nodes[1]).toMatchObject({ nodeId: 'gate', ok: true });
  expect(JSON.parse(unnamedResumed.stdout).nodes[1]).not.toHaveProperty('decidedBy');
  expect(readFileSync(join(dir, 'executions'), 'utf8')).toBe('abaab');
}, 60000);

test('spawned graph run passes JSON object input to commands and status --json reads persisted outputs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-cli-dataflow-'));
  dirs.push(dir);
  const stateRoot = join(dir, 'state');
  const graph = join(dir, 'graph.yaml');
  writeFileSync(join(dir, 'recipes.yaml'), `first:\n  command: 'printf first-output'\nsecond:\n  command: 'cat "$ELANOUS_GRAPH_CONTEXT"'\n`);
  writeFileSync(graph, `graph_id: cli-dataflow
version: 1
entry_node: first
terminal_nodes: [done, failed]
nodes:
  - { node_id: first, kind: agent, recipe: 'cmd:first', max_visits: 1 }
  - { node_id: second, kind: agent, recipe: 'cmd:second', max_visits: 1 }
  - { node_id: done, kind: gate, max_visits: 1 }
  - { node_id: failed, kind: gate, max_visits: 1 }
edges:
  - { from: first, to: second }
  - { from: second, to: done }
`);
  const input = { request: 'hello', count: 2 };
  const run = await spawnGraph(stateRoot, 'run', graph, '--input', JSON.stringify(input), '--json');
  expect(run.code).toBe(0);
  const state = JSON.parse(run.stdout);
  expect(state).toMatchObject({ graphId: 'cli-dataflow', status: 'done', input, executed: 2 });
  expect(state.nodes[0]).toMatchObject({ nodeId: 'first', output: 'first-output' });
  expect(JSON.parse(state.nodes[1].output)).toMatchObject({ graphId: 'cli-dataflow', runId: state.runId, nodeId: 'second', input, outputs: { first: 'first-output' } });
  const persisted = JSON.parse(readFileSync(state.statePath, 'utf8'));
  expect(persisted.input).toEqual(input);
  expect(persisted.nodes.slice(0, 2).map((node: { output: unknown }) => node.output)).toEqual(state.nodes.slice(0, 2).map((node: { output: unknown }) => node.output));
  const status = await spawnGraph(stateRoot, 'status', 'cli-dataflow', '--json');
  expect(status.code).toBe(0);
  expect(JSON.parse(status.stdout)).toEqual(persisted);
}, 30000);

test('graph runs status exposes failed command exit and masked stderr reason only on failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-cli-failure-reason-'));
  dirs.push(dir);
  const stateRoot = join(dir, 'state');
  const pluginDir = join(stateRoot, 'plugins', 'local', 'sample-plugin', '1.0.0');
  const graphsDir = join(pluginDir, 'graphs');
  mkdirSync(graphsDir, { recursive: true });
  writeFileSync(join(pluginDir, 'plugin.ts'), 'export default {}');
  writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ id: 'sample-plugin', version: '1.0.0', main: './plugin.ts',
    contributes: { connectors: [{ id: 'service', fields: [{ name: 'KEY', env: 'SAMPLE_PLUGIN_KEY' }] }] } }));
  setPluginCredentials('sample-plugin', { KEY: 'cli-node-secret' }, stateRoot);
  const graph = join(graphsDir, 'graph.yaml');
  const graphSource = [
    'graph_id: cli-failure-reason', 'version: 1', 'entry_node: first', 'terminal_nodes: [done, failed]', 'nodes:',
    "  - { node_id: first, kind: agent, recipe: 'cmd:first', max_visits: 1 }",
    '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }',
    '  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }', 'edges:',
    '  - from: first', '    on: outcome', '    map: { ok: done, fail: failed }',
  ].join('\n') + '\n';
  writeFileSync(graph, graphSource);
  const recipesPath = join(graphsDir, 'recipes.yaml');
  writeFileSync(recipesPath, `first:\n  command: 'printf "failed with %s\\n" "$SAMPLE_PLUGIN_KEY" >&2; exit 7'\n`);

  const failed = await spawnGraphAt(stateRoot, dir, 'run', graph, '--json');
  expect(failed.code).toBe(1);
  const failedState = JSON.parse(failed.stdout);
  expect(failedState.nodes[0]).toMatchObject({ exit: 7, reason: 'failed with [REDACTED]' });
  expect(failed.stdout).not.toContain('cli-node-secret');
  const failedStatus = await spawnGraphAt(stateRoot, dir, 'runs', 'status', failedState.runId, '--json');
  expect(failedStatus.code).toBe(0);
  expect(JSON.parse(failedStatus.stdout).nodes[0]).toMatchObject({ nodeId: 'first', ok: false, exit: 7, reason: 'failed with [REDACTED]' });

  writeFileSync(recipesPath, `first:\n  command: 'printf "successful with %s\\n" "$SAMPLE_PLUGIN_KEY" >&2; exit 0'\n`);
  const successful = await spawnGraphAt(stateRoot, dir, 'run', graph, '--json');
  expect(successful.code).toBe(0);
  const successfulState = JSON.parse(successful.stdout);
  expect(successfulState.nodes[0]).toMatchObject({ exit: 0, ok: true });
  expect(successfulState.nodes[0]).not.toHaveProperty('reason');
  const successfulStatus = await spawnGraphAt(stateRoot, dir, 'runs', 'status', successfulState.runId, '--json');
  expect(successfulStatus.code).toBe(0);
  expect(JSON.parse(successfulStatus.stdout).nodes[0]).toMatchObject({ nodeId: 'first', ok: true, exit: 0 });
  expect(JSON.parse(successfulStatus.stdout).nodes[0]).not.toHaveProperty('reason');
});

test('CLI --resume --from restarts the failed path and writes progress only to stderr', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-cli-from-'));
  dirs.push(dir);
  const stateRoot = join(dir, 'state');
  const graph = join(dir, 'graph.yaml');
  const marker = join(dir, 'marker');
  writeFileSync(join(dir, 'recipes.yaml'), `first:\n  command: "printf a >> '${marker}'"\nsecond:\n  command: "test -f '${join(dir, 'ready')}' && printf b >> '${marker}'"\n`);
  writeFileSync(graph, `graph_id: cli-from\nversion: 1\nentry_node: first\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: first, kind: agent, recipe: 'cmd:first', max_visits: 1 }\n  - { node_id: second, kind: agent, recipe: 'cmd:second', max_visits: 1 }\n  - { node_id: done, kind: gate, max_visits: 1 }\n  - { node_id: failed, kind: gate, max_visits: 1 }\nedges:\n  - { from: first, to: second }\n  - from: second\n    on: outcome\n    map: { ok: done, fail: failed }\n`);
  const first = await spawnGraph(stateRoot, 'run', graph, '--json');
  expect(first.code).toBe(1);
  expect(first.stderr).toMatch(/\[graph\] first start \(0\.00s\)/);
  expect(first.stderr).toMatch(/\[graph\] second fail \([0-9.]+s\)/);
  const saved = JSON.parse(first.stdout);
  expect(saved.status).toBe('failed');
  expect(readFileSync(marker, 'utf8')).toBe('a');
  const invalid = await spawnGraph(stateRoot, 'run', graph, '--resume', saved.runId, '--from', 'absent', '--json');
  expect(invalid.code).toBe(1);
  expect(invalid.stderr).toContain('--from node');
  expect(readFileSync(marker, 'utf8')).toBe('a');
  writeFileSync(join(dir, 'ready'), 'yes');
  const resumed = await spawnGraph(stateRoot, 'run', graph, '--resume', saved.runId, '--from', 'second', '--json');
  expect(resumed.code).toBe(0);
  expect(resumed.stderr).toMatch(/\[graph\] second start \(0\.00s\)/);
  expect(resumed.stderr).toMatch(/\[graph\] second ok \([0-9.]+s\)/);
  expect(resumed.stderr).not.toContain('[graph] first start');
  expect(JSON.parse(resumed.stdout)).toMatchObject({ status: 'done', path: ['first', 'second', 'done'], resume: { from: 'second', previousStatus: 'failed' } });
  expect(readFileSync(marker, 'utf8')).toBe('ab');
  expect((await spawnGraph(stateRoot, 'run', graph, '--from', 'second')).stderr).toContain('--from requires --resume');
}, 30000);

test('spawned graph run rejects --input unless it is a JSON object before writing a run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-cli-invalid-input-'));
  dirs.push(dir);
  const stateRoot = join(dir, 'state');
  const graph = join(dir, 'graph.yaml');
  writeFileSync(graph, 'unused');
  for (const input of ['{bad', '[]', 'null', '42', '"text"']) {
    const run = await spawnGraph(stateRoot, 'run', graph, '--input', input, '--json');
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('graph run: --input must be a JSON object');
    expect(run.stdout).toBe('');
  }
  expect(existsSync(join(stateRoot, 'graph-runs'))).toBe(false);
}, 30000);

test('concurrent CLI approval and rejection claim only one immutable decision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-cli-race-'));
  dirs.push(dir);
  const stateRoot = join(dir, 'state');
  const graph = join(dir, 'graph.yaml');
  writeFileSync(join(dir, 'recipes.yaml'), 'gate:\n  approval: "Publish now?"\n');
  writeFileSync(graph, `graph_id: race-approval
version: 1
entry_node: gate
terminal_nodes: [done, failed]
nodes:
  - { node_id: gate, kind: judge, recipe: 'approval:gate', max_visits: 1 }
  - { node_id: done, kind: gate, max_visits: 1 }
  - { node_id: failed, kind: gate, max_visits: 1 }
edges:
  - from: gate
    on: outcome
    map: { ok: done, fail: failed }
`);
  const first = await spawnGraph(stateRoot, 'run', graph, '--json');
  expect(first.code).toBe(0);
  const pending = JSON.parse(first.stdout);
  expect(pending.status).toBe('awaiting-approval');
  const [approve, reject] = await Promise.all([
    simCli(['--test', stateRoot, 'graph', 'approve', pending.graphId, pending.runId, '--by', 'first'], {
      mode: 'spawn', allowPaths: [['graph', 'approve']], stateRoot, cwd: root,
    }),
    simCli(['--test', stateRoot, 'graph', 'approve', pending.graphId, pending.runId, '--reject', '--by', 'second'], {
      mode: 'spawn', allowPaths: [['graph', 'approve']], stateRoot, cwd: root,
    }),
  ]);
  const approvedCode = approve.exitCode;
  const rejectedCode = reject.exitCode;
  expect([approvedCode, rejectedCode].sort()).toEqual([0, 1]);
  const winner = approvedCode === 0 ? 'approved' : 'rejected';
  const winnerBy = approvedCode === 0 ? 'first' : 'second';
  const loserError = approvedCode === 0 ? reject.stderr : approve.stderr;
  expect(loserError).toContain('not awaiting an undecided approval');
  const status = await spawnGraph(stateRoot, 'status', pending.graphId, '--json');
  expect(JSON.parse(status.stdout).pending).toMatchObject({ decision: winner, decidedBy: winnerBy });
  expect((await spawnGraph(stateRoot, 'approve', pending.graphId, pending.runId, '--reject')).code).toBe(1);
  const resume = await spawnGraph(stateRoot, 'run', graph, '--resume', pending.runId, '--json');
  expect(JSON.parse(resume.stdout).status).toBe(winner === 'approved' ? 'done' : 'failed');
  expect(JSON.parse(resume.stdout).nodes[0]).toMatchObject({ ok: winner === 'approved', decidedBy: winnerBy });
}, 60000);

test('two spawned resumes cannot both execute the approved downstream command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-cli-resume-race-'));
  dirs.push(dir);
  const stateRoot = join(dir, 'state');
  const graph = join(dir, 'graph.yaml');
  const marker = join(dir, 'started');
  const count = join(dir, 'count');
  const release = join(dir, 'release');
  writeFileSync(join(dir, 'recipes.yaml'), `gate:\n  approval: "Publish?"\nb:\n  command: "touch '${marker}'; while [ ! -f '${release}' ]; do sleep 0.1; done; printf b >> '${count}'"\n`);
  writeFileSync(graph, `graph_id: resume-race
version: 1
entry_node: gate
terminal_nodes: [done, failed]
nodes:
  - { node_id: gate, kind: judge, recipe: 'approval:gate', max_visits: 1 }
  - { node_id: b, kind: agent, recipe: 'cmd:b', max_visits: 1 }
  - { node_id: done, kind: gate, max_visits: 1 }
  - { node_id: failed, kind: gate, max_visits: 1 }
edges:
  - from: gate
    on: outcome
    map: { ok: b, fail: failed }
  - { from: b, to: done }
`);
  const first = JSON.parse((await spawnGraph(stateRoot, 'run', graph, '--json')).stdout);
  expect(first.status).toBe('awaiting-approval');
  expect((await spawnGraph(stateRoot, 'approve', first.graphId, first.runId)).code).toBe(0);
  const firstResume = simCli(['--test', stateRoot, 'graph', 'run', graph, '--resume', first.runId, '--json'], {
    mode: 'spawn', allowPaths: [['graph', 'run']], stateRoot, cwd: root, timeoutMs: 30_000,
  });
  try {
    for (let i = 0; i < 100 && !existsSync(marker); i++) await Bun.sleep(50);
    expect(existsSync(marker)).toBe(true);
    const secondResume = await spawnGraph(stateRoot, 'run', graph, '--resume', first.runId, '--json');
    expect(secondResume.code).toBe(1);
    expect(secondResume.stderr).toContain('already being resumed');
  } finally {
    writeFileSync(release, 'go');
    await firstResume.catch(() => undefined);
  }
  const resumed = await firstResume;
  expect(resumed.exitCode).toBe(0);
  expect(JSON.parse(resumed.stdout).status).toBe('done');
  expect(readFileSync(count, 'utf8')).toBe('b');
}, 60000);

test('real CLI walks docs publication in dry-run mode without executing commands', async () => {
  const stateRoot = resolve(root, '.elanous-test');
  const proc = await simCli(['--test', 'graph', 'run', 'graphs/ops/docs-publish.yaml', '--dry-run', '--json'], {
    mode: 'spawn', allowPaths: [['graph', 'run']], stateRoot, cwd: root,
  });
  expect(proc.stderr).not.toContain('unknown command');
  expect(proc.exitCode).toBe(0);
  const state = JSON.parse(proc.stdout);
  expect(state.path).toEqual(['build', 'deploy', 'done']);
  expect(state.executed).toBe(0);
  expect(state.dryRun).toBe(true);
  const status = await simCli(['--test', 'graph', 'status', 'docs-publish', '--json'], {
    allowPaths: [['graph', 'status']], stateRoot, cwd: root,
  });
  expect(status.exitCode).toBe(0);
  expect(JSON.parse(status.stdout)).toMatchObject({ runId: state.runId, path: state.path, executed: 0 });
}, 30000);
