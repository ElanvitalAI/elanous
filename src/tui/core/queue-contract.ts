// Next TUI queue contract (types · lifecycle error · input mode) — split out of queue.ts (size-contract: 600-line module limit).

export type NextTuiQueueInterruptReason = 'interrupt' | 'esc' | 'timeout-15m' | 'stream-stall';

export type NextTuiQueueSettle =
  | { kind: 'none' }
  | { kind: 'wake' }
  /** A200: after Esc the queued input leaves as the next turn by itself (not restored to the draft). */
  | { kind: 'resubmit'; count: number }
  /** ELN-CANCEL-RESTORE-RULE: Esc with nothing queued and no response at all gives the sent text back to the prompt. */
  | { kind: 'restore-original'; text: string };

/** What the just-ended turn looked like, for the Esc rule. `responded` = any reply text or tool activity happened. */
export interface NextTuiSettledTurn { readonly text: string; readonly responded: boolean }

export type NextTuiQueueDequeue =
  | { kind: 'none' }
  /** SEAT-INBOX B1-C — dequeue 뒤에도 ledger msgId(우편 영수 키)가 떨어지지 않는다(#38804 eventId 사슬). */
  | { kind: 'submit'; id: string; text: string; remaining: number; afterInterrupt: boolean; interruptReason?: NextTuiQueueInterruptReason; itemKind: NextTuiQueueItemKind; source?: NextTuiQueueNoticeSource; occurredAt?: number; msgId?: number };

/**
 * ELN-QUEUE-ITEM-STATE (CONDUCTOR ELN-STEER-AND-TOOL-WATCHDOG §6 «입력 큐 항목»).
 * `steer` joins the running turn at its next tool-result boundary; `queue` waits for the idle boundary.
 */
export type NextTuiQueueDelivery = 'steer' | 'queue';
/** §6 transitions: `queued → delivered` (terminal), `queued → cancelled`, `queued → superseded`. */
export type NextTuiQueueItemStatus = 'queued' | 'delivered' | 'cancelled' | 'superseded';
export type NextTuiQueueBoundary = 'tool-result' | 'idle';
/**
 * CEO addendum C: a queue item is either something the person typed (`user`) or a completion notice
 * (`notice`: sidetab result · harness child finished · seat mail arrived). Producers of notices are
 * ELN-CHILD-NOTICE-INTO-QUEUE; this file only owns their place in the order.
 */
export type NextTuiQueueItemKind = 'user' | 'notice';
export type NextTuiQueueNoticeSource = 'sidetab' | 'harness-child' | 'seat-mail' | 'seat-mail-guide' | 'graph-node' | 'event-watch' | 'capsule-done' | 'ceo-ingress' | 'work-pull' | 'scheduled-wake';

/** Input mode decides batching: a slash command or `!` shell line never travels with ordinary chat. */
export type NextTuiQueueMode = 'chat' | 'command' | 'shell';

export function nextTuiQueueMode(text: string): NextTuiQueueMode {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('/')) return 'command';
  if (trimmed.startsWith('!')) return 'shell';
  return 'chat';
}

export interface NextTuiQueueItem {
  readonly id: string;
  /** Monotonic per queue (= per TUI session); never renumbered, not even when an item is superseded. */
  readonly seq: number;
  /** When this queue accepted the item, in epoch milliseconds. */
  readonly enqueuedAt?: number;
  readonly kind: NextTuiQueueItemKind;
  readonly mode: NextTuiQueueMode;
  readonly delivery: NextTuiQueueDelivery;
  readonly status: NextTuiQueueItemStatus;
  /** Original text — kept as typed even after cancel/supersede. */
  readonly text: string;
  /** Child-side steer handle while the item waits as «조향 대기» (A200). */
  readonly steerId?: string;
  readonly supersededBy?: string;
  /** Set only for `kind: 'notice'`. */
  readonly source?: NextTuiQueueNoticeSource;
  /** SEAT-INBOX B1-C: the ledger message a `seat-mail` notice carries — the receipt key (never parsed from text). */
  readonly msgId?: number;
  /** Why a `cancelled` item was cancelled (the `cancel` reason) — a watcher tells «carried into the running turn» from a drop. */
  readonly cancelReason?: string;
  readonly urgent?: boolean;
  /** QUEUE-FINISH-FIRST: the mail's class from its structured ledger fields (intent · origin · crown) — set at enqueue. */
  readonly mailClass?: 'P0' | 'P1' | 'P2';
  /** CLAUDE-OP-PROXY-LANE — 0 = crown / a person · 1 = the CEO's proxy · absent = the rest (order inside the notices). */
  readonly mailRank?: 0 | 1;
  /** QUEUE-P1-3MIN: the mail's structured intent (request · decision · info · alert) — a decision joins at once. */
  readonly mailIntent?: string;
  readonly mailKind?: string;
  /** QUEUE-FINISH-FIRST: the ledger `replyTo` of a seat mail — a reply to a mail the current work waits on joins it. */
  readonly replyTo?: number;
  /** SEAT-MAIL-COALESCE-NOTICE: an info seat mail — waits like a passive result, listed in the next digest. */
  readonly passive?: boolean;
  /** SEAT-MAIL-COALESCE-NOTICE: this mail's one digest line (`#id · from · kind · body…`). */
  readonly digest?: string;
  /** NOTICE-FOLD-1LINE: a `seat-mail` notice's sender and where the mail's own body sits — in `text` (`bodyAt`) and
   *  in its `digest` line (`digestBodyAt`) — so the chat folds each mail of a digest to its own line. */
  readonly mail?: NextTuiQueueMailSpan;
  /** BULK-TRIAGE: a seat mail's structured ledger fields for the bulk triage card (set by the producer, never parsed). */
  readonly triage?: NextTuiQueueTriageMeta;
  readonly foldedMail?: readonly NextTuiQueueFoldedMail[];
  /**
   * When a notice existed, if the producer knows. Absent means unknown.
   * The zero-miss receipt must not treat unknown as a zero wait.
   */
  readonly occurredAt?: number;
  /** A coalesced capsule completion notice keeps one queue row for all pending results. */
  readonly capsuleCount?: number;
  readonly capsuleFailed?: number;
  /**
   * Hint only (§6 invariant 10): this item may replace `replacementCandidateFor`. It is context for the model
   * and the person — status does not change until an explicit {@link supersede} call.
   */
  readonly replacementCandidateFor?: string;
  /** The first item resubmitted after Esc carries the interrupted-on-purpose line. */
  readonly afterInterrupt?: boolean;
  readonly interruptReason?: NextTuiQueueInterruptReason;
}

