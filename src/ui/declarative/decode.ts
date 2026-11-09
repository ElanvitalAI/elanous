import { isObject } from '../../primitives/guards.js';
// ── Presentation P3 · decodeWidgetTree (JSON/YAML → WidgetSpec[]) ──
//
// Accepts a declarative tree and produces a flat list of WidgetSpec
// records consumable by `WidgetHost.spawn` + optional decoration
// rendering. Recursive shape supports nested children (P3b consumer).
//
// Input shapes accepted:
//
//   // Flat single widget
//   { widget: 'log', config: { lines: ['hi'] } }
//
//   // Top-level array
//   [{ widget: 'log', config: {...} }, { widget: 'list', config: {...} }]
//
//   // Layout wrapper
//   { layout: [{ widget: 'log', ... }, { widget: 'list', ... }] }
//
//   // Nested children
//   {
//     widget: 'container',
//     style: { decoration: { color: 'surface', border: {...} } },
//     children: [{ widget: 'log', ... }]
//   }
//
// Output shape:
//
//   interface WidgetSpec {
//     type: string;
//     id?: string;
//     config?: Record<string, unknown>;
//     decoration?: BoxDecoration;
//     children?: WidgetSpec[];   // preserved for consumers that nest
//   }
//
// Validation: per-node config is validated against the registered
// widget schema (if any). Errors are aggregated and returned alongside
// the partial tree so the LLM caller can fix + retry.

import { getWidgetSchema, type WidgetSchemaEntry } from './schema.js';
import { ensureBuiltinDeclarativeViewSchemasRegistered } from './builtin-view-schemas.js';
import { buildWidgetLabPreset, getWidgetLabPreset } from './presets.js';
import {
  decodeWidgetChromeSpec,
  decodeWidgetInteractionSpec,
  decodeWidgetMotionSpec,
  decodeWidgetStyleSpec,
  widgetChromeSchema,
  widgetInteractionSchema,
  widgetMotionSchema,
  widgetStyleSchema,
  type WidgetSpec,
} from './spec.js';
import { validateJSON, type ValidationError } from './validate.js';

export interface DecodeOptions {
  /** When `true`, decode proceeds even if validation errors exist ·
   *  partial tree is returned. When `false` (default), the first
   *  validation error short-circuits decode and `spec` is empty. */
  readonly lax?: boolean;
}

export interface DecodeResult {
  readonly ok: boolean;
  readonly widgets: readonly WidgetSpec[];
  readonly errors: readonly ValidationError[];
}

type RawNode =
  | {
      preset?: string;
      widget?: string;
      type?: string;
      id?: string;
      character?: string;
      config?: unknown;
      style?: unknown;
      chrome?: unknown;
      motion?: unknown;
      interactions?: unknown;
      children?: unknown;
    }
  | unknown;

type RawRoot =
  | { preset?: unknown }
  | { layout?: unknown; widgets?: unknown }
  | RawNode[]
  | RawNode;

/** Normalize the root-level shape into a flat node array · empty array
 *  when the shape is unrecognizable. */
function collectRoots(root: RawRoot): RawNode[] {
  if (Array.isArray(root)) return root;
  if (!isObject(root)) return [];
  if (Array.isArray((root as { layout?: unknown }).layout)) {
    return (root as { layout: unknown[] }).layout;
  }
  if (Array.isArray((root as { widgets?: unknown }).widgets)) {
    return (root as { widgets: unknown[] }).widgets;
  }
  // Treat the root as a single node when it looks like one.
  if (
    'widget' in (root as Record<string, unknown>)
    || 'type' in (root as Record<string, unknown>)
    || 'preset' in (root as Record<string, unknown>)
  ) {
    return [root];
  }
  return [];
}

/** Decode a single node recursively. Errors accumulate into `errors`
 *  with dotted paths rooted at the current node path. Returns `null`
 *  when the node is unusable (missing type) — caller decides whether
 *  to continue. */
