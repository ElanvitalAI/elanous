// GATE-TIMEOUT-HEAL ⊕ GATE-INSTALL-CACHE (0.2.20) — a shard cut by its deadline keeps the results of the parts that
// finished, says «timeout», and only the rest runs again; per-shard deadlines follow the plan; installs share node slots.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createGateRunner, gateShardShell, POD_SHARD_FILE_CAP, POD_SHARD_TIMEOUT_CAP_SECONDS, readShardArtifacts, shardDeadlineSeconds, shardParts,
  softDeadlineSeconds, type GateRunner,
} from './gate-node';
import { installSlotScript } from '../../src/task-orchestrator/surfaces/pod-install-slots.js';
import { PodPoolScheduler } from '../../src/task-orchestrator/surfaces/pod-pool.js';
import type { RunPodCommandOptions } from '../../src/task-orchestrator/surfaces/pod-command-job.js';
import { readGateShards } from '../../src/release-loop/gate-shards.js';
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

/** A fake `bun` (install · test:deterministic) and `timeout` for running the real Pod shell on this machine. */
function fakeTools(bin: string) {
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'bun'), `#!/bin/bash
if [ "$1" = install ]; then echo "5 packages installed [750ms]"; exit 0; fi
shift 2 # run test:deterministic
files=(); out=
for a in "$@"; do case "$a" in --reporter-outfile=*) out="\${a#--reporter-outfile=}";; --*) ;; *) files+=("\${a#./}");; esac; done
for f in "\${files[@]}"; do case "$f" in *slow*) sleep 30;; esac; done
{ echo '<testsuites>'; for f in "\${files[@]}"; do echo "<testsuite name=\\"$f\\" file=\\"$f\\"><testcase name=\\"works\\" file=\\"$f\\"></testcase></testsuite>"; done; echo '</testsuites>'; } > "$out"
echo "\${#files[@]} pass"; echo "0 fail"; echo "Ran \${#files[@]} tests across \${#files[@]} files."
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
  const shell = gateShardShell({ parts, cdpPatterns: [], softSeconds: 3, cachePrefix: '', installSlots: 0 });
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

function sweepRunner(files: string[], pod: (o: RunPodCommandOptions, parts: string[][]) => Promise<{ exitCode: number; artifactsDir: string; job: string }>) {
  const root = temp('gate-sweep-');
  const repo = join(root, 'repo');
  mkdirSync(repo);
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
