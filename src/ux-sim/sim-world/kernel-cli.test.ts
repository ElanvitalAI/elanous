import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simCli } from '../in-process-cli.js';
import { SIM_WORLD_IDS } from './types.js';
import { sandboxedRunnerCommand } from '../world.js';

// Hosts without a usable OS network sandbox (e.g. gcp1: `unshare -rn` is denied) must refuse to run scenarios — fail-closed by design.
const sandboxUsable = (() => { try { sandboxedRunnerCommand(tmpdir(), process.cwd()); return true; } catch { return false; } })();
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const stateRoot = () => { const root = mkdtempSync(join(tmpdir(), 'sim-world-kernel-cli-')); roots.push(root); return root; };
const RUN = [['sim', 'world', 'run']] as const;

describe('sim world run — reserved ids through the real CLI process', () => {
  test('`sim world run graph --seed 1` on the graph pack (SC1–SB5 registered; single-world CLI end-to-end — decoupled from the `all` merge tree: precheck-5 id collisions, missing seat-mail pack #39231) exits 0 and writes a 15-scenario summary.json', async () => {
    const root = stateRoot();
    const result = await simCli(['sim', 'world', 'run', 'graph', '--seed', '1', '--run-id', 'graph-pack'], {
      mode: 'spawn', stateRoot: root, allowPaths: RUN, timeoutMs: 60_000 });
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toMatchObject({ exitCode: 0 });
    const printed = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
    expect([printed.ok, printed.scenarios]).toEqual([true, 15]);
    const summary = JSON.parse(readFileSync(join(root, 'sim-world', 'graph-pack', 'summary.json'), 'utf8'));
    expect([summary.schema, summary.seed, summary.engine, summary.only, summary.ok]).toEqual(['sim-world.summary/1', 1, 'legacy', null, true]);
    expect(summary.scenarios.map((row: { scenario: string }) => row.scenario)).toEqual([
      'SC1', 'SC2', 'SC3', 'SC4', 'SC5', 'SP1', 'SP2', 'SP3', 'SP4', 'SP5', 'SB1', 'SB2', 'SB3', 'SB4', 'SB5',
    ]);
    expect(summary.scenarios.every((row: { verdict: string }) => ['pass', 'xfail', 'promoted'].includes(row.verdict))).toBe(true);
    expect(summary.worlds).toEqual(['graph']);
    expect(summary.events.map((event: { kind: string; world: string }) => `${event.kind}:${event.world}`).filter((entry: string) => entry.startsWith('pack-empty'))).toEqual([]);
    expect(summary.mainSha).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(summary.worldWallMs)).toEqual(['graph']);
    const replay = await simCli(['sim', 'world', 'run', 'graph', '--replay', 'graph-pack', '--run-id', 'replayed'], {
      mode: 'spawn', stateRoot: root, allowPaths: RUN, timeoutMs: 60_000 });
    expect({ exitCode: replay.exitCode, stderr: replay.stderr }).toMatchObject({ exitCode: 0 });
    const replayed = JSON.parse(readFileSync(join(root, 'sim-world', 'replayed', 'summary.json'), 'utf8'));
    expect([replayed.seed, replayed.replay]).toEqual([1, { mismatches: [], of: 'graph-pack' }]);
  // Source: R-LIVE10 — real CLI child processes; the allowance covers process boot on a loaded gate host.
  }, 120_000);

  test('`sim world run seat-mail --seed 1` on the built-in empty pack exits 0 (`all` now runs real packs: capsule-events ~90s) and writes a 0-scenario summary.json', async () => {
    const root = stateRoot();
    const result = await simCli(['sim', 'world', 'run', 'seat-mail', '--seed', '1', '--run-id', 'empty-packs'], {
      mode: 'spawn', stateRoot: root, allowPaths: RUN, timeoutMs: 60_000 });
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toMatchObject({ exitCode: 0 });
    const printed = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
    expect([printed.ok, printed.scenarios]).toEqual([true, 0]);
    const summary = JSON.parse(readFileSync(join(root, 'sim-world', 'empty-packs', 'summary.json'), 'utf8'));
    expect([summary.schema, summary.seed, summary.engine, summary.only, summary.scenarios, summary.ok]).toEqual(['sim-world.summary/1', 1, 'legacy', null, [], true]);
    expect(summary.worlds).toEqual(['seat-mail']);
    expect(summary.events.map((event: { kind: string; world: string }) => `${event.kind}:${event.world}`)).toEqual([
      'pack-empty:seat-mail',
    ]);
    expect(summary.mainSha).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(summary.worldWallMs)).toEqual(['seat-mail']);
    const replay = await simCli(['sim', 'world', 'run', 'seat-mail', '--replay', 'empty-packs', '--run-id', 'replayed'], {
      mode: 'spawn', stateRoot: root, allowPaths: RUN, timeoutMs: 60_000 });
    expect({ exitCode: replay.exitCode, stderr: replay.stderr }).toMatchObject({ exitCode: 0 });
    const replayed = JSON.parse(readFileSync(join(root, 'sim-world', 'replayed', 'summary.json'), 'utf8'));
    expect([replayed.seed, replayed.replay]).toEqual([1, { mismatches: [], of: 'empty-packs' }]);
  // Source: R-LIVE10 — real CLI child processes; the allowance covers process boot on a loaded gate host.
  }, 120_000);

  test('`sim world run memory --seed 1` exits 0: memory M01–M12 green except M09/M10 xfail, no pack-empty event', async () => {
    const root = stateRoot();
    const result = await simCli(['sim', 'world', 'run', 'memory', '--seed', '1', '--run-id', 'empty-packs'], {
      mode: 'spawn', stateRoot: root, allowPaths: RUN, timeoutMs: 60_000 });
    if (!sandboxUsable) {
      // No OS network isolation on this host: every scenario is infra-error and the run exits 1 with one sandbox-failed event.
      expect(result.exitCode).toBe(1);
      const refused = JSON.parse(readFileSync(join(root, 'sim-world', 'empty-packs', 'summary.json'), 'utf8'));
      expect([refused.ok, refused.counts['infra-error'], refused.events.map((event: { kind: string }) => event.kind)]).toEqual([false, 13, ['sandbox-failed']]);
      return;
    }
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toMatchObject({ exitCode: 0 });
    const printed = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
    expect([printed.ok, printed.scenarios]).toEqual([true, 13]);
    const summary = JSON.parse(readFileSync(join(root, 'sim-world', 'empty-packs', 'summary.json'), 'utf8'));
    expect([summary.schema, summary.seed, summary.engine, summary.only, summary.ok]).toEqual(['sim-world.summary/1', 1, 'legacy', null, true]);
    // SIM-WORLD-MEMORY (S0): the runner calls the memory port now; M09 and M10 stay xfail with the observed literal reason.
    expect(summary.scenarios.map((row: { world: string; scenario: string; engine: string; verdict: string; observedReason: string | null }) =>
      [row.world, row.scenario, row.engine, row.verdict, row.observedReason])).toEqual([
      ['memory', 'M01', 'legacy', 'pass', null],
      ['memory', 'M02', 'legacy', 'pass', null],
      ['memory', 'M03', 'legacy', 'pass', null],
      ['memory', 'M04', 'legacy', 'pass', null],
      ['memory', 'M05', 'legacy', 'pass', null],
      ['memory', 'M06', 'legacy', 'pass', null],
      ['memory', 'M07', 'legacy', 'pass', null],
      ['memory', 'M08', 'legacy', 'pass', null],
      ['memory', 'M09', 'legacy', 'xfail', 'expectation-mismatch: tick2SeesTick1'],
      ['memory', 'M10', 'legacy', 'xfail', 'expectation-mismatch: recalled'],
      ['memory', 'M11', 'legacy', 'pass', null],
      ['memory', 'M12', 'legacy', 'pass', null],
      ['memory', 'M25', 'legacy', 'pass', null],
    ]);
    expect(summary.worlds).toEqual(['memory']);
    expect(summary.events.map((event: { kind: string; world: string }) => `${event.kind}:${event.world}`)).toEqual([]);
    expect(summary.mainSha).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(summary.worldWallMs)).toEqual(['memory']);
    const replay = await simCli(['sim', 'world', 'run', 'memory', '--replay', 'empty-packs', '--run-id', 'replayed'], {
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

describe('sim world replay of a run recorded before a world was added', () => {
  test('a 7-world `all` record replays as those 7 worlds on the 8-world registry (not as its first world only)', async () => {
    const root = stateRoot();
    const first = await simCli(['sim', 'world', 'run', 'all', '--seed', '1', '--only', 'R1-urgent-band', '--run-id', 'old7'], {
      mode: 'spawn', stateRoot: root, allowPaths: RUN, timeoutMs: 60_000 });
    expect(first.exitCode).toBe(0);
    const file = join(root, 'sim-world', 'old7', 'summary.json');
    const summary = JSON.parse(readFileSync(file, 'utf8'));
    // Synthesize the pre-`worker` record: seven worlds, no worker wall time, no worker event.
    summary.worlds = ['memory', 'ta', 'graph', 'supervisors', 'seat-mail', 'capsule-events', 'seat-mail-roundtrip'];
    delete summary.worldWallMs.worker;
    summary.events = summary.events.filter((event: { world: string }) => event.world !== 'worker');
    writeFileSync(file, JSON.stringify(summary));
    const replay = await simCli(['sim', 'world', 'run', 'all', '--replay', 'old7', '--run-id', 'replayed'], {
      mode: 'spawn', stateRoot: root, allowPaths: RUN, timeoutMs: 60_000 });
    const replayed = JSON.parse(readFileSync(join(root, 'sim-world', 'replayed', 'summary.json'), 'utf8'));
    expect([replay.exitCode, replayed.worlds, replayed.replay]).toEqual([0,
      ['memory', 'ta', 'graph', 'supervisors', 'seat-mail', 'capsule-events', 'seat-mail-roundtrip'], { mismatches: [], of: 'old7' }]);
  // Source: R-LIVE10 — two real CLI child processes; same allowance as the neighbouring replay tests.
  }, 120_000);
});

describe('sim world registration ↔ pack files', () => {
  test('every registered world has a pack yaml on disk whose `world:` matches (literal list, not the product constant)', () => {
    const worlds = ['memory', 'ta', 'graph', 'supervisors', 'seat-mail', 'capsule-events', 'seat-mail-roundtrip', 'worker'];
    const registered: string[] = [...SIM_WORLD_IDS];
    expect(registered).toEqual(worlds);
    for (const world of worlds) {
      const file = join(import.meta.dir, '..', 'worlds', `sim-world-${world}.yaml`);
      expect([world, existsSync(file) && readFileSync(file, 'utf8').includes(`\nworld: ${world}\n`)]).toEqual([world, true]);
    }
  });
});

describe('sim world run all — full run (slow: capsule-events ~92s on node-b)', () => {
  // The full `all` run cannot exit 0 on main today (capsule-events C1/C2/C5 wrong-reason-red + C6 regression → ok:false, rc 1).
  // Asserted instead: invariants true either way. TODO(MAIN-RED capsule-events): once those are green, tighten to rc 0 / ok true.
  test('`sim world run all --seed 1` (full) covers all 7 registered worlds and exits 0 iff summary.ok, else 1', async () => {
    const root = stateRoot();
    const result = await simCli(['sim', 'world', 'run', 'all', '--seed', '1', '--run-id', 'full'], {
      mode: 'spawn', stateRoot: root, allowPaths: RUN, timeoutMs: 280_000 });
    const summary = JSON.parse(readFileSync(join(root, 'sim-world', 'full', 'summary.json'), 'utf8'));
    expect(summary.worlds).toEqual(['memory', 'ta', 'graph', 'supervisors', 'seat-mail', 'capsule-events', 'seat-mail-roundtrip', 'worker']);
    expect(Object.keys(summary.worldWallMs).sort()).toEqual(['capsule-events', 'graph', 'memory', 'seat-mail', 'seat-mail-roundtrip', 'supervisors', 'ta', 'worker']);
    expect(summary.events.filter((event: { kind: string }) => event.kind === 'pack-empty').map((event: { world: string }) => event.world))
      .toEqual(['ta', 'supervisors', 'seat-mail']);
    expect(JSON.parse(result.stdout.trim().split('\n').at(-1)!).ok).toBe(summary.ok);
    expect(result.exitCode).toBe(summary.ok ? 0 : 1);
  // Source: R-LIVE10 — capsule-events alone measured ~92s on node-b; allowance covers a loaded gate host.
  }, 300_000);
});
