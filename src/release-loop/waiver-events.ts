import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

export type WaiverEventKind = 'op-waiver' | 'review-cap' | 'gate';
export type WaiverEventMode = 'shadow' | 'operational';
export type WaiverEventExpiry = 'head-changed' | 'used' | 'timeout' | 'release-ended';

export interface WaiverEventInput {
  kind: WaiverEventKind;
  mode: WaiverEventMode;
  target: string;
  head: string;
  evidence: string[];
  actor: string;
  issuedAt: number;
  expiresAt: number;
  maxUses: number;
}

export interface WaiverEvent extends WaiverEventInput {
  schemaVersion: 1;
  eventId: string;
  uses: number;
  expiredBy?: WaiverEventExpiry;
  expiredAt?: number;
  consumedAt?: number;
  promotedAt?: number;
}

export interface WaiverEventDecision {
  allowed: boolean;
  mode: WaiverEventMode;
  usesRemaining: number;
  reason?: string;
  expiredBy?: WaiverEventExpiry;
}

export function gateWaiverEvidence(input: { reason: string; actor: string; unmeasured?: string }): string[] {
  return [`gate-waiver:reason:${input.reason}`, `gate-waiver:actor:${input.actor}`,
    ...(input.unmeasured === undefined ? [] : [`gate-waiver:unmeasured:${input.unmeasured}`])];
}

/** A one-use waiver is bound to its complete evidence set; subset matching can revive stale grants. */
export function hasExactWaiverEvidence(event: Pick<WaiverEvent, 'evidence'>, expected: readonly string[]): boolean {
  return event.evidence.length === expected.length && expected.every((item, index) => event.evidence[index] === item);
}

const HASH = /^[a-f0-9]{40}$/i;
const MAX_TTL: Record<WaiverEventKind, number> = {
  'op-waiver': 72 * 60 * 60 * 1000,
  'review-cap': 24 * 60 * 60 * 1000,
  gate: Number.POSITIVE_INFINITY,
};

function validEvent(event: WaiverEvent): boolean {
  return event.schemaVersion === 1 && typeof event.eventId === 'string' && event.eventId.length > 0
    && ['op-waiver', 'review-cap', 'gate'].includes(event.kind)
    && ['shadow', 'operational'].includes(event.mode)
    && typeof event.target === 'string' && event.target.trim().length > 0
    && typeof event.actor === 'string' && event.actor.trim().length > 0
    && HASH.test(event.head) && Array.isArray(event.evidence) && event.evidence.length > 0
    && event.evidence.every((item) => typeof item === 'string' && item.trim().length > 0)
    && Number.isSafeInteger(event.issuedAt) && Number.isSafeInteger(event.expiresAt) && event.expiresAt > event.issuedAt
    && event.expiresAt - event.issuedAt <= MAX_TTL[event.kind]
    && Number.isSafeInteger(event.maxUses) && event.maxUses === 1
    && Number.isSafeInteger(event.uses) && event.uses >= 0 && event.uses <= event.maxUses
    && (event.kind !== 'gate' || event.target.startsWith('run:'))
    && (event.kind !== 'review-cap' || event.maxUses === 1)
    && (event.expiredBy === undefined || ['head-changed', 'used', 'timeout', 'release-ended'].includes(event.expiredBy))
    && (event.expiredAt === undefined || Number.isSafeInteger(event.expiredAt))
    && (event.consumedAt === undefined || Number.isSafeInteger(event.consumedAt))
    && (event.promotedAt === undefined || Number.isSafeInteger(event.promotedAt))
    && (event.uses === 0 ? event.consumedAt === undefined : event.consumedAt !== undefined)
    && (event.expiredBy === 'used' ? event.uses === event.maxUses && event.consumedAt !== undefined : true)
    && (event.expiredBy === undefined || event.expiredBy === 'used' ? event.expiredAt === undefined : event.expiredAt !== undefined)
    && (event.mode === 'shadow' ? event.promotedAt === undefined : true);
}

