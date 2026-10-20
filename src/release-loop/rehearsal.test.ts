import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { listLoops } from '../loops/registry.js';
import { registerReleaseCommands } from '../cli/release-cli.js';
import { runGraph } from '../graph-runner/runner.js';
import type { LightRcResult } from './light-rc.js';
import type { ReleaseSchedule } from './release-schedule.js';
import { planRehearsal as livePlanRehearsal, rehearsalLeakFailureDetail, runRehearsalLeakCheck, runRehearsalTick, sanitizeRehearsalLeakDetail, type HardGateResult, type RehearsalDeps, type StepId } from './rehearsal.js';
import { planRehearsalShards } from './rehearsal-shard-plan.js';

const cut = '2026-10-10T13:00:00Z';
const schedule = { version: '0.2.23', cutAt: cut, publishAt: '2026-10-10T15:30:00Z' } as ReleaseSchedule;
const at = (minutes: number) => new Date(Date.parse(cut) - minutes * 60_000);
const roots: string[] = [];
const newRoot = (midComplete = true) => {
  const root = mkdtempSync(join(tmpdir(), 'release-rehearsal-'));
  roots.push(root);
  // Light-RC and five-hour cases start from a completed mid-cycle stage. The dedicated mid-cycle case starts fresh.
  if (midComplete) {
    const path = join(root, 'release', schedule.version, 'rehearsal');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'hard-mid.json'), JSON.stringify({ version: schedule.version, step: 'hard-mid', cutAt: cut,
      outcome: 'ok', startedAt: at(720).toISOString(), endedAt: at(720).toISOString(), notifiedAt: at(720).toISOString() }));
  }
  return root;
};
afterEach(() => { resetElanousConfigDir(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const stamp = (root: string, step: StepId) => JSON.parse(readFileSync(join(root, 'release', schedule.version, 'rehearsal', `${step}.json`), 'utf8'));
const planRehearsal: typeof livePlanRehearsal = (schedules, now, stamps) => livePlanRehearsal(schedules, now, { 'hard-mid': true, ...stamps });
test('hard-mid cannot be disabled by interval zero', () => {
  expect(() => livePlanRehearsal([schedule], at(720), {}, 0)).toThrow('must be an integer from 8 to 72');
});
const rc = (overrides: Partial<LightRcResult> = {}): LightRcResult => ({ version: schedule.version, base: 'abc', measuredCommit: 'c'.repeat(40), worktreeHead: 'c'.repeat(40), importerTests: 0, unmeasured: null, introduced: 0, preexisting: 3, unclassified: 0, alwaysInclude: 1, alwaysIncludeMissing: [], shards: 4, remote: 'node-b', gateExitCode: 0, ok: true, ...overrides });
function harness(now: Date, result: LightRcResult = rc(), dirty = false) {
  const calls: string[] = [], hardCalls: string[] = [], notifications: string[] = [], gitCalls: string[] = [];
  const deps: RehearsalDeps = {
    now: () => now, schedules: () => [schedule], hardIntervalHours: 12,
    shardPlan: () => ({ shards: 4, testFiles: 30, gatePlanShards: 4, resources: { cpus: 16, freeBytes: 12e9, totalBytes: 24e9 }, unmeasured: null }),
    git: (args) => { gitCalls.push(args.join(' ')); return { rc: 0, stdout: args[0] === 'status' ? dirty ? ' M file.ts\n' : '' : args[0] === 'rev-parse' ? '1234567890abcdef\n' : '' }; },
    leakCheck: () => ({ status: 0 }),
    lightRc: async (version, checkout) => { expect(checkout).toBe('/fake/checkout'); calls.push(version); return result; },
    hardGate: async (version, checkout, sha) => {
      expect(checkout).toBe('/fake/checkout'); hardCalls.push(version);
      return { outcome: 'ok', commit: sha, executor: 'pod', introduced: [], preexisting: 0 };
    },
    notify: (text) => { notifications.push(text); },
  };
  return { deps, calls, hardCalls, notifications, gitCalls };
}

function publicExportLeakCheckout(fileName: string, exclude: string[] = [], include = 'src/**'): string {
  const checkout = mkdtempSync(join(tmpdir(), 'rehearsal-leak-checkout-'));
  roots.push(checkout);
  const mark = String.fromCodePoint(0x1f451);
  const relativePath = fileName.includes('/') ? fileName : `src/${fileName}`;
  mkdirSync(join(checkout, 'release'), { recursive: true });
  mkdirSync(dirname(join(checkout, relativePath)), { recursive: true });
  mkdirSync(join(checkout, 'scripts'));
  mkdirSync(join(checkout, 'src', 'util'), { recursive: true });
  writeFileSync(join(checkout, 'release', 'public-export.yaml'), `include: [${JSON.stringify(include)}]\nexclude: ${JSON.stringify(exclude)}\nreplace: {}\n`);
  writeFileSync(join(checkout, relativePath), `private ${mark} value\n`);
  copyFileSync(resolve(import.meta.dir, '../..', 'scripts', 'public-export.ts'), join(checkout, 'scripts', 'public-export.ts'));
  symlinkSync(resolve(import.meta.dir, '../..', 'scripts', 'skill-boundary.ts'), join(checkout, 'scripts', 'skill-boundary.ts'));
  symlinkSync(resolve(import.meta.dir, '../..', 'src', 'util', 'spawn-sync-output.ts'), join(checkout, 'src', 'util', 'spawn-sync-output.ts'));
  symlinkSync(resolve(import.meta.dir, '../..', 'node_modules'), join(checkout, 'node_modules'), 'dir');
  spawnSync('git', ['init', '-q'], { cwd: checkout });
  spawnSync('git', ['add', 'release/public-export.yaml', relativePath], { cwd: checkout });
  return checkout;
}

test('cut minus five hours launches one pinned full Pod gate with twelve shards and reports its result', async () => {
  const root = newRoot(), h = harness(at(300));
  const seen: Array<{ version: string; sha: string; ledgerRoot: string; runId: string }> = [];
  h.deps.hardGate = async (version, _checkout, sha, ledgerRoot, runId) => {
    const claimed = stamp(root, 'hard-5h');
    expect(claimed).toMatchObject({ outcome: 'running', hardGateRunId: runId,
      hardGateLog: join(root, 'release', schedule.version, 'rehearsal', `${runId}.log`) });
    seen.push({ version, sha, ledgerRoot, runId });
    return { outcome: 'regression', commit: sha, executor: 'pod', introduced: ['test/new.test.ts > new case'], preexisting: 2 };
  };
  const opts = { ledgerRoot: root, checkout: '/fake/checkout', apply: true };
  await runRehearsalTick(opts, h.deps);
  await runRehearsalTick(opts, h.deps);
  expect(seen).toHaveLength(1);
  const runId = seen[0]!.runId;
  expect(runId.startsWith('hard-')).toBe(true);
  expect(seen[0]).toMatchObject({ version: schedule.version, sha: '1234567890abcdef', ledgerRoot: root });
  expect(h.calls).toEqual([]);
  expect(stamp(root, 'rc-7h')).toMatchObject({ outcome: 'superseded' });
  expect(stamp(root, 'hard-5h')).toMatchObject({ outcome: 'regression', selection: { remote: 'node-b', shards: 12 },
    hardGate: { outcome: 'regression', executor: 'pod', introduced: ['test/new.test.ts > new case'] } });
  expect(stamp(root, 'hard-5h')).toMatchObject({ hardGateRunId: runId, hardGateLog: join(root, 'release', schedule.version, 'rehearsal', `${runId}.log`) });
  expect(h.notifications.some(text => text.includes('hard gate regression') && text.includes('node-b Pod · 12 shards'))).toBe(true);
});

test('invalid pinned Pod result fails closed', async () => {
  const root = newRoot(), h = harness(at(300)), sha = 'a'.repeat(40), id = 'src/ui/screen.test.ts > fails';
  h.deps.git = args => ({ rc: 0, stdout: args[0] === 'rev-parse' ? sha : '' });
  h.deps.hardGate = async () => ({ outcome: 'regression', commit: 'b'.repeat(40), executor: 'pod', introduced: [id], preexisting: 0 });
  await runRehearsalTick({ ledgerRoot: root, checkout: '/fake/checkout', apply: true }, h.deps);
  expect(stamp(root, 'hard-5h').outcome).toBe('error');
});

test('an ok Pod verdict with introduced failures is recorded as an error', async () => {
  const root = newRoot(), h = harness(at(300)), sha = 'a'.repeat(40);
  h.deps.git = args => ({ rc: 0, stdout: args[0] === 'rev-parse' ? sha : '' });
  h.deps.hardGate = async () => ({ outcome: 'ok', commit: sha, executor: 'pod', introduced: ['src/ui/screen.test.ts > fails'], preexisting: 0 });
  await runRehearsalTick({ ledgerRoot: root, checkout: '/fake/checkout', apply: true }, h.deps);
  const result = stamp(root, 'hard-5h');
  expect(result.outcome).toBe('error');
  expect(result.measurementGap.cause).toContain('ok verdict contains introduced failures');
});

test('default hard-gate execution passes twelve Pod shards and the pinned SHA to gate-node', async () => {
  const root = newRoot(), checkout = join(root, 'checkout'), bin = join(root, 'bin'), capture = join(root, 'gate-argv.txt');
  const sha = 'a'.repeat(40), h = harness(at(300)), priorPath = process.env.PATH;
  mkdirSync(checkout); mkdirSync(bin); mkdirSync(join(root, 'release', '0.2.22'), { recursive: true });
  writeFileSync(join(root, 'release', '0.2.22', 'release.json'), JSON.stringify({ version: '0.2.22', publishedAt: '2026-10-09T00:00:00Z' }));
  writeFileSync(join(root, 'config.json'), JSON.stringify({ release: { loop: { gatePodPool: 'k3d-elanous-pool@node-b:56' } } }));
  writeFileSync(join(bin, 'bun'), `#!/bin/sh\nprintf '%s\\n' "$@" > "$REHEARSAL_CAPTURE"\nprintf '%s\\n' '{"outcome":"ok","commit":"${sha}","executor":"pod","introduced":[],"preexisting":0}'\n`);
  chmodSync(join(bin, 'bun'), 0o755);
  setElanousConfigDir(root);
  process.env.PATH = `${bin}:${priorPath}`;
  process.env.REHEARSAL_CAPTURE = capture;
  h.deps.git = args => ({ rc: 0, stdout: args[0] === 'rev-parse' ? sha : '' });
  h.deps.hardGate = undefined;
  try {
    await runRehearsalTick({ ledgerRoot: root, checkout, apply: true }, h.deps);
    const argv = readFileSync(capture, 'utf8').trim().split('\n');
    expect(argv).toContain('scripts/release-loop/gate-node.ts');
    expect(argv.slice(argv.indexOf('--commit'), argv.indexOf('--commit') + 2)).toEqual(['--commit', sha]);
    expect(argv.slice(argv.indexOf('--pod-shards'), argv.indexOf('--pod-shards') + 2)).toEqual(['--pod-shards', '12']);
    expect(argv.slice(argv.indexOf('--executor'), argv.indexOf('--executor') + 2)).toEqual(['--executor', 'pod']);
    expect(stamp(root, 'hard-5h').outcome).toBe('ok');
  } finally { process.env.PATH = priorPath; delete process.env.REHEARSAL_CAPTURE; }
});

test('a gate launch with no JSON appends its cause to an already created empty evidence log', async () => {
  const root = newRoot(), checkout = join(root, 'checkout'), bin = join(root, 'bin'), h = harness(at(300)), priorPath = process.env.PATH;
  mkdirSync(checkout); mkdirSync(bin); mkdirSync(join(root, 'release', '0.2.22'), { recursive: true });
  writeFileSync(join(root, 'release', '0.2.22', 'release.json'), JSON.stringify({ version: '0.2.22', publishedAt: '2026-10-09T00:00:00Z' }));
  writeFileSync(join(root, 'config.json'), JSON.stringify({ release: { loop: { gatePodPool: 'k3d-elanous-pool@node-b:56' } } }));
  writeFileSync(join(bin, 'bun'), '#!/bin/sh\nprintf "pod checkout failed before verdict\\n"\nexit 2\n'); chmodSync(join(bin, 'bun'), 0o755);
  setElanousConfigDir(root);
  process.env.PATH = `${bin}:${priorPath}`;
  h.deps.hardGate = undefined;
  try {
    await runRehearsalTick({ ledgerRoot: root, checkout, apply: true }, h.deps);
    const result = stamp(root, 'hard-5h');
    expect(result.outcome).toBe('error');
    expect(result.measurementGap.cause).toContain('produced no JSON');
    expect(readFileSync(result.measurementGap.evidence, 'utf8')).toContain('pod checkout failed before verdict');
    expect(readFileSync(result.measurementGap.evidence, 'utf8')).toContain('produced no JSON');
  } finally { process.env.PATH = priorPath; }
});

test('stdout-only gate error and ID-less regression leave their verdict in evidence', async () => {
  const priorPath = process.env.PATH;
  try {
    for (const [outcome, exitCode] of [['error', 2], ['regression', 1]] as const) {
      const root = newRoot(), checkout = join(root, 'checkout'), bin = join(root, 'bin'), h = harness(at(300));
      mkdirSync(checkout); mkdirSync(bin); mkdirSync(join(root, 'release', '0.2.22'), { recursive: true });
      writeFileSync(join(root, 'release', '0.2.22', 'release.json'), JSON.stringify({ version: '0.2.22', publishedAt: '2026-10-09T00:00:00Z' }));
      writeFileSync(join(root, 'config.json'), JSON.stringify({ release: { loop: { gatePodPool: 'k3d-elanous-pool@node-b:56' } } }));
      const verdict = { outcome, commit: 'a'.repeat(40), executor: 'pod', introduced: [], preexisting: 0,
        ...(outcome === 'error' ? { error: 'worker died' } : {}) };
      writeFileSync(join(bin, 'bun'), `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(verdict)}'\nexit ${exitCode}\n`);
      chmodSync(join(bin, 'bun'), 0o755);
      setElanousConfigDir(root);
      process.env.PATH = `${bin}:${priorPath}`;
      h.deps.hardGate = undefined;
      h.deps.git = args => ({ rc: 0, stdout: args[0] === 'rev-parse' ? 'a'.repeat(40) : '' });
      await runRehearsalTick({ ledgerRoot: root, checkout, apply: true }, h.deps);
      const result = stamp(root, 'hard-5h');
      expect(result.measurementGap.runId).toBe(result.hardGateRunId);
      expect(readFileSync(result.measurementGap.evidence, 'utf8')).toContain(`"outcome":"${outcome}"`);
      expect(result.outcome).toBe(outcome === 'error' ? 'error' : 'unmeasured');
      expect(result.summary).toContain('introduced UNKNOWN');
      expect(result.summary).toContain('total failures UNKNOWN');
      expect(h.notifications.some(text => text.includes('introduced UNKNOWN') && text.includes('total failures UNKNOWN'))).toBe(true);
    }
  } finally { process.env.PATH = priorPath; }
});

test('hard-stage leak preflight failure retains run ID, cause, and evidence', async () => {
  const root = newRoot(), h = harness(at(300));
  h.deps.leakCheck = () => ({ status: 3 });
  await runRehearsalTick({ ledgerRoot: root, checkout: '/fake/checkout', apply: true }, h.deps);
  const result = stamp(root, 'hard-5h');
  expect(result.outcome).toBe('error');
  expect(result.hardGateRunId).toMatch(/^hard-/);
  expect(result.measurementGap).toMatchObject({ runId: result.hardGateRunId,
    cause: 'public export leak-check failed (rc=3) · leak-check produced no structured diagnostic' });
  expect(readFileSync(result.measurementGap.evidence, 'utf8')).toContain('public export leak-check failed (rc=3) · leak-check produced no structured diagnostic');
  expect(h.hardCalls).toEqual([]);
});

test('dead hard-gate claim preserves its run identity and existing log before reporting interruption', async () => {
  const root = newRoot(false), dir = join(root, 'release', schedule.version, 'rehearsal');
  mkdirSync(dir, { recursive: true });
  const runId = 'hard-crashed-run', evidence = join(dir, `${runId}.log`);
  writeFileSync(evidence, 'gate pod started\n');
  writeFileSync(join(dir, 'hard-5h.json'), JSON.stringify({ version: schedule.version, cutAt: cut, step: 'hard-5h',
    outcome: 'running', startedAt: at(300).toISOString(), ownerPid: 2147483647, hardGateRunId: runId, hardGateLog: evidence }));
  const h = harness(new Date(Date.parse(cut) + 60_000));
  h.deps.schedules = () => [];
  const result = await runRehearsalTick({ ledgerRoot: root, apply: true }, h.deps);
  expect(result).toMatchObject({ status: 'no-schedule', stamps: [{ outcome: 'interrupted' }] });
  const recovered = stamp(root, 'hard-5h');
  expect(recovered).toMatchObject({ outcome: 'interrupted', hardGateRunId: runId, hardGateLog: evidence,
    measurementGap: { runId, evidence, cause: expect.stringContaining('before a gate verdict') } });
  expect(readFileSync(evidence, 'utf8')).toContain('gate pod started\n');
  expect(readFileSync(evidence, 'utf8')).toContain('before a gate verdict');
  expect(h.notifications).toHaveLength(1);
  expect(h.notifications[0]).toContain(runId);
});

test('default twelve-hour mid-cycle hard gate uses the same pinned Pod path and runs once before the five-hour gate', async () => {
  const root = newRoot(false), first = harness(at(720));
  first.deps.hardIntervalHours = 12;
  expect(livePlanRehearsal([schedule], at(721), {})).toMatchObject({ status: 'not-yet', nextStepAt: at(720).toISOString() });
  const opts = { ledgerRoot: root, checkout: '/fake/checkout', apply: true };
  await runRehearsalTick(opts, first.deps);
  await runRehearsalTick(opts, first.deps);
  expect(first.hardCalls).toEqual([schedule.version]);
  expect(stamp(root, 'hard-mid')).toMatchObject({ outcome: 'ok', selection: { shards: 12, remote: 'node-b' } });
  const second = harness(at(300));
  second.deps.hardIntervalHours = 12;
  await runRehearsalTick(opts, second.deps);
  expect(second.hardCalls).toEqual([schedule.version]);
  expect(stamp(root, 'hard-5h')).toMatchObject({ outcome: 'ok', selection: { shards: 12, remote: 'node-b' } });
  expect(stamp(root, 'rc-7h').outcome).toBe('superseded');
});

test('hard rehearsal refuses a host result or wrong commit before it can mark a gate green', async () => {
  for (const bad of [{ executor: 'host' }, { commit: 'different' }] as const) {
    const root = newRoot(), h = harness(at(300));
    h.deps.hardGate = async (_version, _checkout, sha): Promise<HardGateResult> =>
      ({ outcome: 'ok', commit: sha, executor: 'pod', introduced: [], preexisting: 0, ...bad } as HardGateResult);
    await runRehearsalTick({ ledgerRoot: root, checkout: '/fake/checkout', apply: true }, h.deps);
    expect(stamp(root, 'hard-5h')).toMatchObject({ outcome: 'error' });
    expect(stamp(root, 'hard-5h').summary).toContain('did not measure pinned SHA on a Pod');
  }
});

test('hard rehearsal keeps a gate process error cause even when no verdict commit exists', async () => {
  const root = newRoot(), h = harness(at(300));
  h.deps.hardGate = async () => ({ outcome: 'error', commit: '', executor: null, introduced: [], preexisting: 0,
    error: 'pod sweep incomplete: shard-3 timed out' });
  await runRehearsalTick({ ledgerRoot: root, checkout: '/fake/checkout', apply: true }, h.deps);
  expect(stamp(root, 'hard-5h')).toMatchObject({ outcome: 'error', hardGate: { error: 'pod sweep incomplete: shard-3 timed out' } });
  expect(stamp(root, 'hard-5h').summary).toContain('shard-3 timed out');
  expect(h.notifications.some(text => text.includes('shard-3 timed out'))).toBe(true);
  const gap = stamp(root, 'hard-5h').measurementGap;
  expect(gap).toMatchObject({ cause: 'pod sweep incomplete: shard-3 timed out', runId: expect.stringContaining('hard-') });
  expect(readFileSync(gap.evidence, 'utf8')).toContain('shard-3 timed out');
});

test('hard rehearsal records a cause and an actual evidence file when a verdict cannot be measured', async () => {
  const root = newRoot(), h = harness(at(300));
  h.deps.hardGate = async (_version, _checkout, sha) => ({ outcome: 'regression', commit: sha, executor: 'pod', introduced: [], preexisting: 2 });
  await runRehearsalTick({ ledgerRoot: root, checkout: '/fake/checkout', apply: true }, h.deps);
  const saved = stamp(root, 'hard-5h');
  expect(saved.outcome).toBe('unmeasured');
  expect(saved.measurementGap).toMatchObject({ cause: 'regression verdict has no introduced IDs', runId: saved.hardGateRunId, evidence: saved.hardGateLog });
  expect(readFileSync(saved.hardGateLog, 'utf8')).toContain('regression');
  expect(h.notifications.some(text => text.includes('regression verdict has no introduced IDs'))).toBe(true);
});

test('rehearsal leak-check runs on the pinned checkout before RC and blocks a leak', async () => {
  const root = newRoot();
  const h = harness(at(300));
  const seen: string[] = [];
  h.deps.leakCheck = (checkout) => { seen.push(checkout); return { status: 1, detail: '1 hit(s) · ceo-mark graphs/units/land/land.yaml:11' }; };
  await runRehearsalTick({ ledgerRoot: root, checkout: '/fake/checkout', apply: true }, h.deps);
  expect(seen).toEqual(['/fake/checkout']);
  expect(h.calls).toEqual([]);
  expect(stamp(root, 'hard-5h')).toMatchObject({ outcome: 'error', sha: '1234567890abcdef',
    leakCheck: { outcome: 'fail', sha: '1234567890abcdef', exitCode: 1, detail: 'leak-check produced no structured diagnostic' } });
  expect(stamp(root, 'hard-5h').summary).toContain('public export leak-check failed (rc=1) · leak-check produced no structured diagnostic');
  expect(readFileSync(stamp(root, 'hard-5h').measurementGap.evidence, 'utf8')).toContain('leak-check produced no structured diagnostic');
});

test('rehearsal leak-check diagnostic names the pattern, source file and line', () => {
  expect(rehearsalLeakFailureDetail(JSON.stringify({ leaks: 24, hits: [
    { marker: 'ceo-mark', file: 'graphs/units/land/land.yaml', line: 11, text: 'directive: private marker' },
  ] }), '')).toBe('24 hit(s) · ceo-mark graphs/units/land/land.yaml:11');
  expect(rehearsalLeakFailureDetail('', 'private stdout', 'private spawn error')).toBe('leak-check produced no structured diagnostic');
  expect(rehearsalLeakFailureDetail(JSON.stringify({ leaks: 1, hits: [
    { marker: 'ceo-mark', file: 'src/private-secret.txt', line: 1, text: 'private source text' },
  ] }), '')).toBe('1 hit(s) · ceo-mark src/private-secret.txt:1');
  expect(rehearsalLeakFailureDetail(JSON.stringify({ leaks: 1, hits: [
    { marker: 'made-up-marker', file: 'src/.env', line: 1 },
  ] }), '')).toBe('leak-check produced no structured diagnostic');
});

test('persisted leak paths must be tracked and included by that checkout manifest', () => {
  const checkout = publicExportLeakCheckout('hidden.ts', ['src/hidden.ts']);
  expect(sanitizeRehearsalLeakDetail('1 hit(s) · ceo-mark src/hidden.ts:1', checkout))
    .toBe('leak-check produced no structured diagnostic');
  const included = publicExportLeakCheckout('leak.txt');
  expect(sanitizeRehearsalLeakDetail('1 hit(s) · ceo-mark src/leak.txt:999', included))
    .toBe('leak-check produced no structured diagnostic');
  expect(sanitizeRehearsalLeakDetail('1 hit(s) · kr-mobile-phone src/leak.txt:1', included))
    .toBe('leak-check produced no structured diagnostic');
  for (const control of ['\r', '\u001b']) {
    expect(sanitizeRehearsalLeakDetail(`1 hit(s) · ceo-mark src/leak${control}.txt:1`))
      .toBe('leak-check produced no structured diagnostic');
  }
  writeFileSync(join(included, 'src/leak.txt'), 'ordinary public content\n');
  expect(sanitizeRehearsalLeakDetail('1 hit(s) · ceo-mark src/leak.txt:1', included))
    .toBe('leak-check produced no structured diagnostic');
  writeFileSync(join(included, 'src/leak.txt'), `private ${String.fromCodePoint(0x1f451)} value\n`);
  const outside = mkdtempSync(join(tmpdir(), 'rehearsal-leak-outside-'));
  const outsideFile = join(outside, 'leak.txt');
  writeFileSync(outsideFile, `private ${String.fromCodePoint(0x1f451)} value\n`);
  unlinkSync(join(included, 'src/leak.txt'));
  symlinkSync(outsideFile, join(included, 'src/leak.txt'));
  spawnSync('git', ['add', '-f', 'src/leak.txt'], { cwd: included });
  expect(sanitizeRehearsalLeakDetail('1 hit(s) · ceo-mark src/leak.txt:1', included))
    .toBe('leak-check produced no structured diagnostic');
  rmSync(outside, { recursive: true, force: true });
  const addedSurface = publicExportLeakCheckout('other/leak.ts', [], 'other/**');
  expect(sanitizeRehearsalLeakDetail('1 hit(s) · ceo-mark other/leak.ts:1', addedSurface))
    .toBe('1 hit(s) · ceo-mark other/leak.ts:1');
});

test('rehearsal rejects injected non-numeric leak exit codes before persisting them', async () => {
  const root = newRoot(), h = harness(at(300));
  h.deps.leakCheck = () => ({ status: 'secret' as unknown as number, detail: 'secret output' });
  await runRehearsalTick({ ledgerRoot: root, checkout: '/fake/checkout', apply: true }, h.deps);
  const saved = stamp(root, 'hard-5h');
  expect(saved.leakCheck).toMatchObject({ outcome: 'fail', exitCode: null, detail: 'leak-check produced no structured diagnostic' });
  expect(saved.summary.includes('secret')).toBe(false);
  expect(readFileSync(saved.measurementGap.evidence, 'utf8').includes('secret')).toBe(false);
});

test('real public-export leak output is persisted to the hard rehearsal stamp and log without source text', async () => {
  const safeRoot = newRoot(), safeCheckout = publicExportLeakCheckout('leak.txt'), h = harness(at(300));
  // Keep this test focused on the planted public-export leak. A missing host
  // redaction table adds an unrelated private-identifiers-unchecked hit.
  const previousRedactions = process.env.ELANOUS_EXPORT_REDACTIONS;
  const emptyRedactions = join(safeRoot, 'empty-export-redactions.tsv');
  writeFileSync(emptyRedactions, '');
  process.env.ELANOUS_EXPORT_REDACTIONS = emptyRedactions;
  h.deps.git = args => ({ rc: 0, stdout: args[0] === 'rev-parse' ? 'f'.repeat(40) : '' });
  h.deps.leakCheck = runRehearsalLeakCheck;
  try {
    await runRehearsalTick({ ledgerRoot: safeRoot, checkout: safeCheckout, apply: true }, h.deps);
    const safe = stamp(safeRoot, 'hard-5h'), expectedSafe = '1 hit(s) · ceo-mark src/leak.txt:1';
    const safeEvidence = readFileSync(safe.measurementGap.evidence, 'utf8');
    expect(safe.outcome).toBe('error');
    expect(safe.leakCheck.exitCode).toBe(1);
    expect(safe.leakCheck.detail).toBe(expectedSafe);
    expect((safe.summary as string).includes(expectedSafe)).toBe(true);
    expect(safeEvidence).toContain(`public export leak-check failed (rc=1) · ${expectedSafe}`);
    const safePersisted = JSON.stringify(safe) + safeEvidence;
    for (const sourceText of ['private', 'value', String.fromCodePoint(0x1f451)]) expect(safePersisted.includes(sourceText)).toBe(false);

    const privateRoot = newRoot(), privateCheckout = publicExportLeakCheckout('private-secret.txt');
    await runRehearsalTick({ ledgerRoot: privateRoot, checkout: privateCheckout, apply: true }, h.deps);
    const privatePath = stamp(privateRoot, 'hard-5h'), privateEvidence = readFileSync(privatePath.measurementGap.evidence, 'utf8');
    const persisted = JSON.stringify(privatePath) + privateEvidence;
    const expectedPrivate = '1 hit(s) · ceo-mark src/private-secret.txt:1';
    for (const sourceText of [`private ${String.fromCodePoint(0x1f451)} value`, 'value', String.fromCodePoint(0x1f451)])
      expect(persisted.includes(sourceText)).toBe(false);
    expect(privatePath.outcome).toBe('error');
    expect(privatePath.leakCheck.exitCode).toBe(1);
    expect(privatePath.leakCheck.detail).toBe(expectedPrivate);
    expect((privatePath.summary as string).includes(expectedPrivate)).toBe(true);
    expect(privatePath.measurementGap.cause).toBe(`public export leak-check failed (rc=1) · ${expectedPrivate}`);
    expect(privateEvidence).toContain(privatePath.measurementGap.cause);
  } finally {
    if (previousRedactions === undefined) delete process.env.ELANOUS_EXPORT_REDACTIONS;
    else process.env.ELANOUS_EXPORT_REDACTIONS = previousRedactions;
  }
}, 30_000);

test('next future cut picks earliest cut, then version; exact boundaries and already stamped stages', () => {
  const later = { ...schedule, version: '0.2.25', cutAt: '2026-10-10T14:00:00Z' };
  const equal = { ...schedule, version: '0.2.24' };
  expect(planRehearsal([later, equal, schedule], at(540), {})).toEqual({ status: 'not-yet', version: schedule.version, cutAt: cut, nextStepAt: at(420).toISOString() });
  expect(planRehearsal([schedule], new Date(at(420).getTime() - 1), {}).status).toBe('not-yet');
  expect(planRehearsal([schedule], at(420), {})).toMatchObject({ status: 'due', run: 'rc-7h', supersede: [] });
  expect(planRehearsal([schedule], new Date(at(300).getTime() - 1), { 'rc-7h': true })).toMatchObject({ status: 'not-yet', nextStepAt: at(300).toISOString() });
  expect(planRehearsal([schedule], at(300), { 'rc-7h': true })).toMatchObject({ status: 'due', run: 'hard-5h', supersede: [] });
  expect(planRehearsal([schedule], at(300), {})).toMatchObject({ status: 'due', run: 'hard-5h', supersede: ['rc-7h'] });
  expect(planRehearsal([schedule], at(150), { 'rc-7h': true })).toMatchObject({ status: 'due', run: 'rc-150m', supersede: ['hard-5h'] });
  expect(planRehearsal([schedule], at(150), {})).toMatchObject({ status: 'due', run: 'rc-150m', supersede: ['rc-7h', 'hard-5h'] });
  expect(planRehearsal([schedule], at(120), { 'rc-150m': true })).toMatchObject({ status: 'due', run: null, supersede: ['rc-7h', 'hard-5h'] });
  expect(planRehearsal([schedule], at(45), {})).toMatchObject({ status: 'due', run: null, supersede: ['rc-7h', 'hard-5h', 'rc-150m'] });
  expect(planRehearsal([schedule], at(30), { 'rc-7h': true, 'hard-5h': true, 'rc-150m': true }).status).toBe('nothing-due');
  expect(planRehearsal([schedule], new Date(cut), {}).status).toBe('no-schedule');
  expect(planRehearsal([], at(420), {}).status).toBe('no-schedule');
});

test('rehearsal tick stamps a failed TUI screen result as an error, not a successful RC', async () => {
  const root = newRoot();
  const h = harness(at(420), rc({ ok: false, rehearsalTui: { outcome: 'fail', detail: 'help-closes failed' } }));
  const tick = await runRehearsalTick({ ledgerRoot: root, checkout: '/fake/checkout', apply: true }, h.deps);
  expect(tick.status).toBe('due');
  expect(h.calls).toEqual([schedule.version]);
  expect(stamp(root, 'rc-7h')).toMatchObject({ outcome: 'error', result: { ok: false, rehearsalTui: { outcome: 'fail', detail: 'help-closes failed' } } });
});

test('explicit shard count and host reach the RC run and its stamp', async () => {
  const root = newRoot();
  const h = harness(at(420), rc({ shards: 12, remote: 'node-c' }));
  const selections: Array<{ shards?: number; remote?: string }> = [];
  const lightRc = h.deps.lightRc!;
  h.deps.lightRc = async (version, checkout, selection) => {
    selections.push(selection);
    return lightRc(version, checkout, selection);
  };
  const tick = await runRehearsalTick({ ledgerRoot: root, checkout: '/fake/checkout', apply: true, shards: 12, remote: 'node-c' }, h.deps);
  expect(tick.status).toBe('due');
  expect(selections).toEqual([{ shards: 12, remote: 'node-c' }]);
  expect(stamp(root, 'rc-7h')).toMatchObject({ outcome: 'ok', selection: { shards: 12, remote: 'node-c' }, result: { shards: 12, remote: 'node-c' } });
});

test('RC-reported shard count must match selected count before an explicit run can be green', async () => {
  const root = newRoot(), h = harness(at(420), rc({ shards: 4, ok: true }));
  await runRehearsalTick({ ledgerRoot: root, checkout: '/fake/checkout', apply: true, shards: 12 }, h.deps);
  expect(stamp(root, 'rc-7h')).toMatchObject({ outcome: 'unmeasured', selection: { shards: 12 }, result: { shards: 4 } });
  expect(stamp(root, 'rc-7h').summary).toContain('selected shards 12 but RC reported 4');
  expect(h.notifications[0]).toContain('selected shards 12 but RC reported 4');
});

test('measured gate failure and shard mismatch remain error without hiding the mismatch', async () => {
  const root = newRoot(), h = harness(at(420), rc({ shards: 4, ok: false, gateExitCode: 1 }));
  await runRehearsalTick({ ledgerRoot: root, checkout: '/fake/checkout', apply: true, shards: 12 }, h.deps);
  expect(stamp(root, 'rc-7h')).toMatchObject({ outcome: 'error', selection: { shards: 12 } });
  expect(stamp(root, 'rc-7h').summary).toContain('selected shards 12 but RC reported 4');
  expect(h.notifications[0]).toContain('selected shards 12 but RC reported 4');
});

test('no-option tick calls the actual planner with selected files, stored board and resources', async () => {
  const root = newRoot(), h = harness(at(420), rc());
  const selections: Array<{ shards?: number; remote?: string }> = [];
  const lightRc = h.deps.lightRc!;
  h.deps.lightRc = async (version, checkout, selection) => { selections.push(selection); return lightRc(version, checkout, selection); };
  h.deps.shardPlan = planRehearsalShards;
  h.deps.shardPlanDeps = {
    resolveBase: () => 'base', readAlways: () => 'test/always.test.ts',
    select: () => ({ testFiles: ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts'] }),
    resources: () => ({ cpus: 2, freeBytes: 8e9, totalBytes: 16e9 }),
    board: () => ({ v: 1, version: schedule.version, updatedAt: at(420).toISOString(), shards: Array.from({ length: 5 }, (_, i) => ({ id: String(i), state: 'done' })) }),
  };
  await runRehearsalTick({ ledgerRoot: root, checkout: '/fake/checkout', apply: true }, h.deps);
  expect(selections).toEqual([{ shards: 3, remote: undefined }]);
  expect(stamp(root, 'rc-7h')).toMatchObject({ outcome: 'unmeasured', selection: { shards: 3 }, shardPlan: { testFiles: 3, gatePlanShards: 5, resources: { cpus: 2, freeBytes: 8e9, totalBytes: 16e9 } } });
  expect(stamp(root, 'rc-7h').summary).toContain('importer coverage not reported');
});

test('complete selected-file memory and a measured RC can finish a no-option tick as ok', async () => {
  const root = newRoot(), h = harness(at(420), rc({ shards: 2 }));
  h.deps.shardPlan = planRehearsalShards;
  h.deps.shardPlanDeps = {
    resolveBase: () => 'base', readAlways: () => 'test/always.test.ts',
    select: () => ({ testFiles: ['test/a.test.ts', 'test/b.test.ts'], unrunImporterTotal: 0 }),
    fileMemory: () => new Map([['test/a.test.ts', 500], ['test/b.test.ts', 600]]),
    resources: () => ({ cpus: 4, freeBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 }),
    board: () => ({ v: 1, version: schedule.version, updatedAt: at(420).toISOString(), shards: [{ id: '0', state: 'done' }, { id: '1', state: 'done' }] }),
  };
  await runRehearsalTick({ ledgerRoot: root, checkout: '/fake/checkout', apply: true }, h.deps);
  expect(stamp(root, 'rc-7h')).toMatchObject({ outcome: 'ok', selection: { shards: 2 }, shardPlan: { testFiles: 2, gatePlanShards: 2, unmeasured: null } });
});

test('remote no-option tick does not use local memory to cap its shard count', async () => {
  for (const freeBytes of [3 * 1024 ** 3, 7 * 1024 ** 3, 227 * 1024 ** 3]) {
    const expected = 5;
    const root = newRoot(), h = harness(at(420), rc({ shards: expected }));
    const selections: Array<{ shards?: number; remote?: string }> = [];
    const lightRc = h.deps.lightRc!;
    h.deps.lightRc = async (version, checkout, selection) => { selections.push(selection); return lightRc(version, checkout, selection); };
    h.deps.shardPlan = planRehearsalShards;
    h.deps.shardPlanDeps = {
      resolveBase: () => 'base', readAlways: () => 'test/always.test.ts',
      select: () => ({ testFiles: Array.from({ length: 30 }, (_, i) => `test/${i}.test.ts`), unrunImporterTotal: 0 }),
      resources: () => ({ cpus: 16, totalBytes: 256 * 1024 ** 3, freeBytes }),
      board: () => ({ v: 1, version: schedule.version, updatedAt: at(420).toISOString(), shards: Array.from({ length: 5 }, (_, i) => ({ id: String(i), state: 'done' })) }),
    };
    await runRehearsalTick({ ledgerRoot: root, checkout: '/fake/checkout', apply: true }, h.deps);
    expect(selections).toEqual([{ shards: expected, remote: undefined }]);
    expect(stamp(root, 'rc-7h')).toMatchObject({ outcome: 'unmeasured', selection: { shards: expected }, shardPlan: { testFiles: 30, gatePlanShards: 5, resources: { freeBytes }, capacity: { requiredBytes: (1 + 2 * expected) * 1024 ** 3 } } });
    expect(stamp(root, 'rc-7h').summary).toContain('selected file memory not measured');
  }
});

test('remote no-option tick runs RC despite a zero local memory slot and stamps its measured result', async () => {
  const root = newRoot(), h = harness(at(420), rc({ shards: 1 }));
  h.deps.shardPlan = planRehearsalShards;
  h.deps.shardPlanDeps = {
    resolveBase: () => 'base', readAlways: () => 'test/always.test.ts',
    select: () => ({ testFiles: ['test/a.test.ts'], unrunImporterTotal: 0 }),
    fileMemory: () => new Map([['test/a.test.ts', 6_000]]),
    resources: () => ({ cpus: 8, freeBytes: 1, totalBytes: 16 * 1024 ** 3 }),
    board: () => ({ v: 1, version: schedule.version, updatedAt: at(420).toISOString(), shards: [{ id: '0', state: 'done' }] }),
  };
  const opts = { ledgerRoot: root, checkout: '/fake/checkout', apply: true };
  await runRehearsalTick(opts, h.deps);
  await runRehearsalTick(opts, h.deps);
  expect(h.calls).toEqual([schedule.version]);
  expect(stamp(root, 'rc-7h')).toMatchObject({ outcome: 'ok', selection: { shards: 1 }, shardPlan: { capacity: { memoryShards: 0, peakFileBytes: 6_000_000_000 }, remoteCapacityVerifiedBy: 'node-b', unmeasured: null } });
  expect(h.notifications).toHaveLength(1);
});

test('no-option tick records real planning evidence and forwards candidate shards; incomplete evidence stays unmeasured', async () => {
  const root = newRoot(), h = harness(at(420), rc());
  const selections: Array<{ shards?: number; remote?: string }> = [];
  const lightRc = h.deps.lightRc!;
  h.deps.lightRc = async (version, checkout, selection) => { selections.push(selection); return lightRc(version, checkout, selection); };
  h.deps.shardPlan = () => ({ shards: 12, testFiles: 699, gatePlanShards: 12, resources: { cpus: 16, freeBytes: 227e9, totalBytes: 256e9 }, unmeasured: 'sufficiency threshold not measured' });
  await runRehearsalTick({ ledgerRoot: root, checkout: '/fake/checkout', apply: true }, h.deps);
  expect(selections).toEqual([{ shards: 12, remote: undefined }]);
  expect(stamp(root, 'rc-7h')).toMatchObject({ outcome: 'unmeasured', selection: { shards: 12 }, shardPlan: { shards: 12, testFiles: 699, gatePlanShards: 12, resources: { cpus: 16, freeBytes: 227e9 } } });
  expect(stamp(root, 'rc-7h').summary).toContain('sufficiency threshold not measured');
  expect(stamp(root, 'rc-7h').shardPlan.testFiles).toBe(699);
  expect(h.notifications[0]).toContain('sufficiency threshold not measured');
  await runRehearsalTick({ ledgerRoot: root, checkout: '/fake/checkout', apply: true }, h.deps);
  expect(selections).toHaveLength(1);
});

test('a preflight with no runnable shards releases its claim and the next tick retries the same RC', async () => {
  const root = newRoot(), h = harness(at(420), rc({ shards: 1 }));
  const stage = join(root, 'release', schedule.version, 'rehearsal', 'rc-7h.json');
  let files = 0;
  h.deps.shardPlan = () => ({ shards: 1, testFiles: files, gatePlanShards: 4,
    resources: { cpus: 8, freeBytes: 8e9, totalBytes: 16e9 }, unmeasured: files ? null : 'selected test files empty' });
  const opts = { ledgerRoot: root, checkout: '/fake/checkout', apply: true };
  const first = await runRehearsalTick(opts, h.deps);
  expect(first).toMatchObject({ status: 'due', run: 'rc-7h', stamps: [{ outcome: 'unmeasured', shardPlan: { testFiles: 0 }, summary: expect.stringContaining('no runnable rehearsal shards') }] });
  expect(existsSync(stage)).toBe(false);
  expect(h.calls).toEqual([]);
  expect(h.notifications).toEqual([]);
  files = 1;
  const second = await runRehearsalTick(opts, h.deps);
  expect(second).toMatchObject({ status: 'due', run: 'rc-7h', stamps: [{ outcome: 'ok', shardPlan: { testFiles: 1 } }] });
  expect(h.calls).toEqual([schedule.version]);
  expect(stamp(root, 'rc-7h').outcome).toBe('ok');
});

test('missing gate shard plan releases claim regardless of diagnostic wording', async () => {
  const root = newRoot(), h = harness(at(420), rc({ shards: 1 }));
  const stage = join(root, 'release', schedule.version, 'rehearsal', 'rc-7h.json');
  let boardReady = false;
  h.deps.shardPlan = () => ({ shards: 1, testFiles: 1, gatePlanShards: boardReady ? 1 : null,
    resources: { cpus: 8, freeBytes: 8e9, totalBytes: 16e9 },
    planningGaps: boardReady ? [] : ['gate board pending'],
    unmeasured: boardReady ? null : 'gate board pending' });
  const opts = { ledgerRoot: root, checkout: '/fake/checkout', apply: true };
  const first = await runRehearsalTick(opts, h.deps);
  expect(first).toMatchObject({ status: 'due', run: 'rc-7h', stamps: [{ outcome: 'unmeasured', shardPlan: { gatePlanShards: null } }] });
  expect(existsSync(stage)).toBe(false);
  expect(h.calls).toEqual([]);
  boardReady = true;
  const second = await runRehearsalTick(opts, h.deps);
  expect(second).toMatchObject({ status: 'due', run: 'rc-7h', stamps: [{ outcome: 'ok', shardPlan: { gatePlanShards: 1 } }] });
  expect(h.calls).toEqual([schedule.version]);
});

test('leak-check failure stays recorded even when the gate shard plan is missing', async () => {
  const root = newRoot(), h = harness(at(420));
  h.deps.leakCheck = () => ({ status: 1 });
  h.deps.shardPlan = () => ({ shards: 1, testFiles: 1, gatePlanShards: null,
    resources: { cpus: 8, freeBytes: 8e9, totalBytes: 16e9 }, unmeasured: 'gate board pending' });
  await runRehearsalTick({ ledgerRoot: root, checkout: '/fake/checkout', apply: true }, h.deps);
  expect(stamp(root, 'rc-7h')).toMatchObject({ outcome: 'error', leakCheck: { outcome: 'fail', exitCode: 1 } });
  expect(h.calls).toEqual([]);
});

test('remote override forwards planned shards but leaves remote capacity unmeasured', async () => {
  const root = newRoot(), h = harness(at(420));
  const selections: Array<{ shards?: number; remote?: string }> = [];
  h.deps.shardPlan = () => ({ shards: 3, testFiles: 18, gatePlanShards: 3, resources: { cpus: 8, freeBytes: 4e9, totalBytes: 8e9 }, unmeasured: 'remote capacity not measured' });
  const lightRc = h.deps.lightRc!;
  h.deps.lightRc = async (version, checkout, selection) => { selections.push(selection); return lightRc(version, checkout, selection); };
  await runRehearsalTick({ ledgerRoot: root, checkout: '/fake/checkout', apply: true, remote: 'node-c' }, h.deps);
  expect(selections).toEqual([{ shards: 3, remote: 'node-c' }]);
  expect(stamp(root, 'rc-7h').shardPlan.unmeasured).toContain('remote capacity not measured');
  expect(stamp(root, 'rc-7h')).toMatchObject({ outcome: 'unmeasured' });
  expect(stamp(root, 'rc-7h').summary).toContain('remote capacity not measured');
});

test('requested remote must match the RC host before capacity can be verified', async () => {
  const root = newRoot(), h = harness(at(420), rc({ shards: 3, remote: 'node-b' }));
  h.deps.shardPlan = () => ({ shards: 3, testFiles: 3, gatePlanShards: 3,
    resources: { cpus: 8, freeBytes: 8e9, totalBytes: 16e9 }, remoteCapacityPending: true,
    planningGaps: [], unmeasured: 'remote gate host resources unmeasured before RC' });
  await runRehearsalTick({ ledgerRoot: root, checkout: '/fake/checkout', apply: true, remote: 'node-c' }, h.deps);
  expect(stamp(root, 'rc-7h')).toMatchObject({ outcome: 'unmeasured', shardPlan: { remoteCapacityPending: true } });
  expect(stamp(root, 'rc-7h').summary).toContain('requested remote node-c but RC reported node-b');
});

test('failed RC alert preserves a requested-versus-actual remote mismatch', async () => {
  const root = newRoot(), h = harness(at(420), rc({ shards: 4, remote: 'node-b', ok: false, gateExitCode: 1 }));
  await runRehearsalTick({ ledgerRoot: root, checkout: '/fake/checkout', apply: true, shards: 4, remote: 'node-c' }, h.deps);
  expect(stamp(root, 'rc-7h').outcome).toBe('error');
  expect(h.notifications[0]).toContain('requested remote node-c but RC reported node-b');
});

test('runner failure preserves already-stamped planning gap', async () => {
  const root = newRoot(), h = harness(at(420));
  h.deps.shardPlan = () => ({ shards: 2, testFiles: 7, gatePlanShards: 2, resources: { cpus: 2, freeBytes: 2e9, totalBytes: 4e9 }, unmeasured: 'selected file memory missing' });
  h.deps.lightRc = async () => { throw new Error('runner failure'); };
  await runRehearsalTick({ ledgerRoot: root, checkout: '/fake/checkout', apply: true }, h.deps);
  expect(stamp(root, 'rc-7h')).toMatchObject({ outcome: 'error', shardPlan: { testFiles: 7 } });
  expect(stamp(root, 'rc-7h').summary).toContain('runner failure · unmeasured: selected file memory missing');
  expect(h.notifications[0]).toContain('selected file memory missing');
});

test('measured RC gate failure outranks an unmeasured no-option shard plan without hiding its reason', async () => {
  for (const result of [rc({ ok: false, gateExitCode: 0 }), rc({ ok: true, gateExitCode: 1 })]) {
    const root = newRoot(), h = harness(at(420), result);
    h.deps.shardPlan = () => ({ shards: 4, testFiles: 18, gatePlanShards: 4, resources: { cpus: 8, freeBytes: 4e9, totalBytes: 8e9 }, unmeasured: 'sufficiency threshold not measured' });
    await runRehearsalTick({ ledgerRoot: root, checkout: '/fake/checkout', apply: true }, h.deps);
    expect(stamp(root, 'rc-7h')).toMatchObject({ outcome: 'error', result, shardPlan: { testFiles: 18, unmeasured: 'sufficiency threshold not measured' } });
    expect(stamp(root, 'rc-7h').summary).toContain('unmeasured: sufficiency threshold not measured');
    expect(h.notifications[0]).toContain('· error ·');
    expect(h.notifications[0]).toContain('sufficiency threshold not measured');
  }
});

test('reported regression remains visible but incomplete planning cannot be stamped regression', async () => {
  const root = newRoot(), h = harness(at(420), rc({ introduced: 2, ok: false }));
  h.deps.shardPlan = () => ({ shards: 4, testFiles: 18, gatePlanShards: 4,
    resources: { cpus: 8, freeBytes: 4e9, totalBytes: 8e9 }, unmeasured: 'selected file memory not measured' });
  await runRehearsalTick({ ledgerRoot: root, checkout: '/fake/checkout', apply: true }, h.deps);
  expect(stamp(root, 'rc-7h').outcome).toBe('unmeasured');
  expect(stamp(root, 'rc-7h').summary).toContain('introduced 2');
  expect(h.notifications[0]).toContain('selected file memory not measured');
});

test('RC unmeasured reason survives summary and notification even with explicit shards', async () => {
  const root = newRoot(), h = harness(at(420), rc({ unmeasured: 'shard-2', ok: false }));
  await runRehearsalTick({ ledgerRoot: root, checkout: '/fake/checkout', apply: true, shards: 4 }, h.deps);
  expect(stamp(root, 'rc-7h')).toMatchObject({ outcome: 'unmeasured' });
  expect(stamp(root, 'rc-7h').summary).toContain('shard-2');
  expect(h.notifications[0]).toContain('shard-2');
});

test('empty RC unmeasured reason cannot turn a failed RC into ok', async () => {
  const root = newRoot(), h = harness(at(420), rc({ unmeasured: '', ok: false }));
  await runRehearsalTick({ ledgerRoot: root, checkout: '/fake/checkout', apply: true, shards: 4 }, h.deps);
  expect(stamp(root, 'rc-7h').outcome).toBe('unmeasured');
  expect(stamp(root, 'rc-7h').summary).toContain('RC reason empty');
});

test('invalid explicit shard count and host are refused before any rehearsal stamp or launch', async () => {
  for (const selection of [{ shards: 0 }, { shards: 1.5 }, { shards: Number.NaN }, { remote: '-invalid' }]) {
    const root = newRoot(false);
    const h = harness(at(420));
    await expect(runRehearsalTick({ ledgerRoot: root, checkout: '/fake/checkout', apply: true, ...selection }, h.deps)).rejects.toThrow(/invalid --(?:shards|remote)/);
    expect(h.calls).toEqual([]);
    expect(existsSync(join(root, 'release'))).toBe(false);
  }
});

test('two identical -7h ticks claim the stage once; outcome and SHA stay in the stamp', async () => {
  const root = newRoot(), h = harness(at(420));
  const opts = { ledgerRoot: root, checkout: '/fake/checkout', apply: true };
  const [first, second] = await Promise.all([runRehearsalTick(opts, h.deps), runRehearsalTick(opts, h.deps)]);
  expect(first.status).toBe('due');
  expect(second.status).toBe('not-yet');
  expect(h.calls).toEqual([schedule.version]);
  expect(h.gitCalls).toEqual(['status --porcelain', 'fetch -q origin main', 'checkout -q --detach origin/main', 'rev-parse HEAD']);
  expect(h.notifications).toHaveLength(1);
  expect(h.notifications[0]).toContain('새 회귀 0 · 기존 3 · 미분류 0 · node-b');
  expect(h.notifications[0]!.split('\n')).toHaveLength(1);
  expect(stamp(root, 'rc-7h')).toMatchObject({ outcome: 'ok', sha: '1234567890abcdef', result: { introduced: 0 }, startedAt: at(420).toISOString() });
  expect(existsSync(join(root, 'release', schedule.version, 'rehearsal', 'rc-150m.json'))).toBe(false);
  expect(readdirSync(join(root, 'release', schedule.version, 'rehearsal')).sort()).toEqual(['hard-mid.json', 'rc-7h.json']);
});

test('false delivery survives restart and retries without rerunning RC; preview never sends', async () => {
  const root = newRoot(), first = harness(at(420));
  first.deps.notify = (text) => { first.notifications.push(text); return false; };
  const opts = { ledgerRoot: root, checkout: '/fake/checkout', apply: true };
  expect(await runRehearsalTick(opts, first.deps)).toMatchObject({ notificationFailures: 1 });
  expect(stamp(root, 'rc-7h')).toMatchObject({ outcome: 'ok', result: { introduced: 0 } });
  expect(stamp(root, 'rc-7h').notifiedAt).toBeUndefined();
  const restarted = harness(at(400));
  expect((await runRehearsalTick({ ...opts, apply: false }, restarted.deps)).status).toBe('not-yet');
  expect(restarted.notifications).toEqual([]);
  expect(await runRehearsalTick(opts, restarted.deps)).toMatchObject({ status: 'not-yet', notificationFailures: 0 });
  expect(restarted.calls).toEqual([]);
  expect(restarted.gitCalls).toEqual([]);
  expect(restarted.notifications).toEqual(first.notifications);
  expect(stamp(root, 'rc-7h').notifiedAt).toBe(at(400).toISOString());
  await runRehearsalTick(opts, restarted.deps);
  expect(restarted.notifications).toHaveLength(1);
});

test('an already claimed running stage is never retried as an RC or announced as a result', async () => {
  const root = newRoot(), h = harness(at(420));
  const dir = join(root, 'release', schedule.version, 'rehearsal');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'rc-7h.json'), JSON.stringify({ version: schedule.version, cutAt: cut, step: 'rc-7h', outcome: 'running', startedAt: at(420).toISOString() }));
  const result = await runRehearsalTick({ ledgerRoot: root, apply: true, checkout: '/fake/checkout' }, h.deps);
  expect(result.status).toBe('not-yet');
  expect(h.calls).toEqual([]);
  expect(h.notifications).toEqual([]);
  expect(stamp(root, 'rc-7h').outcome).toBe('running');
});

test('stale running claim from a dead owner alerts interruption without re-running, then retries failed notification', async () => {
  const root = newRoot(), h = harness(at(120));
  const dir = join(root, 'release', schedule.version, 'rehearsal');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'rc-7h.json'), JSON.stringify({ version: schedule.version, cutAt: cut, step: 'rc-7h', outcome: 'running', startedAt: at(420).toISOString(), ownerPid: 2147483647 }));
  h.deps.notify = () => false;
  const opts = { ledgerRoot: root, apply: true, checkout: '/fake/checkout' };
  await runRehearsalTick(opts, h.deps);
  expect(stamp(root, 'rc-7h')).toMatchObject({ outcome: 'interrupted', endedAt: at(120).toISOString() });
  expect(stamp(root, 'rc-7h').notifiedAt).toBeUndefined();
  expect(h.calls).toEqual([schedule.version]); // Only the distinct rc-150m is allowed to run.
  expect(stamp(root, 'rc-150m').outcome).toBe('ok');
  const later = harness(at(100));
  await runRehearsalTick(opts, later.deps);
  expect(later.calls).toEqual([]);
  expect(later.notifications).toHaveLength(3); // interrupted rc-7h, superseded hard-5h, completed rc-150m
  expect(later.notifications[0]).toContain('interrupted');
  expect(stamp(root, 'rc-7h').notifiedAt).toBe(at(100).toISOString());
});

test('the interrupted transition is exclusive: a live lock holder blocks it; a dead holder is never unlinked, the next generation is taken', async () => {
  const root = newRoot(), dir = join(root, 'release', schedule.version, 'rehearsal');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'rc-7h.json');
  writeFileSync(path, JSON.stringify({ version: schedule.version, cutAt: cut, step: 'rc-7h', outcome: 'running', startedAt: at(420).toISOString(), ownerPid: 2147483647 }));
  const lock0 = `${path}.interrupt.lock`;
  writeFileSync(lock0, JSON.stringify({ pid: process.pid, token: 'live' }));
  const h = harness(new Date(Date.parse(cut) + 60_000));
  h.deps.schedules = () => [];
  const opts = { ledgerRoot: root, apply: true };
  await runRehearsalTick(opts, h.deps);
  expect(stamp(root, 'rc-7h').outcome).toBe('running');
  expect(h.notifications).toEqual([]);
  expect(readFileSync(lock0, 'utf8')).toContain('live');
  writeFileSync(lock0, JSON.stringify({ pid: 2147483647, token: 'dead' }));
  await runRehearsalTick(opts, h.deps);
  expect(stamp(root, 'rc-7h').outcome).toBe('interrupted');
  expect(h.notifications).toHaveLength(1);
  expect(readFileSync(lock0, 'utf8')).toContain('dead'); // never removed by another tick
  expect(existsSync(`${path}.interrupt.lock.1`)).toBe(false); // own generation released
  await runRehearsalTick(opts, h.deps);
  expect(h.notifications).toHaveLength(1);
});

