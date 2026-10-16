// GATE-TIMEOUT-HEAL ⊕ GATE-INSTALL-CACHE (0.2.20) — a shard cut by its deadline keeps the results of the parts that
// finished, says «timeout», and only the rest runs again; per-shard deadlines follow the plan; installs share node slots.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createGateRunner, gateBatchTestWallSeconds, gateShardShell, POD_SHARD_FILE_CAP, POD_SHARD_TIMEOUT_CAP_SECONDS, readGatePodLifecycle, readIsolatedRun, readShardArtifacts, shardDeadlineSeconds, shardParts,
  softDeadlineSeconds, type GateRunner,
} from './gate-node';
import { installSlotScript } from '../../src/task-orchestrator/surfaces/pod-install-slots.js';
import { PodPoolScheduler } from '../../src/task-orchestrator/surfaces/pod-pool.js';
import type { RunPodCommandOptions } from '../../src/task-orchestrator/surfaces/pod-command-job.js';
import { readGateShards } from '../../src/release-loop/gate-shards.js';
import { readFileDurations } from './shard-plan';
import { debug } from '../../src/debug/log.js';

const CUT = 'a'.repeat(40);
const dirs: string[] = [];
const temp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const junitFor = (files: readonly string[], failing: ReadonlySet<string> = new Set()) => `<?xml version="1.0"?>\n<testsuites>\n${files.map((file) =>
  `<testsuite name="${file}" file="${file}"><testcase name="works" file="${file}">${failing.has(file) ? '<failure message="x"/>' : ''}</testcase></testsuite>`).join('\n')}\n</testsuites>\n`;
const summary = (files: readonly string[], failing: ReadonlySet<string> = new Set()) => {
  const fails = files.filter((file) => failing.has(file));
  return `${fails.map((file) => `${file}:\n(fail) works [1.00ms]`).join('\n')}\n${files.length - fails.length} pass\n${fails.length} fail\nRan ${files.length} tests across ${files.length} files.\n`;
};

test('① per-shard deadline = planned × 1.5 with the configured floor (default 1200 s) and an upper cap', () => {
  expect(shardDeadlineSeconds(18.9 * 60)).toBe(1701); // 0.2.19's largest shard: 18.9 min planned → 28.4 min
  expect(shardDeadlineSeconds(300)).toBe(1200);
  expect(shardDeadlineSeconds(0)).toBe(1200);
  expect(shardDeadlineSeconds(Number.NaN)).toBe(1200);
  expect(shardDeadlineSeconds(300, 17)).toBe(450);
  expect(shardDeadlineSeconds(5, 17)).toBe(17);
  expect(shardDeadlineSeconds(10 * 3600)).toBe(POD_SHARD_TIMEOUT_CAP_SECONDS);
  expect(shardDeadlineSeconds(10 * 3600, 5000)).toBe(5000); // a configured floor above the cap still wins
  expect(softDeadlineSeconds(1701)).toBe(1581);
  expect(softDeadlineSeconds(100)).toBe(80);
});

test('② parts follow the plan and the file cap, in order', () => {
  const files = Array.from({ length: 60 }, (_, i) => `src/f-${i}.test.ts`);
  const parts = shardParts(files, () => 1);
  expect(parts.map((part) => part.length)).toEqual([POD_SHARD_FILE_CAP, POD_SHARD_FILE_CAP, 6]);
  expect(parts.flat()).toEqual(files);
  expect(shardParts(['a', 'b', 'c', 'd'], (file) => file === 'b' ? 200 : 10).map((part) => part.length)).toEqual([2, 2]);
});

test('batch test wall counts overlapping test intervals once and leaves setup gaps as overhead', () => {
  expect(gateBatchTestWallSeconds({ 'part-0-test-start': 10, 'part-0-test-end': 14,
    'part-1-test-start': 12, 'part-1-test-end': 16, 'part-2-test-start': 20, 'part-2-test-end': 22 }, 3)).toBe(8);
  expect(gateBatchTestWallSeconds({ 'part-0-test-start': 10 }, 1)).toBeUndefined();
});

test('Pod lifecycle reader keeps schedule, init and child timestamps without trusting malformed status', () => {
  const time = '2026-10-15T00:00:00Z';
  const pod = { items: [{ metadata: { creationTimestamp: time }, status: {
    conditions: [{ type: 'PodScheduled', lastTransitionTime: time }],
    initContainerStatuses: [{ name: 'isolation-gate', state: { terminated: { startedAt: time, finishedAt: time } } }],
    containerStatuses: [{ name: 'child', state: { terminated: { startedAt: time, finishedAt: time } } }],
  } }] };
  expect(readGatePodLifecycle(JSON.stringify(pod))).toEqual({ podCreated: time, podScheduled: time,
    'init-isolation-gate-start': time, 'init-isolation-gate-end': time, childStart: time, childEnd: time });
  expect(readGatePodLifecycle('{bad')).toEqual({});
});

