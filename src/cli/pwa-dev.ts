// `elanous nexus pwa dev` — Next.js dev server with HMR, paired with
// hot-swap of the running nexus's reverse-proxy upstream.
//
// User-driven design (2026-05-07): "거의 개발 간 default 이면 컨픽으로
// 할 필요 없음". The dev-proxy upstream lives only as nexus runtime
// state, mutated via `POST /v1/nexus/admin/pwa-dev-proxy` on start and
// `DELETE` on exit. No UserConfig persistence, no nexus restart — the
// admin endpoint hot-swaps an in-memory ref.
//
// Flow:
//   1. Resolve apps/pwa cwd + sanity-check node_modules.
//   2. POST the dev origin (`http://localhost:<port>`) to the admin
//      endpoint when a local nexus is reachable. Failures surface as
//      warnings — the dev spawn still runs (cross-origin fallback).
//   3. spawn `bun run dev` (foreground, stdio inherit, HMR enabled).
//   4. On exit (Ctrl-C, crash, normal): DELETE the admin endpoint so
//      nexus flips back to the static export.
//
// `--bg` / `--stop` / `--status` cover the background-managed lifecycle
// (P-2D.1). The body of this file is the foreground dev process — the
// detached child re-spawns itself foreground.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join as joinPath } from 'node:path';

import { resolveDaemonEndpoint, type ResolveDaemonEndpointOpts } from '../nexus/daemon-endpoint.js';
import { resolvePwaCwd } from './pwa-build.js';
import {
  isAliveNexusLock,
  readNexusLock,
  type NexusLockMeta,
} from '../nexus/supervisor/lock.js';

const ADMIN_DEV_PROXY_PATH = '/v1/nexus/admin/pwa-dev-proxy';
/** Bind interface for the next-dev child. Mirrors the nexus
 *  PWA_DEFAULT_HTTP_HOST in pwa-start.ts — both surfaces need to be
 *  reachable from Tailscale / LAN / container without extra flags. */
const DEFAULT_DEV_HOST = '0.0.0.0';
/** Watcher poll cadence for daemon-restart detection. The dev-proxy
 *  registration lives only as in-memory state on the running NEXUS,
 *  so when NEXUS restarts (different pid + startedAt in the lock),
 *  the new instance has no upstream and `/app/...` falls back to
 *  static export. The watcher re-POSTs registration so users don't
 *  need a manual `pwa dev --stop && pwa dev` after every restart.
 *  BACKLOG #2 from the 2026-05-09 dogfood HANDOFF. */
const DEFAULT_REREGISTER_POLL_INTERVAL_MS = 5000;

export interface PwaDevOpts {
  cwd?: string;
  argvBin?: string;
  port?: number;
  /** Bind interface for the Next.js dev server. Default `0.0.0.0` so
   *  Tailscale / LAN / container peers can reach it directly without
   *  going through nexus's reverse-proxy (e.g. for diagnosis). Pass
   *  `127.0.0.1` to opt out and revert to loopback-only. */
  host?: string;
  /** When false, skip POST/DELETE to the admin endpoint. Default true. */
  autoConfig?: boolean;
  /** Override the nexus base URL probed for hot-swap. When omitted the
   *  address comes from the daemon endpoint resolver; a missing daemon
   *  is reported, not guessed. */
  nexusBaseUrl?: string;
  /** Test seam — daemon address. `null` means this universe has no daemon. */
  resolveEndpoint?: (opts?: ResolveDaemonEndpointOpts) => { baseUrl: string } | null;
  spawnFn?: (cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<number>;
  out?: { log: (s: string) => void; error: (s: string) => void };
  skipNodeModulesCheck?: boolean;
  /** Polling interval (ms) for the daemon-restart re-register
   *  watcher. Default 5000. Set 0 to disable. Test seam — small values
   *  shrink the spawn lifetime needed to observe a re-POST. */
  reregisterPollIntervalMs?: number;
  // Test seams
  fetchFn?: typeof fetch;
  readNexusLockFn?: () => NexusLockMeta | null;
  isAliveNexusLockFn?: (meta: NexusLockMeta) => boolean;
}

export interface PwaDevResult {
  exitCode: number;
  cwd: string;
  port: number;
  /** True when POST to admin succeeded (nexus picked up the dev
   *  upstream). Side-effect of best-effort hot-swap. */
  hotSwappedOnStart: boolean;
  /** True when DELETE on admin succeeded. */
  clearedOnExit: boolean;
  /** Number of successful re-POSTs the watcher fired during the
   *  spawn lifetime. >0 means at least one daemon restart was
   *  detected and recovered transparently. */
  reregisterCount: number;
}

function defaultSpawn(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit', env });
    const forward = (sig: NodeJS.Signals) => {
      try { child.kill(sig); } catch { /* already gone */ }
    };
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    child.on('error', (err) => {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
      if (signal === 'SIGINT' || signal === 'SIGTERM') resolve(0);
      else resolve(code ?? (signal ? 1 : 0));
    });
  });
}

