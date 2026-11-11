import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { debug } from '../debug/log.js';
import { LogStore, StoreSink } from '../mss/logging/log-store.js';
import { getTestStateRoot } from '../nexus/paths.js';
import { assembleWarmPoolProviderConfig, fetchMachinePoolDeclarationsFromNexus } from '../../scripts/warm-pool-provider-config.js';
import { issueMemberToken, MEMBER_TOKEN_TTL_MS, revokeMemberToken } from '../control-plane/member-tokens.js';
import type { MachinePoolDeclaration } from '../resource-ledger/machine-pool-inventory.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../elanous-config-dir.js';
import { createNexusState } from '../nexus/state/state.js';
import { TabRegistry } from '../nexus/state/tab-registry.js';
import { NexusEventBus } from '../nexus/api/event-bus.js';
import { routeRequest, type NexusHttpServerOpts } from '../nexus/api/http-server.js';
import { createDevProxyRuntimeRef } from '../nexus/api/admin-dev-proxy.js';
import { createFakePrimaryControl, runWarmPoolReuseSimulation, simulateWarmPoolMachineLossRecovery, type WarmPoolReuseFault } from './warm-pool-reuse-sim.js';
import { simulateWarmPoolTtlRotation } from './warm-pool-reuse-sim.js';
import { withSimClock } from './fake-clock.js';

test('warm provider reaches the Nexus machine-pool route and fails closed on the control endpoint 404', async () => {
  const configRoot = mkdtempSync(join(tmpdir(), 'warm-pool-resource-ledger-route-'));
  setElanousConfigDir(configRoot);
  const token = issueMemberToken('node-b');
  const state = createNexusState({ nexusVersion: 'sim', phase: 'test' });
  const eventBus = new NexusEventBus();
  state.bus = eventBus;
  const opts = { state, registry: new TabRegistry(state), eventBus, allowInsecureResourceLedgerLoopbackForTests: true } as NexusHttpServerOpts;
  const server = { requestIP: (request: Request) => ({ address: new URL(request.url).hostname === '100.64.0.10' ? '100.64.0.20' : '127.0.0.1' }) } as never;
  const devProxy = createDevProxyRuntimeRef();
  const tailnetValidation = { readTailnetAddresses: () => ['100.64.0.10'] };
  const simulatedFetch: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    if (new URL(request.url).hostname === 'warm-control.test') return new Response('Not Found', { status: 404 });
    return await routeRequest(request, opts, server, null, devProxy) ?? new Response('Not Found', { status: 404 });
  }, { preconnect: fetch.preconnect, resourceLedgerUrlValidationForTest: tailnetValidation });
  try {
    const pools = await fetchMachinePoolDeclarationsFromNexus('http://100.64.0.10:8413/v1/resource-ledger/pools', token, simulatedFetch);
    expect(pools).toEqual([]);
    await expect(fetchMachinePoolDeclarationsFromNexus('https://warm-control.test/v1/resource-ledger/pools', token, simulatedFetch))
      .rejects.toThrow('Nexus resource-ledger request failed: HTTP 404');
    await expect(fetchMachinePoolDeclarationsFromNexus('http://100.64.0.10:8413/v1/resource-ledger/pools', 'invalid-token', simulatedFetch))
      .rejects.toThrow('Nexus resource-ledger request failed: HTTP 401');
    revokeMemberToken('node-b');
    await expect(fetchMachinePoolDeclarationsFromNexus('http://100.64.0.10:8413/v1/resource-ledger/pools', token, simulatedFetch))
      .rejects.toThrow('Nexus resource-ledger request failed: HTTP 401');
  } finally {
    resetElanousConfigDir();
    rmSync(configRoot, { recursive: true, force: true });
  }
});

