// 출처: #39074 JUD ⓒ 2건(#108052) — host 쓰기 인가 · 남의 worker 재등록 차단 failure-first 시험.
import { describe, expect, test } from 'bun:test';
import { routeWorkerRegistry, WORKER_REGISTRY_ROUTES } from './api.js';
import { WorkerRegistryStore } from './store.js';

const CLOCK = () => new Date('2026-01-01T00:00:00.000Z');
const hbPath = (n: string) => WORKER_REGISTRY_ROUTES.heartbeatHost.replace(':name', n);
const mk = () => new WorkerRegistryStore(':memory:', CLOCK);

describe('[#39074 JUD ⓒ2] re-register someone else worker', () => {
  test('owner B re-registering A worker: 403, generation and events untouched', () => {
    const store = mk();
    try {
      store.registerWorker({ id: 'w1', kind: 'cli', owner: 'seat-A' });
      const before = store.snapshot();
      const res = routeWorkerRegistry(store, {
        method: 'POST', path: WORKER_REGISTRY_ROUTES.registerWorker,
        identity: 'hq-control', ownerIdentity: 'seat-B',
        body: { id: 'w1', kind: 'cli', owner: 'seat-B' },
      });
      expect(res.status).toBe(403);
      expect(store.getWorker('w1')?.owner).toBe('seat-A');
      expect(store.getWorker('w1')?.generation).toBe(1);
      expect(store.snapshot()).toEqual(before);
    } finally { store.close(); }
  });

  test('owner A re-registering own worker still succeeds (generation +1)', () => {
    const store = mk();
    try {
      store.registerWorker({ id: 'w1', kind: 'cli', owner: 'seat-A' });
      const res = routeWorkerRegistry(store, {
        method: 'POST', path: WORKER_REGISTRY_ROUTES.registerWorker,
        identity: 'hq-control', ownerIdentity: 'seat-A',
        body: { id: 'w1', kind: 'cli', owner: 'seat-A' },
      });
      expect(res.status).toBe(200);
      expect(store.getWorker('w1')?.generation).toBe(2);
    } finally { store.close(); }
  });
});

