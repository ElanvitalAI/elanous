import { describe, expect, test } from 'bun:test';
import { withSimClock } from '../../src/ux-sim/fake-clock.js';
import { createFakeCloudVm } from '../../src/ux-sim/fake-cloud-vm.js';
import type { PluginContext } from '../../src/plugins/core/types.js';
import { createCloudBurstPlugin } from './plugin.js';
import { createMockCloudBurstRuntime } from './mock-runtime.js';
import { getCloudBurstCostReport, requestCloudBurstBasic, type CloudBurstCloudPort } from './service.js';

const EPOCH = Date.parse('2026-11-03T00:00:00Z');
const IMAGE = `sha256:${'a'.repeat(64)}`;

function cloudPort(fleet: ReturnType<typeof createFakeCloudVm>, hourlyCost = 12, readyAfterMs = 5_000): CloudBurstCloudPort {
  return {
    async quote() { return { hourlyCost, readyAfterMs }; },
    async list() { return fleet.statusAll(); },
    async resume(_accountRef, id, options) { return fleet.resume(id, { readyAfterMs: options.readyAfterMs, stopAfterAt: options.stopAfterAt }); },
    async createFromImage(_accountRef, input) { return fleet.createFromImage(input); },
    async status(_accountRef, id) { return fleet.status(id); },
    async stop(_accountRef, id) { return fleet.stop(id); },
    async reportRun(receipt) {
      const current = fleet.status(receipt.vmId);
      const events = fleet.events();
      const startIndex = events.findIndex(event => event.id === receipt.vmId
        && (event.type === 'create-from-image' || event.type === 'resume') && event.at === receipt.startedAt);
      if (startIndex < 0) throw new Error('mock start event missing');
      const stopEvent = events.slice(startIndex + 1).find(event => event.id === receipt.vmId && event.type === 'stop');
      if (stopEvent && stopEvent.type === 'stop') {
        const poweredOnMs = Math.max(0, stopEvent.at - receipt.startedAt);
        return { state: 'parked' as const, poweredOnMs, estimatedCost: poweredOnMs / (60 * 60 * 1000) * receipt.hourlyCost };
      }
      const laterStart = events.slice(startIndex + 1).find(event => event.id === receipt.vmId
        && (event.type === 'create-from-image' || event.type === 'resume'));
      if (laterStart) throw new Error('mock stop event missing before later run');
      const poweredOnMs = Math.max(0, current.poweredOnMs - receipt.baselinePoweredOnMs);
      return { state: current.state, poweredOnMs, estimatedCost: poweredOnMs / (60 * 60 * 1000) * receipt.hourlyCost };
    },
  };
}

