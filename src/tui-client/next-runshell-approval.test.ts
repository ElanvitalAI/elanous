import { describe, expect, test } from 'bun:test';
import { verify } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { runShellApprovalSigningBytes, runShellArgvHash } from '../shell-primitive/runshell-approval.js';
import { createRunShellApprovalIssuer, isRunShellApprovalCall, requestRunShellApproval, RUNSHELL_APPROVAL_CALL, RUNSHELL_APPROVAL_RESULT, runShellApprovalCard } from './next-runshell-approval.js';

const request = { argv: ['/bin/echo', 'a b', ''], cwd: '/tmp', bytesSha256: 'a'.repeat(64), callerSeat: 'seat', sessionId: 'session' };
describe('parent RunShell approval wire', () => {
  test('binds exact argv and fields to an Ed25519 signature; each grant is fresh', () => {
    const issuer = createRunShellApprovalIssuer();
    const first = issuer.issue(request);
    const second = issuer.issue(request);
    expect(first.payload.argvHash).toBe(runShellArgvHash(request.argv));
    expect(first.payload.nonce).not.toBe(second.payload.nonce);
    expect(verify(null, runShellApprovalSigningBytes(first.payload), issuer.publicKey, Buffer.from(first.signature, 'base64'))).toBe(true);
    expect(verify(null, runShellApprovalSigningBytes({ ...first.payload, cwd: '/' }), issuer.publicKey, Buffer.from(first.signature, 'base64'))).toBe(false);
    expect(runShellApprovalCard(request)).toContain(JSON.stringify(request.argv));
  });
  test('parent disconnect denies promptly and removes listeners', async () => {
    const events = new EventEmitter();
    const proc = Object.assign(events, { connected: true, send: (_message: unknown) => true });
    const pending = requestRunShellApproval(proc, request);
    proc.connected = false;
    events.emit('disconnect');
    expect(await pending).toBeNull();
    expect(events.listenerCount('message')).toBe(0);
    expect(events.listenerCount('disconnect')).toBe(0);
    expect(await requestRunShellApproval(proc, request)).toBeNull();
  });
  test('rejects malformed request and cancellation never yields a grant', async () => {
    expect(isRunShellApprovalCall({ type: RUNSHELL_APPROVAL_CALL, callId: 'x', request: { ...request, bytesSha256: 'bad' } })).toBe(false);
    const events = new EventEmitter();
    const sent: any[] = [];
    const proc = Object.assign(events, { send: (message: unknown) => { sent.push(message); return true; } });
    const abort = new AbortController();
    const pending = requestRunShellApproval(proc, request, abort.signal);
    abort.abort();
    events.emit('message', { type: RUNSHELL_APPROVAL_RESULT, callId: sent[0].callId, approval: createRunShellApprovalIssuer().issue(request) });
    expect(await pending).toBeNull();
    expect(sent[1].reason).toBe('turn-cancelled');
  });
});
