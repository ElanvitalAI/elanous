/**
 * ELN-EXTERNAL-EVENTS-NOTICE-ONE — one external event leaves the idle
 * queue as its own turn. Entry calls `noteExternalEventOne` only.
 * This leaf injects, and it handles when the turn ends. The zero-miss
 * receipt is called here. A bundle of many notices is a later PR.
 *
 * A duplicate or a refusal is not injected. `receivedAt` is the poll that
 * took the notice. `injectedAt` is the later moment this leaf put it into
 * the turn. A receipt is ok only after the turn actually finished.
 * An unknown occurrence time is not a zero wait.
 */

import { createExternalEventLedger, type ExternalEventKind, type ExternalEventLedger } from './external-event-ledger.js';
import { externalEventZeroMissReceipt, type ExternalEventZeroMissReceipt } from './external-event-receipt.js';

// The verdict is the one definition in its own leaf: the entry chain's
// import-failure branch uses the same predicate without loading this module.
import { noticeOneDispatch } from './external-event-one-verdict.js';
export { noticeOneDispatch };

export interface ExternalEventOneNotice {
  readonly id: string;
  readonly text: string;
  readonly source?: string;
  /**
   * When the event existed, if the producer knows.
   * Absent is unknown — the receipt must not invent a wait of zero.
   */
  readonly occurredAt?: number;
}

export type ExternalEventOnePhase = 'received' | 'injected' | 'handled' | 'duplicate' | 'refused';

/**
 * Entry's follow-up on the dispatch verdict, as one leaf. Entry hands its
 * own callbacks in; the leaf decides nothing on its own. A refusal or a
 * duplicate is not a turn, and the item is already off the queue, so a
 * later item is woken here. A new row starts the notice turn.
 */
export function dispatchExternalEventOne(input: {
  readonly opened: ExternalEventOneOpened;
  readonly dispatch: ReturnType<typeof noticeOneDispatch>;
  readonly remaining: number;
  /** Entry's key inject: wakes the idle door for a later queued item. */
  readonly injectKey: () => void;
  /** Entry keeps the opened notice for the turn that answers it. */
  readonly keepOpen: (opened: ExternalEventOneOpened) => void;
  readonly startChatTurn: (text: string, status: string) => void;
  readonly log: (event: string, fields: Record<string, unknown>) => void;
}): void {
  if (!input.dispatch.startTurn) {
    input.log('queue-notice-not-injected', { source: input.opened.source, remaining: input.remaining });
    if (input.dispatch.wakeQueue) input.injectKey();
    return;
  }
  input.keepOpen(input.opened);
  input.log('queue-dispatched-notice', { source: input.opened.source, remaining: input.remaining });
  input.startChatTurn(input.opened.text, `[notice · ${input.opened.source ?? 'queue'}] auto-submitted`);
}

export interface ExternalEventOneNote {
  readonly noted: boolean;
  /** True only when this call put the notice into the turn. A duplicate or a refusal is false. */
  readonly injected: boolean;
  readonly phase: ExternalEventOnePhase;
  readonly receipt: ExternalEventZeroMissReceipt;
}

/** What entry keeps for the one notice it just opened. Entry does not inject or finish. */
export interface ExternalEventOneOpened {
  readonly id: string;
  readonly source: string;
  readonly text: string;
  readonly receivedAt: number;
  readonly occurredAt?: number;
  /** True only when the leaf accepted and injected this id. A duplicate or a refusal is false. */
  readonly injected: boolean;
  /** The leaf runs this when the notice turn ends. Entry only forwards the turn result. */
  readonly finish: (turnOk: boolean) => Promise<ExternalEventOneNote>;
}

function kindOf(source: string | undefined): ExternalEventKind {
  if (source === 'wakeup') return 'wakeup';
  if (source === 'harness-child' || source === 'graph-node' || source === 'capsule-done') return 'child-exit';
  if (source === 'graph-end') return 'graph-end';
  return 'mail';
}

