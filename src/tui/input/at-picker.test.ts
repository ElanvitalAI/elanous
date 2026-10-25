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

  test('lists matching files only, descends by typed prefix, and refuses paths outside the root', async () => {
    root = mkdtempSync(join(tmpdir(), 'next-at-picker-'));
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'picked.txt'), 'file body for attachment');
    writeFileSync(join(root, 'docs', 'readme.md'), 'docs body');
    expect((await listAtFiles('pick', root)).map((item) => item.label)).toEqual(['picked.txt']);
    expect((await listAtFiles('docs/rea', root)).map((item) => item.label)).toEqual(['docs/readme.md']);
    expect(await listAtFiles('../picked', root)).toEqual([]);
  });

  test('attaches selected paths only while their body token remains in the submitted text', () => {
    const selected = new Map([['[attached 1: picked.txt]', '/repo/picked.txt'], ['[attached 2: other.txt]', '/repo/other.txt']]);
    expect(attachmentsForMessage('read [attached 1: picked.txt]', selected)).toEqual(['/repo/picked.txt']);
    expect(attachmentsForMessage('plain prompt', selected)).toEqual([]);
  });
});
