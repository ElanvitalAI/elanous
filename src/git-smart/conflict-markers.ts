/** Preserve each caller's historical conflict-marker contract. */
export function hasConflictMarkers(text: string): boolean {
  return /^<{7} |^={7}$|^>{7} |^\|{7} /m.test(text);
}

/** The ladder accepts a bare marker but does not reject a separator on its own. */
export function hasLadderConflictMarkers(text: string): boolean {
  return /^(<{7}|>{7}|\|{7})( |$)/m.test(text);
}
