// ELS-OBSIDIAN-EDIT — the note editor (buffer ops, discard, conflict, save) and vault-save edit-save (clamp, existing .md
// only, mtime+size check, one-step backup, atomic, write failure). Temp folders only; literal expectations.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openVaultEdit, saveVaultEdit } from '../vault-save.js';
import { createNoteEditor, editOpOf, editorKey, renderNoteEditor, type EditOp } from './note-editor.js';
import { hydrateObsidianWithEditor } from './obsidian-edit-hydrate.js';
import { createObsidianTab } from '../obsidian-tab.js';
import { obsidianKey, obsidianProps, renderObsidian } from './obsidian-view.js';

const dirs: string[] = [];
const temp = (): string => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'note-edit-'))); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const plain = (rows: readonly string[]): string[] => rows.map((row) => row.replace(/\u001b\[[0-9;]*m/g, ''));
function vault(): string {
  const v = temp();
  mkdirSync(join(v, 'Projects'));
  writeFileSync(join(v, 'Projects', 'plan.md'), '# Plan\nline two\n');
  return v;
}
const k = (key: string): EditOp => ({ kind: 'key', key } as EditOp);

describe('vault-save edit', () => {
  test('open + save: atomic, backup of the previous text, new stat returned', () => {
    const v = vault(); const state = temp();
    const opened = openVaultEdit(v, 'Projects/plan.md');
    if (!opened.ok) throw new Error(opened.message);
    expect(opened.text).toBe('# Plan\nline two\n');
    const saved = saveVaultEdit(v, 'Projects/plan.md', '# Plan\nedited\n', opened.stat, join(state, 'obsidian-backup'));
    expect(saved.ok).toBe(true);
    expect(readFileSync(join(v, 'Projects', 'plan.md'), 'utf8')).toBe('# Plan\nedited\n');
    expect(readFileSync(join(state, 'obsidian-backup', 'Projects__plan.md'), 'utf8')).toBe('# Plan\nline two\n');
    expect(readdirSync(join(v, 'Projects'))).toEqual(['plan.md']);                         // no temp left behind
  });
  test('changed on disk since open → refused, the file is not touched', () => {
    const v = vault();
    const opened = openVaultEdit(v, 'Projects/plan.md');
    if (!opened.ok) throw new Error(opened.message);
    writeFileSync(join(v, 'Projects', 'plan.md'), 'someone else\n');
    utimesSync(join(v, 'Projects', 'plan.md'), new Date(), new Date(Date.now() + 5000));
    expect(saveVaultEdit(v, 'Projects/plan.md', 'mine\n', opened.stat, undefined)).toEqual({ ok: false, reason: 'changed', message: 'Changed outside since you opened it' });
    expect(readFileSync(join(v, 'Projects', 'plan.md'), 'utf8')).toBe('someone else\n');
  });
  test('only existing .md inside the vault: missing, non-md, «..», symlink escape, vault unset, too large', () => {
    const v = vault(); const outside = temp();
    writeFileSync(join(outside, 'x.md'), 's'); symlinkSync(join(outside, 'x.md'), join(v, 'link.md'));
    writeFileSync(join(v, 'a.txt'), 't'); writeFileSync(join(v, 'big.md'), 'x'.repeat(65_537));
    expect(openVaultEdit(v, 'gone.md')).toEqual({ ok: false, reason: 'not-found', message: 'gone.md not found' });
    expect(openVaultEdit(v, 'a.txt')).toEqual({ ok: false, reason: 'not-found', message: 'a.txt is not a note' });
    expect(openVaultEdit(v, '../x.md')).toEqual({ ok: false, reason: 'outside', message: 'path outside the vault' });
    expect(openVaultEdit(v, 'link.md')).toEqual({ ok: false, reason: 'outside', message: 'note outside the vault — refused' });
    expect(openVaultEdit(undefined, 'a.md')).toMatchObject({ ok: false, reason: 'vault-unset' });
    expect(openVaultEdit(v, 'big.md')).toEqual({ ok: false, reason: 'too-large', message: 'This note is too large to edit here (64 KiB max)' });
  });
  test('write failure: clean line, original intact, temp removed', () => {
    const v = vault();
    const opened = openVaultEdit(v, 'Projects/plan.md');
    if (!opened.ok) throw new Error(opened.message);
    const failed = saveVaultEdit(v, 'Projects/plan.md', 'x', opened.stat, undefined, { write: () => { throw Object.assign(new Error('/secret'), { code: 'ENOSPC' }); } });
    expect(failed).toEqual({ ok: false, reason: 'write-failed', message: 'cannot write Projects/plan.md (ENOSPC)' });
    expect(readFileSync(join(v, 'Projects', 'plan.md'), 'utf8')).toBe('# Plan\nline two\n');
    expect(readdirSync(join(v, 'Projects'))).toEqual(['plan.md']);
  });
});

describe('editor store', () => {
  test('type (Korean), Enter, ⌫ across lines, Del, arrows, Home/End, save', () => {
    const v = vault(); const toasts: string[] = [];
    const ed = createNoteEditor({ vault: () => v, notify: (t) => { toasts.push(t); } });
    ed.apply({ kind: 'open', rel: 'Projects/plan.md' });
    ed.apply(k('end'));
    for (const ch of ['한', '글']) ed.apply({ kind: 'type', text: ch });
    expect(ed.view()!.lines[0]).toBe('# Plan한글');
    ed.apply(k('enter')); ed.apply({ kind: 'type', text: 'new' });
    expect(ed.view()!.lines.slice(0, 3)).toEqual(['# Plan한글', 'new', 'line two']);
    ed.apply(k('home')); ed.apply(k('back'));                                               // join with the line above
    expect(ed.view()!.lines.slice(0, 2)).toEqual(['# Plan한글new', 'line two']);
    ed.apply(k('end')); ed.apply(k('del'));                                                 // join the next line
    expect(ed.view()!.lines[0]).toBe('# Plan한글newline two');
    expect(ed.view()!.dirty).toBe(true);
    ed.apply({ kind: 'save' });
    expect(readFileSync(join(v, 'Projects', 'plan.md'), 'utf8')).toBe('# Plan한글newline two\n');
    expect(ed.view()).toMatchObject({ dirty: false, notice: 'Saved Projects/plan.md' });
    expect(toasts).toEqual(['Saved Projects/plan.md']);
  });
  test('Esc: clean closes; dirty asks «discard» (n stays, y closes without writing)', () => {
    const v = vault();
    const ed = createNoteEditor({ vault: () => v });
    ed.apply({ kind: 'open', rel: 'Projects/plan.md' });
    expect(ed.apply({ kind: 'esc' })).toBeUndefined();
    ed.apply({ kind: 'open', rel: 'Projects/plan.md' });
    ed.apply({ kind: 'type', text: 'x' });
    expect(ed.apply({ kind: 'esc' })!.mode).toBe('discard');
    expect(ed.apply({ kind: 'no' })!.mode).toBe('edit');
    ed.apply({ kind: 'esc' });
    expect(ed.apply({ kind: 'yes' })).toBeUndefined();
    expect(readFileSync(join(v, 'Projects', 'plan.md'), 'utf8')).toBe('# Plan\nline two\n');
  });
  test('save after an outside change → conflict row; y reloads from disk, n keeps the edits', () => {
    const v = vault();
    const ed = createNoteEditor({ vault: () => v });
    ed.apply({ kind: 'open', rel: 'Projects/plan.md' });
    ed.apply({ kind: 'type', text: 'mine ' });
    writeFileSync(join(v, 'Projects', 'plan.md'), 'theirs\n');
    utimesSync(join(v, 'Projects', 'plan.md'), new Date(), new Date(Date.now() + 5000));
    expect(ed.apply({ kind: 'save' })!.mode).toBe('conflict');
    expect(readFileSync(join(v, 'Projects', 'plan.md'), 'utf8')).toBe('theirs\n');
    expect(ed.apply({ kind: 'no' })).toMatchObject({ mode: 'edit', dirty: true });
    ed.apply({ kind: 'save' });
    expect(ed.apply({ kind: 'yes' })).toMatchObject({ mode: 'edit', dirty: false, lines: ['theirs', ''], notice: 'Reloaded from disk' });
  });
  test('open failure → no editor, an error toast', () => {
    const toasts: string[] = [];
    const ed = createNoteEditor({ vault: () => vault(), notify: (t) => { toasts.push(t); } });
    expect(ed.apply({ kind: 'open', rel: 'nope.md' })).toBeUndefined();
    expect(toasts).toEqual(['Cannot edit: nope.md not found']);
  });
});

describe('keys, props, render, hydrate wiring', () => {
  test('editorKey map and op validation', () => {
    const view = { rel: 'a.md', lines: [''], row: 0, col: 0, top: 0, dirty: false, mode: 'edit' as const };
    expect(editorKey(view, '\u0013')).toEqual({ kind: 'save' });
    expect(editorKey(view, '\u001b[D')).toEqual({ kind: 'key', key: 'left' });
    expect(editorKey(view, '가')).toEqual({ kind: 'type', text: '가' });
    expect(editorKey(view, '\u001b[200~')).toBeUndefined();
    expect(editorKey({ ...view, mode: 'discard' }, 'y')).toEqual({ kind: 'yes' });
    expect(editorKey({ ...view, mode: 'conflict' }, 'x')).toBeUndefined();
    expect(editOpOf({ kind: 'open', rel: '../etc/passwd' })).toBeUndefined();
    expect(editOpOf({ kind: 'type', text: 'a\u0007b\r\nc' })).toEqual({ kind: 'type', text: 'ab\nc' });
  });
  test('render: exact box, caret line in view, long Korean line scrolls horizontally', () => {
    const long = '가'.repeat(80);
    const rows = plain(renderNoteEditor({ rel: 'n.md', lines: ['a', long], row: 1, col: 80, top: 0, dirty: true, mode: 'edit' }, { w: 40, h: 6 }, true));
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => Bun.stringWidth(row) === 40)).toBe(true);
    expect(rows[0]).toContain('✎ Obsidian · n.md ●');
    expect(rows[2]).toContain('가가');
    expect(rows[5]).toContain('2:81');
    expect(plain(renderNoteEditor({ rel: 'n.md', lines: ['a'], row: 0, col: 0, top: 0, dirty: true, mode: 'conflict' }, { w: 60, h: 5 }, true))[4]).toContain('Changed outside — reload? y/n');
  });
  test('viewer: e on an open note opens the editor via hydrate; keys go up as editOps; Esc closes back to the note', () => {
    const v = vault();
    const ed = createNoteEditor({ vault: () => v });
    let props = hydrateObsidianWithEditor({ dir: 'Projects', cursor: 0, scroll: 0, note: 'Projects/plan.md' }, v, ed);
    const step = (bytes: string): void => { const next = obsidianKey(props, bytes); if (next !== 'pass') props = hydrateObsidianWithEditor(obsidianProps(JSON.parse(JSON.stringify(next)))!, v, ed); };
    step('e');
    expect(props.editor?.rel).toBe('Projects/plan.md');
    expect(props.holdEsc).toBe(true);
    step('\u001b[B'); step('\u001b[F'); step('!'); step('\u0013');
    expect(readFileSync(join(v, 'Projects', 'plan.md'), 'utf8')).toBe('# Plan\nline two!\n');
    step('\u001b');
    expect(props.editor).toBeUndefined();
    expect(props.text).toBe('# Plan\nline two!\n');
    expect(plain(renderObsidian(props, { w: 60, h: 8 }, true)).at(-1)).toContain('e edit');
  });
});

describe('tab', () => {
  test('several keys in one terminal read are applied one by one while editing; q is text in the editor', () => {
    const v = vault();
    const tab = createObsidianTab({ vault: () => v, write: () => undefined, size: () => ({ cols: 80, rows: 20 }) });
    tab.key('\r');                                                                   // into Projects/
    tab.key('\r');                                                                   // open plan.md
    tab.key('e');
    expect(tab.props().editor?.rel).toBe('Projects/plan.md');
    expect(tab.key('\u001b[B\u001b[F')).toBe(false);                                 // ↓ End in one read
    expect(tab.key(' q한글')).toBe(false);
    expect(tab.key('\u0013')).toBe(false);
    expect(readFileSync(join(v, 'Projects', 'plan.md'), 'utf8')).toBe('# Plan\nline two q한글\n');
    expect(tab.key('\u001b')).toBe(false);                                            // closes the editor, not the tab
    expect(tab.props().editor).toBeUndefined();
    expect(tab.key('q')).toBe(true);
  });
});
