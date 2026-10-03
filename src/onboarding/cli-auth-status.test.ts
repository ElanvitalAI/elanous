import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectSkillCliAuth, type SkillCli } from './cli-auth-status.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fakePath(scripts: Partial<Record<SkillCli, string>>) {
  const path = mkdtempSync(join(tmpdir(), 'cli-auth-status-'));
  directories.push(path);
  const calls = join(path, 'calls');
  for (const [cli, body] of Object.entries(scripts)) {
    const file = join(path, cli);
    writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "${cli} $*" >> '${calls}'\n${body}\n`);
    chmodSync(file, 0o700);
  }
  return { path, calls };
}

test('fake PATH finds each CLI and invokes only its read-only status argv', () => {
  const { path, calls } = fakePath({
    gh: 'exit 0',
    gws: `printf '%s\\n' '{"auth_method":"oauth2","token_valid":true}'`,
    op: 'exit 0',
    himalaya: 'exit 0',
  });
  expect(detectSkillCliAuth({ path })).toEqual([
    { cli: 'gh', found: true, authenticated: true },
    { cli: 'gws', found: true, authenticated: true },
    { cli: 'op', found: true, authenticated: true },
    { cli: 'himalaya', found: true, authenticated: true },
  ]);
  expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual([
    'gh auth status', 'gws auth status', 'op whoami', 'himalaya account check',
  ]);
});

test('missing binaries are skipped without probing real PATH', () => {
  const { path, calls } = fakePath({ gh: 'exit 0' });
  expect(detectSkillCliAuth({ path })).toEqual([
    { cli: 'gh', found: true, authenticated: true },
    { cli: 'gws', found: false, authenticated: false, skippedReason: 'not on PATH' },
    { cli: 'op', found: false, authenticated: false, skippedReason: 'not on PATH' },
    { cli: 'himalaya', found: false, authenticated: false, skippedReason: 'not on PATH' },
  ]);
  expect(readFileSync(calls, 'utf8').trim()).toBe('gh auth status');
});

test('nonzero exit, absent gws session and unavailable status skip without leaking CLI output', () => {
  const { path } = fakePath({
    gh: `echo 'SECRET-gh-token' >&2; exit 1`,
    gws: `printf '%s\\n' '{"storage":"none","token_cache_exists":true,"secret":"SECRET-gws-token"}'`,
    op: `echo 'SECRET-op-token' >&2; exit 2`,
    himalaya: 'exit 1',
  });
  const results = detectSkillCliAuth({ path });
  expect(results.map(({ found, authenticated, skippedReason }) => ({ found, authenticated, skippedReason }))).toEqual([
    { found: true, authenticated: false, skippedReason: 'not authenticated' },
    { found: true, authenticated: false, skippedReason: 'not authenticated' },
    { found: true, authenticated: false, skippedReason: 'not authenticated' },
    { found: true, authenticated: false, skippedReason: 'not authenticated' },
  ]);
  expect(JSON.stringify(results)).not.toContain('SECRET');
  const unavailable = detectSkillCliAuth({
    path,
    runStatus: () => { throw new Error('SECRET-from-spawn'); },
  });
  expect(unavailable.every((result) => result.skippedReason === 'status check unavailable')).toBe(true);
  expect(JSON.stringify(unavailable)).not.toContain('SECRET');
});

test('gws skips expired or invalid cached credentials even when status exits zero', () => {
  // gws 0.22.5 auth status, isolated HOME with credentials.json (invalid client/refresh token)
  // and an expired token_cache.json: exit 0; auth_method=oauth2, storage=plaintext,
  // token_cache_exists=true, has_refresh_token=true, token_valid=false.
  const { path } = fakePath({ gws: `printf '%s\\n' '{"auth_method":"oauth2","storage":"plaintext","token_cache_exists":true,"has_refresh_token":true,"token_valid":false,"token_error":"The OAuth client was not found."}'` });
  const results = detectSkillCliAuth({ path });
  expect(results[1]).toEqual({ cli: 'gws', found: true, authenticated: false, skippedReason: 'not authenticated' });
  expect(detectSkillCliAuth({ path, runStatus: () => ({ status: 0, stdout: 'not JSON' }) })[1]).toEqual(results[1]);
  expect(detectSkillCliAuth({ path, runStatus: () => ({ status: 0, stdout: '{"storage":"plaintext","token_cache_exists":true}' }) })[1]).toEqual(results[1]);
});
