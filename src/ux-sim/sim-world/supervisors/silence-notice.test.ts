// SUP-SILENCE-NOTICE under bun test — seeds 1–5 inside one run, both engines (legacy tickAgent · graph agent.yaml step graph).
// The pack row in sim-world-supervisors.yaml runs the same module through `eln sim world run supervisors`.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SimWorldScenarioContext } from '../types.js';
import { simWorldScenarios } from './silence-notice.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

for (const engine of ['legacy', 'graph'] as const) {
  test(`SUP-SILENCE-NOTICE · seeds 1–5 · ${engine}`, async () => {
    const events: Array<{ kind: string; data: { seed: number; kpi: number[]; settled: number; closed: number[]; rung: Array<[string, number]> } }> = [];
    const universeRoot = mkdtempSync(join(tmpdir(), `sim-silence-notice-${engine}-`)); dirs.push(universeRoot);
    const ctx = {
      world: 'supervisors', scenarioId: 'SUP-SILENCE-NOTICE', seed: 1, engine, universeRoot,
      recorder: { event: (kind: string, data: unknown) => { events.push({ kind, data: data as never }); } },
      random: () => 0.5, device: () => { throw new Error('no device'); },
    } as unknown as SimWorldScenarioContext;
    expect(simWorldScenarios.map(s => s.id)).toEqual(['SUP-SILENCE-NOTICE']);
    expect(await simWorldScenarios[0]!.run(ctx)).toEqual({ ok: true });
    const rows = events.filter(e => e.kind === 'sup:silence-notice').map(e => e.data);
    expect(rows.map(r => r.seed)).toEqual([1, 2, 3, 4, 5]);
    for (const r of rows) expect([r.kpi, r.settled, r.closed, r.rung.map(([to]) => to)]).toEqual([[5, 2], 3, [7, 3], ['TC']]);
  }, 60_000);
}
