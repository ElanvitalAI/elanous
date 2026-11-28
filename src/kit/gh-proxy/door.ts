// Kit gh-proxy · the transparent gh door (GH-PROXY-LAYER ① · 0.3.40 P0). The PATH shim (bin/gh-shim/gh) runs
// `eln gh <argv>` with ELN_GH_SHIM_ACTIVE=1 → this door: same argv, same exit code, same stdout bytes as the real gh, but
//   · the governor first (kit/gh-governor: global secondary-limit cooldown · per-seat GraphQL budget) — a refused call
//     never reaches GitHub (exit 75 · one clean stderr line naming the git alternative);
//   · an identical read (same argv · repository / branch scope · GH_HOST) inside read_cache_sec is answered from one shared
//     cache file (one refresher per key, others wait for its answer) — 100 hand-shell `gh pr view N` per minute → ≤ 60 /
//     read_cache_sec GitHub reads;
//   · meta commands (auth · config · help · version …) and every write pass through untouched (stdio inherited).
// Measured 11-28 20:59–21:04 KST (ps sampling 0.5 s · 300 s): 221 gh processes on the control host (pr view 98 · api graphql
// 48 · pr list 26 · api compare 34) — most from seat shells calling /opt/homebrew/bin/gh directly, outside the governor.
//
// 세 얼굴: 관측 = the governor ledger (o: ok · fail · rate-limited · cooldown · budget · cache) ⊕ <stateRoot>/gh-proxy/read-cache/ /
// 판단 근거 = graphs/policies/gh-proxy.yaml (shim) ⊕ gh-governor.yaml / 수복과 인계 = a door error passes the call through to
// the real gh (fail-open) · the shim falls back to the real gh when eln cannot start · rollback = remove the shim from PATH.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync, closeSync, constants as fsConstants, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync,
  statSync, unlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { constants as osConstants } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import {
  appendLedger, classifyGhCall, GH_DOOR_ENV, GOVERNOR_EXIT, liveGhGovernorDeps, observeGhCall, preflightGhCall,
  type GhCallClass, type GovernorDeps,
} from '../gh-governor/index.js';
import { liveGhProxyPolicy, type GhProxyPolicy } from './policy.js';

/** First lines of the shim carry this word: the door (and the shim itself) skip any gh that is a shim when looking for the real one. */
export const GH_SHIM_MARKER = 'eln-gh-shim';
/** Set by the shim on its `eln gh` child: the door answers transparently (no status line) instead of the explicit-call gateway. */
export const GH_SHIM_ACTIVE_ENV = 'ELN_GH_SHIM_ACTIVE';
/** The real gh the shim found (the door re-checks it is not a shim). */
export const GH_REAL_ENV = 'ELN_GH_REAL';

const isExecutableFile = (p: string): boolean => {
  try { accessSync(p, fsConstants.X_OK); return statSync(p).isFile(); } catch { return false; }
};

/** True when the file's first bytes carry the shim marker (a real gh binary never does). */
export function isGhShim(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(512);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('latin1').includes(GH_SHIM_MARKER);
  } catch { return false; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ } }
}

/** The real gh: ELN_GH_REAL when it is an executable non-shim, else the first non-shim `gh` on PATH · null = none. */
export function resolveRealGh(env: NodeJS.ProcessEnv): string | null {
  const given = env[GH_REAL_ENV]?.trim();
  if (given && isAbsolute(given) && isExecutableFile(given) && !isGhShim(given)) return given;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, 'gh');
    if (isExecutableFile(p) && !isGhShim(p)) return p;
  }
  return null;
}

// ── Read cache ──────────────────────────────────────────────────────────────────────────────────────────────────────

function optionValue(args: readonly string[], names: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    for (const n of names) {
      if (a === n) return args[i + 1];
      if (a.startsWith(`${n}=`)) return a.slice(n.length + 1);
    }
  }
  return undefined;
}

/** Flags / subcommands whose output is interactive, streaming or a browser hand-off — never cached. */
const UNCACHEABLE_FLAG = new Set(['--web', '-w', '--watch', '-i', '--interactive']);

/** A read the cache may answer: not meta, not a write, not interactive/streaming, stdout not a terminal (gh formats for TTYs). */
export function isCacheableRead(c: GhCallClass, args: readonly string[], stdoutIsTTY: boolean): boolean {
  if (stdoutIsTTY || c.kind === 'meta' || c.write) return false;
  if (args[1] === 'watch' || args.some(a => UNCACHEABLE_FLAG.has(a))) return false;
  return true;
}

function gitCommonDir(cwd: string): string | null {
  try {
    const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8', timeout: 5_000 });
    const out = r.status === 0 ? r.stdout.trim() : '';
    return out ? realpathSync(out) : null;
  } catch { return null; }
}

/** The scope one read's answer depends on: an explicit repository (`--repo` · GH_REPO), else the checkout's repository (the
 *  git common dir — every worktree of one repository shares it), and the checkout itself when gh reads the current branch
 *  (`pr view|checks|diff` without a selector · `pr status` · `{branch}` in an api path). */
