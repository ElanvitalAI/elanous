import { expect, test } from 'bun:test';
import type { AttachHandlers, Attached } from './attach-client.js';
import { createAttachApp } from './attach-app.js';
import { createKeyRouter, type KeyAction } from './attach-keys.js';
import { buildSidebar, composeView, parsePaneRows, parseRemoteRows, wordOfState } from './attach-view.js';
import type { ElsResult } from './core.js';
import type { ElsRequest } from './server.js';

const row = (ws: string, pane: string, title: string, state: string) => ({ address: `${ws}/t1/${pane}`, workspace: `name-${ws}`, pane, title, state });
const listOf = (...panes: object[]): string => JSON.stringify({ workspaces: [], tabs: [], panes });
const plain = (text: string): string => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');

test('key router: plain text is input; ctrl+b then a herdr key is an action; ctrl+b ctrl+b is a literal ctrl+b; Esc cancels; the prefix survives a split read', () => {
  const router = createKeyRouter();
  expect(router.feed('ls\r')).toEqual([{ kind: 'input', bytes: 'ls\r' }]);
  expect(router.feed('ab\u0002jcd')).toEqual([{ kind: 'input', bytes: 'ab' }, { kind: 'action', action: 'next' }, { kind: 'input', bytes: 'cd' }]);
  expect(router.feed('\u0002')).toEqual([]);
  expect(router.feed('k')).toEqual([{ kind: 'action', action: 'previous' }]);
  expect(router.feed('\u0002\u0002')).toEqual([{ kind: 'input', bytes: '\u0002' }]);
  expect(router.feed('\u0002\u001bq')).toEqual([{ kind: 'input', bytes: 'q' }]);
  expect(router.feed('\u00023')).toEqual([{ kind: 'action', action: 'goto', n: 3 }]);
  expect(router.feed('\u0002z')).toEqual([{ kind: 'unknown', key: 'z' }]);
  const keyed: [string, KeyAction][] = [['q', 'detach'], ['n', 'next'], ['p', 'previous'], ['w', 'next-workspace'], ['b', 'toggle-sidebar'], ['c', 'new'], ['N', 'new-workspace'], ['x', 'close'], ['D', 'close-workspace'], ['?', 'help']];
  for (const [key, action] of keyed) expect(router.feed(`\u0002${key}`)).toEqual([{ kind: 'action', action }]);
});

test('pane rows come from an els list; anything else is no rows; exited reads as done', () => {
  expect(parsePaneRows(listOf(row('w1', 'p1', 'shell', 'working'))).map((r) => [r.pane, r.wsId, r.workspace, r.title, r.state])).toEqual([['p1', 'w1', 'name-w1', 'shell [build unknown]', 'working']]);
  for (const body of ['null', '7', '"x"', '[]', '{"panes":3}', 'not json']) expect(parsePaneRows(body)).toEqual([]);
  expect([wordOfState('working'), wordOfState('blocked'), wordOfState('idle'), wordOfState('exited'), wordOfState('')]).toEqual(['working', 'blocked', 'idle', 'done', 'done']);
});

test('sidebar: workspace line with its rolled-up mark and «⎇n ●n», pane lines with the status mark in the shared colour, selected in reverse, exited dimmed', () => {
  const rows = parsePaneRows(listOf(row('w1', 'p1', 'build', 'working'), row('w1', 'p2', 'old', 'exited'), row('w2', 'p3', 'repl', 'idle')));
  const lines = buildSidebar(rows, 'p1', 28, 6);
  expect(lines).toHaveLength(6);
  expect(lines.map(plain)).toEqual([' ▾ ● name-w1 ⎇2 ●1          ', '    ● build [build unknown] ', '    ✓ old [build unknown]   ', ' ▾ ○ name-w2                ', '    ○ repl [build unknown]  ', ' '.repeat(28)]);
  expect(lines[1]).toContain('\u001b[7m');                     // the selected row is reverse video
  expect(lines[1]).toContain('\u001b[32m●');                   // working = green mark
  expect(lines[2]).toContain('\u001b[2m');                     // exited = dim
  expect(lines[4]).toContain('\u001b[2m○');                    // idle = dim mark
});