/** A fake `bun` (install · test:deterministic) and `timeout` for running the real Pod shell on this machine. */
function fakeTools(bin: string) {
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'bun'), `#!/bin/bash
if [ "$1" = install ]; then echo "5 packages installed [750ms]"; exit 0; fi
shift 2 # run test:deterministic
if [ -n "$FAKE_PARALLEL_TRACE" ]; then
  echo "start $BASHPID" >> "$FAKE_PARALLEL_TRACE"
  trap 'echo "end $BASHPID" >> "$FAKE_PARALLEL_TRACE"' EXIT
fi
files=(); out=
for a in "$@"; do case "$a" in --reporter-outfile=*) out="\${a#--reporter-outfile=}";; --*) ;; *) files+=("\${a#./}");; esac; done
for f in "\${files[@]}"; do case "$f" in *slow*) sleep 30;; esac; done
[ -n "$FAKE_TEST_SLEEP" ] && sleep "$FAKE_TEST_SLEEP"
echo "TEST_HOME=$HOME"
echo "TEST_CWD=$PWD"
echo "TEST_STATE=$ELANOUS_STATE_DIR"
echo "TEST_TMP=$TMPDIR"
echo "TEST_XDG_CONFIG=$XDG_CONFIG_HOME"
echo "TEST_XDG_CACHE=$XDG_CACHE_HOME"
echo "TEST_XDG_DATA=$XDG_DATA_HOME"
echo "TEST_XDG_STATE=$XDG_STATE_HOME"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git config --local gate.batch-part "\${files[0]}"
  echo "TEST_GIT_LOCAL=$(git config --local gate.batch-part)"
fi
if [ -d "$ELANOUS_STATE_DIR" ] && [ -d "$TMPDIR" ] && [ -d "$XDG_CONFIG_HOME" ] && [ -d "$XDG_CACHE_HOME" ] && [ -d "$XDG_DATA_HOME" ] && [ -d "$XDG_STATE_HOME" ]; then echo 'TEST_DIRS_READY=yes'; else echo 'TEST_DIRS_READY=no'; fi
failed=0
for f in "\${files[@]}"; do if [ "$f" = "$FAKE_FAIL_FILE" ]; then failed=1; echo "$f:"; echo '(fail) works [1.00ms]'; fi; done
{ echo '<testsuites>'; for f in "\${files[@]}"; do echo "<testsuite name=\\"$f\\" file=\\"$f\\"><testcase name=\\"works\\" file=\\"$f\\"></testcase></testsuite>"; done; echo '</testsuites>'; } > "$out"
echo "$(( \${#files[@]} - failed )) pass"; echo "$failed fail"; echo "Ran \${#files[@]} tests across \${#files[@]} files."
exit "$failed"
`);
  // GNU timeout's contract the shell relies on: TERM after N s, exit 124 when it fired.
  writeFileSync(join(bin, 'timeout'), `#!/bin/bash
[ "$1" = -k ] && shift 2
limit=$1; shift
"$@" & pid=$!
( sleep "$limit"; kill -TERM $pid 2>/dev/null; touch "$TMPDIR_FIRED/fired.$pid" ) & watcher=$!
wait $pid; rc=$?
kill $watcher 2>/dev/null
[ -e "$TMPDIR_FIRED/fired.$pid" ] && exit 124
exit $rc
`);
  chmodSync(join(bin, 'bun'), 0o755);
  chmodSync(join(bin, 'timeout'), 0o755);
}

