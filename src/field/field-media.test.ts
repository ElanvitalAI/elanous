import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FIELD_MAX_FILE_BYTES,
  FieldUploadError,
  defaultFieldEvent,
  fieldTimestamp,
  listFieldMedia,
  parseFieldCaption,
  sanitizeFieldName,
  saveFieldMedia,
} from './field-media.js';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function root(): string {
  const r = mkdtempSync(join(tmpdir(), 'field-media-'));
  roots.push(r);
  return r;
}
const NOW = () => new Date('2026-10-15T10:00:00.000Z');
const bytes = (n: number) => new Uint8Array(n).fill(7);

describe('saveFieldMedia', () => {
  test('names files <capturedAt|now>-<device>-<sanitized original> and writes .ready with the media count', () => {
    const rootDir = root();
    const result = saveFieldMedia([
      { originalName: 'IMG_0001.HEIC', mimeType: 'image/heic', bytes: bytes(3), capturedAt: '2026-10-15T19:30:12.456+09:00' },
      { originalName: '../../무대 사진!.jpg', mimeType: 'image/jpeg', bytes: bytes(4) },
    ], { rootDir, event: 'marketers-night-2026-10', device: 'iphone-ceo', now: NOW });
    expect(result.saved).toEqual([
      { name: '20261015T103012Z-iphone-ceo-IMG_0001.HEIC', bytes: 3 },
      { name: '20261015T100000Z-iphone-ceo-_.jpg', bytes: 4 },
    ]);
    expect(result.count).toBe(2);
    const dir = join(rootDir, 'field', 'marketers-night-2026-10');
    expect(readFileSync(join(dir, '.ready'), 'utf8')).toBe('2\n');
    expect(readdirSync(dir).filter((n) => n.startsWith('.tmp-'))).toEqual([]);
  });

  test('.ready counts media already in the folder; non-media and dotfiles are not counted', () => {
    const rootDir = root();
    saveFieldMedia([{ originalName: 'a.mp4', mimeType: 'video/mp4', bytes: bytes(1) }], { rootDir, event: 'ev', device: 'd', now: NOW });
    const dir = join(rootDir, 'field', 'ev');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    const second = saveFieldMedia([{ originalName: 'b.mov', mimeType: 'video/quicktime', bytes: bytes(2) }], { rootDir, event: 'ev', device: 'd', now: NOW });
    expect(second.count).toBe(2);
    expect(readFileSync(join(dir, '.ready'), 'utf8')).toBe('2\n');
    expect(listFieldMedia(dir).map((f) => f.name)).toEqual(['20261015T100000Z-d-a.mp4', '20261015T100000Z-d-b.mov']);
  });

  test('same name + same size is a resend (overwrite); a different size gets a suffix', () => {
    const rootDir = root();
    const opts = { rootDir, event: 'ev', device: 'd', now: NOW };
    saveFieldMedia([{ originalName: 'x.png', mimeType: 'image/png', bytes: bytes(5) }], opts);
    expect(saveFieldMedia([{ originalName: 'x.png', mimeType: 'image/png', bytes: bytes(5) }], opts).count).toBe(1);
    const third = saveFieldMedia([{ originalName: 'x.png', mimeType: 'image/png', bytes: bytes(6) }], opts);
    expect(third.saved[0]!.name).toBe('20261015T100000Z-d-x-1.png');
    expect(third.count).toBe(2);
  });

  test('rejects bad slugs, bad types, oversize files and empty batches — and writes nothing', () => {
    const rootDir = root();
    const ok = { originalName: 'a.jpg', mimeType: 'image/jpeg', bytes: bytes(1) };
    const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as FieldUploadError).code; } return 'none'; };
    expect(code(() => saveFieldMedia([ok], { rootDir, event: 'Bad Slug', device: 'd' }))).toBe('bad-slug');
    expect(code(() => saveFieldMedia([ok], { rootDir, event: '../x', device: 'd' }))).toBe('bad-slug');
    expect(code(() => saveFieldMedia([ok], { rootDir, event: 'ev', device: '-d' }))).toBe('bad-slug');
    expect(code(() => saveFieldMedia([ok, { originalName: 'a.gif', mimeType: 'image/gif', bytes: bytes(1) }], { rootDir, event: 'ev', device: 'd' })))
      .toBe('unsupported-media-type');
    expect(code(() => saveFieldMedia([{ originalName: 'doc.pdf', mimeType: 'application/octet-stream', bytes: bytes(1) }], { rootDir, event: 'ev', device: 'd' })))
      .toBe('unsupported-media-type');
    expect(code(() => saveFieldMedia([{ ...ok, bytes: new Uint8Array(FIELD_MAX_FILE_BYTES + 1) }], { rootDir, event: 'ev', device: 'd' })))
      .toBe('too-large');
    expect(code(() => saveFieldMedia([], { rootDir, event: 'ev', device: 'd' }))).toBe('no-files');
    expect(existsSync(join(rootDir, 'field', 'ev'))).toBe(false);
    expect(new FieldUploadError('unsupported-media-type', 'x').status).toBe(415);
    expect(new FieldUploadError('too-large', 'x').status).toBe(413);
  });

  test('the per-request total cap applies across files', () => {
    const rootDir = root();
    const big = { originalName: 'v.mp4', mimeType: 'video/mp4', bytes: new Uint8Array(FIELD_MAX_FILE_BYTES) };
    let caught: FieldUploadError | undefined;
    try { saveFieldMedia([big, big, big], { rootDir, event: 'ev', device: 'd' }); } catch (e) { caught = e as FieldUploadError; }
    expect(caught?.code).toBe('too-large');
    expect(caught?.message).toContain('250 MB');
  });
});