test('compose: sidebar | pane with the pane colours kept, the cursor placed at the pane cursor, the sidebar dropped under 60 columns', () => {
  const frame = '[screen 40x5 cursor=(row 1, col 3, visible true)]\n\u001b[31mred\u001b[0m text\nsh$ ';
  const wide = composeView({ cols: 70, rows: 4, sidebar: ['SIDE'.padEnd(28), ...Array(3).fill(' '.repeat(28))], frame, status: ' status ' });
  expect(plain(wide).split('\r\n')[0]!.startsWith(`SIDE${' '.repeat(24)}│red text`)).toBe(true);
  expect(wide).toContain('\u001b[31mred');
  expect(wide.endsWith('\u001b[2;33H\u001b[?25h')).toBe(true);   // row 1+1, column 28 sidebar + 1 separator + col 3 + 1
  const narrow = composeView({ cols: 50, rows: 4, sidebar: ['SIDE'.padEnd(28)], frame, status: ' s ' });
  expect(plain(narrow)).not.toContain('SIDE');
  expect(narrow.endsWith('\u001b[2;4H\u001b[?25h')).toBe(true);
  expect(composeView({ cols: 70, rows: 4, sidebar: null, frame: '[screen 40x5 cursor=(row 0, col 0, visible false)]\nx', status: 's' }).endsWith('\u001b[?25l')).toBe(true);
});

// ---- the controller, with a scripted server and a fake attach ----------------------------------------------------------
function harness(initial: string, size = { cols: 80, rows: 24 }, remembered: { sidebar?: boolean; lastPane?: string } = {}, sidebar?: boolean) {
  const saved: { sidebar: boolean; lastPane?: string }[] = [];
  let listing = initial;
  const requests: ElsRequest[] = [];
  const attachments: { pane: string; size: { cols: number; rows: number }; handlers: AttachHandlers; typed: string[]; resizes: [number, number][]; detached: boolean }[] = [];
  const writes: string[] = [];
  let created = 0;
  const app = createAttachApp({
    request: async (request): Promise<ElsResult> => {
      requests.push(request);
      if (request.op === 'ls') return { exitCode: 0, message: listing };
      if (request.op === 'new') {
        created++;
        const pane = `pnew${created}`;
        listing = JSON.stringify({ panes: [...(JSON.parse(listing) as { panes: object[] }).panes, row(`wn${created}`, pane, 'fresh', 'working')] });
        return { exitCode: 0, message: JSON.stringify({ pane }) };
      }
      if (request.op === 'close') {
        listing = JSON.stringify({ panes: (JSON.parse(listing) as { panes: { pane: string }[] }).panes.filter((p) => p.pane !== request.pane) });
        return { exitCode: 0, message: 'closed' };
      }
      return { exitCode: 0, message: '' };
    },
    attach: (pane, paneSize, handlers): Attached => {
      const entry = { pane, size: paneSize, handlers, typed: [] as string[], resizes: [] as [number, number][], detached: false };
      attachments.push(entry);
      return { input: (bytes) => { entry.typed.push(bytes); }, resize: (cols, rows) => { entry.resizes.push([cols, rows]); }, detach: () => { entry.detached = true; } };
    },
    write: (text) => { writes.push(text); },
    size: () => size,
    cwd: '/work/proj',
    env: { SHELL: '/bin/zsh' },
    setInterval: () => 0,
    clearInterval: () => {},
    pollMs: 1000,
    chatCommand: ['/opt/elanous/bin/elanous'],
    memory: { load: () => remembered, save: (state) => { saved.push(state); } },
    ...(sidebar === undefined ? {} : { sidebar }),
  });
  return { app, saved, requests, attachments, writes, setListing: (next: string) => { listing = next; }, lastScreen: () => plain(writes.at(-1) ?? '') };
}

test('app: an empty server gets one new shell (defaults: $SHELL, this folder, folder-named workspace) and the view attaches to it at the pane size', async () => {
  const h = harness(listOf());
  await h.app.start();
  expect(h.requests.find((r) => r.op === 'new')).toEqual({ op: 'new', ws: 'proj', cwd: '/work/proj', command: ['/bin/zsh'] });
  expect(h.attachments.map((a) => a.pane)).toEqual(['pnew1']);
  expect(h.attachments[0]!.size).toEqual({ cols: 51, rows: 22 });      // 80 - 28 sidebar - 1 separator; 24 - 1 status line - 1 tab row
});

test('app: starts on the first pane that is still running; exited panes stay in the list (dimmed), never closed on their own (ELS-FIRST-RUN-LIVE-PANE)', async () => {
  const h = harness(listOf(row('w1', 'old1', 'dead', 'exited'), row('w1', 'live', 'work', 'idle'), row('w2', 'old2', 'dead2', 'exited')));
  await h.app.start();
  expect(h.requests.filter((r) => r.op === 'close')).toEqual([]);
  expect(h.attachments.map((a) => a.pane)).toEqual(['live']);
  expect(h.lastScreen()).toContain('dead');                         // the exited tab is still there, dimmed
});

