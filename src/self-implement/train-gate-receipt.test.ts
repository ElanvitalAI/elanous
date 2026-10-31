import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordPassedSelfGateReceipt, runTrainGateWithReceipts } from './train-gate-receipt.js';
import { gateEnvFingerprint, gateLockfileHash, loadGateReceipts } from './gate-receipt-registry.js';
import { planGateTrainReceiptCarry } from '../../scripts/release-loop/gate-train-receipts.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function repository(): { cwd: string; commit: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'train-gate-receipt-'));
  roots.push(cwd);
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.name', 'Receipt test');
  git(cwd, 'config', 'user.email', 'receipt@test.local');
  writeFileSync(join(cwd, 'bun.lock'), 'receipt fixture lock');
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'src/a.ts'), 'export const a = 1;\n');
  writeFileSync(join(cwd, 'src/b.ts'), 'export const b = 1;\n');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', 'receipt fixture');
  return { cwd, commit: git(cwd, 'rev-parse', 'HEAD') };
}

test('train receipt runs the full requested gate and records a passed measurement', () => {
  const { cwd, commit } = repository();
  const calls: string[] = [];
  const execute = (script: string) => {
    calls.push(script);
    return { status: 0, stdout: 'gate passed', stderr: '' };
  };
  const input = { repo: cwd, commit, baseSha: commit, changedFiles: ['src/a.test.ts', 'src/b.test.ts'] };

  expect(runTrainGateWithReceipts(input, execute)).toMatchObject({ status: 0, stdout: 'gate passed' });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("bun run test:deterministic 'src/a.test.ts' 'src/b.test.ts'");
  expect(calls[0]).toContain("--changed-files 'src/a.test.ts' 'src/b.test.ts'");
  expect(Object.values(loadGateReceipts(join(cwd, '.git', 'elanous-host-regate', 'gate-receipts.json'))))
    .toMatchObject([expect.objectContaining({ verdict: 'passed', radiusFiles: ['src/a.test.ts', 'src/b.test.ts'] })]);

  runTrainGateWithReceipts(input, execute);
  expect(calls).toHaveLength(2);
});

test('failed and unmeasured train runs never record passed receipts', () => {
  for (const status of [1, null] as const) {
    const { cwd, commit } = repository();
    let calls = 0;
    const result = runTrainGateWithReceipts({ repo: cwd, commit, baseSha: commit, changedFiles: ['src/a.test.ts'] }, () => {
      calls++;
      return { status, stdout: '', stderr: 'not passed' };
    });
    expect(result.status).toBe(status);
    expect(calls).toBe(1);
    expect(Object.values(loadGateReceipts(join(cwd, '.git', 'elanous-host-regate', 'gate-receipts.json'))))
      .toHaveLength(0);
  }
});

test('a corrupt registry does not suppress or change the full gate result', () => {
  const { cwd, commit } = repository();
  const registryPath = join(cwd, '.git', 'elanous-host-regate', 'gate-receipts.json');
  mkdirSync(join(cwd, '.git', 'elanous-host-regate'), { recursive: true });
  writeFileSync(registryPath, '{broken json');
  let calls = 0;
  const result = runTrainGateWithReceipts({ repo: cwd, commit, baseSha: commit, changedFiles: ['src/a.test.ts'] }, () => {
    calls++;
    return { status: 0, stdout: 'gate passed', stderr: '' };
  });
  expect(result).toMatchObject({ status: 0, stdout: 'gate passed' });
  expect(calls).toBe(1);
  expect(Object.values(loadGateReceipts(registryPath))).toMatchObject([
    expect.objectContaining({ verdict: 'passed', radiusFiles: ['src/a.test.ts'] }),
  ]);
});

