import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { withPrivateFileLock } from './private-file-lock.js';

interface StoredIngestToken {
  name: string;
  hash: string;
  createdAt: string;
}

export interface IngestTokenInfo {
  name: string;
  createdAt: string;
}

export interface IssuedIngestToken extends IngestTokenInfo {
  token: string;
}

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function tokenFile(root: string): string {
  return join(root, 'nexus', 'ingest-tokens.json');
}

function readTokens(root: string): StoredIngestToken[] {
  const path = tokenFile(root);
  let contents: string;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('ingest token store must be a private regular file');
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const parsed: unknown = JSON.parse(contents);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).length !== 1 || !('tokens' in parsed) || !Array.isArray(parsed.tokens)
    || !parsed.tokens.every((item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
      && Object.keys(item).length === 3
      && 'name' in item && typeof item.name === 'string' && NAME_PATTERN.test(item.name)
      && 'hash' in item && typeof item.hash === 'string' && HASH_PATTERN.test(item.hash)
      && 'createdAt' in item && typeof item.createdAt === 'string')) {
    throw new Error('invalid ingest token store');
  }
  const tokens = parsed.tokens as StoredIngestToken[];
  if (new Set(tokens.map((item) => item.name)).size !== tokens.length) throw new Error('duplicate ingest token names in store');
  return tokens;
}

function withTokenStoreLock<T>(root: string, update: () => T): T {
  const directory = join(root, 'nexus');
  return withPrivateFileLock(join(directory, '.ingest-tokens.lock'), update, 'nexus.ingest-token');
}

function writeTokens(root: string, tokens: StoredIngestToken[]): void {
  const directory = join(root, 'nexus');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = tokenFile(root);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('ingest token store must be a private regular file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = join(directory, `.ingest-tokens-${randomBytes(16).toString('hex')}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, JSON.stringify({ tokens }, null, 2) + '\n');
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* already moved */ }
    throw error;
  }
}

/** The only time a raw token leaves this module is the issue return value. */
export function issueIngestToken(name: string, root: string = effectiveInstanceRoot()): IssuedIngestToken {
  if (!NAME_PATTERN.test(name)) throw new Error('ingest token name must be 1–64 ASCII letters, digits, dots, underscores or hyphens, starting with a letter or digit');
  return withTokenStoreLock(root, () => {
    const tokens = readTokens(root);
    if (tokens.some((entry) => entry.name === name)) throw new Error('ingest token name already exists');
    const token = randomBytes(32).toString('base64url');
    const createdAt = new Date().toISOString();
    const hash = createHash('sha256').update(token).digest('hex');
    writeTokens(root, [...tokens, { name, hash, createdAt }]);
    return { name, token, createdAt };
  });
}

export function revokeIngestToken(name: string, root: string = effectiveInstanceRoot()): boolean {
  return withTokenStoreLock(root, () => {
    const tokens = readTokens(root);
    const remaining = tokens.filter((entry) => entry.name !== name);
    if (remaining.length === tokens.length) return false;
    writeTokens(root, remaining);
    return true;
  });
}

export function listIngestTokens(root: string = effectiveInstanceRoot()): IngestTokenInfo[] {
  return readTokens(root).map(({ name, createdAt }) => ({ name, createdAt }));
}

/** Accept a raw bearer value (not the Authorization header). Revocation is visible on the next request. */
export function matchIngestToken(token: string, root: string = effectiveInstanceRoot()): IngestTokenInfo | null {
  if (typeof token !== 'string' || token.length === 0) return null;
  const digest = createHash('sha256').update(token).digest();
  let matched: IngestTokenInfo | null = null;
  for (const entry of readTokens(root)) {
    if (timingSafeEqual(digest, Buffer.from(entry.hash, 'hex'))) {
      matched = { name: entry.name, createdAt: entry.createdAt };
    }
  }
  return matched;
}

/** Gate helper: read `Authorization: Bearer <token>` and match it. A damaged or unreadable store denies (never throws). */
export function matchIngestAuthorization(req: Request, root: string = effectiveInstanceRoot()): IngestTokenInfo | null {
  const auth = req.headers.get('authorization');
  if (!auth || !/^Bearer [A-Za-z0-9_-]+$/.test(auth)) return null;
  try { return matchIngestToken(auth.slice('Bearer '.length), root); }
  catch { return null; }
}
