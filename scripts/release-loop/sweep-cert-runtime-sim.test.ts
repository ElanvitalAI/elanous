import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateRunner } from './gate-runtime.js';
import { isSweepCertificate } from './sweep-cert.js';
import { PodPoolScheduler } from '../../src/task-orchestrator/surfaces/pod-pool.js';
import type { RunPodCommandOptions } from '../../src/task-orchestrator/surfaces/pod-command-job.js';
import { SPAWN_SYNC_MAX_BUFFER } from '../../src/util/spawn-sync-output.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const IMAGE = `sha256:${'a'.repeat(64)}`;
const FILE = 'test/fixture.test.ts';
const junit = `<testsuites><testsuite name="${FILE}" file="${FILE}"><testcase name="passes" file="${FILE}"></testcase></testsuite></testsuites>`;

function fixture(includeSecondFile = false) {
  const root = mkdtempSync(join(tmpdir(), 'sweep-cert-runtime-'));
  dirs.push(root);
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'test'), { recursive: true });
  writeFileSync(join(repo, FILE), "import { expect, test } from 'bun:test'; test('fixture', () => expect(true).toBe(true));\n");
  const files = [FILE];
  if (includeSecondFile) {
    files.push('test/other.test.ts');
    writeFileSync(join(repo, 'test/other.test.ts'), "import { expect, test } from 'bun:test'; test('other', () => expect(true).toBe(true));\n");
  }
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: SPAWN_SYNC_MAX_BUFFER });
  git(['init', '-q']);
  git(['add', ...files]);
  git(['-c', 'user.name=TC simulation', '-c', 'user.email=tc@example.invalid', 'commit', '-qm', 'fixture']);
  const head = git(['rev-parse', 'HEAD']).trim();
  const receiptRoot = join(root, 'receipts');
  mkdirSync(receiptRoot);
  const command = async (cmd: string, args: string[], cwd: string) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    try { return { rc: 0, output: execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: SPAWN_SYNC_MAX_BUFFER }) }; }
    catch (error) {
      const result = error as { status?: number | null; stdout?: string; stderr?: string };
      return { rc: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
    }
  };
  return { root, repo, head, receiptRoot, command };
}

function runnerFor(f: ReturnType<typeof fixture>, failFile?: string, capacity = 1, unmeasuredFile?: string) { // Source: #35969 simulation checks matching and mismatched slot capacity.
  let podSequence = 0;
  const pod = async (options: RunPodCommandOptions) => {
    const files = [FILE, 'test/other.test.ts'].filter((file) => options.command[2]!.includes(file));
    const failed = !!failFile && files.includes(failFile);
    const artifactsDir = join(f.root, `pod-${podSequence++}`);
    mkdirSync(artifactsDir);
    const job = `fake-${artifactsDir.split('/').pop()}`;
    if (unmeasuredFile && files.includes(unmeasuredFile)) return { exitCode: 137, artifactsDir, job };
    const log = files.map((file) => failed ? `${file}:\n(fail) fails [1.00ms]\n` : '').join('')
      + `${files.length - (failed ? 1 : 0)} pass\n${failed ? '1' : '0'} fail\n0 errors\nRan ${files.length} tests across ${files.length} files.\n`;
    writeFileSync(join(artifactsDir, 'shard.log'), log);
    writeFileSync(join(artifactsDir, 'shard.rc'), failed ? '1\n' : '0\n');
    writeFileSync(join(artifactsDir, 'junit.xml'), `<testsuites>${files.map((file) => `<testsuite name="${file}" file="${file}"><testcase name="${failed ? 'fails' : 'passes'}" file="${file}">${failed ? '<failure message="fixture"/>' : ''}</testcase></testsuite>`).join('')}</testsuites>`);
    return { exitCode: failed ? 1 : 0, artifactsDir, job };
  };
  return createGateRunner(f.repo, undefined, f.command, pod, new PodPoolScheduler([
    { context: 'sim-pool', capacity, k3dCluster: 'sim' },
  ]), () => '');
}

