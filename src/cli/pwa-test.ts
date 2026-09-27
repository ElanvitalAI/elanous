// `elanous nexus run --test` — single-command project-local test mode.
//
// One command does all of that with project-local impact only:
//
//     elanous nexus run --test            # static · HTTP · 1 port (NEXUS)
//     elanous nexus run --test --hmr      # HMR · HTTP · 2 ports (NEXUS + Next dev)
//     elanous nexus run --test --https    # static · HTTPS via Tailscale Serve
//     elanous nexus run --test --hmr --https
//     elanous nexus run --test --status
//     elanous nexus run --test --stop
//
// **2026-05-13 · config-dir-unify**: `--test` redirects ONLY the
// nexus state subtree (lock · runtime.json · logs · tabs) to
// `<repoRoot>/.elanous-test/nexus/`. The config dir (config.json ·
// secrets.json · workflows · tasks) stays at the global root so the
// user's daily-driver provider / personas / scheduler all keep
// working in test mode. To use a different config dir as well, pass
// `--config-dir <path>` (works for both daily and `--test` modes).
//
// Project-local guarantees:
//   - State dir = `<repoRoot>/.elanous-test/nexus/` (gitignored). User's
//     production daemon at `~/.elanous/nexus/` is never touched.
//   - Tailscale Serve mounts only the test port we explicitly opened
//     and remembered in `<repoRoot>/.elanous-test/tailscale-test-port.json`.
//     We never touch the user's other Serve config (e.g. their
//     personal :443 forwards).
//
// Auto port collision recovery:
//   - NEXUS port: coordinator lease in 31450–31499; if the coordinator is
//     absent or answers with any error, fall back to the machine-local
//     test-band lease (`leaseTestPort`, 31450–31499). Never pick
//     production-reserved ports (31413 · 31415 · 31420).
//   - Next dev port (HMR mode only): prefer 3210 → 3211 → 3212+.
//     Skip if any process binds the port.
//   - Stale `<repo>/.elanous-test/.lock` is an idempotent reuse — the
//     command refuses with a clear hint unless `--force` is passed.

import { leaseTestPort } from './port-lease-local.js';
import { debug } from '../debug/log.js';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join as joinPath, resolve as resolvePath } from 'node:path';

import { setTestStateRoot } from '../nexus/paths.js';
import { PORT_BANDS } from '../control-plane/ports.js';
import { PORT_LEASE_TTL_MS } from '../control-plane/port-lease-heartbeat.js';
import { resolvePrimary, type PrimaryAddress, type PrimaryConfig } from '../control-plane/primary.js';
import { runPwaStart, type PwaStartMode, type PwaStartOpts, type PwaStartResult } from './pwa-start.js';
import { runPwaStop, type PwaStopOpts, type PwaStopResult } from './pwa-stop.js';
import { isAliveNexusLock, type NexusLockMeta } from '../nexus/supervisor/lock.js';
import {
  mountTailscaleServe,
  unmountTailscaleServe,
  readMountedState,
  type MountTailscaleServeResult,
  type TailscaleServeOpts,
  type UnmountTailscaleServeResult,
} from './tailscale-serve.js';

