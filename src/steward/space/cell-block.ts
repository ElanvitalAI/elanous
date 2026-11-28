// GOAL-BLOCK-NOT-HUMAN ⊕ HAND-PULL-ON-BLOCK (live 11-25 19:05 · rail 31) — a hand whose cell waits on ANOTHER seat's
// approval / HOLD / decision is not «a person is needed». It parks the cell on the board as blocked-on:<seat> and pulls.
//
// S: after rail 31 (#40114) `eln work next` was called 0 times in 20 min; woken hands ended their turn with «⏸ Blocked: …
//    needs RES isolation approval — a person is needed» or «waiting 120 min for a new decision» and sat on that cell.
//    A cell blocked on a seat (no PR yet) is not a cell-wait.ts wait, so `eln work next` handed it back (exit 4 · WIP 1).
// C: no prose: the block is a structured ledger row (cell · holder · awaited seat · reason · exception mail id).
// Q: how does a hand leave a blocked cell without losing it, and how does the cell come back when the seat answers?
// A: `eln work block <cell> --on <seat> --reason …` (this module):
//      · the hand's lease ends — the cell goes back to the board (owner = the hand's scope coordinator, swapOwnerIf)
//      · one row in `<state>/steward/cell-blocks.jsonl` · one `steward-exception` mail to the awaited seat's coordinator
//        (once per cell × awaited seat while the block is open — a repeat block only refreshes the reason)
//      · `eln work next`: an OPEN block is a wait ('blocked-on') — never READY, never held for WIP 1.
//    The block RESOLVES when the awaited seat answers ABOUT the cell after the block — graphs/policies/work-pull.yaml
//    `block.resolve_on` (structured: sender ⊕ id order ⊕ reply_to ⊕ refs ⊕ the board's updatedBy, never the text):
//    reply-to = a reply to the exception mail · cell-ref = a mail whose refs carry cell:<ID> · cell-touch = the awaited
//    seat changed the cell. A resolved cell is re-offered to its last holder first: READY for it (ranked first), withheld
//    from other hands for {@link REOFFER_GRACE_MS}, then plain READY.
//    WORK-PULL-REACHES-ROSTER (audit 11-28 00:47–01:47Z): the old rule also took ANY later mail from the awaited seat to
//    the holder or its coordinator (`addressed-mail`) — 105 of 139 blocks waited on the hand's own coordinator, which mails
//    its hands all the time: 118 blocks «resolved» in a median 7 min and 93 of the hour's 149 claims were the same hand
//    re-taking the cell it had just parked (PWA-ELN-CONTRACT 8×), unchanged. A block on a WRITER cell (coordinator-held ·
//    the hand is its writer) releases the writer; the coordinator stays owner.
//
// 세 얼굴: 관측 = cell-blocks.jsonl (block · resume rows) ⊕ checklist history (claim row «work block · blocked-on:<seat>»)
//          ⊕ work-next.jsonl · 판단 근거 = {@link openBlocks} ⊕ {@link blockState} (rules, no LLM) · 수복과 인계 = the exception
//          mail to the awaited seat's coordinator · the re-offer to the last holder.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** After the awaited seat replies, other hands wait this long before the cell is plain READY for them. */
export const REOFFER_GRACE_MS = 15 * 60_000;

export type CellBlockRow = {
  readonly op: 'block' | 'resume';
  readonly at: string;
  readonly version: string;
  readonly cell: string;
  /** The hand that held the cell when it blocked. */
  readonly by: string;
  /** The awaited seat. */
  readonly on: string;
  readonly reason?: string;
  /** The exception mail sent at block time (the reply anchor). */
  readonly mailId?: number;
};

export const cellBlocksPath = (root: string): string => join(root, 'steward', 'cell-blocks.jsonl');

export function readCellBlockRows(path: string): CellBlockRow[] {
  if (!existsSync(path)) return [];
  const out: CellBlockRow[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Partial<CellBlockRow>;
      if ((row.op === 'block' || row.op === 'resume') && typeof row.cell === 'string' && typeof row.version === 'string'
        && typeof row.by === 'string' && typeof row.on === 'string' && typeof row.at === 'string') out.push(row as CellBlockRow);
    } catch { /* a torn line is skipped */ }
  }
  return out;
}

/** cell → its latest block row in `version` that no later resume row closed. */
export function openBlocks(rows: readonly CellBlockRow[], version: string): Map<string, CellBlockRow> {
  const open = new Map<string, CellBlockRow>();
  for (const row of rows) {
    if (row.version !== version) continue;
    if (row.op === 'block') open.set(row.cell, row);
    else open.delete(row.cell);
  }
  return open;
}

/**
 * Where a blocked cell stands for `seat` right now:
 *   blocked  = the awaited seat has not answered → a wait (never READY · not held)
 *   reoffer  = answered · `seat` is the last holder → READY for it, ranked first
 *   reserved = answered · another hand · inside the grace window → withheld
 *   ready    = answered · grace over → plain READY
 * `repliedAtMs` = when the awaited seat answered (undefined = not yet).
 */
export function blockState(block: CellBlockRow, seat: string, repliedAtMs: number | undefined, nowMs: number): 'blocked' | 'reoffer' | 'reserved' | 'ready' {
  if (repliedAtMs === undefined) return 'blocked';
  if (block.by.toUpperCase() === seat.toUpperCase()) return 'reoffer';
  return nowMs - repliedAtMs < REOFFER_GRACE_MS ? 'reserved' : 'ready';
}