describe('name + timestamp helpers', () => {
  test('sanitizeFieldName keeps [A-Za-z0-9._-], strips paths, caps at 80, adds a missing extension', () => {
    expect(sanitizeFieldName('C:\\Users\\me\\IMG 1 (2).JPG', 'image/jpeg')).toBe('IMG_1_2_.JPG');
    expect(sanitizeFieldName('file_12', 'image/jpeg')).toBe('file_12.jpg');
    expect(sanitizeFieldName('', 'video/quicktime')).toBe('media.mov');
    expect(sanitizeFieldName('.hidden.png', 'image/png')).toBe('hidden.png');
    const long = sanitizeFieldName(`${'a'.repeat(200)}.mp4`, 'video/mp4');
    expect(long.length).toBe(80);
    expect(long.endsWith('.mp4')).toBe(true);
  });

  test('fieldTimestamp uses capturedAt when parseable, else now (UTC, ISO basic)', () => {
    const now = NOW();
    expect(fieldTimestamp('2026-10-15T19:30:12+09:00', now)).toBe('20261015T103012Z');
    expect(fieldTimestamp(1_760_520_612_000, now)).toBe('20251015T093012Z');
    expect(fieldTimestamp('1760520612', now)).toBe('20251015T093012Z');
    expect(fieldTimestamp('not a date', now)).toBe('20261015T100000Z');
    expect(fieldTimestamp(undefined, now)).toBe('20261015T100000Z');
  });
});

describe('telegram caption grammar', () => {
  test('parseFieldCaption', () => {
    expect(parseFieldCaption(undefined)).toBeNull();
    expect(parseFieldCaption('무대 사진')).toBeNull();
    expect(parseFieldCaption('#현장아님')).toBeNull();
    expect(parseFieldCaption('#현장')).toEqual({});
    expect(parseFieldCaption('오프닝 #현장')).toEqual({ text: '오프닝' });
    expect(parseFieldCaption('#현장 marketers-night-2026-10')).toEqual({ event: 'marketers-night-2026-10' });
    expect(parseFieldCaption('#현장   Marketers-Night 오프닝')).toEqual({ event: 'marketers-night', text: '오프닝' });
    expect(parseFieldCaption('#현장 멋진 무대')).toEqual({ text: '멋진 무대' });
    expect(parseFieldCaption('#현장 ../etc')).toEqual({ text: '../etc' });
  });

  test('defaultFieldEvent prefers a valid config value, else field-<local date>', () => {
    const at = new Date(2026, 9, 3, 23, 59);
    expect(defaultFieldEvent('marketers-night-2026-10', at)).toBe('marketers-night-2026-10');
    expect(defaultFieldEvent('Bad Value', at)).toBe('field-2026-10-03');
    expect(defaultFieldEvent(undefined, at)).toBe('field-2026-10-03');
  });
});

describe('field captions (reel subtitles)', () => {
  test('parser splits event and text around the tag', async () => {
    const { parseFieldCaption } = await import('./field-media.js');
    expect(parseFieldCaption('#현장 marketers-night 오프닝 무대')).toEqual({ event: 'marketers-night', text: '오프닝 무대' });
    expect(parseFieldCaption('#현장 멋진 무대')).toEqual({ text: '멋진 무대' });
    expect(parseFieldCaption('첫 장 #현장')).toEqual({ text: '첫 장' });
    expect(parseFieldCaption('#현장')).toEqual({});
    expect(parseFieldCaption('그냥 사진')).toBeNull();
  });

  test('each file caption writes a normalized line against its saved name', () => {
    const rootDir = root();
    const result = saveFieldMedia([
      { originalName: 'a.jpg', mimeType: 'image/jpeg', bytes: bytes(1), caption: '첫 줄 | 하나' },
      { originalName: 'b.jpg', mimeType: 'image/jpeg', bytes: bytes(1), caption: '두 번째\n줄' },
    ], { rootDir, event: 'ev', device: 'd', now: NOW });
    expect(readFileSync(join(result.dir, 'captions.txt'), 'utf8')).toBe(
      `${result.saved[0]!.name} | 첫 줄 ｜ 하나\n${result.saved[1]!.name} | 두 번째 줄\n`);
  });

  test('a caption becomes one captions.txt line on the first saved file only', async () => {
    const { saveFieldMedia, FIELD_CAPTIONS_FILE } = await import('./field-media.js');
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const rootDir = mkdtempSync(join(tmpdir(), 'field-cap-'));
    const img = (n: string) => ({ originalName: n, mimeType: 'image/jpeg', bytes: new Uint8Array([1, 2, 3]) });
    const r = saveFieldMedia([img('a.jpg'), img('b.jpg')], { rootDir, event: 'ev', device: 'd', caption: '첫 줄\n둘째 | 셋째' });
    const text = readFileSync(join(r.dir, FIELD_CAPTIONS_FILE), 'utf8');
    expect(text).toBe(`${r.saved[0]!.name} | 첫 줄 둘째 ｜ 셋째\n`);
    saveFieldMedia([img('c.jpg')], { rootDir, event: 'ev', device: 'd' });
    expect(readFileSync(join(r.dir, FIELD_CAPTIONS_FILE), 'utf8').split('\n').filter(Boolean).length).toBe(1);
  });
});