export interface PwaTestOpts {
  /** Override `process.argv[1]` (default = `process.argv[1]`). Used to
   *  resolve the repo root for project-local state. */
  argvBin?: string;
  /** Force a specific NEXUS port (skips auto-pick). When provided +
   *  occupied, the command errors instead of probing the next port. */
  port?: number;
  /** HMR mode (default = static). Static is the calm default —
   *  matches `pwa start` precedent. HMR adds Next.js dev server with
   *  auto-port-pick on collision. */
  hmr?: boolean;
  /** Mount Tailscale Serve TLS-terminated-tcp on the picked NEXUS
   *  port. iPad/external device gets `https://<magic-dns>:<port>/...`
   *  for `getUserMedia` (camera/mic) which only works in secure
   *  context. Sudo required (cached creds work). */
  https?: boolean;
  /** Alias for `https` — semantic name surfaced to dogfood callers
   *  who think in feature terms (voice/camera) rather than transport. */
  voice?: boolean;
  /** `--status` mode: print whatever a prior `pwa test` left behind
   *  (lock + tailscale state). No daemon spawn. */
  status?: boolean;
  /** `--stop` mode: cascade stop test daemon + dev BG + Tailscale
   *  Serve unmount. Idempotent — safe to run when nothing is up. */
  stop?: boolean;
  /** Take over a stale or live test instance. Maps to `pwa start
   *  --force` for the daemon spawn. */
  force?: boolean;
  /** Explicit working directory for tools in the detached test daemon. */
  toolCwd?: string;
  /** Build `apps/pwa/out` before starting (only relevant in static
   *  mode). Equivalent to `elanous nexus pwa restart --rebuild`. */
  rebuild?: boolean;
  /** Opt-in: run an fs.watch loop inside the test daemon so source
   *  edits during a test session auto-rebuild. Default off — test mode
   *  is disposable (one-shot PR verification), so the noise of a long-
   *  running watcher is opt-in. Mirrors `elanous nexus run --watch`. */
  watch?: boolean;
  /** Opt-in: static-mode staleness check before start. When true and
   *  `apps/pwa/out` is older than source, run a one-shot build. Default
   *  off for test mode — sibling `--rebuild` covers the explicit case
   *  and isolated test daemons usually run on a known-fresh tree. */
  autoBuild?: boolean;
  /** Opt-in: when `apps/pwa/node_modules` is missing, run `bun install`
   *  in apps/pwa before attempting a build. Default off for test mode
   *  — sibling to the canonical `nexus run` flag of the same name. */
  autoInstall?: boolean;
  /** Opt-in: same-tree auto-restart on port collision. Default off for
   *  test mode (collisions auto-fallback to the next port instead).
   *  Surfaced for parity with `elanous nexus run`. */
  autoRestart?: boolean;
  /** FU8 PR #5 (2026-05-12) — fresh-on-start prune of
   *  `<stateDir>/workflows/` (and `<stateDir>/tasks/` + `<stateDir>/
   *  backups/`) so test runs never inherit prior-run artifacts (e.g.
   *  `greet-*` workflows accumulating across dogfood sessions).
   *  Preserves daemon state (lock · runtime.json · logs · IPC dir).
   *  Default = false (opt-in) so existing test routines keep their
   *  in-progress workflows.
   */
  fresh?: boolean;

  /** Output sink (default = console). */
  out?: { log: (s: string) => void; error: (s: string) => void };

  // ─── Test seams ─────────────────────────────────────────────
  /** Override the repo root resolution from `argvBin`. */
  repoRoot?: string;
  /** Replace the lock liveness check used for stale project locks. */
  productionLockAliveFn?: (meta: NexusLockMeta) => boolean;
  /** Replace the port collision probe. Defaults to a local bind probe. */
  portInUseFn?: (port: number) => boolean | Promise<boolean>;
  /** Explicit primary address and scoped write token for coordinator leases. */
  coordinatorPrimary?: PrimaryConfig;
  /** Coordinator request seam; null means coordinator unavailable. A lease must carry its id. */
  leasePortFn?: (excluded?: readonly number[]) => Promise<CoordinatorPortLease | null>;
  /** Release a failed central claim before retrying. */
  releasePortFn?: (port: number) => Promise<void>;
  /** Test seam — lease directory for the local test-band port lease (default: OS tmp). */
  leaseDir?: string;
  /** Replace the runPwaStart dependency (the underlying daemon + dev
   *  bring-up · we compose this rather than reimplement). */
  pwaStartFn?: (opts: PwaStartOpts) => Promise<PwaStartResult>;
  /** Replace the runPwaStop dependency. */
  pwaStopFn?: (opts: PwaStopOpts) => Promise<PwaStopResult>;
  /** Replace the Tailscale Serve mount/unmount helpers. Test seam onto
   *  the unified `mountTailscaleServe` / `unmountTailscaleServe`.
   *  `pwa test --https` always uses `tls-tcp` mode + `upstreamPort==port`,
   *  so the seam takes `port` separately and the orchestrator fills in
   *  `mode` + `upstreamPort` before delegating. */
  tailscaleMountFn?: (
    port: number,
    opts: Omit<TailscaleServeOpts, 'upstreamPort'>,
  ) => Promise<MountTailscaleServeResult>;
  tailscaleUnmountFn?: (
    opts: Omit<TailscaleServeOpts, 'upstreamPort'>,
  ) => Promise<UnmountTailscaleServeResult>;
  /** Skip running `pwa build` automatically when static mode finds the
   *  out dir missing. Tests bypass the spawn. */
  rebuildFn?: (cwd: string) => Promise<{ exitCode: number }>;
}

export interface PwaTestResult {
  exitCode: number;
  /** When start succeeded, the URL to surface in the iPad guide. */
  url?: string;
  /** Picked ports for diagnostics + status. */
  picked?: {
    nexusPort: number;
    devPort?: number;
  };
  /** Set when `--https` mode mounted Tailscale Serve. */
  tailscaleMounted?: boolean;
}

const DEFAULT_DEV_PORT = 3210;
const DEV_FALLBACK_RANGE = [3211, 3212, 3213, 3214, 3215];

