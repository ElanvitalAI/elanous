import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runSelfGateCli } from './gate-cli.js';

test('self gate passes selected base to policy ratchet', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'self-gate-policy-'));
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const put = (path: string, text: string) => { mkdirSync(join(cwd, path, '..'), { recursive: true }); writeFileSync(join(cwd, path), text); };
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.invalid');
    put('src/a.ts', 'export const OLD_MAX = 1;\n');
    put('scripts/ratchets/policy-constants.baseline.json', JSON.stringify({ threshold: { 'src/a.ts': 1 }, place: {} }));
    git('add', '.'); git('commit', '-qm', 'initial');
    put('src/a.ts', 'export const OLD_MAX = 1;\nexport const MAIN_MAX = 2;\n');
    git('add', '.'); git('commit', '-qm', 'main drift');
    const base = git('rev-parse', 'HEAD'); git('checkout', '-qb', 'pr');
    const deps = {
      changedFiles: () => ({ files: ['src/a.ts'], baseRef: base }),
      runTests: () => ({ status: 0, stdout: '', stderr: '' }),
      runBaseline: () => ({ status: 'pass' as const, output: '', log: '' }),
      runAndroidGate: () => 0, runIosGate: () => 0, runPwaGate: () => 0,
      runIsolationGate: () => 0, runMockModuleRestoreGate: () => 0,
      runModelHardcodeGate: () => 0, runDaemonPortGate: () => 0,
    };
    put('src/a.ts', 'export const OLD_MAX = 1;\nexport const MAIN_MAX = 2;\nexport function f() {}\n');
    const good = runSelfGateCli(cwd, { base, includeImporterTests: true }, deps);
    expect(good.lines.join('\n')).toContain('[policy-constants-gate] PASS');
    put('src/a.ts', 'export const OLD_MAX = 1;\nexport const MAIN_MAX = 2;\nexport const PR_MAX = 3;\n');
    const bad = runSelfGateCli(cwd, { base, includeImporterTests: true }, deps);
    expect(bad.exitCode).toBe(1);
    expect(bad.lines.join('\n')).toContain('PR_MAX');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
