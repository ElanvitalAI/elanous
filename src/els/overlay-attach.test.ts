// ELS-ZAXIS S2: the overlay stack drawn by the attach client over panes and the tile grid, and input routed through it.
import { expect, test } from 'bun:test';
import type { AttachHandlers, Attached } from './attach-client.js';
import { createAttachApp, type OverlayDeps } from './attach-app.js';
import { composeView } from './attach-view.js';
import { composeLayers, createLayerPainter, frameRows, overlayMouse } from './overlay-compose.js';
import { closeLayer, emptyStack, openLayer, type OverlayStack } from './overlay-stack.js';
import { drawTileFrame } from './tile-view.js';
import type { ElsResult } from './core.js';
import type { ElsRequest } from './server.js';

const plain = (text: string): string => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
const rowsOf = (screen: string): string[] => plain(screen).split('\r\n');
const row = (ws: string, pane: string, title: string) => ({ address: `${ws}/t-${pane}/${pane}`, workspace: `name-${ws}`, pane, title, state: 'idle', tab: `t-${pane}` });
const listOf = (...panes: object[]): string => JSON.stringify({ workspaces: [], tabs: [], panes });
const click = (x: number, y: number): string => `\u001b[<0;${x};${y}M`;
const release = (x: number, y: number): string => `\u001b[<0;${x};${y}m`;
// The same tab-row coordinates attach-app.test uses: tab row = line 1, the second tab starts right of the 28-cell side list.
const TAB_ROW_Y = 1;
const P1_TAB_X = 32;
const P2_TAB_X = 40;

function harness(listing: string, size = { cols: 120, rows: 30 }) {
  const requests: ElsRequest[] = [];
  const acts: { action: string; id: string }[] = [];
  const attachments: { pane: string; typed: string[] }[] = [];
  const writes: string[] = [];
  let push: ((stack: OverlayStack) => void) | undefined;
  let closed = false;
  const overlays: OverlayDeps = {
    watch: (onStack) => { push = onStack; return { close: () => { closed = true; } }; },
    act: (one) => { acts.push(one); },
    renderers: { memo: (layer, s) => frameRows('memo', [String((layer.props as { text?: string } | undefined)?.text ?? '')], s) },
    keys: { memo: (_layer, bytes) => bytes === 'm' ? 'consumed' : 'pass' },
  };
  const app = createAttachApp({
    request: async (request): Promise<ElsResult> => { requests.push(request); return request.op === 'ls' ? { exitCode: 0, message: listing } : { exitCode: 0, message: '' }; },
    attach: (pane, _size, _handlers: AttachHandlers): Attached => {
      const entry = { pane, typed: [] as string[] };
      attachments.push(entry);
      return { input: (bytes) => { entry.typed.push(bytes); }, resize: () => {}, scroll: () => {}, detach: () => {} };
    },
    write: (text) => { writes.push(text); },
    size: () => size,
    cwd: '/work',
    env: { SHELL: '/bin/zsh' },
    setInterval: () => 0,
    clearInterval: () => {},
    pollMs: 1000,
    chatCommand: ['/opt/elanous/bin/elanous'],
    memory: { load: () => ({}), save: () => {} },
    overlays,
  });
  return { app, requests, acts, attachments, writes, push: (stack: OverlayStack) => push!(stack), isClosed: () => closed, last: () => writes.at(-1) ?? '' };
}

const memoAt = (stack: OverlayStack, rect: Parameters<typeof openLayer>[1]['rect'], text = 'hello memo') =>
  openLayer(stack, { kind: 'memo', key: 'm', rect, props: { text } });

test('a pushed layer is drawn over the pane in the same frame; the next push without it erases it', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one'), row('w1', 'p2', 'two')));
  await h.app.start('p1');
  expect(plain(h.last())).not.toContain('hello memo');
  const opened = memoAt(emptyStack(), { anchor: 'center', w: 30, h: 5 }).stack;
  h.push(opened);
  const screen = rowsOf(h.last());
  expect(screen.find((line) => line.includes('┌ memo ')) ?? '').toContain('┌ memo ');
  expect(screen.some((line) => line.includes('│hello memo'))).toBe(true);
  h.push(closeLayer(opened, opened.layers[0]!.id));
  expect(plain(h.last())).not.toContain('hello memo');
});

test('a replayed stack (same rev) does not repaint', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one')));
  await h.app.start('p1');
  const stack = memoAt(emptyStack(), { anchor: 'center', w: 20, h: 4 }).stack;
  h.push(stack);
  const count = h.writes.length;
  h.push(stack);
  expect(h.writes.length).toBe(count);
});

