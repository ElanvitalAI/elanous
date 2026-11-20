// ELS-DESKTOP-SIDETAB-SUBSCRIBE ② «서버 트리»: the Els section of the side panel is the workspace → tab → pane TREE, one row per
// node, indented by depth. Nothing is rebuilt here: a real els server (scripted PTY) lists two workspaces with two tabs each, the
// real federation adds a remote host, and the production chain (fetchElsSidetabRows → groupSidetabSections →
// formatSidetabSectionFrame, the function that turns rows into the panel's screen lines) draws it. The assertions read the lines.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestEls } from '../../els/client.js';
import { createFederation } from '../../els/federation.js';
import { elsSocketPath, startElsServer } from '../../els/server.js';
import { fetchElsSidetabRows } from './els-rows.js';
import { formatSidetabSectionFrame, groupSidetabSections } from './sections.js';

// The train TMPDIR is long and a Unix socket path is limited (103 bytes): the state dir lives under /tmp then.
const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** One panel line → its status word, tree depth (2 columns per level after the status word) and text. */
const WORDS = ['busy', 'idle', 'exited', 'stale', 'unknown', 'working', 'blocked', 'done', 'stalled'] as const;
const nodeOf = (line: string): { word: string; depth: number; text: string } => {
  const match = /^ [› ] (\S+) ( *)(.*?)\s*$/.exec(line);
  if (!match || !(WORDS as readonly string[]).includes(match[1]!)) throw new Error(`not a tree line: ${JSON.stringify(line)}`);
  return { word: match[1]!, depth: match[2]!.length / 2, text: match[3]! };
};

test('the Els section draws ws → tab → pane as an indented tree; a remote host is its own ⇄ subtree; a silent host is one ✕ line', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-tree-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  let spawned = 0;
  const started = await startElsServer({ stateRoot: root, spawn: () => ({ id: `pty_${++spawned}`, isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => {} }) });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  const askLocal = (request: Parameters<typeof requestEls>[1]) => requestEls(elsSocketPath(root), request);
  // Interleaved on purpose: a flat creation-order list would put a2 after b1.
  for (const [ws, title] of [['alpha', 'a1'], ['beta', 'b1'], ['alpha', 'a2'], ['beta', 'b2']] as const) {
    expect((await askLocal({ op: 'new', ws, cwd: '/work', command: ['sh'], title })).exitCode).toBe(0);
  }
  const remoteBody = { host: 'minim5', panes: [
    { ws: 'w9', tab: 't9', pane: 'p9', title: 'remote-parent', cwd: '/', state: 'working' },
    { ws: 'w9', tab: 't10', pane: 'p10', title: 'remote-child', cwd: '/', state: 'blocked' }] };
  const rows = await fetchElsSidetabRows({ localHost: 'node-b', list: () => createFederation({ localHost: 'node-b', askLocal,
    registry: { hosts: [{ name: 'minim5', baseUrl: 'http://100.64.0.2:8790' }, { name: 'aws1', baseUrl: 'http://100.64.0.3:8790' }], rejected: [] },
    fetchJson: async (host) => { if (host.name === 'aws1') throw new Error('timeout'); return { status: 200, body: remoteBody }; } }).list() });

  const sections = groupSidetabSections(rows);
  expect(sections.map((section) => section.id)).toEqual(['els']);
  const lines = formatSidetabSectionFrame(rows, 0, 60, 40).lines;
  const start = lines.findIndex((line) => line.includes('Els · 17'));
  const tree = lines.slice(start + 1).filter((line) => !line.includes('+ new')).map(nodeOf);

  // This host: no header (the headquarters carries no mark); workspace (depth 0) → tab (1) → pane (2), server order inside each workspace.
  const local = tree.slice(0, 10).map((node) => [node.depth, node.text]);
  expect(local).toEqual([
    [0, 'alpha'], [1, rows[1]!.label.trim()], [2, 'a1'], [1, rows[3]!.label.trim()], [2, 'a2'],
    [0, 'beta'], [1, rows[6]!.label.trim()], [2, 'b1'], [1, rows[8]!.label.trim()], [2, 'b2'],
  ]);
  // The remote host heads its own subtree one level in, with ⇄; it follows every local line; the status word of a header is its most urgent child.
  expect(tree.slice(10).map((node) => [node.depth, node.text, node.word])).toEqual([
    [0, '⇄minim5', 'blocked'], [1, 'w9', 'blocked'], [2, 't9', 'working'], [3, 'remote-parent', 'working'], [2, 't10', 'blocked'], [3, 'remote-child', 'blocked'],
    [0, '✕ ⇄aws1 · 연결 끊김', 'stale'],
  ]);
  // The row model is unchanged for consumers: panes keep `els:<address>` ids (click / send / read), headers have none; remote rows keep remoteHost.
  expect(rows.filter((row) => row.id.startsWith('els:')).map((row) => row.label.trim())).toEqual(['a1', 'a2', 'b1', 'b2', 'remote-parent', 'remote-child']);
  expect(rows.filter((row) => row.remoteHost === 'minim5').length).toBe(6);
  expect(rows.at(-1)).toMatchObject({ id: 'els-host:aws1', remoteHost: 'aws1', badge: 'stale' });
}, 60_000); // 출처: real els server start + two federation fetch stubs; same bound as els-rows-tree on #39217

