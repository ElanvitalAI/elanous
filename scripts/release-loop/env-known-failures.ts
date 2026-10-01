import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The identity is the complete Bun failure id, not its containing test file. */
export function loadEnvKnownFailures(repoRoot: string): Set<string> {
  const path = join(repoRoot, 'test/env-known-failures.json');
  if (!existsSync(path)) return new Set();
  let data: unknown;
  try { data = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`invalid environment known failures: ${path}`, { cause: error }); }
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || !('env' in data) || data.env !== 'linux-pod'
    || !('measuredAt' in data) || typeof data.measuredAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.measuredAt)
    || !('tests' in data) || !Array.isArray(data.tests)
    || !data.tests.every((entry: unknown) => entry && typeof entry === 'object' && !Array.isArray(entry)
      && 'id' in entry && typeof entry.id === 'string'
      && /^(?:[\w.-]+\/)+[\w.-]+\.test\.tsx? > \S.*$/.test(entry.id)
      && 'reason' in entry && typeof entry.reason === 'string' && entry.reason.trim().length > 0)) {
    throw new Error(`invalid environment known failures: ${path}`);
  }
  const ids = data.tests.map((entry: { id: string }) => entry.id);
  if (new Set(ids).size !== ids.length) throw new Error(`invalid environment known failures: duplicate id in ${path}`);
  return new Set(ids);
}

export function splitKnownEnv(failures: string[], known: Set<string>): { counted: string[]; knownEnv: string[] } {
  return {
    counted: failures.filter((id) => !known.has(id)),
    knownEnv: failures.filter((id) => known.has(id)),
  };
}
