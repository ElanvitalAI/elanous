import { expect, test } from 'bun:test';
import type { AttachHandlers, Attached } from './attach-client.js';
import { createAttachApp } from './attach-app.js';
import { createKeyRouter, type KeyAction } from './attach-keys.js';
import { buildSidebar, composeView, parsePaneRows, wordOfState } from './attach-view.js';
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
  expect(parsePaneRows(listOf(row('w1', 'p1', 'shell', 'working'))).map((r) => [r.pane, r.wsId, r.workspace, r.title, r.state])).toEqual([['p1', 'w1', 'name-w1', 'shell', 'working']]);
  for (const body of ['null', '7', '"x"', '[]', '{"panes":3}', 'not json']) expect(parsePaneRows(body)).toEqual([]);
  expect([wordOfState('working'), wordOfState('blocked'), wordOfState('idle'), wordOfState('exited'), wordOfState('')]).toEqual(['working', 'blocked', 'idle', 'done', 'done']);
});

test('sidebar: workspace line with its rolled-up mark and «⎇n ●n», pane lines with the status mark in the shared colour, selected in reverse, exited dimmed', () => {
  const rows = parsePaneRows(listOf(row('w1', 'p1', 'build', 'working'), row('w1', 'p2', 'old', 'exited'), row('w2', 'p3', 'repl', 'idle')));
  const lines = buildSidebar(rows, 'p1', 28, 6);
  expect(lines).toHaveLength(6);
  expect(lines.map(plain)).toEqual([' ▾ ● name-w1 ⎇2 ●1          ', '    ● build                 ', '    ✓ old                   ', ' ▾ ○ name-w2                ', '    ○ repl                  ', ' '.repeat(28)]);
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
  expect(h.attachments[0]!.size).toEqual({ cols: 51, rows: 23 });      // 80 - 28 sidebar - 1 separator; 24 - 1 status line
});

test('app: starts on the first pane that is still running; exited leftovers are closed, the list re-read', async () => {
  const h = harness(listOf(row('w1', 'old1', 'dead', 'exited'), row('w1', 'live', 'work', 'idle'), row('w2', 'old2', 'dead2', 'exited')));
  await h.app.start();
  expect(h.requests.filter((r) => r.op === 'close')).toEqual([{ op: 'close', pane: 'old1' }, { op: 'close', pane: 'old2' }]);
  expect(h.attachments.map((a) => a.pane)).toEqual(['live']);
  expect(h.lastScreen()).not.toContain('dead');
});

test('app: keys — input goes to the pane, ctrl+b j/k/w/3 switch panes (old attach released), b hides the sidebar and resizes the pane', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle'), row('w1', 'p2', 'two', 'idle'), row('w2', 'p3', 'three', 'idle')));
  await h.app.start();
  h.app.key('ls\r');
  expect(h.attachments[0]!.typed).toEqual(['ls\r']);
  h.app.key('\u0002j');
  expect(h.attachments.map((a) => a.pane)).toEqual(['p1', 'p2']);
  expect(h.attachments[0]!.detached).toBe(true);
  h.app.key('\u0002w');
  expect(h.attachments.at(-1)!.pane).toBe('p3');
  h.app.key('\u0002k');
  expect(h.attachments.at(-1)!.pane).toBe('p2');
  h.app.key('\u00021');
  expect(h.attachments.at(-1)!.pane).toBe('p1');
  h.app.key('\u0002b');
  expect(h.attachments.at(-1)!.resizes.at(-1)).toEqual([80, 23]);
  expect(h.lastScreen().split('\r\n')[0]).not.toContain('▾');
});

test('app: frames from a stale attach are ignored after a switch; the current frame is painted next to the list', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle'), row('w1', 'p2', 'two', 'idle')));
  await h.app.start();
  h.app.key('\u0002j');
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

test('app: the selected pane exits → «pane 종료됨», its last screen stays and the pane stays in the list until the selection leaves; the server going away ends the app with code 1', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle'), row('w1', 'p2', 'two', 'idle')));
  await h.app.start();
  h.setListing(listOf(row('w1', 'p1', 'one', 'exited'), row('w1', 'p2', 'two', 'idle')));
  h.attachments[0]!.handlers.onFrame({ pane: 'p1', seq: 1, cols: 51, rows: 23, screen: '[screen 51x23 cursor=(row 0, col 0, visible false)]\nLAST WORDS' });
  h.attachments[0]!.handlers.onEnd(0, 'pane exited');
  expect(h.lastScreen()).toContain('pane 종료됨');
  expect(h.lastScreen()).toContain('LAST WORDS');
  h.attachments[0]!.handlers.onEnd(1, 'els: the els server closed the connection');
  // (the first attach already ended; a live one losing the server finishes the app)
  h.app.key('\u0002j');
  h.attachments.at(-1)!.handlers.onEnd(1, 'els: the els server closed the connection');
  expect(await h.app.done).toEqual({ code: 1, message: 'els: the els server closed the connection' });
});

test('toggle: ctrl+b s hides and shows the list (the pane is resized each time) and the choice is remembered', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle')));
  await h.app.start();
  expect(h.lastScreen().split('\r\n')[0]).toContain('▾');
  h.app.key('\u0002s');
  expect(h.lastScreen().split('\r\n')[0]).not.toContain('▾');
  expect(h.attachments[0]!.resizes.at(-1)).toEqual([80, 23]);
  expect(h.saved.at(-1)).toEqual({ sidebar: false, lastPane: 'p1' });
  h.app.key('\u0002s');
  expect(h.lastScreen().split('\r\n')[0]).toContain('▾');
  expect(h.attachments[0]!.resizes.at(-1)).toEqual([51, 23]);
  expect(h.saved.at(-1)).toEqual({ sidebar: true, lastPane: 'p1' });
});

test('start state: --no-side beats a remembered open list, a remembered closed list stays closed, nothing remembered = open (els)', async () => {
  const listing = listOf(row('w1', 'p1', 'one', 'idle'));
  const first = (h: ReturnType<typeof harness>) => h.lastScreen().split('\r\n')[0]!.includes('▾');
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
