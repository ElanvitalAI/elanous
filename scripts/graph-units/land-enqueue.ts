import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { debug } from '../../src/debug/log.js';

type RecordValue = Record<string, unknown>;
type EnqueueResult = {
  outcome: 'done' | 'needs-human';
  result: string;
  evidence: RecordValue;
};

function record(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function needsHuman(reason: string, evidence: RecordValue = {}): EnqueueResult {
  return { outcome: 'needs-human', result: reason, evidence: { enqueued: false, reason, ...evidence } };
}

const OWNERS = new Set(['TC', 'MK', 'UX', 'OPC', 'OPT', 'OP', 'tf']);

/** The graph asks the existing OP train to enqueue; it never performs a merge. */
export function runLandEnqueue(
  envelope: unknown,
  executable = process.env.ELANOUS_LAND_ENQUEUE,
  spawn: typeof spawnSync = spawnSync,
): EnqueueResult {
  const context = record(record(envelope).context);
  const rawPr = context.pr;
  const pr = typeof rawPr === 'number' ? rawPr : typeof rawPr === 'string' && /^\d+$/.test(rawPr) ? Number(rawPr) : NaN;
  const expectedHead = text(context.expectedHead);
  const review = text(context.review);
  const rawOwner = text(context.owner);
  const owner = rawOwner.startsWith('train:') ? rawOwner.slice(6) : rawOwner;
  if (!Number.isSafeInteger(pr) || pr <= 0) return needsHuman('pr-missing-or-invalid');
  if (!/^[0-9a-f]{40}$/i.test(expectedHead)) return needsHuman('expected-head-missing-or-invalid', { pr });
  if (!isAbsolute(review) || !existsSync(review)) return needsHuman('review-json-missing', { pr, expectedHead, review });
  if (!OWNERS.has(owner)) return needsHuman('train-owner-missing-or-invalid', { pr, expectedHead, review });
  if (!executable || !isAbsolute(executable) || !existsSync(executable)) {
    return needsHuman('land-enqueue-command-unavailable', { pr, expectedHead, review, owner });
  }
  const args = [String(pr), `train:${owner}`, '--expected-head', expectedHead, '--review', review];
  const result = spawn(executable, args, { encoding: 'utf8', timeout: 55_000, shell: false });
  const evidence = {
    pr, expectedHead, review, owner,
    exitCode: result.status,
    stdout: String(result.stdout ?? '').slice(-2000),
    stderr: String(result.stderr ?? '').slice(-2000),
  };
  if (result.error || result.status !== 0) {
    return needsHuman(result.error ? `land-enqueue-error: ${result.error.message}` : 'land-enqueue-refused', evidence);
  }
  return { outcome: 'done', result: 'train-enqueued', evidence: { enqueued: true, ...evidence } };
}

if (import.meta.main) {
  try {
    const path = process.env.ELANOUS_GRAPH_CONTEXT;
    if (!path) throw new Error('ELANOUS_GRAPH_CONTEXT missing');
    const graph = JSON.parse(readFileSync(path, 'utf8')) as { input?: unknown };
    const result = runLandEnqueue(graph.input);
    debug.log('harness.journey', 'land-enqueue', {
      outcome: result.outcome,
      reason: result.outcome === 'needs-human' ? result.result : null,
      pr: result.evidence.pr ?? null,
      expectedHead: result.evidence.expectedHead ?? null,
      enqueued: result.evidence.enqueued,
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.log(JSON.stringify(needsHuman(`land-context-invalid: ${error instanceof Error ? error.message : String(error)}`)));
  }
}
