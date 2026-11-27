import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import {
  claimIncident,
  createFileIncidentClaimStore,
  type IncidentClaimStore,
  type SupervisorLoopRef,
} from './incident-claim.js';

// Cell: SHADOW-SEES-ALL-OP-MAIL (0.3.31 P0 · seat-state/TC/OP-PROMOTION-1500-DRAFT.md:22).
// Every received mail of a watched seat (OP 등) inside the coverage window is checked against that seat's
// judgment ledger (the same DECISIONS.md family the #19 stall watch reads); a mail with no matching judgment
// row gets one «판단 없음: 사유» record, and a gap count at the threshold raises exactly one 🔴 OP mail.

export interface SeatMailCoverageSeat {
  readonly seatId: string;
  readonly decisionsText: string;
}

export interface ReceivedMailSnapshot {
  readonly id: number;
  readonly createdAtMs: number;
}

export interface SeatMailScan {
  readonly messages: readonly ReceivedMailSnapshot[];
  /** The page bound was hit — window coverage is unproven for the unscanned tail (surfaced, never dropped). */
  readonly truncated: boolean;
}

export type MailCoverageGapReason = '주제 불일치' | '미스캔';

export interface MailCoverageGap {
  readonly mailId: number;
  readonly reason: MailCoverageGapReason;
}

export interface MailNoJudgmentRecord {
  readonly seatId: string;
  readonly mailId: number;
  readonly reason: MailCoverageGapReason;
  readonly incidentId: string;
  /** «#<mailId> 판단 없음: <사유>» — the recorded row text. */
  readonly note: string;
  /** true = this tick wrote the incident claim; false = the record already exists (later tick of the same gap). */
  readonly recorded: boolean;
}

export interface MailCoverageAlarm {
  readonly seatId: string;
  readonly gapCount: number;
  readonly windowMinutes: number;
  readonly records: readonly MailNoJudgmentRecord[];
  readonly mail: { readonly to: 'OP'; readonly subject: string; readonly body: string };
}

export interface MailCoverageDeps {
  readonly store?: IncidentClaimStore;
  readonly scanMail?: (seatId: string) => SeatMailScan;
  readonly windowMinutes?: number;
  readonly gapThreshold?: number;
}

// Source: cell spec (SHADOW-SEES-ALL-OP-MAIL) sets the default gap threshold to 1 — one unjudged received mail is already a coverage gap.
export const DEFAULT_MAIL_COVERAGE_GAP_THRESHOLD = 1;
// Source: SHADOW-CONCORDANCE-1119 measured the widened concordance window 09:00–15:00 KST (six hours); this watch re-checks the same horizon every tick.
export const DEFAULT_MAIL_COVERAGE_WINDOW_MINUTES = 360;
// Source: graphs/ops/op-mail-coverage-watch.yaml ticks every 10 minutes; a 25-minute lease survives two delayed ticks (#19 convention).
export const MAIL_COVERAGE_CLAIM_TTL_MS = 25 * 60_000;
export const MAIL_COVERAGE_COORDINATOR: SupervisorLoopRef = 'loop:coordinator@1';
// Source: the seat mail ledger page size mirrors src/tui/seat-message-receipts.ts SEAT_MESSAGE_READ_LIMIT (1000 rows per listByRecipient page).
const MAIL_COVERAGE_PAGE_SIZE = 1000;
// Source: the scan page count mirrors src/tui/seat-message-receipts.ts SEAT_MESSAGE_SCAN_PAGES — 20 pages bound one full scan; hitting the bound reports `truncated`.
const MAIL_COVERAGE_SCAN_PAGES = 20;
// Source: Unix epoch timestamps use milliseconds per minute.
const MILLISECONDS_PER_MINUTE = 60_000;

/** The judgment ledger references a mail as `#<id>` (house rows like `09:26 #95052 — …` or `OP#94818`); a longer id must not match a shorter one. */
export function isMailJudged(decisionsText: string, mailId: number): boolean {
  if (typeof decisionsText !== 'string' || !Number.isSafeInteger(mailId) || mailId < 0) return false;
  return new RegExp(`#${mailId}(?![0-9])`, 'u').test(decisionsText);
}

/** Ledger `created_at` is ISO-8601 UTC; a zoneless string is forced to UTC (never the host's local zone) and unparseable values fail closed. */
export function parseLedgerCreatedAtMs(value: string): number | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  if (raw === '') return undefined;
  // Source: ledger created_at is stored in UTC, so a missing zone suffix means Z, not local time.
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/u.test(raw);
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const ms = Date.parse(hasZone ? iso : `${iso}Z`);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

