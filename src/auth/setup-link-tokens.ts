import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dlopen, FFIType } from 'bun:ffi';
import { getElanousConfigDir } from '../elanous-config-dir.js';

export const SETUP_LINK_TTL_MS = 10 * 60_000;
const SETUP_BEARER_TTL_MS = 24 * 60 * 60_000;
const LINK_PREFIX = 'els_';
const BEARER_PREFIX = 'elsb_';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const LINK_PATTERN = /^els_[A-Za-z0-9_-]{43}$/;
const BEARER_PATTERN = /^elsb_[A-Za-z0-9_-]{43}$/;

interface SetupLinkEntry {
  hash: string;
  expiresAt: string;
  usedAt?: string;
  bearerHash?: string;
  bearerExpiresAt?: string;
}

type ClaimResult =
  | { ok: true; bearer: string; expiresAt: string }
  | { ok: false; reason: 'unknown' | 'used' | 'expired' };

function storePath(dir: string): string { return join(dir, 'setup-link-tokens.json'); }
function hashOf(token: string): string { return createHash('sha256').update(token).digest('hex'); }
function mint(prefix: string): string { return `${prefix}${randomBytes(32).toString('base64url')}`; }

function readStore(dir: string): SetupLinkEntry[] {
  let raw: string;
  try {
    const path = storePath(dir);
    const st = lstatSync(path);
    if (!st.isFile() || (st.mode & 0o077) !== 0) throw new Error('setup link store must be a private regular file (0600)');
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || !('tokens' in parsed) || !Array.isArray(parsed.tokens)) {
    throw new Error('setup link store is malformed');
  }
  const entries: unknown[] = parsed.tokens;
  if (!entries.every((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const t = entry as Partial<SetupLinkEntry>;
    return typeof t.hash === 'string' && HASH_PATTERN.test(t.hash)
      && typeof t.expiresAt === 'string' && Number.isFinite(Date.parse(t.expiresAt))
      && (t.usedAt === undefined || (typeof t.usedAt === 'string' && Number.isFinite(Date.parse(t.usedAt))))
      && (t.bearerHash === undefined || (typeof t.bearerHash === 'string' && HASH_PATTERN.test(t.bearerHash)))
      && (t.bearerExpiresAt === undefined || (typeof t.bearerExpiresAt === 'string' && Number.isFinite(Date.parse(t.bearerExpiresAt))))
      && ((t.usedAt === undefined && t.bearerHash === undefined && t.bearerExpiresAt === undefined)
        || (t.usedAt !== undefined && t.bearerHash !== undefined && t.bearerExpiresAt !== undefined));
  })) throw new Error('setup link store is malformed');
  return entries as SetupLinkEntry[];
}

function writeStore(dir: string, tokens: SetupLinkEntry[]): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = storePath(dir);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ tokens }, null, 2), { flag: 'wx', mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    try { unlinkSync(tmp); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

// A persistent inode and an OS advisory lock avoid stale owner files after an abrupt process exit.
// Never unlink this file: a replacement inode would let two processes hold different locks.
// Loaded on first use, not at import: libc.so.6 does not exist on Windows and this module sits on the CLI start path (WIN2 10-02).
type Flock = (fd: number, op: number) => number;
let flockFn: Flock | null | undefined;
function osFlock(): Flock | null {
  if (flockFn !== undefined) return flockFn;
  if (process.platform === 'win32') return (flockFn = null);
  const lib = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  return (flockFn = lib.symbols.flock as Flock);
}
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

function withLock<T>(dir: string, fn: () => T): T {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const flock = osFlock();
  // Windows: no advisory flock and no POSIX modes — the store still writes by atomic rename.
  if (!flock) return fn();
  const lock = `${storePath(dir)}.lock`;
  const fd = openSync(lock, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    const current = lstatSync(lock);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.ino !== current.ino || stat.dev !== current.dev) {
      throw new Error('setup link lock must be a private regular file (0600)');
    }
    const until = Date.now() + 3000;
    while (flock(fd, LOCK_EX | LOCK_NB) !== 0) {
      if (Date.now() > until) throw new Error('setup link store is locked — try again');
      Bun.sleepSync(20);
    }
    try {
      const locked = lstatSync(lock);
      if (stat.ino !== locked.ino || stat.dev !== locked.dev) throw new Error('setup link lock changed');
      return fn();
    } finally {
      flock(fd, LOCK_UN);
    }
  } finally {
    closeSync(fd);
  }
}

/** The plaintext link token is returned once; only its SHA-256 digest is persisted. */
export function issueSetupLinkToken(opts: { dir?: string; now?: number } = {}): { token: string; expiresAt: string } {
  const dir = opts.dir ?? getElanousConfigDir();
  const now = opts.now ?? Date.now();
  const token = mint(LINK_PREFIX);
  const expiresAt = new Date(now + SETUP_LINK_TTL_MS).toISOString();
  withLock(dir, () => writeStore(dir, [...readStore(dir), { hash: hashOf(token), expiresAt }]));
  return { token, expiresAt };
}

/** Claim exactly once under the same lock used by issuance. Expired and used links retain their diagnostic status. */
export function claimSetupLinkToken(token: string, opts: { dir?: string; now?: number } = {}): ClaimResult {
  if (typeof token !== 'string' || !LINK_PATTERN.test(token)) return { ok: false, reason: 'unknown' };
  const dir = opts.dir ?? getElanousConfigDir();
  const now = opts.now ?? Date.now();
  return withLock(dir, () => {
    const entries = readStore(dir);
    const digest = Buffer.from(hashOf(token), 'hex');
    const hit = entries.find((entry) => timingSafeEqual(digest, Buffer.from(entry.hash, 'hex')));
    if (!hit) return { ok: false, reason: 'unknown' };
    if (hit.usedAt) return { ok: false, reason: 'used' };
    if (Date.parse(hit.expiresAt) <= now) return { ok: false, reason: 'expired' };
    const bearer = mint(BEARER_PREFIX);
    const expiresAt = new Date(now + SETUP_BEARER_TTL_MS).toISOString();
    hit.usedAt = new Date(now).toISOString();
    hit.bearerHash = hashOf(bearer);
    hit.bearerExpiresAt = expiresAt;
    writeStore(dir, entries);
    return { ok: true, bearer, expiresAt };
  });
}

/** A setup bearer is not an owner or temp-owner token; validate it only on setup-allowed routes. */
export function matchSetupBearer(bearer: string, opts: { dir?: string; now?: number } = {}): { expiresAt: string } | null {
  if (typeof bearer !== 'string' || !BEARER_PATTERN.test(bearer)) return null;
  let entries: SetupLinkEntry[];
  try { entries = readStore(opts.dir ?? getElanousConfigDir()); } catch { return null; }
  const digest = Buffer.from(hashOf(bearer), 'hex');
  const now = opts.now ?? Date.now();
  const hit = entries.find((entry) => entry.bearerHash && entry.bearerExpiresAt
    && timingSafeEqual(digest, Buffer.from(entry.bearerHash, 'hex')) && Date.parse(entry.bearerExpiresAt) > now);
  return hit?.bearerExpiresAt ? { expiresAt: hit.bearerExpiresAt } : null;
}
