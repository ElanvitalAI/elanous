// IDX-6 Phase 5 adoption — shadow auto-opt-in regression tests.
//
// Covers the three adoption sites:
//   1. mouse-action-recipes (`buildActionPicker` shadow passthrough)
//   2. context-menu-host (buildContextMenuPopup shadow option)
//   3. dashboard-context-menu-registry (getTheme → presenter shadow)
//
// Asserts that pushing `shadow: { theme }` through these layers
// produces a painted shadow band, and that `ELANOUS_MODAL_SHADOW=off`
// env disables the band even when the theme is supplied.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import chalk from 'chalk';
import {
  createModelPickerRecipe,
} from '../src/mouse-action-recipes.js';
import type { PopupPlacement } from '../src/status/popups.js';
import { buildContextMenuPopup } from '../src/ui/context-menu-host.js';
import { createDefaultMenuPresenter } from '../src/ui/context-menu-presenter.js';
import { CATPPUCCIN_MOCHA, CATPPUCCIN_LATTE } from '../src/themes/index.js';
import type { ModalSurface } from '../src/display/modal-stack.js';
import type { Menu } from '../src/ui/context-menu-registry.js';

const ORIG_CHALK = chalk.level;
const ORIG_SHADOW = process.env.ELANOUS_MODAL_SHADOW;

beforeEach(() => {
  chalk.level = 3;
  delete process.env.ELANOUS_MODAL_SHADOW;
});
afterEach(() => {
  chalk.level = ORIG_CHALK;
  if (ORIG_SHADOW === undefined) delete process.env.ELANOUS_MODAL_SHADOW;
  else process.env.ELANOUS_MODAL_SHADOW = ORIG_SHADOW;
});

const placement: PopupPlacement = {
  anchorStartCol: 0,
  anchorEndCol: 20,
  statusRow: 20,
  termCols: 80,
  termRows: 24,
};

describe('mouse-action-recipes shadow passthrough', () => {
  test('createModelPickerRecipe with shadow paints ▓ band', () => {
    const handle = createModelPickerRecipe({
      entries: [
        { label: 'Opus 4.7',   provider: 'anthropic', model: 'claude-opus-4-7' },
        { label: 'Sonnet 4.6', provider: 'anthropic', model: 'claude-sonnet-4-6' },
      ],
      placement,
      onSwitch: () => {},
      shadow: { theme: CATPPUCCIN_MOCHA },
    });
    const out = handle.surface.paint();
    expect(out).toContain('▓');
  });

  test('createModelPickerRecipe without shadow option has no ▓ band', () => {
    const handle = createModelPickerRecipe({
      entries: [
        { label: 'Opus 4.7', provider: 'anthropic', model: 'claude-opus-4-7' },
      ],
      placement,
      onSwitch: () => {},
    });
    const out = handle.surface.paint();
    expect(out).not.toContain('▓');
  });


});