test('RESOURCE-LEDGER-PUBLIC-AUTH sim: public HTTPS reads are host-scoped and fail closed on HTTP, expiry, legacy, and revocation', async () => {
  await withSimClock(Date.parse('2026-11-09T00:00:00.000Z'), async clock => {
    const configRoot = mkdtempSync(join(tmpdir(), 'warm-pool-machine-token-ttl-'));
    setElanousConfigDir(configRoot);
    mkdirSync(join(configRoot, 'logs'), { recursive: true });
    const logStore = new LogStore(join(configRoot, 'logs', 'logs.db'), { instance: 'test:machine-token-ttl' });
    const logSink = new StoreSink(logStore, 'ux-sim:machine-token-ttl', { installExitHandlers: false });
    const unregisterLogSink = debug.registerSink(logSink);
    const machine = 'host-a';
    const otherMachine = 'host-b';
    const token = issueMemberToken(machine);
    const otherToken = issueMemberToken(otherMachine);
    const tokenStore = join(configRoot, 'control', 'member-tokens.json');
    const saved = JSON.parse(readFileSync(tokenStore, 'utf8')) as Record<string, { sha256: string; issuedAt: string; expiresAt: string }>;
    const expiresAt = Date.parse(saved[machine]!.expiresAt);
    const state = createNexusState({ nexusVersion: 'sim', phase: 'test' });
    const eventBus = new NexusEventBus();
    state.bus = eventBus;
    const opts = { state, registry: new TabRegistry(state), eventBus } as NexusHttpServerOpts;
    const server = { requestIP: () => ({ address: '198.51.100.42' }) } as never;
    const url = 'https://nexus.example:8413/v1/resource-ledger/pools';
    const pool = (host: string): MachinePoolDeclaration => ({ purpose: 'gate', fanoutGroupId: `gate-${host}`,
      members: [{ host, count: 1, digest: `sha256:${'b'.repeat(64)}`, role: 'both' }],
      fanoutGroup: { shard: { kind: 'gate', input: 'gate-shard', result: 'gate-receipt', fingerprint: 'gate-v1' } },
      fingerprint: { runtime: 'bun-v1', environment: 'linux', skillPacks: [] },
      cleanup: { procedure: 'clean-v1', verify: 'verify-v1' } });
    const machinePool = pool(machine);
    const otherMachinePool = pool(otherMachine);
    const pools = [machinePool, otherMachinePool];
    mkdirSync(join(configRoot, 'resource-ledger'), { recursive: true });
    writeFileSync(join(configRoot, 'resource-ledger', 'events.jsonl'), pools.map((value, index) =>
      JSON.stringify({ event: 'pool-declared', at: `2026-11-08T00:00:0${index}.000Z`, pool: value })).join('\n') + '\n');
    const tailnetValidation = { readTailnetAddresses: () => [] };
    const simulatedFetch: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      await routeRequest(new Request(input, init), opts, server, null, createDevProxyRuntimeRef())
        ?? new Response('Not Found', { status: 404 }),
    { preconnect: fetch.preconnect, resourceLedgerUrlValidationForTest: tailnetValidation });
    try {
      expect(expiresAt - Date.parse(saved[machine]!.issuedAt)).toBe(MEMBER_TOKEN_TTL_MS);
      clock.setTime(expiresAt - 1);
      const ownPools = await fetchMachinePoolDeclarationsFromNexus(url, token, simulatedFetch);
      expect(ownPools).toEqual([machinePool]);
      expect(await fetchMachinePoolDeclarationsFromNexus(url, otherToken, simulatedFetch)).toEqual([otherMachinePool]);

      const cleartext = await simulatedFetch(url.replace('https:', 'http:'), { headers: { authorization: `Bearer ${token}` } });
      expect(cleartext.status).toBe(403);
      expect(await cleartext.json()).toEqual({ error: 'secure-transport-required' });

      const loopbackProxy = { requestIP: () => ({ address: '127.0.0.1' }) } as never;
      const forwardedPlaintext = await routeRequest(new Request('http://127.0.0.1:8413/v1/resource-ledger/pools', {
        headers: { host: 'public.example', authorization: `Bearer ${token}` },
      }), opts, loopbackProxy, null, createDevProxyRuntimeRef());
      expect(forwardedPlaintext?.status).toBe(403);
      expect(await forwardedPlaintext?.json()).toEqual({ error: 'secure-transport-required' });
      const localOnly = await routeRequest(new Request('http://127.0.0.1:8413/v1/resource-ledger/pools', {
        headers: { host: '127.0.0.1:8413', authorization: `Bearer ${token}` },
      }), { ...opts, allowInsecureResourceLedgerLoopbackForTests: true }, loopbackProxy, null, createDevProxyRuntimeRef());
      expect(localOnly?.status).toBe(200);

      clock.setTime(expiresAt);
      const expired = await simulatedFetch(url, { headers: { authorization: `Bearer ${token}` } });
      expect(expired.status).toBe(401);
      expect(await expired.json()).toEqual({ error: 'unauthorized' });
      await expect(fetchMachinePoolDeclarationsFromNexus(url, token, simulatedFetch))
        .rejects.toThrow('Nexus resource-ledger request failed: HTTP 401');

      const legacy = JSON.parse(readFileSync(tokenStore, 'utf8')) as Record<string, Record<string, unknown>>;
      delete legacy[machine]!.expiresAt;
      writeFileSync(tokenStore, JSON.stringify(legacy));
      expect((await simulatedFetch(url, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
      const replacement = issueMemberToken(machine);
      revokeMemberToken(machine);
      expect((await simulatedFetch(url, { headers: { authorization: `Bearer ${replacement}` } })).status).toBe(401);
      logSink.flush();
      const authLogs = logStore.queryAll({ exactCategories: ['resource-ledger.auth'] });
      const refused = authLogs.filter(row => row.event === 'request-refused').map(row => JSON.parse(row.data ?? '{}'));
      expect(refused.some(row => row.reason === 'secure-transport-required')).toBe(true);
      expect(refused.map(row => row.reason)).toContain('unauthorized');
      expect(authLogs.map(row => row.data ?? '').join('\n')).not.toContain(token);
      expect(authLogs.map(row => row.data ?? '').join('\n')).not.toContain(otherToken);
    } finally {
      unregisterLogSink();
      logSink.flush();
      logSink.close();
      logStore.close();
      resetElanousConfigDir();
      rmSync(configRoot, { recursive: true, force: true });
    }
  });
});

test('five local and tailnet hosts build providers from only their own shared-ledger pool', async () => {
  const configRoot = mkdtempSync(join(tmpdir(), 'warm-pool-five-host-ledger-'));
  setElanousConfigDir(configRoot);
  const hosts = ['node-c', 'minim5', 'mshq', 'aws1', 'aws2'] as const;
  const digest = `sha256:${'b'.repeat(64)}`;
  const tokens = Object.fromEntries(hosts.map(host => [host, issueMemberToken(host)]));
  const pools: MachinePoolDeclaration[] = hosts.map((host): MachinePoolDeclaration => ({ purpose: 'gate', fanoutGroupId: `gate-${host}`,
    members: [{ host, count: 1, digest, role: 'both' }],
    fanoutGroup: { shard: { kind: 'gate', input: 'gate-shard', result: 'gate-receipt', fingerprint: 'gate-v1' } },
    fingerprint: { runtime: 'bun-v1', environment: 'linux', skillPacks: [] },
    cleanup: { procedure: 'clean-v1', verify: 'verify-v1' } }));
  mkdirSync(join(configRoot, 'resource-ledger'), { recursive: true });
  writeFileSync(join(configRoot, 'resource-ledger', 'events.jsonl'), pools.map((pool, index) =>
    JSON.stringify({ event: 'pool-declared', at: `2026-11-08T00:00:0${index}.000Z`, pool })).join('\n') + '\n');
  const state = createNexusState({ nexusVersion: 'sim', phase: 'test' });
  const eventBus = new NexusEventBus();
  state.bus = eventBus;
  const opts = { state, registry: new TabRegistry(state), eventBus, allowInsecureResourceLedgerLoopbackForTests: true } as NexusHttpServerOpts;
  const server = { requestIP: (request: Request) => ({ address: new URL(request.url).hostname === '100.64.0.10' ? '100.64.0.20' : '127.0.0.1' }) } as never;
  const tailnetValidation = { readTailnetAddresses: () => ['100.64.0.10'] };
  const simulatedFetch: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    await routeRequest(new Request(input, init), opts, server, null, createDevProxyRuntimeRef())
      ?? new Response('Not Found', { status: 404 }), { preconnect: fetch.preconnect, resourceLedgerUrlValidationForTest: tailnetValidation });
  const imageConfig = { pod: { warmPoolProfile: 'gate', warmPool: { namespace: 'test', imageRepository: 'registry.example/elanous',
    imageDigest: digest, baseImageDigest: `sha256:${'f'.repeat(64)}`, lockHash: 'b'.repeat(64), architecture: 'arm64',
    hostProbeUrl: 'http://host.orb.internal:10001/health', prodProbeUrl: 'http://core.elanous-prod:10002/',
    sourceUrl: 'https://github.com/ElanvitalAI/elanous.git', templates: [] } },
  harness: { imageCommit: 'c'.repeat(40), podPool: 'gate-test-context' } };
  try {
    for (const host of hosts) {
      const token = tokens[host]!;
      const url = host === 'aws1' || host === 'aws2'
        ? 'http://100.64.0.10:8413/v1/resource-ledger/pools'
        : 'http://127.0.0.1:8413/v1/resource-ledger/pools';
      const declarations = await fetchMachinePoolDeclarationsFromNexus(url, token, simulatedFetch);
      expect(declarations).toEqual([pools[hosts.indexOf(host)]]);
      const config = { ...imageConfig, pod: { ...imageConfig.pod, warmPool: {
        ...imageConfig.pod.warmPool, templates: [{ host, tier: 'standard', nodeName: `${host}-node` }],
      } }, harness: { ...imageConfig.harness, podPool: `${host}-context` } };
      const provider = assembleWarmPoolProviderConfig({ config, controlUrl: 'https://control.test:8413',
        memberToken: 'd'.repeat(64), machineTokens: { [host]: token }, machinePools: declarations });
      expect(provider.poolTemplates).toHaveLength(1);
      expect(provider.poolTemplates[0]).toMatchObject({ host, slotCount: 1, spec: {
        kubectlContext: `${host}-context`, image: `registry.example/elanous@${digest}`,
      } });
      expect(provider.machineTokens).toEqual({ [host]: token });
      expect(provider.machinePools).toEqual([pools[hosts.indexOf(host)]]);
    }
  } finally {
    resetElanousConfigDir();
    rmSync(configRoot, { recursive: true, force: true });
  }
});

test('warm provider keeps known pool declarations when the ledger has an unknown event and reports that observation', async () => {
  const configRoot = mkdtempSync(join(tmpdir(), 'warm-pool-unknown-ledger-event-'));
  setElanousConfigDir(configRoot);
  const token = issueMemberToken('node-b');
  const longUnknownType = 'future pool observation α '.repeat(4);
  const controlUnknownType = 'future\nledger-event';
  mkdirSync(join(configRoot, 'logs'), { recursive: true });
  const logStore = new LogStore(join(configRoot, 'logs', 'logs.db'), { instance: 'test:unknown-resource-ledger-event' });
  const logSink = new StoreSink(logStore, 'ux-sim:unknown-resource-ledger-event', { installExitHandlers: false });
  const unregisterLogSink = debug.registerSink(logSink);
  const pool = { purpose: 'gate', fanoutGroupId: 'gate-sim-v1',
    members: [{ host: 'node-b', count: 1, digest: `sha256:${'b'.repeat(64)}`, role: 'both' }],
    fanoutGroup: { shard: { kind: 'gate', input: 'gate-shard', result: 'gate-receipt', fingerprint: 'gate-v1' } },
    fingerprint: { runtime: 'bun-v1', environment: 'linux', skillPacks: [] },
    cleanup: { procedure: 'clean-v1', verify: 'verify-v1' } };
  mkdirSync(join(configRoot, 'resource-ledger'), { recursive: true });
  writeFileSync(join(configRoot, 'resource-ledger', 'events.jsonl'), [
    JSON.stringify({ event: 'pool-declared', at: '2026-11-08T00:00:00.000Z', pool }),
    JSON.stringify({ event: 'future-pool-observation-v2', at: '2026-11-08T00:00:01.000Z', data: { opaque: true } }),
    JSON.stringify({ event: 'future-pool-observation-v2', at: '2026-11-08T00:00:02.000Z', data: { opaque: true } }),
    JSON.stringify({ event: 'future-pool-observation-v3', at: '2026-11-08T00:00:03.000Z', data: { opaque: true } }),
    JSON.stringify({ event: longUnknownType, at: '2026-11-08T00:00:04.000Z', data: { opaque: true } }),
    JSON.stringify({ event: 'future/type', at: '2026-11-08T00:00:05.000Z' }),
    JSON.stringify({ event: 'future?type', at: '2026-11-08T00:00:06.000Z' }),
    JSON.stringify({ event: controlUnknownType, at: '2026-11-08T00:00:07.000Z' }),
  ].join('\n') + '\n');
  const state = createNexusState({ nexusVersion: 'sim', phase: 'test' });
  const eventBus = new NexusEventBus();
  state.bus = eventBus;
  const opts = { state, registry: new TabRegistry(state), eventBus } as NexusHttpServerOpts;
  const server = { requestIP: () => ({ address: '127.0.0.1' }) } as never;
  try {
    const response = await routeRequest(new Request('https://nexus.test/v1/resource-ledger/pools', {
      headers: { authorization: `Bearer ${token}` },
    }), opts, server, null, createDevProxyRuntimeRef());
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ pools: [pool], observations: [
      { kind: 'unknown-ledger-event-skipped', eventType: 'future-pool-observation-v2', count: 2 },
      { kind: 'unknown-ledger-event-skipped', eventType: 'future-pool-observation-v3', count: 1 },
      { kind: 'unknown-ledger-event-skipped', eventType: longUnknownType, count: 1 },
      { kind: 'unknown-ledger-event-skipped', eventType: 'future/type', count: 1 },
      { kind: 'unknown-ledger-event-skipped', eventType: 'future?type', count: 1 },
      { kind: 'unknown-ledger-event-skipped', eventType: controlUnknownType, count: 1 },
    ] });
    logSink.flush();
    const warning = logStore.query({ categories: ['resource-ledger'], limit: 10 })
      .find(row => row.event === 'unknown-events-skipped');
    expect(warning).toBeDefined();
    expect(JSON.parse(warning?.data ?? '{}')).toMatchObject({ total: 7, eventTypes: [
      { eventTypeJson: JSON.stringify('future-pool-observation-v2'), count: 2 },
      { eventTypeJson: JSON.stringify('future-pool-observation-v3'), count: 1 },
      { eventTypeJson: JSON.stringify(longUnknownType), count: 1 },
      { eventTypeJson: JSON.stringify('future/type'), count: 1 },
      { eventTypeJson: JSON.stringify('future?type'), count: 1 },
      { eventTypeJson: JSON.stringify(controlUnknownType), count: 1 },
    ] });
    writeFileSync(join(configRoot, 'resource-ledger', 'events.jsonl'), [
      JSON.stringify({ event: 'pool-declared', at: '2026-11-08T00:00:00.000Z', pool }),
      '{"event":',
    ].join('\n') + '\n');
    const malformed = await routeRequest(new Request('https://nexus.test/v1/resource-ledger/pools', {
      headers: { authorization: `Bearer ${token}` },
    }), opts, server, null, createDevProxyRuntimeRef());
    expect(malformed?.status).toBe(503);
    expect(await malformed?.json()).toEqual({ error: 'resource-ledger-unavailable' });
    const invalidRows = [
      { event: 42 },
      { event: '' },
      { event: 'lease-created' },
      { event: 'lease-heartbeat', at: '2026-11-08T00:00:00.000Z' },
      { event: 'lease-ended', at: '2026-11-08T00:00:00.000Z', id: 'lease-1' },
      { event: 'lease-reaped', at: '2026-11-08T00:00:00.000Z', id: 'lease-1' },
      { event: 'pool-declared', at: '2026-11-08T00:00:00.000Z' },
      { event: 'pool-pod-receipt', at: '2026-11-08T00:00:00.000Z' },
      { event: 'guardian-host-lease', at: '2026-11-08T00:00:00.000Z', record: {} },
      { event: 'guardian-host-lease-conflict', at: '2026-11-08T00:00:00.000Z', requestId: '', existingLeaseId: '', attemptedRequest: {} },
      { event: 'guardian-host-lease-admitted', at: '2026-11-08T00:00:00.000Z', leaseId: '', host: '', runId: '', consumer: '' },
      { event: 'guardian-host-lease-admission-denied', at: '2026-11-08T00:00:00.000Z', leaseId: '', host: '', runId: '', consumer: '', reason: '', alternatives: 'bad' },
    ];
    for (const invalidRow of invalidRows) {
      writeFileSync(join(configRoot, 'resource-ledger', 'events.jsonl'), [
        JSON.stringify({ event: 'pool-declared', at: '2026-11-08T00:00:00.000Z', pool }),
        JSON.stringify(invalidRow),
      ].join('\n') + '\n');
      const invalid = await routeRequest(new Request('https://nexus.test/v1/resource-ledger/pools', {
        headers: { authorization: `Bearer ${token}` },
      }), opts, server, null, createDevProxyRuntimeRef());
      expect(invalid?.status).toBe(503);
      expect(await invalid?.json()).toEqual({ error: 'resource-ledger-unavailable' });
    }
  } finally {
    logSink.flush();
    unregisterLogSink();
    logSink.close();
    logStore.close();
    resetElanousConfigDir();
    rmSync(configRoot, { recursive: true, force: true });
  }
});

