import { resolve as resolvePath } from 'node:path';
import { listPwaInstances } from '../cli/pwa-registry.js';
import { nexusRootDir } from './paths.js';
import { findNexusLifecycleState, type NexusLifecycleState } from './supervisor/lock.js';
import { debug } from '../debug/log.js';
import type { NexusPwaLinkSource, NexusPwaResolution, NexusShowUrls, ResolveNexusPwaOpts } from '../cli/pwa-show-contract.js';

/** Wildcard bind addresses are not client addresses; normalize them to loopback. */
export function toLoopbackUrl(url: string | undefined): string | undefined {
  return url?.replace(/^(https?:\/\/)(?:0\.0\.0\.0|\[::\])(?=[:/]|$)/, '$1127.0.0.1');
}

function urlBase(pwaUrl: string): string { return pwaUrl.replace(/\/app\/?$/, ''); }

export function deriveNexusShowUrls(pwaUrls: { loopback: string; tailnet?: string }): NexusShowUrls {
  const loopbackBase = urlBase(pwaUrls.loopback);
  const tailnetBase = pwaUrls.tailnet ? urlBase(pwaUrls.tailnet) : undefined;
  return {
    pwa: { loopback: pwaUrls.loopback, ...(pwaUrls.tailnet ? { tailnet: pwaUrls.tailnet } : {}) },
    rest: { loopback: `${loopbackBase}/v1/`, ...(tailnetBase ? { tailnet: `${tailnetBase}/v1/` } : {}) },
    sse: { loopback: `${loopbackBase}/v1/events`, ...(tailnetBase ? { tailnet: `${tailnetBase}/v1/events` } : {}) },
  };
}

function isValidHttpHost(host: string): boolean {
  if (/^\[([0-9A-Fa-f:.]+)\]$/.test(host)) return true;
  if (/^[0-9.]+$/.test(host)) {
    const octets = host.split('.');
    return octets.length === 4 && octets.every((octet) => /^(0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255);
  }
  return host.length <= 253 && host.split('.').every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}

function isCurrentLifecycleRoot(lifecycleRoot: string, currentRoot: string): boolean {
  const resolvedLifecycleRoot = resolvePath(lifecycleRoot);
  const resolvedCurrentRoot = resolvePath(currentRoot);
  return resolvedLifecycleRoot === resolvedCurrentRoot || resolvePath(resolvedLifecycleRoot, 'nexus') === resolvedCurrentRoot;
}

export function resolveNexusPwa(opts: ResolveNexusPwaOpts = {}): NexusPwaResolution {
  const cwd = opts.cwd ?? process.cwd();
  const pwaResult = opts.pwaResult;
  let registered: { loopback: string } | undefined;
  try {
    registered = pwaResult
      ? pwaResult.instance && pwaResult.urls ? { loopback: pwaResult.urls.loopback } : undefined
      : (() => {
          const instance = (opts.listFn ?? listPwaInstances)({ prune: true }).find((entry) => entry.cwd === cwd);
          const port = instance?.ports[0];
          return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65_535
            ? { loopback: `http://127.0.0.1:${port}/app/` } : undefined;
        })();
  } catch { return { status: 'absent', reason: 'pwa-query-failed' }; }
  const lifecycle = (opts.lifecycleFn ?? findNexusLifecycleState)();
  const currentRoot = (opts.nexusRootFn ?? nexusRootDir)();
  const currentLifecycle = lifecycle && isCurrentLifecycleRoot(lifecycle.root, currentRoot) ? lifecycle : undefined;
  const lifecycleUrl = currentLifecycle && lifecyclePwaUrl(currentLifecycle);
  const loopback = toLoopbackUrl(registered?.loopback ?? lifecycleUrl?.loopback);
  if (!loopback) {
    if (!currentLifecycle) return { status: 'absent', reason: 'daemon-absent' };
    return { status: 'unregistered', reason: 'pwa-url-unknown', pid: currentLifecycle.lock.pid };
  }
  const sameRuntimeInstance = !registered || registered.loopback === lifecycleUrl?.loopback;
  const recordedTailnet = sameRuntimeInstance ? lifecycleUrl?.tailnet : undefined;
  const liveTailnet = registered && pwaResult ? parseTailnetPwaUrl(pwaResult.urls?.tailnet) : undefined;
  const tailnet = recordedTailnet ?? liveTailnet;
  const source: NexusPwaLinkSource = tailnet ? 'tailnet' : 'local';
  const url = tailnet ?? loopback;
  const tailnetRecordedAt = recordedTailnet ? lifecycleUrl?.tailnetRecordedAt : undefined;
  debug.log('nexus.pwa-link', 'resolved', { source, status: registered ? 'registered' : 'unregistered', ...(tailnetRecordedAt ? { tailnetRecordedAt } : {}) });
  if (registered) return { status: 'registered', loopback, url, source, ...(tailnetRecordedAt ? { tailnetRecordedAt } : {}) };
  return { status: 'unregistered', loopback, url, pid: currentLifecycle!.lock.pid, source, ...(tailnetRecordedAt ? { tailnetRecordedAt } : {}) };
}

function lifecyclePwaUrl(lifecycle: NexusLifecycleState): { loopback: string; tailnet?: string; tailnetRecordedAt?: string } | undefined {
  const runtime = lifecycle.runtime;
  const urls = lifecycleHttpUrls(lifecycle);
  if (!runtime || runtime.pid !== lifecycle.lock.pid || !urls) return undefined;
  const tailnet = parseTailnetPwaUrl(runtime.tailnetUrl);
  const tailnetRecordedAt = parseIsoTimestamp(runtime.tailnetRecordedAt);
  return { loopback: urls.pwa.loopback, ...(tailnet ? { tailnet } : {}), ...(tailnet && tailnetRecordedAt ? { tailnetRecordedAt } : {}) };
}

function parseTailnetPwaUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/app/' && !url.search && !url.hash ? url.toString() : undefined;
  } catch { return undefined; }
}

function parseIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || Number.isNaN(Date.parse(value))) return undefined;
  const [, year, month, day] = match;
  const probe = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return probe.getUTCFullYear() === Number(year) && probe.getUTCMonth() === Number(month) - 1 && probe.getUTCDate() === Number(day) ? value : undefined;
}

function lifecycleHttpUrls(lifecycle: NexusLifecycleState): NexusShowUrls | undefined {
  const runtime = lifecycle.runtime;
  const httpPort = runtime?.httpPort;
  if (!runtime || runtime.pid !== lifecycle.lock.pid || typeof httpPort !== 'number' || !Number.isInteger(httpPort)
    || httpPort < 1 || httpPort > 65_535 || typeof runtime.httpHost !== 'string') return undefined;
  const host = runtime.httpHost.trim();
  const bracketedIpv6 = host.startsWith('[');
  if (!isValidHttpHost(host)) return undefined;
  try {
    const url = new URL(`http://${host}:${httpPort}/app/`);
    const hostnameMatches = bracketedIpv6 ? /^\[[0-9a-f:.]+\]$/i.test(url.hostname) : url.hostname.toLowerCase() === host.toLowerCase();
    const portMatches = url.port === String(httpPort) || (httpPort === 80 && url.port === '');
    if (url.username || url.password || url.pathname !== '/app/' || url.search || url.hash || !hostnameMatches || !portMatches) return undefined;
    return deriveNexusShowUrls({ loopback: url.toString() });
  } catch { return undefined; }
}
