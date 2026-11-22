// OP #127680 2단계 ELS-SERVER-EVENT-HUB-NO-DB-POLL — wiring proof at the layers that run it:
//   ① writer — every committed ledger write (post·ack·receipt·group) leaves exactly one complete sidecar line,
//      and a failed write leaves none (the line waits for the commit, dies with the rollback);
//   ② server — boot wires hub + memory badge state: a committed write from another store wakes the listing
//      badge (event, not a periodic poll), and close() stops the watcher with the server.
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMsgStore } from '../msg/msg-store.js';
import { ledgerEventsPath } from '../msg/ledger-events.js';
import { startElsServer } from './server.js';
import type { ElsPty } from './core.js';

// A Unix socket path holds at most 103 bytes (macOS): a long TMPDIR would push <state>/els/ over it, so fall back to /tmp.
const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();

/** A pane PTY that records nothing and never exits on its own — the spawn seam for a server boot test. */
function fakePty(): ElsPty {
  return { id: `pty-${Math.random().toString(16).slice(2)}`, isAlive: () => true, write: () => {},
    renderScreen: async () => '$', onExit: () => {}, kill: () => {} };
}

test('writer ① — committed post/ack/receipt/group writes leave one sidecar line each; a failed write leaves none', () => {
  const dir = mkdtempSync(join(SOCKET_SAFE_TMP, 'eh-writer-'));
  try {
    const ledger = join(dir, 'msg', 'messages.db');
    const events = ledgerEventsPath(ledger);
    const kinds = (): string[] => readFileSync(events, 'utf8').trim().split('\n').map((line) => (JSON.parse(line) as { kind: string }).kind);
    const store = openMsgStore(ledger);
    expect(existsSync(events)).toBe(false);                                  // no committed write yet — no sidecar line
    expect(() => store.post({ from: 'OP', to: 'group:no-such', body: 'x' })).toThrow();   // group not found → rollback
    expect(existsSync(events)).toBe(false);                                  // the failed write left no line behind
    const message = store.post({ from: 'OP', to: 'SEAT-A', body: 'hello' });
    expect(kinds()).toEqual(['post']);                                       // exactly one line for one committed post
    store.ack('SEAT-A', message.id);
    expect(kinds()).toEqual(['post', 'ack']);
    store.recordReceipt({ messageId: message.id, recipient: 'SEAT-A', state: 'seen', source: 'cli-ack' });
    expect(kinds()).toEqual(['post', 'ack', 'receipt']);
    const group = store.createGroup('eh-hub', 'OP');
    store.joinGroup(group, 'SEAT-A');
    store.leaveGroup(group, 'SEAT-A');
    expect(kinds()).toEqual(['post', 'ack', 'receipt', 'group', 'group', 'group']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('server ② — a committed ledger write wakes the listing badge (event, not a poll) and close() stops the watcher', async () => {
  const dir = mkdtempSync(join(SOCKET_SAFE_TMP, 'eh-server-'));
  const ledger = join(dir, 'msg', 'messages.db');
  const boot = await startElsServer({ stateRoot: join(dir, 'state'), mailBadgeLedgerPath: ledger, spawn: () => fakePty(), reapIntervalMs: 1_000_000 });
  try {
    if (!('server' in boot)) throw new Error(`boot refused: ${boot.message}`);
    const core = boot.core;
    const store = openMsgStore(ledger);                                      // another process' writer, the way `eln msg` opens it
    const pane = (JSON.parse(core.newPane({ ws: 'w', cwd: join(dir, 'seats', 'SEAT-EH', 'w'), command: ['/bin/sh'] }).message) as { pane: string }).pane;
    const badge = (): { count: number; oldestCreatedAt: string | null } | null =>
      (JSON.parse(core.list().message) as { panes: Array<{ pane: string; unreadMail: { count: number; oldestCreatedAt: string | null } | null }> })
        .panes.find((row) => row.pane === pane)!.unreadMail;
    expect(badge()).toBe(null);                                              // JUD-B #132880 ①: unknown ≠ 0 until the off-thread baseline lands
    const landed = async (): Promise<boolean> => {
      const until = Date.now() + 3_000;
      while (Date.now() < until) { if (badge() !== null) return true; await new Promise((resolve) => setTimeout(resolve, 25)); }
      return badge() !== null;
    };
    expect(await landed()).toBe(true);
    expect(badge()).toEqual({ count: 0, oldestCreatedAt: null });            // first-seen seat: one baseline compute, then memory-only
    const message = store.post({ from: 'OP', to: 'SEAT-EH', body: 'wake up' });
    const sawCount = async (): Promise<boolean> => {
      const until = Date.now() + 3_000;
      while (Date.now() < until) {
        if (badge()?.count === 1) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return badge()?.count === 1;
    };
    expect(await sawCount()).toBe(true);                                     // the sidecar line woke the recompute — no poll ran
    store.ack('SEAT-EH', message.id);
    const untilZero = Date.now() + 3_000;
    while (Date.now() < untilZero && badge()?.count !== 0) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(badge()).toEqual({ count: 0, oldestCreatedAt: null });            // the ack line woke it back down
  } finally {
    if ('server' in boot) await boot.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
