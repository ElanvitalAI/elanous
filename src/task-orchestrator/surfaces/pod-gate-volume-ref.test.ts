import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  currentGateVolumeRuntimeIdentity,
  gateExternalVolumeMeasurements,
  gateExternalVolumeContentSha256,
  gateExternalVolumeIdentitySha256,
  parseGateExternalVolumeReadyEvents,
  parseGateExternalVolumeRejectedEvents,
  parseGateExternalVolumeRefs,
  parseGateExternalVolumeIdentity,
  sealGateExternalVolume,
  verifyGateExternalVolumeRef,
  type GateExternalVolumeIdentity,
  type GateVolumeRuntimeIdentity,
} from './pod-gate-volume-ref.js';

const roots: string[] = [];
const temp = () => { const path = mkdtempSync(join(tmpdir(), 'pod-gate-volume-ref-')); roots.push(path); return path; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const runtime: GateVolumeRuntimeIdentity = {
  imageDigest: `sha256:${'a'.repeat(64)}`,
  bunVersion: '1.3.3',
  os: 'linux',
  arch: 'x64',
};
const lockSha256 = 'b'.repeat(64);

test('runtime identity is tied to the caller pinned digest and current Bun platform tuple', () => {
  const actual = currentGateVolumeRuntimeIdentity(runtime.imageDigest);
  expect(actual.imageDigest).toBe(runtime.imageDigest);
  expect(actual.bunVersion).toBe(process.versions.bun);
  expect(String(actual.os)).toBe(String(process.platform));
  expect(String(actual.arch)).toBe(String(process.arch));
  expect(() => currentGateVolumeRuntimeIdentity('mutable-tag')).toThrow('image-digest-unmeasured');
});

function writeNodeModulesIdentity(root: string): GateExternalVolumeIdentity {
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'pkg', 'cli.js'), 'stable cli');
  symlinkSync('../pkg/cli.js', join(root, 'node_modules', '.bin', 'cli'));
  return sealGateExternalVolume(root, { kind: 'node_modules', runtimeIdentity: runtime, lockSha256 });
}

test('node_modules ref verifies runtime, lock and exact sealed tree including safe symlinks', () => {
  const root = temp();
  const sealed = writeNodeModulesIdentity(root);
  const expected = { kind: 'node_modules' as const, runtimeIdentity: runtime, lockSha256,
    contentSha256: sealed.contentSha256!, identitySha256: gateExternalVolumeIdentitySha256(sealed) };
  expect(verifyGateExternalVolumeRef(root, expected))
    .toMatchObject({ ok: true, identity: { kind: 'node_modules', lockSha256 } });
  expect(verifyGateExternalVolumeRef(root, { ...expected, lockSha256: 'c'.repeat(64) }))
    .toEqual({ ok: false, reason: 'lock-hash-mismatch' });
  writeFileSync(join(root, 'node_modules', 'pkg', 'cli.js'), 'contaminated');
  expect(verifyGateExternalVolumeRef(root, expected))
    .toEqual({ ok: false, reason: 'content-hash-mismatch' });
});

test('editing both node_modules content and its writable marker cannot bypass the cut-owned digest', () => {
  const root = temp();
  const sealed = writeNodeModulesIdentity(root);
  const trusted = { kind: 'node_modules' as const, runtimeIdentity: runtime, lockSha256,
    contentSha256: sealed.contentSha256!, identitySha256: gateExternalVolumeIdentitySha256(sealed) };
  writeFileSync(join(root, 'node_modules', 'pkg', 'cli.js'), 'attacker changed tree and marker');
  sealGateExternalVolume(root, { kind: 'node_modules', runtimeIdentity: runtime, lockSha256 });
  expect(verifyGateExternalVolumeRef(root, trusted)).toEqual({ ok: false, reason: 'trusted-content-hash-mismatch' });
});

test('marker runtime and lock metadata are pinned outside the writable volume', () => {
  const root = temp();
  const sealed = writeNodeModulesIdentity(root);
  const trusted = { kind: 'node_modules' as const, runtimeIdentity: runtime, lockSha256,
    contentSha256: sealed.contentSha256!, identitySha256: gateExternalVolumeIdentitySha256(sealed) };
  const marker = join(root, '.elanous-volume-ref.json');
  chmodSync(marker, 0o644);
  const edited = JSON.parse(readFileSync(marker, 'utf8')) as { runtimeIdentity: GateVolumeRuntimeIdentity };
  edited.runtimeIdentity.bunVersion = 'forged-runtime';
  writeFileSync(marker, `${JSON.stringify(edited)}\n`);
  expect(verifyGateExternalVolumeRef(root, trusted)).toEqual({ ok: false, reason: 'trusted-identity-hash-mismatch' });
});

