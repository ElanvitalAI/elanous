// ── OP pulse digest `op-control/pulse-digest` (OP-WAKE-COMMIT-BATCH · P0 · 대표 11-26 04:5x) ─────────────────────
//
// S: due self-wakes and commitment follow-ups reached OP as bursts — «예약 깨움 묶음 · 6건» plus four «깨우개 발화»
//    in one turn, each asking OP to re-read and re-decide.
// C: the OP inbox already batches non-P0 mail to the pulse (#40191) — but scheduled wakes opened their own turns, and the
//    batch turn listed every notice raw, so OP still re-derived «what is done, what is late» by itself.
// A: (1) on the OP seat a due scheduled wake is queued (source `scheduled-wake`) and rides the pulse batch like held mail;
//    (2) the released batch turn opens with ONE digest whose outcomes are pre-evaluated from facts already measured by the
//    watchers (waker status · commitment ledger): ✅ done · ⏰ overdue · ▶ needs action. Crown / urgent / release-stop
//    mail is P0 and never waits (queue-finish-first). A missing pulse still releases at the 30-min max hold.
//
// Three faces:
//   observe = `tui.queue held|released` (reason pulse/starvation) ⊕ the digest head line on the batch turn
//   decision basis = waker status (fired·expired·armed past deadline) ⊕ commitment status — never the model's memory
//   repair & handoff = an overdue / needs-action row names the commitment id and the close door (done needs the facts)

import { CommitmentLedger, type CommitmentEntry } from '../commitment/ledger.js';
import { listWakers, type SelfTimerDeps, type WakerRecord } from '../msg/self-timer-watch.js';

export type DigestBucket = 'done' | 'overdue' | 'action';

export interface DigestRow {
  readonly bucket: DigestBucket;
  readonly commitmentId: string;
  readonly line: string;
}

const clock = (iso: string | undefined): string => {
  if (!iso) return '--:--';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '--:--' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/**
 * Pure: classify each commitment from its wakers (facts the watchers measured) — one row per commitment, newest waker wins.
 * done = closed done since `sinceMs` · overdue = open with a waker expired or armed past its deadline · action = open and a
 * waker fired without auto-closing (the condition held, the owner must act) or blocked. Pending (armed, not due) is omitted.
 */
export function classifyDigest(commitments: readonly CommitmentEntry[], wakers: readonly WakerRecord[], nowMs: number, sinceMs: number): DigestRow[] {
  const byCommitment = new Map<string, WakerRecord[]>();
  for (const w of wakers) byCommitment.set(w.commitmentId, [...(byCommitment.get(w.commitmentId) ?? []), w]);
  const rows: DigestRow[] = [];
  for (const c of commitments) {
    const ws = (byCommitment.get(c.id) ?? []).slice().sort((a, b) => Date.parse(a.armedAt) - Date.parse(b.armedAt));
    const last = ws.at(-1);
    const cond = last ? ` · ${last.condition}` : '';
    if (c.status === 'done') {
      if (Date.parse(c.updatedAt) >= sinceMs) rows.push({ bucket: 'done', commitmentId: c.id, line: `${c.id} «${c.text}»${cond} · ${c.doneEvidence ?? 'done'}` });
      continue;
    }
    if (c.status === 'blocked') { rows.push({ bucket: 'action', commitmentId: c.id, line: `${c.id} «${c.text}» · blocked: ${c.reason ?? '?'}` }); continue; }
    if (c.status !== 'open' || !last) continue;
    if (last.status === 'expired' || (last.status === 'armed' && nowMs >= Date.parse(last.deadlineAt))) {
      rows.push({ bucket: 'overdue', commitmentId: c.id, line: `${c.id} «${c.text}»${cond} · not met by ${clock(last.deadlineAt)}` });
    } else if (last.status === 'fired') {
      rows.push({ bucket: 'action', commitmentId: c.id, line: `${c.id} «${c.text}»${cond} · condition held${last.evidence ? ` (${last.evidence})` : ''} — continue or close` });
    }
  }
  return rows;
}

/** Pure: the one digest block (null when there is nothing to say). `wakes` = the scheduled-wake reasons riding this pulse. */
export function formatPulseDigest(rows: readonly DigestRow[], wakes: number): string | null {
  if (rows.length === 0 && wakes === 0) return null;
  const pick = (b: DigestBucket) => rows.filter((r) => r.bucket === b);
  const done = pick('done'); const overdue = pick('overdue'); const action = pick('action');
  const section = (head: string, list: readonly DigestRow[]) => (list.length ? [`${head} (${list.length})`, ...list.map((r) => `  - ${r.line}`)] : []);
  return [
    `[Pulse digest · done ${done.length} · overdue ${overdue.length} · needs action ${action.length} · scheduled wakes ${wakes}] Outcomes are pre-evaluated from facts — act on overdue and needs-action only; done needs no reply.`,
    ...section('✅ Done', done),
    ...section('⏰ Overdue', overdue),
    ...section('▶ Needs action', action),
    'Close an overdue commitment as reassigned or blocked with a reason when its outcome will not come; «request sent» or a reply is not done.',
  ].join('\n');
}

export interface OpPulseDigestDeps {
  readonly ledger?: CommitmentLedger;
  readonly timer?: SelfTimerDeps;
  readonly now?: () => number;
}

/** Read the OP ledger + wakers once and build the digest (fail-open: a read error → null, the batch still goes). */
export function readPulseDigest(seat: string, sinceMs: number, wakes: number, deps: OpPulseDigestDeps = {}): string | null {
  try {
    const ledger = deps.ledger ?? new CommitmentLedger();
    const commitments = ledger.list(seat);
    const wakers = listWakers(seat, { ...deps.timer, ledger });
    return formatPulseDigest(classifyDigest(commitments, wakers, (deps.now ?? Date.now)(), sinceMs), wakes);
  } catch {
    return wakes > 0 ? formatPulseDigest([], wakes) : null;
  }
}
