/**
 * MAIL-TRIAGE-TASKQUEUE — the next TUI's arrival seam: every seat mail that the watcher queued is triaged into the
 * session's task ledger (mail-triage.ts). A duplicate / status delta merged into an open task leaves the queue with
 * the `triage-merged` cancel reason (the watcher settles it as absorbed) and is not passed on — it never costs a turn.
 * Everything else (A · B · C · E and first-time D) flows on unchanged; the NEED-HUMAN and autopilot hooks always see
 * every arrival (they are called before this filter by entry.ts).
 */
import type { SeatMailArrivalInfo } from '../seat-mail-arrival.js';
import { TRIAGE_MERGED_CANCEL_REASON } from '../seat-mail-arrival.js';
import { createMailTriageLedger, type MailTriageLedger, type MailTriageLedgerOptions, type MailTriageVerdict } from './mail-triage.js';

export interface MailTriageWireDeps {
  /** Remove the queued notice of this mail with a cancel reason (fail-open). Returns how many were removed. */
  readonly removeQueuedNotice: (match: { source: string; msgId: number; reason: string }) => number;
  readonly ledger?: MailTriageLedger;
  readonly ledgerOptions?: MailTriageLedgerOptions;
}

export interface MailTriageWire {
  readonly ledger: MailTriageLedger;
  /** Triage arrivals; returns the ones that still open (or join) a turn. */
  filterArrivals(arrivals?: readonly SeatMailArrivalInfo[]): readonly SeatMailArrivalInfo[] | undefined;
  /** The last verdict per msgId (observation · tests). */
  verdictOf(msgId: number): MailTriageVerdict | undefined;
}

export function createMailTriageWire(deps: MailTriageWireDeps): MailTriageWire {
  const ledger = deps.ledger ?? createMailTriageLedger(deps.ledgerOptions);
  const verdicts = new Map<number, MailTriageVerdict>();
  return {
    ledger,
    verdictOf: (msgId) => verdicts.get(msgId),
    filterArrivals(arrivals) {
      if (arrivals === undefined) return undefined;
      const kept: SeatMailArrivalInfo[] = [];
      for (const arrival of arrivals) {
        if (arrival.msgId === undefined) { kept.push(arrival); continue; }
        let verdict: MailTriageVerdict;
        try {
          verdict = ledger.ingest({
            msgId: arrival.msgId, from: arrival.sender ?? '', kind: arrival.kind ?? null, intent: arrival.intent ?? null,
            crownDirective: arrival.crownDirective ?? null, origin: arrival.origin ?? null, replyTo: arrival.replyTo ?? null,
            refs: arrival.refs ?? null, correlationId: arrival.correlationId ?? null, supersedes: arrival.supersedes ?? null,
            resultState: arrival.resultState ?? null, doneWhen: arrival.doneWhen ?? null, deadlineAt: arrival.deadlineAt ?? null,
            needsAck: arrival.needsAck ?? null, priority: arrival.priority ?? null, senderAbove: arrival.senderAbove ?? null,
            replyToOwn: arrival.replyToOwn ?? null, cellDelegated: arrival.cellDelegated ?? null,
            ...(arrival.body === undefined ? {} : { body: arrival.body }),
          });
        } catch {
          kept.push(arrival); // triage failure never loses a mail
          continue;
        }
        verdicts.set(arrival.msgId, verdict);
        // A D merged into an open task is absorbed here (its notice leaves the queue). Passive mail (the router's default:
        // status · notice · reply · routine request · C) already waits in the queue for the 10-min digest
        // (SEAT-MAIL-PASSIVE-DEFAULT — the notice producer marks it with the same router); only `turn` mail opens a turn.
        if (verdict.cls === 'D' && !verdict.costsTurn) {
          let removed = 0;
          try { removed = deps.removeQueuedNotice({ source: 'seat-mail', msgId: arrival.msgId, reason: TRIAGE_MERGED_CANCEL_REASON }); } catch { removed = 0; }
          if (removed > 0) continue;
        }
        kept.push(arrival);
      }
      return kept;
    },
  };
}
