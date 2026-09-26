import { runBgLaunch, type BgLaunchResult } from './bg-launch.js';
import {
  runPwaDevBgLaunch,
  runPwaDevStop,
  type PwaDevBgLaunchResult,
  type PwaDevStopResult,
} from './pwa-dev-bg.js';
import { defaultServe } from '../nexus/onboarding/pwa-share-prompt.js';
import { probeTailscale, type TailscaleProbe } from '../nexus/onboarding/tailscale-probe.js';
import {
  readSwitchValue,
  readUserConfig,
} from '../nexus/config/user-config.js';
import { registerPwaInstance, listPwaInstances, type PwaRegistryEntry, type PwaLauncherProvenance } from './pwa-registry.js';
import { debug } from '../debug/log.js';
import { runPwaBuild, checkPwaBuildDeps, resolvePwaCwd, type PwaBuildResult } from './pwa-build.js';
import { runPwaInstall, type PwaInstallResult } from './pwa-install.js';
import { runPwaStop, type PwaStopOpts, type PwaStopResult } from './pwa-stop.js';
import { checkPwaStaleness } from './pwa-staleness.js';
import { unmountTailscaleServe, type UnmountTailscaleServeResult } from './tailscale-serve.js';
import { nexusRootDir } from '../nexus/paths.js';
import { resolveCurrentInstance } from '../instance/current.js';
import { leaseTestPort, releaseTestPort, transferTestPort } from './port-lease-local.js';
import { isPidAlive } from '../process/pid-liveness.js';
import type { InstanceResolution } from '../instance/resolve.js';

type ShareTailnetValue = 'ask' | 'enabled' | 'disabled';

export type PwaStartMode = 'static' | 'hmr';

/** P3 (2026-05-10) — fall back to UserConfig when CLI flags omit a port.
 *  Resolution order (highest precedence first):
 *    1. CLI flag (`--http-port` / `--dev-port`)
 *    2. UserConfig: `global.nexus.pwa.{port,devPort}` (set via
 *       `elanous config set global.nexus.pwa.port 31420`)
 *    3. Hard-coded defaults (`port=31415` · `devPort=3210`).
 *  CLI flag wins → ad-hoc override per run · config 영구 변경. */
function defaultReadConfigPort(switchId: string): number | undefined {
  try {
    const v = readSwitchValue(readUserConfig(), switchId);
    if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 65536) return v;
  } catch { /* swallow — config absent or malformed, use hard default */ }
  return undefined;
}