test('app: every pane exited (els reopened after the last shell ended) → a fresh $SHELL pane in this folder\'s space is opened and attached, not the exited one (ELS-FIRST-RUN-LIVE-PANE)', async () => {
  const h = harness(listOf(row('proj', 'gone', 'zsh', 'exited')), undefined, { lastPane: 'gone' });
  await h.app.start();
  expect(h.requests.filter((r) => r.op === 'new')).toEqual([{ op: 'new', ws: 'proj', cwd: '/work/proj', command: ['/bin/zsh'] }]);
  expect(h.attachments.map((a) => a.pane)).toEqual(['pnew1']);
  expect(h.requests.filter((r) => r.op === 'close')).toEqual([]);
});

test('app: keys — input goes to the pane; ctrl+b j/k and 1-9 move between the tabs of the space, w to the next space (old attach released); b hides the list', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle'), row('w1', 'p2', 'two', 'idle'), row('w2', 'p3', 'three', 'idle')));
  await h.app.start();
  h.app.key('ls\r');
  expect(h.attachments[0]!.typed).toEqual(['ls\r']);
  h.app.key('\u0002w');
  expect(h.attachments.map((a) => a.pane)).toEqual(['p1', 'p2']);
  expect(h.attachments[0]!.detached).toBe(true);
  h.app.key('\u0002w');                                           // wraps inside w1, never into w2
  expect(h.attachments.at(-1)!.pane).toBe('p1');
  h.app.key('\u0002w');
  expect(h.attachments.at(-1)!.pane).toBe('p3');
  h.app.key('\u0002k');                                           // w2 has one tab: stays
  expect(h.attachments.map((a) => a.pane)).toEqual(['p1', 'p2', 'p1', 'p3']);
  h.app.key('\u0002w');
  h.app.key('\u00022');                                           // the second tab of w1
  expect(h.attachments.at(-1)!.pane).toBe('p2');
  expect(h.lastScreen().split('\r\n')[0]).toContain('│🛠 one  🛠 two  +');   // FU3: «emoji name» tabs, focus = reverse video
  h.app.key('\u0002b');
  expect(h.attachments.at(-1)!.resizes.at(-1)).toEqual([80, 22]);
  expect(h.lastScreen()).not.toContain('+ new · ≡ menu');
});

test('app: frames from a stale attach are ignored after a switch; the current frame is painted next to the list', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle'), row('w1', 'p2', 'two', 'idle')));
  await h.app.start();
  h.app.key('\u0002w');
  h.attachments[0]!.handlers.onFrame({ pane: 'p1', seq: 1, cols: 51, rows: 23, screen: '[screen 51x23 cursor=(row 0, col 0, visible true)]\nSTALE' });
  h.attachments[1]!.handlers.onFrame({ pane: 'p2', seq: 1, cols: 51, rows: 23, screen: '[screen 51x23 cursor=(row 0, col 2, visible true)]\nfresh$ ' });
  const screen = h.lastScreen();
  expect(screen).toContain('fresh$');
  expect(screen).not.toContain('STALE');
  expect(screen).toContain('name-w1');
});

test('app: c opens a pane in the current workspace, N a new workspace named after the folder (suffix when taken), x asks first and closes only on y, D likewise for the workspace', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle')));
  await h.app.start();
  h.app.key('\u0002c');
  await Bun.sleep(20);
  expect(h.requests.filter((r) => r.op === 'new').at(-1)).toEqual({ op: 'new', ws: 'name-w1', cwd: '/work/proj', command: ['/bin/zsh'] });
  expect(h.attachments.at(-1)!.pane).toBe('pnew1');
  h.app.key('\u0002N');
  await Bun.sleep(20);
  expect(h.requests.filter((r) => r.op === 'new').at(-1)).toMatchObject({ ws: 'proj' });
  h.app.key('\u0002x');
  expect(h.lastScreen()).toContain('닫기?');
  const closesBefore = h.requests.filter((r) => r.op === 'close').length;
  h.app.key('n');
  await Bun.sleep(20);
  expect(h.requests.filter((r) => r.op === 'close')).toHaveLength(closesBefore);
  expect(h.lastScreen()).toContain('취소');
  h.app.key('\u0002x');
  h.app.key('y');
  await Bun.sleep(20);
  expect(h.requests.filter((r) => r.op === 'close')).toHaveLength(closesBefore + 1);
  h.app.key('\u0002D');
  expect(h.lastScreen()).toContain('작업공간');
  h.app.key('y');
  await Bun.sleep(20);
  expect(h.requests.some((r) => r.op === 'close-workspace')).toBe(true);
});

test('app: ctrl+b q detaches with code 0 and releases the attach without closing anything; an unknown prefix key is said, not typed', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle')));
  await h.app.start();
  h.app.key('\u0002z');
  expect(h.lastScreen()).toContain('ctrl+b z 는 아직 없음');
  expect(h.attachments[0]!.typed).toEqual([]);
  h.app.key('\u0002q');
  expect(await h.app.done).toEqual({ code: 0, message: '' });
  expect(h.attachments[0]!.detached).toBe(true);
  expect(h.requests.some((r) => r.op === 'close' || r.op === 'close-workspace')).toBe(false);
});

