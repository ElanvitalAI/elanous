// ELS-ZAXIS S3/S4: the server's overlay registry — validation, placement, persistence, expiry by one timer, hydrate.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorizeRequest, isMutating } from './server-auth.js';
import { createOverlayRegistry } from './overlay-registry.js';
import { chooseFrame } from './elements/element.js';
import { elementKeys, elementRenderers } from './elements/index.js';
import { toast } from './elements/toast.js';

let root = '';
let vault = '';
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'els-ovreg-'));
  vault = join(root, 'Vault');
  mkdirSync(join(vault, '프로젝트'), { recursive: true });
  writeFileSync(join(vault, '안녕.md'), '# 안녕\n\n본문 줄\n');
  writeFileSync(join(vault, '프로젝트', 'Plan.md'), '# Plan\n');
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

const plain = (text: string): string => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
const fresh = (name: string, extra: Partial<Parameters<typeof createOverlayRegistry>[0]> = {}) => {
  const dir = join(root, name);
  let clock = 1_000;
  const timers: { at: number; fn: () => void; handle: number }[] = [];
  let next = 0;
  const registry = createOverlayRegistry({ dir, now: () => clock, context: () => ({ vault }),
    setTimer: (fn, ms) => { const handle = ++next; timers.push({ at: clock + ms, fn, handle }); return handle; },
    clearTimer: (handle) => { const at = timers.findIndex((t) => t.handle === handle); if (at >= 0) timers.splice(at, 1); }, ...extra });
  const advance = (ms: number) => { clock += ms; for (const t of [...timers].filter((one) => one.at <= clock)) { timers.splice(timers.indexOf(t), 1); t.fn(); } };
  return { registry, dir, advance, timers, setClock: (v: number) => { clock = v; } };
};
const json = (message: string) => JSON.parse(message) as Record<string, unknown>;

test('open toast: validated, top-right, band toast, focus none, expires by ONE timer (no poll)', () => {
  const { registry, advance, timers } = fresh('toast');
  const opened = registry.apply({ action: 'open', kind: 'toast', props: { text: 'saved', level: 'success' } });
  expect(opened.exitCode).toBe(0);
  const layer = registry.stack().layers[0]!;
  expect([layer.band, layer.focus, layer.rect.anchor, layer.expiresAt]).toEqual(['toast', 'none', 'tr', 6_000]);
  expect(timers).toHaveLength(1);
  advance(4_999);
  expect(registry.stack().layers).toHaveLength(1);
  advance(1);
  expect(registry.stack().layers).toHaveLength(0);
  expect(timers).toHaveLength(0);
});

test('toasts stack downward and each open without a key is a new toast', () => {
  const { registry } = fresh('stack');
  registry.apply({ action: 'open', kind: 'toast', props: { text: 'one' } });
  registry.apply({ action: 'open', kind: 'toast', props: { text: 'two' } });
  expect(registry.stack().layers.map((l) => l.rect.dy)).toEqual([1, 4]);
});

test('refusals: unknown kind, bad props, bad key, bad ttl, bad pin, unknown action, missing layer', () => {
  const { registry } = fresh('refuse');
  expect(registry.apply({ action: 'open', kind: 'nope' }).exitCode).toBe(2);
  expect(registry.apply({ action: 'open', kind: 'toast', props: { text: '' } }).exitCode).toBe(2);
  expect(registry.apply({ action: 'open', kind: 'toast', props: { text: 'x'.repeat(500) } }).exitCode).toBe(2);
  expect(registry.apply({ action: 'open', kind: 'toast', key: '../x', props: { text: 'a' } }).exitCode).toBe(2);
  expect(registry.apply({ action: 'open', kind: 'toast', ttlMs: 0, props: { text: 'a' } }).exitCode).toBe(2);
  expect(registry.apply({ action: 'open', kind: 'obsidian', pin: 'forever' as 'all' }).exitCode).toBe(2);
  expect(registry.apply({ action: 'explode' as 'list' }).exitCode).toBe(2);
  expect(registry.apply({ action: 'close', id: 'ov99' }).exitCode).toBe(1);
  expect(registry.stack().layers).toHaveLength(0);
});

