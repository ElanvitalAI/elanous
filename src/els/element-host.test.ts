// ELS-ELEMENT-HOST: one element = one server layer; popup · tile · tab are hosts of the same state. Expected boxes are
// literals for a 120×29 overlay view (a 120×30 terminal minus the status line), never computed with the product's code.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOverlayRegistry } from './overlay-registry.js';
import { parseStack, resolveRect, visibleLayers, type OverlayLayer } from './overlay-stack.js';
import { nextFrame, openFrame, tileRects } from './element-frames.js';
import { createElementHost, createTabHostSync, hostPaneMayAct, runsHost, type HostAct } from './element-host.js';
import { obsidian } from './elements/obsidian.js';
import { toast } from './elements/toast.js';

let root = '';
let vault = '';
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'els-host-'));
  vault = join(root, 'Vault');
  mkdirSync(vault, { recursive: true });
  for (const name of ['alpha', 'beta', 'gamma']) writeFileSync(join(vault, `${name}.md`), `# ${name}\n\nbody of ${name}\n`);
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

const VIEW = { cols: 120, rows: 29 };
const plain = (text: string): string => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
const fresh = (name: string, hosts: { entered: string[]; left: string[] } = { entered: [], left: [] }) => {
  const dir = join(root, name);
  const registry = createOverlayRegistry({ dir, context: () => ({ vault }), setTimer: () => 0, clearTimer: () => {},
    onTabHosts: ({ entered, left }) => { hosts.entered.push(...entered.map((l) => l.kind)); hosts.left.push(...left.map((l) => l.kind)); } });
  return { registry, dir, hosts };
};
const layerOf = (stack: { layers: readonly OverlayLayer[] }, kind: string): OverlayLayer => stack.layers.find((one) => one.kind === kind)!;

test('tile grid: 1 = right column · 2 = stacked · 4 = 2×2 in the right 60% — no shared cell, no gap', () => {
  expect(tileRects(1).map((rect) => resolveRect(rect, VIEW))).toEqual([{ x: 72, y: 0, w: 48, h: 29 }]);
  expect(tileRects(2).map((rect) => resolveRect(rect, VIEW))).toEqual([{ x: 72, y: 0, w: 48, h: 15 }, { x: 72, y: 15, w: 48, h: 14 }]);
  expect(tileRects(4).map((rect) => resolveRect(rect, VIEW))).toEqual([
    { x: 48, y: 0, w: 36, h: 15 }, { x: 84, y: 0, w: 36, h: 15 }, { x: 48, y: 15, w: 36, h: 14 }, { x: 84, y: 15, w: 36, h: 14 }]);
  // an odd view: 3 rows of 31 still tile exactly (10 · 11 · 10)
  expect(tileRects(6).map((rect) => resolveRect(rect, { cols: 101, rows: 31 })).filter((box) => box.x === 40).map((box) => [box.y, box.h])).toEqual([[0, 10], [10, 11], [21, 10]]);
});

test('frame rules: the cycle skips unsupported frames; open = explicit · size rule · popup', () => {
  expect([nextFrame('popup', ['popup', 'tile', 'tab']), nextFrame('tile', ['popup', 'tile', 'tab']), nextFrame('tab', ['popup', 'tile', 'tab'])]).toEqual(['tile', 'tab', 'popup']);
  expect(nextFrame('popup', ['popup', 'tab'])).toBe('tab');
  expect(nextFrame('popup', ['popup'])).toBe('popup');
  expect(openFrame(obsidian, 'tile', undefined)).toBe('tile');
  expect(openFrame(obsidian, 'dock', undefined)).toBe('frame must be popup|tile|tab');
  expect(openFrame(toast, 'tab', undefined)).toBe('toast opens as popup only');
  expect([openFrame(obsidian, undefined, { cols: 200, rows: 50 }), openFrame(obsidian, undefined, { cols: 100, rows: 30 }), openFrame(obsidian, undefined, { cols: 50, rows: 30 })]).toEqual(['tile', 'popup', 'tab']);
  expect(openFrame(obsidian, undefined, undefined)).toBe('popup');
  expect(openFrame(obsidian, undefined, { cols: -1, rows: 3 })).toBe('popup');
});

