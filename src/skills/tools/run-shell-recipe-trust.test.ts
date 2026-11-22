import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRecipeTrustAnchor, type RecipeTrustAnchor } from './run-shell-recipe-trust.js';

const owner = process.getuid?.() ?? 0;
const publicKeyPem = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
const anchor: RecipeTrustAnchor = { schema: 1, epoch: 1, publicKeyPem, retired: false, revokedRecipeHashes: [] };

test('trust anchor accepts only a regular file owned by the expected authority', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recipe-trust-'));
  const path = join(dir, 'trust.json');
  writeFileSync(path, JSON.stringify(anchor), { mode: 0o644 });
  expect(readRecipeTrustAnchor(path, owner)).toEqual({ ok: true, anchor });
  expect(readRecipeTrustAnchor(path, owner + 1)).toEqual({ ok: false, reason: 'unsafe-trust-anchor' });
  const link = join(dir, 'link');
  symlinkSync(path, link);
  expect(readRecipeTrustAnchor(link, owner)).toEqual({ ok: false, reason: 'trust-anchor-read-failed' });
  const fifo = join(dir, 'pipe');
  execFileSync('mkfifo', [fifo]);
  expect(readRecipeTrustAnchor(fifo, owner)).toEqual({ ok: false, reason: 'unsafe-trust-anchor' });
});

test('trust anchor fails closed on missing, malformed, weak keys and duplicate revocations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recipe-trust-bad-'));
  const path = join(dir, 'trust.json');
  expect(readRecipeTrustAnchor(path, owner)).toEqual({ ok: false, reason: 'missing-trust-anchor' });
  writeFileSync(path, 'not json', { mode: 0o600 });
  expect(readRecipeTrustAnchor(path, owner)).toEqual({ ok: false, reason: 'invalid-trust-anchor' });
  writeFileSync(path, JSON.stringify({ ...anchor, publicKeyPem: 'bad' }));
  expect(readRecipeTrustAnchor(path, owner)).toEqual({ ok: false, reason: 'invalid-trust-key' });
  writeFileSync(path, JSON.stringify({ ...anchor, revokedRecipeHashes: ['a'.repeat(64), 'a'.repeat(64)] }));
  expect(readRecipeTrustAnchor(path, owner)).toEqual({ ok: false, reason: 'invalid-trust-anchor' });
});
