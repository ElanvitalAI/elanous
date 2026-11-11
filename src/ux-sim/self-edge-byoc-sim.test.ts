import { describe, expect, test } from 'bun:test';
import { simulateSelfEdgeByoc, type SelfEdgeByocInput } from './self-edge-byoc-sim.js';

// Source: Google's public DNS service publishes this globally routable IPv4 address.
const MEMBER_VM_ADDRESS = '8.8.8.8';

const validInput: SelfEdgeByocInput = {
  vmId: 'member-edge',
  imageDigest: 'sha256:blank-os-image',
  publicAddress: MEMBER_VM_ADDRESS,
  ownerId: 'member-owner',
  domain: 'apps.example.test',
  appHost: 'notes.apps.example.test',
  registrarNameservers: ['ns1.member.example.test', 'ns2.member.example.test'],
  vmAuthoritativeNameservers: ['ns1.member.example.test', 'ns2.member.example.test'],
  registrarNameserverTargets: [
    { name: 'ns1.member.example.test', address: MEMBER_VM_ADDRESS },
    { name: 'ns2.member.example.test', address: MEMBER_VM_ADDRESS },
  ],
  authoritativeAnswers: [
    { nameserver: 'ns1.member.example.test', responderAddress: MEMBER_VM_ADDRESS, zone: 'apps.example.test' },
    { nameserver: 'ns2.member.example.test', responderAddress: MEMBER_VM_ADDRESS, zone: 'apps.example.test' },
  ],
  challengeOwnerId: 'member-owner',
  challengeDomain: 'apps.example.test',
  issuedChallenge: 'server-issued-member-domain-challenge',
  authoritativeChallenge: 'server-issued-member-domain-challenge',
  dnsChallengePublished: true,
  certificateReady: true,
  sshReachable: true,
  homeTunnelReachable: true,
};

