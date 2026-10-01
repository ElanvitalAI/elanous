import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHarnessPolicyGates } from './harness-policy-gates.js';

const roots: string[] = [];
function fixture(withScripts = true): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-policy-gate-'));
  roots.push(root);
  if (withScripts) {
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'scripts', 'isolation-hardcode-baseline.txt'), '');
  }
  mkdirSync(join(root, 'src'));
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('actual isolation gate rejects an alias hardcode in changed src/x.ts and accepts the resolver replacement', () => {
  const cwd = fixture();
  writeFileSync(join(cwd, 'src/x.ts'), "import { homedir } from 'node:os';\nconst home = homedir();\nexport function storage() { return join(home, '.elanous', 'storage'); }\n");
  const bad = runHarnessPolicyGates({ cwd, changedFiles: ['src/x.ts'] });
  expect(bad.passed).toBe(false);
  expect(bad.failures[0]?.gate).toBe('isolation-gate');
  expect(bad.failures[0]?.lines.join('\n')).toContain('src/x.ts');

  writeFileSync(join(cwd, 'src/x.ts'), "import { elanousStateRoot } from './state-paths.js';\nexport function storage() { return join(elanousStateRoot(), 'storage'); }\n");
  expect(runHarnessPolicyGates({ cwd, changedFiles: ['src/x.ts'], gates: { 'daemon-port-gate': () => 0 } })).toEqual({ passed: true, failures: [] });
});

test('without scripts, no source gate is invoked', () => {
  const cwd = fixture(false);
  let calls = 0;
  const gate = () => { calls++; return 1; };
  expect(runHarnessPolicyGates({ cwd, changedFiles: ['src/x.ts'], gates: {
    'isolation-gate': gate, 'mock-module-restore-gate': gate, 'model-hardcode-gate': gate, 'daemon-port-gate': gate,
  } })).toEqual({ passed: true, failures: [], skipped: 'no-scripts' });
  expect(calls).toBe(0);
});

test('passes the same changed-files argv and cwd to all three runners; collects each failed gate output', () => {
  const cwd = fixture();
  const received: Array<{ cwd: string; args: string[] }> = [];
  const run = (name: string, status: number) => (out: { cwd: string; args: string[]; error: (line: string) => void }) => {
    received.push({ cwd: out.cwd, args: out.args });
    out.error(`${name}: src/x.ts`);
    return status;
  };
  const result = runHarnessPolicyGates({ cwd, changedFiles: ['src/x.ts', 'scripts/y.ts'], gates: {
    'isolation-gate': run('isolation-gate', 0),
    'mock-module-restore-gate': run('mock-module-restore-gate', 1),
    'model-hardcode-gate': run('model-hardcode-gate', 1),
    'daemon-port-gate': run('daemon-port-gate', 0),
  } });
  expect(received).toEqual(Array.from({ length: 4 }, () => ({ cwd, args: ['--changed-files', 'src/x.ts', 'scripts/y.ts'] })));
  expect(result).toMatchObject({ passed: false, failures: [
    { gate: 'mock-module-restore-gate', lines: [expect.stringContaining('src/x.ts'), expect.stringContaining('violation detected')] },
    { gate: 'model-hardcode-gate', lines: [expect.stringContaining('src/x.ts'), expect.stringContaining('violation detected')] },
  ] });
});

test('injected daemon-port-gate failure is named; a passing one leaves the other gates unchanged', () => {
  const cwd = fixture();
  const failing = runHarnessPolicyGates({ cwd, changedFiles: ['src/x.ts'], gates: {
    'isolation-gate': () => 0,
    'mock-module-restore-gate': () => 0,
    'model-hardcode-gate': () => 0,
    'daemon-port-gate': (out) => { out.error('src/zz-probe.ts:1'); return 1; },
  } });
  expect(failing.passed).toBe(false);
  expect(failing.failures.map((failure) => failure.gate)).toEqual(['daemon-port-gate']);
  expect(failing.failures[0]?.lines.join('\n')).toContain('src/zz-probe.ts:1');

  const passing = runHarnessPolicyGates({ cwd, changedFiles: ['src/x.ts'], gates: {
    'isolation-gate': () => 0,
    'mock-module-restore-gate': (out) => { out.error('mock-module-restore-gate: src/x.ts'); return 1; },
    'model-hardcode-gate': () => 0,
    'daemon-port-gate': () => 0,
  } });
  expect(passing).toMatchObject({ passed: false, failures: [
    { gate: 'mock-module-restore-gate', lines: [expect.stringContaining('src/x.ts'), expect.stringContaining('violation detected')] },
  ] });
});

test('runner exception is a named measurement failure, not a pass', () => {
  const cwd = fixture();
  const result = runHarnessPolicyGates({ cwd, changedFiles: [], gates: {
    'isolation-gate': () => { throw new Error('scan unavailable'); },
    'mock-module-restore-gate': () => 0,
    'model-hardcode-gate': () => 0,
    'daemon-port-gate': () => 0,
  } });
  expect(result).toEqual({ passed: false, failures: [{ gate: 'isolation-gate', lines: [expect.stringContaining('scan unavailable')] }] });
});

test('LEAK1: public-export-leak runs with the same changed files and its failure reaches the child with the file and line', () => {
  const cwd = fixture();
  const pass = () => 0;
  let seen: string[] = [];
  const result = runHarnessPolicyGates({ cwd, changedFiles: ['src/a.test.ts'], gates: {
    'isolation-gate': pass, 'mock-module-restore-gate': pass, 'model-hardcode-gate': pass, 'daemon-port-gate': pass,
    'public-export-leak': (out) => { seen = out.args; out.error('   src/a.test.ts:3  ceo-mark'); return 1; },
  } });
  expect(seen).toEqual(['--changed-files', 'src/a.test.ts']);
  expect(result).toMatchObject({ passed: false, failures: [{ gate: 'public-export-leak', lines: [expect.stringContaining('src/a.test.ts:3  ceo-mark'), expect.stringContaining('violation detected')] }] });
});

test('LEAK1: the real public-export-leak gate does not fail a tree it cannot measure', () => {
  const cwd = fixture();
  const pass = () => 0;
  expect(runHarnessPolicyGates({ cwd, changedFiles: ['src/x.ts'], gates: {
    'isolation-gate': pass, 'mock-module-restore-gate': pass, 'model-hardcode-gate': pass, 'daemon-port-gate': pass,
  } })).toEqual({ passed: true, failures: [] });
});