test('app: the selected pane exits with another pane left → the focus moves to it (ELS-LAST-TAB-EXIT); the server going away ends the app with code 1', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle'), row('w1', 'p2', 'two', 'idle')));
  await h.app.start();
  h.setListing(listOf(row('w1', 'p1', 'one', 'exited'), row('w1', 'p2', 'two', 'idle')));
  h.attachments[0]!.handlers.onEnd(0, 'pane exited');
  expect(h.attachments.at(-1)!.pane).toBe('p2');
  expect(h.lastScreen()).toContain('pane 종료됨');
  h.attachments.at(-1)!.handlers.onEnd(1, 'els: the els server closed the connection');
  expect(await h.app.done).toEqual({ code: 1, message: 'els: the els server closed the connection' });
});

test('app: the last pane exits → the els view closes with code 0 (back to the terminal), like herdr; nothing is closed on the server (ELS-LAST-TAB-EXIT)', async () => {
  const h = harness(listOf(row('w1', 'p1', 'only', 'idle')));
  await h.app.start();
  h.attachments[0]!.handlers.onEnd(0, 'pane exited');
  expect(await h.app.done).toEqual({ code: 0, message: '' });
  expect(h.requests.filter((r) => r.op === 'close' || r.op === 'close-workspace')).toEqual([]);
});

test('toggle: ctrl+b s hides and shows the list (the pane is resized each time) and the choice is remembered', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle')));
  await h.app.start();
  expect(h.lastScreen()).toContain('+ new · ≡ menu');
  h.app.key('\u0002s');
  expect(h.lastScreen()).not.toContain('+ new · ≡ menu');
  expect(h.attachments[0]!.resizes.at(-1)).toEqual([80, 22]);
  expect(h.saved.at(-1)).toEqual({ sidebar: false, lastPane: 'p1' });
  h.app.key('\u0002s');
  expect(h.lastScreen()).toContain('+ new · ≡ menu');
  expect(h.attachments[0]!.resizes.at(-1)).toEqual([51, 22]);
  expect(h.saved.at(-1)).toEqual({ sidebar: true, lastPane: 'p1' });
});

test('start state: --no-side beats a remembered open list, a remembered closed list stays closed, nothing remembered = open (els)', async () => {
  const listing = listOf(row('w1', 'p1', 'one', 'idle'));
  const first = (h: ReturnType<typeof harness>) => h.lastScreen().includes('+ new · ≡ menu');
  const a = harness(listing, undefined, { sidebar: true }, false); await a.app.start(); expect(first(a)).toBe(false);
  const b = harness(listing, undefined, { sidebar: false }); await b.app.start(); expect(first(b)).toBe(false);
  const c = harness(listing, undefined, { sidebar: false }, true); await c.app.start(); expect(first(c)).toBe(true);
  const d = harness(listing); await d.app.start(); expect(first(d)).toBe(true);
});

test('start pane: the remembered last pane if it still runs, else the first running one; the choice is remembered when the view moves', async () => {
  const listing = listOf(row('w1', 'p1', 'one', 'idle'), row('w1', 'p2', 'two', 'idle'));
  const a = harness(listing, undefined, { lastPane: 'p2' }); await a.app.start();
  expect(a.attachments.map((x) => x.pane)).toEqual(['p2']);
  const b = harness(listing, undefined, { lastPane: 'gone' }); await b.app.start();
  expect(b.attachments.map((x) => x.pane)).toEqual(['p1']);
  const c = harness(listOf(row('w1', 'p1', 'one', 'exited'), row('w1', 'p2', 'two', 'idle')), undefined, { lastPane: 'p1' }); await c.app.start();
  expect(c.attachments.map((x) => x.pane)).toEqual(['p2']);
  a.app.key('\u0002k');
  expect(a.saved.at(-1)).toEqual({ sidebar: true, lastPane: 'p1' });
});

test('chat pane: ctrl+b a opens an elanous chat pane (this install\'s elanous, titled «elanous») in the current workspace and shows it', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle')));
  await h.app.start();
  h.app.key('\u0002a');
  await Bun.sleep(20);
  expect(h.requests.filter((r) => r.op === 'new').at(-1)).toEqual({ op: 'new', ws: 'name-w1', cwd: '/work/proj', command: ['/opt/elanous/bin/elanous'], title: 'elanous' });
  expect(h.attachments.at(-1)!.pane).toBe('pnew1');
});