test('obsidian opens hydrated from the configured vault (Korean names), navigates by update, closes', () => {
  const { registry } = fresh('obs');
  const opened = json(registry.apply({ action: 'open', kind: 'obsidian', ws: 'w1' }).message);
  const layer = () => registry.stack().layers.find((l) => l.id === opened.id)!;
  expect([layer().band, layer().focus, layer().ownerWorkspace]).toEqual(['float', 'owns', 'w1']);
  const props = () => layer().props as { entries: { name: string }[]; note?: string; text?: string; cursor: number; dir: string };
  expect(props().entries.map((e) => e.name)).toEqual(['프로젝트', '안녕.md']);
  const key = elementKeys().obsidian!;
  const step = (bytes: string) => { const answer = key(layer(), bytes); if (typeof answer === 'object' && 'update' in answer) expect(registry.apply({ action: 'update', id: String(opened.id), props: answer.update }).exitCode).toBe(0); };
  step('j'); step('\r');
  expect(props().note).toBe('안녕.md');
  expect(props().text).toContain('본문 줄');
  const rows = elementRenderers().obsidian!(layer(), { w: 40, h: 8 }, true).map(plain);
  expect(rows.some((row) => row.includes('본문 줄'))).toBe(true);
  step('\u007f');
  expect(props().note).toBeUndefined();
  expect(registry.apply({ action: 'close', kind: 'obsidian' }).exitCode).toBe(0);
  expect(registry.stack().layers).toHaveLength(0);
});

test('open twice = one layer raised (idempotent per kind+key); update props are re-validated (no injected data)', () => {
  const { registry } = fresh('idem');
  registry.apply({ action: 'open', kind: 'obsidian' });
  registry.apply({ action: 'open', kind: 'obsidian' });
  expect(registry.stack().layers).toHaveLength(1);
  const id = registry.stack().layers[0]!.id;
  expect(registry.apply({ action: 'update', id, props: { dir: '../../etc' } }).exitCode).toBe(2);
  registry.apply({ action: 'update', id, props: { dir: '', text: 'injected', entries: [] } });
  expect((registry.stack().layers[0]!.props as { entries: unknown[] }).entries).toHaveLength(2);
});

test('no vault configured: the popup still opens and says how to set obsidian.vault', () => {
  const { registry } = fresh('novault', { context: () => ({}) });
  registry.apply({ action: 'open', kind: 'obsidian' });
  const rows = elementRenderers().obsidian!(registry.stack().layers[0]!, { w: 70, h: 6 }, true).map(plain);
  expect(rows.join('\n')).toContain('obsidian.vault');
});

test('the stack is written on change and restored by a new registry (restart); expired toasts are dropped at restore', () => {
  const first = fresh('persist');
  first.registry.apply({ action: 'open', kind: 'obsidian', ws: 'w1' });
  first.registry.apply({ action: 'open', kind: 'toast', props: { text: 'bye' } });
  expect(existsSync(join(first.dir, 'overlays.json'))).toBe(true);
  expect(existsSync(join(first.dir, 'elements', 'obsidian', 'default.json'))).toBe(true);
  const second = createOverlayRegistry({ dir: first.dir, now: () => 999_999, context: () => ({ vault }) });
  expect(second.stack().layers.map((l) => l.kind)).toEqual(['obsidian']);
  second.dispose();
});

test('a toast state file is removed when the toast goes; a corrupt overlays.json restores as empty', () => {
  const { registry, dir, advance } = fresh('files');
  registry.apply({ action: 'open', kind: 'toast', key: 'k1', props: { text: 'x' } });
  expect(existsSync(join(dir, 'elements', 'toast', 'k1.json'))).toBe(true);
  advance(10_000);
  expect(existsSync(join(dir, 'elements', 'toast', 'k1.json'))).toBe(false);
  writeFileSync(join(dir, 'overlays.json'), '{not json');
  expect(createOverlayRegistry({ dir }).stack().layers).toHaveLength(0);
  expect(readFileSync(join(dir, 'overlays.json'), 'utf8')).toBe('{not json');
});

