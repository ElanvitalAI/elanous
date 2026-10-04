import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseInjectArgs } from './telegram-inject-args.js';

const dir = mkdtempSync(join(tmpdir(), 'telegram-inject-args-'));
const photos = [1, 2, 3].map((n) => {
  const path = join(dir, `photo-${n}.png`);
  writeFileSync(path, 'fixture');
  return path;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('parseInjectArgs', () => {
  test('글만', () => {
    expect(parseInjectArgs(['--to', '@bot', '--text', 'hello'], {})).toEqual({
      to: '@bot', text: 'hello', photos: [],
    });
  });

  test('사진 1장과 글은 설명으로', () => {
    expect(parseInjectArgs(['--photo', photos[0]!, '--text', 'caption'], { TELEGRAM_TEST_BOT: '@bot' })).toEqual({
      to: '@bot', photos: [photos[0]], caption: 'caption',
    });
  });

  test('사진 3장 순서 유지', () => {
    expect(parseInjectArgs([
      '--to', '@bot', '--photo', photos[2]!, '--photo', photos[0]!, '--photo', photos[1]!,
    ], {})).toEqual({ to: '@bot', photos: [photos[2], photos[0], photos[1]] });
  });

  test('없는 사진 파일 경로 오류', () => {
    const missing = join(dir, 'missing.png');
    expect(() => parseInjectArgs(['--to', '@bot', '--photo', missing], {})).toThrow(missing);
  });

  test('--text 값 대신 --photo 옵션을 받으면 오류', () => {
    expect(() => parseInjectArgs(['--to', '@bot', '--text', '--photo', photos[0]!], {})).toThrow('옵션 값 없음: --text');
  });

  test('글도 사진도 없으면 오류', () => {
    expect(() => parseInjectArgs(['--to', '@bot'], {})).toThrow();
  });
});