test('quit while a request is in flight: a pane created / a close answered after ctrl+b q starts no attach, writes no memory and paints nothing', async () => {
  for (const key of ['\u0002c', '\u0002a', '\u0002N']) {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const attachments: string[] = [];
    const saved: unknown[] = [];
    const writes: string[] = [];
    const listing = listOf(row('w1', 'p1', 'one', 'idle'));
    const app = createAttachApp({
      request: async (request): Promise<ElsResult> => {
        if (request.op === 'new') { await gate; return { exitCode: 0, message: JSON.stringify({ pane: 'late' }) }; }
        return { exitCode: 0, message: request.op === 'ls' ? listing : '' };
      },
      attach: (pane): Attached => { attachments.push(pane); return { input: () => {}, resize: () => {}, detach: () => {} }; },
      write: (text) => { writes.push(text); },
      size: () => ({ cols: 80, rows: 24 }),
      cwd: '/work/proj', env: { SHELL: '/bin/zsh' },
      setInterval: () => 0, clearInterval: () => {}, pollMs: 1000,
      chatCommand: ['/opt/elanous/bin/elanous'],
      memory: { load: () => ({}), save: (state) => { saved.push(state); } },
    });
    await app.start();
    expect(attachments).toEqual(['p1']);
    app.key(key);                       // the request is now waiting on the gate
    app.key('\u0002q');
    expect(await app.done).toEqual({ code: 0, message: '' });
    const savedBefore = saved.length;
    const writesBefore = writes.length;
    release();
    await Bun.sleep(30);
    expect([key, attachments]).toEqual([key, ['p1']]);
    expect([key, saved.length, writes.length]).toEqual([key, savedBefore, writesBefore]);
  }
});

// ---- ELS-ONE-SPACE ①: the other hosts' panes (herdr, registered els hosts) in the same list, read-only -------------------
const fedRow = (host: string, ws: string, tab: string, pane: string, title: string, state: string, reach = 'up') =>
  ({ ws, tab, pane, title, cwd: '/x', state, host, reach, address: `${host}:${ws}/${tab}/${pane}` });
const fedList = (...panes: object[]): string => JSON.stringify({ hosts: [], workspaces: [], tabs: [], panes });

test('remote rows: only panes of other hosts that answered, grouped «⇄host label» (herdr titles split at « · »), the address is the pane', () => {
  const rows = parseRemoteRows(fedList(
    fedRow('Mac', 'w9', 't1', 'p1', 'local one', 'idle', 'local'),
    fedRow('herdr', 'w1', 't2', 'p2', 'OP · mshq 주 OP', 'idle'),
    fedRow('herdr', 'w1', 't2', 'p3', 'OP · zsh', 'working'),
    fedRow('node-b', 'wa', 'tb', 'pc', 'review', 'blocked'),
    fedRow('down1', 'wz', 'tz', 'pz', 'gone', 'idle', 'down')));
  expect(rows.map((r) => `${r.pane} | ${r.wsId} | ${r.workspace} | ${r.title} | ${r.state} | ${r.remote}`)).toEqual([
    'herdr:w1/t2/p2 | herdr:w1 | ⇄herdr OP | mshq 주 OP [build unknown] | idle | herdr',
    'herdr:w1/t2/p3 | herdr:w1 | ⇄herdr OP | zsh [build unknown] | working | herdr',
    'node-b:wa/tb/pc | node-b:wa | ⇄node-b wa | review [build unknown] | blocked | node-b',
  ]);
  for (const body of ['null', '7', '[]', '{"panes":3}', 'nope']) expect(parseRemoteRows(body)).toEqual([]);
});

