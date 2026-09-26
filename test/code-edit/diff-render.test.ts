import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import chalk from 'chalk';
import {
  _clearDiffRenderCacheForTesting,
  _getDiffRenderCacheStatsForTesting,
  buildDiffRenderCacheKey,
  detectTerminalBgLightness,
  detectTerminalColorLevel,
  renderEditBlock,
  resolveDiffRenderVariant,
  resolveDiffPalette,
  type EditResult,
} from '../../src/code-edit/index.js';

// Bun test runs without a TTY, so chalk's default is level 0 (strip
// all escapes). The renderer is supposed to emit coloured output when
// the caller asks for it, so flip to level 3 (truecolor) up-front so
// the colour-present assertions see what production sees.
beforeAll(() => { chalk.level = 3; });
beforeEach(() => _clearDiffRenderCacheForTesting());

function mkResult(
  filePath: string,
  before: string,
  after: string,
  hunks: EditResult['structuredPatch'],
): EditResult {
  const added = hunks.reduce((a, h) => a + h.lines.filter((l) => l.startsWith('+')).length, 0);
  const removed = hunks.reduce((a, h) => a + h.lines.filter((l) => l.startsWith('-')).length, 0);
  return {
    ok: true,
    file_path: filePath,
    structuredPatch: hunks,
    originalContent: before,
    newContent: after,
    edits: [{ old_string: before, new_string: after }],
    linesAdded: added,
    linesRemoved: removed,
  };
}

describe('renderEditBlock — structure (noColor)', () => {
  const result = mkResult(
    '/abs/foo.ts',
    'line1\nOLD\nline3\n',
    'line1\nNEW\nline3\n',
    [
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        lines: [' line1', '-OLD', '+NEW', ' line3'],
      },
    ],
  );

  test('first line is Update(path) header', () => {
    const rows = renderEditBlock(result, { noColor: true });
    expect(rows[0]).toContain('Update(/abs/foo.ts)');
    expect(rows[0]).toContain('●');
  });

  test('second line reports Added/Removed counts', () => {
    const rows = renderEditBlock(result, { noColor: true });
    expect(rows[1]).toContain('Added 1 lines, removed 1 lines');
  });

  test('line numbers + markers appear in hunk rows', () => {
    const rows = renderEditBlock(result, { noColor: true });
    const body = rows.slice(2).join('\n');
    // Deletion at old line 2, addition at new line 2.
    expect(body).toMatch(/2\s*-\s*OLD/);
    expect(body).toMatch(/2\s*\+\s*NEW/);
    // Context gets a space marker and its line number.
    expect(body).toMatch(/1\s{2,}line1/);
    expect(body).toMatch(/3\s{2,}line3/);
  });

  test('Create verb when originalContent is empty', () => {
    const r = mkResult('/abs/new.md', '', 'hi\n', [{
      oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+hi'],
    }]);
    const rows = renderEditBlock(r, { noColor: true });
    expect(rows[0]).toContain('Create(/abs/new.md)');
  });

  test('multi-hunk output has ⋮ separator between hunks', () => {
    const r = mkResult('/abs/big.ts', 'a', 'b', [
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] },
      { oldStart: 10, oldLines: 1, newStart: 10, newLines: 1, lines: ['-x', '+y'] },
    ]);
    const rows = renderEditBlock(r, { noColor: true });
    const joined = rows.join('\n');
    expect(joined).toContain('⋮');
  });

  test('hunk header carries unified-diff `@@ -old,n +new,n @@` range', () => {
    const r = mkResult('/abs/big.ts', 'a', 'b', [
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] },
      { oldStart: 10, oldLines: 2, newStart: 10, newLines: 3, lines: ['-x', '+y', '+z'] },
    ]);
    const rows = renderEditBlock(r, { noColor: true });
    const joined = rows.join('\n');
    expect(joined).toContain('@@ -1,1 +1,1 @@');
    expect(joined).toContain('@@ -10,2 +10,3 @@');
  });

  test('first hunk header omits the ⋮ gap glyph (nothing to gap from)', () => {
    const r = mkResult('/abs/foo.ts', 'a', 'b', [
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] },
    ]);
    const rows = renderEditBlock(r, { noColor: true });
    const header = rows.find((l) => l.includes('@@'))!;
    expect(header).toContain('@@ -1,1 +1,1 @@');
    expect(header).not.toContain('⋮');
  });

  test('empty patch still emits header + sub-header', () => {
    const r = mkResult('/abs/noop.ts', 'same', 'same', []);
    const rows = renderEditBlock(r, { noColor: true });
    expect(rows.length).toBe(2);
    expect(rows[0]).toContain('Update(/abs/noop.ts)');
  });

  test('edited header style renders a Claude-like delta title', () => {
    const rows = renderEditBlock(result, { noColor: true, headerStyle: 'edited' });
    expect(rows[0]).toContain('Edited /abs/foo.ts (+1 -1)');
    expect(rows.slice(1).join('\n')).toMatch(/2\s*\+\s*NEW/);
  });
});

