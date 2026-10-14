/** Apply a Pod repair commit to the already bound PR branch after exact-head checks. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const SHA40 = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
export const REPAIR_BUNDLE_REF = 'refs/elanous/repair/result';

export interface RepairCommitResult {
  pr: number;
  baseHead: string;
  /** Parent repair run binding; required by the HQ worker before CAS. */
  runId?: string;
  commit: string;
  bundleSha256: string;
}

export interface RepairCasRequest {
  repo: string;
  pr: number;
  expectedHead: string;
  bundlePath: string;
  result: RepairCommitResult;
  /** A previous push succeeded. Confirmation may inspect the remote and PR, but must never push again. */
  confirmationOnly?: boolean;
  branch?: string;
  /** Persist a single-use push intent after bundle/ancestry checks and before the push side effect. */
  claimBeforePush?: () => boolean;
}

export interface RepairCasDeps {
  git(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string };
  prView(cwd: string, pr: number): { state: string; head: string; branch: string; crossRepository: boolean; headRepo: string } | null;
  originRepo(cwd: string): string | null;
  sleep?(ms: number): void;
}

export type RepairCasOutcome = { ok: true; fromHead: string; toHead: string; branch: string }
  | { ok: false; reason: string; unconfirmed?: true };

const CONFIRM_DELAYS_MS = [0, 150, 350, 700] as const;
const sleep = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

const defaultDeps: RepairCasDeps = {
  git(cwd, args) {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120_000 });
    return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
  },
  prView(cwd, pr) {
    const r = spawnSync('gh', ['pr', 'view', String(pr), '--json', 'state,headRefOid,headRefName,isCrossRepository,headRepository'], { cwd, encoding: 'utf8', timeout: 30_000 });
    if (r.status !== 0) return null;
    try {
      const v = JSON.parse(String(r.stdout)) as Record<string, unknown>;
      const headRepo = v.headRepository && typeof v.headRepository === 'object'
        ? (v.headRepository as Record<string, unknown>).nameWithOwner : undefined;
      if (typeof v.state !== 'string' || typeof v.headRefOid !== 'string' || typeof v.headRefName !== 'string' || typeof headRepo !== 'string'
        || typeof v.isCrossRepository !== 'boolean') return null;
      return { state: v.state, head: v.headRefOid, branch: v.headRefName, crossRepository: v.isCrossRepository, headRepo };
    } catch { return null; }
  },
  originRepo(cwd) {
    const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', timeout: 30_000 });
    if (r.status !== 0) return null;
    const url = String(r.stdout).trim();
    const match = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url);
    return match?.[1]?.toLowerCase() ?? null;
  },
};

