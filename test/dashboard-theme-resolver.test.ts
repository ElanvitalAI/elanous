// FU G (IDX-6) — dashboard-theme-resolver tests.
//
// Pure unit tests for the preset + plugin + fallback resolution path
// currentThemeTokens() now delegates to. Keeps dashboard.ts out of
// the test surface.

import { describe, expect, test } from 'bun:test';
import {
  resolveActiveTheme,
  setActivePresetInConfig,
  type PluginThemeLoader,
} from '../src/dashboard/render/theme-resolver.js';
import {
  CATPPUCCIN_LATTE,
  CATPPUCCIN_MOCHA,
  ELANOUS_PASTEL_DEFAULT,
  NORD_LIGHT,
  ROSE_PINE_DAWN,
} from '../src/themes/index.js';
import { DEFAULT_THEME_TOKENS, type ThemeTokens } from '../src/theme/tokens.js';

describe('FU G resolveActiveTheme — preset branch', () => {
  test('active name matches a registered preset — returns preset tokens', () => {
    const t = resolveActiveTheme({ raw: { active: 'rose-pine-dawn' } });
    expect(t.name).toBe(ROSE_PINE_DAWN.name);
    expect(t.widgetTokens).toBeDefined();
    expect(t.isPastel).toBe(true);
  });

  test('active name as bare string (legacy config shape) resolves preset', () => {
    const t = resolveActiveTheme({ raw: 'nord-light' });
    expect(t.name).toBe(NORD_LIGHT.name);
  });

  test('preset lookup is case-sensitive (matches registry exactly)', () => {
    // Unknown case should NOT match — falls through to default.
    const t = resolveActiveTheme({ raw: { active: 'ROSE-PINE-DAWN' } });
    expect(t.name).toBe(DEFAULT_THEME_TOKENS.name);
  });

  test('active=default falls through to DEFAULT_THEME_TOKENS', () => {
    const t = resolveActiveTheme({ raw: { active: 'default' } });
    expect(t.name).toBe(DEFAULT_THEME_TOKENS.name);
  });

  test('preset merges on top with user-supplied token overrides', () => {
    const t = resolveActiveTheme({
      raw: {
        active: 'catppuccin-latte',
        tokens: {
          colors: { accent: '#ff0000' }, // user override
        },
      },
    });
    expect(t.name).toBe(CATPPUCCIN_LATTE.name);
    expect(t.colors.accent).toBe('#ff0000');
    // Other Latte fields preserved.
    expect(t.colors.success).toBe(CATPPUCCIN_LATTE.colors.success);
  });
});

describe('FU G resolveActiveTheme — plugin branch', () => {
  test('plugin-contributed theme when name is not a preset', () => {
    const pluginTheme: ThemeTokens = {
      ...DEFAULT_THEME_TOKENS,
      name: 'plugin:test.acme',
      colors: { ...DEFAULT_THEME_TOKENS.colors, accent: '#abcdef' },
    };
    const loadPlugin: PluginThemeLoader = (id) =>
      id === 'plugin:test.acme' ? pluginTheme : null;
    const t = resolveActiveTheme({
      raw: { active: 'plugin:test.acme' },
      loadPlugin,
    });
    expect(t.colors.accent).toBe('#abcdef');
  });

  test('reports plugin theme application with token count and source', () => {
    const events: Array<{ id: string; tokensCount: number; source: string }> = [];
    const t = resolveActiveTheme({
      raw: { active: 'plugin:test.acme' },
      loadPlugin: () => ({ colors: { accent: '#abcdef', success: '#123456' } }),
      onPluginApplied: (event) => events.push(event),
    });

    expect(t.colors.accent).toBe('#abcdef');
    expect(events).toEqual([
      { id: 'plugin:test.acme', tokensCount: 2, source: 'plugin' },
    ]);
  });

  test('does not report plugin application on preset or failed plugin paths', () => {
    const events: unknown[] = [];
    resolveActiveTheme({
      raw: { active: 'rose-pine-dawn' },
      loadPlugin: () => ({ colors: { accent: '#abcdef' } }),
      onPluginApplied: (event) => events.push(event),
    });
    resolveActiveTheme({
      raw: { active: 'plugin:broken' },
      loadPlugin: () => { throw new Error('load failed'); },
      onPluginApplied: (event) => events.push(event),
    });
    expect(events).toEqual([]);
  });

  test('observation callback failure does not discard the applied plugin theme', () => {
    let reportedError: string | null = null;
    const t = resolveActiveTheme({
      raw: { active: 'plugin:test.acme' },
      loadPlugin: () => ({ colors: { accent: '#abcdef' } }),
      onPluginApplied: () => { throw new Error('log unavailable'); },
      onPluginError: (message) => { reportedError = message; },
    });

    expect(t.colors.accent).toBe('#abcdef');
    expect(reportedError).toBeNull();
  });

  test('preset wins over plugin when both would match', () => {
    const sneakyPlugin: PluginThemeLoader = () => ({
      ...DEFAULT_THEME_TOKENS,
      name: 'sneaky',
      colors: { ...DEFAULT_THEME_TOKENS.colors, accent: '#000000' },
    });
    // Use a registered preset name — it must win.
    const t = resolveActiveTheme({
      raw: { active: 'rose-pine-dawn' },
      loadPlugin: sneakyPlugin,
    });
    expect(t.name).toBe(ROSE_PINE_DAWN.name);
  });

  test('plugin load throwing is caught + reported', () => {
    let reported: string | null = null;
    const brokenPlugin: PluginThemeLoader = () => {
      throw new Error('load failed');
    };
    const t = resolveActiveTheme({
      raw: { active: 'plugin:broken' },
      loadPlugin: brokenPlugin,
      onPluginError: (m) => {
        reported = m;
      },
    });
    expect(reported).toContain('load failed');
    // Falls through to default.
    expect(t.name).toBe(DEFAULT_THEME_TOKENS.name);
  });

  test('plugin loader absent — skips plugin branch gracefully', () => {
    const t = resolveActiveTheme({ raw: { active: 'plugin:missing' } });
    // No preset match + no plugin loader → fallthrough to default.
    expect(t.name).toBe(DEFAULT_THEME_TOKENS.name);
  });
});

