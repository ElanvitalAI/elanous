import { expect, test } from 'bun:test';
import { Terminal } from '@xterm/headless';
import type { AttachHandlers, Attached } from './attach-client.js';
import { createAttachApp } from './attach-app.js';
import { createKeyRouter, type KeyAction } from './attach-keys.js';
import { buildSidebar, composeView, parsePaneRows, parseRemoteRows, wordOfState } from './attach-view.js';
import type { ElsResult } from './core.js';
import type { ElsRequest } from './server.js';

const row = (ws: string, pane: string, title: string, state: string) => ({ address: `${ws}/t1/${pane}`, workspace: `name-${ws}`, pane, title, state });
const listOf = (...panes: object[]): string => JSON.stringify({ workspaces: [], tabs: [], panes });
const plain = (text: string): string => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');

test('CEO 30-second no-eyes receipt paints the els side red and clears after actual intake', async () => {
  const panes = [row('op', 'p1', 'OP', 'working')];
  const listed = (pendingRed: number) => JSON.stringify({ panes, ceoSide: { pendingRed } });
  const h = harness(listed(0), { cols: 120, rows: 24 });
  await h.app.start();
  expect(h.lastScreen()).not.toContain('대표 대기 글');
  h.setListing(listed(1));
  h.tick(); await Bun.sleep(20);
  expect(h.lastScreen()).toContain('대표 대기 글');
  expect(h.writes.at(-1)).toContain('\u001b[31m');
  h.setListing(listed(0));
  h.tick(); await Bun.sleep(20);
  expect(h.lastScreen()).not.toContain('대표 대기 글');
});

test('a damaged CEO side status is visibly unknown rather than silently zero', async () => {
  const panes = [row('op', 'p1', 'OP', 'idle')];
  const h = harness(JSON.stringify({ panes, ceoSide: { error: 'unavailable' } }), { cols: 120, rows: 24 });
  await h.app.start();
  expect(h.lastScreen()).toContain('대표 대기 글 확인 불가');
  expect(h.writes.at(-1)).toContain('\u001b[31m');
  h.setListing(JSON.stringify({ panes }));
  h.tick(); await Bun.sleep(20);
  expect(h.lastScreen()).not.toContain('대표 대기 글');
});
// Inspect the actual absolute-positioned overlay, not the old underlying screen row.
const modalRow = (screen: string, y: number, x = 31): string => {
  const match = new RegExp(`\\x1b\\[${y};${x}H([^\\x1b]*(?:\\x1b\\[[0-9;]*m[^\\x1b]*)*)`).exec(screen);
  return plain(match?.[1] ?? '');
};

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

async function renderedRow(screen: string, y: number): Promise<string> {
  const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  try {
    await new Promise<void>((resolve) => terminal.write(screen, resolve));
    return terminal.buffer.active.getLine(y - 1)!.translateToString(true);
  } finally { terminal.dispose(); }
}

// ---- the controller, with a scripted server and a fake attach ----------------------------------------------------------
function harness(initial: string, size = { cols: 80, rows: 24 }, remembered: { sidebar?: boolean; lastPane?: string } = {}, sidebar?: boolean) {
  const saved: { sidebar: boolean; lastPane?: string }[] = [];
  let listing = initial;
  let lsAway: string | undefined;                                 // D1a: what `ls` answers while the els server is away
  let poll: (() => void) | undefined;                             // D1a: the poll timer's callback, driven by tick()
  const requests: ElsRequest[] = [];
  const attachments: { pane: string; size: { cols: number; rows: number }; handlers: AttachHandlers; typed: string[]; resizes: [number, number][]; scrolls: number[]; detached: boolean }[] = [];
  const writes: string[] = [];
  let created = 0;
  let newResponse: (() => Promise<ElsResult>) | undefined;
  const app = createAttachApp({
    request: async (request): Promise<ElsResult> => {
      requests.push(request);
      if (request.op === 'ls') return lsAway ? { exitCode: 1, message: lsAway } : { exitCode: 0, message: listing };
      if (request.op === 'new') {
        if (newResponse) return newResponse();
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
      const entry = { pane, size: paneSize, handlers, typed: [] as string[], resizes: [] as [number, number][], scrolls: [] as number[], detached: false };
      attachments.push(entry);
      return { input: (bytes) => { entry.typed.push(bytes); }, resize: (cols, rows) => { entry.resizes.push([cols, rows]); }, scroll: (lines) => { entry.scrolls.push(lines); }, detach: () => { entry.detached = true; } };
    },
    write: (text) => { writes.push(text); },
    size: () => size,
    cwd: '/work/proj',
    env: { SHELL: '/bin/zsh' },
    setInterval: (callback: () => void) => { poll = callback; return 0; },
    clearInterval: () => {},
    pollMs: 1000,
    chatCommand: ['/opt/elanous/bin/elanous'],
    memory: { load: () => remembered, save: (state) => { saved.push(state); } },
    ...(sidebar === undefined ? {} : { sidebar }),
  });
  return { app, saved, requests, attachments, writes, setNewResponse: (next: (() => Promise<ElsResult>) | undefined) => { newResponse = next; }, setListing: (next: string) => { listing = next; }, setLsAway: (message: string | undefined) => { lsAway = message; }, tick: () => { poll?.(); }, lastScreen: () => plain(writes.at(-1) ?? '') };
}

test('automatic creation: a definitely unsent request recovers on the next poll', async () => {
  for (const initial of [listOf(), listOf(row('w1', 'p1', 'old', 'exited'))]) {
    const h = harness(initial);
    h.setNewResponse(async () => ({ exitCode: 1, message: 'connect failed', transport: { outcome: 'not-sent', reason: 'connect' } }));
    await h.app.start();
    expect(h.requests.filter((r) => r.op === 'new')).toHaveLength(1);
    h.setNewResponse(undefined);
    h.tick(); await Bun.sleep(20);
    expect(h.requests.filter((r) => r.op === 'new')).toHaveLength(2);
    expect(h.attachments.at(-1)?.pane).toBe('pnew1');
  }
});

test('automatic creation: unknown result is not retried on later polls', async () => {
  for (const initial of [listOf(), listOf(row('w1', 'p1', 'old', 'exited'))]) {
    const h = harness(initial);
    h.setNewResponse(async () => { throw new Error('timeout'); });
    await h.app.start();
    h.tick(); await Bun.sleep(10); h.tick(); await Bun.sleep(10);
    expect(h.requests.filter((r) => r.op === 'new')).toHaveLength(1);
  }
});

test('automatic creation: polls do not duplicate an in-flight request', async () => {
  for (const initial of [listOf(), listOf(row('w1', 'p1', 'old', 'exited'))]) {
    const h = harness(initial);
    let resolve!: (result: ElsResult) => void;
    h.setNewResponse(() => new Promise((done) => { resolve = done; }));
    const starting = h.app.start();
    await Bun.sleep(10);
    h.tick(); h.tick(); await Bun.sleep(10);
    expect(h.requests.filter((r) => r.op === 'new')).toHaveLength(1);
    resolve({ exitCode: 1, message: 'not sent', transport: { outcome: 'not-sent', reason: 'connect' } });
    await starting;
  }
});

test('new tab modal: list failure after creation keeps the app and name for inspection', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle')));
  await h.app.start();
  h.setNewResponse(async () => {
    h.setLsAway('list timed out');
    return { exitCode: 0, message: JSON.stringify({ pane: 'p2' }) };
  });
  h.app.key('\u0002c'); h.app.key('named\r');
  await Bun.sleep(20);
  expect(h.lastScreen()).toContain('Outcome unknown');
  expect(await renderedRow(h.writes.at(-1)!, 11)).toContain('named');
});

