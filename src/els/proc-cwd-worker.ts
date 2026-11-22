// Runs only in a dedicated worker: proc_pidinfo itself is a synchronous native call.
import { parentPort } from 'node:worker_threads';

// Darwin sys/proc_info.h: proc_vnodepathinfo contains two vnode_info_path
// records; vnode_info is 152 bytes and each path is MAXPATHLEN (1024).
const PATH_OFFSET = 152;
const PATH_SIZE = 1024;
const INFO_SIZE = 2 * (PATH_OFFSET + PATH_SIZE);

function procCwd(pid: number): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    const { dlopen, FFIType, ptr } = require('bun:ffi') as typeof import('bun:ffi');
    const lib = dlopen('/usr/lib/libproc.dylib', {
      proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    });
    try {
      const data = new Uint8Array(INFO_SIZE);
      const size = lib.symbols.proc_pidinfo(pid, 9, 0, ptr(data), data.length);
      if (size !== INFO_SIZE) return undefined;
      const path = data.subarray(PATH_OFFSET, PATH_OFFSET + PATH_SIZE);
      const end = path.indexOf(0);
      if (end <= 0) return undefined;
      return new TextDecoder('utf-8', { fatal: true }).decode(path.subarray(0, end));
    } finally { lib.close(); }
  } catch { return undefined; }
}

parentPort?.on('message', ({ id, pid }: { id: number; pid: number }) => {
  parentPort?.postMessage({ id, cwd: procCwd(pid) });
});
