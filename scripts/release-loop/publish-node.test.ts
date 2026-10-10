import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as yaml } from 'yaml';
import { runAutoApprove, WARNING_ONLY } from './auto-approve-node.js';
import type { GraphContext } from './node-verdict.js';
import { runPublish, waitForAssets } from './publish-node.js';
import { enableLandingFreeze } from '../../src/release-loop/landing-freeze.js';
import { effectiveInstanceRoot, prodInstanceRoot, resetEffectiveInstanceRoot } from '../../src/instance/resolve.js';

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

test('publish accepts real auto-approve output with warning-only rows but rejects a missing blocking metric', () => {
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
      input: { version, previousVersion: '0.2.3' },
      outputs: {
        gate: { outcome: 'ok', introduced: [] },
        pwa: { outcome: 'ok' },
        upgrade: { outcome: 'ok' },
        tui: { outcome: 'ok', regress: { unmeasured: 'TUI probe timed out' } },
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
      .toEqual([['tui-regress', 'unmeasured'], ['mac-smoke', 'warn']]);
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

test('publish rechecks freeze immediately before irreversible publication; only force-freeze bypasses', async () => {
  const root = mkdtempSync(join(tmpdir(), 'publish-freeze-'));
  const previous = { state: process.env.ELANOUS_STATE_DIR, graph: process.env.ELANOUS_GRAPH_CONTEXT };
  const outputs = Object.fromEntries(['gate', 'pwa', 'upgrade', 'tui', 'prepare', 'docs'].map((name) => [name, { outcome: 'ok' }]));
  Object.assign(outputs, { 'approve-publish': { outcome: 'approved' }, prepare: { outcome: 'ok', commit: 'a', out: 'dist' }, 'version-release': { commit: 'a' }, docs: { outcome: 'ok', branch: 'release-docs/0.2.4' } });
  let publishCalls = 0;
  const run = (_command: string, args: string[]) => {
    if (args.includes('publish')) publishCalls++;
    return { status: 0, stdout: args.some((arg) => arg.endsWith('website/pages.json')) ? JSON.stringify({ pages: [] }) : args.includes('publish') ? JSON.stringify({ ok: true, published: true, tag: 'v0.2.4' }) : '# 0.2.4\nHello', stderr: '' };
  };
  try {
    process.env.ELANOUS_STATE_DIR = root;
    enableLandingFreeze({ reason: 'drill', by: 'MK' }, root);
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.4', previousVersion: '0.2.3' }, outputs });
    expect(runPublish(run, root)).toMatchObject({ outcome: 'fail', summary: expect.stringContaining('동결 중 · drill') });
    expect(publishCalls).toBe(0);
    // A frozen publication leaves no in-flight marker behind (so `freeze on` does not wait on it).
    const { inFlightLandingMerges } = await import('../../src/release-loop/landing-freeze.js');
    expect(inFlightLandingMerges(root)).toBe(0);
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.4', previousVersion: '0.2.3', forceFreeze: true }, outputs });
    expect(runPublish(run, root)).toMatchObject({ outcome: 'ok' });
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
    'auto-approve': { outcome: 'ok', decidedBy: 'release-loop metrics', metrics: Array.from({ length: 8 }, (_, i) => ({ name: `metric-${i}`, verdict: 'pass' })) },
    'version-release': { commit }, gate: { outcome: 'ok' }, pwa: { outcome: 'ok' }, upgrade: { outcome: 'ok' }, tui: { outcome: 'ok' },
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
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version, previousVersion: '0.2.3', ...(publishAt ? { publishAt } : {}) },
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