test('new tab modal: cancel consumes the rest of the same input chunk', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle')));
  await h.app.start();
  h.app.key('\u0002c');
  h.app.key('\u001bxabc\r');
  expect(h.attachments[0]!.typed).toEqual([]);
});

test('new tab modal: incomplete escape cannot consume pane input after save finishes', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle')));
  await h.app.start();
  let resolve!: (value: ElsResult) => void;
  h.setNewResponse(() => new Promise((r) => { resolve = r; }));
  h.app.key('\u0002c'); h.app.key('named\r');
  h.app.key('\u001b[');
  h.setListing(listOf(row('w1', 'p1', 'one', 'idle'), row('w1', 'p2', 'new', 'idle')));
  resolve({ exitCode: 0, message: JSON.stringify({ pane: 'p2' }) });
  await Bun.sleep(300);
  h.app.key('ls\r');
  expect(h.attachments.at(-1)!.typed.join('')).toBe('ls\r');
});

test('new tab modal: arrow split by a short scheduling delay stays in the prompt', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle')));
  await h.app.start();
  h.app.key('\u0002c'); h.app.key('ab');
  h.app.key('\u001b'); await Bun.sleep(15); h.app.key('[D'); h.app.key('X\r');
  await Bun.sleep(20);
  expect(h.requests.filter((r) => r.op === 'new').map((r) => r.title)).toEqual(['aXb']);
  expect(h.attachments[0]!.typed).toEqual([]);
});

test('new tab modal: fragmented arrow does not cancel or leak into the pane', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle')));
  await h.app.start();
  h.app.key('\u0002c'); h.app.key('ab');
  h.app.key('\u001b'); h.app.key('['); h.app.key('D'); h.app.key('X\r');
  await Bun.sleep(20);
  expect(h.requests.filter((r) => r.op === 'new').map((r) => r.title)).toEqual(['aXb']);
  expect(h.attachments[0]!.typed).toEqual([]);
});

test('new tab modal: a delayed incomplete escape suffix is discarded', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle')));
  await h.app.start();
  h.app.key('\u0002c'); h.app.key('ab');
  h.app.key('\u001b[3');
  await Bun.sleep(300);
  h.app.key('~'); h.app.key('X\r');
  await Bun.sleep(20);
  expect(h.requests.filter((r) => r.op === 'new').map((r) => r.title)).toEqual(['abX']);
  expect(h.attachments[0]!.typed).toEqual([]);
});

test('new tab modal: mouse reports split at every boundary do not cancel or leak', async () => {
  const report = '\u001b[<0;40;12M';
  for (let cut = 1; cut < report.length; cut++) {
    const h = harness(listOf(row('w1', 'p1', 'one', 'idle')));
    await h.app.start();
    h.app.key('\u0002c'); h.app.key('work');
    h.app.key(report.slice(0, cut)); h.app.key(report.slice(cut)); h.app.key('\r');
    await Bun.sleep(10);
    expect(h.requests.filter((r) => r.op === 'new').map((r) => r.title)).toEqual(['work']);
    expect(h.attachments[0]!.typed).toEqual([]);
  }
});

test('new tab modal: an escape coalesced with opening is framed across reads', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle')));
  await h.app.start();
  h.app.key('\u0002cab\u001b');
  h.app.key('[D'); h.app.key('X\r');
  await Bun.sleep(20);
  expect(h.requests.filter((r) => r.op === 'new').map((r) => r.title)).toEqual(['aXb']);
  expect(h.attachments[0]!.typed).toEqual([]);
});

test('new tab modal: coalesced open and input is routed to the prompt', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle')));
  await h.app.start();
  h.app.key('\u0002c\u0002bX\r');
  await Bun.sleep(10);
  expect(h.requests.filter((r) => r.op === 'new').at(-1)).toMatchObject({ title: 'bX' });
  expect(h.attachments[0]!.typed).toEqual([]);
});

test('new tab modal: successful creation followed by failed listing does not attach an unlisted pane or allow retry', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle')));
  h.setNewResponse(async () => {
    h.setLsAway('els: no els server is running — start it with `els serve` (or `elanous side serve`)');
    return { exitCode: 0, message: JSON.stringify({ pane: 'pnew1' }) };
  });
  await h.app.start();
  h.app.key('\u0002cwork\r'); await Bun.sleep(20);
  expect(h.attachments.map((a) => a.pane)).toEqual(['p1']);
  expect(h.lastScreen()).toContain('Outcome unknown');
  h.app.key('\r'); await Bun.sleep(10);
  expect(h.requests.filter((r) => r.op === 'new')).toHaveLength(1);
});

test('new tab modal: unknown create outcome does not allow duplicate submission', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle')));
  h.setNewResponse(async () => ({ exitCode: 1, message: 'timed out', transport: { outcome: 'unknown', reason: 'timeout' } }));
  await h.app.start();
  h.app.key('\u0002cwork\r');
  await Bun.sleep(20);
  h.app.key('\r');
  await Bun.sleep(20);
  expect(h.requests.filter((r) => r.op === 'new')).toHaveLength(1);
  expect(h.writes.join('')).toContain('unknown');
});

