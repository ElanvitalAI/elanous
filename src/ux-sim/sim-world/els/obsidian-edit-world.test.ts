// ELS-OBSIDIAN-EDIT sim — seeded scenarios over the sidechat world (REAL registry + attach apps, fake clock) with the REAL
// note editor in the element context and a fake vault COPY per seed: open a note → `e` → edit (Korean per syllable, a
// paste, arrows) → ctrl+s; an outside change before save → «Changed outside — reload? y/n»; Esc on a dirty buffer →
// «Discard changes? y/n»; long Korean lines; an 80x24 screen. Every frame is checked as written (rows · width in cells ·
// status line — sidechat-world frameViolations); on top, an editor frame shows the caret's line number in its status row
// and the editor box stays inside the screen, and nothing reaches the pane under the popup.
import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNoteEditor } from '../../../els/elements/note-editor.js';
import { createSidechatWorld, type SidechatViewer, type SidechatWorld } from './sidechat-world.js';

const SEEDS = [1, 2, 3, 4, 5] as const;
const ESC = '\u001b';
const SAVE = '\u0013';
const roots: string[] = [];
const worlds: SidechatWorld[] = [];
afterAll(() => { for (const one of worlds) one.dispose(); for (const dir of roots) rmSync(dir, { recursive: true, force: true }); });
const plain = (rows: readonly string[]): string[] => rows.map((row) => row.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, ''));
const text = (v: SidechatViewer): string => plain(v.last()).join('\n');

interface EditWorld { readonly w: SidechatWorld; readonly vault: string; readonly state: string }
function world(seed: number, long = false): EditWorld {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `edit-sim-${seed}-`)));
  roots.push(root);
  mkdirSync(join(root, 'fake-vault', 'Projects'), { recursive: true });
  writeFileSync(join(root, 'fake-vault', 'Projects', 'plan.md'), long ? `# 계획\n${'가나다라마바사 '.repeat(20)}\n끝\n` : '# Plan\nfirst line\nsecond line\n');
  cpSync(join(root, 'fake-vault'), join(root, 'vault-copy'), { recursive: true });
  const vault = join(root, 'vault-copy');
  const state = join(root, 'els');
  const noteEditor = createNoteEditor({ vault: () => vault, backupDir: () => join(state, 'obsidian-backup'), page: 8 });
  const w = createSidechatWorld(seed, () => ({ vault, noteEditor }));
  worlds.push(w);
  return { w, vault, state };
}
const note = (t: EditWorld): string => readFileSync(join(t.vault, 'Projects', 'plan.md'), 'utf8');
const sizes = [{ cols: 80, rows: 24 }, { cols: 120, rows: 30 }, { cols: 200, rows: 50 }, { cols: 64, rows: 18 }] as const;

/** Per-frame editor invariant: an editor box (┌ ✎ … ┐) has its bottom edge on screen above the status line. */
function editorViolations(v: SidechatViewer): string[] {
  const rows = plain(v.last());
  const top = rows.findIndex((row) => row.includes('✎ '));
  if (top < 0) return [];
  const bottom = rows.findIndex((row, at) => at > top && row.includes('└') && row.trimEnd().endsWith('┘'));
  return bottom < 0 ? ['the editor has no bottom edge in view'] : bottom >= rows.length - 1 ? ['the editor covers the status line'] : [];
}
async function openEditor(t: EditWorld, v: SidechatViewer): Promise<void> {
  t.w.registry.apply({ action: 'open', kind: 'obsidian', props: { dir: 'Projects', cursor: 0, scroll: 0, note: 'Projects/plan.md' } });
  await t.w.flush();
  v.press('e');
  await t.w.flush();
}

