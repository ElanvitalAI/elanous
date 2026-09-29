import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dlopen, FFIType } from 'bun:ffi';
import { effectiveInstanceRoot } from '../instance/resolve.js';

type PatInfo = { name: string; createdAt: string; expiresAt: string | null };
type StoredPat = PatInfo & { hash: string };
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const directory = (root: string) => join(root, 'mcp-gateway');
const file = (root: string) => join(directory(root), 'pats.json');

function read(root: string): StoredPat[] {
  let raw: string;
  try {
    const stat = lstatSync(file(root));
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('PAT store must be a private regular file');
    raw = readFileSync(file(root), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !('tokens' in value) || !Array.isArray(value.tokens)
    || !value.tokens.every((row: unknown) => row && typeof row === 'object' && !Array.isArray(row) && Object.keys(row).length === 4
      && 'name' in row && typeof row.name === 'string' && NAME.test(row.name)
      && 'hash' in row && typeof row.hash === 'string' && HASH.test(row.hash)
      && 'createdAt' in row && typeof row.createdAt === 'string' && Number.isFinite(Date.parse(row.createdAt))
      && 'expiresAt' in row && (row.expiresAt === null || (typeof row.expiresAt === 'string' && Number.isFinite(Date.parse(row.expiresAt)))))) {
    throw new Error('invalid PAT store');
  }
  const tokens = value.tokens as StoredPat[];
  if (new Set(tokens.map((row) => row.name)).size !== tokens.length) throw new Error('duplicate PAT names');
  return tokens;
}

function locked<T>(root: string, action: () => T): T {
  mkdirSync(directory(root), { recursive: true, mode: 0o700 });
  const fd = openSync(join(directory(root), '.pats.lock'), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  let lib: ReturnType<typeof dlopen> | undefined;
  let flock: ((fd: number, op: number) => number) | undefined;
  let acquired = false;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('PAT lock must be private');
    const libc = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : process.platform === 'linux' ? 'libc.so.6' : null;
    if (!libc) throw new Error('PAT locking unavailable on this platform');
    lib = dlopen(libc, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
    flock = (fd, op) => (lib!.symbols.flock as unknown as (fd: number, op: number) => number)(fd, op);
    const deadline = Date.now() + 10_000;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    while (flock(fd, 2 | 4) !== 0) {
      if (Date.now() >= deadline) throw new Error('timed out waiting for PAT lock');
      Atomics.wait(pause, 0, 0, 10);
    }
    acquired = true;
    return action();
  } finally {
    if (acquired) flock!(fd, 8);
    closeSync(fd);
    lib?.close();
  }
}

function write(root: string, tokens: StoredPat[]): void {
  try {
    const stat = lstatSync(file(root));
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('PAT store must be private');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = join(directory(root), `.pats-${randomBytes(16).toString('hex')}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try { writeFileSync(fd, JSON.stringify({ tokens }, null, 2) + '\n'); }
    finally { closeSync(fd); }
    renameSync(temporary, file(root));
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* already renamed */ }
    throw error;
  }
}

export function issueMcpPat(name: string, options: { expiresDays?: number } = {}, root: string = effectiveInstanceRoot()): PatInfo & { token: string } {
  if (!NAME.test(name)) throw new Error('invalid PAT name');
  const days = options.expiresDays;
  if (days !== undefined && (!Number.isSafeInteger(days) || days <= 0 || Date.now() + days * 86_400_000 > 8.64e15)) throw new Error('invalid PAT expiration');
  return locked(root, () => {
    const tokens = read(root);
    if (tokens.some((row) => row.name === name)) throw new Error('PAT name already exists');
    const token = randomBytes(32).toString('base64url');
    const createdAt = new Date().toISOString();
    const expiresAt = days === undefined ? null : new Date(Date.now() + days * 86_400_000).toISOString();
    write(root, [...tokens, { name, hash: createHash('sha256').update(token).digest('hex'), createdAt, expiresAt }]);
    return { name, token, createdAt, expiresAt };
  });
}

export function listMcpPats(root: string = effectiveInstanceRoot()): PatInfo[] {
  return read(root).map(({ name, createdAt, expiresAt }) => ({ name, createdAt, expiresAt }));
}

export function revokeMcpPat(name: string, root: string = effectiveInstanceRoot()): boolean {
  return locked(root, () => {
    const tokens = read(root);
    const remaining = tokens.filter((row) => row.name !== name);
    if (remaining.length === tokens.length) return false;
    write(root, remaining);
    return true;
  });
}

export function matchMcpPat(token: string, now: number = Date.now(), root: string = effectiveInstanceRoot()): PatInfo | null {
  if (typeof token !== 'string' || !token) return null;
  const digest = createHash('sha256').update(token).digest();
  let found: PatInfo | null = null;
  for (const row of read(root)) {
    if (timingSafeEqual(digest, Buffer.from(row.hash, 'hex')) && (row.expiresAt === null || Date.parse(row.expiresAt) > now)) {
      found = { name: row.name, createdAt: row.createdAt, expiresAt: row.expiresAt };
    }
  }
  return found;
}
