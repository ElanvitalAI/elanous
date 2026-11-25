import type { LLMToolSpec } from '../llm/tool-spec.js';
import { emitTurnLife } from '../debug/turn-life.js';
import type { NextTuiSelfHealthSnapshot } from '../tui/chat/self-health-status.js';
// ── next TUI 의 자기 예약 깨움 (TUI-NEXT-QUEUE-AND-WAKE · 0.2.36 · 2026-10-22) ──────────────────────
//
// 🚨 무엇을 푸는가: 클래식 대시보드엔 `ScheduleWakeup`(H5) ⊕ 내부 턴 문(H2)이 있는데 next TUI 엔 없었다 —
//   next 에서 모델이 «다음 점검 HH:MM» 이라고 적고 턴을 끝내면 그 시각에 아무것도 안 열린다.
// ⭐ 재구현 0: 스케줄러 = 클래식 `createDashboardWakeupScheduler` · 문 = 클래식 `createInternalTurnGate` ·
//   도구 문면·인자 = 클래식 `buildScheduleWakeupHostTool` 그대로. 바쁘면 미룸(#30291)도 스케줄러 몫 그대로다.
// 새 것은 «한 홉»뿐이다: next 의 턴은 REPL 자식(`elanous repl --stdin-jsonl`)에서 돌아 도구도 자식에서 불린다.
//   스케줄러는 TUI(부모)에 산다 — 자식은 Esc·/new 때 죽으므로 거기 타이머를 두면 예약이 같이 죽는다.
//   ⇒ 자식의 `ScheduleWakeup` 은 Bun IPC(`process.send`)로 부모에 묻고, 부모가 클래식 도구 handler 로 답한다.
//   stdin 은 턴 단위 JSONL 이라 도는 턴 «안»에 답을 실을 수 없다 — IPC 는 턴과 따로 흐른다.
// ⛔ 하니스 자식(`ELANOUS_HARNESS_ROLE`)은 무인 런이라 도구를 안 싣는다(클래식 `registerScheduleWakeupHostTool` 과 같은 경계).
//
// 세 얼굴(클래식과 같다):
//   관측 = debug.log('tui.wakeup', …) · debug.log('tui.autoturn', …) — 스케줄러·문이 이미 남긴다
//   인지 = 예약 시각 도래 ∧ 문 판정(NotIdle · HumanTyping …)
//   힐링 = 문이 열리면 next 가 내부 턴 한 번 · 바쁘면 1분마다 미룸(상한 30분) · 끝내 못 열면 «⏰ 예약 깨움 놓침» 한 줄

import { createInternalTurnGate, formatInternalTurnBanner, isInternalTurnEnabledByEnv, type InternalTurnGate, type InternalTurnRequest } from '../tui/input/internal-turn.js';
import { createNextMailWake, type NextMailWakeDeps } from './next-mail-wake.js';
import { createPulseInboxWatcher } from '../seat/seat-pulse-inbox.js';
import { createSeatRetroScheduler, type SeatRetroScheduler, type SeatRetroStateStore } from '../seat/seat-retro.js';

import type { LLMToolDef, PluginContext } from '../plugins/core/types.js';
import {
  SCHEDULE_WAKEUP_TOOL_NAME,
  buildScheduleWakeupHostTool,
  createDashboardWakeupScheduler,
  createWakeupScheduler,
  type WakeupPersistence,
  type WakeupScheduler,
  type WakeupSchedulerDeps,
  type WakeupTimerHandle,
} from '../skills/tools/schedule-wakeup.js';

/** 부모(next TUI)가 REPL 자식에 «IPC 홉이 열렸다»고 알리는 표지. 없으면 자식은 도구를 안 싣는다. */
export const NEXT_TUI_WAKEUP_IPC_ENV = 'ELANOUS_NEXT_TUI_WAKEUP_IPC';
const CALL_TYPE = 'elanous.wakeup.call';
const RESULT_TYPE = 'elanous.wakeup.result';
const DEFAULT_CALL_TIMEOUT_MS = 15_000;
/**
 * TURN-FIELD-BUG-1: the parent answers within this, always — a slow handler gets an error answer while the child is
 * still waiting (its own wait is {@link DEFAULT_CALL_TIMEOUT_MS}). Source: child wait 15s − 5s margin for IPC delivery.
 */
