import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
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
} from '../dashboard/input/seat-task-decompose.js';
import type { Message, MsgStore } from '../msg/msg-store.js';
import { outcomeOfPlanWire, type PlanWire } from '../code-edit/plan-wire.js';
import type { ReceiptInput, ReceiptRecordOutcome } from '../msg/msg-receipts.js';
import { headerFieldsOf, seatMessageContextBlock, type StructuredMessageFields } from '../msg/msg-context-header.js';
import type { NextTuiWakeup } from '../tui-client/next-wakeup.js';
import { createSeatMailAdapter, type SeatMailAdapter } from './turn-events/mail-adapter.js';
import type { NextTuiSelfHealthSnapshot } from './chat/self-health-status.js';
import type { StartTurnIfIdleOptions, StartTurnIfIdleResult } from '../chat/internal-turn-contract.js';
// size-contract: src/tui 는 dashboard 모듈을 import 하지 않는다(chat 계약 import 는 허용 —
// src/tui/input/internal-turn.ts 도 같은 정본을 쓴다). 게이트 인자·결과는 정본 타입을 그대로 쓴다.

export interface SeatMailSnapshot {
  seat: string;
  unread: number | null;
}

const SEAT_IN_PATH = /(?:^|\/)seats\/([A-Za-z][A-Za-z0-9_-]{0,63})(?=\/|$)/g;
const SEAT_ID = /^[A-Z][A-Z0-9_-]{0,63}$/;

/** cwd 의 `seats/<id>` 경로(없으면 COORD_ID)에서 자리 id 를 뽑는다 — 못 뽑으면 null. */
export function resolveSeatId(
  cwd: string,
  deps: { env?: NodeJS.ProcessEnv } = {},
): string | null {
  const env = deps.env ?? process.env;
  const seat = ([...cwd.matchAll(SEAT_IN_PATH)].at(-1)?.[1] ?? env.COORD_ID ?? '').trim().toUpperCase();
  return SEAT_ID.test(seat) ? seat : null;
}