describe('cloud-burst basic mock path', () => {
  test('reports a mock run when provider start event occurs after the receipt timestamp', async () => {
    await withSimClock(EPOCH, async clock => {
      const runtime = createMockCloudBurstRuntime({ beforeVmStart: () => clock.tick(1) });
      await runtime.request({ requestId: 'delayed-start', imageDigest: IMAGE, ttlMs: 30 * 60_000 });
      clock.setTime(EPOCH + 31 * 60_000);
      const report = await runtime.report('delayed-start');
      expect(report).toContain('runPoweredOnMs=1799999');
      expect(report).toContain('state=parked');
    });
  });

  test('uses local capacity first, forwards TTL, and does not need an account', async () => {
    await withSimClock(EPOCH, async () => {
      const fleet = createFakeCloudVm();
      let cloudCalls = 0;
      let localTtlMs: number | undefined;
      const cloud = cloudPort(fleet);
      const result = await requestCloudBurstBasic({ requestId: 'local-request', imageDigest: IMAGE, ttlMs: 30 * 60_000 }, {
        local: { async tryAcquire(input) { localTtlMs = input.ttlMs; return { resourceId: 'local-worker-1', expiresAt: Date.now() + input.ttlMs }; } },
        cloud: {
          ...cloud,
          async quote() { cloudCalls += 1; return { hourlyCost: 12, readyAfterMs: 5_000 }; },
          async list() { cloudCalls += 1; return fleet.statusAll(); },
        },
      });

      expect(result).toMatchObject({ source: 'local', resourceId: 'local-worker-1', estimatedCost: 0, expiresAt: EPOCH + 30 * 60_000 });
      expect(localTtlMs).toBe(30 * 60_000);
      expect(cloudCalls).toBe(0);
      expect(fleet.events()).toEqual([]);
    });
  });

  test('resumes a protected matching image and reports only this run at the current provider rate', async () => {
    await withSimClock(EPOCH, async clock => {
      const fleet = createFakeCloudVm();
      fleet.createFromImage({ id: 'warm-1', imageDigest: IMAGE, hourlyCost: 3 });
      clock.tick(10 * 60_000);
      fleet.stop('warm-1');

      let resumedHourlyCost: number | undefined;
      const cloud: CloudBurstCloudPort = {
        ...cloudPort(fleet, 12, 5_000),
        async resume(_accountRef, id, options) {
          resumedHourlyCost = options.hourlyCost;
          return fleet.resume(id, { readyAfterMs: options.readyAfterMs, stopAfterAt: options.stopAfterAt });
        },
      };
      const result = await requestCloudBurstBasic({
        requestId: 'request-warm', accountRef: 'user-cloud-profile', imageDigest: IMAGE, ttlMs: 30 * 60_000,
      }, { local: { async tryAcquire() { return undefined; } }, cloud });

      expect(result).toMatchObject({ source: 'warm', vm: { id: 'warm-1', state: 'warming', terminationProtected: true, stopAfterAt: EPOCH + 40 * 60_000 } });
      if (result.source !== 'warm') throw new Error('expected warm capacity');
      expect(result.receipt.baselinePoweredOnMs).toBe(10 * 60_000);
      expect(resumedHourlyCost).toBe(12);
      expect(fleet.events().filter(event => event.type === 'create-from-image')).toHaveLength(1);
      expect(fleet.events().filter(event => event.type === 'resume')).toHaveLength(1);
      clock.tick(5_000);
      expect(fleet.status('warm-1').state).toBe('ready');
      clock.setTime(EPOCH + 41 * 60_000);
      const stopped = fleet.status('warm-1');
      expect(stopped).toMatchObject({ state: 'parked', poweredOnMs: 40 * 60_000, estimatedCost: 2 });
      const report = await getCloudBurstCostReport(result.receipt, cloud);
      expect(report).toContain('runPoweredOnMs=1800000');
      expect(report).toContain('estimatedCost=6 provider-cost-units');
      expect(report).toContain('state=parked');
      expect(fleet.events().filter(event => event.type === 'stop')).toHaveLength(2);
      expect(fleet.events().some(event => event.type === 'forbidden-terminate')).toBe(false);
    });
  });

  test('skips an unprotected or differently pinned warm VM and creates protected cold capacity', async () => {
    await withSimClock(EPOCH, async () => {
      const fleet = createFakeCloudVm();
      fleet.createFromImage({ id: 'warm-other-image', imageDigest: `sha256:${'b'.repeat(64)}`, hourlyCost: 12 });
      fleet.stop('warm-other-image');
      fleet.createFromImage({ id: 'warm-unprotected', imageDigest: IMAGE, hourlyCost: 12, terminationProtected: false });
      fleet.stop('warm-unprotected');
      const result = await requestCloudBurstBasic({
        requestId: 'request-cold', accountRef: 'user-cloud-profile', imageDigest: IMAGE, ttlMs: 30 * 60_000,
      }, { local: { async tryAcquire() { return undefined; } }, cloud: cloudPort(fleet) });

      expect(result).toMatchObject({ source: 'cold', vm: {
        id: 'request-cold', imageDigest: IMAGE, state: 'warming', terminationProtected: true,
        stopAfterAt: EPOCH + 30 * 60_000,
      } });
      expect(fleet.events().filter(event => event.type === 'create-from-image').map(event => event.id))
        .toEqual(['warm-other-image', 'warm-unprotected', 'request-cold']);
      expect(fleet.events().some(event => event.type === 'resume')).toBe(false);
    });
  });

  test('stops and rejects a provider VM that does not confirm termination protection', async () => {
    const fleet = createFakeCloudVm();
    const cloud: CloudBurstCloudPort = {
      ...cloudPort(fleet),
      async createFromImage(_accountRef, input) { return fleet.createFromImage({ ...input, terminationProtected: false }); },
    };
    await expect(requestCloudBurstBasic({
      requestId: 'request-unprotected', accountRef: 'user-cloud-profile', imageDigest: IMAGE, ttlMs: 30 * 60_000,
    }, { local: { async tryAcquire() { return undefined; } }, cloud }))
      .rejects.toThrow('provider did not confirm termination protection; stopped request-unprotected');
    expect(fleet.status('request-unprotected').state).toBe('parked');
    expect(fleet.events().filter(event => event.type === 'stop')).toHaveLength(1);
  });

  test('starts cloud TTL after asynchronous quote and inventory preflight', async () => {
    await withSimClock(EPOCH, async clock => {
      const fleet = createFakeCloudVm();
      const base = cloudPort(fleet);
      const cloud: CloudBurstCloudPort = {
        ...base,
        async quote() { clock.tick(2 * 60_000); return { hourlyCost: 12, readyAfterMs: 5_000 }; },
        async list() { clock.tick(3 * 60_000); return fleet.statusAll(); },
      };
      const result = await requestCloudBurstBasic({
        requestId: 'request-delayed', accountRef: 'user-cloud-profile', imageDigest: IMAGE, ttlMs: 30 * 60_000,
      }, { local: { async tryAcquire() { return undefined; } }, cloud });
      expect(result).toMatchObject({ source: 'cold', receipt: { startedAt: EPOCH + 5 * 60_000, stopAfterAt: EPOCH + 35 * 60_000 } });
    });
  });

  test('rejects TTL shorter than provider readiness without creating a VM', async () => {
    const fleet = createFakeCloudVm();
    await expect(requestCloudBurstBasic({
      requestId: 'request-short-ttl', accountRef: 'user-cloud-profile', imageDigest: IMAGE, ttlMs: 1_000,
    }, { local: { async tryAcquire() { return undefined; } }, cloud: cloudPort(fleet) }))
      .rejects.toThrow('ttlMs must exceed provider readiness estimate');
    expect(fleet.events()).toEqual([]);
  });

  test('fails closed without account reference after local capacity is exhausted', async () => {
    const fleet = createFakeCloudVm();
    await expect(requestCloudBurstBasic({
      requestId: 'request-no-account', imageDigest: IMAGE, ttlMs: 30 * 60_000,
    }, { local: { async tryAcquire() { return undefined; } }, cloud: cloudPort(fleet) }))
      .rejects.toThrow('connect a user-owned cloud account reference');
    expect(fleet.events()).toEqual([]);
  });

  test('installed mock command path requests a VM and reports its final TTL cost', async () => {
    await withSimClock(EPOCH, async clock => {
      const lines: string[] = [];
      const ctx = { log(line: string) { lines.push(line); } } as PluginContext;
      const plugin = createCloudBurstPlugin();
      await plugin.slashCommands?.[0]?.handler([
        'mock', 'request', '--request-id', 'mock-run', '--image-digest', IMAGE, '--ttl-minutes', '30',
      ], ctx);
      expect(lines[0]).toContain('Cloud Burst run mock-run (mock-run): state=warming');
      expect(lines[0]).toContain('quotedHourlyCost=12 provider-cost-units/hour');
      clock.setTime(EPOCH + 31 * 60_000);
      await plugin.slashCommands?.[0]?.handler(['mock', 'report', '--request-id', 'mock-run'], ctx);
      const firstRunReport = lines[1];
      expect(firstRunReport).toContain('state=parked');
      expect(firstRunReport).toContain('runPoweredOnMs=1800000');
      expect(firstRunReport).toContain('estimatedCost=6 provider-cost-units');

      await plugin.slashCommands?.[0]?.handler([
        'mock', 'request', '--request-id', 'mock-run-2', '--image-digest', IMAGE, '--ttl-minutes', '30',
      ], ctx);
      clock.setTime(EPOCH + 62 * 60_000);
      await plugin.slashCommands?.[0]?.handler(['mock', 'report', '--request-id', 'mock-run'], ctx);
      expect(lines[3]).toBe(firstRunReport);
    });
  });

  test('live command fails closed without an adapter and rejects credential arguments', async () => {
    const lines: string[] = [];
    const ctx = { log(line: string) { lines.push(line); } } as PluginContext;
    const plugin = createCloudBurstPlugin();
    await plugin.slashCommands?.[0]?.handler(['request', '--token', 'secret'], ctx);
    expect(lines[0]).toContain('Do not pass credential values');
    expect(lines.join(' ')).not.toContain('secret');
    await plugin.slashCommands?.[0]?.handler(['request'], ctx);
    expect(lines[1]).toContain('Live provider adapter is not connected');
  });
});
