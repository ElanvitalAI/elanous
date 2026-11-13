import { describe, expect, test } from 'bun:test';
import {
  applyShellApprovalKey,
  createReplGraphApprover,
  createReplShellApprover,
  dispatchNextTuiBash,
  NEXT_TUI_SHELL_APPROVAL_IPC_ENV,
  type ShellApprovalIpcProcess,
} from './next-shell-approval.js';

class FakeIpc implements ShellApprovalIpcProcess {
  readonly sent: unknown[] = [];
  private readonly listeners = new Set<(message: unknown) => void>();
  send(message: unknown): boolean { this.sent.push(message); return true; }
  on(_event: 'message', listener: (message: unknown) => void): void { this.listeners.add(listener); }
  off(_event: 'message', listener: (message: unknown) => void): void { this.listeners.delete(listener); }
  receive(message: unknown): void { for (const listener of this.listeners) listener(message); }
}

describe('Next TUI human Bash approval', () => {
  test('risky Bash waits for parent human approval and never dispatches after denial', async () => {
    const ipc = new FakeIpc();
    const approve = createReplShellApprover(ipc, { [NEXT_TUI_SHELL_APPROVAL_IPC_ENV]: '1' }, 1000)!;
    let dispatched = false;
    const pending = dispatchNextTuiBash({
      command: 'rm -rf /tmp/demo', enabled: true, approve,
      dispatch: async () => { dispatched = true; return 'ran'; },
    });
    expect(dispatched).toBe(false);
    const call = ipc.sent[0] as { type: string; callId: string; command: string };
    expect(call.command).toBe('rm -rf /tmp/demo');
    ipc.receive({ type: 'elanous.shell-approval.result', callId: call.callId, approved: false });
    expect(await pending).toEqual({ error: 'Bash blocked: human approval was denied.' });
    expect(dispatched).toBe(false);
  });

  test('the explicit human y response is the only path that dispatches risky Bash', async () => {
    const ipc = new FakeIpc();
    const approve = createReplShellApprover(ipc, { [NEXT_TUI_SHELL_APPROVAL_IPC_ENV]: '1' }, 1000)!;
    let dispatched = false;
    const pending = dispatchNextTuiBash({
      command: 'touch /tmp/approved', enabled: true, approve,
      dispatch: async () => { dispatched = true; return 'ran'; },
    });
    expect(dispatched).toBe(false);
    const call = ipc.sent[0] as { callId: string };
    ipc.receive({ type: 'elanous.shell-approval.result', callId: call.callId, approved: true });
    expect(await pending).toBe('ran');
    expect(dispatched).toBe(true);
  });

  test('safe read command bypasses the human prompt; risky command fails closed without a channel', async () => {
    let dispatched = 0;
    expect(await dispatchNextTuiBash({
      command: 'pwd', enabled: true, approve: null, dispatch: async () => { dispatched++; return 'cwd'; },
    })).toBe('cwd');
    expect(await dispatchNextTuiBash({
      command: 'touch /tmp/demo', enabled: true, approve: null, dispatch: async () => { dispatched++; return 'ran'; },
    })).toEqual({ error: 'Bash blocked: human approval channel is unavailable.' });
    expect(dispatched).toBe(1);
  });

  test('only direct human y approves; Enter, n, Esc, and arrows cannot approve', () => {
    expect(applyShellApprovalKey('enter')).toEqual({ kind: 'settled', approved: false });
    expect(applyShellApprovalKey('return')).toEqual({ kind: 'settled', approved: false });
    expect(applyShellApprovalKey('y')).toEqual({ kind: 'settled', approved: true });
    expect(applyShellApprovalKey('y', { ctrl: true })).toEqual({ kind: 'pending' });
    expect(applyShellApprovalKey('y', { alt: true })).toEqual({ kind: 'pending' });
    expect(applyShellApprovalKey('y', { shift: true })).toEqual({ kind: 'pending' });
    expect(applyShellApprovalKey('y', { meta: true })).toEqual({ kind: 'pending' });
    expect(applyShellApprovalKey('y', { kind: 'repeat' })).toEqual({ kind: 'pending' });
    expect(applyShellApprovalKey('up')).toEqual({ kind: 'pending' });
    expect(applyShellApprovalKey('down')).toEqual({ kind: 'pending' });
    expect(applyShellApprovalKey('n')).toEqual({ kind: 'settled', approved: false });
    expect(applyShellApprovalKey('escape')).toEqual({ kind: 'settled', approved: false });
  });

  test('child timeout sends request-id cancellation and ignores a late approval reply', async () => {
    const ipc = new FakeIpc();
    const approve = createReplShellApprover(ipc, { [NEXT_TUI_SHELL_APPROVAL_IPC_ENV]: '1' }, 5)!;
    const pending = approve('rm -rf /tmp/late');
    const call = ipc.sent[0] as { callId: string };
    expect(await pending).toBe(false);
    expect(ipc.sent[1]).toEqual({
      type: 'elanous.shell-approval.cancel', callId: call.callId, reason: 'timeout',
    });
    ipc.receive({ type: 'elanous.shell-approval.result', callId: call.callId, approved: true });
    expect(await pending).toBe(false);
  });

  test('a graph approval reply cannot approve a simultaneous Bash request', async () => {
    const ipc = new FakeIpc();
    const env = { [NEXT_TUI_SHELL_APPROVAL_IPC_ENV]: '1' };
    const bash = createReplShellApprover(ipc, env, 1000)!;
    const graph = createReplGraphApprover(ipc, env, 1000)!;
    const pendingBash = bash('rm -rf /tmp/demo');
    const pendingGraph = graph('GCP 확장 설계 그래프를 실행할까요?');
    const calls = ipc.sent as Array<{ callId: string; kind: string }>;
    expect(calls.map(call => call.callId)).toEqual(['s1', 'g1']);
    expect(calls.map(call => call.kind)).toEqual(['bash', 'graph']);
    ipc.receive({ type: 'elanous.shell-approval.result', callId: 'g1', approved: true });
    expect(await pendingGraph).toBe(true);
    ipc.receive({ type: 'elanous.shell-approval.result', callId: 's1', approved: false });
    expect(await pendingBash).toBe(false);
  });
});
