import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { connectHolderElsPty, holderMetaPath, holderSocketPath, loadHolderMeta, spawnHolderDetached } from './holder.js';

// Real holder process + Unix socket + PTY are the contract under test: a fake socket
// cannot detect a dropped nonce in argv -> holder-main -> startHolder -> pong.
test('detached holder propagates nonce to pong and rejects mismatched adapter controls', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hn-'));
  const pane = 'p';
  const nonce = 'generation-real-wire-126294';
  const child = spawnHolderDetached({ stateRoot: root, paneId: pane, cwd: root,
    title: 'nonce test', command: ['/bin/cat'], generationNonce: nonce });
  let good: ReturnType<typeof connectHolderElsPty> | undefined;
  let bad: ReturnType<typeof connectHolderElsPty> | undefined;
  try {
    // Bounded startup polling is synchronization with the detached real process, not a performance assertion.
    let meta = loadHolderMeta(holderMetaPath(root, pane));
    for (let n = 0; !meta && n < 200; n++) {
      await Bun.sleep(50);
      meta = loadHolderMeta(holderMetaPath(root, pane));
    }
    expect(meta).toBeDefined();
    if (!meta) throw new Error('holder did not start');
    const pong = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = createConnection(holderSocketPath(root, pane));
      let data = '';
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('pong timeout')); }, 5000);
      socket.on('error', (error) => { clearTimeout(timer); reject(error); });
      socket.on('connect', () => socket.write('{"op":"ping"}\n'));
      socket.on('data', (chunk) => {
        data += chunk.toString();
        for (;;) {
          const end = data.indexOf('\n');
          if (end < 0) break;
          const message = JSON.parse(data.slice(0, end));
          data = data.slice(end + 1);
          if (message.type === 'pong') { clearTimeout(timer); socket.destroy(); resolve(message); return; }
        }
      });
    });
    expect(pong.generationNonce).toBe(nonce);
    expect(pong.paneId).toBe(pane);
    expect(pong.ptyId).toBe(meta.ptyId);

    bad = connectHolderElsPty(root, pane, meta, undefined, undefined, 'wrong-generation');
    bad.write('MISMATCH-MUST-NOT-REACH-PTY\n');
    bad.resize?.(37, 11);
    bad.kill();
    const denied = bad.writeAll?.('MISMATCH-WRITE-ALL\n').then(() => 'resolved', () => 'rejected');
    expect(await denied).toBe('rejected');
    expect(bad.isAlive()).toBe(false);

    good = connectHolderElsPty(root, pane, meta, undefined, undefined, nonce);
    await good.writeAll?.('MATCHED-CONTROL-REACHED-PTY\n');
    // cat echoes input; render until it has processed the accepted write.
    let screen = '';
    for (let n = 0; n < 100 && !screen.includes('MATCHED-CONTROL-REACHED-PTY'); n++) {
      screen = await good.renderScreen();
      if (!screen.includes('MATCHED-CONTROL-REACHED-PTY')) await Bun.sleep(25);
    }
    expect(screen).toContain('MATCHED-CONTROL-REACHED-PTY');
    expect(screen).not.toContain('MISMATCH-MUST-NOT-REACH-PTY');
    expect(screen).not.toContain('MISMATCH-WRITE-ALL');
    expect(good.isAlive()).toBe(true);
  } finally {
    bad?.detach?.();
    good?.detach?.();
    try { process.kill(child.pid, 'SIGTERM'); } catch { /* already exited */ }
    // Let holder's SIGTERM cleanup finish before removing the isolated state root.
    for (let n = 0; n < 100; n++) {
      try { process.kill(child.pid, 0); } catch { break; }
      await Bun.sleep(50);
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
