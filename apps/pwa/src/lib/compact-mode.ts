'use client';

import { useCallback, useEffect, useState } from 'react';

export const COMPACT_MAX_WIDTH = 932;
const WIDE_KEY = 'elanous.pwa.wideView';
/** Every useCompactMode() on the page follows one «wide view» choice. */
const WIDE_EVENT = 'elanous:wide-view';

function readWide(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(WIDE_KEY) === '1';
  } catch {
    return false;
  }
}

export function useCompactMode(): { compact: boolean; setWide: (wide: boolean) => void } {
  const [width, setWidth] = useState<number | null>(null);
  const [wide, updateWide] = useState(false);

  useEffect(() => {
    setWidth(window.innerWidth);
    updateWide(readWide());
    const onResize = (): void => setWidth(window.innerWidth);
    const onWide = (event: Event): void => {
      const detail = (event as CustomEvent<boolean>).detail;
      updateWide(typeof detail === 'boolean' ? detail : readWide());
    };
    window.addEventListener('resize', onResize);
    window.addEventListener(WIDE_EVENT, onWide);
    window.addEventListener('storage', onWide);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener(WIDE_EVENT, onWide);
      window.removeEventListener('storage', onWide);
    };
  }, []);

  const setWide = useCallback((next: boolean): void => {
    updateWide(next);
    try {
      if (next) window.localStorage.setItem(WIDE_KEY, '1');
      else window.localStorage.removeItem(WIDE_KEY);
    } catch {
      // The choice still applies in this tab when storage is unavailable.
    }
    window.dispatchEvent(new CustomEvent(WIDE_EVENT, { detail: next }));
  }, []);

  return { compact: width !== null && width <= COMPACT_MAX_WIDTH && !wide, setWide };
}
