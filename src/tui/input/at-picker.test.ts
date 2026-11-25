import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptAtFile, attachmentsForMessage, listAtFiles, parseAtQuery } from './at-picker.js';

let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

describe('Next TUI lazy @ file picker', () => {
  test('parses the active @ prefix at the cursor and replaces only that prefix on selection', () => {
    const query = parseAtQuery('Please read @docs/rea and continue', 21);
    expect(query).toEqual({ prefix: 'docs/rea', start: 12, end: 21 });
    const picked = acceptAtFile('Please read @docs/rea and continue', query!, {
      label: 'docs/readme.md', absPath: '/repo/docs/readme.md', isDir: false,
    }, 1);
    expect(picked.text).toBe('Please read [attached 1: readme.md]  and continue');
    expect(picked.cursor).toBe('Please read [attached 1: readme.md] '.length);
  });

  test('lists folders (with a trailing slash, first) and files, relative to the root and by absolute path', async () => {
    root = mkdtempSync(join(tmpdir(), 'next-at-picker-'));
    mkdirSync(join(root, 'docs'));
    mkdirSync(join(root, 'pictures'));
    writeFileSync(join(root, 'picked.txt'), 'file body for attachment');
    writeFileSync(join(root, 'docs', 'readme.md'), 'docs body');
    writeFileSync(join(root, '.hidden.txt'), 'hidden');
    expect((await listAtFiles('', root)).map((item) => item.label)).toEqual(['docs/', 'pictures/', 'picked.txt']);
    expect((await listAtFiles('pi', root)).map((item) => [item.label, item.isDir])).toEqual([['pictures/', true], ['picked.txt', false]]);
    expect((await listAtFiles('docs/rea', root)).map((item) => item.label)).toEqual(['docs/readme.md']);
    expect((await listAtFiles('.h', root)).map((item) => item.label)).toEqual(['.hidden.txt']);
    expect((await listAtFiles(`${root}/docs/`, root)).map((item) => [item.label, item.absPath]))
      .toEqual([[`${root}/docs/readme.md`, join(root, 'docs', 'readme.md')]]);
    expect((await listAtFiles('docs/../pick', root)).map((item) => item.absPath)).toEqual([join(root, 'picked.txt')]);
    expect(await listAtFiles('missing-dir/x', root)).toEqual([]);
  });

  test('an image choice gets an image token; a text file keeps the attached token', () => {
    const query = parseAtQuery('see @shot', 9)!;
    expect(acceptAtFile('see @shot', query, { label: 'shot.png', absPath: '/repo/shot.png', isDir: false }, 3).text)
      .toBe('see [image 3: shot.png] ');
    expect(acceptAtFile('see @shot', query, { label: 'shot.txt', absPath: '/repo/shot.txt', isDir: false }, 4).token)
      .toBe('[attached 4: shot.txt]');
  });

  test('attaches selected paths only while their body token remains in the submitted text', () => {
    const selected = new Map([['[attached 1: picked.txt]', '/repo/picked.txt'], ['[attached 2: other.txt]', '/repo/other.txt']]);
    expect(attachmentsForMessage('read [attached 1: picked.txt]', selected)).toEqual(['/repo/picked.txt']);
    expect(attachmentsForMessage('plain prompt', selected)).toEqual([]);
  });
});
