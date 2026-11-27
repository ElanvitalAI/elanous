// SEAT-INPLACE-UPDATE — the TUI side: watch the installed manifest, decide at idle boundaries, write the carry and
// leave through the seat-stop key; on boot, take the carry back (draft · queued person lines · notices) and verify the
// durable files did not change across the switch. Pure judgement lives in src/seat/inplace-update.ts.
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import {
  IN_PLACE_SEATS, decideInPlaceUpdate, inPlaceCardBody, planRestore, snapshotDurable, takeCarry, writeCarry,
  type SeatCarry,
} from '../seat/inplace-update.js';

export const INPLACE_POLL_MS = 30_000;

export interface SeatInPlacePorts {
  readonly seat: string | null;
  readonly sessionId: () => string | null;
  readonly carryRoot: string;
  readonly installRoot: string;
  readonly runningCommit: string | null;
  readonly installedCommit: () => string | null;
  readonly busy: () => boolean;
  readonly capsulesActive: () => boolean;
  readonly draft: () => string;
  readonly setDraft: (text: string) => void;
  readonly lastHumanKeyAt: () => number;
  readonly queueItems: () => readonly { readonly kind: string; readonly text: string; readonly source?: string }[];
  readonly enqueuePerson: (text: string) => void;
  readonly enqueueNotice: (text: string, source: string) => void;
  readonly provider: (sessionId: string) => { provider: string; model?: string } | undefined;
  readonly durableFiles: (sessionId: string) => Record<string, string>;
  readonly releaseWindow: () => string | null;
  readonly probe: (entry: string) => boolean;
  /** Leave the loop so the exit path relaunches (`requestTuiSelfRestart('seat-inplace-update:<id>')` + seat-stop key). */
  readonly leave: (sessionId: string) => void;
  readonly card: (body: string) => void;
  /** FU: notices held off-queue (CAPSULE-C2 FIFO · superseded steers) — carried as queue notices. */
  readonly heldNotices?: () => readonly { readonly text: string; readonly source?: string }[];
  /** FU: in-memory caps to carry (epoch ms) and where the new build puts them back. */
  readonly caps?: () => Record<string, number>;
  readonly restoreCaps?: (caps: Readonly<Record<string, number>>) => void;
  readonly now?: () => number;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
}

/** One tick — returns the decision (tests drive this directly; the TUI calls it from a timer and after each turn end). */
export function seatInPlaceTick(ports: SeatInPlacePorts, memo: { failed: Set<string>; probeFailures: Map<string, number>; leaving: boolean }) {
  const log = ports.log ?? ((event, data) => debug.log('seat.inplace-update', event, data));
  const now = (ports.now ?? Date.now)();
  if (memo.leaving) return { action: 'none' as const, reason: 'same-build' as const };
  const installed = ports.installedCommit();
  const items = ports.queueItems();
  const entry = join(ports.installRoot, 'current', 'node_modules', 'elanous', 'bin', 'elanous.mjs');
  const decision = decideInPlaceUpdate({
    seat: ports.seat, runningCommit: ports.runningCommit, installedCommit: installed, busy: ports.busy(),
    capsulesActive: ports.capsulesActive(), draftChars: ports.draft().length,
    queuedPersonLines: items.filter((item) => item.kind === 'user').length,
    lastHumanKeyAgoMs: now - ports.lastHumanKeyAt(), releaseWindow: ports.releaseWindow(), failedCommits: memo.failed,
    probe: () => ports.probe(entry), probeFailures: installed ? memo.probeFailures.get(installed) ?? 0 : 0,
  });
  if (decision.action !== 'none') log('decide', { ...decision, seat: ports.seat, running: ports.runningCommit, installed });
  if (decision.action === 'wait' && decision.reason === 'probe-retry' && installed) {
    memo.probeFailures.set(installed, (memo.probeFailures.get(installed) ?? 0) + 1);
  }
  if (decision.action === 'stay-card') {
    memo.failed.add(decision.toCommit);
    ports.card(inPlaceCardBody(ports.seat ?? '?', decision.reason, `new entry ${decision.toCommit.slice(0, 12)} did not start (--version)`));
  }
  if (decision.action === 'go') {
    const sessionId = ports.sessionId();
    if (!sessionId || !ports.seat) { log('blocked', { reason: 'no-session' }); return { action: 'none' as const, reason: 'same-build' as const }; }
    const files = ports.durableFiles(sessionId);
    const provider = ports.provider(sessionId);
    const carry: SeatCarry = {
      v: 1, seat: ports.seat, sessionId, fromCommit: ports.runningCommit, toCommit: decision.toCommit, writtenAt: now,
      ...(provider ? { provider } : {}),
      draft: ports.draft(),
      queuedPersonLines: items.filter((item) => item.kind === 'user').map((item) => item.text),
      notices: [...(ports.heldNotices?.() ?? []).map((n) => ({ text: n.text, source: n.source ?? 'held' })),
        ...items.filter((item) => item.kind !== 'user').map((item) => ({ text: item.text, source: item.source ?? 'carry' }))],
      ...(ports.caps ? { caps: ports.caps() } : {}),
      durable: snapshotDurable(files), durableFiles: files,
    };
    try {
      const path = writeCarry(ports.carryRoot, carry);
      log('carry-written', { path, draftChars: carry.draft.length, personLines: carry.queuedPersonLines.length, notices: carry.notices.length });
    } catch (error) {
      memo.failed.add(decision.toCommit);
      ports.card(inPlaceCardBody(ports.seat, 'carry-write-failed', String(error).slice(0, 160)));
      return { action: 'stay-card' as const, toCommit: decision.toCommit, reason: 'probe-failed' as const };
    }
    memo.leaving = true;
    ports.leave(sessionId);
  }
  return decision;
}

/** Boot side — restore the carry (if any) into this TUI and report the durable diff. */
export function restoreSeatCarry(ports: SeatInPlacePorts): { restored: boolean; lost: readonly string[] } {
  const log = ports.log ?? ((event, data) => debug.log('seat.inplace-update', event, data));
  if (!ports.seat || !IN_PLACE_SEATS.includes(ports.seat)) return { restored: false, lost: [] };
  const taken = takeCarry(ports.carryRoot, ports.seat, ports.sessionId(), (ports.now ?? Date.now)());
  if (!taken.carry) { if (taken.dropped) log('carry-dropped', { reason: taken.dropped }); return { restored: false, lost: [] }; }
  const carry = taken.carry;
  const plan = planRestore(carry, ports.draft(), snapshotDurable(carry.durableFiles));
  if (plan.draft) ports.setDraft(plan.draft);
  for (const line of plan.personLines) ports.enqueuePerson(line);
  for (const notice of plan.notices) ports.enqueueNotice(notice.text, notice.source);
  if (carry.caps) ports.restoreCaps?.(carry.caps);
  log('carry-restored', { from: carry.fromCommit, to: carry.toCommit, running: ports.runningCommit, draftChars: plan.draft.length,
    personLines: plan.personLines.length, notices: plan.notices.length, lost: plan.lost });
  if (plan.lost.length > 0) ports.card(inPlaceCardBody(carry.seat, 'durable-diff', `changed across the switch: ${plan.lost.join(', ')}`).replace('stayed on the old build', 'moved to the new build'));
  return { restored: true, lost: plan.lost };
}
