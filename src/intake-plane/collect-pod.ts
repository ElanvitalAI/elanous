import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { resolveObsidianRoot } from '../acp/fs-roots.js';
import { debug } from '../debug/log.js';
import { assertVaultWriteAllowed } from '../obsidian/vault-write-guard.js';
import { loadIntakeLedger, markIntakeItem } from './items.js';

export interface CollectPodResult {
  outcome: 'absorbed' | 'failed' | 'conflict' | 'invalid';
  note?: string;
  reason?: string;
}

type PodResult = { ok: true; url: string; note: string; rc: number } | { ok: false; url: string; rc: number; log: string };

function validResult(value: unknown): value is PodResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.url !== 'string' || !v.url || typeof v.rc !== 'number' || !Number.isInteger(v.rc)) return false;
  if (v.ok === true) return typeof v.note === 'string';
  if (v.ok === false) return typeof v.log === 'string' && v.log.length > 0;
  return false;
}

function validNote(note: string): boolean {
  return note.length > 0 && !isAbsolute(note) && !note.startsWith('\\') && !note.includes('\\')
    && note.endsWith('.md') && note.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Collect one Pod absorb artifact. Dry-run reports the outcome a write would have had, without writes. */
export function collectPodAbsorb(root: string, opts: { dir: string; id: string; vaultRoot?: string; dryRun?: boolean; now?: string }): CollectPodResult {
  const finish = (result: CollectPodResult): CollectPodResult => {
    debug.log('intake.collect-pod', 'collected', { id: opts.id, outcome: result.outcome });
    return result;
  };
  let result: unknown;
  try { result = JSON.parse(readFileSync(join(opts.dir, 'result.json'), 'utf8')); }
  catch { return finish({ outcome: 'invalid', reason: 'result.json missing or malformed' }); }
  if (!validResult(result)) return finish({ outcome: 'invalid', reason: 'result.json shape' });
  if (!loadIntakeLedger(root).items.has(opts.id)) return finish({ outcome: 'invalid', reason: 'id not in ledger' });
  if (!result.ok) {
    if (!opts.dryRun) markIntakeItem(root, opts.id, { status: 'deferred' }, opts.now);
    return finish({ outcome: 'failed', reason: String(result.rc) });
  }
  if (!validNote(result.note)) return finish({ outcome: 'invalid', reason: 'invalid note path' });
  const sourceRoot = resolve(opts.dir, 'vault');
  const source = resolve(sourceRoot, result.note);
  const vaultRoot = resolve(opts.vaultRoot ?? resolveObsidianRoot().root);
  const abs = resolve(vaultRoot, result.note);
  if (!inside(source, sourceRoot) || !inside(abs, vaultRoot)) return finish({ outcome: 'invalid', reason: 'invalid note path' });
  try {
    if (!statSync(source).isFile() || !inside(realpathSync(sourceRoot), realpathSync(opts.dir))
      || !inside(realpathSync(source), realpathSync(sourceRoot))) {
      return finish({ outcome: 'invalid', reason: 'note source missing or outside artifacts' });
    }
  } catch { return finish({ outcome: 'invalid', reason: 'note source missing or outside artifacts' }); }
  // A pre-existing destination, including a broken symlink, is always a conflict.
  try { lstatSync(abs); return finish({ outcome: 'conflict', note: abs }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // Resolve existing ancestors before any write; reject symlinks that redirect outside the vault.
  const existingParent = (path: string): string => existsSync(path) ? path : existingParent(dirname(path));
  const anchor = existingParent(vaultRoot);
  const vaultAnchor = realpathSync(anchor);
  const parent = existingParent(dirname(abs));
  if (!inside(realpathSync(parent), vaultAnchor)) {
    return finish({ outcome: 'invalid', reason: 'destination outside vault' });
  }
  // Dry-run checks the guard too, but does not create directories, files or ledger entries.
  assertVaultWriteAllowed(abs);
  if (opts.dryRun) return finish({ outcome: 'absorbed', note: abs });
  mkdirSync(dirname(abs), { recursive: true });
  if (!inside(realpathSync(dirname(abs)), realpathSync(vaultRoot))) return finish({ outcome: 'invalid', reason: 'destination outside vault' });
  const temp = join(dirname(abs), `.collect-pod-${randomUUID()}.tmp`);
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, readFileSync(source));
    closeSync(fd);
    // Reserve the name without overwrite, then atomically replace only our own reservation.
    assertVaultWriteAllowed(abs);
    try { linkSync(temp, abs); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return finish({ outcome: 'conflict', note: abs });
      throw error;
    }
    renameSync(temp, abs);
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
    if (existsSync(temp)) unlinkSync(temp);
  }
  markIntakeItem(root, opts.id, { status: 'absorbed', output: { kind: 'note', ref: abs } }, opts.now);
  return finish({ outcome: 'absorbed', note: abs });
}
