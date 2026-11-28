// RELEASE-PRESIGNED-AUTO sim scenes PA-S1~S7 under bun test (seeds 1–5 × legacy/graph inside one run) — the pack rows
// in sim-world-supervisors.yaml run the same module through `eln sim world run supervisors --engine both`.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SimWorldEngine, SimWorldScenarioContext } from '../types.js';
import { simWorldScenarios } from './release-preauth.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

test('scene ids are the design table PA-S1~S7', () => {
  expect(simWorldScenarios.map(s => s.id)).toEqual(['PA-S1', 'PA-S2', 'PA-S3', 'PA-S4', 'PA-S5', 'PA-S6', 'PA-S7']);
});

for (const engine of ['legacy', 'graph'] as const satisfies readonly SimWorldEngine[]) {
  for (const scenario of simWorldScenarios) {
    test(`${scenario.id} · ${engine} · seeds 1–5 green`, async () => {
      const events: Array<{ kind: string; data: unknown }> = [];
      const universeRoot = mkdtempSync(join(tmpdir(), `sim-release-preauth-${scenario.id}-`)); dirs.push(universeRoot);
      const ctx = {
        world: 'supervisors', scenarioId: scenario.id, seed: 1, engine, universeRoot,
        recorder: { event: (kind: string, data: unknown) => { events.push({ kind, data }); } },
        random: () => 0.5, device: () => { throw new Error('no device'); },
      } as unknown as SimWorldScenarioContext;
      expect(await scenario.run(ctx)).toEqual({ ok: true });
      expect(events).toContainEqual({ kind: 'release-preauth:scene', data: { scenario: scenario.id, engine, seeds: 5 } });
    }, 60_000);
  }
}
