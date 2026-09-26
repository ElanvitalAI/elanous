// Unified Tailscale Serve helper — single source of truth for the
// two transport modes monad-agent uses on macOS:
//
//   - `https-443` — share the daemon on the host's standard HTTPS:443
//                   (one Serve per host · used by `pwa share enable`
//                   and the legacy `bringShareUp` auto-share path in
//                   `pwa-start`). HTTP/2 forwarder · NOT WebSocket-
//                   friendly (Upgrade returns 502).
//
//   - `tls-tcp`   — per-port TLS terminator forwarding plaintext TCP
//                   (HTTP/1.1) to a backend on `localhost:<port>`.
//                   Used by `pwa test --https` for project-local
//                   isolated dogfood. WebSocket Upgrade returns 101
//                   (the iPad-side multi-LLM dispatch needs this).
//
// Why unify? Before this lift, `defaultServe` (https-443) and
// `mountTailscaleTestServe` (tls-tcp) duplicated:
//   - `tailscale serve` shell-out + sudo-required detection
//   - state-file singleton tracking (tls-tcp only)
//   - probe + hostname resolution
// One bug fix touched 2 places. With the unified helper, callers
// pass a discriminated `mode` and the orchestration is shared.
//
// Backward compat: `defaultServe` (pwa-share-prompt) is kept as a thin
// wrapper because its `(binary, port) => { exitCode }` signature is the
// dep-injection contract for `serveFn`/`shareServeFn` in
// `pwa-share-prompt`/`pwa-share`/`pwa-start`. The corresponding
// tls-tcp wrapper (`mountTailscaleTestServe`, formerly in
// `tailscale-test-serve.ts`) was removed in 2026-05-09: only one
// caller (`pwa-test`) used it, so callers now invoke `mountTailscaleServe`
// directly with `mode: { kind: 'tls-tcp', port }`.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { probeTailscale, type TailscaleProbe } from '../nexus/onboarding/tailscale-probe.js';

export type TailscaleServeMode =
  | { kind: 'https-443' }
  | { kind: 'tls-tcp'; port: number };

export interface TailscaleServeOpts {
  /** State file for singleton tracking. When provided, the helper:
   *  - On mount: reads prior state · if mode/port differ, removes the
   *    prior Serve before mounting the new one · writes new state.
   *  - On unmount: reads state to know what to remove.
   *  Optional — `https-443` callers may rely on `serve reset` instead. */
  statePath?: string;
  /** Backend port to forward to. For `tls-tcp` this is also the
   *  public-facing port (mode.port == upstreamPort by convention).
   *  For `https-443` this is the only varying field per host. */
  upstreamPort: number;
  /** Path component of the surfaced URL (default `/app/showroom/`). */
  urlPath?: string;
  /** Mutation privilege policy: by default try without sudo, then retry
   *  once with `sudo -n` only on a permission error. `true` uses sudo
   *  immediately; `false` runs without sudo and never retries. */
  useSudo?: boolean;
  /** Test seam — replace `probeTailscale`. */
  probeFn?: () => Promise<TailscaleProbe>;
  /** Test seam — replace `tailscale serve <args>` shell-out. */
  serveCmdFn?: (binary: string, args: readonly string[]) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
  /** Output sink (default = console). */
  out?: { log: (s: string) => void; error: (s: string) => void };
}

export interface MountTailscaleServeOpts extends TailscaleServeOpts {
  mode: TailscaleServeMode;
}

export interface MountTailscaleServeResult {
  ok: boolean;
  /** When `ok=true`, the URL the iPad/external device should use. */
  url: string | null;
  /** When `ok=false`, machine-readable reason for the failure. */
  reason?:
    | 'tailscale-missing'
    | 'tailscale-down'
    | 'magic-dns-unknown'
    | 'serve-cmd-failed'
    | 'sudo-required';
  /** Human-readable detail (e.g., serve stderr or sudo prompt hint). */
  detail?: string;
  /** When the mount swapped a prior Serve (singleton path · only when
   *  `statePath` was provided + prior mode/port differed). */
  swappedFrom?: { mode: TailscaleServeMode; upstreamPort: number };
}