describe('SELF-EDGE-BYOC blank VM zero-rail simulation', () => {
  test('serves through the member VM and home tunnel after delegation, ACME, and WireGuard are ready', () => {
    const receipt = simulateSelfEdgeByoc(validInput);
    expect(receipt.status).toBe('ready');
    expect(receipt.nameserversVerified).toBe(true);
    expect(receipt.certificateIssued).toBe(true);
    expect(receipt.tunnelEstablished).toBe(true);
    expect(receipt.publicTarget).toBe(validInput.publicAddress);
    expect(receipt.dataPath).toEqual([validInput.appHost, 'member-vm -> WireGuard -> home WSL/Linux k3d']);
    expect(receipt.managedDnsCalls).toEqual([]);
    expect(receipt.relayRequests).toEqual([]);
    expect(receipt.externalProviderCalls).toEqual([]);
  });

  test('fails closed before TLS when registrar delegation differs from the VM authority', () => {
    const receipt = simulateSelfEdgeByoc({ ...validInput, registrarNameservers: ['ns-elsewhere.example.test'] });
    expect(receipt.status).toBe('blocked');
    expect(receipt.block).toBe('nameserver-delegation-mismatch');
    expect(receipt.certificateIssued).toBe(false);
    expect(receipt.tunnelEstablished).toBe(false);
  });

  test('requires the server TXT challenge to bind the requesting owner and normalized domain', () => {
    const receipt = simulateSelfEdgeByoc({ ...validInput, challengeOwnerId: 'another-member' });
    expect(receipt.status).toBe('blocked');
    expect(receipt.block).toBe('domain-ownership-unverified');
    expect(receipt.certificateIssued).toBe(false);
    expect(receipt.publicTarget).toBeUndefined();
  });

  test('rejects an empty owner even when the TXT challenge owner is also empty', () => {
    const receipt = simulateSelfEdgeByoc({ ...validInput, ownerId: '', challengeOwnerId: '' });
    expect(receipt.status).toBe('blocked');
    expect(receipt.block).toBe('domain-ownership-unverified');
    expect(receipt.publicTarget).toBeUndefined();
  });

  test('rejects matching NS names that resolve away from the member VM', () => {
    const receipt = simulateSelfEdgeByoc({
      ...validInput,
      registrarNameserverTargets: validInput.registrarNameserverTargets.map(target => ({ ...target, address: 'third-party-address' })),
    });
    expect(receipt.status).toBe('blocked');
    expect(receipt.block).toBe('nameserver-target-mismatch');
    expect(receipt.nameserversVerified).toBe(false);
    expect(receipt.publicTarget).toBeUndefined();
  });

  test('rejects blank member VM and authoritative response addresses', () => {
    const receipt = simulateSelfEdgeByoc({
      ...validInput,
      publicAddress: '',
      registrarNameserverTargets: validInput.registrarNameserverTargets.map(target => ({ ...target, address: '' })),
      authoritativeAnswers: validInput.authoritativeAnswers.map(answer => ({ ...answer, responderAddress: '' })),
    });
    expect(receipt.status).toBe('blocked');
    expect(receipt.block).toBe('nameserver-target-mismatch');
    expect(receipt.nameserversVerified).toBe(false);
    expect(receipt.publicTarget).toBeUndefined();
  });

  test('rejects a member VM address with surrounding whitespace before publishing a route', () => {
    const receipt = simulateSelfEdgeByoc({ ...validInput, publicAddress: ` ${MEMBER_VM_ADDRESS} ` });
    expect(receipt.status).toBe('blocked');
    expect(receipt.block).toBe('nameserver-target-mismatch');
    expect(receipt.publicTarget).toBeUndefined();
  });

  test('rejects a loopback target even when nameservers and authoritative answers agree', () => {
    const receipt = simulateSelfEdgeByoc({
      ...validInput,
      publicAddress: '127.0.0.1',
      registrarNameserverTargets: validInput.registrarNameserverTargets.map(target => ({ ...target, address: '127.0.0.1' })),
      authoritativeAnswers: validInput.authoritativeAnswers.map(answer => ({ ...answer, responderAddress: '127.0.0.1' })),
    });
    expect(receipt.status).toBe('blocked');
    expect(receipt.block).toBe('nameserver-target-mismatch');
    expect(receipt.publicTarget).toBeUndefined();
  });

  test('rejects compressed documentation IPv6 even when every DNS answer agrees', () => {
    const receipt = simulateSelfEdgeByoc({
      ...validInput,
      publicAddress: '2001:0db8::1',
      registrarNameserverTargets: validInput.registrarNameserverTargets.map(target => ({ ...target, address: '2001:0db8::1' })),
      authoritativeAnswers: validInput.authoritativeAnswers.map(answer => ({ ...answer, responderAddress: '2001:0db8::1' })),
    });
    expect(receipt.status).toBe('blocked');
    expect(receipt.block).toBe('nameserver-target-mismatch');
    expect(receipt.publicTarget).toBeUndefined();
  });

  test('rejects the documentation IPv6 prefix even when every DNS answer agrees', () => {
    const receipt = simulateSelfEdgeByoc({
      ...validInput,
      publicAddress: '3fff::1',
      registrarNameserverTargets: validInput.registrarNameserverTargets.map(target => ({ ...target, address: '3fff::1' })),
      authoritativeAnswers: validInput.authoritativeAnswers.map(answer => ({ ...answer, responderAddress: '3fff::1' })),
    });
    expect(receipt.status).toBe('blocked');
    expect(receipt.block).toBe('nameserver-target-mismatch');
    expect(receipt.publicTarget).toBeUndefined();
  });

  test('refuses a host outside the delegated owner domain', () => {
    const receipt = simulateSelfEdgeByoc({ ...validInput, appHost: 'notes.other.example.test' });
    expect(receipt.status).toBe('blocked');
    expect(receipt.block).toBe('host-outside-domain');
  });

  test('rejects malformed DNS labels and publishes only the normalized host', () => {
    const malformed = simulateSelfEdgeByoc({ ...validInput, appHost: 'bad..apps.example.test' });
    expect(malformed.status).toBe('blocked');
    expect(malformed.block).toBe('host-outside-domain');

    const normalized = simulateSelfEdgeByoc({ ...validInput, appHost: ' Notes.Apps.Example.Test. ' });
    expect(normalized.status).toBe('ready');
    expect(normalized.dataPath?.[0]).toBe('notes.apps.example.test');
  });

  test('does not publish an edge route when the DNS-01 challenge is absent', () => {
    const receipt = simulateSelfEdgeByoc({ ...validInput, dnsChallengePublished: false });
    expect(receipt.status).toBe('blocked');
    expect(receipt.block).toBe('dns-challenge-unpublished');
    expect(receipt.publicTarget).toBeUndefined();
  });

  test('does not publish an edge route when automatic TLS issuance is not ready', () => {
    const receipt = simulateSelfEdgeByoc({ ...validInput, certificateReady: false });
    expect(receipt.status).toBe('blocked');
    expect(receipt.block).toBe('certificate-not-issued');
    expect(receipt.publicTarget).toBeUndefined();
  });

  test('does not claim a live route while the home tunnel is unreachable', () => {
    const receipt = simulateSelfEdgeByoc({ ...validInput, homeTunnelReachable: false });
    expect(receipt.status).toBe('blocked');
    expect(receipt.block).toBe('home-tunnel-unreachable');
    expect(receipt.certificateIssued).toBe(true);
    expect(receipt.tunnelEstablished).toBe(false);
  });

  test('keeps an empty VM unreachable when its SSH bootstrap transport is unavailable', () => {
    const receipt = simulateSelfEdgeByoc({ ...validInput, sshReachable: false });
    expect(receipt.status).toBe('blocked');
    expect(receipt.block).toBe('ssh-unreachable');
    expect(receipt.controlPlane).toEqual(['fake-cloud-vm.createFromImage']);
  });
});
