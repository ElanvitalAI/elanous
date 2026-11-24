// CAPSULE-FOOTER-ONCE (대표 11-24 13:0x «끝난 서브에이전트 줄이 바닥에 턴마다 남는다»): the footer shows only running
// capsules. When one finishes, its result is written ONCE into the transcript at that moment — a dim machine row —
// and it leaves the footer. Consecutive finished-ok capsules of one kind with no message between them fold into one
// row «🤖 3 done · first +2 · Σs» whose members unfold in log focus; a failed / timed-out / cancelled capsule gets its
// own warning row, never folded. The rows share the transcript-marker store with the turn-end «Worked for» rows.
import type { FinishedCapsule } from './capsule-activity.js';

/** One screen-only transcript row anchored after a session message (turn end · mission arrival · capsule result). */
export interface TranscriptMarker {
  readonly afterMessageIndex: number;
  readonly text: string;
  /** Unset = the turn-end blue. `dim` = a machine row · `warn` = a failure to notice. */
  readonly tone?: 'dim' | 'warn';
  /** Rows under the marker when the log is unfolded (log focus) — the members of a folded capsule row. */
  readonly detail?: readonly string[];
  /** Capsule fold state — present only on a finished-ok capsule row that later completions may join. */
  readonly capsule?: { readonly kind: FinishedCapsule['kind']; readonly icon: string; readonly names: readonly string[];
    readonly seconds: number; readonly lines: readonly string[] };
}

function foldedText(group: NonNullable<TranscriptMarker['capsule']>): string {
  if (group.lines.length === 1) return group.lines[0]!;
  return `${group.icon} ${group.lines.length} done · ${group.names[0]} +${group.lines.length - 1} · ${group.seconds}s`;
}

/** The marker list after `done` finished with the transcript's last message at `afterMessageIndex`. */
export function withCapsuleDone(markers: readonly TranscriptMarker[], afterMessageIndex: number, done: FinishedCapsule): TranscriptMarker[] {
  if (done.status !== 'ok') return [...markers, { afterMessageIndex, text: `⚠ ${done.line}`, tone: 'warn' }];
  const last = markers.at(-1);
  if (last?.capsule && last.afterMessageIndex === afterMessageIndex && last.capsule.kind === done.kind) {
    const group = { ...last.capsule, names: [...last.capsule.names, done.name], seconds: last.capsule.seconds + done.seconds,
      lines: [...last.capsule.lines, done.line] };
    return [...markers.slice(0, -1), { afterMessageIndex, text: foldedText(group), tone: 'dim', detail: group.lines, capsule: group }];
  }
  const group = { kind: done.kind, icon: done.icon, names: [done.name], seconds: done.seconds, lines: [done.line] };
  return [...markers, { afterMessageIndex, text: foldedText(group), tone: 'dim', capsule: group }];
}
