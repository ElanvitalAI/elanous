/** RunShell approval wire. The parent alone creates a signing key; a boolean is never a RunShell grant. */
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { runShellArgvHash, runShellApprovalSigningBytes, type RunShellApprovalPayload, type SignedRunShellApproval } from '../shell-primitive/runshell-approval.js';
export type { RunShellApprovalPayload, SignedRunShellApproval } from '../shell-primitive/runshell-approval.js';

export const RUNSHELL_PUBLIC_KEY_ENV = 'ELANOUS_RUNSHELL_APPROVAL_PUBLIC_KEY';
export const RUNSHELL_APPROVAL_CALL = 'elanous.runshell-approval.call';
export const RUNSHELL_APPROVAL_RESULT = 'elanous.runshell-approval.result';
export interface RunShellApprovalRequest {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly bytesSha256: string;
  readonly callerSeat: string;
  readonly sessionId: string;
}
export interface RunShellApprovalCall { readonly type: typeof RUNSHELL_APPROVAL_CALL; readonly callId: string; readonly request: RunShellApprovalRequest }
export interface RunShellApprovalResult { readonly type: typeof RUNSHELL_APPROVAL_RESULT; readonly callId: string; readonly approval: SignedRunShellApproval | null }

export function isRunShellApprovalCall(value: unknown): value is RunShellApprovalCall {
  if (!value || typeof value !== 'object') return false;
  const m = value as Partial<RunShellApprovalCall>;
  const r = m.request;
  return m.type === RUNSHELL_APPROVAL_CALL && typeof m.callId === 'string' && m.callId.length > 0 && m.callId.length <= 128
    && !!r && Array.isArray(r.argv) && r.argv.length > 0 && r.argv.length <= 256
    && r.argv.every(v => typeof v === 'string' && v.length <= 8192 && !v.includes('\0'))
    && typeof r.cwd === 'string' && r.cwd.startsWith('/') && !r.cwd.includes('\0') && r.cwd.length <= 8192
    && typeof r.bytesSha256 === 'string' && /^[a-f0-9]{64}$/.test(r.bytesSha256)
    && typeof r.callerSeat === 'string' && r.callerSeat.length > 0 && r.callerSeat.length <= 256
    && typeof r.sessionId === 'string' && r.sessionId.length > 0 && r.sessionId.length <= 256;
}

/** Parent-only factory: private key never leaves this closure. */
export function createRunShellApprovalIssuer(): {
  publicKey: string;
  issue(request: RunShellApprovalRequest): SignedRunShellApproval;
} {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const issue = (request: RunShellApprovalRequest): SignedRunShellApproval => {
    const payload: RunShellApprovalPayload = {
      cardId: randomUUID(), argvHash: runShellArgvHash(request.argv), cwd: request.cwd,
      bytesSha256: request.bytesSha256, callerSeat: request.callerSeat, sessionId: request.sessionId,
      nonce: randomBytes(32).toString('hex'), expiresAt: Date.now() + 60_000,
    };
    return { payload, signature: sign(null, runShellApprovalSigningBytes(payload), privateKey).toString('base64') };
  };
  return { publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), issue };
}

/** Render unambiguous, escaped argv, not a shell-joined command. */
export function runShellApprovalCard(request: RunShellApprovalRequest): string {
  return `RunShell (one execution)\nargv: ${JSON.stringify(request.argv)}\ncwd: ${JSON.stringify(request.cwd)}\nbytes sha256: ${request.bytesSha256}\nseat: ${JSON.stringify(request.callerSeat)}\nsession: ${JSON.stringify(request.sessionId)}`;
}

/** Child IPC client: null on denial, missing channel, cancellation, timeout or malformed reply. */
export async function requestRunShellApproval(
  proc: import('./next-shell-approval.js').ShellApprovalIpcProcess,
  request: RunShellApprovalRequest,
  signal?: AbortSignal,
  timeoutMs = 5 * 60_000,
): Promise<SignedRunShellApproval | null> {
  if (typeof proc.send !== 'function' || (proc as { connected?: boolean }).connected === false || signal?.aborted || !isRunShellApprovalCall({ type: RUNSHELL_APPROVAL_CALL, callId: 'validation', request })) return null;
  const callId = `runshell-${randomUUID()}`;
  return new Promise(resolve => {
    let settled = false;
    const finish = (approval: SignedRunShellApproval | null, cancel = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      proc.off('message', onMessage);
      proc.off('disconnect' as 'message', onDisconnect);
      if (cancel) try { proc.send?.({ type: 'elanous.shell-approval.cancel', callId, reason: signal?.aborted ? 'turn-cancelled' : 'timeout' }); } catch { /* host exited */ }
      resolve(approval);
    };
    const onAbort = () => finish(null, true);
    const onDisconnect = () => finish(null);
    const onMessage = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      const m = value as Partial<RunShellApprovalResult> & { reason?: unknown };
      if (m.callId !== callId) return;
      if ((m as { type?: string }).type === 'elanous.shell-approval.cancel') { finish(null); return; }
      if (m.type !== RUNSHELL_APPROVAL_RESULT) return;
      const a = m.approval;
      finish(a && typeof a === 'object' && typeof a.signature === 'string' && a.payload && typeof a.payload === 'object' ? a : null);
    };
    const timer = setTimeout(() => finish(null, true), timeoutMs);
    proc.on('message', onMessage);
    proc.on('disconnect' as 'message', onDisconnect);
    signal?.addEventListener('abort', onAbort, { once: true });
    if ((proc as { connected?: boolean }).connected === false) { onDisconnect(); return; }
    if (signal?.aborted) { onAbort(); return; }
    try { proc.send!({ type: RUNSHELL_APPROVAL_CALL, callId, request } satisfies RunShellApprovalCall); }
    catch { finish(null); }
  });
}