test('registry: open by the size rule, switch frames live — the props (cursor) survive every switch; tab hides the layer', () => {
  const { registry, hosts } = fresh('switch');
  const opened = JSON.parse(registry.apply({ action: 'open', kind: 'obsidian', props: {}, view: { cols: 200, rows: 50 } }).message) as { id: string; frame: string };
  expect(opened.frame).toBe('tile');
  expect(resolveRect(layerOf(registry.stack(), 'obsidian').rect, VIEW)).toEqual({ x: 72, y: 0, w: 48, h: 29 });
  expect(registry.apply({ action: 'update', id: opened.id, props: { dir: '', cursor: 2, scroll: 0 } }).exitCode).toBe(0);
  expect(JSON.parse(registry.apply({ action: 'frame', id: opened.id, frame: 'next' }).message)).toMatchObject({ frame: 'tab' });
  expect(layerOf(registry.stack(), 'obsidian').frame).toBe('tab');
  expect(visibleLayers(registry.stack(), undefined)).toHaveLength(0);
  expect(hosts.entered).toEqual(['obsidian']);
  expect((layerOf(registry.stack(), 'obsidian').props as { cursor: number }).cursor).toBe(2);
  registry.apply({ action: 'frame', kind: 'obsidian', frame: 'popup' });
  const back = layerOf(registry.stack(), 'obsidian');
  expect(back.frame).toBeUndefined();
  expect(resolveRect(back.rect, VIEW)).toEqual({ x: 12, y: 3, w: 96, h: 23 });
  expect((back.props as { cursor: number }).cursor).toBe(2);
  expect(hosts.left).toEqual(['obsidian']);
  expect(registry.apply({ action: 'frame', kind: 'obsidian', frame: 'dock' }).exitCode).toBe(2);
  expect(registry.apply({ action: 'open', kind: 'toast', props: { text: 'x' }, frame: 'tile' }).exitCode).toBe(2);
});

test('tiles re-layout on open and close; a tab layer that closes takes its host with it', () => {
  const { registry, hosts } = fresh('relayout');
  registry.apply({ action: 'open', kind: 'obsidian', props: {}, frame: 'tile' });
  registry.apply({ action: 'open', kind: 'sidechat', props: {}, frame: 'tile' });
  expect(registry.stack().layers.map((l) => [l.kind, resolveRect(l.rect, VIEW).y])).toEqual([['obsidian', 0], ['sidechat', 15]]);
  registry.apply({ action: 'close', kind: 'obsidian' });
  expect(resolveRect(layerOf(registry.stack(), 'sidechat').rect, VIEW)).toEqual({ x: 72, y: 0, w: 48, h: 29 });
  registry.apply({ action: 'frame', kind: 'sidechat', frame: 'tab' });
  registry.apply({ action: 'close', kind: 'sidechat' });
  expect(hosts).toEqual({ entered: ['sidechat'], left: ['sidechat'] });
});

test('workbench: registered kinds open as tiles, unregistered ones are named, not faked', () => {
  const { registry } = fresh('bench');
  const first = JSON.parse(registry.apply({ action: 'open', kind: 'obsidian', props: {} }).message) as { id: string };
  registry.apply({ action: 'update', id: first.id, props: { dir: '', cursor: 2, scroll: 0 } });
  const answer = JSON.parse(registry.apply({ action: 'workbench' }).message) as { opened: string[]; skipped: string[]; note: string };
  expect(answer.opened).toEqual(['obsidian', 'files', 'term', 'sidechat']);
  expect(answer.skipped).toEqual([]);
  expect(answer.note).toBe('');
  expect(registry.stack().layers.map((l) => l.frame)).toEqual(['tile', 'tile', 'tile', 'tile']);
  expect((layerOf(registry.stack(), 'obsidian').props as { cursor: number }).cursor).toBe(2);   // an open element keeps its state
});

test('the frame survives a server restart (overlays.json)', () => {
  const { registry, dir } = fresh('restart');
  registry.apply({ action: 'open', kind: 'obsidian', props: {}, frame: 'tab' });
  registry.dispose();
  const file = parseStack(JSON.parse(readFileSync(join(dir, 'overlays.json'), 'utf8')));
  expect(file?.layers.map((l) => l.frame)).toEqual(['tab']);
  const again = createOverlayRegistry({ dir, context: () => ({ vault }) });
  expect(again.stack().layers.map((l) => l.frame)).toEqual(['tab']);
});

test('tab host sync: one pane per tab layer (by command — restart-proof), closed when the layer leaves the tab frame', () => {
  const panes: { id: string; command: string[]; state: string }[] = [];
  const closed: string[] = [];
  const sync = createTabHostSync({ panes: () => panes, cwd: '/home', newPane: (input) => { panes.push({ id: `p${panes.length + 1}`, command: input.command, state: 'idle' }); return { exitCode: 0, message: '' }; },
    close: (pane) => { closed.push(pane); }, command: (kind, key) => ['/bin/bun', '/repo/bin/elanous.mjs', 'side', 'element', 'host', kind, key] });
  const layer = { id: 'ov1', kind: 'obsidian', key: 'default', band: 'float', seq: 1, rect: { anchor: 'center', w: '80%', h: '80%' }, focus: 'owns', frame: 'tab' } as OverlayLayer;
  sync({ entered: [layer], left: [] });
  sync({ entered: [layer], left: [] });
  expect(panes.map((p) => p.command.slice(2))).toEqual([['side', 'element', 'host', 'obsidian', 'default']]);
  sync({ entered: [], left: [layer] });
  expect(closed).toEqual(['p1']);
  expect(runsHost(['x', 'side', 'element', 'host', 'obsidian', 'default'], 'obsidian', 'other')).toBe(false);
});

