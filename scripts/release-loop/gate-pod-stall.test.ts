// GATE-POD-STALL-FAILFAST (0.2.24) — a shard Pod with no test output after its source checkout is stopped within the
// stall window, recorded unmeasured (no split descent), and the gate fails promptly as an executed failure.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createGateRunner, gateBeatScript, gateShardShell, readShardLiveLog, runGateNode, watchShardStall,
  POD_SHARD_FILE_CAP, type GateOptions, type GateRunner,
} from './gate-node';
import { PodPoolScheduler } from '../../src/task-orchestrator/surfaces/pod-pool.js';
import type { RunPodCommandOptions } from '../../src/task-orchestrator/surfaces/pod-command-job.js';
import { debug } from '../../src/debug/log.js';

const CUT = 'c'.repeat(40);
const CHECKOUT = `Cloning into 'repo'...\nELANOUS_POD_SOURCE_VIA mirror\nELANOUS_POD_SOURCE commit ${CUT}\n`;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };
const summary = (files: readonly string[]) => `${files.map((file) => `${file}:\n(pass) case [1.00ms]`).join('\n')}\n${files.length} pass\n0 fail\nRan ${files.length} tests across ${files.length} files.\n`;

/** A pod runner whose Job either stalls after the checkout (resolves only when stopped) or runs every part cleanly. */
function stallRig(files: string[], stalls: (call: number) => boolean, partRc: (part: string[]) => number = () => 0) {
  const root = temp('gate-stall-');
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const calls: Array<{ name: string; files: string[] }> = [];
  const live = new Map<string, { text: string; stop?: () => void }>();
  const stopped: string[] = [];
  const command: GateRunner['command'] = async (cmd, args) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
    return { rc: 0, output: '' };
  };
  const pod = async (o: RunPodCommandOptions) => {
    const parts = [...o.command[2]!.matchAll(/run_part \d+ ([^&]*)/g)].map((m) => [...m[1]!.matchAll(/'\.\/([^']+)'/g)].map((f) => f[1]!));
    calls.push({ name: o.name!, files: parts.flat() });
    const dir = join(root, o.name!);
    mkdirSync(dir);
    if (stalls(calls.length)) {
      // containerd-unresponsive shape (10-10): the checkout prints, then nothing — not even the beat.
      return new Promise<{ exitCode: number; artifactsDir: string; job: string }>((resolveJob) => {
        const safety = setTimeout(() => resolveJob({ exitCode: 1, artifactsDir: dir, job: o.name! }), 20_000);
        live.set(o.name!, { text: CHECKOUT, stop: () => { clearTimeout(safety); resolveJob({ exitCode: 1, artifactsDir: dir, job: o.name! }); } });
      });
    }
    live.set(o.name!, { text: `${CHECKOUT}ELANOUS_GATE_BEAT 1 test 1\n` });
    writeFileSync(join(dir, 'install.rc'), '0\n');
    parts.forEach((part, index) => {
      writeFileSync(join(dir, `part-${index}.log`), summary(part));
      writeFileSync(join(dir, `part-${index}.rc`), `${partRc(part)}\n`);
    });
    // A healthy shard that is still running when the watch polls (test output already there).
    await Bun.sleep(150);
    return { exitCode: 0, artifactsDir: dir, job: o.name! };
  };
  const runner = createGateRunner(repo, undefined, command, pod, new PodPoolScheduler([{ context: 'pool-test', capacity: 8, k3dCluster: 'test' }]), () => CHECKOUT);
  const podOptions: NonNullable<GateOptions['pod']> = {
    pool: 'pool-test', shards: 1, stallSeconds: 0.3, stallPollMs: 20,
    liveLog: (job) => live.get(job.name)?.text ?? null,
    stopJob: (job) => { stopped.push(job.name); live.get(job.name)?.stop?.(); },
  };
  return { root, repo, runner, calls, stopped, podOptions, command };
}

function captureGateEvents() {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const spy = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'release-loop.gate') events.push({ event, data: data as Record<string, unknown> });
  });
  return { events, restore: () => spy.mockRestore() };
}

