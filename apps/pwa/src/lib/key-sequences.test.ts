// WT-X-1 — key sequence builder unit tests.
//
// Pin the exact byte output for every (key, modifier) combo against
// the xterm/VT220 reference. Regressions here would silently break
// vim navigation / shell history on iPad.

import { describe, expect, test } from 'bun:test';
import {
  buildKeySequence,
  isModifierToggleKey,
  NO_MODIFIERS,
  type ModifierKey,
} from './key-sequences';

describe('buildKeySequence — plain (no modifiers)', () => {
  test('Esc → 0x1b', () => {
    expect(buildKeySequence('esc')).toBe('\x1b');
    expect(buildKeySequence('esc', NO_MODIFIERS)).toBe('\x1b');
  });

  test('Tab → 0x09', () => {
    expect(buildKeySequence('tab')).toBe('\x09');
  });

  test('Up arrow → ESC [ A', () => {
    expect(buildKeySequence('up')).toBe('\x1b[A');
  });

  test('Down arrow → ESC [ B', () => {
    expect(buildKeySequence('down')).toBe('\x1b[B');
  });

  test('Right arrow → ESC [ C', () => {
    expect(buildKeySequence('right')).toBe('\x1b[C');
  });

  test('Left arrow → ESC [ D', () => {
    expect(buildKeySequence('left')).toBe('\x1b[D');
  });

  test('Page Up and Page Down → VT sequences', () => {
    expect(buildKeySequence('pageup')).toBe('\x1b[5~');
    expect(buildKeySequence('pagedown')).toBe('\x1b[6~');
  });
});

describe('buildKeySequence — with Ctrl', () => {
  // Ctrl alone → CSI mod 5 for arrows. Esc/Tab fall back to plain
  // since Ctrl+Esc / Ctrl+Tab have no widely-supported mapping.
  test('Ctrl+Esc → plain Esc (no standard mapping)', () => {
    expect(buildKeySequence('esc', { ctrl: true, alt: false })).toBe('\x1b');
  });

  test('Ctrl+Tab → plain Tab (no standard mapping)', () => {
    expect(buildKeySequence('tab', { ctrl: true, alt: false })).toBe('\x09');
  });

  test('Ctrl+Up → ESC [ 1 ; 5 A', () => {
    expect(buildKeySequence('up', { ctrl: true, alt: false })).toBe('\x1b[1;5A');
  });

  test('Ctrl+Down → ESC [ 1 ; 5 B', () => {
    expect(buildKeySequence('down', { ctrl: true, alt: false })).toBe('\x1b[1;5B');
  });

  test('Ctrl+Right → ESC [ 1 ; 5 C (next-word in shell)', () => {
    expect(buildKeySequence('right', { ctrl: true, alt: false })).toBe('\x1b[1;5C');
  });

  test('Ctrl+Left → ESC [ 1 ; 5 D (prev-word in shell)', () => {
    expect(buildKeySequence('left', { ctrl: true, alt: false })).toBe('\x1b[1;5D');
  });
});

describe('buildKeySequence — with Alt', () => {
  test('Alt+Esc → ESC ESC', () => {
    expect(buildKeySequence('esc', { ctrl: false, alt: true })).toBe('\x1b\x1b');
  });

  test('Alt+Tab → ESC + Tab', () => {
    expect(buildKeySequence('tab', { ctrl: false, alt: true })).toBe('\x1b\x09');
  });

  test('Alt+Up → ESC [ 1 ; 3 A', () => {
    expect(buildKeySequence('up', { ctrl: false, alt: true })).toBe('\x1b[1;3A');
  });

  test('Alt+Down → ESC [ 1 ; 3 B', () => {
    expect(buildKeySequence('down', { ctrl: false, alt: true })).toBe('\x1b[1;3B');
  });

  test('Alt+Right → ESC [ 1 ; 3 C', () => {
    expect(buildKeySequence('right', { ctrl: false, alt: true })).toBe('\x1b[1;3C');
  });

  test('Alt+Left → ESC [ 1 ; 3 D', () => {
    expect(buildKeySequence('left', { ctrl: false, alt: true })).toBe('\x1b[1;3D');
  });
});

describe('buildKeySequence — with Ctrl+Alt', () => {
  test('Ctrl+Alt+Up → ESC [ 1 ; 7 A (xterm mod=1+2+4=7)', () => {
    expect(buildKeySequence('up', { ctrl: true, alt: true })).toBe('\x1b[1;7A');
  });

  test('Ctrl+Alt+Right → ESC [ 1 ; 7 C', () => {
    expect(buildKeySequence('right', { ctrl: true, alt: true })).toBe('\x1b[1;7C');
  });

  test('Ctrl+Alt+Esc → ESC ESC (Alt wins; Ctrl ignored on Esc)', () => {
    expect(buildKeySequence('esc', { ctrl: true, alt: true })).toBe('\x1b\x1b');
  });
});

test('Page keys retain CSI Ctrl/Alt modifiers', () => {
  expect(buildKeySequence('pageup', { ctrl: true, alt: false })).toBe('\x1b[5;5~');
  expect(buildKeySequence('pagedown', { ctrl: false, alt: true })).toBe('\x1b[6;3~');
});

describe('isModifierToggleKey', () => {
  test('ctrl + alt are toggles', () => {
    expect(isModifierToggleKey('ctrl')).toBe(true);
    expect(isModifierToggleKey('alt')).toBe(true);
  });

  test('nav keys are not toggles', () => {
    const navs: ModifierKey[] = ['esc', 'tab', 'up', 'down', 'left', 'right'];
    for (const k of navs) {
      expect(isModifierToggleKey(k)).toBe(false);
    }
  });

  test('unknown strings are not toggles', () => {
    expect(isModifierToggleKey('shift')).toBe(false);
    expect(isModifierToggleKey('')).toBe(false);
  });
});

describe('CSI modifier number derivation', () => {
  // Indirect verification — buildKeySequence is the only consumer.
  // mod = 1 + (alt?2:0) + (ctrl?4:0) for the Shift-omitted v1 set.
  test('no modifiers → bare CSI form (no mod number)', () => {
    expect(buildKeySequence('up')).toBe('\x1b[A');
    expect(buildKeySequence('up')).not.toContain(';1');
  });

  test('Ctrl alone = mod 5 (1 + 4)', () => {
    expect(buildKeySequence('up', { ctrl: true, alt: false })).toContain(';5');
  });

  test('Alt alone = mod 3 (1 + 2)', () => {
    expect(buildKeySequence('up', { ctrl: false, alt: true })).toContain(';3');
  });

  test('Ctrl+Alt = mod 7 (1 + 2 + 4)', () => {
    expect(buildKeySequence('up', { ctrl: true, alt: true })).toContain(';7');
  });
});
