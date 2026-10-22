import { setDefaultTimeout, afterEach, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createGateRunner, gateShardShell, previousShardDescent, previousShardResult, GATE_ISOLATED_TIMEOUT_MS, GATE_TIMEOUT_RECHECK_MS, GATE_HOST_RECHECK_FILE_LIMIT, loadFlakyCensusPath, limitedLocalCommand, graphGateResult, judgeGate, parseOptions, readIsolatedRun, POD_HEAVY_FILE_MB, POD_MEMORY_SOURCE, POD_SHARD_FILE_CAP, GATE_NIGHTLY_AUDITS, POD_SWEEP_INTEGRATION_ONLY, stripPodRepoRoot, admitGateShard, poolGateAdmission, reportSelectionTimed, reservedGateHosts, runGateNode, warmCommandMatchesRequest, warmEvidenceFromVerdicts, withWarmGateHooks, GATE_ADMISSION_WAIT_SECONDS_DEFAULT, type GateAdmission, type GateRunner } from './gate-node';
import { resetElanousConfigDir, setElanousConfigDir } from '../../src/elanous-config-dir.js';
import { resetUserConfig } from '../../src/user-config.js';
import { releaseLedgerRoot, prodInstanceRoot } from '../../src/instance/resolve.js';
import { debug } from '../../src/debug/log.js';
import { enableLandingFreeze } from '../../src/release-loop/landing-freeze.js';
import { planPartialRegate, planStalledShardRecheck, writePartialPlan, writeRecheckPlan } from './gate-partial';
import { hardRehearsalGateVersion } from './gate-radius-live';
import { gateEnvFingerprint } from './gate-baseline-receipt';
import { parseFailures, parseTimedOutFailures } from './gate-diff';
import { parsePodCpu, runPodCommand, type RunPodCommandOptions } from '../../src/task-orchestrator/surfaces/pod-command-job.js';
import { PodPoolScheduler, parsePodPool } from '../../src/task-orchestrator/surfaces/pod-pool.js';
import { HostPoolLease } from '../../src/pod-lease/host-lease.js';
import { gateShardsPath, readGateShards } from '../../src/release-loop/gate-shards.js';
import { warmReferenceFromJobArtifacts, writeWarmJobManifest } from './gate-warm-artifacts.js';
import { inspectReleaseGateHost } from '../../src/release-loop/gate-host-reservation.js';
import { runGraph } from '../../src/graph-runner/runner.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

test('freeze prevents starting the release gate before runner side effects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'freeze-release-gate-'));
  scratch.push(root);
  enableLandingFreeze({ reason: 'drill', by: 'MK' }, root);
  let calls = 0;
  const runner = new Proxy({}, { get: () => { calls++; throw new Error('runner must not run'); } }) as GateRunner;
  await expect(judgeGate({ commit: 'a'.repeat(40), version: '0.2.4', instanceRoot: root }, runner)).rejects.toThrow('동결 중 · drill');
  expect(calls).toBe(0);
});

const CUT = 'a'.repeat(40), BASE = 'b'.repeat(40);
const A = 'src/a.test.ts > A', B = 'src/b.test.ts > B', C = 'src/c.test.ts > C', D = 'src/d.test.ts > D';
const scratch: string[] = [];
test('gate host reservation names the actual executor rather than every remote host', () => {
  expect(reservedGateHosts({ remote: 'node-b' })).toEqual(['node-b']);
  expect(reservedGateHosts({ remote: 'agent@node-b' })).toEqual(['node-b']);
  expect(reservedGateHosts({})).toEqual([hostname()]);
  expect(reservedGateHosts({ pod: { pool: 'local-pod:1' } })).toEqual([hostname()]);
  expect(reservedGateHosts({ pod: { pool: 'pod-a@node-b:1,pod-b@node-c:1' } })).toEqual(['node-b', 'node-c']);
});

test('graph-runner context reserves the gate host during the real judge sweep', async () => {
  const { root, instanceRoot, runner } = fake([], []);
  const command = runner.command.bind(runner);
  runner.command = async (cmd, args, cwd, limitMs) => cmd === 'mktemp'
    ? { rc: 0, output: '/tmp/release-gate-proof\n' } : command(cmd, args, cwd, limitMs);
  setElanousConfigDir(instanceRoot);
  const graph = join(root, 'reservation-graph.yaml');
  writeFileSync(join(root, 'recipes.yaml'), 'gate:\n  command: "gate-node"\n');
  writeFileSync(graph, `graph_id: release-gate-reservation\nversion: 1\nentry_node: gate\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: gate, kind: agent, recipe: 'cmd:gate', max_visits: 1 }\n  - { node_id: done, kind: gate, max_visits: 1 }\n  - { node_id: failed, kind: gate, max_visits: 1 }\nedges:\n  - from: gate\n    on: outcome\n    map: { ok: done, fail: failed }\n`);
  let finish!: () => void;
  const wait = new Promise<void>(resolve => { finish = resolve; });
  let entered!: () => void;
  const sweepEntered = new Promise<void>(resolve => { entered = resolve; });
  const sweep = runner.sweep.bind(runner);
  runner.sweep = async (tree, logDir, pod, only) => { entered(); await wait; return sweep(tree, logDir, pod, only); };
  const running = runGraph(graph, { runId: 'gate-live-run', pinChildUniverse: true,
    input: { commit: CUT, version: '1.0.1', previousVersion: '1.0.0', gateExecutor: 'host', gateRemote: 'node-b' },
    deps: { root: instanceRoot, runBash: async (_body, opts) => {
      const rc = await runGateNode(['--json'], opts.env!, runner);
      return { exitCode: rc, stdout: JSON.stringify({ outcome: rc === 0 ? 'ok' : 'fail', verdict: rc === 0 ? 'pass' : 'fail' }), stderr: '' };
    } } });
  await Promise.race([sweepEntered, running.then(() => { throw new Error('gate ended before sweep'); })]);
  expect(inspectReleaseGateHost(instanceRoot, 'node-b')).toMatchObject({ status: 'reserved', runId: 'gate-live-run' });
  finish();
  await running;
  expect(inspectReleaseGateHost(instanceRoot, 'node-b')).toEqual({ status: 'free' });
});
afterEach(() => { resetElanousConfigDir(); for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gate-node-unit-'));
  scratch.push(root);
  const instanceRoot = join(root, 'instance');
  mkdirSync(join(instanceRoot, 'release/1.0.0'), { recursive: true });
  writeFileSync(join(instanceRoot, 'release/1.0.0/release.json'), JSON.stringify({ sourceCommit: BASE }));
  return { root, instanceRoot, ledgerRoot: join(root, 'machine-ledger') };
}
function runOutput(ids: string[]): string {
  return ids.map((id) => {
    const divider = id.indexOf(' > ');
    return `${id.slice(0, divider)}:\n(fail) ${id.slice(divider + 3)} [1.00ms]\n`;
  }).join('') + `\n${ids.length} fail\nRan ${Math.max(1, ids.length)} tests across ${Math.max(1, ids.length)} files.\n`;
}
function fake(cut = [A, B, C], baseline = [A, D], cached = true) {
  const { root, instanceRoot, ledgerRoot } = fixture();
  if (cached) writeFileSync(join(instanceRoot, 'release/1.0.0/gate-failures.json'), JSON.stringify({ commit: BASE, failures: baseline }));
  const calls: string[] = [];
  const runner: GateRunner = {
    async localCommand(cmd, args, cwd) {
      calls.push(`${cmd} ${args.join(' ')} @${cwd}`);
      return { rc: 0, output: '' };
    },
    async command(cmd, args, cwd) {
      calls.push(`${cmd} ${args.join(' ')} @${cwd}`);
      if (cmd === 'sh') return { rc: 0, output: '/home/remote\n' };
      if (cmd === 'git' && args.includes('rev-parse')) return { rc: 0, output: 'true\n' };
      if (cmd === 'git' && args.includes('show-ref')) return { rc: 1, output: '' };
      if (cmd === 'git' && args[0] === 'ls-files' && args[1] === '-z') return { rc: 0, output: `${args.slice(3).join('\0')}\0` };
      if (cmd === 'bun' && args[0] === 'run') {
        const file = args[2]!.replace(/^\.\//, '');
        const ids = cwd.endsWith('/cut') ? (file === 'src/c.test.ts' ? [] : file === 'src/b.test.ts' ? [B] : [A])
          : file === 'src/b.test.ts' ? [] : [A];
        return { rc: ids.length ? 1 : 0, output: runOutput(ids) };
      }
      return { rc: 0, output: '' };
    },
    async sweep(tree, _logDir, _pod, only) {
      calls.push(`sweep @${tree}${only ? ` only=${only.join(',')}` : ''}`);
      const all = tree.endsWith('/cut') ? cut : baseline;
      const ids = only ? all.filter((id) => only.includes(id.split(' > ')[0]!)) : all;
      return { rc: ids.length ? 1 : 0, output: runOutput(ids) };
    },
    async add(tree, sha) { calls.push(`add ${sha} @${tree}`); },
    async remove(tree) { calls.push(`remove @${tree}`); },
    async snapshot(tree, sha) { calls.push(`snapshot ${sha} @${tree}`); },
    async removeSnapshot(tree) { calls.push(`removeSnapshot @${tree}`); },
  };
  return { root, instanceRoot, ledgerRoot, runner, calls };
}
const options = (instanceRoot: string) => ({ commit: CUT, version: '1.0.1', baselineVersion: '1.0.0', instanceRoot, ledgerRoot: join(dirname(instanceRoot), 'machine-ledger') });


test('a multi-file part after a warm one-file part has no source stamp', () => {
  const shell = gateShardShell({ parts: [['src/warm-reference.test.ts'], ['src/a.test.ts', 'src/b.test.ts']],
    cdpPatterns: [], softSeconds: 30, cachePrefix: '', installSlots: 0 });
  const calls = [...shell.matchAll(/(?:WARM_REFERENCE_FILE='[^']*' )?run_part \d+/g)].map((match) => match[0]);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toBe('run_part 1');
  const run = spawnSync('bash', ['-c', `run_part() { if [ -n "$WARM_REFERENCE_FILE" ]; then printf '[warm-worker] file=%s\\n' "$WARM_REFERENCE_FILE"; else printf 'part-no-stamp\\n'; fi; }; ${calls.join('; ')}`], { encoding: 'utf8' });
  expect(run.status).toBe(0);
  expect(run.stdout.trim().split('\n')).toEqual(['[warm-worker] file=src/warm-reference.test.ts', 'part-no-stamp']);
});

test('a real one-file gate shell produces a named Job reference after collection', async () => {
  const { root, runner: fallback } = fake([], []);
  const repo = join(root, 'repo');
  const file = 'src/warm-reference.test.ts';
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  mkdirSync(join(repo, 'apps/pwa'), { recursive: true });
  mkdirSync(join(root, 'working'));
  mkdirSync(join(root, 'bin'));
  mkdirSync(join(root, 'home'));
  expect(spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' }).status).toBe(0);
  symlinkSync(resolve(import.meta.dir, '../test-deterministic.ts'), join(repo, 'scripts/test-deterministic.ts'));
  writeFileSync(join(repo, file), "import { expect, test } from 'bun:test'; test('works', () => expect(1).toBe(1)); test('fails', () => { throw new Error('boom'); });\n");
  writeFileSync(join(root, 'bin/bun'), `#!/bin/sh\nif [ "$1" = install ]; then exit 0; fi\nexec '${process.execPath}' "$@"\n`);
  writeFileSync(join(root, 'bin/timeout'), '#!/bin/sh\n[ "$1" = -k ] && shift 2\nshift\nexec "$@"\n');
  chmodSync(join(root, 'bin/bun'), 0o755);
  chmodSync(join(root, 'bin/timeout'), 0o755);
  let shell = '';
  let shellDiagnostics = '';
  const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: file };
    return fallback.command(cmd, args, cwd);
  }, async (request) => {
    shell = request.command[2]!;
    const run = spawnSync('bash', ['-c', shell], { cwd: join(root, 'working'), encoding: 'utf8',
      timeout: 30_000, env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`, HOME: join(root, 'home') } });
    const artifactsDir = join(root, 'home/outbox');
    shellDiagnostics = `shell rc=${run.status} stderr=${run.stderr} stdout=${run.stdout} error=${run.error ?? ''} install=${existsSync(join(artifactsDir, 'install.log')) ? readFileSync(join(artifactsDir, 'install.log'), 'utf8') : 'missing'} part=${existsSync(join(artifactsDir, 'part-0.log')) ? readFileSync(join(artifactsDir, 'part-0.log'), 'utf8') : 'missing'}`;
    expect(run.status).toBe(0);
    expect(readFileSync(join(artifactsDir, 'part-0.rc'), 'utf8').trim()).toBe('1');
    expect(readFileSync(join(artifactsDir, 'part-0.log'), 'utf8')).toContain(`[warm-worker] file=${file}`);
    expect(readFileSync(join(artifactsDir, 'part-0.log'), 'utf8')).toMatch(/\[warm-worker\] junit-sha256=[0-9a-f]{64}/);
    expect(readFileSync(join(artifactsDir, 'part-0.log'), 'utf8')).toContain('(pass) works');
    expect(readFileSync(join(artifactsDir, 'part-0.log'), 'utf8')).toContain('(fail) fails');
    return { exitCode: 0, artifactsDir, job: 'real-one-file-shell' };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 1, k3dCluster: 'test' }]), () => '');
  const logDir = join(root, 'logs');
  try { await runner.sweep(repo, logDir, { pool: 'pool-test', shards: 1, installSlots: 0 }); }
  catch (error) { throw new Error(`${error}\n${shellDiagnostics}`); }
  expect(shell).toContain("'scripts/test-deterministic.ts'");
  expect(shell).not.toContain("'test:deterministic'");
  const prefix = join(logDir, 'pod-0');
  const meta = JSON.parse(readFileSync(`${prefix}.json`, 'utf8')) as { attemptId: string };
  expect(existsSync(`${prefix}.warm-manifest.json`)).toBe(true);
  expect(warmReferenceFromJobArtifacts(prefix, file, { cutSha: CUT, attemptId: meta.attemptId })).toEqual({
    file, rc: 1, failureIds: [`${file} > fails`], errorIds: [], junitComplete: true,
  });
  // Two real one-file shells produce distinct source attempt stamps. A fresh
  // collector manifest cannot relabel the first Job as the second.
  writeFileSync(join(repo, file), "import { expect, test } from 'bun:test'; test('works', () => expect(1).toBe(1)); test('fails', () => { throw new Error('later'); });\n");
  const laterDir = join(root, 'later-logs');
  const laterHome = join(root, 'later-home');
  const laterWorking = join(root, 'later-working');
  mkdirSync(laterHome);
  mkdirSync(laterWorking);
  const laterRunner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: file };
    return fallback.command(cmd, args, cwd);
  }, async (request) => {
    const run = spawnSync('bash', ['-c', request.command[2]!], { cwd: laterWorking, encoding: 'utf8',
      timeout: 30_000, env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`, HOME: laterHome } });
    const artifactsDir = join(laterHome, 'outbox');
    expect(run.status).toBe(0);
    expect(readFileSync(join(artifactsDir, 'part-0.rc'), 'utf8').trim()).toBe('1');
    return { exitCode: 0, artifactsDir, job: 'later-real-one-file-shell' };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 1, k3dCluster: 'test' }]), () => '');
  await laterRunner.sweep(repo, laterDir, { pool: 'pool-test', shards: 1, installSlots: 0 });
  const laterPrefix = join(laterDir, 'pod-0');
  const laterMeta = JSON.parse(readFileSync(`${laterPrefix}.json`, 'utf8')) as { attemptId: string };
  expect(laterMeta.attemptId).not.toBe(meta.attemptId);
  expect(warmReferenceFromJobArtifacts(laterPrefix, file, { cutSha: CUT, attemptId: laterMeta.attemptId })?.rc).toBe(1);
  copyFileSync(`${prefix}.log`, `${laterPrefix}.log`);
  copyFileSync(`${prefix}.junit.xml`, `${laterPrefix}.junit.xml`);
  expect(writeWarmJobManifest(laterPrefix, file, CUT, laterMeta.attemptId)).toBe(true);
  expect(warmReferenceFromJobArtifacts(laterPrefix, file, { cutSha: CUT, attemptId: laterMeta.attemptId })).toBeNull();
});

test('rehearsal gate invokes executable TUI screen node and refuses a failed screen; regular gate does not invoke it', async () => {
  const f = fake([A], [A]);
  let tuiRuns = 0;
  f.runner.localCommand = async (_cmd, args) => {
    tuiRuns++;
    expect(args.slice(0, 3)).toEqual(['scripts/release-loop/tui-sim-node.ts', '--commit', CUT]);
    return { rc: 1, output: JSON.stringify({ commit: CUT, verdict: 'fail', attempts: 2, checks: [
      { id: 'boot', pass: true, detail: 'booted' }, { id: 'prompt', pass: true, detail: 'prompt' }, { id: 'status-bar', pass: true, detail: 'status' },
      { id: 'help-opens', pass: true, detail: 'help' }, { id: 'help-closes', pass: false, detail: 'stuck' }, { id: 'no-error-text', pass: true, detail: 'clean' },
    ] }) };
  };
  expect(await judgeGate(options(f.instanceRoot), f.runner)).toMatchObject({ outcome: 'ok' });
  expect(tuiRuns).toBe(0);
  expect(await judgeGate({ ...options(f.instanceRoot), rehearsalTui: true }, f.runner)).toMatchObject({
    outcome: 'error', rehearsalTui: { outcome: 'fail', detail: expect.stringContaining('help-closes') },
  });
  expect(tuiRuns).toBe(1);
  f.runner.localCommand = async () => ({ rc: 0, output: 'Usage: --help Dashboard help Commands ❯ ctx 0' });
  expect(await judgeGate({ ...options(f.instanceRoot), rehearsalTui: true }, f.runner)).toMatchObject({
    outcome: 'error', rehearsalTui: { outcome: 'unmeasured' },
  });
});

test('pod counts only listed failing ids separately while still reporting a new unlisted failure', async () => {
  const repo = resolve(import.meta.dir, '../..');
  const listed = (await Bun.file(join(repo, 'test/env-known-failures.json')).json()).tests[0].id as string;
  const { instanceRoot, runner, calls } = fake([listed, B], [listed]);
  const result = await judgeGate({ ...options(instanceRoot), repo, pod: { pool: 'linux' } }, runner);
  expect(result).toMatchObject({ outcome: 'regression', introduced: [B], preexisting: 0, fixed: 0, knownEnv: 1 });
  expect(result.knownEnvCleared).toEqual([]);
  expect(graphGateResult(result, true).summary).toContain('환경 알려진 실패 1');
  expect(calls.filter((call) => call.startsWith('sweep '))).toHaveLength(1);
  expect(calls.some((call) => call.includes(listed.split(' > ')[0]!) && call.includes('test:deterministic'))).toBe(false);
  expect(JSON.parse(readFileSync(join(instanceRoot, 'release/1.0.1/gate-failures.json'), 'utf8')).failures).toEqual([listed, B]);
  expect(JSON.parse(readFileSync(join(dirname(instanceRoot), 'machine-ledger/release/1.0.1/gate-verdict.json'), 'utf8'))).toMatchObject({
    introduced: [B], knownEnv: [listed], preexisting: [], loadFlaky: [],
    baselineReceipt: { valid: false, reason: 'gate was not a complete clean full sweep', commit: CUT },
  });
});

test('pod does not suppress an unlisted regression in the same file as a known failure', async () => {
  const repo = resolve(import.meta.dir, '../..');
  const listed = (await Bun.file(join(repo, 'test/env-known-failures.json')).json()).tests[0].id as string;
  const sibling = `${listed.split(' > ')[0]} > new regression`;
  const { instanceRoot, runner, calls } = fake([listed, sibling], [listed]);
  const isolatedFiles: string[] = [];
  const command = runner.command;
  runner.command = async (cmd, args, cwd) => {
    if (cmd === 'bun' && args[0] === 'run' && args[2] === `./${listed.split(' > ')[0]}`) {
      isolatedFiles.push(cwd);
      return { rc: 1, output: runOutput(cwd.endsWith('/cut') ? [listed, sibling] : [listed]) };
    }
    return command(cmd, args, cwd);
  };
  expect(await judgeGate({ ...options(instanceRoot), repo, pod: { pool: 'linux' } }, runner)).toMatchObject({
    outcome: 'regression', introduced: [sibling], knownEnv: 1, preexisting: 0,
  });
  expect(isolatedFiles).toHaveLength(2);
  expect(calls.filter((call) => call.startsWith('sweep '))).toHaveLength(1);
});

test('pod compares filtered baseline too, reports listed ids cleared, and local never applies the list', async () => {
  const repo = resolve(import.meta.dir, '../..');
  const listed = (await Bun.file(join(repo, 'test/env-known-failures.json')).json()).tests[0].id as string;
  const fixtureRun = fake([B], [listed]);
  const withoutPassEvidence = await judgeGate({ ...options(fixtureRun.instanceRoot), repo, pod: { pool: 'linux' } }, fixtureRun.runner);
  expect(withoutPassEvidence).toMatchObject({ outcome: 'regression', introduced: [B], fixed: 0, knownEnv: 0, knownEnvCleared: [] });
  const sweep = fixtureRun.runner.sweep;
  fixtureRun.runner.sweep = async (tree, logDir, pod) => ({ ...await sweep(tree, logDir, pod), passedIds: [listed] });
  const pod = await judgeGate({ ...options(fixtureRun.instanceRoot), repo, pod: { pool: 'linux' } }, fixtureRun.runner);
  expect(pod).toMatchObject({ outcome: 'regression', introduced: [B], fixed: 0, knownEnv: 0, knownEnvCleared: [listed] });
  expect(pod.knownEnvCleared).toHaveLength(1);
  const local = fake([listed], []);
  const localSweep = local.runner.sweep;
  local.runner.sweep = async (tree, logDir, pod) => ({ ...await localSweep(tree, logDir, pod), passedIds: [listed] });
  const command = local.runner.command;
  local.runner.command = async (cmd, args, cwd) => cmd === 'bun' && args[0] === 'run' && args[2] === `./${listed.split(' > ')[0]}`
    ? { rc: cwd.endsWith('/cut') ? 1 : 0, output: runOutput(cwd.endsWith('/cut') ? [listed] : []) }
    : command(cmd, args, cwd);
  expect(await judgeGate({ ...options(local.instanceRoot), repo }, local.runner)).toMatchObject({
    outcome: 'regression', introduced: [listed], knownEnv: 0, knownEnvCleared: [],
  });
});

test('pod JUnit records only executed passing known ids, not skipped, missing, or failed ids', async () => {
  const { root, instanceRoot, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'test'), { recursive: true });
  const passing = 'src/a.test.ts > passes';
  const skipped = 'src/a.test.ts > skipped';
  const unobserved = 'src/b.test.ts > not run';
  const failing = 'src/a.test.ts > fails';
  writeFileSync(join(repo, 'test/env-known-failures.json'), JSON.stringify({ env: 'linux-pod', measuredAt: '2026-10-01',
    tests: [passing, skipped, unobserved, failing].map((id) => ({ id, reason: 'mac passes' })) }));
  const real = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: 'src/a.test.ts\n' };
    return fixtureRunner.command(cmd, args, cwd);
  }, async (o) => {
    const artifactsDir = join(root, o.name!);
    mkdirSync(artifactsDir);
    writeFileSync(join(artifactsDir, 'shard.log'), 'src/a.test.ts:\n(fail) fails [1.00ms]\n1 pass\n1 fail\nRan 2 tests across 1 file.\n');
    writeFileSync(join(artifactsDir, 'shard.rc'), '1\n');
    writeFileSync(join(artifactsDir, 'junit.xml'), `<testsuites><testsuite name="src/a.test.ts" file="src/a.test.ts">
      <testcase name="passes" file="src/a.test.ts" />
      <testcase name="skipped" file="src/a.test.ts"><skipped /></testcase>
      <testcase name="fails" file="src/a.test.ts"><failure /></testcase>
    </testsuite></testsuites>`);
    return { exitCode: 0, artifactsDir, job: 'fake' };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 1, k3dCluster: 'test' }]));
  fixtureRunner.sweep = real.sweep;
  const result = await judgeGate({ ...options(instanceRoot), repo, pod: { pool: 'pool-test', shards: 1 } }, fixtureRunner);
  expect(result).toMatchObject({ outcome: 'ok', knownEnv: 1, knownEnvCleared: [passing] });
});

test('GATE-WARM-BOOT-SCAN selectionMs: the pod cut sweep times its test selection into the result, the verdict file and one event; a local gate has none', async () => {
  const { root, instanceRoot, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  const real = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    // A slow listing is part of the selection: the timed value must include it.
    if (cmd === 'git' && args[0] === 'ls-files') { await Bun.sleep(40); return { rc: 0, output: 'src/a.test.ts\nsrc/b.test.ts\n' }; }
    return fixtureRunner.command(cmd, args, cwd);
  }, async (o) => {
    const artifactsDir = join(root, o.name!);
    mkdirSync(artifactsDir);
    writeFileSync(join(artifactsDir, 'shard.log'), 'src/a.test.ts:\n(pass) a [1.00ms]\nsrc/b.test.ts:\n(pass) b [1.00ms]\n2 pass\n0 fail\nRan 2 tests across 2 files.\n');
    writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
    return { exitCode: 0, artifactsDir, job: 'fake' };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 1, k3dCluster: 'test' }]));
  fixtureRunner.sweep = real.sweep;
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const spy = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'release-loop.gate') events.push({ event, data: data as Record<string, unknown> });
  });
  let result;
  try { result = await judgeGate({ ...options(instanceRoot), repo, pod: { pool: 'pool-test', shards: 1 } }, fixtureRunner); }
  finally { spy.mockRestore(); }
  expect(result.outcome).toBe('ok');
  expect(typeof result.selectionMs).toBe('number');
  expect(result.selectionMs!).toBeGreaterThanOrEqual(35);
  const timed = events.filter((item) => item.event === 'selection-timed');
  expect(timed.map((item) => item.data)).toEqual([{ ms: result.selectionMs, files: 2 }]);
  const verdict = JSON.parse(readFileSync(join(root, 'machine-ledger/release/1.0.1/gate-verdict.json'), 'utf8'));
  expect(verdict).toMatchObject({ outcome: 'ok', selectionMs: result.selectionMs });
  // Counter-case: a gate whose runner has no pod sweep never invents the field.
  const local = fake([], []);
  const plain = await judgeGate(options(local.instanceRoot), local.runner);
  expect(plain.selectionMs).toBeUndefined();
  expect(JSON.parse(readFileSync(join(local.root, 'machine-ledger/release/1.0.1/gate-verdict.json'), 'utf8')).selectionMs).toBeUndefined();
  // An observer that throws never stops the sweep.
  expect(() => reportSelectionTimed(1, 1, () => { throw new Error('observer'); })).not.toThrow();
});

test('pod rejects malformed known-failure list instead of reporting a clean gate; local ignores it', async () => {
  const { root, instanceRoot, runner } = fake([], []);
  mkdirSync(join(root, 'repo/test'), { recursive: true });
  writeFileSync(join(root, 'repo/test/env-known-failures.json'), '{not json');
  const pod = await judgeGate({ ...options(instanceRoot), repo: join(root, 'repo'), pod: { pool: 'linux' } }, runner);
  expect(pod).toMatchObject({ outcome: 'error', error: expect.stringContaining('invalid environment known failures') });
  expect(await judgeGate({ ...options(instanceRoot), repo: join(root, 'repo') }, runner)).toMatchObject({ outcome: 'ok', knownEnv: 0 });
});

test('cut A/B/C versus baseline A/D reruns B and C; only reproduced B is introduced', async () => {
  const { root, instanceRoot, runner, calls } = fake();
  const result = await judgeGate(options(instanceRoot), runner);
  expect(result).toMatchObject({ outcome: 'regression', commit: CUT, introduced: [B], fixed: 1, preexisting: 1 });
  expect(calls.filter((c) => c.startsWith(`add ${BASE}`))).toHaveLength(0);
  expect(calls.filter((c) => c.startsWith('git '))).toHaveLength(0);
  expect(calls.filter((c) => c.startsWith(`snapshot ${BASE}`))).toHaveLength(1);
  expect(calls.some((c) => c.includes('src/b.test.ts @') && c.includes('/cut'))).toBe(true);
  expect(calls.some((c) => c.includes('src/c.test.ts @') && c.includes('/baseline'))).toBe(false);
  expect(calls.filter((c) => c.startsWith('sweep '))).toHaveLength(1);
  const shadowFiles = readdirSync(join(root, 'machine-ledger/release/1.0.1')).filter((name) => name.startsWith('gate-radius-shadow-'));
  expect(shadowFiles).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(root, 'machine-ledger/release/1.0.1', shadowFiles[0]!), 'utf8')))
    .toMatchObject({ plan: { proposed: 'full', forCommit: CUT }, actual: { commit: CUT, outcome: 'regression', fullSweep: true, introduced: [B] } });
  expect(calls.filter((c) => c.startsWith('bun install '))).toHaveLength(4);
  const path = join(instanceRoot, 'release/1.0.1/gate-failures.json');
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ commit: CUT, failures: [A, B, C] });
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(join(root, 'machine-ledger/release/1.0.1/gate-failures.json'), 'utf8'))).toEqual({ commit: CUT, failures: [A, B, C] });
  expect(existsSync(join(root, 'release/1.0.1/gate-failures.json'))).toBe(false);
  expect(calls.filter((c) => c.startsWith('remove '))).toHaveLength(1);
  expect(calls.filter((c) => c.startsWith('removeSnapshot '))).toHaveLength(1);
});

test('judged identities persist in the machine ledger and a re-gate replaces the prior commit verdict', async () => {
  const { root, instanceRoot, runner } = fake([A, B], [A]);
  const path = join(root, 'machine-ledger/release/1.0.1/gate-verdict.json');
  const events: unknown[] = [];
  const observation = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'release-loop.gate' && event === 'judged') events.push(data);
  });
  try {
    expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'regression', introduced: [B], preexisting: 1 });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      version: '1.0.1', commit: CUT, outcome: 'regression', introduced: [B], knownEnv: [], preexisting: [A], loadFlaky: [],
      baselineReceipt: expect.objectContaining({ valid: false, commit: CUT, reason: 'gate was not a complete clean full sweep' }),
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(events).toContainEqual(expect.objectContaining({
      introduced: 1, preexisting: 1, knownEnv: 0, loadFlaky: 0,
      introducedIds: [B], knownEnvIds: [], preexistingIds: [A], loadFlakyIds: [],
    }));

    runner.sweep = async () => ({ rc: 1, output: runOutput([A]) });
    const nextCommit = 'c'.repeat(40);
    expect(await judgeGate({ ...options(instanceRoot), commit: nextCommit }, runner)).toMatchObject({ outcome: 'ok', introduced: [], preexisting: 1 });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      version: '1.0.1', commit: nextCommit, outcome: 'ok', introduced: [], knownEnv: [], preexisting: [A], loadFlaky: [],
      baselineReceipt: expect.objectContaining({ valid: false, commit: nextCommit }),
    });
    expect(events.at(-1)).toEqual(expect.objectContaining({ commit: nextCommit, introduced: 0, preexisting: 1, introducedIds: [], preexistingIds: [A] }));
  } finally { observation.mockRestore(); }
});

test('second verdict-root write failure records the current error verdict and identities in the first root', async () => {
  const { root, instanceRoot, ledgerRoot, runner } = fake([A, B], [A]);
  const instanceVerdict = join(instanceRoot, 'release/1.0.1/gate-verdict.json');
  const ledgerVerdict = join(ledgerRoot, 'release/1.0.1/gate-verdict.json');
  mkdirSync(dirname(instanceVerdict), { recursive: true });
  mkdirSync(dirname(ledgerVerdict), { recursive: true });
  writeFileSync(instanceVerdict, JSON.stringify({ version: '1.0.1', commit: 'c'.repeat(40), outcome: 'ok', introduced: [], knownEnv: [], preexisting: [], loadFlaky: [] }));
  writeFileSync(ledgerVerdict, JSON.stringify({ version: '1.0.1', commit: 'c'.repeat(40), outcome: 'ok', introduced: [], knownEnv: [], preexisting: [], loadFlaky: [] }));
  const fs = await import('node:fs');
  const realRename = fs.renameSync;
  const judgedEvents: unknown[] = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'release-loop.gate' && event === 'judged') judgedEvents.push(data);
  });
  const rename = spyOn(fs, 'renameSync').mockImplementation((oldPath, newPath) => {
    if (String(newPath) === instanceVerdict) throw new Error('second root write failed');
    return realRename(oldPath, newPath);
  });
  try {
    const result = await judgeGate(options(instanceRoot), runner);
    expect(result).toMatchObject({ outcome: 'error', error: expect.stringContaining('second root write failed') });
    expect(JSON.parse(readFileSync(ledgerVerdict, 'utf8'))).toEqual({
      version: '1.0.1', commit: CUT, outcome: 'error', introduced: [B], knownEnv: [], preexisting: [A], loadFlaky: [],
      baselineReceipt: expect.objectContaining({ valid: false, commit: CUT, reason: 'gate was not a complete clean full sweep' }),
    });
    expect(judgedEvents).toContainEqual(expect.objectContaining({
      commit: CUT, outcome: 'error', introducedIds: [B], preexistingIds: [A],
    }));
  } finally { rename.mockRestore(); log.mockRestore(); }
});

test('unreadable existing verdict returns an error GateResult', async () => {
  const { instanceRoot, ledgerRoot, runner } = fake([A, B], [A]);
  const path = join(ledgerRoot, 'release/1.0.1/gate-verdict.json');
  const events: unknown[] = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'release-loop.gate' && event === 'judged') events.push(data);
  });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'not readable by permissions');
  const fs = await import('node:fs');
  const realRead = fs.readFileSync;
  const read = spyOn(fs, 'readFileSync').mockImplementation(((file: unknown, ...args: unknown[]) => {
    if (String(file) === path) throw new Error('verdict read failed');
    return (realRead as (...parameters: unknown[]) => unknown)(file, ...args);
  }) as typeof fs.readFileSync);
  try {
    expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({
      outcome: 'error', error: expect.stringContaining('verdict read failed'),
    });
    expect(events).toContainEqual(expect.objectContaining({ outcome: 'error', introducedIds: [B], preexistingIds: [A] }));
  } finally { read.mockRestore(); log.mockRestore(); }
});

test('machine ledger baseline is reused across empty worktree universes; stale commit is swept', async () => {
  const { instanceRoot, ledgerRoot, runner, calls } = fake([A], [A], false);
  const previous = join(ledgerRoot, 'release/0.2.3');
  mkdirSync(previous, { recursive: true });
  writeFileSync(join(previous, 'release.json'), JSON.stringify({ sourceCommit: BASE }));
  const cached = join(previous, 'gate-failures.json');
  writeFileSync(cached, JSON.stringify({ commit: BASE, failures: [A] }));
  const opts = { ...options(instanceRoot), ledgerRoot, version: '0.2.4', baselineVersion: '0.2.3' };
  const observations: Array<{ category: string; event: string; data: unknown }> = [];
  const observation = spyOn(debug, 'log').mockImplementation((category, event, data) => { observations.push({ category, event, data }); });
  try {
    expect(await judgeGate(opts, runner)).toMatchObject({ outcome: 'ok', baselineSource: 'ledger', preexisting: 1 });
    expect(calls.filter((c) => c.includes('/baseline') && c.startsWith('sweep '))).toHaveLength(0);
    expect(observations).toContainEqual({ category: 'release-loop.gate', event: 'baseline', data: { version: '0.2.3', source: 'ledger', commit: BASE } });
    for (const location of [ledgerRoot, instanceRoot]) {
      const path = join(location, 'release/0.2.4/gate-failures.json');
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ commit: CUT, failures: [A] });
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    calls.length = 0;
    writeFileSync(cached, JSON.stringify({ commit: 'c'.repeat(40), failures: [A] }));
    expect(await judgeGate(opts, runner)).toMatchObject({ outcome: 'ok', baselineSource: 'swept' });
    expect(calls.filter((c) => c.includes('/baseline') && c.startsWith('sweep '))).toHaveLength(1);
  } finally { observation.mockRestore(); }
});

test('complete previous cut logs replace a missing baseline cache without a baseline sweep', async () => {
  const { instanceRoot, ledgerRoot, runner, calls } = fake([A], [A, D], false);
  const dir = join(ledgerRoot, 'release/1.0.0/gate-logs/cut');
  mkdirSync(dir, { recursive: true });
  for (const [index, id] of [A, D].entries()) {
    writeFileSync(join(dir, `pod-${index}.json`), JSON.stringify({ shardCount: 2, rc: 1, files: [id.split(' > ')[0]], commit: BASE }));
    writeFileSync(join(dir, `pod-${index}.log`), runOutput([id]));
    writeFileSync(join(dir, `pod-${index}.junit.xml`), `<testsuite file="${id.split(' > ')[0]}"/>`);
  }
  const observations: unknown[] = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'release-loop.gate' && event === 'baseline') observations.push(data);
  });
  try {
    expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'ok', baselineSource: 'cut-logs', fixed: 1 });
    expect(calls.filter((call) => call.startsWith('sweep '))).toHaveLength(1);
    expect(observations).toContainEqual({ version: '1.0.0', source: 'cut-logs', commit: BASE });
    calls.length = 0;
    writeFileSync(join(instanceRoot, 'release/1.0.0/gate-failures.json'), JSON.stringify({ commit: BASE, failures: [A] }));
    expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ baselineSource: 'instance', fixed: 0 });
    expect(calls.filter((call) => call.startsWith('sweep '))).toHaveLength(1);
  } finally { log.mockRestore(); }
});

test('ledger cache wins over cut logs even when the cut log is unreadable', async () => {
  const { instanceRoot, ledgerRoot, runner, calls } = fake([A], [A], false);
  const cached = join(ledgerRoot, 'release/1.0.0/gate-failures.json');
  mkdirSync(dirname(cached), { recursive: true });
  writeFileSync(cached, JSON.stringify({ commit: BASE, failures: [A] }));
  const dir = join(ledgerRoot, 'release/1.0.0/gate-logs/cut');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pod-0.json'), '{invalid');
  writeFileSync(join(dir, 'pod-0.log'), runOutput([B]));
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'ok', baselineSource: 'ledger' });
  expect(calls.filter((call) => call.startsWith('sweep '))).toHaveLength(1);
});

test('untrustworthy previous cut logs fall back to sweeping the requested commit', async () => {
  const { instanceRoot, ledgerRoot, runner, calls } = fake([A], [A], false);
  const dir = join(ledgerRoot, 'release/1.0.0/gate-logs/cut');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'pod-0.json');
  const metadata = { shardCount: 1, rc: 1, files: ['src/a.test.ts'], commit: BASE };
  writeFileSync(join(dir, 'pod-0.log'), runOutput([A]));
  writeFileSync(join(dir, 'pod-0.junit.xml'), '<testsuite file="src/a.test.ts"/>');
  for (const variant of ['corrupt', 'stale', 'unknown', 'no-junit'] as const) {
    writeFileSync(path, variant === 'corrupt' ? '{invalid' : JSON.stringify({ ...metadata, commit: variant === 'stale' ? 'c'.repeat(40) : variant === 'unknown' ? undefined : BASE }));
    if (variant === 'no-junit') rmSync(join(dir, 'pod-0.junit.xml'));
    calls.length = 0;
    const result = await judgeGate({ ...options(instanceRoot), baselineCommit: BASE }, runner);
    expect(result).toMatchObject({ outcome: 'ok', baselineSource: 'swept', preexisting: 1 });
    expect(calls.filter((call) => call.startsWith('sweep '))).toHaveLength(2);
  }
});

