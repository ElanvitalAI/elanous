import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { reportGateHubReach, reportImportGraphSccForGate, TSC_CUT_GATE_HUB_FILES } from './import-graph-scc-run.js';
import { gitClosureTree, testsReachingChanged } from './gate-closure.js';

function git(repo: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

test('real gate selector and Git closure read one clean HEAD; a dirty tree is refused', () => {
  const repo = mkdtempSync(join(tmpdir(), 'import-graph-scc-run-'));
  try {
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.name', 'UX Test');
    git(repo, 'config', 'user.email', 'ux-test@example.invalid');
    mkdirSync(join(repo, 'src'));
    mkdirSync(join(repo, 'test'));
    writeFileSync(join(repo, 'src/a.ts'), 'export const value = 1;\n');
    writeFileSync(join(repo, 'test/a.test.ts'), "import '../src/a.js'; test('value', () => {});\n");
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'base');
    const base40 = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'src/a.ts'), "import './a.js'; export const value = 2;\n");
    git(repo, 'add', 'src/a.ts');
    git(repo, 'commit', '-qm', 'head');
    const head40 = git(repo, 'rev-parse', 'HEAD');

    const result = reportImportGraphSccForGate(repo, base40);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.head40).toBe(head40);
    expect(result.changedFiles).toContain('src/a.ts');
    expect(result.report.selectedTests).toContain('test/a.test.ts');
    expect(result.report.measured).toBe(true);
    expect(result.report.cycleCount).toBe(1);
    expect(result.report.largestScc).toBe(1);
    const cli = spawnSync(process.execPath, [join(import.meta.dir, '..', 'import-graph-scc.ts'), '--base', base40, '--repo', repo], { encoding: 'utf8' });
    expect(cli.status).toBe(0);
    expect(JSON.parse(cli.stdout).report).toMatchObject({ measured: true, cycleCount: 1, largestScc: 1 });
    const impact = JSON.parse(cli.stdout).report.changedFileImpacts;
    expect(impact).toEqual([expect.objectContaining({
      file: 'src/a.ts', affectedTests: ['test/a.test.ts'], affectedTestCount: 1, measured: true,
    })]);
    const table = spawnSync(process.execPath, [join(import.meta.dir, '..', 'import-graph-scc.ts'), '--base', base40, '--repo', repo, '--format', 'table'], { encoding: 'utf8' });
    expect(table.status).toBe(0);
    expect(table.stdout).toContain('src/a.ts | 1 | 1 | measured');
    const missingRepo = spawnSync(process.execPath, [join(import.meta.dir, '..', 'import-graph-scc.ts'), '--base', base40, '--repo'], { encoding: 'utf8' });
    expect(missingRepo.status).toBe(2);
    expect(missingRepo.stderr).toContain('usage:');

    writeFileSync(join(repo, 'src/a.ts'), 'export const value = 3;\n');
    expect(reportImportGraphSccForGate(repo, base40)).toEqual({ ok: false, reason: 'working tree is not clean' });
    const dirtyCli = spawnSync(process.execPath, [join(import.meta.dir, '..', 'import-graph-scc.ts'), '--base', base40, '--repo', repo], { encoding: 'utf8' });
    expect(dirtyCli.status).toBe(2);
    expect(JSON.parse(dirtyCli.stdout)).toEqual({ ok: false, reason: 'working tree is not clean' });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}, 20_000);