test('fake primary preserves member and machine lease scope contract', async () => {
  const primary = await createFakePrimaryControl();
  try {
    const key = { context: 'pool-host-a-context', imageDigest: `sha256:${'d'.repeat(64)}`,
      lockHash: 'e'.repeat(64), architecture: 'amd64' };
    const register = await primary.fetch(new URL('/v1/workers/pod', primary.url), { method: 'POST',
      headers: { authorization: `Bearer ${primary.machineTokens['pool-host-a']}`, 'content-type': 'application/json' },
      body: JSON.stringify({ workerId: 'scope-contract-worker', machine: 'pool-host-a', podUid: 'scope-contract-uid', key, ttlMs: 60_000 }) });
    expect(register.status).toBe(200);
    const lease = await primary.fetch(new URL('/v1/leases/pod-worker', primary.url), { method: 'POST',
      headers: { authorization: `Bearer ${primary.memberToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ machine: 'pool-host-a', key, runId: 'scope-contract-run',
        attemptId: 'scope-contract-attempt', ttlMs: 60_000 }) });
    expect(lease.status).toBe(200);
    const leaseValue = await lease.json() as { attrs: { leaseId: string; generation: number } };
    const wrongMachineLease = await primary.fetch(new URL('/v1/leases/pod-worker', primary.url), { method: 'POST',
      headers: { authorization: `Bearer ${primary.machineTokens['pool-host-a']}`, 'content-type': 'application/json' },
      body: JSON.stringify({ machine: 'pool-host-b', key, runId: 'scope-contract-run-2',
        attemptId: 'scope-contract-attempt-2', ttlMs: 60_000 }) });
    expect(wrongMachineLease.status).toBe(403);
    expect(await wrongMachineLease.json()).toMatchObject({ error: 'machine-scope' });
    const machineRelease = await primary.fetch(new URL('/v1/leases/pod-worker/scope-contract-worker/release', primary.url), {
      method: 'POST', headers: { authorization: `Bearer ${primary.machineTokens['pool-host-a']}`, 'content-type': 'application/json' },
      body: JSON.stringify({ leaseId: leaseValue.attrs.leaseId, generation: leaseValue.attrs.generation }),
    });
    expect(machineRelease.status).toBe(403);
    const memberRelease = await primary.fetch(new URL('/v1/leases/pod-worker/scope-contract-worker/release', primary.url), {
      method: 'POST', headers: { authorization: `Bearer ${primary.memberToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ leaseId: leaseValue.attrs.leaseId, generation: leaseValue.attrs.generation }),
    });
    expect(memberRelease.status).toBe(200);
    const machineWorker = await primary.fetch(new URL('/v1/workers/pod', primary.url), { method: 'POST',
      headers: { authorization: `Bearer ${primary.machineTokens['pool-host-a']}`, 'content-type': 'application/json' },
      body: JSON.stringify({ workerId: 'scope-contract-machine-worker', machine: 'pool-host-a',
        podUid: 'scope-contract-machine-uid', key, ttlMs: 60_000 }) });
    expect(machineWorker.status).toBe(200);
    const machineLease = await primary.fetch(new URL('/v1/leases/pod-worker', primary.url), { method: 'POST',
      headers: { authorization: `Bearer ${primary.machineTokens['pool-host-a']}`, 'content-type': 'application/json' },
      body: JSON.stringify({ machine: 'pool-host-a', key, runId: 'scope-contract-machine-run',
        attemptId: 'scope-contract-machine-attempt', ttlMs: 60_000 }) });
    expect(machineLease.status).toBe(200);
    const activeRetirement = await primary.fetch(new URL('/v1/leases/pod-worker/scope-contract-machine-worker/retire', primary.url), {
      method: 'POST', headers: { authorization: `Bearer ${primary.machineTokens['pool-host-a']}`, 'content-type': 'application/json' },
      body: JSON.stringify({ podUid: 'scope-contract-machine-uid' }),
    });
    expect(activeRetirement.status).toBe(409);
    const idleWorker = await primary.fetch(new URL('/v1/workers/pod', primary.url), { method: 'POST',
      headers: { authorization: `Bearer ${primary.machineTokens['pool-host-a']}`, 'content-type': 'application/json' },
      body: JSON.stringify({ workerId: 'scope-contract-retire-worker', machine: 'pool-host-a',
        podUid: 'scope-contract-retire-uid', key, ttlMs: 60_000 }) });
    expect(idleWorker.status).toBe(200);
    const retired = await primary.fetch(new URL('/v1/leases/pod-worker/scope-contract-retire-worker/retire', primary.url), {
      method: 'POST', headers: { authorization: `Bearer ${primary.machineTokens['pool-host-a']}`, 'content-type': 'application/json' },
      body: JSON.stringify({ podUid: 'scope-contract-retire-uid' }),
    });
    expect(retired.status).toBe(200);
    expect(await retired.json()).toMatchObject({ attrs: { state: 'quarantined', reason: 'host-drained' } });
    const retryRetire = await primary.fetch(new URL('/v1/leases/pod-worker/scope-contract-retire-worker/retire', primary.url), {
      method: 'POST', headers: { authorization: `Bearer ${primary.machineTokens['pool-host-a']}`, 'content-type': 'application/json' },
      body: JSON.stringify({ podUid: 'scope-contract-retire-uid' }),
    });
    expect(retryRetire.status).toBe(200);
  } finally { primary.stop(); }
});

