// LOOP-AGENT-V3-YAML — kernel-free run of the graph world's LA3-* scenarios (same code the kernel runs via sim world run graph).
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { simWorldScenarios } from './loop-agent-v3.js';
import expectTable from '../../worlds/expect/graph.json';

setDefaultTimeout(120_000);
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

test('five LA3 scenarios · each listed in the graph pack and green in the expect table (literals)', () => {
  expect(simWorldScenarios.map(s => s.id)).toEqual(['LA3-EQUIV', 'LA3-POLICY', 'LA3-REFUSE', 'LA3-EDGE', 'LA3-PORTABLE']);
  const pack = parseYaml(readFileSync(join(import.meta.dir, '../../worlds/sim-world-graph.yaml'), 'utf8')) as { scenarios: Array<{ id: string; module: string }> };
  expect(pack.scenarios.filter(r => r.module === 'src/ux-sim/sim-world/graph/loop-agent-v3.ts').map(r => r.id)).toEqual(['LA3-EQUIV', 'LA3-POLICY', 'LA3-REFUSE', 'LA3-EDGE', 'LA3-PORTABLE']);
  const entries = (expectTable as { entries: Record<string, { expect: string }> }).entries;
  for (const id of ['LA3-EQUIV', 'LA3-POLICY', 'LA3-REFUSE', 'LA3-EDGE', 'LA3-PORTABLE']) expect(entries[`graph/${id}`]?.expect).toBe('green');
});

for (const scenario of simWorldScenarios) {
  test(`${scenario.id} — ${scenario.title}`, async () => {
    const universeRoot = mkdtempSync(join(tmpdir(), `la3-${scenario.id}-`)); roots.push(universeRoot);
    const events: unknown[] = [];
    const ctx = { world: 'graph', scenarioId: scenario.id, seed: 1, engine: 'legacy', universeRoot, recorder: { event: (k: string, d: unknown) => { events.push({ k, d }); } }, random: () => 0.5, device: () => { throw new Error('no device'); } };
    expect(await scenario.run(ctx as never)).toEqual({ ok: true });
    expect(events.length).toBe(1);
  });
}
