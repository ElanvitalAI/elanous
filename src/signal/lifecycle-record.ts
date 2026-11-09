import { isObject, isStringArray } from '../primitives/guards.js';
// ── Signal exchange · LifecycleRecord (S1) ──
//
// Structured lifecycle declarations over the local ChannelBus. This
// contract is intentionally producer-free: S2 wires child emission and
// S3 carries records across processes. Consumers can use the per-child
// stream or the aggregate in-process fan-in channel.

import type { ChannelBus, ChannelMessage, ChannelSubscription, SubscribeOpts } from '../terminal-matrix/channel-bus.js';

export type SignalClass = 'progress' | 'condition' | 'event';
export type SignalRole = 'child' | 'parent' | 'brain' | 'coordinator';
export type ProgressName = 'started' | 'progress' | 'complete' | 'failed';
export type ConditionName = 'awaiting-input' | 'ownership-lent';
export type EventName = 'action-refused';
export type LifecycleName = ProgressName | ConditionName | EventName;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject { readonly [key: string]: JsonValue; }

export interface OwnershipLentPayload { readonly actor: string; readonly mode: string; }
export interface AwaitingInputPayload { readonly prompt: string; }
export interface ActionRefusedPayload { readonly tools: readonly string[]; readonly by: string; readonly retryable: boolean; }
export interface CompletePayload { readonly summary: string; readonly changedFiles: readonly string[]; readonly verification?: string; }
export interface FailedPayload { readonly reason: string; }
/** Free progress metadata must be serializable before it can enter ChannelBus. */
export type ProgressPayload = JsonObject;

interface LifecycleEnvelope {
  readonly runId: string;
  /** Producer PTY: scopes seq and the bridge deduplication key. */
  readonly ptyId: string;
  /** Subject PTY: the PTY this lifecycle declaration describes. */
  readonly subjectPtyId: string;
  /** Nested ELANOUS_NEST_DEPTH, validated as a non-negative integer. */
  readonly depth: number;
  readonly role: SignalRole;
  /** Monotonic only within this ptyId producer. */
  readonly seq: number;
  readonly at: number;
}

type Untruncated = { readonly truncated: false; readonly truncatedFields?: never };
type Truncated = { readonly truncated: true; readonly truncatedFields: readonly [string, ...string[]] };
type TruncationState = Untruncated | Truncated;

export type StartedLifecycleRecord = LifecycleEnvelope & { readonly class: 'progress'; readonly name: 'started'; readonly payload?: ProgressPayload };
export type ProgressLifecycleRecord = LifecycleEnvelope & { readonly class: 'progress'; readonly name: 'progress'; readonly payload?: ProgressPayload };
export type CompleteLifecycleRecord = LifecycleEnvelope & { readonly class: 'progress'; readonly name: 'complete'; readonly payload: CompletePayload };
export type FailedLifecycleRecord = LifecycleEnvelope & { readonly class: 'progress'; readonly name: 'failed'; readonly payload: FailedPayload };
export type AwaitingInputEnterLifecycleRecord = LifecycleEnvelope & { readonly class: 'condition'; readonly name: 'awaiting-input'; readonly transition: 'enter'; readonly resumable: boolean; readonly payload: AwaitingInputPayload };
export type AwaitingInputExitLifecycleRecord = LifecycleEnvelope & { readonly class: 'condition'; readonly name: 'awaiting-input'; readonly transition: 'exit'; readonly resumable?: never; readonly payload: AwaitingInputPayload };
export type OwnershipLentEnterLifecycleRecord = LifecycleEnvelope & { readonly class: 'condition'; readonly name: 'ownership-lent'; readonly transition: 'enter'; readonly resumable: boolean; readonly payload: OwnershipLentPayload };
export type OwnershipLentExitLifecycleRecord = LifecycleEnvelope & { readonly class: 'condition'; readonly name: 'ownership-lent'; readonly transition: 'exit'; readonly resumable?: never; readonly payload: OwnershipLentPayload };
export type ActionRefusedLifecycleRecord = LifecycleEnvelope & { readonly class: 'event'; readonly name: 'action-refused'; readonly payload: ActionRefusedPayload };

