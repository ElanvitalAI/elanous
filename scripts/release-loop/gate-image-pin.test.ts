import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateImagePinPath, readGateImagePin, resolveGateImagePin, writeGateImagePin } from './gate-image-pin.js';

const digestA = `sha256:${'a'.repeat(64)}`;
const digestB = `sha256:${'b'.repeat(64)}`;

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
