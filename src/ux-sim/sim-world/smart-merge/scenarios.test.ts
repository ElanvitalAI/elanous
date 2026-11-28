// smart-merge sim world — every scenario green on seed 1; the seed-sensitive ones (stack names, hot-file landing order)
// on seeds 1–5. Real temp git repos (no network). Registration: pack yaml ⊕ expect rows ⊕ reserved world id.
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseSimWorldExpectTable } from '../expect.js';
import { isReservedSimWorldId } from '../kernel.js';
import type { SimWorldScenarioContext } from '../types.js';
import { simWorldDevices, simWorldScenarios } from './scenarios.js';

setDefaultTimeout(180_000);

function rng(seed: number): () => number {
  let x = (seed * 2654435761) >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}
function makeCtx(seed: number) {
  const events: { kind: string; data: unknown }[] = [];
  const devices = new Map<string, unknown>();
  for (const def of simWorldDevices) devices.set(def.id, (def.create as () => unknown)());
  const ctx = {
    world: 'smart-merge', scenarioId: 'x', seed, engine: 'legacy', universeRoot: '/nonexistent-smart-merge-universe',
    recorder: { event: (kind: string, data: unknown) => { events.push({ kind, data }); } },
    device: <T>(id: string) => devices.get(id) as T,
    random: rng(seed),
  } as unknown as SimWorldScenarioContext;
  return { ctx, events };
}

const SEED_SENSITIVE = new Set(['SM-STACK-4DEEP', 'SM-HOT-FILE-5PR', 'SM-REFUSED-BEFORE-INSTALL', 'SM-DECLARED-SUPERSEDE', 'SM-CARRY-CONTEXT-MOVED', 'SM-CARRY-OWN-CHANGED', 'SM-REHEARSAL-REGRESSION-CELL', 'SM-GH-SNAPSHOT-5SEATS', 'SM-GH-SECONDARY-COOLDOWN', 'SM-GH-HEAD-MOVED-MID-REFRESH', 'SM-GH-SEAT-BUDGET', 'SM-GH-MIRROR-20FETCH', 'SM-GH-MIRROR-STALE-FALLBACK', 'SM-GH-SHIM-COOLDOWN-VIEW', 'SM-GH-SHIM-100-VIEWS']);
describe('smart-merge scenarios', () => {
  for (const scenario of simWorldScenarios) {
    for (const seed of SEED_SENSITIVE.has(scenario.id) ? [1, 2, 3, 4, 5] : [1]) {
      test(`${scenario.id} seed ${seed} → green`, async () => {
        const { ctx, events } = makeCtx(seed);
        expect(await scenario.run(ctx)).toEqual({ ok: true });
        expect(events.length).toBeGreaterThan(0);
      });
    }
  }
});

describe('smart-merge registration', () => {
  const world = join(import.meta.dir, '../../worlds');
  test('pack yaml lists the scenarios on scenarios.ts', () => {
    expect(isReservedSimWorldId('smart-merge')).toBe(true);
    const pack = parseYaml(readFileSync(join(world, 'sim-world-smart-merge.yaml'), 'utf8'));
    expect(pack.world).toBe('smart-merge');
    expect(pack.scenarios.map((row: { id: string }) => row.id)).toEqual([
      'SM-STALE-PR-REAP', 'SM-STACK-4DEEP', 'SM-STACK-MANUAL-MERGE', 'SM-MAIN-ONLY-MERGE', 'SM-HOT-FILE-5PR', 'SM-LIST-APPEND', 'SM-SEMANTIC-LLM',
      'SM-SECURITY4-SAME-LADDER', 'SM-REVERT-GUARD', 'SM-FORCE-PUSHED-UPSTREAM', 'SM-PR-CLOSED-MID', 'SM-FETCH-FAIL-MID', 'SM-RACE-LOCK', 'SM-REFUSED-BEFORE-INSTALL', 'SM-STACK-AUTO-DISCOVER', 'SM-DECLARED-SUPERSEDE', 'SM-OWN-REWRITE-DECLARATION', 'SM-RESTRUCTURE-PLUS-INSERT', 'SM-REVIEW-OWN-DELTA',
      'SM-CARRY-CONTEXT-MOVED', 'SM-CARRY-OWN-CHANGED', 'SM-L3-LIGHT-LAND', 'SM-REHEARSAL-REGRESSION-CELL',
      'SM-GH-SNAPSHOT-5SEATS', 'SM-GH-SECONDARY-COOLDOWN', 'SM-GH-HEAD-MOVED-MID-REFRESH', 'SM-GH-SEAT-BUDGET',
      'SM-GH-MIRROR-20FETCH', 'SM-GH-MIRROR-STALE-FALLBACK', 'SM-GH-SHIM-COOLDOWN-VIEW', 'SM-GH-SHIM-100-VIEWS',
    ]);
    for (const row of pack.scenarios) expect(row.module).toBe('src/ux-sim/sim-world/smart-merge/scenarios.ts');
    expect(simWorldScenarios.map((s) => s.id)).toEqual(pack.scenarios.map((row: { id: string }) => row.id));
  });
  test('expect table: every smart-merge scenario is a green row', () => {
    const table = parseSimWorldExpectTable(readFileSync(join(world, 'expect', 'smart-merge.json'), 'utf8'));
    for (const s of simWorldScenarios) expect(table.entries[`smart-merge/${s.id}`]?.expect).toBe('green');
  });
});