test('a prior shard with rc 1 but no named failures or errors falls back to the baseline sweep', async () => {
  const { instanceRoot, ledgerRoot, runner, calls } = fake([], [], false);
  const dir = join(ledgerRoot, 'release/1.0.0/gate-logs/cut');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pod-0.json'), JSON.stringify({ shardCount: 1, rc: 1, files: ['src/a.test.ts'], commit: BASE }));
  writeFileSync(join(dir, 'pod-0.log'), '1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.\n');
  writeFileSync(join(dir, 'pod-0.junit.xml'), '<testsuite file="src/a.test.ts"/>');
  // GATE-SPEED A4 — the swept fallback runs only the cut's failing files; a clean cut needs no baseline sweep.
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'ok', baselineSource: 'swept', baselineDeferred: { cutFiles: 0, swept: 0 } });
  expect(calls.filter((call) => call.startsWith('sweep '))).toHaveLength(1);
});

test('missing root shard in previous cut logs falls back to the baseline sweep', async () => {
  const { instanceRoot, ledgerRoot, runner, calls } = fake([A], [A], false);
  const dir = join(ledgerRoot, 'release/1.0.0/gate-logs/cut');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pod-0.json'), JSON.stringify({ shardCount: 2, rc: 1, files: ['src/a.test.ts'] }));
  writeFileSync(join(dir, 'pod-0.log'), runOutput([A]));
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ baselineSource: 'swept' });
  expect(calls.filter((call) => call.startsWith('sweep '))).toHaveLength(2);
});

test('unreadable previous cut log and extra root shard each fall back to the baseline sweep', async () => {
  const { instanceRoot, ledgerRoot, runner, calls } = fake([A], [A], false);
  const dir = join(ledgerRoot, 'release/1.0.0/gate-logs/cut');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pod-0.json'), JSON.stringify({ shardCount: 1, rc: 1, files: ['src/a.test.ts'], commit: BASE }));
  const log = join(dir, 'pod-0.log');
  writeFileSync(log, runOutput([A]));
  writeFileSync(join(dir, 'pod-0.junit.xml'), '<testsuite file="src/a.test.ts"/>');
  rmSync(log);
  mkdirSync(log);
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'ok', baselineSource: 'swept' });
  expect(calls.filter((call) => call.startsWith('sweep '))).toHaveLength(2);
  rmSync(log, { recursive: true });
  writeFileSync(log, runOutput([A]));
  writeFileSync(join(dir, 'pod-1.json'), JSON.stringify({ shardCount: 1, rc: 0, files: ['src/b.test.ts'], commit: BASE }));
  writeFileSync(join(dir, 'pod-1.log'), '1 pass\n0 fail\nRan 1 test across 1 file.\n');
  const report = join(dir, 'pod-1.junit.xml');
  writeFileSync(report, '<testsuite file="src/b.test.ts"/>');
  calls.length = 0;
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'ok', baselineSource: 'swept' });
  expect(calls.filter((call) => call.startsWith('sweep '))).toHaveLength(2);
  rmSync(join(dir, 'pod-1.json'));
  rmSync(join(dir, 'pod-1.log'));
  rmSync(report);
  rmSync(join(dir, 'pod-0.junit.xml'));
  mkdirSync(join(dir, 'pod-0.junit.xml'));
  calls.length = 0;
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'ok', baselineSource: 'swept' });
  expect(calls.filter((call) => call.startsWith('sweep '))).toHaveLength(2);
});

test('missing previous cut log folder falls back to the baseline sweep', async () => {
  const { instanceRoot, runner, calls } = fake([A], [A], false);
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'ok', baselineSource: 'swept' });
  expect(calls.filter((call) => call.startsWith('sweep '))).toHaveLength(2);
});

test('completed cut is persisted when the baseline sweep fails', async () => {
  const { instanceRoot, ledgerRoot, runner, calls } = fake([A, B], [A], false);
  const sweep = runner.sweep;
  runner.sweep = async (tree, logDir) => tree.endsWith('/baseline')
    ? (() => { throw new Error('baseline unavailable'); })()
    : sweep(tree, logDir);
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'error', baselineSource: 'swept', error: 'baseline unavailable' });
  for (const root of [instanceRoot, ledgerRoot]) {
    expect(JSON.parse(readFileSync(join(root, 'release/1.0.1/gate-failures.json'), 'utf8'))).toEqual({ commit: CUT, failures: [A, B] });
  }
  expect(calls.filter((call) => call.startsWith('sweep '))).toHaveLength(1);
});

test('instance fallback uses the instance manifest and cache when machine ledger is missing', async () => {
  const { root, instanceRoot, runner, calls } = fake([A], [A]);
  const result = await judgeGate({ ...options(instanceRoot), ledgerRoot: join(root, 'empty-ledger') }, runner);
  expect(result).toMatchObject({ outcome: 'ok', baselineSource: 'instance' });
  expect(calls.filter((c) => c.startsWith('sweep '))).toHaveLength(1);
});

test('stale ledger cache falls back to a matching instance cache for an explicit baseline commit', async () => {
  const { instanceRoot, ledgerRoot, runner, calls } = fake([A], [A]);
  const stale = join(ledgerRoot, 'release/1.0.0/gate-failures.json');
  mkdirSync(dirname(stale), { recursive: true });
  writeFileSync(stale, JSON.stringify({ commit: 'c'.repeat(40), failures: [B] }));
  expect(await judgeGate({ ...options(instanceRoot), baselineCommit: BASE }, runner)).toMatchObject({ outcome: 'ok', baselineSource: 'instance', preexisting: 1 });
  expect(calls.filter((c) => c.startsWith('sweep '))).toHaveLength(1);
  expect(calls.filter((c) => c.startsWith(`snapshot ${BASE}`))).toHaveLength(0);
});

test('an explicit config directory confines the release ledger even with a distinct injected ledger root', async () => {
  const { root, instanceRoot, runner } = fake([A], [A]);
  setElanousConfigDir(instanceRoot);
  expect(releaseLedgerRoot()).toBe(instanceRoot);
  const other = join(root, 'outside-ledger');
  expect(await judgeGate({ ...options(instanceRoot), ledgerRoot: other }, runner)).toMatchObject({ outcome: 'ok', baselineSource: 'instance' });
  expect(existsSync(join(other, 'release/1.0.1/gate-failures.json'))).toBe(false);
  expect(await judgeGate({ ...options(other), ledgerRoot: other }, runner)).toMatchObject({ outcome: 'ok', baselineSource: 'instance' });
  expect(existsSync(join(other, 'release/1.0.1/gate-failures.json'))).toBe(false);
  resetElanousConfigDir();
  expect(releaseLedgerRoot()).toBe(prodInstanceRoot());
});

test('cached baseline avoids a baseline sweep even when an isolated comparison is necessary', async () => {
  const { instanceRoot, runner, calls } = fake();
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'regression', introduced: [B] });
  expect(calls.filter((call) => call.startsWith('sweep '))).toHaveLength(1);
  expect(calls.filter((call) => call.startsWith(`add ${BASE}`))).toHaveLength(0);
  expect(calls.filter((call) => call.startsWith(`snapshot ${BASE}`))).toHaveLength(1);
});

test('cached baseline avoids baseline worktree entirely when cut has no new failures', async () => {
  const { instanceRoot, runner, calls } = fake([A], [A, D]);
  const result = await judgeGate(options(instanceRoot), runner);
  expect(result).toMatchObject({ outcome: 'ok', introduced: [], fixed: 1, preexisting: 1 });
  expect(calls.filter((c) => c.startsWith('add '))).toHaveLength(1);
  expect(calls.filter((c) => c.startsWith('sweep '))).toHaveLength(1);
});

test('remote command transport starts in /tmp, not the caller checkout', async () => {
  const { root } = fixture();
  const repo = join(root, 'caller-repo');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const record = join(root, 'ssh-args.json');
  const shim = join(bin, 'ssh');
  writeFileSync(shim, `#!/usr/bin/env bun\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n`);
  chmodSync(shim, 0o700);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ''}`;
  try {
    expect((await createGateRunner(repo, 'test-host').command('mktemp', ['-d', '/tmp/release-gate-XXXXXXXX'], '/tmp')).rc).toBe(0);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
  const call = JSON.parse(readFileSync(record, 'utf8')) as { argv: string[]; cwd: string };
  expect(call.argv).toEqual(['test-host', "PATH=$HOME/.bun/bin:/opt/homebrew/bin:$PATH; export PATH; cd '/tmp' && 'mktemp' '-d' '/tmp/release-gate-XXXXXXXX'"]);
  // macOS resolves the /tmp symlink, so the child reports /private/tmp; Linux reports /tmp. Same directory either way.
  expect(['/tmp', '/private/tmp']).toContain(call.cwd);
  expect(realpathSync(call.cwd)).toBe(realpathSync('/tmp'));
  expect(call.cwd).not.toBe(repo);
});

test('remote gate keeps the cut and cached baseline on the same host and cleans both', async () => {
  const { instanceRoot, runner, calls } = fake();
  const sweep = runner.sweep;
  const logDirs: string[] = [];
  runner.sweep = async (tree, logDir) => {
    logDirs.push(logDir!);
    return sweep(tree, logDir);
  };
  const command = runner.command;
  runner.command = async (cmd, args, cwd) => cmd === 'mktemp'
    ? { rc: 0, output: '/tmp/release-gate-remote123\n' }
    : command(cmd, args, cwd);
  expect(await judgeGate({ ...options(instanceRoot), remote: 'test-host' }, runner)).toMatchObject({ outcome: 'regression', introduced: [B] });
  expect(calls.filter((call) => call.startsWith(`add ${BASE}`))).toHaveLength(0);
  expect(calls.filter((call) => call.startsWith('sweep '))).toHaveLength(1);
  expect(logDirs).toEqual([join(instanceRoot, 'release/1.0.1/gate-logs/cut')]);
  expect(calls.some((call) => call.startsWith(`snapshot ${BASE} @/tmp/release-gate-remote123/baseline`))).toBe(true);
  expect(calls.some((call) => call.startsWith('removeSnapshot @/tmp/release-gate-remote123/baseline'))).toBe(true);
  expect(calls).toContain('add ' + CUT + ' @/tmp/release-gate-remote123/cut');
  for (const commit of [CUT, BASE]) {
    expect(calls).toContain(`git push test-host:/home/remote/mirror/elanous-agent.git ${commit}:refs/elanous/gate/${commit} @${process.cwd()}`);
  }
  expect(calls).toContain('rm -rf -- /tmp/release-gate-remote123 @/tmp');
  expect(calls.filter((call) => call.endsWith(`@${process.cwd()}`)).every((call) => call.startsWith('git push '))).toBe(true);
});

test('remote mktemp path is recovered when ssh prints a warning after stdout', async () => {
  const { instanceRoot, runner, calls } = fake([A], [A]);
  const original = runner.command;
  runner.command = async (cmd, args, cwd) => cmd === 'mktemp'
    ? { rc: 0, output: '/tmp/release-gate-warning123\n\nWarning: Permanently added host key\n' }
    : original(cmd, args, cwd);
  expect(await judgeGate({ ...options(instanceRoot), remote: 'test-host' }, runner)).toMatchObject({ outcome: 'ok' });
  expect(calls).toContain('rm -rf -- /tmp/release-gate-warning123 @/tmp');
});

test('remote push failure returns error before creating temporary trees', async () => {
  const { instanceRoot, runner, calls } = fake();
  runner.localCommand = async (cmd, args, cwd) => {
    calls.push(`${cmd} ${args.join(' ')} @${cwd}`);
    return { rc: 128, output: 'commit unavailable' };
  };
  const result = await judgeGate({ ...options(instanceRoot), remote: 'test-host' }, runner);
  expect(result).toMatchObject({ outcome: 'error', error: expect.stringContaining(`remote push ${CUT} failed (rc=128): commit unavailable`) });
  expect(calls.some((call) => call.startsWith('mktemp ') || call.startsWith('sweep '))).toBe(false);
});

test('an existing non-bare remote mirror is rejected without pushing', async () => {
  const { instanceRoot, runner, calls } = fake();
  const command = runner.command;
  runner.command = async (cmd, args, cwd) => cmd === 'git' && args.includes('rev-parse')
    ? { rc: 0, output: 'false\n' }
    : command(cmd, args, cwd);
  expect(await judgeGate({ ...options(instanceRoot), remote: 'test-host' }, runner)).toMatchObject({
    outcome: 'error', error: 'remote mirror is not bare',
  });
  expect(calls.some((call) => call.startsWith('git push ') || call.startsWith('mktemp '))).toBe(false);
});

test('remote checkout failure cleans up without starting a sweep', async () => {
  const { root, instanceRoot } = fixture();
  const calls: string[] = [];
  const runner = createGateRunner(root, 'test-host', async (cmd, args, cwd) => {
    calls.push(`${cmd} ${args.join(' ')} @${cwd}`);
    if (cmd === 'mktemp') return { rc: 0, output: '/tmp/release-gate-prepfailed\n' };
    if (cmd === 'git' && args.includes('rev-parse')) return { rc: 0, output: 'true\n' };
    if (cmd === 'git' && args.includes('show-ref')) return { rc: 0, output: '' };
    if (cmd === 'git' && args.includes('checkout')) return { rc: 128, output: 'unavailable' };
    return { rc: 0, output: '' };
  });
  expect(await judgeGate({ ...options(instanceRoot), remote: 'test-host', remoteMirror: '/mirror.git' }, runner)).toMatchObject({
    outcome: 'error', error: expect.stringContaining('remote tree checkout failed (rc=128): unavailable'),
  });
  expect(calls).toContain('rm -rf -- /tmp/release-gate-prepfailed @/tmp');
  expect(calls.some((call) => call.startsWith('sweep ') || call.startsWith('bun '))).toBe(false);
});

test('remote runner uses only the temporary checkout for git operations', async () => {
  const { root, instanceRoot } = fixture();
  const repo = join(root, 'caller-only-repo');
  mkdirSync(repo);
  expect(spawnSync('git', ['init', '-q', repo]).status).toBe(0);
  const calls: string[] = [];
  const mirror = '/remote/mirror.git';
  const runner = createGateRunner(repo, 'test-host', async (cmd, args, cwd) => {
    calls.push(`${cmd} ${args.join(' ')} @${cwd}`);
    if (cmd === 'mktemp') return { rc: 0, output: '/tmp/release-gate-isolated\n' };
    if (cmd === 'git' && args.includes('show-ref')) return { rc: 1, output: '' };
    if (cmd === 'git' && args.includes('rev-parse')) return { rc: 0, output: 'true\n' };
    if (cmd === 'bun' && args[0] === 'run') {
      const failures = cwd.endsWith('/cut') ? [B] : [];
      return { rc: failures.length ? 1 : 0, output: runOutput(failures) };
    }
    return { rc: 0, output: '' };
  });
  runner.localCommand = async (cmd, args, cwd) => {
    calls.push(`${cmd} ${args.join(' ')} @${cwd}`);
    return { rc: 0, output: '' };
  };
  // A failing cut file makes the gate open the baseline checkout (GATE-SPEED A4 skips it for a clean cut).
  runner.sweep = async (tree) => ({ rc: tree.endsWith('/cut') ? 1 : 0, output: runOutput(tree.endsWith('/cut') ? [B] : []) });
  expect(await judgeGate({ ...options(instanceRoot), remote: 'test-host', remoteMirror: mirror, repo, baselineCommit: BASE }, runner)).toMatchObject({ outcome: 'regression', introduced: [B] });
  expect(calls).toContain(`git clone --no-checkout ${mirror} /tmp/release-gate-isolated/cut @/tmp/release-gate-isolated`);
  expect(calls).toContain(`git clone --no-checkout ${mirror} /tmp/release-gate-isolated/baseline @/tmp/release-gate-isolated`);
  for (const commit of [CUT, BASE]) expect(calls).toContain(`git push test-host:${mirror} ${commit}:refs/elanous/gate/${commit} @${repo}`);
  expect(calls).toContain('rm -rf -- /tmp/release-gate-isolated @/tmp');
  expect(calls.filter((call) => call.endsWith(`@${repo}`)).every((call) => call.startsWith('git push '))).toBe(true);
  calls.length = 0;
  // The first gate cached B's isolated baseline result; drop it so this gate opens the baseline snapshot again.
  rmSync(join(dirname(instanceRoot), 'machine-ledger', 'gate-baseline-cache'), { recursive: true, force: true });
  writeFileSync(join(instanceRoot, 'release/1.0.0/gate-failures.json'), JSON.stringify({ commit: BASE, failures: [A] }));
  runner.sweep = async () => ({ rc: 1, output: runOutput([A, B]) });
  expect(await judgeGate({ ...options(instanceRoot), remote: 'test-host', remoteMirror: mirror, repo, baselineCommit: BASE }, runner)).toMatchObject({ outcome: 'regression' });
  expect(calls).toContain(`git clone --no-checkout ${mirror} /tmp/release-gate-isolated/baseline @/tmp/release-gate-isolated`);
  expect(calls.every((call) => !call.includes(`--shared --no-checkout ${repo}`))).toBe(true);
});

test('remote preparation uses a bare mirror without the caller checkout on the remote', async () => {
  const { root, instanceRoot } = fixture();
  const origin = join(root, 'origin');
  const caller = join(root, 'caller');
  mkdirSync(origin);
  const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: join(root, 'gitconfig') } });
  expect(git(origin, 'init', '-q').status).toBe(0);
  writeFileSync(join(origin, 'tracked.txt'), 'baseline');
  expect(git(origin, 'add', 'tracked.txt').status).toBe(0);
  expect(git(origin, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'baseline').status).toBe(0);
  const baseline = git(origin, 'rev-parse', 'HEAD').stdout.trim();
  writeFileSync(join(origin, 'tracked.txt'), 'cut');
  expect(git(origin, 'add', 'tracked.txt').status).toBe(0);
  expect(git(origin, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'cut').status).toBe(0);
  const cut = git(origin, 'rev-parse', 'HEAD').stdout.trim();
  expect(git(root, 'clone', '-q', '--no-checkout', origin, caller).status).toBe(0);
  expect(git(caller, 'config', '--local', 'core.hooksPath', '/dev/null').status).toBe(0);
  expect(git(caller, 'remote', 'set-url', 'origin', 'https://example.invalid/unavailable.git').status).toBe(0);
  // The remote is always a Linux host whose work dir is `/tmp/release-gate-*` (the code refuses anything else) — mirror
  // that literally; `tmpdir()` is `/var/folders/…` on macOS and made this test red on mbp only.
  const remoteWork = mkdtempSync('/tmp/release-gate-');
  scratch.push(remoteWork);
  const mirror = join(root, 'mirror.git');
  const calls: string[] = [];
  const runner = createGateRunner(caller, 'test-host', async (cmd, args, cwd) => {
    calls.push(`${cmd} ${args.join(' ')} @${cwd}`);
    if (cmd === 'mktemp') return { rc: 0, output: `${remoteWork}\n` };
    if (cmd === 'bun' && args[0] === 'run') {
      const failures = cwd.endsWith('/cut') ? [B] : [];
      return { rc: failures.length ? 1 : 0, output: runOutput(failures) };
    }
    if (cmd === 'bun') return { rc: 0, output: '' };
    if (cmd === 'rm') {
      rmSync(args.at(-1)!, { recursive: true, force: true });
      return { rc: 0, output: '' };
    }
    const run = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
    return { rc: run.status ?? 2, output: `${run.stdout ?? ''}\n${run.stderr ?? ''}` };
  });
  runner.localCommand = async (cmd, args, cwd) => {
    calls.push(`${cmd} ${args.join(' ')} @${cwd}`);
    const run = spawnSync(cmd, ['-c', 'core.hooksPath=/dev/null', 'push', mirror, ...args.slice(2)], { cwd, encoding: 'utf8' });
    return { rc: run.status ?? 2, output: `${run.stdout ?? ''}\n${run.stderr ?? ''}` };
  };
  runner.sweep = async (tree) => {
    expect(readFileSync(join(tree, 'tracked.txt'), 'utf8')).toBe(tree.endsWith('/cut') ? 'cut' : 'baseline');
    expect(git(tree, 'rev-parse', 'HEAD').stdout.trim()).toBe(tree.endsWith('/cut') ? cut : baseline);
    return { rc: tree.endsWith('/cut') ? 1 : 0, output: runOutput(tree.endsWith('/cut') ? [B] : []) };
  };
  expect(await judgeGate({ ...options(instanceRoot), commit: cut, baselineCommit: baseline, repo: caller, remote: 'test-host', remoteMirror: mirror }, runner)).toMatchObject({ outcome: 'regression', introduced: [B] });
  for (const commit of [cut, baseline]) expect(calls).toContain(`git push test-host:${mirror} ${commit}:refs/elanous/gate/${commit} @${caller}`);
  expect(calls).toContain(`git clone --no-checkout ${mirror} ${remoteWork}/cut @${remoteWork}`);
  expect(calls).toContain(`git -C ${remoteWork}/cut fetch origin refs/elanous/gate/${cut} @${remoteWork}`);
  expect(calls).toContain(`git -C ${remoteWork}/cut checkout --detach ${cut} @${remoteWork}`);
  expect(calls).toContain(`git clone --no-checkout ${mirror} ${remoteWork}/baseline @${remoteWork}`);
  expect(calls).toContain(`git -C ${remoteWork}/baseline fetch origin refs/elanous/gate/${baseline} @${remoteWork}`);
  expect(calls).toContain(`git -C ${remoteWork}/baseline checkout --detach ${baseline} @${remoteWork}`);
  expect(calls.filter((call) => call.endsWith(`@${caller}`)).every((call) => call.startsWith('git push '))).toBe(true);
  expect(git(mirror, 'for-each-ref', '--format=%(refname)').stdout.trim().split('\n').sort()).toEqual(
    [cut, baseline].map((commit) => `refs/elanous/gate/${commit}`).sort(),
  );
  expect(existsSync(remoteWork)).toBe(false);
  calls.length = 0;
  mkdirSync(remoteWork);
  runner.sweep = async () => { throw new Error('remote sweep stopped'); };
  expect(await judgeGate({ ...options(instanceRoot), commit: cut, baselineCommit: baseline, repo: caller, remote: 'test-host', remoteMirror: mirror }, runner)).toMatchObject({
    outcome: 'error', error: 'remote sweep stopped',
  });
  expect(existsSync(remoteWork)).toBe(false);
  expect(calls.some((call) => call.startsWith('git push '))).toBe(false);
  mkdirSync(remoteWork);
  rmSync(join(dirname(instanceRoot), 'machine-ledger', 'gate-baseline-cache'), { recursive: true, force: true });
  writeFileSync(join(instanceRoot, 'release/1.0.0/gate-failures.json'), JSON.stringify({ commit: baseline, failures: [A] }));
  runner.sweep = async (tree) => ({ rc: 1, output: runOutput(tree.endsWith('/cut') ? [A, B] : [A]) });
  expect(await judgeGate({ ...options(instanceRoot), commit: cut, baselineCommit: baseline, repo: caller, remote: 'test-host', remoteMirror: mirror }, runner)).toMatchObject({ outcome: 'regression', introduced: [B] });
  expect(calls).toContain(`git clone --no-checkout ${mirror} ${remoteWork}/baseline @${remoteWork}`);
  expect(existsSync(remoteWork)).toBe(false);
  expect(existsSync(caller)).toBe(true);
});

test('real SSH transport pushes to a bare mirror without the caller path or GitHub credentials', async () => {
  const { root, instanceRoot } = fixture();
  const source = join(root, 'source');
  const caller = join(root, 'caller');
  const mirror = join(root, 'remote-mirror.git');
  const bin = join(root, 'bin');
  mkdirSync(source);
  mkdirSync(bin);
  const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  expect(git(source, 'init', '-q').status).toBe(0);
  writeFileSync(join(source, 'tracked.txt'), 'baseline');
  expect(git(source, 'add', 'tracked.txt').status).toBe(0);
  expect(git(source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'baseline').status).toBe(0);
  const baseline = git(source, 'rev-parse', 'HEAD').stdout.trim();
  writeFileSync(join(source, 'tracked.txt'), 'cut');
  expect(git(source, 'add', 'tracked.txt').status).toBe(0);
  expect(git(source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'cut').status).toBe(0);
  const cut = git(source, 'rev-parse', 'HEAD').stdout.trim();
  expect(git(root, 'clone', '-q', '--no-checkout', source, caller).status).toBe(0);
  expect(git(caller, 'config', '--local', 'core.hooksPath', '/dev/null').status).toBe(0);
  expect(git(caller, 'remote', 'set-url', 'origin', 'https://example.invalid/unavailable.git').status).toBe(0);
  const previousGitConfig = process.env.GIT_CONFIG_GLOBAL;
  const previousGitNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  const previousGitAllowProtocol = process.env.GIT_ALLOW_PROTOCOL;
  const previousGitTemplateDir = process.env.GIT_TEMPLATE_DIR;
  const sshCalls = join(root, 'ssh-calls');
  const shim = join(bin, 'ssh');
  writeFileSync(shim, `#!/usr/bin/env bun\nimport { appendFileSync } from 'node:fs';\nimport { spawnSync } from 'node:child_process';\nconst command = process.argv.slice(3).join(' ');\nappendFileSync(${JSON.stringify(sshCalls)}, command + '\\n');\nif (command.includes(${JSON.stringify(caller)})) process.exit(91);\nconst run = spawnSync('sh', ['-c', command], { stdio: 'inherit' });\nprocess.exit(run.status ?? 2);\n`);
  chmodSync(shim, 0o700);
  expect(git(caller, 'config', '--local', 'core.hooksPath', '/dev/null').status).toBe(0);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ''}`;
  try {
    process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.GIT_ALLOW_PROTOCOL = 'file:ssh';
    process.env.GIT_TEMPLATE_DIR = join(root, 'empty-template');
    mkdirSync(process.env.GIT_TEMPLATE_DIR);
    writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
    const runner = createGateRunner(caller, 'test-host');
    const command = runner.command;
    let remoteWork = '';
    runner.command = async (cmd, args, cwd) => {
      if (cmd === 'bun' && args[0] === 'install') return { rc: 0, output: '' };
      const result = await command(cmd, args, cwd);
      if (cmd === 'mktemp') remoteWork = result.output.trim();
      return result;
    };
    runner.sweep = async (tree) => {
      expect(readFileSync(join(tree, 'tracked.txt'), 'utf8')).toBe(tree.endsWith('/cut') ? 'cut' : 'baseline');
      return { rc: 0, output: runOutput([]) };
    };
    const result = await judgeGate({ ...options(instanceRoot), commit: cut, baselineCommit: baseline, repo: caller, remote: 'test-host', remoteMirror: mirror }, runner);
    expect(result).toMatchObject({ outcome: 'ok' });
    expect(git(mirror, 'for-each-ref', '--format=%(refname)').stdout.trim().split('\n').sort()).toEqual(
      [cut, baseline].map((commit) => `refs/elanous/gate/${commit}`).sort(),
    );
    expect(readFileSync(sshCalls, 'utf8')).not.toContain(caller);
    expect(remoteWork).toMatch(/^\/tmp\/release-gate-/);
    expect(existsSync(remoteWork)).toBe(false);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (previousGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGitConfig;
    if (previousGitNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = previousGitNoSystem;
    if (previousGitAllowProtocol === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
    else process.env.GIT_ALLOW_PROTOCOL = previousGitAllowProtocol;
    if (previousGitTemplateDir === undefined) delete process.env.GIT_TEMPLATE_DIR;
    else process.env.GIT_TEMPLATE_DIR = previousGitTemplateDir;
  }
  expect(process.env.GIT_ALLOW_PROTOCOL).toBe(previousGitAllowProtocol);
  expect(process.env.GIT_TEMPLATE_DIR).toBe(previousGitTemplateDir);
});

test('an unsafe remote mirror path fails before any remote commands', async () => {
  const { instanceRoot, runner, calls } = fake();
  expect(await judgeGate({ ...options(instanceRoot), remote: 'test-host', remoteMirror: '/tmp/../caller' }, runner)).toMatchObject({
    outcome: 'error', error: 'invalid remote mirror path',
  });
  expect(calls).toHaveLength(0);
});

test('an invalid remote host fails closed before creating a remote directory', async () => {
  const { instanceRoot, runner, calls } = fake();
  expect(await judgeGate({ ...options(instanceRoot), remote: 'host;unsafe' }, runner)).toMatchObject({ outcome: 'error', error: 'invalid ssh host' });
  expect(calls).toHaveLength(0);
});

test('uncached baseline runs once and is cleaned up', async () => {
  const { instanceRoot, runner, calls } = fake([A], [A, D], false);
  // GATE-SPEED A4 — only the cut's failing file is swept at the baseline, so «fixed» is not counted (D never runs).
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'ok', fixed: null, preexisting: 1, baselineDeferred: { cutFiles: 1, swept: 1 } });
  expect(calls.filter((c) => c.startsWith('sweep '))).toEqual([expect.stringMatching(/\/cut$/), expect.stringMatching(/\/baseline only=src\/a\.test\.ts$/)]);
  expect(calls.filter((c) => c.startsWith('remove '))).toHaveLength(2);
});

test('GATE-SPEED A4: a swept baseline runs only cut failures present at the previous release', async () => {
  const { root, instanceRoot, runner, calls } = fake([A, B], [A], false);
  // Real `git ls-files -z` on a previous-release tree that has a.test.ts but not b.test.ts (test paths are ASCII-only —
  // testFileOfId rejects anything else — so git never quotes them; -z keeps the parse independent of that).
  const previous = join(root, 'previous-release');
  mkdirSync(join(previous, 'src'), { recursive: true });
  writeFileSync(join(previous, 'src/a.test.ts'), '');
  expect(spawnSync('git', ['init', '-q', previous]).status).toBe(0);
  expect(spawnSync('git', ['-C', previous, 'add', 'src/a.test.ts']).status).toBe(0);
  const command = runner.command;
  runner.command = async (cmd, args, cwd) => {
    if (cmd === 'git' && args[0] === 'ls-files') {
      calls.push(`${cmd} ${args.join(' ')} @${cwd}`);
      const run = spawnSync('git', args, { cwd: previous, encoding: 'utf8' });
      return { rc: run.status ?? 2, output: run.stdout };
    }
    return command(cmd, args, cwd);
  };
  const result = await judgeGate(options(instanceRoot), runner);
  expect(result).toMatchObject({ outcome: 'regression', introduced: [B], preexisting: 1, baselineSource: 'swept', baselineDeferred: { cutFiles: 2, swept: 1 } });
  expect(calls.filter((c) => c.startsWith('sweep '))).toEqual([expect.stringMatching(/\/cut$/), expect.stringMatching(/\/baseline only=src\/a\.test\.ts$/)]);
});

test('GATE-SPEED A4: a clean cut never opens the swept baseline', async () => {
  const { instanceRoot, runner, calls } = fake([], [A, D], false);
  const result = await judgeGate(options(instanceRoot), runner);
  expect(result).toMatchObject({ outcome: 'ok', baselineSource: 'swept', baselineDeferred: { cutFiles: 0, swept: 0 } });
  expect(graphGateResult(result, true).summary).toContain('고침 못 셈(기준선 미루기)');
  expect(calls.filter((c) => c.startsWith('sweep '))).toHaveLength(1);
  expect(calls.filter((c) => c.startsWith(`add ${BASE}`))).toHaveLength(0);
});

test('baseline isolated failure reclassifies the candidate as preexisting', async () => {
  const { instanceRoot, runner } = fake([B], []);
  const old = runner.command;
  runner.command = async (cmd, args, cwd) => {
    if (cmd === 'bun' && args[2] === './src/b.test.ts' && cwd.endsWith('/baseline')) return { rc: 1, output: runOutput([B]) };
    return old(cmd, args, cwd);
  };
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'ok', introduced: [], preexisting: 1 });
});

// GATE-BASELINE-CACHE (0.2.18) — the isolated baseline result of (commit, file) is measured once and reused.
const baselineRuns = (calls: string[]) => calls.filter((call) => call.startsWith('bun run test:deterministic') && call.endsWith('/baseline'));
test('baseline cache: a second gate on the same commit and files runs no baseline file and keeps the verdict', async () => {
  const { instanceRoot, ledgerRoot, runner, calls } = fake([B], []);
  const old = runner.command;
  runner.command = async (cmd, args, cwd) => {
    if (cmd === 'bun' && args[2] === './src/b.test.ts' && cwd.endsWith('/baseline')) { calls.push(`${cmd} ${args.join(' ')} @${cwd}`); return { rc: 1, output: runOutput([B]) }; }
    return old(cmd, args, cwd);
  };
  const events: Array<{ category: string; event: string; data: unknown }> = [];
  const spy = spyOn(debug, 'log').mockImplementation((category: string, event: string, data?: unknown) => { events.push({ category, event, data }); });
  try {
    const first = await judgeGate(options(instanceRoot), runner);
    expect(first).toMatchObject({ outcome: 'ok', introduced: [], preexisting: 1, baselineCache: { hits: 0, misses: 1 } });
    expect(baselineRuns(calls)).toHaveLength(1);
    const cache = readFileSync(join(ledgerRoot, 'gate-baseline-cache', `${BASE}.jsonl`), 'utf8');
    expect(JSON.parse(cache.trim())).toEqual({ commit: BASE, file: 'src/b.test.ts', host: 'local', failures: [B], errors: [], missing: false });
    calls.length = 0;
    const second = await judgeGate(options(instanceRoot), runner);
    expect(second).toMatchObject({ outcome: first.outcome, introduced: first.introduced, preexisting: first.preexisting, fixed: first.fixed, baselineCache: { hits: 1, misses: 0 } });
    expect(baselineRuns(calls)).toHaveLength(0);
    expect(calls.filter((call) => call.startsWith(`snapshot ${BASE}`))).toHaveLength(0);
    expect(events.filter((e) => e.category === 'release.gate' && e.event === 'baseline-cache').map((e) => e.data))
      .toEqual([{ hits: 0, misses: 1, commit: BASE }, { hits: 1, misses: 0, commit: BASE }]);
  } finally { spy.mockRestore(); }
});

test('baseline cache: an introduced verdict is reproduced from the cache, and a missing baseline file is cached as missing', async () => {
  const { instanceRoot, runner, calls } = fake([B], []);
  const command = runner.command;
  runner.command = async (cmd, args, cwd) => {
    if (cmd === 'bun' && args[2] === './src/b.test.ts' && cwd.endsWith('/baseline')) {
      calls.push(`${cmd} ${args.join(' ')} @${cwd}`);
      return { rc: 1, output: 'Test filter "./src/b.test.ts" had no matches in --cwd="/tmp/baseline"\n' };
    }
    if (cmd === 'git' && args[0] === 'ls-tree') return { rc: 0, output: '' };
    return command(cmd, args, cwd);
  };
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'regression', introduced: [B], baselineCache: { hits: 0, misses: 1 } });
  calls.length = 0;
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'regression', introduced: [B], baselineCache: { hits: 1, misses: 0 } });
  expect(baselineRuns(calls)).toHaveLength(0);
});

test('baseline cache: a corrupt cache file is re-run, never read as a pass', async () => {
  const valid = JSON.stringify({ commit: BASE, file: 'src/b.test.ts', host: 'local', failures: [B], errors: [], missing: false });
  for (const corrupt of ['{not json\n', JSON.stringify({ commit: BASE, file: 'src/b.test.ts', host: 'local', failures: ['src/other.test.ts > X'], errors: [], missing: false }) + '\n',
    `${valid}\n\n${valid}\n`, valid, '']) {
    const { instanceRoot, ledgerRoot, runner, calls } = fake([B], []);
    mkdirSync(join(ledgerRoot, 'gate-baseline-cache'), { recursive: true });
    writeFileSync(join(ledgerRoot, 'gate-baseline-cache', `${BASE}.jsonl`), corrupt);
    const result = await judgeGate(options(instanceRoot), runner);
    expect(result).toMatchObject({ outcome: 'regression', introduced: [B], baselineCache: { hits: 0, misses: 1 } });
    expect(baselineRuns(calls)).toHaveLength(1);
  }
});

test('baseline cache: a different baseline commit or host is a miss; the cut result seeds the next gate', async () => {
  const { instanceRoot, ledgerRoot, runner, calls } = fake([B], []);
  mkdirSync(join(ledgerRoot, 'gate-baseline-cache'), { recursive: true });
  const other = 'c'.repeat(40);
  writeFileSync(join(ledgerRoot, 'gate-baseline-cache', `${other}.jsonl`), JSON.stringify({ commit: other, file: 'src/b.test.ts', host: 'local', failures: [B], errors: [], missing: false }) + '\n');
  writeFileSync(join(ledgerRoot, 'gate-baseline-cache', `${BASE}.jsonl`), JSON.stringify({ commit: BASE, file: 'src/b.test.ts', host: 'other-host', failures: [B], errors: [], missing: false }) + '\n');
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'regression', introduced: [B], baselineCache: { hits: 0, misses: 1 } });
  expect(baselineRuns(calls)).toHaveLength(1);
  // The cut's isolated check of src/b.test.ts is stored under the cut commit — the next release's baseline.
  const seeded = readFileSync(join(ledgerRoot, 'gate-baseline-cache', `${CUT}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  expect(seeded).toEqual([{ commit: CUT, file: 'src/b.test.ts', host: 'local', failures: [B], errors: [], missing: false }]);
});

test('baseline cache: an isolated result the cache cannot hold skips the cache and keeps the verdict', async () => {
  const { instanceRoot, ledgerRoot, runner } = fake([B], []);
  const old = runner.command;
  runner.command = async (cmd, args, cwd) => {
    if (cmd === 'bun' && args[2] === './src/b.test.ts' && cwd.endsWith('/cut')) return { rc: 1, output: runOutput([B, 'src/other.test.ts > X']) };
    return old(cmd, args, cwd);
  };
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'regression', introduced: [B], baselineCache: { hits: 0, misses: 1 } });
  expect(existsSync(join(ledgerRoot, 'gate-baseline-cache', `${CUT}.jsonl`))).toBe(false);
  expect(existsSync(join(ledgerRoot, 'gate-baseline-cache', `${BASE}.jsonl`))).toBe(true);
});

test('new test file missing from baseline is introduced only after cut isolation reproduces it', async () => {
  const { instanceRoot, runner, calls } = fake([B], []);
  const command = runner.command;
  runner.command = async (cmd, args, cwd) => {
    if (cmd === 'bun' && args[2] === './src/b.test.ts' && cwd.endsWith('/baseline')) {
      return { rc: 1, output: 'Test filter "./src/b.test.ts" had no matches in --cwd="/tmp/baseline"\n' };
    }
    if (cmd === 'git' && args[0] === 'ls-tree') return { rc: 0, output: '' };
    return command(cmd, args, cwd);
  };
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'regression', introduced: [B] });
  expect(calls.filter((call) => call.startsWith(`add ${BASE}`))).toHaveLength(0);
});

