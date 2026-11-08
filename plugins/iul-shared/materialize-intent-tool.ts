import type { LLMToolSpec } from '../../src/llm/tool-spec.js';
// ── MaterializeFromIntent LLM tool (IUL Phase L · Bundle 4W) ──
//
// Expose the generic materialize() pipeline as an LLM tool. An LLM
// receives a user's natural-language intent ("show me a compact heap
// usage indicator"), picks a widget type from the live widget-host
// registry, and the runtime spawns the widget.
//
// Design notes:
//   - Pure function surface — no side effects outside `deps.spawnWidget`.
//   - Provider resolution happens per-dispatch (via `deps.getProvider`)
//     so mid-session API-key swaps + model changes take effect.
//   - Catalog is pulled from `deps.listWidgetTypes()` per-dispatch so
//     plugin activate/deactivate surfaces the latest widget set.
//   - `dryRun: true` returns the WidgetSpec without spawning — useful
//     for preview UX or cost-free LLM evaluations.

import type { LLMProvider } from '../../src/llm.js';
import type { WidgetInstance, WidgetTypeInfo } from '../../src/widgets/types.js';
import {
  buildGenericSystemPrompt,
  materialize,
  type CatalogEntry,
} from './index.js';

export interface MaterializeIntentDeps {
  /** Per-dispatch provider resolver. Tool cannot function without a
   *  live provider — dispatcher throws on `!provider.available()`. */
  getProvider: () => LLMProvider;
  /** Live widget registry snapshot. Called per-dispatch so the tool
   *  sees the latest registry state (plugin activate/deactivate). */
  listWidgetTypes: () => readonly WidgetTypeInfo[];
  /** Optional: spawn the materialized widget via the host. Absent →
   *  tool returns spec only; caller handles placement. */
  spawnWidget?: (opts: {
    type: string;
    character?: string;
    config?: Record<string, unknown>;
  }) => WidgetInstance | undefined;
  /** Widget types the LLM must never pick (e.g. scenario plugins
   *  like 'iul-canvas' that only make sense as input surfaces).
   *  Default empty. */
  defaultSkipTypes?: readonly string[];
}

export interface MaterializeIntentArgs {
  intent: string;
  /** Optional whitelist. When provided, catalog is the intersection of
   *  `listWidgetTypes()` (minus `defaultSkipTypes`) and this list. */
  catalog?: string[];
  /** Optional LLM model override (e.g. specific Haiku snapshot). */
  model?: string;
  /** When true, return the parsed spec without spawning. Default false. */
  dryRun?: boolean;
}

export interface MaterializeIntentOut {
  widgetType: string;
  character?: string;
  reason: string;
  confidence: number;
  spawned: boolean;
  widgetId?: string;
}

export function buildMaterializeFromIntentTool(): LLMToolSpec {
  return {
    name: 'MaterializeFromIntent',
    description:
      'Spawn a widget that matches a natural-language intent. The LLM picks a widget '
      + 'type from the live registry (via listWidgetTypes), returns a WidgetSpec, and '
      + 'the runtime spawns it via WidgetHost. Use dryRun:true to preview the spec '
      + 'without spawning.',
    parameters: {
      type: 'object',
      properties: {
        intent: {
          type: 'string',
          description:
            'Natural-language description of what the user wants to see '
            + '(e.g. "show me a compact heap usage indicator").',
        },
        catalog: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional widget type whitelist. Defaults to every registered type, '
            + 'excluding scenario plugins like iul-canvas.',
        },
        model: {
          type: 'string',
          description:
            'Optional LLM model override (e.g. claude-haiku-4-5-20251001).',
        },
        dryRun: {
          type: 'boolean',
          description:
            'When true, return the spec without spawning the widget. Default false.',
        },
      },
      required: ['intent'],
    },
  };
}

/** Dispatch MaterializeFromIntent. Throws with a specific message on
 *  missing intent, provider unavailable, empty catalog, parse / catalog
 *  mismatch failures, or spawn failure — caller maps to tool error. */
export async function dispatchMaterializeFromIntent(
  raw: Record<string, unknown>,
  deps: MaterializeIntentDeps,
): Promise<MaterializeIntentOut> {
  const args = parseArgs(raw);
  const provider = deps.getProvider();
  if (!provider.available()) {
    throw new Error(
      `MaterializeFromIntent: LLM provider "${provider.name}" not available — `
      + 'set API key first',
    );
  }

  const catalog = resolveCatalog(args.catalog, deps);
  if (catalog.length === 0) {
    throw new Error(
      'MaterializeFromIntent: catalog is empty '
      + '(no widget types available after applying filters)',
    );
  }

  const spec = await materialize({
    systemPrompt: buildGenericSystemPrompt({
      catalog,
      intentSource: "the user's natural-language intent",
    }),
    userContent: `Intent:\n${args.intent}`,
    catalog,
    provider,
    ...(args.model !== undefined ? { model: args.model } : {}),
  });

  const base = {
    widgetType: spec.widgetType,
    reason: spec.reason,
    confidence: spec.confidence,
    ...(spec.character !== undefined ? { character: spec.character } : {}),
  };

  if (args.dryRun || !deps.spawnWidget) {
    return { ...base, spawned: false };
  }

  let instance: WidgetInstance | undefined;
  try {
    instance = deps.spawnWidget({
      type: spec.widgetType,
      ...(spec.character !== undefined ? { character: spec.character } : {}),
      ...(spec.config !== undefined ? { config: spec.config } : {}),
    });
  } catch (err) {
    throw new Error(
      `MaterializeFromIntent: spawnWidget("${spec.widgetType}") failed — `
      + `${(err as Error).message}`,
    );
  }
  if (!instance) {
    throw new Error(
      `MaterializeFromIntent: spawnWidget("${spec.widgetType}") returned no instance`,
    );
  }
  return { ...base, spawned: true, widgetId: instance.id };
}

function parseArgs(raw: Record<string, unknown>): MaterializeIntentArgs {
  const intent = raw.intent;
  if (typeof intent !== 'string' || intent.trim().length === 0) {
    throw new Error(
      'MaterializeFromIntent: intent is required (non-empty string)',
    );
  }
  const catalog = Array.isArray(raw.catalog)
    ? raw.catalog.filter((x): x is string => typeof x === 'string')
    : undefined;
  const model = typeof raw.model === 'string' ? raw.model : undefined;
  const dryRun = typeof raw.dryRun === 'boolean' ? raw.dryRun : false;
  return {
    intent,
    ...(catalog !== undefined ? { catalog } : {}),
    ...(model !== undefined ? { model } : {}),
    dryRun,
  };
}

function resolveCatalog(
  filter: readonly string[] | undefined,
  deps: MaterializeIntentDeps,
): CatalogEntry[] {
  const all = deps.listWidgetTypes();
  const skip = new Set(deps.defaultSkipTypes ?? []);
  const allowed = filter !== undefined ? new Set(filter) : undefined;
  return all
    .filter((info) => !skip.has(info.type))
    .filter((info) => allowed === undefined || allowed.has(info.type))
    .map((info) => ({ type: info.type, description: info.description }));
}
