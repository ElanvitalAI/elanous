/**
 * Warm Pod wire contract. A reply is only a shadow observation until its lease,
 * attempt, artifacts, and result agree with the existing one-shot Job.
 * No command or result in this module launches a Pod or changes the gate verdict.
 */

export interface WarmWorkerKey {
  context: string;
  imageDigest: string;
  lockHash: string;
  architecture: string;
}

export interface WarmWorkerCommand {
  protocol: 1;
  runId: string;
  attemptId: string;
  cutSha: string;
  baselineSha?: string;
  leaseId: string;
  generation: number;
  workerId: string;
  /** Acquired Pod identity and lease timestamp, carried only by the host control path. */
  podUid?: string;
  requestedAt?: string;
  key: WarmWorkerKey;
  deadlineAt: number;
  files: readonly string[];
  /** Named, versioned environment profile; credentials travel through the existing Secret path. */
  envProfile: string;
}

export interface WarmWorkerFileResult {
  file: string;
  rc: number;
  /** Canonical `file > case` IDs parsed from a complete JUnit artifact. */
  failureIds: readonly string[];
  /** Named unhandled errors, including those emitted outside JUnit. */
  errorIds: readonly string[];
  junitComplete: boolean;
}

export interface WarmWorkerReply {
  protocol: 1;
  runId: string;
  attemptId: string;
  cutSha: string;
  baselineSha?: string;
  leaseId: string;
  generation: number;
  workerId: string;
  key: WarmWorkerKey;
  envProfile: string;
  startedAt: number;
  finishedAt: number;
  files: readonly WarmWorkerFileResult[];
}

export type WarmShadowReason = 'match' | 'no-sample' | 'reply-unmeasured' | 'reference-unmeasured' | 'invalid-reply' | 'identity' | 'missing-artifact' | 'file-set' | 'result';
export interface WarmShadowDecision {
  reason: WarmShadowReason;
  /** The existing Job remains authoritative throughout shadow mode. */
  adopt: 'job';
  quarantineWorker: boolean;
}

const decision = (reason: WarmShadowReason): WarmShadowDecision =>
  ({ reason, adopt: 'job', quarantineWorker: !['match', 'no-sample', 'reply-unmeasured', 'reference-unmeasured'].includes(reason) });

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const named = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nonnegativeInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Validate untrusted JSON before it can enter the shadow comparator. */
export function parseWarmWorkerReply(raw: unknown): WarmWorkerReply | null {
  const reply = record(raw);
  const key = record(reply?.key);
  if (!reply || reply.protocol !== 1 || !named(reply.runId) || !named(reply.attemptId) || !named(reply.cutSha)
    || !named(reply.leaseId) || !named(reply.workerId) || !named(reply.envProfile)
    || !nonnegativeInt(reply.generation) || reply.generation < 1
    || !finite(reply.startedAt) || !finite(reply.finishedAt)
    || !key || !named(key.context) || !named(key.imageDigest) || !named(key.lockHash) || !named(key.architecture)
    || !Array.isArray(reply.files) || reply.files.some((part: unknown) => {
      const item = record(part);
      return !item || !named(item.file) || !nonnegativeInt(item.rc)
        || typeof item.junitComplete !== 'boolean'
        || !Array.isArray(item.failureIds) || !item.failureIds.every(named)
        || !Array.isArray(item.errorIds) || !item.errorIds.every(named);
    }) || (reply.baselineSha !== undefined && !named(reply.baselineSha))) return null;
  return raw as WarmWorkerReply;
}

function fileMap(files: readonly WarmWorkerFileResult[], expected: readonly string[]): Map<string, WarmWorkerFileResult> | null {
  if (!Array.isArray(files) || !Array.isArray(expected) || files.length !== expected.length
    || expected.some((file) => !named(file)) || new Set(expected).size !== expected.length) return null;
  const wanted = new Set(expected);
  const map = new Map<string, WarmWorkerFileResult>();
  for (const part of files) {
    if (!part || !named(part.file) || !wanted.has(part.file) || map.has(part.file)) return null;
    map.set(part.file, part);
  }
  return map;
}

function validPart(part: WarmWorkerFileResult): boolean {
  const prefix = `${part.file} > `;
  const namedId = (id: unknown) => typeof id === 'string' && id.startsWith(prefix) && id.slice(prefix.length).trim().length > 0;
  const namedErrorId = (id: unknown) => typeof id === 'string' && id.startsWith(`${prefix}[error] `)
    && id.slice(`${prefix}[error] `.length).trim().length > 0;
  return Number.isSafeInteger(part.rc) && part.rc >= 0 && part.junitComplete === true
    && Array.isArray(part.failureIds) && part.failureIds.every(namedId)
    && new Set(part.failureIds).size === part.failureIds.length
    && Array.isArray(part.errorIds) && part.errorIds.every(namedErrorId)
    && new Set(part.errorIds).size === part.errorIds.length
    && new Set([...part.failureIds, ...part.errorIds]).size === part.failureIds.length + part.errorIds.length
    && (part.rc === 0 ? part.failureIds.length + part.errorIds.length === 0 : part.failureIds.length + part.errorIds.length > 0);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (new Set(left).size !== left.length || new Set(right).size !== right.length || left.length !== right.length) return false;
  const orderedRight = [...right].sort();
  return [...left].sort().every((id, index) => id === orderedRight[index]);
}

/** Fail closed on a stale generation, missing artifact, changed file set, or changed `rc + failure IDs`. */
export function assessWarmWorkerShadow(command: WarmWorkerCommand, job: readonly WarmWorkerFileResult[], rawReply: unknown): WarmShadowDecision {
  if (!Array.isArray(command.files) || !command.files.length) return decision('no-sample');
  const reference = fileMap(job, command.files);
  if (!reference) return decision('reference-unmeasured');
  // Validate the whole authoritative sample before attributing anything to the worker.
  for (const file of command.files) if (!validPart(reference.get(file)!)) return decision('reference-unmeasured');
  if (rawReply === null || rawReply === undefined) return decision('reply-unmeasured');
  const reply = parseWarmWorkerReply(rawReply);
  if (!reply) return decision('invalid-reply');
  if (command.protocol !== 1 || reply.protocol !== 1 || !command.runId || !command.attemptId || !command.cutSha || !command.leaseId || !command.workerId
    || !Number.isSafeInteger(command.generation) || command.generation < 1
    || !Number.isFinite(command.deadlineAt)
    || command.runId !== reply.runId || command.attemptId !== reply.attemptId || command.cutSha !== reply.cutSha
    || command.baselineSha !== reply.baselineSha || command.envProfile !== reply.envProfile
    || command.leaseId !== reply.leaseId || command.generation !== reply.generation || command.workerId !== reply.workerId
    || !command.key || command.key.context !== reply.key?.context || command.key.imageDigest !== reply.key?.imageDigest
    || command.key.lockHash !== reply.key?.lockHash || command.key.architecture !== reply.key?.architecture
    || !Number.isFinite(reply.startedAt) || !Number.isFinite(reply.finishedAt) || reply.finishedAt < reply.startedAt
    || reply.finishedAt > command.deadlineAt) return decision('identity');
  const candidate = fileMap(reply.files, command.files);
  if (!candidate) return decision('file-set');
  for (const file of command.files) if (!validPart(candidate.get(file)!)) return decision('missing-artifact');
  for (const file of command.files) {
    const before = reference.get(file)!;
    const after = candidate.get(file)!;
    if (before.rc !== after.rc || !sameIds(before.failureIds, after.failureIds) || !sameIds(before.errorIds, after.errorIds)) return decision('result');
  }
  return decision('match');
}
