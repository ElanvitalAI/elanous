import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
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

test('actual isolation gate rejects an alias hardcode in changed src/x.ts and accepts the resolver replacement', async () => {
  const cwd = fixture();
  writeFileSync(join(cwd, 'src/x.ts'), "import { homedir } from 'node:os';\nconst home = homedir();\nexport function storage() { return join(home, '.elanous', 'storage'); }\n");
  const bad = await runHarnessPolicyGates({ cwd, changedFiles: ['src/x.ts'] });
  expect(bad.passed).toBe(false);
  expect(bad.failures[0]?.gate).toBe('isolation-gate');
  expect(bad.failures[0]?.lines.join('\n')).toContain('src/x.ts');

  writeFileSync(join(cwd, 'src/x.ts'), "import { elanousStateRoot } from './state-paths.js';\nexport function storage() { return join(elanousStateRoot(), 'storage'); }\n");
  expect(await runHarnessPolicyGates({ cwd, changedFiles: ['src/x.ts'], gates: { 'daemon-port-gate': () => 0, 'public-export-leak': () => 0, 'public-export-import': () => 0 } })).toEqual({ passed: true, failures: [] });
});

test('without scripts, no source gate is invoked', async () => {
  const cwd = fixture(false);
  let calls = 0;
  const gate = () => { calls++; return 1; };
  expect(await runHarnessPolicyGates({ cwd, changedFiles: ['src/x.ts'], gates: {
    'isolation-gate': gate, 'mock-module-restore-gate': gate, 'model-hardcode-gate': gate, 'daemon-port-gate': gate,
    'public-export-leak': gate, 'public-export-import': gate,
  } })).toEqual({ passed: true, failures: [], skipped: 'no-scripts' });
  expect(calls).toBe(0);
});

test('passes the same changed-files argv and cwd to all six runners; collects each failed gate output', async () => {
  const cwd = fixture();
  const received: Array<{ cwd: string; args: string[] }> = [];
  const run = (name: string, status: number) => (out: { cwd: string; args: string[]; error: (line: string) => void }) => {
    received.push({ cwd: out.cwd, args: out.args });
    out.error(`${name}: src/x.ts`);
    return status;
  };
  const result = await runHarnessPolicyGates({ cwd, changedFiles: ['src/x.ts', 'scripts/y.ts'], gates: {
    'isolation-gate': run('isolation-gate', 0),
    'mock-module-restore-gate': run('mock-module-restore-gate', 1),
    'model-hardcode-gate': run('model-hardcode-gate', 1),
    'daemon-port-gate': run('daemon-port-gate', 0),
    'public-export-leak': run('public-export-leak', 0),
    'public-export-import': async (out) => run('public-export-import', 0)(out),
  } });
  expect(received).toEqual(Array.from({ length: 6 }, () => ({ cwd, args: ['--changed-files', 'src/x.ts', 'scripts/y.ts'] })));
  expect(result).toMatchObject({ passed: false, failures: [
    { gate: 'mock-module-restore-gate', lines: [expect.stringContaining('src/x.ts'), expect.stringContaining('violation detected')] },
    { gate: 'model-hardcode-gate', lines: [expect.stringContaining('src/x.ts'), expect.stringContaining('violation detected')] },
  ] });
});