test('a shard that prints only its checkout is stopped within the stall window, retried once fresh, never split, and the sweep fails as unmeasured', async () => {
  // More files than the cap: a «no-output» root shard would otherwise cap-split into -c0/-c1 after its retry.
  const files = Array.from({ length: POD_SHARD_FILE_CAP + 5 }, (_, i) => `src/s-${String(i).padStart(2, '0')}.test.ts`);
  const { root, repo, runner, calls, stopped, podOptions } = stallRig(files, () => true);
  const { events, restore } = captureGateEvents();
  const started = Date.now();
  let error: unknown;
  try { await runner.sweep(repo, join(root, 'logs'), podOptions); }
  catch (caught) { error = caught; }
  finally { restore(); }
  const elapsed = Date.now() - started;
  expect(error).toBeInstanceOf(Error);
  expect(String((error as Error).message)).toContain('unmeasured: no test output within 0.3s of checkout — shards 0');
  expect((error as { stalledShards?: unknown }).stalledShards).toEqual([
    { shard: 0, files, reason: 'no-output', stall: { seconds: 0.3, sinceCheckoutMs: expect.any(Number) } },
  ]);
  // First attempt ⊕ the one fresh retry — no -c<n> / -<n> split Pods.
  expect(calls.map((call) => call.files)).toEqual([files, files]);
  expect(stopped).toEqual(calls.map((call) => call.name));
  expect(elapsed).toBeLessThan(10_000);
  const stalls = events.filter((item) => item.event === 'pod-shard-stall');
  expect(stalls.map((item) => item.data)).toEqual([
    { shard: 0, branch: '', stallSeconds: 0.3, sinceCheckoutMs: expect.any(Number) },
    { shard: 0, branch: '-retry', stallSeconds: 0.3, sinceCheckoutMs: expect.any(Number) },
  ]);
  for (const item of stalls) expect(item.data.sinceCheckoutMs as number).toBeGreaterThanOrEqual(300);
  expect(events.some((item) => /^pod-shard-(?:cap-)?split$|^pod-shard-isolate$|^retry-narrowed$/.test(item.event))).toBe(false);
  expect(events.filter((item) => item.event === 'pod-sweep-unmeasured').map((item) => item.data)).toEqual([{ shards: [0], files: files.length, stallSeconds: 0.3, measuredFiles: 0 }]);
  for (const name of ['pod-0', 'pod-0-retry']) {
    expect(JSON.parse(readFileSync(join(root, 'logs', `${name}.json`), 'utf8'))).toMatchObject({ rc: null, reason: 'stall', finishedFiles: 0, stallSeconds: 0.3 });
  }
  expect(existsSync(join(root, 'logs', 'pod-0-c0.json'))).toBe(false);
}, 30_000);

test('the gate node entry ends promptly with exit 2 and a failed verdict line, the stalled shard listed (an executed failure, not a hang)', async () => {
  const files = ['src/a.test.ts', 'src/b.test.ts'];
  const { root, repo, runner, podOptions } = stallRig(files, () => true);
  // Only the sweep is faked down to the Pod: its logs stay in this temp dir and no shards.json reaches a real ledger.
  const stub: GateRunner = {
    command: runner.command, localCommand: runner.localCommand,
    sweep: (_tree, _logDir, pod, only) => { const { shardsFile: _s, ...rest } = pod!; return runner.sweep(repo, join(root, 'logs'), { ...rest, ...podOptions }, only); },
    add: async () => {}, remove: async () => {}, snapshot: async () => {}, removeSnapshot: async () => {},
  };
  const printed: string[] = [];
  const out = spyOn(console, 'log').mockImplementation((line: unknown) => { printed.push(String(line)); });
  const err = spyOn(console, 'error').mockImplementation(() => {});
  const { restore } = captureGateEvents();
  const started = Date.now();
  let code: number;
  try {
    code = await runGateNode(['--commit', CUT, '--version', '9.9.97', '--baseline-version', '9.9.96', '--pod-pool', 'pool-test', '--json'], {}, stub);
  } finally { restore(); out.mockRestore(); err.mockRestore(); }
  expect(Date.now() - started).toBeLessThan(15_000);
  expect(code).toBe(2);
  const line = JSON.parse(printed.at(-1)!) as Record<string, unknown>;
  expect(line).toMatchObject({ outcome: 'error', verdict: 'fail', stalledEnv: [],
    stalledShards: [{ shard: 0, files, reason: 'no-output', stall: { seconds: 0.3, sinceCheckoutMs: expect.any(Number) } }] });
  expect(String(line.summary)).toContain('게이트 error');
  expect(String(line.error)).toContain('unmeasured');
}, 30_000);

