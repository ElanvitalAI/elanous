import { describe, expect, test } from 'bun:test';
import { originChipText, originTooltipText, terminalOriginLabel } from './terminal-origin-label';

describe('terminal origin labels', () => {
  test('missing classification stays out of the chip but remains explicit in the tooltip', () => {
    expect(originChipText(undefined)).toBe('');
    expect(originChipText({ terminalOriginReason: 'legacy' })).toBe('');
    expect(originTooltipText(undefined)).toBe('출처: 이 행에서는 알 수 없음');
    expect(originTooltipText({ terminalOriginReason: 'legacy' })).toBe('출처: 이 행에서는 알 수 없음: legacy');
    expect(terminalOriginLabel(undefined)).toBe('이 행에서는 알 수 없음');
  });

  test('direct-human shows a person in the chip and tooltip', () => {
    const info = { terminalOriginCategory: 'direct-human' as const };
    expect(originChipText(info)).toBe('사람');
    expect(originTooltipText(info)).toBe('출처: 사람');
  });

  test('classified external tools preserve their name and unknown remains tooltip-only', () => {
    expect(originChipText({ terminalOriginCategory: 'external-tool', externalToolName: 'codex' })).toBe('외부 도구: codex');
    expect(originChipText({ terminalOriginCategory: 'unknown' })).toBe('');
    expect(originTooltipText({ terminalOriginCategory: 'unknown' })).toBe('출처: 이 행에서는 알 수 없음');
  });
});
