'use client';

import { useEffect, useSyncExternalStore } from 'react';

/** Surfaces that want the screen to themselves (GRAPH-WIZARD: the editor while «말로 만들기» is open) register
 *  here; app chrome that would cover them (the PWA install banner) reads it and waits. In-memory only — a reload
 *  starts unquiet. */
const quiet = new Set<string>();
const listeners = new Set<() => void>();

function emit() { for (const listener of listeners) listener(); }

export function setQuietSurface(name: string, on: boolean): void {
  const had = quiet.has(name);
  if (on === had) return;
  if (on) quiet.add(name); else quiet.delete(name);
  emit();
}

export function isQuiet(): boolean { return quiet.size > 0; }

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useQuietSurfaceActive(): boolean {
  return useSyncExternalStore(subscribe, isQuiet, () => false);
}

/** Holds the screen quiet while the calling component is mounted and `on` is true. */
export function useQuietSurface(name: string, on = true): void {
  useEffect(() => {
    setQuietSurface(name, on);
    return () => setQuietSurface(name, false);
  }, [name, on]);
}
