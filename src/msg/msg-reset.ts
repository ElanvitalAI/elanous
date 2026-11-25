// MSG-RESET (CEO 11-25 21:5x «진짜 리셋 — 메일 삭제 · 자리/스페이스/연방 단위») — delete a scope's mail for real.
// Always a snapshot first (VACUUM INTO <state>/msg/backups/reset-<ts>-<scope>.db) · dry-run by default · `--restore`.
// Deleted: msg_messages rows addressed to the scope's seats ⊕ every msg-store row keyed by those ids (message_id /
// request_id columns: acks · receipts · provenance · TA delivery/claim · SLA alerts) ⊕ the seats' cursors.
// Not touched: ledgers outside the msg store (wake ledger · commitment waits) — they key on ids that no longer resolve
// and close as «message gone» on their own read; the backup keeps the originals.
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalMessageAddress, type Message, type MsgStore } from './msg-store.js';
import { isProtectedMail } from './msg-clear.js';
import type { FederationLadder } from './hand-raise-ladder.js';

export type ResetScope = { kind: 'seat'; seat: string } | { kind: 'space'; coordinator: string } | { kind: 'federation' };
export interface ResetPlanSeat { seat: string; total: number; deletable: number; protectedKept: number }
export interface ResetPlan { scope: ResetScope; label: string; seats: ResetPlanSeat[]; ids: number[]; protectedKept: number }

function rowsTo(store: MsgStore, seat: string): Message[] {
  // Direct rows only, expired included (a reset empties the box, not just its live view).
  const ids = (store.db.query('SELECT id FROM msg_messages WHERE recipient = ? ORDER BY id').all(seat) as Array<{ id: number }>).map(r => r.id);
  return ids.map(id => store.getMessage(id)).filter((m): m is Message => m !== null);
}

/** Every direct recipient seat in the store (no ALL · no group address). */
export function knownSeats(store: MsgStore): string[] {
  return (store.db.query("SELECT DISTINCT recipient AS r FROM msg_messages WHERE recipient <> 'ALL' AND recipient NOT LIKE 'group:%' ORDER BY r").all() as Array<{ r: string }>).map(x => x.r);
}

export function scopeSeats(store: MsgStore, scope: ResetScope, ladder: Pick<FederationLadder, 'parentOf'> | null): string[] {
  const seats = knownSeats(store);
  if (scope.kind === 'federation') return seats;
  if (scope.kind === 'seat') return [canonicalMessageAddress(scope.seat)];
  const coord = canonicalMessageAddress(scope.coordinator);
  return seats.filter(s => s === coord || (ladder !== null && canonicalMessageAddress(ladder.parentOf(s)) === coord));
}

export function scopeLabel(scope: ResetScope): string {
  return scope.kind === 'federation' ? 'federation' : scope.kind === 'seat' ? `seat-${canonicalMessageAddress(scope.seat)}` : `space-${canonicalMessageAddress(scope.coordinator)}`;
}

export function planReset(store: MsgStore, scope: ResetScope, ladder: Pick<FederationLadder, 'parentOf'> | null, includeProtected: boolean): ResetPlan {
  const seats: ResetPlanSeat[] = [];
  const ids: number[] = [];
  let protectedKept = 0;
  for (const seat of scopeSeats(store, scope, ladder)) {
    const rows = rowsTo(store, seat);
    const keep = includeProtected ? [] : rows.filter(isProtectedMail);
    const del = rows.filter(m => includeProtected || !isProtectedMail(m));
    ids.push(...del.map(m => m.id));
    protectedKept += keep.length;
    seats.push({ seat, total: rows.length, deletable: del.length, protectedKept: keep.length });
  }
  return { scope, label: scopeLabel(scope), seats, ids, protectedKept };
}

export function backupDir(store: MsgStore): string { return join(dirname(store.db.filename), 'backups'); }

/** Online snapshot (VACUUM INTO) — consistent even with other writers on WAL. */
export function snapshotStore(store: MsgStore, label: string, now: Date): string {
  const dir = backupDir(store);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `reset-${now.toISOString().replace(/[:.]/g, '-')}-${label}.db`);
  store.db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  return path;
}

/** Tables in the msg store keyed by a message id (FK or by name) — the dependent rows a reset removes with the mail. */
function dependentColumns(store: MsgStore): Array<{ table: string; column: string }> {
  const tables = (store.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name <> 'msg_messages' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map(t => t.name);
  const out: Array<{ table: string; column: string }> = [];
  for (const table of tables) {
    const cols = (store.db.query(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(c => c.name);
    for (const column of ['message_id', 'request_id']) if (cols.includes(column)) out.push({ table, column });
  }
  return out;
}

export function applyReset(store: MsgStore, plan: ResetPlan, input: { by: string; backupPath: string }): { deleted: number; perSeat: Record<string, number> } {
  const deps = dependentColumns(store);
  const idSet = new Set(plan.ids);
  store.db.exec('PRAGMA foreign_keys = OFF');
  try {
    store.db.transaction(() => {
      for (let i = 0; i < plan.ids.length; i += 500) {
        const chunk = plan.ids.slice(i, i + 500);
        const marks = chunk.map(() => '?').join(',');
        for (const d of deps) store.db.query(`DELETE FROM "${d.table}" WHERE "${d.column}" IN (${marks})`).run(...chunk);
        store.db.query(`DELETE FROM msg_messages WHERE id IN (${marks})`).run(...chunk);
      }
      // A seat whose whole box went starts from 0 again; a seat with kept protected mail keeps its cursor.
      for (const s of plan.seats) if (s.protectedKept === 0) store.db.query('DELETE FROM msg_cursors WHERE recipient = ?').run(s.seat);
    }).immediate();
  } finally { store.db.exec('PRAGMA foreign_keys = ON'); }
  const perSeat: Record<string, number> = {};
  for (const s of plan.seats) {
    perSeat[s.seat] = s.deletable;
    if (s.deletable === 0) continue;
    store.post({ from: input.by, to: s.seat, kind: 'info', intent: 'info', refs: ['msg-reset:notice', `msg-reset-backup:${input.backupPath}`],
      body: `[mailbox reset · ${s.deletable} deleted · scope ${plan.label} · by ${input.by} · backup ${input.backupPath}]` }, { dedupe: false });
  }
  return { deleted: idSet.size, perSeat };
}

/** Restore a backup over the store file. Snapshots the current store first (returned) so a restore is itself undoable. */
export function restoreBackup(storePath: string, backupPath: string, openStore: () => MsgStore, now: Date): { preRestoreBackup: string } {
  if (!existsSync(backupPath)) throw new Error(`backup not found: ${backupPath}`);
  const cur = openStore();
  let pre: string;
  try { pre = snapshotStore(cur, 'pre-restore', now); } finally { cur.close(); }
  for (const suffix of ['-wal', '-shm']) rmSync(`${storePath}${suffix}`, { force: true });
  copyFileSync(backupPath, storePath);
  return { preRestoreBackup: pre };
}
