// GATE-HOST-EXECUTOR (0.2.24): the release gate's second executor — an SSH host clone instead of Pods.
// Not a waiver: the same gate node runs and records a normal verdict; only where its sweep runs changes.
import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph, type GraphRunState } from '../../src/graph-runner/runner.js';
import { createGateRunner, gateExecutorOf, parseOptions, requestedGateExecutor } from './gate-node.js';
import { resumeReleaseRun } from './resume-release.js';
import { releaseResumeGateExecutor, releaseResumeWaiver } from './resume.js';
import { buildReleaseRunInput } from './unattended-release.js';

const CUT = 'c'.repeat(40);
const SHA = 'a'.repeat(40);
const VERSION = '0.2.19';

function withContext(input: Record<string, unknown>, body: (env: NodeJS.ProcessEnv) => void) {
  const root = mkdtempSync(join(tmpdir(), 'gate-host-executor-'));
  try {
    const path = join(root, 'context.json');
    writeFileSync(path, JSON.stringify({ input: { commit: CUT, version: '1.0.1', previousVersion: '1.0.0', ...input }, outputs: {} }));
    body({ ELANOUS_GRAPH_CONTEXT: path });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('(a) gateExecutor host ignores gatePodPool and every pod option; the sweep runs on gateRemote', () => {
  withContext({ gateExecutor: 'host', gateRemote: 'node-b', gatePodPool: 'x', gatePodShards: 8, gatePodCpu: 'bad' }, (env) => {
    const opts = parseOptions(['--json'], env);
    if (opts === 'help') throw new Error('unexpected help');
    expect(opts.pod).toBeUndefined();
    expect(opts.remote).toBe('node-b');
    expect(opts.executor).toBe('host');
    expect(gateExecutorOf(opts)).toEqual({ executor: 'host', host: 'node-b' });
  });
  // Direct invocation: --executor host drops --pod-pool too.
  const direct = parseOptions(['--commit', CUT, '--version', '1.0.1', '--pod-pool', 'p', '--remote', 'node-b', '--executor', 'host'], {});
  if (direct === 'help') throw new Error('unexpected help');
  expect(direct.pod).toBeUndefined();
  expect(direct.remote).toBe('node-b');
});

test('host executor drives the remote (non-pod) sweep: commands go to the remote runner, no Pod is ever launched', async () => {
  let opts: ReturnType<typeof parseOptions> = 'help';
  withContext({ gateExecutor: 'host', gateRemote: 'node-b', gatePodPool: 'x' }, (env) => { opts = parseOptions(['--json'], env); });
  if (opts === 'help') throw new Error('unexpected help');
  const options = opts as Exclude<ReturnType<typeof parseOptions>, 'help'>;
  const calls: string[] = [];
  let podLaunches = 0;
  const runner = createGateRunner('/repo', options.remote, async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'git') return { rc: 0, output: 'src/cli/a.test.ts\n' };
    if (cmd === 'rg') return { rc: 1, output: '' };
    return { rc: 0, output: '1 pass\n0 fail\nRan 1 tests across 1 files.\n' };
  }, async () => { podLaunches++; throw new Error('pod launched'); });
  const swept = await runner.sweep('/remote/tree', undefined, options.pod);
  expect(swept.rc).toBe(0);
  expect(podLaunches).toBe(0);
  // `rg` CDP discovery runs only on the remote branch of the non-pod sweep.
  expect(calls).toContain('rg -l --glob *.test.ts -e requireCdpBase -e 9333 test scripts');
  expect(calls.some((call) => call.startsWith('bun run test:deterministic'))).toBe(true);
});

test('explicit pod without a pool is refused; a pod verdict names no SSH host even when gateRemote is set', () => {
  withContext({ gateExecutor: 'pod' }, (env) => {
    expect(() => parseOptions(['--json'], env)).toThrow('gateExecutor pod requires gatePodPool');
  });
  withContext({ gatePodPool: 'x', gateRemote: 'node-b' }, (env) => {
    const opts = parseOptions(['--json'], env);
    if (opts === 'help') throw new Error('unexpected help');
    expect(gateExecutorOf(opts)).toEqual({ executor: 'pod', host: null });
  });
  // A refused option set still says which executor was asked for (the failed node output carries it).
  withContext({ gateExecutor: 'host', gatePodPool: 'x' }, (env) => {
    expect(requestedGateExecutor(['--json'], env)).toEqual({ executor: 'host', host: null });
  });
  withContext({ gateExecutor: 'pod', gateRemote: 'node-b' }, (env) => {
    expect(requestedGateExecutor(['--json'], env)).toEqual({ executor: 'pod', host: null });
  });
  expect(requestedGateExecutor(['--executor', 'host', '--remote', 'node-b'], {})).toEqual({ executor: 'host', host: 'node-b' });
});

