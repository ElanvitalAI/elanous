import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { verifyOverlapEvidence } from './pr-land-overlap-evidence.js';
import { buildReviewScopeContractContext, proveReviewCarry } from './review-carry.js';
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

test('REVIEW-SCOPE-CONTRACT: six incident replays carry boundaries, PR evidence, and stale closed critiques', () => {
  const incidents = [
    { pr: 35647, body: '## Summary\nBreak the runtime import cycle across the PWA/Nexus show modules.\n\n## Verification\n18 test files passed; PWA build passed.', scope: 'Break the runtime import cycle', evidence: '18 test files passed; PWA build passed.', closed: 'already-fixed relative path' },
    { pr: 35651, body: '## Summary\nBreak the checker/registry cycle without changing loop checking or scheduling.\n\n## Test reach\n16 files, zero introduced failures; six baseline failures.\n\n## Verification\nDirect guard test: 1 pass.', scope: 'Break the checker/registry cycle without changing loop checking or scheduling.', evidence: 'Direct guard test: 1 pass.', closed: 'require full 1,225-module acyclic graph' },
    { pr: 35523, body: 'Update the release fan-out fake CLI to model held branch state and require readiness plus exact head pin before landing.', scope: 'Update the release fan-out fake CLI', closed: 'third review demands expansion beyond the fake CLI change' },
    { pr: 35720, body: '## Answer\nAdd a receipt-side summarizer for persisted shard dispositions; this PR intentionally contains no gate-node.ts wiring.\n\n## Validation\nNine tests passed; changed test files passed remotely.', scope: 'Add a receipt-side summarizer for persisted shard dispositions; this PR intentionally contains no gate-node.ts wiring.', evidence: 'Nine tests passed; changed test files passed remotely.', closed: 'add out-of-scope producer' },
    { pr: 35457, body: '## Change\nIsolate baseline gate failures with Pod batches and fail closed on incomplete results.\n\n## Verification\nFive tests passed; changed-file typecheck passed.', scope: 'Isolate baseline gate failures with Pod batches', evidence: 'Five tests passed; changed-file typecheck passed.', closed: 'review cap r5 exceeded' },
    { pr: 35542, body: '## Answer\nShare runtime identity for gate replay and SI allocation; cross-architecture reuse is a separate follow-up.\n\n## Verification\nCurrent head has no fresh tests or typecheck.', scope: 'Share runtime identity for gate replay and SI allocation; cross-architecture reuse is a separate follow-up.', evidence: 'Current head has no fresh tests or typecheck.', closed: 'review-cap-exceeded' },
  ];
  const replay = incidents.map((incident) => buildReviewScopeContractContext({
    prBody: incident.body,
    previouslyFixedFindings: [incident.closed],
  }));
  expect(replay).toHaveLength(6);
  for (let index = 0; index < incidents.length; index += 1) {
    const incident = incidents[index]!;
    const context = replay[index]!;
    expect(context).toContain('## Intentional scope boundary');
    expect(context).toContain(incident.scope);
    expect(context).toContain('## PR body evidence');
    if (incident.evidence) expect(context).toContain(incident.evidence);
    else expect(context).toContain('No explicit evidence section was found');
    expect(context).toContain(`[STALE — previously closed with evidence] ${incident.closed}`);
    expect(context).toContain('Do not re-raise');
  }
});

test('REVIEW-SCOPE-CONTRACT: Korean scope headings and nested evidence subsections survive extraction', () => {
  const context = buildReviewScopeContractContext({ prBody: '## 요약\n한 파일의 null guard만 수정한다.\n\n## Evidence\n### Tests\n원격 회귀 시험 1건 통과.', previouslyFixedFindings: [] });
  expect(context).toContain('### 요약\n한 파일의 null guard만 수정한다.');
  expect(context).toContain('### Evidence\n### Tests\n원격 회귀 시험 1건 통과.');
  expect(context).not.toContain('No explicit scope boundary or summary');
  expect(context).not.toContain('No explicit evidence section was found');
});

test('REVIEW-SCOPE-CONTRACT: heading depth is recognized while child sections remain inside parent evidence', () => {
  const context = buildReviewScopeContractContext({ prBody: '### 요약\nOne-file change.\n\n## Verification\n### Tests\nRemote test passed.' });
  expect(context).toContain('### 요약\nOne-file change.');
  expect(context).toContain('### Verification\n### Tests\nRemote test passed.');
});

test('REVIEW-SCOPE-CONTRACT: nested evidence is included once and later evidence sections survive truncation', () => {
  const nested = 'test evidence '.repeat(220);
  const context = buildReviewScopeContractContext({ prBody: `## Verification\n### Tests\n${nested}\n\n## Evidence\nLater independent gate result.` });
  expect(context).toContain(nested.trim());
  expect(context).toContain('### Evidence\nLater independent gate result.');
  expect(context.split('### Tests').length - 1).toBe(1);
});

test('REVIEW-SCOPE-CONTRACT: short sections return unused budget and all small evidence sections survive', () => {
  const long = 'verification detail '.repeat(220);
  const many = Array.from({ length: 13 }, (_, index) => `## Evidence ${index + 1}\nresult-${index + 1}`).join('\n\n');
  const context = buildReviewScopeContractContext({ prBody: `## Verification\n${long}\n\n## Evidence\nshort evidence\n\n${many}` });
  expect(context).toContain(long.trim());
  expect(context).toContain('short evidence');
  expect(context).toContain('### Evidence 13\nresult-13');
});

test('REVIEW-SCOPE-CONTRACT: zero body budget truncates content when section headings alone exceed the cap', () => {
  const largeBody = 'private-evidence-body '.repeat(50);
  const sections = Array.from({ length: 80 }, (_, index) => `## Evidence ${index + 1} ${'heading'.repeat(25)}\n${largeBody}`);
  const context = buildReviewScopeContractContext({ prBody: sections.join('\n\n') });
  expect(context).toContain('[scope/evidence section truncated;');
  expect(context).not.toContain(largeBody);
});
