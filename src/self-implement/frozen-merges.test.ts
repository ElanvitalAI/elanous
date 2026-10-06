import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { disableLandingFreeze, enableLandingFreeze } from '../release-loop/landing-freeze.js';
import { admitLandingMerge as realAdmitLandingMerge, claimPath, owningRepoRoot, pendingFrozenMerges, queueFrozenMerge, sweepFrozenMerges as realSweepFrozenMerges, tryLandingLock, type FrozenMerge } from './frozen-merges.js';

const admitLandingMerge = (...args: Parameters<typeof realAdmitLandingMerge>) => realAdmitLandingMerge(args[0], args[1], args[2], args[3], { prodFreezeRoot: args[1] });
const sweepFrozenMerges = (...args: Parameters<typeof realSweepFrozenMerges>) => realSweepFrozenMerges(args[0], args[1], args[2], args[1]);

const entry = { prNumber: 42, headCommit: 'a'.repeat(40), repoRoot: '/repo' };

/** A fake GitHub: a merge that passes records «merged at this head»; the sweep's confirmation reads it back. */
function github() {
  const merged = new Set<string>();
  const key = (item: FrozenMerge) => `${item.prNumber}@${item.headCommit}`;
  return {
    merged,
    alreadyMerged: (item: FrozenMerge) => merged.has(key(item)),
    merge: (passed = true, extra?: () => void) => async (item: FrozenMerge) => { extra?.(); if (passed) merged.add(key(item)); return { passed }; },
  };
}

