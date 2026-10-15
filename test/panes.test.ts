// ── Pane render purity — same input produces same output ──
// These tests lock in the Phase 0 extractions: each pane module exports
// a pure function over explicit state. The assertion is determinism,
// not visual correctness.

import { describe, test, expect } from 'bun:test';
import { buildLogPaneViewport, renderLogPane, findBlock, renderBodyLine, physicalLogRowCount, logPaneContentHeight, maxLogPaneScroll } from '../src/panes/log-pane.js';
import { stripAnsi } from '../src/tui.js';
import { renderSkillsRows, type SkillRow } from '../src/panes/skills-pane.js';
import { renderFilesRows } from '../src/panes/files-pane.js';
import { paneTitle } from '../src/panes/pane-title.js';
import { fileColor, fileIcon, sizeStr } from '../src/panes/file-icons.js';
import { colorLine } from '../src/panes/syntax-color.js';
import { canPreview } from '../src/panes/preview-pane.js';
import type { FileTreeEntry } from '../src/types.js';

describe('log pane', () => {
  test('multiline log content consumes physical rows without covering the streaming footer', () => {
    const viewport = buildLogPaneViewport(
      { lines: ['command\nfirst\nlast'], scrollOffset: -1, footerLine: 'streaming' },
      { width: 40, height: 6, focused: false },
    );
    expect(viewport.bodyLines).toHaveLength(5);
    expect(viewport.bodyLines.map(stripAnsi)).toEqual([
      '  command', '  first', '  last', '', '  streaming',
    ]);
    expect(viewport.visibleLineIndices).toEqual([0, 0, 0, -1, -1]);
    expect(viewport.bodyLines.every(line => !/[\r\n]/.test(line))).toBe(true);
  });

  test('filter matches only the physical line containing the query', () => {
    const viewport = buildLogPaneViewport(
      { lines: ['before\nneedle\nafter'], scrollOffset: -1, filterQuery: 'needle' },
      { width: 40, height: 4, focused: false },
    );
    expect(viewport.title).toContain('⌕ needle · 1');
    expect(viewport.bodyLines.join('\n')).toContain('needle');
    expect(viewport.bodyLines.join('\n')).not.toContain('before');
    expect(viewport.visibleLineIndices.filter(index => index >= 0)).toEqual([0]);
  });

  test('manual scroll reaches each physical row of a multiline entry', () => {
    const lines = ['first\nsecond\nthird', 'fourth', 'fifth', 'sixth'];
    const height = 4;
    const maxScroll = physicalLogRowCount(lines) - (height - 1);
    expect(physicalLogRowCount(lines, 1)).toBe(3);
    expect(maxScroll).toBe(3);
    const atTop = buildLogPaneViewport({ lines, scrollOffset: 0 }, { width: 30, height, focused: false });
    const oneRowDown = buildLogPaneViewport({ lines, scrollOffset: 1 }, { width: 30, height, focused: false });
    const atTail = buildLogPaneViewport({ lines, scrollOffset: maxScroll }, { width: 30, height, focused: false });
    expect(atTop.bodyLines.slice(0, 3).map(stripAnsi)).toEqual(['  first', '  second', '  third']);
    expect(oneRowDown.bodyLines.slice(0, 3).map(stripAnsi)).toEqual(['  second', '  third', '  fourth']);
    expect(atTail.bodyLines.slice(0, 3).map(stripAnsi)).toEqual(['  fourth', '  fifth', '  sixth']);
  });

  test('filtered scroll bounds count only painted physical rows and reserve footer rows', () => {
    const lines = ['before\r\nneedle\rafter', 'other'];
    expect(physicalLogRowCount(lines)).toBe(4);
    expect(physicalLogRowCount(lines, lines.length, 'needle')).toBe(1);
    expect(logPaneContentHeight(6, true, false)).toBe(3);
    expect(logPaneContentHeight(6, true, true)).toBe(2);
    const maxScroll = Math.max(0, physicalLogRowCount(lines, lines.length, 'needle') - logPaneContentHeight(6, true, false));
    expect(maxScroll).toBe(0);
    const viewport = buildLogPaneViewport(
      { lines, scrollOffset: maxScroll, filterQuery: 'needle', footerLine: 'Streaming…' },
      { width: 40, height: 6, focused: false },
    );
    expect(viewport.bodyLines.map(stripAnsi)).toEqual(['  needle', '', '', '', '  Streaming…']);
  });

  test('keyboard and wheel scroll bound respects filter, freeze, and queued footer height', () => {
    const lines = ['old\nneedle one\nold', 'needle two\nneedle three', 'needle four'];
    expect(maxLogPaneScroll(lines, 4)).toBe(3);
    expect(maxLogPaneScroll(lines, 4, { filterQuery: 'needle' })).toBe(1);
    expect(maxLogPaneScroll(lines, 4, { filterQuery: 'needle', frozenTailIndex: 1 })).toBe(0);
    expect(maxLogPaneScroll(lines, 6, { filterQuery: 'needle', hasFooter: true, hasQueueRow: true })).toBe(2);
  });

  test('renders title + body lines = height', () => {
    const out = renderLogPane(
      { lines: ['a', 'b', 'c'], scrollOffset: 0 },
      { width: 40, height: 5, focused: false },
    );
    // 1 title + (height - 1) body rows
    expect(out).toHaveLength(5);
    expect(out[0]).toContain('Log');
  });

  test('is pure — same input → same output', () => {
    const state = { lines: ['x', 'y'], scrollOffset: -1 };
    const ctx = { width: 30, height: 4, focused: true };
    expect(renderLogPane(state, ctx)).toEqual(renderLogPane(state, ctx));
  });

  test('findBlock returns null on empty input', () => {
    expect(findBlock([], 0)).toBeNull();
  });

  test('findBlock finds a single block with no separators', () => {
    const out = findBlock(['a', 'b', 'c'], 1);
    expect(out).toEqual({ start: 0, end: 3 });
  });

  test('findBlock picks the block the cursor lands in', () => {
    const lines = ['A1', 'A2', '', 'B1', 'B2', 'B3', '', 'C1'];
    expect(findBlock(lines, 0)).toEqual({ start: 0, end: 2 });
    expect(findBlock(lines, 4)).toEqual({ start: 3, end: 6 });
    expect(findBlock(lines, 7)).toEqual({ start: 7, end: 8 });
  });

  test('findBlock on separator walks back to previous non-empty', () => {
    const lines = ['A1', 'A2', '', 'B1'];
    expect(findBlock(lines, 2)).toEqual({ start: 0, end: 2 });
  });

  test('findBlock returns null when cursor is before any non-empty line', () => {
    expect(findBlock(['', '', 'x'], 0)).toBeNull();
  });

  test('follow-tail clamps scrollOffset to maxScroll', () => {
    const longLines = Array.from({ length: 20 }, (_, i) => `line${i}`);
    const tail = renderLogPane(
      { lines: longLines, scrollOffset: -1 },
      { width: 40, height: 5, focused: false },
    );
    // height 5 = title + 4 body rows; last body row should contain line19
    expect(tail[tail.length - 1]).toContain('line19');
  });

  describe('scroll-freeze', () => {
    test('no badge when nothing is hidden behind the freeze', () => {
      const out = renderLogPane(
        { lines: ['a', 'b'], scrollOffset: 0, frozenTailIndex: 2 },
        { width: 40, height: 5, focused: false },
      );
      expect(out[0]).not.toContain('⏸');
    });

    test('badge surfaces hidden-line count in the title row', () => {
      const lines = Array.from({ length: 30 }, (_, i) => `L${i}`);
      const out = renderLogPane(
        { lines, scrollOffset: 5, frozenTailIndex: 20 },
        { width: 60, height: 8, focused: false },
      );
      // 10 lines past the freeze index should be hidden.
      expect(out[0]).toContain('⏸ 10 new');
      expect(out[0]).toContain('G');  // "press G" hint
    });

    test('visible slice is clipped to frozenTailIndex', () => {
      const lines = Array.from({ length: 30 }, (_, i) => `L${i}`);
      const out = renderLogPane(
        { lines, scrollOffset: -1, frozenTailIndex: 10 },
        { width: 40, height: 6, focused: false },
      );
      // Tail-follow under freeze sticks to L9 (index 9, last visible
      // before the frozen cutoff). Must NOT surface any L10+ line.
      const body = out.slice(1).join('\n');
      expect(body).toContain('L9');
      expect(body).not.toMatch(/\bL1[0-9]\b/);
      expect(body).not.toMatch(/\bL2[0-9]\b/);
    });

    test('frozenTailIndex clamped to lines.length defensively', () => {
      // If freeze snapshot is stale (> current length) the renderer
      // treats it as "freeze at current length" — no crash, no badge.
      const lines = ['a', 'b'];
      const out = renderLogPane(
        { lines, scrollOffset: 0, frozenTailIndex: 999 },
        { width: 40, height: 4, focused: false },
      );
      expect(out[0]).not.toContain('⏸');
    });

    test('null frozenTailIndex behaves like legacy (no clipping)', () => {
      const lines = Array.from({ length: 30 }, (_, i) => `L${i}`);
      const out = renderLogPane(
        { lines, scrollOffset: -1, frozenTailIndex: null },
        { width: 40, height: 5, focused: false },
      );
      // Last body row shows the real tail.
      expect(out[out.length - 1]).toContain('L29');
    });
  });

  describe('filter hint', () => {
    test('focused pane with no active filter surfaces the filter hint', () => {
      const out = renderLogPane(
        { lines: ['a', 'b'], scrollOffset: -1, filterHint: '/log filter' },
        { width: 50, height: 5, focused: true },
      );
      expect(stripAnsi(out[0])).toContain('/log filter');
    });

    test('active filter suppresses the passive hint and shows the query badge instead', () => {
      const out = renderLogPane(
        { lines: ['error one', 'two'], scrollOffset: -1, filterQuery: 'error', filterHint: '/log filter' },
        { width: 50, height: 5, focused: true },
      );
      const title = stripAnsi(out[0]);
      expect(title).toContain('⌕ error');
      expect(title).not.toContain('/log filter');
    });
  });

  describe('filter + scrolled status viewport', () => {
    test('filter narrows visible dataset and records source line indices', () => {
      const viewport = buildLogPaneViewport(
        {
          lines: ['alpha', 'beta', 'needle one', 'gamma', 'needle two'],
          scrollOffset: 0,
          filterQuery: 'needle',
        },
        { width: 40, height: 5, focused: false },
      );
      expect(viewport.title).toContain('⌕ needle · 2');
      expect(viewport.bodyLines.join('\n')).toContain('needle one');
      expect(viewport.bodyLines.join('\n')).toContain('needle two');
      expect(viewport.visibleLineIndices.filter(idx => idx >= 0)).toEqual([2, 4]);
    });

    test('long viewport renders a footer status instead of a scrollbar rail', () => {
      const out = renderLogPane(
        {
          lines: Array.from({ length: 30 }, (_, i) => `line-${i}`),
          scrollOffset: 0,
        },
        { width: 20, height: 6, focused: false },
      );
      const body = out.slice(1);
      expect(stripAnsi(body[body.length - 1] ?? '')).toContain('scrolled 1-5/30');
      expect(body.some(row => {
        const stripped = stripAnsi(row);
        return stripped.endsWith('█') || stripped.endsWith('│');
      })).toBe(false);
    });
  });

  describe('overflow marker', () => {
    test('short line passes through untouched (no marker)', () => {
      const out = renderBodyLine('hello', 20);
      expect(stripAnsi(out)).toBe('hello');
      expect(out).not.toContain('…+');
    });

    test('wide line gets …+N tail with hidden-char count', () => {
      const line = 'a'.repeat(50);
      const out = renderBodyLine(line, 20);
      const stripped = stripAnsi(out);
      // Should fit within maxW (20 cols).
      expect(stripped.length).toBeLessThanOrEqual(20);
      // Marker shows how many chars are hidden.
      expect(stripped).toContain('…+');
      const markerMatch = stripped.match(/…\+(\d+)$/);
      expect(markerMatch).toBeTruthy();
      // Hidden count = visible chars past maxW. 50 - 20 = 30
      // (plus a little wiggle because we reserve marker width).
      const hidden = parseInt(markerMatch![1]!, 10);
      expect(hidden).toBeGreaterThanOrEqual(30);
    });

    test('UTF-8 wide chars counted correctly', () => {
      // Korean wide chars take 2 cols each; 20 chars = 40 cols wide.
      const line = '로'.repeat(20);
      const out = renderBodyLine(line, 20);
      const stripped = stripAnsi(out);
      expect(stripped).toContain('…+');
      // Truncated visible width stays ≤ 20 cols.
      // (visible-width check is what matters; not byte length.)
    });

    test('very narrow maxW falls back to plain truncate (no marker)', () => {
      const line = 'verylongline';
      const out = renderBodyLine(line, 5);
      // Under 10 cols we skip the rich marker to avoid painting only
      // "…+N" with no content.
      expect(stripAnsi(out)).not.toContain('…+');
    });

    test('marker has no second truncation — fits in maxW', () => {
      const line = 'x'.repeat(200);
      const maxW = 30;
      const out = renderBodyLine(line, maxW);
      const stripped = stripAnsi(out);
      expect(stripped.length).toBeLessThanOrEqual(maxW);
    });
  });
});

