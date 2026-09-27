import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, closeSync, constants, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dlopen, FFIType } from 'bun:ffi';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { issueIngestToken, listIngestTokens, matchIngestToken, revokeIngestToken } from './ingest-token.js';

// flock's library differs per platform (the store picks the same way — see LIBC_CANDIDATES).
const LIBC = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ingest-token-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

test('issue persists only SHA-256 hashes to a private file, list never reveals credentials', () => {
  const issued = issueIngestToken('provider-a', root);
  const path = join(root, 'nexus', 'ingest-tokens.json');
  const raw = readFileSync(path, 'utf8');
  const stored = JSON.parse(raw) as { tokens: Array<{ name: string; hash: string; createdAt: string }> };
  expect(issued.token.length).toBeGreaterThanOrEqual(32);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(stored.tokens).toEqual([{ name: 'provider-a', hash: createHash('sha256').update(issued.token).digest('hex'), createdAt: issued.createdAt }]);
  expect(raw).not.toContain(issued.token);
  expect(JSON.stringify(listIngestTokens(root))).not.toContain(issued.token);
  expect(listIngestTokens(root)).toEqual([{ name: 'provider-a', createdAt: issued.createdAt }]);
});

test('match checks a bearer digest and revoke immediately disables it without disturbing others', () => {
  const first = issueIngestToken('first', root);
  const second = issueIngestToken('second', root);
  expect(first.token).not.toBe(second.token);
  expect(matchIngestToken(first.token, root)).toEqual({ name: 'first', createdAt: first.createdAt });
  expect(matchIngestToken(second.token, root)).toEqual({ name: 'second', createdAt: second.createdAt });
  expect(matchIngestToken('no-match', root)).toBeNull();
  expect(matchIngestToken('', root)).toBeNull();
  expect(revokeIngestToken('first', root)).toBe(true);
  expect(matchIngestToken(first.token, root)).toBeNull();
  expect(matchIngestToken(second.token, root)?.name).toBe('second');
  expect(revokeIngestToken('first', root)).toBe(false);
  expect(statSync(join(root, 'nexus', 'ingest-tokens.json')).mode & 0o777).toBe(0o600);
});

test('duplicate and invalid names fail before changing the store', () => {
  const first = issueIngestToken('first', root);
  const path = join(root, 'nexus', 'ingest-tokens.json');
  const before = readFileSync(path, 'utf8');
  expect(() => issueIngestToken('first', root)).toThrow();
  for (const bad of ['', '../escape', 'with space', 'x'.repeat(65)]) {
    expect(() => issueIngestToken(bad, root)).toThrow();
  }
  expect(readFileSync(path, 'utf8')).toBe(before);
  expect(matchIngestToken(first.token, root)?.name).toBe('first');
});

test('separate issuers preserve all concurrent writes', async () => {
  const moduleUrl = new URL('./ingest-token.ts', import.meta.url).href;
  const children = Array.from({ length: 12 }, (_, index) => Bun.spawn(
    ['bun', '-e', `import { issueIngestToken } from ${JSON.stringify(moduleUrl)}; issueIngestToken('worker-' + process.env.WORKER, process.env.ROOT);`],
    { env: { ...process.env, ROOT: root, WORKER: String(index) }, stdout: 'pipe', stderr: 'pipe' },
  ));
  const exits = await Promise.all(children.map((child) => child.exited));
  expect(exits).toEqual(Array(12).fill(0));
  expect(listIngestTokens(root).map((entry) => entry.name).sort()).toEqual(
    Array.from({ length: 12 }, (_, index) => `worker-${index}`).sort(),
  );
});

test('revocation cannot be undone by a concurrent issuer in another process', async () => {
  const revoked = issueIngestToken('revoked', root);
  const moduleUrl = new URL('./ingest-token.ts', import.meta.url).href;
  const lock = join(root, 'nexus', '.ingest-tokens.lock');
  const fd = openSync(lock, constants.O_RDWR | constants.O_NOFOLLOW);
  const libc = dlopen(LIBC, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
  expect(libc.symbols.flock(fd, 2 | 4)).toBe(0);
  const children = [
    Bun.spawn(['bun', '-e', `import { issueIngestToken } from ${JSON.stringify(moduleUrl)}; issueIngestToken('other', process.env.ROOT);`],
      { env: { ...process.env, ROOT: root }, stdout: 'pipe', stderr: 'pipe' }),
    Bun.spawn(['bun', '-e', `import { revokeIngestToken } from ${JSON.stringify(moduleUrl)}; if (!revokeIngestToken('revoked', process.env.ROOT)) process.exit(1);`],
      { env: { ...process.env, ROOT: root }, stdout: 'pipe', stderr: 'pipe' }),
  ];
  try {
    await Bun.sleep(250);
    expect(children.every((child) => child.exitCode === null)).toBe(true);
  } finally {
    libc.symbols.flock(fd, 8);
    closeSync(fd);
    libc.close();
  }
  expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0]);
  expect(matchIngestToken(revoked.token, root)).toBeNull();
  expect(listIngestTokens(root).map((entry) => entry.name)).toEqual(['other']);
});

test('a killed lock owner cannot prevent revocation', async () => {
  const issued = issueIngestToken('revoked', root);
  const lock = join(root, 'nexus', '.ingest-tokens.lock');
  const child = Bun.spawn(['bun', '-e', `import { openSync } from 'node:fs'; import { dlopen, FFIType } from 'bun:ffi';
    const fd = openSync(process.env.LOCK, 'r+');
    const libc = dlopen(process.env.LIBC, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
    if (libc.symbols.flock(fd, 2) !== 0) process.exit(1);
    console.log('locked');
    await new Promise(() => {});`], {
    env: { ...process.env, LOCK: lock, LIBC }, stdout: 'pipe', stderr: 'pipe',
  });
  try {
    const reader = child.stdout.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain('locked');
    expect(child.exitCode).toBeNull();
  } finally {
    child.kill('SIGKILL');
    await child.exited;
  }
  expect(existsSync(lock)).toBe(true);
  expect(revokeIngestToken('revoked', root)).toBe(true);
  expect(matchIngestToken(issued.token, root)).toBeNull();
});

test('missing store is empty; malformed or world-readable stores fail closed', () => {
  const path = join(root, 'nexus', 'ingest-tokens.json');
  expect(listIngestTokens(root)).toEqual([]);
  expect(matchIngestToken('anything', root)).toBeNull();
  expect(revokeIngestToken('missing', root)).toBe(false);
  expect(existsSync(path)).toBe(false);
  const issued = issueIngestToken('test', root);
  chmodSync(path, 0o644);
  expect(() => matchIngestToken(issued.token, root)).toThrow();
  expect(() => issueIngestToken('new', root)).toThrow();
  chmodSync(path, 0o600);
  writeFileSync(path, '{broken json', { mode: 0o600 });
  expect(() => matchIngestToken(issued.token, root)).toThrow();
});