describe('[#39074 JUD ⓒ1] host writes authorization', () => {
  test('unauthenticated host upsert (no host identity, not admin): 403, nothing written', () => {
    const store = mk();
    try {
      const res = routeWorkerRegistry(store, {
        method: 'POST', path: WORKER_REGISTRY_ROUTES.upsertHost,
        identity: 'hq-control', body: { name: 'h1', principal: 'p1' },
      });
      expect(res.status).toBe(403);
      expect(store.getHost('h1')).toBeUndefined();
    } finally { store.close(); }
  });

  test('another host identity cannot upsert h1', () => {
    const store = mk();
    try {
      const res = routeWorkerRegistry(store, {
        method: 'POST', path: WORKER_REGISTRY_ROUTES.upsertHost,
        identity: 'hq-control', hostIdentity: 'h2', hostPrincipal: 'p2', body: { name: 'h1' },
      });
      expect(res.status).toBe(403);
    } finally { store.close(); }
  });

  test('revoked host: non-admin cannot un-revoke via body principal rotation', () => {
    const store = mk();
    try {
      store.upsertHost({ name: 'h1', principal: 'p1' });
      store.revokeHost('h1');
      const res = routeWorkerRegistry(store, {
        method: 'POST', path: WORKER_REGISTRY_ROUTES.upsertHost,
        identity: 'hq-control', hostIdentity: 'h1', hostPrincipal: 'p1',
        body: { name: 'h1', principal: 'forged' },
      });
      expect(res.status).toBe(403);
      expect(store.getHost('h1')?.revokedAt).not.toBeNull();
      expect(store.getHost('h1')?.principal).toBe('p1');
      // attacker with another host identity too
      const res2 = routeWorkerRegistry(store, {
        method: 'POST', path: WORKER_REGISTRY_ROUTES.upsertHost,
        identity: 'hq-control', hostIdentity: 'h9', hostPrincipal: 'forged',
        body: { name: 'h1', principal: 'forged' },
      });
      expect(res2.status).toBe(403);
      expect(store.getHost('h1')?.revokedAt).not.toBeNull();
    } finally { store.close(); }
  });

  test('admin can un-revoke via principal rotation', () => {
    const store = mk();
    try {
      store.upsertHost({ name: 'h1', principal: 'p1' });
      store.revokeHost('h1');
      const res = routeWorkerRegistry(store, {
        method: 'POST', path: WORKER_REGISTRY_ROUTES.upsertHost,
        identity: 'hq-control', admin: true, body: { name: 'h1', principal: 'p2' },
      });
      expect(res.status).toBe(200);
      expect(store.getHost('h1')?.revokedAt).toBeNull();
      expect(store.getHost('h1')?.principal).toBe('p2');
    } finally { store.close(); }
  });

  test('host cannot rotate its own bound principal by body; body principal ignored', () => {
    const store = mk();
    try {
      store.upsertHost({ name: 'h1', principal: 'p1' });
      const rot = routeWorkerRegistry(store, {
        method: 'POST', path: WORKER_REGISTRY_ROUTES.upsertHost,
        identity: 'hq-control', hostIdentity: 'h1', hostPrincipal: 'other', body: { name: 'h1', principal: 'other' },
      });
      expect(rot.status).toBe(403);
      const ok = routeWorkerRegistry(store, {
        method: 'POST', path: WORKER_REGISTRY_ROUTES.upsertHost,
        identity: 'hq-control', hostIdentity: 'h1', hostPrincipal: 'p1', body: { name: 'h1', principal: 'forged' },
      });
      expect(ok.status).toBe(200);
      expect(store.getHost('h1')?.principal).toBe('p1');
      expect(store.getHost('h1')?.generation).toBe(1);
    } finally { store.close(); }
  });

  test('heartbeat: forged body principal ignored (409 mismatch from context principal)', () => {
    const store = mk();
    try {
      store.upsertHost({ name: 'h1', principal: 'p1' });
      const forged = routeWorkerRegistry(store, {
        method: 'POST', path: hbPath('h1'),
        identity: 'hq-control', hostIdentity: 'h1', body: { principal: 'p1' },
      });
      expect(forged.status).toBe(409); // no context principal -> body p1 not trusted
      const ok = routeWorkerRegistry(store, {
        method: 'POST', path: hbPath('h1'),
        identity: 'hq-control', hostIdentity: 'h1', hostPrincipal: 'p1', body: { principal: 'forged' },
      });
      expect(ok.status).toBe(200);
    } finally { store.close(); }
  });

  test('셀프 리뷰 M1: 숫자 id 로 owner 대조를 우회할 수 없다 — 400, 세대·원장 불변', () => {
    const store = mk();
    try {
      store.registerWorker({ id: '123', kind: 'cli', owner: 'seat-A' });
      const before = store.snapshot();
      const res = routeWorkerRegistry(store, {
        method: 'POST', path: WORKER_REGISTRY_ROUTES.registerWorker,
        identity: 'hq-control', ownerIdentity: 'seat-B',
        body: { id: 123, kind: 'cli', owner: 'seat-B' },
      });
      expect(res.status).toBe(400);
      expect(store.getWorker('123')?.generation).toBe(1);
      expect(store.snapshot()).toEqual(before);
    } finally { store.close(); }
  });

  test('셀프 리뷰 M2: principal 불일치 409 응답에 결속된 principal 원문이 없다', () => {
    const store = mk();
    try {
      store.upsertHost({ name: 'h1', principal: 'SECRET-p1' });
      const res = routeWorkerRegistry(store, {
        method: 'POST', path: hbPath('h1'),
        identity: 'hq-control', hostIdentity: 'h1', hostPrincipal: 'wrong', body: {},
      });
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).not.toContain('SECRET-p1');
      expect(JSON.stringify(res.body)).not.toContain('wrong');
    } finally { store.close(); }
  });

  test('heartbeat by non-owning host identity: 403', () => {
    const store = mk();
    try {
      store.upsertHost({ name: 'h1', principal: 'p1' });
      const res = routeWorkerRegistry(store, {
        method: 'POST', path: hbPath('h1'),
        identity: 'hq-control', hostIdentity: 'h2', hostPrincipal: 'p1', body: {},
      });
      expect(res.status).toBe(403);
    } finally { store.close(); }
  });
});
