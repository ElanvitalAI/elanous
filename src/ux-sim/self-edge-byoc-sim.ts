import { isIP } from 'node:net';
import { createFakeCloudVm } from './fake-cloud-vm.js';
import { createFakeSsh } from './fake-ssh.js';

// Source: fake-cloud-vm accepts an hourly rate; this zero-rail simulation does not estimate VM cost.
const UNPRICED_HOURLY_COST = 0;
// Source: fake-ssh requires an observed session count; the blank-VM fixture starts with no sessions.
const EMPTY_SESSION_COUNT = 0;
// Source: fake-ssh requires a positive MaxStartups limit; one slot is enough for this serial bootstrap.
const SERIAL_BOOTSTRAP_LIMIT = 1;

export type SelfEdgeByocBlock = 'ssh-unreachable' | 'host-outside-domain' | 'nameserver-delegation-mismatch' | 'nameserver-target-mismatch' | 'domain-ownership-unverified' | 'dns-challenge-unpublished' | 'certificate-not-issued' | 'home-tunnel-unreachable';

export interface SelfEdgeByocNameserverTarget {
  readonly name: string;
  readonly address: string;
}

export interface SelfEdgeByocAuthorityAnswer {
  readonly nameserver: string;
  readonly responderAddress: string;
  readonly zone: string;
}

export interface SelfEdgeByocInput {
  readonly vmId: string;
  readonly imageDigest: string;
  readonly publicAddress: string;
  readonly ownerId: string;
  readonly domain: string;
  readonly appHost: string;
  readonly registrarNameservers: readonly string[];
  readonly vmAuthoritativeNameservers: readonly string[];
  readonly registrarNameserverTargets: readonly SelfEdgeByocNameserverTarget[];
  readonly authoritativeAnswers: readonly SelfEdgeByocAuthorityAnswer[];
  readonly challengeOwnerId: string;
  readonly challengeDomain: string;
  readonly issuedChallenge: string;
  readonly authoritativeChallenge: string;
  readonly dnsChallengePublished: boolean;
  readonly certificateReady: boolean;
  readonly sshReachable: boolean;
  readonly homeTunnelReachable: boolean;
}

export interface SelfEdgeByocReceipt {
  readonly status: 'ready' | 'blocked';
  readonly block?: SelfEdgeByocBlock;
  readonly controlPlane: readonly string[];
  readonly nameserversVerified: boolean;
  readonly certificateIssued: boolean;
  readonly tunnelEstablished: boolean;
  readonly publicTarget?: string;
  readonly dataPath?: readonly [string, string];
  readonly managedDnsCalls: readonly string[];
  readonly relayRequests: readonly string[];
  readonly externalProviderCalls: readonly string[];
}

function sameNameservers(expected: readonly string[], actual: readonly string[]): boolean {
  const normalize = (values: readonly string[]) => [...new Set(values.map(value => value.trim().toLowerCase()).filter(Boolean))].sort();
  const left = normalize(expected);
  const right = normalize(actual);
  return left.length > 0 && left.length === right.length && left.every((value, index) => value === right[index]);
}

function hostBelongsToDomain(host: string, domain: string): string | null {
  const normalizedDomain = normalizeDnsName(domain);
  const normalizedHost = normalizeDnsName(host);
  if (!normalizedDomain || !normalizedHost || normalizedHost === normalizedDomain) return null;
  return normalizedHost.endsWith(`.${normalizedDomain}`) ? normalizedHost : null;
}

function normalizeDnsName(value: string): string | null {
  const normalized = value.trim().toLowerCase().replace(/\.$/, '');
  // Source: RFC 1035 §2.3.1 — DNS labels use letters, digits, and interior hyphens.
  const validLabel = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
  if (!normalized || normalized.length > 253) return null;
  const labels = normalized.split('.');
  if (labels.some(label => label.length > 63 || !validLabel.test(label))) return null;
  return normalized;
}

function isPublicIpAddress(value: string): boolean {
  const normalized = value.trim();
  if (!normalized || normalized !== value || isIP(normalized) === 0) return false;
  if (isIP(normalized) === 6) {
    const groups = expandIpv6(normalized);
    if (!groups) return false;
    // Source: IANA IPv6 Special-Purpose Address Registry; global unicast is 2000::/3.
    const isGlobalUnicast = groups[0] !== undefined && groups[0] >= 0x2000 && groups[0] <= 0x3fff;
    // Source: IANA IPv6 Special-Purpose Address Registry and RFC 9637 — 2001::/23, 2001:db8::/32, 2002::/16, and 3fff::/20 are excluded.
    const isSpecialPurpose = groups[0] === 0x2001 && ((groups[1] ?? 0) <= 0x01ff || groups[1] === 0x0db8)
      || groups[0] === 0x2002
      || groups[0] === 0x3fff && (groups[1] ?? 0) <= 0x0fff;
    return isGlobalUnicast && !isSpecialPurpose;
  }

  const octets = normalized.split('.').map(Number);
  const [first, second, third] = octets;
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  // Source: IANA IPv4 Special-Purpose Address Registry and RFC 6598 (shared address space).
  if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
  if (first === 100 && second !== undefined && second >= 64 && second <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second !== undefined && second >= 16 && second <= 31) return false;
  if (first === 192 && second === 0 && third === 0) return false;
  if (first === 192 && second === 0 && third === 2) return false;
  if (first === 192 && second === 88 && third === 99) return false;
  if (first === 192 && second === 168) return false;
  if (first === 198 && (second === 18 || second === 19)) return false;
  if (first === 198 && second === 51 && third === 100) return false;
  if (first === 203 && second === 0 && third === 113) return false;
  return true;
}

