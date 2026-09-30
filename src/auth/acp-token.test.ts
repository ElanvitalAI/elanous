import { afterEach, describe, expect, test } from 'bun:test';
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureAuthToken } from './acp-token.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acp-token-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('ensureAuthToken', () => {
  test('preserves an existing token file and returns its trimmed contents', () => {
    const dir = tempDir();
    const path = join(dir, 'acp-token');
    writeFileSync(path, 'existing-token\n', { mode: 0o640 });

    expect(ensureAuthToken(dir)).toEqual({ token: 'existing-token', path });
    expect(readFileSync(path, 'utf8')).toBe('existing-token\n');
    expect(lstatSync(path).mode & 0o777).toBe(0o640);
  });

  test('creates a missing token in the config directory with mode 0600 and reuses it', () => {
    const dir = join(tempDir(), 'nested');
    const first = ensureAuthToken(dir);

    expect(first.path).toBe(join(dir, 'acp-token'));
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readFileSync(first.path, 'utf8')).toBe(first.token);
    expect(lstatSync(first.path).mode & 0o777).toBe(0o600);
    expect(ensureAuthToken(dir)).toEqual(first);
  });

  test('propagates a failed token creation without exposing the generated token', () => {
    const dir = tempDir();
    const missingParent = join(dir, 'missing');
    symlinkSync(join(missingParent, 'token'), join(dir, 'acp-token'));

    let error: unknown;
    try { ensureAuthToken(dir); } catch (err) { error = err; }
    expect(error).toBeDefined();
    expect((error as NodeJS.ErrnoException).code).toBe('ENOENT');
    expect(String(error)).not.toMatch(/[A-Za-z0-9_-]{43}/);
    expect(lstatSync(join(dir, 'acp-token')).isSymbolicLink()).toBe(true);
  });
});
