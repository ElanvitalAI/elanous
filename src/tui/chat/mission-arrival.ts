// A side-tab mission can finish while another turn is running. The arrival notice must outlive turns, so it
// is kept as a transcript marker (same store as the turn-end «Worked for» rows), never in the per-turn
// `activity` buffer that each turn overwrites and clears.
export interface MissionArrivalInfo { readonly agent: string; readonly paired: boolean; readonly ok: boolean; readonly path?: string; readonly error?: string }
export type TranscriptMarkerStore = Map<string, { afterMessageIndex: number; text: string }[]>;

export function missionArrivalText(info: MissionArrivalInfo): string {
  const who = `${info.agent}${info.paired ? ' + parallel' : ''}`;
  return info.ok ? `✓ Mission result arrived · ${who}${info.path ? ` · ${info.path}` : ''}`
    : `✘ Mission failed · ${who}${info.error ? ` · ${info.error}` : ''}`;
}

/** Anchor the marker after the session's last message. False when there is no message to anchor to. */
export function addTranscriptMarker(store: TranscriptMarkerStore, sessionId: string, messageCount: number, text: string): boolean {
  if (!sessionId || messageCount <= 0) return false;
  store.set(sessionId, [...(store.get(sessionId) ?? []), { afterMessageIndex: messageCount - 1, text }]);
  return true;
}
