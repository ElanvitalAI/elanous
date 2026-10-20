import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as yaml } from 'yaml';
import { LogStore } from '../../src/mss/logging/log-store.js';
import { BLOCKING_METRIC_NAMES, runAutoApprove, WARNING_ONLY } from './auto-approve-node.js';
import type { GraphContext } from './node-verdict.js';
import { runPublish, waitForAssets } from './publish-node.js';
import { enableLandingFreeze } from '../../src/release-loop/landing-freeze.js';
import { effectiveInstanceRoot, prodInstanceRoot, resetEffectiveInstanceRoot } from '../../src/instance/resolve.js';

function recordApproval(root: string, runId: string, decidedAt: string) {
  const path = join(root, 'graph-runs', 'release-loop', `${runId}.json`);
  const approval = { outcome: 'approved', graphId: 'release-loop', runId, nodeId: 'approve-publish', decidedAt };
  mkdirSync(join(root, 'graph-runs', 'release-loop'), { recursive: true });
  writeFileSync(path, JSON.stringify({ graphId: 'release-loop', runId,
    path: ['auto-approve', 'approve-publish', 'publish'],
    nodes: [{ nodeId: 'approve-publish', ok: true, decidedAt, output: JSON.stringify(approval) }] }));
  writeFileSync(`${path}.2.decision.json`, JSON.stringify({ nodeId: 'approve-publish', decision: 'approved', decidedAt }));
  return approval;
}

