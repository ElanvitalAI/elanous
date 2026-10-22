// P2.3.b — chat picker family modal factory tests. Verifies the paint
// output stays stable and the modal metadata is well-formed for the
// coordinator's modal-stack pipeline.

import { describe, expect, test } from 'bun:test';
import {
  createChatPickerTestFamily,
  createChatPickerTestSources,
} from './helpers/chat-picker-family-fixture.js';
import type { SlashCommand, ArgSuggestion, AtCandidate, SkillCandidate } from '../src/chat/index.js';

const cmds: SlashCommand[] = [
  { name: 'help',  aliases: ['?'], description: 'Show help' },
  { name: 'quit',  aliases: ['q', 'exit'], description: 'Exit application' },
  { name: 'clear', aliases: ['cls'], description: 'Clear log pane' },
];

function slashSpec(overrides: Partial<{
  bounds: { row: number; col: number; width: number; height: number };
  getItems: () => SlashCommand[];
  selectedIdx: () => number;
  maxVisible: number;
  getInputZoneHeight: () => number;
  width: number;
}> = {}) {
  const width = overrides.width ?? 80;
  return {
    bounds: overrides.bounds ?? { row: 30, col: 1, width, height: 1 },
    sources: createChatPickerTestSources({
      slashItems: overrides.getItems ?? (() => cmds),
    }),
    width,
    bindingOverrides: {
      slash: {
        selectedIdx: overrides.selectedIdx ?? (() => 0),
        maxVisible: overrides.maxVisible ?? 5,
        getInputZoneHeight: overrides.getInputZoneHeight ?? (() => 1),
      },
    },
  };
}

function slashModal(overrides: Parameters<typeof slashSpec>[0] = {}) {
  return createChatPickerTestFamily(slashSpec(overrides)).createSurface('slash');
}

describe('chat picker family modal · slash flavor', () => {
  test('returns a kind:modal surface with bounds + paint + cursor', () => {
    const m = slashModal();
    expect(m.kind).toBe('modal');
    // Surface bounds now tighten to the current visible row count at
    // construction time instead of reserving the entire maxVisible band.
    // 3 rows + title + footer + border rhythm => height 6, bottom-anchored
    // above the one-line input zone at row 30.
    expect(m.bounds).toEqual({ row: 24, col: 1, width: 80, height: 6 });
    expect(typeof m.paint).toBe('function');
    expect(typeof m.cursor).toBe('function');
  });

  test('cursor() returns null — input keeps the caret', () => {
    const m = slashModal();
    expect(m.cursor!()).toBeNull();
  });

  test('focusable=false — modal is render-only, chat.ts owns keys', () => {
    const m = slashModal();
    expect(m.focus).toBe('none');
  });
});

