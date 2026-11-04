import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, hostname, networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { parsePodPool } from './pod-pool.js';

export interface TrafficDispatchSnapshot { global: string; podTarget: number }

export type HostIdentityResolver = (host: string) => string | null;

export interface HostLookupResult { status: number | null; stdout: string; stderr?: string; error?: Error | null }
export type HostLookupRunner = (command: string, args: string[]) => HostLookupResult;

function canonicalNamesFromGetent(stdout: string): string[] {
  return [...new Set(stdout.split(/\r?\n/u).flatMap((line) => {
    const fields = line.trim().split(/\s+/u);
    if (fields.length < 3 || isIP(fields[0] ?? '') === 0) return [];
    const name = cleanHostIdentity(fields.at(-1) ?? '');
    return name && isIP(name) === 0 ? [name] : [];
  }))];
}

function hasConfirmedNoData(stdout: string): boolean {
  if (/\bflags:[^\n]*\baa\b/u.test(stdout)) return true;
  const authority = stdout.split(';; AUTHORITY SECTION:')[1]?.split(';; ADDITIONAL SECTION:')[0] ?? '';
  return authority.split(/\r?\n/u).some((line) => line.trim().split(/\s+/u)[3]?.toUpperCase() === 'SOA');
}

interface DnsAddressResponse { status: 'NOERROR' | 'NXDOMAIN'; addresses: string[]; noData: boolean }

function parseDnsAddressResponse(stdout: string, family: 'A' | 'AAAA'): DnsAddressResponse | null {
  if (/\bstatus: NXDOMAIN\b/u.test(stdout)) return { status: 'NXDOMAIN', addresses: [], noData: false };
  if (!/\bstatus: NOERROR\b/u.test(stdout)) return null;
  const answerCount = Number(stdout.match(/ANSWER:\s*(\d+)/u)?.[1]);
  if (!Number.isSafeInteger(answerCount)) return null;
  const addresses = stdout.split(/\r?\n/u).flatMap((line) => {
    const fields = line.trim().split(/\s+/u);
    if (fields[2] !== 'IN' || fields[3] !== family || isIP(fields[4] ?? '') !== (family === 'A' ? 4 : 6)) return [];
    return [normalizeIdentityAddress(fields[4]!)];
  });
  if ((answerCount === 0) !== (addresses.length === 0)) return null;
  const noData = answerCount === 0;
  if (family === 'AAAA' && noData && !hasConfirmedNoData(stdout)) return null;
  return { status: 'NOERROR', addresses, noData };
}

function sameAddresses(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length && sortedLeft.every((address, index) => address === sortedRight[index]);
}

function hostNamesAgree(left: string, right: string): boolean {
  const a = cleanHostIdentity(left);
  const b = cleanHostIdentity(right);
  return Boolean(a && b && a === b);
}

function parseTailnetIdentities(stdout: string): Array<{ dnsName: string; addresses: string[] }> | null {
  try {
    const root = JSON.parse(stdout) as { Peer?: unknown };
    if (!root || typeof root !== 'object' || !('Peer' in root)) return null;
    if (root.Peer === null || root.Peer === undefined) return [];
    if (typeof root.Peer !== 'object' || Array.isArray(root.Peer)) return null;
    return Object.values(root.Peer as Record<string, unknown>).map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { dnsName: '', addresses: [] };
      const peer = value as { DNSName?: unknown; TailscaleIPs?: unknown };
      const addresses = Array.isArray(peer.TailscaleIPs)
        ? peer.TailscaleIPs.filter((address): address is string => typeof address === 'string' && isIP(address) > 0).map(normalizeIdentityAddress)
        : [];
      return { dnsName: typeof peer.DNSName === 'string' ? cleanHostIdentity(peer.DNSName) ?? '' : '', addresses: [...new Set(addresses)].sort() };
    });
  } catch { return null; }
}

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

/** Resolve this process host from assigned addresses when its OS hostname is not an SSH/DNS name.
 * macOS names such as `MacStudioB1` may be absent from SSH config and DNS while the gate roster
 * names the same machine by its tailnet FQDN. */
export function resolveLocalHostIdentity(host: string, localHostname = hostname(),
  interfaces: NodeJS.Dict<Array<{ address: string; internal: boolean }>> = networkInterfaces()): string | null {
  const identity = cleanHostIdentity(host);
  if (!identity || identity !== cleanHostIdentity(localHostname)) return null;
  const addresses = Object.values(interfaces).flatMap((entries) => entries ?? [])
    .map(({ address, internal }) => ({ address: normalizeIdentityAddress(address), internal }))
    .filter(({ address, internal }) => !internal && isIP(address) > 0
      && address !== '::1' && !address.startsWith('127.') && !address.startsWith('169.254.') && !/^fe[89ab][0-9a-f]:/iu.test(address))
    .map(({ address }) => address);
  return [...new Set(addresses)].sort().join(',') || null;
}

