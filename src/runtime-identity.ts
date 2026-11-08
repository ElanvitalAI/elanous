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

/** Architecture equality is the default; cross-architecture matching needs both sides allowlisted. */
export function runtimeArchitecturesMatch(left: string, right: string,
  allowedArchitectures: readonly string[] = []): boolean {
  const normalizedLeft = typeof left === 'string' && matchesEntire(atom, left) ? left.toLowerCase() : null;
  const normalizedRight = typeof right === 'string' && matchesEntire(atom, right) ? right.toLowerCase() : null;
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  // The only supported cross-architecture compatibility is the explicit amd64/arm64 pair.
  // A caller-provided list must never make unrelated or unknown architectures compatible.
  if (!((normalizedLeft === 'amd64' && normalizedRight === 'arm64')
    || (normalizedLeft === 'arm64' && normalizedRight === 'amd64'))) return false;
  const allowed = new Set(allowedArchitectures.filter(value => typeof value === 'string').map(value => value.toLowerCase()));
  return allowed.has(normalizedLeft) && allowed.has(normalizedRight);
}

export function runtimeIdentitiesMatch(left: RuntimeIdentityInput, right: RuntimeIdentityInput,
  allowedArchitectures: readonly string[] = []): boolean {
  const a = createRuntimeIdentity(left);
  const b = createRuntimeIdentity(right);
  return !!a && !!b
    && a.baseImageDigest === b.baseImageDigest
    && a.lockHash === b.lockHash
    && a.os === b.os
    && runtimeArchitecturesMatch(a.architecture, b.architecture, allowedArchitectures)
    && a.bunVersion === b.bunVersion;
}