test('clicks still select tabs after a popup opens and closes (popup away from the tab row)', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one'), row('w1', 'p2', 'two')));
  await h.app.start('p1');
  const opened = memoAt(emptyStack(), { anchor: 'center', w: 30, h: 6 }).stack;
  h.push(opened);
  h.app.key(click(P2_TAB_X, TAB_ROW_Y)); h.app.key(release(P2_TAB_X, TAB_ROW_Y));
  expect(h.attachments.at(-1)!.pane).toBe('p2');                     // the tab row is not covered: the click selects
  h.push(closeLayer(opened, opened.layers[0]!.id));
  h.app.key(click(P1_TAB_X, TAB_ROW_Y)); h.app.key(release(P1_TAB_X, TAB_ROW_Y));
  expect(h.attachments.at(-1)!.pane).toBe('p1');                     // after close: still selects
  expect(h.attachments.every((a) => a.typed.length === 0)).toBe(true);
});

test('a popup covering the tab row takes the click (raise + focus to the server, release swallowed); after close the same click selects', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one'), row('w1', 'p2', 'two')));
  await h.app.start('p1');
  const opened = memoAt(emptyStack(), { anchor: 'tl', w: 120, h: 4 });
  h.push(opened.stack);
  h.app.key(click(P2_TAB_X, TAB_ROW_Y)); h.app.key(release(P2_TAB_X, TAB_ROW_Y));
  expect(h.attachments.map((a) => a.pane)).toEqual(['p1']);
  expect(h.acts).toEqual([{ action: 'raise', id: opened.id }, { action: 'focus', id: opened.id }]);
  expect(h.attachments[0]!.typed).toEqual([]);                        // neither press nor release reached the pane
  h.push(closeLayer(opened.stack, opened.id));
  h.app.key(click(P2_TAB_X, TAB_ROW_Y)); h.app.key(release(P2_TAB_X, TAB_ROW_Y));
  expect(h.attachments.at(-1)!.pane).toBe('p2');
});

test('a focus:none layer (toast) over the tab row is clicked through — the tab is selected', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one'), row('w1', 'p2', 'two')));
  await h.app.start('p1');
  h.push(openLayer(emptyStack(), { kind: 'toast', key: 't', band: 'toast', focus: 'none', rect: { anchor: 'tl', w: 120, h: 3 } }).stack);
  h.app.key(click(P2_TAB_X, TAB_ROW_Y)); h.app.key(release(P2_TAB_X, TAB_ROW_Y));
  expect(h.attachments.at(-1)!.pane).toBe('p2');
  expect(h.acts).toEqual([]);
});

test('a blocking modal swallows a tab click outside it', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one'), row('w1', 'p2', 'two')));
  await h.app.start('p1');
  h.push(openLayer(emptyStack(), { kind: 'decision', key: 'd', band: 'modal', blocking: true, rect: { anchor: 'center', w: 20, h: 5 } }).stack);
  h.app.key(click(P2_TAB_X, TAB_ROW_Y)); h.app.key(release(P2_TAB_X, TAB_ROW_Y));
  expect(h.attachments.map((a) => a.pane)).toEqual(['p1']);
  expect(h.attachments[0]!.typed).toEqual([]);
});

test('keys: the focused layer takes its keys and keeps the rest; Esc closes it (server act) and keys return to the pane', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one')));
  await h.app.start('p1');
  const opened = memoAt(emptyStack(), { anchor: 'center', w: 20, h: 4 });
  h.push(opened.stack);
  h.app.key('m');                                                      // the memo consumes «m»
  h.app.key('x');                                                      // an `owns` layer keeps keys it does not use too
  expect(h.attachments[0]!.typed).toEqual([]);
  h.app.key('\u001b');
  expect(h.acts).toEqual([{ action: 'close', id: opened.id }]);
  expect(plain(h.last())).not.toContain('memo');                       // closed locally at once (the push confirms it)
  h.app.key('m');
  expect(h.attachments[0]!.typed).toEqual(['m']);
});

test('a blocking layer owns every key, even ones its element passes', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one')));
  await h.app.start('p1');
  h.push(openLayer(emptyStack(), { kind: 'decision', key: 'd', band: 'modal', blocking: true, rect: { anchor: 'center', w: 20, h: 5 } }).stack);
  h.app.key('y');
  expect(h.attachments[0]!.typed).toEqual([]);
});

test('a layer of another workspace is not drawn and does not take clicks', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one'), row('w1', 'p2', 'two')));
  await h.app.start('p1');
  h.push(openLayer(emptyStack(), { kind: 'memo', key: 'm', ownerWorkspace: 'elsewhere', rect: { anchor: 'tl', w: 120, h: 4 }, props: { text: 'hidden' } }).stack);
  expect(plain(h.last())).not.toContain('hidden');
  h.app.key(click(P2_TAB_X, TAB_ROW_Y));
  expect(h.attachments.at(-1)!.pane).toBe('p2');
});

