import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateLockfileHash } from '../self-implement/gate-receipt-registry.js';
import { warmWorkerSourceMatches } from '../task-orchestrator/surfaces/pod-warm-worker-runtime.js';
import { allocatePodPhaseCandidates, podPhaseGateIdentityMatches } from '../task-orchestrator/surfaces/pod-warm-switch.js';
import { scoreWarmPodCandidates } from '../task-orchestrator/surfaces/pod-warm-provenance.js';
import { WARM_POD_EXEC, WARM_POD_PREPARE, WARM_POD_RUNTIME_PROBE, probeWarmPodRuntimeContract, type WarmPodSpec } from '../task-orchestrator/surfaces/pod-warm-worker-pod.js';
import { runWarmPrecutCanary, warmGateReplaySelection, type GateRunner, type GateOptions } from '../../scripts/release-loop/gate-runtime.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function seedRepo() {
  const root = mkdtempSync(join(tmpdir(), 'pod-warm-lockhash-sim-'));
  roots.push(root);
  writeFileSync(join(root, 'bun.lock'), readFileSync(join(import.meta.dir, '../../bun.lock')));
  writeFileSync(join(root, 'src-example.test.ts'), 'test("sim", () => {});\n');
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-q']);
  git(['add', 'bun.lock', 'src-example.test.ts']);
  git(['-c', 'user.name=Lockhash Sim', '-c', 'user.email=sim@example.invalid', 'commit', '-qm', 'seed lockhash simulation']);
  return { root, cutSha: git(['rev-parse', 'HEAD']) };
}

test('POD-WARM-NORMALIZE · one bun.lock identity satisfies reconcile, gate selection, worker init, and precut canary', async () => {
  const { root, cutSha } = seedRepo();
  const lockHash = gateLockfileHash(root);
  const rawHash = createHash('sha256').update(readFileSync(join(root, 'bun.lock'))).digest('hex');
  expect(lockHash).not.toBe(rawHash);

  const key = { context: 'sim-host', imageDigest: `sha256:${'a'.repeat(64)}`, lockHash, architecture: 'amd64' };
  const phaseConfig = { gateIdentity: { cutSha, lockHash } };
  expect(podPhaseGateIdentityMatches({ cutSha, key }, phaseConfig)).toBe(true);
  expect(allocatePodPhaseCandidates([{ kind: 'gate' as const, cutSha, lockHash }], { gate: 1, implementation: 0 }, phaseConfig))
    .toMatchObject([{ kind: 'gate', candidate: { cutSha, lockHash } }]);
  const runtimeIdentity = { baseImageDigest: key.imageDigest, lockHash, os: 'linux', architecture: 'amd64', bunVersion: '1.4.2' };
  expect(scoreWarmPodCandidates({ kind: 'gate', cutSha, lockHash, imageDigest: key.imageDigest, runtimeIdentity,
    candidates: [{ candidate: 'warm-pod', kind: 'gate', cutSha, lockHash, imageDigest: key.imageDigest,
      runtimeIdentity, cutShaDistance: 0, contractCompatible: true }] }).selected).toBe('warm-pod');
  expect(WARM_POD_PREPARE).toContain('gateLockfileHash');
  expect(WARM_POD_EXEC).toContain('gateLockfileHash');
  expect(warmWorkerSourceMatches(root, cutSha, lockHash)).toBe(true);
  const selection = warmGateReplaySelection(key, { baseImageDigest: key.imageDigest, imageDigest: key.imageDigest,
    platform: 'linux', architecture: 'amd64', bunVersion: '1.4.2', envFingerprint: 'e'.repeat(64) });
  expect(selection.runtimeContract).toMatchObject({ lockHash, architecture: 'amd64', requiredTools: ['bun', 'git'] });

  const spec: WarmPodSpec = { name: 'warm-sim-host-standard-1', namespace: 'elanous-test', kubectlContext: 'k3d-sim-host',
    workerId: 'warm-sim-host-standard-1-uid', image: `registry.example/elanous@${key.imageDigest}`,
    sourceUrl: 'https://github.com/ElanvitalAI/elanous.git', cutSha, key,
    runtimeContract: { baseImageDigest: key.imageDigest, bunVersion: '1.4.2', os: 'linux', architecture: 'amd64', requiredTools: ['bun', 'git'] },
    memoryLimit: '16Gi', nodeName: 'sim-host-server-0', hostProbeUrl: 'http://host.orb.internal:10001/health',
    prodProbeUrl: 'http://core.elanous-prod:10002/' };
  expect(WARM_POD_RUNTIME_PROBE).toContain('gateLockfileHash');
  const probe = (observedLockHash: string) => probeWarmPodRuntimeContract(spec, () => ({ status: 0,
    stdout: JSON.stringify({ bunVersion: '1.4.2', os: 'linux', architecture: 'amd64',
      tools: { bun: true, git: true }, lockHash: observedLockHash }), stderr: '' }));
  expect(probe(lockHash).status).toBe('compatible');
  expect(probe(rawHash).status).toBe('incompatible');

  const previousState = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = join(root, 'state');
  try {
    const file = 'src-example.test.ts';
    writeFileSync(join(root, "gate-verdict.json"), JSON.stringify({ warmHistory: [], warmHistoryOnly: true }));
    let attempt = 0;
    const runner = {
      localCommand: async (command: string, args: string[]) => {
        const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
        return { rc: result.status ?? 1, output: result.stdout ?? '', error: result.stderr ?? '' };
      },
      recheckPod: async () => ({ rc: 0, warmShadow: { files: [file], attemptId: `sim-${++attempt}`,
        status: 'observed', reason: 'match', cutSha, baselineSha: cutSha,
        workerKey: key, finalized: true, quarantined: 'no' } }),
    } as unknown as GateRunner;
    const opts = { version: '0.3.8', commit: cutSha, baselineCommit: cutSha, repo: root,
      pod: { pool: 'sim', warmReplay: async () => ({ command: null }), warmFinalize: async () => {},
        warmQuarantine: async () => {}, executionIdentity: { baseImageDigest: key.imageDigest,
          bunVersion: '1.4.2', platform: 'linux', architecture: 'amd64' } } } as unknown as GateOptions;
    const result = await runWarmPrecutCanary({ opts, runner, file, config: {}, historyPath: join(root, 'gate-verdict.json') });
    expect(result.samples).toHaveLength(2);
    expect(result.samples.every(sample => sample.workerKey?.lockHash === lockHash)).toBe(true);
  } finally {
    if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previousState;
  }
});