/** Snapshot identity for result carry: a coalesced row may gain more completions before commit. */
export type NextTuiPassiveResultSnapshot = NextTuiQueueItem & { readonly capsuleIds?: readonly string[] };

export type NextTuiQueueOp = 'deliver' | 'cancel' | 'supersede';

/** §6 invariant 2 (opencode LifecycleConflict): an op on an item that is no longer `queued` changes nothing. */
export class NextTuiQueueConflictError extends Error {
  readonly code = 'queue-lifecycle-conflict';
  constructor(
    readonly itemId: string,
    readonly op: NextTuiQueueOp,
    readonly status: NextTuiQueueItemStatus | 'unknown',
  ) {
    super(`queue item ${itemId} is ${status}; ${op} needs a queued item`);
    this.name = 'NextTuiQueueConflictError';
  }
}

/** Observation sink — category `queue` so `eln logs --category queue` shows the lifecycle. */
export type NextTuiQueueLog = (event: string, data: Record<string, unknown>) => void;

/** SEAT-INBOX B1-C: told after an item leaves `queued` (delivered · cancelled · superseded). */
export type NextTuiQueueTransitionListener = (item: NextTuiQueueItem) => void;

export interface NextTuiQueueBatchItem {
  readonly id: string;
  readonly kind: NextTuiQueueItemKind;
  readonly text: string;
  readonly afterInterrupt: boolean;
  readonly interruptReason?: NextTuiQueueInterruptReason;
}

/**
 * Several items taken at one idle boundary. Each entry is its own message — texts are never joined.
 * All entries share one kind and one mode; a command or shell line always travels alone.
 */
export type NextTuiQueueDrain =
  | { kind: 'none' }
  | { kind: 'batch'; mode: NextTuiQueueMode; itemKind: NextTuiQueueItemKind; items: readonly NextTuiQueueBatchItem[]; remaining: number };

/**
 * SEAT-NOTICE-BUNDLE-DRAIN (OP #128938) — the WHOLE waiting notice run taken at one idle boundary
 * as ONE bundle: every notice keeps its own id/source/msgId chain (#38804), order preserved.
 */
export type NextTuiQueueNoticeDrain =
  | { kind: 'none' }
  | { kind: 'notices'; notices: readonly NextTuiQueueNoticeEntry[]; remaining: number };

/** One bundled notice as it leaves the queue — the msgId chain survives (#38804). */
export interface NextTuiQueueNoticeEntry {
  readonly id: string;
  readonly text: string;
  readonly source?: NextTuiQueueNoticeSource;
  readonly occurredAt?: number;
  readonly msgId?: number;
  readonly passive?: boolean;
  readonly digest?: string;
  readonly mailClass?: 'P0' | 'P1' | 'P2';
  /** CLAUDE-OP-PROXY-LANE — 0 = crown / a person · 1 = the CEO's proxy · absent = the rest (order inside the notices). */
  readonly mailRank?: 0 | 1;
  readonly mailIntent?: string;
  readonly mailKind?: string;
  readonly replyTo?: number;
  readonly triage?: NextTuiQueueTriageMeta;
  /** BULK-TRIAGE — on the overflow guide: the structured fields of each mail folded past the cap. */
  readonly foldedMail?: readonly NextTuiQueueFoldedMail[];
}

/** BULK-TRIAGE — one mail folded into the overflow guide past the notice cap (kept for the triage card). */
export interface NextTuiQueueFoldedMail {
  readonly msgId?: number;
  readonly replyTo?: number;
  readonly triage?: NextTuiQueueTriageMeta;
}

/** BULK-TRIAGE — the ledger fields one seat mail brings to the triage card (body clipped to 300 chars). */
export interface NextTuiQueueTriageMeta {
  readonly from: string;
  readonly to?: string;
  readonly kind?: string;
  readonly intent?: string;
  readonly crownDirective?: string;
  readonly originKind?: string;
  readonly deadline?: string;
  readonly priority?: number;
  readonly body: string;
}

/** NOTICE-FOLD-1LINE — a seat mail's sender and body offsets (set by the producer that built the text; never parsed). */
export interface NextTuiQueueMailSpan {
  readonly sender: string;
  readonly bodyAt: number;
  readonly bodyLength: number;
  readonly digestBodyAt: number;
}