test('injected daemon-port-gate failure is named; a passing one leaves the other gates unchanged', async () => {
  const cwd = fixture();
  const failing = await runHarnessPolicyGates({ cwd, changedFiles: ['src/x.ts'], gates: {
    'isolation-gate': () => 0,
    'mock-module-restore-gate': () => 0,
    'model-hardcode-gate': () => 0,
    'daemon-port-gate': (out) => { out.error('src/zz-probe.ts:1'); return 1; },
    'public-export-leak': () => 0,
    'public-export-import': () => 0,
  } });
  expect(failing.passed).toBe(false);
  expect(failing.failures.map((failure) => failure.gate)).toEqual(['daemon-port-gate']);
  expect(failing.failures[0]?.lines.join('\n')).toContain('src/zz-probe.ts:1');

  const passing = await runHarnessPolicyGates({ cwd, changedFiles: ['src/x.ts'], gates: {
    'isolation-gate': () => 0,
    'mock-module-restore-gate': (out) => { out.error('mock-module-restore-gate: src/x.ts'); return 1; },
    'model-hardcode-gate': () => 0,
    'daemon-port-gate': () => 0,
    'public-export-leak': () => 0,
    'public-export-import': () => 0,
  } });
  expect(passing).toMatchObject({ passed: false, failures: [
    { gate: 'mock-module-restore-gate', lines: [expect.stringContaining('src/x.ts'), expect.stringContaining('violation detected')] },
  ] });
});

test('runner exception is a named measurement failure, not a pass', async () => {
  const cwd = fixture();
  const result = await runHarnessPolicyGates({ cwd, changedFiles: [], gates: {
    'isolation-gate': () => { throw new Error('scan unavailable'); },
    'mock-module-restore-gate': () => 0,
    'model-hardcode-gate': () => 0,
    'daemon-port-gate': () => 0,
    'public-export-leak': () => 0,
    'public-export-import': () => 0,
  } });
  expect(result).toEqual({ passed: false, failures: [{ gate: 'isolation-gate', lines: [expect.stringContaining('scan unavailable')] }] });
});

test('LEAK1: public-export-leak runs with the same changed files and its failure reaches the child with the file and line', async () => {
  const cwd = fixture();
  const pass = () => 0;
  let seen: string[] = [];
  const result = await runHarnessPolicyGates({ cwd, changedFiles: ['src/a.test.ts'], gates: {
    'isolation-gate': pass, 'mock-module-restore-gate': pass, 'model-hardcode-gate': pass, 'daemon-port-gate': pass,
    'public-export-leak': (out) => { seen = out.args; out.error('   src/a.test.ts:3 · ceo-mark'); return 1; },
    'public-export-import': pass,
  } });
  expect(seen).toEqual(['--changed-files', 'src/a.test.ts']);
  expect(result).toMatchObject({ passed: false, failures: [{ gate: 'public-export-leak', lines: [expect.stringContaining('src/a.test.ts:3 · ceo-mark'), expect.stringContaining('violation detected')] }] });
});

test('LEAK1: the real public-export-leak gate blocks a tree it cannot measure', async () => {
  const cwd = fixture();
  const pass = () => 0;
  expect(await runHarnessPolicyGates({ cwd, changedFiles: ['src/x.ts'], gates: {
    'isolation-gate': pass, 'mock-module-restore-gate': pass, 'model-hardcode-gate': pass, 'daemon-port-gate': pass,
    'public-export-import': pass,
  } })).toMatchObject({ passed: false, failures: [{ gate: 'public-export-leak', lines: [expect.stringContaining('못 쟀다 — 막는다'), expect.stringContaining('violation detected')] }] });
});

test('public-export-import default runner rejects an unmeasured changed file', async () => {
  const cwd = fixture();
  const pass = () => 0;
  const result = await runHarnessPolicyGates({ cwd, changedFiles: ['src/x.ts'], gates: {
    'isolation-gate': pass, 'mock-module-restore-gate': pass, 'model-hardcode-gate': pass, 'daemon-port-gate': pass,
    'public-export-leak': pass,
  } });
  expect(result).toMatchObject({ passed: false, failures: [{ gate: 'public-export-import', lines: [expect.stringContaining('못 쟀다 — 막는다'), expect.stringContaining('violation detected')] }] });
});

test('public-export-import awaits a resolved failure and keeps its reason', async () => {
  const cwd = fixture();
  const pass = () => 0;
  const result = await runHarnessPolicyGates({ cwd, changedFiles: ['src/x.ts'], gates: {
    'isolation-gate': pass, 'mock-module-restore-gate': pass, 'model-hardcode-gate': pass, 'daemon-port-gate': pass,
    'public-export-leak': pass,
    'public-export-import': async (out) => { await Promise.resolve(); out.error('src/x.ts:4 → src/private.ts'); return 1; },
  } });
  expect(result).toEqual({ passed: false, failures: [{ gate: 'public-export-import', lines: [
    'src/x.ts:4 → src/private.ts', expect.stringContaining('violation detected'),
  ] }] });
});

