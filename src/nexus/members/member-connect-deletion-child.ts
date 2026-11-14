import { existsSync, writeFileSync } from 'node:fs';
import { createMemberStore } from './member-store.js';

const [path, token, ready, go, attempting] = process.argv.slice(2);
if (!path || !token || !ready || !go || !attempting) throw new Error('missing fake deletion probe argument');
const store = createMemberStore({ path });
try {
  writeFileSync(ready, 'ready');
  const deadline = Date.now() + 3_000;
  while (!existsSync(go) && Date.now() < deadline)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  if (!existsSync(go)) throw new Error('deletion release did not arrive');
  writeFileSync(attempting, 'attempting-delete');
  const deleted = store.requestDeletion(token);
  process.stdout.write(JSON.stringify({ deleted }));
  if (!deleted) process.exitCode = 1;
} finally { store.close(); }