// The local freeze universe is isolated too (runPublish → beginLandingMerge reads effectiveInstanceRoot()).
let isolatedStateDir = '';
let savedStateDir: string | undefined;
beforeEach(() => {
  isolatedStateDir = mkdtempSync(join(tmpdir(), 'publish-node-state-'));
  savedStateDir = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = isolatedStateDir;
  resetEffectiveInstanceRoot();
  expect(effectiveInstanceRoot()).not.toBe(prodInstanceRoot());
});
afterEach(() => {
  if (savedStateDir === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = savedStateDir;
  resetEffectiveInstanceRoot();
  rmSync(isolatedStateDir, { recursive: true, force: true });
});

const runner = (answers: Record<string, string[]>) => {
  const calls: string[] = [];
  const run = (_command: string, args: readonly string[]) => {
    const url = args.at(-1)!;
    const name = url.split('/').at(-1)!;
    calls.push(name);
    const queue = answers[name]!;
    return { status: 0, stdout: queue.length > 1 ? queue.shift()! : queue[0]!, stderr: '' };
  };
  return { run, calls };
};

test('publish accepts measured TUI subchecks and mac warning, but rejects a missing blocking metric', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-publish-auto-'));
  const previousContext = process.env.ELANOUS_GRAPH_CONTEXT;
  try {
    const version = '0.2.4';
    const repo = join(root, 'repo');
    const out = join(root, 'release', version, 'prepared');
    mkdirSync(join(out, 'dist'), { recursive: true });
    mkdirSync(repo);
    writeFileSync(join(repo, '.bun-version'), `${Bun.version}\n`);
    for (let n = 0; n < 5; n++) writeFileSync(join(out, 'dist', `file-${n}`), 'fixture');
    const commit = 'a'.repeat(40);
    const context: GraphContext = {
      nodeId: 'publish',
      runId: 'run-publish-subcheck',
      input: { version, previousVersion: '0.2.3' },
      outputs: {
        gate: { outcome: 'ok', introduced: [] },
        pwa: { outcome: 'ok' },
        upgrade: { outcome: 'ok' },
        tui: { outcome: 'ok', regress: { pass: 7, fail: 0,
          results: Array.from({ length: 7 }, (_, i) => ({ id: `R${i + 1}`, title: 'check', ok: true, reason: 'passed' })) } },
        'notes-check': { outcome: 'ok' },
        prepare: { outcome: 'ok', out, commit },
        'version-release': { commit },
        docs: { outcome: 'ok', notes: 'release notes', branch: `release-docs/${version}` },
        'mac-smoke': { outcome: 'fail', summary: 'macOS smoke failed' },
      },
    };
    const auto = runAutoApprove(context, { instanceRoot: root, repo });
    expect(auto).toMatchObject({ outcome: 'ok', decidedBy: 'release-loop metrics' });
    expect(auto.metrics).toHaveLength(10);
    expect(auto.metrics.filter((metric) => !WARNING_ONLY.has(metric.name))).toHaveLength(8);
    expect(auto.metrics.filter((metric) => WARNING_ONLY.has(metric.name)).map((metric) => [metric.name, metric.value]))
      .toEqual([['tui-regress', 'ok'], ['mac-smoke', 'warn']]);
    context.outputs['auto-approve'] = auto;
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify(context);
    const calls: string[] = [];
    const run = (command: string, args: string[]) => {
      calls.push(`${command} ${args.join(' ')}`);
      if (command === 'git' && args[0] === 'show') {
        return { status: 0, stdout: args[1]?.endsWith('website/pages.json')
          ? JSON.stringify({ pages: [] }) : `# ${version}\n\nInternal release notes.\n`, stderr: '' };
      }
      if (command === 'bun' && args.includes('publish')) {
        return { status: 0, stdout: JSON.stringify({ ok: true, published: true, tag: `v${version}`, assets: [] }), stderr: '' };
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    };
    expect(runPublish(run, root)).toMatchObject({ outcome: 'ok', verdict: 'pass', tag: `v${version}` });
    expect(calls.some((call) => call.startsWith('bun bin/elanous.mjs release publish '))).toBe(true);

    for (const foreign of [
      { ...auto, runId: 'another-run' },
      { ...auto, tuiSubcheck: { ...auto.tuiSubcheck, fail: 3, failedCheckIds: ['R4'], approvalRequired: true } },
      { ...auto, metrics: auto.metrics.map((metric, i) => i === 0 ? { ...metric, name: 'metric-0' } : metric) },
      { ...auto, metrics: auto.metrics.map((metric, i) => i === 1 ? { ...metric, name: auto.metrics[0]!.name } : metric) },
    ]) {
      context.outputs['auto-approve'] = foreign;
      process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify(context);
      calls.length = 0;
      expect(runPublish(run, root)).toMatchObject({ outcome: 'fail' });
      expect(calls).toEqual([]);
    }
    context.outputs['auto-approve'] = auto;

    const results = (context.outputs.tui!.regress as { results: Array<{ id: string; ok: boolean }> }).results;
    context.outputs.tui!.regress = { pass: 4, fail: 3,
      results: results.map((result) => ({ ...result, ok: !['R4', 'R5', 'R6'].includes(result.id) })) };
    const subcheck = runAutoApprove(context, { instanceRoot: root, repo });
    expect(subcheck).toMatchObject({ outcome: 'fail',
      tuiSubcheck: { fail: 3, failedCheckIds: ['R4', 'R5', 'R6'], approvalRequired: true } });
    context.outputs['auto-approve'] = subcheck;
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify(context);
    calls.length = 0;
    expect(runPublish(run, root)).toMatchObject({ outcome: 'fail', summary: 'publish blocked: neither auto-approve nor approve-publish approved' });
    expect(calls).toEqual([]);
    context.outputs['approve-publish'] = { outcome: 'approved', decisionBy: 'human' };
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify(context);
    expect(runPublish(run, root)).toMatchObject({ outcome: 'fail', summary: 'publish blocked: neither auto-approve nor approve-publish approved' });
    expect(calls).toEqual([]);
    context.outputs['approve-publish'] = { outcome: 'approved', graphId: 'release-loop', runId: context.runId,
      nodeId: 'approve-publish', decidedAt: new Date().toISOString(), decidedBy: 'human' };
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify(context);
    expect(runPublish(run, root)).toMatchObject({ outcome: 'fail' });
    expect(calls).toEqual([]);
    delete context.outputs['approve-publish'];
    context.outputs.tui!.regress = { pass: 7, fail: 0, results };

    const missing = auto.metrics.find((metric) => !WARNING_ONLY.has(metric.name))!;
    context.outputs['auto-approve'] = { ...auto, metrics: auto.metrics.filter((metric) => metric !== missing) };
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify(context);
    calls.length = 0;
    expect(runPublish(run, root)).toMatchObject({ outcome: 'fail', summary: 'publish blocked: neither auto-approve nor approve-publish approved' });
    expect(calls).toEqual([]);
  } finally {
    if (previousContext === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
    else process.env.ELANOUS_GRAPH_CONTEXT = previousContext;
    rmSync(root, { recursive: true, force: true });
  }
});

test('publish refuses a graph context for any other node before invoking a command', () => {
  const previous = process.env.ELANOUS_GRAPH_CONTEXT;
  let calls = 0;
  const run = () => { calls++; throw new Error('publish command must not run'); };
  try {
    for (const nodeId of ['npm-publish', 'docs-land', 'failed', undefined]) {
      process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ nodeId,
        input: { version: '0.2.27', previousVersion: '0.2.26' }, outputs: {} });
      expect(() => runPublish(run)).toThrow(`publish node context mismatch: expected publish, got ${nodeId ?? 'missing'}`);
    }
    expect(calls).toBe(0);
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
    else process.env.ELANOUS_GRAPH_CONTEXT = previous;
  }
});