export interface UnmountTailscaleServeOpts extends TailscaleServeOpts {
  /** Override the mode to unmount. When omitted + `statePath` is set,
   *  reads from state. When neither is set, unmount is a no-op. */
  mode?: TailscaleServeMode;
}

export interface UnmountTailscaleServeResult {
  ok: boolean;
  /** True when the unmount issued a `serve off` command (vs no-op). */
  unmounted?: { mode: TailscaleServeMode; upstreamPort: number };
  reason?: 'no-state' | 'tailscale-missing' | 'serve-cmd-failed' | 'sudo-required';
  detail?: string;
}

export interface InspectTailscaleServeMountOpts {
  /** TLS-terminated TCP port whose Serve mapping is inspected. */
  port: number;
  /** Tailscale binary resolved by the caller's probe. */
  binary?: string;
  /** Whether to wrap the read-only status command in `sudo -n`. */
  useSudo?: boolean;
  /** Test seam — replace `tailscale serve <args>` shell-out. */
  serveCmdFn?: (binary: string, args: readonly string[]) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}

/** Actual status of a port-specific TLS-terminated TCP Serve mapping. */
export type TailscaleServeMountStatus = 'mounted' | 'unmounted' | 'unknown';

export interface CleanGhostTailscaleServeOpts extends Omit<TailscaleServeOpts, 'upstreamPort'> {
  /** The TLS-terminated TCP port to inspect before an HTTP listener binds. */
  port: number;
  /** Test seam — replace the kernel socket-table query. `null` means unavailable. */
  socketTableFn?: () => Promise<string | null>;
}

export interface CleanGhostTailscaleServeResult {
  ok: boolean;
  cleaned: boolean;
  reason: 'no-mapping' | 'listener-present' | 'socket-table-unavailable' | 'cleaned' | 'tailscale-missing' | 'serve-status-failed' | 'serve-off-failed';
  /** Addresses classified as actual backends (every recognized non-tailnet listener). */
  backendListeners?: string[];
  /** Tailnet-only listeners ignored as Serve's own listeners. */
  ignoredTailnetListeners?: string[];
  detail?: string;
}

const STATE_FILE_VERSION = 1;
const DEFAULT_URL_PATH = '/app/showroom/';
const SUDO_PROMPT_HINT =
  'Tailscale Serve mutation needs sudo. Cached credentials are missing or expired.\n' +
  '  Run once interactively, then retry:\n' +
  '    sudo -v\n' +
  '  Or run the full command directly:';

interface MountedState {
  version: typeof STATE_FILE_VERSION;
  mode: TailscaleServeMode;
  upstreamPort: number;
  hostname: string | null;
  mountedAt: string;
}