// ELS-TAB-STATE-BADGE × tree: a header's summary state follows the SAME precedence as markOf in src/els/space-tabs-view.ts —
// failed/blocked outrank stalled, stalled outranks working, then working > idle > done. A pane row keeps its own state.
test('a tree header over a stalled descendant shows stalled; blocked outranks stalled; plain working stays working; pane rows keep their own state and address', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-tree-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const T0 = 1_700_000_000_000;
  const STALL_WINDOW_MS = 900_000; // 15 minutes — STALLED_AFTER_MS_DEFAULT, written as a literal on purpose.
  const clock = { at: T0 };
  const lastOutput = new Map<string, number | undefined>();
  let spawned = 0;
  const started = await startElsServer({ stateRoot: root, now: () => clock.at, stall: false, spawn: () => {
    const id = `pty_${++spawned}`;
    return { id, isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => {}, resize: () => {}, lastOutputAt: () => lastOutput.get(id) };
  } });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  const askLocal = (request: Parameters<typeof requestEls>[1]) => requestEls(elsSocketPath(root), request);
  // pty_1 (alpha/quiet) never outputs → stalled once the window passes; pty_2 (alpha/busy) and pty_3 (beta/solo) output at the end → working.
  for (const [ws, title] of [['alpha', 'quiet'], ['alpha', 'busy'], ['beta', 'solo']] as const) {
    expect((await askLocal({ op: 'new', ws, cwd: '/work', command: ['sh'], title })).exitCode).toBe(0);
  }
  clock.at = T0 + STALL_WINDOW_MS + 1;
  lastOutput.set('pty_2', clock.at);
  lastOutput.set('pty_3', clock.at);
  // The remote workspace holds a blocked pane and a stalled-working pane (the host's own verdict, carried by federation).
  const remoteBody = { host: 'minim5', panes: [
    { ws: 'w9', tab: 't1', pane: 'p1', title: 'remote-blocked', cwd: '/', state: 'blocked' },
    { ws: 'w9', tab: 't2', pane: 'p2', title: 'remote-quiet', cwd: '/', state: 'working', stalled: true, lastEventAtMs: T0 }] };
  const rows = await fetchElsSidetabRows({ localHost: 'node-b', list: () => createFederation({ localHost: 'node-b', askLocal,
    registry: { hosts: [{ name: 'minim5', baseUrl: 'http://100.64.0.2:8790' }], rejected: [] },
    fetchJson: async () => ({ status: 200, body: remoteBody }) }).list() });

  const stateOf = (label: string) => rows.find((row) => row.label.trim() === label && !row.id.startsWith('els-tab:'))?.agentState;
  expect(stateOf('alpha')).toBe('stalled');   // {working, stalled} → stalled
  expect(stateOf('beta')).toBe('working');    // {working} → working
  expect(stateOf('w9')).toBe('blocked');      // {blocked, stalled} → blocked
  expect(stateOf('⇄minim5')).toBe('blocked');
  // Pane rows keep their own state, and still resolve their els address; headers have none.
  expect(stateOf('quiet')).toBe('stalled');
  expect(stateOf('busy')).toBe('working');
  expect(stateOf('solo')).toBe('working');
  expect(stateOf('remote-quiet')).toBe('stalled');
  expect(stateOf('remote-blocked')).toBe('blocked');
  const paneRow = rows.find((row) => row.label.trim() === 'quiet' && row.id.startsWith('els:'))!;
  expect(paneRow.id).toMatch(/^els:/);
  expect(rows.filter((row) => !row.id.startsWith('els:')).every((row) => !row.id.includes('/p'))).toBe(true);
  expect(rows.find((row) => row.label.trim() === 'alpha')!.id.startsWith('els-ws:')).toBe(true);
}, 60_000);