export interface PwaStartOpts {
  /** Names the *serving* mode, not a deploy environment:
   *  - `'static'` (default) = nexus only, serves the `apps/pwa/out`
   *    static export at `/app/*`. Frozen bundle — no HMR side effects
   *    (stale chunks, 308 redirects, transient delta during edits).
   *  - `'hmr'`              = nexus + Next.js dev BG + admin hot-swap;
   *    nexus reverse-proxies `/app/*` into next-dev so the iteration
   *    loop sees HMR through the same origin (cookies + SW preserved).
   *
   *  Default is `'static'` because the static bundle is the "calm"
   *  default — no transient HMR delta interfering with dogfood. Switch
   *  to `'hmr'` (`--hmr`) when you're actively iterating on PWA UI.
   *  `elanous nexus pwa stop` cascades any BG that the start mode
   *  brought up, so callers don't have to remember which mode is
   *  active. */
  mode?: PwaStartMode;
  /** HMR mode only: Next.js dev server port. Default 3210. */
  devPort?: number;
  /** Bind both nexus AND next-dev to `127.0.0.1` instead of the
   *  `0.0.0.0` default. Convenience flag for the "this machine only"
   *  posture (no LAN / no Tailscale exposure) in a single switch
   *  instead of two (`--http-host 127.0.0.1` + `--host 127.0.0.1`).
   *
   *  Precedence: explicit `httpHost` wins over `loopback` (so a
   *  caller can still pin nexus to a specific interface and let dev
   *  follow loopback). When unset, falls back to the 0.0.0.0
   *  default. */
  loopback?: boolean;
  force?: boolean;
  toolCwd?: string;
  historyDir?: string;
  httpHost?: string;
  httpPort?: number;
  /** Coordinator lease passed to the detached daemon (not used for explicit ports). */
  coordinatorLeasePort?: number;
  coordinatorLeaseToken?: string;
  coordinatorLeaseId?: string;
  /** P3 (2026-05-10) — read UserConfig fallback for ports. Default
   *  reads `global.nexus.pwa.{port,devPort}`. Test seam to inject a
   *  fixture without touching disk. */
  readConfigPortFn?: (switchId: string) => number | undefined;
  /** P4 (2026-05-10) — replace the registry register call. Default
   *  writes to `~/.elanous/pwa-registry.json`. Test seam to keep
   *  registry off disk. */
  registerInstanceFn?: (entry: PwaRegistryEntry) => void;
  /** P2 (2026-05-10) — force-enable Tailnet share for THIS run only.
   *  Bypasses the `global.nexus.pwa.shareTailnet` switch (so the user's
   *  daily-driver disabled/ask state is untouched) and mounts a
   *  `tls-tcp` Tailscale Serve for `httpPort` directly. config 비저장
   *  — restart 시 다시 명시 필요. `share enable` 처럼 영구 효과가
   *  필요하면 그 명령을 사용. */
  https?: boolean;
  /** Static mode only: when `apps/pwa/out` is stale relative to the
   *  source tree, run `runPwaBuild` once before nexus boots. Default
   *  true. Opt out via `--no-auto-build` for fast restarts when the user
   *  knows the bundle is fresh. HMR mode ignores this — dev server owns
   *  iteration. */
  autoBuild?: boolean;
  /** When `apps/pwa/node_modules` is missing (fresh clone / pulled
   *  lockfile / pruned tree), run `bun install` inside `apps/pwa` before
   *  attempting a build. CLI default on for `nexus run`; lib-level
   *  opt-in so existing tests stay green. */
  autoInstall?: boolean;
  /** When `bg-launch` reports a port collision AND the lock holder lives
   *  in the same tree (same cwd / daemonDir), stop the holder and retry
   *  start. Cross-tree collisions still print the 4-option hint. Default
   *  true. Opt out via `--no-auto-restart` to keep the legacy collision
   *  surface. */
  autoRestart?: boolean;
  /** Force a build before start (skips the staleness check). HMR mode
   *  also runs the build so the static export stays current for the
   *  prod-mode flip. */
  rebuild?: boolean;
  /** Static mode only: spawn an fs.watch loop inside the daemon process
   *  so source edits trigger an automatic rebuild. Bundle is hot-served
   *  by nexus on the next request — clients refresh to pick it up. HMR
   *  mode ignores this. */
  watch?: boolean;
  /** When `false`, forward `--no-mcp` to the bg-launched daemon so its
   *  MCP-client boot is skipped (PR1 2026-05-13). Default undefined =
   *  leave the decision to the daemon-side `mcp.enabled` config. */
  mcpEnabled?: boolean;
  out?: { log: (s: string) => void; error: (s: string) => void };
  // ─── Test seams ─────────────────────────────────────────────
  bgLaunchFn?: (opts: {
    force?: boolean;
    forwardArgs?: string[];
    childEnv?: Record<string, string>;
    out?: { log: (s: string) => void; error: (s: string) => void };
  }) => Promise<BgLaunchResult>;
  /** P-2D.3' — replace the dev BG launcher (default = runPwaDevBgLaunch). */
  devLaunchFn?: (opts: { port?: number; host?: string; out?: PwaStartOpts['out'] }) => Promise<PwaDevBgLaunchResult>;
  /** Replace the dev BG stopper (default = runPwaDevStop). Used when the
   *  dev readiness probe times out so the orphaned BG actually gets
   *  cleaned up instead of just being mentioned in an error string. */
  devStopFn?: () => Promise<PwaDevStopResult>;
  /** P-2D.3' — replace fetch (used to probe health + POST admin endpoint). */
  fetchFn?: typeof fetch;
  /** P-2D.3' — sleep helper for the health-probe loop. */
  sleepFn?: (ms: number) => Promise<void>;
  /** P-2D.3' — wall clock (used by health-probe deadlines). */
  now?: () => number;
  // ─── Share lifecycle seams ──────────────────────────────────────
  /** Read the `global.nexus.pwa.shareTailnet` switch. */
  readShareSwitchFn?: () => ShareTailnetValue;
  /** Probe Tailscale presence + alive state. */
  shareProbeFn?: () => Promise<TailscaleProbe>;
  /** Run `tailscale serve --bg --tls-terminated-tcp <port> tcp://localhost:<port>`. */
  shareServeFn?: (binary: string, port: number) => Promise<{ exitCode: number }>;
  // ─── Auto-build / auto-restart seams ────────────────────────────
  /** Resolve `apps/pwa` dir (default = sibling to argv[1]). */
  resolvePwaCwdFn?: () => string | undefined;
  /** Run the staleness check (default = mtime walk). Returning
   *  `stale=true` triggers a one-shot build. */
  stalenessFn?: (pwaCwd: string) => { stale: boolean; reason: string };
  /** Run `runPwaBuild` (default). Test seam to count invocations. */
  buildFn?: (cwd: string) => Promise<PwaBuildResult>;
  /** Run `runPwaInstall` (default). Test seam — production shells out
   *  to `bun install` in apps/pwa. */
  installFn?: (cwd: string) => Promise<PwaInstallResult>;
  /** Run `tailscale serve … off` cleanup before bg-launch when nothing
   *  answers `/v1/health` on the target port. Lib-level opt-in; CLI
   *  flips default on so daily users self-heal from crashed daemons. */
  preflightStaleServe?: boolean;
  /** Verify the daemon actually responds on /v1/health after bg-launch.
   *  Lib-level opt-in (existing pwa-start tests skip the live probe);
   *  CLI flips default on so users learn about bind failures
   *  immediately instead of via a broken tailnet URL hours later. */
  verifyListen?: boolean;
  /** Probe whether the nexus port already has a healthy responder.
   *  Default = single GET against `${nexusBase}/v1/health`. Returning
   *  `true` skips the stale-serve preflight (something on that port
   *  responds — same-tree auto-restart will handle it). */
  healthProbeFn?: (port: number) => Promise<boolean>;
  /** Best-effort `tailscale serve … off` to release a stale binding
   *  before bg-launch. Default = `unmountTailscaleServe` with sudo. */
  unmountServeFn?: (port: number) => Promise<UnmountTailscaleServeResult>;
  /** Check whether `apps/pwa/node_modules` carries the required deps.
   *  Default = `checkPwaBuildDeps` from `pwa-build.ts`. */
  depsCheckFn?: (cwd: string) => { ok: boolean; missing: string[] };
  /** Stop a same-tree daemon before retrying bg-launch. Default =
   *  `runPwaStop`. */
  stopFn?: (opts: PwaStopOpts) => Promise<PwaStopResult>;
  /** Read pwa-registry for the same-tree collision check. */
  listInstancesFn?: () => Array<{ cwd: string; alive: boolean; daemonDir: string; pid?: number; launcherProvenance?: PwaLauncherProvenance }>;
  /** Resolve the current process instance. Test seam for registry kind. */
  resolveCurrentInstanceFn?: () => InstanceResolution;
  /** Isolate local test leases in a temporary directory in tests. */
  leaseDir?: string;
}

