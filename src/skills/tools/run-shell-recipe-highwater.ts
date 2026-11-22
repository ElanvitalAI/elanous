import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { elanousStateRoot } from '../../autopilot/state-paths.js';

/** Runtime is read-only: missing, unsafe or malformed state is never initialized here. */
export function recipeHighwaterPath(): string {
  return join(elanousStateRoot(), 'runshell', 'recipe-highwater.json');
}
export type HighwaterResult = { ok: true; epoch: number; revocationStateSha256: string } | { ok: false; reason: string };
export function readRecipeHighwater(path = recipeHighwaterPath()): HighwaterResult {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600 || st.size < 1 || st.size > 256)
      return { ok: false, reason: 'unsafe-highwater' };
    const bytes = Buffer.alloc(st.size);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length || fstatSync(fd).size !== st.size)
      return { ok: false, reason: 'highwater-changed' };
    const item: unknown = JSON.parse(bytes.toString('utf8'));
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).sort().join(',') !== 'epoch,revocationStateSha256,schema')
      return { ok: false, reason: 'invalid-highwater' };
    const record = item as Record<string, unknown>;
    if (record.schema !== 2 || typeof record.revocationStateSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.revocationStateSha256) || !Number.isSafeInteger(record.epoch) || (record.epoch as number) < 1)
      return { ok: false, reason: 'invalid-highwater' };
    return { ok: true, epoch: record.epoch as number, revocationStateSha256: record.revocationStateSha256 as string };
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing-highwater' : 'invalid-highwater' };
  } finally { if (fd !== undefined) closeSync(fd); }
}
