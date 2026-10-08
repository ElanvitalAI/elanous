import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dlopen, FFIType } from 'bun:ffi';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { effectiveInstanceRoot, prodInstanceRoot } from '../instance/resolve.js';
import { debug } from '../debug/log.js';
import { enterJourneyNode, exitJourneyNode, passJourneyNode, withJourneyNodeSync } from '../self-dev/graph-journey-nodes.js';
import { routeJourneyEdge } from '../self-dev/graph-journey-route.js';
import { beginLandingMerge, type LandingFreeze } from '../release-loop/landing-freeze.js';

/** `manual`: the owning repository could not be determined — a sweep never resumes it; a person does. */
export interface FrozenMerge { prNumber: number; headCommit: string; repoRoot: string; manual?: true; /** Host goal document, so a resumed merge can still apply its «이 칸 완료» declaration (CL-AUTO). */ goalFile?: string }
/** What a resume sweep hands its merge function: the held entry, marked as already claimed by this sweep. */
export type ResumedMerge = FrozenMerge & { resumed: true };

function queuePath(root: string): string { return join(root, 'landing-freeze-pending.json'); }

/** flock(2) through bun:ffi — the kernel drops the lock when its holder exits, so there is no stale lock to reclaim
 *  and no reclaim race. The lock file itself is never deleted (unlinking a flock file would split later lockers). */
const LOCK_EX = 2, LOCK_NB = 4;
let flockCall: ((fd: number, op: number) => number) | undefined;
function flock(fd: number, op: number): number {
  if (!flockCall) {
    const names = process.platform === 'darwin' ? ['libc.dylib'] : ['libc.so.6', `libc.musl-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}.so.1`];
    let lastError: unknown;
    for (const name of names) {
      try {
        const lib = dlopen(name, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
        flockCall = (descriptor, operation) => lib.symbols.flock(descriptor, operation) as number;
        break;
      } catch (error) { lastError = error; }
    }
    if (!flockCall) throw new Error(`flock unavailable (${names.join(', ')}): ${String(lastError)}`);
  }
  return flockCall(fd, op);
}

export function tryLandingLock(path: string): (() => void) | null {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a', 0o600);
  if (flock(fd, LOCK_EX | LOCK_NB) !== 0) { closeSync(fd); return null; }
  let released = false;
  return () => { if (!released) { released = true; closeSync(fd); } };
}

function tryLock(path: string): (() => void) | null { return tryLandingLock(path); }

function lockedQueue<T>(root: string, action: () => T): T {
  mkdirSync(root, { recursive: true });
  const path = join(root, 'landing-freeze-pending.lock');
  const deadline = Date.now() + 5_000;
  let release = tryLock(path);
  while (!release) {
    if (Date.now() >= deadline) throw new Error(`frozen merge queue lock busy: ${path}`);
    Bun.sleepSync(25);
    release = tryLock(path);
  }
  try { return action(); }
  finally { release(); }
}

function readQueue(root: string): FrozenMerge[] {
  const path = queuePath(root);
  if (!existsSync(path)) return [];
  const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(data) || !data.every((item) => item && typeof item === 'object' &&
    Number.isSafeInteger(item.prNumber) && item.prNumber > 0 &&
    typeof item.headCommit === 'string' && /^[a-f0-9]{40}$/i.test(item.headCommit) &&
    typeof item.repoRoot === 'string' && item.repoRoot.length > 0 &&
    (item.manual === undefined || item.manual === true) &&
    (item.goalFile === undefined || (typeof item.goalFile === 'string' && item.goalFile.length > 0)))) throw new Error(`invalid frozen merge queue: ${path}`);
  return data as FrozenMerge[];
}

function writeQueue(root: string, entries: FrozenMerge[]): void {
  mkdirSync(root, { recursive: true });
  const path = queuePath(root);
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}

/** Ordering of two heads of one PR in `repoRoot`: 'older' when `a` is a strict ancestor of `b`, 'newer' when `b` is one
 *  of `a`, otherwise unknown (unrelated, or git cannot see both objects). */
function headOrder(repoRoot: string, a: string, b: string): 'older' | 'newer' | 'unknown' {
  const ancestor = (x: string, y: string) => {
    try { return Bun.spawnSync(['git', '-C', repoRoot, 'merge-base', '--is-ancestor', x, y], { env: process.env }).exitCode === 0; }
    catch { return false; }
  };
  if (a === b) return 'unknown';
  if (ancestor(a, b)) return 'older';
  if (ancestor(b, a)) return 'newer';
  return 'unknown';
}