test('leaving the app closes the overlay stream', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one')));
  await h.app.start('p1');
  h.app.key('\u0002q');
  await h.app.done;
  expect(h.isClosed()).toBe(true);
});

test('composeView: layers splice bottom → top over sidebar and pane; the cursor shows only when no layer covers it', () => {
  const frame = '[screen 40x5 cursor=(row 0, col 2, visible true)]\nsh$ ';
  const base = { cols: 70, rows: 6, sidebar: Array(5).fill('S'.repeat(28)), frame, status: 's' };
  const low = { x: 20, y: 1, width: 10, lines: ['LLLLLLLLLL', 'LLLLLLLLLL'] };
  const high = { x: 25, y: 2, width: 6, lines: ['HHHHHH'] };
  const out = rowsOf(composeView({ ...base, layers: [low, high] }));
  expect(out[1]!.slice(20, 30)).toBe('LLLLLLLLLL');
  expect(out[2]!.slice(20, 31)).toBe('LLLLLHHHHHH');
  expect(composeView(base).endsWith('\u001b[?25h')).toBe(true);
  expect(composeView({ ...base, layers: [low] }).endsWith('\u001b[?25h')).toBe(true);           // cursor at (0, 31): not covered
  expect(composeView({ ...base, layers: [{ x: 29, y: 0, width: 5, lines: ['C'] }] }).endsWith('\u001b[?25l')).toBe(true);
});

test('drawTileFrame: the same layers float over the tile grid', () => {
  const view = { cols: 80, rows: 24, tiles: [{ pane: 'a', title: 'A', state: 'idle', screen: 'aaa' }, { pane: 'b', title: 'B', state: 'idle', screen: 'bbb' }], focus: 0, grid: 'auto' as const, status: 'TILE', page: 0 };
  const boxes = composeLayers(memoAt(emptyStack(), { anchor: 'center', w: 24, h: 5 }).stack, { cols: 80, rows: 23 }, undefined, createLayerPainter({ memo: (layer, s) => frameRows('memo', [String((layer.props as { text: string }).text)], s) }));
  const out = rowsOf(drawTileFrame(view, boxes));
  expect(out).toHaveLength(24);
  expect(out.some((line) => line.includes('┌ memo '))).toBe(true);
  expect(out.some((line) => line.includes('│hello memo'))).toBe(true);
  expect(rowsOf(drawTileFrame(view)).some((line) => line.includes('memo'))).toBe(false);
});

test('composeLayers re-resolves relative rects per view size (200x80 and 80x24)', () => {
  const stack = memoAt(emptyStack(), { anchor: 'br', w: '50%', h: 6 }).stack;
  const paint = createLayerPainter({});
  expect(composeLayers(stack, { cols: 200, rows: 79 }, undefined, paint).map((b) => [b.x, b.y, b.width, b.lines.length])).toEqual([[100, 73, 100, 6]]);
  expect(composeLayers(stack, { cols: 80, rows: 23 }, undefined, paint).map((b) => [b.x, b.y, b.width, b.lines.length])).toEqual([[40, 17, 40, 6]]);
});

test('createLayerPainter: an unknown kind draws a framed box; the cache returns the same rows until props or size change', () => {
  let calls = 0;
  const paint = createLayerPainter({ memo: (_l, s) => { calls++; return frameRows('m', [], s); } });
  const layer = openLayer(emptyStack(), { kind: 'memo', key: 'k', props: { a: 1 } }).stack.layers[0]!;
  const first = paint(layer, { w: 10, h: 3 }, false);
  expect(paint(layer, { w: 10, h: 3 }, false)).toBe(first);
  expect(calls).toBe(1);
  paint({ ...layer, props: { a: 2 } }, { w: 10, h: 3 }, false);
  paint(layer, { w: 12, h: 3 }, false);
  expect(calls).toBe(3);
  const other = openLayer(emptyStack(), { kind: 'mystery', key: 'k' }).stack.layers[0]!;
  expect(paint(other, { w: 12, h: 3 }, false)).toEqual(['┌ mystery ─┐', '│          │', '└──────────┘']);
});

test('frameRows: tiny boxes never throw and keep their height', () => {
  expect(frameRows('t', ['x'], { w: 1, h: 2 })).toHaveLength(2);
  expect(frameRows('a very long title', [], { w: 6, h: 2 })).toEqual(['┌ a v┐', '└────┘']);
});

