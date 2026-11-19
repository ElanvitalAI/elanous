/** Human confirmation bridge for Bash calls made by the Next TUI's REPL child. */
import { isPotentiallyDestructiveShellCommand } from '../cli/shell-confirmation-policy.js';
import { isPublicApprovalUrl } from '../tui/publish-approval-session.js';
import { APPROVAL_APPROVED, APPROVAL_DECLINED, isApprovalHold, normalizeApproval, type ApprovalHoldReason, type ApprovalOutcome } from '../graph-runner/approval-outcome.js';

export const NEXT_TUI_SHELL_APPROVAL_IPC_ENV = 'ELANOUS_NEXT_TUI_SHELL_APPROVAL_IPC';
export const NEXT_TUI_SHELL_APPROVAL_TIMEOUT_MS = 5 * 60_000;
/** Longest per-request window a child may ask the host for (the owner publish-approval window). */
export const NEXT_TUI_SHELL_APPROVAL_MAX_WINDOW_MS = 15 * 60_000;
const CALL_TYPE = 'elanous.shell-approval.call';
const RESULT_TYPE = 'elanous.shell-approval.result';
export const SHELL_APPROVAL_CANCEL_TYPE = 'elanous.shell-approval.cancel';

export interface ShellApprovalCallMessage {
  readonly type: typeof CALL_TYPE;
  readonly callId: string;
  readonly command: string;
  readonly kind?: 'bash' | 'graph';
  /** How long the child will wait for this request; the host sizes its own prompt timer to it (capped). */
  readonly windowMs?: number;
  /** A public owner-approval URL, structured so the host can show its own screen instead of a text prompt (`command` still carries the plain sentence as a fallback). */
  readonly publish?: PublishApprovalCall;
}

export interface PublishApprovalCall { readonly url: string; readonly expiresAt: string }

export interface ShellApprovalResultMessage {
  readonly type: typeof RESULT_TYPE;
  readonly callId: string;
  readonly approved: boolean;
  /** With approved=false: why nobody decided. Absent = the owner (or an explicit deny) said no. */
  readonly reason?: ApprovalHoldReason;
}

export interface ShellApprovalCancelMessage {
  readonly type: typeof SHELL_APPROVAL_CANCEL_TYPE;
  readonly callId: string;
  readonly reason: 'timeout' | 'turn-cancelled' | 'host-cancelled';
}

export interface ShellApprovalIpcProcess {
  send?: (message: unknown) => boolean | void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  off(event: 'message', listener: (message: unknown) => void): unknown;
}

export type ShellApprovalKey = 'up' | 'down' | 'y' | 'n' | 'enter' | 'return' | 'escape' | string;
export function applyShellApprovalKey(
  key: ShellApprovalKey,
  modifiers: { readonly ctrl?: boolean; readonly shift?: boolean; readonly alt?: boolean; readonly meta?: boolean; readonly kind?: 'press' | 'repeat' | 'release' } = {},
): { readonly kind: 'pending' } | { readonly kind: 'settled'; readonly approved: boolean } {
  if (key === 'up' || key === 'down') return { kind: 'pending' };
  if (key === 'y' && !modifiers.ctrl && !modifiers.shift && !modifiers.alt && !modifiers.meta && modifiers.kind !== 'repeat' && modifiers.kind !== 'release') {
    return { kind: 'settled', approved: true };
  }
  if (key === 'n' || key === 'escape' || key === 'enter' || key === 'return') return { kind: 'settled', approved: false };
  return { kind: 'pending' };
}

export function isShellApprovalCallMessage(value: unknown): value is ShellApprovalCallMessage {
  const message = value as Partial<ShellApprovalCallMessage> | null;
  return !!message && message.type === CALL_TYPE && typeof message.callId === 'string'
    && typeof message.command === 'string';
}

function isShellApprovalResultMessage(value: unknown): value is ShellApprovalResultMessage {
  const message = value as Partial<ShellApprovalResultMessage> | null;
  return !!message && message.type === RESULT_TYPE && typeof message.callId === 'string'
    && typeof message.approved === 'boolean'
    && (message.reason === undefined || HOLD_REASONS.has(message.reason));
}

const HOLD_REASONS: ReadonlySet<string> = new Set(['timeout', 'turn-cancelled', 'host-cancelled', 'unavailable']);

export function isShellApprovalCancelMessage(value: unknown): value is ShellApprovalCancelMessage {
  const message = value as Partial<ShellApprovalCancelMessage> | null;
  return !!message && message.type === SHELL_APPROVAL_CANCEL_TYPE && typeof message.callId === 'string'
    && (message.reason === 'timeout' || message.reason === 'turn-cancelled' || message.reason === 'host-cancelled');
}

/** REPL-side request. Missing IPC, timeout, malformed replies, and send failures all deny. */
export function createReplShellApprover(
  proc: ShellApprovalIpcProcess,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = NEXT_TUI_SHELL_APPROVAL_TIMEOUT_MS,
): ((command: string, signal?: AbortSignal) => Promise<boolean>) | null {
  const approve = createReplApprover(proc, env, timeoutMs, 'bash');
  return approve === null ? null : async (command, signal) => (await approve(command, signal)).approved;
}

export function createReplGraphApprover(
  proc: ShellApprovalIpcProcess,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = NEXT_TUI_SHELL_APPROVAL_TIMEOUT_MS,
): ((prompt: string, signal?: AbortSignal, options?: { readonly timeoutMs?: number }) => Promise<ApprovalOutcome>) | null {
  const approve = createReplApprover(proc, env, timeoutMs, 'graph');
  return approve === null ? null : (prompt, signal, options) => approve(prompt, signal, undefined, options?.timeoutMs);
}

