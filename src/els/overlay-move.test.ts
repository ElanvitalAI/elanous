// ELS-POPUP-MOVE/RESIZE (대표 11-26 B2): pure rect moves, the registry acts, the act-view tier, and no mouse-mode escapes.
// Expected boxes are literals for a 120×29 view, never computed with the product's resolveRect.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moveRect, parseStack, resizeRect, resolveRect, type OverlayRect } from './overlay-stack.js';
import { createOverlayRegistry } from './overlay-registry.js';
import { authorizeRequest, isMutating } from './server-auth.js';

const VIEW = { cols: 120, rows: 29 };
const POPUP: OverlayRect = { anchor: 'center', w: '80%', h: '80%' };
let root = '';
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'els-move-')); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

test('move keeps the anchor, stops at the edges and stores only the effective offset', () => {
  expect(resolveRect(POPUP, VIEW)).toEqual({ x: 12, y: 3, w: 96, h: 23 });
  const moved = moveRect(POPUP, VIEW, 5, -2);
  expect(moved).toEqual({ anchor: 'center', w: '80%', h: '80%', dx: 5, dy: -2 });
  expect(resolveRect(moved, VIEW)).toEqual({ x: 17, y: 1, w: 96, h: 23 });
  const pushed = moveRect(POPUP, VIEW, 500, 500);
  expect(resolveRect(pushed, VIEW)).toEqual({ x: 24, y: 6, w: 96, h: 23 });
  expect(pushed).toEqual({ anchor: 'center', w: '80%', h: '80%', dx: 12, dy: 3 });
  expect(resolveRect(moveRect(pushed, VIEW, -1, 0), VIEW)).toEqual({ x: 23, y: 6, w: 96, h: 23 });   // one step back = one cell
  expect(moveRect(moveRect(POPUP, VIEW, 3, 0), VIEW, -3, 0)).toEqual(POPUP);
});

test('resize moves the bottom-right corner, keeps the top-left, never below 12×4 nor past the view', () => {
  expect(resizeRect(POPUP, VIEW, -10, -5)).toEqual({ anchor: 'tl', w: 86, h: 18, dx: 12, dy: 3 });
  expect(resolveRect(resizeRect(POPUP, VIEW, -500, -500), VIEW)).toEqual({ x: 12, y: 3, w: 12, h: 4 });
  expect(resolveRect(resizeRect(POPUP, VIEW, 500, 500), VIEW)).toEqual({ x: 12, y: 3, w: 108, h: 26 });
  expect(resizeRect({ anchor: 'tl', w: 10, h: 3 }, { cols: 10, rows: 3 }, 5, 5)).toEqual({ anchor: 'tl', w: 10, h: 3 });
});

test('registry: move and resize change the rect (persisted), refuse bad deltas and a missing view', () => {
  const dir = join(root, 'reg');
  const registry = createOverlayRegistry({ dir, setTimer: () => 0, clearTimer: () => {} });
  const id = (JSON.parse(registry.apply({ action: 'open', kind: 'obsidian', props: {} }).message) as { id: string }).id;
  expect(registry.apply({ action: 'move', id, dx: -4, dy: 1, view: VIEW }).exitCode).toBe(0);
  expect(resolveRect(registry.stack().layers[0]!.rect, VIEW)).toEqual({ x: 8, y: 4, w: 96, h: 23 });
  expect(registry.apply({ action: 'resize', kind: 'obsidian', dx: -6, dy: -3, view: VIEW }).exitCode).toBe(0);
  expect(resolveRect(registry.stack().layers[0]!.rect, VIEW)).toEqual({ x: 8, y: 4, w: 90, h: 20 });
  expect(registry.apply({ action: 'move', id, dx: 1.5, view: VIEW }).exitCode).toBe(2);
  expect(registry.apply({ action: 'move', id, dx: 2000, view: VIEW }).exitCode).toBe(2);
  expect(registry.apply({ action: 'move', id, dx: 1 }).exitCode).toBe(2);
  expect(registry.apply({ action: 'move', kind: 'nope', dx: 1, view: VIEW }).exitCode).toBe(1);
  const rev = registry.stack().rev;
  registry.apply({ action: 'move', id, dx: 0, dy: 0, view: VIEW });
  expect(registry.stack().rev).toBe(rev);                                     // nothing moved: no push
  // a tile is placed by the tile grid: it does not move until it is a popup again
  registry.apply({ action: 'frame', id, frame: 'tile' });
  expect(registry.apply({ action: 'move', id, dx: 1, view: VIEW }).exitCode).toBe(2);
  registry.apply({ action: 'frame', id, frame: 'popup' });
  registry.apply({ action: 'move', id, dx: -4, dy: 1, view: VIEW });
  registry.apply({ action: 'resize', id, dx: -6, dy: -3, view: VIEW });
  const saved = parseStack(JSON.parse(readFileSync(join(dir, 'overlays.json'), 'utf8')));
  expect(resolveRect(saved!.layers[0]!.rect, VIEW)).toEqual({ x: 8, y: 4, w: 90, h: 20 });
});

test('act-view tier: move/resize are mutating overlay acts — OP everywhere, a hand pane only in its own workspace', () => {
  for (const action of ['move', 'resize']) {
    const request = { op: 'overlay', action, id: 'ov1', dx: 1, dy: 0 };
    expect(isMutating(request)).toBe(true);
    expect(authorizeRequest({ kind: 'op', pane: 'p1' }, request, 'w2', undefined).allow).toBe(true);
    expect(authorizeRequest({ kind: 'hand', seat: 'TC', workspaces: ['w1'], pane: 'p2' }, request, 'w1', undefined).allow).toBe(true);
    expect(authorizeRequest({ kind: 'hand', seat: 'TC', workspaces: ['w1'], pane: 'p2' }, request, 'w2', undefined).allow).toBe(false);
  }
});

test('no mouse-mode escapes in the move/resize code (#40224 dead-click incident)', () => {
  for (const file of ['overlay-stack.ts', 'overlay-registry.ts', 'overlay-compose.ts']) {
    expect(readFileSync(join(import.meta.dir, file), 'utf8')).not.toMatch(/\?100[0-6][hl]/);
  }
});
