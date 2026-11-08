// ── Presentation P3 · encodeWidgetTree (DeclarativeWidgetNode[] → JSON) ──
//
// Reverse of `decodeWidgetTree`. Produces a declarative tree suitable
// for `toJSON` round-trip + persistence (user config files · LLM
// scratchpads). Output shape always wraps in `{ layout: [...] }` for
// parser-agnostic consumption.

import { buildWidgetSpec, type DeclarativeWidgetNode } from './builder.js';
import {
  encodeWidgetSpecs,
  encodeWidgetSpecsYAML,
  type EncodedTree,
} from './encode-specs.js';

export type { EncodedNode, EncodedTree } from './encode-specs.js';

/** Encode a flat list of declarative widget nodes into a tree. The
 *  `layout` wrapper keeps the shape stable (array wrapper would be
 *  legal too but `layout` matches the canonical input shape). */
export function encodeWidgetTree(widgets: readonly DeclarativeWidgetNode[]): EncodedTree {
  return encodeWidgetSpecs(widgets.map(buildWidgetSpec));
}

/** Encode + YAML serialize. Uses the project's `yaml` dependency. */
export async function encodeWidgetTreeYAML(widgets: readonly DeclarativeWidgetNode[]): Promise<string> {
  return encodeWidgetSpecsYAML(widgets.map(buildWidgetSpec));
}
