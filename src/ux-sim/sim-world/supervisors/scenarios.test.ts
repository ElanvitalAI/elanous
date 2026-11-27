// LOOP-AGENTS (대표 11-27 «시뮬월드에서 충분히 검증») — runs each supervisors scenario in its own universe and judges it
// against expect.json with the kernel's verdict rule (pack-local runner, like seat-mail: the kernel yaml stays empty so
// `sim world run all` pack-empty invariants are untouched). An xfail stays green only while the observed red reason
// equals the row's literal redReason. Loop agents not on main are test.skip with the PR that brings them.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifySimWorldOutcome, judgeSimWorldScenario } from '../expect.js';
import { createSimWorldRecorder } from '../recorder.js';
import type { SimWorldExpectTable, SimWorldScenarioContext } from '../types.js';
import { simWorldScenarios, simWorldSkipped } from './scenarios.js';

setDefaultTimeout(60_000);
const table = JSON.parse(readFileSync(join(import.meta.dir, 'expect.json'), 'utf8')) as SimWorldExpectTable;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function judge(id: string) {
  const scenario = simWorldScenarios.find((row) => row.id === id)!;
  const universeRoot = mkdtempSync(join(tmpdir(), `sim-supervisors-${id}-`));
  dirs.push(universeRoot);
  const base = { world: 'supervisors' as const, scenarioId: id, seed: 1, engine: 'legacy' as const, universeRoot };
  const ctx: SimWorldScenarioContext = {
    ...base,
    recorder: createSimWorldRecorder({ dir: join(universeRoot, 'record'), world: base.world, scenario: id, engine: base.engine, seed: base.seed }),
    random: () => 0.5,
    device: (deviceId) => { throw new Error(`no device ${deviceId}`); },
  };
  const outcome = classifySimWorldOutcome(await scenario.run(ctx));
  const row = table.entries[`supervisors/${id}`] ?? null;
  const verdict = judgeSimWorldScenario({
    expected: row?.expect ?? null, actual: outcome.actual, previouslyGreen: row?.greenSince !== undefined,
    promote: false, redReason: row?.redReason ?? null, observedReason: outcome.reason,
  });
  return { verdict, diff: outcome.diff };
}

test('every scenario has exactly one expectation row', () => {
  expect(simWorldScenarios.map((row) => `supervisors/${row.id}`).sort()).toEqual(Object.keys(table.entries).sort());
});

test('skipped loop agents name the PR that brings their code (literal list)', () => {
  expect(simWorldSkipped.map((row) => [row.id, row.reason.match(/PR #\d+/u)?.[0] ?? null])).toEqual([
    ['LA-G1', 'PR #40362'], ['LA-G2', 'PR #40352'], ['LA-G3', 'PR #40352'], ['LA-L1', 'PR #40367'],
  ]);
});

for (const row of simWorldSkipped) test.skip(`${row.id} · ${row.title} — ${row.reason}`, () => {});

for (const scenario of simWorldScenarios) {
  test(`${scenario.id} · ${scenario.title}`, async () => {
    const { verdict, diff } = await judge(scenario.id);
    expect({ verdict, diff: verdict === 'pass' ? null : diff }).toEqual({ verdict: table.entries[`supervisors/${scenario.id}`]!.expect === 'red' ? 'xfail' : 'pass', diff: verdict === 'pass' ? null : diff });
  });
}