export const WAKEUP_ANSWER_CAP_MS = 10_000;

export interface WakeupCallMessage {
  type: typeof CALL_TYPE; callId: string; args: Record<string, unknown>;
  /** Child clock when sent (ms) — the parent's `lagMs` (delivery + parent event-loop delay). */
  sentAt?: number;
}
export interface WakeupResultMessage { type: typeof RESULT_TYPE; callId: string; result: unknown }

export function isWakeupCallMessage(message: unknown): message is WakeupCallMessage {
  const m = message as Partial<WakeupCallMessage> | null;
  return !!m && m.type === CALL_TYPE && typeof m.callId === 'string' && !!m.args && typeof m.args === 'object';
}

function isWakeupResultMessage(message: unknown): message is WakeupResultMessage {
  const m = message as Partial<WakeupResultMessage> | null;
  return !!m && m.type === RESULT_TYPE && typeof m.callId === 'string';
}

export interface WakeupAnswerOptions {
  readonly capMs?: number;
  readonly now?: () => number;
  /** `turn-life:wakeup-call-received` · `:wakeup-call-answered` (default emitTurnLife · fail-open). */
  readonly turnLifeLog?: (event: string, data: Record<string, unknown>) => void;
}

/**
 * 부모 쪽: 자식의 호출 한 건을 클래식 도구 handler 로 풀어 답 메시지를 만든다. Never rejects: a throw, a rejection or a
 * handler slower than `capMs` is an error result (TURN-FIELD-BUG-1 — an unanswered call left the child waiting 15s).
 */
