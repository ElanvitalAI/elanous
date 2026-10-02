import { openSync } from 'node:fs';
import { join } from 'node:path';
import { dlopen, FFIType } from 'bun:ffi';
import { claimSetupLinkToken } from './setup-link-tokens.js';

const [mode, dir, token, now] = process.argv.slice(2);
if (mode === 'claim') {
  process.stdout.write(JSON.stringify(claimSetupLinkToken(token, { dir, now: Number(now) })));
} else if (mode === 'hold') {
  const fd = openSync(join(dir, 'setup-link-tokens.json.lock'), 'r+');
  const libc = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  if (libc.symbols.flock(fd, 2) !== 0) throw new Error('failed to acquire lock');
  process.stdout.write('locked\n');
  await new Promise<void>(() => { setInterval(() => {}, 1000); });
} else {
  throw new Error(`unknown fixture mode: ${mode}`);
}
