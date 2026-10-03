// `elanous nexus pwa stop` — one command to take down everything that
// `elanous nexus pwa start` brought up.
//
// Cascade order (best-effort each step):
//   1. Per-port Tailscale Serve unmount — drop the tls-tcp forward we
//      set up for THIS port via the share lifecycle. Idempotent: if no
//      serve was active, the unmount is a no-op. Skipping when
//      tailscale is missing avoids the "command not found" noise on
//      hosts that never installed it. As of P1 mode unification
//      (2026-05-10) this is per-port (not global `serve reset`) so
//      concurrent multi-instance mounts on other ports survive.
//   2. PWA dev BG (apps/pwa next-dev) — `runPwaDevStop`
//      That stop also DELETEs the admin endpoint via the BG child's
//      `pwa-dev` cleanup `finally`, so nexus flips back to static.
//   3. Nexus daemon — same SIGINT path as `elanous nexus stop`.
//
// `pwa stop` works whether dev mode was ever active. When the dev lock
// is missing or stale we just clear it and proceed to the nexus stop.

import { unmountTailscaleServe } from './tailscale-serve.js';
import { runPwaDevStop, type PwaDevStopResult } from './pwa-dev-bg.js';
import { probeTailscale, type TailscaleProbe } from '../nexus/onboarding/tailscale-probe.js';
import { unregisterPwaInstance } from './pwa-registry.js';
import { readNexusLock } from '../nexus/supervisor/lock.js';
import { resolveNexusPwa, type NexusPwaResolution } from './nexus-show.js';
import { debug } from '../debug/log.js';
import { isPidAlive } from '../process/pid-liveness.js';
import { execFileSync } from 'node:child_process';
import { join as joinPath, resolve as resolvePath } from 'node:path';
import { hostname } from 'node:os';
import { safeReadLock } from '../telegram-lock.js';

export interface PwaStopOpts {
  out?: { log: (s: string) => void; error: (s: string) => void };
  /** Test seam — replace the dev BG stop helper. */
  devStopFn?: () => Promise<PwaDevStopResult>;
  /** Test seam — replace the nexus stop trigger. Default = dynamic
   *  import of `runNexus({stop:true})`. */
  nexusStopFn?: () => Promise<{ exitCode: number }>;
  /** Test seam — probe tailscale presence (skip unmount on hosts without it). */
  shareProbeFn?: () => Promise<TailscaleProbe>;
  /** Test seam — unmount THIS port's tls-tcp serve. Default = unified
   *  `unmountTailscaleServe({ mode: { kind: 'tls-tcp', port } })`. */
  shareResetFn?: (binary: string, port: number) => Promise<{ exitCode: number }>;
  /** Port whose tls-tcp serve is unmounted. Explicit values override daemon resolution. */
  port?: number;
  /** Test seam — resolve the daemon PWA URL used to determine its live port. */
  resolveNexusPwaFn?: () => NexusPwaResolution;
  /** P4 — replace the registry unregister call. Default reads
   *  `~/.elanous/nexus/.lock` to get the daemon pid + drops that entry
   *  from `~/.elanous/pwa-registry.json`. */
  unregisterFn?: (pid: number) => void;
  /** P4 — read the nexus lock to recover daemon pid. Test seam. */
  readLockFn?: () => { pid: number; host?: string; startedAt?: string } | null;
  /** Isolated test daemon stop only: the project-local root to inspect for orphans. */
  isolatedRoot?: string;
  /** Test seams for signals, liveness and bounded polling. */
  signalFn?: (pid: number, signal: 'SIGINT' | 'SIGTERM') => void;
  pidAliveFn?: (pid: number) => boolean;
  sleepFn?: (ms: number) => Promise<void>;
  stopTimeoutMs?: number;
  nowFn?: () => number;
  /** Process table for isolated daemon identity checks and orphan discovery (pid, start time, argv). */
  processTableFn?: () => Array<{ pid: number; startedAt: string; args: string }>;
  /** Test seam for the raw `ps -eo pid=,lstart=,args=` response. */
  psOutputFn?: () => string;
}

