// Kit gh-proxy · git fetch mirror (GH-PROXY-LAYER ② · 0.3.40 P0). One bare mirror of the GitHub repository on the control host;
// only the refresher fetches GitHub (at most once per refresh_min_interval_sec), every consumer repository (the seat worktrees'
// common git dir) fetches from the mirror through `url.<mirror>.insteadOf = <upstream>` — push stays GitHub through
// `url.<upstream>.pushInsteadOf = <upstream>` (git derives the push URL from the original URL before insteadOf applies).
// Measured 11-28 20:59–21:04 KST (ps sampling): 33 git-remote-https processes to github.com in 300 s (6.6/min) from seat TUIs,
// loop jobs and hand shells — each one a full ref advertisement of ~49,600 refs (3.4 MB).
//
// 세 얼굴: 관측 = <stateRoot>/gh-proxy/mirror.json (lastOkAt · lastError · fallback · consumers) ⊕ mirror-tick.json (trigger goal) /
// 판단 근거 = graphs/policies/gh-proxy.yaml (mirror) / 수복과 인계 = a mirror older than stale_fallback_min removes every
// consumer's insteadOf (fetch goes to GitHub) and the next good refresh restores it · a failed refresh is one line in the state
// file and the trigger registry's failure card · rollback = `git config --unset-all url.<mirror>.insteadOf` in each consumer.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { GhProxyPolicy } from './policy.js';

export interface MirrorState {
  readonly schema: 1;
  readonly mirror: string;
  readonly upstream: string;
  readonly consumers: readonly string[];
  readonly lastOkAt: number | null;
  readonly lastTryAt: number | null;
  readonly lastError: string;
  readonly fallback: boolean;
  readonly refreshes: number;
  readonly failures: number;
}

export interface GitRun { (args: readonly string[], opts?: { timeoutMs?: number }): { status: number; stdout: string; stderr: string } }

export const realGit: GitRun = (args, opts = {}) => {
  const r = spawnSync('git', [...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}) });
  return { status: r.status ?? (r.error ? 124 : 1), stdout: r.stdout ?? '', stderr: `${r.stderr ?? ''}${r.error ? String(r.error) : ''}` };
};

export interface MirrorDeps {
  readonly stateRoot: string;
  readonly policy: GhProxyPolicy;
  readonly now: () => number;
  readonly git: GitRun;
  readonly sleep: (ms: number) => void;
}

