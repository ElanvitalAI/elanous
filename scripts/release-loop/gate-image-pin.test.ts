import { describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gateImagePinPath, pinnedGateImageSync, readGateImagePin, replaceGateImagePin, resolveGateImagePin, supersedeGateImagePin,
  gateImageLayerRuntimeKey, gateRuntimeBaseReuseMode, prebuildGateImagePinAtCut, prebuildGateImagePinForRuntimeBases,
  runCutGateImagePrebuild, writeGateImagePin } from './gate-image-pin.js';
import { podCommandJobManifest } from '../../src/task-orchestrator/surfaces/pod-command-job.js';
import { gateImageReadinessPendingPath, gateImageReadinessSignalPath,
  readGateImageReadinessSignal, waitForGateImageT60 } from './release-readiness.js';
import { setSchedule } from '../../src/release-loop/release-schedule.js';

const digestA = `sha256:${'a'.repeat(64)}`;
const digestB = `sha256:${'b'.repeat(64)}`;
const digestC = `sha256:${'c'.repeat(64)}`;
const attestedCut = (commit: string, runId: string) => ({ commit,
  gateImagePrebuild: { outcome: 'built', runId, cutCommit: commit, digest: digestA, eligiblePools: ['pool-a'] } });

it('image prebuild result sim publishes built and reused readiness that releases T-60', async () => {
  const root = mkdtempSync(join(tmpdir(), 'image-readiness-producer-'));
  const input = { root, repo: root, runId: 'cut-run', version: '0.3.9', commit: 'd'.repeat(40), pool: 'pool-a' };
  const path = gateImageReadinessSignalPath(root, input.version);
  const now = new Date('2026-11-09T03:05:00.000Z');
  try {
    setSchedule(input.version, { cutAt: '2026-11-09T03:00:00.000Z' }, 'OP', root);
    for (const outcome of ['built', 'reused'] as const) {
      const result = runCutGateImagePrebuild(input, { now: () => now,
        runPrebuild: () => ({ status: 0, stdout: JSON.stringify({ outcome, digest: digestA, eligiblePools: ['pool-a'] }) }) });
      expect(result).toEqual({ outcome, runId: input.runId, cutCommit: input.commit, digest: digestA, eligiblePools: ['pool-a'] });
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ schemaVersion: 1, status: 'ready', runId: input.runId,
        cutCommit: input.commit, imageDigest: digestA, eligiblePools: ['pool-a'], checkedAt: now.toISOString() });
      expect(await waitForGateImageT60({ runId: input.runId, input: { version: input.version },
        outputs: { 'version-release': attestedCut(input.commit, input.runId) } }, { ledgerRoot: root, now: () => now,
        sleep: async () => { throw new Error('unexpected image hold'); } })).toMatchObject({ signalPath: path, runId: input.runId });
    }
    expect(readdirSync(join(root, 'release', input.version)).filter((name) => name.includes('pending'))).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('failed image prebuild sim leaves T-60 held without a readiness signal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'image-readiness-failed-'));
  const input = { root, repo: root, runId: 'cut-run', version: '0.3.9', commit: 'd'.repeat(40), pool: 'pool-a' };
  const path = gateImageReadinessSignalPath(root, input.version);
  const now = new Date('2026-11-09T03:05:00.000Z');
  try {
    setSchedule(input.version, { cutAt: '2026-11-09T03:00:00.000Z' }, 'OP', root);
    expect(runCutGateImagePrebuild(input, { runPrebuild: () => ({ status: 1, stdout: JSON.stringify({ outcome: 'failed', reason: 'build failed' }) }) }))
      .toEqual({ outcome: 'failed', reason: 'build failed' });
    expect(existsSync(path)).toBe(false);
    await expect(waitForGateImageT60({ runId: input.runId, input: { version: input.version },
      outputs: { 'version-release': attestedCut(input.commit, input.runId) } }, { ledgerRoot: root, now: () => now,
      sleep: async () => { throw new Error('image hold observed'); } })).rejects.toThrow('image hold observed');
    expect(JSON.parse(readFileSync(join(root, 'release', input.version, 'readiness-countdown.json'), 'utf8')))
      .toMatchObject({ phase: 'hold', holdReason: 'image-t60:prebuild-pending' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('failed retry removes a prior ready signal for the same run and cut', async () => {
  const root = mkdtempSync(join(tmpdir(), 'image-readiness-retry-'));
  const input = { root, repo: root, runId: 'cut-run', version: '0.3.9', commit: 'd'.repeat(40), pool: 'pool-a' };
  const path = gateImageReadinessSignalPath(root, input.version);
  const now = new Date('2026-11-09T03:05:00.000Z');
  try {
    setSchedule(input.version, { cutAt: '2026-11-09T03:00:00.000Z' }, 'OP', root);
    expect(runCutGateImagePrebuild(input, { now: () => now,
      runPrebuild: () => ({ status: 0, stdout: JSON.stringify({ outcome: 'built', digest: digestA, eligiblePools: ['pool-a'] }) }) }).outcome).toBe('built');
    expect(existsSync(path)).toBe(true);
    expect(runCutGateImagePrebuild(input, { runPrebuild: () => ({ status: 1, stdout: JSON.stringify({ outcome: 'failed', reason: 'retry failed' }) }) }))
      .toEqual({ outcome: 'failed', reason: 'retry failed' });
    expect(existsSync(path)).toBe(false);
    await expect(waitForGateImageT60({ runId: input.runId, input: { version: input.version },
      outputs: { 'version-release': attestedCut(input.commit, input.runId) } }, { ledgerRoot: root, now: () => now,
      sleep: async () => { throw new Error('image hold observed'); } })).rejects.toThrow('image hold observed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const failure of ['delete', 'write', 'pending'] as const) {
  it(`independent T-60 rejects an old signal after ${failure} failure`, async () => {
    const root = mkdtempSync(join(tmpdir(), `image-readiness-${failure}-`));
    const old = { root, repo: root, runId: failure === 'write' ? 'current-run' : 'old-run',
      version: '0.3.9', commit: failure === 'delete' ? 'd'.repeat(40) : 'a'.repeat(40), pool: 'pool-a' };
    const current = { ...old, runId: 'current-run', commit: 'd'.repeat(40) };
    const path = gateImageReadinessSignalPath(root, old.version);
    const now = new Date('2026-11-09T03:05:00.000Z');
    const child = { status: 0, stdout: JSON.stringify({ outcome: 'built', digest: digestA, eligiblePools: ['pool-a'] }) };
    try {
      setSchedule(old.version, { cutAt: '2026-11-09T03:00:00.000Z' }, 'OP', root);
      expect(runCutGateImagePrebuild(old, { runPrebuild: () => child }).outcome).toBe('built');
      const injected = failure === 'delete' ? { invalidateReady: () => { throw new Error('delete denied'); } }
        : failure === 'pending' ? { markLocalPending: () => { throw new Error('pending denied'); } }
          : { writeReady: () => { throw new Error('write denied'); } };
      expect(runCutGateImagePrebuild(current, { ...injected, runPrebuild: () => child }).outcome).toBe('failed');
      // Remove an optional marker to prove the reader's run/cut identity check is sufficient.
      rmSync(gateImageReadinessPendingPath(root, old.version), { force: true });
      expect(readGateImageReadinessSignal(path, { runId: old.runId, cutCommit: old.commit }).status).toBe('ready');
      await expect(waitForGateImageT60({ runId: current.runId, input: { version: current.version },
        outputs: { 'version-release': { commit: current.commit,
          gateImagePrebuild: attestedCut(old.commit, old.runId).gateImagePrebuild } } }, { ledgerRoot: root, now: () => now,
        sleep: async () => { throw new Error('identity hold observed'); } })).rejects.toThrow('identity hold observed');
      expect(JSON.parse(readFileSync(join(root, 'release', current.version, 'readiness-countdown.json'), 'utf8')))
        .toMatchObject({ phase: 'hold', eta: null });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

it('invalid successful child result cannot publish readiness', () => {
  const root = mkdtempSync(join(tmpdir(), 'image-readiness-invalid-'));
  const input = { root, repo: root, runId: 'cut-run', version: '0.3.9', commit: 'd'.repeat(40), pool: 'pool-a' };
  const path = gateImageReadinessSignalPath(root, input.version);
  try {
    for (const result of [{ outcome: 'built', digest: 'latest', eligiblePools: ['pool-a'] },
      { outcome: 'reused', digest: digestA, eligiblePools: [] }]) {
      expect(runCutGateImagePrebuild(input, { runPrebuild: () => ({ status: 0, stdout: JSON.stringify(result) }) }).outcome).toBe('failed');
      expect(existsSync(path)).toBe(false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('a retry with a read-only release directory cannot release the countdown', async () => {
  const root = mkdtempSync(join(tmpdir(), 'image-readiness-unlink-'));
  const input = { root, repo: root, runId: 'cut-run', version: '0.3.9', commit: 'd'.repeat(40), pool: 'pool-a' };
  const path = gateImageReadinessSignalPath(root, input.version);
  const dir = join(root, 'release', input.version);
  try {
    expect(runCutGateImagePrebuild(input, { runPrebuild: () => ({ status: 0,
      stdout: JSON.stringify({ outcome: 'built', digest: digestA, eligiblePools: ['pool-a'] }) }) }).outcome).toBe('built');
    setSchedule(input.version, { cutAt: '2026-11-09T03:00:00.000Z' }, 'OP', root);
    chmodSync(dir, 0o500);
    expect(runCutGateImagePrebuild(input, { runPrebuild: () => ({ status: 1,
      stdout: JSON.stringify({ outcome: 'failed', reason: 'retry failed' }) }) }).outcome).toBe('failed');
    await expect(waitForGateImageT60({ runId: input.runId, input: { version: input.version },
      outputs: { 'version-release': { commit: input.commit } } }, { ledgerRoot: root,
      now: () => new Date('2026-11-09T03:05:00.000Z') })).rejects.toThrow();
    chmodSync(dir, 0o700);
    expect(readGateImageReadinessSignal(path, { runId: input.runId, cutCommit: input.commit }, { ignorePending: true }).status).toBe('ready');
    await expect(waitForGateImageT60({ runId: input.runId, input: { version: input.version },
      outputs: { 'version-release': { commit: input.commit } } }, { ledgerRoot: root,
      now: () => new Date('2026-11-09T03:05:00.000Z'),
      sleep: async () => { throw new Error('unconfirmed hold observed'); } })).rejects.toThrow('unconfirmed hold observed');
    expect(JSON.parse(readFileSync(join(dir, 'readiness-countdown.json'), 'utf8')))
      .toMatchObject({ phase: 'hold', holdReason: 'image-t60:prebuild-unconfirmed' });
  } finally { chmodSync(dir, 0o700); rmSync(root, { recursive: true, force: true }); }
});

it('readiness rename failure returns failed and removes the pending file', () => {
  const root = mkdtempSync(join(tmpdir(), 'image-readiness-rename-'));
  const input = { root, repo: root, runId: 'cut-run', version: '0.3.9', commit: 'd'.repeat(40), pool: 'pool-a' };
  const path = gateImageReadinessSignalPath(root, input.version);
  try {
    mkdirSync(path, { recursive: true });
    expect(runCutGateImagePrebuild(input, { runPrebuild: () => ({ status: 0,
      stdout: JSON.stringify({ outcome: 'built', digest: digestA, eligiblePools: ['pool-a'] }) }) }).outcome).toBe('failed');
    expect(readdirSync(join(root, 'release', input.version)).sort()).toEqual(['image-readiness.json', 'image-readiness.pending']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('keys the reusable source-free layer only by measured runtime identity', () => {
  const identity = { baseImageDigest: digestA, lockHash: 'b'.repeat(64), architecture: 'x86_64', bunVersion: '1.4.2',
    buildRecipeHash: 'c'.repeat(64), gateDepsDigest: 'd'.repeat(12), skillsDigest: 'e'.repeat(16) };
  const key = gateImageLayerRuntimeKey(identity);
  expect(key).toMatch(/^[a-f0-9]{40}$/);
  expect(gateImageLayerRuntimeKey(identity)).toBe(key);
  expect(gateImageLayerRuntimeKey({ ...identity, architecture: 'aarch64' })).not.toBe(key);
  expect(gateImageLayerRuntimeKey({ ...identity, buildRecipeHash: 'f'.repeat(64) })).not.toBe(key);
  expect(gateImageLayerRuntimeKey({ ...identity, gateDepsDigest: 'a'.repeat(12) })).not.toBe(key);
  expect(gateImageLayerRuntimeKey({ ...identity, skillsDigest: 'none' })).not.toBe(key);
  expect(() => gateImageLayerRuntimeKey({ ...identity, lockHash: '' })).toThrow('identity is incomplete');
});

it('reuses a mixed-base runtime only when every pool already has the same immutable tag digest', () => {
  const arm = { digest: digestA, architecture: 'aarch64' };
  const amd = { digest: digestB, architecture: 'x86_64' };
  expect(gateRuntimeBaseReuseMode([arm, arm], [])).toBe('uniform-base');
  expect(gateRuntimeBaseReuseMode([arm, amd], [digestC, digestC])).toBe('shared-tag');
  expect(() => gateRuntimeBaseReuseMode([arm, amd], [digestC, null])).toThrow('no shared pinned image tag');
  expect(() => gateRuntimeBaseReuseMode([arm, amd], [digestC, digestB])).toThrow('no shared pinned image tag');
  expect(() => gateRuntimeBaseReuseMode([arm, null], [digestC, digestC])).toThrow('could not be measured');
});

it('persists a mixed-base shared tag for the new run without building, and rejects missing or drifting pools', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-mixed-base-prebuild-'));
  const commit = 'd'.repeat(40);
  const image = 'elanous-harness:shared-tag';
  const members = [{ context: 'pool-arm' }, { context: 'pool-amd' }];
  const runtimeBases = [{ digest: digestA, architecture: 'aarch64' }, { digest: digestB, architecture: 'x86_64' }];
  const observed = new Map(members.map((member) => [member.context, digestC]));
  let builds = 0;
  const input = {
    root, version: '0.3.6', commit, image, members, runtimeBases,
    probe: (member: { context: string }) => observed.get(member.context) ?? null,
    sync: async () => { builds++; return new Map(); },
  };
  try {
    expect(await prebuildGateImagePinForRuntimeBases({ ...input, runId: 'shared-run' })).toEqual({
      outcome: 'reused', digest: digestC, eligiblePools: members.map((member) => member.context),
    });
    expect(JSON.parse(readFileSync(gateImagePinPath(root, input.version, 'shared-run'), 'utf8')))
      .toMatchObject({ runId: 'shared-run', commit, image, digest: digestC });
    observed.set('pool-amd', digestB);
    await expect(prebuildGateImagePinForRuntimeBases({ ...input, runId: 'drift-run' }))
      .rejects.toThrow('no shared pinned image tag');
    expect(existsSync(gateImagePinPath(root, input.version, 'drift-run'))).toBe(false);
    observed.delete('pool-amd');
    await expect(prebuildGateImagePinForRuntimeBases({ ...input, runId: 'missing-run' }))
      .rejects.toThrow('no shared pinned image tag');
    expect(existsSync(gateImagePinPath(root, input.version, 'missing-run'))).toBe(false);
    expect(builds).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('GATE-IMAGE-PREBUILD-AT-CUT sim: builds after cut and persists the exact run pin', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-image-prebuild-sim-'));
  const commit = 'd'.repeat(40);
  const image = `elanous-harness:${commit.slice(0, 12)}`;
  const members = [{ context: 'pool-a' }, { context: 'pool-b' }];
  const seen = new Map<string, string | null>();
  let builds = 0;
  const options = {
    root, version: '0.3.6', runId: 'cut-run', commit, image, members,
    probe: (member: { context: string }) => seen.get(member.context) ?? null,
    sync: async () => {
      builds++;
      for (const member of members) seen.set(member.context, digestA);
      return new Map(members.map((member) => [member.context, { ok: true }])) as Map<string, { ok: boolean }>;
    },
  };
  try {
    const prebuilt = await prebuildGateImagePinAtCut(options);
    expect(prebuilt).toEqual({ outcome: 'built', digest: digestA, eligiblePools: ['pool-a', 'pool-b'] });
    expect(builds).toBe(1);
    const pinPath = gateImagePinPath(root, '0.3.6', 'cut-run');
    expect(readGateImagePin(pinPath, 'cut-run', image, commit)?.digest).toBe(digestA);

    const reused = await prebuildGateImagePinAtCut(options);
    expect(reused).toEqual({ outcome: 'reused', digest: digestA, eligiblePools: ['pool-a', 'pool-b'] });
    expect(builds).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('GATE-IMAGE-PREBUILD-AT-CUT append refreshes the run pin for the new cut commit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-image-prebuild-append-'));
  const firstCommit = 'd'.repeat(40), nextCommit = 'e'.repeat(40);
  const members = [{ context: 'pool-a' }];
  const seen = new Map<string, string>();
  let builds = 0;
  const input = (commit: string, digest: string) => ({ root, version: '0.3.6', runId: 'append-run', commit,
    image: `elanous-harness:${commit.slice(0, 12)}`, members,
    probe: (member: { context: string }) => seen.get(`${commit}:${member.context}`) ?? null,
    sync: async () => { builds++; seen.set(`${commit}:pool-a`, digest); return new Map([['pool-a', { ok: true }]]); },
  });
  try {
    await prebuildGateImagePinAtCut(input(firstCommit, digestA));
    const appended = await prebuildGateImagePinAtCut(input(nextCommit, digestB));
    expect(appended).toEqual({ outcome: 'built', digest: digestB, eligiblePools: ['pool-a'] });
    expect(builds).toBe(2);
    expect(readGateImagePin(gateImagePinPath(root, '0.3.6', 'append-run'), 'append-run',
      `elanous-harness:${nextCommit.slice(0, 12)}`, nextCommit)?.digest).toBe(digestB);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

describe('resolveGateImagePin', () => {
  it('selects one immutable digest for the first sweep and excludes pools without it', () => {
    expect(resolveGateImagePin({
      initialDigest: digestA,
      poolImages: new Map([
        ['pool-node-b', [digestA]],
        ['pool-node-c', [digestA, digestB]],
        ['pool-minim5', [digestB]],
      ]),
    })).toEqual({ ok: true, digest: digestA, eligiblePools: ['pool-node-b', 'pool-node-c'] });
  });

  it('reuses the saved digest on resume even when another digest is now the default', () => {
    expect(resolveGateImagePin({
      savedDigest: digestA,
      initialDigest: digestB,
      poolImages: new Map([
        ['pool-node-b', [digestB]],
        ['pool-node-c', [digestA]],
      ]),
    })).toEqual({ ok: true, digest: digestA, eligiblePools: ['pool-node-c'] });
  });

  it('fails closed for malformed or unavailable saved pins', () => {
    expect(resolveGateImagePin({
      savedDigest: 'latest',
      poolImages: new Map([['pool-node-b', [digestA]]]),
    })).toEqual({ ok: false, reason: 'saved-image-digest-invalid' });
    expect(resolveGateImagePin({
      savedDigest: digestA,
      poolImages: new Map([['pool-node-b', [digestB]]]),
    })).toEqual({ ok: false, reason: 'pinned-image-unavailable' });
  });

  it('fails closed instead of using a mutable or missing first-run image', () => {
    expect(resolveGateImagePin({
      initialDigest: 'registry.example/gate:main',
      poolImages: new Map([['pool-node-b', [digestA]]]),
    })).toEqual({ ok: false, reason: 'initial-image-digest-invalid' });
    expect(resolveGateImagePin({ poolImages: new Map([['pool-node-b', [digestA]]]) }))
      .toEqual({ ok: false, reason: 'initial-image-digest-missing' });
  });

  it('pins the OCI RepoDigest, not the different local image Id, while keeping only matching repo digests eligible', () => {
    const localImageId = `sha256:${'c'.repeat(64)}`;
    const repoDigest = `sha256:${'d'.repeat(64)}`;
    const otherRepoDigest = `sha256:${'e'.repeat(64)}`;
    expect(localImageId).not.toBe(repoDigest);
    expect(resolveGateImagePin({
      initialDigest: repoDigest,
      poolImages: new Map([['pool-node-b', [repoDigest]], ['pool-node-c', [repoDigest]], ['pool-other', [otherRepoDigest]]]),
    })).toEqual({ ok: true, digest: repoDigest, eligiblePools: ['pool-node-b', 'pool-node-c'] });
  });

  it('persists one run pin and refuses a later rewrite or an absent resume pin', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-image-pin-'));
    try {
      const path = gateImagePinPath(root, '0.2.42', 'run-1');
      expect(readGateImagePin(path, 'run-1', `elanous-harness:${'a'.repeat(12)}`, 'a'.repeat(40))).toBeNull();
      writeGateImagePin(path, 'run-1', digestA, `elanous-harness:${'a'.repeat(12)}`, 'a'.repeat(40));
      expect(readGateImagePin(path, 'run-1', `elanous-harness:${'a'.repeat(12)}`, 'a'.repeat(40))).toEqual({
        runId: 'run-1', digest: digestA, image: `elanous-harness:${'a'.repeat(12)}`, commit: 'a'.repeat(40),
      });
      expect(() => readGateImagePin(path, 'other-run', `elanous-harness:${'a'.repeat(12)}`, 'a'.repeat(40))).toThrow('invalid gate image pin');
      expect(() => readGateImagePin(path, 'run-1', `elanous-harness:${'a'.repeat(12)}`, 'b'.repeat(40))).toThrow('invalid gate image pin');
      expect(() => writeGateImagePin(path, 'run-1', digestB, `elanous-harness:${'a'.repeat(12)}`, 'a'.repeat(40))).toThrow('immutable');
      expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ version: 2, runId: 'run-1', digest: digestA,
        image: `elanous-harness:${'a'.repeat(12)}`, commit: 'a'.repeat(40) });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

it('keeps a Job on its run-pinned digest and reports tag drift without a push', () => {
  const pinned = `sha256:${'a'.repeat(64)}`;
  const drifted = `sha256:${'b'.repeat(64)}`;
  const commit = 'd'.repeat(40);
  const sync = pinnedGateImageSync({ runId: 'release-run-7', commit, digest: pinned, image: 'elanous-harness:local',
    members: [{ context: 'pool-test', registry: 'k3d-elanous-registry:5050' }], probeTagDigest: () => drifted });
  expect(sync.images.get('pool-test')).toEqual({ ok: true, action: 'fresh', detail: 'run-pinned-digest; tag push skipped', ms: 0,
    imageRef: `k3d-elanous-registry:5050/elanous-harness@${pinned}` });
  expect(sync.tagDrifts).toEqual([{ event: 'image-tag-drift', runId: 'release-run-7',
    tag: `k3d-elanous-registry:5050/elanous-harness:${commit.slice(0, 12)}`,
    pinnedDigest: pinned, observedDigest: drifted, reason: 'digest-changed', context: 'pool-test' }]);
  const imageRef = sync.images.get('pool-test')!.imageRef;
  const manifest = podCommandJobManifest({ name: 'gate-pinned-image', namespace: 'elanous-test', image: imageRef,
    imagePullPolicy: 'IfNotPresent', repoUrl: 'https://example.invalid/repo', command: ['true'], skills: [], clone: true,
    source: { kind: 'commit', sha: commit }, deadlineSeconds: 120,
    provenance: { actorKind: 'seat', actor: 'TC', kind: 'gate-shard', run: 'release-run-7', phase: 'release-gate',
      requestedAt: '2026-10-31T12:00:00.000Z' } });
  const spec = manifest.spec as { template: { spec: { containers: Array<{ image: string; imagePullPolicy: string }> } } };
  expect(spec.template.spec.containers[0]).toMatchObject({ image: imageRef, imagePullPolicy: 'IfNotPresent' });
});

it('probes a fully-qualified image by commit tag without duplicating the registry prefix', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const observed = `sha256:${'b'.repeat(64)}`;
  const commit = 'e'.repeat(40);
  const sync = pinnedGateImageSync({ runId: 'release-run-no-tag', commit, digest, image: 'docker.io/library/elanous-harness',
    members: [{ context: 'pool-test', registry: 'registry.example' }], probeTagDigest: () => observed });

  expect(sync.tagDrifts).toEqual([{ event: 'image-tag-drift', runId: 'release-run-no-tag',
    tag: `registry.example/library/elanous-harness:${commit.slice(0, 12)}`, pinnedDigest: digest, observedDigest: observed,
    reason: 'digest-changed',
    context: 'pool-test' }]);
  expect(sync.images.get('pool-test')?.imageRef).toBe(`registry.example/library/elanous-harness@${digest}`);
});

it('records an unavailable commit tag instead of silently omitting drift evidence', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const commit = 'e'.repeat(40);
  const sync = pinnedGateImageSync({ runId: 'release-run-missing-tag', commit, digest, image: 'elanous-harness:local',
    members: [{ context: 'pool-test', registry: 'registry.example:5000' }], probeTagDigest: () => null });

  expect(sync.tagDrifts).toEqual([{ event: 'image-tag-drift', runId: 'release-run-missing-tag',
    tag: `registry.example:5000/elanous-harness:${commit.slice(0, 12)}`, pinnedDigest: digest,
    observedDigest: null, reason: 'tag-unavailable', context: 'pool-test' }]);
});

it('archives every tip transition in an A→B→A→B sequence without overwriting prior pins', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-image-pin-archive-cycle-'));
  try {
    const runId = 'run-pin-cycle';
    const path = gateImagePinPath(root, '0.2.44', runId);
    const commits = ['a', 'b', 'a', 'b'].map((letter) => letter.repeat(40));
    writeGateImagePin(path, runId, digestA, `elanous-harness:${commits[0]!.slice(0, 12)}`, commits[0]!);
    for (const [index, commit] of commits.slice(1).entries()) {
      const priorCommit = commits[index]!;
      const nextDigest = index === 1 ? digestC : index % 2 ? digestA : digestB;
      expect(replaceGateImagePin(path, runId, nextDigest, `elanous-harness:${commit.slice(0, 12)}`,
        commit, `elanous-harness:${commit.slice(0, 12)}`, priorCommit)).toBeTruthy();
    }
    const archives = readdirSync(dirname(path)).filter((name) => name.startsWith(`${path.split('/').at(-1)}.superseded-`));
    expect(archives).toHaveLength(3);
    expect(new Set(archives).size).toBe(3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('retries an interrupted tip replacement while the previous active pin remains readable', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-image-pin-replacement-retry-'));
  try {
    const runId = 'run-pin-replace-retry';
    const oldCommit = 'c'.repeat(40);
    const newCommit = 'd'.repeat(40);
    const oldImage = `elanous-harness:${oldCommit.slice(0, 12)}`;
    const newImage = `elanous-harness:${newCommit.slice(0, 12)}`;
    const path = gateImagePinPath(root, '0.2.44', runId);
    writeGateImagePin(path, runId, digestA, oldImage, oldCommit);
    const interruptedArchive = supersedeGateImagePin(path, runId, oldImage, newCommit);
    expect(interruptedArchive).not.toBeNull();
    expect(readGateImagePin(path, runId, oldImage, oldCommit)?.digest).toBe(digestA);

    const archivePath = replaceGateImagePin(path, runId, digestB, newImage, newCommit, newImage, oldCommit);
    expect(readGateImagePin(path, runId, newImage, newCommit)?.digest).toBe(digestB);
    expect(JSON.parse(readFileSync(archivePath, 'utf8'))).toMatchObject({ commit: oldCommit, digest: digestA });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
