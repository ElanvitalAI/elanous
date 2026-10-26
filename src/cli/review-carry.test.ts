import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { verifyOverlapEvidence } from './pr-land-overlap-evidence.js';
import { proveReviewCarry } from './review-carry.js';
import type { CmdRunner } from '../autopilot/pr-manager.js';

function fixture(conflict = false) {
  const cwd = mkdtempSync(join(tmpdir(), 'review-carry-'));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'Review Carry');
  git('config', 'user.email', 'review-carry@example.test');
  writeFileSync(join(cwd, 'shared.txt'), 'before\n');
  git('add', '.'); git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  git('switch', '-c', 'feature');
  writeFileSync(join(cwd, conflict ? 'shared.txt' : 'feature.txt'), 'feature\n');
  git('add', '.'); git('commit', '-m', 'feature');
  const oldHead = git('rev-parse', 'HEAD');
  git('switch', 'main');
  writeFileSync(join(cwd, conflict ? 'shared.txt' : 'main.txt'), 'main\n');
  git('add', '.'); git('commit', '-m', 'main advanced');
  const mainHead = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', mainHead);
  git('switch', 'feature');
  if (conflict) {
    const merge = spawnSync('git', ['merge', '--no-ff', '--no-edit', 'main'], { cwd, encoding: 'utf8' });
    expect(merge.status).not.toBe(0);
    writeFileSync(join(cwd, 'shared.txt'), 'resolved\n');
    git('add', '.'); git('commit', '-m', 'manual resolution');
  } else git('merge', '--no-ff', '--no-edit', 'main');
  const newHead = git('rev-parse', 'HEAD');
  return { cwd, git, base, oldHead, mainHead, newHead };
}

test('REVIEW-CARRY: clean main merge is accepted by the land overlap consumer with pinned old review', () => {
  const f = fixture();
  try {
    const proof = proveReviewCarry(f.cwd, f.oldHead, f.newHead);
    expect(proof.ok).toBe(true);
    if (!proof.ok) throw new Error(proof.reason);
    f.git('update-ref', 'refs/remotes/upstream/release', f.mainHead);
    expect(proveReviewCarry(f.cwd, f.oldHead, f.newHead, 'upstream', 'release')).toMatchObject({ ok: true });
    const dir = join(f.cwd, 'review-results');
    mkdirSync(dir);
    const reviewResult = join(dir, `card-42-${f.oldHead.slice(0, 12)}.json`);
    const review = JSON.stringify({ pr: 42, headCommit: f.oldHead, reviewed: true, verdict: 'pass', mustFix: [] });
    writeFileSync(reviewResult, review);
    const evidencePath = join(f.cwd, 'overlap.json');
    const evidence = { pr: 42, head: f.newHead, reviewResult,
      gate: { head: f.newHead, baseCommit: f.mainHead, passed: true },
      reviewCarry: { oldHead: f.oldHead, ...proof, reviewSha256: createHash('sha256').update(review).digest('hex') } };
    writeFileSync(evidencePath, JSON.stringify(evidence));
    const run: CmdRunner = (cmd, args) => {
      if (cmd === 'git' && args[0] === 'ls-remote') return { ok: true,
        out: `${f.mainHead}\trefs/heads/main\n`, err: '' };
      const result = spawnSync(cmd, args, { cwd: f.cwd, encoding: 'utf8' });
      return { ok: result.status === 0, out: result.stdout, err: result.stderr };
    };
    const verify = (overlappingLandings = [f.mainHead]) => verifyOverlapEvidence({ evidencePath, pr: 42, expectedHead: f.newHead,
      remote: 'origin', branch: 'main', cwd: f.cwd, run, readFile: (path) => readFileSync(path, 'utf8'),
      reviewResultsDir: dir, listDir: readdirSync, reviewMtime: (path) => statSync(path).mtimeMs,
      reviewRealPath: realpathSync, overlappingLandings });
    expect(verify()).toMatchObject({ ok: true, mode: 'already-ancestor', reviewResult });
    writeFileSync(evidencePath, JSON.stringify({ ...evidence, gate: undefined }));
    expect(verify()).toMatchObject({ ok: false, reason: 'carry-new-head-gate-missing-or-mismatch' });
    writeFileSync(evidencePath, JSON.stringify(evidence));
    expect(verify([])).toMatchObject({ ok: true, mode: 'rebased', reviewResult });
    for (const key of ['oldBase', 'newBase', 'patchId', 'pathsModesHash'] as const) {
      writeFileSync(evidencePath, JSON.stringify({ ...evidence,
        reviewCarry: { ...evidence.reviewCarry, [key]: '0'.repeat(key === 'pathsModesHash' ? 64 : 40) } }));
      expect(verify()).toMatchObject({ ok: false, reason: 'carry-proof-mismatch' });
    }
    writeFileSync(evidencePath, JSON.stringify({ ...evidence,
      reviewCarry: { ...evidence.reviewCarry, reviewSha256: '0'.repeat(64) } }));
    expect(verify()).toMatchObject({ ok: false, reason: 'carry-review-hash-mismatch' });
    writeFileSync(evidencePath, JSON.stringify(evidence));
    writeFileSync(join(dir, `card-42-${f.newHead.slice(0, 12)}.json`), review);
    expect(verify()).toMatchObject({ ok: false, reason: 'carry-new-head-review-exists' });
  } finally { rmSync(f.cwd, { recursive: true, force: true }); }
}, 30_000);

test('REVIEW-CARRY: code commit after merge and manual conflict resolution are refused', () => {
  const clean = fixture();
  const conflicted = fixture(true);
  try {
    writeFileSync(join(clean.cwd, 'extra.ts'), 'new code\n');
    clean.git('add', '.'); clean.git('commit', '-m', 'extra code');
    expect(proveReviewCarry(clean.cwd, clean.oldHead, clean.git('rev-parse', 'HEAD')))
      .toMatchObject({ ok: false, reason: 'carry-not-direct-main-merge' });
    expect(proveReviewCarry(conflicted.cwd, conflicted.oldHead, conflicted.newHead))
      .toMatchObject({ ok: false, reason: 'carry-merge-conflict-or-unmeasured' });
  } finally {
    rmSync(clean.cwd, { recursive: true, force: true });
    rmSync(conflicted.cwd, { recursive: true, force: true });
  }
}, 30_000);
