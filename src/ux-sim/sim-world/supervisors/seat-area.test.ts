// SEAT-AREA-GUARD sim scene under bun test (seeds 1–5 · both engines inside one run) — the pack row in
// sim-world-supervisors.yaml runs the same module through `eln sim world run supervisors`.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SimWorldScenarioContext } from '../types.js';
import { simWorldScenarios } from './seat-area.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

for (const engine of ['legacy', 'graph'] as const) {
  test(`SUP-SEAT-AREA-GUARD · seeds 1–5 green (${engine})`, async () => {
    const events: Array<{ kind: string; data: unknown }> = [];
    const universeRoot = mkdtempSync(join(tmpdir(), 'sim-seat-area-')); dirs.push(universeRoot);
    const ctx = {
      world: 'supervisors', scenarioId: 'SUP-SEAT-AREA-GUARD', seed: 1, engine, universeRoot,
      recorder: { event: (kind: string, data: unknown) => { events.push({ kind, data }); } },
      random: () => 0.5, device: () => { throw new Error('no device'); },
    } as unknown as SimWorldScenarioContext;
    expect(simWorldScenarios.map((s) => s.id)).toEqual(['SUP-SEAT-AREA-GUARD']);
    expect(await simWorldScenarios[0]!.run(ctx)).toEqual({ ok: true });
    const rows = (events.find((e) => e.kind === 'seat-area-guard')?.data as { rows: Array<{ seed: number; engine: string; hinted: number }> }).rows;
    expect(rows.map((r) => [r.seed, r.engine, r.hinted])).toEqual([1, 2, 3, 4, 5].map((s) => [s, engine, 3]));
  });
}