export interface PwaStartResult {
  exitCode: number;
}

/** Default bind interface for the PWA service path.
 *
 *  Loopback (`127.0.0.1`) is the right default for the bare
 *  `elanous nexus run` (CLI-only, no remote consumers). `pwa start`
 *  is different: PWA consumers are usually on other devices —
 *  iPad / iPhone / second laptop — reaching us over Tailscale.
 *  Tailscale Serve forwards 100.x → loopback, so the loopback
 *  default *technically* works, but it stops working the moment a
 *  user wants to skip Tailscale (LAN dogfood, hotel wifi without
 *  tailnet) or runs in a container/VM.
 *
 *  Picking 0.0.0.0 by default so `pwa start` "just works" from any
 *  reachable interface. Loopback-only callers can still pass
 *  `--http-host 127.0.0.1` to opt out. Auth posture is unchanged —
 *  bearer token / Tailscale Serve TLS are the security layer; the
 *  bind interface only decides who can attempt a connection. */
const PWA_DEFAULT_HTTP_HOST = '0.0.0.0';
const LOOPBACK_HOST = '127.0.0.1';

/** Resolve the bind interface for nexus. Precedence:
 *    explicit `httpHost` > `loopback` shortcut > `0.0.0.0` default. */
function resolveHttpHost(opts: PwaStartOpts): string {
  if (opts.httpHost) return opts.httpHost;
  if (opts.loopback) return LOOPBACK_HOST;
  return PWA_DEFAULT_HTTP_HOST;
}

function collectForwardArgs(opts: PwaStartOpts, httpPort: number): string[] {
  const args = ['--tools', 'webterm'];
  if (opts.toolCwd) args.push('--tool-cwd', opts.toolCwd);
  if (opts.historyDir) args.push('--history-dir', opts.historyDir);
  args.push('--http-host', resolveHttpHost(opts));
  args.push('--http-port', String(httpPort));
  // Forward `--watch` so the daemon child knows to spawn an fs.watch
  // loop after boot. We don't forward `--no-auto-build` etc. because
  // those gates only matter on the parent (build runs before fork).
  if (opts.watch && (opts.mode ?? 'static') === 'static') args.push('--watch');
  if (opts.mcpEnabled === false) args.push('--no-mcp');
  return args;
}

/** Resolve both ports with the P3 fallback chain:
 *    CLI flag (opts.httpPort/opts.devPort) > UserConfig > hard default. */
