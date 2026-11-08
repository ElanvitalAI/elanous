import type { LLMToolSpec } from '../../llm/tool-spec.js';
// IDX-6 Phase 7 / FU J — LLM theme control tools.
//
// Exposes the ThemeService surface to the LLM so PFC / TO / other
// upstream callers can inspect + mutate the visual palette
// programmatically. Complements the user-facing `/theme` slash
// commands (FU D + FU G) with a structured tool API.
//
// Four tools land in this commit:
//   1. GetActiveTheme   — snapshot of the current theme (read)
//   2. ListThemes       — registered preset metadata (read)
//   3. SwitchTheme      — apply a preset (write, audited)
//   4. PreviewTheme     — sample snippet rendered in a given preset
//                         without applying (read, cheap)
//
// Each tool produces BOTH an LLMToolSpec (provider-wire) and a
// LLMToolDef (host-side dispatcher with handler). Callers wire them
// together at the registration layer so the provider sees the
// schema and the host routes results back to the LLM turn loop.
//
// Safety:
//   - SwitchTheme rejects unknown names.
//   - An optional onAudit callback records every SwitchTheme call
//     — the dashboard passes its audit-log sink here.
//   - GetActiveTheme + ListThemes + PreviewTheme are read-only,
//     no audit needed.


import type { LLMToolDef } from '../../plugins/core/types.js';
import type { ThemeService } from '../../theme/service.js';
import type { ThemeTokens } from '../../theme/tokens.js';
import { paintPair, resolveSemantic, resolveWidgetTokens } from '../../theme/tokens.js';
import { getTheme, listThemes, THEME_REGISTRY } from '../../themes/index.js';

export interface ThemeAuditEvent {
  tool:
    | 'GetActiveTheme'
    | 'ListThemes'
    | 'SwitchTheme'
    | 'PreviewTheme';
  args: Record<string, unknown>;
  result: 'ok' | 'rejected';
  previousTheme?: string;
  newTheme?: string;
  rejectionReason?: string;
  timestamp: number;
}

export interface ThemeControlToolsOptions {
  service: ThemeService;
  /** Audit sink — receives one event per tool invocation. When
   *  absent, calls are silent (no-op). Dashboard passes its
   *  control-audit-log sink here. */
  onAudit?: (event: ThemeAuditEvent) => void;
}

// ── LLMToolSpec factories (provider wire-format) ────────────────

