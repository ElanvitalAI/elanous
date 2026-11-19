import { debug } from '../../debug/log.js';
import { TURN_EVENT_SOURCES } from '../../turn-capsule/contract.js';
import { emitTurnLife } from '../../debug/turn-life.js';
import { detectReplacementCandidate, type ReplacementCandidate, type ReplacementDetection } from '../../chat/queue-supersede.js';
import { pushNowToolDecision } from './tool-interrupt-class.js';

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
 * 대표 addendum C: a queue item is either something the person typed (`user`) or a completion notice
 * (`notice`: sidetab result · harness child finished · seat mail arrived). Producers of notices are
 * ELN-CHILD-NOTICE-INTO-QUEUE; this file only owns their place in the order.
 */
export type NextTuiQueueItemKind = 'user' | 'notice';
export type NextTuiQueueNoticeSource = 'sidetab' | 'harness-child' | 'seat-mail' | 'graph-node' | 'event-watch' | 'capsule-done';
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
  readonly urgent?: boolean;
  /**
   * When a notice existed, if the producer knows. Absent means unknown.
   * The zero-miss receipt must not treat unknown as a zero wait.
   */
  readonly occurredAt?: number;
  /**
   * Hint only (§6 invariant 10): this item may replace `replacementCandidateFor`. It is context for the model
   * and the person — status does not change until an explicit {@link supersede} call.
   */
  readonly replacementCandidateFor?: string;
  /** The first item resubmitted after Esc carries the interrupted-on-purpose line. */
  readonly afterInterrupt?: boolean;
  readonly interruptReason?: NextTuiQueueInterruptReason;
}

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

const defaultQueueLog: NextTuiQueueLog = (event, data) => debug.log('queue', event, data);

interface MutableItem {
  id: string;
  seq: number;
  enqueuedAt: number;
  kind: NextTuiQueueItemKind;
  mode: NextTuiQueueMode;
  delivery: NextTuiQueueDelivery;
  status: NextTuiQueueItemStatus;
  text: string;
  steerId?: string;
  supersededBy?: string;
  source?: NextTuiQueueNoticeSource;
  msgId?: number;
  urgent?: boolean;
  occurredAt?: number;
  replacementCandidateFor?: string;
  afterInterrupt?: boolean;
  interruptReason?: NextTuiQueueInterruptReason;
}

/** SEAT-INBOX B1-C: told after an item leaves `queued` (delivered · cancelled · superseded). */
export type NextTuiQueueTransitionListener = (item: NextTuiQueueItem) => void;

function snapshot(item: MutableItem): NextTuiQueueItem {
  return { ...item };
}

/**
 * Consumption order at one boundary:
 *   1. kind — every `user` item before any `notice` (대표 addendum C);
 *   2. inside one kind — `steer` before `queue` (§6 invariant 1);
 *   3. inside one kind and delivery — ascending seq.
 */
function deliveryOrder(a: MutableItem, b: MutableItem): number {
  if (a.kind !== b.kind) return a.kind === 'user' ? -1 : 1;
  if (a.kind === 'notice' && a.urgent !== b.urgent) {
    const rank = (item: MutableItem) => TURN_EVENT_SOURCES.indexOf(item.urgent ? 'urgent-mail' : 'mail');
    return rank(a) - rank(b);
  }
  if (a.delivery !== b.delivery) return a.delivery === 'steer' ? -1 : 1;
  return a.seq - b.seq;
}

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