export function readScope(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, commonDir: (cwd: string) => string | null = gitCommonDir): string {
  const sub = args[1] ?? '';
  const selector = args[2] !== undefined && !args[2].startsWith('-');
  const branchDependent = (args[0] === 'pr' && ((['view', 'checks', 'diff'].includes(sub) && !selector) || sub === 'status'))
    || args.some(a => a.includes('{branch}'));
  if (branchDependent) return `cwd:${resolve(cwd)}`;
  const repo = optionValue(args, ['--repo', '-R']) ?? env.GH_REPO?.trim();
  if (repo) return `repo:${repo.toLowerCase()}`;
  const common = commonDir(cwd);
  return common ? `git:${common}` : `cwd:${resolve(cwd)}`;
}

export const readCacheKey = (args: readonly string[], scope: string, env: NodeJS.ProcessEnv): string =>
  createHash('sha256').update(JSON.stringify([scope, env.GH_HOST ?? '', args])).digest('hex').slice(0, 40);

export const readCacheDir = (stateRoot: string): string => join(stateRoot, 'gh-proxy', 'read-cache');

interface CacheEntry { readonly t: number; readonly status: number; readonly out: string; readonly err: string }

function readEntry(path: string): CacheEntry | null {
  try {
    const e = JSON.parse(readFileSync(path, 'utf8')) as Partial<CacheEntry>;
    return typeof e.t === 'number' && e.status === 0 && typeof e.out === 'string' && typeof e.err === 'string' ? e as CacheEntry : null;
  } catch { return null; }
}

