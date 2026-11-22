import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUNSHELL_PUBLIC_KEY_ENV, RUNSHELL_APPROVAL_RESULT, type RunShellApprovalCall } from '../tui-client/next-runshell-approval.js';
import { testRunShellIssuer as issuer } from '../shell-primitive/runshell-test-issuer.js';
import { dispatchRunShell } from '../skills/tools/shell.js';
import { resetShellRunnerDeps, setShellRunnerDeps } from './dispatch.js';
import { createShellRegistry } from './registry.js';


test('runner uses signed IPC for each spawn, rejects replay and boolean-only approval', async () => {
  const old = { home: process.env.HOME, seat: process.env.ELANOUS_TRACK, key: process.env[RUNSHELL_PUBLIC_KEY_ENV], send: process.send };
  const connectedDescriptor = Object.getOwnPropertyDescriptor(process, 'connected');
  Object.defineProperty(process, 'connected', { configurable: true, value: true });
  process.env.HOME = mkdtempSync(join(tmpdir(), 'runner-grant-'));
  process.env.ELANOUS_TRACK = 'test-seat';
  process.env[RUNSHELL_PUBLIC_KEY_ENV] = issuer.publicKey;
  let grant: ReturnType<typeof issuer.issue> | null = null;
  let state: 'issue' | 'replay' | 'deny' = 'issue';
  (process as any).send = (m: RunShellApprovalCall) => {
    if (state === 'issue') grant = issuer.issue(m.request);
    queueMicrotask(() => process.emit('message', { type: RUNSHELL_APPROVAL_RESULT, callId: m.callId, approval: state === 'deny' ? null : grant }));
    return true;
  };
  setShellRunnerDeps({ registry: createShellRegistry() });
  try {
    const args = { command: ['/bin/echo', 'approved'], cwd: '/tmp', mode: 'inline', approval: 'none' };
    const opts = { sessionId: 'test-session', priorHumanApproval: true };
    const first = await dispatchRunShell(args, opts);
    expect(first.outcome).toBe('exit');
    expect(first.stdout).toBe('approved\n');
    state = 'replay';
    const replay = await dispatchRunShell(args, opts);
    expect(replay.outcome).toBe('spawn-error');
    expect(replay.stdout).toBe('');
    state = 'deny';
    const denied = await dispatchRunShell(args, opts);
    expect(denied.outcome).toBe('denied');
    const background = await dispatchRunShell({ ...args, mode: 'bg' }, opts);
    expect(background.outcome).toBe('denied');
  } finally {
    resetShellRunnerDeps();
    (process as any).send = old.send;
    if (connectedDescriptor) Object.defineProperty(process, 'connected', connectedDescriptor);
    else delete (process as any).connected;
    if (old.home === undefined) delete process.env.HOME; else process.env.HOME = old.home;
    if (old.seat === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = old.seat;
    if (old.key === undefined) delete process.env[RUNSHELL_PUBLIC_KEY_ENV]; else process.env[RUNSHELL_PUBLIC_KEY_ENV] = old.key;
  }
});
