import { existsSync, readFileSync } from 'node:fs';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import {
  claimIncident,
  createFileIncidentClaimStore,
  type IncidentClaimStore,
  type SupervisorLoopRef,
} from './incident-claim.js';

export type SilenceWatchKind =
  | 'run-doctor-visit'
  | 'autopsy'
  | 'failure-attribution'
  | 'landed-but-yellow'
  | 'test-interference-unmeasured';

const SUPPORTED_KINDS: ReadonlySet<string> = new Set([
  'run-doctor-visit',
  'autopsy',
  'failure-attribution',
  'landed-but-yellow',
  'test-interference-unmeasured',
]);

export interface SilenceWatchEvent {
  readonly eventId: string;
  readonly incidentId: string;
  readonly kind: SilenceWatchKind;
  readonly observedAt: string;
  /** ISO-8601 duration, for example RFC §2b's `PT10M`. */
  readonly silenceAfter?: string;
  /** A live claim is an owner only until its lease expires. */
  readonly claim?: { readonly ownerLoopRef: string; readonly expiresAtMs: number };
  /** An explicit, reasoned no_action is handled only when recorded after observation and before deadline. */
  readonly noAction?: { readonly reason: string; readonly recordedAt: string };
}

export interface SilenceWatchProposal {
  readonly eventId: string;
  readonly incidentId: string;
  readonly disposition: 'claimed' | 'escalated' | 'denied';
  readonly ownerLoopRef?: SupervisorLoopRef;
  readonly reason?: string;
}

// Source: RFC-loop-agent-supervisor-and-arg-contract.md §2b uses ISO-8601 PT10M for silenceAfter.
export const DEFAULT_SILENCE_AFTER = 'PT10M';
// Source: graphs/ops/silence-watch.yaml ticks every 10 minutes; a 15-minute claim survives one delayed tick.
export const SILENCE_WATCH_CLAIM_TTL = 'PT15M';
export const SILENCE_WATCH_COORDINATOR: SupervisorLoopRef = 'loop:coordinator@1';

// Source: RFC §5b deadlines are compared to JavaScript epoch timestamps, which use milliseconds.
const MILLISECONDS_PER_SECOND = 1_000;
// Source: RFC §2b ISO-8601 PT durations are converted to the same millisecond clock.
const MILLISECONDS_PER_MINUTE = 60_000;
// Source: RFC §2b ISO-8601 PT durations are converted to the same millisecond clock.
const MILLISECONDS_PER_HOUR = 3_600_000;

function durationMs(value: string): number | undefined {
  const match = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/u.exec(value);
  if (!match || !match.slice(1).some((part) => part !== undefined)) return undefined;
  // Source: an omitted ISO-8601 duration component contributes zero to the total.
  const hours = match[1] === undefined ? 0 : Number(match[1]);
  // Source: an omitted ISO-8601 duration component contributes zero to the total.
  const minutes = match[2] === undefined ? 0 : Number(match[2]);
  // Source: an omitted ISO-8601 duration component contributes zero to the total.
  const seconds = match[3] === undefined ? 0 : Number(match[3]);
  const valueMs = hours * MILLISECONDS_PER_HOUR + minutes * MILLISECONDS_PER_MINUTE + seconds * MILLISECONDS_PER_SECOND;
  // Source: RFC §5b requires an elapsed silence interval, so a zero-length policy is invalid.
  return Number.isSafeInteger(valueMs) && valueMs > 0 ? valueMs : undefined;
}

function timestampMs(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const zone = match[8]!;
  // Source: a UTC Z suffix has zero offset components.
  const zero = 0;
  const zoneHour = zone === 'Z' ? zero : Number(zone.slice(1, 3));
  const zoneMinute = zone === 'Z' ? zero : Number(zone.slice(4, 6));
  // Source: ISO-8601 calendar years start at 1; Date's setter normalizes impossible calendar dates.
  const minYear = 1;
  // Source: RFC 3339 timezone offsets use hour/minute fields capped at 23:59.
  const maxZoneHour = 23;
  // Source: minute and second fields use base-60 ranges.
  const maxMinuteSecond = 59;
  if (year < minYear || zoneHour > maxZoneHour || zoneMinute > maxMinuteSecond) return undefined;
  const calendar = new Date(zero);
  calendar.setUTCFullYear(year, month - minYear, day);
  calendar.setUTCHours(hour, minute, second, zero);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + minYear !== month ||
      calendar.getUTCDate() !== day || calendar.getUTCHours() !== hour ||
      calendar.getUTCMinutes() !== minute || calendar.getUTCSeconds() !== second ||
      minute > maxMinuteSecond || second > maxMinuteSecond) return undefined;
  const result = Date.parse(value);
  // Source: Date.parse returns Unix epoch milliseconds and negative dates are outside supervision receipts.
  return Number.isSafeInteger(result) && result >= 0 ? result : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** Drop malformed or unsupported external observations before they can trigger a claim. */
