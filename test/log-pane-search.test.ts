// In-pane search — findLogMatches + highlightLineSegments pure fns.

import { describe, expect, test } from 'bun:test';
import { findLogMatches, findVisibleLogMatches, highlightLineSegments } from '../src/log-pane/search.js';
import { visibleSearchRowOffset } from '../src/panes/log-pane.js';
import { stripAnsi } from '../src/tui.js';

describe('findLogMatches', () => {
  test('empty query returns no matches', () => {
    expect(findLogMatches(['hello', 'world'], '')).toEqual([]);
    expect(findLogMatches(['hello', 'world'], '   ')).toEqual([]);
  });

  test('case-insensitive substring match', () => {
    const lines = [
      'INFO request completed',
      'ERROR something broke',
      'DEBUG error handled',
    ];
    const results = findLogMatches(lines, 'ERROR');
    expect(results.map(r => r.lineIdx)).toEqual([1, 2]);
  });

  test('preview includes match with leading/trailing ellipses when trimmed', () => {
    const longLine = 'a'.repeat(50) + 'NEEDLE' + 'b'.repeat(100);
    const results = findLogMatches([longLine], 'NEEDLE');
    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.preview.startsWith('…')).toBe(true);
    expect(r.preview.endsWith('…')).toBe(true);
    expect(r.preview).toContain('NEEDLE');
  });

  test('short line renders without ellipses', () => {
    const results = findLogMatches(['hello world'], 'world');
    expect(results).toHaveLength(1);
    expect(results[0]!.preview).toBe('hello world');
    expect(results[0]!.preview.startsWith('…')).toBe(false);
    expect(results[0]!.preview.endsWith('…')).toBe(false);
  });

  test('match offsets point at the query inside preview', () => {
    const results = findLogMatches(['aaa NEEDLE bbb'], 'NEEDLE');
    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.preview.slice(r.matchStart, r.matchEnd)).toBe('NEEDLE');
  });

  test('one match per line (first occurrence)', () => {
    const lines = ['foo bar foo', 'baz'];
    const results = findLogMatches(lines, 'foo');
    expect(results).toHaveLength(1);
    expect(results[0]!.lineIdx).toBe(0);
  });

  test('ANSI-wrapped content is matched against stripped text', () => {
    const ansiLine = '\x1b[31mERROR\x1b[0m log message';
    const results = findLogMatches([ansiLine], 'ERROR');
    expect(results).toHaveLength(1);
    // Preview is stripped so the escapes don't bleed into the UI.
    expect(results[0]!.preview).not.toContain('\x1b');
    expect(results[0]!.preview).toContain('ERROR');
  });

  test('late match in a multiline entry points to its painted row', () => {
    const lines = ['earlier', Array.from({ length: 30 }, (_, i) => i === 25 ? 'needle' : `row ${i}`).join('\n'), 'later'];
    const result = findLogMatches(lines, 'needle')[0]!;
    expect(result.lineIdx).toBe(1);
    expect(result.physicalRowInEntry).toBe(25);
    expect(result.preview).toBe('needle');
    expect(visibleSearchRowOffset(lines, result)).toBe(26);
    expect(visibleSearchRowOffset(lines, result, 'needle')).toBe(0);
  });

  test('search excludes hidden physical rows and can choose a later visible match', () => {
    const lines = ['foo\nbar\nfoo bar'];
    expect(findVisibleLogMatches(lines, 'bar', 'foo')).toEqual(expect.arrayContaining([
      expect.objectContaining({ lineIdx: 0, physicalRowInEntry: 2 }),
    ]));
    expect(findVisibleLogMatches(['foo\nbar'], 'bar', 'foo')).toEqual([]);
    expect(findVisibleLogMatches(['foo\nbar'], 'bar', 'bar')[0]?.physicalRowInEntry).toBe(1);
  });
});

describe('highlightLineSegments', () => {
  test('returns null when query is empty', () => {
    expect(highlightLineSegments('hello', '')).toBeNull();
    expect(highlightLineSegments('hello', '  ')).toBeNull();
  });

  test('returns null when query is not in line', () => {
    expect(highlightLineSegments('hello world', 'xyz')).toBeNull();
  });

  test('splits a plain line at match boundaries', () => {
    const seg = highlightLineSegments('before NEEDLE after', 'NEEDLE');
    expect(seg).not.toBeNull();
    expect(seg!.prefix).toBe('before ');
    expect(seg!.match).toBe('NEEDLE');
    expect(seg!.suffix).toBe(' after');
  });

  test('case-insensitive match but preserves original casing', () => {
    const seg = highlightLineSegments('hello WORLD bye', 'world');
    expect(seg).not.toBeNull();
    expect(seg!.match).toBe('WORLD');
  });

  test('preserves surrounding ANSI spans in prefix/suffix', () => {
    const line = '\x1b[31mERROR\x1b[0m plain \x1b[32mGREEN\x1b[0m';
    const seg = highlightLineSegments(line, 'plain');
    expect(seg).not.toBeNull();
    // Prefix still carries the red ESC. Suffix still carries the
    // green ESC. Match is the unmodified 'plain' substring.
    expect(stripAnsi(seg!.prefix)).toBe('ERROR ');
    expect(seg!.match).toBe('plain');
    expect(stripAnsi(seg!.suffix)).toBe(' GREEN');
  });
});
