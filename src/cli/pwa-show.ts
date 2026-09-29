// P5 (2026-05-10) — `elanous nexus pwa show` — current project's daemon
// view.
//
// Sibling of `pwa global status` (host-wide). `pwa show` narrows to the
// instance whose `cwd` matches the user's current working directory:
// "is this folder's daemon up? what URL do I open on iPad?".
//
// Lookup precedence (first match wins):
//   1. Registry entry where `entry.cwd === process.cwd()` (P4 hookup
//      stores cwd at register time).
//   2. Otherwise — fallback to no-match path with hint.
//
// When a match is found, surface:
//   - alive flag (pid still live?)
//   - all ports (nexus + dev for HMR)
//   - loopback URL (when the daemon's HTTP port is known)
//   - tailnet URL (only when `shareMounted=true` — picks up share
//     enable / `--https` ad-hoc)
//
// The tailnet URL is computed from a Tailscale probe at call time
// (instance entry doesn't store the magic-DNS hostname — that can
// change post-register and we want the current value).

import { homedir } from 'node:os';
import { join } from 'node:path';

import { listPwaInstances, type PwaInstanceListing } from './pwa-registry.js';
import { probeTailscale, type TailscaleProbe } from '../nexus/onboarding/tailscale-probe.js';
import { resolveDaemonEndpoint } from '../nexus/daemon-endpoint.js';
import { debug } from '../debug/log.js';

export interface PwaShowOpts {
  /** Format. Default 'human'. */
  format?: 'human' | 'json';
  /** Override the cwd used for matching (tests). */
  cwd?: string;
  /** Test seam — read registry. */
  listFn?: (opts: { prune?: boolean }) => PwaInstanceListing[];
  /** Test seam — Tailscale probe (for tailnet URL host). */
  probeFn?: () => Promise<TailscaleProbe>;
  /** Output sink. */
  out?: { log: (s: string) => void; error: (s: string) => void };
}

export interface PwaShowResult {
  exitCode: number;
  instance?: PwaInstanceListing;
  urls?: {
    loopback: string;
    tailnet?: string;
  };
}

export async function runPwaShow(opts: PwaShowOpts = {}): Promise<PwaShowResult> {
  const out = opts.out ?? console;
  const cwd = opts.cwd ?? process.cwd();
  const listFn = opts.listFn ?? listPwaInstances;
  const probeFn = opts.probeFn ?? (() => probeTailscale());
  const format = opts.format ?? 'human';

  // Prune so the matched entry's `alive` flag reflects current truth.
  const instances = listFn({ prune: true });
  const match = instances.find((e) => e.cwd === cwd);

  if (!match) {
    if (format === 'json') {
      out.log(JSON.stringify({ instance: null, cwd }, null, 2));
      return { exitCode: 0 };
    }
    out.log(`No PWA daemon registered for this project.`);
    out.log(`  cwd: ${cwd}`);
    out.log('');
    out.log('Bring one up:');
    out.log('  elanous nexus run --hmr');
    out.log('Other instances on this host:');
    out.log('  elanous nexus pwa global status');
    return { exitCode: 0 };
  }

  // Prefer the registry's nexus port; only consult the watch endpoint when it is absent.
  const registryPort = match.ports[0];
  let endpointPort: number | undefined;
  if (registryPort === undefined) {
    try {
      const endpoint = resolveDaemonEndpoint({ purpose: 'watch' });
      endpointPort = endpoint ? Number(new URL(endpoint.baseUrl).port) : undefined;
    } catch { /* No usable daemon address. */ }
  }
  const httpPort = registryPort ?? endpointPort;
  if (httpPort === undefined || !Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65_535) {
    const message = '데몬 주소를 모른다 — `elanous nexus run` 먼저';
    if (format === 'json') out.log(JSON.stringify({ instance: match, urls: null, reason: message }, null, 2));
    else out.log(message);
    return { exitCode: 1, instance: match };
  }
  debug.log('nexus.pwa-share', 'port-resolved', { port: httpPort, source: registryPort === undefined ? 'endpoint' : 'bound' });
  const loopback = `http://127.0.0.1:${httpPort}/app/`;
  let tailnet: string | undefined;
  if (match.shareMounted) {
    try {
      const probe = await probeFn();
      const host = probe.magicDnsHost ?? probe.hostname ?? probe.ips?.[0];
      if (probe.installed && probe.alive && host) {
        tailnet = `https://${host}:${httpPort}/app/`;
      }
    } catch { /* probe failure — tailnet URL stays undefined */ }
  }

  if (format === 'json') {
    out.log(JSON.stringify({
      instance: match,
      urls: { loopback, ...(tailnet ? { tailnet } : {}) },
    }, null, 2));
    return {
      exitCode: 0,
      instance: match,
      urls: { loopback, ...(tailnet ? { tailnet } : {}) },
    };
  }

  const aliveTag = match.alive ? '✓ alive' : '✗ stale (pid dead)';
  out.log(`PWA daemon for this project — ${aliveTag}`);
  out.log('');
  out.log(`  pid       ${match.pid}`);
  out.log(`  mode      ${match.mode}${match.kind === 'test' ? ' (test)' : ''}`);
  out.log(`  ports     ${match.ports.join(', ')}`);
  out.log(`  cwd       ${match.cwd}`);
  out.log(`  daemonDir ${match.daemonDir}`);
  const shareStr = match.shareMounted
    ? (match.https ? 'on (--https · ad-hoc · config 비저장)' : 'on (share enable)')
    : 'off';
  out.log(`  share     ${shareStr}`);
  out.log(`  started   ${match.startedAt}`);
  out.log('');
  out.log('URLs:');
  out.log(`  local     ${loopback}`);
  if (tailnet) {
    out.log(`  tailnet   ${tailnet}`);
  } else if (match.shareMounted) {
    out.log('  tailnet   (Tailscale unreachable — re-run when ts is up)');
  } else {
    out.log('  tailnet   (off · `elanous nexus pwa share enable` to expose)');
  }

  return {
    exitCode: 0,
    instance: match,
    urls: { loopback, ...(tailnet ? { tailnet } : {}) },
  };
}

// Suppress unused-import lint when this file is re-exported.
export const PWA_SHOW_INTERNAL_REGISTRY_HINT = join(homedir(), '.elanous', 'pwa-registry.json');
