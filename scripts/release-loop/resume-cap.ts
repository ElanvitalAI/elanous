import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { GraphRunState } from '../../src/graph-runner/runner.js';
import { isReleaseVersion } from './release-version.js';

/** Called under the OP seat flock, before any branch-tip or graph-run mutation. */
export function reserveReleaseResumeAttempt(state: GraphRunState, root: string, options: {
  now?: () => Date;
  /** Under the OP flock, preview the next observed count before tip preflight. */
  checkOnly?: boolean;
} = {}): { attempt: number; path: string; priorCountKnown: boolean } {
  const version = (state.input as { version?: unknown } | undefined)?.version;
  if (typeof version !== 'string' || !isReleaseVersion(version) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(state.runId))
    throw new Error('release resume count requires a valid saved version and run id');
  const path = join(root, 'release', version, 'resume-attempts', `${state.runId}.json`);
  const hadLedger = existsSync(path);
  const prior = hadLedger ? JSON.parse(readFileSync(path, 'utf8')) as unknown : { version, runId: state.runId, attempts: [] };
  if (!prior || typeof prior !== 'object' || Array.isArray(prior)) throw new Error('release resume attempts ledger invalid');
  const saved = prior as { version?: unknown; runId?: unknown; attempts?: unknown; priorCountKnown?: unknown };
  if (saved.version !== version || saved.runId !== state.runId || !Array.isArray(saved.attempts)
    || saved.attempts.some(value => typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    || (saved.priorCountKnown !== undefined && typeof saved.priorCountKnown !== 'boolean'))
    throw new Error('release resume attempts ledger invalid');
  // Existing ledgers predate this field and began before the first resume.
  // A legacy resumed run with no ledger must carry its unknown history forward.
  const priorCountKnown = hadLedger ? saved.priorCountKnown !== false : !state.resume;
  if (options.checkOnly) return { attempt: saved.attempts.length + 1, path, priorCountKnown };
  const at = (options.now ?? (() => new Date()))().toISOString();
  const next = { version, runId: state.runId, priorCountKnown, attempts: [...saved.attempts, at] };
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, `${JSON.stringify(next)}\n`, { mode: 0o600 }); renameSync(temp, path); }
  finally { try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
  return { attempt: next.attempts.length, path, priorCountKnown };
}
