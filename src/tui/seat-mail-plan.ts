// ELN-PLAN-WIRE-SEAT — split out of seat-mail-boot.ts (size-contract: next TUI modules stay within 600 lines).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';
import {
  MAX_ACTIVE_PLAN_ITEMS,
  decomposeRequests,
  markTaskDone,
  orderPlanTasks,
  reconcilePlan,
  selectNextActive,
  type DecomposedTask,
  type SeatTaskQueuePort,
  type TaskRequest,
} from '../seat/seat-task-decompose.js';
import type { Message, MsgStore } from '../msg/msg-store.js';
import { outcomeOfPlanWire, type PlanWire } from '../code-edit/plan-wire.js';
import type { ReceiptInput } from '../msg/msg-receipts.js';
import { headerFieldsOf, seatMessageContextBlock } from '../msg/msg-context-header.js';
import { createSeatMailAdapter, type SeatMailAdapter } from './turn-events/mail-adapter.js';
import type { SeatMailItem } from './seat-mail-boot.js';

/**
 * mustFix ① — 본문을 자르지 않고 전문 주입한다(200자 잘림으로 뒷부분 지시가 유실되던 결함).
 * SEAT-INBOX B1-C §5d — 메시지마다 머리 한 줄 «[from <자리> · <intent>]» 을 붙인 별도 블록(구조 칸에서만 만든다).
 */
export function formatSeatMailPrompt(seat: string, msgs: SeatMailItem[]): string {
  const blocks = msgs.map(m => seatMessageContextBlock({ id: m.id, sender: m.from, body: m.body, kind: m.kind ?? null, ...headerFieldsOf(m) }));
  return `[우편 수신] ${seat} 앞 ${msgs.length}통(턴 경계 자동 수신 · 처리 뒤 ack) — 위부터 읽고 처리하세요:\n${blocks.join('\n\n')}`;
}

// ---------------------------------------------------------------------------
// ELN-PLAN-WIRE-SEAT (#38016 · absorbed into DECISION-GATE v2): mail → decomposition → plan → next item.
// The decomposition engine (src/seat/seat-task-decompose) is pure; this file wires it:
//   mail ledger (opened per call, so mail that arrives after boot is absorbed) → decomposeRequests → reconcilePlan
//   → plan items persisted per seat (restart never re-adds the same mail) → ONE active item is queued as a seat-mail notice
//   → the turn's plan outcome (planTurnOutcome: `done`) closes the active item with evidence and promotes the next.
// ---------------------------------------------------------------------------
export type SeatPlanItem = DecomposedTask;

/** The mail ledger as far as the plan needs it (structurally a MsgStore). */
export interface SeatPlanLedger {
  list(recipient: string, after?: number, limit?: number): Message[];
  getCursor?(recipient: string): number;
  /** One message by id (WORK-QUEUE supersede rule reads the replaced message's sender · crown mark). */
  getMessage?(id: number): Message | null;
}

/**
 * ELN-SEAT-WORK-QUEUE supersede rule (OP decision on #38288 · this is its canonical text):
 * a message may replace (`supersedes`) only its own sender's earlier mail · OP and 대표 (crown) may replace anyone's ·
 * an item from a 대표 directive can be replaced only by 대표 · anything else is refused (ignored + `plan.supersede-refused`).
 */
export function supersedeAllowed(by: Pick<Message, 'from' | 'crownDirective' | 'origin'>, target: Pick<Message, 'from' | 'crownDirective' | 'origin'>): boolean {
  const byCrown = Boolean(by.crownDirective || by.origin?.delegatedByCrown);
  const targetCrown = Boolean(target.crownDirective || target.origin?.delegatedByCrown);
  if (targetCrown) return byCrown;
  return byCrown || by.from === 'OP' || by.from === target.from;
}

