import type { LLMToolSpec } from '../llm/tool-spec.js';
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

import type { LLMToolDef, PluginContext } from '../plugins/core/types.js';
import {
  SCHEDULE_WAKEUP_TOOL_NAME,
  buildScheduleWakeupHostTool,
  createDashboardWakeupScheduler,
  createWakeupScheduler,
  type WakeupScheduler,
  type WakeupTimerHandle,
} from '../skills/tools/schedule-wakeup.js';

/** 부모(next TUI)가 REPL 자식에 «IPC 홉이 열렸다»고 알리는 표지. 없으면 자식은 도구를 안 싣는다. */
export const NEXT_TUI_WAKEUP_IPC_ENV = 'ELANOUS_NEXT_TUI_WAKEUP_IPC';
const CALL_TYPE = 'elanous.wakeup.call';
const RESULT_TYPE = 'elanous.wakeup.result';
const DEFAULT_CALL_TIMEOUT_MS = 15_000;

export interface WakeupCallMessage { type: typeof CALL_TYPE; callId: string; args: Record<string, unknown> }
export interface WakeupResultMessage { type: typeof RESULT_TYPE; callId: string; result: unknown }

export function isWakeupCallMessage(message: unknown): message is WakeupCallMessage {
  const m = message as Partial<WakeupCallMessage> | null;
  return !!m && m.type === CALL_TYPE && typeof m.callId === 'string' && !!m.args && typeof m.args === 'object';
}

function isWakeupResultMessage(message: unknown): message is WakeupResultMessage {
  const m = message as Partial<WakeupResultMessage> | null;
  return !!m && m.type === RESULT_TYPE && typeof m.callId === 'string';
}

/** 부모 쪽: 자식의 호출 한 건을 클래식 도구 handler 로 풀어 답 메시지를 만든다(던지면 오류 결과). */
export async function answerWakeupCall(tool: LLMToolDef, message: WakeupCallMessage): Promise<WakeupResultMessage> {
  let result: unknown;
  try {
    // 클래식 handler 는 ctx 를 안 본다 — 대시보드도 같은 handler 를 플러그인 문맥 없이 부른다.
    result = await tool.handler(message.args, {} as PluginContext);
  } catch (error) {
    result = { error: `ScheduleWakeup failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { type: RESULT_TYPE, callId: message.callId, result };
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
  let seq = 0;
  const listener = (message: unknown): void => {
    if (!isWakeupResultMessage(message)) return;
    const resolve = waiting.get(message.callId);
    if (!resolve) return;
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
        resolve({ error: `${SCHEDULE_WAKEUP_TOOL_NAME}: next TUI did not answer` });
      }, timeoutMs);
      waiting.set(callId, (result) => { clearTimeout(timer); resolve(result); });
      try {
        send({ type: CALL_TYPE, callId, args } satisfies WakeupCallMessage);
      } catch (error) {
        waiting.delete(callId);
        clearTimeout(timer);
        resolve({ error: `${SCHEDULE_WAKEUP_TOOL_NAME}: IPC send failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }),
  };
}

export interface NextTuiWakeupDeps {
  /** next 의 `busy`(채팅 턴·압축·provider·harness 명령 중). */
  isTurnRunning: () => boolean;
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
}

export interface NextTuiWakeup {
  readonly gate: InternalTurnGate;
  readonly scheduler: WakeupScheduler;
  /** REPL 자식이 부를 도구(부모 handler) — 하니스 자식이면 null. */
  readonly tool: LLMToolDef | null;
  banner(request: Pick<InternalTurnRequest, 'origin' | 'reason'>): string;
  /** 키 큐에서 홉을 꺼낼 때 다시 확인한다. 판정 뒤 사람이 포커스·초안·대기 제출을 바꿀 수 있다. */
  takePendingIfIdle(): InternalTurnRequest | null;
  dispose(): void;
}

/** next TUI 에 클래식 문 ⊕ 클래식 스케줄러를 잇는다. */
export function createNextTuiWakeup(deps: NextTuiWakeupDeps): NextTuiWakeup {
  const env = deps.env ?? process.env;
  const acceleratedTestClock = env.ELANOUS_TEST_FAKE_LLM === '1'
    && env.ELANOUS_TEST_FAST_WAKEUP_CLOCK === '1';
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
  });
  gate.port.attach(deps.requestYield);
  const scheduler = createDashboardWakeupScheduler(gate, {
    notify: deps.notify,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
    ...(deps.clearTimer ? { clearTimer: deps.clearTimer } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  });
  const tool = env.ELANOUS_HARNESS_ROLE?.trim() ? null : buildScheduleWakeupHostTool(scheduler);
  const mailWake = deps.enableSeatMailWake && !env.ELANOUS_HARNESS_ROLE?.trim()
    ? createNextMailWake({ ...deps.mailWakeOptions, startTurnIfIdle: (text, opts) => gate.startTurnIfIdle(text, opts),
      intervalMs: deps.mailWakeOptions?.intervalMs ?? (acceleratedTestClock ? 1_000 : undefined) }) : null;
  return {
    gate,
    scheduler,
    tool,
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
      if (request?.origin === 'msg-wake') mailWake?.confirmDelivery();
      return request;
    },
    dispose() {
      mailWake?.dispose();
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