test('app: herdr panes join the left list under «⇄herdr …»; selecting one paints its read screen, read-only; typing and closing are refused with the reason', async () => {
  const reads: string[] = [];
  const federated = fedList(fedRow('herdr', 'w1', 't2', 'p2', 'OP · mshq 주 OP', 'idle'));
  const base = harness(listOf(row('w1', 'p1', 'mine', 'idle')));
  const attachments = base.attachments;
  let tick: () => void = () => {};
  const app = createAttachApp({
    request: async (request): Promise<ElsResult> => request.op === 'ls' ? { exitCode: 0, message: listOf(row('w1', 'p1', 'mine', 'idle')) } : { exitCode: 0, message: '' },
    attach: (pane, size, handlers): Attached => { const a = { pane, typed: [] as string[] }; attachments.push({ ...a, size, handlers, resizes: [], detached: false }); return { input: (b) => { a.typed.push(b); attachments.at(-1)!.typed.push(b); }, resize: () => {}, detach: () => {} }; },
    write: (text) => { screens.push(plain(text)); },
    size: () => ({ cols: 100, rows: 12 }), cwd: '/work/proj', env: {},
    setInterval: (callback) => { tick = callback; return 0; }, clearInterval: () => {}, pollMs: 1000, chatCommand: ['x'],
    memory: { load: () => ({}), save: () => {} },
    remote: { list: async () => ({ exitCode: 0, message: federated }), read: async (address) => { reads.push(address); return { exitCode: 0, message: `HERDR SCREEN of ${address}` }; } },
  });
  const screens: string[] = [];
  await app.start();
  await Bun.sleep(20);
  expect(screens.at(-1)!).toContain(' ⊞ herdr · 1');               // FU3: herdr's spaces fold under one head on the left
  app.key('\u0002w');                                             // next space: the herdr one
  await Bun.sleep(20);
  expect(reads).toEqual(['herdr:w1/t2/p2']);
  expect(screens.at(-1)!).toContain('HERDR SCREEN of herdr:w1/t2/p2');
  expect(screens.at(-1)!).toContain('│🌐 mshq 주 OP  +');                             // the remote pane's tab (FU3 form)
  expect(screens.at(-1)!).toContain('읽기 전용');
  app.key('rm -rf x\r');
  await Bun.sleep(5);
  expect(screens.at(-1)!).toContain('읽기 전용 — 입력은 els do herdr:w1/t2/p2');
  expect(attachments.map((a) => a.pane)).toEqual(['p1']);        // nothing was attached for the herdr pane
  expect(attachments[0]!.typed).toEqual([]);                      // and the keys went nowhere
  app.key('\u0002x');
  await Bun.sleep(5);
  expect(screens.at(-1)!).toContain('여기서 닫을 수 없음');
  tick(); await Bun.sleep(20);
  expect(reads).toEqual(['herdr:w1/t2/p2', 'herdr:w1/t2/p2']);    // the poll re-reads the selected remote pane
  expect(screens.at(-1)!).toContain('여기서 닫을 수 없음');          // ...and does not wipe the note the person was reading
});

test('app: a failing or empty federated list leaves the local list as it was; a remote pane that disappears moves the selection to a local one', async () => {
  const screens: string[] = [];
  let answer: ElsResult = { exitCode: 0, message: fedList(fedRow('herdr', 'w1', 't2', 'p2', 'OP · a', 'idle')) };
  let tick: () => void = () => {};
  const app = createAttachApp({
    request: async (request): Promise<ElsResult> => request.op === 'ls' ? { exitCode: 0, message: listOf(row('w1', 'p1', 'mine', 'idle')) } : { exitCode: 0, message: '' },
    attach: (): Attached => ({ input: () => {}, resize: () => {}, detach: () => {} }),
    write: (text) => { screens.push(plain(text)); }, size: () => ({ cols: 100, rows: 12 }), cwd: '/w', env: {},
    setInterval: (callback) => { tick = callback; return 0; }, clearInterval: () => {}, pollMs: 1000, chatCommand: ['x'],
    memory: { load: () => ({}), save: () => {} },
    remote: { list: async () => answer, read: async () => ({ exitCode: 0, message: 'SCREEN' }) },
  });
  await app.start(); await Bun.sleep(20);
  app.key('\u0002w'); await Bun.sleep(20);                       // the herdr space
  expect(screens.at(-1)!).toContain('SCREEN');
  answer = { exitCode: 1, message: 'herdr down' };                // the other hosts stop answering
  tick(); await Bun.sleep(30);
  expect(screens.at(-1)!).toContain('mine');                      // the local row is still there
  expect(screens.at(-1)!).not.toContain('⇄herdr');                // the herdr rows are gone, not stale
  expect(screens.at(-1)!).toContain('name-w1 ▸ mine');            // and the selection moved back to the local pane
});

// ---- #38431 review: the other hosts failing in every way the transport can fail ---------------------------------------------
function remoteApp(remote: { list: () => Promise<ElsResult>; read: (address: string) => Promise<ElsResult> }, cols = 120) {
  const screens: string[] = [];
  let tick: () => void = () => {};
  const app = createAttachApp({
    request: async (request): Promise<ElsResult> => request.op === 'ls' ? { exitCode: 0, message: listOf(row('w1', 'p1', 'mine', 'idle')) } : { exitCode: 0, message: '' },
    attach: (): Attached => ({ input: () => {}, resize: () => {}, detach: () => {} }),
    write: (text) => { screens.push(plain(text)); }, size: () => ({ cols, rows: 12 }), cwd: '/w', env: {},
    setInterval: (callback) => { tick = callback; return 0; }, clearInterval: () => {}, pollMs: 1000, chatCommand: ['x'],
    memory: { load: () => ({}), save: () => {} }, remote,
  });
  return { app, screens, tick: () => tick() };
}
const herdrList = fedList(fedRow('herdr', 'w1', 't2', 'p2', 'OP · a', 'idle'));

