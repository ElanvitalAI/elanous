import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { reportImportGraphSccForGate } from './import-graph-scc-run.js';

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
