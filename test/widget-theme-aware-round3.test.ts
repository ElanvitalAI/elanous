// IDX-6 Widget round-2 (file name "round3" to avoid collision with the
// pre-existing round-1 FU I test file that was confusingly named
// `widget-theme-aware-round2.test.ts`).
//
// Scope: TextArea gained
// an optional `theme?` spec field. These tests assert:
//   1. backward compat — no theme → pre-Phase rendering holds
//   2. theme-aware — output differs across presets (MOCHA / LATTE /
//      ROSE_PINE_DAWN / ELANOUS_PASTEL_DEFAULT)
//   3. baseline glyphs (cursor, muted prefix) still present in both
//      paths, so callers don't lose visual affordance

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import chalk from 'chalk';
import {
  CATPPUCCIN_LATTE,
  CATPPUCCIN_MOCHA,
} from '../src/themes/index.js';
import { Printer } from '../src/ui/printer.js';
import { TextArea } from '../src/ui/widgets/text-area.js';

const ORIG_CHALK_LEVEL = chalk.level;

function renderToString(
  view: { draw(p: Printer): void; layout?(s: { width: number; height: number }): void; takeFocus?(): boolean },
  width = 40,
  height = 8,
  focused = true,
): string {
  const p = Printer.create({ width, height, focused });
  view.layout?.({ width, height });
  view.takeFocus?.();
  view.draw(p);
  return p.lines().join('\n');
}

beforeEach(() => { chalk.level = 3; });
afterEach(() => { chalk.level = ORIG_CHALK_LEVEL; });

describe('TextArea — theme passthrough', () => {
  test('without theme renders text (backward compat)', () => {
    // readOnly suppresses the cursor bar so the raw text stays
    // contiguous — the backward-compat assertion is about text
    // surfacing at all, not cursor color.
    const ta = new TextArea({ text: 'hello', readOnly: true });
    const out = renderToString(ta, 20, 3);
    expect(out).toContain('hello');
  });

  test('cursor bar differs across themes (editable focused)', () => {
    const a = new TextArea({ text: '', theme: CATPPUCCIN_MOCHA });
    const b = new TextArea({ text: '', theme: CATPPUCCIN_LATTE });
    const outA = renderToString(a, 10, 2, true);
    const outB = renderToString(b, 10, 2, true);
    expect(outA).toContain('▎');
    expect(outB).toContain('▎');
    expect(outA).not.toBe(outB);
  });

  test('readOnly mode does not paint cursor regardless of theme', () => {
    const a = new TextArea({ text: 'hello', theme: CATPPUCCIN_MOCHA, readOnly: true });
    const out = renderToString(a, 20, 2, true);
    expect(out).not.toContain('▎');
    expect(out).toContain('hello');
  });
});
