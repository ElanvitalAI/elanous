// GATE-POD-STALL-FAILFAST (0.2.24) — a shard Pod with no test output after its source checkout is stopped within the
// stall window, recorded unmeasured (no split descent), and the gate fails promptly as an executed failure.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createGateRunner, gateBeatScript, gateEnvBaselineLine, gateShardAbortScript, gateShardShell, graphGateResult, readShardArtifacts, readShardLiveLog, runGateNode,
  shardStallWatchRecord, watchShardStall, partialFailuresOf, GATE_POD_MIDRUN_STALL_SECONDS_DEFAULT, GATE_SHARD_ABORT_TRIES, POD_SHARD_FILE_CAP, type GateOptions, type GateResult, type GateRunner,
} from './gate-node';
import { PodPoolScheduler } from '../../src/task-orchestrator/surfaces/pod-pool.js';
import type { RunPodCommandOptions } from '../../src/task-orchestrator/surfaces/pod-command-job.js';
import { debug } from '../../src/debug/log.js';
import { runGraph, type GraphRunState } from '../../src/graph-runner/runner.js';
import { gateUnmeasuredDetail, releaseResumeWaiver } from './resume.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../../src/elanous-config-dir.js';
import { resumeReleaseRun } from './resume-release.js';

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
  const calls: Array<{ name: string; files: string[]; shell: string }> = [];
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
    calls.push({ name: o.name!, files: parts.flat(), shell: o.command[2]! });
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

test('a malformed completed-shard log is reported but cannot replace the stalled-shard failure', () => {
  const { events, restore } = captureGateEvents();
  let partial: ReturnType<typeof partialFailuresOf>;
  try {
    partial = partialFailuresOf([
      { rc: 1, output: 'src/kept.test.ts:\n(fail) existing case [1.00ms]\n1 pass\n1 fail\nRan 2 tests across 1 files.', files: 1 },
      { rc: 2, output: 'completed job with truncated output', files: 1 },
    ]);
  } finally { restore(); }
  expect(partial!).toEqual({ failures: ['src/kept.test.ts > existing case'], errors: [] });
  expect(events.filter((item) => item.event === 'pod-partial-failures-unreadable')).toMatchObject([
    { data: { files: 1, reason: expect.stringContaining('pod partial shard 1 incomplete') } },
  ]);
});

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
  // GATE-ENV-BASELINE: the fresh retry Pod goes through the same shell assembly — it carries the env baseline too.
  for (const call of calls) expect(call.shell.split('\n')).toContain(gateEnvBaselineLine());
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
    expect(JSON.parse(readFileSync(join(root, 'logs', `${name}.json`), 'utf8'))).toMatchObject({ rc: null, reason: 'stall', finishedFiles: 0, stallSeconds: 0.3,
      stallWatch: { armed: true, disarmedBy: 'stall-fired', firstTestAtSec: null, stallSeconds: 0.3 } });
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

