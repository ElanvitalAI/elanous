import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContextRegistry } from '../context.js';
import { pasteImagePath } from './image-path-paste.js';

// Source: real format headers — PNG signature + IHDR length head, JPEG SOI+APP0,
// GIF87a version, WebP RIFF + 4-byte size + "WEBP" at offset 8.
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF_HEAD = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
const WEBP_HEAD = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
// Source: a .png name whose content is plain prose — the magic-byte rejection case.
const TEXT_BYTES = Buffer.from('definitely not an image, just prose in a .png file');

let root = '';
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'img-path-paste-')); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

// Source: cell TUI-PASTE-IMAGE-PATH-ATTACH — validation order is exists → regular file → size → magic bytes.
describe('clipboard image-path paste', () => {
  test('attaches a pasted absolute PNG path through the shared image token contract', async () => {
    const pngPath = join(root, 'shot.png');
    writeFileSync(pngPath, PNG_HEAD);
    const result = await pasteImagePath(pngPath, { registry: createContextRegistry() });
    // macOS realpath canonicalizes /var → /private/var — the registry stores the canonical path.
    expect(result).toEqual({ kind: 'image', token: '[Image #1]', attachment: expect.objectContaining({ kind: 'image', sourcePath: realpathSync(pngPath), filename: 'shot.png', sizeBytes: 12 }), isNew: true, format: 'png' }); // 출처: #38867 시험 픽스처 png 의 실측 바이트 수(아래 12바이트 버퍼)
  });

  test('re-pasting the same path dedups to the existing image token', async () => {
    const pngPath = join(root, 'twice.png');
    writeFileSync(pngPath, PNG_HEAD);
    const registry = createContextRegistry();
    await pasteImagePath(pngPath, { registry });
    const result = await pasteImagePath(pngPath, { registry });
    expect(result).toEqual({ kind: 'image', token: '[Image #1]', attachment: expect.objectContaining({ id: 1 }), isNew: false, format: 'png' });
  });

  test('accepts JPEG, GIF and WebP magic bytes as image attachments', async () => {
    const jpegPath = join(root, 'cam.jpg');
    const gifPath = join(root, 'anim.gif');
    const webpPath = join(root, 'lossy.webp');
    writeFileSync(jpegPath, JPEG_HEAD);
    writeFileSync(gifPath, GIF_HEAD);
    writeFileSync(webpPath, WEBP_HEAD);
    const registry = createContextRegistry();
    expect(await pasteImagePath(jpegPath, { registry })).toMatchObject({ kind: 'image', token: '[Image #1]', format: 'jpeg' });
    expect(await pasteImagePath(gifPath, { registry })).toMatchObject({ kind: 'image', token: '[Image #2]', format: 'gif' });
    expect(await pasteImagePath(webpPath, { registry })).toMatchObject({ kind: 'image', token: '[Image #3]', format: 'webp' });
  });

  test('keeps the text as-is with a reason when the extension lies about the content', async () => {
    const liarPath = join(root, 'liar.png');
    writeFileSync(liarPath, TEXT_BYTES);
    const result = await pasteImagePath(liarPath, { registry: createContextRegistry() });
    expect(result).toEqual({ kind: 'text', text: liarPath, reason: 'not-an-image', note: `not an image (magic bytes): ${liarPath}` });
  });

  test('keeps the text as-is when the path does not exist', async () => {
    const missingPath = join(root, 'missing.png');
    const result = await pasteImagePath(missingPath, { registry: createContextRegistry() });
    expect(result).toEqual({ kind: 'text', text: missingPath, reason: 'not-found', note: `path not found: ${missingPath}` });
  });

  test('keeps the text as-is when the path is a directory', async () => {
    const dirPath = join(root, 'folder.png');
    mkdirSync(dirPath);
    const result = await pasteImagePath(dirPath, { registry: createContextRegistry() });
    expect(result).toEqual({ kind: 'text', text: dirPath, reason: 'not-a-file', note: `not a regular file: ${dirPath}` });
  });

  test('keeps the text as-is when the file is larger than the paste gate', async () => {
    const pngPath = join(root, 'huge.png');
    writeFileSync(pngPath, PNG_HEAD);
    // Source: test injection — gate set below the 12-byte PNG head fixture size.
    const result = await pasteImagePath(pngPath, { registry: createContextRegistry(), maxBytes: 4 }); // 출처: #38867 거부 경계 시험 — 픽스처(12바이트)보다 작아 확실히 거부되는 값
    expect(result).toEqual({ kind: 'text', text: pngPath, reason: 'too-large', note: 'file too large: 12 bytes' });
  });

  test('leaves ordinary and multiline pasted text untouched', async () => {
    const registry = createContextRegistry();
    expect(await pasteImagePath('hello world', { registry })).toEqual({ kind: 'text', text: 'hello world', reason: 'not-a-path', note: '' });
    expect(await pasteImagePath('see /tmp/a.png\nand more prose', { registry })).toEqual({ kind: 'text', text: 'see /tmp/a.png\nand more prose', reason: 'not-a-path', note: '' });
    expect(registry.attachments.size).toBe(0);
  });

  test('unquotes Finder-style dragged paths with spaces and rejects URLs', async () => {
    const spacedPath = join(root, 'my shot.png');
    writeFileSync(spacedPath, PNG_HEAD);
    const registry = createContextRegistry();
    expect(await pasteImagePath(`'${spacedPath}'`, { registry })).toMatchObject({ kind: 'image', token: '[Image #1]', format: 'png' });
    expect(await pasteImagePath('https://example.com/cat.png', { registry })).toEqual({ kind: 'text', text: 'https://example.com/cat.png', reason: 'not-a-path', note: '' });
  });
});
