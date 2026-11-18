/**
 * CAPSULE-K3-b (seat-state/TC/CAPSULE-K3-SEAT-LIFETIME-DESIGN-1118.md) — the capsule ledger on disk: one append-only
 * jsonl file per instance, written only by its owner (the TUI process). No wiring here: the TUI hooks (B1 frames →
 * start/done · notice turn responded → delivered · boot reconcile) are the next piece.
 *
 * Every call is fail-open: a ledger that cannot be read or written costs the report, never the turn.
 */
import {
  appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { psProcessStartMs, START_TOLERANCE_MS } from '../harness/harness-stop.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { emitTurnLife } from '../debug/turn-life.js';
import {
  compactLedger, encodeLedgerEntry, parseLedgerLine, reconcileLedger,
  type CapsuleLedgerEntry, type OwnerAlive, type ReconcileResult,
} from './capsule-ledger.js';

export function capsuleLedgerPath(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const dataDir = env.ELANOUS_DATA_DIR?.trim() || join(effectiveInstanceRoot(), 'data');
  return join(dataDir, 'capsule-ledger.jsonl');
}

/** Same owner check as graph runs (`graphRunAlive`): pid alive and its start time matches the recorded one. */
export function defaultOwnerAlive(processStartMs: (pid: number) => number | null = psProcessStartMs): OwnerAlive {
  return (pid, startedAt) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
      const actual = processStartMs(pid);
      return actual !== null && Math.abs(actual - startedAt) <= START_TOLERANCE_MS;
    } catch { return false; }
  };
}

/**
 * JUD #38615 must: a crash mid-write leaves a torn last line with no '\n'; a plain append would glue the next valid
 * line onto it and lose both. True when the file ends without '\n' (reads only the last byte). Fail-open: false.
 */
function endsWithTornTail(path: string): boolean {
  let fd: number | undefined;
  try {
    if (!existsSync(path)) return false;
    fd = openSync(path, 'r');
    const bytes = fstatSync(fd).size;
    if (bytes === 0) return false; // 출처: #38615 빈 파일 = 꼬리 없음
    const last = Buffer.alloc(1); // 출처: #38615 마지막 1바이트만 읽는다
    readSync(fd, last, 0, 1, bytes - 1); // 출처: #38615 마지막 1바이트(offset size-1)
    return last[0] !== 0x0a; // 출처: #38615 '\n'
  } catch { return false; } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* fail-open */ }
  }
}

export interface CapsuleLedgerStore {
  append(entry: CapsuleLedgerEntry): boolean;
  read(): { entries: CapsuleLedgerEntry[]; lines: number };
  /** Boot pass: append interrupted `done` lines, compact if large, return what the seat must report. */
  reconcileAtBoot(now?: number): ReconcileResult;
}

export function createCapsuleLedgerStore(path = capsuleLedgerPath(), ownerAlive: OwnerAlive = defaultOwnerAlive()): CapsuleLedgerStore {
  const append = (entry: CapsuleLedgerEntry): boolean => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      if (endsWithTornTail(path)) appendFileSync(path, '\n');
      appendFileSync(path, encodeLedgerEntry(entry));
      emitTurnLife(`turn-life:capsule-ledger-${entry.op}`, entry.op === 'delivered'
        ? { capsuleIds: entry.capsuleIds, turnId: entry.turnId }
        : { capsuleId: entry.capsuleId, ...(entry.op === 'done' ? { status: entry.status } : { kind: entry.kind, sessionId: entry.sessionId }) });
      return true;
    } catch { return false; }
  };
  const read = (): { entries: CapsuleLedgerEntry[]; lines: number } => {
    let text = '';
    try { if (existsSync(path)) text = readFileSync(path, 'utf8'); } catch { return { entries: [], lines: 0 }; }
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    return { entries: lines.map(parseLedgerLine).filter((entry): entry is CapsuleLedgerEntry => entry !== null), lines: lines.length };
  };
  return {
    append,
    read,
    reconcileAtBoot(now = Date.now()) {
      const { entries, lines } = read();
      const result = reconcileLedger(entries, ownerAlive, now);
      for (const entry of result.interrupted) append(entry);
      const compacted = compactLedger([...entries, ...result.interrupted], lines + result.interrupted.length);
      if (compacted) {
        try {
          const temp = `${path}.${process.pid}.tmp`;
          writeFileSync(temp, compacted.map(encodeLedgerEntry).join(''));
          renameSync(temp, path);
        } catch { /* compaction is an optimisation; the full ledger stays valid */ }
      }
      emitTurnLife('turn-life:capsule-ledger-reconciled', {
        interrupted: result.interrupted.length, undelivered: result.undelivered.length, ledgerLines: lines, compacted: compacted !== null,
      });
      return result;
    },
  };
}