test('remote scratch registry payload receives the newly written receipt', () => {
  const { cwd, commit } = repository();
  const payloadRoot = mkdtempSync(join(tmpdir(), 'train-gate-payload-registry-'));
  roots.push(payloadRoot);
  const payloadPath = join(payloadRoot, 'gate-receipts.json');
  writeFileSync(payloadPath, '{}\n');
  const previous = process.env.ELANOUS_GATE_RECEIPT_REGISTRY_PATH;
  process.env.ELANOUS_GATE_RECEIPT_REGISTRY_PATH = payloadPath;
  try {
    const result = runTrainGateWithReceipts({ repo: cwd, commit, baseSha: commit, changedFiles: ['src/a.ts'] },
      () => ({ status: 0, stdout: 'gate passed', stderr: '' }));
    expect(result.status).toBe(0);
    expect(Object.values(loadGateReceipts(payloadPath))).toMatchObject([
      expect.objectContaining({ verdict: 'passed', radiusFiles: ['src/a.ts'] }),
    ]);
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_GATE_RECEIPT_REGISTRY_PATH;
    else process.env.ELANOUS_GATE_RECEIPT_REGISTRY_PATH = previous;
  }
});

test('passed self gate records only measured changed-only interference and the receipt can carry a test', async () => {
  const { cwd } = repository();
  writeFileSync(join(cwd, 'src/other.test.ts'), 'import { test } from "bun:test"; test("other", () => {});\n');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', 'base test radius');
  const base = git(cwd, 'rev-parse', 'HEAD');
  writeFileSync(join(cwd, 'src/a.test.ts'), 'import { test } from "bun:test"; test("a", () => {});\n');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', 'changed test');
  const head = git(cwd, 'rev-parse', 'HEAD');
  const receiptPath = join(cwd, '.git', 'receipts.json');
  const summaryPath = join(cwd, 'summary.json');
  writeFileSync(summaryPath, JSON.stringify({ head40: head, base40: base, exitCode: 0, verdict: 'passed',
    introduced: 0, unknown: 0, unrunImporters: 0, cohort: ['src/a.test.ts'],
    typecheck: { status: 'passed', base40: base, head40: head, exitCode: 0, newErrors: 0 } }));
  const prior = process.env.ELANOUS_GATE_RECEIPT_REGISTRY_PATH;
  process.env.ELANOUS_GATE_RECEIPT_REGISTRY_PATH = receiptPath;
  try {
    let observed: readonly string[] = [];
    const receipt = await recordPassedSelfGateReceipt({ repo: cwd, commit: head, baseSha: base,
      changedFiles: ['src/a.test.ts'], summaryPath }, async (files) => {
      observed = files;
      return { status: 'no-interference' };
    });
    expect(observed).toEqual(['src/a.test.ts']);
    expect(receipt).toMatchObject({ headCommit: head, baseCommit: base, radiusFiles: ['src/a.test.ts'],
      checks: ['test-interference:changed-only'], verdict: 'passed' });
    const plan = planGateTrainReceiptCarry({ repo: cwd, commit: head, receiptPath,
      bunVersion: process.versions.bun!, lockfileHash: gateLockfileHash(cwd),
      envFingerprint: gateEnvFingerprint(process.env) });
    expect(plan?.carriedFiles).toEqual(['src/a.test.ts']);
    expect(await recordPassedSelfGateReceipt({ repo: cwd, commit: head, baseSha: base,
      changedFiles: ['src/a.test.ts'], summaryPath }, async () => ({ status: 'unmeasurable' }))).toBeUndefined();
  } finally {
    if (prior === undefined) delete process.env.ELANOUS_GATE_RECEIPT_REGISTRY_PATH;
    else process.env.ELANOUS_GATE_RECEIPT_REGISTRY_PATH = prior;
  }
});

test('deleted test paths remain in PWA radius but are never passed to the test runner', () => {
  const { cwd, commit } = repository();
  let script = '';
  runTrainGateWithReceipts({
    repo: cwd,
    commit,
    baseSha: commit,
    changedFiles: ['src/gone.test.ts', 'src/new.test.ts'],
    deletedFiles: ['src/gone.test.ts'],
  }, (value) => { script = value; return { status: 0, stdout: '', stderr: '' }; });
  const testStep = script.split(' && ').find((step) => step.startsWith('bun run test:deterministic')) ?? '';
  expect(testStep).toContain("'src/new.test.ts'");
  expect(testStep).not.toContain('gone.test.ts');
  expect(script).toContain("--changed-files 'src/gone.test.ts' 'src/new.test.ts'");
});
