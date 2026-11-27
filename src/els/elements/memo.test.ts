// ELS-MEMO — the memo pad: store (edits, debounced atomic save, restart, write failure, flush on close), element keys,
// pin toggle through the registry (pin:'all'), send to vault (y/n, once per token, never without y). Temp folders only.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoStore, watchMemoClose } from '../memo-store.js';
import { createOverlayRegistry } from '../overlay-registry.js';
import { memoKey, memoProps, memoTitle, renderMemo } from './memo.js';

const dirs: string[] = [];
const temp = (): string => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'memo-'))); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const plain = (rows: readonly string[]): string[] => rows.map((row) => row.replace(/\u001b\[[0-9;]*m/g, ''));

function fakeTimers() {
  let seq = 0;
  const due = new Map<number, () => void>();
  return { setTimer: (cb: () => void) => { const id = ++seq; due.set(id, cb); return id; }, clearTimer: (id: unknown) => { due.delete(id as number); },
    fire: () => { const all = [...due.values()]; due.clear(); for (const cb of all) cb(); }, pending: () => due.size };
}

describe('memo store', () => {
  test('edits in order; one debounced atomic write; restart reads it back', () => {
    const dir = temp();
    const file = join(dir, 'memos', 'popup.md');
    const t = fakeTimers();
    const store = createMemoStore({ file, setTimer: t.setTimer, clearTimer: t.clearTimer });
    for (const ch of ['회', '의', ' ', 'a']) store.edit({ kind: 'type', text: ch });
    store.edit({ kind: 'newline' }); store.edit({ kind: 'type', text: 'line2x' }); store.edit({ kind: 'back' });
    expect(store.text()).toBe('회의 a\nline2');
    expect(t.pending()).toBe(1);
    expect(existsSync(file)).toBe(false);
    t.fire();
    expect(readFileSync(file, 'utf8')).toBe('회의 a\nline2');
    expect(readdirSync(join(dir, 'memos'))).toEqual(['popup.md']);
    store.edit({ kind: 'clear-line' });
    expect(store.text()).toBe('회의 a\n');
    store.flush();
    expect(readFileSync(file, 'utf8')).toBe('회의 a\n');
    expect(createMemoStore({ file }).text()).toBe('회의 a\n');
  });
  test('a write failure is one clean line; the text stays in memory', () => {
    const t = fakeTimers();
    const store = createMemoStore({ file: join(temp(), 'x.md'), setTimer: t.setTimer, clearTimer: t.clearTimer, write: () => { throw Object.assign(new Error('/secret'), { code: 'EACCES' }); } });
    store.edit({ kind: 'type', text: 'keep' });
    t.fire();
    expect(store.problem()).toBe('Memo not saved (EACCES)');
    expect(store.text()).toBe('keep');
  });
  test('closing the popup flushes a pending save', () => {
    const dir = temp();
    const file = join(dir, 'm.md');
    const t = fakeTimers();
    const store = createMemoStore({ file, setTimer: t.setTimer, clearTimer: t.clearTimer });
    const registry = createOverlayRegistry({ dir, context: () => ({ memo: store }) });
    watchMemoClose(registry, store);
    const id = (JSON.parse(registry.apply({ action: 'open', kind: 'memo', props: {} }).message) as { id: string }).id;
    registry.apply({ action: 'update', id, props: { text: '', edit: { kind: 'type', text: 'bye' } } });
    expect(existsSync(file)).toBe(false);
    registry.apply({ action: 'close', id });
    expect(readFileSync(file, 'utf8')).toBe('bye');
  });
});

describe('memo element', () => {
  test('keys → one edit each; control keys consumed', () => {
    expect(memoKey({ text: 'a' }, 'b')).toEqual({ text: 'ab', edit: { kind: 'type', text: 'b' } });
    expect(memoKey({ text: 'a' }, '\r')).toEqual({ text: 'a\n', edit: { kind: 'newline' } });
    expect(memoKey({ text: 'ab' }, '\u007f')).toEqual({ text: 'a', edit: { kind: 'back' } });
    expect(memoKey({ text: '' }, '\u007f')).toBe('consumed');
    expect(memoKey({ text: 'x\nyy' }, '\u0015')).toEqual({ text: 'x\n', edit: { kind: 'clear-line' } });
    expect(memoKey({ text: 'a' }, '\u0010')).toEqual({ text: 'a', togglePin: true });
    expect(memoKey({ text: 'a' }, '\u001b[A')).toBe('consumed');
    expect(memoKey({ text: '' }, '\u0005')).toBe('consumed');                       // nothing to send
    expect(memoKey({ text: 'a' }, '\u0005')).toEqual({ text: 'a', send: {}, holdEsc: true });
  });
  test('props never take rel/go without a server token; title = first line', () => {
    expect(memoProps({ text: 'x', send: { rel: '../../x', go: true } })).toEqual({ text: 'x', send: {} });
    expect(memoProps('nope')).toBeUndefined();
    expect(memoTitle('\n# Plan for Friday\nbody')).toBe('Plan for Friday');
    expect(memoTitle('   ')).toBe('Memo');
  });
  test('render: exact box, title shows the pin, the end of the text stays in view', () => {
    const rows = plain(renderMemo({ text: Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'), pinAll: true }, { w: 40, h: 8 }, true));
    expect(rows).toHaveLength(8);
    expect(rows.every((row) => Bun.stringWidth(row) === 40)).toBe(true);
    expect(rows[0]).toContain('📝 Memo · 📌 all spaces');
    expect(rows[6]).toContain('line 19');
    expect(rows[7]).toContain('^P pin');
  });
});

describe('memo through the registry: pin toggle and send to vault', () => {
  function world(vault?: string) {
    const dir = temp();
    const toasts: Array<[string, string]> = [];
    const store = createMemoStore({ file: join(dir, 'memos', 'popup.md') });
    const registry = createOverlayRegistry({ dir, context: () => ({ memo: store, vault, notify: (text, level) => { toasts.push([level, text]); } }) });
    const id = (JSON.parse(registry.apply({ action: 'open', kind: 'memo', props: {}, ws: 'w1' }).message) as { id: string }).id;
    const layer = () => registry.stack().layers.find((one) => one.id === id)!;
    const key = (bytes: string): void => { const next = memoKey(layer().props as never, bytes); if (next !== 'consumed') registry.apply({ action: 'update', id, props: next }); };
    return { registry, layer, key, toasts, store };
  }
  test('ctrl+p pins the layer above all spaces and back', () => {
    const w = world();
    expect(w.layer().pin).toBe('space');
    w.key('\u0010');
    expect(w.layer().pin).toBe('all');
    expect((w.layer().props as { pinAll: boolean }).pinAll).toBe(true);
    w.key('\u0010');
    expect(w.layer().pin).toBe('space');
  });
  test('ctrl+e → «Save to 00. Inbox/<title>.md? y/n» → n nothing · y once', () => {
    const vault = temp();
    const w = world(vault);
    for (const ch of Array.from('Groceries')) w.key(ch);
    w.key('\r'); for (const ch of Array.from('milk')) w.key(ch);
    w.key('\u0005');
    expect((w.layer().props as { send: { rel: string } }).send.rel).toBe('00. Inbox/Groceries.md');
    expect(plain(renderMemo(w.layer().props as never, { w: 60, h: 6 }, true)).at(-1)).toContain('Save to 00. Inbox/Groceries.md? y/n');
    w.key('n');
    expect(existsSync(join(vault, '00. Inbox'))).toBe(false);
    w.key('\u0005');
    const asked = (w.layer().props as { send: Record<string, unknown> }).send;
    w.key('y');
    expect(readFileSync(join(vault, '00. Inbox', 'Groceries.md'), 'utf8')).toBe('Groceries\nmilk\n');
    expect(w.toasts).toEqual([['success', 'Saved to 00. Inbox/Groceries.md']]);
    w.registry.apply({ action: 'update', id: w.layer().id, props: { text: '', send: { ...asked, go: true } } });   // replayed y
    expect(readdirSync(join(vault, '00. Inbox'))).toEqual(['Groceries.md']);
    expect(w.store.text()).toBe('Groceries\nmilk');                                  // the memo stays after sending
  });
  test('vault unset → an error toast, no row', () => {
    const w = world();
    w.key('x'); w.key('\u0005');
    expect(w.toasts).toEqual([['error', 'Not saved: Obsidian vault not set — elanous config set obsidian.vault <path>']]);
    expect((w.layer().props as { send?: unknown }).send).toBeUndefined();
  });
});