/** Unjudged in-window mail, each with its reason; a truncated scan adds one 미스캔 gap at the last scanned id (fail-closed on invalid clock or window). */
export function findUnjudgedMail(
  scan: SeatMailScan,
  decisionsText: string,
  nowMs: number,
  windowMinutes: number = DEFAULT_MAIL_COVERAGE_WINDOW_MINUTES,
): MailCoverageGap[] {
  // Source: all accepted timestamps use non-negative Unix epoch milliseconds.
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return [];
  // Source: a non-positive window cannot bound a coverage claim, so fail closed.
  if (!Number.isSafeInteger(windowMinutes) || windowMinutes <= 0) return [];
  const messages = Array.isArray(scan?.messages) ? scan.messages : [];
  const windowStartMs = nowMs - windowMinutes * MILLISECONDS_PER_MINUTE;
  const gaps: MailCoverageGap[] = [];
  let lastScannedId = 0;
  for (const message of messages) {
    if (!Number.isSafeInteger(message?.id) || message.id < 0) continue;
    if (!Number.isSafeInteger(message.createdAtMs) || message.createdAtMs < 0) continue;
    // Source: only mail created inside the window counts; a future-dated row is not observable yet.
    if (message.createdAtMs < windowStartMs || message.createdAtMs > nowMs) continue;
    lastScannedId = Math.max(lastScannedId, message.id);
    // Source: a scanned mail whose id never appears in the judgment ledger is a 주제 불일치 gap.
    if (!isMailJudged(decisionsText, message.id)) {
      gaps.push({ mailId: message.id, reason: '주제 불일치' });
    }
  }
  // Source: a truncated scan cannot prove coverage for the unscanned tail — one 미스캔 gap at the last scanned id.
  if (scan?.truncated === true) gaps.push({ mailId: lastScannedId, reason: '미스캔' });
  return gaps;
}

/** One incident id per gap: the same unjudged mail (or the same truncation point) records and alarms exactly once. */
export function mailNoJudgmentIncidentId(seatId: string, mailId: number, reason: MailCoverageGapReason): string {
  return reason === '미스캔'
    ? `op-mail-coverage:${seatId}:misscan:${mailId}`
    : `op-mail-coverage:${seatId}:no-judgment:${mailId}`;
}

function buildMailCoverageAlarm(
  seatId: string,
  records: readonly MailNoJudgmentRecord[],
  windowMinutes: number,
): MailCoverageAlarm {
  const gapCount = records.length;
  const rows = records.map((record) => record.note).join(' · ');
  return {
    seatId,
    gapCount,
    windowMinutes,
    records,
    mail: {
      to: 'OP',
      // Source: cell spec — gap count at the threshold raises exactly one 🔴 OP mail per tick batch.
      subject: `[SHADOW-OP-MAIL-COVERAGE] 🔴 ${seatId} 판단 없는 수신 우편 ${gapCount}통 (최근 ${windowMinutes}분)`,
      body: `🔴 ${seatId} 최근 ${windowMinutes}분 수신 우편 중 판단 없음 ${gapCount}통 `
        + `(기본 임계 ${DEFAULT_MAIL_COVERAGE_GAP_THRESHOLD}): ${rows}. 그림자가 같은 우편을 판단했는지 확인 권장.`,
    },
  };
}