export type PwaStopShareUnmount =
  | { status: 'success'; port: number; source: 'explicit' | 'nexus' }
  | { status: 'failed'; port: number; source: 'explicit' | 'nexus'; exitCode?: number; error?: string }
  | { status: 'skipped'; reason: 'pwa-port-unknown' | 'pwa-query-failed' | 'tailscale-unavailable' };

export interface PwaStopResult {
  exitCode: number;
  /** True when the dev BG was actually killed (vs no-lock no-op). */
  devKilled: boolean;
  /** True when the daemon stop completed (or the ordinary stop trigger succeeded). */
  nexusStopped: boolean;
  /** True when `tailscale serve reset` was issued (not skipped). */
  shareReset: boolean;
  /** Outcome of the port-specific Tailscale Serve unmount. */
  shareUnmount: PwaStopShareUnmount;
  /** P4 — pid removed from the registry (when a lock file existed). */
  unregisteredPid?: number;
}

async function defaultNexusStop(): Promise<{ exitCode: number }> {
  const { runNexus } = await import('../nexus/index.js');
  await runNexus({ stop: true });
  return { exitCode: 0 };
}

function runningProcesses(output: string): Array<{ pid: number; startedAt: string; args: string }> {
  const lines = output.split('\n');
  return lines.flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+((?:\S+\s+){4}\d{4})\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), startedAt: match[2]!, args: match[3]! }] : [];
  });
}

type ProcessRow = ReturnType<typeof runningProcesses>[number];

function isolatedDaemons(root: string, table: ProcessRow[]): ProcessRow[] {
  return table.filter(row => {
    if (!/^(?:(?:\S*\/)?(?:bun|node)\s+)?(?:\S*\/)?elanous(?:\.(?:mjs|cjs))?\s/.test(row.args)
        || !/(?:^|\s)nexus\s+run(?:\s|$)/.test(row.args)) return false;
    const roots = ['--config-dir', '--test-state-dir'].flatMap(flag => {
      const value = row.args.match(new RegExp(`(?:^|\\s)${flag}(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|(\\S+))`));
      const arg = value?.[1] ?? value?.[2] ?? value?.[3];
      return arg === undefined ? [] : [resolvePath(arg)];
    });
    return roots.length > 0 && roots.every(value => value === resolvePath(root));
  });
}