test('app: a THROWING federated list removes the other hosts\' rows like a failing one and moves a remote selection to a local pane', async () => {
  let throws = false;
  const { app, screens, tick } = remoteApp({ list: async () => { if (throws) throw new Error('boom'); return { exitCode: 0, message: herdrList }; }, read: async () => ({ exitCode: 0, message: 'SCREEN' }) });
  await app.start(); await Bun.sleep(20);
  app.key('\u0002w'); await Bun.sleep(20);
  expect(screens.at(-1)!).toContain('SCREEN');
  throws = true; tick(); await Bun.sleep(30);
  expect(screens.at(-1)!).not.toContain('⇄herdr');
  expect(screens.at(-1)!).toContain('name-w1 ▸ mine');
});

test('app: a THROWING read shows a blank screen and the reason, with no unhandled rejection; the poll\'s read error never wipes the «read-only» note', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    let mode: 'throw' | 'refuse' = 'throw';
    const { app, screens, tick } = remoteApp({ list: async () => ({ exitCode: 0, message: herdrList }),
      read: async () => { if (mode === 'throw') throw new Error('socket reset'); return { exitCode: 1, message: 'read failed' }; } });
    await app.start(); await Bun.sleep(20);
    app.key('\u0002w'); await Bun.sleep(30);
    expect(screens.at(-1)!).toContain('els: socket reset');
    app.key('hello'); await Bun.sleep(10);                       // the person types: the refusal note appears
    expect(screens.at(-1)!).toContain('읽기 전용 — 입력은 els do');
    mode = 'refuse'; tick(); await Bun.sleep(40);                // a poll with a (different) read failure
    expect(screens.at(-1)!).toContain('읽기 전용 — 입력은 els do');   // the person's note is still there
    expect(screens.at(-1)!).toContain('read failed');   // and so is the new reason, in its own place
    expect(unhandled).toEqual([]);
  } finally { process.off('unhandledRejection', onUnhandled); }
});

test('app: two reads of the same pane that finish out of order — the older answer never paints over the newer one', async () => {
  const resolvers: ((r: ElsResult) => void)[] = [];
  const { app, screens, tick } = remoteApp({ list: async () => ({ exitCode: 0, message: herdrList }),
    read: () => new Promise<ElsResult>((resolve) => { resolvers.push(resolve); }) });
  await app.start(); await Bun.sleep(20);
  app.key('\u0002w'); await Bun.sleep(10);                       // read #1 starts (never answered yet)
  tick(); await Bun.sleep(30);                                   // the poll starts read #2
  expect(resolvers).toHaveLength(2);
  resolvers[1]!({ exitCode: 0, message: 'NEWER' }); await Bun.sleep(10);
  resolvers[0]!({ exitCode: 0, message: 'OLDER' }); await Bun.sleep(10);
  expect(screens.at(-1)!).toContain('NEWER');
  expect(screens.at(-1)!).not.toContain('OLDER');
});

test('federation status shows unreachable host and clears it after reconnection', async () => {
  let down = true;
  const { app, screens, tick } = remoteApp({
    list: async () => ({ exitCode: 0, message: JSON.stringify({ hosts: [{ name: 'node-b', reach: down ? 'down' : 'up' }], panes: [] }) }),
    read: async () => ({ exitCode: 1, message: 'unreachable' }),
  });
  await app.start(); await Bun.sleep(20);
  expect(screens.at(-1)!).toContain('⇄node-b ?');
  down = false; tick(); await Bun.sleep(30);
  expect(screens.at(-1)!).not.toContain('⇄node-b ?');
});

test('unreachable host stays visible in a narrow terminal', async () => {
  const { app, screens } = remoteApp({
    list: async () => ({ exitCode: 0, message: JSON.stringify({ hosts: [{ name: 'node-b', reach: 'down' }], panes: [] }) }),
    read: async () => ({ exitCode: 1, message: 'unreachable' }),
  }, 40);
  await app.start(); await Bun.sleep(20);
  expect(screens.at(-1)!).toContain('⇄node-b ?');
});

