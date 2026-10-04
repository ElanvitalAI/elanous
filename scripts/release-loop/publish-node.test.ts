import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAutoApprove, WARNING_ONLY } from './auto-approve-node.js';
import type { GraphContext } from './node-verdict.js';
import { runPublish, waitForAssets } from './publish-node.js';
import { enableLandingFreeze } from '../../src/release-loop/landing-freeze.js';

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
    expect(runPublish(run)).toMatchObject({ outcome: 'ok', verdict: 'pass', tag: `v${version}` });
    expect(calls.some((call) => call.startsWith('bun bin/elanous.mjs release publish '))).toBe(true);

    const missing = auto.metrics.find((metric) => !WARNING_ONLY.has(metric.name))!;
    context.outputs['auto-approve'] = { ...auto, metrics: auto.metrics.filter((metric) => metric !== missing) };
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify(context);
    calls.length = 0;
    expect(runPublish(run)).toMatchObject({ outcome: 'fail', summary: 'publish blocked: neither auto-approve nor approve-publish approved' });
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
    expect(runPublish(run)).toMatchObject({ outcome: 'fail', summary: expect.stringContaining('동결 중 · drill') });
    expect(publishCalls).toBe(0);
    // A frozen publication leaves no in-flight marker behind (so `freeze on` does not wait on it).
    const { inFlightLandingMerges } = await import('../../src/release-loop/landing-freeze.js');
    expect(inFlightLandingMerges(root)).toBe(0);
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.4', previousVersion: '0.2.3', forceFreeze: true }, outputs });
    expect(runPublish(run)).toMatchObject({ outcome: 'ok' });
    expect(publishCalls).toBe(1);
  } finally {
    if (previous.state === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previous.state;
    if (previous.graph === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = previous.graph;
    rmSync(root, { recursive: true, force: true });
  }
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
