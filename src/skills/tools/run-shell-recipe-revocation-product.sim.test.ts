import { expect, test } from 'bun:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTestStateRoot } from '../../nexus/paths.js';
import { recipeHash, recipeSigningBytes } from './run-shell-recipe-ledger.js';
import { authorizeSignedRecipe } from './run-shell-signed-recipe.js';
import { dispatchSignedRecipe } from './run-shell-recipe-dispatch.js';

// Real root-owned trust path is required. Never touch a host: this test only runs
// in an explicitly opted-in disposable, networkless Docker container.
test.skipIf(process.env.RUNSHELL_ISOLATED_EPOCH_SIM !== '1')('synthetic trust events revoke and advance the real product epoch path', async () => {
  if (process.env.RUNSHELL_ISOLATED_EPOCH_SIM !== '1' || process.getuid?.() !== 0 || !existsSync('/.dockerenv'))
    throw new Error('requires explicitly opted-in disposable root Docker container');
  const trustDir = '/etc/elanous/runshell-recipes';
  const trustPath = join(trustDir, 'trust.json');
  if (existsSync(trustPath)) throw new Error('refusing to overwrite an existing trust anchor');
  const home = mkdtempSync(join(tmpdir(), 'recipe-revocation-sim-'));
  const previousState = process.env.ELANOUS_STATE_DIR;
  try {
    process.env.ELANOUS_STATE_DIR = home;
    setTestStateRoot(home);
    mkdirSync(trustDir, { recursive: true, mode: 0o700 });
    mkdirSync(join(home, 'runshell', 'recipes'), { recursive: true, mode: 0o700 });
    const keys = generateKeyPairSync('ed25519');
    const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const recipe = Object.freeze({ id: 'sample', epoch: 7, cwd: home, argv: Object.freeze(['/usr/bin/uname', '-s']),
      bytesSha256: createHash('sha256').update(readFileSync('/usr/bin/uname')).digest('hex') });
    const hash = recipeHash(recipe);
    const unsigned = { v: 1 as const, kind: 'grant' as const, recipeId: recipe.id, recipeSha256: hash,
      signer: 'JUD' as const, at: '2026-11-22T00:00:00.000Z' };
    const envelope = { recipe, event: { ...unsigned, signature: sign(null, recipeSigningBytes(unsigned), keys.privateKey).toString('base64') } };
    writeFileSync(join(home, 'runshell', 'recipes', 'sample.json'), JSON.stringify(envelope), { mode: 0o600 });
    const anchor = (epoch: number, revokedRecipeHashes: string[] = []) =>
      writeFileSync(trustPath, JSON.stringify({ schema: 1, epoch, publicKeyPem, retired: false, revokedRecipeHashes }), { mode: 0o600 });
    const provision = (epoch: number) => Bun.spawnSync([process.execPath, join(import.meta.dir, '../../../scripts/runshell-recipe-highwater.ts'), String(epoch)], { env: process.env });
    anchor(7); expect(provision(7).exitCode).toBe(0);
    const accepted = await dispatchSignedRecipe('sample', 5000);
    expect(accepted.outcome).toBe('exit'); expect(accepted.exitCode).toBe(0); expect(accepted.stdout.trim()).toBe('Linux');
    console.log('SYNTHETIC_EVENT baseline epoch=7 outcome=exit exitCode=0 stdout=Linux');
    anchor(7, [hash]);
    expect(() => authorizeSignedRecipe(envelope)).toThrow('recipe epoch: revocation-state-mismatch');
    expect(provision(7).exitCode).not.toBe(0);
    const revoked = await dispatchSignedRecipe('sample', 5000);
    expect(revoked.outcome).toBe('denied'); expect(revoked.stdout).toBe('');
    console.log('SYNTHETIC_EVENT same-epoch-change reason=revocation-state-mismatch outcome=denied');
    anchor(8, [hash]); expect(provision(8).exitCode).toBe(0);
    expect(() => authorizeSignedRecipe(envelope)).toThrow('recipe epoch: recipe-revoked-by-anchor');
    expect((await dispatchSignedRecipe('sample', 5000)).outcome).toBe('denied');
    console.log('SYNTHETIC_EVENT revoke epoch=8 reason=recipe-revoked-by-anchor outcome=denied');
    anchor(9);
    expect(() => authorizeSignedRecipe(envelope)).toThrow('recipe epoch: epoch-mismatch');
    expect((await dispatchSignedRecipe('sample', 5000)).outcome).toBe('denied');
    console.log('SYNTHETIC_EVENT anchor-advance anchor=9 highwater=8 reason=epoch-mismatch outcome=denied');
    expect(provision(9).exitCode).toBe(0);
    expect(() => authorizeSignedRecipe(envelope)).toThrow('recipe epoch mismatch');
    expect((await dispatchSignedRecipe('sample', 5000)).outcome).toBe('denied');
    console.log('SYNTHETIC_EVENT highwater-advance anchor=9 highwater=9 recipe=7 reason=recipe-epoch-mismatch outcome=denied');
    const entries = readFileSync(join(home, 'nexus', 'runshell-recipes', 'executions.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ phase: 'start', recipeId: 'sample', epoch: 7 });
    expect(entries[1]).toMatchObject({ phase: 'finish', outcome: 'exit', exitCode: 0 });
    console.log('SYNTHETIC_EVENT audit starts=1 finishes=1 denied-spawns=0');
  } finally {
    setTestStateRoot(null);
    if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previousState;
    rmSync(trustPath, { force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
