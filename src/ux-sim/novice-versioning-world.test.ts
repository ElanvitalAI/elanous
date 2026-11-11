import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { createWorld, destroyWorld, runWorldScenario } from './world.js';

const worldFile = join(import.meta.dir, '../../scenarios/ux-sim/novice-versioning-world.yaml');
const scenarioFile = join(import.meta.dir, '../../scenarios/ux-sim/novice-versioning-scenario.ts');

async function withWorldRoot<T>(run: () => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'novice-versioning-world-'));
  const previous = getTestStateRoot();
  setTestStateRoot(root);
  try { return await run(); }
  finally {
    setTestStateRoot(previous ?? null);
    rmSync(root, { recursive: true, force: true });
  }
}

test('standard YAML world runs novice version tasks through the network-sandboxed world runner', async () => {
  await withWorldRoot(async () => {
    const world = await createWorld(worldFile);
    try {
      expect(world.spec.devices).toEqual(['fake-gh']);
      const result = await runWorldScenario(world, scenarioFile);
      expect(result.pass).toBe(true);
      expect(result.noviceVersioning?.elapsedBasis).toBe('screen-and-action estimate');
      expect(result.noviceVersioning?.tasks.map(({ task, clicks, elapsedSeconds, stuckScreens, forbiddenWords, finalVersion }) => ({
        task, clicks, elapsedSeconds, stuckScreens, forbiddenWords, finalVersion,
      }))).toEqual([
        { task: 'restore-yesterday', clicks: 2, elapsedSeconds: 33, stuckScreens: [], forbiddenWords: [], finalVersion: 'version-yesterday' },
        { task: 'preview-discard', clicks: 3, elapsedSeconds: 50, stuckScreens: [], forbiddenWords: [], finalVersion: 'version-today' },
        { task: 'preview-apply', clicks: 3, elapsedSeconds: 50, stuckScreens: [], forbiddenWords: [], finalVersion: 'version-color-change' },
      ]);
      expect(result.devices).toEqual(['fake-gh']);
      expect(result.externalNetworkEvents).toEqual([]);
      expect(world.networkEvents).toEqual([]);
      const previousFault = process.env.ELANOUS_UX_SIM_NOVICE_FAULT;
      try {
        for (const [faultName, expectedVersion, expectedForbidden] of [
          ["apply-routes-to-discard", "version-today", false],
          ["apply-reports-wrong-version", "version-today", false],
          ["applied-screen-has-forbidden-word", "version-color-change", true],
        ] as const) {
          process.env.ELANOUS_UX_SIM_NOVICE_FAULT = faultName;
          const faulted = await runWorldScenario(world, scenarioFile);
          expect(faulted.pass).toBe(false);
          const apply = faulted.noviceVersioning?.tasks.find(({ task }) => task === "preview-apply");
          expect(apply?.pass).toBe(false);
          expect(apply?.finalVersion).toBe(expectedVersion);
          expect((apply?.forbiddenWords.length ?? 0) > 0).toBe(expectedForbidden);
        }
      } finally {
        if (previousFault === undefined) delete process.env.ELANOUS_UX_SIM_NOVICE_FAULT;
        else process.env.ELANOUS_UX_SIM_NOVICE_FAULT = previousFault;
      }
    } finally { await destroyWorld(world); }
  });
// Source: .rules/30-harness/testing-gates.md R-TST1 — bound the OS-sandboxed scenario test.
}, { timeout: 30_000 });
