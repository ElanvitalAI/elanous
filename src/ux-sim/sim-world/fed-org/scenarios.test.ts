// fed-org sim world — scenario verdicts (seeds) ⊕ model invariants ⊕ pack/expect registration.
// Expected values are literals chosen from the model's contract, never re-derived from the product functions.
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseSimWorldExpectTable } from '../expect.js';
import { isReservedSimWorldId } from '../kernel.js';
import type { SimWorldScenarioContext } from '../types.js';
import { BODIES, simulateBodies } from './body.js';
import { recoverAfterEnd } from './experiments.js';
import { seededRandom, simulate, STRUCTURES } from './model.js';
import { simWorldDevices, simWorldScenarios } from './scenarios.js';

setDefaultTimeout(120_000);

// 출처: fed-ontology-bottleneck-REPORT §2.4 (#185892 ✋ 13h 무상향) — S0 hides ✋ for many hours; 10 h is the floor.
const S0_HIDDEN_ASK_P95_MIN = 600;
// 출처: #40318 ✋ ladder (10 min → owner · 20 min → OP · 60 min → CEO) — S1 bounds ✋ resolution under 2 h.
const S1_LADDER_P95_MAX_MIN = 120;
// 출처: fed-chatlog 2322 fan-in TC 168/h — the hub carries > 100 mails/h; domain routing leaves only tech ✋ (< 5/h).
const HUB_TC_INBOUND_MIN = 100;
const DOMAIN_TC_INBOUND_MAX = 5;

function makeCtx(seed: number) {
  const events: { kind: string; data: unknown }[] = [];
  const devices = new Map<string, unknown>();
  for (const def of simWorldDevices) devices.set(def.id, (def.create as () => unknown)());
  const ctx = {
    world: 'fed-org', scenarioId: 'x', seed, engine: 'legacy', universeRoot: '/nonexistent-fed-org-universe',
    recorder: { event: (kind: string, data: unknown) => { events.push({ kind, data }); } },
    device: <T>(id: string) => devices.get(id) as T,
    random: seededRandom(seed),
  } as unknown as SimWorldScenarioContext;
  return { ctx, events };
}

describe('fed-org scenarios (seeds 1–3)', () => {
  for (const scenario of simWorldScenarios) {
    for (const seed of [1, 2, 3]) {
      // seed-independent scenarios (fixed seed lists inside) run once
      if (seed > 1 && scenario.id !== 'FED-ORG-DETERMINISM') continue;
      test(`${scenario.id} seed ${seed} → green`, async () => {
        const { ctx, events } = makeCtx(seed);
        const outcome = await scenario.run(ctx);
        expect(outcome).toEqual({ ok: true });
        expect(events.length).toBe(1);
      });
    }
  }
});

