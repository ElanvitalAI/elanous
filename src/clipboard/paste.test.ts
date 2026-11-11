import { describe, expect, test } from 'bun:test';
import { readClipboardPaste } from './paste.js';
import { createContextRegistry } from '../context.js';
import { registerClipboardImageAttachment } from './image-attachment.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SOURCE_IMAGE = 'clipboard-image-fixture.png';

// Source: clipboard paste contract is image-first with the classic text fallback.
describe('shared clipboard paste contract', () => {
  test('returns the registered image when an image is present', async () => {
    const result = await readClipboardPaste({
      hasImage: async () => true,
      attachImage: async () => '[Image #1]',
      readText: async () => 'clipboard text',
    });
    expect(result).toEqual({ kind: 'image', value: '[Image #1]' });
  });

  test('uses ordinary clipboard text when no image is present', async () => {
    const result = await readClipboardPaste({
      hasImage: async () => false,
      attachImage: async () => '[Image #1]',
      readText: async () => 'path/to/file.png',
    });
    expect(result).toEqual({ kind: 'text', text: 'path/to/file.png', imageDetected: false });
  });

  test('falls back to text when image capture fails', async () => {
    const result = await readClipboardPaste({
      hasImage: async () => true,
      attachImage: async () => null,
      readText: async () => 'ordinary paste',
    });
    expect(result).toEqual({ kind: 'text', text: 'ordinary paste', imageDetected: true });
  });

  test('registers captured PNGs through the same context attachment contract', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clipboard-attachment-'));
    try {
      const path = join(root, SOURCE_IMAGE);
      writeFileSync(path, 'fixture PNG bytes');
      const result = await registerClipboardImageAttachment(createContextRegistry(), async () => path);
      expect(result?.attachment).toMatchObject({ kind: 'image', sourcePath: path, filename: SOURCE_IMAGE });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
