import { describe, expect, test } from 'bun:test';
import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import { connect as capturedNetConnect } from 'node:net';
import tls from 'node:tls';
import { withSimClock } from './fake-clock.js';
import { createFakeCloudVm } from './fake-cloud-vm.js';

const EPOCH = Date.parse('2026-11-02T00:00:00Z');

async function withNetworkGuard<T>(run: () => Promise<T>, expectedBlockedCalls = 0): Promise<T> {
  const originalFetch = globalThis.fetch;
  const bunRuntime = (globalThis as typeof globalThis & { Bun?: Record<string, unknown> }).Bun;
  const restores: Array<() => void> = [];
  let networkCalls = 0;
  const rejectNetwork = (surface: string) => {
    networkCalls += 1;
    throw new Error(`grid simulation attempted network/process access through ${surface}`);
  };
  const blockFunction = (target: object, key: string, surface: string) => {
    const mutable = target as Record<string, unknown>;
    const descriptor = Object.getOwnPropertyDescriptor(mutable, key);
    const original = mutable[key];
    if (typeof original !== 'function') return;
    const blocked = function blockedNetworkOrProcessApi() { return rejectNetwork(surface); };
    if (descriptor?.configurable) {
      Object.defineProperty(mutable, key, { ...descriptor, value: blocked });
      restores.push(() => Object.defineProperty(mutable, key, descriptor));
    } else if (descriptor?.writable) {
      mutable[key] = blocked;
      restores.push(() => { mutable[key] = original; });
    }
  };
  const fetchGuard = Object.assign(async () => rejectNetwork('fetch'), {
    preconnect: () => rejectNetwork('fetch.preconnect'),
  }) as typeof fetch;
  globalThis.fetch = fetchGuard;
  try {
    for (const [module, names, prefix] of [
      [dns, ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt'], 'dns'],
      [dnsPromises, ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt'], 'dns.promises'],
      [net, ['connect', 'createConnection'], 'net'],
      [tls, ['connect'], 'tls'],
      [http, ['request', 'get'], 'http'],
      [https, ['request', 'get'], 'https'],
      [http2, ['connect'], 'http2'],
      [dgram, ['createSocket'], 'dgram'],
      [childProcess, ['spawn', 'exec', 'execFile', 'fork', 'spawnSync', 'execSync', 'execFileSync'], 'child_process'],
    ] as const) {
      for (const name of names) blockFunction(module, name, `${prefix}.${name}`);
    }
    blockFunction(net.Socket.prototype, 'connect', 'net.Socket.connect');
    if (bunRuntime) {
      blockFunction(bunRuntime, 'fetch', 'Bun.fetch');
      for (const name of ['connect', 'spawn', 'spawnSync']) blockFunction(bunRuntime, name, `Bun.${name}`);
    }
    for (const name of ['WebSocket', 'WebSocketStream', 'EventSource', 'XMLHttpRequest']) {
      blockFunction(globalThis, name, name);
    }
    const result = await run();
    expect(networkCalls).toBe(expectedBlockedCalls);
    return result;
  } finally {
    globalThis.fetch = originalFetch;
    for (const restore of restores.reverse()) restore();
  }
}

async function runPaidStopScenario() {
  return withNetworkGuard(() => withSimClock(EPOCH, async (clock) => {
    const fleet = createFakeCloudVm();
    fleet.createFromImage({
      id: 'aws2', imageDigest: 'sha256:grid-image', hourlyCost: 36, readyAfterMs: 100,
      stopAfterAt: EPOCH + 1_000,
    });
    clock.tick(100);
    expect(fleet.status('aws2').state).toBe('ready');
    fleet.openLease('aws2');

    clock.tick(900);
    expect(fleet.status('aws2')).toMatchObject({ state: 'draining', activeLeases: 1 });
    expect(() => fleet.openLease('aws2')).toThrow('new lease refused');
    clock.tick(250);
    const stopped = fleet.closeLease('aws2');

    expect(stopped).toMatchObject({ state: 'parked', activeLeases: 0, poweredOnMs: 1_250, estimatedCost: 0.0125 });
    expect(fleet.events().map((event) => event.type)).toEqual([
      'create-from-image', 'ready', 'lease-opened', 'stop-after-draining', 'lease-closed', 'stop',
    ]);
    expect(fleet.events().filter((event) => event.type === 'stop-after-draining' || event.type === 'stop').map((event) => event.at))
      .toEqual([EPOCH + 1_000, EPOCH + 1_250]);
    expect(fleet.events().some((event) => event.type === 'forbidden-terminate')).toBe(false);
    return { snapshot: stopped, events: fleet.events() };
  }));
}

async function runBurstWindowScenario() {
  return withNetworkGuard(() => withSimClock(EPOCH, async (clock) => {
    const fleet = createFakeCloudVm();
    fleet.createFromImage({ id: 'aws2', imageDigest: 'sha256:grid-image', hourlyCost: 36 });
    clock.tick(1_000);
    fleet.stop('aws2');

    clock.tick(1_000);
    expect(fleet.status('aws2').state).toBe('parked');
    const resumed = fleet.resume('aws2', { readyAfterMs: 500, stopAfterAt: EPOCH + 7_000 });
    expect(resumed.state).toBe('warming');
    clock.tick(500);
    expect(fleet.status('aws2').state).toBe('ready');
    fleet.openLease('aws2');

    clock.tick(4_500);
    expect(fleet.status('aws2')).toMatchObject({ state: 'draining', activeLeases: 1 });
    expect(() => fleet.openLease('aws2')).toThrow('new lease refused');
    const stopped = fleet.closeLease('aws2');

    expect(stopped).toMatchObject({ state: 'parked', activeLeases: 0, poweredOnMs: 6_000 });
    expect(stopped.estimatedCost).toBeCloseTo(0.06, 10);
    expect(fleet.events().filter((event) => event.type === 'stop')).toHaveLength(2);
    expect(fleet.events().some((event) => event.type === 'forbidden-terminate')).toBe(false);
    return { snapshot: stopped, events: fleet.events() };
  }));
}

type ReadyTierAction =
  | { readonly tier: 'pending'; readonly action: 'wait'; readonly hostId: string; readonly readyAfterMs: number }
  | { readonly tier: 'hot'; readonly action: 'lease'; readonly hostId: string; readonly imageDigest: string }
  | {
      readonly tier: 'warm';
      readonly action: 'resume';
      readonly hostId: string;
      readonly imageDigest: string;
      readonly readyAfterMs: number;
      readonly stopAfterAt: number;
    }
  | {
      readonly tier: 'cold';
      readonly action: 'create-from-image';
      readonly vmId: string;
      readonly imageDigest: string;
      readonly hourlyCost: number;
      readonly readyAfterMs: number;
      readonly stopAfterAt: number;
      readonly approvalId: string;
    };

interface ReadyTierDecisionInput {
  readonly demand: number;
  readonly hosts: ReadonlyArray<{ readonly vm: ReturnType<ReturnType<typeof createFakeCloudVm>['status']> }>;
  readonly imageDigest: string;
  readonly stopAfterAt?: number;
  readonly provision?: { readonly vmId: string; readonly hourlyCost: number };
}

function assertActionMatchesInput(input: ReadyTierDecisionInput, action: ReadyTierAction): void {
  if (action.tier === 'hot') {
    const host = input.hosts.find(({ vm }) => vm.id === action.hostId)?.vm;
    if (!host || host.imageDigest !== input.imageDigest || action.imageDigest !== input.imageDigest) {
      throw new Error('hot host image digest does not match the requested image digest');
    }
  }
  if (action.tier === 'warm') {
    const host = input.hosts.find(({ vm }) => vm.id === action.hostId)?.vm;
    if (!host || host.imageDigest !== input.imageDigest || action.imageDigest !== input.imageDigest) {
      throw new Error('warm host image digest does not match the requested image digest');
    }
  }
  if (action.tier === 'cold') {
    if (action.imageDigest !== input.imageDigest) {
      throw new Error('cold image digest does not match the requested image digest');
    }
    if (input.stopAfterAt === undefined || action.stopAfterAt !== input.stopAfterAt) {
      throw new Error('cold stopAfterAt was not propagated from the request');
    }
  }
  if (action.tier === 'warm' && (input.stopAfterAt === undefined || action.stopAfterAt !== input.stopAfterAt)) {
    throw new Error('warm stopAfterAt was not propagated from the request');
  }
}

function resumeWarmHost(
  fleet: ReturnType<typeof createFakeCloudVm>,
  input: ReadyTierDecisionInput,
  action: Extract<ReadyTierAction, { readonly tier: 'warm' }>,
) {
  assertActionMatchesInput(input, action);
  return fleet.resume(action.hostId, { readyAfterMs: action.readyAfterMs, stopAfterAt: input.stopAfterAt });
}

/** Test-local response stub for the separately owned GRID-READY-TIERS seam. */
function createMockReadyTierDecider(actions: readonly ReadyTierAction[]) {
  let index = 0;
  const inputs: ReadyTierDecisionInput[] = [];
  return {
    decide(input: ReadyTierDecisionInput): ReadyTierAction | undefined {
      inputs.push(input);
      if (input.demand <= 0) return undefined;
      const action = actions[index++];
      if (!action) throw new Error('mock readiness tier returned no action for positive demand');
      return action;
    },
    inputs,
  };
}

async function runStandbyTiersScenario() {
  return withNetworkGuard(() => withSimClock(EPOCH, async (clock) => {
    const fleet = createFakeCloudVm();
    const imageDigest = 'sha256:grid-image';
    const decider = createMockReadyTierDecider([
      { tier: 'pending', action: 'wait', hostId: 'warm', readyAfterMs: 250 },
      { tier: 'hot', action: 'lease', hostId: 'warm', imageDigest },
      { tier: 'warm', action: 'resume', hostId: 'parked', imageDigest, readyAfterMs: 200, stopAfterAt: EPOCH + 3_000 },
      {
        tier: 'cold', action: 'create-from-image', vmId: 'cold', imageDigest,
        hourlyCost: 36, readyAfterMs: 800, stopAfterAt: EPOCH + 4_000, approvalId: 'approval-cold-1',
      },
    ]);
    const coldProvisionApprovals: string[] = [];
    const consumedApprovals = new Set<string>();

    fleet.createFromImage({ id: 'warm', imageDigest, hourlyCost: 36, readyAfterMs: 250 });
    fleet.createFromImage({ id: 'parked', imageDigest, hourlyCost: 36 });
    fleet.stop('parked');

    // The readiness-tier owner is represented only by this response mock;
    // every selected action runs through the existing fake-cloud VM device.
    let remainingDemand = 3;
    while (remainingDemand > 0) {
      const input: ReadyTierDecisionInput = {
        demand: remainingDemand,
        hosts: fleet.statusAll().map((vm) => ({ vm })),
        imageDigest,
        ...(remainingDemand === 2 ? { stopAfterAt: EPOCH + 3_000 } : remainingDemand === 1 ? { stopAfterAt: EPOCH + 4_000 } : {}),
        provision: { vmId: 'cold', hourlyCost: 36 },
      };
      const action = decider.decide(input);
      expect(action).toBeDefined();
      if (!action) throw new Error('positive demand must select one readiness tier action');
      assertActionMatchesInput(input, action);

      if (action.tier === 'pending') {
        expect(action.action).toBe('wait');
        expect(fleet.status(action.hostId).state).toBe('warming');
        clock.tick(action.readyAfterMs);
        expect(fleet.status(action.hostId).state).toBe('ready');
      } else if (action.tier === 'hot') {
        expect(action.action).toBe('lease');
        expect(input.hosts.find(({ vm }) => vm.id === action.hostId)?.vm.imageDigest).toBe(action.imageDigest);
        fleet.openLease(action.hostId);
        remainingDemand -= 1;
      } else if (action.tier === 'warm') {
        expect(action.action).toBe('resume');
        resumeWarmHost(fleet, input, action);
        clock.tick(action.readyAfterMs);
        expect(fleet.status(action.hostId).state).toBe('ready');
        fleet.openLease(action.hostId);
        remainingDemand -= 1;
      } else {
        expect(action.action).toBe('create-from-image');
        expect(input.provision).toEqual({ vmId: action.vmId, hourlyCost: action.hourlyCost });
        expect(consumedApprovals.has(action.approvalId)).toBe(false);
        consumedApprovals.add(action.approvalId);
        coldProvisionApprovals.push(action.approvalId);
        fleet.createFromImage({
          id: action.vmId, imageDigest: action.imageDigest, hourlyCost: action.hourlyCost,
          readyAfterMs: action.readyAfterMs, stopAfterAt: input.stopAfterAt,
        });
        clock.tick(action.readyAfterMs);
        expect(fleet.status(action.vmId).state).toBe('ready');
        fleet.openLease(action.vmId);
        remainingDemand -= 1;
      }
    }

    expect(decider.inputs.map(({ demand }) => demand)).toEqual([3, 3, 2, 1]);
    expect(decider.inputs.map(({ hosts }) => hosts.map(({ vm }) => [vm.id, vm.state, vm.activeLeases]))).toEqual([
      [['parked', 'parked', 0], ['warm', 'warming', 0]],
      [['parked', 'parked', 0], ['warm', 'ready', 0]],
      [['parked', 'parked', 0], ['warm', 'ready', 1]],
      [['parked', 'ready', 1], ['warm', 'ready', 1]],
    ]);
    expect(coldProvisionApprovals).toEqual(['approval-cold-1']);
    expect(consumedApprovals.size).toBe(1);
    expect(fleet.status('parked').stopAfterAt).toBe(EPOCH + 3_000);
    expect(fleet.status('cold').stopAfterAt).toBe(EPOCH + 4_000);
    expect(fleet.statusAll().map(({ id, state, activeLeases }) => ({ id, state, activeLeases }))).toEqual([
      { id: 'cold', state: 'ready', activeLeases: 1 },
      { id: 'parked', state: 'ready', activeLeases: 1 },
      { id: 'warm', state: 'ready', activeLeases: 1 },
    ]);
    expect(fleet.events().filter((event) => event.type === 'create-from-image' && event.id === 'cold')).toHaveLength(1);
    expect(fleet.events().filter((event) => event.type === 'lease-opened').map((event) => event.id))
      .toEqual(['warm', 'parked', 'cold']);
    expect(fleet.events().some((event) => event.type === 'forbidden-terminate')).toBe(false);

    for (const id of ['warm', 'parked', 'cold']) {
      fleet.closeLease(id);
      fleet.stop(id);
    }
    expect(fleet.events().map((event) => event.type)).toEqual([
      'create-from-image', 'create-from-image', 'ready', 'stop', 'ready', 'lease-opened', 'resume', 'ready',
      'lease-opened', 'create-from-image', 'ready', 'lease-opened', 'lease-closed', 'stop', 'lease-closed',
      'stop', 'lease-closed', 'stop',
    ]);
    return { snapshots: fleet.statusAll(), events: fleet.events(), coldProvisionApprovals };
  }));
}

describe('grid cloud capacity scenarios (S7, S13, S15)', () => {
  test('readiness actions reject a changed requested image digest', async () => {
    await withNetworkGuard(() => withSimClock(EPOCH, async () => {
      const fleet = createFakeCloudVm();
      fleet.createFromImage({ id: 'matching', imageDigest: 'sha256:grid-image', hourlyCost: 36 });
      const input: ReadyTierDecisionInput = {
        demand: 1,
        hosts: fleet.statusAll().map((vm) => ({ vm })),
        imageDigest: 'sha256:other-image',
      };
      expect(() => assertActionMatchesInput(input, {
        tier: 'hot', action: 'lease', hostId: 'matching', imageDigest: 'sha256:grid-image',
      })).toThrow('hot host image digest does not match the requested image digest');
      expect(() => assertActionMatchesInput(input, {
        tier: 'cold', action: 'create-from-image', vmId: 'cold', imageDigest: 'sha256:grid-image',
        hourlyCost: 36, readyAfterMs: 1, stopAfterAt: EPOCH + 10, approvalId: 'approval',
      })).toThrow('cold image digest does not match the requested image digest');
    }));
  });

  test('warm and cold requests require the input stopAfterAt to reach the VM', async () => {
    await withNetworkGuard(() => withSimClock(EPOCH, async () => {
      const fleet = createFakeCloudVm();
      fleet.createFromImage({ id: 'parked', imageDigest: 'sha256:grid-image', hourlyCost: 36 });
      fleet.stop('parked');
      const input: ReadyTierDecisionInput = {
        demand: 1,
        hosts: fleet.statusAll().map((vm) => ({ vm })),
        imageDigest: 'sha256:grid-image', stopAfterAt: EPOCH + 10,
      };
      expect(() => assertActionMatchesInput(input, {
        tier: 'warm', action: 'resume', hostId: 'parked', imageDigest: input.imageDigest,
        readyAfterMs: 1, stopAfterAt: EPOCH + 11,
      })).toThrow('warm stopAfterAt was not propagated from the request');
      expect(() => assertActionMatchesInput(input, {
        tier: 'cold', action: 'create-from-image', vmId: 'cold', imageDigest: input.imageDigest,
        hourlyCost: 36, readyAfterMs: 1, stopAfterAt: EPOCH + 11, approvalId: 'approval',
      })).toThrow('cold stopAfterAt was not propagated from the request');
    }));
  });

  test('warm resume rejects a parked host with a different image digest', async () => {
    await withNetworkGuard(() => withSimClock(EPOCH, async (clock) => {
      const fleet = createFakeCloudVm();
      fleet.createFromImage({ id: 'parked', imageDigest: 'sha256:old-image', hourlyCost: 36 });
      fleet.stop('parked');
      const input: ReadyTierDecisionInput = {
        demand: 1,
        hosts: fleet.statusAll().map((vm) => ({ vm })),
        imageDigest: 'sha256:grid-image', stopAfterAt: EPOCH + 1_000,
      };
      const action: Extract<ReadyTierAction, { readonly tier: 'warm' }> = {
        tier: 'warm', action: 'resume', hostId: 'parked', imageDigest: input.imageDigest,
        readyAfterMs: 100, stopAfterAt: input.stopAfterAt!,
      };
      expect(() => resumeWarmHost(fleet, input, action)).toThrow('warm host image digest does not match the requested image digest');
      expect(fleet.status('parked').state).toBe('parked');
      expect(fleet.events().filter((event) => event.type === 'resume')).toHaveLength(0);

      const matchingFleet = createFakeCloudVm();
      matchingFleet.createFromImage({ id: 'parked', imageDigest: input.imageDigest, hourlyCost: 36 });
      matchingFleet.stop('parked');
      const matchingInput: ReadyTierDecisionInput = {
        ...input, stopAfterAt: EPOCH + 10_000,
        hosts: matchingFleet.statusAll().map((vm) => ({ vm })),
      };
      const matchingAction = { ...action, stopAfterAt: matchingInput.stopAfterAt! };
      clock.tick(100);
      expect(resumeWarmHost(matchingFleet, matchingInput, matchingAction).state).toBe('warming');
      expect(matchingFleet.events().filter((event) => event.type === 'resume')).toHaveLength(1);
    }));
  });

  test('network guard blocks DNS, socket and process entry points', async () => {
    await withNetworkGuard(async () => {
      try { dnsPromises.lookup('guard.invalid'); } catch { /* expected guard rejection */ }
      try { Reflect.apply(net.Socket.prototype.connect, new net.Socket(), [1, '127.0.0.1']); } catch { /* expected guard rejection */ }
      try { capturedNetConnect(1, '127.0.0.1'); } catch { /* expected guard rejection */ }
      try { childProcess.spawn('true'); } catch { /* expected guard rejection */ }
    }, 4);
  });

  test('S7 paid stop drains existing work and refuses new leases until stop', async () => {
    expect(await runPaidStopScenario()).toEqual(await runPaidStopScenario());
  });

  test('S13 burst window resumes only for the window and parks after lease drain', async () => {
    expect(await runBurstWindowScenario()).toEqual(await runBurstWindowScenario());
  });

  test('S15 consumes warm, preserved, then cold tiers with one cold approval', async () => {
    expect(await runStandbyTiersScenario()).toEqual(await runStandbyTiersScenario());
  });
});