interface RepoLayout {
  repoRoot: string;
  stateDir: string;
  lockPath: string;
  runtimePath: string;
  tailscaleStatePath: string;
  pwaOutDir: string;
  pwaCwd: string;
}

/** Resolve `<repoRoot>` from `argvBin` (process.argv[1]). The bin
 *  symlink lives at `<repo>/bin/elanous.mjs`, so the parent of `bin/` is
 *  the repo. Bun-linked global `elanous` follows the symlink target so
 *  this still resolves to the linked checkout. */
function resolveRepoRoot(argvBin: string | undefined): string | undefined {
  if (!argvBin) return undefined;
  const candidate = resolvePath(dirname(argvBin), '..');
  // Sanity-check by looking for `apps/pwa` + `bin/elanous.mjs` siblings.
  if (!existsSync(joinPath(candidate, 'bin', 'elanous.mjs'))) return undefined;
  if (!existsSync(joinPath(candidate, 'apps', 'pwa'))) return undefined;
  return candidate;
}

function resolveLayout(opts: PwaTestOpts): RepoLayout | null {
  const argvBin = opts.argvBin ?? process.argv[1] ?? '';
  const repoRoot = opts.repoRoot ?? resolveRepoRoot(argvBin);
  if (!repoRoot) return null;
  const stateDir = joinPath(repoRoot, '.elanous-test');
  return {
    repoRoot,
    stateDir,
    lockPath: joinPath(stateDir, '.lock'),
    runtimePath: joinPath(stateDir, 'runtime.json'),
    tailscaleStatePath: joinPath(stateDir, 'tailscale-test-port.json'),
    pwaOutDir: joinPath(repoRoot, 'apps', 'pwa', 'out'),
    pwaCwd: joinPath(repoRoot, 'apps', 'pwa'),
  };
}

async function defaultPortInUse(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', () => resolve(true));
    server.listen(port, '0.0.0.0', () => server.close(() => resolve(false)));
  });
}

