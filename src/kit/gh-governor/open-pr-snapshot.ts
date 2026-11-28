// GH-BUDGET-GOVERNOR ① — one shared open-PR snapshot per repo (<stateRoot>/gh-governor/open-prs-<repo>.json).
// Every reader (the land graph's listPrs · `eln work next` · the steward space · every seat's idle work-pull knock) reads the
// file while it is younger than open_pr_snapshot.ttl_sec; exactly one process refreshes it (lock file), the others wait for the
// refresher's file. Measured before (20:0x): 23 seat processes each paging the whole list with body ⊕ files(first:100) per PR.
//
// The refresh itself is trimmed (⑤): one `gh pr list` without files (gh pages by 100), then files only for heads the files
// cache has not seen (number@head is immutable), batched over GraphQL aliases. A GitHub failure fails the refresh (the last
// snapshot is served ≤ stale_max_sec); one PR whose head moved mid-refresh (or whose files are unreadable) is left out of this
// snapshot (meta `skipped`) and re-read next refresh — a PR is never listed with an unknown file set.
// During a cooldown / budget refusal no refresh is tried: stale snapshot or a GhGovernorRefusal (the land graph skips its tick).
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GhGovernorRefusal, activeCooldown, governorHome, type GhGovernorPolicy } from './index.js';

export interface OpenPrRecord {
  readonly number: number; readonly headRefOid: string; readonly headRefName?: string; readonly baseRefName?: string;
  readonly title?: string; readonly body?: string; readonly isDraft?: boolean; readonly state?: string;
  readonly createdAt?: string; readonly updatedAt?: string; readonly author?: { login?: string };
  readonly isCrossRepository?: boolean; readonly labels?: ReadonlyArray<{ name: string }>;
  readonly files: ReadonlyArray<{ path: string }>;
}

export interface SnapshotTarget { readonly slug: string | null; readonly cwd?: string }

export interface SnapshotRun {
  readonly ok: boolean; readonly exitCode: number; readonly stdout: Buffer | string; readonly stderr: Buffer | string;
  readonly refused?: 'cooldown' | 'budget';
}
export interface SnapshotDeps {
  readonly stateRoot: string;
  readonly now: () => number;
  readonly policy: GhGovernorPolicy;
  /** The governed gh door (production: runGhCliWithResult) — cwd / env carry the repo. */
  readonly run: (args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number }) => SnapshotRun;
  readonly sleep: (ms: number) => void;
  readonly pid?: number;
  readonly alive?: (pid: number) => boolean;
  /** Per-call timeout of one gh child (ms). */
  readonly timeoutMs?: number;
}

/** A PR left out of one snapshot: its head moved between the list and the files read, or its files were unreadable. */
export interface SkippedPr { readonly number: number; readonly head: string; readonly why: 'head-moved' | 'files-unreadable' | 'invalid-head' }
export interface SnapshotRead {
  readonly prs: OpenPrRecord[]; readonly fetchedAt: number; readonly source: 'cache' | 'fresh' | 'stale';
  /** PRs this snapshot left out (re-read on the next refresh) · absent = none. */
  readonly skipped?: readonly SkippedPr[];
}

/** The fields the list asks for — no `files` (heavy: files(first:100) per PR) — every reader's needs, nothing else. */
export const LIST_FIELDS = 'number,headRefOid,headRefName,baseRefName,isDraft,state,title,author,isCrossRepository,createdAt,updatedAt,body,labels';

const repoKey = (t: SnapshotTarget): string => (t.slug ?? 'cwd').replace(/[^A-Za-z0-9._-]/g, '_');
export const snapshotPath = (stateRoot: string, t: SnapshotTarget): string => join(governorHome(stateRoot), `open-prs-${repoKey(t)}.json`);
const lockPath = (stateRoot: string, t: SnapshotTarget): string => `${snapshotPath(stateRoot, t)}.lock`;
const filesCachePath = (stateRoot: string, t: SnapshotTarget): string => join(governorHome(stateRoot), `pr-files-${repoKey(t)}.json`);

