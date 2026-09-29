import { describe, expect, test } from 'bun:test';
import { readLineHeadTokens, scoreSite, summarize, summarizeBy } from './extract-corpus-score';

const COMMENT_THEN_FG = `:root {
  /* ⚪ --font-display: "Swallowed", serif; this comment must not eat the next declaration */
  --fg: #111111;
  --bg: white;
  --accent: rgba(47, 111, 235, 0.95);
  --font-display: "Source Serif", serif;
  --font-body: "Source Sans", sans-serif;
  --text-base: 16px;
}
`;

describe('scoreSite', () => {
  test('reads --fg on the line after a comment that itself contains --font-display', () => {
    const tokens = readLineHeadTokens(COMMENT_THEN_FG);
    expect(tokens.has('fg')).toBe(true);
    expect(tokens.get('fg')).toBe('#111111');
    expect(tokens.get('font-display')).toBe('"Source Serif", serif');
    const score = scoreSite({
      tokensCss: COMMENT_THEN_FG,
      tokensJson: { paintedColors: { text: { 'rgb(0,0,0)': 40 } } },
    });
    expect(score.core).toBe(6);
    expect(score.empty).toBe(false);
  });

  test('reads the named color white and rgba alpha, and scores black-on-white as contrast 21', () => {
    const css = [
      '--bg: white;',
      '--fg: black;',
      '--accent: rgba(255, 0, 0, 0.5);',
      '--font-display: serif;',
      '--font-body: sans-serif;',
      '--text-base: 1rem;',
    ].join('\n');
    const score = scoreSite({
      tokensCss: css,
      tokensJson: { paintedColors: { text: { black: 21 } } },
    });
    expect(score.core).toBe(6);
    expect(score.contrast).toBe(21);
    expect(score.accentOk).toBe(false);
  });

  test('accent is ok only at alpha ≥ 0.9 and when it differs from the background', () => {
    const base = '--bg: white;\n--fg: black;\n--font-display: serif;\n--font-body: sans;\n--text-base: 16px;\n';
    const faint = scoreSite({
      tokensCss: `${base}--accent: rgba(10, 20, 30, 0.89);`,
      tokensJson: { paintedColors: { text: { x: 20 } } },
    });
    expect(faint.accentOk).toBe(false);
    const solid = scoreSite({
      tokensCss: `${base}--accent: rgba(10, 20, 30, 0.9);`,
      tokensJson: { paintedColors: { text: { x: 20 } } },
    });
    expect(solid.accentOk).toBe(true);
    const same = scoreSite({
      tokensCss: `${base}--accent: white;`,
      tokensJson: { paintedColors: { text: { x: 20 } } },
    });
    expect(same.accentOk).toBe(false);
  });

  test('empty when painted text elements are below 20', () => {
    const css = '--bg: #fff;\n--fg: #000;\n';
    const empty = scoreSite({
      tokensCss: css,
      tokensJson: { paintedColors: { text: { a: 0 } } },
    });
    expect(empty.painted).toBe(0);
    expect(empty.empty).toBe(true);
    const borderline = scoreSite({
      tokensCss: css,
      tokensJson: { paintedColors: { text: { a: 19 } } },
    });
    expect(borderline.empty).toBe(true);
    const filled = scoreSite({
      tokensCss: css,
      tokensJson: { paintedColors: { text: { a: 19, b: 1 } } },
    });
    expect(filled.painted).toBe(20);
    expect(filled.empty).toBe(false);
  });

  test('a --name inside a comment is not counted, even on the same line before a real declaration is absent', () => {
    const css = '/* --fg: #ffffff; --bg: #000000; */\n--accent: #3366cc;\n';
    const tokens = readLineHeadTokens(css);
    expect(tokens.has('fg')).toBe(false);
    expect(tokens.has('bg')).toBe(false);
    expect(tokens.get('accent')).toBe('#3366cc');
    const score = scoreSite({ tokensCss: css, tokensJson: { paintedColors: { text: { a: 30 } } } });
    expect(score.core).toBe(1);
  });

  test('a missing tokens.json is unknown paint, not an empty screen', () => {
    const css = ['--bg: white;', '--fg: black;', '--accent: #3366cc;', '--font-display: serif;', '--font-body: sans;', '--text-base: 16px;'].join('\n');
    const missing = scoreSite({ tokensCss: css, tokensJson: null });
    expect(missing.painted).toBeNull();
    expect(missing.empty).toBeNull();
    expect(missing.core).toBe(6);
    const omitted = scoreSite({ tokensCss: css, tokensJson: undefined });
    expect(omitted.empty).toBeNull();
  });

  test('roles, custom properties, backgrounds, and strokes fill a capture the css left blank', () => {
    const score = scoreSite({
      tokensCss: '/* --fg: white; */\\n',
      tokensJson: {
        roles: { fg: 'black', 'font-body': 'sans-serif' },
        customProperties: { '--accent': '#2244aa', 'font-display': 'serif', '--text-base': '16px' },
        paintedColors: {
          backgrounds: { white: 12, '#eeeeee': 1 },
          strokes: { '#2244aa': 8 },
          text: { black: 30 },
        },
      },
    });
    expect(score.core).toBe(6);
    expect(score.contrast).toBe(21);
    expect(score.accentOk).toBe(true);
    expect(score.painted).toBe(30);
    expect(score.empty).toBe(false);
    const bordersOnly = scoreSite({
      tokensCss: '--bg: white;\n--fg: black;\n',
      tokensJson: { paintedColors: { text: {}, strokes: { '#2244aa': 20 }, backgrounds: { white: 4 } } },
    });
    expect(bordersOnly.painted).toBe(0);
    expect(bordersOnly.empty).toBe(false);
  });
});

