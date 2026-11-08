// Low-level encoder for built widget specs. Kept independent of builder.ts
// so builders can serialize their own output without creating an import cycle.
import { encodeWidgetStyleSpec, type WidgetSpec } from './spec.js';

export interface EncodedNode {
  readonly widget: string;
  readonly id?: string;
  readonly character?: string;
  readonly config?: Record<string, unknown>;
  readonly style?: Record<string, unknown>;
  readonly chrome?: Record<string, unknown>;
  readonly motion?: Record<string, unknown>;
  readonly interactions?: Record<string, unknown>;
  readonly children?: readonly EncodedNode[];
}

export interface EncodedTree {
  readonly layout: readonly EncodedNode[];
}

function encodeNode(spec: WidgetSpec): EncodedNode {
  const style = encodeWidgetStyleSpec(
    spec.style ?? (spec.decoration ? { decoration: spec.decoration } : undefined),
  );
  return {
    widget: spec.type,
    ...(spec.id ? { id: spec.id } : {}),
    ...(spec.character ? { character: spec.character } : {}),
    ...(spec.config ? { config: spec.config } : {}),
    ...(style ? { style } : {}),
    ...(spec.chrome ? { chrome: spec.chrome as unknown as Record<string, unknown> } : {}),
    ...(spec.motion ? { motion: spec.motion as unknown as Record<string, unknown> } : {}),
    ...(spec.interactions ? { interactions: spec.interactions as unknown as Record<string, unknown> } : {}),
    ...(spec.children && spec.children.length > 0
      ? { children: spec.children.map(encodeNode) }
      : {}),
  };
}

/** Encode built specs into the stable layout wrapper used for persistence. */
export function encodeWidgetSpecs(widgets: readonly WidgetSpec[]): EncodedTree {
  return { layout: widgets.map(encodeNode) };
}

/** Encode built specs and serialize the resulting tree as YAML. */
export async function encodeWidgetSpecsYAML(widgets: readonly WidgetSpec[]): Promise<string> {
  const tree = encodeWidgetSpecs(widgets);
  const mod = await import('yaml');
  const stringify =
    mod.stringify ?? (mod as unknown as { default: { stringify(v: unknown): string } }).default?.stringify;
  return stringify(tree);
}
