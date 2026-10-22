// IDX-6 FU G — dashboard theme resolution with preset support.
//
// Before this helper, dashboard.ts's currentThemeTokens() supported:
//   1. plugin-contributed themes (pluginHost.loadThemeTokens(id))
//   2. direct token override via user-config
//
// FU G adds a third (and higher-priority) branch: if the active name
// matches a registered ThemeTokens preset from src/themes/, use that
// preset's full hierarchical tokens as the base, merged on top with
// any user overrides. This lets `/theme switch rose-pine-dawn` just
// write `{active: 'rose-pine-dawn'}` into user-config and the next
// requestDashboardRender picks up the full pastel palette.
//
// Resolution order (first match wins):
//   1. Preset by name (src/themes/ registry)
//   2. Plugin-contributed theme (via loadPlugin callback)
//   3. Direct token override (resolveThemeTokens fallback)
//
// Kept in its own file so the logic is unit-testable without
// booting the dashboard.

import {
  DEFAULT_THEME_TOKENS,
  mergeThemeTokens,
  resolveThemeTokens,
  type ThemeTokenInput,
  type ThemeTokens,
} from '../../theme/tokens.js';
import { getTheme } from '../../themes/index.js';

// Plugin loaders contribute *partial* token overrides (merged on top of
// DEFAULT_THEME_TOKENS below), so the return is a ThemeTokenInput — the
// same shape `pluginHost.loadThemeTokens` produces — not a full ThemeTokens.
export type PluginThemeLoader = (id: string) => ThemeTokenInput | null | undefined;

export interface PluginThemeAppliedEvent {
  id: string;
  tokensCount: number;
  source: 'plugin';
}

export interface ResolveActiveThemeOptions {
  /** Raw `dashboard.theme` value from user-config. Shape is flexible:
   *  `null` | `string` | `{ active: string, ... }` | `{ tokens: {...} }`. */
  raw: unknown;
  /** Plugin theme loader — typically `pluginHost?.loadThemeTokens`.
   *  Absent = plugin branch skipped. */
  loadPlugin?: PluginThemeLoader;
  /** Callback invoked when a plugin load throws. Errors are swallowed
   *  (so a broken plugin doesn't crash the dashboard) but reported
   *  here for visibility. */
  onPluginError?: (message: string) => void;
  /** Called after plugin tokens have been merged into the resolved theme. */
  onPluginApplied?: (event: PluginThemeAppliedEvent) => void;
}

/** Resolve the active dashboard theme from user-config, with preset
 *  + plugin + default fallback layers. Pure function — no I/O. */
export function resolveActiveTheme(opts: ResolveActiveThemeOptions): ThemeTokens {
  const { raw, loadPlugin, onPluginError, onPluginApplied } = opts;

  // Extract active name + user overrides from the raw user-config
  // value. The config shape evolved over time — handle all known
  // forms defensively.
  const activeName = getActiveThemeName(raw);
  const rawOverrides: ThemeTokenInput | undefined = extractOverrides(raw);

  // Branch 1: preset registry hit.
  if (activeName) {
    const preset = getTheme(activeName);
    if (preset) {
      return rawOverrides ? mergeThemeTokens(preset, rawOverrides) : preset;
    }
  }

  // Branch 2: plugin-contributed theme.
  if (activeName && loadPlugin) {
    try {
      const contributed = loadPlugin(activeName);
      if (contributed) {
        const resolved = mergeThemeTokens(
          mergeThemeTokens(DEFAULT_THEME_TOKENS, contributed),
          rawOverrides ?? {},
        );
        try {
          onPluginApplied?.({
            id: activeName,
            tokensCount: countTokenLeaves(contributed),
            source: 'plugin',
          });
        } catch {
          // Observation failures must not discard an already-resolved theme.
        }
        return resolved;
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : String(err ?? 'unknown error');
      onPluginError?.(`Theme load failed: ${message}`);
    }
  }

  // Branch 3: direct token override / default fallback.
  return resolveThemeTokens(raw);
}

function countTokenLeaves(value: unknown, isRoot = true): number {
  if (value === null || value === undefined) return 0;
  if (typeof value !== 'object') return 1;
  if (Array.isArray(value)) {
    return value.reduce((count, item) => count + countTokenLeaves(item, false), 0);
  }
  return Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !isRoot || key !== 'name')
    .reduce((count, [, item]) => count + countTokenLeaves(item, false), 0);
}

export function getActiveThemeName(raw: unknown): string | null {
  if (typeof raw === 'string') return raw.trim() || null;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const active = (raw as Record<string, unknown>).active;
    if (typeof active === 'string' && active.trim()) return active.trim();
  }
  return null;
}

function extractOverrides(raw: unknown): ThemeTokenInput | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  // Wrapper form { active, tokens } — overrides come from .tokens.
  if (obj.tokens && typeof obj.tokens === 'object' && !Array.isArray(obj.tokens)) {
    return obj.tokens as ThemeTokenInput;
  }
  // Direct form — treat the whole object (minus `active`) as overrides.
  // But only if it has any of the known ThemeTokenInput top-level keys
  // so we don't accidentally adopt unrelated fields.
  const knownKeys = new Set(['name', 'colors', 'pane', 'modal', 'cursor', 'widget']);
  const hasKnownKey = Object.keys(obj).some((k) => knownKeys.has(k));
  if (hasKnownKey) return obj as ThemeTokenInput;
  return undefined;
}

/** Write a preset switch back into a user-config `dashboard.theme`
 *  shape, preserving any existing token overrides. Returns the new
 *  value the caller should assign to `cfg.dashboard.theme`. */
export function setActivePresetInConfig(
  currentRaw: unknown,
  presetName: string,
): Record<string, unknown> {
  const base =
    currentRaw && typeof currentRaw === 'object' && !Array.isArray(currentRaw)
      ? { ...(currentRaw as Record<string, unknown>) }
      : {};
  base.active = presetName;
  return base;
}