test('two concurrent tick processes on a dead-owner stamp (with and without a dead transition lock) transition and announce it exactly once', async () => {
  const root = newRoot(), dir = join(root, 'release', schedule.version, 'rehearsal');
  mkdirSync(dir, { recursive: true });
  const sent = join(root, 'sent.log');
  const script = join(root, 'tick.ts');
  writeFileSync(script, `import { appendFileSync } from 'node:fs';
import { runRehearsalTick } from ${JSON.stringify(resolve(import.meta.dir, 'rehearsal.ts'))};
const [root, sent, go] = process.argv.slice(2);
while (Date.now() < Number(go)) { /* align both ticks */ }
await runRehearsalTick({ ledgerRoot: root, apply: true }, { now: () => new Date(${JSON.stringify(new Date(Date.parse(cut) + 60_000).toISOString())}), schedules: () => [],
  notify: (text) => { appendFileSync(sent, text + '\\n'); } });
`);
  for (let round = 0; round < 6; round++) {
    rmSync(join(dir, 'rc-7h.json.interrupt.lock'), { force: true });
    // Odd rounds: both processes must also recover the same dead transition lock.
    if (round % 2) writeFileSync(join(dir, 'rc-7h.json.interrupt.lock'), JSON.stringify({ pid: 2147483647, token: 'dead' }));
    writeFileSync(join(dir, 'rc-7h.json'), JSON.stringify({ version: schedule.version, cutAt: cut, step: 'rc-7h', outcome: 'running', startedAt: at(420).toISOString(), ownerPid: 2147483647 }));
    rmSync(sent, { force: true });
    const go = String(Date.now() + 1500);
    const procs = [0, 1].map(() => Bun.spawn(['bun', script, root, sent, go], { stdout: 'pipe', stderr: 'pipe' }));
    const codes = await Promise.all(procs.map(proc => proc.exited));
    expect(codes).toEqual([0, 0]);
    const lines = readFileSync(sent, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('interrupted');
    expect(stamp(root, 'rc-7h')).toMatchObject({ outcome: 'interrupted' });
    expect(stamp(root, 'rc-7h').notifiedAt).toBeDefined();
  }
}, 60_000);

test('a corrupt stamp left by a crash neither blocks other stages and notifications nor re-runs its stage', async () => {
  const root = newRoot(), dir = join(root, 'release', schedule.version, 'rehearsal');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'rc-7h.json'), '{"version":"0.2.23","st');
  const h = harness(at(120));
  const result = await runRehearsalTick({ ledgerRoot: root, apply: true, checkout: '/fake/checkout' }, h.deps);
  expect(result).toMatchObject({ status: 'due', run: 'rc-150m', supersede: ['hard-5h'] });
  expect(h.calls).toEqual([schedule.version]);
  expect(stamp(root, 'rc-150m').outcome).toBe('ok');
  expect(h.notifications).toHaveLength(2); // hard-5h is also stamped superseded on a late wake
  expect(readFileSync(join(dir, 'rc-7h.json'), 'utf8')).toBe('{"version":"0.2.23","st');
  expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]);
});