test('publish rechecks freeze immediately before irreversible publication; only force-freeze bypasses', async () => {
  const root = mkdtempSync(join(tmpdir(), 'publish-freeze-'));
  const previous = { state: process.env.ELANOUS_STATE_DIR, graph: process.env.ELANOUS_GRAPH_CONTEXT };
  const outputs = Object.fromEntries(['gate', 'pwa', 'upgrade', 'tui', 'prepare', 'docs'].map((name) => [name, { outcome: 'ok' }]));
  Object.assign(outputs, { 'approve-publish': recordApproval(root, 'run-freeze', new Date().toISOString()),
    prepare: { outcome: 'ok', commit: 'a', out: 'dist' }, 'version-release': { commit: 'a' }, docs: { outcome: 'ok', branch: 'release-docs/0.2.4' } });
  let publishCalls = 0;
  const run = (_command: string, args: string[]) => {
    if (args.includes('publish')) publishCalls++;
    return { status: 0, stdout: args.some((arg) => arg.endsWith('website/pages.json')) ? JSON.stringify({ pages: [] }) : args.includes('publish') ? JSON.stringify({ ok: true, published: true, tag: 'v0.2.4' }) : '# 0.2.4\nHello', stderr: '' };
  };
  try {
    process.env.ELANOUS_STATE_DIR = root;
    enableLandingFreeze({ reason: 'drill', by: 'MK' }, root);
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ nodeId: 'publish', runId: 'run-freeze', input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs });
    expect(runPublish(run, root, undefined, root)).toMatchObject({ outcome: 'fail', summary: expect.stringContaining('동결 중 · drill') });
    expect(publishCalls).toBe(0);
    // A frozen publication leaves no in-flight marker behind (so `freeze on` does not wait on it).
    const { inFlightLandingMerges } = await import('../../src/release-loop/landing-freeze.js');
    expect(inFlightLandingMerges(root)).toBe(0);
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ nodeId: 'publish', runId: 'run-freeze', input: { version: '0.2.4', previousVersion: '0.2.3', forceFreeze: true }, outputs });
    expect(runPublish(run, root, undefined, root)).toMatchObject({ outcome: 'ok' });
    expect(publishCalls).toBe(1);
  } finally {
    if (previous.state === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previous.state;
    if (previous.graph === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = previous.graph;
    rmSync(root, { recursive: true, force: true });
  }
});

