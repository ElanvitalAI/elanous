// TUI-ANSWER-VANISH-ON-TOOLCALL — the pre-tool streamed text a tool round pulled off the live
// screen, recovered at settle from the live preview and the per-call offsets the tool events
// recorded (entry.ts). The real wire clears a tool round with an empty chunk (llm.ts
// clearVisibleAssistantTextForToolRound → chat.ts drops the full flag), never a replace frame,
// so the replace-path holder (turn.ts onHeldAnswer) never fires on the real wire: the pre-tool
// lines live only in the preview until settle hands them to the screen holder.
//
// Pure on purpose: unit tests drive the real frame sequence (plain delta → tool event → empty
// chunk → settle) through these two inputs and assert the held segment.

/** The held pre-tool text for a settled turn, or null when nothing shown before the first tool
 *  should survive (no streamed text, or a PEM-blocked segment — same guards as turn.ts). */
export function heldPreToolText(
  streamPreview: { sessionId: string; text: string } | null | undefined,
  toolTextOffsets: ReadonlyMap<string, number>,
): string | null {
  if (!streamPreview) return null;
  // The first tool's start offset bounds the pre-tool segment (multi-tool turns hold the first
  // segment only — the holder's existing design limit); no tools means the whole preview.
  const firstToolStart = toolTextOffsets.size > 0 ? Math.min(...toolTextOffsets.values()) : streamPreview.text.length;
  const preTool = streamPreview.text.slice(0, firstToolStart);
  if (preTool.trim() === '' || preTool.toUpperCase().includes('-----BEGIN')) return null;
  return preTool;
}