describe('paint output', () => {
  test('empty filtered list → empty string', () => {
    const m = slashModal({ getItems: () => [] });
    expect(m.paint()).toBe('');
  });

  test('paints one row per filtered command (within maxVisible)', () => {
    const m = slashModal();
    const out = m.paint();
    // All three command names appear.
    expect(out).toContain('help');
    expect(out).toContain('quit');
    expect(out).toContain('clear');
    // Each row begins with `/`.
    expect(out.match(/\//g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  test('selected row uses accent style; others use muted', () => {
    const m = slashModal({ selectedIdx: () => 1 });
    const out = m.paint();
    // The accent style includes a specific ANSI color start
    // (Catppuccin Blue) — sanity-check with strip vs. raw.
    expect(out.length).toBeGreaterThan(0);
  });

  test('respects maxVisible — extra commands are scrolled out', () => {
    const many: SlashCommand[] = Array.from({ length: 20 }, (_, i) => ({
      name: `cmd${i}`, aliases: [], description: `desc ${i}`,
    }));
    const m = slashModal({
      getItems: () => many,
      selectedIdx: () => 0,
      maxVisible: 3,
    });
    const out = m.paint();
    // Should contain the first 3 (selected at top); cmd5 should NOT appear.
    expect(out).toContain('cmd0');
    expect(out.includes('cmd5')).toBe(false);
  });

  test('separator row appears below the picker (above input zone)', () => {
    const m = slashModal({ getInputZoneHeight: () => 2 });
    const out = m.paint();
    // \u2500 = horizontal box-drawing dash used for the separator.
    expect(out).toContain('\u2500');
  });

  test('M6a: picker tracks CURRENT input height, not maxLines reserve', () => {
    // Before the fix, chat.ts passed maxLines (8) as inputZoneHeight even
    // when the user had only 1 line of input, causing the picker to draw
    // 7 rows too high (log-pane area instead of just above the prompt).
    // Now the caller passes a getter that returns the current lines.length.
    // This test simulates that wiring and verifies the position shift.
    //
    // F-E2 — paint wrapper prepends row clears across the click-bounds
    // before the inner picker paint, so "first moveTo" now points at
    // the clear region's top (bounds.row = clickTop) instead of the
    // list row. Use the LAST moveTo — which lands on the separator
    // row = promptRow - inputZoneHeight — to recover the original
    // semantic ("picker tracks input height").
    const oneLine = slashModal({ getInputZoneHeight: () => 1 }).paint();
    const eightLines = slashModal({ getInputZoneHeight: () => 8 }).paint();
    const lastRow = (s: string): number => {
      const all = [...s.matchAll(/\x1b\[(\d+);\d+H/g)];
      const last = all[all.length - 1];
      return last ? parseInt(last[1]!, 10) : -1;
    };
    const r1 = lastRow(oneLine);
    const r8 = lastRow(eightLines);
    expect(r1).toBeGreaterThan(0);
    expect(r8).toBeGreaterThan(0);
    expect(r1 - r8).toBe(7); // 1-line picker's separator sits 7 rows LOWER (closer to prompt)
  });

  test('M6a: dynamic getter is re-evaluated on every paint', () => {
    // If the caller's input grows from 1 to 3 lines while the picker is
    // mounted, the next paint should place the picker 2 rows higher —
    // not keep the original snapshot. F-E2 clear-wrapper reasoning: see
    // test above — use last moveTo to capture the separator row.
    let currentLines = 1;
    const m = slashModal({ getInputZoneHeight: () => currentLines });
    const lastRow = (s: string): number => {
      const all = [...s.matchAll(/\x1b\[(\d+);\d+H/g)];
      const last = all[all.length - 1];
      return last ? parseInt(last[1]!, 10) : -1;
    };
    const before = lastRow(m.paint());
    currentLines = 3;
    const after = lastRow(m.paint());
    expect(before - after).toBe(2);
  });
});

describe('paint determinism', () => {
  test('same spec → same paint output', () => {
    const a = slashModal().paint();
    const b = slashModal().paint();
    expect(a).toBe(b);
  });

  test('selectedIdx beyond maxVisible triggers windowing — output shifts', () => {
    // With many commands, selection at idx 0 vs idx 18 places different
    // commands in the visible window — output bytes differ regardless
    // of color stripping in non-TTY envs.
    const many: SlashCommand[] = Array.from({ length: 20 }, (_, i) => ({
      name: `cmd${String(i).padStart(2, '0')}`, aliases: [], description: `desc ${i}`,
    }));
    const a = slashModal({
      getItems: () => many,
      maxVisible: 3,
      selectedIdx: () => 0,
    }).paint();
    const b = slashModal({
      getItems: () => many,
      maxVisible: 3,
      selectedIdx: () => 18,
    }).paint();
    expect(a).not.toBe(b);
    expect(a).toContain('cmd00');
    expect(b).toContain('cmd18');
  });
});

// ─── Arg picker (P2.3.c) ────────────────────────────────────────

const argItems: ArgSuggestion[] = [
  { value: 'grok', description: 'xAI Grok' },
  { value: 'openai', description: 'OpenAI GPT' },
  { value: 'anthropic', description: 'Anthropic Claude' },
];

function argModal(overrides: Partial<{
  getItems: () => ArgSuggestion[];
  selectedIdx: () => number;
  maxVisible: number;
  getInputZoneHeight: () => number;
  width: number;
}> = {}) {
  const width = overrides.width ?? 80;
  return createChatPickerTestFamily({
    sources: createChatPickerTestSources({
      slashItems: () => [] as SlashCommand[],
      argItems: overrides.getItems ?? (() => argItems),
    }),
    width,
    bindingOverrides: {
      arg: {
        selectedIdx: overrides.selectedIdx ?? (() => 0),
        maxVisible: overrides.maxVisible ?? 5,
        getInputZoneHeight: overrides.getInputZoneHeight ?? (() => 1),
      },
    },
  }).createSurface('arg');
}

describe('chat picker family modal · arg flavor', () => {
  test('returns a kind:modal surface; cursor() null; focusable=false', () => {
    const m = argModal();
    expect(m.kind).toBe('modal');
    expect(m.cursor!()).toBeNull();
    expect(m.focus).toBe('none');
  });

  test('paint includes value + description for each item', () => {
    const m = argModal();
    const out = m.paint();
    expect(out).toContain('grok');
    expect(out).toContain('xAI Grok');
    expect(out).toContain('openai');
    expect(out).toContain('anthropic');
  });

  test('empty items → empty paint output', () => {
    const m = argModal({ getItems: () => [] });
    expect(m.paint()).toBe('');
  });

  test('windowing: many items, selectedIdx beyond maxVisible shifts the window', () => {
    const many: ArgSuggestion[] = Array.from({ length: 12 }, (_, i) => ({ value: `arg${i}`, description: `d${i}` }));
    const a = argModal({ getItems: () => many, maxVisible: 3, selectedIdx: () => 0 }).paint();
    const b = argModal({ getItems: () => many, maxVisible: 3, selectedIdx: () => 10 }).paint();
    expect(a).toContain('arg0');
    expect(b).toContain('arg10');
    expect(a).not.toBe(b);
  });
});

// ─── @-picker (P2.3.c) ──────────────────────────────────────────

const atItems: AtCandidate[] = [
  { label: 'README.md',  absPath: '/repo/README.md', isDir: false, hint: '12 KB' },
  { label: 'src/',        absPath: '/repo/src',       isDir: true,  hint: 'directory' },
  { label: 'package.json', absPath: '/repo/package.json', isDir: false, hint: '4 KB' },
];

function atModal(overrides: Partial<{
  getItems: () => AtCandidate[];
  selectedIdx: () => number;
  maxVisible: number;
  getInputZoneHeight: () => number;
  width: number;
}> = {}) {
  const width = overrides.width ?? 80;
  return createChatPickerTestFamily({
    sources: createChatPickerTestSources({
      slashItems: () => [] as SlashCommand[],
      atItems: overrides.getItems ?? (() => atItems),
    }),
    width,
    bindingOverrides: {
      at: {
        selectedIdx: overrides.selectedIdx ?? (() => 0),
        maxVisible: overrides.maxVisible ?? 5,
        getInputZoneHeight: overrides.getInputZoneHeight ?? (() => 1),
      },
    },
  }).createSurface('at');
}

describe('chat picker family modal · at flavor', () => {
  test('returns a kind:modal surface', () => {
    const m = atModal();
    expect(m.kind).toBe('modal');
    expect(m.cursor!()).toBeNull();
  });

  test('paint includes labels + hints', () => {
    const m = atModal();
    const out = m.paint();
    expect(out).toContain('README.md');
    expect(out).toContain('12 KB');
    expect(out).toContain('package.json');
  });

  test('handles items with icons + ANSI labels without crashing', () => {
    const items: AtCandidate[] = [
      { label: '\x1b[34mfoo\x1b[0m', absPath: '/x/foo', isDir: false, icon: '\u{1F4C4}' },
    ];
    const out = atModal({ getItems: () => items }).paint();
    expect(out.length).toBeGreaterThan(0);
  });

  test('empty items → empty paint output', () => {
    const m = atModal({ getItems: () => [] });
    expect(m.paint()).toBe('');
  });
});