async function stopIsolatedNexus(
  opts: PwaStopOpts,
  out: NonNullable<PwaStopOpts['out']>,
  lock: ReturnType<NonNullable<PwaStopOpts['readLockFn']>>,
): Promise<{ exitCode: number }> {
  const root = opts.isolatedRoot!;
  const inspect = (): ProcessRow[] => isolatedDaemons(root, opts.processTableFn
    ? opts.processTableFn()
    : runningProcesses((opts.psOutputFn ?? (() => execFileSync('ps', ['-eo', 'pid=,lstart=,args='], { encoding: 'utf8' })))()));
  const reportOrphans = (): { exitCode: number } => {
    const orphans = inspect();
    debug.log('nexus.stop', 'orphans', { pid: 0, waitedMs: 0, count: orphans.length });
    if (orphans.length === 0) {
      out.log('  nothing to stop (no lock)');
      return { exitCode: 0 };
    }
    for (const row of orphans) out.error(`  orphan pid ${row.pid} · started ${row.startedAt} · root ${root}`);
    out.error(`  cleanup: ${orphans.map(row => `kill ${row.pid}`).join(' ; ')}`);
    return { exitCode: 1 };
  };
  if (!lock) {
    try { return reportOrphans(); }
    catch (error) {
      out.error(`  cannot inspect nexus processes: ${error instanceof Error ? error.message : String(error)}`);
      return { exitCode: 1 };
    }
  }
  const pid = lock.pid;
  if (lock.host && lock.host !== hostname()) {
    out.error(`  nexus lock held by remote host ${lock.host}; cannot stop from here`);
    return { exitCode: 1 };
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    out.error(`  invalid nexus lock pid ${pid}`);
    return { exitCode: 1 };
  }
  const signal = opts.signalFn ?? ((target: number, name: 'SIGINT' | 'SIGTERM') => process.kill(target, name));
  const alive = opts.pidAliveFn ?? isPidAlive;
  const sleep = opts.sleepFn ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const timeout = opts.stopTimeoutMs ?? 10_000;
  const now = opts.nowFn ?? Date.now;
  let waitedMs = 0;
  const wait = async (): Promise<boolean> => {
    const start = now();
    let elapsed = 0;
    while (alive(pid) && elapsed < timeout) {
      const interval = Math.min(100, timeout - elapsed);
      await sleep(interval);
      elapsed = Math.max(elapsed + interval, now() - start);
    }
    waitedMs += elapsed;
    debug.log('nexus.stop', 'wait', { pid, waitedMs, count: 1 });
    return !alive(pid);
  };
  try {
    if (!alive(pid)) return reportOrphans();
    const identity = inspect().find(row => row.pid === pid);
    if (!identity) {
      out.error(`  pid ${pid} does not match this tree's isolated nexus daemon; no signal sent`);
      return { exitCode: 1 };
    }
    if (lock.startedAt) {
      const processStart = Date.parse(identity.startedAt);
      const lockStart = Date.parse(lock.startedAt);
      if (!Number.isFinite(processStart) || !Number.isFinite(lockStart) || processStart > lockStart + 1_000) {
        out.error(`  pid ${pid} start time cannot match the nexus lock; no signal sent`);
        return { exitCode: 1 };
      }
    }
    // Recheck the argv and start time immediately before each signal: a stale
    // lock or a PID recycled during the wait must never target another process.
    const stillOwned = (): boolean => inspect().some(row => row.pid === pid && row.startedAt === identity.startedAt && row.args === identity.args);
    if (!stillOwned()) {
      out.error(`  pid ${pid} no longer matches the locked daemon; no signal sent`);
      return { exitCode: 1 };
    }
    signal(pid, 'SIGINT');
    out.log(`  SIGINT sent to pid ${pid}`);
    if (await wait()) return { exitCode: 0 };
    if (!alive(pid)) return { exitCode: 0 };
    if (!stillOwned()) {
      out.error(`  pid ${pid} no longer matches the locked daemon; SIGTERM not sent`);
      return { exitCode: 1 };
    }
    signal(pid, 'SIGTERM');
    debug.log('nexus.stop', 'escalated', { pid, waitedMs, count: 1 });
    if (await wait()) return { exitCode: 0 };
  } catch (error) {
    out.error(`  pid ${pid} 이 멈추지 않았다: ${error instanceof Error ? error.message : String(error)}`);
    debug.log('nexus.stop', 'stuck', { pid, waitedMs, count: 1 });
    return { exitCode: 1 };
  }
  out.error(`  pid ${pid} 이 멈추지 않았다`);
  debug.log('nexus.stop', 'stuck', { pid, waitedMs, count: 1 });
  return { exitCode: 1 };
}

async function defaultShareReset(binary: string, port: number): Promise<{ exitCode: number }> {
  const r = await unmountTailscaleServe({
    mode: { kind: 'tls-tcp', port },
    upstreamPort: port,
    useSudo: true,
    probeFn: async () => ({
      installed: true,
      alive: true,
      hostname: 'localhost',
      magicDnsHost: 'localhost',
      binary,
    }),
  });
  if (r.ok) return { exitCode: 0 };
  if (r.reason === 'serve-cmd-failed' || r.reason === 'no-state') return { exitCode: 0 };
  return { exitCode: 1 };
}

function resolveShareUnmountPort(opts: PwaStopOpts):
  | { port: number; source: 'explicit' | 'nexus' }
  | { reason: 'pwa-port-unknown' | 'pwa-query-failed' } {
  if (opts.port !== undefined) return { port: opts.port, source: 'explicit' };
  try {
    const pwa = (opts.resolveNexusPwaFn ?? resolveNexusPwa)();
    if (!('loopback' in pwa)) return { reason: 'pwa-port-unknown' };
    const port = Number(new URL(pwa.loopback).port);
    return Number.isInteger(port) && port >= 1 && port <= 65_535
      ? { port, source: 'nexus' }
      : { reason: 'pwa-port-unknown' };
  } catch {
    return { reason: 'pwa-query-failed' };
  }
}