interface SnapshotFile { readonly v: 1; readonly slug: string | null; readonly fetchedAt: number; readonly prs: OpenPrRecord[]; readonly by?: number; readonly skipped?: SkippedPr[] }

function readSnapshotFile(stateRoot: string, t: SnapshotTarget): SnapshotFile | null {
  try {
    const f = JSON.parse(readFileSync(snapshotPath(stateRoot, t), 'utf8')) as SnapshotFile;
    return f && f.v === 1 && typeof f.fetchedAt === 'number' && Array.isArray(f.prs) ? f : null;
  } catch { return null; }
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.floor(Math.random() * 1e9)}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

const defaultAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

function tryLock(d: SnapshotDeps, t: SnapshotTarget): (() => void) | null {
  const p = lockPath(d.stateRoot, t);
  mkdirSync(governorHome(d.stateRoot), { recursive: true });
  const pid = d.pid ?? process.pid;
  try {
    if (existsSync(p)) {
      let holder = NaN;
      try { holder = Number(readFileSync(p, 'utf8').trim().split(' ')[0]); } catch { /* torn */ }
      const old = d.now() - statSync(p).mtimeMs > d.policy.snapshot.lockStaleSec * 1000;
      if (old || !Number.isInteger(holder) || !(d.alive ?? defaultAlive)(holder)) rmSync(p, { force: true });
    }
    const fd = openSync(p, 'wx'); writeFileSync(fd, `${pid} ${d.now()}`); closeSync(fd);
    return () => { try { if (readFileSync(p, 'utf8').startsWith(`${pid} `)) rmSync(p, { force: true }); } catch { /* gone */ } };
  } catch { return null; }
}

/** Drop the snapshot (a land / close changed the open set): the next reader refreshes. */
export function invalidateOpenPrSnapshot(stateRoot: string, t: SnapshotTarget): void {
  try { rmSync(snapshotPath(stateRoot, t), { force: true }); } catch { /* absent */ }
}

const text = (b: Buffer | string): string => (typeof b === 'string' ? b : b.toString('utf8'));

function refusalOf(r: SnapshotRun, what: string): GhGovernorRefusal | Error {
  if (r.refused) return new GhGovernorRefusal(r.refused, text(r.stderr).trim().split('\n')[0] ?? `${what} refused`);
  return new Error(`gh ${what} rc=${r.exitCode}: ${text(r.stderr).trim().slice(0, 160)}`);
}

/**
 * One refresh: list without files ⊕ files for unseen heads. A GitHub failure (list · a files request) throws (the last snapshot
 * is served). One PR whose head moved between the list and its files read, or whose files are unreadable, is LEFT OUT of this
 * snapshot (never listed with a guessed file set) and re-read on the next refresh — 11-28 22:1x: ~300 open PRs with the
 * smart-merge finisher pushing meant one head always moved, so «fail the whole refresh» never wrote a snapshot (land graph 70 min).
 */
