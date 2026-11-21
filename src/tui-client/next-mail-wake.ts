// Seat mail reaches next TUI through the shared H2 gate; no prompt is typed into a pane.
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { emitTurnLife } from '../debug/turn-life.js';
import { readSeatBudgetUsage, type SeatUsageBucket } from '../dashboard/input/seat-autowake-budget.js';
import { detectSeatTui } from '../seat/seat-boot-preamble.js';
import type { StartTurnIfIdleOptions, StartTurnIfIdleResult } from '../tui/input/internal-turn.js';
import { defaultMsgStorePath, MsgStore, readUnreadSource, readUnreadSummary, type UnreadSource } from '../msg/msg-store.js';
import type { MessageSource } from '../session/index.js';

/** Idle mail watch period (ELN-EXTERNAL-EVENTS ①: a poll, when used, is at most 15s). */
export const IDLE_MAIL_WATCH_MS = 15_000;
/** A refused idle wake is retried on this short cadence instead of waiting out the whole watch period. */
export const IDLE_MAIL_RETRY_MS = 1_000;
/**
 * #38219 REVIEW-2 ①: a mail turn that ends without any answer (provider outage, expired auth) is retried with exponential
 * back-off from the watch period, and after this many in a row that batch is given up (event `gave-up`) — the mail stays
 * unread for A217 overdue and the 60s fallback instead of a turn every 15 seconds forever.
 */
// Source: #38219 REVIEW-2 ① — consecutive no-answer mail turns before giving the batch up.
export const MAIL_WAKE_NO_ANSWER_LIMIT = 5;

export interface NextMailWakeDeps {
  startTurnIfIdle: (text: string, opts: StartTurnIfIdleOptions) => StartTurnIfIdleResult;
  cwd?: string;
  home?: string;
  seat?: string | null;
  enabled?: boolean;
  readUnread?: (seat: string) => { count: number; maxId: number | null } | null;
  /** The single agent seat the unread set came from, or null (mixed / non-agent). Default: the ledger. */
  readSource?: (seat: string) => UnreadSource | null;
  /**
   * The agent-sourced turn put those messages' bodies into the model's context: «seen» (B1-C · compat ack) once the turn
   * actually starts (`confirmDelivery`). Default: the ledger (skipped when `readUnread` is injected).
   */
  recordSeen?: (seat: string, messageIds: readonly number[]) => void;
  /** Clock for the no-answer back-off (default Date.now). */
  now?: () => number;
  /**
   * The opened turn = «delivered» for the unread messages up to `maxId` (B1-C receipt · the 60s eln fallback reads it).
   * Not «seen» by itself: an instruction-only (system) turn gets seen from the model's own ack; an agent-sourced turn gets
   * seen once that turn answered (`noteTurnFinished` → `recordSeen`). Default: the ledger.
   */
  recordDelivered?: (seat: string, maxId: number, turnId: string) => void;
  /**
   * Daily token budget for this seat's wake turns: `{budget, used}` or null (no budget configured / usage unknown).
   * Default: `seat-state/<seat>/autowake-budget` + today's usage ledger (read only when that file holds a valid budget).
   * Fail-open: a read failure is null (the wake proceeds) — see the gate in poll().
   */
  readBudgetUsage?: (now: Date) => { budget: number; used: number } | null;
  /** Test seam for the default supply's usage ledger read (rows of one UTC day); null = unavailable. */
  readBudgetLedger?: (day: string) => readonly SeatUsageBucket[] | null;
  /** Local «HH:MM» for a due timestamp (test seam for the time zone). */
  formatDue?: (iso: string) => string | null;
  intervalMs?: number;
  /** Delay before retrying a gate refusal (NotIdle / HumanTyping). Default {@link IDLE_MAIL_RETRY_MS}. */
  retryMs?: number;
  /** Test seam for the refusal retry timer. */
  scheduleRetry?: (fn: () => void, ms: number) => { cancel: () => void };
  log?: (event: string, data: Record<string, unknown>) => void;
  /** OBSERVE-TURN-EVENT-LIFECYCLE — turn-life observation hook (fail-open). */
  turnLifeLog?: (event: string, data: Record<string, unknown>) => void;
}