test('git mirror verifies the whole tree against the cut-owned digest, not only the pinned commit', () => {
  const source = temp();
  const mirror = temp();
  execFileSync('git', ['init', source], { stdio: 'ignore' });
  execFileSync('git', ['-C', source, 'config', 'user.name', 'Volume test']);
  execFileSync('git', ['-C', source, 'config', 'user.email', 'volume-test@example.invalid']);
  writeFileSync(join(source, 'source.txt'), 'pinned source');
  execFileSync('git', ['-C', source, 'add', 'source.txt'], { stdio: 'ignore' });
  execFileSync('git', ['-C', source, 'commit', '-m', 'source'], { stdio: 'ignore' });
  const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['clone', '--bare', source, mirror], { stdio: 'ignore' });
  const sealed = sealGateExternalVolume(mirror, { kind: 'git-mirror', sourceCommit: commit });
  const trusted = { kind: 'git-mirror' as const, sourceCommit: commit, contentSha256: sealed.contentSha256!,
    identitySha256: gateExternalVolumeIdentitySha256(sealed) };
  expect(verifyGateExternalVolumeRef(mirror, trusted).ok).toBe(true);
  writeFileSync(join(mirror, 'objects', 'info', 'alternates'), '/tmp/untrusted-object-store\n');
  expect(verifyGateExternalVolumeRef(mirror, trusted)).toEqual({ ok: false, reason: 'git-mirror-external-alternates-forbidden' });
  rmSync(join(mirror, 'objects', 'info', 'alternates'));
  writeFileSync(join(mirror, 'untracked-mirror-state'), 'contamination');
  sealGateExternalVolume(mirror, { kind: 'git-mirror', sourceCommit: commit });
  expect(verifyGateExternalVolumeRef(mirror, trusted)).toEqual({ ok: false, reason: 'trusted-content-hash-mismatch' });
  writeFileSync(join(mirror, 'objects', 'info', 'alternates'), '/tmp/untrusted-object-store\n');
  expect(() => sealGateExternalVolume(mirror, { kind: 'git-mirror', sourceCommit: commit }))
    .toThrow('git-mirror-external-alternates-forbidden');
});

test('identity parsing rejects malformed kind-specific fields and unsafe volume trees', () => {
  expect(() => parseGateExternalVolumeIdentity(JSON.stringify({ schemaVersion: 1, kind: 'bun-cache' }))).toThrow();
  const root = temp();
  symlinkSync('../../outside', join(root, 'escape'));
  expect(() => gateExternalVolumeContentSha256(root)).toThrow('volume-symlink-escapes-root');
});

test('volume-ref inputs reject missing identity and the shard metric counts only complete Pod references', () => {
  expect(parseGateExternalVolumeRefs(undefined)).toEqual([]);
  const refs = parseGateExternalVolumeRefs([
    { kind: 'git-mirror', hostPath: '/mirror', contentSha256: 'a'.repeat(64), identitySha256: 'c'.repeat(64) },
    { kind: 'node_modules', hostPath: '/gate/node_modules', contentSha256: 'b'.repeat(64), identitySha256: 'd'.repeat(64) },
  ]);
  expect(() => parseGateExternalVolumeRefs([{ kind: 'node_modules', hostPath: 'relative' }])).toThrow('not canonical');
  expect(() => parseGateExternalVolumeRefs([{ kind: 'node_modules', hostPath: '/gate/node_modules' }])).toThrow('trusted content digest');
  expect(() => parseGateExternalVolumeRefs([refs[1], refs[1]])).toThrow('duplicated');
  const ready = parseGateExternalVolumeReadyEvents('ELANOUS_GATE_VOLUME_REF_READY git-mirror 2.5\nELANOUS_GATE_VOLUME_REF_READY node_modules 12\n');
  const rejected = parseGateExternalVolumeRejectedEvents('ELANOUS_GATE_VOLUME_REF_REJECTED node_modules deps-mismatch\n');
  expect(gateExternalVolumeMeasurements(refs, ready)).toEqual({ volumeRefPod: true, volumeRefExpectedCount: 2,
    volumeRefReadyCount: 2, volumeRefKinds: ['git-mirror', 'node_modules'], volumeRefRejected: [], volumeRefSnapshotPreparationMs: 0,
    volumeRefVerificationMs: 14.5, volumeRefPreparationMs: 14.5 });
  expect(gateExternalVolumeMeasurements(refs, ready, [], 5.5)).toMatchObject({
    volumeRefSnapshotPreparationMs: 5.5, volumeRefVerificationMs: 14.5, volumeRefPreparationMs: 20,
  });
  expect(gateExternalVolumeMeasurements(refs, ready.slice(1)).volumeRefPod).toBe(false);
  expect(gateExternalVolumeMeasurements(refs, ready, rejected).volumeRefPod).toBe(false);
});