test('an incomplete sweep is an error, not a clean release', async () => {
  const { instanceRoot, runner } = fake();
  runner.sweep = async () => ({ rc: 0, output: '0 fail\nRan 0 tests across 0 files.\n' });
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'error', error: expect.stringContaining('cut sweep incomplete') });
});

test('validated Pod sweep counts failures after an earlier shard failure summary', async () => {
  // 0.2.30 cut: shard 77 ended with a repeated Bun failure list, then shard 79
  // reported two more actual failures. The aggregate had 74 named failures but
  // the old global slice counted only 72 execution lines and errored.
  const ids = Array.from({ length: 74 }, (_, i) => `src/case-${i}.test.ts > failure ${i}`);
  const { instanceRoot, runner } = fake(ids, []);
  const command = runner.command;
  runner.command = async (cmd, args, cwd) => {
    if (cmd === 'bun' && args[0] === 'run' && cwd.endsWith('/cut')) {
      const file = args[2]!.replace(/^\.\//, '');
      const id = ids.find((candidate) => candidate.startsWith(`${file} > `));
      return { rc: id ? 1 : 0, output: runOutput(id ? [id] : []) };
    }
    return command(cmd, args, cwd);
  };
  runner.sweep = async () => {
    const body = (items: string[]) => items.map((id) => {
      const [file, name] = id.split(' > ');
      return `${file}:\n(fail) ${name} [1.00ms]\n`;
    }).join('');
    return { rc: 1, validatedShards: true, output: `${body(ids.slice(0, 72))}1 tests failed:\n(fail) failure 71 [1.00ms]\n\n\n${body(ids.slice(72))}\n74 fail\n0 errors\nRan 74 tests across 74 files.\n` };
  };
  const result = await judgeGate(options(instanceRoot), runner);
  expect(result).toMatchObject({ outcome: 'regression', introduced: [...ids].sort() });
});

test('unvalidated sweep keeps the single-run summary boundary', async () => {
  const { instanceRoot, runner } = fake([A, B], []);
  runner.sweep = async () => ({ rc: 1, output: 'src/a.test.ts:\n(fail) A [1.00ms]\n1 tests failed:\n(fail) A [1.00ms]\n\nsrc/b.test.ts:\n(fail) B [1.00ms]\n2 fail\nRan 2 tests across 2 files.\n' });
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'error', error: expect.stringContaining('failure attribution incomplete') });
});

test('a passing title containing (fail) cannot make an under-attributed failure summary complete', async () => {
  const { instanceRoot, runner } = fake([A], []);
  runner.sweep = async () => ({ rc: 1, output: `src/a.test.ts:\n(pass) title contains (fail) as ordinary text\n(fail) A [1.00ms]\n1 pass\n2 fail\nRan 2 tests across 1 file.\n` });
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({
    outcome: 'error', error: expect.stringContaining('failure attribution incomplete: summary=2, identified=1'),
  });
});

test('the original decision-signal passing titles do not turn a clean isolated summary into an error', async () => {
  const { instanceRoot, runner } = fake();
  runner.sweep = async () => ({ rc: 0, output: `src/self-implement/decision-signal-press.test.ts:\n(pass) moves a signal out of pressedRed when every (fail) name also failed on the baseline [0.61ms]\n(pass) reads (fail) names from stderr — real bun test prints them there, not on stdout [0.07ms]\n21 pass\n0 fail\nRan 21 tests across 1 file.\n` });
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'ok', introduced: [], preexisting: 0 });
});

test('a CRLF failure line is counted while a passing title containing (fail) is ignored', async () => {
  const { instanceRoot, runner } = fake([B], [A]);
  runner.sweep = async () => ({ rc: 1, output: `src/b.test.ts:\r\n(pass) title contains (fail)\r\n(fail) B [1.00ms]\r\n1 pass\r\n1 fail\r\nRan 2 tests across 1 file.\r\n` });
  const result = await judgeGate(options(instanceRoot), runner);
  expect(result).toMatchObject({ outcome: 'regression', introduced: [B] });
  expect(result.error).toBeUndefined();
});

test('a leaked non-zero exit under a complete clean summary is read as clean, not incomplete', async () => {
  // 0.2.7 gate: agent-cli at v0.2.6 left process.exitCode = 2 — «12 pass · 0 fail · Ran 12 tests» with rc 2 stopped the gate.
  const { instanceRoot, runner } = fake();
  runner.sweep = async () => ({ rc: 2, output: 'src/a.test.ts:\n 12 pass\n 0 fail\nRan 12 tests across 1 file. [8.54s]\n' });
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'ok', introduced: [] });
});

test('a non-zero exit with a failure in the summary is still incomplete when the exit is not 1', async () => {
  const { instanceRoot, runner } = fake();
  runner.sweep = async () => ({ rc: 2, output: runOutput([A]) });
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'error', error: expect.stringContaining('summary/exit') });
});

test('a nested bun test summary earlier in the output does not replace the sweep summary', async () => {
  // Real sample (09-29 0.2.4 gate `test.log`): a test spawned a nested `bun test` whose «0 fail · Ran 2 tests across 1 file»
  // sat at line 6765 of a 60064-test sweep; the first-match parser read it and called the finished sweep «incomplete».
  const plain = fake();
  const expected = await judgeGate(options(plain.instanceRoot), plain.runner);
  const { instanceRoot, runner } = fake();
  const sweep = runner.sweep;
  runner.sweep = async (tree, logDir) => {
    const run = await sweep(tree, logDir);
    return { ...run, output: `src/nested.test.ts:\n\n 1 pass\n 0 fail\nRan 2 tests across 1 file. [75.00ms]\n${run.output}` };
  };
  const judged = await judgeGate(options(instanceRoot), runner);
  expect(judged.outcome).not.toBe('error');
  expect(judged).toMatchObject({ outcome: expected.outcome, introduced: (expected as { introduced?: string[] }).introduced });
});

test('missing failure summary is an error even if the runner exited zero', async () => {
  const { instanceRoot, runner } = fake();
  runner.sweep = async () => ({ rc: 0, output: 'Ran 1 test across 1 file.\n' });
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'error', error: expect.stringContaining('failure attribution incomplete') });
});

test('a zero-exit sweep reporting failures cannot be called healthy', async () => {
  const { instanceRoot, runner } = fake();
  runner.sweep = async () => ({ rc: 0, output: runOutput([A]) });
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'error', error: expect.stringContaining('failure attribution incomplete') });
});

test('isolated gate reads the 2026-10-16 Bun log with one failure repeated in its closing summary', () => {
  const output = readFileSync(join(import.meta.dir, 'fixtures/gate-recheck-webclone-20261016.log'), 'utf8');
  expect(readIsolatedRun({ rc: 1, output }, 'cut isolated src/webclone/archive-run.test.ts', 'src/webclone/archive-run.test.ts')).toEqual({
    kind: 'read',
    failures: ['src/webclone/archive-run.test.ts > 브라우저 재현 가능한 미러 계약 > 실제 wget은 POSIX ERE를 컴파일해 www 형제 자산만 받고 외부 호스트는 받지 않는다'],
    errors: [],
  });
});

test('an explicit baseline commit rejects stale caches and sweeps when neither location matches', async () => {
  const { instanceRoot, ledgerRoot, runner, calls } = fake([A], [A]);
  const stale = join(ledgerRoot, 'release/1.0.0/gate-failures.json');
  mkdirSync(dirname(stale), { recursive: true });
  writeFileSync(stale, JSON.stringify({ commit: 'd'.repeat(40), failures: [B] }));
  expect(await judgeGate({ ...options(instanceRoot), baselineCommit: 'c'.repeat(40) }, runner)).toMatchObject({
    outcome: 'ok', baselineSource: 'swept', preexisting: 1,
  });
  expect(calls.filter((c) => c.startsWith('sweep '))).toHaveLength(2);
  expect(calls.filter((c) => c.startsWith('add ' + 'c'.repeat(40)))).toHaveLength(1);
});

test('cached failures are rejected when release metadata names a different source commit', async () => {
  const { instanceRoot, runner, calls } = fake([B], [A]);
  writeFileSync(join(instanceRoot, 'release/1.0.0/release.json'), JSON.stringify({ sourceCommit: 'c'.repeat(40) }));
  const result = await judgeGate(options(instanceRoot), runner);
  expect(result).toMatchObject({ outcome: 'regression', introduced: [B], baselineDeferred: { cutFiles: 1, swept: 1 } });
  expect(calls.filter((call) => call.startsWith('sweep '))).toHaveLength(2);
  expect(calls.filter((call) => call.startsWith('add '))).toHaveLength(2);
  expect(calls.filter((call) => call.startsWith('snapshot '))).toHaveLength(0);
});

test('an invalid cached test identity is rejected before any isolation can execute it', async () => {
  const { instanceRoot, runner, calls } = fake();
  writeFileSync(join(instanceRoot, 'release/1.0.0/gate-failures.json'), JSON.stringify({ commit: BASE, failures: ['src/b.test.ts'] }));
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'error', error: expect.stringContaining('unsafe test path') });
  expect(calls.filter((call) => call.includes('test:deterministic src/b.test.ts'))).toHaveLength(0);
});

test('implicit baseline ignores a stale cached commit and sweeps the release manifest source instead', async () => {
  const { instanceRoot, runner, calls } = fake([B], [A]);
  writeFileSync(join(instanceRoot, 'release/1.0.0/gate-failures.json'), JSON.stringify({ commit: 'c'.repeat(40), failures: [B] }));
  const result = await judgeGate(options(instanceRoot), runner);
  expect(result).toMatchObject({ outcome: 'regression', introduced: [B], baselineDeferred: { cutFiles: 1, swept: 1 } });
  expect(calls.filter((call) => call.startsWith('sweep '))).toHaveLength(2);
  expect(calls.filter((call) => call.startsWith(`add ${BASE}`))).toHaveLength(1);
  expect(calls.filter((call) => call.startsWith('snapshot '))).toHaveLength(0);
});

test('missing release manifest cannot silently trust a cached baseline without an explicit commit', async () => {
  const { instanceRoot, runner, calls } = fake();
  rmSync(join(instanceRoot, 'release/1.0.0/release.json'));
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'error', introduced: [] });
  expect(calls.filter((call) => call.startsWith('snapshot '))).toHaveLength(0);
  expect(calls.filter((call) => call.startsWith(`add ${BASE}`))).toHaveLength(0);
});

test('baseline single-file preexistence is checked once per file, including multiple failures', async () => {
  const B2 = 'src/b.test.ts > B2';
  const { instanceRoot, runner, calls } = fake([B, B2], []);
  const old = runner.command;
  runner.command = async (cmd, args, cwd) => {
    if (cmd === 'bun' && args[2] === './src/b.test.ts') {
      calls.push(`${cmd} ${args.join(' ')} @${cwd}`);
      return { rc: 1, output: runOutput(cwd.endsWith('/cut') ? [B, B2] : [B]) };
    }
    return old(cmd, args, cwd);
  };
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'regression', introduced: [B2], preexisting: 1 });
  expect(calls.filter((call) => call.includes('src/b.test.ts @'))).toHaveLength(2);
});

test('four shard sweep combines file failures and passes explicit CDP ignores', async () => {
  const { root } = fixture();
  const paths = ['src/cli/a.test.ts', 'src/agent/b.test.ts', 'test/c.test.ts', 'scripts/d.test.ts'];
  const init = spawnSync('git', ['init', '-q'], { cwd: root });
  expect(init.status).toBe(0);
  for (const path of paths) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), path === 'scripts/d.test.ts' ? 'requireCdpBase' : 'test');
  }
  expect(spawnSync('git', ['add', ...paths], { cwd: root }).status).toBe(0);
  const original = createGateRunner(root).command;
  const seen: string[][] = [];
  const runner = createGateRunner(root, undefined, async (cmd, args, cwd) => {
    if (cmd === 'bun' && args[0] === 'run') {
      seen.push(args);
      const path = args.at(-1)!;
      const ids = path === './src/cli' ? ['src/cli/a.test.ts > A'] : path === './src/agent' ? ['src/agent/b.test.ts > B'] : [];
      // A test that spawns `bun test` prints its own summary first — only the runner's LAST one counts.
      const nested = path === './test' ? '3 pass\n0 fail\nRan 3 tests across 1 file.\n' : '';
      return { rc: ids.length ? 1 : 0, output: `${nested}0 pass\n${runOutput(ids)}` };
    }
    return original(cmd, args, cwd);
  });
  const logDir = join(root, 'logs');
  const sweep = await runner.sweep(root, logDir);
  expect(sweep.rc).toBe(1);
  expect(sweep.output).toContain('2 fail\n0 errors\nRan 4 tests across 4 files.');
  expect(sweep.output).toContain('src/cli/a.test.ts:');
  expect(sweep.output).toContain('src/agent/b.test.ts:');
  // bun reads a bare `test` as a substring filter (every *.test.ts) — shards must pass paths.
  expect(seen.map((args) => args.at(-1))).toEqual(['./src/cli', './src/agent', './test', './scripts']);
  expect(seen[3]).toContain('--path-ignore-patterns');
  for (const args of seen.slice(0, 3)) expect(args).not.toContain('--path-ignore-patterns');
  for (const name of ['src-cli', 'src-rest', 'test', 'other']) expect(existsSync(join(logDir, `${name}.log`))).toBe(true);
});

test('cut Pod shards are balanced, concurrent, commit-pinned and preserve the serial gate judgment', async () => {
  const { root, instanceRoot, runner: fixtureRunner, calls } = fake([], []);
  const files = ['src/cli/a.test.ts', 'src/b.test.ts', 'src/c.test.ts', 'src/d.test.ts', 'src/e.test.ts',
    'src/f.test.ts', 'test/g.test.ts', 'test/h.test.ts', 'scripts/i.test.ts', 'scripts/j.test.ts'];
  const sortedFiles = [...files].sort();
  const treeHead = 'c'.repeat(40);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const original = fixtureRunner.command;
  const outputFor = (paths: string[]) => {
    const ids = paths.includes('src/b.test.ts') ? [B] : [];
    return { rc: ids.length ? 1 : 0, output: `${paths.length - ids.length} pass\n${ids.map((id) => `${id.split(' > ')[0]}:\n(fail) B [1.00ms]\n`).join('')}\n${ids.length} fail\nRan ${paths.length} tests across ${paths.length} files.\n` };
  };
  const serialGroups: string[][] = [];
  const command: GateRunner['command'] = async (cmd, args, cwd) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: `${treeHead}\n` };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: `${[...files].reverse().join('\n')}\n` };
    if (cmd === 'bun' && args[0] === 'run' && (args.length > 3 || ['./src/cli', './test', './scripts'].includes(args[2] ?? ''))) {
      const paths = files.filter((file) => args.slice(2).some((arg) => {
        const path = arg.replace(/^\.\//, '');
        return file === path || file.startsWith(`${path}/`);
      }));
      serialGroups.push(paths);
      return outputFor(paths);
    }
    return original(cmd, args, cwd);
  };
  const serialRunner = createGateRunner(repo, 'test-host', command);
  const serialGateRunner = { ...fixtureRunner, sweep: (tree: string, logDir?: string) => serialRunner.sweep(tree, logDir) };
  const serial = await judgeGate({ ...options(instanceRoot), repo }, serialGateRunner);
  expect(serial).toMatchObject({ outcome: 'regression', introduced: [B] });
  const serialFailures = JSON.parse(readFileSync(join(instanceRoot, 'release/1.0.1/gate-failures.json'), 'utf8')) as { failures: string[] };
  expect(serialGroups).toEqual([files.slice(0, 1), files.slice(1, 6), files.slice(6, 8), files.slice(8)]);
  expect(serialGroups.flat().sort()).toEqual(sortedFiles);
  for (const group of ['src-cli', 'src-rest', 'test', 'other']) {
    expect(existsSync(join(instanceRoot, `release/1.0.1/gate-logs/cut/${group}.log`))).toBe(true);
  }
  expect(serialFailures.failures).toEqual([B]);
  const invoked: Array<RunPodCommandOptions> = [];
  let active = 0;
  let peak = 0;
  let release!: () => void;
  const concurrent = new Promise<void>((resolve) => { release = resolve; });
  const pod = async (o: RunPodCommandOptions) => {
    invoked.push(o);
    active++;
    peak = Math.max(peak, active);
    if (active === 3) release();
    await concurrent;
    const paths = files.filter((file) => o.command[2]!.includes(`'./${file}'`));
    const { rc, output } = outputFor(paths);
    const artifactsDir = join(root, `artifacts-${invoked.indexOf(o)}`);
    mkdirSync(artifactsDir);
    writeFileSync(join(artifactsDir, 'shard.log'), output);
    writeFileSync(join(artifactsDir, 'shard.rc'), `${rc}\n`);
    active--;
    return { exitCode: 0, artifactsDir, job: 'fake' };
  };
  const runner = createGateRunner(repo, undefined, command, pod, new PodPoolScheduler([{ context: 'pool-test', capacity: 3, k3dCluster: 'test' }]));
  runner.recheckPod = undefined; // This case measures sweep placement; final recheck has its own Pod contract test.
  runner.add = fixtureRunner.add;
  runner.remove = fixtureRunner.remove;
  runner.snapshot = fixtureRunner.snapshot;
  runner.removeSnapshot = fixtureRunner.removeSnapshot;
  const observed: Array<{ category: string; event: string; data: unknown }> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => { observed.push({ category, event, data }); });
  const previousEntrance = process.env.ELANOUS_RELEASE_ENTRANCE;
  process.env.ELANOUS_RELEASE_ENTRANCE = ' release-run ';
  try {
    const result = await judgeGate({ ...options(instanceRoot), repo, pod: { pool: 'pool-test', shards: 3 } }, runner);
    expect(result).toMatchObject({ outcome: serial.outcome, introduced: serial.introduced, preexisting: serial.preexisting, fixed: serial.fixed });
    const podFailures = JSON.parse(readFileSync(join(instanceRoot, 'release/1.0.1/gate-failures.json'), 'utf8')) as { failures: string[] };
    expect(podFailures.failures).toEqual(serialFailures.failures);
    expect(result.introduced).toEqual(serial.introduced);
    expect(invoked).toHaveLength(3);
    expect(invoked.every((o) => o.provenanceGate === true
      && o.provenance?.kind === 'gate-shard'
      && !!o.provenance.actor && !!o.provenance.run
      && !!o.provenance.phase && !!o.provenance.requestedAt
      && !!o.provenance.shard)).toBe(true);
    expect(invoked.every((o) => o.provenance?.entrance === 'release-run')).toBe(true);
    expect(peak).toBe(3);
    expect(invoked.every((o) => o.pool === 'pool-test' && o.clone === true && o.deadlineSeconds === 1200 && JSON.stringify(o.source) === JSON.stringify({ kind: 'commit', sha: treeHead }))).toBe(true);
    expect(new Set(invoked.map((o) => o.name)).size).toBe(3);
    // GATE-LIVE-OBS: each shard sees the one gate scheduler through its own tracking view (same members, same slots).
    expect(new Set(invoked.map((o) => o.poolScheduler!.members)).size).toBe(1);
    expect(invoked.map((o) => sortedFiles.filter((f) => o.command[2]!.includes(`'./${f}'`)))).toEqual([
      [sortedFiles[0], sortedFiles[3], sortedFiles[6], sortedFiles[9]],
      [sortedFiles[1], sortedFiles[4], sortedFiles[7]], [sortedFiles[2], sortedFiles[5], sortedFiles[8]],
    ]);
    // GATE-IMAGE-DEPS (#24955): baked deps are linked first; only a miss installs, still into install.log with its rc.
    expect(invoked[0]!.command[2]).toContain('gate_deps_link "$t" >> "$O/install.log" 2>&1');
    expect(invoked[0]!.command[2]).toContain('(cd "$t" && bun install) >> "$O/install.log" 2>&1; irc=$?');
    expect(invoked[0]!.command[2]).toContain('> "$O/part-$i.log" 2>&1');
    const logs = join(instanceRoot, 'release/1.0.1/gate-logs/cut');
    for (let i = 0; i < 3; i++) {
      expect(existsSync(join(logs, `pod-${i}.log`))).toBe(true);
      expect(JSON.parse(readFileSync(join(logs, `pod-${i}.json`), 'utf8'))).toMatchObject({ rc: i === 2 ? 1 : 0, files: sortedFiles.filter((_, index) => index % 3 === i), durationMs: expect.any(Number) });
    }
    expect(observed.filter((item) => item.category === 'release-loop.gate' && item.event === 'pod-shard')).toHaveLength(3);
    expect(observed.filter((item) => item.event === 'pod-shard').map((item) => item.data)).toEqual([
      { shard: 0, files: sortedFiles.filter((_, index) => index % 3 === 0), durationMs: expect.any(Number), rc: 0, attempt: 1, installSeconds: null, gateDeps: {}, deadlineSeconds: 1200, parts: 1 },
      { shard: 1, files: sortedFiles.filter((_, index) => index % 3 === 1), durationMs: expect.any(Number), rc: 0, attempt: 1, installSeconds: null, gateDeps: {}, deadlineSeconds: 1200, parts: 1 },
      { shard: 2, files: sortedFiles.filter((_, index) => index % 3 === 2), durationMs: expect.any(Number), rc: 1, attempt: 1, installSeconds: null, gateDeps: {}, deadlineSeconds: 1200, parts: 1 },
    ]);
    expect(calls.filter((call) => call.startsWith('sweep '))).toHaveLength(0);
    // GATE-LIVE-OBS: the release ledger (here the explicit test ledger) holds one finished row per shard.
    const board = readGateShards(gateShardsPath('1.0.1', join(dirname(instanceRoot), 'machine-ledger')));
    expect(board?.shards.map((row) => [row.id, row.state])).toEqual([['pod-0', 'done'], ['pod-1', 'done'], ['pod-2', 'done']]);
    expect(board?.shards.every((row) => typeof row.endedAt === 'string')).toBe(true);
    // GATE-LIVE-OBS-RC-WORDING ⓒ: after judging, the same board carries the verdict, so the line leaves «판정 전».
    expect(board?.verdict).toEqual({ introduced: result.introduced.length, preexisting: result.preexisting });
  } finally {
    if (previousEntrance === undefined) delete process.env.ELANOUS_RELEASE_ENTRANCE;
    else process.env.ELANOUS_RELEASE_ENTRANCE = previousEntrance;
    log.mockRestore();
  }
});

test('Pod sweep opts into the Bun cache and records the first install timing', async () => {
  const { root, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const invoked: RunPodCommandOptions[] = [];
  const observed: Array<{ event: string; data: unknown }> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'release-loop.gate' && (event === 'pod-shard' || event === 'pod-bun-cache')) observed.push({ event, data });
  });
  const previous = process.env.POD_BUN_CACHE_HOST_PATH;
  delete process.env.POD_BUN_CACHE_HOST_PATH;
  try {
    const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
      if (cmd === 'rg') return { rc: 1, output: '' };
      if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
      if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: 'src/a.test.ts\n' };
      return fixtureRunner.command(cmd, args, cwd);
    }, async (o) => {
      invoked.push(o);
      const artifactsDir = join(root, `cached-shard-${invoked.length}`);
      mkdirSync(artifactsDir);
      writeFileSync(join(artifactsDir, 'shard.log'), '5 packages installed [750ms]\n2 packages installed [3s]\n1 pass\n0 fail\nRan 1 test across 1 file.\n');
      writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
      return { exitCode: 0, artifactsDir, job: 'fake' };
    }, new PodPoolScheduler([{ context: 'pool-test', capacity: 1, k3dCluster: 'test' }]));
    const uncached = await runner.sweep(repo, undefined, { pool: 'pool-test', shards: 1 });
    expect(uncached.rc).toBe(0);
    expect(invoked[0]!.bunCache).toBeUndefined();
    expect(invoked[0]!.command[2]).not.toContain('BUN_INSTALL_CACHE_DIR');
    expect(invoked[0]!.command[2]).toContain('(cd "$t" && bun install) >> "$O/install.log"');
    process.env.POD_BUN_CACHE_HOST_PATH = '  /srv/bun-cache  ';
    const cached = await runner.sweep(repo, undefined, { pool: 'pool-test', shards: 1 });
    expect(cached.podSweep?.id).not.toBe(uncached.podSweep?.id);
    expect({ ...cached, podSweep: { ...cached.podSweep, id: '<sweep>' } })
      .toEqual({ ...uncached, podSweep: { ...uncached.podSweep, id: '<sweep>' } });
    expect(invoked).toHaveLength(2);
    expect(invoked[1]!.bunCache).toBe('/srv/bun-cache');
    const cachePrefix = 'if [ -d /bun-cache ] && [ -w /bun-cache ]; then export BUN_INSTALL_CACHE_DIR=/bun-cache; fi;\n';
    expect(invoked[1]!.command[2]).toContain(`O="$HOME/outbox"`);
    expect(invoked[1]!.command[2]).toContain(cachePrefix);
    expect(invoked[1]!.command[2]!.indexOf(`O="$HOME/outbox"`)).toBeLessThan(invoked[1]!.command[2]!.indexOf(cachePrefix));
    const withoutAttemptNonce = (shell: string) => shell.replace(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/g, '<attempt>');
    expect(withoutAttemptNonce(invoked[1]!.command[2]!.replace(cachePrefix, ''))).toBe(withoutAttemptNonce(invoked[0]!.command[2]!));
    expect(observed).toEqual([
      { event: 'pod-bun-cache', data: { source: 'none' } },
      { event: 'pod-shard', data: expect.objectContaining({ installSeconds: 0.75 }) },
      { event: 'pod-bun-cache', data: { source: 'env' } },
      { event: 'pod-shard', data: expect.objectContaining({ installSeconds: 0.75 }) },
    ]);
  } finally {
    log.mockRestore();
    if (previous === undefined) delete process.env.POD_BUN_CACHE_HOST_PATH;
    else process.env.POD_BUN_CACHE_HOST_PATH = previous;
  }
});

test('graph pod cache wins over env, and blank graph cache falls back to env', async () => {
  const { root } = fixture();
  const context = join(root, 'graph-context.json');
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const invoked: RunPodCommandOptions[] = [];
  const sources: unknown[] = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'release-loop.gate' && event === 'pod-bun-cache') sources.push(data);
  });
  const previous = process.env.POD_BUN_CACHE_HOST_PATH;
  try {
    const runner = createGateRunner(repo, undefined, async (cmd, args) => {
      if (cmd === 'rg') return { rc: 1, output: '' };
      if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
      if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: 'src/a.test.ts\n' };
      throw new Error(`unexpected command: ${cmd}`);
    }, async (o) => {
      invoked.push(o);
      const artifactsDir = join(root, `graph-shard-${invoked.length}`);
      mkdirSync(artifactsDir);
      writeFileSync(join(artifactsDir, 'shard.log'), '1 pass\n0 fail\nRan 1 test across 1 file.\n');
      writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
      return { exitCode: 0, artifactsDir, job: 'fake' };
    }, new PodPoolScheduler([{ context: 'pool-test', capacity: 1, k3dCluster: 'test' }]));
    const sweepGraph = async (cache: unknown) => {
      writeFileSync(context, JSON.stringify({ input: { commit: CUT, version: '1.0.1', previousVersion: '1.0.0', gatePodPool: 'pool-test', gatePodBunCache: cache }, outputs: {} }));
      const opts = parseOptions(['--json'], { ELANOUS_GRAPH_CONTEXT: context });
      if (opts === 'help') throw new Error('unexpected help');
      return runner.sweep(repo, undefined, opts.pod);
    };
    delete process.env.POD_BUN_CACHE_HOST_PATH;
    expect((await sweepGraph('/var/cache/elanous-bun')).rc).toBe(0);
    process.env.POD_BUN_CACHE_HOST_PATH = ' /srv/env-cache ';
    expect((await sweepGraph(' /var/cache/elanous-bun ')).rc).toBe(0);
    expect((await sweepGraph('  ')).rc).toBe(0);
    delete process.env.POD_BUN_CACHE_HOST_PATH;
    expect((await sweepGraph(undefined)).rc).toBe(0);
    const prefix = 'if [ -d /bun-cache ] && [ -w /bun-cache ]; then export BUN_INSTALL_CACHE_DIR=/bun-cache; fi;\n';
    expect(invoked.map((o) => o.bunCache)).toEqual(['/var/cache/elanous-bun', '/var/cache/elanous-bun', '/srv/env-cache', undefined]);
    for (const o of invoked.slice(0, 3)) {
      expect(o.command[2]).toContain(`O="$HOME/outbox"`);
      expect(o.command[2]).toContain(prefix);
      expect(o.command[2]!.indexOf(`O="$HOME/outbox"`)).toBeLessThan(o.command[2]!.indexOf(prefix));
    }
    expect(invoked[3]!.command[2]).not.toContain('BUN_INSTALL_CACHE_DIR');
    expect(sources).toEqual([{ source: 'config' }, { source: 'config' }, { source: 'env' }, { source: 'none' }]);
  } finally {
    log.mockRestore();
    if (previous === undefined) delete process.env.POD_BUN_CACHE_HOST_PATH;
    else process.env.POD_BUN_CACHE_HOST_PATH = previous;
  }
});

test('GATE-SPEED A3①: release.loop.gatePodCpu reaches the shard Job spec end to end; omitted keeps request 1 / limit 4', async () => {
  const { root } = fixture();
  const context = join(root, 'graph-context.json');
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const invoked: RunPodCommandOptions[] = [];
  const jobs: Array<Record<string, unknown>> = [];
  const resources: unknown[] = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'release-loop.gate' && event === 'shard-resources') resources.push(data);
  });
  try {
    const runner = createGateRunner(repo, undefined, async (cmd, args) => {
      if (cmd === 'rg') return { rc: 1, output: '' };
      if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
      if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: 'src/a.test.ts\n' };
      throw new Error(`unexpected command: ${cmd}`);
    }, async (o) => {
      invoked.push(o);
      // The real runPodCommand builds the Job — only kubectl is faked — so the spec is what the cluster would get.
      const { poolScheduler: _pool, pool: _spec, ...rest } = o;
      await runPodCommand({ ...rest, env: {}, configHostMirror: () => undefined, ghToken: () => 'gh-test', imageCommit: null,
        artifactsRoot: join(root, 'pod-artifacts'), log: () => {},
        kubectl: (kargs, input) => {
          if (input) { const body = JSON.parse(input) as Record<string, unknown>; if (body.kind === 'Job') jobs.push(body); }
          if (kargs.some((arg) => arg.includes('.status.conditions'))) return { status: 0, stdout: 'Complete', stderr: '' };
          return { status: 0, stdout: '0', stderr: '' };
        } });
      const artifactsDir = join(root, `cpu-shard-${invoked.length}`);
      mkdirSync(artifactsDir);
      writeFileSync(join(artifactsDir, 'shard.log'), '1 pass\n0 fail\nRan 1 test across 1 file.\n');
      writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
      return { exitCode: 0, artifactsDir, job: 'fake' };
    }, new PodPoolScheduler([{ context: 'pool-test', capacity: 1, k3dCluster: 'test' }]));
    const sweepGraph = async (input: Record<string, unknown>) => {
      writeFileSync(context, JSON.stringify({ input: { commit: CUT, version: '1.0.1', previousVersion: '1.0.0', gatePodPool: 'pool-test', ...input }, outputs: {} }));
      const opts = parseOptions(['--json'], { ELANOUS_GRAPH_CONTEXT: context });
      if (opts === 'help') throw new Error('unexpected help');
      return runner.sweep(repo, undefined, opts.pod);
    };
    expect((await sweepGraph({})).rc).toBe(0);
    expect((await sweepGraph({ gatePodCpu: 1 })).rc).toBe(0);
    expect((await sweepGraph({ gatePodCpu: { request: '500m', limit: '1500m' } })).rc).toBe(0);
    expect(invoked.map((o) => o.cpu)).toEqual([undefined, { request: '1', limit: '1' }, { request: '500m', limit: '1500m' }]);
    const res = (job: Record<string, unknown>) => (job.spec as { template: { spec: { containers: Array<{ resources: unknown }> } } }).template.spec.containers[0]!.resources;
    expect(jobs.map(res)).toEqual([
      { requests: { cpu: '1', memory: '6Gi' }, limits: { memory: '16Gi', cpu: '4' } },
      { requests: { cpu: '1', memory: '6Gi' }, limits: { memory: '16Gi', cpu: '1' } },
      { requests: { cpu: '500m', memory: '6Gi' }, limits: { memory: '16Gi', cpu: '1500m' } },
    ]);
    expect(resources).toEqual([
      { shards: 1, cpuRequest: '1', cpuLimit: '4', cpuSource: 'default' },
      { shards: 1, cpuRequest: '1', cpuLimit: '1', cpuSource: 'config' },
      { shards: 1, cpuRequest: '500m', cpuLimit: '1500m', cpuSource: 'config' },
    ]);
  } finally {
    log.mockRestore();
  }
});

test('GATE-SPEED A3①: gatePodCpu accepts a scalar or { request, limit } and refuses malformed values', () => {
  expect([parsePodCpu(undefined), parsePodCpu(null), parsePodCpu(''), parsePodCpu({})]).toEqual([undefined, undefined, undefined, undefined]);
  expect(parsePodCpu(2)).toEqual({ request: '2', limit: '2' });
  expect(parsePodCpu(' 1500m ')).toEqual({ request: '1500m', limit: '1500m' });
  expect(parsePodCpu({ limit: 2 })).toEqual({ limit: '2' });
  expect(() => parsePodCpu({ request: 3, limit: 2 })).toThrow('exceeds limit');
  expect(() => parsePodCpu({ request: 1, cores: 2 })).toThrow('unknown keys');
  expect(() => parsePodCpu('two')).toThrow('not a positive CPU quantity');
  expect(() => parsePodCpu([1])).toThrow('CPU quantity or { request, limit }');
  // Only a Pod gate reads it: without gatePodPool the value is not consulted.
  const { root } = fixture();
  const context = join(root, 'cpu-context.json');
  writeFileSync(context, JSON.stringify({ input: { commit: CUT, version: '1.0.1', previousVersion: '1.0.0', gatePodCpu: 'bad' }, outputs: {} }));
  expect(parseOptions(['--json'], { ELANOUS_GRAPH_CONTEXT: context })).toMatchObject({ pod: undefined });
  writeFileSync(context, JSON.stringify({ input: { commit: CUT, version: '1.0.1', previousVersion: '1.0.0', gatePodPool: 'p', gatePodCpu: 'bad' }, outputs: {} }));
  expect(() => parseOptions(['--json'], { ELANOUS_GRAPH_CONTEXT: context })).toThrow('not a positive CPU quantity');
});

test('with no baseline cache, the baseline is swept on the same Pod pool as the cut (K9b)', async () => {
  const { root, instanceRoot, runner: fixtureRunner, calls } = fake([], [], false);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const file = 'src/a.test.ts';
  const command: GateRunner['command'] = async (cmd, args, cwd) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: args.includes('-z') ? `${file}\0` : `${file}\n` };
    if (cmd === 'bun' && args[0] === 'run') return { rc: 0, output: `1 pass\n0 fail\nRan 1 test across 1 file.\n` };
    return fixtureRunner.command(cmd, args, cwd);
  };
  let podCalls = 0;
  const runner = createGateRunner(repo, 'test-host', command, async () => {
    podCalls++;
    const artifactsDir = join(root, `cut-shard-${podCalls}`);
    mkdirSync(artifactsDir);
    writeFileSync(join(artifactsDir, 'shard.log'), `1 pass\n0 fail\nRan 1 test across 1 file.\n`);
    writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
    return { exitCode: 0, artifactsDir, job: 'fake' };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 1, k3dCluster: 'test' }]));
  runner.recheckPod = undefined;
  runner.add = fixtureRunner.add;
  runner.remove = fixtureRunner.remove;
  runner.snapshot = fixtureRunner.snapshot;
  runner.removeSnapshot = fixtureRunner.removeSnapshot;
  const serialSweep = runner.sweep;
  const sweptTrees: string[] = [];
  runner.sweep = async (tree, logDir, pod, only) => {
    sweptTrees.push(tree);
    const run = await serialSweep(tree, logDir, pod, only);
    // The cut reports one failing file so the baseline has something to sweep (GATE-SPEED A4 skips a clean cut).
    return tree.endsWith('/cut') ? { ...run, rc: 1, output: runOutput([`${file} > A`]) } : run;
  };
  const result = await judgeGate({ ...options(instanceRoot), repo, pod: { pool: 'pool-test', shards: 1 } }, runner);
  expect(result).toMatchObject({ outcome: 'ok', baselineSource: 'swept' });
  expect(sweptTrees.map((tree) => tree.split('/').at(-1))).toEqual(['cut', 'baseline']);
  expect(podCalls).toBe(2);
  expect(calls.filter((call) => call.startsWith(`add ${BASE}`))).toHaveLength(1);
});

test('Pod sweep defaults to 24 shards with a 1200-second deadline', async () => {
  const { root, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const files = Array.from({ length: 30 }, (_, i) => `src/file-${String(i).padStart(2, '0')}.test.ts`);
  const invoked: RunPodCommandOptions[] = [];
  const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
    return fixtureRunner.command(cmd, args, cwd);
  }, async (o) => {
    invoked.push(o);
    const artifactsDir = join(root, `default-shard-${invoked.length}`);
    mkdirSync(artifactsDir);
    const assigned = files.filter((file) => o.command[2]!.includes(`'./${file}'`));
    writeFileSync(join(artifactsDir, 'shard.log'), `${assigned.length} pass\n0 fail\nRan ${assigned.length} tests across ${assigned.length} files.\n`);
    writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
    return { exitCode: 0, artifactsDir, job: 'fake' };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 24, k3dCluster: 'test' }]));
  const result = await runner.sweep(repo, undefined, { pool: 'pool-test' });
  expect(invoked).toHaveLength(24);
  expect(invoked.every((o) => o.deadlineSeconds === 1200 && o.source?.kind === 'commit')).toBe(true);
  expect(result.rc).toBe(0);
  expect(result.output).toContain('Ran 30 tests across 30 files.');
  await runner.sweep(repo, undefined, { pool: 'pool-test', shards: 3, shardTimeoutSeconds: 17 });
  expect(invoked.slice(24)).toHaveLength(3);
  expect(invoked.slice(24).every((o) => o.deadlineSeconds === 17)).toBe(true);
});

