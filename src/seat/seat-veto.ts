// OP-DIRECT-ASSIGN (CEO 11-26 18:2x · release 0.3.38 P0) — the scope steward's veto over HQ's direct assignment.
//
// S: OP now assigns past a live scope 행정관 while hands sit idle (src/seat/seat-assign.ts · opDirectAssignOpen).
// C: the steward still knows its scope best — a wrong hand on a cell must be undone without a mail round to OP.
// Q: how does the steward undo or redirect an assignment so OP learns of it and the ledger shows who and why?
// A: `eln seat veto <cell> --reason <line> [--to <seat>]` — only the live steward of the cell owner's scope; reason required.
//    Compare-and-set on the owner (unassign = back to the board · --to = reassign), the checklist history keeps the claim row
//    (actor ⊕ «veto: …» reason = the audit row), one `seat.veto` log line, and one mail to OP (HQ).
//
// COORD-RIGHTS (CEO 11-27 08:0x): HQ (OP) may also undo / reassign any owned cell this way — no live steward needed.
//    Audit «override by HQ:OP: …», and the mail goes to the scope steward (or the previous owner) instead of to OP.
//
// OP-HELPERS-STABILIZE (11-27 21:2x): OP returning its OWN held cells to the board (owner OP, no steward) mailed OP
//    itself — 95 of 152 OP inbound mails in one hour were these self-notices (fed kpi «OP inbound/h 157» vs target 20).
//    The actor already knows what it did; when the recipient is the actor there is no mail (mailId null) — the checklist
//    claim row and the `seat.veto` log stay the audit.
//
// 세 얼굴: 관측 = `seat.veto` log ⊕ checklist history claim row ⊕ the OP mail · 판단 근거 = the reason line in all three ·
// 수복과 인계 = OP reads the mail and picks another hand (or accepts); a lost race says who owns the cell now.

import type { ChecklistItem } from '../release-loop/checklist.js';

export const SEAT_VETO_MAIL_KIND = 'coord';

export interface SeatVetoInput {
  readonly cellId: string;
  readonly actor: string;
  readonly reason: string;
  /** Reassign to this seat; absent = unassign (the cell goes back to the board). */
  readonly to?: string;
  readonly version?: string;
}

export interface SeatVetoDeps {
  readonly findCell: (cellId: string, version?: string) => { readonly version: string; readonly item: ChecklistItem } | undefined;
  /** The scope whose 행정관 is live for this hand (null = none) — the same answer seat assign uses. */
  readonly liveStewardScope: (seat: string) => string | null;
  readonly federationSeats: () => ReadonlySet<string>;
  /** Compare-and-set on the owner; writes the checklist history claim row (the audit row). */
  readonly swapOwner: (version: string, cellId: string, input: { expectedOwner: string | null; to: string | null; actor: string; reason: string }) =>
    { readonly outcome: 'swapped' | 'lost' | 'missing'; readonly owner: string | null };
  readonly post: (mail: { from: string; to: string; body: string; kind: string; refs: string[] }) => { readonly id: number };
  readonly hq: string;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
}

export type SeatVetoResult =
  | { readonly ok: true; readonly cellId: string; readonly version: string; readonly from: string; readonly to: string | null; readonly mailId: number | null; readonly audit: string; readonly lines: readonly string[] }
  | { readonly ok: false; readonly code: 'no-reason' | 'unknown-cell' | 'no-owner' | 'not-steward' | 'unknown-seat' | 'lost'; readonly reason: string };

export function seatVeto(input: SeatVetoInput, deps: SeatVetoDeps): SeatVetoResult {
  const actor = input.actor.trim().toUpperCase();
  const reason = input.reason.trim();
  const to = input.to?.trim().toUpperCase() || null;
  const log = (event: string, data: Record<string, unknown>) => { try { deps.log?.(event, data); } catch { /* fail-open */ } };
  if (!reason) return { ok: false, code: 'no-reason', reason: 'seat veto: a reason is required (--reason <line>)' };
  const cell = deps.findCell(input.cellId.trim(), input.version);
  if (!cell) return { ok: false, code: 'unknown-cell', reason: `seat veto: no cell ${input.cellId}${input.version ? ` in ${input.version}` : ''}` };
  const owner = cell.item.owner?.trim().toUpperCase();
  if (!owner) return { ok: false, code: 'no-owner', reason: `seat veto: ${cell.item.id} has no owner — nothing to veto` };
  let scope: string | null = null;
  try { scope = deps.liveStewardScope(owner)?.toUpperCase() ?? null; } catch { scope = null; }
  const hq = deps.hq.toUpperCase();
  const isHq = actor === hq || actor === 'OP';
  if (!isHq && (!scope || scope !== actor)) {
    log('seat.veto.refused', { cellId: cell.item.id, actor, owner, code: 'not-steward', scope });
    return { ok: false, code: 'not-steward', reason: `seat veto: only the live steward of ${owner}'s scope may veto${scope ? ` (steward:${scope})` : ' (no live steward)'} — ${actor || '(no seat)'} may not` };
  }
  if (to && !deps.federationSeats().has(to)) return { ok: false, code: 'unknown-seat', reason: `seat veto: ${to} is not a registered federation seat` };
  const asSteward = scope === actor;
  const label = asSteward ? `steward:${actor}` : `HQ:${actor}`;
  const audit = asSteward ? `veto by ${label}: ${reason.slice(0, 200)}` : `override by ${label}: ${reason.slice(0, 200)}`;
  const recipient = asSteward ? hq : (scope ?? owner);
  const swap = deps.swapOwner(cell.version, cell.item.id, { expectedOwner: cell.item.owner ?? null, to, actor, reason: audit });
  if (swap.outcome !== 'swapped') {
    log('seat.veto.refused', { cellId: cell.item.id, actor, owner, code: 'lost', now: swap.owner });
    return { ok: false, code: 'lost', reason: `seat veto: ${cell.item.id} changed under the veto (owner now ${swap.owner ?? 'none'}, or not yellow) — re-read and retry` };
  }
  const action = to ? `reassigned ${owner} → ${to}` : `unassigned ${owner} (back to the board)`;
  const body = [
    `[SEAT-VETO] cell ${cell.item.id} (${cell.version}) ${action} · by ${label}`,
    `reason: ${reason.slice(0, 240)}`,
    'audit: checklist history claim row (actor ⊕ reason) · log seat.veto',
    to ? 'No reply needed.' : 'Pick another hand if the cell still needs one (eln seat assign POOL <cell>).',
  ].join('\n');
  // A self-notice (the actor is the recipient — HQ returning its own cell) is not mailed: the audit row and log suffice.
  const mailId = recipient === actor ? null : deps.post({ from: actor, to: recipient, body, kind: SEAT_VETO_MAIL_KIND, refs: [`cell:${cell.item.id}`] }).id;
  log('seat.veto', { cellId: cell.item.id, version: cell.version, actor, from: owner, to, reason: reason.slice(0, 200), mailId });
  return { ok: true, cellId: cell.item.id, version: cell.version, from: owner, to, mailId, audit,
    lines: [`⛔ veto ${cell.item.id}: ${action} · audit «${audit}» · ${mailId === null ? `no mail (${recipient} is the actor)` : `mail #${mailId} → ${recipient}`}`] };
}
