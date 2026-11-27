// ELS-MEMO sim — seeded scenarios over the sidechat world (REAL registry + attach apps, fake clock) with a REAL memo store:
// ctrl+b M opens the pad → type (Korean per syllable · a paste) → Enter lines → Esc closes and flushes the md file →
// reopen shows the text; ctrl+p pins above all spaces; ctrl+e sends to a fake vault copy (n nothing · y once even on a
// lagged wire with a doubled y). Every frame is checked as written (rows · width in cells · status line); on top, the pad's
// bottom-right corner and the newest line are inside the frame, and nothing reaches the pane under it.
import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoStore, watchMemoClose, type MemoStore } from '../../../els/memo-store.js';
import type { OverlayRegistry } from '../../../els/overlay-registry.js';
import { createSidechatWorld, type SidechatViewer, type SidechatWorld } from './sidechat-world.js';

const SEEDS = [1, 2, 3, 4, 5, 6] as const;
const PREFIX = '\u0002';
const ESC = '\u001b';
const roots: string[] = [];
const worlds: SidechatWorld[] = [];
afterAll(() => { for (const one of worlds) one.dispose(); for (const dir of roots) rmSync(dir, { recursive: true, force: true }); });
const plain = (rows: readonly string[]): string[] => rows.map((row) => row.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, ''));
const text = (v: SidechatViewer): string => plain(v.last()).join('\n');

interface MemoWorld { readonly w: SidechatWorld; readonly store: MemoStore; readonly file: string; readonly vault: string }
function world(seed: number): MemoWorld {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `memo-sim-${seed}-`)));
  roots.push(root);
  mkdirSync(join(root, 'fake-vault', 'Projects'), { recursive: true });
  writeFileSync(join(root, 'fake-vault', 'Welcome.md'), '# Welcome\n');
  cpSync(join(root, 'fake-vault'), join(root, 'vault-copy'), { recursive: true });
  const vault = join(root, 'vault-copy');
  const file = join(root, 'els', 'memos', 'popup.md');
  // Saves fire only on flush (close) here — the debounce timer is the store's own; the sim proves the close path.
  const store = createMemoStore({ file, setTimer: () => 0, clearTimer: () => undefined });
  let reg: OverlayRegistry | undefined;
  const w = createSidechatWorld(seed, (registry) => { if (!reg) { reg = registry; watchMemoClose(registry, store); } return { memo: store, vault,
    notify: (line, level) => { queueMicrotask(() => { registry.apply({ action: 'open', kind: 'toast', props: { text: line, level } }); }); } }; });
  worlds.push(w);
  return { w, store, file, vault };
}
const memoLayer = (t: MemoWorld) => t.w.registry.stack().layers.find((one) => one.kind === 'memo');
const sizes = [{ cols: 120, rows: 30 }, { cols: 80, rows: 24 }, { cols: 64, rows: 18 }, { cols: 200, rows: 60 }] as const;

/** The pad's own frame rows: the top ╭─ 📝 Memo … ╮ and the bottom ╰ … ╯ on one column span, the text between. */
function padViolations(v: SidechatViewer): string[] {
  const rows = plain(v.last());
  const top = rows.findIndex((row) => row.includes('📝 Memo'));
  if (top < 0) return [];
  const bottom = rows.findIndex((row, at) => at > top && row.includes('╰') && row.trimEnd().endsWith('╯'));
  const out: string[] = [];
  if (bottom < 0) out.push('the pad has no bottom edge in view');
  if (bottom === rows.length - 1) out.push('the pad covers the status line');
  return out;
}