type LifecycleRecordBody =
  | StartedLifecycleRecord | ProgressLifecycleRecord | CompleteLifecycleRecord | FailedLifecycleRecord
  | AwaitingInputEnterLifecycleRecord | AwaitingInputExitLifecycleRecord
  | OwnershipLentEnterLifecycleRecord | OwnershipLentExitLifecycleRecord
  | ActionRefusedLifecycleRecord;

/** Each name, payload, condition transition, and truncation state is coupled at compile time. */
export type LifecycleRecord = LifecycleRecordBody & TruncationState;

export const LIFECYCLE_CHANNEL_PREFIX = 'lifecycle';

/** Per-child channel name. ptyId, not runId, is the producer key —
 *  `seq` is producer-scoped for the same reason (RFC §4b-2-i). */
export function channelForChild(ptyId: string): string {
  return `${LIFECYCLE_CHANNEL_PREFIX}:${ptyId}`;
}

/** Run-scoped fan-in key (RFC §4c). ⭐ This is an EXACT key, so the bus's
 *  exact-key matching (G5 — no wildcard/prefix subscribe) is no obstacle:
 *  a coordinator subscribing here receives exactly one run's children and
 *  never has to filter foreign runs out. An earlier draft used a single
 *  global `lifecycle-all`, which mixed concurrent runs and made correct
 *  consumption depend on every subscriber remembering to filter by runId —
 *  a silent cross-run hazard. Isolation belongs in the key, not in a
 *  discipline each consumer must re-derive. */
export function aggregateChannelForRun(runId: string): string {
  return `run/${runId}/lifecycle`;
}

const VALID_ROLES: ReadonlySet<SignalRole> = new Set(['child', 'parent', 'brain', 'coordinator']);
/** class↔name coupling keyed by the SignalClass discriminant itself. */
const NAMES_BY_CLASS: Record<SignalClass, ReadonlySet<LifecycleName>> = {
  progress: new Set<ProgressName>(['started', 'progress', 'complete', 'failed']),
  condition: new Set<ConditionName>(['awaiting-input', 'ownership-lent']),
  event: new Set<EventName>(['action-refused']),
};
const VALID_CLASSES: ReadonlySet<SignalClass> = new Set(Object.keys(NAMES_BY_CLASS) as SignalClass[]);
/** ⭐ Truncatable fields are per-NAME, not global. A global allowlist let a
 *  `started` record claim `truncatedFields: ['reason']` — a truncation of a
 *  field that record kind does not even have. The flag would then read as
 *  "something was cut" when nothing was, which is exactly the false-signal
 *  class the truncation contract exists to prevent (RFC §4b-2-ii ③). */
const TRUNCATABLE_FIELDS_BY_NAME: Record<LifecycleName, ReadonlySet<string>> = {
  started: new Set(),
  progress: new Set(),
  complete: new Set(['summary', 'changedFiles']),
  failed: new Set(['reason']),
  'awaiting-input': new Set(['prompt']),
  'ownership-lent': new Set(),
  'action-refused': new Set(),
};

/** Depth ceiling for payload validation. Deeply nested input is rejected
 *  structurally (returns false) rather than blowing the stack — the
 *  boundary contract is "malformed → null, never throw". */
const MAX_PAYLOAD_DEPTH = 32;

function isJsonValue(value: unknown, ancestors: ReadonlySet<object> = new Set(), depth = 0): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  // `ancestors` catches cycles; `depth` catches the acyclic-but-deep case
  // that would otherwise recurse until the stack gives out.
  if (depth >= MAX_PAYLOAD_DEPTH) return false;
  if (ancestors.has(value)) return false;
  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, nextAncestors, depth + 1));
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every((item) => isJsonValue(item, nextAncestors, depth + 1));
}

/** Field bounds enforced both here (validation) and in applyTruncation
 *  (production). A truncated field's final length equals its limit, so
 *  a validly-truncated record still passes the `<= limit` check. */
const PROMPT_MAX = 240;
const REASON_MAX = 240;
const SUMMARY_MAX = 4_000;
const CHANGED_FILES_MAX = 50;