test('new tab modal: unknown manual creation is not followed by automatic creation on an empty or exited list', async () => {
  for (const after of [listOf(), listOf(row('w1', 'p1', 'old', 'exited'))]) {
    const h = harness(listOf(row('w1', 'p1', 'one', 'idle')));
    h.setNewResponse(async () => ({ exitCode: 1, message: 'timed out', transport: { outcome: 'unknown', reason: 'timeout' } }));
    await h.app.start();
    h.app.key('\u0002cwork\r'); await Bun.sleep(20);
    h.setListing(after);
    h.tick(); await Bun.sleep(20); h.tick(); await Bun.sleep(20);
    expect(h.requests.filter((r) => r.op === 'new')).toHaveLength(1);
  }
});

test('new tab modal: uncertain result survives close and reopening until acknowledged', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle')));
  h.setNewResponse(async () => ({ exitCode: 1, message: 'timed out', transport: { outcome: 'unknown', reason: 'timeout' } }));
  await h.app.start();
  h.app.key('\u0002cwork\r'); await Bun.sleep(20);
  h.app.key('\u001b'); await Bun.sleep(60);
  h.app.key('\u0002c');
  expect(h.lastScreen()).toContain('Outcome unknown');
  h.app.key('\r'); await Bun.sleep(10);
  expect(h.requests.filter((r) => r.op === 'new')).toHaveLength(1);
  h.app.key('r'); h.app.key('\r'); await Bun.sleep(20);
  expect(h.requests.filter((r) => r.op === 'new').map((r) => r.title)).toEqual(['work', 'work']);
});

test('new tab modal: cancelling risky retry keeps unknown name guarded on reopen', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle')));
  h.setNewResponse(async () => ({ exitCode: 1, message: 'timed out', transport: { outcome: 'unknown', reason: 'timeout' } }));
  await h.app.start();
  h.app.key('\u0002cwork\r'); await Bun.sleep(20);
  h.app.key('r'); h.app.key('\u001b'); await Bun.sleep(60);
  h.app.key('\u0002c');
  expect(h.lastScreen()).toContain('Outcome unknown');
  expect(await renderedRow(h.writes.at(-1)!, 11)).toContain('work');
  h.app.key('\r'); await Bun.sleep(10);
  expect(h.requests.filter((r) => r.op === 'new').map((r) => r.title)).toEqual(['work']);
});
test('new tab modal: uncertain retry retains the original workspace after navigation', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle'), row('w2', 'p2', 'two', 'idle')));
  h.setNewResponse(async () => ({ exitCode: 1, message: 'timed out', transport: { outcome: 'unknown', reason: 'timeout' } }));
  await h.app.start();
  h.app.key('\u0002cwork\r'); await Bun.sleep(20);
  h.app.key('\u001b'); await Bun.sleep(60);
  h.app.key('\u0002w');
  h.app.key('\u0002c'); h.app.key('r'); h.app.key('\r'); await Bun.sleep(20);
  expect(h.requests.filter((r) => r.op === 'new').map((r) => r.ws)).toEqual(['name-w1', 'name-w1']);
});

test('new tab modal: a refused create retains the name and permits retry', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle')));
  h.setNewResponse(async () => ({ exitCode: 1, message: 'refused' }));
  await h.app.start();
  h.app.key('\u0002c'); h.app.key('work\r');
  await Bun.sleep(10);
  expect(h.lastScreen()).toContain('새 탭 이름');
  expect(await renderedRow(h.writes.at(-1)!, 11)).toContain('work');
  expect(h.lastScreen()).toContain('refused');
  h.setNewResponse(undefined);
  h.app.key('\r');
  await Bun.sleep(10);
  expect(h.requests.filter((r) => r.op === 'new').map((r) => r.title)).toEqual(['work', 'work']);
});

test('new tab modal: Ctrl+B during a pending request cannot consume later Esc', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle')));
  let resolve!: (result: ElsResult) => void;
  h.setNewResponse(() => new Promise((done) => { resolve = done; }));
  await h.app.start();
  h.app.key('\u0002cwork\r');
  h.app.key('\u0002');
  resolve({ exitCode: 1, message: 'refused' });
  await Bun.sleep(10);
  h.app.key('\u001b'); await Bun.sleep(60);
  expect(h.lastScreen()).not.toContain('새 탭 이름');
  expect(h.attachments[0]!.typed).toEqual([]);
});

test('new tab modal: repeated Enter while creation is pending sends only one request', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle')));
  let resolve!: (result: ElsResult) => void;
  h.setNewResponse(() => new Promise((done) => { resolve = done; }));
  await h.app.start();
  h.app.key('\u0002cwork\r');
  h.app.key('\r\r');
  expect(h.requests.filter((r) => r.op === 'new')).toHaveLength(1);
  resolve({ exitCode: 1, message: 'refused' });
  await Bun.sleep(10);
  expect(await renderedRow(h.writes.at(-1)!, 11)).toContain('work');
  h.app.key('\u001b');
});
test('new tab modal: Ctrl+B does not consume Esc or name characters and does not arm a pane shortcut', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle')));
  await h.app.start();
  h.app.key('\u0002c');
  expect(h.lastScreen()).toContain('새 탭 이름');
  h.app.key('\u0002');
  h.app.key('\u001b');
  await Bun.sleep(60); // Allow the escape disambiguation window to expire.
  expect(h.lastScreen()).not.toContain('새 탭 이름');
  expect(h.requests.filter((r) => r.op === 'new')).toEqual([]);
  h.app.key('z');
  expect(h.attachments[0]!.typed).toEqual(['z']);
  h.app.key('\u0002c');
  h.app.key('\u0002\u001b');
  await Bun.sleep(60); // A trailing Esc has the same disambiguation window.
  expect(h.lastScreen()).not.toContain('새 탭 이름');
  expect(h.requests.filter((r) => r.op === 'new')).toEqual([]);
  h.app.key('\u0002c');
  h.app.key('a\u0002b');
  h.app.key('\r');
  expect(h.requests.filter((r) => r.op === 'new').at(-1)).toMatchObject({ title: 'ab' });
});

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
  expect(h.lastScreen()).toContain('DEAD');                         // the exited tab is still there, dimmed
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
  expect(h.writes.at(-1) ?? '').toContain('│\u001b[100;37m 🛠 ONE \u001b[49;39m \u001b[44;37m 🛠 TWO \u001b[49;39m +');   // ELS-TAB-STYLE-HERDR: UPPERCASE padded tabs, focus blue, others gray
  h.app.key('\u0002b');
  expect(h.attachments.at(-1)!.resizes.at(-1)).toEqual([80, 22]);
  expect(h.lastScreen()).not.toContain('new · menu');
});