describe('fed-org model invariants', () => {
  test('seeded PRNG is reproducible and in [0,1)', () => {
    const a = seededRandom(42); const b = seededRandom(42);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(xs).toEqual(Array.from({ length: 1000 }, () => b()));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
  });

  test('a day is 24 hourly buckets; hand utilisation and shares are fractions', () => {
    for (const id of ['S0', 'S1', 'S2', 'S3', 'S4'] as const) {
      const r = simulate({ structure: id, seed: 7 });
      expect(r.hourlyLands.length).toBe(24);
      expect(r.backlog.length).toBe(144);
      for (const v of [r.handUtil, r.pingPongRatio, r.opNoopRatio, r.readyEmptyShare, r.agentSlaShare]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  test('S0 hides ✋ (no ladder): p95 wait is hours; S1 ladder bounds it under 2 h', () => {
    const s0 = simulate({ structure: 'S0', seed: 1 }); const s1 = simulate({ structure: 'S1', seed: 1 });
    expect(s0.askWaitP95).toBeGreaterThan(S0_HIDDEN_ASK_P95_MIN);
    expect(s1.askWaitP95).toBeLessThan(S1_LADDER_P95_MAX_MIN);
  });

  test('domain routing removes the TC hub and the echo mail', () => {
    const s0 = simulate({ structure: 'S0', seed: 2 }); const s3 = simulate({ structure: 'S3', seed: 2 });
    expect(s0.tcInboundPerH).toBeGreaterThan(HUB_TC_INBOUND_MIN);
    expect(s3.tcInboundPerH).toBeLessThan(DOMAIN_TC_INBOUND_MAX);
    expect(s3.pingPongRatio).toBe(0);
  });

  test('helpers are off without loop agents (S0–S2 ignore the helper policy)', () => {
    const a = simulate({ structure: 'S2', seed: 3, helpers: { perAgent: 4, fedCapsuleCap: 8 } });
    const b = simulate({ structure: 'S2', seed: 3, helpers: { perAgent: 0, fedCapsuleCap: 8 } });
    expect(a).toEqual(b);
    expect(a.agentItemsPerH).toBe(0);
  });

  test('structures keep their documented knobs', () => {
    expect(STRUCTURES.S0.routing).toBe('hub');
    expect(STRUCTURES.S0.ladderMin).toBe(null);
    expect(STRUCTURES.S3.routing).toBe('domain');
    expect(STRUCTURES.S3.reaskMin).toBe(Infinity);
    expect(STRUCTURES.S4.opL0).toBe(true);
  });

  test('body model covers today\'s 14 trigger bodies, 3 with a goal-not-met check', () => {
    expect(BODIES.length).toBe(14);
    expect(BODIES.filter((b) => b.goalCheck).length).toBe(3);
    const d = simulateBodies('D-shared', 1);
    expect(d.residentProcs).toBe(1);
    expect(d.spawnsPerH).toBe(0);
  });

  test('recoverAfterEnd: excess back under max(3, 25% of peak) for 30 min after the event; null when it never drains', () => {
    const base = new Array(144).fill(10);
    const drained = base.map((v, i) => (i >= 48 && i < 60 ? v + 20 : v));   // spike 8:00–10:00, gone after
    expect(recoverAfterEnd(drained, base, 'judge-backlog')).toBe(120);
    const stuck = base.map((v, i) => (i >= 48 ? v + 20 : v));
    expect(recoverAfterEnd(stuck, base, 'judge-backlog')).toBe(null);
  });
});

describe('fed-org registration', () => {
  const world = join(import.meta.dir, '../../worlds');
  test('pack yaml lists the six scenarios on scenarios.ts', () => {
    expect(isReservedSimWorldId('fed-org')).toBe(true);
    const pack = parseYaml(readFileSync(join(world, 'sim-world-fed-org.yaml'), 'utf8'));
    expect(pack.world).toBe('fed-org');
    // kit scenarios (KIT-KPI-* · kit-kpi.ts) share the pack; the six policy-model rows stay on scenarios.ts
    const own = pack.scenarios.filter((row: { module: string }) => row.module === 'src/ux-sim/sim-world/fed-org/scenarios.ts');
    expect(own.map((row: { id: string }) => row.id)).toEqual([
      'FED-ORG-DETERMINISM', 'FED-ORG-CALIBRATION', 'FED-ORG-TARGET', 'FED-ORG-HEADROOM', 'FED-ORG-HELPERS', 'FED-ORG-BODY',
    ]);
    expect(pack.scenarios.filter((row: { module: string }) => row.module !== 'src/ux-sim/sim-world/fed-org/scenarios.ts').map((row: { id: string; module: string }) => `${row.id}@${row.module}`)).toEqual([
      'KIT-KPI-WINDOW-EVENT-TIME@src/ux-sim/sim-world/fed-org/kit-kpi.ts', 'KIT-KPI-RAW-JUDGMENT@src/ux-sim/sim-world/fed-org/kit-kpi.ts', 'KIT-KPI-BREACH-DEBOUNCE@src/ux-sim/sim-world/fed-org/kit-kpi.ts',
      // CONTEXT-BUS-FEDERATION (0.3.39 P0)
      'CTX-BUS-DECIDE@src/ux-sim/sim-world/fed-org/context-bus.ts', 'CTX-BUS-HQ-HANDOFF@src/ux-sim/sim-world/fed-org/context-bus.ts', 'CTX-BUS-RAW-CONTEXT@src/ux-sim/sim-world/fed-org/context-bus.ts',
      'CTX-BUS-LOOP-STATUS@src/ux-sim/sim-world/fed-org/context-bus.ts', 'CTX-BUS-FALLBACK@src/ux-sim/sim-world/fed-org/context-bus.ts',
    ]);
    expect(simWorldScenarios.map((s) => s.id)).toEqual(own.map((row: { id: string }) => row.id));
  });

  test('expect table: every fed-org scenario is a green row', () => {
    const table = parseSimWorldExpectTable(readFileSync(join(world, 'expect', 'fed-org.json'), 'utf8'));
    for (const s of simWorldScenarios) expect(table.entries[`fed-org/${s.id}`]?.expect).toBe('green');
  });
});
