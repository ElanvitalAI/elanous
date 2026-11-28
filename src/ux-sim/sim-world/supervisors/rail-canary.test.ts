// RAIL-CANARY-AUTO-ROLLBACK sim scenes under bun test (seeds 1–5 · legacy and graph engine labels) — the pack rows in
// sim-world-supervisors.yaml run the same module through `eln sim world run supervisors`.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SimWorldScenarioContext } from '../types.js';
import { simWorldScenarios } from './rail-canary.js';

setDefaultTimeout(120_000);
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

test('the scene list is literal', () => {
  expect(simWorldScenarios.map(s => s.id)).toEqual(['SUP-CANARY-REGRESS', 'SUP-CANARY-HEALTHY', 'SUP-CANARY-FLAP', 'SUP-CANARY-HOLD', 'SUP-CANARY-FALSE']);
});

for (const scene of simWorldScenarios) {
  test(`${scene.id} · seeds 1–5 × legacy/graph green`, async () => {
    const out: string[] = [];
    for (const engine of ['legacy', 'graph'] as const) for (const seed of [1, 2, 3, 4, 5]) {
      const universeRoot = mkdtempSync(join(tmpdir(), `sim-canary-${scene.id}-`)); dirs.push(universeRoot);
      const ctx = { world: 'supervisors', scenarioId: scene.id, seed, engine, universeRoot, recorder: { event: () => {} },
        random: () => 0.5, device: () => { throw new Error('no device'); } } as unknown as SimWorldScenarioContext;
      const r = await scene.run(ctx);
      out.push(`${engine}:${seed}:${r.ok ? 'ok' : `${(r as { reason?: string }).reason} ${(r as { diff?: string }).diff}`}`);
    }
    expect(out).toEqual(['legacy', 'graph'].flatMap(e => [1, 2, 3, 4, 5].map(s => `${e}:${s}:ok`)));
  });
}