describe('summarize', () => {
  test('drops empty rows from the contrast and accent denominators and leaves unknown paint out', () => {
    const summary = summarize([
      { set: 'dev', category: 'saas', core: 6, contrast: 21, accentOk: true, painted: 40, empty: false, sec: 4, ok: true },
      { set: 'dev', category: 'saas', core: 6, contrast: 2, accentOk: false, painted: 0, empty: true, sec: 8, ok: true },
      { set: 'dev', category: 'blog', core: 4, contrast: 3, accentOk: false, painted: 30, empty: false, sec: 2, ok: false },
      { set: 'holdout', category: 'folio', core: 6, contrast: 21, accentOk: true, painted: null, empty: null, sec: 9, ok: true },
    ], 'set');
    expect(summary.n).toBe(4);
    expect(summary.ok).toBe(3);
    expect(summary.empty).toBe(1);
    expect(summary.contrastN).toBe(2);
    expect(summary.contrastPass).toBe(1);
    expect(summary.accentN).toBe(2);
    expect(summary.accentOk).toBe(1);
    expect(summary.medianSec).toBe(6);
    expect(summary.coreAvg).toBeCloseTo((6 + 6 + 4 + 6) / 4);
    const bySet = summarizeBy([
      { set: 'dev', category: 'saas', core: 6, contrast: 21, accentOk: true, painted: 40, empty: false, ok: true },
      { set: 'holdout', category: 'folio', core: 3, contrast: null, accentOk: false, painted: 20, empty: false, ok: false },
    ], 'set');
    expect(bySet.get('dev')?.ok).toBe(1);
    expect(bySet.get('holdout')?.n).toBe(1);
    expect(bySet.get('holdout')?.coreAvg).toBe(3);
    const byCategory = summarizeBy([
      { set: 'dev', category: 'saas', core: 6, contrast: 21, accentOk: true, painted: 40, empty: false, ok: true },
      { set: 'holdout', category: 'saas', core: 6, contrast: 21, accentOk: true, painted: 40, empty: false, ok: true },
    ], 'category');
    expect(byCategory.get('saas')?.n).toBe(2);
  });
});
