// TUI-SIGTTIN-SUSPEND (0.2.36 · 10-23 n8n) — the TUI must not be stopped because a child stole its terminal.
//
// Observed: the TUI's process group was no longer the foreground group of its own tty, its next stdin
// read raised SIGTTIN and zsh printed «suspended (tty input)» (state T). The trigger was an interactive
// login shell (`$SHELL -l -i -c printenv`, shell-env-bootstrap.ts) that opened /dev/tty for job control,
// moved the terminal to its own group and never gave it back. The root fix runs that capture with no
// controlling tty (`detached`). This module is the defence for any other child that does the same:
//
//   ① every tick, compare tcgetpgrp(stdin) with our own group;
//   ② if the foreground group is gone, or it is led by one of our own descendants (or its leader is
//      dead), it was taken by a child of ours → take it back (SIGTTOU ignored for that one call);
//   ③ if a live process that is NOT ours holds it (the user's shell after a real job-control action),
//      do not fight it — log `tui.lifecycle background-tty` once.
//
// Shared by both TUIs: `initTui()` (src/tui.ts) starts it for the classic dashboard and `--tui next`.

import { spawnSync } from 'node:child_process';
import { debug } from './debug/log.js';

export interface ForegroundFacts {
  /** Our process group id (getpgrp()). */
  ownPgid: number;
  /** tcgetpgrp(stdin) — -1 when it could not be read (stdin is not our controlling tty). */
  ttyPgid: number;
  /** Some process still exists in ttyPgid (kill(-ttyPgid, 0)). */
  groupAlive: boolean;
  /** The group leader (pid === ttyPgid) still exists. */
  leaderAlive: boolean;
  /** The group leader is one of our descendants. */
  leaderIsDescendant: boolean;
}

export type ForegroundVerdict =
  | { action: 'ok' }
  | { action: 'unknown' }
  | { action: 'reclaim'; reason: 'fg-group-gone' | 'fg-leader-gone' | 'fg-held-by-our-child'; ttyPgid: number }
  | { action: 'yield'; ttyPgid: number };

/** Pure decision — see the header for the rule. */
export function decideForeground(f: ForegroundFacts): ForegroundVerdict {
  if (f.ttyPgid < 0 || f.ownPgid < 0) return { action: 'unknown' };
  if (f.ttyPgid === f.ownPgid) return { action: 'ok' };
  if (!f.groupAlive) return { action: 'reclaim', reason: 'fg-group-gone', ttyPgid: f.ttyPgid };
  if (!f.leaderAlive) return { action: 'reclaim', reason: 'fg-leader-gone', ttyPgid: f.ttyPgid };
  if (f.leaderIsDescendant) return { action: 'reclaim', reason: 'fg-held-by-our-child', ttyPgid: f.ttyPgid };
  return { action: 'yield', ttyPgid: f.ttyPgid };
}

export interface ForegroundDeps {
  tcgetpgrp(): number;
  getpgrp(): number;
  /** tcsetpgrp(stdin, pgid) with SIGTTOU ignored for the call. Returns true on success. */
  reclaim(pgid: number): boolean;
  alive(pid: number): boolean;
  isDescendant(pid: number): boolean;
  log(event: string, data: Record<string, unknown>): void;
}

function exists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === 'EPERM'; }
}

/** Walks ppid from `pid` up to 1 and reports whether it passes through us. Only runs on an anomaly. */
function isOurDescendant(pid: number): boolean {
  let cur = pid;
  for (let i = 0; i < 64 && cur > 1; i++) {
    const r = spawnSync('ps', ['-o', 'ppid=', '-p', String(cur)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000 });
    const ppid = Number.parseInt(String(r.stdout ?? '').trim(), 10);
    if (!Number.isFinite(ppid) || ppid <= 0) return false;
    if (ppid === process.pid) return true;
    cur = ppid;
  }
  return false;
}

type Libc = { tcgetpgrp(fd: number): number; tcsetpgrp(fd: number, pgid: number): number; getpgrp(): number; signal(sig: number, handler: number | bigint): number | bigint };

