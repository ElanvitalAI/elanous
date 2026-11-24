// TUI-ANSWER-VANISH ⑤ — observation first: a chat row the person could see and then could not is a first-class
// event, named by the code path that removed it. The diff runs on ids only; the content preview is read only for a
// row that vanished (대표 11-24 «which utterance disappeared» · `elanous logs --grep answer-vanished`).
import type { SerializedMessage } from '../../session/index.js';
import { redactSecretText } from '../../debug/secret-redaction.js';

export type TranscriptVanishCause = 'compaction' | 'compact-reload' | 'preview-replace' | 'session-reload' | 'turn-hide' | 'notice-strip' | 'slice-window' | 'other';

/** The rows a frame shows to the person (displayed view, index-aligned with the saved rows). */
export interface TranscriptVanishFrame {
  readonly sessionId: string | undefined;
  /** Saved rows (raw) — ids come from here; the displayed view keeps the same indexes. */
  readonly saved: readonly SerializedMessage[];
  /** The projected rows the chat renders (public history in the basic chat). */
  readonly displayed: readonly SerializedMessage[];
  /** Ids of rows judged on screen this frame, and the ids that were evaluated at all (a tail window). */
  readonly onScreen: ReadonlySet<string>;
  readonly evaluated: ReadonlySet<string>;
  readonly scroll: number;
  /** Set when the person moved the viewport since the last frame (a scroll-off is then not a vanish). */
  readonly userScrolled: boolean;
  readonly busy: boolean;
  /** The reload that replaced the saved rows since the last frame, when one did. */
  readonly reload?: 'compaction' | 'compact-reload' | 'session-reload';
  readonly turnDoor?: string;
  readonly turnSource?: string;
}

export interface TranscriptVanishEvent {
  readonly sessionId: string | undefined;
  readonly msgId: string;
  readonly role: 'user' | 'assistant';
  readonly chars: number;
  readonly createdAt: string;
  readonly preview: string;
  readonly cause: TranscriptVanishCause;
  readonly turnDoor: string | null;
  readonly turnSource: string | null;
  readonly visibleBefore: number;
  readonly visibleAfter: number;
  readonly scrollOffset: number;
}

const PREVIEW_CHARS = 120;

/** Stable id of a saved row: its persisted turn_id (appendMessage mints one per row), else role@ts. */
export function transcriptRowId(message: Pick<SerializedMessage, 'turn_id' | 'role' | 'ts'>): string {
  return message.turn_id !== undefined ? String(message.turn_id) : `${message.role}@${message.ts}`;
}

/** One line, at most 120 chars, secrets redacted — read only for a row that vanished. */
export function vanishPreview(content: string): string {
  const line = redactSecretText(content).replace(/\s+/g, ' ').trim();
  return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS - 1)}…` : line;
}

/** Is this displayed row a chat row the person reads (a user line or a shown answer)? */
export function isChatRow(message: SerializedMessage | undefined): message is SerializedMessage & { role: 'user' | 'assistant' } {
  return message !== undefined && (message.role === 'user' || message.role === 'assistant') && message.content.length > 0;
}

interface Seen { readonly role: 'user' | 'assistant'; readonly chars: number; readonly createdAt: string; readonly content: string }

/** Compare each frame's on-screen chat rows with the previous frame; report every row that left the screen without
 *  the person scrolling, with the code path that removed it. */
export function createTranscriptVanishDetector(log: (event: TranscriptVanishEvent) => void): (frame: TranscriptVanishFrame) => void {
  let previous: { sessionId: string | undefined; onScreen: Map<string, Seen>; scroll: number } | null = null;
  return (frame) => {
    const onScreen = new Map<string, Seen>();
    const savedIndex = new Map<string, number>();
    // Ids only: index the wanted rows (evaluated now · on screen last frame) from the tail, stopping once all are found.
    const wanted = new Set<string>([...frame.evaluated, ...(previous?.onScreen.keys() ?? [])]);
    for (let index = frame.saved.length - 1; index >= 0 && savedIndex.size < wanted.size; index -= 1) {
      const id = transcriptRowId(frame.saved[index]!);
      if (wanted.has(id)) savedIndex.set(id, index);
    }
    for (const id of frame.onScreen) {
      const index = savedIndex.get(id);
      const row = index === undefined ? undefined : frame.displayed[index];
      if (isChatRow(row)) onScreen.set(id, { role: row.role, chars: row.content.length, createdAt: row.ts, content: row.content });
    }
    const prior = previous;
    previous = { sessionId: frame.sessionId, onScreen, scroll: frame.scroll };
    if (!prior || prior.sessionId !== frame.sessionId) return; // a session switch is not a vanish
    for (const [id, seen] of prior.onScreen) {
      if (onScreen.has(id)) continue;
      const index = savedIndex.get(id);
      let cause: TranscriptVanishCause;
      if (index === undefined) cause = frame.reload ?? 'other';
      else if (isChatRow(frame.displayed[index])) {
        if (!frame.evaluated.has(id)) continue; // outside the tail window this frame looked at — not judged
        if (frame.userScrolled || frame.scroll !== prior.scroll) continue; // the person moved the viewport
        cause = 'slice-window';
      } else cause = seen.role === 'user' ? 'notice-strip' : frame.busy ? 'turn-hide' : 'other';
      log({
        sessionId: frame.sessionId, msgId: id, role: seen.role, chars: seen.chars, createdAt: seen.createdAt,
        preview: vanishPreview(seen.content), cause,
        turnDoor: frame.turnDoor ?? null, turnSource: frame.turnSource ?? null,
        visibleBefore: prior.onScreen.size, visibleAfter: onScreen.size, scrollOffset: frame.scroll,
      });
    }
  };
}

/** Which of the last `tail` chat rows have a rendered line on this screen. `renderRow` renders one displayed row
 *  alone (cached by the caller); a row counts as on screen when one of its distinctive lines is a screen line. */
export function chatRowsOnScreen(input: {
  readonly saved: readonly SerializedMessage[];
  readonly displayed: readonly SerializedMessage[];
  readonly screenLines: readonly string[];
  readonly tail: number;
  readonly renderRow: (message: SerializedMessage) => readonly string[];
}): { onScreen: Set<string>; evaluated: Set<string> } {
  const screen = new Set(input.screenLines.map(plainLine).filter((line) => line.length > 0));
  const onScreen = new Set<string>();
  const evaluated = new Set<string>();
  for (let index = input.displayed.length - 1; index >= 0 && evaluated.size < input.tail; index -= 1) {
    const row = input.displayed[index];
    if (!isChatRow(row) || input.saved[index] === undefined) continue;
    const id = transcriptRowId(input.saved[index]!);
    evaluated.add(id);
    if (input.renderRow(row).some((line) => { const plain = plainLine(line); return plain.length >= 6 && screen.has(plain); })) onScreen.add(id);
  }
  return { onScreen, evaluated };
}

function plainLine(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[│┃]/g, ' ').trim();
}
