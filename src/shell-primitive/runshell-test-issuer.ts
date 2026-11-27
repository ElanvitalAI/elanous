// Shared process bootstrap for RunShell tests: the gateway captures this key once.
// Import this module before any RunShell runtime/gateway module so the captured key matches.
import { createRunShellApprovalIssuer, RUNSHELL_APPROVAL_CALL, RUNSHELL_APPROVAL_RESULT, RUNSHELL_PUBLIC_KEY_ENV,
  type RunShellApprovalCall, type RunShellApprovalRequest } from '../tui-client/next-runshell-approval.js';
export const testRunShellIssuer = createRunShellApprovalIssuer();
process.env[RUNSHELL_PUBLIC_KEY_ENV] = testRunShellIssuer.publicKey;

/** A card the simulated parent has not answered yet. */
export interface HeldRunShellCard { readonly request: RunShellApprovalRequest; answer(approved: boolean): void }

/**
 * Simulated Next TUI parent for tests: answers each signed RunShell card over the
 * process IPC seam the real child uses (process.send ⇄ process 'message').
 * `decide` returns true (sign), false (deny) or 'hold' (answer later via `held`).
 */
export function installTestRunShellHost(options: {
  seat?: string;
  decide?: (request: RunShellApprovalRequest) => boolean | 'hold';
} = {}): { readonly cards: RunShellApprovalRequest[]; readonly held: HeldRunShellCard[]; restore(): void } {
  const cards: RunShellApprovalRequest[] = [];
  const held: HeldRunShellCard[] = [];
  const oldSend = process.send;
  const oldSeat = process.env.ELANOUS_TRACK;
  const connected = Object.getOwnPropertyDescriptor(process, 'connected');
  process.env.ELANOUS_TRACK = options.seat ?? 'test-seat';
  Object.defineProperty(process, 'connected', { configurable: true, value: true });
  const reply = (call: RunShellApprovalCall, approved: boolean) => queueMicrotask(() => process.emit('message' as never,
    { type: RUNSHELL_APPROVAL_RESULT, callId: call.callId, approval: approved ? testRunShellIssuer.issue(call.request) : null } as never));
  (process as { send?: unknown }).send = (message: unknown) => {
    const call = message as RunShellApprovalCall;
    if (!call || call.type !== RUNSHELL_APPROVAL_CALL) return true; // cancellations need no answer
    cards.push(call.request);
    const decision = options.decide ? options.decide(call.request) : true;
    if (decision === 'hold') held.push({ request: call.request, answer: approved => reply(call, approved) });
    else reply(call, decision);
    return true;
  };
  return {
    cards, held,
    restore() {
      (process as { send?: unknown }).send = oldSend;
      if (connected) Object.defineProperty(process, 'connected', connected); else delete (process as { connected?: boolean }).connected;
      if (oldSeat === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = oldSeat;
    },
  };
}