let libcCache: Libc | null | undefined;
function libc(): Libc | null {
  if (libcCache !== undefined) return libcCache;
  libcCache = null;
  const path = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : process.platform === 'linux' ? 'libc.so.6' : null;
  if (!path || typeof (globalThis as { Bun?: unknown }).Bun === 'undefined') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { dlopen, FFIType } = require('bun:ffi') as typeof import('bun:ffi');
    const lib = dlopen(path, {
      tcgetpgrp: { args: [FFIType.i32], returns: FFIType.i32 },
      tcsetpgrp: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      getpgrp: { args: [], returns: FFIType.i32 },
      // sig_t signal(int, sig_t) — the handler is a pointer; i64 carries it in the same register.
      signal: { args: [FFIType.i32, FFIType.i64], returns: FFIType.i64 },
    });
    libcCache = lib.symbols as unknown as Libc;
  } catch {
    libcCache = null;
  }
  return libcCache;
}

const SIGTTOU = 22; // darwin and linux
const SIG_IGN = 1;

export function defaultForegroundDeps(): ForegroundDeps | null {
  const c = libc();
  if (!c) return null;
  return {
    tcgetpgrp: () => c.tcgetpgrp(0),
    getpgrp: () => c.getpgrp(),
    reclaim: (pgid) => {
      // A background tcsetpgrp raises SIGTTOU unless it is ignored — ignore it for this one call only.
      const prev = c.signal(SIGTTOU, SIG_IGN);
      try { return c.tcsetpgrp(0, pgid) === 0; } finally { c.signal(SIGTTOU, prev); }
    },
    alive: exists,
    isDescendant: isOurDescendant,
    log: (event, data) => debug.log('tui.lifecycle', event, data),
  };
}

/** One check. Exported for tests; the guard calls it on a timer. `state.yieldedTo` keeps the yield log to once per holder. */
export function checkForeground(deps: ForegroundDeps, state: { yieldedTo: number | null } = { yieldedTo: null }): ForegroundVerdict {
  const ownPgid = deps.getpgrp();
  const ttyPgid = deps.tcgetpgrp();
  if (ttyPgid < 0 || ttyPgid === ownPgid) {
    state.yieldedTo = null;
    return decideForeground({ ownPgid, ttyPgid, groupAlive: true, leaderAlive: true, leaderIsDescendant: false });
  }
  if (state.yieldedTo === ttyPgid) return { action: 'yield', ttyPgid };
  const groupAlive = deps.alive(-ttyPgid);
  const leaderAlive = groupAlive && deps.alive(ttyPgid);
  const leaderIsDescendant = leaderAlive && deps.isDescendant(ttyPgid);
  const verdict = decideForeground({ ownPgid, ttyPgid, groupAlive, leaderAlive, leaderIsDescendant });
  if (verdict.action === 'reclaim') {
    const ok = deps.reclaim(ownPgid);
    deps.log(ok ? 'foreground-reclaimed' : 'foreground-reclaim-failed', { reason: verdict.reason, ttyPgid, ownPgid });
  } else if (verdict.action === 'yield') {
    state.yieldedTo = ttyPgid;
    deps.log('background-tty', { ttyPgid, ownPgid, groupAlive, leaderAlive });
  }
  return verdict;
}

/** Starts the guard; returns stop(). No-op (returns a no-op) when libc/FFI is unavailable. */
export function startForegroundGuard(opts: { intervalMs?: number; deps?: ForegroundDeps | null } = {}): () => void {
  if (process.env.ELANOUS_TTY_FOREGROUND_GUARD === '0') return () => {};
  const deps = opts.deps === undefined ? defaultForegroundDeps() : opts.deps;
  if (!deps) return () => {};
  const state = { yieldedTo: null as number | null };
  const tick = (): void => { try { checkForeground(deps, state); } catch { /* fail-soft */ } };
  tick();
  const timer = setInterval(tick, opts.intervalMs ?? 250);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
