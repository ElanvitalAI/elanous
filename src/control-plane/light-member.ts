import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { assertJoinedMachineId, readMachineProfile } from '../roles/machine-profile.js';
import { RESOURCE_KINDS, type ResourceKind } from './ledger.js';
import { measureLoad } from './member.js';
import { resolvePrimary } from './primary.js';

const DEFAULT_INTERVAL_MS = 30_000;
const MAX_RETRY_MS = 300_000;
const TTL_MS = 600_000;

export interface LightResource {
  kind: ResourceKind;
  name: string;
  url: string;
}

export interface LightMemberOptions {
  resources: LightResource[];
  intervalMs?: number;
  fetch?: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;
  probe?: (url: string, signal: AbortSignal) => Promise<boolean>;
  now?: () => number;
  signal?: AbortSignal;
  once?: boolean;
  root?: string;
}

export interface LightMemberResult {
  machine: string;
  resources: Array<LightResource & { reachable: boolean; bind: 'loopback' | 'tailnet' | 'other' }>;
}

function bindFor(url: URL): 'loopback' | 'tailnet' | 'other' {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)) return 'loopback';
  // URL canonicalizes IPv6 literals; Tailscale allocates addresses from fd7a:115c:a1e0::/48.
  if (/^fd7a:115c:a1e0:/.test(host)) return 'tailnet';
  const octets = host.split('.');
  const parts = octets.map(Number);
  if (parts.length === 4 && parts.every((part, index) => /^(0|[1-9]\d{0,2})$/.test(octets[index]!) && part <= 255) &&
      parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127) return 'tailnet';
  return 'other';
}

function resourceUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid resource URL');
  return url;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Run a joined, machine-scoped member without starting Nexus. `once` returns after one successful registration tick. */
export async function runLightMember(opts: LightMemberOptions): Promise<LightMemberResult> {
  const primary = resolvePrimary({ role: 'member', root: opts.root ?? effectiveInstanceRoot() });
  if (primary.source !== 'join' || !primary.machine || !primary.token) throw new Error('missing machine join');
  const machine = primary.machine;
  const token = primary.token;
  const root = opts.root ?? effectiveInstanceRoot();
  const configured = readMachineProfile(root);
  if (configured) assertJoinedMachineId(configured.id, root);
  const machineAttrs = () => {
    const profile = readMachineProfile(root);
    if (profile && profile.id !== machine) {
      throw new Error(`machine id ${profile.id} differs from joined machine ${machine}`);
    }
    return { load: measureLoad(now), ...(profile ? { duties: profile.duties, seats: profile.seats } : {}) };
  };
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (!Number.isFinite(interval) || interval <= 0 || interval > MAX_RETRY_MS) throw new Error('invalid member heartbeat interval');
  const send = opts.fetch ?? globalThis.fetch;
  const probe = opts.probe ?? (async (url: string, signal: AbortSignal) => {
    const response = await globalThis.fetch(url, { method: 'GET', signal });
    try { return response.ok; } finally { await response.body?.cancel(); }
  });
  const now = opts.now ?? Date.now;
  const signal = opts.signal ?? new AbortController().signal;
  const declarations = opts.resources.map(resource => {
    if (!RESOURCE_KINDS.includes(resource.kind) || resource.kind === 'machine' || resource.kind === 'port-lease' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(resource.name)) throw new Error('invalid member resource');
    const url = resourceUrl(resource.url);
    return { ...resource, url: url.href, bind: bindFor(url), id: `${resource.kind}:${machine}:${resource.name}` };
  });
  if (new Set(declarations.map(resource => resource.id)).size !== declarations.length) throw new Error('duplicate member resource');
  const registered = new Set<string>();
  const machineId = `machine:${machine}`;
  let failures = 0;
  let lastFailure: string | undefined;
  let lastResult: LightMemberResult = { machine, resources: [] };

  const post = async (id: string, body: unknown): Promise<void> => {
    const path = registered.has(id) ? `/v1/resources/${encodeURIComponent(id)}/heartbeat` : '/v1/resources/register';
    let response: Response;
    try {
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
      response = await Promise.race([
        send(new URL(path, primary.url), {
          method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body), signal: requestSignal,
        }),
        new Promise<never>((_, reject) => requestSignal.addEventListener('abort', () => reject(new Error('network-or-timeout')), { once: true })),
      ]);
    } catch { throw new Error('network-or-timeout'); }
    if (!response.ok) {
      if (response.status === 404 && registered.has(id)) registered.delete(id);
      throw new Error(`http-${response.status}`);
    }
    registered.add(id);
  };

  while (!signal.aborted) {
    const resources: LightMemberResult['resources'] = [];
    try {
      const attrs = machineAttrs();
      await post(machineId, registered.has(machineId) ? { attrs } : {
        id: machineId, kind: 'machine', machine, name: machine, owner: '',
        attrs, observedAt: now(), ttlMs: TTL_MS,
      });
      for (const resource of declarations) {
        if (signal.aborted) break;
        let reachable = false;
        try {
          const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(2_000)]);
          reachable = await Promise.race([
            probe(resource.url, probeSignal),
            new Promise<false>(resolve => probeSignal.addEventListener('abort', () => resolve(false), { once: true })),
          ]);
        } catch { /* A failed probe is an observed unreachable resource, not a deletion. */ }
        const { id, bind, ...declaration } = resource;
        resources.push({ ...declaration, reachable, bind });
        await post(id, registered.has(id) ? { attrs: { reachable, bind } } : {
          id, kind: resource.kind, name: resource.name, machine, owner: '', endpoint: resource.url,
          attrs: { reachable, bind }, observedAt: now(), ttlMs: TTL_MS,
        });
      }
      if (signal.aborted) break;
      lastResult = { machine, resources };
      failures = 0;
      lastFailure = undefined;
      if (opts.once) return lastResult;
      await wait(interval, signal);
    } catch (error) {
      if (signal.aborted) break;
      if (!registered.has(machineId)) registered.clear();
      const reason = error instanceof Error ? error.message : 'unknown';
      if (reason !== lastFailure) {
        try { debug.log('control.light-member', 'heartbeat-failed', { reason }); } catch { /* best effort */ }
      }
      lastFailure = reason;
      failures++;
      if (opts.once) throw new Error(reason);
      await wait(Math.min(MAX_RETRY_MS, Math.min(interval, DEFAULT_INTERVAL_MS) * 2 ** Math.min(failures - 1, 20)), signal);
    }
  }
  return lastResult;
}
