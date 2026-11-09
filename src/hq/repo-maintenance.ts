// Bounded maintenance for the shared HQ bare mirror; reference expiry is explicit and off by default.
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { hostname, homedir } from 'node:os';
import { join, resolve } from 'node:path';
const TRAIN_REF_TTL_MS = 24 * 60 * 60 * 1000;
// Pack/ref limits and six-hour cadence come from PLAN-GIT-FILE-IO-MIN-1105.md §1.
export const MAX_REPO_PACKS = 200;
export const MAX_REPO_REFS = 5_000;
export const REPO_MAINTENANCE_CRON = '0 */6 * * *';
// The HQ mirror can contain thousands of packs; a 2-minute cutoff killed repack mid-write.
export const REPO_REPACK_TIMEOUT_MS = 30 * 60 * 1000;
export const REF_EXPIRY_CONCURRENCY_WARNING = 'Train-ref expiry cannot serialize out-of-band ref or worktree writers; default is off and only worktree-unreferenced train refs are candidates.';
export type GitResult = { status: number | null; stdout: string; stderr: string; signal?: NodeJS.Signals | null };
export type GitRunner = (repo: string, args: string[], timeoutMs: number, input?: string) => GitResult;
export interface RepoMaintenanceDeps {
  git?: GitRunner;
  now?: () => number;
  openPrRefs?: () => Set<string> | null;
  queuedTrainRefs?: () => Set<string> | null;
  activeWorktreeRefs?: () => { refs: Set<string>; oids: Set<string> } | null;
  readRefLogText?: (repo: string, ref: string) => string | null;
}
export interface RepoMeasurement { packs: number; refs: number; fetchMs: number; }
export interface RefRow { name: string; oid: string; }
export interface RefExpiryPlan {
  candidates: Array<{ ref: string; reason: 'merged-origin-branch-older-than-24h' | 'train-ref-older-than-24h' }>;
  protectedRefs: string[];
  keptRefs: string[];
  warnings: string[];
  applied: boolean;
}
export interface RepoCapAlert { metric: 'packs' | 'refs'; observed: number; limit: number; }
export interface RepoMaintenanceResult {
  outcome: 'dry-run' | 'applied';
  repo: string;
  before: RepoMeasurement;
  after: RepoMeasurement;
  refExpiryPlan: RefExpiryPlan;
  capAlerts: RepoCapAlert[];
  maintenance: { applied: boolean; fetchAuto: 0; maintenanceAuto: false; refDeletion: boolean; deletedRefs: string[]; geometricRepack: 2; writeMidx: true; keepUnreachable: true; nice: 10 };
}
export function repoCapAlerts(measurement: RepoMeasurement): RepoCapAlert[] {
  const alerts: RepoCapAlert[] = [];
  if (measurement.packs > MAX_REPO_PACKS) alerts.push({ metric: 'packs', observed: measurement.packs, limit: MAX_REPO_PACKS });
  if (measurement.refs > MAX_REPO_REFS) alerts.push({ metric: 'refs', observed: measurement.refs, limit: MAX_REPO_REFS });
  return alerts;
}
const defaultGit: GitRunner = (repo, args, timeoutMs, input) => {
  const r = spawnSync('nice', ['-n', '10', 'git', '--git-dir', repo, ...args], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, ...(input === undefined ? {} : { input }) });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? r.error?.message ?? '', signal: r.signal };
};
function command(git: GitRunner, repo: string, args: string[], timeoutMs = 30_000, input?: string): string {
  const r = git(repo, args, timeoutMs, input);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.signal ?? r.status}): ${r.stderr.trim().slice(0, 500)}`);
  return r.stdout.trim();
}
function parseRefRows(output: string): RefRow[] {
  return output.split('\n').filter(Boolean).map((line) => {
    const match = /^(refs\/\S+)\t([0-9a-f]{40}|[0-9a-f]{64})$/.exec(line);
    if (!match) throw new Error(`invalid ref inventory: ${line.slice(0, 100)}`);
    return { name: match[1]!, oid: match[2]! };
  });
}
export function parseWorktreeRefs(output: string): { refs: Set<string>; oids: Set<string> } | null {
  const blocks = output.trim().split(/\n\s*\n/u).filter(Boolean);
  if (blocks.length === 0) return null;
  const refs = new Set<string>();
  const oids = new Set<string>();
  for (const block of blocks) {
    const lines = block.split('\n');
    if (!/^worktree \S/u.test(lines[0] ?? '')) return null;
    const validFields = lines.slice(1).every((line) => /^HEAD (?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(line)
      || (/^branch refs\/heads\/.+$/u.test(line) && isValidBranchName(line.slice('branch refs/heads/'.length))) || line === 'detached' || line === 'bare'
      || /^locked(?: .*)?$/u.test(line) || /^prunable(?: .*)?$/u.test(line));
    if (!validFields) return null;
    const heads = lines.map((line) => /^HEAD ((?:[0-9a-f]{40}|[0-9a-f]{64}))$/u.exec(line)).filter(Boolean);
    const branches = lines.map((line) => /^branch (refs\/heads\/.+)$/u.exec(line)).filter(Boolean);
    const detached = lines.includes('detached');
    const bare = lines.includes('bare');
    if (bare) {
      if (heads.length || branches.length || detached || lines.filter((line) => line === 'bare').length !== 1) return null;
      continue;
    }
    if (heads.length !== 1 || branches.length > 1 || Boolean(branches.length) === detached) return null;
    oids.add(heads[0]![1]!);
    if (branches[0]) refs.add(branches[0]![1]!);
  }
  return { refs, oids };
}
function originRepoSlug(url: string): string | null {
  const match = /(?:github\.com[:/])([^/]+\/[^/]+?)(?:\.git)?$/i.exec(url.trim());
  return match?.[1]?.replace(/\.git$/i, '') ?? null;
}
function isValidBranchName(value: string): boolean {
  if (!value || value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.')
    || value.includes('\\') || value.includes('..') || value.includes('@{') || /[\x00-\x20~^:?*\[\]\\]/u.test(value)) return false;
  return value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..'
    && !part.startsWith('.') && !part.endsWith('.lock'));
}
export function parseOpenPrRefsJson(stdout: string): Set<string> | null {
  try {
    const rows: unknown = JSON.parse(stdout);
    if (!Array.isArray(rows) || rows.length >= 1000 || rows.some((row) => {
      if (!row || typeof row !== 'object') return true;
      const headRefName = (row as { headRefName?: unknown }).headRefName;
      return typeof headRefName !== 'string' || !isValidBranchName(headRefName);
    })) return null;
    return new Set(rows.map((row: { headRefName: string }) => 'refs/remotes/origin/' + row.headRefName));
  } catch { return null; }
}
function readOpenPrRefs(originUrl: string): Set<string> | null {
  const slug = originRepoSlug(originUrl);
  if (!slug) return null;
  const result = spawnSync('gh', ['pr', 'list', '--repo', slug, '--state', 'open', '--limit', '1000', '--json', 'headRefName'], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) return null;
  return parseOpenPrRefsJson(result.stdout ?? '');
}
export function parseQueuedTrainRefsTsv(text: string): Set<string> | null {
  try {
    const rows = text.split(/\r?\n/).filter((line) => line && !line.startsWith('#'));
    const refs = new Set<string>();
    const prs = new Set<string>();
    for (const [index, row] of rows.entries()) {
      const fields = row.split('\t');
      if (fields.length !== 4 || !/^\d+$/.test(fields[0]!) || !/^[0-9a-f]{40}$/i.test(fields[1]!) || !fields[2]!.trim() || !fields[3]!.trim() || prs.has(fields[0]!))
        throw new Error('invalid train queue row ' + (index + 1));
      prs.add(fields[0]!);
      refs.add('refs/train-manager/pr/' + fields[0]);
    }
    return refs;
  } catch { return null; }
}
function readQueuedTrainRefs(root: string): Set<string> | null {
  try { return parseQueuedTrainRefsTsv(readFileSync(join(root, 'seat-state', 'OP', 'land-queue.tsv'), 'utf8')); }
  catch { return null; }
}
export function parseReflogUpdatedAt(text: string | null, expectedOid?: string): number | null {
  if (!text || !text.endsWith('\n')) return null;
  const lines = text.trimEnd().split(/\r?\n/u);
  const last = lines.at(-1);
  if (!last) return null;
  const match = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) .+ <[^<>\r\n]+> (\d{9,}) ([+-])((?:[01]\d|2[0-3])[0-5]\d)\t.+$/iu.exec(last);
  if (!match || match[1]!.length !== match[2]!.length || (expectedOid && match[2]!.toLowerCase() !== expectedOid.toLowerCase())) return null;
  const seconds = Number(match[3]);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds * 1000 : null;
}
function refUpdatedAt(repo: string, ref: string, expectedOid: string, readLog?: (repo: string, ref: string) => string | null): number | null {
  let text: string | null;
  try { text = readLog ? readLog(repo, ref) : readFileSync(join(repo, 'logs', ref), 'utf8'); }
  catch { return null; }
  return parseReflogUpdatedAt(text, expectedOid);
}
function measurement(git: GitRunner, repo: string, now: () => number): RepoMeasurement {
  const countOutput = command(git, repo, ['count-objects', '-v']);
  const match = /^packs: (\d+)$/m.exec(countOutput);
  if (!match) throw new Error('git count-objects did not report packs');
  const refs = parseRefRows(command(git, repo, ['for-each-ref', '--format=%(refname)%09%(objectname)'])).length;
  const start = now();
  command(git, repo, ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', 'fetch', '--dry-run', '--no-write-fetch-head', '--no-tags', 'origin'], 120_000);
  return { packs: Number(match[1]), refs, fetchMs: Math.max(0, now() - start) };
}

function runRepackWithArtifactDiagnostics(git: GitRunner, repo: string): void {
  const packDir = join(repo, 'objects', 'pack');
  const listTempPacks = (): Set<string> => {
    try { return new Set(readdirSync(packDir).filter((name) => /^tmp_pack_/u.test(name))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
      throw error;
    }
  };
  const before = listTempPacks();
  try {
    command(git, repo, ['repack', '--geometric=2', '-d', '--write-midx', '--keep-unreachable'], REPO_REPACK_TIMEOUT_MS);
  } catch (error) {
    let followup: string;
    try {
      const artifacts = [...listTempPacks()].filter((name) => !before.has(name)).map((name) => {
        try { return `${name} (${statSync(join(packDir, name)).size} bytes)`; }
        catch { return `${name} (size unavailable)`; }
      });
      followup = artifacts.length
        ? `new temporary pack artifacts preserved for inspection: ${artifacts.join(', ')}`
        : 'no new temporary pack artifacts observed';
    } catch (inspectionError) {
      followup = `temporary pack inventory failed: ${inspectionError instanceof Error ? inspectionError.message : String(inspectionError)}; no cleanup attempted`;
    }
    throw new Error(`${error instanceof Error ? error.message : String(error)}; repack follow-up: ${followup}; verify writer processes before any manual cleanup`);
  }
}
export function buildRefExpiryPlan(input: {
  refs: readonly RefRow[]; mergedRefs: ReadonlySet<string>; openPrRefs: ReadonlySet<string> | null;
  queuedTrainRefs: ReadonlySet<string> | null; activeWorktreeRefs: { refs: ReadonlySet<string>; oids: ReadonlySet<string> } | null;
  refUpdatedAt: ReadonlyMap<string, number | null>; nowMs: number;
}): RefExpiryPlan {
  const candidates: RefExpiryPlan['candidates'] = [];
  const protectedRefs: string[] = [];
  const keptRefs: string[] = [];
  const warnings: string[] = [];
  if (!input.openPrRefs) warnings.push('open-pr-heads-unavailable: all origin refs protected');
  if (!input.queuedTrainRefs) warnings.push('train-queue-unavailable: all train-manager refs protected');
  if (!input.activeWorktreeRefs) warnings.push('active-worktrees-unavailable: all refs protected');
  const refs = input.refs;
  for (const row of refs) {
    const isOrigin = row.name.startsWith('refs/remotes/origin/');
    const isTrain = row.name.startsWith('refs/train-manager/');
    const mainAnchor = row.name === 'refs/remotes/origin/main' || row.name === 'refs/remotes/origin/HEAD';
    const active = input.activeWorktreeRefs?.refs.has(row.name) || input.activeWorktreeRefs?.oids.has(row.oid);
    const openPr = input.openPrRefs?.has(row.name);
    const queued = input.queuedTrainRefs?.has(row.name);
    const sourceUnavailable = !input.activeWorktreeRefs || (isOrigin && !input.openPrRefs) || (isTrain && !input.queuedTrainRefs);
    const potentialExpiry = isTrain || (isOrigin && input.mergedRefs.has(row.name) && !mainAnchor);
    const updatedAt = potentialExpiry ? input.refUpdatedAt.get(row.name) ?? null : null;
    if (isTrain && updatedAt === null) warnings.push(`train-ref-age-unavailable: ${row.name}`);
    if (isOrigin && input.mergedRefs.has(row.name) && !mainAnchor && updatedAt === null)
      warnings.push(`origin-ref-age-unavailable: ${row.name}`);
    if (mainAnchor || active || openPr || queued || sourceUnavailable) {
      protectedRefs.push(row.name);
      continue;
    }
    if (potentialExpiry && updatedAt === null) {
      protectedRefs.push(row.name);
      continue;
    }
    if (isOrigin && input.mergedRefs.has(row.name) && updatedAt !== null) {
      if (input.nowMs - updatedAt >= TRAIN_REF_TTL_MS) candidates.push({ ref: row.name, reason: 'merged-origin-branch-older-than-24h' });
      else keptRefs.push(row.name);
      continue;
    }
    if (isTrain && updatedAt !== null) {
      if (input.nowMs - updatedAt >= TRAIN_REF_TTL_MS) candidates.push({ ref: row.name, reason: 'train-ref-older-than-24h' });
      else keptRefs.push(row.name);
      continue;
    }
    keptRefs.push(row.name);
  }
  return { candidates, protectedRefs: protectedRefs.sort(), keptRefs: keptRefs.sort(), warnings: [...new Set(warnings)].sort(), applied: false };
}
function collectProtection(root: string, repo: string, originUrl: string, git: GitRunner, deps: RepoMaintenanceDeps) {
  const openPrRefs = deps.openPrRefs ? deps.openPrRefs() : readOpenPrRefs(originUrl);
  const queuedTrainRefs = deps.queuedTrainRefs ? deps.queuedTrainRefs() : readQueuedTrainRefs(root);
  let activeWorktreeRefs: { refs: Set<string>; oids: Set<string> } | null;
  if (deps.activeWorktreeRefs) activeWorktreeRefs = deps.activeWorktreeRefs();
  else {
    const result = git(repo, ['worktree', 'list', '--porcelain'], 30_000);
    activeWorktreeRefs = result.status === 0 ? parseWorktreeRefs(result.stdout) : null;
  }
  return { openPrRefs, queuedTrainRefs, activeWorktreeRefs };
}
function withLandQueueLock<T>(root: string, action: () => T): T {
  const lock = join(root, 'seat-state', 'OP', 'land-queue.tsv.lock');
  try { mkdirSync(lock); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error('ref expiry blocked: land queue lock is busy at ' + lock);
    throw error;
  }
  try { return action(); } finally { rmSync(lock, { recursive: true, force: true }); }
}
function trainExpiryWarnings(plan: RefExpiryPlan): string[] {
  return plan.warnings.filter((warning) => !warning.startsWith('open-pr-heads-unavailable:')
    && !warning.startsWith('origin-ref-age-unavailable:'));
}
function trainOnlyExpiryPlan(plan: RefExpiryPlan): RefExpiryPlan {
  const candidates = plan.candidates.filter((candidate) => candidate.ref.startsWith('refs/train-manager/'));
  const retainedOriginCandidates = plan.candidates.filter((candidate) => candidate.ref.startsWith('refs/remotes/origin/')).map(({ ref }) => ref);
  return { ...plan, candidates, keptRefs: [...new Set([...plan.keptRefs, ...retainedOriginCandidates])].sort() };
}
function currentRefExpiryPlan(root: string, repo: string, originUrl: string, git: GitRunner, deps: RepoMaintenanceDeps, nowMs: number): { plan: RefExpiryPlan; refs: RefRow[] } {
  const refs = parseRefRows(command(git, repo, ['for-each-ref', '--format=%(refname)%09%(objectname)']));
  if (!refs.some((row) => row.name === 'refs/remotes/origin/main')) throw new Error('protected refs/remotes/origin/main is missing');
  const mergedRefs = new Set(command(git, repo, ['for-each-ref', '--merged=refs/remotes/origin/main', '--format=%(refname)']).split('\n').filter(Boolean));
  const protection = collectProtection(root, repo, originUrl, git, deps);
  const refUpdatedAtMap = new Map<string, number | null>();
  for (const row of refs) {
    if (row.name.startsWith('refs/train-manager/') || (row.name.startsWith('refs/remotes/origin/') && mergedRefs.has(row.name)))
      refUpdatedAtMap.set(row.name, refUpdatedAt(repo, row.name, row.oid, deps.readRefLogText));
  }
  return { plan: buildRefExpiryPlan({ refs, mergedRefs, ...protection, refUpdatedAt: refUpdatedAtMap, nowMs }), refs };
}
/** Dry-run reports expiry candidates; apply compacts metadata and packs, deleting refs only with explicit expiry opt-in. */
export function maintainHqRepo(options: { root?: string; apply?: boolean; expireRefs?: boolean } = {}, deps: RepoMaintenanceDeps = {}): RepoMaintenanceResult {
  if (options.expireRefs && !options.apply) throw new Error('--expire-refs requires --apply');
  const root = resolve(options.root ?? join(homedir(), 'elanous-hq'));
  const repo = join(root, 'repo.git');
  const git = deps.git ?? defaultGit;
  const now = deps.now ?? Date.now;
  if (command(git, repo, ['rev-parse', '--is-bare-repository']) !== 'true') throw new Error(`not an HQ bare repository: ${repo}`);
  const originUrl = command(git, repo, ['remote', 'get-url', 'origin']);
  const initialPlan = currentRefExpiryPlan(root, repo, originUrl, git, deps, now());
  const refExpiryPlan = initialPlan.plan;
  if (options.expireRefs && trainExpiryWarnings(refExpiryPlan).length)
    throw new Error('ref expiry blocked by incomplete protection evidence: ' + trainExpiryWarnings(refExpiryPlan).join(', '));
  const lock = join(root, 'repo-maintenance.lock');
  if (options.apply) {
    try { mkdirSync(lock); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error(`repo maintenance lock exists at ${lock}; inspect ${join(lock, 'owner.json')} and confirm its pid is gone before removing the lock (never steal an active lock)`);
      throw error;
    }
    try {
      try { writeFileSync(join(lock, 'owner.json'), `${JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: now() })}\n`, { flag: 'wx', mode: 0o600 }); }
      catch (error) { rmSync(lock, { recursive: true, force: true }); throw error; }
      command(git, repo, ['config', '--local', '--replace-all', 'gc.auto', '0']);
      command(git, repo, ['config', '--local', '--replace-all', 'maintenance.auto', 'false']);
      const before = measurement(git, repo, now);
      command(git, repo, ['pack-refs', '--all']);
      runRepackWithArtifactDiagnostics(git, repo);
      command(git, repo, ['commit-graph', 'write', '--reachable']);
      command(git, repo, ['worktree', 'prune']);
      let finalPlan = refExpiryPlan;
      let deletedRefs: string[] = [];
      if (options.expireRefs) {
        finalPlan = withLandQueueLock(root, () => {
          const currentPlan = currentRefExpiryPlan(root, repo, originUrl, git, deps, now());
          if (trainExpiryWarnings(currentPlan.plan).length)
            throw new Error('ref expiry blocked by incomplete protection evidence: ' + trainExpiryWarnings(currentPlan.plan).join(', '));
          const trainPlan = trainOnlyExpiryPlan(currentPlan.plan);
          const rows = trainPlan.candidates.map((candidate) => {
            const current = currentPlan.refs.find((row) => row.name === candidate.ref);
            if (!current) throw new Error('ref expiry candidate disappeared during locked recheck: ' + candidate.ref);
            return candidate.ref + ' ' + current.oid;
          });
          if (rows.length) {
            command(git, repo, ['update-ref', '--stdin'], 30_000, ['start', ...rows.map((row) => 'delete ' + row), 'prepare', 'commit', ''].join('\n'));
            deletedRefs = trainPlan.candidates.map((candidate) => candidate.ref);
            return { ...trainPlan, applied: true };
          }
          return trainPlan;
        });
      }
      const after = measurement(git, repo, now);
      return { outcome: 'applied', repo, before, after, refExpiryPlan: finalPlan, capAlerts: repoCapAlerts(after),
        maintenance: { applied: true, fetchAuto: 0, maintenanceAuto: false, refDeletion: deletedRefs.length > 0, deletedRefs, geometricRepack: 2, writeMidx: true, keepUnreachable: true, nice: 10 } };
    } finally { rmSync(lock, { recursive: true, force: true }); }
  }
  const before = measurement(git, repo, now);
  return { outcome: 'dry-run', repo, before, after: before, refExpiryPlan, capAlerts: repoCapAlerts(before),
    maintenance: { applied: false, fetchAuto: 0, maintenanceAuto: false, refDeletion: false, deletedRefs: [], geometricRepack: 2, writeMidx: true, keepUnreachable: true, nice: 10 } };
}
