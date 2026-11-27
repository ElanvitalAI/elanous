// LOOP-AGENT-V3-SMART-2 sim scenes under bun test (seeds 1–3 inside one run) — the pack rows in sim-world-supervisors.yaml
// run the same module through `eln sim world run supervisors`.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SimWorldScenarioContext } from '../types.js';
import { simWorldScenarios } from './v3-smart.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const ctxOf = (id: string, events: Array<{ kind: string; data: unknown }>): SimWorldScenarioContext => {
  const universeRoot = mkdtempSync(join(tmpdir(), 'sim-v3-smart-2-')); dirs.push(universeRoot);
  return {
    world: 'supervisors', scenarioId: id, seed: 1, engine: 'legacy', universeRoot,
    recorder: { event: (kind: string, data: unknown) => { events.push({ kind, data }); } },
    random: () => 0.5, device: () => { throw new Error('no device'); },
  } as unknown as SimWorldScenarioContext;
};

test('scenes registered', () => {
  expect(simWorldScenarios.map(s => s.id)).toEqual(['SUP-V3-SMART-LEARN', 'SUP-V3-RETRO-SOUL']);
});

test('SUP-V3-SMART-LEARN · seeds 1–3 green · plan before/after', async () => {
  const events: Array<{ kind: string; data: unknown }> = [];
  expect(await simWorldScenarios[0]!.run(ctxOf('SUP-V3-SMART-LEARN', events))).toEqual({ ok: true });
  const rows = events.filter(e => e.kind === 'sup:v3-smart-learn').map(e => e.data as { seed: number; before: string; after: string });
  expect(rows.map(r => r.seed)).toEqual([1, 2, 3]);
  for (const r of rows) {
    expect(r.before.startsWith('end-zombie-pregate pregate:')).toBe(true);
    expect(r.after.startsWith('close-stale-record pregate:') && r.after.endsWith(' ← end-zombie-pregate')).toBe(true);
  }
});

test('SUP-V3-RETRO-SOUL · seeds 1–3 green', async () => {
  const events: Array<{ kind: string; data: unknown }> = [];
  expect(await simWorldScenarios[1]!.run(ctxOf('SUP-V3-RETRO-SOUL', events))).toEqual({ ok: true });
  expect(events.filter(e => e.kind === 'sup:v3-retro-soul').length).toBe(3);
});
