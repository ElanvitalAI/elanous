import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncTestConfig } from './config-test-sync.js';

test('sync never copies operating authentication or service credentials, including the configured test bot', () => {
  const root = mkdtempSync(join(tmpdir(), 'sync-fake-auth-'));
  const source = join(root, 'source');
  const target = join(root, 'test');
  mkdirSync(source);
  writeFileSync(join(source, 'config.json'), JSON.stringify({ telegram: { testChannel: { botToken: 'fake-real-token' } }, llm: { apiKey: 'fake-real-key' } }));
  for (const name of ['auth.json', 'secrets.json', 'llm-fallback.json']) writeFileSync(join(source, name), '{"token":"fake-real-secret"}');
  try {
    syncTestConfig(target, source);
    for (const name of ['auth.json', 'secrets.json', 'llm-fallback.json']) expect(existsSync(join(target, name))).toBe(false);
    const config = readFileSync(join(target, 'config.json'), 'utf8');
    expect(config).not.toContain('fake-real-');
    expect(JSON.parse(config).telegram.enabled).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