function validatePayload(name: LifecycleName, payload: unknown): string | null {
  if (payload !== undefined && !isJsonValue(payload)) return 'payload';
  if (name === 'started' || name === 'progress') return payload === undefined || isObject(payload) ? null : 'payload';
  if (!isObject(payload)) return 'payload';
  if (name === 'ownership-lent') return typeof payload.actor === 'string' && typeof payload.mode === 'string' ? null : 'payload';
  if (name === 'awaiting-input') {
    if (typeof payload.prompt !== 'string') return 'payload';
    return payload.prompt.length <= PROMPT_MAX ? null : 'payload';
  }
  if (name === 'action-refused') return isStringArray(payload.tools) && typeof payload.by === 'string' && typeof payload.retryable === 'boolean' ? null : 'payload';
  if (name === 'complete') {
    if (typeof payload.summary !== 'string' || !isStringArray(payload.changedFiles)) return 'payload';
    if (payload.verification !== undefined && typeof payload.verification !== 'string') return 'payload';
    return payload.summary.length <= SUMMARY_MAX && payload.changedFiles.length <= CHANGED_FILES_MAX ? null : 'payload';
  }
  if (typeof payload.reason !== 'string') return 'payload';
  return payload.reason.length <= REASON_MAX ? null : 'payload';
}

/** Structural validation. Returns null when valid, otherwise the violated field. */
export function validateLifecycleRecord(candidate: unknown): string | null {
  if (!isObject(candidate)) return 'not an object';
  // parentPtyId is deliberately absent from the contract (RFC §4b-2): no
  // propagation rule exists to fill it. Reject its own-property presence
  // even when the value is undefined, so it cannot ride through and then
  // vanish in serialization (which would break the strict round-trip).
  if (Object.prototype.hasOwnProperty.call(candidate, 'parentPtyId')) return 'parentPtyId';
  if (typeof candidate.runId !== 'string' || candidate.runId.length === 0) return 'runId';
  if (typeof candidate.ptyId !== 'string' || candidate.ptyId.length === 0) return 'ptyId';
  if (typeof candidate.subjectPtyId !== 'string' || candidate.subjectPtyId.length === 0) return 'subjectPtyId';
  if (candidate.name !== 'ownership-lent' && candidate.subjectPtyId !== candidate.ptyId) return 'subjectPtyId';
  if (typeof candidate.depth !== 'number' || !Number.isInteger(candidate.depth) || candidate.depth < 0) return 'depth';
  if (typeof candidate.role !== 'string' || !VALID_ROLES.has(candidate.role as SignalRole)) return 'role';
  if (typeof candidate.seq !== 'number' || !Number.isInteger(candidate.seq) || candidate.seq < 1) return 'seq';
  if (typeof candidate.at !== 'number' || !Number.isFinite(candidate.at)) return 'at';
  if (typeof candidate.class !== 'string' || !VALID_CLASSES.has(candidate.class as SignalClass)) return 'class';
  if (typeof candidate.name !== 'string') return 'name';
  if (!NAMES_BY_CLASS[candidate.class as SignalClass].has(candidate.name as LifecycleName)) return 'name';
  const hasTransition = Object.prototype.hasOwnProperty.call(candidate, 'transition');
  const hasResumable = Object.prototype.hasOwnProperty.call(candidate, 'resumable');
  const hasTruncatedFields = Object.prototype.hasOwnProperty.call(candidate, 'truncatedFields');
  if (candidate.class === 'condition') {
    if (!hasTransition || (candidate.transition !== 'enter' && candidate.transition !== 'exit')) return 'transition';
    if (candidate.transition === 'enter' && (!hasResumable || typeof candidate.resumable !== 'boolean')) return 'resumable';
    if (candidate.transition === 'exit' && hasResumable) return 'resumable';
  } else if (hasTransition) return 'transition';
  else if (hasResumable) return 'resumable';
  if (typeof candidate.truncated !== 'boolean') return 'truncated';
  if (candidate.truncated) {
    if (!hasTruncatedFields || !isStringArray(candidate.truncatedFields) || candidate.truncatedFields.length === 0) return 'truncatedFields';
    // ⭐ Per-name, not global — a record may only claim truncation of a field
    // its own kind actually carries.
    const allowed = TRUNCATABLE_FIELDS_BY_NAME[candidate.name as LifecycleName];
    if (!candidate.truncatedFields.every((field) => allowed.has(field))) return 'truncatedFields';
  } else if (hasTruncatedFields) return 'truncatedFields';
  return validatePayload(candidate.name as LifecycleName, candidate.payload);
}