describe('skills pane', () => {
  const rows: SkillRow[] = [
    { name: 'alpha', fileCount: 3, syncedTargets: 2, hasSnapshot: true, lastSynced: new Date('2026-01-01') },
    { name: 'beta',  fileCount: 1, syncedTargets: 0, hasSnapshot: false },
  ];

  test('produces exactly listH rows (padded with empty strings)', () => {
    const out = renderSkillsRows(
      { rows, cursor: 0, offset: 0, focused: true },
      30, 5,
    );
    expect(out).toHaveLength(5);
    expect(out[0]).toContain('alpha');
    expect(out[1]).toContain('beta');
    expect(out[2]).toBe('');
  });

  test('is pure', () => {
    const state = { rows, cursor: 1, offset: 0, focused: false };
    expect(renderSkillsRows(state, 30, 3)).toEqual(renderSkillsRows(state, 30, 3));
  });
});

describe('files pane', () => {
  const files: FileTreeEntry[] = [
    { path: 'SKILL.md', size: 1024, mtime: '' },
    { path: 'src/index.ts', size: 2048, mtime: '' },
  ];

  test('renders files with icons and sizes', () => {
    const out = renderFilesRows(
      { files, cursor: 0, offset: 0, focused: true },
      40, 3,
    );
    expect(out).toHaveLength(3);
    expect(out[0]).toContain('SKILL.md');
    expect(out[1]).toContain('index.ts');
  });

  test('is pure', () => {
    const state = { files, cursor: 0, offset: 0, focused: false };
    expect(renderFilesRows(state, 40, 2)).toEqual(renderFilesRows(state, 40, 2));
  });
});