test('a live long-running claim is preserved, but a dead claim is reported after its cut even without a schedule', async () => {
  const root = newRoot(), dir = join(root, 'release', schedule.version, 'rehearsal');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'rc-7h.json');
  writeFileSync(path, JSON.stringify({ version: schedule.version, cutAt: cut, step: 'rc-7h', outcome: 'running', startedAt: at(420).toISOString(), ownerPid: process.pid }));
  const h = harness(new Date(Date.parse(cut) + 60_000));
  h.deps.schedules = () => [];
  const opts = { ledgerRoot: root, apply: true };
  await runRehearsalTick(opts, h.deps);
  expect(stamp(root, 'rc-7h').outcome).toBe('running');
  expect(h.notifications).toEqual([]);
  writeFileSync(path, JSON.stringify({ version: schedule.version, cutAt: cut, step: 'rc-7h', outcome: 'running', startedAt: at(420).toISOString(), ownerPid: 2147483647 }));
  const result = await runRehearsalTick(opts, h.deps);
  expect(result).toMatchObject({ status: 'no-schedule', stamps: [{ outcome: 'interrupted' }] });
  expect(h.calls).toEqual([]);
  expect(h.notifications).toHaveLength(1);
  expect(h.notifications[0]).toContain('⛔ 리허설 0.2.23 rc-7h · interrupted');
  await runRehearsalTick(opts, h.deps);
  expect(h.notifications).toHaveLength(1);
});