test('WARM-POOL-REUSE-SIM: production reconcile selects a gate worker; refusals retain concrete reasons', async () => {
  const stateRoot = getTestStateRoot() ?? join(tmpdir(), `warm-pool-reuse-sim-${randomUUID()}`);
  const logPath = join(stateRoot, 'logs', 'logs.db');
  mkdirSync(join(stateRoot, 'logs'), { recursive: true });
  const store = new LogStore(logPath, { instance: 'test:warm-pool-reuse-sim' });
  const sink = new StoreSink(store, 'ux-sim:warm-pool-reuse-sim', { installExitHandlers: false });
  const unregister = debug.registerSink(sink);
  const runId = `run-warm-pool-reuse-${randomUUID()}`;
  const faults: Array<[WarmPoolReuseFault, string]> = [
    ['image-pin-mismatch', 'image-reference-mismatch'],
    ['profile-mismatch', 'profile-mismatch'],
    ['machine-token-scope-mismatch', 'machine-token-scope-mismatch'],
    ['detail-callback-missing', 'decision-unavailable'],
  ];
  try {
    const success = await runWarmPoolReuseSimulation({ runId });
    expect(success.reconcile).toMatchObject({ target: 1, ready: 1, failed: [] });
    expect(success.selection).toMatchObject({ selected: true, transport: 'observed', reason: 'complete' });
    if (!success.selection) throw new Error('successful simulation must select a worker');
    expect(success.protocol.requests).toHaveLength(1);
    expect(success.protocol.requests[0]).toMatchObject({ runId, attemptId: `${runId}-gate-1`,
      workerId: success.selection.workerId });
    expect(success.protocol.responses).toEqual([{ runId, reason: 'complete', replyRunId: runId }]);
    expect(success.protocol.acknowledgements).toEqual([runId]);
    expect(success.controlRequests).toContainEqual({ path: '/v1/workers/pod', status: 200 });
    expect(success.controlRequests).toContainEqual({ path: '/v1/leases/pod-worker', status: 200 });
    expect(success.controlRequests).toContainEqual({
      path: `/v1/leases/pod-worker/${success.selection.workerId}/release`, status: 200 });
    expect(success.controlRequests).toContainEqual({
      path: `/v1/leases/pod-worker/${success.selection.workerId}/sanitize`, status: 200 });
    const transportFailureRunId = `${runId}-transport-failure`;
    const transportFailure = await runWarmPoolReuseSimulation({ runId: transportFailureRunId, transportFailure: true });
    expect(transportFailure.selection).toMatchObject({ selected: true, transport: 'fallback', reason: 'worker-quarantined' });
    for (const [fault, reason] of faults) {
      const refused = await runWarmPoolReuseSimulation({ runId: `${runId}-${fault}`, fault });
      expect(refused.reconcile).toMatchObject({ target: 1, ready: 0, failed: [expect.any(String)] });
      if (fault === 'machine-token-scope-mismatch')
        expect(refused.controlRequests).toContainEqual({ path: '/v1/workers/pod', status: 403 });
    }
    const digestRepro = await runWarmPoolReuseSimulation({ runId: `${runId}-live-image-digests`,
      fault: 'image-pin-mismatch', imagePinDigests: {
        expected: 'sha256:dcddd5af4f4b8bc822107d184ee5644bd6165afc48194681e5cf6303066be014',
        observed: 'sha256:439cda88a55018764f7a2a76e4462b1489ed8f96edbb7132580d2e1f92988181',
      } });
    expect(digestRepro.reconcile).toMatchObject({ target: 1, ready: 1, failed: [] });
    // Gate reuse is pinned to the requested image digest; drift is observed but never leased.
    expect(digestRepro.selection).toMatchObject({ selected: false, transport: 'fallback', reason: 'lease-unavailable' });
    expect(digestRepro.deletedPodUid).toBeNull();
    expect(digestRepro.controlRequests.filter(row => row.path === '/v1/workers/pod')).toHaveLength(1);
    expect(digestRepro.controlRequests).not.toContainEqual(expect.objectContaining({ path: expect.stringMatching(/\/(retire|reap)$/) }));
    sink.flush();
    const driftRows = store.query({ categories: ['pod.warm'], limit: 200 });
    expect(driftRows.some(row => row.event === 'image-drift'
      && JSON.parse(row.data ?? '{}').runId === `${runId}-live-image-digests`)).toBe(true);
    const incompatible = await runWarmPoolReuseSimulation({ runId: `${runId}-incompatible-runtime`,
      fault: 'image-pin-mismatch', runtimeContractMismatch: true, imagePinDigests: {
        expected: 'sha256:dcddd5af4f4b8bc822107d184ee5644bd6165afc48194681e5cf6303066be014',
        observed: 'sha256:439cda88a55018764f7a2a76e4462b1489ed8f96edbb7132580d2e1f92988181',
      } });
    expect(incompatible.reconcile).toMatchObject({ target: 1, ready: 1, failed: [] });
    expect(incompatible.deletedPodUid).toBe('preexisting-pod-uid');
    expect(incompatible.selection).toMatchObject({ selected: false, transport: 'fallback', reason: 'lease-unavailable' });
    expect(incompatible.controlRequests).toContainEqual({
      path: '/v1/leases/pod-worker/warm-pool-host-a-standard-1-generation-1/retire', status: 200 });
    expect(incompatible.controlRequests).toContainEqual(expect.objectContaining({ path: expect.stringMatching(/\/reap$/), status: 200 }));
    const activeIncompatible = await runWarmPoolReuseSimulation({ runId: `${runId}-active-incompatible-runtime`,
      fault: 'image-pin-mismatch', runtimeContractMismatch: true, imagePinLeaseState: 'leased', imagePinDigests: {
        expected: 'sha256:dcddd5af4f4b8bc822107d184ee5644bd6165afc48194681e5cf6303066be014',
        observed: 'sha256:439cda88a55018764f7a2a76e4462b1489ed8f96edbb7132580d2e1f92988181',
      } });
    expect(activeIncompatible.reconcile).toMatchObject({ target: 1, ready: 0, failed: [expect.any(String)] });
    expect(activeIncompatible.deletedPodUid).toBeNull();
    expect(activeIncompatible.controlRequests).toContainEqual({
      path: '/v1/leases/pod-worker/warm-pool-host-a-standard-1-generation-1/retire', status: 409 });
    sink.flush();
    const rows = store.query({ categories: ['pod.warm', 'pod.warm.provider', 'pod.reuse'], grep: runId, limit: 100 });
    const events = rows.map(row => ({ category: row.category, event: row.event,
      data: row.data ? JSON.parse(row.data) as Record<string, unknown> : {} }));
    const selected = events.filter(row => row.category === 'pod.warm' && row.event === 'request-selection'
      && row.data.runId === runId && row.data.selected === true);
    expect(selected).toHaveLength(1);
    expect(events.filter(row => row.category === 'pod.reuse' && row.event === 'warm-worker-selected'
      && row.data.runId === runId)).toHaveLength(1);
    expect(events.filter(row => row.category === 'pod.reuse' && row.event === 'warm-worker-selected'
      && row.data.runId === transportFailureRunId)).toHaveLength(0);
    for (const [fault, reason] of faults) {
      const refusalRows = store.query({ categories: ['pod.warm.provider'], grep: `${runId}-${fault}`, limit: 100 });
      const refusals = refusalRows.filter(row => row.event === 'prepare-refused').map(row => row.data
        ? JSON.parse(row.data) as Record<string, unknown> : {});
      expect(refusals).toContainEqual(expect.objectContaining({ reason, host: 'pool-host-a',
        slot: 'warm-pool-host-a-standard-1-generation-1', runId: `${runId}-${fault}` }));
    }
  } finally {
    sink.flush(); unregister(); sink.close(); store.close();
    if (!getTestStateRoot()) rmSync(stateRoot, { recursive: true, force: true });
  }
});


