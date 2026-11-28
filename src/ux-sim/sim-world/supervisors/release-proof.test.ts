// RELEASE-HUMAN-PROOF-TRUST-ROOT sim scenes S1~S9 under bun test (seeds 1–5 × legacy/graph inside one run) — the pack rows
// in sim-world-supervisors.yaml run the same module through `eln sim world run supervisors --engine both`.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SimWorldEngine, SimWorldScenarioContext } from '../types.js';
import { simWorldScenarios } from './release-proof.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

test('scene ids are the design table S1~S9', () => {
  expect(simWorldScenarios.map(s => s.id)).toEqual(['RP-S1', 'RP-S2', 'RP-S3', 'RP-S4', 'RP-S5', 'RP-S6', 'RP-S7', 'RP-S8', 'RP-S9']);
});

for (const engine of ['legacy', 'graph'] as const satisfies readonly SimWorldEngine[]) {
  for (const scenario of simWorldScenarios) {
    test(`${scenario.id} · ${engine} · seeds 1–5 green`, async () => {
      const events: Array<{ kind: string; data: unknown }> = [];
      const universeRoot = mkdtempSync(join(tmpdir(), `sim-release-proof-${scenario.id}-`)); dirs.push(universeRoot);
      const ctx = {
        world: 'supervisors', scenarioId: scenario.id, seed: 1, engine, universeRoot,
        recorder: { event: (kind: string, data: unknown) => { events.push({ kind, data }); } },
        random: () => 0.5, device: () => { throw new Error('no device'); },
      } as unknown as SimWorldScenarioContext;
      expect(await scenario.run(ctx)).toEqual({ ok: true });
      expect(events).toContainEqual({ kind: 'release-proof:scene', data: { scenario: scenario.id, engine, seeds: 5 } });
    }, 60_000);
  }
}