export type SeatPlanStatus = Readonly<{
  seat: string; active: number; open: number;
  /** ELN-SEAT-WORK-QUEUE: how long the oldest still-waiting (queued) item has waited, in ms (null = nothing waiting). */
  oldestWaitMs?: number | null;
}>;

/** Per-seat plan persistence: the plan items and how far the mail ledger has been absorbed. */
export interface SeatPlanSaved { items: SeatPlanItem[]; absorbedUpTo: number }
export interface SeatPlanStore { load(): SeatPlanSaved | null; save(state: SeatPlanSaved): void }

/** The queue port the plan writes to; `syncPlan` lets a real queue retract notices of items that closed. */
export type SeatPlanQueuePort = SeatTaskQueuePort & {
  syncPlan?(openTasks: readonly SeatPlanItem[]): void;
  /** Which plan item a queued notice stands for (so a turn can be tied back to its item). */
  taskOfNotice?(noticeItemId: string): string | undefined;
};

export type SeatMailPlanWireOptions = Readonly<{
  seat: string;
  ledger: SeatPlanLedger;
  store?: SeatPlanStore;
  /** Where to start when nothing was saved (default: the ledger's ack cursor — mail unread at boot). */
  cursor?: number;
  /** Clock for the «longest wait» observation (default Date.now). */
  now?: () => number;
  /** Plan ledger event sink (default: `eln logs` category `plan`). Tests inject it to assert `plan.revised`. */
  onPlanEvent?: (event: 'plan.revised', data: PlanRevisedEvent) => void;
  /** `plan.supersede-refused` sink (default: `eln logs` category `plan`). */
  onSupersedeRefused?: (data: { seat: string; msgId: number; from: string; target: number; targetFrom: string | null; reason: string }) => void;
  /**
   * B1-C receipts for mail the plan consumed (source `plan`): `delivered` when absorbed, `seen` when a turn of one of its items
   * ended answered. Without it the plan path left mail «unseen» forever — A217 `msg overdue` and the ACK-SLA alert fired for mail
   * the seat had actually worked (live 11-18, eln-main 9e078bba). Writes are fail-soft: a failure is a log line, never a plan change.
   */
  recordReceipts?: (inputs: readonly ReceiptInput[]) => void;
  /**
   * The seat's one mail owner (CAPSULE-C3 · always on since CAPSULE-FLAGS-REMOVE-DEFAULT R4). The TUI passes ONE
   * adapter to the plan and to the notice watcher (entry.ts); absent = a private one. absorb plans only mail granted to the plan — mail the
   * watcher already carries is not planned a second time (D9) — and an answered item settles its mail.
   */
  mailAdapter?: Pick<SeatMailAdapter, 'claim' | 'settle' | 'release'>;
}>;

/** One item as the plan ledger sees it — ids and states only, never the mail text. */
export type PlanItemSnapshot = Readonly<{ id: string; status: string }>;
export type PlanSnapshot = Readonly<{ active: number; open: number; items: readonly PlanItemSnapshot[]; /** Queue depth's oldest wait (ms) — WORK-QUEUE. */ oldestWaitMs: number | null }>;
/** Why the plan changed — a structural cause, never read from text. */
export type PlanRevisedReason = 'mail-absorbed' | 'item-done' | 'turn-done' | 'stale-on-boot';
/** ELN-PLAN-WIRE-SEAT `plan.revised` (ELN-STEER-AND-TOOL-WATCHDOG §156): emitted only when the plan actually changed. */
export type PlanRevisedEvent = Readonly<{
  seat: string;
  reason: PlanRevisedReason;
  before: PlanSnapshot;
  after: PlanSnapshot;
  /** The decomposition's «what changed» line (mail-absorbed only). */
  reportLine?: string;
  /** Mail ids absorbed (mail-absorbed) or the closed item id (item-done · turn-done). */
  msgIds?: readonly number[];
  itemId?: string;
  /** WORK-QUEUE «낡은 정기 보고 생략»: which items a newer report replaced (old → new host). */
  superseded?: ReadonlyArray<{ itemId: string; by: string }>;
}>;

