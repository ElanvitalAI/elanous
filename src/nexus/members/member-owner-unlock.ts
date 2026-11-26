// MEMBER-HANDLE-OWNER-UNLOCK (대표 11-26): the company owner claims one of our reserved handles by typing an «owner unlock code» at claim
// time. The code is checked against a secret the members server reads from a file named by an env var (the *_FILE secret pattern, see
// ELANOUS_WEBCHAT_HANDOFF_HMAC_KEY_FILE in http-server.ts). The file is read on every attempt (rare path, rotation applies at once) and
// refused unless it is a regular file, owned by this process's user, not readable or writable by group/other, and at least 16 bytes.
// Only sha256 digests are compared (timingSafeEqual); neither the code nor the secret is logged, echoed or returned.
import { createHash, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

/** Env var naming the 0600 secret file. The value is a path, never the secret itself. */
export const OWNER_UNLOCK_CODE_FILE_ENV = 'ELANOUS_MEMBER_OWNER_UNLOCK_CODE_FILE';
/** Shortest secret accepted (bytes, after trimming a trailing newline). Source: 대표 11-26 request. */
export const OWNER_UNLOCK_SECRET_MIN_BYTES = 16;
/**
 * Largest secret accepted (bytes, after trimming). It equals the request code limit so every accepted secret can be typed: a secret of
 * N <= 256 bytes has at most 256 characters. A larger file is refused (fail-closed) rather than truncated.
 */
export const OWNER_UNLOCK_SECRET_MAX_BYTES = 256;
/** Largest code accepted from a request body (characters). */
export const OWNER_UNLOCK_CODE_MAX_CHARS = OWNER_UNLOCK_SECRET_MAX_BYTES;
/** Bytes read from the file: the secret plus a trailing CRLF; anything longer is refused. */
const OWNER_UNLOCK_FILE_READ_BYTES = OWNER_UNLOCK_SECRET_MAX_BYTES + 2;

/**
 * Reserved handles the owner may unlock with a valid code and an owner account. «admin» (and every relay route name) is never here:
 * it stays unclaimable even with a valid code.
 */
export const OWNER_UNLOCKABLE_HANDLES: ReadonlySet<string> = new Set(['user', 'ElanvitalAI', 'elanvital', 'monad', 'elanous']);

/** Attempts with a code allowed per member per window (persisted in the members DB). */
export const OWNER_UNLOCK_ATTEMPT_LIMIT = 5;
export const OWNER_UNLOCK_ATTEMPT_WINDOW_MS = 60 * 60_000;

function sha256(value: Buffer | string): Buffer { return createHash('sha256').update(value).digest(); }

/** sha256 of the configured secret, or null (fail-closed) when the env is unset or the file is missing, unsafe, short or oversized. */
export function readOwnerUnlockSecretDigest(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const file = env[OWNER_UNLOCK_CODE_FILE_ENV]?.trim();
  if (!file) return null;
  let fd: number | undefined;
  try {
    // O_NONBLOCK: a FIFO (or device) at the path must not block the event loop before fstat refuses it as not a regular file.
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    if ((stat.mode & 0o077) !== 0) return null;
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return null;
    if (stat.size > OWNER_UNLOCK_FILE_READ_BYTES) return null;
    const buffer = Buffer.alloc(OWNER_UNLOCK_FILE_READ_BYTES + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > OWNER_UNLOCK_FILE_READ_BYTES) return null;
    }
    let end = length;
    while (end > 0 && (buffer[end - 1] === 0x0a || buffer[end - 1] === 0x0d)) end -= 1;
    const secret = buffer.subarray(0, end);
    const digest = end >= OWNER_UNLOCK_SECRET_MIN_BYTES && end <= OWNER_UNLOCK_SECRET_MAX_BYTES ? sha256(secret) : null;
    buffer.fill(0);
    return digest;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
  }
}

export type OwnerUnlockCodeVerdict = 'match' | 'mismatch' | 'unavailable';

/** Constant-time comparison of sha256(code) against sha256(secret). 'unavailable' when no usable secret is configured. */
export function checkOwnerUnlockCode(code: string, env: NodeJS.ProcessEnv = process.env): OwnerUnlockCodeVerdict {
  const expected = readOwnerUnlockSecretDigest(env);
  if (!expected) return 'unavailable';
  return timingSafeEqual(sha256(code), expected) ? 'match' : 'mismatch';
}