function readProjectLock(lockPath: string): NexusLockMeta | null {
  if (!existsSync(lockPath)) return null;
  try {
    const raw = readFileSync(lockPath, 'utf8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as NexusLockMeta;
    if (typeof parsed.pid !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function coordinatorPortRequest(path: string, method: string, body?: unknown, primary?: PrimaryAddress): Promise<Response | null> {
  primary ??= await resolvePrimary({ role: 'member' });
  if (!primary.token) return null;
  try {
    return await fetch(`${primary.url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${primary.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(1000),
    });
  } catch { return null; }
}

export type CoordinatorPortLease = { port: number; leaseId: string };

export async function requestCoordinatorPort(
  excluded: readonly number[] = [],
  send: typeof coordinatorPortRequest = coordinatorPortRequest,
): Promise<CoordinatorPortLease | null> {
  return requestCoordinatorPortForPrimary(excluded, await resolvePrimary({ role: 'member' }), send);
}

async function requestCoordinatorPortForPrimary(
  excluded: readonly number[], primary: PrimaryAddress, send: typeof coordinatorPortRequest = coordinatorPortRequest,
): Promise<CoordinatorPortLease | null> {
  const response = await send('/v1/leases/port', 'POST', {
    machine: primary.machine ?? (process.env.HOSTNAME || 'local'), purpose: 'nexus-test', ttlMs: PORT_LEASE_TTL_MS, excluded,
  }, primary);
  if (!response) return null;
  if (response.status === 409) {
    const body: unknown = await response.json();
    if ((body as { error?: unknown })?.error === 'no-port') return null;
  }
  if (!response.ok) throw new Error(`coordinator port lease HTTP ${response.status}`);
  const body: unknown = await response.json();
  const port = (body as { port?: unknown })?.port;
  const leaseId = (body as { lease?: { attrs?: { leaseId?: unknown } } })?.lease?.attrs?.leaseId;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < PORT_BANDS.test.start || port > PORT_BANDS.test.end ||
      typeof leaseId !== 'string' || !leaseId) {
    throw new Error('invalid coordinator port lease');
  }
  return { port, leaseId };
}

async function releaseCoordinatorPort(lease: CoordinatorPortLease, primary?: PrimaryAddress): Promise<void> {
  primary ??= await resolvePrimary({ role: 'member' });
  if (!primary.token) return;
  const response = await fetch(`${primary.url}/v1/leases/port/${lease.port}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${primary.token}`, 'x-port-lease-id': lease.leaseId },
    signal: AbortSignal.timeout(1000),
  }).catch(() => null);
  if (!response?.ok && response?.status !== 404 && response?.status !== 403) throw new Error(`coordinator port release ${response ? `HTTP ${response.status}` : 'unavailable'}`);
}

async function pickNexusPort(
  preferred: number | undefined,
  layout: RepoLayout,
  opts: PwaTestOpts,
): Promise<{ port: number; reason: string; leaseId?: string; primary?: PrimaryAddress } | { error: string }> {
  const inUseFn = opts.portInUseFn ?? defaultPortInUse;
  // ⓐ 명시 `--port` 가 이긴다(불변).
  if (preferred !== undefined) {
    if (await inUseFn(preferred)) return { error: `port ${preferred} already in use` };
    return { port: preferred, reason: 'explicit --port' };
  }
  // ⓑ 관제부 임대 — 없거나(null) «어떤 오류든»(409 no-port · 503 · 네트워크 · 잘못된 응답) ⓒ 로 넘어간다.
  const central = await pickCoordinatorPort(opts, inUseFn);
  if (central) return central;
  // ⓒ 기계 안 로컬 임대(#20864) — 시험 대역(31450~31499)에서만 준다. 운영 대역(31413·31415·31420)은 절대 안 고른다.
  const claim = await leaseTestPort({
    owner: layout.repoRoot,
    ...(opts.leaseDir ? { dir: opts.leaseDir } : {}),
    ...(opts.portInUseFn ? { inUse: opts.portInUseFn } : {}),
  });
  if ('error' in claim) return { error: '시험 대역에 빈 포트가 없습니다 (31450..31499)' };
  return { port: claim.port, reason: `시험 대역에서 :${claim.port} 임대` };
}

async function releaseCentral(opts: PwaTestOpts, lease: CoordinatorPortLease, primary?: PrimaryAddress): Promise<void> {
  if (opts.releasePortFn) await opts.releasePortFn(lease.port);
  else await releaseCoordinatorPort(lease, primary);
}

/** 관제부에서 시험 대역 포트를 받는다. 받지 못하면(관제부 부재·오류·잘못된 응답·대역 소진) null — 호출자가 로컬 임대로 넘어간다. */
async function pickCoordinatorPort(
  opts: PwaTestOpts,
  inUseFn: (port: number) => boolean | Promise<boolean>,
): Promise<{ port: number; reason: string; leaseId: string; primary?: PrimaryAddress } | null> {
  const primary = opts.leasePortFn ? undefined : await resolvePrimary({ role: 'member', config: opts.coordinatorPrimary });
  const request = opts.leasePortFn ?? ((excluded: readonly number[]) => requestCoordinatorPortForPrimary(excluded, primary!));
  const excluded: number[] = [];
  for (let attempt = PORT_BANDS.test.start; attempt <= PORT_BANDS.test.end; attempt++) {
    let claimed: CoordinatorPortLease | null;
    try { claimed = await request(excluded); }
    catch (err) {
      debug.log('nexus.port-lease', 'coordinator-fallback', { reason: 'coordinator-error', error: err instanceof Error ? err.message : String(err) });
      return null;
    }
    if (claimed === null) {
      debug.log('nexus.port-lease', 'coordinator-fallback', { reason: 'coordinator-unavailable-or-no-port' });
      return null;
    }
    const { port, leaseId } = claimed;
    if (!Number.isInteger(port) || port < PORT_BANDS.test.start || port > PORT_BANDS.test.end
        || (PORT_BANDS.reserved as readonly number[]).includes(port) || excluded.includes(port)
        || typeof leaseId !== 'string' || !leaseId) {
      debug.log('nexus.port-lease', 'coordinator-fallback', { reason: 'invalid-lease', port });
      return null;
    }
    let occupied: boolean;
    try { occupied = await inUseFn(port); }
    catch (err) {
      await releaseCentral(opts, claimed, primary);
      throw err;
    }
    if (!occupied) return { port, reason: 'coordinator lease', leaseId, ...(primary ? { primary } : {}) };
    await releaseCentral(opts, claimed, primary);
    excluded.push(port);
  }
  debug.log('nexus.port-lease', 'coordinator-fallback', { reason: 'coordinator-band-exhausted' });
  return null;
}

async function pickDevPort(opts: PwaTestOpts): Promise<number | { error: string }> {
  const inUseFn = opts.portInUseFn ?? defaultPortInUse;
  const candidates = [DEFAULT_DEV_PORT, ...DEV_FALLBACK_RANGE];
  for (const port of candidates) {
    if (!await inUseFn(port)) return port;
  }
  return { error: `no free Next dev port in [${candidates.join(', ')}]` };
}

function ensureStateDir(layout: RepoLayout): void {
  mkdirSync(layout.stateDir, { recursive: true });
}

function clearStaleLock(layout: RepoLayout, opts: PwaTestOpts): void {
  // The bg-launch path also clears stale locks itself, but doing it
  // here makes the diagnostic banner accurate (lock hint suppression).
  const lock = readProjectLock(layout.lockPath);
  if (!lock) return;
  const aliveFn = opts.productionLockAliveFn ?? isAliveNexusLock;
  if (!aliveFn(lock)) {
    try { rmSync(layout.lockPath, { force: true }); } catch { /* swallow */ }
  }
}

function urlForLanHttp(port: number): string[] {
  // We can't reliably enumerate the user's LAN IP without a /sbin call
  // that varies across macOS / linux. Surface localhost + 0.0.0.0
  // hint; the caller can run `ipconfig getifaddr en0` if they need the
  // actual LAN IP.
  return [
    `http://localhost:${port}/app/showroom/`,
    `http://<Mac LAN IP>:${port}/app/showroom/`,
    `http://<Tailscale IP · 100.x>:${port}/app/showroom/`,
  ];
}

function defaultRebuild(cwd: string): Promise<{ exitCode: number }> {
  return new Promise(async (resolve) => {
    try {
      const { runPwaBuild } = await import('./pwa-build.js');
      const res = await runPwaBuild({ cwd });
      resolve({ exitCode: res.exitCode });
    } catch {
      resolve({ exitCode: 1 });
    }
  });
}

/** FU8 PR #5 (2026-05-12) — paths that get nuked by `--fresh` on
 *  every test start. **Excluded**: anything daemon-lifecycle (lock ·
 *  runtime.json · logs · `tabs/` IPC dir) and the orchestrator's own
 *  config files. Adding new transient dirs here is the cheapest way
 *  to keep `pwa test --fresh` honest. */
const FRESH_PRUNE_RELATIVE_PATHS: readonly string[] = [
  'workflows',  // accreting `greet-*` artifacts in the HANDOFF observation
  'tasks',      // TOX SQLite + per-mission goal-* dirs from this test session
  'backups',    // any backup invocation triggered during a test run
];

function pruneStaleArtifacts(
  layout: RepoLayout,
  out: NonNullable<PwaTestOpts['out']>,
): { pruned: string[] } {
  const pruned: string[] = [];
  for (const rel of FRESH_PRUNE_RELATIVE_PATHS) {
    const target = joinPath(layout.stateDir, rel);
    if (existsSync(target)) {
      try {
        rmSync(target, { recursive: true, force: true });
        pruned.push(rel);
      } catch (err) {
        out.error(`  ! could not prune ${rel}/: ${(err as Error).message}`);
      }
    }
  }
  return { pruned };
}

async function runStart(
  layout: RepoLayout,
  opts: PwaTestOpts,
  out: NonNullable<PwaTestOpts['out']>,
): Promise<PwaTestResult> {
  ensureStateDir(layout);
  clearStaleLock(layout, opts);

  // FU8 PR #5 (2026-05-12) — `--fresh` opt-in prune. Runs before the
  // daemon spawn so the spawned NEXUS sees an empty workflows /
  // tasks tree. Daemon state files (lock · runtime.json · logs · the
  // `tabs/` IPC dir) are NOT in the prune list, so an in-flight
  // `pwa test --status` still answers correctly across `--fresh`
  // invocations of follow-up tests.
  if (opts.fresh === true) {
    const { pruned } = pruneStaleArtifacts(layout, out);
    if (pruned.length > 0) {
      out.log(`elanous nexus run --test --fresh: pruned ${pruned.map((p) => `${p}/`).join(' · ')}`);
    } else {
      out.log('elanous nexus run --test --fresh: nothing to prune (.elanous-test/ was already clean).');
    }
  }

  // Static mode requires `apps/pwa/out`. Auto-rebuild when --rebuild
  // flag is on (matches `pwa restart --rebuild` semantics).
  const isHmr = opts.hmr === true;
  if (!isHmr && (opts.rebuild || !existsSync(layout.pwaOutDir))) {
    if (!opts.rebuild && !existsSync(layout.pwaOutDir)) {
      out.log('elanous nexus run --test: apps/pwa/out missing — running `pwa build` first.');
    }
    const rebuildFn = opts.rebuildFn ?? defaultRebuild;
    const r = await rebuildFn(layout.pwaCwd);
    if (r.exitCode !== 0) {
      out.error(`✗ pwa build failed (exit ${r.exitCode}). Aborting test start.`);
      // Most common cause on a fresh/pulled tree: declared deps were never
      // installed (webpack "Module not found"). Surface the one-line fix on
      // the LAST line so it isn't lost above the build's own output. --test
      // keeps auto-install opt-in, so point at both the manual fix and flag.
      try {
        const { checkPwaBuildDeps } = await import('./pwa-build.js');
        const deps = checkPwaBuildDeps(layout.pwaCwd);
        if (!deps.ok) {
          const shown = deps.missing.slice(0, 3).join(', ');
          const more = deps.missing.length > 3 ? ` (+${deps.missing.length - 3} more)` : '';
          out.error(`  ↳ apps/pwa 의존성 미설치: ${shown}${more}`);
          out.error(`    fix:  cd "${layout.pwaCwd}" && bun install   (또는 \`nexus run --test --auto-install\`)`);
        }
      } catch { /* hint is best-effort */ }
      return { exitCode: r.exitCode };
    }
  }

  let nexusPick: Awaited<ReturnType<typeof pickNexusPort>>;
  try { nexusPick = await pickNexusPort(opts.port, layout, opts); }
  catch (err) {
    out.error(`✗ coordinator port lease failed: ${err instanceof Error ? err.message : String(err)}`);
    return { exitCode: 1 };
  }
  if ('error' in nexusPick) {
    out.error(`✗ ${nexusPick.error}`);
    return { exitCode: 1 };
  }
  const nexusPort = nexusPick.port;
  const coordinatorPrimary = 'primary' in nexusPick ? nexusPick.primary : undefined;
  const coordinatorToken = coordinatorPrimary?.token;
  const releasePickedLease = async (): Promise<void> => {
    if (nexusPick.reason === 'coordinator lease') {
      if (opts.releasePortFn) await opts.releasePortFn(nexusPort);
      else if (nexusPick.leaseId) await releaseCoordinatorPort({ port: nexusPort, leaseId: nexusPick.leaseId }, coordinatorPrimary);
    }
  };

  let devPort: number | undefined;
  if (isHmr) {
    let devPick: Awaited<ReturnType<typeof pickDevPort>>;
    try { devPick = await pickDevPort(opts); }
    catch (error) {
      await releasePickedLease();
      throw error;
    }
    if (typeof devPick !== 'number') {
      out.error(`✗ ${devPick.error}`);
      await releasePickedLease();
      return { exitCode: 1 };
    }
    devPort = devPick;
  }

  // Project-local nexus state subtree. The detached daemon will see
  // this override via `--test-state-dir <path>` argv re-appended in
  // `bg-launch.ts` (2026-05-13 · config-dir-unify replaces the
  // previous `process.env.ELANOUS_NEXUS_DIR` inheritance).
  setTestStateRoot(layout.stateDir);

  // ISO-2 (2026-07-13 · 대표 결정) — config 도 완전 분기. `--test` 하나로
  // state + config 전부 <repo>/.elanous-test/ 아래로 간다. 운영 config 는
  // 물질화 사본(sync-test)으로만 전달되고, 테스트 프로세스는 운영
  // config.json 을 아예 열지 않는다(overlay 은퇴). bg-launch 가 부모의
  // config-dir 를 `--config-dir` argv 로 자식에 물려주므로 여기서 부모를
  // 분기하면 데몬 자식도 자동 상속된다.
  try {
    const { setElanousConfigDir } = await import('../elanous-config-dir.js');
    setElanousConfigDir(layout.stateDir);
    const { syncTestConfig, isTestConfigStale } = await import('./config-test-sync.js');
    if (!existsSync(joinPath(layout.stateDir, 'config.json'))) {
      const r = syncTestConfig(layout.stateDir);
      out.log(`config 격리: 운영 config 물질화 → ${r.testConfigPath} (telegram=${r.telegramMode})`);
    } else if (isTestConfigStale(layout.stateDir)) {
      out.log(`config 격리: ⚠️ 운영 config 가 테스트 사본보다 최신 — 'elanous config sync-test' 로 갱신 권장`);
    }
  } catch (e) {
    out.error(`✗ config 격리 실패: ${e instanceof Error ? e.message : String(e)} — 운영 오염 위험이라 기동 중단`);
    await releasePickedLease();
    return { exitCode: 1 };
  }

  // Bind interface depends on transport mode:
  //   - --https → loopback only (Tailscale Serve binds the Tailscale
  //     interface :<port> separately and needs us out of its way).
  //   - HTTP only → 0.0.0.0 so iPad can reach via LAN IP / Tailscale
  //     IP / localhost.
  const wantsHttps = opts.https === true || opts.voice === true;
  const httpHost = wantsHttps ? '127.0.0.1' : '0.0.0.0';

  const pwaStartFn = opts.pwaStartFn ?? runPwaStart;
  const mode: PwaStartMode = isHmr ? 'hmr' : 'static';
  const startOpts: PwaStartOpts = {
    mode,
    httpHost,
    httpPort: nexusPort,
    ...(nexusPick.reason === 'coordinator lease' ? { coordinatorLeasePort: nexusPort, ...(coordinatorToken ? { coordinatorLeaseToken: coordinatorToken } : {}), ...(nexusPick.leaseId ? { coordinatorLeaseId: nexusPick.leaseId } : {}) } : {}),
    out,
    ...(opts.force ? { force: true } : {}),
    ...(opts.toolCwd !== undefined ? { toolCwd: opts.toolCwd } : {}),
    ...(devPort !== undefined ? { devPort } : {}),
    // Parity with `elanous nexus run` — staleness build / same-tree
    // restart / fs.watch are all opt-in for test mode (vs. opt-out for
    // the canonical entry). The user surface adds `--watch` /
    // `--auto-build` / `--auto-restart` if they want the same calm
    // auto-reload that `nexus run` provides.
    ...(opts.autoBuild === true ? { autoBuild: true } : {}),
    ...(opts.autoInstall === true ? { autoInstall: true } : {}),
    ...(opts.autoRestart === true ? { autoRestart: true } : {}),
    ...(opts.watch === true && mode === 'static' ? { watch: true } : {}),
    // Test mode never auto-shares via the `pwa share enable` switch —
    // we manage Tailscale Serve ourselves via the unified helper in
    // tailscale-serve.ts (TLS-tcp mode · WS-friendly).
    readShareSwitchFn: () => 'disabled',
  };
  let startRes: PwaStartResult;
  try { startRes = await pwaStartFn(startOpts); }
  catch (err) {
    await releasePickedLease();
    throw err;
  }
  if (startRes.exitCode !== 0) {
    await releasePickedLease();
    return { exitCode: startRes.exitCode };
  }

  let url: string | undefined;
  let tailscaleMounted = false;

  if (wantsHttps) {
    out.log('');
    out.log('elanous nexus run --test --https: mounting Tailscale Serve (TLS-terminated-tcp)…');
    const mountFn =
      opts.tailscaleMountFn
      ?? ((port: number, mountOpts: Omit<TailscaleServeOpts, 'upstreamPort'>) =>
        mountTailscaleServe({
          ...mountOpts,
          mode: { kind: 'tls-tcp', port },
          upstreamPort: port,
        }));
    const mountRes = await mountFn(nexusPort, {
      statePath: layout.tailscaleStatePath,
      out,
    });
    if (!mountRes.ok) {
      out.error(`✗ Tailscale Serve mount failed: ${mountRes.reason ?? 'unknown'}`);
      if (mountRes.detail) out.error(`  ${mountRes.detail}`);
      out.error('  Daemon is up; HTTPS surface is NOT — fall back to HTTP URLs:');
      for (const u of urlForLanHttp(nexusPort)) out.error(`    ${u}`);
      return {
        exitCode: 1,
        picked: { nexusPort, ...(devPort !== undefined ? { devPort } : {}) },
      };
    }
    tailscaleMounted = true;
    url = mountRes.url ?? undefined;
    if (mountRes.swappedFrom !== undefined) {
      out.log(`  swapped Serve from port ${mountRes.swappedFrom.upstreamPort} → ${nexusPort}`);
    }
    out.log(`  ✓ Serve ON · ${url}`);
  }

  // Persist a quick-read state file so `--status` doesn't have to
  // re-derive everything. Single shot · idempotent.
  writeFileSync(
    joinPath(layout.stateDir, 'test-state.json'),
    JSON.stringify(
      {
        mode: isHmr ? 'hmr' : 'static',
        nexusPort,
        ...(devPort !== undefined ? { devPort } : {}),
        https: wantsHttps,
        url: url ?? null,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  out.log('');
  out.log('────────────── elanous nexus run --test ──────────────');
  out.log(`  mode      ${isHmr ? 'hmr' : 'static'}`);
  out.log(`  nexus     :${nexusPort}${nexusPick.reason ? `  (${nexusPick.reason})` : ''}`);
  if (devPort !== undefined) out.log(`  next-dev  :${devPort}`);
  out.log(`  state     ${layout.stateDir}`);
  out.log('');
  if (wantsHttps && url) {
    out.log('  iPad / external (HTTPS · voice/camera OK):');
    out.log(`    ${url}`);
  } else {
    out.log('  iPad / external (HTTP · voice/camera disabled):');
    for (const u of urlForLanHttp(nexusPort)) out.log(`    ${u}`);
  }
  out.log('');
  out.log('  stop      elanous nexus run --test --stop');
  out.log('  status    elanous nexus run --test --status');
  out.log('────────────────────────────────────────────────');

  return {
    exitCode: 0,
    ...(url !== undefined ? { url } : {}),
    picked: { nexusPort, ...(devPort !== undefined ? { devPort } : {}) },
    tailscaleMounted,
  };
}

async function runStop(
  layout: RepoLayout,
  opts: PwaTestOpts,
  out: NonNullable<PwaTestOpts['out']>,
): Promise<PwaTestResult> {
  // Mirror runStart — flip the in-process nexus state root so the
  // stop signal targets `<.elanous-test>/nexus/.lock` (not the user's
  // `~/.elanous/nexus/.lock`). config dir untouched.
  setTestStateRoot(layout.stateDir);
  const pwaStopFn = opts.pwaStopFn ?? runPwaStop;
  out.log('elanous nexus run --test --stop: cascade');

  // Tailscale Serve unmount FIRST — the user's iPad URL stops working
  // immediately, then we tear down daemon + dev. This order matches
  // the start order in reverse. `upstreamPort: 0` is a sentinel meaning
  // "read from state file" — the unified helper consults `statePath`
  // when no explicit mode is supplied.
  const unmountFn =
    opts.tailscaleUnmountFn
    ?? ((unmountOpts: Omit<TailscaleServeOpts, 'upstreamPort'>) =>
      unmountTailscaleServe({ ...unmountOpts, upstreamPort: 0 }));
  const unmountRes = await unmountFn({
    statePath: layout.tailscaleStatePath,
    out,
  });
  if (!unmountRes.ok && unmountRes.reason !== 'no-state') {
    out.error(`  Tailscale Serve unmount issue: ${unmountRes.reason ?? 'unknown'}`);
    if (unmountRes.detail) out.error(`  ${unmountRes.detail}`);
  } else if (unmountRes.unmounted?.upstreamPort !== undefined) {
    out.log(`  ✓ Tailscale Serve OFF (was port ${unmountRes.unmounted.upstreamPort})`);
  }

  // Reuse `runPwaStop` to cascade dev BG + daemon. We pass our own
  // tailscale reset that's a no-op so we don't double-touch (and so we
  // don't clobber the user's other Serves). The dev BG stop also
  // DELETEs the admin endpoint via its own `finally`.
  const stopRes = await pwaStopFn({
    out,
    shareProbeFn: async () => ({ installed: false, alive: false }),
    shareResetFn: async () => ({ exitCode: 0 }),
  });

  // Cleanup state files — leave logs/ for post-mortem.
  const stateFile = joinPath(layout.stateDir, 'test-state.json');
  if (existsSync(stateFile)) {
    try { rmSync(stateFile, { force: true }); } catch { /* swallow */ }
  }

  return { exitCode: stopRes.exitCode };
}

function runStatus(
  layout: RepoLayout,
  out: NonNullable<PwaTestOpts['out']>,
): PwaTestResult {
  const stateFile = joinPath(layout.stateDir, 'test-state.json');
  if (!existsSync(stateFile)) {
    out.log('elanous nexus run --test: no active test instance.');
    return { exitCode: 0 };
  }
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as {
      mode?: string;
      nexusPort?: number;
      devPort?: number;
      https?: boolean;
      url?: string | null;
      startedAt?: string;
    };
    out.log('elanous nexus run --test --status:');
    out.log(`  mode      ${parsed.mode ?? '(unknown)'}`);
    out.log(`  nexus     :${parsed.nexusPort ?? '?'}`);
    if (parsed.devPort !== undefined) out.log(`  next-dev  :${parsed.devPort}`);
    out.log(`  https     ${parsed.https ? 'ON' : 'OFF'}`);
    if (parsed.url) out.log(`  url       ${parsed.url}`);
    out.log(`  started   ${parsed.startedAt ?? '(unknown)'}`);

    const tsState = readMountedState(layout.tailscaleStatePath);
    if (tsState && tsState.mode.kind === 'tls-tcp') {
      out.log(`  tailscale port=${tsState.mode.port} hostname=${tsState.hostname ?? '?'}`);
    }
    return { exitCode: 0 };
  } catch (err) {
    out.error(`elanous nexus run --test --status: state file unreadable — ${(err as Error).message}`);
    return { exitCode: 1 };
  }
}

export async function runPwaTest(opts: PwaTestOpts = {}): Promise<PwaTestResult> {
  const out = opts.out ?? console;
  const layout = resolveLayout(opts);
  if (!layout) {
    out.error(
      `elanous nexus run --test: could not resolve repo root from argv[1]=${opts.argvBin ?? process.argv[1] ?? '(empty)'}`,
    );
    out.error('  Run from a checkout of monad-agent (the bin symlink lives at <repo>/bin/elanous.mjs).');
    return { exitCode: 1 };
  }

  if (opts.status) return runStatus(layout, out);
  if (opts.stop) return runStop(layout, opts, out);
  return runStart(layout, opts, out);
}