/** A per-producer sequence generator. Each invocation starts independently at one. */
export function createSeqCounter(): () => number {
  let current = 0;
  return () => ++current;
}

/** LifecycleRecord → ChannelBus message. Structured data remains in metadata. */
export function recordToChannelMessage(record: LifecycleRecord): Omit<ChannelMessage, 'channel' | 'at'> & { at?: number } {
  return {
    from: record.ptyId,
    payload: JSON.stringify(record.payload ?? {}),
    at: record.at,
    meta: {
      lifecycleRecord: true,
      runId: record.runId,
      ptyId: record.ptyId,
      subjectPtyId: record.subjectPtyId,
      depth: record.depth,
      role: record.role,
      seq: record.seq,
      at: record.at,
      class: record.class,
      name: record.name,
      ...(record.class === 'condition' ? { transition: record.transition } : {}),
      ...(record.class === 'condition' && record.transition === 'enter' ? { resumable: record.resumable } : {}),
      ...('payload' in record ? { payload: record.payload } : {}),
      truncated: record.truncated,
      ...(record.truncated ? { truncatedFields: record.truncatedFields } : {}),
    },
  };
}

/** ChannelBus message → LifecycleRecord. Malformed messages are dropped.
 *  ⭐ This is the consumer-side fail-soft boundary: it never throws. The
 *  depth ceiling in `isJsonValue` already rejects pathological nesting
 *  structurally; the guard below is the belt for anything else a hostile
 *  or corrupt envelope can do (exotic getters, proxies) — a bad message
 *  must not be able to take down a subscriber. */
export function channelMessageToRecord(msg: ChannelMessage): LifecycleRecord | null {
  try {
    return decodeRecord(msg);
  } catch {
    return null;
  }
}

function decodeRecord(msg: ChannelMessage): LifecycleRecord | null {
  const meta = msg.meta as Record<string, unknown> | undefined;
  if (!meta || meta.lifecycleRecord !== true) return null;
  // Spread-guard optionals so absent properties remain absent and strict
  // round-trips do not acquire explicit undefined keys.
  const candidate = {
    runId: meta.runId, ptyId: meta.ptyId, subjectPtyId: meta.subjectPtyId,
    depth: meta.depth, role: meta.role, seq: meta.seq, at: meta.at, class: meta.class, name: meta.name,
    ...(Object.prototype.hasOwnProperty.call(meta, 'transition') ? { transition: meta.transition } : {}),
    ...(Object.prototype.hasOwnProperty.call(meta, 'resumable') ? { resumable: meta.resumable } : {}),
    ...(Object.prototype.hasOwnProperty.call(meta, 'payload') ? { payload: meta.payload } : {}),
    truncated: meta.truncated,
    ...(Object.prototype.hasOwnProperty.call(meta, 'truncatedFields') ? { truncatedFields: meta.truncatedFields } : {}),
  };
  if (validateLifecycleRecord(candidate) !== null) return null;
  // Trust boundary: the ChannelBus envelope's `from` must match the
  // record's producer. Reject a record that impersonates another child
  // (e.g. delivered on one child's channel but claiming a foreign ptyId).
  if (msg.from !== candidate.ptyId) return null;
  return candidate as LifecycleRecord;
}

/** Publish to BOTH the per-child channel and this run's aggregate fan-in.
 *  Each path is independently fail-soft, including serialization, so one
 *  failure cannot prevent the other fan-in attempt. */
export function publishLifecycleRecord(bus: ChannelBus, record: LifecycleRecord): void {
  try {
    bus.publish(channelForChild(record.ptyId), recordToChannelMessage(record));
  } catch { /* fail-soft — lifecycle declarations must not break producers */ }
  try {
    bus.publish(aggregateChannelForRun(record.runId), recordToChannelMessage(record));
  } catch { /* fail-soft — lifecycle declarations must not break producers */ }
}

/** Subscribe to one child's lifecycle declarations. Malformed messages
 *  are dropped rather than delivered to the consumer. */