test('reproduction: the real Pod shell cut by its soft deadline leaves the finished part (log ⊕ junit) and marks the timeout', () => {
  const root = temp('gate-cut-');
  const home = join(root, 'home');
  const repo = join(root, 'work', 'repo');
  mkdirSync(join(repo, 'apps/pwa'), { recursive: true });
  mkdirSync(home);
  fakeTools(join(root, 'bin'));
  const parts = [['src/a.test.ts', 'src/b.test.ts'], ['src/slow.test.ts', 'src/c.test.ts']];
  // Locally /proc/1 is the long-lived host, unlike the freshly started Pod whose age the shell subtracts.
  const shell = gateShardShell({ parts, cdpPatterns: [], softSeconds: 3, cachePrefix: '', installSlots: 0 })
    .replace(/^pod_age=\$\(awk.*$/m, 'pod_age=0');
  const started = Date.now();
  const run = spawnSync('bash', ['-c', shell], { cwd: repo, encoding: 'utf8', timeout: 25_000,
    env: { PATH: `${join(root, 'bin')}:/usr/bin:/bin`, HOME: home, TMPDIR_FIRED: root } });
  expect(run.status).toBe(0);
  expect(Date.now() - started).toBeLessThan(20_000);
  const outbox = join(home, 'outbox');
  expect(readFileSync(join(outbox, 'install.rc'), 'utf8').trim()).toBe('0');
  expect(readFileSync(join(outbox, 'part-0.rc'), 'utf8').trim()).toBe('0');
  expect(existsSync(join(outbox, 'part-1.rc'))).toBe(false);
  expect(readFileSync(join(outbox, 'shard.timeout'), 'utf8').trim()).toBe('1');
  const read = readShardArtifacts(outbox, parts);
  expect(read.timedOut).toBe(true);
  expect(read.rc).toBeUndefined();
  expect(read.finished).toEqual(['src/a.test.ts', 'src/b.test.ts']);
  expect(read.junit).toContain('file="src/b.test.ts"');
  expect(read.junit).not.toContain('src/c.test.ts');
  expect(read.output).toContain('5 packages installed [750ms]');
  expect(read.output).toContain('Ran 2 tests across 2 files.');
}, 30_000);

test('spawn lane uses a per-test 120s limit and marks a capped child as unmeasured before the shard deadline', () => {
  const base = { cdpPatterns: [], softSeconds: 10, cachePrefix: '', installSlots: 0 };
  const regular = gateShardShell({ ...base, parts: [['src/ordinary.test.ts']] });
  expect(regular).not.toContain('--timeout=120000');
  expect(regular).not.toContain('spawn_part');
  expect(() => gateShardShell({ ...base, parts: [['src/ordinary.test.ts', 'test/preview-terminal.test.ts']] }))
    .toThrow('gate spawn lane part mixed with regular tests');
  const parts = [['test/preview-terminal.test.ts']];
  const production = gateShardShell({ ...base, parts });
  expect(production).toContain("'--timeout=120000'");
  expect(production).toContain('if [ "$spawn_part" -eq 1 ] && [ "$left" -gt 120 ]; then left=120; fi');

  const root = temp('gate-spawn-cap-');
  const home = join(root, 'home');
  const repo = join(root, 'work', 'repo');
  mkdirSync(join(repo, 'apps/pwa'), { recursive: true });
  mkdirSync(home);
  fakeTools(join(root, 'bin'));
  // Exercise the production shell path at a two-second test scale, while its shard deadline stays ten seconds.
  const shell = production.replace(/^pod_age=\$\(awk.*$/m, 'pod_age=0')
    .replace('if [ "$spawn_part" -eq 1 ] && [ "$left" -gt 120 ]; then left=120; fi',
      'if [ "$spawn_part" -eq 1 ] && [ "$left" -gt 2 ]; then left=2; fi');
  const run = spawnSync('bash', ['-c', shell], { cwd: repo, encoding: 'utf8', timeout: 15_000,
    env: { PATH: `${join(root, 'bin')}:/usr/bin:/bin`, HOME: home, TMPDIR_FIRED: root, FAKE_TEST_SLEEP: '30' } });
  expect(run.status).toBe(0);
  const outbox = join(home, 'outbox');
  expect(readFileSync(join(outbox, 'shard.timeout'), 'utf8').trim()).toBe('0');
  expect(existsSync(join(outbox, 'part-0.rc'))).toBe(false);
  expect(readShardArtifacts(outbox, parts)).toMatchObject({ timedOut: true, finished: [] });
}, 20_000);

test('spawn child killed before its cap remains a measured failure', () => {
  const root = temp('gate-spawn-early-kill-');
  const home = join(root, 'home');
  const repo = join(root, 'work', 'repo');
  mkdirSync(join(repo, 'apps/pwa'), { recursive: true });
  mkdirSync(home);
  fakeTools(join(root, 'bin'));
  writeFileSync(join(root, 'bin', 'bun'), '#!/bin/bash\nif [ "$1" = install ]; then exit 0; fi\nexit 137\n');
  const shell = gateShardShell({ parts: [['test/preview-terminal.test.ts']], cdpPatterns: [],
    softSeconds: 10, cachePrefix: '', installSlots: 0 }).replace(/^pod_age=\$\(awk.*$/m, 'pod_age=0');
  const run = spawnSync('bash', ['-c', shell], { cwd: repo, encoding: 'utf8', timeout: 15_000,
    env: { PATH: `${join(root, 'bin')}:/usr/bin:/bin`, HOME: home, TMPDIR_FIRED: root } });
  expect(run.status).toBe(0);
  const outbox = join(home, 'outbox');
  expect(existsSync(join(outbox, 'shard.timeout'))).toBe(false);
  expect(readFileSync(join(outbox, 'part-0.rc'), 'utf8').trim()).toBe('137');
});

test('isolation batch runs four files in one shell with separate HOME and complete per-file artifacts', () => {
  const root = temp('gate-batch-');
  const home = join(root, 'home');
  const repo = join(root, 'work', 'repo');
  mkdirSync(join(repo, 'apps/pwa'), { recursive: true });
  mkdirSync(home);
  fakeTools(join(root, 'bin'));
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src/fixture.txt'), 'source');
  expect(spawnSync('git', ['-C', repo, 'init', '-q']).status).toBe(0);
  expect(spawnSync('git', ['-C', repo, 'add', 'src/fixture.txt']).status).toBe(0);
  expect(spawnSync('git', ['-C', repo, '-c', 'user.name=TC', '-c', 'user.email=tc@example.invalid', 'commit', '-qm', 'fixture']).status).toBe(0);
  const parts = ['a', 'b', 'c', 'd'].map((name) => [`src/${name}.test.ts`]);
  const shell = gateShardShell({ parts, cdpPatterns: [], softSeconds: 15, cachePrefix: '', installSlots: 0, parallelParts: 4 })
    .replace(/^pod_age=\$\(awk.*$/m, 'pod_age=0');
  const started = Date.now();
  const run = spawnSync('bash', ['-c', shell], { cwd: repo, encoding: 'utf8', timeout: 20_000,
    env: { PATH: `${join(root, 'bin')}:/usr/bin:/bin`, HOME: home, TMPDIR_FIRED: root, FAKE_TEST_SLEEP: '1' } });
  expect(run.status).toBe(0);
  expect(Date.now() - started).toBeLessThan(12_000);
  const outbox = join(home, 'outbox');
  const result = readShardArtifacts(outbox, parts);
  expect(result).toMatchObject({ rc: 0, timedOut: false, finished: parts.flat() });
  const stages = readFileSync(join(outbox, 'stages.tsv'), 'utf8');
  const testStarts = [...stages.matchAll(/^(\d+)\tpart-\d+-test-start$/gm)].map((match) => Number(match[1]));
  expect(testStarts).toHaveLength(4);
  expect(Math.max(...testStarts) - Math.min(...testStarts)).toBeLessThanOrEqual(3);
  for (let index = 0; index < parts.length; index++) {
    for (const phase of ['setup-start', 'setup-end', 'test-start', 'test-end', 'cleanup-start', 'cleanup-end'])
      expect(stages).toContain(`part-${index}-${phase}`);
  }
  const homes = parts.map((_, index) => readFileSync(join(outbox, `part-${index}.log`), 'utf8').match(/TEST_HOME=(.*)/)?.[1]);
  const worktrees = parts.map((_, index) => readFileSync(join(outbox, `part-${index}.log`), 'utf8').match(/TEST_CWD=(.*)/)?.[1]);
  expect(new Set(homes).size).toBe(4);
  expect(new Set(worktrees).size).toBe(4);
  expect(worktrees.every((value) => value?.includes('/tmp/gate-isolate.'))).toBe(true);
  expect(homes.every((value) => value?.startsWith('/tmp/gate-isolate.'))).toBe(true);
  for (const label of ['STATE', 'TMP', 'XDG_CONFIG', 'XDG_CACHE', 'XDG_DATA', 'XDG_STATE']) {
    const values = parts.map((_, index) => readFileSync(join(outbox, `part-${index}.log`), 'utf8').match(new RegExp(`TEST_${label}=(.*)`))?.[1]);
    expect(new Set(values).size).toBe(4);
    expect(values.every((value) => value?.startsWith('/tmp/gate-isolate.'))).toBe(true);
  }
  expect(parts.every((_, index) => readFileSync(join(outbox, `part-${index}.log`), 'utf8').includes('TEST_DIRS_READY=yes'))).toBe(true);
  for (let index = 0; index < parts.length; index++) {
    expect(readFileSync(join(outbox, `part-${index}.log`), 'utf8')).toContain(`TEST_GIT_LOCAL=${parts[index]![0]}`);
  }
  expect(spawnSync('git', ['-C', repo, 'config', '--local', '--get', 'gate.batch-part']).status).toBe(1);
  expect(gateShardShell({ parts, cdpPatterns: [], softSeconds: 15, cachePrefix: '', installSlots: 0, parallelParts: 1 }))
    .toContain('ELANOUS_STATE_DIR="$isolated/state"');
});

test('final recheck shell executes four file parts, reports each rc, and runs at most two tests together', () => {
  const root = temp('gate-recheck-shell-');
  const home = join(root, 'home');
  const repo = join(root, 'work', 'repo');
  const trace = join(root, 'parallel.trace');
  mkdirSync(join(repo, 'apps/pwa'), { recursive: true });
  mkdirSync(home);
  fakeTools(join(root, 'bin'));
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src/fixture.txt'), 'source');
  expect(spawnSync('git', ['-C', repo, 'init', '-q']).status).toBe(0);
  expect(spawnSync('git', ['-C', repo, 'add', 'src/fixture.txt']).status).toBe(0);
  expect(spawnSync('git', ['-C', repo, '-c', 'user.name=TC', '-c', 'user.email=tc@example.invalid', 'commit', '-qm', 'fixture']).status).toBe(0);
  const files = ['a', 'b', 'c', 'd'].map((name) => `src/${name}.test.ts`);
  const shell = gateShardShell({ parts: files.map((file) => [file]), cdpPatterns: [], softSeconds: 20,
    cachePrefix: '', installSlots: 0, parallelParts: 2, partLimitSeconds: 10 })
    .replace(/^pod_age=\$\(awk.*$/m, 'pod_age=0');
  const run = spawnSync('bash', ['-c', shell], { cwd: repo, encoding: 'utf8', timeout: 25_000,
    env: { PATH: `${join(root, 'bin')}:/usr/bin:/bin`, HOME: home, TMPDIR_FIRED: root,
      FAKE_PARALLEL_TRACE: trace, FAKE_FAIL_FILE: files[1]!, FAKE_TEST_SLEEP: '1' } });
  expect(run.status).toBe(0);
  const outbox = join(home, 'outbox');
  expect(readFileSync(join(outbox, 'install.rc'), 'utf8').trim()).toBe('0');
  for (const [index, file] of files.entries()) {
    const rc = Number(readFileSync(join(outbox, `part-${index}.rc`), 'utf8').trim());
    const output = readFileSync(join(outbox, `part-${index}.log`), 'utf8');
    expect(rc).toBe(index === 1 ? 1 : 0);
    const reading = readIsolatedRun({ rc, output }, 'final Pod recheck', file);
    expect(reading.kind).toBe('read');
    if (reading.kind === 'read') expect(reading.failures).toEqual(index === 1 ? [`${file} > works`] : []);
  }
  let active = 0;
  let peak = 0;
  for (const line of readFileSync(trace, 'utf8').trim().split('\n')) {
    active += line.startsWith('start ') ? 1 : -1;
    expect(active).toBeGreaterThanOrEqual(0);
    peak = Math.max(peak, active);
  }
  expect(active).toBe(0);
  expect(peak).toBe(2);
});

test('readShardArtifacts: every part done → one summary and rc; a crashed part → its exit; the old single-run layout still reads', () => {
  const dir = temp('gate-art-');
  const parts = [['src/a.test.ts'], ['src/b.test.ts', 'src/c.test.ts']];
  writeFileSync(join(dir, 'install.log'), '9 packages installed [1.20s]\n');
  writeFileSync(join(dir, 'install.rc'), '0\n');
  writeFileSync(join(dir, 'part-0.log'), summary(parts[0]!));
  writeFileSync(join(dir, 'part-0.rc'), '0\n');
  writeFileSync(join(dir, 'part-0.junit.xml'), junitFor(parts[0]!));
  writeFileSync(join(dir, 'part-1.log'), summary(parts[1]!, new Set(['src/c.test.ts'])));
  writeFileSync(join(dir, 'part-1.rc'), '1\n');
  writeFileSync(join(dir, 'part-1.junit.xml'), junitFor(parts[1]!, new Set(['src/c.test.ts'])));
  const all = readShardArtifacts(dir, parts);
  expect(all).toMatchObject({ rc: 1, timedOut: false, finished: ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts'] });
  expect(all.output!.match(/Ran \d+ tests? across/g)).toHaveLength(1);
  expect(all.output).toContain('2 pass\n1 fail\n0 errors\nRan 3 tests across 3 files.');
  writeFileSync(join(dir, 'part-1.rc'), '137\n');
  expect(readShardArtifacts(dir, parts)).toMatchObject({ rc: 137, timedOut: false, finished: ['src/a.test.ts'] });
  const legacy = temp('gate-legacy-');
  writeFileSync(join(legacy, 'shard.log'), summary(['src/a.test.ts']));
  writeFileSync(join(legacy, 'shard.rc'), '0\n');
  expect(readShardArtifacts(legacy, parts)).toMatchObject({ rc: 0, timedOut: false, output: summary(['src/a.test.ts']) });
});

function sweepRunner(files: string[], pod: (o: RunPodCommandOptions, parts: string[][]) => Promise<{ exitCode: number; artifactsDir: string; job: string }>, safeFiles: readonly string[] = files) {
  const root = temp('gate-sweep-');
  const repo = join(root, 'repo');
  mkdirSync(repo);
  mkdirSync(join(repo, 'release'));
  writeFileSync(join(repo, 'release/gate-batch-safe.json'), JSON.stringify({ env: 'linux-pod', tests: safeFiles.map((file) => ({ file, evidence: 'synthetic test fixture' })) }));
  const command: GateRunner['command'] = async (cmd, args) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
    return { rc: 0, output: '' };
  };
  const runner = createGateRunner(repo, undefined, command, async (o) => {
    const parts = [...o.command[2]!.matchAll(/run_part \d+ ([^&]*)/g)].map((m) => [...m[1]!.matchAll(/'\.\/([^']+)'/g)].map((f) => f[1]!));
    return pod(o, parts);
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 4, k3dCluster: 'test' }]), () => '');
  return { root, repo, runner };
}

test('unreadable optional stage timings do not change a completed shard verdict', async () => {
  const file = 'src/a.test.ts';
  const { root, repo, runner } = sweepRunner([file], async (o) => {
    const dir = join(root, o.name!);
    mkdirSync(dir);
    writeFileSync(join(dir, 'shard.log'), summary([file]));
    writeFileSync(join(dir, 'shard.rc'), '0\n');
    mkdirSync(join(dir, 'stages.tsv')); // readFileSync throws EISDIR on this optional measurement.
    return { exitCode: 0, artifactsDir: dir, job: 'fake' };
  }, []);
  const result = await runner.sweep(repo, undefined, { pool: 'pool-test', shards: 1, stallSeconds: 0 });
  expect(result.rc).toBe(0);
  expect(result.output).toContain('1 pass');
});

test('sweep generated batch Job shell overlaps safe file tests in the real shell', async () => {
  const files = Array.from({ length: 8 }, (_, i) => `src/f-${i}.test.ts`);
  const shells: string[] = [];
  const intervals: Array<Array<[number, number]>> = [];
  const { root, repo, runner } = sweepRunner(files, async (o, parts) => {
    const shell = o.command[2]!;
    const dir = join(root, o.name!);
    mkdirSync(dir);
    if (!shell.includes('gate-isolate.')) return { exitCode: 137, artifactsDir: dir, job: 'fake' };
    shells.push(shell);
    const home = join(root, `home-${shells.length}`);
    mkdirSync(home);
    const run = spawnSync('bash', ['-c', shell.replace(/^pod_age=\$\(awk.*$/m, 'pod_age=0')], {
      cwd: repo, encoding: 'utf8', timeout: 25_000,
      env: { PATH: `${join(root, 'bin')}:/usr/bin:/bin`, HOME: home, FAKE_TEST_SLEEP: '1' },
    });
    expect(run.status).toBe(0);
    const outbox = join(home, 'outbox');
    const stage = readFileSync(join(outbox, 'stages.tsv'), 'utf8');
    intervals.push(parts.map((_, i) => {
      const start = Number(new RegExp(`^(\\d+)\\tpart-${i}-test-start$`, 'm').exec(stage)?.[1]);
      const end = Number(new RegExp(`^(\\d+)\\tpart-${i}-test-end$`, 'm').exec(stage)?.[1]);
      expect(Number.isFinite(start) && Number.isFinite(end)).toBe(true);
      return [start, end];
    }));
    return { exitCode: 0, artifactsDir: outbox, job: 'fake' };
  });
  mkdirSync(join(repo, 'apps/pwa'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/fixture.txt'), 'source');
  fakeTools(join(root, 'bin'));
  expect(spawnSync('git', ['-C', repo, 'init', '-q']).status).toBe(0);
  expect(spawnSync('git', ['-C', repo, 'add', 'src/fixture.txt']).status).toBe(0);
  expect(spawnSync('git', ['-C', repo, '-c', 'user.name=TC', '-c', 'user.email=tc@example.invalid', 'commit', '-qm', 'fixture']).status).toBe(0);
  const result = await runner.sweep(repo, undefined, { pool: 'pool-test', shards: 1, stallSeconds: 0 });
  expect(result.rc).toBe(0);
  expect(shells.length).toBeGreaterThan(0);
  expect(shells.every((shell) => shell.includes('pids+=('))).toBe(true);
  expect(intervals.some((group) => group.length > 1 && group[0]![0] < group[1]![1] && group[1]![0] < group[0]![1])).toBe(true);
}, 30_000);

test('reproduction through the sweep: a cut shard is reason=timeout, keeps its finished files, re-runs only the rest, and shards.json says so', async () => {
  const files = Array.from({ length: 30 }, (_, i) => `src/f-${String(i).padStart(2, '0')}.test.ts`);
  const assigned: string[][] = [];
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'release-loop.gate') events.push({ event, data: data as Record<string, unknown> });
  });
  const { root, repo, runner } = sweepRunner(files, async (o, parts) => {
    assigned.push(parts.flat());
    const dir = join(root, o.name!);
    mkdirSync(dir);
    writeFileSync(join(dir, 'install.log'), '3 packages installed [2.50s]\n');
    writeFileSync(join(dir, 'install.rc'), '0\n');
    parts.forEach((part, index) => {
      if (assigned.length === 1 && index > 0) return; // first Pod: the deadline cut every part after the first
      writeFileSync(join(dir, `part-${index}.log`), summary(part));
      writeFileSync(join(dir, `part-${index}.rc`), '0\n');
      writeFileSync(join(dir, `part-${index}.junit.xml`), junitFor(part));
    });
    if (assigned.length === 1) writeFileSync(join(dir, 'shard.timeout'), '1\n');
    return { exitCode: 0, artifactsDir: dir, job: 'fake' };
  });
  const shardsPath = join(root, 'ledger', 'release', '9.9.9', 'gate-logs', 'cut', 'shards.json');
  try {
    const result = await runner.sweep(repo, join(root, 'logs'), { pool: 'pool-test', shards: 1, shardsFile: { path: shardsPath, version: '9.9.9' } });
    expect(result.rc).toBe(0);
    expect(result.output).toContain('Ran 30 tests across 30 files.');
  } finally { log.mockRestore(); }
  expect(assigned).toHaveLength(2);
  expect(assigned[0]).toEqual(files);
  expect(assigned[1]).toEqual(files.slice(POD_SHARD_FILE_CAP)); // only the unfinished part
  const first = events.find((item) => item.event === 'pod-shard')!;
  expect(first.data).toMatchObject({ reason: 'timeout', rc: null, finishedFiles: POD_SHARD_FILE_CAP, installSeconds: 2.5 });
  expect(events.some((item) => item.event === 'retry-narrowed' && item.data.after === 3)).toBe(true);
  const meta = JSON.parse(readFileSync(join(root, 'logs', 'pod-0.json'), 'utf8'));
  expect(meta).toMatchObject({ reason: 'timeout', rc: null, finishedFiles: POD_SHARD_FILE_CAP, deadlineSeconds: 1200 });
  const board = readGateShards(shardsPath);
  expect(board).toMatchObject({ version: '9.9.9', shards: [{ id: 'pod-0', state: 'done', installSec: 2.5, rc: 0 }] });
  expect(typeof board!.shards[0]!.endedAt).toBe('string');
});

test('pod shard records outer JUnit file seconds, total test seconds, nonnegative overhead, and logs the test seconds', async () => {
  const files = ['src/a.test.ts', 'src/b.test.ts'];
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'release-loop.gate') events.push({ event, data: data as Record<string, unknown> });
  });
  const { root, repo, runner } = sweepRunner(files, async (o, parts) => {
    const dir = join(root, o.name!);
    mkdirSync(dir);
    writeFileSync(join(dir, 'install.rc'), '0\n');
    writeFileSync(join(dir, 'part-0.log'), summary(parts[0]!));
    writeFileSync(join(dir, 'part-0.rc'), '0\n');
    writeFileSync(join(dir, 'part-0.junit.xml'), '<testsuites><testsuite file="src/a.test.ts" time="2"><testsuite file="src/nested.test.ts" time="90"/></testsuite><testsuite file="src/b.test.ts" time="3"/></testsuites>');
    writeFileSync(join(dir, 'stages.tsv'), '100\tshell-start\n101\tdeps-start\n102\tdeps-end\n103\ttest-start\n105\ttest-end\n106\tshell-end\n');
    return { exitCode: 0, artifactsDir: dir, job: 'fake' };
  });
  try {
    const result = await runner.sweep(repo, join(root, 'logs'), { pool: 'pool-test', shards: 1 });
    expect(result.rc).toBe(0);
  } finally { log.mockRestore(); }
  const meta = JSON.parse(readFileSync(join(root, 'logs', 'pod-0.json'), 'utf8'));
  expect(meta.fileSeconds).toEqual({ 'src/a.test.ts': 2, 'src/b.test.ts': 3 });
  expect(meta.testSeconds).toBe(5);
  expect(meta.testWallSeconds).toBe(2);
  expect(meta.podOverheadSeconds).toBe(Math.max(0, meta.durationMs / 1000 - 2));
  expect(meta.podStages).toMatchObject({ 'deps-start': 101, 'deps-end': 102, 'test-start': 103, 'test-end': 105 });
  expect(meta.phaseTimes).toHaveProperty('admissionStart');
  expect(meta.phaseTimes).toHaveProperty('jobReturned');
  expect(events.find(({ event }) => event === 'pod-shard')?.data.testSeconds).toBe(5);
  expect([...readFileDurations(join(root, 'logs'))]).toEqual([['src/a.test.ts', 2], ['src/b.test.ts', 3]]);
});

test('a cut shard whose finished files have a failure keeps that failure for the verdict and retries it with the unfinished files', async () => {
  const files = Array.from({ length: 30 }, (_, i) => `src/f-${String(i).padStart(2, '0')}.test.ts`);
  const failing = new Set([files[3]!]);
  const assigned: string[][] = [];
  const { root, repo, runner } = sweepRunner(files, async (o, parts) => {
    assigned.push(parts.flat());
    const dir = join(root, o.name!);
    mkdirSync(dir);
    writeFileSync(join(dir, 'install.rc'), '0\n');
    parts.forEach((part, index) => {
      if (assigned.length === 1 && index > 0) return;
      const rc = part.some((file) => failing.has(file)) ? 1 : 0;
      writeFileSync(join(dir, `part-${index}.log`), summary(part, failing));
      writeFileSync(join(dir, `part-${index}.rc`), `${rc}\n`);
      writeFileSync(join(dir, `part-${index}.junit.xml`), junitFor(part, failing));
    });
    if (assigned.length === 1) writeFileSync(join(dir, 'shard.timeout'), '1\n');
    return { exitCode: 0, artifactsDir: dir, job: 'fake' };
  });
  const result = await runner.sweep(repo, undefined, { pool: 'pool-test', shards: 1 });
  expect(assigned[1]).toEqual([files[3]!, ...files.slice(POD_SHARD_FILE_CAP)]);
  expect(result.rc).toBe(1);
  expect(result.output).toContain(`${files[3]}:\n(fail) works`);
  expect(result.output).toContain('29 pass\n1 fail\n0 errors\nRan 30 tests across 30 files.');
});

for (const withRunningOutput of [true, false]) {
  test(`GATE-UNFINISHED-HINT: a cut shard ${withRunningOutput ? 'points pod-N.log at pod-N.unfinished.log and records its bytes' : 'with no running-part output adds no hint line and no json field'}`, async () => {
    const files = Array.from({ length: 30 }, (_, i) => `src/f-${String(i).padStart(2, '0')}.test.ts`);
    let pods = 0;
    const { root, repo, runner } = sweepRunner(files, async (o, parts) => {
      pods += 1;
      const dir = join(root, o.name!);
      mkdirSync(dir);
      writeFileSync(join(dir, 'install.log'), '3 packages installed [2.50s]\n');
      writeFileSync(join(dir, 'install.rc'), '0\n');
      parts.forEach((part, index) => {
        if (pods === 1 && index > 0) {
          // The deadline cut this part mid-run: output, no rc.
          if (withRunningOutput) writeFileSync(join(dir, `part-${index}.log`), `${part[0]}:\n(pass) works [1.00ms]\n`);
          return;
        }
        writeFileSync(join(dir, `part-${index}.log`), summary(part));
        writeFileSync(join(dir, `part-${index}.rc`), '0\n');
        writeFileSync(join(dir, `part-${index}.junit.xml`), junitFor(part));
      });
      if (pods === 1) writeFileSync(join(dir, 'shard.timeout'), '1\n');
      return { exitCode: 0, artifactsDir: dir, job: 'fake' };
    });
    const logs = join(root, 'logs');
    const result = await runner.sweep(repo, logs, { pool: 'pool-test', shards: 1 });
    // The verdict is untouched either way.
    expect(result.rc).toBe(0);
    expect(result.output).toContain('Ran 30 tests across 30 files.');
    expect(result.output).not.toContain('[gate] unfinished:');
    const log = readFileSync(join(logs, 'pod-0.log'), 'utf8');
    const meta = JSON.parse(readFileSync(join(logs, 'pod-0.json'), 'utf8'));
    expect(meta).toMatchObject({ reason: 'timeout', rc: null });
    const unfinishedPath = join(logs, 'pod-0.unfinished.log');
    if (withRunningOutput) {
      const bytes = readFileSync(unfinishedPath).byteLength;
      expect(bytes).toBeGreaterThan(0);
      expect(meta.unfinishedLogBytes).toBe(bytes);
      expect(log.trimEnd().split('\n').at(-1)).toBe(`[gate] unfinished: pod-0.unfinished.log · ${bytes}B (진행 중 part 출력은 그 파일)`);
      // The existing lines stay as they were: the finished part's output comes first, unchanged.
      expect(log).toContain('3 packages installed [2.50s]');
      expect(log).toContain(`Ran ${POD_SHARD_FILE_CAP} tests across ${POD_SHARD_FILE_CAP} files.`);
    } else {
      expect(existsSync(unfinishedPath)).toBe(false);
      expect(meta).not.toHaveProperty('unfinishedLogBytes');
      expect(log).not.toContain('[gate] unfinished:');
    }
    // Shards that finished whole never carry the hint.
    for (const name of readdirSync(logs).filter((file) => file.endsWith('.log') && file !== 'pod-0.log' && !file.endsWith('.unfinished.log'))) {
      expect(readFileSync(join(logs, name), 'utf8')).not.toContain('[gate] unfinished:');
    }
  });
}

test('depth-two isolation keeps unlisted files in their own Pod and batches opt-in files', async () => {
  const files = Array.from({ length: 8 }, (_, i) => `src/f-${i}.test.ts`);
  files[1] = 'src/unlisted.test.ts';
  const jobs: Array<{ files: string[]; batch: boolean }> = [];
  const { root, repo, runner } = sweepRunner(files, async (o, parts) => {
    const batch = o.command[2]!.includes('gate-isolate.');
    jobs.push({ files: parts.flat(), batch });
    const dir = join(root, o.name!);
    mkdirSync(dir);
    if (batch || parts.flat().length === 1) {
      writeFileSync(join(dir, 'install.rc'), '0\n');
      parts.forEach((part, index) => {
        writeFileSync(join(dir, `part-${index}.log`), summary(part));
        writeFileSync(join(dir, `part-${index}.rc`), '0\n');
        writeFileSync(join(dir, `part-${index}.junit.xml`), junitFor(part));
      });
    }
    return { exitCode: 0, artifactsDir: dir, job: 'fake' };
  }, files.filter((file) => file !== files[1]));
  const result = await runner.sweep(repo, undefined, { pool: 'pool-test', shards: 1, stallSeconds: 0 });
  expect(result.rc).toBe(0);
  expect(result.output).toContain('Ran 8 tests across 8 files.');
  expect(jobs.some((job) => job.batch && job.files.length >= 2 && job.files.every((file) => file !== files[1]))).toBe(true);
  expect(jobs.filter((job) => job.batch).every((job) => !job.files.includes(files[1]!))).toBe(true);
  expect(jobs.some((job) => !job.batch && job.files.length === 1 && job.files[0] === files[1])).toBe(true);
  expect(jobs.filter((job) => job.batch || job.files.length === 1).flatMap((job) => job.files).sort()).toEqual([...files].sort());
});

test('a batch missing one JUnit reruns only that file and preserves a completed failure', async () => {
  const files = Array.from({ length: 8 }, (_, i) => `src/f-${i}.test.ts`);
  const failing = new Set([files[1]!]);
  const jobs: Array<{ files: string[]; batch: boolean }> = [];
  let missingBatch = false;
  const { root, repo, runner } = sweepRunner(files, async (o, parts) => {
    const batch = o.command[2]!.includes('gate-isolate.');
    jobs.push({ files: parts.flat(), batch });
    const dir = join(root, o.name!);
    mkdirSync(dir);
    if (batch || parts.flat().length === 1) {
      writeFileSync(join(dir, 'install.rc'), '0\n');
      parts.forEach((part, index) => {
        writeFileSync(join(dir, `part-${index}.log`), summary(part, failing));
        writeFileSync(join(dir, `part-${index}.rc`), `${part.some((file) => failing.has(file)) ? 1 : 0}\n`);
        if (!(batch && !missingBatch && index === 0)) writeFileSync(join(dir, `part-${index}.junit.xml`), junitFor(part, failing));
      });
      if (batch && !missingBatch) missingBatch = true;
    }
    return { exitCode: 0, artifactsDir: dir, job: 'fake' };
  });
  const result = await runner.sweep(repo, undefined, { pool: 'pool-test', shards: 1, stallSeconds: 0 });
  expect(result.rc).toBe(1);
  expect(result.output).toContain('Ran 8 tests across 8 files.');
  expect(result.output).toContain(`${files[1]}:\n(fail) works`);
  // retryFiles keeps the complete part's JUnit verdict and narrows to only the part missing its JUnit.
  expect(jobs.filter((job) => !job.batch && job.files.length === 1)).toEqual([{ files: [files[0]!], batch: false }]);
});

test('④ an isolated Pod that dies before its tests (exit 5 · no outbox) gets one more run instead of stalling the sweep', async () => {
  const files = ['src/only.test.ts'];
  let runs = 0;
  const { root, repo, runner } = sweepRunner(files, async (o, parts) => {
    runs++;
    const dir = join(root, o.name!);
    mkdirSync(dir);
    if (runs === 1) return { exitCode: 5, artifactsDir: dir, job: 'fake' };
    writeFileSync(join(dir, 'install.rc'), '0\n');
    writeFileSync(join(dir, 'part-0.log'), summary(parts[0]!));
    writeFileSync(join(dir, 'part-0.rc'), '0\n');
    return { exitCode: 0, artifactsDir: dir, job: 'fake' };
  });
  const result = await runner.sweep(repo, undefined, { pool: 'pool-test', shards: 1 });
  expect(runs).toBe(2);
  expect(result.rc).toBe(0);
  expect(result.output).toContain('Ran 1 test');
});

test('pod shard without JUnit leaves timing fields unmeasured', async () => {
  const files = ['src/only.test.ts'];
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'release-loop.gate') events.push({ event, data: data as Record<string, unknown> });
  });
  const { root, repo, runner } = sweepRunner(files, async (o, parts) => {
    const dir = join(root, o.name!);
    mkdirSync(dir);
    writeFileSync(join(dir, 'install.rc'), '0\n');
    writeFileSync(join(dir, 'part-0.log'), summary(parts[0]!));
    writeFileSync(join(dir, 'part-0.rc'), '0\n');
    return { exitCode: 0, artifactsDir: dir, job: 'fake' };
  });
  try {
    expect((await runner.sweep(repo, join(root, 'logs'), { pool: 'pool-test', shards: 1 })).rc).toBe(0);
  } finally { log.mockRestore(); }
  const meta = JSON.parse(readFileSync(join(root, 'logs', 'pod-0.json'), 'utf8'));
  expect(meta).not.toHaveProperty('fileSeconds');
  expect(meta).not.toHaveProperty('testSeconds');
  expect(meta).not.toHaveProperty('podOverheadSeconds');
  expect(events.find(({ event }) => event === 'pod-shard')?.data).not.toHaveProperty('testSeconds');
});