test('publish-at waits after measured auto-approval and prerequisites; omission and past deadlines publish immediately', () => {
  const root = mkdtempSync(join(tmpdir(), 'publish-deadline-'));
  const previous = process.env.ELANOUS_GRAPH_CONTEXT;
  const version = '0.2.4';
  const commit = 'a'.repeat(40);
  const outputs: GraphContext['outputs'] = {
    'auto-approve': { outcome: 'ok', runId: 'run-deadline', decidedBy: 'release-loop metrics',
      tuiSubcheck: { runId: 'run-deadline', level: 'ok', fail: 0, failedCheckIds: [], approvalRequired: false },
      metrics: [...BLOCKING_METRIC_NAMES.map((name) => ({ name, verdict: 'pass' })),
        { name: 'tui-regress', verdict: 'pass' }, { name: 'mac-smoke', verdict: 'pass' }] },
    'version-release': { commit }, gate: { outcome: 'ok' }, pwa: { outcome: 'ok' }, upgrade: { outcome: 'ok' },
    tui: { outcome: 'ok', regress: { pass: 7, fail: 0,
      results: Array.from({ length: 7 }, (_, i) => ({ id: `R${i + 1}`, title: 'check', ok: true, reason: 'measured' })) } },
    prepare: { outcome: 'ok', commit, out: root }, docs: { outcome: 'ok', branch: `release-docs/${version}` },
  };
  let now = Date.parse('2099-10-09T10:59:00Z');
  const sleeps: number[] = [];
  const calls: string[] = [];
  const publishTimeouts: Array<number | undefined> = [];
  const run = (command: string, args: string[], _cwd?: string, timeoutMs?: number) => {
    calls.push(`${command} @ ${now}`);
    if (command === 'bun') publishTimeouts.push(timeoutMs);
    return { status: 0, stderr: '', stdout: command === 'git'
      ? args[1]?.endsWith('pages.json') ? '{"pages":[]}' : `# ${version}\n\nBody\n`
      : JSON.stringify({ ok: true, published: true, tag: `v${version}` }) };
  };
  const clock = { now: () => now, sleep: (ms: number) => { sleeps.push(ms); now += ms; } };
  const publish = (publishAt?: string, authorized = true) => {
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ nodeId: 'publish', runId: 'run-deadline', input: { version, previousVersion: '0.2.3', ...(publishAt ? { publishAt } : {}) },
      outputs: authorized ? outputs : { ...outputs, 'auto-approve': { outcome: 'fail' } } });
    calls.length = 0;
    sleeps.length = 0;
    return runPublish(run, root, clock);
  };
  try {
    expect(publish('2099-10-09T20:00+09:00')).toMatchObject({ outcome: 'ok', tag: `v${version}` });
    expect(sleeps).toEqual([60_000]);
    expect(publishTimeouts).toEqual([1_800_000]);
    expect(calls).toEqual([`git @ ${Date.parse('2099-10-09T10:59:00Z')}`, `git @ ${Date.parse('2099-10-09T10:59:00Z')}`, `bun @ ${Date.parse('2099-10-09T11:00:00Z')}`]);
    const unchanged = publish();
    expect(unchanged).toEqual({ outcome: 'ok', verdict: 'pass', summary: `published v${version} · 0 assets downloadable`, tag: `v${version}` });
    expect(sleeps).toEqual([]);
    expect(publishTimeouts).toEqual([1_800_000, 1_800_000]);
    expect(calls.at(-1)).toBe(`bun @ ${now}`);
    expect(publish('2099-10-09T10:58:00Z').outcome).toBe('ok');
    expect(sleeps).toEqual([]);
    expect(publish('2099-10-09T11:01:00Z', false).outcome).toBe('fail');
    expect(calls).toEqual([]);
    expect(sleeps).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('the release graph publish command can outlive the scheduled wait; the inner publish remains bounded', () => {
  const recipes = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/recipes.yaml'), 'utf8')) as Record<string, { command?: string; timeout_ms?: number }>;
  expect(recipes['publish-command']?.command).toBe('bun scripts/release-loop/publish-node.ts');
  expect(recipes['publish-command']?.timeout_ms).toBeUndefined();
});

test('REL3: waits while an asset is not served yet, then reports none pending', () => {
  const { run } = runner({ 'install.sh': ['404', '404', '200'], 'elanous.tgz': ['200'] });
  const sleeps: number[] = [];
  expect(waitForAssets(run as never, 'ElanvitalAI/elanous', 'v0.2.8', ['install.sh', 'elanous.tgz'], 600, (ms) => sleeps.push(ms))).toEqual([]);
  expect(sleeps).toEqual([15_000, 15_000]);
});

test('REL3: an asset that never appears within the wait is returned as pending (publish must not say ok)', () => {
  const { run } = runner({ 'install.sh': ['404'], 'elanous.tgz': ['200'] });
  expect(waitForAssets(run as never, 'ElanvitalAI/elanous', 'v0.2.8', ['install.sh', 'elanous.tgz'], 30, () => {})).toEqual(['install.sh']);
});

test('REL3: probes the public download URL for the tag', () => {
  const urls: string[] = [];
  const run = (_c: string, args: readonly string[]) => { urls.push(args.at(-1)!); return { status: 0, stdout: '200', stderr: '' }; };
  waitForAssets(run as never, 'ElanvitalAI/elanous', 'v0.2.8', ['SHA256SUMS'], 0, () => {});
  expect(urls).toEqual(['https://github.com/ElanvitalAI/elanous/releases/download/v0.2.8/SHA256SUMS']);
});

// GATE-OBS2-2 — the release graph runs publish as its own process; that child inherits no daemon sink, so without
// registerStandaloneLogSink its `release-loop.publish / result` event (whether the irreversible publication happened)
// stays in the file trail and `elanous logs` reads 0 rows. Same proof shape as gate-node-log-sink.test.ts.
test('a publish process spawned like the graph does writes release-loop.publish events to its own logs.db', () => {
  const REPO = resolve(import.meta.dir, '../..');
  const root = mkdtempSync(join(tmpdir(), 'publish-node-log-sink-'));
  const env: Record<string, string | undefined> = { ...process.env, HOME: root, ELANOUS_STATE_DIR: root, ELANOUS_CONFIG_DIR: root };
  delete env.ELANOUS_GRAPH_CONTEXT;
  // NODE_ENV=test turns the default store off; the graph child runs without it, and the state dir above keeps it isolated.
  delete env.NODE_ENV;
  try {
    const run = spawnSync('bun', ['scripts/release-loop/publish-node.ts'], { cwd: REPO, env, encoding: 'utf8', timeout: 50_000 });
    // Invalid input is the cheap path: no publication side effects, but the final `result` event is still logged.
    expect(run.status).toBe(2);
    const lines = run.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).outcome).toBe('error');
    const dbPath = join(root, 'logs', 'logs.db');
    expect(existsSync(dbPath)).toBe(true);
    const store = LogStore.openReadOnly(dbPath);
    try {
      const rows = store.query({ exactCategories: ['release-loop.publish'] });
      expect(rows.map((row) => row.event)).toContain('result');
      expect(rows.every((row) => row.surface === 'release-loop')).toBe(true);
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
