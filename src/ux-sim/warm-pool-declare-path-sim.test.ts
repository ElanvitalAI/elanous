import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { postResourcePoolDeclaration } from '../cli/resource-ledger-cli.js';
import { fetchMachinePoolDeclarationsFromNexus } from '../../scripts/warm-pool-provider-config.js';
import { issueMemberToken } from '../control-plane/member-tokens.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../elanous-config-dir.js';
import { createNexusState } from '../nexus/state/state.js';
import { TabRegistry } from '../nexus/state/tab-registry.js';
import { NexusEventBus } from '../nexus/api/event-bus.js';
import { routeRequest, type NexusHttpServerOpts } from '../nexus/api/http-server.js';
import { createDevProxyRuntimeRef } from '../nexus/api/admin-dev-proxy.js';
import { readResourceLedger } from '../resource-ledger/resource-ledger.js';
import { validateWarmHostProbeUrl } from '../task-orchestrator/surfaces/warm-host-probe.js';
import { simulateWarmPoolDeclaration } from './warm-pool-declare-path-sim.js';
import type { MachinePoolDeclaration } from '../resource-ledger/machine-pool-inventory.js';

const pool: MachinePoolDeclaration = {
  purpose: 'gate',
  members: [{ host: 'node-c', count: 2, digest: 'sha256:' + 'a'.repeat(64), role: 'both' }],
  fanoutGroupId: 'gate-shards-0.3.8',
  fanoutGroup: { shard: { kind: 'gate', input: 'gate-input', result: 'gate-result', fingerprint: 'gate-fp' } },
  fingerprint: { runtime: 'bun-linux', environment: 'gate-env', skillPacks: [{ name: 'gate', version: '1' }] },
  cleanup: { procedure: 'delete job', verify: 'pods absent' },
};

test('owner-auth declaration posts through Nexus and machine-auth GET reads the canonical ledger', async () => {
  const root = mkdtempSync(join(tmpdir(), 'warm-pool-declare-route-'));
  setElanousConfigDir(root);
  const ownerToken = 'owner-test-token';
  const machineToken = issueMemberToken('node-c');
  const state = createNexusState({ nexusVersion: 'sim', phase: 'test' });
  const eventBus = new NexusEventBus();
  state.bus = eventBus;
  const opts = { state, registry: new TabRegistry(state), eventBus,
    metaApi: { bearerToken: ownerToken, noAuth: false } } as NexusHttpServerOpts;
  const server = { requestIP: () => ({ address: '127.0.0.1' }) } as never;
  const endpoint = 'http://127.0.0.1:31415/v1/resource-ledger/pools';
  const calls: Array<{ method: string; authorization: string | null }> = [];
  const fetcher = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push({ method: request.method, authorization: request.headers.get('authorization') });
    return await routeRequest(request, opts, server, null, createDevProxyRuntimeRef()) ?? new Response('Not Found', { status: 404 });
  }, { preconnect: fetch.preconnect }) as unknown as typeof fetch;
  try {
    expect(await postResourcePoolDeclaration(pool, { baseUrl: 'http://127.0.0.1:31415', bearerToken: ownerToken, fetch: fetcher })).toBe(true);
    expect(await postResourcePoolDeclaration(pool, { baseUrl: 'http://127.0.0.1:31415', bearerToken: ownerToken, fetch: fetcher })).toBe(false);
    expect(calls.slice(0, 2)).toEqual([
      { method: 'POST', authorization: 'Bearer ' + ownerToken },
      { method: 'POST', authorization: 'Bearer ' + ownerToken },
    ]);
    const unauthorized = await fetcher(endpoint, { method: 'POST',
      headers: { authorization: 'Bearer wrong-owner-token', 'content-type': 'application/json' }, body: JSON.stringify({ pool }) });
    expect(unauthorized.status).toBe(401);
    const events = readResourceLedger();
    expect(events.filter(event => event.event === 'pool-declared')).toHaveLength(1);
    expect(await fetchMachinePoolDeclarationsFromNexus(endpoint, machineToken, fetcher)).toEqual([pool]);
    expect(await fetchMachinePoolDeclarationsFromNexus(endpoint, issueMemberToken('aws1'), fetcher)).toEqual([]);
    expect(readResourceLedger().filter(event => event.event === 'pool-declared')).toHaveLength(1);
  } finally {
    resetElanousConfigDir();
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalid and conflicting declarations fail closed without adding another event', () => {
  const root = mkdtempSync(join(tmpdir(), 'warm-pool-declare-invalid-'));
  const ledgerPath = join(root, 'events.jsonl');
  try {
    expect(() => simulateWarmPoolDeclaration({ ...pool, members: [] }, 'node-c', ledgerPath)).toThrow();
    const first = simulateWarmPoolDeclaration(pool, 'node-c', ledgerPath);
    expect(first.events.filter(event => event.event === 'pool-declared')).toHaveLength(1);
    const conflict = { ...pool, members: [{ ...pool.members[0], count: 3 }] };
    expect(() => simulateWarmPoolDeclaration(conflict, 'node-c', ledgerPath)).toThrow('conflicting resource pool declaration');
    expect(simulateWarmPoolDeclaration(pool, 'node-c', ledgerPath).events.filter(event => event.event === 'pool-declared')).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('host probe permits OrbStack, private ClusterIP and node IP while rejecting public or credentialed URLs', () => {
  expect(validateWarmHostProbeUrl('http://host.orb.internal:10001/health')).toBe('http://host.orb.internal:10001/health');
  expect(validateWarmHostProbeUrl('http://10.43.195.1:80/health')).toBe('http://10.43.195.1/health');
  expect(validateWarmHostProbeUrl('http://10.43.195.1:10001/health')).toBe('http://10.43.195.1:10001/health');
  expect(validateWarmHostProbeUrl('http://100.64.0.4:10001/health')).toBe('http://100.64.0.4:10001/health');
  expect(validateWarmHostProbeUrl('http://[fd00::1]:10001/health')).toBe('http://[fd00::1]:10001/health');
  for (const value of ['http://example.com:10001/health', 'http://user:pass@10.43.0.1:10001/health',
    'http://10.43.0.1:10001/health?token=x', 'https://10.43.0.1:10001/health'])
    expect(() => validateWarmHostProbeUrl(value)).toThrow();
});