test('host admission and resumed sweep in a child universe defer to operational freeze without merging', async () => {
  const root = mkdtempSync(join(tmpdir(), 'frozen-host-operational-'));
  const prod = join(root, 'prod');
  const child = join(root, 'child');
  try {
    enableLandingFreeze({ reason: 'release cut', by: 'OP' }, prod);
    const admission = realAdmitLandingMerge(entry, child, {}, entry, { prodFreezeRoot: prod });
    expect(admission.kind).toBe('held');
    expect(pendingFrozenMerges(child)).toBe(1);
    let merges = 0;
    expect(await realSweepFrozenMerges(async () => { merges++; return { passed: true }; }, child, () => false, prod)).toEqual({ pending: 1, merged: 0 });
    expect(merges).toBe(0);
    expect(pendingFrozenMerges(child)).toBe(1);
    disableLandingFreeze(prod);
    const gh = github();
    expect(await realSweepFrozenMerges(gh.merge(true), child, gh.alreadyMerged, prod)).toEqual({ pending: 0, merged: 1 });
    expect(gh.merged.size).toBe(1);
    enableLandingFreeze({ reason: 'second cut', by: 'OP' }, prod);
    queueFrozenMerge(entry, child);
    let swept = 0;
    expect(await realSweepFrozenMerges(async () => { swept++; return { passed: true }; }, child, () => false, prod)).toEqual({ pending: 1, merged: 0 });
    expect(swept).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('frozen PR remains queued; off resumes pinned merge on next sweep without losing failed work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'frozen-merge-'));
  try {
    const gh = github();
    enableLandingFreeze({ reason: 'drill', by: 'MK' }, root);
    queueFrozenMerge(entry, root);
    queueFrozenMerge(entry, root);
    const calls: number[] = [];
    const merge = async (item: typeof entry) => { calls.push(item.prNumber); return gh.merge(calls.length > 1)(item); };
    expect(await sweepFrozenMerges(merge, root, gh.alreadyMerged)).toEqual({ pending: 1, merged: 0 });
    expect(calls).toEqual([]);
    disableLandingFreeze(root);
    expect(await sweepFrozenMerges(merge, root, gh.alreadyMerged)).toEqual({ pending: 1, merged: 0 });
    expect(await sweepFrozenMerges(merge, root, gh.alreadyMerged)).toEqual({ pending: 0, merged: 1 });
    expect(calls).toEqual([42, 42]);
    expect(JSON.parse(readFileSync(join(root, 'landing-freeze-pending.json'), 'utf8'))).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a merge call that reports success is dequeued only after GitHub shows the PR merged at the held head', async () => {
  const root = mkdtempSync(join(tmpdir(), 'frozen-merge-confirm-'));
  try {
    queueFrozenMerge(entry, root);
    let checks = 0;
    const neverShown = () => { checks++; return false; };
    expect(await sweepFrozenMerges(async () => ({ passed: true }), root, neverShown)).toEqual({ pending: 1, merged: 0 });
    expect(checks).toBe(2); // before and after the merge call
    const gh = github();
    expect(await sweepFrozenMerges(gh.merge(true), root, gh.alreadyMerged)).toEqual({ pending: 0, merged: 1 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a concurrently queued PR survives cleanup of a successful merge', async () => {
  const root = mkdtempSync(join(tmpdir(), 'frozen-merge-concurrent-'));
  try {
    const gh = github();
    queueFrozenMerge(entry, root);
    const another = { ...entry, prNumber: 43 };
    expect(await sweepFrozenMerges(gh.merge(true, () => queueFrozenMerge(another, root)), root, gh.alreadyMerged)).toEqual({ pending: 1, merged: 1 });
    expect(JSON.parse(readFileSync(join(root, 'landing-freeze-pending.json'), 'utf8'))).toEqual([another]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a changed PR head is never dropped when the earlier HEAD is rejected', async () => {
  const root = mkdtempSync(join(tmpdir(), 'frozen-merge-head-'));
  try {
    const gh = github();
    queueFrozenMerge(entry, root);
    const changed = { ...entry, headCommit: 'b'.repeat(40) };
    let currentHead = entry.headCommit;
    // The PR moves to a new head while the sweep runs; a head-pinned merge of the old head is refused.
    const merge = async (item: FrozenMerge) => {
      queueFrozenMerge(changed, root, () => changed.headCommit); // GitHub now shows the new head
      currentHead = changed.headCommit;
      return gh.merge(item.headCommit === currentHead)(item);
    };
    expect(await sweepFrozenMerges(merge, root, gh.alreadyMerged)).toEqual({ pending: 1, merged: 0 });
    expect(gh.merged.size).toBe(0);
    expect(JSON.parse(readFileSync(join(root, 'landing-freeze-pending.json'), 'utf8'))).toEqual([changed]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an expired freeze reads as off and the next sweep resumes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'frozen-merge-expiry-'));
  try {
    const gh = github();
    enableLandingFreeze({ until: '2026-10-04T07:00:00Z' }, root, new Date('2026-10-04T06:00:00Z'));
    queueFrozenMerge(entry, root);
    expect(await sweepFrozenMerges(gh.merge(true), root, gh.alreadyMerged)).toEqual({ pending: 0, merged: 1 });
    // The expired file is left for `freeze off`/the next `freeze on` — deleting it while reading could race a new freeze.
    expect(existsSync(join(root, 'landing-freeze.json'))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a freeze lifted while the lander queues its PR hands the merge back to the lander, not to a later sweep', () => {
  const root = mkdtempSync(join(tmpdir(), 'frozen-merge-lifted-'));
  try {
    enableLandingFreeze({ reason: 'drill', by: 'OP' }, root);
    const admission = admitLandingMerge(entry, root, { afterQueue: () => disableLandingFreeze(root) });
    expect(admission.kind).toBe('merge');
    expect(pendingFrozenMerges(root)).toBe(1); // kept until the lander's merge is confirmed
    if (admission.kind === 'merge') admission.end(true);
    expect(pendingFrozenMerges(root)).toBe(0);
    enableLandingFreeze({ reason: 'drill', by: 'OP' }, root);
    expect(admitLandingMerge(entry, root).kind).toBe('held');
    expect(pendingFrozenMerges(root)).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a lander that finds its queued PR already claimed by a resume sweep leaves it to the sweep', () => {
  const root = mkdtempSync(join(tmpdir(), 'frozen-merge-taken-'));
  try {
    enableLandingFreeze({ reason: 'drill', by: 'OP' }, root);
    const release = tryLandingLock(claimPath(entry, root))!;
    try {
      expect(admitLandingMerge(entry, root, { afterQueue: () => disableLandingFreeze(root) }).kind).toBe('taken');
      expect(pendingFrozenMerges(root)).toBe(1);
    } finally { release(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('overlapping resume sweeps (freeze off and a supervision tick) merge each held PR once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'frozen-merge-overlap-'));
  try {
    const gh = github();
    queueFrozenMerge(entry, root);
    let merges = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const merge = async (item: FrozenMerge) => { merges++; await held; return gh.merge(true)(item); };
    const first = sweepFrozenMerges(merge, root, gh.alreadyMerged);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await sweepFrozenMerges(merge, root, gh.alreadyMerged);
    expect(second).toEqual({ pending: 1, merged: 0 });
    release();
    expect(await first).toEqual({ pending: 0, merged: 1 });
    expect(merges).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a lock whose holder exited is free again: the kernel drops flock, no reclaim step exists', async () => {
  const root = mkdtempSync(join(tmpdir(), 'frozen-merge-stale-'));
  try {
    const path = claimPath(entry, root);
    writeFileSync(path, 'left by an exited process');
    // Another process takes the lock and exits while holding it.
    const holder = Bun.spawnSync([process.execPath, '-e', `import(${JSON.stringify(join(import.meta.dir, 'frozen-merges.ts'))}).then((m) => { if (!m.tryLandingLock(${JSON.stringify(path)})) process.exit(3); process.exit(0); })`]);
    expect(holder.exitCode).toBe(0);
    const gh = github();
    queueFrozenMerge(entry, root);
    let merges = 0;
    expect(await sweepFrozenMerges(async (item) => { merges++; return gh.merge(true)(item); }, root, gh.alreadyMerged)).toEqual({ pending: 0, merged: 1 });
    expect(merges).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a PR GitHub already shows merged at the held head is dequeued without another merge (duplicate runner)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'frozen-merge-already-'));
  try {
    queueFrozenMerge(entry, root);
    let merges = 0;
    expect(await sweepFrozenMerges(async () => { merges++; return { passed: true }; }, root, () => true)).toEqual({ pending: 0, merged: 1 });
    expect(merges).toBe(0);
    queueFrozenMerge(entry, root);
    // A losing duplicate whose head-pinned merge is refused still dequeues once GitHub shows the merge.
    let checks = 0;
    expect(await sweepFrozenMerges(async () => ({ passed: false }), root, () => checks++ > 0)).toEqual({ pending: 0, merged: 1 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('held merges record the repository that owns the run worktree: plain, separate git dir, and bare', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'frozen-merge-owner-')));
  const git = (...args: string[]) => { const r = Bun.spawnSync(['git', ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }); if (r.exitCode !== 0) throw new Error(r.stderr.toString()); };
  try {
    git('init', '-q', join(root, 'plain'));
    git('-C', join(root, 'plain'), 'commit', '-q', '--allow-empty', '-m', 'init');
    git('-C', join(root, 'plain'), 'worktree', 'add', '-q', join(root, 'plain-wt'));
    expect(owningRepoRoot(join(root, 'plain-wt'))).toBe(join(root, 'plain'));
    git('init', '-q', '--separate-git-dir', join(root, 'sep.git'), join(root, 'sep'));
    git('-C', join(root, 'sep'), 'commit', '-q', '--allow-empty', '-m', 'init');
    git('-C', join(root, 'sep'), 'worktree', 'add', '-q', join(root, 'sep-wt'));
    // git names the separate git dir as the main entry; it outlives the run worktree and git (so gh) works in it.
    const separate = owningRepoRoot(join(root, 'sep-wt'));
    expect(separate).toBe(join(root, 'sep.git'));
    expect(Bun.spawnSync(['git', '-C', separate!, 'rev-parse', '--git-dir']).exitCode).toBe(0);
    git('clone', '-q', '--bare', join(root, 'plain'), join(root, 'bare.git'));
    git('-C', join(root, 'bare.git'), 'worktree', 'add', '-q', join(root, 'bare-wt'));
    expect(owningRepoRoot(join(root, 'bare-wt'))).toBe(join(root, 'bare.git'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a held PR whose owning repository is unknown is kept for a person and never resumed by a sweep', async () => {
  const root = mkdtempSync(join(tmpdir(), 'frozen-merge-manual-'));
  try {
    const gh = github();
    queueFrozenMerge({ ...entry, manual: true }, root);
    let merges = 0;
    expect(await sweepFrozenMerges(async (item) => { merges++; return gh.merge(true)(item); }, root, gh.alreadyMerged)).toEqual({ pending: 1, merged: 0 });
    expect(merges).toBe(0);
    expect(owningRepoRoot(join(root, 'not-a-repo'))).toBeNull();
    expect(owningRepoRoot(root, (() => { throw new Error('spawn ENOENT'); }) as unknown as typeof Bun.spawnSync)).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a lander that took its PR back keeps it claimed until its merge ends: a second lander (freeze off) and a sweep stand aside', async () => {
  const root = mkdtempSync(join(tmpdir(), 'frozen-merge-two-landers-'));
  try {
    enableLandingFreeze({ reason: 'drill', by: 'OP' }, root);
    const first = admitLandingMerge(entry, root, { afterQueue: () => disableLandingFreeze(root) }, entry);
    expect(first.kind).toBe('merge');
    // The freeze stays off: a second lander of the same PR must not start a merge while the first one holds it.
    let secondMerges = 0;
    const second = admitLandingMerge(entry, root, {}, entry);
    if (second.kind === 'merge') { secondMerges++; second.end(); }
    expect(second.kind).toBe('taken');
    expect(secondMerges).toBe(0);
    const gh = github();
    queueFrozenMerge(entry, root);
    let merges = 0;
    expect(await sweepFrozenMerges(async (item) => { merges++; return gh.merge(true)(item); }, root, gh.alreadyMerged)).toEqual({ pending: 1, merged: 0 });
    expect(merges).toBe(0);
    if (first.kind === 'merge') first.end();
    expect(admitLandingMerge(entry, root, {}, entry).kind).toBe('merge');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a lander does not merge a PR that a resume sweep merged and dequeued between its queueing and its claim', () => {
  const root = mkdtempSync(join(tmpdir(), 'frozen-merge-swept-'));
  try {
    enableLandingFreeze({ reason: 'drill', by: 'OP' }, root);
    const sweptMeanwhile = () => {
      disableLandingFreeze(root);
      writeFileSync(join(root, 'landing-freeze-pending.json'), '[]\n'); // the sweep merged and removed it
    };
    expect(admitLandingMerge(entry, root, { afterQueue: sweptMeanwhile }, entry).kind).toBe('taken');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('claims are per repository: the same PR number in another repository is not held back', () => {
  const root = mkdtempSync(join(tmpdir(), 'frozen-merge-repos-'));
  try {
    const release = tryLandingLock(claimPath(entry, root))!;
    try {
      const other = admitLandingMerge({ ...entry, repoRoot: '/other-repo' }, root, {}, { prNumber: entry.prNumber, repoRoot: '/other-repo' });
      expect(other.kind).toBe('merge');
      if (other.kind === 'merge') other.end();
      expect(admitLandingMerge(entry, root, {}, entry).kind).toBe('taken');
    } finally { release(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a lander arriving late with an older head of the same PR does not replace the newer held head', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'frozen-merge-older-head-')));
  const git = (...args: string[]) => { const r = Bun.spawnSync(['git', '-C', join(root, 'repo'), ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }); if (r.exitCode !== 0) throw new Error(r.stderr.toString()); return r.stdout.toString().trim(); };
  try {
    Bun.spawnSync(['git', 'init', '-q', join(root, 'repo')]);
    git('commit', '-q', '--allow-empty', '-m', 'one');
    const older = git('rev-parse', 'HEAD');
    git('commit', '-q', '--allow-empty', '-m', 'two');
    const newer = git('rev-parse', 'HEAD');
    const state = join(root, 'state');
    queueFrozenMerge({ prNumber: 7, headCommit: newer, repoRoot: join(root, 'repo') }, state);
    queueFrozenMerge({ prNumber: 7, headCommit: older, repoRoot: join(root, 'repo') }, state);
    expect(JSON.parse(readFileSync(join(state, 'landing-freeze-pending.json'), 'utf8')).map((item: FrozenMerge) => item.headCommit)).toEqual([newer]);
    // In the forward direction the newer head replaces the older one.
    queueFrozenMerge({ prNumber: 8, headCommit: older, repoRoot: join(root, 'repo') }, state);
    queueFrozenMerge({ prNumber: 8, headCommit: newer, repoRoot: join(root, 'repo') }, state);
    expect(JSON.parse(readFileSync(join(state, 'landing-freeze-pending.json'), 'utf8')).filter((item: FrozenMerge) => item.prNumber === 8).map((item: FrozenMerge) => item.headCommit)).toEqual([newer]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('when git cannot order two heads (objects not local), GitHub decides; if GitHub cannot say either, the held head stays', () => {
  const root = mkdtempSync(join(tmpdir(), 'frozen-merge-unknown-order-'));
  try {
    const newer = 'c'.repeat(40), older = 'd'.repeat(40);
    queueFrozenMerge({ ...entry, headCommit: newer }, root, () => newer);
    queueFrozenMerge({ ...entry, headCommit: older }, root, () => newer);
    expect(JSON.parse(readFileSync(join(root, 'landing-freeze-pending.json'), 'utf8')).map((item: FrozenMerge) => item.headCommit)).toEqual([newer]);
    queueFrozenMerge({ ...entry, headCommit: older }, root, () => null);
    expect(JSON.parse(readFileSync(join(root, 'landing-freeze-pending.json'), 'utf8')).map((item: FrozenMerge) => item.headCommit)).toEqual([newer]);
    // GitHub showing the incoming head as current lets it replace the held one.
    const moved = 'e'.repeat(40);
    queueFrozenMerge({ ...entry, headCommit: moved }, root, () => moved);
    expect(JSON.parse(readFileSync(join(root, 'landing-freeze-pending.json'), 'utf8')).map((item: FrozenMerge) => item.headCommit)).toEqual([moved]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('after the freeze is lifted, a new lander of a still-queued PR takes its claim and dequeues it; a concurrent sweep stands aside', async () => {
  const root = mkdtempSync(join(tmpdir(), 'frozen-merge-new-lander-'));
  try {
    queueFrozenMerge(entry, root);
    const admission = admitLandingMerge(entry, root, {}, entry);
    expect(admission.kind).toBe('merge');
    const gh = github();
    let merges = 0;
    expect(await sweepFrozenMerges(async (item) => { merges++; return gh.merge(true)(item); }, root, gh.alreadyMerged)).toEqual({ pending: 1, merged: 0 });
    expect(merges).toBe(0);
    if (admission.kind === 'merge') admission.end(true);
    expect(pendingFrozenMerges(root)).toBe(0);
    // A PR never held by a freeze takes no claim at all.
    const plain = admitLandingMerge({ ...entry, prNumber: 99 }, root, {}, { prNumber: 99, repoRoot: entry.repoRoot });
    expect(plain.kind).toBe('merge');
    expect(existsSync(claimPath({ prNumber: 99, repoRoot: entry.repoRoot }, root))).toBe(false);
    if (plain.kind === 'merge') plain.end();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('after the freeze is lifted, a lander with an older head dequeues only its own head; a newer held head stays', () => {
  const root = mkdtempSync(join(tmpdir(), 'frozen-merge-own-head-'));
  try {
    const newer = { ...entry, headCommit: 'f'.repeat(40) };
    queueFrozenMerge(newer, root);
    const stale = admitLandingMerge(entry, root, {}, entry);
    expect(stale.kind).toBe('merge');
    if (stale.kind === 'merge') stale.end(true);
    expect(JSON.parse(readFileSync(join(root, 'landing-freeze-pending.json'), 'utf8')).map((item: FrozenMerge) => item.headCommit)).toEqual([newer.headCommit]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the GitHub head lookup runs outside the queue lock: another writer is not blocked while it waits', () => {
  const root = mkdtempSync(join(tmpdir(), 'frozen-merge-lookup-'));
  try {
    queueFrozenMerge(entry, root);
    let otherWrote = false;
    queueFrozenMerge({ ...entry, headCommit: 'c'.repeat(40) }, root, () => {
      queueFrozenMerge({ ...entry, prNumber: 77 }, root); // would time out if the lock were held here
      otherWrote = true;
      return null;
    });
    expect(otherWrote).toBe(true);
    expect(pendingFrozenMerges(root)).toBe(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a lander whose merge fails after the freeze is lifted leaves the held entry for the next sweep', async () => {
  const root = mkdtempSync(join(tmpdir(), 'frozen-merge-lander-fails-'));
  try {
    queueFrozenMerge(entry, root);
    const admission = admitLandingMerge(entry, root, {}, entry);
    expect(admission.kind).toBe('merge');
    if (admission.kind === 'merge') admission.end(false);
    expect(pendingFrozenMerges(root)).toBe(1);
    const gh = github();
    expect(await sweepFrozenMerges(gh.merge(true), root, gh.alreadyMerged)).toEqual({ pending: 0, merged: 1 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a confirmed merge without a known head dequeues nothing; the sweep later drops it once GitHub shows it merged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'frozen-merge-no-head-'));
  try {
    queueFrozenMerge(entry, root);
    const admission = admitLandingMerge(null, root, {}, { prNumber: entry.prNumber, repoRoot: entry.repoRoot });
    expect(admission.kind).toBe('merge');
    if (admission.kind === 'merge') admission.end(true);
    expect(pendingFrozenMerges(root)).toBe(1);
    expect(await sweepFrozenMerges(async () => ({ passed: false }), root, () => true)).toEqual({ pending: 0, merged: 1 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a repository reached through a symlink is the same repository: one queue entry, one claim', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'frozen-merge-alias-')));
  try {
    mkdirSync(join(root, 'repo'));
    symlinkSync(join(root, 'repo'), join(root, 'alias'));
    const state = join(root, 'state');
    const real = { ...entry, repoRoot: join(root, 'repo') };
    const alias = { ...entry, repoRoot: join(root, 'alias') };
    queueFrozenMerge(real, state);
    queueFrozenMerge(alias, state);
    expect(pendingFrozenMerges(state)).toBe(1);
    const first = admitLandingMerge(real, state, {}, real);
    expect(first.kind).toBe('merge');
    expect(admitLandingMerge(alias, state, {}, alias).kind).toBe('taken');
    const gh = github();
    let merges = 0;
    expect(await sweepFrozenMerges(async (item) => { merges++; return gh.merge(true)(item); }, state, gh.alreadyMerged)).toEqual({ pending: 1, merged: 0 });
    expect(merges).toBe(0);
    if (first.kind === 'merge') first.end(true);
    expect(pendingFrozenMerges(state)).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
