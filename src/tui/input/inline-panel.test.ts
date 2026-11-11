import { describe, expect, test } from 'bun:test';
import { formatInlinePanel } from './inline-panel.js';

describe('formatInlinePanel', () => {
  test('keeps the selected row visible in a bounded plain text panel', () => {
    const lines = formatInlinePanel({
      title: '@ 파일 첨부',
      rows: Array.from({ length: 10 }, (_, index) => ({ label: `file-${index}.ts` })),
      selected: 8,
      hint: 'Enter 추가 · Esc 닫기',
    }, 5);
    expect(lines).toEqual([
      '@ 파일 첨부 · ↑↓ 선택 · Enter 선택 · Esc 닫기',
      '  file-6.ts',
      '  file-7.ts',
      '▸ file-8.ts',
      'Enter 추가 · Esc 닫기',
    ]);
  });

  test('renders an empty candidate state without creating a popup', () => {
    expect(formatInlinePanel({ title: '/ 명령', rows: [], hint: '계속 입력' })).toEqual([
      '/ 명령 · ↑↓ 선택 · Enter 선택 · Esc 닫기',
      '  후보 없음',
      '계속 입력',
    ]);
  });
});
