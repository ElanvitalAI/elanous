'use client';

import { useCallback, useEffect, useState } from 'react';

export const SHOW_BETA_KEY = 'elanous.pwa.showBeta';
export const SHOW_BETA_EVENT = 'elanous:show-beta';

function readShowBeta(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(SHOW_BETA_KEY) === '1';
  } catch {
    return false;
  }
}

export function useShowBeta(): { showBeta: boolean; setShowBeta: (next: boolean) => void } {
  const [showBeta, updateShowBeta] = useState(false);

  useEffect(() => {
    updateShowBeta(readShowBeta());
    const onChange = (event: Event): void => {
      const detail = (event as CustomEvent<boolean>).detail;
      updateShowBeta(typeof detail === 'boolean' ? detail : readShowBeta());
    };
    const onStorage = (event: StorageEvent): void => {
      if (event.key === SHOW_BETA_KEY || event.key === null) updateShowBeta(readShowBeta());
    };
    window.addEventListener(SHOW_BETA_EVENT, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(SHOW_BETA_EVENT, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const setShowBeta = useCallback((next: boolean): void => {
    updateShowBeta(next);
    try {
      if (next) window.localStorage.setItem(SHOW_BETA_KEY, '1');
      else window.localStorage.removeItem(SHOW_BETA_KEY);
    } catch {
      // This tab still follows the choice when storage is unavailable.
    }
    window.dispatchEvent(new CustomEvent(SHOW_BETA_EVENT, { detail: next }));
  }, []);

  return { showBeta, setShowBeta };
}
