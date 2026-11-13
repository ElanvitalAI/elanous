import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { manualApply, sweep, type CleanupKind } from './machine-sanitize.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fixture = () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'sanitize-test-'));
  roots.push(root);
  writeFileSync(join(root, '.elanous-sanitize-owned'), 'machine-sanitize-v1\n');
  return root;
};
const child = (root: string, name: string, kind: CleanupKind = 'scratch', pid = 99_999_999) => {
  const path = join(root, name);
  mkdirSync(path);
  writeFileSync(join(path, '.elanous-sanitize-owned'), JSON.stringify({ kind, pid }));
  utimesSync(path, new Date('2026-11-10T00:00:00Z'), new Date('2026-11-10T00:00:00Z'));
  return path;
};

test('inventory finds only marked stale scratch and never moves it', () => {
  const root = fixture();
  const stale = child(root, 'elanous-sanitize-scratch-stale');
  child(root, 'elanous-sanitize-scratch-active', 'scratch', process.pid);
  const evidence = child(root, 'elanous-sanitize-scratch-evidence');
  const secret = child(root, 'elanous-sanitize-scratch-secret-file');
  writeFileSync(join(secret, 'secret.txt'), 'must stay');
  const nested = child(root, 'elanous-sanitize-scratch-nested');
  mkdirSync(join(nested, 'payload'));
  writeFileSync(join(nested, 'payload', 'credentials.json'), '{}');
  const link = join(root, 'elanous-sanitize-scratch-link');
  symlinkSync(stale, link);
  const now = new Date('2026-11-12T08:00:00Z');
  const preview = sweep(root, 'light', false, now);
  expect(preview.before.candidates).toBe(1);
  expect(preview.after.quarantined).toBe(0);
  expect(existsSync(stale)).toBe(true);
  const receipt = sweep(root, 'light', false, now);
  expect(receipt.after).toEqual({ candidates: 1, quarantined: 0 });
  expect(existsSync(stale)).toBe(true);
  expect(() => sweep(root, 'light', true, now)).toThrow('apply is deferred');
  expect(existsSync(stale)).toBe(true);
  expect(existsSync(evidence)).toBe(true);
  expect(readFileSync(join(secret, 'secret.txt'), 'utf8')).toBe('must stay');
  expect(existsSync(nested)).toBe(true);
  expect(lstatSync(link).isSymbolicLink()).toBe(true); // link is never followed or moved
});

test('heavy inventory sees marked cache and log while light skips both; apply remains gated', () => {
  const root = fixture();
  const cache = child(root, 'elanous-sanitize-cache-bun', 'cache');
  const log = child(root, 'elanous-sanitize-log-rotation', 'log');
  const wrongKind = child(root, 'elanous-sanitize-cache-wrong-marker', 'scratch');
  const now = new Date('2026-11-12T08:00:00Z');
  expect(sweep(root, 'light', false, now).before.candidates).toBe(0);
  const heavy = sweep(root, 'heavy', false, now);
  expect(heavy.candidates.map(row => row.kind).sort()).toEqual(['cache', 'log']);
  expect(heavy.after).toEqual({ candidates: 2, quarantined: 0 });
  expect(() => sweep(root, 'heavy', true, now)).toThrow('apply is deferred');
  expect(existsSync(cache)).toBe(true);
  expect(existsSync(log)).toBe(true);
  expect(existsSync(wrongKind)).toBe(true);
});

test('legacy scratch names remain candidates while explicit cache and log names require matching markers', () => {
  const root = fixture();
  const legacy = child(root, 'elanous-sanitize-stale');
  const bareKindWord = child(root, 'elanous-sanitize-cache');
  const wrongCache = child(root, 'elanous-sanitize-cache-wrong', 'scratch');
  const wrongLog = child(root, 'elanous-sanitize-log-wrong', 'cache');
  const now = new Date('2026-11-12T08:00:00Z');
  for (const mode of ['light', 'heavy'] as const) {
    const receipt = sweep(root, mode, false, now);
    expect(receipt.candidates.map(row => row.path).sort()).toEqual([legacy, bareKindWord].sort());
    expect(receipt.candidates.every(row => row.kind === 'scratch')).toBe(true);
    expect(receipt.skipped).toContain('elanous-sanitize-cache-wrong');
    expect(receipt.skipped).toContain('elanous-sanitize-log-wrong');
    expect(receipt.after.quarantined).toBe(0);
  }
  for (const path of [legacy, bareKindWord, wrongCache, wrongLog]) expect(existsSync(path)).toBe(true);
});

test('global or unmarked root fails closed', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'sanitize-unmarked-'));
  roots.push(root);
  expect(() => sweep(root, 'heavy', false)).toThrow('ownership marker');
  expect(() => sweep(realpathSync(tmpdir()), 'light', false)).toThrow('global scratch root');
  writeFileSync(join(root, '.elanous-sanitize-owned'), 'wrong-owner\n');
  expect(() => sweep(root, 'heavy', false)).toThrow('valid ownership marker');
});

