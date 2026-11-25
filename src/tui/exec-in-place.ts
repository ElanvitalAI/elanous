// TUI-RESTART-NESTED-CHAIN — replace this process image with execve (same pid · same terminal · same parent).
// Bun has no `process.execve`; libc's execve through bun:ffi does the job. Used by every TUI self-restart path
// (installed-moved / seat migrate / loop-stall watchdog) so a restart never leaves the old TUI waiting as a parent.
// No TUI imports: the loop watchdog worker loads this from a thread whose main loop may be wedged.

/** Replace this process (all threads) with `argv` (argv[0] = the executable path). Returns only when execve failed. */
export function execInPlace(argv: readonly string[], env: Record<string, string>): string {
  try {
    if (argv.length === 0 || !argv[0]) return 'empty argv';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffi = require('bun:ffi') as typeof import('bun:ffi');
    const lib = ffi.dlopen(process.platform === 'darwin' ? 'libc.dylib' : 'libc.so.6', {
      execve: { args: [ffi.FFIType.ptr, ffi.FFIType.ptr, ffi.FFIType.ptr], returns: ffi.FFIType.i32 },
    });
    const keep: Uint8Array[] = [];
    const cstr = (text: string): Uint8Array => { const bytes = new TextEncoder().encode(`${text}\0`); keep.push(bytes); return bytes; };
    const table = (items: readonly string[]): BigUint64Array => {
      const ptrs = new BigUint64Array(items.length + 1);
      items.forEach((item, index) => { ptrs[index] = BigInt(ffi.ptr(cstr(item))); });
      return ptrs;
    };
    const argvTable = table(argv);
    const envTable = table(Object.entries(env).map(([key, value]) => `${key}=${value}`));
    const rc = lib.symbols.execve(ffi.ptr(cstr(argv[0])), ffi.ptr(argvTable), ffi.ptr(envTable));
    return `execve rc=${rc}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
