import { describe, expect, test } from 'bun:test';

import { readCssRootTokens } from './css-root-tokens.js';

describe('readCssRootTokens', () => {
  test('extracts only declarations from the first :root block', () => {
    const tokens = readCssRootTokens(`.card { --ignored: red; }
      :root { --accent: #123456; --font-display: Georgia, serif; }
      :root { --accent: #abcdef; --second: yes; }`);
    expect(tokens.palette).toEqual([{ name: '--accent', value: '#123456' }]);
    expect(tokens.typography).toEqual([{ name: '--font-display', value: 'Georgia, serif' }]);
    expect(tokens.other).toEqual([]);
  });

  test('reads the first rule when :root begins a selector list', () => {
    const tokens = readCssRootTokens(':root, html { --first: red; } :root { --later: blue; }');
    expect(tokens.other).toEqual([{ name: '--first', value: 'red' }]);
  });

  test('reads :root anywhere in a selector list', () => {
    const tokens = readCssRootTokens('html, :root, body { --first: red; } :root { --later: blue; }');
    expect(tokens.other).toEqual([{ name: '--first', value: 'red' }]);
  });

  test('ignores :root text inside another rule’s custom property value', () => {
    const tokens = readCssRootTokens('article { --fallback: :root { --fake: red; }; } :root { --real: blue; }');
    expect(tokens).toEqual({
      palette: [], typography: [], motion: [], other: [{ name: '--real', value: 'blue' }],
    });
  });

  test('does not treat a selector-shaped nested value as a rule', () => {
    const tokens = readCssRootTokens('article { --fallback: { :root { --fake: red; } }; } :root { --real: blue; }');
    expect(tokens.other).toEqual([{ name: '--real', value: 'blue' }]);
  });

  test('finds the first :root rule inside a conditional rule list', () => {
    const tokens = readCssRootTokens('@media (min-width: 20rem) { article { --ignored: red; } :root { --accent: #abc; } } :root { --late: blue; }');
    expect(tokens.palette).toEqual([{ name: '--accent', value: '#abc' }]);
    expect(tokens.other).toEqual([]);
  });

  test('ignores comments including fake selectors and commented-out declarations', () => {
    const tokens = readCssRootTokens(`/* :root { --fake: red; } */
      :root /* real */ {
        /* --hidden: black; */
        --accent: /* ink */ #137b50; /* trailing comment */
        --font-body: "Noto /* literal */ Sans", sans-serif;
      }`);
    expect(tokens.palette).toEqual([{ name: '--accent', value: '#137b50' }]);
    expect(tokens.typography).toEqual([{ name: '--font-body', value: '"Noto /* literal */ Sans", sans-serif' }]);
  });

  test('keeps multiline values, inner semicolons and braces intact', () => {
    const tokens = readCssRootTokens(`:root {
      --font-display: "A; { font",
        "Noto Sans KR", serif;
      --easing: cubic-bezier(0.2,
        0.3, 0.4, 1);
    }`);
    expect(tokens.typography).toEqual([{
      name: '--font-display', value: '"A; { font",\n        "Noto Sans KR", serif',
    }]);
    expect(tokens.motion).toEqual([{
      name: '--easing', value: 'cubic-bezier(0.2,\n        0.3, 0.4, 1)',
    }]);
  });

  test('preserves escaped semicolons and closing braces while reading subsequent tokens', () => {
    const tokens = readCssRootTokens(String.raw`:root {
      --first: a\;b\}c;
      --second: next;
    }`);
    expect(tokens.other).toEqual([
      { name: '--first', value: String.raw`a\;b\}c` },
      { name: '--second', value: 'next' },
    ]);
  });

  test('classifies palette, typography, motion and other tokens without dropping names', () => {
    const tokens = readCssRootTokens(`:root {
      --bg: #fff;
      --color_primary: rgb(1, 2, 3);
      --font-size-title: 2rem;
      --duration-fast: 200ms;
      --space-2: 8px;
    }`);
    expect(tokens.palette.map((token) => token.name)).toEqual(['--bg', '--color_primary']);
    expect(tokens.typography.map((token) => token.name)).toEqual(['--font-size-title']);
    expect(tokens.motion.map((token) => token.name)).toEqual(['--duration-fast']);
    expect(tokens.other.map((token) => token.name)).toEqual(['--space-2']);
  });

  test('preserves empty custom property values and continues to the next declaration', () => {
    const tokens = readCssRootTokens(':root { --empty: ; --next: red; }');
    expect(tokens.other).toEqual([
      { name: '--empty', value: '' },
      { name: '--next', value: 'red' },
    ]);
  });

  test('returns empty sections when :root is missing', () => {
    expect(readCssRootTokens('body { --accent: #fff; }')).toEqual({
      palette: [], typography: [], motion: [], other: [],
    });
  });
});