function resolvePorts(opts: PwaStartOpts): { httpPort: number; devPort: number } {
  const readConfigPort = opts.readConfigPortFn ?? defaultReadConfigPort;
  const httpPort = opts.httpPort ?? readConfigPort('global.nexus.pwa.port') ?? 31415;
  const devPort = opts.devPort ?? readConfigPort('global.nexus.pwa.devPort') ?? 3210;
  return { httpPort, devPort };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultReadShareSwitch(): ShareTailnetValue {
  try {
    const v = readSwitchValue(readUserConfig(), 'global.nexus.pwa.shareTailnet');
    if (v === 'enabled' || v === 'disabled') return v;
  } catch { /* swallow — config not present yet, treat as 'ask' */ }
  return 'ask';
}

interface ShareTailResult {
  /** What we actually did. `'skipped'` reasons are user-meaningful so
   *  the banner can explain why share didn't come up. */
  outcome: 'serving' | 'skipped' | 'failed';
  reason?: 'switch-disabled' | 'switch-ask' | 'tailscale-missing' | 'tailscale-down' | 'serve-error';
  url?: string;
  serveExitCode?: number;
}

/** Bring `tailscale serve` up at the nexus port if the user opted in via
 *  the `global.nexus.pwa.shareTailnet=enabled` switch. Failures here are
 *  warnings — nexus stays up regardless, and the banner reports what
 *  happened so the user can fix and re-run `pwa share enable`.
 *
 *  P2 (2026-05-10) — `opts.https === true` force-enables for THIS run
 *  only, bypassing the switch. The switch state is untouched so the
 *  user's daily-driver disabled/ask config survives. switch=enabled
 *  + `--https` is redundant but a safe no-op (the same mount already
 *  happens via the switch path). */
async function bringShareUp(opts: PwaStartOpts, httpPort: number): Promise<ShareTailResult> {
  const readSwitch = opts.readShareSwitchFn ?? defaultReadShareSwitch;
  const switchValue = readSwitch();
  // --https flag overrides switch=disabled / 'ask' for this run only.
  // switch=enabled path is unchanged.
  const force = opts.https === true;
  if (!force && switchValue === 'disabled') return { outcome: 'skipped', reason: 'switch-disabled' };
  if (!force && switchValue === 'ask') return { outcome: 'skipped', reason: 'switch-ask' };

  const probeFn = opts.shareProbeFn ?? (() => probeTailscale());
  const probe = await probeFn();
  if (!probe.installed) return { outcome: 'skipped', reason: 'tailscale-missing' };
  if (!probe.alive) return { outcome: 'skipped', reason: 'tailscale-down' };

  const serveFn = opts.shareServeFn ?? defaultServe;
  const serve = await serveFn(probe.binary ?? 'tailscale', httpPort);
  if (serve.exitCode !== 0) {
    return { outcome: 'failed', reason: 'serve-error', serveExitCode: serve.exitCode };
  }
  const host = probe.magicDnsHost ?? probe.hostname ?? probe.ips?.[0];
  return {
    outcome: 'serving',
    ...(host ? { url: `https://${host}:${httpPort}/app/` } : {}),
    serveExitCode: 0,
  };
}

function logShareLine(out: NonNullable<PwaStartOpts['out']>, share: ShareTailResult): void {
  if (share.outcome === 'serving') {
    out.log(`  share        ON   ${share.url ?? '(tailnet host unknown)'}   (Tailscale Serve · auto-managed)`);
    return;
  }
  if (share.outcome === 'failed') {
    out.log(`  share        ERR  serve exit ${share.serveExitCode ?? '?'} — fix Tailscale, re-run \`elanous nexus pwa share enable\``);
    return;
  }
  switch (share.reason) {
    case 'switch-disabled':
      out.log('  share        OFF  local-only — `elanous nexus pwa share enable` to expose');
      break;
    case 'switch-ask':
      out.log('  share        ?    not yet decided — re-run `elanous nexus` (interactive) or `pwa share enable`');
      break;
    case 'tailscale-missing':
      out.log('  share        OFF  Tailscale not installed — https://tailscale.com/download');
      break;
    case 'tailscale-down':
      out.log('  share        OFF  Tailscale not active — start Tailscale, then `pwa share enable`');
      break;
    default:
      out.log('  share        OFF');
  }
}

async function probeUntilReady(
  url: string,
  opts: { fetchFn: typeof fetch; sleepFn: (ms: number) => Promise<void>; now: () => number; deadlineMs: number; pollMs: number },
): Promise<boolean> {
  const deadline = opts.now() + opts.deadlineMs;
  while (opts.now() < deadline) {
    try {
      const res = await opts.fetchFn(url);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await opts.sleepFn(opts.pollMs);
  }
  return false;
}

/** Auto-build helper — decide whether `apps/pwa/out` needs a refresh and
 *  run `runPwaBuild` if so. Returns the build exit code (0 = ok or
 *  skipped). HMR mode skips entirely since the dev server owns
 *  iteration. */
async function maybeAutoBuild(
  opts: PwaStartOpts,
  out: NonNullable<PwaStartOpts['out']>,
  mode: PwaStartMode,
): Promise<number> {
  const resolveFn = opts.resolvePwaCwdFn ?? (() => resolvePwaCwd(process.argv[1] ?? ''));
  const pwaCwd = resolveFn();
  if (!pwaCwd) {
    if (opts.rebuild) {
      out.error('  --rebuild: could not locate apps/pwa — skipping build.');
    }
    return 0;
  }
  let needBuild = opts.rebuild === true;
  const autoBuild = opts.autoBuild === true; // opt-in at the lib level; CLI flips default on
  if (!needBuild && mode === 'static' && autoBuild) {
    const stalenessFn = opts.stalenessFn ?? checkPwaStaleness;
    const verdict = stalenessFn(pwaCwd);
    if (verdict.stale) {
      needBuild = true;
      out.log(`  auto-build: PWA bundle stale (${verdict.reason}) — rebuilding before start...`);
    }
  } else if (needBuild) {
    out.log('  --rebuild: forcing fresh apps/pwa build before start...');
  }
  if (!needBuild) return 0;
  // Auto-install gate — runs only when we're about to build AND
  // `apps/pwa/node_modules` is incomplete. Catches the "fresh clone /
  // pulled lockfile change" path so users don't have to chase the
  // missing-deps diagnostic from runPwaBuild. CLI default on; lib-level
  // opt-in so existing pwa-start.test seams stay green.
  const autoInstall = opts.autoInstall === true;
  if (autoInstall) {
    const depsCheckFn = opts.depsCheckFn ?? ((cwd: string) => checkPwaBuildDeps(cwd));
    const deps = depsCheckFn(pwaCwd);
    if (!deps.ok) {
      const head = deps.missing.slice(0, 3).join(', ');
      const tail = deps.missing.length > 3 ? ` (+${deps.missing.length - 3} more)` : '';
      out.log(`  auto-install: apps/pwa deps missing (${head}${tail}) — running bun install...`);
      const installFn = opts.installFn ?? ((cwd: string) => runPwaInstall({ cwd, out }));
      const installRes = await installFn(pwaCwd);
      if (installRes.exitCode !== 0) {
        out.error(`✗ auto-install: bun install failed (exit ${installRes.exitCode}) — daemon not started.`);
        out.error(`  fix:  cd "${pwaCwd}" && bun install`);
        return installRes.exitCode;
      }
    }
  }
  const buildFn = opts.buildFn ?? ((cwd: string) => runPwaBuild({ cwd, out }));
  const r = await buildFn(pwaCwd);
  return r.exitCode;
}

/** Same-tree restart helper — when bg-launch reports a port collision,
 *  check the pwa-registry for an alive instance in our cwd (or our
 *  daemonDir) and stop it before retrying, unless a service manager
 *  supervises it. Returns `true` when a restart was attempted (caller
 *  should re-invoke bgLaunch once); `false` otherwise. */
async function maybeAutoRestart(
  opts: PwaStartOpts,
  out: NonNullable<PwaStartOpts['out']>,
): Promise<boolean> {
  // opt-in at the lib level; CLI flips default on
  if (opts.autoRestart !== true) return false;
  const listFn = opts.listInstancesFn ?? (() => listPwaInstances({ prune: false }));
  let instances: ReturnType<NonNullable<PwaStartOpts['listInstancesFn']>> = [];
  try {
    instances = listFn();
  } catch {
    return false;
  }
  const ourCwd = process.cwd();
  const ourDaemonDir = nexusRootDir();
  const sameTreeInstances = instances.filter((i) =>
    i.alive && (i.cwd === ourCwd || i.daemonDir === ourDaemonDir),
  );
  const supervised = sameTreeInstances.find((i) => i.launcherProvenance?.kind === 'service-manager');
  if (supervised?.launcherProvenance?.kind === 'service-manager') {
    const serviceName = supervised.launcherProvenance.serviceName;
    const supervisor = serviceName === 'systemd' ? 'systemd' : 'launchd';
    out.error(`이 데몬은 ${supervisor} 가 감독한다 — 멈추지 않았다. 재시작이 필요한지 먼저 \`elanous nexus restart-needed\` · 필요하면 운영자에게 알린 뒤 감독자로 재시작. 시험 데몬은 \`--test --port <격리 포트>\``);
    debug.log('nexus.auto-restart', 'refused-supervised', { serviceName, pid: supervised.pid });
    return false;
  }
  const sameTree = sameTreeInstances[0];
  if (!sameTree) return false;
  out.log('');
  out.log(`  auto-restart: same-tree daemon detected (cwd=${sameTree.cwd}) — stopping then retrying...`);
  const stopFn = opts.stopFn ?? runPwaStop;
  try {
    await stopFn({ out });
  } catch (err) {
    out.error(`  auto-restart: stop failed — ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  // Brief grace for the prior daemon's port release before retry.
  await new Promise((r) => setTimeout(r, 1500));
  return true;
}

/** Preflight clean-up — a previous daemon that crashed (SIGKILL / OOM /
 *  shell hangup) can leave a Tailscale Serve mount listening on our
 *  port with no upstream behind it. The next `nexus run` then either
 *  fails to bind 0.0.0.0:port (Tailscale already owns 100.x:port) or
 *  binds successfully but the tailnet URL hits a zombie forward. We
 *  catch both shapes by probing /v1/health first; if nothing answers,
 *  we proactively call `tailscale serve … off` so bg-launch starts
 *  from a clean port state. Failure paths (sudo missing / no mount)
 *  are non-fatal — bg-launch still tries, and the listen-verification
 *  hook below surfaces the actual diagnosis. */
async function preflightCleanStaleServe(
  opts: PwaStartOpts,
  out: NonNullable<PwaStartOpts['out']>,
  httpPort: number,
): Promise<void> {
  if (opts.preflightStaleServe !== true) return; // lib-level opt-in; CLI flips on
  const fetchFn = opts.fetchFn ?? fetch;
  const probeFn = opts.healthProbeFn ?? (async (port: number) => {
    try {
      const res = await fetchFn(`http://127.0.0.1:${port}/v1/health`, {
        signal: AbortSignal.timeout(800),
      });
      return res.ok;
    } catch { return false; }
  });
  const healthy = await probeFn(httpPort);
  if (healthy) return; // something legitimate already listens; auto-restart handles it
  const unmountFn = opts.unmountServeFn ?? ((port: number) =>
    unmountTailscaleServe({
      mode: { kind: 'tls-tcp', port },
      upstreamPort: port,
      useSudo: true,
    }));
  const r = await unmountFn(httpPort);
  if (r.ok) {
    out.log(`  preflight: stale Tailscale serve binding on :${httpPort} cleared (was zombie · sudo cached or no mount).`);
    return;
  }
  if (r.reason === 'no-state') return; // nothing to do — likely a fresh boot
  if (r.reason === 'sudo-required') {
    out.error(`  preflight: stale Tailscale serve on :${httpPort} blocks bind; sudo required to unmount.`);
    out.error('    fix: `sudo tailscale serve reset` then re-run. (Tailscale 1.96+ drops per-flag off.)');
    return;
  }
  // serve-cmd-failed / tailscale-missing — non-fatal log so users
  // know why a later listen failure happened.
  out.error(`  preflight: stale serve cleanup attempt returned ${r.reason ?? 'unknown'} — bg-launch will still try.`);
}