export function createWaiverEvent(input: WaiverEventInput): WaiverEvent {
  const event: WaiverEvent = { schemaVersion: 1, ...input, head: input.head.toLowerCase(), evidence: [...new Set(input.evidence)],
    eventId: randomUUID(), uses: 0 };
  if (!validEvent(event)) throw new Error('invalid waiver event');
  return event;
}

export function issueOpWaiverEvent(input: Omit<WaiverEventInput, 'kind' | 'issuedAt' | 'expiresAt' | 'maxUses'> & { issuedAt: number }): WaiverEvent {
  return createWaiverEvent({ ...input, kind: 'op-waiver', expiresAt: input.issuedAt + MAX_TTL['op-waiver'], maxUses: 1 });
}

export function issueReviewCapEvent(input: Omit<WaiverEventInput, 'kind' | 'issuedAt' | 'expiresAt' | 'maxUses'> & { issuedAt: number }): WaiverEvent {
  return createWaiverEvent({ ...input, kind: 'review-cap', expiresAt: input.issuedAt + MAX_TTL['review-cap'], maxUses: 1 });
}

export function issueGateWaiverEvent(input: Omit<WaiverEventInput, 'kind' | 'issuedAt' | 'maxUses'> & { issuedAt: number }): WaiverEvent {
  if (!input.target.startsWith('run:')) throw new Error('gate waiver event must be scoped to one graph run');
  return createWaiverEvent({ ...input, kind: 'gate', maxUses: 1 });
}

export function evaluateWaiverEvent(event: WaiverEvent, context: {
  target: string;
  head: string;
  now: number;
  measuredRegression?: boolean;
  releaseEnded?: boolean;
}): WaiverEventDecision {
  const remaining = Math.max(0, event.maxUses - event.uses);
  const decision = (allowed: boolean, reason?: string, expiredBy?: WaiverEventExpiry): WaiverEventDecision => ({
    allowed, mode: event.mode, usesRemaining: remaining, ...(reason ? { reason } : {}), ...(expiredBy ? { expiredBy } : {}),
  });
  if (!validEvent(event) || !Number.isSafeInteger(context.now) || !HASH.test(context.head)) return decision(false, 'invalid-event-or-context');
  if (context.now < event.issuedAt) return decision(false, 'event not issued yet');
  if (event.promotedAt !== undefined && context.now < event.promotedAt) return decision(false, 'event not promoted yet');
  if (context.measuredRegression) return decision(false, 'measured-regression');
  if (event.target !== context.target) return decision(false, 'target-mismatch');
  if (event.head !== context.head.toLowerCase()) return decision(false, 'head changed', 'head-changed');
  if (event.expiredBy) return decision(false, `expired: ${event.expiredBy}`, event.expiredBy);
  if (context.now >= event.expiresAt) return decision(false, 'event lifetime ended', event.kind === 'gate' ? 'release-ended' : 'timeout');
  if (event.kind === 'gate' && context.releaseEnded) return decision(false, 'release ended', 'release-ended');
  if (remaining === 0) return decision(false, 'event use consumed', 'used');
  if (event.mode === 'shadow') return decision(false, 'shadow-only');
  return decision(true);
}

function sameGrant(left: WaiverEvent, right: WaiverEvent): boolean {
  return left.eventId === right.eventId && left.kind === right.kind && left.target === right.target
    && left.head === right.head && JSON.stringify(left.evidence) === JSON.stringify(right.evidence)
    && left.actor === right.actor && left.issuedAt === right.issuedAt && left.expiresAt === right.expiresAt
    && left.maxUses === right.maxUses;
}