describe('pane-title', () => {
  test('active and inactive render different ANSI', () => {
    const a = paneTitle('Hello', true, 30);
    const b = paneTitle('Hello', false, 30);
    expect(a).not.toEqual(b);
    expect(a).toContain('Hello');
    expect(b).toContain('Hello');
  });
});

describe('file-icons', () => {
  test('sizeStr formats B/K/M', () => {
    expect(sizeStr(500)).toBe('500B');
    expect(sizeStr(2048)).toBe('2K');
    expect(sizeStr(5 * 1024 * 1024)).toBe('5.0M');
  });

  test('fileIcon + fileColor handle known types', () => {
    expect(fileIcon('foo.md')).toBeTruthy();
    expect(fileIcon('foo.ts')).toBeTruthy();
    expect(typeof fileColor('foo.py')).toBe('function');
  });
});

describe('syntax-color', () => {
  test('colorLine returns non-empty ANSI for every extension path', () => {
    expect(colorLine('# heading', '.md')).toBeTruthy();
    expect(colorLine('const x = 1', '.ts')).toBeTruthy();
    expect(colorLine('def foo():', '.py')).toBeTruthy();
    expect(colorLine('{"k": 1}', '.json')).toBeTruthy();
    expect(colorLine('SELECT *', '.sql')).toBeTruthy();
  });

  test('is pure', () => {
    expect(colorLine('const x = 1', '.ts')).toBe(colorLine('const x = 1', '.ts'));
  });
});

describe('preview-pane canPreview', () => {
  test('allows common text extensions', () => {
    expect(canPreview('foo.md')).toBe(true);
    expect(canPreview('src/a.ts')).toBe(true);
    expect(canPreview('config.yaml')).toBe(true);
  });

  test('blocks unknown binary-like extensions', () => {
    expect(canPreview('image.png')).toBe(false);
    expect(canPreview('data.bin')).toBe(false);
  });

  test('allows well-known bare names', () => {
    expect(canPreview('SKILL.md')).toBe(true);
    expect(canPreview('Makefile')).toBe(true);
    expect(canPreview('Dockerfile')).toBe(true);
  });
});