// ---- ELS-REMOTE-MARKER: a host reported down keeps its last known panes, marked «?» (they no longer vanish) ------------
test('app: a host reported down keeps its space and tab marked «?»; they come back live when it answers again', async () => {
  let reach: 'up' | 'down' = 'up';
  const answer = (): ElsResult => ({ exitCode: 0, message: JSON.stringify({ hosts: [{ name: 'node-b', reach }], workspaces: [], tabs: [],
    panes: reach === 'up' ? [fedRow('node-b', 'wa', 'tb', 'pc', 'review', 'blocked')] : [] }) });
  const { app, screens, tick } = remoteApp({ list: async () => answer(), read: async () => ({ exitCode: 1, message: 'unreachable' }) });
  await app.start(); await Bun.sleep(20);
  expect(screens.at(-1)!).toContain(' ◐ ⇄node-b wa · 1');
  app.key('\u0002w'); await Bun.sleep(20);                         // the node-b space: its pane is the tab
  expect(screens.at(-1)!).toContain('│🌐 review  +');
  reach = 'down'; tick(); await Bun.sleep(30);
  expect(screens.at(-1)!).toContain('? ⇄node-b wa · 1');             // the space stays, marked unreachable
  expect(screens.at(-1)!).toContain('│🌐 review ?  +');                            // and so does its last known tab
  expect(screens.at(-1)!).toContain('⇄node-b ?');                    // the status line says so too (#38616)
  reach = 'up'; tick(); await Bun.sleep(30);
  expect(screens.at(-1)!).toContain('│🌐 review  +');
  expect(screens.at(-1)!).not.toContain('🌐 review ?');
});

// ---- ELS-VOICE-CONTROL-POPUP (OP #101856 · #101876): ctrl+b : → say it → preview → Enter (closes need y) → the same els requests
test('app: ctrl+b : — «two 탭 삭제해줘» shows ⚠ and Enter alone closes nothing; y closes it once; «새 셸 열어줘» → Enter → Enter opens one shell', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle'), row('w1', 'p2', 'two', 'idle')));
  await h.app.start();
  h.app.key('\u0002:');
  h.app.key('two 탭 삭제해줘\r'); await Bun.sleep(10);
  expect(h.lastScreen()).toContain('⚠ → 탭 two 닫기 · y 로 확인 · 다른 키 취소');
  h.app.key('\r'); await Bun.sleep(10);
  expect(h.requests.filter((r) => r.op === 'close')).toEqual([]);
  expect(h.lastScreen()).toContain('취소 (y 가 아님)');
  h.app.key('\u0002:'); h.app.key('two 탭 삭제해줘\r'); await Bun.sleep(10);
  h.app.key('y'); await Bun.sleep(20);
  expect(h.requests.filter((r) => r.op === 'close')).toEqual([{ op: 'close', pane: 'p2' }]);
  expect(h.lastScreen()).toContain('완료: 탭 two 닫기');
  const before = h.requests.filter((r) => r.op === 'new').length;
  h.app.key('\u0002:'); h.app.key('새 셸 열어줘\r'); await Bun.sleep(10);
  expect(h.lastScreen()).toContain('→ 새 셸 열기 · Enter 실행 · Esc 취소');
  h.app.key('\r'); await Bun.sleep(20);
  expect(h.requests.filter((r) => r.op === 'new').length - before).toBe(1);
  expect(h.attachments.at(-1)!.typed).toEqual([]);                 // none of the words went into the pane
});

// ---- ELS-EXIT-BG-BUTTONS (OP #102571): ⏏ 백그라운드 / ✕ 종료 at the right end of the bottom line (80x24: row 24) ----------
const click = (x: number, y = 24): string => `\u001b[<0;${x};${y}M`;
test('app: the bottom line shows « ⏏ 백그라운드  ✕ 종료 »; clicking ⏏ leaves els running (code 0, nothing closed) — like ctrl+b q', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'working')));
  await h.app.start();
  expect(h.lastScreen().split('\r\n').at(-1)).toContain(' ⏏ 백그라운드  ✕ 종료 ');
  h.app.key(click(65));
  expect(await h.app.done).toEqual({ code: 0, message: '' });
  expect(h.requests.filter((r) => r.op === 'close' || r.op === 'close-workspace')).toEqual([]);
});

test('app: clicking ✕ on a space where nothing runs closes that space and leaves the view', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle'), row('w2', 'p2', 'two', 'working')));
  await h.app.start();
  h.app.key(click(76));
  expect(await h.app.done).toEqual({ code: 0, message: '' });
  expect(h.requests.filter((r) => r.op === 'close-workspace')).toEqual([{ op: 'close-workspace', ws: 'w1' }]);   // only this space
});

test('app: ✕ with something running asks «⚠ N개 실행 중 — 종료?»; any key but y closes nothing; ctrl+b Q then y closes and leaves', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'working'), row('w1', 'p2', 'two', 'idle')));
  await h.app.start();
  h.app.key(click(76));
  expect(h.lastScreen()).toContain('⚠ 1개 실행 중 — 종료? · y 확인 · 다른 키 취소');
  h.app.key('n');
  await Bun.sleep(10);
  expect(h.requests.filter((r) => r.op === 'close-workspace')).toEqual([]);
  h.app.key('\u0002Q');
  h.app.key('y');
  expect(await h.app.done).toEqual({ code: 0, message: '' });
  expect(h.requests.filter((r) => r.op === 'close-workspace')).toEqual([{ op: 'close-workspace', ws: 'w1' }]);
});