test('GATE-WARM-POOL-SHARDS-SIM: three sequential shards reuse one pinned Pod with one receipt per lease', async () => {
  const runId = `run-gate-warm-shards-${randomUUID()}`;
  const result = await runWarmPoolReuseSimulation({ runId, shardCount: 3 });
  expect(result.reconcile).toMatchObject({ target: 1, ready: 1, failed: [] });
  const selections = result.shardSelections;
  if (!selections) throw new Error('sequential shard selections were not recorded');
  expect(selections).toHaveLength(3);
  expect(selections.every(row => row.transport === 'observed' && row.reason === 'complete' && row.released)).toBe(true);
  expect(new Set(selections.map(row => row.workerId)).size).toBe(1);
  expect(new Set(selections.map(row => row.podUid)).size).toBe(1);
  expect(result.protocol.requests.map(row => row.attemptId)).toEqual([
    `${runId}-gate-1`, `${runId}-gate-2`, `${runId}-gate-3`,
  ]);
  expect(result.controlRequests.filter(row => row.path.endsWith('/release'))).toHaveLength(3);
  expect(result.controlRequests.filter(row => row.path.endsWith('/sanitize'))).toHaveLength(3);
});

test('WARM-POOL-REUSE-SIM: disappearing mesh member reclaims its lease and reassigns same digest', async () => {
  const result = await simulateWarmPoolMachineLossRecovery();
  expect(result).toMatchObject({ reason: 'machine-disappeared', lostHost: 'pool-host-a', lostLeaseCount: 1,
    reassignedHost: 'pool-host-b', providerSelection: { selected: true, transport: 'observed', reason: 'complete', workerId: expect.stringMatching(/^warm-pool-host-b-[a-f0-9]+-gate-standard-1$/) }, providerTemplate: { host: 'pool-host-b', slotCount: 1, imageDigest: expect.stringMatching(/^sha256:/) }, digest: expect.stringMatching(/^sha256:/), leaseReaped: true, ledgerReason: 'machine-disappeared', podReceipt: { lastJob: 'crawl-shard-1', cleanupResult: { state: 'unknown' } } });
  expect(result.events).toContainEqual(expect.objectContaining({ type: 'vm-disappeared', id: 'pool-host-a', lostLeases: 1 }));
  expect(result.events).toContainEqual(expect.objectContaining({ type: 'lease-opened', id: 'pool-host-b' }));
});

