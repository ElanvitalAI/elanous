// SIM-WORLD machine-infra · WORLD-REGISTRY — every scenario × seeds 1..5, each in its own universe, judged against the
// machine-infra expect table with the kernel's verdict rule (the same rows `eln sim world run machine-infra` reads).
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifySimWorldOutcome, judgeSimWorldScenario } from '../expect.js';
import { createSimWorldRecorder } from '../recorder.js';
import type { SimWorldExpectTable, SimWorldScenarioContext } from '../types.js';
import { simWorldScenarios } from './world-registry.js';

setDefaultTimeout(60_000);
const SEEDS = [1, 2, 3, 4, 5];
const table = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'worlds', 'expect', 'machine-infra.json'), 'utf8')) as SimWorldExpectTable;
const pack = readFileSync(join(import.meta.dir, '..', '..', 'worlds', 'sim-world-machine-infra.yaml'), 'utf8');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** Deterministic per (seed, scenario) — a scenario never calls Math.random. */
function random(key: string): () => number {
  let s = createHash('sha256').update(key).digest().readUInt32LE(0);
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

async function judge(id: string, seed: number) {
  const scenario = simWorldScenarios.find(row => row.id === id)!;
  const universeRoot = mkdtempSync(join(tmpdir(), `sim-world-reg-${id}-${seed}-`));
  dirs.push(universeRoot);
  const base = { world: 'machine-infra' as const, scenarioId: id, seed, engine: 'legacy' as const, universeRoot };
  const ctx: SimWorldScenarioContext = {
    ...base, recorder: createSimWorldRecorder({ dir: join(universeRoot, 'record'), world: base.world, scenario: id, engine: base.engine, seed }),
    random: random(`${seed}:${id}`), device: (d) => { throw new Error(`no device ${d}`); },
  };
  const outcome = classifySimWorldOutcome(await scenario.run(ctx));
  const row = table.entries[`machine-infra/${id}`] ?? null;
  return { verdict: judgeSimWorldScenario({ expected: row?.expect ?? null, actual: outcome.actual, previouslyGreen: row?.greenSince !== undefined,
    promote: false, redReason: row?.redReason ?? null, observedReason: outcome.reason }), diff: outcome.diff };
}

test('every WORLD-* scenario is in the machine-infra pack and has one expectation row', () => {
  for (const s of simWorldScenarios) {
    expect(pack).toContain(`{ id: ${s.id}, module: src/ux-sim/sim-world/machine-infra/world-registry.ts }`);
    expect(table.entries[`machine-infra/${s.id}`]?.expect).toBe('green');
  }
});

describe.each(SEEDS)('seed %i', (seed) => {
  for (const s of simWorldScenarios) {
    test(`${s.id} — ${s.title}`, async () => {
      const { verdict, diff } = await judge(s.id, seed);
      expect({ verdict, diff }).toEqual({ verdict: 'pass', diff: null });
    });
  }
});
