import { createHash, createPublicKey, verify } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { getElanousConfigDir } from '../elanous-config-dir.js';

/** Wire format shared with the parent; expiresAt is Unix milliseconds. */
export interface RunShellApprovalPayload {
  cardId: string;
  argvHash: string;
  cwd: string;
  bytesSha256: string;
  callerSeat: string;
  sessionId: string;
  nonce: string;
  expiresAt: number;
}
export interface SignedRunShellApproval { payload: RunShellApprovalPayload; signature: string }

/** JSON array preserves argument boundaries and empty arguments. */
export function runShellArgvHash(argv: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(argv), 'utf8').digest('hex');
}

/** Domain-separated fixed-order serialization. Sign these bytes with Ed25519. */
export function runShellApprovalSigningBytes(p: RunShellApprovalPayload): Buffer {
  return Buffer.from('elanous:runshell-approval:v1\n' + JSON.stringify([
    p.cardId, p.argvHash, p.cwd, p.bytesSha256, p.callerSeat, p.sessionId, p.nonce, p.expiresAt,
  ]), 'utf8');
}

/**
 * Approval consumer called by the shared spawn gateway for signed grants.
 * argv and cwd must be the actual independently reconstructed spawn request;
 * executablePath must be the absolute path actually passed to spawn, not a PATH name.
 * No async work may occur between this function and spawn. A consumed nonce is
 * never removed, including on spawn failure. A same-UID replacement between the
 * final hash and exec remains the explicitly accepted v1 race.
 */
export function consumeRunShellApproval(input: {
  approval: SignedRunShellApproval;
  publicKeyPem: string;
  argv: readonly string[];
  cwd: string;
  executablePath: string;
  callerSeat: string;
  sessionId: string;
  signal?: AbortSignal;
}): void {
  const p = input.approval?.payload;
  const sig = input.approval?.signature;
  const hash = /^[0-9a-f]{64}$/;
  if (!p || typeof p.cardId !== 'string' || !p.cardId || p.cardId.length > 256
    || typeof p.callerSeat !== 'string' || !p.callerSeat || p.callerSeat !== input.callerSeat
    || typeof p.sessionId !== 'string' || !p.sessionId || p.sessionId !== input.sessionId
    || typeof p.cwd !== 'string' || !isAbsolute(p.cwd) || p.cwd !== input.cwd
    || typeof p.argvHash !== 'string' || !hash.test(p.argvHash) || p.argvHash !== runShellArgvHash(input.argv)
    || typeof p.bytesSha256 !== 'string' || !hash.test(p.bytesSha256)
    || typeof p.nonce !== 'string' || !/^[0-9a-f]{64}$/.test(p.nonce)
    || !Number.isSafeInteger(p.expiresAt) || p.expiresAt <= Date.now()
    || typeof sig !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(sig)
    || Buffer.from(sig, 'base64').toString('base64') !== sig
    || !isAbsolute(input.executablePath) || input.signal?.aborted) throw new Error('invalid RunShell approval');
  const key = createPublicKey(input.publicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519'
    || !verify(null, runShellApprovalSigningBytes(p), key, Buffer.from(sig, 'base64')))
    throw new Error('invalid RunShell approval signature');

  const root = join(getElanousConfigDir(), 'runshell', 'consumed');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const st = lstatSync(root);
  if (!st.isDirectory() || (st.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && st.uid !== process.getuid())) throw new Error('unsafe RunShell nonce ledger');
  const fd = openSync(join(root, p.nonce), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { fsyncSync(fd); } finally { closeSync(fd); }
  // Durably record the directory entry before any process can be spawned.
  const dir = openSync(root, constants.O_RDONLY);
  try { fsyncSync(dir); } finally { closeSync(dir); }
  if (input.signal?.aborted || p.expiresAt <= Date.now()) throw new Error('RunShell approval expired or cancelled');
  const actual = createHash('sha256').update(readFileSync(input.executablePath)).digest('hex');
  if (actual !== p.bytesSha256) throw new Error('RunShell executable changed');
  if (input.signal?.aborted || p.expiresAt <= Date.now()) throw new Error('RunShell approval expired or cancelled');
}
