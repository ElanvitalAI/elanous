// COORD-HA (0.2.19) — the signal the orchestrator tick reads for its degradation ladder (RFC loop map §A8b ④⑤):
// L1 = no usable LLM (rules only) · L2 = the task board cannot take a write (no new assignment). The tick already acts on
// `TickDeps.degradation`; until now nothing supplied it in production. Each probe answers «false» only on a measured
// failure — an unknown is not a degradation.
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { cardIndexPath, taskCardsDir } from '../../task-cards/card-store.js';
import { resolveUsableLlm } from '../../llm/usable-llm.js';

export interface DegradationSignal { llm: boolean; board: boolean; why: string[] }

/** The task board takes a write: its folder is a directory a file can be created in (created and removed — a permission
 *  bit is not proof · review r1), and its index can take a write lock (busy 2 s · rolled back). */
export function probeBoardWritable(root: string): { ok: boolean; why?: string } {
  const dir = taskCardsDir(root);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!statSync(dir).isDirectory()) return { ok: false, why: 'board dir not writable: not a directory' };
    // A fresh name each time — a leftover from a crashed probe can never make a writable board look full (review r2).
    const probe = join(dir, `.degradation-probe-${randomUUID()}`);
    try { writeFileSync(probe, '', { flag: 'wx', mode: 0o600 }); }
    finally { rmSync(probe, { force: true }); }
  } catch (error) { return { ok: false, why: `board dir not writable: ${(error as NodeJS.ErrnoException).code ?? String(error)}` }; }
  const index = cardIndexPath(root);
  // No index yet: the card store creates it on first open — a writable folder is enough.
  if (!existsSync(index)) return { ok: true };
  let db: Database | undefined;
  try {
    db = new Database(index, { readwrite: true, create: false });
    db.exec('PRAGMA busy_timeout = 2000');
    db.exec('BEGIN IMMEDIATE');
    db.exec('ROLLBACK');
    return { ok: true };
  } catch (error) {
    return { ok: false, why: `board index write lock: ${String(error instanceof Error ? error.message : error).slice(0, 160)}` };
  } finally { try { db?.close(); } catch { /* closing a failed handle is best effort */ } }
}

export interface DegradationDeps {
  usableLlm?: () => { usable: boolean; why: string };
  board?: (root: string) => { ok: boolean; why?: string };
}

export function probeDegradation(root: string, deps: DegradationDeps = {}): DegradationSignal {
  const why: string[] = [];
  let llm = true;
  try {
    const usable = (deps.usableLlm ?? resolveUsableLlm)();
    llm = usable.usable;
    if (!llm) why.push(`llm: ${usable.why}`);
  } catch (error) { why.push(`llm unknown: ${String(error).slice(0, 120)}`); }
  const board = (deps.board ?? probeBoardWritable)(root);
  if (!board.ok) why.push(board.why ?? 'board not writable');
  return { llm, board: board.ok, why };
}
