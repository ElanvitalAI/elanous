import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResourceLedger } from '../control-plane/ledger.js';
import { reconcileCloudBurstAuto, type CloudBurstAutoInput } from './cloud-burst-auto.js';

const FIXED_NOW = Date.parse('2026-11-10T00:00:00.000Z'); // Source: deterministic lifecycle fixture.

test('cloud burst persists its plan across uncertain start and status failures, then drains before re-admitting', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cloud-burst-lifecycle-'));
  try {
    const ledger = new ResourceLedger(root);
    let vmState: 'running' | 'stopped' = 'stopped';
    let startFailure: Error | undefined = new Error('provider accepted request before timeout');
    let statusFailure: Error | undefined;
    let warm = false;
    let leases = 0;
    let admits = 0;
    let joins = 0;
    const input: CloudBurstAutoInput = {
      requestId: 'recoverable-burst', owner: 'NT-3', host: 'aws2', purpose: 'execution', now: FIXED_NOW,
      queueDepth: 4, blockedCount: 1, threshold: 2, imageDigest: `sha256:${'a'.repeat(64)}`, // Source: 내부 문서 `CONDUCTOR` §6c.
      hourlyCostKrw: 10_000, ttlHours: 2,
    };
    const dependencies = {
      ledger,
      cloudVm: {
        async start() { if (startFailure) { vmState = 'running'; throw startFailure; } vmState = 'running'; },
        async stop() { vmState = 'stopped'; },
        async status(host: 'aws2') {
          if (statusFailure) throw statusFailure;
          return { host, state: vmState } as const;
        },
      },
      async join() { joins++; },
      isWarm: async () => warm,
      activeLeases: async () => leases,
      async admit() { admits++; },
      async withdraw() {},
    };

    await expect(reconcileCloudBurstAuto(input, dependencies)).rejects.toThrow('provider accepted request before timeout');
    let lifecycle = ledger.list({ kind: 'universe' }).find(row => row.id === 'fleet-cloud-burst:recoverable-burst');
    expect(lifecycle?.attrs).toMatchObject({ state: 'warming', admissionAt: FIXED_NOW + 60 * 60_000, stopAfterAt: FIXED_NOW + 3 * 60 * 60_000 });
    expect(ledger.list({ kind: 'universe' }).filter(row => row.attrs.type === 'burst-auto-budget-decision')).toHaveLength(1);

    startFailure = undefined;
    statusFailure = new Error('status command temporarily unavailable');
    await expect(reconcileCloudBurstAuto({ ...input, now: FIXED_NOW + 1 }, dependencies)).rejects.toThrow('status command temporarily unavailable');
    lifecycle = ledger.list({ kind: 'universe' }).find(row => row.id === 'fleet-cloud-burst:recoverable-burst');
    expect(lifecycle?.attrs).toMatchObject({ state: 'warming', admissionAt: FIXED_NOW + 60 * 60_000, stopAfterAt: FIXED_NOW + 3 * 60 * 60_000 });
    expect(ledger.list({ kind: 'universe' }).filter(row => row.attrs.type === 'burst-auto-budget-decision')).toHaveLength(1);

    statusFailure = undefined;
    const readyAt = FIXED_NOW + 60 * 60_000;
    expect((await reconcileCloudBurstAuto({ ...input, now: readyAt }, dependencies)).state).toBe('warming');
    expect(joins).toBe(1);
    warm = true;
    expect((await reconcileCloudBurstAuto({ ...input, now: readyAt }, dependencies)).state).toBe('admitted');
    expect(admits).toBe(1);
    expect(joins).toBe(1);

    leases = 1;
    const belowThreshold = { ...input, now: readyAt + 1, queueDepth: 1, blockedCount: 1 };
    expect((await reconcileCloudBurstAuto(belowThreshold, dependencies)).state).toBe('draining');
    expect((await reconcileCloudBurstAuto({ ...input, now: readyAt + 2 }, dependencies)).state).toBe('draining');
    expect(admits).toBe(1);
    leases = 0;
    expect((await reconcileCloudBurstAuto({ ...input, now: readyAt + 3 }, dependencies)).state).toBe('admitted');
    expect(admits).toBe(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('automatic burst rejects cloud aliases outside the worker allowlist', async () => {
  const input = {
    requestId: 'forbidden-burst', owner: 'NT-3', host: 'aws1', purpose: 'execution', now: FIXED_NOW,
    queueDepth: 4, blockedCount: 1, threshold: 2, imageDigest: `sha256:${'b'.repeat(64)}`, // Source: 내부 문서 `CONDUCTOR` §6c.
    hourlyCostKrw: 10_000, ttlHours: 2,
  } as unknown as CloudBurstAutoInput;
  await expect(reconcileCloudBurstAuto(input, {
    cloudVm: { async start() {}, async stop() {}, async status(host) { return { host, state: 'stopped' }; } },
    async join() {}, isWarm: async () => false, activeLeases: async () => 0, async admit() {}, async withdraw() {},
  })).rejects.toThrow('cloud burst host alias is not approved: aws1');
});

test('concurrent reconciles for one request reserve and start only one VM lifecycle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cloud-burst-concurrent-'));
  try {
    const ledger = new ResourceLedger(root);
    let starts = 0;
    let joins = 0;
    const input: CloudBurstAutoInput = {
      requestId: 'same-request', owner: 'NT-3', host: 'aws2', purpose: 'execution', now: FIXED_NOW,
      queueDepth: 3, blockedCount: 2, threshold: 2, imageDigest: `sha256:${'d'.repeat(64)}`, // Source: 내부 문서 `CONDUCTOR` §6c.
      hourlyCostKrw: 10_000, ttlHours: 2,
    };
    const dependencies = {
      ledger,
      cloudVm: {
        async start() { starts++; await Promise.resolve(); },
        async stop() {},
        async status(host: 'aws2') { return { host, state: 'running' } as const; },
      },
      async join() { joins++; },
      isWarm: async () => false,
      activeLeases: async () => 0,
      async admit() {},
      async withdraw() {},
    };
    await Promise.all([
      reconcileCloudBurstAuto(input, dependencies),
      reconcileCloudBurstAuto(input, dependencies),
    ]);
    expect(starts).toBe(1);
    expect(joins).toBe(1);
    expect(ledger.list({ kind: 'universe' }).filter(row => row.attrs.type === 'burst-auto-budget-decision')).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an admitted VM restart withdraws stale capacity and requires a fresh join and warm check', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cloud-burst-restart-'));
  try {
    const ledger = new ResourceLedger(root);
    let vmState: 'running' | 'stopped' = 'stopped';
    let warm = false;
    let starts = 0;
    let joins = 0;
    let admits = 0;
    let withdraws = 0;
    const input: CloudBurstAutoInput = {
      requestId: 'restart-request', owner: 'NT-3', host: 'aws2', purpose: 'execution', now: FIXED_NOW,
      queueDepth: 3, blockedCount: 2, threshold: 2, imageDigest: `sha256:${'e'.repeat(64)}`, // Source: 내부 문서 `CONDUCTOR` §6c.
      hourlyCostKrw: 10_000, ttlHours: 2,
    };
    const dependencies = {
      ledger,
      cloudVm: {
        async start() { starts++; vmState = 'running'; },
        async stop() { vmState = 'stopped'; },
        async status(host: 'aws2') { return { host, state: vmState } as const; },
      },
      async join() { joins++; },
      isWarm: async () => warm,
      activeLeases: async () => 0,
      async admit() { admits++; },
      async withdraw() { withdraws++; },
    };
    await reconcileCloudBurstAuto(input, dependencies);
    const admissionAt = FIXED_NOW + 60 * 60_000; // Source: 내부 문서 `CONDUCTOR` §6c — scheduled admission window.
    warm = true;
    expect((await reconcileCloudBurstAuto({ ...input, now: admissionAt }, dependencies)).state).toBe('admitted');
    expect(joins).toBe(1);
    expect(admits).toBe(1);

    vmState = 'stopped';
    warm = false;
    expect((await reconcileCloudBurstAuto({ ...input, now: admissionAt + 1 }, dependencies)).state).toBe('warming');
    expect(withdraws).toBe(1);
    expect(admits).toBe(1);
    expect(starts).toBe(2);
    expect(ledger.list({ kind: 'universe' }).find(row => row.id === 'fleet-cloud-burst:restart-request')?.attrs.joinedAt).toBeUndefined();

    expect((await reconcileCloudBurstAuto({ ...input, now: admissionAt + 2 }, dependencies)).state).toBe('warming');
    expect(joins).toBe(2);
    expect(admits).toBe(1);
    warm = true;
    expect((await reconcileCloudBurstAuto({ ...input, now: admissionAt + 3 }, dependencies)).state).toBe('admitted');
    expect(admits).toBe(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an admitted VM that loses warm status is withdrawn before it can be admitted again', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cloud-burst-cold-'));
  try {
    const ledger = new ResourceLedger(root);
    let warm = true;
    let withdraws = 0;
    let admits = 0;
    const input: CloudBurstAutoInput = {
      requestId: 'cold-request', owner: 'NT-3', host: 'aws2', purpose: 'execution', now: FIXED_NOW,
      queueDepth: 3, blockedCount: 2, threshold: 2, imageDigest: `sha256:${'f'.repeat(64)}`, // Source: 내부 문서 `CONDUCTOR` §6c.
      hourlyCostKrw: 10_000, ttlHours: 2,
    };
    const dependencies = {
      ledger,
      cloudVm: {
        async start() {}, async stop() {},
        async status(host: 'aws2') { return { host, state: 'running' } as const; },
      },
      async join() {}, isWarm: async () => warm, activeLeases: async () => 0,
      async admit() { admits++; }, async withdraw() { withdraws++; },
    };
    await reconcileCloudBurstAuto(input, dependencies);
    const admissionAt = FIXED_NOW + 60 * 60_000;
    expect((await reconcileCloudBurstAuto({ ...input, now: admissionAt }, dependencies)).state).toBe('admitted');
    warm = false;
    expect((await reconcileCloudBurstAuto({ ...input, now: admissionAt + 1 }, dependencies)).state).toBe('warming');
    expect(withdraws).toBe(1);
    expect(admits).toBe(1);
    expect(ledger.list({ kind: 'universe' }).find(item => item.id === 'fleet-cloud-burst:cold-request')?.attrs).not.toHaveProperty('joinedAt');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('different requests cannot reserve the same cloud worker while its owner is active', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cloud-burst-host-owner-'));
  try {
    const ledger = new ResourceLedger(root);
    let starts = 0;
    const base: CloudBurstAutoInput = {
      requestId: 'host-owner', owner: 'NT-3', host: 'aws2', purpose: 'execution', now: FIXED_NOW,
      queueDepth: 3, blockedCount: 2, threshold: 2, imageDigest: `sha256:${'c'.repeat(64)}`, // Source: 내부 문서 `CONDUCTOR` §6c.
      hourlyCostKrw: 10_000, ttlHours: 2,
    };
    const dependencies = {
      ledger,
      cloudVm: {
        async start() { starts++; }, async stop() {},
        async status(host: 'aws2') { return { host, state: 'running' } as const; },
      },
      async join() {}, isWarm: async () => false, activeLeases: async () => 0,
      async admit() {}, async withdraw() {},
    };
    await reconcileCloudBurstAuto(base, dependencies);
    const competing = await reconcileCloudBurstAuto({ ...base, requestId: 'other-owner' }, dependencies);
    expect(competing).toMatchObject({ state: 'warming', reason: 'cloud host is owned by request host-owner' });
    expect(starts).toBe(1);
    expect(ledger.list({ kind: 'universe' }).some(item => item.id === 'fleet-cloud-burst:other-owner')).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a persisted request cannot be reconciled against a different host', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cloud-burst-host-change-'));
  try {
    const ledger = new ResourceLedger(root);
    const input: CloudBurstAutoInput = {
      requestId: 'stable-host-request', owner: 'NT-3', host: 'aws2', purpose: 'execution', now: FIXED_NOW,
      queueDepth: 3, blockedCount: 2, threshold: 2, imageDigest: `sha256:${'9'.repeat(64)}`, // Source: 내부 문서 `CONDUCTOR` §6c.
      hourlyCostKrw: 10_000, ttlHours: 2,
    };
    const dependencies = {
      ledger,
      cloudVm: {
        async start() {}, async stop() {},
        async status(host: 'aws2' | 'gcp2') { return { host, state: 'running' } as const; },
      },
      async join() {}, isWarm: async () => false, activeLeases: async () => 0,
      async admit() {}, async withdraw() {},
    };
    await reconcileCloudBurstAuto(input, dependencies);
    await expect(reconcileCloudBurstAuto({ ...input, host: 'gcp2' }, dependencies))
      .rejects.toThrow('cloud burst host changed for request stable-host-request');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('UUID request IDs can still resume and drain their persisted lifecycle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cloud-burst-uuid-'));
  try {
    const ledger = new ResourceLedger(root);
    let stopped = false;
    const input: CloudBurstAutoInput = {
      requestId: '123e4567-e89b-12d3-a456-426614174000', owner: 'NT-3', host: 'aws2', purpose: 'execution', now: FIXED_NOW,
      queueDepth: 3, blockedCount: 2, threshold: 2, imageDigest: `sha256:${'8'.repeat(64)}`, // Source: 내부 문서 `CONDUCTOR` §6c.
      hourlyCostKrw: 10_000, ttlHours: 2,
    };
    const dependencies = {
      ledger,
      cloudVm: {
        async start() {}, async stop() { stopped = true; },
        async status(host: 'aws2') { return { host, state: 'running' } as const; },
      },
      async join() {}, isWarm: async () => false, activeLeases: async () => 0,
      async admit() {}, async withdraw() {},
    };
    await reconcileCloudBurstAuto(input, dependencies);
    expect((await reconcileCloudBurstAuto({ ...input, now: FIXED_NOW + 1, queueDepth: 0, blockedCount: 0 }, dependencies)).state).toBe('stopped');
    expect(stopped).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a restart is recorded before start can time out after the provider accepted it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cloud-burst-restart-timeout-'));
  try {
    const ledger = new ResourceLedger(root);
    let state: 'running' | 'stopped' = 'stopped';
    let failRestart = false;
    const input: CloudBurstAutoInput = {
      requestId: 'restart-timeout', owner: 'NT-3', host: 'aws2', purpose: 'execution', now: FIXED_NOW,
      queueDepth: 3, blockedCount: 2, threshold: 2, imageDigest: `sha256:${'b'.repeat(64)}`, // Source: 내부 문서 `CONDUCTOR` §6c.
      hourlyCostKrw: 10_000, ttlHours: 2,
    };
    const dependencies = {
      ledger,
      cloudVm: {
        async start() { state = 'running'; if (failRestart) throw new Error('accepted then timed out'); },
        async stop() {}, async status(host: 'aws2') { return { host, state } as const; },
      },
      async join() {}, isWarm: async () => true, activeLeases: async () => 0,
      async admit() {}, async withdraw() {},
    };
    await reconcileCloudBurstAuto(input, dependencies);
    const admissionAt = FIXED_NOW + 60 * 60_000;
    await reconcileCloudBurstAuto({ ...input, now: admissionAt }, dependencies);
    state = 'stopped';
    failRestart = true;
    await expect(reconcileCloudBurstAuto({ ...input, now: admissionAt + 1 }, dependencies)).rejects.toThrow('accepted then timed out');
    expect(ledger.list({ kind: 'universe' }).find(item => item.id === 'fleet-cloud-burst:restart-timeout')?.attrs)
      .toMatchObject({ state: 'warming' });
    expect(ledger.list({ kind: 'universe' }).find(item => item.id === 'fleet-cloud-burst:restart-timeout')?.attrs)
      .not.toHaveProperty('joinedAt');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