function decodeNode(
  node: RawNode,
  path: string,
  errors: ValidationError[],
): WidgetSpec | null {
  if (!isObject(node)) {
    errors.push({ path, message: 'expected object node' });
    return null;
  }
  let presetBase: WidgetSpec | null = null;
  if (typeof node.preset === 'string') {
    const preset = getWidgetLabPreset(node.preset);
    if (!preset) {
      errors.push({ path: `${path}.preset`, message: `unknown widget lab preset "${node.preset}"` });
      return null;
    }
    const widgets = buildWidgetLabPreset(node.preset);
    if (widgets.length !== 1) {
      errors.push({ path: `${path}.preset`, message: `widget preset "${node.preset}" expands to ${widgets.length} widgets; node-level preset requires exactly one` });
      return null;
    }
    presetBase = widgets[0] ?? null;
  }

  const typeField = ((node.widget ?? node.type) as string | undefined) ?? presetBase?.type;
  if (!typeField || typeof typeField !== 'string') {
    errors.push({ path, message: 'missing `widget` or `type` string' });
    return null;
  }

  const entry: WidgetSchemaEntry = getWidgetSchema(typeField);
  const configPatch = isObject(node.config) ? node.config : undefined;
  const config = presetBase?.config || configPatch
    ? { ...(presetBase?.config ?? {}), ...(configPatch ?? {}) }
    : undefined;
  if (config !== undefined) {
    const result = validateJSON(config, entry.configSchema);
    for (const err of result.errors) {
      errors.push({
        path: `${path}.config${err.path.startsWith('$') ? err.path.slice(1) : err.path}`,
        message: err.message,
      });
    }
  }

  const style = isObject(node.style) ? node.style : undefined;
  if (style) {
    const result = validateJSON(style, widgetStyleSchema);
    for (const err of result.errors) {
      errors.push({
        path: `${path}.style${err.path.startsWith('$') ? err.path.slice(1) : err.path}`,
        message: err.message,
      });
    }
  }
  const chrome = isObject(node.chrome) ? node.chrome : undefined;
  if (chrome) {
    const result = validateJSON(chrome, widgetChromeSchema);
    for (const err of result.errors) {
      errors.push({
        path: `${path}.chrome${err.path.startsWith('$') ? err.path.slice(1) : err.path}`,
        message: err.message,
      });
    }
  }
  const motion = isObject(node.motion) ? node.motion : undefined;
  if (motion) {
    const result = validateJSON(motion, widgetMotionSchema);
    for (const err of result.errors) {
      errors.push({
        path: `${path}.motion${err.path.startsWith('$') ? err.path.slice(1) : err.path}`,
        message: err.message,
      });
    }
  }
  const interactions = isObject(node.interactions) ? node.interactions : undefined;
  if (interactions) {
    const result = validateJSON(interactions, widgetInteractionSchema);
    for (const err of result.errors) {
      errors.push({
        path: `${path}.interactions${err.path.startsWith('$') ? err.path.slice(1) : err.path}`,
        message: err.message,
      });
    }
  }
  if (node.character !== undefined && typeof node.character !== 'string') {
    errors.push({ path: `${path}.character`, message: 'expected string' });
  }

  const decodedStyle = decodeWidgetStyleSpec(style);
  const mergedStyle = presetBase?.style || decodedStyle
    ? {
        ...(presetBase?.style ?? {}),
        ...(decodedStyle ?? {}),
        ...(presetBase?.style?.states || decodedStyle?.states
          ? {
              states: {
                ...(presetBase?.style?.states ?? {}),
                ...(decodedStyle?.states ?? {}),
              },
            }
          : {}),
        ...(presetBase?.style?.tokens || decodedStyle?.tokens
          ? {
              tokens: {
                ...(presetBase?.style?.tokens ?? {}),
                ...(decodedStyle?.tokens ?? {}),
              },
            }
          : {}),
      }
    : undefined;
  const decoration = decodedStyle?.decoration ?? presetBase?.decoration;
  const decodedChrome = decodeWidgetChromeSpec(chrome);
  const mergedChrome = presetBase?.chrome || decodedChrome
    ? { ...(presetBase?.chrome ?? {}), ...(decodedChrome ?? {}) }
    : undefined;
  const decodedMotion = decodeWidgetMotionSpec(motion);
  const mergedMotion = presetBase?.motion || decodedMotion
    ? {
        ...(presetBase?.motion ?? {}),
        ...(decodedMotion ?? {}),
        ...(presetBase?.motion?.enter || decodedMotion?.enter
          ? { enter: { ...(presetBase?.motion?.enter ?? {}), ...(decodedMotion?.enter ?? {}) } }
          : {}),
        ...(presetBase?.motion?.exit || decodedMotion?.exit
          ? { exit: { ...(presetBase?.motion?.exit ?? {}), ...(decodedMotion?.exit ?? {}) } }
          : {}),
        ...(presetBase?.motion?.hover || decodedMotion?.hover
          ? { hover: { ...(presetBase?.motion?.hover ?? {}), ...(decodedMotion?.hover ?? {}) } }
          : {}),
        ...(presetBase?.motion?.focus || decodedMotion?.focus
          ? { focus: { ...(presetBase?.motion?.focus ?? {}), ...(decodedMotion?.focus ?? {}) } }
          : {}),
      }
    : undefined;
  const decodedInteractions = decodeWidgetInteractionSpec(interactions);
  const mergedInteractions = presetBase?.interactions || decodedInteractions
    ? {
        ...(presetBase?.interactions ?? {}),
        ...(decodedInteractions ?? {}),
        ...(presetBase?.interactions?.key || decodedInteractions?.key
          ? { key: [...(presetBase?.interactions?.key ?? []), ...(decodedInteractions?.key ?? [])] }
          : {}),
      }
    : undefined;

  // Children (recursive · nested layout)
  let children: WidgetSpec[] | undefined;
  if (Array.isArray(node.children)) {
    const collected: WidgetSpec[] = [];
    node.children.forEach((child, i) => {
      const sub = decodeNode(child, `${path}.children[${i}]`, errors);
      if (sub) collected.push(sub);
    });
    if (collected.length > 0) children = collected;
  }
  else if (presetBase?.children) {
    children = [...presetBase.children];
  }

  return {
    type: typeField,
    ...((typeof node.id === 'string' ? node.id : presetBase?.id) ? { id: typeof node.id === 'string' ? node.id : presetBase?.id } : {}),
    ...((typeof node.character === 'string' ? node.character : presetBase?.character) ? { character: typeof node.character === 'string' ? node.character : presetBase?.character } : {}),
    ...(config ? { config } : {}),
    ...(decoration ? { decoration } : {}),
    ...(mergedStyle ? { style: mergedStyle } : {}),
    ...(mergedChrome ? { chrome: mergedChrome } : {}),
    ...(mergedMotion ? { motion: mergedMotion } : {}),
    ...(mergedInteractions ? { interactions: mergedInteractions } : {}),
    ...(children ? { children } : {}),
  };
}