test('an aged notification lock owned by a live sender is never stolen; dead owner can be recovered', async () => {
  const root = newRoot(), first = harness(at(420));
  first.deps.notify = () => false;
  const opts = { ledgerRoot: root, apply: true, checkout: '/fake/checkout' };
  await runRehearsalTick(opts, first.deps);
  const lock = join(root, 'release', schedule.version, 'rehearsal', 'rc-7h.json.notify.lock');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'live' }));
  utimesSync(lock, new Date(0), new Date(0));
  const h = harness(at(400));
  expect((await runRehearsalTick(opts, h.deps)).notificationFailures).toBe(1);
  expect(h.notifications).toEqual([]);
  expect(readFileSync(lock, 'utf8')).toContain('live');
  expect(stamp(root, 'rc-7h').notifiedAt).toBeUndefined();
  writeFileSync(lock, JSON.stringify({ pid: 2147483647, token: 'dead' }));
  utimesSync(lock, new Date(0), new Date(0));
  expect((await runRehearsalTick(opts, h.deps)).notificationFailures).toBe(0);
  expect(h.notifications).toHaveLength(1);
  expect(readFileSync(lock, 'utf8')).toContain('dead'); // a dead holder's lock is skipped, never unlinked
  expect(existsSync(`${lock}.1`)).toBe(false); // own generation released
});