test('app: frames from a stale attach are ignored after a switch; the current frame is painted next to the list', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle'), row('w1', 'p2', 'two', 'idle')));
  await h.app.start();
  h.app.key('\u0002w');
  h.attachments[0]!.handlers.onFrame({ pane: 'p1', seq: 1, cols: 51, rows: 23, back: 0, screen: '[screen 51x23 cursor=(row 0, col 0, visible true)]\nSTALE' });
  h.attachments[1]!.handlers.onFrame({ pane: 'p2', seq: 1, cols: 51, rows: 23, back: 0, screen: '[screen 51x23 cursor=(row 0, col 2, visible true)]\nfresh$ ' });
  const screen = h.lastScreen();
  expect(screen).toContain('fresh$');
  expect(screen).not.toContain('STALE');
  expect(screen).toContain('NAME-W1');
});

test('app: c opens a pane in the current workspace, N a new workspace named after the folder (suffix when taken), x asks first and closes only on y, D likewise for the workspace', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle')));
  await h.app.start();
  h.app.key('\u0002c');
  h.app.key('\r');                                                  // ELS-NEW-TAB-NAME-WIDGET: c opens the name prompt; Enter on an empty name = the default tab
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
  expect(h.requests.filter((r) => r.op === 'close').at(-1)).toMatchObject({ confirmed: true });   // the y is the human confirmation the door asks for (#39143)
  h.app.key('\u0002D');
  expect(h.lastScreen()).toContain('작업공간');
  h.app.key('y');
  await Bun.sleep(20);
  expect(h.requests.filter((r) => r.op === 'close-workspace').at(-1)).toMatchObject({ confirmed: true });
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

test('app: the selected pane exits with another pane left → the focus moves to it (ELS-LAST-TAB-EXIT); the server going away is waited out, not the end (D1a)', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle'), row('w1', 'p2', 'two', 'idle')));
  await h.app.start();
  h.setListing(listOf(row('w1', 'p1', 'one', 'exited'), row('w1', 'p2', 'two', 'idle')));
  h.attachments[0]!.handlers.onEnd(0, 'pane exited');
  expect(h.attachments.at(-1)!.pane).toBe('p2');
  expect(h.lastScreen()).toContain('pane 종료됨');
  h.attachments.at(-1)!.handlers.onEnd(1, 'els: the els server closed the connection');
  // D1a(ELS-SERVER-RESTART-SURVIVE): a server lost after a good list no longer ends the view — the screen stays and
  // the status line says it is coming back (the dedicated D1a test below rides the whole cycle).
  expect(h.lastScreen()).toContain('서버 재기동 중 — 다시 붙는 중…');
  expect(await Promise.race([h.app.done.then(() => 'ended'), Bun.sleep(30).then(() => 'still running')])).toBe('still running');
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
  expect(h.lastScreen()).toContain('new · menu');
  h.app.key('\u0002s');
  expect(h.lastScreen()).not.toContain('new · menu');
  expect(h.attachments[0]!.resizes.at(-1)).toEqual([80, 22]);
  expect(h.saved.at(-1)).toEqual({ sidebar: false, lastPane: 'p1' });
  h.app.key('\u0002s');
  expect(h.lastScreen()).toContain('new · menu');
  expect(h.attachments[0]!.resizes.at(-1)).toEqual([51, 22]);
  expect(h.saved.at(-1)).toEqual({ sidebar: true, lastPane: 'p1' });
});

test('start state: --no-side beats a remembered open list, a remembered closed list stays closed, nothing remembered = open (els)', async () => {
  const listing = listOf(row('w1', 'p1', 'one', 'idle'));
  const first = (h: ReturnType<typeof harness>) => h.lastScreen().includes('new · menu');
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
      attach: (pane): Attached => { attachments.push(pane); return { input: () => {}, resize: () => {}, scroll: () => {}, detach: () => {} }; },
      write: (text) => { writes.push(text); },
      size: () => ({ cols: 80, rows: 24 }),
      cwd: '/work/proj', env: { SHELL: '/bin/zsh' },
      setInterval: () => 0, clearInterval: () => {}, pollMs: 1000,
      chatCommand: ['/opt/elanous/bin/elanous'],
      memory: { load: () => ({}), save: (state) => { saved.push(state); } },
    });
    await app.start();
    expect(attachments).toEqual(['p1']);
    app.key(key === '\u0002c' ? `${key}\r` : key);   // c opens the name prompt, Enter saves it
    // the request is now waiting on the gate
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
    attach: (pane, size, handlers): Attached => { const a = { pane, typed: [] as string[] }; attachments.push({ ...a, size, handlers, resizes: [], scrolls: [], detached: false }); return { input: (b) => { a.typed.push(b); attachments.at(-1)!.typed.push(b); }, resize: () => {}, scroll: () => {}, detach: () => {} }; },
    write: (text) => { screens.push(plain(text)); },
    size: () => ({ cols: 100, rows: 12 }), cwd: '/work/proj', env: {},
    setInterval: (callback) => { tick = callback; return 0; }, clearInterval: () => {}, pollMs: 1000, chatCommand: ['x'],
    memory: { load: () => ({}), save: () => {} },
    remote: { list: async () => ({ exitCode: 0, message: federated }), read: async (address) => { reads.push(address); return { exitCode: 0, message: `HERDR SCREEN of ${address}` }; } },
  });
  const screens: string[] = [];
  await app.start();
  await Bun.sleep(20);
  expect(screens.at(-1)!).toContain(' ⊞ HERDR · 1');               // FU3: herdr's spaces fold under one head on the left
  app.key('\u0002w');                                             // next space: the herdr one
  await Bun.sleep(20);
  expect(reads).toEqual(['herdr:w1/t2/p2']);
  expect(screens.at(-1)!).toContain('HERDR SCREEN of herdr:w1/t2/p2');
  expect(screens.at(-1)!).toContain('│ 🌐 ⇄herdr MSHQ 주 OP  +');                             // the remote pane's tab (FU3 form)
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
    attach: (): Attached => ({ input: () => {}, resize: () => {}, scroll: () => {}, detach: () => {} }),
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
    attach: (): Attached => ({ input: () => {}, resize: () => {}, scroll: () => {}, detach: () => {} }),
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
  expect(screens.at(-1)!).toContain('⇄node-b ✕');
  down = false; tick(); await Bun.sleep(30);
  expect(screens.at(-1)!).not.toContain('⇄node-b ✕');
});

