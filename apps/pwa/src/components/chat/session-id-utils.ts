/** Shared session ID formatting and clipboard behavior. Kept leaf-level so
 *  SessionIdChip does not need to import the SessionPill component module. */
/** Copy `value` to clipboard. Returns true on success — false on
 *  permission/insecure-context failure. */
export async function copyToClipboard(value: string): Promise<boolean> {
  if (!value) return false;
  if (typeof navigator === 'undefined' || !navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

/** Truncate sessionId to the first 8 chars + ellipsis when longer than 8;
 *  return the original short ID or the empty placeholder otherwise. */
export function shortSessionId(sid: string | null | undefined): string {
  if (!sid) return '—';
  if (sid.length <= 8) return sid;
  return `${sid.slice(0, 8)}…`;
}