/** Listen verification — confirms bg-launch's child actually bound the
 *  port. Without this hook a daemon that fork-detached but failed to
 *  call `httpServer.listen()` looks fine to bg-launch (which only sees
 *  the spawn succeed) and the user discovers it minutes later when the
 *  PWA URL refuses to load.
 *
 *  Deadline budget: 30s. The lower 8s we shipped first (PR #2521) was
 *  fine for a vanilla daemon but tripped false negatives when one or
 *  more MCP servers in `~/.elanous/config.json` hit the 8s handshake
 *  guard (PR #2527) — each per-server timeout pushed
 *  `startNexusHttpServer` further back. A real listen failure still
 *  shows up before 30s; healthy daemons return on the first probe
 *  within ~200ms, so the new ceiling only matters when something
 *  upstream is already misbehaving. */
async function verifyNexusListening(
  opts: PwaStartOpts,
  out: NonNullable<PwaStartOpts['out']>,
  httpPort: number,
): Promise<boolean> {
  if (opts.verifyListen !== true) return true; // lib-level opt-in; CLI flips on
  const fetchFn = opts.fetchFn ?? fetch;
  const sleepFn = opts.sleepFn ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const ok = await probeUntilReady(`http://127.0.0.1:${httpPort}/v1/health`, {
    fetchFn, sleepFn, now,
    deadlineMs: 30_000,
    pollMs: 250,
  });
  if (!ok) {
    out.error('');
    out.error(`  ✗ nexus did not respond on http://127.0.0.1:${httpPort}/v1/health within 30s.`);
    out.error('     Likely causes:');
    out.error(`       1. stale Tailscale serve binding ${httpPort}: \`sudo tailscale serve reset\` then re-run`);
    out.error('       2. MCP-client boot deadlock past the 30s ceiling: check `~/.elanous/config.json` mcp.servers');
    out.error('       3. daemon log for a non-MCP init that hangs:');
    out.error('             tail -f ~/.elanous/nexus/logs/$(ls -t ~/.elanous/nexus/logs | head -1)');
  }
  return ok;
}