describe('buildContextMenuPopup shadow option', () => {
  test('shadow option paints ▓ band', () => {
    const handle = buildContextMenuPopup(
      {
        items: [
          { value: 'open', label: 'Open' },
          { value: 'copy', label: 'Copy' },
        ],
        anchorRow: 10,
        anchorCol: 10,
        origin: { draw() {}, onEvent: () => null, layout() {}, requiredSize: () => ({ width: 0, height: 0 }), takeFocus: () => true } as never,
      },
      () => {},
      () => {},
      { termCols: 80, termRows: 24, shadow: { theme: CATPPUCCIN_MOCHA } },
    );
    const out = handle.surface.paint();
    expect(out).toContain('▓');
  });

  test('omitted shadow preserves pre-adoption paint', () => {
    const handle = buildContextMenuPopup(
      {
        items: [{ value: 'open', label: 'Open' }],
        anchorRow: 10,
        anchorCol: 10,
        origin: { draw() {}, onEvent: () => null, layout() {}, requiredSize: () => ({ width: 0, height: 0 }), takeFocus: () => true } as never,
      },
      () => {},
      () => {},
      { termCols: 80, termRows: 24 },
    );
    const out = handle.surface.paint();
    expect(out).not.toContain('▓');
  });

  test('theme option styles menu content even without shadow', () => {
    const req = {
      items: [
        { value: 'open', label: 'Open' },
        { value: 'copy', label: 'Copy' },
      ],
      anchorRow: 10,
      anchorCol: 10,
      origin: { draw() {}, onEvent: () => null, layout() {}, requiredSize: () => ({ width: 0, height: 0 }), takeFocus: () => true } as never,
    };
    const plain = buildContextMenuPopup(req, () => {}, () => {}, {
      termCols: 80,
      termRows: 24,
    }).surface.paint();
    const themed = buildContextMenuPopup(req, () => {}, () => {}, {
      termCols: 80,
      termRows: 24,
      theme: CATPPUCCIN_MOCHA,
    }).surface.paint();
    expect(themed).not.toBe(plain);
    expect(themed).not.toContain('▓');
  });
});

describe('createDefaultMenuPresenter getTheme integration', () => {
  function mkPresenter(getTheme: (() => typeof CATPPUCCIN_MOCHA | null) | undefined) {
    const pushed: ModalSurface[] = [];
    return {
      pushed,
      presenter: createDefaultMenuPresenter({
        termSize: () => ({ rows: 24, cols: 80 }),
        pushSurface: s => {
          pushed.push(s);
          return {
            dispose: () => {
              const i = pushed.indexOf(s);
              if (i >= 0) pushed.splice(i, 1);
            },
          };
        },
        getTheme,
      }),
    };
  }

  const menu: Menu = {
    items: [
      { kind: 'command', id: 'a', label: 'Alpha' },
      { kind: 'command', id: 'b', label: 'Beta' },
    ],
  };

  test('getTheme provided → mounted surface paints ▓ band', () => {
    const { pushed, presenter } = mkPresenter(() => CATPPUCCIN_MOCHA);
    void presenter(menu, { x: 10, y: 10 }, {}).catch(() => {});
    expect(pushed.length).toBe(1);
    const painted = pushed[0]!.paint();
    expect(painted).toContain('▓');
  });

  test('getTheme undefined → no shadow (backward compat)', () => {
    const { pushed, presenter } = mkPresenter(undefined);
    void presenter(menu, { x: 10, y: 10 }, {}).catch(() => {});
    expect(pushed.length).toBe(1);
    const painted = pushed[0]!.paint();
    expect(painted).not.toContain('▓');
  });

  test('getTheme returns null → no shadow', () => {
    const { pushed, presenter } = mkPresenter(() => null);
    void presenter(menu, { x: 10, y: 10 }, {}).catch(() => {});
    expect(pushed.length).toBe(1);
    expect(pushed[0]!.paint()).not.toContain('▓');
  });

  test('getTheme throws → presenter swallows + no shadow', () => {
    const { pushed, presenter } = mkPresenter(() => { throw new Error('boom'); });
    void presenter(menu, { x: 10, y: 10 }, {}).catch(() => {});
    expect(pushed.length).toBe(1);
    expect(pushed[0]!.paint()).not.toContain('▓');
  });

  test('different themes produce different menu paint', () => {
    const mocha = mkPresenter(() => CATPPUCCIN_MOCHA);
    void mocha.presenter(menu, { x: 10, y: 10 }, {}).catch(() => {});
    const latte = mkPresenter(() => CATPPUCCIN_LATTE);
    void latte.presenter(menu, { x: 10, y: 10 }, {}).catch(() => {});
    expect(mocha.pushed.length).toBe(1);
    expect(latte.pushed.length).toBe(1);
    expect(mocha.pushed[0]!.paint()).not.toBe(latte.pushed[0]!.paint());
  });
});