export interface WorkBlockDeps {
  readonly now: () => number;
  readonly version: string;
  readonly cells: () => readonly { readonly id: string; readonly status: string; readonly owner?: string; readonly writer?: { readonly seat: string } }[];
  /** seat → its coordinator scope (federation ladder). */
  readonly scopeOf: (seat: string) => string;
  readonly blocks: () => readonly CellBlockRow[];
  readonly swap: (id: string, input: { expectedOwner: string | null; to: string | null; actor: string; reason: string }) => { outcome: 'swapped' | 'lost' | 'missing' };
  /** WORK-PULL-REACHES-ROSTER — release the caller's writer claim on a coordinator-held cell (owner stays). */
  readonly setWriter?: (id: string, input: { expectedOwner: string | null; expectedWriter: string | null; to: string | null; actor: string; reason: string }) => { outcome: 'swapped' | 'lost' | 'missing' };
  /** HQ coordinator: block notices to it go to the fed-state ledger + the 30-min steward digest, not one mail each
   *  (top OP inbound stream 11-25). Resume is unchanged: any later mail from the awaited seat to the hand/board. */
  readonly hq?: string;
  /** Posts the one exception mail; returns its id (undefined = not posted). */
  readonly mail: (input: { to: string; body: string; refs: string[] }) => number | undefined;
  readonly record: (row: CellBlockRow) => void;
}

export type WorkBlockResult =
  | { readonly code: 0; readonly line: string; readonly board: string; readonly mailed: boolean }
  | { readonly code: 2 | 5; readonly line: string };

const ownerSeat = (owner: string | undefined): string => (owner ?? '').split('/')[0]!.trim().toUpperCase();

/** `eln work block` — the caller's own yellow cell goes back to the board as blocked-on:<on>; one exception mail. */
export function workBlock(seatRaw: string, cellId: string, input: { on: string; reason: string }, deps: WorkBlockDeps): WorkBlockResult {
  const seat = seatRaw.trim().toUpperCase();
  const on = input.on.trim().toUpperCase();
  const reason = input.reason.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!on || !reason) return { code: 2, line: 'work block: --on <seat> and --reason <text> are required' };
  if (on === seat) return { code: 2, line: 'work block: --on names the awaited seat, not yourself' };
  const cell = deps.cells().find((c) => c.id === cellId);
  if (!cell) return { code: 5, line: `work block: no cell ${cellId} in ${deps.version}` };
  if (cell.status !== 'yellow') return { code: 5, line: `work block: ${cellId} is ${cell.status} — only an open (yellow) cell blocks` };
  const writing = !!deps.setWriter && cell.writer?.seat?.trim().toUpperCase() === seat && ownerSeat(cell.owner) !== seat;
  if (!writing && ownerSeat(cell.owner) !== seat) return { code: 5, line: `work block: ${cellId} is held by ${cell.owner ?? 'nobody'}, not ${seat}` };
  // A writer cell goes back to its owner's board (the coordinator stays owner) · an owned cell to the hand's coordinator.
  const board = writing ? ownerSeat(cell.owner) : deps.scopeOf(seat).trim().toUpperCase();
  const why = `work block · blocked-on:${on} · ${reason}`;
  const swapped = writing
    ? deps.setWriter!(cellId, { expectedOwner: cell.owner ?? null, expectedWriter: cell.writer!.seat, to: null, actor: seat, reason: why })
    : deps.swap(cellId, { expectedOwner: cell.owner ?? null, to: board, actor: seat, reason: why });
  if (swapped.outcome !== 'swapped') return { code: 5, line: `work block: ${cellId} changed under you (${swapped.outcome}) — read the board and retry` };
  const prior = openBlocks(deps.blocks(), deps.version).get(cellId);
  const at = new Date(deps.now()).toISOString();
  // Once per cell × awaited seat while the block stays open: a repeat block refreshes the row, not the mail.
  let mailId = prior && prior.on === on ? prior.mailId : undefined;
  let mailed = false;
  const coordinatorOf = deps.scopeOf(on).trim().toUpperCase() || on;
  const toHq = deps.hq !== undefined && coordinatorOf === deps.hq.trim().toUpperCase();
  if (!(prior && prior.on === on) && !toHq) {
    const coordinator = coordinatorOf;
    try {
      mailId = deps.mail({ to: coordinator, refs: [`cell:${cellId}`, `blocked-on:${on}`, `steward:${board}`],
        body: [`[행정관 · ${board}] 칸 ${cellId} 이(가) ${on} 을(를) 기다립니다 — ${seat} 는 다음 칸으로 갑니다`,
          `- 사유: ${reason}`,
          `- ${on} 이(가) ${seat} 또는 ${board} 에 답하면(이 우편에 회신) 칸은 ${seat} 에게 먼저 돌아갑니다.`].join('\n') });
      mailed = mailId !== undefined;
    } catch { mailId = undefined; }
  }
  deps.record({ op: 'block', at, version: deps.version, cell: cellId, by: seat, on, reason, ...(mailId !== undefined ? { mailId } : {}) });
  return { code: 0, board, mailed, line: `blocked ${cellId} on ${on} — back on the ${board} board · now run \`eln work next\`` };
}
