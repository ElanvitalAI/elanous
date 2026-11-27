// memory sim world · kit/knowhow scenarios — verdicts over seeds 1–5 ⊕ generator ground truth ⊕ pack/expect registration.
// Rule 11: expected values are literals, never re-derived from the kit.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { SimWorldScenarioContext } from '../types.js';
import { generateKnowhowDoc, kitKnowhowSeeds, simWorldDevices, simWorldScenarios } from './kit-knowhow.js';

const IDS = ['KIT-KNOWHOW-REAL-SHAPES', 'KIT-KNOWHOW-GENERATED', 'KIT-KNOWHOW-CALLERS-AGREE', 'KIT-KNOWHOW-DETERMINISM'];
const MODULE = 'src/ux-sim/sim-world/memory/kit-knowhow.ts';

function makeCtx(seed: number) {
  const events: { kind: string; data: unknown }[] = [];
  const devices = new Map<string, unknown>();
  for (const def of simWorldDevices) devices.set(def.id, (def.create as () => unknown)());
  const ctx = {
    world: 'memory', scenarioId: 'x', seed, engine: 'legacy', universeRoot: '/nonexistent-kit-knowhow-universe',
    recorder: { event: (kind: string, data: unknown) => { events.push({ kind, data }); } },
    device: <T>(id: string) => devices.get(id) as T,
    random: () => 0.5,
  } as unknown as SimWorldScenarioContext;
  return { ctx, events };
}

describe('kit/knowhow scenarios (seeds 1–5)', () => {
  for (const scenario of simWorldScenarios) {
    for (const seed of [1, 2, 3, 4, 5]) {
      test(`${scenario.id} · seed ${seed} passes`, async () => {
        const { ctx } = makeCtx(seed);
        expect(await scenario.run(ctx)).toEqual({ ok: true });
      });
    }
  }
});

describe('generator', () => {
  test('five distinct generator seeds per run seed, stable across calls', () => {
    const a = kitKnowhowSeeds(1);
    expect(a.length).toBe(5);
    expect(new Set(a).size).toBe(5);
    expect(kitKnowhowSeeds(1)).toEqual(a);
    expect(kitKnowhowSeeds(2)).not.toEqual(a);
  });

  test('generated documents carry 6–13 cards and use the real status spellings', () => {
    const spellings = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const g = generateKnowhowDoc(seed);
      expect(g.cards.length >= 6 && g.cards.length <= 13).toBe(true);
      for (const m of g.body.matchAll(/상태: (\S+)/gu)) spellings.add(m[1]!);
    }
    for (const literal of ['active.', 'active(로직', 'unproven(운영', 'superseded-by', 'stale']) expect(spellings.has(literal)).toBe(true);
  });

  test('a failing grammar is caught: a doc whose truth is edited no longer matches', async () => {
    const scenario = simWorldScenarios.find((s) => s.id === 'KIT-KNOWHOW-REAL-SHAPES')!;
    const { ctx } = makeCtx(1);
    const broken = { ...ctx, device: () => ({ kit: () => ({ cards: [], malformed: [] }), seatItems: () => [], k3: () => [], lint: () => undefined }) } as unknown as SimWorldScenarioContext;
    const out = await scenario.run(broken);
    expect(out).toMatchObject({ ok: false, reason: 'real-shape-misread' });
  });
});

describe('registration', () => {
  const root = join(import.meta.dir, '..', '..', '..', '..');
  test('the module exports four scenarios and one device', () => {
    expect(simWorldScenarios.map((s) => s.id)).toEqual(IDS);
    expect(simWorldDevices.map((d) => d.id)).toEqual(['KIT-KNOWHOW-PARSER']);
  });
  test('the memory pack lists them and the expect table holds a green row each', () => {
    const pack = parseYaml(readFileSync(join(root, 'src/ux-sim/worlds/sim-world-memory.yaml'), 'utf8')) as { scenarios: { id: string; module: string }[] };
    expect(pack.scenarios.filter((row) => row.module === MODULE).map((row) => row.id)).toEqual(IDS);
    const table = JSON.parse(readFileSync(join(root, 'src/ux-sim/worlds/expect/memory.json'), 'utf8')) as { entries: Record<string, { expect: string }> };
    for (const id of IDS) expect(table.entries[`memory/${id}`]?.expect).toBe('green');
  });
});
