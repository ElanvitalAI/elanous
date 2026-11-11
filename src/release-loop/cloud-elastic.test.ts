import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { withSimClock } from '../ux-sim/fake-clock.js';
import { createFakeCloudProvider } from '../ux-sim/fake-cloud-vm.js';
import { ResourceLedger } from '../control-plane/ledger.js';
import { runCloudElasticRecipe, CLOUD_ELASTIC_MONTHLY_CAP_KRW, CLOUD_ELASTIC_RECIPE_NODES, cloudElasticRecipeNodes, createNexusCloudElasticEventSink } from './cloud-elastic.js';

const EPOCH = Date.parse('2026-11-06T00:00:00Z');
const request = { id: 'rehearsal-vm', event: 'hard-rehearsal-regression', purpose: 'gate-bisect', provider: 'gcp' as const,
  hostType: 'n2-highmem-8', imageDigest: `sha256:${'a'.repeat(64)}`, expectedHours: 2, hourlyCostKrw: 120_000 };

describe('RLA-CLOUD-ELASTIC fake-provider recipe', () => {
  test('binds the existing cloud join and leave hand tools as ordered recipe nodes', async () => {
    const calls: string[] = [];
    const nodes = cloudElasticRecipeNodes(async (script) => { calls.push(script); });
    await nodes.join({} as never);
    await nodes.leave({} as never);
    expect(calls).toEqual([CLOUD_ELASTIC_RECIPE_NODES.join.script, CLOUD_ELASTIC_RECIPE_NODES.leave.script]);
    expect(CLOUD_ELASTIC_RECIPE_NODES.join.script).toContain('cloud-join.sh');
    expect(CLOUD_ELASTIC_RECIPE_NODES.leave.script).toContain('cloud-leave.sh');
    const recipes = parseYaml(readFileSync(join(import.meta.dir, '../../graphs/release/recipes.yaml'), 'utf8')) as Record<string, { command: string; timeout_ms: number }>;
    // Source: .rules/30-harness/testing-gates.md — join recipe budget covers its enforced maximum hand-tool window.
    expect(recipes['cloud-join']).toEqual({ command: 'bun scripts/release-loop/cloud-elastic-node.ts join', timeout_ms: 10_800_000 });
    // Source: .rules/30-harness/testing-gates.md — leave recipe budget covers its enforced cleanup window.
    expect(recipes['cloud-leave']).toEqual({ command: 'bun scripts/release-loop/cloud-elastic-node.ts leave', timeout_ms: 7_200_000 });
    const graph = parseYaml(readFileSync(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), 'utf8')) as { nodes: Array<{ node_id: string; max_visits: number }> };
    const visits = new Map(graph.nodes.map(node => [node.node_id, node.max_visits]));
    expect(visits.get('gate')).toBe(4);
    for (const node of ['cloud-leave-ok', 'cloud-leave-fail', 'cloud-leave-error', 'cloud-leave-join-fail']) expect(visits.get(node)).toBe(visits.get('gate'));
    expect(readFileSync(join(import.meta.dir, '../../scripts/release-loop/cloud-elastic-node.ts'), 'utf8')).toContain("'cloud-join.sh' : 'cloud-leave.sh'");
    expect(CLOUD_ELASTIC_RECIPE_NODES.join.recipe).toBe('cmd:cloud-join');
    expect(CLOUD_ELASTIC_RECIPE_NODES.leave.recipe).toBe('cmd:cloud-leave');
  });
  test('records request → delayed start → join → work → stop with bounded cost', async () => {
    await withSimClock(EPOCH, async (clock) => {
      const provider = createFakeCloudProvider({ monthlySpentKrw: 4_000_000, monthlyCapKrw: CLOUD_ELASTIC_MONTHLY_CAP_KRW, readyAfterMs: 5_000 });
      const root = mkdtempSync(join(tmpdir(), 'cloud-elastic-ledger-'));
      try {
        const ledger = new ResourceLedger(root);
        const result = await runCloudElasticRecipe(request, provider, async () => { clock.tick(5_000); }, async () => { clock.tick(30 * 60_000); }, undefined,
          createNexusCloudElasticEventSink(ledger));
        expect(result.status).toBe('left');
        expect(result.events.map((event) => event.type)).toEqual(['request', 'start', 'join', 'work', 'leave']);
        expect(result.costKrw).toBeCloseTo(60_166.67, 2);
        // Source: .rules/30-harness/testing-gates.md — fixture cost and spend remain below the configured monthly cap.
        expect(result.costKrw + result.spentBeforeKrw).toBeLessThanOrEqual(5_000_000);
        expect(result.vmState).toBe('parked');
        const rows = ledger.list({ kind: 'universe' }).filter((row) => row.attrs.recordType === 'release-loop-cloud-elastic-event');
        expect(rows.map((row) => row.attrs.eventName)).toEqual(result.events.map((event) => `release-loop.cloud-elastic/${event.type}`));
        expect(rows.at(-1)?.attrs).toMatchObject({ eventType: 'leave', detail: expect.stringContaining('estimatedCostKrw=') });
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  });

  test('blocks requests over the remaining monthly cap before creating a VM', async () => {
    await withSimClock(EPOCH, async () => {
      const provider = createFakeCloudProvider({ monthlySpentKrw: 4_900_000, monthlyCapKrw: CLOUD_ELASTIC_MONTHLY_CAP_KRW });
      const events: string[] = [];
      await expect(runCloudElasticRecipe({ ...request, expectedHours: 1 }, provider, async () => {}, async () => {}, undefined,
        (event) => events.push(event.type))).rejects.toThrow('monthly cap');
      expect(provider.events().some((event) => event.type === 'vm-started')).toBe(false);
      expect(provider.vms().length).toBe(0);
      expect(events).toEqual(['request', 'start-denied']);
    });
  });

  test('the release recipe keeps its 5,000,000 KRW ceiling even if a provider is configured more loosely', async () => {
    await withSimClock(EPOCH, async () => {
      const provider = createFakeCloudProvider({ monthlySpentKrw: 4_900_000, monthlyCapKrw: 50_000_000 });
      const events: string[] = [];
      await expect(runCloudElasticRecipe({ ...request, expectedHours: 1 }, provider, async () => {}, async () => {}, undefined,
        (event) => events.push(event.type))).rejects.toThrow('monthly cap');
      expect(provider.vms()).toHaveLength(0);
      expect(events).toEqual(['request', 'start-denied']);
    });
  });

  // Source: .rules/30-harness/testing-gates.md — concurrent active reservations must share the fixed release cap.
  test('serializes the fixed monthly cap across simultaneous starts even when provider cap is loose', async () => {
    await withSimClock(EPOCH, async () => {
      const provider = createFakeCloudProvider({ quota: 2, monthlyCapKrw: 50_000_000 });
      let workStarted!: () => void; const started = new Promise<void>(resolve => { workStarted = resolve; });
      let finishWork!: () => void; const workHold = new Promise<void>(resolve => { finishWork = resolve; });
      const largeRequest = { ...request, id: 'cap-race-a', expectedHours: 1, hourlyCostKrw: 3_000_000 };
      const first = runCloudElasticRecipe(largeRequest, provider, async () => {}, async () => { workStarted(); await workHold; });
      await started;
      const denied: string[] = [];
      await expect(runCloudElasticRecipe({ ...largeRequest, id: 'cap-race-b' }, provider, async () => {}, async () => {}, undefined,
        event => denied.push(event.type))).rejects.toThrow('monthly cap');
      finishWork();
      await first;
      expect(provider.events().filter(event => event.type === 'vm-started').map(event => event.id)).toEqual(['cap-race-a']);
      expect(denied).toEqual(['request', 'start-denied']);
    });
  });

  // Source: .rules/30-harness/testing-gates.md — elapsed active VM cost remains budgeted when its initial estimate is exceeded.
  test('charges elapsed active VM cost before another request when the provider cap is looser', async () => {
    await withSimClock(EPOCH, async (clock) => {
      const provider = createFakeCloudProvider({ quota: 2, monthlyCapKrw: 50_000_000 });
      let workStarted!: () => void; const started = new Promise<void>(resolve => { workStarted = resolve; });
      let finishWork!: () => void; const workHold = new Promise<void>(resolve => { finishWork = resolve; });
      const active = runCloudElasticRecipe({ ...request, id: 'elapsed-active', expectedHours: 1, hourlyCostKrw: 1_000_000 },
        provider, async () => {}, async () => { workStarted(); await workHold; });
      await started;
      // Source: the five-hour fixture accrues 5,000,000 KRW at 1,000,000 KRW/hour.
      clock.tick(5 * 60 * 60_000);
      await expect(runCloudElasticRecipe({ ...request, id: 'elapsed-next', expectedHours: 1, hourlyCostKrw: 1_000_000 },
        provider, async () => {}, async () => {})).rejects.toThrow('monthly cap');
      finishWork();
      await active;
      expect(provider.events().filter(event => event.type === 'vm-started').map(event => event.id)).toEqual(['elapsed-active']);
      expect(provider.events().filter(event => event.type === 'start-requested').map(event => event.id)).toEqual(['elapsed-active']);
    });
  });

  test('quota and provider start failure do not join or leave a phantom VM', async () => {
    await withSimClock(EPOCH, async () => {
      for (const provider of [createFakeCloudProvider({ quota: 0 }), createFakeCloudProvider({ failStart: true })]) {
        await expect(runCloudElasticRecipe(request, provider, async () => {}, async () => {})).rejects.toThrow();
        expect(provider.events().some((event) => event.type === 'joined')).toBe(false);
        expect(provider.vms().length).toBe(0);
      }
    });
  });

  test('the fake provider carries actual stopped cost into the next monthly-cap decision', async () => {
    await withSimClock(EPOCH, async (clock) => {
      const provider = createFakeCloudProvider({ monthlySpentKrw: 4_400_000, monthlyCapKrw: 5_000_000 });
      provider.start({ id: 'first', imageDigest: request.imageDigest, expectedHours: 1, hourlyCostKrw: 600_000 });
      clock.tick(60_000);
      provider.leave('first');
      expect(provider.monthlySpentKrw).toBeCloseTo(4_410_000, 2);
      expect(() => provider.start({ id: 'second', imageDigest: request.imageDigest, expectedHours: 1, hourlyCostKrw: 600_000 })).toThrow('monthly cap');
    });
  });

  test('the fake provider charges active VM elapsed cost before approving another reservation', async () => {
    await withSimClock(EPOCH, (clock) => {
      const provider = createFakeCloudProvider({ quota: 2, monthlyCapKrw: 5_000_000 });
      provider.start({ id: 'first', imageDigest: request.imageDigest, expectedHours: 1, hourlyCostKrw: 1_000_000 });
      clock.tick(5 * 60 * 60_000);

      expect(() => provider.start({ id: 'second', imageDigest: request.imageDigest, expectedHours: 1, hourlyCostKrw: 1_000_000 }))
        .toThrow('monthly cap');
      expect(provider.events().at(-1)).toMatchObject({ type: 'start-denied', id: 'second', reason: 'monthly-cap' });
    });
  });

  test('reuses of the same VM id append distinct Nexus event rows across sink instances', async () => {
    await withSimClock(EPOCH, async (clock) => {
      const root = mkdtempSync(join(tmpdir(), 'cloud-elastic-repeat-ledger-'));
      try {
        const ledger = new ResourceLedger(root);
        for (let run = 0; run < 2; run++) {
          const provider = createFakeCloudProvider({ readyAfterMs: 0 });
          await runCloudElasticRecipe(request, provider, async () => {}, async () => { clock.tick(60_000); }, undefined,
            createNexusCloudElasticEventSink(ledger));
        }
        const rows = ledger.list({ kind: 'universe' }).filter((row) => row.attrs.recordType === 'release-loop-cloud-elastic-event');
        expect(rows).toHaveLength(10);
        expect(new Set(rows.map((row) => row.id)).size).toBe(10);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  });

  test('a start-event ledger failure still drains and stops the VM', async () => {
    await withSimClock(EPOCH, async () => {
      const provider = createFakeCloudProvider({ readyAfterMs: 0 });
      await expect(runCloudElasticRecipe(request, provider, async () => {}, async () => {}, undefined, (event) => {
        if (event.type === 'start') throw new Error('ledger unavailable');
      })).rejects.toThrow('ledger unavailable');
      expect(provider.vms()[0]?.state).toBe('parked');
      expect(provider.events().some((event) => event.type === 'left')).toBe(true);
    });
  });

  test('join or work failures use the configured leave node and still record stop cost', async () => {
    await withSimClock(EPOCH, async (clock) => {
      for (const failingStage of ['join', 'work'] as const) {
        const provider = createFakeCloudProvider({ readyAfterMs: 0 });
        let leaveCalls = 0;
        const join = async () => { if (failingStage === 'join') throw new Error('join failed'); };
        const work = async () => { clock.tick(60_000); if (failingStage === 'work') throw new Error('work failed'); };
        const leave = async (vm: { id: string }) => { leaveCalls++; provider.leave(vm.id); };
        await expect(runCloudElasticRecipe(request, provider, join, work, leave)).rejects.toThrow(`${failingStage} failed`);
        expect(leaveCalls).toBe(1);
        expect(provider.vms()[0]?.state).toBe('parked');
        expect(provider.events().some((event) => event.type === 'left')).toBe(true);
      }
    });
  });

  test('quota is released after stop so a sequential VM request can start', async () => {
    await withSimClock(EPOCH, () => {
      const provider = createFakeCloudProvider({ quota: 1 });
      provider.start({ id: 'first', imageDigest: request.imageDigest, expectedHours: 1, hourlyCostKrw: 1 });
      provider.leave('first');
      expect(provider.start({ id: 'second', imageDigest: request.imageDigest, expectedHours: 1, hourlyCostKrw: 1 }).id).toBe('second');
    });
  });

  test('leave failure is visible as an orphan and blocks successful completion', async () => {
    await withSimClock(EPOCH, async (clock) => {
      const provider = createFakeCloudProvider({ readyAfterMs: 0 });
      const events: string[] = [];
      await expect(runCloudElasticRecipe(request, provider, async () => {}, async () => { clock.tick(60_000); }, async () => { throw new Error('leave failed'); },
        (event) => events.push(event.type))).rejects.toThrow('orphan VM');
      expect(provider.events().at(-1)?.type).toBe('orphan');
      expect(provider.vms()[0]?.state).toBe('ready');
      expect(events).toEqual(['request', 'start', 'join', 'work', 'orphan']);
    });
  });
});