/** Resolve SSH aliases through the effective OpenSSH config without opening a connection. */
export function resolveSshHostIdentity(host: string, run: HostLookupRunner = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 2_000, maxBuffer: 128 * 1024 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error };
}, platform: NodeJS.Platform = process.platform, localHostname = hostname(),
  interfaces: NodeJS.Dict<Array<{ address: string; internal: boolean }>> = networkInterfaces()): string | null {
  const requestedHost = cleanHostIdentity(host);
  if (requestedHost && requestedHost === cleanHostIdentity(localHostname)) {
    return resolveLocalHostIdentity(host, localHostname, interfaces);
  }
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
    const canonicalNames = platform === 'darwin' ? [] : [...new Set(resolved.flatMap((entry) => canonicalNamesFromGetent(entry.stdout)))];
    if (canonicalNames.length > 1) return null;
    // NSS may expand a short SSH hostname through its search suffix. Use that expansion only
    // when it is an unambiguous suffix of the configured short name; a different FQDN must not
    // silently replace a fully qualified SSH HostName during the independent DNS comparison.
    const canonicalName = canonicalNames[0];
    const lookupName = canonicalName && (canonicalName === name
      || (!name.includes('.') && canonicalName.startsWith(`${name}.`))) ? canonicalName : name;
    const lookupNames = lookupName === name ? [name] : [name, lookupName];
    const dnsFamilies: Array<string[] | null> = [];
    let digUnavailable = false;
    let digFailed = false;
    let digCalls = 0;
    if (platform !== 'darwin') for (const family of ['A', 'AAAA'] as const) {
      if (digUnavailable) { dnsFamilies.push(null); continue; }
      // getent may omit an address returned by DNS (or hide a DNS error behind an NSS success).
      // Compare both authorities when dig exists. A missing optional dig binary falls back to
      // the SSH-configured hostname plus NSS addresses; other dig errors still fail closed.
      // When NSS expands a short name, check both that name and the canonical FQDN.
      const responses: DnsAddressResponse[] = [];
      let queryFailed = false;
      for (const queryName of lookupNames) {
        const dns = run('dig', ['+noall', '+comments', '+question', '+answer', '+authority', '+search', family, queryName]);
        if (dns.error && (dns.error as NodeJS.ErrnoException).code === 'ENOENT') {
          if (digCalls === 0) digUnavailable = true;
          else digFailed = true;
          queryFailed = true;
          break;
        }
        digCalls += 1;
        const response = dns.status === 0 && !dns.error ? parseDnsAddressResponse(dns.stdout, family) : null;
        if (!response) {
          digFailed = true;
          queryFailed = true;
          break;
        }
        responses.push(response);
      }
      if (digUnavailable) { dnsFamilies.push(null); continue; }
      if (queryFailed) { dnsFamilies.push(null); continue; }
      const canonicalResponse = responses.at(-1);
      if (!canonicalResponse) { digFailed = true; dnsFamilies.push(null); continue; }
      if (responses.length === 2) {
        const originalResponse = responses[0]!;
        const aliasAaaaNxdomain = family === 'AAAA' && originalResponse.status === 'NXDOMAIN'
          && canonicalResponse.status === 'NOERROR' && canonicalResponse.noData;
        const originalMatchesCanonical = originalResponse.status === 'NOERROR' && canonicalResponse.status === 'NOERROR'
          && sameAddresses(originalResponse.addresses, canonicalResponse.addresses);
        if (!aliasAaaaNxdomain && !originalMatchesCanonical) {
          digFailed = true;
          dnsFamilies.push(null);
          continue;
        }
      } else if (canonicalResponse.status !== 'NOERROR') {
        digFailed = true;
        dnsFamilies.push(null);
        continue;
      }
      dnsFamilies.push(canonicalResponse.addresses);
    }
    if (digFailed || (!digUnavailable && dnsFamilies.some((family) => family === null))) return null;
    const noIpv6Records = platform !== 'darwin' && resolved[1]?.status === 2
      && !resolved[1]?.error && resolved[1]?.stdout.trim() === '' && !resolved[1]?.stderr?.trim()
      && (digUnavailable || dnsFamilies[1]?.length === 0);
    if (resolved.some((entry, index) => entry.error || entry.status !== 0 && !(index === 1 && noIpv6Records))) return null;
    const addresses = [...new Set(resolved.flatMap((entry) => platform === 'darwin'
      ? [...entry.stdout.matchAll(/^ip_address:\s*(\S+)\s*$/gmu)].map((match) => match[1]!)
      : entry.stdout.split(/\r?\n/u).map((line) => line.trim().split(/\s+/u)[0] ?? ''))
      .filter((address) => isIP(address) > 0).map(normalizeIdentityAddress))].sort();
    if (!addresses.length) return null;
    if (platform !== 'darwin' && !digUnavailable) {
      const dnsAddresses = [...new Set(dnsFamilies.flatMap((family) => family ?? []))].sort();
      if (!sameAddresses(addresses, dnsAddresses)) return null;
    }
    if (platform !== 'darwin' && digUnavailable) {
      const shortNameExpandedByNss = Boolean(canonicalName && !name.includes('.') && canonicalName.startsWith(`${name}.`));
      const sshAndGetentAgree = Boolean(canonicalName && (hostNamesAgree(name, canonicalName) || shortNameExpandedByNss));
      if (!sshAndGetentAgree) return null;
      const tailnet = run('tailscale', ['status', '--json']);
      if (tailnet.status === 0 && !tailnet.error) {
        const peers = parseTailnetIdentities(tailnet.stdout);
        if (!peers) return null;
        const candidates = peers.filter((peer) => [host, name, lookupName, canonicalName ?? ''].some((candidate) => candidate && hostNamesAgree(peer.dnsName, candidate)));
        if (candidates.length > 1) return null;
        const peer = candidates[0];
        const shortInputs = [host, name].map(cleanHostIdentity).filter((candidate): candidate is string => Boolean(candidate && !candidate.includes('.')));
        const ambiguousShortPeer = peers.some((candidate) => shortInputs.includes(candidate.dnsName.split('.')[0] ?? '')
          && candidate.dnsName !== canonicalName && candidate.dnsName !== name);
        if (ambiguousShortPeer) return null;
        if (peer && (peer.addresses.length === 0 || !sameAddresses(addresses, peer.addresses))) return null;
        if (shortNameExpandedByNss && (!peer || peer.dnsName !== canonicalName)) return null;
      } else if (shortNameExpandedByNss) {
        return null;
      }
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
