import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DecisionLedger } from '../../src/decisions/decision-ledger.js';
import type { GraphRunState } from '../../src/graph-runner/runner.js';
import { isReleaseVersion } from './release-version.js';

export const RELEASE_RESUME_LIMIT = 2;

/** Called under the OP seat flock, before any branch-tip or graph-run mutation. */
export function reserveReleaseResumeAttempt(state: GraphRunState, root: string, options: {
  now?: () => Date;
  openCard?: (version: string, runId: string, reason: string) => string;
  /** Under the OP flock, check capacity before tip preflight without consuming an attempt. */
  checkOnly?: boolean;
  /** A dry-run reports the cap without creating an OP decision card. */
  noDecision?: boolean;
} = {}): { attempt: number; path: string } {
  const version = (state.input as { version?: unknown } | undefined)?.version;
  if (typeof version !== 'string' || !isReleaseVersion(version) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(state.runId))
    throw new Error('release resume cap requires a valid saved version and run id');
  const path = join(root, 'release', version, 'resume-attempts', `${state.runId}.json`);
  const card = options.openCard ?? ((v: string, id: string, reason: string) => {
    const ref = `release-resume-cap:${v}:${id}`;
    return new DecisionLedger({ stateDir: root, now: options.now }).raiseOnce({
      title: `${v} release resume limit: ${id}`, category: 'scope',
      scqa: { s: `Release ${v} run ${id} has reached its two-resume limit.`, c: reason,
        q: 'Should this release be deferred or moved to the next version?' },
      options: [{ key: 'a', label: 'Defer this release', consequence: 'Stop this run and reschedule the release.' },
        { key: 'b', label: 'Move to next version', consequence: 'Stop this run and carry the work to a new release.' }],
      recommendation: { skipped: true, reason: 'OP must choose the release disposition.' },
      raisedBy: { agent: 'release-resume-cap', track: 'TC' }, refs: [ref],
    }, ref).id;
  });
  const blocked = (reason: string): never => {
    if (options.noDecision) throw new Error(`release resume limit reached: ${reason}`);
    throw new Error(`release resume limit reached — decision ${card(version, state.runId, reason)}: ${reason}`);
  };
  if (options.noDecision && !options.checkOnly) throw new Error('noDecision requires checkOnly');
  if (!existsSync(path) && state.resume) blocked('saved run was resumed before attempt counting; prior count is unknown');
  const prior = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as unknown : { version, runId: state.runId, attempts: [] };
  if (!prior || typeof prior !== 'object' || Array.isArray(prior)) throw new Error('release resume attempts ledger invalid');
  const saved = prior as { version?: unknown; runId?: unknown; attempts?: unknown };
  if (saved.version !== version || saved.runId !== state.runId || !Array.isArray(saved.attempts)
    || saved.attempts.some(value => typeof value !== 'string' || !Number.isFinite(Date.parse(value))))
    throw new Error('release resume attempts ledger invalid');
  if (saved.attempts.length >= RELEASE_RESUME_LIMIT) blocked(`${saved.attempts.length} resumes already recorded`);
  if (options.checkOnly) return { attempt: saved.attempts.length + 1, path };
  const at = (options.now ?? (() => new Date()))().toISOString();
  const next = { version, runId: state.runId, attempts: [...saved.attempts, at] };
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, `${JSON.stringify(next)}\n`, { mode: 0o600 }); renameSync(temp, path); }
  finally { try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
  return { attempt: next.attempts.length, path };
}
