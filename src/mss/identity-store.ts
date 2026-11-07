// Machine-stable identity persistence. ULID encoding lives in the pure module.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { newUlid } from './ulid.js';

interface IdentityFile {
  elanous_id: string;
  created_at: string;
  schema_version: 1;
}

/** Test override — set to a tmpfile path to isolate from `~/.elanous/`. */
let overrideFile: string | null = null;
let cached: string | null = null;

const DEFAULT_IDENTITY_FILE = join(homedir(), '.elanous', 'identity.json');

function identityPath(): string {
  return overrideFile ?? DEFAULT_IDENTITY_FILE;
}

/** Returns the machine-stable elanous ULID. First call persists
 *  `~/.elanous/identity.json` atomically (tmp + rename); subsequent calls
 *  read the in-process cache. Corrupt or missing file triggers regeneration. */
export function getOrCreateElanousId(): string {
  if (cached) return cached;
  const path = identityPath();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as IdentityFile;
    if (typeof parsed?.elanous_id === 'string' && parsed.elanous_id.length === 26) {
      cached = parsed.elanous_id;
      return cached;
    }
  } catch { /* missing or corrupt — regenerate */ }

  const id = newUlid();
  const payload: IdentityFile = {
    elanous_id: id,
    created_at: new Date().toISOString(),
    schema_version: 1,
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  } catch { /* readonly home — keep in-memory only */ }
  cached = id;
  return cached;
}

/** Test-only — drop in-memory cache. */
export function __resetIdentityForTests(): void {
  cached = null;
}

/** Test-only — redirect persistence to a sandbox file (pass null to reset). */
export function __setIdentityFileForTests(filePath: string | null): void {
  overrideFile = filePath;
  cached = null;
}
