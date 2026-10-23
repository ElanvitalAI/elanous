import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { debug } from '../debug/log.js';
import { normalizeSpaceId } from './harness-space.js';
import { decodeDetachedFrame, encodeDetachedFrame } from './dispatch-detached.js';

/** Final parent-resolved inbox directory handed to a child across state-root boundaries. */
export const CONTROL_INBOX_DIR_ENV = 'ELANOUS_CONTROL_INBOX_DIR';

export interface ControlInboxOptions {
  env?: NodeJS.ProcessEnv;
  /** Final absolute inbox directory resolved by the parent; skips state-root derivation when supplied. */
  explicitInboxDir?: string;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
}

export interface ControlMemoPayload {
  version: 1;
  kind: string;
  urgency: 'urgent' | 'normal';
  body: string;
}

/** Persistent, non-consuming soft-stop request written beside the ready-record inbox. */
export interface SoftStopRequest {
  version: 1;
  requestedAt: string;
}

export interface ControlInboxDrain {
  stop: boolean;
  count: number;
  /** Present for current drains; optional to preserve existing test-seam implementations. */
  memos?: string[];
  structuredMemos?: ControlMemoPayload[];
  memoEntries?: Array<{ body: string; structured?: ControlMemoPayload }>;
  /** Observation-only memo records that remain queued and were not delivered by this drain. */
  peekedMemos?: string[];
  peekedMemoEntries?: Array<{ body: string; structured?: ControlMemoPayload }>;
  /** Number of all delivered memo records, including legacy and malformed-frame fallbacks. */
  receivedCount?: number;
  structuredCount?: number;
  urgentCount?: number;
  malformedFallbackCount?: number;
  peekedReceivedCount?: number;
  peekedUrgentCount?: number;
  peekedMalformedFallbackCount?: number;
}

export interface ControlInboxSnapshot {
  /** `absent` means no producer has created the ready directory; `empty` means it exists without entries. */
  directory: 'absent' | 'empty' | 'present' | 'unreadable';
  stop: boolean;
  memoCount: number;
  /** Earliest ready-record filesystem mtime, or null when no record mtime could be read. */
  oldestMtimeMs: number | null;
  /** Ready records whose content or metadata could not be read. */
  unreadableCount: number;
}

export const CONTROL_MEMO_FRAME_PREFIX = 'CONTROL_MEMO_FRAME:';

type ControlInboxMessage =
  | { type: 'stop' }
  | { type: 'memo'; memo: string; structured?: ControlMemoPayload; malformedFallback?: boolean };

function normalizeControlMemoPayload(value: unknown): ControlMemoPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  const allowedKeys = new Set(['version', 'kind', 'urgency', 'body']);
  if (Object.keys(payload).some((key) => !allowedKeys.has(key))
    || payload.version !== 1 || typeof payload.kind !== 'string' || payload.kind.length === 0
    || (payload.urgency !== 'urgent' && payload.urgency !== 'normal')
    || typeof payload.body !== 'string' || payload.body.length === 0 || /[\r\n]/.test(payload.body)) return null;
  return { version: 1, kind: payload.kind, urgency: payload.urgency, body: payload.body };
}

export function encodeControlMemoFrame(payload: ControlMemoPayload): string {
  const normalized = normalizeControlMemoPayload(payload);
  if (!normalized) throw new TypeError('Invalid control memo payload');
  return encodeDetachedFrame(CONTROL_MEMO_FRAME_PREFIX, normalized);
}

export function decodeControlMemoFrame(line: string): ControlMemoPayload | null {
  return decodeDetachedFrame(line, CONTROL_MEMO_FRAME_PREFIX, normalizeControlMemoPayload);
}

function stateRoot(env: NodeJS.ProcessEnv): string {
  const configured = env.ELANOUS_STATE_DIR?.trim();
  return configured || elanousStateRoot();
}