test('POD-REUSE-TTL-ROTATE: expired idle Pod is UID-reaped and replaced before reuse', async () => {
  const result = await simulateWarmPoolTtlRotation({ runId: `run-warm-pool-ttl-${randomUUID()}`,
    registrationTtlMs: 500, ttlMs: 1_000 });
  expect(result.firstReconcile).toMatchObject({ target: 1, ready: 1, failed: [] });
  expect(result.rotatedReconcile).toMatchObject({ target: 1, ready: 1, failed: [] });
  expect(result.original.stateAfterRotation).toBe('reaping');
  expect(result.original.ttlMs).toBe(500);
  expect(result.registrationTtlMs).toBe(500);
  expect(result.ttlMs).toBe(1_000);
  expect(result.replacement).toMatchObject({ state: 'idle' });
  expect(result.replacement?.workerId).not.toBe(result.original.workerId);
  expect(result.replacement?.podUid).not.toBe(result.original.podUid);
  expect(result.deleteRequests).toEqual([{ name: 'warm-pool-host-a-standard-1', uid: result.original.podUid, deleted: true }]);
  expect(result.selection).toMatchObject({ selected: true, workerId: result.replacement?.workerId,
    transport: 'observed', reason: 'complete' });
});

test('POD-REUSE-TTL-ROTATE: persisted TTL survives shorter config and UID race preserves replacement Pod', async () => {
  const shorterConfig = await simulateWarmPoolTtlRotation({ runId: `run-warm-pool-ttl-short-${randomUUID()}`,
    registrationTtlMs: 1_000, ttlMs: 500, probeElapsedMs: 500 });
  expect(shorterConfig.stillValidReconcile).toMatchObject({ target: 1, ready: 1, failed: [] });
  expect(shorterConfig.stillValidRow).toMatchObject({ ttlMs: 1_000, attrs: { state: 'idle', idleTtlMs: 1_000 } });
  expect(shorterConfig.rotatedReconcile).toMatchObject({ target: 1, ready: 1, failed: [] });
  expect(shorterConfig.original.stateAfterRotation).toBe('reaping');

  const raced = await simulateWarmPoolTtlRotation({ runId: `run-warm-pool-ttl-race-${randomUUID()}`,
    registrationTtlMs: 500, ttlMs: 1_000, replacePodBeforeDelete: true });
  expect(raced.deleteRequests).toEqual([{ name: 'warm-pool-host-a-standard-1',
    uid: raced.original.podUid, deleted: false }]);
  expect(raced.podAfterRotation?.metadata.uid).toBe('raced-replacement-uid');
});

