// 웹터미널 집중 모드 (TERM2 · 대표 2026-10-02 11:3x «터미널 그 자체를 크게 보고 싶을 때»)
//
// - 켜기/끄기 = Ctrl+Shift+F (맥 ⌘+Shift+F) — BT 키보드에서 된다. Esc 는 터미널(vim·tmux)이 써서 빼앗지 않는다.
// - 켜져 있을 때 글자 크기 = Ctrl/⌘+Shift+«=» 키우기 · Ctrl/⌘+Shift+«-» 줄이기 · 기기마다 기억.

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

export function readTermFontSize(storage: StorageLike | null | undefined): number {
  try {
    const raw = storage?.getItem(TERM_FONT_KEY);
    return raw ? clampFontSize(Number(raw)) : TERM_FONT_DEFAULT;
  } catch { return TERM_FONT_DEFAULT; }
}

export function writeTermFontSize(storage: StorageLike | null | undefined, size: number): void {
  try { storage?.setItem(TERM_FONT_KEY, String(clampFontSize(size))); } catch { /* 기억 못 해도 지금 크기는 그대로 */ }
}
