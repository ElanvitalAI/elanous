import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Explicit opt-in only. A test enters a shared Pod after its own-Pod and batch verdicts have been compared. */
export function loadGateBatchSafe(repoRoot: string): Set<string> {
  const path = join(repoRoot, 'release/gate-batch-safe.json');
  if (!existsSync(path)) return new Set();
  let data: unknown;
  try { data = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`invalid gate batch safe list: ${path}`, { cause: error }); }
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || !('env' in data) || data.env !== 'linux-pod'
    || !('tests' in data) || !Array.isArray(data.tests)
    || !data.tests.every((entry: unknown) => entry && typeof entry === 'object' && !Array.isArray(entry)
      && 'file' in entry && typeof entry.file === 'string'
      && /^(?:[\w.-]+\/)+[\w.-]+\.test\.tsx?$/.test(entry.file)
      && 'evidence' in entry && typeof entry.evidence === 'string' && entry.evidence.trim().length > 0)) {
    throw new Error(`invalid gate batch safe list: ${path}`);
  }
  const files = data.tests.map((entry: { file: string }) => entry.file);
  if (new Set(files).size !== files.length) throw new Error(`invalid gate batch safe list: duplicate file in ${path}`);
  return new Set(files);
}
