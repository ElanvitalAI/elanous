// DEMO-1121-VAULT-NOTES-READ literals (OP #103716): the chat agent finds and reads a lecture note in the member's notes
// folder; nothing outside that folder is reachable; no folder set → a plain refusal. Synthetic notes only (no real names).
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchNotesRead, dispatchNotesSearch } from './notes.js';

const cleanups: string[] = [];
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function vault() {
  const base = mkdtempSync(join(tmpdir(), 'notes-'));
  cleanups.push(base);
  const root = join(base, 'vault');
  mkdirSync(join(root, '강의노트'), { recursive: true });
  writeFileSync(join(root, '강의노트', '주식전문가-반도체-1주차.md'), '# 반도체 1주차\n- 메모리 사이클 · 재고 지표\n');
  writeFileSync(join(root, '강의노트', '주식전문가-2차전지-1주차.md'), '# 2차전지\n');
  writeFileSync(join(base, 'outside.md'), 'SECRET OUTSIDE');
  symlinkSync(join(base, 'outside.md'), join(root, '강의노트', 'link-out.md'));
  return { root, base, notesRoot: () => ({ available: true, root }) };
}

test('NotesSearch finds the lecture note by a word in its name; NotesRead returns its text', async () => {
  const v = vault();
  const found = await dispatchNotesSearch({ query: '반도체' }, v.notesRoot) as { notes: { relPath: string }[] };
  expect(found.notes.map((note) => note.relPath)).toEqual(['강의노트/주식전문가-반도체-1주차.md']);
  expect(dispatchNotesRead({ path: '강의노트/주식전문가-반도체-1주차.md' }, v.notesRoot))
    .toEqual({ path: '강의노트/주식전문가-반도체-1주차.md', content: '# 반도체 1주차\n- 메모리 사이클 · 재고 지표\n', size: 59, truncated: false }); // 출처: #39059 합성 노트의 UTF-8 바이트 수
});

test('nothing outside the notes folder is read: .. · an absolute path elsewhere · a symlink out · a non-note file', () => {
  const v = vault();
  expect(() => dispatchNotesRead({ path: '../outside.md' }, v.notesRoot)).toThrow();
  expect(() => dispatchNotesRead({ path: join(v.base, 'outside.md') }, v.notesRoot)).toThrow();
  expect(() => dispatchNotesRead({ path: '강의노트/link-out.md' }, v.notesRoot)).toThrow();
  expect(() => dispatchNotesRead({ path: '.env' }, v.notesRoot)).toThrow('only .md, .markdown or .txt notes are read');
});

test('no notes folder set → a plain refusal that says where to set it', async () => {
  const none = () => ({ available: false, root: '/nonexistent' });
  expect(() => dispatchNotesRead({ path: 'a.md' }, none)).toThrow('no notes folder is set');
  await expect(dispatchNotesSearch({ query: 'x' }, none)).rejects.toThrow('no notes folder is set');
});