function refresh(d: SnapshotDeps, t: SnapshotTarget): { prs: OpenPrRecord[]; skipped: SkippedPr[] } {
  const timeoutMs = d.timeoutMs ?? 60_000;
  const env = t.slug ? { ...process.env, GH_REPO: t.slug } : undefined;
  const opts = { ...(t.cwd ? { cwd: t.cwd } : {}), ...(env ? { env } : {}), timeoutMs };
  const listArgs = ['pr', 'list', '--state', 'open', '--limit', String(d.policy.snapshot.listLimit), '--json', LIST_FIELDS, ...(t.slug ? ['--repo', t.slug] : [])];
  const list = d.run(listArgs, opts);
  if (!list.ok) throw refusalOf(list, 'pr list');
  const raw = JSON.parse(text(list.stdout)) as Array<Record<string, unknown>>;
  if (!Array.isArray(raw)) throw new Error('gh pr list: not an array');

  let cache: Record<string, string[]> = {};
  try { cache = JSON.parse(readFileSync(filesCachePath(d.stateRoot, t), 'utf8')) as Record<string, string[]>; } catch { cache = {}; }
  const keyOf = (n: number, head: string) => `${n}@${head}`;
  const files = new Map<string, string[]>();
  const missing: Array<{ number: number; head: string }> = [];
  const skipped: SkippedPr[] = [];
  for (const p of raw) {
    const n = Number(p.number); const head = String(p.headRefOid ?? '');
    if (!Number.isInteger(n) || n <= 0) throw new Error('gh pr list: row without valid number');
    if (!/^[0-9a-f]{40}$/i.test(head)) { skipped.push({ number: n, head, why: 'invalid-head' }); continue; }
    // A list answer that already carries files (older gh shims · tests) is used as is.
    if (Array.isArray(p.files)) { files.set(keyOf(n, head), (p.files as Array<{ path?: unknown }>).map(f => String(f?.path ?? '')).filter(Boolean)); continue; }
    const hit = cache[keyOf(n, head)];
    if (Array.isArray(hit)) files.set(keyOf(n, head), hit); else missing.push({ number: n, head });
  }
  for (let i = 0; i < missing.length; i += d.policy.snapshot.filesBatch) {
    const batch = missing.slice(i, i + d.policy.snapshot.filesBatch);
    const fields = batch.map(m => `p${m.number}: pullRequest(number: ${m.number}) { headRefOid files(first: 100) { nodes { path } pageInfo { hasNextPage } } }`).join(' ');
    const q = `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { ${fields} } }`;
    const r = d.run(['api', 'graphql', '-F', 'owner={owner}', '-F', 'repo={repo}', '-f', `query=${q}`], opts);
    if (r.refused) throw refusalOf(r, 'api graphql files');
    type Node = { headRefOid?: string; files?: { nodes?: Array<{ path?: string }>; pageInfo?: { hasNextPage?: boolean } } } | null;
    let answer: { data?: { repository?: Record<string, Node> }; errors?: Array<{ path?: unknown }> };
    try { answer = JSON.parse(text(r.stdout)); } catch { throw refusalOf(r, 'api graphql files'); }
    const repo = answer?.data?.repository;
    const errors = answer?.errors;
    const affected = new Set<string>();
    if (errors !== undefined) {
      if (!Array.isArray(errors) || errors.length === 0) throw new Error('gh api graphql files: malformed errors');
      for (const error of errors) {
        const path = error?.path;
        if (!Array.isArray(path) || path[0] !== 'repository' || typeof path[1] !== 'string' || !batch.some(m => `p${m.number}` === path[1])) {
          throw new Error('gh api graphql files: unscoped GraphQL error');
        }
        affected.add(path[1]);
      }
    }
    if (!repo || (!r.ok && affected.size === 0)) throw refusalOf(r, 'api graphql files');
    for (const m of batch) {
      if (affected.has(`p${m.number}`)) { skipped.push({ number: m.number, head: m.head, why: 'files-unreadable' }); continue; }
      const node = repo?.[`p${m.number}`];
      const nodes = node?.files?.nodes;
      const sameHead = !!node && node.headRefOid === m.head;
      if (sameHead && node!.files?.pageInfo?.hasNextPage === false && Array.isArray(nodes)) {
        files.set(keyOf(m.number, m.head), nodes.map(f => String(f?.path ?? '')).filter(Boolean)); continue;
      }
      // > 100 files: REST pages for that PR · pushed between the list and this read / unreadable: that PR is left out of this
      // snapshot (no partial file set) and its files are read again on the next refresh (not cached).
      const paged = sameHead && node!.files?.pageInfo?.hasNextPage === true ? restFiles(d, m.number, opts) : null;
      if (!paged) { skipped.push({ number: m.number, head: m.head, why: node && !sameHead ? 'head-moved' : 'files-unreadable' }); continue; }
      files.set(keyOf(m.number, m.head), paged);
    }
  }
  // Keep only the open heads' entries (the cache never grows past the open set).
  writeAtomic(filesCachePath(d.stateRoot, t), JSON.stringify(Object.fromEntries(files)));
  const prs = raw.filter(p => files.has(keyOf(Number(p.number), String(p.headRefOid)))).map(p => {
    const n = Number(p.number); const head = String(p.headRefOid);
    const rest: Record<string, unknown> = { ...p };
    delete rest.files;
    return { ...(rest as Omit<OpenPrRecord, 'files'>), number: n, headRefOid: head, files: files.get(keyOf(n, head))!.map(path => ({ path })) };
  });
  return { prs, skipped };
}

