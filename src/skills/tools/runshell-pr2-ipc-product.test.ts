import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunShellApprovalIssuer, RUNSHELL_PUBLIC_KEY_ENV, RUNSHELL_APPROVAL_RESULT, type RunShellApprovalCall } from '../../tui-client/next-runshell-approval.js';
import { testRunShellIssuer as issuer } from '../../shell-primitive/runshell-test-issuer.js';
import { dispatchRunShell } from './shell.js';

// CEO 11-23 relax: only hold-class argv still take the signed grant. This argv is destructive by the guardian
// (recursive rm) yet harmless: printf succeeds, so the `||` branch never runs.
const GRANT_FIXTURE = ['/bin/sh', '-c', 'printf "approved\\n" || ngrok version'];  // held as public-tunnel exposure; harmless even if the fallback ever ran

test('product dispatch signs via IPC, executes once, denies replay and denial', async () => {
  const prevHome = process.env.HOME, prevSeat = process.env.ELANOUS_TRACK, prevKey = process.env[RUNSHELL_PUBLIC_KEY_ENV];
  const prevSend = process.send;
  const connectedDescriptor = Object.getOwnPropertyDescriptor(process, 'connected');
  Object.defineProperty(process, 'connected', { configurable: true, value: true });
  process.env.HOME = mkdtempSync(join(tmpdir(), 'runshell-product-ipc-'));
  process.env.ELANOUS_TRACK = 'test-seat';
  process.env[RUNSHELL_PUBLIC_KEY_ENV] = issuer.publicKey;
  let grant: ReturnType<typeof issuer.issue> | null = null;
  const otherIssuer = createRunShellApprovalIssuer();
  let mode: 'issue' | 'replay' | 'deny' | 'other-key' = 'issue';
  (process as any).send = (message: RunShellApprovalCall) => {
    if (mode === 'issue') grant = issuer.issue(message.request);
    const approval = mode === 'deny' ? null : mode === 'other-key' ? otherIssuer.issue(message.request) : grant;
    queueMicrotask(() => process.emit('message', { type: RUNSHELL_APPROVAL_RESULT, callId: message.callId, approval }));
    return true;
  };
  try {
    const args = { command: GRANT_FIXTURE, cwd: '/tmp', approval: 'none', sandbox: 'off' };
    const opts = { sessionId: 'test-session' };
    const first = await dispatchRunShell(args, opts);
    expect(first.outcome).toBe('exit');
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toBe('approved\n');
    mode = 'replay';
    const second = await dispatchRunShell(args, opts);
    expect(second.outcome).not.toBe('exit');
    expect(second.stdout).toBe('');
    mode = 'deny';
    const third = await dispatchRunShell(args, opts);
    expect(third.outcome).toBe('denied');
    expect(third.stdout).toBe('');
    process.env[RUNSHELL_PUBLIC_KEY_ENV] = otherIssuer.publicKey;
    mode = 'other-key';
    const forged = await dispatchRunShell(args, opts);
    expect(forged.outcome).not.toBe('exit');
    expect(forged.stdout).toBe('');
  } finally {
    (process as any).send = prevSend;
    if (connectedDescriptor) Object.defineProperty(process, 'connected', connectedDescriptor);
    else delete (process as any).connected;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevSeat === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = prevSeat;
    if (prevKey === undefined) delete process.env[RUNSHELL_PUBLIC_KEY_ENV]; else process.env[RUNSHELL_PUBLIC_KEY_ENV] = prevKey;
  }
});
