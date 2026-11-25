// SIM-STEWARD-AB-1125 — stand-ins for the two open PRs the A/B device exercises, so the device compiles and runs on main.
// When #40072 (seatAssign) and #40074 (suggestWatch) land, the runner passes the real functions instead (same shapes).
// The seatAssign model keeps exactly the refusals the world can produce: not-coordinator · unknown-seat · unknown-cell ·
// live-writer (another seat's live PR touches a path the cell declares on its «대상 경로:» line).
import type { ChecklistItem } from '../release-loop/checklist.js';

export interface SimWriterRow { kind: 'pr'; ref: string; title: string; updatedAt: string; branch: string; paths: string[] }
export interface SimSeatAssignDeps {
  now: () => Date;
  coordinators: () => { hq: string; spaces: string[] };
  federationSeats: () => Set<string>;
  findCell: (id: string) => { version: string; item: ChecklistItem } | undefined;
  writers: (paths: string[]) => SimWriterRow[];
  assign: (version: string, cellId: string, seat: string) => { from: string | null; outcome: string };
  post: (mail: { from: string; to: string; body: string; kind: string; refs?: string[] }) => { id: number };
  wake: (seat: string, mailId: number, from: string) => Promise<{ result: string }>;
  pool: () => unknown;
}
export type SimSeatAssignResult = { ok: true } | { ok: false; code: string; reason: string };
export type SimSeatAssign = (input: { seat: string; cellId: string; actor: string; why?: string }, deps: SimSeatAssignDeps) => Promise<SimSeatAssignResult>;
export type SimSuggestWatch = (input: { kind?: string; refs?: string[] }) => string | null;

/** Live = the writer moved within this window (#40072 LIVE_WRITER_MS). */
const LIVE_MS = 2 * 60 * 60_000;

export const modelSeatAssign: SimSeatAssign = async (input, deps) => {
  const seat = input.seat.trim().toUpperCase();
  const actor = input.actor.trim().toUpperCase();
  const ladder = deps.coordinators();
  if (!new Set(['OP', ladder.hq, ...ladder.spaces].map((x) => x.toUpperCase())).has(actor)) return { ok: false, code: 'not-coordinator', reason: `seat assign: ${actor} is not a coordinator` };
  if (!deps.federationSeats().has(seat)) return { ok: false, code: 'unknown-seat', reason: `seat assign: ${seat} is not a registered federation seat` };
  const cell = deps.findCell(input.cellId);
  if (!cell) return { ok: false, code: 'unknown-cell', reason: `seat assign: no cell ${input.cellId}` };
  const line = (cell.item.body ?? '').split('\n').find((l) => l.startsWith('대상 경로:'));
  const paths = line ? line.slice('대상 경로:'.length).split(/[\s,·]+/u).filter(Boolean) : [];
  const now = deps.now().getTime();
  const blocking = paths.length ? deps.writers(paths).filter((w) => now - Date.parse(w.updatedAt) <= LIVE_MS && !w.branch.toUpperCase().startsWith(`${seat}/`)) : [];
  if (blocking.length) return { ok: false, code: 'live-writer', reason: `seat assign: another live writer holds ${cell.item.id}'s paths — ${blocking.map((w) => `${w.ref} (${w.branch})`).join(' · ')}` };
  deps.assign(cell.version, cell.item.id, seat);
  const mail = deps.post({ from: actor, to: seat, body: `[SEAT-ASSIGN] cell ${cell.item.id} → ${seat}`, kind: 'assign', refs: [`cell:${cell.item.id}`] });
  await deps.wake(seat, mail.id, actor);
  return { ok: true };
};

export const modelSuggestWatch: SimSuggestWatch = (input) => {
  const pr = (input.refs ?? []).map((r) => r.trim().toLowerCase()).find((r) => r.startsWith('pr:'))?.slice(3).replace(/^#/u, '');
  return pr && /^[1-9]\d{0,7}$/u.test(pr) && input.kind?.trim().toLowerCase() === 'pregate' ? `pregate-receipt:${pr}` : null;
};
