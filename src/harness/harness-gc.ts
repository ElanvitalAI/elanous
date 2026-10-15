import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { debug } from '../debug/log.js';
import { configuredWorktreeRoot } from '../user-config.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { acquireLockSync } from '../storage/file-lock.js';
import { createGhRunner, execHarnessClean, gitStdout, type GitRunner, type GhRunner, type ActiveDirectoryProvider } from './harness-clean.js';
import type { WorktreeAssessmentInput, WorktreeAssessment } from './harness-worktrees.js';

export interface HarnessGcOptions {
  repos?: string[];
  dryRun?: boolean;
  window?: number;
  maxRemove?: number;
  budgetMs?: number;
}

export interface HarnessGcDeps {
  stateRoot?: string;
  worktreeRoot?: string;
  now?: () => number;
  run?: GitRunner;
  runGh?: GhRunner;
  activeDirectoryProvider?: ActiveDirectoryProvider;
  assessWorktree?: (input: WorktreeAssessmentInput) => WorktreeAssessment;
  readWorktreeProvenance?: (path: string, run: GitRunner) => { owner: string; command: string; createdAt: string };
}

export interface HarnessGcRepo {
  gitDir: string;
  offset: number;
  window: number;
  total: number;
  removed: number;
  preserved: number;
  deferred: number;
  failed: number;
  preservedByReason: Record<string, number>;
  orphanScan: 'scanned' | 'unavailable' | 'not-requested';
  unseenOutsideWindow?: number;
  unseenOutsidePrefix?: number;
}

export interface HarnessGcResult {
  outcome: 'ok' | 'skipped' | 'fail';
  reason?: 'overlap' | 'no-target-repo' | 'repo-failed' | 'budget-exhausted';
  repos: number;
  removed: number;
  preserved: number;
  deferred: number;
  failed: number;
  unseenOutsideWindow?: number;
  unseenOutsidePrefix?: number;
  undiscoverable: number;
  orphanScanUnavailable: number;
  budgetMs: number;
  elapsedMs: number;
  repositories: HarnessGcRepo[];
  repoFailures?: Array<{ gitDir: string; error: string }>;
  /** The tick budget ran out inside a repository's queries; that repository was left unverified (cursor kept). */
  budgetExhausted?: boolean;
}

/** Discover current linked worktrees; the tick also retains previously verified automatic targets. */
export function discoverHarnessGcRepos(root: string, expired: () => boolean = () => false):
  { repos: string[]; undiscoverable: number; stopped?: boolean } {
  const repos = new Set<string>();
  let undiscoverable = 0;
  // The deadline is checked *between* reads (each readdir / .git read); a stopped walk leaves the rest unverified.
  let stopped = false;
  const halt = (): boolean => { if (!stopped && expired()) stopped = true; return stopped; };
  const done = () => ({ repos: [...repos].sort(), undiscoverable, ...(stopped ? { stopped } : {}) });
  const children = (path: string): string[] => readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => join(path, entry.name));
  let scopes: string[];
  if (halt()) return done();
  try { scopes = children(root); }
  catch { return { repos: [], undiscoverable: 0 }; }
  for (const scope of scopes) {
    if (halt()) return done();
    let parents: string[];
    try { parents = children(scope); }
    catch { undiscoverable++; continue; }
    for (const parent of parents) {
      if (!parent.endsWith('.worktrees')) continue;
      if (halt()) return done();
      let paths: string[];
      try { paths = children(parent); }
      catch { undiscoverable++; continue; }
      for (const path of paths) {
        if (halt()) return done();
        try {
          const line = readFileSync(join(path, '.git'), 'utf8').trim();
          const match = /^gitdir:\s*(.+?)[/\\]worktrees[/\\][^/\\]+\s*$/.exec(line);
          if (!match) { undiscoverable++; continue; }
          const gitDir = isAbsolute(match[1]!) ? match[1]! : resolve(path, match[1]!);
          repos.add(resolve(gitDir));
        } catch { undiscoverable++; }
      }
    }
  }
  return done();
}

