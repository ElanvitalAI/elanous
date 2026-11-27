import { existsSync, readFileSync } from 'node:fs';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import {
  claimIncident,
  createFileIncidentClaimStore,
  type IncidentClaimStore,
  type SupervisorLoopRef,
} from './incident-claim.js';

// Cell: TUI-OP-LADDER-SPRINT-1119 #19 SHADOW-SEAT-STALL-ALARM.
// A seat whose DECISIONS.md gains no new entry for N minutes (default 30) raises one 🔴 OP mail;
// the same stall — same last-entry timestamp — alarms exactly once.

export interface SeatRecordSnapshot {
  readonly seatId: string;
  readonly decisionsText: string;
}

export interface SeatStallObservation {
  readonly seatId: string;
  readonly lastEntryAtMs: number;
  readonly stalledMinutes: number;
}

export interface SeatStallAlarm {
  readonly seatId: string;
  readonly incidentId: string;
  readonly stalledMinutes: number;
  readonly lastEntryAt: string;
  readonly mail: { readonly to: 'OP'; readonly subject: string; readonly body: string };
}

// Source: cell #19 spec sets the default stall threshold to 30 minutes.
export const DEFAULT_STALL_AFTER_MINUTES = 30;
// Source: graphs/ops/seat-stall-watch.yaml ticks every 10 minutes; a 25-minute lease survives two delayed ticks.
export const SEAT_STALL_CLAIM_TTL_MS = 25 * 60_000;
export const SEAT_STALL_COORDINATOR: SupervisorLoopRef = 'loop:coordinator@1';

// Source: seat DECISIONS.md timestamps are written in KST (UTC+09:00), e.g. `- 2026-11-19 08:41 KST`.
const KST_OFFSET_MINUTES = 9 * 60;
// Source: Unix epoch timestamps use milliseconds per minute.
const MILLISECONDS_PER_MINUTE = 60_000;
// Source: an omitted seconds field contributes zero to the timestamp.
const ZERO_SECONDS = 0;

// Source: seat DECISIONS.md rows start with `- YYYY-MM-DD HH:MM[:SS][.mmm] KST` (KST suffix per house convention; Z also accepted).
const ENTRY_LINE = /^-\s(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d{1,3})?\s*(Z|KST)\b/u;

function entryMs(match: RegExpExecArray): number | undefined {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const seconds = match[6] === undefined ? ZERO_SECONDS : Number(match[6]);
  const zone = match[7]!;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || seconds > 59) {
    // Source: calendar fields use base ranges (months 1–12, days 1–31, 60-based time fields).
    return undefined;
  }
  // Source: Date.UTC months are zero-based, so November is 10.
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, seconds);
  // Source: KST rows are 9 hours ahead of UTC, so subtract the offset to normalize.
  const normalizedMs = zone === 'KST' ? utcMs - KST_OFFSET_MINUTES * MILLISECONDS_PER_MINUTE : utcMs;
  return Number.isSafeInteger(normalizedMs) && normalizedMs >= 0 ? normalizedMs : undefined;
}

/** Latest DECISIONS.md entry timestamp in epoch ms; undefined when no valid entry exists (fail-closed). */
export function lastSeatRecordMs(decisionsText: string): number | undefined {
  if (typeof decisionsText !== 'string' || decisionsText.length === 0) return undefined;
  let latest: number | undefined;
  for (const line of decisionsText.split('\n')) {
    const match = ENTRY_LINE.exec(line);
    if (!match) continue;
    const ms = entryMs(match);
    if (ms === undefined) continue;
    if (latest === undefined || ms > latest) latest = ms;
  }
  return latest;
}

/** Seats whose latest record is at least `stallAfterMinutes` old; snapshots without a parseable entry are skipped (fail-closed). */
export function findStalledSeats(
  snapshots: readonly SeatRecordSnapshot[],
  nowMs: number,
  stallAfterMinutes: number = DEFAULT_STALL_AFTER_MINUTES,
): SeatStallObservation[] {
  // Source: all accepted timestamps use non-negative Unix epoch milliseconds.
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return [];
  // Source: a non-positive threshold cannot prove a stall, so fail closed.
  if (!Number.isSafeInteger(stallAfterMinutes) || stallAfterMinutes <= 0) return [];
  const stalled: SeatStallObservation[] = [];
  for (const snapshot of snapshots) {
    if (typeof snapshot?.seatId !== 'string' || !snapshot.seatId.trim()) continue;
    const lastEntryAtMs = lastSeatRecordMs(snapshot.decisionsText ?? '');
    if (lastEntryAtMs === undefined) continue;
    const elapsedMs = nowMs - lastEntryAtMs;
    if (elapsedMs < stallAfterMinutes * MILLISECONDS_PER_MINUTE) continue;
    stalled.push({
      seatId: snapshot.seatId,
      lastEntryAtMs,
      // Source: stalled age is reported in whole elapsed minutes.
      stalledMinutes: Math.floor(elapsedMs / MILLISECONDS_PER_MINUTE),
    });
  }
  return stalled;
}

