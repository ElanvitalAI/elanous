// OS peer credentials, never a value claimed in the wire request. Unsupported runtimes deny.
import type { Socket } from 'node:net';
export function peerUid(socket: Socket): number | undefined {
  try {
    const fd = (socket as unknown as { _handle?: { fd?: number } })._handle?.fd;
    if (!Number.isInteger(fd) || fd! < 0) return undefined;
    const { dlopen, FFIType, ptr } = require('bun:ffi') as typeof import('bun:ffi');
    if (process.platform === 'darwin') {
      const lib = dlopen('/usr/lib/libSystem.B.dylib', { getpeereid: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 } });
      try { const uid = new Uint32Array(1), gid = new Uint32Array(1); return lib.symbols.getpeereid(fd!, ptr(uid), ptr(gid)) === 0 ? uid[0] : undefined; } finally { lib.close(); }
    }
    if (process.platform === 'linux') {
      const lib = dlopen('libc.so.6', { getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 } });
      try { const cred = new Uint32Array(3), len = new Uint32Array([12]); return lib.symbols.getsockopt(fd!, 1, 17, ptr(cred), ptr(len)) === 0 && len[0] === 12 ? cred[1] : undefined; } finally { lib.close(); }
    }
  } catch { /* fail closed */ }
  return undefined;
}