function readState(statePath: string | undefined): MountedState | null {
  if (!statePath || !existsSync(statePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as
      | (Partial<MountedState> & { port?: number })
      | null;
    if (!parsed || parsed.version !== STATE_FILE_VERSION) return null;
    if (!parsed.mode || typeof parsed.upstreamPort !== 'number') {
      // Legacy state file (`port` only · pre-lift) — recover gracefully
      // as tls-tcp on that port. The next mount will write the v1 shape.
      if (typeof parsed.port === 'number') {
        return {
          version: STATE_FILE_VERSION,
          mode: { kind: 'tls-tcp', port: parsed.port },
          upstreamPort: parsed.port,
          hostname: typeof parsed.hostname === 'string' ? parsed.hostname : null,
          mountedAt:
            typeof parsed.mountedAt === 'string'
              ? parsed.mountedAt
              : new Date().toISOString(),
        };
      }
      return null;
    }
    return {
      version: STATE_FILE_VERSION,
      mode: parsed.mode,
      upstreamPort: parsed.upstreamPort,
      hostname: typeof parsed.hostname === 'string' ? parsed.hostname : null,
      mountedAt:
        typeof parsed.mountedAt === 'string' ? parsed.mountedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function writeState(statePath: string | undefined, state: MountedState): void {
  if (!statePath) return;
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(
    statePath,
    JSON.stringify(state, null, 2),
    { mode: 0o600 },
  );
}

function clearState(statePath: string | undefined): void {
  if (!statePath || !existsSync(statePath)) return;
  try { rmSync(statePath, { force: true }); } catch { /* swallow */ }
}

function buildDefaultServeCmd(useSudo: boolean): (
  binary: string,
  args: readonly string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return (binary, args) => new Promise((resolve) => {
    const cmd = useSudo ? 'sudo' : binary;
    const argv = useSudo ? ['-n', binary, ...args] : [...args];
    execFile(cmd, argv, { timeout: 15000 }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ exitCode: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        return;
      }
      const code =
        err && typeof err === 'object' && 'code' in err && typeof err.code === 'number'
          ? err.code
          : 1;
      resolve({
        exitCode: code,
        stdout: String(stdout ?? ''),
        stderr: String(stderr || (err as Error).message || ''),
      });
    });
  });
}

function isSudoFailure(res: { exitCode: number; stderr: string }): boolean {
  if (res.exitCode === 0) return false;
  return /password is required|a password is required|sudo:.*password/i.test(res.stderr);
}

function isPermissionFailure(res: { exitCode: number; stderr: string }): boolean {
  return res.exitCode !== 0
    && /permission denied|operation not permitted|access denied|requires? (?:root|sudo|administrator)|must (?:be root|run as root)|EACCES|EPERM/i.test(res.stderr);
}

function mutationServeCmd(opts: Pick<TailscaleServeOpts, 'useSudo' | 'serveCmdFn'>): (
  binary: string,
  args: readonly string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const serveCmdFn = opts.serveCmdFn;
  const direct = serveCmdFn ?? buildDefaultServeCmd(false);
  const sudo = serveCmdFn
    ? (binary: string, args: readonly string[]) => serveCmdFn('sudo', ['-n', binary, ...args])
    : buildDefaultServeCmd(true);
  return async (binary, args) => {
    if (opts.useSudo === true) return sudo(binary, args);
    const result = await direct(binary, args);
    return opts.useSudo === undefined && isPermissionFailure(result)
      ? sudo(binary, args)
      : result;
  };
}

/** Build the `tailscale serve …` argv for the chosen mode. */
function mountArgs(mode: TailscaleServeMode, upstreamPort: number): string[] {
  if (mode.kind === 'https-443') {
    return ['serve', '--bg', '--https=443', `http://localhost:${upstreamPort}`];
  }
  // tls-tcp — public-facing TLS terminator on `mode.port` forwarding
  // plaintext TCP to `localhost:<upstreamPort>`. Convention: caller
  // sets mode.port == upstreamPort (one daemon, one port).
  return ['serve', '--bg', '--tls-terminated-tcp', String(mode.port), `tcp://localhost:${upstreamPort}`];
}

/** Build a mode-scoped `tailscale serve … off` argv. This must never
 * reset the host-wide Serve configuration because other worktrees may
 * have live mappings on separate ports. */
function unmountArgs(mode: TailscaleServeMode): string[] {
  if (mode.kind === 'https-443') return ['serve', '--https=443', 'off'];
  return ['serve', '--tls-terminated-tcp', String(mode.port), 'off'];
}

/** URL the iPad/external device should use. */
function buildUrl(mode: TailscaleServeMode, hostname: string, urlPath: string): string {
  if (mode.kind === 'https-443') {
    return `https://${hostname}${urlPath}`;
  }
  return `https://${hostname}:${mode.port}${urlPath}`;
}

function modesEqual(a: TailscaleServeMode, b: TailscaleServeMode): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'tls-tcp' && b.kind === 'tls-tcp') return a.port === b.port;
  return true;
}

function sudoCmdHint(binary: string, args: readonly string[]): string {
  return `    sudo ${binary} ${args.join(' ')}`;
}

/** Mount a Tailscale Serve forward in the chosen `mode`. Singleton
 *  tracking is opt-in via `statePath` — when provided, a prior
 *  mounted port/mode is removed before the new one is added. */
