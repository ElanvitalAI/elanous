// HQ seat folders are disposable views of one bare repository. No scheduler or human checkout is modified here.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { runGitCommand } from '../git-fs/runner.js';
import { runGhCliWithResult, type GhCliResult } from '../git-fs/gh-cli.js';
import { registeredSeats } from '../seat-address/seat-address.js';
import { debug } from '../debug/log.js';

type HqSeatRole = 'OP' | 'MK' | 'TC' | 'UX';
const ROLES: readonly string[] = ['OP', 'MK', 'TC', 'UX'];
interface HouseLedger {
  home: { kind: 'home'; path: string; source: 'cli-resolved' };
  // `reclaiming` records the original work branch tip; checkoutTip is needed if done detached a different branch.
  sandboxes: Record<string, { kind: 'sandbox'; path: string; owner: HqSeatRole; reclaiming?: string; checkoutTip?: string; checkoutBranch?: string }>;
}

function hqRoot(home = process.env.HOME): string {
  if (!home) throw new Error('HOME is required (or pass --root)');
  return join(home, 'elanous-hq');
}

// A first fetch or checkout of the real monorepo takes minutes; only fetch gets the long ceiling.
function git(cwd: string, ...args: string[]): string {
  const result = runGitCommand(cwd, args, { encoding: 'utf8', timeout: args.includes('fetch') ? 1_800_000 : 600_000 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.trim() || `exit ${result.status}`}`);
  return result.stdout.trim();
}

function repository(root: string): string {
  const repo = join(root, 'repo.git');
  if (git(repo, 'rev-parse', '--is-bare-repository') !== 'true') throw new Error(`not a bare repository: ${repo}`);
  return repo;
}

function ledgerPath(root: string): string { return join(root, 'house.json'); }

/** Read-only launch lookup: the registered home and detached seat must exist; never create or refresh a view. */
export function resolveHqLaunchSeat(role: string, home: string, options: { root?: string } = {}): string {
  if (!registeredSeats().some(seat => seat.id === role)) throw new Error(`unregistered seat: ${role}`);
  const root = resolve(options.root ?? hqRoot());
  const registeredHome = readLedger(root).home.path;
  if (realpathSync(home) !== realpathSync(registeredHome)) throw new Error(`house.json home mismatch: registered ${registeredHome}; requested ${home}`);
  const path = join(root, 'seats', role);
  assertRegisteredWorktree(repository(root), path);
  const head = runGitCommand(path, ['symbolic-ref', '--quiet', 'HEAD'], { encoding: 'utf8' });
  if (head.status === 0) throw new Error(`not a detached seat: ${path}`);
  if (head.status !== 1) throw new Error(`git symbolic-ref --quiet HEAD: ${head.stderr.trim() || `exit ${head.status}`}`);
  return path;
}
function readLedger(root: string): HouseLedger {
  const ledger = JSON.parse(readFileSync(ledgerPath(root), 'utf8')) as HouseLedger;
  if (!ledger.home?.path || !ledger.sandboxes || typeof ledger.sandboxes !== 'object') throw new Error('invalid house.json; refusing to guess houses');
  return ledger;
}
function saveLedger(root: string, ledger: HouseLedger): void {
  const path = ledgerPath(root);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try { renameSync(tmp, path); }
  catch (error) { rmSync(tmp, { force: true }); throw error; }
}
// The lock covers the read as well as the atomic rename: a rename alone cannot prevent lost updates.
// It also serializes repo.git worktree/branch mutations: the git runner retries lock contention, and a
// retried `worktree add -b` that already created its branch fails with "branch already exists".
function withLedgerLock<T>(root: string, update: () => T, waitMs = 120_000): T {
  const lock = `${ledgerPath(root)}.lock`;
  const deadline = Date.now() + waitMs;
  while (true) {
    try { mkdirSync(lock); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`house.json lock timed out: ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return update(); }
  finally { rmdirSync(lock); }
}
/** Caller must hold the ledger lock. */
function updateLedgerLocked(root: string, update: (ledger: HouseLedger) => void): void {
  const ledger = readLedger(root);
  update(ledger);
  saveLedger(root, ledger);
}
function roleOf(value: string): HqSeatRole {
  if (!ROLES.includes(value)) throw new Error(`invalid seat role: ${value} (OP|MK|TC|UX)`);
  return value as HqSeatRole;
}
function workName(name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) throw new Error(`invalid work name: ${name}`);
  return name;
}
function clean(path: string): boolean { return git(path, 'status', '--porcelain') === ''; }
function assertRegisteredWorktree(repo: string, path: string): void {
  // The path itself must be the registered worktree: a symlink to another registered worktree
  // (e.g. seats/TC -> work/TC-fix1) would otherwise pass and let a refresh detach that work.
  if (lstatSync(path).isSymbolicLink()) throw new Error(`not a worktree of ${repo}: ${path} (symlink)`);
  const own = join(realpathSync(dirname(path)), basename(path));
  const entries = git(repo, 'worktree', 'list', '--porcelain').split('\n');
  const registered = entries.some(line => line.startsWith('worktree ') && line.slice(9) === own);
  if (!registered) throw new Error(`not a worktree of ${repo}: ${path}`);
  if (realpathSync(git(path, 'rev-parse', '--git-common-dir')) !== realpathSync(repo)) {
    throw new Error(`not a worktree of ${repo}: ${path}`);
  }
}
const SANDBOX_IGNORE = '/.elanous-test/';
// The sandbox is filled by ordinary work, so every view of repo.git ignores it: `status` stays clean and
// `worktree remove` (no --force) deletes it with the worktree instead of refusing a merged work.
function ensureSandboxIgnored(repo: string): void {
  const exclude = join(repo, 'info', 'exclude');
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (current.split('\n').includes(SANDBOX_IGNORE)) return;
  mkdirSync(join(repo, 'info'), { recursive: true });
  writeFileSync(exclude, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${SANDBOX_IGNORE}\n`);
}
// A local relative origin (`../remote.git`) is relative to the calling checkout, not to repo.git. Git itself
// resolves it from the checkout's top level even when run from a subdirectory, so the same base is used here.
function callerOrigin(): string {
  const origin = git(process.cwd(), 'remote', 'get-url', 'origin');
  const url = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(origin);
  const scpLike = /^[^/]*:/.test(origin);
  if (url || scpLike || isAbsolute(origin)) return origin;
  return resolve(git(process.cwd(), 'rev-parse', '--show-toplevel'), origin);
}
function mergedIntoMain(repo: string, commit: string): boolean {
  const merged = runGitCommand(repo, ['merge-base', '--is-ancestor', commit, 'refs/remotes/origin/main'], { encoding: 'utf8' });
  if (merged.status !== 0 && merged.status !== 1) throw new Error(`cannot verify merge: ${merged.stderr.trim()}`);
  return merged.status === 0;
}

export type MergedPrProof = { status: 'pr-merged'; number: number } | { status: 'not-merged' | 'unknown' };
const MERGED_PR_QUERY_LIMIT = 1000;

/** Read-only PR evidence from the HQ mirror's origin, never the caller's current repository. */
export function proveMergedPr(repo: string, branch: string, tip: string, gh: (args: string[]) => GhCliResult = runGhCliWithResult, base?: string): MergedPrProof {
  if (!repo || !branch || !tip) return { status: 'unknown' };
  let result: GhCliResult;
  try {
    // Read the unexpanded URL: `git remote get-url` applies url.*.insteadOf, possibly turning a
    // hosted origin into a local mirror and losing the repository identity gh must query.
    const origin = git(repo, 'config', '--local', '--get', 'remote.origin.url');
    const url = /^(?:https?:\/\/|ssh:\/\/)(?:[^@/]+@)?([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(origin);
    const scp = /^(?:[^@]+@)?([^:/]+):([^/]+)\/([^/]+?)(?:\.git)?$/.exec(origin);
    if (!url && !scp) return { status: 'unknown' };
    const target = url ? `${url[1]}/${url[2]}/${url[3]}` : `${scp![1]}/${scp![2]}/${scp![3]}`;
    result = gh(['pr', 'list', '--state', 'merged', '--head', branch, ...(base ? ['--base', base] : []), '--json', 'number,headRefOid', '--limit', String(MERGED_PR_QUERY_LIMIT), '--repo', target]);
  } catch { return { status: 'unknown' }; }
  if (!result.ok || result.maybeTruncated) return { status: 'unknown' };
  let parsed: unknown;
  try { parsed = JSON.parse(result.stdout.toString('utf8')); }
  catch { return { status: 'unknown' }; }
  if (!Array.isArray(parsed) || !parsed.every((pr): pr is { number: number; headRefOid: string } =>
    pr !== null && typeof pr === 'object' && Number.isSafeInteger(pr.number) && pr.number > 0
    && typeof pr.headRefOid === 'string' && pr.headRefOid.length > 0)) return { status: 'unknown' };
  const matching = parsed.find(pr => pr.headRefOid === tip);
  return matching ? { status: 'pr-merged', number: matching.number }
    : { status: parsed.length >= MERGED_PR_QUERY_LIMIT ? 'unknown' : 'not-merged' };
}

// Every tip checked by done is tied to its own branch, including a different attached branch.
function landedTip(repo: string, branch: string, tip: string, gh: (args: string[]) => GhCliResult): 'ancestor' | 'pr-merged' | 'tree-equal' | null {
  if (mergedIntoMain(repo, tip)) return 'ancestor';
  if (proveMergedPr(repo, branch, tip, gh, 'main').status === 'pr-merged') return 'pr-merged';
  return treeEqualToMain(repo, tip) ? 'tree-equal' : null;
}

function judgeLandedTip(repo: string, branch: string, tip: string, gh: (args: string[]) => GhCliResult): boolean {
  const rule = landedTip(repo, branch, tip, gh);
  try { debug.log('hq.work', 'done-judged', { branch, tip, rule: rule ?? 'not-merged' }); } catch { /* observation must not change the verdict */ }
  return rule !== null;
}

// Squash changes the commit identity. Prove the original commit changed at least one path and
// that every one of those paths has the same content and mode in the fetched main tree.
function treeEqualToMain(repo: string, tip: string): boolean {
  const main = 'refs/remotes/origin/main';
  const base = git(repo, 'merge-base', tip, main);
  const changed = runGitCommand(repo, ['diff', '--name-only', '-z', base, tip], { encoding: 'utf8' });
  if (changed.status !== 0) throw new Error(`cannot verify changed files: ${changed.stderr.trim() || `exit ${changed.status}`}`);
  const files = changed.stdout.split('\0').filter(Boolean);
  if (files.length === 0) return false;
  const equal = runGitCommand(repo, ['diff', '--quiet', tip, main, '--', ...files], { encoding: 'utf8' });
  if (equal.status !== 0 && equal.status !== 1) throw new Error(`cannot verify tree equality: ${equal.stderr.trim() || `exit ${equal.status}`}`);
  return equal.status === 0;
}
// Git lock files are created exclusively; ours carry our pid. A lock left by a killed `work done` is never
// removed automatically (between our check and a delete, a live git could have re-taken it): the error names it.
function takeLock(lock: string): void {
  try { writeFileSync(lock, `hq-done ${process.pid}\n`, { flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let content = '';
    try { content = readFileSync(lock, 'utf8').trim(); } catch { /* gone or unreadable: report as held */ }
    const owner = /^hq-done (\d+)$/.exec(content);
    if (owner && !processAlive(Number(owner[1]))) throw new Error(`stale lock from a stopped hq work done (pid ${owner[1]}): remove ${lock} and rerun`);
    throw error;
  }
}
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
// Scoped `worktree prune`: drop only the admin entry whose checkout is `path` and is already gone.
function removeStaleWorktreeAdmin(repo: string, path: string): void {
  const admins = join(repo, 'worktrees');
  if (!existsSync(admins) || existsSync(path)) return;
  for (const name of readdirSync(admins)) {
    const gitdir = join(admins, name, 'gitdir');
    if (existsSync(gitdir) && readFileSync(gitdir, 'utf8').trim() === join(path, '.git')) rmSync(join(admins, name), { recursive: true, force: true });
  }
}
function quoteShell(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

/** Origin is read from the calling checkout; nothing in that checkout is moved or reconfigured. */
export function hqInit(options: { root?: string; home?: string } = {}): { root: string; created: boolean; cron: string } {
  const root = resolve(options.root ?? hqRoot());
  const repo = join(root, 'repo.git');
  if (!options.home) throw new Error('resolved home house is required to register house.json');
  mkdirSync(options.home, { recursive: true });
  const home = realpathSync(options.home);
  mkdirSync(root, { recursive: true });
  // Concurrent inits serialize here: the repo.git setup and the first house.json registration are both
  // decided under the ledger lock, so neither side can overwrite the other or miss a home mismatch.
  const created = withLedgerLock(root, () => {
    if (existsSync(ledgerPath(root))) {
      const registered = readLedger(root).home.path;
      if (registered !== home) throw new Error(`house.json home mismatch: registered ${registered}; requested ${home}`);
    }
    const fresh = !existsSync(repo);
    if (fresh) {
      const source = callerOrigin();
      git(root, 'init', '--bare', repo);
      git(repo, 'remote', 'add', 'origin', source);
    }
    repository(root);
    if (!fresh) {
      // An existing mirror must be of the repository init is run for; never re-point or reuse another one.
      const mirrored = runGitCommand(repo, ['remote', 'get-url', 'origin'], { encoding: 'utf8' });
      const caller = callerOrigin();
      if (mirrored.status === 0 && mirrored.stdout.trim() !== caller) throw new Error(`repo.git mirrors ${mirrored.stdout.trim()}, not ${caller}; refusing to reuse ${root}`);
    }
    // An interrupted first fetch leaves a bare repository but no origin/main. Finish it on retry.
    const remote = runGitCommand(repo, ['remote', 'get-url', 'origin'], { encoding: 'utf8' });
    if (remote.status !== 0) {
      // Only an empty, just-initialized repo.git (an init stopped before `remote add`) is finished here.
      if (git(repo, 'for-each-ref') !== '' || existsSync(join(repo, 'worktrees'))) throw new Error(`repo.git has no origin but is not empty; refusing to adopt ${repo}`);
      const source = callerOrigin();
      git(repo, 'remote', 'add', 'origin', source);
    }
    const main = runGitCommand(repo, ['rev-parse', '--verify', 'refs/remotes/origin/main'], { encoding: 'utf8' });
    if (fresh || remote.status !== 0 || main.status !== 0) {
      git(repo, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
      git(repo, 'fetch', 'origin');
    }
    git(repo, 'rev-parse', '--verify', 'refs/remotes/origin/main');
    if (!existsSync(ledgerPath(root))) {
      saveLedger(root, { home: { kind: 'home', path: home, source: 'cli-resolved' }, sandboxes: {} });
    }
    return fresh;
  }, 2_100_000); // longer than the 30-minute first fetch, so a concurrent init reaches the home check
  // Print only: OP installs the line. Only existing role views can be refreshed; init never creates seats.
  // cron runs with a minimal PATH, so the line names this runtime and CLI entry by absolute path.
  const cli = [process.execPath, process.argv[1]].filter((part): part is string => Boolean(part)).map(part => quoteShell(resolve(part))).join(' ');
  const script = `git --git-dir=${quoteShell(repo)} fetch origin && ${ROLES.map(role => `( [ ! -d ${quoteShell(join(root, 'seats', role))} ] || ${cli} hq seat ${role} --refresh --root ${quoteShell(root)} )`).join(' && ')}`;
  const cron = `*/5 * * * * ${script}`;
  return { root, created, cron };
}

export function hqSeat(value: string, options: { root?: string; refresh?: boolean } = {}): { path: string; outcome: 'created' | 'unchanged' | 'refreshed' | 'dirty' } {
  const role = roleOf(value);
  const root = resolve(options.root ?? hqRoot());
  const repo = repository(root);
  readLedger(root);
  const path = join(root, 'seats', role);
  // A new seat starts from the current origin/main, not from whatever the mirror last fetched.
  if (!existsSync(path)) git(repo, 'fetch', 'origin');
  const created = withLedgerLock(root, () => {
    if (existsSync(path)) return false;
    mkdirSync(join(root, 'seats'), { recursive: true });
    // A seat folder deleted by hand leaves its git registration behind; drop only that one so the seat is recreated.
    removeStaleWorktreeAdmin(repo, join(realpathSync(join(root, 'seats')), role));
    git(repo, 'worktree', 'add', '--detach', path, 'refs/remotes/origin/main');
    return true;
  });
  if (created) return { path, outcome: 'created' };
  // Refuse an unrelated checkout even when it is clean; do not touch its HEAD.
  assertRegisteredWorktree(repo, path);
  // Seats are always detached; a worktree on a branch here (e.g. a work moved into seats/) is someone's work.
  const onBranch = runGitCommand(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { encoding: 'utf8' });
  if (onBranch.status === 0) throw new Error(`not a seat: ${path} is on branch ${onBranch.stdout.trim()}; refusing to touch it`);
  // A dirty seat must be byte-for-byte untouched, including its detached HEAD.
  if (options.refresh && !clean(path)) return { path, outcome: 'dirty' };
  if (!options.refresh) return { path, outcome: 'unchanged' };
  git(repo, 'fetch', 'origin');
  // Concurrent refreshes of one seat (cron and a person) serialize on the house lock; each re-checks first.
  return withLedgerLock(root, () => {
    assertRegisteredWorktree(repo, path);
    if (runGitCommand(path, ['symbolic-ref', '--quiet', 'HEAD'], { encoding: 'utf8' }).status === 0) throw new Error(`not a seat: ${path} is on a branch; refusing to touch it`);
    if (!clean(path)) return { path, outcome: 'dirty' as const };
    // Commits made on the detached seat are not on origin/main; moving HEAD would orphan them. Treat as dirty.
    if (!mergedIntoMain(repo, git(path, 'rev-parse', 'HEAD'))) return { path, outcome: 'dirty' as const };
    git(path, 'checkout', '--detach', 'refs/remotes/origin/main');
    return { path, outcome: 'refreshed' as const };
  });
}

export function hqWork(action: 'new' | 'done', value: string, nameValue: string, options: { root?: string; gh?: (args: string[]) => GhCliResult } = {}): { path: string; outcome: 'created' | 'removed' } {
  const role = roleOf(value);
  const name = workName(nameValue);
  const root = resolve(options.root ?? hqRoot());
  const repo = repository(root);
  readLedger(root);
  const branch = `work/${role}-${name}`;
  const path = join(root, 'work', `${role}-${name}`);
  if (action === 'new') {
    if (existsSync(path)) throw new Error(`work already exists: ${path}`);
    // fetch stays outside the lock: it only moves remote-tracking refs, is idempotent and lock-retried, and the
    // cron line runs it unlocked anyway. Branch, worktree and ledger changes below are all under the lock.
    git(repo, 'fetch', 'origin');
    withLedgerLock(root, () => {
      if (existsSync(path)) throw new Error(`work already exists: ${path}`);
      mkdirSync(join(root, 'work'), { recursive: true });
      ensureSandboxIgnored(repo);
      const base = git(repo, 'rev-parse', '--verify', 'refs/remotes/origin/main');
      git(repo, 'worktree', 'add', '-b', branch, path, base);
      try {
        const sandbox = join(path, '.elanous-test');
        mkdirSync(sandbox);
        updateLedgerLocked(root, ledger => {
          ledger.sandboxes[path] = { kind: 'sandbox', path: realpathSync(sandbox), owner: role };
        });
      } catch (error) {
        // Roll back only a work that is still exactly what was just created (clean, at base, branch at base),
        // without --force and with a compare-and-delete; anything a hook or another writer added is kept.
        let untouched = false;
        // `--ignored` also sees files in the (ignored) sandbox; only the empty sandbox dir we made is invisible to it.
        try { untouched = git(path, 'rev-parse', '--verify', 'HEAD') === base && git(path, 'status', '--porcelain', '--ignored') === ''; } catch { /* unreadable: keep it */ }
        const removed = untouched ? runGitCommand(repo, ['worktree', 'remove', path], { encoding: 'utf8' }) : undefined;
        const unbranched = removed?.status === 0 ? runGitCommand(repo, ['update-ref', '-d', `refs/heads/${branch}`, base], { encoding: 'utf8' }) : undefined;
        const rolledBack = !untouched ? `work kept: it changed after creation: ${path}`
          : removed?.status !== 0 ? `work kept: ${removed?.stderr.trim()}`
          : unbranched?.status !== 0 ? `rollback incomplete; branch kept: ${unbranched?.stderr.trim()}`
          : 'rolled back';
        throw new Error(`work registration failed (${rolledBack}): ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    return { path, outcome: 'created' };
  }
  git(repo, 'fetch', 'origin');
  withLedgerLock(root, () => {
    if (!existsSync(path)) {
      // Reconcile a done that removed the worktree but failed before the ledger or branch caught up.
      if (!readLedger(root).sandboxes[path]) throw new Error(`work does not exist: ${path}`);
      // A moved worktree (`git worktree move`) is still live work on this branch: never reclaim it from here.
      // Only this work's own stale registration is cleaned below; other (maybe briefly missing) worktrees are left.
      const own = join(existsSync(dirname(path)) ? realpathSync(dirname(path)) : dirname(path), basename(path));
      const elsewhere = git(repo, 'worktree', 'list', '--porcelain').split('\n\n')
        .filter(block => block.split('\n').includes(`branch refs/heads/${branch}`))
        .map(block => block.split('\n')[0]!.slice(9))
        .find(location => location !== own);
      if (elsewhere) throw new Error(`work branch ${branch} is checked out at ${elsewhere}; refusing to reclaim ${path}`);
      const ref = runGitCommand(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { encoding: 'utf8' });
      if (ref.status !== 0) {
        // Without the branch, the only merge proof is the tip an interrupted done recorded before removing.
        const recordedEntry = readLedger(root).sandboxes[path];
        const recorded = recordedEntry?.reclaiming;
        const checkout = recordedEntry?.checkoutTip;
        if (!recorded || !judgeLandedTip(repo, branch, recorded, options.gh ?? runGhCliWithResult)
          || (checkout && (!recordedEntry.checkoutBranch || !judgeLandedTip(repo, recordedEntry.checkoutBranch, checkout, options.gh ?? runGhCliWithResult)))) {
          throw new Error(`cannot verify merge: branch ${branch} is missing; house.json entry kept: ${path}`);
        }
        updateLedgerLocked(root, ledger => { delete ledger.sandboxes[path]; });
        removeStaleWorktreeAdmin(repo, own);
        return;
      }
      const tip = ref.stdout.trim();
      if (!judgeLandedTip(repo, branch, tip, options.gh ?? runGhCliWithResult)) throw new Error(`work is not merged into origin/main: ${branch}`);
      // Same order as a normal done: the entry goes first, so a save that fails again keeps the branch (the proof).
      const entry = readLedger(root).sandboxes[path];
      updateLedgerLocked(root, ledger => { delete ledger.sandboxes[path]; });
      const deleted = runGitCommand(repo, ['update-ref', '-d', `refs/heads/${branch}`, tip], { encoding: 'utf8' });
      if (deleted.status !== 0) {
        // The branch moved after the merge check: put the registration back so done can be retried.
        updateLedgerLocked(root, ledger => { ledger.sandboxes[path] = entry; });
        throw new Error(`work branch moved after the merge check; registration kept: ${branch}: ${deleted.stderr.trim()}`);
      }
      removeStaleWorktreeAdmin(repo, own);
      return;
    }
    // Only work that `hq work new` registered is reclaimed; a hand-made worktree at the same path is not ours.
    const entry = readLedger(root).sandboxes[path];
    if (entry?.owner !== role) throw new Error(`work is not registered in house.json; refusing to remove: ${path}`);
    assertRegisteredWorktree(repo, path);
    if (!clean(path)) throw new Error(`work is dirty; refusing to remove: ${path}`);
    const ref = `refs/heads/${branch}`;
    const attached = runGitCommand(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { encoding: 'utf8' });
    const branchTip = runGitCommand(repo, ['rev-parse', '--verify', '--quiet', ref], { encoding: 'utf8' });
    // Resume: an interrupted done left the work detached at its recorded merged tip, with the branch either
    // still at that tip (stopped before the delete) or already deleted (stopped before the removal).
    const branchPresent = branchTip.status === 0;
    const resuming = attached.status !== 0 && entry.reclaiming !== undefined
      && git(path, 'rev-parse', 'HEAD') === (entry.checkoutTip ?? entry.reclaiming)
      && (!branchPresent || branchTip.stdout.trim() === entry.reclaiming);
    if (!resuming && (attached.status !== 0 || !branchPresent)) throw new Error(`work branch mismatch: ${path}`);
    const ownTip = resuming ? entry.reclaiming! : branchTip.stdout.trim();
    const checkoutBranch = resuming ? entry.checkoutBranch ?? branch : attached.stdout.trim();
    const checkoutRef = `refs/heads/${checkoutBranch}`;
    const differentBranch = checkoutBranch !== branch;
    const tip = differentBranch
      ? (resuming ? entry.checkoutTip! : git(repo, 'rev-parse', '--verify', checkoutRef))
      : ownTip;
    if (!resuming && differentBranch && git(path, 'rev-parse', 'HEAD') !== tip) throw new Error(`work branch moved before the merge check: ${checkoutBranch}`);
    // The ancestor check is against origin/main, not bare HEAD (which may still point to master).
    if (!judgeLandedTip(repo, checkoutBranch, tip, options.gh ?? runGhCliWithResult)) throw new Error(`work is not merged into origin/main: ${checkoutBranch}`);
    if (differentBranch && !judgeLandedTip(repo, branch, ownTip, options.gh ?? runGhCliWithResult)) throw new Error(`work is not merged into origin/main: ${branch}`);
    if (differentBranch && !resuming) {
      const current = runGitCommand(repo, ['rev-parse', '--verify', checkoutRef], { encoding: 'utf8' });
      if (current.status !== 0 || current.stdout.trim() !== tip || git(path, 'rev-parse', 'HEAD') !== tip) throw new Error(`work branch moved before removal: ${checkoutBranch}`);
    }
    // Removal order keeps every interruption resumable: record the proven checkout tip and original branch tip
    // → detach → hold the work's git locks → compare-and-delete the original branch → remove the worktree
    // → drop the registration last. A different attached branch is proven but its ref is never deleted.
    // Holding this worktree's HEAD.lock and index.lock makes git refuse every commit and `add` in it until the
    // removal ends (`worktree remove` itself does not need them), so no commit can land between the last
    // check and the removal. The locks live in the worktree's admin dir, which the removal deletes.
    updateLedgerLocked(root, ledger => { ledger.sandboxes[path] = { ...entry, reclaiming: ownTip,
      ...(differentBranch ? { checkoutTip: tip, checkoutBranch } : {}) }; });
    const admin = git(path, 'rev-parse', '--absolute-git-dir');
    const held: string[] = [];
    const release = (): void => { for (const lock of held.splice(0)) rmSync(lock, { force: true }); };
    const restore = (): string => {
      release();
      const head = runGitCommand(path, ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' });
      runGitCommand(repo, ['update-ref', ref, differentBranch ? ownTip : head.status === 0 ? head.stdout.trim() : tip, ''], { encoding: 'utf8' });
      const reattached = runGitCommand(path, ['symbolic-ref', 'HEAD', checkoutRef], { encoding: 'utf8' }).status === 0;
      // If HEAD could not be re-attached (e.g. a stale HEAD.lock), keep `reclaiming` so the next done resumes.
      const restored = reattached ? { kind: entry.kind, path: entry.path, owner: entry.owner } : { ...entry, reclaiming: ownTip,
        ...(differentBranch ? { checkoutTip: tip, checkoutBranch } : {}) };
      try { updateLedgerLocked(root, ledger => { ledger.sandboxes[path] = restored; }); return reattached ? 'registration restored' : 'left resumable'; }
      catch (error) { return `REGISTRATION NOT RESTORED (fix ${path} in house.json by hand): ${error instanceof Error ? error.message : String(error)}`; }
    };
    const fail = (message: string): never => { throw new Error(`${message}; nothing removed: ${path} · ${restore()}`); };
    if (!resuming) git(path, 'checkout', '--quiet', '--detach');
    for (const name of ['HEAD.lock', 'index.lock']) {
      const lock = join(admin, name);
      try { takeLock(lock); held.push(lock); }
      catch (error) { fail(`work is busy (another git process holds ${name}): ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (git(path, 'rev-parse', 'HEAD') !== tip) fail('work gained a commit after the merge check');
    if (branchPresent) {
      const deleted = runGitCommand(repo, ['update-ref', '-d', ref, ownTip], { encoding: 'utf8' });
      if (deleted.status !== 0) fail(`work branch moved after the merge check: ${deleted.stderr.trim()}`);
    }
    if (!clean(path)) fail('work changed during done');
    if (differentBranch) {
      const current = runGitCommand(repo, ['rev-parse', '--verify', checkoutRef], { encoding: 'utf8' });
      if (current.status !== 0 || current.stdout.trim() !== tip) fail(`work branch moved after the merge check: ${checkoutBranch}`);
    }
    // Without --force, git also refuses a worktree that became dirty after the check above.
    const removed = runGitCommand(repo, ['worktree', 'remove', path], { encoding: 'utf8' });
    if (removed.status !== 0) fail(`git worktree remove failed: ${removed.stderr.trim()}`);
    updateLedgerLocked(root, ledger => { delete ledger.sandboxes[path]; });
  });
  return { path, outcome: 'removed' };
}
