// ELS-TAKEOUT sim — seeded scenarios over the sidechat world (REAL registry + hub + attach apps, fake clock): ctrl+e
// chooser → memo / Obsidian note (y/n) / new tab, Esc cancels the row without closing the popup, a doubled `y` on a lagged
// wire writes once, and the Obsidian popup's «new note» (n → title → y). Every frame is checked as it is written (row
// count, row width in cells, the status line never covered — sidechat-world frameViolations); on top, every frame that shows
// a chooser/confirm row must show it INSIDE the popup frame (│ … │ on the same row) and nothing may reach the pane.
// Vaults are small fake folders made per seed (never a real vault). Expected strings are literals.
import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OverlayRegistry } from '../../../els/overlay-registry.js';
import { createSidechatWorld, type SidechatViewer, type SidechatWorld } from './sidechat-world.js';

const SEEDS = [1, 2, 3, 4, 5, 6] as const;
const PREFIX = '\u0002';
const ESC = '\u001b';
const CTRL_E = '\u0005';
const roots: string[] = [];
const worlds: SidechatWorld[] = [];
afterAll(() => { for (const one of worlds) one.dispose(); for (const dir of roots) rmSync(dir, { recursive: true, force: true }); });
const plain = (rows: readonly string[]): string[] => rows.map((row) => row.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, ''));
const text = (v: SidechatViewer): string => plain(v.last()).join('\n');

/** A small fake vault, then a temp COPY of it — the copy is the one written to. */
function fakeVaultCopy(seed: number): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `takeout-sim-${seed}-`)));
  roots.push(root);
  const source = join(root, 'fake-vault');
  mkdirSync(join(source, 'Projects'), { recursive: true });
  writeFileSync(join(source, 'Projects', 'els.md'), '# els\n\nnotes\n');
  writeFileSync(join(source, 'Welcome.md'), '# Welcome\n');
  if (seed % 2 === 0) mkdirSync(join(source, '00. Inbox'));                  // half the seeds start without an Inbox
  const copy = join(root, 'vault-copy');
  cpSync(source, copy, { recursive: true });
  return copy;
}

interface TakeoutWorld { readonly w: SidechatWorld; readonly state: string; readonly vault: string; readonly tabs: Array<[string, string]> }
function world(seed: number): TakeoutWorld {
  const vault = fakeVaultCopy(seed);
  const state = join(vault, '..', 'els-state');
  mkdirSync(state, { recursive: true });
  const tabs: Array<[string, string]> = [];
  // notify = the server's: a toast opened after the current apply returns.
  const w = createSidechatWorld(seed, (registry: OverlayRegistry) => ({ stateDir: state, vault,
    notify: (line, level) => { queueMicrotask(() => { registry.apply({ action: 'open', kind: 'toast', props: { text: line, level } }); }); },
    openTab: (file, title) => { tabs.push([file, title]); return undefined; } }));
  worlds.push(w);
  return { w, state, vault, tabs };
}

/** Per-frame takeout invariant: a chooser/confirm row is drawn inside the popup frame, never on the status line. */
function rowViolations(v: SidechatViewer): string[] {
  const rows = plain(v.last());
  const out: string[] = [];
  rows.forEach((row, at) => {
    if (!/Take out:|Save to 00\. Inbox|Create 00\. Inbox|New note/.test(row)) return;
    if (at === rows.length - 1) out.push('a chooser row is on the status line');
    if (!/[│└╰]/.test(row)) out.push(`row ${at}: chooser row outside the popup frame`);
  });
  return out;
}

async function askAndAnswer(t: TakeoutWorld, v: SidechatViewer, q: string, a: string): Promise<void> {
  v.press(`${PREFIX}/`);
  await t.w.flush();
  for (const ch of Array.from(q)) v.press(ch);
  v.press('\r');
  await t.w.flush();
  let at = 0;
  while (at < a.length) { const n = t.w.rand.int(1, 9); await t.w.calls.at(-1)!.say(a.slice(at, at + n)); at += n; }
  await t.w.calls.at(-1)!.end();
  await t.w.flush();
}
const QUESTIONS = ['모나드가 뭐야?', 'What is a z-axis overlay?', '오늘 발행 몇 시?'] as const;
const size = (t: TakeoutWorld): { cols: number; rows: number } => [{ cols: 120, rows: 30 }, { cols: 80, rows: 24 }, { cols: 64, rows: 18 }, { cols: 200, rows: 60 }][t.w.rand.int(0, 3)]!;

