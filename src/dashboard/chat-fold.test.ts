import { describe, expect, test } from 'bun:test';

import { buildFoldedTailLine, splitNoSynthesisTail } from './chat-fold.js';

describe('chat no-synthesis tail', () => {
  test('splits at the first marker while preserving the complete internal tail', () => {
    const text = '사람 줄\n\n[NO FINAL SYNTHESIS] The model used …\n\nExplored: a, b';
    const split = splitNoSynthesisTail(text);
    expect(split?.head).toBe('사람 줄');
    expect(split?.head).not.toContain('[NO FINAL SYNTHESIS]');
    expect(split?.tail.startsWith('[NO FINAL SYNTHESIS]')).toBe(true);
    expect(split?.tail).toBe('[NO FINAL SYNTHESIS] The model used …\n\nExplored: a, b');
    expect(splitNoSynthesisTail('그냥 답')).toBeNull();
  });

  test('one-line locale hint interpolates the line count in every bundle', () => {
    const ko = buildFoldedTailLine(5, 'ko');
    const en = buildFoldedTailLine(5, 'en');
    expect(ko).toBe('● 내부 기록 접힘 · 5줄 · f 로 펼치기');
    expect(en).toBe('● Internal notes folded · 5 lines · press f to expand');
    expect(ko).not.toContain('\n');
    expect(en).not.toContain('\n');
    expect(en).not.toMatch(/[가-힣]/);
    for (const locale of ['ja', 'zh'] as const) {
      const line = buildFoldedTailLine(5, locale);
      expect(line.startsWith('● ')).toBe(true);
      expect(line).toContain('5');
      expect(line).not.toContain('\n');
    }
  });
});
