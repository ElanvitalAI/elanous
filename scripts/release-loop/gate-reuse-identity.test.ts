import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gateLockfileHashAtCommit, gateTestedFileHashesAtCommit, sameGateTestedFileHashes } from './gate-reuse-identity.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('reuse identity hashes exact per-file git blobs and named lockfiles', () => {
  const repo = mkdtempSync(join(tmpdir(), 'gate-reuse-identity-')); roots.push(repo);
  const write = (file: string, contents: string) => { mkdirSync(dirname(join(repo, file)), { recursive: true }); writeFileSync(join(repo, file), contents); };
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  write('bun.lock', 'lock A\n'); write('apps/pwa/bun.lock', 'pwa lock A\n');
  write('src/a.test.ts', 'test("a", () => 1);\n'); write('src/b.test.ts', 'test("b", () => 2);\n');
  git('init', '-q'); git('config', 'user.name', 'Gate identity sim'); git('config', 'user.email', 'gate-identity@example.invalid');
  git('add', '.'); git('commit', '-qm', 'initial source');
  const first = git('rev-parse', 'HEAD');
  const firstHashes = gateTestedFileHashesAtCommit(repo, first, ['src/a.test.ts', 'src/b.test.ts'])!;
  const firstLock = gateLockfileHashAtCommit(repo, first)!;
  expect(Object.keys(firstHashes)).toEqual(['src/a.test.ts', 'src/b.test.ts']);
  expect(sameGateTestedFileHashes(firstHashes, { ...firstHashes })).toBe(true);

  write('src/b.test.ts', 'test("b repaired", () => 3);\n');
  git('add', 'src/b.test.ts'); git('commit', '-qm', 'repair one test');
  const repaired = git('rev-parse', 'HEAD');
  const repairedHashes = gateTestedFileHashesAtCommit(repo, repaired, ['src/a.test.ts', 'src/b.test.ts'])!;
  expect(repairedHashes['src/a.test.ts']).toBe(firstHashes['src/a.test.ts']);
  expect(repairedHashes['src/b.test.ts']).not.toBe(firstHashes['src/b.test.ts']);
  expect(gateLockfileHashAtCommit(repo, repaired)).toBe(firstLock);

  write('bun.lock', 'lock B\n');
  git('add', 'bun.lock'); git('commit', '-qm', 'change lockfile');
  const relocked = git('rev-parse', 'HEAD');
  expect(gateLockfileHashAtCommit(repo, relocked)).not.toBe(firstLock);
});
