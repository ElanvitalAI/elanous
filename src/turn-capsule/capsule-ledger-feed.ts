/**
 * CAPSULE-K3-c (seat-state/TC/CAPSULE-K3-SEAT-LIFETIME-DESIGN-1118.md) — what the TUI writes to the capsule ledger and
 * what it says at boot. Pure: B1 capsule frames + the chat child's identity in, ledger entries and one notice out.
 * The calls themselves live in entry.ts and belong to the wiring hand (HOT-FILE-LEASE · TC-H-CC-2).
 */
import type { CapsuleEvent } from './contract.js';
import { INTERRUPTED_SUMMARY, type CapsuleLedgerEntry, type CapsuleRecord } from './capsule-ledger.js';

/** The process that hosts the capsule (the chat child): its death interrupts the capsule. */
export interface CapsuleOwner {
  readonly pid: number;
  readonly startedAt: number;
}

/**
 * A B1 frame → ledger entries. The first frame seen for a capsule writes its `start` (a progress line, or a done
 * that arrives before any progress); a done also writes `done`. `seen` is the caller's set of capsules already started.
 */
export function ledgerEntriesFromFrame(event: CapsuleEvent, owner: CapsuleOwner, seen: Set<string>): CapsuleLedgerEntry[] {
  const entries: CapsuleLedgerEntry[] = [];
  if (!seen.has(event.capsuleId)) {
    seen.add(event.capsuleId);
    entries.push({
      op: 'start', capsuleId: event.capsuleId, kind: event.kind, sessionId: event.sessionId, ownerPid: owner.pid,
      ownerStartedAt: owner.startedAt, startedAt: event.type === 'capsule-done' ? event.startedAt : event.at,
      label: event.type === 'capsule-progress' ? event.line : event.summary,
    });
  }
  if (event.type === 'capsule-done') {
    entries.push({ op: 'done', capsuleId: event.capsuleId, status: event.status, endedAt: event.endedAt, summary: event.summary });
  }
  return entries;
}

/** A notice turn that answered (outcome `responded`) delivered these capsules; any other outcome delivers nothing. */
export function deliveredEntry(capsuleIds: readonly string[], turnId: string, outcome: string, at: number): CapsuleLedgerEntry | null {
  if (outcome !== 'responded' || capsuleIds.length === 0) return null;
  return { op: 'delivered', capsuleIds: [...capsuleIds], turnId, at };
}

/** Most capsules named one by one in the boot notice; the rest are counted. 출처: #38587 C5 — one folded line per event. */
export const BOOT_NOTICE_NAMED_MAX = 5;

/** The one boot notice for what finished or was interrupted while the seat was down; null when there is nothing. */
export function bootCapsuleNotice(undelivered: readonly CapsuleRecord[]): { text: string; capsuleIds: string[] } | null {
  const reported = undelivered.filter((record) => record.done);
  if (reported.length === 0) return null;
  const interrupted = reported.filter((record) => record.done!.summary === INTERRUPTED_SUMMARY).length;
  const named = reported.slice(0, BOOT_NOTICE_NAMED_MAX)
    .map((record) => `${record.start?.label || record.capsuleId} — ${record.done!.status} · capsule:${record.capsuleId}`);
  const more = reported.length > BOOT_NOTICE_NAMED_MAX ? ` · 외 ${reported.length - BOOT_NOTICE_NAMED_MAX}건` : '';
  return {
    text: `재기동 전 캡슐 ${reported.length}건(완료 ${reported.length - interrupted} · 중단 ${interrupted}): ${named.join(' / ')}${more}`,
    capsuleIds: reported.map((record) => record.capsuleId),
  };
}
