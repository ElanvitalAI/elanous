// PR-ZOMBIE-SUPPLY-TRUE sim scene under bun test (seeds 1–5 inside one run) — the pack row in sim-world-supervisors.yaml
// runs the same module through `eln sim world run supervisors`.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SimWorldScenarioContext } from '../types.js';
import { simWorldScenarios } from './pr-zombie.js';

setDefaultTimeout(120_000); // Source: R-TST17 — five seeds × two live land ticks over ~150 PRs each (temp ledgers).
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

test('PR-ZOMBIE-SUPPLY-TRUE · seeds 1–5 green · supply before ≫ after', async () => {
  const events: Array<{ kind: string; data: unknown }> = [];
  const universeRoot = mkdtempSync(join(tmpdir(), 'sim-pr-zombie-')); dirs.push(universeRoot);
  const ctx = {
    world: 'supervisors', scenarioId: 'PR-ZOMBIE-SUPPLY-TRUE', seed: 1, engine: 'legacy', universeRoot,
    recorder: { event: (kind: string, data: unknown) => { events.push({ kind, data }); } },
    random: () => 0.5, device: () => { throw new Error('no device'); },
  } as unknown as SimWorldScenarioContext;
  expect(simWorldScenarios.map((s) => s.id)).toEqual(['PR-ZOMBIE-SUPPLY-TRUE']);
  expect(await simWorldScenarios[0]!.run(ctx)).toEqual({ ok: true });
  const rows = (events.find((e) => e.kind === 'pr-zombie-supply-true')?.data as { rows: Array<Record<string, number>> }).rows;
  expect(rows.map((r) => r.seed)).toEqual([1, 2, 3, 4, 5]);
  // the 11-28 reading: without the policy the pipeline carries every zombie; with it only ready 1 + the fresh ones
  for (const r of rows) {
    expect(r.before).toBe(1 + r.zombies! + r.stale! + r.fresh!);
    expect(r.after).toBe(1 + r.fresh!);
    expect(r.drafted! + r.closeProposals!).toBe(r.zombies!);
  }
});