test('unreachable host stays visible in a narrow terminal', async () => {
  const { app, screens } = remoteApp({
    list: async () => ({ exitCode: 0, message: JSON.stringify({ hosts: [{ name: 'node-b', reach: 'down' }], panes: [] }) }),
    read: async () => ({ exitCode: 1, message: 'unreachable' }),
  }, 40);
  await app.start(); await Bun.sleep(20);
  expect(screens.at(-1)!).toContain('⇄node-b ✕');
});

// ---- ELS-REMOTE-MARKER: a host reported down keeps its last known panes, marked «✕» (they no longer vanish) ------------
test('app: a host reported down keeps its space and tab marked «✕»; they come back live when it answers again', async () => {
  let reach: 'up' | 'down' = 'up';
  const answer = (): ElsResult => ({ exitCode: 0, message: JSON.stringify({ hosts: [{ name: 'node-b', reach }], workspaces: [], tabs: [],
    panes: reach === 'up' ? [fedRow('node-b', 'wa', 'tb', 'pc', 'review', 'blocked')] : [] }) });
  const { app, screens, tick } = remoteApp({ list: async () => answer(), read: async () => ({ exitCode: 1, message: 'unreachable' }) });
  await app.start(); await Bun.sleep(20);
  expect(screens.at(-1)!).toContain(' ◐ ⇄MSB1 WA');
  app.key('\u0002w'); await Bun.sleep(20);                         // the node-b space: its pane is the tab
  expect(screens.at(-1)!).toContain('│ 🌐 ⇄node-b REVIEW  +');
  reach = 'down'; tick(); await Bun.sleep(30);
  expect(screens.at(-1)!).toContain('✕ ⇄MSB1 WA');             // the space stays, marked unreachable
  expect(screens.at(-1)!).toContain('│ 🌐 ⇄node-b REVIEW ✕  +');                            // and so does its last known tab
  expect(screens.at(-1)!).toContain('⇄node-b ✕');                    // the status line says so too (#38616)
  reach = 'up'; tick(); await Bun.sleep(30);
  expect(screens.at(-1)!).toContain('│ 🌐 ⇄node-b REVIEW  +');
  expect(screens.at(-1)!).not.toContain('🌐 ⇄node-b REVIEW ✕');
});

// ELS-REMOTE-MARKER: every surface (list · tab title · status line) × wide / narrow shows ⇄host, and a down host shows ✕ (not «?»).
for (const [cols, name] of [[120, 'wide'], [40, 'narrow']] as const) {
  test(`app (${name} ${cols} cols): remote pane is ⇄node-b on list/tab/status; after the host goes down the marker is ✕, never «?»`, async () => {
    let reach: 'up' | 'down' = 'up';
    const { app, screens, tick } = remoteApp({ read: async () => ({ exitCode: 0, message: 'remote screen' }),
      list: async () => ({ exitCode: 0, message: JSON.stringify({ hosts: [{ name: 'node-b', reach }], workspaces: [], tabs: [],
        panes: reach === 'up' ? [fedRow('node-b', 'wa', 'tb', 'pc', 'review', 'blocked')] : [] }) }) }, cols);
    await app.start(); await Bun.sleep(20);
    app.key('\u0002w'); await Bun.sleep(20);
    const up = screens.at(-1)!;
    expect(up).toContain('⇄node-b wa');                    // list (wide: side list · narrow: dropdown line)
    expect(up).toContain(cols >= 60 ? '│ 🌐 ⇄node-b REVIEW' : '⇄node-b REVIEW');   // tab title
    expect(up).toContain('⇄node-b wa ▸ review');            // status line
    expect(up).not.toContain('⇄node-b ✕');
    expect(up).not.toContain('✕ ⇄node-b');
    reach = 'down'; tick(); await Bun.sleep(30);
    const down = screens.at(-1)!;
    expect(down).toContain('⇄node-b ✕');  // status line host chip
    expect(down).not.toContain('⇄node-b ?');
    if (cols >= 60) { expect(down).toContain('✕ ⇄MSB1 WA'); expect(down).toContain('│ 🌐 ⇄node-b REVIEW ✕'); }
  });
}

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
  expect(h.requests.filter((r) => r.op === 'close')).toEqual([{ op: 'close', pane: 'p2', confirmed: true }]);
  expect(h.lastScreen()).toContain('완료: 탭 two 닫기');
  const before = h.requests.filter((r) => r.op === 'new').length;
  h.app.key('\u0002:'); h.app.key('새 셸 열어줘\r'); await Bun.sleep(10);
  expect(h.lastScreen()).toContain('→ 새 셸 열기 · Enter 실행 · Esc 취소');
  h.app.key('\r'); await Bun.sleep(20);
  expect(h.requests.filter((r) => r.op === 'new').length - before).toBe(1);
  expect(h.attachments.at(-1)!.typed).toEqual([]);                 // none of the words went into the pane
});

test('voice create reports server refusal rather than success', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle')));
  h.setNewResponse(async () => ({ exitCode: 1, message: 'refused' }));
  await h.app.start();
  h.app.key('\u0002:'); h.app.key('새 셸 열어줘\r'); await Bun.sleep(10);
  h.app.key('\r'); await Bun.sleep(20);
  expect(h.lastScreen()).toContain('refused');
  expect(h.lastScreen()).not.toContain('완료: 새 셸 열기');
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
  expect(h.requests.filter((r) => r.op === 'close-workspace')).toEqual([{ op: 'close-workspace', ws: 'w1', confirmed: true }]);   // only this space
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
  expect(h.requests.filter((r) => r.op === 'close-workspace')).toEqual([{ op: 'close-workspace', ws: 'w1', confirmed: true }]);
});

