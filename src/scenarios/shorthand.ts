import { isObject } from '../primitives/guards.js';
// ── Presentation P5a · YAML decoration shorthand expansion ──
//
// Flutter-style `BoxDecoration` YAML would be noisy without shortcuts —
// 4 sides × color/width/style for every border, for example. This
// module rewrites Flutter-flavoured shorthand into the explicit
// BoxDecorationJSON shape that `BoxDecoration.fromJSON` expects.
//
//   border:
//     all: { color: border.focused, width: 1 }
//     # ⇓ expands to
//     top: {...}  right: {...}  bottom: {...}  left: {...}
//
//   borderRadius:
//     circular: 2
//     # ⇓ expands to
//     topLeft: 2  topRight: 2  bottomLeft: 2  bottomRight: 2
//
//   padding: 2
//     # ⇓ expands to
//     top: 2  right: 2  bottom: 2  left: 2
//
// The expander walks the tree and rewrites every `style.decoration`
// encountered. It's pure (no side effects) and returns a new object
// graph — the caller's input stays intact.

function expandBorder(raw: Record<string, unknown>): Record<string, unknown> {
  if ('all' in raw) {
    const side = raw.all;
    return { top: side, right: side, bottom: side, left: side };
  }
  if ('symmetric' in raw) {
    const s = isObject(raw.symmetric) ? raw.symmetric : {};
    const h = s.horizontal ?? null;
    const v = s.vertical ?? null;
    return { top: v, right: h, bottom: v, left: h };
  }
  if ('only' in raw && isObject(raw.only)) {
    return { ...(raw.only as Record<string, unknown>) };
  }
  // Already explicit (top/right/bottom/left) — return as-is.
  return raw;
}

function expandBorderRadius(raw: Record<string, unknown>): Record<string, unknown> {
  if ('circular' in raw) {
    const r = Number(raw.circular ?? 0);
    return { topLeft: r, topRight: r, bottomLeft: r, bottomRight: r };
  }
  if ('only' in raw && isObject(raw.only)) {
    return { ...(raw.only as Record<string, unknown>) };
  }
  return raw;
}

function expandPadding(raw: unknown): unknown {
  if (typeof raw === 'number') {
    return { top: raw, right: raw, bottom: raw, left: raw };
  }
  if (!isObject(raw)) return raw;
  if ('all' in raw) {
    const n = Number(raw.all ?? 0);
    return { top: n, right: n, bottom: n, left: n };
  }
  if ('symmetric' in raw) {
    const s = isObject(raw.symmetric) ? raw.symmetric : {};
    const h = Number(s.horizontal ?? 0);
    const v = Number(s.vertical ?? 0);
    return { top: v, right: h, bottom: v, left: h };
  }
  if ('only' in raw && isObject(raw.only)) {
    return { ...(raw.only as Record<string, unknown>) };
  }
  return raw;
}

/** Rewrite shorthand inside a single decoration object. Returns a new
 *  object · leaves unknown fields alone. */
export function expandDecorationShorthand(raw: unknown): unknown {
  if (!isObject(raw)) return raw;
  const out: Record<string, unknown> = { ...raw };
  if (isObject(out.border)) out.border = expandBorder(out.border);
  if (isObject(out.borderRadius)) out.borderRadius = expandBorderRadius(out.borderRadius);
  if ('padding' in out) out.padding = expandPadding(out.padding);
  return out;
}

/** Walk a scenario's layout tree and expand every `style.decoration`
 *  shorthand encountered. Recurses into `children`, `layout`, and
 *  `widgets` arrays. */
export function expandScenarioShorthand<T>(node: T): T {
  if (Array.isArray(node)) {
    return node.map(expandScenarioShorthand) as unknown as T;
  }
  if (!isObject(node)) return node;
  const clone: Record<string, unknown> = { ...node };
  if (isObject(clone.style)) {
    const style: Record<string, unknown> = { ...clone.style };
    if ('decoration' in style) {
      style.decoration = expandDecorationShorthand(style.decoration);
    }
    clone.style = style;
  }
  if (Array.isArray(clone.children)) {
    clone.children = clone.children.map(expandScenarioShorthand);
  }
  if (Array.isArray(clone.layout)) {
    clone.layout = clone.layout.map(expandScenarioShorthand);
  }
  if (Array.isArray(clone.widgets)) {
    clone.widgets = clone.widgets.map(expandScenarioShorthand);
  }
  return clone as T;
}
