import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { computeReceiptKey, saveGateReceipt, type GateReceipt } from '../../src/self-implement/gate-receipt-registry.js';
import { planGateTrainReceiptCarry } from './gate-train-receipts.js';

const roots: string[] = [];
const run = (cwd: string, ...args: string[]) => {
  const result = spawnSync(args[0]!, args.slice(1), { cwd, encoding: 'utf8' });
  if (result.status !== 0 || result.error) throw new Error(result.stderr || String(result.error));
  return result.stdout.trim();
};
function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'gate-train-receipt-'));
  roots.push(repo);
  run(repo, 'git', 'init', '-q');
  run(repo, 'git', 'config', 'user.name', 'test');
  run(repo, 'git', 'config', 'user.email', 'test@example.invalid');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'bun.lock'), 'lock');
  writeFileSync(join(repo, 'bunfig.toml'), '[test]\n');
  mkdirSync(join(repo, 'src/other'), { recursive: true });
  writeFileSync(join(repo, 'src/other/b.test.ts'), 'import { test } from "bun:test"; test("b", () => {});\n');
  return { repo };
}
function commit(repo: string, message: string): string {
  run(repo, 'git', 'add', '.');
  run(repo, 'git', 'commit', '-qm', message);
  return run(repo, 'git', 'rev-parse', 'HEAD');
}
function addReceipt(repo: string, path: string, baseCommit: string, headCommit: string, radiusFiles: string[]) {
  const identity = { headCommit, baseCommit, bunVersion: '1.4.2', lockfileHash: 'lock-hash', radiusFiles,
    checks: ['test-interference:with-neighbours'], envFingerprint: 'e'.repeat(64) };
  const receipt: GateReceipt = { ...identity, schema: 1, key: computeReceiptKey(identity, 'passed'), verdict: 'passed', savedAt: '2026-10-29T00:00:00.000Z' };
  saveGateReceipt(path, receipt);
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('release gate train receipt carry', () => {
  test('carries only unchanged test radius backed by an ancestor-base passing receipt', () => {
    const { repo } = fixture();
    const base = commit(repo, 'base');
    writeFileSync(join(repo, 'src/a.test.ts'), 'import { test } from "bun:test"; test("a", () => {});\n');
    const head = commit(repo, 'measured tests');
    const receiptPath = join(repo, '.git/receipts.json');
    addReceipt(repo, receiptPath, base, head, ['src/a.test.ts']);
    const plan = planGateTrainReceiptCarry({ repo, commit: head, receiptPath, bunVersion: '1.4.2',
      lockfileHash: 'lock-hash', envFingerprint: 'e'.repeat(64) });
    expect(plan).toMatchObject({ carriedFiles: ['src/a.test.ts'], files: ['src/other/b.test.ts'], totalFiles: 2 });
  });

  test('rejects a changed radius, changed environment, and non-ancestor base', () => {
    const { repo } = fixture();
    const base = commit(repo, 'base');
    writeFileSync(join(repo, 'src/a.test.ts'), 'test("a", () => {});\n');
    const head = commit(repo, 'measured');
    const receiptPath = join(repo, '.git/receipts.json');
    addReceipt(repo, receiptPath, base, head, ['src/a.test.ts']);
    writeFileSync(join(repo, 'src/a.test.ts'), 'test("changed", () => {});\n');
    const cut = commit(repo, 'changed radius');
    expect(planGateTrainReceiptCarry({ repo, commit: cut, receiptPath, bunVersion: '1.4.2', lockfileHash: 'lock-hash',
      envFingerprint: 'e'.repeat(64) })).toMatchObject({ carriedFiles: [], reasons: ['receipt radius changed or missing at cut'] });
    expect(planGateTrainReceiptCarry({ repo, commit: head, receiptPath, bunVersion: '1.4.2', lockfileHash: 'lock-hash',
      envFingerprint: 'f'.repeat(64) })).toMatchObject({ carriedFiles: [], reasons: ['bun/lockfile/environment differs'] });
    writeFileSync(join(repo, 'src/unrelated.ts'), 'export {};\n');
    const unrelated = commit(repo, 'descendant');
    const noAncestorPath = join(repo, '.git/bad-receipts.json');
    addReceipt(repo, noAncestorPath, unrelated, head, ['src/a.test.ts']);
    expect(planGateTrainReceiptCarry({ repo, commit: head, receiptPath: noAncestorPath, bunVersion: '1.4.2', lockfileHash: 'lock-hash',
      envFingerprint: 'e'.repeat(64) })).toMatchObject({ carriedFiles: [], reasons: ['receipt base is not an ancestor of cut'] });
    const uncoveredPath = join(repo, '.git/uncovered-receipts.json');
    addReceipt(repo, uncoveredPath, base, head, ['src/other/b.test.ts']);
    expect(planGateTrainReceiptCarry({ repo, commit: head, receiptPath: uncoveredPath, bunVersion: '1.4.2', lockfileHash: 'lock-hash',
      envFingerprint: 'e'.repeat(64) })).toMatchObject({ carriedFiles: [], reasons: ['receipt radius does not cover base-to-head changes'] });
  });

  test('re-runs a carried test when a merge-skew source change reaches it', () => {
    const { repo } = fixture();
    writeFileSync(join(repo, 'src/dep.ts'), 'export const value = 1;\n');
    writeFileSync(join(repo, 'src/a.test.ts'), 'import { test, expect } from "bun:test"; import { value } from "./dep"; test("a", () => expect(value).toBe(1));\n');
    const base = commit(repo, 'base with candidate test');
    writeFileSync(join(repo, 'src/a.test.ts'), 'import { test, expect } from "bun:test"; import { value } from "./dep"; test("a", () => expect(value).toBe(1)); test("receipt", () => {});\n');
    const measured = commit(repo, 'measure changed test');
    const receiptPath = join(repo, '.git/receipts.json');
    addReceipt(repo, receiptPath, base, measured, ['src/a.test.ts']);
    writeFileSync(join(repo, 'src/dep.ts'), 'export const value = 2;\n');
    const cut = commit(repo, 'merge skew changes dependency');
    const plan = planGateTrainReceiptCarry({ repo, commit: cut, receiptPath, bunVersion: '1.4.2',
      lockfileHash: 'lock-hash', envFingerprint: 'e'.repeat(64) });
    expect(plan).toMatchObject({ carriedFiles: [], files: ['src/a.test.ts', 'src/other/b.test.ts'], totalFiles: 2,
      reasons: ['merge-skew changes reach every receipt test'] });
  });
});