// ---- ELS-MOUSE ③ (OP #101585): 탭 클릭 → 그 탭 포커스 — attach·입력·반전 표식이 모두 클릭한 탭으로 간다 -------------
const TAB_ROW_CLICK_Y = 1;   // 탭 줄 = 화면 첫 줄(사이드바 오른쪽 · FU3 배치)
const P2_TAB_CLICK_X = 40;   // 사이드바 28칸 + 구분선 1칸 + 첫 탭 8칸 + 간격 1칸 오른쪽, 두 번째 탭 안(패딩 다음 칸 · 1 기반 SGR 좌표)
test('app: 마우스로 탭을 클릭하면 그 탭이 포커스된다 — attach 가 그 pane 으로, 입력이 그 pane 으로, 파랑(SGR 44) 표식이 그 탭으로 이동 (OP #101585 ③)', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle'), row('w1', 'p2', 'two', 'idle'), row('w2', 'p3', 'three', 'idle')));
  await h.app.start();
  expect(h.writes.at(-1) ?? '').toContain('\u001b[44;37m 🛠 ONE \u001b[49;39m');        // 시작 표식은 첫 탭 p1
  h.app.key(click(P2_TAB_CLICK_X, TAB_ROW_CLICK_Y));                        // 두 번째 탭 클릭(SGR press)
  expect(h.attachments.at(-1)!.pane).toBe('p2');                            // attach 가 클릭한 pane 으로
  expect(h.attachments[0]!.detached).toBe(true);                            // 예전 attach 는 해제
  expect(h.writes.at(-1) ?? '').toContain('\u001b[44;37m 🛠 TWO \u001b[49;39m');      // 반전 표식이 그 탭으로
  expect(h.writes.at(-1) ?? '').not.toContain('\u001b[44;37m 🛠 ONE \u001b[49;39m');  // 옛 탭에서는 사라진다
  h.app.key('ls\r');
  expect(h.attachments[1]!.typed).toEqual(['ls\r']);                        // 입력도 이제 그 탭(pane)으로
});

// ---- ELS-SIDEBAR-HERDR-CLEAN: the list's rows are the click targets exactly where they are drawn (head row 1, then one row per space, «new» on the last list line) ----
test('app: sidebar clicks follow the drawn rows — a space row selects its first pane, the «spaces» head does nothing, «new» opens the new-tab name row; releases are swallowed', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle'), row('w1', 'p2', 'two', 'idle'), row('w2', 'p3', 'three', 'idle')));
  await h.app.start();
  const screen = (): string[] => (h.lastScreen() ?? '').split('\r\n');
  expect([screen()[0]!.slice(0, 7), screen()[1]!.slice(0, 11), screen()[2]!.slice(0, 11), screen()[22]!.slice(0, 11)]).toEqual([' spaces', ' ○ NAME-W1 ', ' ○ NAME-W2 ', ' new · menu']);
  h.app.key(click(5, 1)); h.app.key('\u001b[<0;5;1m');                         // the head: consumed, selects nothing
  expect(h.attachments.length).toBe(1);
  h.app.key(click(5, 3)); h.app.key('\u001b[<0;5;3m');                         // second space row → its first pane p3
  expect(h.attachments.at(-1)!.pane).toBe('p3');
  h.app.key(click(3, 23)); h.app.key('\u001b[<0;3;23m');                       // the word «new»
  expect(modalRow(h.writes.at(-1)!, 9)).toContain('┌ 새 탭 이름');
  expect(modalRow(h.writes.at(-1)!, 15)).toContain('└');
  expect(h.attachments.every((a) => a.typed.length === 0)).toBe(true);
}, 10_000);

// ---- ELS-MOUSE-RELEASE (JUD-B #111750): a release follows its press — pane press → release reaches the pane; consumed press → release swallowed --
const PANE_PRESS = '\u001b[<0;50;10M';
const PANE_RELEASE = '\u001b[<0;50;10m';
const releaseApp = async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle'), row('w1', 'p2', 'two', 'idle')));
  await h.app.start();
  return h;
};
test('app: a press in the pane and its release both reach the pane program (whole, and the release split across two chunks)', async () => {
  const h = await releaseApp();
  h.app.key(PANE_PRESS);
  h.app.key(PANE_RELEASE);
  expect(h.attachments[0]!.typed).toEqual([PANE_PRESS, PANE_RELEASE]);
  h.app.key(PANE_PRESS);
  h.app.key('\u001b[<0;50');
  h.app.key(';10m');
  expect(h.attachments[0]!.typed).toEqual([PANE_PRESS, PANE_RELEASE, PANE_PRESS, PANE_RELEASE]);
}, 10_000);

test('app: the release of a pane press passes through wherever it lands (over the list or the tab row too) — the pane saw the press and needs it', async () => {
  const h = await releaseApp();
  h.app.key(PANE_PRESS);
  h.app.key('\u001b[<0;10;2m');
  expect(h.attachments[0]!.typed).toEqual([PANE_PRESS, '\u001b[<0;10;2m']);
  expect(h.attachments).toHaveLength(1);                                     // the release did not select anything
}, 10_000);

test('app: the release of a press the app consumed (tab click, list click, bottom-line click) is swallowed — and the next pane press/release pass again', async () => {
  const h = await releaseApp();
  h.app.key(click(P2_TAB_CLICK_X, TAB_ROW_CLICK_Y));                          // consumed: selects p2
  h.app.key(`\u001b[<0;${P2_TAB_CLICK_X};${TAB_ROW_CLICK_Y}m`);
  h.app.key(click(5, 1));                                                     // consumed: list click on space w1 → p1
  h.app.key('\u001b[<0;5;1m');
  h.app.key(click(5));                                                        // consumed: bottom line, no button there
  h.app.key('\u001b[<0;5;24m');
  expect(h.attachments.every((a) => a.typed.length === 0)).toBe(true);        // no press and no release went to any pane
  h.app.key(PANE_PRESS);
  h.app.key(PANE_RELEASE);
  expect(h.attachments.at(-1)!.typed).toEqual([PANE_PRESS, PANE_RELEASE]);
}, 10_000);

// ---- ELS-NARROW-TAB-DROPDOWN: narrow width folds the side list into one top row «emoji tab ▾» that opens a tab list -----------
const narrowList = listOf(row('w1', 'p1', 'shell', 'idle'), row('w1', 'p2', 'build', 'working'), row('w2', 'p3', 'repl', 'blocked'));
const PRESS = (x: number, y: number): string => `\u001b[<0;${x};${y}M`;
const RELEASE = (x: number, y: number): string => `\u001b[<0;${x};${y}m`;

test('narrow dropdown: width 120 keeps the side list; width 60 drops it for one top row «tab ▾» and the pane takes the whole width', async () => {
  const wide = harness(narrowList, { cols: 120, rows: 24 });
  await wide.app.start();
  expect(wide.lastScreen()).toContain('NAME-W1');
  expect(wide.lastScreen()).not.toContain('▾');
  const size = { cols: 60, rows: 24 };
  const h = harness(narrowList, size);
  await h.app.start();
  const screen = h.lastScreen().split('\r\n');
  expect(screen[0]).toContain('🛠 SHELL  ▾');
  expect(h.writes.at(-1) ?? '').toContain('\u001b[44;37m 🛠 SHELL \u001b[49;39m ▾');   // ELS-TAB-STYLE-HERDR: the current tab, UPPERCASE on blue
  expect(h.lastScreen()).not.toContain('NAME-W1');
  expect(h.attachments[0]!.size).toEqual({ cols: 60, rows: 22 });
});

