// ELS-SHORTCUTS-POPUP sim, seeds 1..5: the E-SHORTCUTS-POPUP scenario driven directly (a REAL registry + a REAL attach app,
// read back from @xterm/headless) and through the sim-world kernel on both engines (legacy · graph).
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSimWorlds } from '../kernel.js';
import { runShortcutsPopup } from './shortcuts-popup.js';

const SEEDS = [1, 2, 3, 4, 5] as const;
const matrix = new Map<string, string>();
afterAll(() => {
  console.log(`\nSHORTCUTS-POPUP MATRIX\n| seed | ${SEEDS.join(' | ')} |\n|---|${SEEDS.map(() => '---').join('|')}|\n${['direct', 'legacy', 'graph'].map((run) => `| ${run} | ${SEEDS.map((s) => matrix.get(`${run}:${s}`) ?? '-').join(' | ')} |`).join('\n')}`);
});

describe('ctrl+b ? shortcuts popup: open · stray keys · scroll · Esc · over the tile grid', () => {
  for (const seed of SEEDS) test(`seed ${seed} (direct)`, async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    try {
      await runShortcutsPopup(seed, (event, data) => events.push({ event, data }));
      expect(events.map((one) => one.event).filter((name) => name !== 'shortcuts.scroll')).toEqual(['shortcuts.size', 'shortcuts.open', 'shortcuts.tile']);
      matrix.set(`direct:${seed}`, 'PASS');
    } catch (error) { matrix.set(`direct:${seed}`, 'FAIL'); throw error; }
  }, 30_000);

  for (const seed of SEEDS) test(`seed ${seed} (kernel, both engines)`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'sim-world-els-shortcuts-'));
    try {
      const result = await runSimWorlds({ worldId: 'els', seed, engine: 'both', only: 'E-SHORTCUTS-POPUP', stateRoot: root, runId: `shortcuts-${seed}`, expectBaseFile: null, isolate: 'inline' });
      for (const row of result.scenarios) matrix.set(`${row.engine}:${seed}`, row.verdict === 'pass' ? 'PASS' : row.verdict);
      expect(result.scenarios.map((row) => [row.scenario, row.engine, row.verdict])).toEqual([['E-SHORTCUTS-POPUP', 'legacy', 'pass'], ['E-SHORTCUTS-POPUP', 'graph', 'pass']]);
      expect(result.ok).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 60_000);
});
