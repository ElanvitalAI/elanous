import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { buildUserConfig } from '../user-config.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultSeams } from './seams.js';
import { exposeGateLines } from './orchestrator.js';
import { runSelfGateCli } from './gate-cli.js';

const doc = 'release/public/docs/guide.md';
const response = JSON.stringify({ docs: 1, missing: [], orphan: [], failing: [], internal: [], unreviewed: [], unjudged: [doc] });

function repository(): { cwd: string; dispose: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), 'expose-gate-wiring-'));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    expect(result.status).toBe(0);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(cwd, 'README.md'), 'base\n');
  git('add', 'README.md');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'expose-pr');
  mkdirSync(join(cwd, 'release/public/docs'), { recursive: true });
  writeFileSync(join(cwd, doc), 'Public guide\n');
  git('add', doc);
  git('commit', '-qm', 'public guide');
  return { cwd, dispose: () => rmSync(cwd, { recursive: true, force: true }) };
}

describe('harness exposure gate wiring', () => {
  test('harness.exposeGate defaults to warn, accepts strict and normalizes invalid values', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'expose-config-'));
    const path = join(cwd, 'config.json');
    try {
      expect(buildUserConfig(path).harness?.exposeGate).toBe('warn');
      writeFileSync(path, JSON.stringify({ harness: { exposeGate: 'strict' } }));
      expect(buildUserConfig(path).harness?.exposeGate).toBe('strict');
      writeFileSync(path, JSON.stringify({ harness: { exposeGate: 'other' } }));
      expect(buildUserConfig(path).harness?.exposeGate).toBe('warn');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('self-implement Gate log contains the scoped exposure line and a rejecting exposure verdict reaches gate.passed', async () => {
    const fixture = repository();
    let calls = 0;
    try {
      const common = {
        runIntegrityGate: () => ({ passed: true, steps: [], log: '[test] SKIPPED' }),
        runHarnessPolicyGates: () => ({ passed: true, failures: [], skipped: 'no-scripts' }),
        runExposeGate: (_cwd: string, files: readonly string[], mode: 'warn' | 'strict') => {
          calls += 1;
          expect(files).toContain(doc);
          expect(mode).toBe('warn');
          return { passed: false, log: '[expose] 1개 · 미판정 1 · fail 0' };
        },
      };
      const gate = await defaultSeams(common).gate(fixture.cwd);
      expect(calls).toBe(1);
      expect(gate.passed).toBe(false);
      expect(gate.log).toContain('[expose] 1개 · 미판정 1 · fail 0');
      expect(exposeGateLines(`${'noise'.repeat(1200)}\n${gate.log}`)).toEqual(['[expose] 1개 · 미판정 1 · fail 0']);
    } finally { fixture.dispose(); }
  });

  test('self-implement gate awaits a Promise-resolved public-export-import failure and reports its reason', async () => {
    const fixture = repository();
    const reason = 'public export imports cannot resolve the release entry';
    try {
      const gate = await defaultSeams({
        runIntegrityGate: () => ({ passed: true, steps: [], log: '[test] SKIPPED' }),
        runExposeGate: () => ({ passed: true, log: '' }),
        runHarnessPolicyGates: () => Promise.resolve({
          passed: false,
          failures: [{ gate: 'public-export-import', lines: [reason] }],
        }),
      }).gate(fixture.cwd);
      expect(gate.passed).toBe(false);
      expect(gate.log).toContain(reason);
    } finally { fixture.dispose(); }
  });

  test('self-implement without public docs skips the exposure seam entirely', async () => {
    const fixture = repository();
    let calls = 0;
    try {
      const git = spawnSync('git', ['reset', '--hard', 'main'], { cwd: fixture.cwd });
      expect(git.status).toBe(0);
      writeFileSync(join(fixture.cwd, 'README.md'), 'other change\n');
      const gate = await defaultSeams({
        runIntegrityGate: () => ({ passed: true, steps: [], log: '[test] SKIPPED' }),
        runHarnessPolicyGates: () => ({ passed: true, failures: [], skipped: 'no-scripts' }),
        runExposeGate: () => { calls += 1; throw new Error('must not check'); },
      }).gate(fixture.cwd);
      expect(calls).toBe(0);
      expect(gate.log).not.toContain('[expose]');
    } finally { fixture.dispose(); }
  });

  test('self gate CLI: docs-only PR gets the line and warn lands', () => {
    const files = [doc, 'docs/other.md'];
    const calls: string[][] = [];
    const runCommand = (command: string, args: string[]) => {
      expect(command).toBe('bun');
      calls.push(args);
      return { status: 0, stdout: response };
    };
    const warn = runSelfGateCli('/repo', {}, { changedFiles: () => ({ files, baseRef: 'HEAD' }), runCommand });
    expect(warn.exitCode).toBe(0);
    expect(warn.lines).toContain('[expose] 1개 · 미판정 1 · fail 0');
    expect(calls).toEqual([['scripts/expose-rubric-check.ts', '--json', '--files', doc]]);
  });

  test('self gate CLI without public docs does not call the checker', () => {
    let checkerCalls = 0;
    const gate = runSelfGateCli('/repo', {}, {
      changedFiles: () => ({ files: ['docs/a.md'], baseRef: 'HEAD' }),
      runCommand: (command) => {
        if (command === 'bun') checkerCalls += 1;
        return { status: 0 };
      },
    });
    expect(gate.exitCode).toBe(0);
    expect(gate.lines.some((line) => line.startsWith('[expose]'))).toBe(false);
    expect(checkerCalls).toBe(0);
  });
});