test('narrow dropdown: ctrl+b s opens the list (spaces → tabs with status marks); j then Enter switches the tab and closes it; Esc closes without switching', async () => {
  const h = harness(narrowList, { cols: 60, rows: 24 });
  await h.app.start();
  h.app.key('\u0002s');
  const open = h.lastScreen().split('\r\n');
  expect(open.slice(1, 6).map((line) => line.trim())).toEqual(['name-w1', expect.stringContaining('shell ○'), expect.stringContaining('build ●'), 'name-w2', expect.stringContaining('repl ')]);
  h.app.key('j');
  h.app.key('\r');
  expect(h.attachments.map((a) => a.pane)).toEqual(['p1', 'p2']);
  expect(h.lastScreen().split('\r\n')[0]).toContain('🛠 BUILD  ▾');
  expect(h.lastScreen()).not.toContain('name-w2');
  h.app.key('\u0002s');
  expect(h.lastScreen()).toContain('name-w2');
  h.app.key('\u001b');
  expect(h.lastScreen()).not.toContain('name-w2');
  expect(h.attachments.map((a) => a.pane)).toEqual(['p1', 'p2']);
  expect(h.attachments.at(-1)!.typed).toEqual([]);                 // the dropdown keys never reached the pane
});

test('narrow dropdown: a click on the top row opens the list, a click on a tab switches and closes; each consumed press swallows its release; a click outside only closes', async () => {
  const h = harness(narrowList, { cols: 60, rows: 24 });
  await h.app.start();
  h.app.key(PRESS(10, 1)); h.app.key(RELEASE(10, 1));
  expect(h.lastScreen()).toContain('name-w2');
  h.app.key(PRESS(10, 6)); h.app.key(RELEASE(10, 6));              // the «repl» line
  expect(h.attachments.map((a) => a.pane)).toEqual(['p1', 'p3']);
  expect(h.lastScreen().split('\r\n')[0]).toContain('🛠 REPL  ▾');
  expect(h.lastScreen()).not.toContain('name-w2');
  h.app.key(PRESS(10, 1)); h.app.key(RELEASE(10, 1));
  h.app.key(PRESS(10, 20)); h.app.key(RELEASE(10, 20));            // below the list
  expect(h.lastScreen()).not.toContain('name-w2');
  expect(h.attachments.map((a) => a.pane)).toEqual(['p1', 'p3']);
  expect(h.attachments.flatMap((a) => a.typed)).toEqual([]);       // neither presses nor releases leaked to the pane
});

test('narrow dropdown: widening past the threshold closes the list and brings the side list back; ctrl+b s there still folds the side list', async () => {
  const size = { cols: 60, rows: 24 };
  const h = harness(narrowList, size);
  await h.app.start();
  h.app.key('\u0002s');
  expect(h.lastScreen()).toContain('name-w2');
  size.cols = 120;
  h.app.resized();
  expect(h.lastScreen()).toContain('NAME-W1');
  expect(h.lastScreen()).not.toContain('▾');
  expect(h.attachments[0]!.resizes.at(-1)).toEqual([91, 22]);
  h.app.key('\u0002s');
  expect(h.lastScreen()).not.toContain('NAME-W1');
});

test('app: wheel over the pane and ctrl+b [ / ] ask the server to scroll the attached pane; the status line says how far up the frame is', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle')));
  await h.app.start();
  h.app.key('\u001b[<64;60;10M');                                  // wheel up (SGR 1006), over the pane
  h.app.key('\u001b[<65;60;10M');                                  // wheel down
  h.app.key('\u0002[');
  h.app.key('\u0002]');
  expect(h.attachments[0]!.scrolls).toEqual([3, -3, 20, -20]);     // a page is the terminal height (24) - 4
  h.attachments[0]!.handlers.onFrame({ pane: 'p1', seq: 1, cols: 51, rows: 23, back: 7, screen: '[screen 51x23 scrolled-back=7]\nold' });
  expect(h.lastScreen()).toContain('스크롤백 7줄 위');
  h.attachments[0]!.handlers.onFrame({ pane: 'p1', seq: 2, cols: 51, rows: 23, back: 0, screen: '[screen 51x23 cursor=(row 0, col 0, visible true)]\nlive' });
  expect(h.lastScreen()).not.toContain('스크롤백');
});

// ---- D1a(ELS-SERVER-RESTART-SURVIVE): a lost els server is waited out, and the pane comes back as it was ------------------

test('D1a: the server going away mid-session keeps the view and the screen; the poll re-attaches when the server answers again', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle')));
  await h.app.start();
  h.attachments[0]!.handlers.onFrame({ pane: 'p1', seq: 1, cols: 51, rows: 22, back: 0, screen: 'SAME CHILD STILL RUNNING' });
  expect(h.lastScreen()).toContain('SAME CHILD STILL RUNNING');
  // the els server is killed under the attach: the socket closes, the attach ends
  h.attachments[0]!.handlers.onEnd(1, 'els: the els server closed the connection');
  expect(h.lastScreen()).toContain('SAME CHILD STILL RUNNING');          // the screen it had is kept, not blanked
  expect(h.lastScreen()).toContain('서버 재기동 중 — 다시 붙는 중…');
  expect(await Promise.race([h.app.done.then(() => 'ended'), Bun.sleep(30).then(() => 'still running')])).toBe('still running');
  // while the server is away the poll keeps asking and nothing ends; no blind re-attach attempts either
  h.setLsAway('els: no els server is running — start it with `els serve` (or `elanous side serve`)');
  h.tick(); await Bun.sleep(10);
  expect(h.lastScreen()).toContain('서버 재기동 중 — 다시 붙는 중…');
  expect(h.attachments).toHaveLength(1);
  expect(await Promise.race([h.app.done.then(() => 'ended'), Bun.sleep(30).then(() => 'still running')])).toBe('still running');
  // the server is back: the next poll re-attaches the same pane without clearing the screen, and its first frame repaints it
  h.setLsAway(undefined);
  h.tick(); await Bun.sleep(10);
  expect(h.attachments).toHaveLength(2);
  expect(h.attachments[1]!.pane).toBe('p1');
  expect(h.attachments[1]!.size).toEqual({ cols: 51, rows: 22 });
  expect(h.lastScreen()).toContain('SAME CHILD STILL RUNNING');          // the old screen was never blanked
  h.attachments[1]!.handlers.onFrame({ pane: 'p1', seq: 2, cols: 51, rows: 22, back: 0, screen: 'SAME CHILD, PAINTED AGAIN AFTER THE RESTART' });
  expect(h.lastScreen()).toContain('SAME CHILD, PAINTED AGAIN AFTER THE RESTART');
  expect(h.lastScreen()).not.toContain('서버 재기동 중');                 // the note goes with the wait
  // and the wait-out never swallows a real end: the pane exiting as the last one still closes the view with 0
  h.attachments[1]!.handlers.onEnd(0, 'pane exited');
  expect(await h.app.done).toEqual({ code: 0, message: '' });
});