/** Resolve the legacy inbox directory from the unchanged harness-space identifier. */
export function controlInboxPath(spaceId: string, env: NodeJS.ProcessEnv = process.env): string {
  const safe = normalizeSpaceId(spaceId).replace(/\//g, '-') || 'unknown';
  return join(stateRoot(env), 'harness-screens', `${safe}.inbox`);
}

/** Resolve the final inbox directory, honoring an explicit or inherited parent handoff before legacy derivation. */
export function resolveControlInboxDir(spaceId: string, opts: Pick<ControlInboxOptions, 'env' | 'explicitInboxDir'> = {}): string {
  const env = opts.env ?? process.env;
  const explicitInboxDir = opts.explicitInboxDir?.trim() || env[CONTROL_INBOX_DIR_ENV]?.trim();
  if (explicitInboxDir) {
    if (!isAbsolute(explicitInboxDir)) throw new Error('explicit control inbox directory must be absolute');
    return explicitInboxDir;
  }
  return controlInboxPath(spaceId, env);
}

export function controlInboxEnv(inboxDir: string): Record<typeof CONTROL_INBOX_DIR_ENV, string> {
  if (!isAbsolute(inboxDir)) throw new Error('control inbox directory handoff must be absolute');
  return { [CONTROL_INBOX_DIR_ENV]: inboxDir };
}

function readyPath(path: string): string {
  return `${path}.ready`;
}

function softStopRequestPath(path: string): string {
  return join(path, 'stop-requested.json');
}

function normalizeSoftStopRequest(value: unknown): SoftStopRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const request = value as Record<string, unknown>;
  const allowedKeys = new Set(['version', 'requestedAt']);
  if (Object.keys(request).some((key) => !allowedKeys.has(key))
    || request.version !== 1 || typeof request.requestedAt !== 'string'
    || Number.isNaN(Date.parse(request.requestedAt))) return null;
  return { version: 1, requestedAt: request.requestedAt };
}

export type SoftStopRequestRead =
  | { status: 'present'; request: SoftStopRequest }
  | { status: 'absent' }
  | { status: 'read-failed'; code: string };

/**
 * Read a persistent stop request without consuming it.
 * Absence, a read failure, and a malformed payload stay distinct: only a missing file is `absent`.
 */
export function readSoftStopRequestStatus(spaceId: string, opts: ControlInboxOptions = {}): SoftStopRequestRead {
  const inboxDir = resolveControlInboxDir(spaceId, opts);
  const path = softStopRequestPath(inboxDir);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      logger(opts)('control-inbox', 'soft-stop-request-absent', { spaceId, path });
      return { status: 'absent' };
    }
    const failed = code ?? 'unknown';
    logger(opts)('control-inbox', 'soft-stop-request-read-failed', { spaceId, path, code: failed });
    return { status: 'read-failed', code: failed };
  }

  let request: SoftStopRequest | null = null;
  try {
    request = normalizeSoftStopRequest(JSON.parse(raw) as unknown);
  } catch {
    // The validation event below covers syntactically invalid JSON as an invalid payload.
  }
  if (request) return { status: 'present', request };
  logger(opts)('control-inbox', 'soft-stop-request-validation-failed', { spaceId, path });
  return { status: 'read-failed', code: 'invalid' };
}

/** Read a persistent stop request without consuming it; malformed and unreadable files fail closed to null. */
export function readSoftStopRequest(spaceId: string, opts: ControlInboxOptions = {}): SoftStopRequest | null {
  const read = readSoftStopRequestStatus(spaceId, opts);
  return read.status === 'present' ? read.request : null;
}

function logger(opts: ControlInboxOptions): (category: string, event: string, data: Record<string, unknown>) => void {
  return opts.log ?? ((category, event, data) => debug.log(category, event, data));
}

function encode(message: ControlInboxMessage): string {
  return message.type === 'stop' ? 'stop\n' : `memo:${message.memo}\n`;
}

function decode(content: string): ControlInboxMessage | null {
  const line = content.endsWith('\n') ? content.slice(0, -1) : content;
  if (line === 'stop') return { type: 'stop' };
  if (line.startsWith('memo:') && line.length > 'memo:'.length && !/[\r\n]/.test(line)) {
    const memo = line.slice('memo:'.length);
    if (!memo.startsWith(CONTROL_MEMO_FRAME_PREFIX)) return { type: 'memo', memo };
    const structured = decodeControlMemoFrame(memo);
    return structured
      ? { type: 'memo', memo: structured.body, structured }
      : { type: 'memo', memo, malformedFallback: true };
  }
  return null;
}