/** Shadow tick: record «판단 없음: 사유» per new gap and raise one 🔴 OP mail per newly recorded gap batch. */
export async function runOpMailCoverageWatch(
  seats: readonly SeatMailCoverageSeat[],
  nowMs: number,
  deps: MailCoverageDeps = {},
): Promise<MailCoverageAlarm[]> {
  // Source: all accepted timestamps use non-negative Unix epoch milliseconds.
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return [];
  const store = deps.store ?? createMailCoverageClaimStore();
  const scanMail = deps.scanMail ?? scanSeatMailFromLedger;
  const windowMinutes = deps.windowMinutes ?? DEFAULT_MAIL_COVERAGE_WINDOW_MINUTES;
  const gapThreshold = deps.gapThreshold ?? DEFAULT_MAIL_COVERAGE_GAP_THRESHOLD;
  const alarms: MailCoverageAlarm[] = [];
  for (const seat of seats) {
    if (typeof seat?.seatId !== 'string' || !seat.seatId.trim()) continue;
    const gaps = findUnjudgedMail(scanMail(seat.seatId), seat.decisionsText ?? '', nowMs, windowMinutes);
    const records: MailNoJudgmentRecord[] = [];
    let newlyRecorded = 0;
    for (const gap of gaps) {
      const incidentId = mailNoJudgmentIncidentId(seat.seatId, gap.mailId, gap.reason);
      const result = await claimIncident(store, {
        incidentId,
        ownerLoopRef: MAIL_COVERAGE_COORDINATOR,
        ownerOrder: [MAIL_COVERAGE_COORDINATOR],
        now: () => nowMs,
        leaseMs: MAIL_COVERAGE_CLAIM_TTL_MS,
      });
      // Source: only the first claim writes the record; later ticks of the same gap stay silent (#19 pattern).
      const recorded = result.disposition === 'claimed';
      if (recorded) newlyRecorded += 1;
      records.push({ seatId: seat.seatId, mailId: gap.mailId, reason: gap.reason, incidentId,
        note: `#${gap.mailId} 판단 없음: ${gap.reason}`, recorded });
    }
    // Source: the batch alarms once per newly recorded gap set — persistent gaps already hold their records.
    if (records.length >= gapThreshold && newlyRecorded > 0) {
      alarms.push(buildMailCoverageAlarm(seat.seatId, records, windowMinutes));
    }
  }
  return alarms;
}

/** Persistent default so independent scheduled ticks share no-judgment records. */
export function createMailCoverageClaimStore(root = elanousStateRoot()): IncidentClaimStore {
  return createFileIncidentClaimStore(root);
}

/** Read-only full scan of one seat's received mail — every page up to the scan bound, judged-and-acked mail included. */
export function scanSeatMailFromLedger(seatId: string, deps: { msgPath?: string } = {}): SeatMailScan {
  const msgPath = deps.msgPath ?? join(elanousStateRoot(), 'msg', 'messages.db');
  try { statSync(msgPath); } catch { return { messages: [], truncated: false }; }
  const mod = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js');
  const store = new mod.MsgStore(msgPath, { readOnly: true });
  try {
    // One read snapshot: a mail committed between pages would otherwise sit past the next scan's floor unseen.
    return store.db.transaction((): SeatMailScan => {
      const messages: ReceivedMailSnapshot[] = [];
      let truncated = false;
      let after = 0;
      for (let page = 0; ; page += 1) {
        // Source: includeAcked keeps per-message-acked history — coverage needs every received mail, judged ones included.
        const rows = store.listByRecipient(seatId, after, MAIL_COVERAGE_PAGE_SIZE, { includeAcked: true });
        for (const row of rows) {
          const createdAtMs = parseLedgerCreatedAtMs(row.createdAt);
          if (createdAtMs !== undefined) messages.push({ id: row.id, createdAtMs });
        }
        if (rows.length < MAIL_COVERAGE_PAGE_SIZE) break;
        after = rows.at(-1)!.id;
        if (page + 1 >= MAIL_COVERAGE_SCAN_PAGES) { truncated = true; break; }
      }
      return { messages, truncated };
    }).deferred();
  } finally { store.close(); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function parseMailCoverageGraphContext(raw: string): SeatMailCoverageSeat[] {
  try {
    const context: unknown = JSON.parse(raw);
    if (!isRecord(context) || !isRecord(context.input) || !Array.isArray(context.input.seats)) return [];
    return context.input.seats.filter((item: unknown): item is SeatMailCoverageSeat =>
      isRecord(item) && typeof item.seatId === 'string' && item.seatId.trim() !== ''
      && typeof item.decisionsText === 'string');
  } catch {
    return [];
  }
}

function readGraphSeats(): SeatMailCoverageSeat[] {
  const location = process.env.ELANOUS_GRAPH_CONTEXT;
  if (!location) return [];
  try {
    return parseMailCoverageGraphContext(existsSync(location) ? readFileSync(location, 'utf8') : location);
  } catch {
    return [];
  }
}

async function runShadowCommand(): Promise<void> {
  if (!process.argv.includes('--shadow')) throw new Error('op-mail-coverage-watch requires --shadow');
  const seats = readGraphSeats();
  const alarms = await runOpMailCoverageWatch(seats, Date.now());
  console.log(JSON.stringify({ outcome: 'ok', mode: 'shadow', observed: seats.length, alarms }));
}

if (import.meta.main) {
  void runShadowCommand().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
