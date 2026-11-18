import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simCli } from '../in-process-cli.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const stateRoot = () => { const root = mkdtempSync(join(tmpdir(), 'sim-world-kernel-cli-')); roots.push(root); return root; };
const RUN = [['sim', 'world', 'run']] as const;

describe('sim world run — reserved ids through the real CLI process', () => {
  test('`sim world run all --seed 1` on the built-in empty packs exits 0 and writes a 0-scenario summary.json', async () => {
    const root = stateRoot();
    const result = await simCli(['sim', 'world', 'run', 'all', '--seed', '1', '--run-id', 'empty-packs'], {
      mode: 'spawn', stateRoot: root, allowPaths: RUN, timeoutMs: 60_000 });
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toMatchObject({ exitCode: 0 });
    const printed = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
    expect([printed.ok, printed.scenarios]).toEqual([true, 0]);
    const summary = JSON.parse(readFileSync(join(root, 'sim-world', 'empty-packs', 'summary.json'), 'utf8'));
    expect([summary.schema, summary.seed, summary.engine, summary.only, summary.scenarios, summary.ok]).toEqual(['sim-world.summary/1', 1, 'legacy', null, [], true]);
    expect(summary.worlds).toEqual(['memory', 'ta', 'graph', 'supervisors']);
    expect(summary.events.map((event: { kind: string; world: string }) => `${event.kind}:${event.world}`)).toEqual([
      'pack-empty:memory', 'pack-empty:ta', 'pack-empty:graph', 'pack-empty:supervisors',
    ]);
    expect(summary.mainSha).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(summary.worldWallMs)).toEqual(['graph', 'memory', 'supervisors', 'ta']);
    const replay = await simCli(['sim', 'world', 'run', 'all', '--replay', 'empty-packs', '--run-id', 'replayed'], {
      mode: 'spawn', stateRoot: root, allowPaths: RUN, timeoutMs: 60_000 });
    expect({ exitCode: replay.exitCode, stderr: replay.stderr }).toMatchObject({ exitCode: 0 });
    const replayed = JSON.parse(readFileSync(join(root, 'sim-world', 'replayed', 'summary.json'), 'utf8'));
    expect([replayed.seed, replayed.replay]).toEqual([1, { mismatches: [], of: 'empty-packs' }]);
  // Source: R-LIVE10 — real CLI child processes; the allowance covers process boot on a loaded gate host.
  }, 120_000);

  test('a reserved id without --seed or with a scenario file is refused with exit 2', async () => {
    const root = stateRoot();
    const noSeed = await simCli(['sim', 'world', 'run', 'memory'], { mode: 'spawn', stateRoot: root, allowPaths: RUN, timeoutMs: 60_000 });
    expect(noSeed.exitCode).toBe(2);
    expect(noSeed.stderr).toContain('sim world run: reserved world run requires --seed <non-negative integer>');
    const withFile = await simCli(['sim', 'world', 'run', 'ta', 'x.yaml', '--seed', '1'], { mode: 'spawn', stateRoot: root, allowPaths: RUN, timeoutMs: 60_000 });
    expect(withFile.exitCode).toBe(2);
    expect(withFile.stderr).toContain('sim world run: reserved world id ta takes no scenario file (packs live in src/ux-sim/worlds)');
    const bareSeed = await simCli(['sim', 'world', 'run', 'ta', '--seed'], { mode: 'spawn', stateRoot: root, allowPaths: RUN, timeoutMs: 60_000 });
    expect(bareSeed.exitCode).toBe(2);
    expect(bareSeed.stderr).toContain("sim world run: option '--seed' requires a value");
    expect(existsSync(join(root, 'sim-world'))).toBe(false);
  // Source: R-LIVE10 — real CLI child processes; the allowance covers process boot on a loaded gate host.
  }, 120_000);

  test('a non-reserved world id behaves as before: missing file, kernel flags and unknown worlds keep their old errors', async () => {
    const root = stateRoot();
    const missing = await simCli(['sim', 'world', 'run', 'night-train'], { mode: 'spawn', stateRoot: root, allowPaths: RUN, timeoutMs: 60_000 });
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("error: missing required argument 'scenario-file'\n");
    const flag = await simCli(['sim', 'world', 'run', 'night-train', 's.yaml', '--seed', '1'], { mode: 'spawn', stateRoot: root, allowPaths: RUN, timeoutMs: 60_000 });
    expect(flag.exitCode).toBe(1);
    expect(flag.stderr).toContain("error: unknown option '--seed'\n");
    const unknown = await simCli(['sim', 'world', 'run', 'night-train', 's.yaml'], { mode: 'spawn', stateRoot: root, allowPaths: RUN, timeoutMs: 60_000 });
    // MF1 (Terra #38487): a BARE kernel flag on a non-reserved id keeps the old pre-dispatch Commander error.
    // Literals copied from the installed CLI before this change: `elanous --test=<tmp> sim world run night-train s.yaml --seed`.
    for (const flag of ['--seed', '--only', '--engine']) {
      const bare = await simCli(['sim', 'world', 'run', 'night-train', 's.yaml', flag], { mode: 'spawn', stateRoot: root, allowPaths: RUN, timeoutMs: 60_000 });
      expect([flag, bare.exitCode]).toEqual([flag, 1]);
      expect(bare.stderr).toContain(`error: unknown option '${flag}'\n`);
    }
    // MF1 (Terra #38487 r2): after `--` a token is an operand, never an option. Literal from the installed CLI:
    // `elanous --test=<tmp> sim world run night-train -- --seed` → "sim world run: ENOENT: no such file or directory, lstat '<tmp>/sim'".
    const terminated = await simCli(['sim', 'world', 'run', 'night-train', '--', '--seed'], { mode: 'spawn', stateRoot: root, allowPaths: RUN, timeoutMs: 60_000 });
    expect(terminated.exitCode).toBe(2);
    expect(terminated.stderr).toContain("sim world run: ENOENT: no such file or directory, lstat '");
    expect(terminated.stderr).not.toContain('unknown option');
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr).toContain('sim world run: ENOENT');
    expect(existsSync(join(root, 'sim-world'))).toBe(false);
  // Source: R-LIVE10 — real CLI child processes; the allowance covers process boot on a loaded gate host.
  }, 120_000);
});