describe('FU G resolveActiveTheme — fallback branch', () => {
  test('null raw returns DEFAULT_THEME_TOKENS', () => {
    const t = resolveActiveTheme({ raw: null });
    expect(t.name).toBe(DEFAULT_THEME_TOKENS.name);
  });

  test('malformed raw (array) returns DEFAULT_THEME_TOKENS', () => {
    const t = resolveActiveTheme({ raw: [] });
    expect(t.name).toBe(DEFAULT_THEME_TOKENS.name);
  });

  test('direct token override without active name', () => {
    const t = resolveActiveTheme({
      raw: { colors: { accent: '#111111' } },
    });
    expect(t.colors.accent).toBe('#111111');
    expect(t.name).toBe(DEFAULT_THEME_TOKENS.name);
  });

  test('wrapper tokens form { active, tokens } without known preset', () => {
    const t = resolveActiveTheme({
      raw: {
        active: 'unknown-theme',
        tokens: { colors: { accent: '#222222' } },
      },
    });
    expect(t.colors.accent).toBe('#222222');
  });
});

describe('FU G resolveActiveTheme — cross-preset differentiation', () => {
  test('each preset resolves to its own distinct tokens', () => {
    const pairs: Array<[string, ThemeTokens]> = [
      ['catppuccin-mocha', CATPPUCCIN_MOCHA],
      ['catppuccin-latte', CATPPUCCIN_LATTE],
      ['rose-pine-dawn', ROSE_PINE_DAWN],
      ['nord-light', NORD_LIGHT],
      ['elanous-pastel-default', ELANOUS_PASTEL_DEFAULT],
    ];
    for (const [name, expected] of pairs) {
      const t = resolveActiveTheme({ raw: { active: name } });
      expect(t.name).toBe(expected.name);
      expect(t.colors.accent).toBe(expected.colors.accent);
      expect(t.isDark).toBe(expected.isDark);
    }
  });
});

describe('FU G setActivePresetInConfig', () => {
  test('preserves existing overrides while updating active', () => {
    const out = setActivePresetInConfig(
      { active: 'old', tokens: { colors: { accent: '#abcdef' } } },
      'rose-pine-dawn',
    );
    expect(out.active).toBe('rose-pine-dawn');
    expect(out.tokens).toEqual({ colors: { accent: '#abcdef' } });
  });

  test('accepts null current and produces a fresh object', () => {
    const out = setActivePresetInConfig(null, 'nord-light');
    expect(out).toEqual({ active: 'nord-light' });
  });

  test('ignores array raw (treats as empty)', () => {
    const out = setActivePresetInConfig([], 'catppuccin-latte');
    expect(out.active).toBe('catppuccin-latte');
  });

  test('overwrites existing active', () => {
    const out = setActivePresetInConfig(
      { active: 'elanous-pastel-default' },
      'catppuccin-mocha',
    );
    expect(out.active).toBe('catppuccin-mocha');
  });
});

describe('FU G resolveActiveTheme — round-trip via setActivePresetInConfig', () => {
  test('switching between presets flips accent color', () => {
    let cfg: unknown = null;
    cfg = setActivePresetInConfig(cfg, 'rose-pine-dawn');
    expect(resolveActiveTheme({ raw: cfg }).colors.accent).toBe(
      ROSE_PINE_DAWN.colors.accent,
    );
    cfg = setActivePresetInConfig(cfg, 'nord-light');
    expect(resolveActiveTheme({ raw: cfg }).colors.accent).toBe(
      NORD_LIGHT.colors.accent,
    );
    cfg = setActivePresetInConfig(cfg, 'elanous-pastel-default');
    expect(resolveActiveTheme({ raw: cfg }).colors.accent).toBe(
      ELANOUS_PASTEL_DEFAULT.colors.accent,
    );
  });
});
