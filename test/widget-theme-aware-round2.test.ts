// FU I (IDX-6 Phase 4) — theme-aware refactor: SelectView.
//
// Mirrors the widget-theme-aware.test.ts harness from Button/Dialog.
// Covers backward-compat (no theme), theme-aware rendering,
// cross-theme differentiation.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import chalk from 'chalk';
import {
  resolveSemantic,
  resolveWidgetTokens,
  type ThemeTokens,
} from '../src/theme/tokens.js';
import {
  CATPPUCCIN_LATTE,
  CATPPUCCIN_MOCHA,
  ELANOUS_PASTEL_DEFAULT,
  NORD_LIGHT,
  ROSE_PINE_DAWN,
} from '../src/themes/index.js';
import { Printer } from '../src/ui/printer.js';
import { SelectView } from '../src/ui/widgets/select-view.js';

const ORIG_CHALK_LEVEL = chalk.level;

function renderToString(
  view: { draw(p: Printer): void },
  width = 40,
  height = 8,
  focused = true,
): string {
  const p = Printer.create({ width, height, focused });
  view.draw(p);
  return p.lines().join('\n');
}

function hexTriple(hex: string): string {
  const body = hex.replace('#', '');
  return `${parseInt(body.slice(0, 2), 16)};${parseInt(
    body.slice(2, 4),
    16,
  )};${parseInt(body.slice(4, 6), 16)}`;
}

describe('FU I SelectView — backward compat (no theme)', () => {
  beforeEach(() => {
    chalk.level = 3;
  });
  afterEach(() => {
    chalk.level = ORIG_CHALK_LEVEL;
  });

  test('renders options + cursor without theme', () => {
    const sel = new SelectView({
      options: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
      ],
      onSubmit: () => {},
    });
    sel.takeFocus();
    const out = renderToString(sel, 30, 6);
    expect(out).toContain('Alpha');
    expect(out).toContain('Beta');
    // IDX-F8 — cursor indicator ▸
    expect(out).toContain('▸');
  });
});

describe('FU I SelectView — theme-aware cursor', () => {
  beforeEach(() => {
    chalk.level = 3;
  });
  afterEach(() => {
    chalk.level = ORIG_CHALK_LEVEL;
  });

  test('theme cursor uses selectView.cursor token', () => {
    const sel = new SelectView({
      options: [{ value: 'a', label: 'Alpha' }],
      onSubmit: () => {},
      theme: ROSE_PINE_DAWN,
    });
    sel.takeFocus();
    const out = renderToString(sel, 30, 4);
    const cursor = resolveWidgetTokens(ROSE_PINE_DAWN, 'selectView').cursor;
    expect(out).toContain(hexTriple(cursor.fg));
  });

  test('cross-theme differentiation on cursor color', () => {
    const makeView = (theme: ThemeTokens) =>
      new SelectView({
        options: [{ value: 'a', label: 'Alpha' }],
        onSubmit: () => {},
        theme,
      });
    const mochaView = makeView(CATPPUCCIN_MOCHA);
    const latteView = makeView(CATPPUCCIN_LATTE);
    mochaView.takeFocus();
    latteView.takeFocus();
    const outMocha = renderToString(mochaView, 30, 4);
    const outLatte = renderToString(latteView, 30, 4);
    expect(outMocha).not.toBe(outLatte);
  });
});