test('TSC-CUT-GATE-RUNNER-HUB simulation measures paired hub reach and surfaces preload full fallback', () => {
  const repo = mkdtempSync(join(tmpdir(), 'gate-hub-reach-sim-'));
  try {
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.name', 'Gate Hub Sim');
    git(repo, 'config', 'user.email', 'gate-hub-sim@example.invalid');
    for (const dir of ['scripts/release-loop', 'src/graph-runner', 'test']) mkdirSync(join(repo, dir), { recursive: true });
    writeFileSync(join(repo, 'scripts/release-loop/gate-node.ts'), "import '../../src/shared.js';\n");
    writeFileSync(join(repo, 'src/graph-runner/runner.ts'), "import '../shared.js';\n");
    writeFileSync(join(repo, 'src/shared.ts'), 'export const hub = true;\n');
    writeFileSync(join(repo, 'src/opaque.ts'), "const target = process.env.OPAQUE_TARGET; import(target);\n");
    writeFileSync(join(repo, 'test/a.test.ts'), "import '../scripts/release-loop/gate-node.js'; test('gate node', () => {});\n");
    writeFileSync(join(repo, 'test/b.test.ts'), "import '../scripts/release-loop/gate-node.js'; import '../src/graph-runner/runner.js'; test('both hubs', () => {});\n");
    writeFileSync(join(repo, 'test/c.test.ts'), "import '../src/graph-runner/runner.js'; test('runner', () => {});\n");
    writeFileSync(join(repo, 'test/opaque.test.ts'), "import '../src/opaque.js'; test('opaque path', () => {});\n");
    writeFileSync(join(repo, 'test/preload.ts'), "import '../src/opaque.js';\n");
    writeFileSync(join(repo, 'test/untouched.test.ts'), "test('unrelated', () => {});\n");
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'fixture');
    const radiusCommit = git(repo, 'rev-parse', 'HEAD');

    const radiusTree = gitClosureTree(repo, radiusCommit);
    const tests = ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts', 'test/opaque.test.ts', 'test/untouched.test.ts'];
    const productionRadius = testsReachingChanged(radiusTree, TSC_CUT_GATE_HUB_FILES, tests);
    const radiusReport = reportGateHubReach(repo, radiusCommit);
    expect(TSC_CUT_GATE_HUB_FILES).toEqual(['scripts/release-loop/gate-node.ts', 'src/graph-runner/runner.ts']);
    // Source: synthetic fixture topology; 5 test files, 3 definite and 1 opaque hub reach.
    expect(radiusReport).toMatchObject({
      commit: radiusCommit,
      totalTestFiles: 5,
      hubReach: { definiteTests: 3, opaqueAdditionalTests: 1, selectedTests: 4 },
      conservativeGate: { mode: 'radius', selectedTests: 4 },
    });
    expect(productionRadius.ok).toBe(true);
    if (productionRadius.ok) expect(radiusReport.conservativeGate.selectedTests).toBe(productionRadius.tests.length);
    expect(radiusReport.withinHalf).toBe(true);

    writeFileSync(join(repo, 'bunfig.toml'), '[test]\npreload = ["./test/preload.ts"]\n');
    git(repo, 'add', 'bunfig.toml'); git(repo, 'commit', '-qm', 'enable opaque preload');
    const fallbackCommit = git(repo, 'rev-parse', 'HEAD');
    const fallbackTree = gitClosureTree(repo, fallbackCommit);
    const productionFallback = testsReachingChanged(fallbackTree, TSC_CUT_GATE_HUB_FILES, tests);
    const fallbackReport = reportGateHubReach(repo, fallbackCommit);
    expect(fallbackReport).toMatchObject({
      commit: fallbackCommit,
      hubReach: { definiteTests: 3, opaqueAdditionalTests: 1, selectedTests: 4 },
      conservativeGate: { mode: 'full-fallback', selectedTests: 5 },
    });
    expect(productionFallback.ok).toBe(false);
    if (!productionFallback.ok) expect(fallbackReport.conservativeGate.selectedTests).toBe(tests.length);
    expect(fallbackReport.withinHalf).toBe(true);

    const cli = spawnSync(process.execPath, [join(import.meta.dir, '..', 'import-graph-scc.ts'), '--commit', 'HEAD',
      '--changed-files', TSC_CUT_GATE_HUB_FILES.join(','), '--repo', repo, '--format', 'table'], { encoding: 'utf8' });
    if (cli.status !== 0) throw new Error(cli.stderr || `hub measurement CLI exited ${cli.status}`);
    expect(cli.status).toBe(0);
    expect(cli.stdout).toContain('Hub radius | Total test files | Definite reach | Opaque additional | Gate selection');
    expect(cli.stdout).toContain('4 (4/5) | 5 | 3 | 1 | 5 (full-fallback) | yes');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}, 20_000);
