// RETIRED-TRIGGER-FILTER sim scene under bun test (seeds 1–5 inside one run) — the pack row in sim-world-supervisors.yaml
// runs the same module through `eln sim world run supervisors`.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SimWorldScenarioContext } from '../types.js';
import { simWorldScenarios } from './loop-retired.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

test('SUP-LOOP-RETIRED · seeds 1–5 green', async () => {
  const events: Array<{ kind: string; data: unknown }> = [];
  const universeRoot = mkdtempSync(join(tmpdir(), 'sim-loop-retired-')); dirs.push(universeRoot);
  const ctx = {
    world: 'supervisors', scenarioId: 'SUP-LOOP-RETIRED', seed: 1, engine: 'legacy', universeRoot,
    recorder: { event: (kind: string, data: unknown) => { events.push({ kind, data }); } },
    random: () => 0.5, device: () => { throw new Error('no device'); },
  } as unknown as SimWorldScenarioContext;
  expect(simWorldScenarios.map((s) => s.id)).toEqual(['SUP-LOOP-RETIRED']);
  expect(await simWorldScenarios[0]!.run(ctx)).toEqual({ ok: true });
  const rows = events.filter((e) => e.kind === 'sup:loop-retired').map((e) => e.data as { seed: number; posts: string[]; unnormalized: number });
  expect(rows.map((r) => [r.seed, r.posts, r.unnormalized])).toEqual([1, 2, 3, 4, 5].map((s) => [s, ['OP:loop-exception:release-traffic:2026-11-28T02:20:00.000Z'], 1]));
});
