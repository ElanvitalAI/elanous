// ── User-Intent logger — emit + MSS enrich + sink fan-out ──
//
// PLAN §4.6 — every surface adapter calls `userIntentLogger.emit(...)`.
// Logger fills the universal header (event_id / ts / elanous_id /
// trace_id / etc.), redacts, then fans out to all registered sinks.
//
// Default sinks (U0):
//   - JSONL (always-on, `~/.elanous/user-intents/{date}.jsonl`)
//   - in-memory ring (test seam + future Patcher bridge)
//
// U1 will add OTel; U4 will add the Patcher bridge. Both register
// through `addSink()` so logger.ts stays untouched.

import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { getOrCreateElanousId } from '../mss/identity-store.js';
import {
  getParentSpanId,
  getSpanId,
  getTraceId,
} from '../mss/trace-context.js';
import { redactIntentEvent, redactValue } from './redaction.js';
import { writeUserIntentJsonl } from './sinks/jsonl.js';
import type {
  UserIntentEvent,
  UserIntentEventInput,
} from './types.js';

export interface UserIntentSink {
  name: string;
  write(event: UserIntentEvent): void;
}

export interface UserIntentLoggerOptions {
  /** When false the logger is a no-op. Mirrors the privacy opt-out
   *  surface — set by daemon boot from user-config. */
  enabled?: boolean;
  /** When true, utterance values are kept verbatim. Defaults to
   *  false — content_hash only. */
  logFullContent?: boolean;
  /** Optional override for `device_id`. Falls back to `os.hostname()`. */
  deviceId?: string;
  /** Optional override for `user_id`. Defaults to empty string until
   *  per-user auth lands. */
  userId?: string;
  /** Optional override for `session_id` resolution. Returns the
   *  ambient session id when the surface adapter doesn't pass one. */
  ambientSessionId?: () => string | undefined;
}

function newEventId(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class UserIntentLogger {
  private sinks: UserIntentSink[] = [];
  private opts: Required<Pick<UserIntentLoggerOptions, 'enabled' | 'logFullContent' | 'userId'>>
    & Pick<UserIntentLoggerOptions, 'deviceId' | 'ambientSessionId'>;

  constructor(opts: UserIntentLoggerOptions = {}) {
    this.opts = {
      enabled: opts.enabled ?? true,
      logFullContent: opts.logFullContent ?? false,
      userId: opts.userId ?? '',
      deviceId: opts.deviceId,
      ambientSessionId: opts.ambientSessionId,
    };
    // Default sink — always-on JSONL.
    this.sinks.push({
      name: 'jsonl',
      write: (ev) => { writeUserIntentJsonl(ev); },
    });
  }

  setEnabled(enabled: boolean): void { this.opts.enabled = enabled; }
  setLogFullContent(value: boolean): void { this.opts.logFullContent = value; }

  /** Register an additional sink (U1 OTel · U4 Patcher bridge). */
  addSink(sink: UserIntentSink): void {
    this.sinks.push(sink);
  }

  /** Remove a sink by name (test seam). */
  removeSink(name: string): void {
    this.sinks = this.sinks.filter((s) => s.name !== name);
  }

  /** Replace all sinks (test seam). */
  setSinks(sinks: UserIntentSink[]): void {
    this.sinks = [...sinks];
  }

  listSinks(): readonly string[] {
    return this.sinks.map((s) => s.name);
  }

  /** Build the canonical event from the caller input. Public so the
   *  HTTP endpoint can produce the wire shape without calling `emit`
   *  (when forwarding events from PWA / iOS the trace context already
   *  exists upstream). */
  buildEvent(input: UserIntentEventInput): UserIntentEvent {
    const ts = input.ts ?? new Date().toISOString();
    const value = redactValue(
      input.intent.layer,
      input.intent.value,
      { logFullContent: this.opts.logFullContent },
    );
    const intent = value === undefined && input.intent.value === undefined
      ? input.intent
      : { ...input.intent, value };

    let elanousId = '';
    try { elanousId = getOrCreateElanousId(); } catch { /* identity write may fail */ }

    const sessionId = input.session_id
      ?? this.opts.ambientSessionId?.()
      ?? '';

    const event: UserIntentEvent = {
      schema_version: 1,
      event_id: newEventId(),
      ts,
      user_id: input.user_id ?? this.opts.userId,
      session_id: sessionId,
      device_id: input.device_id ?? this.opts.deviceId ?? hostname(),
      elanous_id: elanousId,
      surface: input.surface,
      intent,
    };

    const traceId = getTraceId();
    if (traceId) event.trace_id = traceId;
    const spanId = getSpanId();
    if (spanId) event.span_id = spanId;
    const parentSpanId = getParentSpanId();
    if (parentSpanId) event.parent_event_id = input.parent_event_id ?? parentSpanId;
    else if (input.parent_event_id) event.parent_event_id = input.parent_event_id;

    if (input.surface_state) event.surface_state = input.surface_state;
    if (input.context) event.context = input.context;
    if (input.outcome) event.outcome = input.outcome;

    return event;
  }

  /** Fire-and-forget emit. Never throws — sinks swallow their own
   *  errors so a JSONL write failure doesn't break the user flow. */
  emit(input: UserIntentEventInput): UserIntentEvent | null {
    if (!this.opts.enabled) return null;
    const event = redactIntentEvent(this.buildEvent(input));
    for (const sink of this.sinks) {
      try { sink.write(event); } catch { /* best-effort */ }
    }
    return event;
  }
}

let singleton: UserIntentLogger | null = null;

export function userIntentLogger(): UserIntentLogger {
  if (!singleton) singleton = new UserIntentLogger();
  return singleton;
}

/** Test seam — reset the singleton between tests. */
export function _resetUserIntentLogger(opts?: UserIntentLoggerOptions): UserIntentLogger {
  singleton = new UserIntentLogger(opts);
  return singleton;
}
