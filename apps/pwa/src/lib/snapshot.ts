/**
 * Surface snapshot helper (chat input · scroll position ·
 * xterm scrollback).
 *
 * The helper stores small localStorage snapshots so remounts can restore
 * user-visible context (draft text, scroll position, terminal scrollback).
 *
 * Key 형식: `elanous.pwa.snapshot.<surface>.<id>` — `surface` 는
 * `chatInput` | `chatScroll` | `xtermScrollback`; terminal surfaces may
 * provide an id, while chat uses the 'singleton' key.
 *
 * Persistence policy:
 * - per-entry cap 256 KB (xterm serialize buffer 최대 케이스 cover).
 *   초과 시 silent drop (snapshot 가치 < UI hang 방지).
 * - 글로벌 cleanup 은 BACKLOG follow-up — 현재는 key collision 없이
 *   기존 키 그대로 유지. 사용자 device storage 압박 시 발생할 수 있는
 *   문제는 dogfood 후 follow-up.
 */

const KEY_PREFIX = 'elanous.pwa.snapshot.';
const MAX_ENTRY_BYTES = 256 * 1024;

export type SnapshotSurface = 'chatInput' | 'chatScroll' | 'xtermScrollback';

export function snapshotKey(surface: SnapshotSurface, id?: string): string {
  return `${KEY_PREFIX}${surface}.${id && id.length > 0 ? id : 'singleton'}`;
}

function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadSnapshot<T>(key: string): T | null {
  const ls = getStorage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch {
    try { ls.removeItem(key); } catch { /* ignore quota errors */ }
    return null;
  }
}

export function saveSnapshot<T>(key: string, value: T): void {
  const ls = getStorage();
  if (!ls) return;
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return;
  }
  if (serialized.length > MAX_ENTRY_BYTES) return;
  try {
    ls.setItem(key, serialized);
  } catch {
    /* quota exceeded — drop snapshot rather than throwing */
  }
}

export function clearSnapshot(key: string): void {
  const ls = getStorage();
  if (!ls) return;
  try { ls.removeItem(key); } catch { /* ignore */ }
}

/** Test seam: exposed limit for size-cap assertions. */
export const __INTERNAL_MAX_BYTES = MAX_ENTRY_BYTES;