function validateTransition(previous: WaiverEvent | undefined, next: WaiverEvent): void {
  if (!validEvent(next)) throw new Error('invalid waiver event');
  if (!previous) {
    if (next.uses !== 0 || next.expiredBy || next.consumedAt || next.expiredAt || next.promotedAt) throw new Error('invalid initial waiver event');
    return;
  }
  if (!sameGrant(previous, next) || previous.expiredBy) throw new Error('invalid waiver event transition');
  if (previous.mode === 'shadow' && next.mode === 'operational') {
    if (next.promotedAt === undefined || next.promotedAt < previous.issuedAt || next.promotedAt >= previous.expiresAt
      || next.uses !== 0 || next.expiredBy) throw new Error('invalid waiver promotion');
    return;
  }
  if (previous.mode !== 'operational' || next.mode !== 'operational') throw new Error('invalid waiver event transition');
  if (next.promotedAt !== previous.promotedAt) throw new Error('invalid waiver event transition');
  if (next.uses === 1 && previous.uses === 0 && next.expiredBy === 'used' && next.consumedAt !== undefined
    && next.consumedAt >= previous.issuedAt && next.consumedAt < previous.expiresAt
    && (previous.promotedAt === undefined || next.consumedAt >= previous.promotedAt)) return;
  if (next.uses === previous.uses && next.expiredBy !== undefined && next.expiredBy !== 'used'
    && next.expiredAt !== undefined && next.expiredAt >= previous.issuedAt
    && (next.expiredBy !== 'timeout' || next.expiredAt >= previous.expiresAt)
    && (next.expiredBy !== 'release-ended' || next.kind === 'gate')) return;
  throw new Error('invalid waiver event transition');
}

export function consumeWaiverEvent(event: WaiverEvent, context: {
  target: string; head: string; now: number; measuredRegression?: boolean; releaseEnded?: boolean;
}): WaiverEvent {
  const decision = evaluateWaiverEvent(event, context);
  if (!decision.allowed) throw new Error(`waiver event cannot be consumed: ${decision.reason ?? decision.expiredBy ?? 'denied'}`);
  const uses = event.uses + 1;
  return { ...event, uses, ...(uses >= event.maxUses ? { expiredBy: 'used' as const } : {}), consumedAt: context.now };
}

export function expireWaiverEvent(event: WaiverEvent, expiredBy: WaiverEventExpiry, now: number): WaiverEvent {
  if (event.mode !== 'operational' || event.expiredBy || now < event.issuedAt
    || (expiredBy === 'timeout' && now < event.expiresAt)
    || (expiredBy === 'release-ended' && event.kind !== 'gate')
    || expiredBy === 'used') throw new Error('only an active operational event can expire');
  return { ...event, expiredBy, expiredAt: now };
}

export function promoteWaiverEvent(event: WaiverEvent, now: number): WaiverEvent {
  if (!validEvent(event) || event.mode !== 'shadow' || now < event.issuedAt || now >= event.expiresAt || event.expiredBy || event.uses > 0) {
    throw new Error('only an active unused shadow event can be promoted');
  }
  return { ...event, mode: 'operational', promotedAt: now };
}

function acquireEventLock(lockPath: string): number {
  try {
    const fd = openSync(lockPath, 'wx', 0o600);
    try { writeSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() })); }
    catch (error) { closeSync(fd); unlinkSync(lockPath); throw error; }
    return fd;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  let owner = 'unknown';
  try {
    const metadata = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown; createdAt?: unknown };
    owner = `pid=${String(metadata.pid ?? 'unknown')} createdAt=${String(metadata.createdAt ?? 'unknown')}`;
  } catch { /* malformed lock remains fail-closed */ }
  throw new Error(`waiver event ledger lock exists (${owner}); verify the owner process is gone, then remove ${lockPath} to recover`);
}

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); }
  finally { closeSync(fd); }
}

let syncCreatedDirectoryParentForTest: ((path: string) => void) | undefined;

/** Test seam for durability ordering and fail-closed checks. */
export function setWaiverDirectorySyncForTest(sync: ((path: string) => void) | undefined): void {
  syncCreatedDirectoryParentForTest = sync;
}