test('notification locks have no generation cap and two processes recovering the same dead notify lock send once', async () => {
  const root = newRoot(), first = harness(at(420));
  first.deps.notify = () => false;
  const opts = { ledgerRoot: root, apply: true, checkout: '/fake/checkout' };
  await runRehearsalTick(opts, first.deps);
  const lock = join(root, 'release', schedule.version, 'rehearsal', 'rc-7h.json.notify.lock');
  for (let generation = 0; generation < 20; generation++) writeFileSync(generation ? `${lock}.${generation}` : lock, JSON.stringify({ pid: 2147483647, token: `dead-${generation}` }));
  const sent = join(root, 'sent.log');
  const script = join(root, 'tick.ts');
  writeFileSync(script, `import { appendFileSync } from 'node:fs';
import { runRehearsalTick } from ${JSON.stringify(resolve(import.meta.dir, 'rehearsal.ts'))};
const [root, sent, go] = process.argv.slice(2);
while (Date.now() < Number(go)) { /* align both ticks */ }
await runRehearsalTick({ ledgerRoot: root, apply: true }, { now: () => new Date(${JSON.stringify(at(410).toISOString())}), schedules: () => [],
  notify: async (text) => { appendFileSync(sent, text + '\\n'); await new Promise((r) => setTimeout(r, 200)); } });
`);
  const go = String(Date.now() + 1500);
  const procs = [0, 1].map(() => Bun.spawn(['bun', script, root, sent, go], { stdout: 'pipe', stderr: 'pipe' }));
  expect(await Promise.all(procs.map(proc => proc.exited))).toEqual([0, 0]);
  expect(readFileSync(sent, 'utf8').trim().split('\n')).toHaveLength(1);
  expect(stamp(root, 'rc-7h').notifiedAt).toBeDefined();
  expect(readFileSync(`${lock}.19`, 'utf8')).toContain('dead-19');
}, 60_000);