test('judgment (0.2.30): a stalled sweep lands on the ledger as an executed failure (unmeasured) that `resume --waive gate` accepts', async () => {
  const files = ['src/a.test.ts', 'src/b.test.ts'];
  const { root, repo, runner, podOptions } = stallRig(files, () => true);
  const stub: GateRunner = {
    command: runner.command, localCommand: runner.localCommand,
    sweep: (_tree, _logDir, pod, only) => { const { shardsFile: _s, ...rest } = pod!; return runner.sweep(repo, join(root, 'logs'), { ...rest, ...podOptions }, only); },
    add: async () => {}, remove: async () => {}, snapshot: async () => {}, removeSnapshot: async () => {},
  };
  // The real graph runner drives the real release graph on a temp ledger (the resume.test.ts / gate-host-executor.test.ts
  // pattern): every node but `gate` answers ok; `gate` runs the recipe's own entry — `gate-node.ts --json` reading the
  // graph context the runner wrote — in-process, with only the Pod sweep faked (the stall rig above).
  const ledger = temp('gate-stall-ledger-');
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const gate: { code?: number; printed: string[]; body?: string; elapsedMs?: number } = { printed: [] };
  const runBash = async (body: string, opts: { env?: NodeJS.ProcessEnv }) => {
    const ctx = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as { nodeId: string };
    if (ctx.nodeId === 'version-release') return { exitCode: 0, stdout: `${JSON.stringify({ outcome: 'ok', version: '9.9.97', commit: CUT, branch: 'release/9.9.97' })}\n`, stderr: '' };
    if (ctx.nodeId !== 'gate') return { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass"}\n', stderr: '' };
    gate.body = body;
    const out = spyOn(console, 'log').mockImplementation((line: unknown) => { gate.printed.push(String(line)); });
    const err = spyOn(console, 'error').mockImplementation(() => {});
    const { restore } = captureGateEvents();
    const started = Date.now();
    try { gate.code = await runGateNode(['--json'], opts.env!, stub); }
    finally { restore(); out.mockRestore(); err.mockRestore(); }
    gate.elapsedMs = Date.now() - started;
    return { exitCode: gate.code, stdout: `${gate.printed.join('\n')}\n`, stderr: '' };
  };
  const first = await runGraph(graphPath, { input: { version: '9.9.97', branchCut: true, previousVersion: '9.9.96', gatePodPool: 'pool-test' }, deps: { root: ledger, runBash } });
  expect(gate.body).toContain('gate-node.ts --json');
  // Ends within the stall window ⊕ one retry — never the shard deadline (10-10: 1697s · rc=null · neither ended nor failed).
  expect(gate.elapsedMs!).toBeLessThan(15_000);
  expect(gate.code).toBe(2);
  expect(first.status).toBe('failed');
  expect(first.path.slice(-3)).toEqual(['gate', 'gate-triage', 'failed']);
  // What `release resume` reads: the state file the runner saved, not the in-memory result.
  const saved = JSON.parse(readFileSync(join(ledger, 'graph-runs', 'release-loop', `${first.runId}.json`), 'utf8')) as GraphRunState;
  expect(saved.path.slice(-3)).toEqual(['gate', 'gate-triage', 'failed']);
  expect(saved.nodes.find((node) => node.nodeId === 'gate-triage')).toMatchObject({ executed: true, ok: true });
  const record = saved.nodes.find((node) => node.nodeId === 'gate')!;
  // An executed failure (exit 2 with the verdict line on the ledger) — not a stopped/no-verdict node.
  expect(record).toMatchObject({ ok: false, executed: true, exit: 2 });
  expect(record.waiver).toBeUndefined();
  const line = JSON.parse(String(record.output).trim().split('\n').at(-1)!) as Record<string, unknown>;
  expect(line).toMatchObject({ outcome: 'error', verdict: 'fail', introduced: [],
    commit: CUT, partialFailures: { failures: [], errors: [] },
    stalledShards: [{ shard: 0, files, reason: 'no-output', stall: { seconds: 0.3, sinceCheckoutMs: expect.any(Number) } }] });
  expect(String(line.error)).toContain('unmeasured: no test output within 0.3s of checkout');
  // The unmeasured marker the waiver rule reads off that saved record.
  expect(gateUnmeasuredDetail(saved, saved.nodes.indexOf(record))).toStartWith('sweep incomplete: pod sweep incomplete: stalled shards 0 (unmeasured: no test output within 0.3s of checkout');
  const reason = 'alternative gate evidence: the pod gate printed no test output after checkout and was recorded unmeasured';
  const waived = releaseResumeWaiver(saved, { from: 'gate', waive: 'gate', reason });
  expect(waived).toMatchObject({ nodeId: 'gate', reason, acceptedRegressions: [{ id: 'waive:gate', note: reason }] });
  expect(waived?.unmeasured).toStartWith('sweep incomplete: pod sweep incomplete: stalled shards 0 (unmeasured: no test output within 0.3s of checkout');
  expect(waived?.unmeasured).toContain('stalled shards 1 (no-output×1)');
  // Exercise the persisted graph output all the way through resume planning; don't inject a synthetic gate result.
  setElanousConfigDir(ledger);
  try {
    let graphCalled = false;
    let plan: Record<string, unknown> | undefined;
    const resumed = await resumeReleaseRun({ runId: first.runId, from: 'gate' }, { root: ledger,
      git: (args) => args[0] === 'ls-remote' ? `${CUT}\trefs/heads/release/9.9.97` : args[0] === 'rev-parse' ? CUT : '',
      isAncestor: () => true, closureTree: () => ({ files }) as never,
      graph: async () => {
        graphCalled = true;
        const planPath = join(ledger, 'release/9.9.97/gate-partial.json');
        if (existsSync(planPath)) plan = JSON.parse(readFileSync(planPath, 'utf8'));
        return { status: 'done', runId: first.runId } as never;
      } });
    expect(graphCalled).toBe(true);
    expect(resumed.partial).toMatchObject({ requested: true, applied: true, files: files.length, priorCommit: CUT });
    expect(plan).toMatchObject({ kind: 'recheck', priorCommit: CUT, forCommit: CUT, files, stalledFiles: files });
  } finally { resetElanousConfigDir(); }
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
  // Each sweep has its own identity even when the measured files and verdict are identical.
  expect(withWatch.podSweep?.id).toBeString();
  expect(without.podSweep?.id).toBeString();
  expect(withWatch.podSweep?.id).not.toBe(without.podSweep?.id);
  expect({ ...withWatch, podSweep: { ...withWatch.podSweep, id: undefined } })
    .toEqual({ ...without, podSweep: { ...without.podSweep, id: undefined } });
  // stallWatch is observation only (GATE-WARM-BOOT-SCAN) — it differs by design and is checked on its own.
  const strip = (meta: Record<string, unknown>) => { const { durationMs: _d, attemptId: _a, phaseTimes: _t, stallWatch: _w, sweepId: _s, ...rest } = meta; return rest; };
  const metaWith = JSON.parse(readFileSync(join(watched.root, 'logs', 'pod-0.json'), 'utf8'));
  const metaWithout = JSON.parse(readFileSync(join(plain.root, 'logs', 'pod-0.json'), 'utf8'));
  expect(metaWith.stallWatch).toEqual({ armed: true, disarmedBy: 'test-output', firstTestAtSec: 0, stallSeconds: 0.3 });
  expect(metaWithout.stallWatch).toEqual({ armed: false, disarmedBy: 'off', firstTestAtSec: null, stallSeconds: 0 });
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
  // GATE-POD-STALL-FAILFAST ①: once there is output the beat carries the part logs' bytes («bun test v1\n» = 12).
  expect(beats.at(-1)).toMatch(/ test 1 12$/);
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

test('GATE-WARM-BOOT-SCAN stallWatch: state names why the watch ended and when the first test output came after the checkout', async () => {
  const run = async (script: Array<string | null>) => {
    let i = 0; let t = 0;
    const watch = watchShardStall({ stallSeconds: 0.1, pollMs: 1, now: () => t, onStall: () => {},
      read: () => { const text = script[Math.min(i, script.length - 1)] ?? null; i++; t += 40; return text; } });
    await Bun.sleep(60);
    watch.stop();
    return watch.state();
  };
  // Checkout seen at t=40, test output at t=80: 0.04 s → rounded to a tenth.
  expect(await run([CHECKOUT, `${CHECKOUT}ELANOUS_GATE_BEAT 1 test 1`])).toEqual({ armed: true, disarmedBy: 'test-output', firstTestAtSec: 0 });
  expect(await run([CHECKOUT, CHECKOUT, `${CHECKOUT}ELANOUS_GATE_BEAT 1 slot 0`, `${CHECKOUT}ELANOUS_GATE_BEAT 2 test 1`])).toEqual({ armed: true, disarmedBy: 'test-output', firstTestAtSec: 0.1 });
  // Silence after the checkout: the stall fired, no test time.
  expect(await run([CHECKOUT])).toEqual({ armed: true, disarmedBy: 'stall-fired', firstTestAtSec: null });
  // Never armed (Pod pending · failed reads): nothing ended it but the Job.
  expect(await run([''])).toEqual({ armed: false, disarmedBy: null, firstTestAtSec: null });
  expect(await run([null])).toEqual({ armed: false, disarmedBy: null, firstTestAtSec: null });
  // The record: off (0 s) and no live log win over any state; a watched shard keeps its state.
  expect(shardStallWatchRecord(0, true, { armed: true, disarmedBy: 'test-output', firstTestAtSec: 3 })).toEqual({ armed: false, disarmedBy: 'off', firstTestAtSec: null, stallSeconds: 0 });
  expect(shardStallWatchRecord(300, false, undefined)).toEqual({ armed: false, disarmedBy: 'no-live-log', firstTestAtSec: null, stallSeconds: 300 });
  expect(shardStallWatchRecord(300, true, undefined)).toEqual({ armed: false, disarmedBy: null, firstTestAtSec: null, stallSeconds: 300 });
});

test('GATE-WARM-BOOT-SCAN stallWatch: a pod sweep without a live log records no-live-log and changes nothing else', async () => {
  const files = ['src/a.test.ts'];
  const rig = stallRig(files, () => false);
  const { liveLog: _l, ...noLive } = rig.podOptions;
  await rig.runner.sweep(rig.repo, join(rig.root, 'logs'), noLive);
  expect(JSON.parse(readFileSync(join(rig.root, 'logs', 'pod-0.json'), 'utf8')).stallWatch).toEqual({ armed: false, disarmedBy: 'no-live-log', firstTestAtSec: null, stallSeconds: 0.3 });
  expect(rig.stopped).toEqual([]);
});

// ── GATE-POD-STALL-FAILFAST ① (mid-run) — a hang after test output began ends only the Pod's test process group ──────────

/** Drives one watch over a scripted live log (one entry per read, the last repeated) on a fake clock. */
async function midRunWatch(script: Array<string | null>, o: { midRunStallSeconds?: number; abortTaken?: Array<boolean | void>; withAbort?: boolean } = {}) {
  let i = 0; let t = 0;
  const calls = { abort: 0, stop: 0, stall: 0, onAbort: [] as number[] };
  const taken = o.abortTaken ?? [];
  const watch = watchShardStall({ stallSeconds: 0.1, pollMs: 1, now: () => t, onStall: () => { calls.stall++; },
    read: () => { const text = script[Math.min(i, script.length - 1)] ?? null; i++; t += 40; return text; },
    stopJob: () => { calls.stop++; },
    midRunStallSeconds: o.midRunStallSeconds ?? 0.2,
    onAbort: ({ sinceLastOutputMs }) => { calls.onAbort.push(sinceLastOutputMs); },
    ...(o.withAbort === false ? {} : { abortTests: () => taken[calls.abort++] ?? true }) });
  await Bun.sleep(80);
  watch.stop();
  return { calls, aborted: watch.aborted(), stalled: watch.stalled(), state: watch.state() };
}
const beat = (seq: number, bytes?: number) => `${CHECKOUT}ELANOUS_GATE_BEAT ${seq} test 1${bytes === undefined ? '' : ` ${bytes}`}`;

test('mid-run: output that stops growing past midRunStallSeconds aborts the tests once — never the Job, never the checkout stall', async () => {
  // First output, then the bytes stay put (10-16 0.2.30 HARD pod-55: part-0.log silent ~20 min, beat still «test 1»).
  const fixed = await midRunWatch([CHECKOUT, beat(1, 100), beat(2, 100), beat(3, 100)]);
  expect(fixed.calls.abort).toBe(1);
  expect(fixed.calls.stop).toBe(0);
  expect(fixed.calls.stall).toBe(0);
  expect(fixed.stalled).toBeUndefined();
  expect(fixed.calls.onAbort).toHaveLength(1);
  expect(fixed.calls.onAbort[0]!).toBeGreaterThanOrEqual(200);
  expect(fixed.aborted).toMatchObject({ reason: 'mid-run-stall 0.2s', by: 'auto', taken: true });
  expect(fixed.state).toEqual({ armed: true, disarmedBy: 'mid-run-stall', firstTestAtSec: 0, abort: { reason: 'mid-run-stall 0.2s', at: expect.any(String), by: 'auto' } });
  // Bytes that keep growing: no abort.
  const growing = await midRunWatch([CHECKOUT, ...Array.from({ length: 400 }, (_, n) => beat(n + 1, 100 + n))]);
  expect(growing.calls.abort).toBe(0);
  expect(growing.aborted).toBeUndefined();
  expect(growing.state).toEqual({ armed: true, disarmedBy: 'test-output', firstTestAtSec: 0 });
  // Failed reads after the output decide nothing new on their own — they neither reset nor fire before the window.
  expect((await midRunWatch([CHECKOUT, beat(1, 5), null], { midRunStallSeconds: 60 })).calls.abort).toBe(0);
});

test('mid-run: the old beat (no bytes), 0 = off, and no abort hook all keep today\'s behavior — the watch ends at the first output', async () => {
  for (const run of [
    await midRunWatch([CHECKOUT, beat(1), beat(2), beat(3)]),
    await midRunWatch([CHECKOUT, beat(1, 100), beat(2, 100)], { midRunStallSeconds: 0 }),
    await midRunWatch([CHECKOUT, beat(1, 100), beat(2, 100)], { withAbort: false }),
  ]) {
    expect(run.calls.abort).toBe(0);
    expect(run.calls.stop).toBe(0);
    expect(run.aborted).toBeUndefined();
    expect(run.state).toEqual({ armed: true, disarmedBy: 'test-output', firstTestAtSec: 0 });
  }
  // Before the first output the checkout stall is unchanged: Job stop, no test abort.
  const silent = await midRunWatch([CHECKOUT]);
  expect(silent.calls.stall).toBe(1);
  expect(silent.calls.stop).toBe(1);
  expect(silent.calls.abort).toBe(0);
  expect(silent.state.disarmedBy).toBe('stall-fired');
  // An abort that does not take is asked again on the next polls, bounded.
  const refused = await midRunWatch([CHECKOUT, beat(1, 9)], { abortTaken: [false, false, false, false, false] });
  expect(refused.calls.abort).toBe(GATE_SHARD_ABORT_TRIES);
  expect(refused.aborted).toMatchObject({ taken: false });
  const second = await midRunWatch([CHECKOUT, beat(1, 9)], { abortTaken: [false, true] });
  expect(second.calls.abort).toBe(2);
  expect(second.aborted).toMatchObject({ taken: true });
  // The parser: bytes when present, the old line unchanged.
  expect(readShardLiveLog(`${beat(4, 1234)}\n`).beat).toEqual({ seq: 4, stage: 'test', testOutput: true, bytes: 1234 });
  expect(readShardLiveLog(`${beat(4)}\n`).beat).toEqual({ seq: 4, stage: 'test', testOutput: true });
  expect(GATE_POD_MIDRUN_STALL_SECONDS_DEFAULT).toBeGreaterThan(0);
});

test('mid-run beat in the real shell: «test 1 <bytes>» carries the part logs\' total, earlier beats keep the old form', () => {
  const outbox = temp('gate-beat-bytes-');
  const script = [
    `O=${JSON.stringify(outbox)}`,
    ...gateBeatScript(1, false),
    'sleep 1.3',
    'echo 0 > "$O/install.rc"; printf "12345" > "$O/part-0.log"; printf "abc" > "$O/part-1.log"',
    'sleep 1.2',
  ].join('\n');
  const ran = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 15_000 });
  expect(ran.status).toBe(0);
  const beats = ran.stdout.split('\n').filter((line) => line.startsWith('ELANOUS_GATE_BEAT '));
  expect(beats[0]).toBe('ELANOUS_GATE_BEAT 1 install 0');
  expect(beats.at(-1)).toMatch(/^ELANOUS_GATE_BEAT \d+ test 1 8$/);
  expect(readShardLiveLog(beats.join('\n')).beat).toMatchObject({ stage: 'test', testOutput: true, bytes: 8 });
});

test('an aborted part reads like a deadline cut: unfinished, timed out, its exit no verdict; the other parts keep theirs', () => {
  const dir = temp('gate-abort-outbox-');
  writeFileSync(join(dir, 'install.rc'), '0\n');
  writeFileSync(join(dir, 'part-0.log'), summary(['src/a.test.ts']));
  writeFileSync(join(dir, 'part-0.rc'), '0\n');
  writeFileSync(join(dir, 'part-1.log'), 'src/b.test.ts:\n(pass) first [1.00ms]\n');
  writeFileSync(join(dir, 'part-1.rc'), '143\n');
  writeFileSync(join(dir, 'part-1.abort'), 'mid-run-stall 600s\n');
  writeFileSync(join(dir, 'shard.timeout'), '1\n');
  const read = readShardArtifacts(dir, [['src/a.test.ts'], ['src/b.test.ts']]);
  expect(read).toMatchObject({ timedOut: true, finished: ['src/a.test.ts'] });
  expect(read.rc).toBeUndefined();
  expect(read.exitCodeOnly).toBeUndefined();
  expect(read.unfinishedLog).toContain('# part 1 (abort: mid-run-stall 600s)');
});

test('a sweep whose shard hangs mid-run: tests aborted in the Pod (no Job stop), shard recorded with abort, files re-run, the run goes on', async () => {
  const files = ['src/a.test.ts', 'src/b.test.ts'];
  const root = temp('gate-midrun-');
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const command: GateRunner['command'] = async (cmd, args) => {
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
    return { rc: cmd === 'rg' ? 1 : 0, output: '' };
  };
  const live = new Map<string, { text: string; abort?: () => void }>();
  const calls: string[][] = [];
  const aborted: Array<{ name: string; reason: string }> = [];
  const stopped: string[] = [];
  const pod = async (o: RunPodCommandOptions) => {
    const parts = [...o.command[2]!.matchAll(/run_part \d+ ([^&]*)/g)].map((m) => [...m[1]!.matchAll(/'\.\/([^']+)'/g)].map((f) => f[1]!));
    calls.push(parts.flat());
    const dir = join(root, o.name!);
    mkdirSync(dir);
    writeFileSync(join(dir, 'install.rc'), '0\n');
    if (calls.length === 1) {
      // First output, then nothing more: the bytes stay at 42 until the in-Pod abort ends the test process group.
      parts.forEach((part, index) => writeFileSync(join(dir, `part-${index}.log`), `${part[0]}:\n(pass) started [1.00ms]\n`));
      return new Promise<{ exitCode: number; artifactsDir: string; job: string }>((resolveJob) => {
        const safety = setTimeout(() => resolveJob({ exitCode: 1, artifactsDir: dir, job: o.name! }), 25_000);
        live.set(o.name!, { text: `${CHECKOUT}ELANOUS_GATE_BEAT 1 test 1 42\n`, abort: () => {
          // What gateShardAbortScript leaves: the abort marker and shard.timeout; the killed part exits 143.
          parts.forEach((_, index) => { writeFileSync(join(dir, `part-${index}.abort`), 'mid-run-stall 0.3s\n'); writeFileSync(join(dir, `part-${index}.rc`), '143\n'); });
          writeFileSync(join(dir, 'shard.timeout'), '0\n');
          clearTimeout(safety);
          setTimeout(() => resolveJob({ exitCode: 0, artifactsDir: dir, job: o.name! }), 10);
        } });
      });
    }
    live.set(o.name!, { text: `${CHECKOUT}ELANOUS_GATE_BEAT 1 test 1\n` });
    parts.forEach((part, index) => {
      writeFileSync(join(dir, `part-${index}.log`), summary(part));
      writeFileSync(join(dir, `part-${index}.rc`), '0\n');
    });
    await Bun.sleep(50);
    return { exitCode: 0, artifactsDir: dir, job: o.name! };
  };
  const runner = createGateRunner(repo, undefined, command, pod, new PodPoolScheduler([{ context: 'pool-test', capacity: 8, k3dCluster: 'test' }]), () => CHECKOUT);
  const { events, restore } = captureGateEvents();
  let result;
  try {
    result = await runner.sweep(repo, join(root, 'logs'), {
      pool: 'pool-test', shards: 1, stallSeconds: 0.3, stallPollMs: 20, midRunStallSeconds: 0.3,
      liveLog: (job) => live.get(job.name)?.text ?? null,
      stopJob: (job) => { stopped.push(job.name); },
      abortTests: (job, reason) => { aborted.push({ name: job.name, reason }); live.get(job.name)?.abort?.(); },
    });
  } finally { restore(); }
  // One in-Pod abort, zero Job stops; the sweep went on and measured every file (the run continues).
  expect(aborted).toHaveLength(1);
  expect(aborted[0]!.reason).toBe('mid-run-stall 0.3s');
  expect(stopped).toEqual([]);
  expect(calls.length).toBeGreaterThan(1);
  expect(calls[0]).toEqual(files);
  expect(result).toMatchObject({ rc: 0, abortedShards: 1 });
  expect(result!.output).toContain('Ran 2 tests across 2 files.');
  const meta = JSON.parse(readFileSync(join(root, 'logs', 'pod-0.json'), 'utf8'));
  expect(meta).toMatchObject({ rc: null, reason: 'timeout', abort: { reason: 'abort: mid-run-stall 0.3s', by: 'auto', at: expect.any(String), taken: true },
    stallWatch: { armed: true, disarmedBy: 'mid-run-stall', abort: { reason: 'mid-run-stall 0.3s', by: 'auto' }, stallSeconds: 0.3 } });
  const abortEvents = events.filter((item) => item.event === 'shard-abort');
  expect(abortEvents.map((item) => item.data)).toEqual([{ shard: 0, branch: '', reason: 'mid-run-stall 0.3s', by: 'auto', sinceLastOutputMs: expect.any(Number) }]);
  expect(events.some((item) => item.event === 'pod-shard-stall')).toBe(false);
  expect(events.filter((item) => item.event === 'pod-sweep-aborted').map((item) => item.data)).toEqual([{ shards: 1, midRunStallSeconds: 0.3 }]);
  // The verdict summary names the aborted shards.
  const verdict = { outcome: 'ok', introduced: [], preexisting: 0, fixed: 0, knownEnv: 0, stalledEnv: [], rcNonzeroNoFailures: [], abortedShards: 1 } as unknown as GateResult;
  expect(graphGateResult(verdict, true).summary).toContain('중단 조각 1');
  expect(graphGateResult({ ...verdict, abortedShards: undefined }, true).summary).not.toContain('중단 조각');
}, 40_000);

// The in-Pod abort itself needs Linux /proc and setsid (the gate image); elsewhere this case is skipped.
const canRunAbortScript = existsSync('/proc/self/stat') && spawnSync('sh', ['-c', 'command -v setsid'], { encoding: 'utf8' }).status === 0;
test.skipIf(!canRunAbortScript)('the in-Pod abort script ends only the test process group, leaving the abort marker and shard.timeout', async () => {
  const home = temp('gate-abort-run-');
  const outbox = join(home, 'outbox');
  mkdirSync(outbox);
  // A group leader whose argv carries the part's reporter outfile (GNU timeout's shape), with a child in its group.
  const leader = Bun.spawn(['setsid', 'bash', '-c', 'sleep 300 & wait', 'x', `--reporter-outfile=${outbox}/part-3.junit.xml`], { stdout: 'ignore', stderr: 'ignore' });
  const bystander = Bun.spawn(['sleep', '300'], { stdout: 'ignore', stderr: 'ignore' });
  await Bun.sleep(300);
  try {
    const ran = spawnSync('bash', ['-c', gateShardAbortScript('mid-run-stall 600s', 1, outbox)], { encoding: 'utf8', timeout: 20_000 });
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain('ELANOUS_GATE_ABORT part=3');
    expect(readFileSync(join(outbox, 'part-3.abort'), 'utf8')).toBe('mid-run-stall 600s\n');
    expect(readFileSync(join(outbox, 'shard.timeout'), 'utf8')).toBe('3\n');
    const code = await Promise.race([leader.exited, Bun.sleep(5_000).then(() => 'alive')]);
    expect(code).not.toBe('alive');
    expect(bystander.exitCode).toBeNull();
    // Nothing left to abort: exit non-zero (not taken).
    expect(spawnSync('bash', ['-c', gateShardAbortScript('mid-run-stall 600s', 1, outbox)], { encoding: 'utf8' }).status).not.toBe(0);
  } finally { leader.kill(9); bystander.kill(9); }
}, 30_000);
