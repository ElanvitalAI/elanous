/** Human confirmation bridge for Bash calls made by the Next TUI's REPL child. */
import { isPotentiallyDestructiveShellCommand } from '../cli/shell-confirmation-policy.js';

export const NEXT_TUI_SHELL_APPROVAL_IPC_ENV = 'ELANOUS_NEXT_TUI_SHELL_APPROVAL_IPC';
export const NEXT_TUI_SHELL_APPROVAL_TIMEOUT_MS = 5 * 60_000;
const CALL_TYPE = 'elanous.shell-approval.call';
const RESULT_TYPE = 'elanous.shell-approval.result';
export const SHELL_APPROVAL_CANCEL_TYPE = 'elanous.shell-approval.cancel';

export interface ShellApprovalCallMessage {
  readonly type: typeof CALL_TYPE;
  readonly callId: string;
  readonly command: string;
}

export interface ShellApprovalResultMessage {
  readonly type: typeof RESULT_TYPE;
  readonly callId: string;
  readonly approved: boolean;
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
    && typeof message.approved === 'boolean';
}

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
): ((command: string) => Promise<boolean>) | null {
  if (env[NEXT_TUI_SHELL_APPROVAL_IPC_ENV] !== '1' || typeof proc.send !== 'function') return null;
  const send = proc.send.bind(proc);
  const waiting = new Map<string, (approved: boolean) => void>();
  let seq = 0;
  const listener = (message: unknown): void => {
    if (isShellApprovalCancelMessage(message)) {
      waiting.get(message.callId)?.(false);
      return;
    }
    if (!isShellApprovalResultMessage(message)) return;
    waiting.get(message.callId)?.(message.approved);
  };
  proc.on('message', listener);
  return (command) => new Promise<boolean>((resolve) => {
    const callId = `s${++seq}`;
    const finish = (approved: boolean, reason?: ShellApprovalCancelMessage['reason']): void => {
      if (!waiting.delete(callId)) return;
      clearTimeout(timer);
      if (reason) {
        try { send({ type: SHELL_APPROVAL_CANCEL_TYPE, callId, reason } satisfies ShellApprovalCancelMessage); }
        catch { /* the host may already be closing */ }
      }
      resolve(approved);
    };
    const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs);
    waiting.set(callId, finish);
    try {
      send({ type: CALL_TYPE, callId, command } satisfies ShellApprovalCallMessage);
    } catch {
      finish(false);
    }
  });
}

export function answerShellApprovalCall(
  handler: ((command: string, callId: string) => Promise<boolean>) | null,
  message: ShellApprovalCallMessage,
): Promise<ShellApprovalResultMessage> {
  return (async () => {
    let approved = false;
    try { approved = handler ? await handler(message.command, message.callId) : false; }
    catch { approved = false; }
    return { type: RESULT_TYPE, callId: message.callId, approved };
  })();
}

/** Guard the actual Bash dispatch boundary; a missing responder never falls through to execution. */
export async function dispatchNextTuiBash<T>(opts: {
  readonly command: string;
  readonly enabled: boolean;
  readonly requiresApproval?: boolean;
  readonly approve: ((command: string) => Promise<boolean>) | null;
  readonly dispatch: () => Promise<T>;
}): Promise<T | { error: string }> {
  if (opts.enabled && (opts.requiresApproval ?? isPotentiallyDestructiveShellCommand(opts.command))) {
    if (!opts.approve) return { error: 'Bash blocked: human approval channel is unavailable.' };
    if (!await opts.approve(opts.command)) return { error: 'Bash blocked: human approval was denied.' };
  }
  return opts.dispatch();
}