const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Restore count lives in the ready name (`.rN`) so persist+restore is one exclusive link. */
const RESTORE_SUFFIX_RE = /\.r([1-9]\d*)$/;
/** 게시 순서를 이름에 실은 레코드. 접두는 «단조 증가»라 문자열 정렬이 곧 게시 순서다. */
const SEQUENCED_RECORD_RE = new RegExp(`^record-([0-9a-f]{16})-${UUID_RE}(?:\\.r[1-9]\\d*)?$`, 'i');
const LEGACY_RECORD_RE = new RegExp(`^record-${UUID_RE}(?:\\.r[1-9]\\d*)?$`, 'i');
const STOP_RECORD_RE = /^stop(?:\.r[1-9]\d*)?$/;

function isStopRecord(name: string): boolean {
  return STOP_RECORD_RE.test(name);
}

function isReadyRecord(name: string): boolean {
  return isStopRecord(name) || SEQUENCED_RECORD_RE.test(name) || LEGACY_RECORD_RE.test(name);
}

function restoreCountFromName(name: string): number {
  const matched = RESTORE_SUFFIX_RE.exec(name);
  if (!matched) return 0;
  const count = Number(matched[1]);
  return Number.isSafeInteger(count) ? count : 0;
}

function recordBaseName(name: string): string {
  return name.replace(RESTORE_SUFFIX_RE, '');
}

function restoredRecordName(name: string, restoreCount: number): string {
  return `${recordBaseName(name)}.r${restoreCount}`;
}

/** ⭐ 게시 순서 키 — ⛔ 분산 락을 쓰지 않는다.
 *
 *  🔑 필요한 계약은 ***「실린 순서대로 배달」***뿐이고, 그것은 «이름»으로 충분하다:
 *    ⓐ 같은 프로세스   밀리초가 같아도 프로세스 내 카운터가 갈라 준다
 *    ⓑ 다른 프로세스   밀리초 시각이 갈라 준다 — 그리고 «그것이» 실린 순서의 정의다
 *  ⛔ 전역 순번 파일·잠금을 쓰면 TOCTOU·PID 재사용·비원자적 카운터가 따라온다(무인 리뷰가 그 셋을 다 잡았다).
 *  ⚠️ legacy `record-<uuid>` 는 접두가 «없어» 빈 키가 되고 정렬에서 «먼저» 온다 —
 *    오래된 레코드가 새 레코드 뒤로 가지 않는다(업그레이드 경계 보존). */
let publishCounter = 0;
function nextSequencePrefix(): string {
  const millis = Date.now().toString(16).padStart(12, '0').slice(-12);
  publishCounter = (publishCounter + 1) & 0xffff;
  return `${millis}${publishCounter.toString(16).padStart(4, '0')}`;
}
function recordSortKey(name: string): string {
  const matched = SEQUENCED_RECORD_RE.exec(name);
  return matched?.[1] ?? '';
}

