import { expect, test } from 'bun:test';
import { renderNextTuiCompactFrame, renderNextTuiLogFrame } from './render.js';

// A notice is information (slash output, a refusal): the whole text stays on screen, wrapped — never cut at the edge.
// Seen live: «/memory» on a 100-column screen lost the end of «(no memory folder yet: <long path> — …)».
const NOTICE = '(no memory folder yet: /very/long/state/dir/memory/folder/that/does/not/fit — it is created as you work)';
const base = { columns: 40, rows: 20, header: ['h'], footer: ['f'], promptLine: '❯ ', notices: [NOTICE], activity: [] as string[],
  scroll: 0, expandedToolIndexes: new Set<number>(), messages: [] };

for (const [name, render] of [['log', renderNextTuiLogFrame], ['compact', renderNextTuiCompactFrame]] as const) for (const [where, input] of [
  ['notice', base],
  // «/memory» answers land in activity (entry.ts memory branch) — the path seen cut off live.
  ['activity', { ...base, notices: [], activity: ['── /memory list ───', NOTICE] }],
] as const) {
  test(`${name} frame: ${where} text longer than the width wraps and keeps every character`, () => {
    const lines = render(input).lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''));
    const rows = lines.filter((line) => line.trim() !== '' && !['h', 'f', '❯'].includes(line.trim()));
    // Rows of at most 40 cells holding all of a longer text = it wrapped.
    expect(rows.every((row) => Bun.stringWidth(row.trimEnd()) <= 40)).toBe(true);
    // Every character survives (a long path breaks mid-word, so compare without the spaces the wrap moves).
    expect(rows.join('').replace(/\s/g, '').replace('──/memorylist───', '')).toBe(
      '(nomemoryfolderyet:/very/long/state/dir/memory/folder/that/does/not/fit—itiscreatedasyouwork)');
  });
}

test('a tool progress row stays one row, cut with the width (it is progress, not an answer)', () => {
  const tool = '⏺ Read(/very/long/state/dir/memory/folder/that/does/not/fit/and/keeps/going/notes.txt)';
  const lines = renderNextTuiLogFrame({ ...base, notices: [], activity: [tool] }).lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''));
  expect(lines.filter((line) => line.includes('⏺ Read(')).length).toBe(1);
  expect(lines.some((line) => line.includes('notes.txt'))).toBe(false);
});