export async function mountTailscaleServe(
  opts: MountTailscaleServeOpts,
): Promise<MountTailscaleServeResult> {
  const probe = await (opts.probeFn ?? probeTailscale)();
  if (!probe.installed) return { ok: false, url: null, reason: 'tailscale-missing' };
  if (!probe.alive) return { ok: false, url: null, reason: 'tailscale-down' };
  const hostname = probe.magicDnsHost ?? probe.hostname ?? null;
  if (!hostname) return { ok: false, url: null, reason: 'magic-dns-unknown' };
  const binary = probe.binary ?? 'tailscale';
  const serveCmd = mutationServeCmd(opts);
  const urlPath = opts.urlPath ?? DEFAULT_URL_PATH;

  // Singleton swap — when state describes a different mode/port,
  // remove the prior Serve before mounting the new one.
  let swappedFrom: MountTailscaleServeResult['swappedFrom'];
  const prior = readState(opts.statePath);
  if (
    prior
    && (
      !modesEqual(prior.mode, opts.mode)
      || prior.upstreamPort !== opts.upstreamPort
    )
  ) {
    const offRes = await serveCmd(binary, unmountArgs(prior.mode));
    if (offRes.exitCode === 0) {
      swappedFrom = { mode: prior.mode, upstreamPort: prior.upstreamPort };
    } else if (isSudoFailure(offRes)) {
      return {
        ok: false,
        url: null,
        reason: 'sudo-required',
        detail:
          `${SUDO_PROMPT_HINT}\n` +
          `${sudoCmdHint(binary, unmountArgs(prior.mode))}\n` +
          `${sudoCmdHint(binary, mountArgs(opts.mode, opts.upstreamPort))}`,
      };
    }
    // Non-sudo failure is tolerated — prior may already be gone.
  }

  const onRes = await serveCmd(binary, mountArgs(opts.mode, opts.upstreamPort));
  if (onRes.exitCode !== 0) {
    if (isSudoFailure(onRes)) {
      return {
        ok: false,
        url: null,
        reason: 'sudo-required',
        detail:
          `${SUDO_PROMPT_HINT}\n${sudoCmdHint(binary, mountArgs(opts.mode, opts.upstreamPort))}`,
      };
    }
    return {
      ok: false,
      url: null,
      reason: 'serve-cmd-failed',
      detail: (onRes.stderr || onRes.stdout || `exit ${onRes.exitCode}`).slice(0, 400),
    };
  }

  writeState(opts.statePath, {
    version: STATE_FILE_VERSION,
    mode: opts.mode,
    upstreamPort: opts.upstreamPort,
    hostname,
    mountedAt: new Date().toISOString(),
  });

  const result: MountTailscaleServeResult = {
    ok: true,
    url: buildUrl(opts.mode, hostname, urlPath),
  };
  if (swappedFrom !== undefined) result.swappedFrom = swappedFrom;
  return result;
}

/** Unmount a Tailscale Serve forward. When `mode` is omitted, the
 *  state file is consulted; when neither is present, the call is a
 *  safe no-op (`reason: 'no-state'`). */
export async function unmountTailscaleServe(
  opts: UnmountTailscaleServeOpts,
): Promise<UnmountTailscaleServeResult> {
  let mode: TailscaleServeMode | undefined = opts.mode;
  let upstreamPort: number | undefined =
    opts.upstreamPort > 0 ? opts.upstreamPort : undefined;
  if (!mode) {
    const state = readState(opts.statePath);
    if (!state) return { ok: true, reason: 'no-state' };
    mode = state.mode;
    upstreamPort = state.upstreamPort;
  }
  if (upstreamPort === undefined) upstreamPort = opts.upstreamPort;

  const probe = await (opts.probeFn ?? probeTailscale)();
  if (!probe.installed) {
    clearState(opts.statePath);
    return { ok: false, reason: 'tailscale-missing' };
  }
  const binary = probe.binary ?? 'tailscale';
  const serveCmd = mutationServeCmd(opts);
  const offRes = await serveCmd(binary, unmountArgs(mode));
  if (offRes.exitCode !== 0) {
    if (isSudoFailure(offRes)) {
      return {
        ok: false,
        reason: 'sudo-required',
        detail: `${SUDO_PROMPT_HINT}\n${sudoCmdHint(binary, unmountArgs(mode))}`,
      };
    }
    // Clear state regardless — non-sudo failure usually means the
    // serve was already absent; we should not keep claiming we own it.
    clearState(opts.statePath);
    return {
      ok: false,
      unmounted: { mode, upstreamPort },
      reason: 'serve-cmd-failed',
      detail: (offRes.stderr || offRes.stdout || `exit ${offRes.exitCode}`).slice(0, 400),
    };
  }
  clearState(opts.statePath);
  return { ok: true, unmounted: { mode, upstreamPort } };
}

