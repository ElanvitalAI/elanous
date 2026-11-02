import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface CacheRecord<T> {
  version: 1;
  key: string;
  source: string;
  expiresAt: number;
  value: T;
}

const MAX_CACHE_FILES = 128;

/** Keep per-state cache storage bounded; remove expired/corrupt entries first, then oldest files. */
function pruneCacheRoot(root: string, now: number): void {
  try {
    const names = readdirSync(root).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
    if (names.length <= MAX_CACHE_FILES) return;
    const entries: Array<{ path: string; mtimeMs: number }> = [];
    for (const name of names) {
      const path = join(root, name);
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) continue;
        const record = JSON.parse(readFileSync(path, 'utf8')) as Partial<CacheRecord<unknown>>;
        if (record.version !== 1 || typeof record.expiresAt !== 'number' || record.expiresAt <= now) {
          unlinkSync(path);
          continue;
        }
        entries.push({ path, mtimeMs: stat.mtimeMs });
      } catch { try { unlinkSync(path); } catch { /* best-effort cleanup */ } }
    }
    entries.sort((left, right) => left.mtimeMs - right.mtimeMs);
    while (entries.length > MAX_CACHE_FILES) {
      const oldest = entries.shift();
      if (!oldest) break;
      try { unlinkSync(oldest.path); } catch { /* best-effort cleanup */ }
    }
  } catch { /* cache maintenance must not change the read result */ }
}

function sourceVersion(paths: readonly string[]): string | undefined {
  const rows: Array<{ path: string; missing?: true; dev?: string; ino?: string; size?: string; mtimeNs?: string; ctimeNs?: string }> = [];
  for (const [index, path] of paths.entries()) {
    try {
      const stat = statSync(path, { bigint: true });
      rows.push({ path, dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size),
        mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) });
    } catch (error) {
      // First path is the authoritative store; later paths (such as SQLite WAL) are optional,
      // but their appearance/disappearance still changes the source version.
      const code = (error as NodeJS.ErrnoException).code;
      if (index === 0 || code !== 'ENOENT') return undefined;
      rows.push({ path, missing: true });
    }
  }
  return JSON.stringify(rows);
}

function readCached<T>(path: string, key: string, source: string, now: number): T | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return undefined;
    const record = JSON.parse(readFileSync(path, 'utf8')) as CacheRecord<T>;
    if (record.version === 1 && record.key === key && record.source === source && record.expiresAt > now) return record.value;
  } catch { /* corrupt, absent, or unsafe cache entries are misses */ }
  return undefined;
}

function writeCached<T>(root: string, path: string, key: string, source: string, value: T, ttlMs: number, now: number): void {
  try {
    const name = createHash('sha256').update(key).digest('hex');
    const temporary = join(root, `.${name}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, key, source,
        expiresAt: now + Math.max(0, ttlMs), value } satisfies CacheRecord<T>), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, path);
    } finally {
      try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* best-effort cleanup */ }
    }
  } catch { /* cache failure must not change the read result */ }
  pruneCacheRoot(root, now);
}

function prepareRoot(root: string): boolean {
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const rootStat = lstatSync(root);
    return rootStat.isDirectory() && !rootStat.isSymbolicLink() && (rootStat.mode & 0o077) === 0;
  } catch { return false; }
}

/** Short cross-process JSON cache. Missing or changing sources always use the live reader. */
export function readQueryCache<T>(input: {
  root: string;
  key: unknown;
  sourcePaths: readonly string[];
  ttlMs: number;
  load: () => T;
  now?: () => number;
}): T {
  const now = input.now ?? Date.now;
  const serializedKey = JSON.stringify(input.key);
  const key = createHash('sha256').update(serializedKey).digest('hex');
  const path = join(input.root, `${key}.json`);
  if (!prepareRoot(input.root)) return input.load();
  const before = sourceVersion(input.sourcePaths);
  if (before !== undefined) {
    const cached = readCached<T>(path, serializedKey, before, now());
    if (cached !== undefined) return cached;
  }

  const value = input.load();
  const after = sourceVersion(input.sourcePaths);
  if (before === undefined || after !== before) return value;
  writeCached(input.root, path, serializedKey, after, value, input.ttlMs, now());
  return value;
}
