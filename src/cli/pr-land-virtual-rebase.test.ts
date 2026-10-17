import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyVirtualRebasePatch } from './pr-land-virtual-rebase.js';
import { verifyOverlapEvidence, verifyOverlapEvidenceVirtualRebase } from './pr-land-overlap-evidence.js';
import { verifyPinnedOverlapDecision, type PrLandDeps } from './pr-cli.js';
import type { CmdRunner } from '../autopilot/pr-manager.js';

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'virtual-rebase-test-'));
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.name', 'Virtual Rebase Test');
  git(cwd, 'config', 'user.email', 'virtual@example.test');
  writeFileSync(join(cwd, 'file.txt'), Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join(''));
  git(cwd, 'add', 'file.txt');
  git(cwd, 'commit', '-m', 'base');
  const base = git(cwd, 'rev-parse', 'HEAD');
  const change = (index: number, value: string) => {
    const path = join(cwd, 'file.txt');
    const lines = readFileSync(path, 'utf8').split('\n');
    lines[index] = value;
    writeFileSync(path, lines.join('\n'));
    git(cwd, 'add', 'file.txt');
    git(cwd, 'commit', '-m', value);
  };
  return { cwd, base, change, clean: () => rmSync(cwd, { recursive: true, force: true }) };
}

function evidenceFixture(cwd: string, head: string, baseTip: string, reviewHead = head) {
  const pr = 28865;
  const reviewDir = join(cwd, '.state', 'review-results');
  mkdirSync(reviewDir, { recursive: true });
  const reviewResult = join(reviewDir, `card-${pr}-${head.slice(0, 12)}.json`);
  const evidencePath = join(cwd, '.state', 'overlap.json');
  writeFileSync(reviewResult, JSON.stringify({ pr, headCommit: reviewHead, reviewed: true, verdict: 'warn', mustFix: [] }));
  writeFileSync(evidencePath, JSON.stringify({ pr, head, reviewResult, gate: {
    passed: true, head, baseCommit: git(cwd, 'merge-base', baseTip, head),
  } }));
  git(cwd, 'update-ref', 'refs/remotes/origin/main', baseTip);
  const run: CmdRunner = (command, args) => {
    if (command === 'git' && args[0] === 'ls-remote') return { ok: true, out: `${baseTip}\trefs/heads/main\n`, err: '' };
    const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
    return { ok: result.status === 0, out: result.stdout ?? '', err: result.stderr ?? '' };
  };
  return {
    evidencePath, pr, expectedHead: head, remote: 'origin', branch: 'main', cwd, run,
    readFile: (path: string) => readFileSync(path, 'utf8'), reviewResultsDir: reviewDir,
    listDir: (dir: string) => readdirSync(dir), reviewMtime: (path: string) => statSync(path).mtimeMs,
    reviewRealPath: (path: string) => realpathSync(path), overlappingLandings: [baseTip],
  };
}

