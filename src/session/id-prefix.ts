// Shortest session-id prefix that still names exactly one session (TUI-RESUME-PICKER).
// Lists used to cut every id to 8 characters, so two sessions sharing those 8 looked the same and
// `/session load <shown prefix>` failed as ambiguous. `resolveSessionId` searches the whole index,
// so uniqueness is measured against every id there — not only the rows on screen.
import { listSessions } from './index.js';

/** Never shorter than this, so short lists keep the familiar 8-character look. */
export const SESSION_ID_PREFIX_MIN = 8;

function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

/**
 * For each id in `ids`, the shortest prefix (≥ `min`) that no other id in `universe` starts with.
 * An id that is itself a prefix of another id gets the whole id (resolveSessionId takes an exact match).
 */
export function uniqueIdPrefixes(ids: readonly string[], universe: readonly string[], min = SESSION_ID_PREFIX_MIN): Map<string, string> {
  const sorted = [...new Set([...universe, ...ids])].sort();
  const position = new Map(sorted.map((id, i) => [id, i]));
  const out = new Map<string, string>();
  for (const id of ids) {
    if (out.has(id)) continue;
    const i = position.get(id)!;
    // In sorted order the longest shared prefix is always with a direct neighbour.
    const shared = Math.max(
      i > 0 ? commonPrefixLength(id, sorted[i - 1]!) : 0,
      i + 1 < sorted.length ? commonPrefixLength(id, sorted[i + 1]!) : 0,
    );
    out.set(id, id.slice(0, Math.min(id.length, Math.max(min, shared + 1))));
  }
  return out;
}

/** `uniqueIdPrefixes` against every session in the store (the set `/session load` resolves in). */
export function sessionIdPrefixes(ids: readonly string[], root?: string): Map<string, string> {
  const universe = (root === undefined ? listSessions() : listSessions({}, root)).map((m) => m.id);
  return uniqueIdPrefixes(ids, universe);
}

/** Display helper: the unique prefix of one id, padded so a column stays aligned. */
export function idPrefixCell(prefixes: ReadonlyMap<string, string>, id: string): string {
  const width = Math.max(SESSION_ID_PREFIX_MIN, ...[...prefixes.values()].map((p) => p.length));
  return (prefixes.get(id) ?? id.slice(0, SESSION_ID_PREFIX_MIN)).padEnd(width);
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * `MM-DD HH:mm` in the viewer's local time zone. Lists used to slice the stored UTC ISO string
 * (`updatedAt.slice(5, 16)`), so a KST viewer saw 16:24 for a session touched at 01:24.
 */
export function sessionListTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(5, 16).replace('T', ' ');
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
