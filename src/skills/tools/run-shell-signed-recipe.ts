import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { elanousStateRoot } from '../../autopilot/state-paths.js';
import { checkRecipeEpoch } from './run-shell-recipe-epoch.js';
import { parseRecipeJson, recipeHash, verifySignedRecipeGrant } from './run-shell-recipe-ledger.js';

/** A signed, exact invocation: there is no caller-provided argv, cwd, or environment. */
export type SignedRecipe = Readonly<{ id: string; epoch: number; cwd: string; argv: readonly string[]; bytesSha256: string }>;
export type SignedRecipeEnvelope = { recipe: SignedRecipe; event: unknown };

export function readSignedRecipe(id: string): SignedRecipeEnvelope {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error('invalid recipe id');
  const path = join(elanousStateRoot(), 'runshell', 'recipes', `${id}.json`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > 1_000_000)
      throw new Error('unsafe recipe file');
    bytes = Buffer.alloc(stat.size);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length || fstatSync(fd).size !== stat.size)
      throw new Error('recipe file changed');
  } finally { closeSync(fd); }
  const envelope = parseRecipeJson(bytes) as SignedRecipeEnvelope;
  if (!envelope || typeof envelope !== 'object' || Object.keys(envelope).sort().join(',') !== 'event,recipe' || envelope.recipe?.id !== id)
    throw new Error('invalid recipe envelope');
  return envelope;
}

/** Called synchronously in the spawn gateway: runtime never selects its trust readers. */
export function authorizeSignedRecipe(envelope: SignedRecipeEnvelope): SignedRecipe {
  const r = envelope?.recipe;
  if (!r || typeof r !== 'object' || Object.keys(r).sort().join(',') !== 'argv,bytesSha256,cwd,epoch,id'
    || typeof r.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(r.id)
    || !Number.isSafeInteger(r.epoch) || r.epoch < 1 || typeof r.cwd !== 'string' || !isAbsolute(r.cwd)
    || !Array.isArray(r.argv) || r.argv.length < 1 || r.argv.length > 32
    || r.argv.some(part => typeof part !== 'string' || part.includes('\0') || part.length > 4096)
    || !isAbsolute(r.argv[0]!) || typeof r.bytesSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(r.bytesSha256))
    throw new Error('invalid signed recipe');
  const hash = recipeHash(r);
  const epoch = checkRecipeEpoch(hash);
  if (!epoch.ok) throw new Error(`recipe epoch: ${epoch.reason}`);
  if (r.epoch !== epoch.epoch) throw new Error('recipe epoch mismatch');
  const grant = verifySignedRecipeGrant(r, envelope.event, epoch.publicKeyPem);
  if (!grant.allowed) throw new Error(`recipe grant: ${grant.reason}`);
  const actual = createHash('sha256').update(readFileSync(r.argv[0]!)).digest('hex');
  if (actual !== r.bytesSha256) throw new Error('recipe executable changed');
  return r;
}