export async function answerWakeupCall(tool: LLMToolDef, message: WakeupCallMessage, opts: WakeupAnswerOptions = {}): Promise<WakeupResultMessage> {
  const now = opts.now ?? Date.now;
  const life = (event: string, data: Record<string, unknown>): void => {
    try { (opts.turnLifeLog ?? emitTurnLife)(event, data); } catch { /* observability is fail-open */ }
  };
  const receivedAt = now();
  const lagMs = typeof message.sentAt === 'number' ? Math.max(0, receivedAt - message.sentAt) : null;
  const action = typeof message.args?.action === 'string' ? message.args.action : 'schedule';
  life('turn-life:wakeup-call-received', { callId: message.callId, action, lagMs });
  const capMs = opts.capMs ?? WAKEUP_ANSWER_CAP_MS;
  let outcome: 'ok' | 'error' | 'timeout' = 'ok';
  let result: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // 클래식 handler 는 ctx 를 안 본다 — 대시보드도 같은 handler 를 플러그인 문맥 없이 부른다.
    const capped = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), capMs); });
    const raced = await Promise.race([Promise.resolve().then(() => tool.handler(message.args, {} as PluginContext)), capped]);
    if (raced === 'timeout') {
      outcome = 'timeout';
      result = { error: `${SCHEDULE_WAKEUP_TOOL_NAME}: the TUI did not finish within ${capMs}ms — run action:'list' before retrying (it may still be scheduled)` };
    } else {
      result = raced;
      if (result && typeof result === 'object' && 'error' in result) outcome = 'error';
    }
  } catch (error) {
    outcome = 'error';
    result = { error: `ScheduleWakeup failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  life('turn-life:wakeup-call-answered', { callId: message.callId, action, result: outcome, ms: now() - receivedAt, lagMs });
  return { type: RESULT_TYPE, callId: message.callId, result };
}

/** The parent's IPC branch: answer, and send — every path sends exactly one reply (a send failure = the child exited). */
export function replyToWakeupCall(tool: LLMToolDef, message: WakeupCallMessage, send: (reply: WakeupResultMessage) => unknown,
  opts: WakeupAnswerOptions = {}): Promise<void> {
  const fallback = (error: unknown): WakeupResultMessage => ({ type: RESULT_TYPE, callId: message.callId,
    result: { error: `ScheduleWakeup failed: ${error instanceof Error ? error.message : String(error)}` } });
  let answered: Promise<WakeupResultMessage>;
  try { answered = answerWakeupCall(tool, message, opts); } catch (error) { answered = Promise.resolve(fallback(error)); }
  return answered.catch(fallback).then((reply) => {
    try { send(reply); } catch { /* the child exited mid-call; its dispatch times out */ }
  });
}

/** 자식이 쓰는 IPC 구멍 — `process` 의 그 부분만(시험이 같은 함수에 가짜를 넘긴다). */
export interface WakeupIpcProcess {
  send?: (message: unknown) => boolean | void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  off(event: 'message', listener: (message: unknown) => void): unknown;
}

/** 도구 문면만 꺼내는 데 쓰는 스케줄러 — handler 는 자식에서 불리지 않는다(부모가 진짜를 부른다). */
const SPEC_ONLY_SCHEDULER: WakeupScheduler = createWakeupScheduler({
  startTurnIfIdle: () => ({ opened: false, reason: 'Disabled' }),
  log: () => {},
});

/**
 * 자식(REPL) 쪽: 부모가 홉을 열었을 때만(`NEXT_TUI_WAKEUP_IPC_ENV=1` ∧ `process.send`) 클래식 `ScheduleWakeup`
 * 문면 그대로의 도구 하나를 낸다. dispatch 는 부모에 묻고 답을 그대로 돌려준다 — 부모가 안 답하면 오류 결과.
 */
export function createReplWakeupTool(
  proc: WakeupIpcProcess,
  env: NodeJS.ProcessEnv = process.env,
  opts: { timeoutMs?: number } = {},
): { spec: LLMToolSpec; dispatch: (args: Record<string, unknown>) => Promise<unknown> } | null {
  if (env[NEXT_TUI_WAKEUP_IPC_ENV] !== '1' || typeof proc.send !== 'function') return null;
  const send = proc.send.bind(proc);
  const { name, description, parameters } = buildScheduleWakeupHostTool(SPEC_ONLY_SCHEDULER);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const waiting = new Map<string, (result: unknown) => void>();
  /** callId → when it timed out: a reply after that is late (the wakeup may exist although the model saw an error). */
  const timedOut = new Map<string, number>();
  let seq = 0;
  const listener = (message: unknown): void => {
    if (!isWakeupResultMessage(message)) return;
    const resolve = waiting.get(message.callId);
    if (!resolve) {
      const at = timedOut.get(message.callId);
      if (at !== undefined) {
        timedOut.delete(message.callId);
        emitTurnLife('turn-life:wakeup-call-late', { callId: message.callId, lateMs: Date.now() - at,
          result: message.result && typeof message.result === 'object' && 'error' in message.result ? 'error' : 'ok' });
      }
      return;
    }
    waiting.delete(message.callId);
    resolve(message.result);
  };
  proc.on('message', listener);
  return {
    spec: { name, description, parameters },
    dispatch: (args) => new Promise<unknown>((resolve) => {
      const callId = `c${++seq}`;
      const timer = setTimeout(() => {
        if (!waiting.delete(callId)) return;
        timedOut.set(callId, Date.now());
        resolve({ error: `${SCHEDULE_WAKEUP_TOOL_NAME}: next TUI did not answer within ${timeoutMs}ms — it may still schedule this; run action:'list' before retrying` });
      }, timeoutMs);
      waiting.set(callId, (result) => { clearTimeout(timer); resolve(result); });
      try {
        send({ type: CALL_TYPE, callId, args, sentAt: Date.now() } satisfies WakeupCallMessage);
      } catch (error) {
        waiting.delete(callId);
        clearTimeout(timer);
        resolve({ error: `${SCHEDULE_WAKEUP_TOOL_NAME}: IPC send failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }),
  };
}

/** How long a parked turn waits for the input loop to take it before it is withdrawn. */
export const SEAT_CAP_START_WAIT_MS = 2_000;