/** > 100 files: REST pages for that one PR. null = unreadable. */
function restFiles(d: SnapshotDeps, n: number, opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number }): string[] | null {
  const r = d.run(['api', `repos/{owner}/{repo}/pulls/${n}/files?per_page=100`, '--paginate', '--jq', '.[].filename'], opts);
  return r.ok ? text(r.stdout).split('\n').map(s => s.trim()).filter(Boolean) : null;
}

const fromFile = (f: SnapshotFile, source: 'cache' | 'stale'): SnapshotRead =>
  ({ prs: f.prs, fetchedAt: f.fetchedAt, source, ...(f.skipped?.length ? { skipped: f.skipped } : {}) });

/** The open PRs of the target repo: fresh file → it · else one refresher (lock) · else wait for the refresher · else stale. */
export function readOpenPrSnapshot(t: SnapshotTarget, d: SnapshotDeps): SnapshotRead {
  const s = d.policy.snapshot;
  const fresh = (f: SnapshotFile | null): boolean => !!f && d.now() - f.fetchedAt < s.ttlSec * 1000 && f.fetchedAt <= d.now() + 5_000;
  const staleOk = (f: SnapshotFile | null): boolean => !!f && d.now() - f.fetchedAt < s.staleMaxSec * 1000;
  const first = readSnapshotFile(d.stateRoot, t);
  if (fresh(first)) return fromFile(first!, 'cache');
  const cool = activeCooldown(d);
  if (cool) {
    if (staleOk(first)) return fromFile(first!, 'stale');
    throw new GhGovernorRefusal('cooldown', `[gh-governor] open PR snapshot: GitHub cooldown until ${new Date(cool.until).toISOString()} and no snapshot younger than ${s.staleMaxSec}s`);
  }
  const release = tryLock(d, t);
  if (release) {
    try {
      const again = readSnapshotFile(d.stateRoot, t); // another refresher may have finished between the read and the lock
      if (fresh(again)) return fromFile(again!, 'cache');
      let got: { prs: OpenPrRecord[]; skipped: SkippedPr[] };
      try { got = refresh(d, t); } catch (e) {
        if (staleOk(again ?? first)) return fromFile((again ?? first)!, 'stale');
        throw e;
      }
      const fetchedAt = d.now();
      const { prs, skipped } = got;
      writeAtomic(snapshotPath(d.stateRoot, t), JSON.stringify({ v: 1, slug: t.slug, fetchedAt, prs, by: d.pid ?? process.pid, ...(skipped.length ? { skipped } : {}) } satisfies SnapshotFile));
      return { prs, fetchedAt, source: 'fresh', ...(skipped.length ? { skipped } : {}) };
    } finally { release(); }
  }
  // Lost the lock: wait for the refresher's file (never a second GitHub read).
  const deadline = d.now() + s.waitForRefresherSec * 1000;
  for (;;) {
    const f = readSnapshotFile(d.stateRoot, t);
    if (fresh(f)) return fromFile(f!, 'cache');
    if (d.now() >= deadline || !existsSync(lockPath(d.stateRoot, t))) {
      if (staleOk(f)) return fromFile(f!, 'stale');
      // The refresher finished without a fresh file (its refresh failed) or the wait ran out: one more try as refresher.
      if (d.now() < deadline) return readOpenPrSnapshot(t, d);
      throw new Error(`open PR snapshot: refresher did not answer within ${s.waitForRefresherSec}s and no snapshot younger than ${s.staleMaxSec}s`);
    }
    d.sleep(250);
  }
}

/** Blocking sleep for the sync readers (the snapshot wait is ≤ wait_for_refresher_sec). */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}
