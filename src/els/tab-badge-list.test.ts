// ELS-TAB-STATE-BADGE — the stalled badge through the real server list path (startElsServer + a pane + the list op),
// then through every client that draws the list: `els ls` lines, the TUI sidetab rows and the els app's space list.
// Time is the server's injected clock (`now` option), never a wait.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paneListLines } from '../cli/els-cli.js';
import { elsRowsFromList } from '../tui/sidetab/els-rows.js';
import { parsePaneRows } from './attach-view.js';
import { requestEls } from './client.js';
import type { ElsPty } from './core.js';
import { elsSocketPath, startElsServer } from './server.js';
import { buildSpaceList, withCommands } from './space-tabs-view.js';

// SOCKET_SAFE_TMP: a Unix socket path holds at most 103 bytes (macOS), a long TMPDIR falls back to /tmp.
const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const T0 = 1_700_000_000_000;
const STALL_WINDOW_MS = 900_000; // 15 minutes — STALLED_AFTER_MS_DEFAULT, written as a literal on purpose.

async function boot() {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-tb-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const clock = { at: T0 };
  const pty = { lastOutput: undefined as number | undefined };
  const stub: ElsPty = { id: 'pty_1', isAlive: () => true, write: () => {}, renderScreen: async () => 'ready\n', onExit: () => {}, kill: () => {}, resize: () => {},
    lastOutputAt: () => pty.lastOutput };
  const started = await startElsServer({ stateRoot: root, spawn: () => stub, now: () => clock.at, stall: false });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  const socket = elsSocketPath(root);
  const created = await requestEls(socket, { op: 'new', ws: 'OP', cwd: '/work', command: ['sh'] });
  expect(created.exitCode).toBe(0);
  const list = async (): Promise<string> => (await requestEls(socket, { op: 'ls' })).message;
  return { clock, pty, list };
}

test('a working pane with no output for the stall window is stalled in the list, `els ls`, the sidetab and the space list', async () => {
  const { clock, pty, list } = await boot();
  const fresh = await list();
  expect((JSON.parse(fresh) as { panes: { badge: string; stalled: boolean }[] }).panes.map((row) => [row.badge, row.stalled])).toEqual([['working', false]]);
  expect(paneListLines(fresh, clock.at)[0]).toContain('[▶ working]');
  expect(elsRowsFromList(fresh, 'node-c')[0]!.agentState).toBe('working');

  clock.at = T0 + STALL_WINDOW_MS + 1;
  const quiet = await list();
  expect((JSON.parse(quiet) as { panes: { badge: string; stalled: boolean; lastEventAtMs: number }[] }).panes.map((row) => [row.badge, row.stalled, row.lastEventAtMs])).toEqual([['stalled', true, T0]]);
  expect(paneListLines(quiet, clock.at)[0]).toContain('[⏸ stalled]');
  // The tree (workspace → tab → pane) carries the stalled state on the pane and on both headers above it.
  expect(elsRowsFromList(quiet, 'node-c').map((row) => [row.badge, row.agentState])).toEqual([['busy', 'stalled'], ['busy', 'stalled'], ['busy', 'stalled']]);
  // The selected space line is drawn in reverse video; the mark is what is asserted.
  expect(buildSpaceList(withCommands(parsePaneRows(quiet), quiet), undefined, 40, 4)[1]).toContain(' ⏸ OP');

  // Output is an event: the pane is working again, the window restarts from the output.
  pty.lastOutput = clock.at;
  const revived = await list();
  expect((JSON.parse(revived) as { panes: { badge: string }[] }).panes.map((row) => row.badge)).toEqual(['working']);
  expect(paneListLines(revived, clock.at)[0]).toContain('[▶ working]');
});

test('one millisecond short of the window is still working', async () => {
  const { clock, list } = await boot();
  clock.at = T0 + STALL_WINDOW_MS;
  expect((JSON.parse(await list()) as { panes: { badge: string }[] }).panes.map((row) => row.badge)).toEqual(['working']);
});

test('a list from a server that sends only lastEventAtMs still reads stalled in `els ls` (the client applies the rule)', () => {
  const legacy = JSON.stringify({ panes: [{ address: 'h:w/t1/p1', title: 'sh', state: 'working', cwd: '/work', lastEventAtMs: T0 }] });
  expect(paneListLines(legacy, T0 + STALL_WINDOW_MS + 1)[0]).toContain('[⏸ stalled]');
  expect(paneListLines(legacy, T0 + STALL_WINDOW_MS)[0]).toContain('[▶ working]');
});