test('manual apply refuses an occupied receipt before moving a candidate', () => {
  const root = fixture();
  const stale = child(root, 'elanous-sanitize-scratch-occupied');
  const receipt = join(root, 'occupied.json');
  writeFileSync(receipt, 'keep');
  expect(() => manualApply(root, 'light', receipt, 'TEST#1', new Date('2026-11-12T08:00:00Z'))).toThrow('EEXIST');
  expect(existsSync(stale)).toBe(true);
  expect(readFileSync(receipt, 'utf8')).toBe('keep');
});

test('manual apply leaves a durable prepared receipt when final publication fails after a move', () => {
  const root = fixture();
  const stale = child(root, 'elanous-sanitize-scratch-final-failure');
  const receipt = join(root, 'prepared.json');
  const occupiedFinal = `${receipt}.final-${process.pid}`;
  expect(() => manualApply(root, 'light', receipt, 'TEST#2', new Date('2026-11-12T08:00:00Z'), () => {
    writeFileSync(occupiedFinal, 'block final publication');
  })).toThrow('EEXIST');
  const prepared = JSON.parse(readFileSync(receipt, 'utf8')) as { phase: string; planned: { source: string; target: string }[] };
  expect(prepared.phase).toBe('prepared');
  expect(prepared.planned[0]?.source).toBe(stale);
  expect(existsSync(stale)).toBe(false);
  expect(existsSync(prepared.planned[0]!.target)).toBe(true);
  expect(readFileSync(occupiedFinal, 'utf8')).toBe('block final publication');
});

test('manual apply final receipt records a marked stale cache quarantine', () => {
  const root = fixture();
  const stale = child(root, 'elanous-sanitize-cache-manual', 'cache');
  const receipt = join(root, 'final.json');
  const result = manualApply(root, 'heavy', receipt, 'TEST#3', new Date('2026-11-12T08:00:00Z'));
  const final = JSON.parse(readFileSync(receipt, 'utf8')) as { phase: string; approvalRef: string; receipt: { after: { quarantined: number } } };
  expect(final.phase).toBe('final');
  expect(final.approvalRef).toBe('TEST#3');
  expect(final.receipt.after.quarantined).toBe(1);
  expect(result.after.quarantined).toBe(1);
  expect(existsSync(stale)).toBe(false);
});

test('root and ancestor links or protected paths fail before any sweep', () => {
  const root = fixture();
  const actual = join(root, 'actual');
  mkdirSync(actual);
  writeFileSync(join(actual, '.elanous-sanitize-owned'), 'machine-sanitize-v1\n');
  symlinkSync(actual, join(root, 'root-link'));
  expect(() => sweep(join(root, 'root-link'), 'light', false)).toThrow('real directory');
  symlinkSync(root, join(root, 'ancestor-link'));
  expect(() => sweep(join(root, 'ancestor-link', 'actual'), 'light', false)).toThrow('real directory');
  const protectedParent = join(root, 'claims');
  mkdirSync(protectedParent);
  const protectedRoot = join(protectedParent, 'scratch');
  mkdirSync(protectedRoot);
  writeFileSync(join(protectedRoot, '.elanous-sanitize-owned'), 'machine-sanitize-v1\n');
  expect(() => sweep(protectedRoot, 'light', false)).toThrow('protected scratch root or ancestor');
});

test('plural protected names inside a marked scratch are excluded from inventory', () => {
  const root = fixture();
  const stale = child(root, 'elanous-sanitize-scratch-plural');
  mkdirSync(join(stale, 'claims'));
  mkdirSync(join(stale, 'secrets'));
  utimesSync(stale, new Date('2026-11-10T00:00:00Z'), new Date('2026-11-10T00:00:00Z'));
  const receipt = sweep(root, 'light', false, new Date('2026-11-12T08:00:00Z'));
  expect(receipt.before.candidates).toBe(0);
  expect(receipt.after.quarantined).toBe(0);
  expect(existsSync(stale)).toBe(true);
});

test('inventory leaves a public existing quarantine and stale scratch untouched', () => {
  const root = fixture();
  const stale = child(root, 'elanous-sanitize-scratch-stale');
  const quarantine = join(root, '.quarantine');
  mkdirSync(quarantine);
  chmodSync(quarantine, 0o755);
  const receipt = sweep(root, 'light', false, new Date('2026-11-12T08:00:00Z'));
  expect(receipt.before.candidates).toBe(1);
  expect(receipt.after.quarantined).toBe(0);
  expect(lstatSync(quarantine).mode & 0o777).toBe(0o755);
  expect(existsSync(stale)).toBe(true);
});