/** GitHub's current head of the PR, or null when it cannot be read. */
function githubHead(entry: FrozenMerge): string | null {
  try {
    const gh = Bun.which('gh', { PATH: process.env.PATH ?? '' }) ?? 'gh';
    const view = Bun.spawnSync([gh, 'pr', 'view', String(entry.prNumber), '--json', 'headRefOid'], { cwd: entry.repoRoot, env: process.env, timeout: 30_000 });
    if (view.exitCode !== 0) return null;
    const head = (JSON.parse(view.stdout.toString()) as { headRefOid?: string }).headRefOid;
    return typeof head === 'string' && /^[0-9a-f]{40}$/i.test(head) ? head : null;
  } catch { return null; }
}

export function queueFrozenMerge(entry: FrozenMerge, root = effectiveInstanceRoot(), currentHead: (entry: FrozenMerge) => string | null = githubHead): void {
  if (!Number.isSafeInteger(entry.prNumber) || entry.prNumber <= 0 || !/^[0-9a-f]{40}$/i.test(entry.headCommit) || !entry.repoRoot) throw new Error('invalid frozen merge entry');
  const repoRoot = repoIdentity(entry.repoRoot);
  // Slow lookups (git, GitHub) happen outside the queue lock; inside it only the held head they were judged against
  // is re-checked — if it changed meanwhile, the judgement is made again.
  for (let attempt = 0; attempt < 3; attempt++) {
    const seen = readQueue(root).find((item) => item.repoRoot === repoRoot && item.prNumber === entry.prNumber)?.headCommit;
    let keepExisting = false;
    let by = 'none';
    if (seen && seen !== entry.headCommit) {
      const order = headOrder(repoRoot, entry.headCommit, seen);
      if (order !== 'unknown') { keepExisting = order === 'older'; by = 'ancestry'; }
      else { keepExisting = currentHead({ ...entry, repoRoot }) !== entry.headCommit; by = 'github-or-unknown'; }
    }
    const done = lockedQueue(root, () => {
      const current = readQueue(root);
      const existing = current.find((item) => item.repoRoot === repoRoot && item.prNumber === entry.prNumber);
      if (existing?.headCommit !== seen) return false; // changed while we looked: judge again
      if (existing && keepExisting) {
        debug.log('harness.merge', 'frozen-head-kept', { pr: entry.prNumber, kept: existing.headCommit, ignored: entry.headCommit, by });
        return true;
      }
      writeQueue(root, [...current.filter((item) => item !== existing), { ...entry, repoRoot }]);
      return true;
    });
    if (done) return;
  }
  throw new Error(`frozen merge queue kept changing for PR ${entry.prNumber}`);
}

export function pendingFrozenMerges(root = effectiveInstanceRoot()): number { return readQueue(root).length; }

/** The repository a run worktree belongs to, as a path that outlives the worktree: the main worktree when there is
 *  one (also with a separate git dir), else the bare repository directory; the worktree itself only if git cannot say. */
export function owningRepoRoot(worktree: string, spawn: typeof Bun.spawnSync = Bun.spawnSync): string | null {
  let list: ReturnType<typeof Bun.spawnSync>;
  try { list = spawn(['git', '-C', worktree, 'worktree', 'list', '--porcelain'], { env: process.env }); }
  catch { return null; } // git could not even run: unknown owner — the held PR stays for a person
  if (list.exitCode === 0) {
    const first = (list.stdout?.toString() ?? "").split('\n\n')[0] ?? '';
    const path = /^worktree (.+)$/m.exec(first)?.[1];
    if (path) return path; // main worktree, or the bare repository directory (gh reads the remote from the git dir)
  }
  return null;
}

const sameEntry = (a: FrozenMerge, b: FrozenMerge) => a.prNumber === b.prNumber && a.repoRoot === b.repoRoot && a.headCommit === b.headCommit;

