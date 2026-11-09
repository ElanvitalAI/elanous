import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gateImagePinPath, pinnedGateImageSync, readGateImagePin, replaceGateImagePin, resolveGateImagePin, supersedeGateImagePin,
  gateImageLayerRuntimeKey, prebuildGateImagePinAtCut, writeGateImagePin } from './gate-image-pin.js';
import { podCommandJobManifest } from '../../src/task-orchestrator/surfaces/pod-command-job.js';

const digestA = `sha256:${'a'.repeat(64)}`;
const digestB = `sha256:${'b'.repeat(64)}`;
const digestC = `sha256:${'c'.repeat(64)}`;

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