test('cut Pod loads two baseline junit reports, logs the plan and writes planned seconds for every assigned file', async () => {
  const { root, instanceRoot, ledgerRoot, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const files = Array.from({ length: 30 }, (_, i) => `src/file-${String(i).padStart(2, '0')}.test.ts`);
  const source = join(ledgerRoot, 'release/1.0.0/gate-logs/cut');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'pod-0.junit.xml'), `<testsuites><testsuite file="${files[0]}" time="100"/><testsuite file="${files[1]}" time="1"/></testsuites>`);
  writeFileSync(join(source, 'pod-1.junit.xml'), `<testsuites><testsuite file="${files[2]}" time="1"/></testsuites>`);
  const invoked: RunPodCommandOptions[] = [];
  const observations: Array<{ category: string; event: string; data: unknown }> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => { observations.push({ category, event, data }); });
  try {
    const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
      if (cmd === 'rg') return { rc: 1, output: '' };
      if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
      if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: [...files].reverse().join('\n') };
      return fixtureRunner.command(cmd, args, cwd);
    }, async (o) => {
      invoked.push(o);
      const assigned = files.filter((file) => o.command[2]!.includes(`'./${file}'`));
      const artifactsDir = join(root, `timed-${invoked.length}`);
      mkdirSync(artifactsDir);
      writeFileSync(join(artifactsDir, 'shard.log'), `${assigned.length} pass\n0 fail\nRan ${assigned.length} tests across ${assigned.length} files.\n`);
      writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
      return { exitCode: 0, artifactsDir, job: 'fake' };
    }, new PodPoolScheduler([{ context: 'pool-test', capacity: 24, k3dCluster: 'test' }]));
    runner.add = fixtureRunner.add;
    runner.remove = fixtureRunner.remove;
    runner.snapshot = fixtureRunner.snapshot;
    runner.removeSnapshot = fixtureRunner.removeSnapshot;
    const result = await judgeGate({ ...options(instanceRoot), ledgerRoot, repo, pod: { pool: 'pool-test' } }, runner);
    expect(result).toMatchObject({ outcome: 'ok', introduced: [], preexisting: 0, fixed: 0 });
    expect(invoked).toHaveLength(24);
    const assigned = invoked.map((o) => files.filter((file) => o.command[2]!.includes(`'./${file}'`)));
    expect(assigned.flat().sort()).toEqual(files);
    expect(assigned[0]).toEqual([files[0]]);
    const logs = join(instanceRoot, 'release/1.0.1/gate-logs/cut');
    const json = assigned.map((_, i) => JSON.parse(readFileSync(join(logs, `pod-${i}.json`), 'utf8')) as { files: string[]; plannedSeconds: number });
    expect(json.map((entry) => entry.files)).toEqual(assigned);
    expect(json[0]!.plannedSeconds).toBe(100);
    expect(json.reduce((sum, entry) => sum + entry.plannedSeconds, 0)).toBe(129);
    expect(observations).toContainEqual({ category: 'release-loop.gate', event: 'pod-shard-plan', data: {
      shards: 24, known: 3, unknown: 27, maxPlannedSeconds: 100, source,
    } });
  } finally { log.mockRestore(); }
});

test('judgeGate plans cut and swept baseline from the prior ledger JUnit; the longest file sets the LPT critical path without changing shards.json', async () => {
  const { root, instanceRoot, ledgerRoot, runner: fixtureRunner } = fake([], [], false);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const files = ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts', 'src/d.test.ts'];
  const source = join(ledgerRoot, 'release/1.0.0/gate-logs/cut');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'pod-0.junit.xml'), `<testsuites>${files.map((file, index) => `<testsuite file="${file}" time="${index === 0 ? 100 : 1}"/>`).join('')}</testsuites>`);
  const assigned: Array<{ tree: string; files: string[] }> = [];
  let cutBoard: { v: number; version: string; updatedAt: string; shards: Array<Record<string, unknown>> } | undefined;
  const observations: unknown[] = [];
  const spy = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'release-loop.gate' && event === 'pod-shard-plan') observations.push(data);
  });
  try {
    const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
      if (cmd === 'rg') return { rc: 1, output: '' };
      if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: cwd.endsWith('/baseline') ? BASE : CUT };
      if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: args.includes('-z') ? 'src/a.test.ts\0' : `${files.join('\n')}\n` };
      return fixtureRunner.command(cmd, args, cwd);
    }, async (o) => {
      const paths = files.filter((file) => o.command[2]!.includes(`'./${file}'`));
      const tree = o.source?.kind === 'commit' && o.source.sha === BASE ? 'baseline' : 'cut';
      assigned.push({ tree, files: paths });
      const artifactsDir = join(root, `lpt-${assigned.length}`);
      mkdirSync(artifactsDir);
      const fails = tree === 'cut' && paths.includes(files[0]!) ? [A] : [];
      writeFileSync(join(artifactsDir, 'shard.log'), `${fails.length ? 'src/a.test.ts:\n(fail) A [1.00ms]\n' : ''}${paths.length - fails.length} pass\n${fails.length} fail\nRan ${paths.length} tests across ${paths.length} files.\n`);
      writeFileSync(join(artifactsDir, 'shard.rc'), `${fails.length ? 1 : 0}\n`);
      return { exitCode: 0, artifactsDir, job: 'fake' };
    }, new PodPoolScheduler([{ context: 'pool-test', capacity: 2, k3dCluster: 'test' }]));
    runner.recheckPod = undefined;
    runner.add = fixtureRunner.add;
    runner.remove = fixtureRunner.remove;
    runner.snapshot = fixtureRunner.snapshot;
    runner.removeSnapshot = fixtureRunner.removeSnapshot;
    const sweep = runner.sweep;
    runner.sweep = async (tree, logDir, pod, only) => {
      const result = await sweep(tree, logDir, pod, only);
      if (tree.endsWith('/cut')) cutBoard = JSON.parse(readFileSync(gateShardsPath('1.0.1', ledgerRoot), 'utf8'));
      return result;
    };
    const result = await judgeGate({ ...options(instanceRoot), ledgerRoot, repo, pod: { pool: 'pool-test', shards: 2 } }, runner);
    expect(result).toMatchObject({ outcome: 'ok', baselineSource: 'swept', baselineDeferred: { cutFiles: 1, swept: 1 }, preexisting: 1 });
    expect(assigned).toEqual([
      { tree: 'cut', files: [files[0]!] }, { tree: 'cut', files: files.slice(1) },
      { tree: 'baseline', files: [files[0]!] },
    ]);
    expect(observations).toEqual([
      { shards: 2, known: 4, unknown: 0, maxPlannedSeconds: 100, source },
      { shards: 1, known: 1, unknown: 0, maxPlannedSeconds: 100, source },
    ]);
    expect(cutBoard).toBeDefined();
    const board = cutBoard!;
    expect(Object.keys(board).sort()).toEqual(['shards', 'updatedAt', 'v', 'version']);
    expect(board.v).toBe(1);
    expect(board.version).toBe('1.0.1');
    expect(board.shards).toHaveLength(2);
    expect(board.shards.map((row) => row.plannedMin)).toEqual([1.7, 0.1]);
    for (const row of board.shards) {
      expect(Object.keys(row).sort()).toEqual(['endedAt', 'id', 'plannedMin', 'rc', 'state']);
      expect(row.state).toBe('done');
    }
  } finally { spy.mockRestore(); }
});

test('the Pod sweep never assigns an integration-only file and logs that it left it out (0.2.7 run 5 install.test stall)', async () => {
  const { root, instanceRoot, ledgerRoot, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const files = ['scripts/install.test.ts', 'src/a.test.ts', 'src/b.test.ts'];
  const invoked: RunPodCommandOptions[] = [];
  const observations: Array<{ category: string; event: string; data: unknown }> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => { observations.push({ category, event, data }); });
  try {
    const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
      if (cmd === 'rg') return { rc: 1, output: '' };
      if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
      if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
      return fixtureRunner.command(cmd, args, cwd);
    }, async (o) => {
      invoked.push(o);
      const assigned = files.filter((file) => o.command[2]!.includes(`'./${file}'`));
      const artifactsDir = join(root, `excl-${invoked.length}`);
      mkdirSync(artifactsDir);
      writeFileSync(join(artifactsDir, 'shard.log'), `${assigned.length} pass\n0 fail\nRan ${assigned.length} tests across ${assigned.length} files.\n`);
      writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
      return { exitCode: 0, artifactsDir, job: 'fake' };
    }, new PodPoolScheduler([{ context: 'pool-test', capacity: 24, k3dCluster: 'test' }]));
    runner.add = fixtureRunner.add;
    runner.remove = fixtureRunner.remove;
    runner.snapshot = fixtureRunner.snapshot;
    runner.removeSnapshot = fixtureRunner.removeSnapshot;
    const result = await judgeGate({ ...options(instanceRoot), ledgerRoot, repo, pod: { pool: 'pool-test' } }, runner);
    expect(result).toMatchObject({ outcome: 'ok' });
    const assigned = invoked.flatMap((o) => files.filter((file) => o.command[2]!.includes(`'./${file}'`)));
    expect(assigned).not.toContain('scripts/install.test.ts');
    expect(assigned.sort()).toEqual(['src/a.test.ts', 'src/b.test.ts']);
    expect(observations).toContainEqual({ category: 'release-loop.gate', event: 'pod-sweep-integration-only', data: { files: ['scripts/install.test.ts'] } });
  } finally { log.mockRestore(); }
});

test('nightly audit files keep their fixture cases in Pod and local gate sweeps', async () => {
  expect(POD_SWEEP_INTEGRATION_ONLY).toEqual(['scripts/install.test.ts', 'scripts/review-model-ab.test.ts']);
  expect(GATE_NIGHTLY_AUDITS).toEqual([
    'test/f12-sweep.test.ts', 'scripts/unwired-exports.test.ts', 'test/pwa-build-typecheck.test.ts',
  ]);
  const { root } = fixture();
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const files = [...GATE_NIGHTLY_AUDITS, 'test/guardian/dispatch-surface-contract.test.ts', 'test/user-config-mcp.test.ts', 'src/a.test.ts', 'test/other.test.ts', 'scripts/other.test.ts'];
  const commands: string[] = [];
  const events: Array<{ category: string; event: string; data: unknown }> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => { events.push({ category, event, data }); });
  try {
    const runner = createGateRunner(repo, 'test-host', async (cmd, args) => {
      if (cmd === 'rg') return { rc: 1, output: '' };
      if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
      if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
      if (cmd === 'bun') { commands.push(args.join(' ')); return { rc: 0, output: '1 pass\n0 fail\nRan 1 test across 1 file.\n' }; }
      throw new Error(`unexpected ${cmd}`);
    }, async (o) => {
      commands.push(o.command[2]!);
      const artifactsDir = join(root, o.name!);
      mkdirSync(artifactsDir);
      const count = files.filter((file) => o.command[2]!.includes(`'./${file}'`)).length;
      writeFileSync(join(artifactsDir, 'shard.log'), `${count} pass\n0 fail\nRan ${count} tests across ${count} files.\n`);
      writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
      return { exitCode: 0, artifactsDir, job: 'fake' };
    }, new PodPoolScheduler([{ context: 'pool-test', capacity: 1, k3dCluster: 'test' }]));
    expect((await runner.sweep(repo, undefined, { pool: 'pool-test', shards: 1 })).rc).toBe(0);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("'./src/a.test.ts'");
    expect(files.every((file) => commands[0]!.includes(`'./${file}'`))).toBe(true);
    expect(events.some((event) => event.event === 'pod-sweep-nightly-audit')).toBe(false);
    commands.length = 0;
    expect((await runner.sweep(repo)).rc).toBe(0);
    expect(commands).toHaveLength(3);
    for (const file of files.filter((path) => path.startsWith('test/') || path.startsWith('scripts/'))) {
      const group = file.startsWith('test/') ? './test' : './scripts';
      expect(commands.find((cmd) => cmd.includes(group))).not.toContain(`--path-ignore-patterns ${file}`);
    }
  } finally { log.mockRestore(); }
});

test('Pod accepts Ran 4 tests across 3 files out of four assigned without retrying', async () => {
  const { root, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const files = Array.from({ length: 12 }, (_, i) => `src/${String.fromCharCode(97 + i)}.test.ts`);
  const calls: number[] = [];
  const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
    return fixtureRunner.command(cmd, args, cwd);
  }, async (o) => {
    const paths = files.filter((file) => o.command[2]!.includes(`'./${file}'`));
    calls.push(paths.length);
    const artifactsDir = join(root, `short-summary-${calls.length}`);
    mkdirSync(artifactsDir);
    writeFileSync(join(artifactsDir, 'shard.log'), `4 pass\n0 fail\nRan 4 tests across ${paths.includes(files[0]!) ? 3 : 4} files.\n`);
    writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
    return { exitCode: 0, artifactsDir, job: 'fake' };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 3, k3dCluster: 'test' }]));
  const result = await runner.sweep(repo, undefined, { pool: 'pool-test', shards: 3 });
  expect(calls).toEqual([4, 4, 4]);
  expect(result.rc).toBe(0);
  expect(result.output).toContain('Ran 12 tests across 11 files.');
});

test('a no-output Pod shard retries once in a fresh Job and its measured result determines the gate', async () => {
  for (const retryOutcome of ['pass', 'fail', 'stall', 'hang'] as const) {
    const stalls = retryOutcome === 'stall' || retryOutcome === 'hang';
    const { root, instanceRoot, runner: fixtureRunner } = fake([], []);
    const repo = join(root, 'repo');
    mkdirSync(repo);
    const files = ['src/a.test.ts', 'src/b.test.ts'];
    const invoked: RunPodCommandOptions[] = [];
    const retries: unknown[] = [];
    const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
      if (category === 'release-loop.gate' && event === 'pod-shard-retry') retries.push(data);
    });
    try {
      const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
        if (cmd === 'rg') return { rc: 1, output: '' };
        if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
        if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
        return fixtureRunner.command(cmd, args, cwd);
      }, async (o) => {
        invoked.push(o);
        const artifactsDir = join(root, o.name!);
        mkdirSync(artifactsDir);
        const isB = o.command[2]!.includes("'./src/b.test.ts'");
        const bAttempt = invoked.filter((call) => call.command[2]!.includes("'./src/b.test.ts'")).length;
        if (isB && (bAttempt === 1 || stalls)) return { exitCode: 0, artifactsDir, job: 'fake' };
        const failed = isB && retryOutcome === 'fail';
        writeFileSync(join(artifactsDir, 'shard.log'), failed
          ? 'src/b.test.ts:\n(fail) B [1.00ms]\n0 pass\n1 fail\nRan 1 test across 1 file.\n'
          : '1 pass\n0 fail\nRan 1 test across 1 file.\n');
        writeFileSync(join(artifactsDir, 'shard.rc'), failed ? '1\n' : '0\n');
        return { exitCode: 0, artifactsDir, job: 'fake' };
      }, new PodPoolScheduler([{ context: 'pool-test', capacity: 2, k3dCluster: 'test' }]));
      runner.recheckPod = undefined;
      runner.add = fixtureRunner.add;
      runner.remove = fixtureRunner.remove;
      runner.snapshot = fixtureRunner.snapshot;
      runner.removeSnapshot = fixtureRunner.removeSnapshot;
      runner.localCommand = async () => (retryOutcome === 'hang'
        ? { rc: 2, output: '\nSystemError: spawnSync bun ETIMEDOUT', timedOut: true }
        : { rc: 0, output: runOutput([]) });
      const result = await judgeGate({ ...options(instanceRoot), repo, pod: { pool: 'pool-test', shards: 2 } }, runner);
      expect(invoked).toHaveLength(3);
      expect(invoked.map((call) => files.filter((file) => call.command[2]!.includes(`'./${file}'`)))).toEqual([[files[0]!], [files[1]!], [files[1]!]]);
      expect(new Set(invoked.map((call) => call.name)).size).toBe(3);
      expect(invoked[1]!.source).toEqual(invoked[2]!.source);
      expect(retries).toEqual([{ shard: 1, files: [files[1]!], reason: 'no-output', outcome: stalls ? 'no-output' : 'ok' }]);
      if (stalls) {
        expect(result).toMatchObject({ outcome: 'ok', introduced: [], stalledEnv: [{ file: files[1]!, reason: 'no-output', local: retryOutcome === 'hang' ? 'timeout' : 'passed' }] });
        expect(existsSync(join(instanceRoot, 'release/1.0.1/gate-failures.json'))).toBe(false);
      } else {
        expect(result).toMatchObject({ outcome: retryOutcome === 'pass' ? 'ok' : 'regression', introduced: retryOutcome === 'pass' ? [] : [B] });
        expect(result.stalledShards).toBeUndefined();
        expect(JSON.parse(readFileSync(join(instanceRoot, 'release/1.0.1/gate-failures.json'), 'utf8')).failures).toEqual(retryOutcome === 'pass' ? [] : [B]);
      }
    } finally { log.mockRestore(); }
  }
});

test('GATE-STALL2: two silent Pod jobs produce a verdict from other shards and one host run per stalled file', async () => {
  for (const localFails of [false, true]) {
    const { root, instanceRoot, runner: fixtureRunner } = fake([A], [A]);
    const repo = join(root, 'repo');
    mkdirSync(repo);
    const files = ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts'];
    const attempts: string[] = [];
    const local: string[] = [];
    const events: unknown[] = [];
    const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
      if (category === 'release-loop.gate' && event === 'pod-shard-stalled-env') events.push(data);
    });
    try {
      const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
        if (cmd === 'rg') return { rc: 1, output: '' };
        if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
        if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
        return fixtureRunner.command(cmd, args, cwd);
      }, async (o) => {
        const assigned = files.filter((file) => o.command[2]!.includes(`'./${file}'`));
        attempts.push(assigned.join(','));
        const artifactsDir = join(root, o.name!);
        mkdirSync(artifactsDir);
        if (assigned.includes('src/b.test.ts')) return { exitCode: 0, artifactsDir, job: 'fake' };
        const isA = assigned.includes('src/a.test.ts');
        writeFileSync(join(artifactsDir, 'shard.log'), isA
          ? `src/a.test.ts:\n(fail) A [1.00ms]\n0 pass\n1 fail\nRan 1 test across 1 file.\n`
          : '1 pass\n0 fail\nRan 1 test across 1 file.\n');
        writeFileSync(join(artifactsDir, 'shard.rc'), isA ? '1\n' : '0\n');
        return { exitCode: 0, artifactsDir, job: 'fake' };
      }, new PodPoolScheduler([{ context: 'pool-test', capacity: 3, k3dCluster: 'test' }]));
      runner.recheckPod = undefined;
      runner.add = fixtureRunner.add;
      runner.remove = fixtureRunner.remove;
      runner.snapshot = fixtureRunner.snapshot;
      runner.removeSnapshot = fixtureRunner.removeSnapshot;
      runner.localCommand = async (cmd, args) => {
        if (cmd === 'bun' && args[0] === 'run') {
          local.push(args[2]!);
          const ids = localFails ? [B] : [];
          return { rc: ids.length ? 1 : 0, output: runOutput(ids) };
        }
        return { rc: 0, output: '' };
      };
      const result = await judgeGate({ ...options(instanceRoot), repo, pod: { pool: 'pool-test', shards: 3 } }, runner);
      expect(result).toMatchObject({ outcome: localFails ? 'regression' : 'ok', introduced: localFails ? [B] : [],
        preexisting: 1, stalledEnv: [{ file: 'src/b.test.ts', reason: 'no-output', local: localFails ? 'failed' : 'passed' }] });
      expect(graphGateResult(result, true).verdict).toBe(localFails ? 'fail' : 'pass');
      expect(graphGateResult(result, true).summary).toContain(localFails ? '환경 멈춤 1 (Pod 밖 통과 0)' : '환경 멈춤 1 (Pod 밖 통과 1)');
      expect(attempts.filter((path) => path === 'src/b.test.ts')).toHaveLength(2);
      expect(local.filter((path) => path === './src/b.test.ts')).toHaveLength(1);
      expect(events).toContainEqual({ files: [{ file: 'src/b.test.ts', reason: 'no-output' }],
        local: [{ file: 'src/b.test.ts', reason: 'no-output', local: localFails ? 'failed' : 'passed' }] });
      expect(existsSync(join(instanceRoot, 'release/1.0.1/gate-failures.json'))).toBe(false);
    } finally { log.mockRestore(); }
  }
});

test('a stalled one-file Pod leaf is remeasured on another pool member and merged into the sweep', async () => {
  const { root, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const file = 'src/stalled.test.ts';
  const members = [
    { context: 'pool-a', sshHost: 'host-a', capacity: 1, k3dCluster: 'test' },
    { context: 'pool-b', sshHost: 'host-b', capacity: 1, k3dCluster: 'test' },
  ];
  const placements: string[] = [];
  let activeHost = '';
  const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: file };
    return fixtureRunner.command(cmd, args, cwd);
  }, async (options) => {
    const member = await options.poolScheduler!.tryAcquire();
    if (!member) throw new Error('fake pool unexpectedly had no available member');
    activeHost = member.context;
    placements.push(member.context);
    const artifactsDir = join(root, `tail-remeasure-${placements.length}`);
    mkdirSync(artifactsDir);
    try {
      if (member.context === 'pool-a') {
        // Keep the Job open until the stall watch observes checkout with no test output.
        await new Promise((resolve) => setTimeout(resolve, 2_200));
        return { exitCode: 0, artifactsDir, job: `fake-${member.context}` };
      }
      writeFileSync(join(artifactsDir, 'shard.log'), '1 pass\n0 fail\nRan 1 test across 1 file.\n');
      writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
      return { exitCode: 0, artifactsDir, job: `fake-${member.context}` };
    } finally {
      options.poolScheduler!.release(member);
    }
  }, new PodPoolScheduler(members, { occupancy: () => Object.fromEntries(members.map((member) => [member.context, { occupied: 0 }])) }));
  const result = await runner.sweep(repo, undefined, {
    pool: 'pool-a@host-a:1,pool-b@host-b:1', shards: 1, stallSeconds: 0.001, stallPollMs: 1,
    liveLog: () => activeHost === 'pool-a'
      ? `ELANOUS_POD_SOURCE commit ${CUT}\nELANOUS_GATE_BEAT 1 install 0\n`
      : `ELANOUS_POD_SOURCE commit ${CUT}\nELANOUS_GATE_BEAT 1 test 1 8\n`,
    stopJob: () => true,
  });
  expect(placements).toEqual(['pool-a', 'pool-a', 'pool-b']);
  expect(result).toMatchObject({ rc: 0, stalledEnv: [], passedIds: [] });
  expect(result.output).toContain('1 pass\n0 fail\n0 errors\nRan 1 tests across 1 files.');
});

test('a failed tail remeasure preserves the original stall and does not launch another Pod', async () => {
  const { root, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const file = 'src/stalled.test.ts';
  const members = [
    { context: 'pool-a', sshHost: 'host-a', capacity: 1, k3dCluster: 'test' },
    { context: 'pool-b', sshHost: 'host-b', capacity: 1, k3dCluster: 'test' },
  ];
  const placements: string[] = [];
  let activeHost = '';
  const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: file };
    return fixtureRunner.command(cmd, args, cwd);
  }, async (options) => {
    const member = await options.poolScheduler!.tryAcquire();
    if (!member) throw new Error('fake pool unexpectedly had no available member');
    activeHost = member.context;
    placements.push(member.context);
    const artifactsDir = join(root, `tail-remeasure-fail-${placements.length}`);
    mkdirSync(artifactsDir);
    try {
      if (member.context === 'pool-a') {
        await new Promise((resolve) => setTimeout(resolve, 2_200));
        return { exitCode: 0, artifactsDir, job: `fake-${member.context}` };
      }
      return { exitCode: 1, artifactsDir, job: `fake-${member.context}`, jobFailed: true, jobError: 'member lost' };
    } finally {
      options.poolScheduler!.release(member);
    }
  }, new PodPoolScheduler(members, { occupancy: () => Object.fromEntries(members.map((member) => [member.context, { occupied: 0 }])) }));
  let failure: unknown;
  try {
    await runner.sweep(repo, undefined, {
      pool: 'pool-a@host-a:1,pool-b@host-b:1', shards: 1, stallSeconds: 0.001, stallPollMs: 1,
      probeMember: (member) => member.context !== 'pool-b',
      liveLog: () => activeHost === 'pool-a'
        ? `ELANOUS_POD_SOURCE commit ${CUT}\nELANOUS_GATE_BEAT 1 install 0\n`
        : '',
      stopJob: () => true,
    });
  } catch (error) { failure = error; }
  expect(placements).toEqual(['pool-a', 'pool-a', 'pool-b']);
  expect(failure).toMatchObject({ stalledShards: [{ shard: 0, files: [file], reason: 'no-output', lastHost: 'pool-a',
    stall: { seconds: expect.any(Number), sinceCheckoutMs: expect.any(Number) }, tailRemeasure: { reason: 'job-failed', host: 'pool-b' } }] });
});

test('a silent Pod shard does not hide a separate measured shard regression', async () => {
  const { root, instanceRoot, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: 'src/b.test.ts\nsrc/c.test.ts\n' };
    if (cmd === 'bun' && args[0] === 'run' && args[2] === './src/c.test.ts') return { rc: cwd.endsWith('/cut') ? 1 : 0, output: runOutput(cwd.endsWith('/cut') ? [C] : []) };
    return fixtureRunner.command(cmd, args, cwd);
  }, async (o) => {
    const artifactsDir = join(root, o.name!);
    mkdirSync(artifactsDir);
    if (o.command[2]!.includes("'./src/c.test.ts'")) {
      writeFileSync(join(artifactsDir, 'shard.log'), `0 pass\n${runOutput([C])}`);
      writeFileSync(join(artifactsDir, 'shard.rc'), '1\n');
    }
    return { exitCode: 0, artifactsDir, job: 'fake' };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 2, k3dCluster: 'test' }]));
  runner.add = fixtureRunner.add;
  runner.remove = fixtureRunner.remove;
  runner.snapshot = fixtureRunner.snapshot;
  runner.removeSnapshot = fixtureRunner.removeSnapshot;
  runner.localCommand = async () => ({ rc: 0, output: runOutput([]) });
  runner.recheckPod = async (_file, commit) => ({ rc: commit === CUT ? 1 : 0, output: runOutput(commit === CUT ? [C] : []) });
  runner.recheckPodBatch = undefined;
  const result = await judgeGate({ ...options(instanceRoot), repo, pod: { pool: 'pool-test', shards: 2 } }, runner);
  expect(result).toMatchObject({ outcome: 'regression', introduced: [C], preexisting: 0,
    stalledEnv: [{ file: 'src/b.test.ts', reason: 'no-output', local: 'passed' }] });
  expect(graphGateResult(result, true).verdict).toBe('fail');
});

test('a silent Pod shard preserves a completed zero-test file error when the stalled file passes on the host', async () => {
  const { root, instanceRoot, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const files = ['src/b.test.ts', 'src/c.test.ts'];
  const attempts: string[] = [];
  const hostRuns: string[] = [];
  const fileError = 'src/c.test.ts:\n# Unhandled error between tests\n0 pass\n0 fail\n1 errors\nRan 0 tests across 1 file.\n';
  const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
    if (cmd === 'bun' && args[0] === 'run' && args[2] === './src/c.test.ts') {
      return { rc: cwd.endsWith('/cut') ? 1 : 0, output: cwd.endsWith('/cut') ? fileError : runOutput([]) };
    }
    return fixtureRunner.command(cmd, args, cwd);
  }, async (o) => {
    const file = files.find((path) => o.command[2]!.includes(`'./${path}'`))!;
    attempts.push(file);
    const artifactsDir = join(root, o.name!);
    mkdirSync(artifactsDir);
    if (file === 'src/c.test.ts') {
      writeFileSync(join(artifactsDir, 'shard.log'), fileError);
      writeFileSync(join(artifactsDir, 'shard.rc'), '1\n');
    }
    return { exitCode: 0, artifactsDir, job: 'fake' };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 2, k3dCluster: 'test' }]));
  runner.add = fixtureRunner.add;
  runner.remove = fixtureRunner.remove;
  runner.snapshot = fixtureRunner.snapshot;
  runner.removeSnapshot = fixtureRunner.removeSnapshot;
  runner.localCommand = async (cmd, args) => {
    if (cmd === 'bun' && args[0] === 'run') hostRuns.push(args[2]!);
    return { rc: 0, output: runOutput([]) };
  };
  runner.recheckPod = async (_file, commit) => ({ rc: commit === CUT ? 1 : 0, output: commit === CUT ? fileError : runOutput([]) });
  runner.recheckPodBatch = undefined;
  const result = await judgeGate({ ...options(instanceRoot), repo, pod: { pool: 'pool-test', shards: 2 } }, runner);
  expect(result).toMatchObject({ outcome: 'error', introduced: [], unmeasuredRecheckFiles: ['src/c.test.ts'],
    unmeasuredErrors: [{ file: 'src/c.test.ts', reason: 'reproduced', ids: ['src/c.test.ts > [error]'] }], preexisting: 0,
    stalledEnv: [{ file: 'src/b.test.ts', reason: 'no-output', local: 'passed' }] });
  expect(graphGateResult(result, true).verdict).toBe('fail');
  expect(attempts).toEqual(['src/b.test.ts', 'src/c.test.ts', 'src/b.test.ts']);
  expect(hostRuns).toEqual(['./src/b.test.ts']);
  writeFileSync(join(instanceRoot, 'release/1.0.0/gate-failures.json'), JSON.stringify({ commit: BASE, failures: [], errors: ['src/c.test.ts > [error]'] }));
  const preexisting = await judgeGate({ ...options(instanceRoot), repo, pod: { pool: 'pool-test', shards: 2 } }, runner);
  expect(preexisting).toMatchObject({ outcome: 'error', introduced: [], preexisting: 0,
    unmeasuredRecheckFiles: ['src/c.test.ts'],
    stalledEnv: [{ file: 'src/b.test.ts', reason: 'no-output', local: 'passed' }] });
  expect(hostRuns).toEqual(['./src/b.test.ts', './src/b.test.ts']);
});

test('remote Pod stall runs the host fallback against a local cut checkout, not the SSH checkout', async () => {
  const { root, instanceRoot, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const host: Array<{ cmd: string; args: string[]; cwd: string }> = [];
  const runner = createGateRunner(repo, 'test-host', async (cmd, args, cwd) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: 'src/b.test.ts\n' };
    if (cmd === 'mktemp') return { rc: 0, output: '/tmp/release-gate-stall2-remote\n' };
    return fixtureRunner.command(cmd, args, cwd);
  }, async (o) => {
    const artifactsDir = join(root, o.name!);
    mkdirSync(artifactsDir);
    return { exitCode: 0, artifactsDir, job: 'fake' };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 1, k3dCluster: 'test' }]));
  runner.add = fixtureRunner.add;
  runner.remove = fixtureRunner.remove;
  runner.snapshot = fixtureRunner.snapshot;
  runner.removeSnapshot = fixtureRunner.removeSnapshot;
  runner.localCommand = async (cmd, args, cwd) => {
    host.push({ cmd, args, cwd });
    return { rc: 0, output: cmd === 'bun' && args[0] === 'run' ? runOutput([]) : '' };
  };
  const result = await judgeGate({ ...options(instanceRoot), repo, remote: 'test-host', pod: { pool: 'pool-test', shards: 1 } }, runner);
  expect(result).toMatchObject({ outcome: 'ok', stalledEnv: [{ file: 'src/b.test.ts', reason: 'no-output', local: 'passed' }] });
  const checkout = host.find((call) => call.cmd === 'git' && call.args[0] === 'clone')!;
  const hostTree = checkout.args.at(-1)!;
  expect(checkout.args).toEqual(['clone', '--quiet', '--shared', '--no-checkout', repo, hostTree]);
  expect(host).toContainEqual({ cmd: 'git', args: ['checkout', '--quiet', '--detach', CUT], cwd: hostTree });
  expect(host.filter((call) => call.cmd === 'bun' && call.args[0] === 'run')).toEqual([
    { cmd: 'bun', args: ['run', 'test:deterministic', './src/b.test.ts'], cwd: hostTree },
  ]);
  expect(hostTree).toMatch(/release-gate-local-/);
  expect(hostTree).not.toContain('release-gate-stall2-remote');
  expect(existsSync(dirname(hostTree))).toBe(false);
});

test('Pod splits OOMKilled four-file shard into two two-file jobs without repeating original', async () => {
  const { root, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const files = Array.from({ length: 12 }, (_, i) => `src/${String.fromCharCode(97 + i)}.test.ts`);
  const calls: number[] = [];
  const splitEvents: unknown[] = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'release-loop.gate' && event === 'pod-shard-split') splitEvents.push(data);
  });
  try {
    const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
      if (cmd === 'rg') return { rc: 1, output: '' };
      if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
      if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
      return fixtureRunner.command(cmd, args, cwd);
    }, async (o) => {
      const paths = files.filter((file) => o.command[2]!.includes(`'./${file}'`));
      const inFirst = paths.some((file) => files.indexOf(file) % 3 === 0);
      if (inFirst) calls.push(paths.length);
      const artifactsDir = join(root, `oom-shard-${o.name}`);
      mkdirSync(artifactsDir);
      if (inFirst && paths.length === 4) return { exitCode: 137, artifactsDir, job: 'fake' };
      writeFileSync(join(artifactsDir, 'shard.log'), `${paths.length} pass\n0 fail\nRan ${paths.length} tests across ${paths.length} files.\n`);
      writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
      return { exitCode: 0, artifactsDir, job: 'fake' };
    }, new PodPoolScheduler([{ context: 'pool-test', capacity: 3, k3dCluster: 'test' }]));
    const result = await runner.sweep(repo, undefined, { pool: 'pool-test', shards: 3 });
    expect(calls).toEqual([4, 2, 2]);
    expect(result.rc).toBe(0);
    expect(result.output).toContain('Ran 12 tests across 12 files.');
    expect(splitEvents).toContainEqual({ shard: 0, depth: 0, files: [files[0], files[3], files[6], files[9]], reason: 'job-failed' });
  } finally { log.mockRestore(); }
});

test('GT1: a 60-file root shard that OOMs retries as 27/27/6 chunks at once, never halving', async () => {
  const { root, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const files = Array.from({ length: 60 }, (_, i) => `src/f${String(i).padStart(2, '0')}.test.ts`);
  mkdirSync(join(repo, 'release'));
  writeFileSync(join(repo, 'release/gate-batch-safe.json'), JSON.stringify({ env: 'linux-pod', tests: files.map((file) => ({ file, evidence: 'synthetic cap fixture' })) }));
  const sizes: number[] = [];
  const shells: string[] = [];
  const events: Array<[string, unknown]> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'release-loop.gate' && (event === 'pod-shard-split' || event === 'pod-shard-cap-split')) events.push([event, data]);
  });
  try {
    const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
      if (cmd === 'rg') return { rc: 1, output: '' };
      if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
      if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
      return fixtureRunner.command(cmd, args, cwd);
    }, async (o) => {
      const paths = files.filter((file) => o.command[2]!.includes(`'./${file}'`));
      sizes.push(paths.length);
      shells.push(o.command[2]!);
      const artifactsDir = join(root, `cap-shard-${o.name}`);
      rmSync(artifactsDir, { recursive: true, force: true });
      mkdirSync(artifactsDir);
      if (paths.length > POD_SHARD_FILE_CAP) return { exitCode: 137, artifactsDir, job: 'fake' };
      if (!o.command[2]!.includes('gate-isolate.')) {
        writeFileSync(join(artifactsDir, 'shard.log'), `${paths.length} pass\n0 fail\nRan ${paths.length} tests across ${paths.length} files.\n`);
        writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
        return { exitCode: 0, artifactsDir, job: 'fake' };
      }
      // A cap chunk is now one Job with file-isolated parts; provide the same artifact contract as that Job.
      writeFileSync(join(artifactsDir, 'install.rc'), '0\n');
      paths.forEach((file, index) => {
        writeFileSync(join(artifactsDir, `part-${index}.log`), `${file}:\n(pass) case [1.00ms]\n1 pass\n0 fail\nRan 1 test across 1 file.\n`);
        writeFileSync(join(artifactsDir, `part-${index}.rc`), '0\n');
        writeFileSync(join(artifactsDir, `part-${index}.junit.xml`), `<testsuites><testsuite file="${file}" tests="1"><testcase name="case"/></testsuite></testsuites>`);
      });
      return { exitCode: 0, artifactsDir, job: 'fake' };
    }, new PodPoolScheduler([{ context: 'pool-test', capacity: 4, k3dCluster: 'test' }]));
    const result = await runner.sweep(repo, undefined, { pool: 'pool-test', shards: 1 });
    expect(sizes[0]).toBe(60);
    expect(sizes.slice(1).sort((a, b) => b - a)).toEqual([27, 27, 6]);
    expect(shells.slice(1).every((shell) => shell.includes('pids+=('))).toBe(true);
    expect(result.rc).toBe(0);
    expect(result.output).toContain('Ran 60 tests across 60 files.');
    expect(events.map(([event]) => event)).toEqual(['pod-shard-cap-split']);
    expect(events[0]![1]).toMatchObject({ shard: 0, files: 60, chunks: 3, cap: 27 });
    writeFileSync(join(repo, 'release/gate-batch-safe.json'), JSON.stringify({ env: 'linux-pod', tests: [] }));
    sizes.length = 0; shells.length = 0;
    const defaultResult = await runner.sweep(repo, undefined, { pool: 'pool-test', shards: 1 });
    expect(sizes).toEqual([60, 27, 27, 6]);
    expect(shells.slice(1).every((shell) => !shell.includes('gate-isolate.'))).toBe(true);
    expect(defaultResult.rc).toBe(0);
  } finally { log.mockRestore(); }
});

test('Pod isolates an OOM file and retains the other three measured passes', async () => {
  const { root, instanceRoot, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const files = ['src/a.test.ts', 'src/boom.test.ts', 'src/c.test.ts', 'src/d.test.ts'];
  const calls: string[][] = [];
  const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
    return fixtureRunner.command(cmd, args, cwd);
  }, async (o) => {
    const assigned = files.filter((file) => o.command[2]!.includes(`'./${file}'`));
    calls.push(assigned);
    const artifactsDir = join(root, `oom-${calls.length}`);
    mkdirSync(artifactsDir);
    if (assigned.includes('src/boom.test.ts')) return { exitCode: 137, artifactsDir, job: 'fake' };
    writeFileSync(join(artifactsDir, 'shard.log'), `${assigned.length} pass\n0 fail\nRan ${assigned.length} tests across ${assigned.length} files.\n`);
    writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
    return { exitCode: 0, artifactsDir, job: 'fake' };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 4, k3dCluster: 'test' }]),
  () => 'startup\nsrc/boom.test.ts:\n');
  runner.add = fixtureRunner.add;
  runner.remove = fixtureRunner.remove;
  const result = await judgeGate({ ...options(instanceRoot), repo, pod: { pool: 'pool-test', shards: 1 } }, runner);
  expect(result).toMatchObject({ outcome: 'error', stalledShards: [
    { reason: 'job-failed', files: ['src/boom.test.ts'], lastFile: 'src/boom.test.ts' },
  ], partialSummary: { pass: 3, fail: 0, errors: 0, ran: 3, files: 3 } });
  expect(result.stalledShards).toHaveLength(1);
  expect(calls).toEqual([files, files.slice(0, 2), files.slice(2), [files[0]!], [files[1]!]]);
  expect(existsSync(join(instanceRoot, 'release/1.0.1/gate-failures.json'))).toBe(false);
});