test('daily recipe inventories stale scratch, cache and log without moving them', () => {
  const root = fixture();
  const stale = child(root, 'elanous-sanitize-scratch-stale');
  const cache = child(root, 'elanous-sanitize-cache-bun', 'cache');
  const log = child(root, 'elanous-sanitize-log-rotation', 'log');
  const recipes = parse(readFileSync(new URL('../../graphs/ops/recipes.yaml', import.meta.url), 'utf8')) as Record<string, { command: string }>;
  const command = recipes['machine-sanitize-heavy']?.command;
  expect(command).toBeDefined();
  expect(command!.split(/\s+/)).not.toContain('--apply');
  const receipt = sweep(root, 'heavy', false, new Date('2026-11-12T08:00:00Z'));
  expect(receipt.before.candidates).toBe(3);
  expect(receipt.candidates.map(row => row.kind).sort()).toEqual(['cache', 'log', 'scratch']);
  expect(receipt.after.quarantined).toBe(0);
  expect(existsSync(stale)).toBe(true);
  expect(existsSync(cache)).toBe(true);
  expect(existsSync(log)).toBe(true);
});

test('receipt write failure cannot move any inventoried candidate', () => {
  const root = fixture();
  const stale = child(root, 'elanous-sanitize-scratch-receipt-preflight');
  const occupied = join(root, 'existing-receipt.json');
  writeFileSync(occupied, 'keep existing receipt');
  for (const receipt of [occupied, join(root, 'missing-parent', 'receipt.json')]) {
    const run = spawnSync('bun', ['scripts/ops/machine-sanitize.ts', '--root', root, '--mode', 'light', '--receipt', receipt], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 10_000, // Source: .rules/30-harness/testing-gates.md — bounded test child
    });
    expect(run.status).toBe(1);
    expect(existsSync(stale)).toBe(true);
  }
  expect(readFileSync(occupied, 'utf8')).toBe('keep existing receipt');
});

test('missing receipt operand fails before root initialization', () => {
  const root = fixture();
  const absent = join(root, 'not-created');
  const run = spawnSync('bun', ['scripts/ops/machine-sanitize.ts', '--root', absent, '--mode', 'light', '--init-root', '--receipt'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 10_000, // Source: .rules/30-harness/testing-gates.md — bounded test child
  });
  expect(run.status).toBe(2);
  expect(run.stderr).toContain('--receipt requires a path');
  expect(existsSync(absent)).toBe(false);
});

test('manual apply rejects a missing approval value even when the next token is a flag', () => {
  const root = fixture();
  const stale = child(root, 'elanous-sanitize-scratch-no-approval');
  const receipt = join(root, 'no-approval.json');
  const run = spawnSync('bun', ['scripts/ops/machine-sanitize.ts', '--root', root, '--mode', 'light',
    '--approval-ref', '--apply', '--manual-apply', '--receipt', receipt], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 10_000, // Source: .rules/30-harness/testing-gates.md — bounded test child
  });
  expect(run.status).not.toBe(0);
  expect(run.stderr).toContain('manual apply requires --apply, --receipt and --approval-ref');
  expect(existsSync(stale)).toBe(true);
  expect(existsSync(receipt)).toBe(false);
});

test('stdout failure retains a complete inventory receipt without moving candidates', () => {
  const root = fixture();
  const stale = child(root, 'elanous-sanitize-scratch-stdout-failure');
  const receipt = join(root, 'new-receipt.json');
  const preload = join(root, 'throw-stdout.ts');
  writeFileSync(preload, "process.stdout.write = () => { throw new Error('injected stdout failure'); };\n");
  const run = spawnSync('bun', ['--preload', preload, 'scripts/ops/machine-sanitize.ts', '--root', root, '--mode', 'light', '--receipt', receipt], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 10_000, // Source: .rules/30-harness/testing-gates.md — bounded test child
  });
  expect(run.status).toBe(1);
  expect(run.stderr).toContain('injected stdout failure');
  expect(existsSync(stale)).toBe(true);
  const published = JSON.parse(readFileSync(receipt, 'utf8')) as { after: { quarantined: number } };
  expect(published.after.quarantined).toBe(0);
});

test('CLI rejects apply before initializing a root or writing a receipt', () => {
  const root = fixture();
  const absent = join(root, 'not-created');
  const receipt = join(root, 'not-created.json');
  const run = spawnSync('bun', ['scripts/ops/machine-sanitize.ts', '--root', absent, '--mode', 'light', '--init-root', '--apply', '--receipt', receipt], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 10_000, // Source: .rules/30-harness/testing-gates.md — bounded test child
  });
  expect(run.status).toBe(2);
  expect(run.stderr).toContain('apply is deferred');
  expect(existsSync(absent)).toBe(false);
  expect(existsSync(receipt)).toBe(false);
});
