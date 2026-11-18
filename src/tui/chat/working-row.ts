// NEXT-TUI-WORKING-ROW (대표 11-17): one «it is running» row right under the streamed text, above the prompt —
// codex's `Working (12s • esc to interrupt)` shape, English. Pure: the caller supplies elapsed time, so tests
// need no wall clock. The row exists only while a turn runs; when it ends the «✻ Worked for …» marker takes over.
import { fitLogLine } from './log-view.js';

/** Braille spinner; one frame per `SPINNER_FRAME_MS` of elapsed turn time. */
export const WORKING_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
export const SPINNER_FRAME_MS = 250;
export const WORKING_INTERRUPT_HINT = 'esc to interrupt';

export type WorkingPhase =
  | { readonly kind: 'working' }
  | { readonly kind: 'thinking' }
  | { readonly kind: 'responding' }
  | { readonly kind: 'tool'; readonly name: string; readonly target?: string };

/** codex-style compact elapsed: `7s` · `1m 05s` · `1h 02m 03s`. */
export function formatWorkingElapsed(elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number): string => String(value).padStart(2, '0');
  if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`;
  return `${seconds}s`;
}

export function workingSpinnerFrame(elapsedMs: number): string {
  const index = Math.floor(Math.max(0, elapsedMs) / SPINNER_FRAME_MS) % WORKING_SPINNER_FRAMES.length;
  return WORKING_SPINNER_FRAMES[index]!;
}

export function workingVerb(phase: WorkingPhase): string {
  switch (phase.kind) {
    case 'thinking': return 'Thinking';
    case 'responding': return 'Responding';
    case 'tool': return phase.target ? `Running ${phase.name}(${phase.target})` : `Running ${phase.name}`;
    default: return 'Working';
  }
}

export function isWorkingRow(line: string): boolean {
  return WORKING_SPINNER_FRAMES.some((frame) => line.startsWith(`${frame} `));
}

/** The row, fitted to `columns`: the `· N queued` suffix is dropped first, then the verb is cut. */
export function workingRowLine(input: {
  readonly phase: WorkingPhase; readonly elapsedMs: number; readonly queued: number; readonly columns: number;
}): string {
  const head = `${workingSpinnerFrame(input.elapsedMs)} ${workingVerb(input.phase)} (${formatWorkingElapsed(input.elapsedMs)} • ${WORKING_INTERRUPT_HINT})`;
  const full = input.queued > 0 ? `${head} · ${input.queued} queued` : head;
  return Bun.stringWidth(full) <= input.columns ? full : fitLogLine(head, input.columns);
}