test('Pod OOM retains a root-level last started file from a partial shard.log even when the job log differs', async () => {
  const { root, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const files = ['foo.test.ts', 'src/a.test.ts', 'src/c.test.ts', 'src/d.test.ts'];
  const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
    return fixtureRunner.command(cmd, args, cwd);
  }, async (o) => {
    const assigned = files.filter((file) => o.command[2]!.includes(`'./${file}'`));
    const artifactsDir = join(root, o.name!);
    mkdirSync(artifactsDir);
    if (assigned.includes('foo.test.ts')) {
      writeFileSync(join(artifactsDir, 'shard.log'), 'src/a.test.ts:\nstartup\nfoo.test.ts:\n');
      return { exitCode: 137, artifactsDir, job: 'fake' };
    }
    writeFileSync(join(artifactsDir, 'shard.log'), `${assigned.length} pass\n0 fail\nRan ${assigned.length} tests across ${assigned.length} files.\n`);
    writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
    return { exitCode: 0, artifactsDir, job: 'fake' };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 4, k3dCluster: 'test' }]),
  () => 'src/a.test.ts:\n');
  await expect(runner.sweep(repo, undefined, { pool: 'pool-test', shards: 1 })).rejects.toMatchObject({
    stalledShards: [{ shard: 0, reason: 'job-failed', files: ['foo.test.ts'], lastFile: 'foo.test.ts' }],
    partialSummary: { pass: 3, fail: 0, ran: 3, files: 3 },
  });
});

test('Pod isolates two-file depth-two OOM leaves without losing healthy file results', async () => {
  const { root, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const files = ['src/a.test.ts', 'src/b.test.ts', 'src/boom.test.ts', 'src/d.test.ts',
    'src/e.test.ts', 'src/f.test.ts', 'src/g.test.ts', 'src/h.test.ts'];
  const calls: string[][] = [];
  const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
    return fixtureRunner.command(cmd, args, cwd);
  }, async (o) => {
    const assigned = files.filter((file) => o.command[2]!.includes(`'./${file}'`));
    calls.push(assigned);
    const artifactsDir = join(root, `deep-${calls.length}`);
    mkdirSync(artifactsDir);
    if (assigned.includes('src/boom.test.ts')) return { exitCode: 137, artifactsDir, job: 'fake' };
    writeFileSync(join(artifactsDir, 'shard.log'), `${assigned.length} pass\n0 fail\nRan ${assigned.length} tests across ${assigned.length} files.\n`);
    writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
    return { exitCode: 0, artifactsDir, job: 'fake' };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 4, k3dCluster: 'test' }]), () => 'src/boom.test.ts:\n');
  await expect(runner.sweep(repo, undefined, { pool: 'pool-test', shards: 1 })).rejects.toMatchObject({
    stalledShards: [{ shard: 0, files: ['src/boom.test.ts'], reason: 'job-failed', lastFile: 'src/boom.test.ts' }],
    partialSummary: { pass: 7, fail: 0, ran: 7, files: 7 },
  });
  expect(calls).toContainEqual(['src/boom.test.ts', 'src/d.test.ts']);
  expect(calls).toContainEqual(['src/boom.test.ts']);
  expect(calls).toContainEqual(['src/d.test.ts']);
});

test('Pod isolates every file of an out-of-memory shard so only the files that fail alone stay stalled', async () => {
  const { root, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const files = Array.from({ length: 44 }, (_, index) => `src/file-${String(index).padStart(2, '0')}.test.ts`);
  const calls: string[][] = [];
  let activeFiles = 0;
  let peakFiles = 0;
  const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
    return fixtureRunner.command(cmd, args, cwd);
  }, async (o) => {
    const assigned = files.filter((file) => o.command[2]!.includes(`'./${file}'`));
    calls.push(assigned);
    if (assigned.length === 1) {
      activeFiles++;
      peakFiles = Math.max(peakFiles, activeFiles);
      await Bun.sleep(2);
      activeFiles--;
    }
    const artifactsDir = join(root, o.name!);
    mkdirSync(artifactsDir);
    if (assigned.length > 1 || assigned[0] === files[43]) return { exitCode: 137, artifactsDir, job: 'fake' };
    writeFileSync(join(artifactsDir, 'shard.log'), '1 pass\n0 fail\nRan 1 test across 1 file.\n');
    writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
    return { exitCode: 0, artifactsDir, job: 'fake' };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 4, k3dCluster: 'test' }]), () => '');
  try {
    await runner.sweep(repo, undefined, { pool: 'pool-test', shards: 1, isolationConcurrency: 2 });
    throw new Error('expected the one stalled file');
  } catch (error) {
    const result = error as { stalledShards: Array<{ files: string[]; reason: string }>; partialSummary: { pass: number; files: number } };
    expect(result.partialSummary).toMatchObject({ pass: 43, files: 43 });
    expect(result.stalledShards.flatMap((item) => item.files).sort()).toEqual([files[43]]);
    expect(result.stalledShards.every((item) => item.reason === 'job-failed')).toBe(true);
  }
  expect(calls.filter((assigned) => assigned.length === 1)).toHaveLength(44);
  expect(peakFiles).toBe(2);
});

test('Pod isolates every file of a depth-two shard that ends with no output', async () => {
  const { root, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const files = Array.from({ length: 44 }, (_, index) => `src/quiet-${String(index).padStart(2, '0')}.test.ts`);
  const calls: string[][] = [];
  const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
    return fixtureRunner.command(cmd, args, cwd);
  }, async (o) => {
    const assigned = files.filter((file) => o.command[2]!.includes(`'./${file}'`));
    calls.push(assigned);
    const artifactsDir = join(root, o.name!);
    mkdirSync(artifactsDir);
    // 여러 파일 조각은 로그도 rc 도 남기지 않는다(no-output) · 파일 하나면 통과
    if (assigned.length > 1 || assigned[0] === files[43]) return { exitCode: 0, artifactsDir, job: 'fake' };
    writeFileSync(join(artifactsDir, 'shard.log'), '1 pass\n0 fail\nRan 1 test across 1 file.\n');
    writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
    return { exitCode: 0, artifactsDir, job: 'fake' };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 4, k3dCluster: 'test' }]), () => '');
  const result = await runner.sweep(repo, undefined, { pool: 'pool-test', shards: 1 });
  expect(result.output).toContain('43 pass\n0 fail\n0 errors\nRan 43 tests across 43 files.');
  expect(result.stalledEnv).toEqual([{ file: files[43]!, reason: 'no-output' }]);
  expect(calls.filter((assigned) => assigned.length === 1)).toHaveLength(45);
  expect(calls.filter((assigned) => assigned[0] === files[43] && assigned.length === 1)).toHaveLength(2);
});

test('Pod records the mismatch at an unattributed leaf', async () => {
  const { root, instanceRoot, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const files = ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts', 'src/d.test.ts'];
  const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
    return fixtureRunner.command(cmd, args, cwd);
  }, async (o) => {
    const assigned = files.filter((file) => o.command[2]!.includes(`'./${file}'`));
    const artifactsDir = join(root, o.name!);
    mkdirSync(artifactsDir);
    const output = assigned.includes('src/b.test.ts')
      ? `src/b.test.ts:\n(fail) B [1.00ms]\n0 pass\n2 fail\nRan ${assigned.length} tests across ${assigned.length} files.\n`
      : `${assigned.length} pass\n0 fail\nRan ${assigned.length} tests across ${assigned.length} files.\n`;
    writeFileSync(join(artifactsDir, 'shard.log'), output);
    writeFileSync(join(artifactsDir, 'shard.rc'), assigned.includes('src/b.test.ts') ? '1\n' : '0\n');
    return { exitCode: 0, artifactsDir, job: 'fake' };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 4, k3dCluster: 'test' }]));
  runner.add = fixtureRunner.add;
  runner.remove = fixtureRunner.remove;
  const result = await judgeGate({ ...options(instanceRoot), repo, pod: { pool: 'pool-test', shards: 1 } }, runner);
  expect(result).toMatchObject({ outcome: 'error', stalledShards: [
    { shard: 0, reason: 'unattributed', files: ['src/b.test.ts'], summaryFailures: 2, namedFailures: 1 },
  ], partialSummary: { pass: 3, fail: 0, ran: 3, files: 3 } });
  expect(result.stalledShards).toHaveLength(1);
  expect(result.stalledShards?.[0]?.detail).toContain('failure attribution incomplete: summary=2, identified=1');
});

test('Pod splits a shard when fail summary names fewer failures than reported', async () => {
  const { root, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const files = Array.from({ length: 4 }, (_, i) => `src/${String.fromCharCode(97 + i)}.test.ts`);
  const calls: number[] = [];
  const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
    return fixtureRunner.command(cmd, args, cwd);
  }, async (o) => {
    const paths = files.filter((file) => o.command[2]!.includes(`'./${file}'`));
    calls.push(paths.length);
    const artifactsDir = join(root, `unattributed-${calls.length}`);
    mkdirSync(artifactsDir);
    const output = paths.length === 4
      ? `src/a.test.ts:\n(fail) A [1.00ms]\n2 pass\n2 fail\nRan 4 tests across 4 files.\n`
      : `${paths.length} pass\n0 fail\nRan ${paths.length} tests across ${paths.length} files.\n`;
    writeFileSync(join(artifactsDir, 'shard.log'), output);
    writeFileSync(join(artifactsDir, 'shard.rc'), paths.length === 4 ? '1\n' : '0\n');
    return { exitCode: 0, artifactsDir, job: 'fake' };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 2, k3dCluster: 'test' }]));
  const result = await runner.sweep(repo, undefined, { pool: 'pool-test', shards: 1 });
  expect(calls).toEqual([4, 2, 2]);
  expect(result.rc).toBe(0);
});

test('Pod splits a shard whose summary omits assigned files and fails closed at depth two', async () => {
  const { root, instanceRoot, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const files = Array.from({ length: 10 }, (_, i) => `src/${String.fromCharCode(97 + i)}.test.ts`);
  const attempts = [0, 0, 0];
  const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
    return fixtureRunner.command(cmd, args, cwd);
  }, async (o) => {
    const shard = files.findIndex((file) => o.command[2]!.includes(`'./${file}'`)) % 3;
    attempts[shard]!++;
    const assigned = files.filter((file) => o.command[2]!.includes(`'./${file}'`));
    const reported = shard === 1 ? 0 : assigned.length;
    const artifactsDir = join(root, `partial-${shard}-${attempts[shard]}`);
    mkdirSync(artifactsDir);
    writeFileSync(join(artifactsDir, 'shard.log'), `${reported} pass\n0 fail\nRan ${reported} tests across ${reported} files.\n`);
    writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
    return { exitCode: 0, artifactsDir, job: 'fake' };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 3, k3dCluster: 'test' }]));
  runner.add = fixtureRunner.add;
  runner.remove = fixtureRunner.remove;
  runner.snapshot = fixtureRunner.snapshot;
  runner.removeSnapshot = fixtureRunner.removeSnapshot;
  const result = await judgeGate({ ...options(instanceRoot), repo, pod: { pool: 'pool-test', shards: 3 } }, runner);
  expect(attempts).toEqual([1, 5, 1]);
  expect(result).toMatchObject({ outcome: 'error', stalledShards: [
    { shard: 1, files: [files[1]], reason: 'incomplete' },
    { shard: 1, files: [files[4]], reason: 'incomplete' },
    { shard: 1, files: [files[7]], reason: 'incomplete' },
  ] });
  expect(existsSync(join(instanceRoot, 'release/1.0.1/gate-failures.json'))).toBe(false);
});

test('Pod splits only incomplete shards and reports stalled leaves instead of publishing a baseline', async () => {
  for (const [alwaysStall, missingSummary] of [[false, false], [false, true], [true, false], [true, true]]) {
    const { root, instanceRoot, runner: fixtureRunner } = fake([], []);
    const repo = join(root, 'repo');
    mkdirSync(repo);
    const files = Array.from({ length: 10 }, (_, i) => `src/${String.fromCharCode(97 + i)}.test.ts`);
    const original = fixtureRunner.command;
    const attempts: number[] = [0, 0, 0];
    const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
      if (cmd === 'rg') return { rc: 1, output: '' };
      if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
      if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
      return original(cmd, args, cwd);
    }, async (o) => {
      const assigned = files.filter((file) => o.command[2]!.includes(`'./${file}'`));
      const shard = files.indexOf(assigned[0]!) % 3;
      attempts[shard]!++;
      const artifactsDir = join(root, `retry-${shard}-${attempts[shard]}`);
      mkdirSync(artifactsDir);
      const incomplete = shard === 1 && (assigned.length === 3 || alwaysStall);
      if (!incomplete || missingSummary) writeFileSync(join(artifactsDir, 'shard.log'), incomplete ? 'no summary\n' : `${assigned.length} pass\n0 fail\nRan ${assigned.length} tests across ${assigned.length} files.\n`);
      if (!incomplete || missingSummary) writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
      return { exitCode: 0, artifactsDir, job: 'fake' };
    }, new PodPoolScheduler([{ context: 'pool-test', capacity: 3, k3dCluster: 'test' }]));
    runner.add = fixtureRunner.add;
    runner.remove = fixtureRunner.remove;
    runner.snapshot = fixtureRunner.snapshot;
    runner.removeSnapshot = fixtureRunner.removeSnapshot;
    runner.localCommand = async () => ({ rc: 0, output: runOutput([]) });
    const result = await judgeGate({ ...options(instanceRoot), repo, pod: { pool: 'pool-test', shards: 3 } }, runner);
    expect(attempts).toEqual([1, alwaysStall ? (missingSummary ? 5 : 10) : (missingSummary ? 3 : 4), 1]);
    if (alwaysStall) {
      if (missingSummary) expect(result).toMatchObject({ outcome: 'error', stalledShards: [
        { shard: 1, files: [files[1]], reason: 'incomplete' },
        { shard: 1, files: [files[4]], reason: 'incomplete' },
        { shard: 1, files: [files[7]], reason: 'incomplete' },
      ] });
      else expect(result).toMatchObject({ outcome: 'ok', stalledEnv: [files[1], files[4], files[7]].map((file) => ({ file, reason: 'no-output', local: 'passed' })) });
      expect(existsSync(join(instanceRoot, 'release/1.0.1/gate-failures.json'))).toBe(false);
    } else expect(result).toMatchObject({ outcome: 'ok', introduced: [] });
  }
});

test('Pod splits thrown timeout or artifact retrieval errors and reports stalled leaves', async () => {
  for (const recover of [true, false]) {
    const { root, instanceRoot, runner: fixtureRunner } = fake([], []);
    const repo = join(root, 'repo');
    mkdirSync(repo);
    const files = Array.from({ length: 10 }, (_, i) => `src/${String.fromCharCode(97 + i)}.test.ts`);
    const attempts = [0, 0, 0];
    const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
      if (cmd === 'rg') return { rc: 1, output: '' };
      if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
      if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
      return fixtureRunner.command(cmd, args, cwd);
    }, async (o) => {
      const assigned = files.filter((file) => o.command[2]!.includes(`'./${file}'`));
      const shard = files.indexOf(assigned[0]!) % 3;
      attempts[shard]!++;
      if (shard === 1 && (assigned.length === 3 || !recover)) throw new Error('artifact retrieval timeout');
      const artifactsDir = join(root, `exception-${shard}-${attempts[shard]}`);
      mkdirSync(artifactsDir);
      writeFileSync(join(artifactsDir, 'shard.log'), `${assigned.length} pass\n0 fail\nRan ${assigned.length} tests across ${assigned.length} files.\n`);
      writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
      return { exitCode: 0, artifactsDir, job: 'fake' };
    }, new PodPoolScheduler([{ context: 'pool-test', capacity: 3, k3dCluster: 'test' }]));
    runner.add = fixtureRunner.add;
    runner.remove = fixtureRunner.remove;
    runner.snapshot = fixtureRunner.snapshot;
    runner.removeSnapshot = fixtureRunner.removeSnapshot;
    const result = await judgeGate({ ...options(instanceRoot), repo, pod: { pool: 'pool-test', shards: 3 } }, runner);
    expect(attempts).toEqual([1, recover ? 3 : 5, 1]);
    if (recover) expect(result).toMatchObject({ outcome: 'ok', introduced: [] });
    else {
      expect(result).toMatchObject({ outcome: 'error', stalledShards: [
        { shard: 1, files: [files[1]], reason: 'job-failed' },
        { shard: 1, files: [files[4]], reason: 'job-failed' },
        { shard: 1, files: [files[7]], reason: 'job-failed' },
      ] });
      expect(existsSync(join(instanceRoot, 'release/1.0.1/gate-failures.json'))).toBe(false);
    }
  }
});

test('a shard with no Ran summary reports its name, rc and last output', async () => {
  const { root } = fixture();
  mkdirSync(join(root, 'src/cli'), { recursive: true });
  writeFileSync(join(root, 'src/cli/a.test.ts'), 'test');
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['add', 'src/cli/a.test.ts'], { cwd: root });
  const real = createGateRunner(root).command;
  const runner = createGateRunner(root, undefined, async (cmd, args, cwd) => cmd === 'bun' ? { rc: 1, output: 'stalled\nlast diagnostic' } : real(cmd, args, cwd));
  await expect(runner.sweep(root, join(root, 'logs'))).rejects.toThrow(/src-cli shard: .*rc=1; Ran=missing; errors=missing.*last diagnostic/s);
});

test('reproduced between-tests errors stay unmeasured regardless of baseline identity', async () => {
  const { instanceRoot, runner } = fake([], []);
  const errorOutput = (file: string) => `${file}:\n# Unhandled error between tests\n0 fail\n1 errors\nRan 1 test across 1 file.\n`;
  const old = runner.command;
  runner.sweep = async (tree) => ({ rc: 1, output: errorOutput(tree.endsWith('/cut') ? 'src/b.test.ts' : 'src/a.test.ts') });
  runner.command = async (cmd, args, cwd) => cmd === 'bun' && args[0] === 'run' && args[2] === './src/b.test.ts'
    ? { rc: cwd.endsWith('/cut') ? 1 : 0, output: cwd.endsWith('/cut') ? errorOutput('src/b.test.ts') : runOutput([]) }
    : old(cmd, args, cwd);
  const cached = join(instanceRoot, 'release/1.0.0/gate-failures.json');
  writeFileSync(cached, JSON.stringify({ commit: BASE, failures: [], errors: ['src/a.test.ts > [error]'] }));
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'error', introduced: [], unmeasuredRecheckFiles: ['src/b.test.ts'] });
  writeFileSync(cached, JSON.stringify({ commit: BASE, failures: [], errors: ['src/b.test.ts > [error]'] }));
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'error', introduced: [], unmeasuredRecheckFiles: ['src/b.test.ts'] });
});

test('a clean isolated error is recorded as interference while another file is still judged as a regression', async () => {
  const { instanceRoot, runner } = fake([], []);
  const old = runner.command;
  runner.sweep = async () => ({ rc: 1, output: 'src/a.test.ts:\n# Unhandled error between tests\nsrc/b.test.ts:\n(fail) B [1.00ms]\n1 fail\n1 errors\nRan 4 tests across 2 files.\n' });
  runner.command = async (cmd, args, cwd, limitMs) => cmd === 'bun' && args[0] === 'run' && args[2] === './src/a.test.ts' && cwd.endsWith('/cut')
    ? { rc: 0, output: runOutput([]) }
    : old(cmd, args, cwd, limitMs);
  const result = await judgeGate(options(instanceRoot), runner);
  expect(result).toMatchObject({ outcome: 'regression', introduced: [B], interferenceErrors: ['src/a.test.ts > [error]'] });
  expect(result.unmeasuredRecheckFiles).toBeUndefined();
});

test('CLI and graph Pod options reach the cut gate and reject invalid shard counts before checkout', () => {
  const { root } = fixture();
  const context = join(root, 'pod-context.json');
  writeFileSync(context, JSON.stringify({ runId: 'gate-pod-invalid', input: { commit: CUT, version: '1.0.1', previousVersion: '1.0.0', gatePodPool: 'pool-test', gatePodShards: 0 }, outputs: {} }));
  const graph = spawnSync('bun', [resolve(import.meta.dir, 'gate-node.ts'), '--json'], {
    encoding: 'utf8', env: { ...process.env, ELANOUS_GRAPH_CONTEXT: context, ELANOUS_STATE_DIR: root },
  });
  expect(graph.status).toBe(2);
  expect(JSON.parse(graph.stdout.trim())).toMatchObject({ outcome: 'error', error: 'invalid pod sweep options' });
  const cli = spawnSync('bun', [resolve(import.meta.dir, 'gate-node.ts'), '--commit', CUT, '--version', '1.0.1', '--baseline-version', '1.0.0', '--pod-shards', '0', '--pod-pool', 'pool-test', '--json'], {
    encoding: 'utf8', env: { ...process.env, ELANOUS_GRAPH_CONTEXT: '/nonexistent/context.json' },
  });
  expect(cli.status).toBe(2);
  expect(JSON.parse(cli.stdout.trim())).toMatchObject({ outcome: 'error', error: 'invalid pod sweep options' });
});

test('graph gateRemoteMirror input is validated before touching the remote host', () => {
  const { root } = fixture();
  const context = join(root, 'context.json');
  writeFileSync(context, JSON.stringify({ runId: 'gate-mirror-invalid', input: { commit: CUT, version: '1.0.1', previousVersion: '1.0.0', gateRemote: 'test-host', gateRemoteMirror: '/tmp/../caller' }, outputs: {} }));
  const result = spawnSync('bun', [resolve(import.meta.dir, 'gate-node.ts'), '--json'], {
    encoding: 'utf8', env: { ...process.env, ELANOUS_GRAPH_CONTEXT: context, ELANOUS_STATE_DIR: root },
  });
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout.trim())).toMatchObject({ outcome: 'error', error: 'invalid remote mirror path' });
});

test('CLI --remote-mirror is validated before touching the remote host', () => {
  const result = spawnSync('bun', [resolve(import.meta.dir, 'gate-node.ts'), '--commit', CUT, '--version', '1.0.1', '--baseline-version', '1.0.0', '--baseline-commit', BASE, '--remote', 'test-host', '--remote-mirror', '/tmp/../caller', '--json'], {
    encoding: 'utf8', env: { ...process.env, ELANOUS_GRAPH_CONTEXT: '/nonexistent/context.json' },
  });
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout.trim())).toMatchObject({ outcome: 'error', error: 'invalid remote mirror path' });
});

test('graph gateRemote input is validated by the existing ssh host guard', () => {
  const { root } = fixture();
  const context = join(root, 'context.json');
  writeFileSync(context, JSON.stringify({ runId: 'gate-host-invalid', input: { commit: CUT, version: '1.0.1', previousVersion: '1.0.0', gateRemote: 'bad;host' }, outputs: {} }));
  const result = spawnSync('bun', [resolve(import.meta.dir, 'gate-node.ts'), '--json'], {
    encoding: 'utf8', env: { ...process.env, ELANOUS_GRAPH_CONTEXT: context, ELANOUS_STATE_DIR: root },
  });
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout.trim())).toMatchObject({ outcome: 'error', error: 'invalid ssh host' });
});

test('local command runner executes in the requested checkout, not its parent repo', async () => {
  const { root } = fixture();
  const checkout = join(root, 'checkout');
  mkdirSync(checkout);
  const output = await createGateRunner(root).command('bun', ['-e', 'console.log(process.cwd())'], checkout);
  expect(output.rc).toBe(0);
  // macOS 의 /var 는 /private/var 링크 — 경로를 실제 경로로 맞춰 비교한다(Pod·Linux 만 초록이던 시험).
  expect(realpathSync(output.output.trim())).toBe(realpathSync(checkout));
});

test('real baseline snapshot extracts a commit without registering a worktree and removes it', async () => {
  const { root } = fixture();
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  expect(git('init', '-q').status).toBe(0);
  writeFileSync(join(repo, 'tracked.txt'), 'original');
  expect(git('add', 'tracked.txt').status).toBe(0);
  expect(git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'baseline').status).toBe(0);
  const sha = git('rev-parse', 'HEAD').stdout.trim();
  writeFileSync(join(repo, 'tracked.txt'), 'working copy');
  const runner = createGateRunner(repo);
  const snapshot = join(root, 'snapshot');
  await runner.snapshot(snapshot, sha);
  expect(readFileSync(join(snapshot, 'tracked.txt'), 'utf8')).toBe('original');
  expect(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: snapshot, encoding: 'utf8' }).stdout.trim()).toBe(sha);
  expect(git('worktree', 'list', '--porcelain').stdout).not.toContain(snapshot);
  await runner.removeSnapshot(snapshot);
  expect(existsSync(snapshot)).toBe(false);
  await expect(runner.snapshot(snapshot, 'c'.repeat(40))).rejects.toThrow('baseline snapshot checkout failed');
  await runner.removeSnapshot(snapshot);
});

test('runner failure is error and does not persist a false baseline', async () => {
  const { instanceRoot, runner, calls } = fake();
  runner.sweep = async () => { throw new Error('suite incomplete'); };
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'error', error: 'suite incomplete' });
  expect(existsSync(join(instanceRoot, 'release/1.0.1/gate-failures.json'))).toBe(false);
  expect(calls.filter((c) => c.startsWith('remove '))).toHaveLength(1);
});

test('cleanup failure retains the completed cut baseline even if the judgment is error', async () => {
  const { instanceRoot, runner } = fake();
  runner.removeSnapshot = async () => { throw new Error('snapshot cleanup failed'); };
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'error', error: expect.stringContaining('cleanup:') });
  expect(JSON.parse(readFileSync(join(instanceRoot, 'release/1.0.1/gate-failures.json'), 'utf8'))).toEqual({ commit: CUT, failures: [A, B, C] });
});

test('graph gate regression maps to fail while preserving measured counts', async () => {
  const { instanceRoot, runner } = fake();
  const result = await judgeGate(options(instanceRoot), runner);
  expect(result.outcome).toBe('regression');
  expect(graphGateResult(result, true)).toMatchObject({ outcome: 'fail', verdict: 'fail', introduced: [B], preexisting: 1, fixed: 1 });
  expect(graphGateResult(result, false)).toMatchObject({ outcome: 'regression', introduced: [B], preexisting: 1, fixed: 1 });
});

test('graph context supplies input values and an un-runnable gate emits JSON error with rc 2', () => {
  const { root } = fixture();
  const context = join(root, 'graph-context.json');
  writeFileSync(context, JSON.stringify({ runId: 'gate-commit-invalid', input: { commit: 'invalid', version: '1.0.1', previousVersion: '1.0.0' }, outputs: {} }));
  const result = spawnSync('bun', [resolve(import.meta.dir, 'gate-node.ts'), '--json'], {
    encoding: 'utf8', timeout: 15_000, env: { ...process.env, ELANOUS_GRAPH_CONTEXT: context, ELANOUS_STATE_DIR: root },
  });
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout.trim().split('\n').at(-1)!)).toMatchObject({ outcome: 'error', commit: 'invalid', introduced: [], error: 'invalid commit or version' });
});

test('explicit CLI arguments do not read an ambient graph context file', () => {
  const result = spawnSync('bun', [resolve(import.meta.dir, 'gate-node.ts'), '--commit', 'invalid', '--version', '1.0.1', '--json'], {
    encoding: 'utf8', timeout: 15_000, env: { ...process.env, ELANOUS_GRAPH_CONTEXT: '/nonexistent/context.json' },
  });
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout.trim().split('\n').at(-1)!)).toMatchObject({ commit: 'invalid', outcome: 'error', error: 'invalid commit or version' });
  const empty = spawnSync('bun', [resolve(import.meta.dir, 'gate-node.ts')], {
    encoding: 'utf8', timeout: 15_000, env: { ...process.env, ELANOUS_GRAPH_CONTEXT: '/nonexistent/context.json' },
  });
  expect(empty.status).toBe(2);
  expect(JSON.parse(empty.stdout.trim().split('\n').at(-1)!)).toMatchObject({ outcome: 'error', error: 'invalid commit or version' });
});

test('--help prints options and exits 0 without invoking a gate', () => {
  const result = spawnSync('bun', [resolve(import.meta.dir, 'gate-node.ts'), '--help'], {
    encoding: 'utf8', timeout: 15_000, env: { ...process.env, ELANOUS_GRAPH_CONTEXT: '/nonexistent/context.json' },
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('--baseline-version');
  expect(result.stdout).toContain('--remote');
  expect(result.stdout).toContain('--remote-mirror');
  expect(result.stdout).toContain('--pod-pool');
  expect(result.stdout).toContain('--pod-shards');
  expect(result.stdout).toContain('--json');
});

test('Pod sweep waits for every shard to finish before reporting a shard error', async () => {
  const { root } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const files = ['src/a.test.ts', 'src/b.test.ts'];
  let slowFinished = false;
  const runner = createGateRunner(repo, undefined, async (cmd, args) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
    return { rc: 0, output: '' };
  }, async (o) => {
    const slow = o.command[2]!.includes("'./src/b.test.ts'");
    const artifactsDir = join(root, slow ? 'slow' : 'fast');
    mkdirSync(artifactsDir, { recursive: true });
    if (slow) { await new Promise((r) => setTimeout(r, 50)); slowFinished = true; }
    writeFileSync(join(artifactsDir, 'shard.log'), '1 pass\n0 fail\nRan 1 tests across 1 files.\n');
    writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
    return { exitCode: slow ? 0 : 1, artifactsDir, job: 'fake' };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 2, k3dCluster: 'test' }]));
  await expect(runner.sweep(repo, undefined, { pool: 'pool-test', shards: 2 })).rejects.toMatchObject({
    stalledShards: [{ shard: 0, files: [files[0]], reason: 'job-failed' }],
  });
  expect(slowFinished).toBe(true);
});

test('Pod sweep never assigns a CDP test to a shard, and only single-file isolation Jobs get the larger memory limit', async () => {
  const { root, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const files = ['scripts/webclone/check-layout-landmark.test.ts', 'src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts', 'src/d.test.ts'];
  const calls: Array<{ files: string[]; memoryLimit?: string }> = [];
  const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
    if (cmd === 'rg') return { rc: 0, output: 'scripts/webclone/check-layout-landmark.test.ts\n' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
    return fixtureRunner.command(cmd, args, cwd);
  }, async (o) => {
    const assigned = files.filter((file) => o.command[2]!.includes(`'./${file}'`));
    calls.push({ files: assigned, ...(o.memoryLimit ? { memoryLimit: o.memoryLimit } : {}) });
    const artifactsDir = join(root, o.name!);
    mkdirSync(artifactsDir);
    if (assigned.length > 1) return { exitCode: 137, artifactsDir, job: 'fake' };
    writeFileSync(join(artifactsDir, 'shard.log'), '1 pass\n0 fail\nRan 1 test across 1 file.\n');
    writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
    return { exitCode: 0, artifactsDir, job: 'fake' };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 4, k3dCluster: 'test' }]), () => '');
  const result = await runner.sweep(repo, undefined, { pool: 'pool-test', shards: 1 });
  expect(result.output).toContain('Ran 4 tests across 4 files.');
  expect(calls.some((call) => call.files.includes('scripts/webclone/check-layout-landmark.test.ts'))).toBe(false);
  expect(calls.filter((call) => call.files.length === 1).every((call) => call.memoryLimit === '32Gi')).toBe(true);
  expect(calls.filter((call) => call.files.length > 1).every((call) => call.memoryLimit === undefined)).toBe(true);
});

test('a file measured at or above the heavy budget runs alone at the isolation limit from the first round', async () => {
  const { root, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'docs', 'measurements'), { recursive: true });
  writeFileSync(join(repo, POD_MEMORY_SOURCE), `file\tsecs\trss_mb\nscripts/heavy.test.ts\t90\t${POD_HEAVY_FILE_MB}\nsrc/a.test.ts\t1\t${POD_HEAVY_FILE_MB - 1}\nsrc/b.test.ts\t1\t\n`);
  const files = ['scripts/heavy.test.ts', 'src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts'];
  const calls: Array<{ files: string[]; memoryLimit?: string }> = [];
  const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
    return fixtureRunner.command(cmd, args, cwd);
  }, async (o) => {
    const assigned = files.filter((file) => o.command[2]!.includes(`'./${file}'`));
    calls.push({ files: assigned, ...(o.memoryLimit ? { memoryLimit: o.memoryLimit } : {}) });
    const artifactsDir = join(root, o.name!);
    mkdirSync(artifactsDir);
    writeFileSync(join(artifactsDir, 'shard.log'), `${assigned.length} pass\n0 fail\nRan ${assigned.length} tests across ${assigned.length} files.\n`);
    writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
    return { exitCode: 0, artifactsDir, job: 'fake' };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 4, k3dCluster: 'test' }]), () => '');
  const result = await runner.sweep(repo, undefined, { pool: 'pool-test', shards: 1 });
  expect(result.output).toContain('Ran 4 tests across 4 files.');
  expect(calls).toHaveLength(2);
  expect(calls).toContainEqual({ files: ['scripts/heavy.test.ts'], memoryLimit: '32Gi' });
  expect(calls).toContainEqual({ files: ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts'] });
});

test('Pod isolates every file of a depth-two unattributed shard so the unnamed failure lands on one file', async () => {
  const { root, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const files = Array.from({ length: 44 }, (_, index) => `src/file-${String(index).padStart(2, '0')}.test.ts`);
  const culprit = files[17]!;
  const calls: string[][] = [];
  const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
    return fixtureRunner.command(cmd, args, cwd);
  }, async (o) => {
    const assigned = files.filter((file) => o.command[2]!.includes(`'./${file}'`));
    calls.push(assigned);
    const artifactsDir = join(root, o.name!);
    mkdirSync(artifactsDir);
    // The culprit adds one failure to the summary that no «(fail)» line names — as in the 09-30 G1e shard 7 (summary 28 · named 27).
    const bad = assigned.includes(culprit);
    const pass = assigned.length - (bad ? 1 : 0);
    writeFileSync(join(artifactsDir, 'shard.log'), `${pass} pass\n${bad ? 1 : 0} fail\nRan ${assigned.length} tests across ${assigned.length} files.\n`);
    writeFileSync(join(artifactsDir, 'shard.rc'), bad ? '1\n' : '0\n');
    return { exitCode: 0, artifactsDir, job: 'fake' };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 4, k3dCluster: 'test' }]), () => '');
  try {
    await runner.sweep(repo, undefined, { pool: 'pool-test', shards: 1 });
    throw new Error('expected the one unattributed file');
  } catch (error) {
    const result = error as { stalledShards: Array<{ files: string[]; reason: string }>; partialSummary: { pass: number; files: number } };
    expect(result.stalledShards).toEqual([expect.objectContaining({ files: [culprit], reason: 'unattributed' })]);
    expect(result.partialSummary).toMatchObject({ pass: 43, files: 43 });
  }
  expect(calls.filter((assigned) => assigned.length === 1).map((assigned) => assigned[0])).toContain(culprit);
});

test('Pod sweep never assigns a test under a hidden directory, which bun discovery never opens', async () => {
  const { root, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const hidden = ['scripts/.parked-still-broken-fixture/pass.test.ts', 'scripts/.parked-still-broken-fixture/fail.test.ts'];
  const files = [...hidden, 'src/a.test.ts', 'src/b.test.ts'];
  const calls: string[][] = [];
  const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
    return fixtureRunner.command(cmd, args, cwd);
  }, async (o) => {
    const assigned = files.filter((file) => o.command[2]!.includes(`'./${file}'`));
    calls.push(assigned);
    const artifactsDir = join(root, o.name!);
    mkdirSync(artifactsDir);
    // An empty fixture run alone is «Ran 0 tests» — the gate reads that as incomplete, so it must never be scheduled.
    const tests = assigned.filter((file) => !hidden.includes(file)).length;
    writeFileSync(join(artifactsDir, 'shard.log'), `${tests} pass\n0 fail\nRan ${tests} tests across ${assigned.length} files.\n`);
    writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
    return { exitCode: 0, artifactsDir, job: 'fake' };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 4, k3dCluster: 'test' }]), () => '');
  const result = await runner.sweep(repo, undefined, { pool: 'pool-test', shards: 4 });
  expect(result.output).toContain('Ran 2 tests across 2 files.');
  expect(calls.flat().some((file) => hidden.includes(file))).toBe(false);
});

test('Pod shards ask bun for a junit report and keep it beside the shard log, without changing the console the verdict reads', async () => {
  const { root, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const files = ['src/a.test.ts', 'src/b.test.ts'];
  const commands: string[] = [];
  const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
    return fixtureRunner.command(cmd, args, cwd);
  }, async (o) => {
    commands.push(o.command[2]!);
    const assigned = files.filter((file) => o.command[2]!.includes(`'./${file}'`));
    const artifactsDir = join(root, o.name!);
    mkdirSync(artifactsDir);
    writeFileSync(join(artifactsDir, 'shard.log'), `${assigned.length} pass\n0 fail\nRan ${assigned.length} tests across ${assigned.length} files.\n`);
    writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
    writeFileSync(join(artifactsDir, 'junit.xml'), assigned.map((file) => `<testsuite name="${file}" file="${file}" time="1.5">`).join('\n'));
    return { exitCode: 0, artifactsDir, job: 'fake' };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 4, k3dCluster: 'test' }]), () => '');
  const logDir = join(root, 'logs');
  const result = await runner.sweep(repo, logDir, { pool: 'pool-test', shards: 1 });
  expect(result.output).toContain('Ran 2 tests across 2 files.');
  expect(commands.every((command) => command.includes('--reporter=junit --reporter-outfile="$O/part-$i.junit.xml"'))).toBe(true);
  expect(readFileSync(join(logDir, 'pod-0.junit.xml'), 'utf8')).toContain('file="src/b.test.ts" time="1.5"');
});

test('a failure the console counts but never names is attributed from the shard junit instead of stalling the sweep', async () => {
  const { root, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const files = ['test/dashboard-vw-diet.test.ts'];
  const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
    return fixtureRunner.command(cmd, args, cwd);
  }, async (o) => {
    const artifactsDir = join(root, o.name!);
    mkdirSync(artifactsDir);
    // 10-01 0.2.6 실물 모양: `--dots` 출력은 실패 본문만 있고 `(fail) <이름>` 줄이 없다.
    writeFileSync(join(artifactsDir, 'shard.log'), '..\n\ntest/dashboard-vw-diet.test.ts:\n85 |   expect(index).toContain(\'x\');\nerror: expect(received).toContain(expected)\n\n5 pass\n1 fail\nRan 6 tests across 1 file.\n');
    writeFileSync(join(artifactsDir, 'shard.rc'), '1\n');
    writeFileSync(join(artifactsDir, 'junit.xml'), `<testsuites><testsuite name="test/dashboard-vw-diet.test.ts" file="test/dashboard-vw-diet.test.ts" tests="6" failures="1">
    <testcase name="retired picker is absent" file="test/dashboard-vw-diet.test.ts" />
    <testcase name="unknown slash command keeps &quot;/x&quot; text" file="test/dashboard-vw-diet.test.ts"><failure type="AssertionError" message="expect"/></testcase>
  </testsuite></testsuites>`);
    return { exitCode: 0, artifactsDir, job: 'fake' };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 4, k3dCluster: 'test' }]), () => '');
  const result = await runner.sweep(repo, join(root, 'logs'), { pool: 'pool-test', shards: 1 });
  expect(result.output).toContain('(fail) unknown slash command keeps "/x" text');
  expect(result.output).toContain('1 fail');
});

test('only a limited host command times out — the real runner kills it and reports timedOut', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-limit-'));
  const runner = createGateRunner(dir);
  const limited = await runner.localCommand('sleep', ['5'], dir, 200);
  expect(limited.timedOut).toBe(true);
  const unlimited = await runner.localCommand('sleep', ['0.3'], dir);
  expect(unlimited.timedOut).toBeUndefined();
  expect(unlimited.rc).toBe(0);
});

