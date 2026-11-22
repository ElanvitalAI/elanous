import { expect, test } from 'bun:test';
import { testRunShellIssuer as issuer } from '../shell-primitive/runshell-test-issuer.js';
import { RUNSHELL_APPROVAL_RESULT, type RunShellApprovalCall } from '../tui-client/next-runshell-approval.js';
import { getShellRunnerDeps, resetShellRunnerDeps } from '../shell-runner/dispatch.js';
import { getShellRegistry, resetShellRegistry } from '../shell-runner/registry.js';
import { buildReplTools } from './index.js';

test('Next chat tools initialize bg runner once and retain signed approval gate', async () => {
  const oldSend = process.send;
  const oldSeat = process.env.ELANOUS_TRACK;
  const connected = Object.getOwnPropertyDescriptor(process, 'connected');
  resetShellRunnerDeps();
  resetShellRegistry();
  process.env.ELANOUS_TRACK = 'test-seat';
  Object.defineProperty(process, 'connected', { configurable: true, value: true });
  let approved = true;
  let requests = 0;
  (process as any).send = (message: RunShellApprovalCall) => {
    requests++;
    const approval = approved ? issuer.issue(message.request) : null;
    queueMicrotask(() => process.emit('message', { type: RUNSHELL_APPROVAL_RESULT, callId: message.callId, approval }));
    return true;
  };
  try {
    const tools = buildReplTools({ nextTui: true, sessionId: 'bg-session' });
    expect(getShellRunnerDeps()?.registry).toBe(getShellRegistry());
    const args = { command: ['/bin/sh', '-c', 'sleep 0.1; printf "approved-bg\\n"'], cwd: '/tmp', mode: 'bg' };
    const started = await tools.dispatch('RunShell', args) as { outcome: string };
    expect(started.outcome).toBe('started');
    const registry = getShellRegistry();
    const handle = registry.list({ includeSettled: true })[0]!;
    expect(handle).toBeDefined();
    const result = await handle.result;
    expect(result.exitCode).toBe(0);
    expect(result.stdout.text).toBe('approved-bg\n');
    buildReplTools({ nextTui: true, sessionId: 'bg-session' });
    expect(getShellRunnerDeps()?.registry).toBe(registry);
    expect(registry.get(handle.id)).toBe(handle);
    approved = false;
    const denied = await tools.dispatch('RunShell', args) as { outcome: string };
    expect(denied.outcome).toBe('denied');
    expect(requests).toBe(2);
    expect(registry.size()).toBe(1);
    console.log(JSON.stringify({ evidence: 'next-repl-bg-runner', started: started.outcome, exit: result.exitCode, denied: denied.outcome, approvals: requests }));
  } finally {
    resetShellRunnerDeps();
    resetShellRegistry();
    (process as any).send = oldSend;
    if (connected) Object.defineProperty(process, 'connected', connected); else delete (process as any).connected;
    if (oldSeat === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = oldSeat;
  }
}, 15000);
