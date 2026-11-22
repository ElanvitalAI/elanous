import { expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElsCore } from './core.js';
import { connectHolderElsPty, holderSocketPath } from './holder.js';
import { emptyJournal } from './space.js';

test('actual holder adapter schedules initial proc read after delayed verified pong without output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cwd-ready-'));
  mkdirSync(join(root, 'els', 'holders'), { recursive: true });
  const server = createServer(socket => socket.once('data', () => setTimeout(() => {
    socket.write(JSON.stringify({ type: 'pong', paneId: 'p', ptyId: 'holder-pty', pid: 4242, generationNonce: 'nonce' }) + '\n');
  }, 250)));
  await new Promise<void>(resolve => server.listen(holderSocketPath(root, 'p'), resolve));
  let stored = emptyJournal(); const reads: number[] = [];
  const pty = connectHolderElsPty(root, 'p', undefined, () => undefined, undefined, 'nonce');
  const core = createElsCore({ load: () => stored, save: j => { stored = j; }, spawn: () => pty,
    procCwdReader: { read: async pid => { reads.push(pid); return '/observed'; }, dispose: () => {} } });
  try {
    core.start(); core.newPane({ ws: 'W', cwd: '/initial', command: ['sh'] });
    expect(pty.pid).toBeUndefined();
    for (let n = 0; n < 40 && !reads.length; n++) await Bun.sleep(25);
    expect(reads).toEqual([4242]);
    expect(stored.panes[0]?.cwd).toBe('/observed');
  } finally {
    core.stopAll(); await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
