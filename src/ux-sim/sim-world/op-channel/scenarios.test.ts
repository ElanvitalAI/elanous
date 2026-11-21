// Runs each op-channel scenario in its own universe and judges it against expect.json with the kernel's verdict rule.
// The kernel CLI (`sim world run op-channel`) is the cross-pack runner; this file is the pack-local gate. An xfail
// keeps the test green only while the observed red reason equals the row's literal redReason.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifySimWorldOutcome, judgeSimWorldScenario } from '../expect.js';
import { createSimWorldRecorder } from '../recorder.js';
import type { SimWorldExpectTable, SimWorldScenarioContext } from '../types.js';
import { simWorldScenarios } from './scenarios.js';

setDefaultTimeout(60_000);
const table = JSON.parse(readFileSync(join(import.meta.dir, 'expect.json'), 'utf8')) as SimWorldExpectTable;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function judge(id: string) {
  const scenario = simWorldScenarios.find((row) => row.id === id)!;
  const universeRoot = mkdtempSync(join(tmpdir(), `sim-op-channel-${id}-`));
  dirs.push(universeRoot);
  const base = { world: 'op-channel' as const, scenarioId: id, seed: 1, engine: 'legacy' as const, universeRoot };
  const ctx: SimWorldScenarioContext = {
    ...base,
    recorder: createSimWorldRecorder({ dir: join(universeRoot, 'record'), world: base.world, scenario: id, engine: base.engine, seed: base.seed }),
    random: () => 0.5,
    device: (deviceId) => { throw new Error(`no device ${deviceId}`); },
  };
  const outcome = classifySimWorldOutcome(await scenario.run(ctx));
  const row = table.entries[`op-channel/${id}`] ?? null;
  const verdict = judgeSimWorldScenario({
    expected: row?.expect ?? null, actual: outcome.actual, previouslyGreen: row?.greenSince !== undefined,
    promote: false, redReason: row?.redReason ?? null, observedReason: outcome.reason,
  });
  return { verdict, diff: outcome.diff };
}

test('every scenario has exactly one expectation row', () => {
  expect(simWorldScenarios.map((row) => `op-channel/${row.id}`).sort()).toEqual(Object.keys(table.entries).sort());
});

for (const scenario of simWorldScenarios) {
  test(`${scenario.id} · ${scenario.title}`, async () => {
    const { verdict, diff } = await judge(scenario.id);
    expect({ verdict, diff: verdict === 'pass' ? null : diff }).toEqual({ verdict: table.entries[`op-channel/${scenario.id}`]!.expect === 'red' ? 'xfail' : 'pass', diff: verdict === 'pass' ? null : diff });
  });
}