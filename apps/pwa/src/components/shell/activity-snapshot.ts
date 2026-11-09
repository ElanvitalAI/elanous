import {
  classifySubject,
  subjectProgressBySubject,
  type ObservatorySubject,
  type SubjectProgress,
} from '@/components/observatory/subject-list';
import { ptyProgressByTerminal } from '@/components/terminal/pty-terminal-list';
import type { DaemonLogEntry } from '@/lib/daemon-client';

export const ACTIVITY_POLL_MS = 8_000;

type ShellActivityRun = {
  subjectId: string;
  runId: string;
  origin: 'system' | 'human';
  progressLine: string | null;
  progressStatus: 'running' | 'complete' | null;
  href: string;
};

export type ShellActivitySnapshot =
  | { kind: 'quiet' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'active'; run: ShellActivityRun; extraLiveCount: number };

export function liveRunHref(runId: string): string {
  return `/live-run?run=${encodeURIComponent(runId)}`;
}

function progressRank(progress: SubjectProgress | undefined): number {
  if (progress?.kind === 'progress' && progress.status === 'running') return 3;
  if (progress?.kind === 'progress') return 2;
  return 1;
}

function toRun(
  subject: ObservatorySubject,
  progress: SubjectProgress | undefined,
): ShellActivityRun {
  return {
    subjectId: subject.id,
    runId: subject.runId || subject.id,
    origin: subject.origin,
    progressLine: progress?.kind === 'progress' ? progress.line : null,
    progressStatus: progress?.kind === 'progress' ? progress.status : null,
    href: liveRunHref(subject.runId || subject.id),
  };
}

/** Live subjects only. Running progress wins, then any progress, then runId. */
export function selectLiveActivity(
  subjects: readonly ObservatorySubject[],
  progressBySubject: ReadonlyMap<string, SubjectProgress>,
): { run: ShellActivityRun; extraLiveCount: number } | null {
  const live = subjects.filter((subject) => classifySubject(subject) === 'live');
  if (live.length === 0) return null;
  const ranked = [...live].sort((a, b) => {
    const rankDelta = progressRank(progressBySubject.get(b.id)) - progressRank(progressBySubject.get(a.id));
    if (rankDelta !== 0) return rankDelta;
    return (a.runId || a.id).localeCompare(b.runId || b.id);
  });
  const chosen = ranked[0]!;
  return {
    run: toRun(chosen, progressBySubject.get(chosen.id)),
    extraLiveCount: live.length - 1,
  };
}

export function buildActivitySnapshot(input: {
  status: 'loading' | 'ready' | 'error';
  subjects?: readonly ObservatorySubject[];
  logs?: readonly DaemonLogEntry[];
  message?: string;
}): ShellActivitySnapshot {
  if (input.status === 'loading') return { kind: 'loading' };
  if (input.status === 'error') {
    return { kind: 'error', message: input.message || 'Failed to load activity' };
  }
  const subjects = input.subjects ?? [];
  const progressBySubject = subjectProgressBySubject(
    subjects,
    ptyProgressByTerminal(input.logs ?? []),
  );
  const selected = selectLiveActivity(subjects, progressBySubject);
  if (!selected) return { kind: 'quiet' };
  return { kind: 'active', run: selected.run, extraLiveCount: selected.extraLiveCount };
}

export function activityAriaLabel(snapshot: Extract<ShellActivitySnapshot, { kind: 'active' }>): string {
  const { run, extraLiveCount } = snapshot;
  const parts = [`LIVE ${run.runId}`, `origin: ${run.origin}`];
  if (run.progressStatus && run.progressLine) {
    parts.push(`${run.progressStatus} — ${run.progressLine}`);
  }
  if (extraLiveCount > 0) parts.push(`+${extraLiveCount} more`);
  return parts.join(' · ');
}
