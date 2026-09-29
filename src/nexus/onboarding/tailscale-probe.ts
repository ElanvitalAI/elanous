// P.3 — Tailscale probe.
//
// Detects whether `tailscale` is installed + alive on the local host so
// the first-boot PWA share wizard can decide which prompt to render.
//
// Probe strategy: run `<binary> status --json` with a short timeout.
// `Self.HostName` / `Self.DNSName` / `Self.TailscaleIPs` come back when
// the daemon is up; the JSON also indicates `BackendState` ('Running' =
// alive, 'Stopped' / 'NeedsLogin' = installed but inactive).
//
// Binary candidates probed in order:
//   1. macOS app:  /Applications/Tailscale.app/Contents/MacOS/Tailscale
//   2. Homebrew:   /opt/homebrew/bin/tailscale
//   3. PATH:       'tailscale' (whatever shells out resolves)

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface TailscaleProbe {
  /** True when the binary was located + ran (regardless of daemon state). */
  installed: boolean;
  /** True when BackendState === 'Running'. */
  alive: boolean;
  /** Self.HostName from `status --json` (e.g., "mbp"). */
  hostname?: string;
  /** Self.DNSName trimmed (MagicDNS, e.g., "mbp.tailnet-xyz.ts.net"). */
  magicDnsHost?: string;
  /** Self.TailscaleIPs (e.g., ["100.64.0.2"]). */
  ips?: string[];
  /** Resolved binary path (for diagnostic / banner). */
  binary?: string;
  /** Raw BackendState string when JSON parsed cleanly. */
  backendState?: string;
}

export interface TailscaleProbeOpts {
  /** Override binary candidates (tests). When unset, the production
   *  search order is used. */
  candidates?: string[];
  /** Test seam — execFile shim returning stdout / exit code. */
  execFn?: (binary: string, args: string[]) => Promise<{ stdout: string; code: number }>;
  /** Test seam — exists check for binary path candidates. */
  existsFn?: (path: string) => boolean;
  /** Timeout for the status call in ms. Default 2000. */
  timeoutMs?: number;
}

const DEFAULT_CANDIDATES = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/opt/homebrew/bin/tailscale',
  'tailscale',
];

/** macOS 앱 번들의 `Tailscale` 바이너리는 환경이 비어 있으면(launchd 로 뜬 넥서스 — `TERM` 없음) CLI 가 아니라
 *  GUI 로 뜨려다 «The Tailscale GUI failed to start» 를 rc 0 으로 낸다 ⇒ JSON 파싱 실패 ⇒ `alive:false` ⇒
 *  공유 자동 마운트가 1분마다 «tailscale-down» 으로 건너뛰었다(📏 2026-09-27 운영 · 재시작 뒤 tailnet PWA 가 빠짐).
 *  `TAILSCALE_BE_CLI=1` 이 CLI 로 고정한다(다른 플랫폼·래퍼에는 무해). tailscale 을 부르는 모든 자리가 이 환경을 쓴다. */
export function tailscaleExecEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, TAILSCALE_BE_CLI: '1' };
}

function defaultExec(timeoutMs: number) {
  return (binary: string, args: string[]): Promise<{ stdout: string; code: number }> =>
    new Promise((resolve) => {
      execFile(binary, args, { timeout: timeoutMs, encoding: 'utf-8', env: tailscaleExecEnv() }, (err, stdout) => {
        // An execFile error with code !== 0 still surfaces stdout; capture both.
        if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'number') {
          resolve({ stdout: stdout ?? '', code: err.code });
          return;
        }
        if (err) {
          resolve({ stdout: stdout ?? '', code: 1 });
          return;
        }
        resolve({ stdout: stdout ?? '', code: 0 });
      });
    });
}

function isPathLike(candidate: string): boolean {
  return candidate.startsWith('/') || candidate.startsWith('.');
}

export async function probeTailscale(opts: TailscaleProbeOpts = {}): Promise<TailscaleProbe> {
  const candidates = opts.candidates ?? DEFAULT_CANDIDATES;
  const exists = opts.existsFn ?? existsSync;
  const exec = opts.execFn ?? defaultExec(opts.timeoutMs ?? 2000);

  // Pick the first candidate that's either an existing absolute path or
  // a bare command (let exec resolve it via PATH).
  let binary: string | undefined;
  for (const c of candidates) {
    if (!isPathLike(c)) {
      binary = c;
      break;
    }
    if (exists(c)) {
      binary = c;
      break;
    }
  }
  if (!binary) {
    return { installed: false, alive: false };
  }

  let result;
  try {
    result = await exec(binary, ['status', '--json']);
  } catch {
    // Bare-command exec failure means the binary is not on PATH.
    return { installed: false, alive: false, binary };
  }

  const installed = result.code !== 127; // 127 = command not found
  if (!installed) {
    return { installed: false, alive: false, binary };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { installed: true, alive: false, binary };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { installed: true, alive: false, binary };
  }

  const status = parsed as { BackendState?: string; Self?: { HostName?: string; DNSName?: string; TailscaleIPs?: string[] } };
  const backendState = typeof status.BackendState === 'string' ? status.BackendState : undefined;
  const alive = backendState === 'Running';
  const self = status.Self ?? {};
  const hostname = typeof self.HostName === 'string' ? self.HostName : undefined;
  const dns = typeof self.DNSName === 'string' ? self.DNSName.replace(/\.$/, '') : undefined;
  const ips = Array.isArray(self.TailscaleIPs)
    ? self.TailscaleIPs.filter((ip): ip is string => typeof ip === 'string')
    : undefined;

  return {
    installed: true,
    alive,
    binary,
    ...(backendState !== undefined ? { backendState } : {}),
    ...(hostname !== undefined ? { hostname } : {}),
    ...(dns !== undefined ? { magicDnsHost: dns } : {}),
    ...(ips !== undefined ? { ips } : {}),
  };
}
