import { createHash, createPublicKey } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

/** Installed atomically by the privileged JUD/OP rollout, never selected by a model or user env. */
export const RUNSHELL_RECIPE_TRUST_PATH = '/etc/elanous/runshell-recipes/trust.json';
export type RecipeTrustAnchor = { schema: 1; epoch: number; publicKeyPem: string;
  retired: boolean; revokedRecipeHashes: string[] };
export type RecipeTrustResult = { ok: true; anchor: RecipeTrustAnchor }
  | { ok: false; reason: string };

export function readRecipeTrustAnchor(path = RUNSHELL_RECIPE_TRUST_PATH, ownerUid = 0): RecipeTrustResult {
  let fd: number | undefined;
  let text: string;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== ownerUid || (stat.mode & 0o022) !== 0
      || stat.size < 1 || stat.size > 8192) return { ok: false, reason: 'unsafe-trust-anchor' };
    const bytes = Buffer.alloc(stat.size);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length || fstatSync(fd).size !== stat.size)
      return { ok: false, reason: 'trust-anchor-changed' };
    text = bytes.toString('utf8');
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'missing-trust-anchor' : 'trust-anchor-read-failed' };
  } finally { if (fd !== undefined) closeSync(fd); }
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { ok: false, reason: 'invalid-trust-anchor' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'invalid-trust-anchor' };
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(',') !== 'epoch,publicKeyPem,retired,revokedRecipeHashes,schema'
    || item.schema !== 1 || !Number.isSafeInteger(item.epoch) || (item.epoch as number) < 1
    || typeof item.publicKeyPem !== 'string' || item.retired !== false && item.retired !== true
    || !Array.isArray(item.revokedRecipeHashes) || item.revokedRecipeHashes.length > 256
    || item.revokedRecipeHashes.some(hash => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))
    || new Set(item.revokedRecipeHashes).size !== item.revokedRecipeHashes.length)
    return { ok: false, reason: 'invalid-trust-anchor' };
  try {
    if (createPublicKey(item.publicKeyPem).asymmetricKeyType !== 'ed25519') throw new Error('wrong key');
  } catch { return { ok: false, reason: 'invalid-trust-key' }; }
  return { ok: true, anchor: item as RecipeTrustAnchor };
}

/** Canonical set encoding: order of revocations is not a state change. */
export function recipeRevocationStateHash(anchor: Pick<RecipeTrustAnchor, 'retired' | 'revokedRecipeHashes'>): string {
  return createHash('sha256').update(JSON.stringify({ retired: anchor.retired,
    revokedRecipeHashes: [...anchor.revokedRecipeHashes].sort() })).digest('hex');
}