test('D1a: a graceful server stop ends the attach as «the server is stopping» — the same wait-out, then the poll re-attaches', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle')));
  await h.app.start();
  h.attachments[0]!.handlers.onFrame({ pane: 'p1', seq: 1, cols: 51, rows: 22, back: 0, screen: 'CHILD BEFORE THE GRACEFUL STOP' });
  // the server is stopped on purpose (els serve SIGTERM → close()): the attach ends as the server going away
  h.attachments[0]!.handlers.onEnd(1, 'the server is stopping');
  expect(h.lastScreen()).toContain('CHILD BEFORE THE GRACEFUL STOP');   // the screen it had is kept, not blanked
  expect(h.lastScreen()).toContain('서버 재기동 중 — 다시 붙는 중…');
  expect(await Promise.race([h.app.done.then(() => 'ended'), Bun.sleep(30).then(() => 'still running')])).toBe('still running');
  // the new server answers: the next poll re-attaches the same pane and its first frame repaints it
  h.tick(); await Bun.sleep(10);
  expect(h.attachments).toHaveLength(2);
  expect(h.attachments[1]!.pane).toBe('p1');
  h.attachments[1]!.handlers.onFrame({ pane: 'p1', seq: 2, cols: 51, rows: 22, back: 0, screen: 'SAME CHILD AFTER THE RESTART' });
  expect(h.lastScreen()).toContain('SAME CHILD AFTER THE RESTART');
  expect(h.lastScreen()).not.toContain('서버 재기동 중');                 // the note goes with the wait
});

test('D1a: a server already away at the first list still ends the view with its message — the wait-out starts after a good list', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle')));
  h.setLsAway('els: no els server is running — start it with `els serve` (or `elanous side serve`)');
  await h.app.start();
  expect(await h.app.done).toEqual({ code: 1, message: 'els: no els server is running — start it with `els serve` (or `elanous side serve`)' });
});

test('D1a r2: an attach refused for a reason that is not the server going away is not retried by the poll — the reason stays on the status line', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle')));
  await h.app.start();
  h.attachments[0]!.handlers.onEnd(1, 'els: attach denied — caller is a pane process (seat HAND-X); present the pane token');
  await Bun.sleep(10);
  expect(h.lastScreen()).toContain('attach denied');
  expect(h.lastScreen()).not.toContain('서버 재기동 중');
  for (let n = 0; n < 5; n++) { h.tick(); await Bun.sleep(10); }       // five polls later the server answers fine — still no blind re-attach
  expect(h.attachments).toHaveLength(1);
  // an unknown pane is the same: a real end, never a retry loop
  const g = harness(listOf(row('w1', 'p1', 'one', 'idle')));
  await g.app.start();
  g.attachments[0]!.handlers.onEnd(1, 'els attach: unknown pane p1');
  for (let n = 0; n < 5; n++) { g.tick(); await Bun.sleep(10); }
  expect(g.attachments).toHaveLength(1);
});

test('D1a r2: a typing refusal from the server (the attach stays view-only) is shown on the status line, not swallowed', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle')));
  await h.app.start();
  h.attachments[0]!.handlers.onFrame({ pane: 'p1', seq: 1, cols: 51, rows: 22, back: 0, screen: 'VIEW ONLY' });
  h.attachments[0]!.handlers.onError?.('els: input denied — present the owner token');
  expect(h.lastScreen()).toContain('input denied');
});

// ---- ELS-NEW-TAB-NAME-WIDGET: «+» and ctrl+b c open the name prompt; the name goes to the new request's title only ----------
const plusAt = (h: ReturnType<typeof harness>): number => { const top = h.lastScreen().split('\r\n')[0]!; return Bun.stringWidth(top.slice(0, top.lastIndexOf('+'))) + 1; };

test('app: clicking «+» opens the name prompt (press consumed, its release swallowed); typed text edits the row, not the pane; Enter makes a tab with that title', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle')));
  await h.app.start();
  const x = plusAt(h);
  h.app.key(`\u001b[<0;${x};1M`); h.app.key(`\u001b[<0;${x};1m`);
  expect(modalRow(h.writes.at(-1)!, 9)).toContain('┌ 새 탭 이름');
  expect(modalRow(h.writes.at(-1)!, 10)).toContain('Name');
  expect(modalRow(h.writes.at(-1)!, 15)).toContain('└');
  h.app.key('빌드 x'); h.app.key('\u007f');
  expect(await renderedRow(h.writes.at(-1)!, 11)).toContain('빌드 ');
  expect(h.attachments.at(-1)!.typed).toEqual([]);               // nothing reached the pane (not the text, not the click or its release)
  h.app.key('\r'); await Bun.sleep(20);
  expect(h.requests.filter((r) => r.op === 'new')).toEqual([{ op: 'new', ws: 'name-w1', cwd: '/work/proj', command: ['/bin/zsh'], title: '빌드' }]);
  expect(modalRow(h.writes.at(-1)!, 9)).not.toContain('새 탭 이름');
});

test('app: Esc cancels (no request), Ctrl+C clears, ESC bytes and ctrl+b c typed into the prompt never go to the pane', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one', 'idle')));
  await h.app.start();
  h.app.key('\u0002c'); h.app.key('abc\u0003z');
  expect(await renderedRow(h.writes.at(-1)!, 11)).toContain('z');
  expect(await renderedRow(h.writes.at(-1)!, 11)).not.toContain('abc');
  h.app.key('\u001b[3;5~\u0002\u0002q');                        // an unknown sequence, a literal ctrl+b: all swallowed by the prompt
  h.app.key('\u001b'); await Bun.sleep(60);
  expect(modalRow(h.writes.at(-1)!, 9)).not.toContain('새 탭 이름');
  expect(h.requests.filter((r) => r.op === 'new')).toEqual([]);
  expect(h.attachments.at(-1)!.typed).toEqual([]);
});
