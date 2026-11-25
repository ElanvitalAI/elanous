// TUI-DISPLAY-SNAPSHOT-RESTORE (대표 11-25 «why only first-order — finish the root»): a restart (installed update →
// self-restart relaunch · seat migration · els reattach with --resume), a session switch and /resume used to paint the
// STORED history. After a compaction the stored history is the model's view (audit rows moved ahead of the summary,
// machine mail cut to stubs), not what the person read. The TUI keeps a display-only snapshot per session beside the
// store — `<id>.display.json` — and paints that snapshot first, then appends anything newer in the store.
//
// Display only: the snapshot is never read by the turn child, the request builder or the compactor (they read
// `<id>.jsonl`). Writing or restoring it never writes the stored history.
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SerializedMessage } from '../../session/index.js';
import { isContextSummaryRow, mergeDisplayAfterCompact } from './compact-display.js';
import { transcriptRowId } from './transcript-vanish.js';

/** One displayed row: a reference to the identical stored row, or the row itself when the store no longer holds it
 *  as shown (dropped, reordered away or rewritten into a stub). */
type SnapshotEntry = { readonly ref: string } | { readonly row: SerializedMessage };

interface DisplaySnapshotFile {
  readonly v: 1;
  readonly sessionId: string;
  readonly savedAt: string;
  readonly entries: readonly SnapshotEntry[];
}

export function displaySnapshotFile(sessionId: string, root: string): string {
  return join(root, `${sessionId}.display.json`);
}

/** A machine-mail row: the compactor rewrites it into a one-line stub later, so the snapshot keeps its text. */
function isStubCandidate(row: SerializedMessage): boolean {
  return row.role === 'user' && row.from !== undefined && row.from.kind !== 'human';
}

/** The snapshot entries for `displayed`, or null when the screen shows exactly the stored history (nothing to keep). */
export function buildDisplaySnapshot(
  displayed: readonly SerializedMessage[],
  stored: readonly SerializedMessage[],
): SnapshotEntry[] | null {
  const storedJson = new Map<string, string>();
  for (const row of stored) storedJson.set(transcriptRowId(row), JSON.stringify(row));
  let sameAsStore = displayed.length === stored.length;
  const entries: SnapshotEntry[] = [];
  displayed.forEach((row, index) => {
    const json = JSON.stringify(row);
    if (sameAsStore && JSON.stringify(stored[index]) !== json) sameAsStore = false;
    if (isContextSummaryRow(row)) return;
    const id = transcriptRowId(row);
    entries.push(storedJson.get(id) === json && !isStubCandidate(row) ? { ref: id } : { row });
  });
  return sameAsStore ? null : entries;
}

/** Write (or clear) the session's display snapshot. Fail-open: a snapshot never blocks the TUI. tmp + rename. */
export function writeDisplaySnapshot(
  sessionId: string,
  displayed: readonly SerializedMessage[],
  stored: readonly SerializedMessage[],
  root: string,
  now: () => Date = () => new Date(),
): 'written' | 'cleared' | 'none' | 'failed' {
  const file = displaySnapshotFile(sessionId, root);
  try {
    const entries = buildDisplaySnapshot(displayed, stored);
    if (!entries) {
      if (!existsSync(file)) return 'none';
      unlinkSync(file);
      return 'cleared';
    }
    const body: DisplaySnapshotFile = { v: 1, sessionId, savedAt: now().toISOString(), entries };
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(body), 'utf-8');
    renameSync(tmp, file);
    return 'written';
  } catch {
    return 'failed';
  }
}

function readSnapshot(sessionId: string, root: string): DisplaySnapshotFile | null {
  try {
    const file = displaySnapshotFile(sessionId, root);
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as DisplaySnapshotFile;
    if (parsed?.v !== 1 || parsed.sessionId !== sessionId || !Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** The rows to paint for `sessionId`: its last displayed transcript, then the stored rows newer than it. Null when there
 *  is no snapshot (paint the store as before). Never writes. */
export function restoreDisplayFromSnapshot(
  sessionId: string,
  stored: readonly SerializedMessage[],
  root: string,
): { rows: SerializedMessage[]; restored: number } | null {
  const snapshot = readSnapshot(sessionId, root);
  if (!snapshot) return null;
  const byId = new Map<string, SerializedMessage>();
  for (const row of stored) byId.set(transcriptRowId(row), row);
  const shown: SerializedMessage[] = [];
  for (const entry of snapshot.entries) {
    if ('ref' in entry) {
      const row = byId.get(entry.ref);
      if (row) shown.push(row);
    } else if (entry.row && typeof entry.row.content === 'string') shown.push(entry.row);
  }
  if (shown.length === 0) return null;
  return { rows: mergeDisplayAfterCompact(shown, stored).rows, restored: shown.length };
}
