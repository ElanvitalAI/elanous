import { isPlainObject } from '../../primitives/guards.js';
// 5-layer config merge — Layer 1 (framework defaults) → Layer 2
// (theme preset) → Layer 3 (answer file / config file) → Layer 4
// (env var override) → Layer 5 (interactive prompt). Each layer is a
// partial — fields it doesn't specify pass through from the layer
// below. The merge is a recursive deep-merge over plain objects;
// arrays + primitives replace.
//
// This module is the kernel for the answer-file / non-interactive
// path used by `elanous setup --config <file>` and CI / dotfile
// scripted setups (PLAN §1.2 Principle #2 — "layered defaults +
// opt-in override"). The priority direction is intentional: a user's
// dotfile beats the theme preset, and an environment variable beats
// the dotfile, and an interactive answer beats env. So the user
// always wins on the field they last specified.
//
// Pure functions — no I/O, no env reads. Callers (`answer-file.ts`,
// `env-bridge.ts`) provide each layer's contribution; this module
// just merges.

export type LayerSource =
  | 'defaults'         // Layer 1
  | 'theme'            // Layer 2
  | 'answer-file'      // Layer 3
  | 'env'              // Layer 4
  | 'interactive';     // Layer 5

export interface Layer<T> {
  source: LayerSource;
  value: Partial<T>;
}

/** Deep-merge a stack of layers in priority order (lowest → highest).
 *  Higher-priority entries override matching fields in lower-priority
 *  entries. Plain objects merge recursively; arrays + primitives
 *  replace. `null` from a higher layer clears the field (so a user
 *  can explicitly null out a default). */
export function mergeLayers<T extends object>(
  layers: ReadonlyArray<Layer<T>>,
): T {
  let merged: Record<string, unknown> = {};
  for (const layer of layers) {
    merged = deepMerge(merged, layer.value as Record<string, unknown>);
  }
  return merged as T;
}

/** Track per-field source — `{ field: layerSource }`. Useful for
 *  debug output (`elanous setup --explain`) so the user can see which
 *  layer set each value. Recurses into nested objects; for nested
 *  values the path becomes a dotted string in the result map. */
export function explainLayers<T extends object>(
  layers: ReadonlyArray<Layer<T>>,
): Record<string, LayerSource> {
  const sources: Record<string, LayerSource> = {};
  for (const layer of layers) {
    walkAssign(layer.value as Record<string, unknown>, '', (path) => {
      sources[path] = layer.source;
    });
  }
  return sources;
}

// ── Internals ───────────────────────────────────────────────────────

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!override || typeof override !== 'object') return base;
  const out = { ...base };
  for (const key of Object.keys(override)) {
    const next = override[key];
    if (next === undefined) continue;
    if (next === null) {
      delete out[key];
      continue;
    }
    const prev = out[key];
    if (isPlainObject(prev, false, true) && isPlainObject(next, false, true)) {
      out[key] = deepMerge(
        prev as Record<string, unknown>,
        next as Record<string, unknown>,
      );
    } else {
      out[key] = next;
    }
  }
  return out;
}

function walkAssign(
  obj: Record<string, unknown> | undefined,
  prefix: string,
  visit: (path: string) => void,
): void {
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(v, false, true)) walkAssign(v as Record<string, unknown>, path, visit);
    else visit(path);
  }
}