function expandIpv6(address: string): number[] | null {
  const normalized = address.toLowerCase();
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const parseHalf = (half: string): number[] | null => {
    if (!half) return [];
    const groups = half.split(':').map(group => Number.parseInt(group, 16));
    return groups.every(group => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
  };
  const left = parseHalf(halves[0] ?? '');
  const right = parseHalf(halves[1] ?? '');
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const missingGroups = 8 - left.length - right.length;
  if (missingGroups < 1) return null;
  return [...left, ...Array.from({ length: missingGroups }, () => 0), ...right];
}

function sameDomain(left: string, right: string): boolean {
  return left.trim().toLowerCase().replace(/^\.+|\.+$/g, '') === right.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
}

/**
 * Blank-member-VM control-plane simulation. VM lifecycle and SSH reachability
 * use existing fakes. DNS delegation, ACME readiness, and the home tunnel are
 * modeled as explicit inputs. It does not call a cloud/DNS provider, managed
 * Elanous DNS, an Elanous relay, or the user's cluster.
 */
export function simulateSelfEdgeByoc(input: SelfEdgeByocInput): SelfEdgeByocReceipt {
  const cloud = createFakeCloudVm();
  cloud.createFromImage({ id: input.vmId, imageDigest: input.imageDigest, hourlyCost: UNPRICED_HOURLY_COST });
  const ssh = createFakeSsh({
    hosts: input.sshReachable ? {
      [input.vmId]: { activeSessions: EMPTY_SESSION_COUNT, maxStartups: SERIAL_BOOTSTRAP_LIMIT },
    } : {},
  });
  const controlPlane = ['fake-cloud-vm.createFromImage'];
  const managedDnsCalls: string[] = [];
  const relayRequests: string[] = [];
  const externalProviderCalls: string[] = [];
  let nameserversVerified = false;
  let certificateIssued = false;
  let tunnelEstablished = false;
  const blocked = (block: SelfEdgeByocBlock): SelfEdgeByocReceipt => {
    cloud.stop(input.vmId);
    return {
      status: 'blocked', block, controlPlane, nameserversVerified,
      certificateIssued, tunnelEstablished,
      managedDnsCalls, relayRequests, externalProviderCalls,
    };
  };

  const bootstrap = ssh.ssh(input.vmId, 'configure-authoritative-dns reverse-proxy-acme wireguard-home-tunnel');
  if (bootstrap.rc !== 0) return blocked('ssh-unreachable');
  controlPlane.push('fake-ssh.bootstrap-request');

  const normalizedAppHost = hostBelongsToDomain(input.appHost, input.domain);
  if (!normalizedAppHost) return blocked('host-outside-domain');
  if (!input.ownerId.trim()
      || !input.challengeOwnerId.trim()
      || input.challengeOwnerId !== input.ownerId
      || !sameDomain(input.challengeDomain, input.domain)
      || !input.issuedChallenge
      || input.authoritativeChallenge !== input.issuedChallenge) {
    return blocked('domain-ownership-unverified');
  }
  if (!isPublicIpAddress(input.publicAddress)) {
    return blocked('nameserver-target-mismatch');
  }
  const nameserverNamesMatch = sameNameservers(input.registrarNameservers, input.vmAuthoritativeNameservers)
    && sameNameservers(input.registrarNameservers, input.registrarNameserverTargets.map(target => target.name))
    && sameNameservers(input.registrarNameservers, input.authoritativeAnswers.map(answer => answer.nameserver));
  const addressesTargetMemberVm = input.registrarNameserverTargets.length > 0
    && input.registrarNameserverTargets.every(target => isIP(target.address.trim()) !== 0 && target.address.trim() === input.publicAddress.trim());
  const authorityAnswersComeFromMemberVm = input.authoritativeAnswers.length > 0
    && input.authoritativeAnswers.every(answer => isIP(answer.responderAddress.trim()) !== 0
      && answer.responderAddress.trim() === input.publicAddress.trim() && sameDomain(answer.zone, input.domain));
  if (nameserverNamesMatch && (!addressesTargetMemberVm || !authorityAnswersComeFromMemberVm)) {
    return blocked('nameserver-target-mismatch');
  }
  nameserversVerified = nameserverNamesMatch && addressesTargetMemberVm && authorityAnswersComeFromMemberVm;
  if (!nameserversVerified) return blocked('nameserver-delegation-mismatch');
  if (!input.dnsChallengePublished) return blocked('dns-challenge-unpublished');
  if (!input.certificateReady) return blocked('certificate-not-issued');
  certificateIssued = true;
  if (!input.homeTunnelReachable) return blocked('home-tunnel-unreachable');
  tunnelEstablished = true;

  controlPlane.push('member-authoritative-dns.ns-verified');
  controlPlane.push('member-edge.acme-dns01-certificate-ready');
  controlPlane.push('member-edge.wireguard-home-tunnel-established');
  controlPlane.push('member-edge.host-route-ready');
  return {
    status: 'ready', controlPlane, nameserversVerified: true,
    certificateIssued: true, tunnelEstablished: true,
    publicTarget: input.publicAddress,
    dataPath: [normalizedAppHost, 'member-vm -> WireGuard -> home WSL/Linux k3d'],
    managedDnsCalls, relayRequests, externalProviderCalls,
  };
}
