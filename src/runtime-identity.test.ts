import { describe, expect, it } from 'bun:test';
import { createRuntimeIdentity, runtimeArchitecturesMatch, runtimeIdentitiesMatch, runtimeIdentityKey } from './runtime-identity.js';

const identity = {
  baseImageDigest: `sha256:${'a'.repeat(64)}`,
  lockHash: 'b'.repeat(64),
  os: 'linux',
  architecture: 'amd64',
  bunVersion: '1.4.2',
};

describe('shared runtime identity', () => {
  it('keys the base image, lock, OS, architecture, and Bun version without host or source SHA', () => {
    const key = runtimeIdentityKey(identity);
    const withHostAndSource = { ...identity, host: 'gcp1', sourceSha: 'a'.repeat(40) };
    expect(key).toMatch(/^runtime-v1:[a-f0-9]{64}$/);
    expect(runtimeIdentityKey(withHostAndSource)).toBe(key);
    expect(runtimeIdentitiesMatch(identity, { ...identity })).toBe(true);
    expect(runtimeIdentitiesMatch(identity, { ...identity, baseImageDigest: `sha256:${'c'.repeat(64)}` })).toBe(false);
    expect(runtimeIdentitiesMatch(identity, { ...identity, lockHash: 'd'.repeat(64) })).toBe(false);
    expect(runtimeIdentitiesMatch(identity, { ...identity, os: 'darwin' })).toBe(false);
    expect(runtimeIdentitiesMatch(identity, { ...identity, architecture: 'arm64' })).toBe(false);
    expect(runtimeIdentitiesMatch(identity, { ...identity, architecture: 'arm64' }, ['amd64', 'arm64'])).toBe(true);
    expect(runtimeIdentitiesMatch(identity, { ...identity, bunVersion: '1.4.3' })).toBe(false);
  });

  it('normalizes OS and architecture and rejects incomplete or malformed identities', () => {
    expect(createRuntimeIdentity({ ...identity, os: 'LINUX', architecture: 'AMD64' }))
      .toEqual(createRuntimeIdentity(identity));
    expect(runtimeIdentityKey({ ...identity, baseImageDigest: 'mutable:latest' })).toBeNull();
    expect(runtimeIdentityKey({ ...identity, lockHash: '' })).toBeNull();
    expect(runtimeIdentityKey({ ...identity, bunVersion: 'latest' })).toBeNull();
    const newlineTainted = [
      { ...identity, baseImageDigest: `${identity.baseImageDigest}\n` },
      { ...identity, lockHash: `${identity.lockHash}\n` },
      { ...identity, os: 'linux\n' },
      { ...identity, architecture: 'amd64\n' },
      { ...identity, bunVersion: '1.4.2\n' },
    ];
    for (const value of newlineTainted) expect(runtimeIdentityKey(value)).toBeNull();
    expect(runtimeIdentitiesMatch({ ...identity, lockHash: '' }, { ...identity, lockHash: '' })).toBe(false);
  });
});

it('runtime architecture matching is exact by default and requires both sides allowlisted for cross-arch', () => {
  expect(runtimeArchitecturesMatch('amd64', 'amd64')).toBe(true);
  expect(runtimeArchitecturesMatch('amd64', 'arm64')).toBe(false);
  expect(runtimeArchitecturesMatch('amd64', 'arm64', ['amd64'])).toBe(false);
  expect(runtimeArchitecturesMatch('amd64', 'arm64', ['amd64', 'arm64'])).toBe(true);
  expect(runtimeArchitecturesMatch('amd64', 'armv7', ['amd64', 'arm64'])).toBe(false);
  expect(runtimeArchitecturesMatch('amd64', 'armv7', ['amd64', 'armv7'])).toBe(false);
  expect(runtimeArchitecturesMatch('amd64', 'ppc64le', ['amd64', 'ppc64le'])).toBe(false);
});