test('a timed-out limited command takes its grandchildren with it — no orphan outlives the gate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-group-'));
  const started = Date.now();
  const result = await limitedLocalCommand('sh', ['-c', 'sleep 30 & echo "grandchild=$!"; wait'], dir, 500);
  // Killing only the leader leaves the grandchild holding the pipe, so the call would return only when it ends (≈30s).
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(result.timedOut).toBe(true);
  const grandchild = Number(/grandchild=(\d+)/.exec(result.output)?.[1]);
  expect(grandchild).toBeGreaterThan(0);
  await new Promise((done) => setTimeout(done, 200));
  expect(() => process.kill(grandchild, 0)).toThrow();
});

test('a timed-out limited command returns by its hard deadline even if a process in another group holds the pipe', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-foreign-'));
  const started = Date.now();
  // perl leaves our group (setpgrp) and keeps stdout open — the 0.2.15 shape: test-deterministic runs `bun test` as its own group leader.
  const result = await limitedLocalCommand('sh', ['-c', 'perl -e "setpgrp(0,0); print qq(foreign=\\$\\$\\n); STDOUT->flush; sleep 30" & wait'], dir, 300, 300);
  const foreign = Number(/foreign=(\d+)/.exec(result.output)?.[1]);
  try {
    expect(foreign).toBeGreaterThan(0);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  } finally { try { if (foreign > 0) process.kill(foreign, 'SIGKILL'); } catch { /* already gone */ } }
});

test('a new-failure file whose cut or baseline re-check times out is an environment stall, not introduced', async () => {
  for (const where of ['cut', 'baseline'] as const) {
    const { instanceRoot, runner } = fake();
    const limits: Array<number | undefined> = [];
    const original = runner.command.bind(runner);
    runner.command = async (cmd, args, cwd, limitMs) => {
      if (cmd === 'bun' && args[0] === 'run') limits.push(limitMs);
      if (cmd === 'bun' && args[0] === 'run' && args[2] === './src/b.test.ts' && cwd.endsWith(`/${where}`))
        return { rc: 2, output: '\nSystemError: spawnSync bun ETIMEDOUT', timedOut: true };
      return original(cmd, args, cwd);
    };
    const logs = spyOn(debug, 'log');
    try {
      const result = await judgeGate(options(instanceRoot), runner);
      expect(result).toMatchObject({ outcome: 'error', introduced: [], unmeasuredRecheckFiles: ['src/b.test.ts'] });
      expect(result.stalledEnv).toContainEqual({ file: 'src/b.test.ts', reason: 'isolated-timeout', local: 'timeout' });
      expect(limits.every((limit) => limit === GATE_ISOLATED_TIMEOUT_MS)).toBe(true);
      expect(logs.mock.calls.some(([category, event, data]) => category === 'release-loop.gate' && event === 'isolated-timeout'
        && (data as { label?: string }).label === `${where} isolated`)).toBe(true);
    } finally { logs.mockRestore(); }
  }
});

test('GATE-PARTIAL: the plan made by planPartialRegate re-runs exactly the changed tests and every prior failure file', async () => {
  // Prior full gate measured A (old) and C (new); the fix commit touched only src/c.test.ts.
  const { instanceRoot, runner } = fake([], [A, D]);
  const sweeps: Array<{ logDir?: string; only?: readonly string[] }> = [];
  runner.sweep = async (_tree, logDir, _pod, only) => {
    sweeps.push({ logDir, only });
    return { rc: 1, output: runOutput([A]) };
  };
  const planned = planPartialRegate({ version: '1.0.1', priorCommit: 'c'.repeat(40), forCommit: CUT,
    changedFiles: ['src/c.test.ts', 'docs/x.md'], priorFailures: [A, C], priorErrors: [] });
  if (!planned.ok) throw new Error(planned.reason);
  writePartialPlan(instanceRoot, planned.plan);
  const result = await judgeGate(options(instanceRoot), runner);
  expect(sweeps).toHaveLength(1);
  expect(sweeps[0]!.only).toEqual(['src/a.test.ts', 'src/c.test.ts']);
  expect(sweeps[0]!.logDir).toEndWith(join('gate-logs', 'cut-partial'));
  // A still fails (as in the baseline) and C is fixed: no new regression, and the verdict says it was partial.
  expect(result).toMatchObject({ outcome: 'ok', introduced: [], preexisting: 1, partial: { priorCommit: 'c'.repeat(40), files: 2 } });
  expect(graphGateResult(result, true).summary).toStartWith('부분 재검 2파일');
  expect(JSON.parse(readFileSync(join(instanceRoot, 'release/1.0.1/gate-failures.json'), 'utf8'))).toMatchObject({ commit: CUT, failures: [A] });
});

test('GATE-RESUME-STALLED-ONLY: the gate rechecks only stalled files and carries every completed result', async () => {
  const { instanceRoot, runner } = fake([A], [A]);
  const sweeps: Array<{ logDir?: string; only?: readonly string[] }> = [];
  runner.sweep = async (_tree, logDir, _pod, only) => {
    sweeps.push({ logDir, only });
    return { rc: 0, output: '1 pass\n0 fail\n0 errors\nRan 1 tests across 1 files.\n' };
  };
  const planned = planStalledShardRecheck({ version: '1.0.1', measuredCommit: CUT, forCommit: CUT,
    failures: [A], errors: [B], stalledFiles: ['src/c.test.ts'], existsAtCommit: () => true });
  if (!planned.ok) throw new Error(planned.reason);
  writeRecheckPlan(instanceRoot, planned.plan);
  const result = await judgeGate(options(instanceRoot), runner);
  expect(sweeps[0]!.only).toEqual(['src/c.test.ts']);
  expect(sweeps[0]!.logDir).toEndWith(join('gate-logs', 'cut-partial'));
  expect(result).toMatchObject({ outcome: 'regression', introduced: [B], preexisting: 1,
    partial: { priorCommit: CUT, files: 1 } });
  expect(JSON.parse(readFileSync(join(instanceRoot, 'release/1.0.1/gate-failures.json'), 'utf8')))
    .toMatchObject({ commit: CUT, failures: [A], errors: [B] });
});

test('GATE-RESUME-STALLED-ONLY: a malformed recheck record returns an error before any sweep', async () => {
  const { instanceRoot, runner } = fake([], []);
  const onlys: Array<readonly string[] | undefined> = [];
  const sweep = runner.sweep;
  runner.sweep = async (tree, logDir, pod, only) => { onlys.push(only); return sweep(tree, logDir, pod, only); };
  mkdirSync(join(instanceRoot, 'release/1.0.1'), { recursive: true });
  writeFileSync(join(instanceRoot, 'release/1.0.1/gate-partial.json'), JSON.stringify({ kind: 'recheck', version: '1.0.1',
    priorCommit: CUT, forCommit: CUT, files: ['../escape.test.ts'], stalledFiles: ['../escape.test.ts'], priorFailures: [], priorErrors: [] }));
  const result = await judgeGate(options(instanceRoot), runner);
  expect(onlys).toEqual([]);
  expect(result).toMatchObject({ outcome: 'error', error: expect.stringContaining('invalid gate recheck plan') });
});

for (const mode of ['clean', 'image-drift', 'selection-gap'] as const) test(`RELEASE-GATE-RADIUS: next graph gate ${mode}`, async () => {
  const { root, instanceRoot, runner } = fake([], []);
  const repo = join(root, 'radius-repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  const git = (...args: string[]) => {
    const run = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (run.status !== 0) throw new Error(run.stderr);
    return run.stdout.trim();
  };
  git('init', '-q'); git('config', 'user.email', 'tc@test'); git('config', 'user.name', 'TC');
  writeFileSync(join(repo, 'package.json'), '{"version":"1.0.0"}\n');
  writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'src/a.test.ts'), "import { a } from './a'; test('a', () => a);\n");
  writeFileSync(join(repo, 'src/b.test.ts'), "test('b', () => 1);\n");
  git('add', '.'); git('commit', '-qm', 'rehearsal');
  const prior = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'src/a.ts'), 'export const a = 2;\n');
  if (mode === 'selection-gap') writeFileSync(join(repo, 'src/b.test.ts'), "test('b', () => 2);\n");
  writeFileSync(join(repo, 'package.json'), '{"version":"1.0.1"}\n');
  git('add', '.'); git('commit', '-qm', 'cut');
  const commit = git('rev-parse', 'HEAD');
  const runId = 'hard-12345678-1234-1234-1234-123456789abc';
  const gateVersion = hardRehearsalGateVersion('1.0.1', runId);
  const pins = { graphSha: 'c'.repeat(64), recipeSha: 'd'.repeat(64) };
  const imageDigest = `sha256:${'f'.repeat(64)}`;
  const envFingerprint = gateEnvFingerprint(process.env);
  const stampDir = join(instanceRoot, 'release/1.0.1/rehearsal');
  const gateDir = join(instanceRoot, 'release', gateVersion);
  mkdirSync(stampDir, { recursive: true }); mkdirSync(join(gateDir, 'gate-logs/cut'), { recursive: true });
  mkdirSync(join(instanceRoot, 'graph-runs/release-loop'), { recursive: true });
  writeFileSync(join(instanceRoot, 'graph-runs/release-loop/run-radius.json'), JSON.stringify({ graphId: 'release-loop', runId: 'run-radius',
    graphSnapshot: { graphSha: pins.graphSha, recipesSha: pins.recipeSha } }));
  writeFileSync(join(stampDir, 'hard-5h.json'), JSON.stringify({ version: '1.0.1', step: 'hard-5h', outcome: 'ok', sha: prior,
    endedAt: '2026-10-20T10:00:00.000Z',
    hardGateRunId: runId, hardGate: { outcome: 'ok', commit: prior, executor: 'pod', introduced: [] } }));
  writeFileSync(join(gateDir, 'gate-verdict.json'), JSON.stringify({ commit: prior, outcome: 'ok', baselineReceipt: {
    schema: 1, valid: true, reason: 'complete clean full sweep', version: gateVersion, commit: prior,
    ...pins, envFingerprint, imageDigest, files: 2, shards: 1 } }));
  writeFileSync(join(gateDir, 'gate-failures.json'), JSON.stringify({ commit: prior, failures: [], errors: [] }));
  writeFileSync(join(gateDir, 'gate-logs/cut/pod-0.json'), JSON.stringify({ commit: prior,
    files: ['src/a.test.ts', 'src/b.test.ts'], imageDigest, shardCount: 1, sweepId: 'sweep-one', attemptId: 'attempt-one' }));
  const sweeps: Array<readonly string[] | undefined> = [];
  runner.sweep = async (_tree, logDir, _pod, only) => {
    sweeps.push(only);
    if (only) {
      mkdirSync(logDir!, { recursive: true });
      const observed = mode === 'selection-gap' ? only.slice(0, 1) : only;
      writeFileSync(join(logDir!, 'pod-0.json'), JSON.stringify({ commit, files: observed,
        imageDigest: mode === 'image-drift' ? `sha256:${'a'.repeat(64)}` : imageDigest,
        sweepId: '12345678-1234-1234-1234-123456789abc', shardCount: 1, attemptId: 'attempt-one' }));
      return { rc: 0, output: runOutput([]), podSweep: {
        id: '12345678-1234-1234-1234-123456789abc', shards: 1, files: [...observed] } };
    }
    return { rc: 0, output: runOutput([]) };
  };
  const result = await judgeGate({ ...options(instanceRoot), repo, commit, graphRunId: 'run-radius',
    pod: { pool: 'local-pod:1' } }, runner, () => imageDigest);
  const chosen = mode === 'selection-gap' ? ['src/a.test.ts', 'src/b.test.ts'] : ['src/a.test.ts'];
  expect(sweeps).toEqual(mode === 'clean' ? [chosen] : [chosen, undefined]);
  expect(result).toMatchObject(mode === 'clean' ? { outcome: 'ok', partial: { priorCommit: prior, files: 1 } } : { outcome: 'ok' });
  if (mode !== 'clean') expect(result.partial).toBeUndefined();
  expect(existsSync(join(instanceRoot, 'release/1.0.1/gate-partial.json'))).toBe(false);
});

function carryCommits(root: string, changed: 'README.md' | 'src/changed.test.ts') {
  const repo = join(root, 'carry-repo');
  mkdirSync(repo);
  const git = (...args: string[]) => {
    const run = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
    return run.stdout.trim();
  };
  git('init', '-q');
  writeFileSync(join(repo, 'README.md'), '# first\n');
  git('add', '.');
  git('-c', 'user.name=TC', '-c', 'user.email=tc@example.test', 'commit', '-qm', 'first');
  const priorCommit = git('rev-parse', 'HEAD');
  if (changed.startsWith('src/')) mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, changed), '# changed\n');
  git('add', '.');
  git('-c', 'user.name=TC', '-c', 'user.email=tc@example.test', 'commit', '-qm', 'append');
  return { repo, priorCommit, commit: git('rev-parse', 'HEAD') };
}

test('GATE-REUSE-BY-DIFF: a clean docs-only carry writes the new SHA without starting a cut sweep', async () => {
  const { root, instanceRoot, runner } = fake([], []);
  const { repo, priorCommit, commit } = carryCommits(root, 'README.md');
  const dir = join(instanceRoot, 'release/1.0.1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'gate-failures.json'), JSON.stringify({ commit: priorCommit, failures: [] }));
  writeFileSync(join(dir, 'gate-verdict.json'), JSON.stringify({ commit: priorCommit, outcome: 'ok' }));
  const planned = planPartialRegate({ version: '1.0.1', priorCommit, forCommit: commit,
    changedFiles: ['README.md'], priorFailures: [], priorErrors: [] });
  if (!planned.ok) throw new Error(planned.reason);
  writePartialPlan(instanceRoot, planned.plan);
  runner.sweep = async () => { throw new Error('cut or baseline Pod sweep started'); };
  const result = await judgeGate({ ...options(instanceRoot), repo, commit }, runner);
  expect(result).toMatchObject({ outcome: 'ok', introduced: [], partial: { priorCommit, files: 0 } });
  expect(JSON.parse(readFileSync(join(dir, 'gate-failures.json'), 'utf8'))).toEqual({ commit, failures: [] });
  expect(JSON.parse(readFileSync(join(dir, 'gate-verdict.json'), 'utf8'))).toMatchObject({ commit, outcome: 'ok' });
});

test('GATE-REUSE-BY-DIFF: carry refuses a prior verdict from another SHA', async () => {
  const { root, instanceRoot, runner } = fake([], []);
  const { repo, priorCommit, commit } = carryCommits(root, 'README.md');
  const dir = join(instanceRoot, 'release/1.0.1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'gate-failures.json'), JSON.stringify({ commit: priorCommit, failures: [] }));
  writeFileSync(join(dir, 'gate-verdict.json'), JSON.stringify({ commit: 'd'.repeat(40), outcome: 'ok' }));
  writePartialPlan(instanceRoot, { kind: 'carry', version: '1.0.1', priorCommit, forCommit: commit,
    files: [], priorFailures: [], priorErrors: [] });
  runner.sweep = async () => { throw new Error('sweep started'); };
  const result = await judgeGate({ ...options(instanceRoot), repo, commit }, runner);
  expect(result).toMatchObject({ outcome: 'error', error: expect.stringContaining('no complete clean gate') });
});

test('GATE-REUSE-BY-DIFF: a forged carry plan cannot skip a changed test', async () => {
  const { root, instanceRoot, runner } = fake([], []);
  const { repo, priorCommit, commit } = carryCommits(root, 'src/changed.test.ts');
  const dir = join(instanceRoot, 'release/1.0.1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'gate-failures.json'), JSON.stringify({ commit: priorCommit, failures: [] }));
  writeFileSync(join(dir, 'gate-verdict.json'), JSON.stringify({ commit: priorCommit, outcome: 'ok' }));
  writePartialPlan(instanceRoot, { kind: 'carry', version: '1.0.1', priorCommit, forCommit: commit,
    files: [], priorFailures: [], priorErrors: [] });
  runner.sweep = async () => { throw new Error('sweep started'); };
  const result = await judgeGate({ ...options(instanceRoot), repo, commit }, runner);
  expect(result).toMatchObject({ outcome: 'error', error: expect.stringContaining('not docs-only') });
  expect(JSON.parse(readFileSync(join(dir, 'gate-failures.json'), 'utf8')).commit).toBe(priorCommit);
});

test('GATE-PARTIAL: a plan for another commit is ignored — the gate sweeps every file', async () => {
  const { instanceRoot, runner } = fake([A], [A]);
  const onlys: Array<readonly string[] | undefined> = [];
  const sweep = runner.sweep;
  runner.sweep = async (tree, logDir, pod, only) => { onlys.push(only); return sweep(tree, logDir, pod, only); };
  mkdirSync(join(instanceRoot, 'release/1.0.1'), { recursive: true });
  writeFileSync(join(instanceRoot, 'release/1.0.1/gate-partial.json'), JSON.stringify({
    version: '1.0.1', priorCommit: 'c'.repeat(40), forCommit: 'd'.repeat(40), files: ['src/c.test.ts'], priorFailures: [], priorErrors: [],
  }));
  const result = await judgeGate(options(instanceRoot), runner);
  expect(onlys[0]).toBeUndefined();
  expect(result.partial).toBeUndefined();
});

test('GATE-PARTIAL: the real local sweep runs only the planned files, and a planned file missing at the commit fails closed', async () => {
  const { root } = fixture();
  const paths = ['src/cli/a.test.ts', 'src/agent/b.test.ts', 'test/c.test.ts'];
  expect(spawnSync('git', ['init', '-q'], { cwd: root }).status).toBe(0);
  for (const path of paths) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), 'test');
  }
  expect(spawnSync('git', ['add', ...paths], { cwd: root }).status).toBe(0);
  const original = createGateRunner(root).command;
  const seen: string[][] = [];
  const runner = createGateRunner(root, undefined, async (cmd, args, cwd) => {
    if (cmd === 'bun' && args[0] === 'run') { seen.push(args); return { rc: 0, output: '1 pass\n0 fail\nRan 1 tests across 1 files.\n' }; }
    return original(cmd, args, cwd);
  });
  await runner.sweep(root, join(root, 'logs'), undefined, ['src/agent/b.test.ts']);
  const ran = seen.flatMap((args) => args.filter((arg) => arg.endsWith('.test.ts') || arg.startsWith('./')));
  expect(ran.some((arg) => arg.includes('src/agent/b.test.ts'))).toBe(true);
  expect(ran.some((arg) => arg.includes('src/cli') || arg.includes('test/c.test.ts'))).toBe(false);
  await expect(runner.sweep(root, join(root, 'logs'), undefined, ['src/agent/b.test.ts', 'src/gone.test.ts'])).rejects.toThrow('partial plan file missing');
});

test('GATE-PARTIAL: the Pod sweep schedules only the planned files, and a planned file missing at the commit fails closed', async () => {
  const { root, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'test'), { recursive: true });
  writeFileSync(join(repo, 'test/env-known-failures.json'), JSON.stringify({ env: 'linux-pod', measuredAt: '2026-10-01', tests: [] }));
  const scheduled: string[] = [];
  const pod = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: 'src/a.test.ts\nsrc/b.test.ts\n' };
    return fixtureRunner.command(cmd, args, cwd);
  }, async (o) => {
    scheduled.push(o.command.join(' '));
    const artifactsDir = join(root, o.name!);
    mkdirSync(artifactsDir);
    writeFileSync(join(artifactsDir, 'shard.log'), 'src/b.test.ts:\n1 pass\n0 fail\nRan 1 tests across 1 file.\n');
    writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
    return { exitCode: 0, artifactsDir, job: 'fake' };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 1, k3dCluster: 'test' }]));
  await pod.sweep(join(root, 'tree'), join(root, 'logs'), { pool: 'pool-test', shards: 4 }, ['src/b.test.ts']);
  expect(scheduled.length).toBeGreaterThan(0);
  expect(scheduled.every((command) => command.includes('src/b.test.ts') && !command.includes('src/a.test.ts'))).toBe(true);
  await expect(pod.sweep(join(root, 'tree'), join(root, 'logs2'), { pool: 'pool-test', shards: 4 }, ['src/b.test.ts', 'src/gone.test.ts']))
    .rejects.toThrow('partial plan file missing');
});

test('0.2.18: a Pod clone-root prefix (cwd changed by a test) is stripped back to a repo-relative test path', () => {
  const out = [
    '../../home/ubuntu/repo/src/task-orchestrator/surfaces/pod-source-receive.test.ts:',
    '(fail) podSourceScript > default prefers the mirror [1.00ms]',
    '/home/ubuntu/repo/src/a.test.ts:',
    '(pass) a > ok',
    'src/b.test.ts:',
  ].join('\n');
  expect(stripPodRepoRoot(out).split('\n')).toEqual([
    'src/task-orchestrator/surfaces/pod-source-receive.test.ts:',
    '(fail) podSourceScript > default prefers the mirror [1.00ms]',
    'src/a.test.ts:',
    '(pass) a > ok',
    'src/b.test.ts:',
  ]);
  // Anything else that climbs out of the repo is left as-is, so the safe-path check still refuses it.
  expect(stripPodRepoRoot('../../etc/x.test.ts:')).toBe('../../etc/x.test.ts:');
  expect(stripPodRepoRoot('../home/other/repo/src/x.test.ts:')).toBe('../home/other/repo/src/x.test.ts:');
});

// GATE-INTRO-RECHECK (0.2.19) — a new failure that is only bun's «timed out» shape gets one isolated re-run with a 60 s
// per-test limit before it is called introduced (0.2.18 first gate: two 5 s limits missed at 6.04/6.06 s → an 84-minute re-gate).
const timedOutOutput = (id: string, ms = 6040) => {
  const divider = id.indexOf(' > ');
  return `${id.slice(0, divider)}:\n(fail) ${id.slice(divider + 3)} [${ms}.00ms]\n  ^ this test timed out after 5000ms.\n\n0 pass\n1 fail\nRan 1 tests across 1 files.\n`;
};
function timeoutRecheckFake(relaxed: (cwd: string) => { rc: number; output: string; timedOut?: boolean }) {
  const made = fake([B], []);
  const old = made.runner.command;
  const rechecks: string[] = [];
  made.runner.command = async (cmd, args, cwd, limitMs) => {
    if (cmd === 'bun' && args[2] === './src/b.test.ts' && cwd.endsWith('/cut')) {
      if (args.includes('--timeout')) { rechecks.push(`${args.join(' ')} @${cwd} limit=${limitMs}`); return relaxed(cwd); }
      return { rc: 1, output: timedOutOutput(B) };
    }
    return old(cmd, args, cwd, limitMs);
  };
  return { ...made, rechecks };
}

test('timed-out shape parser: a timeout is told apart from an assertion failure', () => {
  const output = 'src/t.test.ts:\n(fail) slow one [101.03ms]\n  ^ this test timed out after 100ms.\n1 | x\nerror: expect(received).toBe(expected)\n(fail) bad one [0.26ms]\n 0 pass\n';
  expect(parseFailures(output)).toEqual(['src/t.test.ts > bad one', 'src/t.test.ts > slow one']);
  expect(parseTimedOutFailures(output)).toEqual(['src/t.test.ts > slow one']);
  expect(parseTimedOutFailures('\x1b[31msrc/t.test.ts:\x1b[0m\n(fail) a [5001.00ms]\n\x1b[2m  ^ this test timed out after 5000ms.\x1b[0m\n')).toEqual(['src/t.test.ts > a']);
});

test('GATE-INTRO-RECHECK: a timed-out new failure that passes the 60 s re-run is load-flaky, not introduced', async () => {
  const { root, instanceRoot, runner, rechecks } = timeoutRecheckFake(() => ({ rc: 0, output: 'src/b.test.ts:\n(pass) B [6100.00ms]\n\n1 pass\n0 fail\nRan 1 tests across 1 files.\n' }));
  const events: Array<{ category: string; event: string; data: unknown }> = [];
  const spy = spyOn(debug, 'log').mockImplementation((category: string, event: string, data?: unknown) => { events.push({ category, event, data }); });
  try {
    const result = await judgeGate(options(instanceRoot), runner);
    expect(result).toMatchObject({ outcome: 'ok', introduced: [], loadFlaky: [B] });
    expect(rechecks).toEqual([`run test:deterministic ./src/b.test.ts --timeout ${GATE_TIMEOUT_RECHECK_MS} @${join(dirname(rechecks[0]!.split(' @')[1]!), 'cut')} limit=${GATE_ISOLATED_TIMEOUT_MS}`]);
    expect(graphGateResult(result, true)).toMatchObject({ verdict: 'pass' });
    expect(graphGateResult(result, true).summary).toContain('부하 흔들림 1');
    expect(events).toContainEqual({ category: 'release-loop.gate', event: 'timeout-recheck', data: { file: 'src/b.test.ts', shaped: 1, flaky: 1, recheck: 'read', remote: 'local', limitMs: GATE_TIMEOUT_RECHECK_MS } });
    expect(JSON.parse(readFileSync(join(root, 'machine-ledger/release/1.0.1/gate-verdict.json'), 'utf8'))).toMatchObject({
      introduced: [], knownEnv: [], preexisting: [], loadFlaky: [B],
    });
    expect(events).toContainEqual(expect.objectContaining({ category: 'release-loop.gate', event: 'judged', data: expect.objectContaining({ introduced: 0, loadFlaky: 1, loadFlakyIds: [B] }) }));
    const rows = readFileSync(loadFlakyCensusPath(join(root, 'machine-ledger')), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(rows).toEqual([expect.objectContaining({ version: '1.0.1', commit: CUT, id: B, host: 'local', limitMs: GATE_TIMEOUT_RECHECK_MS })]);
    expect(statSync(loadFlakyCensusPath(join(root, 'machine-ledger'))).mode & 0o777).toBe(0o600);
  } finally { spy.mockRestore(); }
});

test('GATE-INTRO-RECHECK: still failing, a re-run that times out, or an unreadable re-run stays introduced', async () => {
  for (const relaxed of [
    () => ({ rc: 1, output: timedOutOutput(B, 60_010) }),
    () => ({ rc: 124, output: '', timedOut: true }),
    () => ({ rc: 1, output: 'garbage\n' }),
  ]) {
    const { root, instanceRoot, runner, rechecks } = timeoutRecheckFake(relaxed);
    const result = await judgeGate(options(instanceRoot), runner);
    expect(result).toMatchObject({ outcome: 'regression', introduced: [B] });
    expect(result.loadFlaky).toBeUndefined();
    expect(rechecks).toHaveLength(1);
    expect(existsSync(loadFlakyCensusPath(join(root, 'machine-ledger')))).toBe(false);
  }
});

test('GATE-INTRO-RECHECK: an assertion failure is introduced as before, with no re-run', async () => {
  const { instanceRoot, runner, calls } = fake([B], []);
  const result = await judgeGate(options(instanceRoot), runner);
  expect(result).toMatchObject({ outcome: 'regression', introduced: [B] });
  expect(result.loadFlaky).toBeUndefined();
  expect(calls.some((call) => call.includes('--timeout'))).toBe(false);
});

test('GATE-RECHECK-FANOUT: 106 new files cross 32-file windows with no unmeasured result and at most four Pods', async () => {
  const ids = Array.from({ length: 106 }, (_, i) => `src/intro-${i}.test.ts > fails`).reverse();
  const { root, instanceRoot, runner, calls } = fake(ids, []);
  let active = 0;
  let peak = 0;
  let cutJobs = 0;
  const checked: string[] = [];
  runner.recheckPodBatch = async (files, commit) => {
    cutJobs++;
    active++;
    peak = Math.max(peak, active);
    for (const file of files) checked.push(`${commit}:${file}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    return new Map(files.map((file) => [file, { rc: 1, output: runOutput([`${file} > fails`]) }]));
  };
  runner.recheckPod = async (file, commit) => {
    active++;
    peak = Math.max(peak, active);
    checked.push(`${commit}:${file}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    return commit === CUT ? { rc: 1, output: runOutput([`${file} > fails`]) }
      : { rc: 0, output: '1 pass\n0 fail\nRan 1 tests across 1 files.\n' };
  };
  const result = await judgeGate({ ...options(instanceRoot), recheckFileLimit: 32, pod: { pool: 'test', isolationConcurrency: 4 } }, runner);
  expect(result).toMatchObject({ outcome: 'regression', introduced: [...ids].sort(), knownEnv: 0, stalledEnv: [] });
  expect(result.unmeasuredRecheckFiles).toBeUndefined();
  expect(peak).toBe(4);
  expect(cutJobs).toBe(14); // Four windows: 32, 32, 32, 10 files; eight files per Pod.
  expect(checked.filter((item) => item.startsWith(`${CUT}:`))).toHaveLength(106);
  expect(checked.filter((item) => item.startsWith(`${BASE}:`))).toHaveLength(106);
  expect(calls.filter((call) => call.startsWith('bun run test:deterministic'))).toHaveLength(0);
  expect(JSON.parse(readFileSync(join(root, 'machine-ledger/release/1.0.1/gate-verdict.json'), 'utf8')))
    .toMatchObject({ outcome: 'regression', introduced: [...ids].sort() });
});

test('GATE-WARM-SHADOW: the first three cut rechecks are separate one-file Jobs', async () => {
  const { instanceRoot, runner } = fake([A, B, C, D], []);
  const groups: string[][] = [];
  const ids = new Map([A, B, C, D].map((id) => [id.split(' > ')[0]!, id]));
  runner.recheckPodBatch = async (files, commit) => {
    if (commit === CUT) groups.push([...files]);
    return new Map(files.map((file) => [file, { rc: 1, output: runOutput([ids.get(file)!]) }]));
  };
  runner.recheckPod = async () => ({ rc: 0, output: runOutput([]) });
  await judgeGate({ ...options(instanceRoot), pod: { pool: 'test', warmReplay: async () => { throw new Error('injected runner does not call provider'); },
    warmQuarantine: async () => {}, warmFinalize: async () => {} } }, runner);
  expect(groups).toEqual([['src/a.test.ts'], ['src/b.test.ts'], ['src/c.test.ts'], ['src/d.test.ts']]);
});

test('GATE-WARM-SHADOW: one-file warm budget applies once across recheck windows', async () => {
  const { instanceRoot, runner } = fake([A, B, C, D], []);
  const groups: string[][] = [];
  const ids = new Map([A, B, C, D].map((id) => [id.split(' > ')[0]!, id]));
  runner.recheckPodBatch = async (files, commit) => {
    if (commit === CUT) groups.push([...files]);
    return new Map(files.map((file) => [file, { rc: 1, output: runOutput([ids.get(file)!]) }]));
  };
  runner.recheckPod = async () => ({ rc: 0, output: runOutput([]) });
  await judgeGate({ ...options(instanceRoot), recheckFileLimit: 2, pod: { pool: 'test',
    warmReplay: async () => { throw new Error('injected runner does not call provider'); },
    warmQuarantine: async () => {}, warmFinalize: async () => {} } }, runner);
  expect(groups).toEqual([['src/a.test.ts'], ['src/b.test.ts'], ['src/c.test.ts'], ['src/d.test.ts']]);
});

test('GATE-WARM-SHADOW: three files are eligible regardless of completion order', async () => {
  const { instanceRoot, runner } = fake([A, B, C], []);
  const completed: Array<{ file: string; eligible: boolean }> = [];
  const ids = new Map([A, B, C].map((id) => [id.split(' > ')[0]!, id]));
  runner.recheckPodBatch = async (files, commit, pod) => {
    if (commit === CUT) {
      if (files[0] !== 'src/c.test.ts') await new Promise((resolve) => setTimeout(resolve, 20));
      completed.push({ file: files[0]!, eligible: pod.warmEligible === true });
    }
    return new Map(files.map((file) => [file, { rc: 1, output: runOutput([ids.get(file)!]) }]));
  };
  runner.recheckPod = async () => ({ rc: 0, output: runOutput([]) });
  await judgeGate({ ...options(instanceRoot), pod: { pool: 'test',
    warmReplay: async () => { throw new Error('injected runner does not call provider'); },
    warmQuarantine: async () => {}, warmFinalize: async () => {} } }, runner);
  expect(completed.sort((a, b) => a.file.localeCompare(b.file))).toEqual([
    { file: 'src/a.test.ts', eligible: true },
    { file: 'src/b.test.ts', eligible: true },
    { file: 'src/c.test.ts', eligible: true },
  ]);
});

test('GATE-WARM-ADOPT: only exact, finalized shadow parity in the recent verdict enables reuse', () => {
  const key = { context: 'pool', imageDigest: 'sha256:abc', lockHash: 'lock', architecture: 'arm64' };
  const row = { files: ['src/b.test.ts'], attemptId: 'a', status: 'observed' as const, reason: 'match',
    quarantined: 'no' as const, finalized: true, cutSha: CUT, baselineSha: BASE, workerKey: key };
  const history = [{ version: '1.0.1', commit: CUT, baselineCommit: BASE,
    warmShadow: [row, { ...row, attemptId: 'b' }, { ...row, attemptId: 'c' }] }];
  expect(warmEvidenceFromVerdicts(history, '1.0.1', CUT, BASE, 'lock')).toMatchObject({
    consecutiveMatchSamples: 3, recentMismatchCount: 0, canaryPassed: true,
    expected: { head: CUT, main: CUT, lock: 'lock' }, worker: { head: CUT, main: CUT, lock: 'lock' },
  });
  expect(warmEvidenceFromVerdicts(history, '1.0.1', CUT, BASE, 'other')).toBeUndefined();
  expect(warmEvidenceFromVerdicts([{ ...history[0]!, warmShadow: [{ ...row, workerKey: undefined }] }],
    '1.0.1', CUT, BASE, 'lock')).toBeUndefined();
  expect(warmEvidenceFromVerdicts([{ ...history[0]!, warmShadow: [row, { ...row, attemptId: 'b', reason: 'result' }] }],
    '1.0.1', CUT, BASE, 'lock')?.recentMismatchCount).toBe(1);
  expect(warmEvidenceFromVerdicts([{ ...history[0]!, warmShadow: [row, row, row] }],
    '1.0.1', CUT, BASE, 'lock')).toBeUndefined();
  expect(warmEvidenceFromVerdicts([{ ...history[0]!, warmShadow: [row, { ...row, attemptId: 'b',
    workerKey: { ...key, imageDigest: 'sha256:other' } }] }], '1.0.1', CUT, BASE, 'lock')).toBeUndefined();
  expect(warmEvidenceFromVerdicts([{ ...history[0]!, warmShadow: [{ ...row, files: undefined } as unknown as typeof row] }],
    '1.0.1', CUT, BASE, 'lock')).toBeUndefined();
  expect(warmEvidenceFromVerdicts([{ ...history[0]!, warmShadow: [{ ...row, quarantined: 'yes' }] }],
    '1.0.1', CUT, BASE, 'lock')).toBeUndefined();
  expect(warmEvidenceFromVerdicts([{ ...history[0]!, warmShadow: [{ ...row, files: ['../src/b.test.ts'] }] }],
    '1.0.1', CUT, BASE, 'lock')).toBeUndefined();
  expect(warmEvidenceFromVerdicts([{ ...history[0]!, commit: 'c'.repeat(40) }, history[0]!],
    '1.0.1', CUT, BASE, 'lock')).toBeUndefined();
});

test('GATE-WARM-ADOPT: verified history skips a fresh Job; bad reply, key or history falls back', async () => {
  for (const scenario of ['pass', 'bad-reply', 'wrong-key', 'duplicate-history'] as const) {
    const valid = scenario === 'pass';
    const { root, instanceRoot, ledgerRoot, runner } = fake([B], []);
    const lockText = 'pinned lock bytes\n';
    const lockHash = createHash('sha256').update(lockText).digest('hex');
    const key = { context: 'pool', imageDigest: 'sha256:abc', lockHash, architecture: 'arm64' };
    const shadow = (scenario === 'duplicate-history' ? ['a', 'a', 'a'] : ['a', 'b', 'c']).map((attemptId) => ({ files: ['src/b.test.ts'], attemptId,
      status: 'observed', reason: 'match', quarantined: 'no', finalized: true,
      cutSha: CUT, baselineSha: BASE, workerKey: key }));
    mkdirSync(join(ledgerRoot, 'release/1.0.1'), { recursive: true });
    writeFileSync(join(ledgerRoot, 'release/1.0.1/gate-verdict.json'), JSON.stringify({
      version: '1.0.1', commit: CUT, baselineCommit: BASE, outcome: 'ok', warmHistory: [], warmShadow: shadow,
    }));
    const local = runner.localCommand.bind(runner);
    runner.localCommand = async (cmd, args, cwd, timeout) => cmd === 'git' && args[0] === 'show'
      ? { rc: 0, output: lockText } : local(cmd, args, cwd, timeout);
    let freshCutJobs = 0;
    let replays = 0;
    let quarantines = 0;
    let finalizes = 0;
    runner.recheckPodBatch = async (files, commit) => {
      if (commit === CUT) freshCutJobs++;
      return new Map(files.map((file) => [file, { rc: 1, output: runOutput([B]) }]));
    };
    runner.recheckPod = async (file, commit) => {
      if (commit === CUT) freshCutJobs++;
      return { rc: commit === CUT ? 1 : 0, output: runOutput(commit === CUT ? [B] : []) };
    };
    const result = await judgeGate({ ...options(instanceRoot), pod: { pool: 'test',
      warmReuseConfig: { gateRecheck: true },
      warmReplay: async (request) => {
        replays++;
        const command = { ...request, leaseId: 'lease', generation: 1, workerId: 'worker',
          key: scenario === 'wrong-key' ? { ...key, imageDigest: 'sha256:other' } : key };
        return { command, transport: { status: 'observed' as const, reason: 'complete' as const,
          reply: { ...command, startedAt: Date.now(), finishedAt: Date.now(),
            files: [{ file: request.files[0]!, rc: valid ? 0 : 1, junitComplete: true,
              failureIds: valid ? [] : [B], errorIds: [] }] } } };
      },
      warmFinalize: async () => { finalizes++; },
      warmQuarantine: async () => { quarantines++; },
    } }, runner);
    expect(result.outcome).toBe(valid ? 'ok' : 'regression');
    expect(freshCutJobs).toBe(valid ? 0 : 1);
    expect(replays).toBe(scenario === 'duplicate-history' ? 0 : 1);
    expect(finalizes).toBe(valid ? 1 : 0);
    expect(quarantines).toBe(scenario === 'bad-reply' || scenario === 'wrong-key' ? 1 : 0);
    expect(JSON.parse(readFileSync(join(root, 'machine-ledger/release/1.0.1/gate-verdict.json'), 'utf8')).warmHistory).toHaveLength(1);
  }
});

test('GATE-WARM-SHADOW: later recheck failure persists completed cut shadows once', async () => {
  const { root, instanceRoot, runner } = fake([A, B, C], []);
  const files = ['src/a.test.ts', 'src/b.test.ts'];
  let jobs = 0;
  let replays = 0;
  const completedFiles: string[] = [];
  const podRunner = createGateRunner(root, undefined, async () => ({ rc: 0, output: '' }), async (request) => {
    const file = [...files, 'src/c.test.ts'].find((entry) => request.command[2]!.includes(entry));
    expect(file).toBeDefined();
    if (file === 'src/c.test.ts') throw new Error('later recheck batch failed');
    if (file === 'src/a.test.ts') await new Promise((resolve) => setTimeout(resolve, 20));
    completedFiles.push(file!);
    const binding = /attempt=%s\\n" '[a-f0-9]+' '([^']+)'/.exec(request.command[2]!);
    expect(binding).not.toBeNull();
    const artifactsDir = join(root, `completed-job-${++jobs}`);
    mkdirSync(artifactsDir);
    const junit = `<testsuites tests="1"><testsuite name="${file}" file="${file}" tests="1"><testcase name="pass" file="${file}"/></testsuite></testsuites>`;
    const digest = createHash('sha256').update(junit).digest('hex');
    writeFileSync(join(artifactsDir, 'install.rc'), '0\n');
    writeFileSync(join(artifactsDir, 'part-0.junit.xml'), junit);
    writeFileSync(join(artifactsDir, 'part-0.rc'), '0\n');
    writeFileSync(join(artifactsDir, 'part-0.log'), `[warm-worker] file=${file}\n[warm-worker] cut=${CUT} attempt=${binding![1]}\nbun test v1.4.2\n${file}:\n(pass) pass\n1 pass\n0 fail\nRan 1 test across 1 file.\n[warm-worker] junit-sha256=${digest}\n`);
    return { exitCode: 0, artifactsDir, job: `completed-job-${jobs}` };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 2, k3dCluster: 'test' }]));
  runner.recheckPod = podRunner.recheckPod;
  runner.recheckPodBatch = podRunner.recheckPodBatch;
  const result = await judgeGate({ ...options(instanceRoot), pod: { pool: 'pool-test', installSlots: 0,
    warmReplay: async () => { replays++; return { command: null,
      transport: { status: 'fallback', reason: 'no-candidate', reply: null } }; },
    warmQuarantine: async () => {}, warmFinalize: async () => {} } }, runner);
  expect(result).toMatchObject({ outcome: 'error', error: expect.stringContaining('later recheck batch failed') });
  expect(jobs).toBe(2);
  expect(replays).toBe(2);
  expect(completedFiles).toEqual(['src/b.test.ts', 'src/a.test.ts']);
  expect(result.warmShadow).toHaveLength(2);
  expect(result.warmShadow).toMatchObject([
    { files: ['src/a.test.ts'], reason: 'no-candidate' },
    { files: ['src/b.test.ts'], reason: 'no-candidate' },
  ]);
  const verdict = JSON.parse(readFileSync(join(root, 'machine-ledger/release/1.0.1/gate-verdict.json'), 'utf8'));
  expect(verdict.warmShadow).toEqual(result.warmShadow);
  expect(new Set(verdict.warmShadow.map((row: { attemptId: string }) => row.attemptId)).size).toBe(2);
});