function failedReceipt(ledger: ExternalEventLedger, id: string, occurredAt: number | undefined): ExternalEventZeroMissReceipt {
  const receipt = externalEventZeroMissReceipt({
    ledger,
    samples: [{ id, ...(occurredAt === undefined ? {} : { occurredAt }) }],
  });
  return { ...receipt, ok: false };
}

/** One book for the TUI process. Tests reset it. */
let sessionLedger: ExternalEventLedger = createExternalEventLedger();

export function resetExternalEventOneWire(ledger: ExternalEventLedger = createExternalEventLedger()): ExternalEventLedger {
  sessionLedger = ledger;
  return sessionLedger;
}

/**
 * The one call entry makes when a notice leaves the idle queue.
 * `receivedAt` is `at` (the poll that took it). Injection is this same
 * call, a moment later, and only when the row was accepted. A duplicate
 * or a full book is not injected and does not borrow the first row.
 * Handling waits for the finisher this call returns.
 */
export function openExternalEventOne(input: {
  id: string;
  text: string;
  source?: string;
  occurredAt?: number;
  receivedAt?: number;
}): ExternalEventOneOpened {
  const receivedAt = input.receivedAt ?? Date.now();
  const noted = noteExternalEventOne({
    id: input.id,
    text: input.text,
    source: input.source,
    ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
  }, receivedAt);
  const occurredAt = input.occurredAt;
  return {
    id: input.id,
    source: input.source ?? 'queue',
    text: input.text,
    receivedAt,
    ...(occurredAt === undefined ? {} : { occurredAt }),
    injected: noted.injected,
    finish: (turnOk: boolean) => Promise.resolve(finishExternalEventOne({
      id: input.id,
      ...(occurredAt === undefined ? {} : { occurredAt }),
      turnOk,
    })),
  };
}

/**
 * Kept for the verdict table. Entry does not call this. `openExternalEventOne`
 * is the one entry call, and it injects only a new row.
 */
export function noteExternalEventOne(
  notice: ExternalEventOneNotice,
  at = Date.now(),
): ExternalEventOneNote {
  const received = sessionLedger.receive({
    id: notice.id,
    kind: kindOf(notice.source),
    source: notice.text,
    at,
  });
  if (!received.ok) {
    return {
      noted: false,
      injected: false,
      phase: received.reason === 'duplicate' ? 'duplicate' : 'refused',
      receipt: failedReceipt(sessionLedger, notice.id, notice.occurredAt),
    };
  }
  const injectedAt = at + 1;
  const injected = sessionLedger.inject(notice.id, injectedAt);
  return {
    noted: true,
    injected: injected !== null,
    phase: injected ? 'injected' : 'received',
    receipt: failedReceipt(sessionLedger, notice.id, notice.occurredAt),
  };
}

/**
 * The notice turn finished. Entry does not call this. `noteExternalEventOne`
 * keeps the finisher and runs it when the turn ends. Only this step may post
 * an ok receipt, and only when the row was received, injected, and the
 * occurrence time is known and inside the bound.
 */
export function finishExternalEventOne(input: {
  id: string;
  occurredAt?: number;
  at?: number;
  turnOk: boolean;
}): ExternalEventOneNote {
  const at = input.at ?? Date.now();
  const row = sessionLedger.rows().find((item) => item.id === input.id);
  if (!row) {
    return { noted: false, injected: false, phase: 'refused', receipt: failedReceipt(sessionLedger, input.id, input.occurredAt) };
  }
  if (!input.turnOk) {
    return { noted: false, injected: row.injectedAt !== null, phase: row.injectedAt === null ? 'received' : 'injected', receipt: failedReceipt(sessionLedger, input.id, input.occurredAt) };
  }
  const handled = sessionLedger.handle(input.id, at);
  if (!handled) {
    return {
      noted: false,
      injected: row.injectedAt !== null,
      phase: row.handledAt === null ? 'received' : 'duplicate',
      receipt: failedReceipt(sessionLedger, input.id, input.occurredAt),
    };
  }
  const receipt = externalEventZeroMissReceipt({
    ledger: sessionLedger,
    samples: [{ id: input.id, ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }) }],
  });
  return { noted: receipt.ok, injected: true, phase: 'handled', receipt };
}