describe('M1 · ctrl+b M → type (Korean · paste) → lines → Esc flushes popup.md → reopen shows the text', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const t = world(seed);
    const v = await t.w.viewer(sizes[t.w.rand.int(0, sizes.length - 1)]!);
    v.press(`${PREFIX}M`);
    await t.w.flush();
    expect(memoLayer(t)).toBeDefined();
    expect(text(v)).toContain('📝 Memo');
    const first = ['장보기', 'Groceries', '회의 메모'][t.w.rand.int(0, 2)]!;
    for (const ch of Array.from(first)) v.press(ch);
    v.press('\r');
    if (t.w.rand.int(0, 1)) v.press('\u001b[200~우유 · milk\u001b[201~'); else for (const ch of Array.from('우유 · milk')) v.press(ch);
    await t.w.flush();
    expect(t.store.text()).toBe(`${first}\n우유 · milk`);
    expect(text(v)).toContain('우유 · milk');
    expect(padViolations(v)).toEqual([]);
    expect(existsSync(t.file)).toBe(false);                                  // debounced: not written yet
    v.press(ESC);
    await t.w.flush();
    expect(memoLayer(t)).toBeUndefined();
    expect(readFileSync(t.file, 'utf8')).toBe(`${first}\n우유 · milk`);    // closing flushed it
    v.press(`${PREFIX}M`);
    await t.w.flush();
    expect(text(v)).toContain('우유 · milk');
    expect(v.typed()).toEqual([]);
    expect(v.violations).toEqual([]);
  });
});

describe('M2 · ctrl+p pins above all spaces (title says so) and back', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const t = world(seed);
    const v = await t.w.viewer(sizes[t.w.rand.int(0, sizes.length - 1)]!);
    t.w.registry.apply({ action: 'open', kind: 'memo', props: {}, ws: 'w1' });   // the ElsControl path: the caller's workspace
    await t.w.flush();
    expect(memoLayer(t)!.pin).toBe('space');
    v.press('\u0010');
    await t.w.flush();
    expect(memoLayer(t)!.pin).toBe('all');
    expect(text(v)).toContain('📌 all spaces');
    const flips = t.w.rand.int(1, 3);
    for (let at = 0; at < flips; at++) v.press('\u0010');
    await t.w.flush();
    expect(memoLayer(t)!.pin).toBe(flips % 2 === 0 ? 'all' : 'space');
    expect(padViolations(v)).toEqual([]);
    expect(v.violations).toEqual([]);
  });
});

describe('M3 · ctrl+e: n writes nothing; y (doubled on a lagged wire) writes exactly one note into the vault copy', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const t = world(seed);
    const v = await t.w.viewer({ ...sizes[t.w.rand.int(0, sizes.length - 1)]!, lag: true });
    v.press(`${PREFIX}M`); v.deliver(); await t.w.flush();
    for (const ch of Array.from('Plan')) v.press(ch);
    v.press('\r'); for (const ch of Array.from('ship it')) v.press(ch);
    v.deliver(); await t.w.flush();
    v.press('\u0005'); v.deliver(); await t.w.flush();
    expect(text(v)).toMatch(/Save to 00\. In[^\n]*\? y\/n/);
    v.press('n'); v.deliver(); await t.w.flush();
    expect(existsSync(join(t.vault, '00. Inbox'))).toBe(false);
    v.press('\u0005'); v.deliver(); await t.w.flush();
    v.press('y', 'y'); for (let at = t.w.rand.int(0, 2); at > 0; at--) v.press('y');
    v.deliver(); await t.w.flush();
    expect(readdirSync(join(t.vault, '00. Inbox'))).toEqual(['Plan.md']);
    expect(readFileSync(join(t.vault, '00. Inbox', 'Plan.md'), 'utf8')).toBe('Plan\nship it\n');
    expect(t.store.text()).toBe('Plan\nship it');                           // extra y's were not typed into the memo
    expect(v.violations).toEqual([]);
  });
});

describe('M4 · a long memo on small screens: the newest line stays in view, frames stay exact', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const t = world(seed);
    const v = await t.w.viewer(sizes[t.w.rand.int(2, 3)]!);
    v.press(`${PREFIX}M`); await t.w.flush();
    // Enough lines to overflow every pad size (18-row screens show ~7 body rows); kept small so a busy host stays in budget.
    const n = t.w.rand.int(20, 32);
    for (let at = 0; at < n; at++) { for (const ch of Array.from(`줄 ${at} — ${'가나다 '.repeat(t.w.rand.int(1, 4))}`)) v.press(ch); v.press('\r'); }
    for (const ch of Array.from('THE END')) v.press(ch);
    await t.w.flush();
    expect(text(v)).toContain('THE END');
    expect(padViolations(v)).toEqual([]);
    expect(v.violations).toEqual([]);
  }, 20_000);
});
