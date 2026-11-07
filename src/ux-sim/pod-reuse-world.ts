import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { podJobManifest } from '../task-orchestrator/surfaces/self-implement-pod.js';
import { podSourceScript } from '../task-orchestrator/surfaces/pod-source-receive.js';
import { recommendConcurrency, type PoolLeaseMeasure } from '../task-orchestrator/surfaces/pod-lease.js';
import { runWarmPoolReuseSimulation } from './warm-pool-reuse-sim.js';
import { createWorld, destroyWorld, runWarmPoolReuseWorldScenario } from './world.js';
import { getTestStateRoot } from '../nexus/paths.js';
import { createHostMirrorMountAdapter } from './pod-reuse-shared-fake-boundary.js';

export interface PodSourceIoMeasurement {
  sourceBytes: number;
  sourceManifestReadOnly: boolean;
  sourceMountPath: string;
  sourceHostPath: string | null;
  hostMirrorAdapter: { readOnly: boolean; bytesRead: number; bytesWritten: number; writeRejected: boolean };
  reference: { objectStoreBytes: number; sharedObjectAlternate: boolean; readBytes: number; setupMs: number; digest: string; via: string };
  copy: { objectStoreBytes: number; readBytes: number; setupMs: number; digest: string; via: string };
}

export interface PodReuseWorldResult {
  workerProviderHit: Awaited<ReturnType<typeof runWarmPoolReuseSimulation>>;
  workerProviderMismatch: Awaited<ReturnType<typeof runWarmPoolReuseSimulation>>;
  sourceIo: PodSourceIoMeasurement;
  scenario: Awaited<ReturnType<typeof runWarmPoolReuseWorldScenario>>;
  admission: ReturnType<typeof recommendConcurrency>;
  job: Record<string, unknown>;
}