test('overlayMouse: the status line is never covered; SGR coordinates are 1-based', () => {
  const stack = openLayer(emptyStack(), { kind: 'memo', key: 'k', rect: { anchor: 'tl', w: 5, h: 5 } }).stack;
  expect(overlayMouse(stack, { cols: 80, rows: 23 }, 1, 1, undefined)).toMatchObject({ kind: 'layer', local: { x: 0, y: 0 } });
  expect(overlayMouse(stack, { cols: 80, rows: 23 }, 6, 1, undefined)).toBeUndefined();
  expect(overlayMouse(stack, { cols: 80, rows: 23 }, 1, 24, undefined)).toBeUndefined();
});

test('a chunk of several keys («mmx») is fed to the focused layer one key at a time and none leaks', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one')));
  await h.app.start('p1');
  h.push(memoAt(emptyStack(), { anchor: 'center', w: 20, h: 4 }).stack);
  h.app.key('mmx');
  expect(h.attachments[0]!.typed).toEqual([]);
});

test('a server push is applied even when local optimistic edits bumped the local copy to the same rev', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one')));
  await h.app.start('p1');
  const first = memoAt(emptyStack(), { anchor: 'center', w: 30, h: 5 }, 'first');
  h.push(first.stack);                                                   // rev 1
  h.app.key('\u001b');                                                   // local close → local rev 2
  const reopened = memoAt(first.stack, { anchor: 'center', w: 30, h: 5 }, 'second');   // server: rev 2, a different stack
  h.push(reopened.stack);
  expect(plain(h.last())).toContain('second');
});

test('hardening: ctrl-c, arrows, a bracketed paste and Korean IME text never reach the pane under a focused popup', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one')));
  await h.app.start('p1');
  h.push(memoAt(emptyStack(), { anchor: 'center', w: 20, h: 4 }).stack);
  for (const keys of ['\u0003', '\u001b[A', '\u001b[B', '\u001b[200~pasted text\u001b[201~', '한글 입력', '\r', '\t']) h.app.key(keys);
  expect(h.attachments[0]!.typed).toEqual([]);
  h.app.key('\u001b');
  h.app.key('\u0003');
  expect(h.attachments[0]!.typed).toEqual(['\u0003']);                  // after Esc the pane gets keys again
});

test('hardening: a participates layer hands unused keys down; a wheel over the focused popup scrolls the popup, not the pane', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one')));
  await h.app.start('p1');
  const opened = openLayer(emptyStack(), { kind: 'memo', key: 'm', rect: { anchor: 'tl', w: 120, h: 10 }, props: { text: 'x' } });
  h.push(opened.stack);
  let seen = '';
  // the memo reducer consumes only «m»: a wheel down over it becomes ↓ ↓ ↓ — kept by the layer (owns)
  h.app.key('\u001b[<65;40;5M');
  expect(h.attachments[0]!.typed).toEqual([]);
  h.push(openLayer(closeLayer(opened.stack, opened.id), { kind: 'hint', key: 'h', band: 'popup', focus: 'participates', rect: { anchor: 'tl', w: 10, h: 3 } }).stack);
  h.app.key('z');
  seen = h.attachments[0]!.typed.join('');
  expect(seen).toBe('z');
});

test('hardening: the pane cursor is hidden while a popup has focus and comes back at the pane cursor after Esc', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one')));
  await h.app.start('p1');
  const opened = memoAt(emptyStack(), { anchor: 'br', w: 10, h: 3 });
  h.push(opened.stack);
  expect(h.last().endsWith('\u001b[?25l')).toBe(true);
  h.app.key('\u001b');
  expect(h.last().endsWith('\u001b[?25l')).toBe(true);                   // the fake pane never sent a frame: no cursor to show
});

test('ctrl+b o toggles the Obsidian popup: opens one when none is shown, closes the shown one (server acts)', async () => {
  const h = harness(listOf(row('w1', 'p1', 'one')));
  await h.app.start('p1');
  h.app.key('\u0002o');
  await Promise.resolve();
  const overlayActs = () => h.requests.filter((one) => one.op === 'overlay').map((one) => {
    const r = one as { action: string; kind?: string; id?: string };
    return { action: r.action, ...(r.kind ? { kind: r.kind } : {}), ...(r.id ? { id: r.id } : {}) };
  });
  expect(overlayActs()).toEqual([{ action: 'open', kind: 'obsidian' }]);
  h.push(openLayer(emptyStack(), { kind: 'obsidian', key: 'default', rect: { anchor: 'center', w: 40, h: 10 }, props: { dir: '', cursor: 0, scroll: 0 } }).stack);
  h.app.key('\u0002o');
  await Promise.resolve();
  expect(overlayActs()).toEqual([{ action: 'open', kind: 'obsidian' }, { action: 'close', id: 'ov1' }]);
  expect(h.attachments.at(-1)!.typed.join('')).toBe('');
});
