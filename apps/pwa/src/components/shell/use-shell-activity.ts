'use client';

import { useEffect, useState } from 'react';
import { ACTIVITY_POLL_MS, type ShellActivitySnapshot } from './activity-snapshot';
import { fetchActivitySnapshot, type ActivityFetchDeps } from './fetch-activity-snapshot';

/** First activity poll waits this long after the shell mounts (TERM1 · page entry). */
export const ACTIVITY_FIRST_DELAY_MS = 1_500;

/** Longest wait between polls when the daemon is slow. */
export const ACTIVITY_POLL_MAX_MS = 60_000;

/** TERM1 · 10-02 — a slow daemon must not be asked again at full rate: wait at least four times the last answer time
 *  (measured: `/v1/terminals` took 1.7–6.6 s while every open tab polled it every 8 s, saturating the daemon). */
export function nextActivityDelay(pollMs: number, lastMs: number): number {
  return Math.min(ACTIVITY_POLL_MAX_MS, Math.max(pollMs, Math.round(lastMs * 4)));
}

function pageHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden === true;
}

export function startActivityPolling(
  setSnapshot: (snapshot: ShellActivitySnapshot) => void,
  deps: ActivityFetchDeps & { isHidden?: () => boolean; now?: () => number; firstDelayMs?: number } = {},
  pollMs: number = ACTIVITY_POLL_MS,
): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const isHidden = deps.isHidden ?? pageHidden;
  const now = deps.now ?? (() => Date.now());

  const tick = async (): Promise<void> => {
    // A hidden tab (phone in a pocket, background browser tab) asks nothing — it checks again later.
    if (isHidden()) {
      timer = setTimeout(() => { void tick(); }, pollMs);
      return;
    }
    const started = now();
    const next = await fetchActivitySnapshot(deps);
    if (cancelled) return;
    setSnapshot(next);
    timer = setTimeout(() => {
      void tick();
    }, nextActivityDelay(pollMs, now() - started));
  };

  if (deps.firstDelayMs) timer = setTimeout(() => { void tick(); }, deps.firstDelayMs);
  else void tick();
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

export function useShellActivity(
  deps: ActivityFetchDeps = {},
  pollMs: number = ACTIVITY_POLL_MS,
): ShellActivitySnapshot {
  const [snapshot, setSnapshot] = useState<ShellActivitySnapshot>({ kind: 'loading' });

  useEffect(
    // TERM1 — the shell's own first requests go first; the activity strip can wait a moment.
    () => startActivityPolling(setSnapshot, { ...deps, firstDelayMs: ACTIVITY_FIRST_DELAY_MS }, pollMs),
    [deps.fetchImpl, deps.listProgressFrames, pollMs],
  );

  return snapshot;
}