function measureSourceIo(): PodSourceIoMeasurement {
  const root = mkdtempSync(join(tmpdir(), 'pod-reuse-source-io-'));
  try {
    const origin = join(root, 'origin');
    const mirror = join(root, 'mirror.git');
    const referenceCwd = join(root, 'reference-job');
    const copyCwd = join(root, 'copy-job');
    mkdirSync(referenceCwd);
    mkdirSync(copyCwd);
    execFileSync('git', ['init', '-q', '-b', 'main', origin]);
    execFileSync('git', ['-C', origin, 'config', 'user.email', 'pod-reuse-sim@example.com']);
    execFileSync('git', ['-C', origin, 'config', 'user.name', 'POD reuse simulation']);
    writeFileSync(join(origin, 'README.md'), 'host mirror source fixture\n');
    writeFileSync(join(origin, 'dependency-lock.fixture'), Buffer.alloc(256 * 1024, 0x61));
    execFileSync('git', ['-C', origin, 'add', 'README.md', 'dependency-lock.fixture']);
    execFileSync('git', ['-C', origin, 'commit', '-qm', 'seed simulation source']);
    execFileSync('git', ['clone', '-q', '--bare', origin, mirror]);
    const sumFileBytes = (path: string): number => readdirSync(path, { withFileTypes: true }).reduce((sum, entry) => {
      const child = join(path, entry.name);
      return sum + (entry.isDirectory() ? sumFileBytes(child) : statSync(child).size);
    }, 0);
    // A Git alternate is metadata, not a copied object payload. Count only
    // pack/fanout files so reference and copy report the bytes materialized
    // into each checkout's own object store, not network traffic.
    const sumGitObjectPayloadBytes = (path: string): number => readdirSync(path, { withFileTypes: true }).reduce((sum, entry) => {
      if (entry.isDirectory() && entry.name === 'info') return sum;
      const child = join(path, entry.name);
      return sum + (entry.isDirectory() ? sumGitObjectPayloadBytes(child) : statSync(child).size);
    }, 0);
    const sourceBytes = sumFileBytes(join(mirror, 'objects'));
    const hostMirrorAdapter = createHostMirrorMountAdapter({ path: mirror, seed: new Uint8Array(sourceBytes) });
    hostMirrorAdapter.read();
    let hostMirrorWriteRejected = false;
    try {
      hostMirrorAdapter.write(new Uint8Array([0]));
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('host-mirror mount is read-only')) throw error;
      hostMirrorWriteRejected = true;
    }
    const mirrorMountPath = mirror;
    const sourceManifest = podJobManifest({ name: 'pod-reuse-source-io', namespace: 'elanous-test',
      image: 'elanous-harness:sim', repoUrl: 'https://github.com/ElanvitalAI/elanous.git',
      hostMirror: mirror, args: ['--no-supervise'], passEnv: [], deadlineSeconds: 60 }) as {
        spec?: { template?: { spec?: { containers?: Array<{ volumeMounts?: Array<{ name: string; mountPath?: string; readOnly?: boolean }> }>; volumes?: Array<{ name: string; hostPath?: { path?: string; type?: string } }> } } };
      };
    const sourceMount = sourceManifest.spec?.template?.spec?.containers?.[0]?.volumeMounts
      ?.find(({ name }) => name === 'host-mirror');
    if (!sourceMount) throw new Error('production Job manifest omitted the host source mount');
    const sourceVolume = sourceManifest.spec?.template?.spec?.volumes?.find(({ name }) => name === 'host-mirror');
    if (sourceMount.mountPath !== '/host-mirror' || sourceMount.readOnly !== true
      || sourceVolume?.hostPath?.path !== mirror || sourceVolume.hostPath.type !== 'Directory') {
      throw new Error('production Job host mirror mount does not match the read-only Directory contract');
    }
    const referenceStart = performance.now();
    const referenceRun = Bun.spawnSync(['bash', '-c', `set -e\n${podSourceScript({ kind: 'default' }, origin, mirrorMountPath)}`], { cwd: referenceCwd });
    if (referenceRun.exitCode !== 0) throw new Error(`production Pod source script failed: ${referenceRun.stderr.toString()}`);
    if (!referenceRun.stdout.toString().includes('ELANOUS_POD_SOURCE_VIA mirror\n')) throw new Error('production Pod source script did not select the host mirror');
    const referenceMs = performance.now() - referenceStart;
    const referenceObjects = join(referenceCwd, 'repo', '.git', 'objects');
    const referenceAlternatesPath = join(referenceObjects, 'info', 'alternates');
    const sharedObjectAlternate = existsSync(referenceAlternatesPath)
      && readFileSync(referenceAlternatesPath, 'utf8').split(/\r?\n/).some((alternate) => alternate === join(mirror, 'objects'));
    const referenceObjectStoreBytes = sumGitObjectPayloadBytes(referenceObjects);

    const copyStart = performance.now();
    execFileSync('git', ['clone', '-q', '--no-hardlinks', `file://${mirror}`, join(copyCwd, 'repo')]);
    const copyMs = performance.now() - copyStart;
    const referenceRead = readFileSync(join(referenceCwd, 'repo', 'dependency-lock.fixture'));
    const copiedRead = readFileSync(join(copyCwd, 'repo', 'dependency-lock.fixture'));
    const copyObjectStoreBytes = sumGitObjectPayloadBytes(join(copyCwd, 'repo', '.git', 'objects'));
    const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

    return {
      sourceBytes,
      sourceManifestReadOnly: sourceMount.readOnly === true,
      sourceMountPath: sourceMount.mountPath ?? '',
      sourceHostPath: sourceManifest.spec?.template?.spec?.volumes?.find(({ name }) => name === 'host-mirror')?.hostPath?.path ?? null,
      hostMirrorAdapter: { readOnly: hostMirrorAdapter.readOnly, bytesRead: hostMirrorAdapter.bytesRead,
        bytesWritten: hostMirrorAdapter.bytesWritten, writeRejected: hostMirrorWriteRejected },
      reference: { objectStoreBytes: referenceObjectStoreBytes, sharedObjectAlternate, readBytes: referenceRead.byteLength, setupMs: referenceMs, digest: digest(referenceRead), via: 'production-pod-source-script/shared-mirror' },
      copy: { objectStoreBytes: copyObjectStoreBytes, readBytes: copiedRead.byteLength, setupMs: copyMs, digest: digest(copiedRead), via: 'git-clone-no-hardlinks' },
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Run the production reuse world and its supporting admission, Job and source-I/O measurements in one test universe. */
export async function runPodReuseWorld(runId: string): Promise<PodReuseWorldResult> {
  if (!getTestStateRoot()) throw new Error('POD reuse world requires an explicit --test universe');
  const suffix = runId.replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 32);
  let world: Awaited<ReturnType<typeof createWorld>> | undefined;
  try {
    world = await createWorld(join(import.meta.dir, '../../scenarios/ux-sim/warm-pool-reuse-world.yaml'));
    const scenario = await runWarmPoolReuseWorldScenario(world);
    if (!scenario.pass) throw new Error('shared Pod reuse lifecycle world did not pass');
    const workerProviderHit = await runWarmPoolReuseSimulation({ runId: `${suffix}-hit` });
    const workerProviderMismatch = await runWarmPoolReuseSimulation({ runId: `${suffix}-mismatch`, fault: 'profile-mismatch' });
    if (!workerProviderHit.selection?.selected) throw new Error('warm worker provider compatibility hit was not selected');

    const measure: PoolLeaseMeasure = { members: [{ context: 'pod-reuse-world', capacity: 4,
      capacityDefaulted: false, running: 0, pending: 0, unleasedRunning: 0,
      memoryLimitBytes: 6 * 1024 ** 3, allocatableMemoryBytes: 32 * 1024 ** 3,
      availableMemoryByNodeBytes: [26 * 1024 ** 3],
      allocatableMemoryByNodeBytes: [32 * 1024 ** 3], usedMemoryByNodeBytes: [6 * 1024 ** 3],
      reason: null, harnessUsageBytes: [], memoryReservedBytes: 6 * 1024 ** 3,
      allocatableCpuMillicores: 16_000, schedulableCpuMillicores: 16_000, pendingJobs: [] }] };
    const admission = recommendConcurrency(measure, { capacity: 4, accounts: 1, perAccount: 4 });
    const job = podJobManifest({ name: `${suffix}-job`, namespace: 'elanous-test', image: 'elanous-harness:sim',
      repoUrl: 'https://github.com/ElanvitalAI/elanous.git', args: ['--no-supervise'], passEnv: [], deadlineSeconds: 60 });

    return { workerProviderHit, workerProviderMismatch, sourceIo: measureSourceIo(), scenario, admission, job };
  } finally {
    if (world) await destroyWorld(world);
  }
}