function missingDirectoryChain(path: string): string[] {
  const missing: string[] = [];
  let current = path;
  while (!existsSync(current)) {
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return missing;
}

function syncCreatedDirectoryParents(createdDirectories: string[]): void {
  const sync = syncCreatedDirectoryParentForTest ?? syncDirectory;
  // mkdir -p creates the chain from its first missing ancestor toward the leaf.
  // Sync each containing directory in that same order so every new entry is durable.
  for (const created of [...createdDirectories].reverse()) sync(dirname(created));
}

/** Append-only ledger. Stale-lock recovery is manual: verify the recorded PID is gone before removing the named lock. */
export function appendWaiverEvent(path: string, event: WaiverEvent): void {
  appendWaiverEvents(path, [event]);
}

/** Append a related event transition under one lock, so issuance and consumption cannot be split by a crash. */
export function appendWaiverEvents(path: string, events: WaiverEvent[]): void {
  if (events.length === 0) return;
  const lockFd = acquireLedgerLock(path);
  try { appendWaiverEventsUnderLock(path, events); }
  finally { releaseLedgerLock(path, lockFd); }
}

/** Match and consume under one ledger lock so concurrent graph workers cannot authorize stale snapshots. */
export function consumeWaiverEventFromLedger(path: string, matches: (event: WaiverEvent) => boolean, context: {
  target: string; head: string; now: () => number; measuredRegression?: boolean; releaseEnded?: boolean;
}): WaiverEvent {
  const lockFd = acquireLedgerLock(path);
  try {
    const decisionContext = { ...context, now: context.now() };
    const eligible = readWaiverEvents(path).filter(matches)
      .filter((event) => evaluateWaiverEvent(event, decisionContext).allowed);
    if (eligible.length !== 1) throw new Error('release gate waiver event missing, ambiguous, or mismatched; graph transition refused');
    const consumed = consumeWaiverEvent(eligible[0]!, decisionContext);
    appendWaiverEventsUnderLock(path, [consumed]);
    return consumed;
  } finally { releaseLedgerLock(path, lockFd); }
}

function acquireLedgerLock(path: string): number {
  const directory = dirname(path);
  const lockPath = `${path}.lock`;
  if (process.platform === 'win32') {
    throw new Error('waiver event writes require durable directory fsync; Windows is unsupported and the waiver was not consumed');
  }
  const createdDirectories = missingDirectoryChain(directory);
  if (createdDirectories.length > 0) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    syncCreatedDirectoryParents(createdDirectories);
  }
  return acquireEventLock(lockPath);
}

function releaseLedgerLock(path: string, lockFd: number): void {
  closeSync(lockFd);
  unlinkSync(`${path}.lock`);
}

function appendWaiverEventsUnderLock(path: string, events: WaiverEvent[]): void {
  const directory = dirname(path);
  let temporary: string | undefined;
  try {
    const current = new Map(readWaiverEvents(path).map((item) => [item.eventId, item]));
    for (const event of events) {
      validateTransition(current.get(event.eventId), event);
      current.set(event.eventId, event);
    }
    let prior = '';
    try { prior = readFileSync(path, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const prefix = prior.length === 0 || prior.endsWith('\n') ? prior : `${prior}\n`;
    const buffer = Buffer.from(prefix + events.map((event) => JSON.stringify(event)).join('\n') + '\n');
    temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      let offset = 0;
      while (offset < buffer.length) {
        const written = writeSync(fd, buffer, offset, buffer.length - offset);
        if (written <= 0) throw new Error('waiver event ledger write made no progress');
        offset += written;
      }
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, path);
    temporary = undefined;
    syncDirectory(directory);
  } finally {
    if (temporary) try { unlinkSync(temporary); } catch { /* an interrupted append leaves only an ignored temp file */ }
  }
}

export function readWaiverEvents(path: string): WaiverEvent[] {
  let contents: string;
  try { contents = readFileSync(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const current = new Map<string, WaiverEvent>();
  for (const [index, line] of contents.split('\n').entries()) {
    if (!line) continue;
    let event: WaiverEvent;
    try {
      event = JSON.parse(line) as WaiverEvent;
      validateTransition(current.get(event.eventId), event);
    } catch { throw new Error(`invalid waiver event ledger row ${index + 1}`); }
    current.set(event.eventId, event);
  }
  return [...current.values()];
}