test('the host pane draws its layer full-pane and sends the same acts as a popup: update · ctrl+t frame · Esc close', () => {
  const { registry } = fresh('host');
  registry.apply({ action: 'open', kind: 'obsidian', props: {}, frame: 'tab' });
  const writes: string[] = [];
  const acts: HostAct[] = [];
  const host = createElementHost({ kind: 'obsidian', key: 'default', write: (text) => { writes.push(text); }, size: () => ({ cols: 60, rows: 12 }), act: (act) => { acts.push(act); } });
  expect(host.stack(registry.stack())).toBe(false);
  const screen = plain(writes.at(-1)!).split('\r\n');
  expect(screen).toHaveLength(12);
  expect(screen[0]).toContain('📓 Vault · /');
  expect(screen[1]).toContain('alpha');
  host.key('j');
  expect(acts.at(-1)).toEqual({ action: 'update', id: layerOf(registry.stack(), 'obsidian').id, props: { dir: '', cursor: 1, scroll: 0 } });
  host.key('\u0014');
  expect(acts.at(-1)).toMatchObject({ action: 'frame', frame: 'next' });
  host.key('\u001b');
  expect(acts.at(-1)).toMatchObject({ action: 'close' });
  registry.apply({ action: 'frame', kind: 'obsidian', frame: 'popup' });
  expect(host.stack(registry.stack())).toBe(true);
});

test('no mouse-mode escapes in the element host and frame code (#40224 dead-click incident)', () => {
  for (const file of ['element-host.ts', 'element-frames.ts']) {
    const text = readFileSync(join(import.meta.dir, file), 'utf8');
    expect(text).not.toMatch(/\?100[0-6]/);
  }
  const writes: string[] = [];
  const { registry } = fresh('nomouse');
  registry.apply({ action: 'open', kind: 'obsidian', props: {}, frame: 'tab' });
  const host = createElementHost({ kind: 'obsidian', key: 'default', write: (text) => { writes.push(text); }, size: () => ({ cols: 40, rows: 8 }), act: () => {} });
  host.stack(registry.stack());
  host.key('jjk');
  expect(writes.join('')).not.toMatch(/\u001b\[\?100[0-6][hl]/);
});

test('door: only the host pane of a tab layer may act on it, only update · close · frame, only while it is a tab', () => {
  const { registry } = fresh('door');
  const id = (JSON.parse(registry.apply({ action: 'open', kind: 'obsidian', props: {}, frame: 'tab' }).message) as { id: string }).id;
  const panes = [{ id: 'p1', command: ['bun', 'x.mjs', 'side', 'element', 'host', 'obsidian', 'default'] }, { id: 'p2', command: ['zsh'] }];
  expect(hostPaneMayAct(panes, 'p1', registry.stack(), { action: 'update', id })).toBe(true);
  expect(hostPaneMayAct(panes, 'p1', registry.stack(), { action: 'frame', id })).toBe(true);
  expect(hostPaneMayAct(panes, 'p2', registry.stack(), { action: 'update', id })).toBe(false);
  expect(hostPaneMayAct(panes, 'p1', registry.stack(), { action: 'open', id })).toBe(false);
  expect(hostPaneMayAct(panes, 'p1', registry.stack(), { action: 'update' })).toBe(false);
  registry.apply({ action: 'frame', id, frame: 'popup' });
  expect(hostPaneMayAct(panes, 'p1', registry.stack(), { action: 'update', id })).toBe(false);
});

test('popup style: the tab host draws its element dressed like the popup (fancy ≠ simple), full-pane width kept', () => {
  const { registry } = fresh('style');
  registry.apply({ action: 'open', kind: 'obsidian', props: {}, frame: 'tab' });
  const draw = (style: 'simple' | 'fancy'): string[] => {
    const writes: string[] = [];
    const host = createElementHost({ kind: 'obsidian', key: 'default', style: () => style, write: (text) => { writes.push(text); }, size: () => ({ cols: 60, rows: 12 }), act: () => {} });
    host.stack(registry.stack());
    return writes.at(-1)!.replace(/^\u001b\[H/, '').split('\r\n');
  };
  const simple = draw('simple');
  const fancy = draw('fancy');
  expect(fancy).not.toEqual(simple);
  for (const rows of [simple, fancy]) {
    expect(rows).toHaveLength(12);
    for (const row of rows) expect(Bun.stringWidth(row)).toBe(60);
  }
  expect(plain(simple.join('\n'))).toContain('📓 Vault · /');
});
