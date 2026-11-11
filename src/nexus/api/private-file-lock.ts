import { closeSync, constants, fstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { dlopen, FFIType } from 'bun:ffi';
import { logDiagnostic } from '../../mss/logging/diagnostic-sink.js';

const LIBC_CANDIDATES: Readonly<Partial<Record<NodeJS.Platform, readonly string[]>>> = {
  darwin: ['/usr/lib/libSystem.B.dylib'],
  linux: ['libc.so.6'],
};

function openFlock(): { flock: (fd: number, operation: number) => number; close: () => void } | null {
  for (const name of LIBC_CANDIDATES[process.platform] ?? []) {
    try {
      const library = dlopen(name, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
      return { flock: (fd, operation) => library.symbols.flock(fd, operation) as number, close: () => library.close() };
    } catch { /* try the next platform library */ }
  }
  return null;
}

/** Run a synchronous ledger read-modify-write while holding a private advisory flock. */
export function withPrivateFileLock<T>(
  lockPath: string,
  update: () => T,
  diagnosticArea: string,
  requireLock = false,
  loadFlock: () => ReturnType<typeof openFlock> = openFlock,
): T {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const fd = openSync(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  const libc = loadFlock();
  if (!libc) {
    logDiagnostic(diagnosticArea, 'lock-unavailable', { platform: process.platform });
    if (requireLock) {
      closeSync(fd);
      throw new Error('private file lock is unavailable');
    }
  }
  let locked = false;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('private ledger lock must be a private regular file');
    if (libc) {
      const deadline = Date.now() + 10_000;
      const pause = new Int32Array(new SharedArrayBuffer(4));
      for (;;) {
        if (libc.flock(fd, 2 | 4) === 0) {
          locked = true;
          break;
        }
        if (Date.now() >= deadline) throw new Error('timed out waiting for private ledger lock');
        Atomics.wait(pause, 0, 0, 10);
      }
    }
    return update();
  } finally {
    if (locked) libc?.flock(fd, 8);
    closeSync(fd);
    libc?.close();
  }
}