/** A small, read-only snapshot for the next TUI's first frame. */
export function readSeatMailSnapshot(
  cwd: string,
  deps: {
    home?: string;
    env?: NodeJS.ProcessEnv;
    msgPath?: string;
  } = {},
): SeatMailSnapshot | null {
  const env = deps.env ?? process.env;
  // A seat can run an isolated checkout whose path contains another seats/ segment.
  // The innermost segment names the current seat, not the parent workspace —
  // resolveSeatId 가 같은 판정(내측 segments 우선·COORD_ID 폴백)을 수행한다.
  const seat = resolveSeatId(cwd, { env });
  if (seat === null) return null;
  const seatDir = join(deps.home ?? homedir(), 'elanous-hq', 'seat-state', seat);
  try {
    if (!statSync(seatDir).isDirectory()) return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    return { seat, unread: null };
  }
  const msgPath = deps.msgPath ?? join(elanousStateRoot(), 'msg', 'messages.db');
  try {
    statSync(msgPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { seat, unread: code === 'ENOENT' ? 0 : null };
  }
  // Loading MsgStore is only needed when there is an existing ledger to read.
  // A damaged or inaccessible ledger must not prevent the TUI from booting.
  try {
    const msg = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js');
    const store: MsgStore = new msg.MsgStore(msgPath, { readOnly: true });
    try {
      return { seat, unread: store.unreadCount(seat) };
    } finally {
      store.close();
    }
  } catch {
    return { seat, unread: null };
  }
}

export function seatMailLine(snapshot: SeatMailSnapshot | null): string | null {
  return snapshot ? `${snapshot.seat} · 우편 ${snapshot.unread ?? '확인 불가'}` : null;
}

// ── ELN-SEAT-INBOX-TURN-BOUNDARY — 턴 경계 우편 자동 수신 ───────────────────────────
// 턴이 settle 하는 순간에만 잰다(진행 턴 비중단 = 구조적 보장). 주입은 오직 H2 문
// startTurnIfIdle 경로(대표 비침투: 입력칸 버퍼·injectKey·pty 0). 본문은 전문 주입한다(잘림 0 —
// mustFix ①). ack 는 «처리 뒤» — 주입 턴이 아니라 그 턴이 끝난 다음 경계의 check() 에서
// pendingAck 집합을 ackMessage+advanceCursor 한다. 거부(NotIdle 등)면 ack 안 하고 다음 경계에 재시도.

export interface SeatMailItem extends StructuredMessageFields { id: number; from: string; body: string; kind?: string; }

export interface SeatMailInboxStore {
  getCursor(recipient: string): number;
  listByRecipient(recipient: string, after?: number, limit?: number): SeatMailItem[];
  advanceCursor(recipient: string, cursor: number): number;
  ackMessage(recipient: string, messageId: number, status?: 'acked' | 'done'): boolean;
  /**
   * SEAT-INBOX B1-C — 클래식 대시보드엔 입력 큐가 없다. 그래서 delivered = 주입 턴이 열림 · seen = 그 턴이
   * 끝난 경계(기존 «처리 뒤 ack» 시점). 없으면(옛 가짜 원장) 영수증 없이 지금 동작 그대로.
   */
  recordReceipt?(input: ReceiptInput): ReceiptRecordOutcome;
  close(): void;
}

export interface SeatMailInboxDeps {
  seat: string;
  msgPath: string;
  startTurnIfIdle: (input: string, opts: StartTurnIfIdleOptions) => StartTurnIfIdleResult;
  openStore?: (path: string) => SeatMailInboxStore;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
  defer?: (fn: () => void, ms: number) => void;
}

export interface SeatMailInboxController {
  noteTurnEnded(): void;
  check(): { delivered: boolean; count: number; rejected?: string };
  stop(): void;
}

/**
 * mustFix ① — 본문을 자르지 않고 전문 주입한다(200자 잘림으로 뒷부분 지시가 유실되던 결함).
 * SEAT-INBOX B1-C §5d — 메시지마다 머리 한 줄 «[from <자리> · <intent>]» 을 붙인 별도 블록(구조 칸에서만 만든다).
 */
export function formatSeatMailPrompt(seat: string, msgs: SeatMailItem[]): string {
  const blocks = msgs.map(m => seatMessageContextBlock({ id: m.id, sender: m.from, body: m.body, kind: m.kind ?? null, ...headerFieldsOf(m) }));
  return `[우편 수신] ${seat} 앞 ${msgs.length}통(턴 경계 자동 수신 · 처리 뒤 ack) — 위부터 읽고 처리하세요:\n${blocks.join('\n\n')}`;
}

/** Receipt writes never change delivery — a failure is a log line (fail-soft). */
function tryReceipt(store: SeatMailInboxStore, input: ReceiptInput, log: (category: string, event: string, data: Record<string, unknown>) => void): void {
  if (!store.recordReceipt) return;
  try { store.recordReceipt(input); } catch (e) {
    log('msg.receipt-writer', 'record-failed', { msgId: input.messageId, recipient: input.recipient, state: input.state, message: String(e) });
  }
}

export function createSeatMailInbox(deps: SeatMailInboxDeps): SeatMailInboxController {
  const log = deps.log ?? (() => {});
  const defer = deps.defer ?? ((fn) => { const t = setTimeout(fn, 0); (t as { unref?: () => void }).unref?.(); });
  // MsgStore 는 import type 으로만 들여왔으므로 값 생성은 require 로 — readSeatMailSnapshot(64줄)과 동일 패턴.
  const openStore = deps.openStore ?? ((path: string) => {
    const mod = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js');
    return new mod.MsgStore(path) as unknown as SeatMailInboxStore;
  });
  let armed = false;
  const pendingAck = new Set<number>();

  const check: SeatMailInboxController['check'] = () => {
    if (!armed) return { delivered: false, count: 0 };
    armed = false;
    let store: SeatMailInboxStore;
    try { store = openStore(deps.msgPath); } catch (e) { log('tui.seat-mail-inbox', 'store-error', { seat: deps.seat, message: String(e) }); return { delivered: false, count: 0 }; }
    try {
      // ── 1단계: 이전 턴에 주입했던 우편을 «처리 뒤» 여기서 ack(mustFix ①).
      // 주입 턴이 끝나 이 경계에 도달했으므로 모델이 본문을 받아 처리할 기회는 지났다.
      if (pendingAck.size > 0) {
        let ackMax = 0;
        for (const id of pendingAck) {
          // B1-C — seen 영수증(호환 ack 도 같이 쓴다) 뒤에 기존 ack. 영수증이 없거나 실패해도 ack 는 그대로.
          tryReceipt(store, { messageId: id, recipient: deps.seat, state: 'seen', source: 'dashboard-inbox' }, log);
          try { store.ackMessage(deps.seat, id, 'acked'); } catch { /* 자기 ALL 방송 등 — 커서로 덮음 */ }
          if (id > ackMax) ackMax = id;
        }
        try { store.advanceCursor(deps.seat, ackMax); } catch { /* 단조 위반 아님 — 무시 */ }
        log('tui.seat-mail-inbox', 'acked-after-turn', { seat: deps.seat, count: pendingAck.size, maxId: ackMax });
        pendingAck.clear();
      }
      // ── 2단계: 커서 이후 새 우편을 전문 주입. 커서는 옮기지 않는다(다음 경계 ack).
      const cursor = store.getCursor(deps.seat);
      const batch = store.listByRecipient(deps.seat, cursor).sort((a, b) => a.id - b.id);
      if (batch.length === 0) return { delivered: false, count: 0 };
      const maxId = batch[batch.length - 1]!.id;
      const result = deps.startTurnIfIdle(formatSeatMailPrompt(deps.seat, batch), {
        origin: 'msg-wake', reason: `seat-mail-inbox: 우편 ${batch.length}통`,
      });
      if (!result.opened) {
        log('tui.seat-mail-inbox', 'rejected', { seat: deps.seat, count: batch.length, reason: result.reason });
        return { delivered: false, count: batch.length, rejected: result.reason };
      }
      for (const m of batch) {
        pendingAck.add(m.id);
        tryReceipt(store, { messageId: m.id, recipient: deps.seat, state: 'delivered', source: 'dashboard-inbox' }, log);
      }
      log('tui.seat-mail-inbox', 'delivered', { seat: deps.seat, count: batch.length, maxId, turnId: result.turnId });
      return { delivered: true, count: batch.length };
    } finally { try { store.close(); } catch { /* fail-soft */ } }
  };

  return {
    noteTurnEnded() { armed = true; defer(() => { try { check(); } catch { /* fail-soft */ } }, 0); },
    check,
    stop() { /* 원격 구독 경로 제거(mustFix ②) — 정리할 자원 없음 */ },
  };
}

/**
 * Register the seat branch once at boot; each render projects live health and wake state.
 * ELN-PLAN-WIRE-SEAT (#38016): `plan`이 주어지면 매 렌더에 «계획 k/m» 조각을 헤더에 붙인다(mf②).
 */
export function createSeatMailHeaderHook(
  cwd: string,
  deps: Parameters<typeof readSeatMailSnapshot>[1] = {},
  plan?: { status(): SeatPlanStatus | null } | null,
): (health: NextTuiSelfHealthSnapshot | null, wakeup: Pick<NextTuiWakeup, 'headline'> | null) => string | null {
  const mail = seatMailLine(readSeatMailSnapshot(cwd, deps));
  return (health, wakeup) => {
    const line = mail && wakeup ? `${mail} · ${wakeup.headline(health)}` : mail;
    return plan ? appendSeatPlan(line, plan.status()) : line;
  };
}

// ---------------------------------------------------------------------------
// ELN-PLAN-WIRE-SEAT (#38016 · absorbed into DECISION-GATE v2): mail → decomposition → plan → next item.
// The decomposition engine (src/dashboard/input/seat-task-decompose) is pure; this file wires it:
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
export type PlanRevisedReason = 'mail-absorbed' | 'item-done' | 'turn-done';
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
  return {
    id: `mail#${message.id}`,
    text: message.body,
    receivedAt: Number.isFinite(parsed) ? parsed : message.id,
    ...(message.kind === 'interrupt' ? { interrupt: true } : {}),
    ...(priority === undefined ? {} : { priority }),
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
  };

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
  promptQueue: { enqueueNotice(text: string, source: 'seat-mail'): { id: string }; cancel(id: string, reason?: string): unknown },
): SeatPlanQueuePort {
  const noticeOf = new Map<string, string>();
  const enqueued = new Map<string, SeatPlanItem>();
  return {
    enqueue: task => {
      if (noticeOf.has(task.id)) return;
      noticeOf.set(task.id, promptQueue.enqueueNotice(`[계획] ${task.title}`, 'seat-mail').id);
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

/**
 * TUI boot wiring: the real mail ledger (opened per call and closed again — mail that arrives after boot is absorbed on the next
 * call), the real prompt queue, a per-seat plan file. A cwd that is not a seat builds nothing.
 */
export function createSeatMailPlanRuntime(
  options: Readonly<{
    cwd: string;
    deps?: Parameters<typeof readSeatMailSnapshot>[1];
    queue: SeatPlanQueuePort;
    /** Plan file directory (default: the state root's `seat-plans`). */
    planDir?: string;
    /** The seat's one mail owner — the same instance the notice watcher gets (entry.ts). */
    mailAdapter?: SeatMailPlanWireOptions['mailAdapter'];
  }>,
): { header: ReturnType<typeof createSeatMailHeaderHook>; runtime: SeatPlanRuntime | null } {
  const snapshot = readSeatMailSnapshot(options.cwd, options.deps ?? {});
  if (!snapshot || snapshot.unread === null) return { header: createSeatMailHeaderHook(options.cwd, options.deps ?? {}), runtime: null };
  let runtime: SeatPlanRuntime | null = null;
  try {
    const msg = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js');
    const withLedger = <T>(fn: (store: MsgStore) => T, fallback: T): T => {
      let store: MsgStore | undefined;
      try {
        store = new msg.MsgStore(resolveMsgPath(options.deps), { readOnly: true });
        return fn(store);
      } catch { return fallback; } finally { store?.close(); }
    };
    const ledger: SeatPlanLedger = {
      list: (recipient, after, limit) => withLedger(store => store.list(recipient, after, limit), []),
      getCursor: recipient => withLedger(store => store.getCursor(recipient), 0),
      getMessage: id => withLedger(store => store.getMessage(id), null),
    };
    const planFile = join(options.planDir ?? join(elanousStateRoot(), 'seat-plans'), `${snapshot.seat}.json`);
    const recordReceipts = (inputs: readonly ReceiptInput[]): void => {
      // One writable open per batch (the read path stays read-only); each receipt fails on its own, loudly.
      const store = new msg.MsgStore(resolveMsgPath(options.deps));
      try {
        for (const input of inputs) {
          try { store.recordReceipt(input); }
          catch (error) {
            // Same fields as the batch-level warn (seat · source · msgIds · state) — one shape to search for (#38376 Terra ①).
            try { debug.log('msg.receipt-writer', 'record-failed', { seat: snapshot.seat, source: input.source, msgIds: [input.messageId], state: input.state, error: error instanceof Error ? error.message : String(error) }, { level: 'warn' }); }
            catch { /* observability is fail-open */ }
          }
        }
      } finally { store.close(); }
    };
    runtime = wireSeatMailToPlan(options.queue, { seat: snapshot.seat, ledger, store: createSeatPlanFileStore(planFile), recordReceipts,
      ...(options.mailAdapter ? { mailAdapter: options.mailAdapter } : {}) });
    runtime.absorb();
  } catch {
    runtime = null; // boot continues without a plan (ledger missing or damaged)
  }
  return { header: createSeatMailHeaderHook(options.cwd, options.deps ?? {}, runtime), runtime };
}

/** Ledger path — the same rule as readSeatMailSnapshot (an explicit msgPath first, else the state root). */
function resolveMsgPath(deps: Parameters<typeof readSeatMailSnapshot>[1] | undefined): string {
  return deps?.msgPath ?? join(elanousStateRoot(), 'msg', 'messages.db');
}
