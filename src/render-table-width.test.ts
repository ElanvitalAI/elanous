// DEMO-ENGLISH-TABLE — the research card's markdown table: emoji cells and a table wider than the terminal.
// Expected rows are independent literals (not built from the renderer).
import { describe, expect, test } from 'bun:test';
import { renderMarkdown, renderTable } from './render.js';

const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('renderTable width', () => {
  test('emoji cells keep every border aligned', () => {
    const out = plain(renderTable(['Panel', 'Vote'], [['🌐 Macro', 'HOLD'], ['FX', 'BUY']], { headerStyle: (s) => s }));
    expect(out.split('\n')).toEqual([
      '┌──────────┬──────┐',
      '│ Panel    │ Vote │',
      '├──────────┼──────┤',
      '│ 🌐 Macro │ HOLD │',
      '│ FX       │ BUY  │',
      '└──────────┴──────┘',
    ]);
  });

  test('a table wider than the terminal shrinks its widest column and cuts with an ellipsis', () => {
    const top = '┌──────┬───────────────┐'; // the terminal is exactly as wide as this border
    const out = plain(renderTable(['Name', 'Summary'], [['A', 'a very long summary that does not fit']], { headerStyle: (s) => s, maxWidth: Bun.stringWidth(top) }));
    expect(out.split('\n')).toEqual([
      top,
      '│ Name │ Summary       │',
      '├──────┼───────────────┤',
      '│ A    │ a very long … │',
      '└──────┴───────────────┘',
    ]);
  });

  test('renderMarkdown passes the terminal columns to the table', () => {
    const md = '| Panel | Note |\n|---|---|\n| 🗳️ US-China | no parsable answer from the model in time |';
    const lines = plain(renderMarkdown(md, { columns: 30 })).split('\n');
    expect(lines.length).toBe(5);
    for (const line of lines) expect(Bun.stringWidth(line)).toBe(30);
  });
});
