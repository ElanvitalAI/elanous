// JUDGE-BUTLER-V3-LISTED sim scene under bun test (seeds 1–5 inside one run) — the pack row in sim-world-supervisors.yaml
// runs the same module through `eln sim world run supervisors`.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SimWorldScenarioContext } from '../types.js';
import { simWorldScenarios } from './v3-listed.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

test('SUP-V3-LISTED · seeds 1–5 green', async () => {
  const events: Array<{ kind: string; data: unknown }> = [];
  const universeRoot = mkdtempSync(join(tmpdir(), 'sim-v3-listed-')); dirs.push(universeRoot);
  const ctx = {
    world: 'supervisors', scenarioId: 'SUP-V3-LISTED', seed: 1, engine: 'legacy', universeRoot,
    recorder: { event: (kind: string, data: unknown) => { events.push({ kind, data }); } },
    random: () => 0.5, device: () => { throw new Error('no device'); },
  } as unknown as SimWorldScenarioContext;
  expect(simWorldScenarios.map((s) => s.id)).toEqual(['SUP-V3-LISTED']);
  expect(await simWorldScenarios[0]!.run(ctx)).toEqual({ ok: true });
  const rows = events.filter((e) => e.kind === 'sup:v3-listed').map((e) => e.data as { seed: number; butler: { kpi: string } });
  expect(rows.map((r) => [r.seed, r.butler.kpi])).toEqual([1, 2, 3, 4, 5].map((s) => [s, `greens_per_hour ${9 + s} /h (목표 ≥ 10) 충족 · frozen_hands 1 (목표 ≤ 0) 위반`]));
});