const sweep = (f: ReturnType<typeof fixture>, failFile?: string, capacity = 1, only?: readonly string[], unmeasuredFile?: string) => runnerFor(f, failFile, capacity, unmeasuredFile).sweep(f.repo, undefined, { // Source: #35969 fixture defaults to matching root capacity.
  pool: 'pool-test', shards: 1, stallSeconds: 0,
  shardsFile: { path: join(f.root, 'shards.json'), version: '0.3.8', receiptRoot: f.receiptRoot, expectedImageDigest: IMAGE },
}, only);

test('production sweep entry records a certificate only after a complete successful Pod measurement', async () => {
  const f = fixture();
  const result = await sweep(f);
  expect(result.rc).toBe(0);
  const path = join(f.receiptRoot, 'sweep-certificate.json');
  expect(existsSync(path)).toBe(true);
  const certificate: unknown = JSON.parse(readFileSync(path, 'utf8'));
  expect(isSweepCertificate(certificate)).toBe(true);
  expect(certificate).toMatchObject({ sourceCommit: f.head, imageDigest: IMAGE, fileKeys: { [FILE]: expect.stringMatching(/^[a-f0-9]{64}$/) }, sweepConcurrency: 1 });
});

test('production sweep entry leaves the prior certificate intact after failed or concurrency-mismatched runs', async () => {
  // Source: #35969 concurrency boundary pairs one matching slot with a two-slot mismatch.
  for (const scenario of [{ failFile: FILE, capacity: 1 }, { failFile: undefined, capacity: 2 }]) {
    const f = fixture();
    const path = join(f.receiptRoot, 'sweep-certificate.json');
    const prior = JSON.stringify({ prior: true });
    writeFileSync(path, prior);
    let result: Awaited<ReturnType<typeof sweep>> | undefined;
    let failure: unknown;
    try { result = await sweep(f, scenario.failFile, scenario.capacity); } catch (error) { failure = error; }
    if (scenario.failFile) expect(failure === undefined ? result?.rc : 1).toBe(1);
    else {
      expect(failure).toBeUndefined();
      expect(result?.rc).toBe(0);
    }
    expect(readFileSync(path, 'utf8')).toBe(prior);
  }
});

test('production partial sweep over a two-file inventory preserves the prior full-sweep certificate', async () => {
  const f = fixture(true);
  const path = join(f.receiptRoot, 'sweep-certificate.json');
  const prior = JSON.stringify({ prior: true });
  writeFileSync(path, prior);
  const podFiles: string[][] = [];
  // Source: #35969 partial-measurement simulation assigns two test files to two root slots.
  const partialConcurrency = 2;
  const runner = createGateRunner(f.repo, undefined, f.command, async (options) => {
    const files = [FILE, 'test/other.test.ts'].filter((file) => options.command[2]!.includes(file));
    podFiles.push(files);
    const artifactsDir = join(f.root, `partial-pod-${podFiles.length}`);
    mkdirSync(artifactsDir);
    const job = `fake-partial-${podFiles.length}`;
    if (files.includes('test/other.test.ts')) return { exitCode: 137, artifactsDir, job };
    writeFileSync(join(artifactsDir, 'shard.log'), `1 pass\n0 fail\n0 errors\nRan 1 tests across 1 files.\n`);
    writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
    writeFileSync(join(artifactsDir, 'junit.xml'), junit);
    return { exitCode: 0, artifactsDir, job };
  }, new PodPoolScheduler([{ context: 'sim-pool', capacity: partialConcurrency, k3dCluster: 'sim' }]), () => '');
  let failure: unknown;
  try {
    await runner.sweep(f.repo, undefined, { pool: 'pool-test', shards: 2, stallSeconds: 0,
      shardsFile: { path: join(f.root, 'shards.json'), version: '0.3.8', receiptRoot: f.receiptRoot, expectedImageDigest: IMAGE } });
  } catch (error) { failure = error; }
  expect(failure).toBeDefined();
  expect(podFiles.flat()).toContain(FILE);
  expect(podFiles.flat()).toContain('test/other.test.ts');
  expect(podFiles.some((files) => files.length === 1 && files[0] === FILE)).toBe(true);
  expect(readFileSync(path, 'utf8')).toBe(prior);
});
