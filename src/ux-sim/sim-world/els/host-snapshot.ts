// ELS-REMOTE-TAB-1/2: authenticated Nexus metadata only; no remote ELS read/input in this stage.
import { join } from 'node:path';
import { createNexusState } from '../../../nexus/state/state.js';
import { TabRegistry } from '../../../nexus/state/tab-registry.js';
import { NexusEventBus } from '../../../nexus/api/event-bus.js';
import { routeRequest, type NexusHttpServerOpts } from '../../../nexus/api/http-server.js';
import { createDevProxyRuntimeRef } from '../../../nexus/api/admin-dev-proxy.js';
import { WorkerRegistryStore } from '../../../nexus/worker-registry/store.js';
import type { SimWorldDeviceDef, SimWorldScenario } from '../types.js';

interface HostSnapshotDevice {
  readonly reads: () => number;
  get(authenticated: boolean): Promise<{ status: number; body: Record<string, unknown> }>;
  rotate(): void;
  revoke(): void;
  restart(): void;
  close(): void;
}

const owner = 'sim-owner-bearer';
const device: SimWorldDeviceDef<HostSnapshotDevice> = {
  id: 'els-worker-host-snapshot-restart',
  title: 'Nexus worker_hosts WAL, TTL, principal rotation, revocation and route-context restart',
  create(ctx) {
    const path = join(ctx.universeRoot, 'worker-registry.sqlite');
    let now = Date.now() - 120_000;
    let store = new WorkerRegistryStore(path, () => new Date(now));
    store.upsertHost({ name: 'minim5', principal: 'machine-A', elsEndpoint: 'http://100.64.0.2:8790', heartbeatTtlMs: 60_000 });
    now = Date.now();
    let reads = 0;
    const start = (): NexusHttpServerOpts => {
      const state = createNexusState({ nexusVersion: 'sim', phase: 'test' });
      return { state, registry: new TabRegistry(state), eventBus: new NexusEventBus(),
        metaApi: { bearerToken: owner, noAuth: false },
        workerRegistrySnapshot: () => { reads++; return store.snapshot(); },
      };
    };
    let route = start();
    const proxy = createDevProxyRuntimeRef();
    const action = (name: string) => ctx.recorder.event(name, { reads });
    return {
      reads: () => reads,
      async get(authenticated) {
        const request = new Request('https://nexus.test.invalid/v1/els/remote-hosts', {
          ...(authenticated ? { headers: { authorization: `Bearer ${owner}` } } : {}),
        });
        // The kernel replaces only the network listener. This is the same product router
        // the real Nexus HTTP server calls, with its own configured owner credential.
        const response = await routeRequest(request, route, {} as Parameters<typeof routeRequest>[2], null, proxy);
        if (!response) return { status: 404, body: {} };
        return { status: response.status, body: await response.json() as Record<string, unknown> };
      },
      rotate() {
        store.upsertHost({ name: 'minim5', principal: 'machine-B', elsEndpoint: 'http://100.64.0.3:8790', heartbeatTtlMs: 60_000 });
        action('host-principal-rotated');
      },
      revoke() { store.revokeHost('minim5'); action('host-revoked'); },
      restart() {
        store.close();
        store = new WorkerRegistryStore(path, () => new Date(now));
        route = start();
        action('route-context-restarted');
      },
      close() { store.close(); },
    };
  },
  dispose(instance) { instance.close(); },
};

const scenario: SimWorldScenario = {
  id: 'E-HOST-SNAPSHOT-BOUND',
  title: 'Nexus host metadata is bearer-gated and fails closed across TTL, rotation, revocation and WAL reopen',
  devices: [device.id],
  async run(ctx) {
    const host = ctx.device<HostSnapshotDevice>(device.id);
    const anonymous = await host.get(false);
    const stale = await host.get(true);
    host.rotate();
    const live = await host.get(true);
    host.revoke();
    const revoked = await host.get(true);
    host.restart();
    const afterRestart = await host.get(true);
    const row = (body: Record<string, unknown>): Record<string, unknown> => (body.hosts as Record<string, unknown>[])[0]!;
    const good = anonymous.status === 401 && host.reads() === 4
      && stale.status === 200 && row(stale.body).state === 'unavailable' && row(stale.body).elsEndpoint === undefined
      && live.status === 200 && row(live.body).state === 'registered'
      && row(live.body).principal === 'machine-B' && row(live.body).generation === 2
      && row(live.body).elsEndpoint === 'http://100.64.0.3:8790' && row(live.body).readAllowed === false
      && revoked.status === 200 && row(revoked.body).state === 'unavailable' && row(revoked.body).elsEndpoint === undefined
      && afterRestart.status === 200 && row(afterRestart.body).state === 'unavailable'
      && row(afterRestart.body).elsEndpoint === undefined
      && !JSON.stringify([stale, live, revoked, afterRestart]).includes('100.64.0.2');
    ctx.recorder.event('els-host-snapshot-result', { good, reads: host.reads(), anonymous: anonymous.status,
      stale: row(stale.body).state, live: row(live.body).state, revoked: row(revoked.body).state,
      afterRestart: row(afterRestart.body).state });
    return good ? { ok: true } : { ok: false, reason: 'worker host projection lost auth, TTL or generation binding',
      diff: JSON.stringify({ anonymous, stale, live, revoked, afterRestart, reads: host.reads() }) };
  },
};

export const simWorldDevices: readonly SimWorldDeviceDef[] = [device];
export const simWorldScenarios: readonly SimWorldScenario[] = [scenario];