test('per-shard deadlines and install slots reach the Pod; 0 slots turns the throttle off', async () => {
  const files = ['src/a.test.ts'];
  const seen: RunPodCommandOptions[] = [];
  const { root, repo, runner } = sweepRunner(files, async (o, parts) => {
    seen.push(o);
    const dir = join(root, o.name!);
    mkdirSync(dir);
    writeFileSync(join(dir, 'install.rc'), '0\n');
    writeFileSync(join(dir, 'part-0.log'), summary(parts[0]!));
    writeFileSync(join(dir, 'part-0.rc'), '0\n');
    return { exitCode: 0, artifactsDir: dir, job: 'fake' };
  });
  await runner.sweep(repo, undefined, { pool: 'pool-test', shards: 1 });
  await runner.sweep(repo, undefined, { pool: 'pool-test', shards: 1, installSlots: 0 });
  expect(seen[0]!.installSlots).toBe('/var/lib/elanous/gate-install-slots');
  expect(seen[0]!.command[2]).toContain('install_slot_acquire >> "$O/install.log"');
  expect(seen[0]!.deadlineSeconds).toBe(1200);
  expect(seen[1]!.installSlots).toBeUndefined();
  expect(seen[1]!.command[2]).not.toContain('install_slot_acquire');
});

/** Runs `holders` shells at once over one token directory; each records how many holders it saw inside. */
async function contend(dir: string, holders: number, slots: number) {
  const active = join(dir, '..', 'active');
  mkdirSync(active, { recursive: true });
  const seenPath = join(dir, '..', 'seen');
  const body = `${installSlotScript({ dir, slots, waitSeconds: 60, pollSeconds: 0.1 })}
install_slot_acquire >/dev/null
touch '${active}'/$$
ls '${active}' | wc -l >> '${seenPath}'
sleep 0.4
rm -f '${active}'/$$
install_slot_release`;
  await Promise.all(Array.from({ length: holders }, () => new Promise<number | null>((resolve) => {
    const child = spawn('bash', ['-c', body], { stdio: 'ignore' });
    child.on('close', resolve);
  })));
  return readFileSync(seenPath, 'utf8').trim().split('\n').map((line) => Number(line.trim()));
}

