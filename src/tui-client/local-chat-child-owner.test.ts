import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeLocalChatSession, localChatChildOwner, runLocalChatTurn } from './local-chat-turn.js';

// CAPSULE-K3 — the capsule ledger's owner identity is the live chat child: its real pid and spawn time.
test('localChatChildOwner = the live child\'s pid + spawn time; null before spawn and after close', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'child-owner-'));
  const cli = join(dir, 'pid-cli.ts');
  writeFileSync(cli, `
    import { createInterface } from 'node:readline';
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      console.log(JSON.stringify({ event: 'delta', turnId: request.id, text: String(process.pid) }));
      console.log(JSON.stringify({ event: 'result', turnId: request.id, reply: 'done' }));
    }
  `);
  const pids: string[] = [];
  try {
    expect(localChatChildOwner('k3-owner')).toBeNull();
    const before = Date.now();
    await runLocalChatTurn('k3-owner', 'hello', new AbortController().signal, cli, undefined, (delta) => { pids.push(delta); });
    const owner = localChatChildOwner('k3-owner');
    expect(owner?.pid).toBe(Number(pids[0]));
    expect(owner!.startedAt).toBeGreaterThanOrEqual(before);
    expect(owner!.startedAt).toBeLessThanOrEqual(Date.now());
    // Real elapsed time distinguishes a spawn timestamp from Date.now() at lookup.
    await Bun.sleep(20);
    expect(Date.now()).toBeGreaterThan(owner!.startedAt);
    expect(localChatChildOwner('k3-owner')).toEqual(owner);
    await runLocalChatTurn('k3-owner', 'again', new AbortController().signal, cli, undefined, (delta) => { pids.push(delta); });
    expect(pids[1]).toBe(pids[0]);
    expect(localChatChildOwner('k3-owner')).toEqual(owner);
    await closeLocalChatSession('k3-owner');
    expect(localChatChildOwner('k3-owner')).toBeNull();
  } finally {
    await closeLocalChatSession('k3-owner');
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
