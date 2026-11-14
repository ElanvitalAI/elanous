import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { selectBackendFromConfig } from '../nexus/config/secrets/index.js';
import { defaultFileSealedBackend } from './credentials-migration-sealed-file-backend.js';

const first = { bundleId: '10000000-0000-4000-8000-000000000001', envelopeSha256: 'a'.repeat(64),
  staticSecrets: { exa: 'synthetic-only-value' } };

test('two empty fake destination files atomically hold static value and marker; replay checks exact state', async () => {
  for (let index = 0; index < 2; index++) {
    const root = mkdtempSync(join(tmpdir(), 'sealed-file-backend-'));
    try {
      setElanousConfigDir(root);
      selectBackendFromConfig();
      const backend = defaultFileSealedBackend();
      expect(backend).toBeDefined();
      const input = { ...first, bundleId: `10000000-0000-4000-8000-00000000000${index + 1}` };
      expect(await backend!.commitEmptyStaticBatch(input)).toBe('applied');
      const path = join(root, 'secrets.json');
      const raw = readFileSync(path, 'utf8');
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const saved = JSON.parse(raw);
      expect(saved.secrets.exa).toBe('synthetic-only-value');
      expect(saved.secrets[`migration:sealed:${input.bundleId}`]).toBe(input.envelopeSha256);
      expect(await backend!.commitEmptyStaticBatch(input)).toBe('already-applied');
      expect(await backend!.commitEmptyStaticBatch({ ...input, envelopeSha256: 'b'.repeat(64) })).toBe('conflict');
      expect(readFileSync(path, 'utf8')).toBe(raw);
    } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
  }
});

test('occupied aliases, unrelated values and partial marker state all refuse without writes', async () => {
  for (const secrets of [{ EXA_API_KEY: 'existing-synthetic' }, { unrelated: 'existing-synthetic' },
    { [`migration:sealed:${first.bundleId}`]: first.envelopeSha256 }]) {
    const root = mkdtempSync(join(tmpdir(), 'sealed-file-conflict-'));
    try {
      setElanousConfigDir(root);
      selectBackendFromConfig();
      const path = join(root, 'secrets.json');
      writeFileSync(path, JSON.stringify({ version: 1, secrets }), { mode: 0o600 });
      const before = readFileSync(path, 'utf8');
      expect(await defaultFileSealedBackend()!.commitEmptyStaticBatch(first)).toBe('conflict');
      expect(readFileSync(path, 'utf8')).toBe(before);
    } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
  }
});
