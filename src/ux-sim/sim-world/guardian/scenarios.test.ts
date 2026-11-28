// guardian sim world — every scenario green on seeds 1–5 ⊕ pack/expect registration (GUARDIAN-SUBS · 대표 11-28 «시뮬레이션 월드에서
// 충분히 검증» · literal expectations live in scenarios.ts, rule 11).
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { resetGuardianDef } from '../../../guardian-agent/def.js';
import { isReservedSimWorldId } from '../kernel.js';
import type { SimWorldScenarioContext } from '../types.js';
import { seededRandom } from '../fed-org/model.js';
import { simWorldDevices, simWorldScenarios } from './scenarios.js';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); resetGuardianDef(); });

async function makeCtx(seed: number) {
  const universeRoot = mkdtempSync(join(tmpdir(), 'guardian-sim-world-')); roots.push(universeRoot);
  const events: { kind: string; data: unknown }[] = [];
  const recorder = { event: (kind: string, data: unknown) => { events.push({ kind, data }); } };
  const base = { world: 'guardian', scenarioId: 'x', seed, engine: 'legacy', universeRoot, recorder };
  const devices = new Map<string, unknown>();
  for (const def of simWorldDevices) devices.set(def.id, await def.create(base as never));
  const ctx = { ...base, device: <T>(id: string) => devices.get(id) as T, random: seededRandom(seed) } as unknown as SimWorldScenarioContext;
  return { ctx, events };
}

describe('guardian scenarios (seeds 1–5)', () => {
  for (const scenario of simWorldScenarios) {
    for (const seed of [1, 2, 3, 4, 5]) {
      test(`${scenario.id} seed ${seed} → green`, async () => {
        const { ctx, events } = await makeCtx(seed);
        expect(await scenario.run(ctx)).toEqual({ ok: true });
        expect(events.length).toBe(1);
      }, 60_000);
    }
  }
  test('same seed → the same recorded event (replay equality of what a scenario observed)', async () => {
    for (const scenario of simWorldScenarios) {
      const a = await makeCtx(3); await scenario.run(a.ctx);
      const b = await makeCtx(3); await scenario.run(b.ctx);
      expect(`${scenario.id} ${JSON.stringify(b.events)}`).toBe(`${scenario.id} ${JSON.stringify(a.events)}`);
    }
  }, 120_000);
});

describe('guardian pack registration', () => {
  test('reserved id · pack yaml lists every scenario · expect fragment has a green row each', () => {
    expect(isReservedSimWorldId('guardian')).toBe(true);
    const repo = join(import.meta.dir, '../../../..');
    const pack = parseYaml(readFileSync(join(repo, 'src/ux-sim/worlds/sim-world-guardian.yaml'), 'utf8')) as { world: string; scenarios: { id: string }[] };
    expect(pack.world).toBe('guardian');
    expect(pack.scenarios.map(s => s.id)).toEqual(['GRD-PATROL-ZOMBIE', 'GRD-PATROL-RUN-FAILED', 'GRD-PATROL-LOOP-EXC', 'GRD-PATROL-UNCLASSIFIED', 'GRD-PATROL-CONCURRENT', 'GRD-PATROL-PEER-SILENT',
      'GRD-POST-SLA', 'GRD-POST-READ-NOTICE', 'GRD-POST-DORMANT', 'GRD-POST-RAIL', 'GRD-FUEL-ROUTE-NEXT', 'GRD-FUEL-ALL-DRY', 'GRD-FUEL-7DAY', 'GRD-KEYS-REAL-VS-PAUSED',
      'GRD-FUEL-SUB-FIRST', 'GRD-FUEL-NO-PAID-BYPASS', 'GRD-FUEL-NONE-CLEARS-DIRECTIVE', 'GRD-FUEL-REVIEW-NEVER-FORBIDDEN', 'GRD-KEYS-REFRESH', 'GRD-KEYS-REFRESH-FAIL', 'GRD-KEYS-USAGE-EXP',
      'GRD-KIND-RESOURCE-CHECK-PARAMS', 'GRD-KIND-ROLLUP-PARAMS', 'BURST-ACTUATES']);
    expect(simWorldScenarios.map(s => s.id)).toEqual(pack.scenarios.map(s => s.id));
    const table = JSON.parse(readFileSync(join(repo, 'src/ux-sim/worlds/expect/guardian.json'), 'utf8')) as { entries: Record<string, { expect: string }> };
    expect(Object.entries(table.entries).map(([k, v]) => `${k}=${v.expect}`)).toEqual(pack.scenarios.map(s => `guardian/${s.id}=green`));
  });
});
