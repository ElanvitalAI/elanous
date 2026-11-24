// TUI-NOTICE-QUIET (대표 11-24 11:5x «매 턴 뒤 쌓이는 알림 줄은 산만하고 의미 없다»): a notice row reaches the screen
// only when the person must act or it reports a failure. Routine bookkeeping — a notice turn that opened by itself,
// a scheduled resume, an applied steer, the scheduled-wake echo, a pending-result count — is dropped
// from the view and written to the debug log (`tui.notice` · `suppressed` · kind) so it stays observable.
// The restart marker stays as one sticky line: a notice repeating the same new build is dropped. Finished sub-agent
// («🤖 … · ok · Ns») rows stay — they show sub-agents at work (대표 12:1x); chat/capsule-activity.ts folds them.
// TUI-WAKE-NOTICE-HIDDEN (대표 11-24 22:5x «하단에 남아 거슬린다 · 사용자 발화보다 항상 아래에 남는다»): the
// scheduled-wake deferral («⏰ 예약 깨움 대기(…)») and the goal time-wait («⏳ Waiting for time …») are internal
// scheduling — logged, never drawn. Any notice row left is cleared when the person sends an utterance, so no
// notice sits below the newest person message.
// Default behaviour, no switch.

export type SuppressedNoticeKind =
  | 'auto-submitted' | 'resume-banner' | 'steer-applied' | 'wake-echo' | 'wake-defer' | 'time-wait' | 'results-ready' | 'restart-repeat' | 'duplicate';

/** Only the bookkeeping templates this TUI itself writes — anything else (errors, warnings, questions) is shown. */
export function suppressedNoticeKind(line: string): SuppressedNoticeKind | null {
  const text = line.trim();
  if (/^\[notice · [^\]]*\] auto-submitted$/u.test(text)) return 'auto-submitted'; // external-event-one-wire.ts
  if (/^↻ Resuming\b/u.test(text)) return 'resume-banner'; // chat/continue-banner.ts RESUME_BY_ORIGIN
  if (text === 'Steer applied') return 'steer-applied';
  if (/^⏰ 예약 깨움 \d{2}:\d{2}/u.test(text)) return 'wake-echo'; // skills/tools/schedule-wakeup.ts — the booking echo only
  if (/^⏰ 예약 깨움 대기\(/u.test(text)) return 'wake-defer'; // skills/tools/schedule-wakeup.ts — busy deferral
  if (/^⏳ Waiting for time\b/u.test(text)) return 'time-wait'; // tui/input/goal-continue.ts — goal waits for a time
  if (/^✓ Results ready \d+$/u.test(text)) return 'results-ready'; // chat/background-job-status.ts
  return null;
}

/** The new build a restart line names («⟳ 재기동 필요 (새 판 <sha>)» · nexus variants), or null. */
export function restartBuildOf(line: string): string | null {
  if (!line.includes('재기동')) return null;
  const sha = /(?:새 판|옛 판|nexus) ([0-9a-f]{7,40})\)/u.exec(line);
  return sha ? sha[1]! : 'unknown';
}

export type NoticeRowEvent = { kind: 'notice'; line: string } | { kind: 'person' };

/** The notice rows drawn under the transcript: a notice is gated (null → unchanged), a person utterance clears them. */
export function nextNoticeRows(rows: readonly string[], event: NoticeRowEvent, gate: NoticeGate, limit = 3): string[] {
  if (event.kind === 'person') return [];
  const shown = gate.admit(event.line, rows);
  return shown === null ? [...rows] : [...rows, shown].slice(-limit);
}

export interface NoticeGate {
  /** The line to append to the notice rows, or null when it is suppressed (logged once). */
  admit(line: string, shown: readonly string[]): string | null;
  /** Footer restart marker: remembered so a notice naming the same build is not shown a second time. */
  noteSticky(line: string | null): void;
  /** Footer background counter without the «Results ready N» part (null when nothing is left). */
  backgroundRow(line: string): string | null;
}

export function createNoticeGate(log: (kind: SuppressedNoticeKind, line: string) => void): NoticeGate {
  const restartBuilds = new Set<string>();
  // Footer rows are recomputed every frame: log each suppressed text once, not per paint.
  const logged = new Set<string>();
  const suppress = (kind: SuppressedNoticeKind, line: string): void => {
    const key = `${kind}\u0000${line}`;
    if (logged.has(key)) return;
    if (logged.size > 512) logged.clear();
    logged.add(key);
    try { log(kind, line); } catch { /* observability is fail-open */ }
  };
  return {
    admit(line, shown) {
      const kind = suppressedNoticeKind(line);
      if (kind) { suppress(kind, line); return null; }
      const build = restartBuildOf(line);
      if (build !== null) {
        if (restartBuilds.has(build)) { suppress('restart-repeat', line); return null; }
        restartBuilds.add(build);
      }
      if (shown.includes(line)) { suppress('duplicate', line); return null; }
      return line;
    },
    noteSticky(line) {
      const build = line ? restartBuildOf(line) : null;
      if (build !== null) restartBuilds.add(build);
    },
    backgroundRow(line) {
      const parts = line.split(' · ').filter((part) => {
        if (suppressedNoticeKind(part) !== 'results-ready') return true;
        suppress('results-ready', part);
        return false;
      });
      return parts.length > 0 ? parts.join(' · ') : null;
    },
  };
}