describe('E1 · e → edit (Korean syllables · paste · arrows) → ctrl+s writes the vault copy, backup kept, popup stays', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const t = world(seed);
    const v = await t.w.viewer(sizes[t.w.rand.int(0, sizes.length - 1)]!);
    await openEditor(t, v);
    expect(text(v)).toContain('✎ vault-copy · Projects/plan.md');
    expect(editorViolations(v)).toEqual([]);
    v.press('\u001b[B', '\u001b[F');                                         // line 2, end
    const add = [' 추가', ' more', ' 한글 줄'][t.w.rand.int(0, 2)]!;
    if (t.w.rand.int(0, 1)) v.press(`\u001b[200~${add}\u001b[201~`); else for (const ch of Array.from(add)) v.press(ch);
    v.press('\r'); for (const ch of Array.from('new line')) v.press(ch);
    await t.w.flush();
    expect(text(v)).toContain('●');                                          // dirty
    v.press(SAVE);
    await t.w.flush();
    expect(note(t)).toBe(`# Plan\nfirst line${add}\nnew line\nsecond line\n`);
    expect(readFileSync(join(t.state, 'obsidian-backup', 'Projects__plan.md'), 'utf8')).toBe('# Plan\nfirst line\nsecond line\n');
    expect(text(v)).toContain('Saved Projects/plan.md');
    expect(text(v)).not.toContain('●');
    expect(v.typed()).toEqual([]);
    expect(editorViolations(v)).toEqual([]);
    expect(v.violations).toEqual([]);
  });
});

describe('E2 · the file changes on disk before ctrl+s → «Changed outside — reload? y/n» (never clobbered)', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const t = world(seed);
    const v = await t.w.viewer(sizes[t.w.rand.int(0, sizes.length - 1)]!);
    await openEditor(t, v);
    for (const ch of Array.from('mine ')) v.press(ch);
    await t.w.flush();
    writeFileSync(join(t.vault, 'Projects', 'plan.md'), 'theirs\n');
    utimesSync(join(t.vault, 'Projects', 'plan.md'), new Date(), new Date(Date.now() + 5000));
    v.press(SAVE);
    await t.w.flush();
    expect(text(v)).toContain('Changed outside — reload? y/n');
    expect(note(t)).toBe('theirs\n');
    if (t.w.rand.int(0, 1)) {
      v.press('y'); await t.w.flush();
      expect(text(v)).toContain('theirs');
      expect(text(v)).toContain('Reloaded from disk');
    } else {
      v.press('n'); await t.w.flush();
      expect(text(v)).toContain('mine ');                                    // the edits are kept
    }
    expect(note(t)).toBe('theirs\n');
    expect(editorViolations(v)).toEqual([]);
    expect(v.violations).toEqual([]);
  });
});

describe('E3 · Esc on a dirty buffer → «Discard changes? y/n»: n keeps editing, y closes without writing; clean Esc closes', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const t = world(seed);
    const v = await t.w.viewer(sizes[t.w.rand.int(0, sizes.length - 1)]!);
    await openEditor(t, v);
    v.press(ESC); await t.w.flush();                                         // clean → back to the note view
    expect(text(v)).not.toContain('✎ ');
    expect(t.w.registry.stack().layers.some((one) => one.kind === 'obsidian')).toBe(true);
    v.press('e'); await t.w.flush();
    v.press('\u001b[B', 'x', 'y', 'z'); await t.w.flush();
    v.press(ESC); await t.w.flush();
    expect(text(v)).toContain('Discard changes? y/n');
    v.press('n'); await t.w.flush();
    expect(text(v)).toContain('xyz');
    v.press(ESC, 'y'); await t.w.flush();
    expect(text(v)).not.toContain('✎ ');
    expect(note(t)).toBe('# Plan\nfirst line\nsecond line\n');
    expect(readdirSync(join(t.vault, 'Projects'))).toEqual(['plan.md']);
    expect(v.violations).toEqual([]);
  });
});

describe('E4 · long Korean lines: the caret column stays in view (horizontal scroll), cells stay exact; 80x24 included', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const t = world(seed, true);
    const v = await t.w.viewer(seed === 1 ? { cols: 80, rows: 24 } : sizes[t.w.rand.int(0, sizes.length - 1)]!);
    await openEditor(t, v);
    v.press('\u001b[B', '\u001b[F');                                         // the long line, end
    await t.w.flush();
    for (const ch of Array.from('끝말')) v.press(ch);
    await t.w.flush();
    expect(text(v)).toContain('끝말');                                       // the caret end is drawn
    expect(text(v)).toMatch(/2:\d+/);
    const moves = t.w.rand.int(5, 40);
    for (let at = 0; at < moves; at++) v.press('\u001b[D');
    await t.w.flush();
    expect(editorViolations(v)).toEqual([]);
    v.press(SAVE); await t.w.flush();
    expect(note(t).split('\n')[1]!.endsWith('끝말')).toBe(true);
    expect(v.violations).toEqual([]);
  });
});
