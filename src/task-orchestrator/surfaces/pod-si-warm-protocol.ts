/** si-task warm execution contract. The gate-v1 test replay wire remains independent. */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { WarmWorkerKey } from './pod-warm-worker-protocol.js';

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PATH = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const MAX_ARTIFACTS = 256;
const MAX_RESULT_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
const MAX_ARTIFACT_TOTAL_BYTES = 20 * 1024 * 1024;

/** The secret bundle travels on a separate private stdin channel, never in this command or its reply. */
export interface SiWarmCommand {
  protocol: 'si-v1';
  runId: string;
  attemptId: string;
  executionKey: string;
  sourceSha: string;
  leaseId: string;
  generation: number;
  workerId: string;
  podUid: string;
  key: WarmWorkerKey;
  envProfile: 'si-standard-v1';
  deadlineAt: number;
  payloadSha256: string;
  credentialBundleSha256: string;
}

/** Metadata only. Terminal output and artifacts are transferred as separately verified bytes. */
export interface SiWarmReply {
  protocol: 'si-v1';
  runId: string;
  attemptId: string;
  executionKey: string;
  sourceSha: string;
  leaseId: string;
  generation: number;
  workerId: string;
  podUid: string;
  key: WarmWorkerKey;
  envProfile: 'si-standard-v1';
  payloadSha256: string;
  startedAt: number;
  finishedAt: number;
  exitCode: number;
  terminalSha256: string;
  ledgerSha256: string;
  logSha256: string;
  artifacts: readonly { path: string; sha256: string; bytes: number }[];
}

export interface SiWarmReturnedBytes {
  terminal: Uint8Array;
  ledger: Uint8Array;
  log: Uint8Array;
  artifacts: readonly { path: string; bytes: Uint8Array }[];
}

export type SiWarmValidationReason = 'match' | 'invalid-command' | 'invalid-reply' | 'identity'
  | 'expired' | 'missing-output' | 'output-hash' | 'terminal';

export interface SiWarmValidation {
  reason: SiWarmValidationReason;
  /** A matching failed child is still a measured result, never a reason to run a second Job. */
  measured: boolean;
  quarantineWorker: boolean;
}

const own = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const fields = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const str = (value: unknown): value is string => typeof value === 'string';
const token = (value: unknown): value is string => str(value) && TOKEN.test(value);
const digest = (value: unknown): value is string => str(value) && DIGEST.test(value);
const safePath = (value: unknown): value is string => str(value) && PATH.test(value)
  && value.split('/').every(part => part !== '.' && part !== '..');
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const keyFields = ['context', 'imageDigest', 'lockHash', 'architecture'] as const;
const commandFields = ['protocol', 'runId', 'attemptId', 'executionKey', 'sourceSha', 'leaseId',
  'generation', 'workerId', 'podUid', 'key', 'envProfile', 'deadlineAt', 'payloadSha256',
  'credentialBundleSha256'] as const;
const replyFields = ['protocol', 'runId', 'attemptId', 'executionKey', 'sourceSha', 'leaseId',
  'generation', 'workerId', 'podUid', 'key', 'envProfile', 'payloadSha256', 'startedAt',
  'finishedAt', 'exitCode', 'terminalSha256', 'ledgerSha256', 'logSha256', 'artifacts'] as const;

function validKey(raw: unknown): raw is WarmWorkerKey {
  const key = own(raw);
  return !!key && fields(key, keyFields) && token(key.context)
    && str(key.imageDigest) && /^sha256:[a-f0-9]{64}$/.test(key.imageDigest)
    && digest(key.lockHash) && token(key.architecture);
}

/** Reject unknown wire fields so credential text cannot be accepted as reply metadata. */
export function parseSiWarmCommand(raw: unknown): SiWarmCommand | null {
  const row = own(raw);
  if (!row || !fields(row, commandFields) || row.protocol !== 'si-v1'
    || ![row.runId, row.attemptId, row.leaseId, row.workerId].every(token)
    || !digest(row.executionKey) || !str(row.sourceSha) || !SHA.test(row.sourceSha)
    || !token(row.podUid) || !integer(row.generation) || row.generation < 1
    || !validKey(row.key) || row.envProfile !== 'si-standard-v1'
    || !finite(row.deadlineAt) || row.deadlineAt <= 0 || !digest(row.payloadSha256)
    || !digest(row.credentialBundleSha256)) return null;
  return raw as SiWarmCommand;
}

export function parseSiWarmReply(raw: unknown): SiWarmReply | null {
  const row = own(raw);
  if (!row || !fields(row, replyFields) || row.protocol !== 'si-v1'
    || ![row.runId, row.attemptId, row.leaseId, row.workerId].every(token)
    || !digest(row.executionKey) || !str(row.sourceSha) || !SHA.test(row.sourceSha)
    || !token(row.podUid) || !integer(row.generation) || row.generation < 1
    || !validKey(row.key) || row.envProfile !== 'si-standard-v1'
    || !digest(row.payloadSha256) || !finite(row.startedAt) || row.startedAt < 0
    || !finite(row.finishedAt) || row.finishedAt <= row.startedAt
    || !integer(row.exitCode) || row.exitCode < 0
    || !digest(row.terminalSha256) || !digest(row.ledgerSha256) || !digest(row.logSha256)
    || !Array.isArray(row.artifacts) || row.artifacts.length > MAX_ARTIFACTS
    || row.artifacts.some((part: unknown) => {
      const item = own(part);
      return !item || !fields(item, ['path', 'sha256', 'bytes']) || !safePath(item.path) || !digest(item.sha256)
        || !integer(item.bytes) || item.bytes < 0 || item.bytes > MAX_ARTIFACT_BYTES;
    }) || row.artifacts.reduce((sum: number, item: { bytes: number }) => sum + item.bytes, 0) > MAX_ARTIFACT_TOTAL_BYTES) return null;
  return raw as SiWarmReply;
}