export interface NextMailWake {
  poll(): void;
  pendingDeliveryAllowed(): boolean;
  withdrawPending(): void;
  /** The input loop took the mail turn (it is starting). Nothing is marked seen yet. */
  confirmDelivery(): void;
  /**
   * #38203 REVIEW-1 ①: the mail turn ended. `responded` (any assistant text or tool activity) → seen for the bodies it carried;
   * no response (failed or cancelled right away) → nothing is marked and that batch counts as not opened, so the next poll wakes again.
   */
  noteTurnFinished(responded: boolean): void;
  dispose(): void;
}

/** Local «HH:MM» of an ISO timestamp, or null when it does not parse. */
export function localDueHHMM(iso: string): string | null {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return null;
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/** The turn's structured source when every unread message came from one agent seat; undefined otherwise (system). */
export function mailWakeSource(source: UnreadSource | null, formatDue: (iso: string) => string | null = localDueHHMM): MessageSource | undefined {
  if (!source) return undefined;
  const due = source.deadlineAt ? formatDue(source.deadlineAt) : null;
  return { kind: 'agent', seat: source.seat, msgId: String(source.latestId),
    ...(source.intent ? { intent: source.intent } : {}), ...(due ? { due } : {}) };
}

/**
 * MSG-SOURCE-HIERARCHY (#38203 REVIEW): under «⇢ OP · request · due · #id» the log draws the turn's text, so an agent-sourced
 * turn carries exactly what that seat wrote — the unread bodies, oldest first — and nothing the harness wrote.
 */
// Source: #38203 REVIEW-1 ② — OP: one mail turn carries at most the newest 20 bodies / 8k characters, then «외 n건».
export const AGENT_MAIL_TURN_MAX_MESSAGES = 20;
// Source: #38203 REVIEW-1 ② — the character budget (a single body is never cut; it can exceed this alone).
export const AGENT_MAIL_TURN_MAX_CHARS = 8_000;

/** Which messages one agent-sourced turn carries: newest first within the budget, returned oldest first, plus how many older were left. */
export function agentMailTurnBatch(source: Pick<UnreadSource, 'messages'>): { messages: Array<{ id: number; body: string }>; omitted: number } {
  const picked: Array<{ id: number; body: string }> = [];
  let chars = 0;
  for (const message of [...source.messages].reverse()) {
    if (picked.length >= AGENT_MAIL_TURN_MAX_MESSAGES) break;
    if (picked.length > 0 && chars + message.body.length > AGENT_MAIL_TURN_MAX_CHARS) break;
    picked.push(message);
    chars += message.body.length;
  }
  return { messages: picked.reverse(), omitted: source.messages.length - picked.length };
}

export function agentMailTurnText(source: Pick<UnreadSource, 'messages'>): string {
  const batch = agentMailTurnBatch(source);
  const bodies = batch.messages.map(message => message.body).join('\n\n');
  return batch.omitted > 0 ? `(외 ${batch.omitted}건 — 앞선 우편은 eln msg list 로)\n\n${bodies}` : bodies;
}

/** Ledger writer for {@link NextMailWakeDeps.recordSeen} — fail-soft. */
export function ledgerRecordSeen(path?: string) {
  return (seat: string, messageIds: readonly number[]): void => {
    try {
      const store = path === undefined ? new MsgStore(defaultMsgStorePath()) : new MsgStore(path);
      try {
        for (const id of messageIds) {
          try { store.recordReceipt({ messageId: id, recipient: seat, state: 'seen', source: 'tui-mail-wake' }); }
          catch { /* one row never stops the rest */ }
        }
      } finally { store.close(); }
    } catch (error) {
      try { debug.log('tui.msg-wake', 'receipt-failed', { seat, ids: messageIds.length, error: String(error) }); } catch { /* fail-open */ }
    }
  };
}

/** Ledger writer for {@link NextMailWakeDeps.recordDelivered} — fail-soft: a receipt never changes the wake. */
export function ledgerRecordDelivered(path: string = defaultMsgStorePath()) {
  return (seat: string, maxId: number, turnId: string): void => {
    try {
      const store = new MsgStore(path);
      try {
        for (const message of store.listByRecipient(seat, store.getCursor(seat), 1000)) {
          if (message.id > maxId || message.to !== seat) continue;
          try { store.recordReceipt({ messageId: message.id, recipient: seat, state: 'delivered', source: 'tui-mail-wake', queueItemId: turnId }); }
          catch { /* one row (e.g. a group copy) never stops the rest */ }
        }
      } finally { store.close(); }
    } catch (error) {
      try { debug.log('tui.msg-wake', 'receipt-failed', { seat, maxId, error: String(error) }); } catch { /* fail-open */ }
    }
  };
}

/** Default budget supply: no `autowake-budget` file → null with zero ledger reads. Any read failure → null (fail-open). */
function defaultBudgetUsage(home: string, seat: string, ledger?: NextMailWakeDeps['readBudgetLedger']): (now: Date) => { budget: number; used: number } | null {
  return now => {
    let budgetText: string | undefined;
    try { budgetText = readFileSync(join(home, 'elanous-hq', 'seat-state', seat, 'autowake-budget'), 'utf8'); }
    catch { return null; }
    const result = readSeatBudgetUsage({ seat, budgetText, now, readUsage: ledger ?? (day => {
      // Lazy: the ledger module is touched only once a budget file exists.
      const { readUsageDaily } = require('../budget/usage-daily-store.js') as typeof import('../budget/usage-daily-store.js');
      const usage = readUsageDaily(undefined, day);
      return usage && usage.unclassifiedRows === 0 ? usage.rows : null;
    }) });
    if (result.budget === null) return null; // no / invalid budget file: the gate is off
    // A valid budget whose usage cannot be known is a read failure: surfaced (poll logs budget-read-error) and let through.
    if (result.used === null) throw new Error('usage ledger unavailable');
    return { budget: result.budget, used: result.used };
  };
}

function regularFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

export function createNextMailWake(deps: NextMailWakeDeps): NextMailWake {
  const home = deps.home ?? homedir();
  let seat = deps.seat ?? null;
  if (deps.seat === undefined) {
    try { seat = detectSeatTui(deps.cwd ?? process.cwd(), { home })?.seat ?? null; }
    catch (error) { debug.log('tui.msg-wake', 'detect-error', { error: String(error) }); }
  }
  const optedIn = (): boolean => deps.enabled ?? (seat !== null && (
    regularFile(join(home, 'elanous-hq', 'seat-state', seat, 'autowake'))
    || regularFile(join(home, 'elanous-hq', 'seats', seat, 'autowake'))
  ));
  const read = deps.readUnread ?? readUnreadSummary;
  const log = deps.log ?? ((event: string, data: Record<string, unknown>) => debug.log('tui.msg-wake', event, data));
  // OBSERVE-TURN-EVENT-LIFECYCLE — 우편 깨움 관측 주입(기본: debug 직접 방출).
  const turnLifeLog = deps.turnLifeLog ?? emitTurnLife;
  const readBudgetUsage = deps.readBudgetUsage ?? (seat ? defaultBudgetUsage(home, seat, deps.readBudgetLedger) : () => null);
  /** The held batch already reported for this UTC day (one event per batch per day, not one per 15s poll). */
  let budgetHeldKey = '';
  /** A failing budget read is warned once per (UTC day, error), not every 15s poll. */
  let budgetErrorKey = '';
  let lastOpenedId = 0;
  let pendingId = 0;
  /** Messages whose bodies the pending turn carries (agent-sourced turns only). */
  let pendingSeenIds: number[] = [];
  /** The started mail turn: which bodies to mark seen when it answers, and the open mark to restore if it does not. */
  let started: { seenIds: number[]; lastOpenedBefore: number; maxId: number } | null = null;
  /** No-answer back-off for one batch (keyed by its newest id): how many in a row, and the earliest next try. */
  let noAnswer: { maxId: number; count: number; notBefore: number } | null = null;
  const nowMs = deps.now ?? Date.now;
  let stopped = false;
  let retry: { cancel: () => void } | null = null;
  const armRetry = (waitMs?: number): void => {
    if (retry || stopped) return;
    const wait = waitMs ?? deps.retryMs ?? IDLE_MAIL_RETRY_MS;
    const handle = deps.scheduleRetry
      ? deps.scheduleRetry(() => { retry = null; poll(); }, wait)
      : (() => {
        const timer = setTimeout(() => { retry = null; poll(); }, wait);
        timer.unref?.();
        return { cancel: () => clearTimeout(timer) };
      })();
    retry = handle;
  };
  const poll = (): void => {
    // Consent is live state: deleting the file stops reads and turns; recreating it resumes polling.
    if (stopped || !seat || !optedIn()) return;
    let unread: { count: number; maxId: number | null } | null;
    try { unread = read(seat); }
    catch (error) { log('read-error', { seat, error: String(error) }); return; }
    if (!unread || unread.count <= 0 || !unread.maxId || unread.maxId <= lastOpenedId) return;
    // A batch that keeps ending without an answer waits out its back-off; a new message (higher id) starts fresh.
    if (noAnswer && noAnswer.maxId === unread.maxId && nowMs() < noAnswer.notBefore) return;
    // Daily token budget (cost cap): spent → no wake turn; the mail stays unread and is re-judged on every poll, so the
    // next UTC day (used resets) resumes it. Fail-open: an unreadable budget/ledger (null or throw) lets the wake through —
    // this gate only caps cost, a missed wake costs more than a day's overrun, and the failure is logged as a warning.
    let usage: { budget: number; used: number } | null = null;
    try { usage = readBudgetUsage(new Date(nowMs())); }
    catch (error) {
      const key = `${new Date(nowMs()).toISOString().slice(0, 10)}:${String(error)}`;
      if (budgetErrorKey !== key) {
        budgetErrorKey = key;
        log('budget-read-error', { seat, error: String(error) });
      }
    }
    if (usage && usage.used >= usage.budget) {
      const day = new Date(nowMs()).toISOString().slice(0, 10);
      const key = `${unread.maxId}@${day}`;
      if (budgetHeldKey !== key) {
        budgetHeldKey = key;
        log('rejected', { seat, maxId: unread.maxId, count: unread.count, reason: 'token-budget', budget: usage.budget, used: usage.used });
      }
      return;
    }
    // MSG-SOURCE-HIERARCHY: one agent sender (OP …) → the turn is drawn under «⇢ OP · request · due …»; mixed → system.
    let from: MessageSource | undefined;
    let source: UnreadSource | null = null;
    // An injected unread reader (tests · other ledgers) never pairs with the real ledger's source.
    const readSource = deps.readSource ?? (deps.readUnread ? () => null : readUnreadSource);
    try { source = readSource(seat); }
    catch (error) { log('source-read-error', { seat, error: String(error) }); }
    // The two reads must describe the same batch; a message that landed in between → no agent attribution (system).
    if (source && source.latestId === unread.maxId && source.messages.length > 0) from = mailWakeSource(source, deps.formatDue);
    else source = null;
    // OBSERVE-TURN-EVENT-LIFECYCLE — 자리 opt-in 우편 깨움 도착(msgId = 이 묶음의 최신 id; busy 는 문이 판정).
    try { turnLifeLog('turn-life:event-arrived', { source: 'mail-wake', msgId: unread.maxId, arrivedAt: nowMs() }); } catch { /* observability is fail-open */ }
    const result = deps.startTurnIfIdle(
      source ? agentMailTurnText(source) : `[우편 깨움] ${seat} 미읽음 ${unread.count}통 — eln msg list --to ${seat} 로 읽고 처리`,
      { origin: 'msg-wake', reason: `⇢ 우편 ${unread.count}통`, ...(from ? { from } : {}) },
    );
    if (result.opened) {
      pendingId = unread.maxId;
      pendingSeenIds = source ? agentMailTurnBatch(source).messages.map(message => message.id) : [];
      // An injected unread reader (tests) never writes the real ledger.
      (deps.recordDelivered ?? (deps.readUnread ? () => {} : ledgerRecordDelivered()))(seat, unread.maxId, result.turnId);
      log('opened', { seat, maxId: pendingId, count: unread.count, turnId: result.turnId });
    } else if (result.reason === 'NotIdle' || result.reason === 'HumanTyping') {
      // Only a busy door or a person typing is a deferral. Disabled / Cap / Superseded stay on the watch period.
      log('deferred', { seat, maxId: unread.maxId, count: unread.count, reason: result.reason, detail: result.detail ?? null });
      armRetry();
    } else if (result.reason === 'Cap' && result.retryAt !== undefined) {
      // ELN-SEAT-TURN-PACING minimum interval: mail is an outside event — open it once the gap has passed, not 15s later.
      log('deferred', { seat, maxId: unread.maxId, count: unread.count, reason: result.reason, detail: result.detail ?? null, retryAt: result.retryAt });
      armRetry(Math.max(0, result.retryAt - Date.now()));
    } else {
      log('rejected', { seat, maxId: unread.maxId, count: unread.count, reason: result.reason, detail: result.detail ?? null });
    }
  };
  const timer = seat ? setInterval(poll, deps.intervalMs ?? IDLE_MAIL_WATCH_MS) : null;
  timer?.unref?.();
  if (timer) queueMicrotask(poll);
  return {
    poll,
    pendingDeliveryAllowed() { return pendingId === 0 || optedIn(); },
    withdrawPending() { pendingId = 0; pendingSeenIds = []; },
    confirmDelivery() {
      started = { seenIds: pendingSeenIds, lastOpenedBefore: lastOpenedId, maxId: pendingId };
      lastOpenedId = Math.max(lastOpenedId, pendingId);
      pendingId = 0;
      pendingSeenIds = [];
    },
    noteTurnFinished(responded) {
      const turn = started;
      started = null;
      if (!turn) return;
      if (!responded) {
        const count = noAnswer && noAnswer.maxId === turn.maxId ? noAnswer.count + 1 : 1;
        if (count >= MAIL_WAKE_NO_ANSWER_LIMIT) {
          // Give the batch up: keep it marked opened (no more turns for it); the mail stays unread for overdue / fallback.
          noAnswer = null;
          log('gave-up', { seat, maxId: turn.maxId, noAnswerTurns: count });
          try { debug.log('tui.msg-wake', 'gave-up', { seat, maxId: turn.maxId, noAnswerTurns: count }, { level: 'warn' }); } catch { /* fail-open */ }
          return;
        }
        // Not read: restore the open mark so the batch is tried again — after watch × 2^(n-1), not on the next 15s tick.
        lastOpenedId = turn.lastOpenedBefore;
        const waitMs = (deps.intervalMs ?? IDLE_MAIL_WATCH_MS) * 2 ** (count - 1);
        noAnswer = { maxId: turn.maxId, count, notBefore: nowMs() + waitMs };
        log('not-read', { seat, restoredTo: lastOpenedId, noAnswerTurns: count, retryInMs: waitMs });
        return;
      }
      noAnswer = null;
      // The turn answered with those bodies in its context: seen (and compat ack) for exactly them.
      if (seat && turn.seenIds.length > 0) (deps.recordSeen ?? (deps.readUnread ? () => {} : ledgerRecordSeen()))(seat, turn.seenIds);
    },
    dispose() { stopped = true; retry?.cancel(); retry = null; if (timer) clearInterval(timer); },
  };
}
