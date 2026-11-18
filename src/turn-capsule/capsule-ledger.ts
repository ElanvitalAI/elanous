/**
 * CAPSULE-K3-a (seat-state/TC/CAPSULE-K3-SEAT-LIFETIME-DESIGN-1118.md) — the capsule ledger: one append-only record of
 * capsules a seat started, finished and delivered, so a completion survives a restart and a capsule whose owner died
 * is reported as interrupted instead of vanishing.
 *
 * Pure: lines in, lines/decisions out. File I/O and wiring are K3-b; the owner process (the TUI) is the only writer.
 */
import { CAPSULE_KINDS, type CapsuleKind, type CapsuleStatus } from './contract.js';

export type CapsuleLedgerEntry =
  | { readonly op: 'start'; readonly capsuleId: string; readonly kind: CapsuleKind; readonly sessionId: string;
      readonly ownerPid: number; readonly ownerStartedAt: number; readonly startedAt: number; readonly label: string }
  | { readonly op: 'done'; readonly capsuleId: string; readonly status: CapsuleStatus; readonly endedAt: number;
      readonly summary: string }
  | { readonly op: 'delivered'; readonly capsuleIds: readonly string[]; readonly turnId: string; readonly at: number };

/** Compaction threshold: past this many lines the boot pass rewrites the ledger without delivered capsules.
 *  출처: C5 ring (200 events) × start/done/delivered ≈ 3 lines each, ×3 headroom. */
export const CAPSULE_LEDGER_COMPACT_LINES = 2_000;

export const INTERRUPTED_SUMMARY = '자리 재기동으로 중단';

const STATUSES: readonly CapsuleStatus[] = ['ok', 'failed', 'timeout', 'cancelled'];
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

export function encodeLedgerEntry(entry: CapsuleLedgerEntry): string {
  return `${JSON.stringify(entry)}\n`;
}

/** One line → entry, or null (a torn last line after a crash, or anything malformed, is skipped — never fatal). */
export function parseLedgerLine(line: string): CapsuleLedgerEntry | null {
  let v: unknown;
  try { v = JSON.parse(line); } catch { return null; }
  if (!v || typeof v !== 'object') return null;
  const e = v as Record<string, unknown>;
  if (e.op === 'start' && isText(e.capsuleId) && (CAPSULE_KINDS as readonly unknown[]).includes(e.kind) && isText(e.sessionId)
    && Number.isSafeInteger(e.ownerPid) && isTime(e.ownerStartedAt) && isTime(e.startedAt) && typeof e.label === 'string') {
    return { op: 'start', capsuleId: e.capsuleId, kind: e.kind as CapsuleKind, sessionId: e.sessionId, ownerPid: e.ownerPid as number,
      ownerStartedAt: e.ownerStartedAt, startedAt: e.startedAt, label: e.label };
  }
  if (e.op === 'done' && isText(e.capsuleId) && (STATUSES as readonly unknown[]).includes(e.status) && isTime(e.endedAt)
    && typeof e.summary === 'string') {
    return { op: 'done', capsuleId: e.capsuleId, status: e.status as CapsuleStatus, endedAt: e.endedAt, summary: e.summary };
  }
  if (e.op === 'delivered' && Array.isArray(e.capsuleIds) && e.capsuleIds.every(isText) && isText(e.turnId) && isTime(e.at)) {
    return { op: 'delivered', capsuleIds: e.capsuleIds as string[], turnId: e.turnId, at: e.at };
  }
  return null;
}

export interface CapsuleRecord {
  readonly capsuleId: string;
  readonly start?: Extract<CapsuleLedgerEntry, { op: 'start' }>;
  readonly done?: Extract<CapsuleLedgerEntry, { op: 'done' }>;
  readonly delivered: boolean;
}

/** Fold the ledger into one record per capsule, in first-seen order. The first `done` wins (a replay is ignored). */
export function foldLedger(entries: readonly CapsuleLedgerEntry[]): CapsuleRecord[] {
  const byId = new Map<string, { capsuleId: string; start?: CapsuleRecord['start']; done?: CapsuleRecord['done']; delivered: boolean }>();
  const get = (capsuleId: string) => {
    let record = byId.get(capsuleId);
    if (!record) { record = { capsuleId, delivered: false }; byId.set(capsuleId, record); }
    return record;
  };
  for (const entry of entries) {
    if (entry.op === 'start') { const r = get(entry.capsuleId); r.start ??= entry; }
    else if (entry.op === 'done') { const r = get(entry.capsuleId); r.done ??= entry; }
    else for (const id of entry.capsuleIds) get(id).delivered = true;
  }
  return [...byId.values()];
}

/** Is the owner that started a capsule still the same live process? Injected: pid + process start time (pid reuse). */
export type OwnerAlive = (pid: number, startedAt: number) => boolean;

export interface ReconcileResult {
  /** `done{cancelled}` lines to append for capsules whose owner died before they finished. */
  readonly interrupted: readonly Extract<CapsuleLedgerEntry, { op: 'done' }>[];
  /** Finished (including just interrupted) but not yet delivered to a turn, in ledger order. */
  readonly undelivered: readonly CapsuleRecord[];
}

/** Boot pass: owner dead ∧ no done → interrupted · done ∧ not delivered → undelivered. Running ones are left alone. */
export function reconcileLedger(entries: readonly CapsuleLedgerEntry[], ownerAlive: OwnerAlive, now: number): ReconcileResult {
  const interrupted: Extract<CapsuleLedgerEntry, { op: 'done' }>[] = [];
  const undelivered: CapsuleRecord[] = [];
  for (const record of foldLedger(entries)) {
    let done = record.done;
    if (!done && record.start && !ownerAlive(record.start.ownerPid, record.start.ownerStartedAt)) {
      done = { op: 'done', capsuleId: record.capsuleId, status: 'cancelled', endedAt: now, summary: INTERRUPTED_SUMMARY };
      interrupted.push(done);
    }
    if (done && !record.delivered) undelivered.push({ ...record, done });
  }
  return { interrupted, undelivered };
}

/** Compaction: drop every line of capsules that are done and delivered; keep the rest in order. Null = not needed. */
export function compactLedger(entries: readonly CapsuleLedgerEntry[], lineCount: number): CapsuleLedgerEntry[] | null {
  if (lineCount <= CAPSULE_LEDGER_COMPACT_LINES) return null;
  const finished = new Set(foldLedger(entries).filter((r) => r.done && r.delivered).map((r) => r.capsuleId));
  return entries.flatMap((entry): CapsuleLedgerEntry[] => {
    if (entry.op !== 'delivered') return finished.has(entry.capsuleId) ? [] : [entry];
    const kept = entry.capsuleIds.filter((id) => !finished.has(id));
    return kept.length ? [{ ...entry, capsuleIds: kept }] : [];
  });
}