export const mirrorHome = (stateRoot: string): string => join(stateRoot, 'gh-proxy');
export const mirrorStatePath = (stateRoot: string): string => join(mirrorHome(stateRoot), 'mirror.json');
/** Rewritten by every refresh tick (also when no mirror is set up) — the trigger's file-mtime goal. */
export const mirrorTickPath = (stateRoot: string): string => join(mirrorHome(stateRoot), 'mirror-tick.json');
const lockPath = (stateRoot: string): string => join(mirrorHome(stateRoot), 'mirror.lock');

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.floor(Math.random() * 1e9)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`);
  renameSync(tmp, path);
}

export function readMirrorState(stateRoot: string): MirrorState | null {
  try {
    const s = JSON.parse(readFileSync(mirrorStatePath(stateRoot), 'utf8')) as Partial<MirrorState>;
    if (s.schema !== 1 || typeof s.mirror !== 'string' || typeof s.upstream !== 'string' || !Array.isArray(s.consumers)) return null;
    return {
      schema: 1, mirror: s.mirror, upstream: s.upstream, consumers: s.consumers.filter((c): c is string => typeof c === 'string'),
      lastOkAt: typeof s.lastOkAt === 'number' ? s.lastOkAt : null, lastTryAt: typeof s.lastTryAt === 'number' ? s.lastTryAt : null,
      lastError: String(s.lastError ?? ''), fallback: s.fallback === true, refreshes: Number(s.refreshes ?? 0), failures: Number(s.failures ?? 0),
    };
  } catch { return null; }
}

const insteadOfKey = (mirror: string) => `url.${mirror}.insteadOf`;
const pushInsteadOfKey = (upstream: string) => `url.${upstream}.pushInsteadOf`;

function configValues(git: GitRun, gitDir: string, key: string): string[] {
  const r = git(['--git-dir', gitDir, 'config', '--get-all', key]);
  return r.status === 0 ? r.stdout.split('\n').map(l => l.trim()).filter(Boolean) : [];
}

/** True when the consumer's fetch from `upstream` is rewritten to the mirror. */
export function consumerUsesMirror(git: GitRun, gitDir: string, s: Pick<MirrorState, 'mirror' | 'upstream'>): boolean {
  return configValues(git, gitDir, insteadOfKey(s.mirror)).includes(s.upstream);
}

export const isFresh = (s: Pick<MirrorState, 'lastOkAt'>, policy: GhProxyPolicy, nowMs: number): boolean =>
  s.lastOkAt !== null && nowMs - s.lastOkAt <= policy.mirror.staleFallbackMin * 60_000;

export interface Reconcile { readonly gitDir: string; readonly change: 'to-mirror' | 'to-github' | 'none'; readonly error?: string }

/** Point every consumer's fetch at the mirror while it is fresh, at GitHub while it is not (the stale fallback). */
export function reconcileConsumers(d: MirrorDeps, s: MirrorState): Reconcile[] {
  const fresh = isFresh(s, d.policy, d.now());
  return s.consumers.map((gitDir): Reconcile => {
    const has = consumerUsesMirror(d.git, gitDir, s);
    if (fresh && !has) {
      const r = d.git(['--git-dir', gitDir, 'config', '--add', insteadOfKey(s.mirror), s.upstream]);
      return r.status === 0 ? { gitDir, change: 'to-mirror' } : { gitDir, change: 'none', error: r.stderr.trim().slice(0, 200) };
    }
    if (!fresh && has) {
      const r = d.git(['--git-dir', gitDir, 'config', '--unset-all', insteadOfKey(s.mirror)]);
      return r.status === 0 ? { gitDir, change: 'to-github' } : { gitDir, change: 'none', error: r.stderr.trim().slice(0, 200) };
    }
    return { gitDir, change: 'none' };
  });
}

function takeLock(stateRoot: string, staleMs: number, nowMs: number): boolean {
  const p = lockPath(stateRoot);
  mkdirSync(mirrorHome(stateRoot), { recursive: true });
  try { closeSync(openSync(p, 'wx')); writeFileSync(p, String(process.pid)); return true; } catch { /* held */ }
  try {
    const pid = Number(readFileSync(p, 'utf8').trim());
    const dead = Number.isInteger(pid) && pid > 0 && (() => { try { process.kill(pid, 0); return false; } catch { return true; } })();
    if (dead || nowMs - statSync(p).mtimeMs > staleMs) { unlinkSync(p); closeSync(openSync(p, 'wx')); writeFileSync(p, String(process.pid)); return true; }
  } catch { /* another taker won */ }
  return false;
}

export interface RefreshOne { readonly fetched: boolean; readonly ok: boolean; readonly skipped?: 'interval' | 'locked'; readonly error?: string; readonly ms?: number }
export interface TickResult {
  readonly outcome: 'ok' | 'fail';
  readonly mirror: 'absent' | 'present';
  readonly refreshes: RefreshOne[];
  readonly fresh: boolean;
  readonly reconcile: Reconcile[];
}

/** One GitHub fetch into the mirror unless the last attempt is inside the interval or another refresher holds the lock. */
export function refreshOnce(d: MirrorDeps, s: MirrorState): { result: RefreshOne; state: MirrorState } {
  const now = d.now();
  if (s.lastTryAt !== null && now - s.lastTryAt < d.policy.mirror.refreshMinIntervalSec * 1000) return { result: { fetched: false, ok: true, skipped: 'interval' }, state: s };
  if (!takeLock(d.stateRoot, (d.policy.mirror.fetchTimeoutSec + 60) * 1000, now)) return { result: { fetched: false, ok: true, skipped: 'locked' }, state: s };
  try {
    const t0 = d.now();
    const r = d.git(['--git-dir', s.mirror, 'fetch', '--prune', '--quiet', '--no-write-fetch-head', s.upstream, ...d.policy.mirror.refspecs],
      { timeoutMs: d.policy.mirror.fetchTimeoutSec * 1000 });
    const ms = d.now() - t0;
    if (r.status === 0) {
      d.git(['--git-dir', s.mirror, 'pack-refs', '--all']);
      const state: MirrorState = { ...s, lastOkAt: d.now(), lastTryAt: now, lastError: '', refreshes: s.refreshes + 1 };
      writeJsonAtomic(mirrorStatePath(d.stateRoot), state);
      return { result: { fetched: true, ok: true, ms }, state };
    }
    const error = (r.stderr.trim().split('\n').pop() ?? `rc=${r.status}`).slice(0, 300) || `rc=${r.status}`;
    const state: MirrorState = { ...s, lastTryAt: now, lastError: error, failures: s.failures + 1 };
    writeJsonAtomic(mirrorStatePath(d.stateRoot), state);
    return { result: { fetched: true, ok: false, error, ms }, state };
  } finally {
    try { unlinkSync(lockPath(d.stateRoot)); } catch { /* gone */ }
  }
}

/** One trigger tick: up to refreshes_per_tick refreshes, refresh_min_interval_sec apart, then the consumers follow freshness.
 *  No mirror set up → outcome ok, nothing touched (the trigger is harmless on a host without one). */
export function mirrorTick(d: MirrorDeps): TickResult {
  let s = readMirrorState(d.stateRoot);
  let result: TickResult;
  if (!s) {
    result = { outcome: 'ok', mirror: 'absent', refreshes: [], fresh: false, reconcile: [] };
  } else if (!existsSync(s.mirror)) {
    // The mirror directory vanished: fall back at once (consumers fetch GitHub), say so, and keep the registration.
    s = { ...s, lastOkAt: null, lastError: `mirror missing: ${s.mirror}` };
    writeJsonAtomic(mirrorStatePath(d.stateRoot), { ...s, fallback: true });
    result = { outcome: 'fail', mirror: 'present', refreshes: [], fresh: false, reconcile: reconcileConsumers(d, s) };
  } else {
    const refreshes: RefreshOne[] = [];
    for (let i = 0; i < d.policy.mirror.refreshesPerTick; i++) {
      if (i > 0) d.sleep(d.policy.mirror.refreshMinIntervalSec * 1000);
      const one = refreshOnce(d, s);
      refreshes.push(one.result); s = one.state;
    }
    const fresh = isFresh(s, d.policy, d.now());
    const reconcile = reconcileConsumers(d, s);
    if (s.fallback !== !fresh) { s = { ...s, fallback: !fresh }; writeJsonAtomic(mirrorStatePath(d.stateRoot), s); }
    const failed = refreshes.some(r => r.fetched && !r.ok) || reconcile.some(r => r.error);
    result = { outcome: failed ? 'fail' : 'ok', mirror: 'present', refreshes, fresh, reconcile };
  }
  writeJsonAtomic(mirrorTickPath(d.stateRoot), { at: d.now(), ...result });
  return result;
}

export interface SetupResult { readonly ok: boolean; readonly lines: string[] }

/** Register the mirror and its consumers (idempotent). Creates the bare mirror (first full fetch) when it does not exist.
 *  Refuses a consumer whose explicit pushurl would be rewritten by the insteadOf (push must stay GitHub). */
export function setupMirror(d: MirrorDeps, mirror: string, upstream: string, consumers: readonly string[]): SetupResult {
  const lines: string[] = [];
  if (!isAbsolute(mirror)) return { ok: false, lines: [`REFUSE mirror path must be absolute: ${mirror}`] };
  if (!/^https:\/\/[^\s]+\.git$/.test(upstream)) return { ok: false, lines: [`REFUSE upstream must be an https URL ending in .git: ${upstream}`] };
  for (const c of consumers) {
    if (!isAbsolute(c) || d.git(['--git-dir', c, 'rev-parse', '--git-dir']).status !== 0) return { ok: false, lines: [`REFUSE consumer is not a git dir: ${c}`] };
    const push = d.git(['--git-dir', c, 'config', '--get-regexp', '^remote\\..*\\.pushurl$']);
    const bad = push.status === 0 ? push.stdout.split('\n').filter(l => l.split(' ')[1]?.startsWith(upstream)) : [];
    if (bad.length) return { ok: false, lines: [`REFUSE ${c}: explicit pushurl would follow the mirror (${bad[0]}) — remove it first`] };
  }
  if (!existsSync(mirror)) {
    mkdirSync(join(mirror, '..'), { recursive: true });
    const init = d.git(['init', '--quiet', '--bare', mirror]);
    if (init.status !== 0) return { ok: false, lines: [`FAIL git init --bare ${mirror}: ${init.stderr.trim()}`] };
    lines.push(`created ${mirror}`);
  }
  for (const [k, v] of [['uploadpack.allowFilter', 'true'], ['uploadpack.allowAnySHA1InWant', 'true'], ['gc.auto', '0']] as const) {
    d.git(['--git-dir', mirror, 'config', k, v]);
  }
  if (d.git(['--git-dir', mirror, 'rev-parse', '--verify', '--quiet', 'refs/heads/main']).status !== 0) {
    // First full fetch: no timeout (the whole repository) — only setup does this; the refresher's fetches are bounded.
    const t0 = d.now();
    const f = d.git(['--git-dir', mirror, 'fetch', '--prune', '--quiet', '--no-write-fetch-head', upstream, ...d.policy.mirror.refspecs]);
    if (f.status !== 0) return { ok: false, lines: [...lines, `FAIL first fetch: ${f.stderr.trim().split('\n').pop()}`] };
    d.git(['--git-dir', mirror, 'pack-refs', '--all']);
    lines.push(`first fetch ${Math.round((d.now() - t0) / 1000)} s`);
  }
  const prev = readMirrorState(d.stateRoot);
  const state: MirrorState = {
    schema: 1, mirror, upstream, consumers: [...new Set([...(prev?.mirror === mirror ? prev.consumers : []), ...consumers])],
    lastOkAt: d.now(), lastTryAt: d.now(), lastError: '', fallback: false, refreshes: (prev?.refreshes ?? 0), failures: (prev?.failures ?? 0),
  };
  writeJsonAtomic(mirrorStatePath(d.stateRoot), state);
  for (const c of state.consumers) {
    if (!configValues(d.git, c, pushInsteadOfKey(upstream)).includes(upstream)) d.git(['--git-dir', c, 'config', '--add', pushInsteadOfKey(upstream), upstream]);
  }
  for (const r of reconcileConsumers(d, state)) lines.push(`consumer ${r.gitDir}: ${r.change}${r.error ? ` (${r.error})` : ''}`);
  return { ok: true, lines };
}

/** Undo setup: every consumer fetches and pushes GitHub again; the registration is removed (the mirror directory is kept). */
export function teardownMirror(d: MirrorDeps): SetupResult {
  const s = readMirrorState(d.stateRoot);
  if (!s) return { ok: true, lines: ['no mirror registered'] };
  const lines = s.consumers.map((c) => {
    d.git(['--git-dir', c, 'config', '--unset-all', insteadOfKey(s.mirror)]);
    d.git(['--git-dir', c, 'config', '--unset-all', pushInsteadOfKey(s.upstream)]);
    return `consumer ${c}: to-github (mirror ${consumerUsesMirror(d.git, c, s) ? 'STILL SET' : 'unset'})`;
  });
  try { unlinkSync(mirrorStatePath(d.stateRoot)); } catch { /* gone */ }
  return { ok: true, lines };
}