/** Decode a declarative widget tree. Accepts object or array forms ·
 *  returns flat top-level WidgetSpec[] (nested children preserved on
 *  each spec). Validation failures return `ok: false` with partial
 *  results unless `lax: false` (default) short-circuits. */
export function decodeWidgetTree(
  root: RawRoot,
  options: DecodeOptions = {},
): DecodeResult {
  ensureBuiltinDeclarativeViewSchemasRegistered();
  const errors: ValidationError[] = [];
  if (
    isObject(root)
    && typeof (root as { preset?: unknown }).preset === 'string'
    && !('widget' in root)
    && !('type' in root)
    && !('id' in root)
    && !('character' in root)
    && !('config' in root)
    && !('style' in root)
    && !('chrome' in root)
    && !('motion' in root)
    && !('interactions' in root)
    && !('children' in root)
  ) {
    const presetId = (root as { preset: string }).preset;
    if (!getWidgetLabPreset(presetId)) {
      errors.push({ path: '$.preset', message: `unknown widget lab preset "${presetId}"` });
      return { ok: false, widgets: [], errors };
    }
    return {
      ok: true,
      widgets: [...buildWidgetLabPreset(presetId)],
      errors,
    };
  }
  const roots = collectRoots(root);
  // Empty-but-valid containers — `[]`, `{layout: []}`, `{widgets: []}` —
  // should decode cleanly as "no widgets". Only raise the unrecognized-
  // root error when the input is a plain object that has no recognizable
  // shape (e.g. `{random: 'stuff'}`).
  if (roots.length === 0 && root !== undefined) {
    const isExplicitContainer =
      Array.isArray(root) ||
      (isObject(root) && (
        Array.isArray((root as { layout?: unknown }).layout) ||
        Array.isArray((root as { widgets?: unknown }).widgets)
      ));
    if (!isExplicitContainer) {
      errors.push({ path: '$', message: 'root is neither an array nor a layout/widgets container' });
    }
  }
  const widgets: WidgetSpec[] = [];
  roots.forEach((node, i) => {
    const spec = decodeNode(node, `$[${i}]`, errors);
    if (spec) widgets.push(spec);
  });
  const ok = errors.length === 0;
  if (!ok && options.lax !== true) {
    return { ok: false, widgets: [], errors };
  }
  return { ok, widgets, errors };
}

/** Decode from a YAML string. Uses the project's `yaml` dependency
 *  (v2) when present · the import is lazy so environments without
 *  YAML installed fail loudly only at this call site. */
export async function decodeWidgetTreeYAML(
  yaml: string,
  options?: DecodeOptions,
): Promise<DecodeResult> {
  const mod = await import('yaml');
  const parsed = (mod.parse ?? (mod as unknown as { default: { parse(s: string): unknown } }).default?.parse)(yaml);
  return decodeWidgetTree(parsed as RawRoot, options);
}
