import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAtPickerPanel, type AtFileCandidate } from './at-picker.js';

const key = (name: string, modifiers = {}) => ({ name, shift: false, ctrl: false, alt: false, ...modifiers });
const candidate = (label: string): AtFileCandidate => ({ label, absPath: `/fixture/${label}`, isDir: false });

test('input branch opens, wraps selection, accepts at the cursor and closes without writing files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'at-panel-'));
  try {
    writeFileSync(join(root, 'a.txt'), 'a');
    writeFileSync(join(root, 'b.txt'), 'b');
    const panel = createAtPickerPanel(root);
    expect(panel.isOpen).toBe(false);
    await panel.refresh('Read @ tail', 6);
    expect(panel.panel?.rows.map(({ label }) => label)).toEqual(['a.txt', 'b.txt']);
    expect(panel.handleKey(key('up'), 'Read @ tail')?.kind).toBe('moved');
    expect(panel.panel?.selected).toBe(1);
    expect(panel.handleKey(key('enter', { shift: true }), 'Read @ tail')).toBeNull();
    expect(panel.isOpen).toBe(true);
    const selection = panel.handleKey(key('enter'), 'Read @ tail');
    expect(selection?.kind).toBe('selected');
    if (selection?.kind !== 'selected') throw new Error('selection not returned');
    expect(selection.accept(2)).toEqual({
      text: 'Read [attached 2: b.txt]  tail', cursor: 'Read [attached 2: b.txt] '.length,
      token: '[attached 2: b.txt]', absPath: join(root, 'b.txt'),
    });
    expect(panel.panel).toBeNull();
    expect(readdirSync(root).sort()).toEqual(['a.txt', 'b.txt']);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('a');
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('b');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cancel keeps the query dismissed until it changes; leaving the query permits reopening', async () => {
  const panel = createAtPickerPanel('/fixture', async () => [candidate('file.txt')]);
  await panel.refresh('@f', 2);
  expect(panel.handleKey(key('escape'), '@f')?.kind).toBe('dismissed');
  expect(panel.isOpen).toBe(false);
  await panel.refresh('@f', 2);
  expect(panel.isOpen).toBe(false);
  await panel.refresh('@fi', 3);
  expect(panel.isOpen).toBe(true);
  panel.handleKey(key('escape'), '@fi');
  await panel.refresh('', 0);
  await panel.refresh('@fi', 3);
  expect(panel.isOpen).toBe(true);
  panel.close();
  expect(panel.isOpen).toBe(false);
});

test('empty and unreadable candidate lists leave Enter to the ordinary composer', async () => {
  const panel = createAtPickerPanel('/fixture', async () => []);
  expect(await panel.refresh('@missing', 8)).toBe('@ no matching files · keep typing');
  expect(panel.handleKey(key('down'), '@missing')).toBeNull();
  expect(panel.handleKey(key('enter'), '@missing')).toBeNull();
  expect(panel.handleKey(key('escape'), '@missing')?.kind).toBe('dismissed');
});

test('late directory reads cannot reopen a closed panel or replace newer candidates', async () => {
  const pending = new Map<string, (files: AtFileCandidate[]) => void>();
  const panel = createAtPickerPanel('/fixture', (prefix) => new Promise((resolve) => pending.set(prefix, resolve)));
  const older = panel.refresh('@a', 2);
  const newer = panel.refresh('@b', 2);
  pending.get('b')!([candidate('b.txt')]);
  await newer;
  pending.get('a')!([candidate('a.txt')]);
  await older;
  expect(panel.panel?.rows).toEqual([{ label: 'b.txt' }]);
  const closing = panel.refresh('@c', 2);
  panel.close();
  pending.get('c')!([candidate('c.txt')]);
  await closing;
  expect(panel.isOpen).toBe(false);
});

test('Enter or Tab on a folder descends into it and keeps the picker query live', async () => {
  const listed: string[] = [];
  const panel = createAtPickerPanel('/fixture', async (prefix) => {
    listed.push(prefix);
    return prefix === 'sr'
      ? [{ label: 'src/', absPath: '/fixture/src', isDir: true }]
      : [{ label: 'src/a.png', absPath: '/fixture/src/a.png', isDir: false }];
  });
  await panel.refresh('look @sr', 8);
  expect(panel.panel?.rows).toEqual([{ label: 'src/', description: 'folder' }]);
  const descended = panel.handleKey(key('tab'), 'look @sr');
  expect(descended).toEqual({ kind: 'descended', text: 'look @src/', cursor: 10 });
  expect(panel.isOpen).toBe(false);
  await panel.refresh('look @src/', 10);
  expect(panel.panel?.rows).toEqual([{ label: 'src/a.png', description: 'image' }]);
  const picked = panel.handleKey(key('enter'), 'look @src/');
  if (picked?.kind !== 'selected') throw new Error('image not selectable');
  expect(picked.accept(1)).toEqual({ text: 'look [image 1: a.png] ', cursor: 22, token: '[image 1: a.png]', absPath: '/fixture/src/a.png' });
  expect(listed).toEqual(['sr', 'src/']);
});