export interface NextTuiWakeupDeps {
  /** next 의 `busy`(채팅 턴·압축·provider·harness 명령 중). */
  isTurnRunning: () => boolean;
  /** ELN-SEAT-TURN-PACING — rest between automatic turns (entry passes `turnPacingFromEnv()`; absent = unpaced). */
  pacing?: import('../tui/input/internal-turn.js').TurnPacing;
  /** 입력칸이 실제로 앞에 있는가; 로그·파일 선택·사이드탭 위로 자동 턴이 끼어들지 않는다. */
  isInputForeground?: () => boolean;
  /** 자리 opt-in(`autowake`) 우편은 외부 pane 입력 대신 이 H2 문으로 받는다. */
  enableSeatMailWake?: boolean;
  /** Isolated mail source for the opt-in revocation race test. */
  mailWakeOptions?: Omit<NextMailWakeDeps, 'startTurnIfIdle'>;
  /** 입력칸 글 — 비어 있지 않으면 문이 HumanTyping 으로 거부한다. */
  getBufferText: () => string;
  /** 턴 중 쌓인 대기 제출 수 — 있으면 사람 몫이 먼저다(HumanTyping). */
  getQueuedCount: () => number;
  /** 문이 열렸을 때 입력 루프를 깨운다(next 는 감시 키 하나를 넣는다). true = 깨웠다. */
  requestYield: () => boolean;
  /** 화면 한 줄(⏰ 예약 깨움 … · 놓침). */
  notify: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => WakeupTimerHandle;
  clearTimer?: (handle: WakeupTimerHandle) => void;
  lastHumanKeyAt?: () => number;
  pendingKeyCount?: () => number;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
  /** OBSERVE-TURN-EVENT-LIFECYCLE — turn-life observation hook (fail-open). */
  turnLifeLog?: (event: string, data: Record<string, unknown>) => void;
  /** 세션 파일 영속(재기동 복원). 하니스 자식(무인 런)은 받아도 쓰지 않는다 — 도구도 싣지 않는다. */
  persist?: WakeupPersistence;
  /** TURN-CAPSULE-EVENTS R1(C4) — 버스 원천 어댑터(schedule-wakeup.ts:219) 포워드. 없으면 옛길(스케줄러 자체 큐) 그대로. 생산 배선은 entry.ts 몫. */
  publishEvent?: WakeupSchedulerDeps['publishEvent'];
  /** WAKE-FOLD-IDEMPOTENT ③ — the next turn's inbox (a queued notice): past-due wakes busy-refused 10 min land here once. */
  deliverQueued?: WakeupSchedulerDeps['deliverQueued'];
  /** Built-in self-retro (SEAT-ROLE-CARD device 2): opens an origin-'retro' turn on this same door every `intervalMin` minutes. 0 = off. */
  retro?: { readonly seat: string; readonly intervalMin: number; readonly store: SeatRetroStateStore; readonly metrics?: () => readonly string[] };
  /** OP-PULSE: the pulse inbox this seat (OP) opens as origin-'pulse' turns on this same door. Absent = off. */
  pulse?: { readonly inboxPath: string; readonly consumedPath: string };
  /** OP-INBOX-PULSE-BATCH: a pulse turn opened (the held OP mail batch is due). */
  onPulseOpened?: () => void;
}

export interface NextTuiWakeup {
  readonly gate: InternalTurnGate;
  readonly scheduler: WakeupScheduler;
  /** The retro scheduler when one was requested for this seat (state is readable for supervision). */
  readonly retro: SeatRetroScheduler | null;
  /** REPL 자식이 부를 도구(부모 handler) — 하니스 자식이면 null. */
  readonly tool: LLMToolDef | null;
  /** Read-only header projection; no scheduler or health observation is changed. */
  headline(health: NextTuiSelfHealthSnapshot | null): string;
  banner(request: Pick<InternalTurnRequest, 'origin' | 'reason'>): string;
  /** 키 큐에서 홉을 꺼낼 때 다시 확인한다. 판정 뒤 사람이 포커스·초안·대기 제출을 바꿀 수 있다. */
  takePendingIfIdle(): InternalTurnRequest | null;
  /**
   * ELN-TURN-CAP-CONTINUE-STALL (③): the seat-cap continue parked `turnId`. Resolve true once the
   * input loop takes it, false (and withdraw it) if it is still pending when the wait ends.
   */
  confirmSeatCapTurnStarted(turnId: string): Promise<boolean>;
  /** A turn ended: whether it produced any answer. Lets a mail turn mark seen only after it answered (#38203 REVIEW-1 ①). */
  noteTurnFinished(responded: boolean): void;
  dispose(): void;
}

