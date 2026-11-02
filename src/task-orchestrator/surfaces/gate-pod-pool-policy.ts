import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, hostname } from 'node:os';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { parsePodPool } from './pod-pool.js';

export interface TrafficDispatchSnapshot { global: string; podTarget: number }

export type HostIdentityResolver = (host: string) => string | null;

export interface HostLookupResult { status: number | null; stdout: string; stderr?: string; error?: Error | null }
export type HostLookupRunner = (command: string, args: string[]) => HostLookupResult;

function normalizeIdentityAddress(address: string): string {
  const value = address.trim().replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (isIP(value) === 6) {
    try {
      const normalized = new URL(`http://[${value}]/`).hostname.slice(1, -1);
      const mapped = normalized.match(/^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/u);
      if (mapped) {
        const high = Number.parseInt(mapped[1]!, 16);
        const low = Number.parseInt(mapped[2]!, 16);
        return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
      }
      return normalized;
    }
    catch { return value; }
  }
  return value;
}

function cleanHostIdentity(host: string): string | null {
  const value = host.trim().replace(/^[^@]+@/, '').replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const normalized = isIP(value) > 0 ? normalizeIdentityAddress(value) : value;
  return normalized && !normalized.startsWith('-') && !/[\s/]/.test(normalized) ? normalized : null;
}

/** Resolve SSH aliases through the effective OpenSSH config without opening a connection. */
export function resolveSshHostIdentity(host: string, run: HostLookupRunner = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 2_000, maxBuffer: 128 * 1024 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error };
}, platform: NodeJS.Platform = process.platform): string | null {
  const fallback = cleanHostIdentity(host);
  if (!fallback || fallback.length > 255) return null;
  try {
    const result = run('ssh', ['-G', host]);
    if (result.status !== 0 || result.error) return null;
    const configured = result.stdout.split(/\r?\n/u).find((line) => line.startsWith('hostname '))?.slice('hostname '.length).trim();
    const name = configured ? cleanHostIdentity(configured) : null;
    if (!name) return null;
    if (isIP(name)) return name;
    const resolved = platform === 'darwin'
      ? [run('dscacheutil', ['-q', 'host', '-a', 'name', name])]
      : [run('getent', ['ahosts', name]), run('getent', ['ahostsv6', name])];
    const dnsFamilies = platform === 'darwin' ? [] : (['A', 'AAAA'] as const).map((family) => {
      // getent may omit an address returned by DNS (or hide a DNS error behind an NSS success).
      // Compare both authorities on every Linux lookup; any disagreement is ambiguous identity.
      const dns = run('dig', ['+noall', '+comments', '+question', '+answer', family, name]);
      if (dns.status !== 0 || dns.error || !/status: NOERROR\b/u.test(dns.stdout)) return null;
      const answerCount = Number(dns.stdout.match(/ANSWER:\s*(\d+)/u)?.[1]);
      if (!Number.isSafeInteger(answerCount)) return null;
      const addresses = dns.stdout.split(/\r?\n/u).flatMap((line) => {
        const fields = line.trim().split(/\s+/u);
        if (fields[2] !== 'IN' || fields[3] !== family || isIP(fields[4] ?? '') !== (family === 'A' ? 4 : 6)) return [];
        return [normalizeIdentityAddress(fields[4]!)];
      });
      if ((answerCount === 0) !== (addresses.length === 0)) return null;
      return addresses;
    });
    if (dnsFamilies.some((family) => family === null)) return null;
    const noIpv6Records = platform !== 'darwin' && resolved[1]?.status === 2
      && !resolved[1].error && resolved[1].stdout.trim() === '' && !resolved[1].stderr?.trim()
      && dnsFamilies[1]?.length === 0;
    if (resolved.some((entry, index) => entry.error || entry.status !== 0 && !(index === 1 && noIpv6Records))) return null;
    const addresses = [...new Set(resolved.flatMap((entry) => platform === 'darwin'
      ? [...entry.stdout.matchAll(/^ip_address:\s*(\S+)\s*$/gmu)].map((match) => match[1]!)
      : entry.stdout.split(/\r?\n/u).map((line) => line.trim().split(/\s+/u)[0] ?? ''))
      .filter((address) => isIP(address) > 0).map(normalizeIdentityAddress))].sort();
    if (!addresses.length) return null;
    if (platform !== 'darwin') {
      const dnsAddresses = [...new Set(dnsFamilies.flatMap((family) => family ?? []))].sort();
      if (addresses.length !== dnsAddresses.length || addresses.some((address, index) => address !== dnsAddresses[index])) return null;
    }
    return addresses.join(',');
  } catch { return null; }
}

function filterRequired(traffic: TrafficDispatchSnapshot | null): boolean {
  // A missing/unreadable signal cannot prove that the gate is off. Keep its hosts reserved until the signal is readable.
  return traffic === null || releaseGateTrafficActive(traffic);
}