/** One runner per held PR: whoever creates the claim file (resume sweep or the original lander) merges it. */
/** One identity per repository path: symlinks and `..` resolve to the real path (absolute path when it does not exist). */
export function repoIdentity(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** A claim names the repository as well as the PR number — the queue tells PRs apart the same way. */
export function claimPath(key: { prNumber: number; repoRoot: string }, root: string): string {
  const repo = createHash('sha256').update(repoIdentity(key.repoRoot)).digest('hex').slice(0, 12);
  return join(root, `landing-freeze-claim-${key.prNumber}-${repo}.lock`);
}

function claimFrozenMerge(entry: FrozenMerge, root: string): { release: () => void } | null {
  mkdirSync(root, { recursive: true });
  const release = tryLock(claimPath(entry, root));
  return release ? { release } : null;
}

export type LandingAdmission =
  | { kind: 'merge'; /** `true` once the merge is confirmed: drops this lander's own held entry. */ end: (merged?: boolean) => void }
  | { kind: 'held'; freeze: LandingFreeze }
  | { kind: 'taken' };

/** Gate one merge/publication on the freeze. While frozen the entry is queued; if the freeze is lifted while queueing,
 *  the entry is taken back and the caller merges now — unless a resume sweep already claimed it ('taken'). */
export function admitLandingMerge(
  heldEntry: FrozenMerge | null | (() => FrozenMerge | null),
  root = effectiveInstanceRoot(),
  hooks: { afterQueue?: () => void } = {},
  claimKey?: { prNumber: number; repoRoot: string; headCommit?: string },
  opts: { prodFreezeRoot?: string; forceReason?: string } = {},
): LandingAdmission {
  // HARNESS-FULL-GRAPH — 병합 직전 한 곳의 동결 검사가 그래프 노드 freeze-check(출구: open | frozen | taken)이고,
  // 동결이면 보류 대기열이 노드 hold 다. 판정은 바꾸지 않는다 — 관측만.
  const pr = claimKey?.prNumber;
  enterJourneyNode('freeze-check', { provenance: 'admit-landing-merge', ...(pr === undefined ? {} : { data: { pr } }) });
  const admission = withJourneyNodeSync('freeze-check', { provenance: 'admit-landing-merge', ...(pr === undefined ? {} : { data: { pr } }) },
    () => admitLandingMergeUnobserved(heldEntry, root, hooks, claimKey, opts));
  const freezeLabel = admission.kind === 'merge' ? 'open' : admission.kind === 'held' ? 'frozen' : 'taken';
  exitJourneyNode('freeze-check', { provenance: 'admit-landing-merge', outcome: freezeLabel, ...(pr === undefined ? {} : { data: { pr } }) });
  // 2판: 간선 판독을 남긴다(관측). 승인 요구(open→hold) 강제는 0.2.22 — 보류 사유 값이 먼저다(RFC §3).
  routeJourneyEdge('freeze-check', freezeLabel, { freeze: freezeLabel });
  return admission;
}

function admitLandingMergeUnobserved(
  heldEntry: FrozenMerge | null | (() => FrozenMerge | null),
  root: string,
  hooks: { afterQueue?: () => void },
  claimKey: { prNumber: number; repoRoot: string; headCommit?: string } | undefined,
  opts: { prodFreezeRoot?: string; forceReason?: string },
): LandingAdmission {
  let entry: FrozenMerge | null | undefined;
  const prodFreezeRoot = opts.prodFreezeRoot ?? prodInstanceRoot();
  // A held PR is merged by exactly one runner: the claim (repository + PR) is held from admission until the lander's
  // merge has ended. Its queue entry stays until that merge is confirmed — `end(true)` removes this lander's own head;
  // a failed or interrupted merge leaves it for the next resume sweep.
  let claim: { release: () => void } | null = null;
  let ownHead: { prNumber: number; repoRoot: string; headCommit?: string } | null = null;
  const finish = (landing: { end: () => void }, held: { release: () => void } | null, own: typeof ownHead) => (merged?: boolean) => {
    try {
      // Only a confirmed merge of a known head removes that head; without a head nothing is dequeued (a sweep will
      // find the PR merged on GitHub and drop it).
      if (merged && own?.headCommit) {
        const head = own.headCommit;
        lockedQueue(root, () => writeQueue(root, readQueue(root).filter((item) =>
          item.prNumber !== own.prNumber || item.repoRoot !== own.repoRoot || item.headCommit !== head)));
      }
    } finally { landing.end(); held?.release(); }
  };
  for (;;) {
    const landing = beginLandingMerge(root, new Date(), prodFreezeRoot, opts.forceReason);
    if (!landing.frozen) {
      if (!claim && claimKey) {
        const key = { prNumber: claimKey.prNumber, repoRoot: repoIdentity(claimKey.repoRoot), headCommit: claimKey.headCommit };
        const queued = () => readQueue(root).some((item) => item.prNumber === key.prNumber && item.repoRoot === key.repoRoot);
        if (existsSync(claimPath(key, root)) || queued()) {
          const probe = tryLock(claimPath(key, root));
          if (!probe) { landing.end(); return { kind: 'taken' }; }
          claim = { release: probe };
          ownHead = key;
        }
      }
      return { kind: 'merge', end: finish(landing, claim, ownHead) };
    }
    claim?.release();
    claim = null;
    ownHead = null;
    if (entry === undefined) entry = typeof heldEntry === 'function' ? heldEntry() : heldEntry; // only built when frozen
    if (!entry) return { kind: 'held', freeze: landing.frozen };
    queueFrozenMerge(entry, root);
    passJourneyNode('hold', { provenance: 'admit-landing-merge', outcome: 'queued', data: { pr: entry.prNumber } });
    hooks.afterQueue?.();
    const afterQueue = beginLandingMerge(root, new Date(), prodFreezeRoot, opts.forceReason);
    if (afterQueue.frozen) return { kind: 'held', freeze: afterQueue.frozen };
    try {
      const mine = { ...entry, repoRoot: repoIdentity(entry.repoRoot) };
      claim = claimFrozenMerge(mine, root);
      if (!claim) return { kind: 'taken' };
      // A resume sweep already merged and dequeued it between our queueing and our claim: nothing left to merge.
      const stillHeld = readQueue(root).some((item) => sameEntry(item, mine));
      if (!stillHeld) { claim.release(); return { kind: 'taken' }; }
      ownHead = mine;
      debug.log('harness.merge', 'freeze-lifted-while-queueing', { pr: entry.prNumber });
    } catch (error) { claim?.release(); throw error; }
    finally { afterQueue.end(); }
  }
}

/** Default «is this PR already merged at this head?» check — GitHub is the final word. */
function githubMergedAt(entry: FrozenMerge): boolean {
  try {
    // Resolve gh against the current PATH (Bun's spawn would otherwise use the PATH from process start).
    const gh = Bun.which('gh', { PATH: process.env.PATH ?? '' }) ?? 'gh';
    const view = Bun.spawnSync([gh, 'pr', 'view', String(entry.prNumber), '--json', 'state,headRefOid'], { cwd: entry.repoRoot, env: process.env, timeout: 30_000 });
    if (view.exitCode !== 0) return false;
    const pr = JSON.parse(view.stdout.toString()) as { state?: string; headRefOid?: string };
    return pr.state === 'MERGED' && pr.headRefOid === entry.headCommit;
  } catch { return false; } // unknown is «not known merged»: the head-pinned merge still refuses a second merge
}

/** Invoke at a supervision tick. A failed re-gate remains queued; only a confirmed merge is removed.
 *  «Merged once» does not rest on the claim lock alone: every merge is pinned to the held head
 *  (`gh pr merge --match-head-commit`, which refuses an already-merged PR), and before and after each attempt the
 *  sweep asks GitHub whether the PR is already merged at that head — a duplicate runner can at most repeat a re-gate. */
export async function sweepFrozenMerges(
  merge: (entry: ResumedMerge) => Promise<{ passed: boolean; status?: string }> = async (entry) => {
    const { runHostRegate } = await import('./host-regate.js');
    return runHostRegate(entry);
  },
  root = effectiveInstanceRoot(),
  alreadyMerged: (entry: FrozenMerge) => boolean | Promise<boolean> = githubMergedAt,
  prodFreezeRoot = prodInstanceRoot(),
): Promise<{ pending: number; merged: number }> {
  const pending = readQueue(root);
  let merged = 0;
  for (const entry of pending) {
    const guard = beginLandingMerge(root, new Date(), prodFreezeRoot);
    if (guard.frozen) break;
    let claim: { release: () => void } | null = null;
    try {
      claim = claimFrozenMerge(entry, root);
      if (!claim) continue; // another sweep or the original lander is on it
      if (!readQueue(root).some((item) => sameEntry(item, entry))) continue; // taken back by its lander
      if (entry.manual) { debug.log('harness.merge', 'resume-manual', { pr: entry.prNumber, repoRoot: entry.repoRoot }); continue; }
      if (!(await alreadyMerged(entry))) {
        const outcome = await merge({ ...entry, resumed: true });
        if (outcome.status === 'frozen') continue;
        // Whatever the merge call reported, only GitHub showing the PR merged at the held head dequeues it.
        if (!(await alreadyMerged(entry))) {
          if (outcome.passed) debug.log('harness.merge', 'resume-unconfirmed', { pr: entry.prNumber, head: entry.headCommit });
          continue;
        }
      }
      lockedQueue(root, () => {
        const current = readQueue(root);
        if (current.some((item) => sameEntry(item, entry))) {
          writeQueue(root, current.filter((item) => !sameEntry(item, entry)));
          merged++;
        }
      });
    } catch (error) {
      debug.log('harness.merge', 'resume-failed', { pr: entry.prNumber, error: String(error) });
    } finally { guard.end(); claim?.release(); }
  }
  return { pending: readQueue(root).length, merged };
}
