import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { currentBackendId } from '../nexus/config/secrets/index.js';
import { secretsPath } from '../nexus/config/paths.js';
import { SECRETS_VERSION } from '../nexus/config/types.js';
import { acquireLockSync } from '../storage/file-lock.js';
import { assertDistinctMigrationStaticIds, isExportableMigrationStaticId, migrationStaticSlots } from './credentials-migration-bundle.js';
import type { AtomicSealedStaticBackend } from './credentials-migration-sealed.js';

const digestPattern = /^[a-f0-9]{64}$/;
const bundlePattern = /^[0-9a-f-]{36}$/;

function refuse(): never { throw new Error('SEALED_MIGRATION_FILE_BACKEND_REFUSED'); }

function readNarrowFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.() || stat.size > 8 * 1024 * 1024) refuse();
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch { refuse(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) refuse();
  const file = parsed as Record<string, unknown>;
  if (file.version !== SECRETS_VERSION || Object.keys(file).some((key) => key !== 'version' && key !== 'secrets')
    || !file.secrets || typeof file.secrets !== 'object' || Array.isArray(file.secrets)
    || Object.values(file.secrets).some((value) => typeof value !== 'string')) refuse();
  return file.secrets as Record<string, string>;
}

function commitEmptyFileBatch(input: { bundleId: string; envelopeSha256: string;
  staticSecrets: Readonly<Record<string, string>> }): 'applied' | 'already-applied' | 'conflict' {
  const entries = Object.entries(input.staticSecrets);
  if (!bundlePattern.test(input.bundleId) || !digestPattern.test(input.envelopeSha256)
    || entries.length === 0 || entries.length > 128
    || entries.some(([id, value]) => !isExportableMigrationStaticId(id)
      || migrationStaticSlots(id)?.includes('telegram') || typeof value !== 'string' || !value || value.includes('\0'))) refuse();
  try { assertDistinctMigrationStaticIds(entries.map(([id]) => id)); } catch { refuse(); }
  const marker = `migration:sealed:${input.bundleId}`;
  const expected = { ...input.staticSecrets, [marker]: input.envelopeSha256 };
  const path = secretsPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Same lock as ordinary file-backend set/delete/import. The destination must be wholly empty:
  // this stricter boundary guarantees every target alias is empty without a second policy writer.
  const release = acquireLockSync(`${path}.lock`);
  try {
    const current = readNarrowFile(path);
    if (Object.keys(current).length > 0) {
      const keys = Object.keys(expected);
      return Object.keys(current).length === keys.length
        && keys.every((key) => current[key] === expected[key]) ? 'already-applied' : 'conflict';
    }
    const temporary = `${path}.${randomUUID()}.sealed.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: SECRETS_VERSION, secrets: expected }), { mode: 0o600, flag: 'wx' });
      const fd = openSync(temporary, 'r+');
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, path);
      const dirFd = openSync(dirname(path), 'r');
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    return 'applied';
  } finally { release(); }
}

/** No cloud, keychain, or nonempty file-store apply capability is exposed. */
export function defaultFileSealedBackend(): AtomicSealedStaticBackend | undefined {
  if (currentBackendId() !== 'file') return undefined;
  return { atomicBatchAndMarker: true, async commitEmptyStaticBatch(input) { return commitEmptyFileBatch(input); } };
}