/** next TUI 에 클래식 문 ⊕ 클래식 스케줄러를 잇는다. */
export function createNextTuiWakeup(deps: NextTuiWakeupDeps): NextTuiWakeup {
  const env = deps.env ?? process.env;
  const acceleratedTestClock = env.ELANOUS_TEST_FAKE_LLM === '1'
    && env.ELANOUS_TEST_FAST_WAKEUP_CLOCK === '1';
  // OBSERVE-TURN-EVENT-LIFECYCLE — next 문·스케줄러 관측 주입(기본: debug 직접 방출).
  const turnLifeLog = deps.turnLifeLog ?? emitTurnLife;
  const gate = createInternalTurnGate({
    isTurnRunning: deps.isTurnRunning,
    ...(deps.isInputForeground ? { isInputForeground: deps.isInputForeground } : {}),
    getBufferText: deps.getBufferText,
    getTypeaheadCount: deps.getQueuedCount,
    isEnabled: () => isInternalTurnEnabledByEnv(env),
    ...(deps.now ? { now: deps.now } : {}),
    // The test clock advances scheduler time while lastHumanKeyAt is a real wall-clock value.
    // Keep the busy-turn deferral under test without waiting out the production 10s quiet window.
    ...(acceleratedTestClock ? { humanQuietMs: 0 } : {}),
    ...(deps.lastHumanKeyAt ? { lastHumanKeyAt: deps.lastHumanKeyAt } : {}),
    ...(deps.pendingKeyCount ? { pendingKeyCount: deps.pendingKeyCount } : {}),
    ...(deps.log ? { log: deps.log } : {}),
    turnLifeLog,
    ...(deps.pacing ? { pacing: deps.pacing } : {}),
  });
  gate.port.attach(deps.requestYield);
  const scheduler = createDashboardWakeupScheduler(gate, {
    notify: deps.notify,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
    ...(deps.clearTimer ? { clearTimer: deps.clearTimer } : {}),
    ...(deps.log ? { log: deps.log } : {}),
    ...(deps.publishEvent ? { publishEvent: deps.publishEvent } : {}),
    ...(deps.deliverQueued ? { deliverQueued: deps.deliverQueued } : {}),
    ...(deps.persist && !env.ELANOUS_HARNESS_ROLE?.trim() ? { persist: deps.persist } : {}),
  });
  const tool = env.ELANOUS_HARNESS_ROLE?.trim() ? null : buildScheduleWakeupHostTool(scheduler);
  const seatCapWaiters = new Map<string, (started: boolean) => void>();
  const settleSeatCap = (turnId: string, started: boolean): void => {
    const resolve = seatCapWaiters.get(turnId);
    if (!resolve) return;
    seatCapWaiters.delete(turnId);
    resolve(started);
  };
  /** True once the input loop took the parked turn; a turn it never takes within the wait is withdrawn and reported false. */
  const confirmTurnStarted = (turnId: string): Promise<boolean> => {
    if (gate.pendingTurnId() !== turnId) return Promise.resolve(true);
    // The wait uses the injected clock (a fake clock in tests), like the retro timer itself.
    const setT = deps.setTimer ?? ((fn: () => void, ms: number): WakeupTimerHandle => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t; });
    const clearT = deps.clearTimer ?? ((handle: WakeupTimerHandle): void => clearTimeout(handle as ReturnType<typeof setTimeout>));
    return new Promise<boolean>((resolve) => {
      const timer = setT(() => {
        seatCapWaiters.delete(turnId);
        if (gate.pendingTurnId() === turnId) gate.withdrawPendingTurn(turnId);
        resolve(false);
      }, SEAT_CAP_START_WAIT_MS);
      seatCapWaiters.set(turnId, (started) => { clearT(timer); resolve(started); });
    });
  };
  const retro = deps.retro && deps.retro.intervalMin > 0 && !env.ELANOUS_HARNESS_ROLE?.trim()
    ? createSeatRetroScheduler({
      seat: deps.retro.seat, intervalMin: deps.retro.intervalMin, store: deps.retro.store,
      now: deps.now ?? Date.now,
      setTimer: deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t; }),
      clearTimer: deps.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>)),
      startTurnIfIdle: (text, opts) => gate.startTurnIfIdle(text, opts),
      confirmStarted: confirmTurnStarted,
      ...(deps.retro.metrics ? { metrics: deps.retro.metrics } : {}),
      notify: deps.notify,
      ...(deps.log ? { log: (event: string, data: Record<string, unknown>) => deps.log!('tui.retro', event, data) } : {}),
    }) : null;
  retro?.start();
  const pulse = deps.pulse && !env.ELANOUS_HARNESS_ROLE?.trim()
    ? createPulseInboxWatcher({ inboxPath: deps.pulse.inboxPath, consumedPath: deps.pulse.consumedPath,
      startTurnIfIdle: (text, opts) => { const r = gate.startTurnIfIdle(text, opts); if (r.opened) deps.onPulseOpened?.(); return r; },
      setTimer: (fn, ms) => (deps.setTimer ?? ((f: () => void, m: number): WakeupTimerHandle => { const t = setTimeout(f, m); (t as { unref?: () => void }).unref?.(); return t; }))(fn, ms),
      clearTimer: (handle) => (deps.clearTimer ?? ((h: WakeupTimerHandle): void => clearTimeout(h as ReturnType<typeof setTimeout>)))(handle as WakeupTimerHandle),
      notify: deps.notify,
      ...(deps.log ? { log: (event: string, data: Record<string, unknown>) => deps.log!('tui.pulse', event, data) } : {}) }) : null;
  pulse?.start();
  const mailWake = deps.enableSeatMailWake && !env.ELANOUS_HARNESS_ROLE?.trim()
    ? createNextMailWake({ ...deps.mailWakeOptions, startTurnIfIdle: (text, opts) => gate.startTurnIfIdle(text, opts),
      intervalMs: deps.mailWakeOptions?.intervalMs ?? (acceleratedTestClock ? 1_000 : undefined) }) : null;
  return {
    gate,
    scheduler,
    retro,
    tool,
    headline(health) {
      const healthText = health === null ? 'health pending'
        : health.errorCount === null ? 'health unknown'
          : health.errorCount === 0 ? 'healthy' : `health errors ${health.errorCount}`;
      const next = scheduler.list()[0];
      const wakeText = next
        ? `next wake ${new Date(next.dueAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })}`
        : 'no wake scheduled';
      return `${healthText} · ${wakeText}`;
    },
    banner: formatInternalTurnBanner,
    takePendingIfIdle() {
      if (mailWake && !mailWake.pendingDeliveryAllowed()) {
        gate.port.declined?.('mail-opt-in-revoked');
        mailWake.withdrawPending();
        return null;
      }
      const detail = deps.isTurnRunning() ? 'turn-running'
        : deps.getBufferText().length > 0 ? 'buffer'
        : deps.pendingKeyCount && deps.pendingKeyCount() > 0 ? 'unread-keys'
        : deps.getQueuedCount() > 0 ? 'typeahead'
        : deps.isInputForeground && !deps.isInputForeground() ? 'input-not-foreground' : null;
      if (detail) {
        gate.port.declined?.(detail);
        mailWake?.withdrawPending();
        return null;
      }
      const request = gate.takePending();
      // OBSERVE-TURN-EVENT-LIFECYCLE — 문에서 꺼낸 내부 턴(enqueue 시각이 없어 waitMs 생략 · boundary idle).
      if (request !== null) { try { turnLifeLog('turn-life:event-dequeued', { itemId: request.turnId, source: request.origin, boundary: 'idle' }); } catch { /* observability is fail-open */ } }
      if (request?.origin === 'msg-wake') mailWake?.confirmDelivery();
      if (request) settleSeatCap(request.turnId, true);
      return request;
    },
    confirmSeatCapTurnStarted: confirmTurnStarted,
    noteTurnFinished(responded) {
      mailWake?.noteTurnFinished(responded);
    },
    dispose() {
      mailWake?.dispose();
      retro?.dispose();
      pulse?.dispose();
      scheduler.dispose();
      gate.port.detach({ yielded: true });
    },
  };
}

// ── 부모 쪽 홉 등록 — local-chat-turn 이 REPL 자식을 띄울 때 읽는다 ─────────────────────────────

let activeWakeupTool: LLMToolDef | null = null;

/** next TUI 가 부팅 때 자기 도구를 건다(끝날 때 null). 이후 띄우는 REPL 자식에만 홉이 열린다. */
export function setNextTuiWakeupTool(tool: LLMToolDef | null): void {
  activeWakeupTool = tool;
}

export function nextTuiWakeupTool(): LLMToolDef | null {
  return activeWakeupTool;
}
