/**
 * PulseDot — a breathing dot driven by the snapshot tick (one real refresh = one breath step, no free-running timer).
 * Countdown — «elapsed / total · left» with a progress bar.
 */
import { bar, cells, fit } from './text.js';

/** Calm boards breathe ● ○ on every real refresh; a busy board holds a solid ●. */
export function renderPulseDot(props: { readonly tick: number; readonly busy: boolean }): string {
  if (props.busy) return '●';
  return props.tick % 2 === 0 ? '●' : '○';
}

const clock = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec));
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm}:${ss}` : `${Math.floor(s / 60)}:${ss}`;
};

export interface CountdownProps {
  readonly elapsedSec: number;
  readonly totalSec: number;
}

/** «0:42 / 4:00 ███░░░░ 3:18 left» fitted to width; the bar is dropped first when space is short. */
export function renderCountdown(props: CountdownProps, width: number): string {
  const total = Math.max(1, props.totalSec);
  const head = `${clock(props.elapsedSec)} / ${clock(total)}`;
  const tail = `${clock(total - props.elapsedSec)} left`;
  const room = width - cells(head) - cells(tail) - 2;
  if (room < 4) return fit(`${head} · ${tail}`, width);
  return `${head} ${bar(props.elapsedSec / total, Math.min(12, room))} ${tail}`;
}