/** Bundle verification and fetch use an isolated ref: concurrent FETCH_HEAD writers cannot substitute another commit. */
export function applyRepairBundle(request: RepairCasRequest, deps: RepairCasDeps = defaultDeps): RepairCasOutcome {
  const { repo, pr, expectedHead, bundlePath, result } = request;
  const fail = (reason: string): RepairCasOutcome => ({ ok: false, reason });
  if (!Number.isSafeInteger(pr) || pr < 1 || result.pr !== pr || !SHA40.test(expectedHead) || !SHA40.test(result.baseHead)
    || !SHA40.test(result.commit) || !SHA256.test(result.bundleSha256) || result.baseHead.toLowerCase() !== expectedHead.toLowerCase()) {
    return fail('repair result identity or head mismatch');
  }
  if (result.commit.toLowerCase() === expectedHead.toLowerCase()) return fail('repair produced no new commit');
  const git = (args: string[]) => deps.git(repo, args);
  const initial = deps.prView(repo, pr);
  const originRepo = deps.originRepo(repo);
  const pending = (reason: string): RepairCasOutcome => ({ ok: false, unconfirmed: true, reason });
  if (request.confirmationOnly) {
    if (!request.branch || git(['check-ref-format', '--branch', request.branch]).status !== 0) return fail('confirmed repair branch name invalid');
    if (!originRepo) return pending('repair origin identity unavailable; PR head confirmation pending');
    if (!initial) return pending('PR head unavailable; confirmation pending');
    if (initial.state !== 'OPEN' || initial.crossRepository || initial.headRepo.toLowerCase() !== originRepo || initial.branch !== request.branch)
      return pending('repair PR identity not yet stable; confirmation pending');
    const remoteRef = `refs/heads/${request.branch}`;
    const remote = git(['ls-remote', '--exit-code', 'origin', remoteRef]);
    const [remoteHead, remoteName] = remote.stdout.trim().split('\t');
    if (remote.status !== 0 || remoteName !== remoteRef || remoteHead?.toLowerCase() !== result.commit.toLowerCase())
      return pending('repair remote head differs from pushed commit; confirmation pending');
    if (initial.head.toLowerCase() !== result.commit.toLowerCase()) return pending('repair commit is on the remote branch; PR head confirmation pending');
    return { ok: true, fromHead: expectedHead, toHead: result.commit, branch: request.branch };
  }
  let bytes: Buffer;
  try { bytes = readFileSync(bundlePath); } catch { return fail('repair bundle unreadable'); }
  if (createHash('sha256').update(bytes).digest('hex') !== result.bundleSha256.toLowerCase()) return fail('repair bundle sha256 mismatch');
  if (!initial || !originRepo || initial.headRepo.toLowerCase() !== originRepo) return fail('PR head repository differs from git origin');
  const alreadyApplied = initial?.head.toLowerCase() === result.commit.toLowerCase();
  if (!initial || initial.state !== 'OPEN' || initial.crossRepository || (!alreadyApplied && initial.head.toLowerCase() !== expectedHead.toLowerCase()))
    return fail('PR head CAS mismatch or PR unavailable');
  if (!initial.branch || git(['check-ref-format', '--branch', initial.branch]).status !== 0) return fail('PR branch name invalid');
  const initialRemoteRef = `refs/heads/${initial.branch}`;
  const verifyImportedCommit = (): string | null => {
    if (git(['cat-file', '-e', `${expectedHead}^{commit}`]).status !== 0 || git(['bundle', 'verify', bundlePath]).status !== 0)
      return 'repair base or bundle unavailable';
    const localRef = `refs/elanous/repair/import/${pr}-${expectedHead.slice(0, 12)}-${result.commit.slice(0, 12)}`;
    if (git(['fetch', bundlePath, `${REPAIR_BUNDLE_REF}:${localRef}`]).status !== 0
      || git(['rev-parse', localRef]).stdout.trim().toLowerCase() !== result.commit.toLowerCase()
      || git(['merge-base', '--is-ancestor', expectedHead, result.commit]).status !== 0)
      return 'repair commit verification failed';
    return null;
  };
  // A successful push can be visible on origin before gh pr view catches up. Never issue a
  // second leased push for that same commit while the PR API is still reporting the old head.
  if (!alreadyApplied) {
    const remote = git(['ls-remote', '--exit-code', 'origin', initialRemoteRef]);
    const [remoteHead, remoteName] = remote.stdout.trim().split('\t');
    if (remote.status === 0 && remoteName === initialRemoteRef && remoteHead?.toLowerCase() === result.commit.toLowerCase()) {
      const invalid = verifyImportedCommit();
      return invalid ? fail(invalid) : pending('repair commit is on the remote branch; PR head confirmation pending');
    }
  }
  if (alreadyApplied) {
    // A prior process may have pushed and died before recording the card result. Recheck the artifact
    // and exact remote ref before returning the same success; never push a second time.
    const advertised = git(['ls-remote', '--exit-code', 'origin', initialRemoteRef]);
    const [remoteHead, remoteName] = advertised.stdout.trim().split('\t');
    if (advertised.status !== 0 || remoteName !== initialRemoteRef || remoteHead?.toLowerCase() !== result.commit.toLowerCase()) return fail('already-applied PR head remote mismatch');
    const invalid = verifyImportedCommit();
    if (invalid) return fail(`already-applied ${invalid}`);
    return { ok: true, fromHead: expectedHead, toHead: result.commit, branch: initial.branch };
  }
  // The HQ checkout need not have fetched this PR before. Pin its source commit in an isolated ref;
  // never use FETCH_HEAD, which another concurrent worker may replace.
  const baseRef = `refs/elanous/repair/base/${pr}-${expectedHead.slice(0, 12)}`;
  if (git(['fetch', 'origin', `refs/heads/${initial.branch}:${baseRef}`]).status !== 0
    || git(['rev-parse', baseRef]).stdout.trim().toLowerCase() !== expectedHead.toLowerCase()) return fail('reviewed PR head fetch mismatch');
  if (git(['bundle', 'verify', bundlePath]).status !== 0) return fail('repair bundle verification failed');
  const localRef = `refs/elanous/repair/import/${pr}-${expectedHead.slice(0, 12)}-${result.commit.slice(0, 12)}`;
  if (git(['fetch', bundlePath, `${REPAIR_BUNDLE_REF}:${localRef}`]).status !== 0) return fail('repair bundle fetch failed');
  const imported = git(['rev-parse', localRef]).stdout.trim();
  if (imported.toLowerCase() !== result.commit.toLowerCase()) return fail('repair bundle commit mismatch');
  if (git(['merge-base', '--is-ancestor', expectedHead, result.commit]).status !== 0) return fail('repair commit is not a descendant of reviewed PR head');
  if (expectedHead.toLowerCase() === result.commit.toLowerCase()) return fail('repair produced no new commit');
  const view = deps.prView(repo, pr);
  if (!view || view.headRepo.toLowerCase() !== originRepo || view.state !== 'OPEN' || view.crossRepository || view.head.toLowerCase() !== expectedHead.toLowerCase()
    || view.branch !== initial.branch) return fail('PR head CAS mismatch or PR unavailable');
  if (!view.branch || git(['check-ref-format', '--branch', view.branch]).status !== 0) return fail('PR branch name invalid');
  const remoteRef = `refs/heads/${view.branch}`;
  const advertised = git(['ls-remote', '--exit-code', 'origin', remoteRef]);
  const [remoteHead, remoteName] = advertised.stdout.trim().split('\t');
  if (advertised.status !== 0 || remoteName !== remoteRef || remoteHead?.toLowerCase() !== expectedHead.toLowerCase()) return fail('remote branch CAS mismatch');
  if (request.claimBeforePush) {
    try { if (!request.claimBeforePush()) return fail('repair push intent claim refused'); }
    catch (error) { return fail(`repair push intent claim failed: ${error instanceof Error ? error.message : String(error)}`); }
  }
  // OP 2026-10-13 #1109, RFC §6a D3: the contract is "do not overwrite another commit".
  // Two conditions enforce it: result.commit descends from expectedHead (checked above), and
  // the exact-head lease rejects any intervening remote move. No '+' refspec is retained for clarity,
  // but --force-with-lease can force non-FF even without '+': it is NOT a separate safety condition.
  const push = git(['push', `--force-with-lease=${remoteRef}:${expectedHead}`, 'origin', `${result.commit}:${remoteRef}`]);
  if (push.status !== 0) {
    const reason = `exact-head fast-forward push result uncertain: ${(push.stderr || push.stdout).trim().slice(-200)}`;
    return request.claimBeforePush ? pending(reason) : fail(`exact-head fast-forward push rejected: ${(push.stderr || push.stdout).trim().slice(-200)}`);
  }
  for (const delay of CONFIRM_DELAYS_MS) {
    if (delay) (deps.sleep ?? sleep)(delay);
    const after = deps.prView(repo, pr);
    if (after?.state === 'OPEN' && !after.crossRepository && after.headRepo.toLowerCase() === originRepo
      && after.head.toLowerCase() === result.commit.toLowerCase() && after.branch === view.branch) {
      const remote = git(['ls-remote', '--exit-code', 'origin', remoteRef]);
      const [remoteHead, remoteName] = remote.stdout.trim().split('\t');
      if (remote.status === 0 && remoteName === remoteRef && remoteHead?.toLowerCase() === result.commit.toLowerCase())
        return { ok: true, fromHead: expectedHead, toHead: result.commit, branch: view.branch };
    }
  }
  return { ok: false, unconfirmed: true, reason: 'push succeeded; PR head confirmation pending' };
}
