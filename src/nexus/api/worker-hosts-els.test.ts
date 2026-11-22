import { expect, test } from 'bun:test';
import { WorkerRegistryStore } from '../worker-registry/store.js';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { NexusEventBus } from './event-bus.js';
import { startNexusHttpServer } from './http-server.js';

test('owner bearer on untrusted HTTP cannot read or even open a worker_hosts snapshot', async () => {
  let snapshots = 0;
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  const server = startNexusHttpServer({ state, registry: new TabRegistry(state), eventBus: new NexusEventBus(),
    startPort: 48000 + Math.floor(Math.random() * 1000), metaApi: { bearerToken: 'owner-fixture', noAuth: false },
    trustedTlsEdge: { origin: 'https://nexus.test.invalid', secret: 'synthetic-edge-secret-xxxxxxxxxxxxxxxxxxxxxxxx' },
    workerRegistrySnapshot: () => { snapshots++; throw new Error('must not be read'); },
  });
  try {
    const endpoint = `${server.url}/v1/els/remote-hosts`;
    const owner = { authorization: 'Bearer owner-fixture' };
    expect((await fetch(endpoint)).status).toBe(401);
    const refused = await fetch(endpoint, { headers: owner });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'secure-transport-required' });
    expect((await fetch(endpoint, { headers: { ...owner, 'x-forwarded-proto': 'https',
      'x-forwarded-host': 'nexus.test.invalid', 'x-elanous-tls-edge-secret': 'wrong' } })).status).toBe(403);
    expect((await fetch(endpoint, { headers: { ...owner, 'x-forwarded-proto': 'https',
      'x-forwarded-host': 'other.test.invalid',
      'x-elanous-tls-edge-secret': 'synthetic-edge-secret-xxxxxxxxxxxxxxxxxxxxxxxx' } })).status).toBe(403);
    expect(snapshots).toBe(0);
  } finally { server.stop(); }
});

test('real Nexus HTTP returns one authenticated worker_hosts projection without dialing a remote ELS owner', async () => {
  const now = Date.now();
  const store = new WorkerRegistryStore(':memory:', () => new Date(now));
  store.upsertHost({ name: 'minim5', principal: 'machine-A', elsEndpoint: 'http://100.64.0.2:8790', heartbeatTtlMs: 60_000 });
  let snapshots = 0;
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  const server = startNexusHttpServer({ state, registry: new TabRegistry(state), eventBus: new NexusEventBus(),
    startPort: 48000 + Math.floor(Math.random() * 1000), metaApi: { bearerToken: 'owner-fixture', noAuth: false },
    allowInsecureResourceLedgerLoopbackForTests: true,
    workerRegistrySnapshot: () => { snapshots++; return store.snapshot(); },
  });
  try {
    const endpoint = `${server.url}/v1/els/remote-hosts`;
    expect((await fetch(endpoint)).status).toBe(401);
    expect((await fetch(endpoint, { headers: { 'x-identity': 'hq-control', origin: server.url } })).status).toBe(401);
    expect((await fetch(endpoint, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    expect(snapshots).toBe(0);
    const response = await fetch(endpoint, { headers: { authorization: 'Bearer owner-fixture' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ hosts: [{ name: 'minim5', state: 'registered',
      elsEndpoint: 'http://100.64.0.2:8790', principal: 'machine-A', generation: 1 }] });
    expect(snapshots).toBe(1);
    expect((await fetch(endpoint, { method: 'POST', headers: { authorization: 'Bearer owner-fixture' } })).status).toBe(405);
    expect(snapshots).toBe(1);
  } finally { server.stop(); store.close(); }
});

test('worker_hosts projection keeps expired, revoked and rotated hosts fail-closed from one observed generation', async () => {
  let now = Date.now() - 120_000;
  const store = new WorkerRegistryStore(':memory:', () => new Date(now));
  store.upsertHost({ name: 'minim5', principal: 'machine-A', elsEndpoint: 'http://100.64.0.2:8790', heartbeatTtlMs: 60_000 });
  now = Date.now();
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  const server = startNexusHttpServer({ state, registry: new TabRegistry(state), eventBus: new NexusEventBus(),
    startPort: 48000 + Math.floor(Math.random() * 1000), metaApi: { bearerToken: 'owner-fixture', noAuth: false },
    allowInsecureResourceLedgerLoopbackForTests: true,
    workerRegistrySnapshot: () => store.snapshot(),
  });
  const read = async () => {
    const response = await fetch(`${server.url}/v1/els/remote-hosts`, { headers: { authorization: 'Bearer owner-fixture' } });
    expect(response.status).toBe(200);
    return response.json() as Promise<{ hosts: Array<Record<string, unknown>> }>;
  };
  try {
    expect((await read()).hosts).toMatchObject([{ name: 'minim5', state: 'unavailable', readAllowed: false }]);
    expect((await read()).hosts[0]).not.toHaveProperty('elsEndpoint');
    store.upsertHost({ name: 'minim5', principal: 'machine-B', elsEndpoint: 'http://100.64.0.3:8790', heartbeatTtlMs: 60_000 });
    expect((await read()).hosts).toMatchObject([{ name: 'minim5', state: 'registered',
      principal: 'machine-B', generation: 2, elsEndpoint: 'http://100.64.0.3:8790', readAllowed: false }]);
    expect(JSON.stringify(await read())).not.toContain('100.64.0.2');
    store.revokeHost('minim5');
    const revoked = (await read()).hosts[0]!;
    expect(revoked).toMatchObject({ name: 'minim5', state: 'unavailable', generation: 2, readAllowed: false });
    expect(revoked).not.toHaveProperty('elsEndpoint');
    expect(revoked).not.toHaveProperty('principal');
  } finally { server.stop(); store.close(); }
});

test('worker_hosts read failure and noAuth mode never return partial hosts or use hosts.json', async () => {
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  const opts = { state, registry: new TabRegistry(state), eventBus: new NexusEventBus(),
    startPort: 48000 + Math.floor(Math.random() * 1000),
    allowInsecureResourceLedgerLoopbackForTests: true,
    workerRegistrySnapshot: () => { throw new Error('sensitive /home/owner/worker-registry.sqlite'); },
  };
  const server = startNexusHttpServer({ ...opts, metaApi: { bearerToken: 'owner-fixture', noAuth: false } });
  try {
    const response = await fetch(`${server.url}/v1/els/remote-hosts`, { headers: { authorization: 'Bearer owner-fixture' } });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'worker-registry-unavailable' });
  } finally { server.stop(); }
  const noAuth = startNexusHttpServer({ ...opts, startPort: opts.startPort + 1,
    metaApi: { bearerToken: 'owner-fixture', noAuth: true } });
  try {
    expect((await fetch(`${noAuth.url}/v1/els/remote-hosts`, { headers: { authorization: 'Bearer owner-fixture' } })).status).toBe(401);
  } finally { noAuth.stop(); }
});