describe('LAND-VIRTUAL-REBASE patch proof', () => {
  test('evidence with a stale overlapping base reuses its exact-head review after a clean same-patch virtual rebase', () => {
    const f = fixture();
    try {
      git(f.cwd, 'switch', '-c', 'feature');
      f.change(25, 'feature line');
      const head = git(f.cwd, 'rev-parse', 'HEAD');
      git(f.cwd, 'switch', 'main');
      f.change(2, 'main line');
      const baseTip = git(f.cwd, 'rev-parse', 'HEAD');
      const evidence = evidenceFixture(f.cwd, head, baseTip);
      const initial = verifyOverlapEvidence(evidence);
      expect(initial).toMatchObject({ ok: false, reason: expect.stringContaining('base-stale-overlap:'), baseTip });
      expect(verifyOverlapEvidenceVirtualRebase(evidence, baseTip)).toMatchObject({ ok: true, reviewResult: join(f.cwd, '.state', 'review-results', `card-28865-${head.slice(0, 12)}.json`) });
      const messages: string[] = [];
      const decision = () => verifyPinnedOverlapDecision({
        opts: { pr: String(evidence.pr), expectedHead: head, overlapEvidence: evidence.evidencePath, dryRun: true },
        deps: { reviewResultsDir: evidence.reviewResultsDir } as PrLandDeps,
        run: evidence.run, cwd: f.cwd, base: 'main', readFile: evidence.readFile,
        overlappingLandings: [baseTip], decision: 'unavailable',
        out: { log: (line) => messages.push(line), error: (line) => messages.push(line) },
        refuse: (line) => messages.push(line),
      });
      expect(decision()).toBe(true);
      expect(messages.filter((line) => line.startsWith('✓ overlap-evidence: virtual-rebase'))).toHaveLength(1);
      const validEvidence = JSON.parse(readFileSync(evidence.evidencePath, 'utf8'));
      for (const [gate, reason] of [
        [undefined, 'gate-missing'],
        [{ ...validEvidence.gate, passed: false }, 'gate-not-passed'],
        [{ ...validEvidence.gate, head: f.base }, 'gate-head-mismatch'],
      ] as const) {
        writeFileSync(evidence.evidencePath, JSON.stringify({ ...validEvidence, gate }));
        expect(verifyOverlapEvidenceVirtualRebase(evidence, baseTip)).toEqual({ ok: false, reason });
        expect(decision()).toBe(false);
      }
      writeFileSync(evidence.evidencePath, JSON.stringify(validEvidence));
      const badReview = evidenceFixture(f.cwd, head, baseTip, f.base);
      expect(verifyOverlapEvidenceVirtualRebase(badReview, baseTip)).toEqual({ ok: false, reason: 'review-head-mismatch', baseTip });
      expect(decision()).toBe(false);
    } finally { f.clean(); }
  }, 30_000);

  test('evidence virtual rebase refuses a changed patch and a stale local base', () => {
    const f = fixture();
    try {
      git(f.cwd, 'switch', '-c', 'feature');
      f.change(25, 'feature line');
      const head = git(f.cwd, 'rev-parse', 'HEAD');
      git(f.cwd, 'switch', 'main');
      f.change(23, 'main nearby line');
      const baseTip = git(f.cwd, 'rev-parse', 'HEAD');
      const evidence = evidenceFixture(f.cwd, head, baseTip);
      expect(verifyOverlapEvidenceVirtualRebase(evidence, baseTip)).toEqual({ ok: false, reason: 'patch-id-different' });
      const refusals: string[] = [];
      expect(verifyPinnedOverlapDecision({
        opts: { pr: String(evidence.pr), expectedHead: head, overlapEvidence: evidence.evidencePath, dryRun: true },
        deps: { reviewResultsDir: evidence.reviewResultsDir } as PrLandDeps,
        run: evidence.run, cwd: f.cwd, base: 'main', readFile: evidence.readFile,
        overlappingLandings: [baseTip], decision: 'unavailable',
        out: { log: () => {}, error: (line) => refusals.push(line) },
        refuse: (line) => refusals.push(line),
      })).toBe(false);
      expect(refusals.some((line) => line.includes('patch-id-different'))).toBe(true);
      git(f.cwd, 'update-ref', 'refs/remotes/origin/main', f.base);
      expect(verifyOverlapEvidenceVirtualRebase(evidence, baseTip)).toEqual({ ok: false, reason: 'virtual-rebase-base-stale-or-unmeasured' });
    } finally { f.clean(); }
  }, 30_000);

  test('a different hunk keeps the reviewed patch while refs, FETCH_HEAD and object store stay unchanged', () => {
    const f = fixture();
    try {
      git(f.cwd, 'switch', '-c', 'feature');
      f.change(25, 'feature line');
      const head = git(f.cwd, 'rev-parse', 'HEAD');
      git(f.cwd, 'switch', 'main');
      f.change(2, 'main line');
      const baseTip = git(f.cwd, 'rev-parse', 'HEAD');
      const fetchHead = join(f.cwd, '.git', 'FETCH_HEAD');
      writeFileSync(fetchHead, 'sentinel\n');
      const refs = git(f.cwd, 'show-ref');
      const objectCount = git(f.cwd, 'count-objects', '-v');
      const result = verifyVirtualRebasePatch({ cwd: f.cwd, baseTip, head });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.oldBase).toBe(f.base);
      expect(git(f.cwd, 'show-ref')).toBe(refs);
      expect(git(f.cwd, 'count-objects', '-v')).toBe(objectCount);
      expect(readFileSync(fetchHead, 'utf8')).toBe('sentinel\n');
      git(f.cwd, 'switch', 'feature');
      git(f.cwd, 'merge', '--no-edit', 'main');
      const mergedLines = readFileSync(join(f.cwd, 'file.txt'), 'utf8').split('\n');
      expect(mergedLines[2]).toBe('main line');
      expect(mergedLines[25]).toBe('feature line');
    } finally { f.clean(); }
  });

  test('the same line conflicts and does not reuse review', () => {
    const f = fixture();
    try {
      git(f.cwd, 'switch', '-c', 'feature');
      f.change(25, 'feature line');
      const head = git(f.cwd, 'rev-parse', 'HEAD');
      git(f.cwd, 'switch', 'main');
      f.change(25, 'main line');
      expect(verifyVirtualRebasePatch({ cwd: f.cwd, baseTip: git(f.cwd, 'rev-parse', 'HEAD'), head })).toEqual({ ok: false, reason: 'merge-tree-conflict-or-unmeasured' });
    } finally { f.clean(); }
  });

  test('binary and empty patches fail closed', () => {
    const f = fixture();
    try {
      writeFileSync(join(f.cwd, 'blob.bin'), Buffer.from([0, 1, 2]));
      writeFileSync(join(f.cwd, '.gitattributes'), '*.bin diff\n');
      git(f.cwd, 'add', 'blob.bin', '.gitattributes');
      git(f.cwd, 'commit', '-m', 'binary base');
      const binaryBase = git(f.cwd, 'rev-parse', 'HEAD');
      git(f.cwd, 'switch', '-c', 'feature');
      writeFileSync(join(f.cwd, 'blob.bin'), Buffer.from([0, 3, 2]));
      git(f.cwd, 'add', 'blob.bin');
      git(f.cwd, 'commit', '-m', 'binary feature');
      const binaryHead = git(f.cwd, 'rev-parse', 'HEAD');
      git(f.cwd, 'switch', 'main');
      f.change(2, 'main line');
      const baseTip = git(f.cwd, 'rev-parse', 'HEAD');
      expect(git(f.cwd, 'diff', '--numstat', binaryBase, binaryHead)).toMatch(/^\d+\t\d+\tblob\.bin$/u);
      expect(verifyVirtualRebasePatch({ cwd: f.cwd, baseTip, head: binaryHead })).toEqual({ ok: false, reason: 'binary-patch' });
      git(f.cwd, 'switch', '-c', 'empty-feature');
      git(f.cwd, 'commit', '--allow-empty', '-m', 'empty feature');
      expect(verifyVirtualRebasePatch({ cwd: f.cwd, baseTip, head: git(f.cwd, 'rev-parse', 'HEAD') })).toEqual({ ok: false, reason: 'empty-patch' });
    } finally { f.clean(); }
  });

  test('renames and copies do not reuse a content review', () => {
    const f = fixture();
    try {
      git(f.cwd, 'switch', '-c', 'rename-feature');
      git(f.cwd, 'mv', 'file.txt', 'renamed.txt');
      git(f.cwd, 'commit', '-m', 'rename feature');
      const renamedHead = git(f.cwd, 'rev-parse', 'HEAD');
      git(f.cwd, 'switch', 'main');
      writeFileSync(join(f.cwd, 'other.txt'), 'main\n');
      git(f.cwd, 'add', 'other.txt');
      git(f.cwd, 'commit', '-m', 'main change');
      const baseTip = git(f.cwd, 'rev-parse', 'HEAD');
      expect(verifyVirtualRebasePatch({ cwd: f.cwd, baseTip, head: renamedHead })).toEqual({ ok: false, reason: 'rename-or-copy' });

      git(f.cwd, 'switch', '-c', 'copy-feature', f.base);
      writeFileSync(join(f.cwd, 'copy.txt'), readFileSync(join(f.cwd, 'file.txt')));
      git(f.cwd, 'add', 'copy.txt');
      git(f.cwd, 'commit', '-m', 'copy feature');
      expect(verifyVirtualRebasePatch({ cwd: f.cwd, baseTip, head: git(f.cwd, 'rev-parse', 'HEAD') })).toEqual({ ok: false, reason: 'rename-or-copy' });
    } finally { f.clean(); }
  });
});