/** Publishes one record and returns its absolute path (the consumer claims and removes it on read). */
function enqueue(message: ControlInboxMessage, spaceId: string, opts: ControlInboxOptions): string {
  const path = resolveControlInboxDir(spaceId, opts);
  const ready = readyPath(path);
  const id = randomUUID();
  const tempPath = join(ready, `.write-${process.pid}-${id}`);
  const recordPath = join(ready, message.type === 'stop' ? 'stop' : `record-${nextSequencePrefix()}-${id}`);
  mkdirSync(ready, { recursive: true });
  try {
    writeFileSync(tempPath, encode(message), { encoding: 'utf8', flag: 'wx' });
    if (message.type === 'stop') {
      try {
        linkSync(tempPath, recordPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } else {
      renameSync(tempPath, recordPath);
    }
  } finally {
    try { rmSync(tempPath); } catch { /* publication renamed or link-created it */ }
  }
  logger(opts)('control-inbox', `${message.type}-enqueue`, { spaceId, path: recordPath });
  return recordPath;
}

/**
 * Write the durable marker `readSoftStopRequest` reads, without replacing an existing file.
 * The first `requestedAt` stays. A failed write is observed and does not undo the ready/stop record.
 */
function writeDurableSoftStopMarker(spaceId: string, opts: ControlInboxOptions): void {
  const inboxDir = resolveControlInboxDir(spaceId, opts);
  const markerPath = softStopRequestPath(inboxDir);
  if (existsSync(markerPath)) {
    logger(opts)('control-inbox', 'soft-stop-request-kept', { spaceId, path: markerPath });
    return;
  }
  mkdirSync(inboxDir, { recursive: true });
  const marker: SoftStopRequest = { version: 1, requestedAt: new Date().toISOString() };
  const tempPath = join(inboxDir, `.stop-requested-${process.pid}-${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, `${JSON.stringify(marker)}\n`, { encoding: 'utf8', flag: 'wx' });
    try {
      linkSync(tempPath, markerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      logger(opts)('control-inbox', 'soft-stop-request-kept', { spaceId, path: markerPath });
      return;
    }
    logger(opts)('control-inbox', 'soft-stop-request-written', { spaceId, path: markerPath, requestedAt: marker.requestedAt });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    logger(opts)('control-inbox', 'soft-stop-request-write-failed', { spaceId, path: markerPath, code: code ?? 'unknown' });
  } finally {
    try { rmSync(tempPath); } catch { /* published via link, or the write never created it */ }
  }
}

/** Queue the idempotent soft-stop latch and the durable marker, without rewriting either if it already exists. */
export function enqueueSoftStop(spaceId: string, opts: ControlInboxOptions = {}): void {
  enqueue({ type: 'stop' }, spaceId, opts);
  writeDurableSoftStopMarker(spaceId, opts);
}

/** Queue a non-empty, single-line legacy memo or a structured memo for the next drain. */
/** Returns the published record path — it disappears once the child's drain claims it. */
export function enqueueControlMemo(spaceId: string, memo: string | ControlMemoPayload, opts: ControlInboxOptions = {}): string {
  const encoded = typeof memo === 'string' ? memo : encodeControlMemoFrame(memo);
  if (encoded.length === 0 || /[\r\n]/.test(encoded)) {
    throw new Error('control inbox memo must be a non-empty single line');
  }
  return enqueue({ type: 'memo', memo: encoded }, spaceId, opts);
}

function restoreClaim(claimPath: string, recordPath: string, spaceId: string, opts: ControlInboxOptions): { restoreCount: number; restoredPath: string } | null {
  const dir = dirname(recordPath);
  const originalName = basename(recordPath);
  let restoreCount = restoreCountFromName(originalName) + 1;
  const fail = (restoredPath: string, code: string, error: unknown): null => {
    logger(opts)('control-inbox', 'drain-restore-failed', {
      spaceId, path: restoredPath, claimPath, code, error: error instanceof Error ? error.message : String(error),
    });
    try {
      linkSync(claimPath, recordPath);
      try { rmSync(claimPath); } catch { /* original name restored via extra hardlink */ }
    } catch { /* keep the claim rather than delete or clobber it */ }
    return null;
  };
  while (Number.isSafeInteger(restoreCount)) {
    const restoredPath = join(dir, restoredRecordName(originalName, restoreCount));
    logger(opts)('control-inbox', 'drain-restore-attempt', {
      spaceId, path: restoredPath, claimPath, restoreCount,
    });
    try {
      // Exclusive: POSIX rename overwrites an existing `.rN`; link fails with EEXIST instead.
      linkSync(claimPath, restoredPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        restoreCount += 1;
        continue;
      }
      return fail(restoredPath, code ?? 'unknown', error);
    }
    try { rmSync(claimPath); } catch { /* restored via extra hardlink */ }
    return { restoreCount, restoredPath };
  }
  return fail(recordPath, 'overflow', 'restore count exceeded a safe integer');
}

function preserveClaim(
  claimPath: string,
  recordPath: string,
  spaceId: string,
  opts: ControlInboxOptions,
  reason: string,
): void {
  const restored = restoreClaim(claimPath, recordPath, spaceId, opts);
  if (!restored) return;
  logger(opts)('control-inbox', 'drain-record-preserved', {
    spaceId, path: restored.restoredPath, reason, restoreCount: restored.restoreCount,
  });
}

function findRestoredSibling(path: string): string | undefined {
  const dir = dirname(path);
  const base = basename(path);
  try {
    let best: string | undefined;
    let bestCount = 0;
    for (const name of readdirSync(dir)) {
      if (recordBaseName(name) !== base) continue;
      const count = restoreCountFromName(name);
      if (count > bestCount) {
        best = name;
        bestCount = count;
      }
    }
    return best ? join(dir, best) : undefined;
  } catch {
    return undefined;
  }
}

function buildMemoDrainFields(memoMessages: Array<Extract<ControlInboxMessage, { type: 'memo' }>>, prefix = ''): Partial<ControlInboxDrain> {
  const structuredMemos = memoMessages.flatMap((message) => message.structured ? [message.structured] : []);
  const entries = memoMessages.map((message) => ({ body: message.memo, ...(message.structured ? { structured: message.structured } : {}) }));
  const fields: Partial<ControlInboxDrain> = prefix === 'peeked' ? {
    peekedMemos: memoMessages.map((message) => message.memo),
    peekedMemoEntries: entries,
    peekedReceivedCount: memoMessages.length,
    peekedUrgentCount: structuredMemos.filter((memo) => memo.urgency === 'urgent').length,
    peekedMalformedFallbackCount: memoMessages.filter((message) => message.malformedFallback).length,
  } : {
    memos: memoMessages.map((message) => message.memo),
    structuredMemos,
    memoEntries: entries,
    receivedCount: memoMessages.length,
    structuredCount: structuredMemos.length,
    urgentCount: structuredMemos.filter((memo) => memo.urgency === 'urgent').length,
    malformedFallbackCount: memoMessages.filter((message) => message.malformedFallback).length,
  };
  return fields;
}

function consumeRecord(
  recordPath: string,
  spaceId: string,
  opts: ControlInboxOptions,
  messages: ControlInboxMessage[],
): void {
  const claimPath = `${recordPath}.claim-${process.pid}-${randomUUID()}`;
  try {
    renameSync(recordPath, claimPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger(opts)('control-inbox', 'drain-claim-failed', { spaceId, path: recordPath, code: code ?? 'unknown' });
    }
    return;
  }

  let message: ControlInboxMessage | null = null;
  try {
    message = decode(readFileSync(claimPath, 'utf8'));
  } catch (error) {
    preserveClaim(claimPath, recordPath, spaceId, opts, error instanceof Error ? error.message : String(error));
    return;
  }
  if (!message) {
    preserveClaim(claimPath, recordPath, spaceId, opts, 'undecodable');
    return;
  }

  try {
    rmSync(claimPath);
  } catch (error) {
    preserveClaim(claimPath, recordPath, spaceId, opts, error instanceof Error ? error.message : String(error));
    return;
  }
  messages.push(message);
  // A Pod sender asks for this exact record's acknowledgement before publishing
  // it. Missing ack is safe: delivery has happened, but the sender must report
  // read state as unobserved rather than infer it from file disappearance.
  if (existsSync(`${recordPath}.ack-request`)) {
    // Rename consumes the request atomically. If the sender already removed it,
    // this cannot leave a late ack file after the sender's cleanup.
    try { renameSync(`${recordPath}.ack-request`, `${recordPath}.ack`); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        logger(opts)('control-inbox', 'memo-ack-failed', { spaceId, path: recordPath, reason: String(error) });
    }
  }
}

/** Inspect existing ready records without claiming, deleting, or creating any inbox entry. */
export function inspectControlInbox(spaceId: string, opts: ControlInboxOptions = {}): ControlInboxSnapshot {
  const path = resolveControlInboxDir(spaceId, opts);
  const ready = readyPath(path);
  let names: string[];
  try {
    names = readdirSync(ready);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { directory: 'absent', stop: false, memoCount: 0, oldestMtimeMs: null, unreadableCount: 0 };
    logger(opts)('control-inbox', 'inspect-failed', { spaceId, path: ready, code: code ?? 'unknown' });
    return { directory: 'unreadable', stop: false, memoCount: 0, oldestMtimeMs: null, unreadableCount: 0 };
  }
  if (names.length === 0) return { directory: 'empty', stop: false, memoCount: 0, oldestMtimeMs: null, unreadableCount: 0 };

  let stop = false;
  let memoCount = 0;
  let oldestMtimeMs: number | null = null;
  let unreadableCount = 0;
  for (const name of names) {
    if (!isReadyRecord(name)) continue;
    // A stop latch is identified by its published record name. Its unreadable
    // content must not hide the producer's stop request from observation.
    if (isStopRecord(name)) stop = true;
    const recordPath = join(ready, name);
    try {
      const mtimeMs = statSync(recordPath).mtimeMs;
      oldestMtimeMs = oldestMtimeMs === null ? mtimeMs : Math.min(oldestMtimeMs, mtimeMs);
      const message = decode(readFileSync(recordPath, 'utf8'));
      if (!message) {
        unreadableCount += 1;
      } else if (message.type === 'stop') {
        stop = true;
      } else {
        memoCount += 1;
      }
    } catch {
      unreadableCount += 1;
    }
  }
  const result = { directory: 'present' as const, stop, memoCount, oldestMtimeMs, unreadableCount };
  logger(opts)('control-inbox', 'inspect', { spaceId, path: ready, ...result });
  return result;
}

/**
 * Remove ready records whose filesystem mtime is at least `maxAgeMs` old at invocation.
 * Claims use the drain protocol; a consumer that wins a claim is silently left untouched.
 */
export function cleanupStaleControlInbox(spaceId: string, maxAgeMs: number, opts: ControlInboxOptions = {}): number {
  if (typeof maxAgeMs !== 'number' || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    throw new TypeError('control inbox stale age must be a finite non-negative number');
  }

  const path = resolveControlInboxDir(spaceId, opts);
  const ready = readyPath(path);
  const cutoff = Date.now() - maxAgeMs;
  let records: string[] = [];
  try {
    records = readdirSync(ready).filter(isReadyRecord);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') logger(opts)('control-inbox', 'cleanup-failed', { spaceId, path: ready, code: code ?? 'unknown' });
  }

  let count = 0;
  for (const name of records) {
    const recordPath = join(ready, name);
    try {
      if (statSync(recordPath).mtimeMs > cutoff) continue;
    } catch {
      continue;
    }

    const claimPath = `${recordPath}.claim-${process.pid}-${randomUUID()}`;
    logger(opts)('control-inbox', 'cleanup-claim-attempt', { spaceId, path: recordPath, claimPath });
    try {
      renameSync(recordPath, claimPath);
    } catch {
      continue;
    }
    try {
      rmSync(claimPath);
      count += 1;
    } catch (error) {
      logger(opts)('control-inbox', 'cleanup-record-preserved', {
        spaceId, path: claimPath, reason: error instanceof Error ? error.message : String(error),
      });
      restoreClaim(claimPath, recordPath, spaceId, opts);
    }
  }
  // A sender killed without an EXIT trap can leave receipt markers behind.
  // Its wait is capped at 60s; keep at least two minutes before sweeping only
  // markers whose exact record no longer exists. Never infer a read from cleanup.
  let markerCount = 0;
  let tempCount = 0;
  let markerNames: string[] = [];
  try { markerNames = readdirSync(ready); } catch { /* absent ready directory */ }
  const markerCutoff = Date.now() - Math.max(maxAgeMs, 120_000);
  for (const name of markerNames) {
    // Only the Pod publisher's mktemp shape; local enqueue has a different name.
    if (/^\.write-[A-Za-z0-9]{8}$/.test(name)) {
      const tempPath = join(ready, name);
      try {
        if (statSync(tempPath).mtimeMs > markerCutoff) continue;
        rmSync(tempPath);
        tempCount += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          logger(opts)('control-inbox', 'cleanup-temp-failed', { spaceId, path: tempPath, reason: String(error) });
      }
      continue;
    }
    const suffix = name.endsWith('.ack-request') ? '.ack-request' : name.endsWith('.ack') ? '.ack' : null;
    if (!suffix) continue;
    const recordName = name.slice(0, -suffix.length);
    if (!isReadyRecord(recordName) || existsSync(join(ready, recordName))) continue;
    const markerPath = join(ready, name);
    try {
      if (statSync(markerPath).mtimeMs > markerCutoff) continue;
      rmSync(markerPath);
      markerCount += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        logger(opts)('control-inbox', 'cleanup-marker-failed', { spaceId, path: markerPath, reason: String(error) });
    }
  }
  logger(opts)('control-inbox', 'cleanup', { spaceId, path, maxAgeMs, count, markerCount, tempCount });
  return count;
}

function drainLegacyInbox(path: string, spaceId: string, opts: ControlInboxOptions, messages: ControlInboxMessage[]): void {
  let target = path;
  try {
    if (!statSync(target).isFile()) return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger(opts)('control-inbox', 'drain-claim-failed', { spaceId, path: target, code: code ?? 'unknown' });
      return;
    }
    const restored = findRestoredSibling(path);
    if (!restored) return;
    try {
      if (!statSync(restored).isFile()) return;
    } catch {
      return;
    }
    target = restored;
  }

  const claimPath = `${target}.claim-${process.pid}-${randomUUID()}`;
  try {
    renameSync(target, claimPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      logger(opts)('control-inbox', 'drain-claim-failed', { spaceId, path: target, code: code ?? 'unknown' });
    }
    return;
  }

  let legacyMessages: ControlInboxMessage[];
  try {
    const content = readFileSync(claimPath, 'utf8');
    const decoded = content.split(/\r?\n/).filter(Boolean).map((line) => decode(`${line}\n`));
    if (decoded.some((message) => !message)) throw new Error('undecodable-legacy');
    legacyMessages = decoded as ControlInboxMessage[];
  } catch (error) {
    preserveClaim(claimPath, target, spaceId, opts, error instanceof Error ? error.message : String(error));
    return;
  }
  try {
    rmSync(claimPath);
  } catch (error) {
    preserveClaim(claimPath, target, spaceId, opts, error instanceof Error ? error.message : String(error));
    return;
  }
  messages.push(...legacyMessages);
}

/** Consume ready `stop` latches, including restore-suffixed names, without modifying memo records. */
export function drainSoftStopControlInbox(spaceId: string, opts: ControlInboxOptions = {}): ControlInboxDrain {
  const path = resolveControlInboxDir(spaceId, opts);
  const ready = readyPath(path);
  const messages: ControlInboxMessage[] = [];
  consumeRecord(join(ready, 'stop'), spaceId, opts, messages);

  const peekedMessages: ControlInboxMessage[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(ready);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger(opts)('control-inbox', 'soft-stop-peek-failed', { spaceId, path: ready, code: code ?? 'unknown' });
    }
  }
  for (const name of names) {
    if (name !== 'stop' && isStopRecord(name)) consumeRecord(join(ready, name), spaceId, opts, messages);
  }
  const records = names.filter((name) => !isStopRecord(name) && isReadyRecord(name))
    .sort((left, right) => (recordSortKey(left) < recordSortKey(right) ? -1
      : recordSortKey(left) > recordSortKey(right) ? 1 : left < right ? -1 : left > right ? 1 : 0));
  for (const name of records) {
    let message: ControlInboxMessage | null = null;
    try {
      message = decode(readFileSync(join(ready, name), 'utf8'));
    } catch {
      continue;
    }
    if (message?.type === 'memo') peekedMessages.push(message);
  }

  const peekedMemoMessages = peekedMessages.filter((message): message is Extract<ControlInboxMessage, { type: 'memo' }> => message.type === 'memo');
  const result: ControlInboxDrain = {
    stop: messages.some((message) => message.type === 'stop'),
    count: messages.length,
    memos: [],
    structuredMemos: [],
    memoEntries: [],
    receivedCount: 0,
    structuredCount: 0,
    urgentCount: 0,
    malformedFallbackCount: 0,
    ...buildMemoDrainFields(peekedMemoMessages, 'peeked'),
  };
  logger(opts)('control-inbox', 'soft-stop-drain', { spaceId, path, ...result });
  return result;
}

/**
 * Drain a stable snapshot of complete records. Producers publish only after an atomic rename;
 * each consumer atomically claims an exact ready name, restores failed claims, and returns only
 * records whose claimed file was successfully deleted.
 */
export function drainControlInbox(spaceId: string, opts: ControlInboxOptions = {}): ControlInboxDrain {
  const path = resolveControlInboxDir(spaceId, opts);
  const ready = readyPath(path);
  const messages: ControlInboxMessage[] = [];

  drainLegacyInbox(path, spaceId, opts, messages);
  let records: string[] = [];
  try {
    // ⭐ 게시 순서대로 배달한다 — 이름의 단조 접두가 곧 그 순서다(위 nextSequencePrefix 주석).
    //   ⛔ `readdirSync` 의 반환 순서는 파일시스템 «구현»이지 게시 순서가 아니다.
    records = readdirSync(ready).filter(isReadyRecord)
      .sort((left, right) => (recordSortKey(left) < recordSortKey(right) ? -1
        : recordSortKey(left) > recordSortKey(right) ? 1 : left < right ? -1 : left > right ? 1 : 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger(opts)('control-inbox', 'drain-failed', { spaceId, path: ready, code: code ?? 'unknown' });
    }
  }
  for (const name of records) consumeRecord(join(ready, name), spaceId, opts, messages);

  const memoMessages = messages.filter((message): message is Extract<ControlInboxMessage, { type: 'memo' }> => message.type === 'memo');
  const result: ControlInboxDrain = {
    stop: messages.some((message) => message.type === 'stop'),
    count: messages.length,
    ...buildMemoDrainFields(memoMessages),
  };
  logger(opts)('control-inbox', 'drain', { spaceId, path, ...result });
  return result;
}
