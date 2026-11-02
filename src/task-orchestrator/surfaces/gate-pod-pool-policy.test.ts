import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { excludeGatePoolHosts, excludeGatePoolMembers, readTrafficDispatchSnapshot, resolveSshHostIdentity, type HostIdentityResolver, type TrafficDispatchSnapshot } from './gate-pod-pool-policy.js';

const gateTraffic: TrafficDispatchSnapshot = { global: 'gate', podTarget: 0 };
const hostIdentity: HostIdentityResolver = (host) => {
  const value = host.split('@').at(-1)!.toLowerCase().replace(/\.$/, '');
  return ({ 'gate-node': '10.0.0.1', 'gate-alias': '10.0.0.1', 'gate-node.example.com': '10.0.0.1', '10.0.0.1': '10.0.0.1', 'aux-node': '10.0.0.2', gcp1: '10.0.0.3' } as Record<string, string>)[value] ?? value;
};

describe('release gate pool exclusivity for harness Pod dispatch', () => {
  test('gate mode with podTarget zero removes gate hosts and places the task on gcp1', () => {
    const pool = excludeGatePoolMembers('pool-gate-node@gate-node:46,pool-gcp1@gcp1:12',
      'pool-gate-node@gate-node:4,pool-aux-node@aux-node:3', gateTraffic, undefined, hostIdentity);
    expect(pool).toEqual({ active: true, pool: 'pool-gcp1@gcp1:12', gateHosts: ['gate-node', 'aux-node'] });

    const parents = excludeGatePoolHosts([
      { host: 'gate-node', cwd: '/repo' }, { host: 'aux-node', cwd: '/repo' }, { host: 'gcp1', cwd: '/repo' },
    ], 'pool-gate-node@gate-node:4,pool-aux-node@aux-node:3', gateTraffic, undefined, hostIdentity);
    expect(parents.targets.map(({ host }) => host)).toEqual(['gcp1']);
  });

  test('all gate traffic reserves gate hosts regardless of podTarget', () => {
    const gateTrafficWithPods: TrafficDispatchSnapshot = { global: 'gate', podTarget: 4 };
    expect(excludeGatePoolMembers('pool-gate-node@gate-node:4,pool-gcp@gcp1:8', 'pool-gate@gate-node:4', gateTrafficWithPods, undefined, hostIdentity))
      .toEqual({ active: true, pool: 'pool-gcp@gcp1:8', gateHosts: ['gate-node'] });
    expect(excludeGatePoolHosts([{ host: 'gate-node', cwd: '/repo' }, { host: 'gcp1', cwd: '/repo' }],
      'pool-gate@gate-node:4', gateTrafficWithPods, undefined, hostIdentity).targets.map(({ host }) => host)).toEqual(['gcp1']);
  });

  test('non-gate traffic retains the configured Pod pool', () => {
    expect(excludeGatePoolMembers('pool-gate-node@gate-node:46,pool-gcp1@gcp1:12', 'pool-gate-node@gate-node:4',
      { global: 'green', podTarget: 18 }, undefined, hostIdentity)).toEqual({ active: false, pool: 'pool-gate-node@gate-node:46,pool-gcp1@gcp1:12' });
  });

  test('missing gate roster or no non-gate host blocks dispatch instead of using the gate pool', () => {
    expect(excludeGatePoolMembers('pool-gate-node@gate-node:46', undefined, gateTraffic, undefined, hostIdentity)).toMatchObject({ active: true, reason: 'release-gate-pool-missing' });
    expect(excludeGatePoolMembers('pool-gate-node@gate-node:46', 'pool-gate-node@gate-node:4', gateTraffic, undefined, hostIdentity)).toMatchObject({ active: true, reason: 'task-pod-pool-has-no-host-outside-release-gate-pool' });
    expect(excludeGatePoolHosts([{ host: 'gate-node', cwd: '/repo' }], 'pool-gate-node@gate-node:4', gateTraffic, undefined, hostIdentity)).toMatchObject({ active: true, reason: 'no-parent-host-outside-release-gate-pool' });
  });

  test('malformed task pool fails closed and still reports the parsed reserved hosts', () => {
    expect(excludeGatePoolMembers('not a valid pool', 'pool-gate-node@gate-node:4,pool-aux-node@aux-node:3', gateTraffic, undefined, hostIdentity))
      .toEqual({ active: true, gateHosts: ['gate-node', 'aux-node'], reason: 'task-pod-pool-invalid' });
  });

  test('identity resolver is not passed Array.map index as its runner argument', () => {
    const calls: string[] = [];
    const resolver = ((host: string, runner?: unknown) => {
      if (runner !== undefined) return null;
      calls.push(host);
      return host === 'node-b' || host === 'node-c' ? host : 'gcp1';
    }) as HostIdentityResolver;
    expect(excludeGatePoolMembers('pool-gcp@gcp1:12', 'pool-node-b@node-b:4,pool-node-c@node-c:3', gateTraffic, undefined, resolver))
      .toMatchObject({ active: true, pool: 'pool-gcp@gcp1:12' });
    expect(excludeGatePoolHosts([{ host: 'gcp1', cwd: '/repo' }], 'pool-node-b@node-b:4,pool-node-c@node-c:3', gateTraffic, undefined, resolver))
      .toMatchObject({ active: true, targets: [{ host: 'gcp1', cwd: '/repo' }] });
    expect(calls).toEqual(['node-b', 'node-c', 'gcp1', 'node-b', 'node-c', 'gcp1']);
  });

  test('SSH aliases and IP literals for one configured host are excluded as the same gate host', () => {
    const pool = excludeGatePoolMembers('pool-alias@gate-alias:4,pool-fqdn@gate-node.example.com:4,pool-ip@10.0.0.1:4,pool-gcp@gcp1:12',
      'pool-gate@gate-node:4', gateTraffic, undefined, hostIdentity);
    expect(pool).toEqual({ active: true, pool: 'pool-gcp@gcp1:12', gateHosts: ['gate-node'] });
    const parents = excludeGatePoolHosts([{ host: 'gate-alias', cwd: '/repo' }, { host: 'gcp1', cwd: '/repo' }],
      'pool-gate@gate-node:4', gateTraffic, undefined, hostIdentity);
    expect(parents.targets.map(({ host }) => host)).toEqual(['gcp1']);
  });

  test('expanded and compressed IPv6 identities are treated as the same reserved host', () => {
    const identities: HostIdentityResolver = (host) => ({
      gate: '2001:db8::1',
      'gate-expanded': '2001:0db8:0000:0000:0000:0000:0000:0001',
      outside: '2001:db8::2',
    } as Record<string, string>)[host] ?? null;
    const pool = excludeGatePoolMembers('pool-gate@gate-expanded:4,pool-outside@outside:8',
      'pool-reserved@gate:4', gateTraffic, undefined, identities);
    expect(pool).toEqual({ active: true, pool: 'pool-outside@outside:8', gateHosts: ['gate'] });

    const parents = excludeGatePoolHosts([{ host: 'gate-expanded', cwd: '/repo' }, { host: 'outside', cwd: '/repo' }],
      'pool-reserved@gate:4', gateTraffic, undefined, identities);
    expect(parents.targets.map(({ host }) => host)).toEqual(['outside']);
  });

  test('IPv4-mapped IPv6 identities are treated as the same reserved IPv4 host', () => {
    const identities: HostIdentityResolver = (host) => ({
      gate: '192.0.2.1',
      'mapped-expanded': '::ffff:192.0.2.1',
      'mapped-hex': '::ffff:c000:201',
      outside: '192.0.2.2',
    } as Record<string, string>)[host] ?? null;
    const pool = excludeGatePoolMembers('pool-mapped@mapped-hex:4,pool-outside@outside:8',
      'pool-reserved@gate:4', gateTraffic, undefined, identities);
    expect(pool).toEqual({ active: true, pool: 'pool-outside@outside:8', gateHosts: ['gate'] });

    const parents = excludeGatePoolHosts([{ host: 'mapped-expanded', cwd: '/repo' }, { host: 'outside', cwd: '/repo' }],
      'pool-reserved@gate:4', gateTraffic, undefined, identities);
    expect(parents.targets.map(({ host }) => host)).toEqual(['outside']);
  });

  test('unknown traffic keeps reserved hosts filtered, while unreadable identities block dispatch', () => {
    expect(excludeGatePoolMembers('pool-gate-node@gate-node:4,pool-gcp@gcp1:12', 'pool-gate@gate-node:4', null, undefined, hostIdentity))
      .toEqual({ active: true, pool: 'pool-gcp@gcp1:12', gateHosts: ['gate-node'] });
    expect(excludeGatePoolHosts([{ host: 'gate-node', cwd: '/repo' }, { host: 'gcp1', cwd: '/repo' }],
      'pool-gate@gate-node:4', gateTraffic, undefined, () => null))
      .toMatchObject({ active: true, targets: [], reason: 'host-identity-unavailable' });
    expect(readTrafficDispatchSnapshot({ ELANOUS_TRAFFIC_SIGNAL: '/path/that/does/not/exist' })).toBeNull();
  });

  test('unknown global traffic values are unreadable and therefore fail closed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-pool-traffic-'));
    const path = join(dir, 'traffic.json');
    try {
      writeFileSync(path, JSON.stringify({ global: 'gatre', podTarget: 0 }));
      expect(readTrafficDispatchSnapshot({ ELANOUS_TRAFFIC_SIGNAL: path })).toBeNull();
      expect(excludeGatePoolMembers('pool-gate-node@gate-node:4,pool-gcp@gcp1:12', 'pool-gate@gate-node:4',
        readTrafficDispatchSnapshot({ ELANOUS_TRAFFIC_SIGNAL: path }), undefined, hostIdentity))
        .toEqual({ active: true, pool: 'pool-gcp@gcp1:12', gateHosts: ['gate-node'] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('Linux SSH host identity merges IPv4 and IPv6 DNS results', () => {
    const calls: string[] = [];
    const run = (command: string, args: string[]) => {
      calls.push(`${command} ${args.join(' ')}`);
      if (command === 'ssh') return { status: 0, stdout: 'hostname dual.example\n' };
      if (args[0] === 'ahosts') return { status: 0, stdout: '192.0.2.10 STREAM dual.example\n' };
      if (args[0] === 'ahostsv6') return { status: 0, stdout: '2001:db8::10 STREAM dual.example\n' };
      if (command === 'dig') return { status: 0, stdout: args.includes('A')
        ? ';; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 1\n;; flags: qr rd ra; QUERY: 1, ANSWER: 1\ndual.example. 60 IN A 192.0.2.10\n'
        : ';; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 2\n;; flags: qr rd ra; QUERY: 1, ANSWER: 1\ndual.example. 60 IN AAAA 2001:db8::10\n' };
      return { status: 1, stdout: '' };
    };
    expect(resolveSshHostIdentity('alias', run, 'linux')).toBe('192.0.2.10,2001:db8::10');
    expect(calls).toEqual(['ssh -G alias', 'getent ahosts dual.example', 'getent ahostsv6 dual.example',
      'dig +noall +comments +question +answer A dual.example', 'dig +noall +comments +question +answer AAAA dual.example']);
  });

  test('Linux SSH host identity fails closed when successful getent lookups disagree with DNS or DNS fails', () => {
    for (const dnsFailure of [false, true]) {
      const run = (command: string, args: string[]) => {
        if (command === 'ssh') return { status: 0, stdout: 'hostname mismatch.example\n' };
        if (args[0] === 'ahosts') return { status: 0, stdout: '192.0.2.10 STREAM mismatch.example\n' };
        if (args[0] === 'ahostsv6') return { status: 0, stdout: '2001:db8::10 STREAM mismatch.example\n' };
        if (command === 'dig') {
          if (dnsFailure && args.includes('A')) return { status: 0, stdout: ';; ->>HEADER<<- opcode: QUERY, status: SERVFAIL, id: 3\n;; flags: qr rd; QUERY: 1, ANSWER: 0\n' };
          return { status: 0, stdout: args.includes('A')
            ? `;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 4\n;; flags: qr rd ra; QUERY: 1, ANSWER: ${dnsFailure ? 1 : 2}\nmismatch.example. 60 IN A 192.0.2.10\n${dnsFailure ? '' : 'mismatch.example. 60 IN A 192.0.2.99\n'}`
            : ';; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 5\n;; flags: qr rd ra; QUERY: 1, ANSWER: 1\nmismatch.example. 60 IN AAAA 2001:db8::10\n' };
        }
        return { status: 1, stdout: '' };
      };
      expect(resolveSshHostIdentity('alias', run, 'linux')).toBeNull();
    }
  });

  test('Linux SSH host identity fails closed when either address family cannot be resolved', () => {
    const run = (command: string, args: string[]) => {
      if (command === 'ssh') return { status: 0, stdout: 'hostname dual.example\n' };
      return args[0] === 'ahosts'
        ? { status: 0, stdout: '192.0.2.10 STREAM dual.example\n' }
        : { status: 1, stdout: '' };
    };
    expect(resolveSshHostIdentity('alias', run, 'linux')).toBeNull();
  });

  test('Linux SSH host identity accepts an address family with no records when the other family resolves', () => {
    const run = (command: string, args: string[]) => {
      if (command === 'ssh') return { status: 0, stdout: 'hostname ipv4-only.example\n' };
      if (command === 'dig') return { status: 0, stdout: args.includes('A')
        ? ';; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 7\n;; flags: qr rd ra; QUERY: 1, ANSWER: 1\nipv4-only.example. 60 IN A 192.0.2.11\n'
        : ';; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 8\n;; flags: qr rd ra; QUERY: 1, ANSWER: 0\n' };
      return args[0] === 'ahosts'
        ? { status: 0, stdout: '192.0.2.11 STREAM ipv4-only.example\n' }
        : { status: 2, stdout: '' };
    };
    expect(resolveSshHostIdentity('alias', run, 'linux')).toBe('192.0.2.11');
  });

  test('Linux SSH host identity fails closed when an empty getent result is backed by a DNS error', () => {
    const run = (command: string, args: string[]) => {
      if (command === 'ssh') return { status: 0, stdout: 'hostname unstable.example\n' };
      if (command === 'dig') return { status: 0, stdout: ';; ->>HEADER<<- opcode: QUERY, status: SERVFAIL, id: 8\n;; flags: qr rd; QUERY: 1, ANSWER: 0\n' };
      return args[0] === 'ahosts'
        ? { status: 0, stdout: '192.0.2.12 STREAM unstable.example\n' }
        : { status: 2, stdout: '' };
    };
    expect(resolveSshHostIdentity('alias', run, 'linux')).toBeNull();
  });

  test('Linux SSH host identity fails closed when DNS has an address missing from system lookup', () => {
    const run = (command: string, args: string[]) => {
      if (command === 'ssh') return { status: 0, stdout: 'hostname inconsistent.example\n' };
      if (command === 'dig') return { status: 0, stdout: args.includes('A')
        ? ';; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 9\n;; flags: qr rd ra; QUERY: 1, ANSWER: 1\ninconsistent.example. 60 IN A 192.0.2.13\n'
        : ';; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 10\n;; flags: qr rd ra; QUERY: 1, ANSWER: 1\ninconsistent.example. 60 IN AAAA 2001:db8::12\n' };
      return args[0] === 'ahosts'
        ? { status: 0, stdout: '192.0.2.13 STREAM inconsistent.example\n' }
        : { status: 2, stdout: '' };
    };
    expect(resolveSshHostIdentity('alias', run, 'linux')).toBeNull();
  });
});