export function buildGetActiveThemeTool(): LLMToolSpec {
  return {
    name: 'GetActiveTheme',
    description:
      'Return the currently active dashboard theme as a JSON snapshot ' +
      '{name, isDark, isPastel}. Read-only; does not change UI.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  };
}

export function buildListThemesTool(): LLMToolSpec {
  return {
    name: 'ListThemes',
    description:
      'List all registered theme presets (name + isDark + isPastel). ' +
      'Use this before SwitchTheme to discover valid preset names.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  };
}

export function buildSwitchThemeTool(): LLMToolSpec {
  return {
    name: 'SwitchTheme',
    description:
      'Switch the active dashboard theme to a registered preset. ' +
      'Call ListThemes first if the user has not specified a preset name. ' +
      'Returns {ok, previousTheme, newTheme} on success or {ok:false, reason} on rejection.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'Preset name (e.g. "catppuccin-mocha", "catppuccin-latte", "rose-pine-dawn").',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  };
}

export function buildPreviewThemeTool(): LLMToolSpec {
  return {
    name: 'PreviewTheme',
    description:
      'Render a small sample (button label, progress bar, status badge) ' +
      'in the named preset without applying it. Use to show the user how ' +
      'a preset looks before calling SwitchTheme. Returns {ok, sample:{...}}.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Preset name to preview.',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  };
}

// ── LLMToolDef handlers (host-side dispatch) ────────────────────

export function buildThemeHostTools(opts: ThemeControlToolsOptions): LLMToolDef[] {
  const { service } = opts;
  const audit = opts.onAudit ?? (() => {});

  const getActive: LLMToolDef = {
    name: 'GetActiveTheme',
    description: buildGetActiveThemeTool().description,
    parameters: buildGetActiveThemeTool().parameters,
    handler: async () => {
      const snapshot = service.snapshot;
      audit({
        tool: 'GetActiveTheme',
        args: {},
        result: 'ok',
        newTheme: snapshot.name,
        timestamp: Date.now(),
      });
      return snapshot;
    },
  };

  const list: LLMToolDef = {
    name: 'ListThemes',
    description: buildListThemesTool().description,
    parameters: buildListThemesTool().parameters,
    handler: async () => {
      const themes = listThemes();
      audit({
        tool: 'ListThemes',
        args: {},
        result: 'ok',
        timestamp: Date.now(),
      });
      return { themes };
    },
  };

  const switchTool: LLMToolDef = {
    name: 'SwitchTheme',
    description: buildSwitchThemeTool().description,
    parameters: buildSwitchThemeTool().parameters,
    handler: async (args: Record<string, unknown>) => {
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      const previous = service.current.name;
      if (!name) {
        audit({
          tool: 'SwitchTheme',
          args,
          result: 'rejected',
          previousTheme: previous,
          rejectionReason: 'missing name',
          timestamp: Date.now(),
        });
        return {
          ok: false,
          reason:
            "'name' argument is required. Call ListThemes to see valid preset names.",
        };
      }
      const ok = await service.switch(name);
      if (!ok) {
        audit({
          tool: 'SwitchTheme',
          args,
          result: 'rejected',
          previousTheme: previous,
          rejectionReason: 'unknown preset',
          timestamp: Date.now(),
        });
        return {
          ok: false,
          reason: `Theme '${name}' is not a registered preset. Call ListThemes to see valid names.`,
        };
      }
      audit({
        tool: 'SwitchTheme',
        args,
        result: 'ok',
        previousTheme: previous,
        newTheme: service.current.name,
        timestamp: Date.now(),
      });
      return {
        ok: true,
        previousTheme: previous,
        newTheme: service.current.name,
      };
    },
  };

  const preview: LLMToolDef = {
    name: 'PreviewTheme',
    description: buildPreviewThemeTool().description,
    parameters: buildPreviewThemeTool().parameters,
    handler: async (args: Record<string, unknown>) => {
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      if (!name) {
        audit({
          tool: 'PreviewTheme',
          args,
          result: 'rejected',
          rejectionReason: 'missing name',
          timestamp: Date.now(),
        });
        return { ok: false, reason: "'name' argument is required." };
      }
      const theme = getTheme(name);
      if (!theme) {
        audit({
          tool: 'PreviewTheme',
          args,
          result: 'rejected',
          rejectionReason: 'unknown preset',
          timestamp: Date.now(),
        });
        return {
          ok: false,
          reason: `Theme '${name}' is not a registered preset. Call ListThemes to see valid names.`,
        };
      }
      audit({
        tool: 'PreviewTheme',
        args,
        result: 'ok',
        newTheme: theme.name,
        timestamp: Date.now(),
      });
      return { ok: true, sample: buildThemeSample(theme) };
    },
  };

  return [getActive, list, switchTool, preview];
}

/** Small deterministic sample the LLM can show the user as a
 *  "what would this theme look like?" preview. Each entry is a
 *  self-contained snippet of ANSI output the LLM can forward. */
export function buildThemeSample(theme: ThemeTokens): {
  themeName: string;
  isDark: boolean;
  isPastel: boolean;
  button: string;
  progressBarDone: string;
  progressBarError: string;
  statusBadgeRunning: string;
  statusBadgeError: string;
  paneTitleActive: string;
} {
  const buttonFocused = resolveWidgetTokens(theme, 'button').focused ?? {
    fg: theme.colors.text,
  };
  const pt = resolveWidgetTokens(theme, 'paneTitle');
  const crit = resolveSemantic(theme, 'critical');
  const succ = resolveSemantic(theme, 'success');
  const info = resolveSemantic(theme, 'info');
  const muted = resolveSemantic(theme, 'muted');

  return {
    themeName: theme.name,
    isDark: theme.isDark ?? false,
    isPastel: theme.isPastel ?? false,
    button: paintPair(buttonFocused)('[ Focused Button ]'),
    progressBarDone:
      paintPair(succ)('██████████') + paintPair(muted)('····'),
    progressBarError:
      paintPair(crit)('████') + paintPair(muted)('··········'),
    statusBadgeRunning: paintPair(info)('🟢 Running'),
    statusBadgeError: paintPair(crit)('❌ Error'),
    paneTitleActive: paintPair(pt.active)('━ Pane title ━'),
  };
}

/** Convenience — fetch every registered preset's sample at once.
 *  Useful for LLM "compare all themes" scenarios. */
export function buildAllThemeSamples(): Array<
  ReturnType<typeof buildThemeSample>
> {
  return THEME_REGISTRY.map((t) => buildThemeSample(t));
}