test('watchers get every change; workspace close cascades pin:space layers', () => {
  const { registry } = fresh('watch');
  const seen: number[] = [];
  const sub = registry.onChange((stack) => seen.push(stack.layers.length));
  registry.apply({ action: 'open', kind: 'obsidian', ws: 'w1' });
  registry.closeWorkspace('w1');
  sub.dispose();
  registry.apply({ action: 'open', kind: 'obsidian' });
  expect(seen).toEqual([1, 0]);
  expect(registry.workspaceOfLayer(registry.stack().layers[0]!.id)).toBeUndefined();
});

test('door: overlay list is a read; open/close are act-view — OP everywhere, a hand only in its own workspace', () => {
  expect(isMutating({ op: 'overlay', action: 'list' })).toBe(false);
  expect(isMutating({ op: 'overlay', action: 'open' })).toBe(true);
  expect(isMutating({ op: 'overlay-watch' })).toBe(false);
  const hand = { kind: 'hand' as const, seat: 'TC', workspaces: ['tc-space'], pane: 'p9' };
  expect(authorizeRequest({ kind: 'op', pane: 'p1' }, { op: 'overlay', action: 'open' }, 'tc-space', undefined).allow).toBe(true);
  expect(authorizeRequest(hand, { op: 'overlay', action: 'open' }, 'tc-space', undefined).allow).toBe(true);
  expect(authorizeRequest(hand, { op: 'overlay', action: 'open' }, 'op-space', undefined).allow).toBe(false);
  expect(authorizeRequest(hand, { op: 'overlay', action: 'close' }, undefined, undefined).allow).toBe(false);
  expect(authorizeRequest(hand, { op: 'overlay', action: 'list' }, undefined, undefined).allow).toBe(true);
  expect(authorizeRequest({ kind: 'owner', note: 'terminal' }, { op: 'overlay', action: 'open' }, undefined, undefined).allow).toBe(true);
});

test('size-adaptive frame stub: wide → tile, normal → popup, very narrow → tab; toast is always popup', () => {
  const any = { frames: ['popup', 'tile', 'tab'] as const };
  expect(chooseFrame(any, { cols: 200, rows: 80 })).toBe('tile');
  expect(chooseFrame(any, { cols: 80, rows: 24 })).toBe('popup');
  expect(chooseFrame(any, { cols: 50, rows: 24 })).toBe('tab');
  expect(chooseFrame(toast, { cols: 200, rows: 80 })).toBe('popup');
  expect(chooseFrame(toast, { cols: 40, rows: 20 })).toBe('popup');
});

test('toast render: framed, level mark, cut to its box', () => {
  const rows = toast.render({ text: '저장했습니다', level: 'success' }, { w: 20, h: 3 }, false).map(plain);
  expect(rows).toEqual(['╭──────────────────╮', '│ ✓ 저장했습니다   │', '╰──────────────────╯']);
  expect(toast.props({ text: 'a\u001b[31mb', level: 'odd' })).toEqual({ text: 'a [31mb', level: 'info' });
});

test('attach app: keys chain on the local copy — j, j (clamped at the last of two entries), k', async () => {
  const { registry } = fresh('chunk');
  registry.apply({ action: 'open', kind: 'obsidian' });
  const layer = registry.stack().layers[0]!;
  const key = elementKeys().obsidian!;
  let view = layer;
  const updates: unknown[] = [];
  for (const one of ['j', 'j', 'k']) {
    const answer = key(view, one);
    if (typeof answer === 'object' && 'update' in answer) { updates.push(answer.update); view = { ...view, props: { ...(view.props as object), ...(answer.update as object) } }; }
  }
  expect(updates.map((u) => (u as { cursor: number }).cursor)).toEqual([1, 1, 0]);   // two entries: the second j stays on the last row, k goes back
});

test('workspaceOfRequest: open → its ws; close by kind or id → the target layer owner (the door checks it)', () => {
  const { registry } = fresh('wsreq');
  registry.apply({ action: 'open', kind: 'obsidian', ws: 'w7' });
  const id = registry.stack().layers[0]!.id;
  expect(registry.workspaceOfRequest({ action: 'open', kind: 'toast', ws: 'w9' })).toBe('w9');
  expect(registry.workspaceOfRequest({ action: 'close', kind: 'obsidian' })).toBe('w7');
  expect(registry.workspaceOfRequest({ action: 'close', id })).toBe('w7');
  expect(registry.workspaceOfRequest({ action: 'close', kind: 'toast' })).toBeUndefined();
});
