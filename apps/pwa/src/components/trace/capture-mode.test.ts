import { describe, expect, test } from 'bun:test';
import { tracePublicCapture } from './capture-mode';

describe('Trace presentation capture mode', () => {
  test('capture=public opts in even outside presentation', () => {
    expect(tracePublicCapture('public', null)).toBe(true);
    expect(tracePublicCapture('public', 'research')).toBe(true);
  });

  test('stage defaults to public unless capture=private', () => {
    expect(tracePublicCapture(null, 'stage')).toBe(true);
    expect(tracePublicCapture('other', 'stage')).toBe(true);
    expect(tracePublicCapture('private', 'stage')).toBe(false);
  });

  test('ordinary Trace and research stay private without an explicit public option', () => {
    expect(tracePublicCapture(null, null)).toBe(false);
    expect(tracePublicCapture('private', null)).toBe(false);
    expect(tracePublicCapture(null, 'research')).toBe(false);
  });
});