test('a shard that prints test output is unaffected: no stop, no retry, same result and record as without the watch', async () => {
  const files = ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts'];
  const watched = stallRig(files, () => false);
  const { events, restore } = captureGateEvents();
  let withWatch;
  try { withWatch = await watched.runner.sweep(watched.repo, join(watched.root, 'logs'), watched.podOptions); }
  finally { restore(); }
  expect(watched.calls).toHaveLength(1);
  expect(watched.stopped).toEqual([]);
  expect(events.some((item) => item.event === 'pod-shard-stall' || item.event === 'pod-sweep-unmeasured')).toBe(false);
  const plain = stallRig(files, () => false);
  const off = captureGateEvents();
  let without;
  try { without = await plain.runner.sweep(plain.repo, join(plain.root, 'logs'), { pool: 'pool-test', shards: 1, stallSeconds: 0 }); }
  finally { off.restore(); }
  expect(withWatch).toEqual(without);
  const strip = (meta: Record<string, unknown>) => { const { durationMs: _d, attemptId: _a, ...rest } = meta; return rest; };
  const metaWith = JSON.parse(readFileSync(join(watched.root, 'logs', 'pod-0.json'), 'utf8'));
  const metaWithout = JSON.parse(readFileSync(join(plain.root, 'logs', 'pod-0.json'), 'utf8'));
  // runKey hashes the shell without the beat: a watched run reuses (and leaves) the same records as before.
  expect(strip(metaWith)).toEqual(strip(metaWithout));
  expect(metaWith.reason).toBeUndefined();
});

test('the stall clock: armed by the checkout, paused by an install-slot wait, disarmed for good by test output, and blind to failed reads', async () => {
  const run = async (script: Array<string | null>, stallMs = 100) => {
    let i = 0;
    let t = 0;
    const hits: number[] = [];
    const watch = watchShardStall({ stallSeconds: stallMs / 1000, pollMs: 1, now: () => t, onStall: (ms) => hits.push(ms),
      read: () => { const text = script[Math.min(i, script.length - 1)] ?? null; i++; t += 40; return text; } });
    await Bun.sleep(60);
    watch.stop();
    return { hits, stalled: watch.stalled() };
  };
  // No checkout yet (Pod pending): never stalls.
  expect((await run([''])).stalled).toBeUndefined();
  // Checkout and silence: stalls.
  expect((await run([CHECKOUT])).stalled).toEqual({ sinceCheckoutMs: 120 });
  // A failed read decides nothing.
  expect((await run([null])).stalled).toBeUndefined();
  // Beats in install with no test output still stall (a hung install).
  expect((await run([CHECKOUT, `${CHECKOUT}ELANOUS_GATE_BEAT 1 install 0`, `${CHECKOUT}ELANOUS_GATE_BEAT 2 install 0`, `${CHECKOUT}ELANOUS_GATE_BEAT 3 install 0`])).stalled).toBeDefined();
  // A slot wait keeps resetting the window while new beats arrive.
  const slot = Array.from({ length: 200 }, (_, n) => `${CHECKOUT}ELANOUS_GATE_BEAT ${n + 1} slot 0`);
  expect((await run(slot)).stalled).toBeUndefined();
  // The grace extends the window: a beat reporting output just after the window still wins over the stop.
  {
    let i = 0; let t = 0;
    const late = [CHECKOUT, CHECKOUT, CHECKOUT, `${CHECKOUT}ELANOUS_GATE_BEAT 1 test 1`];
    const watch = watchShardStall({ stallSeconds: 0.1, graceMs: 100, pollMs: 1, now: () => t, onStall: () => {},
      read: () => { const text = late[Math.min(i, late.length - 1)]!; i++; t += 40; return text; } });
    await Bun.sleep(60);
    watch.stop();
    expect(watch.stalled()).toBeUndefined();
  }
  // A stop that does not take is asked again every poll until it does — never left to the Job deadline.
  {
    let t = 0;
    const answers = [false, false, true];
    let asked = 0;
    const watch = watchShardStall({ stallSeconds: 0.05, pollMs: 1, now: () => (t += 40), onStall: () => {}, read: () => CHECKOUT,
      stopJob: () => answers[asked++] ?? true });
    await Bun.sleep(60);
    watch.stop();
    expect(watch.stalled()).toBeDefined();
    expect(asked).toBe(3);
  }
  // Test output disarms for good, even if later reads look empty.
  expect((await run([`${CHECKOUT}ELANOUS_GATE_BEAT 1 test 1`, CHECKOUT])).stalled).toBeUndefined();
  expect(readShardLiveLog(`${CHECKOUT}ELANOUS_GATE_BEAT 7 slot 0\nELANOUS_GATE_BEAT 8 test 0\n`)).toEqual({ checkout: true, beat: { seq: 8, stage: 'test', testOutput: false } });
});

