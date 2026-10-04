import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateRunner, GATE_NIGHTLY_AUDITS, POD_SWEEP_INTEGRATION_ONLY } from '../scripts/release-loop/gate-node.js';
import { PodPoolScheduler } from '../src/task-orchestrator/surfaces/pod-pool.js';
import { deriveCdpTestPatterns } from '../scripts/test-deterministic.js';

const repo = join(import.meta.dir, '..');
// Baseline 0826c0c436025104ab4955a73fa11d93520f0ba0: CDP exclusions among the TSV gate-out candidates.
// Do not derive this expectation from the current tree: a newly excluded guarded file must fail the Pod assignment check.
const BASELINE_CDP_EXCLUSIONS = [
  'scripts/webclone/check-layout-landmark.test.ts',
  'scripts/webclone/check-layout-reveal.test.ts',
  'scripts/webclone/check-layout-style-delta.test.ts',
  'scripts/webclone/check-layout.test.ts',
  'scripts/webclone/nav-signature.test.ts',
  'scripts/webclone/pipeline-e2e.test.ts',
  'scripts/webclone/style-delta-gate.test.ts',
  'test/webclone-cdp-stabilization-deterministic.test.ts',
  'test/webclone-check-layout-not-applicable.test.ts',
  'test/webclone-check-layout-scroll-settle.test.ts',
] as const;

test('TD1 gate-out candidates with defect guards are retained without new exclusions', () => {
  const [header, ...rows] = readFileSync(join(repo, 'docs/measurements/td1-top200-content-review-2026-10-01.tsv'), 'utf8').trimEnd().split('\n');
  const columns = header!.split('\t');
  const index = (name: string) => {
    const at = columns.indexOf(name);
    expect(at).toBeGreaterThanOrEqual(0);
    return at;
  };
  const fileAt = index('file');
  const guardsAt = index('guards');
  const dispositionAt = index('disposition');
  const gateOut = rows.map((row) => row.split('\t')).filter((cells) => cells[dispositionAt] === 'move-out-of-gate');
  const report = readFileSync(join(repo, 'docs/measurements/TD1-v2-gate-content-review-2026-10-01.md'), 'utf8');
  expect(gateOut).toHaveLength(21);
  for (const cells of gateOut) {
    const file = cells[fileAt]!;
    expect(file).toMatch(/\.test\.ts$/);
    expect(cells[guardsAt]?.trim().length).toBeGreaterThan(0);
    expect(existsSync(join(repo, file))).toBe(true);
    expect(report).toContain(`| \`${file}\` |`);
  }
  const accounted = [...report.matchAll(/^\| `([^`]+\.test\.ts)` \| (.+) \|$/gm)]
    .map((match) => ({ file: match[1]!, reason: match[2]! }));
  expect(accounted.length).toBeGreaterThan(0);
  expect(accounted.map(({ file }) => file).sort()).toEqual(gateOut.map((cells) => cells[fileAt]!).sort());
  expect(accounted.every(({ reason }) => reason.trim().length > 0)).toBe(true);
  expect(new Set(gateOut.map((cells) => cells[fileAt])).size).toBe(gateOut.length);
  // review-model-ab: OP-approved Pod exclusion (#23439 · 10-04 · Pod no-output 2/2, local 4/0) — no other new exclusion.
  expect(POD_SWEEP_INTEGRATION_ONLY).toEqual(['scripts/install.test.ts', 'scripts/review-model-ab.test.ts']);
  expect(GATE_NIGHTLY_AUDITS).toEqual([
    'test/f12-sweep.test.ts',
    'scripts/unwired-exports.test.ts',
    'test/pwa-build-typecheck.test.ts',
  ]);
  expect(report).toContain('야간 이동 0개');
});

test('guarded gate-out candidates remain assigned to the Pod gate, except existing integration/CDP exclusions', async () => {
  const [header, ...rows] = readFileSync(join(repo, 'docs/measurements/td1-top200-content-review-2026-10-01.tsv'), 'utf8').trimEnd().split('\n');
  const columns = header!.split('\t');
  const disposition = columns.indexOf('disposition');
  const file = columns.indexOf('file');
  const candidates = rows.map((row) => row.split('\t'))
    .filter((cells) => cells[disposition] === 'move-out-of-gate').map((cells) => cells[file]!);
  const currentCdp = deriveCdpTestPatterns({ cwd: repo }).filter((path) => candidates.includes(path));
  const expected = candidates.filter((path) => !POD_SWEEP_INTEGRATION_ONLY.includes(path) && !BASELINE_CDP_EXCLUSIONS.includes(path as typeof BASELINE_CDP_EXCLUSIONS[number]));
  const root = mkdtempSync(join(tmpdir(), 'td1-gate-list-'));
  const assigned: string[] = [];
  try {
    const runner = createGateRunner(root, undefined, async (cmd, args) => {
      if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: `${'a'.repeat(40)}\n` };
      if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: [...candidates, 'src/sentinel.test.ts'].join('\n') };
      if (cmd === 'rg') return { rc: 0, output: currentCdp.join('\n') };
      throw new Error(`unexpected command: ${cmd}`);
    }, async (options) => {
      const paths = [...candidates, 'src/sentinel.test.ts']
        .filter((path) => options.command[2]!.includes(`'./${path}'`));
      assigned.push(...paths);
      const artifactsDir = join(root, options.name!);
      mkdirSync(artifactsDir);
      writeFileSync(join(artifactsDir, 'shard.log'), `${paths.length} pass\n0 fail\nRan ${paths.length} tests across ${paths.length} files.\n`);
      writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
      return { exitCode: 0, artifactsDir, job: 'fake' };
    }, new PodPoolScheduler([{ context: 'td1-test', capacity: 1, k3dCluster: 'test' }]));
    expect((await runner.sweep(root, undefined, { pool: 'td1-test', shards: 1 })).rc).toBe(0);
    expect(assigned.sort()).toEqual([...expected, 'src/sentinel.test.ts'].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