test('overlapping retries do not send the same completed stage twice', async () => {
  const root = newRoot(), h = harness(at(420));
  h.deps.notify = () => false;
  const opts = { ledgerRoot: root, apply: true, checkout: '/fake/checkout' };
  await runRehearsalTick(opts, h.deps);
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  let attempts = 0;
  h.deps.notify = async () => { attempts++; started(); await waiting; return true; };
  const first = runRehearsalTick(opts, h.deps);
  await entered;
  utimesSync(join(root, 'release', schedule.version, 'rehearsal', 'rc-7h.json.notify.lock'), new Date(0), new Date(0));
  const second = await runRehearsalTick(opts, h.deps);
  expect(second.notificationFailures).toBe(1);
  release();
  await first;
  expect(attempts).toBe(1);
  expect(h.calls).toEqual([schedule.version]);
  expect(stamp(root, 'rc-7h').notifiedAt).toBeDefined();
});

test('delivery retry persists after the schedule is removed or its cut has elapsed', async () => {
  for (const schedules of [[], [schedule]]) {
    const root = newRoot(), h = harness(at(420));
    h.deps.notify = () => false;
    await runRehearsalTick({ ledgerRoot: root, apply: true, checkout: '/fake/checkout' }, h.deps);
    const restarted = harness(new Date(Date.parse(cut) + 60_000));
    restarted.deps.schedules = () => schedules;
    expect((await runRehearsalTick({ ledgerRoot: root, apply: true }, restarted.deps)).status).toBe('no-schedule');
    expect(restarted.notifications).toHaveLength(1);
    expect(restarted.calls).toEqual([]);
    expect(stamp(root, 'rc-7h').notifiedAt).toBeDefined();
  }
});