test('the beat runs in the real shell: install → slot → test with output, and stops with the shell', () => {
  const outbox = temp('gate-beat-');
  const script = [
    `O=${JSON.stringify(outbox)}`,
    ...gateBeatScript(1, true),
    'sleep 1.3',
    'echo "[gate] deps . miss (bun.lock differs)" >> "$O/install.log"',
    'sleep 1.2',
    'echo "[gate] install-slot 0 waited 2s" >> "$O/install.log"; echo 0 > "$O/install.rc"; echo "bun test v1" > "$O/part-0.log"',
    'sleep 1.2',
  ].join('\n');
  const started = Date.now();
  const ran = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 15_000 });
  expect(ran.status).toBe(0);
  expect(Date.now() - started).toBeLessThan(8_000);
  const beats = ran.stdout.split('\n').filter((line) => line.startsWith('ELANOUS_GATE_BEAT '));
  expect(beats[0]).toBe('ELANOUS_GATE_BEAT 1 install 0');
  expect(beats.some((line) => / slot 0$/.test(line))).toBe(true);
  expect(beats.at(-1)).toMatch(/ test 1$/);
  // The shard shell carries the beat only when asked; without it the shell is the old one (runKey unchanged).
  const base = { parts: [['src/a.test.ts']], cdpPatterns: [], softSeconds: 100, cachePrefix: '', installSlots: 4 };
  expect(gateShardShell(base)).not.toContain('ELANOUS_GATE_BEAT');
  expect(gateShardShell({ ...base, beatSeconds: 30 })).toContain('sleep 30 >/dev/null');
  expect(gateShardShell({ ...base, beatSeconds: 30 }).replace(gateBeatScript(30, true).join('\n') + '\n', '')).toBe(gateShardShell(base));
});

test('OP: a complete clean summary with an exit other than 0/1 is an exit-code anomaly naming the file, not a stalled shard', async () => {
  // 0.2.23 gate: a test left process.exitCode set — «0 fail · rc 3» — and the verdict only said «stalled shards».
  const files = ['src/a.test.ts', 'src/leak.test.ts'];
  const { root, repo, runner, stopped, podOptions } = stallRig(files, () => false, (part) => (part.includes('src/leak.test.ts') ? 3 : 0));
  const { restore } = captureGateEvents();
  let error: unknown;
  try { await runner.sweep(repo, join(root, 'logs'), podOptions); }
  catch (caught) { error = caught; }
  finally { restore(); }
  expect(error).toBeInstanceOf(Error);
  expect(String((error as Error).message)).toContain('exit-code anomaly: 0 fail but exit ≠ 0/1 — src/leak.test.ts');
  expect(String((error as Error).message)).not.toContain('unmeasured');
  const stalled = (error as { stalledShards: Array<{ files: string[]; reason: string }> }).stalledShards;
  expect(stalled.map(({ files: f, reason }) => ({ files: f, reason }))).toEqual([{ files: ['src/leak.test.ts'], reason: 'exit-code' }]);
  expect(stopped).toEqual([]);
}, 30_000);
