import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestStateRoot, setTestStateRoot } from '../../nexus/paths.js';
import { deviceFidelityStatus } from '../device-fidelity.js';
import { runSimWorlds, simWorldReplayOptions, type SimWorldRunOptions } from './kernel.js';
import { SIM_WORLD_IDS } from './types.js';

const roots: string[] = [];
const priorRoot = getTestStateRoot();
afterEach(() => {
  setTestStateRoot(priorRoot ?? null);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const EXAMPLE = 'src/ux-sim/sim-world/example-scenarios.ts';
const FILES = ['events.jsonl', 'walk.json', 'seam-calls.jsonl', 'claims.jsonl', 'verdict.json'];

/** Temp pack root: memory has the example rows; every other registered pack is empty. */
function fixture(entries: Record<string, unknown>, rows = ['K01', 'K02', 'K03', 'K04', 'K05', 'K06', 'K07', 'K08', 'K09'], module = EXAMPLE) {
  const root = mkdtempSync(join(tmpdir(), 'sim-world-kernel-'));
  roots.push(root);
  const packs = join(root, 'packs');
  mkdirSync(packs);
  const list = rows.length ? `\n${rows.map((id) => `  - { id: ${id}, module: ${module} }`).join('\n')}` : ' []';
  writeFileSync(join(packs, 'sim-world-memory.yaml'), `schema: 1\nworld: memory\nscenarios:${list}\n`);
  for (const world of SIM_WORLD_IDS.filter((id) => id !== 'memory')) writeFileSync(join(packs, `sim-world-${world}.yaml`), `schema: 1\nworld: ${world}\nscenarios: []\n`);
  writeFileSync(join(packs, 'sim-world-expect.json'), JSON.stringify({ schema: 1, entries }));
  const run = (runId: string, extra: Partial<SimWorldRunOptions & { replayOf: string }> = {}) => runSimWorlds({ worldId: 'all', seed: 1, engine: 'legacy', only: null,
    expectBaseFile: null, stateRoot: root, runId, packRoot: packs, isolate: 'inline', ...extra });
  return { root, packs, run };
}

const GREEN = { expect: 'green', greenSince: '2026-11-18', reason: 'example' };
const TABLE = {
  'memory/K01': GREEN,
  'memory/K02': { expect: 'red', reason: 'example red', redReason: 'memory fixed to []' },
  'memory/K03': { expect: 'red', reason: 'example throw', redReason: 'scenario crashed' },
  'memory/K04': { expect: 'red', reason: 'graph only', redReason: 'graph only' },
  'memory/K05': GREEN,
  'memory/K06': { expect: 'red', reason: 'declared reason differs', redReason: 'memory fixed to []' },
  'memory/K07': GREEN,
  'memory/K08': GREEN,
  'memory/K09': GREEN,
};

describe('SIM-WORLD-KERNEL', () => {
  test('judges every example scenario, records skips as events, and writes summary.json', async () => {
    const { root, run } = fixture(TABLE);
    const summary = await run('full');
    expect(summary.scenarios.map((row) => [row.scenario, row.actual, row.verdict, row.diffFirstLine])).toEqual([
      ['K01', 'pass', 'pass', null],
      ['K02', 'fail', 'xfail', 'context.memory: expected 1 line, got 0'],
      ['K03', 'infra-error', 'infra-error', 'scenario crashed'],
      ['K05', 'infra-error', 'infra-error', 'device K-MISSING is not registered'],
      ['K06', 'fail', 'wrong-reason-red', 'provider refused'],
      ['K07', 'absent', 'unmeasured', 'scenario returned no outcome'],
      ['K08', 'malformed', 'malformed', 'malformed scenario outcome: {"ok":"yes"}'],
      ['K09', 'pass', 'contract-violation', 'K-GH-LOOSE/gh-pulls-open#0 $[0].head: missing in fake'],
    ]);
    expect(summary.counts).toEqual({ pass: 1, xfail: 1, promoted: 0, 'promote-required': 0, regression: 0, 'ratchet-violation': 0, 'infra-error': 2, unlisted: 0,
      'wrong-reason-red': 1, unmeasured: 1, malformed: 1, 'contract-violation': 1 });
    expect(summary.events.map((event) => `${event.kind}:${event.world}`)).toEqual([
      'scenario-infra-error:memory', 'engine-unsupported:memory', 'scenario-infra-error:memory', 'contract-violation:memory',
      'pack-empty:ta', 'pack-empty:graph', 'pack-empty:supervisors', 'pack-empty:seat-mail', 'pack-empty:capsule-events', 'pack-empty:seat-mail-roundtrip', 'pack-empty:worker', 'pack-empty:op-channel',
    ]);
    expect(Object.keys(summary.worldWallMs)).toEqual(['memory', 'ta', 'graph', 'supervisors', 'seat-mail', 'capsule-events', 'seat-mail-roundtrip', 'worker', 'op-channel']);
    // The contract verdict comes from the ledger device-fidelity store in each scenario's universe.
    setTestStateRoot(join(root, 'sim-world', 'full', '.universe', 'K01'));
    expect(deviceFidelityStatus('fake-github').verdict).toBe('green');
    setTestStateRoot(join(root, 'sim-world', 'full', '.universe', 'K09'));
    expect(deviceFidelityStatus('fake-github')).toEqual({ verdict: 'yellow', failedRecordingIds: ['shape.example-gh-pulls-open.0.K09.K-GH-LOOSE.gh-pulls-open'] });
    expect(summary.replay).toBeNull();
    expect(summary.ok).toBe(false);
    expect(summary.summaryPath).toBe(join(root, 'sim-world', 'full', 'summary.json'));
    const written = JSON.parse(readFileSync(summary.summaryPath, 'utf8'));
    expect([written.schema, written.seed, written.engine, written.scenarios.length, written.ok]).toEqual(['sim-world.summary/1', 1, 'legacy', 8, false]);
    expect(written.mainSha).toMatch(/^[0-9a-f]{40}$/);
    expect(JSON.parse(readFileSync(join(root, 'sim-world', 'full', 'K02', 'verdict.json'), 'utf8'))).toEqual({
      actual: 'fail', diffFirstLine: 'context.memory: expected 1 line, got 0', engine: 'legacy', expected: 'red', observedReason: 'memory fixed to []',
      scenario: 'K02', seed: 1, verdict: 'xfail', world: 'memory',
    });
  });

  test('the same seed twice writes byte-identical scenario files', async () => {
    const { root, run } = fixture(TABLE);
    await run('first', { only: 'K01' });
    await run('second', { only: 'K01' });
    for (const name of FILES) {
      expect(readFileSync(join(root, 'sim-world', 'second', 'K01', name), 'utf8')).toBe(readFileSync(join(root, 'sim-world', 'first', 'K01', name), 'utf8'));
    }
    expect(readFileSync(join(root, 'sim-world', 'first', 'K01', 'seam-calls.jsonl'), 'utf8')).toBe(
      '{"input":1,"output":{"ok":false},"seam":"gate","seq":0}\n{"input":2,"output":{"ok":true},"seam":"gate","seq":1}\n'
      + '{"input":{"state":"open"},"output":[{"base":{"ref":"main"},"body":null,"created_at":"2026-11-03T00:00:00.000Z","draft":false,'
      + '"head":{"ref":"feature/recorded","sha":"head7"},"labels":[],"merge_commit_sha":null,"merged_at":null,"number":7,"state":"open",'
      + '"title":"Recorded PR","updated_at":"2026-11-04T09:00:00.000Z"}],"seam":"listPulls","seq":2}\n');
  });

  test('a recorder disk failure turns the scenario into infra-error with an event, never a pass', async () => {
    const { run } = fixture(TABLE);
    const summary = await run('disk', { only: 'K01', recorderFs: { mkdir: () => {}, write: () => { throw new Error('ENOSPC: no space left on device'); } } });
    expect(summary.scenarios.map((row) => [row.verdict, row.diffFirstLine])).toEqual([['infra-error', 'recorder write failed: ENOSPC: no space left on device']]);
    expect(summary.events.filter((event) => event.kind === 'recorder-write-failed').map((event) => event.detail)).toEqual(['K01: ENOSPC: no space left on device']);
    expect(summary.ok).toBe(false);
  });

  test('--engine both names dirs <scn>@<engine>; a red row that passes needs promote, and promote makes it ok', async () => {
    const { root, packs, run } = fixture(TABLE);
    const unpromoted = await run('both', { only: 'K04', engine: 'both' });
    expect(unpromoted.scenarios.map((row) => [row.dir, row.verdict])).toEqual([[join(root, 'sim-world', 'both', 'K04@graph'), 'promote-required']]);
    expect(unpromoted.events.map((event) => event.kind)).toContain('engine-unsupported');
    expect(unpromoted.ok).toBe(false);
    const base = join(root, 'base.json');
    writeFileSync(base, readFileSync(join(packs, 'sim-world-expect.json')));
    writeFileSync(join(packs, 'sim-world-expect.json'), JSON.stringify({ schema: 1, entries: { ...TABLE, 'memory/K04': { expect: 'green', greenSince: '2026-11-20', reason: 'promoted' } } }));
    const promoted = await run('promoted', { only: 'K04', engine: 'graph', expectBaseFile: base });
    expect([promoted.scenarios[0]?.verdict, promoted.ok]).toEqual(['promoted', true]);
  });

  test('ratchet violations, --only matching nothing, unlisted rows and module load failures are loud', async () => {
    const { root, packs, run } = fixture(TABLE);
    const base = join(root, 'base.json');
    writeFileSync(base, readFileSync(join(packs, 'sim-world-expect.json')));
    writeFileSync(join(packs, 'sim-world-expect.json'), JSON.stringify({ schema: 1, entries: { ...TABLE, 'memory/K01': { expect: 'red', reason: 'walked back', redReason: 'x' } } }));
    const ratchet = await run('ratchet', { only: 'K01', expectBaseFile: base });
    expect([ratchet.events.map((event) => `${event.kind}:${event.detail}`).filter((line) => line.startsWith('ratchet')), ratchet.ok]).toEqual([['ratchet-green-to-red:memory/K01@legacy', 'ratchet-green-to-red:memory/K01@graph'], false]);
    const nothing = await run('nothing', { only: 'K99' });
    expect([nothing.scenarios.length, nothing.events.some((event) => event.kind === 'only-matched-nothing'), nothing.ok]).toEqual([0, true, false]);
    const unlisted = fixture({});
    expect((await unlisted.run('unlisted', { only: 'K01' })).scenarios.map((row) => row.verdict)).toEqual(['unlisted']);
    const missing = fixture(TABLE, ['K01'], 'src/ux-sim/sim-world/no-such-module.ts');
    const failed = await missing.run('missing');
    expect([failed.scenarios[0]?.verdict, failed.events[0]?.kind]).toEqual(['infra-error', 'module-load-failed']);
  });

  test('replay re-runs a recorded run and diffs the five files; a tampered record is a loud mismatch', async () => {
    const { root, run } = fixture(TABLE);
    await run('recorded', { only: 'K01' });
    const same = await run('replay-1', { only: 'K01', replayOf: 'recorded' });
    expect([same.replay, same.ok]).toEqual([{ of: 'recorded', mismatches: [] }, true]);
    writeFileSync(join(root, 'sim-world', 'recorded', 'K01', 'walk.json'), '{}\n');
    const tampered = await run('replay-2', { only: 'K01', replayOf: 'recorded' });
    expect(tampered.replay?.mismatches.map((row) => `${row.dir}/${row.file}`)).toEqual(['K01/walk.json']);
    expect(tampered.replay?.mismatches[0]?.firstDiff).toBe('line 1: recorded "{}" · replayed "{"');
    expect([tampered.events.some((event) => event.kind === 'replay-mismatch'), tampered.ok]).toEqual([true, false]);
  });

  test('a world over its wall budget is a warning event naming the slowest scenarios, not a failure', async () => {
    const { run } = fixture(TABLE);
    const slow = await run('slow', { only: 'K01', wallBudgetMs: -1 });
    const warnings = slow.events.filter((event) => event.kind === 'world-over-budget');
    expect(warnings.map((event) => event.world)).toEqual(['memory', 'ta', 'graph', 'supervisors', 'seat-mail', 'capsule-events', 'seat-mail-roundtrip', 'worker', 'op-channel']);
    expect(warnings[0]?.detail).toMatch(/^\d+ms > -1ms · slowest K01@legacy \d+ms$/);
    expect(warnings[1]?.detail).toMatch(/^\d+ms > -1ms · slowest \(no scenarios\)$/);
    expect(slow.ok).toBe(true);
  });

  test('a recorder serialization failure (throwing getter) becomes infra-error with an event, never a pass (MF3)', async () => {
    const { run } = fixture({ ...TABLE, 'memory/K10': GREEN }, ['K10']);
    const summary = await run('hostile');
    expect(summary.scenarios.map((row) => [row.scenario, row.actual, row.verdict, row.diffFirstLine])).toEqual([
      ['K10', 'infra-error', 'infra-error', 'recorder write failed: record serialization failed: events seq 0: getter exploded'],
    ]);
    expect(summary.events.filter((event) => event.kind === 'recorder-write-failed').map((event) => event.detail))
      .toEqual(['K10: record serialization failed: events seq 0: getter exploded']);
    expect(summary.ok).toBe(false);
  });

  test('precheck 5: worlds sharing one process run one at a time, and the test root is restored after a throw', async () => {
    const { packs, run } = fixture({ ...TABLE, 'memory/K11': GREEN, 'ta/K12': GREEN }, ['K11', 'K03']);
    writeFileSync(join(packs, 'sim-world-ta.yaml'), `schema: 1\nworld: ta\nscenarios:\n  - { id: K12, module: ${EXAMPLE} }\n`);
    const before = getTestStateRoot();
    const summary = await run('serial');
    expect(summary.scenarios.map((row) => [row.world, row.scenario, row.verdict])).toEqual([
      ['memory', 'K11', 'pass'], ['memory', 'K03', 'infra-error'], ['ta', 'K12', 'pass'],
    ]);
    expect(getTestStateRoot()).toBe(before);
  });

  test('precheck 5: one scenario id in two packs is refused before anything runs (records would collide)', async () => {
    const { packs, run } = fixture(TABLE, ['K01']);
    writeFileSync(join(packs, 'sim-world-ta.yaml'), `schema: 1\nworld: ta\nscenarios:\n  - { id: K01, module: ${EXAMPLE} }\n`);
    await expect(run('dup')).rejects.toThrow('sim world scenario id K01 appears in packs memory and ta');
  });

  test('rule 14: every selected scenario skipped (engine-unsupported) is world-unmeasured and fails the run', async () => {
    const { run } = fixture(TABLE, ['K04']);
    const skipped = await run('all-skipped');
    expect([skipped.scenarios.length, skipped.ok]).toEqual([0, false]);
    expect(skipped.events.filter((event) => event.kind === 'world-unmeasured').map((event) => `${event.world}: ${event.detail}`))
      .toEqual(['memory: 1 scenario(s) selected, 0 executed (engine legacy) — nothing was measured']);
  });

  test('rule 14: some skipped and some executed keeps the normal verdict; an empty pack (0 selected) stays ok', async () => {
    const { run } = fixture(TABLE, ['K01', 'K04']);
    const mixed = await run('mixed');
    expect([mixed.scenarios.map((row) => row.scenario), mixed.events.some((event) => event.kind === 'world-unmeasured'), mixed.ok]).toEqual([['K01'], false, true]);
    const empty = fixture(TABLE, []);
    const none = await empty.run('empty');
    expect([none.scenarios.length, none.events.map((event) => event.kind), none.ok]).toEqual([0, ['pack-empty', 'pack-empty', 'pack-empty', 'pack-empty', 'pack-empty', 'pack-empty', 'pack-empty', 'pack-empty', 'pack-empty'], true]);
  });

  test('MF3: a sandbox failure reports only the selected scenarios × engines', async () => {
    const { run } = fixture(TABLE);
    const failing = async () => { throw new Error('sandbox runner exited 1: boom'); };
    const one = await run('sandbox-only', { only: 'K03', isolate: 'sandbox', runPack: failing });
    expect(one.scenarios.map((row) => [row.scenario, row.engine, row.verdict, row.diffFirstLine])).toEqual([['K03', 'legacy', 'infra-error', 'sandbox runner exited 1: boom']]);
    const both = await run('sandbox-both', { only: 'K03', engine: 'both', isolate: 'sandbox', runPack: failing });
    expect(both.scenarios.map((row) => `${row.scenario}@${row.engine} ${row.dir.slice(row.dir.lastIndexOf('/') + 1)}`)).toEqual(['K03@legacy K03@legacy', 'K03@graph K03@graph']);
    expect([one.ok, one.events.filter((event) => event.kind === 'sandbox-failed').length]).toEqual([false, 1]);
  });

  test('MF2: mainSha is refs/remotes/origin/main, not the checkout HEAD; without that ref it is null plus an event', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'sim-world-mainref-'));
    roots.push(repo);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=sim', '-c', 'user.email=sim@example.test', '-c', 'commit.gpgsign=false', ...args],
      { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'main');
    const main = git('rev-parse', 'HEAD');
    const { run } = fixture(TABLE, []);
    const unmeasured = await run('no-main-ref', { mainRefRoot: repo });
    expect([unmeasured.mainSha, unmeasured.events.filter((event) => event.kind === 'main-sha-unmeasured').map((event) => event.detail)])
      .toEqual([null, ['refs/remotes/origin/main not found']]);
    git('update-ref', 'refs/remotes/origin/main', main);
    git('checkout', '-q', '-b', 'feature');
    git('commit', '-q', '--allow-empty', '-m', 'feature');
    const feature = git('rev-parse', 'HEAD');
    const measured = await run('feature-branch', { mainRefRoot: repo });
    expect([measured.mainSha === main, measured.mainSha === feature, measured.events.some((event) => event.kind === 'main-sha-unmeasured')]).toEqual([true, false, false]);
  });

  test('MF2: --replay restores the recorded --expect-base table; a run without one replays without one', async () => {
    const { root, packs, run } = fixture(TABLE);
    const base = join(root, 'base.json');
    writeFileSync(base, readFileSync(join(packs, 'sim-world-expect.json')));
    writeFileSync(join(packs, 'sim-world-expect.json'), JSON.stringify({ schema: 1, entries: { ...TABLE, 'memory/K04': { expect: 'green', greenSince: '2026-11-20', reason: 'promoted' } } }));
    const original = await run('with-base', { only: 'K04', engine: 'graph', expectBaseFile: base });
    expect([original.scenarios[0]?.verdict, original.expectBase?.path]).toEqual(['promoted', base]);
    const replayOptions = simWorldReplayOptions(root, 'with-base');
    expect(replayOptions).toEqual({ worldId: 'all', worlds: ['memory', 'ta', 'graph', 'supervisors', 'seat-mail', 'capsule-events', 'seat-mail-roundtrip', 'worker', 'op-channel'], seed: 1, engine: 'graph', only: 'K04', expectBaseFile: base });
    const replayed = await run('with-base-replay', { ...replayOptions, replayOf: 'with-base' });
    expect([replayed.scenarios[0]?.verdict, replayed.replay?.mismatches, replayed.ok]).toEqual(['promoted', [], true]);
    const plain = await run('no-base', { only: 'K01' });
    expect([plain.expectBase, simWorldReplayOptions(root, 'no-base').expectBaseFile]).toEqual([null, null]);
  });

  test('a malformed pack or an existing run directory is refused', async () => {
    const { packs, run } = fixture(TABLE);
    await run('once', { only: 'K01' });
    await expect(run('once', { only: 'K01' })).rejects.toThrow('sim world run already exists');
    writeFileSync(join(packs, 'sim-world-ta.yaml'), 'schema: 1\nworld: graph\nscenarios: []\n');
    await expect(run('bad-pack')).rejects.toThrow('sim world pack is invalid');
  });

  test('the sandboxed runner process gives the same verdict as inline', async () => {
    const { run } = fixture(TABLE);
    const sandboxed = await run('sandbox', { only: 'K01', isolate: 'sandbox' });
    expect(sandboxed.scenarios.map((row) => [row.scenario, row.verdict])).toEqual([['K01', 'pass']]);
    const inline = await run('inline-twin', { only: 'K01' });
    const fields = (row: (typeof inline.scenarios)[number]) => [row.world, row.scenario, row.engine, row.seed, row.expected, row.actual, row.verdict, row.diffFirstLine, row.observedReason];
    expect(sandboxed.scenarios.map(fields)).toEqual(inline.scenarios.map(fields));
    expect(sandboxed.events.map((event) => event.kind)).not.toContain('sandbox-failed');
  // Source: R-LIVE10 — this one boots a real sandboxed runner process, so it gets a process-boot allowance.
  }, 60_000);
});