function writeEntry(path: string, e: CacheEntry): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.floor(Math.random() * 1e9)}.tmp`;
  writeFileSync(tmp, JSON.stringify(e));
  renameSync(tmp, path);
}

function tryLock(path: string, staleMs: number): boolean {
  try { mkdirSync(join(path, '..'), { recursive: true }); closeSync(openSync(path, 'wx')); return true; } catch { /* held */ }
  try {
    if (Date.now() - statSync(path).mtimeMs > staleMs) { unlinkSync(path); closeSync(openSync(path, 'wx')); return true; }
  } catch { /* another taker won */ }
  return false;
}

/** Delete cache files older than prune_sec, at most once per prune_sec (a marker file's mtime). Never throws. */
function pruneCache(dir: string, nowMs: number, pruneSec: number): void {
  const marker = join(dir, '.pruned');
  try { if (nowMs - statSync(marker).mtimeMs < pruneSec * 1000) return; } catch { /* first prune */ }
  try {
    for (const f of readdirSync(dir)) {
      if (f === '.pruned') continue;
      const p = join(dir, f);
      try { if (nowMs - statSync(p).mtimeMs > pruneSec * 1000) unlinkSync(p); } catch { /* raced */ }
    }
    try { utimesSync(marker, new Date(nowMs), new Date(nowMs)); } catch { writeFileSync(marker, ''); }
  } catch { /* the cache must never fail a call */ }
}

// ── Children ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface DoorIo { readonly stdoutIsTTY: boolean; out(b: Buffer): void; err(b: Buffer): void }
interface ChildResult { readonly status: number; readonly stdout: Buffer; readonly stderr: Buffer }
type ChildMode = 'inherit' | 'capture' | 'tee-stderr';

/** Run the real gh. inherit = all stdio the caller's · capture = stdout/stderr collected · tee-stderr = stdout the caller's,
 *  stderr shown live and kept (the governor reads GitHub's limit text from it). Exit = gh's code · 128+n on a signal. */
function runChild(bin: string, args: readonly string[], env: NodeJS.ProcessEnv, mode: ChildMode, io: DoorIo): Promise<ChildResult> {
  return new Promise((done) => {
    const out: Buffer[] = []; const err: Buffer[] = []; let errBytes = 0;
    const keepErr = mode === 'capture' ? Infinity : 65_536;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, [...args], { env, stdio: mode === 'inherit' ? 'inherit' : ['inherit', mode === 'capture' ? 'pipe' : 'inherit', 'pipe'] });
    } catch (e) { done({ status: 127, stdout: Buffer.alloc(0), stderr: Buffer.from(String(e)) }); return; }
    const forward = (sig: NodeJS.Signals) => () => { try { child.kill(sig); } catch { /* gone */ } };
    const onTerm = forward('SIGTERM'); const onHup = forward('SIGHUP');
    process.on('SIGTERM', onTerm); process.on('SIGHUP', onHup);
    child.stdout?.on('data', (b: Buffer) => out.push(b));
    child.stderr?.on('data', (b: Buffer) => {
      if (mode === 'tee-stderr') io.err(b);
      if (errBytes < keepErr) { err.push(b); errBytes += b.length; }
    });
    let settled = false;
    const finish = (r: ChildResult) => {
      if (settled) return; settled = true;
      process.off('SIGTERM', onTerm); process.off('SIGHUP', onHup);
      done(r);
    };
    child.once('error', (e) => finish({ status: 127, stdout: Buffer.concat(out), stderr: Buffer.concat([...err, Buffer.from(String(e))]) }));
    child.once('close', (code, signal) => finish({
      status: code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1), stdout: Buffer.concat(out), stderr: Buffer.concat(err),
    }));
  });
}

// ── The door ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface DoorOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly io?: DoorIo;
  /** undefined = the live governor (null = none: calls pass ungoverned). */
  readonly governor?: GovernorDeps | null;
  /** undefined = the live gh-proxy policy (null = none: no read cache). */
  readonly policy?: GhProxyPolicy | null;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly commonDir?: (cwd: string) => string | null;
}

const liveIo = (): DoorIo => ({
  stdoutIsTTY: process.stdout.isTTY === true,
  out: (b) => { process.stdout.write(b); },
  err: (b) => { process.stderr.write(b); },
});
const realSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const safe = (fn: () => void): void => { try { fn(); } catch { /* bookkeeping never fails a call */ } };

/** One gh call through the transparent door. Returns the exit code the caller should exit with. */
export async function runGhDoor(args: readonly string[], o: DoorOptions = {}): Promise<number> {
  const env = o.env ?? process.env;
  const io = o.io ?? liveIo();
  const real = resolveRealGh(env);
  if (!real) { io.err(Buffer.from('[gh-door] real gh not found on PATH (gh shims skipped) — install gh or fix PATH\n')); return 127; }
  const childEnv: NodeJS.ProcessEnv = { ...env, [GH_DOOR_ENV]: '1', [GH_REAL_ENV]: real };
  delete childEnv[GH_SHIM_ACTIVE_ENV];
  let spawned = false;
  try {
    const c = classifyGhCall(args);
    if (c.kind === 'meta') { spawned = true; return (await runChild(real, args, childEnv, 'inherit', io)).status; }
    const gov = o.governor === undefined ? liveGhGovernorDeps() : o.governor;
    if (gov) {
      const pre = preflightGhCall(gov, c);
      if (!pre.allow) { io.err(Buffer.from(`${pre.message}\n`)); return GOVERNOR_EXIT; }
    }
    const policy = o.policy === undefined ? liveGhProxyPolicy() : o.policy;
    const now = gov?.now ?? Date.now;
    if (gov && policy && policy.shim.readCacheSec > 0 && isCacheableRead(c, args, io.stdoutIsTTY)) {
      const dir = readCacheDir(gov.stateRoot);
      const key = readCacheKey(args, readScope(args, o.cwd ?? process.cwd(), env, o.commonDir), env);
      const file = join(dir, `${key}.json`);
      const lock = join(dir, `${key}.lock`);
      const ttlMs = policy.shim.readCacheSec * 1000;
      const serve = (e: CacheEntry): number => {
        io.out(Buffer.from(e.out, 'base64'));
        if (e.err) io.err(Buffer.from(e.err, 'base64'));
        safe(() => appendLedger(gov, { s: gov.seat, k: c.kind, w: 0, l: c.label, o: 'cache' }));
        return 0;
      };
      const fresh = (): CacheEntry | null => { const e = readEntry(file); return e && now() - e.t < ttlMs ? e : null; };
      const hit = fresh();
      if (hit) return serve(hit);
      let locked = tryLock(lock, (policy.shim.readCacheWaitSec + 5) * 1000);
      if (!locked) {
        // Another process is asking GitHub this exact question: wait for its answer instead of asking again.
        const deadline = Date.now() + policy.shim.readCacheWaitSec * 1000;
        const sleep = o.sleep ?? realSleep;
        while (Date.now() < deadline) {
          await sleep(100);
          const e = fresh();
          if (e) return serve(e);
          locked = tryLock(lock, (policy.shim.readCacheWaitSec + 5) * 1000);
          if (locked) break;
        }
      }
      try {
        if (locked) { const e = fresh(); if (e) return serve(e); }
        spawned = true;
        const r = await runChild(real, args, childEnv, 'capture', io);
        safe(() => observeGhCall(gov, c, { exitCode: r.status, output: `${r.stderr.toString('utf8')}\n${r.stdout.length < 4096 ? r.stdout.toString('utf8') : ''}` }));
        io.out(r.stdout);
        if (r.stderr.length) io.err(r.stderr);
        if (r.status === 0 && r.stdout.length + r.stderr.length <= policy.shim.readCacheMaxBytes) {
          safe(() => writeEntry(file, { t: now(), status: 0, out: r.stdout.toString('base64'), err: r.stderr.toString('base64') }));
          safe(() => pruneCache(dir, now(), policy.shim.readCachePruneSec));
        }
        return r.status;
      } finally {
        if (locked) safe(() => unlinkSync(lock));
      }
    }
    spawned = true;
    const r = await runChild(real, args, childEnv, 'tee-stderr', io);
    if (gov) safe(() => observeGhCall(gov, c, { exitCode: r.status, output: r.stderr.toString('utf8') }));
    return r.status;
  } catch (e) {
    if (spawned) { io.err(Buffer.from(`[gh-door] bookkeeping error after gh ran: ${String(e).slice(0, 200)}\n`)); return 1; }
    io.err(Buffer.from(`[gh-door] door error — passing through to gh ungoverned: ${String(e).slice(0, 200)}\n`));
    return (await runChild(real, args, childEnv, 'inherit', io)).status;
  }
}