/** Owns submissions made while a Next TUI turn is running. The input layer owns key interpretation. */
export function createNextTuiQueue(options: { log?: NextTuiQueueLog; turnLifeLog?: (event: string, data: Record<string, unknown>) => void } = {}) {
  const log = options.log ?? defaultQueueLog;
  // OBSERVE-TURN-EVENT-LIFECYCLE — 주입 없이도 기본 경로(debug) 로 방출된다(fail-open).
  const turnLifeLog = options.turnLifeLog ?? emitTurnLife;
  /** Every item ever enqueued, by id — terminal items stay so a late op is a conflict, not a silent no-op. */
  const byId = new Map<string, MutableItem>();
  let lastSeq = 0;
  let interrupted = false;
  let interruptReason: NextTuiQueueInterruptReason = 'interrupt';
  let resumeReason: NextTuiQueueInterruptReason | undefined;
  /** ELN-QUEUE-SUPERSEDE: detected «대체 후보» by the new item's id (targets · correction word for the lines). */
  const candidates = new Map<string, ReplacementCandidate>();

  /** Waiting items in seq order (display / recall order); render reads `count` every frame, so it is kept, not scanned. */
  let waiting: MutableItem[] = [];
  const transitionListeners = new Set<NextTuiQueueTransitionListener>();
  /** #38510 r1 MF2: observers of the queued-count rising (the idle watchdog starts its clock at the real transition). */
  const enqueueListeners = new Set<() => void>();
  /** A listener never breaks the queue — it runs after the state change and its throw is logged, not raised. */
  const notifyTransition = (item: MutableItem): void => {
    for (const listener of transitionListeners) {
      try { listener(snapshot(item)); } catch (error) {
        log('transition-listener-error', { id: item.id, status: item.status, error: error instanceof Error ? error.message : String(error) });
      }
    }
  };
  const queued = (): MutableItem[] => waiting;
  const ordered = (): MutableItem[] => [...waiting].sort(deliveryOrder);
  const leave = (item: MutableItem): void => { waiting = waiting.filter((other) => other !== item); if (waiting.length === 0) resumeReason = undefined; };

  /**
   * §6 invariant 7: accepting an item never stops current execution — this only appends.
   * §6 invariant 10: accepting an item never revises other items — no cancel, no supersede here.
   */
  const accept = (fields: Omit<MutableItem, 'id' | 'seq' | 'status' | 'enqueuedAt'>): NextTuiQueueItem => {
    const seq = ++lastSeq;
    const item: MutableItem = { id: `q${seq}`, seq, enqueuedAt: Date.now(), status: 'queued', ...fields };
    byId.set(item.id, item);
    waiting = [...waiting, item];
    // OBSERVE-TURN-EVENT-LIFECYCLE — accepted(=queued). busy 는 큐가 모른다(entry 의 몫) → 생략.
    try { turnLifeLog('turn-life:event-queued', { itemId: item.id, eventId: item.msgId ?? item.id, kind: item.kind, source: item.source ?? null, delivery: item.delivery, queuedCount: waiting.length }); } catch { /* observability is fail-open */ }
    log('enqueued', {
      id: item.id, seq, kind: item.kind, mode: item.mode, delivery: item.delivery, length: item.text.length,
      ...(item.source === undefined ? {} : { source: item.source }),
      ...(item.msgId === undefined ? {} : { msgId: item.msgId }),
    });
    for (const listener of enqueueListeners) {
      try { listener(); } catch (error) { log('enqueue-listener-failed', { id: item.id, error: error instanceof Error ? error.message : String(error) }); }
    }
    return snapshot(item);
  };

  const requireQueued = (id: string, op: NextTuiQueueOp): MutableItem => {
    const item = byId.get(id);
    if (item === undefined || item.status !== 'queued') {
      const status = item?.status ?? 'unknown';
      log('conflict', { id, op, status });
      throw new NextTuiQueueConflictError(id, op, status);
    }
    return item;
  };

  const deliver = (item: MutableItem, boundary: NextTuiQueueBoundary): void => {
    if (boundary === 'idle' && resumeReason !== undefined) {
      item.afterInterrupt = true;
      if (resumeReason !== 'interrupt') item.interruptReason = resumeReason;
      resumeReason = undefined;
    }
    item.status = 'delivered';
    leave(item);
    try { turnLifeLog('turn-life:event-dequeued', { itemId: item.id, eventId: item.msgId ?? item.id, source: item.source ?? null, boundary, waitMs: Math.max(0, Date.now() - item.enqueuedAt) }); } catch { /* observability is fail-open */ }
    log('delivered', { id: item.id, seq: item.seq, delivery: item.delivery, boundary });
    notifyTransition(item);
  };

  const cancel = (item: MutableItem, reason: string): void => {
    item.status = 'cancelled';
    leave(item);
    log('cancelled', { id: item.id, seq: item.seq, delivery: item.delivery, reason });
    notifyTransition(item);
  };

  const recordCandidate = (item: MutableItem, candidateFor: string, detail: Record<string, unknown> = {}): void => {
    item.replacementCandidateFor = candidateFor;
    log('replacement-candidate', { id: item.id, seq: item.seq, candidateFor, ...detail });
  };

  /**
   * ELN-QUEUE-SUPERSEDE (§6 invariant 5, lowered by 대표): a new user item naming the same target as exactly one
   * waiting user item, with a correction word, is recorded as a replacement candidate — a hint, nothing else.
   * No status changes here (invariants 7·10); `delivered`/`cancelled`/`superseded` items are never candidates.
   */
  const noteDetectedCandidate = (item: MutableItem): void => {
    const detection = detectReplacementCandidate(item, queued());
    if (detection.kind !== 'candidate') return;
    candidates.set(item.id, detection);
    recordCandidate(item, detection.candidateFor, { targets: detection.targets, correctionWord: detection.correctionWord });
  };

  return {
    get count(): number { return queued().length; },
    get pendingTexts(): readonly string[] { return queued().map((item) => item.text); },
    /** Waiting items in seq order — the read model for per-item controls (ITEM-CONTROLS). */
    get items(): readonly NextTuiQueueItem[] { return queued().map(snapshot); },
    /** Queued items the running turn may still take at its next tool-result boundary. */
    get steerCount(): number { return queued().filter((item) => item.steerId !== undefined).length; },
    get steerIds(): readonly string[] { return queued().flatMap((item) => (item.steerId === undefined ? [] : [item.steerId])); },
    get interrupted(): boolean { return interrupted; },
    /** Any item this queue has seen, terminal ones included. */
    get(id: string): NextTuiQueueItem | undefined {
      const item = byId.get(id);
      return item === undefined ? undefined : snapshot(item);
    },
    /** A user utterance. A steer handle means the running turn was offered the text (`steer`); otherwise `queue`. */
    enqueue(text: string, steerId?: string): NextTuiQueueItem {
      const accepted = accept({
        kind: 'user',
        mode: nextTuiQueueMode(text),
        delivery: steerId === undefined ? 'queue' : 'steer',
        text,
        ...(steerId === undefined ? {} : { steerId }),
      });
      const item = byId.get(accepted.id)!;
      noteDetectedCandidate(item);
      return snapshot(item);
    },
    /**
     * What {@link enqueue} would detect for `text` right now, without enqueueing — the steer path needs the
     * model-context line before the item exists (the steer is sent first, then enqueued with its handle).
     */
    previewReplacementCandidate(text: string): ReplacementDetection {
      return detectReplacementCandidate({ id: `q${lastSeq + 1}`, kind: 'user', status: 'queued', text }, queued());
    },
    /** The detected candidate an item carries (targets · correction word), if enqueue found one. */
    replacementCandidate(id: string): ReplacementCandidate | undefined {
      return candidates.get(id);
    },
    /**
     * A completion notice. It always waits behind user utterances and never steers the running turn:
     * seat mail that lands during a turn stays `queue` until the idle door opens the next turn.
     */
    enqueueNotice(text: string, source: NextTuiQueueNoticeSource, meta: { msgId?: number; occurredAt?: number; urgent?: boolean } = {}): NextTuiQueueItem {
      return accept({
        kind: 'notice',
        mode: 'chat',
        delivery: 'queue',
        text,
        source,
        ...(meta.msgId === undefined ? {} : { msgId: meta.msgId }),
        ...(meta.urgent ? { urgent: true } : {}),
        ...(meta.occurredAt === undefined ? {} : { occurredAt: meta.occurredAt }),
      });
    },
    /** #38510 r1 MF2: observe an item entering the queue (after it is stored). Returns the unsubscribe. */
    onEnqueued(listener: () => void): () => void {
      enqueueListeners.add(listener);
      return () => { enqueueListeners.delete(listener); };
    },
    /** SEAT-INBOX B1-C: observe items leaving `queued` (the receipt «seen» source). Returns the unsubscribe. */
    onTransition(listener: NextTuiQueueTransitionListener): () => void {
      transitionListeners.add(listener);
      return () => { transitionListeners.delete(listener); };
    },
    /**
     * The child drained these steers into a model request (tool-result boundary) — they must not leave again
     * as a turn. A steer that is no longer queued (recalled, cancelled, already delivered) is logged as a conflict
     * and skipped: this runs inside an IPC callback, so it reports instead of throwing.
     */
    markSteered(steerIds: readonly string[]): number {
      const wanted = new Set(steerIds);
      let applied = 0;
      for (const item of byId.values()) {
        if (item.steerId === undefined || !wanted.has(item.steerId)) continue;
        if (item.status !== 'queued') {
          log('conflict', { id: item.id, op: 'deliver', status: item.status, steerId: item.steerId });
          continue;
        }
        deliver(item, 'tool-result');
        applied += 1;
      }
      return applied;
    },
    /**
     * ELN-QUEUE-ITEM-CONTROLS: move a waiting item between `steer` (offered to the running turn — the caller
     * already sent it and passes the child handle) and `queue` (the caller already retracted the old handle).
     * Commands and shell lines always wait for idle. Throws {@link NextTuiQueueConflictError} unless queued.
     */
    changeDelivery(id: string, to: NextTuiQueueDelivery, steerId?: string): NextTuiQueueItem {
      const item = requireQueued(id, 'deliver');
      if (to === 'steer' && (steerId === undefined || item.mode !== 'chat')) {
        log('conflict', { id, op: 'deliver', status: item.status, to, reason: steerId === undefined ? 'no-steer-handle' : 'not-steerable' });
        throw new NextTuiQueueConflictError(id, 'deliver', item.status);
      }
      const from = item.delivery;
      item.delivery = to;
      if (to === 'steer') item.steerId = steerId; else delete item.steerId;
      log('delivery-changed', { id: item.id, seq: item.seq, from, to });
      return snapshot(item);
    },
    /** `queued → cancelled`. Throws {@link NextTuiQueueConflictError} for any other status. */
    cancel(id: string, reason = 'user'): NextTuiQueueItem {
      const item = requireQueued(id, 'cancel');
      cancel(item, reason);
      return snapshot(item);
    },
    /**
     * Record that `id` may replace `candidateFor` — an annotation only (§6 invariant 10). Neither item changes
     * status; ELN-QUEUE-SUPERSEDE shows it as a candidate line and context for the model.
     */
    noteReplacementCandidate(id: string, candidateFor: string): NextTuiQueueItem | undefined {
      const item = byId.get(id);
      if (item === undefined || id === candidateFor || !byId.has(candidateFor)) return undefined;
      recordCandidate(item, candidateFor);
      return snapshot(item);
    },
    /**
     * `queued → superseded` with `supersededBy`. The text is kept. This explicit call is the ONLY way into
     * `superseded` (§6 invariant 10): callers are the model's plan tool and the person's queue controls
     * (ITEM-CONTROLS) — never enqueue, never automatic detection.
     */
    supersede(id: string, by: string): NextTuiQueueItem {
      const item = requireQueued(id, 'supersede');
      if (by === id || !byId.has(by)) {
        log('conflict', { id, op: 'supersede', status: item.status, by, reason: 'unknown-successor' });
        throw new NextTuiQueueConflictError(by, 'supersede', 'unknown');
      }
      item.status = 'superseded';
      item.supersededBy = by;
      leave(item);
      log('superseded', { id: item.id, seq: item.seq, by });
      notifyTransition(item);
      return snapshot(item);
    },
    /**
     * Ctrl+Up: every waiting user utterance leaves the queue into the draft — recorded as `cancelled`
     * (reason `recalled`). Notices are not the person's words and stay queued.
     */
    recall(draft: string): { text: string; count: number; steerIds: string[] } | null {
      const recalled = queued().filter((item) => item.kind === 'user');
      if (recalled.length === 0) return null;
      const text = [...recalled.map((item) => item.text), ...(draft ? [draft] : [])].join('\n');
      const steerIds = recalled.flatMap((item) => (item.steerId === undefined ? [] : [item.steerId]));
      for (const item of recalled) cancel(item, 'recalled');
      return { text, count: recalled.length, steerIds };
    },
    markInterrupted(reason: NextTuiQueueInterruptReason = 'interrupt'): void {
      if (!interrupted) interruptReason = reason;
      interrupted = true;
    },
    settle(_draft: string, turn?: NextTuiSettledTurn): NextTuiQueueSettle {
      const pending = queued();
      if (interrupted) {
        interrupted = false;
        if (pending.length === 0) {
          // Esc table: queued input → next turn by itself (below) · queue empty ∧ no response → original text
          // back in the prompt · queue empty ∧ something answered → nothing to give back. Plans are never rolled back.
          return turn && !turn.responded && turn.text.trim() ? { kind: 'restore-original', text: turn.text } : { kind: 'none' };
        }
        // Undelivered steers died with the cancelled turn's child; they leave again as plain input, in seq order.
        for (const item of pending) {
          if (item.delivery === 'steer') {
            log('delivery-changed', { id: item.id, seq: item.seq, from: 'steer', to: 'queue', reason: 'interrupt' });
          }
          item.delivery = 'queue';
          delete item.steerId;
        }
        // The first actual idle delivery carries the interruption metadata (§6 invariant 4).
        resumeReason ??= interruptReason;
        return { kind: 'resubmit', count: pending.length };
      }
      return pending.length > 0 ? { kind: 'wake' } : { kind: 'none' };
    },
    /** CAPSULE-C2-FU: the kind {@link dequeue} would hand out next — read only, nothing leaves. */
    peekKind(): NextTuiQueueItemKind | null { return ordered()[0]?.kind ?? null; },
    /** Idle boundary: one item leaves, in {@link deliveryOrder} (user > notice · steer > queue · seq). */
    dequeue(): NextTuiQueueDequeue {
      const next = ordered()[0];
      if (next === undefined) return { kind: 'none' };
      deliver(next, 'idle');
      return {
        kind: 'submit',
        itemKind: next.kind,
        ...(next.source === undefined ? {} : { source: next.source }),
        id: next.id,
        text: next.text,
        remaining: queued().length,
        afterInterrupt: next.afterInterrupt === true,
        ...(next.interruptReason === undefined ? {} : { interruptReason: next.interruptReason }),
        ...(next.occurredAt === undefined ? {} : { occurredAt: next.occurredAt }),
        ...(next.msgId === undefined ? {} : { msgId: next.msgId }), // 출처: #38804 — dequeue 후에도 eventId 사슬(msgId ?? id)이 유지된다
      };
    },
    /**
     * Idle boundary, several at once: the head in {@link deliveryOrder} plus the following items of the same
     * kind while they stay in `chat` mode. A `command`/`shell` item, or a change of kind, ends the batch.
     * Every item is returned as its own message — the caller sends them as separate user messages.
     */
    drain(): NextTuiQueueDrain {
      const order = ordered();
      const head = order[0];
      if (head === undefined) return { kind: 'none' };
      const batch: MutableItem[] = [head];
      if (head.mode === 'chat') {
        for (const next of order.slice(1)) {
          if (next.kind !== head.kind || next.mode !== 'chat' || !!next.urgent !== !!head.urgent) break;
          batch.push(next);
        }
      }
      for (const item of batch) deliver(item, 'idle');
      return {
        kind: 'batch',
        mode: head.mode,
        itemKind: head.kind,
        items: batch.map((item) => ({ id: item.id, kind: item.kind, text: item.text, afterInterrupt: item.afterInterrupt === true, ...(item.interruptReason === undefined ? {} : { interruptReason: item.interruptReason }) })),
        remaining: queued().length,
      };
    },
  };
}

/** Status-line count of what waits for the running turn — empty when nothing waits. */
export function nextTuiQueueSuffix(count: number): string {
  return count > 0 ? ` · 대기 ${count}` : '';
}

/** A push-now may cut the turn only after a fresh execution-side snapshot shows no active tool, or only
 *  interruptible (read/search) tools — writes, shell, push and unknown tools finish first (ELN-INTERRUPT-CONDITIONAL). */
export function nextTuiPushNowDecision(activeToolNames: readonly string[]): 'interrupt' | 'deferred' {
  return pushNowToolDecision(activeToolNames);
}
