// alloc-budget sim world — every scenario green on seeds 1–5 ⊕ pack/expect registration.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { isReservedSimWorldId } from '../kernel.js';
import type { SimWorldScenarioContext } from '../types.js';
import { seededRandom } from '../fed-org/model.js';
import { simWorldDevices, simWorldScenarios } from './scenarios.js';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

async function makeCtx(seed: number) {
  const universeRoot = mkdtempSync(join(tmpdir(), 'alloc-sim-world-')); roots.push(universeRoot);
  const events: { kind: string; data: unknown }[] = [];
  const recorder = { event: (kind: string, data: unknown) => { events.push({ kind, data }); } };
  const base = { world: 'alloc-budget', scenarioId: 'x', seed, engine: 'legacy', universeRoot, recorder };
  const devices = new Map<string, unknown>();
  for (const def of simWorldDevices) devices.set(def.id, await def.create(base as never));
  const ctx = { ...base, device: <T>(id: string) => devices.get(id) as T, random: seededRandom(seed) } as unknown as SimWorldScenarioContext;
  return { ctx, events };
}

describe('alloc-budget scenarios (seeds 1–5)', () => {
  for (const scenario of simWorldScenarios) {
    for (const seed of [1, 2, 3, 4, 5]) {
      test(`${scenario.id} seed ${seed} → green`, async () => {
        const { ctx, events } = await makeCtx(seed);
        expect(await scenario.run(ctx)).toEqual({ ok: true });
        expect(events.length).toBe(1);
      });
    }
  }
});

describe('alloc-budget pack registration', () => {
  test('reserved id · pack yaml lists every scenario · expect fragment has a green row each', () => {
    expect(isReservedSimWorldId('alloc-budget')).toBe(true);
    const repo = join(import.meta.dir, '../../../..');
    const pack = parseYaml(readFileSync(join(repo, 'src/ux-sim/worlds/sim-world-alloc-budget.yaml'), 'utf8')) as { world: string; scenarios: { id: string }[] };
    expect(pack.world).toBe('alloc-budget');
    expect(pack.scenarios.map(s => s.id)).toEqual(['ALLOC-FLOOD', 'ALLOC-NEAR-CAP', 'ALLOC-CUT-RESERVE', 'ALLOC-TTL-RECLAIM', 'ALLOC-UNATTRIBUTED', 'ALLOC-MODE-SHIFT', 'ALLOC-METERING']);
    expect(simWorldScenarios.map(s => s.id)).toEqual(pack.scenarios.map(s => s.id));
    const table = JSON.parse(readFileSync(join(repo, 'src/ux-sim/worlds/expect/alloc-budget.json'), 'utf8')) as { entries: Record<string, { expect: string }> };
    expect(Object.entries(table.entries).map(([k, v]) => `${k}=${v.expect}`)).toEqual(pack.scenarios.map(s => `alloc-budget/${s.id}=green`));
  });
});