export function siWarmSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function siWarmDigestMatches(bytes: Uint8Array, expected: string): boolean {
  if (!digest(expected)) return false;
  return timingSafeEqual(Buffer.from(siWarmSha256(bytes), 'hex'), Buffer.from(expected, 'hex'));
}

/** Validate the bytes that will enter the existing si-task result and artifact collectors. */
export function assessSiWarmReply(commandRaw: unknown, replyRaw: unknown, returned: SiWarmReturnedBytes | null,
  payload: Uint8Array, credentialBundle: Uint8Array): SiWarmValidation {
  const fail = (reason: SiWarmValidationReason): SiWarmValidation => ({ reason, measured: false, quarantineWorker: true });
  const command = parseSiWarmCommand(commandRaw);
  if (!command || !siWarmDigestMatches(payload, command.payloadSha256)
    || !siWarmDigestMatches(credentialBundle, command.credentialBundleSha256)) return fail('invalid-command');
  const reply = parseSiWarmReply(replyRaw);
  if (!reply) return fail('invalid-reply');
  if (reply.runId !== command.runId || reply.attemptId !== command.attemptId
    || reply.executionKey !== command.executionKey || reply.sourceSha !== command.sourceSha
    || reply.leaseId !== command.leaseId || reply.generation !== command.generation
    || reply.workerId !== command.workerId || reply.podUid !== command.podUid
    || reply.envProfile !== command.envProfile || reply.payloadSha256 !== command.payloadSha256
    || keyFields.some(field => reply.key[field] !== command.key[field])) return fail('identity');
  if (reply.startedAt > reply.finishedAt || reply.finishedAt >= command.deadlineAt) return fail('expired');
  if (!returned || !(returned.terminal instanceof Uint8Array)
    || !(returned.ledger instanceof Uint8Array) || !(returned.log instanceof Uint8Array)
    || !Array.isArray(returned.artifacts) || returned.artifacts.length !== reply.artifacts.length
    || returned.terminal.byteLength === 0 || returned.ledger.byteLength === 0
    || returned.terminal.byteLength > MAX_RESULT_BYTES || returned.ledger.byteLength > MAX_RESULT_BYTES
    || returned.log.byteLength > MAX_RESULT_BYTES) return fail('missing-output');
  if (!siWarmDigestMatches(returned.terminal, reply.terminalSha256)
    || !siWarmDigestMatches(returned.ledger, reply.ledgerSha256)
    || !siWarmDigestMatches(returned.log, reply.logSha256)) return fail('output-hash');
  if (new Set(reply.artifacts.map(item => item.path)).size !== reply.artifacts.length) return fail('invalid-reply');
  const actual = new Map<string, Uint8Array>();
  for (const item of returned.artifacts) {
    if (!item || !safePath(item.path)
      || !(item.bytes instanceof Uint8Array) || actual.has(item.path)) return fail('missing-output');
    actual.set(item.path, item.bytes);
  }
  for (const item of reply.artifacts) {
    const bytes = actual.get(item.path);
    if (!bytes) return fail('missing-output');
    if (bytes.byteLength !== item.bytes || bytes.byteLength > MAX_RESULT_BYTES
      || !siWarmDigestMatches(bytes, item.sha256)) return fail('output-hash');
  }
  try {
    const terminal = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(returned.terminal));
    const row = own(terminal);
    if (!row || typeof row.ok !== 'boolean' || !str(row.stage) || !row.stage) return fail('terminal');
  } catch { return fail('terminal'); }
  return { reason: 'match', measured: true, quarantineWorker: false };
}

export type SiWarmExecutionBoundary = 'not-entered' | 'exec-attempted';
export type SiWarmNextStep = 'adopt-warm' | 'cold-job' | 'reconcile-only';

/** A Pod exec may have made a PR even when its response was lost. Never launch a duplicate Job then. */
export function decideSiWarmNextStep(input: {
  boundary: SiWarmExecutionBoundary;
  leaseFenced: boolean;
  validation?: SiWarmValidation;
}): { next: SiWarmNextStep; quarantineWorker: boolean } {
  if (input.boundary === 'not-entered' && input.leaseFenced)
    return { next: 'cold-job', quarantineWorker: false };
  if (input.boundary === 'exec-attempted' && input.leaseFenced && input.validation?.measured
    && input.validation.reason === 'match')
    return { next: 'adopt-warm', quarantineWorker: false };
  return { next: 'reconcile-only', quarantineWorker: true };
}
