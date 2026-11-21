// OP-CHANNEL-INGRESS-1121 ③ wiring, eln-core side — the REAL session entry: when els put
// ELANOUS_CEO_INGRESS_SOCKET (+ this tab's ELANOUS_CEO_INGRESS_AUTH) in the seat tab env, the
// core HOSTS the ceo listener; one authenticated frame becomes the session's TURN INPUT (front of
// the queue, never shell typing) and knocks the idle door. JUD hold #122410 mustFix — the socket
// answer is the CONSUMPTION receipt: it HOLDS until the frame really leaves the queue as a
// delivered turn input (queue-only → the answer simply never comes; cancelled/superseded →
// refusal). JUD hold #122913 mustFix — the queue's `delivered` transition fires at DRAIN time,
// when the idle boundary hands the batch to the caller that submits it — BEFORE the turn
// accepts it — so the answer (and els' 👀) waits for the TUI's ACTUAL-INTAKE acknowledgement
// instead (onIntake below): accepted → answer(0); failed/cancelled submission → refusal.
// The 👀 receipt stays the els producer's business on that answer — this side only delivers.
//
// Neutral like protocol.ts: no els imports — the TUI entry point and tests both import THIS.
import {
  ENV_CEO_INGRESS_AUTH,
  ENV_CEO_INGRESS_SOCKET,
  ceoFrameAuth,
  startCeoIngressFromEnv,
  type CeoIngressFrame,
  type CeoIngressListener,
  type CeoAcceptedTurn,
} from './ceo-ingress.js';

export { ENV_CEO_INGRESS_AUTH, ENV_CEO_INGRESS_SOCKET };
export type { CeoIngressFrame, CeoIngressListener };

/** The queued turn-input notice the entry's enqueue handed back — its id keys the consumption wait. */
export interface CeoIngressQueuedNotice { readonly id: string }

/**
 * How a queued notice left `queued` (the queue only fires this on the three terminal leaves).
 * `delivered` = it became a real turn's input (the honest 👀 moment); anything else = it never did.
 */
export type CeoIngressQueueTransitionStatus = 'delivered' | 'cancelled' | 'superseded';
export interface CeoIngressQueueTransition { readonly id: string; readonly status: CeoIngressQueueTransitionStatus }
/**
 * JUD hold #122913 — the TUI's acknowledgement of ACTUAL TURN INTAKE for a dequeued notice:
 * `accepted` = a real turn took it as its input (the honest 👀 moment); `failed`/`cancelled`
 * = the submission after the drain never got it there (never a 👀). The queue's `delivered`
 * transition fires at drain hand-out — before submission — so the receipt binds here.
 */
export type CeoIngressIntakeStatus = 'accepted' | 'failed' | 'cancelled';
export interface CeoIngressIntake { readonly id: string; readonly status: CeoIngressIntakeStatus; readonly turn?: CeoAcceptedTurn }

/** The structural doors one consumed frame walks through (the TUI supplies the impls). */
export interface CeoIngressDoors {
  /** One authenticated frame lands as THIS turn's input text — front of the queue, never typed. */
  readonly enqueueNotice: (text: string, source: 'ceo-ingress', meta?: { readonly occurredAt?: number; readonly ceo?: { readonly source: string; readonly threadId: string; readonly messageId: string; readonly ingressId: string } }) => CeoIngressQueuedNotice;
  /** The queued turn input must wake the seat (the idle door). */
  readonly knock: () => void;
  /**
   * JUD hold #122410 — the consumption signal: the queue tells when a queued item leaves. The entry
   * holds its socket answer until THIS frame's notice leaves as `delivered` (a real turn consumed
   * it) and refuses on `cancelled`/`superseded` (never consumed — never a 👀). Returns the unsubscribe.
   */
  readonly onTransition: (listener: (item: CeoIngressQueueTransition) => void) => () => void;
  /** JUD hold #122913 — the ACTUAL-INTAKE acknowledgement channel (see {@link CeoIngressIntake}). */
  readonly onIntake: (listener: (item: CeoIngressIntake) => void) => () => void;
}

/** The turn-input text one ceo frame becomes — the conversation anchors the thread, text verbatim. */
export function ceoFrameTurnText(frame: CeoIngressFrame): string {
  const event = frame.event;
  switch (event.kind) {
    case 'ceo-message': return `[TG-CEO ${event.threadId}/${event.messageId}] ${event.text}`;
    case 'ceo-escalation': return `[TG-CEO ${event.threadId}/${event.messageId}] ⏰ ${event.text}`;
    default: return `[TG-CEO ${event.threadId}/${event.messageId}] RES 대행 중단`;
  }
}

/** The one-call product wiring: host the ceo listener when els provisioned this tab.
 *  Absent env (no socket) → undefined: the seat never half-boots a ceo entrance. */
export async function wireCeoIngressEntry(
  env: NodeJS.ProcessEnv,
  doors: CeoIngressDoors,
): Promise<CeoIngressListener | undefined> {
  const waiting = new Map<string, Promise<void | CeoAcceptedTurn>>();
  return startCeoIngressFromEnv(env, (frame) => {
    const event = frame.event;
    const key = event.kind === 'ceo-message' ? `${event.source}\u0000${event.threadId}\u0000${event.messageId}` : null;
    if (key && waiting.has(key)) return waiting.get(key)!;
    const notice = doors.enqueueNotice(ceoFrameTurnText(frame), 'ceo-ingress', {
      occurredAt: frame.at,
      ...(event.kind === 'ceo-message' ? { ceo: { source: event.source, threadId: event.threadId,
        messageId: event.messageId, ingressId: ceoFrameAuth(frame, env[ENV_CEO_INGRESS_AUTH] ?? '') } } : {}),
    });
    // JUD hold #122410 + #122913 mustFix — the answer must NOT ride on the enqueue/knock return,
    // and not on the queue's `delivered` transition either: that fires at DRAIN time, when the
    // idle boundary hands the batch to the caller that submits it — BEFORE the turn accepts it
    // (a drained item can fail or be cancelled at submission). The answer holds for the TUI's
    // ACTUAL-INTAKE acknowledgement instead (els wires 👀 exactly on that answer): accepted →
    // answer(0); failed/cancelled submission → refusal (no 👀); queue-only → the answer never
    // comes (no 👀 — the SLA's 🔴/⏰ keep telling the truth); cancelled/superseded while queued
    // → refusal (no 👀); failed delivery → nothing here ever ran (no 👀). Both listeners
    // register before the knock: the wake that drains this very notice cannot slip past the wait.
    const accepted = new Promise<void | CeoAcceptedTurn>((resolve, reject) => {
      let settled = false;
      const offIntake = doors.onIntake((item) => {
        if (item.id !== notice.id || settled) return; // another item's intake — this frame keeps waiting
        settled = true;
        offTransition();
        if (item.status === 'accepted') resolve(item.turn);
        else reject(new Error(`ceo frame turn submission ${item.status} — never accepted as turn input`));
      });
      const offTransition = doors.onTransition((item) => {
        if (item.id !== notice.id || settled) return;
        if (item.status === 'delivered') return; // drain hand-out, not intake — #122913: keep waiting for the ack
        settled = true;
        offIntake();
        reject(new Error(`ceo frame left the queue as ${item.status} — never turn input`));
      });
      doors.knock();
    });
    if (key) {
      waiting.set(key, accepted);
      void accepted.then(() => { waiting.delete(key); }, () => { waiting.delete(key); });
    }
    return accepted;
  });
}
