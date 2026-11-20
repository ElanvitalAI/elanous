// [NEXUS-WORKER-REGISTRY-FU] — registry 쓰기(registerWorker·setDesiredState)는
// HQ control 신원이 주입된 소유 좌석 신원(ownerIdentity === row.owner)을 대입할 때만 허용(fail-closed / JUD-B #105414 must 1).
import { describe, expect, test } from 'bun:test';
import { routeWorkerRegistry, WORKER_REGISTRY_ROUTES } from './api.js';
import { WorkerRegistryStore } from './store.js';

const FIXED_CLOCK = () => new Date('2026-01-01T00:00:00.000Z');
const desiredStatePath = (id: string) => WORKER_REGISTRY_ROUTES.setDesiredState.replace(':id', id);

describe('[NEXUS-WORKER-REGISTRY-FU] owner binding on registry writes', () => {
  test('hq-control + ownerIdentity === owner: register & steer succeed', () => {
    const store = new WorkerRegistryStore(':memory:', FIXED_CLOCK);
    try {
      const registerRes = routeWorkerRegistry(store, {
        method: 'POST', path: WORKER_REGISTRY_ROUTES.registerWorker,
        identity: 'hq-control', ownerIdentity: 'seat-A',
        body: { id: 'w1', kind: 'cli', owner: 'seat-A' },
      });
      expect(registerRes.status).toBe(200);
      expect(registerRes.body).toMatchObject({ id: 'w1', owner: 'seat-A' });
      const steerRes = routeWorkerRegistry(store, {
        method: 'POST', path: desiredStatePath('w1'),
        identity: 'hq-control', ownerIdentity: 'seat-A',
        body: { state: 'idle' },
      });
      expect(steerRes.status).toBe(200);
      expect(steerRes.body).toMatchObject({ id: 'w1', desiredState: 'idle' });
    } finally { store.close(); }
  });

  test('ownerIdentity mismatch: both writes 403', () => {
    const store = new WorkerRegistryStore(':memory:', FIXED_CLOCK);
    try {
      const registerRes = routeWorkerRegistry(store, {
        method: 'POST', path: WORKER_REGISTRY_ROUTES.registerWorker,
        identity: 'hq-control', ownerIdentity: 'seat-B',
        body: { id: 'w1', kind: 'cli', owner: 'seat-A' },
      });
      expect(registerRes.status).toBe(403);
      store.registerWorker({ id: 'w2', kind: 'cli', owner: 'seat-A' });
      const steerRes = routeWorkerRegistry(store, {
        method: 'POST', path: desiredStatePath('w2'),
        identity: 'hq-control', ownerIdentity: 'seat-B',
        body: { state: 'idle' },
      });
      expect(steerRes.status).toBe(403);
    } finally { store.close(); }
  });

  test('ownerIdentity absent: both writes 403', () => {
    const store = new WorkerRegistryStore(':memory:', FIXED_CLOCK);
    try {
      const registerRes = routeWorkerRegistry(store, {
        method: 'POST', path: WORKER_REGISTRY_ROUTES.registerWorker,
        identity: 'hq-control',
        body: { id: 'w1', kind: 'cli', owner: 'seat-A' },
      });
      expect(registerRes.status).toBe(403);
      store.registerWorker({ id: 'w2', kind: 'cli', owner: 'seat-A' });
      const steerRes = routeWorkerRegistry(store, {
        method: 'POST', path: desiredStatePath('w2'),
        identity: 'hq-control',
        body: { state: 'idle' },
      });
      expect(steerRes.status).toBe(403);
    } finally { store.close(); }
  });

  test('seat identity alone: both writes 403', () => {
    const store = new WorkerRegistryStore(':memory:', FIXED_CLOCK);
    try {
      const registerRes = routeWorkerRegistry(store, {
        method: 'POST', path: WORKER_REGISTRY_ROUTES.registerWorker,
        identity: 'seat-A', ownerIdentity: 'seat-A',
        body: { id: 'w1', kind: 'cli', owner: 'seat-A' },
      });
      expect(registerRes.status).toBe(403);
      store.registerWorker({ id: 'w2', kind: 'cli', owner: 'seat-A' });
      const steerRes = routeWorkerRegistry(store, {
        method: 'POST', path: desiredStatePath('w2'),
        identity: 'seat-A', ownerIdentity: 'seat-A',
        body: { state: 'idle' },
      });
      expect(steerRes.status).toBe(403);
    } finally { store.close(); }
  });

  test('unknown worker id on setDesiredState: 404', () => {
    const store = new WorkerRegistryStore(':memory:', FIXED_CLOCK);
    try {
      const steerRes = routeWorkerRegistry(store, {
        method: 'POST', path: desiredStatePath('ghost'),
        identity: 'hq-control', ownerIdentity: 'seat-A',
        body: { state: 'idle' },
      });
      expect(steerRes.status).toBe(404);
    } finally { store.close(); }
  });
});