// 웹터미널 집중 모드 (TERM2 · 대표 2026-10-02 11:3x «터미널 그 자체를 크게 보고 싶을 때»)
//
// - 켜기/끄기 = Ctrl+Shift+F (맥 ⌘+Shift+F) — BT 키보드에서 된다. Esc 는 터미널(vim·tmux)이 써서 빼앗지 않는다.
// - 켜져 있을 때 글자 크기 = Ctrl/⌘+Shift+«=» 키우기 · Ctrl/⌘+Shift+«-» 줄이기 · 기기마다 기억.

export const TERM_FOCUS_DISABLED_KEY = 'elanous.pwa.termFocusStartDisabled';

export function readTermFocusStartDisabled(storage: StorageLike | null | undefined): boolean {
  try { return storage?.getItem(TERM_FOCUS_DISABLED_KEY) === '1'; } catch { return false; }
}

export function writeTermFocusStartDisabled(storage: StorageLike | null | undefined): void {
  try { storage?.setItem(TERM_FOCUS_DISABLED_KEY, '1'); } catch { /* The current focus choice still applies. */ }
}

export const TERM_FONT_KEY = 'elanous.pwa.termFontSize';
export const TERM_FONT_DEFAULT = 13;
export const TERM_FONT_MIN = 9;
export const TERM_FONT_MAX = 32;

type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>;
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const chord = (e: KeyLike) => (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey;

export function isFocusToggleKey(e: KeyLike): boolean {
  return chord(e) && (e.code === 'KeyF' || e.key === 'F' || e.key === 'f');
}

/** +1 키우기 · -1 줄이기 · 0 아님. Shift 를 누르면 `=` 가 `+` 로, `-` 가 `_` 로 오는 배열도 받는다. */
export function fontStepKey(e: KeyLike): 1 | -1 | 0 {
  if (!chord(e)) return 0;
  if (e.code === 'Equal' || e.code === 'NumpadAdd' || e.key === '+' || e.key === '=') return 1;
  if (e.code === 'Minus' || e.code === 'NumpadSubtract' || e.key === '_' || e.key === '-') return -1;
  return 0;
}

export function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) return TERM_FONT_DEFAULT;
  return Math.min(TERM_FONT_MAX, Math.max(TERM_FONT_MIN, Math.round(size)));
}

export function readTermFontSize(storage: StorageLike | null | undefined, mobile = false): number {
  const fallback = TERM_FONT_DEFAULT + (mobile ? 1 : 0);
  try {
    const raw = storage?.getItem(TERM_FONT_KEY);
    return raw ? clampFontSize(Number(raw)) : fallback;
  } catch { return fallback; }
}

export function writeTermFontSize(storage: StorageLike | null | undefined, size: number): void {
  try { storage?.setItem(TERM_FONT_KEY, String(clampFontSize(size))); } catch { /* 기억 못 해도 지금 크기는 그대로 */ }
}

// Storage events only reach other documents; notify the other mounted layouts in
// this document explicitly, even when browser storage is unavailable.
const fontSizeListeners = new Set<(size: number) => void>();
let currentFontSize: number | undefined;

export function publishTermFontSize(size: number): void {
  const next = clampFontSize(size);
  currentFontSize = next;
  try {
    const storage = window.localStorage;
    storage.setItem(TERM_FONT_KEY, String(next));
    if (storage.getItem(TERM_FONT_KEY) === String(next)) currentFontSize = undefined;
  } catch { /* keep the current size in memory if storage is blocked */ }
  for (const listener of fontSizeListeners) listener(next);
}

export function subscribeTermFontSize(listener: (size: number) => void): () => void {
  fontSizeListeners.add(listener);
  const refresh = () => {
    let storage: StorageLike | null = null;
    try { storage = window.localStorage; } catch { /* storage access may be blocked */ }
    listener(currentFontSize ?? readTermFontSize(storage, window.matchMedia?.('(pointer: coarse)').matches ?? false));
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== TERM_FONT_KEY && event.key !== null) return;
    try { if (event.storageArea && event.storageArea !== window.localStorage) return; } catch { return; }
    currentFontSize = undefined;
    refresh();
  };
  window.addEventListener('storage', onStorage);
  refresh();
  return () => { fontSizeListeners.delete(listener); window.removeEventListener('storage', onStorage); };
}