export async function runPwaStart(opts: PwaStartOpts = {}): Promise<PwaStartResult> {
  const out = opts.out ?? console;
  const mode: PwaStartMode = opts.mode ?? 'static';
  const bgLaunchFn = opts.bgLaunchFn ?? runBgLaunch;
  const ports = resolvePorts(opts);
  let registryKind: PwaRegistryEntry['kind'] = 'production';
  try {
    if ((opts.resolveCurrentInstanceFn ?? resolveCurrentInstance)().kind === 'test') {
      registryKind = 'test';
    }
  } catch { /* instance resolution is best-effort — registry writes still proceed */ }

  let httpPort = ports.httpPort;
  const devPort = ports.devPort;
  let leased = false;
  if (registryKind === 'test' && opts.httpPort === undefined) {
    const claim = await leaseTestPort({ owner: process.cwd(), ...(opts.leaseDir ? { dir: opts.leaseDir } : {}) });
    if ('error' in claim) {
      out.error('시험 대역에 빈 포트가 없습니다 (31450..31499).');
      return { exitCode: 1 };
    }
    httpPort = claim.port;
    leased = true;
    out.log(`시험 대역에서 :${httpPort} 임대`);
  }
  const dropLauncherLease = () => {
    if (leased) releaseTestPort(httpPort, process.pid, opts.leaseDir);
  };
  // A · staleness / forced rebuild — runs once before the daemon spawns
  //   so the very first request after start serves the new bundle.
  let buildExit: number;
  try {
    buildExit = await maybeAutoBuild(opts, out, mode);
  } catch (err) {
    dropLauncherLease();
    throw err;
  }
  if (buildExit !== 0) {
    dropLauncherLease();
    return { exitCode: buildExit };
  }
  // Preflight — proactively unmount a stale Tailscale serve binding so
  // the bind below doesn't lose interface ownership to a zombie.
  try {
    await preflightCleanStaleServe(opts, out, httpPort);
  } catch (err) {
    dropLauncherLease();
    throw err;
  }

  let bg: BgLaunchResult;
  try {
    bg = await bgLaunchFn({
      ...(opts.force ? { force: true } : {}),
      forwardArgs: collectForwardArgs(opts, httpPort),
      ...(opts.coordinatorLeasePort !== undefined ? { childEnv: { ELANOUS_TEST_COORDINATOR_LEASE_PORT: String(opts.coordinatorLeasePort), ...(opts.coordinatorLeaseToken ? { ELANOUS_TEST_COORDINATOR_LEASE_TOKEN: opts.coordinatorLeaseToken } : {}), ...(opts.coordinatorLeaseId ? { ELANOUS_TEST_COORDINATOR_LEASE_ID: opts.coordinatorLeaseId } : {}) } } : {}),
      out,
    });
  } catch (err) {
    dropLauncherLease();
    throw err;
  }

  // B · same-tree auto-restart — when bg-launch trips the existing-lock
  //   path AND the live holder lives in our cwd/daemonDir, maybeAutoRestart
  //   refuses supervised holders; only unsupervised holders are stopped and
  //   retried once. Cross-tree collisions still hit the 4-option hint
  //   below so a user with multiple trees can't accidentally kill the
  //   other one's daemon.
  if (bg.exitCode !== 0) {
    const shouldRetry = await maybeAutoRestart(opts, out);
    if (shouldRetry) {
      try {
        bg = await bgLaunchFn({
          ...(opts.force ? { force: true } : {}),
          forwardArgs: collectForwardArgs(opts, httpPort),
          ...(opts.coordinatorLeasePort !== undefined ? { childEnv: { ELANOUS_TEST_COORDINATOR_LEASE_PORT: String(opts.coordinatorLeasePort), ...(opts.coordinatorLeaseToken ? { ELANOUS_TEST_COORDINATOR_LEASE_TOKEN: opts.coordinatorLeaseToken } : {}), ...(opts.coordinatorLeaseId ? { ELANOUS_TEST_COORDINATOR_LEASE_ID: opts.coordinatorLeaseId } : {}) } } : {}),
          out,
        });
      } catch (err) {
        dropLauncherLease();
        throw err;
      }
    }
  }
  if (bg.exitCode !== 0) {
    dropLauncherLease();
    // P3 collision hint — bgLaunch typically exits non-zero when an
    // existing lock holder occupies our port. The user-facing diagnostic
    // for a clean recovery path: take over (`--force`), pick another
    // port (`--http-port <n>`), or stop the existing daemon. Don't
    // narrow to a specific exit code so the hint always shows whenever
    // the supervisor refuses — most reasons share the same fix surface.
    out.error('');
    out.error(`  hint: nexus failed to claim port :${httpPort}.`);
    out.error('         · take over: rerun with `--force`');
    out.error(`         · alt port: rerun with \`--http-port <n>\` (e.g. ${httpPort + 1})`);
    out.error('         · or stop the existing daemon: `elanous nexus pwa stop`');
    out.error('         · permanent: `elanous config set global.nexus.pwa.port <n>`');
    return { exitCode: bg.exitCode };
  }
  if (leased) {
    if (typeof bg.pid === 'number' && isPidAlive(bg.pid)) {
      transferTestPort(httpPort, process.pid, bg.pid, opts.leaseDir);
    } else {
      // A launcher reporting success without a live daemon must not retain a claim.
      dropLauncherLease();
    }
  }
  if (mode !== 'hmr') {
    // Static mode: nexus is up, no dev BG. Verify the daemon actually
    // bound the port (catches the stale-serve / EADDRINUSE / partial
    // boot case before we mount Tailscale serve onto a dead upstream),
    // then bring share up if the user opted in.
    const ready = await verifyNexusListening(opts, out, httpPort);
    if (!ready) return { exitCode: 1 };
    const share = await bringShareUp(opts, httpPort);
    out.log('');
    logShareLine(out, share);
    // P4 — register this instance so `pwa global status / clean` can
    // see it across folders / projects. pid comes from bg-launch; if
    // the supervisor didn't surface it (test seam) we skip silently.
    if (typeof bg.pid === 'number') {
      const registerFn = opts.registerInstanceFn ?? registerPwaInstance;
      try {
        registerFn({
          pid: bg.pid,
          ports: [httpPort],
          mode: 'static',
          kind: registryKind,
          cwd: process.cwd(),
          daemonDir: nexusRootDir(),
          shareMounted: share.outcome === 'serving',
          https: opts.https === true,
          startedAt: new Date().toISOString(),
        });
      } catch { /* registry write best-effort — never block start */ }
    }
    return { exitCode: 0 };
  }

  // HMR mode tail — wait for nexus → spawn dev BG → admin POST.
  const fetchFn = opts.fetchFn ?? fetch;
  const sleepFn = opts.sleepFn ?? defaultSleep;
  const now = opts.now ?? Date.now;
  // Probe loopback regardless of the bind interface. nexus listens on
  // 0.0.0.0 (or explicit --http-host) but loopback always reaches the
  // same socket on the same host, so this stays correct + cheap even
  // in container environments.
  const nexusBase = `http://127.0.0.1:${httpPort}`;

  out.log('');
  out.log('elanous nexus pwa start --hmr: bringing up HMR iteration loop...');

  const nexusReady = await probeUntilReady(`${nexusBase}/v1/health`, {
    fetchFn, sleepFn, now,
    deadlineMs: 10_000,
    pollMs: 100,
  });
  if (!nexusReady) {
    out.error(`✗ nexus boot did not respond on ${nexusBase}/v1/health within 10s.`);
    out.error('  Check the log path printed above; PWA dev server NOT started.');
    return { exitCode: 1 };
  }
  out.log(`  ✓ nexus health OK  (${nexusBase}/v1/health)`);

  const devLaunchFn = opts.devLaunchFn ?? runPwaDevBgLaunch;
  // `--loopback` makes next-dev follow nexus to 127.0.0.1 so neither
  // surface listens on every interface. Without it, dev defaults to
  // 0.0.0.0 (matching nexus's default). Explicit nexus `--http-host`
  // does NOT auto-set the dev host — those are independent toggles
  // and a user pinning nexus to a specific NIC may still want dev
  // exposed on every interface.
  const devHost = opts.loopback ? LOOPBACK_HOST : undefined;
  const dev = await devLaunchFn({ port: devPort, ...(devHost ? { host: devHost } : {}), out });
  if (dev.exitCode !== 0) {
    out.error('✗ pwa dev BG launch failed — see error above. Nexus is still up.');
    return { exitCode: dev.exitCode };
  }

  // PWA only mounts `/app/*` (root returns 404 → next-dev's `/_not-found`).
  // Probing `/` would treat the live server as not-ready until the deadline,
  // even though next-dev was ready in <1s. `/app/` is the route the user
  // actually visits and the same path nexus reverse-proxies on success.
  const devProbeUrl = `http://localhost:${devPort}/app/`;
  const devReady = await probeUntilReady(devProbeUrl, {
    fetchFn, sleepFn, now,
    deadlineMs: 30_000,
    pollMs: 200,
  });
  if (!devReady) {
    out.error(`✗ Next.js dev server did not respond on ${devProbeUrl} within 30s.`);
    out.error('  Stopping dev BG; check the dev log path above.');
    const devStopFn = opts.devStopFn ?? runPwaDevStop;
    try { await devStopFn(); } catch { /* best-effort cleanup */ }
    return { exitCode: 1 };
  }
  out.log(`  ✓ next-dev ready   (${devProbeUrl})`);

  try {
    const res = await fetchFn(`${nexusBase}/v1/nexus/admin/pwa-dev-proxy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upstream: `http://localhost:${devPort}` }),
    });
    if (!res.ok) {
      out.error(`✗ admin POST returned ${res.status} — single-origin disabled.`);
      out.error('  Dev server is still running cross-origin at http://localhost:' + devPort + '/app/');
      return { exitCode: 1 };
    }
  } catch (err) {
    out.error(`✗ admin POST failed — ${err instanceof Error ? err.message : String(err)}`);
    return { exitCode: 1 };
  }
  out.log(`  ✓ dev-proxy ON     (${nexusBase}/v1/nexus/admin/pwa-dev-proxy live)`);
  out.log('');
  const httpHostShown = resolveHttpHost(opts);
  out.log('HMR iteration loop ready.');
  out.log(`  loopback URL ${nexusBase}/app/   (this host · single-origin · HMR · cookies + SW)`);
  if (httpHostShown === '0.0.0.0') {
    out.log(`  reachable on every interface (LAN / Tailscale / container) — bind=${httpHostShown}:${httpPort}`);
  } else if (opts.loopback && !opts.httpHost) {
    out.log(`  loopback-only — bind=${httpHostShown}:${httpPort} (--loopback · LAN / Tailscale not reachable)`);
  } else {
    out.log(`  bind=${httpHostShown}:${httpPort}  (--http-host explicit · loopback-only if 127.x)`);
  }
  out.log(`  dev origin   http://localhost:${devPort}/app/   (also live · cross-origin)`);
  const share = await bringShareUp(opts, httpPort);
  logShareLine(out, share);
  out.log('  stop both    elanous nexus pwa stop');

  // P4 — register HMR instance with both ports (nexus + Next dev) so
  // `pwa global clean` can reap both. See static-mode register above.
  if (typeof bg.pid === 'number') {
    const registerFn = opts.registerInstanceFn ?? registerPwaInstance;
    try {
      registerFn({
        pid: bg.pid,
        ports: [httpPort, devPort],
        mode: 'hmr',
        kind: registryKind,
        cwd: process.cwd(),
        daemonDir: nexusRootDir(),
        shareMounted: share.outcome === 'serving',
        https: opts.https === true,
        startedAt: new Date().toISOString(),
      });
    } catch { /* registry write best-effort */ }
  }

  return { exitCode: 0 };
}
