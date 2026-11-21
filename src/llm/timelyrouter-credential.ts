import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const FILE = 'timelyrouter_credential.json';

function cachePath(dir?: string): string {
  return join(dir ?? process.env.ELANOUS_KEY_CACHE_DIR?.trim() ?? join(homedir(), '.cache'), FILE);
}

export function timelyRouterBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('timelyrouter baseUrl invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('timelyrouter baseUrl must be an HTTPS API origin/path without credentials or query');
  }
  return url.toString().replace(/\/+$/, '');
}

/** One atomic file binds the key to the exact API base URL checked during setup. */
export function saveTimelyRouterCredential(apiKey: string, baseUrl: string, dir?: string): void {
  const key = apiKey.trim();
  if (!key || key.includes('\0')) throw new Error('timelyrouter key invalid');
  const endpoint = timelyRouterBaseUrl(baseUrl);
  const path = cachePath(dir);
  const parent = dir ?? process.env.ELANOUS_KEY_CACHE_DIR?.trim() ?? join(homedir(), '.cache');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!lstatSync(parent).isDirectory()) throw new Error('timelyrouter cache directory invalid');
  const temp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const fd = openSync(temp, 'wx', 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, JSON.stringify({ version: 1, baseUrl: endpoint, apiKey: key }));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}

function cachedPair(dir?: string): { baseUrl: string; apiKey: string } | undefined {
  const path = cachePath(dir);
  let fd: number;
  // Open without waiting for a FIFO writer, then validate the opened inode before reading.
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error('timelyrouter credential file unsafe');
    throw new Error('timelyrouter credential lookup failed');
  }
  let value: unknown;
  try {
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    if (!stat.isFile() || uid === undefined || stat.uid !== uid || stat.size > 8192 || (stat.mode & 0o077) !== 0) {
      throw new Error('timelyrouter credential file unsafe');
    }
    value = JSON.parse(readFileSync(fd, 'utf8'));
  } catch (error) {
    if (error instanceof Error && error.message === 'timelyrouter credential file unsafe') throw error;
    throw new Error('timelyrouter credential read failed');
  } finally { closeSync(fd); }
  if (!value || typeof value !== 'object') throw new Error('timelyrouter credential format invalid');
  const pair = value as Record<string, unknown>;
  if (pair.version !== 1 || typeof pair.baseUrl !== 'string' || typeof pair.apiKey !== 'string' || !pair.apiKey.trim()) {
    throw new Error('timelyrouter credential format invalid');
  }
  return { baseUrl: timelyRouterBaseUrl(pair.baseUrl), apiKey: pair.apiKey };
}

/** An old key is never sent after the configured URL changes. Returning to the old URL restores it. */
export function timelyRouterApiKeyFor(baseUrl?: string, env: NodeJS.ProcessEnv = process.env, dir?: string): string | undefined {
  const wanted = baseUrl?.trim() || env.TIMELYROUTER_BASE_URL?.trim();
  const pair = cachedPair(dir);
  if (!wanted) return undefined;
  const endpoint = timelyRouterBaseUrl(wanted);
  if (pair) return pair.baseUrl === endpoint ? pair.apiKey : undefined;
  const envEndpoint = env.TIMELYROUTER_BASE_URL?.trim();
  return envEndpoint && timelyRouterBaseUrl(envEndpoint) === endpoint ? env.TIMELYROUTER_API_KEY?.trim() || undefined : undefined;
}

export function hasTimelyRouterCredential(dir?: string): boolean {
  return cachedPair(dir) !== undefined;
}