export type SeatPlanRuntime = {
  /** Reads mail that arrived since the last call, revises the plan, queues the active item. The ack cursor is never moved. */
  absorb(): SeatPlanStatus;
  status(): SeatPlanStatus;
  plan(): readonly SeatPlanItem[];
  /** Close an item — evidence required (invariant 9: empty evidence throws). Closing one item is not closing the plan: the next is promoted. */
  complete(id: string, evidence: string): SeatPlanStatus;
  /**
   * A finished turn's plan outcome. `done` closes the active item (the evidence names the finished plan) and promotes the next —
   * but only for a turn that belongs to that item: `noticeItemId` is the queue notice the turn (or the turn chain it continues) started from.
   */
  noteTurnOutcome(kind: 'done' | 'continue' | 'blocked' | 'waiting', evidence: string, noticeItemId: string): SeatPlanStatus | null;
  /** A turn started from this item's queue notice (or its chain) ended with an answer — its source mail is `seen` (receipt only). */
  noteTurnAnswered(noticeItemId: string): void;
};

const CLOSED: ReadonlySet<string> = new Set(['done', 'superseded', 'cancelled']);

// PLAN-STALE-ON-BOOT (CEO 11-26 23:3x · hands re-delivered #88540 · #89009 · #88550 from 11-18…11-26 on every TUI boot and
// spent turns answering «this is a repeat notice»): the seat plan's ONE active item is queued again at each boot and closes
// only on a turn that ends with a finished update_plan — an item whose mail was simply answered stayed active forever and
// starved 93–245 items queued behind it. At boot an open item now expires (cancelled · evidence names why) when:
//   • its mail is older than PLAN_ITEM_MAX_AGE_MS (출처: two working days — a request older than that is history), or
//   • its mail id is at or below the seat's ack cursor (the seat lineage acked it), or
//   • a turn already answered it and it has been re-offered on more than PLAN_ITEM_MAX_BOOT_OFFERS boots without closing
//     (출처: 11-22 TC-H-CC-2's stale #38547 was hand-closed after repeating — an answered item re-offered twice is a repeat).
// The first boot on a build with this rule is the one-time sweep; each expiry is one `plan.revised` (reason stale-on-boot).
export const PLAN_ITEM_MAX_AGE_MS = 48 * 60 * 60_000;
export const PLAN_ITEM_MAX_BOOT_OFFERS = 2;
const isClosed = (task: SeatPlanItem): boolean => CLOSED.has(task.status);

/** Header piece «계획 k/m»: k = active items (≤ MAX_ACTIVE_PLAN_ITEMS), m = items still open. */
export function seatPlanLine(status: SeatPlanStatus | null): string | null {
  return status ? `계획 ${status.active}/${status.open}` : null;
}

/** Append the plan piece after the seat header line («OPC · 우편 n»). */
export function appendSeatPlan(line: string | null, status: SeatPlanStatus | null): string | null {
  const plan = seatPlanLine(status);
  if (line === null) return plan;
  return plan === null ? line : `${line} · ${plan}`;
}

/** Unread mail → TaskRequest. Receiving is not interrupting (invariant 7): only kind=interrupt mail is marked. */
export function messageToTaskRequest(message: Message): TaskRequest {
  const parsed = Date.parse(message.createdAt);
  const priority = structuredPriority(message);
  // r2 (JUD #121493): the ledger's VERIFIED fields (B1-A origin kind/seat · intent · crown) ride along so the plan
  // notice's header prefers them over the legacy sender/kind — the same rule the immediate-injection path already
  // follows (formatSeatMailPrompt spreads headerFieldsOf). Legacy stays the fallback for rows without the columns.
  const header = headerFieldsOf(message);
  return {
    id: `mail#${message.id}`,
    text: message.body,
    receivedAt: Number.isFinite(parsed) ? parsed : message.id,
    // ELN-SEAT-INBOX-TURN-BOUNDARY (#121130): sender + transport kind ride along so the queue notice
    // can carry the mail ORIGINAL (sender · msg:<id> · body verbatim) — never a one-line summary.
    sender: message.from,
    ...(message.kind !== undefined ? { kind: message.kind } : {}),
    ...(message.kind === 'interrupt' ? { interrupt: true } : {}),
    ...(priority === undefined ? {} : { priority }),
    ...(Object.keys(header).length > 0 ? { header } : {}),
  };
}