test('WARM-POOL-REUSE-SIM: draining host is excluded from reconcile and new lease allocation', async () => {
  const result = await runWarmPoolReuseSimulation({ runId: `run-drain-${randomUUID()}`,
    drainingHosts: ['pool-host-a'] });
  expect(result.reconcile).toMatchObject({ target: 0, ready: 0, failed: [] });
  expect(result.selection).toMatchObject({ selected: false, transport: 'fallback', reason: 'no-candidate' });
  expect(result.controlRequests).not.toContainEqual(expect.objectContaining({ path: '/v1/leases/pod-worker' }));
  expect(result.controlRequests).not.toContainEqual(expect.objectContaining({ path: '/v1/workers/pod' }));
});

test('WARM-POOL-REUSE-SIM: idle drained worker is quarantined and UID-pinned deleted', async () => {
  const result = await runWarmPoolReuseSimulation({ runId: `run-drain-cleanup-${randomUUID()}`,
    drainingHosts: ['pool-host-a'], seedDrainingPod: true });
  expect(result.reconcile).toMatchObject({ target: 0, ready: 0, failed: [] });
  expect(result.deletedPodUid).toBe('drained-pod-uid');
  expect(result.selection).toMatchObject({ selected: false, transport: 'fallback', reason: 'no-candidate' });
  expect(result.controlRequests).toContainEqual(expect.objectContaining({
    path: '/v1/leases/pod-worker/warm-pool-host-a-standard-1-generation-1/retire', status: 200 }));
});

