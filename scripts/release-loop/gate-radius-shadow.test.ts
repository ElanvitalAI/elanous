import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planGateRadiusShadow, shadowActual, writeGateRadiusShadow } from './gate-radius-shadow';
import { createGateRunner, judgeGate } from './gate-node';

const roots: string[] = [];
setDefaultTimeout(60_000);
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(seedPrior = true) {
  const repo = mkdtempSync(join(tmpdir(), 'gate-radius-shadow-'));
  roots.push(repo);
  const git = (...args: string[]) => {
    const run = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (run.status !== 0) throw new Error(run.stderr);
    return run.stdout.trim();
  };
  git('init', '-q'); git('config', 'user.email', 'tc@test'); git('config', 'user.name', 'TC');
  mkdirSync(join(repo, 'src')); mkdirSync(join(repo, 'release/1.0.0'), { recursive: true });
  mkdirSync(join(repo, 'apps/pwa'), { recursive: true });
  writeFileSync(join(repo, 'apps/pwa/package.json'), '{"name":"shadow-pwa","private":true}\n');
  writeFileSync(join(repo, 'package.json'), '{"name":"shadow-fixture","version":"1.0.0","scripts":{"test:deterministic":"bun test"}}\n');
  writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1;\n');
  for (const name of ['a', 'b', 'c', 'd', 'e']) writeFileSync(join(repo, `src/${name}.test.ts`),
    name === 'a' ? "import { a } from './a'; test('a', () => a);\n"
      : name === 'c' ? "test('c', () => { if (process.env.GATE_SHADOW_C_FAILURE === '1' && require('../package.json').version === '1.0.1') throw new Error('shadow miss'); });\n"
        : `test('${name}', () => 1);\n`);
  git('add', '.'); git('commit', '-qm', 'prior gate');
  const priorCommit = git('rev-parse', 'HEAD');
  const ledgerRoot = mkdtempSync(join(tmpdir(), 'gate-radius-shadow-ledger-'));
  roots.push(ledgerRoot);
  mkdirSync(join(ledgerRoot, 'release/1.0.0'), { recursive: true });
  writeFileSync(join(ledgerRoot, 'release/1.0.0/release.json'), JSON.stringify({ sourceCommit: priorCommit }));
  if (seedPrior) {
    writeFileSync(join(ledgerRoot, 'release/1.0.0/gate-verdict.json'), JSON.stringify({ commit: priorCommit, outcome: 'ok' }));
    writeFileSync(join(ledgerRoot, 'release/1.0.0/gate-failures.json'), JSON.stringify({ commit: priorCommit, failures: [], errors: [] }));
  }
  writeFileSync(join(repo, 'src/a.ts'), 'export const a = 2;\n');
  writeFileSync(join(repo, 'package.json'), '{"name":"shadow-fixture","version":"1.0.1","scripts":{"test:deterministic":"bun test"}}\n');
  git('add', '.'); git('commit', '-qm', 'new cut');
  return { repo, ledgerRoot, priorCommit, forCommit: git('rev-parse', 'HEAD') };
}

test('RELEASE-GATE-RADIUS-SHADOW records a proposed import radius beside the unchanged full result', () => {
  const source = fixture();
  const plan = planGateRadiusShadow({ ...source, version: '1.0.1', baselineVersion: '1.0.0' });
  expect(plan).toMatchObject({ proposed: 'partial', files: ['src/a.test.ts'], totalTests: 5 });
  const actual = shadowActual({ plan, outcome: 'regression', introduced: ['src/a.test.ts > A', 'src/c.test.ts > C'],
    cutFailures: ['src/a.test.ts > A', 'src/c.test.ts > C'], cutErrors: [], cutRc: 1, fullSweep: true });
  expect(actual.missedIntroduced).toEqual(['src/c.test.ts > C']);
  const path = writeGateRadiusShadow(source.ledgerRoot, { plan, actual, recordedAt: new Date().toISOString() });
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ plan: { proposed: 'partial' },
    actual: { fullSweep: true, missedIntroduced: ['src/c.test.ts > C'] } });
  expect(readdirSync(join(source.ledgerRoot, 'release/1.0.1')).filter((name) => name.startsWith('gate-radius-shadow-'))).toHaveLength(1);
});

test('RELEASE-GATE-RADIUS-SHADOW missing prior evidence proposes full without authorizing reuse', () => {
  const source = fixture();
  rmSync(join(source.ledgerRoot, 'release/1.0.0/gate-failures.json'));
  expect(planGateRadiusShadow({ ...source, version: '1.0.1', baselineVersion: '1.0.0' }))
    .toMatchObject({ proposed: 'full', files: [], totalTests: null });
});

test('RELEASE-GATE-RADIUS-SHADOW rejects gate evidence for a different prior release commit', () => {
  const source = fixture();
  writeFileSync(join(source.ledgerRoot, 'release/1.0.0/release.json'),
    JSON.stringify({ sourceCommit: source.forCommit }));
  expect(planGateRadiusShadow({ ...source, version: '1.0.1', baselineVersion: '1.0.0' }))
    .toMatchObject({ proposed: 'full', reason: 'prior gate commit differs from release source' });
});

test('RELEASE-GATE-RADIUS-SHADOW rejects conflicting ledger and instance release commits', () => {
  const source = fixture();
  const instanceRoot = mkdtempSync(join(tmpdir(), 'gate-radius-shadow-instance-'));
  roots.push(instanceRoot);
  mkdirSync(join(instanceRoot, 'release/1.0.0'), { recursive: true });
  writeFileSync(join(instanceRoot, 'release/1.0.0/release.json'),
    JSON.stringify({ sourceCommit: source.forCommit }));
  expect(planGateRadiusShadow({ ...source, instanceRoot, version: '1.0.1', baselineVersion: '1.0.0' }))
    .toMatchObject({ proposed: 'full', reason: 'prior gate commit differs from release source' });
});