/**
 * ELN-SEAT-WORK-QUEUE «🔴/대표 > P0 > 일반» from structured fields only: a crown directive or crown delegation and
 * B1-A priority ≥ 2 (`--priority urgent`) → urgent · priority 1 (`p0`) → p0 · otherwise none (the text marks still apply).
 */
export function structuredPriority(message: Pick<Message, 'priority' | 'crownDirective' | 'origin'>): 'urgent' | 'p0' | undefined {
  if (message.crownDirective || message.origin?.delegatedByCrown) return 'urgent';
  if (typeof message.priority === 'number' && message.priority >= 2) return 'urgent';
  if (typeof message.priority === 'number' && message.priority >= 1) return 'p0';
  return undefined;
}

/** «Next item auto-selection»: with no active item, the selection rule (priority → seq) promotes exactly one (contract §6). */
function promoteNextActive(tasks: SeatPlanItem[]): SeatPlanItem[] {
  if (tasks.some(task => task.status === 'active')) return tasks;
  const pick = selectNextActive(tasks);
  if (pick === undefined) return tasks;
  return tasks.map(task => (task.id === pick.id ? { ...task, status: 'active' as const } : task));
}

export function wireSeatMailToPlan(queue: SeatPlanQueuePort, options: SeatMailPlanWireOptions): SeatPlanRuntime {
  const { seat, ledger, store } = options;
  const mailAdapter = options.mailAdapter ?? createSeatMailAdapter();
  const saved = store?.load() ?? null;
  const enqueuedIds = new Set<string>();
  let items: SeatPlanItem[] = saved?.items ?? [];
  let absorbedUpTo = Math.max(saved?.absorbedUpTo ?? 0, options.cursor ?? ledger.getCursor?.(seat) ?? 0);

  const status = (): SeatPlanStatus => {
    const active = items.filter(item => item.status === 'active').length;
    const waiting = items.filter(item => item.status === 'queued' && typeof item.receivedAt === 'number').map(item => item.receivedAt as number);
    const oldestWaitMs = waiting.length === 0 ? null : Math.max(0, (options.now ?? Date.now)() - Math.min(...waiting));
    return { seat, active: Math.min(active, MAX_ACTIVE_PLAN_ITEMS), open: items.filter(item => !isClosed(item)).length, oldestWaitMs };
  };

  /** Only the ACTIVE item is queued (one notice at a time); items that closed leave the queue. */
  const syncQueueWithPlan = (): void => {
    for (const task of items) {
      if (task.status !== 'active' || enqueuedIds.has(task.id)) continue;
      queue.enqueue(task);
      enqueuedIds.add(task.id);
    }
    queue.syncPlan?.(items.filter(task => !isClosed(task)));
  };

  const persist = (): void => { try { store?.save({ items, absorbedUpTo }); } catch { /* the plan keeps working without its file */ } };
  const receipts = (inputs: readonly ReceiptInput[]): void => {
    if (inputs.length === 0 || options.recordReceipts === undefined) return;
    try { options.recordReceipts(inputs); }
    catch (error) {
      try { debug.log('msg.receipt-writer', 'record-failed', { seat, source: 'plan', msgIds: inputs.map(input => input.messageId), state: inputs[0]!.state, error: error instanceof Error ? error.message : String(error) }, { level: 'warn' }); }
      catch { /* observability is fail-open */ }
    }
  };

  const snapshot = (): PlanSnapshot => {
    const current = status();
    return { active: current.active, open: current.open, items: items.map(item => ({ id: item.id, status: item.status })), oldestWaitMs: current.oldestWaitMs ?? null };
  };
  const emitPlanEvent = options.onPlanEvent ?? ((event: 'plan.revised', data: PlanRevisedEvent) => {
    try { debug.log('plan', event, data as unknown as Record<string, unknown>); } catch { /* observability is fail-open */ }
  });
  /** `plan.revised{before, after, reason}` — only when ids or states moved (a no-op revision is not an event). */
  const revised = (before: PlanSnapshot, reason: PlanRevisedReason, extra: Partial<Pick<PlanRevisedEvent, 'reportLine' | 'msgIds' | 'itemId' | 'superseded'>> = {}): void => {
    const after = snapshot();
    if (JSON.stringify(before.items) === JSON.stringify(after.items)) return;
    try { emitPlanEvent('plan.revised', { seat, reason, before, after, ...extra }); } catch { /* an event sink never breaks the plan */ }
  };

  const absorb = (): SeatPlanStatus => {
    const listed = ledger.list(seat, absorbedUpTo);
    if (listed.length === 0) return status();
    const before = snapshot();
    absorbedUpTo = listed.reduce((max, message) => Math.max(max, message.id), absorbedUpTo);
    const granted = new Set(mailAdapter.claim('plan', listed.map(message => message.id)).granted);
    const messages = listed.filter(message => granted.has(message.id));
    if (messages.length === 0) { persist(); return status(); }
    // ELN-SEAT-WORK-QUEUE «낡은 정기 보고 생략»: a message that names an older one in `supersedes` replaces it —
    // the older is not decomposed in this batch, and its still-open items close as superseded. Structural field only.
    const replaced = new Map<number, number>();
    for (const message of messages) {
      if (typeof message.supersedes !== 'number') continue;
      const target = messages.find(other => other.id === message.supersedes) ?? ledger.getMessage?.(message.supersedes) ?? null;
      if (target !== null && !supersedeAllowed(message, target)) {
        const data = { seat, msgId: message.id, from: message.from, target: message.supersedes, targetFrom: target.from,
          reason: (target.crownDirective || target.origin?.delegatedByCrown) ? 'crown-item-needs-crown' : 'not-own-mail' };
        try { (options.onSupersedeRefused ?? ((d: typeof data) => debug.log('plan', 'plan.supersede-refused', d, { level: 'warn' })))(data); }
        catch { /* observability is fail-open */ }
        continue;
      }
      replaced.set(message.supersedes, message.id);
    }
    const fresh = messages.filter(message => !replaced.has(message.id));
    const requests = fresh.map(messageToTaskRequest);
    const receivedAt = new Map(requests.map(request => [request.id, request.receivedAt]));
    const result = decomposeRequests(requests);
    const decomposed = { ...result, tasks: result.tasks.map(task => ({ ...task, receivedAt: receivedAt.get(task.sourceRequestId) ?? (options.now ?? Date.now)() })) };
    // #38288 REVIEW-2 must: close the replaced items BEFORE reconciling — a closed item is never a host, so the newer
    // report is listed as its own item (absorption runs old → new) instead of being folded into the old one and then
    // lost when the old one closes (across two batches both used to vanish without a signal).
    const mailIdOf = (task: DecomposedTask): number => Number(task.sourceRequestId.replace(/^mail#/, ''));
    const closedOld: DecomposedTask[] = [];
    const existing = items.map(task => {
      const by = replaced.get(mailIdOf(task));
      if (by === undefined || isClosed(task)) return task;
      const closed = { ...task, status: 'superseded' as const };
      closedOld.push(closed);
      return closed;
    });
    // Invariant 10 (a new utterance is not an automatic revision): cancellations are never applied here.
    const revision = reconcilePlan(existing, { ...decomposed, cancellations: [] });
    let merged = [...revision.kept, ...revision.rescheduled];
    const supersededPairs: Array<{ itemId: string; by: string }> = [];
    if (closedOld.length > 0) {
      merged = merged.map(task => {
        if (!closedOld.some(old => old.id === task.id)) return task;
        const host = merged.find(other => other.sourceRequestId === `mail#${replaced.get(mailIdOf(task))}` && !isClosed(other));
        if (host) supersededPairs.push({ itemId: task.id, by: host.id });
        return host ? { ...task, supersededBy: host.id } : task;
      });
    }
    items = promoteNextActive(orderPlanTasks(merged));
    // TURN-FIELD-BUG-3: the plan carries only mail that became an item (any status · folded = superseded item) or was
    // replaced in this batch. A `source: plan` receipt hides mail from the per-message watcher (seat-message-receipts.ts
    // takenMessageIds), so mail that decomposed into NOTHING must not get one — and its claim goes back — or it never
    // opens a turn (live 11-18 capsule test universe s1: a second idle mail absorbed at a turn end, 0 items, lost).
    const carried = new Set<number>([...replaced.keys()]);
    for (const task of items) if (Number.isSafeInteger(mailIdOf(task))) carried.add(mailIdOf(task));
    // JUD #38701 ⓑ: a request folded into an existing host (reconcilePlan → revision.superseded) is carried by that host
    // too — it is not in `items`, but without the plan's receipt and claim the watcher would open a second turn for it.
    for (const task of revision.superseded) if (Number.isSafeInteger(mailIdOf(task))) carried.add(mailIdOf(task));
    const notCarried = messages.filter(message => !carried.has(message.id)).map(message => message.id);
    receipts(messages.filter(message => carried.has(message.id))
      .map(message => ({ messageId: message.id, recipient: seat, state: 'delivered' as const, source: 'plan' as const })));
    if (notCarried.length > 0) mailAdapter.release('plan', notCarried);
    syncQueueWithPlan();
    persist();
    revised(before, 'mail-absorbed', { reportLine: revision.reportLine, msgIds: messages.map(message => message.id),
      ...(supersededPairs.length > 0 ? { superseded: supersededPairs } : {}) });
    return status();
  };

  const closeItem = (id: string, evidence: string, reason: PlanRevisedReason): SeatPlanStatus => {
    const before = snapshot();
    items = promoteNextActive(orderPlanTasks(markTaskDone(items, id, evidence)));
    syncQueueWithPlan();
    persist();
    revised(before, reason, { itemId: id });
    return status();
  };
  const complete = (id: string, evidence: string): SeatPlanStatus => closeItem(id, evidence, 'item-done');

  const noteTurnOutcome: SeatPlanRuntime['noteTurnOutcome'] = (kind, evidence, noticeItemId) => {
    if (kind !== 'done') return null;
    const active = items.find(task => task.status === 'active');
    // A plan the model finished on some other turn (a person's own question) says nothing about the mail item.
    if (!active || queue.taskOfNotice?.(noticeItemId) !== active.id) return null;
    return closeItem(active.id, evidence, 'turn-done');
  };

  const noteTurnAnswered: SeatPlanRuntime['noteTurnAnswered'] = noticeItemId => {
    const taskId = queue.taskOfNotice?.(noticeItemId);
    const task = taskId === undefined ? undefined : items.find(item => item.id === taskId);
    const mailId = task === undefined ? NaN : Number(task.sourceRequestId.replace(/^mail#/, ''));
    if (!Number.isSafeInteger(mailId) || mailId <= 0) return;
    receipts([{ messageId: mailId, recipient: seat, state: 'seen', source: 'plan', queueItemId: noticeItemId }]);
    mailAdapter.settle('plan', [mailId], 'responded');
    // PLAN-STALE-ON-BOOT: remember the item was answered — a later boot that re-offers it counts toward its expiry.
    const at = (options.now ?? Date.now)();
    items = items.map(item => (item.id === task!.id ? { ...item, answeredAt: at } : item));
    persist();
  };

  // PLAN-STALE-ON-BOOT — expire what a boot must not offer again, then promote the next item.
  {
    const before = snapshot();
    const nowMs = (options.now ?? Date.now)();
    const cursor = (() => { try { return ledger.getCursor?.(seat) ?? 0; } catch { return 0; } })();
    const expired: string[] = [];
    items = items.map(task => {
      if (isClosed(task)) return task;
      const mailId = Number(task.sourceRequestId.replace(/^mail#/, ''));
      const age = typeof task.receivedAt === 'number' ? nowMs - task.receivedAt : 0;
      // A re-offer counts only for an item a turn already answered (a long task still being worked is answered too, but a
      // first-time item that never got its turn is not «repeated»).
      const offers = task.status === 'active' && task.answeredAt !== undefined ? (task.bootOffers ?? 0) + 1 : (task.bootOffers ?? 0);
      const why = age > PLAN_ITEM_MAX_AGE_MS ? `expired on boot: mail older than ${PLAN_ITEM_MAX_AGE_MS / 3_600_000}h`
        : Number.isSafeInteger(mailId) && mailId > 0 && mailId <= cursor ? `expired on boot: mail #${mailId} already acked by ${seat}`
          : offers > PLAN_ITEM_MAX_BOOT_OFFERS ? `expired on boot: re-offered on ${offers} boots without closing` : null;
      if (why) { expired.push(task.id); return { ...task, status: 'cancelled' as const, doneEvidence: why }; }
      return offers !== (task.bootOffers ?? 0) ? { ...task, bootOffers: offers } : task;
    });
    if (expired.length > 0) {
      items = promoteNextActive(orderPlanTasks(items));
      persist();
      revised(before, 'stale-on-boot', { itemId: expired.join(',') });
    } else if (items.some(task => task.bootOffers !== undefined)) persist();
  }
  // A restart starts with an empty prompt queue: the saved active item is queued again, nothing else.
  syncQueueWithPlan();
  return { absorb, status, plan: () => items, complete, noteTurnOutcome, noteTurnAnswered };
}

/**
 * Ties turns to the active plan item. A turn belongs to the item when it started from the item's queue notice, or continues such a
 * turn by itself (an automatic follow-up); a turn the person typed ends the chain. Closing happens whatever the auto-continue
 * decision was — a queued input or a draft makes the auto-continue yield, but the finished plan is still finished.
 */
export function createSeatPlanTurnLink(runtime: SeatPlanRuntime) {
  let dispatched: { id: string; text: string } | null = null;
  let chain: string | null = null;
  return {
    /** The queue handed this notice to the input as the next turn. */
    noticeDispatched(noticeItemId: string, text: string): void { dispatched = { id: noticeItemId, text }; },
    /** A chat turn starts; returns the notice its chain belongs to (null = not a plan-item turn). */
    turnStarted(turnText: string, internal: boolean): string | null {
      if (dispatched !== null && dispatched.text.trim() === turnText.trim()) chain = dispatched.id;
      else if (!internal) chain = null;
      dispatched = null;
      return chain;
    },
    /** A chat turn ended. Returns the plan status when this turn's finished plan closed the active item. */
    turnEnded(chainId: string | null, completed: boolean, plan: PlanWire | undefined): SeatPlanStatus | null {
      // seen only after an ANSWERED turn of the item (the #38203 REVIEW-1 ① rule) — before the done check closes the item.
      if (completed && chainId !== null) runtime.noteTurnAnswered(chainId);
      if (!completed || chainId === null || plan === undefined || outcomeOfPlanWire(plan).kind !== 'done') return null;
      const closed = runtime.noteTurnOutcome('done', `update_plan v${plan.version}: all ${plan.steps.length} steps completed`, chainId);
      if (closed !== null && chain === chainId) chain = null;
      return closed;
    },
  };
}

/**
 * Prompt queue → plan port. Plan items travel as `seat-mail` notices (대표 addendum C: notices wait behind what the person typed).
 * `syncPlan` retracts the notice of an item that closed before its turn started; a notice already delivered cannot be retracted.
 */
export function seatTaskQueueFromPromptQueue(
  promptQueue: { enqueueNotice(text: string, source: 'seat-mail', meta?: { msgId?: number; occurredAt?: number; urgent?: boolean }): { id: string }; cancel(id: string, reason?: string): unknown;
    onTransition?: (listener: (item: { id: string; status: string }) => void) => () => void },
  onStarted?: (messageId: number, itemId: string) => void,
): SeatPlanQueuePort {
  const noticeOf = new Map<string, string>();
  const enqueued = new Map<string, SeatPlanItem>();
  promptQueue.onTransition?.(item => {
    if (item.status !== 'delivered') return;
    const taskId = [...noticeOf].find(([, id]) => id === item.id)?.[0];
    const source = taskId === undefined ? undefined : enqueued.get(taskId)?.sourceRequestId;
    const id = /^mail#([1-9]\d*)$/.exec(source ?? '')?.[1];
    if (id) onStarted?.(Number(id), item.id);
  });
  return {
    enqueue: task => {
      if (noticeOf.has(task.id)) return;
      const mailIdMatch = /^mail#([1-9]\d*)$/.exec(task.sourceRequestId);
      const mailIdNum = mailIdMatch === null ? undefined : Number(mailIdMatch[1]);
      // ELN-SEAT-INBOX-TURN-BOUNDARY (#121130): this notice IS the next turn's model input — it must carry
      // the mail ORIGINAL (sender · msg:<id> · body verbatim, seatMessageContextBlock), never a summary line:
      // a summary made the model «answer» without ever seeing the mail, and the after-turn ack then made
      // it vanish from the unread list. The queue keys the mail identity as msgId meta, never as its text.
      // r2 (JUD #121493): the VERIFIED header markers (origin kind/seat · intent · crown) ride the plan
      // notice too — headerFieldsOf already flattened them onto the task; legacy sender/kind is only the
      // fallback, exactly like the immediate-injection path (formatSeatMailPrompt).
      const original = mailIdNum === undefined || task.sourceSender === undefined ? '' : `\n${seatMessageContextBlock({
        id: mailIdNum, sender: task.sourceSender, body: task.sourceText,
        ...(task.sourceKind !== undefined ? { kind: task.sourceKind } : {}),
        ...(task.sourceHeader ?? {}),
      })}`;
      noticeOf.set(task.id, promptQueue.enqueueNotice(`[계획] ${task.title}${original}`, 'seat-mail',
        mailIdNum === undefined ? {} : { msgId: mailIdNum }).id);
      enqueued.set(task.id, task);
    },
    snapshot: () => [...enqueued.values()],
    taskOfNotice: noticeItemId => [...noticeOf].find(([, itemId]) => itemId === noticeItemId)?.[0],
    syncPlan: openTasks => {
      const open = new Set(openTasks.map(task => task.id));
      for (const [taskId, itemId] of [...noticeOf]) {
        if (open.has(taskId)) continue;
        noticeOf.delete(taskId);
        enqueued.delete(taskId);
        try { promptQueue.cancel(itemId, 'plan-closed'); } catch { /* already delivered: nothing left to retract */ }
      }
    },
  };
}

/** Plan persistence as one JSON file per seat (temp file + rename, so a half-written file never exists). */
export function createSeatPlanFileStore(path: string): SeatPlanStore {
  return {
    load: () => {
      try {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<SeatPlanSaved>;
        return Array.isArray(raw.items) && typeof raw.absorbedUpTo === 'number' ? { items: raw.items, absorbedUpTo: raw.absorbedUpTo } : null;
      } catch { return null; }
    },
    save: state => {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(state));
      renameSync(tmp, path);
    },
  };
}
