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
export type NextTuiQueueNoticeSource = 'sidetab' | 'harness-child' | 'seat-mail' | 'seat-mail-guide' | 'graph-node' | 'event-watch' | 'capsule-done' | 'ceo-ingress';

const passiveResultSource = (source?: NextTuiQueueNoticeSource): boolean =>
  source === 'capsule-done' || source === 'sidetab' || source === 'harness-child';
/**
 * CAPSULE-DONE-KNOCK-PTY-E2E-FU (OP 11-22) — passive results stay quiet so they cost no turn of their own, but a seat
 * with no person must not hold them forever: once the oldest has waited this long they become actionable together,
 * and the idle door drains them all as one notice bundle (one turn). While a turn runs the idle door stays shut.
 */
export const PASSIVE_RESULT_IDLE_WAKE_MS = 120_000;/** Input mode decides batching: a slash command or `!` shell line never travels with ordinary chat. */
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
  cancelReason?: string;
  urgent?: boolean;
  occurredAt?: number;
  capsuleCount?: number;
  capsuleFailed?: number;
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
}

/** Owns submissions made while a Next TUI turn is running. The input layer owns key interpretation. */
export function createNextTuiQueue(options: { log?: NextTuiQueueLog; turnLifeLog?: (event: string, data: Record<string, unknown>) => void } = {}) {
  const log = options.log ?? defaultQueueLog;
  // OBSERVE-TURN-EVENT-LIFECYCLE — 주입 없이도 기본 경로(debug) 로 방출된다(fail-open).
  const turnLifeLog = options.turnLifeLog ?? emitTurnLife;
  /** Every item ever enqueued, by id — terminal items stay so a late op is a conflict, not a silent no-op. */
  const byId = new Map<string, MutableItem>();
  let lastSeq = 0;
  /** SEAT-NOTICE-BUNDLE-DRAIN — the ONE guide item for cap-dropped notices, and how many were dropped since it (re)appeared. */
  let overflowNoticeId: string | null = null;
  let droppedNotices = 0;
  let interrupted = false;
  let interruptReason: NextTuiQueueInterruptReason = 'interrupt';
  let resumeReason: NextTuiQueueInterruptReason | undefined;
  /** ELN-QUEUE-SUPERSEDE: detected «대체 후보» by the new item's id (targets · correction word for the lines). */
  const candidates = new Map<string, ReplacementCandidate>();

  /** Waiting items in seq order (display / recall order); render reads `count` every frame, so it is kept, not scanned. */
  let waiting: MutableItem[] = [];
  let capsulePending: { item: MutableItem; completions: Map<string, { text: string; failed: boolean }> } | null = null;
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
  /** Passive rows join the automatic door once the oldest one has waited {@link PASSIVE_RESULT_IDLE_WAKE_MS}. */
  const passiveRipe = (): boolean => waiting.some((item) => passiveResultSource(item.source) && Date.now() - item.enqueuedAt >= PASSIVE_RESULT_IDLE_WAKE_MS);
  const actionable = (): MutableItem[] => (passiveRipe() ? ordered() : ordered().filter((item) => !passiveResultSource(item.source)));
  const leave = (item: MutableItem): void => {
    waiting = waiting.filter((other) => other !== item);
    if (capsulePending?.item === item) capsulePending = null;
    if (waiting.length === 0) resumeReason = undefined;
  };

  const refreshCapsuleSummary = (pending: NonNullable<typeof capsulePending>): void => {
    const values = [...pending.completions.values()];
    const count = values.length;
    const failed = values.filter((value) => value.failed).length;
    pending.item.capsuleCount = count;
    pending.item.capsuleFailed = failed;
    pending.item.text = count === 1 ? values[0]!.text
      : `캡슐 완료 ${count}건 · 실패 ${failed}건 · 결과는 이 턴의 작업 알림에서 확인`;
  };
  const handoff = (next: MutableItem): NextTuiQueueDequeue => ({
    kind: 'submit', itemKind: next.kind,
    ...(next.source === undefined ? {} : { source: next.source }),
    id: next.id, text: next.text, remaining: queued().length,
    afterInterrupt: next.afterInterrupt === true,
    ...(next.interruptReason === undefined ? {} : { interruptReason: next.interruptReason }),
    ...(next.occurredAt === undefined ? {} : { occurredAt: next.occurredAt }),
    ...(next.msgId === undefined ? {} : { msgId: next.msgId }),
  });

  /**
   * §6 invariant 7: accepting an item never stops current execution — this only appends.
   * §6 invariant 10: accepting an item never revises other items — no cancel, no supersede here.
   */
  const accept = (fields: Omit<MutableItem, 'id' | 'seq' | 'status' | 'enqueuedAt'>): NextTuiQueueItem => {
    // SEAT-NOTICE-BUNDLE-DRAIN (OP #128938, DIAG §107 «대기 88») — 대기 알림 상한 20.
    // JUD-B #39592 producer probe — 상한·가이드는 자리 우편(seat-mail · seat-mail-guide) 전용이다. sidetab·capsule-done·wake 등 다른
    // 생산자는 PR 전 동작 그대로(상한 접힘 없음): 접으면 가이드(비수동 종류)가 수동 결과를 대신해 자동 발사를
    // 만들고, capsule-done 의 capsulePending 이 가이드 항목을 물어 캡슐 제거가 가이드를 취소한다.
    if (fields.kind === 'notice' && (fields.source === 'seat-mail' || fields.source === 'seat-mail-guide')) {
      const waitingNotices = waiting.filter((item) => item.status === 'queued' && item.kind === 'notice' && item.id !== overflowNoticeId);
      if (waitingNotices.length >= NEXT_TUI_NOTICE_CAP) {
        droppedNotices += 1;
        const overflow = overflowNoticeId === null ? undefined : byId.get(overflowNoticeId);
        if (overflow && overflow.status === 'queued') {
          overflow.text = noticeOverflowGuideLine(droppedNotices);
          log('notice-cap-overflow', { dropped: droppedNotices, kept: waitingNotices.length });
          return snapshot(overflow);
        }
        const seq = ++lastSeq;
        // OP #129667 ①(JUD-B #129661 원장 probe) — 가이드는 접힌 알림을 대표하는 한 줄일 뿐이다:
        // 우편의 msgId(원장 영수 키 · #38804 eventId 사슬)를 물려받지 않는다. 하이재크되면
        // 묶음 settle 이 본문 미전달 우편까지 false seen 처리한다.
        const item: MutableItem = {
          kind: fields.kind,
          mode: fields.mode,
          delivery: fields.delivery,
          text: noticeOverflowGuideLine(droppedNotices),
          // OP #130302/#130531 합의 — 안내는 «seat-mail-guide» 별도 종류(msgId 없음 · poll당 1줄):
          // seat-mail 건수 셈에서 빺 — r1/r2 시험의 «안내=seat-mail» 단언은 이 종류 기준으로 갱신되었다(r4).
          source: 'seat-mail-guide',
          ...(fields.urgent ? { urgent: true } : {}),
          ...(fields.occurredAt === undefined ? {} : { occurredAt: fields.occurredAt }),
          id: `q${seq}`,
          seq,
          enqueuedAt: Date.now(),
          status: 'queued',
        };
        overflowNoticeId = item.id;
        byId.set(item.id, item);
        waiting = [...waiting, item];
        log('notice-cap-overflow', { dropped: droppedNotices, kept: waitingNotices.length, guide: item.id });
        return snapshot(item);
      }
    }
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
    item.cancelReason = reason;
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
    /** Result-only notices are visible and open an automatic turn only after {@link PASSIVE_RESULT_IDLE_WAKE_MS}. */
    get autoDispatchCount(): number { return actionable().length; },
    get pendingTexts(): readonly string[] { return queued().map((item) => item.text); },
    /** Waiting items in seq order — the read model for per-item controls (ITEM-CONTROLS). */
    get items(): readonly NextTuiQueueItem[] { return queued().map(snapshot); },
    /** Queued items the running turn may still take at its next tool-result boundary. */
    get steerCount(): number { return queued().filter((item) => item.steerId !== undefined).length; },
    get steerIds(): readonly string[] { return queued().flatMap((item) => (item.steerId === undefined ? [] : [item.steerId])); },
    get interrupted(): boolean { return interrupted; },
    /** Move the pending interruption to the entry turn, including off-queue held notices. */
    takeResumeReason(): NextTuiQueueInterruptReason | undefined {
      const reason = resumeReason;
      resumeReason = undefined;
      return reason;
    },
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
    /** Keep at most one queued capsule notice; the child notification drain owns the individual result bodies. */
    enqueueCapsuleDoneNotice(text: string, capsuleId: string, status: string, occurredAt?: number): NextTuiQueueItem | null {
      if (capsulePending?.completions.has(capsuleId)) return null;
      if (!capsulePending) {
        const accepted = this.enqueueNotice(text, 'capsule-done', occurredAt === undefined ? {} : { occurredAt });
        const item = byId.get(accepted.id)!;
        capsulePending = { item, completions: new Map() };
      }
      capsulePending.completions.set(capsuleId, { text, failed: status !== 'ok' });
      refreshCapsuleSummary(capsulePending);
      // Only the first completion needs a wake. Later arrivals update the same pending row.
      return capsulePending.completions.size === 1 ? snapshot(capsulePending.item) : null;
    },
    /** Mid-turn result delivery removes only that capsule from its pending summary. */
    removeCapsuleDoneNotice(capsuleId: string): boolean {
      const pending = capsulePending;
      if (!pending?.completions.delete(capsuleId)) return false;
      if (pending.completions.size === 0) cancel(pending.item, 'mid-turn-carried');
      else refreshCapsuleSummary(pending);
      return true;
    },
    /** The next real turn drains task results; retire its summary without creating a result-only turn. */
    consumeCapsuleDoneSummary(): boolean {
      if (!capsulePending) return false;
      cancel(capsulePending.item, 'carried-with-turn');
      return true;
    },
    /** A bounded read for the next actual turn; no item leaves until the child accepts that turn. */
    passiveResultNotices(max: number): readonly NextTuiPassiveResultSnapshot[] {
      return queued().filter((item) => passiveResultSource(item.source)).slice(0, max).map((item) => ({
        ...snapshot(item),
        ...(capsulePending?.item === item ? { capsuleIds: [...capsulePending.completions.keys()] } : {}),
      }));
    },
    /** Consume only results that were actually attached to the accepted turn. */
    consumePassiveResultNotices(rows: readonly NextTuiPassiveResultSnapshot[]): number {
      let consumed = 0;
      for (const row of rows) {
        const item = byId.get(row.id);
        if (item?.status !== 'queued' || !passiveResultSource(item.source)) continue;
        if (item.source === 'capsule-done') {
          if (capsulePending?.item !== item || !row.capsuleIds?.length) continue;
          let removed = false;
          for (const capsuleId of row.capsuleIds) removed = this.removeCapsuleDoneNotice(capsuleId) || removed;
          if (removed) consumed++;
        } else { cancel(item, 'carried-with-turn'); consumed++; }
      }
      return consumed;
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
    settle(_draft: string, turn?: NextTuiSettledTurn, hasHeldNotice = false): NextTuiQueueSettle {
      const pending = queued();
      if (interrupted) {
        interrupted = false;
        if (hasHeldNotice) resumeReason ??= interruptReason;
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
    /** The automatic door skips passive results while preserving dequeue()'s public FIFO contract. */
    peekActionableKind(): NextTuiQueueItemKind | null { return actionable()[0]?.kind ?? null; },
    dequeueActionable(): NextTuiQueueDequeue {
      const next = actionable()[0];
      if (next === undefined) return { kind: 'none' };
      deliver(next, 'idle');
      return handoff(next);
    },
    /** Idle boundary: one item leaves, in {@link deliveryOrder} (user > notice · steer > queue · seq). */
    dequeue(): NextTuiQueueDequeue {
      const next = ordered()[0];
      if (next === undefined) return { kind: 'none' };
      deliver(next, 'idle');
      return handoff(next); // 출처: #38804 — dequeue 후에도 eventId 사슬(msgId ?? id)이 유지된다
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
    /**
     * SEAT-NOTICE-BUNDLE-DRAIN — idle boundary, the WHOLE waiting notice run as ONE bundle
     * (deliveryOrder head run; a person's line ahead of the run leaves earlier and is never bundled).
     * Order is preserved; every notice keeps its own id/source/msgId chain (#38804).
     */
    drainNotices(): NextTuiQueueNoticeDrain {
      const order = ordered();
      const batch: MutableItem[] = [];
      for (const item of order) {
        // SEAT-NOTICE-BUNDLE-DRAIN — 사람 줄은 이 묶음에 끼지 않고 자기 턴으로 남는다
        // (deliveryOrder가 사람 줄을 모든 알림 앞에 두므로, 비-notice 항목은 skip).
        if (item.kind !== 'notice' || item.mode !== 'chat') continue;
        batch.push(item);
      }
      if (batch.length === 0) return { kind: 'none' };
      for (const item of batch) deliver(item, 'idle');
      return {
        kind: 'notices',
        notices: batch.map((item) => ({
          id: item.id, text: item.text,
          ...(item.source === undefined ? {} : { source: item.source }),
          ...(item.occurredAt === undefined ? {} : { occurredAt: item.occurredAt }),
          ...(item.msgId === undefined ? {} : { msgId: item.msgId }),
        })),
        remaining: queued().length,
      };
    },
  };
}

/** SEAT-NOTICE-BUNDLE-DRAIN — the ONE guide line for notices dropped at the cap (원장 안내 한 줄). */
export const NEXT_TUI_NOTICE_CAP = 20;
export function noticeOverflowGuideLine(dropped: number): string {
  return `[notice-overflow] 알림 상한 ${NEXT_TUI_NOTICE_CAP}을 넘어 ${dropped}건이 접혔습니다 — 원장에서 확인: eln msg list`;
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