function defaultSocketTable(): Promise<string | null> {
  const args = process.platform === 'darwin' ? ['-an', '-p', 'tcp'] : ['-ltn'];
  return new Promise((resolve) => {
    // These commands read the kernel socket table without asking the OS
    // to reveal a process owner, so root-owned listeners cannot disappear
    // from this safety check. `netstat -p` is a macOS protocol selector;
    // Linux uses `ss -ltn`, where no process-owner flag is needed.
    execFile(process.platform === 'linux' ? 'ss' : 'netstat', args, { timeout: 5000 }, (err, stdout) => {
      resolve(err ? null : String(stdout ?? ''));
    });
  });
}

function hasTlsTcpMapping(status: string, port: number): boolean {
  try {
    const parsed = JSON.parse(status) as { TCP?: Record<string, unknown> };
    return Boolean(parsed.TCP && Object.prototype.hasOwnProperty.call(parsed.TCP, String(port)));
  } catch {
    return false;
  }
}

/** Read the live Serve status for one TLS-terminated TCP port without changing it.
 * A mount is valid only when Tailscale declares TLS termination and forwards
 * exactly to that port's localhost TCP upstream. */
export async function inspectTailscaleServeMount(
  opts: InspectTailscaleServeMountOpts,
): Promise<TailscaleServeMountStatus> {
  const serveCmd = opts.serveCmdFn ?? buildDefaultServeCmd(opts.useSudo !== false);
  const status = await serveCmd(opts.binary ?? 'tailscale', ['serve', 'status', '--json']);
  if (status.exitCode !== 0) return 'unknown';

  try {
    const parsed = JSON.parse(status.stdout) as { TCP?: unknown };
    if (!parsed.TCP || typeof parsed.TCP !== 'object' || Array.isArray(parsed.TCP)) return 'unknown';
    const mapping = (parsed.TCP as Record<string, unknown>)[String(opts.port)];
    if (mapping === undefined) return 'unmounted';
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return 'unknown';

    const { TCPForward, TerminateTLS } = mapping as Record<string, unknown>;
    if (typeof TerminateTLS !== 'string' || typeof TCPForward !== 'string') return 'unmounted';
    // ⛔ 2026-08-14 실측 — 이 자리는 `tcp://localhost:<port>` «만» 받다가 거짓 unmounted 를 냈다.
    //   실제 `tailscale serve status --json` 은 스킴 «없이» 준다:
    //     "31415": { "TCPForward": "localhost:31415", "TerminateTLS": "mbp.tailnet-example.ts.net" }
    //   ⇒ 되는 마운트를 unmounted 로 읽어 «동작하는» tailnet 주소를 감췄다.
    //   두 형태를 다 받는다(옛 문면은 리뷰 추정이었고 실물로 확인된 적이 없었다).
    const upstream = TCPForward.replace(/^tcp:\/\//, '');
    return upstream === `localhost:${opts.port}` ? 'mounted' : 'unmounted';
  } catch {
    return 'unknown';
  }
}

interface ListenerClassification {
  backendListeners: string[];
  ignoredTailnetListeners: string[];
}

function localAddressForPort(endpoint: string, port: number): string | null {
  const suffix = `:${port}`;
  if (endpoint.endsWith(suffix)) return endpoint.slice(0, -suffix.length).replace(/^\[|\]$/g, '');
  const dottedSuffix = `.${port}`;
  if (endpoint.endsWith(dottedSuffix)) return endpoint.slice(0, -dottedSuffix.length);
  return null;
}

function isTailnetListenerAddress(address: string): boolean {
  const ipv4 = /^100\.(?:6[4-9]|[789]\d|1[01]\d|12[0-7])\./.test(address);
  return ipv4 || /^fd7a:115c:a1e0:/i.test(address);
}

function classifyListeningSockets(socketTable: string, port: number): ListenerClassification {
  const addresses = new Set<string>();

  for (const line of socketTable.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    // Linux `ss -ltn` writes LISTEN first and the local endpoint in column 4.
    if (columns[0] === 'LISTEN' && columns.length >= 4) {
      const address = localAddressForPort(columns[3], port);
      if (address !== null) addresses.add(address);
      continue;
    }

    // macOS `netstat -an -p tcp` writes the local endpoint before trailing LISTEN.
    if (/\bLISTEN(?:ING)?\b/i.test(line)) {
      for (const endpoint of columns) {
        const address = localAddressForPort(endpoint, port);
        if (address !== null) addresses.add(address);
      }
    }
  }

  // Tailscale Serve owns only tailnet-bound sockets. Every other recognized
  // listener may be another process, so preserve the mapping conservatively.
  const backendListeners = [...addresses].filter((address) => !isTailnetListenerAddress(address));
  const ignoredTailnetListeners = [...addresses].filter(isTailnetListenerAddress);
  return { backendListeners, ignoredTailnetListeners };
}

/** Remove a Serve mapping only when its TLS port has no kernel listener.
 * This deliberately does not inspect process ownership: a live listener
 * may belong to another user or root and must preserve its shared mapping. */
export async function cleanGhostTailscaleServe(
  opts: CleanGhostTailscaleServeOpts,
): Promise<CleanGhostTailscaleServeResult> {
  const probe = await (opts.probeFn ?? probeTailscale)();
  if (!probe.installed) return { ok: false, cleaned: false, reason: 'tailscale-missing' };

  const binary = probe.binary ?? 'tailscale';
  const serveCmd = opts.serveCmdFn ?? buildDefaultServeCmd(opts.useSudo !== false);
  const status = await serveCmd(binary, ['serve', 'status', '--json']);
  if (status.exitCode !== 0) {
    return {
      ok: false,
      cleaned: false,
      reason: 'serve-status-failed',
      detail: (status.stderr || status.stdout || `exit ${status.exitCode}`).slice(0, 400),
    };
  }
  if (!hasTlsTcpMapping(status.stdout, opts.port)) {
    return { ok: true, cleaned: false, reason: 'no-mapping' };
  }

  const socketTable = await (opts.socketTableFn ?? defaultSocketTable)();
  if (socketTable === null) {
    return { ok: false, cleaned: false, reason: 'socket-table-unavailable' };
  }
  const listeners = classifyListeningSockets(socketTable, opts.port);
  if (listeners.backendListeners.length > 0) {
    return { ok: true, cleaned: false, reason: 'listener-present', ...listeners };
  }

  // Do not reuse unmountTailscaleServe here: its legacy lifecycle contract
  // uses `serve reset`, which would remove unrelated live mappings. This
  // preflight has a stricter contract and turns off only the verified port.
  const offRes = await mutationServeCmd(opts)(binary, ['serve', '--tls-terminated-tcp', String(opts.port), 'off']);
  if (offRes.exitCode !== 0) {
    return {
      ok: false,
      cleaned: false,
      reason: 'serve-off-failed',
      detail: (offRes.stderr || offRes.stdout || `exit ${offRes.exitCode}`).slice(0, 400),
    };
  }
  return { ok: true, cleaned: true, reason: 'cleaned', ...listeners };
}

/** Read-only inspection of a state file (no shell-out). */
export function readMountedState(statePath: string | undefined): MountedState | null {
  return readState(statePath);
}
