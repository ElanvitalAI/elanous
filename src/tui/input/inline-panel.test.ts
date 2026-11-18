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
      '@ 파일 첨부 · ↑↓ select · Enter select · Esc close',
      '  file-6.ts',
      '  file-7.ts',
      '▸ file-8.ts',
      'Enter 추가 · Esc 닫기',
    ]);
  });

  test('renders an empty candidate state without creating a popup', () => {
    expect(formatInlinePanel({ title: '/ 명령', rows: [], hint: '계속 입력' })).toEqual([
      '/ 명령 · ↑↓ select · Enter select · Esc close',
      '  No candidates',
      '계속 입력',
    ]);
  });

  // TUI-COMPACT-CROWDED-FOOTER: with fewer than three rows the decoration (title · hint) is omitted and only candidate rows remain.
  const rows = ['quit', 'help', 'new', 'compact', 'session'].map((label) => ({ label }));
  test('crowded: one row shows only the selected candidate, two rows show a window with the selection visible', () => {
    expect(formatInlinePanel({ title: 't', rows, selected: 0, hint: 'h' }, 1)).toEqual(['▸ quit']);
    expect(formatInlinePanel({ title: 't', rows, selected: 3, hint: 'h' }, 1)).toEqual(['▸ compact']);
    expect(formatInlinePanel({ title: 't', rows, selected: 0, hint: 'h' }, 2)).toEqual(['▸ quit', '  help']);
    expect(formatInlinePanel({ title: 't', rows, selected: 4, hint: 'h' }, 2)).toEqual(['  compact', '▸ session']);
    expect(formatInlinePanel({ title: 't', rows: [], hint: 'h' }, 1)).toEqual(['  No candidates']);
    expect(formatInlinePanel({ title: 't', rows: [], hint: 'h' }, 2)).toEqual(['  No candidates']);
  });

  test('three rows keep the chrome: title, one candidate, hint', () => {
    expect(formatInlinePanel({ title: 't', rows, selected: 2, hint: 'h' }, 3)).toEqual(['t · ↑↓ select · Enter select · Esc close', '▸ new', 'h']);
  });
});

test('the header says what Enter does in this panel — the queue panel edits (header and hint agree)', () => {
  const rows = [{ label: 'steer · queued one' }];
  expect(formatInlinePanel({ title: 'Queue', rows, hint: 'Tab steer↔queue · Delete cancel · Enter edit · Esc close', enterAction: 'edit' }))
    .toEqual(['Queue · ↑↓ select · Enter edit · Esc close', '▸ steer · queued one', 'Tab steer↔queue · Delete cancel · Enter edit · Esc close']);
  expect(formatInlinePanel({ title: 'Model', rows, hint: 'h' })[0]).toBe('Model · ↑↓ select · Enter select · Esc close');
});