function defaultRun(args: string[]) {
  const result = spawnSync('git', args, { encoding: 'utf8', timeout: 20_000 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function positive(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid GC limit: ${value}`);
  return value;
}

/** One lock guards discovery, every repository window, deletion, and cursor writes. */
export function runHarnessGcTick(opts: HarnessGcOptions = {}, deps: HarnessGcDeps = {}): HarnessGcResult {
  const windowSize = positive(opts.window, 150);
  const maxRemove = positive(opts.maxRemove, 30);
  const budgetMs = positive(opts.budgetMs, 240_000);
  const now = deps.now ?? Date.now;
  const started = now();
  const state = join(deps.stateRoot ?? effectiveInstanceRoot(), 'harness-gc');
  mkdirSync(state, { recursive: true });
  const lockPath = join(state, 'tick.lock');
  let holder = '';
  let release: () => void;
  try {
    release = acquireLockSync(lockPath, { maxTries: 2, retryBusyMs: 1, breakDeadHolder: true,
      staleMs: Math.max(2 * budgetMs, 600_000), onWait: (value) => { holder = value; } });
  } catch (error) {
    if (!String(error).includes('timed out')) throw error;
    debug.log('harness.gc', 'tick-skipped', { reason: 'overlap', holder });
    return { outcome: 'skipped', reason: 'overlap', repos: 0, removed: 0, preserved: 0, deferred: 0, failed: 0,
      undiscoverable: 0, orphanScanUnavailable: 0, budgetMs, elapsedMs: now() - started, repositories: [] };
  }
  try {
    const runner = deps.run ?? defaultRun;
    const cursorPath = join(state, 'cursor.json');
    const targetsPath = join(state, 'targets.json');
    let cursor: Record<string, number> = {};
    let persistedTargets: string[] = [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(cursorPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cursor = parsed as Record<string, number>;
    } catch { /* No cursor yet, or corrupt state: start at the beginning. */ }
    try {
      const parsed: unknown = JSON.parse(readFileSync(targetsPath, 'utf8'));
      if (Array.isArray(parsed)) persistedTargets = parsed.filter((path): path is string =>
        typeof path === 'string' && isAbsolute(path));
    } catch { /* No persisted automatic targets yet. */ }
    const discovery = opts.repos === undefined
      ? discoverHarnessGcRepos(deps.worktreeRoot ?? configuredWorktreeRoot(), () => now() - started >= budgetMs)
      : { repos: opts.repos, undiscoverable: 0 };
    // A verified automatic target survives removal of its last linked worktree; --repo never enrolls it.
    const candidates = opts.repos === undefined
      ? [...new Set([...discovery.repos, ...persistedTargets])]
      : discovery.repos;
    const targets = new Set<string>();
    const repoFailures: Array<{ gitDir: string; error: string }> = [];
    let failed = 0;
    // A discovery walk cut by the deadline: repositories it did not reach are unverified, not absent.
    let discoveryBudgetExhausted = 'stopped' in discovery && discovery.stopped === true;
    for (const repo of [...candidates].sort()) {
      if (now() - started >= budgetMs) { discoveryBudgetExhausted = true; break; }
      const common = gitStdout(['-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'], runner);
      if (common.ok && common.value && isAbsolute(common.value)) {
        const gitDir = resolve(common.value);
        targets.add(gitDir);
        if (!opts.dryRun && opts.repos === undefined) persistedTargets.push(gitDir);
      } else { failed++; repoFailures.push({ gitDir: repo, error: 'git common directory unavailable' }); }
    }
    const repositories: HarnessGcRepo[] = [];
    let removed = 0;
    let preserved = 0;
    let deferred = 0;
    let unseenOutsideWindow: number | undefined = repoFailures.length || discoveryBudgetExhausted ? undefined : 0;
    let unseenOutsidePrefix: number | undefined = repoFailures.length || discoveryBudgetExhausted ? undefined : 0;
    let orphanScanUnavailable = 0;
    let processedTargets = 0;
    let budgetExhausted = false;
    // maxRemove bounds deletion *attempts* (incl. partial/failed ones), not only successes.
    let attempts = 0;
    const overBudget = (): boolean => now() - started >= budgetMs;
    const baseGh: GhRunner = deps.runGh ?? createGhRunner();
    for (const gitDir of [...targets].sort()) {
      if (overBudget()) { budgetExhausted = true; break; } // remaining repositories unprocessed — record it
      processedTargets++;
      const offset = Number.isSafeInteger(cursor[gitDir]) && cursor[gitDir]! >= 0 ? cursor[gitDir]! : 0;
      // The deadline is enforced inside the clean too: once it passes, every further *read* (git query, PR lookup,
      // safety measurement) fails fast instead of running on past the tick. Deletions are never cut mid-item —
      // `shouldRemove` already refuses to start one after the deadline.
      let budgetHit = false;
      const isDeletion = (args: readonly string[]): boolean =>
        (args.includes('worktree') && args.includes('remove')) || (args.includes('branch') && args.includes('-D'));
      const run: GitRunner = (args) => {
        if (!isDeletion(args) && overBudget()) { budgetHit = true; return { status: 1, stdout: '', stderr: 'harness gc tick budget exhausted' }; }
        return runner(args[0] === '-C' ? args : ['-C', gitDir, ...args]);
      };
      const runGh: GhRunner = (args, options) => {
        if (overBudget()) { budgetHit = true; return { status: 1, stdout: '', stderr: 'harness gc tick budget exhausted', error: 'budget' }; }
        return baseGh(args, options);
      };
      try {
        // gh's {owner}/{repo} placeholders refer to cwd, not this target repository.
        const remote = gitStdout(['config', '--get', 'remote.origin.url'], run);
        const identity = remote.ok ? /(?:github\.com[:/])([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote.value) : null;
        if (!identity) throw new Error('target repository has no GitHub origin identity');
        const result = execHarnessClean({ mode: 'merged', dryRun: opts.dryRun, repo: `${identity[1]}/${identity[2]}`,
          window: { offset, size: windowSize }, forceWorktreeRemove: false, run, runGh, expired: overBudget,
          activeDirectoryProvider: deps.activeDirectoryProvider,
          assessWorktree: deps.assessWorktree,
          readWorktreeProvenance: deps.readWorktreeProvenance,
          shouldRemove: () => {
            if (attempts >= maxRemove) return false; // count cap, not the time budget
            if (overBudget()) { budgetExhausted = true; return false; } // deletion deferred by the time budget
            attempts++;
            return true;
          } });
        const plan = result.plan;
        if (result.expired) budgetHit = true;
        if (budgetHit) {
          // Unverified, not failed: nothing is counted as preserved/failed and the cursor is kept for the next tick.
          removed += result.removed.length;
          failed += result.failed.length;
          budgetExhausted = true;
          debug.log('harness.gc', 'repo-budget-exhausted', { gitDir, removed: result.removed.length });
          break;
        }
        if (plan.unavailable) {
          repoFailures.push({ gitDir, error: 'required clean query unavailable' });
          failed++;
        }
        const pending = result.deferred?.length ?? 0;
        const byReason: Record<string, number> = {};
        for (const item of plan.preserve) byReason[item.reason] = (byReason[item.reason] ?? 0) + 1;
        const repo: HarnessGcRepo = {
          gitDir, offset: result.window!.offset, window: result.window!.size, total: result.window!.total,
          removed: result.removed.length, preserved: plan.preserve.length, deferred: pending,
          failed: result.failed.length, preservedByReason: byReason, orphanScan: plan.orphanScan,
          ...(plan.queryStatus?.branches && plan.queryStatus.worktrees
            ? { unseenOutsideWindow: result.window!.unseenOutsideWindow } : {}),
          ...(plan.queryStatus?.branches && plan.queryStatus.worktrees && plan.scope?.registeredWorktrees !== undefined
            ? { unseenOutsidePrefix: Math.max(0, plan.scope.registeredWorktrees - plan.scope.matchedWorktrees) } : {}),
        };
        repositories.push(repo);
        debug.log('harness.gc', 'repo', repo);
        removed += repo.removed;
        preserved += repo.preserved;
        deferred += repo.deferred;
        failed += repo.failed;
        if (repo.unseenOutsideWindow === undefined) unseenOutsideWindow = undefined;
        else if (unseenOutsideWindow !== undefined) unseenOutsideWindow += repo.unseenOutsideWindow;
        if (repo.unseenOutsidePrefix === undefined) unseenOutsidePrefix = undefined;
        else if (unseenOutsidePrefix !== undefined) unseenOutsidePrefix += repo.unseenOutsidePrefix;
        if (plan.orphanScan === 'unavailable') orphanScanUnavailable++;
        if (!opts.dryRun && repo.deferred === 0 && repo.failed === 0 && !plan.unavailable) {
          const next = repo.offset + repo.window - repo.removed;
          cursor[gitDir] = next >= repo.total - repo.removed ? 0 : Math.max(0, next);
        }
      } catch (error) {
        if (budgetHit) {
          budgetExhausted = true;
          debug.log('harness.gc', 'repo-budget-exhausted', { gitDir, error: String(error) });
          break;
        }
        failed++;
        unseenOutsideWindow = undefined;
        unseenOutsidePrefix = undefined;
        repoFailures.push({ gitDir, error: String(error) });
        debug.log('harness.gc', 'repo-failed', { gitDir, error: String(error) }, { level: 'error' });
      }
    }
    if (processedTargets < targets.size || budgetExhausted) {
      unseenOutsideWindow = undefined;
      unseenOutsidePrefix = undefined;
    }
    if (!opts.dryRun && targets.size) {
      const temp = join(state, `cursor.${process.pid}.tmp`);
      writeFileSync(temp, JSON.stringify(cursor));
      renameSync(temp, cursorPath);
    }
    if (!opts.dryRun && opts.repos === undefined && persistedTargets.length) {
      const temp = join(state, `targets.${process.pid}.tmp`);
      writeFileSync(temp, JSON.stringify([...new Set(persistedTargets)].sort()));
      renameSync(temp, targetsPath);
    }
    // A tick whose budget ran out before any repository was verified did not succeed — it is «skipped», never «ok».
    const outcome = (targets.size === 0 && !discoveryBudgetExhausted) || failed > 0 ? 'fail'
      : repositories.length === 0 ? 'skipped' : 'ok';
    const summary: HarnessGcResult = { outcome,
      ...(outcome === 'fail' ? { reason: targets.size === 0 ? 'no-target-repo' as const : 'repo-failed' as const }
        : outcome === 'skipped' ? { reason: 'budget-exhausted' as const } : {}),
      repos: repositories.length, removed, preserved, deferred, failed,
      ...(unseenOutsideWindow === undefined ? {} : { unseenOutsideWindow }),
      ...(unseenOutsidePrefix === undefined ? {} : { unseenOutsidePrefix }),
      undiscoverable: discovery.undiscoverable, orphanScanUnavailable, budgetMs,
      elapsedMs: now() - started, repositories,
      ...(repoFailures.length ? { repoFailures } : {}),
      ...(budgetExhausted || discoveryBudgetExhausted ? { budgetExhausted: true } : {}) };
    debug.log('harness.gc', 'tick', summary);
    return summary;
  } finally { release(); }
}

interface HarnessGcCliOptions extends HarnessGcOptions {
  human: boolean;
  json: boolean;
}

export function formatHarnessGcReport(result: HarnessGcResult): string {
  const value = (count: number | undefined): string => count === undefined ? 'unknown' : String(count);
  const lines = [
    `Harness GC · ${result.outcome}${result.reason ? ` (${result.reason})` : ''}`,
    `repos=${result.repos} removed=${result.removed} preserved=${result.preserved} deferred=${result.deferred} failed=${result.failed}`,
    `unseenOutsideWindow=${value(result.unseenOutsideWindow)} unseenOutsidePrefix=${value(result.unseenOutsidePrefix)}`,
    `orphanScanUnavailable=${result.orphanScanUnavailable} budgetMs=${result.budgetMs} elapsedMs=${result.elapsedMs} budgetExhausted=${result.budgetExhausted ?? false}`,
  ];
  if (result.repositories.length === 0) lines.push('orphanScan=not-requested (no repository result)');
  for (const repo of result.repositories) {
    lines.push(`repo=${repo.gitDir} orphanScan=${repo.orphanScan} removed=${repo.removed} preserved=${repo.preserved} deferred=${repo.deferred} failed=${repo.failed}`);
  }
  for (const failure of result.repoFailures ?? []) lines.push(`repoFailure=${failure.gitDir}: ${failure.error}`);
  return lines.join('\n');
}

export function formatHarnessGcOutput(result: HarnessGcResult, format: Pick<HarnessGcCliOptions, 'human' | 'json'>): string {
  return format.human && !format.json ? formatHarnessGcReport(result) : JSON.stringify(result);
}

function cliArgs(args: string[]): HarnessGcCliOptions {
  const opts: HarnessGcCliOptions = { human: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') { opts.json = true; continue; }
    if (arg === '--human') { opts.human = true; continue; }
    if (arg === '--dry-run') { opts.dryRun = true; continue; }
    if (arg === '--repo') { (opts.repos ??= []).push(args[++i] ?? ''); continue; }
    const key = arg === '--window' ? 'window' : arg === '--max-remove' ? 'maxRemove' : arg === '--budget-ms' ? 'budgetMs' : null;
    if (!key) throw new Error(`unknown GC option: ${arg}`);
    opts[key] = Number(args[++i]);
  }
  if (opts.repos?.some((repo) => !repo)) throw new Error('--repo needs a path');
  return opts;
}

if (import.meta.main) {
  try {
    const opts = cliArgs(process.argv.slice(2));
    const result = runHarnessGcTick(opts);
    console.log(formatHarnessGcOutput(result, opts));
    if (result.outcome === 'fail') process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({ outcome: 'fail', reason: String(error) }));
    process.exitCode = 1;
  }
}
