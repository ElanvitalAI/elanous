import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { buildReplTools } from './index.js';
import { NEXT_TUI_SHELL_APPROVAL_IPC_ENV, type ShellApprovalIpcProcess } from '../tui-client/next-shell-approval.js';
import { buildUserConfig, runWithUserConfigSnapshot } from '../user-config.js';

class FakeApprovalProcess extends EventEmitter implements ShellApprovalIpcProcess {
  approved = true;
  calls: Array<{ type: string; callId: string; command: string }> = [];

  send(message: unknown): boolean {
    const call = message as { type: string; callId: string; command: string };
    this.calls.push(call);
    queueMicrotask(() => this.emit('message', {
      type: 'elanous.shell-approval.result', callId: call.callId, approved: this.approved,
    }));
    return true;
  }
}

describe('Next TUI REPL Bash dispatch approval boundary', () => {
  test('buildReplTools waits for approval IPC before dispatching and never dispatches a denial', async () => {
    const priorEnv = process.env[NEXT_TUI_SHELL_APPROVAL_IPC_ENV];
    const approvalProcess = new FakeApprovalProcess();
    const dispatched: string[] = [];
    const dispatchBash = async (args: Record<string, unknown>, _options: { cwd: string }) => {
      dispatched.push(String(args.command));
      return { ok: true };
    };
    process.env[NEXT_TUI_SHELL_APPROVAL_IPC_ENV] = '1';
    try {
      const tools = buildReplTools({
        shellApprovalProcess: approvalProcess,
        dispatchBash,
      });
      const approved = await tools.dispatch('Bash', { command: 'rm -rf /tmp/approved' });
      expect(approved).toEqual({ ok: true });
      expect(approvalProcess.calls.map((call) => call.command)).toEqual(['rm -rf /tmp/approved']);
      expect(dispatched).toEqual(['rm -rf /tmp/approved']);

      approvalProcess.approved = false;
      const denied = await tools.dispatch('Bash', { command: 'rm -rf /tmp/denied' });
      expect(denied).toEqual({ error: 'Bash blocked: human approval was denied.' });
      expect(approvalProcess.calls.map((call) => call.command)).toEqual([
        'rm -rf /tmp/approved', 'rm -rf /tmp/denied',
      ]);
      expect(dispatched).toEqual(['rm -rf /tmp/approved']);

      const noChannelTools = buildReplTools({
        shellApprovalProcess: new EventEmitter() as ShellApprovalIpcProcess,
        dispatchBash,
      });
      const noChannel = await noChannelTools.dispatch('Bash', { command: 'rm -rf /tmp/no-channel' });
      expect(noChannel).toEqual({ error: 'Bash blocked: human approval channel is unavailable.' });
      expect(dispatched).toEqual(['rm -rf /tmp/approved']);

      delete process.env[NEXT_TUI_SHELL_APPROVAL_IPC_ENV];
      const disabledIpcTools = buildReplTools({ dispatchBash });
      const unavailableIpc = await disabledIpcTools.dispatch('Bash', { command: 'rm -rf /tmp/ipc-disabled' });
      expect(unavailableIpc).toEqual({ error: 'Bash blocked: human approval channel is unavailable.' });
      expect(dispatched).toEqual(['rm -rf /tmp/approved']);
    } finally {
      if (priorEnv === undefined) delete process.env[NEXT_TUI_SHELL_APPROVAL_IPC_ENV];
      else process.env[NEXT_TUI_SHELL_APPROVAL_IPC_ENV] = priorEnv;
    }
  });

  test('buildReplTools applies shell.bashApproval=all from config to harmless Bash', async () => {
    const root = mkdtempSync(join(tmpdir(), 'next-tui-bash-approval-'));
    const configPath = join(root, 'config.json');
    const priorEnv = process.env[NEXT_TUI_SHELL_APPROVAL_IPC_ENV];
    const approvalProcess = new FakeApprovalProcess();
    approvalProcess.approved = false;
    const dispatched: string[] = [];
    const dispatchBash = async (args: Record<string, unknown>, _options: { cwd: string }) => {
      dispatched.push(String(args.command));
      return { ok: true };
    };
    writeFileSync(configPath, JSON.stringify({ shell: { bashApproval: 'all' } }));
    const config = buildUserConfig(configPath);
    process.env[NEXT_TUI_SHELL_APPROVAL_IPC_ENV] = '1';
    try {
      const tools = buildReplTools({ shellApprovalProcess: approvalProcess, dispatchBash });
      const denied = await runWithUserConfigSnapshot(config, () =>
        tools.dispatch('Bash', { command: 'printf protected-by-all-mode' }));
      expect(denied).toEqual({ error: 'Bash blocked: human approval was denied.' });
      expect(approvalProcess.calls.map((call) => call.command)).toEqual(['printf protected-by-all-mode']);
      expect(dispatched).toEqual([]);

      approvalProcess.approved = true;
      const approved = await runWithUserConfigSnapshot(config, () =>
        tools.dispatch('Bash', { command: 'printf approved-by-all-mode' }));
      expect(approved).toEqual({ ok: true });
      expect(approvalProcess.calls.map((call) => call.command)).toEqual([
        'printf protected-by-all-mode', 'printf approved-by-all-mode',
      ]);
      expect(dispatched).toEqual(['printf approved-by-all-mode']);
    } finally {
      if (priorEnv === undefined) delete process.env[NEXT_TUI_SHELL_APPROVAL_IPC_ENV];
      else process.env[NEXT_TUI_SHELL_APPROVAL_IPC_ENV] = priorEnv;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