test('RELEASE-GATE-RADIUS-SHADOW proposed partial still runs the complete cut sweep', async () => {
  const source = fixture(false);
  const instanceRoot = mkdtempSync(join(tmpdir(), 'gate-radius-shadow-instance-'));
  roots.push(instanceRoot);
  mkdirSync(join(instanceRoot, 'release/0.9.9'), { recursive: true });
  writeFileSync(join(instanceRoot, 'release/0.9.9/release.json'), JSON.stringify({ sourceCommit: source.priorCommit }));
  mkdirSync(join(instanceRoot, 'release/1.0.0'), { recursive: true });
  writeFileSync(join(instanceRoot, 'release/1.0.0/release.json'), JSON.stringify({ sourceCommit: source.priorCommit }));
  const selections: Array<{ tree: string; only?: readonly string[] }> = [];
  const runner = createGateRunner(source.repo);
  const realSweep = runner.sweep.bind(runner);
  runner.sweep = async (tree, log, pod, only) => {
      selections.push({ tree, only });
      return realSweep(tree, log, pod, only);
  };
  const priorResult = await judgeGate({ repo: source.repo, commit: source.priorCommit, version: '1.0.0',
    baselineVersion: '0.9.9', instanceRoot, ledgerRoot: source.ledgerRoot }, runner);
  expect(priorResult.outcome, JSON.stringify(priorResult)).toBe('ok');
  for (const root of [instanceRoot, source.ledgerRoot]) {
    expect(JSON.parse(readFileSync(join(root, 'release/1.0.0/gate-verdict.json'), 'utf8')))
      .toMatchObject({ commit: source.priorCommit, outcome: 'ok' });
    expect(JSON.parse(readFileSync(join(root, 'release/1.0.0/gate-failures.json'), 'utf8')))
      .toMatchObject({ commit: source.priorCommit, failures: [] });
  }
  const result = await judgeGate({ repo: source.repo, commit: source.forCommit, version: '1.0.1',
    baselineVersion: '1.0.0', instanceRoot, ledgerRoot: source.ledgerRoot }, runner);
  expect(result.outcome).toBe('ok');
  expect(selections.filter((selection) => selection.tree.endsWith('/cut')).at(-1)?.only).toBeUndefined();
  const files = readdirSync(join(source.ledgerRoot, 'release/1.0.1')).filter((name) => name.startsWith('gate-radius-shadow-'));
  expect(files).toHaveLength(1);
  const shadow = JSON.parse(readFileSync(join(source.ledgerRoot, 'release/1.0.1', files[0]!), 'utf8'));
  expect(shadow).toMatchObject({ plan: { proposed: 'partial', files: ['src/a.test.ts'] },
    actual: { outcome: 'ok', fullSweep: true } });
  process.env.GATE_SHADOW_C_FAILURE = '1';
  const priorSelections = selections.length;
  let failureResult: Awaited<ReturnType<typeof judgeGate>>;
  try {
    failureResult = await judgeGate({ repo: source.repo, commit: source.forCommit, version: '1.0.1',
      baselineVersion: '1.0.0', instanceRoot, ledgerRoot: source.ledgerRoot }, runner);
  } finally { delete process.env.GATE_SHADOW_C_FAILURE; }
  expect(failureResult).toMatchObject({ outcome: 'regression', introduced: ['src/c.test.ts > c'] });
  expect(selections.slice(priorSelections).find((selection) => selection.tree.endsWith('/cut'))?.only).toBeUndefined();
  const later = readdirSync(join(source.ledgerRoot, 'release/1.0.1'))
    .filter((name) => name.startsWith('gate-radius-shadow-'))
    .map((name) => JSON.parse(readFileSync(join(source.ledgerRoot, 'release/1.0.1', name), 'utf8')));
  expect(later).toHaveLength(2);
  expect(later.find((record) => record.actual.outcome === 'regression'))
    .toMatchObject({ plan: { files: ['src/a.test.ts'] }, actual: { fullSweep: true,
      missedIntroduced: ['src/c.test.ts > c'] } });
});

test('RELEASE-GATE-RADIUS-SHADOW does not call an anomalous cut a complete comparison', async () => {
  const source = fixture();
  const instanceRoot = mkdtempSync(join(tmpdir(), 'gate-radius-shadow-anomaly-'));
  roots.push(instanceRoot);
  mkdirSync(join(instanceRoot, 'release/1.0.0'), { recursive: true });
  writeFileSync(join(instanceRoot, 'release/1.0.0/release.json'), JSON.stringify({ sourceCommit: source.priorCommit }));
  const runner = createGateRunner(source.repo);
  const realSweep = runner.sweep.bind(runner);
  runner.sweep = async (tree, log, pod, only) => {
    const run = await realSweep(tree, log, pod, only);
    return tree.endsWith('/cut') ? { ...run, rc: 3 } : run;
  };
  const result = await judgeGate({ repo: source.repo, commit: source.forCommit, version: '1.0.1',
    baselineVersion: '1.0.0', instanceRoot, ledgerRoot: source.ledgerRoot }, runner);
  const files = readdirSync(join(source.ledgerRoot, 'release/1.0.1')).filter((name) => name.startsWith('gate-radius-shadow-'));
  expect(files).toHaveLength(1);
  const shadow = JSON.parse(readFileSync(join(source.ledgerRoot, 'release/1.0.1', files[0]!), 'utf8'));
  expect(shadow.actual, JSON.stringify({ result, shadow })).toMatchObject({ cutRc: 3, fullSweep: false,
    comparison: 'unmeasured' });
  expect(shadow.actual.missedIntroduced).toEqual([]);
});