/** REPL-side request for the owner publish-approval screen: resolves true once the owner has seen the URL and chosen to wait for the decision. */
export function createReplPublishApprover(
  proc: ShellApprovalIpcProcess,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = NEXT_TUI_SHELL_APPROVAL_TIMEOUT_MS,
): ((url: string, expiresAt: string, fallbackPrompt: string, signal?: AbortSignal) => Promise<boolean>) | null {
  const approve = createReplApprover(proc, env, timeoutMs, 'graph');
  return approve === null ? null : async (url, expiresAt, fallbackPrompt, signal) => (await approve(fallbackPrompt, signal, { url, expiresAt })).approved;
}

function createReplApprover(
  proc: ShellApprovalIpcProcess,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  kind: 'bash' | 'graph',
): ((command: string, signal?: AbortSignal, publish?: PublishApprovalCall, windowMs?: number) => Promise<ApprovalOutcome>) | null {
  if (env[NEXT_TUI_SHELL_APPROVAL_IPC_ENV] !== '1' || typeof proc.send !== 'function') return null;
  const send = proc.send.bind(proc);
  const waiting = new Map<string, (outcome: ApprovalOutcome, echo?: ShellApprovalCancelMessage['reason']) => void>();
  let seq = 0;
  const listener = (message: unknown): void => {
    if (isShellApprovalCancelMessage(message)) {
      // A cancel from the host means no one decided; it is never an owner refusal.
      waiting.get(message.callId)?.({ approved: false, reason: message.reason satisfies ApprovalHoldReason });
      return;
    }
    if (!isShellApprovalResultMessage(message)) return;
    waiting.get(message.callId)?.(message.approved ? APPROVAL_APPROVED
      : message.reason ? { approved: false, reason: message.reason } : APPROVAL_DECLINED);
  };
  proc.on('message', listener);
  return (command, signal, publish, windowMs) => new Promise<ApprovalOutcome>((resolve) => {
    if (signal?.aborted) { resolve({ approved: false, reason: 'turn-cancelled' }); return; }
    // A publish request has its own id space: it runs beside the graph approver, whose ids start with «g».
    const callId = `${publish ? 'p' : kind === 'graph' ? 'g' : 's'}${++seq}`;
    const finish = (outcome: ApprovalOutcome, echo?: ShellApprovalCancelMessage['reason']): void => {
      if (!waiting.delete(callId)) return;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (echo) {
        try { send({ type: SHELL_APPROVAL_CANCEL_TYPE, callId, reason: echo } satisfies ShellApprovalCancelMessage); }
        catch { /* the host may already be closing */ }
      }
      resolve(outcome);
    };
    const onAbort = (): void => finish({ approved: false, reason: 'turn-cancelled' }, 'turn-cancelled');
    const timer = setTimeout(() => finish({ approved: false, reason: 'timeout' }, 'timeout'), windowMs ?? timeoutMs);
    waiting.set(callId, finish);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    try {
      send({ type: CALL_TYPE, callId, command, kind, ...(publish ? { publish } : {}),
        ...(windowMs === undefined ? {} : { windowMs }) } satisfies ShellApprovalCallMessage);
    } catch {
      finish({ approved: false, reason: 'unavailable' });
    }
  });
}

/** The structured URL of a publish-approval call, or null when the message has none (or it is not a plain public https URL). */
export function publishApprovalOf(message: ShellApprovalCallMessage): PublishApprovalCall | null {
  const publish = (message as { publish?: unknown }).publish as Partial<PublishApprovalCall> | undefined;
  if (!publish || typeof publish.url !== 'string' || typeof publish.expiresAt !== 'string') return null;
  return isPublicApprovalUrl(publish.url) ? { url: publish.url, expiresAt: publish.expiresAt } : null;
}

/** The host answers with a plain boolean (an explicit yes/no) or an outcome that says why nobody decided. */
export function answerShellApprovalCall(
  handler: ((command: string, callId: string) => Promise<boolean | ApprovalOutcome>) | null,
  message: ShellApprovalCallMessage,
): Promise<ShellApprovalResultMessage> {
  return (async () => {
    // No handler and a throwing handler both mean nobody decided: the child holds instead of recording a refusal.
    let outcome: ApprovalOutcome = { approved: false, reason: 'unavailable' };
    try { if (handler) outcome = normalizeApproval(await handler(message.command, message.callId)); }
    catch { outcome = { approved: false, reason: 'unavailable' }; }
    return { type: RESULT_TYPE, callId: message.callId, approved: outcome.approved,
      ...(!outcome.approved && isApprovalHold(outcome) ? { reason: outcome.reason } : {}) };
  })();
}

/** Guard the actual Bash dispatch boundary; a missing responder never falls through to execution. */
export async function dispatchNextTuiBash<T>(opts: {
  readonly command: string;
  readonly enabled: boolean;
  readonly requiresApproval?: boolean;
  readonly approve: ((command: string, signal?: AbortSignal) => Promise<boolean>) | null;
  readonly signal?: AbortSignal;
  readonly dispatch: () => Promise<T>;
}): Promise<T | { error: string }> {
  if (opts.signal?.aborted) return { error: 'Bash blocked: turn cancelled.' };
  if (opts.enabled && (opts.requiresApproval ?? isPotentiallyDestructiveShellCommand(opts.command))) {
    if (!opts.approve) return { error: 'Bash blocked: human approval channel is unavailable.' };
    const approved = await opts.approve(opts.command, opts.signal);
    if (opts.signal?.aborted) return { error: 'Bash blocked: turn cancelled.' };
    if (!approved) return { error: 'Bash blocked: human approval was denied.' };
  }
  if (opts.signal?.aborted) return { error: 'Bash blocked: turn cancelled.' };
  return opts.dispatch();
}