test('gate profile alone wires the live warm provider; injected runners and fixed profile stay off', () => {
  const opts = { commit: CUT, version: '1.0.1', pod: { pool: 'pool-test' } };
  expect(withWarmGateHooks(opts, { pod: { warmPoolProfile: 'fixed' } })).toBe(opts);
  expect(withWarmGateHooks(opts, { pod: { warmPoolProfile: 'gate' } }, true)).toBe(opts);
  expect(withWarmGateHooks({ commit: CUT, version: '1.0.1' }, { pod: { warmPoolProfile: 'gate' } }).pod).toBeUndefined();
  const wired = withWarmGateHooks(opts, { pod: { warmPoolProfile: 'gate' } });
  expect(wired.pod?.warmReplay).toBeFunction();
  expect(wired.pod?.warmFinalize).toBeFunction();
  expect(wired.pod?.warmQuarantine).toBeFunction();
  expect(wired.pod?.pool).toBe('pool-test');
});

test('runGateNode reads the configured profile before choosing live Pod warm hooks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-warm-entry-'));
  scratch.push(root);
  setElanousConfigDir(root);
  const wired: boolean[] = [];
  const judge = async (opts: Parameters<typeof judgeGate>[0]) => {
    wired.push(!!opts.pod?.warmReplay && !!opts.pod?.warmFinalize && !!opts.pod?.warmQuarantine);
    return { outcome: 'ok' as const, commit: CUT, introduced: [], preexisting: 0, fixed: 0,
      knownEnv: 0, knownEnvCleared: [], stalledEnv: [], rcNonzeroNoFailures: [], durationMs: 0 };
  };
  const args = ['--commit', CUT, '--version', '1.0.1', '--baseline-version', '1.0.0', '--pod-pool', 'pool-test', '--json'];
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ pod: { warmPoolProfile: 'gate' } }));
    resetUserConfig();
    expect(await runGateNode(args, {}, undefined, judge)).toBe(0);
    writeFileSync(join(root, 'config.json'), JSON.stringify({ pod: { warmPoolProfile: 'fixed' } }));
    resetUserConfig();
    expect(await runGateNode(args, {}, undefined, judge)).toBe(0);
    expect(wired).toEqual([true, false]);
  } finally { resetUserConfig(); }
});

test('GATE-WARM-SHADOW: the Job verdict and durable gate record retain separate worker observation', async () => {
  const { root, instanceRoot, runner } = fake([B], []);
  const observed = { files: ['src/b.test.ts'], attemptId: 'attempt-1', status: 'observed' as const,
    reason: 'result', quarantined: 'yes' as const };
  runner.recheckPodBatch = async (files) => new Map(files.map((file) => [file, {
    rc: 1, output: runOutput([B]), warmShadow: observed,
  }]));
  runner.recheckPod = async () => ({ rc: 0, output: runOutput([]) });
  const result = await judgeGate({ ...options(instanceRoot), pod: { pool: 'test' } }, runner);
  expect(result).toMatchObject({ outcome: 'regression', introduced: [B], warmShadow: [observed] });
  const verdict = JSON.parse(readFileSync(join(root, 'machine-ledger/release/1.0.1/gate-verdict.json'), 'utf8'));
  expect(verdict).toMatchObject({ outcome: 'regression', introduced: [B], warmShadow: [observed] });
});

test('GATE-WARM-SHADOW: timeout retry observation is persisted and each verdict gets a fresh budget', async () => {
  const { root, instanceRoot, runner } = fake([B], []);
  const missing = { files: ['src/b.test.ts'], attemptId: 'initial', status: 'unmeasured' as const,
    reason: 'reference-unmeasured', quarantined: 'no' as const };
  const observed = { files: ['src/b.test.ts'], attemptId: 'relaxed', status: 'observed' as const,
    reason: 'match', quarantined: 'no' as const };
  const scopes: unknown[] = [];
  runner.recheckPodBatch = async (files, commit, pod) => {
    if (commit === CUT) scopes.push(pod.warmShadowScope);
    return new Map(files.map((file) => [file, { rc: 1, output: timedOutOutput(B),
      ...(commit === CUT ? { warmShadow: missing } : {}) }]));
  };
  runner.recheckPod = async (_file, commit, pod, _limit, relaxed) => {
    if (commit === CUT && relaxed) {
      scopes.push(pod.warmShadowScope);
      return { rc: 0, output: runOutput([]), warmShadow: observed };
    }
    return { rc: 0, output: runOutput([]) };
  };
  const opts = { ...options(instanceRoot), pod: { pool: 'test',
    warmReplay: async () => { throw new Error('injected runner does not call provider'); },
    warmQuarantine: async () => {}, warmFinalize: async () => {} } };
  const first = await judgeGate(opts, runner);
  expect(first).toMatchObject({ outcome: 'ok', loadFlaky: [B], warmShadow: [missing, observed] });
  expect(JSON.parse(readFileSync(join(root, 'machine-ledger/release/1.0.1/gate-verdict.json'), 'utf8')))
    .toMatchObject({ warmShadow: [missing, observed] });
  expect(scopes[0]).toBe(scopes[1]);
  await judgeGate(opts, runner);
  expect(scopes[2]).not.toBe(scopes[0]);
});

test('GATE-WARM-SHADOW: real recheck Jobs persist both missing and relaxed observations', async () => {
  const { root, instanceRoot, runner } = fake([B], []);
  const file = 'src/b.test.ts';
  let jobs = 0;
  const podRunner = createGateRunner(root, undefined, async () => ({ rc: 0, output: '' }), async (request) => {
    const artifactsDir = join(root, `warm-timeout-job-${++jobs}`);
    mkdirSync(artifactsDir);
    writeFileSync(join(artifactsDir, 'install.rc'), '0\n');
    if (request.command[2]!.includes("'--timeout' '60000'")) {
      const binding = /attempt=%s\\n" '[a-f0-9]+' '([^']+)'/.exec(request.command[2]!);
      expect(binding).not.toBeNull();
      const junit = `<testsuites tests="1"><testsuite name="${file}" file="${file}" tests="1"><testcase name="B" file="${file}"/></testsuite></testsuites>`;
      const digest = createHash('sha256').update(junit).digest('hex');
      writeFileSync(join(artifactsDir, 'part-0.junit.xml'), junit);
      writeFileSync(join(artifactsDir, 'part-0.rc'), '0\n');
      writeFileSync(join(artifactsDir, 'part-0.log'), `[warm-worker] file=${file}\n[warm-worker] cut=${CUT} attempt=${binding![1]}\nbun test v1.4.2\n${file}:\n(pass) B\n1 pass\n0 fail\nRan 1 test across 1 file.\n[warm-worker] junit-sha256=${digest}\n`);
    } else {
      writeFileSync(join(artifactsDir, 'part-0.rc'), '1\n');
      writeFileSync(join(artifactsDir, 'part-0.log'), timedOutOutput(B));
    }
    return { exitCode: 0, artifactsDir, job: `warm-timeout-job-${jobs}` };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 1, k3dCluster: 'test' }]));
  runner.recheckPod = podRunner.recheckPod;
  runner.recheckPodBatch = podRunner.recheckPodBatch;
  const result = await judgeGate({ ...options(instanceRoot), pod: { pool: 'pool-test', installSlots: 0,
    warmReplay: async () => ({ command: null, transport: { status: 'fallback', reason: 'no-candidate', reply: null } }),
    warmQuarantine: async () => {}, warmFinalize: async () => {} } }, runner);
  expect(jobs).toBe(2);
  expect(result).toMatchObject({ outcome: 'ok', loadFlaky: [B],
    warmShadow: [{ status: 'unmeasured', reason: 'reference-unmeasured' },
      { status: 'fallback', reason: 'no-candidate' }] });
  expect(JSON.parse(readFileSync(join(root, 'machine-ledger/release/1.0.1/gate-verdict.json'), 'utf8')))
    .toMatchObject({ warmShadow: [{ status: 'unmeasured', reason: 'reference-unmeasured' },
      { status: 'fallback', reason: 'no-candidate' }] });
});

test('GATE-WARM-SHADOW: two incomplete eligible Job references each leave an observation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-warm-two-missing-'));
  scratch.push(root);
  let jobs = 0;
  const runner = createGateRunner(root, undefined, async () => ({ rc: 0, output: '' }), async () => {
    const artifactsDir = join(root, `missing-job-${++jobs}`);
    mkdirSync(artifactsDir);
    writeFileSync(join(artifactsDir, 'install.rc'), '0\n');
    writeFileSync(join(artifactsDir, 'part-0.rc'), '1\n');
    writeFileSync(join(artifactsDir, 'part-0.log'), runOutput([jobs === 1 ? A : B]));
    return { exitCode: 0, artifactsDir, job: `missing-job-${jobs}` };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 1, k3dCluster: 'test' }]));
  const scope = { requested: false };
  const pod = { pool: 'pool-test', installSlots: 0, warmCutSha: CUT, warmEligible: true,
    warmShadowScope: scope, warmReplay: async () => { throw new Error('incomplete references cannot replay'); },
    warmQuarantine: async () => {}, warmFinalize: async () => {} };
  const first = await runner.recheckPod!('src/a.test.ts', CUT, pod, GATE_ISOLATED_TIMEOUT_MS);
  const second = await runner.recheckPod!('src/b.test.ts', CUT, pod, GATE_ISOLATED_TIMEOUT_MS);
  expect(first.warmShadow).toMatchObject({ status: 'unmeasured', reason: 'reference-unmeasured' });
  expect(second.warmShadow).toMatchObject({ status: 'unmeasured', reason: 'reference-unmeasured' });
  expect(first.warmShadow?.attemptId).not.toBe(second.warmShadow?.attemptId);
  expect(scope.requested).toBe(false);
});

test('GATE-WARM-SHADOW: missing part artifacts and timed-out Jobs remain red with persisted missing references', async () => {
  for (const mode of ['missing-rc', 'part-timeout'] as const) {
    const { root, instanceRoot, runner } = fake([B], []);
    const podRunner = createGateRunner(root, undefined, async () => ({ rc: 0, output: '' }), async () => {
      const artifactsDir = join(root, `warm-${mode}`);
      mkdirSync(artifactsDir);
      writeFileSync(join(artifactsDir, 'install.rc'), '0\n');
      writeFileSync(join(artifactsDir, 'part-0.log'), timedOutOutput(B));
      if (mode === 'part-timeout') {
        writeFileSync(join(artifactsDir, 'part-0.rc'), '124\n');
        writeFileSync(join(artifactsDir, 'part-0.timeout'), '1\n');
      }
      return { exitCode: 0, artifactsDir, job: `warm-${mode}` };
    }, new PodPoolScheduler([{ context: 'pool-test', capacity: 1, k3dCluster: 'test' }]));
    runner.recheckPod = podRunner.recheckPod;
    runner.recheckPodBatch = podRunner.recheckPodBatch;
    const result = await judgeGate({ ...options(instanceRoot), pod: { pool: 'pool-test', installSlots: 0,
      warmReplay: async () => { throw new Error('unmeasured reference cannot replay'); },
      warmQuarantine: async () => {}, warmFinalize: async () => {} } }, runner);
    expect(result).toMatchObject({ outcome: 'error', unmeasuredRecheckFiles: ['src/b.test.ts'],
      warmShadow: [{ status: 'unmeasured', reason: 'reference-unmeasured' }] });
    expect(JSON.parse(readFileSync(join(root, 'machine-ledger/release/1.0.1/gate-verdict.json'), 'utf8')))
      .toMatchObject({ outcome: 'error', warmShadow: [{ status: 'unmeasured', reason: 'reference-unmeasured' }] });
  }
});

test('GATE-WARM-SHADOW: two parallel incomplete Jobs both persist their attempt identities', async () => {
  const { root, instanceRoot, runner } = fake([A, B], []);
  let jobs = 0;
  const podRunner = createGateRunner(root, undefined, async () => ({ rc: 0, output: '' }), async () => {
    const artifactsDir = join(root, `parallel-incomplete-${++jobs}`);
    mkdirSync(artifactsDir);
    writeFileSync(join(artifactsDir, 'install.rc'), '0\n');
    writeFileSync(join(artifactsDir, 'part-0.log'), runOutput([jobs === 1 ? A : B]));
    return { exitCode: 0, artifactsDir, job: `parallel-incomplete-${jobs}` };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 2, k3dCluster: 'test' }]));
  runner.recheckPod = podRunner.recheckPod;
  runner.recheckPodBatch = podRunner.recheckPodBatch;
  const result = await judgeGate({ ...options(instanceRoot), pod: { pool: 'pool-test', installSlots: 0, isolationConcurrency: 2,
    warmReplay: async () => { throw new Error('incomplete references cannot replay'); },
    warmQuarantine: async () => {}, warmFinalize: async () => {} } }, runner);
  expect(jobs).toBe(2);
  expect(result).toMatchObject({ outcome: 'error', unmeasuredRecheckFiles: ['src/a.test.ts', 'src/b.test.ts'] });
  expect(result.warmShadow).toHaveLength(2);
  expect(new Set(result.warmShadow!.map((row) => row.attemptId)).size).toBe(2);
  const verdict = JSON.parse(readFileSync(join(root, 'machine-ledger/release/1.0.1/gate-verdict.json'), 'utf8'));
  expect(verdict.warmShadow).toHaveLength(2);
  expect(new Set(verdict.warmShadow.map((row: { attemptId: string }) => row.attemptId)).size).toBe(2);
});

test('GATE-WARM-SHADOW: cap-one failure still attempts the second Job and retains its successful shadow', async () => {
  const { root, instanceRoot, runner } = fake([A, B], []);
  let jobs = 0;
  const podRunner = createGateRunner(root, undefined, async () => ({ rc: 0, output: '' }), async () => {
    const artifactsDir = join(root, `serial-incomplete-${++jobs}`);
    mkdirSync(artifactsDir);
    writeFileSync(join(artifactsDir, 'install.rc'), '0\n');
    writeFileSync(join(artifactsDir, 'part-0.log'), runOutput([jobs === 1 ? A : B]));
    if (jobs === 2) writeFileSync(join(artifactsDir, 'part-0.rc'), '1\n');
    return { exitCode: 0, artifactsDir, job: `serial-incomplete-${jobs}` };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 1, k3dCluster: 'test' }]));
  runner.recheckPod = podRunner.recheckPod;
  runner.recheckPodBatch = podRunner.recheckPodBatch;
  const result = await judgeGate({ ...options(instanceRoot), recheckFileLimit: 1,
    pod: { pool: 'pool-test', installSlots: 0, isolationConcurrency: 1,
      warmReplay: async () => { throw new Error('incomplete references cannot replay'); },
      warmQuarantine: async () => {}, warmFinalize: async () => {} } }, runner);
  expect(jobs).toBe(2);
  expect(result).toMatchObject({ outcome: 'error', unmeasuredRecheckFiles: ['src/a.test.ts'] });
  expect(result.warmShadow).toHaveLength(2);
  expect(new Set(result.warmShadow!.map((row) => row.attemptId)).size).toBe(2);
  const verdict = JSON.parse(readFileSync(join(root, 'machine-ledger/release/1.0.1/gate-verdict.json'), 'utf8'));
  expect(verdict.warmShadow).toHaveLength(2);
});

test('GATE-RECHECK-POD: a final isolated check pins its commit and reads the real one-part Pod artifact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-recheck-pod-'));
  const requests: RunPodCommandOptions[] = [];
  try {
    const runner = createGateRunner(root, undefined, async () => ({ rc: 0, output: '' }), async (request) => {
      requests.push(request);
      const artifactsDir = join(root, `artifact-${requests.length}`);
      mkdirSync(artifactsDir);
      writeFileSync(join(artifactsDir, 'install.rc'), '0\n');
      writeFileSync(join(artifactsDir, 'part-0.log'), runOutput([A]));
      writeFileSync(join(artifactsDir, 'part-0.rc'), '1\n');
      if (request.command[2]!.includes("'./src/b.test.ts'")) {
        writeFileSync(join(artifactsDir, 'part-1.log'), '1 pass\n0 fail\nRan 1 tests across 1 files.\n');
        writeFileSync(join(artifactsDir, 'part-1.rc'), '0\n');
      }
      if (request.command[2]!.includes("'./src/c.test.ts'")) {
        writeFileSync(join(artifactsDir, 'part-2.log'), '1 pass\n0 fail\nRan 1 tests across 1 files.\n');
        writeFileSync(join(artifactsDir, 'part-2.rc'), '0\n');
      }
      if (request.command[2]!.includes("'./src/d.test.ts'")) {
        writeFileSync(join(artifactsDir, 'part-0.log'), 'timed out\n');
        writeFileSync(join(artifactsDir, 'part-0.rc'), '124\n');
        writeFileSync(join(artifactsDir, 'part-0.timeout'), '0\n');
      }
      return { exitCode: 0, artifactsDir, job: 'fake-recheck' };
    }, new PodPoolScheduler([{ context: 'pool-test', capacity: 1, k3dCluster: 'test' }]));
    let warmCalls = 0;
    const result = await runner.recheckPod!('src/a.test.ts', CUT, { pool: 'pool-test', installSlots: 0, warmCutSha: CUT, warmEligible: true,
      warmReplay: async () => { warmCalls++; throw new Error('unmeasured Job cannot be replayed'); },
      warmQuarantine: async () => {},
      warmFinalize: async () => {},
    }, GATE_ISOLATED_TIMEOUT_MS, true);
    expect(result.rc).toBe(1);
    expect(result.timedOut).toBeUndefined();
    expect(result.warmReference).toBeNull(); // The fake Job has no JUnit; it cannot certify a warm comparison.
    expect(result.warmShadow).toMatchObject({ status: 'unmeasured', reason: 'reference-unmeasured' });
    expect(warmCalls).toBe(0);
    expect(result.warmAttemptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.output).toContain('(fail)');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ pool: 'pool-test', clone: true, source: { kind: 'commit', sha: CUT }, memoryLimit: expect.any(String), deadlineSeconds: 480 });
    expect(requests[0]!.command[2]).toContain("'--timeout' '60000'");
    expect(requests[0]!.command[2]).toContain('ELANOUS_TEST_FAKE_LLM');
    expect(requests[0]!.command[2]).toContain('left=300');
    expect(requests[0]!.command[2]).toContain('part-$i.timeout');
    expect(requests[0]!.command[2]).toContain('[warm-worker] cut=');
    expect(requests[0]!.command[2]).toContain('[warm-worker] file=');
    const batch = await runner.recheckPodBatch!(['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts'], BASE, { pool: 'pool-test', installSlots: 0 }, GATE_ISOLATED_TIMEOUT_MS);
    expect(batch.get('src/a.test.ts')?.rc).toBe(1);
    expect(batch.get('src/b.test.ts')?.rc).toBe(0);
    expect(batch.get('src/c.test.ts')?.rc).toBe(0);
    expect(requests[1]).toMatchObject({ source: { kind: 'commit', sha: BASE }, deadlineSeconds: 780 });
    expect(requests[1]!.command[2]).toContain('gate-isolate.');
    const shell = requests[1]!.command[2]!;
    expect(shell.indexOf("run_part 0 'bun'")).toBeLessThan(shell.indexOf("run_part 1 'bun'"));
    expect(shell.indexOf('for pid in "${pids[@]}"', shell.indexOf("run_part 1 'bun'"))).toBeLessThan(shell.indexOf("run_part 2 'bun'"));
    const timeout = await runner.recheckPod!('src/d.test.ts', CUT, { pool: 'pool-test', installSlots: 0 }, GATE_ISOLATED_TIMEOUT_MS);
    expect(timeout).toMatchObject({ rc: 124, timedOut: true });
    const rootFile = await runner.recheckPod!('root.test.ts', CUT, { pool: 'pool-test', installSlots: 0 }, GATE_ISOLATED_TIMEOUT_MS);
    expect(rootFile.rc).toBe(1);
    expect(requests.at(-1)!.command[2]).toContain("'./root.test.ts'");
    await expect(runner.recheckPod!('../escape.test.ts', CUT, { pool: 'pool-test' }, GATE_ISOLATED_TIMEOUT_MS)).rejects.toThrow('unsafe pod recheck files');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function warmReferenceRunner(root: string, file: string): GateRunner {
  let requested = 0;
  return createGateRunner(root, undefined, async () => ({ rc: 0, output: '' }), async (request) => {
    const binding = /attempt=%s\\n" '[a-f0-9]+' '([^']+)'/.exec(request.command[2]!);
    expect(binding).not.toBeNull();
    const attemptId = binding![1]!;
    const artifactsDir = join(root, `job-${++requested}`);
    mkdirSync(artifactsDir);
    const junit = `<testsuites tests="1"><testsuite name="${file}" file="${file}" tests="1"><testcase name="works" file="${file}"/></testsuite></testsuites>`;
    const digest = createHash('sha256').update(junit).digest('hex');
    writeFileSync(join(artifactsDir, 'install.rc'), '0\n');
    writeFileSync(join(artifactsDir, 'part-0.rc'), '0\n');
    writeFileSync(join(artifactsDir, 'part-0.junit.xml'), junit);
    writeFileSync(join(artifactsDir, 'part-0.log'), `[warm-worker] file=${file}\n[warm-worker] cut=${CUT} attempt=${attemptId}\nbun test v1.4.2\n${file}:\n(pass) works\n1 pass\n0 fail\nRan 1 test across 1 file.\n[warm-worker] junit-sha256=${digest}\n`);
    return { exitCode: 0, artifactsDir, job: 'fake-warm-reference' };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 1, k3dCluster: 'test' }]));
}

test('GATE-WARM-SHADOW: a source-bound Job stays authoritative and a divergent worker is quarantined', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-warm-shadow-'));
  scratch.push(root);
  const file = 'src/a.test.ts';
  const key = { context: 'pool-test', imageDigest: `sha256:${'a'.repeat(64)}`, lockHash: 'b'.repeat(64), architecture: 'amd64' };
  const quarantined: string[] = [];
  const runner = warmReferenceRunner(root, file);
  const result = await runner.recheckPod!(file, CUT, { pool: 'pool-test', installSlots: 0, warmCutSha: CUT, warmEligible: true,
    warmReplay: async (input) => {
      const command = { ...input, leaseId: 'lease-1', generation: 1, workerId: 'worker-1', key };
      return { command, transport: { status: 'observed', reason: 'complete', reply: { ...command,
        startedAt: Date.now() - 10, finishedAt: Date.now(), files: [{ file, rc: 1,
          failureIds: [`${file} > broken`], errorIds: [], junitComplete: true }] } } };
    },
    warmQuarantine: async (_command, reason) => { quarantined.push(reason); },
    warmFinalize: async () => { throw new Error('mismatch must not finalize'); },
  }, GATE_ISOLATED_TIMEOUT_MS);
  expect(result.rc).toBe(0);
  expect(result.warmReference).toEqual({ file, rc: 0, failureIds: [], errorIds: [], junitComplete: true });
  expect(result.warmShadow).toMatchObject({ status: 'observed', reason: 'result', quarantined: 'yes' });
  expect(quarantined).toEqual(['result']);
});

test('GATE-WARM-SHADOW: a stalled provider cannot hold a completed Job verdict', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-warm-timeout-'));
  scratch.push(root);
  const runner = warmReferenceRunner(root, 'src/a.test.ts');
  const started = Date.now();
  const result = await runner.recheckPod!('src/a.test.ts', CUT, { pool: 'pool-test', installSlots: 0,
    warmCutSha: CUT, warmEligible: true, warmShadowTimeoutMs: 20,
    warmReplay: async () => new Promise(() => {}),
    warmQuarantine: async () => {}, warmFinalize: async () => {},
  }, GATE_ISOLATED_TIMEOUT_MS);
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(result).toMatchObject({ rc: 0, warmShadow: { status: 'unmeasured', quarantined: 'unavailable' } });
  expect(result.warmShadow?.reason).toContain('warm replay timeout');
});

test('GATE-WARM-SHADOW: a late leased reply is fenced after the Job verdict', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-warm-late-replay-'));
  scratch.push(root);
  const file = 'src/a.test.ts';
  const key = { context: 'pool-test', imageDigest: `sha256:${'a'.repeat(64)}`, lockHash: 'b'.repeat(64), architecture: 'amd64' };
  let deliver: ((reply: any) => void) | undefined;
  let requested: any;
  const reasons: string[] = [];
  const result = await warmReferenceRunner(root, file).recheckPod!(file, CUT, { pool: 'pool-test', installSlots: 0,
    warmCutSha: CUT, warmEligible: true, warmShadowTimeoutMs: 20,
    warmReplay: async (input) => { requested = input; return new Promise((resolve) => { deliver = resolve; }); },
    warmQuarantine: async (_command, reason) => { reasons.push(reason); }, warmFinalize: async () => {},
  }, GATE_ISOLATED_TIMEOUT_MS);
  expect(result).toMatchObject({ rc: 0, warmShadow: { status: 'unmeasured', quarantined: 'unavailable' } });
  deliver!({ command: { ...requested, leaseId: 'lease-late', generation: 1, workerId: 'worker-late', key },
    transport: { status: 'observed', reason: 'complete', reply: null } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(reasons).toEqual(['late-replay-after-timeout']);
});

test('GATE-WARM-SHADOW: an ineligible complete Job never requests replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-warm-ineligible-'));
  scratch.push(root);
  let requests = 0;
  const result = await warmReferenceRunner(root, 'src/a.test.ts').recheckPod!('src/a.test.ts', CUT,
    { pool: 'pool-test', installSlots: 0, warmCutSha: CUT, warmEligible: false,
      warmReplay: async () => { requests++; throw new Error('unexpected replay'); },
      warmQuarantine: async () => {}, warmFinalize: async () => {} }, GATE_ISOLATED_TIMEOUT_MS);
  expect(result).toMatchObject({ rc: 0 });
  expect(result.warmReference).toBeNull();
  expect(result.warmShadow).toBeUndefined();
  expect(requests).toBe(0);
});

test('GATE-WARM-SHADOW: an uncertain leased replay is quarantined or records quarantine failure', async () => {
  const file = 'src/a.test.ts';
  const key = { context: 'pool-test', imageDigest: `sha256:${'a'.repeat(64)}`, lockHash: 'b'.repeat(64), architecture: 'amd64' };
  for (const quarantineFails of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), 'gate-warm-uncertain-'));
    scratch.push(root);
    const reasons: string[] = [];
    const result = await warmReferenceRunner(root, file).recheckPod!(file, CUT, { pool: 'pool-test', installSlots: 0, warmCutSha: CUT, warmEligible: true,
      warmReplay: async (input) => ({ command: { ...input, leaseId: 'lease-1', generation: 1, workerId: 'worker-1', key },
        transport: { status: 'fallback', reason: 'exec-failed', reply: null } }),
      warmQuarantine: async (_command, reason) => {
        reasons.push(reason);
        if (quarantineFails) throw new Error('control unavailable');
      },
      warmFinalize: async () => { throw new Error('uncertain replay must not finalize'); },
    }, GATE_ISOLATED_TIMEOUT_MS);
    expect(result.rc).toBe(0);
    expect(result.warmShadow).toMatchObject({ status: 'fallback', reason: 'exec-failed',
      quarantined: quarantineFails ? 'failed' : 'yes' });
    expect(reasons).toEqual(['transport-exec-failed']);
  }
});

test('GATE-WARM-SHADOW: only a matching replay finalizes the fenced worker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-warm-finalize-'));
  scratch.push(root);
  const file = 'src/a.test.ts';
  const key = { context: 'pool-test', imageDigest: `sha256:${'a'.repeat(64)}`, lockHash: 'b'.repeat(64), architecture: 'amd64' };
  const finalized: string[] = [];
  const runner = warmReferenceRunner(root, file);
  const result = await runner.recheckPod!(file, CUT, { pool: 'pool-test', installSlots: 0, warmCutSha: CUT, warmEligible: true,
    warmReplay: async (input) => {
      const command = { ...input, leaseId: 'lease-1', generation: 1, workerId: 'worker-1', key };
      return { command, transport: { status: 'observed', reason: 'complete', reply: { ...command,
        startedAt: Date.now() - 10, finishedAt: Date.now(), files: [{ file, rc: 0,
          failureIds: [], errorIds: [], junitComplete: true }] } } };
    },
    warmQuarantine: async () => { throw new Error('matching replay must not quarantine'); },
    warmFinalize: async (command) => { finalized.push(command.attemptId); },
  }, GATE_ISOLATED_TIMEOUT_MS);
  expect(result).toMatchObject({ rc: 0, warmShadow: { status: 'observed', reason: 'match', finalized: true, quarantined: 'no' } });
  expect(result.warmAttemptId).toBeDefined();
  expect(finalized).toEqual([result.warmAttemptId!]);
});

test('GATE-WARM-SHADOW: failed finalization quarantines and does not change the Job rc', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-warm-finalize-failed-'));
  scratch.push(root);
  const file = 'src/a.test.ts';
  const key = { context: 'pool-test', imageDigest: `sha256:${'a'.repeat(64)}`, lockHash: 'b'.repeat(64), architecture: 'amd64' };
  const reasons: string[] = [];
  const result = await warmReferenceRunner(root, file).recheckPod!(file, CUT, { pool: 'pool-test', installSlots: 0, warmCutSha: CUT, warmEligible: true,
    warmReplay: async (input) => {
      const command = { ...input, leaseId: 'lease-1', generation: 1, workerId: 'worker-1', key };
      return { command, transport: { status: 'observed', reason: 'complete', reply: { ...command,
        startedAt: Date.now() - 10, finishedAt: Date.now(), files: [{ file, rc: 0,
          failureIds: [], errorIds: [], junitComplete: true }] } } };
    },
    warmQuarantine: async (_command, reason) => { reasons.push(reason); },
    warmFinalize: async () => { throw new Error('sanitize unavailable'); },
  }, GATE_ISOLATED_TIMEOUT_MS);
  expect(result).toMatchObject({ rc: 0, warmShadow: { status: 'fallback', reason: 'finalize-failed', finalized: false, quarantined: 'yes' } });
  expect(reasons).toEqual(['finalize-failed']);
});

test('GATE-WARM-SHADOW: provider lease completion cannot switch the compared Job attempt', () => {
  const request = { protocol: 1 as const, runId: 'run-1', attemptId: 'attempt-1', cutSha: CUT,
    deadlineAt: Date.now() + 60_000, files: ['src/a.test.ts'], envProfile: 'gate-v1' };
  const command = { ...request, leaseId: 'lease-1', generation: 1, workerId: 'worker-1',
    key: { context: 'pool-test', imageDigest: `sha256:${'a'.repeat(64)}`, lockHash: 'b'.repeat(64), architecture: 'amd64' } };
  expect(warmCommandMatchesRequest(command, request)).toBe(true);
  expect(warmCommandMatchesRequest({ ...command, cutSha: BASE }, request)).toBe(false);
  expect(warmCommandMatchesRequest({ ...command, attemptId: 'another-attempt' }, request)).toBe(false);
  expect(warmCommandMatchesRequest({ ...command, files: ['src/b.test.ts'] }, request)).toBe(false);
});

test('GATE-RECHECK-FANOUT: a failing batch or baseline waits for already-started siblings before the error verdict', async () => {
  for (const failAt of ['batch', 'baseline'] as const) {
    const ids = Array.from({ length: failAt === 'batch' ? 16 : 2 }, (_, i) => `src/intro-${i}.test.ts > fails`);
    const { instanceRoot, runner } = fake(ids, []);
    let started = 0;
    let finished = 0;
    runner.recheckPodBatch = async (files) => {
      started++;
      if (failAt === 'batch' && started === 1) throw new Error('batch failed');
      await new Promise((resolve) => setTimeout(resolve, 20));
      finished++;
      return new Map(files.map((file) => [file, { rc: 1, output: runOutput([`${file} > fails`]) }]));
    };
    runner.recheckPod = async (_file) => {
      started++;
      if (failAt === 'baseline' && started === 2) throw new Error('baseline failed');
      await new Promise((resolve) => setTimeout(resolve, 20));
      finished++;
      return { rc: 0, output: runOutput([]) };
    };
    const result = await judgeGate({ ...options(instanceRoot), pod: { pool: 'test', isolationConcurrency: 2 } }, runner);
    expect(result).toMatchObject({ outcome: 'error', error: expect.stringContaining(`${failAt} failed`) });
    expect(started).toBe(failAt === 'batch' ? 2 : 3);
    expect(finished).toBe(failAt === 'batch' ? 1 : 2);
  }
});

test('GATE-RECHECK-POD: a timed-out file stays unmeasured and cannot yield an ok verdict', async () => {
  const { instanceRoot, runner } = fake([B], []);
  runner.recheckPod = async () => { throw new Error('single-file fallback should not run'); };
  runner.recheckPodBatch = async (files) => new Map(files.map((file) => [file, { rc: 124, output: '', timedOut: true }]));
  const result = await judgeGate({ ...options(instanceRoot), pod: { pool: 'test' } }, runner);
  expect(result).toMatchObject({ outcome: 'error', unmeasuredRecheckFiles: ['src/b.test.ts'],
    stalledEnv: [{ file: 'src/b.test.ts', reason: 'isolated-timeout', local: 'timeout' }] });
});

test('GATE-RECHECK-HOST: a timed-out host recheck stays unmeasured and cannot yield an ok verdict', async () => {
  const { instanceRoot, runner } = fake([B], []);
  const command = runner.command;
  runner.command = async (cmd, args, cwd, limitMs) =>
    cmd === 'bun' && args[0] === 'run' && cwd.endsWith('/cut')
      ? { rc: 124, output: '', timedOut: true }
      : command(cmd, args, cwd, limitMs);
  const result = await judgeGate(options(instanceRoot), runner);
  expect(result).toMatchObject({ outcome: 'error', unmeasuredRecheckFiles: ['src/b.test.ts'],
    error: expect.stringContaining('isolated recheck timed out: src/b.test.ts'),
    stalledEnv: [{ file: 'src/b.test.ts', reason: 'isolated-timeout', local: 'timeout' }] });
  expect(result.introduced).toEqual([]);
});

// GATE-SHARD-RESUME (0.2.19) — 0.2.18 gate 2 stopped after 33 minutes on a tool error and gate 3 re-ran every finished shard.
test('GATE-SHARD-RESUME: a re-run on the same commit reads finished shards from the log directory instead of starting Pods', async () => {
  const { root, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const logDir = join(root, 'gate-logs', 'cut');
  const files = Array.from({ length: 12 }, (_, i) => `src/${String.fromCharCode(97 + i)}.test.ts`);
  let podCalls = 0;
  const shardLog = (paths: string[]) => `${paths.length} pass\n0 fail\nRan ${paths.length} tests across ${paths.length} files.\n`;
  const events: Array<{ event: string; data: unknown }> = [];
  const spy = spyOn(debug, 'log').mockImplementation((category: string, event: string, data?: unknown) => { if (category === 'release-loop.gate') events.push({ event, data }); });
  try {
    const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
      if (cmd === 'rg') return { rc: 1, output: '' };
      if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
      if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
      return fixtureRunner.command(cmd, args, cwd);
    }, async (o) => {
      podCalls++;
      const paths = files.filter((file) => o.command[2]!.includes(`'./${file}'`));
      const artifactsDir = join(root, `art-${podCalls}`);
      mkdirSync(artifactsDir);
      writeFileSync(join(artifactsDir, 'shard.log'), shardLog(paths));
      writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
      return { exitCode: 0, artifactsDir, job: 'fake' };
    }, new PodPoolScheduler([{ context: 'pool-test', capacity: 3, k3dCluster: 'test' }]));
    const first = await runner.sweep(repo, logDir, { pool: 'pool-test', shards: 3 });
    expect(podCalls).toBe(3);
    const meta0 = readFileSync(join(logDir, 'pod-0.json'), 'utf8');

    // Same commit, same plan: no Pod, same verdict, the measured durations stay as they were.
    events.length = 0;
    const resumed = await runner.sweep(repo, logDir, { pool: 'pool-test', shards: 3 });
    expect(podCalls).toBe(3);
    expect(resumed.output).toBe(first.output);
    expect(readFileSync(join(logDir, 'pod-0.json'), 'utf8')).toBe(meta0);
    expect(events.filter((e) => e.event === 'pod-shard-resumed')).toHaveLength(3);
    expect(events.filter((e) => e.event === 'pod-shard')).toHaveLength(0);

    // A shard recorded for another commit, or a log the current tool cannot read, runs for real — only that shard.
    const meta1 = JSON.parse(readFileSync(join(logDir, 'pod-1.json'), 'utf8'));
    writeFileSync(join(logDir, 'pod-1.json'), JSON.stringify({ ...meta1, commit: BASE }));
    writeFileSync(join(logDir, 'pod-2.log'), 'garbage\n');
    events.length = 0;
    await runner.sweep(repo, logDir, { pool: 'pool-test', shards: 3 });
    expect(podCalls).toBe(5);
    expect(events.filter((e) => e.event === 'pod-shard-resume-miss').map((e) => (e.data as { shard: number }).shard)).toEqual([2]);

    // --fresh-shards: every shard starts a Pod.
    await runner.sweep(repo, logDir, { pool: 'pool-test', shards: 3, freshShards: true });
    expect(podCalls).toBe(8);
    // A change on the Pod side (here the deadline) changes the run key: no old result is reused (TC 09:48 review).
    await runner.sweep(repo, logDir, { pool: 'pool-test', shards: 3, shardTimeoutSeconds: 900 });
    expect(podCalls).toBe(11);
    await runner.sweep(repo, logDir, { pool: 'pool-test', shards: 3, shardTimeoutSeconds: 900 });
    expect(podCalls).toBe(11);
    // Another pool is another place: nothing measured on pool-test is reused there (review r5).
    await runner.sweep(repo, logDir, { pool: 'pool-other', shards: 3, shardTimeoutSeconds: 900 });
    expect(podCalls).toBe(14);
  } finally { spy.mockRestore(); }
});