test('throwing delivery retries superseded and no-checkout alerts on the next tick', async () => {
  const root = newRoot(), failed = harness(at(30));
  failed.deps.notify = () => { throw new Error('offline'); };
  const opts = { ledgerRoot: root, apply: true };
  expect(await runRehearsalTick(opts, failed.deps)).toMatchObject({ notificationFailures: 3 });
  for (const step of ['rc-7h', 'hard-5h', 'rc-150m'] as const) expect(stamp(root, step)).toMatchObject({ outcome: 'superseded' });
  const restarted = harness(at(20));
  expect((await runRehearsalTick(opts, restarted.deps)).notificationFailures).toBe(0);
  expect(restarted.calls).toEqual([]);
  expect(restarted.notifications).toHaveLength(3);
  for (const step of ['rc-7h', 'hard-5h', 'rc-150m'] as const) expect(stamp(root, step).notifiedAt).toBe(at(20).toISOString());

  const missing = newRoot(), m = harness(at(420));
  const env = process.env.ELANOUS_REHEARSAL_GIT_CWD;
  try {
    delete process.env.ELANOUS_REHEARSAL_GIT_CWD;
    m.deps.notify = () => { throw new Error('offline'); };
    expect((await runRehearsalTick({ ledgerRoot: missing, apply: true }, m.deps)).notificationFailures).toBe(1);
    const retry = harness(at(400));
    await runRehearsalTick({ ledgerRoot: missing, apply: true }, retry.deps);
    expect(retry.calls).toEqual([]);
    expect(retry.notifications).toHaveLength(1);
    expect(retry.notifications[0]).toContain('ELANOUS_REHEARSAL_GIT_CWD');
    expect(stamp(missing, 'rc-7h')).toMatchObject({ outcome: 'no-checkout', notifiedAt: at(400).toISOString() });
  } finally { if (env === undefined) delete process.env.ELANOUS_REHEARSAL_GIT_CWD; else process.env.ELANOUS_REHEARSAL_GIT_CWD = env; }
});

test('late wake runs only rc-150m; from -45m on every unstamped step is superseded', async () => {
  const root = newRoot(), h = harness(at(120));
  await runRehearsalTick({ ledgerRoot: root, apply: true, checkout: '/fake/checkout' }, h.deps);
  expect(h.calls).toEqual([schedule.version]);
  expect(stamp(root, 'rc-150m').outcome).toBe('ok');
  expect(stamp(root, 'rc-7h').outcome).toBe('superseded');
  expect(stamp(root, 'hard-5h').outcome).toBe('superseded');
  expect(h.notifications).toHaveLength(3);
  await runRehearsalTick({ ledgerRoot: root, apply: true, checkout: '/fake/checkout' }, h.deps);
  expect(h.calls).toEqual([schedule.version]);
  expect(h.notifications).toHaveLength(3);
  const lateRoot = newRoot(), late = harness(at(30));
  await runRehearsalTick({ ledgerRoot: lateRoot, apply: true, checkout: '/fake/checkout' }, late.deps);
  expect(late.calls).toEqual([]);
  expect(late.gitCalls).toEqual([]);
  expect(stamp(lateRoot, 'rc-7h').outcome).toBe('superseded');
  expect(stamp(lateRoot, 'hard-5h').outcome).toBe('superseded');
  expect(stamp(lateRoot, 'rc-150m').outcome).toBe('superseded');
  expect(late.notifications).toHaveLength(3);
});

test('unmeasured is not green; absent or dirty checkout has one notification and never runs RC', async () => {
  const unknown = newRoot(), u = harness(at(420), rc({ unclassified: null, ok: false }));
  await runRehearsalTick({ ledgerRoot: unknown, apply: true, checkout: '/fake/checkout' }, u.deps);
  expect(stamp(unknown, 'rc-7h').outcome).toBe('unmeasured');
  expect(u.calls).toHaveLength(1);
  const missing = newRoot(), m = harness(at(420));
  const prior = process.env.ELANOUS_REHEARSAL_GIT_CWD;
  try {
    delete process.env.ELANOUS_REHEARSAL_GIT_CWD;
    await runRehearsalTick({ ledgerRoot: missing, apply: true }, m.deps);
  } finally { if (prior === undefined) delete process.env.ELANOUS_REHEARSAL_GIT_CWD; else process.env.ELANOUS_REHEARSAL_GIT_CWD = prior; }
  expect(stamp(missing, 'rc-7h').outcome).toBe('no-checkout');
  expect(m.calls).toHaveLength(0);
  expect(m.gitCalls).toHaveLength(0);
  expect(m.notifications).toHaveLength(1);
  expect(m.notifications[0]).toContain('ELANOUS_REHEARSAL_GIT_CWD');
  const dirty = newRoot(), d = harness(at(420), rc(), true);
  await runRehearsalTick({ ledgerRoot: dirty, apply: true, checkout: '/fake/checkout' }, d.deps);
  expect(stamp(dirty, 'rc-7h').outcome).toBe('checkout-dirty');
  expect(d.gitCalls).toEqual(['status --porcelain']);
  expect(d.calls).toHaveLength(0);
  expect(d.notifications).toHaveLength(1);
});

test('regression, unclassified failures, git failure and runner throw remain distinct in stamps and alerts', async () => {
  for (const [result, outcome] of [[rc({ introduced: 2, ok: false }), 'regression'], [rc({ unclassified: 1, ok: false }), 'unmeasured']] as const) {
    const root = newRoot(), h = harness(at(420), result);
    await runRehearsalTick({ ledgerRoot: root, apply: true, checkout: '/fake/checkout' }, h.deps);
    expect(stamp(root, 'rc-7h').outcome).toBe(outcome);
    expect(h.notifications).toHaveLength(1);
  }
  const root = newRoot(), h = harness(at(420));
  h.deps.lightRc = async () => { throw new Error('runner failure\nsecret detail'); };
  await runRehearsalTick({ ledgerRoot: root, apply: true, checkout: '/fake/checkout' }, h.deps);
  expect(stamp(root, 'rc-7h')).toMatchObject({ outcome: 'error', summary: 'runner failure' });
  expect(h.notifications[0]).not.toContain('secret detail');
  const fetchRoot = newRoot(), f = harness(at(420));
  f.deps.git = (args) => ({ rc: args[0] === 'fetch' ? 1 : 0, stdout: '', stderr: 'offline' });
  await runRehearsalTick({ ledgerRoot: fetchRoot, apply: true, checkout: '/fake/checkout' }, f.deps);
  expect(stamp(fetchRoot, 'rc-7h').outcome).toBe('error');
  expect(f.calls).toHaveLength(0);
});

test('a failed RC gate never reports a clean measurement as ok', async () => {
  for (const result of [rc({ ok: false, gateExitCode: 0 }), rc({ ok: true, gateExitCode: 1 })]) {
    const root = newRoot(), h = harness(at(420), result);
    await runRehearsalTick({ ledgerRoot: root, apply: true, checkout: '/fake/checkout' }, h.deps);
    expect(stamp(root, 'rc-7h')).toMatchObject({ outcome: 'error', result });
    expect(h.calls).toEqual([schedule.version]);
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0]).toStartWith('⛔ 리허설');
    expect(h.notifications[0]).toContain('· error ·');
    expect(h.notifications[0]).toContain(`gate rc ${result.gateExitCode}`);
    if (!result.ok) expect(h.notifications[0]).toContain('RC 실패');
    expect(h.notifications[0]).not.toContain('· ok ·');
  }
});

test('a cut rescheduled after rc-7h claim still cannot execute rc-7h again for that version', async () => {
  const root = newRoot(), h = harness(at(420));
  await runRehearsalTick({ ledgerRoot: root, apply: true, checkout: '/fake/checkout' }, h.deps);
  const moved = { ...schedule, cutAt: new Date(Date.parse(cut) + 60 * 60_000).toISOString() };
  h.deps.schedules = () => [moved];
  const next = await runRehearsalTick({ ledgerRoot: root, apply: true, checkout: '/fake/checkout' }, h.deps);
  expect(next).toMatchObject({ status: 'not-yet', nextStepAt: new Date(Date.parse(moved.cutAt) - 300 * 60_000).toISOString() });
  expect(h.calls).toEqual([schedule.version]);
  expect(stamp(root, 'rc-7h').cutAt).toBe(cut);
});

test('empty, elapsed, not-yet and preview do not touch git, RC, notifications or stamp directory', async () => {
  for (const [schedules, now, expected] of [[[], at(420), 'no-schedule'], [[schedule], new Date(cut), 'no-schedule'], [[schedule], at(900), 'not-yet'], [[schedule], at(420), 'due']] as const) {
    const root = newRoot(false), h = harness(now);
    h.deps.schedules = () => [...schedules];
    const result = await runRehearsalTick({ ledgerRoot: root, checkout: '/fake/checkout', apply: expected === 'due' ? false : true }, h.deps);
    expect(result.status).toBe(expected);
    expect(h.calls).toEqual([]);
    expect(h.notifications).toEqual([]);
    expect(h.gitCalls).toEqual([]);
    expect(existsSync(join(root, 'release', schedule.version, 'rehearsal'))).toBe(false);
  }
});

test('CLI preview is read-only and JSON remains one line; loop registry names the cron graph', async () => {
  const root = newRoot(false);
  setElanousConfigDir(root);
  const program = new Command();
  registerReleaseCommands(program, { ledgerRoot: root });
  const output: string[] = [];
  const oldWrite = process.stdout.write, oldError = console.error;
  try {
    process.stdout.write = ((chunk: string) => { output.push(String(chunk)); return true; }) as typeof process.stdout.write;
    console.error = () => {};
    await program.parseAsync(['release', 'rehearsal', 'tick', '--json'], { from: 'user' });
  } finally { process.stdout.write = oldWrite; console.error = oldError; }
  expect(output).toHaveLength(1);
  expect(JSON.parse(output[0]!)).toMatchObject({ ok: true, status: 'no-schedule' });
  expect(existsSync(join(root, 'release', schedule.version, 'rehearsal'))).toBe(false);
  const repo = resolve(import.meta.dir, '..', '..');
  const loop = listLoops({ root: repo, stateRoot: root, schedules: [] }).find(item => item.id === 'release-rehearsal');
  expect(loop).toMatchObject({ id: 'release-rehearsal', trigger: { cron: '*/15 * * * *' }, file: 'graphs/release-rehearsal/release-rehearsal.yaml' });
}, 30_000);

test('CLI apply accepts injected clock and checkout, emits one JSON result and claims once', async () => {
  const root = newRoot(), h = harness(at(420), rc({ shards: 12, remote: 'node-c' }));
  const selections: Array<{ shards?: number; remote?: string }> = [];
  const lightRc = h.deps.lightRc!;
  h.deps.lightRc = async (version, checkout, selection) => {
    selections.push(selection);
    return lightRc(version, checkout, selection);
  };
  setElanousConfigDir(root);
  const cli = new Command();
  registerReleaseCommands(cli, { ledgerRoot: root }, {}, {}, {}, h.deps);
  const output: string[] = [];
  const original = process.stdout.write;
  const oldError = console.error;
  const exit = process.exitCode;
  try {
    process.exitCode = 0;
    process.stdout.write = ((chunk: string) => { output.push(String(chunk)); return true; }) as typeof process.stdout.write;
    console.error = () => {};
    await cli.parseAsync(['release', 'rehearsal', 'tick', '--apply', '--checkout', '/fake/checkout', '--shards', '12', '--remote', 'node-c', '--json'], { from: 'user' });
    await cli.parseAsync(['release', 'rehearsal', 'tick', '--apply', '--checkout', '/fake/checkout', '--json'], { from: 'user' });
    expect(process.exitCode).toBe(0);
  } finally { process.exitCode = exit ?? 0; process.stdout.write = original; console.error = oldError; }
  expect(output).toHaveLength(2);
  expect(JSON.parse(output[0]!)).toMatchObject({ ok: true, status: 'due', stamps: [{ outcome: 'ok' }] });
  expect(JSON.parse(output[1]!)).toMatchObject({ ok: true, status: 'not-yet' });
  expect(h.calls).toEqual([schedule.version]);
  expect(selections).toEqual([{ shards: 12, remote: 'node-c' }]);
  expect(stamp(root, 'rc-7h').sha).toBe('1234567890abcdef');
});

