import { useSyncExternalStore } from 'react';

export type PwaRole = 'owner' | 'contributor' | 'general';
export const PWA_ROLE_KEY = 'elanous.pwa.role';
export const PWA_ROLE_EVENT = 'elanous:pwa-role';

/** MAT2 — a device that never picked a role sees only stable screens (대표 «완성도 낮은 것은 노출하지 않는다»).
 *  The owner picks «오너» once in /setup → 화면 역할; that choice is stored on this device. */
export function readPwaRole(): PwaRole {
  try {
    const value = window.localStorage.getItem(PWA_ROLE_KEY);
    if (value === 'owner' || value === 'contributor' || value === 'general') return value;
  } catch { /* Storage can be unavailable. */ }
  return 'general';
}

export function writePwaRole(role: PwaRole): void {
  try { window.localStorage.setItem(PWA_ROLE_KEY, role); } catch { /* Keep the previous role when storage is unavailable. */ }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') window.dispatchEvent(new Event(PWA_ROLE_EVENT));
}

function subscribeRole(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {};
  window.addEventListener(PWA_ROLE_EVENT, onChange);
  const onStorage = (event: StorageEvent) => {
    if (event.key === PWA_ROLE_KEY || event.key === null) onChange();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(PWA_ROLE_EVENT, onChange);
    window.removeEventListener('storage', onStorage);
  };
}

export function usePwaRole(): PwaRole {
  return useSyncExternalStore(subscribeRole, readPwaRole, () => 'general');
}
