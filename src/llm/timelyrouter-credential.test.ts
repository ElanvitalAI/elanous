import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveTimelyRouterCredential, timelyRouterApiKeyFor } from './timelyrouter-credential.js';

test('TimelyRouter cached key stays with its verified URL and recovers when restored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timelyrouter-cred-'));
  const original = 'https://timely.mock.invalid/v1';
  const changed = 'https://other.mock.invalid/v1';
  try {
    saveTimelyRouterCredential('original-key', original, dir);
    const env = { TIMELYROUTER_API_KEY: 'env-key', TIMELYROUTER_BASE_URL: changed };
    expect(timelyRouterApiKeyFor(original, env, dir)).toBe('original-key');
    expect(timelyRouterApiKeyFor(changed, env, dir)).toBeUndefined();
    expect(timelyRouterApiKeyFor(original, env, dir)).toBe('original-key');
    const path = join(dir, 'timelyrouter_credential.json');
    chmodSync(path, 0o644);
    expect(() => timelyRouterApiKeyFor(changed, env, dir)).toThrow(/unsafe/);
    chmodSync(path, 0o600);
    writeFileSync(path, '{bad json');
    expect(() => timelyRouterApiKeyFor(changed, env, dir)).toThrow(/read failed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('TimelyRouter cache refuses FIFO before a blocking read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timelyrouter-fifo-'));
  try {
    const path = join(dir, 'timelyrouter_credential.json');
    expect(spawnSync('mkfifo', [path]).status).toBe(0);
    const script = `import { timelyRouterApiKeyFor } from ${JSON.stringify(new URL('./timelyrouter-credential.ts', import.meta.url).href)}; try { timelyRouterApiKeyFor('https://timely.mock.invalid/v1', {}, ${JSON.stringify(dir)}); process.exit(2); } catch (error) { if (!String(error).includes('unsafe')) process.exit(3); }`;
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 1500 });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('TimelyRouter cache refuses an FD owned by another UID', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timelyrouter-owner-'));
  const oldGetuid = process.getuid;
  try {
    saveTimelyRouterCredential('local-key', 'https://timely.mock.invalid/v1', dir);
    if (!oldGetuid) throw new Error('Unix UID test required');
    process.getuid = () => oldGetuid() + 1;
    expect(() => timelyRouterApiKeyFor('https://timely.mock.invalid/v1', {}, dir)).toThrow(/unsafe/);
  } finally { process.getuid = oldGetuid; rmSync(dir, { recursive: true, force: true }); }
});

test('TimelyRouter cache refuses a symlink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timelyrouter-link-'));
  const path = join(dir, 'timelyrouter_credential.json');
  try {
    const target = join(dir, 'target.json');
    writeFileSync(target, JSON.stringify({ version: 1, baseUrl: 'https://timely.mock.invalid/v1', apiKey: 'other-key' }), { mode: 0o600 });
    symlinkSync(target, path);
    expect(() => timelyRouterApiKeyFor('https://timely.mock.invalid/v1', {}, dir)).toThrow(/unsafe/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