export function subscribeChildLifecycle(
  bus: ChannelBus,
  ptyId: string,
  cb: (record: LifecycleRecord) => void,
  opts?: SubscribeOpts,
): ChannelSubscription {
  return bus.subscribe(channelForChild(ptyId), (message) => {
    const record = channelMessageToRecord(message);
    if (record && record.ptyId === ptyId) cb(record);
  }, opts);
}

/** Subscribe to every child of ONE run through that run's aggregate key.
 *  ⭐ Run-scoped by construction — a coordinator never sees a sibling run's
 *  records, so correctness does not depend on it remembering to filter. */
export function subscribeRunLifecycle(
  bus: ChannelBus,
  runId: string,
  cb: (record: LifecycleRecord) => void,
  opts?: SubscribeOpts,
): ChannelSubscription {
  return bus.subscribe(aggregateChannelForRun(runId), (message) => {
    const record = channelMessageToRecord(message);
    if (record && record.runId === runId) cb(record);
  }, opts);
}

/** Read one run's aggregate replay buffer without subscribing. */
export function snapshotRunLifecycle(bus: ChannelBus, runId: string, limit?: number): LifecycleRecord[] {
  return bus.snapshot(aggregateChannelForRun(runId), limit)
    .map(channelMessageToRecord)
    .filter((record): record is LifecycleRecord => record !== null && record.runId === runId);
}

export function snapshotChildLifecycle(bus: ChannelBus, ptyId: string, limit?: number): LifecycleRecord[] {
  return bus.snapshot(channelForChild(ptyId), limit)
    .map(channelMessageToRecord)
    .filter((record): record is LifecycleRecord => record !== null && record.ptyId === ptyId);
}

export interface TruncationLimits { readonly [field: string]: number; }
export type TruncatableValue = JsonValue | readonly string[];
export type TruncatablePayload = Readonly<Record<string, TruncatableValue>>;
/** ⭐ Discriminated so the helper's output can be spread straight into a
 *  record and still satisfy `validateLifecycleRecord`. A single shape with
 *  an always-present `truncatedFields: []` could not: the contract says the
 *  field is ABSENT when nothing was cut (present-but-empty and absent are
 *  different states, and only one of them is true). The type now makes the
 *  producer seam and the validator agree by construction rather than by
 *  the caller remembering to strip an empty array. */
export type TruncationResult =
  | { readonly payload: TruncatablePayload; readonly truncated: false }
  | { readonly payload: TruncatablePayload; readonly truncated: true; readonly truncatedFields: readonly string[] };

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let retained = limit;
  let notice = '';
  while (retained >= 0) {
    notice = `… [${value.length - retained} chars omitted]`;
    if (retained + notice.length <= limit) return `${value.slice(0, retained)}${notice}`;
    retained -= 1;
  }
  return notice.slice(0, limit);
}

function truncateFiles(value: readonly string[], limit: number): readonly string[] {
  if (value.length <= limit) return value;
  const retained = Math.max(0, limit - 1);
  return [...value.slice(0, retained), `… [${value.length - retained} files omitted]`].slice(0, limit);
}

/** Apply field-specific text and string-list bounds with in-band notices. */
export function applyTruncation(payload: TruncatablePayload, limits: TruncationLimits): TruncationResult {
  const result: Record<string, TruncatableValue> = { ...payload };
  const truncatedFields: string[] = [];
  for (const [field, limit] of Object.entries(limits)) {
    const value = payload[field];
    if (!Number.isInteger(limit) || limit < 0 || value === undefined) continue;
    if (typeof value === 'string' && value.length > limit) {
      result[field] = truncateText(value, limit);
      truncatedFields.push(field);
    } else if (isStringArray(value) && value.length > limit) {
      result[field] = truncateFiles(value, limit);
      truncatedFields.push(field);
    }
  }
  return truncatedFields.length > 0
    ? { payload: result, truncated: true, truncatedFields }
    : { payload: result, truncated: false };
}

export const LIFECYCLE_TRUNCATION_LIMITS = {
  prompt: PROMPT_MAX, reason: REASON_MAX, summary: SUMMARY_MAX, changedFiles: CHANGED_FILES_MAX,
} as const satisfies TruncationLimits;
