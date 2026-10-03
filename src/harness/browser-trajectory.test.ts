import { setDefaultTimeout, afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  browserTrajectoryDirectory,
  listSavedBrowserActionTrajectories,
  readSavedBrowserActionTrajectory,
  saveBrowserActionTrajectory,
} from './browser-trajectory.js';
import { simComputerUse } from '../ux-sim/computer-use.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const roots: string[] = [];

function testRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `browser-trajectory-${label}-`));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('named browser action trajectories', () => {
  test('saves and reads a named trajectory with timestamp/run provenance that simComputerUse consumes unchanged', async () => {
    const root = testRoot('round-trip');
    const saved = saveBrowserActionTrajectory('account-settings', {
      runId: 'run-20260827',
      status: 'ready',
      trajectory: [
        { target: '#profile', coordinates: { x: 10, y: 20 } },
        { target: 'button.save', coordinates: { x: 30, y: 40 } },
      ],
    }, root);
    const read = readSavedBrowserActionTrajectory('account-settings', root);
    const simulation = await simComputerUse({ scenario: 'normal', trajectory: read.trajectory, runId: read.source.runId });

    expect(read).toEqual(saved);
    expect(read.savedAt).toEqual(expect.any(String));
    expect(read.source).toEqual({ runId: 'run-20260827' });
    expect(simulation.actions.map(action => action.target)).toEqual(['#profile', 'button.save']);
    expect(simulation.observations.map(observation => observation.coordinates)).toEqual([{ x: 10, y: 20 }, { x: 30, y: 40 }]);
  });

  test('rejects empty trajectories on save and read so saved records remain simComputerUse-consumable', () => {
    const root = testRoot('empty');
    expect(() => saveBrowserActionTrajectory('empty-save', {
      runId: 'run-empty',
      status: 'ready',
      trajectory: [],
    }, root)).toThrow("cannot save browser trajectory 'empty-save' with an empty or invalid trajectory");

    const path = join(browserTrajectoryDirectory(root), 'empty-read.json');
    mkdirSync(browserTrajectoryDirectory(root), { recursive: true });
    writeFileSync(path, JSON.stringify({
      name: 'empty-read', savedAt: '2026-08-27T00:00:00.000Z', source: { runId: 'run-empty' }, trajectory: [],
    }));
    expect(() => readSavedBrowserActionTrajectory('empty-read', root))
      .toThrow("browser trajectory 'empty-read' is malformed");
  });

  test('missing names fail loudly with the requested name', () => {
    expect(() => readSavedBrowserActionTrajectory('missing-demo', testRoot('missing')))
      .toThrow("browser trajectory 'missing-demo' was not found");
  });

  test('uses the supplied state root and stores only trajectory plus provenance', () => {
    const testUniverse = testRoot('test-universe');
    const productionUniverse = testRoot('production-universe');
    saveBrowserActionTrajectory('isolated', {
      runId: 'run-isolated',
      status: 'ready',
      trajectory: [{ target: '#only-selector', coordinates: { x: 1, y: 2 } }],
    }, testUniverse);

    const storedPath = join(browserTrajectoryDirectory(testUniverse), 'isolated.json');
    const stored = JSON.parse(readFileSync(storedPath, 'utf8')) as Record<string, unknown>;
    expect(existsSync(storedPath)).toBe(true);
    expect(existsSync(join(browserTrajectoryDirectory(productionUniverse), 'isolated.json'))).toBe(false);
    expect(Object.keys(stored).sort()).toEqual(['name', 'savedAt', 'source', 'trajectory']);
    expect(JSON.stringify(stored)).not.toContain('attachmentRef');
    expect(JSON.stringify(stored)).not.toContain('image');
    expect(JSON.stringify(stored)).not.toContain('html');
  });

  test('CLI reads a named trajectory and passes its stored runId to computer-use simulation', async () => {
    const root = testRoot('cli');
    saveBrowserActionTrajectory('cli-replay', {
      runId: 'run-cli-source',
      status: 'ready',
      trajectory: [{ target: '#from-named-trajectory', coordinates: { x: 9, y: 8 } }],
    }, root);
    const child = Bun.spawn(['bun', 'scripts/ux-sim.ts', '--computer-use', 'normal', '--trajectory', 'cli-replay'], {
      cwd: import.meta.dir + '/../..',
      env: { ...process.env, ELANOUS_STATE_DIR: root },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('저장 궤적');
    expect(stdout).toContain('runId=run-cli-source');
    expect(stdout).toContain('관측한 궤적                  #from-named-trajectory');
  });

  test('CLI rejects --trajectory without its required name', async () => {
    const child = Bun.spawn(['bun', 'scripts/ux-sim.ts', '--computer-use', 'normal', '--trajectory'], {
      cwd: import.meta.dir + '/../..', stdout: 'pipe', stderr: 'pipe',
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

    expect(exitCode).toBe(2);
    expect(stderr).toContain('--trajectory requires a name');
  });

  test('CLI rejects a following flag as a missing --trajectory name', async () => {
    const child = Bun.spawn(['bun', 'scripts/ux-sim.ts', '--computer-use', 'normal', '--trajectory', '--from-run', 'run'], {
      cwd: import.meta.dir + '/../..', stdout: 'pipe', stderr: 'pipe',
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

    expect(exitCode).toBe(2);
    expect(stderr).toContain('--trajectory requires a name');
  });

  test('CLI rejects --save-trajectory unless --from-run is its only source', async () => {
    const withoutSource = Bun.spawn(['bun', 'scripts/ux-sim.ts', '--computer-use', 'normal', '--save-trajectory', 'demo'], {
      cwd: import.meta.dir + '/../..', stdout: 'pipe', stderr: 'pipe',
    });
    const withNamedSource = Bun.spawn(['bun', 'scripts/ux-sim.ts', '--computer-use', 'normal', '--trajectory', 'demo', '--save-trajectory', 'copy'], {
      cwd: import.meta.dir + '/../..', stdout: 'pipe', stderr: 'pipe',
    });
    const [withoutSourceExit, withoutSourceStderr, withNamedSourceExit, withNamedSourceStderr] = await Promise.all([
      withoutSource.exited,
      new Response(withoutSource.stderr).text(),
      withNamedSource.exited,
      new Response(withNamedSource.stderr).text(),
    ]);

    expect(withoutSourceExit).toBe(2);
    expect(withoutSourceStderr).toContain('--save-trajectory requires --from-run');
    expect(withNamedSourceExit).toBe(2);
    expect(withNamedSourceStderr).toContain('--save-trajectory requires --from-run');
  });

  test('lists names with embedded provenance', () => {
    const root = testRoot('list');
    saveBrowserActionTrajectory('first', { runId: 'run-first', status: 'ready', trajectory: [{ target: '#first', coordinates: { x: 1, y: 1 } }] }, root);
    saveBrowserActionTrajectory('second', { runId: 'run-second', status: 'ready', trajectory: [{ target: '#second', coordinates: { x: 2, y: 2 } }] }, root);

    expect(listSavedBrowserActionTrajectories(root)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'first', source: { runId: 'run-first' } }),
      expect.objectContaining({ name: 'second', source: { runId: 'run-second' } }),
    ]));
  });
});