test('release CLI two ticks report shard shortage, released claim, and same-stage retry in an isolated ledger', async () => {
  const root = newRoot(), h = harness(at(420), rc({ shards: 1 }));
  const checkout = resolve(import.meta.dir, '..', '..');
  const stage = join(root, 'release', schedule.version, 'rehearsal', 'rc-7h.json');
  let boardReady = false;
  h.deps.shardPlan = planRehearsalShards;
  let leakChecks = 0;
  h.deps.leakCheck = () => { leakChecks++; return { status: 0 }; };
  h.deps.shardPlanDeps = {
    resolveBase: () => 'base', readAlways: () => '',
    select: () => ({ testFiles: ['src/release-loop/rehearsal.test.ts'], unrunImporterTotal: 0 }),
    fileMemory: () => new Map([['src/release-loop/rehearsal.test.ts', 500]]),
    resources: () => ({ cpus: 4, freeBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 }),
    board: () => boardReady ? { v: 1, version: schedule.version, updatedAt: at(420).toISOString(), shards: [{ id: '0', state: 'done' }] } : null,
  };
  h.deps.lightRc = async (version, cwd) => {
    expect(cwd).toBe(checkout);
    h.calls.push(version);
    return rc({ shards: 1 });
  };
  setElanousConfigDir(root);
  const cli = new Command(); registerReleaseCommands(cli, { ledgerRoot: root }, {}, {}, {}, h.deps);
  const outputs: string[] = [];
  const original = process.stdout.write, oldError = console.error, exit = process.exitCode;
  try {
    process.stdout.write = ((chunk: string) => { outputs.push(String(chunk)); return true; }) as typeof process.stdout.write;
    console.error = () => {};
    const args = ['release', 'rehearsal', 'tick', '--apply', '--checkout', checkout, '--json'];
    process.exitCode = 0;
    await cli.parseAsync(args, { from: 'user' });
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(outputs[0]!)).toMatchObject({ ok: false, status: 'due', run: 'rc-7h', stamps: [{ outcome: 'unmeasured', shardPlan: { gatePlanShards: null, testFiles: 1 } }] });
    expect(existsSync(stage)).toBe(false);
    expect(h.calls).toEqual([]);
    expect(leakChecks).toBe(1);
    boardReady = true;
    process.exitCode = 0;
    await cli.parseAsync(args, { from: 'user' });
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(outputs[1]!)).toMatchObject({ ok: true, status: 'due', run: 'rc-7h', stamps: [{ outcome: 'ok', shardPlan: { testFiles: 1 } }] });
    expect(stamp(root, 'rc-7h')).toMatchObject({ outcome: 'ok', result: { shards: 1 } });
    expect(h.calls).toEqual([schedule.version]);
    expect(leakChecks).toBe(2);
  } finally { process.exitCode = exit ?? 0; process.stdout.write = original; console.error = oldError; }
});

test('CLI rejects invalid --shards and --remote before RC stamp', async () => {
  for (const args of [['--shards', '0'], ['--shards', 'NaN'], ['--remote', '-invalid']]) {
    const root = newRoot(false), h = harness(at(420));
    setElanousConfigDir(root);
    const cli = new Command();
    registerReleaseCommands(cli, { ledgerRoot: root }, {}, {}, {}, h.deps);
    const output: string[] = [];
    const original = process.stdout.write, oldError = console.error, exit = process.exitCode;
    try {
      process.stdout.write = ((chunk: string) => { output.push(String(chunk)); return true; }) as typeof process.stdout.write;
      console.error = () => {};
      process.exitCode = 0;
      await cli.parseAsync(['release', 'rehearsal', 'tick', '--apply', '--checkout', '/fake/checkout', ...args, '--json'], { from: 'user' });
      expect(process.exitCode).toBe(1);
    } finally { process.stdout.write = original; console.error = oldError; process.exitCode = exit ?? 0; }
    expect(JSON.parse(output[0]!)).toMatchObject({ ok: false });
    expect(h.calls).toEqual([]);
    expect(existsSync(join(root, 'release', schedule.version, 'rehearsal'))).toBe(false);
  }
});

test('CLI apply reports unmeasured and no-checkout as failures without suppressing the stamped outcome', async () => {
  for (const missing of [false, true]) {
    const root = newRoot(), h = harness(at(420), rc({ introduced: null, ok: false }));
    setElanousConfigDir(root);
    const cli = new Command();
    registerReleaseCommands(cli, { ledgerRoot: root }, {}, {}, {}, h.deps);
    const output: string[] = [];
    const original = process.stdout.write, oldError = console.error, exit = process.exitCode;
    const env = process.env.ELANOUS_REHEARSAL_GIT_CWD;
    try {
      delete process.env.ELANOUS_REHEARSAL_GIT_CWD;
      process.exitCode = 0;
      process.stdout.write = ((chunk: string) => { output.push(String(chunk)); return true; }) as typeof process.stdout.write;
      console.error = () => {};
      await cli.parseAsync(['release', 'rehearsal', 'tick', '--apply', ...(missing ? [] : ['--checkout', '/fake/checkout']), '--json'], { from: 'user' });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = exit ?? 0;
      process.stdout.write = original;
      console.error = oldError;
      if (env === undefined) delete process.env.ELANOUS_REHEARSAL_GIT_CWD; else process.env.ELANOUS_REHEARSAL_GIT_CWD = env;
    }
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ ok: false, stamps: [{ outcome: missing ? 'no-checkout' : 'unmeasured' }] });
    expect(h.calls).toHaveLength(missing ? 0 : 1);
    expect(h.notifications).toHaveLength(1);
  }
});

test('CLI exposes failed notification in JSON and retries delivery without rerunning RC', async () => {
  const root = newRoot(), h = harness(at(420));
  h.deps.notify = () => false;
  setElanousConfigDir(root);
  const cli = new Command();
  registerReleaseCommands(cli, { ledgerRoot: root }, {}, {}, {}, h.deps);
  const output: string[] = [];
  const original = process.stdout.write, oldError = console.error, exit = process.exitCode;
  try {
    process.stdout.write = ((chunk: string) => { output.push(String(chunk)); return true; }) as typeof process.stdout.write;
    console.error = () => {};
    process.exitCode = 0;
    await cli.parseAsync(['release', 'rehearsal', 'tick', '--apply', '--checkout', '/fake/checkout', '--json'], { from: 'user' });
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ ok: false, notificationFailures: 1, stamps: [{ outcome: 'ok' }] });
    h.deps.notify = (text) => { h.notifications.push(text); return true; };
    process.exitCode = 0;
    await cli.parseAsync(['release', 'rehearsal', 'tick', '--apply', '--checkout', '/fake/checkout', '--json'], { from: 'user' });
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(output[1]!)).toMatchObject({ ok: true, notificationFailures: 0 });
  } finally { process.exitCode = exit ?? 0; process.stdout.write = original; console.error = oldError; }
  expect(h.calls).toEqual([schedule.version]);
  expect(h.notifications).toHaveLength(1);
});

test('CLI apply marks a failed RC gate as failed JSON, not a successful rehearsal', async () => {
  const root = newRoot(), h = harness(at(420), rc({ introduced: 0, unclassified: 0, gateExitCode: 1, ok: false }));
  setElanousConfigDir(root);
  const cli = new Command();
  registerReleaseCommands(cli, { ledgerRoot: root }, {}, {}, {}, h.deps);
  const output: string[] = [];
  const original = process.stdout.write, oldError = console.error, exit = process.exitCode;
  try {
    process.exitCode = 0;
    process.stdout.write = ((chunk: string) => { output.push(String(chunk)); return true; }) as typeof process.stdout.write;
    console.error = () => {};
    await cli.parseAsync(['release', 'rehearsal', 'tick', '--apply', '--checkout', '/fake/checkout', '--json'], { from: 'user' });
    expect(process.exitCode).toBe(1);
  } finally { process.exitCode = exit ?? 0; process.stdout.write = original; console.error = oldError; }
  expect(output).toHaveLength(1);
  expect(JSON.parse(output[0]!)).toMatchObject({ ok: false, stamps: [{ outcome: 'error', result: { ok: false, gateExitCode: 1 } }] });
  expect(h.notifications).toHaveLength(1);
  expect(h.notifications[0]).toStartWith('⛔ 리허설');
});

test('graph tick routes a successful JSON recipe outcome to done and errors to failed', async () => {
  const root = newRoot();
  const graph = join(import.meta.dir, '..', '..', 'graphs', 'release-rehearsal', 'release-rehearsal.yaml');
  const recipe = parseYaml(readFileSync(join(import.meta.dir, '..', '..', 'graphs', 'release-rehearsal', 'recipes.yaml'), 'utf8')) as { tick: { command: string; timeout_ms: number } };
  expect(recipe.tick.timeout_ms).toBe(18_000_000);
  expect(recipe.tick.command).toContain('ELANOUS_REHEARSAL_GIT_CWD');
  expect(recipe.tick.command).toContain('"--apply", "--json"');
  for (const [exitCode, expected] of [[0, 'done'], [1, 'failed']] as const) {
    const result = await runGraph(graph, { deps: { root, runBash: async (command) => {
      expect(command).toBe(recipe.tick.command);
      return { stdout: exitCode ? '' : '{"outcome":"ok"}', stderr: exitCode ? 'simulated error' : '', exitCode };
    } } });
    expect(result.status).toBe(expected);
  }
});

test('recipe actually launches in configured checkout and passes the CLI JSON into the graph', () => {
  const root = newRoot(), bin = join(root, 'bin'), checkout = join(root, 'checkout');
  mkdirSync(bin);
  mkdirSync(checkout);
  const seen = join(root, 'invoked');
  writeFileSync(join(bin, 'bun'), `#!/bin/sh\nif [ "$1" = "-e" ]; then exec "${Bun.which('bun')}" "$@"; fi\npwd > "${seen}"\nprintf '{"ok":true,"status":"no-schedule"}\\n'\n`);
  chmodSync(join(bin, 'bun'), 0o755);
  const recipe = parseYaml(readFileSync(join(import.meta.dir, '..', '..', 'graphs', 'release-rehearsal', 'recipes.yaml'), 'utf8')) as { tick: { command: string } };
  const result = spawnSync('/bin/bash', ['-c', recipe.tick.command], { cwd: import.meta.dir,
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ELANOUS_GRAPH_DIR: join(import.meta.dir, '..', '..', 'graphs', 'release-rehearsal'), ELANOUS_REHEARSAL_GIT_CWD: checkout } });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'ok', tick: { ok: true, status: 'no-schedule' } });
  expect(realpathSync(readFileSync(seen, 'utf8').trim())).toBe(realpathSync(checkout));
});
