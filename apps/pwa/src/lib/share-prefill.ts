export const SHARE_PREFILL_KEY = 'elanous.pwa.sharePrefill';
export const SHARE_PREFILL_EVENT = 'elanous:pwa-share-prefill';

export function writeSharePrefill(text: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(SHARE_PREFILL_KEY, text);
    window.dispatchEvent(new Event(SHARE_PREFILL_EVENT));
  } catch { /* sessionStorage may be disabled */ }
}

export function takeSharePrefill(): string {
  if (typeof window === 'undefined') return '';
  try {
    const text = window.sessionStorage.getItem(SHARE_PREFILL_KEY) ?? '';
    window.sessionStorage.removeItem(SHARE_PREFILL_KEY);
    return text;
  } catch {
    return '';
  }
}