export function parseSilenceWatchEvents(value: unknown): SilenceWatchEvent[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is SilenceWatchEvent => {
    if (!isRecord(item) || typeof item.eventId !== 'string' || !item.eventId.trim() ||
        typeof item.incidentId !== 'string' || !item.incidentId.trim() ||
        typeof item.kind !== 'string' || !SUPPORTED_KINDS.has(item.kind) ||
        typeof item.observedAt !== 'string' || timestampMs(item.observedAt) === undefined) return false;
    if (item.silenceAfter !== undefined &&
        (typeof item.silenceAfter !== 'string' || durationMs(item.silenceAfter) === undefined)) return false;
    if (item.claim !== undefined && (!isRecord(item.claim) || typeof item.claim.ownerLoopRef !== 'string' ||
        !item.claim.ownerLoopRef.trim() || !Number.isSafeInteger(item.claim.expiresAtMs))) return false;
    if (item.noAction !== undefined && (!isRecord(item.noAction) || typeof item.noAction.reason !== 'string' ||
        !item.noAction.reason.trim() || typeof item.noAction.recordedAt !== 'string' ||
        timestampMs(item.noAction.recordedAt) === undefined)) return false;
    return true;
  });
}

function hasValidOwner(event: SilenceWatchEvent, now: number): boolean {
  return Boolean(event.claim?.ownerLoopRef.trim())
    && Number.isSafeInteger(event.claim?.expiresAtMs)
    && event.claim!.expiresAtMs > now;
}

function hasTimelyNoAction(event: SilenceWatchEvent, deadline: number, now: number): boolean {
  if (!event.noAction?.reason.trim()) return false;
  const recordedAt = timestampMs(event.noAction.recordedAt);
  const observedAt = timestampMs(event.observedAt);
  return recordedAt !== undefined && observedAt !== undefined && recordedAt >= observedAt &&
    recordedAt <= now && recordedAt <= deadline;
}

/** Return only observations past their deadline without a live claim or timely no_action decision. */
export function findSilentSupervisionEvents(events: readonly SilenceWatchEvent[], now: number): SilenceWatchEvent[] {
  // Source: all accepted supervision timestamps use non-negative Unix epoch milliseconds.
  if (!Number.isSafeInteger(now) || now < 0) return [];
  return parseSilenceWatchEvents(events).filter((event) => {
    const observedAt = timestampMs(event.observedAt);
    const silenceAfter = durationMs(event.silenceAfter ?? DEFAULT_SILENCE_AFTER);
    if (observedAt === undefined || silenceAfter === undefined) return false;
    const deadline = observedAt + silenceAfter;
    if (!Number.isSafeInteger(deadline) || now < deadline) return false;
    if (hasValidOwner(event, now) || hasTimelyNoAction(event, deadline, now)) return false;
    return true;
  });
}

/** Shadow tick: claim a single coordinator owner and return proposals without external writes. */
export async function runSilenceWatch(
  events: readonly SilenceWatchEvent[],
  now: number,
  store: IncidentClaimStore = createSilenceWatchClaimStore(),
): Promise<SilenceWatchProposal[]> {
  const due = findSilentSupervisionEvents(events, now);
  const leaseMs = durationMs(SILENCE_WATCH_CLAIM_TTL);
  if (leaseMs === undefined) return [];
  const proposals: SilenceWatchProposal[] = [];
  for (const event of due) {
    if (!event.eventId.trim() || !event.incidentId.trim()) continue;
    const result = await claimIncident(store, {
      incidentId: event.incidentId,
      ownerLoopRef: SILENCE_WATCH_COORDINATOR,
      ownerOrder: [SILENCE_WATCH_COORDINATOR],
      now: () => now,
      leaseMs,
    });
    proposals.push({ eventId: event.eventId, incidentId: event.incidentId, disposition: result.disposition,
      ...(result.claim ? { ownerLoopRef: result.claim.ownerLoopRef } : {}),
      ...(result.disposition === 'denied' ? { reason: result.reason } : {}) });
  }
  return proposals;
}

/** Persistent default so independent scheduled ticks share incident claims. */
export function createSilenceWatchClaimStore(root = elanousStateRoot()): IncidentClaimStore {
  return createFileIncidentClaimStore(root);
}

export function parseSilenceWatchGraphContext(raw: string): SilenceWatchEvent[] {
  try {
    const context: unknown = JSON.parse(raw);
    if (!isRecord(context) || !isRecord(context.input)) return [];
    return parseSilenceWatchEvents(context.input.events);
  } catch {
    return [];
  }
}

function readGraphEvents(): SilenceWatchEvent[] {
  const location = process.env.ELANOUS_GRAPH_CONTEXT;
  if (!location) return [];
  try {
    return parseSilenceWatchGraphContext(existsSync(location) ? readFileSync(location, 'utf8') : location);
  } catch {
    return [];
  }
}

async function runShadowCommand(): Promise<void> {
  if (!process.argv.includes('--shadow')) throw new Error('silence-watch requires --shadow');
  const events = readGraphEvents();
  const proposals = await runSilenceWatch(events, Date.now());
  console.log(JSON.stringify({ outcome: 'ok', mode: 'shadow', observed: events.length, escalations: proposals }));
}

if (import.meta.main) {
  void runShadowCommand().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