test('(b) default input with gatePodPool is a pod gate exactly as before (no executor key added)', () => {
  withContext({ gatePodPool: 'x' }, (env) => {
    const opts = parseOptions(['--json'], env);
    if (opts === 'help') throw new Error('unexpected help');
    expect(opts.pod).toEqual({ pool: 'x' });
    expect(opts.remote).toBeUndefined();
    expect('executor' in opts).toBe(false);
    expect(gateExecutorOf(opts)).toEqual({ executor: 'pod', host: null });
  });
  withContext({ gateExecutor: 'pod', gatePodPool: 'x' }, (env) => {
    const opts = parseOptions(['--json'], env);
    if (opts === 'help') throw new Error('unexpected help');
    expect(opts.pod).toEqual({ pool: 'x' });
    expect(gateExecutorOf(opts).executor).toBe('pod');
  });
});

test('(c) host executor without gateRemote fails clearly; an unknown executor is refused', () => {
  withContext({ gateExecutor: 'host', gatePodPool: 'x' }, (env) => {
    expect(() => parseOptions(['--json'], env)).toThrow('gateExecutor host requires gateRemote');
  });
  withContext({ gateExecutor: 'k8s', gatePodPool: 'x' }, (env) => {
    expect(() => parseOptions(['--json'], env)).toThrow('gateExecutor must be pod or host');
  });
  expect(() => parseOptions(['--commit', CUT, '--version', '1.0.1', '--executor', 'host'], {})).toThrow('gateExecutor host requires gateRemote');
});