test('GATE-SHARD-RESUME: previousShardResult accepts only the same commit, run key, ordered files and a test exit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shard-resume-'));
  scratch.push(dir);
  const write = (meta: object, log = 'Ran 1 tests across 1 files.\n') => {
    writeFileSync(join(dir, 'pod-0.json'), JSON.stringify(meta));
    writeFileSync(join(dir, 'pod-0.log'), log);
  };
  const files = ['src/a.test.ts', 'src/b.test.ts'];
  const key = 'k'.repeat(64);
  write({ commit: CUT, files, rc: 1, durationMs: 1234, runKey: key, jobExitCode: 0, jobFailed: false });
  expect(previousShardResult(dir, 'pod-0', CUT, files, key)).toEqual({ output: 'Ran 1 tests across 1 files.\n', rc: 1, durationMs: 1234 });
  expect(previousShardResult(dir, 'pod-0', BASE, files, key)).toBeUndefined();
  expect(previousShardResult(dir, 'pod-0', CUT, files, 'other')).toBeUndefined();
  expect(previousShardResult(dir, 'pod-0', CUT, [...files].reverse(), key)).toBeUndefined();
  expect(previousShardResult(dir, 'pod-0', CUT, files.slice(0, 1), key)).toBeUndefined();
  // A Job that crashed (or a record without its exit) is never reused, whatever rc and log say (review r6).
  for (const job of [{ jobExitCode: 1, jobFailed: false }, { jobExitCode: 0, jobFailed: true }, {}]) {
    write({ commit: CUT, files, rc: 0, runKey: key, ...job });
    expect(previousShardResult(dir, 'pod-0', CUT, files, key)).toBeUndefined();
  }
  // A log written before run keys existed (no runKey) is never reused.
  write({ commit: CUT, files, rc: 0, jobExitCode: 0, jobFailed: false });
  expect(previousShardResult(dir, 'pod-0', CUT, files, key)).toBeUndefined();
  for (const rc of [null, 2, 137]) {
    write({ commit: CUT, files, rc, runKey: key, jobExitCode: 0, jobFailed: false });
    expect(previousShardResult(dir, 'pod-0', CUT, files, key)).toBeUndefined();
  }
  writeFileSync(join(dir, 'pod-0.json'), '{broken');
  expect(previousShardResult(dir, 'pod-0', CUT, files, key)).toBeUndefined();
  write({ commit: CUT, files, rc: 0, runKey: key, jobExitCode: 0, jobFailed: false });
  rmSync(join(dir, 'pod-0.log'));
  expect(previousShardResult(dir, 'pod-0', CUT, files, key)).toBeUndefined();
  expect(previousShardResult(join(dir, 'missing'), 'pod-0', CUT, files, key)).toBeUndefined();
});

test('GATE-SHARD-RESUME: --fresh-shards turns reuse off and keeps the pool', () => {
  const opts = parseOptions(['--commit', CUT, '--version', '1.0.1', '--pod-pool', 'pool-test', '--fresh-shards'], {});
  if (opts === 'help') throw new Error('unexpected help');
  expect(opts.pod?.pool).toBe('pool-test');
  expect(opts.pod?.freshShards).toBe(true);
  const plain = parseOptions(['--commit', CUT, '--version', '1.0.1', '--pod-pool', 'pool-test'], {});
  if (plain === 'help') throw new Error('unexpected help');
  expect(plain.pod?.freshShards).toBeUndefined();
  // Without a Pod pool the flag does not invent a Pod gate (review r5), in either order.
  for (const args of [['--fresh-shards', '--commit', CUT, '--version', '1.0.1'], ['--commit', CUT, '--version', '1.0.1', '--fresh-shards']]) {
    const local = parseOptions(args, {});
    if (local === 'help') throw new Error('unexpected help');
    expect(local.pod).toBeUndefined();
  }
  const before = parseOptions(['--fresh-shards', '--commit', CUT, '--version', '1.0.1', '--pod-pool', 'pool-test'], {});
  if (before === 'help') throw new Error('unexpected help');
  expect(before.pod).toEqual({ pool: 'pool-test', freshShards: true });
});

test('GATE-SHARD-RESUME: a shard the previous attempt split (OOM) goes straight to its finished halves, with no Pod (TC review ②)', async () => {
  const { root, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const logDir = join(root, 'gate-logs', 'cut');
  const files = ['src/a.test.ts', 'src/b.test.ts'];
  let podCalls = 0;
  const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
    return fixtureRunner.command(cmd, args, cwd);
  }, async (o) => {
    podCalls++;
    const paths = files.filter((file) => o.command[2]!.includes(`'./${file}'`));
    const artifactsDir = join(root, `split-${podCalls}`);
    mkdirSync(artifactsDir);
    if (paths.length > 1) return { exitCode: 137, artifactsDir, job: 'oom' };
    writeFileSync(join(artifactsDir, 'shard.log'), `${paths[0]}:\n(pass) ok\n1 pass\n0 fail\nRan 1 tests across 1 files.\n`);
    writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
    return { exitCode: 0, artifactsDir, job: 'fake' };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 3, k3dCluster: 'test' }]));
  const first = await runner.sweep(repo, logDir, { pool: 'pool-test', shards: 1 });
  expect(podCalls).toBe(3);
  const runKey = JSON.parse(readFileSync(join(logDir, 'pod-0.json'), 'utf8')).runKey as string;
  expect(runKey).toMatch(/^[0-9a-f]{64}$/);
  expect(previousShardDescent(logDir, 'pod-0', CUT, files, runKey, undefined, '-0')?.way).toBe('split');
  expect(previousShardDescent(logDir, 'pod-0', CUT, files, runKey, undefined, '-c0')).toBeUndefined();
  expect(previousShardDescent(logDir, 'pod-0', BASE, files, runKey)).toBeUndefined();
  expect(previousShardDescent(logDir, 'pod-0', CUT, files, 'other')).toBeUndefined();
  const resumed = await runner.sweep(repo, logDir, { pool: 'pool-test', shards: 1 });
  expect(podCalls).toBe(3);
  expect(resumed.output).toBe(first.output);
});

test('GATE-SHARD-RESUME: a parent that exited 0 with no output and went down to its retry resumes through the retry, with no Pod (review r1)', async () => {
  const { root, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const logDir = join(root, 'gate-logs', 'cut');
  const files = ['src/a.test.ts'];
  let podCalls = 0;
  const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
    return fixtureRunner.command(cmd, args, cwd);
  }, async () => {
    podCalls++;
    const artifactsDir = join(root, `retry-${podCalls}`);
    mkdirSync(artifactsDir);
    // First Job: rc 0 and an empty log (no output) → the gate retries in a fresh Job, which passes.
    writeFileSync(join(artifactsDir, 'shard.log'), podCalls === 1 ? '' : 'src/a.test.ts:\n(pass) ok\n1 pass\n0 fail\nRan 1 tests across 1 files.\n');
    writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
    return { exitCode: 0, artifactsDir, job: 'fake' };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 1, k3dCluster: 'test' }]));
  const first = await runner.sweep(repo, logDir, { pool: 'pool-test', shards: 1 });
  expect(podCalls).toBe(2);
  expect(JSON.parse(readFileSync(join(logDir, 'pod-0.json'), 'utf8')).rc).toBe(0);
  const resumed = await runner.sweep(repo, logDir, { pool: 'pool-test', shards: 1 });
  expect(podCalls).toBe(2);
  expect(resumed.output).toBe(first.output);
  // A child left by another plan (files not from this shard) is not a way down.
  const runKey = JSON.parse(readFileSync(join(logDir, 'pod-0.json'), 'utf8')).runKey as string;
  writeFileSync(join(logDir, 'pod-0-retry.json'), JSON.stringify({ commit: CUT, files: ['src/other.test.ts'], rc: 0 }));
  expect(previousShardDescent(logDir, 'pod-0', CUT, files, runKey)).toBeUndefined();
});

test('GATE-SHARD-RESUME: a child left by an older attempt is ignored once the parent ran again and finished (review r2)', async () => {
  const { root, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const logDir = join(root, 'gate-logs', 'cut');
  const files = ['src/a.test.ts'];
  let podCalls = 0;
  const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
    return fixtureRunner.command(cmd, args, cwd);
  }, async () => {
    podCalls++;
    const artifactsDir = join(root, `stale-${podCalls}`);
    mkdirSync(artifactsDir);
    // 1: no output → 2: the retry fails a test → (fresh) 3: the parent itself passes.
    const log = podCalls === 1 ? '' : podCalls === 2
      ? 'src/a.test.ts:\n(fail) A [1.00ms]\n0 pass\n1 fail\nRan 1 tests across 1 files.\n'
      : 'src/a.test.ts:\n(pass) A\n1 pass\n0 fail\nRan 1 tests across 1 files.\n';
    writeFileSync(join(artifactsDir, 'shard.log'), log);
    writeFileSync(join(artifactsDir, 'shard.rc'), podCalls === 2 ? '1\n' : '0\n');
    return { exitCode: 0, artifactsDir, job: 'fake' };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 1, k3dCluster: 'test' }]));
  expect((await runner.sweep(repo, logDir, { pool: 'pool-test', shards: 1 })).rc).toBe(1);
  expect(podCalls).toBe(2);
  expect((await runner.sweep(repo, logDir, { pool: 'pool-test', shards: 1, freshShards: true })).rc).toBe(0);
  expect(podCalls).toBe(3);
  expect(existsSync(join(logDir, 'pod-0-retry.json'))).toBe(true);
  // The old retry record is still on disk, but the parent's latest attempt did not write it: resume reads the parent.
  const resumed = await runner.sweep(repo, logDir, { pool: 'pool-test', shards: 1 });
  expect(podCalls).toBe(3);
  expect(resumed.rc).toBe(0);
});

test('GATE-SHARD-RESUME: a big shard that went cap-split and then file isolation resumes all the way down with no Pod (review r3)', async () => {
  const { root, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const logDir = join(root, 'gate-logs', 'cut');
  const files = Array.from({ length: POD_SHARD_FILE_CAP + 2 }, (_, i) => `src/f${String(i).padStart(2, '0')}.test.ts`);
  let podCalls = 0;
  const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
    return fixtureRunner.command(cmd, args, cwd);
  }, async (o) => {
    podCalls++;
    const paths = files.filter((file) => o.command[2]!.includes(`'./${file}'`));
    const artifactsDir = join(root, `iso-${podCalls}`);
    mkdirSync(artifactsDir);
    // Any bundle runs out of memory; each file alone passes.
    if (paths.length > 1) return { exitCode: 137, artifactsDir, job: 'oom' };
    writeFileSync(join(artifactsDir, 'shard.log'), `${paths[0]}:\n(pass) ok\n1 pass\n0 fail\nRan 1 tests across 1 files.\n`);
    writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
    return { exitCode: 0, artifactsDir, job: 'fake' };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 4, k3dCluster: 'test' }]));
  const first = await runner.sweep(repo, logDir, { pool: 'pool-test', shards: 1 });
  // root 1 · cap chunks 2 (each a file-isolated batch) · both batches OOM · per-file fallback 29.
  expect(podCalls).toBe(1 + 2 + files.length);
  expect(existsSync(join(logDir, 'pod-0-c0-file-0.json'))).toBe(true);
  const resumed = await runner.sweep(repo, logDir, { pool: 'pool-test', shards: 1 });
  expect(podCalls).toBe(1 + 2 + files.length);
  expect(resumed.output).toBe(first.output);
  // One isolated child's log is damaged: only that child runs a Pod, and only clean leaves report «resumed» (review r4).
  writeFileSync(join(logDir, 'pod-0-c1-file-1.log'), 'garbage\n');
  const events: Array<{ event: string; data: { branch?: string } }> = [];
  const spy = spyOn(debug, 'log').mockImplementation((category: string, event: string, data?: unknown) => { if (category === 'release-loop.gate') events.push({ event, data: data as { branch?: string } }); });
  try {
    const again = await runner.sweep(repo, logDir, { pool: 'pool-test', shards: 1 });
    expect(podCalls).toBe(1 + 2 + files.length + 1);
    expect(again.output).toBe(first.output);
  } finally { spy.mockRestore(); }
  const resumedBranches = events.filter((e) => e.event === 'pod-shard-resumed').map((e) => e.data.branch);
  expect(resumedBranches).toHaveLength(files.length - 1);
  expect(resumedBranches).not.toContain('-c1-file-1');
  expect(events.filter((e) => e.event === 'pod-shard-resume-miss').map((e) => e.data.branch)).toEqual(['-c1-file-1']);
  expect(events.filter((e) => e.event === 'pod-shard-descend').map((e) => e.data.branch).sort()).toEqual(['', '-c0', '-c1']);
});

test('GATE-SHARD-RESUME: a Job that exited non-zero with rc 0 and a clean log is run again, never reused as a pass (review r6)', async () => {
  const { root, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const logDir = join(root, 'gate-logs', 'cut');
  const files = ['src/a.test.ts'];
  let podCalls = 0;
  const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
    return fixtureRunner.command(cmd, args, cwd);
  }, async () => {
    podCalls++;
    const artifactsDir = join(root, `crash-${podCalls}`);
    mkdirSync(artifactsDir);
    writeFileSync(join(artifactsDir, 'shard.log'), 'src/a.test.ts:\n(pass) ok\n1 pass\n0 fail\nRan 1 tests across 1 files.\n');
    writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
    return { exitCode: 1, artifactsDir, job: 'crashed' };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 1, k3dCluster: 'test' }]));
  await expect(runner.sweep(repo, logDir, { pool: 'pool-test', shards: 1 })).rejects.toThrow();
  const calls = podCalls;
  expect(JSON.parse(readFileSync(join(logDir, 'pod-0.json'), 'utf8'))).toMatchObject({ rc: 0, jobExitCode: 1, jobFailed: false });
  await expect(runner.sweep(repo, logDir, { pool: 'pool-test', shards: 1 })).rejects.toThrow();
  expect(podCalls).toBe(calls * 2);
});

test('GATE-SHARD-FAILURE-CAPTURE: a failed Job records redacted Pod termination and log tail without changing the verdict', async () => {
  const { root, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const logDir = join(root, 'gate-logs', 'cut');
  const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: 'src/a.test.ts' };
    return fixtureRunner.command(cmd, args, cwd);
  }, async (o) => {
    const member = await o.poolScheduler?.tryAcquire();
    if (member) o.poolScheduler?.release(member);
    const artifactsDir = join(root, 'failed-job');
    mkdirSync(artifactsDir, { recursive: true });
    return { exitCode: 137, artifactsDir, job: 'failed-job' };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 1, k3dCluster: 'test' }]));
  const evidence = { termination: { reason: 'OOMKilled', exitCode: 137, finishedAt: '2026-10-20T09:01:00Z' } };
  let logTail = `${'가'.repeat(7_000)}token=abc123def456secret\n`;
  const kubectlCalls: string[][] = [];
  const failureKubectl = (args: readonly string[]) => {
    kubectlCalls.push([...args]);
    return args.includes('get')
      ? { status: 0, stdout: JSON.stringify({ items: [
        { metadata: { name: 'old-running' }, status: { containerStatuses: [{ name: 'child', state: { running: {} }, lastState: { terminated: { reason: 'EarlierCrash', exitCode: 1 } } }] } },
        { metadata: { name: 'earlier-failed' }, status: { containerStatuses: [{ name: 'child', state: { terminated: { reason: 'Error', exitCode: 1, finishedAt: '2026-10-20T09:00:00Z' } } }] } },
        { metadata: { name: 'failed-pod' }, status: { containerStatuses: [{ name: 'child', state: { terminated: evidence.termination } }] } },
      ] }), stderr: '' }
      : { status: 0, stdout: logTail, stderr: '' };
  };
  await expect(runner.sweep(repo, logDir, { pool: 'pool-test', shards: 1, failureKubectl })).rejects.toThrow();
  const row = JSON.parse(readFileSync(join(logDir, 'pod-0.json'), 'utf8'));
  expect(row).toMatchObject({ jobExitCode: 137, jobFailed: false, failureCapture: { podName: 'failed-pod', termination: evidence.termination } });
  expect(row.failureCapture.logTail).toContain('token=***');
  expect(row.failureCapture.logTail).not.toContain('abc123def456secret');
  expect(Buffer.byteLength(row.failureCapture.logTail, 'utf8')).toBeLessThanOrEqual(16_384);
  expect(kubectlCalls).toHaveLength(2);
  expect(kubectlCalls[0]).toContain('pool-test');
  expect(kubectlCalls[1]).toContain('pod/failed-pod');
  // Old slice-before-redaction starts in the middle of this token and leaks its suffix.
  // A later artifact read throws; the catch must keep the evidence already collected once.
  mkdirSync(join(root, 'failed-job', 'shard.log'));
  logTail = `token=abc123def456secret${'x'.repeat(16_375)}`;
  await expect(runner.sweep(repo, join(root, 'gate-logs', 'boundary'), { pool: 'pool-test', shards: 1, failureKubectl })).rejects.toThrow();
  const boundary = JSON.parse(readFileSync(join(root, 'gate-logs', 'boundary', 'pod-0.json'), 'utf8'));
  expect(boundary.jobFailed).toBe(true);
  expect(kubectlCalls).toHaveLength(4);
  expect(boundary.failureCapture.logTail).toContain('token=***');
  expect(boundary.failureCapture.logTail).not.toContain('def456secret');
});

test('GATE-SHARD-FAILURE-CAPTURE: collection errors are recorded without replacing Job failure', async () => {
  const { root, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const logDir = join(root, 'gate-logs', 'cut');
  const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: 'src/a.test.ts' };
    return fixtureRunner.command(cmd, args, cwd);
  }, async () => { throw new Error('Job status unreadable'); },
  new PodPoolScheduler([{ context: 'pool-test', capacity: 1, k3dCluster: 'test' }]));
  await expect(runner.sweep(repo, logDir, { pool: 'pool-test', shards: 1, failureEvidence: () => { throw new Error('kubectl timeout'); } })).rejects.toThrow();
  expect(JSON.parse(readFileSync(join(logDir, 'pod-0.json'), 'utf8'))).toMatchObject({
    jobFailed: true, failureCapture: { error: '수거 실패 · Error: kubectl timeout' },
  });
});

test('GATE-SHARD-RESUME: a fresh run that fails while replacing a shard log leaves no reusable record behind (review r8·r9)', async () => {
  const { root, runner: fixtureRunner } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const logDir = join(root, 'gate-logs', 'cut');
  const files = ['src/a.test.ts'];
  let podCalls = 0;
  const runner = createGateRunner(repo, undefined, async (cmd, args, cwd) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
    return fixtureRunner.command(cmd, args, cwd);
  }, async () => {
    podCalls++;
    const artifactsDir = join(root, `swap-${podCalls}`);
    mkdirSync(artifactsDir);
    writeFileSync(join(artifactsDir, 'shard.log'), 'src/a.test.ts:\n(pass) ok\n1 pass\n0 fail\nRan 1 tests across 1 files.\n');
    writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
    return { exitCode: 0, artifactsDir, job: 'fake' };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 1, k3dCluster: 'test' }]));
  await runner.sweep(repo, logDir, { pool: 'pool-test', shards: 1 });
  expect(existsSync(join(logDir, 'pod-0.json'))).toBe(true);
  // The log cannot be replaced (a directory sits at its name): the run stops between invalidating and rewriting.
  rmSync(join(logDir, 'pod-0.log'));
  mkdirSync(join(logDir, 'pod-0.log'));
  await expect(runner.sweep(repo, logDir, { pool: 'pool-test', shards: 1, freshShards: true })).rejects.toThrow();
  expect(existsSync(join(logDir, 'pod-0.json'))).toBe(false);
  expect(previousShardResult(logDir, 'pod-0', CUT, files, 'any')).toBeUndefined();
});

// ── GATE-MEM-ADMIT (0.2.20): gate shard Jobs ask pool admission like harness goal Pods ────────────────────────────
const admitStatus = (recommended: number) => ({ recommended, accountSlots: 0, limitedBy: 'memory' as const, reason: null,
  capacitySlots: 24, memorySlots: recommended, placeableSlots: recommended, running: 0, pending: 0 });
function admitPool(free: () => number) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-mem-admit-lease-'));
  scratch.push(dir);
  return new PodPoolScheduler(parsePodPool('pool-test:24'), { hostLease: new HostPoolLease('pool-test', { dir }), pollMs: 5, status: () => admitStatus(free()) });
}

test('GATE-MEM-ADMIT: admission granted at once → launch with no wait reason written', async () => {
  const waits: string[] = [];
  const result = await admitGateShard(poolGateAdmission(admitPool(() => 3)), { waitMs: 5_000, onWait: (r) => waits.push(r) });
  expect(result.outcome).toBe('granted');
  expect(waits).toEqual([]);
  result.release();
  result.release();
});

test('GATE-MEM-ADMIT: no room → the wait reason (recommended · limitedBy) is recorded → granted when memory frees', async () => {
  let free = 0;
  const waits: string[] = [];
  const pool = admitPool(() => free);
  const result = await admitGateShard(poolGateAdmission(pool), { waitMs: 10_000, firstReasonMs: 1, reasonPollMs: 5, onWait: (r) => { waits.push(r); free = 1; } });
  expect(result.outcome).toBe('granted');
  expect(waits[0]).toContain('메모리 여유 대기(admission)');
  expect(waits[0]).toContain('recommended=0 limitedBy=memory');
  expect(result.reason).toBe(waits.at(-1));
  result.release();
});

test('GATE-MEM-ADMIT: bounded wait → proceeds with admission-timeout and leaves no queued waiter (no deadlock)', async () => {
  const pool = admitPool(() => 0);
  const started = Date.now();
  const result = await admitGateShard(poolGateAdmission(pool), { waitMs: 60, firstReasonMs: 1, reasonPollMs: 5, onWait: () => {} });
  expect(result.outcome).toBe('admission-timeout');
  expect(result.reason).toContain('limitedBy=memory');
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(pool.admissionSnapshot().queued).toBe(0);
  expect(pool.admissionSnapshot({ gate: true }).queued).toBe(0);
  expect(() => result.release()).not.toThrow();
});

test('GATE-ADMIT-EXEMPT: the gate shard admission asks the pool as a gate caller (exempt from its own GATE-RESERVE CPU bound)', async () => {
  const pool = admitPool(() => 1);
  const result = await admitGateShard(poolGateAdmission(pool), { waitMs: 5_000, onWait: () => {} });
  expect(result.outcome).toBe('granted');
  expect(pool.admissionSnapshot({ gate: true }).active).toBe(1);
  expect(pool.admissionSnapshot().active).toBe(0);
  result.release();
  expect(pool.admissionSnapshot({ gate: true }).active).toBe(0);
});

test('GATE-MEM-ADMIT: an admission error launches at once; no admission or 0 s is off', async () => {
  const broken: GateAdmission = { acquire: async () => { throw new Error('lease dir unreadable'); }, waitReason: () => null };
  expect(await admitGateShard(broken, { waitMs: 5_000, onWait: () => {} })).toMatchObject({ outcome: 'admission-error', reason: 'lease dir unreadable' });
  expect((await admitGateShard(undefined, { waitMs: 5_000, onWait: () => {} })).outcome).toBe('off');
  expect((await admitGateShard(broken, { waitMs: 0, onWait: () => {} })).outcome).toBe('off');
  expect(GATE_ADMISSION_WAIT_SECONDS_DEFAULT).toBe(300);
});

test('GATE-MEM-ADMIT: sweep — the shard waits with a visible reason, then launches; timeout and grant are journaled; config reaches it', async () => {
  const { root } = fake([], []);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const shardsPath = join(root, 'shards.json');
  const command: GateRunner['command'] = async (cmd, args) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: 'src/a.test.ts\n' };
    return { rc: 0, output: '' };
  };
  const seenWaits: Array<string | undefined> = [];
  let launched = 0;
  const pod = async () => {
    launched++;
    const artifactsDir = join(root, `admit-shard-${launched}`);
    mkdirSync(artifactsDir);
    writeFileSync(join(artifactsDir, 'shard.log'), '1 pass\n0 fail\nRan 1 test across 1 file.\n');
    writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
    return { exitCode: 0, artifactsDir, job: 'fake' };
  };
  const observed: Array<{ event: string; data: unknown; level?: string }> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data, opts) => {
    if (category === 'release-loop.gate' && (event === 'shard-admission' || event === 'pod-admission')) observed.push({ event, data, ...(opts?.level ? { level: opts.level } : {}) });
  });
  try {
    // ① never any room: the row says why while it waits, and after the bound the shard launches with admission-timeout.
    let aborted = false;
    const never: GateAdmission = {
      acquire: (signal) => new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('pod lease admission aborted')); })),
      waitReason: () => 'recommended=0 limitedBy=memory memorySlots=0',
    };
    const watch = setInterval(() => { seenWaits.push(readGateShards(shardsPath)?.shards[0]?.waitReason); }, 100);
    const runner = createGateRunner(repo, undefined, command, pod, new PodPoolScheduler([{ context: 'pool-test', capacity: 1, k3dCluster: 'test' }]));
    const logs = join(root, 'logs-timeout');
    const swept = await runner.sweep(repo, logs, { pool: 'pool-test', shards: 1, admissionWaitSeconds: 2, admission: never, shardsFile: { path: shardsPath, version: '1.0.1' } });
    clearInterval(watch);
    expect(swept.rc).toBe(0);
    expect(aborted).toBe(true);
    expect(launched).toBe(1);
    expect(seenWaits).toContain('메모리 여유 대기(admission) · recommended=0 limitedBy=memory memorySlots=0');
    expect(readGateShards(shardsPath)?.shards[0]).toMatchObject({ id: 'pod-0', state: 'done' });
    expect(readGateShards(shardsPath)?.shards[0]?.waitReason).toBeUndefined();
    const shardJson = JSON.parse(readFileSync(join(logs, 'pod-0.json'), 'utf8')) as { admission: string; admissionWaitMs: number; durationMs: number };
    expect(shardJson.admission).toBe('admission-timeout');
    expect(shardJson.admissionWaitMs).toBeGreaterThanOrEqual(1_900);
    // The admission wait is not the shard's run time (the next release plans by durationMs).
    expect(shardJson.durationMs).toBeLessThan(1_500);
    expect(observed).toContainEqual({ event: 'shard-admission', data: expect.objectContaining({ shard: 0, outcome: 'admission-timeout' }), level: 'warn' });
    expect(observed).toContainEqual({ event: 'pod-admission', data: { waitSeconds: 2, source: 'config', enabled: true } });
    // ② room: granted, and the admission goes back once the member is chosen (not held through the Job) — exactly once,
    // though the gate releases it at placement and again after the Job. The fake Pod places itself through the pool it is given.
    let releases = 0;
    const room: GateAdmission = { acquire: async () => () => { releases++; }, waitReason: () => null };
    let releasesAtPlacement = -1;
    const placingPod = async (o: RunPodCommandOptions) => {
      const member = await o.poolScheduler!.tryAcquire(undefined, undefined, { selfCapped: true });
      expect(member?.context).toBe('pool-test');
      releasesAtPlacement = releases;
      const done = await pod();
      o.poolScheduler!.release(member!);
      return done;
    };
    const granted = createGateRunner(repo, undefined, command, placingPod, new PodPoolScheduler([{ context: 'pool-test', capacity: 1, k3dCluster: 'test' }]));
    const logs2 = join(root, 'logs-granted');
    expect((await granted.sweep(repo, logs2, { pool: 'pool-test', shards: 1, admission: room })).rc).toBe(0);
    expect(releasesAtPlacement).toBe(1);
    expect(releases).toBe(1);
    expect(JSON.parse(readFileSync(join(logs2, 'pod-0.json'), 'utf8'))).toMatchObject({ admission: 'granted' });
    // ③ an injected pool without an injected admission (every existing gate test) stays admission-free.
    const plain = createGateRunner(repo, undefined, command, pod, new PodPoolScheduler([{ context: 'pool-test', capacity: 1, k3dCluster: 'test' }]));
    const logs3 = join(root, 'logs-plain');
    expect((await plain.sweep(repo, logs3, { pool: 'pool-test', shards: 1 })).rc).toBe(0);
    expect(JSON.parse(readFileSync(join(logs3, 'pod-0.json'), 'utf8')).admission).toBeUndefined();
  } finally { log.mockRestore(); }
  // release.loop.gatePodAdmissionWaitSeconds → graph input → shard admission bound.
  const context = join(root, 'admit-context.json');
  writeFileSync(context, JSON.stringify({ input: { commit: CUT, version: '1.0.1', previousVersion: '1.0.0', gatePodPool: 'p', gatePodAdmissionWaitSeconds: 45 }, outputs: {} }));
  expect(parseOptions(['--json'], { ELANOUS_GRAPH_CONTEXT: context })).toMatchObject({ pod: { pool: 'p', admissionWaitSeconds: 45 } });
});

// GATE-MULTI-HOST (0.2.25 · 대표) — the gate pool is a host roster: shards spread over its members, each shard's member is
// recorded (shard json · pod-shard log · shards.json), and an unreachable member hands its shards to the others.
function multiHostRig(members: Array<{ context: string; sshHost: string; capacity: number }>, fileCount: number, failOn: (context: string) => boolean) {
  const root = mkdtempSync(join(tmpdir(), 'gate-multi-host-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const files = Array.from({ length: fileCount }, (_, i) => `src/m-${String(i).padStart(2, '0')}.test.ts`);
  const placements: Array<{ context: string; files: string[]; ok: boolean }> = [];
  const active = new Map<string, number>();
  const peak = new Map<string, number>();
  const command: GateRunner['command'] = async (cmd, args) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: 'c'.repeat(40) };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
    return { rc: 0, output: '' };
  };
  // Stands in for runPodCommand: places through the gate's scheduler, then fails on a lost member (image sync / apply
  // over a dead ssh/kubectl) or runs every part cleanly.
  const pod = async (o: RunPodCommandOptions) => {
    const pool = o.poolScheduler!;
    let member = await pool.tryAcquire(undefined, undefined, { selfCapped: true });
    while (!member) { await Bun.sleep(5); member = await pool.tryAcquire(undefined, undefined, { selfCapped: true }); }
    const parts = [...o.command[2]!.matchAll(/run_part \d+ ([^&]*)/g)].map((m) => [...m[1]!.matchAll(/'\.\/([^']+)'/g)].map((f) => f[1]!));
    try {
      active.set(member.context, (active.get(member.context) ?? 0) + 1);
      peak.set(member.context, Math.max(peak.get(member.context) ?? 0, active.get(member.context)!));
      await Bun.sleep(20);
      const ok = !failOn(member.context);
      placements.push({ context: member.context, files: parts.flat(), ok });
      if (!ok) throw new Error(`pod command: 이미지 판을 못 맞췄다: ssh: connect to host ${member.sshHost}: Operation timed out`);
      const dir = join(root, o.name!);
      mkdirSync(dir);
      writeFileSync(join(dir, 'install.rc'), '0\n');
      parts.forEach((part, index) => {
        writeFileSync(join(dir, `part-${index}.log`), `${part.map((file) => `${file}:\n(pass) case [1.00ms]`).join('\n')}\n${part.length} pass\n0 fail\nRan ${part.length} tests across ${part.length} files.\n`);
        writeFileSync(join(dir, `part-${index}.rc`), '0\n');
      });
      return { exitCode: 0, artifactsDir: dir, job: o.name! };
    } finally {
      active.set(member.context, active.get(member.context)! - 1);
      pool.release(member);
    }
  };
  const scheduler = new PodPoolScheduler(members.map((m) => ({ ...m, k3dCluster: 'elanous-pool' })));
  const runner = createGateRunner(repo, undefined, command, pod, scheduler, () => '');
  return { root, repo, files, runner, placements, peak };
}

function gateEvents() {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const spy = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'release-loop.gate') events.push({ event, data: data as Record<string, unknown> });
  });
  return { events, restore: () => spy.mockRestore() };
}

const ROSTER = [
  { context: 'pool-node-b', sshHost: 'node-b', capacity: 4 },
  { context: 'pool-node-c', sshHost: 'node-c', capacity: 2 },
  { context: 'pool-wsl', sshHost: 'host-e-wsl', capacity: 2 },
];

test('GATE-MULTI-HOST: shards are split across the roster hosts (no member over its cap) and each shard records its host', async () => {
  const { root, repo, files, runner, placements, peak } = multiHostRig(ROSTER, 16, () => false);
  const { events, restore } = gateEvents();
  const shardsFile = join(root, 'shards.json');
  let result: Awaited<ReturnType<GateRunner['sweep']>>;
  try { result = await runner.sweep(repo, join(root, 'logs'), { pool: 'roster', shards: 8, stallSeconds: 0, probeMember: () => true, shardsFile: { path: shardsFile, version: '0.2.25' } }); }
  finally { restore(); rmSync(root, { recursive: true, force: true, maxRetries: 0 }); }
  expect(result!.rc).toBe(0);
  expect(result!.output).toContain(`Ran ${files.length} tests across ${files.length} files.`);
  // Free-share placement fills every member in proportion to its cap — not 8 shards on one host.
  const used = new Set(placements.map((p) => p.context));
  expect(used.size).toBeGreaterThanOrEqual(2);
  for (const m of ROSTER) expect(peak.get(m.context) ?? 0).toBeLessThanOrEqual(m.capacity);
  const shardLogs = events.filter((e) => e.event === 'pod-shard');
  expect(shardLogs).toHaveLength(8);
  expect(shardLogs.every((e) => ROSTER.some((m) => m.context === e.data.host))).toBe(true);
  expect(new Set(shardLogs.map((e) => e.data.host)).size).toBe(used.size);
  expect(events.find((e) => e.event === 'pod-roster')?.data).toMatchObject({ multiHost: true, probe: true, members: ROSTER.map((m) => ({ context: m.context, host: m.sshHost, capacity: m.capacity })) });
  expect(events.some((e) => e.event === 'pod-member-down' || e.event === 'pod-shard-host-retry')).toBe(false);
}, 30_000);

test('GATE-MULTI-HOST: when one host is unreachable the rest take its shards — the gate passes, the lost host is skipped from then on', async () => {
  const { root, repo, files, runner, placements } = multiHostRig(ROSTER, 16, (context) => context === 'pool-node-c');
  const { events, restore } = gateEvents();
  const probed: string[] = [];
  const shardsFile = join(root, 'shards.json');
  let result: Awaited<ReturnType<GateRunner['sweep']>>;
  let board: ReturnType<typeof readGateShards> = null;
  let shardJson: Array<Record<string, unknown>> = [];
  try {
    result = await runner.sweep(repo, join(root, 'logs'), { pool: 'roster', shards: 8, stallSeconds: 0, shardsFile: { path: shardsFile, version: '0.2.25' },
      probeMember: (m) => { probed.push(m.context); return m.context !== 'pool-node-c'; } });
    board = readGateShards(shardsFile);
    shardJson = Array.from({ length: 8 }, (_, i) => JSON.parse(readFileSync(join(root, 'logs', `pod-${i}.json`), 'utf8')) as Record<string, unknown>);
  } finally { restore(); rmSync(root, { recursive: true, force: true, maxRetries: 0 }); }
  // Every file measured exactly once on a live host — no split, no stalled shard, no gate failure.
  expect(result!.rc).toBe(0);
  expect(result!.output).toContain(`Ran ${files.length} tests across ${files.length} files.`);
  expect(placements.filter((p) => p.ok).flatMap((p) => p.files).sort()).toEqual(files);
  expect(placements.filter((p) => p.ok).every((p) => p.context !== 'pool-node-c')).toBe(true);
  const lost = placements.filter((p) => !p.ok);
  expect(lost.length).toBeGreaterThanOrEqual(1);
  expect(lost.every((p) => p.context === 'pool-node-c')).toBe(true);
  // Probed once: after that node-c is skipped for placement (only shards already placed there fail over).
  expect(probed).toEqual(['pool-node-c']);
  expect(events.filter((e) => e.event === 'pod-member-down').map((e) => e.data)).toEqual([
    { member: 'pool-node-c', host: 'node-c', shard: expect.any(Number), error: expect.stringContaining('ssh: connect to host node-c'), remaining: ['pool-node-b', 'pool-wsl'] },
  ]);
  // Only the shards already placed on node-c (≤ its cap) fail; each fails over once — node-c is never chosen again.
  expect(lost.length).toBeLessThanOrEqual(2);
  expect(events.filter((e) => e.event === 'pod-shard-host-retry').map((e) => e.data.attempt)).toEqual(lost.map(() => 1));
  expect(events.some((e) => /^pod-shard-(?:cap-)?split$|^pod-shard-isolate$/.test(e.event))).toBe(false);
  // Evidence: the root shard json and the board carry the host; a shard that failed over ends on a live host.
  expect(shardJson.every((j) => typeof j.host === 'string')).toBe(true);
  expect(board?.shards.map((row) => row.state)).toEqual(Array(8).fill('done'));
  expect(board?.shards.every((row) => row.host === 'pool-node-b' || row.host === 'pool-wsl')).toBe(true);
}, 30_000);

test('GATE-MULTI-HOST: a one-member pool keeps the old path — a failed launch is never probed or host-retried', async () => {
  let calls = 0;
  const { root, repo, runner } = multiHostRig([{ context: 'pool-node-b', sshHost: 'node-b', capacity: 4 }], 2, () => ++calls === 1);
  const { events, restore } = gateEvents();
  const probed: string[] = [];
  let error: unknown;
  try { await runner.sweep(repo, join(root, 'logs'), { pool: 'pool-node-b', shards: 1, stallSeconds: 0, probeMember: (m) => { probed.push(m.context); return false; } }); }
  catch (caught) { error = caught; }
  finally { restore(); rmSync(root, { recursive: true, force: true, maxRetries: 0 }); }
  expect(error).toBeUndefined();
  expect(probed).toEqual([]);
  expect(events.some((e) => e.event === 'pod-member-down' || e.event === 'pod-shard-host-retry')).toBe(false);
  // The old job-failed path: the 2-file root shard splits in halves.
  expect(events.some((e) => e.event === 'pod-shard-split')).toBe(true);
}, 30_000);