test('GATE-INSTALL-CACHE: several shards on one hostPath never exceed the slots, all finish, and leave no token', async () => {
  const dir = join(temp('gate-slots-'), 'slots');
  mkdirSync(dir);
  const seen = await contend(dir, 8, 2);
  expect(seen).toHaveLength(8);
  expect(Math.max(...seen)).toBeLessThanOrEqual(2);
  expect(Math.max(...seen)).toBe(2); // the throttle still lets two run together
  expect(readdirSync(dir)).toEqual([]);
}, 30_000);

test('install slots: a stale token is reclaimed, a held one is waited for at most the cap, and an unwritable directory never blocks', () => {
  const root = temp('gate-slots-stale-');
  const dir = join(root, 'slots');
  mkdirSync(join(dir, 'slot-0'), { recursive: true });
  const old = new Date(Date.now() - 3600_000);
  utimesSync(join(dir, 'slot-0'), old, old);
  const run = (script: string) => spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 20_000 });
  const reclaimed = run(`${installSlotScript({ dir, slots: 1, waitSeconds: 10, staleSeconds: 60 })}\ninstall_slot_acquire; echo "held=$install_slot"`);
  expect(reclaimed.stdout).toContain('[gate] install-slot 0 waited');
  expect(reclaimed.stdout).toContain(`held=${dir}/slot-0`);
  // slot-0 is now fresh (held by the run above, which never released it): a second waiter gives up after the cap.
  const capped = run(`${installSlotScript({ dir, slots: 1, waitSeconds: 1, staleSeconds: 900 })}\ninstall_slot_acquire; echo "rc=$? held=$install_slot"`);
  expect(capped.stdout).toContain('[gate] install-slot none (waited');
  expect(capped.stdout).toContain('rc=0 held=');
  const missing = run(`${installSlotScript({ dir: join(root, 'absent'), slots: 2 })}\ninstall_slot_acquire; echo "rc=$?"`);
  expect(missing.stdout).toContain('[gate] install-slot none (directory not writable)');
  expect(missing.stdout).toContain('rc=0');
}, 30_000);
