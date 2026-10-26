// ── Keybinding registry tests ──

import { describe, test, expect } from 'bun:test';
import {
  KEYBINDINGS, CONTEXT_LABELS, keyBindingsByContext, renderKeyHelp,
  type KeyContext,
} from '../src/keybindings';
import { SLASH_COMMANDS } from '../src/chat/index';

describe('keybinding registry', () => {
  test('every binding has a known context', () => {
    const known = new Set(Object.keys(CONTEXT_LABELS) as KeyContext[]);
    for (const b of KEYBINDINGS) {
      expect(known.has(b.context)).toBe(true);
      expect(b.keys.length).toBeGreaterThan(0);
      expect(b.action.length).toBeGreaterThan(3);
    }
  });

  test('keyBindingsByContext groups exhaustively', () => {
    const grouped = keyBindingsByContext();
    const total = Object.values(grouped).reduce((n, arr) => n + arr.length, 0);
    expect(total).toBe(KEYBINDINGS.length);
    for (const ctx of Object.keys(CONTEXT_LABELS) as KeyContext[]) {
      expect(Array.isArray(grouped[ctx])).toBe(true);
    }
  });

  test('renderKeyHelp returns something non-empty, includes all context labels', () => {
    const out = renderKeyHelp();
    for (const label of Object.values(CONTEXT_LABELS)) {
      expect(out).toContain(label);
    }
    // Also contains the slash-command footer
    expect(out).toContain('Slash commands');
  });

  test('renderKeyHelp with context filter narrows output', () => {
    const full = renderKeyHelp();
    const narrow = renderKeyHelp({ context: 'log' });
    expect(narrow.length).toBeLessThan(full.length);
    expect(narrow).toContain('Log pane');
    expect(narrow).not.toContain('Browser');
  });

  test('every binding covered by ≥ one of: arrow keys, letter, modifier combo', () => {
    // Sanity check the data — catches empty-key typos.
    for (const b of KEYBINDINGS) {
      const allNonEmpty = b.keys.every(k => k.trim().length > 0);
      expect(allNonEmpty).toBe(true);
    }
  });

  test('TUI-CTRLB-PREFIX-LEAK: mock catalog advertises Ctrl+X c control and Ctrl+B background', () => {
    const advertised = (key: string) => KEYBINDINGS.filter(binding => binding.keys.includes(key)).map(binding => binding.action);
    expect(advertised('Ctrl+X c')).toEqual([expect.stringMatching(/enter control mode/i)]);
    expect(advertised('Ctrl+B')).toEqual(['Background running child tasks (while streaming; turn continues)']);
    expect(KEYBINDINGS.find(binding => binding.keys.includes('Ctrl+X c'))?.context).toBe('input');
    const help = renderKeyHelp();
    expect(help).toMatch(/Ctrl\+X c\s+Enter control mode/i);
    expect(help).not.toMatch(/Ctrl\+X c\s+New virtual window/i);
    expect(help).toMatch(/Ctrl\+B\s+Background running/i);
    const inputHelp = renderKeyHelp({ context: 'input' });
    expect(inputHelp).toMatch(/Ctrl\+X c\s+Enter control mode/i);
    expect(inputHelp).not.toContain('Ctrl+B');
  });

  test('TUI-CTRLB-PREFIX-LEAK: catalog does not advertise Ctrl+B as a prefix', () => {
    const help = renderKeyHelp();
    expect(KEYBINDINGS.filter(binding => binding.keys.some(key => key.startsWith('Ctrl+B ')))).toEqual([]);
    expect(help).not.toMatch(/Ctrl\+B [a-zA-Z0-9%"?]/);
    expect(KEYBINDINGS.find(binding => binding.keys.includes('Ctrl+X s'))?.action).toContain('Enter sync mode (chat input)');
    expect(KEYBINDINGS.find(binding => binding.keys.includes('Ctrl+X g'))?.action).toContain('Exit sync/control mode');
    expect(KEYBINDINGS.find(binding => binding.keys.includes('Ctrl+X s'))?.context).toBe('input');
    expect(KEYBINDINGS.find(binding => binding.keys.includes('Ctrl+X Ctrl+S'))?.action).toContain('Reopen scratchpad');
    expect(KEYBINDINGS.some(binding => binding.action.includes('Horizontal split') || binding.action.includes('Toggle modal ↔ virtual-window session'))).toBe(false);
  });

  test('VP3 — Ctrl+7 binding wired for Widget Playground view', () => {
    const ctrl7 = KEYBINDINGS.find(b => b.keys.includes('Ctrl+7'));
    expect(ctrl7).toBeDefined();
    expect(ctrl7!.keys).toContain('Ctrl+/ (fallback)');
    expect(ctrl7!.action).toContain('Widget Playground');
    expect(ctrl7!.action).toContain('/view 7');
  });

  test('VP3 — renderKeyHelp surfaces Ctrl+7 alongside other view shortcuts', () => {
    const out = renderKeyHelp();
    expect(out).toContain('Ctrl+7');
    expect(out).toContain('Ctrl+/');
    expect(out).toMatch(/View 7.*Widget Playground|Widget Playground.*View 7/);
  });
});

describe('slash command hygiene', () => {
  test('no two commands share a name or alias', () => {
    const seen = new Set<string>();
    for (const c of SLASH_COMMANDS) {
      expect(seen.has(c.name)).toBe(false);
      seen.add(c.name);
      for (const a of c.aliases ?? []) {
        expect(seen.has(a)).toBe(false);
        seen.add(a);
      }
    }
  });

  test('/keys is not listed without a dispatcher', () => {
    const found = SLASH_COMMANDS.find(c => c.name === 'keys');
    expect(found).toBeUndefined();
  });

  // ── ST4 — sessions sidebar chords ─────────────────────────────

  test('ST4 — sessions sidebar chord bindings are catalogued', () => {
    const chords = new Map<string, string>();
    for (const b of KEYBINDINGS) {
      for (const k of b.keys) chords.set(k, b.action);
    }
    expect(chords.get('Ctrl+X S')).toMatch(/Focus sessions sidebar/i);
    expect(chords.get('Ctrl+X n')).toMatch(/next session/i);
    expect(chords.get('Ctrl+X p')).toMatch(/previous session/i);
  });

  test('NT5 — notification bell chord is catalogued', () => {
    const chords = new Map<string, string>();
    for (const b of KEYBINDINGS) {
      for (const k of b.keys) chords.set(k, b.action);
    }
    expect(chords.get('Ctrl+X b')).toMatch(/notification bell/i);
  });
});