test('release run input: pod stays fail-closed on a missing pool; an explicit host executor does not need one', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-host-run-input-'));
  try {
    mkdirSync(join(root, 'release', '0.10.0'), { recursive: true });
    writeFileSync(join(root, 'release', '0.10.0', 'release.json'), JSON.stringify({ version: '0.10.0', publishedAt: 'now' }));
    expect(() => buildReleaseRunInput('0.11.0', { ledgerRoot: root, config: {} })).toThrow('release.loop.gatePodPool is required');
    expect(() => buildReleaseRunInput('0.11.0', { ledgerRoot: root, config: {} }, undefined, { executor: 'pod' })).toThrow('release.loop.gatePodPool is required');
    // Default (no choice) stays byte-identical: no gateExecutor key.
    expect(buildReleaseRunInput('0.11.0', { ledgerRoot: root, config: { gatePodPool: 'pool' } })).toEqual({ version: '0.11.0', previousVersion: '0.10.0', gatePodPool: 'pool' });
    expect(buildReleaseRunInput('0.11.0', { ledgerRoot: root, config: {} }, undefined, { executor: 'host', host: 'node-b' }))
      .toEqual({ version: '0.11.0', previousVersion: '0.10.0', gateExecutor: 'host', gateRemote: 'node-b' });
    // --gate-host overrides release.loop.gateRemote; without it the configured host is used.
    expect(buildReleaseRunInput('0.11.0', { ledgerRoot: root, config: { gatePodPool: 'pool', gateRemote: 'old' } }, undefined, { executor: 'host', host: 'node-b' }))
      .toMatchObject({ gateExecutor: 'host', gateRemote: 'node-b', gatePodPool: 'pool' });
    expect(buildReleaseRunInput('0.11.0', { ledgerRoot: root, config: { gateRemote: 'node-b' } }, undefined, { executor: 'host' })).toMatchObject({ gateExecutor: 'host', gateRemote: 'node-b' });
    expect(() => buildReleaseRunInput('0.11.0', { ledgerRoot: root, config: {} }, undefined, { executor: 'host' })).toThrow('requires a gate host');
    expect(() => buildReleaseRunInput('0.11.0', { ledgerRoot: root, config: { gatePodPool: 'pool' } }, undefined, { host: 'node-b' })).toThrow('--gate-host requires --gate-executor host');
    expect(() => buildReleaseRunInput('0.11.0', { ledgerRoot: root, config: { gatePodPool: 'pool' } }, undefined, { executor: 'pod', host: 'node-b' })).toThrow('only to --gate-executor host');
    expect(() => buildReleaseRunInput('0.11.0', { ledgerRoot: root, config: {} }, undefined, { executor: 'host', host: 'node-b; rm -rf /' })).toThrow('invalid gate host');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('(d) resume --gate-executor host --gate-host node-b re-runs gate on the host executor and records the override; the gate stays unwaivable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-host-resume-'));
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const gateContexts: string[] = [];
  const runBash = async (_body: string, opts: { env?: NodeJS.ProcessEnv }) => {
    const raw = readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8');
    const ctx = JSON.parse(raw) as { nodeId: string };
    if (ctx.nodeId === 'version-release') return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', version: VERSION, commit: SHA, branch: `release/${VERSION}` }) + '\n', stderr: '' };
    // Pod infrastructure stalls: the gate cannot measure.
    if (ctx.nodeId === 'gate') { gateContexts.push(raw); return { exitCode: 2, stdout: '{"outcome":"error","verdict":"fail","summary":"pod sweep incomplete"}\n', stderr: '' }; }
    return { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass"}\n', stderr: '' };
  };
  const git = (args: string[]) => args[0] === 'ls-remote' ? `${SHA}\trefs/heads/release/${VERSION}` : args[0] === 'rev-parse' ? SHA : '';
  try {
    const first = await runGraph(graphPath, { input: { version: VERSION, branchCut: true, previousVersion: '0.2.18', gatePodPool: 'x' }, deps: { root, runBash } });
    expect(first.status).toBe('failed');
    expect(first.path.slice(-2)).toEqual(['gate', 'failed']);
    const deps = { root, graphPath, git, runBash };
    // The safety policy is unchanged: gate is never waived.
    expect(() => releaseResumeWaiver(first, { from: 'gate', waive: 'gate', reason: 'Pod infrastructure stalled' })).toThrow('cannot waive a safety');
    await expect(resumeReleaseRun({ runId: first.runId, from: 'gate', gateHost: 'node-b' }, deps)).rejects.toThrow('--gate-host requires --gate-executor host');
    await expect(resumeReleaseRun({ runId: first.runId, from: 'gate', gateExecutor: 'k8s' }, deps)).rejects.toThrow('gate executor must be pod or host');
    // No --gate-host and no saved gateRemote: refused before anything is written.
    const stateFile = join(root, 'graph-runs', 'release-loop', `${first.runId}.json`);
    const before = readFileSync(stateFile, 'utf8');
    await expect(resumeReleaseRun({ runId: first.runId, from: 'gate', gateExecutor: 'host' }, deps)).rejects.toThrow('requires a gate host');
    expect(readFileSync(stateFile, 'utf8')).toBe(before);

    const resumed = await resumeReleaseRun({ runId: first.runId, from: 'gate', gateExecutor: 'host', gateHost: 'node-b' }, deps);
    expect(gateContexts).toHaveLength(2);
    const resumedContext = JSON.parse(gateContexts[1]!) as { input: Record<string, unknown> };
    expect(resumedContext.input).toMatchObject({ gateExecutor: 'host', gateRemote: 'node-b', gatePodPool: 'x' });
    // The resumed gate node, reading that exact context file, runs the non-pod sweep on node-b.
    const contextFile = join(root, 'resumed-gate-context.json');
    writeFileSync(contextFile, gateContexts[1]!);
    const opts = parseOptions(['--json'], { ELANOUS_GRAPH_CONTEXT: contextFile });
    if (opts === 'help') throw new Error('unexpected help');
    expect(opts.pod).toBeUndefined();
    expect(gateExecutorOf(opts)).toEqual({ executor: 'host', host: 'node-b' });
    // The real gate-node.ts entry on that context: it reaches for node-b over ssh (a stub that refuses), never kubectl,
    // and its node output names the executor. No real host is contacted.
    const bin = join(root, 'bin');
    const trail = join(root, 'trail');
    mkdirSync(bin);
    writeFileSync(join(bin, 'ssh'), `#!/bin/sh\necho "ssh $1" >> '${trail}'\necho 'stub: no ssh in tests' >&2\nexit 255\n`);
    writeFileSync(join(bin, 'kubectl'), `#!/bin/sh\necho "kubectl $*" >> '${trail}'\nexit 1\n`);
    chmodSync(join(bin, 'ssh'), 0o755);
    chmodSync(join(bin, 'kubectl'), 0o755);
    const node = spawnSync('bun', [join(import.meta.dir, 'gate-node.ts'), '--json'], {
      cwd: join(import.meta.dir, '../..'), encoding: 'utf8', timeout: 90_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ELANOUS_GRAPH_CONTEXT: contextFile, ELANOUS_STATE_DIR: join(root, 'state') },
    });
    const emitted = node.stdout.trim().split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line) as Record<string, unknown>).at(-1);
    expect(emitted).toMatchObject({ executor: 'host', host: 'node-b', outcome: 'error' });
    const trailLines = readFileSync(trail, 'utf8').trim().split('\n');
    expect(trailLines).toContain('ssh node-b');
    expect(trailLines.some((line) => line.startsWith('kubectl'))).toBe(false);
    // The override is recorded on the run ledger: what was set and what it replaced.
    const saved = JSON.parse(readFileSync(stateFile, 'utf8')) as GraphRunState;
    expect(saved.inputOverrides).toHaveLength(1);
    expect(saved.inputOverrides![0]).toMatchObject({ kind: 'gate-executor', from: 'gate', set: { gateExecutor: 'host', gateRemote: 'node-b' }, previous: { gateExecutor: null, gateRemote: null } });
    expect(saved.input).toMatchObject({ gateExecutor: 'host', gateRemote: 'node-b' });
    expect(resumed.state.inputOverrides).toEqual(saved.inputOverrides);
    // The gate record is a normal executed verdict, never a waiver.
    const gateRecord = saved.nodes.find((node) => node.nodeId === 'gate')!;
    expect(gateRecord.executed).toBe(true);
    expect(gateRecord.waiver).toBeUndefined();

    // Back to pod: the host the override added is dropped again, and the second switch is recorded too.
    await resumeReleaseRun({ runId: first.runId, from: 'gate', gateExecutor: 'pod' }, deps);
    const back = JSON.parse(gateContexts[2]!) as { input: Record<string, unknown> };
    expect(back.input.gateExecutor).toBe('pod');
    expect('gateRemote' in back.input).toBe(false);
    const after = JSON.parse(readFileSync(stateFile, 'utf8')) as GraphRunState;
    expect(after.inputOverrides!.map((item) => item.set.gateExecutor)).toEqual(['host', 'pod']);
    expect(after.inputOverrides![1]).toMatchObject({ unset: ['gateRemote'], previous: { gateExecutor: 'host', gateRemote: 'node-b' } });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);

test('a gate executor switch needs a resume that re-runs gate', () => {
  const state = { graphId: 'release-loop', runId: 'r', status: 'failed', path: ['cutoff', 'gate', 'mac-smoke', 'failed'], nodes: [],
    input: { version: VERSION, previousVersion: '0.2.18', gatePodPool: 'x' }, executed: 0, dryRun: false, statePath: '' } as unknown as GraphRunState;
  expect(() => releaseResumeGateExecutor(state, { from: 'mac-smoke', executor: 'host', host: 'node-b' })).toThrow('re-runs gate');
  expect(releaseResumeGateExecutor(state, { from: 'gate', executor: 'host', host: 'node-b' }).set).toEqual({ gateExecutor: 'host', gateRemote: 'node-b' });
  expect(releaseResumeGateExecutor(state, { from: 'cutoff', executor: 'host', host: 'node-b' }).set.gateExecutor).toBe('host');
  const noPool = { ...state, input: { version: VERSION, previousVersion: '0.2.18' } } as GraphRunState;
  expect(() => releaseResumeGateExecutor(noPool, { from: 'gate', executor: 'pod' })).toThrow('requires the saved run input gatePodPool');
});