describe('T1 · ctrl+e → m: the last answer becomes a memo under the els state folder, a toast says so', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const t = world(seed);
    const v = await t.w.viewer(size(t));
    const q = QUESTIONS[t.w.rand.int(0, QUESTIONS.length - 1)]!;
    await askAndAnswer(t, v, q, '짧은 **답**입니다.\n\n- 하나\n- 둘');
    v.press(CTRL_E);
    await t.w.flush();
    expect(text(v)).toMatch(/Take out: (\[m\]|m) memo/);
    expect(rowViolations(v)).toEqual([]);
    v.press('m');
    await t.w.flush();
    const memos = readdirSync(join(t.state, 'memos'));
    expect(memos).toHaveLength(1);
    expect(readFileSync(join(t.state, 'memos', memos[0]!), 'utf8')).toBe(`# ${q}\n\n짧은 **답**입니다.\n\n- 하나\n- 둘\n`);
    expect(text(v)).toContain('Memo saved: memos/');
    expect(text(v)).not.toContain('Take out:');
    expect(t.w.layer()).toBeDefined();                                        // the popup stays
    expect(v.typed()).toEqual([]);
    expect(v.violations).toEqual([]);
  });
});

describe('T2 · ctrl+e → o: confirm row, n writes nothing, y writes once into the vault copy\'s 00. Inbox', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const t = world(seed);
    const v = await t.w.viewer(size(t));
    await askAndAnswer(t, v, 'What is a z-axis overlay?', 'Layers above panes.');
    v.press(CTRL_E, 'o');
    await t.w.flush();
    expect(text(v)).toMatch(/Save to 00\. Inbox\/What[^\n]*\? y\/n/);
    if (v.size.cols >= 120) expect(text(v)).toContain('Save to 00. Inbox/What is a z-axis overlay.md? y/n');
    expect(rowViolations(v)).toEqual([]);
    const inboxBefore = existsSync(join(t.vault, '00. Inbox'));
    expect(inboxBefore).toBe(seed % 2 === 0);
    if (t.w.rand.int(0, 1) === 1) v.press('n'); else v.press(ESC);           // both cancel, neither closes the popup
    await t.w.flush();
    expect(t.w.layer()).toBeDefined();
    expect(existsSync(join(t.vault, '00. Inbox'))).toBe(inboxBefore);
    v.press(CTRL_E, 'o');
    await t.w.flush();
    v.press('y');
    await t.w.flush();
    expect(readFileSync(join(t.vault, '00. Inbox', 'What is a z-axis overlay.md'), 'utf8')).toBe('# What is a z-axis overlay?\n\nLayers above panes.\n');
    expect(readdirSync(join(t.vault, '00. Inbox'))).toEqual(['What is a z-axis overlay.md']);
    expect(text(v)).toContain('✓ Saved to 00. Inbox/');
    // The original notes are untouched.
    expect(readFileSync(join(t.vault, 'Projects', 'els.md'), 'utf8')).toBe('# els\n\nnotes\n');
    expect(v.violations).toEqual([]);
  });
});

describe('T3 · Esc on the chooser cancels the row only; the next Esc closes the popup', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const t = world(seed);
    const v = await t.w.viewer(size(t));
    await askAndAnswer(t, v, 'q', 'a');
    v.press(CTRL_E);
    await t.w.flush();
    v.press(ESC);
    await t.w.flush();
    expect(t.w.layer()).toBeDefined();
    expect(text(v)).not.toContain('Take out:');
    v.press(ESC);
    await t.w.flush();
    expect(t.w.layer()).toBeUndefined();
    expect(v.typed()).toEqual([]);
    expect(v.violations).toEqual([]);
  });
});