test('WARM-POOL-REUSE-SIM: assembled drain config retains another host through production selection', async () => {
  const digest = `sha256:${'d'.repeat(64)}`;
  const assembled = assembleWarmPoolProviderConfig({
    config: { pod: { warmPoolProfile: 'gate', warmPool: { namespace: 'elanous-test',
      imageRepository: 'registry.example/elanous', imageDigest: digest,
      baseImageDigest: `sha256:${'a'.repeat(64)}`, lockHash: 'e'.repeat(64),
      architecture: 'amd64', hostProbeUrl: 'http://host.orb.internal:10001/health',
      prodProbeUrl: 'http://core.elanous-prod:10002/', sourceUrl: 'https://github.com/ElanvitalAI/elanous.git',
      drainingHosts: ['pool-host-a'], templates: [
        { host: 'pool-host-a', tier: 'standard', nodeName: 'pool-host-a-server-0' },
        { host: 'pool-host-b', tier: 'standard', nodeName: 'pool-host-a-server-0' },
      ] } }, harness: { imageCommit: 'f'.repeat(40), podPool: 'pool-host-a-context' } },
    controlUrl: 'https://control.example:8413', memberToken: 'a'.repeat(64),
    machineTokens: { 'pool-host-a': 'b'.repeat(64), 'pool-host-b': 'c'.repeat(64) },
  });
  expect(assembled.poolTemplates.map(row => row.host)).toEqual(['pool-host-a', 'pool-host-b']);
  expect(assembled.drainingHosts).toEqual(['pool-host-a']);
  const result = await runWarmPoolReuseSimulation({ runId: `run-assembled-drain-${randomUUID()}`,
    providerConfig: assembled });
  expect(result.reconcile).toMatchObject({ target: 1, ready: 1, failed: [] });
  expect(result.selection).toMatchObject({ selected: true, transport: 'observed', reason: 'complete',
    workerId: expect.stringMatching(/^warm-pool-host-b-/) });
});
