// Registered remote els hosts: <state>/els/hosts.json, edited by a person (no code writes it).
// A base URL must be a tailnet name (.ts.net / .tailnet), a tailnet address (100.64.0.0/10) or loopback; anything on the
// public internet is dropped and named in `rejected`.

import { lookup } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';

export interface FederatedHost {
  readonly name: string;
  /** tailnet origin, e.g. http://node-b.tail1234.ts.net:8790 (for a herdr host: the marker `herdr:`, never fetched) */
  readonly baseUrl: string;
  /** `herdr` = the herdr panes of this machine, answered by `src/els/herdr-host.ts` instead of an HTTP read window. */
  readonly kind?: 'herdr';
  /** Explicit, pinned operator transport for remote update-all. Read-only federation does not need this. */
  readonly update?: { readonly sshTarget: string; readonly knownHostsFile: string; readonly catchUpSeat: 'OP' | 'TC' | 'MK' | 'UX'; readonly bin?: string;
    readonly home?: string; readonly stateRoot?: string; readonly cwd?: string };
}

export interface HostRegistry {
  readonly hosts: readonly FederatedHost[];
  /** Entries left out, each with why (public URL, bad name, duplicate). */
  readonly rejected: readonly string[];
  /** Set when hosts.json exists but cannot be read or parsed: the registry is then empty. */
  readonly problem?: string;
}

export function elsHostsPath(stateRoot: string): string {
  return join(stateRoot, 'els', 'hosts.json');
}

const HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

/** Is `hostname` loopback or inside the tailnet (CGNAT 100.64.0.0/10, tailnet DNS names)? */
export function isTailnetOrLoopback(hostname: string): boolean {
  const name = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (name === 'localhost' || name === '127.0.0.1' || name === '::1') return true;
  if (name.endsWith('.ts.net') || name.endsWith('.tailnet')) return true;
  const octets = name.split('.').map(Number);
  // 출처: Tailscale assigns IPv4 addresses from the CGNAT range 100.64.0.0/10 (second octet 64–127).
  return octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    && octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127;
}

function tailnetOrigin(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return isTailnetOrLoopback(url.hostname) ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function updateTransport(raw: unknown, baseUrl: string): FederatedHost['update'] | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'update transport is not an object';
  const row = raw as Record<string, unknown>;
  const target = row.sshTarget;
  const known = row.knownHostsFile;
  if (!['OP', 'TC', 'MK', 'UX'].includes(String(row.catchUpSeat))) return 'update catchUpSeat must be OP, TC, MK or UX';
  if (typeof target !== 'string' || !/^[a-z_][a-z0-9_-]*@[A-Za-z0-9._-]+$/i.test(target)) return 'update sshTarget must be user@host';
  const targetHost = target.slice(target.indexOf('@') + 1).toLowerCase();
  if (targetHost !== new URL(baseUrl).hostname.toLowerCase()) return 'update SSH HostName differs from registered URL host';
  if (typeof known !== 'string' || !known.startsWith('/')) return 'update knownHostsFile must be absolute';
  if (/[\s%\0]/.test(known)) return 'update knownHostsFile must be one single literal file';
  for (const key of ['bin', 'home', 'stateRoot', 'cwd']) if (row[key] !== undefined
    && (typeof row[key] !== 'string' || !(row[key] as string).startsWith('/') || /[\r\n\0]/.test(row[key] as string)))
    return `update ${key} must be absolute`;
  return { sshTarget: target, knownHostsFile: known, catchUpSeat: row.catchUpSeat as 'OP' | 'TC' | 'MK' | 'UX',
    ...(typeof row.bin === 'string' ? { bin: row.bin } : {}),
    ...(typeof row.home === 'string' ? { home: row.home } : {}),
    ...(typeof row.stateRoot === 'string' ? { stateRoot: row.stateRoot } : {}),
    ...(typeof row.cwd === 'string' ? { cwd: row.cwd } : {}) };
}

export function loadHostRegistry(path: string): HostRegistry {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { hosts: [], rejected: [] };
    return { hosts: [], rejected: [], problem: `els hosts: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (error) {
    return { hosts: [], rejected: [], problem: `els hosts: ${path} is not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const rows = raw && typeof raw === 'object' && Array.isArray((raw as { hosts?: unknown }).hosts) ? (raw as { hosts: unknown[] }).hosts : undefined;
  if (!rows) return { hosts: [], rejected: [], problem: `els hosts: ${path} has no hosts array` };
  const hosts: FederatedHost[] = [];
  const rejected: string[] = [];
  rows.forEach((row, index) => {
    const entry = row && typeof row === 'object' ? row as { name?: unknown; baseUrl?: unknown } : {};
    const name = typeof entry.name === 'string' ? entry.name : '';
    const baseUrl = typeof entry.baseUrl === 'string' ? tailnetOrigin(entry.baseUrl) : undefined;
    if (!HOST_NAME.test(name)) rejected.push(`hosts[${index}]: bad name`);
    else if (!baseUrl) rejected.push(`${name}: baseUrl is not a tailnet or loopback http(s) URL`);
    else if (hosts.some((host) => host.name === name)) rejected.push(`${name}: duplicate name`);
    else {
      const update = (row as { update?: unknown }).update === undefined ? undefined : updateTransport((row as { update?: unknown }).update, baseUrl);
      if (typeof update === 'string') rejected.push(`${name}: ${update}`);
      else hosts.push({ name, baseUrl, ...(update ? { update } : {}) });
    }
  });
  return { hosts, rejected };
}

/** Bind the effect to the registry snapshot used for the pane listing; a changed entry revokes this run. */
export function registeredHostAtExecution(path: string, listed: HostRegistry, name: string): FederatedHost {
  const current = loadHostRegistry(path);
  if (listed.problem || listed.rejected.length || current.problem || current.rejected.length
    || JSON.stringify(current.hosts) !== JSON.stringify(listed.hosts))
    throw new Error('els host registry changed after listing');
  const host = listed.hosts.find(row => row.name === name);
  if (!host) throw new Error('registered host missing from listing snapshot');
  return host;
}

/**
 * GET `path` on a registered host, read-only. The host name must resolve to a loopback or tailnet address (a tailnet
 * DNS name that resolves elsewhere is refused), and redirects are refused (a host must not send the request on).
 * Residual: the name is resolved again by the connection itself; a DNS answer that changes between the two is not
 * caught here (the tailnet's MagicDNS is the resolver the hosts use).
 */
export async function fetchHostJson(host: FederatedHost, path: string, timeoutMs: number, post?: unknown): Promise<{ status: number; body: unknown }> {
  const url = new URL(path, host.baseUrl);
  const name = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(name) ? [name] : (await lookup(name, { all: true })).map((entry) => entry.address);
  const outside = addresses.find((address) => !isTailnetOrLoopback(address));
  if (outside !== undefined || addresses[0] === undefined) throw new Error(`${name} resolves to ${outside ?? 'nothing'}, not a tailnet or loopback address`);
  const response = await fetch(url, post === undefined
    ? { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' }
    : { method: 'POST', body: JSON.stringify(post), headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
  if (response.status >= 300 && response.status < 400) throw new Error(`redirect refused (http ${response.status})`);
  let body: unknown;
  try { body = await response.json(); } catch { body = undefined; }
  return { status: response.status, body };
}
