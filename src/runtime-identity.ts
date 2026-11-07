import { createHash } from 'node:crypto';

/** Stable environment identity shared by gate receipts, Pod matching, and image preflight. */
export interface RuntimeIdentityInput {
  baseImageDigest: string;
  lockHash: string;
  os: string;
  architecture: string;
  bunVersion: string;
}

export interface RuntimeIdentity extends RuntimeIdentityInput {
  version: 1;
}

const digest = /^sha256:[a-f0-9]{64}$/;
const hash = /^[a-f0-9]{64}$/;
const atom = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$/;
const version = /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/;
const matchesEntire = (pattern: RegExp, value: string) => pattern.exec(value)?.[0] === value;

/** Validate and normalize only the five environment facts; host and source commit are excluded. */
export function createRuntimeIdentity(input: RuntimeIdentityInput): RuntimeIdentity | null {
  if (!input || typeof input !== 'object'
    || typeof input.baseImageDigest !== 'string' || !matchesEntire(digest, input.baseImageDigest)
    || typeof input.lockHash !== 'string' || !matchesEntire(hash, input.lockHash)
    || typeof input.os !== 'string' || !matchesEntire(atom, input.os)
    || typeof input.architecture !== 'string' || !matchesEntire(atom, input.architecture)
    || typeof input.bunVersion !== 'string' || !matchesEntire(version, input.bunVersion)) return null;
  return { version: 1, baseImageDigest: input.baseImageDigest, lockHash: input.lockHash,
    os: input.os.toLowerCase(), architecture: input.architecture.toLowerCase(), bunVersion: input.bunVersion };
}

/** Canonical, host-independent key. Invalid or legacy/incomplete inputs fail closed. */
export function runtimeIdentityKey(input: RuntimeIdentityInput): string | null {
  const identity = createRuntimeIdentity(input);
  if (!identity) return null;
  const canonical = JSON.stringify([identity.version, identity.baseImageDigest, identity.lockHash,
    identity.os, identity.architecture, identity.bunVersion]);
  return `runtime-v1:${createHash('sha256').update(canonical).digest('hex')}`;
}

export function runtimeIdentitiesMatch(left: RuntimeIdentityInput, right: RuntimeIdentityInput): boolean {
  const leftKey = runtimeIdentityKey(left);
  return leftKey !== null && leftKey === runtimeIdentityKey(right);
}
