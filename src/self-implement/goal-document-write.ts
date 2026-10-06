/** Atomic goal-document replacement for self-answered clarifications (POD-SELF-ANSWER). */
import { chmodSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';

export interface GoalDocumentWriteIo {
  writeFileSync: (path: string, data: string, options?: { mode?: number }) => void;
  renameSync: (from: string, to: string) => void;
  rmSync: (path: string, options: { force: boolean }) => void;
  statSync: (path: string) => { mode: number };
  chmodSync: (path: string, mode: number) => void;
}

const realIo: GoalDocumentWriteIo = { writeFileSync, renameSync, rmSync, statSync, chmodSync };

/** Replace a goal document atomically (temp file next to it + rename) so a failed write never leaves a torn goal.
 *  The existing file's permission bits are kept, so a 0600 goal stays 0600 after replacement. */
export function writeGoalDocumentAtomic(path: string, document: string, io: GoalDocumentWriteIo = realIo): void {
  let mode: number | undefined;
  try { mode = io.statSync(path).mode & 0o777; } catch { mode = undefined; }
  const temporary = `${path}.self-answer-${process.pid}-${Date.now()}.tmp`;
  try {
    io.writeFileSync(temporary, document, mode === undefined ? undefined : { mode });
    if (mode !== undefined) io.chmodSync(temporary, mode);
    io.renameSync(temporary, path);
  } catch (error) {
    try { io.rmSync(temporary, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}