describe('renderEditBlock — ANSI coloring', () => {
  const result = mkResult(
    '/abs/f.ts',
    'A\n',
    'B\n',
    [
      {
        oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
        lines: ['-A', '+B'],
      },
    ],
  );

  test('default output contains ANSI escape sequences', () => {
    const rows = renderEditBlock(result);
    expect(rows.join('\n')).toMatch(/\x1b\[/);
  });

  test('noColor strips all escapes', () => {
    const rows = renderEditBlock(result, { noColor: true });
    expect(rows.join('\n')).not.toMatch(/\x1b\[/);
  });

  test('add row and delete row use different bg colours', () => {
    const rows = renderEditBlock(result);
    // With color: the delete row and add row should differ in bytes.
    const delRow = rows.find((r) => r.includes('A'))!;
    const addRow = rows.find((r) => r.includes('B'))!;
    expect(delRow).not.toBe(addRow);
    expect(delRow.length).toBeGreaterThan(1);
    expect(addRow.length).toBeGreaterThan(1);
  });
});

describe('renderEditBlock — width behaviour', () => {
  test('cols option right-pads body so bg fills the row', () => {
    const r = mkResult('/abs/x.ts', 'short', 'short', [{
      oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
      lines: ['+hi'],
    }]);
    const rows = renderEditBlock(r, { noColor: true, cols: 40 });
    const addRow = rows.find((l) => /\+\s*hi/.test(l))!;
    // Row body + gutter should be ~cols wide (no color, counting chars directly).
    expect(addRow.length).toBeGreaterThanOrEqual(20);
  });

  test('maxLineWidth truncates very long lines with ellipsis', () => {
    const huge = 'x'.repeat(5000);
    const r = mkResult('/abs/big.ts', huge, huge, [{
      oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['+' + huge],
    }]);
    const rows = renderEditBlock(r, { noColor: true, maxLineWidth: 100 });
    // Skip the `@@ -… +… @@` hunk header (Phase 2) — match the
    // numbered `+` content row instead.
    const addRow = rows.find((l) => /^\s*\d+\s*\+/.test(l))!;
    expect(addRow.length).toBeLessThan(200);
    expect(addRow).toContain('…');
  });
});

describe('diff palette helpers', () => {
  test('detectTerminalColorLevel resolves truecolor / 256 / ansi16', () => {
    expect(detectTerminalColorLevel({ COLORTERM: 'truecolor' } as NodeJS.ProcessEnv)).toBe('truecolor');
    expect(detectTerminalColorLevel({ TERM: 'xterm-256color' } as NodeJS.ProcessEnv)).toBe('256');
    expect(detectTerminalColorLevel({ TERM: 'screen' } as NodeJS.ProcessEnv)).toBe('ansi16');
  });

  test('detectTerminalBgLightness uses COLORFGBG heuristic', () => {
    expect(detectTerminalBgLightness({ COLORFGBG: '15;0' } as NodeJS.ProcessEnv)).toBe(false);
    expect(detectTerminalBgLightness({ COLORFGBG: '0;15' } as NodeJS.ProcessEnv)).toBe(true);
    expect(detectTerminalBgLightness({} as NodeJS.ProcessEnv)).toBe(null);
  });

  test('ansi16 palette emits fg-only escapes without bg fills', () => {
    const palette = resolveDiffPalette('ansi16', false);
    const sample = palette.addBody('hello');
    expect(sample).toMatch(/\x1b\[/);
    expect(sample).not.toMatch(/\x1b\[4\d/);
    expect(sample).not.toMatch(/\x1b\[10\d/);
  });

  test('light truecolor palette differs from dark palette', () => {
    const dark = resolveDiffPalette('truecolor', false).addBody('x');
    const light = resolveDiffPalette('truecolor', true).addBody('x');
    expect(light).not.toBe(dark);
  });

  test('render variant resolves adaptive bg and render dimensions', () => {
    const variant = resolveDiffRenderVariant({
      cols: 120,
      maxLineWidth: 300,
      syntax: true,
      colorTier: '256',
    });
    expect(variant).toEqual({
      cols: 120,
      noColor: false,
      maxLineWidth: 300,
      syntax: true,
      colorTier: '256',
      isLight: false,
      inlineWordDiff: false,
    });
  });

  test('cache key is derived from the resolved render variant', () => {
    const key = buildDiffRenderCacheKey({
      cols: 80,
      noColor: true,
      maxLineWidth: 2000,
      syntax: true,
      colorTier: 'auto',
      isLight: false,
      inlineWordDiff: false,
    });
    expect(key).toBe('cols:80|no:1|max:2000|syn:1|tier:auto|light:0|wd:0');
  });

  test('inlineWordDiff flag flows into the variant + cache key', () => {
    const variant = resolveDiffRenderVariant({ inlineWordDiff: true });
    expect(variant.inlineWordDiff).toBe(true);
    expect(buildDiffRenderCacheKey(variant)).toContain('|wd:1');
  });
});

describe('diff render cache', () => {
  const result = mkResult(
    '/abs/cache.ts',
    'before\nvalue\n',
    'before\nnext\n',
    [
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        lines: [' before', '-value', '+next'],
      },
    ],
  );

  test('re-rendering the same hunk and variant records a cache hit', () => {
    renderEditBlock(result, { noColor: true, cols: 80 });
    expect(_getDiffRenderCacheStatsForTesting()).toEqual({
      hits: 0,
      misses: 1,
      evictions: 0,
    });

    renderEditBlock(result, { noColor: true, cols: 80 });
    expect(_getDiffRenderCacheStatsForTesting()).toEqual({
      hits: 1,
      misses: 1,
      evictions: 0,
    });
  });

  test('variant changes produce cache misses instead of stale reuse', () => {
    renderEditBlock(result, { noColor: true, cols: 80 });
    renderEditBlock(result, { noColor: true, cols: 120 });
    expect(_getDiffRenderCacheStatsForTesting()).toEqual({
      hits: 0,
      misses: 2,
      evictions: 0,
    });
  });

  test('bounded cache evicts the oldest variant after the cap', () => {
    const widths = [60, 70, 80, 90, 100];
    for (const cols of widths) renderEditBlock(result, { noColor: true, cols });
    expect(_getDiffRenderCacheStatsForTesting()).toEqual({
      hits: 0,
      misses: 5,
      evictions: 1,
    });

    renderEditBlock(result, { noColor: true, cols: 60 });
    expect(_getDiffRenderCacheStatsForTesting()).toEqual({
      hits: 0,
      misses: 6,
      evictions: 2,
    });
  });
});

describe('renderEditBlock — inlineWordDiff (Phase 5)', () => {
  test('default (off) — `-`/`+` pair renders without intra-line inverse', () => {
    const r = mkResult('/abs/x.ts', 'const x = 1;', 'const x = 2;', [{
      oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
      lines: ['-const x = 1;', '+const x = 2;'],
    }]);
    const rows = renderEditBlock(r);
    const joined = rows.join('\n');
    // No chalk.inverse escape (`\x1b[7m`) anywhere when inlineWordDiff
    // is off — the option is strictly additive.
    expect(joined).not.toContain('\x1b[7m');
  });

  test('inlineWordDiff: true — changed span gains chalk.inverse emphasis', () => {
    const r = mkResult('/abs/x.ts', 'const x = 1;', 'const x = 2;', [{
      oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
      lines: ['-const x = 1;', '+const x = 2;'],
    }]);
    const rows = renderEditBlock(r, { inlineWordDiff: true });
    const joined = rows.join('\n');
    // chalk.bold.inverse = `\x1b[1m\x1b[7m…` — we just assert inverse
    // appears, which only happens on the word-diff path.
    expect(joined).toContain('\x1b[7m');
  });

  test('inlineWordDiff is a no-op when noColor=true (shiki/inverse both suppressed)', () => {
    const r = mkResult('/abs/x.ts', 'a', 'b', [{
      oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
      lines: ['-a', '+b'],
    }]);
    const rows = renderEditBlock(r, { noColor: true, inlineWordDiff: true });
    const joined = rows.join('\n');
    expect(joined).not.toContain('\x1b[');
  });

  test('unpaired `-` (no following `+`) falls back to the existing line path', () => {
    const r = mkResult('/abs/x.ts', 'a\nb\n', 'b\n', [{
      oldStart: 1, oldLines: 2, newStart: 1, newLines: 1,
      lines: ['-a', ' b'],
    }]);
    const rows = renderEditBlock(r, { inlineWordDiff: true });
    // Should not throw; output should mention `-` marker and `b`.
    const joined = rows.join('\n');
    expect(joined).toContain('-');
    expect(joined).toContain('b');
  });
});
