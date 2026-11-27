// POOL-PULL-NEEDS-SPEC sim scene under bun test (seeds 1–5 inside one run) — the pack row in sim-world-supervisors.yaml
// runs the same module through `eln sim world run supervisors`.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SimWorldScenarioContext } from '../types.js';
import { simWorldScenarios } from './pool-needs-spec.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

test('SUP-POOL-NEEDS-SPEC · seeds 1–5 green', async () => {
  const events: Array<{ kind: string; data: unknown }> = [];
  const universeRoot = mkdtempSync(join(tmpdir(), 'sim-pool-needs-spec-')); dirs.push(universeRoot);
  const ctx = {
    world: 'supervisors', scenarioId: 'SUP-POOL-NEEDS-SPEC', seed: 1, engine: 'legacy', universeRoot,
    recorder: { event: (kind: string, data: unknown) => { events.push({ kind, data }); } },
    random: () => 0.5, device: () => { throw new Error('no device'); },
  } as unknown as SimWorldScenarioContext;
  expect(simWorldScenarios.map((s) => s.id)).toEqual(['SUP-POOL-NEEDS-SPEC']);
  expect(await simWorldScenarios[0]!.run(ctx)).toEqual({ ok: true });
  const rows = (events.find((e) => e.kind === 'pool-needs-spec')?.data as { rows: Array<{ seed: number; withSpec: number; noSpec: number; claimedOn: number; claimedOff: number }> }).rows;
  expect(rows.map((r) => r.seed)).toEqual([1, 2, 3, 4, 5]);
  for (const r of rows) expect([r.withSpec + r.noSpec, r.claimedOn === r.withSpec, r.claimedOff]).toEqual([12, true, 12]);
});
