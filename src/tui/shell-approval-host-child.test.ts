// Host prompt (shell-approval-session) → IPC reply → child approver: «nobody decided» must never arrive as «declined».
import { describe, expect, test } from 'bun:test';
import {
  NEXT_TUI_SHELL_APPROVAL_IPC_ENV,
  NEXT_TUI_SHELL_APPROVAL_MAX_WINDOW_MS,
  NEXT_TUI_SHELL_APPROVAL_TIMEOUT_MS,
  answerShellApprovalCall,
  createReplGraphApprover,
  isShellApprovalCallMessage,
  isShellApprovalCancelMessage,
  type ShellApprovalCallMessage,
  type ShellApprovalIpcProcess,
} from '../tui-client/next-shell-approval.js';
import {
  createShellApprovalSession,
  requestTimeoutMs,
  shellApprovalCancelStatus,
  shellApprovalTimeoutStatus,
  type NextTuiShellApprovalSession,
} from './shell-approval-session.js';
import type { Key } from '../tui.js';
import { englishFooterText } from './chat/status-line.js';

const env = { [NEXT_TUI_SHELL_APPROVAL_IPC_ENV]: '1' };
const key = (name: string): Key => ({ name, ctrl: false, shift: false } as Key);

/** One child process wired to one host session the way local-chat-turn wires them. */
function wire(timeoutMs?: number) {
  const statuses: string[] = [];
  const session: NextTuiShellApprovalSession = createShellApprovalSession({
    setStatus: line => statuses.push(line), render: () => {}, ...(timeoutMs === undefined ? {} : { timeoutMs }),
    viewport: () => ({ columns: 80, rows: 6, sidetabWidth: 0 }),
  });
  const listeners = new Set<(message: unknown) => void>();
  const calls: ShellApprovalCallMessage[] = [];
  const child: ShellApprovalIpcProcess = {
    send(message: unknown) {
      if (isShellApprovalCallMessage(message)) {
        calls.push(message);
        void answerShellApprovalCall((command, callId) => session.beginDecision(command, callId, message.kind === 'graph' ? 'graph' : 'bash', message.windowMs), message)
          .then(reply => { for (const l of listeners) l(reply); });
      } else if (isShellApprovalCancelMessage(message)) session.cancel(message.callId, message.reason);
      return true;
    },
    on(_event: 'message', l: (message: unknown) => void) { listeners.add(l); },
    off(_event: 'message', l: (message: unknown) => void) { listeners.delete(l); },
  };
  return { session, statuses, calls, child };
}

describe('host approval prompt → child graph approver', () => {
  test('the owner pressing n is declined; pressing y is approved', async () => {
    const w = wire();
    const approver = createReplGraphApprover(w.child, env, NEXT_TUI_SHELL_APPROVAL_TIMEOUT_MS)!;
    const no = approver('review-publish?');
    w.session.handleKey(key('n'));
    expect(await no).toEqual({ approved: false, reason: 'declined' });
    const yes = approver('review-publish?');
    w.session.handleKey(key('y'));
    expect(await yes).toEqual({ approved: true });
  });

  test('nobody answering until the host prompt times out reaches the child as a timeout, not a refusal', async () => {
    const w = wire(Number.EPSILON);
    const approver = createReplGraphApprover(w.child, env, NEXT_TUI_SHELL_APPROVAL_TIMEOUT_MS)!;
    expect(await approver('review-publish?')).toEqual({ approved: false, reason: 'timeout' });
    expect(w.statuses.at(-1)).toBe(shellApprovalTimeoutStatus('graph'));
    expect(w.statuses.at(-1)).not.toContain('거부됨');
  });

  test('a second request while another prompt is up is «unavailable» (not shown to the owner), never declined', async () => {
    const w = wire();
    const approver = createReplGraphApprover(w.child, env, NEXT_TUI_SHELL_APPROVAL_TIMEOUT_MS)!;
    const first = approver('first');
    expect(await approver('second')).toEqual({ approved: false, reason: 'unavailable' });
    w.session.handleKey(key('y'));
    expect(await first).toEqual({ approved: true });
  });

  test('a host with no handler, or a handler that throws, answers «unavailable»', async () => {
    const call = { type: 'elanous.shell-approval.call', callId: 'g1', command: 'q', kind: 'graph' } as ShellApprovalCallMessage;
    expect(await answerShellApprovalCall(null, call)).toMatchObject({ approved: false, reason: 'unavailable' });
    expect(await answerShellApprovalCall(async () => { throw new Error('boom'); }, call)).toMatchObject({ approved: false, reason: 'unavailable' });
    expect((await answerShellApprovalCall(async () => false, call)).reason).toBeUndefined();
  });

  test('the host disposing with a prompt open is a host cancel, not a refusal', async () => {
    const w = wire();
    const pending = createReplGraphApprover(w.child, env, NEXT_TUI_SHELL_APPROVAL_TIMEOUT_MS)!('q');
    w.session.dispose();
    expect(await pending).toEqual({ approved: false, reason: 'host-cancelled' });
  });

  test('a request for the owner window carries its length and the host timer follows it (capped, one second early)', async () => {
    const w = wire();
    const approver = createReplGraphApprover(w.child, env, NEXT_TUI_SHELL_APPROVAL_TIMEOUT_MS)!;
    void approver('review-publish?', undefined, { timeoutMs: NEXT_TUI_SHELL_APPROVAL_MAX_WINDOW_MS });
    expect(w.calls[0]!.windowMs).toBe(NEXT_TUI_SHELL_APPROVAL_MAX_WINDOW_MS);
    w.session.dispose();
    const second = wire();
    void createReplGraphApprover(second.child, env, NEXT_TUI_SHELL_APPROVAL_TIMEOUT_MS)!('plain');
    expect(second.calls[0]!.windowMs).toBeUndefined();
    second.session.dispose();
    const normal = requestTimeoutMs(undefined);
    const owner = requestTimeoutMs(undefined, NEXT_TUI_SHELL_APPROVAL_MAX_WINDOW_MS);
    expect(normal).toBeLessThan(NEXT_TUI_SHELL_APPROVAL_TIMEOUT_MS); // the host ends before the child's own timer
    expect(owner).toBeLessThan(NEXT_TUI_SHELL_APPROVAL_MAX_WINDOW_MS);
    expect(owner - normal).toBe(NEXT_TUI_SHELL_APPROVAL_MAX_WINDOW_MS - NEXT_TUI_SHELL_APPROVAL_TIMEOUT_MS);
    expect(requestTimeoutMs(undefined, Number.MAX_SAFE_INTEGER)).toBe(owner); // never beyond the owner window
    expect(requestTimeoutMs(undefined, Number.NaN)).toBe(normal);
    expect(requestTimeoutMs(Number.EPSILON, NEXT_TUI_SHELL_APPROVAL_MAX_WINDOW_MS)).toBe(Math.max(Number.EPSILON, 1)); // the test seam still wins
  });

  test('the hold statuses have English footer text (not denied)', () => {
    expect(englishFooterText(shellApprovalTimeoutStatus('graph'))).toBe('Plugin graph approval timed out · on hold (not denied)');
    expect(englishFooterText(shellApprovalCancelStatus('graph'))).toBe('Plugin graph approval cancelled · on hold (not denied)');
    expect(englishFooterText(shellApprovalTimeoutStatus('bash'))).toBe('Bash approval timed out · denied');
  });
});