export async function runPwaStop(opts: PwaStopOpts = {}): Promise<PwaStopResult> {
  const out = opts.out ?? console;
  const portResolution = resolveShareUnmountPort(opts);
  const devStopFn = opts.devStopFn ?? (() => runPwaDevStop({ out }));
  const shareProbeFn = opts.shareProbeFn ?? (() => probeTailscale());
  const shareResetFn = opts.shareResetFn ?? defaultShareReset;
  const unregisterFn = opts.unregisterFn ?? (opts.isolatedRoot ? undefined : unregisterPwaInstance);
  const readLockFn = opts.readLockFn ?? (opts.isolatedRoot
    ? () => safeReadLock(joinPath(opts.isolatedRoot!, 'nexus', '.lock'))
    : () => readNexusLock());

  out.log('elanous nexus pwa stop: cascade');

  // Per-port unmount first — release THIS port's tls-tcp forward
  // before nexus dies. Idempotent and unconditional: the user's
  // switch state is irrelevant to "drop the forward we may have left
  // running on this port"; if nothing is forwarded the unmount is a
  // no-op. Concurrent multi-instance mounts on OTHER ports survive
  // (P1 unification: per-port, not global `serve reset`).
  let shareReset = false;
  let shareUnmount: PwaStopShareUnmount = 'port' in portResolution
    ? { status: 'skipped', reason: 'tailscale-unavailable' }
    : { status: 'skipped', reason: portResolution.reason };
  if (!('port' in portResolution)) {
    out.log(`  (share unmount skipped — ${portResolution.reason})`);
  }
  if ('port' in portResolution) {
    let probe: TailscaleProbe | undefined;
    try {
      probe = await shareProbeFn();
    } catch { /* tailscale probe threw — preserve the existing skip behavior */ }
    if (probe?.installed) {
      try {
        const r = await shareResetFn(probe.binary ?? 'tailscale', portResolution.port);
        shareReset = true;
        shareUnmount = r.exitCode === 0
          ? { status: 'success', port: portResolution.port, source: portResolution.source }
          : { status: 'failed', port: portResolution.port, source: portResolution.source, exitCode: r.exitCode };
        if (r.exitCode !== 0) {
          out.log(`  (share unmount exit ${r.exitCode} — port :${portResolution.port} may still be forwarded)`);
        }
      } catch (error) {
        shareReset = true;
        const message = error instanceof Error ? error.message : String(error);
        shareUnmount = { status: 'failed', port: portResolution.port, source: portResolution.source, error: message };
        out.log(`  (share unmount failed — port :${portResolution.port} may still be forwarded: ${message})`);
      }
    }
  }

  // P4 registry unregister — read the lock for the daemon pid before
  // we send SIGINT (the lock is removed during stop). The isolated stop
  // never writes to the production registry. Missing lock/pid is best-effort.
  let unregisteredPid: number | undefined;
  let lock: ReturnType<typeof readLockFn> = null;
  try { lock = readLockFn(); }
  catch (error) {
    if (opts.isolatedRoot) {
      out.error(`  cannot read nexus lock: ${error instanceof Error ? error.message : String(error)}`);
      return { exitCode: 1, devKilled: false, nexusStopped: false, shareReset, shareUnmount };
    }
  }
  try {
    if (lock && typeof lock.pid === 'number' && (!opts.isolatedRoot || !lock.host || lock.host === hostname())) {
      if (unregisterFn) {
        unregisterFn(lock.pid);
        unregisteredPid = lock.pid;
      }
    }
  } catch { /* registry unregister failure — non-fatal */ }

  const devR = await devStopFn();
  const nexusR = await (opts.nexusStopFn ?? (opts.isolatedRoot
    ? () => stopIsolatedNexus(opts, out, lock)
    : defaultNexusStop))();
  const exitCode = devR.exitCode === 0 && nexusR.exitCode === 0 ? 0 : 1;
  return {
    exitCode,
    devKilled: devR.killed,
    nexusStopped: nexusR.exitCode === 0,
    shareReset,
    shareUnmount,
    ...(unregisteredPid !== undefined ? { unregisteredPid } : {}),
  };
}