/** One incident id per stall window: the same last-entry timestamp dedupes to one alarm. */
export function seatStallIncidentId(seatId: string, lastEntryAtMs: number): string {
  return `seat-stall:${seatId}:${lastEntryAtMs}`;
}

function buildSeatStallMail(observation: SeatStallObservation): SeatStallAlarm {
  const lastEntryAt = new Date(observation.lastEntryAtMs).toISOString();
  return {
    seatId: observation.seatId,
    incidentId: seatStallIncidentId(observation.seatId, observation.lastEntryAtMs),
    stalledMinutes: observation.stalledMinutes,
    lastEntryAt,
    mail: {
      to: 'OP',
      // Source: cell #19 requires one 🔴 OP mail per stalled seat.
      subject: `[SHADOW-SEAT-STALL] 🔴 ${observation.seatId} 기록 정지 ${observation.stalledMinutes}분`,
      body: `🔴 ${observation.seatId} 마지막 기록 ${lastEntryAt} 이후 ${observation.stalledMinutes}분 새 기록 0 `
        + `(기본 상한 ${DEFAULT_STALL_AFTER_MINUTES}분). 자리 점검 권장.`,
    },
  };
}

/** Shadow tick: emit 🔴 OP mail proposals for each new stall; the same stall claims once and stays silent. */
export async function runSeatStallWatch(
  snapshots: readonly SeatRecordSnapshot[],
  nowMs: number,
  store: IncidentClaimStore = createSeatStallClaimStore(),
): Promise<SeatStallAlarm[]> {
  const alarms: SeatStallAlarm[] = [];
  for (const observation of findStalledSeats(snapshots, nowMs)) {
    const result = await claimIncident(store, {
      incidentId: seatStallIncidentId(observation.seatId, observation.lastEntryAtMs),
      ownerLoopRef: SEAT_STALL_COORDINATOR,
      ownerOrder: [SEAT_STALL_COORDINATOR],
      now: () => nowMs,
      leaseMs: SEAT_STALL_CLAIM_TTL_MS,
    });
    // Source: only the first claim for a stall window raises the mail; later ticks for the same stall stay silent.
    if (result.disposition === 'claimed') alarms.push(buildSeatStallMail(observation));
  }
  return alarms;
}

/** Persistent default so independent scheduled ticks share stall claims. */
export function createSeatStallClaimStore(root = elanousStateRoot()): IncidentClaimStore {
  return createFileIncidentClaimStore(root);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function parseSeatStallGraphContext(raw: string): SeatRecordSnapshot[] {
  try {
    const context: unknown = JSON.parse(raw);
    if (!isRecord(context) || !isRecord(context.input) || !Array.isArray(context.input.seats)) return [];
    return context.input.seats.filter((item: unknown): item is SeatRecordSnapshot =>
      isRecord(item) && typeof item.seatId === 'string' && item.seatId.trim() !== ''
      && typeof item.decisionsText === 'string');
  } catch {
    return [];
  }
}

function readGraphSeats(): SeatRecordSnapshot[] {
  const location = process.env.ELANOUS_GRAPH_CONTEXT;
  if (!location) return [];
  try {
    return parseSeatStallGraphContext(existsSync(location) ? readFileSync(location, 'utf8') : location);
  } catch {
    return [];
  }
}

async function runShadowCommand(): Promise<void> {
  if (!process.argv.includes('--shadow')) throw new Error('seat-stall-watch requires --shadow');
  const seats = readGraphSeats();
  const alarms = await runSeatStallWatch(seats, Date.now());
  console.log(JSON.stringify({ outcome: 'ok', mode: 'shadow', observed: seats.length, alarms }));
}

if (import.meta.main) {
  void runShadowCommand().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