function identitiesOverlap(left: string, right: string): boolean {
  const rightAddresses = new Set(right.split(',').map(normalizeIdentityAddress));
  return left.split(',').some((address) => rightAddresses.has(normalizeIdentityAddress(address)));
}

export function readTrafficDispatchSnapshot(env: NodeJS.ProcessEnv = process.env): TrafficDispatchSnapshot | null {
  const path = env.ELANOUS_TRAFFIC_SIGNAL || join(homedir(), 'elanous-hq', 'seat-state', 'OP', 'traffic.json');
  try {
    if (!existsSync(path)) return null;
    const value = JSON.parse(readFileSync(path, 'utf8')) as { global?: unknown; podTarget?: unknown };
    return (value.global === 'green' || value.global === 'gate') && typeof value.podTarget === 'number' && Number.isSafeInteger(value.podTarget)
      ? { global: value.global, podTarget: value.podTarget as number } : null;
  } catch { return null; }
}

export function releaseGateTrafficActive(traffic: TrafficDispatchSnapshot | null): traffic is TrafficDispatchSnapshot & { global: 'gate' } {
  return traffic?.global === 'gate';
}

export type GatePoolFilter<T> = { active: false; targets: T[] } | { active: true; targets: T[]; gateHosts: string[]; reason?: string };

function gateHostsFromSpec(gatePool: string | undefined, localHost: string): { hosts: string[]; reason?: string } {
  if (!gatePool?.trim()) return { hosts: [], reason: 'release-gate-pool-missing' };
  try {
    const hosts = [...new Set(parsePodPool(gatePool).map((member) => member.sshHost ?? localHost))];
    return hosts.length ? { hosts } : { hosts, reason: 'release-gate-pool-empty' };
  } catch { return { hosts: [], reason: 'release-gate-pool-invalid' }; }
}

/** Exclude every host that the release gate reserves; malformed or empty gate rosters fail closed. */
export function excludeGatePoolHosts<T extends { host: string }>(targets: readonly T[], gatePool: string | undefined,
  traffic: TrafficDispatchSnapshot | null, localHost = hostname(), resolveIdentity: HostIdentityResolver = resolveSshHostIdentity): GatePoolFilter<T> {
  if (!filterRequired(traffic)) return { active: false, targets: [...targets] };
  const roster = gateHostsFromSpec(gatePool, localHost);
  const gateHosts = roster.hosts;
  if (roster.reason) return { active: true, targets: [], gateHosts, reason: roster.reason };
  const gateIdentities = gateHosts.map((host) => resolveIdentity(host));
  const targetIdentities = targets.map((target) => resolveIdentity(target.host));
  if (gateIdentities.some((identity) => !identity) || targetIdentities.some((identity) => !identity)) {
    return { active: true, targets: [], gateHosts, reason: 'host-identity-unavailable' };
  }
  const eligible = targets.filter((_target, index) => !gateIdentities.some((identity) => identitiesOverlap(identity!, targetIdentities[index]!)));
  return eligible.length
    ? { active: true, targets: eligible, gateHosts }
    : { active: true, targets: [], gateHosts, reason: 'no-parent-host-outside-release-gate-pool' };
}

/** Keep original pool tokens and capacities while removing the gate's SSH hosts. */
export function excludeGatePoolMembers(pool: string | undefined, gatePool: string | undefined,
  traffic: TrafficDispatchSnapshot | null, localHost = hostname(), resolveIdentity: HostIdentityResolver = resolveSshHostIdentity): { active: false; pool?: string } | { active: true; pool?: string; gateHosts: string[]; reason?: string } {
  if (!filterRequired(traffic)) return { active: false, ...(pool ? { pool } : {}) };
  if (!pool?.trim()) return { active: true, gateHosts: [], reason: 'task-pod-pool-missing' };
  const roster = gateHostsFromSpec(gatePool, localHost);
  if (roster.reason) return { active: true, gateHosts: roster.hosts, reason: roster.reason };
  let members: ReturnType<typeof parsePodPool>;
  try { members = parsePodPool(pool); }
  catch { return { active: true, gateHosts: roster.hosts, reason: 'task-pod-pool-invalid' }; }
  const gateIdentities = roster.hosts.map((host) => resolveIdentity(host));
  const memberIdentities = members.map((member) => resolveIdentity(member.sshHost ?? localHost));
  if (gateIdentities.some((identity) => !identity) || memberIdentities.some((identity) => !identity)) {
    return { active: true, gateHosts: roster.hosts, reason: 'host-identity-unavailable' };
  }
  const tokens = pool.split(',').map((token) => token.trim());
  const kept = members.flatMap((_member, index) => gateIdentities.some((identity) => identitiesOverlap(identity!, memberIdentities[index]!)) ? [] : [tokens[index]!]);
  return kept.length
    ? { active: true, pool: kept.join(','), gateHosts: roster.hosts }
    : { active: true, gateHosts: roster.hosts, reason: 'task-pod-pool-has-no-host-outside-release-gate-pool' };
}
