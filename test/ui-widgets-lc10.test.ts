import { describe, expect, test } from 'bun:test';
import { Printer } from '../src/ui/printer.js';
import { stripAnsi } from '../src/tui.js';
import type { KeyEvent } from '../src/plugins/core/types.js';
import { FileDialog, type FileEntry } from '../src/ui/widgets/file-dialog.js';

function key(name: string, mods: Partial<KeyEvent> = {}): KeyEvent {
  return { name, ctrl: false, shift: false, alt: false, ...mods };
}

function render(v: { draw: (p: Printer) => void }, w = 50, h = 10, focused = true): string[] {
  const p = Printer.create({ width: w, height: h, focused });
  v.draw(p);
  return p.lines().map(stripAnsi);
}

async function nextTick(): Promise<void> {
  await new Promise(r => setTimeout(r, 5));
}

function makeFs(map: Record<string, FileEntry[]>) {
  return (path: string): FileEntry[] => map[path] ?? [];
}

describe('LC10 FileDialog', () => {
  test('renders current dir entries + breadcrumb title', async () => {
    const fs = makeFs({
      '/': [
        { name: 'src',     isDirectory: true },
        { name: 'a.txt',   isDirectory: false },
        { name: '.hidden', isDirectory: false, hidden: true },
      ],
    });
    const d = new FileDialog({ startDir: '/', mode: 'open', readDir: fs, onSubmit: () => {} });
    d.takeFocus();
    await nextTick();
    const lines = render(d, 50, 10);
    const joined = lines.join('\n');
    expect(joined).toContain('Open — /');
    expect(joined).toContain('src/');
    expect(joined).toContain('a.txt');
    expect(joined).not.toContain('.hidden');
  });

  test('navigates into a directory on Enter', async () => {
    const fs = makeFs({
      '/':    [{ name: 'sub', isDirectory: true }, { name: '..', isDirectory: true }],
      '/sub': [{ name: 'deep.txt', isDirectory: false }],
    });
    const d = new FileDialog({ startDir: '/', mode: 'open', readDir: fs, onSubmit: () => {} });
    d.takeFocus();
    await nextTick();
    // cursor is on '..' by default; press down to get to sub
    d.onEvent(key('down'));
    d.onEvent(key('enter'));
    await nextTick();
    expect(d._state().cwd).toBe('/sub');
  });

  test('open mode submits full path on file Enter', async () => {
    const fs = makeFs({
      '/': [{ name: 'hello.txt', isDirectory: false }],
    });
    let picked: string | null = null;
    const d = new FileDialog({
      startDir: '/', mode: 'open', readDir: fs,
      onSubmit: p => { picked = p; },
    });
    d.takeFocus();
    await nextTick();
    d.onEvent(key('down'));           // skip '..'
    d.onEvent(key('enter'));
    expect(picked).toBe('/hello.txt');
  });

  test('dir mode picks current dir on Ctrl+Enter', async () => {
    const fs = makeFs({ '/work': [] });
    let picked: string | null = null;
    const d = new FileDialog({
      startDir: '/work', mode: 'dir', readDir: fs,
      onSubmit: p => { picked = p; },
    });
    d.takeFocus();
    await nextTick();
    d.onEvent(key('enter', { ctrl: true }));
    expect(picked).toBe('/work');
  });

  test('parent navigation via ..', async () => {
    const fs = makeFs({
      '/home':      [{ name: 'alice', isDirectory: true }],
      '/home/alice': [{ name: 'f.txt', isDirectory: false }],
    });
    const d = new FileDialog({ startDir: '/home/alice', mode: 'open', readDir: fs, onSubmit: () => {} });
    d.takeFocus();
    await nextTick();
    // cursor on '..'
    d.onEvent(key('enter'));
    await nextTick();
    expect(d._state().cwd).toBe('/home');
  });

  test('showHidden exposes dotfiles', async () => {
    const fs = makeFs({
      '/': [{ name: '.env', isDirectory: false }],
    });
    const d = new FileDialog({
      startDir: '/', mode: 'open', readDir: fs, showHidden: true, onSubmit: () => {},
    });
    d.takeFocus();
    await nextTick();
    const lines = render(d, 40, 6);
    expect(lines.join('\n')).toContain('.env');
  });

  test('chromeSpec overrides title and can hide close glyph', async () => {
    const fs = makeFs({
      '/': [{ name: 'hello.txt', isDirectory: false }],
    });
    const d = new FileDialog({
      startDir: '/',
      mode: 'open',
      readDir: fs,
      chromeSpec: { title: 'Spec file picker', showClose: false, variant: 'panel' },
      onSubmit: () => {},
    });
    d.takeFocus();
    await nextTick();
    const lines = render(d, 40, 6);
    const joined = lines.join('\n');
    expect(joined).toContain('Spec file picker');
    expect(joined).not.toContain('×');
  });
});
