import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateRunner } from './gate-node';
import { defaultGateHostMirrorReaders, readOperatingHostMirror, resolveGateHostMirror, type GateHostMirrorReaders } from './gate-host-mirror';
import { resetElanousConfigDir, setElanousConfigDir } from '../../src/elanous-config-dir.js';
import { debug } from '../../src/debug/log.js';
import { PodPoolScheduler } from '../../src/task-orchestrator/surfaces/pod-pool.js';
import type { RunPodCommandOptions } from '../../src/task-orchestrator/surfaces/pod-command-job.js';

const CUT = 'a'.repeat(40);
const roots: string[] = [];
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'gate-host-mirror-')); roots.push(dir); return dir; };
afterEach(() => { resetElanousConfigDir(); for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** An operating config dir (stand-in for ~/.elanous) whose config.json holds the given pod.hostMirror. */
const operatingDir = (hostMirror?: unknown) => {
  const dir = tmp();
  writeFileSync(join(dir, 'config.json'), JSON.stringify(hostMirror === undefined ? { llm: {} } : { pod: { hostMirror } }));
  return dir;
};

// The HARD run book shape: isolated config dir, no env, nothing in the isolated config, mirror only in the operating one.
const isolatedReaders = (opDir: string, extra: Partial<GateHostMirrorReaders> = {}): GateHostMirrorReaders => ({
  env: {}, config: () => undefined, isolated: () => true, operatingConfig: () => readOperatingHostMirror(opDir), ...extra,
});

test('isolated config, no env, operating config has pod.hostMirror → operating-config', () => {
  expect(resolveGateHostMirror(undefined, isolatedReaders(operatingDir('/mirror-host/elanous-agent.git'))))
    .toEqual({ hostMirror: '/mirror-host/elanous-agent.git', source: 'operating-config', path: '/mirror-host/elanous-agent.git' });
});

test('priority: option → env → current config → operating config', () => {
  const op = operatingDir('/op/mirror.git');
  const env = { ELANOUS_POD_HOST_MIRROR: ' /env/mirror.git ' };
  const config = () => '/cfg/mirror.git';
  expect(resolveGateHostMirror('/opt/mirror.git', isolatedReaders(op, { env, config })).source).toBe('option');
  expect(resolveGateHostMirror(undefined, isolatedReaders(op, { env, config }))).toEqual({ hostMirror: '/env/mirror.git', source: 'env', path: '/env/mirror.git' });
  expect(resolveGateHostMirror('  ', isolatedReaders(op, { config }))).toEqual({ hostMirror: '/cfg/mirror.git', source: 'config', path: '/cfg/mirror.git' });
});

test('nothing anywhere → none; the operating config is only read when the config is isolated (falsification)', () => {
  expect(resolveGateHostMirror(undefined, isolatedReaders(operatingDir()))).toEqual({ source: 'none', path: null });
  let read = 0;
  const op = operatingDir('/op/mirror.git');
  const notIsolated = resolveGateHostMirror(undefined, isolatedReaders(op, { isolated: () => false, operatingConfig: () => { read++; return readOperatingHostMirror(op); } }));
  expect(notIsolated).toEqual({ source: 'none', path: null });
  expect(read).toBe(0);
});

test('a failing or unusable operating read is none — the gate is never blocked by it', () => {
  const broken = tmp();
  writeFileSync(join(broken, 'config.json'), '{not json');
  expect(readOperatingHostMirror(broken)).toBeUndefined();
  expect(readOperatingHostMirror(join(broken, 'missing'))).toBeUndefined();
  expect(resolveGateHostMirror(undefined, isolatedReaders(broken))).toEqual({ source: 'none', path: null });
  expect(resolveGateHostMirror(undefined, isolatedReaders(broken, { operatingConfig: () => { throw new Error('EACCES'); } })).source).toBe('none');
  expect(resolveGateHostMirror(undefined, isolatedReaders(operatingDir('relative/mirror.git'))).source).toBe('none');
  expect(resolveGateHostMirror(undefined, isolatedReaders(operatingDir(42))).source).toBe('none');
});

test('default readers see an explicit --config-dir run root as isolated', () => {
  setElanousConfigDir(tmp());
  expect(defaultGateHostMirrorReaders().isolated()).toBe(true);
});

test('Pod sweep hands the resolved mirror to every shard podCommand and logs the source once per runner', async () => {
  const root = tmp();
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const op = operatingDir('/mirror-host/elanous-agent.git');
  const invoked: RunPodCommandOptions[] = [];
  const observed: unknown[] = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'release-loop.gate' && event === 'host-mirror-resolved') observed.push(data);
  });
  const runnerWith = () => createGateRunner(repo, undefined, async (cmd, args) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: 'src/a.test.ts\n' };
    throw new Error(`unexpected command: ${cmd}`);
  }, async (o) => {
    invoked.push(o);
    const artifactsDir = mkdtempSync(join(root, 'shard-'));
    writeFileSync(join(artifactsDir, 'shard.log'), '1 pass\n0 fail\nRan 1 test across 1 file.\n');
    writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
    return { exitCode: 0, artifactsDir, job: 'fake' };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 1, k3dCluster: 'test' }]));
  try {
    const runner = runnerWith();
    const pod = { pool: 'pool-test', shards: 1, hostMirrorReaders: isolatedReaders(op) };
    expect((await runner.sweep(repo, undefined, pod)).rc).toBe(0);
    expect((await runner.sweep(repo, undefined, pod)).rc).toBe(0);
    expect(invoked).toHaveLength(2);
    expect(invoked.map((o) => o.hostMirror)).toEqual(Array(2).fill('/mirror-host/elanous-agent.git'));
    expect(observed).toEqual([{ source: 'operating-config', path: '/mirror-host/elanous-agent.git' }]);

    // env wins over the operating config; nothing anywhere passes no hostMirror key at all (runPodCommand keeps its own fallback).
    invoked.length = 0; observed.length = 0;
    await runnerWith().sweep(repo, undefined, { ...pod, hostMirrorReaders: isolatedReaders(op, { env: { ELANOUS_POD_HOST_MIRROR: '/env/mirror.git' } }) });
    expect(invoked.map((o) => o.hostMirror)).toEqual(['/env/mirror.git']);
    invoked.length = 0;
    await runnerWith().sweep(repo, undefined, { ...pod, hostMirrorReaders: isolatedReaders(operatingDir()) });
    expect(invoked).toHaveLength(1);
    expect('hostMirror' in invoked[0]!).toBe(false);
    expect(observed).toEqual([{ source: 'env', path: '/env/mirror.git' }, { source: 'none', path: null }]);
  } finally { log.mockRestore(); }
});