describe('T4 · a lagged wire: y pressed twice before the push lands writes exactly one note', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const t = world(seed);
    const v = await t.w.viewer({ ...size(t), lag: true });
    v.press(`${PREFIX}/`); await t.w.flush();
    for (const ch of Array.from('lag test')) v.press(ch);
    v.press('\r'); v.deliver(); await t.w.flush();
    await t.w.calls.at(-1)!.say('ok'); await t.w.calls.at(-1)!.end(); await t.w.flush();
    v.press(CTRL_E); v.deliver(); await t.w.flush();
    v.press('o'); v.deliver(); await t.w.flush();
    expect(text(v)).toContain('Save to 00. Inbox/lag test.md? y/n');
    v.press('y', 'y');                                                       // both on the wire before any push
    const extra = t.w.rand.int(0, 2);
    for (let at = 0; at < extra; at++) v.press('y');
    v.deliver(); await t.w.flush();
    expect(readdirSync(join(t.vault, '00. Inbox'))).toEqual(['lag test.md']);
    expect(v.violations).toEqual([]);
  });
});

describe('T5 · ctrl+e → t: the memo opens in a new tab (read-only viewer), nothing typed into the pane', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const t = world(seed);
    const v = await t.w.viewer(size(t));
    await askAndAnswer(t, v, '표로 정리해줘', '| a | b |\n|---|---|\n| 1 | 2 |');
    v.press(CTRL_E, 't');
    await t.w.flush();
    expect(t.tabs).toHaveLength(1);
    expect(t.tabs[0]![0].startsWith(join(t.state, 'memos'))).toBe(true);
    expect(t.tabs[0]![1]).toBe('▤ 표로 정리해줘');
    expect(text(v)).toContain('Opened in a new tab');
    expect(v.typed()).toEqual([]);
    expect(v.violations).toEqual([]);
  });
});

describe('T6 · Obsidian popup: n → title (Korean, per syllable) → Enter → y creates the note and opens it', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const t = world(seed);
    const v = await t.w.viewer(size(t));
    t.w.registry.apply({ action: 'open', kind: 'obsidian', props: {} });
    await t.w.flush();
    expect(text(v)).toContain('Welcome');
    v.press('n');
    await t.w.flush();
    const title = ['회의 메모', 'Daily plan', '아이디어 q'][t.w.rand.int(0, 2)]!;
    for (const ch of Array.from(title)) v.press(ch);                          // q is text here, not quit
    await t.w.flush();
    expect(text(v)).toMatch(/New note[^\n]*▏/);
    if (v.size.cols >= 120) expect(text(v)).toContain(`New note in 00. Inbox: ${title}▏`);
    expect(rowViolations(v)).toEqual([]);
    v.press('\r');
    await t.w.flush();
    expect(text(v)).toMatch(/Create 00\. Inbox\/[^\n]*\? y\/n/);
    if (v.size.cols >= 120) expect(text(v)).toContain(`Create 00. Inbox/${title}.md? y/n`);
    expect(rowViolations(v)).toEqual([]);
    v.press('y');
    await t.w.flush();
    expect(readFileSync(join(t.vault, '00. Inbox', `${title}.md`), 'utf8')).toBe(`# ${title}\n`);
    expect(text(v)).toContain(`# ${title}`.replace('# ', ''));                // the viewer shows the new note
    // A second note with the same title gets -2 (never overwrites).
    v.press('\u007f'); await t.w.flush();                                      // back to the list
    v.press('n'); for (const ch of Array.from(title)) v.press(ch); v.press('\r'); await t.w.flush();
    expect(text(v)).toMatch(/Create 00\. Inbox\/[^\n]*-2\.md\? y\/n/);
    v.press(ESC); await t.w.flush();
    expect(t.w.registry.stack().layers.some((one) => one.kind === 'obsidian')).toBe(true);   // Esc cancelled the row only
    expect(readdirSync(join(t.vault, '00. Inbox'))).toEqual([`${title}.md`]);
    expect(v.typed()).toEqual([]);
    expect(v.violations).toEqual([]);
  });
});
