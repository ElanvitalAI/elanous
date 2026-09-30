import { expect, test } from 'bun:test';
import { classifyLeftoverInput, summarizeSubmitText } from './submit-trace.js';

test('submitted text counts code points, lines, and lone Hangul jamo without storing text', () => {
  expect(summarizeSubmitText('안녕')).toEqual({
    chars: 2, lines: 1, lastIsLoneJamo: false, loneJamoCount: 0, hasHangul: true,
  });
  expect(summarizeSubmitText('안ㄴ').lastIsLoneJamo).toBe(true);
  expect(summarizeSubmitText('ㅋㅋㅋ').loneJamoCount).toBe(3);
  expect(summarizeSubmitText('abc').hasHangul).toBe(false);
  expect(summarizeSubmitText('가\n나').lines).toBe(2);
  expect(summarizeSubmitText('😀').chars).toBe(1);
  expect(summarizeSubmitText('ᄀ')).toMatchObject({ lastIsLoneJamo: true, loneJamoCount: 1 });
  const input = 'secret-안ㄴ';
  expect(Object.values(summarizeSubmitText(input)).every(value => typeof value !== 'string')).toBe(true);
  expect(JSON.stringify(summarizeSubmitText(input))).not.toContain(input);
});

test('first single Hangul character within 1000ms is classified, not copied', () => {
  expect(classifyLeftoverInput('다', 300)).toBe('syllable');
  expect(classifyLeftoverInput('ㅇ', 300)).toBe('jamo');
  expect(classifyLeftoverInput('다', 1500)).toBeNull();
  expect(classifyLeftoverInput('ab', 300)).toBeNull();
  expect(classifyLeftoverInput('다', 1000)).toBe('syllable');
  expect(classifyLeftoverInput('다', -1)).toBeNull();
  expect(classifyLeftoverInput('ᄀ', 300)).toBe('jamo');
});
