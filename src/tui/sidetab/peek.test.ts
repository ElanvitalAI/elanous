import { describe, expect, test } from 'bun:test';
import { formatSidetabPeekLines } from './peek.js';

describe('next TUI sidetab peek', () => {
  test('uses only the last three non-empty lines and strips terminal controls', () => {
    const lines = formatSidetabPeekLines('\u001b[31mfirst\u001b[0m\r\n\r\nsecond\rthird\u001b]0;title\u0007', 28);
    expect(lines).toEqual(['   ↳ first', '   ↳ second', '   ↳ third']);
  });

  test('bounds snapshot cleanup before selecting the latest lines', () => {
    const largeSnapshot = `${Array.from({ length: 30_000 }, (_, i) => `old-${i}\n`).join('')}first-visible\nsecond-visible\nlatest-visible`;
    expect(formatSidetabPeekLines(largeSnapshot, 32)).toEqual([
      '   ↳ first-visible', '   ↳ second-visible', '   ↳ latest-visible',
    ]);
  });

  test('truncates at grapheme boundaries to the available panel width', () => {
    const lines = formatSidetabPeekLines('12345678901234567890\n가나다라마바사', 12, 2);
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => Bun.stringWidth(line) <= 12)).toBe(true);
    expect(lines[0]).toEndWith('…');
    expect(lines[1]).toContain('가');
  });

  test('returns no preview for empty, too narrow, or disabled inputs', () => {
    expect(formatSidetabPeekLines('', 20)).toEqual([]);
    expect(formatSidetabPeekLines('output', 4)).toEqual([]);
    expect(formatSidetabPeekLines('output', 20, 0)).toEqual([]);
  });
});
