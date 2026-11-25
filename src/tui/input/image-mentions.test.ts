import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imagePathMentions } from './image-mentions.js';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
let root = '';
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ''; });

test('@ mentions (absolute, relative, quoted) and bare absolute image paths resolve to existing images only', () => {
  root = mkdtempSync(join(tmpdir(), 'image-mentions-'));
  mkdirSync(join(root, 'shots'));
  writeFileSync(join(root, 'clip-20261125-120022.png'), PNG_BYTES);
  writeFileSync(join(root, 'shots', 'a.jpg'), PNG_BYTES);
  writeFileSync(join(root, 'my shot.webp'), PNG_BYTES);
  writeFileSync(join(root, 'notes.txt'), 'text');
  const text = [
    `look at ${root}/clip-20261125-120022.png, please`,
    '@shots/a.jpg',
    `@"${root}/my shot.webp"`,
    '@notes.txt',
    `${root}/missing.png`,
    `@${root}/clip-20261125-120022.png`,
  ].join('\n');
  // Order: quoted @ mentions, then unquoted @ mentions, then bare paths; duplicates collapse to the first.
  expect(imagePathMentions(text, root)).toEqual([
    join(root, 'my shot.webp'),
    join(root, 'shots', 'a.jpg'),
    join(root, 'clip-20261125-120022.png'),
  ]);
});

test('plain prose, an empty directory path and an email address are never attachments', () => {
  root = mkdtempSync(join(tmpdir(), 'image-mentions-'));
  mkdirSync(join(root, 'dir.png'));
  expect(imagePathMentions(`mail me@example.com about ${root}/dir.png and @dir.png`, root)).toEqual([]);
});