async function postDevProxy(
  baseUrl: string,
  upstream: string,
  fetchFn: typeof fetch,
): Promise<boolean> {
  try {
    const res = await fetchFn(`${baseUrl}${ADMIN_DEV_PROXY_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upstream }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function deleteDevProxy(
  baseUrl: string,
  fetchFn: typeof fetch,
): Promise<boolean> {
  try {
    const res = await fetchFn(`${baseUrl}${ADMIN_DEV_PROXY_PATH}`, {
      method: 'DELETE',
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function runPwaDev(opts: PwaDevOpts = {}): Promise<PwaDevResult> {
  const out = opts.out ?? console;
  const port = opts.port ?? 3210;
  const autoConfig = opts.autoConfig !== false;
  const argvBin = opts.argvBin ?? process.argv[1] ?? '';
  const cwd = opts.cwd ?? resolvePwaCwd(argvBin);
  if (!cwd) {
    out.error(`elanous nexus pwa dev: could not locate apps/pwa (argv[1]=${argvBin || '(empty)'})`);
    out.error('Pass --cwd <path> or run from a checkout of the monad-agent repo.');
    return { exitCode: 1, cwd: '', port, hotSwappedOnStart: false, clearedOnExit: false, reregisterCount: 0 };
  }
  if (!opts.skipNodeModulesCheck && !existsSync(joinPath(cwd, 'node_modules'))) {
    out.error(`elanous nexus pwa dev: ${cwd}/node_modules is missing.`);
    out.error('apps/pwa is a standalone bun package — run once:');
    out.error(`  cd ${cwd} && bun install`);
    return { exitCode: 1, cwd, port, hotSwappedOnStart: false, clearedOnExit: false, reregisterCount: 0 };
  }

  const fetchFn = opts.fetchFn ?? fetch;
  const readLockFn = opts.readNexusLockFn ?? readNexusLock;
  const isAliveFn = opts.isAliveNexusLockFn ?? isAliveNexusLock;
  const baseUrl = opts.nexusBaseUrl ?? (opts.resolveEndpoint ?? resolveDaemonEndpoint)()?.baseUrl ?? null;

  out.log(`elanous nexus pwa dev: ${cwd}`);
  const hostShown = opts.host ?? DEFAULT_DEV_HOST;
  out.log(`  bun run dev  (Next.js dev server · ${hostShown}:${port} · HMR enabled)`);

  const upstream = `http://localhost:${port}`;
  let hotSwappedOnStart = false;

  // Track which daemon instance owns the registration so the watcher
  // can re-POST when the lock pid + startedAt change (i.e. NEXUS
  // restarted and the in-memory dev-proxy upstream was reset).
  let lastSeenPid: number | null = null;
  let lastSeenStartedAt: string | null = null;

  if (autoConfig && !baseUrl) {
    out.error('  nexus: daemon address unknown — a port is not guessed. Pass --nexus-url or start the daemon.');
  } else if (autoConfig && baseUrl) {
    const lock = readLockFn();
    if (lock && isAliveFn(lock)) {
      out.log(`  nexus: live lock detected (pid ${lock.pid}) — POST ${ADMIN_DEV_PROXY_PATH}`);
      const ok = await postDevProxy(baseUrl, upstream, fetchFn);
      if (ok) {
        hotSwappedOnStart = true;
        lastSeenPid = lock.pid;
        lastSeenStartedAt = lock.startedAt;
        out.log(`  nexus: dev-proxy ON  (upstream=${upstream}) — single-origin live`);
      } else {
        out.error('  nexus: admin POST failed — falling back to cross-origin dev only');
      }
    } else {
      out.log('  nexus: no live lock — start one with `elanous nexus run`.');
    }
  } else {
    out.log('  --no-auto-config — admin endpoint untouched.');
  }

  out.log(`  → single-origin (when nexus is up): ${baseUrl ? `${baseUrl}/app/` : '(daemon address unknown)'}`);
  out.log(`  → cross-origin (always):           http://localhost:${port}/app/`);
  out.log('  Ctrl-C to stop.');

  // PORT + HOSTNAME envs are how Next.js's `next dev` picks the bind
  // socket (no -H/-p flag plumbing needed). 0.0.0.0 default lets
  // Tailscale / LAN peers reach the dev server directly; opt out via
  // `--host 127.0.0.1` per `PwaDevOpts.host`.
  const host = opts.host ?? DEFAULT_DEV_HOST;
  const env = { ...process.env, PORT: String(port), HOSTNAME: host };
  const spawnFn = opts.spawnFn ?? defaultSpawn;

  // BACKLOG #2 (2026-05-09 dogfood) — daemon-restart re-register
  // watcher. Polls the lock + re-POSTs when pid OR startedAt
  // changed. Cleared in `finally` so a fast spawn exit can still
  // race a poll cleanly. autoConfig=false skips the watcher (caller
  // opted out of admin-endpoint mutation entirely).
  const pollIntervalMs = opts.reregisterPollIntervalMs ?? DEFAULT_REREGISTER_POLL_INTERVAL_MS;
  const watcherEnabled = autoConfig && baseUrl !== null && pollIntervalMs > 0;
  let reregisterCount = 0;
  let watcherTimer: ReturnType<typeof setInterval> | null = null;
  if (watcherEnabled) {
    watcherTimer = setInterval(() => {
      void (async () => {
        let cur: NexusLockMeta | null;
        try { cur = readLockFn(); } catch { return; }
        if (!cur || !isAliveFn(cur)) return;
        if (cur.pid === lastSeenPid && cur.startedAt === lastSeenStartedAt) return;
        const fromLabel =
          lastSeenPid !== null
            ? `pid ${lastSeenPid}`
            : 'no prior registration';
        out.log(`  nexus: ${fromLabel} → pid ${cur.pid} (startedAt=${cur.startedAt}) — re-POST ${ADMIN_DEV_PROXY_PATH}`);
        const ok = await postDevProxy(baseUrl, upstream, fetchFn);
        if (ok) {
          reregisterCount += 1;
          lastSeenPid = cur.pid;
          lastSeenStartedAt = cur.startedAt;
          if (!hotSwappedOnStart) hotSwappedOnStart = true;
          out.log(`  nexus: dev-proxy re-registered (upstream=${upstream})`);
        } else {
          out.error('  nexus: admin re-POST failed — pwa-dev-proxy lost; manual:');
          out.error(`    curl -X POST -H 'content-type: application/json' -d '{"upstream":"${upstream}"}' ${baseUrl}${ADMIN_DEV_PROXY_PATH}`);
        }
      })();
    }, pollIntervalMs);
    // Don't keep the event loop alive solely for this watcher; the
    // spawnFn promise is the lifetime.
    (watcherTimer as unknown as { unref?: () => void }).unref?.();
  }

  let exitCode = 1;
  let clearedOnExit = false;
  try {
    exitCode = await spawnFn('bun', ['run', 'dev'], cwd, env);
  } finally {
    if (watcherTimer) clearInterval(watcherTimer);
    if (autoConfig && baseUrl && hotSwappedOnStart) {
      const ok = await deleteDevProxy(baseUrl, fetchFn);
      if (ok) {
        clearedOnExit = true;
        out.log('  nexus: dev-proxy OFF (back to static export)');
      } else {
        out.error('  nexus: admin DELETE failed — flip back manually with:');
        out.error(`    curl -X DELETE ${baseUrl}${ADMIN_DEV_PROXY_PATH}`);
      }
    }
  }

  if (exitCode === 0) out.log('✓ pwa dev stopped cleanly.');
  else out.error(`✗ pwa dev exited with code ${exitCode}.`);

  return { exitCode, cwd, port, hotSwappedOnStart, clearedOnExit, reregisterCount };
}
