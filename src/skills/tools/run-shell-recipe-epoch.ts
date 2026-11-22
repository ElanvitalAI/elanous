import { readRecipeHighwater, type HighwaterResult } from './run-shell-recipe-highwater.js';
import { readRecipeTrustAnchor, recipeRevocationStateHash, type RecipeTrustResult } from './run-shell-recipe-trust.js';

/** Read-only epoch check. This is not itself authorization: callers must also verify
 * the signed recipe and bind its actual argv, cwd and executable at the spawn seam. */
export function checkRecipeEpoch(recipeSha256: string, readers: {
  trust: () => RecipeTrustResult; highwater: () => HighwaterResult;
} = { trust: readRecipeTrustAnchor, highwater: readRecipeHighwater }):
  { ok: true; epoch: number; publicKeyPem: string } | { ok: false; reason: string } {
  if (!/^[a-f0-9]{64}$/.test(recipeSha256)) return { ok: false, reason: 'invalid-recipe-hash' };
  const trust = readers.trust();
  if (!trust.ok) return trust;
  const highwater = readers.highwater();
  if (!highwater.ok) return highwater;
  if (trust.anchor.epoch !== highwater.epoch) return { ok: false, reason: 'epoch-mismatch' };
  if (recipeRevocationStateHash(trust.anchor) !== highwater.revocationStateSha256) return { ok: false, reason: 'revocation-state-mismatch' };
  if (trust.anchor.retired) return { ok: false, reason: 'trust-epoch-retired' };
  if (trust.anchor.revokedRecipeHashes.includes(recipeSha256)) return { ok: false, reason: 'recipe-revoked-by-anchor' };
  return { ok: true, epoch: trust.anchor.epoch, publicKeyPem: trust.anchor.publicKeyPem };
}