test('public-export-import awaits a rejected runner and preserves its diagnostic', async () => {
  const cwd = fixture();
  const pass = () => 0;
  const result = await runHarnessPolicyGates({ cwd, changedFiles: ['src/x.ts'], gates: {
    'isolation-gate': pass, 'mock-module-restore-gate': pass, 'model-hardcode-gate': pass, 'daemon-port-gate': pass,
    'public-export-leak': pass,
    'public-export-import': async (out) => { out.error('scan pending'); throw new Error('import scanner unavailable'); },
  } });
  expect(result).toEqual({ passed: false, failures: [{ gate: 'public-export-import', lines: [
    'scan pending', expect.stringContaining('import scanner unavailable'),
  ] }] });
});

/** A tracked repo whose public manifest includes src/** and excludes the directive index (same shape as the import-gate fixture). */
function exportFixture(importLine: string): string {
  const root = fixture();
  mkdirSync(join(root, 'node_modules/typescript'), { recursive: true });
  writeFileSync(join(root, 'node_modules/typescript/package.json'), '{"name":"typescript","version":"0.0.0","main":"index.js"}\n');
  writeFileSync(join(root, 'node_modules/typescript/index.js'), 'module.exports = {};\n');
  mkdirSync(join(root, 'src/decisions'), { recursive: true });
  mkdirSync(join(root, 'src/directives'), { recursive: true });
  mkdirSync(join(root, 'release'), { recursive: true });
  writeFileSync(join(root, 'release/public-export.yaml'), 'include:\n  - src/**\nexclude:\n  - src/directives/directive-index*\n');
  writeFileSync(join(root, 'src/directives/directive-index.ts'), 'export const index = 1;\n');
  writeFileSync(join(root, 'src/decisions/proact-meter.ts'), `${importLine}\nexport const meter = 1;\n`);
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  expect(spawnSync('git', ['init', '-q'], { cwd: root }).status).toBe(0);
  expect(spawnSync('git', ['add', '-A'], { cwd: root, env }).status).toBe(0);
  expect(spawnSync('git', ['commit', '-qm', 'base'], { cwd: root, env }).status).toBe(0);
  return root;
}
const othersPass = { 'isolation-gate': () => 0, 'mock-module-restore-gate': () => 0, 'model-hardcode-gate': () => 0, 'daemon-port-gate': () => 0, 'public-export-leak': () => 0 } as const;

test('EXPORT-IMPORT-FULL: the real import gate blocks a public file that statically imports an excluded module', async () => {
  // Assembled at runtime so this test file itself does not carry a literal import of the excluded module.
  const excluded = ['..', 'directives', 'directive-index.js'].join('/');
  const cwd = exportFixture(`import { index } from '${excluded}';`);
  const result = await runHarnessPolicyGates({ cwd, changedFiles: ['src/decisions/proact-meter.ts'], gates: othersPass });
  expect(result.passed).toBe(false);
  expect(result.failures.map((failure) => failure.gate)).toEqual(['public-export-import']);
  expect(result.failures[0]!.lines.filter((line) => line.includes('src/decisions/proact-meter.ts:1 → src/directives/directive-index.ts'))).toHaveLength(1);
});

test('EXPORT-IMPORT-FULL: the same file loading the module dynamically passes the real import gate', async () => {
  const cwd = exportFixture("export async function load() { const name = 'directive-index'; return import('../directives/' + name + '.js'); }");
  expect(await runHarnessPolicyGates({ cwd, changedFiles: ['src/decisions/proact-meter.ts'], gates: othersPass })).toEqual({ passed: true, failures: [] });
});
