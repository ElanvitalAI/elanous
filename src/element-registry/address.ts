// Global address parse/format.
//
// Grammar:  <prefix>:<rest>   where <prefix> ∈ KIND_PREFIX values.
//
// Examples:
//   win:3                   → { kind:'window',  id:'3' }
//   pane:a1b2c3             → { kind:'pane',    id:'a1b2c3' }
//   pty:pty_0a1b2c3d        → { kind:'pty',     id:'pty_0a1b2c3d' }
//   sess:codex-1            → { kind:'session', id:'codex-1' }
//   widget:wd-log:2         → { kind:'widget',  id:'wd-log:2' }
//   tool:Bash               → { kind:'tool',    id:'Bash' }
//
// Permissive: accepts optional leading '@'. Unknown prefixes return null
// so callers can fall back to kind-specific parsers.

import { ADDR_PREFIX_TO_KIND, KIND_PREFIX, type ElementKind, type ParsedElementAddress } from './types.js';

const ADDR_RE = /^@?([a-z]+):(.+)$/i;

export function parseElementAddress(raw: string): ParsedElementAddress | null {
  const trimmed = raw.trim();
  const m = ADDR_RE.exec(trimmed);
  if (!m) return null;
  const prefix = m[1]!.toLowerCase();
  const rest = m[2]!;
  const kind = ADDR_PREFIX_TO_KIND[prefix];
  if (!kind) return null;
  if (rest.length === 0) return null;
  return { raw: trimmed, kind, id: rest };
}

export function formatElementAddress(kind: ElementKind, id: string): string {
  return `${KIND_PREFIX[kind]}:${id}`;
}

/** Does this string already start with `<kind>:` (ignoring @)? */
export function isQualifiedAddress(raw: string, kind?: ElementKind): boolean {
  const p = parseElementAddress(raw);
  if (!p) return false;
  if (kind && p.kind !== kind) return false;
  return true;
}

/** Ensure the returned string starts with `<kind>:`. Idempotent. */
export function ensureQualified(kind: ElementKind, idOrAddr: string): string {
  const p = parseElementAddress(idOrAddr);
  if (p && p.kind === kind) return p.raw.replace(/^@/, '');
  return formatElementAddress(kind, idOrAddr);
}
