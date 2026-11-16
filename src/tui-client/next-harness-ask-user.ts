/** One bounded interview round between the sticky REPL child and its owning Next TUI. */
import { randomUUID } from 'node:crypto';
export const HARNESS_ASK_USER_IPC_ENV = 'ELANOUS_NEXT_TUI_HARNESS_ASK_USER_IPC';
export const HARNESS_ASK_USER_TIMEOUT_MS = 5 * 60_000;
const REQUEST = 'elanous.harness-ask-user.call';
const RESULT = 'elanous.harness-ask-user.result';
const CANCEL = 'elanous.harness-ask-user.cancel';

export interface HarnessAskUserRound {
  readonly questions: readonly string[];
  readonly assumptions: readonly string[];
}
export interface HarnessAskUserCall {
  readonly type: typeof REQUEST;
  readonly callId: string;
  readonly sessionId: string;
  readonly round: HarnessAskUserRound;
}
export interface HarnessAskUserResult {
  readonly type: typeof RESULT;
  readonly callId: string;
  readonly sessionId: string;
  readonly answer: string | null;
}
export interface HarnessAskUserCancel {
  readonly type: typeof CANCEL;
  readonly callId: string;
  readonly sessionId: string;
  readonly reason: 'timeout' | 'turn-cancelled' | 'host-cancelled';
}
export interface HarnessAskUserIpcProcess {
  send?: (message: unknown) => boolean | void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  off(event: 'message', listener: (message: unknown) => void): unknown;
}

const clean = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= max
  && !/[\x00-\x1f\x7f]/u.test(value);
const cleanAnswer = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= 8192
  && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value);

/** A model supplies wording only. The host owns call/session identity and answer routing. */
export function parseHarnessAskUserRound(value: unknown): HarnessAskUserRound | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!Object.keys(raw).every(key => key === 'questions' || key === 'assumptions')) return null;
  if (!Array.isArray(raw.questions) || raw.questions.length < 1 || raw.questions.length > 2
    || !raw.questions.every(question => clean(question, 512))) return null;
  if (!Array.isArray(raw.assumptions) || raw.assumptions.length > 5
    || !raw.assumptions.every(assumption => clean(assumption, 256))) return null;
  return { questions: [...raw.questions], assumptions: [...raw.assumptions] };
}

export function isHarnessAskUserCall(value: unknown): value is HarnessAskUserCall {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.type === REQUEST && typeof row.callId === 'string' && /^h[0-9a-f-]{36}$/u.test(row.callId)
    && typeof row.sessionId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(row.sessionId)
    && parseHarnessAskUserRound(row.round) !== null;
}
export function isHarnessAskUserResult(value: unknown): value is HarnessAskUserResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.type === RESULT && typeof row.callId === 'string' && typeof row.sessionId === 'string'
    && (row.answer === null || cleanAnswer(row.answer));
}
export function isHarnessAskUserCancel(value: unknown): value is HarnessAskUserCancel {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.type === CANCEL && typeof row.callId === 'string' && typeof row.sessionId === 'string'
    && (row.reason === 'timeout' || row.reason === 'turn-cancelled' || row.reason === 'host-cancelled');
}

/** Missing IPC and every invalid, late or foreign-session response settle without an answer. */
export function createReplHarnessAsker(proc: HarnessAskUserIpcProcess, sessionId: string,
  env: NodeJS.ProcessEnv = process.env, timeoutMs = HARNESS_ASK_USER_TIMEOUT_MS,
): ((round: HarnessAskUserRound, signal?: AbortSignal) => Promise<string | null>) | null {
  if (env[HARNESS_ASK_USER_IPC_ENV] !== '1' || typeof proc.send !== 'function'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(sessionId)) return null;
  const send = proc.send.bind(proc);
  const pending = new Map<string, (answer: string | null) => void>();
  proc.on('message', (value) => {
    if (!isHarnessAskUserResult(value) || value.sessionId !== sessionId) return;
    pending.get(value.callId)?.(value.answer);
  });
  return (round, signal) => new Promise<string | null>((resolve) => {
    if (!parseHarnessAskUserRound(round) || signal?.aborted) { resolve(null); return; }
    const callId = `h${randomUUID()}`;
    const finish = (answer: string | null, reason?: HarnessAskUserCancel['reason']) => {
      if (!pending.delete(callId)) return;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (reason) try { send({ type: CANCEL, callId, sessionId, reason } satisfies HarnessAskUserCancel); } catch { /* child exit */ }
      resolve(answer);
    };
    const onAbort = () => finish(null, 'turn-cancelled');
    const timer = setTimeout(() => finish(null, 'timeout'), timeoutMs);
    pending.set(callId, finish);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    try { send({ type: REQUEST, callId, sessionId, round } satisfies HarnessAskUserCall); }
    catch { finish(null); }
  });
}

export async function answerHarnessAskUserCall(handler: ((call: HarnessAskUserCall) => Promise<string | null>) | null,
  call: HarnessAskUserCall): Promise<HarnessAskUserResult> {
  let answer: string | null = null;
  try { answer = handler ? await handler(call) : null; } catch { /* fail closed */ }
  return { type: RESULT, callId: call.callId, sessionId: call.sessionId,
    answer: cleanAnswer(answer) ? answer : null };
}
